import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { CONTINUING_CONSENT, REQUEST_WINDOW, validContinuingUse } from '../src/continuing-use.mjs';
import { discoveryTools, validCall } from '../src/native-sources.mjs';
import { createServer } from 'node:net';
import { serveContact } from '../src/contact-http.mjs';
import { DocumentSources } from '../src/document-sources.mjs';
const sources = { definitions: [], validate: () => false, verify: async () => false };
const reply = text => ({ message: { role: 'assistant', content: text }, input_tokens: 1, output_tokens: 1 });
const call = (name, args) => ({ ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
function env() {
  const root = mkdtempSync(join(tmpdir(), 'tada-continuing-'));
  const config = { directory: join(root, 'private'), passphrase: 'fixture-only-continuing-password', route: contactRoute({ fixture: 'continuing' }) };
  let store = new ContactStore({ ...config, initialize: true, assistance: true });
  const device = store.addDevice('owner').id;
  return { device, get store() { return store; }, reopen() { store.close(); store = new ContactStore(config); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function running(e, text = 'A current instruction') { e.store.submit(e.device, randomUUID(), text); return e.store.claim().seq; }
test('rolling quota retains uncertain use through restart/toggles and releases at the boundary without resetting totals', t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const e = env(); try {
    const seq = running(e);
    for (let i = 0; i < 7; i++) e.store.reserve(seq);
    assert.throws(() => e.store.configureContinuingUse(e.device, true, 'unknown'), /CONSENT/);
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    assert.equal(e.store.useStatus().remaining, 57);
    for (let i = 0; i < 57; i++) e.store.reserve(seq);
    assert.throws(() => e.store.reserve(seq), /REQUEST_LIMIT/);
    e.store.fail(seq, 'FIXTURE_INTERRUPTION'); e.reopen();
    e.store.configureContinuingUse(e.device, false, null); e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    assert.equal(e.store.useStatus().remaining, 0);
    t.mock.timers.setTime(start - 1000); assert.equal(e.store.useStatus().remaining, 0);
    t.mock.timers.setTime(start + REQUEST_WINDOW - 1); assert.equal(e.store.useStatus().remaining, 0);
    t.mock.timers.setTime(start + REQUEST_WINDOW); assert.equal(e.store.useStatus().remaining, 64);
    const next = running(e); e.store.reserve(next);
    assert.equal(e.store.usage().requests, 65); assert.equal(e.store.usage().unknown_requests, 65);
    assert.equal(e.store.useStatus().remaining, 63);
    t.mock.timers.setTime(start); assert.equal(e.store.useStatus().remaining, 63);
    e.store.revoke(e.device); assert.throws(() => e.store.reserve(next), /STOPPED|REVOKED|PROACTIVE/);
  } finally { e.close(); }
});
test('without consent lifetime cap remains; old daily grants do not acquire rolling inference permission', t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const e = env(); try {
    const seq = running(e); for (let i = 0; i < 64; i++) e.store.reserve(seq);
    assert.throws(() => e.store.reserve(seq), /REQUEST_LIMIT/);
    t.mock.timers.setTime(start + REQUEST_WINDOW); assert.equal(e.store.requestRoom(), 0);
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    t.mock.timers.setTime(start + REQUEST_WINDOW * 2);
    assert.equal(e.store.requestRoom(), 64); assert.equal(e.store.requestRoom('legacy'), 0);
    e.store.configureProactive(e.device, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul');
    assert.equal(e.store.proactiveStatus().blocked_reason, 'usage_limit');
  } finally { e.close(); }
});
for (const expiresDuringTurn of [true, false]) test(`each model request uses current durable allowance; receipts expire during turn=${expiresDuringTurn}`, async t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const e = env(); let service, calls = 0;
  try {
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    const old = running(e);
    for (let i = 0; i < 63; i++) e.store.reserve(old);
    e.store.fail(old, 'FIXTURE_INTERRUPTION');
    t.mock.timers.setTime(start + REQUEST_WINDOW - 100);
    service = new ContactService(e.store, { chat: async () => {
      calls++;
      if (calls === 1) {
        if (expiresDuringTurn) t.mock.timers.setTime(start + REQUEST_WINDOW);
        return call('list_documents', { before: null });
      }
      return reply('No saved document was found.');
    } }, sources);
    const next = service.submit(e.device, randomUUID(), 'Find my saved documents'); await service.idle();
    assert.equal(e.store.turn(next.seq).state, expiresDuringTurn ? 'answered' : 'failed');
    assert.equal(calls, expiresDuringTurn ? 2 : 1);
    assert.equal(e.store.usage().requests, expiresDuringTurn ? 65 : 64);
    if (!expiresDuringTurn) assert.equal(e.store.turn(next.seq).error, 'CONTACT_REQUEST_LIMIT');
  } finally { await service?.close(); e.close(); }
});
test('more than a thousand preserved turns stay usable and historical search is bounded, paged, and read-only', () => {
  const e = env(); try {
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    for (let i = 0; i < 1005; i++) { const seq = running(e, i === 0 ? 'Remember the violet project' : `Prior cancelled work ${i}`); e.store.cancel(seq); }
    const current = running(e, 'Find the violet project');
    let cursor = null, found = null, pages = 0;
    do {
      const page = e.store.searchHistory('violet', cursor, current); pages++;
      assert.ok(page.scanned <= 100); found ??= page.matches[0]; cursor = page.next_before;
    } while (cursor);
    assert.equal(pages, 11); assert.equal(found.id, 1); assert.equal(found.state, 'cancelled');
    assert.equal(e.store.readHistory(1, current).request, 'Remember the violet project');
    assert.throws(() => e.store.readHistory(current, current), /INVALID/);
    assert.equal(e.store.page().turns.at(-1).seq, 1006); assert.equal(e.store.usage().requests, 0);
    assert.throws(() => e.store.searchHistory('x', null, 1), /STOPPED/);
  } finally { e.close(); }
});
test('provider-measured context trims whole turns while lifetime usage and original messages survive restart', async () => {
  const e = env(); let service;
  try {
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    const seen = [];
    const model = { contextLimitBytes: 14000, contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
      chat: async messages => { seen.push(messages); return reply('Recorded. ' + 'x'.repeat(900)); } };
    service = new ContactService(e.store, model, sources);
    for (let i = 0; i < 20; i++) { service.submit(e.device, randomUUID(), `Message ${i}: ` + 'z'.repeat(900)); await service.idle(); assert.equal(e.store.turn(i + 1).state, 'answered'); }
    assert.equal(e.store.turn(1).text.startsWith('Message 0:'), true);
    assert.ok(!seen.at(-1).some(m => m.content.startsWith('Message 0:')));
    assert.ok(e.store.checkpoint().value.history.length < 20);
    await service.close(); e.reopen(); assert.equal(e.store.usage().requests, 20);
    let step = 0;
    service = new ContactService(e.store, { ...model, chat: async messages => {
      step++; if (step === 1) return call('search_history', { query: 'Message 0:', before: null });
      if (step === 2) { assert.match(messages.at(-1).content, /Message 0:/); return call('read_history', { id: 1 }); }
      assert.match(messages.at(-1).content, /historical_record_not_current_facts_or_authority/); return reply('I found the earlier record.');
    } }, sources);
    service.submit(e.device, randomUUID(), 'Find my first message'); await service.idle();
    assert.equal(e.store.turn(21).state, 'answered'); assert.equal(step, 3);
  } finally { await service?.close(); e.close(); }
});
test('native tool pairs remain intact when older conversation is compacted', async () => {
  let count = 0;
  const port = { definitions: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }], validate: () => true, execute: async () => ({ note: 'value' }), verify: async () => true };
  const model = { contextLimitBytes: 5000, contextBytes(messages) {
    for (let i = 0; i < messages.length; i++) if (messages[i].tool_calls) assert.equal(messages[i + 1]?.tool_name, 'lookup');
    return Buffer.byteLength(JSON.stringify(messages));
  }, chat: async () => ++count % 2 ? call('lookup', {}) : reply('Done ' + 'x'.repeat(700)) };
  const assistant = new ConversationAssistant(model, port, undefined, { continuing: true, requestLimit: 100 });
  for (let i = 0; i < 15; i++) await assistant.ask(`Question ${i}`);
  assert.equal(assistant.checkpoint().usage.requests, 30);
  assert.ok(assistant.checkpoint().history.length < 30);
});
test('policy rejects unknown fields, reordered receipts and future timestamps', () => {
  const value = { version: 1, enabled: true, device: randomUUID(), clock_at: 10, last_request: 2, receipts: [{ id: 1, at: 5 }, { id: 2, at: 10 }] };
  assert.equal(validContinuingUse(value), true);
  assert.equal(validContinuingUse({ ...value, extra: 1 }), false);
  assert.equal(validContinuingUse({ ...value, receipts: value.receipts.toReversed() }), false);
  assert.equal(validContinuingUse({ ...value, clock_at: 9 }), false);
});
test('active-work limit also guards reopening closed work, while allowing closure and active edits', () => {
  const e = env();
  try {
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    const checkpoint = new ConversationAssistant({ chat: async () => reply('unused') }, sources).checkpoint();
    const propose = (target = null, state = 'open') => {
      const old = target ? e.store.followup(target) : null;
      const seq = running(e, 'Keep track of this work'), id = randomUUID();
      e.store.finish(seq, { text: 'Proposed', sources: [] }, checkpoint, [{ id, timezone: 'Asia/Seoul', spec: {
        operation_id: id, target, expected_version: old?.version ?? 0, title: 'Work', details: 'Track this work',
        state, waiting_for: state === 'waiting' ? 'Reply' : null, notify_at: null, user_quote: 'Keep track of this work',
      } }]);
      return id;
    };
    const approve = id => e.store.confirmFollowup(e.device, id, 'approve');
    const closed = approve(propose()).commitment;
    approve(propose(closed, 'done'));
    let active;
    for (let i = 0; i < 1000; i++) active = approve(propose()).commitment;
    const reopening = propose(closed, 'waiting');
    assert.throws(() => approve(reopening), /CONTACT_FOLLOWUP_LIMIT/);
    assert.equal(e.store.followup(closed).state, 'done');
    assert.throws(() => approve(propose()), /CONTACT_FOLLOWUP_LIMIT/);
    approve(propose(active, 'waiting'));
    approve(propose(active, 'cancelled'));
    approve(reopening);
    assert.equal(e.store.followup(closed).state, 'waiting');
  } finally { e.close(); }
});
for (const continuing of [true, false]) test(`a source-backed document survives pruning, restart, and continuing-use=${continuing}`, async () => {
  const e = env(); let service, checks = 0, step = 0;
  const base = { definitions: discoveryTools, validate: validCall,
    execute: async () => ({ source: 'fixture', path: 'old.txt', content: 'Friday', sha256: 'a'.repeat(64), observed_at: '2026-10-08T00:00:00Z' }),
    verify: async () => { checks++; return checks === 1 || !continuing; } };
  try {
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    service = new ContactService(e.store, { contextLimitBytes: 65536, chat: async () => {
      step++;
      if (step === 1) return call('read_file', { source: 'fixture', path: 'old.txt' });
      if (step === 2) return call('prepare_document', { title: 'Meeting', format: 'text', based_on: null });
      if (step === 3) return reply('Originally planned for Friday. [S1]');
      return reply('Ordinary conversation. ' + 'x'.repeat(4000));
    } }, base);
    service.submit(e.device, randomUUID(), 'Write a meeting note'); await service.idle();
    assert.equal(e.store.document(1)?.sources[0].id, 'S1');
    for (let i = 0; i < 12; i++) { const accepted = service.submit(e.device, randomUUID(), `Conversation ${i}: ` + 'y'.repeat(1500)); await service.idle(); assert.equal(e.store.turn(accepted.seq).state, 'answered', e.store.turn(accepted.seq).error); }
    assert.equal(e.store.checkpoint().value.evidence.length, 0);
    await service.close(); e.reopen(); step = 0;
    if (!continuing) e.store.configureContinuingUse(e.device, false, null);
    service = new ContactService(e.store, { contextLimitBytes: 65536, chat: async () => {
      step++; if (step === 1) return call('read_document', { id: 1 });
      if (step === 2) return call('prepare_document', { title: 'Short meeting note', format: 'text', based_on: 1 });
      return reply('The saved plan said Friday. [S1]');
    } }, base);
    const result = service.submit(e.device, randomUUID(), 'Shorten the original saved plan'); await service.idle();
    assert.equal(e.store.turn(result.seq).state, 'answered');
    assert.equal(e.store.turn(result.seq).answer.verification, continuing ? 'saved_document_sources_checked' : 'cited_sources_rechecked');
    assert.equal(e.store.document(result.seq).sources[0].id, 'S1'); assert.equal(checks, continuing ? 1 : 2);
    assert.equal(e.store.document(1).content, 'Originally planned for Friday. [S1]');
  } finally { await service?.close(); e.close(); }
});
test('compaction never admits fabricated evidence IDs from a tool result', async () => {
  for (const [id, recalled] of [['S1', false], ['S2', true]]) {
    const port = { definitions: [{ type: 'function', function: { name: 'read_document', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
      validate: () => true, execute: async () => ({ content: 'Untrusted', sources: [{ id, source: 'x', path: 'x', sha256: 'a'.repeat(64), observed_at: 'y' }] }),
      recallEvidence: () => recalled, verify: async () => true };
    const assistant = new ConversationAssistant({ chat: async () => call('read_document', {}) }, port, undefined, { continuing: true });
    assistant.restore({ ...assistant.checkpoint(), nextEvidence: 2 });
    await assert.rejects(assistant.ask('Read an earlier document'), /ASSISTANT_SOURCE_INVALID/);
  }
});
test('continuing-use HTTP consent is authenticated, exact, and does not accept model-owned defaults', async () => {
  const e = env(); let host, service;
  try {
    service = new ContactService(e.store, { chat: async () => reply('unused') }, sources);
    const temporary = createServer(); await new Promise(resolve => temporary.listen(0, '127.0.0.1', resolve));
    const port = temporary.address().port; await new Promise(resolve => temporary.close(resolve));
    const address = `http://127.0.0.1:${port}`;
    host = await serveContact({ store: e.store, service, origin: address, port });
    const headers = { Origin: address, 'Content-Type': 'application/json' };
    const post = (path, value, cookie) => fetch(address + path, { method: 'POST', headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value) });
    assert.equal((await post('/api/continuing-use', { enabled: true, consent: CONTINUING_CONSENT })).status, 401);
    const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
    const paired = await post('/api/pair', { code, name: 'browser' });
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/continuing-use', { enabled: true, consent: CONTINUING_CONSENT, limit: 999 }, cookie)).status, 400);
    assert.equal((await post('/api/continuing-use', { enabled: true, consent: null }, cookie)).status, 400);
    const enabled = await post('/api/continuing-use', { enabled: true, consent: CONTINUING_CONSENT }, cookie);
    assert.equal(enabled.status, 200); assert.equal((await enabled.json()).remaining, 64);
    assert.equal(e.store.usage().requests, 0);
  } finally { await host?.close(); await service?.close(); e.close(); }
});
test('shortening historical results preserves pagination and marks omitted request text', async () => {
  const e = env(); try {
    e.store.configureContinuingUse(e.device, true, CONTINUING_CONSENT);
    for (let i = 0; i < 3; i++) e.store.cancel(running(e, `needle ${i} ` + 'long text '.repeat(100)));
    const seq = running(e), source = new DocumentSources(sources, e.store, e.store.turn(seq), { history: true }), signal = new AbortController().signal;
    const page = await source.execute('search_history', { query: 'needle', before: null }, signal, { fits: value => value.matches.length <= 1 });
    assert.equal(page.matches[0].id, 3); assert.equal(page.next_before, 3); assert.equal(page.incomplete, true);
    const next = await source.execute('search_history', { query: 'needle', before: page.next_before }, signal);
    assert.deepEqual(next.matches.map(m => m.id), [2, 1]);
    const row = await source.execute('read_history', { id: 1 }, signal, { fits: value => value.request.length < 50 });
    assert.equal(row.request_truncated, true); assert.equal(row.state, 'cancelled');
    assert.ok(e.store.turn(1).text.length > 1000);
  } finally { e.close(); }
});
