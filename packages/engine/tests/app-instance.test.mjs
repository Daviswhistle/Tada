import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { acquireAppInstance } from '../src/app-instance.mjs';
import { startApp } from '../src/start-app.mjs';
import { contactOptions } from '../src/contact-cli.mjs';
function protector() {
  const key = randomBytes(32);
  return { async protect(bytes) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }, async unprotect(bytes) {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  } };
}

test('relaunch reopens the same protected window and rotates its entry without another runtime; restart releases ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-instance-')), data = join(root, 'conversation'), os = protector();
  let first, second, third, runs = 0, entries = 0;
  const opened = [], instance = options => acquireAppInstance(options, { protector: os });
  const run = async (_args, { ui }) => {
    runs++; if (runs === 1) mkdirSync(data);
    ui.ready(() => 'http://127.0.0.1:8787/#entry=' + ++entries); await ui.wait();
  };
  try {
    first = await startApp(['--data', data, '--model', 'fixture'], { run, instance, open: async url => { opened.push(url); } });
    second = await startApp(['--model', 'fixture', '--data', data], { run, instance, open: async url => { opened.push(url); } });
    assert.equal(first.url, second.url); assert.equal(runs, 1); assert.equal(entries, 2);
    assert.deepEqual(opened, [first.url, first.url]);
    const secret = new URLSearchParams(new URL(first.url).hash.slice(1)).get('setup');
    assert.equal(readFileSync(data + '.app-private/window.json', 'utf8').includes(secret), false);
    await assert.rejects(acquireAppInstance(contactOptions(['--data', data, '--port', '8799']), { protector: os }), /SETTINGS_IN_USE/);
    await second.close();
    const state = await fetch(new URL(first.url).origin + '/state', { headers: { Authorization: 'Bearer ' + secret } });
    assert.equal(state.status, 200, 'closing a relaunch does not stop the original owner');
    await first.close(); await first.close();
    third = await startApp(['--data', data, '--model', 'fixture'], { run, instance, open: async () => {} });
    assert.notEqual(first.url, third.url); assert.equal(runs, 2);
  } finally { await third?.close(); await second?.close(); await first?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('instance discovery rejects a symlinked private directory', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-path-')), data = join(root, 'conversation'), target = join(root, 'other');
  mkdirSync(target); symlinkSync(target, data + '.app-private');
  try { await assert.rejects(acquireAppInstance(contactOptions(['--data', data]), { protector: protector() }), /PRIVATE_PATH_REQUIRED/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit initialization retries the newly created journal after a contact port collision', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createHash } = await import('node:crypto');
  const { ChatGPTStore } = await import('../../providers/src/chatgpt-store.mjs');
  const { ContactStore, contactRoute } = await import('../src/contact-store.mjs');
  const { main } = await import('../src/contact-cli.mjs');
  const root = mkdtempSync(join(tmpdir(), 'tada-app-init-retry-')), data = join(root, 'conversation'), os = protector();
  const passphrase = 'synthetic setup retry fixture passphrase';
  const account = new ChatGPTStore({ directory: data + '.chatgpt-private', passphrase });
  account.save({ ...account.read(), client: 'oaiapp_fixture', subject: 'fixture-subject', email: 'fixture@example.invalid', model: 'fixture-model',
    tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_at: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] } });
  account.close();
  const blocker = createServer((_req, res) => { res.writeHead(404); res.end(); });
  blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port, nativeFetch = globalThis.fetch; let app, initialized = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, options);
    assert.equal(String(url), 'https://api.openai.com/v1/models');
    return new Response(JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const route = contactRoute({ version: 1, provider: 'chatgpt-subscription', model: 'fixture-model',
    digest: createHash('sha256').update('oaiapp_fixture:fixture-subject:fixture-model').digest('hex'), endpoint: 'https://api.openai.com/v1', scopes: [] });
  try {
    app = await startApp(['--data', data, '--init', '--port', String(port)], { open: async () => {},
      instance: options => acquireAppInstance(options, { protector: os }),
      run: (args, { ui }) => main(args, { keyProvider: async () => passphrase, ui: { ...ui, initialized() { initialized++; ui.initialized(); } } }) });
    const url = new URL(app.url), headers = { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('setup') };
    const until = async stage => {
      for (let i = 0; i < 200; i++) { const state = await nativeFetch(url.origin + '/state', { headers }).then(r => r.json()); if (state.stage === stage) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw Error('SETUP_STAGE_TIMEOUT:' + stage);
    };
    const failed = await until('error'); assert.match(failed.message, /주소가 이미 사용/u);
    const before = new ContactStore({ directory: data, passphrase, route }); const id = before.id; before.close();
    await new Promise(resolve => blocker.close(resolve));
    assert.equal((await nativeFetch(url.origin + '/action', { method: 'POST', headers: { ...headers, Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: failed.revision, action: 'retry', value: null }) })).status, 200);
    const ready = await until('ready'); assert.ok(ready.url.startsWith(`http://127.0.0.1:${port}/#pair=`));
    assert.equal(initialized, 1);
    await app.close();
    const after = new ContactStore({ directory: data, passphrase, route }); assert.equal(after.id, id); after.close();
  } finally { await app?.close(); if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); globalThis.fetch = nativeFetch; rmSync(root, { recursive: true, force: true }); }
});

test('ordinary reopen ignores completed launch actions without silently accepting new actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-actions-')), data = join(root, 'conversation'), os = protector();
  const instance = options => acquireAppInstance(options, { protector: os });
  let app, runs = 0;
  const run = async (_args, { ui }) => { runs++; ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait(); };
  try {
    app = await startApp(['--data', data, '--login', '--upgrade-contact'], { run, instance, open: async () => {} });
    const plain = await instance(contactOptions(['--data', data]));
    const repeat = await instance(contactOptions(['--data', data, '--login', '--upgrade-contact']));
    assert.equal(plain.url, app.url); assert.equal(repeat.url, app.url); assert.equal(runs, 1);
    await app.close();
    app = await startApp(['--data', data], { run, instance, open: async () => {} });
    for (const flag of ['--login', '--upgrade-contact']) {
      await assert.rejects(instance(contactOptions(['--data', data, flag])), /ACTION_REQUIRES_RESTART/);
    }
    assert.equal(runs, 2);
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('window publication failure opens a useful error screen and releases ownership before any runtime starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-publish-')), data = join(root, 'conversation');
  const broken = { ...protector(), async protect() { throw Error('CONTACT_OS_PROTECTION_FAILED'); } };
  let app, runs = 0; const opened = [];
  try {
    app = await startApp(['--data', data], { instance: options => acquireAppInstance(options, { protector: broken }),
      run: async () => { runs++; }, open: async url => { opened.push(url); } });
    assert.equal(runs, 0); assert.deepEqual(opened, [app.url]);
    const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('setup');
    const state = await fetch(url.origin + '/state', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    assert.equal(state.stage, 'error'); assert.equal(state.retryable, false); assert.match(state.message, /Windows 계정/u);
    const replacement = await acquireAppInstance(contactOptions(['--data', data]), { protector: protector() });
    assert.equal(replacement.existing, false); replacement.close();
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});
