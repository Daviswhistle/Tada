//! ENGINE-01A: bounded duplex worker-v1 exchange over host-owned child pipes.
//! Only the SEC-01A digest read is executable. Channel identity never comes from
//! JSON. Process exit/reaping and checkpoint ownership remain in process_runner.
use crate::{process_runner::with_store, worker_wire};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tada_contracts::{worker::*, SafeInteger};
use tada_store::{
    control::worker::{decode_worker_message, WorkerChannel, MAX_WORKER_BODY},
    priority::Priority,
    Error, Store,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::{ChildStdin, ChildStdout},
    sync::{oneshot, watch},
};

type Result<T> = std::result::Result<T, Error>;
const MAX_MESSAGES: usize = 8;

#[derive(Clone)]
pub(crate) enum Program {
    BuiltIn,
    /// Explicit developer-supplied runtime; not a bundled or sandboxed release.
    Node(PathBuf),
}

pub(crate) fn proposal(task: &str, hash: &str, nonce: &str) -> WorkerProposal {
    WorkerProposal {
        schema_version: SafeInteger::new(1).expect("constant"),
        call_id: format!("digest-{nonce}"),
        task_id: task.into(),
        tool: "task.contract_digest".into(),
        tool_version: SafeInteger::new(1).expect("constant"),
        resource: format!("task://{task}/contract"),
        purpose: "verify_input_snapshot".into(),
        arguments: WorkerArguments {
            expected_hash: hash.into(),
        },
    }
}

/// This policy belongs only to the explicit disposable demo, never to submit,
/// a model-authored profile, or an automatically enabled production default.
pub(crate) fn demo_policy(task: &str, mode: &str) -> Result<WorkerPolicy> {
    let decision = match mode {
        "deny" => "DENY",
        "decision" => "REQUIRE_DECISION",
        "handoff" => "HANDOFF",
        _ => "ALLOW",
    };
    tada_contracts::decode(&serde_json::json!({
        "schema_version":1,"profile_id":"mock-test","revision":1,
        "origin":"local_policy","denied_tools":[],
        "rules":[{"tool":"task.contract_digest","tool_version":1,
            "resource":format!("task://{task}/contract"),
            "purpose":"verify_input_snapshot","decision":decision}],
        "max_calls":1,"grant_ttl_ms":30000
    }))
    .map_err(|_| Error::Invalid("ENGINE_DEMO_POLICY"))
}

pub(crate) async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let n = reader.read_u32().await? as usize;
    if n == 0 || n > MAX_WORKER_BODY {
        return Err(Error::Invalid("ENGINE_FRAME_LIMIT"));
    }
    let mut bytes = vec![0; n];
    reader.read_exact(&mut bytes).await?;
    Ok(bytes)
}
async fn send_frame(writer: &mut (impl AsyncWrite + Unpin), body: &[u8]) -> Result<()> {
    writer
        .write_all(&worker_wire::packet(body, MAX_WORKER_BODY)?)
        .await?;
    writer.flush().await?;
    Ok(())
}
fn read_sync(reader: &mut impl Read) -> Result<Vec<u8>> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let n = u32::from_be_bytes(header) as usize;
    if n == 0 || n > MAX_WORKER_BODY {
        return Err(Error::Invalid("ENGINE_FRAME_LIMIT"));
    }
    let mut body = vec![0; n];
    reader.read_exact(&mut body)?;
    Ok(body)
}
fn send_sync(writer: &mut impl Write, value: &impl serde::Serialize) -> Result<()> {
    writer.write_all(&worker_wire::packet(
        &serde_json::to_vec(value)?,
        MAX_WORKER_BODY,
    )?)?;
    writer.flush()?;
    Ok(())
}

