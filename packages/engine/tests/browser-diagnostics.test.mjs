import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { drainBrowserStderr } from '../../../evals/assistant-v1/browser-diagnostics.mjs';

test('a verbose child can finish startup without blocking on an unread stderr pipe', { timeout: 5000 }, async () => {
  const size = 2 * 1024 * 1024;
  const child = spawn(process.execPath, ['-e', `process.stderr.write('x'.repeat(${size}),()=>process.stdout.end('ready'))`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const diagnostics = drainBrowserStderr(child); let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0); assert.equal(stdout, 'ready');
    assert.equal(diagnostics().stderr_bytes, size);
    assert.equal(Buffer.byteLength(diagnostics().stderr_tail), 8192);
  } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('browser diagnostics redact pairing fragments and reject an unbounded capture setting', () => {
  const stderr = new PassThrough(), child = { stderr, exitCode: null, signalCode: null };
  const diagnostic = drainBrowserStderr(child, 1024);
  stderr.write('navigation http://127.0.0.1/#pair=fixture_pairing_secret\n');
  assert.ok(!diagnostic().stderr_tail.includes('fixture_pairing_secret'));
  assert.match(diagnostic().stderr_tail, /#pair=\[redacted\]/);
  for (const limit of [0, -1, Infinity, 65537]) assert.throws(() => drainBrowserStderr(child, limit));
  stderr.destroy();
});
