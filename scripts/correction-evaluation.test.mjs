import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCorrectionAcceptance, correctionFixtures } from '../evals/assistant-v1/correction-candidate.mjs';

test('correction evaluation rejects invalid request limits without acquiring a provider', async () => {
  let inspected = false;
  for (const requestLimit of [0, 65, '4', 1.5]) await assert.rejects(runCorrectionAcceptance({ provider: { inspect() { inspected = true; } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(inspected, false); assert.equal(correctionFixtures().length, 2);
});

test('correction fixtures retain yesterday timestamps, pending prior changes, and actual provider capabilities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-correction-harness-')); let inspected = false;
  const provider = { identity: { provider: 'chatgpt-subscription', model: 'fixture', billing: 'chatgpt-plan', account_label: 'ACCOUNT_CANARY' }, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    async inspect() { inspected = true; return this.identity; }, async researchPublicWeb() { throw Error('UNEXPECTED_RESEARCH'); },
    async chat(messages, tools, signal, beforeDispatch) {
      signal.throwIfAborted(); assert.equal(typeof beforeDispatch, 'function'); beforeDispatch();
      assert.equal(inspected, true); assert.ok(tools.some(tool => tool.function.name === 'research_public_web'));
      assert.doesNotMatch(JSON.stringify(messages), /A09|mechanical_checks|completion_checks|새봄|누리/);
      return { message: { role: 'assistant', content: '기존 업무를 변경하지 않은 시험 답변.' }, input_tokens: 1, output_tokens: 1 };
    } };
  try {
    const reportPath = join(root, 'report.json'); const report = await runCorrectionAcceptance({ provider, implementation: 'fixture', reportPath });
    assert.equal(report.model_requests.length, 2);
    for (const result of report.results) {
      assert.equal(result.status, 'failed'); assert.equal(result.execution_profile.local_reviews, false); assert.equal(result.execution_profile.public_web, true);
      assert.equal(result.work_after.items[0].id, result.work_before.id); assert.equal(result.work_after.pending.length, 1);
      assert.ok(result.fixture.history.at(-1).created - result.fixture.history[1].created >= 86399000);
      assert.equal(result.mechanical_checks.current_correction_bound, false);
    }
    assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /ACCOUNT_CANARY/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
