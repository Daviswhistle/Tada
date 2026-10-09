import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,lstatSync,symlinkSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppRecords,RESTORE_CONSENT } from '../src/app-records.mjs';
import { ContactStore,contactRoute } from '../src/contact-store.mjs';
import { createRecordBackup } from '../src/contact-backup.mjs';
const protector={kind:'windows-dpapi-v1',protect:async k=>Buffer.from(k),unprotect:async k=>Buffer.from(k)};
const passphrase='SYNTHETIC_APP_RECOVERY_KEY_ONLY',route=contactRoute({fixture:'app-recovery'});
function env({missing=false}={}){
 const root=mkdtempSync(join(tmpdir(),'tada-app-records-')),data=join(root,'conversation'),profile=data+'.chatgpt-private';
 mkdirSync(data+'.app-private',{mode:0o700});
 if(!missing){mkdirSync(data,{mode:0o700});writeFileSync(join(data,'original.bin'),'ORIGINAL_RECORD_BYTES',{mode:0o600});}
 mkdirSync(profile,{mode:0o700});writeFileSync(join(profile,'account.bin'),'ORIGINAL_ACCOUNT_BYTES',{mode:0o600});
 const options={data,provider:'chatgpt',roots:[]};
 const instance=extra=>new AppRecords(options,{protector,...extra});
 return{root,data,profile,instance,close:()=>rmSync(root,{recursive:true,force:true})};
}
async function backup(root){
 const store=new ContactStore({directory:join(root,'source-'+randomUUID()),passphrase,route,initialize:true,mail:true});
 try{const d=store.addDevice('old');const t=store.submit(d.id,randomUUID(),'백업의 대화').seq;store.claim();store.finish(t,{text:'저장한 답변',sources:[]},{version:1});
  const snapshot=store.exportRecords(d.id,{provider:{kind:'chatgpt-subscription',subject:'synthetic-subject',label:'owner@example.test',model:'test-model'},google_client:null});
  return{snapshot,...await createRecordBackup(snapshot,{protector,portable:true})};
 }finally{store.close();}
}
async function prepare(records,archive){const p=await records.preview(archive.bytes);await records.confirm(p.id,RESTORE_CONSENT);return p;}
async function initialize(records){const context=await records.context();if(context.initialize){const s=new ContactStore({directory:context.data,passphrase,route,initialize:true,recovery:context.recovery});s.close();context.publishDirectory();}return context;}

