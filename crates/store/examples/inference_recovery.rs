//! Mock-only durable request demonstration. No remote inference or account.
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tada_store::{
    model_ledger::{
        InferenceAdmission, InferenceFinish, InferenceReceipt, InferenceSpec, InferenceState,
        InferenceUsage,
    },
    queue::utc_now_ms,
    Store,
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(
        args.next()
            .ok_or("Usage: inference_recovery NEW_DIRECTORY")?,
    );
    if args.next().is_some() {
        return Err("Usage: inference_recovery NEW_DIRECTORY".into());
    }
    std::fs::create_dir(&root)?;
    let contract = tada_contracts::decode(&json!({
        "task_id":"model-demo","contract_version":1,"goal":"demonstrate a durable mock request, not a completed user goal",
        "inputs":[],"deliverables":[],"acceptance":["actual-result-not-published"],"external_effects":[],
        "budget":{"max_model_turns":2},"policy_profile_id":"mock-test",
        "on_budget_exhaustion":"save_and_request_decision","assumptions":[]
    }))?;
    let mut store = Store::open(&root)?;
    store.create_task(&contract, 100)?;
    let lease = store
        .claim_work("demo", utc_now_ms()?, Duration::from_secs(60))?
        .ok_or("No work")?;
    let spec = InferenceSpec {
        request_id: "first-request".into(),
        previous_checkpoint: None,
        reserve_micro_usd: 40,
        max_output_tokens: 1000,
        timeout_ms: 30_000,
    };
    let ticket = match store.admit_mock_inference(&lease, &spec)? {
        InferenceAdmission::Fresh(ticket) => ticket,
        InferenceAdmission::Recorded(_) => return Err("Unexpected existing request".into()),
    };
    let observer = ticket.observer();
    store.observe_inference_usage(
        &observer,
        &InferenceUsage {
            input_tokens: 12,
            output_tokens: 3,
            reported: true,
        },
    )?;
    // The independent fixture result is retained by the host in this demo. The
    // process-kill test uses a separate persistent provider ledger instead.
    let late = InferenceReceipt {
        request_hash: observer.request_hash().into(),
        finish: InferenceFinish::Stop,
        usage: InferenceUsage {
            input_tokens: 12,
            output_tokens: 5,
            reported: true,
        },
        charged_micro_usd: Some(17),
        proposals: vec![],
        retry_after_ms: None,
    };
    store.cancel("model-demo")?;
    drop(ticket);
    drop(store);
    let mut store = Store::open(&root)?;
    let before = store.inference_checkpoint("model-demo")?;
    assert_eq!(before.turns_used, 1);
    assert_eq!(before.committed_micro_usd, 40);
    assert_eq!(before.requests[0].state, InferenceState::Unknown);
    let observer = store.inference_observer("model-demo", "first-request")?;
    let saved = store.finish_mock_inference(&observer, &late)?;
    assert!(!saved.output_accepted_at_commit);
    let after = store.inference_checkpoint("model-demo")?;
    assert_eq!(after.turns_used, 1);
    assert_eq!(after.committed_micro_usd, 17);
    assert_eq!(
        store.task("model-demo")?.execution_status,
        tada_contracts::ExecutionStatus::Cancelled
    );
    assert_ne!(
        store.task("model-demo")?.completion_status,
        tada_contracts::CompletionStatus::Succeeded
    );
    println!("mock inference: 1 admission; restart reservation: 40; observed charge: 17; output discarded; execution CANCELLED; task success false");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
