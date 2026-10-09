// Evaluator-only fixtures. No account acquisition, live inference or mutation on import.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
const sha = text => createHash('sha256').update(text).digest('hex');

export function preferenceFixtures() {
  return [
    { variant: 1, project: '이음', ask: '평소처럼 정리해줘.',
      preference: '이음 운영 보고서는 앞으로 결정 사항 → 담당자·기한 → 미해결점 순서로 짧은 항목으로 정리해줘. 이걸 평소 방식으로 확정할게. 근거 없는 담당자나 기한은 채우지 말아줘.',
      exception: '이번 이음 운영 보고의 경영진용 초안만 배경과 기대효과를 길게 풀어서 써줘. 이번 한 번만 쓸 형식이야.',
      exceptionAnswer: '이음 경영진용 초안은 배경과 기대효과를 긴 서술형으로 정리할게요.',
      content: '# 이음 운영 회의 확정 메모\n이번 주 확정본. 이전 초안보다 우선한다.\n가입 도움말 개선을 먼저 시행하기로 확정. 결제 화면 개편은 이번 주 제외.\n도움말 문구: 지윤이 10월 14일 15시까지 초안 작성. 접근성 검수: 민호 담당, 검수 날짜는 아직 미정.\n미해결: 실험 성공 기준과 검수 날짜. 초기 초안의 전면 개편안은 채택하지 않음.\n',
      oldContent: '# 이음 지난주 초안\n전면 개편과 결제 화면 변경을 함께 검토. 모든 일은 준호 담당, 10월 10일 완료라는 초기 제안. 아직 확정 전.\n' },
    { variant: 2, project: '모람', ask: '늘 해주던 방식으로 이번 것도 정리해 줘.',
      preference: '모람 진행 상황은 표보다 짧은 서술형이 편해. 바뀐 결정과 다음 행동, 남은 불확실성이 자연스럽게 읽히는 짧은 문단으로 해줘. 이 형식을 기본으로 써줘.',
      exception: '모람의 다음 진행 자료는 정리되는 대로 알려줄게.',
      exceptionAnswer: '다음 모람 보고는 항목·담당·기한을 열로 둔 표 형식을 써 보는 건 어떨까요? 아직 선택하신 것으로 기록하지는 않았어요.',
      content: '# 모람 출시 점검 확정 기록\n현재 확정본. 종전 할인 검토안은 철회.\n배송 알림 개선을 먼저 진행하고 가격 할인은 하지 않기로 결정.\n수아가 10월 16일 오전까지 안내 문구를 작성. 준은 고객 문의를 분류하되 완료일은 아직 미정.\n성공 기준은 다음 회의에서 정할 예정이며 고객 만족도 수치는 아직 측정하지 않음.\n',
      oldContent: '# 모람 초기 논의\n할인 프로모션을 먼저 하고 은수가 10월 12일까지 완료하는 안을 검토. 결정 전 초안.\n' },
  ];
}

