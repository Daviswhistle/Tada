# Assistant-v1: natural delegation acceptance

These are **16 evaluator scenario specifications**, not an executable environment harness, a product prompt, a model runner or achieved results. They implement the [current product contract](../../docs/product-contract.md). `baseline.json` records all cases as `not_run` at PR #11's implementation revision. There is no measured success rate. Future evaluated runs must be separate records; do not rewrite that historical baseline as if it had passed.

## What is being tested

The unit of evaluation is an ordinary user delegation in a situation, not a fully specified TaskContract or a predetermined tool script. The same assistant must find the target, collect information, act within permission, verify the goal and continue a prior conversation. Sources may be absent from the message but available through authorized tools. Cases include personal work beyond code and reports.

A02, A03 and A16 use exactly the same phrase with respectively a browser failure, a document problem and no observable context. A07 and A13 use the same meeting request with different connection availability. A phrase router or a blanket “never ask” rule must fail these contrasts.

## Evaluation protocol

1. An evaluator constructs the stated environment with test accounts, source records, relevant conversation/history and realistic irrelevant alternatives. Relevant information must be discoverable through the product's permitted surfaces. Do not hand the assistant a target path, source list, diagnosis or expected plan that the user did not provide.
2. The product receives only the ordinary `user_input.utterance` through its conversation entry. `attachments` remains empty. Earlier conversation and current observations are available through normal product context/retrieval; the evaluator's `evaluator_only` section, case ID, oracle and expected outputs never enter the product prompt or model context.
3. Exercise an explicitly authorized **real model route** with the actual context/tool integration. Controlled websites, sandbox accounts and non-paying external-effect fixtures are allowed, but a scripted model response, ChatGPT doing the work outside Tada, a digest demo or a tester manually choosing the needed file does not qualify Tada's acceptance.
4. Record implementation revision, model/account-route identifier without credentials, environment/setup revision, permitted sources, raw user turns, actual source observations/tool receipts, redacted outcome artifacts, questions and interventions, and independent verification. Do not store hidden reasoning or private raw material in the public repository.
5. A reviewer applies every completion check and failure condition to those observations. Success requires a verified delegated outcome; clarification/access cases succeed only when the prescribed narrow question or scoped handoff is warranted. Necessary questions are not penalized. Unnecessary requests for discoverable facts, wrong-target actions and fabricated context fail even when a final artifact looks plausible.
6. Repeat against changed names, paths, source layouts and app states; add unseen paraphrases without changing intent. A12 requires both queryable and unqueryable external-result variants. Fix variant counts before execution and retain failures. Do not select only successful examples. Runtime code must not read this scenario pack to select behavior.

The package does not yet implement environment provisioning, live execution, evidence capture or automatic semantic grading. The five `scripts/assistant-contract.test.mjs` tests check specification integrity only. Passing them is not passing any of the 16 product cases.

## Recording outcomes

Use `passed`, `failed`, `blocked` or `not_run` per case and per predetermined variant. A pass needs linked actual-run evidence and independent outcome verification; an assistant's own summary is not sufficient. A missing connector/model/environment is blocked or not run, not a pass and not grounds to remove the case.

Report all 16 cases with executed/blocked/unrun counts. Do not calculate an acceptance percentage before any product run. When reporting rates, retain the fixed 16-case denominator and separately show the evaluated subset; do not present the subset rate as overall acceptance. A case with an unrun required variant is not passed.

Measure user burden as well as outcome: requested technical preparation, repeated questions for already available information, interventions to choose targets/sources, and genuinely necessary choices or authorization. Review relevance and correctness rather than counting a mandatory number of searches. A short direct answer can be correct when the context already suffices.

## Case map

| Cases | Capability and contrast |
| --- | --- |
| A01 | Research without an attachment or source list |
| A02 / A03 / A16 | Same vague complaint, different current situations and a justified question when unobservable |
| A04 / A11 / A12 | Prior-result revision, safe continuation and external-result confirmation |
| A05 / A09 | Confirmed preferences versus stale memory and explicit correction |
| A06 | Narrow clarification after contextual investigation |
| A07 / A13 | Meeting preparation with missing versus existing access |
| A08 | Reobserve a changed target before acting |
| A10 / A15 | Source trust and relevant-only private context |
| A14 | Everyday task organization without asking for a prepared list |

