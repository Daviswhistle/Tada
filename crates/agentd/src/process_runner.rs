//! Task-specific fixed probe processes. Only the foreground host calls this;
//! no model-supplied executable, environment or directory is accepted.
use crate::{process_scope::Scope, worker_wire::{self, Request, MAX_REPLY, MAX_REQUEST}};
use serde::Serialize;
use std::{path::{Path,PathBuf},process::{ExitStatus,Stdio},sync::{Arc,Mutex},time::Duration};
use tada_store::{priority::Priority,queue::{WorkKind,WorkLease,WorkState},Error,Store};
use tokio::{io::{AsyncRead,AsyncReadExt,AsyncWriteExt},process::{Child,Command},sync::{watch,oneshot},time::{sleep,timeout,Instant}};

pub(crate) type Result<T> = std::result::Result<T,Error>;
#[derive(Clone)]
pub(crate) struct Options {
    pub mode: String,
    pub deadline: Duration,
}
impl Default for Options { fn default() -> Self { Self { mode:"normal".into(),deadline:Duration::from_secs(10) } } }
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum Cause { Completed, Cancelled, Shutdown, Deadline, InvalidOutput, ProcessFailed, OwnershipLost }
#[derive(Debug,Serialize)]
pub(crate) struct Report {
    pub task_id: String,
    pub pid: u32,
    pub reaped: bool,
    pub cause: Cause,
    pub queue_state: WorkState,
    pub checkpoint: Option<String>,
}

