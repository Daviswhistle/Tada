// Host-owned contact journal. Raw context never goes into a browser checkpoint.
// Separate from the existing action ledger: this host exposes no mutation tools.
import { DatabaseSync, backup } from 'node:sqlite';
import { validateFollowupProposal, followupTimezone, followupInstant, isFollowupId, followupReviewText } from './followup-contract.mjs';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const counter = value => Number.isSafeInteger(value) && value >= 0;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ID = /^[a-zA-Z0-9_-]{16,80}$/u;
const SCHEMA = `
CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, salt BLOB NOT NULL, proof TEXT NOT NULL, route TEXT NOT NULL, schema_hash TEXT NOT NULL) STRICT;
CREATE TABLE devices(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
CREATE TABLE turns(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, device TEXT NOT NULL REFERENCES devices(id), state TEXT NOT NULL CHECK(state IN('queued','running','answered','failed','cancelled','interrupted')), payload TEXT NOT NULL, answer TEXT, error TEXT, created INTEGER NOT NULL) STRICT;
CREATE TABLE requests(seq INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL REFERENCES turns(seq), state TEXT NOT NULL CHECK(state IN('reserved','observed','unknown')), input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0)) STRICT;
CREATE TABLE context(singleton INTEGER PRIMARY KEY CHECK(singleton=1), through_seq INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
PRAGMA user_version=1;
`;

const MESSAGING_SCHEMA = `
CREATE TABLE telegram_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), bot_id TEXT NOT NULL, last_update INTEGER, last_received INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE telegram_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1), device TEXT NOT NULL REFERENCES devices(id), payload TEXT NOT NULL, since_seq INTEGER NOT NULL) STRICT;
CREATE TABLE telegram_outbox(id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), turn INTEGER REFERENCES turns(seq), part INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('queued','sending','sent','unknown','rejected','suppressed')), receipt TEXT, not_before INTEGER NOT NULL DEFAULT 0, error TEXT, created INTEGER NOT NULL) STRICT;
CREATE TABLE telegram_controls(id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), target INTEGER REFERENCES turns(seq)) STRICT;
CREATE INDEX telegram_delivery ON telegram_outbox(state,not_before,created,part);
PRAGMA user_version=2;
`;
const SCHEMA_V2 = SCHEMA + MESSAGING_SCHEMA;

const FOLLOWUP_SCHEMA = `
CREATE TABLE followups(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),origin_turn INTEGER NOT NULL REFERENCES turns(seq),device TEXT NOT NULL REFERENCES devices(id),state TEXT NOT NULL CHECK(state IN('open','waiting','done','cancelled')),payload TEXT NOT NULL,notify_at INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL) STRICT;
CREATE TABLE followup_proposals(id TEXT PRIMARY KEY,turn INTEGER NOT NULL REFERENCES turns(seq),device TEXT NOT NULL REFERENCES devices(id),operation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','approved','rejected','expired','superseded')),payload TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(turn,operation_id)) STRICT;
CREATE TABLE followup_notices(id TEXT PRIMARY KEY,commitment TEXT NOT NULL REFERENCES followups(id),version INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('ready','seen','superseded')),telegram_id TEXT REFERENCES telegram_outbox(id),created INTEGER NOT NULL,UNIQUE(commitment,version)) STRICT;
CREATE INDEX followup_due ON followups(state,notify_at);
PRAGMA user_version=3;
`;
const SCHEMA_V3 = SCHEMA_V2 + FOLLOWUP_SCHEMA;

// v1-v3 schema text remains unchanged. Reviews are explicit owner grants, not
// model-created reminders; each commitment version can enqueue at most one turn.
const REVIEW_SCHEMA = `
CREATE TABLE followup_reviews(id TEXT PRIMARY KEY,commitment TEXT NOT NULL REFERENCES followups(id),version INTEGER NOT NULL CHECK(version>0),device TEXT NOT NULL REFERENCES devices(id),payload TEXT NOT NULL,due INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('armed','queued','cancelled')),turn INTEGER UNIQUE REFERENCES turns(seq),error TEXT,created INTEGER NOT NULL,UNIQUE(commitment,version)) STRICT;
CREATE INDEX review_due ON followup_reviews(state,due);
PRAGMA user_version=4;
`;
const SCHEMA_V4 = SCHEMA_V3 + REVIEW_SCHEMA;


const telegramId = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/u.test(value)
  && Number.isSafeInteger(Number(value)) && Number(value) < 2 ** 52;
function messageParts(text) {
  // Count UTF-16 units conservatively and do not cut surrogate pairs. Plain text,
  // no markdown parser or embedded media, and no silent shortening of an answer.
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || Buffer.byteLength(text) > 65536) throw new Error('CONTACT_NOTICE_INVALID');
  const result = []; let part = '';
  for (const scalar of text) {
    if (part.length + scalar.length > 3400) { result.push(part); part = ''; }
    part += scalar;
  }
  if (part) result.push(part);
  if (result.length > 20) throw new Error('CONTACT_NOTICE_LIMIT');
  return result.map((body, i) => result.length > 1 ? `[${i + 1}/${result.length}]\n${body}` : body);
}

function checkedPath(path, directory) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new Error('CONTACT_PATH_REJECTED');
  }
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error('CONTACT_PRIVATE_DIRECTORY_REQUIRED');
  }
}
function prepare(root, initialize) {
  // Trusted host filesystem required. This is not protection against a same-user
  // process replacing directory entries between lstat and SQLite's open.
  for (let current = root; dirname(current) !== current; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('CONTACT_PATH_REJECTED');
  }
  if (initialize) mkdirSync(root, { mode: 0o700 });
  checkedPath(root, true);
  for (const name of ['owner.sqlite', 'contact.sqlite']) {
    const path = join(root, name);
    if (initialize) closeSync(openSync(path, 'wx', 0o600));
    checkedPath(path, false);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(path + suffix)) checkedPath(path + suffix, false);
    }
  }
}

