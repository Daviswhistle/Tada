# Conversational preview: find information without a prepared task

This is the first executable slice following the [corrected product contract](product-contract.md). A foreground conversation uses a real, explicitly selected local Ollama model to choose reusable source tools, read relevant text and answer with source references. The same in-memory conversation supports follow-up. It is a **read-only developer preview**, not the complete personal assistant or an end-user installer.

## User entry and setup

The user does not provide a TaskContract, exact document path, tool plan or an attachment with each message. The trusted launcher selects a model and grants readable source directories once. The model receives opaque source IDs and labels, not an option to grant itself another root. Source selection is setup/consent, not selecting the answer file for a test.

With the repository-pinned Node and Rust toolchains and an already installed local tool-capable Ollama model:

```sh
npm ci --ignore-scripts
cargo build --locked -p tada-agentd --bin tada-read-broker
npm run assistant -- --model YOUR_INSTALLED_LOCAL_MODEL --broker ABSOLUTE_PATH_TO_TADA_READ_BROKER --allow-read YOUR_NOTES_DIRECTORY
```

Replace the two paths with actual paths; Windows's gateway binary ends in `.exe`. Additional `--allow-read DIRECTORY` options add up to eight sources. Without a source the assistant can converse but cannot invent current context. `--help` shows the current limits. Configure your own trusted Ollama server with `OLLAMA_NO_CLOUD=1`; the preview connects only to an explicit `http://127.0.0.1:PORT` endpoint. It never installs Ollama, pulls a model, reads a provider key, starts a service or switches to cloud inference.

Then type ordinary messages, for example asking what is blocking a project and who owns the next action, followed by “make that shorter.” The engine does not branch on those phrases. `/forget` explicitly clears the in-memory conversation without refunding the lifetime request meter; `/exit` exits. Ctrl+C cancels an active request. After an interrupted protocol or resource-limit stop, the preview requires an explicit context reset rather than silently dropping history and pretending to resume.

## What is connected

`assistant-cli.mjs` supplies the foreground conversation surface. `conversation.ts` is a general model/tool loop with no evaluator case IDs or fixtures in its prompt. `ollama-local.mjs` uses the native chat API with messages and function tools. It checks an installed local GGUF model, declared completion/tool capabilities, and its digest before sending conversation text. Full JSON completion with a compatible finish reason is required before any tool proposal. Thinking text is neither displayed nor retained.

`native-sources.mjs` dispatches only `list_sources`, `list_files` and `read_file` to the checked-in Rust `tada-read-broker` executable using argument arrays and a cleaned environment. There is no shell command, file mutation, public HTTP control listener or model-supplied root. This preview uses one small read-specific launcher boundary; it does **not** claim integration with the older fixed `task.contract_digest` WorkerRPC, mock-model accounting route or task queue. Those components and their tests remain intact for subsequent durable integration. No fake TaskContract or mock pricing record is created for a real conversation.

Linux opens each component relative to an owned directory handle with no-follow and checks the source device. Directory enumeration uses the opened descriptor. Windows holds non-deletable/non-writable ancestor handles, rejects reparse points and uses file-handle identity. The launcher pins each root's identity at enrollment and the gateway rechecks it for each operation. Symlinks/reparse points, hardlinked text, traversal, Windows device/UNC namespaces, hidden path components, obvious secret filenames and unsupported types are refused rather than repaired.

These checks defend this gateway's scoped reads, not all actions of a compromised same-user process. The model server, launcher and checked-in native executable are trusted host code. A malicious local server can lie about its identity or forward data; a loopback address alone is not proof of an offline computation. The CI starts a checked Ollama runtime with cloud disabled and synthetic inputs, separately from user's installations. Filename exclusions are conservative filters, not complete secret discovery. Choose appropriate source directories rather than assuming arbitrary personal data is safe to expose.

## Evidence and limits