/// Await admission BEFORE occupying a blocking thread. The permit stays owned
/// until the actual DB worker exits, even if its async caller is dropped.
pub(crate) async fn with_store<T:Send+'static>(store:Arc<Mutex<Store>>,priority:Priority,f:impl FnOnce(&mut Store)->Result<T>+Send+'static)->Result<T> {
    let gate = store.lock().map_err(|_|Error::RecoveryRequired)?.admission_gate();
    let permit = gate.register(priority)?.await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut owner = store.lock().map_err(|_|Error::RecoveryRequired)?;
        f(&mut owner)
    }).await.map_err(|_|Error::RecoveryRequired)?
}
async fn read_reply(reader:&mut (impl AsyncRead+Unpin))->Result<Vec<u8>> {
    let n=reader.read_u32().await? as usize;
    if n==0 || n>MAX_REPLY { return Err(Error::Invalid("PROBE_FRAME_LIMIT")); }
    let mut bytes=vec![0;n]; reader.read_exact(&mut bytes).await?;
    let mut extra=[0;1];
    if reader.read(&mut extra).await?!=0 { return Err(Error::Invalid("PROBE_TRAILING_DATA")); }
    Ok(bytes)
}
async fn drain_stderr(reader:impl AsyncRead+Unpin)->Result<()> {
    // Bounded discard, not a potentially unbounded log file or terminal echo.
    let mut bounded=reader.take((MAX_REPLY+1) as u64); let mut bytes=Vec::new();
    bounded.read_to_end(&mut bytes).await?;
    if bytes.len()>MAX_REPLY { return Err(Error::Invalid("PROBE_STDERR_LIMIT")); }
    Ok(())
}
async fn reap(child:&mut Child,scope:&Scope)->Result<ExitStatus> {
    // A kill request is not reaping evidence. Regardless of races around exit,
    // require successful wait and an empty Windows job before releasing work.
    let _kill=scope.terminate(child);
    let status=timeout(Duration::from_secs(3),child.wait()).await
        .map_err(|_|Error::Denied("PROBE_REAP_UNCONFIRMED"))??;
    timeout(Duration::from_secs(3),async {
        while !scope.empty()? { sleep(Duration::from_millis(10)).await; }
        Ok::<_,Error>(())
    }).await.map_err(|_|Error::Denied("PROBE_SCOPE_NOT_EMPTY"))??;
    Ok(status)
}
fn configure(command:&mut Command,cwd:&Path) {
    command.arg("--probe-worker").current_dir(cwd).env_clear()
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Windows needs its OS directory for native runtime facilities. Deliberately
    // no PATH, HOME, proxy, provider key, NODE_OPTIONS or shell startup injection.
    #[cfg(windows)]
    if let Some(root)=std::env::var_os("SystemRoot") { command.env("SystemRoot",root); }
}
pub(crate) async fn run_one(store:Arc<Mutex<Store>>,exe:PathBuf,cwd:PathBuf,mut stop:watch::Receiver<bool>,options:Options,started:Option<oneshot::Sender<u32>>)->Result<Option<Report>> {
    if !cfg!(any(target_os="linux",windows)) { return Err(Error::Denied("PROBE_PLATFORM_UNSUPPORTED")); }
    if options.deadline.is_zero() || options.deadline>Duration::from_secs(30)
        || (options.mode!="normal" && !cfg!(feature="process-fixtures")) || !exe.is_absolute() || !cwd.is_absolute()
    { return Err(Error::Invalid("PROBE_OPTIONS")); }
    if *stop.borrow() { return Ok(None); }
    let stop_at_claim=stop.clone();
    let assignment=with_store(Arc::clone(&store),Priority::Ordinary,move |s| {
        if *stop_at_claim.borrow() || s.leased_work_count()?!=0 { return Ok(None); }
        let Some(lease)=s.claim_work("foreground-fixed-probe",tada_store::queue::utc_now_ms()?,Duration::from_secs(60))? else {return Ok(None);};
        if lease.kind()==WorkKind::Reconcile {
            // No external target is invented by the host. Leave observation
            // pending for its real adapter, with a bounded polling interval.
            s.defer_work(&lease,tada_store::queue::utc_now_ms()?.checked_add(1000).ok_or(Error::Invalid("UTC_CLOCK_RANGE"))?)?;
            return Ok(None);
        }
        let contract=s.work_contract(&lease)?;
        let value=tada_contracts::encode(&contract).map_err(|_|Error::RecoveryRequired)?;
        Ok(Some((lease,serde_json::to_string(&value)?)))
    }).await?;
    let Some((lease,contract_json))=assignment else {return Ok(None);};
    let mut nonce=[0;16]; getrandom::fill(&mut nonce).map_err(|_|Error::Invalid("PROBE_RANDOM_FAILED"))?;
    let request=Request{format:1,nonce:nonce.iter().map(|b|format!("{b:02x}")).collect(),task_id:lease.task_id().into(),fence:lease.fence(),contract_json};
    let input=worker_wire::packet(&serde_json::to_vec(&request)?,MAX_REQUEST)?;
    let mut command=Command::new(exe); configure(&mut command,&cwd);
    #[cfg(feature="process-fixtures")]
    if options.mode!="normal" {command.arg(&options.mode);}
    let scope=Scope::prepare(&mut command)?;
    let mut child=command.spawn()?;
    let pid=child.id().ok_or(Error::Denied("PROBE_PID_UNAVAILABLE"))?;
    if let Err(error)=scope.attach(&child) {
        // Includes nested-job failures: no request bytes were sent.
        reap(&mut child,&scope).await?;
        return Err(Error::Io(error));
    }
    let mut stdin=child.stdin.take().ok_or(Error::RecoveryRequired)?;
    let mut stdout=child.stdout.take().ok_or(Error::RecoveryRequired)?;
    let stderr=child.stderr.take().ok_or(Error::RecoveryRequired)?;
    let observed_lease=lease.clone();
    if let Err(error)=with_store(Arc::clone(&store),Priority::Ordinary,move |s|s.note_probe_process(&observed_lease,pid,false)).await {
        drop(stdin); reap(&mut child,&scope).await?;
        return Err(error);
    }
    let expected_hash=lease.contract_hash().to_owned();
    let observation=async {
        let send=async move {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?; drop(stdin);
            if let Some(started)=started {let _=started.send(pid);}
            Ok::<_,Error>(())
        };
        let read=async {
            let bytes=read_reply(&mut stdout).await?;
            request.check_reply(&bytes,&expected_hash)?;
            Ok::<_,Error>(())
        };
        tokio::try_join!(send,read,drain_stderr(stderr))?;
        Ok::<_,Error>(())
    };
    // Both the complete response/EOF and the exit status are necessary. Neither
    // a valid reply followed by a hung worker nor exit 0 without a reply passes.
    let mut storage_error=None;
    let mut cause={
        tokio::pin!(observation);
        let wait=child.wait(); tokio::pin!(wait);
        let deadline=sleep(options.deadline); tokio::pin!(deadline);
        let mut poll=tokio::time::interval(Duration::from_millis(25));
        let mut got_reply=false; let mut exited=false;
        loop {
            if got_reply && exited {break Cause::Completed;}
            tokio::select! {
                biased;
                _=stop.changed()=>break Cause::Shutdown,
                _=&mut deadline=>break Cause::Deadline,
                _=poll.tick()=>{
                    let current=lease.clone();
                    match with_store(Arc::clone(&store),Priority::Ordinary,move |s|s.check_work_lease(&current)).await {
                        Ok(())=>(),
                        Err(Error::Denied(_))=>break Cause::OwnershipLost,
                        Err(error)=>{storage_error=Some(error);break Cause::OwnershipLost;},
                    }
                },
                result=&mut observation,if !got_reply=>match result {Ok(())=>got_reply=true,Err(_)=>break Cause::InvalidOutput},
                status=&mut wait,if !exited=>match status {Ok(status) if status.success()=>exited=true,_=>break Cause::ProcessFailed},
            }
        }
    };
    // Do not abort/detach a worker and hand its assignment to someone else.
    // On failure here the caller stops; no queue-release operation is reached.
    reap(&mut child,&scope).await?;
    if let Some(error)=storage_error {return Err(error);}
    let current=lease.clone();
    with_store(Arc::clone(&store),Priority::Ordinary,move |s|s.note_probe_process(&current,pid,true)).await?;
    let current=lease.clone();
    let (checkpoint,queue_state,cancelled)=with_store(Arc::clone(&store),Priority::Ordinary,move |s| {
        let cancelled=s.task(current.task_id())?.execution_status==tada_contracts::ExecutionStatus::Cancelled;
        if cancelled {return Ok((None,s.work_entry(current.task_id())?.state,true));}
        let checkpoint=if cause==Cause::Completed {
            match s.finish_probe(&current,current.contract_hash()) {
                Ok(hash)=>Some(hash),
                Err(Error::Denied("STALE_QUEUE_LEASE"))=>{
                    s.retire_stopped_probe(&current,None)?; None
                },
                Err(error)=>return Err(error),
            }
        } else {
            // Graceful host stop yields; a faulty/expired process is parked
            // instead of creating an unbounded automatic spawn/retry loop.
            let retry=if cause==Cause::Shutdown {Some(tada_store::queue::utc_now_ms()?)} else {None};
            s.retire_stopped_probe(&current,retry)?; None
        };
        Ok((checkpoint,s.work_entry(current.task_id())?.state,false))
    }).await?;
    if cancelled {cause=Cause::Cancelled;}
    Ok(Some(Report{task_id:lease.task_id().into(),pid,reaped:true,cause,queue_state,checkpoint}))
}
pub(crate) async fn run_loop(store:Arc<Mutex<Store>>,exe:PathBuf,cwd:PathBuf,mut stop:watch::Receiver<bool>)->Result<()> {
    loop {
        if *stop.borrow() {return Ok(());}
        let result=run_one(Arc::clone(&store),exe.clone(),cwd.clone(),stop.clone(),Options::default(),None).await?;
        if result.is_none() {
            tokio::select! {biased; _=stop.changed()=>return Ok(()), _=sleep(Duration::from_millis(100))=>()}
        }
    }
}
