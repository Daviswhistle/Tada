// Fixed evaluator environments. Importing never accesses an account.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
import { GoogleConnection } from '../../packages/engine/src/google-connection.mjs';
import { GOOGLE_SCOPES } from '../../packages/engine/src/google-contract.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'provider_state' ? undefined : item));
const sources = { definitions: [], validate: () => false, verify: async () => false };
const date = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export function contextualAccessFixtures(now = Date.now()) {
  const meetings = [
    ['해솔 시연 미팅 준비', '목표: 주문 조회 화면의 두 시안을 시연하고 한 안을 고른다. 조회 문의는 주 38건. 준비: 두 시안 화면과 배송 지연 사례. 질문: 실패 상태 안내와 접근성 점검 담당. 잠정 시각은 오후 2시, 잠정 장소는 본관 3층이며 확정 일정으로 다시 확인해야 한다.'],
    ['오로라 미팅 준비', '목표: 가입 이탈 개선 실험 하나 결정. 가입 단계 3의 이탈률은 42%. 후보는 필수 입력을 두 개로 축소하기와 도움말 추가하기. 비교할 것: 개발 부담과 가입 완료율. 물어볼 것: 측정 기간과 담당자. 시간·장소는 미확정.'],
  ];
  return [
    { case: 'A06', variant: 1, topic: '오로라', ask: '그거 보내줘.',
      history: '오로라 건의 고객 담당은 김민지, 내부 운영 담당은 박준호야. 제안 요약과 비용 비교 둘 다 준비했어. 두 사람이 어느 자료를 받을지는 아직 정하지 않았어.',
      documents: [['오로라 제안 요약', '가입 단계의 필수 입력을 두 개로 줄이는 실험 제안. 실험 기간은 2주이며 성공 기준은 가입 완료율 5%p 개선이다.'], ['오로라 비용 비교', '입력 축소안은 120만원, 도움말 추가안은 80만원. 두 안의 포함 범위가 달라 가격만으로 고르지 않는다.']],
      recent: '오로라 건은 김민지가 고객 쪽 담당이고 김민지가 일정 조율도 맡아. 자료는 방금 준비한 두 개야. 전달 대상과 자료의 조합은 아직 미정이야.' },
    { case: 'A06', variant: 2, topic: '해솔', ask: '준비해 둔 자료, 그분한테 전달해줘.',
      history: '해솔 행사의 이서연은 현장 운영 담당, 정우진은 참가자 안내 담당이야. 행사 안내와 진행표가 있고 두 사람이 어느 자료를 받을지는 아직 정하지 않았어.',
      documents: [['해솔 진행표', '오후 2시 장비 점검, 3시 행사 시작, 4시 질의응답. 자막과 휠체어 접근을 유지한다.'], ['해솔 행사 안내', '참가자 8명, 1층 회의실. 개인 준비물은 노트 한 권이며 식사는 제공하지 않는다.']],
      recent: '해솔 건은 정우진이 안내 담당이고 정우진과 준비 얘기를 했어. 전달할 자료와 수신자 조합은 아직 정하지 않았어.' },
    { case: 'A07', variant: 1, topic: '오로라', ask: '내일 미팅 준비 좀 해줘.', resume: '연결했어. 이어서 준비해줘.', tomorrow: date(now + 86400000),
      history: '오로라 실험 결정과 해솔 시연 미팅을 준비하고 있어. 각각의 준비 문서는 남겼고 확정 날짜는 이 대화에 적지 않았어. 일정 계정은 아직 연결하지 않았어.',
      documents: meetings, recent: '회의 준비 문서는 두 건 모두 저장했어. 오로라 자료를 마지막으로 손봤어.', otherDate: date(now + 2 * 86400000),
      event: { summary: '오로라 실험 결정 미팅', time: '10:00', location: '새빛센터 2층', description: '필수 입력 축소와 도움말 추가 중 한 실험, 측정 기간과 담당자를 결정합니다.', attendee: '김선아' } },
    { case: 'A07', variant: 2, topic: '해솔', ask: '내일 만나는 자리, 준비할 것부터 챙겨줘.', resume: '이제 일정 연결됐어. 아까 준비하던 거 마무리해줘.', tomorrow: date(now + 86400000),
      history: '해솔 시연과 오로라 실험 결정 미팅을 준비하고 있어. 각각 준비 자료가 있고 확정 날짜는 이 대화에 적지 않았어. 일정 계정은 아직 연결하지 않았어. 문서의 잠정 시간과 장소를 확정으로 쓰지 마.',
      documents: meetings, recent: '회의 준비 자료는 두 건 모두 있어. 가장 최근에 손본 문서는 오로라 실험 결정 자료야.', otherDate: date(now + 3 * 86400000),
      event: { summary: '해솔 주문 조회 시연', time: '15:30', location: '별관 1층 시연실', description: '기존 오후 2시·본관 3층에서 변경 확정. 주문 조회 두 시안과 배송 지연 사례를 비교합니다.', attendee: '박현우' } },
  ];
}
export async function runContextualAccess({ provider, reportPath, implementation, requestLimit = 48 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const inspected = await provider.inspect(AbortSignal.timeout(20000)), fixtures = contextualAccessFixtures();
  const report = { kind: 'contextual_clarification_and_access_candidate', implementation,
    runtime: Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider','model','model_digest','billing','display_name'].includes(key))),
    harness_sha256: sha(readFileSync(new URL(import.meta.url))), fixtures_sha256: sha(JSON.stringify(fixtures)), started_at: new Date().toISOString(),
    fixed_cases: ['A06', 'A07'], fixture_version: 2, variants_per_case: 2, synthetic_data_only: true, production_scope_changed: false,
    live_google_oauth: false, physical_devices: false, sending_capability: false, product_acceptance: 'not_passed',
    independent_semantic_review: 'required', request_limit: requestLimit, model_requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(plain(report), null, 2) + '\n', { mode: 0o600 });
  for (const fixture of fixtures) {
    const root = mkdtempSync(join(tmpdir(), 'tada-contextual-access-')); let store, service, connection;
    const result = { case: fixture.case, variant: fixture.variant, fixture: { ...fixture, history_records: [], document_records: [] }, calls: [], network: [], phases: [] };
    report.results.push(result); save();
    try {
      store = new ContactStore({ directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }), initialize: true, assistance: true });
      const owner = store.addDevice('Synthetic owner').id; store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1');
      const seed = (text, answer, title = null) => {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim();
        const spec = title ? store.prepareDocument(seq, { title, format: 'markdown', based_on: null }) : null;
        const checkpoint = new ConversationAssistant({}, sources).checkpoint();
        checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: title ? `Saved document: ${seq}. Read it for content.` : answer }];
        store.finish(seq, { text: answer, sources: [], verification: 'not_applicable' }, checkpoint, [], spec);
        result.fixture.history_records.push({ seq, text, answer }); if (title) result.fixture.document_records.push(store.document(seq)); return seq;
      };
      seed(fixture.history, '준비 정보를 기록했어요.');
      for (const [title, body] of fixture.documents) seed(`${title} 내용을 문서로 남겨줘.`, body, title);
      const unrelated = seed('별개의 라일락 고객 시연은 지난달 끝났어. 담당 이서연도 해솔 담당자와 동명이인인 다른 사람이야. 이 업무는 종료됐어.', '라일락 가격 시연, 오후 5시. 지난달 완료.', '라일락 지난달 결과');
      seed(fixture.recent ?? `${fixture.topic} 미팅 자료를 바탕으로 준비할 거야. 시간과 장소는 일정이 확정되면 확인할게.`, '알겠습니다.');
      const originalDocuments = result.fixture.document_records.map(doc => ({ id: doc.id, sha256: doc.sha256 }));
      let phase = 'initial', opened = '';
      const fetchImpl = async (input, init) => {
        init.signal?.throwIfAborted(); const url = new URL(input);
        result.network.push({ phase, path: url.pathname, method: init.method, timeMin: url.searchParams.get('timeMin'), timeMax: url.searchParams.get('timeMax') });
        let value;
        if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') value = { access_token: 'SYNTHETIC_ACCESS_ONLY', refresh_token: 'SYNTHETIC_REFRESH_ONLY', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') };
        else if (url.pathname.endsWith('/users/me/profile')) value = { emailAddress: 'owner@example.test' };
        else if (url.pathname.endsWith('/events') && fixture.event) {
          const event = fixture.event;
          value = { items: [{ id: 'target', status: 'confirmed', summary: event.summary, location: event.location, description: event.description,
            attendees: [{ email: 'colleague@example.test', displayName: event.attendee }],
            start: { dateTime: `${fixture.tomorrow}T${event.time}:00+09:00` }, end: { dateTime: `${fixture.tomorrow}T${String(Number(event.time.slice(0, 2)) + 1).padStart(2, '0')}${event.time.slice(2)}:00+09:00` } },
          { id: 'cancelled', status: 'cancelled', summary: `${fixture.topic} 취소된 옛 일정` },
          { id: 'other_meeting', status: 'confirmed', summary: fixture.variant === 1 ? '해솔 주문 조회 시연' : '오로라 실험 결정 미팅', location: '본관 3층', start: { dateTime: `${fixture.otherDate}T14:00:00+09:00` }, end: { dateTime: `${fixture.otherDate}T15:00:00+09:00` } },
          { id: 'unrelated', status: 'confirmed', summary: '라일락 다른 고객 점검', location: '본관 4층', start: { dateTime: `${fixture.tomorrow}T17:00:00+09:00` }, end: { dateTime: `${fixture.tomorrow}T18:00:00+09:00` } }] };
        } else if (url.pathname.endsWith('/messages')) value = { messages: [] };
        else throw Error('UNEXPECTED_FIXTURE_REQUEST');
        return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
      };
      connection = new GoogleConnection({ store, clientId: '123456789012-fixture.apps.googleusercontent.com', openBrowser: async url => { opened = url; return true; }, fetchImpl });
      const invoke = async (operation, input, run) => {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, case: fixture.case, variant: fixture.variant, phase, operation, state: 'reserved' }; report.model_requests.push(attempt);
        const call = { number: attempt.number, phase, operation, ...plain(input) }; result.calls.push(call); save();
        try { const value = await run(); attempt.state = 'observed'; call.response = plain(operation === 'chat' ? value.message : value); save(); return value; }
        catch (error) { const usage = error?.observedUsage, known = [usage?.input_tokens, usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0);
          attempt.state = known ? 'observed_failure' : 'unknown'; if (known) call.observed_usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
          call.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_PROVIDER_FAILED'; save(); throw error; }
      };
      const model = { identity: provider.identity, chat: (messages, tools, signal, beforeDispatch) => invoke('chat', { messages, tool_names: tools.map(t => t.function.name) }, () => provider.chat(messages, tools, signal, beforeDispatch)) };
      if (typeof provider.researchPublicWeb === 'function') model.researchPublicWeb = (request, previous, signal, beforeDispatch) => invoke('public_web', { request, previous }, () => provider.researchPublicWeb(request, previous, signal, beforeDispatch));
      if (typeof provider.contextBytes === 'function') model.contextBytes = (...args) => provider.contextBytes(...args);
      if (provider.contextLimitBytes !== undefined) model.contextLimitBytes = provider.contextLimitBytes;
      service = new ContactService(store, model, sources, { timezone: 'Asia/Seoul' }); service.attachGoogle(connection);
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews, public_web: typeof model.researchPublicWeb === 'function' };
      if (result.execution_profile.provider !== inspected.provider || service.localReviews !== (inspected.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      const runPhase = async utterance => {
        const seq = service.submit(owner, randomUUID(), utterance).seq; await service.idle(); const turn = store.turn(seq);
        const observed = result.calls.filter(call => call.phase === phase).flatMap(call => call.messages ?? []).filter(message => message.role === 'tool');
        const entry = { phase, utterance, seq, state: turn.state, error: turn.error, answer: turn.answer, document: store.document(seq), observed_tools: plain(observed), connected: connection.status().connected, usage: store.usage() };
        result.phases.push(entry); save(); return entry;
      };
      const initial = await runPhase(fixture.ask);
      if (fixture.case === 'A07' && initial.state === 'answered') {
        phase = 'connecting'; await service.connectGoogle(owner, 'google_readonly_v1');
        const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
        result.connection = { consent: 'google_readonly_v1', scopes: auth.searchParams.get('scope').split(' '), pkce: auth.searchParams.get('code_challenge_method') };
        callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'SYNTHETIC_AUTH_CODE');
        const completed = await fetch(callback); result.connection.completed = completed.ok && (await completed.text()).includes('Google 계정 연결 완료') && connection.status().connected;
        if (!result.connection.completed) throw Error('EVAL_CONNECTION_FAILED');
        phase = 'resumed'; await runPhase(fixture.resume);
      }
      result.usage = store.usage();
      const calls = result.calls.flatMap(call => call.response?.tool_calls ?? []), initialCalls = result.calls.filter(call => call.phase === 'initial').flatMap(call => call.response?.tool_calls ?? []);
      const readIds = initialCalls.filter(call => call.function.name === 'read_document').map(call => call.function.arguments.id);
      const pending = store.followupState().proposals;
      result.mechanical_checks = { answered: result.phases.every(p => p.state === 'answered'), originals_preserved: originalDocuments.every(doc => store.document(doc.id).sha256 === doc.sha256),
        relevant_documents_read: result.fixture.document_records.filter(doc => doc.id !== unrelated).every(doc => readIds.includes(doc.id)),
        no_unrelated_document_read: !calls.some(call => call.function.name === 'read_document' && call.function.arguments.id === unrelated),
        no_unrequested_work_proposals: pending.length === 0, no_google_before_connection: !result.network.some(request => request.phase === 'initial'),
        current_sources_unavailable_initially: result.calls.filter(call => call.phase === 'initial' && call.operation === 'chat').every(call => !call.tool_names.includes('list_upcoming_events')),
        ...(fixture.case === 'A07' ? { both_phases_completed: result.phases.length === 2, connection_completed: result.connection?.completed === true,
          calendar_read_after_connection: result.network.some(request => request.phase === 'resumed' && request.path.endsWith('/events')),
          saved_lineage_preserved: !result.phases[0].document || !result.phases[1]?.document || result.phases[1].document.root === result.phases[0].document.root } : {}),
        usage_metered: result.usage.requests === report.model_requests.filter(item => item.case === fixture.case && item.variant === fixture.variant).length };
      result.status = Object.values(result.mechanical_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_FAILED'; }
    finally { await service?.close(); await connection?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); save(); }
    console.log(JSON.stringify({ case: fixture.case, variant: fixture.variant, status: result.status, error: result.error, checks: result.mechanical_checks }));
  }
  report.finished_at = new Date().toISOString(); save(); return report;
}
