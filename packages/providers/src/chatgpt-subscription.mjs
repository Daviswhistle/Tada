import { createHash } from 'node:crypto';
import { API, response, providerError } from './chatgpt-http.mjs';
import { parseUniqueJson } from '../../engine/src/json.mjs';
const validName = name => typeof name === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u.test(name);
export function responsesInput(messages) {
  const input = []; let pending = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool') {
      const call = pending.shift();
      if (!call || message.tool_name !== call.name) throw Error('CHATGPT_HISTORY_INVALID');
      input.push({ type: 'function_call_output', call_id: call.id, output: message.content });
      continue;
    }
    if (pending.length) throw Error('CHATGPT_HISTORY_INVALID');
    if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw Error('CHATGPT_HISTORY_INVALID');
    if (message.provider_state) {
      const state = message.provider_state;
      if (state.version !== 1 || state.provider !== 'chatgpt-subscription' || !Array.isArray(state.items)
        || state.items.length > 24 || message.role !== 'assistant'
        || Object.keys(state).some(key => !['version', 'provider', 'items'].includes(key))) throw Error('CHATGPT_HISTORY_INVALID');
      const calls = [], replayText = [];
      for (const item of state.items) {
        if (item.type === 'reasoning') {
          if (typeof item.id !== 'string' || typeof item.encrypted_content !== 'string' || !item.encrypted_content
            || !Array.isArray(item.summary) || item.summary.length || Object.keys(item).some(key => !['type', 'id', 'encrypted_content', 'summary'].includes(key))) throw Error('CHATGPT_HISTORY_INVALID');
        } else if (item.type === 'function_call') {
          const fn = message.tool_calls?.[calls.length]?.function;
          if (!fn || item.status !== 'completed' || Object.keys(item).some(key => !['type', 'id', 'call_id', 'namespace', 'name', 'arguments', 'status'].includes(key))
            || (item.id !== undefined && typeof item.id !== 'string') || item.namespace !== 'tada' || item.name !== fn.name || typeof item.call_id !== 'string'
            || JSON.stringify(parseUniqueJson(item.arguments, 16384)) !== JSON.stringify(fn.arguments)) throw Error('CHATGPT_HISTORY_INVALID');
          calls.push({ id: item.call_id, name: item.name });
        } else if (item.type === 'message') {
          if (Object.keys(item).some(key => !['type', 'id', 'role', 'status', 'content', 'phase'].includes(key))
            || (item.id !== undefined && typeof item.id !== 'string') || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)
            || (item.phase !== undefined && !['commentary', 'final_answer'].includes(item.phase))) throw Error('CHATGPT_HISTORY_INVALID');
          for (const part of item.content) {
            const text = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
            if (Object.keys(part).some(key => !['type', part.type === 'refusal' ? 'refusal' : 'text', 'annotations'].includes(key))
              || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length)) || typeof text !== 'string') throw Error('CHATGPT_HISTORY_INVALID');
            if (item.phase !== 'commentary') replayText.push(text);
          }
        } else throw Error('CHATGPT_HISTORY_INVALID');
      }
      if (replayText.join('\n') !== message.content) throw Error('CHATGPT_HISTORY_INVALID');
      if (calls.length !== (message.tool_calls ?? []).length) throw Error('CHATGPT_HISTORY_INVALID');
      input.push(...structuredClone(state.items)); pending = calls;
    } else {
      if (message.content) input.push({ role: message.role === 'system' ? 'developer' : message.role, content: message.content });
      for (let n = 0; n < (message.tool_calls ?? []).length; n++) {
        const fn = message.tool_calls[n]?.function;
        if (message.role !== 'assistant' || !validName(fn?.name)) throw Error('CHATGPT_HISTORY_INVALID');
        // Legacy v1 history has no provider continuation. It remains readable;
        // newly returned subscription calls retain their real IDs below.
        const id = `call_tada_${index}_${n}`;
        input.push({ type: 'function_call', call_id: id, namespace: 'tada', name: fn.name, arguments: JSON.stringify(fn.arguments) });
        pending.push({ id, name: fn.name });
      }
    }
  }
  if (pending.length) throw Error('CHATGPT_HISTORY_INVALID');
  return input;
}
export function completedTurn(value, names) {
  if (value?.status !== 'completed' || !Array.isArray(value.output) || !value.usage
    || ![value.usage.input_tokens, value.usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('CHATGPT_INCOMPLETE_TURN');
  const calls = [], text = [], ids = new Set(), retained = []; let refused = false;
  for (const item of value.output) {
    if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string' && item.encrypted_content && typeof item.id === 'string') {
        retained.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: [] });
      } else if (value.output.some(output => output.type === 'function_call')) throw Error('CHATGPT_CONTINUATION_REQUIRED');
      continue; // Retain only encrypted continuation; never plaintext reasoning/summary.
    }
    if (item.type === 'function_call') {
      if (item.namespace !== 'tada' || !names.has(item.name) || typeof item.call_id !== 'string' || ids.has(item.call_id)
        || item.status !== 'completed' || typeof item.arguments !== 'string') throw Error('CHATGPT_TOOL_CALL_INVALID');
      let args;
      try { args = parseUniqueJson(item.arguments, 16384); } catch { throw Error('CHATGPT_TOOL_CALL_INVALID'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('CHATGPT_TOOL_CALL_INVALID');
      ids.add(item.call_id); calls.push({ function: { name: item.name, arguments: args } });
      retained.push({ type: 'function_call', ...(typeof item.id === 'string' ? { id: item.id } : {}), call_id: item.call_id, namespace: 'tada', name: item.name, arguments: item.arguments, status: 'completed' });
    } else if (item.type === 'message' && item.role === 'assistant' && item.status === 'completed' && Array.isArray(item.content)) {
      if (item.phase !== undefined && !['commentary', 'final_answer'].includes(item.phase)) throw Error('CHATGPT_OUTPUT_UNSUPPORTED');
      const parts = [];
      for (const part of item.content) {
        const visible = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
        if (typeof visible !== 'string') throw Error('CHATGPT_OUTPUT_UNSUPPORTED');
        parts.push(part.type === 'refusal' ? { type: 'refusal', refusal: visible } : { type: 'output_text', text: visible, annotations: [] });
        if (item.phase !== 'commentary') { text.push(visible); if (part.type === 'refusal') refused = true; }
      }
      retained.push({ type: 'message', ...(typeof item.id === 'string' ? { id: item.id } : {}), role: 'assistant', status: 'completed', content: parts, ...(item.phase ? { phase: item.phase } : {}) });
    } else throw Error('CHATGPT_OUTPUT_UNSUPPORTED');
  }
  if (calls.length > 8 || (!calls.length && !text.join('').trim())) throw Error('CHATGPT_INCOMPLETE_TURN');
  const content = text.join('\n');
  if (Buffer.byteLength(content) > 16384 || /<\/?(?:think|analysis|reasoning)(?:\s|>)/iu.test(content)) throw Error('CHATGPT_OUTPUT_UNSUPPORTED');
  return { ...(refused ? { refused: true } : {}), message: { role: 'assistant', content, tool_calls: calls,
    provider_state: { version: 1, provider: 'chatgpt-subscription', items: retained } }, input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens };
}
async function collect(res, signal) {
  if (!res.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) { await res.body?.cancel(); throw Error('CHATGPT_STREAM_REQUIRED'); }
  const reader = res.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, events = 0, terminal;
  function event(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { if (!terminal) throw Error('CHATGPT_INCOMPLETE_TURN'); return; }
    if (terminal) throw Error('CHATGPT_STREAM_AFTER_COMPLETION');
    if (++events > 4096) throw Error('CHATGPT_RESPONSE_LIMIT');
    let item; try { item = parseUniqueJson(data, 262144); } catch { throw Error('CHATGPT_STREAM_INVALID'); }
    if (item.type === 'response.failed' || item.type === 'error') {
      const code = item.response?.error?.code ?? item.code;
      throw providerError(code, 200, item.response?.error?.param ?? item.param);
    }
    if (item.type === 'response.incomplete') throw Error('CHATGPT_INCOMPLETE_TURN');
    if (item.type === 'response.completed') terminal = item.response;
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.length; if (bytes > 1048576) throw Error('CHATGPT_RESPONSE_LIMIT');
      buffer += decoder.decode(value, { stream: true });
      // SSE accepts both LF and CRLF, including split CRLF across chunks.
      buffer = buffer.replace(/\r\n/gu, '\n');
      for (let at; (at = buffer.indexOf('\n\n')) >= 0;) { event(buffer.slice(0, at)); buffer = buffer.slice(at + 2); }
    }
    if (buffer.trim()) throw Error('CHATGPT_STREAM_INCOMPLETE');
    signal?.throwIfAborted();
    if (!terminal) throw Error('CHATGPT_INCOMPLETE_TURN');
    return terminal;
  } catch (error) {
    if (signal?.aborted) throw Error('ASSISTANT_CANCELLED');
    if (/^CHATGPT_[A-Z_]+$/u.test(error?.message)) throw error;
    throw Error('CHATGPT_STREAM_INCOMPLETE');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class ChatGPTSubscription {
  constructor({ account, model, fetcher = globalThis.fetch }) { this.account = account; this.model = model; this.fetcher = fetcher; this.identity = null; }
  async inspect(signal) {
    const catalog = await this.account.models(signal), item = catalog.find(item => item.slug === this.model);
    if (!item) throw Error('CHATGPT_MODEL_UNAVAILABLE');
    const profile = this.account.profile;
    this.binding = `${profile.client}:${profile.subject}`;
    this.identity = Object.freeze({ provider: 'chatgpt-subscription', model: this.model,
      model_digest: createHash('sha256').update(`${this.binding}:${this.model}`).digest('hex'),
      billing: 'chatgpt-plan', display_name: item.display_name, account_label: profile.email ?? profile.client });
    return this.identity;
  }
  #request(messages, tools) {
    const names = new Set(), definitions = tools.map(tool => {
      const fn = tool?.function;
      if (tool?.type !== 'function' || !validName(fn?.name) || names.has(fn.name)) throw Error('CHATGPT_TOOL_SCHEMA_INVALID');
      names.add(fn.name);
      return { type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters, strict: false };
    });
    const request = { model: this.model, input: responsesInput(messages), store: false, stream: true,
      ...(definitions.length ? { tools: [{ type: 'namespace', name: 'tada', description: 'Tools granted by this Tada host.', tools: definitions }] } : {}) };
    return { request, names };
  }
  contextBytes(messages, tools) { return Buffer.byteLength(JSON.stringify(this.#request(messages, tools).request)); }
  async chat(messages, tools, signal) {
    if (!this.identity) throw Error('CHATGPT_INSPECT_REQUIRED');
    const profile = this.account.profile;
    if (`${profile.client}:${profile.subject}` !== this.binding) throw Error('CHATGPT_ACCOUNT_CHANGED');
    const { request, names } = this.#request(messages, tools);
    const token = await this.account.accessToken(signal);
    const res = await response(this.fetcher, `${API}/responses`, { method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    return completedTurn(await collect(res, signal), names);
  }
}
