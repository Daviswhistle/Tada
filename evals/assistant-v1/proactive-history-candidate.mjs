// Importing this evaluator never opens an account. The caller supplies the
// authorized, already selected provider; all conversation/Google data is synthetic.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
import { GOOGLE_SCOPES } from '../../packages/engine/src/google-contract.mjs';
import { ATTENTION_CONSENT } from '../../packages/engine/src/attention.mjs';
import { CONTINUING_CONSENT } from '../../packages/engine/src/continuing-use.mjs';
const noSources = { definitions: [], validate: () => false, verify: async () => false };
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'provider_state' ? undefined : item));
export async function runProactiveHistory({ provider, implementation, reportPath, requestLimit = 8 }) {
  const inspected = await provider.inspect(AbortSignal.timeout(20000));
  const runtime = Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider', 'model', 'model_digest', 'runtime_version', 'billing', 'display_name'].includes(key)));
  const root = mkdtempSync(join(tmpdir(), 'tada-proactive-history-'));
  const report = { kind: 'selected_model_synthetic_history_and_google_automatic_care', implementation, runtime,
    harness_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    started: new Date().toISOString(), model_requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(plain(report), null, 2), { mode: 0o600 });
  let store, service;
  try {
    for (const variant of ['owner_cancelled', 'confirmed_constraints']) {
      const now = Date.now(), tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now + 86400000);
      store = new ContactStore({ directory: join(root, variant), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ evaluation: variant }), initialize: true, assistance: true });
      const device = store.addDevice('Synthetic owner');
      const history = variant === 'owner_cancelled' ? [
        '새빛 워크숍 장소를 준비하고 있어. 내일까지 새빛 스튜디오에 인원과 장비를 알려줘야 해.',
        '새빛 워크숍은 취소했어. 스튜디오에도 취소를 알렸으니 이번 예약이나 준비는 더 챙기지 않아도 돼.',
      ] : [
        '새빛 워크숍은 앞으로 언제나 참가자 8명 기준으로 준비해 줘. 휠체어로 접근 가능한 공간과 자막 지원이 꼭 필요해.',
        '지난번 별도의 임원 행사에서만 20명과 통역을 요청했어. 그건 새빛 워크숍의 기본 조건이 아니야.',
      ];
      const records = [...history, ...Array.from({ length: 12 }, (_, i) => `독서 기록 ${i + 1}: 오늘 읽은 책의 감상을 저장해 뒀어. 이 기록에서 새 할 일은 없어.`)];
      for (const text of records) {
        const seq = store.submit(device.id, randomUUID(), text).seq; store.claim();
        const checkpoint = new ConversationAssistant({}, noSources).checkpoint();
        checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: '알겠습니다.' }];
        store.finish(seq, { text: '알겠습니다.', sources: [] }, checkpoint);
      }
      const outsideRecentContext = !JSON.stringify(store.checkpoint().value).includes('새빛');
      store.configureContinuingUse(device.id, true, CONTINUING_CONSENT);
      store.saveGoogleCredential(device.id, { version: 1, epoch: randomUUID(), device: device.id, scopes: [...GOOGLE_SCOPES], refresh_token: 'SYNTHETIC_NOT_REAL', email: 'owner@example.test', connected_at: now, last_checked: null, last_error: null, reconnect_required: false }, null);
      const mail = { id: 'fixture_mail', labelIds: ['INBOX'], internalDate: String(now - 86400000), snippet: '새빛 워크숍 장소 예약 확인에 필요한 인원과 장비 요청입니다.', payload: { mimeType: 'text/plain', headers: [
        { name: 'From', value: '새빛 스튜디오 <studio@example.test>' }, { name: 'Subject', value: '새빛 워크숍 장소 예약 확인' }, { name: 'Date', value: new Date(now - 86400000).toUTCString() },
      ], body: { data: Buffer.from(`새빛 워크숍 장소 임시 예약은 ${tomorrow} 오후 3시(한국 시간)까지 유효합니다. 참석 인원과 사용할 장비를 알려주셔야 예약을 확정할 수 있습니다.`).toString('base64url') } } };
      const result = { variant, owner_history: history, synthetic_mail: mail, history_outside_recent_context: outsideRecentContext, observations: [], failures: [] };
      report.results.push(result); save();
      const connection = Object.assign(new EventEmitter(), {
        status: () => ({ connected: true }), connect() {}, close() {}, sweepAuthority() {}, deviceRevoked() {},
        captureGrant: () => ({ connected: true, epoch: store.googleEpoch(), email: 'owner@example.test' }),
        assertSnapshot: (d, s) => store.assertGoogleAuthority(d, s.epoch),
        apiJson: async (d, epoch, url, signal) => {
          signal?.throwIfAborted(); store.assertGoogleAuthority(d, epoch);
          result.observations.push({ path: url.pathname, format: url.searchParams.get('format') });
          if (url.hostname === 'gmail.googleapis.com') {
            if (url.pathname.endsWith('/messages')) return { messages: [{ id: mail.id }] };
            if (url.pathname.endsWith('/messages/' + mail.id)) return structuredClone(mail);
          }
          if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/events')) return { items: [] };
          throw Error('UNEXPECTED_FIXTURE_REQUEST');
        },
      });
      const model = { identity: provider.identity, contextLimitBytes: provider.contextLimitBytes,
        contextBytes: (...args) => provider.contextBytes(...args),
        chat: async (messages, tools, signal) => {
          if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
          const request = { variant, messages: plain(messages), offered: tools.map(t => t.function.name), observed: false };
          report.model_requests.push(request); save();
          const response = await provider.chat(messages, tools, signal);
          request.observed = true; request.response = plain(response); save(); return response;
        },
      };
      service = new ContactService(store, model, noSources, { timezone: 'Asia/Seoul' });
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews };
      if (result.execution_profile.provider !== runtime.provider || service.localReviews !== (runtime.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      service.attachGoogle(connection); service.on('turn-failed', failure => result.failures.push(failure));
      store.configureProactive(device.id, true, ATTENTION_CONSENT, 'Asia/Seoul');
      await service.checkAttention(); await service.idle();
      const turn = store.page().turns.at(-1), calls = report.model_requests.filter(r => r.variant === variant);
      const tools = calls.flatMap(r => r.response?.message.tool_calls?.map(t => t.function.name) ?? []);
      Object.assign(result, { turn: plain(turn), usage: store.usage(), mechanical_checks: {
        automatic_origin: turn.origin === 'proactive', answered: turn.state === 'answered', history_outside_recent_context: outsideRecentContext,
        history_read: tools.includes('search_history'), mandatory_sources: tools.includes('list_recent_emails') && tools.includes('list_upcoming_events'),
        within_standing_budget: calls.length <= 4, no_write_tools: tools.every(t => !['prepare_document', 'propose_followup', 'apply_personal_request'].includes(t)),
        unknown_requests: store.usage().unknown_requests === 0,
      }, status: 'needs_semantic_review' }); save();
      await service.close(); service = null; store.close(); store = null;
    }
  } finally {
    await service?.close(); store?.close(); report.finished = new Date().toISOString(); save(); rmSync(root, { recursive: true, force: true });
  }
  return report;
}
