import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runContextualResearch, contextualResearchFixtures, hasPageInspection } from '../evals/assistant-v1/contextual-research-candidate.mjs';
const nativeIntegration = { skip: process.env.TADA_TEST_READ_BROKER ? false : 'Set TADA_TEST_READ_BROKER to the compiled Rust read broker; Linux/Windows CI builds and supplies it.' };

test('contextual research rejects invalid limits before provider access', async () => {
  let inspected = false;
  for (const requestLimit of [0, 65, '4', 1.5]) await assert.rejects(runContextualResearch({ repo: resolve('.'), provider: { inspect() { inspected = true; } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(inspected, false); assert.equal(contextualResearchFixtures().length, 2);
});
test('contextual research preserves archived reports and separates old targets from model input without awarding a scripted pass', nativeIntegration, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-contextual-harness-')); let inspected = false, returned = 0;
  const provider = { identity: { provider: 'chatgpt-subscription', model: 'fixture', billing: 'chatgpt-plan', account_label: 'ACCOUNT_CANARY' }, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    async inspect() { inspected = true; return this.identity; }, async researchPublicWeb() { throw Error('UNEXPECTED_RESEARCH'); },
    async chat(messages, tools, signal, beforeDispatch) {
      assert.equal(inspected, true); signal.throwIfAborted(); assert.equal(typeof beforeDispatch, 'function'); beforeDispatch();
      assert.ok(tools.some(tool => tool.function.name === 'research_public_web')); assert.ok(tools.some(tool => tool.function.name === 'list_sources'));
      assert.doesNotMatch(JSON.stringify(messages), /A01|mechanical_checks|Microsoft|Costco|completion_checks/);
      returned++;
      return { message: { role: 'assistant', content: '조사하지 않은 합성 시험 답변.' }, input_tokens: 1, output_tokens: 1 };
    } };
  try {
    const reportPath = join(root, 'report.json');
    const report = await runContextualResearch({ repo: resolve('.'), provider, implementation: 'fixture', reportPath, broker: process.env.TADA_TEST_READ_BROKER });
    assert.equal(returned, 2, 'provider assertions must reach the normal return in each variant');
    assert.equal(report.model_requests.length, 2); assert.ok(report.model_requests.every(item => item.state === 'observed'));
    assert.equal(report.product_acceptance, 'not_passed');
    for (const result of report.results) {
      assert.equal(result.status, 'failed'); assert.equal(result.execution_profile.local_reviews, false);
      assert.equal(result.turn.state, 'answered'); assert.equal(result.turn.answer.text, '조사하지 않은 합성 시험 답변.');
      assert.equal(result.mechanical_checks.target_outside_recent_context, true); assert.equal(result.mechanical_checks.previous_analysis_read, false);
      assert.equal(result.mechanical_checks.owner_context_forwarded, false);
      assert.equal(result.fixture.files.length, 3); assert.ok(result.fixture.files.filter(file => file.company).every(file => new Date(file.original_created).toISOString().startsWith('2026-10-09')));
    }
    assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /ACCOUNT_CANARY/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('page inspection recognizes both original-page actions but never a search-only or malformed trace', () => {
  for (const type of ['open_page', 'find_in_page']) assert.equal(hasPageInspection([{ type, url: 'https://www.sec.gov/example.htm' }]), true);
  for (const observations of [undefined, [], [{ type: 'search', url: 'https://www.sec.gov/example.htm' }],
    [{ type: 'open_page' }], [{ type: 'find_in_page', url: 'not a URL' }], [{ type: 'open_page', url: 'file:///etc/passwd' }]]) {
    assert.equal(hasPageInspection(observations), false);
  }
});

for (const operation of ['chat', 'public_web']) for (const known of [false, true]) test(`${operation} failure preserves ${known ? 'observed usage' : 'uncertainty'} consistently with the journal`, nativeIntegration, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-contextual-failure-'));
  const failure = () => { const error = Error('CHATGPT_INCOMPLETE_TURN'); if (known) error.observedUsage = { input_tokens: 11, output_tokens: 7 }; throw error; };
  const provider = { identity: { provider: 'chatgpt-subscription', model: 'fixture', billing: 'chatgpt-plan' }, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    async inspect() { return this.identity; }, async researchPublicWeb() { return failure(); },
    async chat(messages) {
      if (operation === 'chat') return failure();
      const response = messages.some(m => m.role === 'tool') ? { role: 'assistant', content: '공개 자료를 확인하지 못했어요.' }
        : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'research_public_web', arguments: {} } }] };
      return { message: response, input_tokens: 2, output_tokens: 1 };
    } };
  try {
    const report = await runContextualResearch({ repo: resolve('.'), provider, implementation: 'fixture', reportPath: join(root, 'report.json'), broker: process.env.TADA_TEST_READ_BROKER });
    assert.equal(report.results.length, 2);
    for (const result of report.results) {
      const failed = report.model_requests.filter(item => item.variant === result.variant && item.operation === operation);
      assert.equal(failed.length, 1); assert.equal(failed[0].state, known ? 'observed_failure' : 'unknown');
      const receipt = result.calls.find(item => item.number === failed[0].number);
      assert.equal(receipt.error, 'CHATGPT_INCOMPLETE_TURN');
      assert.deepEqual(receipt.observed_usage, known ? { input_tokens: 11, output_tokens: 7 } : undefined);
      assert.equal(result.usage.unknown_requests, known ? 0 : 1);
      const successful = report.model_requests.filter(item => item.variant === result.variant && item.state === 'observed').length;
      assert.equal(result.usage.input_tokens, successful * 2 + (known ? 11 : 0));
      assert.equal(result.usage.output_tokens, successful + (known ? 7 : 0));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
