//! Disposable, mock-only demonstration. No network or real account is used.
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tada_contracts::{decode, ActionState, CompletionStatus, ExecutionStatus, TaskContract};
use tada_store::{mock::{MockMode, MockPayload, MockService}, Store};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().ok_or("Usage: recover_mock NEW_DIRECTORY")?);
    if args.next().is_some() { return Err("Usage: recover_mock NEW_DIRECTORY".into()); }
    // Atomic creation refuses existing files/directories instead of reusing user data.
    std::fs::create_dir(&root)?;
    let contract: TaskContract = decode(&json!({
        "task_id":"mock-demo", "contract_version":1,
        "goal":"Demonstrate recovery without repeating an external effect",
        "inputs":[], "deliverables":[], "acceptance":["demo.result_published"],
        "external_effects":[{"capability":"mock.apply","account_ref":"mock-account","target":"demo-target","purpose":"mock-test"}],
        "budget":{"max_model_turns":1},"policy_profile_id":"mock-test",
        "on_budget_exhaustion":"save_and_request_decision","assumptions":[]
    }))?;
    let mut store = Store::open(&root)?;
    let mut service = MockService::open(&root.join("external.sqlite"))?;
    store.create_task(&contract, 100)?;
    let lease = store.start_run("mock-demo", Duration::from_secs(60))?;
    let payload = MockPayload { target:"demo-target".into(), value:"expected-result".into() };
    store.propose_mock("demo-action", &lease, &payload)?;
    store.prepare_mock("demo-action", &lease)?;
    store.dispatch_mock("demo-action", &lease, &mut service, MockMode::DropResponse, 30)?;
    store.cancel("mock-demo")?;
    assert_eq!(store.task("mock-demo")?.completion_status, CompletionStatus::OutcomeUnknown);
    drop(store);
    let mut reopened = Store::open(&root)?;
    reopened.reconcile_mock("demo-action", &service)?;
    assert_eq!(service.effect_count()?, 1);
    assert_eq!(reopened.action("demo-action")?.state, ActionState::Verified);
    assert_eq!(reopened.task("mock-demo")?.execution_status, ExecutionStatus::Cancelled);
    assert_ne!(reopened.task("mock-demo")?.completion_status, CompletionStatus::Succeeded);
    assert_eq!(reopened.budget_committed("mock-demo")?, 30);
    println!("mock effects: 1; action: VERIFIED; execution: CANCELLED; task success: false; committed fixture budget: 30 micro-USD");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
