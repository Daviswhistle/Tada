import test from 'node:test';
import { EventEmitter } from 'node:events';
import { CONTINUING_CONSENT } from '../src/continuing-use.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { BrowserSources } from '../src/browser-sources.mjs';
import { fileCopy, fileHash, validBrowserFileActions, finishBrowserFileAction } from '../src/browser-file-actions.mjs';
import { validBrowserActions } from '../src/browser-actions.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { serveContact } from '../src/contact-http.mjs';
import { request } from 'node:http';
const base={definitions:[],validate:()=>false,execute:async()=>{throw Error('NO_SOURCE');},verify:async()=>false};
const signal=()=>new AbortController().signal;
function fixture({mail=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'tada-file-actions-')),options={directory:join(root,'journal'),passphrase:'synthetic file fixture key',route:contactRoute({fixture:'files'})};
  let store=new ContactStore({...options,initialize:true,assistance:true,mail});const device=store.addDevice('Owner');
  store.submit(device.id,randomUUID(),'이거 안 돼.');const job=store.claim();
  const original=fileCopy('original.csv','text/csv',Buffer.from('\ufeffname,amount\r\n한솔,1200\r\n','utf16le'));
  const browser={grant:{epoch:randomUUID(),device:device.id,target:'tab',url:'https://fixture.invalid/import',origin:'https://fixture.invalid',files:true},writes:0,
    assert(epoch){if(this.grant?.epoch!==epoch)throw Error('CONTACT_BROWSER_TARGET_CHANGED');},
    async observe(epoch,admit){admit();return {key:'private-key',url:this.grant.url,title:'Import',text:'File encoding error',fields:[],files:[{ref:'file-1',label:'CSV',name:original.name,replaceable:true,submitters:[{ref:'submit-1',label:'Import'}]}],downloads:[{ref:'download-1',label:'Imported copy',name:'fixed.csv'}]};},
    async readFile(epoch,observation,ref,admit){admit();return original;},
    async replaceFile(epoch,observation,ref,source,replacement,submit,admit){admit();this.writes++;this.copy=replacement;return {applied:true,submitted:true,result_key:"fixture-result"};},
    async download(epoch,observation,ref,admit){admit();return {data:this.copy.data};},async release(){},unshare(){this.grant=null;},async close(){this.unshare();}};
  return {root,options,device,job,original,browser,get store(){return store;},sources(){return new BrowserSources(base,store,browser,job);},reopen(){store.close();store=new ContactStore(options);},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
async function read(e,sources=e.sources()) {
  const observation=await sources.execute('observe_shared_browser',{},signal());
  const file=await sources.execute('read_shared_file',{observation:observation.observation,ref:'file-1',encoding:'auto'},signal());
  return {sources,file,args:{file:file.file,name:'fixed.csv',content:file.content,edits:[],submit:'submit-1'}};
}
test('selected file preserves encrypted original/copy, verifies real bytes and survives restart',async()=>{
  const e=fixture();try {
    const {sources,file,args}=await read(e);assert.equal(file.encoding,'utf-16le');assert.match(file.content,/한솔/);
    const applied=await sources.execute('replace_shared_file',args,signal());assert.equal(applied.state,'UNCERTAIN');assert.equal(e.store.browserBlocked(e.browser.grant.origin),true);
    const observation=await sources.execute('observe_shared_browser',{},signal());
    const verified=await sources.execute('verify_shared_file',{action_id:applied.action_id,observation:observation.observation,ref:'download-1'},signal());
    assert.equal(verified.state,'UNCERTAIN');assert.equal(verified.download_matches,true);assert.equal(verified.server_persistence,'not_checked');assert.equal(verified.sha256,fileHash(Buffer.from(file.content)));assert.equal(e.browser.writes,1);
    assert.deepEqual(e.store.browserFile(e.device.id,applied.action_id,'original'),e.original);
    assert.ok(validBrowserActions({version:2,records:e.store.browserActions()}));assert.equal(validBrowserActions({version:1,records:e.store.browserActions()}),false);
    for(const suffix of ['','-wal']) {try{assert.equal(readFileSync(join(e.root,'journal','contact.sqlite'+suffix)).includes(Buffer.from(file.content)),false);}catch(error){if(error.code!=='ENOENT')throw error;}}
    e.reopen();assert.equal(e.store.browserActions()[0].action.state,'UNCERTAIN');assert.equal(e.store.browserBlocked(e.browser.grant.origin),true);
  } finally {e.close();}
});
for(const mode of ['cancel','revoke','unshare','old_grant','wrong_ref','stale','budget'])test(`file ${mode} before dispatch leaves original and sends no write`,async()=>{
  const e=fixture();try {
    const {sources,args}=await read(e);
    if(mode==='cancel')e.store.cancel(e.job.seq);if(mode==='revoke')e.store.revoke(e.device.id);if(mode==='unshare')e.browser.grant=null;
    if(mode==='old_grant'){e.browser.grant={...e.browser.grant,files:false,epoch:randomUUID()};}
    if(mode==='wrong_ref')args.submit='submit-99';if(mode==='stale')await sources.execute('observe_shared_browser',{},signal());
    await assert.rejects(sources.execute('replace_shared_file',args,signal(),mode==='budget'?{fits:()=>false}:undefined));
    assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
  } finally {e.close();}
});
test('old text-only sharing does not expose or allow file tools',async()=>{
  const e=fixture();try{e.browser.grant.files=false;const s=e.sources();assert.deepEqual(s.definitions.map(t=>t.function.name),['observe_shared_browser']);assert.equal(s.validate('read_shared_file',{observation:'x',ref:'file-1',encoding:'auto'}),false);await assert.rejects(s.execute('read_shared_file',{observation:'x',ref:'file-1',encoding:'auto'},signal()));}finally{e.close();}
});
for(const mode of ['lost_response','lost_download','cancel_after_send','mismatch'])test(`file ${mode} preserves uncertain effects and prevents repeats`,async()=>{
  const e=fixture();try {
    const {sources,args}=await read(e),replace=e.browser.replaceFile;
    e.browser.replaceFile=async(...params)=>{const result=await replace.apply(e.browser,params);if(mode==='lost_response')throw Error('UNKNOWN');if(mode==='cancel_after_send')e.store.cancel(e.job.seq);return result;};
    let applied;
    if(mode==='cancel_after_send')await assert.rejects(sources.execute('replace_shared_file',args,signal()));
    else {
      applied=await sources.execute('replace_shared_file',args,signal());
      if(mode==='lost_download')e.browser.download=async()=>{throw Error('UNKNOWN');};
      if(mode==='mismatch')e.browser.download=async()=>({data:Buffer.from('wrong document').toString('base64')});
      const view=await sources.execute('observe_shared_browser',{},signal());
      if(mode==='lost_download'||mode==='lost_response')await assert.rejects(sources.execute('verify_shared_file',{action_id:applied.action_id,observation:view.observation,ref:'download-1'},signal()));
      if(mode==='mismatch')assert.equal((await sources.execute('verify_shared_file',{action_id:applied.action_id,observation:view.observation,ref:'download-1'},signal())).download_matches,false);
    }
    e.reopen();assert.equal(e.store.browserBlocked(e.browser.grant.origin),true);assert.equal(e.browser.writes,1);
    assert.equal(e.store.browserActions()[0].action.state,'UNCERTAIN');
  }finally{e.close();}
});
test('file record bytes, version, intent and verified readback cannot be forged',async()=>{
  const e=fixture();try {
    const {sources,args}=await read(e);await sources.execute('replace_shared_file',args,signal());const record=e.store.browserActions()[0];
    for(const edit of [r=>r.payload.original.data='invalid',r=>r.payload.replacement.sha256='0'.repeat(64),r=>r.action.intent_hash='0'.repeat(64),r=>r.action.method='browser.fill_textbox',r=>r.action.state='VERIFIED',r=>r.receipt.version=2,r=>r.receipt.server_persistence='download_readback',r=>r.action.verifier_version='selected_file_download_v1',r=>r.receipt.applied=false]){
      const next=structuredClone(record);edit(next);assert.equal(validBrowserFileActions({version:2,records:[next]}),false);
    }
    assert.equal(validBrowserActions({version:3,records:[record]}),false);
  }finally{e.close();}
});
test('file dispatch crash recovers uncertain; backup restoration retains bytes without replay authority',async()=>{
  const e=fixture();let restored;try {
    const observation=await e.browser.observe(e.browser.grant.epoch,()=>{}),copy=fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n'));
    const id=e.store.admitBrowserFileAction(e.job.seq,e.browser.grant,observation,'file-1',e.original,copy,'submit-1');
    e.reopen();assert.equal(e.store.browserActions()[0].action.state,'UNCERTAIN');assert.equal(e.browser.writes,0);
    const recovery=e.store.exportRecords(e.device.id);
    restored=new ContactStore({...e.options,directory:join(e.root,'restored'),initialize:true,recovery});const owner=restored.addDevice('New owner');
    assert.deepEqual(restored.browserFile(owner.id,id,'original'),e.original);assert.deepEqual(restored.browserFile(owner.id,id,'replacement'),copy);
    assert.equal(restored.readBrowserActions()[0].recovery.quarantined,true);assert.equal(restored.browserBlocked(e.browser.grant.origin),true);
    assert.equal(restored.claim(),null);assert.equal(e.browser.writes,0);
  }finally{restored?.close();e.close();}
});
test('file downloads require current device authority and return exact immutable bytes',async()=>{
  const e=fixture();let host,service;try {
    const {sources,args}=await read(e),action=await sources.execute('replace_shared_file',args,signal());
    service=new ContactService(e.store,{},base);host=await serveContact({store:e.store,service,origin:'http://127.0.0.1:9177',port:0});
    const get=(kind,cookie='')=>new Promise((yes,no)=>{
      const req=request(`http://127.0.0.1:${host.address.port}/api/browser/files/${action.action_id}/${kind}`,{headers:{Host:'127.0.0.1:9177',Origin:'http://127.0.0.1:9177',Cookie:cookie}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>yes({status:res.statusCode,bytes:Buffer.concat(chunks),headers:res.headers}));});req.on('error',no);req.end();
    });
    assert.equal((await get('original')).status,401);
    const original=await get('original',`tada_local=${e.device.token}`);assert.equal(original.status,200);assert.deepEqual(original.bytes,Buffer.from(e.original.data,'base64'));assert.match(original.headers['content-disposition'],/attachment/);
    const replacement=await get('replacement',`tada_local=${e.device.token}`);assert.deepEqual(replacement.bytes,Buffer.from(args.content));
    e.store.revoke(e.device.id);assert.equal((await get('replacement',`tada_local=${e.device.token}`)).status,401);
  }finally{await host?.close();await service?.close();e.close();}
});
test('file tool schemas follow observed prerequisites without losing text-field support',async()=>{
  const e=fixture();try {
    const s=e.sources(),names=()=>s.definitions.map(t=>t.function.name);
    assert.deepEqual(names(),['observe_shared_browser']);
    const observe=e.browser.observe;e.browser.observe=async(...args)=>({...await observe.apply(e.browser,args),fields:[{ref:'text-1',label:'Title',value:'Original'}]});
    const observation=await s.execute('observe_shared_browser',{},signal());
    assert.deepEqual(names(),['observe_shared_browser','fill_shared_textbox','read_shared_file']);
    const file=await s.execute('read_shared_file',{observation:observation.observation,ref:'file-1',encoding:'auto'},signal());
    assert.deepEqual(names(),['observe_shared_browser','fill_shared_textbox','replace_shared_file']);
    const action=await s.execute('replace_shared_file',{file:file.file,name:'fixed.csv',content:null,edits:[],submit:'submit-1'},signal());
    assert.deepEqual(names(),['observe_shared_browser']);
    const after=await s.execute('observe_shared_browser',{},signal());
    assert.deepEqual(names(),['observe_shared_browser','fill_shared_textbox','verify_shared_file']);
    await s.execute('verify_shared_file',{action_id:action.action_id,observation:after.observation,ref:'download-1'},signal());
    assert.deepEqual(names(),['observe_shared_browser']);
    await s.execute('observe_shared_browser',{},signal());
    assert.ok(names().includes('read_shared_file'));
  }finally{e.close();}
});
for(const files of [false,true])test(`Google and continuing use retain ordinary local conversation with files ${files}`,async()=>{
  const e=fixture({mail:true});let service;try {
    e.store.cancel(e.job.seq);e.store.configureContinuingUse(e.device.id,true,CONTINUING_CONSENT);e.browser.grant.files=files;
    let calls=0;
    service=new ContactService(e.store,{identity:{provider:'ollama-local'},async chat(){calls++;return {message:{role:'assistant',content:'안녕하세요.'},input_tokens:1,output_tokens:1};}},base);
    service.attachBrowser(e.browser);service.attachGoogle(Object.assign(new EventEmitter(),{connect(){},close(){},status:()=>({configured:true,connected:true}),captureGrant:()=>({connected:true,email:'owner@example.invalid'}),assertSnapshot(){}}));
    const receipt=service.submit(e.device.id,randomUUID(),'안녕');await service.idle();
    assert.equal(e.store.turn(receipt.seq).state,'answered');assert.equal(calls,1);assert.equal(e.browser.writes,0);
  }finally{await service?.close();e.close();}
});
for(const connected of [false,true])for(const historical of [false,true])test(`default local context supports file workflow with Google/continuing use ${connected}, saved history ${historical}`,async()=>{
  const e=fixture({mail:connected});let service;try {
    if(historical) {
      const observation=await e.browser.observe(e.browser.grant.epoch,()=>{});
      const old=e.store.admitBrowserFileAction(e.job.seq,e.browser.grant,observation,'file-1',e.original,fileCopy('past.csv','text/csv',Buffer.from('past')),null);
      e.store.finishBrowserFileAction(old,false);
    }
    e.store.cancel(e.job.seq);let step=0,view,file,action;const sizes=[];
    const call=(name,args)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]},input_tokens:1,output_tokens:1});
    if(connected)e.store.configureContinuingUse(e.device.id,true,CONTINUING_CONSENT);
    service=new ContactService(e.store,{identity:{provider:'ollama-local'},contextBytes(messages,tools){const size=Buffer.byteLength(JSON.stringify({messages,tools}));sizes.push(size);return size;},async chat(messages,tools){
      if(tools.some(t=>t.function.name==='select_tools')&&!tools.some(t=>t.function.name==='work_on_shared_browser'))return call('select_tools',{names:['work_on_shared_browser']});
      if(tools.some(t=>t.function.name==='work_on_shared_browser'))return messages.some(m=>m.tool_name==='work_on_shared_browser') ? {message:{role:'assistant',content:'브라우저 작업 결과를 확인했어요.'},input_tokens:1,output_tokens:1} : call('work_on_shared_browser',{});
      step++;if(step===1)return call('observe_shared_browser',{});
      const last=step<=6?JSON.parse(messages.at(-1).content):null;assert.equal(last?.error,undefined,JSON.stringify({step,last,sizes}));
      if(step===2){view=last;return call('read_shared_file',{observation:view.observation,ref:'file-1',encoding:'auto'});}
      if(step===3){file=last;return call('replace_shared_file',{file:file.file,name:'fixed.csv',content:file.content,edits:[],submit:'submit-1'});}
      if(step===4){action=last;return call('observe_shared_browser',{});}
      if(step===5)return call('verify_shared_file',{action_id:action.action_id,observation:last.observation,ref:'download-1'});
      return {message:{role:'assistant',content:'수정본을 내려받아 내용이 일치하는지 확인했어요.'},input_tokens:1,output_tokens:1};
    }},base);service.attachBrowser(e.browser);
    if(connected)service.attachGoogle(Object.assign(new EventEmitter(),{connect(){},close(){},status:()=>({configured:true,connected:true}),captureGrant:()=>({connected:true,email:'owner@example.invalid'}),assertSnapshot(){}}));
    const accepted=service.submit(e.device.id,randomUUID(),'이거 안 돼.');await service.idle();
    const turn=e.store.turn(accepted.seq);assert.equal(turn.state,'answered',JSON.stringify({error:turn.error,step,sizes}));
    assert.equal(e.store.browserActions()[0].action.state,'UNCERTAIN');assert.equal(e.browser.writes,1);assert.match(turn.answer.notice,/1건은 다운로드한 파일이 수정본과 일치/);
    assert.doesNotMatch(turn.answer.notice,/입력은 적용되지 않았/);
    assert.ok(turn.answer.notice.includes(`/api/browser/files/${action.action_id}/original`));
    assert.ok(turn.answer.notice.includes(`/api/browser/files/${action.action_id}/replacement`));
    if(!connected) {
      const grant=structuredClone(e.browser.grant);await service.close();service=null;
      e.store.resolveBrowserAction(e.device.id,action.action_id,'checked_browser_effect_allow_new_work_v1');
      for(let i=0;i<22;i++) {
        e.store.submit(e.device.id,randomUUID(),'Later unrelated input');const job=e.store.claim();
        const id=e.store.admitBrowserAction(job.seq,grant,{key:'later',fields:[{ref:'1',label:'Other'}]},'1',String(i));
        e.store.finishBrowserAction(id,String(i),{url:grant.url,value:String(i)},true);e.store.cancel(job.seq);
      }
      assert.equal(e.store.browserActions().some(r=>r.action.action_id===action.action_id),false);
      e.reopen();assert.equal(e.store.readTurn(accepted.seq).answer.notice,turn.answer.notice);
      assert.deepEqual(e.store.browserFile(e.device.id,action.action_id,'original'),e.original);
      const restored=new ContactStore({...e.options,directory:join(e.root,'restored-links'),initialize:true,recovery:e.store.exportRecords(e.device.id)});
      try{const owner=restored.addDevice('Restored owner');assert.equal(restored.readTurn(accepted.seq).answer.notice,turn.answer.notice);assert.deepEqual(restored.browserFile(owner.id,action.action_id,'original'),e.original);}finally{restored.close();}
    }

  }finally{await service?.close();e.close();}
});
for(const repair of ['encoding','edit'])test(`continuing service repairs a 20KB file through bounded ${repair} arguments`,async()=>{
  const e=fixture();let service;try {
    e.store.cancel(e.job.seq);let step=0;
    const text='x'.repeat(20000)+'\nBROKEN-END';
    const original=fileCopy('large.txt','text/plain',Buffer.from(text));
    e.browser.readFile=async(epoch,observation,ref,admit)=>{admit();return original;};
    const call=(name,args)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]},input_tokens:1,output_tokens:1});
    service=new ContactService(e.store,{contextLimitBytes:65536,async chat(messages,tools){
      if(tools.some(t=>t.function.name==='work_on_shared_browser'))return messages.some(m=>m.tool_name==='work_on_shared_browser') ? {message:{role:'assistant',content:'브라우저 작업 결과를 확인했어요.'},input_tokens:1,output_tokens:1} : call('work_on_shared_browser',{});
      step++;if(step===1)return call('observe_shared_browser',{});
      const last=JSON.parse(messages.at(-1).content);
      if(step===2)return call('read_shared_file',{observation:last.observation,ref:'file-1',encoding:'auto'});
      if(step===3){assert.equal(last.content,text);return call('replace_shared_file',{file:last.file,name:'fixed.txt',content:null,edits:repair==='edit'?[{old_text:'BROKEN-END',new_text:'FIXED-END'}]:[],submit:null});}
      return {message:{role:'assistant',content:'수정본을 적용했지만 사이트의 처리 결과는 아직 확인하지 못했어요.'},input_tokens:1,output_tokens:1};
    }},base);service.attachBrowser(e.browser);
    const accepted=service.submit(e.device.id,randomUUID(),'선택한 파일을 고쳐줘.');await service.idle();
    const turn=e.store.turn(accepted.seq);assert.equal(turn.state,'answered',turn.error);assert.equal(e.browser.writes,1);
    assert.equal(Buffer.from(e.browser.copy.data,'base64').toString(),repair==='edit'?text.replace('BROKEN-END','FIXED-END'):text);
    assert.deepEqual(e.store.browserFile(e.device.id,e.store.browserActions()[0].action.action_id,'original'),original);
  }finally{await service?.close();e.close();}
});
for(const mode of ['missing','ambiguous','oversize','mixed','unknown'])test(`invalid ${mode} file edits leave the selected file untouched`,async()=>{
  const e=fixture();try{
    if(mode==='oversize')e.browser.readFile=async()=>fileCopy('large.txt','text/plain',Buffer.from('x'.repeat(29000)+'END'));
    const {sources,args}=await read(e);args.content=null;
    args.edits=[{old_text:mode==='missing'?'missing':mode==='oversize'?'END':'\r\n',new_text:mode==='oversize'?'z'.repeat(4000):'\n'}];
    if(mode==='mixed')args.content='rewrite';if(mode==='unknown')args.edits[0].guess=true;
    await assert.rejects(sources.execute('replace_shared_file',args,signal()));assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
  }finally{e.close();}
});
for(const reason of ['target_changed','form_validation','submission_not_observed'])test(`file application without observed submission preserves ${reason} and cannot replay`,async()=>{
  const e=fixture();try{
    const {sources,args}=await read(e),replace=e.browser.replaceFile;
    e.browser.replaceFile=async(...params)=>{await replace.apply(e.browser,params);return {applied:true,submitted:false,reason};};
    const result=await sources.execute('replace_shared_file',args,signal());
    assert.equal(result.submitted,false);assert.equal(result.reason,reason);assert.equal(result.state,'UNCERTAIN');
    assert.equal(e.store.browserBlocked(e.browser.grant.origin),true);assert.equal(e.browser.writes,1);
    const view=await sources.execute('observe_shared_browser',{},signal());
    await assert.rejects(sources.execute('verify_shared_file',{action_id:result.action_id,observation:view.observation,ref:'download-1'},signal()));
    await assert.rejects(sources.execute('replace_shared_file',args,signal()));assert.equal(e.browser.writes,1);
  }finally{e.close();}
});
test('a file in a command-bearing form remains readable but cannot trigger change or submission',async()=>{
  const e=fixture();try{
    const observe=e.browser.observe;
    e.browser.observe=async(...params)=>{const view=await observe.apply(e.browser,params);view.files[0].replaceable=false;view.files[0].submitters=[];return view;};
    const {sources,args}=await read(e);args.submit=null;
    await assert.rejects(sources.execute('replace_shared_file',args,signal()),/CONTACT_BROWSER_FILE_SCOPE/);
    assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
  }finally{e.close();}
});
for(const name of ['passwords.txt','credentials.json','secrets.csv','access-token.log','비밀번호.txt'])test(`credential file ${name} is rejected before source delivery or result creation`,async()=>{
  const e=fixture();try{
    assert.throws(()=>fileCopy(name,'text/plain',Buffer.from('synthetic canary')),/CONTACT_BROWSER_FILE_INVALID/);
    const {sources,args}=await read(e);args.name=name;
    await assert.rejects(sources.execute('replace_shared_file',args,signal()));
    assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
    const next=e.sources();e.browser.readFile=async()=>({...e.original,name});
    const view=await next.execute('observe_shared_browser',{},signal());
    await assert.rejects(next.execute('read_shared_file',{observation:view.observation,ref:'file-1',encoding:'auto'},signal()));
  }finally{e.close();}
});
test('a vanished original is a confirmed failure and an existing download cannot verify it',async()=>{
  const e=fixture();try{
    const {sources,args}=await read(e);
    e.browser.replaceFile=async(epoch,observation,ref,source,replacement,submit,admit)=>{admit();return {applied:false,reason:'file_unavailable'};};
    const result=await sources.execute('replace_shared_file',args,signal());
    assert.equal(result.state,'FAILED');assert.equal(result.verdict,'CONFIRMED_NOT_APPLIED');assert.equal(result.reason,'file_unavailable');
    const view=await sources.execute('observe_shared_browser',{},signal());
    await assert.rejects(sources.execute('verify_shared_file',{action_id:result.action_id,observation:view.observation,ref:'download-1'},signal()));
    assert.equal(e.browser.writes,0);assert.equal(e.store.browserBlocked(e.browser.grant.origin),false);
  }finally{e.close();}
});

