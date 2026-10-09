# Tada

현재 실행 경로의 [자동 실행과 복구](docs/background-running.md)는 설정에서 같은 비서를 Linux 사용자 서비스로 이어 실행합니다. WSL에서는 Linux 환경이 실행 중이어야 하며 Windows 부팅·절전 중 동작과 실제 휴대폰 수신은 별도 검증 대상입니다.

**Ask. Go live your life. Tada.**

Tada is being built as a personal AI assistant you can delegate to in ordinary language. You should not have to collect the documents, name the project, diagnose the error, or write a complete task specification first. The assistant should find the relevant context, work out what is needed, gather information, act through available tools, and check the result.

“Look into that company”, “This isn't working”, and “Make the earlier one simpler” are product acceptance requests, not shortcuts for prewritten workflows. The same request can mean different things in different conversations or screens. File, terminal, browser and app tools are means to do the work, not the product definition.

## Open Tada

On the currently supported Windows/WSL development host, run `npm start`. Tada opens a browser window, connects an existing ChatGPT subscription through its official login, and continues into the same saved conversation. No extra Tada password, terminal consent input, model number or device name is required. Connection failures can be retried in the window. Model choice is available on screen and saved for later starts.

The conversation now puts your message and the assistant's answer first. Account details and notifications are in Settings; saved work is expandable. Suggestions fill a draft without sending it, interrupted requests can be brought back for editing, and uncertain message admission preserves the draft and checks the same request before sending again.

This remains a development build requiring the repository's Node dependencies. It is not a signed installer. The optional background service operates only while its host is running. The new browser entry reuses the existing contact runtime, encrypted records and limits. It does not add general computer actions; live checks below qualify only their observed scopes. The advanced `npm run contact` entry remains available; `npm start -- --provider ollama --model YOUR_INSTALLED_LOCAL_MODEL` uses an explicitly selected installed local model. See [the experience and verification scope](docs/experience-2026-10-08.md).

The same conversation now supports [saved documents](docs/contact-documents.md): create a short Markdown/text document, download it, and revise it in a later message while preserving earlier versions. These are encrypted conversation results, not arbitrary filesystem changes or external publication. A bounded real subscription and Google check is recorded below; broad product and device acceptance remains incomplete.

A [bounded live check on 2026-10-09](docs/qualification-2026-10-07.md#2026-10-09--연결된-google-계정에서-문서-완성) used the selected ChatGPT subscription and a connected Google account to produce a saved document, recheck three cited sources and preserve it across restart. Mail results were truncated; this does not qualify comprehensive inbox review or the finished product. The [current subscription acceptance record](docs/qualification-2026-10-09.md) separately reports real-model behavior on fixed synthetic environments, including retained failures.

## Proactive suggestions and phone contact

[먼저 챙겨보기와 휴대폰 연락](docs/proactive-and-mobile.md)은 같은 대화의 설정에서 켭니다. 수시 확인을 선택하면 연결된 메일·일정을 15분마다 살펴보고, 변화가 있을 때 하루 최대 네 번 판단합니다. 시간 일정은 30분 전에 알리며 새 내용이 없으면 조용히 기다립니다. Telegram 연결은 화면에서 설정하고 휴대폰에서 같은 비서에게 이야기합니다. 기존 기록은 원본 백업 후 v5 업데이트를 본인이 선택해야 합니다. 실제 계정에서의 제안 품질과 휴대폰 송수신은 아직 검증하지 않았으며, 컴퓨터에서 Tada가 실행 중이어야 합니다.

[지속 사용](docs/continuing-use.md)을 켜면 누적 기록을 유지하며 최근 24시간 기준으로 사용 여유가 돌아옵니다. 최근 모델 문맥에서 빠진 대화·문서는 같은 암호화 기록에서 찾아 이어 쓸 수 있습니다. 기존 기록·권한을 자동 확대하지 않으며, 이 기능만으로 설치·항상 켜진 운영·실제 휴대폰 및 전체 제품 평가가 완료되는 것은 아닙니다.

## Continuing contact build

The current development tip includes a [browser contact host](docs/contact-assistant.md) with an encrypted conversation shared across paired devices, optional [private Telegram contact](docs/telegram-contact.md), [saved work](docs/contact-followups.md) and [one-time local reviews](docs/contact-reviews.md). Start it with `npm run contact -- --help`. The default contact route now uses [official ChatGPT subscription sign-in](docs/chatgpt-subscription.md); `--provider ollama` retains local-model support. Setup still requires development runtimes. Windows/WSL now uses the signed-in Windows account to protect storage without a separate Tada password; existing manual-password records use `--ask-passphrase`. Native Linux/macOS automatic protection is not yet supported. The subscription implementation has protocol/integration tests and bounded real inference evidence; general account compatibility, installation and always-on delivery remain incomplete.

The user requires a finished personal secretary with release quality. [The current completion target](docs/roadmap.md#completion-target--2026-10-07) includes real actions, installation, long-lived work and independent product acceptance. The developer previews below are narrower entry points, not the finished product.

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

**This is not yet the complete general-purpose assistant.** Current-screen observation, agent file modification, arbitrary commands, general external actions and a native desktop interface remain unconnected. When the contact host has its Google OAuth setup, that same conversation can read bounded recent Gmail inbox data and the upcoming primary-calendar week; it cannot send or modify mail/calendar items. See [Google connection and its current qualification limits](docs/google-connection.md). Durable conversation is available in the separate contact entry described above; these two terminal selections retain only session context. The local preview rechecks cited source bytes; public citations come from the provider. Neither mechanism independently proves every semantic claim or a successful external action. The terminal is a development entry point, not the intended final desktop experience.

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
