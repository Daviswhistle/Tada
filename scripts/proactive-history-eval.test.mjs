import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProactiveHistory } from '../evals/assistant-v1/proactive-history-candidate.mjs';

test('proactive evaluation inspects the supplied provider and preserves its profile without exposing account identity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T03:00:00Z') });
  const root = mkdtempSync(join(tmpdir(), 'tada-history-eval-test-')), reportPath = join(root, 'report.json');
  let inspected = false, calls = 0;
  const provider = {
    identity: null, contextLimitBytes: 65536, contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    async inspect() { inspected = true; return this.identity = { provider: 'chatgpt-subscription', model: 'synthetic', billing: 'chatgpt-plan', account_label: 'PRIVATE_ACCOUNT_CANARY' }; },
    async chat(messages, tools) {
      assert.equal(inspected, true); calls++;
      assert.ok(tools.some(t => t.function.name === 'search_history'));
      assert.ok(!tools.some(t => ['prepare_document', 'apply_personal_request'].includes(t.function.name)));
      assert.doesNotMatch(JSON.stringify(messages), /owner_cancelled|confirmed_constraints|mechanical_checks|PRIVATE_ACCOUNT_CANARY/);
      return { message: { role: 'assistant', content: 'NO_NEW_SUGGESTION', provider_state: 'PRIVATE_CONTINUATION_CANARY' }, input_tokens: 1, output_tokens: 1 };
    },
  };
  try {
    const report = await runProactiveHistory({ provider, implementation: 'synthetic-test', reportPath });
    assert.equal(report.runtime.provider, 'chatgpt-subscription'); assert.equal(report.runtime.billing, 'chatgpt-plan');
    assert.equal(report.results.length, 2); assert.ok(calls >= 2 && calls <= 8);
    assert.ok(report.results.every(r => r.history_outside_recent_context && r.status === 'needs_semantic_review'));
    assert.ok(report.results.every(r => r.execution_profile.provider === 'chatgpt-subscription' && r.execution_profile.local_reviews === false));
    assert.ok(report.results.every(r => !r.mechanical_checks.history_read));
    assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /PRIVATE_ACCOUNT_CANARY|PRIVATE_CONTINUATION_CANARY/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
