import assert from 'node:assert/strict';
import test from 'node:test';
import { RESEARCH_ENDPOINT, RESEARCH_LIMITS, ResearchFault, researchRequest, decodeResearchResponse, openAIResearchProvider } from '../src/research.ts';
import { MODEL, KEY, responseFixture, httpFixture, latch, tick } from './research-fixtures.mjs';
const body = () => researchRequest(MODEL, 'Test instructions', [{ role: 'user', content: 'Find the relevant sources.' }]);
const signal = () => new AbortController().signal;
const code = name => error => error instanceof ResearchFault && error.code === name;

test('API-key research fixes the endpoint tools limits and stateless request contract', async () => {
  let calls = 0;
  const provider = openAIResearchProvider(KEY, async (url, options) => {
    calls++;
    assert.equal(url, RESEARCH_ENDPOINT);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    const sent = JSON.parse(options.body);
    assert.deepEqual(sent, body());
    assert.equal(sent.stream, false); assert.equal(sent.store, false);
    assert.equal(sent.max_output_tokens, 4096); assert.equal(sent.max_tool_calls, 4);
    assert.deepEqual(sent.tools, [{ type: 'web_search' }]);
    assert.equal(sent.previous_response_id, undefined);
    assert.equal(sent.background, undefined);
    return httpFixture();
  });
  const answer = await provider.exchange(body(), signal());
  assert.equal(answer.parts[0].citations[0].url, 'https://example.org/source');
  assert.equal(answer.searches, 1); assert.equal(answer.usage.totalTokens, 20);
  assert.equal(calls, 1); provider.dispose();
  await assert.rejects(provider.exchange(body(), signal()), code('RESEARCH_INVALID_CONFIG'));
});

test('unsupported request overrides and invalid setup fail before network entry', async () => {
  let calls = 0;
  const provider = openAIResearchProvider(KEY, async () => { calls++; return httpFixture(); });
  for (const changed of [
    { ...body(), tools: [{ type: 'computer_use_preview' }] },
    { ...body(), stream: true }, { ...body(), endpoint: 'https://other.example' },
    { ...body(), max_tool_calls: 100 }, { ...body(), previous_response_id: 'resp_old' },
  ]) await assert.rejects(provider.exchange(changed, signal()), code('RESEARCH_INVALID_CONFIG'));
  assert.equal(calls, 0);
  for (const bad of ['', 'a\nb', 'a'.repeat(4097)]) assert.throws(() => openAIResearchProvider(bad), code('RESEARCH_INVALID_CONFIG'));
  for (const bad of ['', '../model', 'https://model.example', 'x\r\nAuthorization']) assert.throws(() => researchRequest(bad, '', [{}]), code('RESEARCH_INVALID_CONFIG'));
  assert.throws(() => researchRequest(MODEL, '', [{ content: 'x'.repeat(RESEARCH_LIMITS.contextBytes) }]), code('RESEARCH_CONTEXT_LIMIT'));
});

test('opaque output items are preserved in order but never interpreted as tool permission', () => {
  const response = responseFixture();
  const answer = decodeResearchResponse(JSON.stringify(response), MODEL);
  assert.deepEqual(answer.continuation, response.output);
  assert.equal(answer.parts.length, 1);
  assert.equal(JSON.stringify(answer.parts).includes('OPAQUE_FAKE'), false);
  assert.equal(answer.sources.length, 1);
});

test('only final or legacy assistant text is displayed; commentary remains private continuation', () => {
  const response = responseFixture();
  response.output.splice(1, 0, { id: 'comment', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'NOT_THE_FINAL_RESULT', annotations: [] }] });
  response.output.at(-1).phase = 'final_answer';
  const answer = decodeResearchResponse(JSON.stringify(response), MODEL);
  assert.equal(answer.parts.length, 1);
  assert.equal(answer.continuation.length, 4);
  assert.equal(answer.parts[0].text.includes('NOT_THE_FINAL_RESULT'), false);
});

test('sixteen fixed malformed or unsupported output cases release no accepted answer', () => {
  const variants = [
    r => { r.status = 'incomplete'; },
    r => { r.output.push({ id: 'function', type: 'function_call', name: 'delete', arguments: '{}' }); },
    r => { r.output[1].status = 'failed'; },
    r => { r.output[1].action.type = 'execute'; },
    r => { r.output[2].content[0].annotations = []; },
    r => { r.output[2].role = 'developer'; },
    r => { r.output[2].content[0].annotations[0].url = 'javascript:alert(1)'; },
    r => { r.output[2].content[0].annotations[0].url = 'https://name:password@example.org/'; },
    r => { r.output[2].content[0].annotations[0].end_index = 999; },
    r => { r.output[2].content[0].annotations[0].start_index = -1; },
    r => { r.output[2].content[0].annotations[0].type = 'file_citation'; },
    r => { r.output[0].encrypted_content = null; },
    r => { r.output[2].id = r.output[0].id; },
    r => { r.usage.total_tokens = 19; },
    r => { r.output[2].phase = 'unknown_phase'; },
    r => { r.output = []; },
  ];
  assert.equal(variants.length, 16);
  for (const change of variants) {
    const response = responseFixture(); change(response);
    assert.throws(() => decodeResearchResponse(JSON.stringify(response), MODEL), ResearchFault);
  }
  for (const raw of ['{}', '{"id":"a","id":"b"}', JSON.stringify(responseFixture()).slice(0, -1), `${JSON.stringify(responseFixture())} {}`]) {
    assert.throws(() => decodeResearchResponse(raw, MODEL), ResearchFault);
  }
});

