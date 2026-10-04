// Scripted protocol regressions, not real-model success evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationAssistant } from '../src/conversation.ts';
import { discoveryTools, validCall } from '../src/native-sources.mjs';
const call = (name, args) => ({ function: { name, arguments: args } });
const turn = tool_calls => ({ message: { role: 'assistant', content: '', tool_calls }, input_tokens: 1, output_tokens: 1 });
const done = { message: { role: 'assistant', content: 'Mina owns the next action. [S1]' }, input_tokens: 1, output_tokens: 1 };
function sourcePort() {
  return { definitions: discoveryTools, calls: [],
    validate(name, args) { return validCall(name, args) && (name === 'list_sources' || args.source === 's1'); },
    async execute(name, args) {
      this.calls.push({ name, args });
      return { source: 's1', path: args.path, content: 'Owner: Mina', sha256: 'a'.repeat(64), observed_at: 'now' };
    },
    async verify() { return true; },
  };
}

test('known-tool argument correction executes only a new wholly valid batch', async () => {
  const port = sourcePort();
  let count = 0;
  const model = { async chat(messages) {
    count++;
    if (count === 1) return turn([call('list_sources', {}), call('read_file', { source: 's1', path: 'note.md', offset: 0 })]);
    if (count === 2) {
      assert.equal(port.calls.length, 0, 'no member of the rejected batch ran');
      const feedback = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.deepEqual(feedback.map(f => f.error), ['BATCH_NOT_EXECUTED', 'CALL_ARGUMENTS_OR_SOURCE_INVALID']);
      assert.ok(feedback.every(f => f.performed === false));
      return turn([call('read_file', { source: 's1', path: 'note.md' })]);
    }
    return done;
  } };
  const result = await new ConversationAssistant(model, port).ask('Who is handling it?');
  assert.equal(result.sources.length, 1);
  assert.deepEqual(port.calls, [{ name: 'read_file', args: { source: 's1', path: 'note.md' } }]);
  assert.equal(result.usage.requests, 3);
});

test('repeated invalid arguments stay rejected instead of being coerced or retried forever', async () => {
  const port = sourcePort(); let requests = 0;
  const args = { source: 's1', path: 'note.md', offset: 0 };
  const model = { async chat() { requests++; return turn([call('read_file', { ...args })]); } };
  await assert.rejects(new ConversationAssistant(model, port).ask('Read it.'), /ASSISTANT_TOOL_REJECTED/u);
  assert.equal(requests, 2);
  assert.equal(port.calls.length, 0);
  assert.equal(validCall('read_file', args), false, 'the schema was not weakened');
});

test('a nonexistent source is never replaced with a convenient allowed root', async () => {
  const port = sourcePort(); let requests = 0;
  const model = { async chat() { requests++; return turn([call('read_file', { source: 'other', path: 'note.md' })]); } };
  await assert.rejects(new ConversationAssistant(model, port).ask('Investigate.'), /ASSISTANT_TOOL_REJECTED/u);
  assert.equal(requests, 2);
  assert.equal(port.calls.length, 0);
});

test('an unregistered capability receives no repair-based authority expansion', async () => {
  const port = sourcePort(); let requests = 0;
  const model = { async chat() { requests++; return turn([call('file_delete', { path: 'note.md' })]); } };
  await assert.rejects(new ConversationAssistant(model, port).ask('Sort it out.'), /ASSISTANT_TOOL_REJECTED/u);
  assert.equal(requests, 1);
  assert.equal(port.calls.length, 0);
});
