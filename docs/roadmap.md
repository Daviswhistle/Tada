# Implementation gates

This is an execution order, not a release-date promise. The supplied design's §32 and Appendix F remain the basis. CORE-03 through CORE-07 are implementation substeps; they do not rename the original work breakdown or complete its entire stage 1.

## CORE 01 — contract foundation

Schema and transition sources, generated Rust/TypeScript types, fail-closed value validation, shared fixtures, preserved design, and CI. Provider authentication evidence and an independent threat-boundary review remain separate from the green contract suite.

## CORE 02 — durable mock execution

`crates/store` owns SQLite state/event CAS, a separately durable restore witness, OS store ownership, supervisor-generation leases, cancellation/dispatch serialization, an independent non-idempotent mock, exact integer fixture reservations and a stopped/decision outbox. See [CORE-02](core-02.md) for original boundaries and fixed fault cases.

The original review scope remains:

1. WAL/FULL, state/version CAS and event append in one transaction, foreign keys and state constraints, one active run, and read-only recovery when invariants fail.
2. Single daemon ownership, scoped leases and monotonic-time fencing. Stale owners cannot admit new dispatch. Current recovery conservatively invalidates all prior generations, including the same OS boot.
3. Durable cancellation serialized with dispatch admission. Already-admitted operations may finish after cancellation; observation may continue, new effects may not.
4. Immutable payloads, append-only attempts/receipts and explicit reconciliation. Response loss must neither cause a second effect nor fabricate success.
5. Reservations including uncertain usage, checkpoints and result outbox. Do not implement a floating-point money ledger from the illustrative wire budget.

Required faults include process kill around admission, response loss, revoked cached grant, concurrent cancellation, stale fence, applied mismatch, unknown outcome after cancellation, disk-write failure and restoring a backup after an external effect. Preserve fixed denominators. Safe quarantine is not successful automatic recovery, and regression samples are not the 1,000-injection release gate or hardware power-loss qualification.

## CORE 03 / CORE 04 — authenticated control and native transports

[CORE-03](control-protocol.md) supplies bounded authenticated commands and atomic logical-request replay. [CORE-04](native-ipc.md) binds them to Linux Unix sockets and Windows named pipes with peer checks, absolute I/O deadlines, bounded sessions and a separate-process fixture. Session-only bootstrap remains available through an inherited anonymous pipe. Unsupported native platforms reject before creating endpoints while the portable workspace still compiles.

## CORE 05 — persistent installation identity

[CORE-05](installation-identity.md) adds explicit RESERVED/ACTIVE enrollment, Linux Secret Service and Windows Credential Manager adapters, private installation metadata, a daemon lifetime lock, authenticated discovery and generation-pinned native connection. Missing or altered active keys block new load/bind/reconnect; interrupted reservation requires explicit finish with lookup before creation. Tests distinguish mock-vault behavior from isolated real-vault process tests.

Human-facing enrollment/recovery, stable default launcher paths, key rotation, live durable revocation, stale-runtime retention and reboot qualification remain. Deleting an OS-vault key does not instantly revoke cached sessions. Installation credentials never constitute worker tool grants.

## CORE 06 — durable queue and cooperative supervisor

[CORE-06](queue-supervisor.md) stores queue registration and updates with authoritative tasks/events in one witnessed transaction. It adds one-shot UTC not-before scheduling, reconciliation/deadline/ordinary ordering, opaque owner/generation/fence leases, safe explicit yield, immutable probe checkpoints, and a host supervisor with bounded active assignments. Idle polling makes no journal writes. Cancelled execution does not resume; unresolved effects retain observation-only work and their cost reservations.

Native control registers authenticated cancellation at a shared priority gate before blocking-worker scheduling. Queued cancellation precedes ordinary worker completion; the store rechecks session revocation, expiry and generation after admission. Already-entered transactions are not preempted. The native regression proves this order over actual sockets/pipes, without claiming a measured p95 latency or resolving pre-authentication connection exhaustion.

Task-ledger schema v2 uses an explicit backed-up migration from the unchanged v1 source. Normal v1 open requests migration instead of silently changing data. Unresolved effects/publication block migration; witness/state gaps require read-only recovery. The independent installation-identity schema and task/control wire contracts remain unchanged.

The supervisor's executable fixture is an immutable-input probe, not a model worker: checkpointed tasks retain unmet user acceptance criteria and never become SUCCEEDED. Nine added process-kill boundaries exercise claim, yield, checkpoint and migration without replacing earlier faults.

## CORE 07 — foreground host and fixed child lifecycle

[CORE-07](process-host.md) composes protected ledger directories, explicit enrollment, authenticated native control and an optional separate-process fixed probe in the `tada-agentd` executable. The private single-request worker protocol bounds input/output and binds task, nonce, fence and contract hash. A complete reply and actual owned-process exit/cleanup are both required before checkpointing or safe retirement. Graceful shutdown may yield this known pure worker; faults park it without automatic respawn. Cancellation after spawn but before admission sends no assignment, confirms cleanup and leaves unrelated control available.

