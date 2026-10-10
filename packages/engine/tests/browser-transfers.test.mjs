import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { BrowserSources } from '../src/browser-sources.mjs';
import { BrowserTransfers, TRANSFER_CONSENT } from '../src/browser-transfers.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { ContactService } from '../src/contact-service.mjs';
import { CONTINUING_CONSENT } from '../src/continuing-use.mjs';
import { fileCopy } from '../src/browser-file-actions.mjs';
import { HISTORY_TOOLS, validHistoryCall, readConversationHistory } from '../src/history-sources.mjs';
import Ajv from 'ajv';
import { DocumentSources } from '../src/document-sources.mjs';
import { EventEmitter } from 'node:events';
import { checkSelectedFile } from '../src/shared-browser-files.mjs';
import { runInNewContext } from 'node:vm';
import { responsesInput } from '../../providers/src/chatgpt-subscription.mjs';
import { discoveryTools } from '../src/native-sources.mjs';
import { GOOGLE_SEND_SCOPES } from '../src/google-contract.mjs';
import { MAIL_SEND_CONSENT } from '../src/mail-actions.mjs';
const empty = { definitions: [], validate: () => false, verify: async () => false };
const signal = () => new AbortController().signal;
const reply = text => ({ message: { role: 'assistant', content: text }, input_tokens: 1, output_tokens: 1 });
const call = (name, args = {}) => ({ ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
function fixture({mail=false}={}) {
  const root = mkdtempSync(join(tmpdir(), 'tada-transfer-'));
  const options = { directory: join(root,'journal'), passphrase: 'Synthetic transfer fixture', route: contactRoute({ test:'transfers' }) };
  let store = new ContactStore({ ...options, initialize:true, assistance:true, mail });
  const device = store.addDevice('Owner').id, other = store.addDevice('Other').id;
  const original = fileCopy('original.csv','text/csv',Buffer.from('name,value\noriginal,1\n'));
  const browser = { grant:{ epoch:randomUUID(), device, target:'synthetic', url:'https://fixture.invalid/edit', origin:'https://fixture.invalid', files:true }, writes:0, releases:[],
    assert(epoch) { if (this.grant?.epoch !== epoch) throw Error('CONTACT_BROWSER_TARGET_CHANGED'); },
    async observe(epoch,admit) { admit(); return { key:randomUUID(), url:this.grant.url, title:'Synthetic', text:'Untrusted', fields:[{ref:'1',label:'Title',value:'Original'}], files:[{ref:'file-1',label:'CSV',name:original.name,replaceable:true,submitters:[{ref:'submit-1',label:'Import'}]}] }; },
    async checkText(epoch,observation,ref,length,admit) { admit(); assert.equal(typeof length,'number'); return {ready:true}; },
    async checkFile(epoch,observation,ref,source,submit,admit) { admit(); assert.deepEqual(source,original); return {ready:true}; },
    async fill(epoch,observation,ref,value,admit) { admit(); this.writes++; this.value=value; return {applied:true}; },
    async verify(epoch,observation,admit) { admit(); return {url:this.grant.url,value:this.value}; },
    async readFile(epoch,observation,ref,admit) { admit(); return original; },
    async replaceFile(epoch,observation,ref,source,replacement,submit,admit) { admit(); this.writes++; this.copy=replacement; this.submit=submit; return {applied:true,submitted:submit!==null}; },
    async release(...args) { this.releases.push(args); }, unshare() { this.grant=null; }, async close() {} };
  const manager = new BrowserTransfers(store,browser,()=>{});
  return {root,device,other,browser,manager,original,get store(){return store;},
    job() { store.submit(device,randomUUID(),'이전 내용을 공유한 화면에 옮겨줘.'); return store.claim(); },
    reopen() {store.close();store=new ContactStore(options);},
    close(){store.close();rmSync(root,{recursive:true,force:true});} };
}
async function prepare(e, {file=false, google=null, finish=true}={}) {
  const job=e.job(), scope=e.manager.capture(job,google), sources=new BrowserSources(empty,e.store,e.browser,job,{prepare:scope.stage});
  const observed=await sources.execute('observe_shared_browser',{},signal());
  let args={observation:observed.observation,ref:'1',value:'SYNTHETIC_PRIVATE_EXACT <script> & "한글"'};
  if(file){const read=await sources.execute('read_shared_file',{observation:observed.observation,ref:'file-1',encoding:'auto'},signal());args={file:read.file,name:'approved.csv',content:null,edits:[{old_text:'original',new_text:'승인 내용'}],submit:'submit-1'};}
  assert.equal(sources.validate(file?'replace_shared_file':'fill_shared_textbox',args),false);
  const staged=await sources.execute(file?'prepare_browser_file_transfer':'prepare_browser_text_transfer',args,signal());
  assert.equal(staged.state,'awaiting_owner_confirmation'); assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
  await sources.close(); assert.equal(e.browser.releases.length,0);
  if(finish){e.store.finish(job.seq,{text:'준비했어요.',sources:[],verification:'not_applicable'},new ConversationAssistant({chat:async()=>reply('fixture')},empty).checkpoint());assert.equal(scope.publish(),true);}
  return {job,scope,args,preview:e.manager.status(e.device)};
}
const approval = preview => ({id:preview.id,revision:preview.revision,sha256:preview.sha256,consent:TRANSFER_CONSENT});
function seedMail(e) {
  const job=e.job(),record=e.store.prepareMail(job.seq,{account:'owner@example.test',to:['recipient@example.test'],cc:[],bcc:[],subject:'Synthetic status',body:'Synthetic body',reply:null});
  e.store.finish(job.seq,{text:'초안 준비',sources:[]},new ConversationAssistant({},empty).checkpoint(),[],null,null,record);
  return record;
}
function connectedGoogle(e) {
  const credential={version:2,send_enabled:true,epoch:randomUUID(),device:e.device,scopes:[...GOOGLE_SEND_SCOPES],refresh_token:'SYNTHETIC_REFRESH_ONLY',email:'owner@example.test',connected_at:Date.now(),last_checked:null,last_error:null,reconnect_required:false};
  e.store.saveGoogleCredential(e.device,credential,null);
  return Object.assign(new EventEmitter(),{connect(){},close(){},status:()=>({configured:true,connected:true}),captureGrant:()=>({connected:true,email:credential.email,epoch:credential.epoch,related_mail_epoch:e.store.relatedMailEpoch()}),assertSnapshot(){},sweepAuthority(){}});
}
for(const file of [false,true])for(const state of ['ACCEPTED','UNCERTAIN'])test(`mail ${state} lookup preserves same-turn ${file?'file':'text'} preparation`,async()=>{
  const e=fixture({mail:true});let service,step=0,checks=0,sends=0;try{
    const google=connectedGoogle(e),record=seedMail(e);
    e.store.beginMailSend(e.device,record.id,record.revision,record.sha256,e.store.googleEpoch(),MAIL_SEND_CONSENT);
    e.store.finishMailSend(record.id,state,state==='ACCEPTED'?'gmail_accepted_not_delivery':'outcome_unknown',state==='ACCEPTED'?{gmail_id:'sent1',thread_id:'thread1',http_status:200}:{});
    google.reconcileMail=async(device,id)=>{checks++;e.store.assertDevice(device);return e.store.readMailAction(id);};
    google.sendMail=async()=>{sends++;throw Error('UNEXPECTED_SEND');};
    service=new ContactService(e.store,{contextLimitBytes:65536,async chat(messages){step++;
      if(step===1)return call('read_mail_action',{id:record.id});
      if(step===2){assert.equal(JSON.parse(messages.at(-1).content).status_check.state,'fresh');return call('observe_shared_browser');}
      if(step===3){const observation=JSON.parse(messages.at(-1).content).observation;return file?call('read_shared_file',{observation,ref:'file-1',encoding:'auto'}):call('prepare_browser_text_transfer',{observation,ref:'1',value:'Confirmed lookup'});}
      if(file&&step===4)return call('prepare_browser_file_transfer',{file:JSON.parse(messages.at(-1).content).file,name:'status.csv',content:'status,value\nchecked,1\n',edits:[],submit:null});
      assert.equal(JSON.parse(messages.at(-1).content).state,'awaiting_owner_confirmation');return reply('준비했어요.');
    }},empty);service.attachGoogle(google);service.attachBrowser(e.browser);
    const job=service.submit(e.device,randomUUID(),'메일 상태를 조회하고 공유 화면에 옮길 내용을 준비해줘.');await service.idle();
    assert.equal(e.store.turn(job.seq).state,'answered');const preview=service.browserStatus(e.device).transfer;assert.equal(preview.state,'ready');
    await service.reconcileMail(e.device,record.id,signal());assert.equal(checks,2);assert.equal(service.browserStatus(e.device).transfer.id,preview.id);
    assert.equal(sends,0);assert.equal(e.browser.writes,0);
  }finally{await service?.close();e.close();}
});
for(const action of ['send','edit','discard'])test(`owner mail ${action} still invalidates a prepared browser transfer`,async()=>{
  const e=fixture({mail:true});let service,step=0;try{
    const google=connectedGoogle(e),record=seedMail(e);google.sendMail=async()=>record;
    service=new ContactService(e.store,{contextLimitBytes:65536,async chat(messages){step++;if(step===1)return call('observe_shared_browser');if(step===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'private'});return reply('준비했어요.');}},empty);
    service.attachGoogle(google);service.attachBrowser(e.browser);service.submit(e.device,randomUUID(),'준비해줘.');await service.idle();assert.equal(service.browserStatus(e.device).transfer.state,'ready');
    const input={id:record.id,revision:record.revision,sha256:record.sha256};
    if(action==='send'){const sending=service.sendMail(e.device,{...input,consent:MAIL_SEND_CONSENT});assert.equal(service.browserStatus(e.device).transfer,null);await sending;}
    if(action==='edit')service.editMail(e.device,{...input,draft:{...record.draft,body:'Owner changed'}});
    if(action==='discard')service.discardMail(e.device,input);
    assert.equal(service.browserStatus(e.device).transfer,null);assert.equal(e.browser.writes,0);
  }finally{await service?.close();e.close();}
});
for(const previous of [false,true])for(const task of ['greeting','text','file','editor'])test(`all connected features fit default local context: ${task}, prior receipt=${previous}`,async()=>{
  const e=fixture({mail:true});let service,step=0,editorStep=0;const sizes=[],errors=[];try{
    const google=connectedGoogle(e);e.store.configureContinuingUse(e.device,true,CONTINUING_CONSENT);e.store.configureFollowupDelegation(e.device,true,'personal_followups_v1');e.store.configureRelatedMail(e.device,true,'related_mail_readonly_v1');e.store.configureProactive(e.device,true,'connected_attention_v2','Asia/Seoul');
    if(previous){const {preview}=await prepare(e);await e.manager.approve(e.device,approval(preview));}
    const model={identity:{provider:'ollama-local'},contextBytes:(messages,tools)=>Buffer.byteLength(JSON.stringify({messages,tools})),async chat(messages,tools){
      sizes.push(this.contextBytes(messages,tools));assert.ok(sizes.at(-1)<=14000);
      if(messages[0].content.includes('Isolated browser work.')){
        editorStep++;if(editorStep===1)return call('observe_shared_browser');if(editorStep===2)return call('fill_shared_textbox',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'Repaired'});return reply('입력값을 확인했어요.');
      }
      const ready=(name,args={})=>{if(tools.some(t=>t.function.name===name))return call(name,args);step--;return call('select_tools',{names:[name]});};
      const latest=messages.findLast(m=>m.role==='tool'&&m.tool_name!=='select_tools');
      step++;if(previous)assert.match(JSON.stringify(messages),/CONFIRMED_APPLIED/);
      if(task==='greeting')return reply('안녕');
      if(messages.at(-1).role==='tool'){const error=JSON.parse(messages.at(-1).content).error;if(error)errors.push(error);assert.equal(error,undefined);}
      if(step===1)return ready('observe_shared_browser');
      if(step===2){const observation=JSON.parse(latest.content).observation;
        if(task==='editor')return ready('work_on_shared_browser');
        return task==='text'?ready('prepare_browser_text_transfer',{observation,ref:'1',value:'Stored context'}):ready('read_shared_file',{observation,ref:'file-1',encoding:'auto'});
      }
      if(step===3&&task==='file')return ready('prepare_browser_file_transfer',{file:JSON.parse(latest.content).file,name:'copy.csv',content:'name,value\nnew,2\n',edits:[],submit:null});
      return reply('준비했어요.');
    }};
    service=new ContactService(e.store,model,{...empty,definitions:discoveryTools},{timezone:'Asia/Seoul'});service.attachGoogle(google);service.attachBrowser(e.browser);
    const job=service.submit(e.device,randomUUID(),task==='greeting'?'안녕':'현재 부탁을 처리해줘.');await service.idle();
    assert.equal(e.store.turn(job.seq).state,'answered',JSON.stringify({turn:e.store.turn(job.seq),sizes,step,editorStep,errors}));
    if(task==='text'||task==='file')assert.equal(service.browserStatus(e.device).transfer?.state,'ready');
    if(task==='editor'){assert.equal(editorStep,3);assert.equal(e.browser.value,'Repaired');}
  }finally{await service?.close();e.close();}
});
test('exact preview applies once without inference and receipt survives restart in conversation/history',async()=>{
  const e=fixture();try{
    const {job,args,preview}=await prepare(e); assert.equal(preview.text,args.value);assert.equal(e.manager.status(e.other),null);
    const input=approval(preview), first=e.manager.approve(e.device,input),second=e.manager.approve(e.device,input);assert.equal(first,second);
    const result=await first;assert.equal(result.result.state,'VERIFIED');assert.equal(e.browser.value,args.value);assert.equal(e.browser.writes,1);
    assert.deepEqual(await e.manager.approve(e.device,input),result);assert.equal(e.store.usage().requests,0);
    assert.equal(e.store.page().turns[0].browser_receipts[0].state,'VERIFIED');
    e.reopen();assert.equal(new BrowserTransfers(e.store,e.browser,()=>{}).status(e.device),null);
    const next=e.job();assert.equal(e.store.readHistory(job.seq,next.seq).browser_receipts[0].state,'VERIFIED');
    assert.match(e.store.browserReceiptContext(next.seq),/CONFIRMED_APPLIED/);
  }finally{e.close();}
});
for(const mutation of ['digest','revision','id','consent','unknown','device'])test(`owner approval rejects ${mutation} without write`,async()=>{
  const e=fixture();try{const {preview}=await prepare(e),input=approval(preview);if(mutation==='unknown')input.value='hidden replacement';else if(mutation!=='device')input[mutation==='digest'?'sha256':mutation]='wrong';assert.throws(()=>e.manager.approve(mutation==='device'?e.other:e.device,input));assert.equal(e.browser.writes,0);}finally{e.close();}
});
for(const mutation of ['new_request','revoke','share','history_off_on','google','expiry','discard'])test(`prepared transfer cannot apply after ${mutation}`,async()=>{
  const e=fixture();const now=Date.now;try{
    let epoch='first';const google={captureGrant:()=>epoch,assertSnapshot:(device,value)=>{if(value!==epoch)throw Error('CONTACT_GOOGLE_GRANT_CHANGED');}};
    const {preview}=await prepare(e,{google}),input=approval(preview);
    if(mutation==='new_request')e.manager.invalidate();if(mutation==='revoke')e.store.revoke(e.device);if(mutation==='share')e.browser.grant={...e.browser.grant,epoch:randomUUID()};
    if(mutation==='history_off_on'){e.store.configureContinuingUse(e.device,false,null);e.store.configureContinuingUse(e.device,true,CONTINUING_CONSENT);}
    if(mutation==='google')epoch='second';if(mutation==='expiry')Date.now=()=>now()+300001;
    if(mutation==='discard')e.manager.discard(e.device,input);
    assert.throws(()=>e.manager.approve(e.device,input));assert.equal(e.browser.writes,0);
  }finally{Date.now=now;e.close();}
});
test('an old running turn cannot publish after new owner input; snapshot release targets only the old key',async()=>{
  const e=fixture();try{const job=e.job(),scope=e.manager.capture(job,null);e.manager.invalidate();assert.throws(()=>scope.stage({grant:e.browser.grant}));assert.equal(e.browser.writes,0);}finally{e.close();}
});
test('file preview shows final patched bytes; one approval preserves original and selected submit',async()=>{
  const e=fixture();try{const {preview}=await prepare(e,{file:true});assert.equal(preview.text,'name,value\n승인 내용,1\n');assert.equal(preview.submit,'Import');const result=await e.manager.approve(e.device,approval(preview));assert.equal(e.browser.writes,1);assert.equal(e.browser.submit,'submit-1');assert.equal(Buffer.from(e.browser.copy.data,'base64').toString(),preview.text);assert.deepEqual(e.store.browserFile(e.device,result.result.id,'original'),e.original);assert.equal(result.result.state,'UNCERTAIN');}finally{e.close();}
});
for(const mode of ['response_lost','verification_lost','revoked_after_dispatch','changed_target'])test(`${mode} preserves effect distinction without replay`,async()=>{
  const e=fixture();try{const {preview}=await prepare(e),input=approval(preview),fill=e.browser.fill;
    e.browser.fill=async(...args)=>{if(mode==='changed_target'){args.at(-1)();return {applied:false,reason:'target_changed'};}const result=await fill.apply(e.browser,args);if(mode==='response_lost')throw Error('lost');if(mode==='revoked_after_dispatch')e.manager.invalidate();return result;};
    if(mode==='verification_lost')e.browser.verify=async()=>{throw Error('lost');};
    const result=await e.manager.approve(e.device,input), expected=mode==='changed_target'?'FAILED':'UNCERTAIN';
    if(mode==='revoked_after_dispatch'){assert.equal(result,null);assert.throws(()=>e.manager.approve(e.device,input));}
    else {assert.equal(result.result.state,expected);await e.manager.approve(e.device,input);}
    assert.equal(e.browser.writes,mode==='changed_target'?0:1);e.reopen();assert.equal(e.store.page().turns[0].browser_receipts[0].state,expected);
  }finally{e.close();}
});
test('same ContactService prepares with private context; approval needs no extra model request and next turn sees receipt',async()=>{
  const e=fixture();let service,phase=0,seed=true;try{
    service=new ContactService(e.store,{async chat(messages){if(seed)return reply('SYNTHETIC_PRIVATE_CONTEXT');phase++;
      if(phase===1){assert.match(JSON.stringify(messages),/SYNTHETIC_PRIVATE_CONTEXT/);return call('observe_shared_browser');}
      if(phase===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'SYNTHETIC_PRIVATE_CONTEXT'});
      if(phase===3)return reply('입력할 내용을 준비했어요.');
      assert.match(JSON.stringify(messages),/CONFIRMED_APPLIED/);return reply('입력값을 확인한 기록이 있어요.');
    }},empty);service.attachBrowser(e.browser);service.submit(e.device,randomUUID(),'기억해줘.');await service.idle();seed=false;
    service.submit(e.device,randomUUID(),'기억한 내용을 옮겨줘.');await service.idle();const preview=service.browserStatus(e.device).transfer;assert.equal(preview.state,'ready');assert.equal(e.browser.writes,0);
    const before=e.store.usage().requests;await service.approveBrowserTransfer(e.device,approval(preview));assert.equal(e.store.usage().requests,before);assert.equal(e.browser.writes,1);
    assert.equal(e.store.continuingUseEnabled(),false);
    const next=service.submit(e.device,randomUUID(),'처리됐어?');await service.idle();assert.equal(phase,4);assert.equal(e.store.turn(next.seq).state,'answered');
  }finally{await service?.close();e.close();}
});

