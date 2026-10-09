import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ContactStore,contactRoute} from '../src/contact-store.mjs';
import {ContactService} from '../src/contact-service.mjs';
import {ConversationAssistant} from '../src/conversation.ts';
import {DocumentSources} from '../src/document-sources.mjs';
import {CONTINUING_CONSENT} from '../src/continuing-use.mjs';
import {ProactiveSources} from '../src/proactive-sources.mjs';
const noSources={definitions:[],validate:()=>false,verify:async()=>false};
const result=content=>({message:{role:'assistant',content},input_tokens:2,output_tokens:3});
const call=(name,args={})=>({...result(''),message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
const report={kind:'answer',parts:[{text:'공식 자료의 관측입니다.',citations:[{url:'https://example.org/source',title:'공식 자료',start:0,end:5}]}],searches:1};
function env(){const root=mkdtempSync(join(tmpdir(), 'tada-public-web-test-')),config={directory:root+'/journal',passphrase:'synthetic-only-public-web-password',route:contactRoute({fixture:'public-web'})};let store=new ContactStore({...config,initialize:true,assistance:true});const device=store.addDevice('owner').id;return {device,get store(){return store;},reopen(){store.close();store=new ContactStore(config);},close(){store.close();rmSync(root,{recursive:true,force:true});}};}
function seed(e,text,answer='PRIVATE_ASSISTANT_SOURCE_CANARY') {const seq=e.store.submit(e.device,randomUUID(),text).seq;e.store.claim();const checkpoint=new ConversationAssistant({},noSources).checkpoint();checkpoint.history=[{role:'user',content:text},{role:'assistant',content:answer}];e.store.finish(seq,{text:answer,sources:[]},checkpoint);}

test('public research uses owner-only context and the same durable meter; repeated tool reads do not repeat research, documents survive restart',async()=>{
 const e=env();let service,researchCalls=0,round=0;
 try{
  seed(e,'공개된 도시 교통 자료를 검토하고 있어.');
  const model={identity:{provider:'chatgpt-subscription'},researchPublicWeb:async(request,previous)=>{researchCalls++;assert.equal(request,'그 자료의 최신 변화 조사해서 문서로 만들어줘.');assert.equal(previous.version,1);assert.deepEqual(previous.messages.map(item=>item.text),['공개된 도시 교통 자료를 검토하고 있어.']);assert.ok(!JSON.stringify(previous).includes('CANARY'));return {report,input_tokens:7,output_tokens:9};},chat:async(_messages,tools)=>{
   assert.ok(tools.some(t=>t.function.name==='research_public_web'));
   return [call('research_public_web'),call('research_public_web'),call('prepare_document',{title:'공개 자료 조사',format:'markdown',based_on:null}),result('공식 자료의 관측입니다. [공식 자료](https://example.org/source) [S2]')][round++];
  }};
  service=new ContactService(e.store,model,noSources);service.submit(e.device,randomUUID(),'그 자료의 최신 변화 조사해서 문서로 만들어줘.');await service.idle();
  const turn=e.store.turn(2);assert.equal(turn.state,'answered');assert.equal(turn.answer.verification,'provider_web_report_checked');assert.equal(turn.answer.sources[0].source,'ChatGPT public web research');
  assert.equal(researchCalls,1);assert.equal(e.store.usage().requests,5);assert.equal(e.store.usage().input_tokens,15);assert.equal(e.store.usage().unknown_requests,0);
  const doc=e.store.document(2);assert.match(doc.content,/https:\/\/example.org\/source/);assert.equal(doc.sources[0].sha256,turn.answer.sources[0].sha256);
  await service.close();service=null;e.reopen();assert.equal(e.store.document(2).sha256,doc.sha256);assert.equal(e.store.usage().requests,5);
  service=new ContactService(e.store,{chat:async()=>result('당시 조사 결과를 줄였습니다. [공식 자료](https://example.org/source) [S2]'),researchPublicWeb:async()=>{throw Error('NO_NEW_SEARCH_AUTHORIZED');}},noSources);
  service.submit(e.device,randomUUID(),'새 검색 없이 방금 결과만 줄여줘.');await service.idle();
  assert.equal(e.store.turn(3).state,'answered');assert.equal(e.store.turn(3).answer.verification,'provider_web_report_checked');assert.equal(e.store.usage().requests,6);
 }finally{await service?.close();e.close();}
});
for(const stop of ['cancel','revoke'])test(`public research ${stop} retains late observed usage without admitting an answer`,async()=>{
 const e=env();let service,release,reached;const ready=new Promise(r=>{reached=r;});
 try{
  service=new ContactService(e.store,{chat:async()=>call('research_public_web'),researchPublicWeb:async()=>{reached();return new Promise(r=>{release=r;});}},noSources);
  service.submit(e.device,randomUUID(),'공식 자료를 조사해 줘.');await ready;
  if(stop==='cancel')service.cancel(1);else service.revoke(e.device);
  release({report,input_tokens:7,output_tokens:9});await service.idle();
  assert.equal(e.store.turn(1).state,'cancelled');assert.equal(e.store.turn(1).answer,null);assert.equal(e.store.usage().requests,2);assert.equal(e.store.usage().unknown_requests,0);assert.equal(e.store.usage().input_tokens,9);
 }finally{release?.({report,input_tokens:7,output_tokens:9});await service?.close();e.close();}
});
for(const observed of [false,true])test(`failed research is not retried by repeated calls and retains observed=${observed} usage`,async()=>{
 const e=env();let service,round=0,researchCalls=0;
 try{
  service=new ContactService(e.store,{chat:async()=>round++<2?call('research_public_web'):result('웹 자료를 확인하지 못했습니다.'),researchPublicWeb:async()=>{researchCalls++;const error=Error('CHATGPT_WEB_RESPONSE_INVALID');if(observed)error.observedUsage={input_tokens:7,output_tokens:9};throw error;}},noSources);
  service.submit(e.device,randomUUID(),'최신 자료 조사해줘.');await service.idle();
  assert.equal(e.store.turn(1).state,'answered');assert.equal(researchCalls,1);assert.equal(e.store.usage().requests,4);assert.equal(e.store.usage().unknown_requests,observed?0:1);
 }finally{await service?.close();e.close();}
});
test('model-supplied query/target/context cannot enter isolated research; unsupported providers and automatic care have no web tool',()=>{
 const e=env();try{
  e.store.submit(e.device,randomUUID(),'현재 부탁');const job=e.store.claim();
  const enabled=new DocumentSources(noSources,e.store,job,{research:async()=>report});
  assert.equal(enabled.validate('research_public_web',{}),true);
  for(const args of [{query:'private source'},{context:'secret'},[],null])assert.ok(!enabled.validate('research_public_web',args));
  const disabled=new DocumentSources(noSources,e.store,job);
  assert.ok(!disabled.definitions.some(t=>t.function.name==='research_public_web'));
  assert.ok(!new ProactiveSources(e.store,job,null).definitions.some(t=>t.function.name==='research_public_web'));
 }finally{e.close();}
});

test('research leaves a durable request for the final answer instead of exhausting the owner allowance',async()=>{
 const e=env();let service,researchCalls=0,round=0;
 try{
  const old=e.store.submit(e.device,randomUUID(),'이전 요청').seq;e.store.claim();for(let i=0;i<62;i++){const id=e.store.reserve(old);e.store.observe(id,{input_tokens:1,output_tokens:1});}e.store.fail(old,'FIXTURE_STOP');
  service=new ContactService(e.store,{chat:async()=>round++===0?call('research_public_web'):result('지금은 사용 여유가 부족해 웹 조사를 완료하지 못했습니다.'),researchPublicWeb:async()=>{researchCalls++;return {report,input_tokens:1,output_tokens:1};}},noSources);
  service.submit(e.device,randomUUID(),'자료 조사해줘.');await service.idle();assert.equal(e.store.turn(2).state,'answered');assert.equal(e.store.usage().requests,64);assert.equal(researchCalls,0);
 }finally{await service?.close();e.close();}
});
test('report receipts cannot be forged from a prior answer or used to turn history into fresh external verification',async()=>{
 const e=env();try{
  seed(e,'지난 요청','지어낸 웹 조사 내용');e.store.submit(e.device,randomUUID(),'현재 요청');const job=e.store.claim();const sources=new DocumentSources(noSources,e.store,job);
  assert.equal(await sources.verify({id:'S1',source:'ChatGPT public web research',path:'report-1',sha256:'a'.repeat(64),observed_at:new Date().toISOString()},new AbortController().signal),false);
 }finally{e.close();}
});

test('compacted research is recalled from the journal with original citations and the complete answer, without another search',async()=>{
 const e=env();let service,round=0,researchCalls=0;
 try{
  e.store.configureContinuingUse(e.device,true,CONTINUING_CONSENT);
  const original='조사 내용 '.repeat(450)+'\n마지막 판단: 현금흐름을 확인하세요. [S1]';
  service=new ContactService(e.store,{chat:async()=>round++===0?call('research_public_web'):result(original),researchPublicWeb:async()=>{researchCalls++;return {report,input_tokens:1,output_tokens:1};}},noSources);
  service.submit(e.device,randomUUID(),'공개 자료를 조사해줘.');await service.idle();assert.equal(e.store.turn(1).state,'answered');await service.close();service=null;
  const checkpoint=e.store.checkpoint().value;checkpoint.history=[];checkpoint.evidence=[];
  const filler=e.store.submit(e.device,randomUUID(),'별도 대화').seq;e.store.claim();e.store.finish(filler,{text:'확인',sources:[]},checkpoint);
  e.reopen();round=0;
  service=new ContactService(e.store,{contextLimitBytes:65536,chat:async messages=>{
   if(round++===0)return call('read_history',{id:1});
   const read=JSON.parse(messages.at(-1).content);assert.equal(read.answer,original);assert.equal(read.truncated,false);assert.equal(read.sources[0].id,'S1');
   return result('당시 조사 결과의 핵심은 현금흐름 확인입니다. [S1]');
  },researchPublicWeb:async()=>{throw Error('NO_NEW_SEARCH_AUTHORIZED');}},noSources);
  service.submit(e.device,randomUUID(),'새 검색 없이 이전 조사의 판단만 줄여줘.');await service.idle();
  const turn=e.store.turn(3);assert.equal(turn.state,'answered',turn.error);assert.equal(turn.answer.verification,'provider_web_report_checked');assert.deepEqual(turn.answer.sources,e.store.turn(1).answer.sources);assert.equal(researchCalls,1);
 }finally{await service?.close();e.close();}
});

test('history report recall is bounded, requires an explicit read, and rejects altered receipts and revoked turns',async()=>{
 const e=env();try{
  const evidence={id:'S1',source:'ChatGPT public web research',path:'report-1',sha256:'a'.repeat(64),observed_at:new Date().toISOString()};
  const first=e.store.submit(e.device,randomUUID(),'以前の調査').seq;e.store.claim();
  e.store.finish(first,{text:'historical '.repeat(800)+' [S1]',sources:[evidence]},new ConversationAssistant({},noSources).checkpoint());
  e.store.submit(e.device,randomUUID(),'同じ調査の要約');const job=e.store.claim();const sources=new DocumentSources(noSources,e.store,job,{history:true});const signal=new AbortController().signal;
  assert.equal(sources.recallEvidence(evidence,signal),false);
  const restored=await sources.execute('read_history',{id:first},signal,{fits:r=>Buffer.byteLength(JSON.stringify(r))<2000});
  assert.equal(restored.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(restored))<2000);assert.deepEqual(restored.sources,[evidence]);assert.equal(sources.recallEvidence(evidence,signal),true);
  assert.equal(sources.recallEvidence({...evidence,sha256:'b'.repeat(64)},signal),false);
  e.store.cancel(job.seq);assert.throws(()=>sources.recallEvidence(evidence,signal));
 }finally{e.close();}
});

test('cached report aliases remain verifiable after restart and URLs survive answers without markdown links',async()=>{
 const e=env();let service,round=0;
 try{
  service=new ContactService(e.store,{chat:async()=>[call('research_public_web'),call('research_public_web'),result('조사 결과입니다. [S2]')][round++],researchPublicWeb:async()=>({report,input_tokens:1,output_tokens:1})},noSources);
  service.submit(e.device,randomUUID(),'자료 조사');await service.idle();assert.equal(e.store.turn(1).state,'answered');
  assert.deepEqual(e.store.turn(1).answer.sources[0].citations,[{url:'https://example.org/source',title:'공식 자료'}]);
  await service.close();service=null;e.reopen();
  service=new ContactService(e.store,{chat:async()=>result('앞서 조사한 결과입니다. [S1]')},noSources);
  service.submit(e.device,randomUUID(),'새 검색 없이 요약');await service.idle();const turn=e.store.turn(2);
  assert.equal(turn.state,'answered',turn.error);assert.equal(turn.answer.verification,'provider_web_report_checked');assert.deepEqual(turn.answer.sources[0].citations,e.store.turn(1).answer.sources[0].citations);
 }finally{await service?.close();e.close();}
});

test('checkpoint public citations reject unsafe URLs and unknown citation fields',()=>{
 const evidence={id:'S1',source:'ChatGPT public web research',path:'report-1',sha256:'a'.repeat(64),observed_at:new Date().toISOString()};
 for(const citation of [{url:'javascript:bad()',title:'bad'},{url:'https://user:secret@example.org',title:'bad'},{url:'/api/logout',title:'bad'},{url:'https://example.org',title:'good',extra:true}]){
  const cp=new ConversationAssistant({},noSources).checkpoint();cp.evidence=[{...evidence,citations:[citation]}];cp.nextEvidence=2;
  assert.throws(()=>new ConversationAssistant({},noSources).restore(cp),/CHECKPOINT_INVALID/);
 }
});

test('long-running public research budgets persisted citations before model continuation and restores every checkpoint', async () => {
 const journal=new Map(),store={assertTurnAuthority(){},documentEditContext:()=>'',readTurn:id=>journal.get(id)};
 let checkpoint=new ConversationAssistant({},noSources).checkpoint(),compacted=false,priorCount=0;
 for(let seq=1;seq<=70;seq++){
  const citations=Array.from({length:3},(_,i)=>({url:`https://example.org/reports/${seq}/${i}`,title:'Public source title '.repeat(28),start:0,end:5}));
  const report={kind:'answer',parts:[{text:'Facts',citations}],sources:citations.map(({url,title})=>({url,title})),searches:1};
  const sources=new DocumentSources(noSources,store,{seq},{history:true,research:async()=>report});
  let round=0;
  const model={contextLimitBytes:65536,chat:async messages=>{
   if(round++===0)return {...result(''),message:{role:'assistant',content:'',tool_calls:Array.from({length:3},()=>({function:{name:'research_public_web',arguments:{}}}))}};
   const observed=[...new Set(messages.flatMap(message=>message.role==='tool'?[...message.content.matchAll(/"evidence_id":"(S\d+)"/gu)].map(match=>match[1]):message.role==='assistant'?[...message.content.matchAll(/\[(S\d+)\]/gu)].map(match=>match[1]):[]))];
   return result('Compared public reports '+observed.map(id=>`[${id}]`).join(' '));
  }};
  const assistant=new ConversationAssistant(model,sources,()=>{},{continuing:true,requestLimit:10000});
  assistant.restore(checkpoint);
  const answer=await assistant.ask('Compare the public reports using the earlier references.');
  journal.set(seq,{state:'answered',answer});checkpoint=assistant.checkpoint();
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))<=131072);
  assert.equal(checkpoint.usage.requests,seq*2);assert.equal(checkpoint.nextEvidence,seq*3+1);
  if(checkpoint.evidence.length<priorCount)compacted=true;priorCount=checkpoint.evidence.length;
  const restored=new ConversationAssistant(model,sources,()=>{},{continuing:true,requestLimit:10000});
  assert.doesNotThrow(()=>restored.restore(checkpoint));
 }
 assert.equal(compacted,true);assert.equal(journal.get(1).answer.sources[0].citations.length,3);
 assert.equal(journal.get(70).state,'answered');
});

