# CORE-02: durable mock execution

Status: the first executable CORE-02 slice, not a complete stage-1 daemon or a release qualification. This change is stacked on CORE-01. The original Korean design is unchanged. This document records implementation choices, including conservative restrictions, rather than silently rewriting that design.

## What runs

`tada-store` owns a dedicated local directory and holds `owner.lock` with an OS file lock for the full store lifetime. It opens `state.sqlite` and a separately durable `witness.sqlite`, both with WAL, synchronous FULL, foreign keys and bounded busy waits. Tasks and actions are validated against CORE-01 before storage; updates use version CAS and append their event inside the same state transaction. The schema has strict tables, generated state/version columns, state checks, foreign keys, a single-active-run partial index, and immutable payload/attempt/event/receipt triggers.

The only executable target is `MockService`, a separate persistent SQLite effect ledger. It opens no sockets and has no real accounts, credentials, shell or browser. A second call with the same action ID creates a second effect: there is deliberately no service-side deduplication hiding unsafe client retries.

Run the complete validation and the disposable example:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --nocapture
cargo run --locked -p tada-store --example recover_mock -- ./new-mock-demo
```

The example refuses an existing destination. It records a mock effect, loses the response, cancels execution, reopens the store, and verifies the existing effect by observation. It neither sends the mutation again nor labels the whole task successful.

## Admission, authority and time

A run lease contains a task, run ID, supervisor generation and increasing task fence. Deadlines use the owning process's `Instant`. Every store open advances the persistent supervisor generation and invalidates all previous runs and grants, including a restart on the same OS boot. This is intentionally more conservative than retaining same-boot leases; an OS boot-ID probe and a scheduler are not implemented here.

The trusted host calls mock-only control APIs. The worker cannot insert arbitrary SQL through the public API. Proposal scope must match the task's exact mock capability, account, target and purpose. Prepare records AUTHORIZED and PREPARED transitions and creates an internal mock grant. Dispatch rereads the current cancellation epoch, run activity/generation/fence/deadline, policy revision, explicit deny, revocation, payload hash and remaining budget. Cached grants do not bypass these checks.

These checks are **not** a complete SEC-01 broker. There is no authenticated IPC surface, public grant issuance endpoint, general resource selector, egress engine or host sandbox. Anyone who can invoke the trusted control API is within its trust boundary. Do not expose it directly to a model or remote client.

Cancellation and dispatch are serialized through the store owner and an IMMEDIATE transaction. Cancellation first means no new dispatch admission. Admission first means the in-flight mock call may still produce an effect after cancellation. Reconciliation is read-only at the target and remains possible after cancellation. A positive cancellation epoch is never automatically reset, and repeated cancellation is idempotent.

The first implementation permits at most one attempt per action. It does not offer automatic retransmission, compensation or explicit resumption of cancelled tasks. On restart, prepared but never admitted actions are rejected with their history retained; a later engine may make a fresh authorized proposal after checking current state. Admitted, acknowledged or uncertain effects block starting a new run until reconciled. This is narrower than the eventual retry policy, not a claim that all safely retryable cases are implemented.

## Commit ordering and backup restoration

Each state transaction computes its changes and checks business denials before changing the witness. It then appends a monotonic commit witness (operation name, aggregate/event-kind list and its digest), and only afterward commits the state transaction with the same witness sequence. No external mock call occurs until dispatch admission has completed both commits.

A crash between witness commit and state commit leaves a detectable mismatch. Writable open returns `READ_ONLY_RECOVERY_REQUIRED`, even if the interrupted operation may have been harmless. This deliberately trades availability for not guessing whether a lost cancellation or dispatch matters. A storage error poisons the current handle; new mutations cannot proceed until a successful audited reopen. The separate witness is not an atomic transaction with the main database, and this implementation does not claim otherwise.

Opening checks SQLite integrity, foreign keys, schema version/identity, store identity, witness high-water mark, task/action contract validity, latest event/snapshot agreement and immutable payload hashes. `Store::inspect` opens the main database read-only for forensic export. Its output is untrusted data, not authority or proof of completion.

`backup_state` uses SQLite's backup API and refuses an existing destination. Retain the witness independently. Restoring an older state backup while keeping the newer witness quarantines the store rather than reissuing post-backup effects. A missing witness is not silently recreated. If **both** state and witness are reverted together, there is no surviving local high-water mark; this implementation cannot detect all such rollbacks. Recovery then needs an independently retained journal, target observations or a user decision. There is no production restore wizard or automatic quarantine-clearing API in this slice.

The witness records evidence that a commit may exist, not encrypted receipt bodies or a cryptographically authenticated audit log. A malicious same-user process, whole-directory replacement, hard-link aliasing, filesystem relocation or a compromised host are outside this mock fixture's boundary. Use only a dedicated, trusted directory on a local filesystem. Real-user encryption and hardened directory/handle identity belong to subsequent gates.

## Effects, verification and budgets

DISPATCHING is persisted with an immutable payload, a single append-only attempt and a cost reservation before calling the mock. Lost responses remain UNCERTAIN. A missing or ambiguous observation is not proof of non-application and never authorizes replay. Receipt binding checks logical action ID and request hash. Verification rereads the mock ledger and compares the actual target/value with the immutable intended payload.

A confirmed mismatch stays ACKNOWLEDGED with `APPLIED_MISMATCH`, a confirmed effect, failed acceptance, the actual receipt and observation evidence. It is neither rewritten as success nor erased on restart. A receipt that was already stored remains knowledge even when later observation is unavailable.

Budget values are exact integer micro-USD fixture units, bounded by the wire safe-integer range. Dispatch reserves inside the admission transaction. Unknown usage retains its reservation across cancellation and restart; it is not reset to zero. The mock reports a known charge no greater than its reservation. This is not a real pricing adapter, a conversion from the illustrative floating-point wire budget, a subscription balance or a hierarchical parent/child budget ledger.

A VERIFIED action is not a SUCCEEDED task. Required task acceptance criteria remain unmet until ART-01 validates actual deliverables and commits publication. This crate never manufactures an artifact manifest, clears the original required criteria or declares whole-task completion.

## Notification delivery

Stopped/decision entries are committed in the same state transaction as their relevant task state. They contain only stable keys, IDs, versions and kinds; no body, secret or document text. Repeated identical unknown observations and reopen do not create a fresh user decision. An acknowledgement is idempotent, and unacknowledged entries survive reopening. Pending enumeration returns only the current task version: a resolved decision is not offered again as an obsolete question, and superseding an entry does not falsely mark it delivered. The eventual delivery sink must still revalidate the version at delivery time.

Delivery is at-least-once with a stable deduplication key. This PR has no OS notification sender and does not claim exactly-once physical notification delivery: a sink can receive a notification before the sender crashes recording its acknowledgement. A later sink must honor the key. Successful-result notifications remain blocked on ART-01 publication, not simulated by the mock's success.

## Fixed fault coverage

The process-kill test launches the Rust unit-test binary as a child, waits for a named checkpoint, uses the OS kill operation, reaps the child, and inspects both durable ledgers. Fault hooks are compiled only for tests; release builds have no environment-controlled fault API.

| Kill boundary | Required observed outcome after reopening |
| --- | --- |
| Before admission | No effect/attempt; expired prepared action is not replayed |
| Dispatch witness committed, state uncommitted | Read-only recovery required; no guessed dispatch |
| Dispatch state committed, call not sent | UNCERTAIN, one attempt, reservation retained, no resend |
| Independent external effect committed, receipt not saved | Observe existing effect, verify once, no duplicate |
| Receipt state committed, verification unfinished | Reconcile the saved effect; receipt alone is not success |
| Reconciliation/result-outbox transaction committed | Restore verified action and pending outbox, not task success |
| Cancellation witness committed, state uncommitted | Quarantine rather than reviving the pre-cancellation state |

Additional tests cover sixteen threaded cancellation/admission races, same-boot generation changes, stale fences, deterministic monotonic expiry, explicit deny/revision changes, revoked grants, out-of-scope targets, exact integer limits, reservation retention, confirmed mismatch, ambiguous observations, event-write rollback, receipt-write failure, actual SQLITE_FULL from a constrained page count, append-only records, event/snapshot drift, missing witness and state-backup rollback after an effect.

Seven fixed kill boundaries and sixteen local races are regression cases, **not** the design's 1,000-injection release gate, a physical power-cut test or a cancellation latency measurement. The full 120-task evaluation and 200 adversarial cases remain unrun. CI must be reported per actual commit/OS; a source-preparation or formatting job is not test evidence.

## Next boundaries

The next implementation should extend this executable foundation rather than bypass it: authenticated local IPC and command idempotency, a queue/scheduler and broader resource leases, independently reviewed SEC-01 authority, real credential/encrypted blob storage, richer recovery exports/restore handling, hierarchical and provider-aware budgets, then file staging and ART-01 verification/publication. Provider authentication remains a separate authorized proof. No live external mutation should be enabled merely because these mock tests pass.

Implementation references checked 2026-10-01: SQLite [WAL](https://www.sqlite.org/wal.html), [synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous), [online backup](https://www.sqlite.org/backup.html); Rust [File locking](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock); [rusqlite](https://docs.rs/rusqlite/0.40.2/rusqlite/), [sha2](https://docs.rs/sha2/0.10.9/sha2/). These references describe APIs, not independently verified Tada guarantees.
