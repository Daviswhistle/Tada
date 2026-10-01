# Implementation gates

This is an execution order, not a release-date promise. The supplied design's §32 and Appendix F remain the basis.

## CORE 01 — contract foundation

Schema and transition sources, generated Rust/TypeScript types, fail-closed value validation, shared fixtures, preserved design, and CI. A green contract suite is not “stage 0 complete”: provider authentication evidence and an independent threat-boundary review remain open.

## CORE 02 — durable mock execution

The first executable slice is in `crates/store`, with exact implementation boundaries and fixed fault cases in [CORE-02](core-02.md). It provides SQLite state/event CAS, a separately durable restore witness, OS store ownership, supervisor-generation leases, cancellation/dispatch serialization, an independent non-idempotent mock, integer reservations and a stopped/decision outbox. It does not complete the entire stage-1 daemon.

The original review scope remains:

1. SQLite WAL and synchronous FULL; state/version CAS plus event append in one transaction; foreign keys and state constraints; one active run; read-only recovery when invariants fail.
2. Single daemon ownership, boot identity, scoped leases and monotonic-time fencing. A stale owner cannot admit a new dispatch.
3. Cancellation epoch and durable tombstone serialized against dispatch admission. An already admitted in-flight operation may finish after cancellation; reconciliation observations may continue, new effects may not.
4. Immutable action payload, append-only attempts, receipts, and explicit reconciliation. The mock service must save an effect and drop its response. Restart must not create a second effect or invent a success.
5. Budget reservations (including uncertain usage), recovery checkpoints, and result notification outbox. Do not implement a floating-point money ledger from the illustrative wire budget.

Required fault cases include kill-before/after admission, response loss, revoked cached grant, concurrent cancellation, stale fence, an applied mismatch, unknown outcome after cancellation, disk-write failure, and backup restoration after an external effect. Count fixed cases; do not shrink the denominator to make a gate pass.

Remaining CORE-02 integration: authenticated local IPC and request deduplication, installed supervisor and scheduled queue, OS boot identity and general resource leases, rich checkpoints, production recovery export/restore handling, hierarchical/provider-aware budgets, and successful-result delivery coupled to ART-01. The mock currently invalidates every previous generation on open and forbids retransmission rather than implementing all safe-retry cases. Quarantine after a witness/state mismatch is a safety fallback, not successful automatic recovery. Seven process-kill boundaries and sixteen races are not the 1,000-injection release gate or a latency/power-cut qualification.

## Provider proof — separate gate

With explicit user authorization, verify official account/registration eligibility, authentication, one inference request, tool-call completion, refresh/re-authentication, and cancellation. Subscription and API-key paths remain distinct. Do not silently use an existing CLI token file, browser cookies, a borrowed client ID, or a paid fallback. Record official source/version/date and observable evidence without credentials.

## ART 01 — first result end to end

Input snapshot → isolated staging → file generation → independent verification → immutable artifact → durable publish intent → destination re-read → result/outbox commit. Kill at every boundary. Detect original-file changes and never turn unverified staging into a completed result. Only then attach the TypeScript model loop and thin request/result UI.

## Later product scope

Managed browser, Windows native automation, Linux core parity, optional macOS bridge, signed packaging/updates, and the design's full safety/quality evaluations follow their original dependencies. None is represented by empty placeholder packages.
