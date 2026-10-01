//! CORE-02: a durable, mock-only effect ledger, not a production authority broker.
//! There is intentionally no shell, network transport, provider login or public IPC.

use rusqlite::{params, Connection, OpenFlags, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    path::Path,
    time::{Duration, Instant},
};
use tada_contracts::{ActionRecord, SafeInteger, TaskContract, TaskSnapshot};

pub mod mock;
use mock::{MockMode, MockPayload, MockService, Receipt};

const SCHEMA: &str = include_str!("schema.sql");
const WITNESS_SCHEMA: &str = "CREATE TABLE identity(id TEXT PRIMARY KEY) STRICT;
CREATE TABLE journal(seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, event_digest TEXT NOT NULL, aggregates TEXT NOT NULL CHECK(json_valid(aggregates))) STRICT;
CREATE TRIGGER no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'immutable witness'); END;
CREATE TRIGGER no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'immutable witness'); END;
PRAGMA user_version=1;";

type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Denied(&'static str),
    Invalid(&'static str),
    RecoveryRequired,
    AlreadyOpen,
    Sql(rusqlite::Error),
    Io(std::io::Error),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never echo SQL parameters, payloads, paths or arbitrary instance data.
        f.write_str(match self {
            Self::Denied(code) | Self::Invalid(code) => code,
            Self::RecoveryRequired => "READ_ONLY_RECOVERY_REQUIRED",
            Self::AlreadyOpen => "DAEMON_ALREADY_OPEN",
            Self::Sql(_) => "DATABASE_IO_FAILED",
            Self::Io(_) => "FILESYSTEM_IO_FAILED",
        })
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::Invalid("INVALID_JSON")
    }
}

/// Opaque admission reference. Possession alone is never sufficient authority.
#[derive(Debug, Clone)]
pub struct Lease {
    task_id: String,
    run_id: i64,
    generation: i64,
    fence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub key: String,
    pub task_id: String,
    pub task_version: i64,
    pub kind: String,
}

