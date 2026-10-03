#![cfg(all(feature = "process-fixtures", any(target_os = "linux", windows)))]
use serde_json::Value;
use std::{
    io::BufRead,
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
            "t9l-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn command(root: &Temp, mode: &str) -> Command {
    // Test setup resolves the pinned runtime. Product commands require its
    // explicit absolute path and do not discover a runtime from PATH.
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("pinned Node is required for the process-fixture suite");
    assert!(output.status.success());
    let path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    assert!(path.is_absolute());
    let mut command = Command::new(env!("CARGO_BIN_EXE_tada-agentd"));
    command
        .arg("demo-typescript")
        .arg(&root.0)
        .arg(path)
        .arg(mode)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}
#[test]
fn killing_foreground_parent_also_stops_the_real_node_runtime() {
    let root = Temp::new();
    let mut parent = command(&root, "parent-death").spawn().unwrap();
    let stdout = parent.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = thread::spawn(move || {
        let mut line = String::new();
        let result = std::io::BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send((result, line));
    });
    let notice = rx.recv_timeout(Duration::from_secs(15));
    if notice.is_err() {
        let _ = parent.kill();
        let _ = parent.wait();
        reader.join().unwrap();
        panic!("Node start notice not received");
    }
    let (result, line) = notice.unwrap();
    result.unwrap();
    reader.join().unwrap();
    let pid = serde_json::from_str::<Value>(&line).unwrap()["worker_started"]
        .as_u64()
        .unwrap() as u32;
    let witness = ProcessWatch::open(pid);
    assert!(
        witness.running(),
        "Node must be live before parent termination"
    );
    parent.kill().unwrap();
    assert!(!parent.wait().unwrap().success());
    let deadline = Instant::now() + Duration::from_secs(5);
    while witness.running() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!witness.running(), "Node survived its foreground parent");
    // Recovery creates a new supervisor generation; the old channel cannot be
    // revived. A stored PID is never used as authority to terminate a process.
    let mut store = tada_store::Store::open(&root.0.join("data")).unwrap();
    assert_eq!(
        store.task("probe-a").unwrap().completion_status,
        tada_contracts::CompletionStatus::Pending
    );
    assert!(store
        .claim_work(
            "after-node-parent-exit",
            tada_store::queue::utc_now_ms().unwrap(),
            Duration::from_secs(60)
        )
        .unwrap()
        .is_some());
}
#[test]
fn graceful_stop_reaps_node_and_revokes_channel_before_reassignment() {
    let root = Temp::new();
    let mut parent = command(&root, "shutdown").spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while parent.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if parent.try_wait().unwrap().is_none() {
        let _ = parent.kill();
        let _ = parent.wait();
        panic!("Node graceful stop exceeded fixed outer timeout");
    }
    let output = parent.wait_with_output().unwrap();
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["broker_enabled"], true);
    assert_eq!(value["report"]["cause"], "shutdown");
    assert_eq!(value["report"]["reaped"], true);
    assert_eq!(value["report"]["checkpoint"], Value::Null);
    assert_eq!(value["task"]["execution_status"], "READY");
    assert_eq!(value["task"]["completion_status"], "PENDING");
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
    assert_eq!(count("worker.channel_revoked"), 1);
    assert_eq!(count("worker.probe_reaped"), 1);
    assert_eq!(count("worker.call_completed"), 0);
    drop(conn);
    let mut store = tada_store::Store::open(&root.0.join("data")).unwrap();
    let lease = store
        .claim_work(
            "after-node-reap",
            tada_store::queue::utc_now_ms().unwrap(),
            Duration::from_secs(60),
        )
        .unwrap()
        .unwrap();
    assert_eq!(lease.task_id(), "probe-a");
    assert!(lease.attempt() > 1);
}

#[cfg(target_os = "linux")]
struct ProcessWatch {
    pid: u32,
    start: String,
}
#[cfg(target_os = "linux")]
impl ProcessWatch {
    fn fields(pid: u32) -> Option<(String, String)> {
        let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<_> = raw.rsplit_once(") ")?.1.split_whitespace().collect();
        Some((fields.first()?.to_string(), fields.get(19)?.to_string()))
    }
    fn open(pid: u32) -> Self {
        Self {
            pid,
            start: Self::fields(pid).unwrap().1,
        }
    }
    fn running(&self) -> bool {
        Self::fields(self.pid)
            .is_some_and(|(state, start)| start == self.start && state != "Z" && state != "X")
    }
}
#[cfg(windows)]
struct ProcessWatch(std::os::windows::io::OwnedHandle);
#[cfg(windows)]
impl ProcessWatch {
    fn open(pid: u32) -> Self {
        use std::os::windows::io::FromRawHandle;
        // Retain the kernel object with SYNCHRONIZE only, not a recycled PID.
        let raw =
            unsafe { windows_sys::Win32::System::Threading::OpenProcess(0x0010_0000, 0, pid) };
        assert!(!raw.is_null());
        Self(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) })
    }
    fn running(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        let status = unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(self.0.as_raw_handle(), 0)
        };
        assert!(status == 0 || status == 258, "process wait failed");
        status == 258
    }
}
