#![cfg(any(target_os = "linux", windows))]
use serde_json::Value;
use std::{
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
        let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Self(std::env::temp_dir().join(format!("t7r-{name}")))
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
    let deadline = Instant::now() + Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("startup regression exceeded its fixed timeout");
    }
    child.wait_with_output().unwrap()
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn relative_dot_demo_keeps_private_root_checks_and_local_drive_syntax() {
    let root = Temp::new();
    std::fs::create_dir(&root.0).unwrap();
    let mut command = binary();
    command.current_dir(&root.0).arg("demo").arg("./result");
    let result = success(run(command));
    assert_eq!(result["report"]["cause"], "completed");
    assert_eq!(result["report"]["reaped"], true);
    assert_eq!(result["task"]["completion_status"], "PENDING");
    // Re-open through the SAME security validator; never chmod/repair on failure.
    let guarded = tada_credential::StoreDirectory::open(&root.0.join("result/data")).unwrap();
    let store = guarded.open_store().unwrap();
    assert_eq!(
        store.task("probe-a").unwrap().execution_status,
        tada_contracts::ExecutionStatus::Stopped
    );
}
#[test]
fn parent_components_are_rejected_before_creating_a_demo_directory() {
    let root = Temp::new();
    std::fs::create_dir(&root.0).unwrap();
    std::fs::create_dir(root.0.join("child")).unwrap();
    let mut command = binary();
    command
        .current_dir(&root.0)
        .arg("demo")
        .arg("child/../must-not-exist");
    let output = run(command);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ABSOLUTE_PRIVATE_PATH_REQUIRED"));
    assert!(!root.0.join("must-not-exist").exists());
    assert!(!root.0.join("child/data").exists());
}
#[cfg(windows)]
#[test]
fn explicit_verbatim_path_is_not_silently_accepted_by_the_demo() {
    let root = Temp::new();
    std::fs::create_dir(&root.0).unwrap();
    let verbatim = std::fs::canonicalize(&root.0).unwrap();
    assert!(matches!(
        verbatim.components().next(),
        Some(std::path::Component::Prefix(p))
            if matches!(p.kind(), std::path::Prefix::VerbatimDisk(_))
    ));
    let mut command = binary();
    command.arg("demo").arg(verbatim.join("must-not-exist"));
    let output = run(command);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("IDENTITY_PATH_REJECTED"));
    assert!(!root.0.join("must-not-exist").exists());
}
#[cfg(not(feature = "process-fixtures"))]
#[test]
fn production_build_has_no_startup_fault_command() {
    let root = Temp::new();
    let mut command = binary();
    command.arg("demo").arg(&root.0).arg("cancel-before-start");
    let output = run(command);
    assert!(!output.status.success());
    assert!(!root.0.exists());
}
#[cfg(feature = "process-fixtures")]
#[test]
fn cancelled_spawn_sends_no_assignment_and_the_same_host_accepts_followup_work() {
    let root = Temp::new();
    let mut command = binary();
    command.arg("demo").arg(&root.0).arg("cancel-before-start");
    let result = success(run(command));
    assert_eq!(result["report"]["cause"], "cancelled");
    assert_eq!(result["report"]["reaped"], true);
    assert_eq!(result["report"]["queue_state"], "cancelled");
    assert!(result["report"]["checkpoint"].is_null());
    assert_eq!(result["task"]["execution_status"], "CANCELLED");
    assert_eq!(result["task"]["cancel_epoch"], 1);
    assert_eq!(result["task"]["completion_status"], "PENDING");
    assert_eq!(result["followup"]["task_id"], "probe-after-race");
    assert_eq!(result["followup"]["cause"], "completed");
    assert_eq!(result["followup"]["reaped"], true);
    assert!(result["followup"]["checkpoint"].is_string());
    assert_eq!(result["live_tools"], 0);
    let conn = rusqlite::Connection::open_with_flags(
        root.0.join("data/state.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    // No forged admission/reaping/checkpoint records for the rejected spawn.
    let unadmitted: i64 = conn
        .query_row(
            "SELECT count(*) FROM events WHERE kind IN ('worker.probe_started',
             'worker.probe_reaped') AND json_extract(payload,'$.task_id')='probe-a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unadmitted, 0);
    let checkpoints: i64 = conn
        .query_row("SELECT count(*) FROM work_checkpoints", [], |r| r.get(0))
        .unwrap();
    assert_eq!(checkpoints, 1);
    drop(conn);
    let store = tada_store::Store::open(&root.0.join("data")).unwrap();
    assert_eq!(
        store.task("probe-a").unwrap().execution_status,
        tada_contracts::ExecutionStatus::Cancelled
    );
    assert_eq!(
        store.task("probe-after-race").unwrap().completion_status,
        tada_contracts::CompletionStatus::Pending
    );
}
#[cfg(feature = "process-fixtures")]
#[test]
fn flushed_output_limits_fail_as_invalid_output_not_as_a_deadline() {
    for mode in ["stdout-flood", "stderr-flood"] {
        let root = Temp::new();
        let mut command = binary();
        command.arg("demo").arg(&root.0).arg(mode);
        let result = success(run(command));
        assert_eq!(result["report"]["cause"], "invalid_output", "{mode}");
        assert_eq!(result["report"]["reaped"], true, "{mode}");
        assert!(result["report"]["checkpoint"].is_null(), "{mode}");
    }
}
