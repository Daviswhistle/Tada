import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { BackgroundApp, BACKGROUND_CONSENT, backgroundArguments, backgroundUnit } from '../src/background-app.mjs';
import { contactOptions } from '../src/contact-cli.mjs';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { serveContact } from '../src/contact-http.mjs';
const sources = { definitions: [], validate: () => false, verify: async () => false };
const reply = text => ({ message: { role: 'assistant', content: text }, input_tokens: 1, output_tokens: 1 });
function environment() {
  const root = mkdtempSync(join(tmpdir(), 'tada-background-'));
  const options = contactOptions(['--data', join(root, 'private')]);
  let enabled = false, running = false;
  const calls = [], run = async args => {
    calls.push(args);
    if (args[0] === 'show') return args[1] === '--property=Version' ? 'Version=255\n'
      : `UnitFileState=${enabled ? 'enabled' : 'disabled'}\nActiveState=${running ? 'active' : 'inactive'}\nSubState=${running ? 'running' : 'dead'}\n`;
    if (args[0] === 'enable') enabled = true;
    if (args[0] === 'disable') enabled = false;
    if (args[0] === 'start') running = true;
    return '';
  };
  return { root, options, run, calls, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('background launch preserves exact source/model options, strips one-time actions, and quotes systemd metacharacters', () => {
  const options = contactOptions(['--data', '/tmp/a %name $VALUE "quoted"', '--init', '--login', '--upgrade-contact', '--model', 'fixture']);
  const args = backgroundArguments(options);
  assert.equal(args[0], '--background');
  for (const key of ['--init', '--login', '--upgrade-contact', '--endpoint']) assert.equal(args.includes(key), false);
  const unit = backgroundUnit(options, '/tmp/node with space', '/tmp/start-app.mjs');
  assert.match(unit, /%%name \$\$VALUE \\"quoted\\"/);
  assert.match(unit, /StandardOutput=null/); assert.match(unit, /UMask=0077/);
  assert.doesNotMatch(unit, /^Environment=/m); assert.match(unit, /^UnsetEnvironment=TADA_GOOGLE_OAUTH_CLIENT_ID TADA_GOOGLE_OAUTH_CLIENT_SECRET$/m); assert.equal(unit.includes('#setup='), false);
  assert.throws(() => backgroundUnit({ ...options, data: '/tmp/new\nline' }), /SETTINGS_INVALID/);
});
test('explicit opt-in installs only the same private user unit; disabling preserves the running app and its data', async () => {
  const e = environment(); let handed = 0, authorized = 0;
  try {
    const app = new BackgroundApp(e.options, { directory: join(e.root, 'units'), run: e.run, handoff: async () => { handed++; } });
    assert.equal((await app.status()).enabled, false);
    assert.equal(e.calls.some(c => c[0] === 'enable'), false);
    await assert.rejects(app.configure(true, null, () => {}), /CONSENT/);
    const state = await app.configure(true, BACKGROUND_CONSENT, () => { authorized++; });
    assert.equal(state.enabled, true); assert.equal(state.running, true); assert.equal(state.transfer, true);
    assert.equal(handed, 0); await app.handoff(); assert.equal(handed, 1); assert.ok(authorized >= 3);
    const path = join(e.root, 'units', readdirSync(join(e.root, 'units'))[0]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const bytes = readFileSync(path, 'utf8');
    const disabled = await app.configure(false, null, () => {});
    assert.equal(disabled.enabled, false); assert.equal(disabled.running, true);
    assert.equal(e.calls.some(c => ['stop', 'restart', 'kill'].includes(c[0])), false);
    assert.equal(readFileSync(path, 'utf8'), bytes);
    const service = new BackgroundApp(e.options, { directory: join(e.root, 'units'), run: e.run, background: true, handoff: async () => { throw Error('No second transfer'); } });
    assert.equal((await service.configure(true, BACKGROUND_CONSENT, () => {})).transfer, false); await service.handoff();
  } finally { e.close(); }
});
test('changed units, symlinks and a revoked requesting device cannot gain startup authority', async () => {
  const e = environment();
  try {
    const directory = join(e.root, 'units');
    const app = new BackgroundApp(e.options, { directory, run: e.run });
    await app.configure(true, BACKGROUND_CONSENT, () => {});
    const path = join(directory, readdirSync(directory)[0]);
    writeFileSync(path, 'Unrelated owner service');
    assert.equal((await app.status(true)).available, false);
    await assert.rejects(app.configure(true, BACKGROUND_CONSENT, () => {}), /UNAVAILABLE/);
    assert.equal(readFileSync(path, 'utf8'), 'Unrelated owner service');
    unlinkSync(path); symlinkSync(join(e.root, 'absent'), path);
    assert.equal((await app.status(true)).error, 'CONTACT_BACKGROUND_PATH_INVALID');
    const linked = join(e.root, 'linked'); symlinkSync(directory, linked);
    const unsafe = new BackgroundApp(e.options, { directory: linked, run: e.run });
    assert.equal((await unsafe.status(true)).error, 'CONTACT_BACKGROUND_PATH_INVALID');
    let current = true;
    const revoked = new BackgroundApp(e.options, { directory: join(e.root, 'other'), run: async args => {
      const result = await e.run(args); if (args[0] === 'daemon-reload') current = false; return result;
    } });
    e.calls.length = 0;
    await assert.rejects(revoked.configure(true, BACKGROUND_CONSENT, () => { if (!current) throw Error('CONTACT_DEVICE_REVOKED'); }), /REVOKED/);
    assert.equal(e.calls.some(c => c[0] === 'enable' || c[0] === 'start'), false);
  } finally { e.close(); }
});
test('service handoff drains admitted requests without aborting inference, then closes new admission', async () => {
  const e = environment(); let service, store, finish, calls = 0;
  try {
    store = new ContactStore({ directory: e.options.data, passphrase: 'synthetic background test password', route: contactRoute({ fixture: 'background' }), initialize: true, assistance: true });
    const device = store.addDevice('browser').id;
    service = new ContactService(store, { chat: async (_messages, _tools, signal) => {
      calls++; if (calls === 1) await new Promise(resolve => { finish = resolve; });
      assert.equal(signal.aborted, false); return reply('Completed');
    } }, sources);
    const a = service.submit(device, randomUUID(), 'First work');
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    const transfer = service.stopWhenIdle();
    const b = service.submit(device, randomUUID(), 'Second already admitted work');
    finish(); await transfer;
    assert.equal(store.turn(a.seq).state, 'answered'); assert.equal(store.turn(b.seq).state, 'answered');
    assert.equal(service.stopped, true); assert.equal(calls, 2);
    assert.throws(() => service.submit(device, randomUUID(), 'Too late'), /HOST_STOPPING/);
  } finally { await service?.close(); store?.close(); e.close(); }
});
test('startup HTTP actions require exact authenticated consent and transfer only after the response is finished', async () => {
  const e = environment(); let host, store, service, changes = 0, transfers = 0;
  try {
    store = new ContactStore({ directory: e.options.data, passphrase: 'synthetic background HTTP password', route: contactRoute({ fixture: 'background' }), initialize: true, assistance: true });
    service = new ContactService(store, { chat: async () => reply('unused') }, sources);
    const temporary = createServer(); await new Promise(resolve => temporary.listen(0, '127.0.0.1', resolve));
    const port = temporary.address().port; await new Promise(resolve => temporary.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    host = await serveContact({ store, service, origin, port, background: {
      status: async () => ({ available: true, enabled: false }),
      configure: async (enabled, consent, authorize) => { authorize(); assert.equal(consent, BACKGROUND_CONSENT); changes++; return { enabled, transfer: true }; },
      handoff: async () => { transfers++; },
    } });
    const post = (path, value, cookie) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value) });
    assert.equal((await post('/api/background', { enabled: true, consent: BACKGROUND_CONSENT })).status, 401);
    const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
    const paired = await post('/api/pair', { code, name: 'owner' }); const cookie = paired.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/background', { enabled: true, consent: BACKGROUND_CONSENT, command: 'arbitrary' }, cookie)).status, 400);
    assert.equal(changes, 0);
    const response = await post('/api/background', { enabled: true, consent: BACKGROUND_CONSENT }, cookie);
    assert.equal(response.status, 200); assert.equal((await response.json()).transferring, true);
    assert.equal(changes, 1); assert.equal(transfers, 1);
  } finally { await host?.close(); await service?.close(); store?.close(); e.close(); }
});

test('optional status never waits for a slow manager and shares one pending probe', async () => {
  const e = environment(); let release, probes = 0;
  try {
    const app = new BackgroundApp(e.options, { directory: join(e.root, 'units'), run: async () => {
      probes++; return new Promise(resolve => { release = resolve; });
    } });
    const first = await app.status(); assert.equal(first.checking, true);
    assert.equal((await app.status()).checking, true); assert.equal(probes, 1);
    const forced = app.status(true); release('Version=255\n');
    assert.equal((await forced).available, true); assert.equal(probes, 1);
    assert.equal((await app.status()).available, true);
  } finally { e.close(); }
});
test('nonportable account settings reject transfer before any service writes', async () => {
  const e = environment();
  try {
    const app = new BackgroundApp(e.options, { directory: join(e.root, 'units'), run: e.run });
    await assert.rejects(app.configure(true, BACKGROUND_CONSENT, () => {}, () => { throw Error('CONTACT_BACKGROUND_GOOGLE_SETTINGS_REQUIRED'); }), /GOOGLE_SETTINGS_REQUIRED/);
    assert.deepEqual(readdirSync(e.root), []);
    assert.ok(e.calls.every(args => args[0] === 'show'));
    assert.equal((await app.configure(false, null, () => {}, () => { throw Error('must not block disable'); })).enabled, false);
  } finally { e.close(); }
});

test('a UI probe that started before service activation cannot reject a successful transfer', async () => {
  const e = environment(); const realNow = Date.now; let advance = 0, app, startedProbe = false, release, delayed = false;
  Date.now = () => realNow() + advance;
  try {
    app = new BackgroundApp(e.options, { directory: join(e.root, 'units'), run: async args => {
      if (args[0] === 'start') {
        advance += 6000; delayed = true; app.status();
        while (!startedProbe) await new Promise(resolve => setTimeout(resolve, 1));
        const result = await e.run(args);
        setTimeout(() => { delayed = false; release(); }, 20);
        return result;
      }
      const result = await e.run(args);
      if (delayed && args[0] === 'show' && args[1] !== '--property=Version') {
        startedProbe = true; return new Promise(resolve => { release = () => resolve(result); });
      }
      return result;
    } });
    const state = await app.configure(true, BACKGROUND_CONSENT, () => {});
    assert.equal(state.running, true); assert.equal(state.transfer, true);
  } finally { Date.now = realNow; e.close(); }
});
