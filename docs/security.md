# Security boundaries and review checklist

Status: design checklist, **not an independent security review**. This PR executes no end-user tools and stores no end-user secrets.

The source design §14 distinguishes authorized user requests/decisions and local policy from external data. Files, documents, repository content, web pages, tool output, and model proposals cannot confer authority. Preserve provenance even when a user explicitly asked to read a source.

Before real execution, reviewers must examine broker-only dispatch, authenticated local IPC, grant authenticity and revocation, expiry and fencing, cancellation races, capability intersections and deny precedence, immutable payload binding, credential egress, expected-hash conflict checks, symlink/reparse-point escape, stale observations, and recovery after lost responses. A passing JSON schema cannot establish any of these properties by itself.

The full-control host-shell profile is not a sandbox. Same-user process separation cannot promise file/network isolation or protection against a compromised user account. Restricted profiles may claim only isolation actually enforced and tested on the relevant OS. No generic shell, arbitrary desktop input, or plugin runtime is enabled by the contract package.

Use fake credentials and mock accounts in public fixtures. Diagnostics must not include instance values. CI validation jobs use read-only repository permissions, pinned action revisions, no model credentials, and no pull_request_target execution of contributed code. Dependency lockfiles must be reviewed with changes.

A nonpublic vulnerability reporting channel, responsible maintainer, response process, and release signing identity are still to be designated. Do not publish credentials or exploit material in a public issue to compensate for that missing channel. Public security advisories and release readiness require a maintainer decision.

## Dependency maintenance — 2026-10-10

Ajv is pinned to 8.20.0, replacing 8.17.1. This removes the reported
[optional `$data` ReDoS advisory](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6).
Tada does not enable `$data`; this maintenance does not imply that the vulnerable
option was exposed. Only Ajv and its lockfile entry changed; other dependency
versions, strict validators, schemas and fixtures are unchanged.

Clean installation and `npm audit` passed with zero reported vulnerabilities at
this date. All 1,101 Node checks, Rust formatting, Clippy, workspace tests and
agentd process fixtures passed. The bundled dependency also passed all 178
shared contract tests on native Windows, plus the eight portable and seven
running-upgrade checks. This is dependency and regression
evidence, not an independent security review or release qualification.

The rebuilt Windows archive contains 1,009 manifest files; every archive entry
was compared with the built bytes. Its SHA-256 is
`63d545f238884073afe3ae1ce24004b89c5af5089c051cd1bd3915ccbe0abbdc`.
The prior tray verification record describes the preceding archive and retains
its then-current advisory; it is not the dependency state of this rebuild.
