# CORE-06: durable scheduling and cooperative supervision

This is a library-level continuation of design §9, §12.3, §19.3 and §23. It adds executable queue ownership and prioritized control admission to the existing store/native IPC. The preserved design remains unchanged. `tada-agentd` is a cooperative host supervisor and a fixed opt-in probe, not an installed daemon, model engine or production tool worker.

## State and execution boundaries

`work_queue` is in the task ledger, not a second best-effort queue database. Task submission, its queue row, task event and the original command receipt commit together. Every authoritative task transition updates the queue in the same transaction. An action-only observation also refreshes the queue even when the task remains CANCELLED/PENDING with no new task version; verified cancelled effects cannot leave a stale observation assignment. Queue records are versioned, schema-checked internal JSON with indexed generated columns; each change has a corresponding immutable event. Opening verifies the current task/queue projection, contract digest and latest queue event before recovery. Missing or contradictory rows are not silently rebuilt as if corruption were a normal restart.

A queue item records its task, kind, state, priority, UTC `run_after_ms`, creation ordinal, attempt count, owner, monotonic lease deadline, supervisor generation, fencing token, cancellation epoch and immutable task-contract hash. `advance` work can acquire a task run; `reconcile` work deliberately cannot. Queue ownership is scheduling permission within the trusted host, **not** a scoped tool grant.

Task and queue states have different meanings. `finished` means no further work is assigned by this supervisor slice, not that task acceptance passed. `cancelled` means no execution work may be claimed. A cancelled task with an unresolved external effect instead retains observation-only `reconcile` work. An existing `APPLIED_MISMATCH` remains a confirmed effect with failed acceptance and does not become a new mutation or an endless verification retry.

`claim_work` atomically acquires the queue lease and, for `advance`, its task run. It rereads authoritative state and policy before admission. Leases bind store identity, task, owner, generation, fence and cancellation epoch. A repeated claim cannot produce a second owner, and a stale claim cannot publish a checkpoint. Restart advances the existing store generation, invalidates earlier runs/grants and resets safe assignments. The queue fence and attempt history survive; verified effects are not sent again.

Live expired leases are not silently stolen. Expiry blocks the old worker's next admission; another worker still needs proof that the old worker stopped, or an audited supervisor restart. This first slice has no process reaper/heartbeat protocol that could safely prove termination. Availability after a hung worker is a follow-through gate, not permission to replay an uncertain action.

## Scheduling and priority

The persistent scheduler is one-shot. `run_after_ms` is an absolute UTC not-before timestamp. It survives reopening and is rechecked for every claim. A backwards wall clock can delay a job; it cannot extend a lease because leases use the owning store's monotonic clock. This does not implement recurring IANA-time-zone schedules, DST occurrence keys, missed-occurrence policy or permission to invent recurring tasks.

Eligible reconciliation has priority 0, tasks with a declared deadline priority 10, and ordinary tasks priority 20. Within a class, not-before time, creation ordinal and task ID give deterministic order. Deadline presence is prioritized; this is not an earliest-deadline-first solver or a deadline-feasibility guarantee. A denied execution policy excludes ordinary claims while existing effect observations and cancellation remain available. Idle polling with no eligible item does not append an event or witness commit.

The host `Supervisor` defaults in the example to one live assignment; construction accepts one through three. Claim, yield, stop-admission and checkpoint operations use the store's shared `AdmissionGate`. Stopping admission does not cancel the user's task or claim an in-flight transaction rolled back. A cooperative host must stop its worker before yielding the assignment. Work and input hashing occur outside the store mutex.

The admission gate orders already-registered work: cancellation, reconciliation, then ordinary commands/completion. FIFO is retained within each class. Tickets are registered **before** spawning blocking workers, so executor thread scheduling cannot put an ordinary operation ahead of a previously waiting cancellation. Abandoned tickets are removed and the wait predicate is checked after every condition-variable wakeup.

Native control authenticates a complete bounded frame and validates a controller's `task.cancel` request before giving it cancellation priority. A model-supplied priority field, malformed command, observer credential or bad MAC cannot claim this class. After waiting, the store again checks generation, session expiry and revocation before processing the body. Existing JSON-RPC methods, payload contracts, duplicate-key rejection and original-command replay semantics are unchanged.

This ordering does not preempt a transaction that already acquired admission. Nor does it solve a full pre-authentication connection pool, an unbounded external host holding the raw store mutex or physically hung disk I/O. The old trusted-host store methods remain available for fixtures; callers bypassing the gate are outside its ordering promise. A controller cancellation during an already admitted external call can still leave an effect to reconcile. There is no measured 250 ms p95 claim in this PR.

## Model-free probe and observation worker

