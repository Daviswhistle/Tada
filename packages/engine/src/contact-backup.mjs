// An encrypted, data-only archive. It carries records, never reusable authority.
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { windowsProtector } from './contact-key.mjs';
import { parseUniqueJson, parseUniqueArchiveJson } from './json.mjs';

export const BACKUP_CONSENT = 'encrypted_record_backup_v1';
export const MAX_BACKUP_BYTES = 33554432;
const MAGIC = Buffer.from('TADA-BACKUP-1\n');
const KEY_AAD = Buffer.from('tada.backup.recovery-key.v1');
const shape = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const fail = () => { throw Error('CONTACT_BACKUP_INVALID'); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit) => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= limit;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
// No credentials, provider checkpoints, device authentication hashes, Telegram
// bindings or executable settings are among these allowed tables/columns.
export const BACKUP_COLUMNS = Object.freeze({
  devices: 'id,name,expires,revoked',
  turns: 'seq,request_id,device,state,payload,answer,error,created',
  requests: 'seq,turn,state,input_tokens,output_tokens',
  followups: 'id,version,origin_turn,device,state,payload,notify_at,created,updated',
  followup_proposals: 'id,turn,device,operation_id,state,payload,created',
  followup_notices: 'id,commitment,version,payload,state,telegram_id,created',
  followup_reviews: 'id,commitment,version,device,payload,due,state,turn,error,created',
  telegram_outbox: 'id,device,turn,part,payload,state,receipt,not_before,error,created',
  proactive_runs: 'turn,epoch,fingerprint,created,payload',
  mail_actions: 'id,turn,state,payload',
  browser_actions: 'name,payload',
});
export function backupRecordGroups(value) {
  return [...(value.recovered ?? []), value.version === 2 ? { ...value, recovered: [] } : value];
}
export function validateBackupSnapshot(value) {
  if (!shape(value, value?.version === 2 ? 'version,created_at,source,connection,records,recovered' : 'version,created_at,source,connection,records') || ![1,2].includes(value.version) || !integer(value.created_at)
      || !shape(value.source, 'journal_id,schema_version,route') || !uuid(value.source.journal_id)
      || !(value.version === 2 ? [7] : [1,2,3,4,5,6]).includes(value.source.schema_version) || !hex(value.source.route)
      || !shape(value.connection, 'provider,google_client') || !shape(value.records, Object.keys(BACKUP_COLUMNS).join(','))) fail();
  if (value.version === 2) {
    if (!Array.isArray(value.recovered)) fail();
    for (const prior of value.recovered) {
      if (!(prior?.version === 1 || prior?.version === 2 && Array.isArray(prior.recovered) && prior.recovered.length === 0)) fail();
      validateBackupSnapshot(prior);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BACKUP_BYTES || Buffer.byteLength(JSON.stringify(backupRecordGroups(value))) > MAX_BACKUP_BYTES) throw Error('CONTACT_BACKUP_TOO_LARGE');
  const provider = value.connection.provider, client = value.connection.google_client;
  if (provider !== null && (!shape(provider, 'kind,subject,label,model') || !['chatgpt-subscription', 'ollama-local'].includes(provider.kind)
      || !(provider.subject === null || text(provider.subject, 512)) || !(provider.label === null || text(provider.label, 320)) || !text(provider.model, 256))) fail();
  if (client !== null && (!shape(client, 'client_id,client_secret') || !text(client.client_id, 200)
      || !/^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/u.test(client.client_id) || !text(client.client_secret, 4096))) fail();
  let count = (value.recovered ?? []).reduce((total, prior) => total + Object.values(prior.records).reduce((sum, rows) => sum + rows.length, 0), 0);
  if (count > 200000) throw Error('CONTACT_BACKUP_TOO_LARGE');
  for (const [name, fields] of Object.entries(BACKUP_COLUMNS)) {
    const rows = value.records[name];
    if (!Array.isArray(rows) || rows.length > 100000) fail();
    for (const row of rows) { if (!shape(row, fields)) fail(); if (++count > 200000) throw Error('CONTACT_BACKUP_TOO_LARGE'); }
  }
  // These are archive records, not replay commands. Full domain/lineage checks
  // must also precede any future import into a live store.
  const devices = new Set(), turns = new Set(), requests = new Set();
  for (const d of value.records.devices) {
    if (!uuid(d.id) || devices.has(d.id) || !text(d.name, 1024) || !integer(d.expires) || ![0,1].includes(d.revoked)) fail(); devices.add(d.id);
  }
  for (const t of value.records.turns) {
    if (!integer(t.seq) || t.seq < 1 || turns.has(t.seq) || !text(t.request_id, 200) || !devices.has(t.device)
        || !['queued','running','answered','failed','cancelled','interrupted'].includes(t.state) || !integer(t.created)
        || !shape(t.payload, 'text') || !text(t.payload.text, 65536) || !(t.answer === null || typeof t.answer === 'object' && !Array.isArray(t.answer))
        || !(t.error === null || text(t.error, 256))) fail(); turns.add(t.seq);
  }
  for (const r of value.records.requests) {
    if (!integer(r.seq) || r.seq < 1 || requests.has(r.seq) || !turns.has(r.turn) || !['reserved','observed','unknown'].includes(r.state)
        || !integer(r.input_tokens) || !integer(r.output_tokens)) fail(); requests.add(r.seq);
  }
  for (const name of ['followup_proposals','followup_reviews','telegram_outbox','mail_actions','proactive_runs']) {
    for (const row of value.records[name]) if (row.turn !== null && !turns.has(row.turn)) fail();
  }
  for (const row of value.records.browser_actions) if (!/^browser_action:(?:DISPATCHING|VERIFIED|UNCERTAIN|ACKNOWLEDGED|FAILED):browser-[a-f0-9-]{36}$/u.test(row.name)) fail();
  return value;
}
function decode(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url'); if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== value) fail(); return bytes;
}
function encrypt(key, plain, aad) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
  return { nonce, data: Buffer.concat([cipher.update(plain), cipher.final()]), tag: cipher.getAuthTag() };
}
function decrypt(key, nonce, data, tag, aad) {
  const cipher = createDecipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function recoveryKey(code, salt) {
  if (typeof code !== 'string' || !/^TADA1-[A-Za-z0-9_-]{32}$/u.test(code)) throw Error('CONTACT_BACKUP_RECOVERY_CODE_REQUIRED');
  return Buffer.from(hkdfSync('sha256', Buffer.from(code.slice(6), 'base64url'), salt, KEY_AAD, 32));
}
export async function createRecordBackup(snapshot, { portable = false, protector = windowsProtector() } = {}) {
  if (typeof portable !== 'boolean' || protector.kind !== 'windows-dpapi-v1') fail();
  validateBackupSnapshot(snapshot);
  let key, plain, recovery, recoveryCode = null;
  try {
    plain = Buffer.from(JSON.stringify(snapshot)); if (plain.length > MAX_BACKUP_BYTES) throw Error('CONTACT_BACKUP_TOO_LARGE');
    key = randomBytes(32); const wrapped = await protector.protect(key);
    if (!(wrapped instanceof Uint8Array) || wrapped.length < 1 || wrapped.length > 8192) fail();
    if (portable) {
      recoveryCode = 'TADA1-' + randomBytes(24).toString('base64url'); const salt = randomBytes(16); const derived = recoveryKey(recoveryCode, salt);
      try {
        const encrypted = encrypt(derived, key, KEY_AAD);
        recovery = { salt: salt.toString('base64url'), nonce: encrypted.nonce.toString('base64url'), data: encrypted.data.toString('base64url'), tag: encrypted.tag.toString('base64url') };
      } finally { derived.fill(0); }
    }
    const header = Buffer.from(JSON.stringify({ version: 1, windows_key: Buffer.from(wrapped).toString('base64url'), recovery: recovery ?? null, bytes: plain.length }));
    if (header.length > 16384) fail();
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, size, header]), encrypted = encrypt(key, plain, aad);
    return { bytes: Buffer.concat([aad, encrypted.nonce, encrypted.data, encrypted.tag]), recoveryCode, created_at: snapshot.created_at };
  } finally { key?.fill(0); plain?.fill(0); }
}
export async function openRecordBackup(bytes, { recoveryCode = null, protector } = {}) {
  let key, plain;
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BACKUP_BYTES + MAGIC.length + 4 + 16384 + 28 || bytes.length < MAGIC.length + 4 + 28) fail();
    bytes = Buffer.from(bytes);
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) fail();
    const headerLength = bytes.readUInt32BE(MAGIC.length), offset = MAGIC.length + 4 + headerLength;
    if (headerLength < 1 || headerLength > 16384 || offset + 28 > bytes.length) fail();
    const header = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(MAGIC.length + 4, offset)), 16384);
    if (!shape(header, 'version,windows_key,recovery,bytes') || header.version !== 1 || !integer(header.bytes) || header.bytes > MAX_BACKUP_BYTES
        || header.bytes !== bytes.length - offset - 28) fail();
    const wrapped = decode(header.windows_key, 1, 8192), r = header.recovery;
    if (r !== null && !shape(r, 'salt,nonce,data,tag')) fail();
    // Validate even an unused wrapper; malformed future variants fail closed.
    const portable = r === null ? null : { salt: decode(r.salt, 16), nonce: decode(r.nonce, 12), data: decode(r.data, 32), tag: decode(r.tag, 16) };
    if (recoveryCode !== null) {
      if (!portable) throw Error('CONTACT_BACKUP_NOT_PORTABLE');
      const derived = recoveryKey(recoveryCode, portable.salt);
      try { key = decrypt(derived, portable.nonce, portable.data, portable.tag, KEY_AAD); } finally { derived.fill(0); }
    } else {
      protector ??= windowsProtector(); if (protector.kind !== 'windows-dpapi-v1') fail();
      key = await protector.unprotect(wrapped);
    }
    if (!Buffer.isBuffer(key) || key.length !== 32) fail();
    plain = decrypt(key, bytes.subarray(offset, offset + 12), bytes.subarray(offset + 12, -16), bytes.subarray(-16), bytes.subarray(0, offset));
    return validateBackupSnapshot(parseUniqueArchiveJson(new TextDecoder('utf-8', { fatal: true }).decode(plain), MAX_BACKUP_BYTES));
  } catch (error) {
    if (['CONTACT_BACKUP_INVALID','CONTACT_BACKUP_RECOVERY_CODE_REQUIRED','CONTACT_BACKUP_NOT_PORTABLE','CONTACT_OS_PROTECTION_UNAVAILABLE'].includes(error?.message)) throw error;
    throw Error('CONTACT_BACKUP_CANNOT_OPEN');
  } finally { key?.fill(0); plain?.fill(0); }
}
export function backupSummary(snapshot) {
  validateBackupSnapshot(snapshot);
  const groups = [snapshot, ...(snapshot.recovered ?? [])];
  return { created_at: snapshot.created_at, account: snapshot.connection.provider?.label ?? null, model: snapshot.connection.provider?.model ?? null,
    turns: groups.reduce((n,g) => n + g.records.turns.length, 0), documents: groups.reduce((n,g) => n + g.records.turns.filter(t => t.answer?.document).length, 0),
    work: groups.reduce((n,g) => n + g.records.followups.length, 0), mail: groups.reduce((n,g) => n + g.records.mail_actions.length, 0),
    carries_authority: false, restore_status: 'records_only_requires_reconnection_and_quarantine' };
}
