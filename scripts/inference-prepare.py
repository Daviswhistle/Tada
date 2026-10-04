"""One-shot exact-base integration. Removed together with its branch preparer."""
from pathlib import Path
import subprocess

expected = {
    'crates/store/src/lib.rs': 'e9b6976d11f2d05eccaab083a570094f108263ad',
    'crates/store/src/queue.rs': '649c80283050acfc4a13ffed6300765c9b6f73b0',
    'crates/store/src/control/mod.rs': 'f3b5383f56fb315bc0e5dd2b941aca07ee3f9d08',
}
for name, sha in expected.items():
    actual = subprocess.check_output(['git', 'hash-object', '--', name], text=True).strip()
    assert actual == sha, (name, actual, sha)

def edit(name, replacements):
    path = Path(name)
    body = path.read_text()
    for old, new in replacements:
        assert body.count(old) == 1, (name, old)
        body = body.replace(old, new)
    path.write_text(body)

edit('crates/store/src/lib.rs', [
    ('pub mod mock;\n', 'pub mod mock;\npub mod model_ledger;\n'),
    ('        if version == 2 {\n            queue::audit(self)?;\n        }', '        if version == 2 {\n            queue::audit(self)?;\n            model_ledger::audit(&self.conn)?;\n        }'),
    ('            queue::recover(tx)?;\n', '            queue::recover(tx)?;\n            model_ledger::recover(tx)?;\n'),
    ('''fn committed_budget(conn: &Connection, id: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT coalesce(sum(CASE WHEN status='settled' THEN charged ELSE reserved END),0) FROM reservations WHERE task_id=?1",[id],|r|r.get(0))?)
}''', '''fn committed_budget(conn: &Connection, id: &str) -> Result<i64> {
    let actions: i64 = conn.query_row("SELECT coalesce(sum(CASE WHEN status='settled' THEN charged ELSE reserved END),0) FROM reservations WHERE task_id=?1",[id],|r|r.get(0))?;
    let models = model_ledger::committed(conn, id)?;
    counter(actions.checked_add(models).ok_or(Error::RecoveryRequired)?)
        .map_err(|_| Error::RecoveryRequired)
}'''),
])
edit('crates/store/src/control/mod.rs', [('mod json_input;', 'pub(crate) mod json_input;')])
edit('crates/store/src/queue.rs', [
    ('if !pending(tx, lease.task_id())?.is_empty() {', 'if !pending(tx, lease.task_id())?.is_empty() || crate::model_ledger::pending(tx, lease.task_id())? {'),
    ('if !pending(tx,lease.task_id())?.is_empty() { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }', 'if !pending(tx,lease.task_id())?.is_empty() || crate::model_ledger::pending(tx,lease.task_id())? { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }'),
])
p = Path('crates/store/src/model_ledger.rs')
s = p.read_text().replace('use serde_json::{json, Value};', 'use serde_json::Value;')
s = s.replace('output_available', 'output_accepted_at_commit')
old = '    pub uncertain_usage_requests: i64,\n'
assert s.count(old) == 1
s = s.replace(old, old + '    pub usage_overflow: bool,\n')
old = 'pub(crate) fn committed(conn: &Connection, task: &str) -> Result<i64> {'
assert s.count(old) == 1
s = s.replace(old, '''pub(crate) fn pending(conn: &Connection, task: &str) -> Result<bool> {
    Ok(load(conn, task)?.values().any(|e| e.view.state != InferenceState::Finished))
}
''' + old)
old = '                uncertain_usage_requests:0,blocked_on_observation:false,'
assert s.count(old) == 1
s = s.replace(old, '                uncertain_usage_requests:0,usage_overflow:false,blocked_on_observation:false,')
old = '''                checkpoint.input_tokens = checked_add(checkpoint.input_tokens, entry.usage.input_tokens)?;
                checkpoint.output_tokens = checked_add(checkpoint.output_tokens, entry.usage.output_tokens)?;'''
assert s.count(old) == 1
s = s.replace(old, '''                match checked_add(checkpoint.input_tokens, entry.usage.input_tokens) {
                    Ok(n) => checkpoint.input_tokens = n,
                    Err(_) => checkpoint.usage_overflow = true,
                }
                match checked_add(checkpoint.output_tokens, entry.usage.output_tokens) {
                    Ok(n) => checkpoint.output_tokens = n,
                    Err(_) => checkpoint.usage_overflow = true,
                }''')
p.write_text(s)
Path(__file__).unlink()
Path('.github/workflows/model-ledger-prepare.yml').unlink()
