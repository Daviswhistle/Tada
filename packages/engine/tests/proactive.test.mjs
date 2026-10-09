import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { FollowupSources } from '../src/followup-sources.mjs';
import { ProactiveSources } from '../src/proactive-sources.mjs';
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NOT_CONNECTED'); }, verify: async () => false };
const passphrase = 'fixture-only-proactive-password', route = contactRoute({ fixture: 'proactive' });
const noon = Date.parse('2026-10-08T03:00:00Z');
const consent = 'daily_conversation_suggestions_v1';
function env(assistance = true) {
  const root = mkdtempSync(join(tmpdir(), 'tada-proactive-')), directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase, route, initialize: true, reviews: true, assistance });
  return { root, directory, get store() { return store; }, reopen() { store.close(); store = new ContactStore({ directory, passphrase, route }); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function seed(store, device, text = '다음 주 첫 고객 미팅을 준비 중이야.') {
  const seq = store.submit(device, randomUUID(), text).seq; store.claim();
  const cp = new ConversationAssistant({}, noSources).checkpoint();
  cp.history = [{ role: 'user', content: text }, { role: 'assistant', content: '첫 고객 미팅을 준비 중이시군요.' }];
  store.finish(seq, { text: cp.history[1].content, sources: [] }, cp);
  return seq;
}
const reply = text => ({ message: { role: 'assistant', content: text }, input_tokens: 5, output_tokens: 4 });

test('v4 remains intact until explicit backup migration; grants are disabled by default and encrypted', async () => {
  const e = env(false);
  try {
    const d = e.store.addDevice('owner'); const before = seed(e.store, d.id);
    assert.equal(e.store.proactiveTick(noon), 0);
    assert.throws(() => e.store.configureProactive(d.id, true, consent, 'Asia/Seoul'), /UPGRADE_REQUIRED/);
    const path = await e.store.upgradeAssistance();
    const old = new DatabaseSync(path, { readOnly: true }); assert.equal(old.prepare('PRAGMA user_version').get().user_version, 4); old.close();
    assert.equal(e.store.turn(before).state, 'answered'); assert.equal(e.store.proactiveStatus().enabled, false);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.reopen();
    assert.equal(e.store.proactiveStatus().enabled, true); assert.equal(e.store.contactVersion, 5);
    assert.equal(readFileSync(join(e.directory, 'contact.sqlite')).includes(Buffer.from(consent)), false);
  } finally { e.close(); }
});

test('daily permission is exact; no work, quiet hours, busy queue and unchanged context do not dispatch', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner');
    assert.throws(() => e.store.configureProactive(d.id, true, 'yes', 'Asia/Seoul'), /CONSENT_REQUIRED/);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon - 12 * 3600000);
    assert.equal(e.store.proactiveTick(noon), 0); seed(e.store, d.id);
    assert.equal(e.store.proactiveTick(noon - 12 * 3600000), 0);
    assert.equal(e.store.proactiveTick(noon), 1); assert.equal(e.store.proactiveTick(noon), 0);
    const job = e.store.claim(); assert.equal(job.origin, 'proactive');
    e.store.finish(job.seq, { text: 'NO_NEW_SUGGESTION', sources: [], quiet: true }, e.store.checkpoint().value);
    assert.equal(e.store.proactiveTick(noon + 86400000), 0);
    e.reopen(); assert.equal(e.store.proactiveTick(noon + 86400000), 0);
    seed(e.store, d.id, '자료는 만들었는데 미팅 질문을 아직 생각 못 했어.');
    assert.equal(e.store.proactiveTick(noon + 86400000), 1);
  } finally { e.close(); }
});

test('disable or device revoke cancels a queued check and fences running model and result admission', () => {
  for (const action of ['disable', 'revoke']) {
    const e = env();
    try {
      const d = e.store.addDevice('owner'); seed(e.store, d.id);
      e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
      const job = e.store.claim(); const reservation = e.store.reserve(job.seq);
      if (action === 'disable') e.store.configureProactive(d.id, false, null, 'Asia/Seoul'); else e.store.revoke(d.id);
      e.store.observe(reservation, reply('late'));
      assert.throws(() => e.store.reserve(job.seq), /STOPPED|REVOKED/);
      assert.equal(e.store.finish(job.seq, { text: 'late', sources: [] }, e.store.checkpoint().value), false);
      assert.equal(e.store.usage().requests, 1);
    } finally { e.close(); }
  }
});

