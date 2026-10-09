import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfirmationAcceptance } from '../evals/assistant-v1/mail-confirmation-candidate.mjs';
for (const requestLimit of [0, -1, 25, 1.5, '24', 'unbounded', NaN, Infinity, null]) test(`mail confirmation rejects invalid request limit ${String(requestLimit)} before account access`, async () => {
  let touched = false;
  await assert.rejects(runConfirmationAcceptance({ provider: { inspect() { touched = true; throw Error('ACCOUNT_MUST_NOT_BE_READ'); } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(touched, false);
});
for (const requestLimit of [1, 24]) test(`mail confirmation admits bounded integer ${requestLimit} without changing it`, async () => {
  let calls = 0;
  await assert.rejects(runConfirmationAcceptance({ provider: { inspect() { calls++; throw Error('SYNTHETIC_INSPECTION_STOP'); } }, requestLimit }), /SYNTHETIC_INSPECTION_STOP/);
  assert.equal(calls, 1);
});

test('provider without optional contextBytes uses the normal default measurement path', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'tada-mail-eval-budget-')); let calls = 0;
  const provider = {
    identity: { provider: 'ollama-local', model: 'synthetic', model_digest: 'synthetic-local-model' },
    async inspect() { return this.identity; },
    async chat(messages) {
      const step = calls++ % 3; let message;
      if (step === 0) message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_mail_actions', arguments: { before: null } } }] };
      else if (step === 1) {
        const list = JSON.parse(messages.at(-1).content), target = list.records.find(r => r.state === 'UNCERTAIN');
        message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_mail_action', arguments: { id: target.id } } }] };
      } else {
        const receipt = JSON.parse(messages.at(-1).content); assert.ok(['VERIFIED', 'UNCERTAIN'].includes(receipt.state));
        message = { role: 'assistant', content: '저장된 발송 시도의 현재 확인 결과를 조회했습니다.' };
      }
      return { message, input_tokens: 1, output_tokens: 1 };
    },
  };
  try {
    const result = await runConfirmationAcceptance({ provider, implementation: 'synthetic-protocol-regression', reportPath: join(root, 'report.json'), requestLimit: 6 });
    assert.equal(calls, 6, JSON.stringify(result.results.map(r => r.error)));
    assert.equal(result.requests.length, 6); assert.ok(result.requests.every(r => r.state === 'observed'));
    assert.ok(result.results.every(r => r.status === 'needs_semantic_review'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