pub struct Store {
    conn: Connection,
    witness: Connection,
    // Never unlink a held lock: that would permit locking a replacement inode.
    _lock: File,
    clock: Instant,
    poisoned: bool,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn checked(name: &str, value: &Value) -> Result<()> {
    tada_contracts::validate(name, value).map_err(|_| Error::Invalid("INVALID_CONTRACT"))
}
fn counter(value: i64) -> Result<i64> {
    u64::try_from(value)
        .ok()
        .and_then(SafeInteger::new)
        .map(|_| value)
        .ok_or(Error::Invalid("COUNTER_OVERFLOW"))
}
fn increment(value: i64) -> Result<i64> {
    counter(
        value
            .checked_add(1)
            .ok_or(Error::Invalid("COUNTER_OVERFLOW"))?,
    )
}
fn number(value: &Value, key: &str) -> Result<i64> {
    counter(value[key].as_i64().ok_or(Error::RecoveryRequired)?)
        .map_err(|_| Error::RecoveryRequired)
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(Error::RecoveryRequired)
}
fn parse(raw: String) -> Result<Value> {
    serde_json::from_str(&raw).map_err(|_| Error::RecoveryRequired)
}
fn snapshot(conn: &Connection, id: &str) -> Result<Value> {
    parse(conn.query_row("SELECT snapshot FROM tasks WHERE id=?1", [id], |r| r.get(0))?)
}
fn action(conn: &Connection, id: &str) -> Result<Value> {
    parse(conn.query_row("SELECT record FROM actions WHERE id=?1", [id], |r| r.get(0))?)
}
fn ids(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare(sql)?;
    let values = statement
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(values)
}
fn event(tx: &Transaction<'_>, id: &str, kind: &str, payload: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO events(aggregate_id,kind,payload) VALUES(?1,?2,?3)",
        params![id, kind, payload.to_string()],
    )?;
    Ok(())
}
fn save_task(tx: &Transaction<'_>, mut value: Value, kind: &str) -> Result<Value> {
    let version = number(&value, "version")?;
    value["version"] = json!(increment(version)?);
    checked("TaskSnapshot", &value)?;
    if tx.execute(
        "UPDATE tasks SET snapshot=?1 WHERE id=?2 AND version=?3",
        params![value.to_string(), text(&value, "task_id")?, version],
    )? != 1
    {
        return Err(Error::Denied("TASK_CAS_CONFLICT"));
    }
    event(tx, text(&value, "task_id")?, kind, &value)?;
    Ok(value)
}
fn save_action(tx: &Transaction<'_>, mut value: Value, state: &str, kind: &str) -> Result<Value> {
    let before = action(tx, text(&value, "action_id")?)?;
    let from: tada_contracts::ActionState = serde_json::from_value(before["state"].clone())?;
    let to: tada_contracts::ActionState = serde_json::from_value(json!(state))?;
    if from != to && !tada_contracts::is_action_transition_allowed(from, to) {
        return Err(Error::Denied("INVALID_ACTION_TRANSITION"));
    }
    let version = number(&value, "version")?;
    value["state"] = json!(state);
    value["version"] = json!(increment(version)?);
    checked("ActionRecord", &value)?;
    if tx.execute(
        "UPDATE actions SET record=?1 WHERE id=?2 AND version=?3",
        params![value.to_string(), text(&value, "action_id")?, version],
    )? != 1
    {
        return Err(Error::Denied("ACTION_CAS_CONFLICT"));
    }
    event(tx, text(&value, "action_id")?, kind, &value)?;
    Ok(value)
}
fn refresh_task(tx: &Transaction<'_>, id: &str, stop: bool) -> Result<Value> {
    let mut value = snapshot(tx, id)?;
    let before = value.clone();
    let mut statement = tx.prepare("SELECT id FROM actions WHERE task_id=?1 AND json_extract(record,'$.side_effect_state')='uncertain' ORDER BY id")?;
    let unresolved = statement
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let awaiting: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE task_id=?1 AND state='ACKNOWLEDGED' AND json_extract(record,'$.acceptance_status')='pending')",[id],|r|r.get(0))?;
    value["unresolved_effects"] = json!(unresolved);
    value["completion_status"] = json!(if unresolved.is_empty() {
        "PENDING"
    } else {
        "OUTCOME_UNKNOWN"
    });
    value
        .as_object_mut()
        .ok_or(Error::RecoveryRequired)?
        .remove("wait");
    if number(&value, "cancel_epoch")? > 0 {
        value["execution_status"] = json!("CANCELLED");
    } else if !unresolved.is_empty() || awaiting {
        value["execution_status"] = json!("WAITING");
        value["wait"] = json!({"reason":"EXTERNAL_RESULT","wake_event":"mock.reconciliation"});
    } else if stop {
        value["execution_status"] = json!("STOPPED");
    } else if value["execution_status"] == "WAITING" {
        value["execution_status"] = json!("READY");
    }
    let value = if value == before {
        value
    } else {
        save_task(tx, value, "task.effect_observed")?
    };
    if stop {
        let kind = if !unresolved.is_empty() {
            "decision_required"
        } else {
            "stopped"
        };
        enqueue(tx, &value, kind)?;
    }
    Ok(value)
}
fn enqueue(tx: &Transaction<'_>, value: &Value, kind: &str) -> Result<()> {
    let id = text(value, "task_id")?;
    let version = number(value, "version")?;
    let key = format!("{id}:{version}:{kind}");
    tx.execute("INSERT INTO outbox(key,task_id,task_version,kind) VALUES(?1,?2,?3,?4) ON CONFLICT(key) DO NOTHING", params![key,id,version,kind])?;
    Ok(())
}
fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(2))?;
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    )?;
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    let sync: i64 = conn.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
    if mode != "wal" || sync != 2 {
        return Err(Error::RecoveryRequired);
    }
    Ok(())
}
fn healthy_database(conn: &Connection) -> Result<()> {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let fk_problem = conn
        .prepare("PRAGMA foreign_key_check")?
        .query([])?
        .next()?
        .is_some();
    if integrity != "ok" || version != 1 || fk_problem {
        return Err(Error::RecoveryRequired);
    }
    Ok(())
}