test('background tools are read-only and old grants cannot acquire future tools or external reads', async () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    const job = e.store.claim(), sources = new ProactiveSources(e.store, job), signal = new AbortController().signal;
    assert.deepEqual(sources.definitions.map(d => d.function.name), ['list_documents', 'read_document', 'list_followups']);
    for (const name of ['prepare_document', 'propose_followup', 'read_file', 'shell']) assert.equal(sources.validate(name, {}), false);
    assert.throws(() => e.store.prepareDocument(job.seq, { title: 'No write', format: 'text', based_on: null }), /READ_ONLY/);
    assert.equal((await sources.execute('list_followups', { status: 'active', offset: 0 }, signal)).items.length, 0);
    for (let i = 0; i < 4; i++) e.store.observe(e.store.reserve(job.seq), reply('counted'));
    assert.throws(() => e.store.reserve(job.seq), /PROACTIVE_REQUEST_LIMIT/);
  } finally { e.close(); }
});

test('subscription uses same service and checkpoint; quiet checks do not change conversation or queue mobile notifications', async () => {
  const e = env(); let service;
  try {
    const d = e.store.addDevice('owner'); const seq = seed(e.store, d.id);
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    let seen;
    service = new ContactService(e.store, { identity: { provider: 'chatgpt-subscription' }, chat: async (messages, tools) => {
      seen = { messages, tools }; return reply('NO_NEW_SUGGESTION');
    } }, noSources);
    service.start(); await service.idle();
    assert.ok(seen.messages.some(m => m.content.includes('첫 고객 미팅')));
    assert.ok(seen.messages[0].content.includes('NOT a new human request'));
    assert.equal(e.store.checkpoint().through, seq);
    assert.equal(e.store.page().turns.at(-1).answer.quiet, true);
    const before = e.store.messagingStatus().deliveries;
    e.store.telegramQueueResults(); assert.deepEqual(e.store.messagingStatus().deliveries, before);
  } finally { await service?.close(); e.close(); }
});

test('interrupted check is never replayed after restart; a useful suggestion joins the continuing conversation', async () => {
  const e = env(); let service;
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    const stopped = e.store.claim(); e.reopen();
    assert.equal(e.store.turn(stopped.seq).state, 'interrupted'); assert.equal(e.store.proactiveTick(noon + 86400000), 0);
    seed(e.store, d.id, '고객 요구사항 질문 목록은 아직 없어.'); e.store.proactiveTick(noon + 86400000);
    service = new ContactService(e.store, { chat: async () => reply('미팅 전에 고객 요구사항 질문 목록을 준비하면 좋겠어요. 초안을 만들어드릴까요?') }, noSources);
    service.start(); await service.idle();
    assert.equal(e.store.page().turns.at(-1).origin, 'proactive');
    assert.match(e.store.checkpoint().value.history.at(-1).content, /질문 목록/);
  } finally { await service?.close(); e.close(); }
});

test('a new owner message makes an in-flight suggestion stale before admission and suppresses old pending delivery', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    const job = e.store.claim(), r = e.store.reserve(job.seq);
    e.store.submit(d.id, randomUUID(), '그 미팅은 취소됐어.'); e.store.observe(r, reply('late'));
    assert.throws(() => e.store.assertTurnAuthority(job.seq), /PROACTIVE_STOPPED/);
    assert.throws(() => e.store.finish(job.seq, { text: '미팅 준비를 제안해요', sources: [] }, e.store.checkpoint().value), /PROACTIVE_STOPPED/);
    e.store.proactiveTick(noon); assert.equal(e.store.turn(job.seq).state, 'cancelled');
  } finally { e.close(); }
});

test('encrypted grant-to-run linkage rejects tampering and unknown schema versions', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    e.store.close(); const db = new DatabaseSync(join(e.directory, 'contact.sqlite'));
    db.prepare('UPDATE proactive_runs SET epoch=?').run(randomUUID()); db.close();
    assert.throws(() => e.reopen(), /PROACTIVE_INVALID/);
  } finally { e.close(); }
});

test('the running host initiates a permitted check without an open browser or a new user request', async () => {
  const e = env(); let service;
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    // Select an ordinary timezone whose current wall clock is within check hours.
    const zones = ['Pacific/Honolulu', 'Asia/Seoul', 'Europe/London'];
    const timezone = zones.find(zone => { const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format()); return h >= 9 && h < 21; });
    assert.ok(timezone);
    let count = 0;
    service = new ContactService(e.store, { chat: async () => { count++; return reply('첫 고객 미팅에서 확인할 질문 목록을 준비해두면 좋겠어요.'); } }, noSources, { timezone });
    service.start(); await service.idle();
    service.configureProactive(d.id, true, consent);
    for (let i = 0; i < 150 && count === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await service.idle(); assert.equal(count, 1); assert.equal(e.store.page().turns.at(-1).origin, 'proactive');
    service.configureProactive(d.id, false, null); assert.equal(e.store.proactiveStatus().enabled, false);
  } finally { await service?.close(); e.close(); }
});

