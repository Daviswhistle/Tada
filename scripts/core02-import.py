"""One-shot, exact source refinements before formatting the staged CORE-02 code.
The normal CI does not run this script. It is removed in the import commit.
"""
from pathlib import Path
p = Path('crates/store/src/lib.rs')
s = p.read_text()
def replace(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
replace('OpenFlags, OptionalExtension, Transaction,', 'OpenFlags, Transaction,')
replace('    let mut value = snapshot(tx,id)?;\n    let mut statement', '    let mut value = snapshot(tx,id)?;\n    let before = value.clone();\n    let mut statement')
replace('    value["unresolved_effects"] = json!(unresolved);', '    let awaiting: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE task_id=?1 AND state=\'ACKNOWLEDGED\' AND json_extract(record,\'$.acceptance_status\')=\'pending\')",[id],|r|r.get(0))?;\n    value["unresolved_effects"] = json!(unresolved);')
replace('    } else if !unresolved.is_empty() {\n        value["execution_status"]', '    } else if !unresolved.is_empty() || awaiting {\n        value["execution_status"]')
replace('    } else if stop { value["execution_status"] = json!("STOPPED"); }\n    let value = save_task', '    } else if stop { value["execution_status"] = json!("STOPPED"); }\n    else if value["execution_status"] == "WAITING" { value["execution_status"] = json!("READY"); }\n    if value == before { return Ok(value); }\n    let value = save_task')
replace('    if stop || !unresolved.is_empty() {', '    if stop {')
replace('    tx.execute("INSERT INTO outbox(key,task_id,task_version,kind) VALUES(?1,?2,?3,?4)",', '    tx.execute("INSERT INTO outbox(key,task_id,task_version,kind) VALUES(?1,?2,?3,?4) ON CONFLICT(key) DO NOTHING",')
replace('                s.query_map([first], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?\n', '                let rows = s.query_map([first], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;\n                rows\n')
replace('                value["execution_status"] = json!("READY");\n                value.as_object_mut().ok_or(Error::RecoveryRequired)?.remove("wait");\n                save_task(tx,value,"task.recovered")?;\n                refresh_task(tx,&id,false)?;', '                if value["execution_status"] == "RUNNING" {\n                    value["execution_status"] = json!("READY");\n                    value.as_object_mut().ok_or(Error::RecoveryRequired)?.remove("wait");\n                    save_task(tx,value,"task.recovered")?;\n                }\n                let value = refresh_task(tx,&id,false)?;\n                if value["completion_status"] == "OUTCOME_UNKNOWN" { enqueue(tx,&value,"decision_required")?; }')
replace('            let previous: u64 = tx.query_row', '            let unresolved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE task_id=?1 AND state IN (\'DISPATCHING\',\'UNCERTAIN\',\'ACKNOWLEDGED\'))",[id],|r|r.get(0))?;\n            if unresolved { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }\n            let previous: u64 = tx.query_row')
replace('            tx.execute("UPDATE reservations SET status=\'uncertain\' WHERE action_id=?1 AND status=\'reserved\'",[id])?;\n            refresh_task(tx,text(&value,"task_id")?,false)?;', '            tx.execute("UPDATE reservations SET status=\'uncertain\' WHERE action_id=?1 AND status=\'reserved\'",[id])?;\n            let task = refresh_task(tx,text(&value,"task_id")?,false)?;\n            enqueue(tx,&task,"decision_required")?;')
replace('        File::open(ready).unwrap().sync_all().unwrap();', '        OpenOptions::new().write(true).open(ready).unwrap().sync_all().unwrap();')
p.write_text(s)
Path(__file__).unlink()
