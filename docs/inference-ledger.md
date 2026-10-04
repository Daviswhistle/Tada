# MODEL-01B: durable inference admission and observation

This slice implements the Rust storage boundary for the preserved design's §9, §11, §12, §19 and §23. It follows [the bounded mock stream controller](model-streams.md). The supplied design is unchanged. New internal records and the backed-up storage-v3 transition are implementation refinements.

## Executable boundary

`crates/store/src/model_ledger.rs` provides trusted-host APIs for a single fixed route, `mock-contract-digest-v1`. Admission persists a request, its exact mock input, reservation, lifetime turn ordinal and current execution binding before returning an execution ticket. Cumulative usage and a final observed receipt are appended to the same witnessed store. The final receipt is also a content-fingerprinted observation checkpoint; it exists before a caller receives the response.

The fixed input contains task/request identity, the immutable task-contract hash, predecessor checkpoint and output-token limit. It is stored as recoverable content-addressed bytes, not a hash without a payload. User goals, prompts, credentials and reasoning text are not copied into this input or model events. A live adapter will need encrypted context/continuation storage rather than adding plaintext prompts here.

The only proposal the final mock receipt may contain is the exact assigned `task.contract_digest` read. The ledger validates its schema, task, resource, purpose, version and expected hash. It neither executes that proposal nor issues a tool grant. Authority for a subsequent actual tool call remains with SEC-01A.

These types are internal versioned Rust storage records, not a new worker JSON-RPC contract. No new method is added to the existing UI or worker RPC router. The TypeScript controller is not yet connected to these APIs; its own counters remain session-local. The runnable example and new regression suite exercise the host storage boundary directly.

## Explicit storage-v3 opt-in

Existing and newly created ordinary developer stores remain schema v2 until the trusted host calls `Store::enable_mock_inference(NEW_BACKUP_PATH)` at a safe point. Active work or unresolved external effects/publication block the transition. The method audits v2, creates a consistent SQLite backup, then commits `user_version=3`, a new semantic fingerprint and a single migration marker in one witnessed transaction. Repeating the request for an already valid v3 store does not write another marker or backup.

No table layout rewrite is needed: inference uses the existing immutable payload table and append-only event journal. The version still changes because an old binary's budget calculation would otherwise ignore model reservations. The pre-v3 implementation only recognizes schema versions 1 and 2; its normal writable open rejects this version/fingerprint instead of treating inference usage as zero. Forensic read-only inspection is distinct from writable compatibility.

A crash after backup leaves readable v2. A crash after the v3 state commit leaves auditable v3. A witness-before-state gap requires read-only recovery, including when the interrupted operation appears harmless. Keep the independent witness; restoring only the pre-upgrade state backup cannot erase newer history and resume automatically. Reverting both state and witness together still needs independent surviving evidence and is not made safe by this migration.

## Admission and replay

`admit_mock_inference` requires a live execution `WorkLease`, an explicit task model-turn cap, a v3 store, the current predecessor checkpoint and sufficient shared task budget. It checks the owning store/task, supervisor generation, queue/run fence, monotonic expiry, cancellation epoch and current host policy revision at the transaction boundary. The timeout is clamped to the current queue lease.

`InferenceAdmission::Fresh` carries an opaque non-clonable, non-deserializable ticket. Repeating the same immutable request ID returns `Recorded`, a historical snapshot, never another execution ticket. Changing its reserved amount, limits or predecessor while reusing the ID is rejected. The execution ticket is for trusted host adapter code, not a capability sent directly to arbitrary code or a real provider.

An admitted request may already have been sent even when no response was recorded. Reopen therefore turns unfinished admissions into `Unknown`, retaining their turn, input reference, usage and reservation. A fresh model request is blocked while any prior request is admitted or unknown. Reopening again does not append duplicate uncertainty events. There is no automatic retransmission or a way to reconstruct an execution ticket from an observation handle.

`inference_observer` can reacquire an accounting-only handle after restart. It allows a trusted adapter to record usage or the exact externally observed receipt, including after cancellation. It does not create new execution authority. Identical final receipts replay without another event; conflicting receipts are rejected.

## Accounting and checkpoints

Model reservations and the existing mock-action reservations are summed against the same task-level integer micro-USD cap. They cannot each spend the full balance independently. The amounts in this route are fixture units, not a price table or a verified real-provider dollar guarantee.