impl Store {
    /// Use a dedicated trusted local directory, never a network filesystem.
    /// Every open creates a new supervisor generation; no prior lease survives.
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        for name in ["state.sqlite", "witness.sqlite", "owner.lock"] {
            if fs::symlink_metadata(root.join(name)).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(Error::RecoveryRequired);
            }
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("owner.lock"))?;
        match lock.try_lock() {
            Ok(()) => (),
            Err(std::fs::TryLockError::WouldBlock) => return Err(Error::AlreadyOpen),
            Err(std::fs::TryLockError::Error(e)) => return Err(Error::Io(e)),
        }
        let exists = root.join("state.sqlite").exists();
        if exists != root.join("witness.sqlite").exists() {
            return Err(Error::RecoveryRequired);
        }
        let conn = Connection::open(root.join("state.sqlite"))?;
        let witness = Connection::open(root.join("witness.sqlite"))?;
        configure(&conn)?;
        configure(&witness)?;
        if !exists {
            let store_id: String =
                conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
            conn.execute_batch("BEGIN IMMEDIATE")?;
            conn.execute_batch(SCHEMA)?;
            conn.execute(
                "INSERT INTO metadata VALUES(1,?1,?2,0,0,1,0)",
                params![store_id, digest(SCHEMA.as_bytes())],
            )?;
            conn.execute_batch("COMMIT")?;
            witness.execute_batch("BEGIN IMMEDIATE")?;
            witness.execute_batch(WITNESS_SCHEMA)?;
            witness.execute("INSERT INTO identity VALUES(?1)", [store_id])?;
            witness.execute_batch("COMMIT")?;
        }
        let mut store = Self {
            conn,
            witness,
            _lock: lock,
            clock: Instant::now(),
            poisoned: false,
        };
        store.audit()?;
        store.recover()?;
        Ok(store)
    }

    fn audit(&self) -> Result<()> {
        healthy_database(&self.conn)?;
        healthy_database(&self.witness)?;
        let (id, hash, seq): (String, String, i64) = self.conn.query_row(
            "SELECT store_id,schema_hash,witness_seq FROM metadata",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let other: String = self
            .witness
            .query_row("SELECT id FROM identity", [], |r| r.get(0))?;
        let tip: i64 =
            self.witness
                .query_row("SELECT coalesce(max(seq),0) FROM journal", [], |r| r.get(0))?;
        if id != other || hash != digest(SCHEMA.as_bytes()) || seq != tip {
            return Err(Error::RecoveryRequired);
        }
        for id in ids(&self.conn, "SELECT id FROM tasks")? {
            let value = snapshot(&self.conn, &id)?;
            checked("TaskSnapshot", &value).map_err(|_| Error::RecoveryRequired)?;
            let contract: String =
                self.conn
                    .query_row("SELECT contract FROM tasks WHERE id=?1", [&id], |r| {
                        r.get(0)
                    })?;
            checked("TaskContract", &parse(contract)?).map_err(|_| Error::RecoveryRequired)?;
            self.audit_tail(&id, "task.%", &value)?;
        }
        for id in ids(&self.conn, "SELECT id FROM actions")? {
            let value = action(&self.conn, &id)?;
            checked("ActionRecord", &value).map_err(|_| Error::RecoveryRequired)?;
            self.audit_tail(&id, "action.%", &value)?;
            let (hash, bytes): (String,Vec<u8>) = self.conn.query_row("SELECT p.hash,p.content FROM actions a JOIN payloads p ON p.hash=a.payload_hash WHERE a.id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?)))?;
            if hash != digest(&bytes) || value["payload_ref"] != format!("blob://sha256/{hash}") {
                return Err(Error::RecoveryRequired);
            }
        }
        Ok(())
    }
    fn audit_tail(&self, id: &str, pattern: &str, value: &Value) -> Result<()> {
        let raw: String = self.conn.query_row("SELECT payload FROM events WHERE aggregate_id=?1 AND kind LIKE ?2 ORDER BY seq DESC LIMIT 1",params![id,pattern],|r|r.get(0))?;
        if parse(raw)? != *value {
            return Err(Error::RecoveryRequired);
        }
        Ok(())
    }

    /// The witness commits before the state transaction. A crash in that gap is
    /// deliberately quarantined, not guessed away. Business denials run before
    /// either commit. A storage failure poisons this handle until audited reopen.
    fn transact<T>(
        &mut self,
        kind: &str,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T>,
    ) -> Result<T> {
        if self.poisoned {
            return Err(Error::RecoveryRequired);
        }
        let outcome = (|| {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let first: i64 =
                tx.query_row("SELECT coalesce(max(seq),0) FROM events", [], |r| r.get(0))?;
            let result = operation(&tx)?;
            let old: i64 = tx.query_row("SELECT witness_seq FROM metadata", [], |r| r.get(0))?;
            let seq = increment(old)?;
            let aggregates = {
                let mut s =
                    tx.prepare("SELECT aggregate_id,kind FROM events WHERE seq>?1 ORDER BY seq")?;
                let rows = s
                    .query_map([first], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            let summary = serde_json::to_string(&aggregates)?;
            tx.execute("UPDATE metadata SET witness_seq=?1", [seq])?;
            self.witness.execute(
                "INSERT INTO journal(seq,kind,event_digest,aggregates) VALUES(?1,?2,?3,?4)",
                params![seq, kind, digest(summary.as_bytes()), summary],
            )?;
            checkpoint(&format!("{kind}.witness"));
            tx.commit()?;
            checkpoint(&format!("{kind}.commit"));
            Ok(result)
        })();
        if matches!(
            &outcome,
            Err(Error::Sql(_) | Error::Io(_) | Error::RecoveryRequired)
        ) {
            self.poisoned = true;
        }
        outcome
    }

    fn recover(&mut self) -> Result<()> {
        self.transact("recovery", |tx| {
            let generation: i64 =
                tx.query_row("SELECT generation FROM metadata", [], |r| r.get(0))?;
            tx.execute(
                "UPDATE metadata SET generation=?1",
                [increment(generation)?],
            )?;
            tx.execute("UPDATE runs SET active=0 WHERE active=1", [])?;
            tx.execute("UPDATE grants SET revoked=1 WHERE revoked=0", [])?;
            tx.execute(
                "UPDATE reservations SET status='uncertain' WHERE status='reserved'",
                [],
            )?;
            for id in ids(
                tx,
                "SELECT id FROM actions WHERE state IN ('AUTHORIZED','PREPARED','DISPATCHING')",
            )? {
                let mut value = action(tx, &id)?;
                if value["state"] == "DISPATCHING" {
                    value["side_effect_state"] = json!("uncertain");
                    value["reconciliation_verdict"] = json!("UNCERTAIN");
                    value["acceptance_status"] = json!("inconclusive");
                    save_action(tx, value, "UNCERTAIN", "action.recovered_uncertain")?;
                } else {
                    save_action(tx, value, "REJECTED", "action.expired_before_dispatch")?;
                }
            }
            for id in ids(
                tx,
                "SELECT id FROM tasks WHERE execution IN ('RUNNING','WAITING','CANCELLING')",
            )? {
                let mut value = snapshot(tx, &id)?;
                if value["execution_status"] == "RUNNING" {
                    value["execution_status"] = json!("READY");
                    value
                        .as_object_mut()
                        .ok_or(Error::RecoveryRequired)?
                        .remove("wait");
                    save_task(tx, value, "task.recovered")?;
                }
                let value = refresh_task(tx, &id, false)?;
                if value["completion_status"] == "OUTCOME_UNKNOWN" {
                    enqueue(tx, &value, "decision_required")?;
                }
            }
            event(
                tx,
                "supervisor",
                "supervisor.recovered",
                &json!({"generation":generation+1}),
            )?;
            Ok(())
        })
    }

    pub fn create_task(&mut self, contract: &TaskContract, budget_micro_usd: i64) -> Result<()> {
        counter(budget_micro_usd)?;
        let contract =
            tada_contracts::encode(contract).map_err(|_| Error::Invalid("INVALID_CONTRACT"))?;
        let id = text(&contract, "task_id")?.to_owned();
        // Only the fixed in-process mock adapter exists. A budget value here is
        // a fake ledger cap, not a dollar guarantee for any real model route.
        self.transact("create_task",|tx| {
            let value = json!({"schema_version":1,"task_id":id,"version":1,"execution_status":"READY","completion_status":"PENDING","cancel_epoch":0,"unresolved_effects":[],"unmet_required_criteria":contract["acceptance"]});
            checked("TaskSnapshot",&value)?;
            tx.execute("INSERT INTO tasks(id,contract,snapshot,budget_micro_usd) VALUES(?1,?2,?3,?4)",params![id,contract.to_string(),value.to_string(),budget_micro_usd])?;
            event(tx,&id,"task.created",&value)
        })
    }

    pub fn start_run(&mut self, id: &str, ttl: Duration) -> Result<Lease> {
        let tick = self.tick()?;
        let duration =
            i64::try_from(ttl.as_millis()).map_err(|_| Error::Invalid("LEASE_DURATION"))?;
        if duration == 0 {
            return Err(Error::Invalid("LEASE_DURATION"));
        }
        let until = counter(
            tick.checked_add(duration)
                .ok_or(Error::Invalid("LEASE_DURATION"))?,
        )?;
        self.transact("start_run",|tx| {
            let mut value = snapshot(tx,id)?;
            if number(&value,"cancel_epoch")? != 0 || value["execution_status"] != "READY" {
                return Err(Error::Denied("TASK_NOT_READY"));
            }
            let unresolved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE task_id=?1 AND state IN ('DISPATCHING','UNCERTAIN','ACKNOWLEDGED'))",[id],|r|r.get(0))?;
            if unresolved { return Err(Error::Denied("RECONCILIATION_REQUIRED")); }
            let previous: i64 = tx.query_row("SELECT fence FROM tasks WHERE id=?1",[id],|r|r.get(0))?;
            let fence = increment(previous)?;
            let generation: i64 = tx.query_row("SELECT generation FROM metadata",[],|r|r.get(0))?;
            tx.execute("UPDATE tasks SET fence=?1 WHERE id=?2",params![fence,id])?;
            tx.execute("INSERT INTO runs(task_id,generation,fence,expires_tick,active) VALUES(?1,?2,?3,?4,1)",params![id,generation,fence,until])?;
            let run_id = tx.last_insert_rowid();
            value["execution_status"] = json!("RUNNING");
            save_task(tx,value,"task.run_started")?;
            Ok(Lease{ task_id:id.to_owned(),run_id,generation,fence })
        })
    }
    fn tick(&self) -> Result<i64> {
        i64::try_from(self.clock.elapsed().as_millis()).map_err(|_| Error::RecoveryRequired)
    }

    pub fn propose_mock(&mut self, id: &str, lease: &Lease, payload: &MockPayload) -> Result<()> {
        payload.validate()?;
        let bytes = serde_json::to_vec(payload)?;
        let hash = digest(&bytes);
        let tick = self.tick()?;
        self.transact("propose",|tx| {
            admit_lease(tx,lease,tick)?;
            scope(tx,&lease.task_id,&payload.target)?;
            let revision: i64 = tx.query_row("SELECT policy_revision FROM metadata",[],|r|r.get(0))?;
            let epoch = number(&snapshot(tx,&lease.task_id)?,"cancel_epoch")?;
            let value = json!({"schema_version":1,"action_id":id,"task_id":lease.task_id,"version":1,"state":"PROPOSED","effect":"external_write","intent_hash":hash,"payload_ref":format!("blob://sha256/{hash}"),"method":"mock.apply","endpoint":"mock://ledger","account_ref":"mock-account","target":payload.target,"policy_revision":revision,"cancel_epoch":epoch,"precondition_version":1,"verifier_version":"mock-ledger-v1","side_effect_state":"none","reconciliation_verdict":"NOT_OBSERVED","acceptance_status":"pending","evidence_refs":[]});
            checked("ActionRecord",&value)?;
            tx.execute("INSERT OR IGNORE INTO payloads(hash,content) VALUES(?1,?2)",params![hash,bytes])?;
            tx.execute("INSERT INTO actions(id,task_id,payload_hash,record) VALUES(?1,?2,?3,?4)",params![id,lease.task_id,hash,value.to_string()])?;
            event(tx,id,"action.proposed",&value)
        })
    }

    pub fn prepare_mock(&mut self, id: &str, lease: &Lease) -> Result<()> {
        let tick = self.tick()?;
        self.transact("prepare", |tx| {
            admit_lease(tx, lease, tick)?;
            let mut value = action(tx, id)?;
            if value["state"] != "PROPOSED" || value["task_id"] != lease.task_id {
                return Err(Error::Denied("ACTION_NOT_PROPOSED"));
            }
            scope(tx, &lease.task_id, text(&value, "target")?)?;
            let (revision, denied): (i64, bool) =
                tx.query_row("SELECT policy_revision,denied FROM metadata", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            if denied {
                return Err(Error::Denied("POLICY_DENIED"));
            }
            value["policy_revision"] = json!(revision);
            value["fencing_token"] = json!(lease.fence);
            let value = save_action(tx, value, "AUTHORIZED", "action.authorized")?;
            tx.execute(
                "INSERT INTO grants VALUES(?1,?2,?3,?4,?5,0)",
                params![
                    id,
                    lease.run_id,
                    revision,
                    number(&value, "cancel_epoch")?,
                    lease.fence
                ],
            )?;
            save_action(tx, value, "PREPARED", "action.prepared")?;
            Ok(())
        })
    }

    fn admit(&mut self, id: &str, lease: &Lease, reserved: i64) -> Result<Dispatch> {
        counter(reserved)?;
        let tick = self.tick()?;
        self.transact("dispatch",|tx| {
            admit_lease(tx,lease,tick)?;
            let mut value = action(tx,id)?;
            if value["state"] != "PREPARED" || value["task_id"] != lease.task_id { return Err(Error::Denied("ACTION_NOT_PREPARED")); }
            let current = snapshot(tx,&lease.task_id)?;
            let (revision,denied): (i64,bool) = tx.query_row("SELECT policy_revision,denied FROM metadata",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM grants WHERE action_id=?1 AND run_id=?2 AND policy_revision=?3 AND cancel_epoch=?4 AND fence=?5 AND revoked=0)",params![id,lease.run_id,revision,number(&current,"cancel_epoch")?,lease.fence],|r|r.get(0))?;
            if denied || !valid || number(&value,"policy_revision")? != revision || number(&value,"cancel_epoch")? != number(&current,"cancel_epoch")? || number(&value,"fencing_token")? != lease.fence {
                return Err(Error::Denied("STALE_OR_REVOKED_GRANT"));
            }
            scope(tx,&lease.task_id,text(&value,"target")?)?;
            let used = committed_budget(tx,&lease.task_id)?;
            let cap: i64 = tx.query_row("SELECT budget_micro_usd FROM tasks WHERE id=?1",[&lease.task_id],|r|r.get(0))?;
            if used.checked_add(reserved).is_none_or(|n| n > cap) { return Err(Error::Denied("BUDGET_EXHAUSTED")); }
            let bytes: Vec<u8> = tx.query_row("SELECT content FROM payloads WHERE hash=?1",[text(&value,"intent_hash")?],|r|r.get(0))?;
            if digest(&bytes) != text(&value,"intent_hash")? { return Err(Error::RecoveryRequired); }
            let payload: MockPayload = serde_json::from_slice(&bytes)?;
            if payload.target != text(&value,"target")? { return Err(Error::RecoveryRequired); }
            tx.execute("INSERT INTO attempts(action_id,generation,fence,payload_hash) VALUES(?1,?2,?3,?4)",params![id,lease.generation,lease.fence,text(&value,"intent_hash")?])?;
            tx.execute("INSERT INTO reservations VALUES(?1,?2,?3,NULL,'reserved')",params![id,lease.task_id,reserved])?;
            value["side_effect_state"] = json!("uncertain");
            save_action(tx,value,"DISPATCHING","action.dispatch_admitted")?;
            refresh_task(tx,&lease.task_id,false)?;
            Ok(Dispatch{action_id:id.to_owned(),payload,hash:digest(&bytes),reserved})
        })
    }

    /// The mock is deliberately non-idempotent. A duplicate call would append
    /// a second effect; safety must come from admission, not hidden deduplication.
    pub fn dispatch_mock(
        &mut self,
        id: &str,
        lease: &Lease,
        service: &mut MockService,
        mode: MockMode,
        reserved: i64,
    ) -> Result<()> {
        let request = self.admit(id, lease, reserved)?;
        let receipt = service.apply(&request, mode)?;
        checkpoint("external.effect");
        if let Some(receipt) = receipt {
            self.record_receipt(id, &receipt)?;
        } else {
            self.mark_uncertain(id)?;
        }
        Ok(())
    }

    fn record_receipt(&mut self, id: &str, receipt: &Receipt) -> Result<()> {
        self.transact("receipt", |tx| {
            let mut value = action(tx, id)?;
            if !matches!(text(&value, "state")?, "DISPATCHING" | "UNCERTAIN") {
                return Err(Error::Denied("RECEIPT_STATE"));
            }
            bind_receipt(&value, receipt)?;
            tx.execute(
                "INSERT INTO receipts VALUES(?1,?2)",
                params![id, serde_json::to_string(receipt)?],
            )?;
            value["receipt_ref"] = json!(receipt.reference());
            value["side_effect_state"] = json!("confirmed");
            value["reconciliation_verdict"] = json!("NOT_OBSERVED");
            value["acceptance_status"] = json!("pending");
            let value = save_action(tx, value, "ACKNOWLEDGED", "action.receipt_recorded")?;
            settle(tx, id, receipt.charged)?;
            refresh_task(tx, text(&value, "task_id")?, false)?;
            Ok(())
        })
    }
    fn mark_uncertain(&mut self, id: &str) -> Result<()> {
        let current = action(&self.conn, id)?;
        if current["state"] == "UNCERTAIN" {
            return Ok(());
        }
        self.transact("uncertain",|tx| {
            let mut value = action(tx,id)?;
            value["side_effect_state"] = json!("uncertain");
            value["reconciliation_verdict"] = json!("UNCERTAIN");
            value["acceptance_status"] = json!("inconclusive");
            let value = save_action(tx,value,"UNCERTAIN","action.response_lost")?;
            tx.execute("UPDATE reservations SET status='uncertain' WHERE action_id=?1 AND status='reserved'",[id])?;
            let task = refresh_task(tx,text(&value,"task_id")?,false)?;
            enqueue(tx,&task,"decision_required")?;
            Ok(())
        })
    }

    /// Observation is allowed after cancellation. This method never transmits
    /// a new mutation, and absence or ambiguous lookup is not negative proof.
    pub fn reconcile_mock(&mut self, id: &str, service: &MockService) -> Result<()> {
        if self.poisoned {
            return Err(Error::RecoveryRequired);
        }
        let value = action(&self.conn, id)?;
        if value["state"] == "VERIFIED" || value["reconciliation_verdict"] == "APPLIED_MISMATCH" {
            return Ok(());
        }
        if !matches!(
            text(&value, "state")?,
            "DISPATCHING" | "UNCERTAIN" | "ACKNOWLEDGED"
        ) {
            return Err(Error::Denied("NOT_RECONCILABLE"));
        }
        let Some(receipt) = service.observe(id)? else {
            // An earlier receipt is knowledge: do not erase a confirmed effect.
            return if value["state"] == "ACKNOWLEDGED" {
                Ok(())
            } else {
                self.mark_uncertain(id)
            };
        };
        bind_receipt(&value, &receipt)?;
        if value["state"] != "ACKNOWLEDGED" {
            self.record_receipt(id, &receipt)?;
        }
        self.transact("reconcile", |tx| {
            let mut value = action(tx, id)?;
            let bytes: Vec<u8> = tx.query_row(
                "SELECT content FROM payloads WHERE hash=?1",
                [text(&value, "intent_hash")?],
                |r| r.get(0),
            )?;
            let expected: MockPayload = serde_json::from_slice(&bytes)?;
            let matches = expected == receipt.actual;
            value["evidence_refs"] = json!([format!(
                "mock-observation:{}:{}",
                receipt.sequence,
                digest(&serde_json::to_vec(&receipt.actual)?)
            )]);
            value["reconciliation_verdict"] = json!(if matches {
                "CONFIRMED_APPLIED"
            } else {
                "APPLIED_MISMATCH"
            });
            value["acceptance_status"] = json!(if matches { "pass" } else { "fail" });
            let state = if matches { "VERIFIED" } else { "ACKNOWLEDGED" };
            let value = save_action(tx, value, state, "action.reconciled")?;
            refresh_task(tx, text(&value, "task_id")?, true)?;
            tx.execute(
                "UPDATE runs SET active=0 WHERE task_id=?1",
                [text(&value, "task_id")?],
            )?;
            Ok(())
        })
    }

    pub fn cancel(&mut self, id: &str) -> Result<()> {
        let current = snapshot(&self.conn, id)?;
        if number(&current, "cancel_epoch")? > 0 {
            return Ok(());
        }
        self.transact("cancel",|tx| {
            let mut value = snapshot(tx,id)?;
            value["cancel_epoch"] = json!(increment(number(&value,"cancel_epoch")?)?);
            value["execution_status"] = json!("CANCELLED");
            value.as_object_mut().ok_or(Error::RecoveryRequired)?.remove("wait");
            let value = save_task(tx,value,"task.cancelled")?;
            tx.execute("UPDATE grants SET revoked=1 WHERE action_id IN (SELECT id FROM actions WHERE task_id=?1)",[id])?;
            tx.execute("UPDATE runs SET active=0 WHERE task_id=?1",[id])?;
            enqueue(tx,&value,"stopped")?;
            Ok(())
        })
    }

    pub fn revoke_mock_grant(&mut self, id: &str) -> Result<()> {
        self.transact("revoke", |tx| {
            if tx.execute("UPDATE grants SET revoked=1 WHERE action_id=?1", [id])? != 1 {
                return Err(Error::Denied("GRANT_NOT_FOUND"));
            }
            event(tx, id, "grant.revoked", &json!({"revoked":true}))
        })
    }
    pub fn set_mock_policy_denied(&mut self, denied: bool) -> Result<()> {
        self.transact("policy", |tx| {
            let revision: i64 =
                tx.query_row("SELECT policy_revision FROM metadata", [], |r| r.get(0))?;
            tx.execute(
                "UPDATE metadata SET policy_revision=?1,denied=?2",
                params![increment(revision)?, denied],
            )?;
            event(
                tx,
                "mock-policy",
                "policy.changed",
                &json!({"revision":revision+1,"denied":denied}),
            )
        })
    }
    pub fn task(&self, id: &str) -> Result<TaskSnapshot> {
        tada_contracts::decode(&snapshot(&self.conn, id)?).map_err(|_| Error::RecoveryRequired)
    }
    pub fn action(&self, id: &str) -> Result<ActionRecord> {
        tada_contracts::decode(&action(&self.conn, id)?).map_err(|_| Error::RecoveryRequired)
    }
    pub fn budget_committed(&self, id: &str) -> Result<i64> {
        committed_budget(&self.conn, id)
    }
    pub fn pending_notifications(&self) -> Result<Vec<Notification>> {
        let mut s = self.conn.prepare("SELECT o.key,o.task_id,o.task_version,o.kind FROM outbox o JOIN tasks t ON t.id=o.task_id WHERE o.delivered=0 AND o.task_version=t.version ORDER BY o.task_id,o.task_version,o.kind")?;
        let values = s
            .query_map([], |r| {
                Ok(Notification {
                    key: r.get(0)?,
                    task_id: r.get(1)?,
                    task_version: r.get(2)?,
                    kind: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(values)
    }
    /// Delivery is at-least-once. The downstream sink must honor the stable key;
    /// an OS notification side effect cannot be atomically committed with SQLite.
    pub fn acknowledge_notification(&mut self, key: &str) -> Result<()> {
        let delivered: bool =
            self.conn
                .query_row("SELECT delivered FROM outbox WHERE key=?1", [key], |r| {
                    r.get(0)
                })?;
        if delivered {
            return Ok(());
        }
        self.transact("outbox_ack", |tx| {
            tx.execute("UPDATE outbox SET delivered=1 WHERE key=?1", [key])?;
            event(
                tx,
                "outbox",
                "notification.acknowledged",
                &json!({"key":key}),
            )
        })
    }
    /// Consistent state-only backup. Retain witness.sqlite independently.
    /// Restoring this backup requires quarantine/reconciliation, never replay.
    pub fn backup_state(&self, destination: &Path) -> Result<()> {
        if destination.exists() {
            return Err(Error::Denied("BACKUP_DESTINATION_EXISTS"));
        }
        self.conn.backup("main", destination, None)?;
        Ok(())
    }
    /// Read-only forensic export remains possible when the writable open fails.
    /// Returned JSON is untrusted data, not evidence of completion or permission.
    pub fn inspect(root: &Path) -> Result<Vec<String>> {
        let conn = Connection::open_with_flags(
            root.join("state.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        ids(&conn, "SELECT snapshot FROM tasks ORDER BY id")
    }
}

fn admit_lease(tx: &Transaction<'_>, lease: &Lease, tick: i64) -> Result<()> {
    let current = snapshot(tx, &lease.task_id)?;
    if number(&current, "cancel_epoch")? > 0 {
        return Err(Error::Denied("TASK_CANCELLED"));
    }
    if current["execution_status"] != "RUNNING" {
        return Err(Error::Denied("TASK_NOT_RUNNING"));
    }
    let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id JOIN metadata m ON m.singleton=1 WHERE r.id=?1 AND r.task_id=?2 AND r.active=1 AND r.generation=?3 AND r.generation=m.generation AND r.fence=?4 AND r.fence=t.fence AND r.expires_tick>?5)",params![lease.run_id,lease.task_id,lease.generation,lease.fence,tick],|r|r.get(0))?;
    if !valid {
        return Err(Error::Denied("STALE_LEASE"));
    }
    Ok(())
}
fn scope(tx: &Transaction<'_>, id: &str, target: &str) -> Result<()> {
    let raw: String = tx.query_row("SELECT contract FROM tasks WHERE id=?1", [id], |r| r.get(0))?;
    let contract: TaskContract =
        tada_contracts::decode(&parse(raw)?).map_err(|_| Error::RecoveryRequired)?;
    if !contract.external_effects.iter().any(|s| {
        s.capability == "mock.apply"
            && s.account_ref == "mock-account"
            && s.target == target
            && s.purpose == "mock-test"
    }) {
        return Err(Error::Denied("OUTSIDE_TASK_SCOPE"));
    }
    Ok(())
}
fn committed_budget(conn: &Connection, id: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT coalesce(sum(CASE WHEN status='settled' THEN charged ELSE reserved END),0) FROM reservations WHERE task_id=?1",[id],|r|r.get(0))?)
}
fn bind_receipt(value: &Value, receipt: &Receipt) -> Result<()> {
    if text(value, "action_id")? != receipt.action_id
        || text(value, "intent_hash")? != receipt.request_hash
    {
        return Err(Error::RecoveryRequired);
    }
    Ok(())
}
fn settle(tx: &Transaction<'_>, id: &str, charged: i64) -> Result<()> {
    counter(charged)?;
    let reserved: i64 = tx.query_row(
        "SELECT reserved FROM reservations WHERE action_id=?1",
        [id],
        |r| r.get(0),
    )?;
    if charged > reserved {
        return Err(Error::RecoveryRequired);
    }
    tx.execute(
        "UPDATE reservations SET status='settled',charged=?1 WHERE action_id=?2",
        params![charged, id],
    )?;
    Ok(())
}

pub(crate) struct Dispatch {
    action_id: String,
    payload: MockPayload,
    hash: String,
    reserved: i64,
}

// Fault hooks exist only in the unit-test binary. Release builds have no
// environment-controlled pause/kill path and no arbitrary SQL testing API.
#[cfg(not(test))]
fn checkpoint(_: &str) {}
#[cfg(test)]
fn checkpoint(phase: &str) {
    if std::env::var("TADA_TEST_PHASE").ok().as_deref() == Some(phase) {
        let root = std::env::var_os("TADA_TEST_ROOT").expect("test root");
        let ready = Path::new(&root).join("boundary.ready");
        fs::write(&ready, phase).expect("signal fault boundary");
        OpenOptions::new()
            .write(true)
            .open(ready)
            .unwrap()
            .sync_all()
            .unwrap();
        loop {
            std::thread::park();
        }
    }
}
#[cfg(test)]
mod tests;