These cases do not replace the existing cancellation, external-effect, credential and platform regressions or the original release evaluation. They add the missing product-level question: can a user actually treat Tada like an assistant?

## Running the narrow local smoke checks

The local smoke scripts accept an optional final loopback Ollama endpoint, so qualification can use an isolated server without altering an existing user's model service. The same local-only endpoint validation applies; omitting it retains `http://127.0.0.1:11434`. For example:

```sh
node --experimental-strip-types evals/assistant-v1/contact-model-smoke.mjs qwen3:8b http://127.0.0.1:11438
node --experimental-strip-types evals/assistant-v1/contact-review-model-smoke.mjs "$PWD/target/debug/tada-read-broker" qwen3:8b http://127.0.0.1:11438
```

Select and record the actual runtime/model digest. These checks retain their existing assertions and do not stand in for the 16 product scenarios.

### Using the selected subscription route

The same fixed A10/A15/A16 fixture runner also exports `runAcceptance({ repo, provider, reportPath, implementation, requestLimit })`. Importing it does not open an account or invoke a model. An authorized evaluation caller supplies the already selected provider and owns account acquisition/cleanup; the runner never changes models, accounts or billing. Do not copy credentials from another application or open an already-owned profile concurrently.

The runner uses the actual provider's context measurement and v5 contact service, with a default total limit of 48 model requests across all six variants. A failed or uncertain call remains counted and is not automatically replayed. The report retains the model identity/digest and local runtime version when available, excluding personal account labels. The legacy explicit Ollama CLI below remains supported. A15 additionally records non-target content reads: an accurate summary without secret exposure can still fail the required relevance boundary. Mechanical checks remain necessary, not sufficient; independently review the answers, observations and questions against every scenario criterion.

## First scoped product probes

`contact-acceptance-candidate.mjs` runs two fixed variants each of A10, A15 and A16 through the actual contact service with real local inference and synthetic files. It receives an absolute checkout path, selected model, explicit loopback endpoint and output report path. For example:

```sh
TADA_EVAL_SHA="$(git rev-parse HEAD)" node --experimental-strip-types evals/assistant-v1/contact-acceptance-candidate.mjs "$PWD" qwen3:8b http://127.0.0.1:11438 /tmp/tada-acceptance.json
```

The evaluator sets up ordinary prior dialogue and fixture files; it never sends scenario IDs, grading rules or the oracle to the product. A failed setup turn is retained, and the corresponding task is not falsely marked executed. Reports are written after every variant. `needs_semantic_review` is not a pass: apply every case's completion, failure and question criteria independently. Exit status is not a semantic verdict. The [2026-10-07 record](../../docs/qualification-2026-10-07.md) retains the failed 8B result and stopped 14B comparison. These routes do not decide the product's default provider; the user selected official existing-subscription integration as the priority.

The [2026-10-09 subscription record](../../docs/qualification-2026-10-09.md) evaluates these same six variants with the selected real subscription model. The first run failed A15-1 for an unnecessary unrelated file read despite all then-existing mechanical checks passing. After a general relevance instruction change and an explicit A15 observation check, the new run passed all six variants in independent semantic review. A subsequent code review found that the evaluator omitted provider identity and advertised local scheduled reviews that the actual subscription service forbids. These semantic observations are retained, but a third run with the corrected execution profile used 25 observed requests and passed all mechanical checks and independent semantic review. That run qualified A10/A15/A16. Later connected-planning and preference runs described below initially brought the total to six cases; the later correction run below adds A09; this does not qualify the full product or physical delivery.

## Confirmed preferences applied to current work

`preference-candidate.mjs` exports `runPreferenceAcceptance({repo, provider, reportPath, implementation, broker, requestLimit})`. The caller supplies its selected, authorized provider and owns profile acquisition/cleanup. The runner preserves provider identity, context measurement and public research capability, uses the actual contact service and native read broker, and fixes two synthetic A05 variants before execution. It does not change production grants, models, accounts or billing. The default total ceiling is 24 requests, including any public research attempts. Stored provider continuation and personal account labels are excluded from reports.