`supervisor_probe` is an explicit disposable example. It creates two probe tasks and a cancelled task, sets a one-shot delay, reopens the store, hashes each claimed immutable contract outside the store lock, checks the returned digest and atomically commits a checkpoint plus stopped state/outbox. It rejects stale/cancelled assignments, does not clear required task criteria and never sets `SUCCEEDED`. A checkpoint proves the probe ran against the bound input, not that a requested document or user goal is complete.

```sh
cargo run --locked -p tada-agentd --example supervisor_probe -- ./new-supervisor-demo
```

The destination must be new. The example installs nothing, reads no OS/provider credentials, invokes no model and dispatches no external tool. Its timestamps are deterministic fixture UTC milliseconds, not the current wall-clock schedule of an actual user task.

The observation path is separate: `reconcile_work_mock` reads up to 32 existing pending actions from the independent mock ledger. It never calls the mutation endpoint or receives a task-run lease. Missing/ambiguous observations retain `OUTCOME_UNKNOWN`, the existing reservation and a delayed queue item. Receipt/result changes use the original CORE-02 verification rules. A positive cancellation epoch is preserved throughout. This local mock observation is bounded by record count, not a production remote-I/O timeout guarantee.

## Explicit schema migration

New stores initialize task-ledger schema v2. The source of the original v1 schema is preserved exactly, and `queue.sql` is an additive migration with its own composite checksum. The independent witness stays at schema v1. A normal open of an older task store returns `QUEUE_MIGRATION_REQUIRED`; it does not mutate task history, enroll a new identity or start work.

Stop the old owner first, retain the independent witness, and explicitly supply a **new** backup destination:

```sh
cargo run --locked -p tada-store --example migrate_queue_v2 -- /existing/store /new/location/v1-backup.sqlite
```

The migration obtains exclusive store ownership and audits the old state. `DISPATCHING`, `ACKNOWLEDGED`, `UNCERTAIN`, `VERIFYING` or `PUBLISHING` work blocks it; use a compatible v1 binary to reconcile first. It creates a consistent SQLite online backup, then creates queue/checkpoint tables, projects existing tasks, updates the schema checksum and records migration completion inside one witnessed state transaction. The original command journal and cancellation records are retained.

A crash after the backup but before migration permits an explicit retry with another new backup path. A crash after witness commit but before state commit is quarantined as `READ_ONLY_RECOVERY_REQUIRED`, not guessed away. A completed migration can be reopened without migration replay. A v1-only binary rejects schema v2 instead of running against fields it does not understand. Restoring an old backup while retaining a newer witness also requires recovery. Reverting both databases together removes the independent high-water evidence and is not fully detectable locally.

This API is not a general rollback wizard, cross-version encrypted-backup product or hardware power-loss qualification. Existing directory identities and backup constraints follow the trusted-local-store boundary documented in CORE-02.

## Regression coverage

The fixed queue fault matrix has nine real child-process kill boundaries: claim witness/commit, defer witness/commit, checkpoint witness/commit, and migration backup/witness/commit. Parent tests kill and reap the child, reopen state, and check either preserved queue/checkpoint behavior or explicit recovery quarantine. They do not hide quarantine as successful automatic resumption.

Other cases cover transactional submission/queue rollback, deadline/FIFO ordering, due time over restart and clock rollback, idle no-write polling, duplicate owners, stale/cross-store/expired claims, cancellation of queued/leased work, late worker results, input-hash mismatch, unknown-cost retention, delayed observations without retransmission, policy deny with observation still available, corrupted queue/checkpoint state, legacy migration and backup refusal, and authentication-based priority classification.

The native regression holds an active admission permit, registers ordinary probe completion, sends a real authenticated cancellation through Unix socket/named pipe, waits until that cancellation is actually queued, and releases the permit. Cancellation must commit first and the late probe must be rejected. It is an ordering test, not a synthetic sleep-based latency claim.

The earlier contract, effect-loss, control-replay, native transport and actual OS-vault suites remain required. Final PR evidence must identify the exact commit and operating-system jobs. No source-preparation job, unavailable backend or skipped feature can stand in for execution evidence. Nine boundaries are not the design's 1,000-injection release gate.

## Next integration

The next worker boundary needs process lifecycle/containment, startup discovery and an installed or foreground agentd host, bounded engine-worker IPC, worker-scoped SEC-01 authority and verified safe-yield/reaping before any lease reclamation. Recurring schedules and hierarchical budgets need their own contracts. File operations and ART-01 result verification/publication follow those boundaries. A working queue and a verified mock checkpoint do not justify enabling arbitrary host tools or claiming user-result completion.

API references checked 2026-10-02: SQLite [transactions](https://www.sqlite.org/lang_transaction.html) and [online backup](https://www.sqlite.org/backup.html); Rust [Condvar](https://doc.rust-lang.org/std/sync/struct.Condvar.html). These explain implementation APIs, not independent evidence that Tada meets release guarantees.
