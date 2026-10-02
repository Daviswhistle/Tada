use super::*;
use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, sync::atomic::{AtomicU64, Ordering}, thread, time::Instant};
use crate::mock::{MockMode,MockPayload,MockService};
static NEXT:AtomicU64=AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp { fn new()->Self {
    let path=std::env::temp_dir().join(format!("tada-q6-{}-{}-{}",std::process::id(),utc_now_ms().unwrap(),NEXT.fetch_add(1,Ordering::Relaxed)));
    fs::create_dir(&path).unwrap(); Self(path)
} }
impl Drop for Temp { fn drop(&mut self) { let _=fs::remove_dir_all(&self.0); } }
fn contract(id:&str)->tada_contracts::TaskContract {
    tada_contracts::decode(&json!({"task_id":id,"contract_version":1,"goal":"fixed mock queue fixture","inputs":[],"deliverables":[],"acceptance":["mock.matches"],"external_effects":[{"capability":"mock.apply","account_ref":"mock-account","target":"target-a","purpose":"mock-test"}],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]})).unwrap()
}
fn setup(root:&Path)->Store { let mut store=Store::open(root).unwrap(); store.create_task(&contract("task-a"),100).unwrap(); store }
fn tip(store:&Store)->i64 { store.witness.query_row("SELECT max(seq) FROM journal",[],|r|r.get(0)).unwrap() }
fn claim(store:&mut Store)->WorkLease { store.claim_work("worker-a",0,Duration::from_secs(60)).unwrap().unwrap() }
fn effects(store:&mut Store,root:&Path)->MockService {
    let run=store.start_run("task-a",Duration::from_secs(60)).unwrap();
    store.propose_mock("action-a",&run,&MockPayload{target:"target-a".into(),value:"expected".into()}).unwrap();
    store.prepare_mock("action-a",&run).unwrap();
    let mut service=MockService::open(&root.join("external.sqlite")).unwrap();
    store.dispatch_mock("action-a",&run,&mut service,MockMode::DropResponse,25).unwrap(); service
}
fn legacy(root:&Path) {
    fs::create_dir_all(root).unwrap();
    let conn=Connection::open(root.join("state.sqlite")).unwrap(); crate::configure(&conn).unwrap();
    conn.execute_batch(crate::SCHEMA).unwrap();
    conn.execute("INSERT INTO metadata VALUES(1,?1,?2,0,0,1,0)",params!["a".repeat(32),digest(crate::SCHEMA.as_bytes())]).unwrap();
    let c=tada_contracts::encode(&contract("task-a")).unwrap();
    let snapshot=json!({"schema_version":1,"task_id":"task-a","version":1,"execution_status":"READY","completion_status":"PENDING","cancel_epoch":0,"unresolved_effects":[],"unmet_required_criteria":["mock.matches"]});
    conn.execute("INSERT INTO tasks(id,contract,snapshot,budget_micro_usd) VALUES('task-a',?1,?2,100)",params![c.to_string(),snapshot.to_string()]).unwrap();
    conn.execute("INSERT INTO events(aggregate_id,kind,payload) VALUES('task-a','task.created',?1)",[snapshot.to_string()]).unwrap();
    let witness=Connection::open(root.join("witness.sqlite")).unwrap(); crate::configure(&witness).unwrap();
    witness.execute_batch(crate::WITNESS_SCHEMA).unwrap(); witness.execute("INSERT INTO identity VALUES(?1)",["a".repeat(32)]).unwrap();
}
#[test]
fn submit_and_queue_insert_are_atomic_on_queue_write_failure() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let before=tip(&store);
    store.conn.execute_batch("CREATE TRIGGER queue_failure BEFORE INSERT ON work_queue BEGIN SELECT RAISE(ABORT,'fault'); END;").unwrap();
    assert!(store.create_task(&contract("task-a"),100).is_err());
    assert_eq!(store.conn.query_row("SELECT count(*) FROM tasks",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(store.conn.query_row("SELECT count(*) FROM events WHERE kind='task.created'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(tip(&store),before); assert!(store.poisoned);
}
#[test]
fn fresh_queue_is_ready_and_idle_polling_has_no_writes() {
    let temp=Temp::new(); let mut store=setup(&temp.0);
    assert_eq!(store.work_entry("task-a").unwrap().state,WorkState::Ready);
    store.schedule_work("task-a",1000).unwrap(); let before=tip(&store);
    for _ in 0..100 { assert!(store.claim_work("worker",999,Duration::from_secs(10)).unwrap().is_none()); }
    assert_eq!(tip(&store),before); assert!(store.claim_work("worker",1000,Duration::from_secs(10)).unwrap().is_some());
}
#[test]
fn one_shot_schedule_survives_restart_and_wall_clock_backwards() {
    let temp=Temp::new(); let mut store=setup(&temp.0);
    store.schedule_work("task-a",5000).unwrap(); drop(store);
    let mut store=Store::open(&temp.0).unwrap();
    for now in [4999,100,0,4999] { assert!(store.claim_work("worker",now,Duration::from_secs(10)).unwrap().is_none()); }
    assert!(store.claim_work("worker",5000,Duration::from_secs(10)).unwrap().is_some());
}
#[test]
fn deadline_priority_then_fifo_are_independent_of_task_name() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap();
    store.create_task(&contract("z-first"),100).unwrap(); store.create_task(&contract("a-second"),100).unwrap();
    let mut value=tada_contracts::encode(&contract("deadline")).unwrap(); value["deadline"]=json!("2027-01-01T00:00:00Z");
    store.create_task(&tada_contracts::decode(&value).unwrap(),100).unwrap();
    let first=claim(&mut store); assert_eq!(first.task_id(),"deadline"); store.finish_probe(&first,first.contract_hash()).unwrap();
    assert_eq!(claim(&mut store).task_id(),"z-first"); assert_eq!(claim(&mut store).task_id(),"a-second");
}
#[test]
fn claimed_work_has_exactly_one_owner_and_old_fence_cannot_complete() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let old=claim(&mut store);
    assert!(store.claim_work("other",0,Duration::from_secs(10)).unwrap().is_none());
    store.defer_work(&old,0).unwrap(); let new=claim(&mut store);
    assert!(new.fence()>old.fence()); assert_eq!(new.attempt(),2);
    assert!(store.finish_probe(&old,old.contract_hash()).is_err());
    store.finish_probe(&new,new.contract_hash()).unwrap();
    assert!(store.finish_probe(&new,new.contract_hash()).is_err());
}
#[test]
fn expired_live_claim_is_not_stolen_or_extended_by_wall_clock() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let lease=claim(&mut store);
    store.clock=Instant::now().checked_sub(Duration::from_secs(120)).unwrap();
    assert!(store.finish_probe(&lease,lease.contract_hash()).is_err());
    assert!(store.claim_work("other",9_000_000,Duration::from_secs(30)).unwrap().is_none());
    drop(store); let mut store=Store::open(&temp.0).unwrap(); let new=claim(&mut store);
    assert!(new.fence()>lease.fence()); assert!(store.finish_probe(&lease,lease.contract_hash()).is_err());
}
#[test]
fn cancellation_invalidates_queued_and_leased_probe_without_success() {
    for lease_first in [false,true] {
        let temp=Temp::new(); let mut store=setup(&temp.0);
        let lease=lease_first.then(||claim(&mut store)); store.cancel("task-a").unwrap();
        if let Some(lease)=lease { assert!(store.finish_probe(&lease,lease.contract_hash()).is_err()); }
        assert_eq!(store.work_entry("task-a").unwrap().state,WorkState::Cancelled);
        assert!(store.claim_work("worker",0,Duration::from_secs(10)).unwrap().is_none());
        drop(store); let store=Store::open(&temp.0).unwrap();
        assert_eq!(snapshot(&store.conn,"task-a").unwrap()["execution_status"],"CANCELLED");
        assert_eq!(store.conn.query_row("SELECT count(*) FROM work_checkpoints",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
}
#[test]
fn wrong_probe_fingerprint_is_not_checkpointed_and_task_criteria_remain_unmet() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let lease=claim(&mut store);
    assert!(store.finish_probe(&lease,&"0".repeat(64)).is_err());
    let hash=store.finish_probe(&lease,lease.contract_hash()).unwrap();
    assert_eq!(hash.len(),64); assert_eq!(store.work_entry("task-a").unwrap().state,WorkState::Finished);
    let value=snapshot(&store.conn,"task-a").unwrap(); assert_eq!(value["completion_status"],"PENDING");
    assert_eq!(value["unmet_required_criteria"],json!(["mock.matches"])); assert!(value.get("result_manifest_ref").is_none());
    drop(store); let mut store=Store::open(&temp.0).unwrap(); assert!(store.claim_work("worker",0,Duration::from_secs(10)).unwrap().is_none());
}
#[test]
fn cancelled_uncertainty_is_observed_before_ordinary_work_without_a_run_grant() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let service=effects(&mut store,&temp.0);
    store.cancel("task-a").unwrap(); store.create_task(&contract("ordinary"),100).unwrap();
    let lease=claim(&mut store); assert_eq!(lease.task_id(),"task-a"); assert_eq!(lease.kind(),WorkKind::Reconcile); assert!(lease.run().is_none());
    assert!(store.finish_probe(&lease,lease.contract_hash()).is_err());
    store.reconcile_work_mock(&lease,&service,1000).unwrap();
    assert_eq!(service.effect_count().unwrap(),1); assert_eq!(store.budget_committed("task-a").unwrap(),25);
    assert_eq!(snapshot(&store.conn,"task-a").unwrap()["execution_status"],"CANCELLED");
    assert_eq!(store.work_entry("task-a").unwrap().state,WorkState::Cancelled);
    assert_eq!(claim(&mut store).task_id(),"ordinary");
}
#[test]
fn unknown_observation_defers_and_retains_cost_without_busy_loop_or_resend() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let mut service=effects(&mut store,&temp.0); service.hide_observations(true);
    let lease=claim(&mut store); store.reconcile_work_mock(&lease,&service,1000).unwrap();
    let before=tip(&store); assert!(store.claim_work("worker",999,Duration::from_secs(10)).unwrap().is_none()); assert_eq!(tip(&store),before);
    assert_eq!(snapshot(&store.conn,"task-a").unwrap()["completion_status"],"OUTCOME_UNKNOWN");
    assert_eq!(store.budget_committed("task-a").unwrap(),25); assert_eq!(service.effect_count().unwrap(),1);
    drop(store); let mut store=Store::open(&temp.0).unwrap(); assert_eq!(store.work_entry("task-a").unwrap().run_after_ms,1000);
    service.hide_observations(false); let lease=store.claim_work("worker",1000,Duration::from_secs(60)).unwrap().unwrap();
    store.reconcile_work_mock(&lease,&service,2000).unwrap(); assert_eq!(service.effect_count().unwrap(),1);
}
#[test]
fn denied_execution_policy_does_not_block_reconciliation_or_cancel() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let service=effects(&mut store,&temp.0);
    store.create_task(&contract("ordinary"),100).unwrap(); store.set_mock_policy_denied(true).unwrap();
    let lease=claim(&mut store); assert_eq!(lease.kind(),WorkKind::Reconcile);
    store.reconcile_work_mock(&lease,&service,1000).unwrap();
    assert!(store.claim_work("worker",0,Duration::from_secs(10)).unwrap().is_none());
    store.cancel("ordinary").unwrap();
}
#[test]
fn invalid_queue_inputs_and_cross_store_claim_do_not_change_state() {
    let a=Temp::new(); let b=Temp::new(); let mut first=setup(&a.0); let mut second=setup(&b.0);
    for ttl in [Duration::ZERO,Duration::from_nanos(1),Duration::from_secs(301)] { assert!(first.claim_work("worker",0,ttl).is_err()); }
    assert!(first.claim_work("bad owner",0,Duration::from_secs(1)).is_err()); assert!(first.schedule_work("task-a",-1).is_err());
    let lease=claim(&mut first); let _=claim(&mut second);
    assert!(second.finish_probe(&lease,lease.contract_hash()).is_err());
}
#[test]
fn queue_snapshot_drift_and_missing_projection_fail_before_recovery() {
    for sql in ["UPDATE work_queue SET record=json_set(record,'$.version',999)","DROP TRIGGER retain_queue; DELETE FROM work_queue"] {
        let temp=Temp::new(); let store=setup(&temp.0); store.conn.execute_batch(sql).unwrap(); drop(store);
        assert!(matches!(Store::open(&temp.0),Err(Error::RecoveryRequired)));
    }
}
#[test]
fn checkpoint_write_failure_rolls_back_queue_task_and_events() {
    let temp=Temp::new(); let mut store=setup(&temp.0); let lease=claim(&mut store); let before=tip(&store);
    store.conn.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON work_checkpoints BEGIN SELECT RAISE(ABORT,'fault'); END;").unwrap();
    assert!(store.finish_probe(&lease,lease.contract_hash()).is_err()); assert_eq!(tip(&store),before);
    assert_eq!(load(&store.conn,"task-a").unwrap().unwrap().state,WorkState::Leased); assert!(store.poisoned);
}
#[test]
fn legacy_open_requires_explicit_backup_migration_and_old_binary_version_is_blocked() {
    let temp=Temp::new(); legacy(&temp.0);
    assert!(matches!(Store::open(&temp.0),Err(Error::Denied("QUEUE_MIGRATION_REQUIRED"))));
    let backup=temp.0.join("v1-backup.sqlite"); Store::migrate_queue_v2(&temp.0,&backup).unwrap();
    let backup=Connection::open(backup).unwrap(); assert_eq!(crate::queue_migration::version(&backup).unwrap(),1);
    let mut store=Store::open(&temp.0).unwrap(); assert_eq!(crate::queue_migration::version(&store.conn).unwrap(),2);
    assert!(crate::healthy_database(&store.conn,1).is_err());
    assert!(store.claim_work("worker",0,Duration::from_secs(10)).unwrap().is_some());
}
#[test]
fn migration_refuses_existing_backup_and_inflight_publication_without_modifying_source() {
    let temp=Temp::new(); legacy(&temp.0); let backup=temp.0.join("existing.sqlite"); fs::write(&backup,b"do-not-replace").unwrap();
    assert!(Store::migrate_queue_v2(&temp.0,&backup).is_err()); assert_eq!(fs::read(&backup).unwrap(),b"do-not-replace");
    let conn=Connection::open(temp.0.join("state.sqlite")).unwrap();
    let mut value=snapshot(&conn,"task-a").unwrap(); value["execution_status"]=json!("PUBLISHING");value["version"]=json!(2);
    conn.execute("UPDATE tasks SET snapshot=?1 WHERE id='task-a'",[value.to_string()]).unwrap();
    conn.execute("INSERT INTO events(aggregate_id,kind,payload) VALUES('task-a','task.publishing',?1)",[value.to_string()]).unwrap(); drop(conn);
    let backup=temp.0.join("never-created.sqlite");
    assert!(matches!(Store::migrate_queue_v2(&temp.0,&backup),Err(Error::Denied("MIGRATION_RECONCILIATION_REQUIRED")))); assert!(!backup.exists());
}
#[test]
fn unknown_schema_and_changed_contract_are_not_repaired() {
    for sql in ["PRAGMA user_version=999", "UPDATE tasks SET contract=json_set(contract,'$.goal','changed after queueing')"] {
        let temp=Temp::new(); let store=setup(&temp.0); store.conn.execute_batch(sql).unwrap(); drop(store);
        assert!(matches!(Store::open(&temp.0),Err(Error::RecoveryRequired)));
    }
}
fn sessions(store:&Store,credential:&crate::control::auth::Credential)->(crate::control::auth::ServerSession,crate::control::auth::ClientSession) {
    let pending=store.control_challenge(credential).unwrap();
    let (client,proof)=credential.answer(&pending.message(),&store.control_store_id().unwrap()).unwrap();
    let (server,proof)=pending.accept(proof).unwrap(); (server,client.confirm(proof).unwrap())
}
#[test]
fn prepared_cancel_priority_requires_authentication_controller_and_valid_contract() {
    use crate::{control::{auth::{Access,Credential},PreparedControl},priority::Priority};
    let temp=Temp::new(); let mut store=setup(&temp.0);
    for (access,extra,expected) in [(Access::Controller,false,Priority::Cancellation),(Access::Observer,false,Priority::Ordinary),(Access::Controller,true,Priority::Ordinary)] {
        let cred=Credential::generate("ui",access).unwrap();let (session,mut client)=sessions(&store,&cred);
        let mut value=json!({"jsonrpc":"2.0","id":"transport","method":"task.cancel","params":{"task_id":"task-a","request_id":"cancel-1"}});
        if extra { value["params"]["escalate"]=json!(true); }
        let prepared=PreparedControl::authenticate(session,&client.request(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap();
        assert_eq!(prepared.priority(),expected);
    }
    let cred=Credential::generate("ui",Access::Controller).unwrap();let (session,mut client)=sessions(&store,&cred);
    let mut frame=client.request(b"{}").unwrap();frame[12]^=1;assert!(PreparedControl::authenticate(session,&frame).is_err());
    let (session,mut client)=sessions(&store,&cred);
    let request=json!({"jsonrpc":"2.0","id":"transport","method":"task.cancel","params":{"task_id":"task-a","request_id":"cancel-2"}});
    let prepared=PreparedControl::authenticate(session,&client.request(&serde_json::to_vec(&request).unwrap()).unwrap()).unwrap();
    cred.revoke(); assert!(store.control_handle_prepared(prepared).is_err()); assert_eq!(number(&snapshot(&store.conn,"task-a").unwrap(),"cancel_epoch").unwrap(),0);
}

#[test]
fn crash_child() {
    let Some(root)=std::env::var_os("TADA_TEST_ROOT") else { return; };
    let root=Path::new(&root); let phase=std::env::var("TADA_TEST_PHASE").unwrap();
    if phase.starts_with("queue_migrate") { legacy(root); Store::migrate_queue_v2(root,&root.join("backup.sqlite")).unwrap(); }
    else {
        let mut store=setup(root); let lease=claim(&mut store);
        if phase.starts_with("queue_defer") { store.defer_work(&lease,5000).unwrap(); }
        else { store.finish_probe(&lease,lease.contract_hash()).unwrap(); }
    }
    panic!("fault boundary not reached");
}
#[test]
fn nine_process_kill_boundaries_preserve_queue_or_require_read_only_recovery() {
    let phases=["queue_claim.witness","queue_claim.commit","queue_defer.witness","queue_defer.commit","queue_checkpoint.witness","queue_checkpoint.commit","queue_migrate.backup","queue_migrate.witness","queue_migrate.commit"];
    assert_eq!(phases.len(),9);
    for phase in phases {
        let temp=Temp::new();
        let mut child=Command::new(std::env::current_exe().unwrap()).args(["--exact","queue::tests::crash_child","--nocapture"]).env("TADA_TEST_ROOT",&temp.0).env("TADA_TEST_PHASE",phase).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
        let deadline=Instant::now()+Duration::from_secs(30);
        while !temp.0.join("boundary.ready").exists() && Instant::now()<deadline {
            if let Some(status)=child.try_wait().unwrap() { panic!("child exited before {phase}: {status}"); }
            thread::sleep(Duration::from_millis(10));
        }
        let reached=temp.0.join("boundary.ready").exists(); child.kill().unwrap(); child.wait().unwrap(); assert!(reached,"{phase}");
        if phase.ends_with(".witness") { assert!(matches!(Store::open(&temp.0),Err(Error::RecoveryRequired)),"{phase}"); continue; }
        if phase=="queue_migrate.backup" {
            assert!(matches!(Store::open(&temp.0),Err(Error::Denied("QUEUE_MIGRATION_REQUIRED"))));
            Store::migrate_queue_v2(&temp.0,&temp.0.join("second-backup.sqlite")).unwrap();
        }
        let mut store=Store::open(&temp.0).unwrap(); let entry=store.work_entry("task-a").unwrap();
        if phase=="queue_checkpoint.commit" {
            assert_eq!(entry.state,WorkState::Finished); assert!(store.claim_work("worker",0,Duration::from_secs(60)).unwrap().is_none());
            assert_eq!(store.conn.query_row("SELECT count(*) FROM work_checkpoints",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        } else {
            assert_eq!(entry.state,WorkState::Ready); if phase=="queue_defer.commit" { assert_eq!(entry.run_after_ms,5000); }
            assert!(store.claim_work("new-worker",5000,Duration::from_secs(60)).unwrap().is_some());
        }
        assert_ne!(snapshot(&store.conn,"task-a").unwrap()["completion_status"],"SUCCEEDED");
        println!("queue fault {phase}: passed");
    }
}
