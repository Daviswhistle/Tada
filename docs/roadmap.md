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

Remaining CORE-02 integration: installed supervisor and scheduled/priority queue, OS boot identity and general resource leases, rich checkpoints, production recovery export/restore handling, hierarchical/provider-aware budgets, and successful-result delivery coupled to ART-01. The mock currently invalidates every previous generation on open and forbids retransmission rather than implementing all safe-retry cases. Quarantine after a witness/state mismatch is a safety fallback, not successful automatic recovery. Fixed process-kill cases are not the 1,000-injection release gate or a latency/power-cut qualification.

## CORE 03 / CORE 04 — control integration substeps

[CORE-03](control-protocol.md) supplies authenticated bounded commands and atomic logical request replay. [CORE-04](native-ipc.md) binds them to Linux Unix sockets and Windows named pipes, with peer identity checks, absolute I/O deadlines, bounded sessions and a separate-process fixture. Session-only key transfer remains available through an inherited anonymous pipe. Unsupported OSes reject native endpoint creation while allowing the portable workspace to compile.

## CORE 05 — persistent installation identity

[CORE-05](installation-identity.md) adds the trusted-host `crates/credential` module: explicit RESERVED/ACTIVE enrollment, Linux Secret Service and Windows Credential Manager adapters, private installation metadata, a daemon lifetime lock, authenticated runtime discovery and generation-pinned native connection. The original task DB and command contracts stay unchanged. Missing or altered active keys block load/bind/reconnect; an interrupted reservation requires explicit finish, with lookup before creation. Tests distinguish private mock-vault conformance from isolated native-vault process tests.

This closes the library-level persistent bootstrap/discovery slice, not complete packaging or independent security review. Human-facing enrollment and recovery, stable default launcher paths, key rotation/live durable revocation, bounded stale-runtime retention and platform reboot qualification remain. Existing in-memory sessions are not instantly revoked by deleting a vault item. No installation credential is a worker capability.

These substep names do not replace the original work breakdown or complete stage 1. Next implement the supervisor/queue and cancellation priority on the durable store, then integrate reviewed SEC-01 worker authority before any real external tool.

## Provider proof — separate gate

With explicit user authorization, verify official account/registration eligibility, authentication, one inference request, tool-call completion, refresh/re-authentication, and cancellation. Subscription and API-key paths remain distinct. Do not silently use an existing CLI token file, browser cookies, a borrowed client ID, or a paid fallback. Record official source/version/date and observable evidence without credentials.

## ART 01 — first result end to end

Input snapshot → isolated staging → file generation → independent verification → immutable artifact → durable publish intent → destination re-read → result/outbox commit. Kill at every boundary. Detect original-file changes and never turn unverified staging into a completed result. Only then attach the TypeScript model loop and thin request/result UI.

## Later product scope

Managed browser, Windows native automation, Linux core parity, optional macOS bridge, signed packaging/updates, and the design's full safety/quality evaluations follow their original dependencies. None is represented by empty placeholder packages.