for(const mode of ['model_failure','new_request','stop'])test(`service ${mode} discards abandoned preparation and never applies it`,async()=>{
  const e=fixture();let service,calls=0,continueReply;try{
    let prepared;const staged=new Promise(resolve=>{prepared=resolve;});
    service=new ContactService(e.store,{async chat(messages){calls++;
      if(calls===1)return call('observe_shared_browser');
      if(calls===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'old prepared text'});
      if(calls===3){prepared();await new Promise(resolve=>{continueReply=resolve;});if(mode==='model_failure')throw Error('SYNTHETIC_FAILURE');}
      return reply('준비했어요.');
    }},empty);service.attachBrowser(e.browser);service.submit(e.device,randomUUID(),'옮겨줘.');await staged;
    if(mode==='new_request')service.submit(e.device,randomUUID(),'그만하고 새 이야기를 하자.');if(mode==='stop')service.beginStop();continueReply();await service.idle();
    assert.equal(service.browserStatus(e.device).transfer,null);assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
  }finally{continueReply?.();await service?.close();e.close();}
});
test('host close drains an already dispatched transfer and preserves uncertain receipt',async()=>{
  const e=fixture();let service,release,calls=0;try{
    service=new ContactService(e.store,{async chat(messages){calls++;if(calls===1)return call('observe_shared_browser');if(calls===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'exact'});return reply('준비했어요.');}},empty);service.attachBrowser(e.browser);
    service.submit(e.device,randomUUID(),'옮겨줘');await service.idle();let admitted;const dispatched=new Promise(r=>{admitted=r;});
    e.browser.fill=async(epoch,observation,ref,value,admit)=>{admit();e.browser.writes++;admitted();await new Promise(r=>{release=r;});return {applied:true};};
    const preview=service.browserStatus(e.device).transfer, applying=service.approveBrowserTransfer(e.device,approval(preview));await dispatched;
    let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release();await Promise.all([applying,closing]);
    assert.equal(e.store.browserActions()[0].action.state,'UNCERTAIN');assert.equal(e.browser.writes,1);
  }finally{release?.();await service?.close();e.close();}
});
test('prepared private bytes and provider continuation are not saved as reusable model context',async()=>{
  const e=fixture();let service,calls=0;const secret='SYNTHETIC_TRANSIENT_TRANSFER_'+randomUUID();try{
    service=new ContactService(e.store,{async chat(messages){calls++;if(calls===1)return call('observe_shared_browser');if(calls===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:secret});return reply('검토할 내용을 준비했어요.');}},empty);service.attachBrowser(e.browser);
    service.submit(e.device,randomUUID(),'옮길 내용을 준비해줘.');await service.idle();assert.equal(service.browserStatus(e.device).transfer.text,secret);assert.equal(JSON.stringify(e.store.checkpoint()).includes(secret),false);assert.equal(e.browser.writes,0);
  }finally{await service?.close();e.close();}
});
for(const file of [false,true])for(const restart of [false,true])test(`shared ${file?'file':'page'} continuation expires on unshare, restart=${restart}`,async()=>{
  const e=fixture();let service,step=0;
  const body=Buffer.from(e.original.data,'base64').toString(),page='SYNTHETIC_PRIVATE_PAGE_'+randomUUID(),opaque='SYNTHETIC_SHARED_REASONING_'+randomUUID(),finalStep=file?3:2;
  const observe=e.browser.observe;e.browser.observe=async(...args)=>({...await observe.apply(e.browser,args),text:page});
  const model={async chat(messages){step++;
    if(step===1)return call('observe_shared_browser');
    if(file&&step===2){assert.equal(JSON.parse(messages.at(-1).content).text,page);return call('read_shared_file',{observation:JSON.parse(messages.at(-1).content).observation,ref:'file-1',encoding:'auto'});}
    if(step===finalStep){assert.equal(JSON.parse(messages.at(-1).content)[file?'content':'text'],file?body:page);return {...reply('점검했어요.'),message:{role:'assistant',content:'점검했어요.',provider_state:{version:1,provider:'chatgpt-subscription',items:[{type:'reasoning',id:'rs_fixture',encrypted_content:opaque,summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'점검했어요.',annotations:[]}]}]}}};}
    const wire=JSON.stringify(responsesInput(messages));for(const transient of [opaque,page,'original,1'])assert.equal(wire.includes(transient),false);assert.match(wire,/점검했어요/u);return reply('계속 이야기해요.');
  }};
  try{
    service=new ContactService(e.store,model,empty);service.attachBrowser(e.browser);
    const first=service.submit(e.device,randomUUID(),file?'선택한 파일만 읽고 점검해줘.':'공유한 페이지를 읽고 점검해줘.');await service.idle();assert.equal(e.store.turn(first.seq).state,'answered',JSON.stringify(e.store.turn(first.seq)));
    const saved=JSON.stringify(e.store.checkpoint());for(const transient of [opaque,page,'original,1'])assert.equal(saved.includes(transient),false);assert.match(saved,/점검했어요/u);assert.equal(e.browser.writes,0);
    service.unshareBrowser(e.device);
    if(restart){await service.close();e.reopen();service=new ContactService(e.store,model,empty);service.attachBrowser(e.browser);}
    const next=service.submit(e.device,randomUUID(),'안녕');await service.idle();assert.equal(e.store.turn(next.seq).state,'answered',JSON.stringify(e.store.turn(next.seq)));assert.equal(step,finalStep+1);
  }finally{await service?.close();e.close();}
});
test('per-turn receipts outlive recent twenty UI records and refresh after new persisted actions',async()=>{
  const e=fixture();try{
    const {job,preview}=await prepare(e);await e.manager.approve(e.device,approval(preview));const receipt=e.store.browserReceipts(job.seq)[0];
    const next=e.job(),observation=await e.browser.observe(e.browser.grant.epoch,()=>{});
    for(let i=0;i<25;i++){const id=e.store.admitBrowserAction(next.seq,e.browser.grant,observation,'1','value'+i);e.store.finishBrowserAction(id,'value'+i,{url:e.browser.grant.url,value:'value'+i},true);}
    assert.equal(e.store.browserActions().some(r=>r.action.action_id===receipt.id),false);
    assert.deepEqual(e.store.browserReceipts(job.seq),[receipt]);assert.equal(e.store.browserReceipts(next.seq).length,25);
    e.reopen();assert.deepEqual(e.store.page().turns.find(t=>t.seq===job.seq).browser_receipts,[receipt]);
  }finally{e.close();}
});

