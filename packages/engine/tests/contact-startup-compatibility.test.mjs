// Local protocol fixtures only: no account, installed model or OS migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { main } from '../src/contact-cli.mjs';
import { serveSetup } from '../src/app-setup.mjs';
import { createRecordBackup, openRecordBackup } from '../src/contact-backup.mjs';
import { DatabaseSync } from 'node:sqlite';
import { saveGoogleClientConfig } from '../src/google-client-config.mjs';
import { GOOGLE_SCOPES, GOOGLE_SEND_CONSENT } from '../src/google-contract.mjs';
const key='synthetic-compatibility-key-only';
const noSources={definitions:[],validate:()=>false,verify:async()=>false};
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(version=5){
 const calls=[];const upstream=createServer((req,res)=>{
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
   const request=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
   let body=req.url==='/api/version'?{version:'synthetic-only'}:req.url==='/api/tags'?{models:[{name:'fixture:latest',size:10,digest:'a'.repeat(64)}]}:req.url==='/api/show'?{details:{format:'gguf'},capabilities:['completion','tools']}:null;
   if(req.url==='/api/chat'){
    calls.push(request);const recent=request.messages.slice(request.messages.findLastIndex(m=>m.role==='user')+1);
    const tools=request.tools.map(t=>t.function.name);
    const read=tools.includes('list_recent_emails')&&!recent.some(m=>m.role==='tool');
    body={done:true,done_reason:'stop',message:{role:'assistant',content:read?'':'기존 대화를 이어서 확인했어요. '+recent.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content).evidence_id).filter(Boolean).map(id=>'['+id+']').join(' '),...(read?{tool_calls:[{function:{name:'list_followups',arguments:{status:'active',offset:0}}},{function:{name:'list_recent_emails',arguments:{}}},{function:{name:'list_upcoming_events',arguments:{}}}]}:{})},prompt_eval_count:5,eval_count:4};
   }
   res.writeHead(body?200:404,{'content-type':'application/json'});res.end(JSON.stringify(body));
  });
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const endpoint='http://127.0.0.1:'+upstream.address().port,root=mkdtempSync(join(tmpdir(),'tada-compatible-')),data=join(root,'journal');
 const route=contactRoute({version:1,provider:'ollama-local',model:'fixture:latest',digest:'a'.repeat(64),endpoint,scopes:[]});
 let store=new ContactStore({directory:data,passphrase:key,route,initialize:true,reviews:version>=4,assistance:version>=5});
 const device=store.addDevice('Synthetic owner');const id=store.id;
 const seq=store.submit(device.id,randomUUID(),'내일 회의 준비를 이어서 도와줘.').seq;store.claim();
 const cp=new ConversationAssistant({},noSources).checkpoint();cp.history=[{role:'user',content:'내일 회의 준비를 이어서 도와줘.'},{role:'assistant',content:'기존 기록입니다.'}];store.finish(seq,{text:'기존 기록입니다.',sources:[],verification:'not_applicable'},cp);store.close();
 const args=['--data',data,'--provider','ollama','--model','fixture','--endpoint',endpoint,'--port',String(await freePort()),'--timezone','Asia/Seoul'];
 const open=()=>new ContactStore({directory:data,passphrase:key,route});
 return {data,root,args,route,id,device,calls,open,async close(){store.close();await new Promise(r=>upstream.close(r));rmSync(root,{recursive:true,force:true});}};
}
test('v5 starts and reopens through the actual runtime, preserving records, connected reads and care without enabling mail',async()=>{
 const f=await fixture(),nativeFetch=globalThis.fetch;let googleReads=0;
 try{
  saveGoogleClientConfig({data:f.data,passphrase:key,route:f.route,client:{client_id:'123456789012-fixture.apps.googleusercontent.com',client_secret:'FAKE_CLIENT_SECRET'}});
  const store=f.open();store.configureContinuingUse(f.device.id,true,'continuing_conversation_24h_v1');
  store.saveGoogleCredential(f.device.id,{version:1,epoch:randomUUID(),device:f.device.id,scopes:[...GOOGLE_SCOPES],refresh_token:'SYNTHETIC_REFRESH_TOKEN_ONLY',email:'owner@example.test',connected_at:Date.now(),last_checked:null,last_error:null,reconnect_required:false},null);
  // The actual scheduler receives a noon timezone regardless of CI wall time.
  let offset=12-new Date().getUTCHours();if(offset>12)offset-=24;
  const zone=offset===0?'Etc/UTC':`Etc/GMT${offset>0?'-':'+'}${Math.abs(offset)}`;
  store.configureProactive(f.device.id,true,'daily_conversation_suggestions_v1',zone);store.close();
  globalThis.fetch=async(url,options)=>{
   const u=new URL(url);if(u.hostname==='127.0.0.1')return nativeFetch(url,options);
   googleReads++;
   if(u.href==='https://oauth2.googleapis.com/token')return Response.json({access_token:'SYNTHETIC_ACCESS_TOKEN_ONLY',token_type:'Bearer',expires_in:3600,scope:GOOGLE_SCOPES.join(' ')});
   assert.equal(options.method,'GET');if(u.hostname==='www.googleapis.com'&&u.pathname==='/calendar/v3/calendars/primary/events')return Response.json({items:[]});assert.equal(u.hostname,'gmail.googleapis.com');
   if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'owner@example.test'});
   assert.equal(u.pathname,'/gmail/v1/users/me/messages');return Response.json({messages:[]});
  };
  for(let run=0;run<2;run++){
   let entry,registered=0;
   const ui={signal:new AbortController().signal,recordUpdate:prepare=>{assert.equal(typeof prepare,'function');registered++;return()=> 'http://127.0.0.1:9000/#upgrade=1';},ready:source=>{entry=source();},fail:()=>{throw Error('UNEXPECTED_RUNTIME_FAULT');},wait:async()=>{
    const origin=new URL(entry).origin;
    const call=(path,body,cookie=true)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:'tada_local='+f.device.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const state=async()=>{const r=await call('/api/state');const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
    const until=async(predicate)=>{const end=Date.now()+10000;do{const value=await state();if(predicate(value))return value;await new Promise(r=>setTimeout(r,15));}while(Date.now()<end);throw Error('COMPATIBILITY_STATE_TIMEOUT');};
    let current=await until(s=>s.turns.some(t=>t.origin==='proactive'&&t.state==='answered'));
    assert.equal(current.assistant,f.id);assert.equal(current.google.connected,true);assert.equal(current.google.mail.ready,false);assert.equal(current.record_update_available,true);assert.equal(current.proactive.enabled,true);
    assert.equal((await call('/api/records/update',{},false)).status,401);
    assert.deepEqual(await (await call('/api/records/update',{})).json(),{url:'http://127.0.0.1:9000/#upgrade=1'});
    const before=googleReads,mail={id:'mail-'+randomUUID(),revision:1,sha256:'a'.repeat(64)};
    for(const [path,body] of [
     ['/api/mail/edit',{...mail,draft:{}}],['/api/mail/discard',mail],['/api/mail/send',{...mail,consent:'send_exact_mail_once_v1'}],['/api/mail/reconcile',{id:mail.id}],['/api/google/connect',{consent:GOOGLE_SEND_CONSENT}],
    ]){const result=await call(path,body);assert.equal(result.ok,false);assert.match((await result.json()).error,/MAIL_UPGRADE_REQUIRED/);}
    assert.equal(googleReads,before,'mail denial happens before token refresh or Google requests');
    const request_id=randomUUID();assert.equal((await call('/api/turns',{request_id,text:'최근 메일도 확인해 줘.'})).status,202);
    current=await until(s=>s.turns.some(t=>t.request_id===request_id&&t.state==='answered'));
    assert.ok(current.turns.some(t=>t.answer?.text==='기존 기록입니다.'));assert.ok(googleReads>before);
   }};
   const background=run?{status:async()=>({available:true,enabled:true}),configure:async()=>{},handoff:async()=>{}}:undefined;
   await main(f.args,{ui,keyProvider:async()=>key,background});assert.equal(registered,1);
   const reopened=f.open();assert.equal(reopened.contactVersion,5);assert.equal(reopened.id,f.id);assert.equal(reopened.googleCredential().version,1);assert.equal(reopened.proactiveStatus().enabled,true);const snapshot=reopened.exportRecords(f.device.id);assert.equal(snapshot.source.schema_version,5);assert.deepEqual(snapshot.records.mail_actions,[]);reopened.close();
   const protector={kind:'windows-dpapi-v1',protect:async b=>Buffer.from(b),unprotect:async b=>Buffer.from(b)};
   const archive=await createRecordBackup(snapshot,{protector});assert.equal(archive.bytes.includes(Buffer.from('기존 기록입니다.')),false);
   const restored=new ContactStore({directory:join(f.root,'restored-'+run),passphrase:key,route:f.route,initialize:true,recovery:await openRecordBackup(archive.bytes,{protector})});
   assert.equal(restored.contactVersion,7);assert.equal(restored.readTurn(1).answer.text,'기존 기록입니다.');assert.equal(restored.googleCredential(),null);assert.equal(restored.proactiveStatus().enabled,false);assert.equal(restored.claim(),null);restored.close();
   assert.equal(readdirSync(f.data).some(name=>name.startsWith('before-mail-')),false);
  }
  assert.ok(f.calls.length>=4);assert.ok(f.calls.every(c=>c.tools.every(t=>!['prepare_mail','list_mail_actions','read_mail_action'].includes(t.function.name))));
 }finally{globalThis.fetch=nativeFetch;await f.close();}
});
test('older v4 retains explicit backup upgrade, while v5 never silently upgrades',async()=>{
 const f=await fixture(4);try{
  const ui={signal:new AbortController().signal,ready:()=>{},wait:async()=>{},fail:()=>{throw Error('UNEXPECTED_RUNTIME_FAULT');}};
  await assert.rejects(main(f.args,{ui,keyProvider:async()=>key}),/CONTACT_ASSISTANCE_UPGRADE_REQUIRED/);
  let s=f.open();assert.equal(s.contactVersion,4);s.close();
  await main(f.args,{ui:{...ui,upgrade:true},keyProvider:async()=>key});
  s=f.open();assert.equal(s.contactVersion,6);assert.equal(s.id,f.id);assert.equal(s.turn(1).answer.text,'기존 기록입니다.');s.close();
  assert.ok(readdirSync(f.data).some(n=>n.startsWith('before-mail-')));assert.ok(readdirSync(f.data).some(n=>n.startsWith('before-assistance-')));
 }finally{await f.close();}
});

