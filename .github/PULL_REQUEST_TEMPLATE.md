## User experience affected

Original ordinary-language request, without tester-added technical instructions:

What did the assistant need to discover rather than being handed a file, path, diagnosis or plan?

Observed user outcome and the actual result/target verification:

## Scope

State whether this is a product feature, component/security maintenance, or documentation/evaluation-definition change. For the latter two, do not imply new assistant capability. Identify the concrete blocker on the current delegation slice.

## Evidence

Relevant `assistant-v1` case IDs and actual outcome: passed / failed / blocked / not run. Keep unrun cases visible; do not count unit tests or mocked inference as product acceptance.

Actual model/route and implementation revision, context/source observations, tool receipts, outcome verification, user preparation and questions. Link redacted evidence, not secrets or private raw context. Evaluator setup and expected outputs must not be supplied to the assistant.

## Safety and continuity

Explain changed permissions, data exposure, current-target checks, contract/result lineage, cancellation and recovery behavior. Report relevant regressions actually run and any failures. “CI green” is not independent security review.

## Remaining integration

What part of the same user experience is still unavailable? What is the next concrete user-visible result, rather than the next abstract subsystem?

Base/head dependency and integration/merge status:
