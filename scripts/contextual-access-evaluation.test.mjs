import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextualAccessFixtures, runContextualAccess } from '../evals/assistant-v1/contextual-access-candidate.mjs';
const identity = { provider: 'chatgpt-subscription', model: 'synthetic', billing: 'chatgpt-plan', account_label: 'ACCOUNT_CANARY' };
const reply = content => ({ message: { role: 'assistant', content }, input_tokens: 1, output_tokens: 1 });
const call = (name, args) => ({ ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
test('contextual access fixes two variants per case and rejects invalid budgets before account access', async () => {
  const fixtures = contextualAccessFixtures(); assert.deepEqual(fixtures.map(f => f.case), ['A06', 'A06', 'A07', 'A07']);
  let touched = false;
  for (const requestLimit of [0, -1, 65, 1.5, '48']) await assert.rejects(runContextualAccess({ provider: { inspect() { touched = true; } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(touched, false);
});
test('contextual access uses real local OAuth callback, same history and current Google tools without self-grading meaning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-access-eval-')), seen = [], rounds = new Map(), fixtures = contextualAccessFixtures();
  const provider = { identity, inspect: async () => identity, contextLimitBytes: 65536,
    contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    researchPublicWeb() { throw Error('UNEXPECTED_RESEARCH'); }, async chat(messages, tools, signal, beforeDispatch) {
      seen.push({ messages, names: tools.map(t => t.function.name), gate: typeof beforeDispatch }); beforeDispatch?.();
      const text = messages.findLast(m => m.role === 'user').content, fixture = fixtures.find(f => f.ask === text || f.resume === text);
      if (!fixture) throw Error('UNKNOWN_TEST_REQUEST');
      const step = rounds.get(text) ?? 0; rounds.set(text, step + 1);
      if (fixture.resume === text) {
        if (step === 0) return call('list_upcoming_events', {});
        const observation = messages.findLast(m => m.tool_name === 'list_upcoming_events');
        const id = JSON.parse(observation.content).evidence_id;
        return reply(`일정 조회 합성 결과 [${id}]. 의미 검수가 필요합니다.`);
      }
      if (step === 0) return call('read_history', { id: 1 });
      if (step === 1) return call('read_document', { id: 2 });
      if (step === 2) return call('read_document', { id: 3 });
      return reply('합성 준비 결과입니다. 어떤 선택인지 알려주세요. 의미 검수가 필요합니다.');
    } };
  try {
    const path = join(root, 'result.json'), report = await runContextualAccess({ provider, reportPath: path, implementation: 'fixture' });
    assert.equal(seen.length, 20); assert.equal(report.model_requests.length, 20); assert.equal(report.fixture_version, 2);
    assert.ok(report.results.every(result => result.status === 'needs_semantic_review' && Object.values(result.mechanical_checks).every(Boolean)));
    for (const result of report.results.filter(r => r.case === 'A07')) {
      assert.equal(result.phases.length, 2); assert.equal(result.phases[0].connected, false); assert.equal(result.phases[1].connected, true);
      assert.equal(result.connection.pkce, 'S256'); assert.equal(result.connection.scopes.length, 2);
      assert.ok(result.phases[1].observed_tools.some(t => t.tool_name === 'list_upcoming_events'));
      assert.ok(result.network.every(n => n.phase !== 'initial'));
      assert.ok(result.network.some(n => n.phase === 'connecting' && n.method === 'POST'));
    }
    assert.ok(seen.every(s => s.gate === 'function' && s.names.includes('research_public_web')));
    assert.doesNotMatch(JSON.stringify(seen), /A06|A07|completion_checks|mechanical_checks/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /ACCOUNT_CANARY|SYNTHETIC_ACCESS_ONLY|SYNTHETIC_REFRESH_ONLY|SYNTHETIC_AUTH_CODE/);
    assert.equal(report.product_acceptance, 'not_passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const known of [true, false]) test(`contextual access retains failed requests and does not connect after a failed initial turn: known=${known}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-access-fail-'));
  const provider = { identity, inspect: async () => identity, async chat() { const error = Error('FIXTURE_FAILURE'); if (known) error.observedUsage = { input_tokens: 3, output_tokens: 2 }; throw error; } };
  try {
    const report = await runContextualAccess({ provider, reportPath: join(root, 'result.json'), implementation: 'fixture' });
    assert.equal(report.model_requests.length, 4); assert.ok(report.results.every(r => r.status === 'failed' && r.phases.length === 1 && r.phases[0].state === 'failed' && r.network.length === 0));
    assert.ok(report.model_requests.every(r => r.state === (known ? 'observed_failure' : 'unknown')));
    assert.ok(report.results.every(r => r.usage.requests === 1 && r.usage.unknown_requests === (known ? 0 : 1)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
