// Import-only fixed environments. No account access until explicitly called.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'provider_state' ? undefined : item));
const sources = { definitions: [], validate: () => false, verify: async () => false };
export const documentRevisionFixtures = () => [
  { variant: 1, title: '오로라 워크숍 진행 안내', ask: '아까 것, 너무 복잡해. 좀 고쳐봐.',
    feedback: '진행자가 바로 볼 수 있게 할 일과 시간 중심으로 줄여줘. 참가 조건은 빠뜨리지 말고.',
    original: '# 오로라 워크숍 진행 안내\n\n## 목적과 배경\n서로의 의견을 듣고 다음 할 일을 정하는 모임입니다. 진행자는 다양한 의견을 기록하고 다음 행동을 정리하는 역할을 합니다.\n\n## 개요\n| 구분 | 내용 |\n|---|---|\n| 시작 | 오후 2시 |\n| 장소 | 2층 회의실 |\n| 인원 | 8명 예정 |\n\n## 참가 조건\n휠체어 접근과 자막을 유지합니다.\n\n## 준비 사항\n좌석과 장비를 확인합니다. 자막을 준비합니다. 다과를 주문합니다.\n\n## 진행 세부 사항\n진행자는 안건을 소개합니다. 참석자의 의견을 듣고 기록합니다. 의견을 기록할 때에는 다음 할 일에 연결할 수 있도록 기록하는 것이 필요합니다.\n\n## 마무리 및 사후 정리\n담당자와 다음 할 일을 확인합니다. 다음 할 일과 담당자가 무엇인지 다시 확인하는 것이 마무리입니다.',
    edited: '# 오로라 워크숍 진행 안내\n\n## 목적과 배경\n서로의 의견을 듣고 다음 할 일을 정하는 모임입니다. 진행자는 다양한 의견을 기록하고 다음 행동을 정리하는 역할을 합니다.\n\n## 개요\n| 구분 | 내용 |\n|---|---|\n| 시작 | 오후 3시 |\n| 장소 | 1층 회의실 |\n| 인원 | 8명 확정 |\n\n## 참가 조건\n휠체어 접근과 자막을 유지합니다.\n\n## 준비 사항\n좌석과 장비를 확인합니다. 자막을 준비합니다.\n\n## 진행 세부 사항\n진행자는 안건을 소개합니다. 참석자의 의견을 듣고 기록합니다. 의견을 기록할 때에는 다음 할 일에 연결할 수 있도록 기록하는 것이 필요합니다.\n\n## 마무리 및 사후 정리\n담당자와 다음 할 일을 확인합니다. 다음 할 일과 담당자가 무엇인지 다시 확인하는 것이 마무리입니다.' },
  { variant: 2, title: '장비 인수 체크리스트', ask: '전에 만든 거, 설명이 여기저기 흩어져 있어서 따라가기 어렵네. 필요한 건 남기고 바로 쓸 수 있게 다듬어줘.',
    feedback: '신입 담당자가 순서대로 따라갈 수 있게 정리해줘. 예외 상황도 놓치면 안 돼.',
    original: '# 장비 인수 체크리스트\n\n## 기본 정보\n담당자는 민수이고 인수는 금요일 16시까지입니다. 이 안내는 신입 담당자가 장비를 빠짐없이 받도록 돕기 위한 문서입니다.\n\n## 준비\n주문 내역과 인수 목록을 준비합니다. 인수 목록은 받을 장비를 확인하는 데 사용합니다. 개인 전화번호를 수집합니다.\n\n## 수령\n포장을 개봉합니다. 개봉 후 사진을 남깁니다. 수량을 대조합니다. 인수 확인을 합니다. 인수 확인 후 일련번호를 대조합니다.\n\n## 예외 처리\n불일치가 있어도 우선 인수하고 담당자에게 문의합니다. 파손이 있으면 별도로 기록합니다.\n\n## 마무리\n일련번호와 수량을 인수 목록에 기록합니다. 담당자는 장비별 기록이 빠지지 않았는지 확인합니다. 기록을 남기는 것은 추후 장비 확인을 위한 절차입니다.',
    edited: '# 장비 인수 체크리스트\n\n## 기본 정보\n담당자는 지연이고 인수는 목요일 16시까지입니다. 이 안내는 신입 담당자가 장비를 빠짐없이 받도록 돕기 위한 문서입니다.\n\n## 준비\n주문 내역과 인수 목록을 준비합니다. 인수 목록은 받을 장비를 확인하는 데 사용합니다.\n\n## 수령\n개봉 전에 사진을 남깁니다. 포장을 개봉합니다. 수량을 대조합니다. 인수 확인 전에 일련번호를 대조합니다.\n\n## 예외 처리\n불일치가 있으면 인수를 중단하고 담당자에게 문의합니다. 파손이 있으면 별도로 기록합니다.\n\n## 마무리\n수량과 일련번호에 문제가 없으면 인수를 확인합니다. 일련번호와 수량을 인수 목록에 기록합니다. 담당자는 장비별 기록이 빠지지 않았는지 확인합니다. 기록을 남기는 것은 추후 장비 확인을 위한 절차입니다.' },
];
export async function runDocumentRevision({ provider, reportPath, implementation, requestLimit = 32 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const inspected = await provider.inspect(AbortSignal.timeout(20000)), fixtures = documentRevisionFixtures();
  const report = { kind: 'owner_document_revision_candidate', implementation, runtime: Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider','model','model_digest','billing','display_name'].includes(key))),
    harness_sha256: sha(readFileSync(new URL(import.meta.url))), fixtures_sha256: sha(JSON.stringify(fixtures)), started_at: new Date().toISOString(), fixed_cases: ['A04'], variants_per_case: 2,
    synthetic_data_only: true, production_scope_changed: false, physical_devices: false, product_acceptance: 'not_passed', independent_semantic_review: 'required', request_limit: requestLimit, model_requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(plain(report), null, 2) + '\n', { mode: 0o600 });
  for (const fixture of fixtures) {
    const root = mkdtempSync(join(tmpdir(), 'tada-document-revision-')); let store, service, host;
    const result = { case: 'A04', variant: fixture.variant, utterance: fixture.ask, fixture: { ...fixture, history: [] }, calls: [] }; report.results.push(result); save();
    try {
      store = new ContactStore({ directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }), initialize: true, assistance: true });
      const owner = store.addDevice('Synthetic owner').id; store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1');
      const seed = (text, answer, document = false) => {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim();
        const spec = document ? store.prepareDocument(seq, { title: fixture.title, format: 'markdown', based_on: null }) : null;
        const checkpoint = new ConversationAssistant({}, sources).checkpoint(); checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: answer }];
        store.finish(seq, { text: answer, sources: [], verification: 'not_applicable' }, checkpoint, [], spec); result.fixture.history.push({ seq, text, answer }); return seq;
      };
      const other = seed('같은 제목으로 보관할 지난달 행사 자료야. 이건 완료됐고 더 수정하지 않을 거야.', '# 지난달 완료 기록\n이미 끝난 다른 행사이며 후속 수정 대상이 아닙니다.', true);
      const first = seed(fixture.title + '를 만들어줘.', fixture.original, true);
      const feedback = seed(fixture.feedback, '이 문서는 그 기준으로 다듬겠습니다.');
      // Use the owner-edit path. Never place the latest edited body in the checkpoint.
      const beforeEdit = store.checkpoint();
      const edited = store.editDocument(owner, { request_id: randomUUID(), based_on: first, title: fixture.title, content: fixture.edited }).document;
      result.fixture.original_document = store.document(first); result.fixture.other_document = store.document(other); result.fixture.edited_document = edited;
      result.fixture.feedback_id = feedback; result.fixture.active_context = store.checkpoint(); result.fixture.edit_preserved_checkpoint = JSON.stringify(beforeEdit) === JSON.stringify(store.checkpoint());
      const record = (operation, input) => {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, variant: fixture.variant, operation, state: 'reserved' }; report.model_requests.push(attempt);
        const call = { number: attempt.number, operation, ...plain(input) }; result.calls.push(call); save(); return { attempt, call };
      };
      const invoke = async (operation, input, run) => {
        const { attempt, call } = record(operation, input);
        try { const value = await run(); attempt.state = 'observed'; call.response = plain(operation === 'chat' ? value.message : value); save(); return value; }
        catch (error) { const usage = error?.observedUsage, known = [usage?.input_tokens, usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0);
          attempt.state = known ? 'observed_failure' : 'unknown'; if (known) call.observed_usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
          call.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_PROVIDER_FAILED'; save(); throw error; }
      };
      const model = { identity: provider.identity, chat: (messages, tools, signal, beforeDispatch) => invoke('chat', { messages, tool_names: tools.map(t => t.function.name) }, () => provider.chat(messages, tools, signal, beforeDispatch)) };
      if (typeof provider.researchPublicWeb === 'function') model.researchPublicWeb = (request, previous, signal, beforeDispatch) => invoke('public_web', { request, previous }, () => provider.researchPublicWeb(request, previous, signal, beforeDispatch));
      if (typeof provider.contextBytes === 'function') model.contextBytes = (...args) => provider.contextBytes(...args);
      if (provider.contextLimitBytes !== undefined) model.contextLimitBytes = provider.contextLimitBytes;
      service = new ContactService(store, model, sources, { timezone: 'Asia/Seoul' });
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews, public_web: typeof model.researchPublicWeb === 'function' };
      if (result.execution_profile.provider !== inspected.provider || service.localReviews !== (inspected.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      const seq = service.submit(owner, randomUUID(), fixture.ask).seq; await service.idle(); const turn = store.turn(seq);
      result.turn = { seq, state: turn.state, error: turn.error, answer: turn.answer }; result.usage = store.usage(); result.saved_document = store.document(seq);
      const calls = result.calls.flatMap(item => item.response?.tool_calls ?? []);
      result.mechanical_checks = { answered: turn.state === 'answered', actual_edit_path: result.fixture.edit_preserved_checkpoint && edited.author === 'owner',
        latest_document_read: calls.some(item => item.function.name === 'read_document' && item.function.arguments.id === edited.id),
        same_lineage_new_version: result.saved_document?.root === first && result.saved_document?.based_on === edited.id && result.saved_document?.revision === 3,
        prior_versions_preserved: store.document(first).sha256 === sha(fixture.original) && store.document(edited.id).sha256 === sha(fixture.edited),
        unrelated_document_preserved: JSON.stringify(store.document(other)) === JSON.stringify(result.fixture.other_document),
        no_public_research: report.model_requests.filter(item => item.variant === fixture.variant).every(item => item.operation === 'chat'), no_unknown_requests: result.usage.unknown_requests === 0 };
      if (result.saved_document) {
        const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
        const origin = `http://127.0.0.1:${port}`; host = await serveContact({ store, service, origin, port });
        const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
        const paired = await fetch(origin + '/api/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Fixture download' }) });
        if (!paired.ok) throw Error('EVAL_PAIR_FAILED');
        const downloaded = await fetch(origin + `/api/documents/${seq}`, { headers: { Cookie: paired.headers.get('set-cookie').split(';')[0] } });
        const body = await downloaded.text(); result.download = { status: downloaded.status, body, sha256: sha(body), claimed_sha256: downloaded.headers.get('x-content-sha256') };
        result.mechanical_checks.download_verified = downloaded.ok && body.startsWith(result.saved_document.content) && sha(body) === result.download.claimed_sha256;
      } else result.mechanical_checks.download_verified = false;
      result.status = Object.values(result.mechanical_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_FAILED'; }
    finally { await host?.close(); await service?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); save(); }
    console.log(JSON.stringify({ variant: result.variant, status: result.status, error: result.error, checks: result.mechanical_checks }));
  }
  report.finished_at = new Date().toISOString(); save(); return report;
}
