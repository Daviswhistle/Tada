use super::*;
use super::auth::{ClientSession, ServerSession};
use crate::mock::{MockMode, MockPayload, MockService};
use std::{fs, path::PathBuf, process::{Command,Stdio}, sync::{Arc,Mutex,Barrier,atomic::{AtomicU64,Ordering}}, thread, time::{Duration,Instant,SystemTime,UNIX_EPOCH}};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tada-control-{}-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap(); Self(path)
    }
}
impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn credential() -> Credential { Credential::generate("trusted-ui",Access::Controller).unwrap() }
fn pair(store: &Store,key: &Credential) -> (ServerSession,ClientSession) {
    let id = store.control_store_id().unwrap();
    let pending = store.control_challenge(key).unwrap();
    let (client,proof) = key.answer(&pending.message(),&id).unwrap();
    let (server,proof) = pending.accept(proof).unwrap();
    (server,client.confirm(proof).unwrap())
}
fn rpc(method: &str,params: Value) -> Value { json!({"jsonrpc":"2.0","id":"wire-a","method":method,"params":params}) }
fn contract() -> Value { json!({"task_id":"task-a","contract_version":1,"goal":"mock control test","inputs":[],"deliverables":[],"acceptance":["mock.matches"],"external_effects":[{"capability":"mock.apply","account_ref":"mock-account","target":"target-a","purpose":"mock-test"}],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]}) }
fn submit() -> Value { rpc("task.submit",json!({"request_id":"submit-a","contract":contract(),"budget_micro_usd":100})) }
fn cancel() -> Value { rpc("task.cancel",json!({"request_id":"cancel-a","task_id":"task-a"})) }
fn raw(store: &mut Store,sessions: &mut (ServerSession,ClientSession),body: &[u8]) -> Value {
    let frame = sessions.1.request(body).unwrap();
    let response = store.control_handle(&mut sessions.0,&frame).unwrap();
    serde_json::from_slice(&sessions.1.response(&response).unwrap()).unwrap()
}
fn call(store: &mut Store,sessions: &mut (ServerSession,ClientSession),value: &Value) -> Value {
    raw(store,sessions,&serde_json::to_vec(value).unwrap())
}
fn count(store: &Store,kind: &str) -> i64 { store.conn.query_row("SELECT count(*) FROM events WHERE kind=?1",[kind],|r|r.get(0)).unwrap() }
fn tip(store: &Store) -> i64 { store.witness.query_row("SELECT coalesce(max(seq),0) FROM journal",[],|r|r.get(0)).unwrap() }

