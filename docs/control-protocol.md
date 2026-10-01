# CORE-03: local control protocol and durable request replay

Status: transport-neutral protocol implementation on top of CORE-02, **not a native IPC listener or a complete SEC-01 broker**. CORE-03 is an implementation substep name, not a replacement for the original work breakdown. The supplied design is unchanged; its §18.3 is the basis for bounded messages, nonce authentication, durable request identity and sequence-based event reads. Native socket/pipe protections and daemon scheduling remain required.

## Public boundary and scope

`Store::control_handle` accepts an authenticated binary frame plus an opaque established session. It exposes only these JSON-RPC 2.0 methods:

| Method | Required parameters | Access | Durable behavior |
| --- | --- | --- | --- |
| `task.submit` | `request_id`, validated `contract`, `budget_micro_usd` | Controller | Create task and original command result in one state transaction |
| `task.cancel` | `request_id`, `task_id` | Controller | Cancel, revoke mock grants/runs, outbox and original command result in one state transaction |
| `task.get` | `task_id` | Controller or Observer | Return the current checked task snapshot |
| `task.events` | `task_id`, `after_seq`, `limit` (1–64) | Controller or Observer | Read task snapshot events after an exclusive sequence cursor |

Neither role is a worker grant. Controllers are trusted local-user frontends and can submit/cancel tasks; observers can read all tasks of this single-user store. Do not hand either credential to an untrusted document, website, model or plugin. A task's submitted scope does not manufacture actual tool approval. No method dispatches a tool, changes policy, issues a grant, accesses credentials, executes SQL or starts a shell. The existing store-only mock APIs stay within the trusted host boundary.

All requests require a string transport `id` and object `params`, with no unknown fields. Mutations also require a logical `request_id`. Notifications are unsupported: an object without an ID closes the control session without a JSON-RPC response and is never executed. Batch requests and unsupported methods are rejected. Protocol errors use fixed codes/messages rather than echoing invalid field values. The transport ID is deliberately echoed for request correlation and must not carry a secret.

The authoritative JSON Schema adds `ControlRequest` and method-specific parameter definitions without changing the existing CORE-01 definitions. Rust/TypeScript shapes are regenerated from that source and both validators consume 24 additional shared positive/negative cases. Shape validity is still not authentication. The Rust ingress parser rejects duplicate object keys at every depth, including escaped aliases, before schema validation; partial/trailing/overdeep JSON is not salvaged into a command.

## Mutual authentication and frames

The trusted host provisions a separate random 256-bit credential for each principal/access pair. `Credential::generate` obtains OS randomness; `from_secret` is an explicit trusted-bootstrap API, not a request-field conversion. Credentials and sessions have no Debug/Serialize implementation. The implementation does not read other applications' tokens, expose a secret-file API, or place keys in the DB, diagnostics, environment or RPC bodies.

The server challenge binds protocol version, store identity, current supervisor generation, authenticated principal, role and a fresh server nonce. The client checks a store ID learned through trusted bootstrap, adds its own nonce, and proves the transcript using domain-separated HMAC-SHA-256. The server checks the proof with the library's constant-time verification, returns its separate proof, and derives a session key. A pending challenge is consumed even on failure. The client verifies the server proof before creating its usable session.

Each authenticated frame has a big-endian 32-bit length, a big-endian 64-bit sequence, a JSON body and a 32-byte MAC. MAC inputs include the length, sequence and body with explicit lengths and distinct request/response domains. Repeated, reordered, reflected, truncated, oversized or modified frames close that session. JSON body size is capped at 65,536 bytes. Handshake lifetime is 10 seconds; session lifetime is 300 seconds and at most 4,096 messages in each direction. These are chosen protocol bounds, not measured performance results. Expiry is monotonic. Store reopen changes the supervisor generation and invalidates old sessions.

Credential revocation is shared by established server sessions that came from that in-memory credential; it is checked before requests and again for new command admission. Individual sessions can also be closed. This is **not durable installation-key revocation**, a key-rotation service, perfect forward secrecy, memory zeroization or an independently audited authentication design. HMAC authenticates frames but does not encrypt their bodies.

No OS transport is opened. UNIX 0600 socket permissions and peer-UID checking, Windows named-pipe SID ACLs, safe path/endpoint ownership, protected secret provisioning/persistence and connection limits/timeouts are prerequisites for a real listener. Generic `Read`/`Write` frame helpers bound allocation but cannot impose OS deadlines; a slow reader must not be allowed to hold up cancellation. Never expose these helpers as a raw TCP/HTTP service and describe it as secure local IPC. The single-user compromised-host limitation of the original design remains.

## Logical request identity and atomicity

