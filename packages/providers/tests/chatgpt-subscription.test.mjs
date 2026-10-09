import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTSubscription, responsesInput } from '../src/chatgpt-subscription.mjs';
import { ContactStore, contactRoute } from '../../engine/src/contact-store.mjs';
import { ConversationAssistant } from '../../engine/src/conversation.ts';
import { ContactService } from '../../engine/src/contact-service.mjs';
import { NativeSources, discoveryTools, validCall } from '../../engine/src/native-sources.mjs';
import { contactOptions } from '../../engine/src/contact-cli.mjs';
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const call = (name, args, overrides = {}) => ({ type: 'function_call', namespace: 'tada', name, arguments: JSON.stringify(args), status: 'completed', call_id: `fake-call-${randomUUID()}`, ...overrides });
const completed = output => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 12, output_tokens: 8 } } });
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const tool = { type: 'function', function: { name: 'list_sources', description: 'List permitted sources', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };
async function serverFixture(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer synthetic-fixture-access');
    assert.equal(req.headers.accept, 'text/event-stream');
    handler(body, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const account = { profile: { client: 'fixture-client', subject: 'fixture-subject', email: 'fixture@example.invalid' },
    models: async () => [{ slug: 'fixture-model', display_name: 'Fixture Model' }], accessToken: async () => 'synthetic-fixture-access' };
  const fetcher = (url, options) => { assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error'); return fetch(`http://127.0.0.1:${server.address().port}`, options); };
  const provider = new ChatGPTSubscription({ account, model: 'fixture-model', fetcher }); await provider.inspect();
  return { provider, account, requests, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function stream(res, events, contentType = 'text/event-stream') {
  res.writeHead(200, contentType === null ? {} : { 'content-type': contentType }); res.end(events.map(frame).join(''));
}

test('subscription is the explicit default, local compatibility requires a named local provider', () => {
  assert.equal(contactOptions(['--data', 'fixture']).provider, 'chatgpt');
  assert.equal(contactOptions(['--data', 'fixture', '--provider', 'ollama', '--model', 'm']).endpoint, 'http://127.0.0.1:11434');
  for (const args of [['--endpoint', 'http://attacker.invalid'], ['--provider', 'unknown'], ['--provider', 'ollama'], ['--login', '--logout']]) assert.throws(() => contactOptions(['--data', 'fixture', ...args]));
});

test('complete subscription response uses the public protocol and discards private reasoning', async () => {
  const env = await serverFixture((body, res) => stream(res, [completed([{ type: 'reasoning', summary: [{ text: 'private fixture reasoning' }] }, message('안녕하세요.')])]));
  try {
    let admitted = 0;
    const result = await env.provider.chat([{ role: 'system', content: 'host rules' }, { role: 'user', content: '안녕' }], [], new AbortController().signal, () => { admitted++; });
    assert.equal(admitted, 1);
    assert.equal(result.message.content, '안녕하세요.'); assert.equal(result.input_tokens, 12);
    const body = env.requests[0]; assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'store', 'stream']);
    assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.input[0].role, 'developer');
  } finally { await env.close(); }
});

test('missing Content-Type accepts a fully completed SSE response with normal field framing', async () => {
  const env = await serverFixture((_body, res) => {
    res.writeHead(200);
    res.end(': synthetic comment\r\nretry: 1000\r\nid: fixture\r\nevent: response.completed\r\n'
      + frame(completed([message('검증된 합성 답변입니다.')])).replace(/\n/gu, '\r\n'));
  });
  try {
    const result = await env.provider.chat([{ role: 'user', content: 'synthetic request' }], [], new AbortController().signal);
    assert.equal(result.message.content, '검증된 합성 답변입니다.');
    assert.equal(result.input_tokens, 12); assert.equal(result.output_tokens, 8); assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

for (const contentType of ['application/json', 'text/html', '', 'text/event-stream-malicious']) test(`explicit non-SSE MIME ${JSON.stringify(contentType)} rejects even completed SSE and never retries`, async () => {
  const env = await serverFixture((_body, res) => stream(res, [completed([message('must not escape')])], contentType));
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'synthetic request' }], [], new AbortController().signal), /CHATGPT_STREAM_REQUIRED/);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

for (const [name, body, expected] of [
  ['JSON response', JSON.stringify(completed([message('must not escape')]).response), 'CHATGPT_STREAM_INCOMPLETE'],
  ['HTML response', '<html><body>must not escape</body></html>', 'CHATGPT_STREAM_INCOMPLETE'],
  ['JSON wrapper with injected SSE', '{"wrapped":"\n' + frame(completed([message('must not escape')])) + '"}\n\n', 'CHATGPT_STREAM_INVALID'],
  ['HTML wrapper with injected SSE', '<html>\n' + frame(completed([message('must not escape')])) + '</html>\n\n', 'CHATGPT_STREAM_INVALID'],
  ['truncated frame', frame(completed([message('must not escape')])).slice(0, -1), 'CHATGPT_STREAM_INCOMPLETE'],
  ['missing completion', frame({ type: 'response.output_text.delta', delta: 'partial' }), 'CHATGPT_INCOMPLETE_TURN'],
  ['incomplete turn', frame({ type: 'response.incomplete' }), 'CHATGPT_INCOMPLETE_TURN'],
  ['late failure', frame({ type: 'response.output_text.delta', delta: 'partial' }) + frame({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }), 'CHATGPT_USAGE_LIMIT'],
  ['failure after completion', frame(completed([message('must not escape')])) + frame({ type: 'response.failed' }), 'CHATGPT_STREAM_AFTER_COMPLETION'],
  ['wrong tool', frame(completed([call('send_money', {})])), 'CHATGPT_TOOL_CALL_INVALID'],
  ['wrong namespace', frame(completed([call('list_sources', {}, { namespace: 'attacker' })])), 'CHATGPT_TOOL_CALL_INVALID'],
  ['event limit', frame({ type: 'response.output_text.delta', delta: '' }).repeat(4097), 'CHATGPT_RESPONSE_LIMIT'],
  ['byte limit', ':' + 'x'.repeat(1048576) + '\n\n' + frame(completed([message('must not escape')])), 'CHATGPT_RESPONSE_LIMIT'],
]) test(`missing Content-Type ${name} releases no answer or tool and never retries`, async () => {
  const env = await serverFixture((_body, res) => { res.writeHead(200); res.end(body); });
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'synthetic request' }], [tool], new AbortController().signal), error => error.message === expected);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

test('missing Content-Type and absent HTTP body return a defined stream error without retry', async () => {
  const env = await serverFixture((_body, res) => { res.writeHead(204); res.end(); });
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'synthetic request' }], [], new AbortController().signal), /CHATGPT_STREAM_INCOMPLETE/);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

