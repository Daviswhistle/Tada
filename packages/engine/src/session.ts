// A deterministic TypeScript worker session, not a model loop or a tool executor.
// All authority and durable effects remain in the Rust host.
import { parseContract } from '../../contracts/src/index.mjs';
import type { WorkerContractMap, WorkerProposal, WorkerGrant, WorkerRequest, WorkerResult } from '../../contracts/src/generated/worker.js';

export interface SessionIO {
  receive(): Promise<unknown>;
  send(message: unknown): Promise<void>;
}
function parse<K extends keyof WorkerContractMap>(name: K, value: unknown): WorkerContractMap[K] {
  try { return parseContract(name, value); }
  catch { throw new Error('ENGINE_INVALID_MESSAGE'); }
}
function bindGrant(proposal: WorkerProposal, grant: WorkerGrant): void {
  if (grant.task_id !== proposal.task_id || grant.tool !== proposal.tool
      || grant.tool_version !== proposal.tool_version || grant.resource !== proposal.resource
      || grant.purpose !== proposal.purpose || grant.cancel_epoch !== 0) {
    throw new Error('ENGINE_GRANT_BINDING');
  }
}
function bindResult(request: WorkerRequest, value: unknown, replayed: boolean): WorkerResult {
  const reply = parse('WorkerReply', value);
  const result = reply.result;
  if (reply.id !== request.id || result.call_id !== request.params.proposal.call_id
      || result.grant_ref !== request.params.grant_ref
      || result.contract_hash !== request.params.proposal.arguments.expected_hash
      || result.replayed !== replayed) {
    throw new Error('ENGINE_REPLY_BINDING');
  }
  return result;
}

/** Exercise an immutable digest call and durable replay, then return the host's
 * exact committed result. The host still requires EOF and successful reaping.
 * Pipeline mode is only a loss fixture: it sends a duplicate request before
 * receiving the first response. There is no timer-based automatic tool retry.
 */
export async function runDigestSession(io: SessionIO, pipelineReplay = false): Promise<void> {
  const proposal = parse('WorkerProposal', await io.receive());
  await io.send(proposal);
  const authorization = parse('WorkerAuthorization', await io.receive());
  if (authorization.decision !== 'ALLOW') return;
  const grant = authorization.grant;
  if (!grant) throw new Error('ENGINE_MISSING_GRANT');
  bindGrant(proposal, grant);
  const request: WorkerRequest = {
    jsonrpc: '2.0', id: 'invoke-first', method: 'tool.invoke',
    params: {
      grant_ref: grant.grant_id, proposal,
      policy_revision: grant.policy_revision, generation: grant.generation,
      cancel_epoch: grant.cancel_epoch, fencing_token: grant.fencing_token,
    },
  };
  await io.send(parse('WorkerRequest', request));
  let first: WorkerResult | undefined;
  if (!pipelineReplay) first = bindResult(request, await io.receive(), false);
  const replay = { ...request, id: 'invoke-replay' };
  await io.send(parse('WorkerRequest', replay));
  const result = bindResult(replay, await io.receive(), true);
  if (first && first.evidence_ref !== result.evidence_ref) {
    throw new Error('ENGINE_REPLAY_EVIDENCE_CHANGED');
  }
  await io.send(result);
}