test('warm receipt history updates changed actions without decrypting old file payloads',async()=>{
  const e=fixture(),decipher=crypto.createDecipheriv;let decryptions=0;try{
    const job=e.job(),view=await e.browser.observe(e.browser.grant.epoch,()=>{});
    const original=fileCopy('old.csv','text/csv',Buffer.alloc(32768,97)),replacement=fileCopy('new.csv','text/csv',Buffer.alloc(32768,98));
    for(let i=0;i<30;i++){const id=e.store.admitBrowserFileAction(job.seq,e.browser.grant,view,'file-1',original,replacement,null);e.store.finishBrowserFileAction(id,false);}
    assert.equal(e.store.browserReceipts(job.seq).length,30);
    crypto.createDecipheriv=(...args)=>{decryptions++;return decipher(...args);};syncBuiltinESMExports();
    const id=e.store.admitBrowserFileAction(job.seq,e.browser.grant,view,'file-1',original,replacement,null);
    decryptions=0;let receipts=e.store.browserReceipts(job.seq);assert.equal(receipts.length,31);assert.equal(receipts.find(r=>r.id===id).state,'DISPATCHING');assert.equal(decryptions,0);
    e.store.finishBrowserFileAction(id,false);
    decryptions=0;receipts=e.store.browserReceipts(job.seq);assert.equal(receipts.find(r=>r.id===id).state,'FAILED');assert.equal(decryptions,0);
    assert.match(e.store.browserReceiptContext(job.seq+1),/CONFIRMED_NOT_APPLIED/);assert.equal(decryptions,0);
    e.reopen();decryptions=0;assert.deepEqual(e.store.browserReceipts(job.seq),receipts);assert.equal(decryptions,31);
  }finally{crypto.createDecipheriv=decipher;syncBuiltinESMExports();e.close();}
});
test('rolled-back action admission invalidates its in-memory receipt',async()=>{
  const e=fixture(),exec=DatabaseSync.prototype.exec;try{
    const job=e.job(),view=await e.browser.observe(e.browser.grant.epoch,()=>{});assert.deepEqual(e.store.browserReceipts(job.seq),[]);
    let fail=true;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&fail){fail=false;throw Error('CONTACT_TEST_ROLLBACK');}return exec.call(this,sql);};
    assert.throws(()=>e.store.admitBrowserAction(job.seq,e.browser.grant,view,'1','not committed'),/CONTACT_TEST_ROLLBACK/);
    assert.deepEqual(e.store.browserReceipts(job.seq),[]);assert.deepEqual(e.store.browserActions(),[]);
    const id=e.store.admitBrowserAction(job.seq,e.browser.grant,view,'1','committed');assert.equal(e.store.browserReceipts(job.seq)[0].id,id);
    e.store.finishBrowserAction(id,'committed',{url:e.browser.grant.url,value:'committed'},true);
    const receipts=e.store.browserReceipts(job.seq);e.reopen();assert.deepEqual(e.store.browserReceipts(job.seq),receipts);
  }finally{DatabaseSync.prototype.exec=exec;e.close();}
});

