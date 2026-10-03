//! Foreground developer host. No installation, auto-start, model or tool runner.
//! Persistent identity and session-only demo are separate explicit commands.
use crate::process_runner::{self, Options};
use serde_json::{json, Value};
#[cfg(feature = "process-fixtures")]
use std::io::Write;
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tada_credential::{Installation, StoreDirectory};
use tada_local_ipc::{Client, ConnectInfo, Limits, Listener};
use tada_store::{
    control::auth::{Access, Credential, MAX_BODY},
    Store,
};
use tokio::sync::{oneshot, watch};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const HELP: &str = "Tada foreground development host\n\
  tada-agentd init ABS_NEW_STORE ABS_NEW_IDENTITY\n\
  tada-agentd finish-init ABS_STORE ABS_IDENTITY\n\
  tada-agentd serve ABS_STORE ABS_IDENTITY\n\
  tada-agentd serve-probe ABS_STORE ABS_IDENTITY\n\
  tada-agentd request ABS_IDENTITY REQUEST_JSON_FILE\n\
  tada-agentd demo NEW_DIRECTORY\n\
init/finish-init explicitly use the current user's OS vault. serve only accepts\n\
authenticated control requests. serve-probe additionally runs the fixed no-tool\n\
input-hash probe; it never fulfills a user's goal or marks a task SUCCEEDED.\n\
Ctrl-C (and SIGTERM on Linux) drains entered control requests and reaps the probe.\n\
demo uses only disposable data and an explicitly session-only credential.\n";
fn supported() -> Result<()> {
    if !cfg!(any(target_os = "linux", windows)) {
        return Err("FOREGROUND_UNSUPPORTED_PLATFORM".into());
    }
    Ok(())
}
fn absolute(path: &OsString) -> Result<PathBuf> {
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("ABSOLUTE_PRIVATE_PATH_REQUIRED".into());
    }
    Ok(path)
}
fn runtime() -> Result<tokio::runtime::Runtime> {
    // Linux PDEATHSIG follows the spawning thread. Keep all fixed-probe spawn
    // operations on this persistent foreground thread, not a transient pool job.
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}
fn unique() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "RANDOM_FAILED")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn run(args: Vec<OsString>) -> Result<()> {
    if args.is_empty() || args == [OsString::from("--help")] {
        print!("{HELP}");
        return Ok(());
    }
    let command = args[0].to_str().ok_or("INVALID_COMMAND")?;
    supported()?;
    match (command, args.len()) {
        ("init", 3) => {
            let store_path = absolute(&args[1])?;
            let identity_path = absolute(&args[2])?;
            if store_path == identity_path || identity_path.exists() {
                return Err("NEW_IDENTITY_PATH_REQUIRED".into());
            }
            let root = StoreDirectory::create(&store_path)?;
            let store = root.initialize_store()?;
            Installation::initialize(&identity_path, &store)?;
            println!("Installation initialized; no daemon, tool or auto-start entry was launched.");
        }
        ("finish-init", 3) => {
            let root = StoreDirectory::open(&absolute(&args[1])?)?;
            let store = root.open_store()?;
            Installation::finish_initialization(&absolute(&args[2])?, &store)?;
            println!("Installation enrollment verified; existing identity preserved.");
        }
        ("serve" | "serve-probe", 3) => {
            let identity = Installation::load(&absolute(&args[2])?)?;
            let root = StoreDirectory::open(&absolute(&args[1])?)?;
            let store = root.open_store()?;
            if store.control_store_id()? != identity.store_id() {
                return Err("INSTALLATION_STORE_MISMATCH".into());
            }
            let store = Arc::new(Mutex::new(store));
            let probe = command == "serve-probe";
            runtime()?.block_on(serve(root, store, identity, probe))?;
        }
        ("request", 3) => {
            let identity = absolute(&args[1])?;
            let mut body = Vec::new();
            std::fs::File::open(&args[2])?
                .take((MAX_BODY + 1) as u64)
                .read_to_end(&mut body)?;
            if body.is_empty() || body.len() > MAX_BODY {
                return Err("REQUEST_BODY_LIMIT".into());
            }
            runtime()?.block_on(async {
                let mut client = tada_credential::connect(&identity, Limits::default()).await?;
                let response = client.request(&body).await?;
                let value: Value = serde_json::from_slice(&response)?;
                // JSON escaping keeps ANSI/control bytes from becoming terminal
                // commands. Never print raw child stderr or authentication frames.
                println!("{}", serde_json::to_string(&value)?);
                if value.get("error").is_some() {
                    return Err("CONTROL_REQUEST_REJECTED".into());
                }
                Ok::<_, Box<dyn std::error::Error>>(())
            })?;
        }
        ("demo", 2) => {
            runtime()?.block_on(demo(Path::new(&args[1]), "normal"))?;
        }
        #[cfg(feature = "process-fixtures")]
        ("demo", 3) => {
            runtime()?.block_on(demo(
                Path::new(&args[1]),
                args[2].to_str().ok_or("INVALID_FIXTURE")?,
            ))?;
        }
        _ => return Err("INVALID_COMMAND: use --help".into()),
    }
    Ok(())
}
async fn signal() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate())?;
        tokio::select! {result=tokio::signal::ctrl_c()=>result,_=term.recv()=>Ok(())}
    }
    #[cfg(not(target_os = "linux"))]
    {
        tokio::signal::ctrl_c().await
    }
}
async fn serve(
    root: StoreDirectory,
    store: Arc<Mutex<Store>>,
    identity: Installation,
    probe: bool,
) -> Result<()> {
    let (stop, rx) = watch::channel(false);
    let bound = identity.bind(Arc::clone(&store))?;
    let work_path = root.path().join(format!("probe-{}", unique()?));
    let work = if probe {
        Some(StoreDirectory::create(&work_path)?)
    } else {
        None
    };
    let mut server = tokio::spawn(bound.serve(Limits::default(), rx.clone()));
    let owner = Arc::clone(&store);
    let cwd = work_path.clone();
    let exe = std::env::current_exe()?;
    let mut engine = tokio::spawn(async move {
        if probe {
            process_runner::run_loop(owner, exe, cwd, rx).await
        } else {
            let mut rx = rx;
            let _ = rx.changed().await;
            Ok(())
        }
    });
    eprintln!("Foreground control ready; fixed-probe execution: {probe}; no model or external tool enabled.");
    let mut server_done = None;
    let mut engine_done = None;
    let signal_result = tokio::select! {
        biased;
        result=signal()=>result,
        result=&mut server=>{server_done=Some(result);Ok(())},
        result=&mut engine=>{engine_done=Some(result);Ok(())},
    };
    let _ = stop.send(true);
    // Do not abort the process future. Both subsystems drain before releasing
    // the Store or its protected root. No worker lease is released on Drop.
    let engine_result = match engine_done {
        Some(result) => result,
        None => engine.await,
    };
    let server_result = match server_done {
        Some(result) => result,
        None => server.await,
    };
    drop(work);
    if probe {
        let _ = std::fs::remove_dir(&work_path);
    }
    engine_result??;
    server_result??;
    signal_result?;
    drop(store);
    drop(root);
    Ok(())
}
fn submit(task: &str) -> Value {
    json!({"jsonrpc":"2.0","id":format!("submit-{task}"),"method":"task.submit","params":{"request_id":format!("create-{task}"),"budget_micro_usd":0,"contract":{"task_id":task,"contract_version":1,"goal":"disposable process lifecycle probe","inputs":[],"deliverables":[],"acceptance":["actual-user-result-not-published"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}}})
}
async fn call(client: &mut Client, request: Value) -> Result<Value> {
    let reply: Value =
        serde_json::from_slice(&client.request(&serde_json::to_vec(&request)?).await?)?;
    if reply.get("error").is_some() {
        return Err("DEMO_CONTROL_REJECTED".into());
    }
    Ok(reply)
}
async fn cancel(client: &mut Client, id: &str) -> Result<()> {
    call(client,json!({"jsonrpc":"2.0","id":format!("cancel-{id}"),"method":"task.cancel","params":{"request_id":format!("cancel-once-{id}"),"task_id":id}})).await?;
    Ok(())
}
async fn demo(path: &Path, mode: &str) -> Result<()> {
    // Resolve relative syntax without converting Windows Disk paths to verbatim
    // device syntax. Keep the existing private-root validator and ACL checks.
    // Validate before any creation; canonicalization must not hide parent hops.
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("ABSOLUTE_PRIVATE_PATH_REQUIRED".into());
    }
    let path = std::path::absolute(path)?;
    let demo_root = StoreDirectory::create(&path)?;
    let root = StoreDirectory::create(&path.join("data"))?;
    let store = Arc::new(Mutex::new(root.initialize_store()?));
    let work = StoreDirectory::create(&path.join("work"))?;
    let listener = Listener::bind(&path, &unique()?)?;
    let key = Arc::new(Credential::generate("demo-ui", Access::Controller)?);
    let info = ConnectInfo {
        address: listener.address().into(),
        store_id: store
            .lock()
            .map_err(|_| "STORE_POISONED")?
            .control_store_id()?,
        server_pid: std::process::id(),
    };
    let (stop, rx) = watch::channel(false);
    let server = tokio::spawn(tada_local_ipc::serve(
        listener,
        Arc::clone(&store),
        Arc::clone(&key),
        Limits::default(),
        rx.clone(),
    ));
    let mut client = Client::connect(&info, &key, Limits::default()).await?;
    call(&mut client, submit("probe-a")).await?;
    call(&mut client, submit("probe-cancelled")).await?;
    cancel(&mut client, "probe-cancelled").await?;
    drop(client);
    let mut client = Client::connect(&info, &key, Limits::default()).await?;
    call(&mut client, submit("probe-a")).await?;
    #[cfg(feature = "process-fixtures")]
    let (startup_notice, startup_reached) = oneshot::channel();
    #[cfg(feature = "process-fixtures")]
    let (startup_release, startup_resume) = oneshot::channel();
    let options = Options {
        mode: if ["cancel", "shutdown", "timeout", "parent-death"].contains(&mode) {
            "hang".into()
        } else if mode == "cancel-before-start" {
            "normal".into()
        } else {
            mode.into()
        },
        deadline: if ["timeout", "reply-hang"].contains(&mode) {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(30)
        },
        #[cfg(feature = "process-fixtures")]
        startup_barrier: (mode == "cancel-before-start").then_some(process_runner::StartupBarrier {
            reached: startup_notice,
            resume: startup_resume,
        }),
    };
    let (notice, mut started) = oneshot::channel();
    let runner = tokio::spawn(process_runner::run_one(
        Arc::clone(&store),
        std::env::current_exe()?,
        work.path().to_owned(),
        rx.clone(),
        options,
        Some(notice),
    ));
    #[cfg(feature = "process-fixtures")]
    let pid = if mode == "cancel-before-start" {
        let pid = startup_reached.await?;
        // A real authenticated native cancellation, not a direct DB test write.
        cancel(&mut client, "probe-a").await?;
        startup_release.send(()).map_err(|_| "STARTUP_RUNNER_LOST")?;
        pid
    } else {
        (&mut started).await?
    };
    #[cfg(not(feature = "process-fixtures"))]
    let pid = (&mut started).await?;
    if mode == "cancel" {
        cancel(&mut client, "probe-a").await?;
    }
    if mode == "shutdown" {
        let _ = stop.send(true);
    }
    #[cfg(feature = "process-fixtures")]
    if mode == "parent-death" {
        println!("{}", json!({"worker_started":pid}));
        std::io::stdout().flush()?;
        std::future::pending::<()>().await;
    }
    let _ = pid;
    let report = runner.await??.ok_or("DEMO_NO_ASSIGNMENT")?;
    let followup = if mode == "cancel-before-start" {
        if started.await.is_ok() {
            return Err("CANCELLED_ASSIGNMENT_WAS_DELIVERED".into());
        }
        // Keep using the same server and store after the cancelled spawn.
        call(&mut client, submit("probe-after-race")).await?;
        process_runner::run_one(
            Arc::clone(&store),
            std::env::current_exe()?,
            work.path().to_owned(),
            rx,
            Options::default(),
            None,
        )
        .await?
    } else {
        None
    };
    let _ = stop.send(true);
    server.await??;
    let (task, cancelled) = {
        let owner = store.lock().map_err(|_| "STORE_POISONED")?;
        (owner.task("probe-a")?, owner.task("probe-cancelled")?)
    };
    if task.completion_status == tada_contracts::CompletionStatus::Succeeded
        || cancelled.execution_status != tada_contracts::ExecutionStatus::Cancelled
    {
        return Err("DEMO_INVARIANT".into());
    }
    println!(
        "{}",
        json!({"report":report,"task":task,"queued_cancel_epoch":cancelled.cancel_epoch,"live_tools":0,"followup":followup})
    );
    drop(client);
    drop(store);
    drop(work);
    drop(root);
    drop(demo_root);
    Ok(())
}
