#![cfg(any(target_os="linux",windows))]
use serde_json::Value;
use std::{path::PathBuf,process::{Command,Stdio,Output},time::{Duration,Instant},thread,io::{Read,Write}};

struct Temp(PathBuf);
impl Temp {
    fn new()->Self {
        let mut bytes=[0;12];getrandom::fill(&mut bytes).unwrap();
        Self(std::env::temp_dir().join(format!("t7-{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>())))
    }
}
impl Drop for Temp {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
fn binary()->Command {Command::new(env!("CARGO_BIN_EXE_tada-agentd"))}
fn run(mut command:Command)->Output {
    let mut child=command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let deadline=Instant::now()+Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() && Instant::now()<deadline {thread::sleep(Duration::from_millis(10));}
    if child.try_wait().unwrap().is_none() {let _=child.kill();let _=child.wait();panic!("foreground fixture exceeded its fixed timeout");}
    child.wait_with_output().unwrap()
}
fn demo(root:&Temp,mode:Option<&str>)->Value {
    let mut command=binary();command.arg("demo").arg(&root.0);
    if let Some(mode)=mode {command.arg(mode);}
    let output=run(command);
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let value:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["report"]["reaped"],true);
    assert!(value["report"]["pid"].as_u64().unwrap()>0);
    assert_ne!(value["task"]["completion_status"],"SUCCEEDED");
    assert_eq!(value["queued_cancel_epoch"],1);
    assert_eq!(value["live_tools"],0);
    value
}
#[test]
fn foreground_native_control_runs_one_separate_probe_and_preserves_replay() {
    let root=Temp::new();let value=demo(&root,None);
    assert_eq!(value["report"]["cause"],"completed");
    assert_eq!(value["task"]["execution_status"],"STOPPED");
    assert!(value["report"]["checkpoint"].is_string());
    let store=tada_store::Store::open(&root.0.join("data")).unwrap();
    assert_eq!(store.task("probe-cancelled").unwrap().execution_status,tada_contracts::ExecutionStatus::Cancelled);
    let conn=rusqlite::Connection::open_with_flags(root.0.join("data/state.sqlite"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (started,reaped,checkpoints):(i64,i64,i64)=conn.query_row("SELECT (SELECT count(*) FROM events WHERE kind='worker.probe_started'),(SELECT count(*) FROM events WHERE kind='worker.probe_reaped'),(SELECT count(*) FROM work_checkpoints)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!((started,reaped,checkpoints),(1,1,1));
}
#[test]
fn existing_destination_and_invalid_commands_do_not_overwrite_data() {
    let root=Temp::new();std::fs::create_dir(&root.0).unwrap();
    std::fs::write(root.0.join("keep"),b"preserve").unwrap();
    let mut command=binary();command.arg("demo").arg(&root.0);
    assert!(!run(command).status.success());
    assert_eq!(std::fs::read(root.0.join("keep")).unwrap(),b"preserve");
    let mut command=binary();command.arg("serve").arg("relative").arg("relative");
    assert!(!run(command).status.success());
    assert!(!root.0.join("data").exists());
    let mut command=binary();command.arg("--help");
    assert!(run(command).status.success());
}
#[test]
fn worker_stdio_rejects_partial_oversized_duplicate_and_unknown_input() {
    for body in [vec![255;4],vec![0,0,0,100,b'{'],{
        let payload=b"{\"format\":1,\"format\":1}";
        let mut b=(payload.len() as u32).to_be_bytes().to_vec();b.extend_from_slice(payload);b
    },{
        let payload=b"{\"format\":1,\"command\":\"shell\"}";
        let mut b=(payload.len() as u32).to_be_bytes().to_vec();b.extend_from_slice(payload);b
    }] {
        let mut child=binary().arg("--probe-worker").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(&body).unwrap();
        let output=child.wait_with_output().unwrap();
        assert!(!output.status.success());assert!(output.stdout.is_empty());
    }
}
#[test]
fn oversized_request_is_rejected_before_os_vault_access() {
    let root=Temp::new();std::fs::create_dir(&root.0).unwrap();
    let request=root.0.join("huge.json");std::fs::write(&request,vec![b'x';tada_store::control::auth::MAX_BODY+1]).unwrap();
    let mut command=binary();command.arg("request").arg(root.0.join("missing-identity")).arg(request);
    let output=run(command);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("REQUEST_BODY_LIMIT"));
    assert!(!root.0.join("missing-identity").exists());
}
#[cfg(feature="process-fixtures")]
#[test]
fn fixed_fault_matrix_never_accepts_exit_or_response_alone_as_completion() {
    let modes=["empty","exit-error","wrong-hash","wrong-nonce","wrong-task","wrong-fence","stdout-flood","stderr-flood","partial","duplicate","trailing","reply-hang","timeout"];
    assert_eq!(modes.len(),13,"fixed process failure denominator");
    for mode in modes {
        let root=Temp::new();let value=demo(&root,Some(mode));
        assert_ne!(value["report"]["cause"],"completed","{mode}");
        assert!(value["report"]["checkpoint"].is_null(),"{mode}");
        assert_eq!(value["report"]["queue_state"],"finished","{mode}");
        assert_eq!(value["task"]["execution_status"],"STOPPED","{mode}");
        assert_eq!(value["task"]["unmet_required_criteria"],serde_json::json!(["actual-user-result-not-published"]));
        let conn=rusqlite::Connection::open_with_flags(root.0.join("data/state.sqlite"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM work_checkpoints",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        println!("fixed process fault {mode}: reaped, no result checkpoint, parked");
    }
}
#[cfg(feature="process-fixtures")]
#[test]
fn native_cancel_and_graceful_shutdown_reap_before_cancel_or_yield() {
    let cancelled=Temp::new();let value=demo(&cancelled,Some("cancel"));
    assert_eq!(value["report"]["cause"],"cancelled");
    assert_eq!(value["task"]["execution_status"],"CANCELLED");
    assert_eq!(value["task"]["cancel_epoch"],1);
    assert!(value["report"]["checkpoint"].is_null());
    let stopped=Temp::new();let value=demo(&stopped,Some("shutdown"));
    assert_eq!(value["report"]["cause"],"shutdown");
    assert_eq!(value["task"]["execution_status"],"READY");
    assert_eq!(value["task"]["cancel_epoch"],0);
    let mut store=tada_store::Store::open(&stopped.0.join("data")).unwrap();
    let lease=store.claim_work("after-reap",tada_store::queue::utc_now_ms().unwrap(),Duration::from_secs(60)).unwrap().unwrap();
    assert_eq!(lease.task_id(),"probe-a");assert!(lease.attempt()>1);
}
#[cfg(feature="process-fixtures")]
#[test]
fn fixed_worker_does_not_inherit_provider_or_runtime_injection_environment() {
    let root=Temp::new();let mut command=binary();command.arg("demo").arg(&root.0).arg("env-canary");
    const CANARY:&str="TADA_FAKE_SECRET_MUST_NOT_REACH_WORKER_7";
    for key in ["TADA_SECRET_CANARY","OPENAI_API_KEY","NODE_OPTIONS","PYTHONPATH"] {command.env(key,CANARY);}
    let output=run(command);
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let value:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["report"]["cause"],"completed");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(CANARY));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(CANARY));
}
#[cfg(all(feature="process-fixtures",windows))]
#[test]
fn windows_job_disallows_a_second_active_process() {
    let root=Temp::new();let value=demo(&root,Some("spawn-child"));
    assert_eq!(value["report"]["cause"],"completed");
}
#[cfg(feature="process-fixtures")]
#[test]
fn killing_foreground_parent_stops_its_owned_fixed_worker() {
    use std::io::BufRead;
    let root=Temp::new();
    let mut parent=binary().arg("demo").arg(&root.0).arg("parent-death").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let stdout=parent.stdout.take().unwrap();let (tx,rx)=std::sync::mpsc::channel();
    let reader=thread::spawn(move || {let mut line=String::new();let result=std::io::BufReader::new(stdout).read_line(&mut line);let _=tx.send((result,line));});
    let notice=rx.recv_timeout(Duration::from_secs(15));
    if notice.is_err(){let _=parent.kill();let _=parent.wait();reader.join().unwrap();panic!("worker start notice not received");}
    let (result,line)=notice.unwrap();result.unwrap();reader.join().unwrap();
    let pid=serde_json::from_str::<Value>(&line).unwrap()["worker_started"].as_u64().unwrap() as u32;
    let witness=ProcessWatch::open(pid);
    assert!(witness.running(),"worker must be live before the parent is killed");
    parent.kill().unwrap();assert!(!parent.wait().unwrap().success());
    let deadline=Instant::now()+Duration::from_secs(5);
    while witness.running() && Instant::now()<deadline {thread::sleep(Duration::from_millis(10));}
    assert!(!witness.running(),"owned fixed worker survived its foreground parent");
    // No PID is used as authority during recovery. Only this known pure probe
    // may be recomputed; the prior nonce/generation cannot submit a result.
    let mut store=tada_store::Store::open(&root.0.join("data")).unwrap();
    assert!(store.claim_work("after-parent-exit",tada_store::queue::utc_now_ms().unwrap(),Duration::from_secs(60)).unwrap().is_some());
}
#[cfg(all(feature="process-fixtures",target_os="linux"))]
struct ProcessWatch {pid:u32,start:String}
#[cfg(all(feature="process-fixtures",target_os="linux"))]
impl ProcessWatch {
    fn fields(pid:u32)->Option<(String,String)> {
        let raw=std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields:Vec<_>=raw.rsplit_once(") ")?.1.split_whitespace().collect();
        Some((fields.first()?.to_string(),fields.get(19)?.to_string()))
    }
    fn open(pid:u32)->Self {Self{pid,start:Self::fields(pid).unwrap().1}}
    fn running(&self)->bool {Self::fields(self.pid).is_some_and(|(state,start)|start==self.start && state!="Z" && state!="X")}
}
#[cfg(all(feature="process-fixtures",windows))]
struct ProcessWatch(std::os::windows::io::OwnedHandle);
#[cfg(all(feature="process-fixtures",windows))]
impl ProcessWatch {
    fn open(pid:u32)->Self {
        use std::os::windows::io::FromRawHandle;
        // SYNCHRONIZE access only; retain the kernel object, not a recycled PID.
        let raw=unsafe{windows_sys::Win32::System::Threading::OpenProcess(0x0010_0000,0,pid)};
        assert!(!raw.is_null());Self(unsafe{std::os::windows::io::OwnedHandle::from_raw_handle(raw)})
    }
    fn running(&self)->bool {
        use std::os::windows::io::AsRawHandle;
        let status=unsafe{windows_sys::Win32::System::Threading::WaitForSingleObject(self.0.as_raw_handle(),0)};
        assert!(status==0 || status==258,"process wait failed");status==258
    }
}
