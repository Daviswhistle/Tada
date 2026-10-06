// Real local SQLite + HTTP protocol fixture; no Telegram credential, account,
// public network call, or live model is used by this test suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createHash, createCipheriv, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { serveContact } from '../src/contact-http.mjs';
import { TelegramAPI, TelegramFault } from '../src/telegram-api.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { TelegramContact } from '../src/telegram-contact.mjs';
import { PassThrough } from 'node:stream';
import { contactOptions, telegramConsent } from '../src/contact-cli.mjs';

const bot = '123456789', user = '987654321', token = `${bot}:${'test_only_not_a_secret_'.repeat(2)}`;
const passphrase = 'fixture only passphrase longer than sixteen';
const route = contactRoute({ telegram_fixture: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_TOOLS'); }, verify: async () => false };
const response = content => ({ message: { role: 'assistant', content }, input_tokens: 4, output_tokens: 5 });
const message = (n, text, uid = Number(user)) => ({ update_id: n, message: { message_id: n, chat: { id: uid, type: 'private' }, from: { id: uid, is_bot: false }, text } });
function setup({ reviews = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tada-telegram-'));
  const directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase, route, initialize: true, reviews });
  return { root, directory, get store() { return store; },
    reopen() { store.close(); store = new ContactStore({ directory, passphrase, route }); return store; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function fixture() {
  const f = { updates: [], calls: [], effects: [], nextSend: null, nextPoll: null, webhook: '', me: { id: Number(bot), is_bot: true, username: 'TadaFixtureBot' }, sockets: new Set() };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const method = req.url.split('/').at(-1), input = JSON.parse(Buffer.concat(chunks));
      f.calls.push({ method, input });
      const json = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); };
      if (method === 'getMe') return json({ ok: true, result: f.me });
      if (method === 'getWebhookInfo') return json({ ok: true, result: { url: f.webhook } });
      if (method === 'getUpdates') {
        if (f.nextPoll) { const fn = f.nextPoll; f.nextPoll = null; return fn(req, res, input, json); }
        return json({ ok: true, result: f.updates.splice(0, 20) });
      }
      if (method === 'sendMessage') {
        if (f.nextSend) { const fn = f.nextSend; f.nextSend = null; return fn(req, res, input, json); }
        f.effects.push(input);
        return json({ ok: true, result: { message_id: f.effects.length, chat: { id: Number(input.chat_id), type: 'private' }, from: f.me, text: input.text } });
      }
      json({ ok: false, error_code: 400 }, 400);
    });
  });
  server.on('connection', socket => { f.sockets.add(socket); socket.on('close', () => f.sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  f.api = () => new TelegramAPI(token, (options, callback) => {
    // The executable always asks for the official HTTPS endpoint. Only this
    // test-owned transport routes it to the local simulator; no CLI override.
    assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'api.telegram.org');
    assert.equal(options.port, 443); assert.equal(options.method, 'POST');
    assert.ok(options.path.startsWith(`/bot${token}/`));
    return request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback);
  });
  f.close = async () => { for (const socket of f.sockets) socket.destroy(); await new Promise(r => server.close(r)); };
  return f;
}
async function pair(bridge, f) {
  const code = new URL(bridge.pair()).searchParams.get('start');
  let candidate; bridge.once('pairing', value => { candidate = value; });
  f.updates.push(message(1, `/start ${code}`)); await bridge.pollOnce();
  assert.ok(candidate); return bridge.approve(candidate.candidate);
}
function directBind(store) {
  store.telegramConfigure(bot);
  return store.telegramBind({ bot, chat: user, user, after_message: 1 });
}
function deliverAll(store) {
  store.telegramQueueResults(); const out = [];
  for (;;) {
    const item = store.telegramClaimDelivery(Date.now() + 86400000);
    if (!item) break;
    out.push(item);
    store.telegramDelivery(item.id, 'sent', { receipt: { message_id: out.length, bot, chat: user, text_hash: sha(item.text) } });
  }
  return out;
}
async function browser(store, service) {
  const origin = 'http://127.0.0.1:9322';
  const host = await serveContact({ store, service, origin, port: 0 });
  const call = (path, body, cookie = '') => new Promise((yes, no) => {
    const req = request({ hostname: '127.0.0.1', port: host.address.port, path, method: body === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:9322', Origin: origin, 'Content-Type': 'application/json', Cookie: cookie } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => yes({ code: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', no); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
  const paired = await call('/api/pair', { code, name: 'Browser fixture' });
  return { host, call, cookie: paired.headers['set-cookie'][0].split(';')[0] };
}

test('one assistant continues Telegram → browser → restarted host → Telegram with real shared storage and HTTP', async () => {
  const env = setup(), f = await fixture(); const histories = [];
  const model = { async chat(messages) { histories.push(messages); return response(['내일 논의할 핵심 세 가지를 정리했어요.', '민감한 브라우저 답변 ABC_PRIVATE', '앞서 이야기한 핵심을 한 문장으로 줄였어요.'][histories.length - 1]); } };
  let service = new ContactService(env.store, model, noSources), bridge = new TelegramContact(env.store, service, f.api()), ui;
  try {
    await bridge.initialize(); await pair(bridge, f); await bridge.deliverOnce();
    f.updates.push(message(2, '내일 이야기할 내용을 같이 정리하자.')); await bridge.pollOnce(); await service.idle();
    // No browser session is open while this answer is independently delivered.
    await bridge.deliverOnce(Date.now() + 2000); assert.match(f.effects.at(-1).text, /핵심 세 가지/u);
    ui = await browser(env.store, service);
    const first = await ui.call('/api/state', undefined, ui.cookie);
    assert.equal(first.body.turns[0].text, '내일 이야기할 내용을 같이 정리하자.');
    const identity = first.body.assistant;
    await ui.call('/api/turns', { request_id: randomUUID(), text: '이건 브라우저에서 이야기할게. 조금 더 자세히 설명해줘.' }, ui.cookie);
    await service.idle(); await bridge.deliverOnce(Date.now() + 4000);
    assert.match(f.effects.at(-1).text, /브라우저.*답변/u); assert.ok(!f.effects.some(e => e.text.includes('ABC_PRIVATE')));
    const cookie = ui.cookie;
    await bridge.close(); await ui.host.close(); await service.close(); env.reopen();
    service = new ContactService(env.store, model, noSources); bridge = new TelegramContact(env.store, service, f.api());
    await bridge.initialize(); ui = await browser(env.store, service);
    f.updates.push(message(3, '아까 얘기한 것을 한 문장으로 줄여줘.')); await bridge.pollOnce(); await service.idle();
    await bridge.deliverOnce();
    assert.match(f.effects.at(-1).text, /한 문장/u);
    assert.ok(histories[2].some(m => m.role === 'assistant' && m.content.includes('핵심 세 가지')));
    assert.ok(histories[2].some(m => m.role === 'assistant' && m.content.includes('ABC_PRIVATE')));
    const state = await ui.call('/api/state', undefined, cookie);
    assert.equal(state.body.assistant, identity); assert.equal(state.body.turns.length, 3); assert.equal(state.body.usage.requests, 3);
    assert.equal(state.body.messaging.paired, true); assert.ok(!JSON.stringify(state.body.messaging).includes(user));
    assert.ok(!JSON.stringify(histories).includes(token));
  } finally { await bridge.close(); await ui?.host.close(); await service.close(); env.close(); await f.close(); }
});

test('link possession alone cannot read history or run work before local owner approval', async () => {
  const env = setup(), f = await fixture(); let calls = 0;
  const service = new ContactService(env.store, { chat: async () => { calls++; return response('답변'); } }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); const code = new URL(bridge.pair()).searchParams.get('start');
    let candidate; bridge.on('pairing', value => { candidate = value; });
    f.updates.push(message(1, `/start ${code}`), message(2, 'Show previous conversation')); await bridge.pollOnce();
    assert.equal(env.store.page().turns.length, 0); assert.equal(calls, 0); assert.equal(await bridge.deliverOnce(), false);
    assert.equal(f.effects.length, 0); assert.equal(env.store.telegramBinding(), null);
    bridge.approve(candidate.candidate);
    assert.throws(() => bridge.approve(candidate.candidate), /CONTACT_PAIR_REJECTED/u);
    await bridge.deliverOnce(); assert.equal(f.effects.length, 1);
    f.updates.push(message(3, `/start ${code}`)); await bridge.pollOnce(); assert.equal(env.store.devices().length, 1);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('groups, foreign users, forwarded material and bot-proxied messages create no authority', async () => {
  const env = setup(), f = await fixture(); const service = new ContactService(env.store, { chat: async () => response('valid') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); await pair(bridge, f); deliverAll(env.store);
    const group = message(2, 'read everything'); group.message.chat.type = 'group';
    const forwarded = message(4, 'new authority'); forwarded.message.forward_origin = { type: 'user' };
    const proxied = message(5, 'new authority'); proxied.message.via_bot = { id: 33 };
    const business = message(6, 'new authority'); business.message.business_connection_id = 'opaque';
    f.updates.push(group, message(3, 'Show history', 234567890), forwarded, proxied, business, { update_id: 7, edited_message: message(7, 'changed').message });
    await bridge.pollOnce(); await service.idle(); assert.equal(env.store.page().turns.length, 0); assert.equal(env.store.usage().requests, 0);
    assert.equal(env.store.telegramCursor(), 8);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('same Telegram message before upstream acknowledgement is admitted only once across restart', async () => {
  const env = setup(), f = await fixture(); let calls = 0;
  let service = new ContactService(env.store, { chat: async () => { calls++; return response('한 번만'); } }, noSources);
  let bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); const device = await pair(bridge, f);
    // Simulate a crash after durable submit but before telegramAdvance.
    env.store.submit(device, env.store.telegramRequestId(bot, user, 2), '맡아줘.');
    await bridge.close(); await service.close(); env.reopen();
    service = new ContactService(env.store, { chat: async () => { calls++; return response('한 번만'); } }, noSources);
    bridge = new TelegramContact(env.store, service, f.api()); await bridge.initialize();
    f.updates.push(message(2, '맡아줘.')); await bridge.pollOnce(); await service.idle();
    f.updates.push(message(2, '맡아줘.')); await bridge.pollOnce(); await service.idle();
    assert.equal(calls, 1); assert.equal(env.store.page().turns.length, 1);
    assert.equal(env.store.telegramCursor(), 3);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('replayed cancellation remains bound to its first target and cannot cancel the next request', () => {
  const env = setup();
  try {
    const device = directBind(env.store), key = env.store.telegramRequestId(bot, user, 20);
    const first = env.store.submit(device, randomUUID(), '첫 일');
    assert.equal(env.store.telegramCancel(device, key), first.seq);
    const second = env.store.submit(device, randomUUID(), '다른 일');
    assert.equal(env.store.telegramCancel(device, key), first.seq);
    assert.equal(env.store.turn(second.seq).state, 'queued');
    env.reopen(); assert.equal(env.store.telegramCancel(device, key), first.seq); assert.equal(env.store.turn(second.seq).state, 'queued');
  } finally { env.close(); }
});

test('a no-target cancel receipt stays no-target after later work arrives', () => {
  const env = setup();
  try {
    const device = directBind(env.store), key = env.store.telegramRequestId(bot, user, 9);
    assert.equal(env.store.telegramCancel(device, key), null);
    const fresh = env.store.submit(device, randomUUID(), '나중에 접수');
    assert.equal(env.store.telegramCancel(device, key), null); assert.equal(env.store.turn(fresh.seq).state, 'queued');
  } finally { env.close(); }
});

test('revoke suppresses queued messages and incoming work without deleting browser history', async () => {
  const env = setup(), f = await fixture(); const service = new ContactService(env.store, { chat: async () => response('보내지 않을 답변') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); const device = await pair(bridge, f);
    f.updates.push(message(2, '요청')); await bridge.pollOnce(); await service.idle(); env.store.telegramQueueResults();
    f.updates.push(message(3, '/stop'), message(4, '재실행')); await bridge.pollOnce();
    assert.equal(await bridge.deliverOnce(), false); assert.equal(f.effects.length, 0);
    assert.equal(env.store.messagingStatus().paired, false); assert.equal(env.store.page().turns.length, 1);
    assert.equal(env.store.devices().find(d => d.id === device).revoked, 1);
    assert.ok(env.store.messagingStatus().deliveries.suppressed >= 2);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('lost send response retains one uncertain delivery and never automatically retransmits after restart', async () => {
  const env = setup(), f = await fixture(); let service = new ContactService(env.store, { chat: async () => response('작업 완료') }, noSources);
  let bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); await pair(bridge, f);
    f.nextSend = (req, res, input) => { f.effects.push(input); res.destroy(); };
    await bridge.deliverOnce(); assert.equal(f.effects.length, 1); assert.equal(env.store.messagingStatus().deliveries.unknown, 1);
    await bridge.close(); await service.close(); env.reopen();
    service = new ContactService(env.store, { chat: async () => response('later') }, noSources); bridge = new TelegramContact(env.store, service, f.api()); await bridge.initialize();
    assert.equal(await bridge.deliverOnce(), false); assert.equal(f.effects.length, 1);
    assert.equal(env.store.messagingStatus().deliveries.unknown, 1);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('known rate rejection persists a retry boundary but does not resend early or lose the payload', async () => {
  const env = setup(), f = await fixture(); const service = new ContactService(env.store, { chat: async () => response('ok') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); await pair(bridge, f);
    f.nextSend = (_req, _res, _input, json) => json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, 429);
    await bridge.deliverOnce(); assert.equal(f.effects.length, 0); assert.equal(env.store.messagingStatus().deliveries.queued, 1);
    assert.equal(await bridge.deliverOnce(Date.now() + 2000), false);
    await bridge.deliverOnce(Date.now() + 31000); assert.equal(f.effects.length, 1); assert.equal(env.store.messagingStatus().deliveries.sent, 1);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('a committed receipt prevents replay, whereas unsent completion is recovered from the same answer after restart', async () => {
  const env = setup(); let service;
  try {
    const device = directBind(env.store); deliverAll(env.store);
    service = new ContactService(env.store, { chat: async () => response('영속 결과') }, noSources);
    service.submit(device, randomUUID(), '답해줘.'); await service.idle(); await service.close(); env.reopen();
    const result = deliverAll(env.store); assert.equal(result.length, 1); assert.match(result[0].text, /영속 결과/u);
    env.reopen(); assert.equal(deliverAll(env.store).length, 0); assert.equal(env.store.page().turns[0].answer.text, '영속 결과');
  } finally { await service?.close(); env.close(); }
});

test('long Unicode answers retain all text while a lost first part suppresses dangling later parts', async () => {
  const env = setup(); let service;
  try {
    const device = directBind(env.store); deliverAll(env.store);
    const answer = '한글😀'.repeat(1300); // within the existing 16 KiB model-response limit
    service = new ContactService(env.store, { chat: async () => response(answer) }, noSources);
    service.submit(device, randomUUID(), '길게'); await service.idle();
    assert.equal(env.store.page().turns[0].state, 'answered'); env.store.telegramQueueResults();
    const first = env.store.telegramClaimDelivery(); assert.ok(first.text.length < 4096); assert.ok(first.text.isWellFormed());
    env.store.telegramDelivery(first.id, 'unknown', { error: 'CONTACT_TELEGRAM_NETWORK' });
    assert.equal(env.store.telegramClaimDelivery(), null);
    assert.ok(env.store.messagingStatus().deliveries.suppressed >= 1);
    assert.equal(env.store.page().turns[0].answer.text, answer);
  } finally { await service?.close(); env.close(); }
});

test('binding starts with current work, never silently sends the pre-pair conversation history', async () => {
  const env = setup(); const service = new ContactService(env.store, { chat: async () => response('PRE_PAIR_PRIVATE') }, noSources);
  try {
    service.submit(env.store.addDevice('browser').id, randomUUID(), 'old private question'); await service.idle();
    directBind(env.store); const notes = deliverAll(env.store); assert.equal(notes.length, 1); assert.ok(!notes[0].text.includes('PRE_PAIR_PRIVATE'));
  } finally { await service.close(); env.close(); }
});

test('missing text gets an honest unsupported-media notice rather than invented transcription', async () => {
  const env = setup(), f = await fixture(); let calls = 0;
  const service = new ContactService(env.store, { chat: async () => { calls++; return response('bad'); } }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); await pair(bridge, f); deliverAll(env.store);
    const voice = message(2); voice.message.voice = { file_id: 'not-read' }; f.updates.push(voice);
    await bridge.pollOnce(); await bridge.deliverOnce(); assert.equal(calls, 0); assert.match(f.effects.at(-1).text, /텍스트만/u);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('bot identity cannot change a persisted destination, and a stale week-old cursor is not reused', () => {
  const env = setup();
  try {
    directBind(env.store); assert.throws(() => env.store.telegramConfigure('123456788'), /BOT_CHANGED/u);
    env.store.telegramAdvance(543); assert.equal(env.store.telegramCursor(), 544);
    assert.equal(env.store.telegramCursor(Date.now() + 8 * 86400000), undefined);
    env.store.telegramAdvance(32); assert.equal(env.store.telegramCursor(), 33);
    env.reopen(); assert.equal(env.store.telegramBinding().bot, bot);
  } finally { env.close(); }
});

test('the adapter fixes endpoint and capabilities, refuses occupied webhooks, and never silently removes one', async () => {
  const f = await fixture(); let api = f.api();
  try {
    f.webhook = 'https://existing.example/hook'; await assert.rejects(api.inspect(), /WEBHOOK_PRESENT/u);
    assert.deepEqual(f.calls.map(c => c.method), ['getMe', 'getWebhookInfo']); api.close();
    f.webhook = ''; api = f.api(); assert.equal((await api.inspect()).id, bot);
    await api.updates(7); const input = f.calls.at(-1).input;
    assert.deepEqual(input, { offset: 7, timeout: 25, limit: 20, allowed_updates: ['message'] });
    await api.send({ bot, chat: user, text: '안녕 <script>🙂' });
    assert.deepEqual(f.effects[0], { chat_id: user, text: '안녕 <script>🙂', link_preview_options: { is_disabled: true }, protect_content: true });
  } finally { api.close(); await f.close(); }
});

test('six malformed response variants never release accepted updates or follow a redirect', async () => {
  const f = await fixture(), api = f.api();
  try {
    await api.inspect();
    const responses = [
      (_q, r) => r.end('{"ok":true,"ok":false,"result":[]}'),
      (_q, r) => r.end('{"ok":true,"result":[]} trailing'),
      (_q, r) => { r.writeHead(302, { location: 'https://unapproved.example' }); r.end(); },
      (_q, r) => r.end(Buffer.from([0xff, 0xfe])),
      (_q, r) => r.end(' '.repeat(262145)),
      (_q, _r, _b, json) => json({ ok: true, result: [{ update_id: 2 }, { update_id: 2 }] }),
    ];
    for (const handler of responses) { f.nextPoll = handler; await assert.rejects(api.updates()); }
    assert.equal(f.calls.filter(c => c.method === 'getUpdates').length, 6);
  } finally { api.close(); await f.close(); }
});

test('actual EOF is required and cancellation tears down the in-progress HTTP connection', async () => {
  const f = await fixture(), api = f.api();
  try {
    await api.inspect(); let started;
    const ready = new Promise(r => { started = r; });
    f.nextPoll = (_req, res) => { res.writeHead(200); res.write('{"ok":true,"result":[]}'); started(); };
    const abort = new AbortController(); let settled = false;
    const pending = api.updates(undefined, abort.signal).finally(() => { settled = true; });
    await ready; await pause(20); assert.equal(settled, false);
    abort.abort(); await assert.rejects(pending, /CANCELLED/u);
    await pause(20); assert.equal(f.sockets.size, 0);
  } finally { api.close(); await f.close(); }
});

test('wrong-account send receipts and server failures stay uncertain without exposing provider descriptions', async () => {
  const f = await fixture(), api = f.api();
  try {
    await api.inspect();
    f.nextSend = (_q, _r, input, json) => json({ ok: true, result: { message_id: 1, chat: { type: 'private', id: 19 }, from: f.me, text: input.text } });
    await assert.rejects(api.send({ bot, chat: user, text: '내용' }), /RECEIPT_MISMATCH/u);
    f.nextSend = (_q, _r, _input, json) => json({ ok: false, error_code: 500, description: `LEAK ${token}` }, 500);
    await assert.rejects(api.send({ bot, chat: user, text: '내용' }), e => e.message === 'CONTACT_TELEGRAM_REJECTED' && !e.definitelyRejected && !String(e).includes(token));
    await assert.rejects(api.send({ bot, chat: '-123', text: 'group' }), /SEND_INVALID/u);
  } finally { api.close(); await f.close(); }
});

test('CLI requires explicit Telegram selection, has no token or remote API override flag, and help makes no connection', async () => {
  const args = ['--data', 'test-root', '--model', 'explicit-local-model'];
  assert.equal(contactOptions(args).telegram, undefined);
  assert.equal(contactOptions([...args, '--telegram']).telegram, true);
  assert.equal(contactOptions([...args, '--upgrade-contact']).upgrade, true);
  assert.throws(() => contactOptions([...args, '--telegram', '--telegram']), /OPTIONS_INVALID/u);
  assert.throws(() => contactOptions([...args, '--telegram-token', token]), /OPTIONS_INVALID/u);
  assert.throws(() => contactOptions([...args, '--telegram-endpoint', 'http://elsewhere']), /OPTIONS_INVALID/u);
  assert.equal('/telegram-approve '.length, 18);
  const child = spawn(process.execPath, ['--experimental-strip-types', 'packages/engine/src/contact-cli.mjs', '--help'], { cwd: resolve('.') });
  let out = ''; child.stdout.on('data', c => { out += c; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0); assert.match(out, /--telegram/u); assert.ok(!out.includes(token));
});

// A literal prior-format fixture, independent of the new schema/migration code.
const V1 = `
CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, salt BLOB NOT NULL, proof TEXT NOT NULL, route TEXT NOT NULL, schema_hash TEXT NOT NULL) STRICT;
CREATE TABLE devices(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
CREATE TABLE turns(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, device TEXT NOT NULL REFERENCES devices(id), state TEXT NOT NULL CHECK(state IN('queued','running','answered','failed','cancelled','interrupted')), payload TEXT NOT NULL, answer TEXT, error TEXT, created INTEGER NOT NULL) STRICT;
CREATE TABLE requests(seq INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL REFERENCES turns(seq), state TEXT NOT NULL CHECK(state IN('reserved','observed','unknown')), input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0)) STRICT;
CREATE TABLE context(singleton INTEGER PRIMARY KEY CHECK(singleton=1), through_seq INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
PRAGMA user_version=1;
`;
function createV1(directory) {
  mkdirSync(directory, { mode: 0o700 });
  for (const file of ['owner.sqlite', 'contact.sqlite']) closeSync(openSync(join(directory, file), 'wx', 0o600));
  const db = new DatabaseSync(join(directory, 'contact.sqlite')); db.exec(V1);
  const install = randomUUID(), salt = randomBytes(32), key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(`${install}:identity`));
  const proof = Buffer.concat([nonce, cipher.update(JSON.stringify({ id: install, route })), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO identity VALUES(1,?,?,?,?,?)').run(install, salt, proof, route, sha(V1)); db.close(); key.fill(0);
  return install;
}

test('v1 contact records remain readable and require an explicit backed-up v2 upgrade before messaging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-telegram-upgrade-')), directory = join(root, 'private');
  const identity = createV1(directory); let store;
  try {
    store = new ContactStore({ directory, passphrase, route }); assert.equal(store.contactVersion, 1);
    const device = store.addDevice('existing browser'); store.submit(device.id, randomUUID(), '앞선 대화');
    assert.throws(() => store.telegramConfigure(bot), /UPGRADE_REQUIRED/u);
    const backupPath = await store.upgradeMessaging(); assert.ok(existsSync(backupPath));
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(backup.prepare('SELECT count(*) n FROM turns').get().n, 1); backup.close();
    assert.equal(store.contactVersion, 2); assert.equal(await store.upgradeMessaging(), null);
    assert.equal(store.id, identity); assert.equal(store.authenticate(device.token), device.id);
    directBind(store); store.close(); store = new ContactStore({ directory, passphrase, route });
    assert.equal(store.contactVersion, 2); assert.equal(store.page().turns[0].text, '앞선 대화');
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('v1 upgrade refuses a running request instead of changing state under the worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-telegram-upgrade-')), directory = join(root, 'private'); createV1(directory);
  const store = new ContactStore({ directory, passphrase, route });
  try {
    const device = store.addDevice('existing').id; store.submit(device, randomUUID(), 'running'); store.claim();
    await assert.rejects(store.upgradeMessaging(), /UPGRADE_BUSY/u); assert.equal(store.contactVersion, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('messenger identity, plaintext message and reply do not appear in the persisted database', async () => {
  const env = setup(); let service;
  try {
    const device = directBind(env.store); service = new ContactService(env.store, { chat: async () => response('PRIVATE_REPLY_CANARY') }, noSources);
    service.submit(device, randomUUID(), 'PRIVATE_MESSAGE_CANARY'); await service.idle(); deliverAll(env.store); await service.close(); env.store.close();
    const data = readFileSync(join(env.directory, 'contact.sqlite')).toString('latin1');
    for (const secret of ['PRIVATE_REPLY_CANARY', 'PRIVATE_MESSAGE_CANARY', user, token]) assert.ok(!data.includes(secret));
  } finally { await service?.close(); env.close(); }
});

test('four real process-kill boundaries preserve outbox state without replaying an uncertain effect', async () => {
  const phases = ['before_claim', 'admitted', 'applied', 'receipt_committed'];
  for (const phase of phases) {
    const env = setup(); env.store.close();
    const source = `
      import { ContactStore } from ${JSON.stringify(new URL('../src/contact-store.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import { writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      const store = new ContactStore(${JSON.stringify({ directory: env.directory, passphrase, route })});
      store.telegramConfigure(${JSON.stringify(bot)});
      store.telegramBind(${JSON.stringify({ bot, chat: user, user, after_message: 1 })});
      const effects = new DatabaseSync(${JSON.stringify(join(env.root, 'effects.sqlite'))});
      effects.exec('PRAGMA synchronous=FULL; CREATE TABLE effects(text TEXT) STRICT;');
      const phase = ${JSON.stringify(phase)};
      if (phase !== 'before_claim') {
        const out = store.telegramClaimDelivery();
        if (phase === 'applied' || phase === 'receipt_committed') {
          effects.prepare('INSERT INTO effects VALUES(?)').run(out.text);
          if (phase === 'receipt_committed') store.telegramDelivery(out.id, 'sent', {receipt:{message_id:1,bot:out.bot,chat:out.chat,text_hash:createHash('sha256').update(out.text).digest('hex')}});
        }
      }
      const ready = ${JSON.stringify(join(env.root, 'ready'))}; writeFileSync(ready, 'ready'); const fd=openSync(ready,'r+');fsyncSync(fd);closeSync(fd);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', c => { errors += c; });
    try {
      for (let n = 0; n < 500 && !existsSync(join(env.root, 'ready')) && child.exitCode === null; n++) await pause(10);
      assert.ok(existsSync(join(env.root, 'ready')), `${phase}: ${errors}`);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      env.reopen();
      const count = new DatabaseSync(join(env.root, 'effects.sqlite'), { readOnly: true });
      assert.equal(count.prepare('SELECT count(*) n FROM effects').get().n, ['applied', 'receipt_committed'].includes(phase) ? 1 : 0); count.close();
      const status = env.store.messagingStatus().deliveries;
      if (phase === 'before_claim') assert.equal(status.queued, 1);
      else if (phase === 'receipt_committed') { assert.equal(status.sent, 1); assert.equal(env.store.telegramClaimDelivery(), null); }
      else { assert.equal(status.unknown, 1); assert.equal(env.store.telegramClaimDelivery(), null); }
      console.log(`messaging fault ${phase}: persisted, no ambiguous resend`);
    } finally { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } env.close(); }
  }
});


test('poll conflict suspends both Telegram loops but the same browser conversation remains usable', async () => {
  const env = setup(), f = await fixture(); const service = new ContactService(env.store, { chat: async () => response('브라우저는 계속 사용 가능') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); await pair(bridge, f); deliverAll(env.store);
    f.nextPoll = (_q, _r, _body, json) => json({ ok: false, error_code: 409, description: 'another poller' }, 409);
    bridge.start();
    for (let n = 0; n < 100 && !bridge.status().suspended; n++) await pause(10);
    assert.equal(bridge.status().suspended, true); assert.equal(bridge.status().online, false);
    const sent = f.effects.length; assert.equal(await bridge.deliverOnce(Date.now() + 10000), false); assert.equal(f.effects.length, sent);
    service.submit(env.store.addDevice('Browser').id, randomUUID(), '여기서 이어가자.'); await service.idle();
    assert.equal(env.store.page().turns.at(-1).answer.text, '브라우저는 계속 사용 가능');
    assert.throws(() => bridge.start(), /ALREADY_STARTED/u);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('shutdown interrupts a real pending long-poll socket without waiting for the remote timeout', async () => {
  const env = setup(), f = await fixture(); const service = new ContactService(env.store, { chat: async () => response('ok') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); let begun; const ready = new Promise(r => { begun = r; });
    f.nextPoll = (_q, res) => { res.writeHead(200); res.write(' '); begun(); };
    bridge.start(); await ready; await bridge.close(); await pause(20);
    assert.equal(f.sockets.size, 0); assert.equal(env.store.usage().requests, 0);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('known send authorization failure revokes only messenger authority and releases no retry', async () => {
  const env = setup(), f = await fixture(); const service = new ContactService(env.store, { chat: async () => response('ok') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    const browserDevice = env.store.addDevice('browser');
    await bridge.initialize(); await pair(bridge, f);
    f.nextSend = (_q, _r, _body, json) => json({ ok: false, error_code: 403, description: 'blocked' }, 403);
    await bridge.deliverOnce();
    assert.equal(env.store.messagingStatus().deliveries.rejected, 1); assert.equal(env.store.messagingStatus().paired, false);
    assert.equal(bridge.status().suspended, true); assert.equal(env.store.authenticate(browserDevice.token), browserDevice.id);
    assert.equal(await bridge.deliverOnce(Date.now() + 10000), false);
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('chunked reply roundtrips every Unicode scalar and a reply cannot be rerouted by a changed receipt', async () => {
  const env = setup(); let service;
  try {
    const device = directBind(env.store); deliverAll(env.store);
    const text = '😀abc한'.repeat(1300);
    service = new ContactService(env.store, { chat: async () => response(text) }, noSources);
    service.submit(device, randomUUID(), '긴 답변'); await service.idle();
    assert.equal(env.store.page().turns.at(-1).state, 'answered');
    const parts = deliverAll(env.store); assert.ok(parts.length > 1);
    const full = parts.map(p => p.text.replace(/^\[\d+\/\d+\]\n/u, '')).join('');
    assert.equal(full, 'Tada · 요청 1\n' + text); assert.ok(parts.every(p => p.text.length <= 4096 && p.text.isWellFormed()));
    env.store.telegramNote('test-next', '바꾸지 않을 대상'); const claimed = env.store.telegramClaimDelivery();
    assert.throws(() => env.store.telegramDelivery(claimed.id, 'sent', { receipt: { message_id: 99, bot, chat: '77', text_hash: sha(claimed.text) } }), /RECEIPT_INVALID/u);
    env.store.telegramDelivery(claimed.id, 'unknown', { error: 'CONTACT_TELEGRAM_RECEIPT_MISMATCH' });
    assert.equal(env.store.messagingStatus().deliveries.unknown, 1);
  } finally { await service?.close(); env.close(); }
});

test('a revoked device cannot regain access through an old message after explicit re-pairing', () => {
  const env = setup();
  try {
    const first = directBind(env.store); env.store.revoke(first);
    const next = env.store.telegramBind({ bot, chat: user, user, after_message: 50 });
    assert.notEqual(next, first); assert.equal(env.store.telegramBinding().after_message, 50);
    const deliveries = deliverAll(env.store); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].device, next);
    assert.throws(() => env.store.submit(first, randomUUID(), 'old authority'), /REVOKED/u);
  } finally { env.close(); }
});


test('messaging consent accepts only explicit YES and input closure aborts without starting a connection', async () => {
  for (const value of ['YES', 'yes', 'no']) {
    const input = new PassThrough(), output = new PassThrough();
    const pending = telegramConsent(input, output); input.write(value + '\n');
    assert.equal(await pending, value === 'YES'); input.destroy(); output.destroy();
  }
  const input = new PassThrough(), output = new PassThrough();
  const pending = telegramConsent(input, output); input.end();
  await assert.rejects(pending, error => error.name === 'AbortError'); output.destroy();
});

test('running contact loops accept ordinary messages and deliver the saved reply while no browser is open', async () => {
  const env = setup(), f = await fixture(); let seen = 0, delayedReceipt = false;
  const service = new ContactService(env.store, { async chat() { seen++; return response('대화 창 없이도 답변을 돌려드렸어요.'); } }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); await pair(bridge, f);
    // Keep the remote effect and local receipt commit observably distinct.
    // The old assertion raced on f.effects and could see only one sent receipt.
    const delayReply = (_req, _res, input, json) => {
      f.effects.push(input);
      const result = { message_id: f.effects.length, chat: { id: Number(input.chat_id), type: 'private' }, from: f.me, text: input.text };
      if (input.text.includes('대화 창 없이도 답변을 돌려드렸어요.')) {
        delayedReceipt = true;
        setTimeout(() => json({ ok: true, result }), 75);
      } else { f.nextSend = delayReply; json({ ok: true, result }); }
    };
    f.nextSend = delayReply;
    f.updates.push(message(2, '밖에 있는데 이 생각을 같이 정리해줘.'));
    bridge.start(); // No manual pollOnce/deliverOnce after startup.
    for (let n = 0; n < 500 && (!f.effects.some(m => m.text.includes('답변을 돌려드렸어요'))
      || env.store.messagingStatus().deliveries.sent !== 2); n++) await pause(10);
    assert.equal(seen, 1); assert.equal(env.store.page().turns[0].state, 'answered');
    assert.ok(f.effects.some(m => m.text.includes('답변을 돌려드렸어요')));
    assert.equal(delayedReceipt, true);
    assert.equal(f.effects.length, 2); // no duplicate upstream effect
    assert.equal(env.store.messagingStatus().deliveries.sent, 2); // welcome + actual reply
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});


function scheduledFixture(store, device) {
  const text = '보고서를 다시 확인할 일로 저장해줘.', seq = store.submit(device, randomUUID(), text).seq; store.claim();
  const proposal = { id: randomUUID(), timezone: 'Asia/Seoul', spec: {
    operation_id: 'telegram_review_fixture', target: null, expected_version: 0,
    title: '보고서 다시 확인', details: '현재 자료에서 변경 사항과 다음 행동 정리', state: 'open', waiting_for: null,
    notify_at: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, 'Z'), user_quote: text,
  } };
  store.finish(seq, { text: '맡길 내용과 시각을 확인해 주세요.', sources: [] }, new ConversationAssistant({}, noSources).checkpoint(), [proposal]);
  return proposal;
}

test('paired Telegram confirms and separately authorizes a review on the same service, then delivers its result once', async () => {
  const env = setup({ reviews: true }), f = await fixture(); let calls = 0;
  const service = new ContactService(env.store, { chat: async () => { calls++; return response('연결된 자료가 없어 현재 보고서는 확인하지 못했어요.'); } }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); const device = await pair(bridge, f); const p = scheduledFixture(env.store, device);
    f.updates.push(message(2, `/confirm ${p.id}`)); await bridge.pollOnce();
    const w = env.store.followupPage('active').items[0]; assert.equal(w.review, null); assert.equal(calls, 0);
    const notices = deliverAll(env.store); assert.ok(notices.some(x => x.text.includes(`/review ${w.id} 1`) && x.text.includes('최대 8회')));
    const forged = message(3, `/review ${w.id} 1`); forged.message.forward_origin = { type: 'user' };
    f.updates.push(forged, message(4, `/review ${w.id} 2`)); await bridge.pollOnce(); assert.equal(env.store.reviewState(w.id, 1), null);
    f.updates.push(message(5, `/review ${w.id} 1`)); await bridge.pollOnce(); assert.equal(env.store.reviewState(w.id, 1).state, 'armed'); assert.equal(calls, 0);
    // Drain informational notices BEFORE queuing the test's future review.
    deliverAll(env.store);
    service.tickFollowups(Date.parse(w.notify_at)); service.start(); await service.idle(); assert.equal(calls, 1);
    await bridge.deliverOnce(); assert.match(f.effects.at(-1).text, /현재 보고서는 확인하지 못했어요/);
    assert.equal(env.store.followup(w.id).state, 'open');
    assert.equal(await bridge.deliverOnce(Date.now() + 3000), false);
    f.updates.push(message(6, `/review ${w.id} 1`)); await bridge.pollOnce(); service.tickFollowups(Date.parse(w.notify_at)); await service.idle();
    assert.equal(calls, 1); assert.equal(env.store.reviewState(w.id, 1).state, 'answered');
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});

test('a cancelled review result is suppressed after a definite Telegram 429 rejection, not retried into changed authority', async () => {
  const env = setup({ reviews: true }), f = await fixture();
  const service = new ContactService(env.store, { chat: async () => response('REVIEW_PRIVATE_LATE_OUTPUT') }, noSources);
  const bridge = new TelegramContact(env.store, service, f.api());
  try {
    await bridge.initialize(); const device = await pair(bridge, f), p = scheduledFixture(env.store, device);
    const w = env.store.confirmFollowup(device, p.id, 'approve'); deliverAll(env.store);
    service.armReview(device, w.commitment, 1, 'one_local_read_only_review');
    service.tickFollowups(Date.parse(env.store.followup(w.commitment).notify_at)); service.start(); await service.idle();
    f.nextSend = (_req, _res, _body, json) => json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429);
    assert.equal(await bridge.deliverOnce(), true); assert.equal(f.effects.length, 0);
    f.updates.push(message(2, `/review-cancel ${w.commitment} 1`)); await bridge.pollOnce();
    await bridge.deliverOnce(Date.now() + 3000);
    assert.ok(!f.effects.some(item => item.text.includes('REVIEW_PRIVATE_LATE_OUTPUT')));
    assert.ok(env.store.messagingStatus().deliveries.suppressed >= 1);
    assert.equal(env.store.reviewState(w.commitment, 1).state, 'answered', 'cancellation never falsifies the saved completed result');
  } finally { await bridge.close(); await service.close(); env.close(); await f.close(); }
});
