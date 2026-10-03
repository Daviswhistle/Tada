import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUniqueJson } from '../src/json.mjs';
import { runDigestSession } from '../src/session.ts';

const proposal = { schema_version:1, call_id:'digest-probe', task_id:'task-a', tool:'task.contract_digest', tool_version:1, resource:'task://task-a/contract', purpose:'verify_input_snapshot', arguments:{expected_hash:'a'.repeat(64)} };
const grant = { schema_version:1, grant_id:'grant-a', subject:'worker-a', task_id:'task-a', tool:'task.contract_digest', tool_version:1, resource:proposal.resource, purpose:proposal.purpose, payload_hash:'b'.repeat(64), profile_id:'mock-test', policy_revision:1, generation:1, cancel_epoch:0, fencing_token:1, expires_at_ms:1900000000000 };
const authorization = {schema_version:1, decision:'ALLOW', reason:'ALLOWED', grant};
const result = {schema_version:1, call_id:proposal.call_id, grant_ref:grant.grant_id, status:'ok', side_effect_state:'none', contract_hash:proposal.arguments.expected_hash, evidence_ref:'digest-evidence', replayed:false};
const reply = (id, replayed) => ({jsonrpc:'2.0', id, result:{...result,replayed}});
function transport(messages) {
  const incoming = structuredClone(messages);
  const sent = [];
  return {sent, async receive() { assert.ok(incoming.length); return incoming.shift(); }, async send(v) { sent.push(structuredClone(v)); }};
}
test('raw parser rejects duplicate keys and escaped aliases without discarding input', () => {
  for (const raw of ['{"id":1,"id":2}', '{"x":{"a":1,"\\u0061":2}}', '{"x":[{"a":1,"a":2}]}']) assert.throws(() => parseUniqueJson(raw), /ENGINE_INVALID_JSON/);
});
test('raw parser rejects partial trailing nonfinite oversized and overdeep JSON', () => {
  for (const raw of ['{}{}','{"a":','[1e999]', '[01]', '{"a":1,}', '[1,]', '"\\ud800"', '"\\udc00"', '"'+'a'.repeat(16384)+'"', '['.repeat(66)+'0'+']'.repeat(66)]) assert.throws(() => parseUniqueJson(raw), /ENGINE_INVALID_JSON/);
});
test('raw parser preserves valid unicode scalars numbers and nested structures', () => {
  const raw='{"a":[true,false,null,1,1.0,-1.5e-2],"한글":"😀","__proto__":{"x":1},"escaped":"a\\\"b"}';
  assert.deepEqual(parseUniqueJson(raw), JSON.parse(raw));
  assert.equal({}.x, undefined);
});
test('typed session invokes once then replays same immutable call with new RPC id', async () => {
  const io=transport([proposal,authorization,reply('invoke-first',false),reply('invoke-replay',true)]);
  await runDigestSession(io);
  assert.equal(io.sent.length,4);
  assert.deepEqual(io.sent[1].params,io.sent[2].params);
  assert.notEqual(io.sent[1].id,io.sent[2].id);
  assert.deepEqual(io.sent[3],reply('invoke-replay',true).result);
  assert.equal(io.sent[3].task_success,undefined);
});
test('lost-response fixture pipelines only the same immutable call', async () => {
  const io=transport([proposal,authorization,reply('invoke-replay',true)]);
  await runDigestSession(io,true);
  assert.deepEqual(io.sent[1].params,io.sent[2].params);
  assert.equal(io.sent[3].replayed,true);
});
test('DENY REQUIRE_DECISION and HANDOFF issue no invoke or claimed result', async () => {
  for (const decision of ['DENY','REQUIRE_DECISION','HANDOFF']) {
    const io=transport([proposal,{schema_version:1,decision,reason:'NOT_ALLOWED'}]);
    await runDigestSession(io); assert.equal(io.sent.length,1);
  }
});
test('borrowed or scope-modified grants fail before any invocation', async () => {
  for (const [field,value] of [['task_id','other'],['tool','other'],['tool_version',2],['resource','other'],['purpose','other'],['cancel_epoch',1]]) {
    const io=transport([proposal,{...authorization,grant:{...grant,[field]:value}}]);
    await assert.rejects(runDigestSession(io),/ENGINE_GRANT_BINDING/);
    assert.equal(io.sent.length,1);
  }
});
test('mismatched response identity hash effect or replay classification is not returned', async () => {
  for (const bad of [
    {...reply('invoke-first',false),id:'other'},
    ...[['call_id','other'],['grant_ref','other'],['contract_hash','c'.repeat(64)],['replayed',true],['side_effect_state','confirmed']].map(([k,v])=>({...reply('invoke-first',false),result:{...result,[k]:v}})),
  ]) {
    const io=transport([proposal,authorization,bad]);
    await assert.rejects(runDigestSession(io)); assert.equal(io.sent.length,2);
  }
});
test('changed replay evidence cannot become a finished session', async () => {
  const replay=reply('invoke-replay',true); replay.result.evidence_ref='different-evidence';
  const io=transport([proposal,authorization,reply('invoke-first',false),replay]);
  await assert.rejects(runDigestSession(io),/ENGINE_REPLAY_EVIDENCE_CHANGED/);
  assert.equal(io.sent.length,3);
});
test('invalid message diagnostics do not echo the raw canary', async () => {
  const io=transport([{...proposal,secret:'FAKE-SECRET-DO-NOT-ECHO'}]);
  await assert.rejects(runDigestSession(io), (e)=>e.message==='ENGINE_INVALID_MESSAGE' && !e.message.includes('FAKE-SECRET'));
  assert.equal(io.sent.length,0);
});