for(const bytes of [9000,10500])test(`staged file schema budget admits the complete next request for ${bytes} bytes`,async()=>{
  const e=fixture();try{
    const content='x'.repeat(bytes),source=e.sources();let calls=0,last;
    e.browser.readFile=async(epoch,observation,ref,admit)=>{admit();return fileCopy('large.txt','text/plain',Buffer.from(content));};
    const model={async chat(messages,tools){
      calls++;assert.ok(Buffer.byteLength(JSON.stringify({messages,tools}))<=14000);
      const call=(name,args)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]},input_tokens:1,output_tokens:1});
      if(calls===1)return call('observe_shared_browser',{});
      last=JSON.parse(messages.at(-1).content);
      if(calls===2)return call('read_shared_file',{observation:last.observation,ref:'file-1',encoding:'auto'});
      if(bytes===10500){assert.equal(last.error,'ASSISTANT_SOURCE_LIMIT');assert.equal(source.definitions.some(t=>t.function.name==='replace_shared_file'),false);assert.equal(JSON.stringify(messages).includes(content),false);}
      else{assert.equal(last.content,content);assert.ok(source.definitions.some(t=>t.function.name==='replace_shared_file'));}
      return {message:{role:'assistant',content:bytes===10500?'이 파일은 현재 한도 안에서 전부 읽을 수 없어 수정하지 않았어요.':'파일을 읽었고 아직 수정하지 않았어요.'},input_tokens:1,output_tokens:1};
    }};
    const assistant=new ConversationAssistant(model,source);const answer=await assistant.ask('이 파일을 확인해 줘.').catch(error=>{throw Error(JSON.stringify({error:error.message,bytes,calls,last_error:last?.error}));});
    assert.equal(calls,3);assert.ok(answer.text);assert.equal(e.browser.writes,0);assert.equal(e.store.browserActions().length,0);
  }finally{e.close();}
});

