import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { request } from 'node:http';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { GOOGLE_SEND_SCOPES } from '../src/google-contract.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { serveContact } from '../src/contact-http.mjs';
import { BACKUP_CONSENT, BACKUP_COLUMNS, createRecordBackup, openRecordBackup, backupSummary } from '../src/contact-backup.mjs';
import { parseUniqueArchiveJson, parseUniqueJson } from '../src/json.mjs';
const sources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
function protection() {
  const wrapping = randomBytes(32);
  return { kind: 'windows-dpapi-v1', async protect(key) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrapping, iv);
    return Buffer.concat([iv, cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  }, async unprotect(bytes) {
    const cipher = createDecipheriv('aes-256-gcm', wrapping, bytes.subarray(0,12)); cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12,-16)), cipher.final()]);
  } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tada-backup-'));
  const store = new ContactStore({ directory: join(root, 'journal'), initialize: true, assistance: true, mail: true,
    passphrase: 'SYNTHETIC_BACKUP_KEY_ONLY', route: contactRoute({ fixture: 'backup' }) });
  const device = store.addDevice('백업 테스트');
  return { root, store, device, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function turn(e, text = '보존할 대화') {
  const seq = e.store.submit(e.device.id, randomUUID(), text).seq; e.store.claim();
  const checkpoint = new ConversationAssistant({}, sources).checkpoint();
  checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: '보존할 답변' }];
  e.store.finish(seq, { text: '보존할 답변', sources: [] }, checkpoint); return seq;
}
test('archive exports all saved turns beyond UI pagination and excludes credential stores and checkpoints', async () => {
  const e = fixture(); try {
    for (let i = 0; i < 31; i++) turn(e, `보존할 대화 ${i}`);
    const pending = e.store.submit(e.device.id, randomUUID(), '대기한 요청');
    const token = '123456789:SYNTHETIC_MOBILE_TOKEN_ONLY_123456789'; e.store.saveMobileCredential(e.device.id, token);
    const before = e.store.turn(pending.seq), snapshot = e.store.exportRecords(e.device.id);
    assert.equal(snapshot.records.turns.length, 32); assert.equal(snapshot.records.turns[31].state, 'queued');
    assert.equal(snapshot.records.turns[0].payload.text, '보존할 대화 0'); assert.equal(snapshot.records.turns[30].answer.text, '보존할 답변');
    assert.deepEqual(Object.keys(snapshot.records), Object.keys(BACKUP_COLUMNS));
    assert.ok(!JSON.stringify(snapshot).includes(token)); assert.ok(!JSON.stringify(snapshot).includes(e.device.token));
    assert.equal(Object.hasOwn(snapshot.records.devices[0], 'token_hash'), false); assert.equal(Object.hasOwn(snapshot.records, 'context'), false);
    const protector = protection(), archive = await createRecordBackup(snapshot, { protector });
    assert.equal(archive.recoveryCode, null); assert.ok(!archive.bytes.includes(Buffer.from('보존할 답변')));
    assert.deepEqual(await openRecordBackup(archive.bytes, { protector }), snapshot);
    assert.deepEqual(e.store.turn(pending.seq), before); assert.equal(backupSummary(snapshot).turns, 32);
    e.store.revoke(e.device.id); assert.throws(() => e.store.exportRecords(e.device.id), /DEVICE_REVOKED/u);
  } finally { e.close(); }
});
test('optional portable code opens with a different OS account, and wrong keys or changes never fall back', async () => {
  const e = fixture(); try {
    turn(e); const snapshot = e.store.exportRecords(e.device.id), protector = protection();
    const archive = await createRecordBackup(snapshot, { portable: true, protector });
    assert.match(archive.recoveryCode, /^TADA1-[A-Za-z0-9_-]{32}$/u);
    assert.deepEqual(await openRecordBackup(archive.bytes, { recoveryCode: archive.recoveryCode, protector: protection() }), snapshot);
    await assert.rejects(openRecordBackup(archive.bytes, { protector: protection() }), /CANNOT_OPEN/u);
    await assert.rejects(openRecordBackup(archive.bytes, { protector, recoveryCode: 'TADA1-' + 'a'.repeat(32) }), /CANNOT_OPEN/u);
    await assert.rejects(openRecordBackup(archive.bytes, { recoveryCode: 'bad' }), /RECOVERY_CODE_REQUIRED/u);
    for (const at of [0, 20, archive.bytes.length - 1, archive.bytes.length - 20]) {
      const corrupt = Buffer.from(archive.bytes); corrupt[at] ^= 1;
      await assert.rejects(openRecordBackup(corrupt, { recoveryCode: archive.recoveryCode }), /CONTACT_BACKUP_/u);
    }
    await assert.rejects(openRecordBackup(Buffer.concat([archive.bytes, Buffer.from([0])]), { protector }), /INVALID/u);
    const local = await createRecordBackup(snapshot, { protector });
    await assert.rejects(openRecordBackup(local.bytes, { recoveryCode: archive.recoveryCode }), /NOT_PORTABLE/u);
  } finally { e.close(); }
});
test('archive parser has an explicit larger bound without widening ordinary wire readers', () => {
  const text = JSON.stringify({ content: 'x'.repeat(300000) });
  assert.equal(parseUniqueArchiveJson(text).content.length, 300000);
  assert.throws(() => parseUniqueJson(text, 400000), /INVALID_JSON/u);
  for (const invalid of ['{"a":1,"a":2}', '{"a":"\\ud800"}', '{"a":1e999}']) assert.throws(() => parseUniqueArchiveJson(invalid), /INVALID_JSON/u);
});
test('unknown archive fields, schema versions and broken references fail before protection', async () => {
  const e = fixture(); try {
    turn(e); const original = e.store.exportRecords(e.device.id); let protections = 0;
    for (const mutate of [s => s.records.devices[0].token_hash = 'forbidden', s => s.source.schema_version = 99,
      s => s.records.turns[0].device = randomUUID(), s => s.records.turns.push(s.records.turns[0]), s => s.records.extra = []]) {
      const snapshot = structuredClone(original); mutate(snapshot);
      await assert.rejects(createRecordBackup(snapshot, { protector: { kind: 'windows-dpapi-v1', protect() { protections++; } } }), /INVALID/u);
    }
    assert.equal(protections, 0);
  } finally { e.close(); }
});
for (const change of ['revoke','stop']) test(`backup does not return a late private result after ${change}, and serializes creation`, async () => {
  const e = fixture(); let release;
  const protector = protection(), slow = { ...protector, protect: key => new Promise(resolve => { const copy = Buffer.from(key); release = async () => { const wrapped = await protector.protect(copy); copy.fill(0); resolve(wrapped); }; }) };
  const service = new ContactService(e.store, {}, sources, { backup: { protector: slow } });
  try {
    const operation = service.backupRecords(e.device.id, true, BACKUP_CONSENT);
    await assert.rejects(service.backupRecords(e.device.id, false, BACKUP_CONSENT), /BACKUP_BUSY/u);
    if (change === 'revoke') e.store.revoke(e.device.id); else service.beginStop();
    await release(); await assert.rejects(operation, change === 'revoke' ? /DEVICE_REVOKED/u : /HOST_STOPPING/u);
  } finally { await service.close(); e.close(); }
});
test('authenticated same-origin backup download is encrypted, non-cacheable and rejects malformed consent', async () => {
  const e = fixture(), protector = protection(); turn(e);
  const service = new ContactService(e.store, {}, sources, { backup: { protector } }); let host;
  try {
    host = await serveContact({ store: e.store, service, origin: 'http://127.0.0.1:0', port: 0 });
    const call = (body, origin = 'http://127.0.0.1:0', token = e.device.token) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: host.address.port, path: '/api/records/backup', method: 'POST', headers: {
        Host: '127.0.0.1:0', Origin: origin, Cookie: `tada_local=${token}`, 'Content-Type': 'application/json',
      } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) })); });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    const input = { portable: true, consent: BACKUP_CONSENT };
    assert.equal((await call(input, 'https://foreign.test')).status, 403);
    assert.equal((await call(input, undefined, 'unpaired')).status, 401);
    for (const body of [{ ...input, consent: null }, { ...input, portable: 'yes' }, { ...input, extra: true }]) assert.equal((await call(body)).status, 400);
    const result = await call(input); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-disposition'], /\.tadabackup/u);
    const snapshot = await openRecordBackup(result.bytes, { recoveryCode: result.headers['x-tada-recovery-code'] });
    assert.equal(snapshot.records.turns[0].answer.text, '보존할 답변');
    assert.equal(e.store.authenticate(e.device.token), e.device.id);
  } finally { await host?.close(); await service.close(); e.close(); }
});

