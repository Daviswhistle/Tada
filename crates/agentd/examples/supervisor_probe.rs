//! Disposable model-free supervisor example; never a live user's task engine.
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tada_agentd::{ProbeOutcome, Supervisor};
use tada_store::Store;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().ok_or("Usage: supervisor_probe NEW_DIRECTORY")?);
    if args.next().is_some() {
        return Err("Usage: supervisor_probe NEW_DIRECTORY".into());
    }
    std::fs::create_dir(&root)?;
    let mut store = Store::open(&root)?;
    for id in ["delayed", "ordinary", "cancelled"] {
        let contract = tada_contracts::decode(
            &json!({"task_id":id,"contract_version":1,"goal":"immutable-input probe only","inputs":[],"deliverables":[],"acceptance":["real-result-not-yet-published"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}),
        )?;
        store.create_task(&contract, 0)?;
    }
    store.schedule_work("delayed", 2000)?;
    store.cancel("cancelled")?;
    drop(store);
    let store = Arc::new(Mutex::new(Store::open(&root)?));
    let supervisor = Supervisor::new(Arc::clone(&store), "demo-supervisor".into(), 1)?;
    if !matches!(supervisor.probe_once(1000)?,ProbeOutcome::Checkpointed{task_id,..} if task_id=="ordinary")
    {
        return Err("ordinary assignment failed".into());
    }
    if supervisor.probe_once(1999)? != ProbeOutcome::Idle {
        return Err("scheduled work ran early".into());
    }
    if !matches!(supervisor.probe_once(2000)?,ProbeOutcome::Checkpointed{task_id,..} if task_id=="delayed")
    {
        return Err("scheduled assignment failed".into());
    }
    supervisor.stop_admission()?;
    for id in ["ordinary", "delayed", "cancelled"] {
        if store
            .lock()
            .map_err(|_| "store poisoned")?
            .task(id)?
            .completion_status
            == tada_contracts::CompletionStatus::Succeeded
        {
            return Err("probe manufactured task success".into());
        }
    }
    if store
        .lock()
        .map_err(|_| "store poisoned")?
        .task("cancelled")?
        .execution_status
        != tada_contracts::ExecutionStatus::Cancelled
    {
        return Err("cancelled work revived".into());
    }
    println!("supervisor: queue restored; probes checkpointed: 2; delayed work not early; cancelled work not run; user tasks succeeded: 0; live tools: 0");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
