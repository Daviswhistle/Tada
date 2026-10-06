import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { request, createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { serveContact } from '../src/contact-http.mjs';
import { FollowupSources, FOLLOWUP_TOOLS } from '../src/followup-sources.mjs';
import { validateFollowupProposal, followupInstant, followupTimezone } from '../src/followup-contract.mjs';
import { TelegramContact } from '../src/telegram-contact.mjs';
import { TelegramAPI } from '../src/telegram-api.mjs';
import { ConversationAssistant } from '../src/conversation.ts';

const passphrase = 'fixture only sufficiently long passphrase';
const route = contactRoute({ fixture: 'followups' });
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NOT_CONNECTED'); }, verify: async () => false };
const reply = (text, calls = []) => ({ message: { role: 'assistant', content: text, tool_calls: calls }, input_tokens: 9, output_tokens: 4 });
const call = (name, args) => ({ function: { name, arguments: args } });
const iso = time => new Date(time).toISOString().replace(/\.\d{3}Z$/u, 'Z');
const input = '다음에 민지 답장 확인할 일로 기억해줘. 시각을 정해서 한 번 알려줘.';
function spec(overrides = {}) {
  return { operation_id: 'keep_minji_reply', target: null, expected_version: 0, title: '민지 답장 확인',
    details: '답장 여부를 확인하고 필요한 후속 작업을 정리하기', state: 'waiting', waiting_for: '민지의 답장',
    notify_at: iso(Date.now() + 3600000), user_quote: input, ...overrides };
}
function environment(v3 = true) {
  const root = mkdtempSync(join(tmpdir(), 'tada-work-followups-')), directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase, route, initialize: true, followups: v3 });
  return { root, directory, get store() { return store; },
    reopen() { store.close(); store = new ContactStore({ directory, passphrase, route }); return store; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function proposal(env, device, value = spec(), text = input) {
  const seq = env.store.submit(device, randomUUID(), text).seq;
  env.store.claim();
  const p = { id: randomUUID(), spec: value, timezone: 'Asia/Seoul' };
  const checkpoint = new ConversationAssistant({ chat: async () => reply('unused') }, noSources).checkpoint();
  env.store.finish(seq, { text: '제안했어요.', sources: [] }, checkpoint, [p]);
  return p;
}
async function active(env, device, value = spec()) {
  const p = await proposal(env, device, value);
  return env.store.confirmFollowup(device, p.id, 'approve');
}
const sha = v => createHash('sha256').update(v).digest('hex');
function acceptOutbox(store) {
  const rows = [];
  for (;;) {
    const row = store.telegramClaimDelivery(); if (!row) break; rows.push(row);
    store.telegramDelivery(row.id, 'sent', { receipt: { message_id: rows.length, bot: row.bot, chat: row.chat, text_hash: sha(row.text) } });
  }
  return rows;
}
function bindTelegram(store) {
  store.telegramConfigure('333'); return store.telegramBind({ bot: '333', chat: '555', user: '555', after_message: 10 });
}
async function network(store, service) {
  const origin = 'http://127.0.0.1:9278';
  const host = await serveContact({ store, service, origin, port: 0 });
  const rpc = (path, body, cookie = '', custom = {}) => new Promise((yes, no) => {
    const req = request(`http://127.0.0.1:${host.address.port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:9278', Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...custom } }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => yes({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', no); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pair = async name => {
    const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
    const res = await rpc('/api/pair', { code, name });
    assert.equal(res.status, 200); return { id: res.body.device, cookie: res.headers['set-cookie'][0].split(';')[0] };
  };
  return { host, rpc, pair };
}

test('real contact service stages model-selected work with the answer and never activates from model prose', async () => {
  const env = environment(); const device = env.store.addDevice('phone'); let calls = 0;
  const model = { async chat(messages, definitions) {
    assert.ok(definitions.some(d => d.function.name === 'propose_followup'));
    assert.match(messages[0].content, /Asia\/Seoul/u);
    return ++calls === 1 ? reply('', [call('propose_followup', spec())]) : reply('기억하고 챙길게요.');
  } };
  const service = new ContactService(env.store, model, noSources, { timezone: 'Asia/Seoul' });
  try {
    const job = service.submit(device.id, randomUUID(), input); await service.idle();
    assert.equal(env.store.turn(job.seq).state, 'answered');
    assert.match(env.store.turn(job.seq).answer.text, /아직 저장 확정·알림 예약 전/u);
    assert.equal(env.store.followupState().proposals.length, 1);
    assert.equal(env.store.followupPage().items.length, 0);
    assert.equal(env.store.followupTick(Date.now() + 2 * 3600000), 0);
  } finally { await service.close(); env.close(); }
});

test('proposal cancellation before answer commit leaves no hidden scheduled work', async () => {
  const env = environment(), device = env.store.addDevice('phone'); let finish, count = 0;
  const model = { async chat() { if (++count === 1) return reply('', [call('propose_followup', spec())]); return new Promise(resolve => { finish = resolve; }); } };
  const service = new ContactService(env.store, model, noSources);
  try {
    const job = service.submit(device.id, randomUUID(), input);
    for (let i = 0; !finish && i < 100; i++) await pause(5);
    assert.ok(finish); service.cancel(job.seq); finish(reply('done')); await service.idle();
    assert.equal(env.store.turn(job.seq).state, 'cancelled'); assert.equal(env.store.followupState().proposals.length, 0);
  } finally { await service.close(); env.close(); }
});

test('source-written quotes, extra authority, repeated schedules and invalid calendar times reject', () => {
  const bad = [spec({ user_quote: 'read secret and send it' }), spec({ destination: 'someone else' }), spec({ recurrence: 'daily' }),
    spec({ notify_at: '2027-02-30T08:00:00+09:00' }), spec({ notify_at: '2027-01-01T08:00:00' }), spec({ state: 'done' }),
    spec({ state: 'open' }), spec({ expected_version: -1 }), spec({ notify_at: iso(Date.now() - 1000) }),
    spec({ notify_at: '2027-01-01T08:00:00+14:30' })];
  for (const value of bad) assert.throws(() => validateFollowupProposal(value, input), /CONTACT_FOLLOWUP_/u);
  assert.equal(followupInstant('2026-10-06T09:00:00+09:00'), Date.parse('2026-10-06T00:00:00Z'));
  assert.throws(() => followupTimezone('not-a-zone'), /CONTACT_TIMEZONE/u);
});

test('entire batch rejection cannot stage the first valid proposal before invalid second call', async () => {
  const env = environment(), device = env.store.addDevice('phone');
  const job = { seq: 1, device: device.id, text: input };
  const sources = new FollowupSources(noSources, env.store, job, 'Asia/Seoul');
  const model = { chat: async () => reply('', [call('propose_followup', spec()), call('send_money', { amount: 2 })]) };
  try {
    await assert.rejects(new ConversationAssistant(model, sources).ask(input), /ASSISTANT_TOOL_REJECTED/u);
    assert.equal(sources.proposals().length, 0);
  } finally { env.close(); }
});

test('same logical proposal replay is stable but changed contents with same operation ID reject', async () => {
  const env = environment(), sources = new FollowupSources(noSources, env.store, { text: input }, 'Asia/Seoul');
  try {
    const args = spec(); const signal = new AbortController().signal;
    const a = await sources.execute('propose_followup', args, signal), b = await sources.execute('propose_followup', args, signal);
    assert.deepEqual(a, b); assert.equal(sources.proposals().length, 1);
    await assert.rejects(sources.execute('propose_followup', { ...args, title: '다른 업무' }, signal), /ID_REUSED/u);
  } finally { env.close(); }
});

test('owner confirmation from another paired client persists once and replay does not revive cancelled work', async () => {
  const env = environment(), phone = env.store.addDevice('phone'), pc = env.store.addDevice('PC');
  try {
    const p = await proposal(env, phone.id); const result = env.store.confirmFollowup(pc.id, p.id, 'approve');
    assert.equal(env.store.followup(result.commitment).state, 'waiting');
    const cancellation = await proposal(env, pc.id, spec({ target: result.commitment, expected_version: 1, state: 'cancelled', waiting_for: null, notify_at: null }));
    env.store.confirmFollowup(pc.id, cancellation.id, 'approve'); env.reopen();
    assert.equal(env.store.confirmFollowup(pc.id, p.id, 'approve').replay, true);
    assert.equal(env.store.followup(result.commitment).state, 'cancelled');
    assert.equal(env.store.followup(result.commitment).version, 2);
  } finally { env.close(); }
});

test('concurrent device revisions cannot use a superseded proposal against new state', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    const original = await active(env, d.id);
    const a = await proposal(env, d.id, spec({ target: original.commitment, expected_version: 1, title: '수정 A' }));
    const b = await proposal(env, d.id, spec({ target: original.commitment, expected_version: 1, title: '수정 B' }));
    env.store.confirmFollowup(d.id, b.id, 'approve');
    assert.throws(() => env.store.confirmFollowup(d.id, a.id, 'approve'), /DECISION_CONFLICT/u);
    assert.equal(env.store.followup(original.commitment).title, '수정 B');
  } finally { env.close(); }
});

test('rejected and expired proposals do not silently activate later', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    const a = await proposal(env, d.id); env.store.confirmFollowup(d.id, a.id, 'reject');
    assert.throws(() => env.store.confirmFollowup(d.id, a.id, 'approve'), /DECISION_CONFLICT/u);
    const b = await proposal(env, d.id, spec({ notify_at: null }));
    env.store.followupTick(Date.now() + 2 * 86400000);
    assert.throws(() => env.store.confirmFollowup(d.id, b.id, 'approve'), /DECISION_CONFLICT/u);
    assert.equal(env.store.followupPage('all').items.length, 0);
  } finally { env.close(); }
});

test('due time creates one durable notice across reopen and clock reversal without a model call', async () => {
  const env = environment(), d = env.store.addDevice('phone'); const args = spec();
  try {
    await active(env, d.id, args); const due = followupInstant(args.notify_at);
    assert.equal(env.store.followupTick(due - 1), 0); assert.equal(env.store.followupTick(due), 1);
    env.reopen(); assert.equal(env.store.followupTick(due), 0); assert.equal(env.store.followupTick(due - 86400000), 0);
    assert.equal(env.store.followupTick(due + 86400000), 0); assert.equal(env.store.usage().requests, 0);
    assert.equal(env.store.followupState().notices.length, 1);
  } finally { env.close(); }
});

test('overdue catch-up reports lateness once and waiting record does not pretend a reply was seen', async () => {
  const env = environment(), d = env.store.addDevice('phone'), args = spec();
  try {
    const result = await active(env, d.id, args); env.store.followupTick(followupInstant(args.notify_at) + 3600000);
    const n = env.store.followupState().notices[0]; assert.equal(n.late, true); assert.match(n.text, /시각이 지났/u);
    assert.equal(env.store.followup(result.commitment).state, 'waiting');
    assert.equal(env.store.followup(result.commitment).completion_basis, null);
  } finally { env.close(); }
});

test('revoking the approving device suppresses unsent notices without losing the work record', async () => {
  const env = environment(), d = env.store.addDevice('phone'), args = spec();
  try {
    const result = await active(env, d.id, args); bindTelegram(env.store); acceptOutbox(env.store);
    env.store.followupTick(followupInstant(args.notify_at)); env.store.revoke(d.id);
    assert.equal(env.store.telegramClaimDelivery(), null); assert.equal(env.store.followupState().notices.length, 0);
    assert.equal(env.store.followup(result.commitment).state, 'waiting');
  } finally { env.close(); }
});

test('browser-origin reminder sends a minimal notice and Telegram-origin one uses the approved title', async () => {
  for (const telegramOrigin of [false, true]) {
    const env = environment();
    try {
      const tg = bindTelegram(env.store); const d = telegramOrigin ? tg : env.store.addDevice('PC').id;
      acceptOutbox(env.store); const args = spec(); await active(env, d, args);
      env.store.followupTick(followupInstant(args.notify_at)); const notices = acceptOutbox(env.store);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].text.includes(args.title), telegramOrigin);
      assert.equal(env.store.followupTick(followupInstant(args.notify_at)), 0);
    } finally { env.close(); }
  }
});

test('changing or cancelling work suppresses an old queued notification, not sent history', async () => {
  for (const inFlight of [false, true]) {
    const env = environment(), d = env.store.addDevice('phone'), args = spec();
    try {
      bindTelegram(env.store); acceptOutbox(env.store); const result = await active(env, d.id, args);
      env.store.followupTick(followupInstant(args.notify_at)); const sending = inFlight ? env.store.telegramClaimDelivery() : null;
      const cancel = await proposal(env, d.id, spec({ target: result.commitment, expected_version: 1, state: 'cancelled', waiting_for: null, notify_at: null }));
      env.store.confirmFollowup(d.id, cancel.id, 'approve');
      assert.equal(env.store.telegramClaimDelivery(), null); assert.equal(env.store.followupState().notices.length, 0);
      if (sending) env.store.telegramDelivery(sending.id, 'unknown', { error: 'CONNECTION_LOST' });
      assert.equal(env.store.messagingStatus().deliveries[inFlight ? 'unknown' : 'suppressed'], 1);
    } finally { env.close(); }
  }
});

test('notification acknowledgement suppresses queued transmission without marking the work completed', async () => {
  const env = environment(), d = env.store.addDevice('phone'), args = spec();
  try {
    bindTelegram(env.store); acceptOutbox(env.store); const result = await active(env, d.id, args);
    env.store.followupTick(followupInstant(args.notify_at)); const id = env.store.followupState().notices[0].id;
    env.store.dismissFollowupNotice(d.id, id); env.store.dismissFollowupNotice(d.id, id);
    assert.equal(env.store.telegramClaimDelivery(), null); assert.equal(env.store.followup(result.commitment).state, 'waiting');
  } finally { env.close(); }
});

test('explicit user completion retains its limited owner-reported evidence level', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    const result = await active(env, d.id);
    const p = await proposal(env, d.id, spec({ target: result.commitment, expected_version: 1, state: 'done', waiting_for: null, notify_at: null }));
    env.store.confirmFollowup(d.id, p.id, 'approve'); env.reopen();
    assert.equal(env.store.followup(result.commitment).completion_basis, 'owner_confirmation');
    assert.equal(env.store.followupPage('active').items.length, 0);
    assert.equal(env.store.followupPage('all').items[0].state, 'done');
  } finally { env.close(); }
});

test('approved record update remains independent of model history and is retrieved on another-device followup', async () => {
  const env = environment(), a = env.store.addDevice('phone'), b = env.store.addDevice('PC'); let modelCount = 0, observed;
  const model = { async chat(messages) {
    if (++modelCount === 1) return reply('', [call('list_followups', { status: 'active', offset: 0 })]);
    observed = JSON.parse(messages.filter(m => m.role === 'tool').at(-1).content);
    return reply('민지 답장을 기다리는 일을 챙기고 있어요.');
  } };
  let service;
  try {
    await active(env, a.id); env.reopen(); service = new ContactService(env.store, model, noSources);
    service.submit(b.id, randomUUID(), '내가 맡겨둔 일 뭐가 남았지?'); await service.idle();
    assert.equal(observed.items[0].title, '민지 답장 확인'); assert.equal(observed.items[0].state, 'waiting');
  } finally { await service?.close(); env.close(); }
});

test('explicit v2 upgrade makes a consistent backup and old schema is not silently upgraded', async () => {
  const env = environment(false);
  try {
    const d = env.store.addDevice('PC'); assert.equal(env.store.contactVersion, 2);
    assert.equal(env.store.followupState().available, false); const backup = await env.store.upgradeFollowups();
    assert.ok(backup); const old = new DatabaseSync(backup, { readOnly: true });
    assert.equal(old.prepare('PRAGMA user_version').get().user_version, 2); old.close();
    env.reopen(); assert.equal(env.store.contactVersion, 3); assert.equal(env.store.authenticate(d.token), d.id);
    assert.equal(await env.store.upgradeMessaging(), null); assert.equal(await env.store.upgradeFollowups(), null);
  } finally { env.close(); }
});

test('upgrade refuses an active turn or admitted outbound send', async () => {
  const env = environment(false);
  try {
    const d = env.store.addDevice('PC'); env.store.submit(d.id, randomUUID(), 'test'); const job = env.store.claim();
    await assert.rejects(env.store.upgradeFollowups(), /UPGRADE_BUSY/u); env.store.cancel(job.seq);
    bindTelegram(env.store); env.store.telegramClaimDelivery();
    await assert.rejects(env.store.upgradeFollowups(), /UPGRADE_BUSY/u);
  } finally { env.close(); }
});

test('work payloads and notices are encrypted at rest; corruption prevents reopened use', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    const args = spec({ title: 'SECRET_CANARY_LONG_TERM_TITLE' }); const result = await active(env, d.id, args);
    env.store.followupTick(followupInstant(args.notify_at)); env.store.close();
    const bytes = readFileSync(join(env.directory, 'contact.sqlite')); assert.equal(bytes.includes(Buffer.from(args.title)), false);
    const raw = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    raw.prepare('UPDATE followups SET payload=? WHERE id=?').run('corrupt', result.commitment); raw.close();
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route }), /INTEGRITY/u);
  } finally { env.close(); }
});

test('failed notice/outbox insertion rolls back both instead of losing or duplicating the reminder', async () => {
  const env = environment(), d = env.store.addDevice('phone'), args = spec();
  try {
    bindTelegram(env.store); acceptOutbox(env.store); await active(env, d.id, args);
    const raw = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    raw.exec("CREATE TRIGGER broken_notice BEFORE INSERT ON followup_notices BEGIN SELECT RAISE(ABORT,'fault'); END;");
    assert.throws(() => env.store.followupTick(followupInstant(args.notify_at)), /STORAGE_FAILED/u);
    assert.equal(raw.prepare("SELECT count(*) n FROM telegram_outbox WHERE state='queued'").get().n, 0);
    assert.equal(raw.prepare('SELECT count(*) n FROM followup_notices').get().n, 0);
    raw.exec('DROP TRIGGER broken_notice'); raw.close(); env.reopen();
    assert.equal(env.store.followupTick(followupInstant(args.notify_at)), 1);
  } finally { env.close(); }
});

test('paired HTTP clients see and approve the exact proposal; extra payload, cross-origin and unauthenticated requests fail', async () => {
  const env = environment(); const service = new ContactService(env.store, { chat: async () => reply('test') }, noSources);
  const net = await network(env.store, service);
  try {
    const phone = await net.pair('phone'), pc = await net.pair('PC'); const p = await proposal(env, phone.id);
    const state = await net.rpc('/api/state', undefined, pc.cookie); assert.equal(state.body.followups.proposals[0].id, p.id);
    assert.equal((await net.rpc('/api/followups/decision', { proposal_id: p.id, decision: 'approve' })).status, 401);
    assert.equal((await net.rpc('/api/followups/decision', { proposal_id: p.id, decision: 'approve', notify_at: 'changed' }, pc.cookie)).status, 400);
    assert.equal((await net.rpc('/api/followups/decision', { proposal_id: p.id, decision: 'approve' }, pc.cookie, { Origin: 'https://elsewhere.test' })).status, 403);
    assert.equal((await net.rpc('/api/followups/decision', { proposal_id: p.id, decision: 'approve' }, pc.cookie)).status, 200);
    assert.equal((await net.rpc('/api/followups?offset=0', undefined, phone.cookie)).body.items.length, 1);
    assert.equal((await net.rpc('/api/followups?offset=-1', undefined, pc.cookie)).status, 400);
  } finally { await net.host.close(); await service.close(); env.close(); }
});

test('paired Telegram owner can confirm the same pending work without opening a browser; replay stays one record', async () => {
  const env = environment(); const service = new ContactService(env.store, { chat: async () => reply('test') }, noSources);
  let update = [];
  const api = { inspect: async () => ({ id: '333', username: 'fixture_bot' }), updates: async () => update, close() {} };
  const telegram = new TelegramContact(env.store, service, api);
  try {
    await telegram.initialize(); const d = bindTelegram(env.store); const p = await proposal(env, d);
    env.store.telegramQueueResults(); const sent = acceptOutbox(env.store);
    assert.ok(sent.some(x => x.text.includes(`/confirm ${p.id}`)));
    update = [{ update_id: 90, message: { message_id: 11, chat: { id: 555, type: 'private' }, from: { id: 555, is_bot: false }, text: `/confirm ${p.id}` } }];
    await telegram.pollOnce(); await telegram.pollOnce();
    assert.equal(env.store.followupPage().items.length, 1); assert.equal(env.store.followup(p.id).version, 1);
    assert.equal(env.store.usage().requests, 0);
  } finally { await telegram.close(); await service.close(); env.close(); }
});

test('running timer delivers a due notice with no browser and no additional model request', async () => {
  const env = environment(), d = env.store.addDevice('phone'); let modelCalls = 0;
  const service = new ContactService(env.store, { chat: async () => { modelCalls++; return reply('unused'); } }, noSources);
  try {
    const args = spec({ notify_at: iso(Date.now() + 2500) }); await active(env, d.id, args);
    service.start(); await service.idle();
    for (let i = 0; i < 80 && !env.store.followupState().notices.length; i++) await pause(50);
    assert.equal(env.store.followupState().notices.length, 1); assert.equal(modelCalls, 0);
  } finally { await service.close(); env.close(); }
});

test('no-contact-v3 source mode does not advertise work control, and paging preserves all work without oversized results', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    for (let i = 0; i < 7; i++) await active(env, d.id, spec({ title: `업무 ${i}`, notify_at: null }));
    const first = env.store.followupPage('active', 0), rest = env.store.followupPage('active', first.next_offset);
    assert.equal(first.items.length, 5); assert.equal(rest.items.length, 2); assert.equal(rest.next_offset, null);
    assert.equal(new Set([...first.items, ...rest.items].map(v => v.id)).size, 7);
    const model = { chat: async (_messages, tools) => { assert.equal(tools.length, 0); return reply('도구 연결이 없어요.'); } };
    await new ConversationAssistant(model, noSources).ask('맡긴 일');
  } finally { env.close(); }
});

test('actual child-process kills preserve pending, confirmed and due states without duplicate catch-up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-followup-kill-'));
  const module = new URL('../src/contact-store.mjs', import.meta.url).href;
  const engine = new URL('../src/conversation.ts', import.meta.url).href;
  try {
    for (const phase of ['proposal', 'confirmed', 'notice']) {
      const directory = join(root, phase), args = spec();
      const code = `import {ContactStore} from ${JSON.stringify(module)}; import {ConversationAssistant} from ${JSON.stringify(engine)};
        const store=new ContactStore({directory:${JSON.stringify(directory)},passphrase:${JSON.stringify(passphrase)},route:${JSON.stringify(route)},initialize:true,followups:true});
        const device=store.addDevice('child');const seq=store.submit(device.id,'child_request_identifier',${JSON.stringify(input)}).seq;store.claim();
        const proposal={id:'00000000-0000-4000-8000-000000000001',spec:${JSON.stringify(args)},timezone:'Asia/Seoul'};
        const checkpoint=new ConversationAssistant({}, {definitions:[]}).checkpoint();store.finish(seq,{text:'review',sources:[]},checkpoint,[proposal]);
        if(${JSON.stringify(phase)}!=='proposal')store.confirmFollowup(device.id,proposal.id,'approve');
        if(${JSON.stringify(phase)}==='notice')store.followupTick(${followupInstant(args.notify_at)});
        console.log('READY');setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', c => { stderr += c; });
      try {
        const ready = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error(stderr); }), pause(15000, undefined, { ref: false }).then(() => { throw Error('child timeout'); })]);
        assert.match(String(ready[0]), /READY/u); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        const store = new ContactStore({ directory, passphrase, route });
        if (phase === 'proposal') { assert.equal(store.followupState().proposals.length, 1); assert.equal(store.followupTick(followupInstant(args.notify_at)), 0); }
        else { assert.equal(store.followupPage().items.length, 1); assert.equal(store.followupTick(followupInstant(args.notify_at)), phase === 'notice' ? 0 : 1); assert.equal(store.followupState().notices.length, 1); }
        store.close();
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a rate-limited reminder requeued after cancellation is rechecked and never resent', async () => {
  const env = environment(), d = env.store.addDevice('phone'), args = spec();
  try {
    bindTelegram(env.store); acceptOutbox(env.store); const result = await active(env, d.id, args);
    env.store.followupTick(followupInstant(args.notify_at)); const sending = env.store.telegramClaimDelivery();
    assert.ok(sending);
    const p = await proposal(env, d.id, spec({ target: result.commitment, expected_version: 1, state: 'cancelled', waiting_for: null, notify_at: null }));
    env.store.confirmFollowup(d.id, p.id, 'approve');
    // Telegram explicitly rejected the in-flight request with 429. It becomes
    // retryable, but the subsequent claim must reread the updated work state.
    env.store.telegramDelivery(sending.id, 'queued', { retryAt: 0, error: 'CONTACT_TELEGRAM_RATE_LIMIT' });
    assert.equal(env.store.telegramClaimDelivery(), null);
    assert.equal(env.store.messagingStatus().deliveries.suppressed, 1);
    env.reopen(); assert.equal(env.store.telegramClaimDelivery(), null);
  } finally { env.close(); }
});

test('proposals beyond the approving credential lifetime do not make unkeepable notification promises', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    const p = await proposal(env, d.id, spec({ notify_at: iso(Date.now() + 31 * 86400000) }));
    assert.throws(() => env.store.confirmFollowup(d.id, p.id, 'approve'), /DEVICE_EXPIRES/u);
    assert.equal(env.store.followupPage().items.length, 0);
    // A normal, in-range request is still usable after this business denial.
    const normal = await active(env, d.id); env.store.revoke(d.id);
    assert.equal(env.store.followup(normal.commitment).notification_status, 'suspended_device');
    assert.equal(env.store.followupTick(Date.now() + 32 * 86400000), 0);
  } finally { env.close(); }
});

