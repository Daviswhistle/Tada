# MODEL-01A / ENGINE-01B: bounded mock model streams

This implementation follows the preserved design's §6.5, §11, §12, §23, §24 and Appendix C/F. It builds on [ENGINE-01A](engine-duplex.md), without replacing the original design or changing task/control/worker-v1 contracts, task-ledger schema v2, installation identity, dependencies or lockfiles.

## Executable slice

`packages/providers` now owns a versioned normalized event contract, stream collector and deterministic no-I/O mock. `packages/engine/src/model-loop.ts` validates a complete model turn, proposes the exact assigned digest read through a supplied ToolPort, then gives its committed evidence to the next model turn. It returns a bounded stop/verification/recovery classification. No SDK, remote endpoint, account lookup, model inference, credential or paid fallback is present.

The actual Node process fixture composes this controller with the existing Rust propose/grant/invoke/replay broker. The final worker result is withheld until the mock follow-up model stream also finishes correctly. A committed digest read remains in the ledger if a later stream fails; it does not justify a checkpoint or task completion by itself.

## Model event v1

`packages/contracts/schema/model.v1.json` is a separate schema. `generate-model-contracts.mjs` derives TypeScript and Rust declarations; both validators consume 36 shared positive/negative cases. Existing source schemas and generated types are preserved.

Each event has `schema_version`, `request_id`, contiguous one-based `seq` and a discriminating `type`. Supported shapes are `text_delta`, `tool_call_delta`, `tool_call_complete`, `reasoning_handle`, `usage`, `rate_limit`, `completed`, and `failed`.

`payload_json` refines Appendix C's illustrative `payload: unknown`: retaining exact JSON text lets the engine reject duplicate keys before parsing can discard them. When deltas exist, the completion payload must be byte-for-byte the accumulated text. A provider may emit a complete-only call. Raw provider transport decoding/duplicate-event handling belongs to each future adapter; the collector receives already normalized event objects, not arbitrary HTTP/SSE bytes. Sequence numbers are adapter-owned, not model authority.

Successful collection requires the complete-call events, one compatible terminal `completed`, and iterator EOF. A trailing event, unfinished call, changed completion payload, reused call ID, unknown field/version, foreign request or sequence gap rejects the entire turn before any proposal is released. All calls in a valid turn are then strict-JSON/schema/scope-checked before the first dispatch. Nothing reconstructs a tool call from parseable fragments.

Text is counted against resource limits and discarded, not logged or promoted into evidence. A syntactically shaped `reasoning_handle` is represented in the wire contract but explicitly rejected by this collector until a real encrypted continuation store exists. It is neither plaintext reasoning nor a cross-provider handoff.

## Bounded recovery

The session has separate turn, tool-call, recovery-attempt, active-time, event-count, total-byte and per-call-byte bounds. Caller limits may be lower than the implementation ceilings (80 turns, 16 tools/recoveries, 30 seconds, 4096 events, 1 MiB serialized event data per turn and 16 KiB per call). These ceilings constrain this mock slice; they are not product defaults or a provider price/entitlement guarantee. Zero turn/tool/recovery allowance is valid.

A failed model request consumes its reserved turn. A malformed or interrupted response may be replaced by a fresh bounded model stream, never by patching its partial JSON. Two consecutive identical phase/input/error signatures enter `diagnose`; changing errors still cannot exceed the total recovery allowance. Resource exhaustion stops rather than entering a schema-correction loop.

A replacement stream also requires the previous local iterator to have ended or acknowledged `return()` with `done: true`. Cleanup gets a separate, bounded 100ms grace period after abort is forwarded. Missing, rejecting, malformed or non-settling cleanup produces `unsupported / MODEL_CLEANUP_UNCONFIRMED`; the loop starts no second stream. Cancellation and an already expired session deadline keep their own classifications. Natural EOF needs no extra `return()` call. Closing a local iterator is not proof that a remote provider cancelled an inference or refunded usage.

Iterator ownership is retained as soon as it is acquired, even when acquisition itself finishes after cancellation or the monotonic deadline. The rejected acquisition result is still cleaned up. A timeout while awaiting the wrapper must not lose the resource that the wrapped operation actually created. Late cleanup rejection is observed without exposing raw adapter errors.

Capacity responses return `waiting / PROVIDER_CAPACITY` with a bounded positive `retry_after_ms` when provided. Authentication and network failures return distinct waiting reasons. This controller does not sleep, register schedules, reconnect accounts, install a provider or choose another paid route. A future persistent scheduler must supply wake events/times under the existing task WAITING contract.

Tool transport/result failures are outside the model-correction loop. They return `reconcile` and retain consumed call capacity. The controller never automatically reissues an ambiguous tool invocation. Logical call IDs cannot be invoked twice by later model turns. The supplied ToolPort is a trusted host adapter, not authority created by a JavaScript interface: the actual fixture still uses current Rust policy, channel, generation, cancellation epoch, fence and result bindings.

