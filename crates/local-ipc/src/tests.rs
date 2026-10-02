use super::*;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tada_store::control::auth::Access;

pub(crate) fn nonce() -> String {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) struct Temp(pub PathBuf);
impl Temp {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ti-{}", nonce()));
        create_runtime_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Harness {
    temp: Temp,
    store: Arc<Mutex<Store>>,
    key: Arc<Credential>,
    info: ConnectInfo,
    limits: Limits,
    stop: watch::Sender<bool>,
    job: tokio::task::JoinHandle<Result<ServeReport>>,
}
impl Harness {
    fn new(access: Access, limits: Limits) -> Self {
        Self::start(
            Temp::new(),
            Arc::new(Credential::generate("ui", access).unwrap()),
            limits,
        )
    }
    fn start(temp: Temp, key: Arc<Credential>, limits: Limits) -> Self {
        let store = Arc::new(Mutex::new(Store::open(&temp.0).unwrap()));
        let listener = Listener::bind(&temp.0, &nonce()).unwrap();
        let info = ConnectInfo {
            address: listener.address().into(),
            store_id: store.lock().unwrap().control_store_id().unwrap(),
            server_pid: std::process::id(),
        };
        let (stop, rx) = watch::channel(false);
        let job = tokio::spawn(serve(
            listener,
            Arc::clone(&store),
            Arc::clone(&key),
            limits,
            rx,
        ));
        Self {
            temp,
            store,
            key,
            info,
            limits,
            stop,
            job,
        }
    }
    async fn client(&self) -> Client {
        Client::connect(&self.info, &self.key, self.limits)
            .await
            .unwrap()
    }
    async fn close(self) -> ServeReport {
        self.stop.send(true).unwrap();
        let report = self.job.await.unwrap().unwrap();
        drop(self.store);
        drop(self.temp);
        report
    }
    async fn restart(self) -> Self {
        self.stop.send(true).unwrap();
        self.job.await.unwrap().unwrap();
        drop(self.store);
        Self::start(self.temp, self.key, self.limits)
    }
}
fn limits() -> Limits {
    Limits {
        connections: 4,
        handshake: Duration::from_secs(2),
        frame: Duration::from_secs(2),
    }
}
fn submit() -> Value {
    json!({"jsonrpc":"2.0","id":"submit-wire","method":"task.submit","params":{"request_id":"submit-once","budget_micro_usd":100,"contract":{"task_id":"ipc-task","contract_version":1,"goal":"native IPC fixture","inputs":[],"deliverables":[],"acceptance":["result.published"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}}})
}
fn cancel() -> Value {
    json!({"jsonrpc":"2.0","id":"cancel-wire","method":"task.cancel","params":{"request_id":"cancel-once","task_id":"ipc-task"}})
}
fn get() -> Value {
    json!({"jsonrpc":"2.0","id":"get-wire","method":"task.get","params":{"task_id":"ipc-task"}})
}
async fn call(client: &mut Client, request: &Value) -> Value {
    serde_json::from_slice(
        &client
            .request(&serde_json::to_vec(request).unwrap())
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn raw(h: &Harness) -> (Stream, ClientSession) {
    let mut stream = platform::connect(&h.info.address, h.info.server_pid)
        .await
        .unwrap();
    let challenge: Challenge = read_handshake(&mut stream).await.unwrap();
    let (pending, proof) = h.key.answer(&challenge, &h.info.store_id).unwrap();
    write_handshake(&mut stream, &proof).await.unwrap();
    let proof: ServerProof = read_handshake(&mut stream).await.unwrap();
    (stream, pending.confirm(proof).unwrap())
}
async fn wait_task(h: &Harness) {
    timeout(Duration::from_secs(5), async {
        loop {
            if h.store.lock().unwrap().task("ipc-task").is_ok() {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
async fn closed(stream: &mut Stream) {
    let mut byte = [0];
    let result = timeout(Duration::from_secs(3), stream.read(&mut byte))
        .await
        .unwrap();
    assert!(
        matches!(result, Ok(0) | Err(_)),
        "connection should close without a reply"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_submit_cancel_replay_and_payload_conflict() {
    let h = Harness::new(Access::Controller, limits());
    let mut c = h.client().await;
    let accepted = call(&mut c, &submit()).await;
    assert_eq!(accepted["result"]["command_result"]["task_version"], 1);
    assert_eq!(accepted, call(&mut c, &submit()).await);
    let mut changed = submit();
    changed["params"]["budget_micro_usd"] = json!(99);
    let conflict = call(&mut c, &changed).await;
    assert_eq!(conflict["error"]["message"], "REQUEST_ID_REUSED");
    let cancelled = call(&mut c, &cancel()).await;
    assert_eq!(cancelled, call(&mut c, &cancel()).await);
    assert_eq!(accepted, call(&mut c, &submit()).await);
    let current = call(&mut c, &get()).await;
    assert_eq!(
        current["result"]["snapshot"]["execution_status"],
        "CANCELLED"
    );
    assert_eq!(current["result"]["snapshot"]["cancel_epoch"], 1);
    assert_eq!(current["result"]["snapshot"]["version"], 2);
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_native_reply_and_store_reopen_do_not_repeat_mutation() {
    let h = Harness::new(Access::Controller, limits());
    let (mut stream, mut session) = raw(&h).await;
    stream
        .write_all(
            &session
                .request(&serde_json::to_vec(&submit()).unwrap())
                .unwrap(),
        )
        .await
        .unwrap();
    wait_task(&h).await;
    drop(stream); // Commit observed independently; reply never read.
    let h = h.restart().await;
    let mut c = h.client().await;
    let accepted = call(&mut c, &submit()).await;
    assert_eq!(accepted["result"]["command_result"]["task_version"], 1);
    call(&mut c, &cancel()).await;
    assert_eq!(accepted, call(&mut c, &submit()).await);
    assert_eq!(
        call(&mut c, &get()).await["result"]["snapshot"]["version"],
        2
    );
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_key_store_identity_and_server_pid_do_not_poison_service() {
    let h = Harness::new(Access::Controller, limits());
    let wrong = Credential::generate("ui", Access::Controller).unwrap();
    assert!(Client::connect(&h.info, &wrong, h.limits).await.is_err());
    let mut info = h.info.clone();
    info.store_id = "0".repeat(32);
    assert!(Client::connect(&info, &h.key, h.limits).await.is_err());
    info = h.info.clone();
    info.server_pid += 1;
    assert!(matches!(
        Client::connect(&info, &h.key, h.limits).await,
        Err(Error::PeerRejected)
    ));
    let mut c = h.client().await;
    assert!(call(&mut c, &submit()).await.get("result").is_some());
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observer_and_revoked_credentials_cannot_change_tasks() {
    let h = Harness::new(Access::Observer, limits());
    let mut c = h.client().await;
    assert_eq!(
        call(&mut c, &submit()).await["error"]["message"],
        "CONTROL_FORBIDDEN"
    );
    assert!(h.store.lock().unwrap().task("ipc-task").is_err());
    h.key.revoke();
    assert!(c
        .request(&serde_json::to_vec(&get()).unwrap())
        .await
        .is_err());
    assert!(matches!(
        c.request(&serde_json::to_vec(&get()).unwrap()).await,
        Err(Error::Closed)
    ));
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_handshake_does_not_hold_store_or_block_another_clients_cancel() {
    let h = Harness::new(Access::Controller, limits());
    let mut c = h.client().await;
    call(&mut c, &submit()).await;
    let mut slow = platform::connect(&h.info.address, h.info.server_pid)
        .await
        .unwrap();
    let _: Challenge = read_handshake(&mut slow).await.unwrap();
    let result = timeout(Duration::from_secs(1), call(&mut c, &cancel()))
        .await
        .unwrap();
    assert!(result.get("result").is_some());
    drop(slow);
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_authenticated_frame_has_an_absolute_deadline_even_with_trickle() {
    let mut l = limits();
    l.frame = Duration::from_millis(250);
    let h = Harness::new(Access::Controller, l);
    let (stream, _) = raw(&h).await;
    let (mut reader, mut writer) = tokio::io::split(stream);
    writer.write_all(&128u32.to_be_bytes()).await.unwrap();
    let trickle = tokio::spawn(async move {
        for _ in 0..20 {
            if writer.write_all(&[0]).await.is_err() {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    });
    let mut byte = [0];
    let result = timeout(Duration::from_secs(2), reader.read(&mut byte))
        .await
        .unwrap();
    assert!(matches!(result, Ok(0) | Err(_)));
    trickle.await.unwrap();
    assert!(h.store.lock().unwrap().task("ipc-task").is_err());
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_capacity_is_bounded_and_timeout_releases_the_slot() {
    let mut l = limits();
    l.connections = 1;
    l.handshake = Duration::from_millis(500);
    let h = Harness::new(Access::Controller, l);
    let mut slow = platform::connect(&h.info.address, h.info.server_pid)
        .await
        .unwrap();
    let _: Challenge = read_handshake(&mut slow).await.unwrap();
    assert!(Client::connect(&h.info, &h.key, h.limits).await.is_err());
    closed(&mut slow).await;
    sleep(Duration::from_millis(20)).await;
    let mut c = h.client().await;
    assert!(call(&mut c, &submit()).await.get("result").is_some());
    let report = h.close().await;
    assert!(report.capacity_rejected >= 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_and_tampered_frames_close_only_the_bad_connection() {
    let h = Harness::new(Access::Controller, limits());
    let (mut stream, _) = raw(&h).await;
    stream.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    closed(&mut stream).await;
    let (mut stream, mut session) = raw(&h).await;
    let mut frame = session
        .request(&serde_json::to_vec(&submit()).unwrap())
        .unwrap();
    let end = frame.len() - 1;
    frame[end] ^= 1;
    stream.write_all(&frame).await.unwrap();
    closed(&mut stream).await;
    assert!(h.store.lock().unwrap().task("ipc-task").is_err());
    let mut c = h.client().await;
    assert!(call(&mut c, &submit()).await.get("result").is_some());
    h.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_interrupts_idle_handshake_and_sessions_without_waiting_for_timeouts() {
    let h = Harness::new(Access::Controller, limits());
    let _c = h.client().await;
    let mut slow = platform::connect(&h.info.address, h.info.server_pid)
        .await
        .unwrap();
    let _: Challenge = read_handshake(&mut slow).await.unwrap();
    timeout(Duration::from_secs(1), h.close()).await.unwrap();
    closed(&mut slow).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_timeout_closes_session_but_cannot_undo_an_entered_transaction() {
    let h = Harness::new(Access::Controller, limits());
    let mut c = h.client().await;
    c.limits.frame = Duration::from_millis(100);
    // Use a separate blocking test thread to hold the owner without parking a
    // runtime thread or carrying a MutexGuard across await in the test itself.
    let store = Arc::clone(&h.store);
    let (locked, rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _guard = store.lock().unwrap();
        locked.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    rx.recv().unwrap();
    assert!(matches!(
        c.request(&serde_json::to_vec(&submit()).unwrap()).await,
        Err(Error::Deadline)
    ));
    assert!(matches!(
        c.request(&serde_json::to_vec(&submit()).unwrap()).await,
        Err(Error::Closed)
    ));
    release.send(()).unwrap();
    holder.join().unwrap();
    wait_task(&h).await;
    let mut fresh = h.client().await;
    assert_eq!(
        call(&mut fresh, &submit()).await["result"]["command_result"]["task_version"],
        1
    );
    h.close().await;
}
#[tokio::test]
async fn wire_bounds_reject_empty_huge_truncated_and_invalid_handshake() {
    for header in [0u32, u32::MAX] {
        let (mut a, mut b) = tokio::io::duplex(16);
        a.write_all(&header.to_be_bytes()).await.unwrap();
        assert!(read_packet(&mut b, 1, 2048).await.is_err());
    }
    let (mut a, b) = tokio::io::duplex(128);
    a.write_all(&5u32.to_be_bytes()).await.unwrap();
    a.write_all(b"xx").await.unwrap();
    drop(a);
    let mut stream: Stream = Box::new(b);
    assert!(read_handshake::<ServerProof>(&mut stream).await.is_err());
    let (mut a, b) = tokio::io::duplex(512);
    let invalid = br#"{"mac":[],"mac":[]}"#;
    a.write_all(&(invalid.len() as u32).to_be_bytes())
        .await
        .unwrap();
    a.write_all(invalid).await.unwrap();
    let mut stream: Stream = Box::new(b);
    assert!(read_handshake::<ServerProof>(&mut stream).await.is_err());
}
#[test]
fn invalid_resource_limits_and_diagnostics_fail_closed() {
    let mut l = limits();
    l.connections = 0;
    assert!(l.validate().is_err());
    l.connections = 33;
    assert!(l.validate().is_err());
    l = limits();
    l.handshake = Duration::ZERO;
    assert!(l.validate().is_err());
    l = limits();
    l.frame = Duration::from_secs(31);
    assert!(l.validate().is_err());
    let e = Error::Io(std::io::Error::other("DO_NOT_LOG_THIS_SECRET"));
    assert!(!format!("{e:?} {e}").contains("DO_NOT_LOG_THIS_SECRET"));
}
