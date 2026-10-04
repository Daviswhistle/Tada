// Actual command dispatch; neither route receives a real credential or model call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the existing assistant entry requires an explicit web opt-in and keeps local setup separate', () => {
  const cli = fileURLToPath(new URL('../src/assistant-cli.mjs', import.meta.url));
  const key = 'FAKE_ROUTE_CREDENTIAL_DO_NOT_USE';
  for (const [args, success, expected] of [
    [['--help'], true, /--allow-read/u],
    [['--web', '--help'], true, /conversational public research/u],
    [['--web', '--model', 'test-model'], false, /INTERACTIVE_TERMINAL_REQUIRED/u],
    [['--web', '--allow-read', '/private'], false, /INVALID_OPTIONS/u],
    [['--key', key], false, /ASSISTANT_ARGUMENTS/u],
  ]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
      env: { ...process.env, OPENAI_API_KEY: key }, input: `${key}\n`, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, success ? 0 : 1);
    assert.match(result.stdout + result.stderr, expected);
    assert.equal((result.stdout + result.stderr).includes(key), false);
  }
});
