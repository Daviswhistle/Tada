"""Apply the outbox review fix, then remove this one-shot import helper."""
from pathlib import Path
p = Path('crates/store/src/lib.rs')
s = p.read_text()
old = '''    if value == before {
        return Ok(value);
    }
    let value = save_task(tx, value, "task.effect_observed")?;'''
new = '''    let value = if value == before {
        value
    } else {
        save_task(tx, value, "task.effect_observed")?
    };'''
assert s.count(old) == 1
s = s.replace(old, new)
old = 'SELECT key,task_id,task_version,kind FROM outbox WHERE delivered=0 ORDER BY task_id,task_version'
new = 'SELECT o.key,o.task_id,o.task_version,o.kind FROM outbox o JOIN tasks t ON t.id=o.task_id WHERE o.delivered=0 AND o.task_version=t.version ORDER BY o.task_id,o.task_version,o.kind'
assert s.count(old) == 1
s = s.replace(old,new)
p.write_text(s)
p = Path('crates/store/src/tests.rs')
s = p.read_text()
s += '''
#[test]
fn resolved_outcome_suppresses_superseded_decision_without_fake_ack() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store.dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 10).unwrap();
    let old = store.pending_notifications().unwrap();
    assert_eq!(old.len(), 1);
    assert_eq!(old[0].kind, "decision_required");
    store.reconcile_mock("action-a", &service).unwrap();
    let current = store.pending_notifications().unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].kind, "stopped");
    assert_ne!(current[0].key, old[0].key);
    let acknowledged: bool = store.conn.query_row("SELECT delivered FROM outbox WHERE key=?1", [&old[0].key], |r| r.get(0)).unwrap();
    assert!(!acknowledged, "supersession must not pretend transport delivery");
    drop(store);
    assert_eq!(Store::open(&temp.0).unwrap().pending_notifications().unwrap(), current);
}
#[test]
fn cancelled_reconciliation_enqueues_current_version_when_execution_is_unchanged() {
    let temp = Temp::new();
    let (mut store, mut service, lease) = setup(&temp.0);
    store.dispatch_mock("action-a", &lease, &mut service, MockMode::DropResponse, 10).unwrap();
    store.cancel("task-a").unwrap();
    store.reconcile_mock("action-a", &service).unwrap();
    let notes = store.pending_notifications().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].kind, "stopped");
    assert_eq!(notes[0].task_version, number(&state(&store), "version").unwrap());
    assert_eq!(state(&store)["execution_status"], "CANCELLED");
    store.reconcile_mock("action-a", &service).unwrap();
    assert_eq!(store.pending_notifications().unwrap(), notes);
}
'''
p.write_text(s)
p = Path('docs/core-02.md')
s = p.read_text()
old = 'An acknowledgement is idempotent, and unacknowledged entries survive reopening.'
new = 'An acknowledgement is idempotent, and unacknowledged entries survive reopening. Pending enumeration returns only the current task version: a resolved decision is not offered again as an obsolete question, and superseding an entry does not falsely mark it delivered. The eventual delivery sink must still revalidate the version at delivery time.'
assert s.count(old) == 1
p.write_text(s.replace(old,new))
Path(__file__).unlink()
