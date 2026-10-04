// Specification integrity only. These tests never run or score an assistant.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => JSON.parse(readFileSync(new URL(`../evals/assistant-v1/${name}`, import.meta.url), 'utf8'));
const suite = read('cases.json');
const baseline = read('baseline.json');
const ids = Array.from({ length: 16 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`);
const text = value => assert.ok(typeof value === 'string' && value.trim().length > 0);

test('assistant scenario specification retains its fixed sixteen-case denominator', () => {
  assert.equal(suite.format, 1);
  assert.equal(suite.suite_id, 'assistant-v1');
  assert.equal(suite.kind, 'product_scenario_specification');
  text(suite.notice);
  assert.deepEqual(suite.cases.map(item => item.id), ids);
  assert.equal(new Set(suite.cases.map(item => item.title)).size, ids.length);
});

test('natural user requests contain neither attachments nor evaluator instructions', () => {
  for (const item of suite.cases) {
    text(item.title);
    text(item.family);
    assert.deepEqual(Object.keys(item.user_input).sort(), ['attachments', 'utterance']);
    text(item.user_input.utterance);
    assert.deepEqual(item.user_input.attachments, []);
    assert.ok(item.evaluator_only && typeof item.evaluator_only === 'object');
    for (const key of ['context_setup', 'completion_checks', 'failure_conditions']) {
      assert.ok(Array.isArray(item.evaluator_only[key]) && item.evaluator_only[key].length >= 2);
      item.evaluator_only[key].forEach(text);
    }
    text(item.evaluator_only.question_rule);
  }
});

test('same utterance has distinct contexts including a justified clarification case', () => {
  const cases = ['A02', 'A03', 'A16'].map(id => suite.cases.find(item => item.id === id));
  assert.equal(new Set(cases.map(item => item.user_input.utterance)).size, 1);
  assert.equal(new Set(cases.map(item => JSON.stringify(item.evaluator_only.context_setup))).size, 3);
  assert.equal(cases[0].family, 'situated_repair');
  assert.equal(cases[1].family, 'situated_repair');
  assert.equal(cases[2].family, 'clarification');
  assert.deepEqual(
    suite.cases.find(item => item.id === 'A07').user_input,
    suite.cases.find(item => item.id === 'A13').user_input,
  );
});

test('all nine product requirements retain outcome and boundary coverage', () => {
  const allowed = Array.from({ length: 9 }, (_, index) => `AC-${String(index + 1).padStart(2, '0')}`);
  const covered = new Set();
  for (const item of suite.cases) {
    assert.ok(Array.isArray(item.requirements) && item.requirements.length > 0);
    assert.equal(new Set(item.requirements).size, item.requirements.length);
    for (const requirement of item.requirements) {
      assert.ok(allowed.includes(requirement));
      covered.add(requirement);
    }
  }
  assert.deepEqual([...covered].sort(), allowed);
});

test('historical product baseline is explicitly unrun, never a passing component test', () => {
  assert.equal(baseline.format, 1);
  assert.equal(baseline.suite_id, suite.suite_id);
  assert.equal(baseline.status, 'not_run');
  assert.match(baseline.basis_commit, /^[a-f0-9]{40}$/u);
  text(baseline.note);
  assert.deepEqual(baseline.cases.map(item => item.id), ids);
  for (const item of baseline.cases) {
    assert.equal(item.status, 'not_run');
    assert.deepEqual(item.evidence_refs, []);
  }
  // New evaluated runs belong in separate evidence records, not this baseline.
  assert.equal(Object.hasOwn(baseline, 'success_rate'), false);
});
