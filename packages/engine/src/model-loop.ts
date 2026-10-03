// ENGINE-01B: bounded in-process mock controller. Rust owns durable task state.
import { parseContract } from '../../contracts/src/index.mjs';
import type { WorkerProposal, WorkerResult } from '../../contracts/src/generated/worker.js';
import { parseUniqueJson } from './json.mjs';
import { bounded, collectModelTurn, ModelFault } from '../../providers/src/stream.ts';
import type { ProviderAdapter, ModelRequest, Usage } from '../../providers/src/stream.ts';

export interface LoopLimits {
  readonly max_turns: number;
  readonly max_tool_calls: number;
  readonly max_recoveries: number;
  readonly max_active_ms: number;
  readonly max_events: number;
  readonly max_bytes: number;
  readonly max_call_bytes: number;
}
export interface LoopMeter {
  turns: number;
  tool_calls: number;
  recoveries: number;
  input_tokens: number;
  output_tokens: number;
  uncertain_requests: number;
  usage_overflow: boolean;
}
export type LoopState = 'verify' | 'waiting' | 'diagnose' | 'budget' | 'cancelled' | 'reconcile' | 'unsupported';
export interface LoopOutcome {
  state: LoopState;
  reason: string;
  meter: LoopMeter;
  evidence: WorkerResult[];
  retry_after_ms?: number;
}
export interface ToolPort {
  // The caller must revalidate authority at actual dispatch and return only a
  // committed result. Cancelling this promise never proves effects were undone.
  invoke(proposal: WorkerProposal, signal: AbortSignal): Promise<WorkerResult>;
}
const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, reported: false });
function validLimits(l: LoopLimits): boolean {
  return [[l.max_turns,0,80],[l.max_tool_calls,0,16],[l.max_recoveries,0,16],[l.max_active_ms,1,30000],[l.max_events,1,4096],[l.max_bytes,1,1048576],[l.max_call_bytes,1,16384]]
    .every(([v, min, max]) => v !== undefined && min !== undefined && max !== undefined && Number.isSafeInteger(v) && v >= min && v <= max);
}
function proposalFrom(raw: string, callId: string, seed: WorkerProposal): WorkerProposal {
  let proposal: WorkerProposal;
  try { proposal = parseContract('WorkerProposal', parseUniqueJson(raw)); }
  catch { throw new ModelFault('MODEL_TOOL_SCHEMA', 'protocol', emptyUsage()); }
  if (proposal.call_id !== callId || proposal.task_id !== seed.task_id || proposal.tool !== seed.tool
      || proposal.tool_version !== seed.tool_version || proposal.resource !== seed.resource
      || proposal.purpose !== seed.purpose || proposal.arguments.expected_hash !== seed.arguments.expected_hash) {
    throw new ModelFault('MODEL_TOOL_SCOPE', 'unsupported', emptyUsage());
  }
  return proposal;
}

/** No restart/import API is provided: these meters and observations are session
 * state, not a durable checkpoint. This loop can use only its fixed adapter and
 * exact digest seed. It cannot switch account, model, tool, resource or policy.
 */
