// Synthetic protocol data, never model or assistant-acceptance evidence.
export const MODEL = 'test-model';
export const KEY = 'FAKE_TEST_KEY_DO_NOT_USE';
export function responseFixture({ id = 'resp_test', searched = true } = {}) {
  const output = [{ id: `reason_${id}`, type: 'reasoning', summary: [], encrypted_content: 'OPAQUE_FAKE_CONTINUATION_NOT_A_SECRET' }];
  if (searched) output.push({ id: `search_${id}`, type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'sample source', sources: [{ type: 'url', url: 'https://example.org/source', title: 'Example source' }] } });
  output.push({ id: `message_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'A sourced answer.', annotations: searched ? [{ type: 'url_citation', url: 'https://example.org/source', title: 'Example source', start_index: 2, end_index: 9 }] : [] }] });
  return { object: 'response', id, model: MODEL, status: 'completed', error: null, output, usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
}
export function httpFixture(value = responseFixture()) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
export function latch() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise(resolve => setImmediate(resolve));
