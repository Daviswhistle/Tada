import test from 'node:test';
import assert from 'node:assert/strict';
import { collectModelTurn, ModelFault } from '../src/stream.ts';
import { runModelLoop } from '../../engine/src/model-loop.ts';

const seed = {schema_version:1,call_id:'digest-cleanup',task_id:'task',tool:'task.contract_digest',tool_version:1,resource:'task://task/contract',purpose:'verify_input_snapshot',arguments:{expected_hash:'a'.repeat(64)}};
const limits = {max_turns:4,max_tool_calls:1,max_recoveries:2,max_active_ms:3000,max_events:64,max_bytes:65536,max_call_bytes:16384};
const streamLimits = {max_events:64,max_bytes:65536,max_calls:1,max_call_bytes:16384};
const request = {request_id:'cleanup-test',task_id:seed.task_id,phase:'proposal',input_hash:seed.arguments.expected_hash,proposal_json:JSON.stringify(seed),evidence_refs:[]};
const frame = (id,seq,type,fields={}) => ({schema_version:1,request_id:id,seq,type,...fields});
const unusedPort = {async invoke(){ assert.fail('no proposal from the rejected stream may execute'); }};
function faultyIterator(id) {
  let index = 0;
  const items = [
    frame(id,1,'usage',{input_tokens:11,output_tokens:7}),
    frame(id,2,'tool_call_complete',{call_id:seed.call_id,payload_json:JSON.stringify(seed)}),
    frame(id,3,'not_a_registered_event'),
  ];
  return {
    [Symbol.asyncIterator](){return this;},
    async next(){return index < items.length ? {done:false,value:items[index++]} : {done:true};},
  };
}

test('confirmed iterator cleanup precedes a fresh protocol recovery request',async()=>{
  let requests = 0, active = 0, reached, release;
  const ready = new Promise(resolve=>{reached=resolve;});
  const provider = {id:'cleanup-fixture',stream(req){
    requests++;
    if(requests===1){
      active++;
      const iterator=faultyIterator(req.request_id);
      iterator.return=function(){
        assert.equal(this,iterator,'preserve receiver identity for cleanup');
        reached();
        return new Promise(resolve=>{release=()=>{active--;resolve({done:true});};});
      };
      return iterator;
    }
    assert.equal(active,0,'a second producer cannot overlap the first');
    return (async function*(){
      yield frame(req.request_id,1,'usage',{input_tokens:1,output_tokens:1});
      yield frame(req.request_id,2,'completed',{finish_reason:'stop'});
    })();
  }};
  const running=runModelLoop(provider,seed,unusedPort,limits,new AbortController().signal);
  await ready;
  assert.equal(requests,1);assert.equal(active,1);
  release();
  const out=await running;
  assert.equal(out.state,'verify');assert.equal(requests,2);
  assert.equal(out.meter.recoveries,1);assert.equal(out.meter.tool_calls,0);
  assert.equal(out.meter.input_tokens,12);assert.equal(out.meter.output_tokens,8);
  assert.equal(out.meter.uncertain_requests,1);assert.deepEqual(out.evidence,[]);
});

test('eight unconfirmed cleanup variants forbid replacement requests and retain observed usage',async()=>{
  const variants = [
    ['missing',()=>{}],
    ['pending',it=>{it.return=()=>new Promise(()=>{});} ],
    ['rejected',it=>{it.return=async()=>{throw new Error('FAKE-CLEANUP-SECRET');};}],
    ['thrown',it=>{it.return=()=>{throw new Error('FAKE-CLEANUP-SECRET');};}],
    ['null',it=>{it.return=async()=>null;}],
    ['not-done',it=>{it.return=async()=>({done:false,value:'FAKE-CLEANUP-SECRET'});}],
    ['return-getter',it=>{Object.defineProperty(it,'return',{get(){throw new Error('FAKE-CLEANUP-SECRET');}});}],
    ['done-getter',it=>{it.return=async()=>({get done(){throw new Error('FAKE-CLEANUP-SECRET');}});}],
  ];
  assert.equal(variants.length,8,'fixed cleanup rejection denominator');
  for(const [name,change] of variants){
    let requests=0;
    const provider={id:'unconfirmed',stream(req){requests++;const it=faultyIterator(req.request_id);change(it);return it;}};
    const out=await runModelLoop(provider,seed,unusedPort,limits,new AbortController().signal);
    assert.equal(out.state,'unsupported',name);assert.equal(out.reason,'MODEL_CLEANUP_UNCONFIRMED',name);
    assert.equal(requests,1,name);assert.equal(out.meter.turns,1,name);
    assert.equal(out.meter.recoveries,0,name);assert.equal(out.meter.tool_calls,0,name);
    assert.equal(out.meter.input_tokens,11,name);assert.equal(out.meter.output_tokens,7,name);
    assert.equal(out.meter.uncertain_requests,1,name);assert.ok(!JSON.stringify(out).includes('FAKE-CLEANUP-SECRET'),name);
  }
});

