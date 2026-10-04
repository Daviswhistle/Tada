use super::*;
use crate::mock::{MockMode, MockPayload, MockService};
use crate::queue::utc_now_ms;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "tada-model-ledger-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn task(turns: i64) -> tada_contracts::TaskContract {
    tada_contracts::decode(&json!({
        "task_id":"task-a","contract_version":1,"goal":"FAKE_PRIVATE_GOAL_NOT_IN_INFERENCE_EVENTS",
        "inputs":[],"deliverables":[],"acceptance":["independent-result-required"],
        "external_effects":[{"capability":"mock.apply","account_ref":"mock-account","target":"target-a","purpose":"mock-test"}],
        "budget":{"max_model_turns":turns},"policy_profile_id":"mock-test",
        "on_budget_exhaustion":"save_and_request_decision","assumptions":[]
    })).unwrap()
}
fn setup(root: &Path, turns: i64, cap: i64) -> (Store, WorkLease) {
    let mut store = Store::open(root).unwrap();
    store
        .enable_mock_inference(&root.join("before-model-v3.sqlite"))
        .unwrap();
    store.create_task(&task(turns), cap).unwrap();
    let lease = store
        .claim_work("model-test", utc_now_ms().unwrap(), Duration::from_secs(60))
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
fn fresh(store: &mut Store, lease: &WorkLease, request: &InferenceSpec) -> InferenceTicket {
    match store.admit_mock_inference(lease, request).unwrap() {
        InferenceAdmission::Fresh(ticket) => ticket,
        InferenceAdmission::Recorded(_) => panic!("new request unexpectedly replayed"),
    }
}
fn receipt(handle: &InferenceObserver, charge: Option<i64>) -> InferenceReceipt {
    InferenceReceipt {
        request_hash: handle.request_hash().into(),
        finish: InferenceFinish::Stop,
        usage: InferenceUsage {
            input_tokens: 12,
            output_tokens: 5,
            reported: true,
        },
        charged_micro_usd: charge,
        proposals: vec![],
        retry_after_ms: None,
    }
}
fn count(store: &Store, kind: &str) -> i64 {
    store
        .conn
        .query_row("SELECT count(*) FROM events WHERE kind=?1", [kind], |r| {
            r.get(0)
        })
        .unwrap()
}
fn tip(store: &Store) -> i64 {
    store
        .witness
        .query_row("SELECT max(seq) FROM journal", [], |r| r.get(0))
        .unwrap()
}
fn pending_task(store: &Store) {
    assert_ne!(
        store.task("task-a").unwrap().completion_status,
        tada_contracts::CompletionStatus::Succeeded
    );
    assert_eq!(
        store.task("task-a").unwrap().unmet_required_criteria,
        vec!["independent-result-required"]
    );
}

#[test]
fn admission_persists_exact_input_and_retry_returns_no_second_ticket() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let request = spec("r1", None, 40);
    let ticket = fresh(&mut store, &lease, &request);
    let before = tip(&store);
    let replay = store.admit_mock_inference(&lease, &request).unwrap();
    assert!(matches!(replay, InferenceAdmission::Recorded(_)));
    assert_eq!(tip(&store), before);
    assert_eq!(count(&store, "model.admitted"), 1);
    let view = store.inference_checkpoint("task-a").unwrap();
    assert_eq!(view.turns_used, 1);
    assert_eq!(view.committed_micro_usd, 40);
    assert!(view.blocked_on_observation);
    assert_eq!(view.uncertain_usage_requests, 1);
    let record = load(&store.conn, "task-a").unwrap().remove("r1").unwrap();
    let bytes: Vec<u8> = store
        .conn
        .query_row(
            "SELECT content FROM payloads WHERE hash=?1",
            [&record.admission.input_hash],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(bytes, serde_json::to_vec(ticket.input()).unwrap());
    let raw: String = store
        .conn
        .query_row(
            "SELECT group_concat(payload) FROM events WHERE kind GLOB 'model.*'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!raw.contains("FAKE_PRIVATE_GOAL"));
    assert!(!String::from_utf8(bytes)
        .unwrap()
        .contains("FAKE_PRIVATE_GOAL"));
    pending_task(&store);
}
#[test]
fn changed_request_or_checkpoint_is_denied_without_refilling_budget() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let before = tip(&store);
    assert!(matches!(
        store.admit_mock_inference(&lease, &spec("r1", None, 41)),
        Err(Error::Denied("MODEL_REQUEST_ID_REUSED"))
    ));
    assert!(matches!(
        store.admit_mock_inference(&lease, &spec("r2", None, 40)),
        Err(Error::Denied("MODEL_OBSERVATION_REQUIRED"))
    ));
    assert_eq!(tip(&store), before);
    store
        .finish_mock_inference(&ticket.observer(), &receipt(&ticket.observer(), Some(17)))
        .unwrap();
    assert!(matches!(
        store.admit_mock_inference(&lease, &spec("r2", None, 40)),
        Err(Error::Denied("MODEL_CHECKPOINT_STALE"))
    ));
    assert_eq!(store.budget_committed("task-a").unwrap(), 17);
}
#[test]
fn cumulative_usage_is_monotonic_idempotent_and_does_not_settle_the_reservation() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let usage = InferenceUsage {
        input_tokens: 10,
        output_tokens: 3,
        reported: true,
    };
    store.observe_inference_usage(&h, &usage).unwrap();
    let before = tip(&store);
    store.observe_inference_usage(&h, &usage).unwrap();
    assert_eq!(tip(&store), before);
    assert!(store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                input_tokens: 9,
                ..usage.clone()
            }
        )
        .is_err());
    assert!(store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                reported: false,
                ..usage.clone()
            }
        )
        .is_err());
    store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                output_tokens: 4,
                ..usage
            },
        )
        .unwrap();
    let view = store.inference_checkpoint("task-a").unwrap();
    assert_eq!(view.input_tokens, 10);
    assert_eq!(view.output_tokens, 4);
    assert_eq!(view.committed_micro_usd, 40);
    assert_eq!(view.uncertain_usage_requests, 1);
}
#[test]
fn receipt_and_checkpoint_commit_together_and_replay_never_records_again() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 2, 100);
    let request = spec("r1", None, 40);
    let ticket = fresh(&mut store, &lease, &request);
    let h = ticket.observer();
    let received = receipt(&h, Some(17));
    let first = store.finish_mock_inference(&h, &received).unwrap();
    let before = tip(&store);
    let second = store.finish_mock_inference(&h, &received).unwrap();
    assert_eq!(first.checkpoint_ref, second.checkpoint_ref);
    assert_eq!(tip(&store), before);
    assert!(first.output_accepted_at_commit);
    assert_eq!(count(&store, "model.finished"), 1);
    assert_eq!(store.budget_committed("task-a").unwrap(), 17);
    assert_eq!(
        store
            .inference_checkpoint("task-a")
            .unwrap()
            .uncertain_usage_requests,
        0
    );
    assert!(store
        .finish_mock_inference(&h, &receipt(&h, Some(18)))
        .is_err());
    assert!(matches!(
        store.admit_mock_inference(&lease, &request).unwrap(),
        InferenceAdmission::Recorded(_)
    ));
    pending_task(&store);
}
#[test]
fn model_proposals_are_schema_and_exact_scope_checked_before_receipt_commit() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let valid:WorkerProposal=tada_contracts::decode(&json!({"schema_version":1,"call_id":"call-1","task_id":"task-a","tool":"task.contract_digest","tool_version":1,"resource":"task://task-a/contract","purpose":"verify_input_snapshot","arguments":{"expected_hash":lease.contract_hash()}})).unwrap();
    for bad in [
        {
            let mut p = valid.clone();
            p.task_id = "other".into();
            p
        },
        {
            let mut p = valid.clone();
            p.tool = "credential.export".into();
            p
        },
        {
            let mut p = valid.clone();
            p.arguments.expected_hash = "b".repeat(64);
            p
        },
    ] {
        let mut received = receipt(&h, Some(17));
        received.finish = InferenceFinish::ToolCalls;
        received.proposals = vec![bad];
        assert!(store.finish_mock_inference(&h, &received).is_err());
    }
    let mut received = receipt(&h, Some(17));
    received.finish = InferenceFinish::ToolCalls;
    received.proposals = vec![valid];
    assert!(
        store
            .finish_mock_inference(&h, &received)
            .unwrap()
            .output_accepted_at_commit
    );
    assert_eq!(count(&store, "worker.call_completed"), 0);
    pending_task(&store);
}
#[test]
fn cancelled_late_receipt_settles_usage_without_restoring_execution_or_accepting_output() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    store.cancel("task-a").unwrap();
    store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                input_tokens: 10,
                output_tokens: 2,
                reported: true,
            },
        )
        .unwrap();
    let saved = store
        .finish_mock_inference(&h, &receipt(&h, Some(17)))
        .unwrap();
    assert!(!saved.output_accepted_at_commit);
    assert_eq!(store.budget_committed("task-a").unwrap(), 17);
    assert!(store
        .admit_mock_inference(&lease, &spec("r2", saved.checkpoint_ref, 40))
        .is_err());
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    assert_eq!(
        store.task("task-a").unwrap().execution_status,
        tada_contracts::ExecutionStatus::Cancelled
    );
    assert_eq!(store.task("task-a").unwrap().cancel_epoch.get(), 1);
    assert_eq!(store.inference_checkpoint("task-a").unwrap().turns_used, 1);
    pending_task(&store);
}
#[test]
fn changed_policy_or_monotonic_expiry_discards_late_output_but_keeps_cost() {
    for expired in [false, true] {
        let temp = Temp::new();
        let (mut store, lease) = setup(&temp.0, 4, 100);
        let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
        let h = ticket.observer();
        if expired {
            store.clock = store.clock.checked_sub(Duration::from_secs(40)).unwrap();
        } else {
            store.set_mock_policy_denied(true).unwrap();
        }
        let saved = store
            .finish_mock_inference(&h, &receipt(&h, Some(17)))
            .unwrap();
        assert!(!saved.output_accepted_at_commit);
        assert_eq!(store.budget_committed("task-a").unwrap(), 17);
    }
}
#[test]
fn restart_keeps_unknown_request_usage_and_reservation_then_accepts_only_observation() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 3, 100);
    let request = spec("r1", None, 40);
    let ticket = fresh(&mut store, &lease, &request);
    let h = ticket.observer();
    store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                input_tokens: 10,
                output_tokens: 3,
                reported: true,
            },
        )
        .unwrap();
    drop(ticket);
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    let current = store
        .claim_work("new-owner", utc_now_ms().unwrap(), Duration::from_secs(60))
        .unwrap()
        .unwrap();
    let view = store.inference_checkpoint("task-a").unwrap();
    assert_eq!(view.requests[0].state, InferenceState::Unknown);
    assert_eq!(view.input_tokens, 10);
    assert_eq!(view.committed_micro_usd, 40);
    assert_eq!(view.turns_used, 1);
    assert!(matches!(
        store.admit_mock_inference(&current, &request).unwrap(),
        InferenceAdmission::Recorded(_)
    ));
    assert!(matches!(
        store.admit_mock_inference(&current, &spec("r2", None, 40)),
        Err(Error::Denied("MODEL_OBSERVATION_REQUIRED"))
    ));
    let observer = store.inference_observer("task-a", "r1").unwrap();
    let saved = store
        .finish_mock_inference(&observer, &receipt(&observer, Some(17)))
        .unwrap();
    assert!(
        !saved.output_accepted_at_commit,
        "a late old-generation response is accounting only"
    );
    fresh(&mut store, &current, &spec("r2", saved.checkpoint_ref, 40));
    assert_eq!(store.inference_checkpoint("task-a").unwrap().turns_used, 2);
    assert_eq!(store.budget_committed("task-a").unwrap(), 57);
    assert_eq!(count(&store, "model.admitted"), 2);
    pending_task(&store);
}
#[test]
fn finished_checkpoint_survives_restart_and_turn_cap_is_not_reset() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 1, 100);
    let request = spec("r1", None, 40);
    let ticket = fresh(&mut store, &lease, &request);
    let h = ticket.observer();
    let saved = store
        .finish_mock_inference(&h, &receipt(&h, Some(17)))
        .unwrap();
    store.defer_work(&lease, 0).unwrap();
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    let current = store
        .claim_work(
            "after-restart",
            utc_now_ms().unwrap(),
            Duration::from_secs(60),
        )
        .unwrap()
        .unwrap();
    let view = store.inference_checkpoint("task-a").unwrap();
    assert_eq!(view.latest_checkpoint, saved.checkpoint_ref);
    assert_eq!(view.turns_used, 1);
    assert!(matches!(
        store.admit_mock_inference(&current, &request).unwrap(),
        InferenceAdmission::Recorded(_)
    ));
    assert!(matches!(
        store.admit_mock_inference(&current, &spec("r2", saved.checkpoint_ref, 1)),
        Err(Error::Denied("MODEL_TURN_LIMIT"))
    ));
    assert_eq!(count(&store, "model.admitted"), 1);
    pending_task(&store);
}
#[test]
fn observed_usage_without_final_charge_retains_full_reservation_after_restart() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 3, 50);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let saved = store.finish_mock_inference(&h, &receipt(&h, None)).unwrap();
    assert_eq!(
        store
            .inference_checkpoint("task-a")
            .unwrap()
            .uncertain_usage_requests,
        1
    );
    store.defer_work(&lease, 0).unwrap();
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    let current = store
        .claim_work("again", utc_now_ms().unwrap(), Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert_eq!(store.budget_committed("task-a").unwrap(), 40);
    assert!(matches!(
        store.admit_mock_inference(&current, &spec("r2", saved.checkpoint_ref, 11)),
        Err(Error::Denied("MODEL_BUDGET_EXHAUSTED"))
    ));
}
#[test]
fn model_and_action_reservations_share_the_same_task_cap() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let run = lease.run().unwrap();
    store
        .propose_mock(
            "action-a",
            run,
            &MockPayload {
                target: "target-a".into(),
                value: "expected".into(),
            },
        )
        .unwrap();
    store.prepare_mock("action-a", run).unwrap();
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 70));
    let mut service = MockService::open(&temp.0.join("external.sqlite")).unwrap();
    assert!(matches!(
        store.dispatch_mock("action-a", run, &mut service, MockMode::Normal, 31),
        Err(Error::Denied("BUDGET_EXHAUSTED"))
    ));
    assert_eq!(service.effect_count().unwrap(), 0);
    let h = ticket.observer();
    store
        .finish_mock_inference(&h, &receipt(&h, Some(20)))
        .unwrap();
    store
        .dispatch_mock("action-a", run, &mut service, MockMode::Normal, 80)
        .unwrap();
    assert_eq!(store.budget_committed("task-a").unwrap(), 100);
    assert_eq!(service.effect_count().unwrap(), 1);
}
#[test]
fn unknown_model_blocks_probe_checkpoint_and_yield_without_erasing_the_request() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    assert!(store.finish_probe(&lease, lease.contract_hash()).is_err());
    assert!(store.defer_work(&lease, 0).is_err());
    store.mark_inference_unknown(&ticket.observer()).unwrap();
    assert!(store.finish_probe(&lease, lease.contract_hash()).is_err());
    assert_eq!(
        store
            .inference_checkpoint("task-a")
            .unwrap()
            .committed_micro_usd,
        40
    );
}
#[test]
fn repeated_protocol_failure_history_survives_restart_and_requires_diagnosis() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let mut previous = None;
    for id in ["r1", "r2"] {
        let ticket = fresh(&mut store, &lease, &spec(id, previous, 20));
        let h = ticket.observer();
        let mut received = receipt(&h, Some(10));
        received.finish = InferenceFinish::Protocol;
        previous = store
            .finish_mock_inference(&h, &received)
            .unwrap()
            .checkpoint_ref;
    }
    store.defer_work(&lease, 0).unwrap();
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    let current = store
        .claim_work("again", utc_now_ms().unwrap(), Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert!(matches!(
        store.admit_mock_inference(&current, &spec("r3", previous, 20)),
        Err(Error::Denied("MODEL_DIAGNOSIS_REQUIRED"))
    ));
    assert_eq!(store.inference_checkpoint("task-a").unwrap().turns_used, 2);
}
#[test]
fn capacity_auth_network_and_cancelled_receipts_cannot_silently_resume() {
    for finish in [
        InferenceFinish::Capacity,
        InferenceFinish::Auth,
        InferenceFinish::Network,
        InferenceFinish::Cancelled,
    ] {
        let temp = Temp::new();
        let (mut store, lease) = setup(&temp.0, 4, 100);
        let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
        let h = ticket.observer();
        let mut received = receipt(&h, Some(10));
        received.finish = finish;
        if finish == InferenceFinish::Capacity {
            received.retry_after_ms = Some(60000);
        }
        let saved = store.finish_mock_inference(&h, &received).unwrap();
        assert!(!saved.output_accepted_at_commit);
        assert!(matches!(
            store.admit_mock_inference(&lease, &spec("r2", saved.checkpoint_ref, 20)),
            Err(Error::Denied("MODEL_WAKE_REQUIRED"))
        ));
    }
}
#[test]
fn malformed_specs_and_receipts_do_not_modify_budget_or_poison_valid_store() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let before = tip(&store);
    for bad in [
        spec("r1", None, -1),
        spec("", None, 1),
        spec("r1", Some("bad".into()), 1),
        InferenceSpec {
            timeout_ms: 0,
            ..spec("r1", None, 1)
        },
    ] {
        assert!(store.admit_mock_inference(&lease, &bad).is_err());
    }
    assert_eq!(tip(&store), before);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let before = tip(&store);
    for bad in [
        receipt(&h, Some(41)),
        receipt(&h, Some(-1)),
        InferenceReceipt {
            request_hash: "b".repeat(64),
            ..receipt(&h, Some(10))
        },
        InferenceReceipt {
            retry_after_ms: Some(1),
            ..receipt(&h, Some(10))
        },
    ] {
        assert!(store.finish_mock_inference(&h, &bad).is_err());
    }
    assert_eq!(tip(&store), before);
    assert!(!store.poisoned);
    store
        .finish_mock_inference(&h, &receipt(&h, Some(10)))
        .unwrap();
}
#[test]
fn foreign_store_observer_and_lease_cannot_update_another_request() {
    let a = Temp::new();
    let b = Temp::new();
    let (mut first, l1) = setup(&a.0, 4, 100);
    let (mut second, l2) = setup(&b.0, 4, 100);
    let t1 = fresh(&mut first, &l1, &spec("r1", None, 40));
    fresh(&mut second, &l2, &spec("r1", None, 40));
    assert!(second
        .admit_mock_inference(&l1, &spec("r2", None, 1))
        .is_err());
    assert!(matches!(
        second.finish_mock_inference(&t1.observer(), &receipt(&t1.observer(), Some(10))),
        Err(Error::Denied("MODEL_OBSERVER_MISMATCH"))
    ));
    assert_eq!(count(&second, "model.finished"), 0);
}
#[test]
fn event_write_failure_rolls_back_admission_payload_and_reservation_then_freezes() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let before = tip(&store);
    store.conn.execute_batch("CREATE TRIGGER fail_model BEFORE INSERT ON events WHEN new.kind='model.admitted' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(store
        .admit_mock_inference(&lease, &spec("r1", None, 40))
        .is_err());
    assert!(store.poisoned);
    assert_eq!(count(&store, "model.admitted"), 0);
    assert_eq!(tip(&store), before);
    let payloads: i64 = store
        .conn
        .query_row("SELECT count(*) FROM payloads", [], |r| r.get(0))
        .unwrap();
    assert_eq!(payloads, 0);
    assert_eq!(crate::committed_budget(&store.conn, "task-a").unwrap(), 0);
}
#[test]
fn failed_receipt_commit_does_not_release_reserved_cost_or_create_checkpoint() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let before = tip(&store);
    store.conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON events WHEN new.kind='model.finished' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(store
        .finish_mock_inference(&h, &receipt(&h, Some(10)))
        .is_err());
    assert!(store.poisoned);
    assert_eq!(tip(&store), before);
    assert_eq!(count(&store, "model.finished"), 0);
    assert_eq!(crate::committed_budget(&store.conn, "task-a").unwrap(), 40);
}
#[test]
fn startup_audit_rejects_unknown_model_records_instead_of_ignoring_them() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    fresh(&mut store, &lease, &spec("r1", None, 40));
    store
        .conn
        .execute(
            "INSERT INTO events(aggregate_id,kind,payload) VALUES(?1,'model.future','{}')",
            [key("task-a")],
        )
        .unwrap();
    drop(store);
    assert!(matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)));
}
#[test]
fn older_state_backup_cannot_erase_a_later_inference_reservation() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let backup = temp.0.join("before.sqlite");
    store.backup_state(&backup).unwrap();
    fresh(&mut store, &lease, &spec("r1", None, 40));
    drop(store);
    fs::copy(backup, temp.0.join("state.sqlite")).unwrap();
    assert!(matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)));
}
#[test]
fn repeated_reopen_does_not_duplicate_unknown_events_or_reset_usage() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    fresh(&mut store, &lease, &spec("r1", None, 40));
    drop(store);
    for _ in 0..3 {
        let mut store = Store::open(&temp.0).unwrap();
        assert_eq!(count(&store, "model.unknown"), 1);
        assert_eq!(store.inference_checkpoint("task-a").unwrap().turns_used, 1);
        assert_eq!(store.budget_committed("task-a").unwrap(), 40);
    }
}
#[test]
fn usage_observations_are_bounded_without_refunding_or_marking_finished() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    for n in 1..=64 {
        store
            .observe_inference_usage(
                &h,
                &InferenceUsage {
                    input_tokens: n,
                    output_tokens: 0,
                    reported: true,
                },
            )
            .unwrap();
    }
    assert!(store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                input_tokens: 65,
                output_tokens: 0,
                reported: true
            }
        )
        .is_err());
    assert_eq!(count(&store, "model.usage"), 64);
    assert_eq!(store.budget_committed("task-a").unwrap(), 40);
}
#[test]
fn aggregate_token_overflow_is_explicit_and_preserves_individual_observations() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let mut previous = None;
    for id in ["r1", "r2"] {
        let ticket = fresh(&mut store, &lease, &spec(id, previous, 20));
        let h = ticket.observer();
        let mut received = receipt(&h, Some(10));
        received.usage.input_tokens = 9_007_199_254_740_991;
        previous = store
            .finish_mock_inference(&h, &received)
            .unwrap()
            .checkpoint_ref;
    }
    let view = store.inference_checkpoint("task-a").unwrap();
    assert!(view.usage_overflow);
    assert_eq!(view.input_tokens, 9_007_199_254_740_991);
    assert_eq!(view.requests[1].usage.input_tokens, 9_007_199_254_740_991);
    assert!(!store.poisoned);
}

