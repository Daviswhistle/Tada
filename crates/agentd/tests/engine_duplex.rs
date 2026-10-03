#![cfg(any(target_os = "linux", windows))]
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut bytes = [0; 12];
        getrandom::fill(&mut bytes).unwrap();
        Self(std::env::temp_dir().join(format!(
            "t9-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_tada-agentd"))
}
fn run(mut command: Command) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(40);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("duplex host exceeded fixed outer timeout");
    }
    child.wait_with_output().unwrap()
}
fn demo(root: &Temp, node: Option<&PathBuf>, mode: Option<&str>, canary: bool) -> Value {
    let mut command = binary();
    command
        .arg(if node.is_some() {
            "demo-typescript"
        } else {
            "demo-engine"
        })
        .arg(&root.0);
    if let Some(node) = node {
        command.arg(node);
    }
    if let Some(mode) = mode {
        command.arg(mode);
    }
    if canary {
        command
            .env("TADA_SECRET_CANARY", "FAKE-ENGINE-SECRET")
            .env("OPENAI_API_KEY", "FAKE-ENGINE-SECRET")
            .env("NODE_OPTIONS", "--this-must-not-reach-node")
            .env("PYTHONPATH", "FAKE-ENGINE-SECRET");
    }
    let output = run(command);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("FAKE-ENGINE-SECRET"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("FAKE-ENGINE-SECRET"));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["broker_enabled"], true);
    assert_eq!(value["report"]["reaped"], true);
    assert_eq!(value["queued_cancel_epoch"], 1);
    assert_eq!(value["task"]["completion_status"], "PENDING");
    assert_eq!(
        value["task"]["unmet_required_criteria"],
        serde_json::json!(["actual-user-result-not-published"])
    );
    value
}
fn conn(root: &Temp) -> Connection {
    Connection::open_with_flags(
        root.0.join("data/state.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
fn events(root: &Temp, kind: &str) -> i64 {
    conn(root)
        .query_row("SELECT count(*) FROM events WHERE kind=?1", [kind], |r| {
            r.get(0)
        })
        .unwrap()
}
fn checkpoints(root: &Temp) -> i64 {
    conn(root)
        .query_row("SELECT count(*) FROM work_checkpoints", [], |r| r.get(0))
        .unwrap()
}
fn success(root: &Temp, value: &Value) {
    assert_eq!(value["report"]["cause"], "completed");
    assert!(value["report"]["checkpoint"].is_string());
    assert_eq!(events(root, "worker.channel_opened"), 1);
    assert_eq!(events(root, "worker.grant_issued"), 1);
    assert_eq!(events(root, "worker.call_completed"), 1);
    assert_eq!(events(root, "worker.channel_revoked"), 1);
    assert_eq!(events(root, "worker.probe_started"), 1);
    assert_eq!(events(root, "worker.probe_reaped"), 1);
    assert_eq!(checkpoints(root), 1);
    let store = tada_store::Store::open(&root.0.join("data")).unwrap();
    assert_ne!(
        store.task("probe-a").unwrap().completion_status,
        tada_contracts::CompletionStatus::Succeeded
    );
}
#[test]
fn builtin_duplex_proposal_grant_invoke_replay_exit_and_checkpoint_use_one_ledger_result() {
    let root = Temp::new();
    success(&root, &demo(&root, None, None, false));
}
#[test]
fn engine_entry_rejects_partial_duplicate_unknown_and_oversized_bootstrap() {
    for bytes in [
        vec![255; 4],
        vec![0, 0, 0, 100, b'{'],
        {
            let p = br#"{"schema_version":1,"schema_version":1}"#;
            let mut b = (p.len() as u32).to_be_bytes().to_vec();
            b.extend_from_slice(p);
            b
        },
        {
            let p = br#"{"command":"shell"}"#;
            let mut b = (p.len() as u32).to_be_bytes().to_vec();
            b.extend_from_slice(p);
            b
        },
    ] {
        let mut child = binary()
            .arg("--engine-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = child.stdin.take().unwrap().write_all(&bytes);
        let result = child.wait_with_output().unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }
}
#[test]
fn explicit_runtime_path_and_occupied_demo_root_are_rejected_without_repair() {
    let root = Temp::new();
    let mut cmd = binary();
    cmd.arg("demo-typescript").arg(&root.0).arg("relative-node");
    assert!(!run(cmd).status.success());
    assert!(!root.0.exists());
    std::fs::create_dir(&root.0).unwrap();
    std::fs::write(root.0.join("keep"), b"preserve").unwrap();
    let mut cmd = binary();
    cmd.arg("demo-engine").arg(&root.0);
    assert!(!run(cmd).status.success());
    assert_eq!(std::fs::read(root.0.join("keep")).unwrap(), b"preserve");
}
#[cfg(not(feature = "process-fixtures"))]
#[test]
fn normal_host_has_no_engine_fault_switch() {
    let root = Temp::new();
    let mut cmd = binary();
    cmd.arg("demo-engine").arg(&root.0).arg("lost-reply");
    assert!(!run(cmd).status.success());
    assert!(!root.0.exists());
}

#[cfg(feature = "process-fixtures")]
fn node() -> PathBuf {
    // Test setup only. The product CLI never searches PATH for its runtime.
    let out = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("pinned Node is required for the duplex conformance suite");
    assert!(out.status.success());
    let path = PathBuf::from(String::from_utf8(out.stdout).unwrap().trim());
    assert!(path.is_absolute());
    path
}
#[cfg(feature = "process-fixtures")]
#[test]
fn all_nonallow_outcomes_cross_pipe_without_grant_invocation_or_checkpoint() {
    for mode in ["deny", "decision", "handoff"] {
        let root = Temp::new();
        let value = demo(&root, None, Some(mode), false);
        assert_eq!(value["report"]["cause"], "authority_denied");
        assert_eq!(events(&root, "worker.grant_issued"), 0);
        assert_eq!(events(&root, "worker.call_completed"), 0);
        assert_eq!(events(&root, "worker.channel_revoked"), 1);
        assert_eq!(checkpoints(&root), 0);
    }
}
#[cfg(feature = "process-fixtures")]
#[test]
fn thirteen_duplex_faults_never_publish_or_accept_worker_claims() {
    let modes = [
        "wrong-task",
        "wrong-resource",
        "unknown-tool",
        "duplicate",
        "partial",
        "oversized",
        "changed-call",
        "forged-final",
        "message-flood",
        "trailing",
        "reply-hang",
        "timeout",
        "revoke",
    ];
    assert_eq!(modes.len(), 13);
    for mode in modes {
        let root = Temp::new();
        let value = demo(&root, None, Some(mode), false);
        assert_ne!(value["report"]["cause"], "completed", "{mode}");
        assert_eq!(value["report"]["checkpoint"], Value::Null, "{mode}");
        assert_eq!(checkpoints(&root), 0, "{mode}");
        assert_eq!(events(&root, "worker.channel_revoked"), 1, "{mode}");
        let observed = i64::from(["message-flood", "trailing", "reply-hang"].contains(&mode));
        assert_eq!(events(&root, "worker.call_completed"), observed, "{mode}");
        assert_eq!(events(&root, "worker.probe_reaped"), 1, "{mode}");
        println!("duplex fault {mode}: reaped, revoked, no checkpoint");
    }
}
#[cfg(feature = "process-fixtures")]
#[test]
fn dropped_committed_reply_replays_without_second_call_for_rust_and_typescript() {
    let runtime = node();
    for program in [None, Some(&runtime)] {
        let root = Temp::new();
        success(&root, &demo(&root, program, Some("lost-reply"), false));
    }
}
#[cfg(feature = "process-fixtures")]
#[test]
fn native_cancel_between_grant_and_invoke_keeps_same_host_available_in_both_languages() {
    let runtime = node();
    for program in [None, Some(&runtime)] {
        let root = Temp::new();
        let value = demo(&root, program, Some("cancel-before-invoke"), false);
        assert_eq!(value["report"]["cause"], "cancelled");
        assert_eq!(value["task"]["cancel_epoch"], 1);
        assert_eq!(value["report"]["checkpoint"], Value::Null);
        assert_eq!(value["followup"]["cause"], "completed");
        assert_eq!(events(&root, "worker.grant_issued"), 2);
        // Only the unrelated follow-up call is admitted. No cancelled invocation.
        assert_eq!(events(&root, "worker.call_completed"), 1);
        assert_eq!(events(&root, "worker.channel_revoked"), 2);
        assert_eq!(checkpoints(&root), 1);
        let store = tada_store::Store::open(&root.0.join("data")).unwrap();
        assert_eq!(
            store.task("probe-a").unwrap().execution_status,
            tada_contracts::ExecutionStatus::Cancelled
        );
    }
}
#[cfg(feature = "process-fixtures")]
#[test]
fn actual_typescript_child_uses_same_broker_and_inherits_no_injection_environment() {
    let runtime = node();
    let root = Temp::new();
    success(
        &root,
        &demo(&root, Some(&runtime), Some("env-canary"), true),
    );
}
#[cfg(feature = "process-fixtures")]
#[test]
fn channel_opened_before_spawn_is_revoked_when_cancellation_wins_process_admission() {
    let root = Temp::new();
    let value = demo(&root, None, Some("cancel-before-start"), false);
    assert_eq!(value["report"]["cause"], "cancelled");
    assert_eq!(value["followup"]["cause"], "completed");
    assert_eq!(events(&root, "worker.channel_revoked"), 2);
    assert_eq!(events(&root, "worker.probe_started"), 1);
    assert_eq!(events(&root, "worker.probe_reaped"), 1);
    assert_eq!(events(&root, "worker.call_completed"), 1);
}
