import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { ReviewSources } from '../src/review-sources.mjs';
import { serveContact } from '../src/contact-http.mjs';

const passphrase = 'fixture only scheduled review test passphrase';
const route = contactRoute({ fixture: 'scheduled-review' });
const consent = 'one_local_read_only_review';
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NOT_CONNECTED'); }, verify: async () => false };
const reply = (text, calls = []) => ({ message: { role: 'assistant', content: text, tool_calls: calls }, input_tokens: 9, output_tokens: 4 });
const iso = time => new Date(time).toISOString().replace(/\.\d{3}Z$/u, 'Z');
const sha = text => createHash('sha256').update(text).digest('hex');
const input = '보고서를 다시 확인할 일로 기억해 줘.';
function env(version = 4) {
  const root = mkdtempSync(join(tmpdir(), 'tada-review-')), directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase, route, initialize: true, followups: true, reviews: version === 4 });
  return { root, directory, get store() { return store; }, reopen() { store.close(); store = new ContactStore({ directory, passphrase, route }); return store; }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function proposal(e, device, changes = {}) {
  const seq = e.store.submit(device, randomUUID(), input).seq; e.store.claim();
  const spec = { operation_id: 'review_report', target: null, expected_version: 0, title: '보고서 확인', details: '현재 보고서를 읽고 바뀐 점과 다음 행동을 정리하기', state: 'open', waiting_for: null, notify_at: iso(Date.now() + 3600000), user_quote: input, ...changes };
  const id = randomUUID();
  e.store.finish(seq, { text: '확인할 업무를 제안했어요.', sources: [] }, new ConversationAssistant({}, noSources).checkpoint(), [{ id, spec, timezone: 'Asia/Seoul' }]);
  return id;
}
function work(e, device, changes = {}) { return e.store.confirmFollowup(device, proposal(e, device, changes), 'approve'); }
function arm(e, device, w) { return e.store.armReview(device, w.commitment, w.version, consent); }
function due(e, w) { return Date.parse(e.store.followup(w.commitment).notify_at); }
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('TEST_WAIT_FAILED'); };

