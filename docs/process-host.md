# CORE-07: foreground host and fixed probe processes

This implementation continues the preserved design's §5.2, §9, §15.4, §18 and §23. CORE-07 is an implementation substep, not a new design stage or a claim that the entire first stage is complete. The original design, task/control wire contracts, task-ledger schema v2 and installation-identity schema are unchanged.

## Executable entry points

Build with the repository's pinned Rust toolchain. On Linux and Windows, `tada-agentd` accepts these explicit commands:

```text
tada-agentd init ABS_NEW_STORE ABS_NEW_IDENTITY
tada-agentd finish-init ABS_STORE ABS_IDENTITY
tada-agentd serve ABS_STORE ABS_IDENTITY
tada-agentd serve-probe ABS_STORE ABS_IDENTITY
tada-agentd request ABS_IDENTITY REQUEST_JSON_FILE
tada-agentd demo NEW_DIRECTORY
```

`init` creates a new protected task directory and explicitly enrolls an installation key in the current user's OS vault. `finish-init` resumes the existing enrollment without regenerating a missing active key. Existing directories are not overwritten or repaired. A failed initial setup can leave its explicit partial state; use the documented identity recovery boundary rather than deleting or replacing keys automatically.

`serve` runs foreground authenticated local control only. `serve-probe` also opts into a fixed, model-free input-hash probe. The host checks that the installation belongs to this task store, holds the protected directory and single-owner locks, and publishes the existing authenticated native discovery record. It does not install a service, auto-start task, shell profile or HTTP endpoint. Ctrl-C, and SIGTERM on Linux, stop further work and drain entered control requests and the owned probe before store release.

`request` reads a bounded JSON file before accessing the installation vault or connecting. The command uses existing task.submit/cancel/get/events contracts and preserves logical request IDs. Responses are serialized JSON rather than raw terminal-control bytes. No worker management, grant issuance, arbitrary SQL or shell RPC is added.

Persistent commands use the existing Linux Secret Service or Windows Credential Manager implementation. Their vault-unavailable and missing-key paths do not silently fall back to files. The ordinary demo uses a separate, explicit session-only credential and does not test the complete persistent init/serve/request flow. Isolated OS-vault tests remain distinct evidence, not proof of all CLI combinations or reboot behavior.

## Disposable demonstration

Use a new directory under an existing local parent:

```sh
cargo run --locked -p tada-agentd --bin tada-agentd -- demo ./new-process-demo
```

The demo owns a protected store, a native control listener and one separate fixed worker process. It submits and replays a request, cancels another queued task, executes the first input-hash probe, checks its response and OS exit, then stops the server. A successful demo prints a JSON report with a reaped worker, one checkpoint and zero live tools. Task completion remains PENDING with its original unmet acceptance criterion.

The demo resolves relative syntax without filesystem canonicalization, preserving ordinary local-drive syntax on Windows. Parent components are rejected before creation. The existing private-root validator still rejects unsupported UNC/device/verbatim namespaces, links/reparse objects and unsafe access controls. This is not a new general-purpose path sanitizer: the same guarded directory checks remain the authority.

## Child boundary and response validation

Only the host's own absolute executable with the fixed `--probe-worker` entry point is launched. The child has a private working directory and a cleared environment; Windows retains only SystemRoot. No installation/provider key, database path, user-supplied executable or shell command is passed by the host. The child receives a fresh nonce, task ID, queue fence and immutable canonical contract JSON through private stdin.

This is a Rust-only fixture protocol, not the later TypeScript engine protocol. It admits one length-prefixed request of at most 262,144 bytes and one response of at most 4,096 bytes. The response must bind the nonce, task, fence and independently expected contract hash. Empty, partial, oversized, trailing, unknown-field, duplicate-field and cross-assignment responses fail validation. Stderr is bounded to 4,096 bytes and discarded instead of becoming an unbounded file or terminal echo.

The runner requires both a complete matching reply/EOF and successful OS process exit before checkpointing. A correct reply followed by a hung process, or exit code zero with no reply, is insufficient. Input processing and pipe I/O occur outside the store mutex. Ownership checks use the shared admission gate, with an independent monotonic process deadline and shutdown signal. Probe checkpoints never clear the user's required acceptance conditions or produce SUCCEEDED.

