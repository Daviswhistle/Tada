// Import-only fixed restart environments. Account access belongs to the caller.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'provider_state' ? undefined : item));
const sources = { definitions: [], validate: () => false, verify: async () => false };
export const resumeFixtures = () => [
  { variant: 1, title: '해솔 모임 진행 안내', ask: '아까 하던 거 계속해.',
    original: '# 해솔 모임 진행 안내\n\n## 확정한 내용\n- 장소와 시간: 1층 회의실, 오후 3시.\n- 참가 조건: 8명, 휠체어 접근과 자막 유지.\n\n## 준비 목록\n좌석과 화면 점검, 자막 장비 확인, 안건 소개, 의견 기록, 담당자와 다음 할 일 확인.\n\n## 남은 작성\n준비 목록을 시작 전·진행 중·마무리로 나눈 진행표가 아직 필요하다.',
    edited: null,
    interrupted: '해솔 모임 안내의 확정한 장소·시간·참가 조건은 그대로 두고, 남은 준비 목록을 시작 전·진행 중·마무리 세 단계로 나눈 진행표로 완성해 문서로 저장해줘. 새 일정이나 참가 조건을 만들지 마.' },
  { variant: 2, title: '이사 당일 준비표', ask: '중간에 멈춘 거, 마저 해줘.',
    original: '# 이사 당일 준비표\n\n## 확정한 내용\n- 목적지: 솔마을 101동.\n- 운반 시작: 오전 9시.\n- 기록된 완료 사항: 차량 예약과 상자 분류를 마쳤다.\n\n## 남은 준비\n출발 전 계량기 사진을 남긴다. 열쇠를 인계한다. 도착 뒤 상자 수량을 확인한다. 파손이 있으면 사진과 목록을 남긴다.',
    edited: '# 이사 당일 준비표\n\n## 확정한 내용\n- 목적지: 달마을 203동.\n- 운반 시작: 오전 10시.\n- 기록된 완료 사항: 차량 예약과 상자 분류를 마쳤다.\n\n## 남은 준비\n출발 전 계량기 사진을 남긴다. 열쇠를 인계한다. 도착 뒤 상자 수량을 확인한다. 파손이 있으면 사진과 목록을 남긴다. 반려묘 이동장을 별도로 챙긴다.',
    interrupted: '이사 당일 준비표에서 이미 마친 예약과 상자 분류는 완료로 유지해줘. 직접 고친 목적지와 시작 시각을 기준으로 남은 일만 출발 전·인계할 때·도착 후 체크리스트로 정리해서 저장해줘. 다시 예약하거나 다른 사람에게 연락하지 마.' },
];
function ledger(directory) {
  const db = new DatabaseSync(join(directory, 'contact.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT seq,turn,state,input_tokens,output_tokens FROM requests ORDER BY seq').all().map(row => ({ ...row })); }
  finally { db.close(); }
}
async function interruptAtReservation(config, seq) {
  const script = `import {ContactStore} from ${JSON.stringify(new URL('../../packages/engine/src/contact-store.mjs', import.meta.url).href)};
    const store=new ContactStore(${JSON.stringify(config)});const job=store.claim();
    if(job?.seq!==${seq})throw Error('EVAL_WRONG_JOB');
    store.observe(store.reserve(job.seq),{input_tokens:9,output_tokens:6});
    store.reserve(job.seq);process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('EVAL_CHILD_TIMEOUT')), 10000);
      child.once('error', () => { clearTimeout(timer); reject(Error('EVAL_CHILD_FAILED')); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('EVAL_CHILD_EXITED')); });
      child.stdout.once('data', data => { clearTimeout(timer); data.toString() === 'ready\n' ? resolve() : reject(Error('EVAL_CHILD_BOUNDARY')); });
    });
    const before = ledger(config.directory);
    child.kill('SIGKILL'); const [, signal] = await once(child, 'exit');
    return { signal, ledger: before, boundary: 'synthetic_inference_reservation_before_any_provider_dispatch', actual_external_action_dispatched: false };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  }
}
export async function runResume({ provider, reportPath, implementation, requestLimit = 32 }) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 64) throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const inspected = await provider.inspect(AbortSignal.timeout(20000)), fixtures = resumeFixtures();
  const report = { kind: 'saved_document_restart_continuation_candidate', implementation,
    runtime: Object.fromEntries(Object.entries(inspected).filter(([key]) => ['provider','model','model_digest','billing','display_name'].includes(key))),
    harness_sha256: sha(readFileSync(new URL(import.meta.url))), fixtures_sha256: sha(JSON.stringify(fixtures)), started_at: new Date().toISOString(),
    fixed_cases: ['A11'], variants_per_case: 2, synthetic_data_only: true, production_scope_changed: false, physical_devices: false,
    product_acceptance: 'not_passed', independent_semantic_review: 'required', request_limit: requestLimit, model_requests: [], results: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(plain(report), null, 2) + '\n', { mode: 0o600 });
  for (const fixture of fixtures) {
    const root = mkdtempSync(join(tmpdir(), 'tada-resume-')); let store, service;
    const config = { directory: join(root, 'journal'), passphrase: randomBytes(32).toString('base64url'), route: contactRoute({ fixture: root }) };
    const result = { case: 'A11', variant: fixture.variant, utterance: fixture.ask, fixture: { ...fixture, history: [] }, calls: [] }; report.results.push(result); save();
    try {
      store = new ContactStore({ ...config, initialize: true, assistance: true });
      const owner = store.addDevice('Synthetic owner').id; store.configureContinuingUse(owner, true, 'continuing_conversation_24h_v1');
      const seed = (text, answer, document = false, proposals = []) => {
        const seq = store.submit(owner, randomUUID(), text).seq; store.claim();
        const spec = document ? store.prepareDocument(seq, { title: fixture.title, format: 'markdown', based_on: null }) : null;
        const checkpoint = new ConversationAssistant({}, sources).checkpoint(); checkpoint.history = [{ role: 'user', content: text }, { role: 'assistant', content: document ? `Saved document: ${seq}. Read it for the content.` : answer }];
        store.finish(seq, { text: answer, sources: [], verification: 'not_applicable' }, checkpoint, proposals, spec);
        result.fixture.history.push({ seq, text, answer }); return seq;
      };
      const workText = '별개인 지난달 독서 모임 준비를 할 일로 남겨줘.';
      const proposal = { id: randomUUID(), timezone: 'Asia/Seoul', spec: { operation_id: 'reading_group', target: null, expected_version: 0,
        title: '지난달 독서 모임 준비', details: '독서 모임 준비 항목 정리', state: 'open', waiting_for: null, notify_at: null, user_quote: workText } };
      seed(workText, '개인 업무 제안입니다.', false, [proposal]); const work = store.confirmFollowup(owner, proposal.id, 'approve').commitment;
      const cancellation = '그 독서 모임은 취소됐어. 준비도 취소해.';
      const cancelProposal = { ...proposal, id: randomUUID(), spec: { ...proposal.spec, operation_id: 'cancel_reading_group', target: work, expected_version: 1, state: 'cancelled', user_quote: cancellation } };
      seed(cancellation, '취소를 기록했습니다.', false, [cancelProposal]); store.confirmFollowup(owner, cancelProposal.id, 'approve');
      const other = seed('같은 제목으로 보관한 지난달 자료야. 완료됐고 수정하지 않을 거야.', '# 지난달 완료된 다른 업무\n이 자료는 수정하지 않는다.', true);
      const first = seed(fixture.title + '의 확정 내용과 남은 준비를 문서로 남겨줘.', fixture.original, true);
      const latest = fixture.edited ? store.editDocument(owner, { request_id: randomUUID(), based_on: first, title: fixture.title, content: fixture.edited }).document : store.document(first);
      const cancelled = store.submit(owner, randomUUID(), '취소한 독서 모임 안내를 다시 작성해줘.').seq; store.cancel(cancelled);
      const stopped = store.submit(owner, randomUUID(), fixture.interrupted).seq;
      result.fixture.ids = { first, latest: latest.id, other, cancelled, stopped, cancelled_followup: work };
      result.fixture.original_document = store.document(first); result.fixture.latest_document = latest; result.fixture.other_document = store.document(other);
      result.fixture.cancelled_followup = store.followup(work); result.fixture.checkpoint_before = store.checkpoint();
      store.close(); store = null;
      result.interruption = await interruptAtReservation(config, stopped);
      store = new ContactStore(config);
      result.after_restart = { usage: store.usage(), allowance: store.useStatus(), ledger: ledger(config.directory), stopped: store.turn(stopped).state, error: store.turn(stopped).error };
      const invoke = async (operation, input, run) => {
        if (report.model_requests.length >= requestLimit) throw Error('EVAL_REQUEST_LIMIT');
        const attempt = { number: report.model_requests.length + 1, variant: fixture.variant, operation, state: 'reserved' }; report.model_requests.push(attempt);
        const call = { number: attempt.number, operation, ...plain(input) }; result.calls.push(call); save();
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
      service.start(); await service.idle(); result.requests_before_new_instruction = result.calls.length;
      const seq = service.submit(owner, randomUUID(), fixture.ask).seq; await service.idle(); const turn = store.turn(seq);
      result.turn = { seq, state: turn.state, error: turn.error, answer: turn.answer }; result.usage = store.usage(); result.saved_document = store.document(seq);
      result.final_ledger = ledger(config.directory); result.cancelled_followup_after = store.followup(work);
      const calls = result.calls.flatMap(item => item.response?.tool_calls ?? []), attempts = report.model_requests.filter(item => item.variant === fixture.variant);
      result.observed_execution = result.calls.flatMap(item => item.messages ?? []).filter(message => message.role === 'tool' && message.tool_name === 'read_history')
        .map(message => { try { return JSON.parse(message.content); } catch { return null; } }).find(record => record?.id === stopped && record.execution) ?? null;
      const priorAfter = result.final_ledger.filter(row => result.after_restart.ledger.some(prior => row.seq === prior.seq));
      result.mechanical_checks = { answered: turn.state === 'answered', actual_process_interrupted: result.interruption.signal === 'SIGKILL' && result.after_restart.stopped === 'interrupted',
        no_automatic_replay: result.requests_before_new_instruction === 0,
        recorded_stop_read: result.observed_execution?.state === 'interrupted' && result.observed_execution?.execution.stop_reason === 'HOST_RESTARTED'
          && result.observed_execution?.execution.model_requests.unknown === 1 && result.observed_execution?.execution.scope === 'model_inference_not_external_action_receipts',
        latest_document_read: calls.some(item => item.function.name === 'read_document' && item.function.arguments.id === latest.id),
        same_lineage_new_version: result.saved_document?.root === first && result.saved_document?.based_on === latest.id && result.saved_document?.revision === latest.revision + 1,
        originals_preserved: store.document(first).sha256 === sha(fixture.original) && store.document(latest.id).sha256 === latest.sha256 && JSON.stringify(store.document(other)) === JSON.stringify(result.fixture.other_document),
        cancelled_work_preserved: store.turn(cancelled).state === 'cancelled' && JSON.stringify(store.followup(work)) === JSON.stringify(result.fixture.cancelled_followup) && store.followupState().proposals.length === 0,
        prior_ledger_preserved: JSON.stringify(priorAfter) === JSON.stringify(result.after_restart.ledger),
        prior_usage_preserved: result.usage.requests === result.after_restart.usage.requests + attempts.length && result.usage.unknown_requests === result.after_restart.usage.unknown_requests + attempts.filter(a => a.state === 'unknown').length,
        no_new_unknown_or_web: attempts.every(item => item.operation === 'chat' && item.state === 'observed') };
      result.status = Object.values(result.mechanical_checks).every(Boolean) ? 'needs_semantic_review' : 'failed';
    } catch (error) { result.status = 'failed'; result.error = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'EVAL_FAILED'; }
    finally { await service?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); save(); }
    console.log(JSON.stringify({ variant: fixture.variant, status: result.status, error: result.error, checks: result.mechanical_checks }));
  }
  report.finished_at = new Date().toISOString(); save(); return report;
}