#[test]
fn lost_reply_reconnect_replays_result_without_writes() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key);
    let first=call(&mut store,&mut sessions,&submit());
    assert_eq!(first["result"]["command_result"]["task_version"],1);
    let before=tip(&store);
    let mut sessions=pair(&store,&key);
    let replay=call(&mut store,&mut sessions,&submit());
    assert_eq!(first,replay); assert_eq!(count(&store,"task.created"),1);
    assert_eq!(count(&store,"control.completed"),1); assert_eq!(tip(&store),before);
}
#[test]
fn changed_transport_id_and_whitespace_do_not_change_logical_request() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); let first=call(&mut store,&mut sessions,&submit());
    let mut request=submit(); request["id"]=json!("another-wire-id");
    let replay=raw(&mut store,&mut sessions,serde_json::to_string_pretty(&request).unwrap().as_bytes());
    assert_eq!(replay["id"],"another-wire-id"); assert_eq!(first["result"],replay["result"]);
    assert_eq!(count(&store,"control.completed"),1);
}
#[test]
fn same_id_with_changed_payload_or_method_is_rejected() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    let before=tip(&store);
    let mut changed=submit(); changed["params"]["contract"]["goal"]=json!("different goal");
    assert_eq!(call(&mut store,&mut sessions,&changed)["error"]["message"],"REQUEST_ID_REUSED");
    let changed=rpc("task.cancel",json!({"request_id":"submit-a","task_id":"task-a"}));
    assert_eq!(call(&mut store,&mut sessions,&changed)["error"]["message"],"REQUEST_ID_REUSED");
    assert_eq!(tip(&store),before); assert_eq!(store.task("task-a").unwrap().cancel_epoch.get(),0);
}
#[test]
fn old_submit_reply_is_historical_and_never_revives_cancelled_task() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); let first=call(&mut store,&mut sessions,&submit());
    call(&mut store,&mut sessions,&cancel()); drop(store);
    let mut store=Store::open(&temp.0).unwrap(); let mut sessions=pair(&store,&key);
    assert_eq!(call(&mut store,&mut sessions,&submit()),first);
    assert_eq!(first["result"]["semantics"],"original_command_commit");
    let current=call(&mut store,&mut sessions,&rpc("task.get",json!({"task_id":"task-a"})));
    assert_eq!(current["result"]["snapshot"]["execution_status"],"CANCELLED");
    assert_eq!(count(&store,"task.cancelled"),1);
}
#[test]
fn successful_and_rejected_commands_both_replay_after_restart() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key);
    let rejected=call(&mut store,&mut sessions,&cancel());
    assert_eq!(rejected["error"]["message"],"TASK_NOT_FOUND");
    call(&mut store,&mut sessions,&submit()); drop(store);
    let mut store=Store::open(&temp.0).unwrap(); let mut sessions=pair(&store,&key);
    assert_eq!(call(&mut store,&mut sessions,&cancel()),rejected);
    assert_eq!(store.task("task-a").unwrap().cancel_epoch.get(),0);
    let mut new_cancel=cancel(); new_cancel["params"]["request_id"]=json!("cancel-b");
    assert!(call(&mut store,&mut sessions,&new_cancel).get("result").is_some());
}
#[test]
fn duplicate_task_is_business_error_not_a_poisoned_database() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    let mut duplicate=submit(); duplicate["params"]["request_id"]=json!("submit-b");
    assert_eq!(call(&mut store,&mut sessions,&duplicate)["error"]["message"],"TASK_EXISTS");
    assert!(!store.poisoned); assert!(call(&mut store,&mut sessions,&cancel()).get("result").is_some());
}
#[test]
fn observer_cannot_mutate_or_replay_controller_receipts() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    let observer=Credential::generate("trusted-ui",Access::Observer).unwrap();
    let mut sessions=pair(&store,&observer); let before=tip(&store);
    for request in [submit(),cancel()] {
        assert_eq!(call(&mut store,&mut sessions,&request)["error"]["message"],"CONTROL_FORBIDDEN");
    }
    assert!(call(&mut store,&mut sessions,&rpc("task.get",json!({"task_id":"task-a"}))).get("result").is_some());
    assert_eq!(tip(&store),before);
}
#[test]
fn credential_revocation_invalidates_established_session_before_mutation() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); let frame=sessions.1.request(&serde_json::to_vec(&submit()).unwrap()).unwrap();
    let before=tip(&store); key.revoke();
    assert!(store.control_handle(&mut sessions.0,&frame).is_err());
    assert_eq!(tip(&store),before); assert_eq!(count(&store,"task.created"),0);
}
#[test]
fn previous_store_generation_and_other_store_session_are_rejected() {
    let temp=Temp::new(); let store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); drop(store);
    let mut store=Store::open(&temp.0).unwrap();
    let frame=sessions.1.request(&serde_json::to_vec(&submit()).unwrap()).unwrap();
    assert!(store.control_handle(&mut sessions.0,&frame).is_err());
    let mut sessions=pair(&store,&key);
    let other=Temp::new(); let mut other=Store::open(&other.0).unwrap();
    let frame=sessions.1.request(&serde_json::to_vec(&submit()).unwrap()).unwrap();
    assert!(other.control_handle(&mut sessions.0,&frame).is_err());
}
#[test]
fn logical_request_identity_is_scoped_to_authenticated_principal() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    let other=Credential::generate("second-ui",Access::Controller).unwrap();
    let mut sessions=pair(&store,&other);
    assert_eq!(call(&mut store,&mut sessions,&submit())["error"]["message"],"TASK_EXISTS");
    assert_eq!(count(&store,"control.completed"),2);
}
#[test]
fn no_policy_grant_tool_or_sql_command_is_exposed() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); let before=tip(&store);
    for method in ["policy.set","grant.issue","mock.dispatch","process.start","sql.execute","credential.export"] {
        let value=rpc(method,json!({"request_id":"bad","grant":"DO_NOT_LOG_THIS_SECRET"}));
        let reply=call(&mut store,&mut sessions,&value);
        assert_eq!(reply["error"]["code"],-32601);
        assert!(!reply.to_string().contains("DO_NOT_LOG_THIS_SECRET"));
    }
    assert_eq!(tip(&store),before);
}
#[test]
fn unknown_fields_negative_budgets_wrong_versions_and_notifications_do_not_mutate() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); let before=tip(&store);
    let mut extra=submit(); extra["params"]["approval"]=json!("DO_NOT_LOG_THIS_SECRET");
    let mut negative=submit(); negative["params"]["budget_micro_usd"]=json!(-1);
    let mut version=submit(); version["jsonrpc"]=json!("3.0");
    for value in [extra,negative,version,json!([submit()])] {
        let reply=call(&mut store,&mut sessions,&value);
        assert!(reply.get("error").is_some()); assert!(!reply.to_string().contains("DO_NOT_LOG_THIS_SECRET"));
    }
    let mut value=submit(); value.as_object_mut().unwrap().remove("id");
    let frame=sessions.1.request(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(store.control_handle(&mut sessions.0,&frame).is_err());
    assert_eq!(tip(&store),before); assert_eq!(count(&store,"task.created"),0);
}
#[test]
fn duplicate_nested_keys_fail_before_schema_and_storage() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key);
    let value=br#"{"jsonrpc":"2.0","id":"wire-a","method":"task.cancel","params":{"request_id":"cancel-a","task_id":"task-a","task_id":"task-b"}}"#;
    assert_eq!(raw(&mut store,&mut sessions,value)["error"]["code"],-32700);
    assert_eq!(count(&store,"control.completed"),0);
}
#[test]
fn cancel_replay_does_not_bump_epoch_or_repeat_notification() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    let first=call(&mut store,&mut sessions,&cancel()); let notes=store.pending_notifications().unwrap();
    let before=tip(&store);
    assert_eq!(call(&mut store,&mut sessions,&cancel()),first);
    assert_eq!(tip(&store),before); assert_eq!(store.pending_notifications().unwrap(),notes);
    assert_eq!(store.task("task-a").unwrap().cancel_epoch.get(),1);
}
#[test]
fn control_cancellation_preserves_unknown_effect_and_blocks_new_admission() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    let lease=store.start_run("task-a",Duration::from_secs(60)).unwrap();
    store.propose_mock("action-a",&lease,&MockPayload{target:"target-a".into(),value:"test".into()}).unwrap();
    store.prepare_mock("action-a",&lease).unwrap();
    let mut target=MockService::open(&temp.0.join("external.sqlite")).unwrap();
    store.dispatch_mock("action-a",&lease,&mut target,MockMode::DropResponse,30).unwrap();
    let cancelled=call(&mut store,&mut sessions,&cancel());
    assert_eq!(cancelled["result"]["command_result"]["completion_status"],"OUTCOME_UNKNOWN");
    assert!(store.dispatch_mock("action-a",&lease,&mut target,MockMode::Normal,30).is_err());
    store.reconcile_mock("action-a",&target).unwrap();
    assert_eq!(target.effect_count().unwrap(),1);
    assert_eq!(store.task("task-a").unwrap().execution_status,ExecutionStatus::Cancelled);
    assert_eq!(call(&mut store,&mut sessions,&cancel()),cancelled);
}
#[test]
fn cancellation_is_available_even_when_mock_policy_denies_execution() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit());
    store.set_mock_policy_denied(true).unwrap();
    assert!(call(&mut store,&mut sessions,&cancel()).get("result").is_some());
}
#[test]
fn result_journal_write_failure_rolls_back_task_and_event_and_poisoned_handle_cannot_replay() {
    for method in ["submit","cancel"] {
        let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
        let mut sessions=pair(&store,&key);
        if method=="cancel" { call(&mut store,&mut sessions,&submit()); }
        let before=tip(&store); let receipts=count(&store,"control.completed");
        store.conn.execute_batch("CREATE TRIGGER reject_control_receipt BEFORE INSERT ON events WHEN new.kind='control.completed' BEGIN SELECT RAISE(ABORT,'injected receipt write failure'); END;").unwrap();
        let request=if method=="submit" {submit()} else {cancel()};
        let frame=sessions.1.request(&serde_json::to_vec(&request).unwrap()).unwrap();
        assert!(store.control_handle(&mut sessions.0,&frame).is_err());
        assert!(store.poisoned); assert_eq!(tip(&store),before); assert_eq!(count(&store,"control.completed"),receipts);
        if method=="submit" { assert!(!exists(&store.conn,"task-a").unwrap()); }
        else { assert_eq!(store.task("task-a").unwrap().cancel_epoch.get(),0); }
        assert!(store.control_challenge(&key).is_err());
        store.conn.execute_batch("DROP TRIGGER reject_control_receipt").unwrap(); drop(store);
        let mut store=Store::open(&temp.0).unwrap(); let mut sessions=pair(&store,&key);
        assert!(call(&mut store,&mut sessions,&request).get("result").is_some());
    }
}
#[test]
fn concurrent_duplicate_submissions_share_one_committed_result() {
    let temp=Temp::new(); let store=Store::open(&temp.0).unwrap(); let key=credential();
    let one=pair(&store,&key); let two=pair(&store,&key);
    let shared=Arc::new(Mutex::new(store)); let barrier=Arc::new(Barrier::new(3));
    let threads=[one,two].into_iter().map(|mut sessions| {
        let store=Arc::clone(&shared); let barrier=Arc::clone(&barrier);
        thread::spawn(move|| { barrier.wait(); call(&mut store.lock().unwrap(),&mut sessions,&submit()) })
    }).collect::<Vec<_>>();
    barrier.wait();
    let values=threads.into_iter().map(|t|t.join().unwrap()).collect::<Vec<_>>();
    assert_eq!(values[0],values[1]); assert_eq!(count(&shared.lock().unwrap(),"task.created"),1);
}
#[test]
fn task_event_cursor_resumes_without_control_receipts_or_other_tasks() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key); call(&mut store,&mut sessions,&submit()); call(&mut store,&mut sessions,&cancel());
    let page=rpc("task.events",json!({"task_id":"task-a","after_seq":0,"limit":1}));
    let first=call(&mut store,&mut sessions,&page); assert_eq!(first["result"]["events"].as_array().unwrap().len(),1);
    let cursor=first["result"]["next_seq"].as_i64().unwrap();
    let mut other=submit(); other["params"]["request_id"]=json!("submit-b"); other["params"]["contract"]["task_id"]=json!("task-b");
    call(&mut store,&mut sessions,&other); drop(store);
    let mut store=Store::open(&temp.0).unwrap(); let mut sessions=pair(&store,&key);
    let next=call(&mut store,&mut sessions,&rpc("task.events",json!({"task_id":"task-a","after_seq":cursor,"limit":64})));
    let events=next["result"]["events"].as_array().unwrap(); assert_eq!(events.len(),1);
    assert_eq!(events[0]["kind"],"task.cancelled");
    assert!(!next.to_string().contains("control.completed")); assert!(!next.to_string().contains("task-b"));
    let ahead=call(&mut store,&mut sessions,&rpc("task.events",json!({"task_id":"task-a","after_seq":9007199254740991i64,"limit":64})));
    assert_eq!(ahead["error"]["message"],"CURSOR_AHEAD");
}
#[test]
fn oversized_snapshots_fail_bounded_reads_without_blocking_cancellation() {
    let temp=Temp::new(); let mut store=Store::open(&temp.0).unwrap(); let key=credential();
    let mut value=contract();
    value["acceptance"]=json!((0..900).map(|n|format!("criterion{n}{}","x".repeat(90))).collect::<Vec<_>>());
    store.create_task(&tada_contracts::decode(&value).unwrap(),100).unwrap();
    let mut sessions=pair(&store,&key);
    let get=call(&mut store,&mut sessions,&rpc("task.get",json!({"task_id":"task-a"})));
    assert_eq!(get["error"]["message"],"RESPONSE_TOO_LARGE");
    let events=call(&mut store,&mut sessions,&rpc("task.events",json!({"task_id":"task-a","after_seq":0,"limit":1})));
    assert_eq!(events["error"]["message"],"EVENT_TOO_LARGE");
    assert!(call(&mut store,&mut sessions,&cancel()).get("result").is_some());
    assert_eq!(store.task("task-a").unwrap().cancel_epoch.get(),1);
}

