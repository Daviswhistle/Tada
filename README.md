# Tada

**Ask. Go live your life. Tada.**

An open-source, local-first desktop agent being built to execute work on your computer and return verified results. The intended architecture is a Rust daemon and authority broker, a TypeScript engine, and a Tauri desktop UI. Remote inference uses explicitly connected accounts; “local-first” does not mean all inference stays on-device.

## Current status: foreground control and a durable fixed-worker foundation

The repository has shared Rust/TypeScript contracts, a witnessed SQLite task/effect ledger, authenticated native control on Linux and Windows, persistent OS-vault installation identity, a durable queue, and a foreground host with an opt-in separate-process input-hash probe. Task acceptance remains separate from worker/checkpoint success. **There is no desktop UI, installed service, production model worker, model login or browser control yet.** These components have regression fixtures; live-provider safety and the design's release gates remain separate.

The supplied [design v1.0 (Korean)](docs/design/source-2026-09-30.md) is preserved byte-for-byte. Implementation decisions and boundaries: [contracts](docs/contracts-v1.md), [durable mock core](docs/core-02.md), [control protocol](docs/control-protocol.md), [native IPC](docs/native-ipc.md), [installation identity](docs/installation-identity.md), [queue/supervisor](docs/queue-supervisor.md), and [foreground process host](docs/process-host.md).

## Check the foundation

Use the toolchain versions in `.node-version` and `rust-toolchain.toml`:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Ordinary tests use fixtures, no provider credentials, model calls or OS-vault writes. Initial dependency installation downloads packages; contract validation does not fetch external schema references. These are developer prerequisites, not requirements for an eventual end-user installer.

On Linux and Windows, also run the complete process-lifecycle failure suite. CI requires it in addition to the ordinary workspace tests:

```sh
cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
```

This enables only test fixtures, including parent-death, malformed output and a synchronized startup-cancellation race. The normal build does not accept those fault commands. Passing the fixed probe suite does not qualify arbitrary host processes or a model engine.

## Disposable demonstrations

Every destination below must be a **new** directory. Examples write mock data and install no service or automatic-start entry.

```sh
cargo run --locked -p tada-store --example recover_mock -- ./new-mock-demo
cargo run --locked -p tada-store --example control_replay -- ./new-control-demo
cargo run --locked -p tada-agentd --example supervisor_probe -- ./new-supervisor-demo
```

`recover_mock` saves one independent mock effect, loses its reply, cancels, reopens the store and verifies the existing effect without resending it. `control_replay` authenticates in-process and replays submit/cancel after reopening without reviving cancelled work. `supervisor_probe` restores a queue, respects a one-shot not-before time, checks immutable input hashes and writes two checkpoints while leaving user-task acceptance unmet. None manufactures a SUCCEEDED task.

On Linux or Windows, run the foreground host with one real child probe:

```sh
cargo run --locked -p tada-agentd --bin tada-agentd -- demo ./new-process-demo
```

The demo uses authenticated native control with a session-only credential, preserves request replay and queued cancellation, and requires a matching bounded worker reply plus confirmed process exit before its checkpoint. It does not access an OS vault or run a model/tool. The [foreground command reference](docs/process-host.md) explains explicit persistent enrollment, `serve` versus `serve-probe`, `request`, protected paths and shutdown behavior.

The earlier distinct-process native-control client example remains available:

```sh
cargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- ./new-native-demo
```

That parent owns a fixture store/listener and supplies its client child a session-only random key through an anonymous pipe. The client reconnects and replays submit/cancel. No key goes into argv, environment, RPC or plaintext files; both processes exit. Unlike that client, the fixed probe worker receives no installation credential at all.

Persistent identity uses explicit enrollment and the current user's Linux Secret Service or Windows Credential Manager. It has no plaintext-file fallback. Ordinary and process-fixture tests do not access those vaults. The following **opt-in** native integration command writes unique disposable fixture entries, so use an isolated test account/session with the actual backend available:

```sh
cargo test --locked -p tada-credential --features os-vault-tests os_tests:: -- --nocapture --test-threads=1
```

Linux CI runs its own isolated D-Bus/keyring session. macOS currently compiles the portable core and rejects unsupported native IPC/identity operations before creating endpoints; native macOS transport and Keychain integration remain future work.

## Existing developer stores: explicit queue migration

New stores use task-ledger schema v2. Existing v1 stores are not silently migrated: normal open returns `QUEUE_MIGRATION_REQUIRED`. Stop the old owner, reconcile pending effects with a compatible v1 build, retain the independent witness, and explicitly choose a new backup file:

```sh
cargo run --locked -p tada-store --example migrate_queue_v2 -- /existing/store /new/location/v1-backup.sqlite
```

Migration audits and backs up v1 before creating queue/checkpoint tables and committing a checksum/version marker. It refuses unresolved external work/publication and an occupied backup destination. A witness/state mismatch requires read-only recovery. Full constraints and interrupted-migration behavior are in [CORE-06](docs/queue-supervisor.md); this is not a general restore wizard. CORE-07 adds no further schema migration.

## Modules

| Path | Responsibility |
| --- | --- |
| `packages/contracts/`, `crates/contracts/`, `fixtures/contracts/v1/` | One authoritative schema, generated types and shared conformance cases |
| `crates/store/` | Task/action ledger, witness, control replay, queue, integer mock reservations, checkpoints and outbox |
| `crates/local-ipc/` | Native socket/pipe peer checks, bounded authenticated I/O and cancellation-prioritized store admission |
| `crates/credential/` | Explicit persistent installation enrollment, protected ledger directories, OS-vault adapters and generation-pinned discovery |
| `crates/agentd/` | Supervisor, foreground CLI and bounded fixed-probe child lifecycle; no installed service or implicit tool worker |
| `scripts/`, `docs/` | Deterministic generation, source fidelity, implementation decisions and remaining gates |

Change schemas only through their source, then regenerate and validate:

```sh
npm run generate
npm run check
cargo test --workspace --locked
```

Do not hand-edit generated contracts. Validation is not authorization; queue ownership is not a tool grant; an acknowledged effect is not verified; verified actions and checkpoints are not whole-task completion. Cancellation preserves uncertain external effects and does not authorize automatic compensation.

## Next gates

The [roadmap](docs/roadmap.md) retains reviewed worker-scoped SEC-01 authority, the shared TypeScript engine/tool boundary, general process containment/recovery, installed-service integration, richer recovery, hierarchical/provider-aware budgets and recurring schedule contracts. Provider authentication, file tools and ART-01 result verification/publication require their own evidence. Persistent-key rotation and live revocation also remain separate. Do not enable live tools merely because mock/native tests pass.

See [CONTRIBUTING](CONTRIBUTING.md), [agent instructions](AGENTS.md) and [security boundaries](docs/security.md). No maintainer sign-off, independent security review or response SLA is fabricated.

Licensed under [Apache-2.0](LICENSE).
