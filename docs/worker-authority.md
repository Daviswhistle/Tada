# SEC-01A — host-bound worker authority admission

This is the first executable policy/grant slice of the original SEC-01 work item, stacked after CORE-07. It implements a transport-neutral library boundary for one read-only tool. It does not complete the design's entire security broker or turn the fixed process probe into a model agent. The supplied design and existing task/control v1 schemas remain unchanged.

## Source mapping

| Design requirement | Implemented slice |
| --- | --- |
| Sections 5 and 13: workers propose, daemon owns authority | Policy/channel installation is trusted-host Rust API only; serialized worker input cannot set either |
| Section 13.2: DENY, ALLOW, REQUIRE_DECISION, HANDOFF | Exact-rule evaluator; explicit deny first, then task/catalog intersection; only ALLOW issues a grant |
| Sections 14.2 and 18.3: provenance and scoped grants | Host-retained channel, task/resource/purpose/version binding, durable policy revision, generation, epoch, fence and expiry |
| Sections 9, 18.3 and 23: durable admission and cancellation | Grant issuance, invocation result and revocation use the existing witnessed event transaction; current authority is checked again before commit |
| Appendix A: shared Rust/TypeScript contracts | Separate worker-v1 schema, deterministic generated types, common explicit-value fixtures and typed decoding |

The policy profile, digest-tool name, exact rule semantics, worker-v1 field layout, 64-call/channel ceiling and 60-second maximum TTL are implementation choices for this slice, not externally measured limits or verbatim design examples.

## Deliberately narrow executable capability

Only `task.contract_digest` version 1 is registered. It reads the immutable contract digest for its own current task assignment. Its resource is exactly `task://<task_id>/contract`, its purpose is `verify_input_snapshot`, and its `expected_hash` must match the authoritative task contract. Prefixes, wildcard rules and path normalization do not expand that resource. The broker-owned catalog declares a read effect and no network use; the catalog digest is bound into stored grants.

An ALLOW rule does not register a new tool. File access, process execution, credential export, policy self-modification, desktop actions and arbitrary arguments remain unavailable even if a policy fixture names them. A successful digest read neither changes task completion nor clears acceptance criteria, consumes model budget, publishes artifacts or creates a result notification. Its evidence reference identifies a recorded digest read, not proof that a user goal is complete.

## Trust and invocation path

The trusted host installs a validated `WorkerPolicy` for an existing task whose `policy_profile_id` matches. Origin is restricted to user_request, user_decision or local_policy, but that string is provenance, not authentication. Never pass document/model-authored policy objects to the host API merely because they validate. The authenticated UI control router is unchanged: it still does not expose policy/channel/grant creation or worker invocation.

The host opens a fresh `WorkerChannel` from a live `WorkLease`. The channel is opaque, non-deserializable and tied to the store, task, supervisor generation, host-policy revision, cancellation epoch, queue fence, contract hash and monotonic deadline. The host must retain it with the protected connection. A worker-supplied subject or grant ID cannot reconstruct this handle. Reconciliation-only assignments have no execution channel. A clone shares the same durable revocation.

The host evaluates a complete `WorkerProposal`, then persists one `WorkerGrant` only on ALLOW. The descriptor is a reference, not a bearer credential: invocation must also present the host-retained channel, and the broker looks up its own grant record. Grants bind the normalized proposal hash, capability version, resource, purpose, current policy and catalog digests, generation, epoch and fence. Changing any bound input cannot reuse the grant.

For this registry, the decision precedence is explicit denied_tools, task/catalog rejection, then matched DENY, HANDOFF, REQUIRE_DECISION, ALLOW. No matched permission yields REQUIRE_DECISION. Non-ALLOW results contain no grant and perform no execution. HANDOFF and REQUIRE_DECISION are typed outcomes only; this slice does not create an approval UI, authorize a follow-up, or initiate an OS authentication prompt.

## Expiry, revocation, replay and cost

Expiry enforcement uses the owning store's monotonic Instant, bounded by the channel and queue lease. The worker-visible expires_at_ms is informational UTC metadata; changing the wall clock cannot extend the monotonic lease. Every store reopen changes generation, so previous channels/grants cannot be revived or reconstructed from saved JSON. New generations must open new authorized channels. Durable policies survive reopen; expiring execution authority does not silently reset policy revisions.

The same channel/call_id and unchanged proposal resolve to the original grant while it remains valid. Repeating authorization does not refresh its expiry. A policy update requires a strictly greater revision, except an identical idempotent update. A new revision invalidates old grants; it cannot silently give an earlier call new approval. Channel call capacity is reserved at issuance; revocation does not refund it. This is a per-channel call bound, not hierarchical budgets, provider pricing or an OS resource quota.