The Windows demo retains normal local-drive path syntax without relaxing existing namespace/owner/ACL checks. Linux parent-death handling and Windows Job Objects cover this trusted fixed worker's lifecycle, not a universal filesystem sandbox or arbitrary process-tree recovery. Normal and feature-only lifecycle regressions are both required in Linux/Windows CI. The thirteen-case fault matrix remains fixed, with extra exact-boundary cancellation and output-limit tests; per-commit results and any failures are recorded in the PR rather than inferred from compilation.

Public task/control contracts, the preserved design and task/identity schema versions are unchanged by CORE-07. The ordinary foreground demo uses session-only authentication. Existing real-vault suites do not establish every persistent CLI flow, physical reboot behavior or end-user service installation.

## Next core / SEC-01 integration

The reviewed worker-scoped policy/grant admission and versioned Rust/TypeScript digest interface are implemented in SEC-01A and ENGINE-01A. Keep CPU-heavy work and external I/O outside store locks and preserve cancellation-first admission when adding real tools. General workers need independently verified containment and stop/reaping recovery; the fixed probe's retirement rule is not a license to steal expired live assignments. Installed-service packaging remains separate from explicit foreground operation.

Follow-through includes recurring IANA-time-zone/occurrence/catch-up contracts, decision-response priority, general resource locks, rich engine checkpoints, production recovery export/restore, parent/child and provider-aware budgets, and notifications coupled to ART-01 publication. None is implied by the fixed probe or in-process admission gate.

## Provider proof — separate gate

With explicit user authorization, verify official app/account eligibility, authentication, one inference request, tool-call completion, refresh/re-authentication and cancellation. Subscription and API-key paths remain distinct. Do not silently use another CLI's token, browser cookies, a borrowed client ID or a paid fallback. Record official source/version/date and observable evidence without credentials.

## ART 01 — first user result end to end

Input snapshot → isolated staging → file generation → independent verification → immutable artifact → durable publish intent → destination re-read → result/outbox commit. Kill at every boundary. Detect original-file changes and preserve user edits. A verified action or supervisor checkpoint is not a verified, published user artifact. Connect the TypeScript model loop and request/result UI through these existing boundaries.

## Later product scope

Managed browser, Windows native automation, Linux core parity, optional macOS bridge, signed packaging/updates and full safety/quality evaluations follow their original dependencies. No empty placeholder package stands in for implementation or evidence.

## ENGINE-01A — duplex digest integration

The actual Rust and TypeScript process paths are specified in [engine-duplex.md](engine-duplex.md). This joins the existing host-owned channel to a bounded propose/authorize/invoke/replay/final exchange without replacing the task/control/worker schemas. It remains a model-free fixed read probe; general model planning, provider adapters, file actions, artifact verification/publication, packaged runtime integrity and independent security review are separate gates.

## MODEL-01A / ENGINE-01B — normalized mock streams and bounded controller

[Model streams](model-streams.md) adds a separately versioned event schema with generated Rust/TypeScript types and shared conformance fixtures. The collector withholds calls until completion and EOF; the controller enforces finite requests/tools/recovery/time, rejects changed scope, preserves observed/unknown usage, distinguishes waiting reasons and refuses automatic retry of ambiguous tool outcomes. A feature-only actual Node path uses the unchanged Rust digest broker and preserves committed evidence when a later model stream fails. No real provider account or inference is used.

These controller meters and classifications are session-local. The Rust admission/storage portion of the next gate is implemented separately below; the controller has not yet been connected to it. Persisted WAITING wake conditions, encrypted continuation and live provider serializers/conformance must be connected before production inference. A mock stream parser and a pure-probe checkpoint do not complete the original MODEL 01 or ENGINE 01 release gates.

## MODEL-01B — durable host inference observations

[Inference ledger](inference-ledger.md) persists exact mock inputs, lifetime model-turn admission, shared action/model cost reservations, cumulative usage, immutable receipts and predecessor-linked observation checkpoints. Same-ID replays return stored observations rather than another execution ticket. Reopen retains unfinished requests as unknown and blocks fresh inference until observation. Late receipts can settle cost without accepting cancelled, expired, policy-invalid or previous-generation output.

A separate explicit backed-up v2 → v3 semantic transition protects the new budget calculation from older binaries. Ordinary stores remain v2 until enabled by the trusted host; task/control/worker/model wire schemas and installation identity are unchanged. The fixed inference route does not execute a provider or tool, and no new operation is exposed through current UI/worker RPC. Nine inference and three migration kill boundaries exercise commit gaps without weakening earlier regression gates. Over-budget caller input is rejected without poisoning a valid store or consuming a turn; maximum-safe-integer accounting and pre-admission cancellation have public-API regressions.

Next integrate the existing TypeScript controller through separately versioned model-request/observation/checkpoint envelopes. Require acknowledged durable observations before the next model turn, bind actual tool-result lineage, and persist waiting/wakeup, failure state and active-time accounting. Then verify live-provider credentials, prices, hard/soft limits, encrypted context and continuation under explicit authorization. The current ledger is not a resumable conversation, a general cost estimator, an installed model daemon or ART-01 publication.