test('backup preserves follow-up lineage, delivery uncertainty, document versions, saved mail and usage', async () => {
  const e = fixture(); try {
    e.store.telegramConfigure('333'); e.store.telegramBind({ bot: '333', chat: '555', user: '555', after_message: 10 });
    const delivery = e.store.telegramClaimDelivery(); assert.ok(delivery);
    e.store.telegramDelivery(delivery.id, 'unknown', { error: 'SYNTHETIC_RESPONSE_LOST' });
    const text = '내일 회의 준비를 알려줘.', seq = e.store.submit(e.device.id, randomUUID(), text).seq; e.store.claim();
    const cp = new ConversationAssistant({}, sources).checkpoint();
    const proposal = { id: randomUUID(), timezone: 'Asia/Seoul', spec: { operation_id: 'prepare_meeting', target: null, expected_version: 0,
      title: '회의 준비', details: '자료 챙기기', state: 'open', waiting_for: null, notify_at: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, 'Z'), user_quote: text } };
    const requestId = e.store.reserve(seq); e.store.observe(requestId, { input_tokens: 10, output_tokens: 4 });
    e.store.finish(seq, { text: '알림을 제안했어요.', sources: [] }, cp, [proposal]);
    const work = e.store.confirmFollowup(e.device.id, proposal.id, 'approve');
    const docSeq = e.store.submit(e.device.id, randomUUID(), '체크리스트 만들어줘').seq; e.store.claim();
    const document = e.store.prepareDocument(docSeq, { title: '체크리스트', format: 'text', based_on: null });
    e.store.finish(docSeq, { text: '자료 확인', sources: [] }, cp, [], document);
    e.store.editDocument(e.device.id, { request_id: randomUUID(), based_on: docSeq, title: '수정한 체크리스트', content: '자료와 참석자 확인' });
    const secret = 'SYNTHETIC_GOOGLE_REFRESH_ONLY_123456789';
    e.store.saveGoogleCredential(e.device.id, { version: 2, send_enabled: true, epoch: randomUUID(), device: e.device.id, scopes: [...GOOGLE_SEND_SCOPES], refresh_token: secret, email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false }, null);
    const mailSeq = e.store.submit(e.device.id, randomUUID(), '초안 준비').seq; e.store.claim();
    const mail = e.store.prepareMail(mailSeq, { account: 'owner@example.test', to: ['partner@example.test'], cc: [], bcc: [], subject: '자료 요청', body: '자료를 부탁합니다.', reply: null });
    e.store.finish(mailSeq, { text: '초안입니다.', sources: [] }, cp, [], null, null, mail);
    const snapshot = e.store.exportRecords(e.device.id), protector = protection();
    assert.deepEqual(await openRecordBackup((await createRecordBackup(snapshot, { protector })).bytes, { protector }), snapshot);
    assert.equal(snapshot.records.followup_proposals[0].state, 'approved'); assert.equal(snapshot.records.followups[0].id, work.commitment);
    assert.equal(snapshot.records.telegram_outbox.find(r => r.id === delivery.id).state, 'unknown');
    assert.equal(snapshot.records.requests[0].input_tokens, 10); assert.equal(snapshot.records.requests[0].output_tokens, 4);
    assert.equal(snapshot.records.mail_actions[0].payload.id, mail.id); assert.ok(!JSON.stringify(snapshot).includes(secret));
    assert.equal(snapshot.records.turns.filter(t => t.answer?.document).length, 2);
    assert.equal(snapshot.records.turns.find(t => t.answer?.document?.based_on === docSeq).answer.text, '자료와 참석자 확인');
  } finally { e.close(); }
});
