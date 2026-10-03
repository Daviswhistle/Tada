# ENGINE-01A: bounded duplex worker integration

This slice connects SEC-01A's host-owned worker channel to actual child-process pipes. It exercises the task/engine/tool separation in design §§5, 11, 18 and 23, without replacing the preserved design, task/control/worker-v1 schemas, DB versions or dependency locks. This is a deterministic input-digest probe, not the complete ENGINE-01 model/recovery loop.

## Executable paths

From the repository root, after installing the exact `.node-version` and `rust-toolchain.toml` versions and running `npm ci --ignore-scripts`:

```sh
cargo run --locked -p tada-agentd --bin tada-agentd -- demo-engine ./new-duplex-demo
cargo run --locked -p tada-agentd --bin tada-agentd -- demo-typescript ./new-typescript-demo ABSOLUTE_PATH_TO_PINNED_NODE
```

Use a new directory for each demonstration. Both paths use disposable task data and explicitly session-only UI authentication. They install no service, enroll no OS-vault key, and invoke no model, network tool, shell command or external account. `demo-engine` starts the built-in Rust protocol reference worker; `demo-typescript` starts `packages/engine/src/stdio.mjs`, which imports and executes the checked-in `session.ts` using Node's native erasable-type support. CI type-checking is separate from runtime type stripping.

The TypeScript command requires a user-supplied absolute executable path and checks the exact pinned Node version in the child. It does not resolve product runtimes from PATH, download a runtime, or claim that an arbitrary executable reporting that version is authentic. The script path is fixed to the checked-out source location. Runtime signatures, bundled runtime/worker manifests, installation relocation and packaged-resource integrity are subsequent release gates. This developer command must not become an untrusted model-selectable process tool.

The existing `demo`, `serve` and `serve-probe` behaviors remain separate. Persistent foreground serving does not automatically install the demo policy or enable the new digest engine.

## Protocol and authority

The protocol uses existing worker-v1 schema types in a fixed phase order. Each frame is a nonempty UTF-8 JSON document preceded by a four-byte big-endian length, capped at 16,384 bytes. The broker's invocation reply remains capped at 4,096 bytes. No partial JSON or trailing fragment is interpreted as a command.

| Phase | Sender | Schema and meaning |
| --- | --- | --- |
| Bootstrap | Host | `WorkerProposal` identifies the fixed task digest and per-assignment call ID; not a credential |
| Propose | Child | `WorkerProposal`; the host validates the whole message and current scope |
| Authorize | Host | `WorkerAuthorization`; only ALLOW carries the broker's recorded `WorkerGrant` |
| Invoke | Child | `WorkerRequest` / `tool.invoke`, using that grant and immutable proposal |
| Return | Host | `WorkerReply`, only after the broker commits its call result |
| Replay | Child/host | Same logical call with a new RPC ID; current authority remains required |
| Finish | Child | Exact last `WorkerResult`, followed by EOF and successful process exit |

This is a phase-bound development protocol, not a generic parallel provider stream, a newly negotiated engine envelope or a human approval RPC. All typed messages use the existing generated Rust/TypeScript definitions. The child never provides the opaque `WorkerChannel`; the parent retains it alongside the owned pipes and supplies it to the broker. Policy installation and channel creation remain host-only APIs.

The one executable tool remains `task.contract_digest`, with the exact task resource, purpose and expected input hash from SEC-01A. The explicit demo installs one matching local policy, with one-call capacity and a finite grant lifetime. A proposal cannot register another tool, change its effect, access another task, supply a policy, or treat a grant reference as a bearer credential.

The Rust ingress exposes a bounded unique-key decoder before schema validation. The TypeScript ingress scans raw JSON for duplicate keys (including escaped aliases), invalid Unicode/UTF-8, partial/trailing documents, nonfinite numbers, depth and size limits before parsing. Object schema validation alone does not detect duplicates that JSON.parse has already discarded. TypeScript errors are fixed codes and do not echo rejected message content.

## Bounded I/O and lifecycle

The exchange handles one frame at a time with awaited writes/backpressure. It accepts at most eight post-authorization frames; no unbounded per-call queue or log is created. Stderr uses the existing bounded discard path. The host's monotonic deadline and cancellation monitor span the entire exchange, so slowly delivered bytes or a valid final message followed by a hung child cannot prolong execution indefinitely.

The parent does not hold the store mutex while waiting for child I/O. Every authorization and invocation enters the existing cancellation-prioritized store admission gate and checks shutdown after waiting. Broker code then revalidates current task ownership, cancellation, scope, policy, expiry and revocation. An already-entered blocking store operation retains its permit until its actual closure exits even when its awaiting async future is dropped. Cleanup's channel revocation waits on that same gate rather than assuming an abandoned future means an abandoned DB operation.

