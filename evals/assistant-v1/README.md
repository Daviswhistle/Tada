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
