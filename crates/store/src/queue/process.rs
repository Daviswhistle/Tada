//! Trusted-host lifecycle bookkeeping for the fixed no-tool probe.
//! Reaping is established by agentd's owned OS Child handle, not a worker claim.
//! These APIs are deliberately absent from the control/worker wire protocols.
use super::*;

fn process_key(lease: &WorkLease, pid: u32) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&(
        "probe-process-v1",
        &lease.store_id,
        lease.task_id(),
        lease.fence(),
        lease.entry.lease_generation,
        pid,
    ))?))
}
fn context(store: &Store, lease: &WorkLease) -> Result<()> {
    if store.poisoned {
        return Err(Error::RecoveryRequired);
    }
    let (id, generation): (String, i64) =
        store
            .conn
            .query_row("SELECT store_id,generation FROM metadata", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
    if id != lease.store_id
        || lease.entry.lease_generation != Some(generation)
        || lease.kind() != WorkKind::Advance
    {
        return Err(Error::Denied("STALE_QUEUE_LEASE"));
    }
    let entry = load(&store.conn, lease.task_id())?.ok_or(Error::RecoveryRequired)?;
    if entry.fence != lease.fence() || entry.contract_hash != lease.contract_hash() {
        return Err(Error::Denied("STALE_QUEUE_LEASE"));
    }
    Ok(())
}
impl Store {
    /// A read-only cooperative stop check. Expiry invalidates work but is not
    /// proof that an OS process stopped, so this does not release its ownership.
    pub fn check_work_lease(&self, lease: &WorkLease) -> Result<()> {
        alive(self, lease, self.tick()?)?;
        Ok(())
    }
    /// Private-host observation, not a public credential or permission endpoint.
    /// The PID is audit metadata only: never resolve/kill a process by this record.
    pub fn note_probe_process(&mut self, lease: &WorkLease, pid: u32, reaped: bool) -> Result<()> {
        if pid == 0 {
            return Err(Error::Invalid("PROBE_PID_INVALID"));
        }
        context(self, lease)?;
        let key = process_key(lease, pid)?;
        let started: i64 = self.conn.query_row(
            "SELECT count(*) FROM events WHERE aggregate_id=?1 AND kind='worker.probe_started'",
            [&key],
            |r| r.get(0),
        )?;
        let ended: i64 = self.conn.query_row(
            "SELECT count(*) FROM events WHERE aggregate_id=?1 AND kind='worker.probe_reaped'",
            [&key],
            |r| r.get(0),
        )?;
        if started > 1 || ended > 1 || ended > started {
            return Err(Error::RecoveryRequired);
        }
        if reaped {
            if started != 1 {
                return Err(Error::Denied("PROBE_START_NOT_RECORDED"));
            }
            if ended == 1 {
                return Ok(());
            }
        } else {
            self.check_work_lease(lease)?;
            if started != 0 {
                return Err(Error::Denied("PROBE_START_REUSED"));
            }
            let actions: i64 = self.conn.query_row(
                "SELECT count(*) FROM actions WHERE task_id=?1",
                [lease.task_id()],
                |r| r.get(0),
            )?;
            if actions != 0 {
                return Err(Error::Denied("PROBE_HAS_ACTION_HISTORY"));
            }
        }
        self.transact(if reaped {"probe_reaped"} else {"probe_spawn"},|tx|event(tx,&key,
            if reaped {"worker.probe_reaped"} else {"worker.probe_started"},
            &json!({"format":1,"task_id":lease.task_id(),"queue_fence":lease.fence(),"generation":lease.entry.lease_generation,"pid":pid,"reaped":reaped,"source":"trusted_host_owned_child","tool_authority":false})))
    }
    /// Retire an exact, stopped fixed-probe assignment, including expired ones.
    /// Caller MUST first kill/wait its owned child and record that observation.
    /// No reaping assertion is accepted from a model, PID file or worker message.
    /// `Some` yields after graceful host shutdown; `None` parks faulty work.
    pub fn retire_stopped_probe(
        &mut self,
        lease: &WorkLease,
        pid: u32,
        retry_at_ms: Option<i64>,
    ) -> Result<()> {
        context(self, lease)?;
        if let Some(at) = retry_at_ms {
            counter(at)?;
        }
        let key = process_key(lease, pid)?;
        let reaped: i64 = self.conn.query_row(
            "SELECT count(*) FROM events WHERE aggregate_id=?1 AND kind='worker.probe_reaped'",
            [&key],
            |r| r.get(0),
        )?;
        if reaped != 1 {
            return Err(Error::Denied("PROBE_REAP_NOT_RECORDED"));
        }
        let current = snapshot(&self.conn, lease.task_id())?;
        if number(&current, "cancel_epoch")? > 0 {
            return Ok(());
        }
        // Intentionally ignore only deadline, never owner/generation/fence. This
        // is explicit stop/reap recovery, not expiry-based live lease stealing.
        let entry = alive(self, lease, 0)?;
        let run = lease
            .run()
            .ok_or(Error::Denied("OBSERVATION_ONLY_ASSIGNMENT"))?;
        let valid:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?1 AND r.active=1 AND r.generation=?2 AND r.fence=?3 AND r.fence=t.fence AND t.cancel_epoch=0 AND t.execution='RUNNING')",params![run.run_id,run.generation,run.fence],|r|r.get(0))?;
        if !valid || entry.run_id != Some(run.run_id) {
            return Err(Error::Denied("STALE_QUEUE_LEASE"));
        }
        let actions: i64 = self.conn.query_row(
            "SELECT count(*) FROM actions WHERE task_id=?1",
            [lease.task_id()],
            |r| r.get(0),
        )?;
        if actions != 0 {
            return Err(Error::Denied("PROBE_HAS_ACTION_HISTORY"));
        }
        self.transact("probe_retire",|tx| {
            tx.execute("UPDATE runs SET active=0 WHERE id=?1",[run.run_id])?;
            tx.execute("UPDATE grants SET revoked=1 WHERE run_id=?1",[run.run_id])?;
            let mut value=snapshot(tx,lease.task_id())?;
            value["execution_status"]=json!(if retry_at_ms.is_some(){"READY"}else{"STOPPED"});
            let value=save_task(tx,value,"task.probe_process_retired")?;
            if let Some(at)=retry_at_ms {
                let mut entry=load(tx,lease.task_id())?.ok_or(Error::RecoveryRequired)?;
                entry.run_after_ms=at; save(tx,entry)?;
            } else {crate::enqueue(tx,&value,"stopped")?;}
            event(tx,&key,"worker.probe_retired",&json!({"format":1,"task_id":lease.task_id(),"pid":pid,"queue_fence":lease.fence(),"reaped":true,"retry_at_ms":retry_at_ms,"task_success":false}))
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, Store, WorkLease) {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("tp7-{:x}", u128::from_le_bytes(random)));
        let mut store = Store::open(&root).unwrap();
        let contract=tada_contracts::decode(&json!({"task_id":"process-test","contract_version":1,"goal":"fixed probe","inputs":[],"deliverables":[],"acceptance":["unmet"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]})).unwrap();
        store.create_task(&contract, 0).unwrap();
        let lease = store
            .claim_work("host", 0, Duration::from_secs(1))
            .unwrap()
            .unwrap();
        (root, store, lease)
    }
    #[test]
    fn expiry_alone_cannot_retire_or_reassign_a_worker() {
        let (root, mut store, lease) = fixture();
        store.note_probe_process(&lease, 123, true).unwrap_err();
        store.note_probe_process(&lease, 123, false).unwrap();
        store.clock = std::time::Instant::now()
            .checked_sub(Duration::from_secs(5))
            .unwrap();
        assert!(store.check_work_lease(&lease).is_err());
        assert!(store.retire_stopped_probe(&lease, 123, Some(0)).is_err());
        assert!(store
            .claim_work("other", 10000, Duration::from_secs(5))
            .unwrap()
            .is_none());
        store.note_probe_process(&lease, 123, true).unwrap();
        store.retire_stopped_probe(&lease, 123, Some(100)).unwrap();
        let next = store
            .claim_work("other", 100, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(next.fence() > lease.fence());
        assert!(store.retire_stopped_probe(&lease, 123, None).is_err());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reap_keeps_cancelled_state_and_is_idempotent() {
        let (root, mut store, lease) = fixture();
        store.note_probe_process(&lease, 123, false).unwrap();
        store.cancel(lease.task_id()).unwrap();
        let before = snapshot(&store.conn, lease.task_id()).unwrap();
        store.note_probe_process(&lease, 123, true).unwrap();
        store.note_probe_process(&lease, 123, true).unwrap();
        store.retire_stopped_probe(&lease, 123, Some(0)).unwrap();
        assert_eq!(snapshot(&store.conn, lease.task_id()).unwrap(), before);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_worker_parks_without_clearing_acceptance_or_reviving_after_reopen() {
        let (root, mut store, lease) = fixture();
        store.note_probe_process(&lease, 123, false).unwrap();
        assert!(store.retire_stopped_probe(&lease, 456, None).is_err());
        store.note_probe_process(&lease, 123, true).unwrap();
        store.retire_stopped_probe(&lease, 123, None).unwrap();
        let before = snapshot(&store.conn, lease.task_id()).unwrap();
        assert_eq!(before["execution_status"], "STOPPED");
        assert_eq!(before["completion_status"], "PENDING");
        assert_eq!(before["unmet_required_criteria"], json!(["unmet"]));
        drop(store);
        let mut store = Store::open(&root).unwrap();
        assert!(store
            .claim_work("host", 10000, Duration::from_secs(5))
            .unwrap()
            .is_none());
        assert!(store.note_probe_process(&lease, 123, true).is_err());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
