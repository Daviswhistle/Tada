// Cold continuing-file retrieval; injected provider and synthetic records only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { fileCopy } from '../../packages/engine/src/browser-file-actions.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const plain=v=>JSON.parse(JSON.stringify(v,(k,x)=>k==='provider_state'?undefined:x));
const base={definitions:[],validate:()=>false,execute:async()=>{throw Error('NO_SOURCE');},verify:async()=>false};
export const savedFileFixtures=[
 {mode:'restart',request:'전에 고쳐 둔 모임 명단 파일 다시 찾아줘. 무엇을 바꿨는지 확인하고 원본과 수정본 둘 다 받을 수 있게 해줘.',name:'모임명단.csv',original:'이름;인원\n가람;3\n누리;2\n',replacement:'이름,인원\n가람,3\n누리,2\n'},
 {mode:'recovery',request:'지난번에 손봤던 대여 목록 파일, 원본과 고친 걸 다시 받고 싶어. 어떤 부분이 달라졌는지도 알려줘.',name:'대여목록.json',original:'{"품목":"마이크","수량":4,}',replacement:'{"품목":"마이크","수량":4}'},
];
export async function runSavedFiles({provider,reportPath,implementation,requestLimit=16}) {
 if(!Number.isSafeInteger(requestLimit)||requestLimit<1||requestLimit>32)throw Error('EVAL_REQUEST_LIMIT_INVALID');
 const inspected=await provider.inspect(AbortSignal.timeout(20000));
 const report={kind:'saved_file_candidate',implementation,runtime:Object.fromEntries(Object.entries(inspected).filter(([k])=>['provider','model','model_digest','billing'].includes(k))),harness_sha256:sha(readFileSync(new URL(import.meta.url))),fixtures_sha256:sha(JSON.stringify(savedFileFixtures)),synthetic_data_only:true,product_acceptance:'not_passed',independent_semantic_review:'required',request_limit:requestLimit,started_at:new Date().toISOString(),model_requests:[],results:[]};
 const save=()=>writeFileSync(reportPath,JSON.stringify(plain(report),null,2)+'\n',{mode:0o600});
 for(const fixture of savedFileFixtures){
  const root=mkdtempSync(join(tmpdir(),'tada-saved-file-eval-')),options={directory:join(root,'journal'),passphrase:randomBytes(32).toString('base64url'),route:contactRoute({fixture:root})};let store,service;
  const result={mode:fixture.mode,fixture,calls:[]};report.results.push(result);save();
  try{
   store=new ContactStore({...options,initialize:true,assistance:true});let owner=store.addDevice('Synthetic owner').id;
   const seq=store.submit(owner,randomUUID(),'파일 형식 오류를 고쳐줘').seq;store.claim();
   const grant={device:owner,epoch:randomUUID(),target:'synthetic',url:'https://fixture.invalid/import',origin:'https://fixture.invalid',files:true};
   const view={key:'fixture',files:[{ref:'file-1',label:'선택 파일'}]};
   const original=fileCopy(fixture.name,'text/plain',Buffer.from(fixture.original)),copy=fileCopy('수정-'+fixture.name,'text/plain',Buffer.from(fixture.replacement));
   const id=store.admitBrowserFileAction(seq,grant,view,'file-1',original,copy,null);store.finishBrowserFileAction(id,true);
   // Later unrelated text records push the target past the display and scan page.
   for(let i=0;i<105;i++){
    const other={...grant,origin:`https://later${i}.invalid`,url:`https://later${i}.invalid/form`};
    const action=store.admitBrowserAction(seq,other,{key:'other',fields:[{ref:'text',label:'Title'}]},'text','보관');store.finishBrowserAction(action,'보관',null,false);
   }
   store.cancel(seq);const recordsBefore=store.exportRecords(owner).records.browser_actions;
   if(fixture.mode==='recovery'){
    const recovery=store.exportRecords(owner);store.close();store=new ContactStore({...options,directory:join(root,'restored'),initialize:true,recovery});owner=store.addDevice('Fresh owner').id;
   }else{store.close();store=new ContactStore(options);}
   // Key sort includes the state prefix: all 105 FAILED noise records precede
   // the UNCERTAIN file even though action IDs themselves are random UUIDs.
   const targetName=`browser_action:UNCERTAIN:${id}`;
   result.preceding_records=fixture.mode==='recovery' ? recordsBefore.map(r=>r.name).sort().indexOf(targetName) : recordsBefore.length-1;
   assert.equal(result.preceding_records,105);
   let preflight=store.savedFilePage(owner,seq+1);
   if(fixture.mode==='recovery'){assert.equal(preflight.records.length,0);assert.equal(preflight.next.phase,'recovered');preflight=store.savedFilePage(owner,seq+1,preflight.next);}
   assert.equal(preflight.records.length,0);assert.ok(preflight.next);
   assert.equal(store.savedFilePage(owner,seq+1,preflight.next).records[0].action.action_id,id);
   store.configureContinuingUse(owner,true,'continuing_conversation_24h_v1');
   const model={identity:provider.identity,chat:async(messages,tools,signal,beforeDispatch)=>{
    if(report.model_requests.length>=requestLimit)throw Error('EVAL_REQUEST_LIMIT');
    const attempt={number:report.model_requests.length+1,mode:fixture.mode,state:'reserved'},call={number:attempt.number,messages:plain(messages),tool_names:tools.map(t=>t.function.name)};report.model_requests.push(attempt);result.calls.push(call);save();
    try{const response=await provider.chat(messages,tools,signal,beforeDispatch);attempt.state='observed';call.response=plain(response.message);save();return response;}
    catch(error){attempt.state=error?.observedUsage?'observed_failure':'unknown';call.error=/^[A-Z_]{1,80}$/.test(error?.message)?error.message:'EVAL_PROVIDER_FAILED';save();throw error;}
   }};
   if(typeof provider.contextBytes==='function')model.contextBytes=(...args)=>provider.contextBytes(...args);if(provider.contextLimitBytes!==undefined)model.contextLimitBytes=provider.contextLimitBytes;
   service=new ContactService(store,model,base);const accepted=service.submit(owner,randomUUID(),fixture.request);await service.idle();const turn=store.turn(accepted.seq);
   result.state=turn.state;result.error=turn.error;result.answer=turn.answer;result.usage=store.usage();result.action_id=id;
   const observations=result.calls.flatMap(c=>c.messages).filter(m=>m.role==='tool').map(m=>({name:m.tool_name,result:JSON.parse(m.content)}));
   const reads=observations.filter(o=>o.name==='read_saved_file'&&o.result.action_id===id).map(o=>o.result);
   const after=store.exportRecords(owner);const historical=fixture.mode==='recovery'?after.recovered[0].records.browser_actions:after.records.browser_actions;
   result.mechanical_checks={answered:turn.state==='answered',listed_beyond_display_window:result.preceding_records===105&&observations.some(o=>o.name==='list_saved_files'&&o.result.files?.some(f=>f.action_id===id)),read_original:reads.some(r=>r.kind==='original'&&r.content===fixture.original),read_copy:reads.some(r=>r.kind==='replacement'&&r.content===fixture.replacement),linked_original:turn.answer?.text.includes(`/api/browser/files/${id}/original`)===true,linked_copy:turn.answer?.text.includes(`/api/browser/files/${id}/replacement`)===true,original_preserved:store.browserFile(owner,id,'original').sha256===original.sha256,copy_preserved:store.browserFile(owner,id,'replacement').sha256===copy.sha256,no_action_replay:JSON.stringify(recordsBefore)===JSON.stringify(historical),no_unknown_requests:store.usage().unknown_requests===0,recovery_provenance:fixture.mode!=='recovery'||reads.every(r=>r.recovery?.quarantined===true)};
   result.status=Object.values(result.mechanical_checks).every(Boolean)?'needs_semantic_review':'failed';
  }catch(error){result.status='failed';result.error=/^[A-Z_]{1,80}$/.test(error?.message)?error.message:'EVAL_FAILED';}
  finally{await service?.close();store?.close();rmSync(root,{recursive:true,force:true});save();}
  console.log(JSON.stringify({mode:result.mode,status:result.status,error:result.error,checks:result.mechanical_checks}));
  if(report.model_requests.some(r=>r.state==='unknown'))break;
 }
 report.finished_at=new Date().toISOString();save();return report;
}
