//! Developer-only native IPC demonstration. The parent owns a fixture store;
//! its child is a distinct client process. No service is installed or retained.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tada_local_ipc::{create_runtime_dir, serve, Client, ConnectInfo, Limits, Listener};
use tada_store::{
    control::auth::{Access, Credential},
    Store,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
    time::timeout,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const CLIENT_OK: &str =
    "native client: authenticated; reconnect replay: preserved; cancellation epoch: 1\n";
async fn call(client: &mut Client, request: Value) -> Result<Value> {
    Ok(serde_json::from_slice(
        &client.request(&serde_json::to_vec(&request)?).await?,
    )?)
}
fn submit() -> Value {
    json!({"jsonrpc":"2.0","id":"submit-wire","method":"task.submit","params":{"request_id":"submit-once","budget_micro_usd":100,"contract":{"task_id":"demo-task","contract_version":1,"goal":"cross-process local control fixture","inputs":[],"deliverables":[],"acceptance":["result.published"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}}})
}
async fn child(args: Vec<String>) -> Result<()> {
    if args.len() != 3 {
        return Err("INTERNAL_CLIENT_ARGUMENTS".into());
    }
    let mut key = [0; 32];
    {
        use std::io::Read;
        // stdin is the inherited anonymous pipe created exclusively for this
        // child below. The key never appears in argv, env, files or RPC bodies.
        let mut pipe = std::io::stdin().lock();
        pipe.read_exact(&mut key)?;
        let mut extra = [0];
        if pipe.read(&mut extra)? != 0 {
            return Err("BOOTSTRAP_LENGTH".into());
        }
    }
    let credential = Credential::from_secret("demo-ui", Access::Controller, key)?;
    key.fill(0);
    let info = ConnectInfo {
        address: args[0].clone(),
        store_id: args[1].clone(),
        server_pid: args[2].parse()?,
    };
    let mut client = Client::connect(&info, &credential, Limits::default()).await?;
    let accepted = call(&mut client, submit()).await?;
    if accepted["result"]["command_result"]["task_version"] != 1 {
        return Err("SUBMIT_RESULT".into());
    }
    drop(client);
    let mut client = Client::connect(&info, &credential, Limits::default()).await?;
    if call(&mut client, submit()).await? != accepted {
        return Err("REPLAY_RESULT".into());
    }
    let cancel = json!({"jsonrpc":"2.0","id":"cancel-wire","method":"task.cancel","params":{"request_id":"cancel-once","task_id":"demo-task"}});
    let cancelled = call(&mut client, cancel.clone()).await?;
    if call(&mut client, cancel).await? != cancelled
        || call(&mut client, submit()).await? != accepted
    {
        return Err("CANCEL_REPLAY".into());
    }
    let current=call(&mut client,json!({"jsonrpc":"2.0","id":"get-wire","method":"task.get","params":{"task_id":"demo-task"}})).await?;
    if current["result"]["snapshot"]["execution_status"] != "CANCELLED"
        || current["result"]["snapshot"]["cancel_epoch"] != 1
        || current["result"]["snapshot"]["version"] != 2
    {
        return Err("CURRENT_STATE".into());
    }
    print!("{CLIENT_OK}");
    Ok(())
}
async fn parent(root: &Path) -> Result<()> {
    create_runtime_dir(root)?;
    let root = root.canonicalize()?;
    let store = Arc::new(Mutex::new(Store::open(&root)?));
    let id = store.lock().map_err(|_| "STORE_LOCK")?.control_store_id()?;
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| "ENTROPY_UNAVAILABLE")?;
    let credential = Arc::new(Credential::from_secret("demo-ui", Access::Controller, key)?);
    let listener = Listener::bind(&root, &id)?;
    let address = listener.address().to_owned();
    let (stop, rx) = watch::channel(false);
    let server = tokio::spawn(serve(
        listener,
        Arc::clone(&store),
        credential,
        Limits::default(),
        rx,
    ));
    let result = async {
        let mut process = tokio::process::Command::new(std::env::current_exe()?)
            .args(["--client", &address, &id, &std::process::id().to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut pipe = process.stdin.take().ok_or("BOOTSTRAP_PIPE")?;
        pipe.write_all(&key).await?;
        drop(pipe);
        let status = match timeout(Duration::from_secs(20), process.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                process.kill().await?;
                process.wait().await?;
                return Err("CLIENT_TIMEOUT".into());
            }
        };
        let mut output = Vec::new();
        process
            .stdout
            .take()
            .ok_or("CLIENT_STDOUT")?
            .take(4096)
            .read_to_end(&mut output)
            .await?;
        if !status.success() || output != CLIENT_OK.as_bytes() {
            return Err("NATIVE_CLIENT_FAILED".into());
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    }
    .await;
    let _ = stop.send(true);
    server.await??;
    result?;
    let current = store.lock().map_err(|_| "STORE_LOCK")?.task("demo-task")?;
    if current.cancel_epoch.get() != 1 {
        return Err("CANCELLATION_CHANGED".into());
    }
    drop(store);
    // Fixture canary: no transferred raw key is present in either SQLite file.
    for name in ["state.sqlite", "witness.sqlite"] {
        if std::fs::read(root.join(name))?
            .windows(key.len())
            .any(|w| w == key)
        {
            return Err("SECRET_CANARY_IN_STORAGE".into());
        }
    }
    key.fill(0); // Best effort only; this is not a memory-zeroization guarantee.
    println!("native IPC: two processes; peer and HMAC authentication: passed; replay: preserved; execution: CANCELLED; epoch: 1; no persistent key or external tool");
    Ok(())
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = if args.first().map(String::as_str) == Some("--client") {
        child(args[1..].to_vec()).await
    } else if args.len() == 1 {
        parent(&PathBuf::from(&args[0])).await
    } else {
        Err("Usage: tada-ipc-demo NEW_DIRECTORY".into())
    };
    if result.is_err() {
        // Do not echo handshake material, request bodies, OS paths or secrets.
        eprintln!("NATIVE_IPC_DEMO_FAILED (use a new directory and a supported OS)");
        std::process::exit(1);
    }
}
