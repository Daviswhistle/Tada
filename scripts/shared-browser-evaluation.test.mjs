import test from 'node:test';
import assert from 'node:assert/strict';
import { runSharedBrowser, sharedBrowserFixtures } from '../evals/assistant-v1/shared-browser-candidate.mjs';
for (const requestLimit of [0, -1, 49, 1.5]) test(`browser evaluation rejects request ceiling ${requestLimit} before account access`, async () => {
  await assert.rejects(runSharedBrowser({ provider: { inspect() { throw Error('ACCOUNT_MUST_NOT_BE_READ'); } }, requestLimit }), /EVAL_REQUEST_LIMIT_INVALID/);
});
test('freshness environments vary target and account context without prescribing model actions', () => {
  assert.equal(sharedBrowserFixtures.length, 2);
  assert.match(sharedBrowserFixtures[0].before, /해솔/);
  assert.match(sharedBrowserFixtures[0].after, /다른 모임/);
  assert.match(sharedBrowserFixtures[1].before, /내 개인 계정/);
  assert.match(sharedBrowserFixtures[1].after, /공용 운영 계정/);
  for (const fixture of sharedBrowserFixtures) assert.ok(!/observe_shared|fill_shared|A08|정답|평가/u.test(JSON.stringify(fixture)));
});
