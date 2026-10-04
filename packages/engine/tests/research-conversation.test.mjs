import assert from 'node:assert/strict';
import test from 'node:test';
import { Conversation } from '../src/research-conversation.ts';
import { RESEARCH_LIMITS, ResearchFault, decodeResearchResponse, openAIResearchProvider } from '../../providers/src/research.ts';
import { MODEL, KEY, responseFixture, httpFixture, latch, tick } from '../../providers/tests/research-fixtures.mjs';
const signal = () => new AbortController().signal;
function fixtureSession() {
  const requests = [];
  const provider = openAIResearchProvider(KEY, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return httpFixture(responseFixture({ id: `resp_${requests.length}` }));
  });
  return { session: new Conversation(MODEL, provider), requests };
}

test('ordinary conversation needs no task contract file path attachments or source list', async () => {
  const { session, requests } = fixtureSession();
  const text = '자료는 따로 없어. 그 서비스가 어떤지 알아봐.';
  const answer = await session.ask(text, signal());
  assert.deepEqual(requests[0].input, [{ role: 'user', content: text }]);
  assert.equal(requests[0].input[0].TaskContract, undefined);
  assert.equal(answer.parts[0].text, 'A sourced answer.');
  assert.equal(Object.hasOwn(answer, 'continuation'), false);
  assert.equal(JSON.stringify(session.status()).includes('OPAQUE_FAKE'), false);
  assert.equal(session.status().persistent, false);
});

test('follow-up includes actual prior user and all provider output items in order', async () => {
  const { session, requests } = fixtureSession();
  await session.ask('오늘은 회사 A를 보고 있어.', signal());
  await session.ask('아까 답변을 좀 더 쉽게 고쳐줘.', signal());
  assert.deepEqual(requests[1].input, [
    { role: 'user', content: '오늘은 회사 A를 보고 있어.' },
    ...responseFixture({ id: 'resp_1' }).output,
    { role: 'user', content: '아까 답변을 좀 더 쉽게 고쳐줘.' },
  ]);
  assert.equal(requests[1].previous_response_id, undefined);
  assert.equal(requests[1].input[1].encrypted_content, 'OPAQUE_FAKE_CONTINUATION_NOT_A_SECRET');
});

