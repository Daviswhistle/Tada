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
])
edit('crates/store/src/model_ledger/tests.rs',[
    ('    let mut store = Store::open(root).unwrap();\n    store.create_task(&task(turns), cap).unwrap();', '    let mut store = Store::open(root).unwrap();\n    store.enable_mock_inference(&root.join("before-model-v3.sqlite")).unwrap();\n    store.create_task(&task(turns), cap).unwrap();'),
])
edit('crates/store/examples/inference_recovery.rs',[
    ('    let mut store = Store::open(&root)?;\n    store.create_task(&contract, 100)?;', '    let mut store = Store::open(&root)?;\n    store.enable_mock_inference(&root.join("before-model-v3.sqlite"))?;\n    store.create_task(&contract, 100)?;'),
])
edit('.github/workflows/ci.yml',[
    ('      - name: Run authenticated control replay example\n', '''      - name: Run durable inference reservation and late-observation example
        run: cargo run --locked -p tada-store --example inference_recovery -- "${{ runner.temp }}/tada-model-ledger-demo"
      - name: Run authenticated control replay example
'''),
])
Path(__file__).unlink()
Path('.github/workflows/model-ledger-prepare.yml').unlink()
