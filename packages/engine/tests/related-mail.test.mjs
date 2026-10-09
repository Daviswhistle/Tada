import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TelegramContact } from '../src/telegram-contact.mjs';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { GoogleConnection } from '../src/google-connection.mjs';
import { GoogleSources } from '../src/google-sources.mjs';
import { GOOGLE_SCOPES, validRelatedMail } from '../src/google-contract.mjs';
import { validMailSearch } from '../src/related-mail.mjs';
import { observeAttention } from '../src/attention.mjs';

const noSources = { definitions: [], validate: () => false, verify: async () => false };
const budget = { contextLimitBytes: 65536, fits: () => true };
const signal = () => new AbortController().signal;
const evidence = r => ({ id: 'S1', source: r.source, path: r.path, sha256: r.sha256, observed_at: r.observed_at });
const consent = 'related_mail_readonly_v1';
function environment() {
  const root = mkdtempSync(join(tmpdir(), 'tada-related-mail-'));
  const options = { directory: join(root, 'journal'), passphrase: 'synthetic-related-mail-test-only', route: contactRoute({ test: 'related-mail' }) };
  let store = new ContactStore({ ...options, initialize: true, assistance: true });
  const device = store.addDevice('Fixture owner').id;
  const credential = () => ({ version: 1, epoch: randomUUID(), device, scopes: [...GOOGLE_SCOPES],
    refresh_token: 'SYNTHETIC_REFRESH_TOKEN_NEVER_REAL', email: 'owner@example.test', connected_at: Date.now(),
    last_checked: null, last_error: null, reconnect_required: false });
  store.saveGoogleCredential(device, credential(), null);
  const requests = [], now = Date.now();
  const message = (id, labels, offset) => ({ id, threadId: 'thread1', labelIds: labels, internalDate: String(now - offset),
    snippet: `${id} meeting preparation`, payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: labels.includes('SENT') ? 'owner@example.test' : 'colleague@example.test' },
      { name: 'Subject', value: 'Aurora meeting' }, { name: 'Date', value: new Date(now - offset).toUTCString() },
    ], body: { data: Buffer.from(`${id} body with useful preparation detail`).toString('base64url') } } });
  const messages = new Map([
    ['inbox', message('inbox', ['INBOX'], 60000)], ['archive', message('archive', [], 365 * 86400000)],
    ['sent', message('sent', ['SENT'], 30000)], ['third', message('third', [], 50000)],
  ]);
  let sentIds = ['sent'], calendarItems = [], hold = null;
  const fetchImpl = async (input, init) => {
    const url = new URL(input); requests.push({ path: url.pathname, query: url.searchParams.get('q'), format: url.searchParams.get('format') });
    if (hold && url.pathname === hold.path) { const current = hold; hold = null; current.started(); await current.wait; }
    init.signal?.throwIfAborted();
    let value;
    if (url.pathname.endsWith('/token')) value = { access_token: 'SYNTHETIC_ACCESS_TOKEN_NEVER_REAL', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') };
    else if (url.pathname.endsWith('/messages')) {
      const q = url.searchParams.get('q');
      assert.equal(url.searchParams.get('maxResults'), '20');
      value = q.startsWith('in:inbox') ? { messages: [{ id: 'inbox' }] }
        : q.startsWith('in:sent') ? { messages: sentIds.map(id => ({ id })) }
        : url.searchParams.get('pageToken') === 'page2' ? { messages: [{ id: 'sent' }], nextPageToken: 'page3' }
        : url.searchParams.get('pageToken') === 'page3' ? { messages: [{ id: 'third' }] }
        : { messages: [{ id: 'archive' }], nextPageToken: 'page2' };
    } else if (url.pathname.includes('/messages/')) value = messages.get(url.pathname.split('/').at(-1));
    else if (url.pathname.endsWith('/threads/thread1')) {
      assert.equal(url.searchParams.get('format'), 'metadata'); value = { id: 'thread1', messages: [...messages.values()] };
    } else if (url.pathname.endsWith('/events')) value = { items: calendarItems };
    else throw Error('UNEXPECTED_FIXTURE_REQUEST');
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  let connection = new GoogleConnection({ store, clientId: '123456789012-fixture.apps.googleusercontent.com', openBrowser: async () => true, fetchImpl });
  const job = () => { store.submit(device, randomUUID(), 'Aurora 회의 준비 자료와 보낸 기록을 확인해줘.'); return store.claim(); };
  return { root, device, requests, messages, credential, get store() { return store; }, get connection() { return connection; },
    source: () => new GoogleSources(noSources, store, connection, job()),
    enable: () => connection.configureRelatedMail(device, true, consent),
    sent: ids => { sentIds = ids; }, calendar: items => { calendarItems = items; },
    hold(path) { let started, release; const began = new Promise(r => { started = r; }), wait = new Promise(r => { release = r; }); hold = { path, started, wait }; return { began, release }; },
    reopen() { connection.close(); store.close(); store = new ContactStore(options); connection = new GoogleConnection({ store, clientId: '123456789012-fixture.apps.googleusercontent.com', openBrowser: async () => true, fetchImpl }); },
    close() { connection.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('related mail is separate explicit encrypted account-bound permission and survives reopen without widening a replacement account', () => {
  const e = environment();
  try {
    assert.equal(e.store.relatedMailEpoch(), null);
    assert.equal(e.source().definitions.some(d => d.function.name === 'search_related_emails'), false);
    assert.throws(() => e.connection.configureRelatedMail(e.device, true, 'google_readonly_v1'), /CONSENT_REQUIRED/u);
    e.enable(); const epoch = e.store.relatedMailEpoch(), snapshot = e.connection.captureGrant(e.device);
    e.enable(); assert.equal(e.store.relatedMailEpoch(), epoch);
    e.reopen(); assert.equal(e.store.relatedMailEpoch(), epoch);
    e.connection.configureRelatedMail(e.device, false, null); e.enable();
    assert.notEqual(e.store.relatedMailEpoch(), epoch);
    assert.throws(() => e.connection.assertSnapshot(e.device, snapshot), /AUTHORITY_CHANGED/u);
    e.store.saveGoogleCredential(e.device, e.credential(), e.store.googleEpoch());
    assert.equal(e.store.relatedMailEpoch(), null); assert.equal(e.connection.status().related_mail.enabled, false);
    assert.throws(() => e.connection.configureRelatedMail(e.device, 'true', consent), /CONSENT_REQUIRED/u);
    assert.equal(validRelatedMail({ version: 1, enabled: true, epoch: randomUUID(), device: e.device, google_epoch: null }), false);
    assert.equal(validRelatedMail({ version: 1, enabled: false, epoch: randomUUID(), device: e.device, google_epoch: null, extra: true }), false);
  } finally { e.close(); }
});

test('targeted search has literal queries, issued pagination, three-page admission and current cited bodies outside the inbox', async () => {
  const e = environment(); e.enable(); const s = e.source();
  try {
    for (const terms of [['in:anywhere'], ['x" OR *'], [''], ['   '], ['{all}'], ['../secret'], Array(6).fill('topic')])
      assert.equal(validMailSearch({ terms, cursor: null }), false);
    const args = { terms: ['Aurora', '회의'], cursor: null };
    const first = await s.execute('search_related_emails', args, signal(), budget), data = JSON.parse(first.content);
    assert.equal(data.emails[0].id, 'archive'); assert.ok(data.next_cursor);
    assert.equal(e.requests.find(r => r.query).query, '"Aurora" "회의" -in:spam -in:trash -in:drafts');
    assert.equal(s.validate('search_related_emails', { terms: ['Different'], cursor: data.next_cursor }), false);
    assert.equal(s.validate('search_related_emails', { ...args, cursor: randomUUID() }), false);
    const second = await s.execute('search_related_emails', { ...args, cursor: data.next_cursor }, signal(), budget);
    const third = await s.execute('search_related_emails', { ...args, cursor: JSON.parse(second.content).next_cursor }, signal(), budget);
    assert.equal(JSON.parse(third.content).emails[0].id, 'third');
    await assert.rejects(s.execute('search_related_emails', { terms: ['New'], cursor: null }, signal(), budget), /SEARCH_LIMIT/u);
    assert.equal(await s.verify(evidence(first), signal()), true);
    const body = await s.execute('read_email', { id: 'archive' }, signal(), budget);
    assert.match(body.content, /archive body/u); assert.equal(await s.verify(evidence(body), signal()), true);
    e.messages.get('archive').payload.body.data = Buffer.from('changed current body').toString('base64url');
    assert.equal(await s.verify(evidence(body), signal()), false);
    assert.equal(await s.verify({ ...evidence(first), path: 'search/forged' }, signal()), false);
    e.messages.get('archive').labelIds = ['TRASH'];
    assert.equal(await s.verify(evidence(first), signal()), false);
  } finally { e.close(); }
});

test('thread observations expose current sent facts, not resolution, and only disclose eligible messages for body reads', async () => {
  const e = environment(); e.enable(); const s = e.source();
  try {
    e.messages.set('draft', { ...e.messages.get('sent'), id: 'draft', labelIds: ['DRAFT'] });
    e.messages.set('trash', { ...e.messages.get('sent'), id: 'trash', labelIds: ['TRASH'] });
    await s.execute('list_recent_emails', {}, signal(), budget);
    assert.equal(s.validate('read_email_thread', { id: 'thread1' }), false);
    const thread = await s.execute('read_email_thread', { id: 'inbox' }, signal(), budget), content = JSON.parse(thread.content);
    assert.equal(content.messages[0].id, 'sent'); assert.equal(content.messages[0].sent, true);
    assert.equal(content.messages.some(m => ['draft', 'trash'].includes(m.id)), false);
    assert.equal(content.truncated, true); assert.equal(s.validate('read_email', { id: 'draft' }), false);
    assert.equal(s.validate('read_email', { id: 'sent' }), true);
    assert.match(content.reply_status, /no_resolution_inference/u);
    assert.equal(await s.verify(evidence(thread), signal()), true);
    e.messages.get('sent').snippet = 'Updated reply'; assert.equal(await s.verify(evidence(thread), signal()), false);
    const body = await s.execute('read_email', { id: 'sent' }, signal(), budget); assert.match(body.content, /sent body/u);
  } finally { e.close(); }
});

test('a shortened thread retains newest observations and rechecks the same excerpt', async () => {
  const e = environment(); e.enable(); const s = e.source();
  try {
    await s.execute('list_recent_emails', {}, signal(), budget);
    const small = { contextLimitBytes: 65536, fits: r => JSON.parse(r.content).messages.length <= 1 };
    const result = await s.execute('read_email_thread', { id: 'inbox' }, signal(), small);
    const data = JSON.parse(result.content); assert.equal(data.messages.length, 1); assert.equal(data.messages[0].id, 'sent');
    assert.equal(data.truncated, true); assert.equal(await s.verify(evidence(result), signal()), true);
  } finally { e.close(); }
});

test('revoking related mail rejects an in-flight source response and a new grant cannot revive it', async () => {
  const e = environment(); e.enable(); const s = e.source();
  try {
    const held = e.hold('/gmail/v1/users/me/messages');
    const pending = s.execute('search_related_emails', { terms: ['Aurora'], cursor: null }, signal(), budget);
    await held.began; e.connection.configureRelatedMail(e.device, false, null); e.enable(); held.release();
    await assert.rejects(pending, /AUTHORITY_CHANGED/u);
    assert.throws(() => s.assertCurrent(signal()), /AUTHORITY_CHANGED/u);
  } finally { e.close(); }
});

test('automatic checks observe recent sent changes only under the related-mail grant', async () => {
  const e = environment();
  try {
    e.store.configureProactive(e.device, true, 'connected_attention_v2', 'Asia/Seoul');
    const ticket = e.store.claimAttention();
    assert.ok(ticket);
    const before = await observeAttention(e.store, e.connection, ticket, signal());
    assert.equal(e.requests.some(r => r.query?.startsWith('in:sent')), false);
    e.enable();
    assert.throws(() => e.store.assertAttention(ticket), /AUTHORITY_CHANGED/u);
    const nextTicket = e.store.claimAttention(Date.now() + 900001);
    const after = await observeAttention(e.store, e.connection, nextTicket, signal());
    assert.notEqual(after.fingerprint, before.fingerprint);
    e.sent(['sent', 'newreply']);
    const changed = await observeAttention(e.store, e.connection, nextTicket, signal());
    assert.notEqual(changed.fingerprint, after.fingerprint);
    assert.ok(e.requests.some(r => r.query?.startsWith('in:sent')));
  } finally { e.close(); }
});

for (const contextLimitBytes of [14000, 65536]) test(`same conversation composes related search, sent thread and body with current citations at ${contextLimitBytes} bytes`, async () => {
  const e = environment(); e.enable(); let step = 0;
  const tool = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, input_tokens: 7, output_tokens: 4 });
  const model = { identity: { provider: 'chatgpt-subscription', model: 'synthetic' }, contextLimitBytes,
    async chat(messages) {
      step++;
      if (step === 1) return tool('search_related_emails', { terms: ['Aurora'], cursor: null });
      if (step === 2) {
        const result = JSON.parse(messages.findLast(m => m.tool_name === 'search_related_emails').content);
        return tool('read_email_thread', { id: JSON.parse(result.content).emails[0].id });
      }
      if (step === 3) {
        const result = JSON.parse(messages.findLast(m => m.tool_name === 'read_email_thread').content);
        return tool('read_email', { id: JSON.parse(result.content).messages.find(m => m.sent).id });
      }
      return { message: { role: 'assistant', content: '이 대화에는 발신 메일이 있으며 [S2], 본문도 확인했습니다. [S3] 모든 요청의 해결 여부까지 확인된 것은 아닙니다.' }, input_tokens: 7, output_tokens: 4 };
    } };
  const service = new ContactService(e.store, model, noSources, { timezone: 'Asia/Seoul' }); service.attachGoogle(e.connection);
  try {
    const { seq } = service.submit(e.device, randomUUID(), 'Aurora 회의 메일에 답장을 보냈는지 확인해줘.'); await service.idle();
    const turn = e.store.turn(seq); assert.equal(turn.state, 'answered', turn.error); assert.equal(step, 4);
    assert.equal(turn.answer.verification, 'cited_sources_rechecked'); assert.equal(turn.answer.sources.length, 2);
    const checkpoint = e.store.checkpoint().value;
    for (const name of ['search_related_emails', 'read_email_thread', 'read_email']) {
      const message = checkpoint.history.find(m => m.tool_name === name); assert.ok(message);
      assert.match(message.content, /not retained/u); assert.equal(message.content.includes('meeting preparation'), false);
    }
    assert.equal(e.store.followupState().pending.length, 0);
  } finally { await service.close(); e.close(); }
});

test('a reply arriving after related-mail revocation cannot be committed or regain the removed source scope', async () => {
  const e = environment(); e.enable(); let release, ready;
  const waiting = new Promise(r => { ready = r; }), held = new Promise(r => { release = r; }); let calls = 0;
  const model = { identity: { provider: 'chatgpt-subscription', model: 'synthetic' }, async chat() {
    if (++calls === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_related_emails', arguments: { terms: ['Aurora'], cursor: null } } }] }, input_tokens: 1, output_tokens: 1 };
    ready(); await held;
    return { message: { role: 'assistant', content: 'Late reply from removed mail scope [S1]' }, input_tokens: 1, output_tokens: 1 };
  } };
  const service = new ContactService(e.store, model, noSources); service.attachGoogle(e.connection);
  try {
    const { seq } = service.submit(e.device, randomUUID(), '관련 자료를 찾아줘.'); await waiting;
    service.configureRelatedMail(e.device, false, null); e.enable(); release(); await service.idle();
    assert.notEqual(e.store.turn(seq).state, 'answered'); assert.equal(e.store.checkpoint().through, 0);
  } finally { release?.(); await service.close(); e.close(); }
});

test('changing related-mail permission invalidates queued proactive work without resetting its schedule or usage', () => {
  const e = environment();
  try {
    e.enable();
    const now = Math.ceil(Date.now() / 86400000) * 86400000 + 3 * 3600000;
    e.store.configureProactive(e.device, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', now);
    assert.equal(e.store.proactiveTick(now, true), 1);
    const turn = e.store.page().turns.at(-1), next = e.store.proactiveStatus().next_at, usage = e.store.usage();
    assert.equal(turn.state, 'queued');
    e.connection.configureRelatedMail(e.device, false, null);
    assert.equal(e.store.turn(turn.seq).state, 'cancelled');
    e.enable(); assert.equal(e.store.turn(turn.seq).state, 'cancelled');
    assert.equal(e.store.proactiveStatus().next_at, next); assert.deepEqual(e.store.usage(), usage);
  } finally { e.close(); }
});

for (const withdrawal of ['revoke', 'expire']) test(`related-mail consent from another device is checked after token refresh: ${withdrawal}`, async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const e = environment(); let service, held;
  try {
    const consentDevice = e.store.addDevice('Consent device', now - 30 * 86400000 + 60000).id;
    e.connection.configureRelatedMail(consentDevice, true, consent);
    service = new ContactService(e.store, { chat: async () => ({ message: { role: 'assistant', content: '', tool_calls: [
      { function: { name: 'search_related_emails', arguments: { terms: ['Aurora'], cursor: null } } },
    ] }, input_tokens: 1, output_tokens: 1 }) }, noSources);
    service.attachGoogle(e.connection);
    held = e.hold('/token');
    const { seq } = service.submit(e.device, randomUUID(), 'Aurora 관련 자료를 찾아줘.');
    await held.began;
    if (withdrawal === 'revoke') service.revoke(consentDevice); else t.mock.timers.setTime(now + 60000);
    assert.equal(e.store.relatedMailEpoch(), null);
    held.release(); await service.idle();
    assert.equal(e.store.turn(seq).state, 'failed');
    assert.deepEqual(e.requests.map(r => r.path), ['/token'], 'No Gmail request may dispatch after the additional consent ends');
  } finally { held?.release(); await service?.close(); e.close(); }
});

for (const enable of [true, false]) test(`calendar delivery remains independent when related mail changes to ${enable}`, async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const e = environment(); let service, bridge, held, sends = 0;
  try {
    if (!enable) e.enable();
    service = new ContactService(e.store, {}, noSources, { timezone: 'Asia/Seoul' }); service.attachGoogle(e.connection);
    bridge = new TelegramContact(e.store, service, { inspect: async () => ({ id: '1234567', username: 'fixturebot' }), close() {},
      send: async d => { sends++; return { message_id: sends, chat: d.chat, bot: d.bot, text_hash: createHash('sha256').update(d.text).digest('hex') }; } });
    await bridge.initialize(); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    const welcome = e.store.telegramClaimDelivery(now); e.store.telegramDelivery(welcome.id, 'suppressed');
    e.store.configureProactive(e.device, true, 'connected_attention_v2', 'Asia/Seoul', now);
    const event = { id: 'meeting', title: 'Synthetic meeting', start: now + 5 * 60000, day: null };
    e.calendar([{ id: event.id, summary: event.title, start: { dateTime: new Date(event.start).toISOString() } }]);
    e.store.finishAttention(e.store.claimAttention(now), { fingerprint: 'a'.repeat(64), events: [event], truncated: false, observed_at: now, account: 'owner@example.test' }, now);
    const job = e.store.claim(); if (job) e.store.fail(job.seq, 'FIXTURE_INTERRUPTION');
    held = e.hold('/calendar/v3/calendars/primary/events');
    const delivery = bridge.deliverOnce(now); await held.began;
    e.connection.configureRelatedMail(e.device, enable, enable ? consent : null);
    held.release(); await delivery;
    assert.equal(sends, 1, 'The current calendar notice must not be delayed past its start by a mail permission change');
    assert.equal(e.store.messagingStatus().deliveries.queued ?? 0, 0);
    assert.equal(e.requests.some(r => r.path.includes('/gmail/')), false);
  } finally { held?.release(); await bridge?.close(); await service?.close(); e.close(); }
});

test('unlabelled archived mail is discoverable and readable when Google omits its optional labelIds field', async () => {
  const e = environment();
  try {
    e.enable(); delete e.messages.get('archive').labelIds;
    const s = e.source();
    const page = await s.execute('search_related_emails', { terms: ['Aurora'], cursor: null }, signal(), budget);
    assert.equal(JSON.parse(page.content).emails[0]?.id, 'archive');
    const thread = await s.execute('read_email_thread', { id: 'archive' }, signal(), budget);
    assert.ok(JSON.parse(thread.content).messages.some(m => m.id === 'archive' && m.sent === false));
    const body = await s.execute('read_email', { id: 'archive' }, signal(), budget);
    for (const result of [page, thread, body]) assert.equal(await s.verify(evidence(result), signal()), true);
    for (const labels of [null, 'SENT', {}, [5], ['SPAM'], ['TRASH'], ['DRAFT']]) {
      e.messages.get('archive').labelIds = labels;
      assert.equal(await s.verify(evidence(body), signal()), false);
    }
  } finally { e.close(); }
});

for (const change of ['enable', 'disable', 'revoke', 'expire']) test(`interrupted attention rechecks current scope before an imminent calendar event: ${change}`, async t => {
  const now = Date.parse('2026-10-09T03:00:00Z'); t.mock.timers.enable({ apis: ['Date'], now });
  const e = environment(); let held;
  try {
    const consentDevice = e.store.addDevice('Consent device', now - 30 * 86400000 + 60000).id;
    if (change !== 'enable') e.connection.configureRelatedMail(consentDevice, true, consent);
    e.store.configureProactive(e.device, true, 'connected_attention_v2', 'Asia/Seoul', now - 15 * 60000);
    e.store.finishAttention(e.store.claimAttention(now - 15 * 60000), { fingerprint: 'b'.repeat(64), events: [], truncated: false, observed_at: now - 15 * 60000, account: 'owner@example.test' }, now - 15 * 60000);
    const previous = e.store.claim(); if (previous) e.store.fail(previous.seq, 'FIXTURE_INTERRUPTION');
    assert.equal(e.store.proactiveStatus().attention.checks_today, 1);
    e.calendar([{ id: 'nearby', summary: 'Synthetic meeting', start: { dateTime: new Date(now + 5 * 60000).toISOString() } }]);
    const usage = e.store.usage(), ticket = e.store.claimAttention(now);
    held = e.hold('/calendar/v3/calendars/primary/events');
    const observation = observeAttention(e.store, e.connection, ticket, signal(), now);
    await held.began;
    if (change === 'expire') t.mock.timers.setTime(now + 60000);
    else if (change === 'revoke') e.store.revoke(consentDevice);
    else e.connection.configureRelatedMail(consentDevice, change === 'enable', change === 'enable' ? consent : null);
    held.release(); await assert.rejects(observation, /AUTHORITY_CHANGED/);
    e.store.failAttention(ticket, 'CONTACT_GOOGLE_AUTHORITY_CHANGED');
    const fresh = e.store.claimAttention(Date.now());
    assert.ok(fresh, 'A changed mail scope must not postpone an otherwise authorized calendar check by 15 minutes');
    assert.equal(fresh.related_mail_epoch, e.store.relatedMailEpoch());
    const current = await observeAttention(e.store, e.connection, fresh, signal(), Date.now());
    e.store.finishAttention(fresh, current, Date.now());
    assert.equal(e.store.page().turns.filter(turn => turn.answer?.calendar_reminder).length, 1);
    assert.equal(e.store.claimAttention(Date.now()), null, 'Recovery restores the ordinary observation interval');
    assert.deepEqual(e.store.usage(), usage, 'Recovery does not reset usage or run a model');
    assert.equal(e.store.proactiveStatus().attention.checks_today, 1, 'The earlier AI check and its cooldown are retained');
  } finally { held?.release(); e.close(); }
});