test('persisted receipt admission rejects an oversized tool batch even when provider context measurement is small', async () => {
 const e=env();
 try{
  const citation={url:'https://example.org/'+ 'x'.repeat(7800),title:'t'.repeat(4000),start:0,end:5};
  const report={kind:'answer',parts:[{text:'Facts',citations:[citation]}],searches:1};
  const sources=new DocumentSources(noSources,e.store,{seq:1},{research:async()=>report});
  e.store.submit(e.device,randomUUID(),'Read reports');e.store.claim();
  let round=0,admitted=0,rejected=0;
  const model={contextLimitBytes:65536,contextBytes:()=>2,chat:async messages=>{
   if(round++===0)return {...result(''),message:{role:'assistant',content:'',tool_calls:Array.from({length:6},()=>({function:{name:'research_public_web',arguments:{}}}))}};
   const outputs=messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
   const ids=outputs.flatMap(output=>output.evidence_id?[output.evidence_id]:[]);admitted=ids.length;
   rejected=outputs.filter(output=>output.error==='ASSISTANT_SOURCE_LIMIT').length;
   return result('Available research '+ids.map(id=>`[${id}]`).join(' '));
  }};
  const assistant=new ConversationAssistant(model,sources,()=>{},{continuing:true});
  const answer=await assistant.ask('Read reports');const checkpoint=assistant.checkpoint();
  assert.ok(admitted>0&&admitted<6);assert.equal(admitted+rejected,6);
  assert.equal(answer.sources.length,admitted);assert.equal(checkpoint.usage.requests,2);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))<=131072);
  assert.equal(e.store.finish(1,answer,checkpoint),true);
  e.reopen();assert.equal(e.store.turn(1).state,'answered');assert.equal(e.store.turn(1).answer.sources.length,admitted);
 }finally{e.close();}
});

