// Regression for actual local-smoke output contamination. Synthetic HTTP only.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { OllamaLocal } from '../src/ollama-local.mjs';

async function withResponse(message, action) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let response;
      if (req.url === '/api/version') response = { version: 'fixture' };
      else if (req.url === '/api/tags') response = { models: [{ name: 'chosen:latest', size: 1, digest: 'a'.repeat(64) }] };
      else if (req.url === '/api/show') response = { details: { format: 'gguf' }, capabilities: ['completion', 'tools'] };
      else {
        calls.push(JSON.parse(body));
        response = { done: true, done_reason: 'stop', message, prompt_eval_count: 5, eval_count: 9 };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OllamaLocal({ model: 'chosen', endpoint: `http://127.0.0.1:${server.address().port}` });
    await provider.inspect();
    await action(provider, calls);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('unseparated reasoning is rejected without rendering, salvaging or retrying the turn', async () => {
  for (const content of ['<think>private-canary</think>answer', 'private-canary</think>answer',
    '<THINK>private-canary', '<analysis>private-canary</analysis>', 'private-canary</reasoning>answer']) {
    await withResponse({ role: 'assistant', content }, async (provider, calls) => {
      await assert.rejects(provider.chat([{ role: 'user', content: 'Hello' }], []), error => {
        assert.equal(error.message, 'OLLAMA_UNSEPARATED_REASONING');
        assert.equal(JSON.stringify(error).includes('private-canary'), false);
        return true;
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, 'chosen:latest', 'never substitute another model');
    });
  }
});

test('a valid-looking tool call cannot escape a contaminated response', async () => {
  await withResponse({ role: 'assistant', content: 'private-canary</think>',
    tool_calls: [{ function: { name: 'read_file', arguments: { source: 's1', path: 'record.md' } } }] }, async provider => {
    await assert.rejects(provider.chat([], []), /OLLAMA_UNSEPARATED_REASONING/u);
  });
});

test('the separate thinking channel is dropped while genuine final content is preserved exactly', async () => {
  await withResponse({ role: 'assistant', content: 'The answer. [S1]', thinking: 'private-canary' }, async provider => {
    const answer = await provider.chat([], []);
    assert.equal(answer.message.content, 'The answer. [S1]');
    assert.equal(JSON.stringify(answer).includes('private-canary'), false);
    assert.equal(answer.input_tokens, 5);
    assert.equal(answer.output_tokens, 9);
  });
});
