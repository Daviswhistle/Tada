import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, lstatSync, chmodSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { contactStorageKey } from '../src/contact-key.mjs';
import { GoogleConnection } from '../src/google-connection.mjs';
import { GOOGLE_SCOPES } from '../src/google-contract.mjs';
import { GOOGLE_CLIENT_CONFIG_FILE, saveGoogleClientConfig, loadGoogleClientConfig } from '../src/google-client-config.mjs';
import { setupError } from '../src/app-setup.mjs';
import { startApp } from '../src/start-app.mjs';
import { main } from '../src/contact-cli.mjs';
import { ChatGPTStore } from '../../providers/src/chatgpt-store.mjs';

const passphrase = 'synthetic-google-client-config-storage-key';
const client = { client_id: '123456789012-fixture.apps.googleusercontent.com', client_secret: 'SYNTHETIC_GOOGLE_CLIENT_SECRET_ONLY' };
const selected = { clientId: client.client_id, clientSecret: client.client_secret };
function fixture(route = contactRoute({ fixture: 'google-client-config' }), key = passphrase) {
  const root = mkdtempSync(join(tmpdir(), 'tada-google-client-config-')), data = join(root, 'journal');
  let store = new ContactStore({ directory: data, passphrase: key, route, initialize: true, assistance: true });
  const options = { data, passphrase: key, route, client }, path = join(data, GOOGLE_CLIENT_CONFIG_FILE);
  return { root, data, get store() { return store; }, options, path,
    save(input = options) {
      store.close();
      try { return saveGoogleClientConfig(input); }
      finally { store = new ContactStore({ directory: data, passphrase: key, route }); }
    },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('dedicated client settings reopen encrypted without changing journal settings or exposing secrets', () => {
  const f = fixture();
  try {
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {} }), { clientId: '', clientSecret: '' });
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(f.save(), { saved: true });
    const bytes = readFileSync(f.path);
    for (const value of [client.client_id, client.client_secret, passphrase]) assert.equal(bytes.includes(Buffer.from(value)), false);
    if (process.platform !== 'win32') assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), ['payload', 'salt', 'version']);
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {} }), selected);
    assert.equal(f.store.googleCredential(), null); assert.equal(f.store.contactVersion, 5);
    const id = f.store.id; f.store.close();
    const reopened = new ContactStore({ directory: f.data, passphrase, route: contactRoute({ fixture: 'google-client-config' }) });
    try {
      assert.equal(reopened.id, id); assert.equal(reopened.googleCredential(), null);
      assert.deepEqual(loadGoogleClientConfig({ data: f.data, passphrase, env: {} }), selected);
      const google = new GoogleConnection({ store: reopened, ...loadGoogleClientConfig({ data: f.data, passphrase, env: {} }) });
      assert.equal(google.status().configured, true); assert.equal(google.status().connected, false); google.close();
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('existing managed storage key also opens the sidecar without a second password or a replacement key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-google-client-key-')), data = join(root, 'journal'), osKey = randomBytes(32);
  let store, protects = 0;
  const protector = { kind: 'synthetic-test-protector', async protect(bytes) {
    protects++; const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', osKey, nonce);
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }, async unprotect(bytes) {
    const decipher = createDecipheriv('aes-256-gcm', osKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  } };
  try {
    const key = await contactStorageKey({ data, initialize: true, protector });
    store = new ContactStore({ directory: data, passphrase: key, route: contactRoute({ fixture: 'managed-client-key' }), initialize: true, assistance: true });
    store.close(); saveGoogleClientConfig({ data, passphrase: key, client, route: contactRoute({ fixture: 'managed-client-key' }) });
    const restored = await contactStorageKey({ data, protector });
    assert.equal(restored, key); assert.equal(protects, 1);
    assert.deepEqual(loadGoogleClientConfig({ data, passphrase: restored, env: {} }), selected);
  } finally { store?.close(); osKey.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test('exclusive provisioning owns the correct journal and key, refuses active grants and never overwrites existing settings', () => {
  const f = fixture();
  try {
    assert.throws(() => saveGoogleClientConfig(f.options), /OWNER_REQUIRED/u);
    assert.throws(() => f.save({ ...f.options, route: contactRoute({ fixture: 'different route' }) }), /OWNER_REQUIRED/u);
    assert.throws(() => f.save({ ...f.options, passphrase: 'different-synthetic-storage-key' }), /OWNER_REQUIRED/u);
    assert.equal(existsSync(f.path), false);
    const device = f.store.addDevice('Synthetic owner');
    f.store.saveGoogleCredential(device.id, { version: 1, epoch: randomUUID(), device: device.id, scopes: [...GOOGLE_SCOPES],
      refresh_token: 'SYNTHETIC_GOOGLE_REFRESH_TOKEN_ONLY', email: 'fixture@example.test', connected_at: Date.now(),
      last_checked: null, last_error: null, reconnect_required: false }, null);
    const before = f.store.googleCredential();
    assert.throws(() => f.save(), /GRANT_PRESENT/u); assert.equal(existsSync(f.path), false);
    assert.deepEqual(f.store.googleCredential(), before);
    f.store.clearGoogleCredential(device.id); f.save();
    const sealed = readFileSync(f.path);
    assert.throws(() => f.save({ ...f.options, client: { ...client, client_secret: 'DIFFERENT_SYNTHETIC_SECRET' } }), /CONFIG_EXISTS/u);
    assert.deepEqual(readFileSync(f.path), sealed);
  } finally { f.close(); }
});

test('provisioning refuses legacy journals without migration or changing their version', () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-google-client-legacy-')), data = join(root, 'journal'), route = contactRoute({ fixture: 'legacy-client-config' });
  let store = new ContactStore({ directory: data, passphrase, route, initialize: true });
  try {
    const id = store.id; store.close();
    assert.throws(() => saveGoogleClientConfig({ data, passphrase, route, client }), /UPGRADE_REQUIRED/u);
    assert.equal(existsSync(join(data, GOOGLE_CLIENT_CONFIG_FILE)), false);
    store = new ContactStore({ directory: data, passphrase, route }); assert.equal(store.contactVersion, 2); assert.equal(store.id, id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const key of ['', ' '.repeat(16), 'short', 'x'.repeat(1025)]) test(`invalid storage key length ${key.length} cannot create a sidecar`, () => {
  const f = fixture();
  try { assert.throws(() => f.save({ ...f.options, passphrase: key }), /KEY_REQUIRED/u); assert.equal(existsSync(f.path), false); }
  finally { f.close(); }
});

for (const invalid of [null, { ...client, extra: true }, { client_id: client.client_id }, { ...client, client_id: 'attacker.invalid' }, { ...client, client_secret: '\n' }, { ...client, client_secret: 'x'.repeat(4097) }]) test('malformed client settings are rejected before any file is created', () => {
  const f = fixture();
  try { assert.throws(() => f.save({ ...f.options, client: invalid }), /CONFIG_INVALID/u); assert.equal(existsSync(f.path), false); }
  finally { f.close(); }
});

for (const change of ['wrong key', 'ciphertext', 'salt', 'version', 'unknown field', 'duplicate field', 'oversized']) test(`existing ${change} configuration fails closed without changing the file or grant`, () => {
  const f = fixture();
  try {
    f.save();
    const record = JSON.parse(readFileSync(f.path)), options = { ...f.options, env: {} };
    if (change === 'wrong key') options.passphrase = 'different-synthetic-storage-key';
    if (change === 'ciphertext' || change === 'salt') {
      const field = change === 'ciphertext' ? 'payload' : 'salt', bytes = Buffer.from(record[field], 'base64url'); bytes[0] ^= 1;
      record[field] = bytes.toString('base64url');
    }
    if (change === 'version') record.version = 2;
    if (change === 'unknown field') record.extra = true;
    const text = change === 'duplicate field' ? JSON.stringify(record).replace('"version":1', '"version":1,"version":1')
      : change === 'oversized' ? 'x'.repeat(16385) : JSON.stringify(record);
    writeFileSync(f.path, text); const before = readFileSync(f.path);
    assert.throws(() => loadGoogleClientConfig(options), /CONFIG_INVALID/u);
    assert.throws(() => loadGoogleClientConfig({ ...options, env: { TADA_GOOGLE_OAUTH_CLIENT_ID: client.client_id } }), /CONFIG_INVALID/u);
    assert.deepEqual(readFileSync(f.path), before); assert.equal(f.store.googleCredential(), null);
  } finally { f.close(); }
});

test('ENV pair takes precedence without mixing, persisting, or falling back from an invalid override', () => {
  const f = fixture(), id = '987654321098-env.apps.googleusercontent.com';
  try {
    f.save(); const sealed = readFileSync(f.path);
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: { TADA_GOOGLE_OAUTH_CLIENT_ID: id, TADA_GOOGLE_OAUTH_CLIENT_SECRET: 'ENV_SYNTHETIC_SECRET' } }), { clientId: id, clientSecret: 'ENV_SYNTHETIC_SECRET' });
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: { TADA_GOOGLE_OAUTH_CLIENT_ID: id } }), { clientId: id, clientSecret: '' });
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: { TADA_GOOGLE_OAUTH_CLIENT_ID: '' } }), { clientId: '', clientSecret: '' });
    for (const env of [{ TADA_GOOGLE_OAUTH_CLIENT_SECRET: 'ENV_SYNTHETIC_SECRET' }, { TADA_GOOGLE_OAUTH_CLIENT_ID: 'bad' }]) assert.throws(() => loadGoogleClientConfig({ ...f.options, env }), /CONFIG_INVALID/u);
    assert.deepEqual(readFileSync(f.path), sealed); assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {} }), selected);
  } finally { f.close(); }
});

