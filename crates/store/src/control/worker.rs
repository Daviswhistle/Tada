//! SEC-01A: exact-scope admission for one broker-owned, read-only digest tool.
//! The host retains the opaque channel for an authenticated worker connection.
//! This is not a listener, a filesystem sandbox, or a general execution gateway.
use super::json_input;
use crate::{counter, digest, event, Error, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fmt, time::{Duration, Instant}};
use tada_contracts::{worker::*, Contract, SafeInteger};
use crate::queue::{WorkKind, WorkLease};

mod policy;
#[cfg(test)]
mod tests;

pub const MAX_WORKER_BODY: usize = 16_384;
const CATALOG: &str = "task.contract_digest/v1;effect=read;source=bound-task-contract;arguments=expected_hash;network=none;result=sha256;input=16384;output=4096";

/// Host-owned channel identity. Never reconstructed from a worker's subject,
/// task ID, grant reference or JSON. Keep one handle per protected connection.
/// A clone shares the same durable revocation and cannot widen its assignment.
#[derive(Clone)]
pub struct WorkerChannel {
    lease: WorkLease,
    record: ChannelRecord,
}
impl fmt::Debug for WorkerChannel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WorkerChannel { host_bound: true }")
    }
}
impl WorkerChannel {
    pub fn subject(&self) -> &str { &self.record.subject }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelRecord {
    format: u8,
    subject: String,
    task_id: String,
    store_id: String,
    generation: i64,
    host_revision: i64,
    cancel_epoch: i64,
    queue_fence: i64,
    contract_hash: String,
    expires_tick: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRecord {
    format: u8,
    channel_hash: String,
    policy_hash: String,
    catalog_hash: String,
    expires_tick: i64,
    proposal: WorkerProposal,
    grant: WorkerGrant,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdmissionRecord {
    format: u8,
    fingerprint: String,
    result: WorkerResult,
}
fn n(value: SafeInteger) -> i64 { value.get() as i64 }
fn si(value: i64) -> Result<SafeInteger> {
    counter(value)?;
    SafeInteger::new(value as u64).ok_or(Error::Invalid("WORKER_COUNTER"))
}
fn encode<T: Contract>(value: &T) -> Result<Value> {
    tada_contracts::encode(value).map_err(|_| Error::Invalid("WORKER_CONTRACT"))
}
fn decode<T: Contract>(value: &Value) -> Result<T> {
    tada_contracts::decode(value).map_err(|_| Error::Invalid("WORKER_CONTRACT"))
}
fn fingerprint<T: Serialize>(value: &T) -> Result<String> {
    Ok(digest(&serde_json::to_vec(value)?))
}
fn unique<T: DeserializeOwned>(conn: &Connection, key: &str, kind: &str) -> Result<Option<T>> {
    let mut stmt = conn.prepare("SELECT payload FROM events WHERE aggregate_id=?1 AND kind=?2 ORDER BY seq LIMIT 2")?;
    let rows = stmt.query_map(params![key, kind], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > 1 { return Err(Error::RecoveryRequired); }
    rows.first().map(|s| {
        let value = json_input::parse(s.as_bytes()).map_err(|_| Error::RecoveryRequired)?;
        serde_json::from_value(value).map_err(|_| Error::RecoveryRequired)
    }).transpose()
}
fn policy_key(task: &str) -> String { format!("worker-policy-{}", digest(task.as_bytes())) }
fn latest_policy(conn: &Connection, task: &str) -> Result<Option<WorkerPolicy>> {
    let raw: Option<String> = conn.query_row(
        "SELECT payload FROM events WHERE aggregate_id=?1 AND kind='worker.policy_set' ORDER BY seq DESC LIMIT 1",
        [policy_key(task)], |r| r.get(0),
    ).optional()?;
    raw.map(|raw| {
        let value = json_input::parse(raw.as_bytes()).map_err(|_| Error::RecoveryRequired)?;
        decode(&value).map_err(|_| Error::RecoveryRequired)
    }).transpose()
}
fn revoked(conn: &Connection, key: &str, kind: &str) -> Result<bool> {
    let record: Option<Value> = unique(conn, key, kind)?;
    match record {
        None => Ok(false),
        Some(value) if value == json!({"format":1,"revoked":true}) => Ok(true),
        _ => Err(Error::RecoveryRequired),
    }
}
fn authorization(decision: WorkerDecision, reason: &str, grant: Option<WorkerGrant>) -> WorkerAuthorization {
    WorkerAuthorization { schema_version: SafeInteger::new(1).expect("constant"), decision, reason: reason.into(), grant }
}
fn tick(clock: Instant) -> Result<i64> {
    counter(i64::try_from(clock.elapsed().as_millis()).map_err(|_| Error::RecoveryRequired)?)
}
fn admission_tx(tx: &Transaction<'_>, channel: &ChannelRecord, expires: i64, clock: Instant) -> Result<()> {
    let now = tick(clock)?;
    if now >= expires || now >= channel.expires_tick { return Err(Error::Denied("WORKER_EXPIRED")); }
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks t JOIN work_queue q ON q.task_id=t.id JOIN metadata m ON m.singleton=1 JOIN runs r ON r.id=json_extract(q.record,'$.run_id') WHERE t.id=?1 AND t.execution='RUNNING' AND t.cancel_epoch=?2 AND m.store_id=?3 AND m.generation=?4 AND m.policy_revision=?5 AND m.denied=0 AND json_extract(q.record,'$.kind')='advance' AND json_extract(q.record,'$.state')='leased' AND json_extract(q.record,'$.fence')=?6 AND json_extract(q.record,'$.contract_hash')=?7 AND json_extract(q.record,'$.lease_generation')=m.generation AND json_extract(q.record,'$.lease_until_tick')>?8 AND r.active=1 AND r.generation=m.generation AND r.fence=t.fence AND r.expires_tick>?8)",
        params![channel.task_id, channel.cancel_epoch, channel.store_id, channel.generation, channel.host_revision, channel.queue_fence, channel.contract_hash, now], |r| r.get(0),
    )?;
    if !active { return Err(Error::Denied("WORKER_AUTHORITY_CHANGED")); }
    if revoked(tx, &channel.subject, "worker.channel_revoked")? { return Err(Error::Denied("WORKER_REVOKED")); }
    Ok(())
}
impl Store {
    fn worker_operation<T>(&mut self, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        if self.poisoned { return Err(Error::RecoveryRequired); }
        let result = f(self);
        if matches!(&result, Err(Error::Sql(_) | Error::Io(_) | Error::RecoveryRequired)) { self.poisoned = true; }
        result
    }
    /// Trusted-host policy input only. No UI/worker RPC route calls this API.
    /// Origin is provenance, not a way for a document to prove its own authority.
    pub fn set_worker_policy(&mut self, task_id: &str, policy: &WorkerPolicy) -> Result<()> {
        self.worker_operation(|s| {
            let value = encode(policy)?;
            if !super::exists(&s.conn, task_id)? { return Err(Error::Denied("WORKER_TASK_NOT_FOUND")); }
            let raw: String = s.conn.query_row("SELECT contract FROM tasks WHERE id=?1", [task_id], |r| r.get(0))?;
            let contract: tada_contracts::TaskContract = tada_contracts::decode(&crate::parse(raw)?)
                .map_err(|_| Error::RecoveryRequired)?;
            if contract.policy_profile_id != policy.profile_id { return Err(Error::Denied("WORKER_PROFILE_MISMATCH")); }
            if let Some(old) = latest_policy(&s.conn, task_id)? {
                if old == *policy { return Ok(()); }
                if n(policy.revision) <= n(old.revision) { return Err(Error::Denied("WORKER_POLICY_REVISION_REUSED")); }
            }
            s.transact("worker_policy", |tx| event(tx, &policy_key(task_id), "worker.policy_set", &value))
        })
    }
    /// Bind a fresh host channel to an existing live execution assignment.
    /// Transport integration must retain this handle; accepting a JSON subject
    /// instead would bypass the boundary. Reconciliation has no execution channel.
    pub fn open_worker_channel(&mut self, lease: &WorkLease, ttl: Duration) -> Result<WorkerChannel> {
        self.worker_operation(|s| {
            s.check_work_lease(lease)?;
            if lease.kind() != WorkKind::Advance { return Err(Error::Denied("WORKER_OBSERVATION_ONLY")); }
            let ms = i64::try_from(ttl.as_millis()).map_err(|_| Error::Invalid("WORKER_TTL"))?;
            if !(1..=60_000).contains(&ms) { return Err(Error::Invalid("WORKER_TTL")); }
            if latest_policy(&s.conn, lease.task_id())?.is_none() { return Err(Error::Denied("WORKER_POLICY_REQUIRED")); }
            let (store_id, generation) = s.control_context()?;
            let (host_revision, denied): (i64, bool) = s.conn.query_row("SELECT policy_revision,denied FROM metadata", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if denied { return Err(Error::Denied("WORKER_HOST_DENIED")); }
            let entry = s.work_entry(lease.task_id())?;
            let until = counter(s.tick()?.checked_add(ms).ok_or(Error::Invalid("WORKER_TTL"))?)?
                .min(entry.lease_until_tick.ok_or(Error::RecoveryRequired)?);
            let mut random = [0; 32];
            getrandom::fill(&mut random).map_err(|_| Error::Invalid("WORKER_RANDOM_FAILED"))?;
            let record = ChannelRecord {
                format: 1, subject: format!("worker-{}", digest(&random)), task_id: lease.task_id().into(),
                store_id, generation, host_revision, cancel_epoch: entry.cancel_epoch,
                queue_fence: lease.fence(), contract_hash: lease.contract_hash().into(), expires_tick: until,
            };
            let clock = s.clock;
            s.transact("worker_channel", |tx| {
                admission_tx(tx, &record, until, clock)?;
                event(tx, &record.subject, "worker.channel_opened", &serde_json::to_value(&record)?)
            })?;
            Ok(WorkerChannel { lease: lease.clone(), record })
        })
    }
    fn worker_channel_current(&self, channel: &WorkerChannel) -> Result<()> {
        let (id, generation) = self.control_context()?;
        let c = &channel.record;
        if c.store_id != id || c.generation != generation { return Err(Error::Denied("WORKER_STALE_GENERATION")); }
        let recorded: ChannelRecord = unique(&self.conn, &c.subject, "worker.channel_opened")?
            .ok_or(Error::Denied("WORKER_UNKNOWN_CHANNEL"))?;
        if recorded != *c { return Err(Error::RecoveryRequired); }
        if revoked(&self.conn, &c.subject, "worker.channel_revoked")? { return Err(Error::Denied("WORKER_REVOKED")); }
        if self.tick()? >= c.expires_tick { return Err(Error::Denied("WORKER_EXPIRED")); }
        self.check_work_lease(&channel.lease)?;
        let (revision, denied): (i64, bool) = self.conn.query_row("SELECT policy_revision,denied FROM metadata", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        if denied || revision != c.host_revision { return Err(Error::Denied("WORKER_HOST_POLICY_CHANGED")); }
        Ok(())
    }
    fn worker_decision(&self, channel: &WorkerChannel, proposal: &WorkerProposal) -> Result<(WorkerPolicy, WorkerDecision, &'static str)> {
        self.worker_channel_current(channel)?;
        encode(proposal)?;
        let policy = latest_policy(&self.conn, channel.lease.task_id())?.ok_or(Error::Denied("WORKER_POLICY_REQUIRED"))?;
        let contract = self.work_contract(&channel.lease)?;
        if contract.policy_profile_id != policy.profile_id { return Err(Error::RecoveryRequired); }
        let (decision, reason) = policy::evaluate(&policy, proposal, channel.lease.task_id(), channel.lease.contract_hash());
        Ok((policy, decision, reason))
    }
    /// Evaluate a complete typed proposal and, only on ALLOW, persist a one-call
    /// grant. Repeating the same call does not extend expiry or allocate a new ID.
    pub fn authorize_worker_call(&mut self, channel: &WorkerChannel, proposal: &WorkerProposal) -> Result<WorkerAuthorization> {
        self.worker_operation(|s| {
            let (policy, decision, reason) = s.worker_decision(channel, proposal)?;
            if decision != WorkerDecision::Allow { return Ok(authorization(decision, reason, None)); }
            let grant_id = format!("grant-{}", fingerprint(&(&channel.record.subject, &proposal.call_id))?);
            if let Some(old) = unique::<GrantRecord>(&s.conn, &grant_id, "worker.grant_issued")? {
                if old.proposal != *proposal { return Err(Error::Denied("WORKER_CALL_ID_REUSED")); }
                s.worker_grant_current(channel, &old, &policy)?;
                return Ok(authorization(WorkerDecision::Allow, "ALLOWED", Some(old.grant)));
            }
            let count: i64 = s.conn.query_row("SELECT count(*) FROM events WHERE kind='worker.grant_issued' AND json_extract(payload,'$.grant.subject')=?1", [channel.subject()], |r| r.get(0))?;
            if count >= n(policy.max_calls) { return Err(Error::Denied("WORKER_GRANT_LIMIT")); }
            let now = s.tick()?;
            let expires = counter(now.checked_add(n(policy.grant_ttl_ms)).ok_or(Error::Invalid("WORKER_TTL"))?)?.min(channel.record.expires_tick);
            if expires <= now { return Err(Error::Denied("WORKER_EXPIRED")); }
            let grant = WorkerGrant {
                schema_version: si(1)?, grant_id: grant_id.clone(), subject: channel.subject().into(),
                task_id: proposal.task_id.clone(), tool: proposal.tool.clone(), tool_version: proposal.tool_version,
                resource: proposal.resource.clone(), purpose: proposal.purpose.clone(), payload_hash: fingerprint(proposal)?,
                profile_id: policy.profile_id.clone(), policy_revision: policy.revision,
                generation: si(channel.record.generation)?, cancel_epoch: si(channel.record.cancel_epoch)?,
                fencing_token: si(channel.record.queue_fence)?,
                expires_at_ms: si(crate::queue::utc_now_ms()?.checked_add(expires - now).ok_or(Error::Invalid("WORKER_TTL"))?)?,
            };
            encode(&grant)?;
            let record = GrantRecord { format: 1, channel_hash: fingerprint(&channel.record)?, policy_hash: fingerprint(&policy)?,
                catalog_hash: digest(CATALOG.as_bytes()), expires_tick: expires, proposal: proposal.clone(), grant: grant.clone() };
            let clock = s.clock;
            crate::checkpoint("worker_issue.before");
            s.transact("worker_issue", |tx| {
                admission_tx(tx, &channel.record, expires, clock)?;
                event(tx, &grant_id, "worker.grant_issued", &serde_json::to_value(&record)?)
            })?;
            Ok(authorization(WorkerDecision::Allow, "ALLOWED", Some(grant)))
        })
    }
    fn worker_grant_current(&self, channel: &WorkerChannel, record: &GrantRecord, policy: &WorkerPolicy) -> Result<()> {
        encode(&record.grant).map_err(|_| Error::RecoveryRequired)?;
        encode(&record.proposal).map_err(|_| Error::RecoveryRequired)?;
        let grant = &record.grant;
        if record.format != 1 || record.channel_hash != fingerprint(&channel.record)?
            || record.catalog_hash != digest(CATALOG.as_bytes()) || record.expires_tick > channel.record.expires_tick
            || grant.subject != channel.subject() || grant.task_id != channel.lease.task_id()
            || grant.tool != record.proposal.tool || grant.tool_version != record.proposal.tool_version
            || grant.resource != record.proposal.resource || grant.purpose != record.proposal.purpose
            || grant.payload_hash != fingerprint(&record.proposal)? || n(grant.generation) != channel.record.generation
            || n(grant.fencing_token) != channel.lease.fence() || n(grant.cancel_epoch) != channel.record.cancel_epoch
        { return Err(Error::Denied("WORKER_GRANT_BINDING")); }
        if record.policy_hash != fingerprint(policy)? || grant.policy_revision != policy.revision || grant.profile_id != policy.profile_id {
            return Err(Error::Denied("WORKER_POLICY_CHANGED"));
        }
        if self.tick()? >= record.expires_tick { return Err(Error::Denied("WORKER_EXPIRED")); }
        if revoked(&self.conn, &grant.grant_id, "worker.grant_revoked")? { return Err(Error::Denied("WORKER_REVOKED")); }
        Ok(())
    }
    /// Process a bounded JSON-RPC request from the host-bound channel. This
    /// method is intentionally NOT routed by control_handle or the native UI RPC.
    /// All present tool work is an immutable digest read; no external call runs.
    pub fn invoke_worker(&mut self, channel: &WorkerChannel, body: &[u8]) -> Result<Vec<u8>> {
        self.worker_operation(|s| s.invoke_worker_inner(channel, body))
    }
    fn invoke_worker_inner(&mut self, channel: &WorkerChannel, body: &[u8]) -> Result<Vec<u8>> {
        self.worker_channel_current(channel)?;
        if body.is_empty() || body.len() > MAX_WORKER_BODY { return Err(Error::Invalid("WORKER_BODY_LIMIT")); }
        let raw = json_input::parse(body).map_err(|_| Error::Invalid("WORKER_INVALID_JSON"))?;
        let request: WorkerRequest = decode(&raw)?;
        let call = &request.params;
        let (policy, decision, _) = self.worker_decision(channel, &call.proposal)?;
        if decision != WorkerDecision::Allow { return Err(Error::Denied("WORKER_NOT_ALLOWED")); }
        let record: GrantRecord = unique(&self.conn, &call.grant_ref, "worker.grant_issued")?
            .ok_or(Error::Denied("WORKER_UNKNOWN_GRANT"))?;
        self.worker_grant_current(channel, &record, &policy)?;
        let grant = &record.grant;
        if grant.grant_id != call.grant_ref || record.proposal != call.proposal
            || call.policy_revision != grant.policy_revision || call.generation != grant.generation
            || call.cancel_epoch != grant.cancel_epoch || call.fencing_token != grant.fencing_token
        { return Err(Error::Denied("WORKER_CALL_BINDING")); }
        let print = fingerprint(call)?;
        let expected_evidence = format!("digest-{}", fingerprint(&(&grant.grant_id, &grant.payload_hash))?);
        let mut result = WorkerResult {
            schema_version: si(1)?, call_id: call.proposal.call_id.clone(), grant_ref: grant.grant_id.clone(),
            status: "ok".into(), side_effect_state: "none".into(), contract_hash: channel.lease.contract_hash().into(),
            evidence_ref: expected_evidence, replayed: false,
        };
        encode(&result)?;
        if let Some(prior) = unique::<AdmissionRecord>(&self.conn, &grant.grant_id, "worker.call_completed")? {
            if prior.format != 1 || prior.fingerprint != print || prior.result != result { return Err(Error::RecoveryRequired); }
            result.replayed = true;
        } else {
            let record = AdmissionRecord { format: 1, fingerprint: print, result: result.clone() };
            let clock = self.clock;
            let expires = record_grant_expiry(&self.conn, &grant.grant_id)?;
            crate::checkpoint("worker_invoke.before");
            self.transact("worker_invoke", |tx| {
                admission_tx(tx, &channel.record, expires, clock)?;
                if revoked(tx, &grant.grant_id, "worker.grant_revoked")? { return Err(Error::Denied("WORKER_REVOKED")); }
                let latest = latest_policy(tx, channel.lease.task_id())?.ok_or(Error::RecoveryRequired)?;
                if latest != policy { return Err(Error::Denied("WORKER_POLICY_CHANGED")); }
                event(tx, &grant.grant_id, "worker.call_completed", &serde_json::to_value(&record)?)
            })?;
        }
        let response = WorkerReply { jsonrpc: "2.0".into(), id: request.id, result };
        let bytes = serde_json::to_vec(&encode(&response)?)?;
        if bytes.len() > 4096 { return Err(Error::RecoveryRequired); }
        Ok(bytes)
    }
    /// Trusted-host revocation, including already-expired grants. It never
    /// modifies task completion, erases a receipt, or implies compensation.
    pub fn revoke_worker_grant(&mut self, channel: &WorkerChannel, grant_id: &str) -> Result<()> {
        self.worker_operation(|s| {
            let (id, generation) = s.control_context()?;
            if id != channel.record.store_id || generation != channel.record.generation { return Err(Error::Denied("WORKER_STALE_GENERATION")); }
            let record: GrantRecord = unique(&s.conn, grant_id, "worker.grant_issued")?.ok_or(Error::Denied("WORKER_UNKNOWN_GRANT"))?;
            if record.grant.subject != channel.subject() || record.grant.grant_id != grant_id || record.channel_hash != fingerprint(&channel.record)? {
                return Err(Error::Denied("WORKER_GRANT_BINDING"));
            }
            if revoked(&s.conn, grant_id, "worker.grant_revoked")? { return Ok(()); }
            crate::checkpoint("worker_revoke.before");
            s.transact("worker_revoke", |tx| event(tx, grant_id, "worker.grant_revoked", &json!({"format":1,"revoked":true})))
        })
    }
    pub fn revoke_worker_channel(&mut self, channel: &WorkerChannel) -> Result<()> {
        self.worker_operation(|s| {
            let (id, generation) = s.control_context()?;
            if id != channel.record.store_id || generation != channel.record.generation { return Err(Error::Denied("WORKER_STALE_GENERATION")); }
            let record: ChannelRecord = unique(&s.conn, channel.subject(), "worker.channel_opened")?.ok_or(Error::Denied("WORKER_UNKNOWN_CHANNEL"))?;
            if record != channel.record { return Err(Error::RecoveryRequired); }
            if revoked(&s.conn, channel.subject(), "worker.channel_revoked")? { return Ok(()); }
            s.transact("worker_revoke_channel", |tx| event(tx, channel.subject(), "worker.channel_revoked", &json!({"format":1,"revoked":true})))
        })
    }
}
fn record_grant_expiry(conn: &Connection, id: &str) -> Result<i64> {
    let record: GrantRecord = unique(conn, id, "worker.grant_issued")?.ok_or(Error::RecoveryRequired)?;
    Ok(record.expires_tick)
}