test('identical vague words retain different supplied conversation context rather than selecting a phrase script', async () => {
  const a = fixtureSession(), b = fixtureSession();
  await a.session.ask('파일이 열리지 않는 상황을 이야기하고 있어.', signal());
  await b.session.ask('웹페이지 업로드를 이야기하고 있어.', signal());
  await a.session.ask('이거 안 돼.', signal());
  await b.session.ask('이거 안 돼.', signal());
  assert.notDeepEqual(a.requests[1].input, b.requests[1].input);
  assert.deepEqual(a.requests[1].input.at(-1), b.requests[1].input.at(-1));
  // Forwarding context is proven here, not actual semantic understanding/repair.
  assert.match(a.requests[1].instructions, /cannot currently see the user's screen/u);
});

test('user corrections and returned answers cannot mutate the retained conversation by alias', async () => {
  const { session, requests } = fixtureSession();
  const first = await session.ask('회사 A를 조사해줘.', signal());
  first.parts[0].text = 'MUTATED_OUTSIDE';
  session.latestAnswer.parts[0].text = 'SECOND_ALIAS';
  await session.ask('아니, 회사 B야.', signal());
  assert.equal(requests[1].input.at(-1).content, '아니, 회사 B야.');
  assert.equal(JSON.stringify(requests[1]).includes('MUTATED_OUTSIDE'), false);
  assert.equal(JSON.stringify(requests[1]).includes('SECOND_ALIAS'), false);
  const status = session.status(); status.attempts[0].usage.totalTokens = 999;
  assert.equal(session.status().observedTokens, 40);
});

test('clearing context does not refill eight attempted requests or erase observations', async () => {
  const { session, requests } = fixtureSession();
  for (let i = 0; i < RESEARCH_LIMITS.requests; i++) {
    await session.ask(`요청 ${i}`, signal());
    session.clearConversation();
  }
  assert.equal(session.latestAnswer, null);
  assert.equal(session.status().requests, 8); assert.equal(session.status().observedTokens, 160);
  assert.equal(session.status().remainingRequests, 0);
  await assert.rejects(session.ask('한 번 더', signal()), /CONVERSATION_REQUEST_LIMIT/u);
  assert.equal(requests.length, 8);
  assert.ok(requests.every(r => r.input.length === 1));
});

test('failed requests are not retried; clearing history cannot bypass explicit uncertain-cost acknowledgement', async () => {
  let calls = 0;
  const session = new Conversation(MODEL, openAIResearchProvider(KEY, async () => {
    calls++;
    if (calls === 1) throw new Error('PRIVATE_ERROR');
    return httpFixture();
  }));
  await assert.rejects(session.ask('조사해줘.', signal()), /RESEARCH_TRANSPORT/u);
  assert.equal(calls, 1); assert.equal(session.status().uncertainUsageRequests, 1);
  session.clearConversation();
  await assert.rejects(session.ask('계속해.', signal()), /ACKNOWLEDGEMENT_REQUIRED/u);
  assert.equal(calls, 1);
  session.acknowledgeFailure();
  await session.ask('이번에는 이 주제로 조사해.', signal());
  assert.equal(calls, 2); assert.equal(session.status().requests, 2);
  assert.equal(session.status().uncertainUsageRequests, 1);
});

test('incomplete response preserves known usage without becoming the last answer', async () => {
  const incomplete = responseFixture(); incomplete.status = 'incomplete';
  const session = new Conversation(MODEL, openAIResearchProvider(KEY, async () => httpFixture(incomplete)));
  await assert.rejects(session.ask('조사해줘.', signal()), /RESEARCH_INCOMPLETE/u);
  assert.equal(session.latestAnswer, null);
  assert.equal(session.status().observedTokens, 20); assert.equal(session.status().uncertainUsageRequests, 0);
  assert.equal(session.requiresAcknowledgement, true);
});

test('cancellation just before answer acceptance retains usage but no final answer', async () => {
  const abort = new AbortController();
  const session = new Conversation(MODEL, {
    dispose() {},
    async exchange() { abort.abort(); return decodeResearchResponse(JSON.stringify(responseFixture()), MODEL); },
  });
  await assert.rejects(session.ask('조사해줘.', abort.signal), /RESEARCH_CANCELLED/u);
  assert.equal(session.latestAnswer, null); assert.equal(session.status().observedTokens, 20);
  assert.equal(session.status().attempts[0].state, 'stopped');
});

test('pre-cancellation invalid input and context exhaustion do not consume another request', async () => {
  const { session, requests } = fixtureSession();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(session.ask('조사', abort.signal), /RESEARCH_CANCELLED/u);
  for (const bad of ['', ' '.repeat(8), '한'.repeat(6000)]) await assert.rejects(session.ask(bad, signal()), /CONVERSATION_INVALID_INPUT/u);
  assert.equal(session.status().requests, 0); assert.equal(requests.length, 0);
  const huge = responseFixture(); huge.output[0].encrypted_content = 'x'.repeat(RESEARCH_LIMITS.contextBytes);
  let calls = 0;
  const full = new Conversation(MODEL, openAIResearchProvider(KEY, async () => { calls++; return httpFixture(huge); }));
  await full.ask('먼저 조사', signal());
  await assert.rejects(full.ask('계속', signal()), /RESEARCH_CONTEXT_LIMIT/u);
  assert.equal(calls, 1); assert.equal(full.status().requests, 1);
});

test('concurrent prompts and context clear are blocked while a request is active', async () => {
  const ready = latch();
  const session = new Conversation(MODEL, openAIResearchProvider(KEY, () => ready.promise));
  const first = session.ask('먼저', signal());
  await assert.rejects(session.ask('두 번째', signal()), /CONVERSATION_UNAVAILABLE/u);
  assert.throws(() => session.clearConversation(), /CONVERSATION_UNAVAILABLE/u);
  ready.resolve(httpFixture()); await first;
  assert.equal(session.status().requests, 1);
});

test('unknown producer cleanup cannot be acknowledged into another paid request', async () => {
  const ready = latch(); const abort = new AbortController();
  const session = new Conversation(MODEL, openAIResearchProvider(KEY, () => ready.promise));
  const pending = session.ask('먼저', abort.signal); abort.abort();
  await assert.rejects(pending, /RESEARCH_CANCELLED/u);
  assert.equal(session.status().cleanupConfirmed, false);
  assert.throws(() => session.acknowledgeFailure(), /CONVERSATION_UNAVAILABLE/u);
  ready.resolve(httpFixture()); await tick();
});

test('disposal clears visible answer and prevents a late completion from restoring history', async () => {
  const ready = latch(); let disposed = false;
  const session = new Conversation(MODEL, { exchange: () => ready.promise, dispose() { disposed = true; } });
  const pending = session.ask('조사', signal()); session.dispose();
  ready.resolve(decodeResearchResponse(JSON.stringify(responseFixture()), MODEL));
  await assert.rejects(pending, /RESEARCH_CANCELLED/u);
  assert.equal(session.latestAnswer, null); assert.equal(disposed, true);
  await assert.rejects(session.ask('계속', signal()), /CONVERSATION_UNAVAILABLE/u);
});