for (const kind of ['file permissions', 'directory permissions', 'file symlink', 'ancestor symlink', 'hard link']) test(`${kind} are rejected without following or replacing private files`, { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    f.save(); const before = readFileSync(f.path); let data = f.data;
    if (kind === 'file permissions') chmodSync(f.path, 0o644);
    if (kind === 'directory permissions') chmodSync(f.data, 0o755);
    if (kind === 'file symlink') { const target = join(f.root, 'target'); writeFileSync(target, before, { mode: 0o600 }); unlinkSync(f.path); symlinkSync(target, f.path); }
    if (kind === 'ancestor symlink') { data = join(f.root, 'alias'); symlinkSync(f.data, data); }
    if (kind === 'hard link') linkSync(f.path, join(f.root, 'linked'));
    assert.throws(() => loadGoogleClientConfig({ ...f.options, data, env: {} }), /PRIVATE_PATH_REQUIRED|OWNER_REQUIRED/u);
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.close(); }
});

test('configuration startup errors have human recovery guidance without raw codes', () => {
  for (const kind of ['INVALID', 'KEY_REQUIRED', 'PRIVATE_PATH_REQUIRED', 'EXISTS', 'SAVE_FAILED', 'OWNER_REQUIRED', 'GRANT_PRESENT', 'UPGRADE_REQUIRED']) {
    const code = `CONTACT_GOOGLE_CLIENT_CONFIG_${kind}`, text = setupError(Error(code));
    assert.match(text, /Google/u); assert.match(text, /복원|확인|설정|기존|키/u); assert.equal(text.includes(code), false);
  }
});

