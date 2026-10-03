use super::*;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        Self(std::env::temp_dir().join(format!("tada-sec01-{}", digest(&random))))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn contract(id: &str) -> tada_contracts::TaskContract {
    tada_contracts::decode(&json!({"task_id":id,"contract_version":1,"goal":"worker authority fixture","inputs":[],"deliverables":[],"acceptance":["user.result.unmet"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"worker-fixture","on_budget_exhaustion":"save_and_request_decision","assumptions":[]})).unwrap()
}
fn policy_for(task: &str) -> WorkerPolicy {
    decode(&json!({"schema_version":1,"profile_id":"worker-fixture","revision":1,"origin":"local_policy","denied_tools":[],"rules":[{"tool":"task.contract_digest","tool_version":1,"resource":format!("task://{task}/contract"),"purpose":"verify_input_snapshot","decision":"ALLOW"}],"max_calls":4,"grant_ttl_ms":20000})).unwrap()
}
fn proposal(lease: &WorkLease, id: &str) -> WorkerProposal {
    decode(&json!({"schema_version":1,"call_id":id,"task_id":lease.task_id(),"tool":"task.contract_digest","tool_version":1,"resource":format!("task://{}/contract",lease.task_id()),"purpose":"verify_input_snapshot","arguments":{"expected_hash":lease.contract_hash()}})).unwrap()
}
fn setup(root: &Path) -> (Store, WorkLease, WorkerChannel, WorkerProposal) {
    let mut s = Store::open(root).unwrap();
    s.create_task(&contract("worker-task"), 0).unwrap();
    s.set_worker_policy("worker-task", &policy_for("worker-task"))
        .unwrap();
    let lease = s
        .claim_work("worker-host", 0, Duration::from_secs(60))
        .unwrap()
        .unwrap();
    let channel = s
        .open_worker_channel(&lease, Duration::from_secs(30))
        .unwrap();
    let call = proposal(&lease, "call-a");
    (s, lease, channel, call)
}
fn grant(s: &mut Store, channel: &WorkerChannel, proposal: &WorkerProposal) -> WorkerGrant {
    let result = s.authorize_worker_call(channel, proposal).unwrap();
    assert_eq!(result.decision, WorkerDecision::Allow);
    encode(&result).unwrap();
    result.grant.unwrap()
}
fn request(call: &WorkerProposal, grant: &WorkerGrant, id: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tool.invoke","params":{"grant_ref":grant.grant_id,"proposal":call,"policy_revision":grant.policy_revision,"generation":grant.generation,"cancel_epoch":grant.cancel_epoch,"fencing_token":grant.fencing_token}})
}
fn invoke(s: &mut Store, channel: &WorkerChannel, req: &Value) -> Result<WorkerReply> {
    let bytes = s.invoke_worker(channel, &serde_json::to_vec(req).unwrap())?;
    decode(&serde_json::from_slice(&bytes).unwrap())
}
fn count(s: &Store, kind: &str) -> i64 {
    s.conn
        .query_row("SELECT count(*) FROM events WHERE kind=?1", [kind], |r| {
            r.get(0)
        })
        .unwrap()
}
fn tip(s: &Store) -> i64 {
    s.conn
        .query_row("SELECT witness_seq FROM metadata", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn policy_required_and_invalid_policy_never_changes_task_authority() {
    let temp = Temp::new();
    let mut s = Store::open(&temp.0).unwrap();
    s.create_task(&contract("worker-task"), 0).unwrap();
    let lease = s
        .claim_work("host", 0, Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert!(matches!(
        s.open_worker_channel(&lease, Duration::from_secs(5)),
        Err(Error::Denied("WORKER_POLICY_REQUIRED"))
    ));
    let before = tip(&s);
    let mut policy = policy_for("worker-task");
    policy.profile_id = "another-profile".into();
    assert!(s.set_worker_policy("worker-task", &policy).is_err());
    assert_eq!(tip(&s), before);
    assert!(!s.poisoned);
}
#[test]
fn authorized_digest_is_atomic_read_evidence_not_user_task_completion() {
    let temp = Temp::new();
    let (mut s, lease, channel, call) = setup(&temp.0);
    let before = s.task(lease.task_id()).unwrap();
    let g = grant(&mut s, &channel, &call);
    let result = invoke(&mut s, &channel, &request(&call, &g, "rpc-a")).unwrap();
    assert_eq!(result.result.contract_hash, lease.contract_hash());
    assert_eq!(result.result.side_effect_state, "none");
    assert!(!result.result.replayed);
    assert_eq!(s.task(lease.task_id()).unwrap(), before);
    assert_eq!(count(&s, "worker.call_completed"), 1);
    assert_eq!(s.budget_committed(lease.task_id()).unwrap(), 0);
}
#[test]
fn every_nonallow_decision_issues_no_grant_and_deny_wins_conflicts() {
    for decision in [
        WorkerDecision::Deny,
        WorkerDecision::RequireDecision,
        WorkerDecision::Handoff,
    ] {
        let temp = Temp::new();
        let (mut s, _, channel, call) = setup(&temp.0);
        let mut policy = policy_for("worker-task");
        let mut rule = policy.rules[0].clone();
        rule.decision = decision;
        policy.rules.push(rule);
        policy.revision = si(2).unwrap();
        s.set_worker_policy("worker-task", &policy).unwrap();
        let before = tip(&s);
        let result = s.authorize_worker_call(&channel, &call).unwrap();
        assert_eq!(result.decision, decision);
        assert!(result.grant.is_none());
        encode(&result).unwrap();
        assert_eq!(tip(&s), before);
        policy.denied_tools.push("task.contract_digest".into());
        policy.revision = si(3).unwrap();
        s.set_worker_policy("worker-task", &policy).unwrap();
        assert_eq!(
            s.authorize_worker_call(&channel, &call).unwrap().decision,
            WorkerDecision::Deny
        );
        assert_eq!(count(&s, "worker.grant_issued"), 0);
    }
}
#[test]
fn unmatched_exact_resource_requires_decision_and_task_scope_never_expands() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let mut policy = policy_for("worker-task");
    policy.rules[0].resource = "task://worker-task".into();
    policy.revision = si(2).unwrap();
    s.set_worker_policy("worker-task", &policy).unwrap();
    assert_eq!(
        s.authorize_worker_call(&channel, &call).unwrap().decision,
        WorkerDecision::RequireDecision
    );
    for field in ["task", "resource", "purpose", "hash"] {
        let mut bad = call.clone();
        match field {
            "task" => bad.task_id = "other-task".into(),
            "resource" => bad.resource.push_str("/../other"),
            "purpose" => bad.purpose = "upload".into(),
            _ => bad.arguments.expected_hash = "0".repeat(64),
        }
        assert_eq!(
            s.authorize_worker_call(&channel, &bad).unwrap().decision,
            WorkerDecision::Deny
        );
    }
}
#[test]
fn a_policy_allow_cannot_register_a_tool_or_downgrade_its_effect() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    for (i, tool) in [
        "process.start",
        "credential.export",
        "policy.self_modify",
        "file.read",
        "desktop.act",
    ]
    .into_iter()
    .enumerate()
    {
        let mut policy = policy_for("worker-task");
        policy.revision = si(i as i64 + 2).unwrap();
        policy.rules[0].tool = tool.into();
        s.set_worker_policy("worker-task", &policy).unwrap();
        let mut bad = call.clone();
        bad.tool = tool.into();
        assert_eq!(
            s.authorize_worker_call(&channel, &bad).unwrap().decision,
            WorkerDecision::Deny
        );
    }
    assert_eq!(count(&s, "worker.grant_issued"), 0);
}
#[test]
fn stable_call_identity_never_refreshes_grant_expiry_or_allocates_twice() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let before = tip(&s);
    assert_eq!(grant(&mut s, &channel, &call), g);
    assert_eq!(tip(&s), before);
    let mut call2 = call.clone();
    call2.call_id = "call-b".into();
    let g2 = grant(&mut s, &channel, &call2);
    assert_ne!(g2.grant_id, g.grant_id);
    assert_eq!(count(&s, "worker.grant_issued"), 2);
}
#[test]
fn replay_returns_one_committed_result_and_normalizes_integral_counters() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let req = request(&call, &g, "rpc-a");
    invoke(&mut s, &channel, &req).unwrap();
    let before = tip(&s);
    let mut again = req;
    again["id"] = json!("rpc-after-response-loss");
    again["params"]["fencing_token"] = json!(n(g.fencing_token) as f64);
    again["params"]["proposal"]["tool_version"] = json!(1.0);
    let reply = invoke(&mut s, &channel, &again).unwrap();
    assert!(reply.result.replayed);
    assert_eq!(reply.id, "rpc-after-response-loss");
    assert_eq!(tip(&s), before);
    assert_eq!(count(&s, "worker.call_completed"), 1);
}
#[test]
fn borrowed_grant_and_worker_authored_binding_changes_do_not_admit() {
    let temp = Temp::new();
    let (mut s, lease, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let req = request(&call, &g, "rpc-a");
    let other = s
        .open_worker_channel(&lease, Duration::from_secs(30))
        .unwrap();
    assert!(invoke(&mut s, &other, &req).is_err());
    for (field, value) in [
        ("grant_ref", json!("invented")),
        ("fencing_token", json!(999)),
        ("generation", json!(999)),
        ("cancel_epoch", json!(1)),
        ("policy_revision", json!(999)),
    ] {
        let mut bad = req.clone();
        bad["params"][field] = value;
        assert!(invoke(&mut s, &channel, &bad).is_err(), "{field}");
    }
    let mut bad = req.clone();
    bad["params"]["proposal"]["call_id"] = json!("another-call");
    assert!(invoke(&mut s, &channel, &bad).is_err());
    assert_eq!(count(&s, "worker.call_completed"), 0);
    assert!(!s.poisoned);
    invoke(&mut s, &channel, &req).unwrap();
}
#[test]
fn policy_revision_is_durable_and_old_grants_never_inherit_new_approval() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let mut policy = policy_for("worker-task");
    policy.max_calls = si(5).unwrap();
    assert!(matches!(
        s.set_worker_policy("worker-task", &policy),
        Err(Error::Denied("WORKER_POLICY_REVISION_REUSED"))
    ));
    policy.revision = si(2).unwrap();
    s.set_worker_policy("worker-task", &policy).unwrap();
    assert!(invoke(&mut s, &channel, &request(&call, &g, "rpc-a")).is_err());
    assert!(s.authorize_worker_call(&channel, &call).is_err());
    let mut next = call.clone();
    next.call_id = "fresh-policy-call".into();
    let fresh = grant(&mut s, &channel, &next);
    assert_eq!(n(fresh.policy_revision), 2);
    drop(s);
    let s = Store::open(&temp.0).unwrap();
    assert_eq!(
        n(latest_policy(&s.conn, "worker-task")
            .unwrap()
            .unwrap()
            .revision),
        2
    );
}
#[test]
fn revoke_is_idempotent_and_even_a_cached_result_requires_current_authority() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let req = request(&call, &g, "rpc-a");
    invoke(&mut s, &channel, &req).unwrap();
    s.revoke_worker_grant(&channel, &g.grant_id).unwrap();
    let before = tip(&s);
    s.revoke_worker_grant(&channel, &g.grant_id).unwrap();
    assert_eq!(tip(&s), before);
    assert!(invoke(&mut s, &channel, &req).is_err());
    assert_eq!(count(&s, "worker.call_completed"), 1);
    s.revoke_worker_channel(&channel).unwrap();
    let before = tip(&s);
    s.revoke_worker_channel(&channel).unwrap();
    assert_eq!(tip(&s), before);
    assert!(s.authorize_worker_call(&channel.clone(), &call).is_err());
}
#[test]
fn grant_limit_is_reserved_at_issue_and_revocation_does_not_refill_it() {
    let temp = Temp::new();
    let (mut s, _, channel, mut call) = setup(&temp.0);
    for i in 0..4 {
        call.call_id = format!("call-{i}");
        let g = grant(&mut s, &channel, &call);
        s.revoke_worker_grant(&channel, &g.grant_id).unwrap();
    }
    call.call_id = "call-over-limit".into();
    assert!(matches!(
        s.authorize_worker_call(&channel, &call),
        Err(Error::Denied("WORKER_GRANT_LIMIT"))
    ));
    assert_eq!(count(&s, "worker.grant_issued"), 4);
}
#[test]
fn cancellation_before_issue_or_before_invoke_blocks_new_admission() {
    for already_issued in [false, true] {
        let temp = Temp::new();
        let (mut s, _, channel, call) = setup(&temp.0);
        let g = already_issued.then(|| grant(&mut s, &channel, &call));
        s.cancel("worker-task").unwrap();
        assert!(s.authorize_worker_call(&channel, &call).is_err());
        if let Some(g) = g {
            assert!(invoke(&mut s, &channel, &request(&call, &g, "rpc-a")).is_err());
        }
        assert_eq!(count(&s, "worker.call_completed"), 0);
        assert_eq!(s.task("worker-task").unwrap().cancel_epoch.get(), 1);
    }
}
#[test]
fn monotonic_grant_and_channel_expiry_do_not_wait_for_wall_clock() {
    for seconds in [21, 31] {
        let temp = Temp::new();
        let (mut s, _, channel, call) = setup(&temp.0);
        let g = grant(&mut s, &channel, &call);
        // Advance the existing clock origin, preserving time spent in setup.
        // Replacing it with now-minus-N can leave a late-issued grant unexpired.
        s.clock = s.clock.checked_sub(Duration::from_secs(seconds)).unwrap();
        assert!(matches!(
            invoke(&mut s, &channel, &request(&call, &g, "rpc-a")),
            Err(Error::Denied("WORKER_EXPIRED"))
        ));
        assert!(s.authorize_worker_call(&channel, &call).is_err());
        assert_eq!(count(&s, "worker.call_completed"), 0);
    }
}
#[test]
fn restart_foreign_store_stale_fence_and_host_policy_changes_reject_channels() {
    let temp = Temp::new();
    let (mut s, lease, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let req = request(&call, &g, "rpc-a");
    let foreign = Temp::new();
    let mut other = Store::open(&foreign.0).unwrap();
    assert!(invoke(&mut other, &channel, &req).is_err());
    s.defer_work(&lease, 0).unwrap();
    let new_lease = s
        .claim_work("next-host", 0, Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert!(invoke(&mut s, &channel, &req).is_err());
    let fresh = s
        .open_worker_channel(&new_lease, Duration::from_secs(30))
        .unwrap();
    let call2 = proposal(&new_lease, "new-call");
    let g2 = grant(&mut s, &fresh, &call2);
    s.set_mock_policy_denied(false).unwrap();
    assert!(invoke(&mut s, &fresh, &request(&call2, &g2, "rpc-b")).is_err());
    drop(s);
    let mut reopened = Store::open(&temp.0).unwrap();
    assert!(invoke(&mut reopened, &channel, &req).is_err());
    assert_eq!(count(&reopened, "worker.call_completed"), 0);
}
#[test]
fn malformed_unknown_and_duplicate_raw_requests_do_not_poison_valid_channels() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let req = request(&call, &g, "rpc-a");
    let raw = serde_json::to_string(&req).unwrap();
    for bad in [
        String::new(),
        "x".repeat(MAX_WORKER_BODY + 1),
        raw[..raw.len() / 2].into(),
        format!("{raw}{{}}"),
        raw.replace("\"rpc-a\"", "\"rpc-a\",\"id\":\"duplicate\""),
        raw.replace(
            "\"expected_hash\":",
            "\"expected_hash\":\"fake\",\"expected_hash\":",
        ),
    ] {
        assert!(s.invoke_worker(&channel, bad.as_bytes()).is_err());
        assert!(!s.poisoned);
    }
    for field in ["effect", "origin", "subject", "success", "command"] {
        let mut bad = req.clone();
        bad["params"][field] = json!("self-approved");
        assert!(invoke(&mut s, &channel, &bad).is_err());
    }
    let mut bad = req.clone();
    bad["method"] = json!("policy.set");
    assert!(invoke(&mut s, &channel, &bad).is_err());
    invoke(&mut s, &channel, &req).unwrap();
}
#[test]
fn failed_event_commit_preserves_budget_and_never_returns_uncommitted_success() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    let before = tip(&s);
    s.conn.execute_batch("CREATE TRIGGER inject_worker_failure BEFORE INSERT ON events WHEN new.kind='worker.call_completed' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(invoke(&mut s, &channel, &request(&call, &g, "rpc-a")).is_err());
    assert!(s.poisoned);
    assert_eq!(tip(&s), before);
    assert_eq!(count(&s, "worker.call_completed"), 0);
    assert!(s.create_task(&contract("blocked"), 0).is_err());
}
#[test]
fn corrupted_admission_and_policy_records_stop_further_store_mutations() {
    for kind in ["worker.call_completed", "worker.policy_set"] {
        let temp = Temp::new();
        let (mut s, _, channel, call) = setup(&temp.0);
        let g = grant(&mut s, &channel, &call);
        let key = if kind == "worker.policy_set" {
            policy_key("worker-task")
        } else {
            g.grant_id.clone()
        };
        s.conn
            .execute(
                "INSERT INTO events(aggregate_id,kind,payload) VALUES(?1,?2,'{}')",
                params![key, kind],
            )
            .unwrap();
        assert!(matches!(
            invoke(&mut s, &channel, &request(&call, &g, "rpc-a")),
            Err(Error::RecoveryRequired)
        ));
        assert!(s.poisoned);
        assert!(s.create_task(&contract("blocked"), 0).is_err());
    }
}
#[test]
fn channel_and_grant_events_contain_no_raw_task_text_or_credential() {
    let temp = Temp::new();
    let (mut s, _, channel, call) = setup(&temp.0);
    let g = grant(&mut s, &channel, &call);
    invoke(&mut s, &channel, &request(&call, &g, "rpc-a")).unwrap();
    let mut stmt = s
        .conn
        .prepare("SELECT payload FROM events WHERE kind LIKE 'worker.%'")
        .unwrap();
    for raw in stmt.query_map([], |r| r.get::<_, String>(0)).unwrap() {
        let raw = raw.unwrap();
        assert!(!raw.contains("worker authority fixture"));
        assert!(!raw.contains("user.result.unmet"));
    }
    assert!(!format!("{channel:?}").contains(channel.subject()));
}

#[test]
fn crash_child() {
    let Some(root) = std::env::var_os("TADA_TEST_ROOT") else {
        return;
    };
    let (mut s, _, channel, call) = setup(Path::new(&root));
    let g = grant(&mut s, &channel, &call);
    invoke(&mut s, &channel, &request(&call, &g, "rpc-a")).unwrap();
    s.revoke_worker_grant(&channel, &g.grant_id).unwrap();
    panic!("requested worker fault boundary not reached");
}
#[test]
fn nine_process_kill_boundaries_preserve_grants_receipts_and_revocations() {
    let phases = [
        "worker_issue.before",
        "worker_issue.witness",
        "worker_issue.commit",
        "worker_invoke.before",
        "worker_invoke.witness",
        "worker_invoke.commit",
        "worker_revoke.before",
        "worker_revoke.witness",
        "worker_revoke.commit",
    ];
    assert_eq!(phases.len(), 9, "fixed SEC-01A fault denominator");
    for phase in phases {
        let temp = Temp::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "control::worker::tests::crash_child",
                "--nocapture",
            ])
            .env("TADA_TEST_ROOT", &temp.0)
            .env("TADA_TEST_PHASE", phase)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !temp.0.join("boundary.ready").exists() && Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("child exited before {phase}: {status}");
            }
            thread::sleep(Duration::from_millis(10));
        }
        let reached = temp.0.join("boundary.ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(reached, "{phase}");
        if phase.ends_with(".witness") {
            assert!(
                matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)),
                "{phase}"
            );
            assert_eq!(Store::inspect(&temp.0).unwrap().len(), 1);
        } else {
            let mut s = Store::open(&temp.0).unwrap();
            let expected_grants = i64::from(phase != "worker_issue.before");
            let expected_calls =
                i64::from(phase == "worker_invoke.commit" || phase.starts_with("worker_revoke."));
            assert_eq!(count(&s, "worker.grant_issued"), expected_grants, "{phase}");
            assert_eq!(
                count(&s, "worker.call_completed"),
                expected_calls,
                "{phase}"
            );
            assert_eq!(
                count(&s, "worker.grant_revoked"),
                i64::from(phase == "worker_revoke.commit")
            );
            let lease = s
                .claim_work("restart", 0, Duration::from_secs(60))
                .unwrap()
                .unwrap();
            let channel = s
                .open_worker_channel(&lease, Duration::from_secs(30))
                .unwrap();
            if expected_grants > 0 {
                let raw: String = s
                    .conn
                    .query_row(
                        "SELECT payload FROM events WHERE kind='worker.grant_issued' LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                let old: GrantRecord = serde_json::from_str(&raw).unwrap();
                assert!(invoke(
                    &mut s,
                    &channel,
                    &request(&old.proposal, &old.grant, "old-grant")
                )
                .is_err());
            }
            assert_eq!(count(&s, "worker.call_completed"), expected_calls);
            assert_eq!(
                s.task("worker-task").unwrap().completion_status,
                tada_contracts::CompletionStatus::Pending
            );
        }
        println!("worker fault {phase}: passed");
    }
}
