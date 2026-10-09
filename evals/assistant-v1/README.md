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

The [2026-10-09 subscription record](../../docs/qualification-2026-10-09.md) evaluates these same six variants with the selected real subscription model. The first run failed A15-1 for an unnecessary unrelated file read despite all then-existing mechanical checks passing. After a general relevance instruction change and an explicit A15 observation check, the new run passed all six variants in independent semantic review. A subsequent code review found that the evaluator omitted provider identity and advertised local scheduled reviews that the actual subscription service forbids. These semantic observations are retained, but a third run with the corrected execution profile used 25 observed requests and passed all mechanical checks and independent semantic review. The final profile-qualified cases are A10/A15/A16. The other 13 cases remain not run; this does not qualify the full product or physical delivery.