test('owner update click restarts the real v5 runtime once and creates a v5 backup before opening v6',async()=>{
 const f=await fixture();let setup,runs=0;
 try{
  setup=await serveSetup({run:ui=>{runs++;return main(f.args,{ui,keyProvider:async()=>key});}});
  const url=new URL(setup.url),authorization='Bearer '+new URLSearchParams(url.hash.slice(1)).get('setup');
  const state=()=>fetch(url.origin+'/state',{headers:{Authorization:authorization}}).then(r=>r.json());
  const ready=async()=>{const end=Date.now()+10000;do{const value=await state();if(value.stage==='ready')return value;assert.notEqual(value.stage,'error',value.message);await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);throw Error('SETUP_TIMEOUT');};
  const first=await ready();assert.equal(first.upgrade_available,true);assert.equal(runs,1);
  const accepted=await fetch(url.origin+'/action',{method:'POST',headers:{Origin:url.origin,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({revision:first.revision,action:'upgrade',value:true})});assert.equal(accepted.status,202);
  const next=await ready();assert.equal(next.upgrade_available,false);assert.equal(runs,2);
  await setup.close();setup=null;
  const store=f.open();assert.equal(store.contactVersion,6);assert.equal(store.id,f.id);assert.equal(store.turn(1).answer.text,'기존 기록입니다.');assert.equal(store.googleCredential(),null);store.close();
  const backups=readdirSync(f.data).filter(n=>n.startsWith('before-mail-'));assert.equal(backups.length,1);
  const db=new DatabaseSync(join(f.data,backups[0]),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);assert.equal(db.prepare('SELECT id FROM identity').get().id,f.id);}finally{db.close();}
 }finally{await setup?.close();await f.close();}
});