#[test]
fn crash_child() {
    let Some(root) = std::env::var_os("TADA_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let (mut store, lease) = setup(root, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let received = receipt(&h, Some(17));
    // Independent mock provider ledger has no unique request key or dedup cache.
    // A second transmission would create a second row and fail the parent test.
    let external = Connection::open(root.join("provider.sqlite")).unwrap();
    crate::configure(&external).unwrap();
    external
        .execute_batch("CREATE TABLE results(id INTEGER PRIMARY KEY, receipt TEXT NOT NULL);")
        .unwrap();
    external
        .execute(
            "INSERT INTO results(receipt) VALUES(?1)",
            [serde_json::to_string(&received).unwrap()],
        )
        .unwrap();
    store
        .observe_inference_usage(
            &h,
            &InferenceUsage {
                input_tokens: 10,
                output_tokens: 3,
                reported: true,
            },
        )
        .unwrap();
    store.finish_mock_inference(&h, &received).unwrap();
    panic!("fault boundary not reached");
}
#[test]
fn nine_real_process_kills_preserve_inference_or_quarantine_witness_gap() {
    let phases = [
        "model_admit.before",
        "model_admit.witness",
        "model_admit.commit",
        "model_usage.before",
        "model_usage.witness",
        "model_usage.commit",
        "model_finish.before",
        "model_finish.witness",
        "model_finish.commit",
    ];
    assert_eq!(phases.len(), 9, "fixed process-kill denominator");
    for phase in phases {
        let temp = Temp::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "model_ledger::tests::crash_child", "--nocapture"])
            .env("TADA_TEST_ROOT", &temp.0)
            .env("TADA_TEST_PHASE", phase)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !temp.0.join("boundary.ready").exists() && Instant::now() < deadline {
            if let Some(exit) = child.try_wait().unwrap() {
                panic!("child exited before {phase}: {exit}");
            }
            thread::sleep(Duration::from_millis(10));
        }
        let reached = temp.0.join("boundary.ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(reached, "unreached boundary {phase}");
        let external = if temp.0.join("provider.sqlite").exists() {
            Some(Connection::open(temp.0.join("provider.sqlite")).unwrap())
        } else {
            None
        };
        let provider_calls: i64 = external
            .as_ref()
            .map(|c| {
                c.query_row("SELECT count(*) FROM results", [], |r| r.get(0))
                    .unwrap()
            })
            .unwrap_or(0);
        assert_eq!(provider_calls, i64::from(!phase.starts_with("model_admit")));
        if phase.ends_with("witness") {
            assert!(
                matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)),
                "{phase}"
            );
            continue;
        }
        let mut store = Store::open(&temp.0).unwrap();
        let mut view = store.inference_checkpoint("task-a").unwrap();
        if phase == "model_admit.before" {
            assert_eq!(view.turns_used, 0);
            assert_eq!(view.committed_micro_usd, 0);
        } else {
            assert_eq!(view.turns_used, 1);
            assert_eq!(
                view.committed_micro_usd,
                if phase == "model_finish.commit" {
                    17
                } else {
                    40
                }
            );
            if phase != "model_finish.commit" {
                assert_eq!(view.requests[0].state, InferenceState::Unknown);
            }
            if let Some(external) = external.as_ref() {
                let raw: String = external
                    .query_row("SELECT receipt FROM results", [], |r| r.get(0))
                    .unwrap();
                let received: InferenceReceipt = serde_json::from_str(&raw).unwrap();
                let h = store.inference_observer("task-a", "r1").unwrap();
                store.finish_mock_inference(&h, &received).unwrap();
                view = store.inference_checkpoint("task-a").unwrap();
                assert_eq!(view.committed_micro_usd, 17);
                if phase != "model_finish.commit" {
                    assert!(!view.requests[0].output_accepted_at_commit);
                }
                assert_eq!(
                    external
                        .query_row("SELECT count(*) FROM results", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    1
                );
            }
            assert_eq!(count(&store, "model.admitted"), 1);
        }
        pending_task(&store);
        println!("inference fault {phase}: preserved, no retransmission");
    }
}

