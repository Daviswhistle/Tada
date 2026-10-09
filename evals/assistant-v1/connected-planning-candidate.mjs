// Evaluator-only environments. Cases/oracles never enter the assistant context.
// Importing this module neither opens an account nor invokes a model.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const day = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
export function planningFixtures(now) {
  const today = day(now), tomorrow = day(now + 86400000);
  const weekday = new Date(today + 'T00:00:00+09:00').getUTCDay();
  // UTC at Korean midnight is the preceding day: Monday maps to Sunday (0).
  const monday = day(now - weekday * 86400000), sunday = day(now + (6 - weekday) * 86400000);
  return [1, 2].flatMap(variant => [
    { case: 'A13', variant, today, tomorrow, monday, sunday, name: variant === 1 ? '오로라' : '해오름',
      ask: variant === 1 ? '내일 미팅 준비 좀 해줘.' : '내일 있는 회의, 내가 뭘 알고 가야 할지 챙겨줘.' },
    { case: 'A14', variant, today, tomorrow, monday, sunday, name: variant === 1 ? '미루' : '버들',
      ask: variant === 1 ? '이번 주 할 일 좀 정리해줘.' : '이번 주 남은 일들, 뭘 먼저 해야 할지 살펴봐 줘.' },
  ]);
}

export async function runPlanningAcceptance({ repo, provider, reportPath, implementation, requestLimit = 48 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const load = path => import(pathToFileURL(join(repo, path)).href);
  const { ContactStore, contactRoute } = await load('packages/engine/src/contact-store.mjs');
  const { ContactService } = await load('packages/engine/src/contact-service.mjs');
  const { ConversationAssistant } = await load('packages/engine/src/conversation.ts');
  const { NativeSources } = await load('packages/engine/src/native-sources.mjs');
  const { GoogleConnection } = await load('packages/engine/src/google-connection.mjs');
  const { GOOGLE_SCOPES } = await load('packages/engine/src/google-contract.mjs');
  const inspected = await provider.inspect(AbortSignal.timeout(20000));
  const runtime = Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider', 'model', 'model_digest', 'runtime_version', 'billing', 'display_name'].includes(key)));
  const report = { kind: 'connected_planning_candidate', implementation, runtime,
    harness_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    started_at: new Date().toISOString(), fixed_cases: ['A13', 'A14'], variants_per_case: 2,
    synthetic_data_only: true, production_scope_changed: false, physical_devices: false, remote_delivery: false,
    product_acceptance: 'not_passed', independent_semantic_review: 'required', request_limit: requestLimit, model_requests: [], results: [] };
  const persist = () => writeFileSync(reportPath, JSON.stringify(report, (key, value) => key === 'provider_state' ? undefined : value, 2) + '\n', { mode: 0o600 });
  const now = Date.now();
  for (const f of planningFixtures(now)) {
    const root = mkdtempSync(join(tmpdir(), 'tada-planning-'));
    let store, service;
    const result = { case: f.case, variant: f.variant, utterance: f.ask, fixture: { ...f, history: [], files: [], emails: [], events: [] }, observations: [], calls: [] };
    report.results.push(result); persist();
    try {
      const notes = join(root, 'notes'); mkdirSync(notes);
      const writeNote = (name, content) => { writeFileSync(join(notes, name), content); result.fixture.files.push({ name, content }); };
      const target = `${f.name}-회의-${randomBytes(4).toString('hex')}.md`;
      if (f.case === 'A13') {
        writeNote(target, `# ${f.name} 회의 자료\n資料更新: ${f.today}\n${f.variant === 1 ? '가입 단계 3에서 이탈이 42%로 가장 높다. 비교할 실험은 필수 입력 2개로 축소하기와 도움말 추가하기다. 지원팀 선아가 실험 검토를 맡는다.' : '초기 안은 가격 인하였으나 비용 여력이 없어 철회됐다. 현재 안은 배송 안내 개선과 주문 조회 단순화다. 조회 문의는 주 38건이다. 검토 담당은 현우다.'}\n결정할 것은 실험 한 개와 성공 지표, 담당자다. 이 문서에는 실험 결과가 아직 없다.\n`);
        writeNote('옛-회의-메모.md', `지난달 ${f.name} 회의 초안: ${f.variant === 1 ? '전면 재설계' : '가격 인하'}를 논의했다. 이 문서는 지난달 기록이며 현재 안건은 아니다.\n`);
      } else writeNote(`${f.name}-작업-의존관계.md`, `${f.name} 출시: 검수 승인이 난 후 최종 공지 작성, 이후 배포 가능. 디자인 인수와 검수 승인은 다른 단계다.\n`);
      writeNote('무관한-프로젝트.md', '별개의 라일락 행사 기록. 올해 3월 행사는 종료됐다.\n');
      const native = new NativeSources(join(repo, 'target/debug/tada-read-broker'), [notes]); await native.initialize();
      const sources = { definitions: native.definitions, validate: (...a) => native.validate(...a),
        async execute(...a) { const value = await native.execute(...a); result.observations.push({ tool: a[0], args: a[1], value }); return value; },
        async verify(...a) { const valid = await native.verify(...a); result.observations.push({ tool: 'citation_recheck', path: a[0].path, valid }); return valid; } };
      store = new ContactStore({ directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }), initialize: true, assistance: true });
      const owner = store.addDevice('Fixture owner').id;
      store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1');
      function seed(text, proposals = []) {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim();
        const checkpoint = new ConversationAssistant({}, sources).checkpoint();
        checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: '기록을 남겼어요.' }];
        store.finish(seq, { text: '기록을 남겼어요.', sources: [] }, checkpoint, proposals);
        result.fixture.history.push({ seq, text });
      }
      function work(title, details, state = 'open', waiting_for = null) {
        const text = `${title}: ${details} 이 일을 기억해줘. 알림은 예약하지 마.`;
        const p = { id: randomUUID(), timezone: 'Asia/Seoul', spec: { operation_id: randomUUID(), target: null, expected_version: 0,
          title, details, state, waiting_for, notify_at: null, user_quote: text } };
        seed(text, [p]); return store.confirmFollowup(owner, p.id, 'approve');
      }
      if (f.case === 'A13') seed(`${f.name} 미팅에서는 추측으로 결론 내리지 말고 실험 하나를 정하고 싶어. ${f.variant === 1 ? '나는 대규모 재설계보다 빠르게 검증하는 작은 변경을 선호해.' : '지난번 가격 인하 제안은 철회했어. 할인은 이번에 검토하지 말아줘.'} 관련 자료는 연결된 문서 폴더에 있어.`);
      else {
        seed(f.variant === 1 ? '이번 주 업무 우선순위는 고객 약속을 내부 정리보다 먼저야. 마감이 같은 일이라면 고객이 기다리는 일을 먼저 정리해줘.' : '이번 주에는 두 고객 세라와 나래의 우선순위를 아직 못 정했어. 두 요청은 같은 기한이고 둘 다 이번 주에 해낼 시간은 없어. 어느 쪽을 먼저 할지는 내가 결정할게.');
        work(`${f.name} 검수 승인`, `${f.today} 17시까지 승인 여부 확인. 승인 뒤 공지 작성.`, 'waiting', '검수 담당자 승인');
        work(`${f.name} 디자인 인수`, '디자인 자료 전달 완료 여부 확인.', 'waiting', '고객 수령 확인');
        work(`${f.name} 최종 공지`, `${f.sunday} 18시까지 작성. 검수 승인 뒤에만 확정.`);
        if (f.variant === 2) {
          work('세라 요청', `${f.sunday} 16시까지 고객 요청 처리. 나래 요청과 시간이 겹쳐 둘 중 하나 선택 필요.`);
          work('나래 요청', `${f.sunday} 16시까지 고객 요청 처리. 세라 요청과 시간이 겹쳐 둘 중 하나 선택 필요.`);
        }
        work('내부 자료 정리', `${f.sunday} 18시까지 정리. 고객 작업보다 후순위.`);
        work('다음 주 정기 보고', `${day(now + 7 * 86400000)}까지 작성.`);
        work('다음 주 발표 준비', `${day(now + 8 * 86400000)}까지 준비.`);
        work('다음 주 파일 분류', `${day(now + 9 * 86400000)}까지 정리.`);
      }
      // Earlier context is genuinely outside the short checkpoint, but remains
      // in the same journal for the product's normal history retrieval tools.
      seed('오늘도 한국어로 이야기해줘.');
      store.saveGoogleCredential(owner, { version: 1, epoch: randomUUID(), device: owner, scopes: [...GOOGLE_SCOPES], refresh_token: 'SYNTHETIC_REFRESH_ONLY', email: 'owner@example.test', connected_at: now, last_checked: null, last_error: null, reconnect_required: false }, null);
      const mail = (id, labels, age, subject, body, threadId = id, snippet = body.slice(0, 110)) => ({ id, threadId, ...(labels.length ? { labelIds: labels } : {}), internalDate: String(now - age), snippet,
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: labels.includes('SENT') ? '사용자 <owner@example.test>' : '동료 <colleague@example.test>' }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(now - age).toUTCString() }], body: { data: Buffer.from(body).toString('base64url') } } });
      const event = (id, summary, date, time, description) => ({ id, summary, description, start: { dateTime: date + 'T' + time + ':00+09:00' }, end: { dateTime: date + 'T' + String(Number(time.slice(0, 2)) + 1).padStart(2, '0') + time.slice(2) + ':00+09:00' } });
      let mails, events;
      if (f.case === 'A13') {
        mails = [mail('agenda', ['INBOX'], 3600000, `${f.name} 미팅 안건 안내`, f.variant === 1 ? '내일 미팅에서 가입 이탈 개선 실험을 하나 선택합니다. 선아가 10분 동안 현황을 공유합니다. 실험은 다음 주 월요일 착수합니다. 현황과 후보는 연결된 회의 문서를 참고하세요.' : '내일 미팅 시간은 오후 2시로 변경했습니다. 가격 인하는 제외합니다. 문서에 있는 두 안 중 배송 안내 개선부터 논의합니다. 현우가 검토 결과를 15분 공유합니다. 성공 지표는 문의 건수 감소입니다.', 'meeting', '내일 미팅의 확정 안건과 준비사항입니다. 아래 세부 내용을 확인해 주세요.'),
          mail('request', [], 40 * 86400000, `${f.name} 미팅 장비`, '참석 인원과 노트북 수를 회신해 주세요.', 'equipment'),
          mail('reply', ['SENT'], 2 * 86400000, `Re: ${f.name} 미팅 장비`, '참석 인원 12명, 노트북 3대입니다.', 'equipment'),
          mail('receipt', [], 2 * 3600000, `Re: ${f.name} 미팅 장비`, '12명과 노트북 3대로 준비 확정했습니다. 장비 관련 추가 준비는 없습니다.', 'equipment')];
        events = [event('meeting', `${f.name} 미팅`, f.tomorrow, f.variant === 1 ? '10:00' : '14:00', '현재 안건에 맞춰 실험 하나와 성공 지표를 결정합니다. 관련 메일과 문서가 있습니다.'), event('distractor', `${f.name} 후속 점검`, day(now + 4 * 86400000), '16:00', '실험 착수 뒤 점검')];
      } else {
        mails = [mail('design_sent', ['SENT'], 2 * 86400000, `${f.name} 디자인 인수`, '디자인 파일을 전달했습니다.', 'design'),
          mail('design_receipt', [], 3600000, `Re: ${f.name} 디자인 인수`, '디자인 파일을 받았고 인수 완료했습니다. 추가 수정은 없습니다.', 'design'),
          mail('review_sent', ['SENT'], 86400000, `${f.name} 검수 승인`, '검수 자료를 전달했습니다. 승인 결과를 기다립니다.', 'review')];
        if (f.variant === 2) mails.push(mail('new_design', ['INBOX'], 1800000, `Re: ${f.name} 디자인 인수`, `앞선 인수 완료와 별개로 새 요청입니다. 앱 아이콘의 배경색을 변경해 주세요. 기한은 ${f.tomorrow} 12시이며 원래 인수 작업을 다시 할 필요는 없습니다.`, 'design', '기존 작업과 별도의 추가 요청 및 새 기한을 안내합니다.'));
        events = [event('approval', `${f.name} 검수 결과 확인`, f.today, '17:00', '결과 확인 후 최종 공지 진행'), event('nextweek', '다음 주 보고', day(now + 7 * 86400000), '10:00', '주간 보고')];
      }
      if (f.case === 'A14') for (const message of mails) {
        if (!message.labelIds?.includes('SENT')) message.payload.headers[0].value = '고객 <customer@example.test>';
      }
      result.fixture.emails = mails; result.fixture.events = events;
      const fetchImpl = async (input, init) => {
        init.signal?.throwIfAborted(); const url = new URL(input); let value;
        result.observations.push({ path: url.pathname, query: url.searchParams.get('q'), format: url.searchParams.get('format') });
        if (url.pathname.endsWith('/token')) value = { access_token: 'SYNTHETIC_ACCESS_ONLY', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') };
        else if (url.pathname.endsWith('/messages')) {
          const q = url.searchParams.get('q') ?? '', terms = [...q.matchAll(/"([^"]+)"/gu)].map(m => m[1].toLowerCase());
          const selected = mails.filter(m => q.startsWith('in:inbox') ? m.labelIds?.includes('INBOX') : q.startsWith('in:sent') ? m.labelIds?.includes('SENT') : terms.every(t => (m.payload.headers.map(h => h.value).join(' ') + Buffer.from(m.payload.body.data, 'base64url')).toLowerCase().includes(t)));
          value = { messages: selected.toSorted((a, b) => Number(b.internalDate) - Number(a.internalDate)).map(m => ({ id: m.id, threadId: m.threadId })) };
        } else if (url.pathname.includes('/messages/')) value = mails.find(m => m.id === url.pathname.split('/').at(-1));
        else if (url.pathname.includes('/threads/')) { const id = url.pathname.split('/').at(-1); value = { id, messages: mails.filter(m => m.threadId === id) }; }
        else if (url.pathname.endsWith('/events')) value = { items: events.filter(e => Date.parse(e.end.dateTime) > Date.parse(url.searchParams.get('timeMin')) && Date.parse(e.start.dateTime) < Date.parse(url.searchParams.get('timeMax'))) };
        else throw Error('UNEXPECTED_FIXTURE_REQUEST');
        if (!value) throw Error('UNEXPECTED_FIXTURE_REQUEST'); return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
      };
      const connection = new GoogleConnection({ store, clientId: '123456789012-fixture.apps.googleusercontent.com', openBrowser: async () => true, fetchImpl });
      connection.configureRelatedMail(owner, true, 'related_mail_readonly_v1');
      const metered = { get identity() { return provider.identity; }, async chat(messages, tools, signal) {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, case: f.case, variant: f.variant, state: 'reserved' };
        report.model_requests.push(attempt); const call = { number: attempt.number, messages: structuredClone(messages) }; result.calls.push(call); persist();
        try { const response = await provider.chat(messages, tools, signal); attempt.state = 'observed'; call.response = response.message; persist(); return response; }
        catch (error) { attempt.state = 'unknown'; persist(); throw error; }
      } };
      if (typeof provider.contextBytes === 'function') metered.contextBytes = (...args) => provider.contextBytes(...args);
      if (provider.contextLimitBytes !== undefined) metered.contextLimitBytes = provider.contextLimitBytes;
      service = new ContactService(store, metered, sources, { timezone: 'Asia/Seoul' }); service.attachGoogle(connection);
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews };
      if (result.execution_profile.provider !== runtime.provider || service.localReviews !== (runtime.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      const allWork = () => { let offset = 0, items = []; do { const page = store.followupPage('all', offset); items.push(...page.items); offset = page.next_offset; } while (offset !== null); return items; };
      result.work_before = allWork();
      const { seq } = service.submit(owner, randomUUID(), f.ask); await service.idle();
      const turn = store.turn(seq); result.turn = { state: turn.state, error: turn.error, answer: turn.answer }; result.work_after = allWork(); result.usage = store.usage();
      const calls = result.calls.flatMap(c => c.response?.tool_calls ?? []);
      result.necessary_checks = { answered: turn.state === 'answered', unchanged_work: JSON.stringify(result.work_before) === JSON.stringify(result.work_after), no_pending_proposals: store.followupPage('all', 0).pending.length === 0,
        ...(f.case === 'A13' ? { history_retrieved: calls.some(c => ['search_history', 'read_history'].includes(c.function.name)) } : {}), calendar_read: calls.some(c => c.function.name === 'list_upcoming_events'),
        ...(f.case === 'A13' ? { current_document_read: result.observations.some(o => o.tool === 'read_file' && o.args.path === target), agenda_body_read: result.observations.some(o => o.path?.endsWith('/messages/agenda') && o.format === 'full') } : { work_collected: calls.some(c => c.function.name === 'list_followups'), work_paged: calls.some(c => c.function.name === 'list_followups' && c.function.arguments.offset > 0), receipt_observed: result.observations.some(o => o.path?.endsWith('/messages/design_receipt') || o.path?.endsWith('/threads/design')) }),
        sources_rechecked: turn.answer?.verification === 'cited_sources_rechecked' };
      result.diagnostics = { history_retrieved: calls.some(c => ['search_history', 'read_history'].includes(c.function.name)) };
      result.status = Object.values(result.necessary_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = error.message; }
    finally { await service?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); persist(); }
    console.log(JSON.stringify({ case: f.case, variant: f.variant, status: result.status, checks: result.necessary_checks, error: result.error }));
  }
  report.finished_at = new Date().toISOString(); persist(); return report;
}
