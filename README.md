# Tada

**Ask. Go live your life. Tada.**

An open-source, local-first desktop agent being built to execute work on your computer and return verified results. The intended architecture is a Rust daemon and authority broker, a TypeScript engine, and a Tauri desktop UI. Remote inference uses explicitly connected accounts; “local-first” does not mean all inference stays on-device.

## Current status: durable mock core with native local control

This repository contains versioned contracts, generated Rust/TypeScript types, cross-language conformance fixtures, and a Rust store that exercises durable state, cancellation and recovery against an independent mock effect ledger. The control protocol now connects real frontend processes through Linux Unix-domain sockets and Windows named pipes, with OS peer checks, authenticated sessions and durable request replay. **There is no desktop UI, installed daemon, persistent credential store, model login or browser control yet.** Native transport and mock recovery have their own regression tests; real-provider safety and the design's release gates remain separate.

The supplied [design v1.0 (Korean)](docs/design/source-2026-09-30.md) is preserved byte-for-byte. [Contract decisions](docs/contracts-v1.md), [CORE-02 implementation boundaries](docs/core-02.md), [control protocol decisions](docs/control-protocol.md), and [native IPC boundaries](docs/native-ipc.md) distinguish executable code from illustrative design snippets and guarantees that still require runtime evidence.

## Check the foundation

Development uses the versions in `.node-version` and `rust-toolchain.toml`. Install those toolchains, then run:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

No provider credentials or model calls are used by these tests. Dependencies are downloaded during initial installation; schema validation itself does not fetch external references. These are **developer prerequisites**, not a plan to require end users to install Node or Rust.

Run disposable demonstrations in new directories:

```sh
cargo run --locked -p tada-store --example recover_mock -- ./new-mock-demo
cargo run --locked -p tada-store --example control_replay -- ./new-control-demo
```

The first mock saves one effect and loses its response. Execution is cancelled, the store is reopened, and the existing effect is verified without sending the mutation again. The task is not declared successful. The second example authenticates in-process, discards a submit reply, reopens the store and replays submit/cancel without reviving cancelled work. It uses an ephemeral in-memory fixture key, not a real IPC endpoint or installed secret store. Both destinations must not already exist; only mock data is written.

On Linux or Windows, run the separate-process native IPC demonstration:

```sh
cargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- ./new-native-demo
```

The parent opens the fixture store and native listener, then transfers an ephemeral credential to its own client child through an anonymous pipe. The child authenticates, disconnects, reconnects and replays submit/cancel. No key is saved to disk, passed in argv/environment, or sent through RPC. The new directory must not exist. Both processes exit when verification finishes; nothing is installed.

The native listener is available only on Linux/Windows in this slice. Other OS builds return `IPC_UNSUPPORTED_PLATFORM` before creating an endpoint, instead of breaking the portable workspace or pretending to offer peer-verified IPC. macOS native transport and credential integration remain unimplemented.

Change the source schema, regenerate, and rerun the full suite:

```sh
npm run generate
npm run check
cargo test --workspace --locked
```

Do not hand-edit generated files. JSON Schema checks and typed decoding are separate: a type assertion is not validation, and successful validation is not authorization.

## What is here

| Path | Responsibility |
| --- | --- |
| `packages/contracts/schema/` | Authoritative v1 JSON Schema and action transition graph |
| `packages/contracts/src/` | JavaScript runtime validator with TypeScript declarations and generated types |
| `crates/contracts/` | Rust validation and validate-before-decode/encode helpers |
| `crates/store/` | SQLite state/event transactions, restore witness, mock admission/reconciliation, budget reservations, outbox and fault tests |
| `crates/store/src/control/` | Bounded authenticated frames, strict JSON-RPC commands, atomic request replay and task-event reads; no listener |
| `crates/local-ipc/` | Native socket/pipe peers, bounded I/O and sessions, graceful drain, and opt-in cross-process fixture demo |
| `fixtures/contracts/v1/` | The same valid and invalid cases consumed by both runtimes |
| `scripts/` | Deterministic generation and source-fidelity checks |
| `docs/` | Supplied design, implementation decisions, threat boundaries, and next gates |

The action graph only describes possible transitions; it is not permission or replay safety. The mock store adds transactional checks within its explicitly limited trusted-host boundary, not a general security broker. `APPLIED_MISMATCH` preserves a confirmed effect and failed acceptance. Cancellation does not erase an unknown outcome. No action success manufactures whole-task completion.

## Next gates

[CORE-02 follow-through and SEC-01](docs/roadmap.md): persistent installation identity/discovery and OS-secret-store bootstrap, scheduled work, general resource leases, production recovery controls, reviewed policies, encrypted real-user data and provider-aware budgets. The control protocol is not an OS sandbox or a completed IPC-security gate. ART-01 must verify and publish results before successful-result notifications exist. Real provider authentication remains a separate unproven gate. Do not enable live external writes merely because the mock tests pass.

## Contributing and security

See [CONTRIBUTING](CONTRIBUTING.md), [agent instructions](AGENTS.md), and [security boundaries](docs/security.md). No vulnerability contact or response SLA has been invented; that release prerequisite remains explicitly open.

Licensed under [Apache-2.0](LICENSE).