pub(crate) struct Exchange {
    pub store: Arc<Mutex<Store>>,
    pub channel: WorkerChannel,
    pub seed: WorkerProposal,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub started: Option<oneshot::Sender<u32>>,
    pub pid: u32,
    pub stop: watch::Receiver<bool>,
    pub mode: String,
    /// Fixture-only handshake: host control can commit cancellation/revocation
    /// after grant delivery and before this invocation enters the store gate.
    #[cfg(feature = "process-fixtures")]
    pub invocation_barrier: Option<crate::process_runner::StartupBarrier>,
}
impl Exchange {
    pub(crate) async fn run(mut self) -> Result<()> {
        send_frame(&mut self.stdin, &serde_json::to_vec(&self.seed)?).await?;
        if let Some(started) = self.started.take() {
            let _ = started.send(self.pid);
        }
        let bytes = read_frame(&mut self.stdout).await?;
        let proposed: WorkerProposal = decode_worker_message(&bytes)?;
        let channel = self.channel.clone();
        let stop = self.stop.clone();
        let authorization = with_store(Arc::clone(&self.store), Priority::Ordinary, move |s| {
            if *stop.borrow() {
                return Err(Error::Denied("ENGINE_STOPPED"));
            }
            s.authorize_worker_call(&channel, &proposed)
        })
        .await?;
        let grant = authorization.grant.clone();
        send_frame(&mut self.stdin, &serde_json::to_vec(&authorization)?).await?;
        if authorization.decision != WorkerDecision::Allow {
            return Err(Error::Denied("ENGINE_AUTHORITY_DENIED"));
        }
        let grant = grant.ok_or(Error::RecoveryRequired)?;
        let mut last: Option<WorkerResult> = None;
        #[cfg(feature = "process-fixtures")]
        let mut first = true;
        for _ in 0..MAX_MESSAGES {
            let bytes = read_frame(&mut self.stdout).await?;
            if decode_worker_message::<WorkerRequest>(&bytes).is_ok() {
                #[cfg(feature = "process-fixtures")]
                if first {
                    first = false;
                    if let Some(barrier) = self.invocation_barrier.take() {
                        barrier
                            .reached
                            .send(self.pid)
                            .map_err(|_| Error::Invalid("ENGINE_BARRIER_LOST"))?;
                        tokio::time::timeout(std::time::Duration::from_secs(5), barrier.resume)
                            .await
                            .map_err(|_| Error::Invalid("ENGINE_BARRIER_TIMEOUT"))?
                            .map_err(|_| Error::Invalid("ENGINE_BARRIER_LOST"))?;
                    }
                    if self.mode == "revoke" {
                        let channel = self.channel.clone();
                        let id = grant.grant_id.clone();
                        with_store(Arc::clone(&self.store), Priority::Cancellation, move |s| {
                            s.revoke_worker_grant(&channel, &id)
                        })
                        .await?;
                    }
                }
                let channel = self.channel.clone();
                let stop = self.stop.clone();
                let response = with_store(Arc::clone(&self.store), Priority::Ordinary, move |s| {
                    if *stop.borrow() {
                        return Err(Error::Denied("ENGINE_STOPPED"));
                    }
                    s.invoke_worker(&channel, &bytes)
                })
                .await?;
                let reply: WorkerReply = decode_worker_message(&response)?;
                if reply.result.grant_ref != grant.grant_id {
                    return Err(Error::RecoveryRequired);
                }
                let first_result = last.is_none();
                last = Some(reply.result);
                // Drop only a fixture response AFTER its durable commit. The
                // worker has sent a second ID for the same immutable call.
                if cfg!(feature = "process-fixtures") && self.mode == "lost-reply" && first_result {
                    continue;
                }
                send_frame(&mut self.stdin, &response).await?;
            } else {
                let claimed: WorkerResult = decode_worker_message(&bytes)?;
                if last.as_ref() != Some(&claimed) {
                    return Err(Error::Invalid("ENGINE_UNPROVEN_RESULT"));
                }
                self.stdin.shutdown().await?;
                drop(self.stdin);
                let mut extra = [0; 1];
                if self.stdout.read(&mut extra).await? != 0 {
                    return Err(Error::Invalid("ENGINE_TRAILING_DATA"));
                }
                return Ok(());
            }
        }
        Err(Error::Invalid("ENGINE_MESSAGE_LIMIT"))
    }
}

/// Built-in protocol reference worker, launched before any runtime is created.
/// It receives no installation key, database handle, executable or tool registry.
pub fn worker_stdio(mode: &str) -> Result<()> {
    if mode != "normal" && !cfg!(feature = "process-fixtures") {
        return Err(Error::Invalid("ENGINE_FIXTURE_DISABLED"));
    }
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let proposal: WorkerProposal = decode_worker_message(&read_sync(&mut input)?)?;
    #[cfg(feature = "process-fixtures")]
    let proposal = {
        let mut proposal = proposal;
        match mode {
            "wrong-task" => proposal.task_id.push_str("-other"),
            "wrong-resource" => proposal.resource.push_str("/other"),
            "unknown-tool" => proposal.tool = "credential.export".into(),
            "duplicate" => {
                output.write_all(&worker_wire::packet(
                    br#"{"schema_version":1,"schema_version":1}"#,
                    MAX_WORKER_BODY,
                )?)?;
                output.flush()?;
                return Ok(());
            }
            "partial" => {
                output.write_all(&[0, 0, 0, 100, b'{'])?;
                output.flush()?;
                return Ok(());
            }
            "oversized" => {
                output.write_all(&[255; 4])?;
                output.flush()?;
                return Ok(());
            }
            "hang" => loop {
                std::thread::park();
            },
            _ => (),
        }
        proposal
    };
    send_sync(&mut output, &proposal)?;
    let auth: WorkerAuthorization = decode_worker_message(&read_sync(&mut input)?)?;
    if auth.decision != WorkerDecision::Allow {
        return Ok(());
    }
    let grant = auth.grant.ok_or(Error::Invalid("ENGINE_MISSING_GRANT"))?;
    let mut request = WorkerRequest {
        jsonrpc: "2.0".into(),
        id: "invoke-first".into(),
        method: "tool.invoke".into(),
        params: WorkerCall {
            grant_ref: grant.grant_id,
            proposal,
            policy_revision: grant.policy_revision,
            generation: grant.generation,
            cancel_epoch: grant.cancel_epoch,
            fencing_token: grant.fencing_token,
        },
    };
    #[cfg(feature = "process-fixtures")]
    if mode == "forged-final" {
        let claimed = WorkerResult {
            schema_version: SafeInteger::new(1).expect("constant"),
            call_id: request.params.proposal.call_id.clone(),
            grant_ref: request.params.grant_ref.clone(),
            status: "ok".into(),
            side_effect_state: "none".into(),
            contract_hash: request.params.proposal.arguments.expected_hash.clone(),
            evidence_ref: "invented-proof".into(),
            replayed: false,
        };
        send_sync(&mut output, &claimed)?;
        return Ok(());
    }
    #[cfg(feature = "process-fixtures")]
    if mode == "changed-call" {
        request.params.proposal.arguments.expected_hash = "0".repeat(64);
    }
    send_sync(&mut output, &request)?;
    let lost = cfg!(feature = "process-fixtures") && mode == "lost-reply";
    if !lost {
        let first: WorkerReply = decode_worker_message(&read_sync(&mut input)?)?;
        if first.id != request.id || first.result.replayed {
            return Err(Error::Invalid("ENGINE_FIRST_REPLY"));
        }
    }
    // A second transport ID with the SAME logical call tests durable replay.
    request.id = "invoke-replay".into();
    send_sync(&mut output, &request)?;
    let reply: WorkerReply = decode_worker_message(&read_sync(&mut input)?)?;
    if reply.id != request.id
        || !reply.result.replayed
        || reply.result.call_id != request.params.proposal.call_id
        || reply.result.grant_ref != request.params.grant_ref
        || reply.result.contract_hash != request.params.proposal.arguments.expected_hash
    {
        return Err(Error::Invalid("ENGINE_REPLY_BINDING"));
    }
    #[cfg(feature = "process-fixtures")]
    if mode == "message-flood" {
        for _ in 0..MAX_MESSAGES {
            send_sync(&mut output, &request)?;
            let _ = read_sync(&mut input)?;
        }
    }
    send_sync(&mut output, &reply.result)?;
    #[cfg(feature = "process-fixtures")]
    match mode {
        "trailing" => {
            output.write_all(&[0])?;
            output.flush()?;
        }
        "reply-hang" => loop {
            std::thread::park();
        },
        "env-canary" => {
            if [
                "TADA_SECRET_CANARY",
                "OPENAI_API_KEY",
                "NODE_OPTIONS",
                "PYTHONPATH",
            ]
            .iter()
            .any(|k| std::env::var_os(k).is_some())
            {
                return Err(Error::Invalid("ENGINE_ENV_LEAK"));
            }
        }
        _ => (),
    }
    Ok(())
}
