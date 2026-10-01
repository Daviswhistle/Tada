use super::*;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Barrier, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "tada-core02-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn contract(id: &str) -> TaskContract {
    tada_contracts::decode(&json!({"task_id":id,"contract_version":1,"goal":"exercise the local mock ledger","inputs":[],"deliverables":[],"acceptance":["mock.matches"],"external_effects":[{"capability":"mock.apply","account_ref":"mock-account","target":"target-a","purpose":"mock-test"}],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]})).unwrap()
}
fn payload() -> MockPayload {
    MockPayload {
        target: "target-a".into(),
        value: "expected".into(),
    }
}
fn setup(root: &Path) -> (Store, MockService, Lease) {
    let mut store = Store::open(root).unwrap();
    store.create_task(&contract("task-a"), 100).unwrap();
    let lease = store.start_run("task-a", Duration::from_secs(60)).unwrap();
    store.propose_mock("action-a", &lease, &payload()).unwrap();
    store.prepare_mock("action-a", &lease).unwrap();
    let service = MockService::open(&root.join("external.sqlite")).unwrap();
    (store, service, lease)
}
fn state(store: &Store) -> Value {
    snapshot(&store.conn, "task-a").unwrap()
}
fn record(store: &Store) -> Value {
    action(&store.conn, "action-a").unwrap()
}
fn attempts(store: &Store) -> i64 {
    store
        .conn
        .query_row("SELECT count(*) FROM attempts", [], |r| r.get(0))
        .unwrap()
}
fn witness_tip(store: &Store) -> i64 {
    store
        .witness
        .query_row("SELECT coalesce(max(seq),0) FROM journal", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn wal_full_foreign_keys_and_single_owner() {
    let temp = Temp::new();
    let (store, _service, _lease) = setup(&temp.0);
    for conn in [&store.conn, &store.witness] {
        assert_eq!(
            conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        assert_eq!(
            conn.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    assert!(matches!(Store::open(&temp.0), Err(Error::AlreadyOpen)));
}
#[test]
fn second_run_is_denied_without_changing_events_or_witness() {
    let temp = Temp::new();
    let (mut store, _, _) = setup(&temp.0);
    let tip = witness_tip(&store);
    let before = state(&store);
    assert!(store.start_run("task-a", Duration::from_secs(60)).is_err());
    assert_eq!(state(&store), before);
    assert_eq!(witness_tip(&store), tip);
}
#[test]
fn receipt_is_not_verification_and_action_is_not_task_success() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 30)
        .unwrap();
    assert_eq!(record(&store)["state"], "ACKNOWLEDGED");
    assert_ne!(state(&store)["completion_status"], "SUCCEEDED");
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store)["state"], "VERIFIED");
    assert_ne!(state(&store)["completion_status"], "SUCCEEDED");
    assert_eq!(
        state(&store)["unmet_required_criteria"],
        json!(["mock.matches"])
    );
    assert_eq!(service.effect_count().unwrap(), 1);
}
#[test]
fn response_loss_survives_restart_without_resend() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 40)
        .unwrap();
    assert_eq!(record(&store)["state"], "UNCERTAIN");
    assert_eq!(store.budget_committed("task-a").unwrap(), 40);
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 40)
        .is_err());
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store)["state"], "VERIFIED");
    assert_eq!(service.effect_count().unwrap(), 1);
    assert_eq!(attempts(&store), 1);
    assert_eq!(store.budget_committed("task-a").unwrap(), 40);
}
#[test]
fn cancel_before_admission_blocks_queued_grant_and_is_durable() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store.cancel("task-a").unwrap();
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 10)
        .is_err());
    let cancelled = state(&store);
    let notifications = store.pending_notifications().unwrap();
    store.cancel("task-a").unwrap();
    assert_eq!(state(&store), cancelled);
    assert_eq!(store.pending_notifications().unwrap(), notifications);
    drop(store);
    let store = Store::open(&temp.0).unwrap();
    assert_eq!(state(&store)["execution_status"], "CANCELLED");
    assert_eq!(state(&store)["cancel_epoch"], 1);
    assert_eq!(service.effect_count().unwrap(), 0);
}
#[test]
fn admitted_effect_can_arrive_after_cancel_but_new_effects_cannot() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let admitted = store.admit("action-a", &lease, 20).unwrap();
    store.cancel("task-a").unwrap();
    service.apply(&admitted, MockMode::DropResponse).unwrap();
    assert_eq!(state(&store)["completion_status"], "OUTCOME_UNKNOWN");
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 20)
        .is_err());
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(state(&store)["execution_status"], "CANCELLED");
    assert_eq!(record(&store)["state"], "VERIFIED");
    assert_ne!(state(&store)["completion_status"], "SUCCEEDED");
    assert_eq!(service.effect_count().unwrap(), 1);
}
#[test]
fn cancelled_unknown_outcome_is_not_erased_on_restart() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 25)
        .unwrap();
    store.cancel("task-a").unwrap();
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    service.hide_observations(true);
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(state(&store)["execution_status"], "CANCELLED");
    assert_eq!(state(&store)["completion_status"], "OUTCOME_UNKNOWN");
    assert_eq!(store.budget_committed("task-a").unwrap(), 25);
}
#[test]
fn cached_revoked_grant_cannot_dispatch() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store.revoke_mock_grant("action-a").unwrap();
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 1)
        .is_err());
    assert_eq!(service.effect_count().unwrap(), 0);
    assert_eq!(attempts(&store), 0);
}
#[test]
fn current_policy_revision_and_explicit_deny_are_rechecked() {
    for denied in [true, false] {
        let temp = Temp::new();
        let (mut store, mut service, lease) = setup(&temp.0);
        store.set_mock_policy_denied(denied).unwrap();
        assert!(store
            .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 1)
            .is_err());
        assert_eq!(service.effect_count().unwrap(), 0);
    }
}
#[test]
fn stale_fence_and_generation_do_not_admit() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let mut stale = lease.clone();
    stale.fence += 1;
    assert!(store
        .dispatch_mock("action-a", &stale, &mut service, MockMode::Normal, 1)
        .is_err());
    stale = lease.clone();
    stale.generation += 1;
    assert!(store
        .dispatch_mock("action-a", &stale, &mut service, MockMode::Normal, 1)
        .is_err());
    assert_eq!(attempts(&store), 0);
}
#[test]
fn old_lease_expires_even_on_same_boot_and_pending_action_is_not_replayed() {
    let temp = Temp::new();
    let (store, mut service, lease) = setup(&temp.0);
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    assert_eq!(record(&store)["state"], "REJECTED");
    let fresh = store.start_run("task-a", Duration::from_secs(60)).unwrap();
    assert!(fresh.generation > lease.generation);
    assert!(fresh.fence > lease.fence);
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 1)
        .is_err());
    assert_eq!(service.effect_count().unwrap(), 0);
}
#[test]
fn monotonic_expiry_does_not_depend_on_wall_clock() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    // Advance the private monotonic origin deterministically; no OS clock change.
    store.clock = Instant::now()
        .checked_sub(Duration::from_secs(120))
        .unwrap();
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 1)
        .is_err());
    assert_eq!(service.effect_count().unwrap(), 0);
}
#[test]
fn out_of_scope_target_is_denied_before_storage() {
    let temp = Temp::new();
    let (mut store, _, lease) = setup(&temp.0);
    let tip = witness_tip(&store);
    let bad = MockPayload {
        target: "another-account".into(),
        value: "data".into(),
    };
    assert!(store.propose_mock("action-b", &lease, &bad).is_err());
    assert_eq!(witness_tip(&store), tip);
}
#[test]
fn insufficient_budget_denies_without_attempt_or_external_effect() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let tip = witness_tip(&store);
    assert!(matches!(
        store.dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 101),
        Err(Error::Denied("BUDGET_EXHAUSTED"))
    ));
    assert_eq!(store.budget_committed("task-a").unwrap(), 0);
    assert_eq!(witness_tip(&store), tip);
    assert_eq!(attempts(&store), 0);
    assert_eq!(service.effect_count().unwrap(), 0);
}
#[test]
fn maximum_integer_budget_does_not_use_float_arithmetic() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.0).unwrap();
    assert!(store
        .create_task(
            &contract("too-large"),
            i64::try_from(SafeInteger::MAX).unwrap() + 1
        )
        .is_err());
    store
        .create_task(
            &contract("task-a"),
            i64::try_from(SafeInteger::MAX).unwrap(),
        )
        .unwrap();
    let lease = store.start_run("task-a", Duration::from_secs(60)).unwrap();
    store.propose_mock("action-a", &lease, &payload()).unwrap();
    store.prepare_mock("action-a", &lease).unwrap();
    let mut service = MockService::open(&temp.0.join("external.sqlite")).unwrap();
    store
        .dispatch_mock(
            "action-a",
            &lease,
            &mut service,
            MockMode::DropResponse,
            i64::try_from(SafeInteger::MAX).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store.budget_committed("task-a").unwrap(),
        i64::try_from(SafeInteger::MAX).unwrap()
    );
}
#[test]
fn applied_mismatch_preserves_actual_effect_and_failed_acceptance() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock(
            "action-a",
            &lease,
            &mut service,
            MockMode::AppliedMismatch,
            30,
        )
        .unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    let before = record(&store);
    assert_eq!(before["state"], "ACKNOWLEDGED");
    assert_eq!(before["side_effect_state"], "confirmed");
    assert_eq!(before["acceptance_status"], "fail");
    assert_eq!(before["reconciliation_verdict"], "APPLIED_MISMATCH");
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store), before);
    assert_eq!(service.effect_count().unwrap(), 1);
}
#[test]
fn missing_and_ambiguous_observation_never_authorize_retry() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let admitted = store.admit("action-a", &lease, 5).unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store)["state"], "UNCERTAIN");
    // Demonstrate that the service would expose duplicates instead of hiding them.
    service.apply(&admitted, MockMode::Normal).unwrap();
    service.apply(&admitted, MockMode::Normal).unwrap();
    assert_eq!(service.effect_count().unwrap(), 2);
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store)["state"], "UNCERTAIN");
    assert_eq!(attempts(&store), 1);
}
#[test]
fn acknowledged_effect_is_not_erased_when_observation_disappears() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 10)
        .unwrap();
    let before = record(&store);
    service.hide_observations(true);
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store), before);
}
#[test]
fn repeated_unknown_observation_and_restart_do_not_duplicate_notifications() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 10)
        .unwrap();
    let before = store.pending_notifications().unwrap();
    service.hide_observations(true);
    store.reconcile_mock("action-a", &service).unwrap();
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(store.pending_notifications().unwrap(), before);
}
#[test]
fn durable_outbox_replays_same_key_and_acknowledgement_is_idempotent() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 10)
        .unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    let pending = store.pending_notifications().unwrap();
    assert!(!pending.is_empty());
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    assert_eq!(store.pending_notifications().unwrap(), pending);
    for note in pending {
        store.acknowledge_notification(&note.key).unwrap();
        store.acknowledge_notification(&note.key).unwrap();
    }
    assert!(store.pending_notifications().unwrap().is_empty());
}
#[test]
fn state_and_event_rollback_together_on_event_write_failure() {
    let temp = Temp::new();
    let (mut store, _, _) = setup(&temp.0);
    let before = state(&store);
    let tip = witness_tip(&store);
    store.conn.execute_batch("CREATE TRIGGER inject_failure BEFORE INSERT ON events WHEN new.kind='task.cancelled' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
    assert!(store.cancel("task-a").is_err());
    assert_eq!(state(&store), before);
    assert_eq!(witness_tip(&store), tip);
    assert!(store.poisoned);
}
#[test]
fn receipt_write_failure_freezes_new_effects_but_preserves_reconciliation() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let admitted = store.admit("action-a", &lease, 20).unwrap();
    let receipt = service.apply(&admitted, MockMode::Normal).unwrap().unwrap();
    store.conn.execute_batch("PRAGMA query_only=ON").unwrap();
    assert!(store.record_receipt("action-a", &receipt).is_err());
    assert!(store.poisoned);
    assert!(store.create_task(&contract("task-b"), 100).is_err());
    store.conn.execute_batch("PRAGMA query_only=OFF").unwrap();
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(record(&store)["state"], "VERIFIED");
    assert_eq!(service.effect_count().unwrap(), 1);
}
#[test]
fn sqlite_full_rolls_back_without_a_phantom_witness_commit() {
    let temp = Temp::new();
    let (mut store, _, _) = setup(&temp.0);
    let pages: i64 = store
        .conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .conn
        .execute_batch(&format!("PRAGMA max_page_count={pages}"))
        .unwrap();
    let tip = witness_tip(&store);
    let result = store.transact("fill_test", |tx| {
        tx.execute(
            "INSERT INTO payloads(hash,content) VALUES(?1,zeroblob(1048576))",
            ["f".repeat(64)],
        )?;
        Ok(())
    });
    assert!(
        matches!(result,Err(Error::Sql(rusqlite::Error::SqliteFailure(e,_))) if e.extended_code==13)
    );
    assert!(store.poisoned);
    assert_eq!(witness_tip(&store), tip);
}
#[test]
fn attempts_payloads_receipts_and_events_are_append_only() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 10)
        .unwrap();
    for table in ["attempts", "payloads", "receipts", "events"] {
        assert!(store
            .conn
            .execute(&format!("DELETE FROM {table}"), [])
            .is_err());
    }
    assert_eq!(attempts(&store), 1);
}
#[test]
fn mismatched_event_snapshot_and_schema_fail_writable_open() {
    let temp = Temp::new();
    let (store, _, _) = setup(&temp.0);
    store
        .conn
        .execute(
            "UPDATE tasks SET snapshot=json_set(snapshot,'$.version',99) WHERE id='task-a'",
            [],
        )
        .unwrap();
    drop(store);
    assert!(matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)));
    assert_eq!(Store::inspect(&temp.0).unwrap().len(), 1);
}
#[test]
fn missing_witness_is_not_silently_recreated() {
    let temp = Temp::new();
    let (store, service, _) = setup(&temp.0);
    drop(store);
    drop(service);
    fs::remove_file(temp.0.join("witness.sqlite")).unwrap();
    assert!(matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)));
    assert!(!temp.0.join("witness.sqlite").exists());
}
#[test]
fn restored_backup_after_external_effect_is_quarantined_not_replayed() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let backup = temp.0.join("backup.sqlite");
    store.backup_state(&backup).unwrap();
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 10)
        .unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    drop(store);
    fs::copy(&backup, temp.0.join("state.sqlite")).unwrap();
    assert!(matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)));
    assert_eq!(Store::inspect(&temp.0).unwrap().len(), 1);
    assert_eq!(service.effect_count().unwrap(), 1);
}
#[test]
fn cancellation_race_has_a_single_ordered_admission_boundary() {
    for _ in 0..16 {
        let temp = Temp::new();
        let (store, _, lease) = setup(&temp.0);
        let shared = Arc::new(Mutex::new(store));
        let gate = Arc::new(Barrier::new(3));
        let a = Arc::clone(&shared);
        let ga = Arc::clone(&gate);
        let sender = thread::spawn(move || {
            ga.wait();
            a.lock().unwrap().admit("action-a", &lease, 10).is_ok()
        });
        let b = Arc::clone(&shared);
        let gb = Arc::clone(&gate);
        let canceller = thread::spawn(move || {
            gb.wait();
            b.lock().unwrap().cancel("task-a").unwrap();
        });
        gate.wait();
        let admitted = sender.join().unwrap();
        canceller.join().unwrap();
        let store = shared.lock().unwrap();
        assert_eq!(state(&store)["execution_status"], "CANCELLED");
        let cancel_seq: i64 = store
            .conn
            .query_row(
                "SELECT seq FROM events WHERE kind='task.cancelled'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if admitted {
            let dispatch_seq: i64 = store
                .conn
                .query_row(
                    "SELECT seq FROM events WHERE kind='action.dispatch_admitted'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(dispatch_seq < cancel_seq);
            assert_eq!(state(&store)["completion_status"], "OUTCOME_UNKNOWN");
        } else {
            assert_eq!(attempts(&store), 0);
        }
    }
}

// Launched alone in a subprocess by the fault matrix below; no-op in the normal
// test run. Parent uses an actual OS kill and waits for process reaping.
#[test]
fn crash_child() {
    let Some(root) = std::env::var_os("TADA_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let (mut store, mut service, lease) = setup(root);
    checkpoint("before_admission");
    let phase = std::env::var("TADA_TEST_PHASE").unwrap();
    if phase == "cancel.witness" {
        store.cancel("task-a").unwrap();
    }
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, 20)
        .unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    panic!("requested fault boundary was not reached");
}
#[test]
fn real_process_kill_matrix_preserves_effects_and_fails_closed() {
    let phases = [
        "before_admission",
        "dispatch.witness",
        "dispatch.commit",
        "external.effect",
        "receipt.commit",
        "reconcile.commit",
        "cancel.witness",
    ];
    assert_eq!(phases.len(), 7, "fixed fault denominator");
    for phase in phases {
        let temp = Temp::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::crash_child", "--nocapture"])
            .env("TADA_TEST_ROOT", &temp.0)
            .env("TADA_TEST_PHASE", phase)
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
        let status = child.wait().unwrap();
        assert!(reached, "fault boundary not reached: {phase}");
        assert!(!status.success());
        let service = MockService::open(&temp.0.join("external.sqlite")).unwrap();
        if matches!(phase, "dispatch.witness" | "cancel.witness") {
            assert!(
                matches!(Store::open(&temp.0), Err(Error::RecoveryRequired)),
                "{phase}"
            );
            assert_eq!(service.effect_count().unwrap(), 0);
            assert_eq!(Store::inspect(&temp.0).unwrap().len(), 1);
            continue;
        }
        let mut store = Store::open(&temp.0).unwrap();
        if phase == "before_admission" {
            assert_eq!(record(&store)["state"], "REJECTED");
            assert_eq!(attempts(&store), 0);
        } else {
            store.reconcile_mock("action-a", &service).unwrap();
            let applied = matches!(
                phase,
                "external.effect" | "receipt.commit" | "reconcile.commit"
            );
            assert_eq!(
                record(&store)["state"],
                if applied { "VERIFIED" } else { "UNCERTAIN" },
                "{phase}"
            );
            assert_eq!(attempts(&store), 1);
            assert_eq!(service.effect_count().unwrap(), i64::from(applied));
            assert_eq!(store.budget_committed("task-a").unwrap(), 20);
            if phase == "reconcile.commit" {
                assert!(!store.pending_notifications().unwrap().is_empty());
            }
        }
        assert_ne!(state(&store)["completion_status"], "SUCCEEDED");
        println!("fault {phase}: passed");
    }
}

#[test]
fn negative_budget_and_reservation_cannot_create_credit() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    let before = witness_tip(&store);
    assert!(store.create_task(&contract("negative-cap"), -1).is_err());
    assert!(store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::Normal, -1)
        .is_err());
    assert_eq!(witness_tip(&store), before);
    assert_eq!(attempts(&store), 0);
    assert_eq!(service.effect_count().unwrap(), 0);
}