export async function runModelLoop(
  adapter: ProviderAdapter, input: WorkerProposal, port: ToolPort,
  requestedLimits: LoopLimits, signal: AbortSignal,
): Promise<LoopOutcome> {
  const limits = { ...requestedLimits };
  if (!validLimits(limits)) throw new Error('MODEL_LOOP_LIMITS');
  const seed = parseContract('WorkerProposal', input);
  const deadline = performance.now() + limits.max_active_ms;
  const meter: LoopMeter = { turns: 0, tool_calls: 0, recoveries: 0, input_tokens: 0, output_tokens: 0, uncertain_requests: 0, usage_overflow: false };
  const evidence: WorkerResult[] = [];
  const logicalCalls = new Set<string>();
  let failureSignature = '', repeated = 0;
  const outcome = (state: LoopState, reason: string, retry?: number): LoopOutcome => ({
    state, reason, meter: { ...meter }, evidence: structuredClone(evidence),
    ...(retry === undefined ? {} : { retry_after_ms: retry }),
  });
  const addUsage = (usage: Usage, complete: boolean): boolean => {
    const input = meter.input_tokens + usage.input_tokens;
    const output = meter.output_tokens + usage.output_tokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) {
      meter.usage_overflow = true; meter.uncertain_requests++; return false;
    }
    meter.input_tokens = input; meter.output_tokens = output;
    if (!complete || !usage.reported) meter.uncertain_requests++;
    return true;
  };
  while (true) {
    if (signal.aborted) return outcome('cancelled','MODEL_CANCELLED');
    if (performance.now() >= deadline) return outcome('budget','MODEL_ACTIVE_LIMIT');
    if (meter.turns >= limits.max_turns) return outcome('budget','MODEL_TURN_LIMIT');
    // Reserve before touching the adapter. Failed/unknown turns are not refunded.
    meter.turns++;
    const request: ModelRequest = Object.freeze({
      request_id: `model-${meter.turns}`, task_id: seed.task_id,
      phase: evidence.length ? 'after_tool' : 'proposal', input_hash: seed.arguments.expected_hash,
      proposal_json: JSON.stringify(seed), evidence_refs: Object.freeze(evidence.map((item) => item.evidence_ref)),
    });
    let proposals: WorkerProposal[];
    let modelStopped = false;
    try {
      const turn = await collectModelTurn(adapter, request, signal, deadline, {
        max_events: limits.max_events, max_bytes: limits.max_bytes,
        max_calls: limits.max_tool_calls, max_call_bytes: limits.max_call_bytes,
      });
      if (!addUsage(turn.usage, true)) return outcome('budget','MODEL_USAGE_OVERFLOW');
      // Validate ALL calls before any of them reaches the broker.
      proposals = turn.calls.map((call) => proposalFrom(call.payload_json, call.call_id, seed));
      modelStopped = turn.finish_reason === 'stop';
    } catch (error) {
      if (!(error instanceof ModelFault)) return outcome('diagnose','MODEL_CONTROLLER_FAULT');
      // Tool parsing occurs after successful usage accounting; its faults have
      // no extra usage. Collection faults always retain any observed counters.
      if (!['MODEL_TOOL_SCHEMA','MODEL_TOOL_SCOPE'].includes(error.message)
          && !addUsage(error.usage, false)) return outcome('budget','MODEL_USAGE_OVERFLOW');
      if (signal.aborted || error.category === 'cancelled') return outcome('cancelled','MODEL_CANCELLED');
      if (error.category === 'deadline') return outcome('budget','MODEL_ACTIVE_LIMIT');
      if (error.category === 'capacity') return outcome('waiting','PROVIDER_CAPACITY',error.retry_after_ms);
      if (error.category === 'auth') return outcome('waiting','AUTH');
      if (error.category === 'network') return outcome('waiting','NETWORK');
      if (error.category === 'unsupported') return outcome('unsupported',error.message);
      if (['MODEL_EVENT_LIMIT','MODEL_BYTE_LIMIT','MODEL_CALL_LIMIT','MODEL_ARGUMENT_LIMIT'].includes(error.message)) return outcome('budget',error.message);
      const signature = `${request.phase}:${request.input_hash}:${error.message}`;
      repeated = signature === failureSignature ? repeated + 1 : 1;
      failureSignature = signature;
      if (repeated >= 2) return outcome('diagnose','MODEL_REPEATED_FAILURE');
      if (meter.recoveries >= limits.max_recoveries) return outcome('budget','MODEL_RECOVERY_LIMIT');
      meter.recoveries++;
      continue; // A fresh stream; no partial call survives into this attempt.
    }
    if (signal.aborted) return outcome('cancelled','MODEL_CANCELLED');
    if (modelStopped) return outcome('verify','MODEL_FINISHED_NOT_VERIFIED');
    if (meter.tool_calls + proposals.length > limits.max_tool_calls) return outcome('budget','MODEL_TOOL_LIMIT');
    if (proposals.some((proposal) => logicalCalls.has(proposal.call_id))) return outcome('diagnose','MODEL_DUPLICATE_LOGICAL_CALL');
    for (const proposal of proposals) {
      if (signal.aborted) return outcome('cancelled','MODEL_CANCELLED');
      logicalCalls.add(proposal.call_id);
      meter.tool_calls++;
      try {
        const returned = await bounded(() => port.invoke(structuredClone(proposal), signal), signal, deadline);
        const result = parseContract('WorkerResult', returned);
        if (result.call_id !== proposal.call_id || result.contract_hash !== seed.arguments.expected_hash) {
          return outcome('reconcile','MODEL_TOOL_RESULT_BINDING');
        }
        evidence.push(result);
      } catch {
        // This is outside the model correction loop. Never resend an invocation
        // after ambiguous transport/commit, even if its promise was cancelled.
        return outcome('reconcile','MODEL_TOOL_OUTCOME_UNKNOWN');
      }
    }
    failureSignature = ''; repeated = 0;
    // The next model request sees only the acknowledged broker evidence.
  }
}