The last conversation context identifies only the current project. Earlier confirmed formatting preferences compete with a newer one-time owner choice in variant 1 and an unconfirmed assistant suggestion in variant 2. Both formats must actually be observed; absent exposure is insufficient evidence, even if the final formatting is correct. A source-grounded answer without unnecessary questions is required; creating a separate document is not imposed on this ordinary request. Mechanical checks never award a semantic pass.

The [first run](results/2026-10-09-preference-first.json) is retained: the first variant did not observe the competing format, and the evaluator omitted public research capability. After correcting these evaluation gaps, the [full-capability run](results/2026-10-09-preference-context.json) used eight observed requests, zero unknown requests and no public web calls. [Independent semantic review](results/2026-10-09-preference-context-review.json) passed both variants. At that point subscription acceptance was **A05/A10/A13/A14/A15/A16: 6 of 16 cases passed, 10 not run**. This is short synthetic-history evidence, not natural long-term memory or release qualification.

## Correcting an earlier reference in saved work

`correction-candidate.mjs` fixes two A09 variants before execution, preserving the supplied provider identity, context measurement and public research capability. It seeds a real encrypted fixture journal with an older unrelated analysis, a yesterday owner-selected company, today's wrong saved work and an unconfirmed version-bound delay proposal. Fixture timestamps are set only while that fixture store is closed. The latest model context does not contain the correct target. No live user records or production grants are changed.

The [real selected subscription run](results/2026-10-09-owner-correction.json) used 15 observed requests, zero unknown and zero public research calls. [Independent review](results/2026-10-09-owner-correction-review.json) confirmed both variants: the same work ID was corrected to v2, its detailed plan and current correction lineage were retained, the approved reminder time was preserved and the old unconfirmed proposal was superseded. This qualifies personal-work correction; it does not prove new research or arbitrary external plan changes. At that point acceptance was **A05/A09/A10/A13/A14/A15/A16: 7 of 16 cases passed, 9 not run**.

## Research from an earlier conversation

`contextual-research-candidate.mjs` exports `runContextualResearch({repo, provider, reportPath, implementation, broker, requestLimit})`. The caller owns the selected authorized profile. Two fixed A01 variants put the current company and criteria outside recent context, alongside a closed investigation of another company and unrelated history/files. The connected folder contains the original dated and hashed same-day public reports from the earlier run; their original citation IDs are not transplanted into the new assistant. The actual native read broker and continuing service discover and read those reports, while isolated public research receives only host-selected owner context. The default total request ceiling is 32. No production grant or owner record changes.

The [actual run](results/2026-10-09-contextual-research-first.json) used 15 observed requests, zero unknown and two public research requests. The raw second variant retains its original automated failure: the old predicate recognized only `open_page`, omitting the observed SEC `find_in_page`. [Independent review](results/2026-10-09-contextual-research-review.json) verified page inspection, source facts, calculations and both complete answers. The corrected predicate recognizes either page action with a URL; a search-only trace still fails and mechanical checks never replace semantic review. The runtime was not changed or rerun to repair this evaluator error.

Both variants passed A01: the assistant retrieved the earlier target and criteria, inspected the relevant archived analysis and current public evidence, and completed a conditional judgment without requiring a company name, upload or source list. The same-day archive does not prove correction of substantially outdated facts. At that point acceptance was **A01/A05/A09/A10/A13/A14/A15/A16: 8 of 16 passed**; A02/A03/A04/A06/A07/A08/A11/A12 remain not run. This is not product release acceptance.

The native evaluator sanity tests require `TADA_TEST_READ_BROKER` pointing to a compiled broker. Linux/Windows CI builds it before `npm run check` and supplies the platform-specific path, also enabling the existing native Google/preference integrations. A Node-only local run without that explicit setting reports the native cases as skipped; it is not native integration evidence.

### Owner-edited document revision candidate