`verify / MODEL_FINISHED_NOT_VERIFIED` means the model stopped, not that an independent verifier passed. It can contain no evidence. The native fixture rejects that as uncheckpointable; no task becomes SUCCEEDED. A real ART-01 verifier/publication path remains necessary.

## Cancellation and accounting

Async waits are bounded by one monotonic session deadline, including final-event-then-hang. Iterator cleanup has the additional bounded 100ms grace period described above, even for adapters whose `next` or `return` never settle. Abort is forwarded, late promise rejections are observed and operations are rechecked immediately before entry. This cannot preempt synchronous same-process code or prove a remote request stopped. The Rust parent still owns process cleanup; the existing Linux/Windows lifecycle regressions remain enabled.

Cancellation before tool admission produces no new call. Cancellation during an already-entered ToolPort wait is an unknown outcome requiring reconciliation, not a rollback receipt. The host remains responsible for actual dispatch/cancellation serialization and preserving late effects.

Usage events are cumulative input/output snapshots within a request, so repeated snapshots are not summed. Regression is rejected. Across requests observed counters are added once; interrupted/missing usage increases `uncertain_requests` rather than refunding the turn or claiming zero cost. Safe-integer overflow stops with `usage_overflow`; retained counters are a lower bound, not a falsely exact total. These token meters are session diagnostics, not a dollar ledger or authoritative parent/child budget.

## Exact persistence boundary

The controller has no checkpoint import or automatic restart API. Its turns, failure signatures, provider continuation and evidence view are session-local. Only existing broker read receipts and final pure-probe checkpoints use the durable Rust store. Do not claim that restarting the worker preserves model usage/retry limits or resumes an interrupted model stream.

The feature-only bridge uses test limits and mock events, not the demo TaskContract's inference budget. Ordinary `serve`, `serve-probe`, `demo-engine` and `demo-typescript` continue their original paths. The ordinary Rust host rejects `model-*` fixture arguments before creating a destination. Running source directly is trusted developer code, not a packaged security boundary.

Model-loop `waiting`, `diagnose`, `budget` and `reconcile` are controller outcomes only. The old digest fixture protocol has no general engine outcome envelope; unsuccessful model fixtures exit with a fixed diagnostic, and the parent parks the probe as STOPPED/PENDING without a checkpoint. There is no fabricated durable WAITING state or pending UI decision in this slice.

## Reproduction and evidence

Use the pinned `.node-version` and Rust toolchain, then:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
```

`npm test` explicitly enables Node's type stripping; TypeScript source is also checked separately with `tsc --noEmit`. Runtime imports retain `.ts` extensions and TypeScript permits them in this no-emit project. See the [Node TypeScript documentation](https://nodejs.org/api/typescript.html); passing an exact version check is not executable authenticity proof.

A focused actual-process run, using a new destination and the real absolute pinned Node path:

```sh
cargo run --locked -p tada-agentd --features process-fixtures --bin tada-agentd -- demo-typescript ./new-model-demo ABS_NODE model-normal
cargo run --locked -p tada-agentd --features process-fixtures --bin tada-agentd -- demo-typescript ./new-model-recovery ABS_NODE model-repair-once
```

The fixed test denominators are 36 model-wire cases shared across languages, 16 stream protocol rejection cases, and 9 actual Node model-fault scenarios plus 2 successful/recovered scenarios. Additional tests cover deadlines, cancellation, usage, recovery/tool limits and outcome binding. The process scenarios are nested in two Rust test functions and must not be added again as independent top-level functions. Expanded suites overlap ordinary coverage. Per-head CI results belong in the PR, not invented here.

The nine process failures are persistent partial JSON, repeated protocol failure, capacity, authentication, network, prose-only completion, failure after a committed read, changed tool scope and a hung model stream. Each checks process reaping, channel revocation and no false checkpoint. Only the post-read failure retains one invocation record. Earlier broker replay, native cancellation, parent-death and thirteen-case process/duplex matrices remain mandatory.

Seven additional cleanup regression functions cover acknowledgement before recovery, eight unconfirmed cleanup variants, natural EOF without `return`, cancellation/deadline during acquisition, cancellation during cleanup, and late cleanup rejection. The eight variants are missing, pending, rejected, synchronously thrown, null, `done: false`, a throwing `return` getter, and a throwing `done` getter. These cases preserve the previous fixed denominators; no case was removed to obtain a passing run.

## Next gate

Before live inference: host-owned durable model-request admission and budget reservation; versioned engine outcome/checkpoint envelopes; committed observation before another model turn; restart/usage uncertainty recovery and cancellation at every persistence boundary. Then add account-route-specific serializers and authorized provider conformance, including capabilities and encrypted continuation. Model SDK support, production WAITING wakeups, general tools, file staging, independent artifact verification/publication, runtime packaging and desktop UI are separate work. This slice does not satisfy the full MODEL-01/ENGINE-01, reboot, 1000-injection or end-user release gates.