test('natural EOF is sufficient even when a completed iterator has no return method',async()=>{
  let index=0;
  const provider={id:'natural',stream(){return {
    [Symbol.asyncIterator](){return this;},
    async next(){return index++===0 ? {done:false,value:frame(request.request_id,1,'completed',{finish_reason:'stop'})} : {done:true};},
  };}};
  const out=await collectModelTurn(provider,request,new AbortController().signal,performance.now()+1000,streamLimits);
  assert.equal(out.finish_reason,'stop');assert.deepEqual(out.calls,[]);
});

test('cancellation during stream acquisition still closes the acquired iterator',async()=>{
  const cancel=new AbortController();let closed=0,next=0;
  const provider={id:'acquisition-cancel',stream(){cancel.abort();return {
    [Symbol.asyncIterator](){return this;},
    async next(){next++;return {done:true};},
    async return(){closed++;return {done:true};},
  };}};
  await assert.rejects(collectModelTurn(provider,request,cancel.signal,performance.now()+1000,streamLimits),/MODEL_CANCELLED/);
  assert.equal(next,0);assert.equal(closed,1);
});

test('deadline expiring during synchronous acquisition does not lose iterator cleanup ownership',async()=>{
  let closed=0,next=0;
  const provider={id:'acquisition-deadline',stream(){
    const until=performance.now()+25;
    while(performance.now()<until){/* bounded synchronous acquisition fixture */}
    return {
      [Symbol.asyncIterator](){return this;},
      async next(){next++;return {done:true};},
      async return(){closed++;return {done:true};},
    };
  }};
  await assert.rejects(collectModelTurn(provider,request,new AbortController().signal,performance.now()+10,streamLimits),/MODEL_DEADLINE/);
  assert.equal(next,0);assert.equal(closed,1);
});

test('cancellation while cleanup is pending prevents a recovery request',async()=>{
  const cancel=new AbortController();let reached,requests=0;
  const ready=new Promise(resolve=>{reached=resolve;});
  const provider={id:'cleanup-cancel',stream(req){
    requests++;const it=faultyIterator(req.request_id);
    it.return=()=>{reached();return new Promise(()=>{});};return it;
  }};
  const running=runModelLoop(provider,seed,unusedPort,limits,cancel.signal);
  await ready;cancel.abort();
  const out=await running;
  assert.equal(out.state,'cancelled');assert.equal(requests,1);assert.equal(out.meter.recoveries,0);
  assert.equal(out.meter.input_tokens,11);assert.equal(out.meter.uncertain_requests,1);
});

test('a cleanup rejection arriving after the bounded wait remains observed',async()=>{
  let reject;
  const provider={id:'late-cleanup',stream(){
    const it=faultyIterator(request.request_id);
    it.return=()=>new Promise((_resolve,r)=>{reject=r;});return it;
  }};
  await assert.rejects(collectModelTurn(provider,request,new AbortController().signal,performance.now()+1000,streamLimits),
    e=>e instanceof ModelFault && e.message==='MODEL_CLEANUP_UNCONFIRMED');
  reject(new Error('FAKE-LATE-CLEANUP-SECRET'));
  await new Promise(resolve=>setImmediate(resolve));
});
