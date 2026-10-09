import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeFixtures, runResume } from '../evals/assistant-v1/resume-candidate.mjs';
const identity = { provider: 'chatgpt-subscription', model: 'synthetic', billing: 'chatgpt-plan', account_label: 'ACCOUNT_CANARY' };
const reply = content => ({ message: { role: 'assistant', content }, input_tokens: 1, output_tokens: 1 });
const call = (name, args) => ({ ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
test('resume fixtures fix distinct contexts and reject invalid budgets before account access', async () => {
  const fixtures = resumeFixtures(); assert.equal(fixtures.length, 2); assert.notEqual(fixtures[0].ask, fixtures[1].ask);
  let touched = false;
  for (const requestLimit of [0, -1, 65, 1.5, '32']) await assert.rejects(runResume({ provider: { inspect() { touched = true; } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(touched, false);
});
test('resume evaluation uses killed real fixture processes, preserves uncertain history and does not self-award acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-resume-eval-')), seen = [], gates = []; let rounds = 0;
  const provider = { identity, inspect: async () => identity, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    researchPublicWeb() { throw Error('UNEXPECTED_RESEARCH'); }, async chat(messages, tools, signal, beforeDispatch) {
      seen.push({ messages, tools }); gates.push(typeof beforeDispatch); beforeDispatch?.(signal);
      const variant = Math.floor(rounds / 4), step = rounds++ % 4, latest = variant ? 5 : 4, stopped = variant ? 7 : 6;
      if (step === 0) return call('read_history', { id: stopped });
      if (step === 1) return call('read_document', { id: latest });
      if (step === 2) return call('prepare_document', { title: '이어 쓴 문서', format: 'markdown', based_on: latest });
      return reply('합성 검사 결과. 의미 검수가 필요합니다.');
    } };
  try {
    const path = join(root, 'result.json'), report = await runResume({ provider, reportPath: path, implementation: 'fixture' });
    assert.equal(seen.length, 8); assert.equal(report.model_requests.length, 8);
    assert.ok(report.results.every(result => result.status === 'needs_semantic_review' && Object.values(result.mechanical_checks).every(Boolean)));
    assert.ok(report.results.every(result => result.requests_before_new_instruction === 0 && result.interruption.signal === 'SIGKILL'));
    assert.ok(report.results.every(result => result.usage.requests === 6 && result.usage.unknown_requests === 1));
    assert.ok(report.results.every(result => result.after_restart.ledger[1].state === 'unknown' && result.interruption.ledger[1].state === 'reserved'));
    assert.ok(report.results.every(result => result.execution_profile.local_reviews === false && result.execution_profile.public_web));
    assert.ok(gates.every(gate => gate === 'function')); assert.ok(seen.every(item => item.tools.some(tool => tool.function.name === 'research_public_web')));
    assert.doesNotMatch(JSON.stringify(seen), /A11|completion_checks|mechanical_checks/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /ACCOUNT_CANARY/); assert.equal(report.product_acceptance, 'not_passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const known of [true, false]) test(`resume evaluator preserves old unknown use and new failed usage: known=${known}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-resume-eval-fail-'));
  const provider = { identity, inspect: async () => identity, async chat() { const error = Error('FIXTURE_FAILURE'); if (known) error.observedUsage = { input_tokens: 3, output_tokens: 2 }; throw error; } };
  try {
    const report = await runResume({ provider, reportPath: join(root, 'result.json'), implementation: 'fixture' });
    assert.equal(report.model_requests.length, 2); assert.ok(report.results.every(item => item.status === 'failed' && item.turn.state === 'failed'));
    assert.ok(report.model_requests.every(item => item.state === (known ? 'observed_failure' : 'unknown')));
    assert.ok(report.results.every(item => item.usage.requests === 3 && item.usage.unknown_requests === (known ? 1 : 2)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
