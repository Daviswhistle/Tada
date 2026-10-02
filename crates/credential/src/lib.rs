//! Persistent installation identity and authenticated native endpoint discovery.
//! Trusted host APIs only: no provider tokens, RPC key export or plaintext fallback.
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tada_local_ipc::{Client, ConnectInfo, Limits, Listener, ServeReport};
use tada_store::{
    control::auth::{Access, Credential},
    Store,
};
use tokio::sync::watch;
use zeroize::Zeroizing;

mod platform;
mod vault;
use platform::Root;
use vault::{NativeVault, Vault};

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Unsupported,
    Io,
    Database,
    Busy,
    UnsafePath,
    InvalidIdentity,
    Incomplete,
    SecretMissing,
    SecretLocked,
    SecretUnavailable,
    SecretAmbiguous,
    SecretConflict,
    RecoveryRequired,
    Offline,
    DiscoveryRejected,
    Transport,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unsupported => "IDENTITY_UNSUPPORTED_PLATFORM",
            Self::Io => "IDENTITY_IO_FAILED",
            Self::Database => "IDENTITY_DATABASE_FAILED",
            Self::Busy => "IDENTITY_BUSY",
            Self::UnsafePath => "IDENTITY_PATH_REJECTED",
            Self::InvalidIdentity => "IDENTITY_INVALID",
            Self::Incomplete => "IDENTITY_PROVISIONING_INCOMPLETE",
            Self::SecretMissing => "IDENTITY_SECRET_MISSING",
            Self::SecretLocked => "IDENTITY_SECRET_LOCKED",
            Self::SecretUnavailable => "IDENTITY_SECRET_UNAVAILABLE",
            Self::SecretAmbiguous => "IDENTITY_SECRET_AMBIGUOUS",
            Self::SecretConflict => "IDENTITY_SECRET_CONFLICT",
            Self::RecoveryRequired => "IDENTITY_RECOVERY_REQUIRED",
            Self::Offline => "IDENTITY_DAEMON_OFFLINE",
            Self::DiscoveryRejected => "IDENTITY_DISCOVERY_REJECTED",
            Self::Transport => "IDENTITY_TRANSPORT_FAILED",
        })
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}
impl From<tada_store::Error> for Error {
    fn from(_: tada_store::Error) -> Self {
        Self::RecoveryRequired
    }
}
impl From<tada_local_ipc::Error> for Error {
    fn from(_: tada_local_ipc::Error) -> Self {
        Self::Transport
    }
}

const DB: &str = "identity.sqlite";
const SCHEMA: &str = "CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), install_id TEXT NOT NULL, store_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('RESERVED','ACTIVE')), digest BLOB, CHECK((phase='RESERVED' AND digest IS NULL) OR (phase='ACTIVE' AND length(digest)=32))) STRICT;
CREATE TABLE runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0), payload TEXT, tag BLOB, CHECK((payload IS NULL AND tag IS NULL) OR (json_valid(payload) AND length(tag)=32))) STRICT;
INSERT INTO runtime VALUES(1,0,NULL,NULL);
CREATE TRIGGER identity_no_delete BEFORE DELETE ON identity BEGIN SELECT RAISE(ABORT,'immutable identity'); END;
CREATE TRIGGER identity_no_replace BEFORE UPDATE ON identity WHEN old.phase='ACTIVE' OR new.install_id!=old.install_id OR new.store_id!=old.store_id BEGIN SELECT RAISE(ABORT,'immutable identity'); END;
PRAGMA user_version=1;";

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::SecretUnavailable)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn hash(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}
fn lock(file: &File) -> Result<()> {
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(_) => Error::Io,
    })
}
fn database(root: &Root, create: bool) -> Result<Connection> {
    root.check_files(&[
        DB,
        "identity.sqlite-wal",
        "identity.sqlite-shm",
        "identity.sqlite-journal",
    ])?;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | if create {
            OpenFlags::SQLITE_OPEN_CREATE
        } else {
            OpenFlags::empty()
        };
    let conn = Connection::open_with_flags(root.path().join(DB), flags)?;
    conn.busy_timeout(Duration::from_secs(2))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    )?;
    root.check_files(&[DB, "identity.sqlite-wal", "identity.sqlite-shm"])?;
    let wal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    let full: i64 = conn.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
    if wal != "wal" || full != 2 {
        return Err(Error::RecoveryRequired);
    }
    if !create {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if version != 1 || integrity != "ok" {
            return Err(Error::RecoveryRequired);
        }
    }
    Ok(conn)
}
#[derive(Clone)]
struct Meta {
    install_id: String,
    store_id: String,
    active: bool,
    digest: Option<Vec<u8>>,
}
fn metadata(conn: &Connection) -> Result<Meta> {
    let count: i64 = conn.query_row("SELECT count(*) FROM identity", [], |r| r.get(0))?;
    let (install_id, store_id, phase, digest): (String, String, String, Option<Vec<u8>>) = conn
        .query_row(
            "SELECT install_id,store_id,phase,digest FROM identity WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    if count != 1
        || !valid_id(&install_id)
        || !valid_id(&store_id)
        || !matches!(phase.as_str(), "RESERVED" | "ACTIVE")
        || (phase == "ACTIVE" && digest.as_ref().is_none_or(|d| d.len() != 32))
        || (phase == "RESERVED" && digest.is_some())
    {
        return Err(Error::RecoveryRequired);
    }
    Ok(Meta {
        install_id,
        store_id,
        active: phase == "ACTIVE",
        digest,
    })
}
fn bound_record(meta: &Meta) -> Result<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(100));
    bytes.extend_from_slice(b"TID1");
    bytes.extend_from_slice(meta.install_id.as_bytes());
    bytes.extend_from_slice(meta.store_id.as_bytes());
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *key).map_err(|_| Error::SecretUnavailable)?;
    bytes.extend_from_slice(&*key);
    Ok(bytes)
}
fn checked_secret(meta: &Meta, bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    if bytes.len() != 100
        || &bytes[..4] != b"TID1"
        || &bytes[4..36] != meta.install_id.as_bytes()
        || &bytes[36..68] != meta.store_id.as_bytes()
        || meta.digest.as_ref().is_some_and(|d| *d != hash(bytes))
    {
        return Err(Error::SecretConflict);
    }
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(&bytes[68..]);
    Ok(key)
}