test('refusal and no-search conversational responses do not fabricate search citations', () => {
  const ordinary = decodeResearchResponse(JSON.stringify(responseFixture({ searched: false })), MODEL);
  assert.equal(ordinary.kind, 'answer'); assert.equal(ordinary.searches, 0);
  const refusal = responseFixture();
  refusal.output[2].content = [{ type: 'refusal', refusal: 'I cannot make that transaction.' }];
  const answer = decodeResearchResponse(JSON.stringify(refusal), MODEL);
  assert.equal(answer.kind, 'refusal'); assert.equal(answer.parts[0].citations.length, 0);
});

test('search open-page and find actions contribute sources without client-side URL fetching', () => {
  const response = responseFixture();
  response.output.splice(2, 0,
    { id: 'open', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.org/source' } },
    { id: 'find', type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', pattern: 'sample', url: 'https://example.org/source' } },
  );
  const answer = decodeResearchResponse(JSON.stringify(response), MODEL);
  assert.equal(answer.searches, 3); assert.equal(answer.sources.length, 1);
});

test('valid observed usage survives incomplete or rejected response classification', async () => {
  const response = responseFixture(); response.status = 'incomplete';
  const provider = openAIResearchProvider(KEY, async () => httpFixture(response));
  await assert.rejects(provider.exchange(body(), signal()), error => {
    assert.equal(error.code, 'RESEARCH_INCOMPLETE'); assert.equal(error.usage.totalTokens, 20);
    assert.equal(error.responseId, 'resp_test'); return true;
  });
});

test('HTTP and network failures are classified once without raw body or secret leakage', async () => {
  for (const [status, expected] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'CAPACITY'], [400, 'REQUEST'], [500, 'SERVER']]) {
    let calls = 0;
    const provider = openAIResearchProvider(KEY, async () => { calls++; return new Response(`PRIVATE_BODY_${KEY}`, { status }); });
    await assert.rejects(provider.exchange(body(), signal()), error => {
      assert.equal(error.code, `RESEARCH_HTTP_${expected}`); assert.equal(error.usage, null);
      assert.equal(String(error).includes(KEY), false); assert.equal(JSON.stringify(error).includes('PRIVATE_BODY'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
  const provider = openAIResearchProvider(KEY, async () => { throw new Error(`secret=${KEY}`); });
  await assert.rejects(provider.exchange(body(), signal()), code('RESEARCH_TRANSPORT'));
});

test('JSON must reach actual EOF before an answer can be accepted', async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(JSON.stringify(responseFixture()))); } });
  const provider = openAIResearchProvider(KEY, async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
  let settled = false;
  const answer = provider.exchange(body(), signal()).finally(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  controller.close(); assert.equal((await answer).responseId, 'resp_test');
});

test('body bytes and UTF-8 are bounded independently of content-length', async () => {
  for (const response of [
    new Response('a', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': `${RESEARCH_LIMITS.responseBytes + 1}` } }),
    new Response(new Uint8Array(RESEARCH_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const provider = openAIResearchProvider(KEY, async () => response);
    await assert.rejects(provider.exchange(body(), signal()), ResearchFault);
  }
});

test('already cancelled operation enters no fetch; concurrent exchange is denied', async () => {
  let calls = 0;
  const ready = latch();
  const provider = openAIResearchProvider(KEY, async () => { calls++; return ready.promise; });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(provider.exchange(body(), cancelled.signal), code('RESEARCH_CANCELLED'));
  assert.equal(calls, 0);
  const first = provider.exchange(body(), signal());
  await assert.rejects(provider.exchange(body(), signal()), code('RESEARCH_INVALID_CONFIG'));
  ready.resolve(httpFixture()); await first; assert.equal(calls, 1);
});

test('cancelled body is closed; unconfirmed cleanup makes the adapter unusable', async () => {
  for (const confirm of [true, false]) {
    const entered = latch(); let cancellations = 0;
    const stream = new ReadableStream({ start() { entered.resolve(); }, cancel() { cancellations++; return confirm ? undefined : new Promise(() => {}); } });
    const provider = openAIResearchProvider(KEY, async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const abort = new AbortController();
    const pending = provider.exchange(body(), abort.signal);
    await entered.promise; await tick(); abort.abort();
    await assert.rejects(pending, error => { assert.equal(error.code, 'RESEARCH_CANCELLED'); assert.equal(error.cleanupConfirmed, confirm); return true; });
    assert.equal(cancellations, 1);
    if (!confirm) await assert.rejects(provider.exchange(body(), signal()), code('RESEARCH_INVALID_CONFIG'));
  }
});

test('late fetch response is cleaned up and a late rejection is always observed', async () => {
  for (const reject of [true, false]) {
    const ready = latch(); let cancellations = 0;
    const abort = new AbortController();
    const provider = openAIResearchProvider(KEY, () => { abort.abort(); return ready.promise; });
    const pending = provider.exchange(body(), abort.signal);
    await assert.rejects(pending, error => { assert.equal(error.code, 'RESEARCH_CANCELLED'); assert.equal(error.cleanupConfirmed, false); return true; });
    if (reject) ready.reject(new Error('LATE_PRIVATE_CANARY'));
    else ready.resolve(new Response(new ReadableStream({ cancel() { cancellations++; } })));
    await tick(); await tick();
    assert.equal(cancellations, reject ? 0 : 1);
    await assert.rejects(provider.exchange(body(), signal()), code('RESEARCH_INVALID_CONFIG'));
  }
});

test('disposing a provider aborts its active HTTP body instead of silently leaving it running', async () => {
  let cancelled = false;
  const provider = openAIResearchProvider(KEY, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
  const pending = provider.exchange(body(), signal());
  await tick(); provider.dispose();
  await assert.rejects(pending, code('RESEARCH_CANCELLED')); assert.equal(cancelled, true);
});
