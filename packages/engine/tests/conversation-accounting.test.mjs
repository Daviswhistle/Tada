// Deterministic accounting races; these scripted ports are not live-model proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationAssistant } from '../src/conversation.ts';

const completed = (input = 3, output = 2) => ({
  message: { role: 'assistant', content: 'Hello.' }, input_tokens: input, output_tokens: output,
});
const sources = () => ({
  definitions: [], calls: 0, validate: () => true,
  async execute() { this.calls++; return {}; },
  async verify() { throw new Error('UNEXPECTED_VERIFICATION'); },
});

test('cancellation rejects late output without deleting its observed usage or dispatching reads', async () => {
  const abort = new AbortController();
  const port = sources();
  const model = { async chat() {
    abort.abort();
    return { ...completed(43, 7), message: { role: 'assistant', content: '',
      tool_calls: [{ function: { name: 'list_sources', arguments: {} } }] } };
  } };
  const assistant = new ConversationAssistant(model, port);
  await assert.rejects(assistant.ask('Find the relevant notes.', abort.signal), /ASSISTANT_CANCELLED/u);
  assert.equal(port.calls, 0);
  await assert.rejects(assistant.ask('Continue.'), /ASSISTANT_SESSION_RESET_REQUIRED/u);
  assistant.forget();
  model.chat = async () => completed();
  const answer = await assistant.ask('Hello.');
  assert.deepEqual(answer.usage, { requests: 2, input_tokens: 46, output_tokens: 9, unknown_requests: 0 });
});

test('invalid output usage leaves both totals unchanged and records one uncertain request', async () => {
  const model = { chat: async () => completed(43, -1) };
  const assistant = new ConversationAssistant(model, sources());
  await assert.rejects(assistant.ask('Hello.'), /ASSISTANT_USAGE_INVALID/u);
  assistant.forget();
  model.chat = async () => completed();
  const answer = await assistant.ask('Hello again.');
  assert.deepEqual(answer.usage, { requests: 2, input_tokens: 3, output_tokens: 2, unknown_requests: 1 });
});

test('overflow preserves the previous lower bound instead of partial credit or a false exact total', async () => {
  const model = { chat: async () => completed(Number.MAX_SAFE_INTEGER, 1) };
  const assistant = new ConversationAssistant(model, sources());
  await assistant.ask('First.');
  model.chat = async () => completed(1, 9);
  await assert.rejects(assistant.ask('Second.'), /ASSISTANT_USAGE_INVALID/u);
  assistant.forget();
  model.chat = async () => completed(0, 0);
  const answer = await assistant.ask('Third.');
  assert.deepEqual(answer.usage, {
    requests: 3, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, unknown_requests: 1,
  });
});
