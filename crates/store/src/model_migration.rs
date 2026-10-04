//! Explicit storage-semantic upgrade: old binaries must not ignore model costs.
//! No table rewrite is necessary, but the event catalog changes what an existing
//! task budget means. Therefore PRAGMA user_version and the schema fingerprint
//! advance together, with a backup and a witnessed marker, before any inference.
use crate::{event, Error, Result, Store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) const FORMAT: &str = "tada-store-v3:model-ledger-v1;events=admitted,usage,unknown,finished;task-cost=actions+models;unknown=retain-reservation;request-id=single-admission";

pub(crate) fn audit(conn: &Connection) -> Result<()> {
    let version = crate::queue_migration::version(conn)?;
    let mut statement = conn.prepare("SELECT payload FROM events WHERE aggregate_id='schema' AND kind='schema.model_v3' ORDER BY seq LIMIT 2")?;
    let rows = statement.query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if version == 3 {
        if rows.len() != 1 {
            return Err(Error::RecoveryRequired);
        }
        let value: Value = serde_json::from_str(&rows[0]).map_err(|_| Error::RecoveryRequired)?;
        let expected = json!({"from":2,"to":3,"checksum":crate::queue_migration::schema_hash(3)?,"backup_required":true});
        if value != expected { return Err(Error::RecoveryRequired); }
    } else {
        let model_events: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE kind GLOB 'model.*')", [], |r| r.get(0))?;
        if !rows.is_empty() || model_events { return Err(Error::RecoveryRequired); }
    }
    Ok(())
}
impl Store {
    /// Opt in a stopped, schema-v2 developer store to mock inference accounting.
    /// The NEW backup path is caller-selected. This neither starts a model nor
    /// approves a paid route. A v3 store remains v3 even when it has no requests.
    pub fn enable_mock_inference(&mut self, backup: &Path) -> Result<()> {
        if self.poisoned { return Err(Error::RecoveryRequired); }
        self.audit()?;
        match crate::queue_migration::version(&self.conn)? {
            3 => return Ok(()),
            2 => (),
            _ => return Err(Error::Denied("MODEL_MIGRATION_REQUIRES_V2")),
        }
        let running: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE execution IN ('RUNNING','VERIFYING','PUBLISHING','CANCELLING')) OR EXISTS(SELECT 1 FROM work_queue WHERE state='leased') OR EXISTS(SELECT 1 FROM actions WHERE state IN ('DISPATCHING','ACKNOWLEDGED','UNCERTAIN'))",
            [], |r| r.get(0),
        )?;
        if running { return Err(Error::Denied("MODEL_MIGRATION_REQUIRES_SAFE_POINT")); }
        self.backup_state(backup)?;
        crate::checkpoint("model_enable.backup");
        let checksum = crate::queue_migration::schema_hash(3)?;
        self.transact("model_enable", |tx| {
            tx.execute_batch("PRAGMA user_version=3;")?;
            tx.execute("UPDATE metadata SET schema_hash=?1 WHERE singleton=1", params![checksum])?;
            event(tx, "schema", "schema.model_v3", &json!({"from":2,"to":3,"checksum":checksum,"backup_required":true}))
        })?;
        self.audit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, process::{Command, Stdio}, thread, time::{Duration, Instant}};
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let mut bytes=[0;16];getrandom::fill(&mut bytes).unwrap();
            let id=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
            let root=std::env::temp_dir().join(format!("tada-model-v3-{id}"));fs::create_dir(&root).unwrap();Self(root)
        }
    }
    impl Drop for Temp { fn drop(&mut self) { let _=fs::remove_dir_all(&self.0); } }
    fn task() -> tada_contracts::TaskContract {
        tada_contracts::decode(&json!({"task_id":"migration-task","contract_version":1,"goal":"fixture","inputs":[],"deliverables":[],"acceptance":["unmet"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]})).unwrap()
    }
    #[test]
    fn explicit_upgrade_backs_up_v2_and_changes_the_older_binary_version_barrier() {
        let temp=Temp::new();let mut store=Store::open(&temp.0).unwrap();
        assert_eq!(crate::queue_migration::version(&store.conn).unwrap(),2);
        let backup=temp.0.join("v2.sqlite");store.enable_mock_inference(&backup).unwrap();
        assert_eq!(crate::queue_migration::version(&Connection::open(&backup).unwrap()).unwrap(),2);
        assert_eq!(crate::queue_migration::version(&store.conn).unwrap(),3);
        let actual:String=store.conn.query_row("SELECT schema_hash FROM metadata",[],|r|r.get(0)).unwrap();
        assert_ne!(actual,crate::queue_migration::schema_hash(2).unwrap());
        let before:i64=store.conn.query_row("SELECT witness_seq FROM metadata",[],|r|r.get(0)).unwrap();
        store.enable_mock_inference(&backup).unwrap();
        assert_eq!(store.conn.query_row("SELECT witness_seq FROM metadata",[],|r|r.get::<_,i64>(0)).unwrap(),before);
        drop(store);Store::open(&temp.0).unwrap();
    }
    #[test]
    fn inference_refuses_an_unupgraded_store_without_silently_migrating() {
        let temp=Temp::new();let mut store=Store::open(&temp.0).unwrap();store.create_task(&task(),100).unwrap();
        let lease=store.claim_work("fixture",crate::queue::utc_now_ms().unwrap(),Duration::from_secs(60)).unwrap().unwrap();
        let spec=crate::model_ledger::InferenceSpec{request_id:"r1".into(),previous_checkpoint:None,reserve_micro_usd:10,max_output_tokens:100,timeout_ms:1000};
        assert!(matches!(store.admit_mock_inference(&lease,&spec),Err(Error::Denied("MODEL_MIGRATION_REQUIRED"))));
        assert_eq!(crate::queue_migration::version(&store.conn).unwrap(),2);
    }
    #[test]
    fn occupied_backup_and_live_assignment_are_not_overwritten_or_migrated() {
        let temp=Temp::new();let mut store=Store::open(&temp.0).unwrap();let backup=temp.0.join("keep");
        fs::write(&backup,b"preserve").unwrap();assert!(store.enable_mock_inference(&backup).is_err());
        assert_eq!(fs::read(&backup).unwrap(),b"preserve");assert_eq!(crate::queue_migration::version(&store.conn).unwrap(),2);
        store.create_task(&task(),100).unwrap();store.claim_work("fixture",crate::queue::utc_now_ms().unwrap(),Duration::from_secs(60)).unwrap();
        let new=temp.0.join("unused-backup");
        assert!(matches!(store.enable_mock_inference(&new),Err(Error::Denied("MODEL_MIGRATION_REQUIRES_SAFE_POINT"))));assert!(!new.exists());
    }
    #[test]
    fn missing_upgrade_marker_or_downgraded_version_fails_open() {
        for downgrade in [false,true] {
            let temp=Temp::new();let mut store=Store::open(&temp.0).unwrap();store.enable_mock_inference(&temp.0.join("v2.sqlite")).unwrap();
            if downgrade {store.conn.execute_batch("PRAGMA user_version=2;").unwrap();}
            else {store.conn.execute_batch("DROP TRIGGER immutable_event_delete; DELETE FROM events WHERE kind='schema.model_v3';").unwrap();}
            drop(store);assert!(matches!(Store::open(&temp.0),Err(Error::RecoveryRequired)));
        }
    }
    #[test]
    fn crash_child() {
        let Some(root)=std::env::var_os("TADA_TEST_ROOT") else {return;};let root=Path::new(&root);
        let mut store=Store::open(root).unwrap();store.enable_mock_inference(&root.join("v2.sqlite")).unwrap();panic!("boundary not reached");
    }
    #[test]
    fn three_upgrade_kills_preserve_a_valid_version_or_quarantine_the_gap() {
        for phase in ["model_enable.backup","model_enable.witness","model_enable.commit"] {
            let temp=Temp::new();let mut child=Command::new(std::env::current_exe().unwrap())
                .args(["--exact","model_migration::tests::crash_child","--nocapture"])
                .env("TADA_TEST_ROOT",&temp.0).env("TADA_TEST_PHASE",phase)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
            let end=Instant::now()+Duration::from_secs(30);
            while !temp.0.join("boundary.ready").exists() && Instant::now()<end {
                if let Some(code)=child.try_wait().unwrap() {panic!("child exited before {phase}: {code}");}
                thread::sleep(Duration::from_millis(10));
            }
            let reached=temp.0.join("boundary.ready").exists();child.kill().unwrap();child.wait().unwrap();assert!(reached);
            assert_eq!(crate::queue_migration::version(&Connection::open(temp.0.join("v2.sqlite")).unwrap()).unwrap(),2);
            if phase=="model_enable.witness" {assert!(matches!(Store::open(&temp.0),Err(Error::RecoveryRequired)));}
            else {
                let store=Store::open(&temp.0).unwrap();
                assert_eq!(crate::queue_migration::version(&store.conn).unwrap(),if phase=="model_enable.backup" {2} else {3});
            }
        }
    }
}
