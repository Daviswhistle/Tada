# Tada

**Ask. Go live your life. Tada.**

Tada is being built as a personal AI assistant you can delegate to in ordinary language. You should not have to collect the documents, name the project, diagnose the error, or write a complete task specification first. The assistant should find the relevant context, work out what is needed, gather information, act through available tools, and check the result.

“Look into that company”, “This isn't working”, and “Make the earlier one simpler” are product acceptance requests, not shortcuts for prewritten workflows. The same request can mean different things in different conversations or screens. File, terminal, browser and app tools are means to do the work, not the product definition.

## Current product contract

The user's 2026-10-04 correction is recorded in the [current product contract](docs/product-contract.md) and [revised roadmap](docs/roadmap.md). It changes the interpretation and development priorities of the preserved [2026-09-30 design](docs/design/source-2026-09-30.md), which remains byte-identical. Cancellation, authorization, original-file protection and verified completion still apply.

The intended experience is:

- **Understand and discover:** connect the request to relevant conversation, ongoing work, prior results, confirmed preferences and permitted current observations; find missing information rather than asking the user to prepare it.
- **Act and check:** choose and compose available tools, resolve recoverable problems, and verify the user's actual goal rather than only process exit or file existence.
- **Continue naturally:** understand follow-up references, preserve current user edits, and ask only for a real choice, needed access, or consequential ambiguity that available context cannot resolve.

Context access is scoped and permission-aware. This does not require continuous screen recording, unrestricted private-data collection, guessed approvals, or a promise to understand information the assistant cannot observe. Full-computer control remains a planned explicit mode, with its real limits disclosed.

## What works today

**There is not yet a usable general-purpose assistant.** The current implementation has a Rust execution and recovery core, authenticated Linux/Windows local control, OS-vault installation identity, a durable queue, bounded child processes, a TypeScript mock-model loop and a separate durable inference ledger. The only broker-backed tool currently exercised is `task.contract_digest`.

Real model integration, conversational intake, active-context collection, autonomous source discovery, general file/browser/app work, and a user-facing conversation/result screen are not yet connected into a working assistant. The TypeScript loop is not wired to the durable inference ledger. These are the next user-experience milestones, not features proven by component CI.

The [assistant acceptance suite](evals/assistant-v1/README.md) defines 16 natural-delegation scenarios. Its [baseline](evals/assistant-v1/baseline.json) is explicitly **not run**: component tests and scripted digest demonstrations are not assistant success evidence. The new suite-integrity tests only validate that specification.

## Development

Use the versions in `.node-version` and `rust-toolchain.toml`:

```sh
npm ci --ignore-scripts
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
```

Ordinary tests use fixtures, not live paid inference or OS-vault enrollment. The process-fixture suite requires the pinned Node runtime and locked Node dependencies. It remains mandatory in Linux/Windows CI. These are developer prerequisites, not the intended end-user experience.

Disposable component examples require a destination that does not exist:

```sh
cargo run --locked -p tada-agentd --bin tada-agentd -- demo ./new-process-demo
cargo run --locked -p tada-store --example inference_recovery -- ./new-inference-demo
```

The first checks native control and a fixed child probe. The second preserves a mock inference reservation through cancellation/reopen and records a late observation. Neither performs a real user task or produces a completed assistant result.

## Implementation references

[Contracts](docs/contracts-v1.md), [durable core](docs/core-02.md), [control replay](docs/control-protocol.md), [native IPC](docs/native-ipc.md), [installation identity](docs/installation-identity.md), [queue/supervisor](docs/queue-supervisor.md), [foreground host](docs/process-host.md), [worker authority](docs/worker-authority.md), [duplex engine](docs/engine-duplex.md), [mock model streams](docs/model-streams.md), and [inference ledger](docs/inference-ledger.md) document implemented boundaries and remaining limits. Older “next step” sections are historical; the current roadmap governs priorities.

Existing developer data has explicit version transitions. Ordinary new stores use schema v2; v1 queue migration and optional v2-to-v3 mock inference require a safe point and a new backup. See the queue and inference documents before opening or migrating existing data. No example is an installer or restore wizard.

Linux Secret Service and Windows Credential Manager tests are separately opt-in and write disposable entries. Use an isolated test session and the [identity test instructions](docs/installation-identity.md). macOS currently has static portability and unsupported-native checks, not native engine/Keychain support.

See [AGENTS.md](AGENTS.md) for development priorities and invariants, [CONTRIBUTING.md](CONTRIBUTING.md), and [security boundaries](docs/security.md). Local-first means execution/state ownership on the user's device; remote inference may transmit permitted context to the chosen provider. No live account route or undocumented credential reuse is implied.

Licensed under [Apache-2.0](LICENSE).
