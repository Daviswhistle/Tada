import test from 'node:test';
import assert from 'node:assert/strict';
import { runModelLoop } from '../src/model-loop.ts';
import { MockProvider } from '../../providers/src/mock.ts';
const seed={schema_version:1,call_id:'digest-test',task_id:'task',tool:'task.contract_digest',tool_version:1,resource:'task://task/contract',purpose:'verify_input_snapshot',arguments:{expected_hash:'a'.repeat(64)}};
const result={schema_version:1,call_id:seed.call_id,grant_ref:'grant',status:'ok',side_effect_state:'none',contract_hash:'a'.repeat(64),evidence_ref:'evidence',replayed:false};
const limits={max_turns:6,max_tool_calls:1,max_recoveries:2,max_active_ms:1000,max_events:64,max_bytes:65536,max_call_bytes:16384};
async function run(scenario,overrides={},port={async invoke(){return structuredClone(result);}}){
  return runModelLoop(new MockProvider(scenario),seed,port,{...limits,...overrides},new AbortController().signal);
}
function provider(turns){let at=0;return {id:'fixture',async *stream(req){
  const items=turns[Math.min(at++,turns.length-1)];
  yield* items.map((v,i)=>({schema_version:1,request_id:req.request_id,seq:i+1,...v}));
}};}
const completed=(payload=seed)=>[{type:'tool_call_complete',call_id:payload.call_id,payload_json:JSON.stringify(payload)},{type:'completed',finish_reason:'tool_calls'}];
const stop=[{type:'completed',finish_reason:'stop'}];

