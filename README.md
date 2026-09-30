# Tada

**Ask. Go live your life. Tada.**

An open-source, local-first desktop agent being built to execute work on your computer and return verified results. The intended architecture is a Rust daemon and authority broker, a TypeScript engine, and a Tauri desktop UI. Remote inference uses explicitly connected accounts; “local-first” does not mean all inference stays on-device.

## Current status: contract foundation, not a working agent

This repository currently contains versioned contracts, generated Rust/TypeScript types, cross-language conformance fixtures, and CI. **There is no desktop application, running daemon, model login, browser control, or crash-safe execution yet.** Passing contract tests does not establish those capabilities or satisfy the release gates in the design.

The supplied [design v1.0 (Korean)](docs/design/source-2026-09-30.md) is preserved byte-for-byte. [Implementation decisions](docs/contracts-v1.md) distinguish executable contracts from illustrative design snippets and from guarantees that still require runtime evidence.

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
| `fixtures/contracts/v1/` | The same valid and invalid cases consumed by both runtimes |
| `scripts/` | Deterministic generation and source-fidelity checks |
| `docs/` | Supplied design, implementation decisions, threat boundaries, and next gates |

The action graph only describes possible transitions. It does **not** grant permission, establish safe retry, check cancellation, or perform a state transaction. `APPLIED_MISMATCH` records a confirmed effect and failed acceptance; it is neither verified success nor an unknown effect. A cancelled task may still have an unknown external outcome.

## Next gate

[CORE 02](docs/roadmap.md): SQLite state and event transactions, cancellation tombstones, fenced dispatch admission, and mock-side-effect crash recovery. Real provider authentication remains a separate unproven gate. Do not connect real external writes until the broker and recovery tests exist.

## Contributing and security

See [CONTRIBUTING](CONTRIBUTING.md), [agent instructions](AGENTS.md), and [security boundaries](docs/security.md). No vulnerability contact or response SLA has been invented; that release prerequisite remains explicitly open.

Licensed under [Apache-2.0](LICENSE).
