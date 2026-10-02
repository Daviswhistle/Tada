"""Complete exact CORE-06 integration, then remove this import helper."""
from pathlib import Path

def patch(path, old, new):
    p=Path(path);s=p.read_text();assert s.count(old)==1,(path,old,s.count(old));p.write_text(s.replace(old,new))
patch('crates/store/src/priority.rs', 'impl AdmissionGate {', '''impl AdmissionGate {
    /// Bounded diagnostic count. No command body, key or identity is exposed.
    pub fn pending_count(&self, priority: Priority) -> Result<usize> {
        let state = self.state.lock().map_err(|_| Error::RecoveryRequired)?;
        Ok(state.waiting.iter().filter(|(kind, _)| *kind == priority).count())
    }''')
patch('crates/local-ipc/src/priority_tests.rs', 'assert_eq!(h.store.lock().unwrap().task("ipc-task").unwrap().execution_status,tada_contracts::ExecutionStatus::Cancelled);', 'assert_eq!(serde_json::to_value(h.store.lock().unwrap().task("ipc-task").unwrap()).unwrap()["execution_status"], "CANCELLED");')
patch('crates/local-ipc/src/priority_tests.rs', 'assert_eq!(h.close().await.failed,0);', 'h.close().await;')
p=Path('crates/local-ipc/src/tests.rs');s=p.read_text();assert 'include!("priority_tests.rs")' not in s;p.write_text(s+'\ninclude!("priority_tests.rs");\n')
patch('crates/store/src/queue.rs', 'Ok(self.conn.query_row("SELECT count(*) FROM work_queue WHERE state=\'leased\'",[],|r|r.get(0))?)', 'let count: i64 = self.conn.query_row("SELECT count(*) FROM work_queue WHERE state=\'leased\'", [], |r| r.get(0))?;\n        usize::try_from(count).map_err(|_| Error::RecoveryRequired)')
Path(__file__).unlink()
