import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixtureMessage, stopFixture } from './runtime-fixture-ipc.mjs';
const launch = source => spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });

test('fixture exit before readiness rejects and cleanup accepts an exited child', { timeout: 5000 }, async () => {
  const child = launch('process.exit(23)');
  try {
    await assert.rejects(fixtureMessage(child), /FIXTURE_EXIT: 23/);
    assert.equal(child.exitCode, 23);
    await assert.rejects(fixtureMessage(child), /FIXTURE_EXIT: 23/);
    assert.equal(child.listenerCount('message'), 0);
  } finally { await stopFixture(child); }
});
test('fixture exit before counts cannot strand the parent report', { timeout: 5000 }, async () => {
  const child = launch("process.send({ready:true}); process.on('message',()=>process.exit(24));");
  try {
    assert.deepEqual(await fixtureMessage(child), { ready: true });
    await assert.rejects(fixtureMessage(child, { send: 'counts' }), /FIXTURE_EXIT: 24/);
  } finally { await stopFixture(child); }
});
test('a live but silent fixture times out and disconnect cleanup terminates it', { timeout: 5000 }, async () => {
  const child = launch("process.send({ready:true}); process.on('message',()=>{}); process.on('disconnect',()=>process.exit(0));");
  try {
    await fixtureMessage(child);
    await assert.rejects(fixtureMessage(child, { send: 'counts', timeoutMs: 100 }), /FIXTURE_IPC_TIMEOUT/);
    assert.equal(child.listenerCount('message'), 0);
  } finally { await stopFixture(child); }
  assert.equal(child.exitCode, 0);
});
test('fixture cleanup kills an unresponsive owned child after bounded grace', { timeout: 5000 }, async () => {
  const child = launch("setInterval(()=>{},1000); process.send({ready:true});");
  await fixtureMessage(child);
  await stopFixture(child);
  assert.equal(child.signalCode, 'SIGKILL');
});
test('spawn error rejects the waiting fixture and does not block cleanup', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath + '-does-not-exist', [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await assert.rejects(fixtureMessage(child), /ENOENT/);
  await stopFixture(child);
});
