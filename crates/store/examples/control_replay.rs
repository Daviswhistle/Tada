//! Disposable in-process control protocol demonstration, not an IPC server.
use serde_json::{json,Value};
use std::path::PathBuf;
use tada_store::{Store,control::auth::{Access,Credential,ServerSession,ClientSession}};

type Result<T> = std::result::Result<T,Box<dyn std::error::Error>>;
fn connect(store: &Store,credential: &Credential) -> Result<(ServerSession,ClientSession)> {
    let trusted_store_id = store.control_store_id()?;
    let pending = store.control_challenge(credential)?;
    let (client,proof) = credential.answer(&pending.message(),&trusted_store_id)?;
    let (server,proof) = pending.accept(proof)?;
    Ok((server,client.confirm(proof)?))
}
fn call(store: &mut Store,pair: &mut (ServerSession,ClientSession),request: &Value) -> Result<Value> {
    let frame = pair.1.request(&serde_json::to_vec(request)?)?;
    let response = store.control_handle(&mut pair.0,&frame)?;
    Ok(serde_json::from_slice(&pair.1.response(&response)?)?)
}
fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().ok_or("Usage: control_replay NEW_DIRECTORY")?);
    if args.next().is_some() { return Err("Usage: control_replay NEW_DIRECTORY".into()); }
    std::fs::create_dir(&root)?;
    let mut store = Store::open(&root)?;
    // This ephemeral fixture key stays in memory across the simulated restart.
    // Real installation-secret provisioning is deliberately not implemented here.
    let credential = Credential::generate("demo-ui",Access::Controller)?;
    let mut pair = connect(&store,&credential)?;
    let submit = json!({"jsonrpc":"2.0","id":"submit-wire","method":"task.submit","params":{
        "request_id":"submit-once","budget_micro_usd":100,
        "contract":{"task_id":"demo-task","contract_version":1,"goal":"demonstrate durable control replay","inputs":[],"deliverables":[],"acceptance":["result.published"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}
    }});
    let frame = pair.1.request(&serde_json::to_vec(&submit)?)?;
    let _lost_reply = store.control_handle(&mut pair.0,&frame)?;
    drop(store);
    let mut store = Store::open(&root)?;
    let mut pair = connect(&store,&credential)?;
    let accepted = call(&mut store,&mut pair,&submit)?;
    assert_eq!(accepted["result"]["command_result"]["task_version"],1);
    let cancel = json!({"jsonrpc":"2.0","id":"cancel-wire","method":"task.cancel","params":{"request_id":"cancel-once","task_id":"demo-task"}});
    let cancelled = call(&mut store,&mut pair,&cancel)?;
    assert_eq!(cancelled,call(&mut store,&mut pair,&cancel)?);
    assert_eq!(accepted,call(&mut store,&mut pair,&submit)?);
    let current = call(&mut store,&mut pair,&json!({"jsonrpc":"2.0","id":"query-wire","method":"task.get","params":{"task_id":"demo-task"}}))?;
    assert_eq!(current["result"]["snapshot"]["execution_status"],"CANCELLED");
    assert_eq!(current["result"]["snapshot"]["cancel_epoch"],1);
    assert_eq!(current["result"]["snapshot"]["version"],2);
    println!("control: authenticated; submit: replayed after reopen; cancel epoch: 1; current execution: CANCELLED; no listener or external tool enabled");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
