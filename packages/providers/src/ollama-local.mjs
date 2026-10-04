// Native Ollama adapter. No credentials, remote endpoint, automatic pull or fallback.
import http from 'node:http';
import { parseUniqueJson } from '../../engine/src/json.mjs';

export function localEndpoint(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password
      || u.pathname !== '/' || u.search || u.hash || !u.port) {
    throw new Error('OLLAMA_EXPLICIT_LOOPBACK_REQUIRED');
  }
  return u;
}

export function jsonRequest(base, path, body, signal, maxBytes = 262144) {
  const target = new URL(path, localEndpoint(base));
  if (!['/api/chat', '/api/show', '/api/tags', '/api/version'].includes(path)) {
    throw new Error('OLLAMA_ENDPOINT_REJECTED');
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(target, {
      method: bytes ? 'POST' : 'GET', agent: false, signal,
      headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {},
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => req.destroy(new Error('OLLAMA_REQUEST_TIMEOUT')), 180000);
    req.on('error', () => finish(new Error(signal?.aborted ? 'ASSISTANT_CANCELLED' : 'OLLAMA_UNAVAILABLE')));
    req.on('response', res => {
      // Never forward redirects, credentials, server diagnostics or streamed fragments.
      if (res.statusCode !== 200) {
        res.destroy();
        finish(new Error(res.statusCode === 404 ? 'OLLAMA_MODEL_UNAVAILABLE' : 'OLLAMA_REQUEST_REJECTED'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          finish(new Error('OLLAMA_RESPONSE_LIMIT'));
          res.destroy(); req.destroy();
        } else chunks.push(chunk);
      });
      res.on('error', () => finish(new Error('OLLAMA_RESPONSE_INCOMPLETE')));
      res.on('end', () => {
        if (settled) return;
        try {
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          finish(null, parseUniqueJson(raw, maxBytes));
        } catch { finish(new Error('OLLAMA_RESPONSE_INVALID')); }
      });
    });
    req.end(bytes);
  });
}

export class OllamaLocal {
  constructor({ model, endpoint = 'http://127.0.0.1:11434' }) {
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(model)
        || /cloud/iu.test(model)) throw new Error('OLLAMA_LOCAL_MODEL_REQUIRED');
    this.endpoint = localEndpoint(endpoint).href;
    this.model = model.includes(':') ? model : `${model}:latest`;
    this.identity = null;
  }
  async inspect(signal) {
    const [version, tags, show] = await Promise.all([
      jsonRequest(this.endpoint, '/api/version', undefined, signal),
      jsonRequest(this.endpoint, '/api/tags', undefined, signal),
      jsonRequest(this.endpoint, '/api/show', { model: this.model }, signal),
    ]);
    const item = tags.models?.find(item => item.name === this.model || item.model === this.model);
    if (!item || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/u.test(item.digest)
        || item.remote_host || item.remote_model || show.remote_host || show.remote_model
        || show.details?.format !== 'gguf') throw new Error('OLLAMA_INSTALLED_LOCAL_WEIGHTS_REQUIRED');
    if (!Array.isArray(show.capabilities) || !show.capabilities.includes('completion')
        || !show.capabilities.includes('tools')) throw new Error('OLLAMA_TOOL_CAPABILITY_REQUIRED');
    if (typeof version.version !== 'string') throw new Error('OLLAMA_VERSION_UNAVAILABLE');
    this.thinking = show.capabilities.includes('thinking');
    this.identity = Object.freeze({ provider: 'ollama-local', model: this.model,
      model_digest: item.digest, runtime_version: version.version, billing: 'local-compute-only' });
    return this.identity;
  }
  async chat(messages, tools, signal) {
    if (!this.identity) throw new Error('OLLAMA_INSPECT_REQUIRED');
    // Recheck installed identity before sending user content. Changing an alias is not consent.
    const tags = await jsonRequest(this.endpoint, '/api/tags', undefined, signal);
    const item = tags.models?.find(item => item.name === this.model || item.model === this.model);
    if (item?.digest !== this.identity.model_digest || item?.remote_host || item?.remote_model) {
      throw new Error('OLLAMA_MODEL_CHANGED');
    }
    const body = { model: this.model, messages, tools, stream: false, keep_alive: '5m',
      options: { num_ctx: 16384, num_predict: 768, temperature: 0 } };
    if (this.thinking) body.think = false;
    const raw = await jsonRequest(this.endpoint, '/api/chat', body, signal, 65536);
    if (raw.done !== true || raw.done_reason !== 'stop' || raw.message?.role !== 'assistant'
        || typeof raw.message.content !== 'string') throw new Error('OLLAMA_INCOMPLETE_TURN');
    const calls = raw.message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 8) throw new Error('OLLAMA_TOOL_CALL_LIMIT');
    const normalized = calls.map(call => {
      const fn = call?.function;
      if (!fn || typeof fn.name !== 'string' || !fn.arguments || Array.isArray(fn.arguments)
          || typeof fn.arguments !== 'object') throw new Error('OLLAMA_TOOL_CALL_INVALID');
      return { function: { name: fn.name, arguments: fn.arguments } };
    });
    const usage = [raw.prompt_eval_count, raw.eval_count];
    if (!usage.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('OLLAMA_USAGE_UNAVAILABLE');
    // Thinking is neither displayed nor retained. Do not silently trim user history.
    return { message: { role: 'assistant', content: raw.message.content, tool_calls: normalized },
      input_tokens: usage[0], output_tokens: usage[1] };
  }
}