/// Contains key material; intentionally neither Debug, Clone nor Serialize.
/// Blocking OS-vault operations belong at startup/on a blocking thread, never
/// while holding the task Store mutex or inside an RPC handler.
pub struct Installation {
    root: Root,
    meta: Meta,
    key: Zeroizing<[u8; 32]>,
}
impl Installation {
    /// Explicit enrollment, only into a NEW private directory. Existing data is
    /// never overwritten, even when an OS vault is missing or inaccessible.
    pub fn initialize(new_root: &Path, store: &Store) -> Result<Self> {
        Self::initialize_with(new_root, &store.control_store_id()?, &NativeVault)
    }
    /// Explicitly resume RESERVED enrollment. An ACTIVE missing key is never
    /// regenerated. The caller supplies the already-audited expected task store.
    pub fn finish_initialization(root: &Path, store: &Store) -> Result<Self> {
        Self::finish_with(root, &store.control_store_id()?, &NativeVault)
    }
    /// Read-only with respect to identity/key material: never enrolls/unlocks.
    pub fn load(root: &Path) -> Result<Self> {
        Self::load_with(root, &NativeVault)
    }
    pub fn installation_id(&self) -> &str {
        &self.meta.install_id
    }
    pub fn store_id(&self) -> &str {
        &self.meta.store_id
    }