The replay key binds the **authenticated** principal and `request_id`; the fingerprint binds method and validated normalized parameters. The JSON-RPC transport `id` is excluded, so a reconnect can use a new correlation ID while keeping the same logical request. Validated Rust decode/encode normalizes integral JSON counters such as `1.0` to the same integer representation as `1`; it does not coerce strings, drop unknown fields or add authorization defaults. Object key order and whitespace do not change request identity. Changing the target, method, goal, scope, budget or other parameters under the same request ID returns `REQUEST_ID_REUSED` without altering the task.

The command result is appended as a versioned `control.completed` record in the existing immutable event journal, inside the same state transaction as task creation/cancellation and its task event/outbox. There is no second cache commit after the mutation. The owner rechecks for a prior record within admission. A replay returns the original result without a new task event, cancellation epoch, notification or witness increment. Successful results and deterministic `TASK_EXISTS`/`TASK_NOT_FOUND` rejections are preserved; a formerly rejected request does not turn into a new operation merely because the task later appears. A new intended operation needs a new request ID.

Responses to mutations explicitly say `semantics: original_command_commit`. They are historical receipts, not a claim about the current task. Replaying the original submit after cancellation can return its original READY receipt while `task.get` correctly returns CANCELLED. Replaying never revives cancelled work, erases unresolved effects, unreserves unknown cost or marks the whole task successful.

The unchanged CORE-02 witness commits before the primary state transaction. A crash after command commit but before delivery replays the saved result. A crash before admission can be retried. A crash between witness and state commit requires read-only recovery, not guessed success or a new mutation. Database errors or replay-record corruption poison the current store handle and close its control session; ordinary invalid input or authentication failure does not poison unrelated legitimate sessions. Existing audited reopen behavior is not a general corruption-repair facility.

This slice reuses the event journal to avoid an unreviewed DB migration. Replay lookup is a bounded-result but potentially linear scan; command receipts are retained with that journal and must not be pruned without a future retention/tombstone contract. A dedicated indexed request table, journal-retention policy and restore-aware migration are still needed before production-scale traffic. The owner lock and transaction serialize writers; this is not a multi-host exactly-once protocol. External mutations retain CORE-02's separate admission/observation contract.

## Event and output bounds

`task.events` returns only checked `task.*` snapshot events for the requested task. It never returns control receipts, authentication data, arbitrary event payloads or another task's records. The cursor advances only through returned events. Count and encoded-byte limits bound each response. A current snapshot or a single event that cannot fit returns a fixed size error; it is not truncated into a misleading partial snapshot. Mutation receipts contain only a compact state summary so even a task created through the trusted API with a very large criterion list can still be cancelled through control.

The event cursor is valid in the current audited store history. It is not a durable subscription service or a cursor portable across manual restoration/replacement of both journals. No task-list pagination, live stream, UI reconnection loop or secret-bearing event channel is enabled here.

## Verification and reproduction

Run the normal suite and two independent mock examples:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --nocapture
cargo run --locked -p tada-store --example recover_mock -- ./new-effect-demo
cargo run --locked -p tada-store --example control_replay -- ./new-control-demo
```

Both example destinations must be new directories. `control_replay` authenticates in memory, discards a submit reply, reopens the store, reauthenticates, replays submit/cancel and observes the current CANCELLED state with epoch 1. Its fixture credential stays in memory across the simulated store reopen; this is not proof of cross-process secret persistence or native IPC.

New regression tests cover wrong client key and server proof, nonce/identity/role binding, session expiry/revocation/generation, tampering and frame replay/reordering/reflection, bounded framing, duplicate JSON keys, command replay and payload conflicts, read-only access, forbidden methods, old receipts versus current state, persistent business rejections, simultaneous duplicate submissions, cancellation with an uncertain mock effect, receipt-write rollback, corrupt receipt detection, large snapshots and event cursor isolation.

The actual process-kill matrix fixes **six scenarios**: submit and cancel at each of before-admission, witness-before-state-commit, and command-commit-before-reply. A parent process kills and reaps a child at each boundary and tests the reopened state. The existing seven CORE-02 effect boundaries and sixteen cancellation/admission races remain in the suite. These cases are not the design's 1,000-injection release evaluation, an independent security review, an OS service test or a physical power-cut qualification.

## Next integration

Native UNIX/Windows transports with peer checks and protected bootstrap must bind this protocol to real frontend processes. Installed supervisor, scheduler/queue, broader resource leases, worker-scoped SEC-01 grants, provider credentials, production recovery, encrypted data and ART-01 remain separate gates. A green protocol test cannot substitute for any of them. Keep the endpoint closed until its platform-specific protection and cancellation behavior have their own evidence.

API references checked 2026-10-01: [JSON-RPC 2.0](https://www.jsonrpc.org/specification), [RustCrypto hmac 0.12.1](https://docs.rs/hmac/0.12.1/hmac/), [getrandom 0.3.4](https://docs.rs/getrandom/0.3.4/getrandom/fn.fill.html). These establish library/protocol contracts, not a third-party security certification for Tada.
