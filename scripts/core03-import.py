"""Finalize control-context decoding and poison-on-corruption regression checks."""
from pathlib import Path
p = Path('crates/store/src/control/mod.rs')
s = p.read_text()
old = '''            "SELECT store_id,generation FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),'''
new = '''            "SELECT store_id,generation FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),'''
assert s.count(old) == 1
s = s.replace(old,new)
old = '''    pub fn control_handle(&mut self, session: &mut ServerSession, frame: &[u8]) -> Result<Vec<u8>> {
        let (store_id, generation) = self.control_context()?;'''
new = '''    pub fn control_handle(&mut self, session: &mut ServerSession, frame: &[u8]) -> Result<Vec<u8>> {
        let result = self.control_handle_inner(session, frame);
        if matches!(&result, Err(Error::Sql(_) | Error::Io(_) | Error::RecoveryRequired)) {
            self.poisoned = true;
            session.revoke();
        }
        result
    }

    fn control_handle_inner(&mut self, session: &mut ServerSession, frame: &[u8]) -> Result<Vec<u8>> {
        let (store_id, generation) = self.control_context()?;'''
assert s.count(old) == 1
p.write_text(s.replace(old,new))
p = Path('crates/store/src/control/tests.rs')
s = p.read_text() + '''
#[test]
fn corrupt_replay_record_closes_store_control_before_any_new_command() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.0).unwrap();
    let key = credential();
    let mut sessions = pair(&store, &key);
    call(&mut store, &mut sessions, &submit());
    // A second receipt violates the single-owner command journal invariant.
    // Private test SQL can construct corruption; no RPC exposes this operation.
    store.conn.execute("INSERT INTO events(aggregate_id,kind,payload) SELECT aggregate_id,kind,payload FROM events WHERE kind='control.completed'", []).unwrap();
    let frame = sessions.1.request(&serde_json::to_vec(&submit()).unwrap()).unwrap();
    assert!(matches!(store.control_handle(&mut sessions.0, &frame), Err(Error::RecoveryRequired)));
    assert!(store.poisoned);
    assert!(store.control_challenge(&key).is_err());
    let before = count(&store, "task.cancelled");
    assert!(store.cancel("task-a").is_err());
    assert_eq!(count(&store, "task.cancelled"), before);
}

#[test]
fn invalid_authenticated_requests_do_not_poison_other_sessions() {
    let temp = Temp::new();
    let mut store = Store::open(&temp.0).unwrap();
    let key = credential();
    let mut sessions = pair(&store, &key);
    let reply = raw(&mut store, &mut sessions, b"not-json");
    assert_eq!(reply["error"]["code"], -32700);
    assert!(!store.poisoned);
    let mut fresh = pair(&store, &key);
    assert!(call(&mut store, &mut fresh, &submit()).get("result").is_some());
}
'''
p.write_text(s)
Path(__file__).unlink()