test('tool batches use namespace and paired durable function outputs on the next request', async () => {
  const env = await serverFixture((_body, res) => stream(res, [completed([call('list_sources', {})])]));
  try {
    const reply = await env.provider.chat([{ role: 'user', content: '자료 찾아줘' }], [tool], new AbortController().signal);
    assert.deepEqual(reply.message.tool_calls, [{ function: { name: 'list_sources', arguments: {} } }]);
    assert.equal(env.requests[0].tools[0].type, 'namespace');
    const history = [{ role: 'user', content: '자료 찾아줘' }, reply.message, { role: 'tool', tool_name: 'list_sources', content: '{"sources":[]}' }];
    await env.provider.chat(history, [tool], new AbortController().signal);
    const items = env.requests[1].input;
    assert.equal(items[1].namespace, 'tada'); assert.equal(items[1].call_id, items[2].call_id); assert.equal(items[2].type, 'function_call_output');
    assert.deepEqual(responsesInput(history), items); // Restart reconstructs the same complete pairs.
    assert.throws(() => responsesInput(history.slice(0, -1)), /HISTORY_INVALID/);
  } finally { await env.close(); }
});

for (const [name, events] of [
  ['late failure', [{ type: 'response.output_text.delta', delta: 'looks successful' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]],
  ['missing completion', [{ type: 'response.output_text.delta', delta: 'partial' }]],
  ['incomplete', [{ type: 'response.incomplete' }]],
  ['failure after completion', [completed([message('discard me')]), { type: 'response.failed' }]],
  ['duplicate completion', [completed([message('discard me')]), completed([message('discard me')])]],
  ['wrong namespace', [completed([call('list_sources', {}, { namespace: 'attacker' })])]],
  ['unknown tool', [completed([call('send_money', {})])]],
  ['duplicate JSON arguments', [completed([call('list_sources', {}, { arguments: '{"x":1,"x":2}' })])]],
]) test(`${name} cannot release an answer or tool and never retries`, async () => {
  const env = await serverFixture((_body, res) => stream(res, events));
  try { await assert.rejects(env.provider.chat([{ role: 'user', content: 'hello' }], [tool], new AbortController().signal), /CHATGPT_/); assert.equal(env.requests.length, 1); }
  finally { await env.close(); }
});

test('a cancelled stream closes and preserves no partial answer', async () => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const env = await serverFixture((_body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame({ type: 'response.output_text.delta', delta: 'partial' })); began(); });
  try {
    const abort = new AbortController(), pending = env.provider.chat([{ role: 'user', content: 'hello' }], [], abort.signal);
    await started; abort.abort(); await assert.rejects(pending, /ASSISTANT_CANCELLED/); assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

test('HTTP redirects cannot forward credentials to another destination', async () => {
  const env = await serverFixture((_body, res) => { res.writeHead(302, { Location: 'https://attacker.invalid' }); res.end(); });
  try { await assert.rejects(env.provider.chat([{ role: 'user', content: 'hello' }], [], new AbortController().signal), /CHATGPT_NETWORK_FAILED/); assert.equal(env.requests.length, 1); }
  finally { await env.close(); }
});

for (const contentType of ['text/event-stream', null]) test(`same contact conversation with ${contentType === null ? 'missing' : 'declared'} Content-Type executes source tools, survives restart across devices and rejects remote review grants`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-subscription-contact-')), notes = join(root, 'notes'), directory = join(root, 'journal');
  mkdirSync(notes); writeFileSync(join(notes, 'update.txt'), '미루 출시: 11월 2일. 남은 일: 계약 검토.');
  let phase = 0;
  const env = await serverFixture((body, res) => {
    assert.equal(body.store, false);
    assert.ok(body.input[0].content.includes('Per-task LOCAL FILE reviews are unavailable'));
    assert.equal(body.input[0].content.includes('separately authorize one read-only local review'), false);
    const outputs = body.input.filter(item => item.type === 'function_call_output');
    let output;
    if (phase === 0) output = call('list_sources', {});
    if (phase === 1) { const source = JSON.parse(outputs.at(-1).output).sources[0]; output = call('list_files', { source: source.source, directory: '.' }); }
    if (phase === 2) { const listing = JSON.parse(outputs.at(-1).output); output = call('read_file', { source: listing.source, path: 'update.txt' }); }
    if (phase === 3) output = message('미루 출시는 11월 2일이고, 남은 일은 계약 검토입니다. [S1]');
    if (phase === 4) {
      assert.ok(body.input.some(item => item.role === 'user' && item.content.includes('미루')));
      assert.ok(outputs.some(item => item.output.includes('계약 검토')));
      output = message('앞서 확인한 남은 일은 계약 검토입니다. [S1]');
    }
    phase++; stream(res, [completed([{ type: 'reasoning', id: `rs_fixture_${phase}`, encrypted_content: `opaque-encrypted-fixture-${phase}${'x'.repeat(5000)}`, summary: [{ type: 'summary_text', text: 'private summary fixture' }] }, output])], contentType);
  });
  const passphrase = 'synthetic contact encryption passphrase', route = contactRoute({ provider: env.provider.identity });
  let store, service;
  try {
    const sources = process.env.TADA_TEST_READ_BROKER ? new NativeSources(process.env.TADA_TEST_READ_BROKER, [notes]) : {
      definitions: discoveryTools,
      validate: (name, args) => validCall(name, args) && (name === 'list_sources' || args.source === 's1'),
      async execute(name) {
        if (name === 'list_sources') return { sources: [{ source: 's1', label: 'fixture notes' }] };
        if (name === 'list_files') return { source: 's1', files: ['update.txt'] };
        const content = readFileSync(join(notes, 'update.txt'), 'utf8');
        return { source: 's1', path: 'update.txt', content, sha256: createHash('sha256').update(content).digest('hex'), observed_at: new Date().toISOString() };
      },
      async verify(evidence) { return evidence.sha256 === (await this.execute('read_file')).sha256; },
    };
    if (sources.initialize) await sources.initialize(new AbortController().signal);
    store = new ContactStore({ directory, passphrase, route, initialize: true, reviews: true });
    const first = store.addDevice('fixture phone'), second = store.addDevice('fixture laptop');
    service = new ContactService(store, env.provider, sources);
    assert.equal(service.localReviews, false);
    assert.throws(() => service.armReview(first.id, randomUUID(), 1, 'one_local_read_only_review'), /LOCAL_PROVIDER_REQUIRED/);
    const accepted = service.submit(first.id, randomUUID(), '미루 출시 상황과 다음 할 일을 확인해줘.'); await service.idle();
    assert.equal(store.turn(accepted.seq).state, 'answered', JSON.stringify(store.turn(accepted.seq)));
    assert.equal(store.checkpoint().value.version, 2);
    const oldEnvelope = { ...store.checkpoint().value, version: 1 };
    assert.throws(() => new ConversationAssistant(env.provider, sources).restore(oldEnvelope), /ASSISTANT_CHECKPOINT_INVALID/);
    assert.ok(JSON.stringify(store.checkpoint()).includes('opaque-encrypted-fixture'));
    assert.equal(JSON.stringify(store.page()).includes('opaque-encrypted-fixture'), false);
    assert.equal(JSON.stringify(store.checkpoint()).includes('private summary fixture'), false);
    assert.ok(env.requests[1].input.some(item => item.type === 'reasoning' && item.encrypted_content === `opaque-encrypted-fixture-1${'x'.repeat(5000)}`));
    assert.equal(env.requests[1].input.find(item => item.type === 'function_call').call_id, env.requests[1].input.find(item => item.type === 'function_call_output').call_id);
    assert.ok(store.page().turns.some(turn => turn.answer?.text.includes('11월 2일')));
    await service.close(); store.close();
    store = new ContactStore({ directory, passphrase, route }); service = new ContactService(store, env.provider, sources);
    const followup = service.submit(second.id, randomUUID(), '남은 일이 뭐였지?'); await service.idle();
    assert.equal(store.turn(followup.seq).state, 'answered'); assert.equal(phase, 5); assert.equal(store.usage().requests, 5);
    const wireSizes = env.requests.map(request => Buffer.byteLength(JSON.stringify(request)));
    assert.ok(wireSizes.some(bytes => bytes > 14000), 'native continuation must survive the old preview cap');
    assert.ok(wireSizes.every(bytes => bytes <= 65536), 'full subscription requests stay bounded');
    await service.close(); store.close();
    assert.throws(() => new ContactStore({ directory, passphrase, route: contactRoute({ account: 'different' }) }), /CONTACT_ROUTE_CHANGED/);
  } finally { await service?.close(); store?.close(); await env.close(); rmSync(root, { recursive: true, force: true }); }
});


test('completed refusals remain visible answers with known usage', async () => {
  const env = await serverFixture((_body, res) => stream(res, [completed([{ type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'refusal', refusal: '그 요청은 도와드릴 수 없습니다.' }] }])]));
  try {
    const result = await env.provider.chat([{ role: 'user', content: 'fixture' }], [], new AbortController().signal);
    assert.equal(result.message.content, '그 요청은 도와드릴 수 없습니다.'); assert.equal(result.output_tokens, 8);
    assert.equal(responsesInput([result.message])[0].phase, 'final_answer');
  } finally { await env.close(); }
});

