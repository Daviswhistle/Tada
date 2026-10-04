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

Context access is scoped and permission-aware. This does not require continuous screen recording, unrestricted private-data collection, guessed approvals, or a promise to understand information the assistant cannot observe. Full-computer control remains a planned explicit mode, with its real limits disclosed. The [Instinct reference](docs/references/instinct.md) informs ongoing-context and ordinary-conversation experience, not copied implementation or independently verified service claims.

## Conversational developer preview

### Local conversation and source discovery

The local path accepts raw messages, uses an explicitly selected Ollama model, discovers permitted text sources through a Rust read-only gateway, and supports same-session follow-up. Source directories are granted once at startup; the user does not select the exact answer file or supply a TaskContract with each question. The model chooses among reusable source-listing and reading tools, not phrase-specific scripts.

Build with the repository-pinned toolchains, run your own trusted Ollama server with cloud disabled, and choose an already installed tool-capable local model:

```sh
npm ci --ignore-scripts
cargo build --locked -p tada-agentd --bin tada-read-broker
npm run assistant -- --model YOUR_INSTALLED_LOCAL_MODEL --broker ABSOLUTE_PATH_TO_TADA_READ_BROKER --allow-read YOUR_NOTES_DIRECTORY
```

Use actual paths in place of the placeholders; the Windows gateway ends in `.exe`. Type ordinary questions and follow-up requests. `/forget` clears session context and `/exit` exits. No model download, credential reuse, paid fallback or service installation occurs in this command. See the [preview guide](docs/conversational-preview.md) for local-only setup, read scope, limits and verification.

The real local smoke at PR #13 head `ba94c6f` passed both predefined discovery/follow-up variants with Ollama 0.34.0 and the explicitly selected `qwen3:8b` weights. Earlier `qwen3:4b` and `qwen3:4b-instruct` attempts failed and remain recorded in that PR. These observations qualify a narrow English fixture, not every installed model, broad reasoning reliability or the full assistant acceptance suite. Production never switches models to make a request pass.

### Public research, explicitly selected

A separate API-key route uses provider-hosted public web research and preserves the same foreground conversation for follow-up:

```sh
npm run assistant -- --web --help
npm run assistant -- --web
```

It asks for a chosen model, explicit API-billing/context-transmission consent, then a hidden session-only API key. It does not read keys from environment variables or other applications, and never silently switches from the local route. No per-question attachment, file path or source list is required. `/save` explicitly exports the last answer with clickable sources to a new local HTML file.

**The public API route has not been exercised with a real paid account.** Its serializer, conversation flow, presentation and CLI have synthetic protocol tests, not live compatibility or answer-quality evidence. It has process-local request/token/tool bounds, not a strict dollar cap or the daemon's restart-safe accounting. No real key was used in its implementation. See [public research](docs/public-research.md) for exact limits, API-key versus subscription distinctions and remaining validation.

The two preview selections currently have separate in-memory conversations. Local roots, file contents and local conversation are never automatically sent into web/API research. Shared working context and host permission/ledger integration remain next work within one assistant; the modes are not two finished products.

**This is not yet the complete general-purpose assistant.** Current-screen observation, mail/calendar, agent file modification, arbitrary commands, external actions, durable conversation and a desktop interface remain unconnected. The local preview rechecks cited source bytes; public citations come from the provider. Neither mechanism independently proves every semantic claim or a successful external action. The terminal is a development entry point, not the intended final desktop experience.

## Existing execution core and product evidence

The repository also has a Rust execution/recovery core, authenticated Linux/Windows local control, OS-vault installation identity, durable queue, bounded child processes, TypeScript mock-model loop and separate durable inference ledger. These retain their original tests. The old WorkerRPC tool remains `task.contract_digest`; the newer conversation gateways do not claim full task/budget/worker-ledger integration. No fake contract or price is created to make a preview look integrated.

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

[Contracts](docs/contracts-v1.md), [durable core](docs/core-02.md), [control replay](docs/control-protocol.md), [native IPC](docs/native-ipc.md), [installation identity](docs/installation-identity.md), [queue/supervisor](docs/queue-supervisor.md), [foreground host](docs/process-host.md), [worker authority](docs/worker-authority.md), [duplex engine](docs/engine-duplex.md), [mock model streams](docs/model-streams.md), [inference ledger](docs/inference-ledger.md), [local conversation](docs/conversational-preview.md), and [public research](docs/public-research.md) document implemented boundaries and remaining limits. The current product roadmap governs priorities, not old infrastructure-only “next step” sections.

Existing developer data has explicit version transitions. Ordinary new stores use schema v2; v1 queue migration and optional v2-to-v3 mock inference require a safe point and a new backup. The conversation previews do not change those versions or store raw prompts in the task ledger. See the queue and inference documents before opening or migrating existing data. No example is an installer or restore wizard.

Linux Secret Service and Windows Credential Manager tests are separately opt-in and write disposable entries. Use an isolated test session and the [identity test instructions](docs/installation-identity.md). macOS currently has static portability and unsupported-native checks, not the native read gateway or native engine/Keychain support.

See [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [security boundaries](docs/security.md). Local-first means execution/state ownership on the user's device. Explicitly chosen remote inference may transmit permitted conversation and search context to its provider. `store:false` alone is not Zero Data Retention. No remote account access or undocumented credential reuse is implied.

Licensed under [Apache-2.0](LICENSE).
