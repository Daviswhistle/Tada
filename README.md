# Tada

**Ask. Go live your life. Tada.**

An open-source, local-first desktop agent being built to execute work on your computer and return verified results. The intended architecture is a Rust daemon and authority broker, a TypeScript engine, and a Tauri desktop UI. Remote inference uses explicitly connected accounts; “local-first” does not mean all inference stays on-device.

## Current status: durable mock core, native control and persistent identity

This repository contains versioned contracts, generated Rust/TypeScript types, cross-language conformance fixtures, and a Rust store that exercises durable state, cancellation and recovery against an independent mock effect ledger. The control protocol connects real frontend processes through Linux Unix-domain sockets and Windows named pipes, with OS peer checks, authenticated sessions and durable request replay. A trusted-host installation library now supplies Linux Secret Service / Windows Credential Manager enrollment and authenticated daemon discovery across process restarts. **Desktop UI, installed daemon/scheduler, model login, real tools and browser control remain unimplemented.** Each integration has its own regression tests; real-provider safety and the design's release gates remain separate.

The supplied [design v1.0 (Korean)](docs/design/source-2026-09-30.md) is preserved byte-for-byte. [Contract decisions](docs/contracts-v1.md), [CORE-02](docs/core-02.md), [control protocol](docs/control-protocol.md), [native IPC](docs/native-ipc.md), and [installation identity](docs/installation-identity.md) distinguish executable code from illustrative snippets and remaining qualification.

## Check the foundation

Development uses the versions in `.node-version` and `rust-toolchain.toml`. Install those toolchains, then run:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

No provider credentials or model calls are used. Ordinary tests use private test-only mock vaults; they do not enroll an OS credential. Dependencies are downloaded during initial installation; schema validation itself does not fetch external references. These are **developer prerequisites**, not end-user installation requirements.

Run disposable demonstrations in new directories:

```sh
cargo run --locked -p tada-store --example recover_mock -- ./new-mock-demo
cargo run --locked -p tada-store --example control_replay -- ./new-control-demo
```

The first mock saves one effect and loses its response. Execution is cancelled, the store is reopened, and the existing effect is verified without sending the mutation again. The task is not declared successful. The second authenticates in-process, discards a submit reply, reopens the store and replays submit/cancel without reviving cancelled work. It uses an ephemeral fixture key. Both destinations must not already exist; only mock data is written.

On Linux or Windows, run the separate-process native IPC demonstration:

```sh
cargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- ./new-native-demo
```

The parent opens the fixture store and native listener, then transfers an ephemeral credential to its own client child through an anonymous pipe. The child authenticates, disconnects, reconnects and replays submit/cancel. No key is saved to disk, passed in argv/environment, or sent through RPC. The new directory must not exist. Both processes exit when verification finishes; nothing is installed.

The separate persistent-identity library exposes explicit initialize/finish/load/bind/connect operations; see [its lifecycle and tests](docs/installation-identity.md). It never replaces a missing active key or silently chooses a plaintext fallback. **Opt-in `os-vault-tests` write disposable fixture entries to the current user's OS vault and should run only in an isolated test account/session.** The CI has dedicated Secret Service/Credential Manager jobs; ordinary test success is not evidence those backends were exercised.

Native IPC and persistent identity are implemented for Linux/Windows. Other OS builds return an explicit unsupported-capability error before creating the endpoint or identity root. macOS native transport and keychain integration remain separate.

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
| `crates/store/` | SQLite state/events, restore witness, mock admission/reconciliation, budget reservations, outbox and fault tests |
| `crates/store/src/control/` | Bounded authenticated frames, strict commands, atomic request replay and task-event reads |
| `crates/local-ipc/` | Native peers, bounded I/O and sessions, graceful drain, cross-process fixture demo |
| `crates/credential/` | Explicit OS-vault enrollment, private installation metadata, signed discovery and generation-pinned connection |
| `fixtures/contracts/v1/` | Shared positive and negative contract cases |
| `scripts/` | Deterministic generation, source-fidelity checks and isolated OS-vault CI wrapper |
| `docs/` | Supplied design, implementation decisions, threat boundaries and next gates |

The action graph describes possible transitions, not permission or replay safety. The store adds transactional checks within its limited trusted-host boundary, not a general security broker. `APPLIED_MISMATCH` preserves a confirmed effect and failed acceptance. Cancellation does not erase an unknown outcome. Neither action success nor successful authentication manufactures whole-task completion or worker authority.

## Next gates

[CORE-02 follow-through and SEC-01](docs/roadmap.md): supervisor/queue and cancellation priority, worker-scoped grants, human-facing enrollment/recovery and key rotation, general resource leases, production recovery controls, encrypted real-user data and provider-aware budgets. ART-01 must verify and publish results before successful-result notifications exist. Real provider authentication remains a separate authorized proof. Keep live external writes disabled until their own boundaries have evidence.

## Contributing and security

See [CONTRIBUTING](CONTRIBUTING.md), [agent instructions](AGENTS.md), and [security boundaries](docs/security.md). No vulnerability contact or response SLA has been invented; that release prerequisite remains open.

Licensed under [Apache-2.0](LICENSE).
