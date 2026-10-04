"""Exact source integration for the reviewed v3 accounting compatibility gate."""
from pathlib import Path
import subprocess
assert subprocess.check_output(['git','hash-object','crates/store/src/model_ledger.rs'],text=True).strip() == '8bff73fc0eac697ec845bdefd6a0b82de1e9d658'
assert subprocess.check_output(['git','hash-object','crates/store/src/queue_migration.rs'],text=True).strip() == 'fea7660e6bba26c6c1b0c88cc0557ea88443c596'
def edit(name, pairs):
    p=Path(name);s=p.read_text()
    for old,new in pairs:
        assert s.count(old)==1,(name,old)
        s=s.replace(old,new)
    p.write_text(s)
edit('crates/store/src/lib.rs',[
    ('pub mod model_ledger;','pub mod model_ledger;\nmod model_migration;'),
    ('        if version == 2 {\n            queue::audit(self)?;', '        model_migration::audit(&self.conn)?;\n        if matches!(version, 2 | 3) {\n            queue::audit(self)?;'),
])
edit('crates/store/src/control/json_input.rs',[
    ('pub(super) fn parse(', 'pub(crate) fn parse('),
])
edit('crates/store/src/queue_migration.rs',[
    ('        _ => Err(Error::RecoveryRequired),', '''        3 => Ok(digest(
            format!("{SCHEMA}\\n{}\\n{}", crate::queue::SCHEMA, crate::model_migration::FORMAT).as_bytes(),
        )),
        _ => Err(Error::RecoveryRequired),'''),
])
edit('crates/store/src/model_ledger.rs',[
    ('(receipt.finish == InferenceFinish::ToolCalls) != !receipt.proposals.is_empty()', '(receipt.finish == InferenceFinish::ToolCalls) == receipt.proposals.is_empty()'),
    ('            spec.validate()?;\n            s.check_work_lease(lease)?;', '''            spec.validate()?;
            if crate::queue_migration::version(&s.conn)? != 3 {
                return Err(Error::Denied("MODEL_MIGRATION_REQUIRED"));
            }
            s.check_work_lease(lease)?;'''),
    ('            let values = ordered(load(&s.conn, task)?);', '''            let exists: bool = s.conn.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",[task],|r|r.get(0))?;
            if !exists { return Err(Error::Denied("MODEL_TASK_NOT_FOUND")); }
            let values = ordered(load(&s.conn, task)?);'''),
    ('            if let Some(last) = previous.last().and_then(|e| e.receipt.as_ref()) {', '''            if let Some(last) = previous.last().and_then(|e| e.receipt.as_ref()) {
                if last.finish == InferenceFinish::ToolCalls {
                    // Until the engine checkpoint binds committed tool receipts,
                    // a model proposal is not an observation for the next turn.
                    return Err(Error::Denied("MODEL_TOOL_OBSERVATION_REQUIRED"));
                }'''),
])
edit('crates/store/src/model_ledger/tests.rs',[
    ('    let mut store = Store::open(root).unwrap();\n    store.create_task(&task(turns), cap).unwrap();', '    let mut store = Store::open(root).unwrap();\n    store.enable_mock_inference(&root.join("before-model-v3.sqlite")).unwrap();\n    store.create_task(&task(turns), cap).unwrap();'),
])
p=Path('crates/store/src/model_ledger/tests.rs')
p.write_text(p.read_text()+'''
#[test]
fn next_model_request_waits_for_tool_result_lineage_not_merely_a_proposal() {
    let temp=Temp::new();let (mut store,lease)=setup(&temp.0,4,100);
    let ticket=fresh(&mut store,&lease,&spec("r1",None,40));let h=ticket.observer();
    let proposal=tada_contracts::decode(&json!({"schema_version":1,"call_id":"call-1","task_id":"task-a","tool":"task.contract_digest","tool_version":1,"resource":"task://task-a/contract","purpose":"verify_input_snapshot","arguments":{"expected_hash":lease.contract_hash()}})).unwrap();
    let mut received=receipt(&h,Some(17));received.finish=InferenceFinish::ToolCalls;received.proposals=vec![proposal];
    let saved=store.finish_mock_inference(&h,&received).unwrap();
    assert!(matches!(store.admit_mock_inference(&lease,&spec("r2",saved.checkpoint_ref,40)),Err(Error::Denied("MODEL_TOOL_OBSERVATION_REQUIRED"))));
    assert_eq!(count(&store,"model.admitted"),1);
    assert_eq!(count(&store,"worker.call_completed"),0);
}
#[test]
fn unknown_task_checkpoint_is_not_an_empty_successful_snapshot() {
    let temp=Temp::new();let (mut store,_)=setup(&temp.0,4,100);
    assert!(matches!(store.inference_checkpoint("missing"),Err(Error::Denied("MODEL_TASK_NOT_FOUND"))));
    assert!(!store.poisoned);
}
''')
edit('crates/store/examples/inference_recovery.rs',[
    ('    let mut store = Store::open(&root)?;\n    store.create_task(&contract, 100)?;', '    let mut store = Store::open(&root)?;\n    store.enable_mock_inference(&root.join("before-model-v3.sqlite"))?;\n    store.create_task(&contract, 100)?;'),
])
Path(__file__).unlink()
Path('.github/workflows/model-ledger-prepare.yml').unlink()
