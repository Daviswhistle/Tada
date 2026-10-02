# Tada

**Ask. Go live your life. Tada.**

An open-source, local-first desktop agent being built to execute work on your computer and return verified results. The intended architecture is a Rust daemon and authority broker, a TypeScript engine, and a Tauri desktop UI. Remote inference uses explicitly connected accounts; “local-first” does not mean all inference stays on-device.

## Current status: durable queue and authenticated local-control foundation

The repository has shared Rust/TypeScript contracts, a witnessed SQLite task/effect ledger, authenticated native control on Linux and Windows, persistent OS-vault installation identity, and a cooperative supervisor with one-shot scheduling and cancellation-prioritized admission. Task acceptance remains separate from worker/checkpoint success. **There is no desktop UI, installed daemon, production model worker, model login or browser control yet.** These components have regression fixtures; live-provider safety and the design's release gates remain separate.

The supplied [design v1.0 (Korean)](docs/design/source-2026-09-30.md) is preserved byte-for-byte. Implementation decisions and boundaries: [contracts](docs/contracts-v1.md), [durable mock core](docs/core-02.md), [control protocol](docs/control-protocol.md), [native IPC](docs/native-ipc.md), [installation identity](docs/installation-identity.md), and [queue/supervisor](docs/queue-supervisor.md).

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

## Disposable demonstrations

Every destination below must be a **new** directory. Examples write mock data and install no service or automatic-start entry.

```sh
cargo run --locked -p tada-store --example recover_mock -- ./new-mock-demo
cargo run --locked -p tada-store --example control_replay -- ./new-control-demo
cargo run --locked -p tada-agentd --example supervisor_probe -- ./new-supervisor-demo
```

`recover_mock` saves one independent mock effect, loses its reply, cancels, reopens the store and verifies the existing effect without resending it. `control_replay` authenticates in-process and replays submit/cancel after reopening without reviving cancelled work. `supervisor_probe` restores a queue, respects a one-shot not-before time, checks immutable input hashes and writes two checkpoints while leaving user-task acceptance unmet. None manufactures a SUCCEEDED task.

On Linux or Windows, run the distinct-process native IPC example:

```sh
cargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- ./new-native-demo
```

The parent owns a fixture store/listener and supplies its client child a session-only random key through an anonymous pipe. The client reconnects and replays submit/cancel. No key goes into argv, environment, RPC or plaintext files; both processes exit.

Persistent identity uses explicit library enrollment and the current user's Linux Secret Service or Windows Credential Manager. It has no plaintext-file fallback. Ordinary tests do not access those vaults. The following **opt-in** native integration command writes unique disposable fixture entries, so use an isolated test account/session with the actual backend available:

```sh
cargo test --locked -p tada-credential --features os-vault-tests os_tests:: -- --nocapture --test-threads=1
```

Linux CI runs its own isolated D-Bus/keyring session. macOS currently compiles the portable core and rejects unsupported native IPC/identity operations before creating endpoints; native macOS transport and Keychain integration remain future work.

## Existing developer stores: explicit queue migration

New stores use task-ledger schema v2. Existing v1 stores are not silently migrated: normal open returns `QUEUE_MIGRATION_REQUIRED`. Stop the old owner, reconcile pending effects with a compatible v1 build, retain the independent witness, and explicitly choose a new backup file:

```sh
cargo run --locked -p tada-store --example migrate_queue_v2 -- /existing/store /new/location/v1-backup.sqlite
```

Migration audits and backs up v1 before creating queue/checkpoint tables and committing a checksum/version marker. It refuses unresolved external work/publication and an occupied backup destination. A witness/state mismatch requires read-only recovery. Full constraints and interrupted-migration behavior are in [CORE-06](docs/queue-supervisor.md); this is not a general restore wizard.

## Modules

| Path | Responsibility |
| --- | --- |
| `packages/contracts/`, `crates/contracts/`, `fixtures/contracts/v1/` | One authoritative schema, generated types and shared conformance cases |
| `crates/store/` | Task/action ledger, witness, control replay, queue, integer mock reservations, checkpoints and outbox |
| `crates/local-ipc/` | Native socket/pipe peer checks, bounded authenticated I/O and cancellation-prioritized store admission |
| `crates/credential/` | Explicit persistent installation enrollment, OS-vault adapters and generation-pinned discovery |
| `crates/agentd/` | Cooperative host supervisor and deterministic opt-in probe; no installed daemon or implicit tool worker |
| `scripts/`, `docs/` | Deterministic generation, source fidelity, implementation decisions and remaining gates |

Change schemas only through their source, then regenerate and validate:

```sh
npm run generate
npm run check
cargo test --workspace --locked
```

Do not hand-edit generated contracts. Validation is not authorization; queue ownership is not a tool grant; an acknowledged effect is not verified; verified actions and checkpoints are not whole-task completion. Cancellation preserves uncertain external effects and does not authorize automatic compensation.

## Next gates

The [roadmap](docs/roadmap.md) retains process lifecycle/containment and safe reaping, foreground/installed daemon integration, reviewed worker-scoped SEC-01 authority, richer recovery, hierarchical/provider-aware budgets and recurring schedule contracts. Provider authentication, a model loop, file tools and ART-01 result verification/publication require their own evidence. Persistent-key rotation and live revocation also remain separate. Do not enable live tools merely because mock/native tests pass.

See [CONTRIBUTING](CONTRIBUTING.md), [agent instructions](AGENTS.md) and [security boundaries](docs/security.md). No maintainer sign-off, independent security review or response SLA is fabricated.

Licensed under [Apache-2.0](LICENSE).
