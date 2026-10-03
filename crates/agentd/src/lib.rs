//! CORE-06 cooperative supervisor. Default one live assignment; no model/tool
//! worker is launched implicitly. The probe is an opt-in deterministic fixture.
//! Production task-process containment and scheduling policy are later gates.
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tada_store::{
    priority::{AdmissionGate, Priority},
    queue::WorkLease,
    Error, Store,
};

type Result<T> = std::result::Result<T, Error>;
pub struct Supervisor {
    store: Arc<Mutex<Store>>,
    gate: Arc<AdmissionGate>,
    owner: String,
    max_active: usize,
    stopped: AtomicBool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    Idle,
    Checkpointed { task_id: String, checkpoint: String },
    Discarded { task_id: String },
    ObservationRequired { task_id: String },
}
impl Supervisor {
    pub fn new(store: Arc<Mutex<Store>>, owner: String, max_active: usize) -> Result<Self> {
        if !(1..=3).contains(&max_active)
            || owner.is_empty()
            || owner.len() > 128
            || !owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        {
            return Err(Error::Invalid("SUPERVISOR_LIMITS"));
        }
        let gate = store
            .lock()
            .map_err(|_| Error::RecoveryRequired)?
            .admission_gate();
        Ok(Self {
            store,
            gate,
            owner,
            max_active,
            stopped: AtomicBool::new(false),
        })
    }
    /// Blocking admission method; invoke from a blocking host thread, not while
    /// holding the store mutex. Stop and claim have one ordered gate boundary.
    pub fn claim(&self, now_ms: i64) -> Result<Option<WorkLease>> {
        let _permit = self.gate.enter(Priority::Ordinary)?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(Error::Denied("SUPERVISOR_STOPPED"));
        }
        let mut store = self.store.lock().map_err(|_| Error::RecoveryRequired)?;
        if store.leased_work_count()? >= self.max_active {
            return Ok(None);
        }
        store.claim_work(&self.owner, now_ms, Duration::from_secs(60))
    }
    pub fn stop_admission(&self) -> Result<()> {
        let _permit = self.gate.enter(Priority::Cancellation)?;
        self.stopped.store(true, Ordering::Release);
        Ok(())
    }
    /// Acknowledged stop prevents further claims, not completion of work already
    /// admitted. Caller must stop its worker before yielding this assignment.
    pub fn defer_stopped_worker(&self, lease: &WorkLease, run_after_ms: i64) -> Result<()> {
        let _permit = self.gate.enter(Priority::Ordinary)?;
        self.store
            .lock()
            .map_err(|_| Error::RecoveryRequired)?
            .defer_work(lease, run_after_ms)
    }
    pub fn finish_probe(&self, lease: &WorkLease, observed_hash: &str) -> Result<String> {
        let _permit = self.gate.enter(Priority::Ordinary)?;
        self.store
            .lock()
            .map_err(|_| Error::RecoveryRequired)?
            .finish_probe(lease, observed_hash)
    }
    /// Run one fixed input-hash probe outside the store mutex. This proves safe
    /// assignment/checkpoint lifecycle, not fulfillment of the user's task goal.
    pub fn probe_once(&self, now_ms: i64) -> Result<ProbeOutcome> {
        let Some(lease) = self.claim(now_ms)? else {
            return Ok(ProbeOutcome::Idle);
        };
        if lease.kind() == tada_store::queue::WorkKind::Reconcile {
            // Never substitute a probe for external observation or start a run.
            self.defer_stopped_worker(
                &lease,
                now_ms
                    .checked_add(1000)
                    .ok_or(Error::Invalid("UTC_CLOCK_RANGE"))?,
            )?;
            return Ok(ProbeOutcome::ObservationRequired {
                task_id: lease.task_id().into(),
            });
        }
        let contract = {
            let _permit = self.gate.enter(Priority::Ordinary)?;
            self.store
                .lock()
                .map_err(|_| Error::RecoveryRequired)?
                .work_contract(&lease)?
        };
        let value = tada_contracts::encode(&contract).map_err(|_| Error::RecoveryRequired)?;
        let bytes = serde_json::to_vec(&value).map_err(|_| Error::RecoveryRequired)?;
        let observed = format!("{:x}", Sha256::digest(&bytes));
        match self.finish_probe(&lease, &observed) {
            Ok(checkpoint) => Ok(ProbeOutcome::Checkpointed {
                task_id: lease.task_id().into(),
                checkpoint,
            }),
            Err(Error::Denied("STALE_QUEUE_LEASE" | "TASK_CANCELLED")) => {
                Ok(ProbeOutcome::Discarded {
                    task_id: lease.task_id().into(),
                })
            }
            Err(error) => Err(error),
        }
    }
    /// The current target is the independent local mock only. Reads still have
    /// real failure semantics; an unavailable observation retains uncertainty.
    pub fn reconcile_mock(
        &self,
        lease: &WorkLease,
        service: &tada_store::mock::MockService,
        retry_at_ms: i64,
    ) -> Result<()> {
        let _permit = self.gate.enter(Priority::Reconciliation)?;
        self.store
            .lock()
            .map_err(|_| Error::RecoveryRequired)?
            .reconcile_work_mock(lease, service, retry_at_ms)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (std::path::PathBuf, Arc<Mutex<Store>>) {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!("ts6-{:x}", u128::from_le_bytes(random)));
        let mut store = Store::open(&path).unwrap();
        for id in ["first", "second"] {
            let c=tada_contracts::decode(&json!({"task_id":id,"contract_version":1,"goal":"supervisor fixture","inputs":[],"deliverables":[],"acceptance":["not-yet-published"],"external_effects":[],"budget":{"max_model_turns":1},"policy_profile_id":"mock-test","on_budget_exhaustion":"save_and_request_decision","assumptions":[]})).unwrap();
            store.create_task(&c, 0).unwrap();
        }
        (path, Arc::new(Mutex::new(store)))
    }
    #[test]
    fn concurrency_bound_and_stop_preserve_existing_assignments_without_cancelling_tasks() {
        let (path, store) = fixture();
        let supervisor = Supervisor::new(Arc::clone(&store), "supervisor".into(), 1).unwrap();
        let lease = supervisor.claim(0).unwrap().unwrap();
        assert!(supervisor.claim(0).unwrap().is_none());
        supervisor.stop_admission().unwrap();
        assert!(supervisor.claim(0).is_err());
        supervisor.defer_stopped_worker(&lease, 5000).unwrap();
        assert_eq!(
            store
                .lock()
                .unwrap()
                .work_entry("first")
                .unwrap()
                .run_after_ms,
            5000
        );
        assert_eq!(
            store.lock().unwrap().task("first").unwrap().cancel_epoch,
            tada_contracts::SafeInteger::new(0).unwrap()
        );
        drop(supervisor);
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn deterministic_worker_checkpoints_units_without_reporting_user_task_success() {
        let (path, store) = fixture();
        let supervisor = Supervisor::new(Arc::clone(&store), "supervisor".into(), 1).unwrap();
        for id in ["first", "second"] {
            assert!(
                matches!(supervisor.probe_once(0).unwrap(),ProbeOutcome::Checkpointed{task_id,..} if task_id==id)
            );
            assert_eq!(
                store.lock().unwrap().task(id).unwrap().completion_status,
                tada_contracts::CompletionStatus::Pending
            );
        }
        assert_eq!(supervisor.probe_once(0).unwrap(), ProbeOutcome::Idle);
        drop(supervisor);
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn cancellation_queued_ahead_of_worker_completion_discards_late_result() {
        let (path, store) = fixture();
        let supervisor =
            Arc::new(Supervisor::new(Arc::clone(&store), "supervisor".into(), 1).unwrap());
        let lease = supervisor.claim(0).unwrap().unwrap();
        let gate = store.lock().unwrap().admission_gate();
        let owner = gate.enter(Priority::Ordinary).unwrap();
        let cancel = gate.register(Priority::Cancellation).unwrap();
        let worker = Arc::clone(&supervisor);
        let handle = std::thread::spawn(move || worker.finish_probe(&lease, lease.contract_hash()));
        drop(owner);
        let permit = cancel.wait().unwrap();
        store.lock().unwrap().cancel("first").unwrap();
        drop(permit);
        assert!(matches!(
            handle.join().unwrap(),
            Err(Error::Denied("STALE_QUEUE_LEASE"))
        ));
        drop(supervisor);
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }
}

pub mod foreground;
mod process_runner;
mod process_scope;
pub mod worker_wire;

pub mod engine_pipe;
