import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDiagnostics } from '../../../evals/assistant-v1/model-diagnostics.mjs';

test('fixture model diagnostics preserve detached normalized tool/error records', () => {
  const capture = modelDiagnostics();
  const event = { kind: 'request', recent_tool_results: [{ role: 'tool', content: '{"error":"CONTACT_FOLLOWUP_ID_REUSED"}' }] };
  capture.record(event); event.recent_tool_results[0].content = 'changed';
  const value = capture.snapshot();
  assert.equal(value.events[0].recent_tool_results[0].content, '{"error":"CONTACT_FOLLOWUP_ID_REUSED"}');
  value.events.length = 0; assert.equal(capture.snapshot().events.length, 1);
});

test('fixture model diagnostics explicitly report omitted oversized events without an unbounded log', () => {
  const capture = modelDiagnostics(64);
  capture.record({ kind: 'small' }); capture.record({ text: 'x'.repeat(1000) });
  const value = capture.snapshot();
  assert.equal(value.events.length, 1); assert.equal(value.omitted_events, 1);
  assert.ok(value.captured_bytes <= 64);
  for (const limit of [0, -1, NaN, Infinity, 262145]) assert.throws(() => modelDiagnostics(limit));
});