test('many persisted effects retain bounded newest receipt context and allow continuing conversation',async()=>{
  const e=fixture();let service,calls=0,seen;try{
    e.store.configureContinuingUse(e.device,true,CONTINUING_CONSENT);
    const checkpoint=new ConversationAssistant({chat:async()=>reply('fixture')},empty).checkpoint();
    for(let turn=0;turn<3;turn++){
      const job=e.job(),observation=await e.browser.observe(e.browser.grant.epoch,()=>{});
      for(let i=0;i<5;i++){const id=e.store.admitBrowserAction(job.seq,e.browser.grant,observation,'1','value');e.store.finishBrowserAction(id,'value',{url:e.browser.grant.url,value:'value'},true);}
      e.store.finish(job.seq,{text:'입력 완료',sources:[],verification:'not_applicable'},checkpoint);
    }
    const context=e.store.browserReceiptContext(4);assert.ok(Buffer.byteLength(JSON.stringify(context))<=512);assert.match(context,/"omitted":true/);
    assert.ok(context.includes(e.store.browserReceipts(3).at(-1).id));assert.equal(e.store.page().turns.flatMap(t=>t.browser_receipts).length,15);
    service=new ContactService(e.store,{contextLimitBytes:65536,async chat(messages){calls++;seen=JSON.stringify(messages);return reply('대화를 이어가요.');}},empty);
    const next=service.submit(e.device,randomUUID(),'다음 이야기를 하자.');await service.idle();assert.equal(e.store.turn(next.seq).state,'answered',JSON.stringify(e.store.turn(next.seq)));assert.equal(calls,1);assert.match(seen,/CONFIRMED_APPLIED/);
  }finally{await service?.close();e.close();}
});

