//! Durable one-shot work ownership. A queue claim is not a tool grant.
//! Task/action state remains authoritative; queue rows and their events change
//! in that same SQLite transaction. This module never retries an external write.
use crate::{action, admit_lease, checked, counter, digest, event, increment, number, parse, save_task, snapshot, text, Error, Lease, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const SCHEMA: &str = include_str!("queue.sql");
const PENDING: &str = "SELECT id FROM actions WHERE task_id=?1 AND (state IN ('DISPATCHING','UNCERTAIN') OR (state='ACKNOWLEDGED' AND json_extract(record,'$.reconciliation_verdict')!='APPLIED_MISMATCH')) ORDER BY id";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum WorkKind { Advance, Reconcile }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum WorkState { Ready, Leased, Parked, Finished, Cancelled }

/// Persisted internal format, not a new model/RPC contract. The task contract
/// and signed control wire remain unchanged. UTC milliseconds are one-shot
/// not-before times; recurring civil-time schedules need their own contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkEntry {
    pub format: u8,
    pub task_id: String,
    pub version: i64,
    pub kind: WorkKind,
    pub state: WorkState,
    pub priority: i64,
    pub run_after_ms: i64,
    pub ordinal: i64,
    pub attempt: i64,
    pub fence: i64,
    pub cancel_epoch: i64,
    pub contract_hash: String,
    pub lease_owner: Option<String>,
    pub lease_generation: Option<i64>,
    pub lease_until_tick: Option<i64>,
    pub run_id: Option<i64>,
}
impl WorkEntry {
    fn validate(&self) -> Result<()> {
        if self.format!=1 || self.version==0 || self.ordinal==0 || self.contract_hash.len()!=64
            || !self.contract_hash.bytes().all(|b|b.is_ascii_hexdigit())
            || !matches!(self.priority,0|10|20)
            || (self.kind==WorkKind::Reconcile)!=(self.priority==0) {
            return Err(Error::RecoveryRequired);
        }
        for n in [self.version,self.run_after_ms,self.ordinal,self.attempt,self.fence,self.cancel_epoch] { counter(n).map_err(|_|Error::RecoveryRequired)?; }
        if self.state==WorkState::Leased {
            if self.attempt==0 || self.fence==0 || !self.lease_owner.as_deref().is_some_and(owner_valid)
                || self.lease_generation.is_none_or(|n|n<=0)
                || self.lease_until_tick.is_none_or(|n|n<=0)
                || (self.kind==WorkKind::Advance)!=self.run_id.is_some() {
                return Err(Error::RecoveryRequired);
            }
            for n in [self.lease_generation,self.lease_until_tick,self.run_id].into_iter().flatten() { counter(n).map_err(|_|Error::RecoveryRequired)?; }
        } else if self.lease_owner.is_some() || self.lease_generation.is_some() || self.lease_until_tick.is_some() || self.run_id.is_some() {
            return Err(Error::RecoveryRequired);
        }
        Ok(())
    }
    fn clear_lease(&mut self) {
        self.lease_owner=None; self.lease_generation=None; self.lease_until_tick=None; self.run_id=None;
    }
}

