"""One-shot exact CORE-06 integration; removed from the prepared branch."""
from pathlib import Path

def patch(path, replacements):
    p=Path(path)
    s=p.read_text()
    for old,new in replacements:
        assert s.count(old)==1,(path,old,s.count(old))
        s=s.replace(old,new)
    p.write_text(s)

patch('crates/store/src/lib.rs',[
('pub mod control;','pub mod control;\npub mod priority;\npub mod queue;\nmod queue_migration;'),
('    poisoned: bool,\n}', '    poisoned: bool,\n    admission: std::sync::Arc<priority::AdmissionGate>,\n}'),
('    event(tx, text(&value, "task_id")?, kind, &value)?;\n    Ok(value)', '    event(tx, text(&value, "task_id")?, kind, &value)?;\n    queue::sync(tx, &value, false)?;\n    Ok(value)'),
('fn healthy_database(conn: &Connection) -> Result<()> {','fn healthy_database(conn: &Connection, expected_version: i64) -> Result<()> {'),
('version != 1 || fk_problem','version != expected_version || fk_problem'),
('    pub fn open(root: &Path) -> Result<Self> {','    pub fn open(root: &Path) -> Result<Self> {\n        let mut store = Self::open_unrecovered(root, false)?;\n        store.recover()?;\n        Ok(store)\n    }\n\n    pub fn admission_gate(&self) -> std::sync::Arc<priority::AdmissionGate> {\n        std::sync::Arc::clone(&self.admission)\n    }\n\n    fn open_unrecovered(root: &Path, allow_legacy: bool) -> Result<Self> {'),
('            conn.execute_batch(SCHEMA)?;','            conn.execute_batch(SCHEMA)?;\n            conn.execute_batch(queue::SCHEMA)?;'),
('params![store_id, digest(SCHEMA.as_bytes())]','params![store_id, queue_migration::schema_hash(2)?]'),
('        let mut store = Self {','        let store = Self {'),
('            poisoned: false,\n        };\n        store.audit()?;\n        store.recover()?;\n        Ok(store)', '            poisoned: false,\n            admission: std::sync::Arc::new(priority::AdmissionGate::default()),\n        };\n        store.audit()?;\n        if !allow_legacy && queue_migration::version(&store.conn)? == 1 {\n            return Err(Error::Denied("QUEUE_MIGRATION_REQUIRED"));\n        }\n        Ok(store)'),
('        healthy_database(&self.conn)?;\n        healthy_database(&self.witness)?;', '        let version = queue_migration::version(&self.conn)?;\n        let expected_hash = queue_migration::schema_hash(version)?;\n        healthy_database(&self.conn, version)?;\n        healthy_database(&self.witness, 1)?;'),
('hash != digest(SCHEMA.as_bytes())','hash != expected_hash'),
('        Ok(())\n    }\n    fn audit_tail', '        if version == 2 { queue::audit(self)?; }\n        Ok(())\n    }\n    fn audit_tail'),
('            event(\n                tx,\n                "supervisor",','            queue::recover(tx)?;\n            event(\n                tx,\n                "supervisor",'),
])
p=Path('crates/store/src/lib.rs');s=p.read_text()
a=s.index('        self.transact("start_run",|tx| {')
b=s.index('\n    }\n    fn tick',a)
s=s[:a]+'        self.transact("start_run", |tx| queue::start_run_tx(tx, id, until))'+s[b:]
p.write_text(s)

patch('crates/store/src/control/mod.rs',[
('    event(tx, id, "task.created", &value)?;\n    Ok(value)', '    event(tx, id, "task.created", &value)?;\n    crate::queue::sync(tx, &value, false)?;\n    Ok(value)'),
('        let body = session.open(frame)?;\n        let value = match json_input::parse(&body)', '        let body = session.open(frame)?;\n        self.control_body_inner(session, &body)\n    }\n\n    fn control_body_inner(&mut self, session: &mut ServerSession, body: &[u8]) -> Result<Vec<u8>> {\n        let (store_id, generation) = self.control_context()?;\n        if let Err(error) = session.check(&store_id, generation) {\n            session.revoke();\n            return Err(error);\n        }\n        let value = match json_input::parse(body)'),
])
p=Path('crates/store/src/control/mod.rs');s=p.read_text();s+='''
/// Opaque, authenticated request waiting for store admission. It cannot be
/// constructed from a model-provided priority flag or edited after verification.
pub struct PreparedControl {
    session: ServerSession,
    body: Vec<u8>,
    priority: crate::priority::Priority,
}
impl PreparedControl {
    pub fn authenticate(mut session: ServerSession, frame: &[u8]) -> Result<Self> {
        let body = session.open(frame)?;
        let cancellation = session.access == Access::Controller
            && json_input::parse(&body).is_ok_and(|value| {
                value["method"] == "task.cancel" && checked("ControlRequest", &value).is_ok()
            });
        let priority = if cancellation { crate::priority::Priority::Cancellation } else { crate::priority::Priority::Ordinary };
        Ok(Self { session, body, priority })
    }
    pub fn priority(&self) -> crate::priority::Priority { self.priority }
}
impl Store {
    pub fn control_handle_prepared(&mut self, mut request: PreparedControl) -> Result<(ServerSession, Vec<u8>)> {
        // Current generation, expiry and revocation are checked AFTER waiting.
        let result = self.control_body_inner(&mut request.session, &request.body);
        if matches!(&result, Err(Error::Sql(_) | Error::Io(_) | Error::RecoveryRequired)) {
            self.poisoned = true;
            request.session.revoke();
        }
        Ok((request.session, result?))
    }
}
''';p.write_text(s)

patch('crates/local-ipc/src/lib.rs',[
('    let limits = limits.validate()?;\n    let permits', '    let limits = limits.validate()?;\n    let gate = store.lock().map_err(|_| Error::WorkerFailed)?.admission_gate();\n    let permits'),
('                let store = Arc::clone(&store);\n                let credential', '                let store = Arc::clone(&store);\n                let gate = Arc::clone(&gate);\n                let credential'),
('connection(stream, store, credential, limits, stopped).await', 'connection(stream, store, credential, limits, stopped, gate).await'),
('    mut stopped: watch::Receiver<bool>,\n) -> Result<()> {', '    mut stopped: watch::Receiver<bool>,\n    gate: Arc<tada_store::priority::AdmissionGate>,\n) -> Result<()> {'),
('        let owner = Arc::clone(&store);\n        let stop_at_admission', '        let prepared = tada_store::control::PreparedControl::authenticate(session, &frame)?;\n        let ticket = gate.register(prepared.priority())?;\n        let owner = Arc::clone(&store);\n        let stop_at_admission'),
('            let mut store = owner.lock().map_err(|_| Error::WorkerFailed)?;', '            let _permit = ticket.wait()?;\n            let mut store = owner.lock().map_err(|_| Error::WorkerFailed)?;'),
('            let response = store.control_handle(&mut session, &frame)?;\n            Ok::<_, Error>((session, response))', '            Ok::<_, Error>(store.control_handle_prepared(prepared)?)'),
])
# New module import is intentionally removed rather than allow(unused_imports).
p=Path('crates/store/src/queue.rs');s=p.read_text();s=s.replace('use crate::{action, admit_lease,','use crate::{admit_lease,');p.write_text(s)
p=Path('Cargo.toml');s=p.read_text();assert '"crates/agentd"' not in s;s=s.replace('"crates/credential"','"crates/credential", "crates/agentd"');assert '"crates/agentd"' in s;p.write_text(s)
Path(__file__).unlink()
