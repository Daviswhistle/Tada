//! Pure policy intersection. Text and declared provenance do not authenticate a
//! caller. The host-only install path establishes the authority source.
use tada_contracts::worker::{WorkerDecision, WorkerPolicy, WorkerProposal};

pub(super) fn evaluate(
    policy: &WorkerPolicy,
    call: &WorkerProposal,
    task: &str,
    contract_hash: &str,
) -> (WorkerDecision, &'static str) {
    use WorkerDecision::*;
    if policy.denied_tools.contains(&call.tool) {
        return (Deny, "EXPLICIT_DENY");
    }
    // Trusted catalog owns effects and accepted versions, not model arguments.
    if call.tool != "task.contract_digest" || call.tool_version.get() != 1 {
        return (Deny, "TOOL_NOT_REGISTERED");
    }
    if call.task_id != task
        || call.resource != format!("task://{task}/contract")
        || call.purpose != "verify_input_snapshot"
        || call.arguments.expected_hash != contract_hash
    {
        return (Deny, "TASK_SCOPE_MISMATCH");
    }
    let matched: Vec<_> = policy
        .rules
        .iter()
        .filter(|rule| {
            rule.tool == call.tool
                && rule.tool_version == call.tool_version
                && rule.resource == call.resource
                && rule.purpose == call.purpose
        })
        .map(|rule| rule.decision)
        .collect();
    // Explicit denial always wins; a decision/handoff cannot be diluted by an
    // additional ALLOW rule. References are exact, never prefix/wildcard matches.
    for (decision, reason) in [
        (Deny, "RULE_DENY"),
        (Handoff, "RULE_HANDOFF"),
        (RequireDecision, "RULE_DECISION"),
        (Allow, "ALLOWED"),
    ] {
        if matched.contains(&decision) {
            return (decision, reason);
        }
    }
    (RequireDecision, "NO_MATCHING_PERMISSION")
}
