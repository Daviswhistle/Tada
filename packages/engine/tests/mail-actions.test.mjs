import { ChatGPTSubscription, completedTurn } from '../../providers/src/chatgpt-subscription.mjs';
import { request } from 'node:http';
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
import { GoogleConnection } from '../src/google-connection.mjs';
import { MailSources } from '../src/mail-sources.mjs';
import { GoogleSources } from '../src/google-sources.mjs';
import { discoveryTools } from '../src/native-sources.mjs';
import { GOOGLE_SCOPES, GOOGLE_SEND_SCOPES, GOOGLE_SEND_CONSENT, validGoogleCredential } from '../src/google-contract.mjs';
import { MAIL_SEND_CONSENT, MAIL_UPGRADE_CONSENT, mailDigest, validMailAction, validMailDraft, prepareMailAction, startMailAction, mailMime } from '../src/mail-actions.mjs';
import { compareSentMail } from '../src/mail-reconcile.mjs';
import { serveContact } from '../src/contact-http.mjs';
const password = 'synthetic-mail-journal-test-only', route = contactRoute({ fixture: 'mail-actions' });
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const draft = () => ({ account: 'owner@example.test', to: ['recipient@example.test'], cc: [], bcc: ['private@example.test'], subject: '일정 확인', body: '안녕하세요.\n금요일에 뵙겠습니다.\n', reply: null });
function env(mail = true) {
  const root = mkdtempSync(join(tmpdir(), 'tada-mail-')), directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase: password, route, initialize: true, assistance: true, mail });
  const device = store.addDevice('synthetic owner');
  const grant = { version: mail ? 2 : 1, ...(mail ? { send_enabled: true } : {}), epoch: randomUUID(), device: device.id,
    scopes: [...(mail ? GOOGLE_SEND_SCOPES : GOOGLE_SCOPES)], refresh_token: 'SYNTHETIC_ONLY_REFRESH_TOKEN_123456789', email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false };
  store.saveGoogleCredential(device.id, grant, null);
  return { root, directory, device, grant, get store() { return store; }, reopen() { store.close(); store = new ContactStore({ directory, passphrase: password, route }); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function seed(e, value = draft()) {
  const seq = e.store.submit(e.device.id, randomUUID(), '금요일 미팅 확인 메일을 준비해 줘.').seq; e.store.claim();
  const record = e.store.prepareMail(seq, value);
  const cp = new ConversationAssistant({}, noSources).checkpoint();
  cp.history = [{ role: 'user', content: '미팅 확인 메일을 준비해 줘.' }, { role: 'assistant', content: '초안을 준비했어요.' }];
  e.store.finish(seq, { text: '초안을 준비했어요.', sources: [] }, cp, [], null, null, record); return record;
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function connection(e, handler = () => response({ id: 'sent1', threadId: 'thread1' })) {
  const requests = []; let authUrl;
  const google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com',
    openBrowser: async url => { authUrl = url; return true; }, fetchImpl: async (url, options) => {
      const target = new URL(url); requests.push({ url: target, method: options.method, body: options.body });
      if (target.hostname === 'oauth2.googleapis.com' && target.pathname === '/token') return response({ access_token: 'SYNTHETIC_ONLY_ACCESS_TOKEN_123456789', refresh_token: 'SYNTHETIC_ONLY_REFRESH_TOKEN_234567890', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SEND_SCOPES.join(' ') });
      if (target.pathname.endsWith('/profile')) return response({ emailAddress: 'owner@example.test' });
      return handler(target, options);
    } });
  return { google, requests, get authUrl() { return authUrl; } };
}
function sentCopy(record) {
  return { id: 'sent1', threadId: record.draft.reply?.thread_id ?? 'thread1', labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: record.draft.account }, { name: 'To', value: record.draft.to.join(', ') },
    { name: 'Cc', value: record.draft.cc.join(', ') }, { name: 'Bcc', value: record.draft.bcc.join(', ') },
    { name: 'Content-Type', value: 'text/plain; charset=UTF-8' },
    { name: 'Subject', value: record.draft.subject }, { name: 'Message-ID', value: record.attempt.message_id },
    ...(record.draft.reply ? [{ name: 'In-Reply-To', value: record.draft.reply.message_id }, { name: 'References', value: [...new Set([...record.draft.reply.references, record.draft.reply.message_id])].join('\r\n ') }] : []),
  ], body: { data: Buffer.from(record.draft.body.replaceAll('\n', '\r\n')).toString('base64url') } } };
}
test('strict draft rejects injection, duplicate destinations, oversized content and extra fields', () => {
  assert.equal(validMailDraft(draft()), true);
  for (const patch of [{ subject: 'hello\r\nBcc: stranger@example.test' }, { to: ['a@example.test\nBcc:x@example.test'] }, { cc: ['RECIPIENT@example.test'] }, { body: '가'.repeat(6000) }, { unexpected: true }, { reply: {} }]) assert.equal(validMailDraft({ ...draft(), ...patch }), false);
  const prepared = prepareMailAction(1, randomUUID(), draft());
  assert.equal(validMailAction({ ...prepared, version: 2 }), false);
  assert.equal(validMailAction({ ...prepared, draft: { ...draft(), body: 'changed' } }), false);
});
test('MIME preserves exact UTF-8 content, folded recipients, hidden recipients and stable message identity', () => {
  const record = startMailAction(prepareMailAction(1, randomUUID(), { ...draft(), subject: '회의 '.repeat(30) }), randomUUID(), randomUUID());
  const raw = Buffer.from(mailMime(record), 'base64url').toString('utf8');
  assert.match(raw, /Bcc: private@example.test\r\n/u); assert.ok(raw.includes(`Message-ID: ${record.attempt.message_id}`));
  const body = Buffer.from(raw.split('\r\n\r\n')[1].replaceAll('\r\n', ''), 'base64').toString('utf8');
  assert.equal(body, record.draft.body.replaceAll('\n', '\r\n'));
  assert.ok(raw.split('\r\n').every(line => Buffer.byteLength(line) < 998));
});
test('draft/answer transaction, CAS edits, exact consent and encrypted records survive restart', () => {
  const e = env(); try {
    const record = seed(e); assert.equal(e.store.turn(record.turn).answer.mail_action_id, record.id);
    const changed = e.store.editMail(e.device.id, record.id, record.revision, record.sha256, { ...record.draft, body: '수정한 내용' });
    assert.equal(changed.revision, 2); assert.notEqual(changed.sha256, record.sha256);
    assert.throws(() => e.store.beginMailSend(e.device.id, record.id, 1, record.sha256, e.grant.epoch, MAIL_SEND_CONSENT), /DRAFT_CHANGED/u);
    assert.throws(() => e.store.beginMailSend(e.device.id, record.id, 2, changed.sha256, e.grant.epoch, null), /CONSENT_REQUIRED/u);
    e.reopen(); assert.deepEqual(e.store.mailAction(record.id), changed);
    assert.ok(!readFileSync(join(e.directory, 'contact.sqlite')).includes(Buffer.from('수정한 내용')));
  } finally { e.close(); }
});
test('v5 requires explicit backed-up migration, preserving identity and read-only account', async () => {
  const e = env(false); try {
    const id = e.store.id; await assert.rejects(e.store.upgradeMail(null), /CONSENT/u);
    assert.equal(e.store.contactVersion, 5); const backup = await e.store.upgradeMail(MAIL_UPGRADE_CONSENT);
    const db = new DatabaseSync(backup, { readOnly: true }); try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5); } finally { db.close(); }
    assert.equal(e.store.contactVersion, 6); assert.equal(e.store.id, id); assert.deepEqual(e.store.googleCredential(), e.grant);
    assert.equal(e.store.googleConnected(), true); e.reopen(); assert.equal(e.store.contactVersion, 6);
  } finally { e.close(); }
});
test('crash-left dispatch is unknown and cannot be resent after reopen', () => {
  const e = env(); try {
    const record = seed(e); e.store.beginMailSend(e.device.id, record.id, 1, record.sha256, e.grant.epoch, MAIL_SEND_CONSENT);
    e.reopen(); assert.equal(e.store.mailAction(record.id).state, 'UNCERTAIN');
    assert.throws(() => e.store.beginMailSend(e.device.id, record.id, 1, record.sha256, e.grant.epoch, MAIL_SEND_CONSENT), /ALREADY_DISPATCHED/u);
  } finally { e.close(); }
});
for (const scenario of ['accepted', 'rejected', 'lost', 'malformed', 'revoked_after_post']) test(`send performs at most one POST and preserves ${scenario} receipt`, async () => {
  const e = env(); let postCount = 0;
  const c = connection(e, () => {
    postCount++;
    if (scenario === 'lost') throw Error('synthetic response lost');
    if (scenario === 'revoked_after_post') e.store.revoke(e.device.id);
    return scenario === 'rejected' ? response({ error: 'rejected' }, 403) : scenario === 'malformed' ? response({}) : response({ id: 'sent1', threadId: 'thread1' });
  });
  try {
    const record = seed(e), result = await c.google.sendMail(e.device.id, record.id, 1, record.sha256, MAIL_SEND_CONSENT);
    assert.equal(result.state, ['accepted','revoked_after_post'].includes(scenario) ? 'ACCEPTED' : scenario === 'rejected' ? 'REJECTED' : 'UNCERTAIN');
    assert.equal(postCount, 1);
    await assert.rejects(c.google.sendMail(e.device.id, record.id, 1, record.sha256, MAIL_SEND_CONSENT)); assert.equal(postCount, 1);
  } finally { c.google.close(); e.close(); }
});
test('local send disable changes epoch, aborts send authority, keeps readable credential', async () => {
  const e = env(), c = connection(e); try {
    const record = seed(e); c.google.disableMail(e.device.id);
    assert.equal(e.store.googleConnected(), true); assert.equal(e.store.googleCredential().send_enabled, false);
    await assert.rejects(c.google.sendMail(e.device.id, record.id, 1, record.sha256, MAIL_SEND_CONSENT), /SEND_PERMISSION/u);
    assert.equal(e.store.mailAction(record.id).state, 'DRAFT'); assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 0);
  } finally { c.google.close(); e.close(); }
});
for (const scenario of ['matches','mismatch','missing','many','unreadable']) test(`read-only reconciliation ${scenario} never resends`, async () => {
  const e = env(); let record;
  const c = connection(e, url => {
    if (url.pathname.endsWith('/messages')) return response(scenario === 'missing' ? {} : { messages: scenario === 'many' ? [{ id: 'sent1' }, { id: 'sent2' }] : [{ id: 'sent1' }] });
    const message = sentCopy(record);
    if (scenario === 'mismatch') message.payload.body.data = Buffer.from('changed').toString('base64url');
    if (scenario === 'unreadable') message.payload.mimeType = 'application/octet-stream';
    return response(message);
  });
  try {
    const prepared = seed(e); record = e.store.beginMailSend(e.device.id, prepared.id, 1, prepared.sha256, e.grant.epoch, MAIL_SEND_CONSENT);
    e.store.finishMailSend(record.id, 'UNCERTAIN', 'outcome_unknown');
    const result = await c.google.reconcileMail(e.device.id, record.id);
    assert.equal(result.state, scenario === 'matches' ? 'VERIFIED' : scenario === 'mismatch' ? 'APPLIED_MISMATCH' : 'UNCERTAIN');
    assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 0);
    if (scenario === 'missing') assert.equal(result.result.basis, 'not_found_is_not_unsent');
  } finally { c.google.close(); e.close(); }
});
test('sent receipt rejects spoofed message identity and duplicate destination headers', () => {
  const record = startMailAction(prepareMailAction(1, randomUUID(), draft()), randomUUID(), randomUUID());
  const message = sentCopy(record); assert.equal(compareSentMail(record, message), true);
  message.payload.headers.push({ name: 'To', value: 'other@example.test' }); assert.equal(compareSentMail(record, message), null);
  message.payload.headers.pop(); message.payload.headers.find(h => h.name === 'Message-ID').value = '<someone@else.test>'; assert.equal(compareSentMail(record, message), null);
});
test('credential v1 preserved; expanded v2 requires exact scope and explicit boolean', () => {
  const e = env(); try {
    assert.equal(validGoogleCredential(e.grant), true);
    assert.equal(validGoogleCredential({ ...e.grant, version: 1 }), false);
    assert.equal(validGoogleCredential({ ...e.grant, scopes: [...GOOGLE_SCOPES] }), false);
    assert.equal(validGoogleCredential({ ...e.grant, send_enabled: 'true' }), false);
    assert.equal(validGoogleCredential({ ...e.grant, scopes: [...GOOGLE_SEND_SCOPES, GOOGLE_SCOPES[0]] }), false);
  } finally { e.close(); }
});
test('replacement send OAuth requests exact expanded scopes and preserves old grant on denial', async () => {
  const e = env(false); await e.store.upgradeMail(MAIL_UPGRADE_CONSENT); const c = connection(e);
  try {
    await c.google.connect(e.device.id, GOOGLE_SEND_CONSENT);
    const url = new URL(c.authUrl); assert.equal(url.searchParams.get('scope'), GOOGLE_SEND_SCOPES.join(' '));
    assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
    const callback = new URL(url.searchParams.get('redirect_uri')); callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('error', 'access_denied');
    await fetch(callback, { redirect: 'manual' }); assert.deepEqual(e.store.googleCredential(), e.grant); assert.equal(c.google.status().connected, true);
  } finally { c.google.close(); e.close(); }
});
test('mail source prepares one draft, never exposes send tool, rejects invented reply id and does not commit before answer', async () => {
  const e = env(); try {
    const seq = e.store.submit(e.device.id, randomUUID(), '메일 초안을 만들어 줘.').seq; const job = e.store.claim();
    const sources = new MailSources(noSources, e.store, job, { replyReference: async () => { throw Error('CONTACT_MAIL_REPLY_READ_REQUIRED'); } });
    const args = { ...draft(), reply_to: null }; delete args.account; delete args.reply;
    assert.ok(!sources.definitions.some(t => /send_mail/u.test(t.function.name)));
    await assert.rejects(sources.execute('prepare_mail', { ...args, reply_to: 'invented' }), /REPLY_READ_REQUIRED/u);
    const result = await sources.execute('prepare_mail', args); assert.equal(result.sent, false);
    assert.equal(e.store.mailActions().records.length, 0); assert.equal(sources.prepared().turn, seq);
    await assert.rejects(sources.execute('prepare_mail', args), /ALREADY_PREPARED/u);
  } finally { e.close(); }
});
test('grant changes during refresh prevent POST; closing after token return also prevents dispatch', async () => {
  for (const action of ['disable', 'close']) {
    const e = env(); let google, posts = 0;
    google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', fetchImpl: async (url) => {
      if (String(url).includes('/token')) {
        if (action === 'disable') google.disableMail(e.device.id); else google.close();
        return response({ access_token: 'SYNTHETIC_ONLY_ACCESS_TOKEN_123456789', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SEND_SCOPES.join(' ') });
      }
      posts++; return response({ id: 'sent1', threadId: 'thread1' });
    } });
    try { const record = seed(e); await assert.rejects(google.sendMail(e.device.id, record.id, 1, record.sha256, MAIL_SEND_CONSENT)); assert.equal(posts, 0); assert.equal(e.store.mailAction(record.id).state, 'DRAFT'); }
    finally { google.close(); e.close(); }
  }
});
test('send OAuth rejects a different account and partial grant without replacing readable connection', async () => {
  for (const mode of ['account', 'scope']) {
    const e = env(false); await e.store.upgradeMail(MAIL_UPGRADE_CONSENT); let auth;
    const google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', openBrowser: async url => { auth = new URL(url); return true; }, fetchImpl: async url =>
      String(url).includes('/token') ? response({ access_token: 'SYNTHETIC_ONLY_ACCESS_TOKEN_123456789', refresh_token: 'SYNTHETIC_ONLY_REFRESH_TOKEN_123456789', expires_in: 3600, token_type: 'Bearer', scope: (mode === 'scope' ? GOOGLE_SCOPES : GOOGLE_SEND_SCOPES).join(' ') }) : response({ emailAddress: 'different@example.test' }) });
    try {
      await google.connect(e.device.id, GOOGLE_SEND_CONSENT);
      const callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
      await fetch(callback, { redirect: 'manual' }); assert.deepEqual(e.store.googleCredential(), e.grant);
    } finally { google.close(); e.close(); }
  }
});
test('model draft completes in the continuing answer; HTTP requires origin, exact consent and current revision', async () => {
  const e = env(), c = connection(e); let step = 0;
  const args = { ...draft(), reply_to: null }; delete args.account; delete args.reply;
  const service = new ContactService(e.store, { chat: async () => ({ message: step++ === 0
    ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'prepare_mail', arguments: args } }] }
    : { role: 'assistant', content: '초안을 준비했어요. 받는 사람과 내용을 확인해 주세요.' }, input_tokens: 10, output_tokens: 10 }) }, noSources);
  service.attachGoogle(c.google); let host;
  try {
    const accepted = service.submit(e.device.id, randomUUID(), '금요일 미팅 확인 메일 초안을 만들어 줘.');
    for (let tries = 0; tries < 300 && ['queued','running'].includes(e.store.turn(accepted.seq).state); tries++) await new Promise(r => setTimeout(r, 10));
    const turn = e.store.turn(accepted.seq); assert.equal(turn.state, 'answered'); assert.ok(turn.answer.mail_action_id);
    const record = e.store.mailAction(turn.answer.mail_action_id); assert.equal(record.draft.body, args.body);
    assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 0);
    host = await serveContact({ store: e.store, service, origin: 'http://127.0.0.1:0', port: 0 });
    const call = (path, body, origin = 'http://127.0.0.1:0') => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: host.address.port, path, method: body ? 'POST' : 'GET', headers: {
        Host: '127.0.0.1:0', Origin: origin, Cookie: `tada_local=${e.device.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
      } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) })); });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    const input = { id: record.id, revision: 1, sha256: record.sha256, consent: MAIL_SEND_CONSENT };
    assert.equal((await call('/api/mail/send', input, 'https://foreign.test')).status, 403);
    assert.equal((await call('/api/mail/send', { ...input, consent: null })).status, 400);
    assert.equal((await call('/api/mail/send', { ...input, revision: 2 })).status, 400);
    assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 0);
    const sent = await call('/api/mail/send', input); assert.equal(sent.status, 200);
    assert.equal((await call('/api/mail/send', input)).status, 400);
    assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 1);
    assert.equal((await call(`/api/mail/${record.id}`)).data.mail.id, record.id);

  } finally { await host?.close(); await service.close(); e.close(); }
});

test('all enabled local tools leave room for a current-work read and answer within the model context', async () => {
  const e = env(); let calls = 0, largest = 0;
  e.store.configureRelatedMail(e.device.id, true, 'related_mail_readonly_v1');
  e.store.configureContinuingUse(e.device.id, true, 'continuing_conversation_24h_v1');
  e.store.configureFollowupDelegation(e.device.id, true, 'personal_followups_v1');
  e.store.configureProactive(e.device.id, true, 'connected_attention_v2', 'Asia/Seoul');
  const model = { identity: { provider: 'ollama-local' },
    contextBytes(messages, tools) { const bytes = Buffer.byteLength(JSON.stringify({ messages, tools })); largest = Math.max(largest, bytes); return bytes; },
    async chat() { return { message: ++calls === 1
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_followups', arguments: { status: 'active', offset: 0 } } }] }
      : { role: 'assistant', content: '저장된 할 일이 없어요.' }, input_tokens: 1, output_tokens: 1 }; },
  };
  const service = new ContactService(e.store, model, { ...noSources, definitions: discoveryTools }, { timezone: 'Asia/Seoul' });
  const google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', fetchImpl: async () => { throw Error('No external requests'); } });
  service.attachGoogle(google);
  service.attachBrowser({ grant: { device: e.device.id, url: 'https://example.test/', origin: 'https://example.test', epoch: randomUUID() }, on() {}, unshare() {}, async close() {} });
  try {
    const turn = service.submit(e.device.id, randomUUID(), '지금 저장된 할 일이 있어?'); await service.idle();
    assert.equal(e.store.turn(turn.seq).error, null, `calls=${calls}, bytes=${largest}`); assert.equal(e.store.turn(turn.seq).state, 'answered');
    assert.equal(calls, 2); assert.ok(largest <= 14000, `actual composed input: ${largest} bytes`);
  } finally { await service.close(); e.close(); }
});
test('reply draft preserves full observed subject even when the model only sees its excerpt', async () => {
  const e = env();
  try {
    e.store.submit(e.device.id, randomUUID(), '이 메일에 답장 초안을 준비해 줘.'); const job = e.store.claim();
    const subject = '가'.repeat(90), headers = [
      { name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: subject },
      { name: 'Date', value: new Date(Date.now() - 60000).toUTCString() }, { name: 'Message-ID', value: '<original@example.test>' },
    ];
    const message = { id: 'm1', threadId: 'thread1', labelIds: ['INBOX'], snippet: 'synthetic message', internalDate: String(Date.now() - 60000),
      payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from('Original synthetic text').toString('base64url') } } };
    const connection = { captureGrant: () => ({ connected: true, email: e.grant.email, epoch: e.grant.epoch, related_mail_epoch: null }), assertSnapshot() {},
      apiJson: async (device, epoch, url) => url.pathname.endsWith('/messages') ? { messages: [{ id: 'm1' }] } : message };
    const google = new GoogleSources(noSources, e.store, connection, job), mail = new MailSources(google, e.store, job, google), signal = new AbortController().signal;
    await mail.execute('list_recent_emails', {}, signal);
    const read = await mail.execute('read_email', { id: 'm1' }, signal);
    assert.ok(Buffer.byteLength(read.subject) < Buffer.byteLength(subject));
    await mail.execute('prepare_mail', { to: ['sender@example.test'], cc: [], bcc: [], subject: read.subject, body: '답장 내용', reply_to: 'm1' }, signal);
    assert.equal(mail.prepared().draft.subject, subject); assert.equal(mail.prepared().draft.reply.subject, subject);
    assert.equal(mail.prepared().draft.reply.thread_id, 'thread1');
  } finally { e.close(); }
});

for (const timing of ['before_callback', 'during_exchange']) test(`disable sending cancels a pending scope upgrade ${timing} without replacing read access`, async () => {
  const e = env(false); await e.store.upgradeMail(MAIL_UPGRADE_CONSENT);
  let auth, reached, release; const entering = new Promise(r => { reached = r; }), token = new Promise(r => { release = r; });
  const google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', openBrowser: async url => { auth = new URL(url); return true; },
    fetchImpl: async url => {
      if (String(url).includes('/token')) { reached(); if (timing === 'during_exchange') await token;
        return response({ access_token: 'SYNTHETIC_ONLY_ACCESS_TOKEN_123456789', refresh_token: 'SYNTHETIC_ONLY_REFRESH_TOKEN_123456789', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SEND_SCOPES.join(' ') }); }
      return response({ emailAddress: e.grant.email });
    } });
  try {
    await google.connect(e.device.id, GOOGLE_SEND_CONSENT);
    assert.equal(google.status().mail.connecting, true);
    const callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    let pending;
    if (timing === 'during_exchange') { pending = fetch(callback, { redirect: 'manual' }); await entering; }
    google.disableMail(e.device.id); assert.equal(google.status().pending, false); assert.equal(google.status().mail.connecting, false);
    release();
    if (pending) await pending; else await assert.rejects(fetch(callback, { redirect: 'manual' }));
    assert.deepEqual(e.store.googleCredential(), e.grant); assert.equal(google.status().connected, true); assert.equal(google.status().mail.enabled, false);
  } finally { release(); google.close(); e.close(); }
});
for (const recovery of ['success', 'revoked']) test(`401 repairs authentication without retrying the rejected send: ${recovery}`, async () => {
  const e = env(); let tokens = 0, posts = 0;
  const google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', fetchImpl: async url => {
    if (String(url).includes('/token')) { tokens++;
      return tokens > 1 && recovery === 'revoked' ? response({ error: 'invalid_grant' }, 400)
        : response({ access_token: `SYNTHETIC_ONLY_ACCESS_TOKEN_123456789_${tokens}`, expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SEND_SCOPES.join(' ') }); }
    posts++; return posts === 1 ? response({}, 401) : response({ id: 'sent2', threadId: 'thread2' });
  } });
  try {
    const first = seed(e), rejected = await google.sendMail(e.device.id, first.id, 1, first.sha256, MAIL_SEND_CONSENT);
    assert.equal(rejected.state, 'REJECTED'); assert.equal(rejected.result.http_status, 401); assert.equal(tokens, 2); assert.equal(posts, 1);
    await assert.rejects(google.sendMail(e.device.id, first.id, 1, first.sha256, MAIL_SEND_CONSENT)); assert.equal(posts, 1);
    if (recovery === 'revoked') { assert.equal(google.status().state, 'reconnect_required'); assert.equal(google.status().connected, false); }
    else { const second = seed(e); assert.equal((await google.sendMail(e.device.id, second.id, 1, second.sha256, MAIL_SEND_CONSENT)).state, 'ACCEPTED'); assert.equal(tokens, 2); assert.equal(posts, 2); }
  } finally { google.close(); e.close(); }
});
test('SENT verification refuses unsupported, ambiguous or absent charset declarations', () => {
  const record = startMailAction(prepareMailAction(1, randomUUID(), draft()), randomUUID(), randomUUID());
  for (const value of ['text/plain; charset=UTF-8', 'TEXT/PLAIN; charset="utf-8"']) {
    const copy = sentCopy(record); copy.payload.headers.find(h => h.name === 'Content-Type').value = value; assert.equal(compareSentMail(record, copy), true);
  }
  for (const value of ['text/plain; charset=iso-8859-1', 'text/plain', 'text/html; charset=utf-8', 'text/plain; charset=utf-8; charset=iso-8859-1']) {
    const copy = sentCopy(record); copy.payload.headers.find(h => h.name === 'Content-Type').value = value; assert.equal(compareSentMail(record, copy), null);
  }
  const missing = sentCopy(record); missing.payload.headers = missing.payload.headers.filter(h => h.name !== 'Content-Type'); assert.equal(compareSentMail(record, missing), null);
});
test('reply verification compares the sent References lineage including its parent', () => {
  const value = { ...draft(), reply: { gmail_id: 'original', thread_id: 'thread1', message_id: '<parent@example.test>', references: ['<ancestor@example.test>'], subject: draft().subject } };
  const record = startMailAction(prepareMailAction(1, randomUUID(), value), randomUUID(), randomUUID());
  assert.equal(compareSentMail(record, sentCopy(record)), true);
  for (const reference of ['', '<other@example.test>', '<parent@example.test>', '<ancestor@example.test>']) {
    const copy = sentCopy(record); copy.payload.headers.find(h => h.name === 'References').value = reference; assert.equal(compareSentMail(record, copy), false);
  }
  const missing = sentCopy(record); missing.payload.headers = missing.payload.headers.filter(h => h.name !== 'References'); assert.equal(compareSentMail(record, missing), false);
});

test('a 401 arriving after send authority is disabled keeps its rejection without reviving credentials', async () => {
  const e = env(); let google;
  const c = connection(e, () => { google.disableMail(e.device.id); return response({}, 401); }); google = c.google;
  try {
    const record = seed(e), result = await google.sendMail(e.device.id, record.id, 1, record.sha256, MAIL_SEND_CONSENT);
    assert.equal(result.state, 'REJECTED'); assert.equal(result.result.http_status, 401);
    assert.equal(google.status().mail.enabled, false); assert.equal(google.status().connected, true);
    assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/token')).length, 1);
    assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 1);
  } finally { google.close(); e.close(); }
});

for (const enabled of [true, false]) test(`disabling send preserves the existing related-mail choice: ${enabled}`, () => {
  const e = env(), c = connection(e);
  try {
    e.store.configureRelatedMail(e.device.id, enabled, enabled ? 'related_mail_readonly_v1' : null);
    const prior = e.store.relatedMailEpoch(); c.google.disableMail(e.device.id);
    assert.equal(c.google.status().mail.enabled, false); assert.equal(c.google.status().connected, true);
    assert.equal(e.store.relatedMailEpoch(), prior); e.reopen(); assert.equal(e.store.relatedMailEpoch(), prior);
  } finally { c.google.close(); e.close(); }
});
test('disabling send never rebinds a related-mail grant left stale by account reconnection', () => {
  const e = env();
  try {
    e.store.configureRelatedMail(e.device.id, true, 'related_mail_readonly_v1');
    e.store.saveGoogleCredential(e.device.id, { ...e.grant, epoch: randomUUID() }, e.grant.epoch);
    assert.equal(e.store.relatedMailEpoch(), null);
    e.store.disableMail(e.device.id); assert.equal(e.store.relatedMailEpoch(), null);
    e.reopen(); assert.equal(e.store.relatedMailEpoch(), null);
  } finally { e.close(); }
});
for (const mode of ['available', 'absent', 'duplicate', 'malformed', 'folded', 'long', 'long_from']) test(`read_email exposes complete reply recipients or explicit uncertainty: ${mode}`, async () => {
  const e = env();
  try {
    e.store.submit(e.device.id, randomUUID(), '방금 메일 답장 준비해 줘.'); const job = e.store.claim();
    const received = Date.now() - 60000, headers = [{ name: 'From', value: mode === 'long_from' ? '긴 표시 이름 '.repeat(40) + '<noreply@example.test>' : 'noreply@example.test' }, { name: 'Subject', value: '문의 안내' }, { name: 'Date', value: new Date(received).toUTCString() }, { name: 'Message-ID', value: '<original@example.test>' }];
    if (!['absent', 'long_from'].includes(mode)) headers.push({ name: 'Reply-To', value: mode === 'malformed' ? 'not an address' : mode === 'long' ? 'x'.repeat(2050) : mode === 'folded' ? 'Support <support@example.test>,\r\n "Park, Minseo" <minseo@example.test>' : 'Support <support@example.test>' });
    if (mode === 'duplicate') headers.push({ name: 'Reply-To', value: 'different@example.test' });
    const message = { id: 'm1', threadId: 'thread1', snippet: '확인해 주세요.', labelIds: ['INBOX'], internalDate: String(received), payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from('확인해 주세요.').toString('base64url') } } };
    const connection = { captureGrant: () => ({ connected: true, email: e.grant.email, epoch: e.grant.epoch, related_mail_epoch: null }), assertSnapshot() {}, apiJson: async (device, epoch, url) => url.pathname.endsWith('/messages') ? { messages: [{ id: 'm1' }] } : message };
    const google = new GoogleSources(noSources, e.store, connection, job), mail = new MailSources(google, e.store, job, google), signal = new AbortController().signal;
    await mail.execute('list_recent_emails', {}, signal); const read = await mail.execute('read_email', { id: 'm1' }, signal);
    const usable = ['available', 'folded'].includes(mode);
    assert.equal(read.reply_address_status, usable ? 'available' : ['absent', 'long_from'].includes(mode) ? 'absent' : 'unavailable');
    assert.deepEqual(read.reply_addresses, usable ? mode === 'folded' ? ['support@example.test', 'minseo@example.test'] : ['support@example.test'] : []);
    assert.deepEqual(read.from_addresses, ['noreply@example.test']); assert.equal(read.from_address_status, 'available');
    if (mode === 'long_from') {
      assert.ok(!read.from.includes('noreply@example.test'));
      await mail.execute('prepare_mail', { to: read.from_addresses, cc: [], bcc: [], subject: read.subject, body: '확인했습니다.', reply_to: 'm1' }, signal);
      assert.deepEqual(mail.prepared().draft.to, ['noreply@example.test']);
    }
    if (usable) {
      assert.match(read.content, /support@example.test/u);
      await mail.execute('prepare_mail', { to: read.reply_addresses, cc: [], bcc: [], subject: read.subject, body: '확인했습니다.', reply_to: 'm1' }, signal);
      assert.deepEqual(mail.prepared().draft.to, read.reply_addresses);
    }
  } finally { e.close(); }
});

test('subscription continuation can retain a long mail draft without double-counting its actionable output', async () => {
  const e = env(), c = connection(e); let calls = 0;
  const args = { to: ['recipient@example.test'], cc: [], bcc: [], subject: '자세한 제안', body: 'Long plain text. '.repeat(600), reply_to: null };
  const adapter = new ChatGPTSubscription({ account: {}, model: 'synthetic-mail-model' });
  const service = new ContactService(e.store, { contextLimitBytes: adapter.contextLimitBytes, contextBytes: (...a) => adapter.contextBytes(...a),
    chat: async () => completedTurn({ status: 'completed', usage: { input_tokens: 10, output_tokens: 10 }, output: calls++ === 0
      ? [{ type: 'function_call', namespace: 'tada', name: 'prepare_mail', call_id: 'call-draft', arguments: JSON.stringify(args), status: 'completed' }]
      : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '초안을 저장했어요. 아직 보내지 않았습니다.' }] }],
    }, new Set(['prepare_mail'])) }, noSources);
  service.attachGoogle(c.google);
  try {
    const turn = service.submit(e.device.id, randomUUID(), '자세한 제안 메일을 초안으로 준비해 줘.'); await service.idle();
    assert.equal(e.store.turn(turn.seq).state, 'answered', JSON.stringify(e.store.turn(turn.seq).error));
    const record = e.store.mailActions().records[0]; assert.equal(record.state, 'DRAFT'); assert.equal(record.draft.body, args.body);
    assert.equal(calls, 2); assert.equal(c.requests.length, 0);
  } finally { await service.close(); c.google.close(); e.close(); }
});

test('local recent-mail list and body read fit with related mail and personal delegation enabled', async () => {
  const e = env(); let step = 0, largest = 0;
  e.store.configureRelatedMail(e.device.id, true, 'related_mail_readonly_v1');
  e.store.configureContinuingUse(e.device.id, true, 'continuing_conversation_24h_v1');
  e.store.configureFollowupDelegation(e.device.id, true, 'personal_followups_v1');
  e.store.configureProactive(e.device.id, true, 'connected_attention_v2', 'Asia/Seoul');
  const received = Date.now() - 60000;
  const message = { id: 'm1', threadId: 'thread1', labelIds: ['INBOX'], snippet: 'Please confirm the meeting time.', internalDate: String(received), payload: {
    mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: 'Meeting confirmation' },
      { name: 'Date', value: new Date(received).toUTCString() }, { name: 'Message-ID', value: '<original@example.test>' }],
    body: { data: Buffer.from('Please confirm the meeting time in your reply.').toString('base64url') } } };
  const c = connection(e, url => response(url.pathname.endsWith('/messages') ? { messages: [{ id: 'm1' }] } : message));
  const model = { identity: { provider: 'ollama-local' }, contextBytes: (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools })),
    async chat(messages, tools) {
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify({ messages, tools })));
      if (step) assert.equal(JSON.parse(messages.at(-1).content).error, undefined);
      const name = step === 0 ? 'list_recent_emails' : 'read_email';
      return { message: step++ < 2 ? { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: name === 'read_email' ? { id: 'm1' } : {} } }] }
        : { role: 'assistant', content: '미팅 시간을 확인해 달라는 메일이에요. [S2]' }, input_tokens: 1, output_tokens: 1 };
    } };
  const service = new ContactService(e.store, model, { ...noSources, definitions: discoveryTools }, { timezone: 'Asia/Seoul' }); service.attachGoogle(c.google);
  try {
    const { seq } = service.submit(e.device.id, randomUUID(), '최근 미팅 확인 메일 본문을 읽어줘.'); await service.idle();
    assert.equal(e.store.turn(seq).error, null, `step=${step}, largest=${largest}`); assert.equal(e.store.turn(seq).state, 'answered');
    assert.equal(step, 3); assert.ok(largest <= 14000); assert.equal(c.requests.filter(r => r.url.pathname.endsWith('/send')).length, 0);
  } finally { await service.close(); e.close(); }
});

for (const phase of ['token', 'send']) test(`graceful service handoff drains admitted mail during ${phase} before closing Google`, async () => {
  const e = env(), record = seed(e); let release, entered, posts = 0, finished = false;
  const entering = new Promise(resolve => { entered = resolve; });
  const google = new GoogleConnection({ store: e.store, clientId: '1234567890-synthetic.apps.googleusercontent.com', fetchImpl: async (url, { signal }) => {
    const path = new URL(url).pathname;
    if (path === '/token' && phase === 'token' || path.endsWith('/send') && phase === 'send') {
      entered(); await new Promise(resolve => { release = resolve; }); assert.equal(signal.aborted, false);
    }
    if (path === '/token') return response({ access_token: 'SYNTHETIC_ONLY_ACCESS_TOKEN_123456789', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SEND_SCOPES.join(' ') });
    if (path.endsWith('/send')) { posts++; return response({ id: 'sent1', threadId: 'thread1' }); }
    if (path.endsWith('/messages')) return response({ messages: [{ id: 'sent1' }] });
    return response(sentCopy(e.store.mailAction(record.id)));
  } });
  const service = new ContactService(e.store, {}, noSources); service.attachGoogle(google);
  try {
    const sending = service.sendMail(e.device.id, { id: record.id, revision: record.revision, sha256: record.sha256, consent: MAIL_SEND_CONSENT }); await entering;
    const handoff = service.stopWhenIdle().then(() => { finished = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(finished, false); assert.equal(service.stopped, false);
    release(); assert.equal((await sending).state, 'VERIFIED'); await handoff;
    assert.equal(service.stopped, true); assert.equal(posts, 1);
    await assert.rejects(service.reconcileMail(e.device.id, record.id), /HOST_STOPPING/);
    await service.close(); assert.equal(e.store.mailAction(record.id).state, 'VERIFIED');
  } finally { release?.(); await service.close(); e.close(); }
});
