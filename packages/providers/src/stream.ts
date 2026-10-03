// MODEL-01A normalizes events, not authority. No SDK, credential or network here.
import { parseContract } from '../../contracts/src/index.mjs';
import type { ModelEvent } from '../../contracts/src/generated/model.js';

export interface ModelRequest {
  readonly request_id: string;
  readonly task_id: string;
  readonly phase: 'proposal' | 'after_tool';
  readonly input_hash: string;
  readonly proposal_json: string;
  readonly evidence_refs: readonly string[];
}
export interface ProviderAdapter {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<unknown>;
}
export interface StreamLimits {
  readonly max_events: number;
  readonly max_bytes: number;
  readonly max_calls: number;
  readonly max_call_bytes: number;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reported: boolean;
}
export type FaultCategory = 'protocol' | 'network' | 'auth' | 'capacity' | 'unsupported' | 'cancelled' | 'deadline';
const faultCodes = new Set([
  'MODEL_CANCELLED','MODEL_DEADLINE','MODEL_LIMITS','MODEL_AFTER_TERMINAL',
  'MODEL_EVENT_LIMIT','MODEL_EVENT_SCHEMA','MODEL_BYTE_LIMIT','MODEL_EVENT_BINDING',
  'MODEL_CONTINUATION_UNSUPPORTED','MODEL_USAGE_REGRESSION','MODEL_CAPACITY',
  'MODEL_NETWORK','MODEL_AUTH','MODEL_PROTOCOL','MODEL_UNSUPPORTED','MODEL_PARTIAL_CALL',
  'MODEL_FINISH_MISMATCH','MODEL_CALL_LIMIT','MODEL_CALL_ALREADY_COMPLETE',
  'MODEL_ARGUMENT_LIMIT','MODEL_COMPLETE_MISMATCH','MODEL_STREAM_INCOMPLETE',
  'MODEL_TOOL_SCHEMA','MODEL_TOOL_SCOPE',
]);
const categories = new Set(['protocol','network','auth','capacity','unsupported','cancelled','deadline']);
export class ModelFault extends Error {
  readonly category: FaultCategory;
  readonly usage: Usage;
  readonly retry_after_ms: number | undefined;
  constructor(code: string, category: FaultCategory, usage: Usage, retryAfter?: number) {
    super(faultCodes.has(code) ? code : 'MODEL_NETWORK');
    this.name = 'ModelFault';
    this.category = faultCodes.has(code) && categories.has(category) ? category : 'network';
    this.usage = {
      input_tokens: Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 ? usage.input_tokens : 0,
      output_tokens: Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 ? usage.output_tokens : 0,
      reported: usage.reported === true,
    };
    this.retry_after_ms = retryAfter !== undefined && Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86400000 ? retryAfter : undefined;
  }
}
export interface ModelTurn {
  finish_reason: 'stop' | 'tool_calls';
  calls: Array<{ call_id: string; payload_json: string }>;
  usage: Usage;
}
const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, reported: false });
const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Bound an async wait even when an adapter ignores cancellation. This does not
 * prove that a remote request/tool stopped: its usage/effects may remain unknown.
 * The native host retains authority and separately owns actual process cleanup.
 */
export async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted) throw new ModelFault('MODEL_CANCELLED', 'cancelled', emptyUsage());
  if (!Number.isFinite(deadline)) throw new ModelFault('MODEL_LIMITS', 'unsupported', emptyUsage());
  const left = deadline - performance.now();
  if (left <= 0) throw new ModelFault('MODEL_DEADLINE', 'deadline', emptyUsage());
  return new Promise<T>((resolve, reject) => {
    const fail = (code: string, category: FaultCategory): void => { clean(); reject(new ModelFault(code, category, emptyUsage())); };
    const cancel = (): void => fail('MODEL_CANCELLED', 'cancelled');
    const timer = setTimeout(() => fail('MODEL_DEADLINE', 'deadline'), left);
    const clean = (): void => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    signal.addEventListener('abort', cancel, { once: true });
    // Recheck immediately before entering the adapter; never invoke an operation
    // queued by a microtask after its caller has already cancelled.
    Promise.resolve().then(() => {
      if (signal.aborted) throw new ModelFault('MODEL_CANCELLED', 'cancelled', emptyUsage());
      if (performance.now() >= deadline) throw new ModelFault('MODEL_DEADLINE', 'deadline', emptyUsage());
      return operation();
    }).then((value) => {
      clean();
      if (signal.aborted) reject(new ModelFault('MODEL_CANCELLED', 'cancelled', emptyUsage()));
      else if (performance.now() >= deadline) reject(new ModelFault('MODEL_DEADLINE', 'deadline', emptyUsage()));
      else resolve(value);
    }, (error: unknown) => { clean(); reject(error); });
  });
}
function checkLimits(limits: StreamLimits): void {
  for (const [value, minimum, ceiling] of [[limits.max_events,1,4096],[limits.max_bytes,1,1048576],[limits.max_calls,0,16],[limits.max_call_bytes,1,16384]]) {
    if (value === undefined || minimum === undefined || ceiling === undefined || !Number.isSafeInteger(value) || value < minimum || value > ceiling) {
      throw new ModelFault('MODEL_LIMITS', 'unsupported', emptyUsage());
    }
  }
}

