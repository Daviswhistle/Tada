// API-key-only, foreground public research. No local tool dispatch or SDK retries.
import { parseUniqueJson } from '../../engine/src/json.mjs';

export const RESEARCH_ENDPOINT = 'https://api.openai.com/v1/responses';
export const RESEARCH_LIMITS = Object.freeze({
  requests: 8, outputTokens: 4096, toolCalls: 4,
  timeoutMs: 120_000, responseBytes: 262_144, contextBytes: 196_608,
  utteranceBytes: 16_384,
});
export type JsonObject = { [key: string]: unknown };
export interface ResearchUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface ResearchCitation { url: string; title: string; start: number; end: number }
export interface ResearchPart { text: string; citations: ResearchCitation[] }
export interface ResearchAnswer {
  responseId: string;
  requestedModel: string;
  returnedModel: string;
  kind: 'answer' | 'refusal';
  parts: ResearchPart[];
  sources: { url: string; title: string }[];
  searches: number;
  usage: ResearchUsage | null;
  // These opaque provider items are private continuation, never a UI/log field.
  continuation: JsonObject[];
}
export type FaultCode = 'RESEARCH_INVALID_CONFIG' | 'RESEARCH_INVALID_INPUT'
  | 'RESEARCH_CONTEXT_LIMIT' | 'RESEARCH_INVALID_RESPONSE' | 'RESEARCH_UNSUPPORTED_OUTPUT'
  | 'RESEARCH_SOURCE_MISSING' | 'RESEARCH_INCOMPLETE' | 'RESEARCH_CANCELLED'
  | 'RESEARCH_TIMEOUT' | 'RESEARCH_TRANSPORT' | 'RESEARCH_HTTP_AUTH'
  | 'RESEARCH_HTTP_CAPACITY' | 'RESEARCH_HTTP_REQUEST' | 'RESEARCH_HTTP_SERVER'
  | 'RESEARCH_RESPONSE_LIMIT' | 'RESEARCH_CLEANUP_UNCONFIRMED';
export class ResearchFault extends Error {
  readonly code: FaultCode;
  usage: ResearchUsage | null = null;
  responseId: string | null = null;
  cleanupConfirmed = true;
  constructor(code: FaultCode) { super(code); this.name = 'ResearchFault'; this.code = code; }
}
const fail = (code: FaultCode): never => { throw new ResearchFault(code); };
export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('RESEARCH_INVALID_RESPONSE');
  return value as JsonObject;
}
function string(value: unknown, max = 262_144): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return fail('RESEARCH_INVALID_RESPONSE');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('RESEARCH_INVALID_RESPONSE');
  return value;
}
export function validateModel(model: unknown): asserts model is string {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(model)) fail('RESEARCH_INVALID_CONFIG');
}
export function citationUrl(value: unknown): string {
  const raw = string(value, 8192);
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(raw)) return fail('RESEARCH_INVALID_RESPONSE');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('RESEARCH_INVALID_RESPONSE'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail('RESEARCH_INVALID_RESPONSE');
  // Display-only: these URLs are never fetched by this client or executed.
  return url.href;
}
function usage(value: unknown): ResearchUsage | null {
  if (value === null || value === undefined) return null;
  const u = object(value);
  const inputTokens = integer(u.input_tokens);
  const outputTokens = integer(u.output_tokens);
  const totalTokens = integer(u.total_tokens);
  if (!Number.isSafeInteger(inputTokens + outputTokens) || inputTokens + outputTokens !== totalTokens) return fail('RESEARCH_INVALID_RESPONSE');
  return { inputTokens, outputTokens, totalTokens };
}

export function researchRequest(model: string, instructions: string, input: readonly JsonObject[]): JsonObject {
  validateModel(model);
  if (typeof instructions !== 'string' || instructions.length > 8192 || !Array.isArray(input) || input.length === 0) fail('RESEARCH_INVALID_INPUT');
  const body: JsonObject = {
    model, instructions, input, store: false, stream: false,
    tools: [{ type: 'web_search' }], tool_choice: 'auto',
    max_output_tokens: RESEARCH_LIMITS.outputTokens,
    max_tool_calls: RESEARCH_LIMITS.toolCalls,
    truncation: 'disabled',
    include: ['web_search_call.action.sources', 'reasoning.encrypted_content'],
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > RESEARCH_LIMITS.contextBytes) fail('RESEARCH_CONTEXT_LIMIT');
  return body;
}

