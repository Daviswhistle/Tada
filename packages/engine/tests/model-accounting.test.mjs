import test from 'node:test';
import assert from 'node:assert/strict';
import { runModelLoop } from '../src/model-loop.ts';
import { ModelFault } from '../../providers/src/stream.ts';
const seed={schema_version:1,call_id:'digest-accounting',task_id:'task',tool:'task.contract_digest',tool_version:1,resource:'task://task/contract',purpose:'verify_input_snapshot',arguments:{expected_hash:'a'.repeat(64)}};
const limits={max_turns:6,max_tool_calls:1,max_recoveries:2,max_active_ms:1000,max_events:64,max_bytes:65536,max_call_bytes:16384};
const noTool={async invoke(){assert.fail('invalid streams must not invoke');}};

test('adapter reuse of an internal error code cannot skip observed usage accounting',async()=>{
  const adapter={id:'error-code-fixture',async *stream(request){
    yield {schema_version:1,request_id:request.request_id,seq:1,type:'usage',input_tokens:10,output_tokens:3};
    throw new ModelFault('MODEL_TOOL_SCHEMA','protocol',{input_tokens:0,output_tokens:0,reported:false});
  }};
  const result=await runModelLoop(adapter,seed,noTool,limits,new AbortController().signal);
  assert.equal(result.state,'diagnose');
  assert.equal(result.meter.turns,2);
  assert.equal(result.meter.input_tokens,20);
  assert.equal(result.meter.output_tokens,6);
  assert.equal(result.meter.uncertain_requests,2);
});
test('post-collection proposal rejection does not double count the completed request usage',async()=>{
  const adapter={id:'invalid-json-fixture',async *stream(request){
    yield {schema_version:1,request_id:request.request_id,seq:1,type:'usage',input_tokens:10,output_tokens:3};
    yield {schema_version:1,request_id:request.request_id,seq:2,type:'tool_call_complete',call_id:seed.call_id,payload_json:'{'};
    yield {schema_version:1,request_id:request.request_id,seq:3,type:'completed',finish_reason:'tool_calls'};
  }};
  const result=await runModelLoop(adapter,seed,noTool,limits,new AbortController().signal);
  assert.equal(result.state,'diagnose');
  assert.equal(result.meter.turns,2);
  assert.equal(result.meter.input_tokens,20);
  assert.equal(result.meter.output_tokens,6);
  assert.equal(result.meter.uncertain_requests,0);
});
