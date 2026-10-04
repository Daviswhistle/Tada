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

## Conversational developer preview

The first conversation path now accepts raw messages, uses an explicitly selected local Ollama model, discovers permitted text sources through a Rust read-only gateway, and supports same-session follow-up. Source directories are granted once at startup; the user does not select the exact answer file or supply a TaskContract with each question. The model chooses among reusable source-listing and reading tools, not phrase-specific scripts.

Build with the repository-pinned toolchains, run your own trusted Ollama server with cloud disabled, and choose an already installed tool-capable local model:

```sh
npm ci --ignore-scripts
cargo build --locked -p tada-agentd --bin tada-read-broker
npm run assistant -- --model YOUR_INSTALLED_LOCAL_MODEL --broker ABSOLUTE_PATH_TO_TADA_READ_BROKER --allow-read YOUR_NOTES_DIRECTORY
```

Use actual paths in place of the placeholders; the Windows gateway ends in `.exe`. Type ordinary questions and follow-up requests. `/forget` clears session context and `/exit` exits. No model download, credential reuse, paid fallback or service installation occurs in this command. See the [preview guide](docs/conversational-preview.md) for local-only setup, read scope, limits and verification.

**This is not yet the complete general-purpose assistant.** It reads small UTF-8 text files and answers with source references whose bytes are rechecked. It does not yet see the current screen, search public websites, use mail/calendar, change files, run arbitrary commands, publish artifacts or retain conversation after process exit. A source hash verifies bytes, not every semantic claim. The current terminal is a development entry point, not the intended desktop experience.

## Existing execution core and product evidence

The repository also has a Rust execution/recovery core, authenticated Linux/Windows local control, OS-vault installation identity, durable queue, bounded child processes, TypeScript mock-model loop and separate durable inference ledger. These retain their original tests. The old WorkerRPC tool remains `task.contract_digest`; the new read-only conversation gateway is a narrow launcher-owned path and does not claim full task/budget/worker-ledger integration. No fake contract or price is created to make the new path look integrated.

The [assistant acceptance suite](evals/assistant-v1/README.md) defines 16 natural-delegation scenarios. Its historical [baseline](evals/assistant-v1/baseline.json) remains **not run**. A separate real-local-model smoke exercises discovery and follow-up in two predetermined synthetic contexts; observed pass/failure evidence is reported per PR/head. Neither scripted unit responses nor that narrow smoke qualifies all 16 product scenarios.

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

Ordinary tests use fixtures, not live paid inference or OS-vault enrollment. The process-fixture suite requires the pinned Node runtime and locked Node dependencies. It remains mandatory in Linux/Windows CI. The separate local-assistant CI downloads a checked Ollama runtime and public local-model weights into an isolated runner, not a user's machine. These are developer prerequisites, not the intended end-user experience.

Disposable component examples require a destination that does not exist:

```sh
cargo run --locked -p tada-agentd --bin tada-agentd -- demo ./new-process-demo
cargo run --locked -p tada-store --example inference_recovery -- ./new-inference-demo
```

The first checks native control and a fixed child probe. The second preserves a mock inference reservation through cancellation/reopen and records a late observation. Neither performs a real user task or produces a completed assistant result.

## Implementation references

[Contracts](docs/contracts-v1.md), [durable core](docs/core-02.md), [control replay](docs/control-protocol.md), [native IPC](docs/native-ipc.md), [installation identity](docs/installation-identity.md), [queue/supervisor](docs/queue-supervisor.md), [foreground host](docs/process-host.md), [worker authority](docs/worker-authority.md), [duplex engine](docs/engine-duplex.md), [mock model streams](docs/model-streams.md), [inference ledger](docs/inference-ledger.md), and [conversational preview](docs/conversational-preview.md) document implemented boundaries and remaining limits. The current product roadmap governs priorities, not old infrastructure-only “next step” sections.

Existing developer data has explicit version transitions. Ordinary new stores use schema v2; v1 queue migration and optional v2-to-v3 mock inference require a safe point and a new backup. The conversational preview does not change those schema versions or store raw prompts in them. See the queue and inference documents before opening or migrating existing data. No example is an installer or restore wizard.

Linux Secret Service and Windows Credential Manager tests are separately opt-in and write disposable entries. Use an isolated test session and the [identity test instructions](docs/installation-identity.md). macOS currently has static portability and unsupported-native checks, not the native read gateway or native engine/Keychain support.

See [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [security boundaries](docs/security.md). Local-first means execution/state ownership on the user's device. The current conversational route is local-only; future remote routes may transmit permitted context to the explicitly chosen provider. No remote account access or undocumented credential reuse is implied.

Licensed under [Apache-2.0](LICENSE).