for (const configured of [false, true]) test(`normal app startup and restart ${configured ? 'restore encrypted Google app setup' : 'keep conversation available without optional Google setup'}`, async () => {
  const route = contactRoute({ version: 1, provider: 'chatgpt-subscription', model: 'fixture-model',
    digest: createHash('sha256').update('fixture-client:fixture-subject:fixture-model').digest('hex'), endpoint: 'https://api.openai.com/v1', scopes: [] });
  const f = fixture(route), profile = join(f.root, 'profile'); let app;
  const account = new ChatGPTStore({ directory: profile, passphrase });
  account.save({ ...account.read(), client: 'fixture-client', subject: 'fixture-subject', email: 'fixture@example.invalid', model: 'fixture-model',
    tokens: { access_token: 'SYNTHETIC_SUBSCRIPTION_ACCESS_ONLY', refresh_token: 'SYNTHETIC_SUBSCRIPTION_REFRESH_ONLY', expires_at: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] } });
  account.close();
  if (configured) f.save();
  const sealed = configured ? readFileSync(f.path) : null; f.store.close();
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const nativeFetch = globalThis.fetch, keys = ['TADA_GOOGLE_OAUTH_CLIENT_ID', 'TADA_GOOGLE_OAUTH_CLIENT_SECRET'], oldEnv = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, options);
    assert.equal(String(url), 'https://api.openai.com/v1/models'); assert.equal(options.method, undefined);
    return new Response(JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list' }] }));
  };
  try {
    for (let start = 0; start < 3; start++) {
      if (start > 0) {
        process.env.TADA_GOOGLE_OAUTH_CLIENT_ID = configured ? (start === 1 ? '' : client.client_id) : client.client_id;
        process.env.TADA_GOOGLE_OAUTH_CLIENT_SECRET = configured ? (start === 1 ? '' : client.client_secret) : client.client_secret;
      }
      app = await startApp(['--data', f.data, '--chatgpt-profile', profile, '--port', String(port)], {
        open: async () => {}, instance: async () => ({ existing: false, publish: async () => {}, close() {} }),
        run: (args, { ui }) => main(args, { ui, keyProvider: async () => passphrase, background: {
          status: async () => ({ available: true }),
          configure: async (_enabled, _consent, authorize, prepare) => { authorize(); prepare(); return { enabled: true, transfer: false }; },
        } }),
      });
      const setup = new URL(app.url), headers = { Authorization: 'Bearer ' + new URLSearchParams(setup.hash.slice(1)).get('setup') };
      let state;
      for (let attempt = 0; attempt < 400; attempt++) {
        state = await nativeFetch(setup.origin + '/state', { headers }).then(res => res.json());
        if (['ready', 'error'].includes(state.stage)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(state.stage, 'ready', JSON.stringify(state));
      const entry = new URL(state.url), paired = await nativeFetch(entry.origin + '/api/pair', {
        method: 'POST', headers: { Origin: entry.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: new URLSearchParams(entry.hash.slice(1)).get('pair'), name: 'Synthetic browser' }),
      });
      assert.equal(paired.status, 200);
      const page = await nativeFetch(entry.origin + '/api/state', { headers: { Cookie: paired.headers.get('set-cookie').split(';')[0] } }).then(res => res.json());
      assert.equal(page.google.configured, start === 0 ? configured : configured ? start !== 1 : true); assert.equal(page.google.connected, false); assert.equal(page.google.has_credential, false);
      assert.equal(page.provider.provider, 'chatgpt-subscription'); assert.equal(page.usage.requests, 0);
      for (const value of [client.client_id, client.client_secret, passphrase]) assert.equal(JSON.stringify(page).includes(value), false);
      const enabled = await nativeFetch(entry.origin + '/api/background', { method: 'POST',
        headers: { Origin: entry.origin, 'Content-Type': 'application/json', Cookie: paired.headers.get('set-cookie').split(';')[0] },
        body: JSON.stringify({ enabled: true, consent: 'same_assistant_background_v1' }) });
      const outcome = await enabled.json();
      if (start === 0 || configured && start === 2) assert.equal(outcome.enabled, true);
      else assert.equal(outcome.error, 'CONTACT_BACKGROUND_GOOGLE_SETTINGS_REQUIRED');
      await app.close(); app = null;
    }
    if (configured) assert.deepEqual(readFileSync(f.path), sealed); else assert.equal(existsSync(f.path), false);
  } finally {
    await app?.close(); globalThis.fetch = nativeFetch;
    for (const [index, key] of keys.entries()) { if (oldEnv[index] === undefined) delete process.env[key]; else process.env[key] = oldEnv[index]; }
    f.close();
  }
});

