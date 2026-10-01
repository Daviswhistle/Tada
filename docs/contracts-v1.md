# CORE 01: executable contract decisions

Status: proposed v1 wire foundation, not a released ABI. Basis: supplied design v1.0 dated 2026-09-30; implementation decisions recorded 2026-10-01. No source text has been corrected, reconciled, or replaced in the [original](design/source-2026-09-30.md). Its SHA-256 is checked by the test suite.

## Source-to-implementation map

| Contract | Design basis | Implemented boundary |
| --- | --- | --- |
| `TaskContract` | §7 | Goal, input snapshots, deliverables, required criterion IDs, scoped external effects, budget, policy profile, assumptions, optional deadline |
| `TaskSnapshot` | §8 and §23 | Separate execution/result axes, cancellation epoch, unresolved actions, unmet criteria, waiting reason and wake condition |
| `ActionRecord` | §10 and Appendix D | Immutable payload reference, request identity, policy/cancellation/fence references, effect state, reconciliation verdict, acceptance state, receipts/evidence |
| `PermissionGrant` | §13 and §18 | Task-bound capability, resource/destination, purpose, authority provenance, expiry, policy revision, epoch and fence |
| `ProviderCapabilityManifest` | §6 and Appendix C | Explicit account route and observed capability metadata; verified claims require evidence references and a date |
| `ArtifactManifest` | §22 and Appendix E | Required criterion coverage, pass/fail/inconclusive, evidence, artifacts, known receipts, unresolved effects, and explicit incomplete criteria |

The source's §19 SQL is explicitly illustrative. This PR does not implement that SQL or introduce a single task `state` column. Nested structures and additional evidence fields are wire refinements documented here, not claims that they already appear verbatim in the examples.

## Execution and completion are two axes

`execution_status`: RECEIVED, READY, RUNNING, WAITING, VERIFYING, PUBLISHING, CANCELLING, CANCELLED, STOPPED.

`completion_status`: PENDING, SUCCEEDED, PARTIAL, OUTCOME_UNKNOWN, FAILED.

`STOPPED` and `PENDING` are implementation labels introduced for the two-axis representation; they are not extra user-facing outcomes. A stopped successful task has SUCCEEDED; ordinary cancellation has CANCELLED plus PENDING/PARTIAL/FAILED as appropriate. If important external effects remain unresolved, completion is OUTCOME_UNKNOWN even when execution is CANCELLED. The cancellation epoch must remain positive on a cancelled snapshot. Resuming work, tombstone persistence, and result derivation are future daemon responsibilities, not performed by these value validators.

WAITING requires a recognized reason and at least one observation time, wake event, or expiry. Non-waiting snapshots cannot retain stale wait metadata. SUCCEEDED requires STOPPED, no unresolved effects, no unmet required criteria, and a result manifest reference. The daemon must later resolve and validate that reference in its commit transaction; a nonempty reference alone is not evidence of completion.

## Action state, effect, and acceptance

The state enum remains the design's ten states. `APPLIED_MISMATCH` is a **reconciliation verdict**, not a new terminal action state. It requires ACKNOWLEDGED, a confirmed write effect, failed acceptance, a receipt, and observation evidence. It cannot be serialized as VERIFIED or as an uncertain effect.

VERIFIED requires CONFIRMED_APPLIED, passing acceptance, a receipt, and evidence. A verified mutation must have a confirmed effect. Read-only actions retain effect `none`; CONFIRMED_APPLIED then describes completion of the operation, not an external mutation.

UNCERTAIN requires an inconclusive reconciliation classification. For writes, its side effect is uncertain. CONFIRMED_NOT_APPLIED requires FAILED, no effect, and evidence. COMPENSATED must link a distinct compensation action; the broker must later check that it is distinct and independently authorized, because schema references do not establish identity or permission.

The transition graph is generated into both languages. It blocks direct UNCERTAIN→DISPATCHING and VERIFIED→DISPATCHING. FAILED→AUTHORIZED is only a **possible** retry path; a safe negative observation, the idempotency retention contract, identical immutable payload, and current authorization are all required at runtime. This PR does not implement automatic retry. The graph does not replace a transactional state machine.

The request payload is a content-addressed reference, not a mutable path or a hash without recoverable content. `method`, `endpoint`, `account_ref`, and `target` preserve request identity. Materialization, encryption, precondition comparison, idempotency-key construction/retention, and fencing enforcement remain future runtime work.

