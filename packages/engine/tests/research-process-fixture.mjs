// Test harness only. No live model, TTY qualification or product acceptance claim.
import assert from 'node:assert/strict';
import { main } from '../src/research-cli.mjs';
import { KEY, MODEL, responseFixture, httpFixture } from '../../providers/tests/research-fixtures.mjs';
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
process.stdin.setRawMode = () => process.stdin;
let calls = 0;
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  const request = JSON.parse(init.body);
  assert.equal(request.model, MODEL);
  assert.equal(request.input.at(-1).role, 'user');
  if (calls === 1) {
    assert.equal(request.input[0].content, '그 서비스를 조사해줘.');
    assert.equal(request.input.at(-1).content, '아까 답변을 더 쉽게 고쳐줘.');
    assert.deepEqual(request.input.slice(1, -1), responseFixture({ id: 'resp_cli_1' }).output);
  }
  calls++;
  assert.ok(calls <= 2);
  return httpFixture(responseFixture({ id: `resp_cli_${calls}` }));
};
try {
  await main(['--model', MODEL]);
  assert.equal(calls, 2);
  process.stdout.write('\nTEST_ONLY_FOREGROUND_FLOW_PASSED\n');
} catch {
  process.stderr.write('TEST_ONLY_FOREGROUND_FLOW_FAILED\n');
  process.exitCode = 1;
}
