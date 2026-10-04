//! Public-API regressions: rejected input must not become a storage failure.
use serde_json::json;
use std::{fs, path::PathBuf, time::Duration};
use tada_store::{
    model_ledger::{
        InferenceAdmission, InferenceFinish, InferenceReceipt, InferenceSpec, InferenceUsage,
    },
    queue::{utc_now_ms, WorkLease},
    Error, Store,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let id = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let root = std::env::temp_dir().join(format!("tada-inference-edges-{id}"));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup(temp: &Temp, budget: i64) -> (Store, WorkLease) {
    let mut store = Store::open(&temp.0).unwrap();
    store
        .enable_mock_inference(&temp.0.join("v2.sqlite"))
        .unwrap();
    let contract = tada_contracts::decode(&json!({
        "task_id":"edge-task","contract_version":1,"goal":"mock boundary regression",
        "inputs":[],"deliverables":[],"acceptance":["independent-verifier"],
        "external_effects":[],"budget":{"max_model_turns":4},"policy_profile_id":"mock-test",
        "on_budget_exhaustion":"save_and_request_decision","assumptions":[]
    }))
    .unwrap();
    store.create_task(&contract, budget).unwrap();
    let lease = store
        .claim_work("edge-test", utc_now_ms().unwrap(), Duration::from_secs(60))
        .unwrap()
        .unwrap();
    (store, lease)
}
fn spec(id: &str, previous: Option<String>, amount: i64) -> InferenceSpec {
    InferenceSpec {
        request_id: id.into(),
        previous_checkpoint: previous,
        reserve_micro_usd: amount,
        max_output_tokens: 1000,
        timeout_ms: 30_000,
    }
}
fn finish_first(store: &mut Store, lease: &WorkLease) -> Option<String> {
    let ticket = match store
        .admit_mock_inference(lease, &spec("r1", None, 1))
        .unwrap()
    {
        InferenceAdmission::Fresh(ticket) => ticket,
        InferenceAdmission::Recorded(_) => panic!("first request must be fresh"),
    };
    let handle = ticket.observer();
    store
        .finish_mock_inference(
            &handle,
            &InferenceReceipt {
                request_hash: handle.request_hash().into(),
                finish: InferenceFinish::Stop,
                usage: InferenceUsage {
                    input_tokens: 1,
                    output_tokens: 1,
                    reported: true,
                },
                charged_micro_usd: Some(1),
                proposals: vec![],
                retry_after_ms: None,
            },
        )
        .unwrap()
        .checkpoint_ref
}
#[test]
fn oversized_sum_is_budget_denial_not_poison_and_a_smaller_request_still_works() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp, 100);
    let previous = finish_first(&mut store, &lease);
    let before = serde_json::to_value(store.inference_checkpoint("edge-task").unwrap()).unwrap();
    let maximum = i64::try_from(tada_contracts::SafeInteger::MAX).unwrap();
    assert!(matches!(
        store.admit_mock_inference(&lease, &spec("r2", previous.clone(), maximum)),
        Err(Error::Denied("MODEL_BUDGET_EXHAUSTED"))
    ));
    let after = serde_json::to_value(store.inference_checkpoint("edge-task").unwrap()).unwrap();
    assert_eq!(
        before, after,
        "denial must not consume a turn or modify observations"
    );
    assert!(matches!(
        store
            .admit_mock_inference(&lease, &spec("r2", previous, 99))
            .unwrap(),
        InferenceAdmission::Fresh(_)
    ));
    assert_eq!(store.budget_committed("edge-task").unwrap(), 100);
}
#[test]
fn safe_integer_boundary_preserves_exact_remaining_capacity_across_reopen() {
    let temp = Temp::new();
    let maximum = i64::try_from(tada_contracts::SafeInteger::MAX).unwrap();
    let (mut store, lease) = setup(&temp, maximum);
    let previous = finish_first(&mut store, &lease);
    assert!(matches!(
        store.admit_mock_inference(&lease, &spec("r2", previous.clone(), maximum)),
        Err(Error::Denied("MODEL_BUDGET_EXHAUSTED"))
    ));
    assert!(matches!(
        store
            .admit_mock_inference(&lease, &spec("r2", previous, maximum - 1))
            .unwrap(),
        InferenceAdmission::Fresh(_)
    ));
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    let checkpoint = store.inference_checkpoint("edge-task").unwrap();
    assert_eq!(checkpoint.turns_used, 2);
    assert_eq!(checkpoint.committed_micro_usd, maximum);
    assert!(checkpoint.blocked_on_observation);
    assert_eq!(checkpoint.uncertain_usage_requests, 1);
}
#[test]
fn cancellation_before_first_model_admission_never_consumes_a_turn() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp, 100);
    store.cancel("edge-task").unwrap();
    assert!(store
        .admit_mock_inference(&lease, &spec("r1", None, 40))
        .is_err());
    let checkpoint = store.inference_checkpoint("edge-task").unwrap();
    assert_eq!(checkpoint.turns_used, 0);
    assert_eq!(checkpoint.committed_micro_usd, 0);
    assert_eq!(store.task("edge-task").unwrap().cancel_epoch.get(), 1);
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    assert_eq!(
        store.inference_checkpoint("edge-task").unwrap().turns_used,
        0
    );
    assert_eq!(store.task("edge-task").unwrap().cancel_epoch.get(), 1);
}
