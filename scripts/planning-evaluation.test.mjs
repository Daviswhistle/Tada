import test from 'node:test';
import assert from 'node:assert/strict';
import { planningFixtures, runPlanningAcceptance } from '../evals/assistant-v1/connected-planning-candidate.mjs';

test('planning evaluator uses Korean calendar weeks across UTC and year boundaries', () => {
  for (const [instant, monday, sunday, tomorrow] of [
    ['2026-10-04T23:59:59+09:00', '2026-09-28', '2026-10-04', '2026-10-05'],
    ['2026-10-05T00:00:00+09:00', '2026-10-05', '2026-10-11', '2026-10-06'],
    ['2026-10-11T23:59:59+09:00', '2026-10-05', '2026-10-11', '2026-10-12'],
    ['2027-01-01T00:30:00+09:00', '2026-12-28', '2027-01-03', '2027-01-02'],
  ]) {
    const fixtures = planningFixtures(Date.parse(instant));
    assert.equal(fixtures.length, 4);
    for (const fixture of fixtures) {
      assert.equal(fixture.monday, monday); assert.equal(fixture.sunday, sunday); assert.equal(fixture.tomorrow, tomorrow);
      assert.ok(!fixture.ask.includes(fixture.name));
    }
    assert.deepEqual(fixtures.map(f => `${f.case}-${f.variant}`).sort(), ['A13-1', 'A13-2', 'A14-1', 'A14-2']);
  }
});

test('invalid evaluator request ceilings fail before touching the provider', async () => {
  let touched = false;
  const provider = { inspect() { touched = true; throw Error('MUST_NOT_CALL'); } };
  for (const requestLimit of [0, -1, 65, 1.5, '4', NaN]) {
    await assert.rejects(runPlanningAcceptance({ provider, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
  }
  assert.equal(touched, false);
});