test('historical hash-only records remain readable but cannot enter the new completion path',async()=>{
  const e=fixture();try {
    const {sources,args}=await read(e);await sources.execute('replace_shared_file',args,signal());
    const old=structuredClone(e.store.browserActions()[0]);old.action.verifier_version='selected_file_download_v1';
    old.action.state='VERIFIED';old.action.side_effect_state='confirmed';old.action.reconciliation_verdict='CONFIRMED_APPLIED';old.action.acceptance_status='pass';
    old.receipt.version=2;old.receipt.verification_scope='selected_file_download';old.receipt.observed_sha256=old.payload.replacement.sha256;old.receipt.server_persistence='download_readback';
    assert.equal(validBrowserFileActions({version:2,records:[old]}),true);
    old.action.state='UNCERTAIN';old.action.side_effect_state='uncertain';old.action.reconciliation_verdict='UNCERTAIN';old.action.acceptance_status='inconclusive';old.receipt.observed_sha256=null;old.receipt.server_persistence='not_checked';
    assert.equal(validBrowserFileActions({version:2,records:[old]}),true);
    assert.throws(()=>finishBrowserFileAction(old,true,old.payload.replacement.sha256),/CONTACT_BROWSER_FILE_INVALID/);
    old.action.verifier_version='selected_file_download_v2';assert.equal(validBrowserFileActions({version:2,records:[old]}),false);
  }finally{e.close();}
});
