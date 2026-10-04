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