`document-revision-candidate.mjs` exports `runDocumentRevision({provider, reportPath, implementation, requestLimit})`. The caller owns the selected authorized profile. Two fixed A04 environments contain a prior document, ordinary feedback, a separate completed same-title document and a later edit saved through the actual owner-edit path. The latest edited body is not planted into the model checkpoint. Ordinary current requests name no file or document ID. Actual saved lineage, immutable originals, successful latest-body reads and authenticated download bytes are recorded; meaning preservation and useful simplification require independent comparison. The default shared ceiling is 32 requests. No production records or source grants change. Import and ordinary sanity tests never access an account.


The [first run](results/2026-10-09-document-revision-first.json) and [review](results/2026-10-09-document-revision-first-review.json) retain an annotated, unissued source-ID defect. After correcting source admission and document-reference guidance, the [same fixed rerun](results/2026-10-09-document-revision.json) used six observed requests, zero unknown and zero web calls. [Independent review](results/2026-10-09-document-revision-review.json) and the primary accepted both A04 variants. The equipment checklist improved order and exception handling but increased in length; do not report it as volume reduction. The rerun did not itself trigger citation repair. At that point acceptance was **A01/A04/A05/A09/A10/A13/A14/A15/A16: 9 of 16 passed**; A02/A03/A06/A07/A08/A11/A12 remain not run. This is not product release acceptance.

### Saved-document restart continuation candidate

`resume-candidate.mjs` exports `runResume({provider, reportPath, implementation, requestLimit})`. Two fixed A11 environments contain committed document work, a separately cancelled commitment and request, and an interrupted document revision. The second environment includes a later owner-edited version. An owned fixture process reserves synthetic inference, is killed before any provider dispatch, and the actual store recovers the reservation as unknown. These seeded historical receipts are reported separately from new real provider requests; they are not evidence of an uncertain external write.

The real contact service must remain idle after restart, then read the recorded execution status and newest saved document after the new ordinary owner request. The evaluator checks lineage, original content hashes, preserved cancellation and ledger, and bounded fresh inference. It does not self-award semantic or release acceptance. Import and ordinary sanity tests access no account. The scope is continuation from a committed document, not recovery of all mid-turn observations or general external-action resumption.


The [actual selected-subscription run](results/2026-10-09-resume.json) used nine observed new requests, zero unknown new requests and no web calls. [Independent semantic review](results/2026-10-09-resume-review.json) and the primary accepted both A11 variants within the committed-document scope. Each fixture retained two seeded historical requests, including one unknown reservation; these are not new real calls. At that point acceptance was **A01/A04/A05/A09/A10/A11/A13/A14/A15/A16: 10 of 16 passed**; A02/A03/A06/A07/A08/A12 remain not run. General external-action recovery and release acceptance remain unqualified.

## Contextual clarification and missing access candidate

`contextual-access-candidate.mjs` exports `runContextualAccess({provider, reportPath, implementation, requestLimit})`. Fixture version 2 retains two A06 variants with two saved documents and two unresolved recipients. Both A07 variants have preparation for two plausible meetings but no connected calendar or recorded date identifying tomorrow's meeting. The actual local OAuth callback uses synthetic provider responses; only the newly connected calendar distinguishes tomorrow's target from the other meeting on a later date. The same journal continues with a short owner message naming no target or prior answer. One variant changes tentative time and location; cancelled and unrelated events remain distractors. The actual Google adapter exposes its supported fields; the fixture does not grant extra tools or account data.

The caller owns the selected authorized model profile. Identity, context measurement, public research and pre-dispatch authority callbacks are preserved. The shared ceiling is 48 model requests. Reports retain failed and uncertain requests separately and require independent semantic review of the actual questions, preparations and continuation. A06 has no sending capability, so it cannot prove a dispatch guard for an enabled sender. A07 uses the product's bundled Gmail/Calendar read-only scope, not a calendar-only grant, and synthetic OAuth is not live Google account qualification. Production records and grants remain unchanged. Ordinary sanity tests do not access an account or award acceptance.

