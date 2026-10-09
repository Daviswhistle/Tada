// Fixed evaluator-only environments. Importing never opens a live account.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
const sources = { definitions: [], validate: () => false, verify: async () => false };
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'provider_state' ? undefined : item));
export const correctionFixtures = () => [
  { variant: 1, target: '새봄', wrong: '가온', unrelated: '보람', ask: '아니, 그 회사 말고 어제 이야기한 회사.' },
  { variant: 2, target: '누리', wrong: '다온', unrelated: '해담', ask: '지금 적힌 회사는 아니야. 어제 마지막에 정한 곳으로 그 조사 업무를 고쳐줘.' },
];
export async function runCorrectionAcceptance({ provider, reportPath, implementation, requestLimit = 32 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const inspected = await provider.inspect(AbortSignal.timeout(20000));
  const report = { kind: 'owner_context_correction_candidate', implementation, runtime: Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider', 'model', 'model_digest', 'billing', 'display_name'].includes(key))),
    harness_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), started_at: new Date().toISOString(), fixed_cases: ['A09'], variants_per_case: 2,
    synthetic_data_only: true, production_scope_changed: false, physical_devices: false, remote_delivery: false, request_limit: requestLimit, product_acceptance: 'not_passed', independent_semantic_review: 'required', model_requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(plain(report), null, 2) + '\n', { mode: 0o600 });
  for (const fixture of correctionFixtures()) {
    const root = mkdtempSync(join(tmpdir(), 'tada-correction-')); let store, service;
    const result = { case: 'A09', variant: fixture.variant, utterance: fixture.ask, fixture: { ...fixture, history: [] }, calls: [] }; report.results.push(result); save();
    try {
      const config = { directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }) };
      store = new ContactStore({ ...config, initialize: true, assistance: true }); const owner = store.addDevice('Fixture owner').id;
      store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1'); store.configureFollowupDelegation(owner, true, 'personal_followups_v1');
      const seed = (text, answer = '기록을 남겼어요.', proposals = []) => {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim(); const checkpoint = new ConversationAssistant({}, sources).checkpoint();
        checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: answer }];
        store.finish(seq, { text: answer, sources: [] }, checkpoint, proposals); result.fixture.history.push({ seq, text, answer }); return seq;
      };
      const irrelevant = seed(`${fixture.unrelated} 회사의 제품 조사는 지난달에 끝났어. 그 기록은 보관만 해줘.`, '지난 조사 기록은 보관하고 새 업무를 만들지 않을게요.');
      const earlier = seed(`다음에 조사할 회사는 ${fixture.target}로 정했어. 유료 요금제 조건과 고객 지원 정책을 비교하는 계획이야. 제품을 구매하거나 회사에 연락하는 건 아니야.`, `조사 대상은 ${fixture.target}, 비교할 항목은 요금제 조건과 고객 지원 정책으로 정리했어요.`);
      const requested = `${fixture.wrong}의 요금제 조건과 고객 지원 정책을 비교할 일을 기억하고 내일 오후에 한 번 알려줘.`;
      const initial = { id: randomUUID(), timezone: 'Asia/Seoul', spec: { operation_id: 'initial_work', target: null, expected_version: 0, title: `${fixture.wrong} 회사 조사`, details: `${fixture.wrong}의 유료 요금제 조건과 고객 지원 정책 비교. 구매·외부 연락 없음.`, state: 'open', waiting_for: null,
        notify_at: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/u, 'Z'), user_quote: requested } };
      seed(requested, '회사 조사 업무와 한 번 알림을 기록했어요.', [initial]); store.confirmFollowup(owner, initial.id, 'approve');
      const before = store.followupPage('all', 0).items[0]; result.work_before = before;
      const draftRequest = '그 회사 조사 알림을 하루 더 미루는 안도 보여줘. 아직 확정하지는 마.';
      const pending = { id: randomUUID(), timezone: 'Asia/Seoul', spec: { ...initial.spec, operation_id: 'unconfirmed_delay', target: before.id, expected_version: before.version,
        notify_at: new Date(Date.now() + 2 * 86400000).toISOString().replace(/\.\d{3}Z$/u, 'Z'), user_quote: draftRequest } };
      seed(draftRequest, '알림을 하루 미루는 변경안만 준비했고, 확인 전에는 바꾸지 않았어요.', [pending]); result.fixture.pending_change = pending;
      for (const text of ['이번 주 운동은 수요일에 했어.', '메모한 책은 달의 지도야.', '점심은 밖에서 먹을 예정이야.', '주말 약속은 아직 미정이야.', '출장은 다음 달에 생각할게.']) seed(text);
      seed(`지금 수정하려는 건 저장돼 있는 회사 조사 업무야. 현재 제목에는 ${fixture.wrong}라고 적혀 있는데 조사 대상을 바로잡으려고 해.`);
      // Fixture timestamps are changed only with its store closed, before any
      // real model call. The user's journal and active work are never touched.
      store.close(); store = null;
      const setup = new DatabaseSync(join(config.directory, 'contact.sqlite'));
      try {
        setup.prepare('UPDATE turns SET created=? WHERE seq=?').run(Date.now() - 3 * 86400000, irrelevant);
        setup.prepare('UPDATE turns SET created=? WHERE seq=?').run(Date.now() - 86400000, earlier);
        for (const item of result.fixture.history) item.created = setup.prepare('SELECT created FROM turns WHERE seq=?').get(item.seq).created;
      } finally { setup.close(); }
      store = new ContactStore(config);
      const record = (operation, input) => {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, variant: fixture.variant, operation, state: 'reserved' }; report.model_requests.push(attempt);
        const call = { number: attempt.number, operation, ...plain(input) }; result.calls.push(call); save(); return { attempt, call };
      };
      const model = { identity: provider.identity, async chat(messages, tools, signal, beforeDispatch) {
        const { attempt, call } = record('chat', { messages, tool_names: tools.map(tool => tool.function.name) });
        try { const value = await provider.chat(messages, tools, signal, beforeDispatch); attempt.state = 'observed'; call.response = plain(value.message); save(); return value; }
        catch (error) { attempt.state = 'unknown'; save(); throw error; }
      } };
      if (typeof provider.contextBytes === 'function') model.contextBytes = (...args) => provider.contextBytes(...args);
      if (provider.contextLimitBytes !== undefined) model.contextLimitBytes = provider.contextLimitBytes;
      if (typeof provider.researchPublicWeb === 'function') model.researchPublicWeb = async (request, previous, signal, beforeDispatch) => {
        const { attempt, call } = record('public_web', { request, previous });
        try { const value = await provider.researchPublicWeb(request, previous, signal, beforeDispatch); attempt.state = 'observed'; call.response = plain(value); save(); return value; }
        catch (error) { attempt.state = 'unknown'; save(); throw error; }
      };
      service = new ContactService(store, model, sources, { timezone: 'Asia/Seoul' });
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews, public_web: typeof model.researchPublicWeb === 'function' };
      if (result.execution_profile.provider !== report.runtime.provider || service.localReviews !== (report.runtime.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      const { seq } = service.submit(owner, randomUUID(), fixture.ask); await service.idle();
      const turn = store.turn(seq); result.turn = { seq, state: turn.state, error: turn.error, answer: turn.answer }; result.work_after = store.followupPage('all', 0); result.usage = store.usage();
      const inspect = new DatabaseSync(join(config.directory, 'contact.sqlite'), { readOnly: true });
      try { result.proposal_lineage = inspect.prepare('SELECT id,turn,state FROM followup_proposals ORDER BY created,id').all(); } finally { inspect.close(); }
      const calls = result.calls.flatMap(call => call.response?.tool_calls ?? []), after = result.work_after.items.find(item => item.id === before.id);
      result.mechanical_checks = { answered: turn.state === 'answered', old_owner_read: calls.some(call => call.function.name === 'read_history' && call.function.arguments.id === earlier),
        one_same_work: result.work_after.items.length === 1 && after?.version === before.version + 1,
        target_corrected: !!after?.title.includes(fixture.target) && !!after?.details.includes(fixture.target) && !after.title.includes(fixture.wrong),
        prior_pending_superseded: result.proposal_lineage.find(item => item.id === pending.id)?.state === 'superseded',
        current_correction_bound: result.proposal_lineage.some(item => item.turn === seq && item.state === 'approved') };
      result.status = Object.values(result.mechanical_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]{1,64}$/u.test(error.message) ? error.message : 'EVALUATION_FAILED'; }
    finally { await service?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); save(); }
    console.log(JSON.stringify({ variant: result.variant, status: result.status, checks: result.mechanical_checks, error: result.error }));
  }
  report.finished_at = new Date().toISOString(); save(); return report;
}
