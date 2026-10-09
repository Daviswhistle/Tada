import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsBackgroundApp } from '../src/windows-background-app.mjs';
import { contactOptions } from '../src/contact-cli.mjs';
const local = '/fixture/local', data = local + '/Tada/conversation';
const options = () => contactOptions(['--data', data]);
const config = run => ({ node: local + '/Tada/app/versions/' + 'a'.repeat(64) + '/node/node.exe', platform: 'win32',
  env: { LOCALAPPDATA: local, TADA_WINDOWS_SUPERVISED: '1' }, run });
test('installed startup registers only the existing route and disables without stopping or handing off', async () => {
  const calls = []; let registered = false, checked = 0, prepared = 0;
  const app = new WindowsBackgroundApp(options(), config(async (file, args) => {
    assert.equal(file, local + '/Tada/app/Tada.exe'); calls.push(args[0]);
    if (args[0] === '--startup-enable') registered = true;
    if (args[0] === '--startup-disable') registered = false;
    return JSON.stringify({ registered });
  }));
  assert.equal((await app.status(true)).available, true);
  const enabled = await app.configure(true, 'same_assistant_background_v1', () => checked++, () => prepared++);
  assert.equal(enabled.enabled, true); assert.equal(enabled.transfer, false); assert.equal(enabled.startup, 'registered_only');
  assert.equal(prepared, 1); assert.equal(checked, 2);
  assert.equal((await app.configure(false, null, () => checked++)).enabled, false);
  await app.handoff(); assert.equal(calls.some(value => /stop|kill/u.test(value)), false);
});
test('portable, unsupervised and nondefault route cannot register a different assistant', async () => {
  let called = 0; const make = () => config(async () => { called++; return '{"registered":false}'; });
  for (const variation of [ { model: 'different' }, { port: 9999 }, { timezone: 'Etc/GMT+9' }, { data: '/other' }, { roots: ['/source'] }, { 'chatgpt-profile': '/other-profile' } ]) {
    assert.equal((await new WindowsBackgroundApp({ ...options(), ...variation }, make()).status(true)).available, false);
  }
  assert.equal((await new WindowsBackgroundApp(options(), { ...make(), env: { LOCALAPPDATA: local } }).status()).available, false);
  assert.equal((await new WindowsBackgroundApp(options(), { ...make(), node: '/portable/node/node.exe' }).status()).available, false);
  assert.equal(called, 0);
});
test('revocation after preflight admits no registration; malformed helper results fail closed', async () => {
  const calls = []; let checks = 0;
  const app = new WindowsBackgroundApp(options(), config(async (_file, args) => { calls.push(args[0]); return '{"registered":false}'; }));
  await assert.rejects(app.configure(true, 'same_assistant_background_v1', () => { if (++checks === 2) throw Error('revoked'); }), /revoked/u);
  assert.deepEqual(calls, ['--startup-status']);
  for (const raw of ['{}', '{"registered":1}', '{"registered":true,"extra":true}']) {
    assert.equal((await new WindowsBackgroundApp(options(), config(async () => raw)).status(true)).available, false);
  }
});

test('a slow Windows startup query does not block conversation state reads', async () => {
  let finish;
  const app = new WindowsBackgroundApp(options(), config(() => new Promise(resolve => { finish = resolve; })));
  const first = await app.status(); assert.equal(first.checking, true);
  const repeated = await app.status(); assert.equal(repeated.checking, true);
  finish('{"registered":true}');
  assert.equal((await app.status(true)).enabled, true);
});

test('an installed repair generation keeps the same fixed startup entry', async () => {
  const fixture = config(async (file) => { assert.equal(file, local + '/Tada/app/Tada.exe'); return '{"registered":true}'; });
  fixture.node = fixture.node.replace('/' + 'a'.repeat(64) + '/', '/' + 'a'.repeat(64) + '-' + 'b'.repeat(32) + '/');
  assert.equal((await new WindowsBackgroundApp(options(), fixture).status(true)).enabled, true);
});