for (const quiet of [false, true]) test(`saved-document check uses recorded evidence and permits quiet completion: ${quiet}`, async () => {
  const e = env(); let service;
  try {
    const d = e.store.addDevice('owner');
    const seq = e.store.submit(d.id, randomUUID(), '공급업체 분석 문서를 저장해 줘.').seq; e.store.claim();
    const evidence = { id: 'S1', source: 'fixture', path: 'supplier.txt', sha256: 'a'.repeat(64), observed_at: new Date().toISOString() };
    const cp = new ConversationAssistant({}, noSources).checkpoint();
    cp.history = [{ role: 'user', content: '공급업체 분석 문서를 저장해 줘.' }, { role: 'assistant', content: 'Saved document. Use read_document.' }]; cp.evidence = [evidence]; cp.nextEvidence = 2;
    const document = e.store.prepareDocument(seq, { title: '공급업체 분석', format: 'text', based_on: null });
    e.store.finish(seq, { text: '납기는 미정입니다. [S1]', sources: [evidence] }, cp, [], document);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    let calls = 0;
    const unavailableExternalSource = { ...noSources, verify: async () => { throw Error('UNAUTHORIZED_EXTERNAL_READ'); } };
    service = new ContactService(e.store, { chat: async () => ++calls === 1
      ? { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_document', arguments: { id: seq } } }] } }
      : reply(quiet ? 'NO_NEW_SUGGESTION' : '저장된 분석에는 당시 납기가 미정이라고 되어 있어요. [S1] 납기 질문 목록을 준비하면 좋겠어요.') }, unavailableExternalSource);
    service.start(); await service.idle();
    const turn = e.store.page().turns.at(-1);
    assert.equal(turn.state, 'answered'); assert.equal(turn.answer.verification, quiet ? 'not_applicable' : 'saved_document_sources_checked');
    assert.deepEqual(turn.answer.sources, quiet ? [] : [evidence]); assert.equal(calls, 2);
    assert.equal(turn.answer.quiet === true, quiet);
    if (quiet) assert.equal(e.store.checkpoint().through, seq);
  } finally { await service?.close(); e.close(); }
});

test('a snapshot verifier rejects unread, mismatched and revoked evidence', async () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    const job = e.store.claim(), sources = new ProactiveSources(e.store, job), signal = new AbortController().signal;
    const evidence = { id: 'S1', source: 'fixture', path: 'missing.txt', sha256: 'b'.repeat(64), observed_at: new Date().toISOString() };
    assert.equal(await sources.verify(evidence, signal), false);
    e.store.configureProactive(d.id, false, null, 'Asia/Seoul');
    await assert.rejects(sources.verify(evidence, signal), /STOPPED/);
  } finally { e.close(); }
});

test('switching off and on preserves daily cooldown and deduplication across restart', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'); seed(e.store, d.id);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon); assert.equal(e.store.proactiveTick(noon), 1);
    const job = e.store.claim(); e.store.finish(job.seq, { text: 'NO_NEW_SUGGESTION', sources: [], quiet: true }, e.store.checkpoint().value);
    const next = e.store.proactiveStatus().next_at;
    e.store.configureProactive(d.id, false, null, 'Asia/Seoul', noon + 1000);
    e.store.configureProactive(d.id, true, consent, 'Asia/Seoul', noon + 2000);
    assert.equal(e.store.proactiveStatus().next_at, next); assert.equal(e.store.proactiveTick(noon + 2000), 0);
    e.reopen(); assert.equal(e.store.proactiveTick(noon + 86400000), 0);
    seed(e.store, d.id, '미팅 날짜가 바뀌었어.'); assert.equal(e.store.proactiveTick(noon + 86400000), 1);
  } finally { e.close(); }
});

