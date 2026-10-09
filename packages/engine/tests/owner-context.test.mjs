import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { OwnerContext, validOwnerContext } from '../src/owner-context.mjs';
import { DocumentSources } from '../src/document-sources.mjs';
const sources = { definitions: [], validate: () => false, verify: async () => false };
const signal = () => new AbortController().signal;
const reply = (content, tool_calls = []) => ({ message: { role: 'assistant', content, tool_calls }, input_tokens: 1, output_tokens: 1 });
const call = (name, args = {}) => reply('', [{ function: { name, arguments: args } }]);
function env() {
  const root = mkdtempSync(join(tmpdir(), 'tada-owner-context-'));
  const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'SYNTHETIC_CONTEXT_KEY', route: contactRoute({ fixture: root }), initialize: true, assistance: true });
  const device = store.addDevice('Owner').id;
  store.configureContinuingUse(device, true, 'continuing_conversation_24h_v1');
  const seed = (text, proposals = []) => {
    const seq = store.submit(device, randomUUID(), text).seq; store.claim();
    const checkpoint = new ConversationAssistant({}, sources).checkpoint();
    checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: 'ASSISTANT_SOURCE_CANARY' }];
    store.finish(seq, { text: 'ASSISTANT_SOURCE_CANARY', sources: [] }, checkpoint, proposals); return seq;
  };
  const job = text => { store.submit(device, randomUUID(), text); return store.claim(); };
  return { root, store, device, seed, job, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('only explicitly read owner history joins bounded recent context; search text and assistant content do not', async () => {
  const e = env(); try {
    const old = e.seed('Earlier project: Cedar. Do not purchase anything.');
    for (let i = 0; i < 6; i++) e.seed(`Recent unrelated remark ${i}`);
    const job = e.job('Research that earlier project.'), context = new OwnerContext(e.store, job);
    const docs = new DocumentSources(sources, e.store, job, { history: true, ownerContext: context });
    await docs.execute('search_history', { query: 'Cedar', before: null }, signal());
    assert.ok(context.snapshot(signal()).messages.every(item => item.id !== old));
    await docs.execute('read_history', { id: old }, signal());
    const selected = context.snapshot(signal()); assert.equal(validOwnerContext(selected), true);
    assert.equal(selected.messages.length, 5); assert.equal(selected.messages[0].selection, 'read_history');
    assert.match(selected.messages[0].text, /Do not purchase anything\.$/);
    assert.doesNotMatch(JSON.stringify(selected), /ASSISTANT_SOURCE_CANARY|Research that earlier/);
    assert.ok(new OwnerContext(e.store, job).snapshot(signal()).messages.every(item => item.id !== old));
    assert.ok(!docs.validate('read_history', { id: old, text: 'SOURCE_QUERY_CANARY' }));
  } finally { e.close(); }
});

test('a history read rejected by the consumer budget does not register its owner context', async () => {
  const e = env(); try {
    const old = e.seed('Old private owner context'); for (let i = 0; i < 5; i++) e.seed(`Recent ${i}`);
    const job = e.job('Now'), context = new OwnerContext(e.store, job), docs = new DocumentSources(sources, e.store, job, { history: true, ownerContext: context });
    await assert.rejects(docs.execute('read_history', { id: old }, signal(), { fits: () => false }), /SOURCE_LIMIT/);
    assert.ok(context.snapshot(signal()).messages.every(item => item.id !== old));
  } finally { e.close(); }
});

for (const change of ['off-on', 'settings-device', 'cancel']) test(`history authority cannot revive after ${change}`, () => {
  const e = env(); try {
    const old = e.seed('Earlier owner request'), job = e.job('Current'), context = new OwnerContext(e.store, job);
    context.read(old, signal());
    if (change === 'cancel') e.store.cancel(job.seq);
    else if (change === 'settings-device') e.store.configureContinuingUse(e.store.addDevice('Other').id, true, 'continuing_conversation_24h_v1');
    else { e.store.configureContinuingUse(e.device, false, null); e.store.configureContinuingUse(e.device, true, 'continuing_conversation_24h_v1'); }
    assert.throws(() => context.snapshot(signal()), /HISTORY_DISABLED|REQUEST_STOPPED/);
  } finally { e.close(); }
});

test('owner context retains only four explicitly read records and never truncates a prohibition', () => {
  const e = env(); try {
    const ids = Array.from({ length: 6 }, (_, i) => e.seed(`Record ${i}`));
    const long = e.seed('x'.repeat(3000) + ' DO NOT SEND');
    for (let i = 0; i < 5; i++) e.seed(`Recent ${i}`);
    const job = e.job('Current'), context = new OwnerContext(e.store, job);
    for (const id of ids) context.read(id, signal());
    let selected = context.snapshot(signal());
    assert.deepEqual(selected.messages.filter(item => item.selection === 'read_history').map(item => item.id), ids.slice(-4));
    context.read(long, signal()); selected = context.snapshot(signal(), 1000);
    assert.equal(selected.omitted, true); assert.ok(selected.messages.every(item => item.id !== long));
    assert.ok(Buffer.byteLength(JSON.stringify(selected)) <= 1000);
  } finally { e.close(); }
});

test('automatic care and review turns are excluded even when their generic origin falls back to human', () => {
  const rows = [1, 2, 3, 4].map(seq => ({ seq, created: Date.now(), state: seq === 4 ? 'cancelled' : 'answered', text: `record-${seq}`, origin: 'human' }));
  const store = { historyRevision: () => 0, continuingUseEnabled: () => true, assertTurnAuthority() {}, turn: id => rows.find(row => row.seq === id), page: () => ({ turns: [...rows] }), proactiveForTurn: id => id === 2, reviewForTurn: id => id === 3 };
  const context = new OwnerContext(store, { seq: 5 });
  for (const row of rows) context.read(row.seq, signal());
  const selected = context.snapshot(signal());
  assert.deepEqual(selected.messages.map(item => item.id), [1, 4]); assert.equal(selected.messages[1].state, 'cancelled');
});

test('context envelope rejects unknown fields, versions, duplicate IDs and invalid timestamps', () => {
  const good = { version: 1, messages: [{ id: 1, created_at: '2026-10-09T00:00:00.000Z', state: 'answered', text: 'Owner request', selection: 'read_history' }], omitted: false };
  assert.equal(validOwnerContext(good), true);
  for (const change of [v => { v.version = 2; }, v => { v.source = 'mail'; }, v => { v.messages.push(v.messages[0]); }, v => { v.messages[0].created_at = '2026-02-30T00:00:00.000Z'; }, v => { v.messages[0].selection = 'source'; }, v => { v.messages[0].assistant = 'injected'; }, v => { v.messages[0].text = 'x'.repeat(4097); }]) {
    const value = structuredClone(good); change(value); assert.equal(validOwnerContext(value), false);
  }
});

for (const limit of [500, 8192]) for (const excess of [0, 1]) test(`owner context measures the returned omission flag at ${limit} bytes plus ${excess}`, () => {
  const e = env(); try {
    const envelope = { version: 1, messages: [1, 2].map(id => ({ id, created_at: '2026-10-09T00:00:00.000Z', state: 'answered', text: '', selection: 'recent' })), omitted: false };
    const textBytes = limit + excess - Buffer.byteLength(JSON.stringify(envelope));
    e.seed('x'.repeat(Math.floor(textBytes / 2))); e.seed('y'.repeat(Math.ceil(textBytes / 2)));
    const selected = new OwnerContext(e.store, e.job('Current request')).snapshot(signal(), limit);
    assert.equal(validOwnerContext(selected), true);
    assert.ok(Buffer.byteLength(JSON.stringify(selected)) <= limit);
    assert.equal(selected.messages.length, excess ? 1 : 2);
    assert.equal(selected.omitted, Boolean(excess));
    if (!excess) assert.equal(Buffer.byteLength(JSON.stringify(selected)), limit);
  } finally { e.close(); }
});

const report = { searches: 1, parts: [{ text: 'Public observation', citations: [{ url: 'https://example.org/source', title: 'Source', start: 0, end: 6 }] }] };
test('the actual conversation sends explicitly retrieved old owner context into one isolated research request', async () => {
  const e = env(); let service, round = 0, research = 0;
  try {
    const old = e.seed('Cedar is the public company we discussed. Do not buy.'); for (let i = 0; i < 6; i++) e.seed(`Unrelated ${i}`);
    const model = { chat: async () => [call('read_history', { id: old }), call('research_public_web'), reply('Observed report [S1]')][round++], researchPublicWeb: async (request, previous) => {
      research++; assert.equal(request, 'Research the earlier company.'); assert.equal(previous.messages[0].id, old); assert.match(previous.messages[0].text, /Do not buy/); assert.doesNotMatch(JSON.stringify(previous), /CANARY/);
      return { report, input_tokens: 1, output_tokens: 1 };
    } };
    service = new ContactService(e.store, model, sources); service.submit(e.device, randomUUID(), 'Research the earlier company.'); await service.idle();
    assert.equal(e.store.turn(8).state, 'answered'); assert.equal(research, 1); assert.equal(e.store.usage().unknown_requests, 0);
  } finally { await service?.close(); e.close(); }
});

test('an old-context research result is withheld after off/on while observed model usage remains', async () => {
  const e = env(); let service, release, reached, round = 0;
  const ready = new Promise(resolve => { reached = resolve; });
  try {
    const old = e.seed('Cedar is the company.'); for (let i = 0; i < 5; i++) e.seed(`Other ${i}`);
    service = new ContactService(e.store, { chat: async () => round++ === 0 ? call('read_history', { id: old }) : call('research_public_web'), researchPublicWeb: async () => { reached(); return new Promise(resolve => { release = resolve; }); } }, sources);
    const { seq } = service.submit(e.device, randomUUID(), 'Research the earlier company.'); await ready;
    e.store.configureContinuingUse(e.device, false, null); e.store.configureContinuingUse(e.device, true, 'continuing_conversation_24h_v1');
    release({ report, input_tokens: 2, output_tokens: 3 }); await service.idle();
    const turn = e.store.turn(seq); assert.equal(turn.state, 'failed'); assert.equal(turn.error, 'CONTACT_HISTORY_DISABLED'); assert.equal(turn.answer, null);
    assert.equal(e.store.usage().requests, 3); assert.equal(e.store.usage().unknown_requests, 0);
  } finally { release?.({ report, input_tokens: 2, output_tokens: 3 }); await service?.close(); e.close(); }
});

test('retrieved owner context corrects the existing work and invalidates its older scheduled review', async () => {
  const e = env(); let service, outer = 0, intake = 0;
  try {
    const old = e.seed('For the company analysis, use Cedar. Do not send anything externally.');
    const request = 'Remember the Birch analysis work.', proposal = { id: randomUUID(), timezone: 'Asia/Seoul', spec: {
      operation_id: 'initial', target: null, expected_version: 0, title: 'Birch analysis', details: 'Review the company information.', state: 'open', waiting_for: null,
      notify_at: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, 'Z'), user_quote: request } };
    e.seed(request, [proposal]); e.store.confirmFollowup(e.device, proposal.id, 'approve');
    const before = e.store.followupPage('all', 0).items[0];
    e.store.armReview(e.device, before.id, before.version, 'one_local_read_only_review');
    for (let i = 0; i < 5; i++) e.seed(`Other ${i}`);
    e.store.configureFollowupDelegation(e.device, true, 'personal_followups_v1');
    const correction = 'Change that work to the earlier company. Do not set an alert.';
    const model = { chat: async (messages, definitions) => {
      if (definitions.some(tool => tool.function.name === 'prepare_followup_change')) {
        const host = messages[0].content;
        assert.match(host, /Cedar/); assert.match(host, /Do not send anything externally/); assert.doesNotMatch(host, /ASSISTANT_SOURCE_CANARY/);
        assert.equal(messages.find(message => message.role === 'user').content, correction);
        if (intake++ === 0) return call('prepare_followup_change', { ...proposal.spec, operation_id: 'correction', target: before.id, expected_version: before.version, title: 'Cedar analysis', notify_at: null, user_quote: correction });
        return reply('Prepared the corrected work.');
      }
      return [call('read_history', { id: old }), call('apply_personal_request'), reply('Changed the existing work to Cedar without an alert.')][outer++];
    } };
    service = new ContactService(e.store, model, sources); const { seq } = service.submit(e.device, randomUUID(), correction); await service.idle();
    assert.equal(e.store.turn(seq).state, 'answered');
    const after = e.store.followup(before.id); assert.equal(after.version, 2); assert.equal(after.title, 'Cedar analysis'); assert.equal(after.notify_at, null);
    assert.equal(e.store.followupPage('all', 0).items.length, 1); assert.equal(e.store.reviewState(before.id, before.version).state, 'cancelled');
    assert.equal(e.store.reviewState(before.id, after.version), null); assert.equal(e.store.usage().unknown_requests, 0);
  } finally { await service?.close(); e.close(); }
});