test('preview is read-only, confirmation is explicit, activation preserves bytes and old defaults cannot reopen',async()=>{
 const e=env();try{
  const a=await backup(e.root),r=e.instance(),p=await r.preview(a.bytes);
  assert.equal(p.turns,1);assert.equal(p.new_registration_required,true);assert.equal(r.status().pending,false);assert.equal((await r.context()),null);
  assert.equal(readFileSync(join(e.data,'original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');
  await assert.rejects(r.confirm(p.id,'wrong'),/CONSENT_REQUIRED/u);
  await r.confirm(p.id,RESTORE_CONSENT);assert.equal(r.status().pending,true);
  const c=await initialize(r);assert.equal(c.expectedSubject,'synthetic-subject');assert.equal(c.expectedClient,null);c.beforeReady();
  assert.ok(lstatSync(e.data).isFile());assert.ok(lstatSync(e.profile).isFile());
  const active=await e.instance().context();assert.equal(active.initialize,false);assert.equal(active.restoring,false);active.beforeReady();
  const original=join(active.data,'..','original');assert.equal(readFileSync(join(original,'data','original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');assert.equal(readFileSync(join(original,'profile','account.bin'),'utf8'),'ORIGINAL_ACCOUNT_BYTES');
  const s=new ContactStore({directory:active.data,passphrase,route});assert.equal(s.readTurn(1).text,'백업의 대화');assert.equal(s.claim(),null);s.close();
  assert.throws(()=>new ContactStore({directory:e.data,passphrase,route,initialize:true}),/CONTACT_|EEXIST/u);
  await assert.rejects(r.confirm(p.id,RESTORE_CONSENT),/PREVIEW_EXPIRED/u);
 }finally{e.close();}
});
for(const missing of [false,true])for(const phase of ['recorded-original','guarded-data','saved-profile','prepared-barrier-profile','published-barrier-profile','blocked-profile','saved-data','prepared-barrier-data','published-barrier-data','blocked-data','before-pointer','after-pointer'])test(`restore resumes a crash at ${phase}; original missing=${missing}`,async()=>{
 const e=env({missing});try{
  const a=await backup(e.root);let fired=false;const r=e.instance({fault:name=>{if(name===phase&&!fired){fired=true;throw Error('SIMULATED_CRASH');}}});await prepare(r,a);const c=await initialize(r);
  assert.throws(()=>c.beforeReady(),/SIMULATED_CRASH/u);assert.equal(fired,true);
  const resumed=e.instance(),again=await initialize(resumed);again.beforeReady();const active=await resumed.context();assert.equal(active.restoring,false);
  assert.ok(lstatSync(e.profile).isFile());assert.ok(lstatSync(e.data).isFile());
  assert.equal(readFileSync(join(active.data,'..','original','profile','account.bin'),'utf8'),'ORIGINAL_ACCOUNT_BYTES');
  if(!missing)assert.equal(readFileSync(join(active.data,'..','original','data','original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');
 }finally{e.close();}
});
test('canceling before activation returns to original records and keeps the staged directory separate',async()=>{
 const e=env();try{const r=e.instance(),a=await backup(e.root);await prepare(r,a);await initialize(r);assert.equal(r.canCancel(),true);r.cancel();assert.equal(await r.context(),null);assert.equal(r.status().pending,false);assert.equal(readFileSync(join(e.data,'original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');}finally{e.close();}
});
test('a partial staging database is never treated as the published record generation',async()=>{
 const e=env();try{const r=e.instance();await prepare(r,await backup(e.root));const interrupted=await r.context();mkdirSync(interrupted.data,{mode:0o700});writeFileSync(join(interrupted.data,'contact.sqlite'),'partial',{mode:0o600});const next=await initialize(e.instance());assert.notEqual(next.data,interrupted.data);next.beforeReady();assert.equal(readFileSync(join(interrupted.data,'contact.sqlite'),'utf8'),'partial');}finally{e.close();}
});
test('an interrupted guard write is preserved but a fresh guard candidate allows restart to finish',async()=>{
 const e=env({missing:true});let stale,context;
 try{
  const r=e.instance({fault:phase=>{if(phase==='preparing-guard'){
   const generation=join(context.data,'..'),name=readdirSync(generation).find(name=>name.startsWith('guard-pending-'));
   stale=join(generation,name,'.record-'+randomUUID()+'.tmp');writeFileSync(stale,'PARTIAL_GUARD_WRITE',{mode:0o600});throw Error('SIMULATED_CRASH');
  }}});await prepare(r,await backup(e.root));context=await initialize(r);assert.throws(()=>context.beforeReady(),/SIMULATED_CRASH/u);
  const resumed=e.instance();(await initialize(resumed)).beforeReady();assert.equal((await resumed.context()).restoring,false);assert.equal(readFileSync(stale,'utf8'),'PARTIAL_GUARD_WRITE');assert.ok(lstatSync(e.data).isFile());
 }finally{e.close();}
});
test('repeat restore resumes an after-pointer crash without reviving the prior active generation',async()=>{
 const e=env();try{let r=e.instance();const a=await backup(e.root);await prepare(r,a);(await initialize(r)).beforeReady();const first=(await r.context()).data;
  r=e.instance({fault:phase=>{if(phase==='after-pointer')throw Error('SIMULATED_CRASH');}});await prepare(r,a);const second=await initialize(r);assert.throws(()=>second.beforeReady(),/SIMULATED_CRASH/u);
  const resumed=e.instance();(await initialize(resumed)).beforeReady();assert.notEqual((await resumed.context()).data,first);assert.ok(lstatSync(first).isDirectory());
 }finally{e.close();}
});
test('missing active database and altered barriers fail without recreating or overwriting records',async()=>{
 const e=env();try{const r=e.instance();await prepare(r,await backup(e.root));const c=await initialize(r);writeFileSync(join(e.data,'later.txt'),'new',{mode:0o600});
  c.beforeReady();const active=await r.context();writeFileSync(e.profile,'CHANGED');assert.throws(()=>active.beforeReady(),/BARRIER_CHANGED/u);
  rmSync(join(active.data,'contact.sqlite'));await assert.rejects(r.context(),/ACTIVE_MISSING/u);
 }finally{e.close();}
});
test('a profile path collision after its preserved move cannot be overwritten',async()=>{
 const e=env();try{const r=e.instance({fault:phase=>{if(phase==='saved-profile'){writeFileSync(e.profile,'COLLISION',{mode:0o600});throw Error('SIMULATED_CRASH');}}});await prepare(r,await backup(e.root));const c=await initialize(r);assert.throws(()=>c.beforeReady(),/SIMULATED_CRASH/u);const next=await initialize(e.instance());assert.throws(()=>next.beforeReady(),/ORIGINAL_CHANGED/u);assert.equal(readFileSync(e.profile,'utf8'),'COLLISION');assert.equal(readFileSync(join(e.data,'original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');}finally{e.close();}
});

test('original changes after the durable preservation plan stop activation before moving either source',async()=>{
 const e=env();try{const r=e.instance({fault:phase=>{if(phase==='recorded-original')throw Error('SIMULATED_CRASH');}});await prepare(r,await backup(e.root));const c=await initialize(r);assert.throws(()=>c.beforeReady(),/SIMULATED_CRASH/u);
  writeFileSync(join(e.profile,'account.bin'),'OWNER_CHANGED');const next=await initialize(e.instance());assert.throws(()=>next.beforeReady(),/ORIGINAL_CHANGED/u);
  assert.equal(readFileSync(join(e.profile,'account.bin'),'utf8'),'OWNER_CHANGED');assert.equal(readFileSync(join(e.data,'original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');
 }finally{e.close();}
});
test('a linked source is rejected without following or changing its target',async()=>{
 const e=env();try{const r=e.instance();await prepare(r,await backup(e.root));const c=await initialize(r);symlinkSync(e.profile,join(e.data,'linked'),'junction');assert.throws(()=>c.beforeReady(),/PRIVATE_PATH_REQUIRED/u);assert.equal(readFileSync(join(e.profile,'account.bin'),'utf8'),'ORIGINAL_ACCOUNT_BYTES');assert.equal(r.canCancel(),true);}finally{e.close();}
});
test('missing data and profile are guarded across every transition without creating an executable old journal',async()=>{
 for(const phase of ['guarded-data','saved-profile','blocked-profile','saved-data']){
  const e=env({missing:true});try{rmSync(e.profile,{recursive:true});const r=e.instance({fault:name=>{if(name===phase)throw Error('SIMULATED_CRASH');}});await prepare(r,await backup(e.root));const c=await initialize(r);assert.throws(()=>c.beforeReady(),/SIMULATED_CRASH/u);
   assert.ok(lstatSync(e.data,{throwIfNoEntry:false}) || lstatSync(e.profile).isFile());
   (await initialize(e.instance())).beforeReady();assert.ok(lstatSync(e.data).isFile());assert.ok(lstatSync(e.profile).isFile());
  }finally{e.close();}
 }
});
test('provider mismatch and stale previews cannot stage a generation',async()=>{
 const e=env();try{const a=await backup(e.root),r=e.instance(),p=await r.preview(a.bytes);const newer=await r.preview(a.bytes);assert.notEqual(p.id,newer.id);await assert.rejects(r.confirm(p.id,RESTORE_CONSENT),/PREVIEW_EXPIRED/u);r.clearPreview();await assert.rejects(r.confirm(newer.id,RESTORE_CONSENT),/PREVIEW_EXPIRED/u);
  const local=new AppRecords({data:e.data,provider:'ollama'},{protector});await assert.rejects(local.preview(a.bytes),/PROVIDER_MISMATCH/u);assert.equal(local.status().pending,false);assert.equal(readdirSync(e.data+'.app-private/records').length,0);
 }finally{e.close();}
});
test('saved model choices are versioned, argument-bound and cannot be written after cancellation',async()=>{
 const e=env();try{
  const r=e.instance();await prepare(r,await backup(e.root));const c=await r.context();c.saveModelChoice('chosen-model');
  assert.equal((await r.context()).modelChoice,'chosen-model');assert.throws(()=>c.saveModelChoice('bad\nmodel'),/INVALID/u);
  const path=join(c.data,'..','model-choice.json'),original=JSON.parse(readFileSync(path,'utf8'));
  for(const record of [{...original,version:2},{...original,extra:true},{...original,selected:7},{...original,requested:[]}]){
   writeFileSync(path,JSON.stringify(record));await assert.rejects(r.context(),/INVALID/u);
  }
  writeFileSync(path,JSON.stringify(original));r.cancel();assert.throws(()=>c.saveModelChoice('late-model'),/INVALID/u);assert.equal(await r.context(),null);
 }finally{e.close();}
});

for(const target of ['data','profile'])test(`an independently owned original ${target} blocks restoration before any move`,async()=>{
 const e=env({missing:target==='data'});let owner;
 try{
  const {ChatGPTStore}=await import('../../providers/src/chatgpt-store.mjs');
  owner=target==='data'?new ContactStore({directory:e.data,passphrase,route,initialize:true}):new ChatGPTStore({directory:e.profile,passphrase});
  if(target==='data'){const d=owner.addDevice('existing CLI');owner.submit(d.id,randomUUID(),'기존 작업');}
  const r=e.instance();await prepare(r,await backup(e.root));const c=await initialize(r);
  assert.throws(()=>c.beforeReady(),/SOURCE_IN_USE/u);assert.equal(r.canCancel(),true);assert.ok(lstatSync(e.data).isDirectory());assert.ok(lstatSync(e.profile).isDirectory());
  if(target==='data')assert.equal(owner.claim().text,'기존 작업');
  owner.close();owner=null;c.beforeReady();assert.equal((await r.context()).restoring,false);
 }finally{owner?.close();e.close();}
});
test('an independently opened prior restored generation also blocks a repeated restoration',async()=>{
 const e=env();let owner;try{
  const r=e.instance(),a=await backup(e.root);await prepare(r,a);(await initialize(r)).beforeReady();const first=await r.context();
  owner=new ContactStore({directory:first.data,passphrase,route});await prepare(r,a);const c=await initialize(r);
  assert.throws(()=>c.beforeReady(),/SOURCE_IN_USE/u);assert.equal(r.canCancel(),true);
  owner.close();owner=null;c.beforeReady();assert.notEqual((await r.context()).data,first.data);
 }finally{owner?.close();e.close();}
});
if(process.platform!=='win32')test('POSIX retains original source leases through directory and pointer publication',async()=>{
 const e=env({missing:true});try{
  const {ChatGPTStore}=await import('../../providers/src/chatgpt-store.mjs');
  new ContactStore({directory:e.data,passphrase,route,initialize:true}).close();new ChatGPTStore({directory:e.profile,passphrase}).close();
  let observed=false;const r=e.instance({fault:phase=>{if(phase==='recorded-original'){
   assert.throws(()=>new ContactStore({directory:e.data,passphrase,route}),/ALREADY_OWNED/u);
   assert.throws(()=>new ChatGPTStore({directory:e.profile,passphrase}),/PROFILE_IN_USE/u);observed=true;
  }}});await prepare(r,await backup(e.root));(await initialize(r)).beforeReady();assert.equal(observed,true);
 }finally{e.close();}
});

if(process.platform==='win32')test('Windows held profile handle blocks the move, preserves the source and resumes after the handle closes',async()=>{
 const { spawn }=await import('node:child_process');const { once }=await import('node:events');const e=env();let child;
 try{const r=e.instance();await prepare(r,await backup(e.root));const c=await initialize(r);
  const command="$s=[System.IO.File]::Open($env:TADA_TEST_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);[Console]::WriteLine('READY');[Console]::ReadLine()|Out-Null;$s.Dispose()";
  child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,TADA_TEST_LOCK_PATH:join(e.profile,'account.bin')},stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(Error('HOLDER_TIMEOUT')),10000);child.stdout.on('data',b=>{out+=b;if(out.includes('READY')){clearTimeout(timeout);resolve();}});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',code=>{clearTimeout(timeout);if(!out.includes('READY'))reject(Error('HOLDER_EXIT_'+code));});});
  assert.throws(()=>c.beforeReady(),/EPERM|EACCES|EBUSY/u);assert.equal(readFileSync(join(e.profile,'account.bin'),'utf8'),'ORIGINAL_ACCOUNT_BYTES');assert.equal(readFileSync(join(e.data,'original.bin'),'utf8'),'ORIGINAL_RECORD_BYTES');
  const exited=once(child,'exit');child.stdin.end('\n');assert.equal((await exited)[0],0);child=null;(await initialize(e.instance())).beforeReady();assert.equal((await r.context()).restoring,false);
 }finally{if(child){const exited=once(child,'exit');child.stdin.end('\n');await exited;}e.close();}
});
if(process.platform==='win32')for(const target of ['data','profile'])test(`Windows refuses a switch when another SQLite ${target} owner wins the post-check race`,async()=>{
 const {ChatGPTStore}=await import('../../providers/src/chatgpt-store.mjs');const e=env({missing:true});let owner;
 try{
  new ContactStore({directory:e.data,passphrase,route,initialize:true}).close();new ChatGPTStore({directory:e.profile,passphrase}).close();
  const r=e.instance({fault:phase=>{if(phase==='recorded-original'){owner=target==='data'?new ContactStore({directory:e.data,passphrase,route}):new ChatGPTStore({directory:e.profile,passphrase});const held=target==='data'?e.data:e.profile;assert.throws(()=>renameSync(held,held+'.race-test'),/EPERM|EACCES|EBUSY/u);}}});
  await prepare(r,await backup(e.root));const c=await initialize(r);
  // A reopened store may first create WAL/owner metadata; either the tree
  // check or Windows handle exclusion must reject the switch.
  assert.throws(()=>c.beforeReady(),/EPERM|EACCES|EBUSY|ORIGINAL_CHANGED/u);assert.equal(r.status().pending,true);assert.ok(lstatSync(target==='data'?e.data:e.profile).isDirectory());
  owner.close();owner=null;(await initialize(e.instance())).beforeReady();assert.equal((await r.context()).restoring,false);
 }finally{owner?.close();e.close();}
});

for(const phase of ['recorded-original','guarded-data','saved-profile','prepared-barrier-profile','published-barrier-profile','blocked-profile','saved-data','prepared-barrier-data','published-barrier-data','blocked-data','before-pointer','after-pointer'])test(`real SQLite records survive process kill at ${phase} without fingerprinting transient lease journals`,async()=>{
 const {spawnSync}=await import('node:child_process');const {ChatGPTStore}=await import('../../providers/src/chatgpt-store.mjs');
 const e=env({missing:true});try{
  const old=new ContactStore({directory:e.data,passphrase,route,initialize:true}),d=old.addDevice('original');old.submit(d.id,'original-request','원래 기록');old.close();
  new ChatGPTStore({directory:e.profile,passphrase}).close();
  const originalData=readFileSync(join(e.data,'contact.sqlite')),originalProfile=readFileSync(join(e.profile,'account.sqlite'));
  const r=e.instance();await prepare(r,await backup(e.root));
  const script=`import{AppRecords}from ${JSON.stringify(new URL('../src/app-records.mjs',import.meta.url).href)};import{ContactStore}from ${JSON.stringify(new URL('../src/contact-store.mjs',import.meta.url).href)};import{writeSync}from'node:fs';const r=new AppRecords(${JSON.stringify({data:e.data,provider:'chatgpt'})},{protector:{kind:'windows-dpapi-v1',unprotect:async k=>Buffer.from(k)},fault:name=>{if(name===${JSON.stringify(phase)}){writeSync(1,name);process.kill(process.pid,'SIGKILL');}}});const c=await r.context();const s=new ContactStore({directory:c.data,passphrase:${JSON.stringify(passphrase)},route:${JSON.stringify(route)},initialize:true,recovery:c.recovery});s.close();c.publishDirectory();c.beforeReady();`;
  const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
  assert.equal(child.error,undefined);assert.equal(child.stdout,phase,child.stderr);assert.ok(child.signal==='SIGKILL'||child.status!==0);
  const resumed=e.instance();(await initialize(resumed)).beforeReady();const c=await resumed.context();assert.equal(c.restoring,false);
  assert.deepEqual(readFileSync(join(c.data,'..','original','data','contact.sqlite')),originalData);
  assert.deepEqual(readFileSync(join(c.data,'..','original','profile','account.sqlite')),originalProfile);
  const s=new ContactStore({directory:c.data,passphrase,route});assert.equal(s.claim(),null);assert.equal(s.readTurn(1).text,'백업의 대화');s.close();
 }finally{e.close();}
});

test('rebuilding an inactive candidate cannot move a database held by an independent owner',async()=>{
 const e=env();let owner;try{
  const r=e.instance();await prepare(r,await backup(e.root));await initialize(r);
  const c=await r.context(),committed=join(c.data,'..','conversation');
  const candidate=new ContactStore({directory:c.data,passphrase,route,initialize:true,recovery:c.recovery});candidate.close();
  owner=new ContactStore({directory:committed,passphrase,route});assert.throws(()=>c.publishDirectory(),/SOURCE_IN_USE/u);
  owner.close();owner=null;c.publishDirectory();c.beforeReady();assert.equal((await r.context()).restoring,false);
 }finally{owner?.close();e.close();}
});
for(const target of ['data','profile'])test(`linked ${target} lease sidecars are rejected before SQLite acquisition`,async()=>{
 const {linkSync}=await import('node:fs');const {ChatGPTStore}=await import('../../providers/src/chatgpt-store.mjs');
 const e=env({missing:true});try{
  new ContactStore({directory:e.data,passphrase,route,initialize:true}).close();new ChatGPTStore({directory:e.profile,passphrase}).close();
  const r=e.instance();await prepare(r,await backup(e.root));const c=await initialize(r);
  const external=join(e.root,'external');writeFileSync(external,'DO_NOT_CHANGE',{mode:0o600});linkSync(external,join(e[target],'owner.sqlite-journal'));
  assert.throws(()=>c.beforeReady(),/PRIVATE_PATH_REQUIRED/u);assert.equal(readFileSync(external,'utf8'),'DO_NOT_CHANGE');
 }finally{e.close();}
});

if(process.platform!=='win32')test('retiring an inactive candidate cannot unlink a new owner journal at the reused directory path',async()=>{
 const {existsSync}=await import('node:fs');const e=env();let owner,armed=false,committed;
 try{
  const r=e.instance({fault:phase=>{if(phase==='published-candidate'&&armed)owner=new ContactStore({directory:committed,passphrase,route});}});
  await prepare(r,await backup(e.root));await initialize(r);const c=await r.context();committed=join(c.data,'..','conversation');
  const s=new ContactStore({directory:c.data,passphrase,route,initialize:true,recovery:c.recovery});s.close();armed=true;c.publishDirectory();
  assert.equal(existsSync(join(committed,'owner.sqlite-journal')),true);
  owner.close();owner=null;c.beforeReady();assert.equal((await r.context()).restoring,false);
 }finally{owner?.close();e.close();}
});
