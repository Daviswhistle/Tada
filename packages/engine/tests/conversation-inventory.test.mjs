// Host metadata regressions, not evidence of an LLM's intent resolution.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationAssistant } from '../src/conversation.ts';

const definition = name => ({ type: 'function', function: { name, description: 'fixture', parameters: { type: 'object', properties: {} } } });
const response = () => ({ message: { role: 'assistant', content: 'Which situation are you referring to?' }, input_tokens: 1, output_tokens: 1 });
const sourcePort = definitions => ({ definitions, validate: () => false,
  execute: () => { throw new Error('UNEXPECTED_READ'); }, verify: () => true });

test('model receives the actual host tool inventory without a preselected source or task', async () => {
  const source = sourcePort([definition('list_sources'), definition('read_file')]);
  const assistant = new ConversationAssistant({ async chat(messages, tools) {
    assert.match(messages[0].content, /Current host tool inventory: \["list_sources","read_file"\]/u);
    assert.deepEqual(tools, source.definitions);
    assert.equal(messages.at(-1).content, 'What is going on?');
    assert.equal(messages[0].content.includes('Cedar'), false);
    assert.equal(messages[0].content.includes('status-'), false);
    return response();
  } }, source);
  await assistant.ask('What is going on?');
});

test('an empty inventory remains empty rather than claiming a connected source', async () => {
  const assistant = new ConversationAssistant({ async chat(messages, tools) {
    assert.match(messages[0].content, /Current host tool inventory: \[\]/u);
    assert.deepEqual(tools, []);
    return response();
  } }, sourcePort([]));
  const result = await assistant.ask('This is not working.');
  assert.deepEqual(result.sources, []);
  assert.equal(result.verification, 'not_applicable');
});

test('inventory refreshes on follow-up and forget without using untrusted names as instructions', async () => {
  const source = sourcePort([definition('list_sources')]);
  let calls = 0;
  const assistant = new ConversationAssistant({ async chat(messages) {
    calls++;
    assert.match(messages[0].content, calls === 1
      ? /Current host tool inventory: \["list_sources"\]/u
      : /Current host tool inventory: \[\]/u);
    assert.equal(messages[0].content.includes('INVENTORY_INJECTION_CANARY'), false);
    return response();
  } }, source);
  await assistant.ask('Hello.');
  source.definitions = [definition('invalid\nINVENTORY_INJECTION_CANARY')];
  await assistant.ask('And now?');
  source.definitions = [];
  assistant.forget();
  await assistant.ask('Hello again.');
  assert.equal(calls, 3);
});
