#![cfg(any(target_os = "linux", windows))]
#[cfg(feature = "process-fixtures")]
use serde_json::Value;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut bytes = [0; 12];
        getrandom::fill(&mut bytes).unwrap();
        Self(std::env::temp_dir().join(format!(
            "t10-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn run(root: &Temp, mode: &str) -> std::process::Output {
    #[cfg(feature = "process-fixtures")]
    let path = {
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("pinned Node is required");
        assert!(node.status.success());
        PathBuf::from(String::from_utf8(node.stdout).unwrap().trim())
    };
    // The ordinary rejection test does not need or launch a Node installation.
    #[cfg(not(feature = "process-fixtures"))]
    let path = PathBuf::from(env!("CARGO_BIN_EXE_tada-agentd"));
    assert!(path.is_absolute());
    let mut child = Command::new(env!("CARGO_BIN_EXE_tada-agentd"))
        .arg("demo-typescript")
        .arg(&root.0)
        .arg(path)
        .arg(mode)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(40);
    while child.try_wait().unwrap().is_none() && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("model fixture exceeded its outer deadline");
    }
    child.wait_with_output().unwrap()
}
#[cfg(not(feature = "process-fixtures"))]
#[test]
fn ordinary_host_does_not_expose_model_fixture_modes() {
    let root = Temp::new();
    assert!(!run(&root, "model-normal").status.success());
    assert!(!root.0.exists());
}
#[cfg(feature = "process-fixtures")]
fn verify(mode: &str, checkpoint: bool, calls: i64) {
    let root = Temp::new();
    let output = run(&root, mode);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["report"]["reaped"], true, "{mode}");
    assert_eq!(value["task"]["completion_status"], "PENDING", "{mode}");
    assert_eq!(value["report"]["checkpoint"].is_string(), checkpoint, "{mode}");
    assert_eq!(value["report"]["cause"] == "completed", checkpoint, "{mode}");
    let conn = rusqlite::Connection::open_with_flags(
        root.0.join("data/state.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count = |kind: &str| {
        conn.query_row("SELECT count(*) FROM events WHERE kind=?1", [kind], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(count("worker.call_completed"), calls, "{mode}");
    assert_eq!(count("worker.grant_issued"), calls, "{mode}");
    assert_eq!(count("worker.channel_revoked"), 1, "{mode}");
    println!("model process {mode}: calls={calls}, checkpoint={checkpoint}, reaped");
}
#[cfg(feature = "process-fixtures")]
#[test]
fn actual_node_mock_streams_reach_one_durable_read_only_after_complete_turn() {
    for mode in ["model-normal", "model-repair-once"] {
        verify(mode, true, 1);
    }
}
#[cfg(feature = "process-fixtures")]
#[test]
fn nine_model_fault_paths_preserve_evidence_without_false_checkpoints() {
    let cases = [
        ("model-partial-always", 0),
        ("model-repeated-error", 0),
        ("model-capacity", 0),
        ("model-auth", 0),
        ("model-network", 0),
        ("model-text-only", 0),
        ("model-after-tool-error", 1),
        ("model-scope-change", 0),
        ("model-hang", 0),
    ];
    assert_eq!(cases.len(), 9, "fixed model-process fault denominator");
    for (mode, calls) in cases {
        verify(mode, false, calls);
    }
}