The [first real run](results/2026-10-09-contextual-access-first.json) used 22 observed requests without unknown or web calls. Its [original review](results/2026-10-09-contextual-access-first-review.json) failed all four variants despite mechanical checks passing. A06 guessed a recipient from recency. A later [independent premise reassessment](results/2026-10-09-contextual-access-v1-fixed-review.json) corrected the A07 judgment: the fixture already identified the meeting and the owner deferred schedule details, making preparation with deferred time/place reasonable. Those A07 fixtures do not establish access-dependent identification and do not justify forcing a connection question. The original review remains preserved with this explicit supersession.

The [same-fixture rerun](results/2026-10-09-contextual-access-v1-fixed.json) used 23 observed requests, zero unknown and zero web. Independent review passed A06-1 but failed A06-2 for asking confirmation of the recent recipient while omitting the other candidate. A07 conversation continuity was observed, but neither run qualifies formal A07. Conditional lineage checks are not document evidence when no new document exists. Fixture version 2 removes the premature target identification and owner deferral; a narrow choice or necessary connection request is valid, not connection alone. No formal case is added from either version-1 run.

The [version-2 real run](results/2026-10-09-contextual-access.json) used 21 observed requests, zero unknown and zero web. [Independent review](results/2026-10-09-contextual-access-review.json) and the primary accepted all four variants. Both recipient cases named all unresolved candidates. Both access cases provided concise preparation from two actual documents, asked only which meeting was tomorrow, then identified the correct meeting after connection and completed its preparation in the same conversation. Neither A07 variant created a new document; this is conversational continuation. No unrelated mail read occurred. Current scoped acceptance is **A01/A04/A05/A06/A07/A09/A10/A11/A13/A14/A15/A16: 12 of 16 passed**; A02/A03/A08/A12 remain not run. This is not product release acceptance.


## Shared-browser freshness candidate

`shared-browser-candidate.mjs` exports `runSharedBrowser({provider, reportPath, implementation, requestLimit})`. Two fixed A08 environments use an owned sandboxed Chrome, actual continuing service and earlier ordinary owner context. After the first observation, variant 1 replaces the target with a different-group field and moves the intended field. Variant 2 keeps the textarea node but changes the account display. These are synthetic pages; no actual external account is used. The shared ceiling is 24 requests. The model receives host tools and observed page context, never evaluator expected actions or case IDs.

The [first actual run](results/2026-10-09-shared-browser-first.json) used six observed requests, no unknown or web calls. [Independent review](results/2026-10-09-shared-browser-first-review.json) failed both variants: stale writes were blocked, but the assistant did not observe again. The host now returns the refusal reason and permits fresh discovery only after confirmed no effect; uncertain or mismatched effects remain blocked.

The [same fixed rerun](results/2026-10-09-shared-browser.json) used nine observed requests, no unknown or web calls. [Independent review](results/2026-10-09-shared-browser-review.json) and the primary accepted both variants. The assistant found and filled the correct moved field, or observed the wrong account display and gave necessary recovery guidance without input. DOM input verification is not server save or submission. At this point **A01/A04/A05/A06/A07/A08/A09/A10/A11/A13/A14/A15/A16: 13 of 16 passed**; A02/A03/A12 remain unqualified. This is not release acceptance.

`shared-browser-smoke.mjs` exercises the actual browser/service with a synthetic model. `shared-browser-boundaries.mjs` independently checks selected-account/checkbox preconditions, hidden-field exclusion, bounded observation retention, cleanup and reopening with fresh private context. Neither accesses live accounts or models. Ordinary tests include exact byte-budget limits, encrypted action persistence, no replay after cancellation or uncertain effect, and fresh observation admission.

The origin-only observation amendment was checked with the same fixed A08 environments. The [first privacy run](results/2026-10-09-shared-browser-privacy.json) retains one failed variant due to provider transport failure (five observed requests and one unknown; no input effect). A fresh [complete rerun](results/2026-10-09-shared-browser-privacy-rerun.json) passed both variants with nine observed requests and no unknown or web requests. [Independent semantic review](results/2026-10-09-shared-browser-privacy-rerun-review.json) and the primary accepted the updated A08 evidence. Combined usage is 15 requests, including the preserved unknown request, within the original ceiling of 24; no previous action was replayed. This adds no new accepted case and does not establish release acceptance.