After the exchange finishes or fails, the existing process runner terminates/waits for the owned process and, on Windows, checks that its job is empty. It then durably revokes the channel before retiring/reassigning work or recording a probe checkpoint. Cancellation that wins between OS spawn and the start record sends no assignment and still revokes the opened channel after cleanup. Storage/reaping failures stop the affected host path; a kill request or Drop is not evidence that work is safe to reassign.

Linux parent-death/process-group protections and Windows kill-on-close Job Object behavior remain as in CORE-07. These are lifecycle controls, not filesystem/network isolation. Node can create runtime threads, but this slice enables no child-process tool. The same-user process boundary does not prevent independent host access by malicious code; the fixed checked-in worker and explicitly chosen executable are within the demo's trust boundary.

## Results, replay and cancellation

Normal execution deliberately sends the identical immutable call twice using distinct RPC IDs. The host records one `worker.call_completed` event and returns the same evidence with the replay indicator on the second response. The final child claim must equal the host's actual last result; an invented evidence reference or exit code zero cannot produce a checkpoint. The host also requires EOF and confirmed process exit. The eventual checkpoint verifies this limited probe only: original user-task acceptance remains unmet and `completion_status` stays PENDING.

The `lost-reply` process fixture discards the first response only after the broker has committed. The child has pipelined another request for the same call; the second response must be a replay, not a new grant or invocation. There is no generic timer-triggered retransmission or automatic write retry. Process restart still invalidates the old channel generation; this fixture does not claim same-channel reconnection after death.

The synchronized `cancel-before-invoke` fixture pauses after a grant has been delivered and before invocation reaches admission. A real authenticated native control request commits cancellation, then the test releases the boundary. The cancelled task must produce no invocation/checkpoint, preserve its tombstone, and leave the same server available for an unrelated follow-up probe. Grant revocation immediately before invocation is tested separately. These are deterministic orderings, not cancellation latency measurements.

Non-ALLOW authorization is returned as `WorkerAuthorization` before the session is closed. Later invocation denials close this narrow session and produce a bounded host-side report. This slice does not invent a general worker error/retry envelope, display human approval dialogs, or silently convert REQUIRE_DECISION/HANDOFF into ALLOW.

## Verification commands and fixed cases

```sh
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --nocapture
cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
```

The ordinary suite includes the built-in duplex path and malformed bootstrap/invalid CLI cases. The already-mandatory `process-fixtures` suite additionally uses the actual pinned Node executable on the developer test PATH. Absence or mismatch is a test failure, not a silently skipped TypeScript integration. This PATH lookup belongs to test setup; the product command still requires an explicit absolute path. Both general CI jobs already install the pinned Node version and locked dependencies.

The new fixed thirteen-case process matrix covers wrong task, wrong resource, unregistered tool, duplicate fields, partial frame, oversized frame, changed authorized call, fabricated final evidence, excessive message count, trailing output, final-reply-then-hang, timeout, and revoked grant. A fault may preserve a previously committed digest read, but must never produce a probe checkpoint or a successful user-task result. Existing CORE-07 thirteen-case tests and all previous store/control/queue/broker kill cases remain enabled.

Separate integration functions exercise all three non-ALLOW decisions, response loss in both languages, native cancellation-before-invocation in both languages with same-host follow-up, real TypeScript environment canaries, and channel cleanup when cancellation wins before process admission. JavaScript tests cover raw parsing and the typed state machine independently. Nested cases and functions overlapping ordinary/feature runs are not counted as disjoint tests. Report actual final commit/OS evidence in the PR, not preparation or formatting as a passing runtime test.

## Next boundary

The next useful product work is the versioned model-event adapter and bounded execution/recovery loop, still with mock model streams before authorized live provider proof. General error/decision/checkpoint envelopes, real resource handles and write action admission, parent/child budgets, file staging and ART-01 verified publication remain necessary. A digest RPC or a child exit does not establish a useful completed user task. Provider authentication, independent security review, signed packaging and the design's release evaluation remain separate gates.

Implementation references checked 2026-10-04 (Seoul): Node's [TypeScript execution](https://nodejs.org/api/typescript.html), Tokio's [spawn_blocking cancellation behavior](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html) and [owned child lifecycle](https://docs.rs/tokio/latest/tokio/process/struct.Child.html). API documentation is not proof of Tada's runtime behavior; this repository's locked versions and CI are the execution evidence.