test('temporary usage checks are distinct from quota exhaustion and never auto-retried', async () => {
  const env = await serverFixture((_body, res) => stream(res, [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable' } } }]));
  try { await assert.rejects(env.provider.chat([{ role: 'user', content: 'fixture' }], [], new AbortController().signal), /CHATGPT_USAGE_UNAVAILABLE/); assert.equal(env.requests.length, 1); }
  finally { await env.close(); }
});

for (const event of [
  { type: 'response.failed', response: { error: { code: 'server_error', type: 'server_error', message: 'PRIVATE_FIXTURE_INPUT' } } },
  { type: 'error', error: { code: 'subscription_sharing_usage_limit_exceeded', type: 'rate_limit_error', param: 'model', message: 'PRIVATE_FIXTURE_INPUT' } },
  { type: 'error', code: null, type_ignored: 'PRIVATE_FIXTURE_INPUT', message: 'PRIVATE_FIXTURE_INPUT' },
  { type: 'response.failed' },
]) test(`stream failure retains bounded structure: ${JSON.stringify(event).slice(0, 90)}`, async () => {
  const env = await serverFixture((_body, res) => stream(res, [event]));
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'fixture' }], [], new AbortController().signal), error => {
      const detail = event.response?.error ?? event.error ?? (event.type === 'error' ? event : undefined);
      assert.equal(error.code, detail?.code ?? undefined);
      assert.equal(error.param, detail?.param);
      assert.equal(error.event_type, event.type);
      assert.equal(error.error_shape, detail ? 'object' : 'absent');
      assert.equal(error.error_type, ['server_error', 'rate_limit_error'].includes(detail?.type) ? detail.type : undefined);
      assert.equal(JSON.stringify(error).includes('PRIVATE_FIXTURE_INPUT'), false);
      return true;
    });
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});


