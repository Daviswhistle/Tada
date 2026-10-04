//! MODEL-01B: host-owned durable admission for the fixed mock inference route.
//! Internal persisted records, not a worker RPC or a provider pricing contract.
//! No method in this module opens a network connection or executes a tool.
use crate::queue::{WorkKind, WorkLease};
use crate::{counter, digest, event, parse, Error, Result, Store};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fmt, time::Instant};
use tada_contracts::worker::WorkerProposal;

const MAX_REQUESTS: usize = 80;
const MAX_USAGE_EVENTS: usize = 64;
const MAX_RECORD_BYTES: usize = 32_768;
const MAX_EVENTS: usize = MAX_REQUESTS * (MAX_USAGE_EVENTS + 3);
const ROUTE: &str = "mock-contract-digest-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InferenceSpec {
    pub request_id: String,
    pub previous_checkpoint: Option<String>,
    pub reserve_micro_usd: i64,
    pub max_output_tokens: i64,
    pub timeout_ms: i64,
}
impl InferenceSpec {
    fn validate(&self) -> Result<()> {
        if !identifier(&self.request_id)
            || self
                .previous_checkpoint
                .as_deref()
                .is_some_and(|s| !hash(s))
            || !(1..=1_000_000).contains(&self.max_output_tokens)
            || !(1..=30_000).contains(&self.timeout_ms)
        {
            return Err(Error::Invalid("MODEL_SPEC_INVALID"));
        }
        counter(self.reserve_micro_usd)?;
        Ok(())
    }
}