test('claiming the next queued request clears an intervening obsolete preview',async()=>{
  const e=fixture();let service,release,step=0;try{
    let started;const running=new Promise(r=>{started=r;});
    service=new ContactService(e.store,{async chat(messages){const request=messages.findLast(m=>m.role==='user').content;
      if(request==='first'){started();await new Promise(r=>{release=r;});return reply('First done');}
      if(request==='second'){step++;if(step===1)return call('observe_shared_browser');if(step===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'obsolete'});return reply('Prepared');}
      return reply('Newer owner request done');
    }},empty);service.attachBrowser(e.browser);
    service.submit(e.device,randomUUID(),'first');await running;
    service.submit(e.device,randomUUID(),'second');const third=service.submit(e.device,randomUUID(),'third');release();await service.idle();
    assert.equal(e.store.turn(third.seq).state,'answered');assert.equal(service.browserStatus(e.device).transfer,null);assert.equal(e.browser.writes,0);
  }finally{release?.();await service?.close();e.close();}
});

test('new request during applying can prepare again after the old effect reconciles',async()=>{
  const e=fixture();let service,release,step=0;try{
    service=new ContactService(e.store,{async chat(messages){step++;if(step%3===1)return call('observe_shared_browser');if(step%3===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'exact'});return reply('Prepared');}},empty);service.attachBrowser(e.browser);
    const first=service.submit(e.device,randomUUID(),'처음 준비');await service.idle();let admitted;const dispatched=new Promise(r=>{admitted=r;});
    e.browser.fill=async(epoch,observation,ref,value,admit)=>{admit();admitted();await new Promise(r=>{release=r;});return {applied:false,reason:'target_changed'};};
    const preview=service.browserStatus(e.device).transfer, applying=service.approveBrowserTransfer(e.device,approval(preview));await dispatched;
    const next=service.submit(e.device,randomUUID(),'새로 준비');release();assert.equal(await applying,null);await service.idle();
    assert.equal(e.store.browserReceipts(first.seq)[0].state,'FAILED');assert.equal(service.browserStatus(e.device).transfer.turn,next.seq);assert.equal(service.browserStatus(e.device).transfer.state,'ready');assert.equal(e.browser.writes,0);
  }finally{release?.();await service?.close();e.close();}
});