#[test]
fn crash_child() {
    let Some(root)=std::env::var_os("TADA_TEST_ROOT") else { return; };
    let mut store=Store::open(std::path::Path::new(&root)).unwrap(); let key=credential();
    let mut sessions=pair(&store,&key);
    let request=if std::env::var("TADA_CONTROL_COMMAND").unwrap()=="cancel" {
        store.create_task(&tada_contracts::decode(&contract()).unwrap(),100).unwrap(); cancel()
    } else {submit()};
    call(&mut store,&mut sessions,&request);
    panic!("fault checkpoint was not reached");
}
#[test]
fn real_process_kill_before_witness_and_after_command_commit() {
    let phases=["control.before","control.witness","control.commit"];
    let commands=["submit","cancel"];
    assert_eq!(phases.len()*commands.len(),6,"fixed control fault denominator");
    for command in commands {
        for phase in phases {
            let temp=Temp::new();
            let mut child=Command::new(std::env::current_exe().unwrap()).args(["--exact","control::tests::crash_child","--nocapture"]).env("TADA_TEST_ROOT",&temp.0).env("TADA_TEST_PHASE",phase).env("TADA_CONTROL_COMMAND",command).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
            let deadline=Instant::now()+Duration::from_secs(30);
            while !temp.0.join("boundary.ready").exists() && Instant::now()<deadline {
                if let Some(status)=child.try_wait().unwrap() { panic!("{command}/{phase} child exited early: {status}"); }
                thread::sleep(Duration::from_millis(10));
            }
            let reached=temp.0.join("boundary.ready").exists(); child.kill().unwrap(); child.wait().unwrap();
            assert!(reached,"{command}/{phase} checkpoint missing");
            if phase=="control.witness" {
                assert!(matches!(Store::open(&temp.0),Err(Error::RecoveryRequired)));
                continue;
            }
            let mut store=Store::open(&temp.0).unwrap(); let key=credential(); let mut sessions=pair(&store,&key);
            let before=tip(&store);
            let request=if command=="submit" {submit()} else {cancel()};
            assert!(call(&mut store,&mut sessions,&request).get("result").is_some());
            assert_eq!(count(&store,"control.completed"),1);
            assert_eq!(count(&store,"task.created"),1);
            assert_eq!(count(&store,"task.cancelled"),i64::from(command=="cancel"));
            if phase=="control.commit" { assert_eq!(tip(&store),before,"replay must not write"); }
            else { assert_eq!(tip(&store),before+1); }
            println!("control fault {command}/{phase}: passed");
        }
    }
}
