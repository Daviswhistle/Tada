import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { DesktopNotices } from '../src/desktop-notices.mjs';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { ATTENTION_CONSENT, ATTENTION_INTERVAL } from '../src/attention.mjs';
import { GOOGLE_SCOPES } from '../src/google-contract.mjs';
const noon = Date.parse('2026-10-10T12:00:00Z');
const sources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const checkpoint = () => new ConversationAssistant({}, sources).checkpoint();
function env(t) {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const root = mkdtempSync(join(tmpdir(), 'tada-desktop-')), directory = join(root, 'journal');
  const config = { directory, passphrase: 'SYNTHETIC_DESKTOP_KEY_ONLY', route: contactRoute({ fixture: 'desktop-news' }) };
  let store = new ContactStore({ ...config, initialize: true, assistance: true });
  const device = store.addDevice('synthetic owner').id;
  store.saveGoogleCredential(device, { version: 1, epoch: randomUUID(), device, scopes: [...GOOGLE_SCOPES], refresh_token: 'SYNTHETIC_REFRESH_TOKEN_ONLY', email: 'owner@example.test', connected_at: noon, last_checked: null, last_error: null, reconnect_required: false }, null);
  store.configureProactive(device, true, ATTENTION_CONSENT, 'UTC', noon);
  return { root, directory, device, config, path: join(directory, 'desktop-notices.v1.enc'), get store() { return store; },
    reopen() { store.close(); store = new ContactStore(config); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function observe(e, events = [], fingerprint = 'a'.repeat(64)) {
  const at = Date.now(), ticket = e.store.claimAttention(at); assert.ok(ticket);
  e.store.finishAttention(ticket, { observed_at: at, events, fingerprint, truncated: false, account: 'owner@example.test' }, at);
}
function answer(e, quiet = false) {
  const job = e.store.claim(); assert.ok(job);
  e.store.finish(job.seq, { text: 'SYNTHETIC_PRIVATE_SUGGESTION', sources: [], ...(quiet ? { quiet: true } : {}) }, checkpoint());
  return job.seq;
}
const event = at => ({ id: 'event1', title: 'SYNTHETIC_PRIVATE_MEETING', start: at + 20 * 60000, day: null });
function work(e, overrides = {}) {
  const text = '약속한 시각에 회신 확인할 일을 챙겨 줘.', seq = e.store.submit(e.device, randomUUID(), text).seq;
  assert.equal(e.store.claim().seq, seq);
  const proposal = { id: randomUUID(), timezone: 'UTC', spec: { operation_id: 'fixture_work_' + seq, target: null, expected_version: 0,
    title: 'SYNTHETIC_PRIVATE_WORK', details: '회신 확인', state: 'open', waiting_for: null, notify_at: new Date(Date.now() + 60000).toISOString().replace('.000Z', 'Z'), user_quote: text, ...overrides } };
  e.store.finish(seq, { text: '알림을 준비했어요.', sources: [] }, checkpoint(), [proposal]);
  return e.store.confirmFollowup(e.device, proposal.id, 'approve');
}

test('first activation skips old results; new suggestion is attempted once across restart without changing the schema', t => {
  const e = env(t); try {
    observe(e); answer(e); e.store.prepareDesktopNotices(); assert.equal(e.store.takeDesktopNotices(), false);
    t.mock.timers.setTime(noon + 3600000); observe(e, [], 'b'.repeat(64)); answer(e);
    assert.equal(e.store.takeDesktopNotices(), true); assert.equal(e.store.takeDesktopNotices(), false);
    const bytes = readFileSync(e.path); assert.equal(bytes.includes(Buffer.from('SYNTHETIC_PRIVATE')), false);
    e.reopen(); assert.equal(e.store.contactVersion, 5); assert.equal(e.store.takeDesktopNotices(), false);
    assert.equal(e.store.page().turns.length, 2); assert.equal(e.store.usage().requests, 0);
    assert.deepEqual(readFileSync(e.path), bytes, 'no-op checks do not rewrite the cache');
  } finally { e.close(); }
});
test('a lower-sequence pending suggestion still alerts after a higher calendar result and restart', t => {
  const e = env(t); try {
    observe(e); e.store.prepareDesktopNotices();
    t.mock.timers.setTime(noon + ATTENTION_INTERVAL); observe(e, [event(Date.now())]);
    assert.equal(e.store.takeDesktopNotices(), true);
    e.reopen(); answer(e); assert.equal(e.store.takeDesktopNotices(), true);
    assert.equal(e.store.takeDesktopNotices(), false);
  } finally { e.close(); }
});
for (const change of ['quiet', 'off', 'revoked', 'expired', 'google_changed', 'owner_message']) test(`new suggestion is suppressed when ${change}`, t => {
  const e = env(t); try {
    e.store.prepareDesktopNotices(); observe(e); answer(e, change === 'quiet');
    if (change === 'off') e.store.configureProactive(e.device, false, null, 'UTC');
    if (change === 'revoked') e.store.revoke(e.device);
    if (change === 'expired') t.mock.timers.setTime(noon + 31 * 86400000);
    if (change === 'google_changed') e.store.clearGoogleCredential(e.device);
    if (change === 'owner_message') e.store.submit(e.device, randomUUID(), '새로 알려줄 내용이 있어.');
    assert.equal(e.store.takeDesktopNotices(), false);
  } finally { e.close(); }
});
for (const change of ['removed', 'stale', 'google_changed']) test(`calendar notification does not replay when ${change}`, t => {
  const e = env(t); try {
    e.store.prepareDesktopNotices(); observe(e, [event(Date.now())]);
    if (change === 'removed') { t.mock.timers.setTime(noon + ATTENTION_INTERVAL); observe(e); }
    if (change === 'stale') { t.mock.timers.setTime(noon + 60001); e.reopen(); }
    if (change === 'google_changed') e.store.clearGoogleCredential(e.device);
    assert.equal(e.store.takeDesktopNotices(), false);
  } finally { e.close(); }
});
test('corrupt or foreign notification cache never poisons the conversation store', t => {
  const e = env(t); try {
    e.store.prepareDesktopNotices(); e.reopen(); writeFileSync(e.path, 'CORRUPT');
    assert.throws(() => e.store.prepareDesktopNotices(), /DESKTOP_NOTICES_UNAVAILABLE/);
    const device = e.store.addDevice('still works'); assert.ok(e.store.submit(device.id, randomUUID(), '대화는 계속').seq);
    e.reopen(); assert.equal(e.store.page().turns.length, 1);
  } finally { e.close(); }
});
test('sidecar copied to another journal fails closed for notifications only', t => {
  const e = env(t); let other; try {
    e.store.prepareDesktopNotices(); const directory = join(e.root, 'other');
    other = new ContactStore({ ...e.config, directory, initialize: true, assistance: true });
    copyFileSync(e.path, join(directory, 'desktop-notices.v1.enc'));
    assert.throws(() => other.prepareDesktopNotices(), /DESKTOP_NOTICES_UNAVAILABLE/);
    assert.equal(other.page().turns.length, 0);
  } finally { other?.close(); e.close(); }
});
test('service sends no body, starts after readiness, and stops notifications before draining', async t => {
  const e = env(t); let service; try {
    const messages = [];
    service = new ContactService(e.store, { chat: async () => { throw Error('UNEXPECTED_MODEL_CALL'); } }, sources, { desktopNotify: (...args) => messages.push(args) });
    observe(e, [event(Date.now())]); const queued = e.store.claim(); if (queued) e.store.fail(queued.seq, 'FIXTURE_CANCELLED');
    service.emit('change'); assert.equal(messages.length, 0); service.start(); await service.idle();
    assert.deepEqual(messages, [[]]); assert.equal(service.desktopNotifications.active, true);
    service.emit('change'); assert.equal(messages.length, 1);
    service.beginStop(); assert.equal(service.desktopNotifications.active, false);
    t.mock.timers.setTime(noon + ATTENTION_INTERVAL); observe(e, [{ ...event(Date.now()), id: 'event2' }]);
    service.emit('change'); assert.equal(messages.length, 1);
  } finally { await service?.close(); e.close(); }
});
test('notification persistence failure disables only that channel and keeps normal conversation available', async t => {
  const e = env(t); let service; try {
    writeFileSync(e.path, 'CORRUPT'); let calls = 0;
    service = new ContactService(e.store, { chat: async () => { calls++; return { message: { role: 'assistant', content: '연결됐어요.' }, input_tokens: 1, output_tokens: 1 }; } }, sources, { desktopNotify: () => assert.fail('must not notify') });
    service.submit(e.device, randomUUID(), '인사해 줘.'); await service.idle();
    assert.equal(calls, 1); assert.equal(e.store.page().turns[0].state, 'answered');
    assert.equal(service.desktopNotifications.error, true); assert.equal(service.stopped, false);
  } finally { await service?.close(); e.close(); }
});
test('symlinked cache is rejected without touching its target', { skip: process.platform === 'win32' }, t => {
  const e = env(t); try {
    const target = join(e.root, 'keep'); writeFileSync(target, 'KEEP', { mode: 0o600 }); symlinkSync(target, e.path);
    assert.throws(() => e.store.prepareDesktopNotices(), /DESKTOP_NOTICES_UNAVAILABLE/);
    assert.equal(readFileSync(target, 'utf8'), 'KEEP'); assert.equal(statSync(target).size, 4);
  } finally { e.close(); }
});
for (const change of ['none', 'seen', 'cancelled', 'expired', 'revoked']) test(`followup notice uses current work and device state: ${change}`, t => {
  const e = env(t); try {
    e.store.prepareDesktopNotices(); const item = work(e);
    t.mock.timers.setTime(noon + 60000); assert.equal(e.store.followupTick(), 1);
    const notice = e.store.followupState().notices[0];
    if (change === 'seen') e.store.dismissFollowupNotice(e.device, notice.id);
    if (change === 'cancelled') work(e, { target: item.commitment, expected_version: 1, state: 'cancelled', notify_at: null });
    if (change === 'expired') t.mock.timers.setTime(noon + 31 * 86400000);
    if (change === 'revoked') e.store.revoke(e.device);
    assert.equal(e.store.takeDesktopNotices(), change === 'none');
    e.reopen(); assert.equal(e.store.takeDesktopNotices(), false);
  } finally { e.close(); }
});
test('a failed native handoff is not retried after the attempt was persisted', async t => {
  const e = env(t); let service; try {
    let calls = 0;
    service = new ContactService(e.store, {}, sources, { desktopNotify: () => { calls++; throw Error('SYNTHETIC_PIPE_FAILURE'); } });
    observe(e, [event(Date.now())]); const pending = e.store.claim(); if (pending) e.store.fail(pending.seq, 'FIXTURE_CANCELLED');
    service.start(); await service.idle(); assert.equal(calls, 1); assert.equal(service.desktopNotifications.error, true);
    await service.close(); service = null; e.reopen();
    service = new ContactService(e.store, {}, sources, { desktopNotify: () => calls++ }); service.start(); await service.idle();
    assert.equal(calls, 1); assert.equal(e.store.page().turns.some(t => t.answer?.calendar_reminder), true);
  } finally { await service?.close(); e.close(); }
});
test('external cache damage during a host lifetime is preserved instead of overwritten', t => {
  const e = env(t); try {
    e.store.prepareDesktopNotices(); writeFileSync(e.path, 'DAMAGED'); observe(e); answer(e);
    assert.throws(() => e.store.takeDesktopNotices(), /DESKTOP_NOTICES_UNAVAILABLE/);
    assert.equal(readFileSync(e.path, 'utf8'), 'DAMAGED'); assert.equal(e.store.page().turns[0].state, 'answered');
  } finally { e.close(); }
});
test('restored historical suggestions and due notices never become new desktop notifications', t => {
  const e = env(t); let restored; try {
    observe(e); answer(e); work(e); t.mock.timers.setTime(noon + 60000); e.store.followupTick();
    e.store.prepareDesktopNotices();
    const snapshot = e.store.exportRecords(e.device, { provider: null, google_client: null });
    assert.equal(JSON.stringify(snapshot).includes('desktop-notices'), false);
    restored = new ContactStore({ ...e.config, directory: join(e.root, 'restored'), initialize: true, recovery: snapshot });
    assert.ok(restored.page().turns.some(row => row.recovery));
    assert.equal(restored.takeDesktopNotices(), false);
  } finally { restored?.close(); e.close(); }
});
test('a decryptable future cache version is preserved and rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-desktop-version-')), key = randomBytes(32), id = randomUUID();
  try {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(`${id}:desktop-notices:v1`));
    const bytes = Buffer.concat([iv, cipher.update(JSON.stringify({ version: 2, through: 0, pending: [], notices: [] })), cipher.final(), cipher.getAuthTag()]);
    const path = join(root, 'desktop-notices.v1.enc'); writeFileSync(path, bytes, { mode: 0o600 });
    assert.throws(() => new DesktopNotices(root, key, id).prepare(() => assert.fail('must not reset')), /DESKTOP_NOTICES_UNAVAILABLE/);
    assert.deepEqual(readFileSync(path), bytes);
  } finally { key.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test('starting after the due time notifies immediately without another change or model request', async t => {
  const e = env(t); let service; try {
    work(e); e.store.prepareDesktopNotices(); e.reopen();
    t.mock.timers.setTime(noon + 60000);
    let calls = 0;
    service = new ContactService(e.store, { chat: async () => assert.fail('no model request') }, sources, { desktopNotify: () => calls++ });
    service.start(); await service.idle();
    assert.equal(e.store.followupState().notices.length, 1); assert.equal(calls, 1);
    service.start(); service.emit('change'); assert.equal(calls, 1);
    await service.close(); service = null; e.reopen();
    service = new ContactService(e.store, {}, sources, { desktopNotify: () => calls++ });
    service.start(); await service.idle(); assert.equal(calls, 1);
  } finally { await service?.close(); e.close(); }
});
test('a separately connected Google device expiring suppresses an otherwise fresh calendar notice', t => {
  const e = env(t); try {
    // The Google owner was added first; the proactive device remains valid.
    const at = noon + 30 * 86400000 - 30000; t.mock.timers.setTime(at);
    const proactiveDevice = e.store.addDevice('new proactive owner').id;
    e.store.configureProactive(e.device, false, null, 'UTC');
    e.store.configureProactive(proactiveDevice, true, ATTENTION_CONSENT, 'UTC');
    e.store.prepareDesktopNotices(); observe(e, [event(at)]);
    t.mock.timers.setTime(at + 30001);
    e.store.assertDevice(proactiveDevice); assert.equal(e.store.googleConnected(), false);
    assert.equal(e.store.takeDesktopNotices(), false);
  } finally { e.close(); }
});
test('service created before an explicit old-record upgrade initializes desktop notifications afterward', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const root = mkdtempSync(join(tmpdir(), 'tada-desktop-upgrade-'));
  const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'SYNTHETIC_OLD_JOURNAL_ONLY', route: contactRoute({ fixture: 'old-notifications' }), initialize: true, reviews: true });
  let service; try {
    const e = { store, device: store.addDevice('synthetic owner').id }; let calls = 0;
    assert.equal(store.contactVersion, 4);
    service = new ContactService(store, {}, sources, { desktopNotify: () => calls++ });
    assert.equal(service.desktopNotifications.error, false); assert.equal(service.desktopNotifications.active, false);
    const backup = await store.upgradeAssistance(); assert.ok(backup);
    work(e); t.mock.timers.setTime(noon + 60000);
    service.start(); await service.idle();
    assert.equal(store.contactVersion, 5); assert.equal(service.desktopNotifications.active, true);
    assert.equal(service.desktopNotifications.error, false); assert.equal(calls, 1);
  } finally { await service?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
