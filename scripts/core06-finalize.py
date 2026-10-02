"""Synchronize queue after action-only observations; retain task-version semantics."""
from pathlib import Path
p=Path('crates/store/src/lib.rs');s=p.read_text();old='''        save_task(tx, value, "task.effect_observed")?
    };
    if stop {''';new='''        save_task(tx, value, "task.effect_observed")?
    };
    // Verification can finish while the task stays CANCELLED/PENDING. The
    // action changed even when no new task version was necessary.
    queue::sync(tx, &value, false)?;
    if stop {''';assert s.count(old)==1;p.write_text(s.replace(old,new))
p=Path('crates/store/src/queue/tests.rs');s=p.read_text();s+='''
#[test]
fn action_only_verification_retires_cancelled_observation_without_fake_task_version() {
    let temp = Temp::new();
    let mut store = setup(&temp.0);
    let service = effects(&mut store, &temp.0);
    store.cancel("task-a").unwrap();
    let receipt = service.observe("action-a").unwrap().unwrap();
    store.record_receipt("action-a", &receipt).unwrap();
    let before = snapshot(&store.conn, "task-a").unwrap();
    assert_eq!(before["execution_status"], "CANCELLED");
    assert_eq!(before["completion_status"], "PENDING");
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(snapshot(&store.conn, "task-a").unwrap(), before);
    assert_eq!(store.work_entry("task-a").unwrap().state, WorkState::Cancelled);
    assert_eq!(store.work_entry("task-a").unwrap().kind, WorkKind::Advance);
    drop(store);
    let mut store = Store::open(&temp.0).unwrap();
    assert!(store.claim_work("worker", 0, Duration::from_secs(10)).unwrap().is_none());
    assert_eq!(service.effect_count().unwrap(), 1);
}
''';p.write_text(s)
p=Path('docs/queue-supervisor.md');s=p.read_text();old='Every authoritative task transition updates the queue in the same transaction.';new='Every authoritative task transition updates the queue in the same transaction. An action-only observation also refreshes the queue even when the task remains CANCELLED/PENDING with no new task version; verified cancelled effects cannot leave a stale observation assignment.';assert s.count(old)==1;p.write_text(s.replace(old,new))
Path(__file__).unlink()
