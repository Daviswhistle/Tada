// Diagnostic only: an explicit single-tool request is not natural-delegation success.
// Logs no model prose, thinking, user material or tool result. No tool is executed.
import { createHash } from 'node:crypto';
import { OllamaLocal, jsonRequest } from '../../packages/providers/src/ollama-local.mjs';
import { discoveryTools } from '../../packages/engine/src/native-sources.mjs';

const provider = new OllamaLocal({ model: process.argv[2] });
const identity = await provider.inspect(AbortSignal.timeout(20000));
const show = await jsonRequest(provider.endpoint, '/api/show', { model: provider.model }, AbortSignal.timeout(20000));
let probe;
try {
  const result = await provider.chat([
    { role: 'system', content: 'You are testing a function-calling protocol. Use the provided function, not prose. Do not invent its output.' },
    { role: 'user', content: 'Call list_sources with an empty JSON object.' },
  ], [discoveryTools[0]], AbortSignal.timeout(180000));
  const calls = result.message.tool_calls;
  probe = { structured_call_returned: calls.length === 1 && calls[0].function.name === 'list_sources'
    && Object.keys(calls[0].function.arguments).length === 0,
    call_names: calls.map(call => call.function.name), input_tokens: result.input_tokens, output_tokens: result.output_tokens };
} catch (error) {
  probe = { structured_call_returned: false, error: /^[A-Z_]{1,64}$/u.test(error.message) ? error.message : 'PROBE_FAILED' };
}
console.log(JSON.stringify({ kind: 'local_protocol_diagnostic', identity,
  template_sha256: typeof show.template === 'string' ? createHash('sha256').update(show.template).digest('hex') : null,
  template_has_tools: typeof show.template === 'string' && show.template.includes('.Tools'),
  capabilities: show.capabilities, probe, product_acceptance: 'not_run' }));
// The actual two-variant suite still runs and retains its own failure gate.
