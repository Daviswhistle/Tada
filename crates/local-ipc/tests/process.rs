use std::{
    fs,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn distinct_process_native_replay_demo_and_existing_directory_refusal() {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).unwrap();
    let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let root = std::env::temp_dir().join(format!("tp-{name}"));
    let mut child = Command::new(env!("CARGO_BIN_EXE_tada-ipc-demo"))
        .arg(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("native demo exceeded test deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .take(4096)
        .read_to_string(&mut output)
        .unwrap();
    assert!(status.success(), "native IPC demo failed");
    assert!(output.contains("native IPC: two processes"));
    assert!(output.contains("execution: CANCELLED; epoch: 1"));
    let before = fs::read(root.join("state.sqlite")).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_tada-ipc-demo"))
        .arg(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success(), "existing directory must be refused");
    assert_eq!(before, fs::read(root.join("state.sqlite")).unwrap());
    fs::remove_dir_all(root).unwrap();
}
