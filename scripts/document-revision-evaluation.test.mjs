import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentRevisionFixtures, runDocumentRevision } from '../evals/assistant-v1/document-revision-candidate.mjs';
const identity = { provider: 'chatgpt-subscription', model: 'synthetic', billing: 'chatgpt-plan', account_label: 'ACCOUNT_CANARY' };
const reply = content => ({ message: { role: 'assistant', content }, input_tokens: 1, output_tokens: 1 });
const call = (name, args) => ({ ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
test('document revision fixes two ordinary variants and rejects bad budgets before account access', async () => {
  const fixtures = documentRevisionFixtures(); assert.equal(fixtures.length, 2); assert.notEqual(fixtures[0].ask, fixtures[1].ask);
  let touched = false;
  for (const requestLimit of [0, 65, -1, 1.5, '32']) await assert.rejects(runDocumentRevision({ provider: { inspect() { touched = true; } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(touched, false);
});
test('document evaluator exercises owner-edit, same-root revision and actual export without self-awarding acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-doc-eval-')), seen = [], gates = [];
  let rounds = 0;
  const provider = { identity, inspect: async () => identity, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    researchPublicWeb() { throw Error('UNEXPECTED_RESEARCH'); },
    async chat(messages, tools, signal, beforeDispatch) {
      seen.push({ messages, tools }); gates.push(typeof beforeDispatch); beforeDispatch?.(signal);
      const step = rounds++ % 3;
      if (step === 0) return call('read_document', { id: 4 });
      if (step === 1) return call('prepare_document', { title: '짧은 문서', format: 'markdown', based_on: 4 });
      return reply('합성 검사 결과. 의미 검수가 필요합니다.');
    } };
  try {
    const path = join(root, 'result.json'), report = await runDocumentRevision({ provider, reportPath: path, implementation: 'fixture' });
    assert.equal(report.model_requests.length, 6); assert.equal(seen.length, 6); assert.ok(report.model_requests.every(item => item.state === 'observed'));
    assert.ok(report.results.every(item => item.turn.state === 'answered' && item.status === 'needs_semantic_review' && Object.values(item.mechanical_checks).every(Boolean)));
    assert.ok(report.results.every(item => item.usage.requests === 3 && item.execution_profile.local_reviews === false && item.execution_profile.public_web));
    assert.ok(gates.every(item => item === 'function')); assert.ok(seen.every(item => item.tools.some(tool => tool.function.name === 'research_public_web')));
    assert.doesNotMatch(JSON.stringify(seen), /A04|completion_checks|mechanical_checks/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /ACCOUNT_CANARY/); assert.equal(report.product_acceptance, 'not_passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const known of [true, false]) test(`document evaluator preserves failed usage: known=${known}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-doc-eval-fail-'));
  const provider = { identity, inspect: async () => identity, async chat() { const error = Error('FIXTURE_FAILURE'); if (known) error.observedUsage = { input_tokens: 3, output_tokens: 2 }; throw error; } };
  try {
    const report = await runDocumentRevision({ provider, reportPath: join(root, 'result.json'), implementation: 'fixture' });
    assert.equal(report.model_requests.length, 2); assert.ok(report.results.every(item => item.status === 'failed' && item.turn.state === 'failed'));
    assert.ok(report.model_requests.every(item => item.state === (known ? 'observed_failure' : 'unknown')));
    assert.ok(report.results.every(item => item.usage.requests === 1 && item.usage.unknown_requests === (known ? 0 : 1)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
