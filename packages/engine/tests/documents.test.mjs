import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { serveContact } from '../src/contact-http.mjs';
import { discoveryTools } from '../src/native-sources.mjs';
import { DocumentSources } from '../src/document-sources.mjs';
const passphrase = 'synthetic document journal fixture';
const route = contactRoute({ documents: 'fixture' });
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => true };
const result = content => ({ message: { role: 'assistant', content }, input_tokens: 1, output_tokens: 1 });
const call = (name, args) => ({ ...result(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
function env() {
  const root = mkdtempSync(join(tmpdir(), 'tada-documents-')), directory = join(root, 'journal');
  let store = new ContactStore({ directory, passphrase, route, initialize: true, reviews: true });
  return { root, directory, get store() { return store; }, restart() { store.close(); store = new ContactStore({ directory, passphrase, route }); },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function scripted(steps) { return { chat: async (messages, tools) => {
  const step = steps.shift(); assert.ok(step, 'unexpected model call'); return typeof step === 'function' ? step(messages, tools) : step;
} }; }

test('create, retrieve after restart, revise and authenticated download keep actual content and original versions', async () => {
  const e = env(), firstText = '# 회의 준비\n\n- 참석자 확인\n- 안건 정리\n\n<script>not executable</script>';
  let service, host;
  try {
    const device = e.store.addDevice('Browser');
    service = new ContactService(e.store, scripted([
      call('prepare_document', { title: '회의 준비', format: 'markdown', based_on: null }), result(firstText),
    ]), noSources);
    service.submit(device.id, randomUUID(), '회의를 준비할 체크리스트 문서 만들어줘.'); await service.idle();
    assert.equal(e.store.turn(1).state, 'answered');
    assert.equal(e.store.document(1).content, firstText);
    assert.equal(e.store.document(1).sha256, createHash('sha256').update(firstText).digest('hex'));
    assert.equal(JSON.stringify(e.store.checkpoint()).includes(firstText), false);
    assert.equal(e.store.documentPage().documents[0].id, 1);
    await service.close(); e.restart();
    service = new ContactService(e.store, scripted([
      messages => { assert.ok(messages.some(m => m.content.includes('Saved document:'))); return call('list_documents', { before: null }); },
      call('read_document', { id: 1 }), call('prepare_document', { title: '짧은 회의 준비', format: 'text', based_on: 1 }),
      result('회의 전: 참석자와 안건을 확인한다.'),
    ]), noSources);
    service.submit(device.id, randomUUID(), '아까 문서, 한 문장으로 줄여줘.'); await service.idle();
    assert.equal(e.store.turn(2).state, 'answered');
    const revised = e.store.document(2);
    assert.equal(revised.revision, 2); assert.equal(revised.root, 1); assert.equal(revised.based_on, 1);
    assert.equal(e.store.document(1).content, firstText);
    assert.equal(JSON.stringify(e.store.checkpoint()).includes('not executable'), false);
    const pending = e.store.submit(device.id, randomUUID(), 'Try an older base'); e.store.claim();
    assert.throws(() => e.store.prepareDocument(pending.seq, { title: 'old', format: 'text', based_on: 1 }), /DOCUMENT_STALE/);
    e.store.cancel(pending.seq);
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    host = await serveContact({ store: e.store, service, origin, port });
    const headers = { Origin: origin };
    assert.equal((await fetch(origin + '/api/documents/2', { headers })).status, 401);
    const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
    const pair = await fetch(origin + '/api/pair', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Other browser' }) });
    const cookie = pair.headers.get('set-cookie').split(';')[0], paired = await pair.json();
    const response = await fetch(origin + '/api/documents/2', { headers: { ...headers, Cookie: cookie } });
    assert.equal(response.status, 200); assert.equal(await response.text(), revised.content);
    assert.equal(response.headers.get('x-content-sha256'), revised.sha256);
    assert.match(response.headers.get('content-disposition'), /attachment;.*\.txt/u);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    e.store.revoke(paired.device);
    assert.equal((await fetch(origin + '/api/documents/2', { headers: { ...headers, Cookie: cookie } })).status, 401);
    assert.equal(readFileSync(join(e.directory, 'contact.sqlite')).includes(Buffer.from('회의 준비')), false);
  } finally { await host?.close(); await service?.close(); e.close(); }
});

for (const stop of ['cancel', 'revoke']) test(`${stop} after document preparation never publishes a late result`, async () => {
  const e = env(); let service, resolveFinal, reached;
  const ready = new Promise(resolve => { reached = resolve; });
  try {
    const device = e.store.addDevice('Browser');
    service = new ContactService(e.store, scripted([
      call('prepare_document', { title: '미완성 문서', format: 'text', based_on: null }),
      () => new Promise(resolve => { resolveFinal = resolve; reached(); }),
    ]), noSources);
    service.submit(device.id, randomUUID(), '문서 만들어줘.'); await ready;
    if (stop === 'cancel') service.cancel(1); else service.revoke(device.id);
    resolveFinal(result('Never publish this cancelled content')); await service.idle();
    assert.equal(e.store.document(1), null); assert.deepEqual(e.store.documentPage().documents, []);
    assert.equal(e.store.turn(1).state, 'cancelled');
    assert.equal(e.store.usage().requests, 2);
  } finally { resolveFinal?.(result('late')); await service?.close(); e.close(); }
});

test('document scope rejects unexpected fields, missing parents and multiple different prepared outputs', async () => {
  const e = env();
  try {
    const device = e.store.addDevice('Browser'); e.store.submit(device.id, randomUUID(), 'Write a document'); const job = e.store.claim();
    const source = new DocumentSources(noSources, e.store, job), signal = new AbortController().signal;
    const spec = { title: 'Checklist', format: 'markdown', based_on: null };
    assert.equal(source.validate('prepare_document', { ...spec, path: '/tmp/not-allowed' }), false);
    assert.equal(source.validate('prepare_document', { ...spec, format: 'html' }), false);
    await assert.rejects(source.execute('read_document', { id: 999 }, signal), /NOT_FOUND/);
    const prepared = await source.execute('prepare_document', spec, signal);
    assert.deepEqual(await source.execute('prepare_document', spec, signal), prepared);
    await assert.rejects(source.execute('prepare_document', { ...spec, title: 'Another' }, signal), /ALREADY_PREPARED/);
    assert.equal(e.store.document(job.seq), null);
  } finally { e.close(); }
});

for (const connected of [false, true]) test(`maximum-size document revision keeps the context cap; connected sources=${connected}`, async () => {
  const e = env(); let service;
  const sources = { ...noSources, definitions: connected ? discoveryTools : [] };
  try {
    const device = e.store.addDevice('Browser'), body = 'x'.repeat(4096);
    service = new ContactService(e.store, scripted([call('prepare_document', { title: 'Full note', format: 'text', based_on: null }), result(body)]), sources);
    service.submit(device.id, randomUUID(), 'Create this note'); await service.idle();
    assert.equal(e.store.document(1)?.content, body); await service.close(); e.restart();
    service = new ContactService(e.store, scripted([call('list_documents', { before: null }), call('read_document', { id: 1 }),
      call('prepare_document', { title: 'Revised note', format: 'text', based_on: 1 }), result('Shortened note')]), sources);
    service.submit(device.id, randomUUID(), 'Shorten the earlier note'); await service.idle();
    assert.equal(e.store.document(2)?.content, 'Shortened note', e.store.turn(2).error);
  } finally { await service?.close(); e.close(); }
});

test('document checkpoint compaction keeps subscription replay valid without retaining the full body', async () => {
  const { completedTurn, responsesInput } = await import('../../providers/src/chatgpt-subscription.mjs');
  const e = env(); let service;
  try {
    const device = e.store.addDevice('Browser');
    const args = { title: 'Subscription document', format: 'markdown', based_on: null };
    const packet = output => completedTurn({ status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } }, new Set(['prepare_document']));
    service = new ContactService(e.store, scripted([
      packet([{ type: 'function_call', namespace: 'tada', name: 'prepare_document', call_id: 'fixture-call', arguments: JSON.stringify(args), status: 'completed' }]),
      packet([{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Private document body' }] }]),
    ]), noSources);
    service.submit(device.id, randomUUID(), 'Make a document'); await service.idle();
    assert.ok(e.store.document(1));
    assert.doesNotThrow(() => responsesInput(e.store.checkpoint().value.history));
    assert.equal(JSON.stringify(e.store.checkpoint()).includes('Private document body'), false);
  } finally { await service?.close(); e.close(); }
});

for (const changed of [false, true]) test(`document citations are checked before publication; source changed=${changed}`, async () => {
  const { discoveryTools, validCall } = await import('../src/native-sources.mjs');
  const e = env(); let service, verified = 0;
  const source = { definitions: discoveryTools, validate: validCall,
    execute: async () => ({ source: 's1', path: 'meeting.txt', content: '회의는 금요일입니다.', sha256: 'a'.repeat(64), observed_at: new Date().toISOString() }),
    verify: async () => { verified++; if (changed) throw Error('SOURCE_CHANGED_REOBSERVE_REQUIRED'); return true; } };
  try {
    const device = e.store.addDevice('Browser');
    service = new ContactService(e.store, scripted([
      call('read_file', { source: 's1', path: 'meeting.txt' }), call('prepare_document', { title: '회의 안내', format: 'markdown', based_on: null }), result('회의는 금요일입니다. [S1]'),
    ]), source);
    service.submit(device.id, randomUUID(), '회의 안내를 문서로 만들어줘'); await service.idle();
    assert.equal(verified, 1);
    if (changed) { assert.equal(e.store.document(1), null); assert.equal(e.store.turn(1).error, 'SOURCE_CHANGED_REOBSERVE_REQUIRED'); }
    else { assert.equal(e.store.document(1).sources[0].id, 'S1'); assert.match(e.store.document(1).content, /\[S1\]/u); }
  } finally { await service?.close(); e.close(); }
});

test('a document and pending follow-up keep confirmation outside the document body', async () => {
  const e = env(); let service;
  try {
    const device = e.store.addDevice('Browser'), text = '문서를 만들고 이 일을 기록해줘';
    service = new ContactService(e.store, scripted([
      call('prepare_document', { title: '진행 요약', format: 'text', based_on: null }),
      call('propose_followup', { operation_id: 'fixture-note', target: null, expected_version: 0, title: '기록한 일', details: '확인이 필요한 일', state: 'open', waiting_for: null, notify_at: null, user_quote: text }),
      result('이 문서의 본문입니다.'),
    ]), noSources);
    service.submit(device.id, randomUUID(), text); await service.idle();
    assert.equal(e.store.document(1)?.content, '이 문서의 본문입니다.', e.store.turn(1).error);
    assert.match(e.store.turn(1).answer.notice, /확정해 주세요/u);
    assert.equal(e.store.followupState().proposals.length, 1);
  } finally { await service?.close(); e.close(); }
});

test('document lineage stays observable when distinct originals acquire the same title', async () => {
  const e = env(); let service;
  try {
    const device = e.store.addDevice('Browser');
    service = new ContactService(e.store, scripted([
      call('prepare_document', { title: 'First', format: 'text', based_on: null }), result('A'),
      call('prepare_document', { title: 'Second', format: 'text', based_on: null }), result('B'),
      call('read_document', { id: 2 }), call('prepare_document', { title: 'Edited', format: 'text', based_on: 2 }), result('Same'),
      call('read_document', { id: 1 }), call('prepare_document', { title: 'Edited', format: 'text', based_on: 1 }), result('Same'),
    ]), noSources);
    for (const text of ['First', 'Second', 'Revise second', 'Revise first']) { service.submit(device.id, randomUUID(), text); await service.idle(); }
    assert.deepEqual(e.store.documentPage().documents.slice(0, 2).map(({ id, root, based_on }) => ({ id, root, based_on })), [
      { id: 4, root: 1, based_on: 1 }, { id: 3, root: 2, based_on: 2 },
    ]);
    e.store.submit(device.id, randomUUID(), 'Read latest first'); const job = e.store.claim();
    const doc = await new DocumentSources(noSources, e.store, job).execute('read_document', { id: 4 }, new AbortController().signal);
    assert.equal(doc.root, 1); assert.equal(doc.based_on, 1); e.store.cancel(job.seq);
  } finally { await service?.close(); e.close(); }
});

for (const changed of [false, true]) test(`source-backed document revisions require citations and revalidation; changed=${changed}`, async () => {
  const { validCall } = await import('../src/native-sources.mjs');
  const e = env(); let service, checks = 0, revision = false;
  const sources = { definitions: discoveryTools, validate: validCall,
    execute: async () => ({ source: 's1', path: 'notes.txt', content: 'Friday', sha256: 'a'.repeat(64), observed_at: '2026-10-08T00:00:00Z' }),
    verify: async () => { checks++; return !(revision && changed); } };
  try {
    const device = e.store.addDevice('Browser');
    service = new ContactService(e.store, scripted([
      call('read_file', { source: 's1', path: 'notes.txt' }), call('prepare_document', { title: 'Meeting', format: 'text', based_on: null }), result('Meeting: Friday. [S1]'),
      call('read_document', { id: 1 }), call('prepare_document', { title: 'Short meeting', format: 'text', based_on: 1 }), result('Friday'),
      messages => { assert.match(messages.at(-1).content, /missing or unknown source references/u); return result('Friday [S1]'); },
    ]), sources);
    service.submit(device.id, randomUUID(), 'Write meeting note'); await service.idle(); revision = true;
    service.submit(device.id, randomUUID(), 'Shorten note'); await service.idle();
    assert.equal(checks, 2);
    if (changed) { assert.equal(e.store.document(2), null); assert.equal(e.store.turn(2).error, 'SOURCE_CHANGED_REOBSERVE_REQUIRED'); }
    else { assert.equal(e.store.document(2)?.sources[0].id, 'S1'); assert.equal(e.store.turn(2).answer.verification, 'cited_sources_rechecked'); }
  } finally { await service?.close(); e.close(); }
});

test('structured provider refusal remains a conversation answer and never replaces the latest document', async () => {
  const { completedTurn } = await import('../../providers/src/chatgpt-subscription.mjs');
  const e = env(); let service;
  try {
    const device = e.store.addDevice('Browser');
    const refusal = completedTurn({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot create this document.' }] }], usage: { input_tokens: 1, output_tokens: 1 } }, new Set());
    service = new ContactService(e.store, scripted([
      call('prepare_document', { title: 'Original', format: 'text', based_on: null }), result('Original text'),
      call('prepare_document', { title: 'Revision', format: 'text', based_on: 1 }), refusal,
    ]), noSources);
    service.submit(device.id, randomUUID(), 'Make a note'); await service.idle();
    service.submit(device.id, randomUUID(), 'Revise the note'); await service.idle();
    assert.equal(e.store.turn(2).state, 'answered'); assert.equal(e.store.turn(2).answer.refused, true);
    assert.match(e.store.turn(2).answer.text, /cannot create/u); assert.equal(e.store.document(2), null);
    assert.equal(e.store.documentPage().documents.length, 1); assert.equal(e.store.document(1).content, 'Original text');
  } finally { await service?.close(); e.close(); }
});

for (const format of ['markdown', 'text']) test(`downloaded ${format} research retains source URLs after restart without model-written links`, async () => {
  const e = env(); let service, host;
  try {
    const device = e.store.addDevice('Browser'), url = 'https://example.org/primary?year=2026&part=2';
    const steps = [call('research_public_web', {}), call('prepare_document', { title: 'Research', format, based_on: null }), result('조사 결과입니다. [S1]')];
    service = new ContactService(e.store, { ...scripted(steps), identity: { provider: 'chatgpt-subscription' },
      researchPublicWeb: async () => ({ report: { kind: 'answer', searches: 1, parts: [{ text: 'Facts', citations: [{ url, title: '<img src=x> [official]', start: 0, end: 5 }] }] }, input_tokens: 1, output_tokens: 1 }) }, noSources);
    service.submit(device.id, randomUUID(), '공개 자료를 조사해 문서로 만들어줘.'); await service.idle();
    assert.equal(e.store.turn(1).state, 'answered', e.store.turn(1).error);
    await service.close(); e.restart();
    service = new ContactService(e.store, scripted([]), noSources);
    const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port; await new Promise(r => reserve.close(r));
    const origin = `http://127.0.0.1:${port}`;
    host = await serveContact({ store: e.store, service, origin, port });
    const response = await fetch(origin + '/api/documents/1', { headers: { Origin: origin, Cookie: `tada_local=${device.token}` } });
    assert.equal(response.status, 200); const body = await response.text();
    assert.ok(body.startsWith('조사 결과입니다. [S1]')); assert.ok(body.includes(url));
    assert.match(body, /참고 자료\n\[S1\]/u);
    assert.equal(response.headers.get('x-content-sha256'), createHash('sha256').update(body).digest('hex'));
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body));
    if (format === 'markdown') { assert.ok(body.includes('\\<img src=x\\>')); assert.ok(body.includes(`<${url}>`)); }
    else assert.ok(body.includes('<img src=x> [official]'));
    e.store.revoke(device.id);
    assert.equal((await fetch(origin + '/api/documents/1', { headers: { Cookie: `tada_local=${device.token}` } })).status, 401);
  } finally { await host?.close(); await service?.close(); e.close(); }
});