## Lost-send confirmation

`mail-confirmation-candidate.mjs` exports `runConfirmationAcceptance({provider, implementation, reportPath, requestLimit})`. An authorized caller supplies the existing selected provider and owns account cleanup; The request limit must be a positive safe integer no greater than 24 (default 24), checked before provider inspection. It bounds model requests across two fixed variants. The actual contact service sends an explicitly approved synthetic draft once to a simulated Gmail endpoint. That endpoint constructs its SENT copy from the actual POST MIME bytes and then loses the response. After store/service restart and a newer unsent distractor draft, the product receives an ordinary confirmation request. Variant 1 allows a fresh SENT lookup; variant 2 remains unavailable. No real Gmail write or recipient delivery occurs.

The report preserves requests, tool observations, independent simulated-server content, prior/final receipts and mechanical checks. `needs_semantic_review` requires independent review against all A12 criteria: correct prior target, actual lookup, accurate confirmation level, no delivery/read claim and no default resend suggestion. The evaluator fixture, case ID and oracle are never placed in the product prompt. Failures and unknown provider calls are retained.

## Situated file repair

`situated-file-candidate.mjs` exports `runSituatedFiles({provider, reportPath, implementation, requestLimit})`. Two fixed A02 environments use an actual owned Chrome, selected CSV file, HTTP upload endpoint and rendered table. UTF-16LE and semicolon-delimited inputs fail the receiving app's UTF-8/comma contract. The oracle compares every received and rendered cell with fixed independent values. Two A03 environments begin with an authenticated download of an actual prior Tada result. A local JSON viewer fails to open the downloaded trailing-comma or fenced JSON. Completion requires the repaired file to actually open and render all original semantic content in that viewer. Both cases use the same vague utterance per variant. No case ID, expected values or repair script is placed in product input.

The injected provider retains its identity, context measurement and public research. The request ceiling is a positive safe integer up to 64, default 48, across all four variants; unknown model requests stop the run rather than retry. Original file and saved document hashes, unrelated records, one saved repair action and its copy's correspondence to the actual result are checked. These are small synthetic browser apps, not native desktop, arbitrary file formats, production server durability or release qualification. Mechanical checks still require independent semantic review.

The [first selected-subscription run](results/2026-10-10-situated-file-first.json) used 20 observed requests, zero unknown or public research requests. [Independent review](results/2026-10-10-situated-file-first-review.json) passed A02-2 only. A02-1 completed the repair but its answer confused an unrelated saved record with the current file. Both A03 variants created new JSON documents without observing or repairing the still-failing document viewer. The failures remain recorded. The generic browser guidance now distinguishes current and saved targets and requires observing the intended app operation, rather than treating a new copy alone as completion; it contains no fixture-specific phrases or repair steps.

The [A08 regression after selected-file integration](results/2026-10-10-shared-browser-file-regression.json) used nine observed requests, zero unknown or web calls. [Independent review](results/2026-10-10-shared-browser-file-regression-review.json) passed both moved-field/changed-account-display variants on that implementation. It did not exercise this subsequent situated-operation guidance change.

The [operation-guidance rerun](results/2026-10-10-situated-file-operation.json) used 21 observed requests, zero unknown or web calls. [Independent review](results/2026-10-10-situated-file-operation-review.json) passed both A02 variants and A03-2. A03-1 again repaired only the saved document. The condition “unclear failure” still let the model infer the current target from history alone; guidance was clarified to observe the shared app for a reported malfunction. These first two runs used 41 requests combined. A further fixed rerun is separately bounded to 32 requests; none of the failed variants or calls is removed from the record.