## Cancellation, cleanup and ownership

Process-start and process-reaped observations are host-owned events in the witnessed ledger. A stored PID is diagnostic data, not authority to terminate a possibly reused PID during recovery. The runner waits on its owned child, and on Windows also checks the owned job is empty. A kill request, Drop or a timeout alone is not a reaping receipt. If cleanup cannot be confirmed, no queue-retirement call is reached.

The trusted-host retirement path checks exact store/generation/fence and a recorded reap, and refuses action history. A gracefully stopped known-pure probe can yield to READY after cleanup. Failed, malformed or timed-out probes park STOPPED/PENDING instead of automatically respawning. Expired live assignments are not stolen. Reconciliation work has no run/tool grant; without its target adapter this foreground host defers it without inventing evidence or resending a mutation.

Cancellation may win after OS spawn but before process admission is recorded. In that case the runner closes the still-unsent input, confirms child cleanup and checks the exact cancelled task/queue identity. It returns a cancelled report without stopping unrelated control work. It does not fabricate an admitted start/reap event pair or checkpoint for that unadmitted process. Storage corruption and unrelated ownership failures still return errors. The regression resumes the same server and store with a new request to prove the cancellation does not disable the host.

A cancellation that occurs after admission can still race with an already admitted pure operation. Its late result is checked against the current cancellation epoch and cannot revive the task. Existing unknown external-effect semantics are unchanged.

## Platform boundary

Linux sets a separate process group, disables core dumps and installs a parent-death SIGKILL with a parent-race check in the pre-exec hook. Spawn occurs on the foreground's persistent current-thread runtime. This covers the known built-in single-process worker; it is not a general descendant/cgroup containment guarantee or filesystem/network sandbox.

Windows uses a non-inheritable, unnamed kill-on-close Job Object with one active process permitted. The trusted child initially waits for stdin; assignment bytes are sent only after successful job attachment. Attachment failure has no unmanaged fallback. Owned process/job handles govern cleanup. A Job Object does not restrict filesystem access like a sandbox.

The worker protocol does not expose tools or credentials, but same-user compromise, a replaced trusted executable and arbitrary host code remain outside this fixture's protection. macOS native foreground support is disabled; portable compilation and explicit unsupported-capability tests are separate from native runtime support.

## Required validation

Run the ordinary suite and the complete opt-in process fixture suite:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --nocapture
cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
```

The Linux/Windows CI matrix runs both suites and the foreground demo. The separate vault jobs lint all features and run their isolated real-vault tests. CI stays read-only and does not commit formatting or generated changes. Per-commit execution results belong in the PR, including failures; documentation or successful compilation is not runtime evidence.

The original failure matrix has thirteen cases: empty output, failed exit, wrong hash, wrong nonce, wrong task, wrong fence, oversized stdout header, excessive stderr, partial response, duplicate fields, trailing bytes, valid-reply-then-hang, and timeout. The malformed stdout fixture explicitly flushes its invalid header before parking so the parent actually receives it. Additional regressions require stdout/stderr limit violations to report invalid_output, not merely a generic deadline.

Further tests cover native cancellation, graceful shutdown and later reassignment, foreground-parent death, sanitized-environment canaries, Windows second-active-process refusal, local/relative path compatibility, pre-creation parent-hop rejection and unmodified verbatim-path rejection. A feature-only oneshot barrier stops the runner exactly between spawn and admission, waits for a real authenticated native cancellation, then resumes; it does not guess the race with sleeps. That case proves no assignment-delivery notification, no checkpoint for the cancelled task, confirmed cleanup and successful follow-up work on the same host. Non-fixture builds reject the test-only command before creating a directory.

These are deterministic regression cases, not the design's 1,000-injection gate, cancellation percentiles, physical power-cut/reboot qualification, general hostile-plugin evaluation or an independent security review. Existing store/control/queue and native-vault fault denominators remain required.

## Next boundary

Implement reviewed worker-scoped SEC-01 authority and the versioned Rust/TypeScript engine/tool interface before live tools. General process containment/recovery, real provider authentication, ART-01 result verification/publication, UI and installed-service packaging remain separate gates. The fixed worker's response cannot grant itself authority or certify a user result.
