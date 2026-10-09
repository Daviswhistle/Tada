import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preferenceFixtures, runPreferenceAcceptance } from '../evals/assistant-v1/preference-candidate.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));

test('preference evaluation fixes two different ordinary requests and rejects invalid budgets before account use', async () => {
  const fixtures = preferenceFixtures();
  assert.equal(fixtures.length, 2); assert.notEqual(fixtures[0].ask, fixtures[1].ask);
  let touched = false; const provider = { inspect() { touched = true; } };
  for (const requestLimit of [0, 65, -1, 1.5, '24']) await assert.rejects(runPreferenceAcceptance({ repo, provider, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(touched, false);
});

test('preference evaluator preserves provider identity and does not self-award a pass for an ungrounded answer', { skip: !process.env.TADA_TEST_READ_BROKER }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-preference-check-')); let inspected = false;
  const provider = { identity: { provider: 'chatgpt-subscription', model: 'synthetic-model', billing: 'chatgpt-plan', account_label: 'ACCOUNT_CANARY' }, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    async inspect() { inspected = true; return this.identity; },
    async researchPublicWeb() { throw Error('UNEXPECTED_RESEARCH'); },
    async chat(messages, tools) {
      assert.equal(inspected, true); assert.ok(tools.some(tool => tool.function.name === 'research_public_web')); const text = JSON.stringify(messages);
      assert.doesNotMatch(text, /A05|completion_checks|mechanical_checks|앞으로 결정 사항|표보다 짧은 서술형/);
      return { message: { role: 'assistant', content: '형식을 확인하지 않은 답변입니다.', provider_state: { version: 1, provider: 'chatgpt-subscription', items: [{ type: 'reasoning', encrypted_content: 'STATE_CANARY' }] } }, input_tokens: 1, output_tokens: 1 };
    },
  };
  try {
    const reportPath = join(root, 'report.json');
    const report = await runPreferenceAcceptance({ repo, provider, broker: process.env.TADA_TEST_READ_BROKER, reportPath, implementation: 'fixture' });
    assert.equal(report.results.length, 2); assert.equal(report.model_requests.length, 2);
    assert.ok(report.results.every(result => result.status === 'failed' && result.execution_profile.local_reviews === false && result.execution_profile.public_web === true && !result.mechanical_checks.competing_formats_observed && !result.mechanical_checks.history_lookup && result.mechanical_checks.unchanged_source_files));
    assert.equal(report.product_acceptance, 'not_passed');
    assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /ACCOUNT_CANARY|STATE_CANARY/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
