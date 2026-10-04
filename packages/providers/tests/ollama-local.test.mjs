// Local HTTP protocol tests; scripted responses are not a real model evaluation.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { OllamaLocal, localEndpoint, jsonRequest } from '../src/ollama-local.mjs';
const digest = 'a'.repeat(64);
async function server(fn, body) {
  const httpd = http.createServer(fn);
  await new Promise(resolve => httpd.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${httpd.address().port}`;
  try { return await body(endpoint); }
  finally { httpd.closeAllConnections(); await new Promise(resolve => httpd.close(resolve)); }
}
function fixture(overrides = {}) {
  return (req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      if (overrides[req.url]) return overrides[req.url](req, res, text);
      const value = req.url === '/api/version' ? { version: 'fixture-not-a-model' }
        : req.url === '/api/tags' ? { models: [{ name: 'unit:latest', size: 10, digest }] }
        : req.url === '/api/show' ? { details: { format: 'gguf' }, capabilities: ['completion', 'tools', 'thinking'] }
        : { done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Hi.', thinking: 'do-not-retain' }, prompt_eval_count: 4, eval_count: 2 };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    });
  };
}

test('provider rejects remote, credential-bearing, cloud and implicit endpoints', () => {
  for (const endpoint of ['https://127.0.0.1:11434', 'http://localhost:11434', 'http://example.com:11434', 'http://u:p@127.0.0.1:11434', 'http://127.0.0.1:11434/api/chat', 'http://127.0.0.1:11434/?x=1']) {
    assert.throws(() => localEndpoint(endpoint));
  }
  assert.throws(() => new OllamaLocal({ model: 'x:cloud' }));
  assert.throws(() => new OllamaLocal({ model: 'a\n' }));
});

test('inspect verifies local weights and capabilities before receiving user content', async () => {
  await server(fixture(), async endpoint => {
    const provider = new OllamaLocal({ model: 'unit', endpoint });
    await assert.rejects(provider.chat([], [], new AbortController().signal), /INSPECT_REQUIRED/u);
    const identity = await provider.inspect(new AbortController().signal);
    assert.equal(identity.model_digest, digest);
    const result = await provider.chat([{ role: 'user', content: 'Hi' }], [], new AbortController().signal);
    assert.equal(result.message.content, 'Hi.');
    assert.equal(Object.hasOwn(result.message, 'thinking'), false);
    assert.equal(result.input_tokens, 4);
  });
});

test('chat sends tool schema, no stream, and preserves actual tool result roles', async () => {
  await server(fixture({ '/api/chat': (_req, res, raw) => {
    const request = JSON.parse(raw);
    assert.equal(request.stream, false); assert.equal(request.think, false);
    assert.equal(request.messages[0].role, 'tool'); assert.equal(request.messages[0].tool_name, 'read_file');
    assert.equal(request.tools[0].function.name, 'read_file');
    res.end(JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_sources', arguments: {} } }] }, prompt_eval_count: 1, eval_count: 1 }));
  } }), async endpoint => {
    const provider = new OllamaLocal({ model: 'unit', endpoint }); await provider.inspect();
    const response = await provider.chat([{ role: 'tool', tool_name: 'read_file', content: '{}' }], [{ type: 'function', function: { name: 'read_file' } }]);
    assert.equal(response.message.tool_calls[0].function.name, 'list_sources');
  });
});

test('remote-weight declarations and missing tool capability are not local proof', async () => {
  for (const show of [
    { remote_host: 'https://cloud.invalid', details: { format: 'gguf' }, capabilities: ['completion', 'tools'] },
    { details: { format: 'gguf' }, capabilities: ['completion'] },
  ]) await server(fixture({ '/api/show': (_req, res) => res.end(JSON.stringify(show)) }), async endpoint => {
    await assert.rejects(new OllamaLocal({ model: 'unit', endpoint }).inspect());
  });
});

test('an alias changing weights blocks user-content transmission', async () => {
  let times = 0, chats = 0;
  await server(fixture({
    '/api/tags': (_req, res) => res.end(JSON.stringify({ models: [{ name: 'unit:latest', size: 10, digest: times++ ? 'b'.repeat(64) : digest }] })),
    '/api/chat': (_req, res) => { chats++; res.end('{}'); },
  }), async endpoint => {
    const provider = new OllamaLocal({ model: 'unit', endpoint }); await provider.inspect();
    await assert.rejects(provider.chat([{ role: 'user', content: 'private' }], []), /MODEL_CHANGED/u);
    assert.equal(chats, 0);
  });
});

test('redirects, incomplete JSON, duplicate keys and oversized responses are rejected', async () => {
  for (const respond of [
    (_req, res) => { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); },
    (_req, res) => res.end('{"done":true'),
    (_req, res) => res.end('{"done":false,"done":true}'),
    (_req, res) => res.end(' '.repeat(100)),
  ]) await server(respond, async endpoint => { await assert.rejects(jsonRequest(endpoint, '/api/version', undefined, undefined, 64)); });
});

test('cancellation closes a stalled local response without forwarding diagnostics', async () => {
  await server((_req, _res) => {}, async endpoint => {
    const abort = new AbortController(); const pending = jsonRequest(endpoint, '/api/chat', {}, abort.signal);
    abort.abort(); await assert.rejects(pending, /ASSISTANT_CANCELLED/u);
  });
});

test('length-truncated completion cannot release tool calls', async () => {
  await server(fixture({ '/api/chat': (_req, res) => res.end(JSON.stringify({ done: true, done_reason: 'length', message: { role: 'assistant', content: 'fragment' }, prompt_eval_count: 1, eval_count: 2 })) }), async endpoint => {
    const provider = new OllamaLocal({ model: 'unit', endpoint }); await provider.inspect();
    await assert.rejects(provider.chat([], []), /INCOMPLETE_TURN/u);
  });
});