test('history receipt pages fit a small result budget without losing long labels or effects',async()=>{
  const e=fixture();try{
    const job=e.job(),view=await e.browser.observe(e.browser.grant.epoch,()=>{});view.fields[0].label='긴 이름'.repeat(60);
    for(let i=0;i<17;i++){const id=e.store.admitBrowserAction(job.seq,e.browser.grant,view,'1','value');e.store.finishBrowserAction(id,'value',{url:e.browser.grant.url,value:'value'},true);}
    e.store.finish(job.seq,{text:'처리한 결과',sources:[],verification:'not_applicable'},new ConversationAssistant({},empty).checkpoint());
    const next=e.job(),all=e.store.browserReceipts(job.seq),seen=[],budget={fits:value=>Buffer.byteLength(JSON.stringify(value))<=2600};let offset=0;
    do {const page=readConversationHistory(e.store,next.seq,'read_history',{id:job.seq,receipt_offset:offset},budget);assert.ok(budget.fits(page));assert.equal(page.browser_receipts_total,17);assert.ok(page.browser_receipts.length);seen.push(...page.browser_receipts);offset=page.browser_receipts_next_offset;} while(offset!==null);
    assert.deepEqual(seen,all);assert.equal(new Set(seen.map(r=>r.id)).size,17);assert.ok(seen.every(r=>r.field===view.fields[0].label));
    assert.equal(e.store.readHistory(job.seq,next.seq).browser_receipts.length,8);
    assert.throws(()=>e.store.readHistory(job.seq,next.seq,-1),/HISTORY_INVALID/);
  }finally{e.close();}
});