/// Opaque live assignment, bound to one store, task, owner, generation and fence.
/// Reconciliation assignments deliberately have no execution/run lease.
#[derive(Debug, Clone)]
pub struct WorkLease {
    store_id: String,
    entry: WorkEntry,
    run: Option<Lease>,
}
impl WorkLease {
    pub fn task_id(&self)->&str { &self.entry.task_id }
    pub fn kind(&self)->WorkKind { self.entry.kind }
    pub fn fence(&self)->i64 { self.entry.fence }
    pub fn attempt(&self)->i64 { self.entry.attempt }
    pub fn contract_hash(&self)->&str { &self.entry.contract_hash }
    /// Trusted-host execution only. This is still not a scoped tool grant.
    pub fn run(&self)->Option<&Lease> { self.run.as_ref() }
}
fn owner_valid(owner:&str)->bool {
    !owner.is_empty() && owner.len()<=128 && owner.bytes().all(|b|b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
pub fn utc_now_ms()->Result<i64> {
    let n=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|Error::Invalid("UTC_CLOCK_BEFORE_EPOCH"))?.as_millis();
    counter(i64::try_from(n).map_err(|_|Error::Invalid("UTC_CLOCK_RANGE"))?)
}
pub(crate) fn pending(conn:&Connection,id:&str)->Result<Vec<String>> {
    let mut s=conn.prepare(PENDING)?;
    let rows=s.query_map([id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}
fn contract_hash(conn:&Connection,id:&str)->Result<String> {
    let raw:String=conn.query_row("SELECT contract FROM tasks WHERE id=?1",[id],|r|r.get(0))?;
    let value=parse(raw)?;
    checked("TaskContract",&value).map_err(|_|Error::RecoveryRequired)?;
    Ok(digest(&serde_json::to_vec(&value)?))
}
fn load(conn:&Connection,id:&str)->Result<Option<WorkEntry>> {
    let raw:Option<String>=conn.query_row("SELECT record FROM work_queue WHERE task_id=?1",[id],|r|r.get(0)).optional()?;
    raw.map(|s| {
        let entry:WorkEntry=serde_json::from_str(&s).map_err(|_|Error::RecoveryRequired)?;
        entry.validate()?;
        if entry.task_id!=id { return Err(Error::RecoveryRequired); }
        Ok(entry)
    }).transpose()
}
fn save(tx:&Transaction<'_>,mut entry:WorkEntry)->Result<WorkEntry> {
    let version=entry.version;
    entry.version=increment(version)?;
    entry.validate()?;
    if tx.execute("UPDATE work_queue SET record=?1 WHERE task_id=?2 AND version=?3",params![serde_json::to_string(&entry)?,entry.task_id,version])?!=1 { return Err(Error::Denied("QUEUE_CAS_CONFLICT")); }
    event(tx,&entry.task_id,"queue.updated",&serde_json::to_value(&entry)?)?;
    Ok(entry)
}
fn desired(conn:&Connection,value:&Value)->Result<(WorkKind,WorkState)> {
    if !pending(conn,text(value,"task_id")?)?.is_empty() { return Ok((WorkKind::Reconcile,WorkState::Ready)); }
    let state=if number(value,"cancel_epoch")?>0 { WorkState::Cancelled } else {
        match text(value,"execution_status")? {
            "READY"=>WorkState::Ready,
            "STOPPED"=>WorkState::Finished,
            _=>WorkState::Parked,
        }
    };
    Ok((WorkKind::Advance,state))
}
/// Called after every authoritative task update, before its transaction commits.
/// A phase change invalidates a claim, but an observation that still needs the
/// same reconciliation keeps its owner until explicit defer or process recovery.
pub(crate) fn sync(tx:&Transaction<'_>,value:&Value,recovery:bool)->Result<()> {
    let id=text(value,"task_id")?;
    let (kind,mut state)=desired(tx,value)?;
    let epoch=number(value,"cancel_epoch")?;
    let Some(mut entry)=load(tx,id)? else {
        let raw:String=tx.query_row("SELECT contract FROM tasks WHERE id=?1",[id],|r|r.get(0))?;
        let contract=parse(raw)?;
        let ordinal:i64=tx.query_row("SELECT min(seq) FROM events WHERE aggregate_id=?1 AND kind='task.created'",[id],|r|r.get(0))?;
        let entry=WorkEntry{format:1,task_id:id.into(),version:1,kind,state,priority:if kind==WorkKind::Reconcile {0} else if contract.get("deadline").is_some() {10} else {20},run_after_ms:0,ordinal,attempt:0,fence:0,cancel_epoch:epoch,contract_hash:contract_hash(tx,id)?,lease_owner:None,lease_generation:None,lease_until_tick:None,run_id:None};
        entry.validate()?;
        tx.execute("INSERT INTO work_queue(task_id,record) VALUES(?1,?2)",params![id,serde_json::to_string(&entry)?])?;
        event(tx,id,"queue.created",&serde_json::to_value(&entry)?)?;
        return Ok(());
    };
    if contract_hash(tx,id)?!=entry.contract_hash { return Err(Error::RecoveryRequired); }
    let before=entry.clone();
    if !recovery && entry.state==WorkState::Leased && entry.kind==kind && entry.cancel_epoch==epoch {
        if kind==WorkKind::Reconcile || value["execution_status"]=="RUNNING" { state=WorkState::Leased; }
    }
    if kind!=entry.kind { entry.run_after_ms=0; }
    entry.kind=kind; entry.state=state; entry.cancel_epoch=epoch;
    if kind==WorkKind::Reconcile { entry.priority=0; }
    else if entry.priority==0 {
        let raw:String=tx.query_row("SELECT contract FROM tasks WHERE id=?1",[id],|r|r.get(0))?;
        entry.priority=if parse(raw)?.get("deadline").is_some() {10} else {20};
    }
    if state!=WorkState::Leased { entry.clear_lease(); }
    if entry!=before { save(tx,entry)?; }
    Ok(())
}
pub(crate) fn recover(tx:&Transaction<'_>)->Result<()> {
    for id in crate::ids(tx,"SELECT id FROM tasks ORDER BY id")? { sync(tx,&snapshot(tx,&id)?,true)?; }
    Ok(())
}
pub(crate) fn audit(store:&Store)->Result<()> {
    let orphan:bool=store.conn.query_row("SELECT EXISTS(SELECT 1 FROM tasks t LEFT JOIN work_queue q ON q.task_id=t.id WHERE q.task_id IS NULL)",[],|r|r.get(0))?;
    if orphan { return Err(Error::RecoveryRequired); }
    for id in crate::ids(&store.conn,"SELECT task_id FROM work_queue")? {
        let entry=load(&store.conn,&id)?.ok_or(Error::RecoveryRequired)?;
        if entry.contract_hash!=contract_hash(&store.conn,&id)? { return Err(Error::RecoveryRequired); }
        store.audit_tail(&id,"queue.%",&serde_json::to_value(&entry)?)?;
        let value=snapshot(&store.conn,&id)?;
        let (kind,state)=desired(&store.conn,&value)?;
        if entry.kind!=kind || entry.cancel_epoch!=number(&value,"cancel_epoch")? { return Err(Error::RecoveryRequired); }
        if entry.state!=WorkState::Leased && entry.state!=state { return Err(Error::RecoveryRequired); }
        if entry.state==WorkState::Leased && kind==WorkKind::Advance && value["execution_status"]!="RUNNING" { return Err(Error::RecoveryRequired); }
    }
    let mut s=store.conn.prepare("SELECT hash,record FROM work_checkpoints")?;
    let mut rows=s.query([])?;
    while let Some(row)=rows.next()? {
        let hash:String=row.get(0)?; let raw:String=row.get(1)?;
        if digest(raw.as_bytes())!=hash { return Err(Error::RecoveryRequired); }
    }
    Ok(())
}
fn candidate(conn:&Connection,now:i64)->Result<Option<String>> {
    // Current authoritative state is checked in SQL as well as after selection.
    Ok(conn.query_row("SELECT q.task_id FROM work_queue q JOIN tasks t ON t.id=q.task_id JOIN metadata m ON m.singleton=1 WHERE q.state='ready' AND q.run_after<=?1 AND (q.kind='reconcile' OR (t.execution='READY' AND t.cancel_epoch=0 AND m.denied=0)) ORDER BY q.priority,q.run_after,q.ordinal,q.task_id LIMIT 1",[now],|r|r.get(0)).optional()?)
}
fn alive(store:&Store,lease:&WorkLease,tick:i64)->Result<WorkEntry> {
    if store.poisoned { return Err(Error::RecoveryRequired); }
    let (id,generation):(String,i64)=store.conn.query_row("SELECT store_id,generation FROM metadata",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let entry=load(&store.conn,lease.task_id())?.ok_or(Error::Denied("STALE_QUEUE_LEASE"))?;
    if id!=lease.store_id || entry.state!=WorkState::Leased || entry.kind!=lease.kind()
        || entry.fence!=lease.entry.fence || entry.lease_owner!=lease.entry.lease_owner
        || entry.lease_generation!=Some(generation) || entry.lease_generation!=lease.entry.lease_generation
        || entry.cancel_epoch!=lease.entry.cancel_epoch || entry.lease_until_tick.is_none_or(|until|until<=tick) {
        return Err(Error::Denied("STALE_QUEUE_LEASE"));
    }
    if contract_hash(&store.conn,lease.task_id())?!=entry.contract_hash { return Err(Error::RecoveryRequired); }
    Ok(entry)
}
impl Store {
    pub fn work_entry(&self,id:&str)->Result<WorkEntry> {
        if self.poisoned { return Err(Error::RecoveryRequired); }
        load(&self.conn,id)?.ok_or(Error::Denied("QUEUE_TASK_NOT_FOUND"))
    }
    /// No write or witness commit occurs on idle polling. Only the trusted host
    /// supplies UTC time; a clock moving backwards delays schedules, not leases.
    pub fn claim_work(&mut self,owner:&str,now_ms:i64,ttl:Duration)->Result<Option<WorkLease>> {
        if self.poisoned { return Err(Error::RecoveryRequired); }
        counter(now_ms)?;
        if !owner_valid(owner) || ttl.is_zero() || ttl>Duration::from_secs(300) { return Err(Error::Invalid("QUEUE_LEASE_LIMIT")); }
        let tick=self.tick()?;
        let duration=i64::try_from(ttl.as_millis()).map_err(|_|Error::Invalid("QUEUE_LEASE_LIMIT"))?;
        if duration==0 { return Err(Error::Invalid("QUEUE_LEASE_LIMIT")); }
        let until=counter(tick.checked_add(duration).ok_or(Error::Invalid("QUEUE_LEASE_LIMIT"))?)?;
        let Some(id)=candidate(&self.conn,now_ms)? else { return Ok(None); };
        self.transact("queue_claim",|tx| {
            if candidate(tx,now_ms)?.as_deref()!=Some(&id) { return Err(Error::Denied("QUEUE_CAS_CONFLICT")); }
            let entry=load(tx,&id)?.ok_or(Error::RecoveryRequired)?;
            let run=if entry.kind==WorkKind::Advance { Some(start_run_tx(tx,&id,until)?) } else { None };
            let mut entry=load(tx,&id)?.ok_or(Error::RecoveryRequired)?;
            let (store_id,generation):(String,i64)=tx.query_row("SELECT store_id,generation FROM metadata",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            entry.state=WorkState::Leased; entry.attempt=increment(entry.attempt)?; entry.fence=increment(entry.fence)?;
            entry.lease_owner=Some(owner.into()); entry.lease_generation=Some(generation); entry.lease_until_tick=Some(until);
            entry.run_id=run.as_ref().map(|r|r.run_id);
            let entry=save(tx,entry)?;
            Ok(Some(WorkLease{store_id,entry,run}))
        })
    }
    /// Reorder only READY work, with an absolute UTC not-before time. This does
    /// not create recurring schedules, reset a cancellation or change authority.
    pub fn schedule_work(&mut self,id:&str,run_after_ms:i64)->Result<()> {
        counter(run_after_ms)?;
        let entry=self.work_entry(id)?;
        if entry.state!=WorkState::Ready { return Err(Error::Denied("QUEUE_NOT_READY")); }
        if entry.run_after_ms==run_after_ms { return Ok(()); }
        self.transact("queue_schedule",|tx| {
            let mut entry=load(tx,id)?.ok_or(Error::RecoveryRequired)?;
            if entry.state!=WorkState::Ready { return Err(Error::Denied("QUEUE_NOT_READY")); }
            entry.run_after_ms=run_after_ms; save(tx,entry)?; Ok(())
        })
    }
    pub fn work_contract(&self,lease:&WorkLease)->Result<tada_contracts::TaskContract> {
        alive(self,lease,self.tick()?)?;
        let raw:String=self.conn.query_row("SELECT contract FROM tasks WHERE id=?1",[lease.task_id()],|r|r.get(0))?;
        tada_contracts::decode(&parse(raw)?).map_err(|_|Error::RecoveryRequired)
    }
    /// Worker has stopped at a safe point. Yield never retransmits or clears an
    /// external uncertainty. Expired live leases require an explicit host stop
    /// or process recovery; another worker cannot silently steal their work.
    pub fn defer_work(&mut self,lease:&WorkLease,run_after_ms:i64)->Result<()> {
        counter(run_after_ms)?;
        let tick=self.tick()?; alive(self,lease,tick)?;
        self.transact("queue_defer",|tx| {
            if let Some(run)=lease.run() {
                admit_lease(tx,run,tick)?;
                if !pending(tx,lease.task_id())?.is_empty() { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }
                tx.execute("UPDATE runs SET active=0 WHERE id=?1",[run.run_id])?;
                tx.execute("UPDATE grants SET revoked=1 WHERE run_id=?1",[run.run_id])?;
                let mut value=snapshot(tx,lease.task_id())?;
                value["execution_status"]=json!("READY");
                save_task(tx,value,"task.queue_yielded")?;
            }
            let mut entry=load(tx,lease.task_id())?.ok_or(Error::RecoveryRequired)?;
            entry.state=WorkState::Ready; entry.clear_lease(); entry.run_after_ms=run_after_ms;
            save(tx,entry)?; Ok(())
        })
    }
    /// Fixed model-free probe: independently check the worker's immutable input
    /// digest, persist a checkpoint, stop execution, and leave all task acceptance
    /// criteria unmet. This is not an artifact verifier or a completed user task.
    pub fn finish_probe(&mut self,lease:&WorkLease,observed_contract_hash:&str)->Result<String> {
        let tick=self.tick()?;
        let entry=alive(self,lease,tick)?;
        let run=lease.run().ok_or(Error::Denied("OBSERVATION_ONLY_ASSIGNMENT"))?;
        if observed_contract_hash!=entry.contract_hash { return Err(Error::Denied("PROBE_INPUT_CHANGED")); }
        self.transact("queue_checkpoint",|tx| {
            admit_lease(tx,run,tick)?;
            if !pending(tx,lease.task_id())?.is_empty() { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }
            let checkpoint=json!({"format":1,"kind":"immutable_input_probe","task_id":lease.task_id(),"contract_hash":entry.contract_hash,"generation":entry.lease_generation,"queue_fence":entry.fence,"run_id":run.run_id,"task_success":false});
            let raw=serde_json::to_string(&checkpoint)?; let hash=digest(raw.as_bytes());
            tx.execute("INSERT INTO work_checkpoints(hash,task_id,record) VALUES(?1,?2,?3)",params![hash,lease.task_id(),raw])?;
            event(tx,lease.task_id(),"checkpoint.probe",&json!({"hash":hash}))?;
            tx.execute("UPDATE runs SET active=0 WHERE id=?1",[run.run_id])?;
            tx.execute("UPDATE grants SET revoked=1 WHERE run_id=?1",[run.run_id])?;
            let mut value=snapshot(tx,lease.task_id())?;
            value["execution_status"]=json!("STOPPED");
            let value=save_task(tx,value,"task.probe_stopped")?;
            crate::enqueue(tx,&value,"stopped")?;
            Ok(hash)
        })
    }
    /// Reconciliation uses existing receipt/target observation only. It does not
    /// obtain a run lease or call the mock's mutation endpoint, even on zero hits.
    pub fn reconcile_work_mock(&mut self,lease:&WorkLease,service:&crate::mock::MockService,retry_at_ms:i64)->Result<()> {
        counter(retry_at_ms)?;
        alive(self,lease,self.tick()?)?;
        if lease.kind()!=WorkKind::Reconcile { return Err(Error::Denied("NOT_RECONCILIATION_WORK")); }
        let actions=pending(&self.conn,lease.task_id())?;
        for id in actions.into_iter().take(32) { self.reconcile_mock(&id,service)?; }
        if self.work_entry(lease.task_id())?.state==WorkState::Leased { self.defer_work(lease,retry_at_ms)?; }
        Ok(())
    }
    /// Count is bounded by the queue, not a universal CPU/process quota.
    pub fn leased_work_count(&self)->Result<usize> {
        if self.poisoned { return Err(Error::RecoveryRequired); }
        Ok(self.conn.query_row("SELECT count(*) FROM work_queue WHERE state='leased'",[],|r|r.get(0))?)
    }
}

pub(crate) fn start_run_tx(tx:&Transaction<'_>,id:&str,until:i64)->Result<Lease> {
    let mut value=snapshot(tx,id)?;
    if number(&value,"cancel_epoch")?!=0 || value["execution_status"]!="READY" { return Err(Error::Denied("TASK_NOT_READY")); }
    // A confirmed mismatch still requires a new explicit task/plan decision.
    let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE task_id=?1 AND state IN ('DISPATCHING','UNCERTAIN','ACKNOWLEDGED'))",[id],|r|r.get(0))?;
    if unresolved { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }
    let previous:i64=tx.query_row("SELECT fence FROM tasks WHERE id=?1",[id],|r|r.get(0))?;
    let fence=increment(previous)?;
    let generation:i64=tx.query_row("SELECT generation FROM metadata",[],|r|r.get(0))?;
    tx.execute("UPDATE tasks SET fence=?1 WHERE id=?2",params![fence,id])?;
    tx.execute("INSERT INTO runs(task_id,generation,fence,expires_tick,active) VALUES(?1,?2,?3,?4,1)",params![id,generation,fence,until])?;
    let run_id=tx.last_insert_rowid();
    value["execution_status"]=json!("RUNNING");
    save_task(tx,value,"task.run_started")?;
    Ok(Lease{task_id:id.into(),run_id,generation,fence})
}

#[cfg(test)]
mod tests;