A request consumes one lifetime task turn at admission. Reconnect, cancellation, process restart and receipt replay do not reset that count. A known final charge settles the reservation exactly once. Missing final charge retains the full reserved amount even when the stream finished and token usage was observed. An observed charge above the fixed mock reservation is rejected and leaves the unresolved request blocking another admission; real pricing/overage and provider-hard versus client-soft limits remain adapter work.

Usage observations are cumulative and monotonic per request. Repeated snapshots are idempotent, regressions are rejected and at most 64 changing observations are accepted. Aggregate token overflow is explicit: the checkpoint retains a lower-bound total plus `usage_overflow`, while every per-request exact observation remains available. Missing or unfinished usage remains counted as uncertain rather than refunded.

The receipt, request binding, final classification, acceptance-at-commit flag and checkpoint fingerprint share one append. The next request must identify the latest checkpoint. `output_accepted_at_commit` is historical admission information, not a grant or a current-authority check: consumers must still use the broker. Late cancelled, expired, policy-invalid or previous-generation responses may settle accounting but get no accepted-output flag.

Two consecutive protocol-error receipts require diagnosis across restart. Capacity, authentication, network and cancelled receipts require a future explicit wake/resume path. They do not silently select another account, refill the budget or bypass a wait. These checks deliberately stop at the host storage boundary rather than inventing a full engine state machine.

The checkpoint describes inference observations and accounting. It does not contain a resumed conversation, an encrypted reasoning handle, artifact verification or complete tool-result lineage. The original task acceptance criteria remain unchanged and no task becomes `SUCCEEDED`. Pending model observation blocks the existing pure-probe checkpoint and safe-yield APIs. The scheduler and rich engine outcome/wakeup envelope still need explicit integration before a persistent serving mode can drive this ledger.

## Integrity and fixed fault coverage

Startup verifies the storage-v3 marker/fingerprint, immutable input bytes, task/record bindings, contiguous request ordinals, checkpoint predecessor chain, usage monotonicity, final-receipt consistency and shared budget cap. Per-task event replay is bounded. Unknown model event types, duplicate admissions/final records, mismatched inputs or broken references fail rather than being repaired. A storage error poisons the current handle and blocks new mutations. The event journal is not a cryptographically authenticated log against a compromised same-user process; indexed production projections are also future work.

The inference kill matrix contains nine fixed boundaries: admission, usage observation and final receipt, each before the transaction, after the independent witness commit, and after the state commit. The parent actually kills and reaps its test child. A separate mock provider SQLite ledger records the observed receipt without an idempotency cache. Recovery reads that receipt; it never appends a second provider execution. An admission committed before any provider row remains unknown rather than being assumed unsent.

Three additional process-kill boundaries cover v3 backup, witness and state commit. Other regressions exercise replay/payload conflicts, cancelled late results, stale policy/expiry, bounded usage, shared action/model cost, exhausted lifetime turns, invalid receipts/proposals, event-write rollback, backup restoration, corrupt startup records and repeated reopen. Fixed fault cases are regression coverage, not the full 1,000-injection or physical power-cut release gate. Per-head CI observations belong in the PR.

## Run it

With the repository-pinned toolchains:

```sh
cargo test --locked -p tada-store model_ledger:: -- --nocapture
cargo test --locked -p tada-store model_migration:: -- --nocapture
cargo run --locked -p tada-store --example inference_recovery -- ./new-inference-demo
```

The destination must not exist. The example creates disposable data and a v2 backup, explicitly enables v3, reserves 40 fixture units, records cumulative usage, cancels and reopens. It observes a final charge of 17 while retaining one consumed turn and `CANCELLED` execution; the old response is not accepted for execution. No model, provider credential, OS-vault enrollment or external account mutation is used.

The full CI keeps existing npm, Rust, native IPC, worker/process failure, TypeScript model-stream and isolated OS-vault regressions, and adds execution of this example on Linux and Windows. Static portability on macOS is not desktop-engine support.

## Next integration

Connect this host ledger to a separately versioned Rust–TypeScript model-request/observation envelope, including acknowledged commits before advancing the loop. Bind actual tool-result evidence into the engine checkpoint, persist waiting/wakeup and failure state, and validate cancellation at each duplex/storage boundary. Then add provider-specific serializers, real pricing and account capabilities, encrypted context/continuation and authorized live-provider conformance. File staging, independent result verification/publication, runtime packaging and UI remain their own gates.