test('composed history pages retain public sources and every browser effect within the final budget',async()=>{
  const e=fixture();try{
    const job=e.job(),view=await e.browser.observe(e.browser.grant.epoch,()=>{});
    for(let i=0;i<17;i++){const id=e.store.admitBrowserAction(job.seq,e.browser.grant,view,'1','value');e.store.finishBrowserAction(id,'value',{url:e.browser.grant.url,value:'value'},true);}
    const evidence={id:'S1',source:'ChatGPT public web research',path:`report-${job.seq}`,sha256:'a'.repeat(64),observed_at:new Date().toISOString(),citations:[{url:'https://example.org/source',title:'Public source '.repeat(25)}]};
    e.store.finish(job.seq,{text:'Saved fact [S1]',sources:[evidence]},new ConversationAssistant({},empty).checkpoint());
    const next=e.job(),all=e.store.browserReceipts(job.seq),seen=[],budget={fits:value=>Buffer.byteLength(JSON.stringify(value))<=2600},reads=[];
    const sources=new DocumentSources(empty,e.store,next,{history:true,ownerContext:{assertCurrent(){},read(id){reads.push(id);}}});
    await assert.rejects(sources.execute('read_history',{id:job.seq},signal(),{fits:value=>Buffer.byteLength(JSON.stringify(value))<=100}),/ASSISTANT_SOURCE_LIMIT/);
    assert.equal(sources.recallEvidence(evidence,signal()),false);assert.deepEqual(reads,[]);
    let offset=0;
    do {
      const page=await sources.execute('read_history',{id:job.seq,receipt_offset:offset},signal(),budget);
      assert.ok(budget.fits(page));assert.deepEqual(page.sources,[evidence]);assert.equal(page.browser_receipts_total,17);assert.ok(page.browser_receipts.length);
      assert.match(page.note,/saved public research receipts/);seen.push(...page.browser_receipts);offset=page.browser_receipts_next_offset;
    }while(offset!==null);
    assert.deepEqual(seen,all);assert.equal(new Set(seen.map(r=>r.id)).size,17);assert.ok(reads.length>1);assert.ok(reads.every(id=>id===job.seq));
    assert.equal(sources.recallEvidence(evidence,signal()),true);assert.deepEqual(e.store.turn(job.seq).answer.sources,[evidence]);
  }finally{e.close();}
});

test('history optional receipt cursor agrees between advertised schema and runtime validation',()=>{
  const validate=new Ajv().compile(HISTORY_TOOLS.find(t=>t.function.name==='read_history').function.parameters);
  for(const args of [{id:1},{id:1,receipt_offset:0},{receipt_offset:8,id:1}]){assert.equal(validate(args),true);assert.equal(validHistoryCall('read_history',args),true);}
  for(const args of [{id:1,receipt_offset:-1},{id:1,receipt_offset:0.5},{id:1,receipt_offset:'0'},{id:1,receipt_offset:null},{id:1,extra:0},{receipt_offset:0},{id:1,receipt_offset:Number.MAX_SAFE_INTEGER+1}]){assert.equal(validate(args),false);assert.equal(validHistoryCall('read_history',args),false);}
  assert.equal(validHistoryCall('read_history',{id:1,receipt_offset:Number.MAX_SAFE_INTEGER+1}),false);
});

test('default local context can retrieve multiple long-label browser effects through the service',async()=>{
  const e=fixture();let service,step=0,seen;try{
    e.store.configureContinuingUse(e.device,true,CONTINUING_CONSENT);
    const job=e.job(),view=await e.browser.observe(e.browser.grant.epoch,()=>{});view.fields[0].label='설'.repeat(300);
    for(let i=0;i<8;i++){const id=e.store.admitBrowserAction(job.seq,e.browser.grant,view,'1','value');e.store.finishBrowserAction(id,'value',{url:e.browser.grant.url,value:'value'},true);}
    e.store.finish(job.seq,{text:'완료',sources:[],verification:'not_applicable'},new ConversationAssistant({},empty).checkpoint());
    service=new ContactService(e.store,{async chat(messages){if(++step===1)return call('read_history',{id:job.seq});seen=JSON.parse(messages.at(-1).content);return reply('기록을 확인했어요.');}},empty);
    const next=service.submit(e.device,randomUUID(),'아까 결과를 확인해줘');await service.idle();assert.equal(e.store.turn(next.seq).state,'answered');assert.equal(seen.error,undefined);assert.equal(seen.browser_receipts_total,8);assert.ok(seen.browser_receipts.length>0);assert.ok(seen.browser_receipts_next_offset>0);
  }finally{await service?.close();e.close();}
});

