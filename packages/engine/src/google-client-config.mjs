// Tada's dedicated OAuth application settings, separate from user Google grants.
// Reuse the contact storage key; never import another application's credentials.
import { constants, lstatSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { parseUniqueJson } from './json.mjs';
import { ContactStore } from './contact-store.mjs';

export const GOOGLE_CLIENT_CONFIG_FILE = 'google-oauth-client.enc';
const MAX_FILE_BYTES = 16384, MAX_PLAIN_BYTES = 9000;
const AAD = Buffer.from('tada.google-oauth-client.v1');
const fail = code => { throw Error(`CONTACT_GOOGLE_CLIENT_CONFIG_${code}`); };

function validClient(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'client_id,client_secret'
    && typeof value.client_id === 'string' && value.client_id.length <= 200
    && /^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/u.test(value.client_id)
    && typeof value.client_secret === 'string' && /^[\x21-\x7e]{0,4096}$/u.test(value.client_secret);
}
function owned(stat, directory = false, links = 1) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== links)
      || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) fail('PRIVATE_PATH_REQUIRED');
}
function paths(data) {
  if (typeof data !== 'string' || !data) fail('PRIVATE_PATH_REQUIRED');
  const root = resolve(data);
  for (let at = root; dirname(at) !== at; at = dirname(at)) {
    try { if (lstatSync(at).isSymbolicLink()) fail('PRIVATE_PATH_REQUIRED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { owned(lstatSync(root), true); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return { root, path: join(root, GOOGLE_CLIENT_CONFIG_FILE) };
}
function assertKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16 || passphrase.length > 1024 || !passphrase.trim()) fail('KEY_REQUIRED');
}
function keyFor(passphrase, salt) {
  assertKey(passphrase);
  return scryptSync(passphrase, Buffer.concat([AAD, salt]), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function decoded(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3)
      || !/^[A-Za-z0-9_-]+$/u.test(value)) fail('INVALID');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== value) fail('INVALID');
  return bytes;
}
function readSaved(data, passphrase, store) {
  let fd, key, plain;
  try {
    const location = paths(data);
    if (!location) return null;
    let initial;
    try { initial = lstatSync(location.path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let staging;
    if (initial.nlink === 2) {
      // A crash between publish and staging unlink leaves exactly these two
      // names. Recover only under the matching journal's process ownership.
      if (!(store instanceof ContactStore)) fail('OWNER_REQUIRED');
      try { store.assertStorageDirectory(location.root); } catch { fail('OWNER_REQUIRED'); }
      owned(initial, false, 2);
      const candidates = readdirSync(location.root).filter(name => /^\.google-oauth-client-[0-9a-f-]{36}\.tmp$/u.test(name));
      for (const name of candidates) {
        const candidate = join(location.root, name), stat = lstatSync(candidate);
        if (stat.dev === initial.dev && stat.ino === initial.ino) {
          owned(stat, false, 2);
          if (staging) fail('PRIVATE_PATH_REQUIRED');
          staging = candidate;
        }
      }
      if (!staging) fail('PRIVATE_PATH_REQUIRED');
    } else owned(initial);
    fd = openSync(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd); owned(stat, false, staging ? 2 : 1);
    if (stat.dev !== initial.dev || stat.ino !== initial.ino) fail('PRIVATE_PATH_REQUIRED');
    if (stat.size > MAX_FILE_BYTES) fail('INVALID');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size > MAX_FILE_BYTES) fail('INVALID');
    const record = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)), MAX_FILE_BYTES);
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.keys(record).sort().join(',') !== 'payload,salt,version' || record.version !== 1) fail('INVALID');
    const salt = decoded(record.salt, 32, 32), payload = decoded(record.payload, 29, MAX_PLAIN_BYTES + 28);
    key = keyFor(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAAD(AAD); decipher.setAuthTag(payload.subarray(-16));
    plain = Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]);
    const client = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(plain), MAX_PLAIN_BYTES);
    if (!validClient(client)) fail('INVALID');
    if (staging) {
      store.assertStorageDirectory(location.root);
      for (const path of [staging, location.path]) {
        const current = lstatSync(path); owned(current, false, 2);
        if (current.dev !== stat.dev || current.ino !== stat.ino) fail('PRIVATE_PATH_REQUIRED');
      }
      unlinkSync(staging);
      owned(fstatSync(fd));
    }
    return client;
  } catch (error) {
    if (/^CONTACT_GOOGLE_CLIENT_CONFIG_[A-Z_]+$/u.test(error?.message)) throw error;
    fail(['EACCES', 'EPERM', 'ELOOP'].includes(error?.code) ? 'PRIVATE_PATH_REQUIRED' : 'INVALID');
  } finally { key?.fill(0); plain?.fill(0); if (fd !== undefined) closeSync(fd); }
}