test('the quiet marker does not exempt ordinary foreground answers from citation checks', async () => {
  let calls = 0;
  const sources = { definitions: [{ type: 'function', function: { name: 'read_file', description: 'fixture read', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
    validate: name => name === 'read_file', execute: async () => ({ source: 'fixture', path: 'note.txt', content: 'A recorded fact.', sha256: 'a'.repeat(64), observed_at: new Date().toISOString() }), verify: async () => true };
  const model = { chat: async () => ++calls === 1 ? { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] } } : reply('NO_NEW_SUGGESTION') };
  await assert.rejects(new ConversationAssistant(model, sources).ask('Read the note.'), /UNGROUNDED_ANSWER/);
  assert.equal(calls, 3);
});

test('proactive remaining responses count uncertain reservations and never create another allowance', () => {
  const e = env();
  try {
    const device = e.store.addDevice('owner'); seed(e.store, device.id);
    e.store.configureProactive(device.id, true, consent, 'Asia/Seoul', noon); e.store.proactiveTick(noon);
    const job = e.store.claim();
    assert.equal(e.store.requestAllowance(job.seq), 4);
    for (let used = 1; used <= 4; used++) {
      const reservation = e.store.reserve(job.seq); e.store.observe(reservation, used === 1 ? null : reply('fixture'));
      assert.equal(e.store.requestAllowance(job.seq), 4 - used);
    }
    assert.throws(() => e.store.reserve(job.seq), /PROACTIVE_REQUEST_LIMIT/);
    assert.equal(e.store.usage().unknown_requests, 1);
  } finally { e.close(); }
});

test('foreground answers receive current connected care settings instead of obsolete provider limitations', () => {
  const e = env();
  try {
    const device = e.store.addDevice('owner');
    e.store.configureProactive(device.id, true, 'connected_attention_v2', 'Asia/Seoul');
    e.store.submit(device.id, randomUUID(), '자동 확인이 켜져 있는 게 맞아?'); const job = e.store.claim();
    const base = { ...noSources, definitions: ['list_recent_emails', 'list_upcoming_events'].map(name => ({ function: { name } })) };
    const sources = new FollowupSources(base, e.store, job, 'Asia/Seoul', Date.now, false);
    assert.match(sources.hostContext, /Proactive care is ENABLED; mode continuous/);
    assert.match(sources.hostContext, /permitted mail\/calendar changes.*every 15 minutes/);
    assert.match(sources.hostContext, /LOCAL FILE reviews are unavailable/);
    assert.doesNotMatch(sources.hostContext, /No automatic source reviews with this provider/);
    base.definitions = [];
    assert.match(sources.hostContext, /Google mail\/calendar unavailable/);
    assert.doesNotMatch(sources.hostContext, /already checks permitted mail\/calendar|It also checks calendar reminders/);
    e.store.configureProactive(device.id, false, null, 'Asia/Seoul');
    assert.match(sources.hostContext, /Proactive care is DISABLED/);
    assert.doesNotMatch(sources.hostContext, /active standing schedule|no automatic checks are active/);
    assert.match(sources.hostContext, /armed reminders\/reviews are unchanged/);
  } finally { e.close(); }
});

for (const valid of [true, false]) test(`failure diagnostics contain only bounded machine metadata and tool names: ${valid}`, async () => {
  const e = env(); let service; const captured = []; let calls = 0;
  try {
    const device = e.store.addDevice('owner');
    service = new ContactService(e.store, { chat: async () => {
      if (++calls === 1) return { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_followups', arguments: { status: 'active', offset: 0 } } }] } };
      throw Object.assign(Error('CHATGPT_RESPONSE_FAILED'), { code: valid ? 'server_error' : 'SYNTHETIC_PRIVATE_PAYLOAD', status: valid ? 200 : 'SYNTHETIC_PRIVATE_PAYLOAD',
        param: valid ? 'model' : 'input.SYNTHETIC_PRIVATE_PAYLOAD', body_shape: valid ? 'error_object' : 'SYNTHETIC_PRIVATE_PAYLOAD',
        event_type: valid ? 'response.failed' : 'SYNTHETIC_PRIVATE_PAYLOAD', error_type: valid ? 'server_error' : 'SYNTHETIC_PRIVATE_PAYLOAD', error_shape: valid ? 'object' : 'SYNTHETIC_PRIVATE_PAYLOAD',
        body: 'SYNTHETIC_PRIVATE_PAYLOAD', authorization: 'SYNTHETIC_PRIVATE_PAYLOAD', cause: Error('SYNTHETIC_PRIVATE_PAYLOAD') });
    } }, noSources);
    service.on('turn-failed', value => captured.push(value));
    const { seq } = service.submit(device.id, randomUUID(), 'SYNTHETIC_PRIVATE_PAYLOAD'); await service.idle();
    assert.equal(e.store.turn(seq).state, 'failed'); assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], { turn: seq, code: 'CHATGPT_RESPONSE_FAILED', ...(valid ? { provider_code: 'server_error', status: 200, param: 'model', body_shape: 'error_object', event_type: 'response.failed', error_type: 'server_error', error_shape: 'object' } : {}), attempted_tools: ['list_followups'] });
    assert.equal(JSON.stringify(captured).includes('SYNTHETIC_PRIVATE_PAYLOAD'), false);
    assert.equal(e.store.usage().requests, 2); assert.equal(e.store.usage().unknown_requests, 1);
  } finally { await service?.close(); e.close(); }
});