for(const mail of [false,true])for(const related of [false,true])test(`applied receipt is mandatory in default local context with Google mail=${mail} related=${related}`,async()=>{
  const e=fixture({mail});let service,phase=0,follow=false,seen;try{
    service=new ContactService(e.store,{async chat(messages,tools){if(follow){seen=JSON.stringify(messages);return reply('처리 기록');}phase++;const ready=(name,args={})=>{if(tools.some(t=>t.function.name===name))return call(name,args);phase--;return call('select_tools',{names:[name]});};
      if(phase===1)return ready('observe_shared_browser');
      if(phase===2)return ready('prepare_browser_text_transfer',{observation:JSON.parse(messages.findLast(m=>m.tool_name==='observe_shared_browser').content).observation,ref:'1',value:'exact'});
      return reply('준비했어요.');
    }},empty);service.attachBrowser(e.browser);
    const grant={connected:true,email:'owner@example.invalid',...(related?{related_mail_epoch:randomUUID()}: {})};
    service.attachGoogle(Object.assign(new EventEmitter(),{connect(){},close(){},status:()=>({configured:true,connected:true}),captureGrant:()=>grant,assertSnapshot(){}}));
    service.submit(e.device,randomUUID(),'옮겨줘');await service.idle();const preview=service.browserStatus(e.device).transfer;assert.equal(preview?.state,'ready');
    await service.approveBrowserTransfer(e.device,approval(preview));follow=true;
    const next=service.submit(e.device,randomUUID(),'처리됐어?');await service.idle();assert.equal(e.store.turn(next.seq).state,'answered',JSON.stringify(e.store.turn(next.seq)));assert.match(seen,/CONFIRMED_APPLIED/);
  }finally{await service?.close();e.close();}
});
for(const failed of [false,true])test(`transfer checkpoint preserves actual preparation status and stays redacted with a followup (failed=${failed})`,async()=>{
  const e=fixture();let service,calls=0;const secret='SYNTHETIC_TRANSIENT_'+randomUUID();try{
    service=new ContactService(e.store,{contextLimitBytes:65536,async chat(messages){calls++;
      if(calls===1)return call('observe_shared_browser');
      if(calls===2)return call('prepare_browser_text_transfer',{observation:failed?'stale':JSON.parse(messages.at(-1).content).observation,ref:'1',value:secret});
      if(calls===3)return call('propose_followup',{operation_id:'test',target:null,expected_version:0,title:'Check later',details:'Owner asked for a check',state:'open',waiting_for:null,notify_at:null,user_quote:'챙길 일도 저장해줘'});
      return reply(`입력 내용: ${secret}. 챙길 일도 준비했어요.`);
    }},empty);service.attachBrowser(e.browser);
    const turn=service.submit(e.device,randomUUID(),'이 내용을 옮기고 챙길 일도 저장해줘');await service.idle();assert.equal(e.store.turn(turn.seq).state,'answered');
    const history=JSON.stringify(e.store.checkpoint().value.history);assert.equal(history.includes(secret),false);
    assert.match(history,failed?/did not leave a valid preview/:/prepared for owner review/);assert.equal(!!service.browserStatus(e.device).transfer,!failed);
    assert.match(e.store.turn(turn.seq).answer.notice,/아직 저장 확정/);
  }finally{await service?.close();e.close();}
});
for(const file of [false,true])for(const mode of ['changed','malformed','revoked','cancelled','expired'])test(`preparation preflight ${mode} file=${file} cannot stage or write`,async()=>{
  const e=fixture(),now=Date.now;try{
    const job=e.job(),scope=e.manager.capture(job,null),sources=new BrowserSources(empty,e.store,e.browser,job,{prepare:scope.stage});
    const observed=await sources.execute('observe_shared_browser',{},signal());
    let args={observation:observed.observation,ref:'1',value:'private 👋'};
    if(file){const read=await sources.execute('read_shared_file',{observation:observed.observation,ref:'file-1',encoding:'auto'},signal());args={file:read.file,name:'new.csv',content:'private 👋',edits:[],submit:null};}
    e.browser[file?'checkFile':'checkText']=async(...args)=>{args.at(-1)();if(mode==='revoked')e.store.revoke(e.device);if(mode==='cancelled')e.store.cancel(job.seq);if(mode==='expired')Date.now=()=>now()+60001;return mode==='changed'?{applied:false,reason:'target_changed'}:mode==='malformed'?{}:{ready:true};};
    const operation=sources.execute(file?'prepare_browser_file_transfer':'prepare_browser_text_transfer',args,signal());
    if(mode==='changed'){assert.deepEqual(await operation,{state:'not_prepared',reason:'target_changed',recovery:'observe_current_page'});await assert.rejects(sources.execute(file?'prepare_browser_file_transfer':'prepare_browser_text_transfer',args,signal()),/OBSERVATION_REQUIRED/);}
    else await assert.rejects(operation);
    assert.equal(scope.prepared(),false);assert.equal(e.store.browserActions().length,0);assert.equal(e.browser.writes,0);
  }finally{Date.now=now;e.close();}
});

for(const change of ['file','submit'])test(`file preflight rechecks ${change} after asynchronous file read`,async()=>{
  let current=true,signature='original',release;
  const form={},button={form,ref:'submit-1',e:{value:'',hasAttribute:()=>false},signature:'original',value:'',text:'Import',action:undefined,method:undefined,target:undefined};
  const item={ref:'file-1',form,file:{name:'original.csv',type:'text/csv',arrayBuffer:()=>new Promise(r=>{release=r;})}};
  const snapshot={fileEntries:[item],submitters:[button],fileForm:()=>true,current:()=>current,submitAllowed:()=>true,signature:()=>signature,renderedText:()=> 'Import'};
  const context={snapshot,btoa:v=>Buffer.from(v,'binary').toString('base64'),Uint8Array};
  const check=runInNewContext(`(${checkSelectedFile})`,context);
  const result=check('snapshot','file-1',{name:'original.csv',type:'text/csv',data:'YQ=='},'submit-1');
  if(change==='file')current=false;else signature='changed';release(Uint8Array.of(97).buffer);
  assert.deepEqual(JSON.parse(JSON.stringify(await result)),{applied:false,reason:'target_changed'});
});

test('a refused final answer discards the preview and records no valid preparation',async()=>{
  const e=fixture();let service,step=0;try{
    service=new ContactService(e.store,{async chat(messages){step++;if(step===1)return call('observe_shared_browser');if(step===2)return call('prepare_browser_text_transfer',{observation:JSON.parse(messages.at(-1).content).observation,ref:'1',value:'private'});return {...reply('진행하지 않았어요.'),refused:true};}},empty);service.attachBrowser(e.browser);
    const next=service.submit(e.device,randomUUID(),'준비해줘');await service.idle();assert.equal(e.store.turn(next.seq).state,'answered');assert.equal(e.store.turn(next.seq).answer.refused,true);
    assert.equal(service.browserStatus(e.device).transfer,null);assert.match(JSON.stringify(e.store.checkpoint().value.history),/did not leave a valid preview/);assert.equal(e.browser.writes,0);
  }finally{await service?.close();e.close();}
});
