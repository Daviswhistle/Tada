# Conversational public research — explicit API-key developer preview

This is a source-backed public research path within the existing `npm run assistant` entry point. It is a concrete intake/provider/presentation integration, not a new task form. It is also **not yet live-provider-qualified**: protocol, conversation and child-process tests use synthetic HTTP responses. No real OpenAI credential or paid inference was used during implementation. The 16 assistant-v1 product cases remain unrun.

## Intended user flow

Start `npm run assistant -- --web`. Choose a Responses API model, explicitly accept API billing/context transmission, and enter a key in the hidden prompt. Then speak normally: establish a subject, ask for investigation without supplying source links, and ask a follow-up such as “Make the earlier answer easier to understand.” The exact user text and actual accepted prior provider output are passed in order. The model chooses when and how to use public web research; no example phrase is routed to a script or supplied an evaluator oracle.

The existing local Ollama/source-discovery path remains available with its original arguments. Web research is a separate explicit choice, never a fallback when local inference fails. Local source roots, file contents and the local conversation are not silently copied into this API route. Each route currently has its own foreground conversation; unified permissions, conversation identity and cross-source working context are unfinished integration, not claimed by using one launcher.

The current web route has no screen, mailbox, calendar, local file, shell, phone, scheduling or external mutation tools. The assistant instruction explicitly distinguishes these unavailable observations from available conversation/public evidence. It asks a narrow question when a referent cannot be found, rather than pretending to see the user's screen. This restricted first route does not replace Tada's context-aware general-assistant product contract.

## Actual API contract

`packages/providers/src/research.ts` posts to the fixed official Responses endpoint using the API key supplied to this process. It uses `web_search`, `store:false`, `stream:false`, disabled input truncation, and explicit maximum output/tool-call bounds. This is **not the ChatGPT subscription/token-sharing serializer**, which has different requirements. No model alias is assumed to support the tool: the user selects the model; unsupported or denied requests stop without substituting another model/account.

Stateless follow-up replays every supported output item in order, including web-search items and provider-encrypted reasoning continuation. The opaque continuation is not decoded, shown, exported or automatically persisted. The visible answer contains only final/legacy assistant text, refusals and provider citation metadata. Commentary is preserved for replay but omitted from the answer. A refused or incomplete response is not a successful external action.

The full bounded HTTP body must finish and decode before any answer is accepted. Duplicate JSON keys, incomplete terminal state, malformed annotations, unsupported function/computer/MCP/code output, unsafe citation schemes and search answers without citations are rejected. Citation URLs are displayed, never followed by a client-side fetching tool. Valid observed usage survives a rejected/incomplete terminal response; unobserved usage remains unknown. These checks establish protocol integrity, not semantic truth or the reliability of cited pages.

## Consent, limits and cancellation

The key is entered without echo/history and kept only in the process. The CLI does not accept it in argv or read it from environment variables, another application's tokens, cookies or files. It requires a real interactive terminal before setup/network entry. Closing input or interrupting key setup cancels rather than leaving a prompt pending. Clearing JavaScript references is not secure zeroization of all memory copies.

Before requesting a key, the UI explains that this is separately billed API use and that the conversation and searches may be processed remotely. It exposes limits of 8 attempted requests per process, 4 built-in tool calls and 4096 output/reasoning tokens per request, 120 seconds per HTTP operation, 256 KiB response bodies and 192 KiB request context. There is no strict dollar cap, actual provider price table, account entitlement discovery, persistent usage ledger or restart-safe conversation in this preview. Starting another process is not claimed to preserve the same budget. Do not use this path for work requiring the daemon's existing hard accounting/continuation guarantees.

An entered failed request is never automatically retried. `/continue` asks for explicit acknowledgement that the previous request may have incurred usage and the next utterance is a new paid request. `/clear` deletes conversation/answers but does not refill allowances, erase attempts or bypass that acknowledgement. If producer cleanup was unconfirmed, acknowledgement cannot reopen the adapter. Ctrl+C aborts a current request; local cancellation is not proof of a remote refund or remote compute termination. Known late usage is retained without publishing a late answer.

The HTTP owner observes late rejections, cancels a late body, bounds reader cleanup and refuses to start another request from an adapter with uncertain cleanup. The first response is never cut into parseable fragments or silently replaced by another account. Fixed errors are shown rather than raw provider errors that could contain keys or user text.

## Results and export

Text is sanitized for terminal control and bidi characters. Provider URL citations appear with their corresponding text blocks. `/save` creates a new randomly named local HTML answer file with clickable source links, escaped model text, no embedded remote resources and a restrictive content-security policy. Existing files and occupied links are never overwritten. No automatic conversation log, credential, provider reasoning or opaque continuation enters that export.

This is an explicit user export in the current directory, not an agent filesystem tool and not the daemon's ART-01 verification/publication process. Source links do not certify every model assertion. The CLI never marks a Rust task SUCCEEDED or claims an external action occurred.

## Developer commands and evidence

Use the repository-pinned Node version and locked dependencies:

```sh
npm ci --ignore-scripts
npm run check
npm run assistant -- --web --help
npm run assistant -- --web
```

`--model MODEL_ID` may provide the explicit model choice; unsupported flags and pasted key arguments are rejected without echo. No default model or paid fallback is chosen for the user. The live command incurs API costs only after explicit consent and hidden credential entry; this implementation session did not execute it with real credentials.

New tests cover the provider serializer/parser and transport lifecycle, ordinary conversation/follow-up, usage and stop semantics, safe answer presentation/export, hidden-key handling, actual command routing and a separate CLI process with synthetic transport and TTY properties. The process test is not a physical-terminal qualification or actual model behavior. The local subset was typechecked and 37 pre-dispatch tests ran on Node 22.16.0; pinned full-repository results and the additional dispatcher test are recorded per commit in the PR. Existing Rust/native/local-model checks remain enabled.

## Why this is part of the same product work

The [Instinct reference](references/instinct.md) reinforces ordinary interaction, relevant working context and natural follow-up rather than requiring technical preparation. Tada's next integration should join existing conversation/source capabilities with a real authorized model and the host's permissions/receipts, not build another independent assistant for every channel. Public research now has an executable API path, but live compatibility and answer quality still need explicit authorized evidence. Broader screen/connected-source discovery and actual corrective actions remain essential next outcomes.

## Primary API sources checked 2026-10-05

- [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create): request fields, output items, limits and usage.
- [Web search guide](https://developers.openai.com/api/docs/guides/tools-web-search): built-in search, open/find actions, URL annotations and visible clickable citations.
- [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): stateless continuation with encrypted reasoning items and output-token accounting.
- [Data controls](https://developers.openai.com/api/docs/guides/your-data): `store:false` does not by itself establish Zero Data Retention.

These documents support serializer choices, not a claim that a particular selected account/model has passed Tada conformance or that this route is equivalent to official subscription integration.
