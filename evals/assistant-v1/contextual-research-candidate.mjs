// Import-only evaluator. The caller owns the selected authorized provider/profile.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'provider_state' ? undefined : item));
// Both actions inspect page content. A search result or citation alone does not.
// Relevance and support for decisive claims still require independent review.
export function hasPageInspection(observations) {
  return Array.isArray(observations) && observations.some(item => {
    if (!['open_page', 'find_in_page'].includes(item?.type) || typeof item.url !== 'string') return false;
    try { return ['https:', 'http:'].includes(new URL(item.url).protocol); } catch { return false; }
  });
}
export function contextualResearchFixtures() {
  return [
    { variant: 1, company: 'Microsoft', other: 'Costco', ask: '그 회사 투자할 만한지 알아봐.',
      choice: '다음에 투자할 만한지 알아볼 회사는 Microsoft야. 이전 Costco 검토는 일단 끝냈어. 장기 관점에서 이익과 현금흐름, AI 투자 부담, 현재 가격에 반영된 기대가 중요해. 연결된 문서 폴더에 이전 분석도 보관해 뒀어. 그 분석의 전제가 지금도 맞는지 공개 자료로 대조해서 판단하고 싶어. 거래나 계좌 조회는 하지 마.' },
    { variant: 2, company: 'Costco', other: 'Microsoft', ask: '전에 검토하기로 한 회사, 지금 투자할 가치가 있는지 근거를 찾아 판단해줘.',
      choice: '이번에 투자 검토 대상으로 정한 회사는 Costco야. Microsoft에 관한 검토는 종료했어. 회원제 사업의 지속성과 수익성, 가격 부담을 중심으로 판단하고 싶어. 좋은 회사여도 비싸면 기다릴 수 있어. 예전 분석은 연결된 문서 폴더에 보관해 뒀으니 지금 공개 자료와 비교해 줘. 거래나 외부 연락은 하지 마.' },
  ];
}
export async function runContextualResearch({ repo, provider, reportPath, implementation, broker = join(repo, `target/debug/tada-read-broker${process.platform === 'win32' ? '.exe' : ''}`), requestLimit = 32 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const load = path => import(pathToFileURL(join(repo, path)).href);
  const { ContactStore, contactRoute } = await load('packages/engine/src/contact-store.mjs');
  const { ContactService } = await load('packages/engine/src/contact-service.mjs');
  const { ConversationAssistant } = await load('packages/engine/src/conversation.ts');
  const { NativeSources } = await load('packages/engine/src/native-sources.mjs');
  const archivePath = join(repo, 'evals/assistant-v1/results/2026-10-09-public-research.json');
  const archiveBytes = readFileSync(archivePath), archive = JSON.parse(archiveBytes);
  if (sha(archiveBytes) !== '70a12d3c8d64acddbd2cd04156c832b17a1eec9c0041832bddd0db15ad7d1709') throw Error('EVAL_ARCHIVE_CHANGED');
  const inspected = await provider.inspect(AbortSignal.timeout(20000));
  if (typeof provider.researchPublicWeb !== 'function') throw Error('EVAL_WEB_PROVIDER_REQUIRED');
  const runtime = Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider', 'model', 'model_digest', 'runtime_version', 'billing', 'display_name'].includes(key)));
  const fixtures = contextualResearchFixtures();
  const report = { kind: 'contextual_public_research_acceptance', implementation, runtime, harness_sha256: sha(readFileSync(new URL(import.meta.url))),
    archive_sha256: sha(archiveBytes), fixtures_sha256: sha(JSON.stringify(fixtures)), started_at: new Date().toISOString(), fixed_cases: ['A01'], variants_per_case: 2,
    synthetic_owner_history: true, real_archived_public_reports: true, production_scope_changed: false, physical_devices: false,
    product_acceptance: 'not_passed', independent_semantic_review: 'required', request_limit: requestLimit, model_requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(plain(report), null, 2) + '\n', { mode: 0o600 });
  for (const fixture of fixtures) {
    const root = mkdtempSync(join(tmpdir(), 'tada-contextual-research-')); let store, service;
    const result = { case: 'A01', variant: fixture.variant, company: fixture.company, utterance: fixture.ask, fixture: { history: [], files: [] }, calls: [], observations: [], status: 'needs_semantic_review' };
    report.results.push(result); save();
    try {
      const folder = join(root, 'documents'); mkdirSync(folder);
      const target = `${fixture.variant === 1 ? '분석' : '검토기록'}/${fixture.company}-${randomBytes(4).toString('hex')}.md`;
      for (const company of [fixture.company, fixture.other]) {
        const turn = archive.results.find(item => item.company === company)?.turns[0];
        if (turn?.state !== 'answered' || !turn.answer?.text) throw Error('EVAL_ARCHIVE_INVALID');
        const name = company === fixture.company ? target : `보관/${company}-검토.md`;
        const content = `# ${company} 이전 분석 보관본\n원본 작성: ${new Date(turn.created).toISOString()}\n원문 SHA256: ${sha(turn.answer.text)}\n보관 당시 분석이며 현재 외부 사실을 새로 확인한 기록은 아닙니다. 본문 S 표기는 원 보고서의 표기입니다.\n\n${turn.answer.text}\n`;
        mkdirSync(dirname(join(folder, name)), { recursive: true }); writeFileSync(join(folder, name), content);
        result.fixture.files.push({ name, company, content, sha256: sha(content), original_created: turn.created, original_answer_sha256: sha(turn.answer.text) });
      }
      const unrelated = '# 라일락 행사 회고\n투자 검토와 무관한 지난 행사 기록. 장소 변경은 끝났고 추가 준비는 없음.\n';
      writeFileSync(join(folder, '라일락-행사.md'), unrelated); result.fixture.files.push({ name: '라일락-행사.md', content: unrelated, sha256: sha(unrelated) });
      const native = new NativeSources(broker, [folder]); await native.initialize();
      const sources = { definitions: native.definitions, validate: (...args) => native.validate(...args),
        async execute(...args) { const value = await native.execute(...args); result.observations.push({ tool: args[0], args: args[1], value }); return value; },
        async verify(...args) { const valid = await native.verify(...args); result.observations.push({ tool: 'citation_recheck', path: args[0].path, valid }); return valid; } };
      store = new ContactStore({ directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }), initialize: true, assistance: true });
      const owner = store.addDevice('Synthetic owner').id; store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1');
      const seed = text => {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim();
        const checkpoint = new ConversationAssistant({}, sources).checkpoint(); checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: '기록했습니다.' }];
        store.finish(seq, { text: '기록했습니다.', sources: [] }, checkpoint); result.fixture.history.push({ seq, created: store.turn(seq).created, text }); return seq;
      };
      seed(`예전에 투자 검토하던 회사는 ${fixture.other}였어. 그때 분석은 보관하고 이번 검토는 끝낼게.`);
      seed('라일락 행사 회고 자료는 정리된 것으로 둘게. 회사 투자 조사와는 별개야.');
      const chosen = seed(fixture.choice);
      for (const text of ['내일 점심은 밖에서 먹을 예정이야.', '메모해 둔 책 제목은 달의 지도였어.', '이번 주 운동은 수요일에 했어.', '출장은 아직 정하지 않았어.', '주말 일정은 나중에 이야기할게.']) seed(text);
      result.fixture.active_context = plain(store.checkpoint()); result.fixture.current_choice_id = chosen; result.fixture.target_file = target;
      const record = (operation, input) => {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, variant: fixture.variant, operation, state: 'reserved' }; report.model_requests.push(attempt);
        const call = { number: attempt.number, operation, ...plain(input) }; result.calls.push(call); save(); return { attempt, call };
      };
      const failed = (attempt, call, error) => {
        const usage = error?.observedUsage;
        const known = [usage?.input_tokens, usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0);
        attempt.state = known ? 'observed_failure' : 'unknown';
        if (known) call.observed_usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
        call.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_PROVIDER_FAILED';
        save();
      };
      const model = { identity: provider.identity, async chat(messages, tools, signal, beforeDispatch) {
        const { attempt, call } = record('chat', { messages, tool_names: tools.map(tool => tool.function.name) });
        try { const value = await provider.chat(messages, tools, signal, beforeDispatch); attempt.state = 'observed'; call.response = plain(value.message); save(); return value; }
        catch (error) { failed(attempt, call, error); throw error; }
      }, async researchPublicWeb(request, previous, signal, beforeDispatch) {
        const { attempt, call } = record('public_web', { request, previous });
        try { const value = await provider.researchPublicWeb(request, previous, signal, beforeDispatch); attempt.state = 'observed'; call.response = plain(value); save(); return value; }
        catch (error) { failed(attempt, call, error); throw error; }
      } };
      if (typeof provider.contextBytes === 'function') model.contextBytes = (...args) => provider.contextBytes(...args);
      if (provider.contextLimitBytes !== undefined) model.contextLimitBytes = provider.contextLimitBytes;
      service = new ContactService(store, model, sources, { timezone: 'Asia/Seoul' });
      result.execution_profile = { provider: service.providerStatus.provider, local_reviews: service.localReviews, public_web: true };
      if (result.execution_profile.provider !== runtime.provider || service.localReviews !== (runtime.provider === 'ollama-local')) throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
      const before = store.followupState(); const { seq } = service.submit(owner, randomUUID(), fixture.ask); await service.idle();
      const turn = store.turn(seq); result.turn = { seq, state: turn.state, error: turn.error, answer: turn.answer }; result.usage = store.usage();
      const calls = result.calls.flatMap(item => item.response?.tool_calls ?? []), web = result.calls.filter(item => item.operation === 'public_web');
      result.mechanical_checks = { answered: turn.state === 'answered', target_outside_recent_context: !JSON.stringify(result.fixture.active_context).includes(fixture.company),
        old_owner_read: calls.some(item => item.function.name === 'read_history' && item.function.arguments.id === chosen),
        owner_context_forwarded: web.length === 1 && web[0].previous?.messages?.some(item => item.id === chosen && item.selection === 'read_history' && item.text === fixture.choice) === true,
        previous_analysis_read: result.observations.some(item => item.tool === 'read_file' && item.args.path === target),
        public_pages_inspected: web.some(item => hasPageInspection(item.response?.report?.observations)),
        new_report_cited: turn.answer?.verification === 'provider_web_report_checked',
        unchanged_files: result.fixture.files.every(file => sha(readFileSync(join(folder, file.name))) === file.sha256),
        unchanged_work: JSON.stringify(before) === JSON.stringify(store.followupState()), unknown_requests: store.usage().unknown_requests === 0 };
      result.status = Object.values(result.mechanical_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_FAILED'; }
    finally { await service?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); save(); }
    console.log(JSON.stringify({ variant: result.variant, status: result.status, error: result.error, checks: result.mechanical_checks }));
  }
  report.finished_at = new Date().toISOString(); save(); return report;
}
