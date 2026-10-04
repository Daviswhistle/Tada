# Current roadmap — an assistant, not another layer of mock infrastructure

Revised 2026-10-04 following the user's explicit correction. [Product contract](product-contract.md) is the current behavior specification. The preserved design remains a historical source and its safety invariants remain in force; its old examples and implementation ordering are not the active priority list.

## Next delivery: one continuous delegation experience

The next working build must accept ordinary conversation, discover the relevant context and sources, perform useful work through general tools, verify the result, and accept a follow-up without requiring the user to restate everything. Use the same assistant path for research without attachments, “This isn't working” in the current environment, and “Make the earlier one simpler.” Do not implement three phrase-to-script routes.

**Live provider proof, conversational intake, context discovery and a minimal conversation/result surface start now, together with the first real tools.** They are no longer deferred until every infrastructure follow-through is finished. Existing authorization, cancellation, durability and process boundaries are reused. Fix a concrete blocker on this path rather than requiring a new series of stand-alone abstraction PRs before any user-visible work.

| Work inside this delivery | Observable acceptance evidence |
| --- | --- |
| Natural conversation entry and ongoing-work links | Accept a raw message without required attachment, path, task ID or completed TaskContract; follow-up refers to the correct prior work/result. |
| Authorized real model route | One actual selected provider or local-model route reasons over the observed input; credentials, capabilities and costs are explicit. A deterministic mock is not this proof. |
| Relevant context and source discovery | Retrieve conversation/results/preferences, observe the current target when permitted, and search permitted local/connected/public sources without tester-supplied source paths. |
| General tools and result verification | Use reusable file/search/browser/app or explicitly authorized process tools; demonstrate the user's original action or a usable sourced result, not a contract-digest receipt. |
| Evidence-backed continuation | Commit observations and actual tool evidence through the existing ledger; retain limits and current user edits across follow-up and safe restart. |
| Narrow questions and permission handling | Resolve discoverable facts independently, ask for a genuine missing choice/access, and remain useful when one source is unavailable. |

These are workstreams within one user-facing milestone, not six new complete subsystems that must each be generalized before integration. Split commits for review where useful, but report the unfinished end-to-end outcome honestly. Thin UI and CLI are both acceptable development entry points; raw JSON or manual technical context preparation is not the product interface.

### Execution order inside the slice

Start with a raw conversation plus one authorized real inference route and request-scoped context reads. Connect dynamic source discovery and the first useful general tool as soon as that path exists. Add actual-result verification and same-conversation revision while closing only the durability/permission gaps exercised by those actions. Require the relevant fault checks before enabling effects; this priority change never licenses skipping them.

A discovery phase can start with an unresolved subject and no user-supplied source. It must inherit bounded approved reads and cost limits, not unrestricted authority. The engine creates/revises internal execution contracts from observed evidence. Exact target/precondition/approval checks apply before the corresponding mutation, not as a reason to reject the initial utterance. Any necessary wire/version changes ship with the actual intake integration; do not weaken existing v1 validators or mutate an already bound contract hash.

For a live route, confirm official current eligibility and serialization contracts at implementation time. Use explicitly authorized credentials; never reuse another application's tokens, invent account access or silently choose a paid fallback. No specific provider policy is reverified by this documentation change. If live access cannot be exercised, record that blocker and continue independently implementable integration; do not label a mock run as live proof.

## Product acceptance, separate from component regression

The [assistant-v1 suite](../evals/assistant-v1/README.md) contains 16 fixed scenario specifications covering discovery, situated reference resolution, follow-up, memory, access, ambiguity, freshness, trust, privacy and ordinary personal work. Run the same wording against different environments and unseen paraphrases against changed names/paths. The evaluator's setup, oracle and expected outputs never enter the assistant prompt.

The current baseline is **not run**. Scenario validity, mock success and CI success do not qualify the assistant. Record actual model/route, implementation revision, observable source/tool evidence, user preparation and questions, outcome verification and remaining failures. Unavailable environments stay in the denominator as blocked/unrun, not removed. Success is completing the delegated goal within current permissions; “zero questions” achieved by guessing a target is failure.

First inspect A01/A02/A04 as discovery, current-situation work and follow-up probes, alongside the necessary ambiguity/access/trust controls A06/A07/A10/A16. This is a development order, not a reduced published denominator: report all 16, and do not claim the initial product gate until every case has been evaluated and satisfied its rubric. Physical reboot, broad native-app coverage and the original release/security evaluation remain separate gates.

## Development admission rule

Every feature PR states the user's original utterance, what the assistant discovered rather than being handed, the observed outcome, and the next incomplete part of the same user experience. A maintenance/security fix may be component-only but must say so. Test/PR counts are engineering evidence, not product completion percentages.

Do not add empty packages, hardcoded phrase routers, another synthetic digest feature, or a generalized framework without a demonstrated blocker in the current delegation slice. Use the [PR template](../.github/PULL_REQUEST_TEMPLATE.md) and [repository instructions](../AGENTS.md).

## Existing implementation to reuse

These are implemented component boundaries through PR #11, not a usable assistant and not instructions to keep extending each independently.

| Component | Reuse and current boundary |
| --- | --- |
| [CORE-01 contracts](contracts-v1.md) | Cross-language schemas/fixtures; an internal execution contract is not a user intake form. |
| [CORE-02 store](core-02.md) | Witnessed SQLite state/effects, cancellation, reservations and outbox; recovery gaps quarantine rather than guess. |
| [CORE-03 control](control-protocol.md), [CORE-04 IPC](native-ipc.md) | Authenticated command replay, Linux sockets and Windows pipes; no natural-conversation endpoint yet. |
| [CORE-05 identity](installation-identity.md) | Explicit OS-vault enrollment and authenticated discovery; not provider login or screen consent. |
| [CORE-06 queue](queue-supervisor.md), [CORE-07 host](process-host.md) | Durable scheduling and owned fixed-child lifecycle; not a general task solver or universal sandbox. |
| [SEC-01A authority](worker-authority.md), [ENGINE-01A pipes](engine-duplex.md) | Exact-scope broker and Rust/TypeScript exchange; only the assigned contract-digest tool is exercised. |
| [MODEL-01A streams](model-streams.md) | Normalized stream validation and bounded mock controller; session-local model state. |
| [MODEL-01B ledger](inference-ledger.md) | Durable host admission/accounting and v3 version barrier; not yet connected to the TypeScript loop or resumable conversation. |

The currently immutable execution contract is an identified integration mismatch for progressive understanding, not a reason to ask the user for a complete specification. Preserve existing records and grants when introducing revisions; make stale bindings unusable rather than silently updating them.

## After the first delegation experience

Broaden source/connectors and reusable tools, whole-computer control, native OS coverage, personal-work scenarios and long-lived memory. Add installed-service delivery, runtime packaging/integrity, key rotation/revocation, broader containment, richer restore handling, recurring schedules and hierarchical budgets where the actual product needs them. Maintain capability-specific limitations instead of treating one unsupported adapter as total assistant failure.

Result verification/publication, signed distribution, security review, original fault and adversarial evaluations, privacy controls and platform qualification remain release requirements. They do not replace user-experience acceptance. No deadline or percentage-complete claim is implied by this ordering.
