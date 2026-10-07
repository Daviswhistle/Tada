import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { contactStorageKey } from '../src/contact-key.mjs';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ChatGPTStore } from '../../providers/src/chatgpt-store.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tada-key-test-')), data = join(root, 'contact'), profile = join(root, 'profile');
  const osKey = randomBytes(32); let protects = 0;
  const protector = { kind: 'windows-dpapi-v1', async protect(bytes) {
    protects++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', osKey, iv);
    return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }, async unprotect(bytes) {
    const cipher = createDecipheriv('aes-256-gcm', osKey, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
  } };
  return { root, data, profile, protector, get protects() { return protects; }, close() { osKey.fill(0); rmSync(root, { recursive: true, force: true }); } };
}

test('managed key persists only wrapped bytes and reopens both encrypted stores without a password', async () => {
  const env = setup(); let account, store;
  try {
    const key = await contactStorageKey({ ...env, initialize: true });
    assert.equal(env.protects, 1); assert.equal(existsSync(env.data), false);
    account = new ChatGPTStore({ directory: env.profile, passphrase: key });
    account.save({ ...account.read(), fixture: 'not a real account' }); account.close();
    const route = contactRoute({ fixture: true });
    store = new ContactStore({ directory: env.data, passphrase: key, route, initialize: true });
    const identity = store.id; store.close();
    const reopened = await contactStorageKey({ ...env, initialize: false });
    assert.equal(reopened, key); assert.equal(env.protects, 1);
    store = new ContactStore({ directory: env.data, passphrase: reopened, route }); assert.equal(store.id, identity);
    account = new ChatGPTStore({ directory: env.profile, passphrase: reopened }); assert.equal(account.read().fixture, 'not a real account');
    const bytes = readFileSync(join(env.profile, 'storage-key.sqlite'));
    assert.equal(bytes.includes(Buffer.from(key)), false); assert.equal(bytes.includes(Buffer.from(key, 'base64url')), false);
  } finally { store?.close(); account?.close(); env.close(); }
});

test('missing keys never initialize over password records or lost managed keys', async () => {
  const env = setup();
  try {
    mkdirSync(env.data); const path = join(env.data, 'contact.sqlite'); writeFileSync(path, 'existing record sentinel');
    await assert.rejects(contactStorageKey({ ...env, initialize: true }), /STORAGE_KEY_MISSING/);
    assert.equal(env.protects, 0); assert.equal(existsSync(env.profile), false); assert.equal(readFileSync(path, 'utf8'), 'existing record sentinel');
  } finally { env.close(); }
});

test('unavailable OS protection and corrupt records do not fall back or overwrite the wrapped key', async () => {
  const env = setup();
  try {
    await contactStorageKey({ ...env, initialize: true }); const path = join(env.profile, 'storage-key.sqlite');
    const readWrapped = () => { const db = new DatabaseSync(path); try { return Buffer.from(db.prepare('SELECT wrapped FROM storage_key').get().wrapped); } finally { db.close(); } };
    const before = readWrapped();
    const failed = { ...env.protector, async unprotect() { throw Error('CONTACT_OS_PROTECTION_FAILED'); } };
    await assert.rejects(contactStorageKey({ ...env, protector: failed, initialize: true }), /OS_PROTECTION_FAILED/);
    assert.deepEqual(readWrapped(), before); assert.equal(env.protects, 1);
    const db = new DatabaseSync(path); db.prepare('UPDATE storage_key SET version=99').run(); db.close();
    await assert.rejects(contactStorageKey({ ...env, initialize: true }), /STORAGE_KEY_INVALID/);
    assert.deepEqual(readWrapped(), before); assert.equal(env.protects, 1);
  } finally { env.close(); }
});

test('simultaneous first starts cannot publish different keys', async () => {
  const env = setup(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = { ...env.protector, async protect(bytes) { await gate; return env.protector.protect(bytes); } };
  let first;
  try {
    first = contactStorageKey({ ...env, protector: slow, initialize: true });
    await assert.rejects(contactStorageKey({ ...env, initialize: true }), /STORAGE_KEY_UNAVAILABLE/);
    release(); const key = await first;
    assert.equal(await contactStorageKey({ ...env }), key); assert.equal(env.protects, 1);
  } finally { release(); await first?.catch(() => {}); env.close(); }
});

test('a linked managed key file is rejected before it is opened', async () => {
  const env = setup();
  try {
    await contactStorageKey({ ...env, initialize: true });
    linkSync(join(env.profile, 'storage-key.sqlite'), join(env.root, 'linked'));
    await assert.rejects(contactStorageKey({ ...env }), /KEY_PATH_REJECTED/);
  } finally { env.close(); }
});