for (const [status, errorBody, expected, shape] of [
  [503, { error: { code: 'subscription_sharing_usage_unavailable', message: 'private fixture diagnostic' } }, 'CHATGPT_USAGE_UNAVAILABLE', 'error_object'],
  [400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0].type' } }, 'CHATGPT_CAPABILITY_UNAVAILABLE', 'error_object'],
  [403, { error: { code: 'subscription_sharing_user_not_eligible' } }, 'CHATGPT_PLAN_UNAVAILABLE', 'error_object'],
  [503, { detail: 'private fixture diagnostic' }, 'CHATGPT_TEMPORARILY_UNAVAILABLE', 'detail'],
]) test(`pre-stream HTTP ${status} ${expected} keeps safe diagnostics and never retries`, async () => {
  const env = await serverFixture((_body, res) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_fixture' }); res.end(JSON.stringify(errorBody)); });
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'fixture' }], [], new AbortController().signal), error => {
      assert.equal(error.message, expected); assert.equal(error.status, status); assert.equal(error.body_shape, shape); assert.equal(error.request_id, 'req_fixture');
      assert.equal(error.code, errorBody.error?.code); assert.equal(error.param, errorBody.error?.param);
      assert.equal(JSON.stringify(error).includes('private fixture diagnostic'), false); return true;
    });
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