export class ContactStore {
  #db; #owner; #key; #id; #closed = false; #poisoned = false; #version = 1; #root; #upgrading = false;
  constructor({ directory, passphrase, route, initialize = false, followups = false, reviews = false }) {
    if (typeof directory !== 'string' || !directory || typeof passphrase !== 'string' || passphrase.length < 16
        || passphrase.length > 1024 || typeof route !== 'string' || !/^[a-f0-9]{64}$/u.test(route)) {
      throw new Error('CONTACT_SETUP_REQUIRED');
    }
    const root = resolve(directory); this.#root = root;
    prepare(root, initialize);
    try {
      // A dedicated SQLite EXCLUSIVE transaction is a process-lifetime lock.
      // The kernel releases it on crash. Never unlink or lease-steal its file.
      this.#owner = new DatabaseSync(join(root, 'owner.sqlite'), { timeout: 0 });
      this.#owner.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    } catch { this.#owner?.close(); throw new Error('CONTACT_ALREADY_OWNED'); }
    try {
      this.#db = new DatabaseSync(join(root, 'contact.sqlite'), { timeout: 2000 });
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (initialize) {
        const salt = randomBytes(32);
        this.#id = randomUUID();
        this.#key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          const schema = reviews ? SCHEMA_V4 : followups ? SCHEMA_V3 : SCHEMA_V2;
          this.#db.exec(schema); this.#version = reviews ? 4 : followups ? 3 : 2;
          this.#db.prepare('INSERT INTO identity VALUES(1,?,?,?,?,?)').run(this.#id, salt,
            this.#seal('identity', { id: this.#id, route }), route, hash(schema));
          this.#db.exec('COMMIT');
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
      } else {
        this.#version = this.#db.prepare('PRAGMA user_version').get().user_version;
        if (![1, 2, 3, 4].includes(this.#version)) throw new Error('CONTACT_SCHEMA_UNSUPPORTED');
        const identity = this.#db.prepare('SELECT * FROM identity WHERE singleton=1').get();
        if (!identity || identity.route !== route || identity.schema_hash !== hash(this.#version === 1 ? SCHEMA : this.#version === 2 ? SCHEMA_V2 : this.#version === 3 ? SCHEMA_V3 : SCHEMA_V4)) throw new Error('CONTACT_ROUTE_CHANGED');
        this.#id = identity.id;
        this.#key = scryptSync(passphrase, identity.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const proof = this.#open('identity', identity.proof);
        if (proof.id !== this.#id || proof.route !== route) throw new Error('CONTACT_UNLOCK_FAILED');
      }
      if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
          || this.#db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('CONTACT_STORE_INVALID');
      // Authenticate ciphertext before making any recovery change.
      this.checkpoint();
      for (const row of this.#db.prepare('SELECT * FROM turns').all()) this.#turn(row);
      if (this.#version >= 2) {
        this.telegramBinding();
        for (const row of this.#db.prepare('SELECT id,payload,receipt FROM telegram_outbox').all()) {
          this.#open(`telegram-out:${row.id}`, row.payload);
          if (row.receipt) this.#open(`telegram-receipt:${row.id}`, row.receipt);
        }
      }
      if (this.#version >= 3) {
        for (const row of this.#db.prepare('SELECT * FROM followups').all()) this.#commitment(row);
        for (const row of this.#db.prepare('SELECT * FROM followup_proposals').all()) this.#proposal(row);
        for (const row of this.#db.prepare('SELECT * FROM followup_notices').all()) this.#open(`followup-notice:${row.id}`, row.payload);
      }
      if (this.#version === 4) {
        for (const row of this.#db.prepare('SELECT * FROM followup_reviews').all()) this.#reviewPayload(row);
      }
      this.#tx(() => {
        this.#db.exec("UPDATE requests SET state='unknown' WHERE state='reserved'; UPDATE turns SET state='interrupted',error='HOST_RESTARTED' WHERE state='running';");
        if (this.#version >= 2) this.#db.exec("UPDATE telegram_outbox SET state='unknown',error='HOST_RESTARTED' WHERE state='sending';");
      });
    } catch (error) {
      this.close();
      if (/^CONTACT_[A-Z_]+$/u.test(error.message)) throw error;
      throw new Error('CONTACT_STORE_UNAVAILABLE');
    }
  }
  #seal(aad, value) {
    const plain = Buffer.from(JSON.stringify(value));
    if (plain.length > 262144) throw new Error('CONTACT_CONTEXT_LIMIT');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(`${this.#id}:${aad}`));
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  #open(aad, sealed) {
    try {
      if (typeof sealed !== 'string' || sealed.length > 400000) throw new Error();
      const bytes = Buffer.from(sealed, 'base64');
      if (bytes.length < 28) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${this.#id}:${aad}`));
      decipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
    } catch { this.#poisoned = true; throw new Error('CONTACT_UNLOCK_OR_INTEGRITY_FAILED'); }
  }
  #check() { if (this.#closed || this.#poisoned || this.#upgrading) throw new Error('CONTACT_STORE_UNAVAILABLE'); }
  #tx(fn) {
    this.#check();
    let begun = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); begun = true;
      const result = fn(); this.#db.exec('COMMIT'); return result;
    } catch (error) {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { this.#poisoned = true; } }
      if (!/^CONTACT_[A-Z_]+$/u.test(error.message)) this.#poisoned = true;
      throw /^CONTACT_[A-Z_]+$/u.test(error.message) ? error : new Error('CONTACT_STORAGE_FAILED');
    }
  }
  get id() { return this.#id; }
  addDevice(name, now = Date.now()) {
    if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error('CONTACT_DEVICE_NAME');
    return this.#tx(() => {
      if (this.#db.prepare('SELECT count(*) n FROM devices WHERE revoked=0 AND expires>?').get(now).n >= 8) throw new Error('CONTACT_DEVICE_LIMIT');
      const id = randomUUID(), token = randomBytes(32).toString('base64url');
      this.#db.prepare('INSERT INTO devices VALUES(?,?,?,?,0)').run(id, hash(token), this.#seal(`device:${id}`, name), now + 30 * 86400000);
      return { id, token };
    });
  }
  authenticate(token, now = Date.now()) {
    this.#check();
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    return this.#db.prepare('SELECT id FROM devices WHERE token_hash=? AND revoked=0 AND expires>?').get(hash(token), now)?.id ?? null;
  }
  #device(id, now = Date.now()) {
    if (!this.#db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0 AND expires>?').get(id, now)) throw new Error('CONTACT_DEVICE_REVOKED');
  }
  devices() {
    this.#check();
    return this.#db.prepare('SELECT id,name,expires,revoked FROM devices').all().map(row => ({ ...row, name: this.#open(`device:${row.id}`, row.name) }));
  }
  revoke(id) {
    this.#tx(() => {
      this.#db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id);
      this.#db.prepare("UPDATE turns SET state='cancelled',error='DEVICE_REVOKED' WHERE device=? AND state IN('queued','running')").run(id);
      if (this.#version >= 3) {
        this.#db.prepare("UPDATE followup_proposals SET state='rejected' WHERE device=? AND state='pending'").run(id);
        for (const row of this.#db.prepare('SELECT id FROM followups WHERE device=?').all(id)) this.#suppressFollowup(row.id);
      }
    });
  }
  submit(device, requestId, text) {
    if (!ID.test(requestId) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(JSON.stringify(text)) > 4096) throw new Error('CONTACT_MESSAGE_INVALID');
    return this.#tx(() => {
      this.#device(device);
      const old = this.#db.prepare('SELECT * FROM turns WHERE request_id=?').get(requestId);
      if (old) {
        if (this.#turn(old).text !== text) throw new Error('CONTACT_REQUEST_ID_REUSED');
        return { seq: old.seq, replay: true };
      }
      if (this.#db.prepare("SELECT count(*) n FROM turns WHERE state IN('queued','running')").get().n >= 16
          || this.#db.prepare('SELECT count(*) n FROM turns').get().n >= 1000) throw new Error('CONTACT_QUEUE_LIMIT');
      const result = this.#db.prepare("INSERT INTO turns(request_id,device,state,payload,created) VALUES(?,?,'queued',?,?)")
        .run(requestId, device, this.#seal(`turn:${requestId}`, { text }), Date.now());
      return { seq: Number(result.lastInsertRowid), replay: false };
    });
  }
  claim() {
    return this.#tx(() => {
      if (this.#db.prepare("SELECT seq FROM turns WHERE state='running'").get()) return null;
      this.#db.prepare("UPDATE turns SET state='cancelled',error='DEVICE_REVOKED' WHERE state='queued' AND device IN(SELECT id FROM devices WHERE revoked=1 OR expires<=?)").run(Date.now());
      if (this.#version === 4) this.#sweepReviews(Date.now());
      const row = this.#db.prepare("SELECT * FROM turns WHERE state='queued' ORDER BY seq LIMIT 1").get();
      if (!row) return null;
      this.#db.prepare("UPDATE turns SET state='running' WHERE seq=?").run(row.seq);
      return { ...this.#turn(row), state: 'running' };
    });
  }
  cancel(seq) {
    return this.#tx(() => Number(this.#db.prepare("UPDATE turns SET state='cancelled',error='USER_CANCELLED' WHERE seq=? AND state IN('queued','running')").run(seq).changes) > 0);
  }
  #turn(row) {
    return { seq: row.seq, device: row.device, state: row.state, created: row.created,
      text: this.#open(`turn:${row.request_id}`, row.payload).text,
      answer: row.answer ? this.#open(`answer:${row.request_id}`, row.answer) : null, error: row.error };
  }
  turn(seq) { this.#check(); const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(seq); return row ? this.#turn(row) : null; }
  page(before = Number.MAX_SAFE_INTEGER) {
    this.#check();
    if (!counter(before)) throw new Error('CONTACT_CURSOR_INVALID');
    const rows = this.#db.prepare('SELECT * FROM turns WHERE seq<? ORDER BY seq DESC LIMIT 51').all(before);
    const more = rows.length > 50;
    return { turns: rows.slice(0, 50).reverse().map(row => this.#turn(row)), next_before: more ? rows[49].seq : null };
  }
  checkpoint() {
    this.#check();
    const row = this.#db.prepare('SELECT * FROM context WHERE singleton=1').get();
    return row ? { through: row.through_seq, value: this.#open(`context:${row.through_seq}`, row.payload) } : { through: 0, value: null };
  }
  stoppedSince(after, before) {
    this.#check();
    return this.#db.prepare("SELECT * FROM turns WHERE seq>? AND seq<? AND state IN('cancelled','failed','interrupted') ORDER BY seq").all(after, before).map(row => this.#turn(row));
  }
  reserve(seq) {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT state,device FROM turns WHERE seq=?').get(seq);
      if (row?.state !== 'running') throw new Error('CONTACT_REQUEST_STOPPED');
      this.#device(row.device);
      this.#assertReviewAuthority(seq);
      if (this.#version === 4 && this.reviewForTurn(seq)
          && this.#db.prepare('SELECT count(*) n FROM requests WHERE turn=?').get(seq).n >= 8) throw new Error('CONTACT_REVIEW_REQUEST_LIMIT');
      if (this.#db.prepare('SELECT count(*) n FROM requests').get().n >= 64) throw new Error('CONTACT_REQUEST_LIMIT');
      return Number(this.#db.prepare("INSERT INTO requests(turn,state) VALUES(?,'reserved')").run(seq).lastInsertRowid);
    });
  }
  observe(request, response) {
    const valid = response && counter(response.input_tokens) && counter(response.output_tokens);
    this.#tx(() => {
      const prior = this.#db.prepare('SELECT * FROM requests WHERE seq=?').get(request);
      if (prior?.state !== 'reserved') throw new Error('CONTACT_OBSERVATION_CONFLICT');
      const totals = this.usage();
      const safe = valid && counter(totals.input_tokens + response.input_tokens) && counter(totals.output_tokens + response.output_tokens);
      this.#db.prepare('UPDATE requests SET state=?,input_tokens=?,output_tokens=? WHERE seq=?')
        .run(safe ? 'observed' : 'unknown', safe ? response.input_tokens : 0, safe ? response.output_tokens : 0, request);
    });
  }
  usage() {
    this.#check();
    const total = { requests: 0, input_tokens: 0, output_tokens: 0, unknown_requests: 0 };
    for (const row of this.#db.prepare('SELECT * FROM requests').all()) {
      total.requests++;
      if (row.state !== 'observed') total.unknown_requests++;
      for (const key of ['input_tokens', 'output_tokens']) {
        if (!counter(total[key] + row[key])) throw new Error('CONTACT_USAGE_OVERFLOW');
        total[key] += row[key];
      }
    }
    return total;
  }
  finish(seq, answer, checkpoint, proposals = []) {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(seq);
      if (row?.state !== 'running') return false;
      this.#device(row.device);
      this.#assertReviewAuthority(seq);
      if (typeof answer?.text !== 'string' || !answer.text.trim() || !Array.isArray(answer.sources)
          || !checkpoint || checkpoint.version !== 1) throw new Error('CONTACT_ANSWER_INVALID');
      if (this.#version === 4 && this.reviewForTurn(seq) && proposals.length) throw new Error('CONTACT_REVIEW_READ_ONLY');
      this.#saveFollowupProposals(row, proposals);
      this.#db.prepare("UPDATE turns SET state='answered',answer=? WHERE seq=?").run(this.#seal(`answer:${row.request_id}`, answer), seq);
      this.#db.prepare('INSERT INTO context VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET through_seq=excluded.through_seq,payload=excluded.payload')
        .run(seq, this.#seal(`context:${seq}`, checkpoint));
      return true;
    });
  }
  fail(seq, error = 'ASSISTANT_FAILED', state = 'failed') {
    if (!['failed', 'interrupted'].includes(state) || !/^[A-Z_]{1,64}$/u.test(error)) throw new Error('CONTACT_ERROR_INVALID');
    this.#tx(() => { this.#db.prepare("UPDATE turns SET state=?,error=? WHERE seq=? AND state='running'").run(state, error, seq); });
  }

  get contactVersion() { return this.#version; }
  async upgradeMessaging() {
    this.#check();
    if (this.#version >= 2) return null;
    if (this.#db.prepare("SELECT seq FROM turns WHERE state='running'").get()) throw new Error('CONTACT_UPGRADE_BUSY');
    const path = join(this.#root, `before-messaging-${randomUUID()}.sqlite`);
    this.#upgrading = true;
    try {
      closeSync(openSync(path, 'wx', 0o600));
      await backup(this.#db, path);
      const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== 'win32') {
        const dir = openSync(this.#root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      this.#upgrading = false;
      this.#tx(() => {
        this.#db.exec(MESSAGING_SCHEMA);
        this.#db.prepare('UPDATE identity SET schema_hash=? WHERE singleton=1').run(hash(SCHEMA_V2));
      });
      this.#version = 2;
      return path;
    } finally { this.#upgrading = false; }
  }
  #messaging() {
    this.#check();
    if (this.#version < 2) throw new Error('CONTACT_MESSAGING_UPGRADE_REQUIRED');
  }
  telegramConfigure(bot) {
    this.#messaging();
    if (!telegramId(bot)) throw new Error('CONTACT_TELEGRAM_ID_INVALID');
    this.#tx(() => {
      const old = this.#db.prepare('SELECT bot_id FROM telegram_config WHERE singleton=1').get();
      if (old && old.bot_id !== bot) throw new Error('CONTACT_TELEGRAM_BOT_CHANGED');
      if (!old) this.#db.prepare('INSERT INTO telegram_config(singleton,bot_id) VALUES(1,?)').run(bot);
    });
  }
  telegramBinding() {
    this.#messaging();
    const row = this.#db.prepare('SELECT * FROM telegram_binding WHERE singleton=1').get();
    if (!row) return null;
    const payload = this.#open(`telegram-binding:${row.device}`, row.payload);
    if (!telegramId(payload.bot) || !telegramId(payload.chat) || payload.user !== payload.chat
        || !counter(payload.after_message)) throw new Error('CONTACT_TELEGRAM_BINDING_INVALID');
    let live = true;
    try { this.#device(row.device); } catch { live = false; }
    return { ...payload, device: row.device, since_seq: row.since_seq, live };
  }
  telegramBind({ bot, chat, user, after_message }) {
    this.#messaging();
    if (!telegramId(bot) || !telegramId(chat) || chat !== user || !counter(after_message)) throw new Error('CONTACT_TELEGRAM_ID_INVALID');
    return this.#tx(() => {
      if (this.#db.prepare('SELECT bot_id FROM telegram_config WHERE singleton=1').get()?.bot_id !== bot) throw new Error('CONTACT_TELEGRAM_BOT_CHANGED');
      if (this.telegramBinding()?.live) throw new Error('CONTACT_TELEGRAM_ALREADY_PAIRED');
      if (this.#db.prepare('SELECT count(*) n FROM devices WHERE revoked=0 AND expires>?').get(Date.now()).n >= 8) throw new Error('CONTACT_DEVICE_LIMIT');
      const device = randomUUID(), token = randomBytes(32).toString('base64url');
      this.#db.prepare('INSERT INTO devices VALUES(?,?,?,?,0)').run(device, hash(token), this.#seal(`device:${device}`, 'Telegram (owner approved)'), Date.now() + 30 * 86400000);
      // No browser bearer token is handed to Telegram, the model, or a client.
      const since = this.#db.prepare('SELECT coalesce(max(seq),0) n FROM turns').get().n;
      this.#db.prepare('INSERT INTO telegram_binding VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET device=excluded.device,payload=excluded.payload,since_seq=excluded.since_seq')
        .run(device, this.#seal(`telegram-binding:${device}`, { bot, chat, user, after_message }), since);
      this.#telegramNote(`welcome:${device}`, device, null, `같은 Tada에 연결됐어요. 브라우저에서 나누던 대화도 이어갈 수 있어요.\n이 채팅으로 보낸 요청의 답변은 여기에, 브라우저 요청의 결과는 내용 없는 알림으로 전달해요. /cancel은 이 채팅의 최근 대기 요청을 취소하고 /stop은 연결을 해제해요.`);
      return device;
    });
  }
  telegramCursor(now = Date.now()) {
    this.#messaging();
    const config = this.#db.prepare('SELECT * FROM telegram_config WHERE singleton=1').get();
    if (!config) throw new Error('CONTACT_TELEGRAM_NOT_CONFIGURED');
    // Telegram chooses a random next update ID after a week without updates.
    // Omit the old offset then; logical message IDs still deduplicate admission.
    return config.last_update === null || now - config.last_received >= 7 * 86400000 ? undefined : config.last_update + 1;
  }
  telegramAdvance(update) {
    this.#messaging();
    if (!counter(update) || update >= Number.MAX_SAFE_INTEGER) throw new Error('CONTACT_TELEGRAM_UPDATE_INVALID');
    this.#tx(() => { this.#db.prepare('UPDATE telegram_config SET last_update=?,last_received=? WHERE singleton=1').run(update, Date.now()); });
  }
  telegramRequestId(bot, chat, message) {
    if (!telegramId(bot) || !telegramId(chat) || !counter(message)) throw new Error('CONTACT_TELEGRAM_ID_INVALID');
    return `tg_${hash(JSON.stringify([bot, chat, message]))}`;
  }
  telegramCancel(device, requestId) {
    this.#messaging();
    if (!ID.test(requestId)) throw new Error('CONTACT_REQUEST_ID_INVALID');
    return this.#tx(() => {
      this.#device(device);
      const old = this.#db.prepare('SELECT device,target FROM telegram_controls WHERE id=?').get(requestId);
      if (old) {
        if (old.device !== device) throw new Error('CONTACT_REQUEST_ID_REUSED');
        return old.target;
      }
      const target = this.latestPending(device);
      this.#db.prepare('INSERT INTO telegram_controls VALUES(?,?,?)').run(requestId, device, target);
      if (target !== null) this.#db.prepare("UPDATE turns SET state='cancelled',error='USER_CANCELLED' WHERE seq=? AND state IN('queued','running')").run(target);
      return target;
    });
  }
  latestPending(device) {
    this.#check();
    return this.#db.prepare("SELECT seq FROM turns WHERE device=? AND state IN('queued','running') ORDER BY seq DESC LIMIT 1").get(device)?.seq ?? null;
  }
  #telegramNote(key, device, turn, text) {
    const binding = this.telegramBinding();
    if (!binding?.live || binding.device !== device) return;
    if (this.#db.prepare('SELECT count(*) n FROM telegram_outbox').get().n >= 8000) throw new Error('CONTACT_NOTICE_LIMIT');
    const parts = messageParts(text);
    for (let part = 0; part < parts.length; part++) {
      const id = hash(`${key}:${part}`);
      if (this.#db.prepare('SELECT id FROM telegram_outbox WHERE id=?').get(id)) continue;
      this.#db.prepare("INSERT INTO telegram_outbox(id,device,turn,part,payload,state,created) VALUES(?,?,?,?,?,'queued',?)")
        .run(id, device, turn, part, this.#seal(`telegram-out:${id}`, { chat: binding.chat, bot: binding.bot, text: parts[part] }), Date.now());
    }
  }
  telegramNote(key, text) {
    this.#messaging();
    if (typeof key !== 'string' || key.length > 128) throw new Error('CONTACT_NOTICE_INVALID');
    this.#tx(() => {
      const binding = this.telegramBinding();
      if (binding?.live) this.#telegramNote(`notice:${binding.device}:${key}`, binding.device, null, text);
    });
  }
  telegramQueueResults() {
    this.#messaging();
    this.#tx(() => {
      const binding = this.telegramBinding();
      if (!binding?.live) return;
      const rows = this.#db.prepare("SELECT * FROM turns WHERE seq>? AND state IN('answered','failed','cancelled','interrupted') ORDER BY seq").all(binding.since_seq);
      for (const row of rows) {
        const key = `result:${binding.device}:${row.seq}`;
        if (this.#db.prepare('SELECT id FROM telegram_outbox WHERE id=?').get(hash(`${key}:0`))) continue;
        const fromTelegram = row.device === binding.device;
        let text;
        if (!fromTelegram) {
          text = row.state === 'answered' ? `Tada · 요청 ${row.seq}\n브라우저에서 맡긴 요청의 답변이 준비됐어요. 같은 연락 화면에서 확인할 수 있어요.`
            : `Tada · 요청 ${row.seq}\n브라우저 요청이 중지됐어요. 같은 연락 화면에서 상태를 확인해 주세요.`;
        } else if (row.state === 'answered') {
          const turn = this.#turn(row);
          text = `Tada · 요청 ${row.seq}\n${turn.answer.text}`;
          if (turn.answer.sources.length) text += '\n\n자료 식별자·관측 시각은 같은 연락 화면의 참고 자료에서 확인할 수 있어요.';
        } else text = `Tada · 요청 ${row.seq}\n${row.state === 'cancelled' ? '요청을 취소했어요.' : '이번 답변을 완료하지 못했어요. 앞선 대화는 보존했어요. 새 메시지로 이어서 이야기할 수 있어요.'}`;
        this.#telegramNote(key, binding.device, row.seq, text);
        if (fromTelegram && this.#version >= 3) {
          for (const proposal of this.#db.prepare("SELECT * FROM followup_proposals WHERE turn=? AND state='pending'").all(row.seq)) {
            this.#telegramNote(`review:${proposal.id}`, binding.device, null, followupReviewText(this.#proposal(proposal)));
          }
        }
      }
    });
  }
  telegramClaimDelivery(now = Date.now()) {
    this.#messaging();
    return this.#tx(() => {
      this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='DEVICE_REVOKED' WHERE state='queued' AND device IN(SELECT id FROM devices WHERE revoked=1 OR expires<=?)").run(now);
      if (this.#version >= 3) this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='FOLLOWUP_SUPERSEDED' WHERE state='queued' AND id IN(SELECT n.telegram_id FROM followup_notices n JOIN followups f ON f.id=n.commitment JOIN devices d ON d.id=f.device WHERE n.state<>'ready' OR f.version<>n.version OR f.state NOT IN('open','waiting') OR d.revoked=1 OR d.expires<=?)").run(now);
      if (this.#version === 4) {
        this.#sweepReviews(now);
        this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='CONTACT_REVIEW_SUPERSEDED' WHERE state='queued' AND turn IN(SELECT r.turn FROM followup_reviews r JOIN followups f ON f.id=r.commitment JOIN devices d ON d.id=r.device JOIN devices w ON w.id=f.device WHERE r.state='cancelled' OR r.version<>f.version OR f.state NOT IN('open','waiting') OR d.revoked=1 OR d.expires<=? OR w.revoked=1 OR w.expires<=?)").run(now, now);
      }
      // A lost first part must not be followed by dangling continuation parts.
      this.#db.exec("UPDATE telegram_outbox AS o SET state='suppressed',error='PREVIOUS_PART_UNCONFIRMED' WHERE o.state='queued' AND o.turn IS NOT NULL AND EXISTS(SELECT 1 FROM telegram_outbox p WHERE p.device=o.device AND p.turn=o.turn AND p.part<o.part AND p.state IN('unknown','rejected','suppressed'))");
      const row = this.#db.prepare("SELECT * FROM telegram_outbox WHERE state='queued' ORDER BY created,part,id LIMIT 1").get();
      if (!row || row.not_before > now) return null;
      if (this.#db.prepare("SELECT id FROM telegram_outbox WHERE state='sending'").get()) return null;
      this.#device(row.device);
      const payload = this.#open(`telegram-out:${row.id}`, row.payload);
      const binding = this.telegramBinding();
      if (!binding?.live || binding.device !== row.device || payload.chat !== binding.chat || payload.bot !== binding.bot) throw new Error('CONTACT_TELEGRAM_BINDING_INVALID');
      this.#db.prepare("UPDATE telegram_outbox SET state='sending' WHERE id=?").run(row.id);
      return { id: row.id, device: row.device, ...payload };
    });
  }
  telegramDelivery(id, state, { receipt = null, retryAt = 0, error = null } = {}) {
    this.#messaging();
    if (!['sent','unknown','rejected','queued'].includes(state) || !counter(retryAt)
        || (error !== null && !/^[A-Z_]{1,64}$/u.test(error))) throw new Error('CONTACT_DELIVERY_INVALID');
    this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM telegram_outbox WHERE id=?').get(id);
      if (row?.state !== 'sending') throw new Error('CONTACT_DELIVERY_CONFLICT');
      const payload = this.#open(`telegram-out:${id}`, row.payload);
      if (state === 'sent' && (!receipt || !counter(receipt.message_id) || receipt.message_id === 0
          || receipt.chat !== payload.chat || receipt.bot !== payload.bot || receipt.text_hash !== hash(payload.text))) throw new Error('CONTACT_RECEIPT_INVALID');
      this.#db.prepare('UPDATE telegram_outbox SET state=?,receipt=?,not_before=?,error=? WHERE id=?').run(state,
        receipt ? this.#seal(`telegram-receipt:${id}`, receipt) : null, retryAt, error, id);
    });
  }
  messagingStatus() {
    this.#check();
    if (this.#version < 2) return { available: false };
    const counts = {};
    for (const row of this.#db.prepare('SELECT state,count(*) n FROM telegram_outbox GROUP BY state').all()) counts[row.state] = row.n;
    return { available: true, paired: this.telegramBinding()?.live ?? false, deliveries: counts };
  }

  // Work records belong to this same encrypted contact journal, not a parallel bot.
  #followups() { this.#check(); if (this.#version < 3) throw new Error('CONTACT_FOLLOWUP_UPGRADE_REQUIRED'); }
  #proposal(row) {
    const value = this.#open(`followup-proposal:${row.id}`, row.payload);
    return { id: row.id, turn: row.turn, status: row.state, created: row.created, ...value };
  }
  #commitment(row) {
    const value = this.#open(`followup:${row.id}:${row.version}`, row.payload);
    if (value.state !== row.state || (value.notify_at === null ? null : followupInstant(value.notify_at)) !== row.notify_at) {
      this.#poisoned = true; throw new Error('CONTACT_FOLLOWUP_INTEGRITY');
    }
    let notification = 'not_scheduled';
    if (row.notify_at !== null && ['open', 'waiting'].includes(row.state)) {
      const owner = this.#db.prepare('SELECT revoked,expires FROM devices WHERE id=?').get(row.device);
      const notice = this.#db.prepare('SELECT state FROM followup_notices WHERE commitment=? AND version=?').get(row.id, row.version);
      notification = !owner || owner.revoked || owner.expires <= Date.now() ? 'suspended_device'
        : notice?.state === 'seen' ? 'acknowledged' : notice?.state === 'ready' ? 'notice_ready'
          : notice?.state === 'superseded' ? 'suppressed' : 'scheduled';
    }
    return { id: row.id, version: row.version, origin_turn: row.origin_turn, owner_device: row.device,
      updated: row.updated, ...value, review: this.reviewState(row.id, row.version), notification_status: notification, completion_basis: row.state === 'done' ? 'owner_confirmation' : null };
  }
  followup(id) {
    this.#followups(); if (!isFollowupId(id)) throw new Error('CONTACT_FOLLOWUP_INVALID');
    const row = this.#db.prepare('SELECT * FROM followups WHERE id=?').get(id);
    return row ? this.#commitment(row) : null;
  }
  followupPage(status = 'active', offset = 0) {
    this.#followups();
    if (!['active', 'all'].includes(status) || !counter(offset) || offset > 1000) throw new Error('CONTACT_FOLLOWUP_INVALID');
    const condition = status === 'active' ? "WHERE state IN('open','waiting')" : '';
    const rows = this.#db.prepare(`SELECT * FROM followups ${condition} ORDER BY updated DESC,id LIMIT 6 OFFSET ?`).all(offset);
    return { pending: this.#db.prepare("SELECT * FROM followup_proposals WHERE state='pending' ORDER BY created,id LIMIT 8").all().map(row => { const p = this.#proposal(row); return { id: p.id, title: p.spec.title, target: p.spec.target, status: 'pending_owner_confirmation' }; }), items: rows.slice(0, 5).map(row => this.#commitment(row)), next_offset: rows.length > 5 ? offset + 5 : null,
      note: 'These are owner-confirmed work records. Waiting does not imply external monitoring. Done means the owner marked it done, not independent outcome verification.' };
  }
  followupState() {
    this.#check(); if (this.#version < 3) return { available: false };
    const proposals = this.#db.prepare("SELECT * FROM followup_proposals WHERE state='pending' ORDER BY created,id").all().map(row => this.#proposal(row));
    const notices = this.#db.prepare("SELECT * FROM followup_notices WHERE state='ready' ORDER BY created,id").all()
      .map(row => ({ id: row.id, commitment: row.commitment, version: row.version, created: row.created,
        ...this.#open(`followup-notice:${row.id}`, row.payload) }));
    return { available: true, reviews_available: this.#version === 4, ...this.followupPage('active', 0), proposals, notices };
  }
  #saveFollowupProposals(turn, proposals) {
    if (!Array.isArray(proposals) || proposals.length > 4) throw new Error('CONTACT_FOLLOWUP_INVALID');
    if (!proposals.length) return;
    this.#followups();
    if (this.#db.prepare("SELECT count(*) n FROM followup_proposals WHERE state='pending'").get().n + proposals.length > 32
        || this.#db.prepare('SELECT count(*) n FROM followup_proposals').get().n + proposals.length > 1000) throw new Error('CONTACT_FOLLOWUP_LIMIT');
    const text = this.#turn(turn).text;
    const ids = new Set(), operations = new Set();
    for (const proposal of proposals) {
      if (!proposal || Object.keys(proposal).sort().join(',') !== 'id,spec,timezone'
          || !isFollowupId(proposal.id) || ids.has(proposal.id)) throw new Error('CONTACT_FOLLOWUP_INVALID');
      ids.add(proposal.id);
      const spec = validateFollowupProposal(proposal.spec, text);
      followupTimezone(proposal.timezone);
      if (operations.has(spec.operation_id)) throw new Error('CONTACT_FOLLOWUP_INVALID');
      operations.add(spec.operation_id);
      if (spec.target !== null && this.followup(spec.target)?.version !== spec.expected_version) throw new Error('CONTACT_FOLLOWUP_STALE');
      this.#db.prepare("INSERT INTO followup_proposals VALUES(?,?,?,?,'pending',?,?)")
        .run(proposal.id, turn.seq, turn.device, spec.operation_id,
          this.#seal(`followup-proposal:${proposal.id}`, { spec, timezone: proposal.timezone }), Date.now());
    }
  }
  #suppressFollowup(id) {
    if (this.#version === 4) this.#cancelReviews(id, 'CONTACT_REVIEW_SUPERSEDED');
    // Already-sending/sent/unknown deliveries remain honest history. Only queued
    // transmissions can be suppressed; cancellation cannot retract a sent alert.
    this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='FOLLOWUP_SUPERSEDED' WHERE state='queued' AND id IN(SELECT telegram_id FROM followup_notices WHERE commitment=?)").run(id);
    this.#db.prepare("UPDATE followup_notices SET state='superseded' WHERE commitment=? AND state='ready'").run(id);
  }
  confirmFollowup(device, proposalId, decision, now = Date.now()) {
    this.#followups();
    if (!isFollowupId(proposalId) || !['approve', 'reject'].includes(decision) || !counter(now)) throw new Error('CONTACT_FOLLOWUP_INVALID');
    return this.#tx(() => {
      this.#device(device, now);
      const row = this.#db.prepare('SELECT * FROM followup_proposals WHERE id=?').get(proposalId);
      if (!row) throw new Error('CONTACT_FOLLOWUP_NOT_FOUND');
      const proposal = this.#proposal(row), spec = proposal.spec;
      const target = spec.target ?? proposal.id;
      if (row.state !== 'pending') {
        if (row.state === (decision === 'approve' ? 'approved' : 'rejected'))
          return { proposal: proposalId, status: row.state, commitment: decision === 'approve' ? target : null, replay: true };
        throw new Error('CONTACT_FOLLOWUP_DECISION_CONFLICT');
      }
      if (decision === 'reject') {
        this.#db.prepare("UPDATE followup_proposals SET state='rejected' WHERE id=?").run(proposalId);
        return { proposal: proposalId, status: 'rejected', commitment: null, replay: false };
      }
      this.#device(row.device, now);
      if (spec.notify_at !== null && followupInstant(spec.notify_at) >= this.#db.prepare('SELECT expires FROM devices WHERE id=?').get(device).expires) throw new Error('CONTACT_FOLLOWUP_DEVICE_EXPIRES');
      if (now - row.created > 86400000 || this.#db.prepare('SELECT state FROM turns WHERE seq=?').get(row.turn)?.state !== 'answered')
        throw new Error('CONTACT_FOLLOWUP_EXPIRED');
      // Recheck the exact immutable payload, not a new interpretation of the chat.
      validateFollowupProposal(spec, this.turn(row.turn).text, now);
      const old = spec.target === null ? null : this.followup(spec.target);
      if (spec.target !== null && (!old || old.version !== spec.expected_version)) throw new Error('CONTACT_FOLLOWUP_STALE');
      if (!old && this.#db.prepare('SELECT count(*) n FROM followups').get().n >= 1000) throw new Error('CONTACT_FOLLOWUP_LIMIT');
      const version = old ? old.version + 1 : 1;
      if (!Number.isSafeInteger(version)) throw new Error('CONTACT_FOLLOWUP_LIMIT');
      const value = { title: spec.title, details: spec.details, state: spec.state, waiting_for: spec.waiting_for,
        notify_at: spec.notify_at, timezone: proposal.timezone, user_quote: spec.user_quote };
      if (old) this.#suppressFollowup(target);
      this.#db.prepare('INSERT INTO followups VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,device=excluded.device,state=excluded.state,payload=excluded.payload,notify_at=excluded.notify_at,updated=excluded.updated')
        .run(target, version, old?.origin_turn ?? row.turn, device, spec.state,
          this.#seal(`followup:${target}:${version}`, value), spec.notify_at === null ? null : followupInstant(spec.notify_at), now, now);
      this.#db.prepare("UPDATE followup_proposals SET state='approved' WHERE id=?").run(proposalId);
      for (const other of this.#db.prepare("SELECT * FROM followup_proposals WHERE state='pending'").all()) {
        if (this.#proposal(other).spec.target === target) this.#db.prepare("UPDATE followup_proposals SET state='superseded' WHERE id=?").run(other.id);
      }
      return { proposal: proposalId, status: 'approved', commitment: target, version, replay: false };
    });
  }
  dismissFollowupNotice(device, noticeId) {
    this.#followups();
    if (typeof noticeId !== 'string' || !/^[a-f0-9]{64}$/u.test(noticeId)) throw new Error('CONTACT_FOLLOWUP_INVALID');
    return this.#tx(() => {
      this.#device(device);
      const row = this.#db.prepare('SELECT * FROM followup_notices WHERE id=?').get(noticeId);
      if (!row) throw new Error('CONTACT_FOLLOWUP_NOT_FOUND');
      this.#db.prepare("UPDATE followup_notices SET state='seen' WHERE id=? AND state='ready'").run(noticeId);
      if (row.telegram_id) this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='OWNER_ACKNOWLEDGED' WHERE id=? AND state='queued'").run(row.telegram_id);
    });
  }
  followupTick(now = Date.now()) {
    this.#followups(); if (!counter(now)) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
    // No model calls or new tasks. A clock jump can make one notice due, never
    // repeat it. A sleeping host catches up once, explicitly reporting lateness.
    return this.#tx(() => {
      this.#db.prepare("UPDATE followup_proposals SET state='expired' WHERE state='pending' AND created<?").run(now - 86400000);
      const inactive = this.#db.prepare("SELECT * FROM followups WHERE state IN('open','waiting') AND device IN(SELECT id FROM devices WHERE revoked=1 OR expires<=?)").all(now);
      for (const row of inactive) this.#suppressFollowup(row.id);
      let changed = 0;
      for (const row of this.#db.prepare("SELECT * FROM followups WHERE state IN('open','waiting') AND notify_at<=? ORDER BY notify_at,id").all(now)) {
        const key = hash(`followup:${row.id}:${row.version}`);
        if (this.#db.prepare('SELECT id FROM followup_notices WHERE id=?').get(key)) continue;
        try { this.#device(row.device, now); } catch (error) { if (error.message === 'CONTACT_DEVICE_REVOKED') continue; throw error; }
        const item = this.#commitment(row), late = now - row.notify_at > 5 * 60000;
        const body = { title: item.title, details: item.details, scheduled_at: item.notify_at, timezone: item.timezone,
          text: `${late ? '호스트가 확인한 지금은 약속한 시각이 지났어요.' : '약속한 확인 시각이에요.'} ${item.title}`,
          waiting_for: item.waiting_for, late };
        const binding = this.telegramBinding();
        let telegram = null;
        if (binding?.live && !['armed','queued','running','answered'].includes(this.reviewState(row.id, row.version)?.state)) {
          const noticeKey = `followup:${key}:${binding.device}`;
          const text = row.device === binding.device
            ? `${body.text}${item.waiting_for ? `\n기다리는 것: ${item.waiting_for}` : ''}\n연락 화면에서 확인·변경할 수 있어요. 외부 회신을 자동 확인한 것은 아니에요.`
            : 'Tada · 맡겨둔 일을 확인할 시각이에요. 같은 연락 화면에서 내용을 확인해 주세요.';
          this.#telegramNote(noticeKey, binding.device, null, text);
          telegram = hash(`${noticeKey}:0`);
        }
        this.#db.prepare("INSERT INTO followup_notices VALUES(?,?,?,?, 'ready',?,?)")
          .run(key, row.id, row.version, this.#seal(`followup-notice:${key}`, body), telegram, now);
        changed++;
      }
      return changed;
    });
  }
  // Called before a model/tool dispatch and after asynchronous source reads.
  assertTurnAuthority(seq) {
    this.#check();
    const turn = this.#db.prepare('SELECT state,device FROM turns WHERE seq=?').get(seq);
    if (turn?.state !== 'running') throw new Error('CONTACT_REQUEST_STOPPED');
    this.#device(turn.device); this.#assertReviewAuthority(seq);
  }
  #assertReviewAuthority(seq) {
    if (this.#version !== 4) return;
    const row = this.#db.prepare('SELECT * FROM followup_reviews WHERE turn=?').get(seq);
    if (!row) return;
    const work = this.#db.prepare('SELECT version,state,device FROM followups WHERE id=?').get(row.commitment);
    if (row.state !== 'queued' || !work || work.version !== row.version || !['open','waiting'].includes(work.state)) throw new Error('CONTACT_REVIEW_SUPERSEDED');
    this.#device(row.device); this.#device(work.device); this.#reviewPayload(row);
  }
  #reviewPayload(row) {
    const value = this.#open(`review:${row.id}`, row.payload);
    if (value.commitment !== row.commitment || value.version !== row.version || value.device !== row.device
        || value.due !== row.due || value.consent !== 'one_local_read_only_review'
        || typeof value.text !== 'string' || Buffer.byteLength(JSON.stringify(value.text)) > 4096) {
      this.#poisoned = true; throw new Error('CONTACT_REVIEW_INTEGRITY');
    }
    if (row.turn !== null) {
      const turn = this.#db.prepare('SELECT request_id,device,payload FROM turns WHERE seq=?').get(row.turn);
      if (!turn || turn.request_id !== `review_${row.id}` || turn.device !== row.device
          || this.#open(`turn:${turn.request_id}`, turn.payload).text !== value.text) {
        this.#poisoned = true; throw new Error('CONTACT_REVIEW_INTEGRITY');
      }
    }
    return value;
  }
  reviewState(commitment, version) {
    this.#check(); if (this.#version !== 4) return null;
    const row = this.#db.prepare('SELECT r.*,t.state turn_state,t.error turn_error FROM followup_reviews r LEFT JOIN turns t ON t.seq=r.turn WHERE r.commitment=? AND r.version=?').get(commitment, version);
    return row ? { id: row.id, state: row.state === 'cancelled' ? 'cancelled' : row.turn_state ?? row.state,
      turn: row.turn, error: row.error ?? row.turn_error, due: row.due } : null;
  }
  reviewForTurn(seq) {
    this.#check(); if (this.#version !== 4) return null;
    const row = this.#db.prepare('SELECT * FROM followup_reviews WHERE turn=?').get(seq);
    return row ? { ...this.#reviewPayload(row), id: row.id } : null;
  }
  armReview(device, commitment, version, consent, now = Date.now()) {
    this.#check();
    if (this.#version !== 4) throw new Error('CONTACT_REVIEW_UPGRADE_REQUIRED');
    if (!isFollowupId(commitment) || !counter(version) || version < 1 || !counter(now)
        || consent !== 'one_local_read_only_review') throw new Error('CONTACT_REVIEW_CONSENT_REQUIRED');
    return this.#tx(() => {
      this.#device(device, now);
      const item = this.followup(commitment);
      if (!item || item.version !== version) throw new Error('CONTACT_FOLLOWUP_STALE');
      this.#device(item.owner_device, now);
      const existing = this.reviewState(commitment, version);
      if (existing) return { ...existing, replay: true }; // never rearm a cancelled/finished grant
      if (!['open','waiting'].includes(item.state) || item.notify_at === null) throw new Error('CONTACT_REVIEW_TIME_REQUIRED');
      const due = followupInstant(item.notify_at);
      if (due <= now) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
      if (due >= this.#db.prepare('SELECT expires FROM devices WHERE id=?').get(device).expires) throw new Error('CONTACT_FOLLOWUP_DEVICE_EXPIRES');
      if (this.#db.prepare("SELECT count(*) n FROM followup_reviews WHERE state='armed'").get().n >= 32
          || this.#db.prepare('SELECT count(*) n FROM followup_reviews').get().n >= 1000) throw new Error('CONTACT_FOLLOWUP_LIMIT');
      const id = hash(`review:${commitment}:${version}`);
      const text = `[예약한 일회성 확인 · ${item.notify_at}]\n${item.title}\n${item.details}\n현재 허용된 로컬 자료만 확인해 결과와 다음 행동을 알려 주세요. 확인하지 못한 내용은 구분해 주세요.`;
      if (Buffer.byteLength(JSON.stringify(text)) > 4096) throw new Error('CONTACT_MESSAGE_INVALID');
      const value = { commitment, version, device, due, consent, text };
      this.#db.prepare("INSERT INTO followup_reviews VALUES(?,?,?,?,?,?,'armed',NULL,NULL,?)")
        .run(id, commitment, version, device, this.#seal(`review:${id}`, value), due, now);
      return { ...this.reviewState(commitment, version), replay: false };
    });
  }
  #cancelReviews(commitment, error, version = null) {
    // A terminal grant from an older revision must never revoke the new one.
    const selection = 'SELECT turn FROM followup_reviews WHERE commitment=? AND (? IS NULL OR version=?)';
    this.#db.prepare(`UPDATE turns SET state='cancelled',error=? WHERE state IN('queued','running') AND seq IN(${selection})`).run(error, commitment, version, version);
    this.#db.prepare(`UPDATE telegram_outbox SET state='suppressed',error=? WHERE state='queued' AND turn IN(${selection})`).run(error, commitment, version, version);
    this.#db.prepare("UPDATE followup_reviews SET state='cancelled',error=? WHERE commitment=? AND (? IS NULL OR version=?) AND (state='armed' OR (state='queued' AND turn IN(SELECT seq FROM turns WHERE state IN('cancelled','queued','running'))))").run(error, commitment, version, version);
  }
  cancelReview(device, commitment, version) {
    this.#check(); if (this.#version !== 4) throw new Error('CONTACT_REVIEW_UPGRADE_REQUIRED');
    return this.#tx(() => {
      this.#device(device);
      if (!isFollowupId(commitment) || !counter(version) || this.followup(commitment)?.version !== version) throw new Error('CONTACT_FOLLOWUP_STALE');
      this.#cancelReviews(commitment, 'CONTACT_REVIEW_CANCELLED', version);
      return this.reviewState(commitment, version);
    });
  }
  #sweepReviews(now) {
    const rows = this.#db.prepare("SELECT r.*,f.version current_version,f.state work_state,f.device work_device,t.state turn_state FROM followup_reviews r JOIN followups f ON f.id=r.commitment LEFT JOIN turns t ON t.seq=r.turn WHERE r.state IN('armed','queued')").all();
    for (const row of rows) {
      let live = row.version === row.current_version && ['open','waiting'].includes(row.work_state);
      try { this.#device(row.device, now); this.#device(row.work_device, now); }
      catch (error) { if (error.message !== 'CONTACT_DEVICE_REVOKED') throw error; live = false; }
      if (!live) this.#cancelReviews(row.commitment, 'CONTACT_REVIEW_SUPERSEDED', row.version);
      else if ((row.state === 'armed' || row.turn_state === 'queued') && now - row.due > 86400000) {
        this.#cancelReviews(row.commitment, 'CONTACT_REVIEW_MISSED', row.version);
      }
    }
  }
  reviewTick(now = Date.now()) {
    this.#check(); if (this.#version !== 4) return 0;
    if (!counter(now)) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
    return this.#tx(() => {
      this.#sweepReviews(now); let count = 0;
      for (const row of this.#db.prepare("SELECT * FROM followup_reviews WHERE state='armed' AND due<=? ORDER BY due,id").all(now)) {
        // A stale autonomous review is not silently executed days after its appointment.
        if (now - row.due > 86400000) { this.#cancelReviews(row.commitment, 'CONTACT_REVIEW_MISSED', row.version); continue; }
        if (this.#db.prepare("SELECT count(*) n FROM turns WHERE state IN('queued','running')").get().n >= 16
            || this.#db.prepare('SELECT count(*) n FROM turns').get().n >= 1000) break;
        const value = this.#reviewPayload(row), requestId = `review_${row.id}`;
        const result = this.#db.prepare("INSERT INTO turns(request_id,device,state,payload,created) VALUES(?,?,'queued',?,?)")
          .run(requestId, row.device, this.#seal(`turn:${requestId}`, { text: value.text }), now);
        this.#db.prepare("UPDATE followup_reviews SET state='queued',turn=? WHERE id=?").run(Number(result.lastInsertRowid), row.id);
        count++;
      }
      return count;
    });
  }
  async upgradeReviews() {
    this.#check(); if (this.#version === 4) return null;
    if (this.#version !== 3) throw new Error('CONTACT_FOLLOWUP_UPGRADE_REQUIRED');
    if (this.#db.prepare("SELECT seq FROM turns WHERE state='running'").get()
        || this.#db.prepare("SELECT id FROM telegram_outbox WHERE state='sending'").get()) throw new Error('CONTACT_UPGRADE_BUSY');
    const path = join(this.#root, `before-reviews-${randomUUID()}.sqlite`);
    this.#upgrading = true;
    try {
      closeSync(openSync(path, 'wx', 0o600)); await backup(this.#db, path);
      const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== 'win32') { const dir = openSync(this.#root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.#upgrading = false;
      this.#tx(() => { this.#db.exec(REVIEW_SCHEMA); this.#db.prepare('UPDATE identity SET schema_hash=? WHERE singleton=1').run(hash(SCHEMA_V4)); });
      this.#version = 4; return path;
    } finally { this.#upgrading = false; }
  }
  async upgradeFollowups() {
    this.#check(); if (this.#version >= 3) return null;
    if (this.#version !== 2) throw new Error('CONTACT_MESSAGING_UPGRADE_REQUIRED');
    if (this.#db.prepare("SELECT seq FROM turns WHERE state='running'").get()
        || this.#db.prepare("SELECT id FROM telegram_outbox WHERE state='sending'").get()) throw new Error('CONTACT_UPGRADE_BUSY');
    const path = join(this.#root, `before-followups-${randomUUID()}.sqlite`);
    this.#upgrading = true;
    try {
      closeSync(openSync(path, 'wx', 0o600)); await backup(this.#db, path);
      const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== 'win32') { const dir = openSync(this.#root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.#upgrading = false;
      this.#tx(() => {
        this.#db.exec(FOLLOWUP_SCHEMA);
        this.#db.prepare('UPDATE identity SET schema_hash=? WHERE singleton=1').run(hash(SCHEMA_V3));
      });
      this.#version = 3; return path;
    } finally { this.#upgrading = false; }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db?.close(); } finally { this.#owner?.close(); this.#key?.fill(0); }
  }
}
export const contactRoute = value => hash(JSON.stringify(value));