#[test]
fn next_model_request_waits_for_tool_result_lineage_not_merely_a_proposal() {
    let temp = Temp::new();
    let (mut store, lease) = setup(&temp.0, 4, 100);
    let ticket = fresh(&mut store, &lease, &spec("r1", None, 40));
    let h = ticket.observer();
    let proposal=tada_contracts::decode(&json!({"schema_version":1,"call_id":"call-1","task_id":"task-a","tool":"task.contract_digest","tool_version":1,"resource":"task://task-a/contract","purpose":"verify_input_snapshot","arguments":{"expected_hash":lease.contract_hash()}})).unwrap();
    let mut received = receipt(&h, Some(17));
    received.finish = InferenceFinish::ToolCalls;
    received.proposals = vec![proposal];
    let saved = store.finish_mock_inference(&h, &received).unwrap();
    assert!(matches!(
        store.admit_mock_inference(&lease, &spec("r2", saved.checkpoint_ref, 40)),
        Err(Error::Denied("MODEL_TOOL_OBSERVATION_REQUIRED"))
    ));
    assert_eq!(count(&store, "model.admitted"), 1);
    assert_eq!(count(&store, "worker.call_completed"), 0);
}
#[test]
fn unknown_task_checkpoint_is_not_an_empty_successful_snapshot() {
    let temp = Temp::new();
    let (mut store, _) = setup(&temp.0, 4, 100);
    assert!(matches!(
        store.inference_checkpoint("missing"),
        Err(Error::Denied("MODEL_TASK_NOT_FOUND"))
    ));
    assert!(!store.poisoned);
}
