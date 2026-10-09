import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { GoogleConnection } from '../src/google-connection.mjs';
import { MailSources } from '../src/mail-sources.mjs';
import { GOOGLE_SEND_SCOPES } from '../src/google-contract.mjs';
import { MAIL_SEND_CONSENT } from '../src/mail-actions.mjs';
const base = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tada-mail-confirm-'));
  const options = { directory: join(root, 'journal'), passphrase: 'SYNTHETIC_CONFIRMATION_JOURNAL_ONLY', route: contactRoute({ fixture: 'mail-confirmation' }) };
  let store = new ContactStore({ ...options, initialize: true, assistance: true, mail: true });
  const device = store.addDevice('synthetic owner');
  store.saveGoogleCredential(device.id, { version: 2, send_enabled: true, epoch: randomUUID(), device: device.id,
    scopes: [...GOOGLE_SEND_SCOPES], refresh_token: 'SYNTHETIC_REFRESH_TOKEN_ONLY_123456789', email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false }, null);
  return { device, get store() { return store; }, reopen() { store.close(); store = new ContactStore(options); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function seed(e, subject = '금요일 미팅 확인', body = '금요일 오후 3시에 뵙겠습니다.') {
  const text = `${subject} 메일을 준비해 줘.`, seq = e.store.submit(e.device.id, randomUUID(), text).seq; e.store.claim();
  const record = e.store.prepareMail(seq, { account: 'owner@example.test', to: ['minseo@example.test'], cc: [], bcc: [], subject, body, reply: null });
  const cp = new ConversationAssistant({}, base).checkpoint();
  cp.history = [{ role: 'user', content: text }, { role: 'assistant', content: '초안을 준비했어요. 아직 보내지 않았어요.' }];
  e.store.finish(seq, { text: cp.history[1].content, sources: [] }, cp, [], null, null, record); return record;
}
// Independent remote fixture: construct what Gmail stored from actual POST bytes,
// never from the local expected draft or its digest.
function copyFromPost(raw) {
  const mime = Buffer.from(raw, 'base64url').toString('utf8'), split = mime.indexOf('\r\n\r\n');
  const headers = mime.slice(0, split).replace(/\r\n[ \t]+/gu, ' ').split('\r\n').map(line => {
    const at = line.indexOf(':'); return { name: line.slice(0, at), value: line.slice(at + 1).trim() };
  });
  return { id: 'sent1', threadId: 'thread1', labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers,
    body: { data: Buffer.from(mime.slice(split + 4).replaceAll('\r\n', ''), 'base64').toString('base64url') } } };
}
function connect(e, handler) {
  return new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', fetchImpl: async (url, options) => {
    const u = new URL(url);
    if (u.pathname === '/token') return json({ access_token: 'SYNTHETIC_ACCESS_TOKEN_ONLY_123456789', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SEND_SCOPES.join(' ') });
    return handler(u, options);
  } });
}
for (const available of [true, false]) test(`conversation checks lost send after restart, queryable=${available}, without a second POST`, async () => {
  const e = fixture(); let service, posts = 0, copy, reads = 0;
  try {
    const record = seed(e);
    service = new ContactService(e.store, {}, base); service.attachGoogle(connect(e, (u, options) => {
      if (u.pathname.endsWith('/send')) { posts++; copy = copyFromPost(JSON.parse(options.body).raw); throw Error('RESPONSE_LOST'); }
      throw Error('OFFLINE');
    }));
    assert.equal((await service.sendMail(e.device.id, { id: record.id, revision: record.revision, sha256: record.sha256, consent: MAIL_SEND_CONSENT })).state, 'UNCERTAIN');
    await service.close(); e.reopen(); const distractor = seed(e, '다음 달 행사 초안');
    let step = 0, observation;
    const model = { chat: async messages => {
      let message;
      if (step === 0) message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_mail_actions', arguments: { before: null } } }] };
      else if (step === 1) {
        const page = JSON.parse(messages.at(-1).content);
        assert.equal(page.records[0].id, distractor.id); assert.equal(page.records[0].state, 'DRAFT'); assert.equal(page.records[0].send_attempted_at, null);
        const target = page.records.find(r => r.state === 'UNCERTAIN'); assert.equal(target.id, record.id); assert.equal(target.send_attempted_at, new Date(e.store.mailAction(record.id).attempt.at).toISOString());
        message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_mail_action', arguments: { id: target.id } } }] };
      } else {
        observation = JSON.parse(messages.at(-1).content);
        message = { role: 'assistant', content: available ? 'Gmail 보낸함에서 승인한 내용과 일치하는 사본을 확인했어요. 수신이나 열람 여부는 확인되지 않았어요.' : '이전 발송의 응답이 유실됐고 지금 Gmail을 조회할 수 없어 발송 결과를 확정할 수 없어요. 다시 보내지는 않았어요.' };
      }
      step++; return { message, input_tokens: 1, output_tokens: 1 };
    } };
    service = new ContactService(e.store, model, base); service.attachGoogle(connect(e, u => {
      assert.ok(!u.pathname.endsWith('/send')); reads++; if (!available) throw Error('OFFLINE');
      return json(u.pathname.endsWith('/messages') ? { messages: [{ id: copy.id }] } : copy);
    }));
    const turn = service.submit(e.device.id, randomUUID(), '아까 보낸 거 확인해줘.'); await service.idle();
    assert.equal(e.store.turn(turn.seq).state, 'answered', JSON.stringify(e.store.turn(turn.seq).error));
    assert.equal(observation.state, available ? 'VERIFIED' : 'UNCERTAIN'); assert.deepEqual(observation.status_check, { state: available ? 'fresh' : 'unavailable', attempted: true });
    assert.ok(reads > 0); assert.equal(posts, 1); assert.equal(e.store.mailAction(distractor.id).state, 'DRAFT');
    assert.equal(step, 3);
  } finally { await service?.close(); e.close(); }
});
for (const state of ['DRAFT', 'VERIFIED']) test(`reading ${state} returns saved evidence without unnecessary remote lookup`, async () => {
  const e = fixture(); try {
    const record = seed(e);
    if (state === 'VERIFIED') {
      e.store.beginMailSend(e.device.id, record.id, record.revision, record.sha256, e.store.googleEpoch(), MAIL_SEND_CONSENT);
      e.store.finishMailSend(record.id, 'VERIFIED', 'sent_copy_matches_not_delivery', { gmail_id: 'sent1', thread_id: 'thread1' });
    }
    e.store.submit(e.device.id, randomUUID(), '메일 기록 보여줘.'); const job = e.store.claim();
    const sources = new MailSources(base, e.store, job, null, () => { throw Error('UNEXPECTED_REMOTE'); });
    const result = await sources.execute('read_mail_action', { id: record.id });
    assert.equal(result.state, state); assert.deepEqual(result.status_check, { state: 'saved', attempted: false });
  } finally { e.close(); }
});
for (const stop of ['abort', 'cancel', 'revoke']) test(`late mail lookup is not admitted after ${stop}`, async () => {
  const e = fixture(); try {
    const record = seed(e); e.store.beginMailSend(e.device.id, record.id, record.revision, record.sha256, e.store.googleEpoch(), MAIL_SEND_CONSENT);
    e.store.finishMailSend(record.id, 'UNCERTAIN', 'outcome_unknown');
    e.store.submit(e.device.id, randomUUID(), '확인해줘.'); const job = e.store.claim(), controller = new AbortController();
    const sources = new MailSources(base, e.store, job, null, async (id, signal) => {
      assert.equal(signal, controller.signal);
      if (stop === 'abort') controller.abort(); else if (stop === 'cancel') e.store.cancel(job.seq); else e.store.revoke(e.device.id);
      return e.store.mailAction(id);
    });
    await assert.rejects(sources.execute('read_mail_action', { id: record.id }, controller.signal));
  } finally { e.close(); }
});
test('long body omission is explicit and does not imply the partial draft matches its full digest', async () => {
  const e = fixture(); try {
    const record = seed(e, '긴 본문', '가'.repeat(3000));
    e.store.submit(e.device.id, randomUUID(), '메일 확인해줘.'); const job = e.store.claim();
    const sources = new MailSources(base, e.store, job, null);
    const result = await sources.execute('read_mail_action', { id: record.id }, undefined, { fits: value => JSON.stringify(value).length < 2500 });
    assert.equal(result.draft.body, undefined); assert.deepEqual(result.omitted_fields, ['draft.body']);
    assert.equal(result.sha256_basis, 'full_saved_draft_not_partial_result'); assert.equal(result.sha256, record.sha256);
    await assert.rejects(sources.execute('read_mail_action', { id: record.id }, undefined, { fits: () => false }), /SOURCE_LIMIT/);
  } finally { e.close(); }
});
test('concurrent manual reconciliation shares the service lock with conversational status reads', async () => {
  const e = fixture(); let release, entered, service, lookups = 0;
  const entering = new Promise(resolve => { entered = resolve; });
  try {
    const record = seed(e); e.store.beginMailSend(e.device.id, record.id, record.revision, record.sha256, e.store.googleEpoch(), MAIL_SEND_CONSENT);
    e.store.finishMailSend(record.id, 'UNCERTAIN', 'outcome_unknown');
    service = new ContactService(e.store, {}, base); service.attachGoogle(connect(e, async () => {
      lookups++; entered(); await new Promise(resolve => { release = resolve; }); return json({});
    }));
    const pending = service.reconcileMail(e.device.id, record.id); await entering;
    e.store.submit(e.device.id, randomUUID(), '확인해줘.'); const job = e.store.claim();
    const sources = new MailSources(base, e.store, job, null, (id, signal) => service.reconcileMail(e.device.id, id, signal));
    const result = await sources.execute('read_mail_action', { id: record.id }, new AbortController().signal);
    assert.equal(result.state, 'UNCERTAIN'); assert.deepEqual(result.status_check, { state: 'unavailable', attempted: false }); assert.equal(lookups, 1);
    release(); await pending;
  } finally { release?.(); await service?.close(); e.close(); }
});