The current read-only invocation runs under the store owner and records one result inside the existing state transaction. The admission check rereads cancellation, live queue/run ownership, generation, fence, host policy, grant/channel revocation and monotonic expiry. A lost response can be replayed with a new RPC id without another invocation/result event. Replay still requires current authority: cancellation, expiry or revocation prevents disclosure to the old channel even if a result was previously committed. Public UI historical-command replay retains its separate existing semantics.

A grant or channel can be revoked idempotently through the trusted host without deleting its record or a committed result. Cancellation keeps the existing task tombstone and blocks both new grants and invocation. Nothing compensates an external effect; this capability produces none. A future writing adapter must use the existing ActionRecord/attempt/reconciliation ledger, not assume this read-only transaction makes an external service atomic.

## Wire and persistence boundaries

`packages/contracts/schema/worker.v1.json` is the new offline source of truth. `npm run generate` generates `crates/contracts/src/worker.rs` and `packages/contracts/src/generated/worker.ts`; `npm run check` checks both old and new outputs. WorkerPolicy, Proposal, Grant, Authorization, Call, Request, Result and Reply have closed schemas. Positive and negative fixtures include policy provenance, unknown fields, limits, incomplete authorization and mathematically integral 1.0 counters.

The raw Rust worker-input boundary rejects duplicate keys before schema decoding, as well as partial/trailing JSON and requests larger than 16,384 bytes. It accepts only a complete JSON-RPC 2.0 `tool.invoke` request with an ID; no batches or notifications are enabled. Successful replies are bounded to 4,096 bytes. Runtime denials are static Rust error codes; a future transport must map errors into a reviewed error envelope without echoing payloads. JavaScript object validation does not claim to detect duplicate keys already discarded by JSON.parse; raw worker input is currently parsed by the Rust boundary.

Policy, channel, grant, invocation and revocation records use namespaced events in the existing append-only event journal. No task/identity DB migration, new dependency or lockfile change is required. Record lookups validate their shape/bindings; detected corrupt policy or invocation records poison the handle and prevent further mutations. This is not a complete startup scan of all new security records, a cryptographically authenticated log or a production-scale indexed approval store.

The independent witness retains its conservative ordering. A crash after witness append but before the state commit requires read-only recovery. This is intentional quarantine, not successful automatic replay. Restoring both journal and witness together still requires independent surviving evidence as documented in CORE-02. No worker-side result text can erase cancellation or make an old generation current.

## Verification commands and fixed denominator

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --nocapture
cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
cargo test --locked -p tada-store control::worker:: -- --nocapture
```

The two runtimes consume 41 identical explicit-value worker cases in addition to the unchanged original contract cases. Broker tests cover four-way decisions, conflicting rules, scope/capability substitution, borrowed grant references, changed bindings, idempotence, policy revisions, grant/channel revocation, cancellation before issue/invocation, monotonic expiry, stale fences/generations, bounded call capacity, raw malformed input, result-write rollback and corruption handling.

The fixed nine-case process-kill matrix kills a real child before, between witness/state commits, and after committed grant issuance, invocation and revocation. Reopening must preserve exactly the committed records or quarantine the gap, never revalidate old grants. These are regression samples, not the design's 200-adversarial-case, 1,000-injection, cancellation-percentile or power-cut release gates. Consult the PR's exact commit and CI run for observed pass/fail results; source preparation and formatting alone are not test evidence.

## Next integration

Wire the broker into a versioned duplex engine/tool process connection that retains the host channel, bounds request queues and honors cancellation-prioritized store admission. The existing CORE-07 fixed probe still uses its original private pipe protocol; the TypeScript model engine and its transport are not implemented by these generated types. Do not advertise end-to-end worker RPC until that separate process integration is tested.

A later SEC-01 slice must add authenticated human policy/approval management, scope predicates and resource handles, real-tool admission, destination/egress and amount checks, reviewed caller registration, grant delegation/parent limits, policy startup audit and indexed projections. Actual file/process/browser tools, OS sandboxing, provider authentication, ART-01 result publication, UI and installed services remain distinct gates. Same-user unrestricted host access is outside this broker's enforcement boundary.

## Follow-through: ENGINE-01A

The subsequent [duplex integration](engine-duplex.md) retains the opaque channel in the parent and calls this broker from a real child-pipe exchange. The original SEC-01A library boundary above describes its initial slice; the built-in and TypeScript demonstration paths now exercise it across processes. Neither path exposes host policy installation or channel issuance to worker JSON.