export async function runPreferenceAcceptance({ repo, provider, reportPath, implementation, broker = join(repo, 'target/debug/tada-read-broker'), requestLimit = 24 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const load = path => import(pathToFileURL(join(repo, path)).href);
  const { ContactStore, contactRoute } = await load('packages/engine/src/contact-store.mjs');
  const { ContactService } = await load('packages/engine/src/contact-service.mjs');
  const { ConversationAssistant } = await load('packages/engine/src/conversation.ts');
  const { NativeSources } = await load('packages/engine/src/native-sources.mjs');
  const inspected = await provider.inspect(AbortSignal.timeout(20000));
  const runtime = Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider', 'model', 'model_digest', 'runtime_version', 'billing', 'display_name'].includes(key)));
  const fixtures = preferenceFixtures();
  const report = { kind: 'preference_acceptance_candidate', implementation, runtime, harness_sha256: sha(readFileSync(new URL(import.meta.url))),
    started_at: new Date().toISOString(), fixed_cases: ['A05'], variants_per_case: 2, fixtures_sha256: sha(JSON.stringify(fixtures)),
    synthetic_data_only: true, production_scope_changed: false, physical_devices: false, remote_delivery: false,
    product_acceptance: 'not_passed', independent_semantic_review: 'required', request_limit: requestLimit, model_requests: [], results: [] };
  const persist = () => writeFileSync(reportPath, JSON.stringify(report, (key, value) => key === 'provider_state' ? undefined : value, 2) + '\n', { mode: 0o600 });
  for (const fixture of fixtures) {
    const root = mkdtempSync(join(tmpdir(), 'tada-preference-')); let store, service;
    const result = { case: 'A05', variant: fixture.variant, utterance: fixture.ask, fixture: { ...fixture, history: [], files: [] }, observations: [], calls: [] };
    report.results.push(result); persist();
    try {
      const notes = join(root, 'notes'); mkdirSync(notes);
      const target = `${fixture.project}-확정-${randomBytes(4).toString('hex')}.md`;
      for (const [name, content] of [[target, fixture.content], [`${fixture.project}-지난주-초안.md`, fixture.oldContent], ['라일락-행사.md', '# 라일락 지난 행사\n이미 끝난 행사. 참여 인원 80명. 다음 행사 계획은 없음.\n']]) {
        writeFileSync(join(notes, name), content); result.fixture.files.push({ name, content, sha256: sha(content) });
      }
      const native = new NativeSources(broker, [notes]); await native.initialize();
      const sources = { definitions: native.definitions, validate: (...args) => native.validate(...args),
        async execute(...args) { const value = await native.execute(...args); result.observations.push({ tool: args[0], args: args[1], value }); return value; },
        async verify(...args) { const valid = await native.verify(...args); result.observations.push({ tool: 'citation_recheck', path: args[0].path, valid }); return valid; } };
      store = new ContactStore({ directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }), initialize: true, assistance: true });
      const owner = store.addDevice('Fixture owner').id; store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1');
      const seed = (text, answer = '기록을 남겼어요.') => {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim();
        const checkpoint = new ConversationAssistant({}, sources).checkpoint();
        checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: answer }];
        store.finish(seq, { text: answer, sources: [] }, checkpoint);
        result.fixture.history.push({ seq, text, answer });
      };
      seed(fixture.preference, '말씀하신 형식을 이 프로젝트의 기본 정리 방식으로 기억할게요.');
      seed('라일락 행사 회고는 준비 비용만 표로 정리해줘. 다른 프로젝트 보고 방식과는 별개야.');
      seed(fixture.exception, fixture.exceptionAnswer);
      for (const text of ['내일은 점심을 밖에서 먹을 예정이야.', '메모해 둔 책 제목은 달의 지도였어.', '이번 주 운동은 수요일에 했어.', '출장은 아직 정해지지 않았어.', '주말 일정은 나중에 정할게.']) seed(text);
      seed(`이번에 정리할 대상은 ${fixture.project}의 이번 주 운영 보고야. 연결된 문서 폴더에 이번 주 확정 기록과 예전 초안이 있어. 이번 주 확정 내용으로 정리할 거야.`);
      result.fixture.active_context = result.fixture.history.at(-1);
      const metered = { get identity() { return provider.identity; }, async chat(messages, tools, signal) {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, case: 'A05', variant: fixture.variant, state: 'reserved' };
        report.model_requests.push(attempt); const call = { number: attempt.number, operation: 'chat', messages: structuredClone(messages), tool_names: tools.map(tool => tool.function.name) }; result.calls.push(call); persist();
        try { const response = await provider.chat(messages, tools, signal); attempt.state = 'observed'; call.response = response.message; persist(); return response; }
        catch (error) { attempt.state = 'unknown'; persist(); throw error; }
      } };
      if (typeof provider.researchPublicWeb === 'function') metered.researchPublicWeb = async (request, previous, signal) => {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, case: 'A05', variant: fixture.variant, state: 'reserved' };
        report.model_requests.push(attempt);
        const call = { number: attempt.number, operation: 'public_web', request, previous: structuredClone(previous) }; result.calls.push(call); persist();
        try { const response = await provider.researchPublicWeb(request, previous, signal); attempt.state = 'observed'; call.research_response = response; persist(); return response; }
        catch (error) { attempt.state = 'unknown'; persist(); throw error; }
      };
      if (typeof provider.contextBytes === 'function') metered.contextBytes = (...args) => provider.contextBytes(...args);
      if (provider.contextLimitBytes !== undefined) metered.contextLimitBytes = provider.contextLimitBytes;
      service = new ContactService(store, metered, sources, { timezone: 'Asia/Seoul' });
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews, public_web: typeof metered.researchPublicWeb === 'function' };
      if (result.execution_profile.provider !== runtime.provider || service.localReviews !== (runtime.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      result.work_before = store.followupState();
      const { seq } = service.submit(owner, randomUUID(), fixture.ask); await service.idle();
      const turn = store.turn(seq); result.turn = { state: turn.state, error: turn.error, answer: turn.answer }; result.usage = store.usage(); result.work_after = store.followupState();
      const calls = result.calls.flatMap(call => call.response?.tool_calls ?? []);
      const observedHistory = new Set();
      for (const call of result.calls) for (const message of call.messages ?? []) {
        if (message.role !== 'tool' || !['search_history', 'read_history'].includes(message.tool_name)) continue;
        const value = JSON.parse(message.content);
        for (const record of message.tool_name === 'search_history' ? value.matches ?? [] : [value]) if (record.id) observedHistory.add(record.id);
      }
      result.observed_history_ids = [...observedHistory];
      result.mechanical_checks = { answered: turn.state === 'answered', competing_formats_observed: observedHistory.has(result.fixture.history[0].seq) && observedHistory.has(result.fixture.history[2].seq), history_lookup: calls.some(call => ['search_history', 'read_history'].includes(call.function.name)),
        current_document_read: result.observations.some(item => item.tool === 'read_file' && item.args.path === target),
        sources_rechecked: turn.answer?.verification === 'cited_sources_rechecked',
        unchanged_source_files: result.fixture.files.every(file => sha(readFileSync(join(notes, file.name))) === file.sha256),
        unchanged_work: JSON.stringify(result.work_before) === JSON.stringify(result.work_after) };
      result.status = Object.values(result.mechanical_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]{1,64}$/u.test(error.message) ? error.message : 'EVALUATION_FAILED'; }
    finally { await service?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); persist(); }
    console.log(JSON.stringify({ case: result.case, variant: result.variant, status: result.status, checks: result.mechanical_checks, error: result.error }));
  }
  report.finished_at = new Date().toISOString(); persist(); return report;
}