The [current-app-observation run](results/2026-10-10-situated-file-observe.json) used 23 observed requests with no unknown or web calls. [Independent review](results/2026-10-10-situated-file-observe-review.json) and the primary accepted the app-level task criteria in all four variants. Both A02 variants verified the actual received/rendered cells without a download verification call. Both A03 variants opened the corrected selected file in the viewer and preserved the original; A03-1 also saved a linked revised document. Its bare-document reply communicates completion weakly. The old host notice overgeneralized uncertainty despite successful visible operation; subsequent wording separates visible results from automatically unconfirmed final application, without changing the uncertain receipt or replay fence.

At that review point, scoped app-level acceptance covered **A01–A16, 16/16 cases**, in their documented limited variants. This is not full release acceptance or broad file/desktop qualification. Communication caveats, future-use continuity, live device/account qualification and the original release gates remain separate. The three situated runs used 64 observed requests in total, and all failed attempts remain available.

### 저장 파일 후속 조회 — 2026-10-10

[`saved-file-candidate.mjs`](saved-file-candidate.mjs)는 공급자를 주입하는 별도 후속 사용 시험이다. 가져오기만으로 계정에 접근하지 않는다. 재시작·백업 복원한 원장에서 105개의 후속 작업 뒤 원본·수정본을 찾고, 차이를 설명하며 두 인증 다운로드 링크를 제공하는 두 합성 상황을 고정한다. 평가용 정답·환경 mode는 보고서에만 남고 모델 입력에는 일반 사용자 요청과 실제 도구 응답만 제공한다. 요청 상한은 실행 전에 1–32 정수로 검증한다. 불명 공급자 응답이 생기면 재시도하지 않고 중단한다.

[첫 선택 모델 원문](results/2026-10-10-saved-file-first.json): 현재 `gpt-6-astra`, 총 9개 응답 관측·불명 0개, 두 상황의 기계적 판정 통과. 두 요청이 기존 16개 전체 수락을 새로 검증하거나 출시 분모를 늘리는 것은 아니다. 실제 변경 내용과 한계는 [검증 기록](../../docs/qualification-2026-10-10.md#재시작복원-뒤-저장-파일-다시-찾기)에 남긴다.

[독립 의미 검수](results/2026-10-10-saved-file-first-review.json)는 두 사례 모두 통과로 판정했다. 주 세션이 원문 tool_calls와 최종 답변을 대조해 수락했고, 검수 초안의 restart 빈 페이지 수는 실제 1개로 정정했다. 실제 다운로드 성공이나 현재 외부 앱 반영까지 의미 평가가 보증하지 않는다.


### Private-source transfer and ordinary-repair requalification (2026-10-10)

The host now prepares private-source transfers for exact owner approval and keeps ordinary editing isolated. The first updated [A08](results/2026-10-10-shared-browser-transfer-first.json) and [A02/A03](results/2026-10-10-situated-file-transfer-first.json) runs exposed stale preparation and ordinary repairs being diverted into previews or unrelated documents. They remain failed evidence. The runtime now performs read-only preparation preflight, allows planner discovery before a fresh isolated repair, and preserves actual post-approval effect context.

On runtime `30609ed`, the [second A08 run](results/2026-10-10-shared-browser-transfer-second.json) passed both variants in nine observed requests, accepted by [independent semantic review](results/2026-10-10-shared-browser-transfer-second-review.json). `shared-browser-candidate.mjs` now has evaluator owner actor version 1: after inference, it approves only the exact expected text/origin/Haesol field in variant 1; it never approves the excluded account in variant 2. Fixture prompts and product inputs are unchanged; the expected values are not sent to the model.

The [second situated run](results/2026-10-10-situated-file-transfer-second.json) reached its 32-request evaluator ceiling in the last variant and is not a complete pass. The [third run](results/2026-10-10-situated-file-transfer-third.json), using the harness default ceiling 48 with unchanged runtime, fixtures and criteria, passed all four mechanical and [independent semantic checks](results/2026-10-10-situated-file-transfer-third-review.json) in 36 observed requests. Original and unrelated records were preserved; received/rendered table cells and opened JSON semantics matched. Host file receipts remain UNCERTAIN; app-level observations do not prove arbitrary server persistence or relax replay fences. These five runs total 101 observed model requests, including failures and the interrupted evaluation. They do not establish physical-phone or whole-product release acceptance.
