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
    const result = await env.provider.chat([{ role: 'system', content: 'host rules' }, { role: 'user', content: '안녕' }], [], new AbortController().signal);
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
    assert.ok(body.input[0].content.includes('No automatic source reviews with this provider'));
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
    phase++; stream(res, [completed([{ type: 'reasoning', id: `rs_fixture_${phase}`, encrypted_content: `opaque-encrypted-fixture-${phase}`, summary: [{ type: 'summary_text', text: 'private summary fixture' }] }, output])], contentType);
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
    assert.ok(env.requests[1].input.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-encrypted-fixture-1'));
    assert.equal(env.requests[1].input.find(item => item.type === 'function_call').call_id, env.requests[1].input.find(item => item.type === 'function_call_output').call_id);
    assert.ok(store.page().turns.some(turn => turn.answer?.text.includes('11월 2일')));
    await service.close(); store.close();
    store = new ContactStore({ directory, passphrase, route }); service = new ContactService(store, env.provider, sources);
    const followup = service.submit(second.id, randomUUID(), '남은 일이 뭐였지?'); await service.idle();
    assert.equal(store.turn(followup.seq).state, 'answered'); assert.equal(phase, 5); assert.equal(store.usage().requests, 5);
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
    assert.ok(measured.every(size => size <= 14000));
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
