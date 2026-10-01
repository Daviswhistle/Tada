//! Authenticated, transport-neutral local control protocol.
//! Only submit, cancel, snapshot and task-event reads are exposed. There is no
//! tool dispatch, policy/grant issuance, shell, login or listener in this module.
use crate::{
    checked, counter, digest, enqueue, event, number, parse, save_task, snapshot, text, Error,
    Result, Store,
};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tada_contracts::{CompletionStatus, ExecutionStatus};

pub mod auth;
mod json_input;
use auth::{identifier, Access, Credential, Pending, ServerSession, MAX_BODY};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    principal: String,
    request_id: String,
    fingerprint: String,
    outcome: Outcome,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Outcome {
    Applied {
        task_id: String,
        task_version: i64,
        execution_status: ExecutionStatus,
        completion_status: CompletionStatus,
        cancel_epoch: i64,
    },
    Rejected {
        reason: Rejection,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Rejection {
    TaskExists,
    TaskNotFound,
}
impl Outcome {
    fn applied(value: &Value) -> Result<Self> {
        checked("TaskSnapshot", value)?;
        Ok(Self::Applied {
            task_id: text(value, "task_id")?.into(),
            task_version: number(value, "version")?,
            execution_status: serde_json::from_value(value["execution_status"].clone())?,
            completion_status: serde_json::from_value(value["completion_status"].clone())?,
            cancel_epoch: number(value, "cancel_epoch")?,
        })
    }
    fn validate(&self) -> Result<()> {
        if let Self::Applied {
            task_id,
            task_version,
            cancel_epoch,
            execution_status,
            ..
        } = self
        {
            if !identifier(task_id)
                || *task_version <= 0
                || (*execution_status == ExecutionStatus::Cancelled && *cancel_epoch == 0)
            {
                return Err(Error::RecoveryRequired);
            }
            counter(*task_version).map_err(|_| Error::RecoveryRequired)?;
            counter(*cancel_epoch).map_err(|_| Error::RecoveryRequired)?;
        }
        Ok(())
    }
    fn response(&self, id: &str) -> Result<Value> {
        self.validate()?;
        Ok(match self {
            Self::Applied { .. } => success(
                id,
                json!({"command_result":serde_json::to_value(self)?,"semantics":"original_command_commit"}),
            ),
            Self::Rejected { reason } => failure(
                json!(id),
                -32010,
                match reason {
                    Rejection::TaskExists => "TASK_EXISTS",
                    Rejection::TaskNotFound => "TASK_NOT_FOUND",
                },
            ),
        })
    }
}

impl Store {
    /// Trusted-host bootstrap identity. Not an unauthenticated discovery RPC.
    pub fn control_store_id(&self) -> Result<String> {
        if self.poisoned {
            return Err(Error::RecoveryRequired);
        }
        Ok(self
            .conn
            .query_row("SELECT store_id FROM metadata WHERE singleton=1", [], |r| {
                r.get(0)
            })?)
    }
    pub fn control_challenge<'a>(&self, credential: &'a Credential) -> Result<Pending<'a>> {
        let (id, generation) = self.control_context()?;
        credential.challenge(id, generation)
    }
    fn control_context(&self) -> Result<(String, i64)> {
        if self.poisoned {
            return Err(Error::RecoveryRequired);
        }
        Ok(self.conn.query_row(
            "SELECT store_id,generation FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        )?)
    }

    /// The caller owns protected transport and OS peer validation. A failed
    /// authentication closes this session before decoding or querying a task.
    /// Application responses are signed; storage errors abort the request and
    /// must not be turned into a success by the transport adapter.
    pub fn control_handle(&mut self, session: &mut ServerSession, frame: &[u8]) -> Result<Vec<u8>> {
        let (store_id, generation) = self.control_context()?;
        if let Err(error) = session.check(&store_id, generation) {
            session.revoke();
            return Err(error);
        }
        let body = session.open(frame)?;
        let value = match json_input::parse(&body) {
            Ok(value) => value,
            Err(_) => return signed(session, failure(Value::Null, -32700, "INVALID_JSON")),
        };
        // No unacknowledgeable mutation notifications. Close rather than reply
        // to a JSON-RPC notification, which must not receive a response.
        if value.is_object() && value.get("id").is_none() {
            session.revoke();
            return Err(Error::Invalid("CONTROL_ID_REQUIRED"));
        }
        let Some(id) = value["id"].as_str().filter(|id| identifier(id)) else {
            return signed(session, failure(Value::Null, -32600, "INVALID_REQUEST"));
        };
        let envelope = value.as_object().is_some_and(|o| {
            o.len() == 4
                && o.keys()
                    .all(|k| ["jsonrpc", "id", "method", "params"].contains(&k.as_str()))
        });
        if !envelope
            || value["jsonrpc"] != "2.0"
            || !value["method"].is_string()
            || !value["params"].is_object()
        {
            return signed(session, failure(Value::Null, -32600, "INVALID_REQUEST"));
        }
        let method = value["method"]
            .as_str()
            .ok_or(Error::Invalid("INVALID_REQUEST"))?;
        if !["task.submit", "task.cancel", "task.get", "task.events"].contains(&method) {
            return signed(session, failure(json!(id), -32601, "METHOD_NOT_FOUND"));
        }
        if checked("ControlRequest", &value).is_err() {
            return signed(session, failure(json!(id), -32602, "INVALID_PARAMS"));
        }
        // JSON Schema considers 1 and 1.0 equal integers. Normalize only through
        // validated generated types, never by coercing strings or dropping fields.
        let typed = tada_contracts::decode::<tada_contracts::ControlRequest>(&value)
            .map_err(|_| Error::Invalid("CONTROL_TYPED_DECODE_FAILED"))?;
        let normalized = tada_contracts::encode(&typed)
            .map_err(|_| Error::Invalid("CONTROL_TYPED_ENCODE_FAILED"))?;
        let parameters = &normalized["params"];
        let response = match method {
            "task.get" => self.control_snapshot(id, text(parameters, "task_id")?)?,
            "task.events" => self.control_events(id, parameters)?,
            _ => {
                if session.access != Access::Controller {
                    return signed(session, failure(json!(id), -32001, "CONTROL_FORBIDDEN"));
                }
                let request_id = text(parameters, "request_id")?;
                let key = digest(&serde_json::to_vec(&(&session.principal, request_id))?);
                let fingerprint = digest(&serde_json::to_vec(
                    &json!({"method":method,"params":parameters}),
                )?);
                let replay = lookup(
                    &self.conn,
                    &key,
                    &session.principal,
                    request_id,
                    &fingerprint,
                );
                match replay {
                    Ok(Some(outcome)) => outcome.response(id)?,
                    Err(Error::Denied("REQUEST_ID_REUSED")) => {
                        failure(json!(id), -32011, "REQUEST_ID_REUSED")
                    }
                    Err(error) => return Err(error),
                    Ok(None) => {
                        crate::checkpoint("control.before");
                        let outcome = self.transact("control", |tx| {
                            // Admission rechecks in-memory key revocation/expiry;
                            // no authentication or authority comes from params.
                            session.check(&store_id, generation)?;
                            if let Some(outcome) =
                                lookup(tx, &key, &session.principal, request_id, &fingerprint)?
                            {
                                return Ok(outcome);
                            }
                            let outcome = match method {
                                "task.submit" => {
                                    let contract = &parameters["contract"];
                                    let task_id = text(contract, "task_id")?;
                                    if exists(tx, task_id)? {
                                        Outcome::Rejected {
                                            reason: Rejection::TaskExists,
                                        }
                                    } else {
                                        Outcome::applied(&create_task_tx(
                                            tx,
                                            contract,
                                            number(parameters, "budget_micro_usd")?,
                                        )?)?
                                    }
                                }
                                "task.cancel" => {
                                    let task_id = text(parameters, "task_id")?;
                                    if !exists(tx, task_id)? {
                                        Outcome::Rejected {
                                            reason: Rejection::TaskNotFound,
                                        }
                                    } else {
                                        Outcome::applied(&cancel_task_tx(tx, task_id)?)?
                                    }
                                }
                                _ => return Err(Error::Invalid("UNREACHABLE_METHOD")),
                            };
                            let receipt = Receipt {
                                version: 1,
                                principal: session.principal.clone(),
                                request_id: request_id.into(),
                                fingerprint: fingerprint.clone(),
                                outcome,
                            };
                            event(
                                tx,
                                &key,
                                "control.completed",
                                &serde_json::to_value(&receipt)?,
                            )?;
                            Ok(receipt.outcome)
                        })?;
                        outcome.response(id)?
                    }
                }
            }
        };
        signed(session, response)
    }

    fn control_snapshot(&self, id: &str, task_id: &str) -> Result<Value> {
        if !exists(&self.conn, task_id)? {
            return Ok(failure(json!(id), -32010, "TASK_NOT_FOUND"));
        }
        let value = snapshot(&self.conn, task_id)?;
        checked("TaskSnapshot", &value).map_err(|_| Error::RecoveryRequired)?;
        Ok(success(id, json!({"snapshot":value,"semantics":"current"})))
    }
    fn control_events(&self, id: &str, p: &Value) -> Result<Value> {
        let task_id = text(p, "task_id")?;
        if !exists(&self.conn, task_id)? {
            return Ok(failure(json!(id), -32010, "TASK_NOT_FOUND"));
        }
        let after = number(p, "after_seq")?;
        let limit = number(p, "limit")?;
        let tip: i64 = self
            .conn
            .query_row("SELECT coalesce(max(seq),0) FROM events", [], |r| r.get(0))?;
        if after > tip {
            return Ok(failure(json!(id), -32602, "CURSOR_AHEAD"));
        }
        let mut statement = self.conn.prepare("SELECT seq,kind,payload FROM events WHERE aggregate_id=?1 AND kind LIKE 'task.%' AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let rows = statement.query_map(params![task_id, after, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut entries = Vec::new();
        let mut next = after;
        let mut bytes = 0;
        for row in rows {
            let (seq, kind, raw) = row?;
            let payload = parse(raw)?;
            checked("TaskSnapshot", &payload).map_err(|_| Error::RecoveryRequired)?;
            if payload["task_id"] != task_id {
                return Err(Error::RecoveryRequired);
            }
            let entry = json!({"seq":seq,"kind":kind,"snapshot":payload});
            let size = serde_json::to_vec(&entry)?.len();
            if bytes + size > MAX_BODY - 1024 {
                if entries.is_empty() {
                    return Ok(failure(json!(id), -32012, "EVENT_TOO_LARGE"));
                }
                break;
            }
            bytes += size;
            entries.push(entry);
            next = seq;
        }
        // next_seq advances only across entries actually returned. Control
        // receipts, keys and other tasks' events are never included in this feed.
        Ok(success(id, json!({"events":entries,"next_seq":next})))
    }
}

fn exists(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
        [id],
        |r| r.get(0),
    )?)
}
fn lookup(
    conn: &Connection,
    key: &str,
    principal: &str,
    request_id: &str,
    fingerprint: &str,
) -> Result<Option<Outcome>> {
    let mut statement = conn.prepare("SELECT payload FROM events WHERE aggregate_id=?1 AND kind='control.completed' ORDER BY seq LIMIT 2")?;
    let rows = statement
        .query_map([key], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > 1 {
        return Err(Error::RecoveryRequired);
    }
    let Some(raw) = rows.first() else {
        return Ok(None);
    };
    let receipt: Receipt = serde_json::from_str(raw).map_err(|_| Error::RecoveryRequired)?;
    if receipt.version != 1 || receipt.principal != principal || receipt.request_id != request_id {
        return Err(Error::RecoveryRequired);
    }
    receipt.outcome.validate()?;
    if receipt.fingerprint != fingerprint {
        return Err(Error::Denied("REQUEST_ID_REUSED"));
    }
    Ok(Some(receipt.outcome))
}
fn success(id: &str, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn failure(id: Value, code: i64, message: &'static str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn signed(session: &mut ServerSession, mut response: Value) -> Result<Vec<u8>> {
    let mut body = serde_json::to_vec(&response)?;
    if body.len() > MAX_BODY {
        response = failure(response["id"].clone(), -32012, "RESPONSE_TOO_LARGE");
        body = serde_json::to_vec(&response)?;
    }
    session.seal(&body)
}

// Shared transactional mutations: the old trusted-host APIs delegate here too.
// No nested transaction or separate post-commit request-cache write is used.
pub(crate) fn create_task_tx(tx: &Transaction<'_>, contract: &Value, budget: i64) -> Result<Value> {
    counter(budget)?;
    checked("TaskContract", contract)?;
    let id = text(contract, "task_id")?;
    let value = json!({"schema_version":1,"task_id":id,"version":1,"execution_status":"READY","completion_status":"PENDING","cancel_epoch":0,"unresolved_effects":[],"unmet_required_criteria":contract["acceptance"]});
    checked("TaskSnapshot", &value)?;
    tx.execute(
        "INSERT INTO tasks(id,contract,snapshot,budget_micro_usd) VALUES(?1,?2,?3,?4)",
        params![id, contract.to_string(), value.to_string(), budget],
    )?;
    event(tx, id, "task.created", &value)?;
    Ok(value)
}
pub(crate) fn cancel_task_tx(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let mut value = snapshot(tx, id)?;
    if number(&value, "cancel_epoch")? > 0 {
        return Ok(value);
    }
    value["cancel_epoch"] = json!(crate::increment(number(&value, "cancel_epoch")?)?);
    value["execution_status"] = json!("CANCELLED");
    value
        .as_object_mut()
        .ok_or(Error::RecoveryRequired)?
        .remove("wait");
    let value = save_task(tx, value, "task.cancelled")?;
    tx.execute(
        "UPDATE grants SET revoked=1 WHERE action_id IN (SELECT id FROM actions WHERE task_id=?1)",
        [id],
    )?;
    tx.execute("UPDATE runs SET active=0 WHERE task_id=?1", [id])?;
    enqueue(tx, &value, "stopped")?;
    Ok(value)
}

#[cfg(test)]
mod tests;
