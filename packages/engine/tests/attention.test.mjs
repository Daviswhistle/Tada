import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { GOOGLE_SCOPES } from '../src/google-contract.mjs';
import { ATTENTION_CONSENT, ATTENTION_INTERVAL, attentionEvent, observeAttention, validAttention } from '../src/attention.mjs';
const sources = { definitions: [], validate: () => false, verify: async () => false };
function env() {
  const root = mkdtempSync(join(tmpdir(), 'tada-attention-')), directory = join(root, 'private');
  const config = { directory, passphrase: 'test-only-attention-password', route: contactRoute({ fixture: 'attention' }) };
  let store = new ContactStore({ ...config, initialize: true, assistance: true });
  const device = store.addDevice('fixture owner');
  store.saveGoogleCredential(device.id, { version: 1, epoch: randomUUID(), device: device.id, scopes: [...GOOGLE_SCOPES], refresh_token: 'fixture-only-not-a-real-token', email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false }, null);
  return { device: device.id, directory, get store() { return store; }, reopen() { store.close(); store = new ContactStore(config); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const now = Date.parse('2026-10-09T03:00:00Z');
const view = (time, events = [], fingerprint = 'a'.repeat(64)) => ({ fingerprint, events, truncated: false, observed_at: time, account: 'owner@example.test' });
function settle(store) { const job = store.claim(); if (job) store.fail(job.seq, 'FIXTURE_FAILURE'); }
function enable(e, at = now) { return e.store.configureProactive(e.device, true, ATTENTION_CONSENT, 'Asia/Seoul', at); }

test('v1 is not silently expanded; v2 opt-in survives restart, rejects unknown consent', () => {
  const e = env(); try {
    e.store.configureProactive(e.device, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', now);
    assert.equal(e.store.claimAttention(now), null);
    assert.throws(() => e.store.configureProactive(e.device, true, 'anything', 'Asia/Seoul'), /CONSENT/);
    enable(e); assert.equal(e.store.proactiveStatus().mode, 'continuous'); e.reopen();
    assert.equal(e.store.proactiveStatus().mode, 'continuous'); assert.equal(e.store.proactiveTick(now, true), 0);
    assert.ok(e.store.claimAttention(now)); assert.equal(e.store.claimAttention(now), null);
  } finally { e.close(); }
});
test('unchanged polls create no turns or model use; changes and daily relevance are bounded', () => {
  const e = env(); try {
    enable(e); let ticket = e.store.claimAttention(now);
    assert.equal(e.store.finishAttention(ticket, view(now), now), 1); settle(e.store);
    let count = e.store.page().turns.length;
    for (let i = 1; i < 4; i++) {
      const time = now + i * ATTENTION_INTERVAL; ticket = e.store.claimAttention(time);
      assert.equal(e.store.finishAttention(ticket, view(time), time), 0);
    }
    assert.equal(e.store.page().turns.length, count); assert.equal(e.store.usage().requests, 0);
    for (let hour = 1; hour <= 5; hour++) {
      const time = now + hour * 3600000; ticket = e.store.claimAttention(time);
      assert.equal(e.store.finishAttention(ticket, view(time, [], String(hour).repeat(64)), time), hour < 4 ? 1 : 0); settle(e.store);
    }
    e.reopen(); const nextDay = now + 86400000;
    ticket = e.store.claimAttention(nextDay); assert.equal(e.store.finishAttention(ticket, view(nextDay), nextDay), 1);
    assert.equal(e.store.page().turns.length, count + 4);
  } finally { e.close(); }
});
test('timed alert comes at 30 minutes, persists dedupe through restart and re-enable, handles changed start', () => {
  const e = env(); try {
    enable(e); const event = { id: 'event_1', title: 'Private fixture appointment', start: now + 40 * 60000, day: null };
    let ticket = e.store.claimAttention(now); e.store.finishAttention(ticket, view(now, [event]), now); settle(e.store);
    assert.equal(e.store.proactiveStatus().next_at, now + 10 * 60000);
    let time = now + 10 * 60000; ticket = e.store.claimAttention(time);
    assert.equal(e.store.finishAttention(ticket, view(time, [event]), time), 1);
    const notice = e.store.page().turns.at(-1); assert.equal(notice.answer.calendar_reminder, true); assert.match(notice.answer.text, /30분/);
    e.reopen(); e.store.configureProactive(e.device, false, null, 'Asia/Seoul', time); enable(e, time);
    time += ATTENTION_INTERVAL; ticket = e.store.claimAttention(time); assert.equal(e.store.finishAttention(ticket, view(time, [event]), time), 0);
    time += ATTENTION_INTERVAL; const moved = { ...event, start: time + 20 * 60000 };
    ticket = e.store.claimAttention(time); assert.equal(e.store.finishAttention(ticket, view(time, [moved]), time), 1);
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 2);
    assert.equal(e.store.usage().requests, 0);
    assert.equal(readFileSync(join(e.directory, 'contact.sqlite')).includes(Buffer.from(event.title)), false);
  } finally { e.close(); }
});
test('all-day morning alert, declined/cancelled/ambiguous/malformed events, no late timed reminders', () => {
  const e = env(); try {
    enable(e); const event = attentionEvent({ id: 'all_day', summary: 'All day', start: { date: '2026-10-09' } });
    const late = { id: 'ended', title: 'ended', start: now - 1, day: null };
    const ticket = e.store.claimAttention(now); e.store.finishAttention(ticket, view(now, [event, late]), now);
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 1);
    for (const item of [
      { id: 'x', status: 'cancelled', start: { date: '2026-10-09' } },
      { id: 'x', attendees: [{ self: true, responseStatus: 'declined' }], start: { date: '2026-10-09' } },
      { id: 'x', start: { dateTime: '2026-10-09T12:00:00', timeZone: 'Asia/Seoul' } },
      { id: 'x', start: { date: '2026-02-30' } },
    ]) assert.equal(attentionEvent(item), null);
    assert.equal(validAttention({ version: 2 }), false);
  } finally { e.close(); }
});
for (const action of ['off', 'revoke', 'disconnect']) test(`in-flight ${action} invalidates observed data before notification or model admission`, () => {
  const e = env(); try {
    enable(e); const ticket = e.store.claimAttention(now);
    if (action === 'off') e.store.configureProactive(e.device, false, null, 'Asia/Seoul');
    if (action === 'revoke') e.store.revoke(e.device);
    if (action === 'disconnect') e.store.clearGoogleCredential(e.device);
    assert.throws(() => e.store.finishAttention(ticket, view(now), now), /STOPPED|AUTHORITY/);
    assert.equal(e.store.page().turns.filter(t => t.origin === 'proactive').length, 0);
  } finally { e.close(); }
});
test('source errors remain visible with durable backoff, not successful empty checks', () => {
  const e = env(); try {
    enable(e); const ticket = e.store.claimAttention(now);
    e.store.failAttention(ticket, 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE'); e.reopen();
    assert.equal(e.store.proactiveStatus().attention.error, 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE');
    assert.equal(e.store.proactiveStatus().attention.observed_at, null);
    assert.equal(e.store.claimAttention(now + 1000), null); assert.equal(e.store.page().turns.length, 0);
  } finally { e.close(); }
});
test('observer uses only two bounded read APIs, stable content ignores moving time window, cancellation between reads stops', async () => {
  const e = env(); try {
    enable(e); let ticket = e.store.claimAttention(now), urls = [];
    const connection = { captureGrant: () => ({ connected: true, epoch: e.store.googleEpoch(), email: 'owner@example.test' }), assertSnapshot() {},
      apiJson: async (_device, _epoch, url) => { urls.push(url); return url.hostname.includes('gmail') ? { messages: [{ id: 'mail_1' }] } : { items: [] }; } };
    const a = await observeAttention(e.store, connection, ticket, new AbortController().signal, now);
    const b = await observeAttention(e.store, connection, ticket, new AbortController().signal, now + 1000);
    assert.equal(a.fingerprint, b.fingerprint); assert.equal(urls.length, 4); assert.ok(urls.every(url => url.searchParams.get('maxResults') === '20'));
    connection.apiJson = async () => { e.store.configureProactive(e.device, false, null, 'Asia/Seoul'); return {}; };
    await assert.rejects(observeAttention(e.store, connection, ticket, new AbortController().signal, now), /STOPPED/);
  } finally { e.close(); }
});
test('running service polls without an open browser and handles local-only completion without getting stuck', async () => {
  const e = env(); let service; try {
    e.store.clearGoogleCredential(e.device); enable(e, Date.now());
    // Night-time zone prevents inference; this verifies scheduler lifecycle only.
    const zone = ['Pacific/Honolulu', 'Asia/Seoul', 'Europe/London'].find(z => {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', hourCycle: 'h23' }).format()); return h < 9 || h >= 21;
    });
    e.store.configureProactive(e.device, false, null, zone); e.store.configureProactive(e.device, true, ATTENTION_CONSENT, zone, Date.now());
    service = new ContactService(e.store, { chat: () => { throw Error('MUST_NOT_CALL_MODEL'); } }, sources, { timezone: zone });
    await service.checkAttention(); assert.ok(e.store.proactiveStatus().attention.observed_at);
    assert.equal(e.store.attentionStatus().google_observed, false);
    await service.checkAttention(Date.now() + ATTENTION_INTERVAL + 1);
    assert.equal(e.store.usage().requests, 0);
  } finally { await service?.close(); e.close(); }
});

test('cancelled event stays suppressed when Telegram outbox is built later; reminder joins the same checkpoint', () => {
  const e = env(); try {
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    const welcome = e.store.telegramClaimDelivery(); e.store.telegramDelivery(welcome.id, 'suppressed');
    enable(e); const event = { id: 'event_1', title: 'Fixture meeting', start: now + 25 * 60000, day: null };
    e.store.finishAttention(e.store.claimAttention(now), view(now, [event]), now); settle(e.store);
    const seq = e.store.page().turns.find(t => t.answer?.calendar_reminder).seq;
    assert.equal(e.store.checkpoint().through, 0);
    assert.match(e.store.reminderContext(0, seq + 1), /Fixture meeting/);
    const time = now + ATTENTION_INTERVAL;
    e.store.finishAttention(e.store.claimAttention(time), view(time, []), time);
    assert.deepEqual(e.store.attentionDelivery(seq), { stopped: true });
    e.store.telegramQueueResults(); assert.equal(e.store.telegramClaimDelivery(), null);
    e.reopen(); e.store.telegramQueueResults(); assert.equal(e.store.telegramClaimDelivery(), null);
  } finally { e.close(); }
});
test('same Google account reconnect preserves event dedupe; impossible timed dates are rejected', () => {
  const e = env(); try {
    enable(e); const event = { id: 'event_1', title: 'Fixture meeting', start: now + 29 * 60000, day: null };
    e.store.finishAttention(e.store.claimAttention(now), view(now, [event]), now); settle(e.store);
    const old = e.store.googleCredential(); e.store.saveGoogleCredential(e.device, { ...old, epoch: randomUUID() }, old.epoch);
    const time = now + ATTENTION_INTERVAL;
    e.store.finishAttention(e.store.claimAttention(time), view(time, [event]), time);
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 1);
    assert.equal(attentionEvent({ id: 'bad', start: { dateTime: '2027-02-30T10:00:00Z' } }), null);
  } finally { e.close(); }
});
test('delivery validation re-reads calendar, rejects changed target and revoked authority after await', async () => {
  const e = env(); let service; try {
    const time = Date.now(); enable(e, time);
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    const welcome = e.store.telegramClaimDelivery(); e.store.telegramDelivery(welcome.id, 'suppressed');
    const event = { id: 'event_1', title: 'Fixture meeting', start: time + 20 * 60000, day: null };
    e.store.finishAttention(e.store.claimAttention(time), view(time, [event]), time); settle(e.store);
    e.store.telegramQueueResults(); const delivery = e.store.telegramClaimDelivery(); assert.ok(delivery.turn);
    let current = { items: [{ id: event.id, summary: event.title, start: { dateTime: new Date(event.start).toISOString() } }] }, revoke = false;
    const google = Object.assign(new EventEmitter(), { connect() {}, status: () => ({ connected: true }), close() {},
      captureGrant: () => ({ connected: true, epoch: e.store.googleEpoch(), email: 'owner@example.test' }), assertSnapshot() {},
      apiJson: async (_d, _e, url) => { assert.equal(url.hostname, 'www.googleapis.com'); if (revoke) e.store.configureProactive(e.device, false, null, 'Asia/Seoul'); return current; } });
    service = new ContactService(e.store, {}, sources, { timezone: 'Asia/Seoul' }); service.attachGoogle(google);
    assert.equal(await service.validateDelivery(delivery, new AbortController().signal), true);
    current.items[0].summary = 'Changed title'; assert.equal(await service.validateDelivery(delivery, new AbortController().signal), false);
    current = { items: [] }; assert.equal(await service.validateDelivery(delivery, new AbortController().signal), false);
    revoke = true; await assert.rejects(service.validateDelivery(delivery, new AbortController().signal), /STOPPED/);
  } finally { await service?.close(); e.close(); }
});

test('twenty long calendar titles do not inflate checkpoint or hide a prior interrupted request', async () => {
  const e = env(); let service; try {
    const time = Date.now(); enable(e, time);
    const failed = e.store.submit(e.device, randomUUID(), 'Remember my earlier failed request').seq;
    e.store.claim(); e.store.fail(failed, 'FIXTURE_FAILURE');
    const events = Array.from({ length: 20 }, (_, i) => ({ id: `event_${i}`, title: '한'.repeat(200), start: time + 20 * 60000, day: null }));
    e.store.finishAttention(e.store.claimAttention(time), view(time, events), time); settle(e.store);
    assert.equal(e.store.checkpoint().through, 0);
    let seen;
    service = new ContactService(e.store, { chat: async messages => { seen = messages; return { message: { role: 'assistant', content: 'I can continue.' }, input_tokens: 1, output_tokens: 1 }; } }, sources);
    const accepted = service.submit(e.device, randomUUID(), 'Continue the earlier request'); await service.idle();
    assert.equal(e.store.turn(accepted.seq).state, 'answered');
    assert.ok(seen.some(m => m.content.includes('Remember my earlier failed request')));
    assert.ok(seen.some(m => m.content.includes('Recent historical calendar notices')));
    assert.ok(Buffer.byteLength(JSON.stringify(e.store.checkpoint().value)) < 3000);
  } finally { await service?.close(); e.close(); }
});
test('a deferred outbox item does not block unrelated ready notices or reorder its own parts', () => {
  const e = env(); try {
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    const welcome = e.store.telegramClaimDelivery(); e.store.telegramDelivery(welcome.id, 'queued', { retryAt: Date.now() + 900000 });
    e.store.telegramNote('ready', 'Ready independent notification');
    const ready = e.store.telegramClaimDelivery(); assert.equal(ready.text, 'Ready independent notification');
    e.store.telegramDelivery(ready.id, 'suppressed'); assert.equal(e.store.telegramClaimDelivery(), null);
  } finally { e.close(); }
});

test('multipart notices preserve their own order while an unrelated retry waits', () => {
  const e = env(); try {
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    const welcome = e.store.telegramClaimDelivery(); e.store.telegramDelivery(welcome.id, 'queued', { retryAt: Date.now() + 900000 });
    e.store.telegramNote('long', 'x'.repeat(5000));
    const first = e.store.telegramClaimDelivery(); assert.match(first.text, /^\[1\/2\]/);
    e.store.telegramDelivery(first.id, 'queued', { retryAt: Date.now() + 60000 });
    assert.equal(e.store.telegramClaimDelivery(), null);
    const retried = e.store.telegramClaimDelivery(Date.now() + 60001); assert.equal(retried.id, first.id);
    e.store.telegramDelivery(retried.id, 'unknown'); assert.equal(e.store.telegramClaimDelivery(), null);
  } finally { e.close(); }
});
test('all-day delivery follows persisted owner timezone even when the new host timezone differs', async () => {
  const e = env(); let service; try {
    const time = Date.now(); const { localDay, localHour } = await import('../src/attention.mjs');
    const zones = ['Pacific/Honolulu', 'Asia/Seoul', 'Europe/London'];
    const ownerZone = zones.find(z => localHour(time, z) >= 9 && localHour(time, z) < 21);
    const hostZone = zones.find(z => localDay(time, z) !== localDay(time, ownerZone) || localHour(time, z) < 9 || localHour(time, z) >= 21);
    e.store.configureProactive(e.device, true, ATTENTION_CONSENT, ownerZone, time);
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    e.store.telegramDelivery(e.store.telegramClaimDelivery().id, 'suppressed');
    const event = { id: 'all_day', title: 'Day appointment', start: null, day: localDay(time, ownerZone) };
    e.store.finishAttention(e.store.claimAttention(time), view(time, [event]), time); settle(e.store); e.store.telegramQueueResults();
    const delivery = e.store.telegramClaimDelivery();
    const google = Object.assign(new EventEmitter(), { connect() {}, status: () => ({ connected: true }), close() {},
      captureGrant: () => ({ connected: true, epoch: e.store.googleEpoch(), email: 'owner@example.test' }), assertSnapshot() {},
      apiJson: async () => ({ items: [{ id: event.id, summary: event.title, start: { date: event.day } }] }) });
    service = new ContactService(e.store, {}, sources, { timezone: hostZone }); service.attachGoogle(google);
    assert.equal(await service.validateDelivery(delivery, new AbortController().signal), true);
  } finally { await service?.close(); e.close(); }
});

test('an unrelated conversation does not cancel an observed calendar alert awaiting delivery', () => {
  const e = env(); try {
    enable(e); e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    e.store.telegramDelivery(e.store.telegramClaimDelivery().id, 'suppressed');
    const event = { id: 'event_1', title: 'Still valid', start: now + 25 * 60000, day: null };
    e.store.finishAttention(e.store.claimAttention(now), view(now, [event]), now); settle(e.store);
    e.store.submit(e.device, randomUUID(), 'Tell me a different thing'); e.store.telegramQueueResults();
    const delivery = e.store.telegramClaimDelivery(); assert.ok(delivery);
    assert.doesNotThrow(() => e.store.assertTelegramDelivery(delivery));
    assert.ok(e.store.attentionDelivery(delivery.turn).key);
  } finally { e.close(); }
});
test('Google authentication failure retains the last observation and records the reconnect error', () => {
  const e = env(); try {
    enable(e); e.store.finishAttention(e.store.claimAttention(now), view(now), now); settle(e.store);
    const time = now + ATTENTION_INTERVAL, ticket = e.store.claimAttention(time);
    e.store.noteGoogleError(e.store.googleEpoch(), 'reconnect_required', time);
    assert.equal(e.store.failAttention(ticket, 'CONTACT_GOOGLE_RECONNECT_REQUIRED'), true);
    assert.equal(e.store.proactiveStatus().attention.error, 'CONTACT_GOOGLE_RECONNECT_REQUIRED');
    assert.equal(e.store.proactiveStatus().attention.observed_at, now);
    e.store.configureProactive(e.device, false, null, 'Asia/Seoul'); assert.equal(e.store.failAttention(ticket, 'LATE_ERROR'), false);
  } finally { e.close(); }
});
test('ordinary Telegram reply is not sent if /stop arrives during asynchronous validation', async () => {
  const { TelegramContact } = await import('../src/telegram-contact.mjs');
  const { ConversationAssistant } = await import('../src/conversation.ts');
  const e = env(); let service, telegram; try {
    let release, sends = 0;
    const pending = new Promise(resolve => { release = resolve; });
    service = new ContactService(e.store, {}, sources);
    service.validateDelivery = async () => { await pending; return true; };
    const api = { inspect: async () => ({ id: '1234567', username: 'fixture_bot' }), close() {}, send: async () => { sends++; throw Error('SHOULD_NOT_SEND'); } };
    telegram = new TelegramContact(e.store, service, api); await telegram.initialize();
    const device = e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    e.store.telegramDelivery(e.store.telegramClaimDelivery().id, 'suppressed');
    const seq = e.store.submit(device, randomUUID(), 'Private fixture request').seq; e.store.claim();
    e.store.finish(seq, { text: 'Private fixture response', sources: [] }, new ConversationAssistant({}, sources).checkpoint());
    const sending = telegram.deliverOnce(); service.revoke(device); release(); await sending;
    assert.equal(sends, 0); assert.equal(e.store.telegramClaimDelivery(), null);
  } finally { await telegram?.close(); await service?.close(); e.close(); }
});

test('calendar observation and reminders run while human work is active; inference waits', async () => {
  const e = env(); let service;
  try {
    const time = Date.now(); enable(e, time);
    const pending = e.store.submit(e.device, randomUUID(), 'Long active work'); e.store.claim();
    const google = Object.assign(new EventEmitter(), { connect() {}, status: () => ({ connected: true }), close() {},
      captureGrant: () => ({ connected: true, epoch: e.store.googleEpoch(), email: 'owner@example.test' }), assertSnapshot() {},
      apiJson: async (_d, _e, url) => url.hostname.includes('gmail') ? { messages: [] } : { items: [{ id: 'busy_event', summary: 'Busy fixture appointment', start: { dateTime: new Date(time + 20 * 60000).toISOString() } }] } });
    service = new ContactService(e.store, { chat() { throw Error('MUST_NOT_CALL_MODEL'); } }, sources);
    service.attachGoogle(google); await service.checkAttention(time);
    assert.equal(e.store.turn(pending.seq).state, 'running');
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 1);
    assert.equal(e.store.page().turns.filter(t => t.origin === 'proactive' && !t.answer).length, 0);
    assert.equal(e.store.usage().requests, 0);
  } finally { await service?.close(); e.close(); }
});
test('calendar notice recall remains after unrelated answered turns and a restart', async () => {
  const e = env(); let service; const contexts = [];
  try {
    e.store.clearGoogleCredential(e.device); enable(e);
    e.store.finishAttention(e.store.claimAttention(now), view(now, [{ id: 'recall', title: 'Unique recall appointment', start: now + 20 * 60000, day: null }]), now);
    const model = { chat: async messages => { contexts.push(messages); return { message: { role: 'assistant', content: 'Okay.' }, input_tokens: 1, output_tokens: 1 }; } };
    service = new ContactService(e.store, model, sources);
    service.submit(e.device, randomUUID(), 'An unrelated hello'); await service.idle(); await service.close();
    e.reopen(); service = new ContactService(e.store, model, sources);
    service.submit(e.device, randomUUID(), 'What was the earlier reminder?'); await service.idle();
    assert.equal(contexts.length, 2);
    assert.ok(contexts.every(history => history.some(m => m.content.includes('Unique recall appointment'))));
    assert.ok(!JSON.stringify(e.store.checkpoint().value.history).includes('Unique recall appointment'));
  } finally { await service?.close(); e.close(); }
});
test('calendar API reordering does not count as a source change', async () => {
  const e = env(); try {
    enable(e); const ticket = e.store.claimAttention(now);
    let items = ['event_b', 'event_a'].map(id => ({ id, summary: id, start: { dateTime: new Date(now + 3600000).toISOString() } }));
    const connection = { captureGrant: () => ({ connected: true, epoch: e.store.googleEpoch(), email: 'owner@example.test' }), assertSnapshot() {},
      apiJson: async (_d, _e, url) => url.hostname.includes('gmail') ? { messages: [] } : { items } };
    const a = await observeAttention(e.store, connection, ticket, new AbortController().signal, now);
    items.reverse(); const b = await observeAttention(e.store, connection, ticket, new AbortController().signal, now + 1000);
    assert.equal(a.fingerprint, b.fingerprint);
  } finally { e.close(); }
});


test('a new human message during observation postpones AI suggestions but retains verified calendar timing', () => {
  const e = env(); try {
    enable(e); const ticket = e.store.claimAttention(now);
    e.store.submit(e.device, randomUUID(), 'A new human message');
    e.store.finishAttention(ticket, view(now, [{ id: 'during_chat', title: 'Appointment during chat', start: now + 20 * 60000, day: null }]), now);
    const turns = e.store.page().turns;
    assert.equal(turns.filter(t => t.answer?.calendar_reminder).length, 1);
    assert.equal(turns.filter(t => t.origin === 'proactive' && !t.answer).length, 0);
  } finally { e.close(); }
});

test('a wake request received between empty-queue observation and drain cleanup is not lost', async () => {
  const e = env(); let service;
  try {
    e.store.clearGoogleCredential(e.device);
    const originalClaim = e.store.claim.bind(e.store); let added = false, calls = 0;
    e.store.claim = () => {
      const job = originalClaim();
      if (!job && !added) { added = true; queueMicrotask(() => service.submit(e.device, randomUUID(), 'Arrived during drain cleanup')); }
      return job;
    };
    service = new ContactService(e.store, { chat: async () => { calls++; return { message: { role: 'assistant', content: 'Done' }, input_tokens: 1, output_tokens: 1 }; } }, sources);
    service.start(); await service.idle();
    assert.equal(calls, 1); assert.equal(e.store.page().turns[0].state, 'answered');
  } finally { await service?.close(); e.close(); }
});
test('renaming an upcoming event suppresses the outdated unsent alert without duplicating its occurrence', () => {
  const e = env(); try {
    enable(e); const event = { id: 'renamed', title: 'Old title', start: now + 29 * 60000, day: null };
    e.store.finishAttention(e.store.claimAttention(now), view(now, [event]), now); settle(e.store);
    const prior = e.store.page().turns.find(t => t.answer?.calendar_reminder);
    const later = now + ATTENTION_INTERVAL;
    e.store.finishAttention(e.store.claimAttention(later), view(later, [{ ...event, title: 'New title' }]), later);
    assert.deepEqual(e.store.attentionDelivery(prior.seq), { stopped: true });
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 1);
    assert.match(e.store.turn(prior.seq).answer.text, /Old title/);
  } finally { e.close(); }
});

test('Gmail failure leaves verified calendar reminders working and defers model judgments', async () => {
  const e = env(); try {
    enable(e); let calendarReads = 0;
    const connection = { captureGrant: () => ({ connected: true, epoch: e.store.googleEpoch(), email: 'owner@example.test' }), assertSnapshot() {},
      apiJson: async (_d, _e, url) => { if (url.hostname.includes('gmail')) throw Error('CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE'); calendarReads++; return { items: [{ id: 'mail_failure', summary: 'Calendar still works', start: { dateTime: new Date(now + 29 * 60000).toISOString() } }] }; } };
    for (let step = 0; step < 3; step++) {
      const time = now + step * ATTENTION_INTERVAL, ticket = e.store.claimAttention(time);
      const observation = await observeAttention(e.store, connection, ticket, new AbortController().signal, time);
      e.store.finishAttention(ticket, observation, time);
    }
    assert.equal(calendarReads, 3);
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 1);
    assert.equal(e.store.page().turns.filter(t => t.origin === 'proactive' && !t.answer).length, 0);
    assert.equal(e.store.attentionStatus().error, 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE');
  } finally { e.close(); }
});

test('a delivered calendar occurrence is not sent again after a title edit and restart', () => {
  const e = env(); try {
    e.store.telegramConfigure('1234567'); e.store.telegramBind({ bot: '1234567', chat: '987654', user: '987654', after_message: 0 });
    e.store.telegramDelivery(e.store.telegramClaimDelivery().id, 'suppressed');
    enable(e); const event = { id: 'delivered', title: 'Original', start: now + 29 * 60000, day: null };
    e.store.finishAttention(e.store.claimAttention(now), view(now, [event]), now); settle(e.store);
    e.store.telegramQueueResults(); const delivery = e.store.telegramClaimDelivery();
    e.store.telegramDelivery(delivery.id, 'sent', { receipt: { message_id: 1, bot: delivery.bot, chat: delivery.chat, text_hash: createHash('sha256').update(delivery.text).digest('hex') } });
    e.reopen(); const later = now + ATTENTION_INTERVAL;
    e.store.finishAttention(e.store.claimAttention(later), view(later, [{ ...event, title: 'Renamed' }]), later);
    e.store.telegramQueueResults(); assert.equal(e.store.telegramClaimDelivery(), null);
    assert.equal(e.store.page().turns.filter(t => t.answer?.calendar_reminder).length, 1);
  } finally { e.close(); }
});

test('Google observation status belongs to the currently connected account epoch', () => {
  const e = env();
  try {
    enable(e); e.store.finishAttention(e.store.claimAttention(now), view(now), now); settle(e.store);
    assert.equal(e.store.attentionStatus().google_observed, true);
    const previous = e.store.googleCredential(); e.store.clearGoogleCredential(e.device);
    assert.equal(e.store.attentionStatus().google_observed, false);
    e.store.saveGoogleCredential(e.device, { ...previous, epoch: randomUUID() }, null);
    assert.equal(e.store.attentionStatus().google_observed, false);
  } finally { e.close(); }
});