    fn initialize_with(path: &Path, store_id: &str, vault: &impl Vault) -> Result<Self> {
        if !valid_id(store_id) {
            return Err(Error::InvalidIdentity);
        }
        Root::create(path)?;
        let root = Root::open(path)?;
        let owner = root.file("identity.lock", true)?;
        lock(&owner)?;
        let mut conn = database(&root, true)?;
        let tx = conn.transaction()?;
        tx.execute_batch(SCHEMA)?;
        tx.execute(
            "INSERT INTO identity VALUES(1,?1,?2,'RESERVED',NULL)",
            params![random_id()?, store_id],
        )?;
        tx.commit()?;
        root.sync()?;
        checkpoint("reserved");
        drop(conn);
        drop(owner);
        drop(root);
        Self::finish_with(path, store_id, vault)
    }
    fn finish_with(path: &Path, store_id: &str, vault: &impl Vault) -> Result<Self> {
        let root = Root::open(path)?;
        let owner = root.file("identity.lock", false)?;
        lock(&owner)?;
        let conn = database(&root, false)?;
        let mut meta = metadata(&conn)?;
        if meta.store_id != store_id {
            return Err(Error::InvalidIdentity);
        }
        let bytes = match vault.read(&meta.install_id)? {
            Some(bytes) => bytes,
            None if meta.active => return Err(Error::SecretMissing),
            None => {
                let bytes = bound_record(&meta)?;
                vault.create(&meta.install_id, &bytes)?;
                checkpoint("vault");
                // A successful write is not proof that the intended record is
                // readable. Never publish or activate before reread and binding.
                let observed = vault.read(&meta.install_id)?.ok_or(Error::SecretMissing)?;
                if *observed != *bytes {
                    return Err(Error::SecretConflict);
                }
                observed
            }
        };
        let key = checked_secret(&meta, &bytes)?;
        if !meta.active {
            let digest = hash(&bytes);
            if conn.execute("UPDATE identity SET phase='ACTIVE',digest=?1 WHERE singleton=1 AND phase='RESERVED'",[&digest])?!=1 {return Err(Error::RecoveryRequired);}
            meta.active = true;
            meta.digest = Some(digest);
            checkpoint("active");
        }
        drop(conn);
        drop(owner);
        Ok(Self { root, meta, key })
    }
    fn load_with(path: &Path, vault: &impl Vault) -> Result<Self> {
        let root = Root::open(path)?;
        let owner = root.file("identity.lock", false)?;
        lock(&owner)?;
        let conn = database(&root, false)?;
        let meta = metadata(&conn)?;
        if !meta.active {
            return Err(Error::Incomplete);
        }
        let bytes = vault.read(&meta.install_id)?.ok_or(Error::SecretMissing)?;
        let key = checked_secret(&meta, &bytes)?;
        drop(conn);
        drop(owner);
        Ok(Self { root, meta, key })
    }
    fn credential(&self) -> Result<Arc<Credential>> {
        Ok(Arc::new(Credential::from_secret(
            "installation-ui",
            Access::Controller,
            *self.key,
        )?))
    }
    /// Bind and publish one native endpoint. This is not service installation.
    /// The returned value owns the daemon lock until serve() has drained.
    pub fn bind(self, store: Arc<Mutex<Store>>) -> Result<BoundInstallation> {
        self.bind_with(store, &NativeVault)
    }
    fn bind_with(self, store: Arc<Mutex<Store>>, vault: &impl Vault) -> Result<BoundInstallation> {
        let owner = self.root.file("daemon.lock", true)?;
        lock(&owner)?;
        let fresh = Self::load_with(self.root.path(), vault)?;
        if fresh.meta.install_id != self.meta.install_id || fresh.meta.digest != self.meta.digest {
            return Err(Error::SecretConflict);
        }
        let credential = fresh.credential()?;
        let (store_id, generation) = {
            let store = store.lock().map_err(|_| Error::RecoveryRequired)?;
            let challenge = store.control_challenge(&credential)?.message();
            (challenge.store_id, challenge.generation)
        };
        if store_id != self.meta.store_id {
            return Err(Error::InvalidIdentity);
        }
        let instance = random_id()?;
        let runtime = self.root.path().join(format!("run-{instance}"));
        Root::create(&runtime)?;
        let runtime_guard = RuntimeDir(runtime.clone());
        let listener = Listener::bind(&runtime, &instance)?;
        let mut endpoint = Endpoint {
            version: 1,
            install_id: self.meta.install_id.clone(),
            store_id,
            revision: 0,
            generation,
            server_pid: std::process::id(),
            instance,
            address: listener.address().to_owned(),
        };
        let gate = self.root.file("identity.lock", false)?;
        lock(&gate)?;
        let mut conn = database(&self.root, false)?;
        let tx = conn.transaction()?;
        let revision: i64 =
            tx.query_row("SELECT revision FROM runtime WHERE singleton=1", [], |r| {
                r.get(0)
            })?;
        endpoint.revision = revision
            .checked_add(1)
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .ok_or(Error::RecoveryRequired)?;
        let payload = serde_json::to_string(&endpoint).map_err(|_| Error::DiscoveryRejected)?;
        let tag = mac(&self.key, payload.as_bytes()).finalize().into_bytes();
        tx.execute(
            "UPDATE runtime SET revision=?1,payload=?2,tag=?3 WHERE singleton=1",
            params![endpoint.revision, payload, &tag[..]],
        )?;
        tx.commit()?;
        drop(conn);
        drop(gate);
        checkpoint("published");
        Ok(BoundInstallation {
            listener,
            store,
            credential,
            _owner: owner,
            _identity: self,
            _runtime: runtime_guard,
        })
    }
    fn discovery(&self) -> Result<Endpoint> {
        let owner = self
            .root
            .file("daemon.lock", false)
            .map_err(|_| Error::Offline)?;
        match owner.try_lock_shared() {
            Ok(()) => return Err(Error::Offline),
            Err(std::fs::TryLockError::WouldBlock) => (),
            Err(std::fs::TryLockError::Error(_)) => return Err(Error::Io),
        }
        let conn = database(&self.root, false)?;
        let row:Option<(i64,String,Vec<u8>)>=conn.query_row("SELECT revision,payload,tag FROM runtime WHERE singleton=1 AND payload IS NOT NULL",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (revision, payload, tag) = row.ok_or(Error::Offline)?;
        if payload.len() > 2048 {
            return Err(Error::DiscoveryRejected);
        }
        mac(&self.key, payload.as_bytes())
            .verify_slice(&tag)
            .map_err(|_| Error::DiscoveryRejected)?;
        let endpoint: Endpoint =
            serde_json::from_str(&payload).map_err(|_| Error::DiscoveryRejected)?;
        if endpoint.version != 1
            || endpoint.install_id != self.meta.install_id
            || endpoint.store_id != self.meta.store_id
            || endpoint.revision != revision
            || revision <= 0
            || endpoint.generation <= 0
            || endpoint.server_pid == 0
            || !valid_id(&endpoint.instance)
        {
            return Err(Error::DiscoveryRejected);
        }
        let expected = platform::address(self.root.path(), &endpoint.instance)?;
        if endpoint.address != expected {
            return Err(Error::DiscoveryRejected);
        }
        Ok(endpoint)
    }
}
fn mac(key: &[u8; 32], payload: &[u8]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("fixed HMAC key size");
    mac.update(b"tada.installation.discovery.v1\0");
    mac.update(&(payload.len() as u64).to_be_bytes());
    mac.update(payload);
    mac
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    version: u8,
    install_id: String,
    store_id: String,
    revision: i64,
    generation: i64,
    server_pid: u32,
    instance: String,
    address: String,
}

/// Loads only this installation's OS secret, verifies signed discovery, then
/// pins store identity, kernel PID and supervisor generation during handshake.
/// Does not launch a daemon or fall back to another endpoint/key.
pub async fn connect(root: &Path, limits: Limits) -> Result<Client> {
    let path = root.to_owned();
    let (identity, endpoint) = tokio::task::spawn_blocking(move || {
        let identity = Installation::load(&path)?;
        let endpoint = identity.discovery()?;
        Ok::<_, Error>((identity, endpoint))
    })
    .await
    .map_err(|_| Error::RecoveryRequired)??;
    let credential = identity.credential()?;
    Ok(Client::connect_pinned(
        &ConnectInfo {
            address: endpoint.address,
            store_id: endpoint.store_id,
            server_pid: endpoint.server_pid,
        },
        &credential,
        limits,
        endpoint.generation,
    )
    .await?)
}
struct RuntimeDir(PathBuf);
impl Drop for RuntimeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}
pub struct BoundInstallation {
    // Field order drops the listener before the runtime-dir cleanup.
    listener: Listener,
    store: Arc<Mutex<Store>>,
    credential: Arc<Credential>,
    _owner: File,
    _identity: Installation,
    _runtime: RuntimeDir,
}
impl BoundInstallation {
    pub async fn serve(
        self,
        limits: Limits,
        shutdown: watch::Receiver<bool>,
    ) -> Result<ServeReport> {
        // Remaining fields stay owned across the await, including the OS lock.
        let Self {
            listener,
            store,
            credential,
            _owner,
            _identity,
            _runtime,
        } = self;
        let result = tada_local_ipc::serve(listener, store, credential, limits, shutdown).await;
        drop(_runtime);
        drop(_owner);
        drop(_identity);
        Ok(result?)
    }
}
#[cfg(not(test))]
fn checkpoint(_: &str) {}
#[cfg(test)]
fn checkpoint(phase: &str) {
    if std::env::var("TADA_IDENTITY_FAULT").ok().as_deref() == Some(phase) {
        let root = std::env::var_os("TADA_IDENTITY_TEST_ROOT").expect("fault root");
        let mut ready = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(Path::new(&root).join("fault.ready"))
            .unwrap();
        use std::io::Write;
        ready.write_all(phase.as_bytes()).unwrap();
        ready.sync_all().unwrap();
        loop {
            std::thread::park();
        }
    }
}
#[cfg(all(test, feature = "os-vault-tests", any(target_os = "linux", windows)))]
mod os_tests;
#[cfg(all(test, any(target_os = "linux", windows)))]
mod tests;