test('proposal insertion failure cannot publish an answer or checkpoint that falsely promises stored work', async () => {
  const env = environment(), d = env.store.addDevice('phone');
  try {
    const seq = env.store.submit(d.id, randomUUID(), input).seq; env.store.claim();
    const raw = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    raw.exec("CREATE TRIGGER broken_proposal BEFORE INSERT ON followup_proposals BEGIN SELECT RAISE(ABORT,'fault'); END;");
    const checkpoint = new ConversationAssistant({ chat: async () => reply('unused') }, noSources).checkpoint();
    assert.throws(() => env.store.finish(seq, { text: 'saved', sources: [] }, checkpoint,
      [{ id: randomUUID(), spec: spec(), timezone: 'Asia/Seoul' }]), /STORAGE_FAILED/u);
    assert.equal(raw.prepare('SELECT state,answer FROM turns WHERE seq=?').get(seq).state, 'running');
    assert.equal(raw.prepare('SELECT state,answer FROM turns WHERE seq=?').get(seq).answer, null);
    assert.equal(raw.prepare('SELECT count(*) n FROM context').get().n, 0);
    raw.exec('DROP TRIGGER broken_proposal'); raw.close(); env.reopen();
    assert.equal(env.store.turn(seq).state, 'interrupted'); assert.equal(env.store.followupState().proposals.length, 0);
  } finally { env.close(); }
});