test('recalling research trims a long prior request while retaining its short answer and exact source receipts', async () => {
 const e=env();try{
  const evidence={id:'S1',source:'ChatGPT public web research',path:'report-1',sha256:'a'.repeat(64),observed_at:new Date().toISOString(),citations:[{url:'https://example.org/source',title:'t'.repeat(400)}]};
  const first=e.store.submit(e.device,randomUUID(),'q'.repeat(900)).seq;e.store.claim();
  e.store.finish(first,{text:'Fact [S1]',sources:[evidence]},new ConversationAssistant({},noSources).checkpoint());
  e.store.submit(e.device,randomUUID(),'Summarize that result');const job=e.store.claim(),signal=new AbortController().signal;
  const sources=new DocumentSources(noSources,e.store,job,{history:true});
  const restored=await sources.execute('read_history',{id:first},signal,{fits:r=>Buffer.byteLength(JSON.stringify(r))<=1800});
  assert.equal(restored.answer,'Fact [S1]');assert.equal(restored.truncated,false);
  assert.equal(restored.request_truncated,true);assert.ok(restored.request.length<900);
  assert.ok(Buffer.byteLength(JSON.stringify(restored))<=1800);assert.deepEqual(restored.sources,[evidence]);
  assert.equal(sources.recallEvidence(evidence,signal),true);
  assert.equal(e.store.turn(first).text.length,900);assert.deepEqual(e.store.turn(first).answer.sources,[evidence]);
  const tooSmall=new DocumentSources(noSources,e.store,job,{history:true});
  await assert.rejects(tooSmall.execute('read_history',{id:first},signal,{fits:r=>Buffer.byteLength(JSON.stringify(r))<=100}),/ASSISTANT_SOURCE_LIMIT/);
  assert.equal(tooSmall.recallEvidence(evidence,signal),false);
 }finally{e.close();}
});