## Validation before types

JSON Schema Draft 2020-12 is the source of truth; schema identifiers are offline registry identifiers, not URLs to fetch. Objects reject unknown fields, optional fields may be absent but not null, and unsupported versions fail. AJV does not coerce values, remove fields, or add defaults. Rust's validator is built without HTTP/filesystem resolution features. Format checks are explicit in both implementations.

Generated types express structural shape; they do not encode every pattern, numerical bound, conditional, or current-policy rule. Use `parseContract` in JavaScript/TypeScript and `decode<T>`/`encode<T>` in Rust at boundaries, not raw type assertions or raw serde decoding. A Rust sealed trait binds each decoder to its own schema name. A deserialized or constructed struct still needs validation before it crosses a boundary.

Counters use the unsigned JavaScript-safe integer range 0…9,007,199,254,740,991; revisions and fences start at 1. Rust accepts mathematically integral JSON numbers such as `1.0`, matching JSON Schema, rather than rejecting an otherwise valid shared fixture. Timestamps are RFC 3339 date-times in UTC with a `Z` suffix. Nonempty text fields have a 16,384-character wire bound. The current illustrative budget schema caps a requested USD budget at 1,000,000; this is a conservative wire bound chosen here, not a provider limit or a measured product requirement. It must be revisited before a real budget ledger is frozen. `max_usd` is optional for routes without a dollar guarantee and is not a cost reservation or settlement ledger.

The generator supports a deliberately limited vocabulary. Unknown schema keywords and nonlocal references fail generation. Shape types are generated from a single schema; semantic cross-field checks still run at validation time. AJV strict required/type lints are relaxed only for conditional fragments that rely on their enclosing schema; schema validation and strict unknown-keyword checks remain enabled.

## Required-criterion coverage

For every artifact manifest, both runtimes compute the actual unmet required IDs from `required_criteria` and the verification records. Missing, failed, or inconclusive required records are unmet. Duplicate criterion records are rejected rather than allowing last-write-wins ambiguity. The supplied `unmet_required_criteria` must match exactly. `complete` also forbids unresolved effects. Optional criteria may fail without silently becoming required. `partial` must describe an actual unmet condition or unresolved effect.

Criterion IDs identify individual checks (for example `docx.opens` and `pdf.opens`), not just a generic method reused ambiguously across outputs. The runtime will still have to bind manifest requirements to the original TaskContract, verify evidence and artifact hashes in storage, and atomically commit publication plus the result outbox. Fabricated evidence IDs can satisfy shape checks but cannot satisfy that future completion gate.

## Permission and provider limits

The grant schema describes a one-action grant. An external-write grant binds a payload hash and destination. Broader predicate approvals remain a separate broker design task. The only authority provenance labels are user_request, user_decision, and local_policy; model/web/document provenance cannot issue a grant. A well-shaped grant is **not authentic** until the daemon looks it up and checks current policy, revocation, expiry, subject, resource identity, epoch, and fence.

All provider fixtures use `mock` and a fictitious model. No actual provider capability, subscription eligibility, client registration, token refresh, inference, image input, or paid fallback has been tested or enabled here. The supplied design's dated provider claims remain in the source document, not a current compatibility warranty. A real adapter must recheck official documentation and pass live authorized conformance tests before claiming support.

## Compatibility and unfinished gates

Both runtimes consume the same immutable fixture input for a PR. Their acceptance must match the expected verdict, valid inputs must survive typed roundtrips, invalid inputs must not be repaired, and diagnostics must not echo the secret canary. Regeneration is byte-checked in CI. Future breaking wire changes need a new version and migration cases; backward-compatible changes still need cross-language fixture coverage.

Not implemented: persistence, CAS, event transactions, durable cancellation, authenticated IPC, security sandboxing, policy evaluation, provider authentication, scheduling, tool execution, independent evidence collection, artifact publication, and notifications. No performance, power-loss durability, security review, or release-gate result is claimed by CORE 01.

## Validator references

Implementation references, checked 2026-10-01: [JSON Schema 2020-12](https://json-schema.org/draft/2020-12), [AJV draft support](https://ajv.js.org/json-schema.html), [Rust jsonschema](https://docs.rs/jsonschema/0.58.3/jsonschema/). These explain validator behavior, not Tada product guarantees.
