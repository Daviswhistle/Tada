import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
import { GoogleConnection } from '../../packages/engine/src/google-connection.mjs';
import { MailSources } from '../../packages/engine/src/mail-sources.mjs';
import { GOOGLE_SEND_SCOPES } from '../../packages/engine/src/google-contract.mjs';
import { MAIL_SEND_CONSENT } from '../../packages/engine/src/mail-actions.mjs';
const base = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tada-mail-confirm-'));
  const options = { directory: join(root, 'journal'), passphrase: 'SYNTHETIC_CONFIRMATION_JOURNAL_ONLY', route: contactRoute({ fixture: 'mail-confirmation' }) };
  let store = new ContactStore({ ...options, initialize: true, assistance: true, mail: true });
  const device = store.addDevice('synthetic owner');
  store.configureContinuingUse(device.id, true, 'continuing_conversation_24h_v1');
  store.saveGoogleCredential(device.id, { version: 2, send_enabled: true, epoch: randomUUID(), device: device.id,
    scopes: [...GOOGLE_SEND_SCOPES], refresh_token: 'SYNTHETIC_REFRESH_TOKEN_ONLY_123456789', email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false }, null);
  return { device, get store() { return store; }, reopen() { store.close(); store = new ContactStore(options); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function seed(e, subject, body, recipient = 'minseo@example.test') {
  const text = `${subject} 메일을 준비해 줘.`, seq = e.store.submit(e.device.id, randomUUID(), text).seq; e.store.claim();
  const record = e.store.prepareMail(seq, { account: 'owner@example.test', to: [recipient], cc: [], bcc: [], subject, body, reply: null });
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
const variants = [
  { variant: 1, available: true, subject: '민서 씨 미팅 시간 확인', recipient: 'minseo@example.test', body: '민서 님, 금요일 오후 3시에 뵙겠습니다.', utterance: '아까 보낸 거 확인해줘.' },
  { variant: 2, available: false, subject: '지현 씨 검토 자료 전달 일정', recipient: 'jihyun@example.test', body: '지현 님, 검토 의견은 목요일까지 전달하겠습니다.', utterance: '조금 전에 보낸 메일, 처리됐는지 확인해줄래?' },
];
export async function runConfirmationAcceptance({ provider, implementation, reportPath, requestLimit = 24 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 24) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const report = { kind: 'mail_confirmation_acceptance_candidate', implementation, synthetic_data_only: true, remote_delivery: false,
    harness_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    fixtures_sha256: createHash('sha256').update(JSON.stringify(variants)).digest('hex'), started_at: new Date().toISOString(), requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, (key, value) => key === 'provider_state' ? undefined : value, 2) + '\n', { mode: 0o600 });
  const info = await provider.inspect(AbortSignal.timeout(20000));
  report.runtime = Object.fromEntries(Object.entries(info).filter(([key]) => ['provider', 'model', 'model_digest', 'runtime_version', 'billing', 'display_name'].includes(key)));
  for (const f of variants) {
    const e = fixture(); let service, copy, restored = false;
    const result = { variant: f.variant, utterance: f.utterance, fixture: f, calls: [], google: [], posts: 0 };
    report.results.push(result); save();
    try {
      const target = seed(e, f.subject, f.body, f.recipient);
      const handler = (url, options) => {
        result.google.push({ phase: restored ? 'confirmation' : 'initial_send', path: url.pathname, method: options.method ?? 'GET' }); save();
        if (url.pathname.endsWith('/send')) {
          result.posts++; copy = copyFromPost(JSON.parse(options.body).raw);
          result.accepted_mime_sha256 = createHash('sha256').update(Buffer.from(JSON.parse(options.body).raw, 'base64url')).digest('hex');
          result.server_copy = copy; save(); throw Error('SYNTHETIC_RESPONSE_LOST_AFTER_ACCEPTANCE');
        }
        if (!restored || !f.available) throw Error('SYNTHETIC_LOOKUP_UNAVAILABLE');
        if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: copy.id }] });
        if (url.pathname.endsWith('/sent1')) return json(copy);
        if (url.pathname.endsWith('/events')) return json({ items: [] });
        throw Error('EVAL_UNEXPECTED_GOOGLE_REQUEST');
      };
      service = new ContactService(e.store, {}, base); service.attachGoogle(connect(e, handler));
      result.initial_receipt = await service.sendMail(e.device.id, { id: target.id, revision: target.revision, sha256: target.sha256, consent: MAIL_SEND_CONSENT });
      await service.close(); e.reopen(); restored = true; result.restored_receipt = e.store.mailAction(target.id);
      const distractor = seed(e, f.variant === 1 ? '다음 달 행사 초안' : '월요일 워크숍 참석 문의', '아직 검토 중인 초안입니다.', 'other@example.test');
      const model = { identity: provider.identity, ...(typeof provider.contextBytes === 'function' ? { contextBytes: (...args) => provider.contextBytes(...args) } : {}), contextLimitBytes: provider.contextLimitBytes,
        async chat(messages, tools, signal, beforeDispatch) {
          if (report.requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
          const attempt = { number: report.requests.length + 1, variant: f.variant, state: 'reserved' };
          report.requests.push(attempt); const call = { number: attempt.number, messages, tools: tools.map(t => t.function.name) }; result.calls.push(call); save();
          try { const response = await provider.chat(messages, tools, signal, beforeDispatch); attempt.state = 'observed'; call.response = response.message; save(); return response; }
          catch (error) { attempt.state = 'unknown'; call.error = /^[A-Z_]+$/u.test(error?.message) ? error.message : 'EVAL_PROVIDER_FAILED'; save(); throw error; }
        },
      };
      if (typeof provider.researchPublicWeb === 'function') model.researchPublicWeb = async (request, previous, signal, beforeDispatch) => {
        if (report.requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.requests.length + 1, variant: f.variant, operation: 'web', state: 'reserved' }; report.requests.push(attempt); save();
        try { const response = await provider.researchPublicWeb(request, previous, signal, beforeDispatch); attempt.state = 'observed'; save(); return response; }
        catch (error) { attempt.state = 'unknown'; save(); throw error; }
      };
      service = new ContactService(e.store, model, base, { timezone: 'Asia/Seoul' }); service.attachGoogle(connect(e, handler));
      const turn = service.submit(e.device.id, randomUUID(), f.utterance); await service.idle();
      const saved = e.store.turn(turn.seq); result.state = saved.state; result.error = saved.error; result.answer = saved.answer;
      result.final_receipt = e.store.mailAction(target.id); result.distractor = e.store.mailAction(distractor.id); result.usage = e.store.usage();
      const toolMessages = result.calls.flatMap(call => call.messages.filter(m => m.role === 'tool' && m.tool_name === 'read_mail_action'));
      const observations = toolMessages.map(m => { try { return JSON.parse(m.content); } catch { return null; } }).filter(Boolean);
      result.checks = { answered: saved.state === 'answered', exactlyOnePost: result.posts === 1,
        initiallyUncertain: result.initial_receipt.state === 'UNCERTAIN' && result.restored_receipt.state === 'UNCERTAIN',
        queriedExternal: result.google.some(r => r.phase === 'confirmation' && r.path.endsWith('/messages')),
        readCorrectReceipt: observations.some(r => r.id === target.id),
        expectedState: result.final_receipt.state === (f.available ? 'VERIFIED' : 'UNCERTAIN'),
        freshOrUnavailable: observations.some(r => r.id === target.id && r.status_check?.state === (f.available ? 'fresh' : 'unavailable')),
        distractorUnsent: result.distractor.state === 'DRAFT', noNewDraft: e.store.mailActions().records.length === 2,
      };
      result.status = Object.values(result.checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]+$/u.test(error?.message) ? error.message : 'EVAL_FAILED'; }
    finally { await service?.close(); e.close(); save(); }
  }
  report.finished_at = new Date().toISOString(); save(); return report;
}
