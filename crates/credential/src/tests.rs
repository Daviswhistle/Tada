use super::*;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU8, AtomicUsize, Ordering},
};

pub(super) struct Temp(pub PathBuf);
impl Temp {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ti-{}", &random_id().unwrap()[..12]));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    pub(super) fn id(&self) -> PathBuf {
        self.0.join("id")
    }
    pub(super) fn store(&self) -> Store {
        Store::open(&self.0.join("tasks")).unwrap()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct MemoryVault {
    records: Mutex<BTreeMap<String, Vec<u8>>>,
    mode: AtomicU8,
    writes: AtomicUsize,
}
impl Vault for MemoryVault {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        match self.mode.load(Ordering::SeqCst) {
            1 => return Err(Error::SecretLocked),
            2 => return Err(Error::SecretUnavailable),
            3 => return Err(Error::SecretAmbiguous),
            _ => (),
        }
        Ok(self
            .records
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .map(Zeroizing::new))
    }
    fn create(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let mut records = self.records.lock().unwrap();
        if records.contains_key(id) {
            return Err(Error::SecretConflict);
        }
        records.insert(id.into(), bytes.to_vec());
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.mode.load(Ordering::SeqCst) == 4 {
            Err(Error::SecretUnavailable)
        } else {
            Ok(())
        }
    }
}
fn initialize(temp: &Temp, vault: &MemoryVault) -> Installation {
    Installation::initialize_with(&temp.id(), &"a".repeat(32), vault).unwrap()
}
pub(super) fn request(method: &str) -> serde_json::Value {
    use serde_json::json;
    let params = match method {
        "task.submit" => json!({"request_id":"submit-once","budget_micro_usd":100,"contract":{
            "task_id":"identity-task","contract_version":1,"goal":"persistent native control fixture",
            "inputs":[],"deliverables":[],"acceptance":["result.published"],"external_effects":[],
            "budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}}),
        "task.cancel" => json!({"request_id":"cancel-once","task_id":"identity-task"}),
        _ => json!({"task_id":"identity-task"}),
    };
    json!({"jsonrpc":"2.0","id":"wire","method":method,"params":params})
}
pub(super) async fn call(client: &mut Client, method: &str) -> serde_json::Value {
    let reply = client
        .request(&serde_json::to_vec(&request(method)).unwrap())
        .await
        .unwrap();
    serde_json::from_slice(&reply).unwrap()
}
async fn fake_connect(path: &Path, vault: &MemoryVault) -> Result<Client> {
    let id = Installation::load_with(path, vault)?;
    let e = id.discovery()?;
    Ok(Client::connect_pinned(
        &ConnectInfo {
            address: e.address,
            store_id: e.store_id,
            server_pid: e.server_pid,
        },
        &id.credential()?,
        Limits::default(),
        e.generation,
    )
    .await?)
}

#[test]
fn persistent_identity_and_credential_remain_stable_without_another_write() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    let install_id = id.meta.install_id.clone();
    let digest = id.meta.digest.clone();
    drop(id);
    for _ in 0..3 {
        let loaded = Installation::load_with(&temp.id(), &vault).unwrap();
        assert_eq!(loaded.meta.install_id, install_id);
        assert_eq!(loaded.meta.digest, digest);
    }
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn existing_directory_and_database_are_not_overwritten() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    drop(id);
    let before = std::fs::read(temp.id().join(DB)).unwrap();
    assert!(Installation::initialize_with(&temp.id(), &"a".repeat(32), &vault).is_err());
    assert_eq!(std::fs::read(temp.id().join(DB)).unwrap(), before);
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn locked_unavailable_and_ambiguous_vaults_never_fall_back_to_files() {
    for (mode, expected) in [
        (1, Error::SecretLocked),
        (2, Error::SecretUnavailable),
        (3, Error::SecretAmbiguous),
    ] {
        let temp = Temp::new();
        let vault = MemoryVault::default();
        vault.mode.store(mode, Ordering::SeqCst);
        assert!(
            matches!(Installation::initialize_with(&temp.id(),&"a".repeat(32),&vault),Err(e) if e==expected)
        );
        let root = Root::open(&temp.id()).unwrap();
        let conn = database(&root, false).unwrap();
        assert!(!metadata(&conn).unwrap().active);
        assert_eq!(vault.writes.load(Ordering::SeqCst), 0);
        let names: Vec<_> = std::fs::read_dir(temp.id())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(names.iter().all(|n| matches!(
            n.to_str(),
            Some(
                "identity.lock" | "identity.sqlite" | "identity.sqlite-wal" | "identity.sqlite-shm"
            )
        )));
    }
}
#[test]
fn reserved_identity_requires_explicit_resume_and_preserves_install_id() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    vault.mode.store(2, Ordering::SeqCst);
    assert!(Installation::initialize_with(&temp.id(), &"a".repeat(32), &vault).is_err());
    let root = Root::open(&temp.id()).unwrap();
    let conn = database(&root, false).unwrap();
    let before = metadata(&conn).unwrap().install_id;
    drop(conn);
    drop(root);
    vault.mode.store(0, Ordering::SeqCst);
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::Incomplete)
    ));
    let ready = Installation::finish_with(&temp.id(), &"a".repeat(32), &vault).unwrap();
    assert_eq!(ready.meta.install_id, before);
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn lost_vault_write_response_is_reconciled_without_duplicate_creation() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    vault.mode.store(4, Ordering::SeqCst);
    assert!(matches!(
        Installation::initialize_with(&temp.id(), &"a".repeat(32), &vault),
        Err(Error::SecretUnavailable)
    ));
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
    vault.mode.store(0, Ordering::SeqCst);
    assert!(Installation::finish_with(&temp.id(), &"a".repeat(32), &vault).is_ok());
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn active_missing_secret_is_not_regenerated_by_load_or_finish() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    drop(initialize(&temp, &vault));
    vault.records.lock().unwrap().clear();
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::SecretMissing)
    ));
    assert!(matches!(
        Installation::finish_with(&temp.id(), &"a".repeat(32), &vault),
        Err(Error::SecretMissing)
    ));
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn changed_secret_and_wrong_record_binding_are_rejected() {
    for offset in [0, 4, 36, 68] {
        let temp = Temp::new();
        let vault = MemoryVault::default();
        let id = initialize(&temp, &vault);
        let key = id.meta.install_id.clone();
        drop(id);
        vault.records.lock().unwrap().get_mut(&key).unwrap()[offset] ^= 1;
        assert!(matches!(
            Installation::load_with(&temp.id(), &vault),
            Err(Error::SecretConflict)
        ));
    }
}
#[test]
fn malformed_secret_length_is_not_tolerated() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    let key = id.meta.install_id.clone();
    drop(id);
    vault.records.lock().unwrap().get_mut(&key).unwrap().pop();
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::SecretConflict)
    ));
}
#[test]
fn different_task_store_cannot_adopt_an_existing_installation() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    drop(initialize(&temp, &vault));
    assert!(matches!(
        Installation::finish_with(&temp.id(), &"b".repeat(32), &vault),
        Err(Error::InvalidIdentity)
    ));
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn identity_lock_serializes_initialization_and_client_loading() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    let guard = id.root.file("identity.lock", false).unwrap();
    lock(&guard).unwrap();
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::Busy)
    ));
    drop(guard);
    assert!(Installation::load_with(&temp.id(), &vault).is_ok());
}
#[test]
fn future_schema_and_missing_metadata_do_not_create_a_fresh_identity() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    let conn = database(&id.root, false).unwrap();
    conn.execute_batch("PRAGMA user_version=2").unwrap();
    drop(conn);
    drop(id);
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::RecoveryRequired)
    ));
    std::fs::remove_file(temp.id().join(DB)).unwrap();
    assert!(Installation::load_with(&temp.id(), &vault).is_err());
    assert!(!temp.id().join(DB).exists());
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn active_identity_cannot_be_rewritten_or_deleted() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    let conn = database(&id.root, false).unwrap();
    assert!(conn.execute("DELETE FROM identity", []).is_err());
    assert!(conn
        .execute("UPDATE identity SET phase='RESERVED',digest=NULL", [])
        .is_err());
}
#[test]
fn identity_keys_never_appear_in_metadata_or_redacted_errors() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let id = initialize(&temp, &vault);
    let canary = Zeroizing::new(id.key.to_vec());
    drop(id);
    for entry in std::fs::read_dir(temp.id()).unwrap() {
        let p = entry.unwrap().path();
        if p.is_file() {
            let b = std::fs::read(p).unwrap();
            assert!(!b.windows(32).any(|s| s == &canary[..]));
        }
    }
    assert_eq!(
        format!("{}", Error::SecretUnavailable),
        "IDENTITY_SECRET_UNAVAILABLE"
    );
}
#[test]
fn relative_or_parent_traversal_root_is_rejected_before_creation() {
    assert!(matches!(
        Root::create(Path::new("relative-id")),
        Err(Error::UnsafePath)
    ));
    let temp = Temp::new();
    assert!(matches!(
        Root::create(&temp.0.join("nested/../bad")),
        Err(Error::UnsafePath)
    ));
}
#[cfg(target_os = "linux")]
#[test]
fn public_roots_symlinks_and_hardlinked_metadata_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = Temp::new();
    let vault = MemoryVault::default();
    drop(initialize(&temp, &vault));
    std::fs::set_permissions(temp.id(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::UnsafePath)
    ));
    std::fs::set_permissions(temp.id(), std::fs::Permissions::from_mode(0o700)).unwrap();
    symlink(temp.id(), temp.0.join("alias")).unwrap();
    assert!(Installation::load_with(&temp.0.join("alias"), &vault).is_err());
    std::fs::hard_link(temp.id().join(DB), temp.0.join("linked-db")).unwrap();
    assert!(matches!(
        Installation::load_with(&temp.id(), &vault),
        Err(Error::UnsafePath)
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_discovery_native_replay_and_restarted_store_generation() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let store = temp.store();
    let identity =
        Installation::initialize_with(&temp.id(), &store.control_store_id().unwrap(), &vault)
            .unwrap();
    let original = identity.meta.install_id.clone();
    let store = Arc::new(Mutex::new(store));
    let bound = identity.bind_with(Arc::clone(&store), &vault).unwrap();
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(bound.serve(Limits::default(), stopped));
    let mut client = fake_connect(&temp.id(), &vault).await.unwrap();
    let accepted = call(&mut client, "task.submit").await;
    drop(client);
    let mut client = fake_connect(&temp.id(), &vault).await.unwrap();
    assert_eq!(accepted, call(&mut client, "task.submit").await);
    call(&mut client, "task.cancel").await;
    drop(client);
    stop.send(true).unwrap();
    task.await.unwrap().unwrap();
    drop(store);
    let identity = Installation::load_with(&temp.id(), &vault).unwrap();
    assert_eq!(identity.meta.install_id, original);
    assert!(matches!(identity.discovery(), Err(Error::Offline)));
    let store = Arc::new(Mutex::new(temp.store()));
    let bound = identity.bind_with(Arc::clone(&store), &vault).unwrap();
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(bound.serve(Limits::default(), stopped));
    let mut client = fake_connect(&temp.id(), &vault).await.unwrap();
    assert_eq!(accepted, call(&mut client, "task.submit").await);
    let current = call(&mut client, "task.get").await;
    assert_eq!(
        current["result"]["snapshot"]["execution_status"],
        "CANCELLED"
    );
    assert_eq!(current["result"]["snapshot"]["cancel_epoch"], 1);
    drop(client);
    stop.send(true).unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(vault.writes.load(Ordering::SeqCst), 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_lock_rejects_second_listener_and_bind_rereads_vault() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let store = Arc::new(Mutex::new(temp.store()));
    let id = Installation::initialize_with(
        &temp.id(),
        &store.lock().unwrap().control_store_id().unwrap(),
        &vault,
    )
    .unwrap();
    let other = Installation::load_with(&temp.id(), &vault).unwrap();
    let bound = id.bind_with(Arc::clone(&store), &vault).unwrap();
    assert!(matches!(
        other.bind_with(Arc::clone(&store), &vault),
        Err(Error::Busy)
    ));
    drop(bound);
    let cached = Installation::load_with(&temp.id(), &vault).unwrap();
    vault.records.lock().unwrap().clear();
    assert!(matches!(
        cached.bind_with(store, &vault),
        Err(Error::SecretMissing)
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn modified_discovery_mac_namespace_revision_and_generation_fail_closed() {
    let temp = Temp::new();
    let vault = MemoryVault::default();
    let store = Arc::new(Mutex::new(temp.store()));
    let id = Installation::initialize_with(
        &temp.id(),
        &store.lock().unwrap().control_store_id().unwrap(),
        &vault,
    )
    .unwrap();
    let bound = id.bind_with(Arc::clone(&store), &vault).unwrap();
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(bound.serve(Limits::default(), stopped));
    let id = Installation::load_with(&temp.id(), &vault).unwrap();
    let conn = database(&id.root, false).unwrap();
    let (original, tag): (String, Vec<u8>) = conn
        .query_row("SELECT payload,tag FROM runtime", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    conn.execute("UPDATE runtime SET tag=zeroblob(32)", [])
        .unwrap();
    assert!(matches!(id.discovery(), Err(Error::DiscoveryRejected)));
    conn.execute("UPDATE runtime SET tag=?1", [&tag]).unwrap();
    conn.execute("UPDATE runtime SET revision=revision+1", [])
        .unwrap();
    assert!(matches!(id.discovery(), Err(Error::DiscoveryRejected)));
    conn.execute("UPDATE runtime SET revision=revision-1", [])
        .unwrap();
    for field in ["address", "generation"] {
        let mut e: Endpoint = serde_json::from_str(&original).unwrap();
        if field == "address" {
            e.address = "tcp://localhost:9999".into();
        } else {
            e.generation += 1;
        }
        let payload = serde_json::to_string(&e).unwrap();
        let tag = mac(&id.key, payload.as_bytes()).finalize().into_bytes();
        conn.execute(
            "UPDATE runtime SET payload=?1,tag=?2",
            params![payload, &tag[..]],
        )
        .unwrap();
        assert!(fake_connect(&temp.id(), &vault).await.is_err());
    }
    conn.execute(
        "UPDATE runtime SET payload=?1,tag=?2",
        params![original, tag],
    )
    .unwrap();
    assert!(fake_connect(&temp.id(), &vault).await.is_ok());
    drop(conn);
    stop.send(true).unwrap();
    task.await.unwrap().unwrap();
}
