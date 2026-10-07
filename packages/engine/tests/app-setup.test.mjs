import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSetup } from '../src/app-setup.mjs';
import { appArguments } from '../src/start-app.mjs';

const turn = () => new Promise(resolve => setTimeout(resolve, 10));
async function client(run) {
  const host = await serveSetup({ run });
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
    mkdirSync(data);
    assert.equal(appArguments(['--data', data]).includes('--init'), false);
    assert.equal(appArguments(['--data', data, '--init']).includes('--init'), true, 'explicit creation is not silently changed before this run creates a journal');
    assert.throws(() => appArguments(['--port', 'not-a-port']));
    const defaults = appArguments([]); assert.ok(defaults.includes('--data'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
