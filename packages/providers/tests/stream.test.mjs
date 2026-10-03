import test from 'node:test';
import assert from 'node:assert/strict';
import { collectModelTurn, bounded, ModelFault } from '../src/stream.ts';
const request = {request_id:'r1',task_id:'t1',phase:'proposal',input_hash:'a'.repeat(64),proposal_json:'{}',evidence_refs:[]};
const limits = {max_events:64,max_bytes:65536,max_calls:4,max_call_bytes:16384};
const events = (...items) => items.map((item,i) => ({schema_version:1,request_id:'r1',seq:i+1,...item}));
const adapter = (items) => ({id:'fixture',async *stream(){ yield* items; }});
const collect = (items,opts={}) => collectModelTurn(adapter(items),request,new AbortController().signal,performance.now()+1000,{...limits,...opts});
const stop = {type:'completed',finish_reason:'stop'};
const delta = {type:'tool_call_delta',call_id:'c',chunk:'{}'};
const complete = {type:'tool_call_complete',call_id:'c',payload_json:'{}'};
const finish = {type:'completed',finish_reason:'tool_calls'};

test('tool calls are released only after complete, terminal and EOF',async()=>{
  const turn=await collect(events(delta,complete,finish));
  assert.equal(turn.finish_reason,'tool_calls');
  assert.deepEqual(turn.calls,[{call_id:'c',payload_json:'{}'}]);
  assert.equal(turn.usage.reported,false);
});
test('interleaved calls remain individually bound and preserve encounter order',async()=>{
  const turn=await collect(events(delta,{...delta,call_id:'other'}, {...complete,call_id:'other'},complete,finish));
  assert.deepEqual(turn.calls.map((v)=>v.call_id),['c','other']);
});
test('a complete-only provider event is accepted without inventing deltas',async()=>{
  assert.equal((await collect(events(complete,finish))).calls.length,1);
});
test('successful-looking calls are withheld until the iterator actually ends',async()=>{
  let release, reached;
  const ready=new Promise((r)=>{reached=r;});
  const held={id:'held',async *stream(){yield* events(complete,finish);reached();await new Promise((r)=>{release=r;});}};
  let settled=false;
  const running=collectModelTurn(held,request,new AbortController().signal,performance.now()+1000,limits).then((v)=>{settled=true;return v;});
  await ready;assert.equal(settled,false);release();assert.equal((await running).calls.length,1);
});
const badCases = [
  ['empty',[], 'MODEL_STREAM_INCOMPLETE'],
  ['partial',events(delta),'MODEL_STREAM_INCOMPLETE'],
  ['no-terminal',events(complete),'MODEL_STREAM_INCOMPLETE'],
  ['terminal-partial',events(delta,finish),'MODEL_PARTIAL_CALL'],
  ['changed-completion',events(delta,{...complete,payload_json:'{"x":1}'},finish),'MODEL_COMPLETE_MISMATCH'],
  ['duplicate-completion',events(complete,complete,finish),'MODEL_CALL_ALREADY_COMPLETE'],
  ['delta-after-completion',events(complete,delta,finish),'MODEL_CALL_ALREADY_COMPLETE'],
  ['finish-mismatch',events(complete,stop),'MODEL_FINISH_MISMATCH'],
  ['empty-tool-finish',events(finish),'MODEL_FINISH_MISMATCH'],
  ['after-terminal',events(stop,{type:'text_delta',value:'extra'}),'MODEL_AFTER_TERMINAL'],
  ['duplicate-terminal',events(stop,stop),'MODEL_AFTER_TERMINAL'],
  ['foreign-request',events(stop).map((e)=>({...e,request_id:'other'})),'MODEL_EVENT_BINDING'],
  ['sequence-gap',events(stop).map((e)=>({...e,seq:2})),'MODEL_EVENT_BINDING'],
  ['unknown-field',events({...stop,success:true}),'MODEL_EVENT_SCHEMA'],
  ['unknown-event',events({type:'grant_issued'}),'MODEL_EVENT_SCHEMA'],
  ['future-version',events(stop).map((e)=>({...e,schema_version:2})),'MODEL_EVENT_SCHEMA'],
];
assert.equal(badCases.length,16,'fixed stream-fault denominator');
for (const [name,items,code] of badCases) test(`stream rejection: ${name}`,async()=>{
  await assert.rejects(collect(items),(error)=>error instanceof ModelFault && error.message===code);
});
test('event, total bytes, UTF-8 argument bytes and call count have separate bounds',async()=>{
  await assert.rejects(collect(events({type:'text_delta',value:'x'},stop),{max_events:1}),/MODEL_EVENT_LIMIT/);
  await assert.rejects(collect(events({type:'text_delta',value:'x'},stop),{max_bytes:1}),/MODEL_BYTE_LIMIT/);
  await assert.rejects(collect(events({...delta,chunk:'한글'}),{max_call_bytes:4}),/MODEL_ARGUMENT_LIMIT/);
  await assert.rejects(collect(events(delta,{...delta,call_id:'d'}),{max_calls:1}),/MODEL_CALL_LIMIT/);
});
test('cumulative usage is not double counted and cannot regress',async()=>{
  const usage={type:'usage',input_tokens:10,output_tokens:3};
  const turn=await collect(events(usage,{...usage,output_tokens:5},stop));
  assert.deepEqual(turn.usage,{input_tokens:10,output_tokens:5,reported:true});
  await assert.rejects(collect(events(usage,{...usage,input_tokens:9},stop)),/MODEL_USAGE_REGRESSION/);
});
test('observed usage survives a partial stream and an adapter exception without raw diagnostics',async()=>{
  const usage={type:'usage',input_tokens:11,output_tokens:7};
  await assert.rejects(collect(events(usage,delta)),(e)=>e.usage.input_tokens===11 && e.usage.output_tokens===7);
  const broken={id:'broken',async *stream(){yield* events(usage);throw new Error('FAKE_SECRET_PROVIDER_TOKEN');}};
  await assert.rejects(collectModelTurn(broken,request,new AbortController().signal,performance.now()+1000,limits),(e)=>{
    assert.equal(e.message,'MODEL_NETWORK');assert.equal(e.usage.input_tokens,11);assert.ok(!JSON.stringify(e).includes('FAKE_SECRET'));return true;
  });
});
test('capacity keeps retry-after and unsupported continuation is not treated as encrypted storage',async()=>{
  await assert.rejects(collect(events({type:'rate_limit',retry_after_ms:4000})),(e)=>e.category==='capacity' && e.retry_after_ms===4000);
  await assert.rejects(collect(events({type:'reasoning_handle',encrypted_ref:'encrypted:ref'})),/MODEL_CONTINUATION_UNSUPPORTED/);
});
test('cancel interrupts an adapter that ignores signal and has an unending return',async()=>{
  const cancel=new AbortController();let reached,observed;
  const ready=new Promise((r)=>{reached=r;});
  const hanging={id:'hang',stream(_req,sig){observed=sig;return {[Symbol.asyncIterator](){return this;},next(){reached();return new Promise(()=>{});},return(){return new Promise(()=>{});}};}};
  const running=collectModelTurn(hanging,request,cancel.signal,performance.now()+1000,limits);
  await ready;cancel.abort();await assert.rejects(running,/MODEL_CANCELLED/);assert.equal(observed.aborted,true);
});
test('absolute deadline also bounds final-event-then-hang',async()=>{
  const hanging={id:'hang',async *stream(){yield* events(stop);await new Promise(()=>{});}};
  await assert.rejects(collectModelTurn(hanging,request,new AbortController().signal,performance.now()+30,limits),/MODEL_DEADLINE/);
});
test('already-cancelled and microtask-cancelled operations are never entered',async()=>{
  let calls=0;const c=new AbortController();c.abort();
  await assert.rejects(bounded(async()=>{calls++;},c.signal,performance.now()+1000),/MODEL_CANCELLED/);
  const d=new AbortController();const work=bounded(async()=>{calls++;},d.signal,performance.now()+1000);d.abort();
  await assert.rejects(work,/MODEL_CANCELLED/);assert.equal(calls,0);
});
test('late adapter rejection after cancellation is observed',async()=>{
  let reject;const c=new AbortController();
  const pending=bounded(()=>new Promise((_r,r)=>{reject=r;}),c.signal,performance.now()+1000);
  await Promise.resolve();c.abort();await assert.rejects(pending,/MODEL_CANCELLED/);reject(new Error('late'));
  await new Promise((r)=>setImmediate(r));
});
test('invalid resource limits fail before adapter entry',async()=>{
  let calls=0;const provider={id:'never',stream(){calls++;throw new Error('not entered');}};
  await assert.rejects(collectModelTurn(provider,request,new AbortController().signal,performance.now()+1000,{...limits,max_events:0}),/MODEL_LIMITS/);
  assert.equal(calls,0);
});

test('adapter-thrown fault classes cannot leak arbitrary diagnostics',async()=>{
  const bad={id:'bad',async *stream(){throw new ModelFault('FAKE_SECRET_TOKEN','network',{input_tokens:0,output_tokens:0,reported:false});}};
  await assert.rejects(collectModelTurn(bad,request,new AbortController().signal,performance.now()+1000,limits),(e)=>e.message==='MODEL_NETWORK' && !JSON.stringify(e).includes('FAKE_SECRET'));
});