#[test]
fn resolved_outcome_suppresses_superseded_decision_without_fake_ack() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 10)
        .unwrap();
    let old = store.pending_notifications().unwrap();
    assert_eq!(old.len(), 1);
    assert_eq!(old[0].kind, "decision_required");
    store.reconcile_mock("action-a", &service).unwrap();
    let current = store.pending_notifications().unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].kind, "stopped");
    assert_ne!(current[0].key, old[0].key);
    let acknowledged: bool = store
        .conn
        .query_row(
            "SELECT delivered FROM outbox WHERE key=?1",
            [&old[0].key],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !acknowledged,
        "supersession must not pretend transport delivery"
    );
    drop(store);
    assert_eq!(
        Store::open(&temp.0)
            .unwrap()
            .pending_notifications()
            .unwrap(),
        current
    );
}
#[test]
fn cancelled_reconciliation_enqueues_current_version_when_execution_is_unchanged() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store
        .dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 10)
        .unwrap();
    store.cancel("task-a").unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    let notes = store.pending_notifications().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].kind, "stopped");
    assert_eq!(
        notes[0].task_version,
        number(&state(&store), "version").unwrap()
    );
    assert_eq!(state(&store)["execution_status"], "CANCELLED");
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(store.pending_notifications().unwrap(), notes);
}
