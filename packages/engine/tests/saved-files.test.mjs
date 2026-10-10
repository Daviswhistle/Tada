import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { SavedFileSources } from '../src/saved-file-sources.mjs';
import { RecoveredRecords } from '../src/contact-recovery.mjs';
import { CONTINUING_CONSENT } from '../src/continuing-use.mjs';
import { fileCopy, fileHash } from '../src/browser-file-actions.mjs';
const base={definitions:[],validate:()=>false,execute:async()=>{throw Error('NO_SOURCE');},verify:async()=>false};
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'tada-saved-files-')),options={directory:join(root,'journal'),passphrase:'SYNTHETIC_SAVED_FILES_KEY',route:contactRoute({fixture:'saved-files'})};
  const stores=[];const open=opts=>{const s=new ContactStore({...options,...opts});stores.push(s);return s;};
  const store=open({initialize:true,assistance:true}),device=store.addDevice('Owner');
  const start=(s=store,d=device)=>{const id=s.submit(d.id,randomUUID(),'아까 고친 파일을 찾아줘').seq;return s.claim();};
  const seed=start(),original=fileCopy('원본.csv','text/csv',Buffer.from('\ufeffname,amount\n한솔,1200\n','utf16le'));
  const copy=fileCopy('수정.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n'));
  let n=0;
  const add=(file=true,applied=false,source=original)=>{
    const grant={epoch:randomUUID(),device:device.id,target:'fixture',origin:`https://fixture${n++}.invalid`,files:true};grant.url=grant.origin+'/import';
    const view={key:'view',fields:[{ref:'field',label:'Title'}],files:[{ref:'file',label:'CSV'}]};
    const id=file?store.admitBrowserFileAction(seed.seq,grant,view,'file',source,copy,null):store.admitBrowserAction(seed.seq,grant,view,'field','saved');
    if(file)store.finishBrowserFileAction(id,applied);else store.finishBrowserAction(id,'saved',null,false);
    return id;
  };
  const next=()=>{store.cancel(seed.seq);store.configureContinuingUse(device.id,true,CONTINUING_CONSENT);return start();};
  return {root,store,device,seed,original,copy,add,next,start,open,close(){for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});}};
}
const list=(s,cursor=null,budget)=>s.execute('list_saved_files',{cursor},undefined,budget);
const read=(s,id,kind='replacement',encoding='auto',budget)=>s.execute('read_saved_file',{action_id:id,kind,encoding},undefined,budget);
test('older than twenty actions: bounded empty pages lead to complete original/copy across restart',async()=>{
 const e=fixture();try {
  const id=e.add();for(let i=0;i<105;i++)e.add(false);e.next();e.store.close();
  const s=e.open();const job=e.start(s);const tools=new SavedFileSources(base,s,job);
  assert.deepEqual(tools.definitions.map(t=>t.function.name),['list_saved_files']);
  await assert.rejects(read(tools,id),/INVALID/);
  const first=await list(tools);assert.equal(first.files.length,0);assert.ok(first.next_cursor);
  const second=await list(tools,first.next_cursor);assert.equal(second.files[0].action_id,id);assert.equal(second.next_cursor,null);
  const original=await read(tools,id,'original'),copy=await read(tools,id);
  assert.equal(original.encoding,'utf-16le');assert.equal(original.content,copy.content);assert.equal(copy.sha256,e.copy.sha256);assert.equal(copy.truncated,false);
  assert.equal(copy.url,`/api/browser/files/${id}/replacement`);assert.equal(copy.source_kind,'saved_file_snapshot');
  assert.equal(copy.state,'FAILED');assert.equal(await tools.verify([],undefined),false);
  assert.deepEqual(s.browserFile(e.device.id,id,'original'),e.original);
 }finally{e.close();}
});
test('page boundaries, turn-local cursors and same-state receipt updates cannot silently skip records',async()=>{
 const e=fixture();try{
  const ids=Array.from({length:12},()=>e.add(true,true)),job=e.next(),tools=new SavedFileSources(base,e.store,job);
  const page=await list(tools);assert.equal(page.files.length,5);assert.ok(page.next_cursor);
  const req=e.store.reserve(job.seq);e.store.observe(req,{input_tokens:1,output_tokens:1});
  assert.equal((await list(tools,page.next_cursor)).files.length,5);
  await assert.rejects(list(new SavedFileSources(base,e.store,job),page.next_cursor),/INVALID/);
  // DELETE/INSERT can reuse the highest rowid, name and count. Explicit revision
  // changes must invalidate the old cursor even in that exact state.
  e.store.finishBrowserFileAction(ids.at(-1),true,fileHash(Buffer.from('download')));
  await assert.rejects(list(tools,page.next_cursor),/CURSOR_STALE/);
  const all=[];let cursor=null;do{const p=await list(tools,cursor);all.push(...p.files.map(f=>f.action_id));cursor=p.next_cursor;}while(cursor);
  assert.equal(new Set(all).size,12);assert.deepEqual(new Set(all),new Set(ids));
 }finally{e.close();}
});
test('recovered snapshots use exact/paged lookups, preserve provenance and never revive actions',async()=>{
 const e=fixture();const rows=RecoveredRecords.prototype.rows;try{
  const ids=Array.from({length:12},()=>e.add()),snapshot=e.store.exportRecords(e.device.id);
  const s=e.open({directory:join(e.root,'restored'),initialize:true,recovery:snapshot}),d=s.addDevice('New owner');
  s.configureContinuingUse(d.id,true,CONTINUING_CONSENT);const job=e.start(s,d);
  RecoveredRecords.prototype.rows=function(name){if(name==='browser_actions')throw Error('FULL_ARCHIVE_CLONE');return rows.call(this,name);};
  const tools=new SavedFileSources(base,s,job);let cursor=null;const files=[];
  do{const p=await list(tools,cursor);files.push(...p.files);cursor=p.next_cursor;}while(cursor);
  assert.equal(files.length,12);const r=await read(tools,ids[0],'original');
  assert.equal(r.recovery.quarantined,true);assert.equal(r.recovery.generation,snapshot.source.journal_id);
  assert.deepEqual(s.browserFile(d.id,ids[0],'original'),e.original);assert.equal(s.browserActions().length,0);assert.equal(s.browserReceipts(e.seed.seq).length,12);
  assert.throws(()=>s.finishBrowserFileAction(ids[0],true),/INVALID/);
 }finally{RecoveredRecords.prototype.rows=rows;e.close();}
});
for(const mode of ['off','off_on','revoke','cancel','wrong_device','aborted'])test(`saved file reads and result admission respect ${mode}`,async()=>{
 const e=fixture();try{
  const id=e.add(),job=e.next(),tools=new SavedFileSources(base,e.store,mode==='wrong_device'?{...job,device:randomUUID()}:job);
  if(mode==='wrong_device'){await assert.rejects(list(tools));return;}
  await list(tools);await read(tools,id);
  if(mode==='off'||mode==='off_on')e.store.configureContinuingUse(e.device.id,false,null);
  if(mode==='off_on')e.store.configureContinuingUse(e.device.id,true,CONTINUING_CONSENT);
  if(mode==='revoke')e.store.revoke(e.device.id);if(mode==='cancel')e.store.cancel(job.seq);
  const signal=mode==='aborted'?AbortSignal.abort():undefined;
  assert.throws(()=>tools.assertCurrent(signal));await assert.rejects(tools.execute('read_saved_file',{action_id:id,kind:'original',encoding:'auto'},signal));
  if(mode==='off'||mode==='off_on')assert.deepEqual(e.store.browserFile(e.device.id,id,'original'),e.original);
 }finally{e.close();}
});
test('disabled/empty history, forged IDs, current-turn files and tool collisions grant no access',async()=>{
 const e=fixture();try{
  const id=e.add(),disabled=new SavedFileSources(base,e.store,e.seed);assert.equal(disabled.definitions.length,0);
  await assert.rejects(list(disabled),/HISTORY_DISABLED/);const job=e.next();
  const s=new SavedFileSources(base,e.store,job);
  assert.equal((await list(s)).files.length,1);await assert.rejects(read(s,'browser-'+randomUUID()),/INVALID/);
  await assert.rejects(s.execute('read_saved_file',{action_id:id,kind:'original',encoding:'auto',extra:true}),/INVALID/);
  const current=new SavedFileSources(base,e.store,e.seed);await assert.rejects(list(current),/STOPPED/);
  assert.throws(()=>e.store.savedFileRecord(e.device.id,id,e.seed.seq),/INVALID/);
  assert.throws(()=>new SavedFileSources({definitions:[{function:{name:'read_saved_file'}}]},e.store,job),/COLLISION/);
 }finally{e.close();}
});
test('whole file or explicit limit/encoding failure: no silent truncation or budget-issued read grants',async()=>{
 const e=fixture();try{
  const id=e.add(true,false,fileCopy('latin.txt','text/plain',Buffer.from([0xe9]))),job=e.next(),s=new SavedFileSources(base,e.store,job);
  await assert.rejects(list(s,null,{fits:()=>false}),/SOURCE_LIMIT/);await assert.rejects(read(s,id),/INVALID/);
  await list(s);await assert.rejects(read(s,id,'original'),/ENCODING_REQUIRED/);
  assert.equal((await read(s,id,'original','windows-1252')).content,'é');
  await assert.rejects(read(s,id,'replacement','auto',{fits:()=>false}),/SOURCE_LIMIT/);
  assert.equal((await read(s,id)).content,Buffer.from(e.copy.data,'base64').toString());
 }finally{e.close();}
});
for(const google of [false,true])test(`continuing conversation recalls file with no browser connection and compacts the saved checkpoint, Google ${google}`,async()=>{
 const e=fixture();let service;try{
  const id=Array.from({length:12},()=>e.add()).at(-1);e.store.cancel(e.seed.seq);e.store.configureContinuingUse(e.device.id,true,CONTINUING_CONSENT);let step=0;
  const call=(name,args)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]},input_tokens:1,output_tokens:1});
  service=new ContactService(e.store,{async chat(messages,tools){step++;
    if(step===1){assert.ok(tools.some(t=>t.function.name==='list_saved_files'));return call('list_saved_files',{cursor:null});}
    const last=JSON.parse(messages.at(-1).content);assert.equal(last.error,undefined);
    if(step===2){assert.equal(last.files[0].action_id,id);return call('read_saved_file',{action_id:id,kind:'replacement',encoding:'auto'});}
    assert.equal(last.content,Buffer.from(e.copy.data,'base64').toString());return {message:{role:'assistant',content:'저장된 수정 파일을 찾았어요.'},input_tokens:1,output_tokens:1};
  }},base);
  if(google)service.attachGoogle(Object.assign(new EventEmitter(),{connect(){},close(){},status:()=>({configured:true,connected:true}),captureGrant:()=>({connected:true,email:'owner@example.invalid'}),assertSnapshot(){}}));
  const accepted=service.submit(e.device.id,randomUUID(),'아까 고친 파일 찾아줘');await service.idle();assert.equal(e.store.turn(accepted.seq).state,'answered',JSON.stringify({error:e.store.turn(accepted.seq).error,step}));assert.equal(step,3);
  const saved=e.store.checkpoint().value.history.find(m=>m.tool_name==='read_saved_file');assert.ok(saved);assert.doesNotMatch(saved.content,/한솔/);
 }finally{await service?.close();e.close();}
});
test('context-sized pages never omit saved pairs or issue read authority for unreturned items',async()=>{
 const e=fixture();try{
  const ids=Array.from({length:12},()=>e.add()),job=e.next(),s=new SavedFileSources(base,e.store,job),seen=[];
  let cursor=null;do{
    const page=await list(s,cursor,{fits:r=>r.files.length<=2});assert.ok(page.files.length<=2);
    seen.push(...page.files.map(r=>r.action_id));cursor=page.next_cursor;
    if(seen.length===2)await assert.rejects(read(s,ids[0]),/INVALID/);
  }while(cursor);
  assert.deepEqual(new Set(seen),new Set(ids));assert.equal(seen.length,12);
 }finally{e.close();}
});
test('no historical browser records expose no tools and do not borrow a later enabled grant',async()=>{
 const e=fixture();try{
  const job=e.next(),empty=new SavedFileSources(base,e.store,job);assert.equal(empty.definitions.length,0);await assert.rejects(list(empty),/DISABLED/);
 }finally{e.close();}
});
test('history off/on while a provider result is pending rejects the late recalled-file answer',async()=>{
 const e=fixture();let service;try{
  e.add();e.store.cancel(e.seed.seq);e.store.configureContinuingUse(e.device.id,true,CONTINUING_CONSENT);let step=0;
  service=new ContactService(e.store,{async chat(){step++;
    if(step===1)return {message:{role:'assistant',content:'',tool_calls:[{function:{name:'list_saved_files',arguments:{cursor:null}}}]},input_tokens:1,output_tokens:1};
    e.store.configureContinuingUse(e.device.id,false,null);e.store.configureContinuingUse(e.device.id,true,CONTINUING_CONSENT);
    return {message:{role:'assistant',content:'REJECT_THIS_LATE_HISTORY_ANSWER'},input_tokens:1,output_tokens:1};
  }},base);
  const accepted=service.submit(e.device.id,randomUUID(),'아까 파일');await service.idle();
  assert.equal(e.store.turn(accepted.seq).state,'failed');assert.equal(e.store.turn(accepted.seq).error,'CONTACT_HISTORY_DISABLED');
  assert.equal(e.store.turn(accepted.seq).answer,null);assert.equal(e.store.usage().requests,2);
 }finally{await service?.close();e.close();}
});