test('same-model conversation, actual HTTP Bot serializer, cross-device state and reopened host deliver one due follow-up', async () => {
  const env = environment(); const upstream = { updates: [], delivered: [] }; let nextUpdate = 1, nextMessage = 10;
  const wire = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); const method = req.url.split('/').at(-1);
    let result;
    if (method === 'getMe') result = { id: 33333, is_bot: true, username: 'fixture_bot' };
    else if (method === 'getWebhookInfo') result = { url: '' };
    else if (method === 'getUpdates') result = upstream.updates.filter(u => u.update_id >= (payload.offset ?? 0));
    else if (method === 'sendMessage') {
      upstream.delivered.push(payload.text);
      result = { message_id: 100 + upstream.delivered.length, chat: { id: 555, type: 'private' },
        from: { id: 33333, is_bot: true }, text: payload.text };
    } else { res.writeHead(400); res.end(JSON.stringify({ ok: false, error_code: 400 })); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  wire.listen(0, '127.0.0.1'); await once(wire, 'listening');
  const api = () => new TelegramAPI(`33333:${'F'.repeat(24)}`, (options, callback) => {
    assert.equal(options.hostname, 'api.telegram.org'); assert.equal(options.protocol, 'https:');
    return request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: wire.address().port }, callback);
  });
  const push = text => upstream.updates.push({ update_id: nextUpdate++, message: { message_id: nextMessage++,
    chat: { id: 555, type: 'private' }, from: { id: 555, is_bot: false }, text } });
  const args = spec(); let modelCalls = 0, readWork;
  const model = { async chat(messages) {
    modelCalls++;
    if (modelCalls === 1) return reply('', [call('propose_followup', args)]);
    if (modelCalls === 2) return reply('내용과 알릴 시각을 제안했어요.');
    if (modelCalls === 3) return reply('', [call('list_followups', { status: 'active', offset: 0 })]);
    readWork = JSON.parse(messages.filter(m => m.role === 'tool').at(-1).content);
    return reply(`맡겨둔 일은 ${readWork.items[0].title}이고, ${readWork.items[0].waiting_for}을 기다리고 있어요.`);
  } };
  let service = new ContactService(env.store, model, noSources, { timezone: 'Asia/Seoul' });
  let telegram = new TelegramContact(env.store, service, api()), net;
  let sendClock = Date.now();
  const flush = async () => { for (let i = 0; i < 20; i++) { sendClock += 2000; if (!await telegram.deliverOnce(sendClock)) break; } };
  try {
    await telegram.initialize(); let candidate;
    telegram.on('pairing', value => { candidate = value.candidate; });
    push(`/start ${new URL(telegram.pair()).searchParams.get('start')}`); await telegram.pollOnce();
    assert.ok(candidate); telegram.approve(candidate); await flush();
    push(input); await telegram.pollOnce(); await service.idle(); await flush();
    const p = env.store.followupState().proposals[0]; assert.ok(p);
    assert.ok(upstream.delivered.some(text => text.includes(`/confirm ${p.id}`)));
    push(`/confirm ${p.id}`); await telegram.pollOnce(); await flush();
    assert.equal(env.store.followup(p.id).version, 1);
    const assistantIdentity = env.store.id;
    await telegram.close(); await service.close(); env.reopen();
    service = new ContactService(env.store, model, noSources, { timezone: 'Asia/Seoul' });
    telegram = new TelegramContact(env.store, service, api()); await telegram.initialize();
    push('맡겨둔 일 뭐가 남았어?'); await telegram.pollOnce(); await service.idle(); await flush();
    assert.equal(readWork.items[0].id, p.id); assert.equal(env.store.id, assistantIdentity);
    net = await network(env.store, service); const pc = await net.pair('another PC');
    const state = await net.rpc('/api/state', undefined, pc.cookie);
    assert.equal(state.body.followups.items[0].id, p.id);
    assert.ok(state.body.turns.some(t => t.text === input));
    const before = upstream.delivered.length, callsBefore = modelCalls;
    assert.equal(service.tickFollowups(followupInstant(args.notify_at) + 1000), 1); await flush();
    assert.equal(upstream.delivered.length, before + 1);
    assert.match(upstream.delivered.at(-1), /약속한 확인 시각/u);
    assert.match(upstream.delivered.at(-1), /외부 회신을 자동 확인한 것은 아니에요/u);
    assert.equal(service.tickFollowups(followupInstant(args.notify_at) + 2000), 0); await flush();
    assert.equal(upstream.delivered.length, before + 1); assert.equal(modelCalls, callsBefore);
    console.log('CONTACT_FOLLOWUP_E2E ' + JSON.stringify({
      qualification: 'synthetic model and local Telegram HTTP simulator; not live account evidence',
      user_input: input, followup_input: '맡겨둔 일 뭐가 남았어?',
      same_assistant_after_restart: env.store.id === assistantIdentity,
      pc_and_telegram_share_commitment: state.body.followups.items[0].id === p.id,
      model_requests: modelCalls, due_notice_count: upstream.delivered.length - before,
      reminder_model_requests: modelCalls - callsBefore, record_state: env.store.followup(p.id).state,
      actual_due_message: upstream.delivered.at(-1), mailbox_observation: false,
    }));
  } finally { await net?.host.close(); await telegram.close(); await service.close(); env.close(); wire.closeAllConnections(); wire.close(); await once(wire, 'close'); }
});