for (const failure of ['write', 'sync']) test(`failed ${failure} does not block conversation startup or configuration retry`, () => {
  const f = fixture(), originalWrite = fs.writeFileSync, originalSync = fs.fsyncSync;
  try {
    if (failure === 'write') fs.writeFileSync = (fd, bytes) => {
      originalWrite(fd, bytes.slice(0, 20));
      throw Object.assign(Error('synthetic disk full'), { code: 'ENOSPC' });
    };
    else fs.fsyncSync = () => { throw Object.assign(Error('synthetic sync failure'), { code: 'EIO' }); };
    syncBuiltinESMExports();
    assert.throws(() => f.save(), /CONFIG_SAVE_FAILED/u);
    fs.writeFileSync = originalWrite; fs.fsyncSync = originalSync; syncBuiltinESMExports();
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {} }), { clientId: '', clientSecret: '' });
    assert.equal(f.store.contactVersion, 5);
    assert.equal(fs.readdirSync(f.data).some(name => name.endsWith('.tmp')), false);
    f.save();
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {} }), selected);
  } finally {
    fs.writeFileSync = originalWrite; fs.fsyncSync = originalSync; syncBuiltinESMExports();
    f.close();
  }
});

test('startup recovers a real process exit after publish using authenticated data and the matching journal owner', () => {
  const f = fixture(), other = fixture(contactRoute({ fixture: 'other-config-journal' }));
  let store;
  try {
    f.store.close();
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { saveGoogleClientConfig } from ${JSON.stringify(new URL('../src/google-client-config.mjs', import.meta.url).href)};
      const publish = fs.linkSync;
      fs.linkSync = (...args) => { publish(...args); process.exit(77); };
      syncBuiltinESMExports();
      saveGoogleClientConfig(${JSON.stringify(f.options)});
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 77, child.stderr);
    assert.equal(lstatSync(f.path).nlink, 2);
    assert.throws(() => loadGoogleClientConfig({ ...f.options, env: {} }), /OWNER_REQUIRED/u);
    assert.throws(() => loadGoogleClientConfig({ ...f.options, env: {}, store: other.store }), /OWNER_REQUIRED/u);
    store = new ContactStore({ directory: f.data, passphrase, route: f.options.route });
    assert.throws(() => loadGoogleClientConfig({ ...f.options, passphrase: 'wrong-synthetic-storage-key', env: {}, store }), /CONFIG_INVALID/u);
    assert.equal(lstatSync(f.path).nlink, 2);
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {}, store }), selected);
    assert.equal(lstatSync(f.path).nlink, 1);
    assert.equal(fs.readdirSync(f.data).some(name => name.endsWith('.tmp')), false);
    assert.deepEqual(loadGoogleClientConfig({ ...f.options, env: {}, store }), selected);
    assert.equal(store.googleCredential(), null);
  } finally { store?.close(); other.close(); f.close(); }
});