Listings are paged (64 entries, up to 4096 scanned directory entries) and explicitly return a continuation offset; they are not file-content evidence or a transactionally stable directory snapshot. Reads accept UTF-8 plain text up to 8 KiB with `.txt`, `.md`, `.csv`, `.json`, `.log` or `.rst` names. Hash and metadata checks detect observed changes, and cited files are reopened and rehashed before returning a sourced answer. A changed source stops that answer. Mutation during a read or malicious same-user filesystem changes are not universally eliminated by metadata checks; this is not filesystem isolation.

Actual reads get source references such as `[S1]`. The controller rejects invented identifiers, requests one bounded citation correction when necessary, and rechecks cited bytes. This proves which bytes were available and still match, **not that every sentence is semantically correct**. It does not establish exhaustive research or independent task acceptance, and never writes a task SUCCEEDED state. Evaluators must still inspect source relevance, conclusions and omissions.

The preview limits a message to 4 KiB, serialized model context including tool descriptions to 14 KiB, a user turn to 12 model requests and 24 tool calls, and a foreground session to 64 requests. A user turn has a ten-minute deadline; one local HTTP request has a three-minute deadline and each native read a five-second deadline. Local output uses 768 requested prediction tokens and a 16384-token model context setting. The byte check is a conservative client resource limit, not provider token accounting or a production large-context promise. Completed request token counts are observed; interrupted requests remain uncertain. No paid-provider dollar budget is claimed.

Conversation, source evidence and these counters live in process memory. Nothing writes raw prompts or model reasoning to the existing SQLite ledger. Process exit loses conversational context; encrypted persistence, richer memory retrieval and safe resume are remaining work. Source files are never modified. The preview has no live screen/app observation, web search, email/calendar connector, report-file publication, arbitrary terminal tool or desktop UI. “This isn't working” without available context should prompt a narrow question, not a fabricated diagnosis.

## Verification and actual-model evidence

Existing npm/Rust/native/model/vault CI remains enabled. Added tests cover conversation continuity, batch validation, source-data roles, citation integrity, stale sources, cancellation, context limits, repeated failures, concurrent messages, CLI arguments, JSON bounds, local-provider identity/redirects/complete replies and native path/type/hardlink/pagination behavior. Scripted model responses in those tests are only plumbing fixtures.

`evals/assistant-v1/local-model-smoke.mjs` is a separate **real local-model smoke**, executed in the additional read-only CI workflow. It creates two predetermined synthetic contexts with the same user wording but different blockers, owners and next actions. Source paths contain a new random suffix and are not included in the user/model prompt. The actual model must discover sources through the production tools and respond to a same-conversation shortening request. The evaluator, not the product, holds expected facts. It checks both answers, actual tool observations, citations and shortening; all variants, including failures, remain in the report. The CLI itself is a thin wrapper around this same controller/provider/gateway path.

The smoke records runtime version, exact installed model digest, implementation SHA, utterances, answers, source observations, usage and checks. It is not a benchmark for investment research, screen diagnosis or all natural-language variations. English smoke requests do not establish Korean quality. The sixteen assistant-v1 product cases remain unrun; their baseline is unchanged. Per-head CI and live-smoke conclusions belong in the PR, not inferred from code existence.

The isolated CI explicitly downloads a checksum-verified Ollama v0.34.0 archive and `qwen3:4b` model weights. This uses runner compute and public downloads, not a paid model API or personal account. The model is a smoke-test choice, not a product recommendation or an automatically selected user default. Model pulls occur only in that explicit test workflow. The product never downloads a model.

## Next user-visible expansion

Keep the same conversation interface while adding permitted current-environment observations and public/connected source search, then result-producing tools through the existing durable authority/publication path. Introduce encrypted conversation/task linkage in the actual path rather than inventing a completed contract at intake. Preserve the distinction between this useful read-only slice and the user's broader “treat it like a human assistant” goal.

API references checked 2026-10-04: [Ollama chat](https://docs.ollama.com/api/chat), [tool calling](https://docs.ollama.com/capabilities/tool-calling), [local-only configuration](https://docs.ollama.com/faq), [Rust Windows OpenOptionsExt](https://doc.rust-lang.org/std/os/windows/fs/trait.OpenOptionsExt.html), [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle). The references specify APIs, not independently certified Tada guarantees.
