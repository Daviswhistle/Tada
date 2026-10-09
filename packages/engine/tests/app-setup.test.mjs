import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSetup } from '../src/app-setup.mjs';
import { appArguments } from '../src/start-app.mjs';

const turn = () => new Promise(resolve => setTimeout(resolve, 10));
async function client(run, options = {}) {
  const host = await serveSetup({ run, ...options });
  const url = new URL(host.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('setup');
  const get = () => fetch(`${origin}/state`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const action = (state, action, value = null, overrides = {}) => fetch(`${origin}/action`, { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...overrides },
    body: JSON.stringify({ revision: state.revision, action, value }) });
  const until = async stage => { for (let i = 0; i < 100; i++) { const state = await get(); if (state.stage === stage) return state; await turn(); } throw Error(`SETUP_NOT_${stage}`); };
  return { host, origin, token, get, action, until };
}

test('setup exposes no owner state without its local capability and rejects foreign origins and stale answers', async () => {
  let accepted = 0;
  const c = await client(async ui => { await ui.consent(); accepted++; await ui.selectModel([{ name: 'Fixture' }]); ui.ready('http://127.0.0.1:8787/#pair=fixture'); await ui.wait(); });
  try {
    const consent = await c.until('consent');
    assert.equal((await fetch(`${c.origin}/state`)).status, 401);
    const page = await fetch(c.origin); assert.equal((await page.text()).includes(c.token), false);
    assert.equal((await c.action(consent, 'answer', true, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal(await new Promise(resolve => { const req = request(c.origin + '/state', { headers: { Host: 'foreign.invalid', Authorization: 'Bearer ' + c.token } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); }), 403);
    assert.equal((await c.action(consent, 'answer', true, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(accepted, 0);
    assert.equal((await c.action(consent, 'answer', true)).status, 200);
    const model = await c.until('model');
    assert.equal((await c.action(consent, 'answer', true)).status, 409);
    assert.equal((await c.action(model, 'answer', '2')).status, 409);
    assert.equal((await c.action(model, 'answer', '1')).status, 200);
    assert.equal((await c.until('ready')).url.includes('#pair='), true);
    assert.equal(accepted, 1);
  } finally { await c.host.close(); }
});

test('cancel waits for the old runtime to finish before retry, hides diagnostics and creates fresh consent', async () => {
  let running = 0, maximum = 0, attempts = 0;
  const c = await client(async ui => {
    running++; maximum = Math.max(maximum, running); attempts++;
    try {
      await ui.consent(); ui.login('https://auth.openai.com/fixture'); await ui.wait();
      throw Error('PRIVATE_FIXTURE_DIAGNOSTIC');
    } finally { running--; }
  });
  try {
    const first = await c.until('consent'); await c.action(first, 'answer', true);
    const login = await c.until('login'); await c.action(login, 'cancel');
    const error = await c.until('error'); assert.equal(JSON.stringify(error).includes('PRIVATE_FIXTURE'), false);
    await c.action(error, 'retry');
    const next = await c.until('consent'); assert.notEqual(first.revision, next.revision);
    assert.equal(attempts, 2); assert.equal(maximum, 1);
    assert.equal((await c.action(first, 'answer', true)).status, 409);
  } finally { await c.host.close(); }
  assert.equal(running, 0);
});

test('app selects stable default storage and never automatically initializes an existing directory on retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-args-'));
  try {
    const data = join(root, 'conversation');
    assert.equal(appArguments(['--data', data]).includes('--init'), true);
    assert.equal(appArguments(['--data', data], { initialize: false }).includes('--init'), false);
    mkdirSync(data);
    assert.equal(appArguments(['--data', data]).includes('--init'), false);
    assert.equal(appArguments(['--data', data, '--init']).includes('--init'), true, 'explicit creation is not silently changed before this run creates a journal');
    assert.throws(() => appArguments(['--port', 'not-a-port']));
    const defaults = appArguments([]); assert.ok(defaults.includes('--data'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background setup recovers transient startup observations without restarting an active conversation', async () => {
  let attempts = 0;
  const c = await client(async ui => {
    attempts++;
    if (attempts === 1) throw Error('CHATGPT_NETWORK_FAILED');
    ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait();
  }, { autoRetry: true, retryDelays: [100] });
  try {
    const error = await c.until('error'); assert.ok(error.retry_at > Date.now());
    await c.until('ready'); assert.equal(attempts, 2);
    await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(attempts, 2);
  } finally { await c.host.close(); }
});

for (const code of ['CHATGPT_REFRESH_UNCERTAIN', 'CONTACT_OS_PROTECTION_FAILED', 'CONTACT_ASSISTANCE_UPGRADE_REQUIRED', 'CONTACT_MAIL_UPGRADE_REQUIRED']) {
  test(`background setup leaves ${code} for owner recovery instead of retrying`, async () => {
    let attempts = 0;
    const c = await client(async () => { attempts++; throw Error(code); }, { autoRetry: true, retryDelays: [10] });
    try { const state = await c.until('error'); assert.equal(state.retry_at, undefined); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(attempts, 1); }
    finally { await c.host.close(); }
  });
}
test('background retry is cancelled by shutdown and never replays an interactive login exchange', async () => {
  let attempts = 0;
  const a = await client(async () => { attempts++; throw Error('CHATGPT_NETWORK_FAILED'); }, { autoRetry: true, retryDelays: [80] });
  await a.until('error'); await a.host.close(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(attempts, 1);
  const b = await client(async ui => { attempts++; ui.login('https://auth.openai.com/fixture'); throw Error('CHATGPT_NETWORK_FAILED'); }, { autoRetry: true, retryDelays: [10] });
  try { const state = await b.until('error'); assert.equal(state.retry_at, undefined); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(attempts, 2); }
  finally { await b.host.close(); }
});

test('real listen collisions recover automatically when the address is released', async () => {
  const { createServer } = await import('node:net');
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port; let attempts = 0;
  const c = await client(async ui => {
    attempts++; const listener = createServer();
    try {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
      ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait();
    } finally { if (listener.listening) await new Promise(resolve => listener.close(resolve)); }
  }, { autoRetry: true, retryDelays: [100] });
  try {
    assert.ok((await c.until('error')).retry_at);
    await new Promise(resolve => blocker.close(resolve)); await c.until('ready'); assert.equal(attempts, 2);
  } finally { if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); await c.host.close(); }
});
test('provider read timeout retries before interaction but owner cancellation does not', async () => {
  const { response } = await import('../../providers/src/chatgpt-http.mjs'); let attempts = 0;
  const c = await client(async ui => {
    attempts++;
    if (attempts === 1) await response(async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'https://example.invalid/fixture', { signal: AbortSignal.any([ui.signal, AbortSignal.timeout(20)]) });
    ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait();
  }, { autoRetry: true, retryDelays: [100] });
  try { assert.ok((await c.until('error')).retry_at); await c.until('ready'); assert.equal(attempts, 2); }
  finally { await c.host.close(); }
  const cancelled = await client(async ui => { ui.login('https://auth.openai.com/fixture'); await ui.wait(); throw Error('ASSISTANT_CANCELLED'); }, { autoRetry: true, retryDelays: [10] });
  try {
    await cancelled.action(await cancelled.until('login'), 'cancel');
    assert.equal((await cancelled.until('error')).retry_at, undefined);
  } finally { await cancelled.host.close(); }
});