test('mock two-turn loop observes broker evidence before requesting independent verification',async()=>{
  const value=await run('normal');
  assert.equal(value.state,'verify');assert.equal(value.reason,'MODEL_FINISHED_NOT_VERIFIED');
  assert.equal(value.meter.turns,2);assert.equal(value.meter.tool_calls,1);
  assert.equal(value.meter.input_tokens,20);assert.equal(value.meter.output_tokens,8);
  assert.equal(value.meter.uncertain_requests,0);assert.deepEqual(value.evidence,[result]);
});
test('one interrupted stream is discarded and a fresh complete response may recover',async()=>{
  let calls=0;const value=await run('repair-once',{}, {async invoke(){calls++;return result;}});
  assert.equal(value.state,'verify');assert.equal(value.meter.turns,3);assert.equal(value.meter.recoveries,1);
  assert.equal(value.meter.input_tokens,30);assert.equal(value.meter.output_tokens,11);
  assert.equal(value.meter.uncertain_requests,1);assert.equal(calls,1);
});
for(const scenario of ['partial-always','repeated-error'])test(`${scenario}: same failure twice enters diagnosis without executing`,async()=>{
  let calls=0;const value=await run(scenario,{}, {async invoke(){calls++;return result;}});
  assert.equal(value.state,'diagnose');assert.equal(value.meter.turns,2);assert.equal(calls,0);
  assert.equal(value.meter.uncertain_requests,2);
});
for(const [scenario,reason] of [['capacity','PROVIDER_CAPACITY'],['auth','AUTH'],['network','NETWORK']])test(`${scenario}: classify waiting without hidden provider fallback`,async()=>{
  const value=await run(scenario);assert.equal(value.state,'waiting');assert.equal(value.reason,reason);
  assert.equal(value.meter.turns,1);assert.equal(value.meter.tool_calls,0);assert.equal(value.meter.input_tokens,10);
  if(scenario==='capacity')assert.equal(value.retry_after_ms,60000);
});
test('model prose is not a task success, artifact, or tool evidence',async()=>{
  const value=await run('text-only');assert.equal(value.state,'verify');assert.deepEqual(value.evidence,[]);
  assert.ok(!JSON.stringify(value).includes('The task is complete'));assert.equal(value.meter.tool_calls,0);
});
test('post-tool stream failure preserves the read and never invokes it again',async()=>{
  let calls=0;const value=await run('after-tool-error',{}, {async invoke(){calls++;return result;}});
  assert.equal(value.state,'diagnose');assert.equal(calls,1);assert.deepEqual(value.evidence,[result]);
});
test('changed model scope stops rather than using a fallback tool',async()=>{
  const value=await run('scope-change');assert.equal(value.state,'unsupported');assert.equal(value.meter.tool_calls,0);
});
test('tool-call JSON is strict and not reconstructed from parseable fragments',async()=>{
  const variants=[JSON.stringify(seed).slice(0,-1),JSON.stringify(seed).replace('"schema_version":1','"schema_version":1,"schema_version":1'),JSON.stringify({...seed,command:'shell'})];
  for(const payload_json of variants){
    let calls=0;const p=provider([[{type:'tool_call_complete',call_id:seed.call_id,payload_json},{type:'completed',finish_reason:'tool_calls'}]]);
    const value=await runModelLoop(p,seed,{async invoke(){calls++;return result;}},limits,new AbortController().signal);
    assert.equal(value.state,'diagnose');assert.equal(calls,0);assert.equal(value.meter.turns,2);
  }
});
test('all proposals in a model turn are validated before the first call',async()=>{
  let calls=0;const items=[...completed(seed).slice(0,-1),...completed({...seed,call_id:'other',tool:'credential.export'})];
  const value=await runModelLoop(provider([items]),seed,{async invoke(){calls++;return result;}},{...limits,max_tool_calls:2},new AbortController().signal);
  assert.equal(value.state,'unsupported');assert.equal(calls,0);
});
test('ambiguous tool transport stops for reconciliation and retains consumed call capacity',async()=>{
  let calls=0;const value=await run('normal',{}, {async invoke(){calls++;throw new Error('FAKE_SECRET');}});
  assert.equal(value.state,'reconcile');assert.equal(value.meter.tool_calls,1);assert.equal(value.meter.turns,1);assert.equal(calls,1);
  assert.ok(!JSON.stringify(value).includes('FAKE_SECRET'));
});
test('a mismatched broker result is not supplied as evidence to another model turn',async()=>{
  const value=await run('normal',{}, {async invoke(){return {...result,contract_hash:'b'.repeat(64)};}});
  assert.equal(value.state,'reconcile');assert.equal(value.meter.turns,1);assert.deepEqual(value.evidence,[]);
});
test('exhausted turn and tool limits do not start an extra operation',async()=>{
  const value=await run('normal',{max_turns:1});assert.equal(value.state,'budget');assert.equal(value.meter.turns,1);assert.equal(value.evidence.length,1);
  let calls=0;const p=provider([completed(seed),completed({...seed,call_id:'next'})]);
  const other=await runModelLoop(p,seed,{async invoke(){calls++;return result;}},limits,new AbortController().signal);
  assert.equal(other.reason,'MODEL_TOOL_LIMIT');assert.equal(calls,1);
});
test('an identical logical call is never re-executed by a later model turn',async()=>{
  let calls=0;const value=await runModelLoop(provider([completed(seed)]),seed,{async invoke(){calls++;return result;}},{...limits,max_tool_calls:2},new AbortController().signal);
  assert.equal(value.reason,'MODEL_DUPLICATE_LOGICAL_CALL');assert.equal(calls,1);
});
test('recovery branches are bounded even when each failure has a different signature',async()=>{
  const value=await runModelLoop(provider([[{type:'failed',category:'protocol'}],[{type:'completed',finish_reason:'tool_calls'}]]),seed,{async invoke(){throw new Error('no');}},{...limits,max_recoveries:1},new AbortController().signal);
  assert.equal(value.reason,'MODEL_RECOVERY_LIMIT');assert.equal(value.meter.turns,2);
});
test('active deadline terminates a stalled mock provider without a tool call',async()=>{
  const value=await run('hang',{max_active_ms:30});assert.equal(value.state,'budget');assert.equal(value.meter.tool_calls,0);assert.equal(value.meter.uncertain_requests,1);
});
test('cancellation before model entry consumes no request and no tool capacity',async()=>{
  const c=new AbortController();c.abort();const value=await runModelLoop(new MockProvider(),seed,{async invoke(){throw new Error('no');}},limits,c.signal);
  assert.equal(value.state,'cancelled');assert.equal(value.meter.turns,0);
});
test('cancellation after the stream but before admission does not execute a late tool',async()=>{
  const c=new AbortController();let calls=0;
  const p={id:'cancel',async *stream(req){yield* completed().map((v,i)=>({schema_version:1,request_id:req.request_id,seq:i+1,...v}));c.abort();}};
  const value=await runModelLoop(p,seed,{async invoke(){calls++;return result;}},limits,c.signal);
  assert.equal(value.state,'cancelled');assert.equal(calls,0);
});
test('cancellation during a tool wait is not represented as a confirmed rollback',async()=>{
  const c=new AbortController();const value=await runModelLoop(new MockProvider(),seed,{async invoke(){c.abort();return result;}},limits,c.signal);
  assert.equal(value.state,'reconcile');assert.equal(value.meter.tool_calls,1);assert.equal(value.meter.turns,1);
});
test('invalid limits reject before a model is requested',async()=>{
  await assert.rejects(run('normal',{max_turns:NaN}),/MODEL_LOOP_LIMITS/);
});
test('usage sums cannot overflow into negative credit or a false exact total',async()=>{
  const huge={type:'usage',input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:0};
  const value=await runModelLoop(provider([[huge,...completed()],[huge,...stop]]),seed,{async invoke(){return result;}},limits,new AbortController().signal);
  assert.equal(value.state,'budget');assert.equal(value.reason,'MODEL_USAGE_OVERFLOW');
});

test('zero turn or recovery allowance is honored without silently replenishing it',async()=>{
  const none=await run('normal',{max_turns:0});assert.equal(none.meter.turns,0);assert.equal(none.state,'budget');
  const noRetry=await run('partial-always',{max_recoveries:0});assert.equal(noRetry.meter.turns,1);assert.equal(noRetry.reason,'MODEL_RECOVERY_LIMIT');
});
test('event exhaustion is a resource stop, not a schema-retry loop',async()=>{
  const value=await run('normal',{max_events:1});assert.equal(value.state,'budget');assert.equal(value.meter.turns,1);
});