for (const body of ['x'.repeat(4096), '"x"'.repeat(1300)]) test(`subscription document revision budgets actual request, including escaping=${body.includes('"')}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-sub-documents-'));
  let store, service;
  const steps = [
    [call('prepare_document', { title: 'Full note', format: 'text', based_on: null })], [message(body)],
    [call('list_documents', { before: null })], [call('read_document', { id: 1 })],
    [call('prepare_document', { title: 'Short note', format: 'text', based_on: 1 })], [message('Shortened note')],
  ];
  const f = await serverFixture((_body, res) => { const output = steps.shift(); assert.ok(output); stream(res, [completed(output)]); });
  const measured = [], originalSize = f.provider.contextBytes.bind(f.provider), originalChat = f.provider.chat.bind(f.provider);
  // Source admission also measures prospective messages without inference.
  // Compare only actual chat requests with the bytes sent to the HTTP fixture.
  f.provider.chat = (messages, tools, signal) => { measured.push(originalSize(messages, tools)); return originalChat(messages, tools, signal); };
  try {
    store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'synthetic document subscription passphrase', route: contactRoute({ fixture: 'subscription-documents' }), initialize: true, reviews: true });
    const sources = { definitions: discoveryTools, validate: validCall, execute: async () => { throw Error('NO_SOURCE_READ_EXPECTED'); }, verify: async () => true };
    service = new ContactService(store, f.provider, sources, { timezone: 'Asia/Seoul' });
    const device = store.addDevice('Browser');
    service.submit(device.id, randomUUID(), 'Create a note'); await service.idle(); assert.equal(store.document(1)?.content, body, store.turn(1).error);
    await service.close(); store.close();
    store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'synthetic document subscription passphrase', route: contactRoute({ fixture: 'subscription-documents' }) });
    service = new ContactService(store, f.provider, sources, { timezone: 'Asia/Seoul' });
    service.submit(device.id, randomUUID(), 'Shorten the previous document'); await service.idle();
    assert.equal(store.document(2)?.content, 'Shortened note', `${store.turn(2).error}: ${measured.join(',')}`);
    assert.equal(steps.length, 0); assert.equal(f.requests.length, 6);
    assert.deepEqual(measured, f.requests.map(body => Buffer.byteLength(JSON.stringify(body))));
    assert.ok(measured.every(size => size <= f.provider.contextLimitBytes));
  } finally { await service?.close(); store?.close(); await f.close(); rmSync(root, { recursive: true, force: true }); }
});

const itemDone = (item, output_index = 0) => ({ type: 'response.output_item.done', output_index, item });
const finalItem = () => ({ ...message('준비됐어요.'), id: 'msg_synthetic', phase: 'final_answer' });
const itemAdded = (item, output_index = 0) => ({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } });
for (const mime of [null, 'text/event-stream']) test(`item.done supplies completed output when terminal output is empty (${mime})`, async () => {
  const item = finalItem();
  const env = await serverFixture((_body, res) => stream(res, [itemAdded(item), { type: 'response.output_text.delta', delta: 'never collect partial text' }, itemDone(item), completed([])], mime));
  try {
    const result = await env.provider.chat([{ role: 'user', content: 'synthetic request' }], [], new AbortController().signal);
    assert.equal(result.message.content, '준비됐어요.');
    assert.equal(result.input_tokens, 12); assert.equal(result.output_tokens, 8);
    assert.deepEqual(responsesInput([result.message]), result.message.provider_state.items);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

test('streamed tool and encrypted reasoning preserve ordered continuation without duplicated terminal output', async () => {
  const reason = { type: 'reasoning', id: 'reason_synthetic', encrypted_content: 'synthetic-ciphertext', summary: [] };
  const fn = { ...call('list_sources', {}), id: 'tool_synthetic' };
  const env = await serverFixture((_body, res) => stream(res, [itemDone(fn, 1), itemDone(reason), completed([])]));
  try {
    const result = await env.provider.chat([{ role: 'user', content: 'synthetic request' }], [tool], new AbortController().signal);
    assert.deepEqual(result.message.provider_state.items, [reason, fn]);
    assert.equal(result.message.tool_calls.length, 1);
    assert.equal(responsesInput([result.message, { role: 'tool', tool_name: 'list_sources', content: '{}' }]).at(-1).call_id, fn.call_id);
  } finally { await env.close(); }
});

test('matching full terminal output is admitted once', async () => {
  const item = finalItem();
  const env = await serverFixture((_body, res) => stream(res, [itemAdded(item), itemDone(item), completed([item])]));
  try {
    const result = await env.provider.chat([{ role: 'user', content: 'synthetic request' }], [], new AbortController().signal);
    assert.equal(result.message.content, '준비됐어요.'); assert.equal(result.message.provider_state.items.length, 1);
  } finally { await env.close(); }
});

for (const [label, events, expected] of [
  ['no response completion', [itemDone(finalItem())], 'CHATGPT_INCOMPLETE_TURN'],
  ['no finalized item', [itemAdded(finalItem()), completed([])], 'CHATGPT_INCOMPLETE_TURN'],
  ['index gap', [itemDone(finalItem(), 1), completed([])], 'CHATGPT_INCOMPLETE_TURN'],
  ['duplicate finalized index', [itemDone(finalItem()), itemDone(finalItem()), completed([])], 'CHATGPT_STREAM_INVALID'],
  ['duplicate item identity', [itemDone(finalItem()), itemDone(finalItem(), 1), completed([])], 'CHATGPT_STREAM_INVALID'],
  ['negative index', [itemDone(finalItem(), -1), completed([])], 'CHATGPT_STREAM_INVALID'],
  ['too many items', [itemDone(finalItem(), 24), completed([])], 'CHATGPT_STREAM_INVALID'],
  ['missing item identity', [itemDone(message('invalid')), completed([])], 'CHATGPT_STREAM_INVALID'],
  ['identity changed', [itemAdded(finalItem()), itemDone({ ...finalItem(), id: 'different' }), completed([])], 'CHATGPT_STREAM_INVALID'],
  ['unfinished second item', [itemDone(finalItem()), itemAdded({ ...finalItem(), id: 'second' }, 1), completed([])], 'CHATGPT_INCOMPLETE_TURN'],
  ['terminal conflict', [itemDone(finalItem()), completed([{ ...finalItem(), content: [{ type: 'output_text', text: 'conflicting answer' }] }])], 'CHATGPT_STREAM_INVALID'],
  ['invalid finalized status', [itemDone({ ...finalItem(), status: 'in_progress' }), completed([])], 'CHATGPT_OUTPUT_UNSUPPORTED'],
  ['missing usage', [itemDone(finalItem()), { type: 'response.completed', response: { status: 'completed', output: [] } }], 'CHATGPT_INCOMPLETE_TURN'],
  ['missing output array', [itemDone(finalItem()), { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }], 'CHATGPT_INCOMPLETE_TURN'],
  ['wrong tool namespace', [itemDone({ ...call('list_sources', {}), id: 'tool', namespace: 'other' }), completed([])], 'CHATGPT_TOOL_CALL_INVALID'],
  ['incomplete terminal', [itemDone(finalItem()), { type: 'response.incomplete' }], 'CHATGPT_INCOMPLETE_TURN'],
  ['late stream failure', [itemDone(finalItem()), completed([]), { type: 'response.failed' }], 'CHATGPT_STREAM_AFTER_COMPLETION'],
]) test(`stream item assembly rejects ${label} without releasing output or retrying`, async () => {
  const env = await serverFixture((_body, res) => stream(res, events));
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'synthetic request' }], [tool], new AbortController().signal), error => error.message === expected);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

for (const fullTerminal of [false, true]) test(`streamed function call accepts optional item ID absence with ${fullTerminal ? 'full' : 'empty'} terminal output`, async () => {
  const fn = call('list_sources', {});
  const env = await serverFixture((_body, res) => stream(res, [
    { type: 'response.output_item.added', output_index: 0, item: { ...fn, status: 'in_progress', arguments: '' } },
    itemDone(fn), completed(fullTerminal ? [fn] : []),
  ]));
  try {
    const result = await env.provider.chat([{ role: 'user', content: 'synthetic request' }], [tool], new AbortController().signal);
    assert.equal(result.message.tool_calls[0].function.name, 'list_sources');
    assert.deepEqual(result.message.provider_state.items, [fn]);
    assert.equal(responsesInput([result.message, { role: 'tool', tool_name: 'list_sources', content: '{}' }]).at(-1).call_id, fn.call_id);
  } finally { await env.close(); }
});

for (const change of ['call identity', 'optional item identity', 'duplicate call identity']) test(`streamed calls reject changed or duplicated ${change}`, async () => {
  const fn = { ...call('list_sources', {}), id: 'tool_synthetic' };
  const events = change === 'duplicate call identity'
    ? [itemDone(fn), itemDone({ ...fn, id: 'second_item' }, 1)]
    : [{ type: 'response.output_item.added', output_index: 0, item: { ...fn, status: 'in_progress' } },
      itemDone({ ...fn, ...(change === 'call identity' ? { call_id: 'different_call' } : { id: 'different_item' }) })];
  const env = await serverFixture((_body, res) => stream(res, [...events, completed([])]));
  try {
    await assert.rejects(env.provider.chat([{ role: 'user', content: 'synthetic request' }], [tool], new AbortController().signal), /CHATGPT_STREAM_INVALID/u);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

test('continuing conversation compacts complete native response groups and restores their call IDs', async () => {
  let step = 0;
  const f = await serverFixture((_body, res) => {
    step++;
    stream(res, [completed(step % 2 ? [call('list_sources', {})] : [message('Recorded. ' + 'x'.repeat(1500))])]);
  });
  const sources = { definitions: [tool], validate: (name, args) => name === 'list_sources' && Object.keys(args).length === 0,
    execute: async () => ({ sources: [] }), verify: async () => true };
  try {
    let assistant = new ConversationAssistant(f.provider, sources, undefined, { continuing: true, requestLimit: 100 });
    for (let i = 0; i < 25; i++) await assistant.ask(`Historical request ${i}: ` + 'y'.repeat(1000));
    const checkpoint = assistant.checkpoint();
    assert.equal(checkpoint.version, 2); assert.equal(checkpoint.usage.requests, 50);
    assert.ok(!checkpoint.history.some(m => m.content.startsWith('Historical request 0:')));
    assistant = new ConversationAssistant(f.provider, sources, undefined, { continuing: true, requestLimit: 100 });
    assistant.restore(checkpoint); await assistant.ask('Continue after restart');
    assert.equal(f.requests.length, 52);
    for (const request of f.requests) {
      const calls = new Set();
      for (const item of request.input) {
        if (item.type === 'function_call') calls.add(item.call_id);
        if (item.type === 'function_call_output') { assert.ok(calls.has(item.call_id)); calls.delete(item.call_id); }
      }
      assert.equal(calls.size, 0); assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 65536);
    }
  } finally { await f.close(); }
});

const webResponse = () => ({ object: 'response', id: 'fixture-web-response', model: 'fixture-model', status: 'completed', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, output: [
  { id: 'private-reasoning', type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING_CANARY' }] },
  { id: 'web-call', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'public facts', sources: [{ type: 'url', url: 'https://example.org/source' }] } },
  { id: 'web-answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '공식 자료입니다. [출처](https://example.org/source)', annotations: [{ type: 'url_citation', url: 'https://example.org/source', title: '공식 자료', start_index: 0, end_index: 8 }] }] },
] });
test('isolated subscription research uses official streaming plan route and retains public citations without continuation', async () => {
  const env = await serverFixture((_body, res) => stream(res, [{ type: 'response.completed', response: webResponse() }]));
  try {
    const result = await env.provider.researchPublicWeb('공식 자료를 찾아줘.', ['공개 프로젝트를 검토 중이야.'], new AbortController().signal);
    assert.equal(result.input_tokens, 12); assert.equal(result.report.searches, 1);
    assert.equal(result.report.parts[0].citations[0].url, 'https://example.org/source');
    assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING_CANARY'), false); assert.equal(result.report.continuation, undefined);
    const body = env.requests[0]; assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(body.max_tool_calls, undefined);
    assert.equal(body.previous_response_id, undefined); assert.equal(body.input.length, 2); assert.equal(body.input[1].content, '공식 자료를 찾아줘.');
    assert.match(body.input[0].content, /Earlier owner messages/);
    env.account.profile.subject = 'different-owner';
    await assert.rejects(env.provider.researchPublicWeb('Find facts', [], new AbortController().signal), /ACCOUNT_CHANGED/);
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});
for (const [name, change] of [
  ['missing citations', r => { r.output[2].content[0].annotations = []; }],
  ['unsafe citation', r => { r.output[2].content[0].annotations[0].url = 'javascript:bad()'; }],
  ['function output', r => { r.output.push({ id: 'bad', type: 'function_call', name: 'send', arguments: '{}' }); }],
]) test(`subscription research rejects ${name}, preserves observed usage and never retries`, async () => {
  const value = webResponse(); change(value);
  const env = await serverFixture((_body, res) => stream(res, [{ type: 'response.completed', response: value }]));
  try {
    await assert.rejects(env.provider.researchPublicWeb('Find facts', [], new AbortController().signal), error => {
      assert.equal(error.message, 'CHATGPT_WEB_RESPONSE_INVALID'); assert.deepEqual(error.observedUsage, { input_tokens: 12, output_tokens: 8 }); return true;
    }); assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});
test('subscription research validates owner-only input before network and does not accept source objects', async () => {
  const env = await serverFixture(() => { throw Error('must not dispatch'); });
  try {
    for (const [request, previous] of [['', []], ['x'.repeat(4097), []], ['a', [{ content: 'injected source' }]], ['a', Array(5).fill('x')], ['a', ['x'.repeat(8193)]]]) {
      await assert.rejects(env.provider.researchPublicWeb(request, previous, new AbortController().signal), /HISTORY_INVALID/);
    } assert.equal(env.requests.length, 0);
  } finally { await env.close(); }
});

test('a web completion without usage releases no research report', async()=>{
 const value=webResponse();delete value.usage;
 const env=await serverFixture((_body,res)=>stream(res,[{type:'response.completed',response:value}]));
 try{await assert.rejects(env.provider.researchPublicWeb('Find facts',[],new AbortController().signal),error=>error.message==='CHATGPT_WEB_RESPONSE_INVALID'&&error.observedUsage===undefined);assert.equal(env.requests.length,1);}finally{await env.close();}
});

for(const kind of ['response.incomplete','response.failed'])test(`web ${kind} retains observed usage without admitting a result`,async()=>{
 const env=await serverFixture((_body,res)=>stream(res,[{type:kind,response:{status:kind.split('.')[1],usage:{input_tokens:19,output_tokens:11},error:{code:'server_error'}}}]));
 try{await assert.rejects(env.provider.researchPublicWeb('Find facts',[],new AbortController().signal),error=>{assert.deepEqual(error.observedUsage,{input_tokens:19,output_tokens:11});return true;});assert.equal(env.requests.length,1);}finally{await env.close();}
});
test('web cancellation after a completed frame preserves usage while withholding the answer',async()=>{
 let reached;const ready=new Promise(r=>{reached=r;});
 const env=await serverFixture((_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame({type:'response.completed',response:webResponse()}));setTimeout(reached,50);});
 const abort=new AbortController();
 try{const pending=env.provider.researchPublicWeb('Find facts',[],abort.signal);await ready;abort.abort();await assert.rejects(pending,error=>{assert.equal(error.message,'ASSISTANT_CANCELLED');assert.deepEqual(error.observedUsage,{input_tokens:12,output_tokens:8});return true;});}finally{await env.close();}
});
for(const usage of [{input_tokens:-1,output_tokens:3},{input_tokens:1,output_tokens:'3'},{}])test(`invalid incomplete usage is never treated as observed ${JSON.stringify(usage)}`,async()=>{
 const env=await serverFixture((_body,res)=>stream(res,[{type:'response.incomplete',response:{usage}}]));
 try{await assert.rejects(env.provider.researchPublicWeb('Find facts',[],new AbortController().signal),error=>error.observedUsage===undefined);}finally{await env.close();}
});

test('isolated research accepts strictly versioned retrieved-owner context without treating it as a new request', async () => {
  const env = await serverFixture((_body, res) => stream(res, [{ type: 'response.completed', response: webResponse() }]));
  try {
    const context = { version: 1, messages: [{ id: 7, created_at: '2026-10-08T00:00:00.000Z', state: 'cancelled', text: 'The public company is Cedar. Do not buy.', selection: 'read_history' }], omitted: true };
    let admitted = 0;
    await env.provider.researchPublicWeb('Research that company, without buying.', context, new AbortController().signal, () => { admitted++; });
    assert.equal(admitted, 1);
    const body = env.requests[0]; assert.match(body.input[0].content, /2026-10-08T00:00:00.000Z/); assert.match(body.input[0].content, /cancelled requests must not be retried/);
    assert.equal(body.input[1].content, 'Research that company, without buying.');
    for (const change of [value => { value.version = 2; }, value => { value.query = 'private'; }, value => { value.messages[0].source = 'email'; }, value => { value.messages.push(value.messages[0]); }]) {
      const invalid = structuredClone(context); change(invalid);
      await assert.rejects(env.provider.researchPublicWeb('Research', invalid, new AbortController().signal), /HISTORY_INVALID/);
    }
    assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

for (const [path, change] of [['research', 'off-on'], ['research', 'settings-device'], ['chat', 'off-on'], ['personal', 'off-on'], ['personal', 'delegation']]) {
  test(`host admission stops ${path} transmission after ${change} during token refresh`, { timeout: 15000 }, async () => {
    const env = await serverFixture((_body, res) => stream(res, [completed([message('Unexpected transmission')])]));
    const root = mkdtempSync(join(tmpdir(), 'tada-delayed-admission-'));
    const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'SYNTHETIC_DELAYED_KEY', route: contactRoute({ fixture: root }), initialize: true, assistance: true });
    const base = { definitions: [], validate: () => false, verify: async () => false };
    const device = store.addDevice('Synthetic owner').id;
    let service, release, reached, admissionError, round = 0;
    const waiting = new Promise(resolve => { reached = resolve; });
    const fakeCall = (name, args = {}) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, input_tokens: 1, output_tokens: 1 });
    try {
      store.configureContinuingUse(device, true, 'continuing_conversation_24h_v1');
      store.configureFollowupDelegation(device, true, 'personal_followups_v1');
      for (const text of ['Cedar is the earlier company. Do not send externally.', ...Array.from({ length: 5 }, (_, i) => `Unrelated ${i}`)]) {
        const seq = store.submit(device, randomUUID(), text).seq; store.claim();
        const checkpoint = new ConversationAssistant({}, base).checkpoint(); checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: 'Recorded.' }];
        store.finish(seq, { text: 'Recorded.', sources: [] }, checkpoint);
      }
      env.account.accessToken = async () => { reached(); return new Promise(resolve => { release = resolve; }); };
      const model = { identity: env.provider.identity, contextLimitBytes: env.provider.contextLimitBytes, contextBytes: (...args) => env.provider.contextBytes(...args),
        researchPublicWeb: (...args) => env.provider.researchPublicWeb(...args),
        chat: async (...args) => {
          if (round++ === 0) return fakeCall('read_history', { id: 1 });
          if (path === 'research') return fakeCall('research_public_web');
          if (path === 'personal' && admissionError) return { message: { role: 'assistant', content: '변경 권한이 꺼져 있어 업무를 저장하지 않았습니다.' }, input_tokens: 1, output_tokens: 1 };
          if (path === 'personal' && !args[1].some(tool => tool.function.name === 'prepare_followup_change')) return fakeCall('apply_personal_request');
          try { return await env.provider.chat(...args); }
          catch (error) { admissionError = error.message; throw error; }
        } };
      service = new ContactService(store, model, base);
      const { seq } = service.submit(device, randomUUID(), path === 'personal' ? 'Save the earlier company work.' : 'Research the earlier company.');
      await waiting;
      if (change === 'delegation') store.configureFollowupDelegation(device, false, null);
      else if (change === 'settings-device') store.configureContinuingUse(store.addDevice('Other owner device').id, true, 'continuing_conversation_24h_v1');
      else { store.configureContinuingUse(device, false, null); store.configureContinuingUse(device, true, 'continuing_conversation_24h_v1'); }
      release('synthetic-fixture-access'); await service.idle();
      assert.equal(env.requests.length, 0, 'no HTTP inference request after revocation');
      if (change === 'delegation') {
        assert.match(admissionError, /DELEGATION/); assert.equal(store.turn(seq).state, 'answered');
        assert.match(store.turn(seq).answer.text, /저장하지 않았습니다/);
      } else {
        assert.equal(store.turn(seq).state, 'failed'); assert.equal(store.turn(seq).error, 'CONTACT_HISTORY_DISABLED');
        assert.equal(store.turn(seq).answer, null);
      }
      assert.equal(store.followupPage('all', 0).items.length, 0);
      // Preserve the reservation conservatively; the admission error is not a model usage receipt.
      assert.equal(store.usage().unknown_requests, 1);
    } finally { release?.('synthetic-fixture-access'); await service?.close(); store.close(); rmSync(root, { recursive: true, force: true }); await env.close(); }
  });
}
