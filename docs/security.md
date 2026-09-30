# Security boundaries and review checklist

Status: design checklist, **not an independent security review**. This PR executes no end-user tools and stores no end-user secrets.

The source design §14 distinguishes authorized user requests/decisions and local policy from external data. Files, documents, repository content, web pages, tool output, and model proposals cannot confer authority. Preserve provenance even when a user explicitly asked to read a source.

Before real execution, reviewers must examine broker-only dispatch, authenticated local IPC, grant authenticity and revocation, expiry and fencing, cancellation races, capability intersections and deny precedence, immutable payload binding, credential egress, expected-hash conflict checks, symlink/reparse-point escape, stale observations, and recovery after lost responses. A passing JSON schema cannot establish any of these properties by itself.

The full-control host-shell profile is not a sandbox. Same-user process separation cannot promise file/network isolation or protection against a compromised user account. Restricted profiles may claim only isolation actually enforced and tested on the relevant OS. No generic shell, arbitrary desktop input, or plugin runtime is enabled by the contract package.

Use fake credentials and mock accounts in public fixtures. Diagnostics must not include instance values. CI validation jobs use read-only repository permissions, pinned action revisions, no model credentials, and no pull_request_target execution of contributed code. Dependency lockfiles must be reviewed with changes.

A nonpublic vulnerability reporting channel, responsible maintainer, response process, and release signing identity are still to be designated. Do not publish credentials or exploit material in a public issue to compensate for that missing channel. Public security advisories and release readiness require a maintainer decision.