test('actual CLI startup and reopen accept contact v4 with Telegram instead of retaining obsolete version guards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-followup-entry-'));
  const code = join(root, 'runtime');
  mkdirSync(join(code, 'packages/providers/src'), { recursive: true });
  cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(code, 'packages/engine/src'), { recursive: true });
  cpSync(fileURLToPath(new URL('../../../apps/contact', import.meta.url)), join(code, 'apps/contact'), { recursive: true });
  // Copy product sources unchanged, replace only the not-exercised native read
  // adapter and inference endpoint in this private test tree. This proves CLI
  // wiring, not real Ollama capability or physical terminal behavior.
  writeFileSync(join(code, 'packages/providers/src/ollama-local.mjs'), `export class OllamaLocal {
    async inspect() { return {provider:'fixture',model:'fixture',model_digest:'fixture'}; }
    async chat() { throw Error('INFERENCE_NOT_EXPECTED'); }
  }`);
  writeFileSync(join(code, 'packages/engine/src/native-sources.mjs'), 'export class NativeSources {}\nexport function runReadGateway() {throw Error("NO_SOURCE_EXPECTED")}');
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume actual request */ }
    const method = req.url.split('/').at(-1);
    const result = method === 'getMe' ? { id: 33333, is_bot: true, username: 'fixture_bot' }
      : method === 'getWebhookInfo' ? { url: '' } : [];
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  try {
    const directory = join(root, 'private');
    for (const initialize of [true, false]) {
      const available = createServer(); available.listen(0, '127.0.0.1'); await once(available, 'listening');
      const port = available.address().port; available.close(); await once(available, 'close');
      const args = ['--data', directory, ...(initialize ? ['--init'] : []), '--model', 'fixture', '--telegram', '--timezone', 'Asia/Seoul', '--port', String(port)];
      const values = [passphrase, ...(initialize ? [passphrase] : []), 'YES', `33333:${'F'.repeat(24)}`];
      const source = `
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        import {EventEmitter} from 'node:events';
        const require=createRequire(import.meta.url), questions=${JSON.stringify(values)};
        const readline=require('node:readline/promises');
        readline.createInterface=()=>Object.assign(new EventEmitter(), {
          question:async()=>{if(!questions.length)throw Error('EXTRA_QUESTION');return questions.shift()},
          close(){this.emit('close')},
          async *[Symbol.asyncIterator](){yield '/telegram-status';yield '/quit'}
        });
        require('node:https').request=(options, callback)=>require('node:http').request({...options,
          protocol:'http:',hostname:'127.0.0.1',port:${upstream.address().port}},callback);
        syncBuiltinESMExports();
        Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});
        const {main}=await import(${JSON.stringify(pathToFileURL(join(code, 'packages/engine/src/contact-cli.mjs')).href)});
        await main(${JSON.stringify(args)});
        if(questions.length)throw Error('SETUP_NOT_CONSUMED');
        console.log('CONTACT_V4_CLI_STARTED_AND_STOPPED');
      `;
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000); timeout.unref();
      const [exit] = await once(child, 'exit'); clearTimeout(timeout);
      // Do not echo the disposable pairing link or fixture token on failure.
      assert.equal(exit, 0, stderr.replace(/33333:[A-Za-z0-9_-]+/gu, '[fixture credential]'));
      assert.match(stdout, /CONTACT_V4_CLI_STARTED_AND_STOPPED/u);
      assert.match(stdout, /Tada 연락 호스트가 열렸습니다/u);
      const db = new DatabaseSync(join(directory, 'contact.sqlite'), { readOnly: true });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4); db.close();
    }
  } finally { upstream.closeAllConnections(); upstream.close(); await once(upstream, 'close'); rmSync(root, { recursive: true, force: true }); }
});