export function decodeResearchResponse(raw: string, model: string): ResearchAnswer {
  let response: JsonObject;
  try { response = object(parseUniqueJson(raw, RESEARCH_LIMITS.responseBytes)); }
  catch { return fail('RESEARCH_INVALID_RESPONSE'); }
  let observed: ResearchUsage | null = null;
  let responseId: string | null = null;
  try {
    observed = usage(response.usage);
    responseId = string(response.id, 256);
    if (response.object !== 'response') fail('RESEARCH_INVALID_RESPONSE');
    if (response.status !== 'completed' || (response.error !== null && response.error !== undefined)) fail('RESEARCH_INCOMPLETE');
    const returnedModel = string(response.model, 256);
    if (!Array.isArray(response.output) || response.output.length === 0 || response.output.length > 64) fail('RESEARCH_INVALID_RESPONSE');
    const output = response.output as unknown[];
    const parts: ResearchPart[] = [];
    const sources = new Map<string, { url: string; title: string }>();
    let searches = 0;
    let refused = false;
    const itemIds = new Set<string>();
    for (const candidate of output) {
      const item = object(candidate);
      const id = string(item.id, 256);
      if (itemIds.has(id)) fail('RESEARCH_INVALID_RESPONSE');
      itemIds.add(id);
      if (item.type === 'reasoning') {
        // Requested stateless opaque continuation is kept intact, never decoded.
        string(item.encrypted_content, RESEARCH_LIMITS.responseBytes);
        if (!Array.isArray(item.summary)) fail('RESEARCH_INVALID_RESPONSE');
      } else if (item.type === 'web_search_call') {
        if (item.status !== 'completed') fail('RESEARCH_INCOMPLETE');
        searches++;
        const action = object(item.action);
        if (!['search', 'open_page', 'find_in_page'].includes(String(action.type))) fail('RESEARCH_UNSUPPORTED_OUTPUT');
        if (action.sources !== undefined) {
          if (!Array.isArray(action.sources) || action.sources.length > 128) fail('RESEARCH_INVALID_RESPONSE');
          for (const candidateSource of action.sources as unknown[]) {
            const source = object(candidateSource);
            const url = citationUrl(source.url);
            const title = source.title === undefined ? url : string(source.title, 4096);
            sources.set(url, { url, title });
          }
        }
      } else if (item.type === 'message') {
        if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content) || item.content.length > 64) fail('RESEARCH_INVALID_RESPONSE');
        for (const candidatePart of item.content as unknown[]) {
          const part = object(candidatePart);
          if (item.phase !== undefined && item.phase !== null && !['commentary', 'final_answer'].includes(String(item.phase))) fail('RESEARCH_UNSUPPORTED_OUTPUT');
          if (item.phase === 'commentary') continue;
          if (part.type === 'refusal') {
            refused = true;
            parts.push({ text: string(part.refusal), citations: [] });
            continue;
          }
          if (part.type !== 'output_text') fail('RESEARCH_UNSUPPORTED_OUTPUT');
          const text = string(part.text);
          if (!Array.isArray(part.annotations) || part.annotations.length > 128) fail('RESEARCH_INVALID_RESPONSE');
          const citations: ResearchCitation[] = [];
          for (const candidateAnnotation of part.annotations as unknown[]) {
            const a = object(candidateAnnotation);
            if (a.type !== 'url_citation') fail('RESEARCH_UNSUPPORTED_OUTPUT');
            const url = citationUrl(a.url);
            const title = string(a.title, 4096);
            const start = integer(a.start_index), end = integer(a.end_index);
            if (start > end || end > text.length) fail('RESEARCH_INVALID_RESPONSE');
            citations.push({ url, title, start, end });
            sources.set(url, { url, title });
          }
          parts.push({ text, citations });
        }
      } else {
        // Never execute a function, computer, MCP, file or code tool here.
        fail('RESEARCH_UNSUPPORTED_OUTPUT');
      }
    }
    if (!parts.length || searches > RESEARCH_LIMITS.toolCalls) fail('RESEARCH_INVALID_RESPONSE');
    if (searches > 0 && !refused && !parts.some(part => part.citations.length > 0)) fail('RESEARCH_SOURCE_MISSING');
    return {
      responseId, requestedModel: model, returnedModel,
      kind: refused ? 'refusal' : 'answer', parts, sources: [...sources.values()],
      searches, usage: observed, continuation: output as JsonObject[],
    };
  } catch (error) {
    const fault = error instanceof ResearchFault ? error : new ResearchFault('RESEARCH_INVALID_RESPONSE');
    fault.usage = observed;
    fault.responseId = responseId;
    throw fault;
  }
}