async function http(e, service) {
  const origin = 'http://127.0.0.1:9017';
  const host = await serveContact({ store: e.store, service, origin, port: 0 });
  const call = (path, body, token = '') => new Promise((yes, no) => {
    const req = request(`http://127.0.0.1:${host.address.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1:9017', Origin: origin, 'Content-Type': 'application/json', Cookie: `tada_local=${token}` } }, res => {
      const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => yes({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
    }); req.on('error', no); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { host, call };
}

test('v3 never gains scheduled authority implicitly; explicit migration backs up, preserves work and reopens v4', async () => {
  const e = env(3);
  try {
    const d = e.store.addDevice('desktop'); const w = work(e, d.id);
    assert.throws(() => arm(e, d.id, w), /CONTACT_REVIEW_UPGRADE_REQUIRED/);
    assert.equal(e.store.reviewTick(due(e, w)), 0);
    const path = await e.store.upgradeReviews(); assert.ok(path);
    const backup = new DatabaseSync(path, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 3); backup.close();
    assert.equal(e.store.followup(w.commitment).title, '보고서 확인');
    assert.equal(await e.store.upgradeReviews(), null);
    assert.equal(await e.store.upgradeFollowups(), null);
    e.reopen(); assert.equal(e.store.contactVersion, 4); assert.equal(e.store.reviewState(w.commitment, 1), null);
  } finally { e.close(); }
});

test('ordinary reminders do not call a model or create review turns', () => {
  const e = env();
  try { const d = e.store.addDevice('owner'), w = work(e, d.id); assert.equal(e.store.reviewTick(due(e, w)), 0); assert.equal(e.store.followupTick(due(e, w)), 1); assert.equal(e.store.page().turns.length, 1); assert.equal(e.store.usage().requests, 0); }
  finally { e.close(); }
});

test('exact consent, current version, active authority and future time are required', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id);
    for (const wrong of [undefined, true, 'yes', 'read_only', {}]) assert.throws(() => e.store.armReview(d.id, w.commitment, 1, wrong), /CONTACT_REVIEW_CONSENT_REQUIRED/);
    assert.throws(() => e.store.armReview(d.id, w.commitment, 2, consent), /CONTACT_FOLLOWUP_STALE/);
    assert.throws(() => e.store.armReview(d.id, w.commitment, 1, consent, due(e, w)), /CONTACT_FOLLOWUP_TIME_INVALID/);
    e.store.revoke(d.id); assert.throws(() => arm(e, d.id, w), /CONTACT_DEVICE_REVOKED/);
  } finally { e.close(); }
});

test('arming and due ticks are idempotent across restart and do not reset accounting', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); const first = arm(e, d.id, w);
    assert.equal(arm(e, d.id, w).id, first.id); assert.equal(arm(e, d.id, w).replay, true);
    assert.equal(e.store.reviewTick(due(e, w) - 1), 0); e.reopen();
    assert.equal(e.store.reviewTick(due(e, w)), 1); assert.equal(e.store.reviewTick(due(e, w)), 0);
    const queued = e.store.reviewState(w.commitment, 1); assert.equal(queued.state, 'queued');
    e.reopen(); assert.equal(e.store.reviewTick(due(e, w) + 2000), 0); assert.equal(e.store.page().turns.length, 2); assert.equal(e.store.usage().requests, 0);
  } finally { e.close(); }
});

test('scheduled review uses the SAME real journal/loop, freshly reads a changed file, verifies citations and preserves work state', async () => {
  const e = env(); let service;
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id), file = join(e.root, 'report.txt');
    writeFileSync(file, 'draft A'); arm(e, d.id, w); writeFileSync(file, 'draft B: cost reduced to 8');
    let reads = 0, modelCalls = 0;
    const sources = { definitions: [{ type: 'function', function: { name: 'read_file' } }], validate: (name, a) => name === 'read_file' && a.source === 'fixture' && a.path === 'report.txt',
      execute: async () => { reads++; const text = readFileSync(file, 'utf8'); return { source: 'fixture', path: 'report.txt', content: text, sha256: sha(text), observed_at: new Date().toISOString() }; },
      verify: async evidence => { reads++; return evidence.sha256 === sha(readFileSync(file, 'utf8')); } };
    const model = { chat: async messages => {
      modelCalls++; assert.match(messages[0].content, /ONE-TIME scheduled/);
      if (modelCalls === 1) return reply('', [{ function: { name: 'read_file', arguments: { source: 'fixture', path: 'report.txt' } } }]);
      const observation = JSON.parse(messages.at(-1).content); assert.match(observation.content, /draft B/);
      return reply(`현재 파일의 비용은 8로 줄었어요. [${observation.evidence_id}] 다음은 산출 근거를 확인하는 것입니다.`);
    } };
    e.store.reviewTick(due(e, w)); service = new ContactService(e.store, model, sources); service.start(); await service.idle();
    const result = e.store.reviewState(w.commitment, 1); assert.equal(result.state, 'answered');
    assert.equal(reads, 2); assert.equal(modelCalls, 2); assert.equal(e.store.usage().requests, 2);
    const saved = e.store.turn(result.turn); assert.match(saved.answer.text, /비용은 8/); assert.equal(saved.answer.verification, 'cited_sources_rechecked');
    assert.equal(e.store.followup(w.commitment).state, 'open');
    await service.close(); e.reopen(); assert.equal(e.store.turn(result.turn).answer.text, saved.answer.text);
  } finally { await service?.close(); e.close(); }
});

test('review tool inventory strips proposals and any present or future mutation tool', async () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w)); const job = e.store.claim();
    const base = { ...noSources, definitions: ['read_file','propose_followup','send_email','execute_program'].map(name => ({ function: { name } })), validate: () => true };
    const wrapper = new ReviewSources(base, e.store, job, e.store.reviewForTurn(job.seq));
    assert.deepEqual(wrapper.definitions.map(x => x.function.name), ['read_file']);
    for (const name of ['propose_followup','send_email','execute_program']) {
      assert.equal(wrapper.validate(name, {}), false);
      await assert.rejects(wrapper.execute(name, {}, new AbortController().signal), /CONTACT_REVIEW_READ_ONLY/);
    }
  } finally { e.close(); }
});

test('cancelling an armed review does not rearm it on replay or remove the ordinary reminder', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w);
    assert.equal(e.store.cancelReview(d.id, w.commitment, 1).state, 'cancelled');
    assert.equal(arm(e, d.id, w).state, 'cancelled'); assert.equal(e.store.reviewTick(due(e, w)), 0);
    assert.equal(e.store.followupTick(due(e, w)), 1);
  } finally { e.close(); }
});

test('changing a commitment cancels its old queued review without cancelling the new version', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w);
    const p = proposal(e, d.id, { target: w.commitment, expected_version: 1, details: '업데이트된 범위만 확인하기' });
    e.store.reviewTick(due(e, w));
    const newer = e.store.confirmFollowup(d.id, p, 'approve'); assert.equal(e.store.reviewState(w.commitment, 1).state, 'cancelled');
    arm(e, d.id, newer); assert.equal(e.store.reviewTick(due(e, newer)), 1);
    assert.equal(e.store.reviewState(w.commitment, 2).state, 'queued');
  } finally { e.close(); }
});

test('cancellation while a model response is in flight prevents output admission but records late usage', async () => {
  const e = env(); let service, release;
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w));
    service = new ContactService(e.store, { chat: () => new Promise(r => { release = r; }) }, noSources);
    service.start(); await waitFor(() => !!release); service.cancelReview(d.id, w.commitment, 1); release(reply('late result'));
    await service.idle(); const review = e.store.reviewState(w.commitment, 1); assert.equal(review.state, 'cancelled');
    assert.equal(e.store.turn(review.turn).answer, null); assert.equal(e.store.usage().input_tokens, 9);
  } finally { await service?.close(); e.close(); }
});

test('revocation of either task owner or separate reviewing device blocks due execution', () => {
  for (const revokeOwner of [true, false]) {
    const e = env();
    try {
      const owner = e.store.addDevice('desktop'), reviewer = e.store.addDevice('phone'), w = work(e, owner.id);
      arm(e, reviewer.id, w); e.store.revoke(revokeOwner ? owner.id : reviewer.id);
      assert.equal(e.store.reviewTick(due(e, w)), 0); assert.equal(e.store.reviewState(w.commitment, 1).state, 'cancelled');
    } finally { e.close(); }
  }
});

test('source completion after permission loss cannot be consumed by the next model call', async () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w)); const job = e.store.claim(); let release;
    const base = { ...noSources, definitions: [{ function: { name: 'read_file' } }], validate: () => true, execute: () => new Promise(r => { release = r; }) };
    const wrapper = new ReviewSources(base, e.store, job, e.store.reviewForTurn(job.seq));
    const pending = wrapper.execute('read_file', {}, new AbortController().signal); e.store.revoke(d.id); release({ content: 'late private data' });
    await assert.rejects(pending, /CONTACT_REQUEST_STOPPED|CONTACT_DEVICE_REVOKED/);
  } finally { e.close(); }
});

test('restart marks an in-flight review interrupted, retains uncertainty, and never automatically retries it', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w));
    const job = e.store.claim(); e.store.reserve(job.seq); e.reopen();
    assert.equal(e.store.reviewState(w.commitment, 1).state, 'interrupted'); assert.equal(e.store.usage().unknown_requests, 1);
    assert.equal(e.store.reviewTick(due(e, w) + 100), 0); assert.equal(e.store.claim(), null);
  } finally { e.close(); }
});

test('a review more than 24 hours late is visibly cancelled rather than silently executed', () => {
  const e = env();
  try { const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); assert.equal(e.store.reviewTick(due(e, w) + 86400001), 0); assert.equal(e.store.reviewState(w.commitment, 1).error, 'CONTACT_REVIEW_MISSED'); }
  finally { e.close(); }
});

test('a full queue defers the same grant until capacity is available', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w);
    const seqs = Array.from({ length: 16 }, () => e.store.submit(d.id, randomUUID(), 'ordinary queued message').seq);
    assert.equal(e.store.reviewTick(due(e, w)), 0); assert.equal(e.store.reviewState(w.commitment, 1).state, 'armed');
    e.store.cancel(seqs[0]); assert.equal(e.store.reviewTick(due(e, w)), 1); assert.equal(e.store.reviewTick(due(e, w)), 0);
  } finally { e.close(); }
});

test('each review has at most eight model requests and uses the existing durable lifetime budget', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w)); const job = e.store.claim();
    for (let i = 0; i < 8; i++) e.store.observe(e.store.reserve(job.seq), reply('bounded'));
    assert.throws(() => e.store.reserve(job.seq), /CONTACT_REVIEW_REQUEST_LIMIT/); assert.equal(e.store.usage().requests, 8);
    e.reopen(); assert.equal(e.store.usage().requests, 8);
  } finally { e.close(); }
});

test('HTTP review endpoints require paired credentials, exact fields and version-bound consent', async () => {
  const e = env(); let service, server;
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); service = new ContactService(e.store, {}, noSources); server = await http(e, service);
    const body = { commitment: w.commitment, version: 1, consent };
    assert.equal((await server.call('/api/followups/review', body)).status, 401);
    assert.equal((await server.call('/api/followups/review', { ...body, tool: 'send_email' }, d.token)).status, 400);
    assert.equal((await server.call('/api/followups/review', { ...body, consent: true }, d.token)).status, 400);
    assert.equal((await server.call('/api/followups/review', body, d.token)).body.state, 'armed');
    assert.equal((await server.call('/api/state', undefined, d.token)).body.followups.reviews_available, true);
    assert.equal((await server.call('/api/followups/review/cancel', { commitment: w.commitment, version: 1 }, d.token)).body.state, 'cancelled');
  } finally { await server?.host.close(); await service?.close(); e.close(); }
});

test('review snapshots are encrypted and modifying plaintext due metadata fails closed on reopen', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id, { details: 'SENSITIVE_REVIEW_FIXTURE_8239' }); arm(e, d.id, w); e.store.close();
    assert.equal(readFileSync(join(e.directory, 'contact.sqlite')).includes(Buffer.from('SENSITIVE_REVIEW_FIXTURE_8239')), false);
    const db = new DatabaseSync(join(e.directory, 'contact.sqlite')); db.exec('UPDATE followup_reviews SET due=due-1000'); db.close();
    assert.throws(() => e.reopen(), /CONTACT_REVIEW_INTEGRITY/);
  } finally { e.close(); }
});

test('an answered older version never cancels an armed newer review during stale-state sweeps', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), first = work(e, d.id); arm(e, d.id, first); e.store.reviewTick(due(e, first));
    const job = e.store.claim(); e.store.finish(job.seq, { text: 'previous result', sources: [] }, new ConversationAssistant({}, noSources).checkpoint());
    const newer = work(e, d.id, { target: first.commitment, expected_version: 1, details: '새 버전 확인' });
    arm(e, d.id, newer); e.store.reviewTick(due(e, newer) - 1);
    assert.equal(e.store.reviewState(first.commitment, 1).state, 'answered');
    assert.equal(e.store.reviewState(first.commitment, 2).state, 'armed');
    assert.equal(e.store.reviewTick(due(e, newer)), 1);
  } finally { e.close(); }
});

test('a queued review also expires if the host was absent more than 24 hours past its appointment', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w)); e.reopen();
    e.store.reviewTick(due(e, w) + 86400001);
    assert.equal(e.store.reviewState(w.commitment, 1).state, 'cancelled');
    assert.equal(e.store.reviewState(w.commitment, 1).error, 'CONTACT_REVIEW_MISSED');
    assert.equal(e.store.claim(), null);
  } finally { e.close(); }
});

test('tampering with the encrypted grant-to-turn link is rejected on reopen', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w));
    const foreign = e.store.submit(d.id, randomUUID(), 'unrelated user instruction').seq; e.store.close();
    const db = new DatabaseSync(join(e.directory, 'contact.sqlite'));
    db.prepare('UPDATE followup_reviews SET turn=?').run(foreign); db.close();
    assert.throws(() => e.reopen(), /CONTACT_REVIEW_INTEGRITY/);
  } finally { e.close(); }
});

test('the actual host timer starts an approved review once with no browser or manual due tick', { timeout: 9000 }, async () => {
  const e = env(); let service, calls = 0;
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id, { notify_at: iso(Date.now() + 2500) }); arm(e, d.id, w);
    service = new ContactService(e.store, { chat: async () => { calls++; return reply('연결된 자료가 없어 실제 내용은 확인하지 못했어요.'); } }, noSources);
    service.start(); assert.equal(calls, 0);
    for (let i = 0; i < 120 && e.store.reviewState(w.commitment, 1).state !== 'answered'; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(e.store.reviewState(w.commitment, 1).state, 'answered'); assert.equal(calls, 1);
    await new Promise(r => setTimeout(r, 1100)); assert.equal(calls, 1);
    await service.close(); e.reopen(); assert.equal(e.store.reviewTick(), 0); assert.equal(e.store.claim(), null);
  } finally { await service?.close(); e.close(); }
});

test('a scheduled model cannot dispatch a write even when the base host knows that tool', async () => {
  const e = env(); let service, executed = false;
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id); arm(e, d.id, w); e.store.reviewTick(due(e, w));
    const sources = { ...noSources, definitions: [{ function: { name: 'send_email' } }], validate: () => true, execute: async () => { executed = true; } };
    service = new ContactService(e.store, { chat: async () => reply('', [{ function: { name: 'send_email', arguments: { body: 'not permitted' } } }]) }, sources);
    service.start(); await service.idle(); const state = e.store.reviewState(w.commitment, 1);
    assert.equal(state.state, 'failed'); assert.ok(state.error); assert.equal(executed, false); assert.equal(e.store.turn(state.turn).answer, null);
  } finally { await service?.close(); e.close(); }
});

test('an exhausted existing journal budget blocks scheduled inference rather than opening a new allowance', () => {
  const e = env();
  try {
    const d = e.store.addDevice('owner'), w = work(e, d.id), seq = e.store.submit(d.id, randomUUID(), 'ordinary metered work').seq;
    e.store.claim(); for (let i = 0; i < 64; i++) e.store.observe(e.store.reserve(seq), reply('fixture'));
    e.store.fail(seq, 'TEST_DONE'); arm(e, d.id, w); e.store.reviewTick(due(e, w)); const job = e.store.claim();
    assert.throws(() => e.store.reserve(job.seq), /CONTACT_REQUEST_LIMIT/); assert.equal(e.store.usage().requests, 64);
  } finally { e.close(); }
});