// Explicit host provisioning only, while the contact runtime is stopped. Open
// the matching existing journal to verify its key and hold its single owner.
// No active Google grant may be rebound or saved client replaced.
export function saveGoogleClientConfig({ data, passphrase, client, route }) {
  let fd, key, plain, store, temporary;
  try {
    if (!validClient(client)) fail('INVALID');
    assertKey(passphrase);
    const location = paths(data);
    if (!location) fail('PRIVATE_PATH_REQUIRED');
    try { store = new ContactStore({ directory: location.root, passphrase, route }); }
    catch { fail('OWNER_REQUIRED'); }
    if (![5, 6].includes(store.contactVersion)) fail('UPGRADE_REQUIRED');
    if (store.googleCredential() !== null) fail('GRANT_PRESENT');
    const salt = randomBytes(32), nonce = randomBytes(12);
    key = keyFor(passphrase, salt); plain = Buffer.from(JSON.stringify(client));
    if (plain.length > MAX_PLAIN_BYTES) fail('INVALID');
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(AAD);
    const payload = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const sealed = JSON.stringify({ version: 1, salt: salt.toString('base64url'), payload: payload.toString('base64url') });
    if (Buffer.byteLength(sealed) > MAX_FILE_BYTES) fail('INVALID');
    const staging = join(location.root, `.google-oauth-client-${randomUUID()}.tmp`);
    fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    temporary = staging;
    owned(fstatSync(fd)); writeFileSync(fd, sealed); fsyncSync(fd); closeSync(fd); fd = undefined;
    // Publish only a fully synced ciphertext. link is atomic and fails if the
    // destination exists; rename would silently replace another configuration.
    linkSync(temporary, location.path);
    unlinkSync(temporary); temporary = undefined;
    if (process.platform !== 'win32') { fd = openSync(location.root, constants.O_RDONLY); fsyncSync(fd); }
    return { saved: true };
  } catch (error) {
    if (/^CONTACT_GOOGLE_CLIENT_CONFIG_[A-Z_]+$/u.test(error?.message)) throw error;
    fail(error?.code === 'EEXIST' ? 'EXISTS' : ['EACCES', 'EPERM', 'ELOOP'].includes(error?.code) ? 'PRIVATE_PATH_REQUIRED' : 'SAVE_FAILED');
  } finally {
    key?.fill(0); plain?.fill(0);
    try { if (fd !== undefined) closeSync(fd); }
    finally {
      try { if (temporary) unlinkSync(temporary); }
      finally { store?.close(); }
    }
  }
}

export function loadGoogleClientConfig({ data, passphrase, env = process.env, store }) {
  // Authenticate an existing sidecar even with an ENV override. Corruption is
  // never silently treated as missing configuration or overwritten.
  const saved = readSaved(data, passphrase, store);
  const hasId = Object.hasOwn(env, 'TADA_GOOGLE_OAUTH_CLIENT_ID'), hasSecret = Object.hasOwn(env, 'TADA_GOOGLE_OAUTH_CLIENT_SECRET');
  if (hasId || hasSecret) {
    if (!hasId) fail('INVALID');
    const client = { client_id: env.TADA_GOOGLE_OAUTH_CLIENT_ID, client_secret: hasSecret ? env.TADA_GOOGLE_OAUTH_CLIENT_SECRET : '' };
    if (client.client_id === '' && client.client_secret === '') return { clientId: '', clientSecret: '' };
    if (!validClient(client)) fail('INVALID');
    return { clientId: client.client_id, clientSecret: client.client_secret };
  }
  return { clientId: saved?.client_id ?? '', clientSecret: saved?.client_secret ?? '' };
}