/// Exact replayable mock input. It contains no user goal, prompt or credential.
/// A live adapter must use an encrypted context store instead of extending this
/// mock-only payload into a plaintext prompt archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MockInferenceInput {
    pub format: u8,
    pub route: String,
    pub task_id: String,
    pub request_id: String,
    pub ordinal: i64,
    pub contract_hash: String,
    pub previous_checkpoint: Option<String>,
    pub max_output_tokens: i64,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InferenceUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reported: bool,
}
impl InferenceUsage {
    fn validate(&self) -> Result<()> {
        counter(self.input_tokens)?;
        counter(self.output_tokens)?;
        if !self.reported && (self.input_tokens != 0 || self.output_tokens != 0) {
            return Err(Error::Invalid("MODEL_USAGE_INVALID"));
        }
        Ok(())
    }
    fn follows(&self, old: &Self) -> bool {
        self.input_tokens >= old.input_tokens
            && self.output_tokens >= old.output_tokens
            && (!old.reported || self.reported)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferenceFinish {
    Stop,
    ToolCalls,
    Protocol,
    Capacity,
    Auth,
    Network,
    Cancelled,
}
/// Supplied only by a trusted host adapter after complete stream validation and
/// confirmed local producer cleanup. This is observation, never authority.
/// A partial stream must use mark_inference_unknown, not a fabricated receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InferenceReceipt {
    pub request_hash: String,
    pub finish: InferenceFinish,
    pub usage: InferenceUsage,
    pub charged_micro_usd: Option<i64>,
    pub proposals: Vec<WorkerProposal>,
    pub retry_after_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    store_id: String,
    task_id: String,
    contract_hash: String,
    generation: i64,
    host_revision: i64,
    cancel_epoch: i64,
    queue_fence: i64,
    expires_tick: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdmissionRecord {
    format: u8,
    binding: Binding,
    spec: InferenceSpec,
    ordinal: i64,
    input_hash: String,
    input_ref: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UsageRecord {
    format: u8,
    request_id: String,
    request_hash: String,
    usage: InferenceUsage,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishedRecord {
    format: u8,
    request_id: String,
    receipt: InferenceReceipt,
    output_accepted_at_commit: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnknownRecord {
    format: u8,
    request_id: String,
    request_hash: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InferenceState {
    Admitted,
    Unknown,
    Finished,
}
#[derive(Debug, Clone, Serialize)]
pub struct InferenceSnapshot {
    pub request_id: String,
    pub request_hash: String,
    pub ordinal: i64,
    pub state: InferenceState,
    pub input_ref: String,
    pub reserve_micro_usd: i64,
    pub usage: InferenceUsage,
    pub receipt: Option<InferenceReceipt>,
    pub output_accepted_at_commit: bool,
    pub checkpoint_ref: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct InferenceCheckpoint {
    pub format: u8,
    pub task_id: String,
    pub turns_used: i64,
    pub committed_micro_usd: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub uncertain_usage_requests: i64,
    pub usage_overflow: bool,
    pub blocked_on_observation: bool,
    pub latest_checkpoint: Option<String>,
    pub requests: Vec<InferenceSnapshot>,
}
/// A newly admitted request is the only way to obtain an execution ticket.
/// Repeating the same ID returns an observation snapshot, not another ticket.
pub enum InferenceAdmission {
    Fresh(InferenceTicket),
    Recorded(InferenceSnapshot),
}
/// Host-only, non-clonable and non-deserializable. Retain with the actual adapter
/// operation. Dropping it is NOT a cancellation, refund or proof of no request.
pub struct InferenceTicket {
    observer: InferenceObserver,
    input: MockInferenceInput,
}
impl fmt::Debug for InferenceTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("InferenceTicket { host_owned: true }")
    }
}
impl InferenceTicket {
    pub fn input(&self) -> &MockInferenceInput {
        &self.input
    }
    pub fn observer(&self) -> InferenceObserver {
        self.observer.clone()
    }
}
/// Receipt/usage observation only. This handle can be reacquired after restart;
/// it cannot be upgraded to an execution ticket or used to issue another request.
#[derive(Clone)]
pub struct InferenceObserver {
    store_id: String,
    task_id: String,
    request_id: String,
    request_hash: String,
}
impl fmt::Debug for InferenceObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("InferenceObserver { observation_only: true }")
    }
}
impl InferenceObserver {
    pub fn request_hash(&self) -> &str {
        &self.request_hash
    }
}
struct Entry {
    admission: AdmissionRecord,
    view: InferenceSnapshot,
    usage_events: usize,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn key(task: &str) -> String {
    format!("inference:{}", digest(task.as_bytes()))
}
fn fingerprint<T: Serialize>(value: &T) -> Result<String> {
    Ok(digest(&serde_json::to_vec(value)?))
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::RecoveryRequired)
}
fn checked_add(a: i64, b: i64) -> Result<i64> {
    counter(a.checked_add(b).ok_or(Error::RecoveryRequired)?).map_err(|_| Error::RecoveryRequired)
}
fn contract(conn: &Connection, task: &str) -> Result<Value> {
    let raw: String = conn.query_row("SELECT contract FROM tasks WHERE id=?1", [task], |r| {
        r.get(0)
    })?;
    let value = parse(raw)?;
    crate::checked("TaskContract", &value).map_err(|_| Error::RecoveryRequired)?;
    Ok(value)
}
fn turn_cap(value: &Value) -> Result<i64> {
    let n = value["budget"]["max_model_turns"]
        .as_u64()
        .ok_or(Error::Denied("MODEL_TURN_CAP_REQUIRED"))?;
    if n > MAX_REQUESTS as u64 {
        return Err(Error::Denied("MODEL_TURN_CAP_UNSUPPORTED"));
    }
    Ok(n as i64)
}
fn input_for(record: &AdmissionRecord) -> MockInferenceInput {
    MockInferenceInput {
        format: 1,
        route: ROUTE.into(),
        task_id: record.binding.task_id.clone(),
        request_id: record.spec.request_id.clone(),
        ordinal: record.ordinal,
        contract_hash: record.binding.contract_hash.clone(),
        previous_checkpoint: record.spec.previous_checkpoint.clone(),
        max_output_tokens: record.spec.max_output_tokens,
    }
}
fn validate_receipt(entry: &Entry, receipt: &InferenceReceipt) -> Result<()> {
    receipt.usage.validate()?;
    if receipt.request_hash != entry.view.request_hash
        || !receipt.usage.follows(&entry.view.usage)
        || receipt.usage.output_tokens > entry.admission.spec.max_output_tokens
        || (receipt.finish == InferenceFinish::ToolCalls) == receipt.proposals.is_empty()
        || receipt.proposals.len() > 1
        || receipt.retry_after_ms.is_some_and(|n| {
            receipt.finish != InferenceFinish::Capacity || !(1..=86_400_000).contains(&n)
        })
    {
        return Err(Error::Invalid("MODEL_RECEIPT_INVALID"));
    }
    if let Some(charged) = receipt.charged_micro_usd {
        counter(charged)?;
        if charged > entry.admission.spec.reserve_micro_usd {
            return Err(Error::Invalid("MODEL_MOCK_CHARGE_EXCEEDS_RESERVATION"));
        }
    }
    for proposal in &receipt.proposals {
        tada_contracts::encode(proposal).map_err(|_| Error::Invalid("MODEL_PROPOSAL_INVALID"))?;
        let task = &entry.admission.binding.task_id;
        if proposal.task_id != *task
            || !identifier(&proposal.call_id)
            || proposal.tool != "task.contract_digest"
            || proposal.tool_version.get() != 1
            || proposal.resource != format!("task://{task}/contract")
            || proposal.purpose != "verify_input_snapshot"
            || proposal.arguments.expected_hash != entry.admission.binding.contract_hash
        {
            return Err(Error::Invalid("MODEL_PROPOSAL_OUTSIDE_SCOPE"));
        }
    }
    Ok(())
}
fn append<T: Serialize>(tx: &Transaction<'_>, task: &str, kind: &str, value: &T) -> Result<()> {
    let body = serde_json::to_value(value)?;
    if serde_json::to_vec(&body)?.len() > MAX_RECORD_BYTES {
        return Err(Error::Invalid("MODEL_RECORD_LIMIT"));
    }
    event(tx, &key(task), kind, &body)
}
fn load(conn: &Connection, task: &str) -> Result<BTreeMap<String, Entry>> {
    let mut stmt = conn.prepare("SELECT kind,CASE WHEN length(CAST(payload AS BLOB))<=32768 THEN payload ELSE NULL END FROM events WHERE aggregate_id=?1 AND kind GLOB 'model.*' ORDER BY seq LIMIT 5361")?;
    let mut rows = stmt.query([key(task)])?;
    let mut entries: BTreeMap<String, Entry> = BTreeMap::new();
    let mut count = 0;
    let mut checkpoint: Option<String> = None;
    while let Some(row) = rows.next()? {
        count += 1;
        if count > MAX_EVENTS {
            return Err(Error::RecoveryRequired);
        }
        let kind: String = row.get(0)?;
        let raw: Option<String> = row.get(1)?;
        let raw = raw.ok_or(Error::RecoveryRequired)?;
        let value = crate::control::json_input::parse(raw.as_bytes())
            .map_err(|_| Error::RecoveryRequired)?;
        match kind.as_str() {
            "model.admitted" => {
                let record: AdmissionRecord = decode(value)?;
                record
                    .spec
                    .validate()
                    .map_err(|_| Error::RecoveryRequired)?;
                if record.format != 1
                    || record.binding.task_id != task
                    || record.ordinal != entries.len() as i64 + 1
                    || entries.len() >= MAX_REQUESTS
                    || entries.contains_key(&record.spec.request_id)
                    || entries
                        .values()
                        .any(|e| e.view.state != InferenceState::Finished)
                    || record.spec.previous_checkpoint != checkpoint
                    || record.binding.cancel_epoch != 0
                    || [
                        record.binding.generation,
                        record.binding.host_revision,
                        record.binding.queue_fence,
                        record.binding.expires_tick,
                    ]
                    .iter()
                    .any(|n| *n <= 0)
                {
                    return Err(Error::RecoveryRequired);
                }
                for n in [
                    record.binding.generation,
                    record.binding.host_revision,
                    record.binding.queue_fence,
                    record.binding.expires_tick,
                ] {
                    counter(n).map_err(|_| Error::RecoveryRequired)?;
                }
                let store_id: String =
                    conn.query_row("SELECT store_id FROM metadata", [], |r| r.get(0))?;
                if record.binding.store_id != store_id
                    || !hash(&record.input_hash)
                    || record.binding.contract_hash
                        != digest(&serde_json::to_vec(&contract(conn, task)?)?)
                    || record.input_ref != format!("blob://sha256/{}", record.input_hash)
                {
                    return Err(Error::RecoveryRequired);
                }
                let bytes: Vec<u8> = conn.query_row(
                    "SELECT content FROM payloads WHERE hash=?1 AND length(content)<=32768",
                    [&record.input_hash],
                    |r| r.get(0),
                )?;
                if digest(&bytes) != record.input_hash
                    || bytes != serde_json::to_vec(&input_for(&record))?
                {
                    return Err(Error::RecoveryRequired);
                }
                let view = InferenceSnapshot {
                    request_id: record.spec.request_id.clone(),
                    request_hash: fingerprint(&record)?,
                    ordinal: record.ordinal,
                    state: InferenceState::Admitted,
                    input_ref: record.input_ref.clone(),
                    reserve_micro_usd: record.spec.reserve_micro_usd,
                    usage: InferenceUsage::default(),
                    receipt: None,
                    output_accepted_at_commit: false,
                    checkpoint_ref: None,
                };
                entries.insert(
                    record.spec.request_id.clone(),
                    Entry {
                        admission: record,
                        view,
                        usage_events: 0,
                    },
                );
            }
            "model.usage" => {
                let record: UsageRecord = decode(value)?;
                let entry = entries
                    .get_mut(&record.request_id)
                    .ok_or(Error::RecoveryRequired)?;
                record
                    .usage
                    .validate()
                    .map_err(|_| Error::RecoveryRequired)?;
                if record.format != 1
                    || record.request_hash != entry.view.request_hash
                    || entry.view.state == InferenceState::Finished
                    || !record.usage.follows(&entry.view.usage)
                    || record.usage == entry.view.usage
                    || record.usage.output_tokens > entry.admission.spec.max_output_tokens
                    || entry.usage_events >= MAX_USAGE_EVENTS
                {
                    return Err(Error::RecoveryRequired);
                }
                entry.view.usage = record.usage;
                entry.usage_events += 1;
            }
            "model.finished" => {
                let record: FinishedRecord = decode(value)?;
                let entry = entries
                    .get_mut(&record.request_id)
                    .ok_or(Error::RecoveryRequired)?;
                if record.format != 1 || entry.view.state == InferenceState::Finished {
                    return Err(Error::RecoveryRequired);
                }
                validate_receipt(entry, &record.receipt).map_err(|_| Error::RecoveryRequired)?;
                if record.output_accepted_at_commit
                    && !matches!(
                        record.receipt.finish,
                        InferenceFinish::Stop | InferenceFinish::ToolCalls
                    )
                {
                    return Err(Error::RecoveryRequired);
                }
                checkpoint = Some(fingerprint(&record)?);
                entry.view.usage = record.receipt.usage.clone();
                entry.view.state = InferenceState::Finished;
                entry.view.output_accepted_at_commit = record.output_accepted_at_commit;
                entry.view.receipt = Some(record.receipt);
                entry.view.checkpoint_ref = checkpoint.clone();
            }
            "model.unknown" => {
                let record: UnknownRecord = decode(value)?;
                let entry = entries
                    .get_mut(&record.request_id)
                    .ok_or(Error::RecoveryRequired)?;
                if record.format != 1
                    || record.request_hash != entry.view.request_hash
                    || entry.view.state != InferenceState::Admitted
                {
                    return Err(Error::RecoveryRequired);
                }
                entry.view.state = InferenceState::Unknown;
            }
            _ => return Err(Error::RecoveryRequired),
        }
    }
    if !entries.is_empty() {
        let cap = turn_cap(&contract(conn, task)?).map_err(|_| Error::RecoveryRequired)?;
        if entries.len() as i64 > cap {
            return Err(Error::RecoveryRequired);
        }
    }
    Ok(entries)
}
fn ordered(entries: BTreeMap<String, Entry>) -> Vec<InferenceSnapshot> {
    let mut values: Vec<_> = entries.into_values().map(|e| e.view).collect();
    values.sort_by_key(|e| e.ordinal);
    values
}
fn spent(values: &[InferenceSnapshot]) -> Result<i64> {
    values.iter().try_fold(0, |total, e| {
        checked_add(
            total,
            e.receipt
                .as_ref()
                .and_then(|r| r.charged_micro_usd)
                .unwrap_or(e.reserve_micro_usd),
        )
    })
}
pub(crate) fn pending(conn: &Connection, task: &str) -> Result<bool> {
    Ok(load(conn, task)?
        .values()
        .any(|e| e.view.state != InferenceState::Finished))
}
pub(crate) fn committed(conn: &Connection, task: &str) -> Result<i64> {
    spent(&ordered(load(conn, task)?))
}
fn model_tasks(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT aggregate_id FROM events WHERE kind GLOB 'model.*'")?;
    let keys = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tasks = Vec::new();
    for k in keys {
        let task: String = conn.query_row("SELECT json_extract(payload,'$.binding.task_id') FROM events WHERE aggregate_id=?1 AND kind='model.admitted' ORDER BY seq LIMIT 1", [&k], |r| r.get(0))?;
        if key(&task) != k {
            return Err(Error::RecoveryRequired);
        }
        tasks.push(task);
    }
    Ok(tasks)
}
pub(crate) fn audit(conn: &Connection) -> Result<()> {
    for task in model_tasks(conn)? {
        load(conn, &task).map_err(|_| Error::RecoveryRequired)?;
        let total = crate::committed_budget(conn, &task)?;
        let cap: i64 = conn.query_row(
            "SELECT budget_micro_usd FROM tasks WHERE id=?1",
            [&task],
            |r| r.get(0),
        )?;
        if total > cap {
            return Err(Error::RecoveryRequired);
        }
    }
    Ok(())
}
pub(crate) fn recover(tx: &Transaction<'_>) -> Result<()> {
    for task in model_tasks(tx)? {
        for entry in load(tx, &task)?.into_values() {
            if entry.view.state == InferenceState::Admitted {
                append(
                    tx,
                    &task,
                    "model.unknown",
                    &UnknownRecord {
                        format: 1,
                        request_id: entry.view.request_id,
                        request_hash: entry.view.request_hash,
                    },
                )?;
            }
        }
    }
    Ok(())
}
fn live(conn: &Connection, binding: &Binding, clock: Instant) -> Result<bool> {
    let tick = i64::try_from(clock.elapsed().as_millis()).map_err(|_| Error::RecoveryRequired)?;
    if tick >= binding.expires_tick {
        return Ok(false);
    }
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks t JOIN work_queue q ON q.task_id=t.id JOIN metadata m ON m.singleton=1 JOIN runs r ON r.id=json_extract(q.record,'$.run_id') WHERE t.id=?1 AND t.execution='RUNNING' AND t.cancel_epoch=?2 AND m.store_id=?3 AND m.generation=?4 AND m.policy_revision=?5 AND m.denied=0 AND json_extract(q.record,'$.state')='leased' AND json_extract(q.record,'$.kind')='advance' AND json_extract(q.record,'$.fence')=?6 AND json_extract(q.record,'$.contract_hash')=?7 AND json_extract(q.record,'$.lease_generation')=m.generation AND json_extract(q.record,'$.lease_until_tick')>?8 AND r.active=1 AND r.generation=m.generation AND r.fence=t.fence AND r.expires_tick>?8)",
        params![binding.task_id,binding.cancel_epoch,binding.store_id,binding.generation,binding.host_revision,binding.queue_fence,binding.contract_hash,tick], |r| r.get(0),
    )?)
}
fn observer(entry: &Entry) -> InferenceObserver {
    InferenceObserver {
        store_id: entry.admission.binding.store_id.clone(),
        task_id: entry.admission.binding.task_id.clone(),
        request_id: entry.view.request_id.clone(),
        request_hash: entry.view.request_hash.clone(),
    }
}
fn observed(conn: &Connection, handle: &InferenceObserver) -> Result<Entry> {
    let mut entries = load(conn, &handle.task_id)?;
    let entry = entries
        .remove(&handle.request_id)
        .ok_or(Error::Denied("MODEL_REQUEST_NOT_FOUND"))?;
    if entry.admission.binding.store_id != handle.store_id
        || entry.view.request_hash != handle.request_hash
    {
        return Err(Error::Denied("MODEL_OBSERVER_MISMATCH"));
    }
    Ok(entry)
}
impl Store {
    fn inference_operation<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if self.poisoned {
            return Err(Error::RecoveryRequired);
        }
        let result = f(self);
        if matches!(
            &result,
            Err(Error::RecoveryRequired | Error::Sql(_) | Error::Io(_))
        ) {
            self.poisoned = true;
        }
        result
    }
    /// Admit only the fixed mock route. There is no endpoint/model/account field
    /// for a worker to select and no capability claim for any real provider.
    pub fn admit_mock_inference(
        &mut self,
        lease: &WorkLease,
        spec: &InferenceSpec,
    ) -> Result<InferenceAdmission> {
        self.inference_operation(|s| {
            spec.validate()?;
            if crate::queue_migration::version(&s.conn)? != 3 {
                return Err(Error::Denied("MODEL_MIGRATION_REQUIRED"));
            }
            s.check_work_lease(lease)?;
            if lease.kind() != WorkKind::Advance {
                return Err(Error::Denied("MODEL_OBSERVATION_ONLY_LEASE"));
            }
            let entries = load(&s.conn, lease.task_id())?;
            if let Some(entry) = entries.get(&spec.request_id) {
                if entry.admission.spec != *spec {
                    return Err(Error::Denied("MODEL_REQUEST_ID_REUSED"));
                }
                return Ok(InferenceAdmission::Recorded(entry.view.clone()));
            }
            let previous = ordered(entries);
            if previous.iter().any(|e| e.state != InferenceState::Finished) {
                return Err(Error::Denied("MODEL_OBSERVATION_REQUIRED"));
            }
            let last = previous.last().and_then(|e| e.checkpoint_ref.as_ref());
            if last != spec.previous_checkpoint.as_ref() {
                return Err(Error::Denied("MODEL_CHECKPOINT_STALE"));
            }
            if let Some(last) = previous.last().and_then(|e| e.receipt.as_ref()) {
                if last.finish == InferenceFinish::ToolCalls {
                    // Until the engine checkpoint binds committed tool receipts,
                    // a model proposal is not an observation for the next turn.
                    return Err(Error::Denied("MODEL_TOOL_OBSERVATION_REQUIRED"));
                }
                if !matches!(
                    last.finish,
                    InferenceFinish::Stop | InferenceFinish::ToolCalls | InferenceFinish::Protocol
                ) {
                    return Err(Error::Denied("MODEL_WAKE_REQUIRED"));
                }
            }
            if previous
                .iter()
                .rev()
                .take(2)
                .filter(|e| {
                    e.receipt
                        .as_ref()
                        .is_some_and(|r| r.finish == InferenceFinish::Protocol)
                })
                .count()
                == 2
            {
                return Err(Error::Denied("MODEL_DIAGNOSIS_REQUIRED"));
            }
            let cap = turn_cap(&contract(&s.conn, lease.task_id())?)?;
            if previous.len() as i64 >= cap {
                return Err(Error::Denied("MODEL_TURN_LIMIT"));
            }
            let queue = s.work_entry(lease.task_id())?;
            let (store_id, generation, host_revision): (String, i64, i64) = s.conn.query_row(
                "SELECT store_id,generation,policy_revision FROM metadata",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let expires = checked_add(s.tick()?, spec.timeout_ms)?
                .min(queue.lease_until_tick.ok_or(Error::RecoveryRequired)?);
            let mut record = AdmissionRecord {
                format: 1,
                binding: Binding {
                    store_id,
                    task_id: lease.task_id().into(),
                    contract_hash: lease.contract_hash().into(),
                    generation,
                    host_revision,
                    cancel_epoch: 0,
                    queue_fence: lease.fence(),
                    expires_tick: expires,
                },
                spec: spec.clone(),
                ordinal: previous.len() as i64 + 1,
                input_hash: String::new(),
                input_ref: String::new(),
            };
            let input = input_for(&record);
            let bytes = serde_json::to_vec(&input)?;
            record.input_hash = digest(&bytes);
            record.input_ref = format!("blob://sha256/{}", record.input_hash);
            let clock = s.clock;
            crate::checkpoint("model_admit.before");
            s.transact("model_admit", |tx| {
                if !live(tx, &record.binding, clock)? {
                    return Err(Error::Denied("MODEL_AUTHORITY_CHANGED"));
                }
                let used = crate::committed_budget(tx, lease.task_id())?;
                let budget: i64 = tx.query_row(
                    "SELECT budget_micro_usd FROM tasks WHERE id=?1",
                    [lease.task_id()],
                    |r| r.get(0),
                )?;
                if used > budget {
                    return Err(Error::RecoveryRequired);
                }
                // Both stored amounts are bounded nonnegative integers. Compare
                // against the remaining balance BEFORE adding caller input:
                // an oversized request is a denial, not database corruption.
                if spec.reserve_micro_usd > budget - used {
                    return Err(Error::Denied("MODEL_BUDGET_EXHAUSTED"));
                }
                tx.execute(
                    "INSERT OR IGNORE INTO payloads(hash,content) VALUES(?1,?2)",
                    params![record.input_hash, bytes],
                )?;
                append(tx, lease.task_id(), "model.admitted", &record)
            })?;
            let entry = load(&s.conn, lease.task_id())?
                .remove(&spec.request_id)
                .ok_or(Error::RecoveryRequired)?;
            Ok(InferenceAdmission::Fresh(InferenceTicket {
                observer: observer(&entry),
                input,
            }))
        })
    }
    /// Reacquire ONLY observation authority after restart. No fresh admission or
    /// replacement execution ticket is created, even for an apparently unsent request.
    pub fn inference_observer(&mut self, task: &str, request: &str) -> Result<InferenceObserver> {
        self.inference_operation(|s| {
            let entry = load(&s.conn, task)?
                .remove(request)
                .ok_or(Error::Denied("MODEL_REQUEST_NOT_FOUND"))?;
            Ok(observer(&entry))
        })
    }
    pub fn observe_inference_usage(
        &mut self,
        handle: &InferenceObserver,
        usage: &InferenceUsage,
    ) -> Result<()> {
        self.inference_operation(|s| {
            usage.validate()?;
            let entry = observed(&s.conn, handle)?;
            if *usage == entry.view.usage {
                return Ok(());
            }
            if entry.view.state == InferenceState::Finished
                || !usage.follows(&entry.view.usage)
                || usage.output_tokens > entry.admission.spec.max_output_tokens
                || entry.usage_events >= MAX_USAGE_EVENTS
            {
                return Err(Error::Denied("MODEL_USAGE_UPDATE_REJECTED"));
            }
            crate::checkpoint("model_usage.before");
            s.transact("model_usage", |tx| {
                append(
                    tx,
                    &handle.task_id,
                    "model.usage",
                    &UsageRecord {
                        format: 1,
                        request_id: handle.request_id.clone(),
                        request_hash: handle.request_hash.clone(),
                        usage: usage.clone(),
                    },
                )
            })
        })
    }
    pub fn mark_inference_unknown(&mut self, handle: &InferenceObserver) -> Result<()> {
        self.inference_operation(|s| {
            let entry = observed(&s.conn, handle)?;
            if entry.view.state == InferenceState::Unknown {
                return Ok(());
            }
            if entry.view.state != InferenceState::Admitted {
                return Err(Error::Denied("MODEL_ALREADY_FINISHED"));
            }
            s.transact("model_unknown", |tx| {
                append(
                    tx,
                    &handle.task_id,
                    "model.unknown",
                    &UnknownRecord {
                        format: 1,
                        request_id: handle.request_id.clone(),
                        request_hash: handle.request_hash.clone(),
                    },
                )
            })
        })
    }
    /// Commit the receipt and its checkpoint together BEFORE returning to an
    /// engine. Late observations can settle usage, but cannot revive cancelled,
    /// expired, revoked or previous-generation output for execution.
    pub fn finish_mock_inference(
        &mut self,
        handle: &InferenceObserver,
        receipt: &InferenceReceipt,
    ) -> Result<InferenceSnapshot> {
        self.inference_operation(|s| {
            let entry = observed(&s.conn, handle)?;
            if let Some(saved) = &entry.view.receipt {
                if saved != receipt {
                    return Err(Error::Denied("MODEL_RECEIPT_CONFLICT"));
                }
                return Ok(entry.view);
            }
            validate_receipt(&entry, receipt)?;
            let clock = s.clock;
            crate::checkpoint("model_finish.before");
            s.transact("model_finish", |tx| {
                let output_accepted_at_commit = matches!(
                    receipt.finish,
                    InferenceFinish::Stop | InferenceFinish::ToolCalls
                ) && live(tx, &entry.admission.binding, clock)?;
                append(
                    tx,
                    &handle.task_id,
                    "model.finished",
                    &FinishedRecord {
                        format: 1,
                        request_id: handle.request_id.clone(),
                        receipt: receipt.clone(),
                        output_accepted_at_commit,
                    },
                )
            })?;
            Ok(observed(&s.conn, handle)?.view)
        })
    }
    /// Trusted-host inspection. These snapshots contain no grant and do not
    /// mutate task acceptance, issue a retry, or rehydrate a model conversation.
    pub fn inference_checkpoint(&mut self, task: &str) -> Result<InferenceCheckpoint> {
        self.inference_operation(|s| {
            let exists: bool = s.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
                [task],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::Denied("MODEL_TASK_NOT_FOUND"));
            }
            let values = ordered(load(&s.conn, task)?);
            let mut checkpoint = InferenceCheckpoint {
                format: 1,
                task_id: task.into(),
                turns_used: values.len() as i64,
                committed_micro_usd: spent(&values)?,
                input_tokens: 0,
                output_tokens: 0,
                uncertain_usage_requests: 0,
                usage_overflow: false,
                blocked_on_observation: false,
                latest_checkpoint: values.last().and_then(|e| e.checkpoint_ref.clone()),
                requests: Vec::new(),
            };
            for entry in &values {
                match checked_add(checkpoint.input_tokens, entry.usage.input_tokens) {
                    Ok(n) => checkpoint.input_tokens = n,
                    Err(_) => checkpoint.usage_overflow = true,
                }
                match checked_add(checkpoint.output_tokens, entry.usage.output_tokens) {
                    Ok(n) => checkpoint.output_tokens = n,
                    Err(_) => checkpoint.usage_overflow = true,
                }
                if entry.state != InferenceState::Finished
                    || !entry.usage.reported
                    || entry
                        .receipt
                        .as_ref()
                        .and_then(|r| r.charged_micro_usd)
                        .is_none()
                {
                    checkpoint.uncertain_usage_requests += 1;
                }
                checkpoint.blocked_on_observation |= entry.state != InferenceState::Finished;
            }
            checkpoint.requests = values;
            Ok(checkpoint)
        })
    }
}

#[cfg(test)]
mod tests;
