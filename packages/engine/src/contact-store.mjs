// Host-owned contact journal. Raw context never goes into a browser checkpoint.
// Separate from the existing action ledger: documents are conversation results,
// never an authority to overwrite arbitrary files or publish externally.
import { DatabaseSync, backup } from 'node:sqlite';
import { validateFollowupProposal, followupTimezone, followupInstant, isFollowupId, followupReviewText } from './followup-contract.mjs';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { ATTENTION_CONSENT, ATTENTION_INTERVAL, validAttention, localDay, localHour, eventKey, reminderDue, reminderText } from './attention.mjs';
import { CONTINUING_CONSENT, REQUEST_LIMIT, REQUEST_WINDOW, validContinuingUse, useWindow } from './continuing-use.mjs';
import { GOOGLE_SCOPES, validGoogleCredential, validGoogleDisconnect } from './google-contract.mjs';

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
const ASSISTANCE_SCHEMA = `
CREATE TABLE assistance_settings(name TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
CREATE TABLE proactive_runs(turn INTEGER PRIMARY KEY REFERENCES turns(seq),epoch TEXT NOT NULL,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL) STRICT;
PRAGMA user_version=5;
`;
const SCHEMA_V5 = SCHEMA_V4 + ASSISTANCE_SCHEMA;


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
  constructor({ directory, passphrase, route, initialize = false, followups = false, reviews = false, assistance = false }) {
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
          const schema = assistance ? SCHEMA_V5 : reviews ? SCHEMA_V4 : followups ? SCHEMA_V3 : SCHEMA_V2;
          this.#db.exec(schema); this.#version = assistance ? 5 : reviews ? 4 : followups ? 3 : 2;
          this.#db.prepare('INSERT INTO identity VALUES(1,?,?,?,?,?)').run(this.#id, salt,
            this.#seal('identity', { id: this.#id, route }), route, hash(schema));
          this.#db.exec('COMMIT');
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
      } else {
        this.#version = this.#db.prepare('PRAGMA user_version').get().user_version;
        if (![1, 2, 3, 4, 5].includes(this.#version)) throw new Error('CONTACT_SCHEMA_UNSUPPORTED');
        const identity = this.#db.prepare('SELECT * FROM identity WHERE singleton=1').get();
        if (!identity || identity.route !== route || identity.schema_hash !== hash(this.#version === 1 ? SCHEMA : this.#version === 2 ? SCHEMA_V2 : this.#version === 3 ? SCHEMA_V3 : this.#version === 4 ? SCHEMA_V4 : SCHEMA_V5)) throw new Error('CONTACT_ROUTE_CHANGED');
        this.#id = identity.id;
        this.#key = scryptSync(passphrase, identity.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const proof = this.#open('identity', identity.proof);
        if (proof.id !== this.#id || proof.route !== route) throw new Error('CONTACT_UNLOCK_FAILED');
      }
      if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
          || this.#db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('CONTACT_STORE_INVALID');
      // Authenticate ciphertext before making any recovery change.
      this.checkpoint();
      for (const row of this.#db.prepare('SELECT * FROM turns').iterate()) this.#turn(row);
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
      if (this.#version >= 4) {
        for (const row of this.#db.prepare('SELECT * FROM followup_reviews').all()) this.#reviewPayload(row);
      }
      if (this.#version >= 5) {
        for (const row of this.#db.prepare('SELECT * FROM assistance_settings').all()) this.#setting(row.name);
        this.#sweepProactive();
      }
      this.#tx(() => {
        this.#synchronizeUse();
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
      const google = this.#setting('google');
      if (google?.device === id) this.#saveSetting('google', null);
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
          || (!this.continuingUseEnabled() && this.#db.prepare('SELECT count(*) n FROM turns').get().n >= 1000)) throw new Error('CONTACT_QUEUE_LIMIT');
      const result = this.#db.prepare("INSERT INTO turns(request_id,device,state,payload,created) VALUES(?,?,'queued',?,?)")
        .run(requestId, device, this.#seal(`turn:${requestId}`, { text }), Date.now());
      return { seq: Number(result.lastInsertRowid), replay: false };
    });
  }
  claim() {
    return this.#tx(() => {
      if (this.#db.prepare("SELECT seq FROM turns WHERE state='running'").get()) return null;
      this.#db.prepare("UPDATE turns SET state='cancelled',error='DEVICE_REVOKED' WHERE state='queued' AND device IN(SELECT id FROM devices WHERE revoked=1 OR expires<=?)").run(Date.now());
      if (this.#version >= 4) this.#sweepReviews(Date.now());
      this.#sweepProactive();
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
    const answer = row.answer ? this.#open(`answer:${row.request_id}`, row.answer) : null;
    if (answer?.document) {
      const d = answer.document;
      if (d.version !== 1 || d.id !== row.seq || !Number.isSafeInteger(d.root) || d.root < 1 || d.root > d.id
          || !Number.isSafeInteger(d.revision) || d.revision < 1 || !['markdown', 'text'].includes(d.format)
          || typeof d.title !== 'string' || !d.title.trim() || d.title.length > 120
          || (d.based_on !== null && (!Number.isSafeInteger(d.based_on) || d.based_on < 1 || d.based_on >= d.id))
          || typeof answer.text !== 'string' || Buffer.byteLength(answer.text) > 4096 || d.sha256 !== hash(answer.text)) throw Error('CONTACT_DOCUMENT_INVALID');
    }
    return { seq: row.seq, request_id: row.request_id, device: row.device, state: row.state, created: row.created,
      text: this.#open(`turn:${row.request_id}`, row.payload).text,
      ...(this.proactiveForTurn(row.seq) ? { origin: 'proactive' } : {}),
      answer, error: row.error };
  }
  document(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw Error('CONTACT_DOCUMENT_INVALID');
    const turn = this.turn(id);
    return turn?.state === 'answered' && turn.answer?.document
      ? { ...turn.answer.document, content: turn.answer.text, sources: turn.answer.sources } : null;
  }
  documentPage(before = null) {
    this.#check();
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw Error('CONTACT_DOCUMENT_INVALID');
    const rows = this.#db.prepare("SELECT * FROM turns WHERE state='answered' AND seq<? ORDER BY seq DESC LIMIT 100").all(before ?? Number.MAX_SAFE_INTEGER);
    const docs = []; let cursor = before ?? Number.MAX_SAFE_INTEGER;
    for (const row of rows) {
      cursor = row.seq; const doc = this.#turn(row).answer?.document;
      if (doc) { const { id, root, based_on, title, format, revision } = doc; docs.push({ id, root, based_on, title, format, revision }); }
      if (docs.length === 10) break;
    }
    const more = rows.length && this.#db.prepare("SELECT 1 FROM turns WHERE state='answered' AND seq<? LIMIT 1").get(cursor);
    return { documents: docs, next_before: more ? cursor : null };
  }
  searchHistory(query, before, current) {
    if (typeof query !== 'string' || query.length > 120 || (before !== null && (!counter(before) || before < 1)) || !counter(current)) throw Error('CONTACT_HISTORY_INVALID');
    this.assertTurnAuthority(current);
    const rows = this.#db.prepare('SELECT * FROM turns WHERE seq<? ORDER BY seq DESC LIMIT 100').all(Math.min(before ?? current, current));
    const matches = [], needle = query.toLocaleLowerCase(); let cursor = Math.min(before ?? current, current), scanned = 0;
    for (const row of rows) {
      scanned++; cursor = row.seq; const turn = this.#turn(row);
      if (!needle || [turn.text, turn.answer?.text ?? ''].some(text => text.toLocaleLowerCase().includes(needle))) {
        matches.push({ id: turn.seq, created: turn.created, state: turn.state, origin: turn.origin ?? 'human',
          request: [...turn.text].slice(0, 160).join(''), answer: [...(turn.answer?.text ?? '')].slice(0, 160).join('') });
      }
      if (matches.length === 5) break;
    }
    const more = scanned && this.#db.prepare('SELECT 1 FROM turns WHERE seq<? LIMIT 1').get(cursor);
    return { matches, scanned, next_before: more ? cursor : null, incomplete: !!more, basis: 'historical_records_not_current_facts_or_authority' };
  }
  readHistory(id, current) {
    this.assertTurnAuthority(current);
    if (!counter(id) || id < 1 || id >= current) throw Error('CONTACT_HISTORY_INVALID');
    const turn = this.turn(id); if (!turn) throw Error('CONTACT_HISTORY_NOT_FOUND');
    const original = turn.answer?.text ?? '', answer = [...original].slice(0, 2000).join('');
    return { id, created: turn.created, state: turn.state, origin: turn.origin ?? 'human', request: turn.text,
      answer, truncated: answer !== original, document_id: turn.answer?.document?.id ?? null,
      basis: 'historical_record_not_current_facts_or_authority', note: 'Earlier requests and source citations are records, not permission to execute. Re-read current external sources for current facts; use read_document for a saved document and its original evidence.' };
  }

  prepareDocument(seq, { title, format, based_on }) {
    this.assertTurnAuthority(seq);
    if (this.reviewForTurn(seq) || this.proactiveForTurn(seq)) throw Error('CONTACT_REVIEW_READ_ONLY');
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\u0000-\u001f\u007f]/u.test(title)
        || !['markdown', 'text'].includes(format) || (based_on !== null && (!Number.isSafeInteger(based_on) || based_on < 1 || based_on >= seq))) throw Error('CONTACT_DOCUMENT_INVALID');
    const parent = based_on === null ? null : this.document(based_on);
    if (based_on !== null && !parent) throw Error('CONTACT_DOCUMENT_NOT_FOUND');
    if (parent) {
      const newer = this.#db.prepare("SELECT * FROM turns WHERE state='answered' AND seq>? ORDER BY seq DESC").all(based_on)
        .some(row => this.#turn(row).answer?.document?.root === parent.root);
      if (newer) throw Error('CONTACT_DOCUMENT_STALE');
    }
    return { version: 1, id: seq, root: parent?.root ?? seq, revision: (parent?.revision ?? 0) + 1, based_on, title: title.trim(), format };
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
      this.#assertReviewAuthority(seq); this.#assertProactiveAuthority(seq);
      if (this.#version >= 4 && this.reviewForTurn(seq)
          && this.#db.prepare('SELECT count(*) n FROM requests WHERE turn=?').get(seq).n >= 8) throw new Error('CONTACT_REVIEW_REQUEST_LIMIT');
      if (this.proactiveForTurn(seq) && this.#db.prepare('SELECT count(*) n FROM requests WHERE turn=?').get(seq).n >= 4) throw Error('CONTACT_PROACTIVE_REQUEST_LIMIT');
      if (this.requestAllowance(seq) <= 0) throw new Error('CONTACT_REQUEST_LIMIT');
      const id = Number(this.#db.prepare("INSERT INTO requests(turn,state) VALUES(?,'reserved')").run(seq).lastInsertRowid);
      const policy = this.#setting('continuing_use');
      if (policy) {
        const window = useWindow(policy, Date.now());
        this.#saveSetting('continuing_use', { ...window, last_request: id, receipts: [...window.receipts, { id, at: window.clock_at }].slice(-REQUEST_LIMIT) });
      }
      return id;
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
    const total = this.#db.prepare("SELECT count(*) requests,coalesce(sum(input_tokens),0) input_tokens,coalesce(sum(output_tokens),0) output_tokens,coalesce(sum(state!='observed'),0) unknown_requests FROM requests").get();
    if (!Object.values(total).every(counter)) throw Error('CONTACT_USAGE_OVERFLOW');
    return { ...total };
  }
  #synchronizeUse() {
    const policy = this.#setting('continuing_use'); if (!policy) return;
    const rows = this.#db.prepare('SELECT seq FROM requests ORDER BY seq DESC LIMIT 64').all().reverse();
    const last = rows.at(-1)?.seq ?? 0;
    if (last < policy.last_request) throw Error('CONTACT_USAGE_POLICY_INVALID');
    if (last === policy.last_request) return;
    // A previous compatible runtime may have made requests without timestamps.
    // Count every untracked reservation at reopening; never invent expired use.
    const window = useWindow(policy, Date.now());
    const receipts = rows.filter(r => r.seq > policy.last_request || window.receipts.some(old => old.id === r.seq))
      .map(r => window.receipts.find(old => old.id === r.seq) ?? { id: r.seq, at: window.clock_at });
    this.#saveSetting('continuing_use', { ...window, last_request: last, receipts });
  }
  continuingUseEnabled(now = Date.now()) {
    const policy = this.#setting('continuing_use');
    if (!policy?.enabled) return false;
    try { this.#device(policy.device, now); return true; } catch { return false; }
  }
  useStatus(now = Date.now()) {
    this.#check();
    const policy = this.#setting('continuing_use'), enabled = this.continuingUseEnabled(now);
    const window = policy ? useWindow(policy, now) : null;
    const remaining = Math.max(0, REQUEST_LIMIT - (enabled ? window.receipts.length : this.usage().requests));
    return { available: this.#version >= 5, enabled, limit: REQUEST_LIMIT, remaining,
      resumes_at: enabled && !remaining ? window.receipts[0].at + REQUEST_WINDOW : null };
  }
  configureContinuingUse(device, enabled, consent, now = Date.now()) {
    if (typeof enabled !== 'boolean' || (enabled ? consent !== CONTINUING_CONSENT : consent !== null) || !counter(now)) throw Error('CONTACT_USAGE_CONSENT_REQUIRED');
    return this.#tx(() => {
      this.#device(device, now);
      const prior = this.#setting('continuing_use');
      const rows = prior ? [] : this.#db.prepare('SELECT seq FROM requests ORDER BY seq DESC LIMIT 64').all().reverse();
      const value = prior ? useWindow(prior, now) : { version: 1, enabled, device, clock_at: now, last_request: rows.at(-1)?.seq ?? 0, receipts: rows.map(r => ({ id: r.seq, at: now })) };
      this.#saveSetting('continuing_use', { ...value, enabled, device });
      return this.useStatus(now);
    });
  }
  requestRoom(kind = 'foreground', now = Date.now()) {
    return kind !== 'legacy' && this.continuingUseEnabled(now) ? this.useStatus(now).remaining : Math.max(0, REQUEST_LIMIT - this.usage().requests);
  }
  requestAllowance(seq, now = Date.now()) {
    this.assertTurnAuthority(seq);
    const run = this.proactiveForTurn(seq), review = this.reviewForTurn(seq);
    const room = this.requestRoom(review || run && this.#setting('proactive')?.version !== 2 ? 'legacy' : run ? 'continuous' : 'foreground', now);
    if (!run && !review) return room;
    const used = this.#db.prepare('SELECT count(*) n FROM requests WHERE turn=?').get(seq).n;
    return Math.min(room, Math.max(0, (run ? 4 : 8) - used));
  }

  finish(seq, answer, checkpoint, proposals = [], document = null) {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(seq);
      if (row?.state !== 'running') return false;
      this.#device(row.device);
      this.#assertReviewAuthority(seq); this.#assertProactiveAuthority(seq);
      if (typeof answer?.text !== 'string' || !answer.text.trim() || !Array.isArray(answer.sources)
          || !checkpoint || ![1, 2].includes(checkpoint.version)) throw new Error('CONTACT_ANSWER_INVALID');
      if (this.#version >= 4 && this.reviewForTurn(seq) && proposals.length) throw new Error('CONTACT_REVIEW_READ_ONLY');
      if (this.proactiveForTurn(seq) && (proposals.length || document)) throw Error('CONTACT_PROACTIVE_READ_ONLY');
      if (Object.hasOwn(answer, 'document')) throw Error('CONTACT_DOCUMENT_INVALID');
      if (document) {
        const checked = this.prepareDocument(seq, document);
        if (Object.keys(checked).some(k => checked[k] !== document[k]) || Buffer.byteLength(answer.text) > 4096) throw Error('CONTACT_DOCUMENT_INVALID');
        answer = { ...answer, document: { ...checked, sha256: hash(answer.text) } };
      }
      this.#saveFollowupProposals(row, proposals);
      this.#db.prepare("UPDATE turns SET state='answered',answer=? WHERE seq=?").run(this.#seal(`answer:${row.request_id}`, answer), seq);
      if (!answer.quiet) this.#db.prepare('INSERT INTO context VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET through_seq=excluded.through_seq,payload=excluded.payload')
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
        .run(id, device, turn, part, this.#seal(`telegram-out:${id}`, { chat: binding.chat, bot: binding.bot, text: parts[part], group: hash(key) }), Date.now());
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
        const proactive = this.proactiveForTurn(row.seq);
        if (proactive && (row.state !== 'answered' || this.#turn(row).answer?.quiet || !this.#proactiveLive(proactive) || !this.#attentionNoticeLive(row.seq))) continue;
        const key = `result:${binding.device}:${row.seq}`;
        if (this.#db.prepare('SELECT id FROM telegram_outbox WHERE id=?').get(hash(`${key}:0`))) continue;
        const fromTelegram = row.device === binding.device;
        let text;
        if (proactive) {
          text = 'Tada · 먼저 챙겨봤어요\n새 제안이 대화에 있어요. 이 채팅에서 “새 제안 알려줘”라고 말씀해 주세요.';
        } else if (!fromTelegram) {
          text = row.state === 'answered' ? `Tada · 요청 ${row.seq}\n브라우저에서 맡긴 요청의 답변이 준비됐어요. 같은 연락 화면에서 확인할 수 있어요.`
            : `Tada · 요청 ${row.seq}\n브라우저 요청이 중지됐어요. 같은 연락 화면에서 상태를 확인해 주세요.`;
        } else if (row.state === 'answered') {
          const turn = this.#turn(row);
          text = `Tada · 요청 ${row.seq}\n${turn.answer.text}`;
          if (turn.answer.notice) text += '\n\n' + turn.answer.notice;
          if (turn.answer.sources.length) text += '\n\n자료 식별자·관측 시각은 같은 연락 화면의 참고 자료에서 확인할 수 있어요.';
        } else {
          let failure = '이번 답변을 완료하지 못했어요. 앞선 대화는 보존했어요. 새 메시지로 이어서 이야기할 수 있어요.';
          if (['CONTACT_GOOGLE_RECONNECT_REQUIRED', 'CONTACT_GOOGLE_SCOPE_DENIED', 'CONTACT_GOOGLE_PERMISSION_DENIED'].includes(row.error)) {
            failure = 'Google 연결이나 읽기 권한을 다시 확인해야 해요. 컴퓨터의 Tada 설정에서 Gmail과 일정 연결을 확인하고 Google을 다시 연결한 뒤 말씀해 주세요. 앞선 대화는 보존했고 자동으로 다시 실행하지 않았어요.';
          } else if (row.error === 'CONTACT_GOOGLE_RESPONSE_LIMIT') {
            failure = 'Google에서 받은 자료가 너무 커 확인을 마치지 못했어요. 요청 내용을 좁히거나 다른 자료로 새 메시지를 보내 주세요. 앞선 대화는 보존했고 자동으로 다시 실행하지 않았어요.';
          } else if (['CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE', 'CONTACT_GOOGLE_RESPONSE_INVALID'].includes(row.error)) {
            failure = 'Google 정보를 지금 확인하지 못해 답변을 멈췄어요. 잠시 후 새 메시지로 말씀해 주세요. 앞선 대화는 보존했고 자동으로 다시 실행하지 않았어요.';
          }
          text = `Tada · 요청 ${row.seq}\n${row.state === 'cancelled' ? '요청을 취소했어요.' : failure}`;
        }
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
      if (this.#version >= 4) {
        this.#sweepReviews(now);
        this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='CONTACT_REVIEW_SUPERSEDED' WHERE state='queued' AND turn IN(SELECT r.turn FROM followup_reviews r JOIN followups f ON f.id=r.commitment JOIN devices d ON d.id=r.device JOIN devices w ON w.id=f.device WHERE r.state='cancelled' OR r.version<>f.version OR f.state NOT IN('open','waiting') OR d.revoked=1 OR d.expires<=? OR w.revoked=1 OR w.expires<=?)").run(now, now);
      }
      this.#sweepProactive(now);
      for (const row of this.#db.prepare("SELECT id,turn FROM telegram_outbox WHERE state='queued' AND turn IS NOT NULL").all()) if (!this.#attentionNoticeLive(row.turn)) this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='CONTACT_SOURCE_CHANGED' WHERE id=?").run(row.id);
      // A lost first part must not be followed by dangling continuation parts.
      this.#db.exec("UPDATE telegram_outbox AS o SET state='suppressed',error='PREVIOUS_PART_UNCONFIRMED' WHERE o.state='queued' AND o.turn IS NOT NULL AND EXISTS(SELECT 1 FROM telegram_outbox p WHERE p.device=o.device AND p.turn=o.turn AND p.part<o.part AND p.state IN('unknown','rejected','suppressed'))");
      const candidates = this.#db.prepare("SELECT o.* FROM telegram_outbox o WHERE o.state='queued' AND o.not_before<=? AND NOT EXISTS(SELECT 1 FROM telegram_outbox p WHERE p.device=o.device AND p.turn=o.turn AND p.part<o.part AND p.state IN('queued','sending')) ORDER BY o.created,o.part,o.id").all(now);
      const row = candidates.find(candidate => {
        if (candidate.turn !== null || candidate.part === 0) return true;
        const value = this.#open(`telegram-out:${candidate.id}`, candidate.payload);
        const earlier = this.#db.prepare("SELECT * FROM telegram_outbox WHERE device=? AND turn IS NULL AND part<? AND state<>'sent'").all(candidate.device, candidate.part);
        for (const previous of earlier) {
          const prior = this.#open(`telegram-out:${previous.id}`, previous.payload);
          if (value.group ? value.group !== prior.group : prior.group) continue;
          if (['queued', 'sending'].includes(previous.state)) return false;
          if (value.group && ['unknown', 'rejected', 'suppressed'].includes(previous.state)) {
            this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='PREVIOUS_PART_UNCONFIRMED' WHERE id=?").run(candidate.id); return false;
          }
        }
        return true;
      });
      if (!row) return null;
      if (this.#db.prepare("SELECT id FROM telegram_outbox WHERE state='sending'").get()) return null;
      this.#device(row.device);
      const payload = this.#open(`telegram-out:${row.id}`, row.payload);
      const binding = this.telegramBinding();
      if (!binding?.live || binding.device !== row.device || payload.chat !== binding.chat || payload.bot !== binding.bot) throw new Error('CONTACT_TELEGRAM_BINDING_INVALID');
      this.#db.prepare("UPDATE telegram_outbox SET state='sending' WHERE id=?").run(row.id);
      return { id: row.id, device: row.device, turn: row.turn, ...payload };
    });
  }
  assertTelegramDelivery(delivery) {
    this.#check();
    const row = this.#db.prepare('SELECT * FROM telegram_outbox WHERE id=?').get(delivery.id);
    const binding = this.telegramBinding();
    if (row?.state !== 'sending' || row.device !== delivery.device || row.turn !== delivery.turn
        || !binding?.live || binding.device !== row.device) throw Error('CONTACT_TELEGRAM_DELIVERY_STOPPED');
    this.#device(row.device);
    const payload = this.#open(`telegram-out:${row.id}`, row.payload);
    if (payload.chat !== binding.chat || payload.bot !== binding.bot || ['chat', 'bot', 'text', 'group'].some(k => payload[k] !== delivery[k])) throw Error('CONTACT_TELEGRAM_DELIVERY_STOPPED');
    if (row.turn !== null) { this.#assertReviewAuthority(row.turn); this.#assertProactiveAuthority(row.turn); }
    if (this.#version >= 3) {
      const notice = this.#db.prepare('SELECT n.state,n.version,f.version current_version,f.state work_state,f.device FROM followup_notices n JOIN followups f ON f.id=n.commitment WHERE n.telegram_id=?').get(row.id);
      if (notice) {
        this.#device(notice.device);
        if (notice.state !== 'ready' || notice.version !== notice.current_version || !['open', 'waiting'].includes(notice.work_state)) throw Error('CONTACT_TELEGRAM_DELIVERY_STOPPED');
      }
    }
  }
  telegramDelivery(id, state, { receipt = null, retryAt = 0, error = null } = {}) {
    this.#messaging();
    if (!['sent','unknown','rejected','queued','suppressed'].includes(state) || !counter(retryAt)
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
    if (!['active', 'all'].includes(status) || !counter(offset) || (!this.continuingUseEnabled() && offset > 1000)) throw new Error('CONTACT_FOLLOWUP_INVALID');
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
    return { available: true, reviews_available: this.#version >= 4, ...this.followupPage('active', 0), proposals, notices };
  }
  #saveFollowupProposals(turn, proposals) {
    if (!Array.isArray(proposals) || proposals.length > 4) throw new Error('CONTACT_FOLLOWUP_INVALID');
    if (!proposals.length) return;
    this.#followups();
    if (this.#db.prepare("SELECT count(*) n FROM followup_proposals WHERE state='pending'").get().n + proposals.length > 32
        || (!this.continuingUseEnabled() && this.#db.prepare('SELECT count(*) n FROM followup_proposals').get().n + proposals.length > 1000)) throw new Error('CONTACT_FOLLOWUP_LIMIT');
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
    if (this.#version >= 4) this.#cancelReviews(id, 'CONTACT_REVIEW_SUPERSEDED');
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
      const continuing = this.continuingUseEnabled();
      const addsActive = ['open', 'waiting'].includes(spec.state) && !['open', 'waiting'].includes(old?.state);
      if ((continuing ? addsActive : !old) && this.#db.prepare(continuing ? "SELECT count(*) n FROM followups WHERE state IN('open','waiting')" : 'SELECT count(*) n FROM followups').get().n >= 1000) throw new Error('CONTACT_FOLLOWUP_LIMIT');
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
    this.#device(turn.device); this.#assertReviewAuthority(seq); this.#assertProactiveAuthority(seq);
  }
  #assertReviewAuthority(seq) {
    if (this.#version < 4) return;
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
    this.#check(); if (this.#version < 4) return null;
    const row = this.#db.prepare('SELECT r.*,t.state turn_state,t.error turn_error FROM followup_reviews r LEFT JOIN turns t ON t.seq=r.turn WHERE r.commitment=? AND r.version=?').get(commitment, version);
    return row ? { id: row.id, state: row.state === 'cancelled' ? 'cancelled' : row.turn_state ?? row.state,
      turn: row.turn, error: row.error ?? row.turn_error, due: row.due } : null;
  }
  reviewForTurn(seq) {
    this.#check(); if (this.#version < 4) return null;
    const row = this.#db.prepare('SELECT * FROM followup_reviews WHERE turn=?').get(seq);
    return row ? { ...this.#reviewPayload(row), id: row.id } : null;
  }
  armReview(device, commitment, version, consent, now = Date.now()) {
    this.#check();
    if (this.#version < 4) throw new Error('CONTACT_REVIEW_UPGRADE_REQUIRED');
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
          || (!this.continuingUseEnabled() && this.#db.prepare('SELECT count(*) n FROM followup_reviews').get().n >= 1000)) throw new Error('CONTACT_FOLLOWUP_LIMIT');
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
    this.#check(); if (this.#version < 4) throw new Error('CONTACT_REVIEW_UPGRADE_REQUIRED');
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
    this.#check(); if (this.#version < 4) return 0;
    if (!counter(now)) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
    return this.#tx(() => {
      this.#sweepReviews(now); let count = 0;
      for (const row of this.#db.prepare("SELECT * FROM followup_reviews WHERE state='armed' AND due<=? ORDER BY due,id").all(now)) {
        // A stale autonomous review is not silently executed days after its appointment.
        if (now - row.due > 86400000) { this.#cancelReviews(row.commitment, 'CONTACT_REVIEW_MISSED', row.version); continue; }
        if (this.#db.prepare("SELECT count(*) n FROM turns WHERE state IN('queued','running')").get().n >= 16
            || (!this.continuingUseEnabled() && this.#db.prepare('SELECT count(*) n FROM turns').get().n >= 1000)) break;
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
    this.#check(); if (this.#version >= 4) return null;
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

  // v5 settings are encrypted in the same journal, never model-owned authority.
  #setting(name) {
    this.#check(); if (this.#version < 5) return null;
    const row = this.#db.prepare('SELECT payload FROM assistance_settings WHERE name=?').get(name);
    const value = row ? this.#open(`setting:${name}`, row.payload) : null;
    if (value !== null) {
      const valid = name === 'mobile' ? Object.keys(value).join(',') === 'token' && typeof value.token === 'string' && /^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,128}$/u.test(value.token)
        : name === 'google' ? validGoogleCredential(value)
        : name === 'google_disconnect' ? validGoogleDisconnect(value)
        : name === 'continuing_use' ? validContinuingUse(value)
        : name === 'attention' ? validAttention(value)
        : name === 'proactive' && Object.keys(value).sort().join(',') === 'device,enabled,epoch,last_fingerprint,next_at,timezone,version'
          && [1, 2].includes(value.version) && typeof value.enabled === 'boolean' && isFollowupId(value.epoch) && isFollowupId(value.device)
          && counter(value.next_at) && typeof value.timezone === 'string'
          && (value.last_fingerprint === null || /^[a-f0-9]{64}$/u.test(value.last_fingerprint));
      if (!valid) throw Error('CONTACT_SETTING_INVALID');
      if (name === 'proactive') followupTimezone(value.timezone);
    }
    return value;
  }
  #saveSetting(name, value) {
    if (this.#version < 5) throw Error('CONTACT_ASSISTANCE_UPGRADE_REQUIRED');
    this.#db.prepare('INSERT INTO assistance_settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload')
      .run(name, this.#seal(`setting:${name}`, value));
  }
  assertDevice(device) { this.#check(); this.#device(device); }
  assertStorageDirectory(directory) {
    this.#check();
    if (resolve(directory) !== this.#root) throw Error('CONTACT_STORAGE_OWNER_MISMATCH');
  }
  googleCredential() { const value = this.#setting('google'); return value ? structuredClone(value) : null; }
  googleDisconnectStatus() {
    const value = this.#setting('google_disconnect');
    return value ? { local_removed: true, remote_revoked: value.remote_revoked } : null;
  }
  noteGoogleDisconnect(epoch, remoteRevoked) {
    if (!validGoogleDisconnect({ version: 1, epoch, remote_revoked: remoteRevoked })) throw Error('CONTACT_GOOGLE_CREDENTIAL_INVALID');
    return this.#tx(() => {
      const value = this.#setting('google_disconnect');
      if (!value || value.epoch !== epoch || this.#setting('google')) return false;
      this.#saveSetting('google_disconnect', { ...value, remote_revoked: remoteRevoked });
      return true;
    });
  }
  googleEpoch() { return this.#setting('google')?.epoch ?? null; }
  googleConnected() {
    const value = this.#setting('google');
    if (!value || value.reconnect_required || value.scopes.length !== GOOGLE_SCOPES.length) return false;
    try { this.#device(value.device); return true; } catch { return false; }
  }
  assertGoogleAuthority(device, epoch) {
    this.#check(); this.#device(device);
    const value = this.#setting('google');
    if (!value || value.epoch !== epoch) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
    this.#device(value.device);
    if (value.reconnect_required) throw Error('CONTACT_GOOGLE_RECONNECT_REQUIRED');
    if (value.scopes.length !== GOOGLE_SCOPES.length || [...value.scopes].sort().join('\n') !== [...GOOGLE_SCOPES].sort().join('\n')) throw Error('CONTACT_GOOGLE_SCOPE_DENIED');
    return structuredClone(value);
  }
  saveGoogleCredential(device, value, expectedEpoch) {
    if (!validGoogleCredential(value) || value.device !== device || (expectedEpoch !== null && typeof expectedEpoch !== 'string')) throw Error('CONTACT_GOOGLE_CREDENTIAL_INVALID');
    return this.#tx(() => {
      this.#device(device);
      const old = this.#setting('google');
      if ((old?.epoch ?? null) !== expectedEpoch) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
      this.#saveSetting('google', structuredClone(value));
      this.#saveSetting('google_disconnect', null);
      return { connected: true, account: value.email };
    });
  }
  clearGoogleCredential(device) {
    return this.#tx(() => {
      this.#device(device);
      const old = this.#setting('google');
      this.#saveSetting('google', null);
      if (old) this.#saveSetting('google_disconnect', { version: 1, epoch: old.epoch, remote_revoked: false });
      return old ? structuredClone(old) : null;
    });
  }
  rotateGoogleRefresh(epoch, expected, refreshToken) {
    return this.#tx(() => {
      const value = this.#setting('google');
      if (!value || value.epoch !== epoch || value.refresh_token !== expected) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
      const next = { ...value, refresh_token: refreshToken };
      if (!validGoogleCredential(next)) throw Error('CONTACT_GOOGLE_CREDENTIAL_INVALID');
      this.#saveSetting('google', next);
    });
  }
  noteGoogleCheck(epoch, checkedAt) {
    return this.#tx(() => {
      const value = this.#setting('google');
      if (!value || value.epoch !== epoch) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
      const next = { ...value, last_checked: checkedAt, last_error: null, reconnect_required: false };
      if (!validGoogleCredential(next)) throw Error('CONTACT_GOOGLE_CREDENTIAL_INVALID');
      this.#saveSetting('google', next);
    });
  }
  noteGoogleError(epoch, error, checkedAt, reconnectRequired = false) {
    if (typeof reconnectRequired !== 'boolean' || !['authorization_denied', 'temporarily_unavailable', 'permission_denied', 'reconnect_required'].includes(error)) throw Error('CONTACT_GOOGLE_CREDENTIAL_INVALID');
    return this.#tx(() => {
      const value = this.#setting('google');
      if (!value || value.epoch !== epoch) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
      const next = { ...value, last_checked: checkedAt, last_error: error,
        reconnect_required: reconnectRequired || error === 'reconnect_required' || value.reconnect_required };
      if (!validGoogleCredential(next)) throw Error('CONTACT_GOOGLE_CREDENTIAL_INVALID');
      this.#saveSetting('google', next);
    });
  }
  mobileCredential() { return this.#setting('mobile'); }
  saveMobileCredential(device, token) {
    this.#tx(() => {
      this.#device(device);
      if (token !== null && (typeof token !== 'string' || !/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,128}$/u.test(token))) throw Error('CONTACT_TELEGRAM_TOKEN_INVALID');
      this.#saveSetting('mobile', token === null ? null : { token });
    });
  }
  proactiveForTurn(seq) {
    if (this.#version < 5) return null;
    const row = this.#db.prepare('SELECT * FROM proactive_runs WHERE turn=?').get(seq);
    if (!row) return null;
    const value = this.#open(`proactive:${seq}`, row.payload);
    if (Object.keys(value).sort().join(',') !== 'created,epoch,fingerprint,turn' || ['turn', 'epoch', 'fingerprint', 'created'].some(k => value[k] !== row[k])) throw Error('CONTACT_PROACTIVE_INVALID');
    return value;
  }
  #proactiveLive(run, now = Date.now()) {
    const grant = this.#setting('proactive');
    if (!grant?.enabled || run.epoch !== grant.epoch) return false;
    try { this.#device(grant.device, now); return true; } catch { return false; }
  }
  #proactiveCurrent(run, now = Date.now()) {
    if (!this.#proactiveLive(run, now)) return false;
    const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(run.turn);
    return this.#turn(row).answer?.calendar_reminder ? this.#attentionNoticeLive(run.turn) : run.fingerprint === this.#proactiveFingerprint();
  }
  #assertProactiveAuthority(seq) {
    const run = this.proactiveForTurn(seq);
    if (run && !this.#proactiveCurrent(run)) throw Error('CONTACT_PROACTIVE_STOPPED');
  }
  #sweepProactive(now = Date.now()) {
    if (this.#version < 5) return;
    for (const run of this.#db.prepare("SELECT r.* FROM proactive_runs r JOIN turns t ON t.seq=r.turn WHERE t.state IN('queued','running') OR EXISTS(SELECT 1 FROM telegram_outbox o WHERE o.turn=r.turn AND o.state='queued')").all()) {
      this.proactiveForTurn(run.turn);
      if (this.#proactiveCurrent(run, now)) continue;
      this.#db.prepare("UPDATE turns SET state='cancelled',error='CONTACT_PROACTIVE_STOPPED' WHERE seq=? AND state IN('queued','running')").run(run.turn);
      this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='CONTACT_PROACTIVE_STOPPED' WHERE turn=? AND state='queued'").run(run.turn);
    }
  }
  proactiveStatus() {
    const grant = this.#setting('proactive');
    const live = grant && this.#proactiveLive({ epoch: grant.epoch });
    const last = this.#version >= 5 ? this.#db.prepare('SELECT t.state,t.error,r.created FROM proactive_runs r JOIN turns t ON t.seq=r.turn ORDER BY r.turn DESC LIMIT 1').get() : null;
    return { available: this.#version >= 5, enabled: !!live, timezone: grant?.timezone ?? null,
      mode: grant?.version === 2 ? 'continuous' : 'daily', attention: grant?.version === 2 ? this.attentionStatus() : null,
      next_at: live ? grant.next_at : null, blocked_reason: live && this.requestRoom(grant.version === 2 ? 'continuous' : 'legacy') <= 4 ? 'usage_limit' : null, last: last ?? null };
  }
  configureProactive(device, enabled, consent, timezone, now = Date.now()) {
    if (typeof enabled !== 'boolean' || (enabled && !['daily_conversation_suggestions_v1', ATTENTION_CONSENT].includes(consent)) || (!enabled && consent !== null)) throw Error('CONTACT_PROACTIVE_CONSENT_REQUIRED');
    followupTimezone(timezone);
    return this.#tx(() => {
      this.#device(device);
      const old = this.#setting('proactive');
      const version = enabled ? (consent === ATTENTION_CONSENT ? 2 : 1) : (old?.version ?? 1);
      if (enabled && old?.enabled && old.version === version && this.#proactiveLive({ epoch: old.epoch })) return this.proactiveStatus();
      this.#saveSetting('proactive', { version, enabled, epoch: randomUUID(), device, timezone, next_at: old?.version === version ? old.next_at : now, last_fingerprint: old?.last_fingerprint ?? null });
      this.#sweepProactive(now); return this.proactiveStatus();
    });
  }
  #proactiveFingerprint() {
    const recent = this.#db.prepare('SELECT max(seq) seq FROM turns WHERE seq NOT IN(SELECT turn FROM proactive_runs)').get().seq;
    const work = this.#db.prepare("SELECT f.id,f.version,f.state,d.revoked,d.expires FROM followups f JOIN devices d ON d.id=f.device ORDER BY f.id").all();
    const google = this.#setting('google');
    return hash(JSON.stringify([recent, work, google ? { epoch: google.epoch, reconnect_required: google.reconnect_required } : null]));
  }
  proactiveTick(now = Date.now(), googleAvailable = false) {
    if (this.#version < 5) return 0;
    return this.#tx(() => {
      this.#sweepProactive(now);
      const grant = this.#setting('proactive');
      if (grant?.version === 2 || !grant?.enabled || !this.#proactiveLive({ epoch: grant.epoch }, now) || now < grant.next_at) return 0;
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: grant.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
      if (hour < 9 || hour >= 21) return 0;
      if (this.#db.prepare("SELECT seq FROM turns WHERE state IN('queued','running')").get()) return 0;
      const recent = this.#db.prepare('SELECT max(seq) seq FROM turns WHERE seq NOT IN(SELECT turn FROM proactive_runs)').get().seq;
      const external = googleAvailable && this.googleConnected();
      if ((!recent && !external) || this.requestRoom('legacy', now) <= 4 || (!this.continuingUseEnabled() && this.#db.prepare('SELECT count(*) n FROM turns').get().n >= 1000)) return 0;
      const fingerprint = this.#proactiveFingerprint();
      if (!external && fingerprint === grant.last_fingerprint) return 0;
      const requestId = `proactive_${randomUUID()}`;
      const text = '예약된 먼저 챙겨보기입니다(사람이 보낸 새 메시지가 아님). 최근 대화와 저장된 일을 살펴 새로 도움이 될 일을 제안하세요. Google 계정이 연결되어 있고 Tada 설정에서 먼저 챙겨보기를 켠 경우에만 최근 받은편지함과 앞으로 7일의 기본 캘린더를 함께 확인할 수 있습니다.';
      const result = this.#db.prepare("INSERT INTO turns(request_id,device,state,payload,created) VALUES(?,?,'queued',?,?)")
        .run(requestId, grant.device, this.#seal(`turn:${requestId}`, { text }), now);
      const seq = Number(result.lastInsertRowid);
      this.#db.prepare('INSERT INTO proactive_runs VALUES(?,?,?,?,?)').run(seq, grant.epoch, fingerprint, now, this.#seal(`proactive:${seq}`, { turn: seq, epoch: grant.epoch, fingerprint, created: now }));
      this.#saveSetting('proactive', { ...grant, next_at: now + 86400000, last_fingerprint: fingerprint });
      return 1;
    });
  }
  #attentionNoticeLive(seq) {
    const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(seq);
    if (!row || !this.#turn(row).answer?.calendar_reminder) return true;
    const state = this.#setting('attention');
    return state?.google_epoch === this.googleEpoch() && state?.notified.some(n => n.turn === seq && n.active) === true;
  }
  attentionDelivery(seq) {
    const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(seq);
    if (!row || !this.#turn(row).answer?.calendar_reminder) return null;
    const run = this.proactiveForTurn(seq), grant = this.#setting('proactive');
    if (!this.#proactiveLive(run) || !this.#attentionNoticeLive(seq)) return { stopped: true };
    const receipt = this.#setting('attention').notified.find(n => n.turn === seq);
    return { key: receipt.key, text: this.#turn(row).answer.text, created: row.created, ticket: { epoch: grant.epoch, device: grant.device, google_epoch: this.googleEpoch(), local_fingerprint: this.#proactiveFingerprint(), timezone: grant.timezone, claimed_at: Date.now() } };
  }
  assertAttentionDelivery(id, seq, ticket) {
    this.assertAttention(ticket); this.#assertProactiveAuthority(seq);
    const row = this.#db.prepare('SELECT * FROM telegram_outbox WHERE id=?').get(id);
    if (row?.state !== 'sending' || row.turn !== seq || !this.#attentionNoticeLive(seq)) throw Error('CONTACT_PROACTIVE_STOPPED');
    this.#device(row.device);
    const binding = this.telegramBinding();
    if (!binding?.live || binding.device !== row.device) throw Error('CONTACT_PROACTIVE_STOPPED');
  }
  reminderContext(_after, before) {
    if (this.#version < 5) return '';
    const rows = this.#db.prepare("SELECT t.* FROM turns t JOIN proactive_runs r ON r.turn=t.seq WHERE t.seq<? AND t.state='answered' ORDER BY t.seq DESC LIMIT 20").all(before);
    const notices = rows.map(row => this.#turn(row)).filter(t => t.answer?.calendar_reminder).slice(0, 3)
      .map(t => ({ id: t.seq, at: new Date(t.created).toISOString(), excerpt: [...t.answer.text].slice(0, 60).join('') }));
    return notices.length ? JSON.stringify(notices) : '';
  }
  attentionStatus() {
    const value = this.#setting('attention');
    return value ? { observed_at: value.observed_at || null, google_observed: !!value.google_epoch && value.google_epoch === this.googleEpoch() && value.observed_at > 0, error: value.error, checks_today: value.model_day === localDay(Date.now(), this.#setting('proactive').timezone) ? value.model_runs : 0 } : null;
  }
  #attentionState(grant) {
    const old = this.#setting('attention');
    // Retain cooldown and sent identities across toggles. Neither a toggle nor
    // reconnect resets resource use; a new Google epoch has different event keys.
    return { version: 1, epoch: grant.epoch, google_epoch: this.googleEpoch(), observed_at: 0, error: null, fingerprint: null,
      model_next_at: old?.model_next_at ?? 0, model_day: old?.model_day ?? '', model_runs: old?.model_runs ?? 0, notified: old?.notified ?? [],
      ...(old?.epoch === grant.epoch && old.google_epoch === this.googleEpoch() ? old : {}) };
  }
  assertAttention(ticket) {
    const grant = this.#setting('proactive');
    if (grant?.version !== 2 || ticket.epoch !== grant.epoch || ticket.device !== grant.device
        || !this.#proactiveLive(ticket) || ticket.google_epoch !== this.googleEpoch()) throw Error('CONTACT_PROACTIVE_STOPPED');
    if (ticket.google_epoch && !this.googleConnected()) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
  }
  claimAttention(now = Date.now()) {
    if (this.#version < 5) return null;
    return this.#tx(() => {
      this.#sweepProactive(now);
      const grant = this.#setting('proactive');
      if (grant?.version !== 2 || !this.#proactiveLive(grant, now) || now < grant.next_at) return null;
      this.#saveSetting('proactive', { ...grant, next_at: now + ATTENTION_INTERVAL });
      return { epoch: grant.epoch, device: grant.device, google_epoch: this.googleEpoch(), local_fingerprint: this.#proactiveFingerprint(), claimed_at: now, has_context: !!this.#db.prepare('SELECT seq FROM turns WHERE seq NOT IN(SELECT turn FROM proactive_runs) LIMIT 1').get() };
    });
  }
  failAttention(ticket, error) {
    return this.#tx(() => {
      const grant = this.#setting('proactive');
      if (grant?.version !== 2 || ticket.epoch !== grant.epoch || ticket.device !== grant.device
          || !this.#proactiveLive(ticket) || ticket.google_epoch !== this.googleEpoch()) return false;
      // Authentication failure changes the Google status/fingerprint itself;
      // record that failure without restoring any withdrawn read authority.
      const state = this.#attentionState(grant);
      this.#saveSetting('attention', { ...state, error: /^[A-Z_]{1,64}$/u.test(error) ? error : 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE' });
      return true;
    });
  }
  #enqueueProactive(grant, now, text, answer = null) {
    if (!this.continuingUseEnabled() && this.#db.prepare('SELECT count(*) n FROM turns').get().n >= 1000) return null;
    const requestId = `proactive_${randomUUID()}`, fingerprint = this.#proactiveFingerprint();
    const result = this.#db.prepare('INSERT INTO turns(request_id,device,state,payload,answer,created) VALUES(?,?,?,?,?,?)')
      .run(requestId, grant.device, answer ? 'answered' : 'queued', this.#seal(`turn:${requestId}`, { text }), answer ? this.#seal(`answer:${requestId}`, answer) : null, now);
    const seq = Number(result.lastInsertRowid);
    this.#db.prepare('INSERT INTO proactive_runs VALUES(?,?,?,?,?)').run(seq, grant.epoch, fingerprint, now, this.#seal(`proactive:${seq}`, { turn: seq, epoch: grant.epoch, fingerprint, created: now }));
    return seq;
  }
  finishAttention(ticket, observation, now = Date.now()) {
    return this.#tx(() => {
      this.assertAttention(ticket);
      const grant = this.#setting('proactive'), state = this.#attentionState(grant);
      // Only trusted host observation enters here, never an HTTP/model payload.
      if (!observation || !/^[a-f0-9]{64}$/u.test(observation.fingerprint) || !Array.isArray(observation.events)
          || observation.events.length > 20 || (observation.error != null && !/^[A-Z_]{1,64}$/u.test(observation.error)) || observation.observed_at < ticket.claimed_at || now - observation.observed_at > 60000) throw Error('CONTACT_GOOGLE_SOURCE_STALE');
      const keys = new Set(observation.events.map(event => eventKey(observation.account, event)));
      let notified = state.notified.filter(n => n.until > now), changes = 0;
      // Suppress undelivered alerts removed or rescheduled in a complete view.
      // A truncated observation cannot establish absence.
      for (const old of notified) {
        const event = observation.events.find(item => eventKey(observation.account, item) === old.key);
        const row = this.#db.prepare('SELECT * FROM turns WHERE seq=?').get(old.turn);
        const changedTitle = event && row && reminderText(event, row.created, grant.timezone) !== this.#turn(row).answer.text;
        if ((!observation.truncated && !keys.has(old.key)) || changedTitle) {
          old.active = false;
          this.#db.prepare("UPDATE telegram_outbox SET state='suppressed',error='CONTACT_SOURCE_CHANGED' WHERE turn=? AND state='queued'").run(old.turn);
        }
      }
      for (const event of observation.events) {
        const key = eventKey(observation.account, event);
        if (!reminderDue(event, now, grant.timezone) || notified.some(n => n.key === key) || notified.length >= 200) continue;
        const text = reminderText(event, now, grant.timezone);
        const seq = this.#enqueueProactive(grant, now, '일정 시각에 맞춘 자동 알림', { text, sources: [], verification: 'not_applicable', calendar_reminder: true, observed_at: observation.observed_at });
        if (seq) { notified.push({ key, turn: seq, until: now + 8 * 86400000, active: true }); changes++; }
      }
      const day = localDay(now, grant.timezone), hour = localHour(now, grant.timezone);
      const fingerprint = hash(JSON.stringify([observation.fingerprint, ticket.local_fingerprint, day]));
      let runs = state.model_day === day ? state.model_runs : 0, next = state.model_next_at, acceptedFingerprint = state.fingerprint;
      if (!observation.error && !this.#db.prepare("SELECT seq FROM turns WHERE state IN('queued','running')").get()
          && ticket.local_fingerprint === this.#proactiveFingerprint()
          && (ticket.google_epoch || ticket.has_context) && hour >= 9 && hour < 21 && now >= next && runs < 4 && this.requestRoom('continuous', now) > 4 && fingerprint !== state.fingerprint) {
        const seq = this.#enqueueProactive(grant, now, '자동 확인: 새로운 메일·일정 변화와 미완료 업무를 확인하고 필요한 제안만 알려 주세요.');
        if (seq) { runs++; changes++; next = now + 3600000; acceptedFingerprint = fingerprint; }
      }
      this.#saveSetting('attention', { ...state, observed_at: observation.observed_at, error: observation.error ?? null, fingerprint: acceptedFingerprint,
        model_day: day, model_runs: runs, model_next_at: next, notified });
      const due = observation.events.filter(e => e.start !== null && e.start - 1800000 > now).map(e => e.start - 1800000);
      this.#saveSetting('proactive', { ...grant, next_at: Math.min(now + ATTENTION_INTERVAL, ...due) });
      return changes;
    });
  }
  async upgradeAssistance() {
    this.#check(); if (this.#version >= 5) return null;
    if (this.#version !== 4) throw Error('CONTACT_REVIEW_UPGRADE_REQUIRED');
    if (this.#db.prepare("SELECT seq FROM turns WHERE state='running'").get()
        || this.#db.prepare("SELECT id FROM telegram_outbox WHERE state='sending'").get()) throw Error('CONTACT_UPGRADE_BUSY');
    const path = join(this.#root, `before-assistance-${randomUUID()}.sqlite`);
    this.#upgrading = true;
    try {
      closeSync(openSync(path, 'wx', 0o600)); await backup(this.#db, path);
      const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== 'win32') { const dir = openSync(this.#root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.#upgrading = false;
      this.#tx(() => { this.#db.exec(ASSISTANCE_SCHEMA); this.#db.prepare('UPDATE identity SET schema_hash=? WHERE singleton=1').run(hash(SCHEMA_V5)); });
      this.#version = 5; return path;
    } finally { this.#upgrading = false; }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db?.close(); } finally { this.#owner?.close(); this.#key?.fill(0); }
  }
}
export const contactRoute = value => hash(JSON.stringify(value));
