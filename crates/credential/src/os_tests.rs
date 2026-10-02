//! Opt-in integration tests for disposable hosted-runner OS vault entries.
//! No user provider credentials or broad vault enumeration is used.
use super::*;
use crate::tests::{call, Temp};
use std::{
    process::{Child, Command, Stdio},
    thread,
    time::Instant,
};
struct Cleanup(String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = vault::delete_test(&self.0);
    }
}
fn cleanup(path: &Path) -> Cleanup {
    let root = Root::open(path).unwrap();
    let db = database(&root, false).unwrap();
    Cleanup(metadata(&db).unwrap().install_id)
}
fn child(root: &Path, test: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("TADA_IDENTITY_TEST_ROOT", root)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap()
}
fn wait_ready(child: &mut Child, path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(45);
    while !path.exists() && Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("identity child exited before boundary: {status}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !path.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("identity child boundary timeout");
    }
}
fn finish_child(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            return;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("identity child failed to drain");
        }
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn native_vault_persists_bound_record_and_missing_active_key_never_regenerates() {
    let temp = Temp::new();
    let store = temp.store();
    let identity = Installation::initialize(&temp.id(), &store).unwrap();
    let _cleanup = cleanup(&temp.id());
    let original = identity.meta.install_id.clone();
    let digest = identity.meta.digest.clone();
    let key = Zeroizing::new(identity.key.to_vec());
    drop(identity);
    let loaded = Installation::load(&temp.id()).unwrap();
    assert_eq!(loaded.meta.install_id, original);
    assert_eq!(loaded.meta.digest, digest);
    drop(loaded);
    for entry in std::fs::read_dir(temp.id()).unwrap() {
        let p = entry.unwrap().path();
        if p.is_file() {
            let bytes = std::fs::read(p).unwrap();
            assert!(
                !bytes.windows(32).any(|b| b == &key[..]),
                "plaintext key in metadata"
            );
        }
    }
    vault::delete_test(&original).unwrap();
    assert!(matches!(
        Installation::load(&temp.id()),
        Err(Error::SecretMissing)
    ));
    assert!(matches!(
        Installation::finish_initialization(&temp.id(), &store),
        Err(Error::SecretMissing)
    ));
    assert!(NativeVault.read(&original).unwrap().is_none());
}
// No-op in the normal feature run; the parent invokes this exact test alone.
#[test]
fn enrollment_child() {
    let Some(root) = std::env::var_os("TADA_IDENTITY_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let store = Store::open(&root.join("tasks")).unwrap();
    let _identity = Installation::initialize(&root.join("id"), &store).unwrap();
    panic!("expected enrollment fault checkpoint was not reached");
}
#[test]
fn process_kill_at_three_enrollment_boundaries_reuses_the_reserved_identity() {
    let phases = ["reserved", "vault", "active"];
    for phase in phases {
        let temp = Temp::new();
        let store = temp.store();
        drop(store);
        let mut process = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "os_tests::enrollment_child", "--nocapture"])
            .env("TADA_IDENTITY_TEST_ROOT", &temp.0)
            .env("TADA_IDENTITY_FAULT", phase)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        wait_ready(&mut process, &temp.0.join("fault.ready"));
        process.kill().unwrap();
        assert!(!process.wait().unwrap().success());
        let _cleanup = cleanup(&temp.id());
        let reserved_id = _cleanup.0.clone();
        let before = NativeVault.read(&reserved_id).unwrap();
        assert_eq!(before.is_some(), phase != "reserved");
        let store = temp.store();
        if phase != "active" {
            assert!(matches!(
                Installation::load(&temp.id()),
                Err(Error::Incomplete)
            ));
        }
        let ready = Installation::finish_initialization(&temp.id(), &store).unwrap();
        assert_eq!(ready.meta.install_id, reserved_id);
        let after = NativeVault.read(&reserved_id).unwrap().unwrap();
        if let Some(before) = before {
            assert!(
                before.as_slice() == after.as_slice(),
                "existing OS-vault record must not be replaced"
            );
        }
        drop(ready);
        assert!(Installation::load(&temp.id()).is_ok());
        println!("OS-vault enrollment kill boundary {phase}: passed");
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_child() {
    let Some(root) = std::env::var_os("TADA_IDENTITY_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let store = Arc::new(Mutex::new(Store::open(&root.join("tasks")).unwrap()));
    let identity = Installation::load(&root.join("id")).unwrap();
    let bound = identity.bind(Arc::clone(&store)).unwrap();
    let (stop, stopped) = watch::channel(false);
    let server = tokio::spawn(bound.serve(Limits::default(), stopped));
    std::fs::write(root.join("server.ready"), b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !root.join("server.stop").exists() {
        assert!(Instant::now() < deadline, "server fixture deadline");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    stop.send(true).unwrap();
    server.await.unwrap().unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn distinct_server_process_restart_preserves_identity_and_native_request_replay() {
    let temp = Temp::new();
    let store = temp.store();
    let identity = Installation::initialize(&temp.id(), &store).unwrap();
    let _cleanup = cleanup(&temp.id());
    let original = identity.meta.install_id.clone();
    drop(identity);
    drop(store);
    let mut server = child(&temp.0, "os_tests::server_child");
    wait_ready(&mut server, &temp.0.join("server.ready"));
    let mut client = connect(&temp.id(), Limits::default()).await.unwrap();
    let accepted = call(&mut client, "task.submit").await;
    call(&mut client, "task.cancel").await;
    drop(client);
    std::fs::write(temp.0.join("server.stop"), b"stop").unwrap();
    finish_child(&mut server);
    let loaded = Installation::load(&temp.id()).unwrap();
    assert_eq!(loaded.meta.install_id, original);
    assert!(matches!(loaded.discovery(), Err(Error::Offline)));
    drop(loaded);
    std::fs::remove_file(temp.0.join("server.ready")).unwrap();
    std::fs::remove_file(temp.0.join("server.stop")).unwrap();
    let mut server = child(&temp.0, "os_tests::server_child");
    wait_ready(&mut server, &temp.0.join("server.ready"));
    let mut client = connect(&temp.id(), Limits::default()).await.unwrap();
    assert_eq!(accepted, call(&mut client, "task.submit").await);
    let current = call(&mut client, "task.get").await;
    assert_eq!(
        current["result"]["snapshot"]["execution_status"],
        "CANCELLED"
    );
    assert_eq!(current["result"]["snapshot"]["cancel_epoch"], 1);
    drop(client);
    std::fs::write(temp.0.join("server.stop"), b"stop").unwrap();
    finish_child(&mut server);
    println!("persistent OS identity: stable; distinct server restart: passed; native replay: preserved; execution: CANCELLED; epoch: 1");
}