// Waits are bounded even in test transports that ignore AbortSignal. Any late
// failure remains observed. A late HTTP response body is closed by the owner.
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Observe even an already-created promise when cancellation won synchronously.
  // The caller must still own/close any eventual returned resource.
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ResearchFault('RESEARCH_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}
async function cleanup(close: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(close).then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 100); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
export type ResearchExchange = (body: JsonObject, signal: AbortSignal) => Promise<ResearchAnswer>;
export interface ResearchProvider { readonly exchange: ResearchExchange; dispose(): void }
export function openAIResearchProvider(apiKey: string, fetchImpl: typeof fetch = globalThis.fetch): ResearchProvider {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{8,4096}$/u.test(apiKey) || typeof fetchImpl !== 'function') fail('RESEARCH_INVALID_CONFIG');
  let secret = apiKey;
  apiKey = '';
  let cancelActive: (() => void) | null = null;
  let busy = false;
  let unusable = false;
  return {
    dispose() { secret = ''; unusable = true; cancelActive?.(); },
    async exchange(body, externalSignal) {
      if (busy || unusable || !secret) fail('RESEARCH_INVALID_CONFIG');
      if (externalSignal.aborted) fail('RESEARCH_CANCELLED');
      // Rebuild from the host-owned contract; do not accept endpoint/tool overrides.
      const expected = researchRequest(String(body.model), String(body.instructions), body.input as JsonObject[]);
      if (JSON.stringify(body) !== JSON.stringify(expected)) fail('RESEARCH_INVALID_CONFIG');
      busy = true;
      const abort = new AbortController();
      cancelActive = () => abort.abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; abort.abort(); }, RESEARCH_LIMITS.timeoutMs);
      const cancel = () => abort.abort();
      externalSignal.addEventListener('abort', cancel, { once: true });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      let completeBody = false;
      let pendingFetch = false;
      let parsed: ResearchAnswer | undefined;
      try {
        if (externalSignal.aborted) cancel();
        if (abort.signal.aborted) fail('RESEARCH_CANCELLED');
        const pending = fetchImpl(RESEARCH_ENDPOINT, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(expected), signal: abort.signal,
        });
        pendingFetch = true;
        pending.then(late => {
          pendingFetch = false;
          if (abort.signal.aborted && !response) void cleanup(() => late.body?.cancel() ?? Promise.resolve());
        }, () => { pendingFetch = false; });
        response = await abortable(pending, abort.signal);
        if (!response.ok) {
          const code: FaultCode = [401, 403].includes(response.status) ? 'RESEARCH_HTTP_AUTH'
            : response.status === 429 ? 'RESEARCH_HTTP_CAPACITY'
            : response.status >= 500 ? 'RESEARCH_HTTP_SERVER' : 'RESEARCH_HTTP_REQUEST';
          fail(code);
        }
        if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) fail('RESEARCH_INVALID_RESPONSE');
        const responseBody = response.body;
        if (!responseBody) return fail('RESEARCH_INVALID_RESPONSE');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > RESEARCH_LIMITS.responseBytes)) fail('RESEARCH_RESPONSE_LIMIT');
        reader = responseBody.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let raw = '', bytes = 0;
        for (;;) {
          const chunk = await abortable(reader.read(), abort.signal);
          if (chunk.done) { completeBody = true; break; }
          bytes += chunk.value.byteLength;
          if (bytes > RESEARCH_LIMITS.responseBytes) fail('RESEARCH_RESPONSE_LIMIT');
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
        parsed = decodeResearchResponse(raw, String(expected.model));
        if (abort.signal.aborted) fail('RESEARCH_CANCELLED');
        return parsed;
      } catch (error) {
        abort.abort();
        const fault = new ResearchFault(timedOut ? 'RESEARCH_TIMEOUT'
          : externalSignal.aborted ? 'RESEARCH_CANCELLED'
          : error instanceof ResearchFault ? error.code : 'RESEARCH_TRANSPORT');
        const evidence = error instanceof ResearchFault ? error : null;
        fault.usage = parsed?.usage ?? evidence?.usage ?? null;
        fault.responseId = parsed?.responseId ?? evidence?.responseId ?? null;
        fault.cleanupConfirmed = !pendingFetch;
        if (reader && !completeBody) fault.cleanupConfirmed = await cleanup(() => reader!.cancel()) && fault.cleanupConfirmed;
        else if (!reader && response?.body) fault.cleanupConfirmed = await cleanup(() => response!.body!.cancel()) && fault.cleanupConfirmed;
        if (!fault.cleanupConfirmed) unusable = true;
        throw fault;
      } finally {
        clearTimeout(timer);
        externalSignal.removeEventListener('abort', cancel);
        if (reader && completeBody) reader.releaseLock();
        cancelActive = null;
        busy = false;
      }
    },
  };
}