/** A successful turn requires a terminal event AND EOF. No call is released
 * while a stream can still invalidate it. Deltas are never repaired or executed.
 * Usage snapshots are cumulative within one request, not additive deltas.
 */
export async function collectModelTurn(
  adapter: ProviderAdapter, request: ModelRequest, signal: AbortSignal,
  deadline: number, limits: StreamLimits,
): Promise<ModelTurn> {
  checkLimits(limits);
  const usage = emptyUsage();
  const child = new AbortController();
  const abort = (): void => child.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) child.abort();
  let iterator: AsyncIterator<unknown> | undefined;
  let ended = false;
  let count = 0, totalBytes = 0;
  let finish: ModelTurn['finish_reason'] | undefined;
  const calls = new Map<string, { chunks: string; size: number; payload: string | undefined }>();
  function fail(code: string): never { throw new ModelFault(code, 'protocol', usage); }
  try {
    iterator = await bounded(async () => adapter.stream(request, child.signal)[Symbol.asyncIterator](), child.signal, deadline);
    while (true) {
      const current = iterator;
      const item = await bounded(() => current.next(), child.signal, deadline);
      if (item.done) { ended = true; break; }
      if (finish !== undefined) fail('MODEL_AFTER_TERMINAL');
      if (++count > limits.max_events) fail('MODEL_EVENT_LIMIT');
      let event: ModelEvent;
      try { event = parseContract('ModelEvent', item.value); }
      catch { fail('MODEL_EVENT_SCHEMA'); }
      totalBytes += bytes(JSON.stringify(event));
      if (totalBytes > limits.max_bytes) fail('MODEL_BYTE_LIMIT');
      if (event.request_id !== request.request_id || event.seq !== count) fail('MODEL_EVENT_BINDING');
      switch (event.type) {
        case 'text_delta': break; // Count but do not log or trust prose as evidence.
        case 'reasoning_handle':
          // No encrypted continuation store is connected in the mock slice.
          // A syntactically plausible reference is not encryption evidence.
          throw new ModelFault('MODEL_CONTINUATION_UNSUPPORTED', 'unsupported', usage);
        case 'usage':
          if (event.input_tokens < usage.input_tokens || event.output_tokens < usage.output_tokens) fail('MODEL_USAGE_REGRESSION');
          usage.input_tokens = event.input_tokens;
          usage.output_tokens = event.output_tokens;
          usage.reported = true;
          break;
        case 'rate_limit': throw new ModelFault('MODEL_CAPACITY', 'capacity', usage, event.retry_after_ms);
        case 'failed': throw new ModelFault(`MODEL_${event.category.toUpperCase()}`, event.category, usage);
        case 'completed':
          if ([...calls.values()].some((call) => call.payload === undefined)) fail('MODEL_PARTIAL_CALL');
          if ((calls.size > 0) !== (event.finish_reason === 'tool_calls')) fail('MODEL_FINISH_MISMATCH');
          finish = event.finish_reason;
          break;
        case 'tool_call_delta':
        case 'tool_call_complete': {
          let call = calls.get(event.call_id);
          if (!call) {
            if (calls.size >= limits.max_calls) fail('MODEL_CALL_LIMIT');
            call = { chunks: '', size: 0, payload: undefined };
            calls.set(event.call_id, call);
          }
          if (call.payload !== undefined) fail('MODEL_CALL_ALREADY_COMPLETE');
          if (event.type === 'tool_call_delta') {
            call.size += bytes(event.chunk);
            if (call.size > limits.max_call_bytes) fail('MODEL_ARGUMENT_LIMIT');
            call.chunks += event.chunk;
          } else {
            if (bytes(event.payload_json) > limits.max_call_bytes) fail('MODEL_ARGUMENT_LIMIT');
            if (call.size > 0 && call.chunks !== event.payload_json) fail('MODEL_COMPLETE_MISMATCH');
            call.payload = event.payload_json;
          }
          break;
        }
      }
    }
    if (finish === undefined) fail('MODEL_STREAM_INCOMPLETE');
    return { finish_reason: finish, usage: { ...usage }, calls: [...calls].map(([call_id, call]) => ({ call_id, payload_json: call.payload! })) };
  } catch (error) {
    // Preserve observed usage even when completion/transport is lost. No raw
    // adapter error (which could contain credentials or prompts) leaves here.
    if (error instanceof ModelFault) throw new ModelFault(error.message, error.category, usage, error.retry_after_ms);
    throw new ModelFault('MODEL_NETWORK', 'network', usage);
  } finally {
    signal.removeEventListener('abort', abort);
    child.abort();
    if (!ended && iterator?.return) {
      // An uncooperative iterator may never settle return(). Do not make the
      // cancellation deadline depend on it, and always observe a late rejection.
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* fixed diagnostics only */ }
    }
  }
}
