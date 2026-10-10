import test from 'node:test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,existsSync,symlinkSync,linkSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppPrivacy,ERASE_CONSENT } from '../src/app-privacy.mjs';
import { ContactStore,contactRoute } from '../src/contact-store.mjs';
import { AppRecords,RESTORE_CONSENT } from '../src/app-records.mjs';
import { createRecordBackup } from '../src/contact-backup.mjs';
const protector={kind:'windows-dpapi-v1',protect:async k=>Buffer.from(k),unprotect:async k=>Buffer.from(k)};
const passphrase='SYNTHETIC_PRIVACY_KEY_ONLY',route=contactRoute({fixture:'privacy'});
function env(){
 const root=mkdtempSync(join(tmpdir(),'tada-privacy-')),data=join(root,'conversation'),profile=data+'.chatgpt-private';
 mkdirSync(data+'.app-private',{mode:0o700});mkdirSync(profile,{mode:0o700});
 for(const name of ['owner.sqlite','account.sqlite','storage-key.sqlite'])writeFileSync(join(profile,name),'',{mode:0o600});
 const store=new ContactStore({directory:data,passphrase,route,initialize:true,mail:true}),d=store.addDevice('old');store.submit(d.id,randomUUID(),'SYNTHETIC PRIVATE TEXT');store.close();
 const options={data,provider:'chatgpt'},instance=extra=>new AppPrivacy(options,extra);
 return{root,data,profile,options,instance,close:()=>rmSync(root,{recursive:true,force:true})};
}
function complete(e,p=e.instance()){p.begin(randomUUID(),ERASE_CONSENT);p.erase();return p;}
test('local clear removes exact owned records and keys, blocks old starts and needs explicit fresh start',()=>{
 const e=env();try{
  const p=complete(e);assert.equal(p.status().phase,'done');assert.equal(readdirSync(e.data+'.app-private').some(n=>n.startsWith('erasing-')),false);
  assert.throws(()=>new ContactStore({directory:e.data,passphrase,route,initialize:true}));
  assert.equal(p.fresh().phase,'new');assert.equal(existsSync(e.data),false);assert.equal(existsSync(e.profile),false);
  const fresh=new ContactStore({directory:e.data,passphrase,route,initialize:true});assert.equal(fresh.page().turns.length,0);p.completeFresh(p.status().request);assert.equal(p.status().phase,null);fresh.close();
 }finally{e.close();}
});
test('consent and unknown files are rejected before deletion intent; user file remains',()=>{
 const e=env();try{const p=e.instance();assert.throws(()=>p.begin(randomUUID(),'bad'),/CONSENT_REQUIRED/u);writeFileSync(join(e.data,'my-notes.txt'),'KEEP',{mode:0o600});assert.throws(()=>p.begin(randomUUID(),ERASE_CONSENT),/UNKNOWN_FILES/u);assert.equal(p.status().phase,null);assert.equal(readFileSync(join(e.data,'my-notes.txt'),'utf8'),'KEEP');}finally{e.close();}
});
test('active source owner blocks deletion and explicit retry succeeds after it closes',()=>{
 const e=env();let store;try{const p=e.instance();p.begin(randomUUID(),ERASE_CONSENT);store=new ContactStore({directory:e.data,passphrase,route});assert.throws(()=>p.erase(),/IN_USE/u);assert.equal(p.status().phase,'requested');assert.equal(existsSync(join(e.data,'contact.sqlite')),true);store.close();store=null;p.erase();assert.equal(p.status().phase,'done');}finally{store?.close();e.close();}
});
for(const phase of ['requested','planned','moved-data','opened-guard-data','prepared-guard-data','published-guard-data','guarded-data','moved-profile','guarded-profile','guarded-localkey','guarded-records','quarantined','deleted-entry','removed-quarantine','done','fresh','fresh-data','fresh-profile','fresh-localkey','fresh-ready'])test('interrupted clear resumes at '+phase,()=>{
 const e=env();try{
  let fired=false;const p=e.instance({fault:name=>{if(name===phase&&!fired){fired=true;throw Error('SIMULATED_CRASH');}}});
  assert.throws(()=>{complete(e,p);p.fresh();},/SIMULATED_CRASH/u);assert.equal(fired,true);
  // AppRecords creates this empty root during startup, even while erase is blocked.
  new AppRecords(e.options,{protector});
  const resumed=e.instance();if(!['done','fresh','new'].includes(resumed.status().phase))resumed.erase();resumed.fresh();assert.equal(existsSync(e.data),false);assert.equal(existsSync(e.profile),false);
 }finally{e.close();}
});
test('changed quarantined file stops further deletion and preserves its bytes',()=>{
 const e=env();try{const p=e.instance({fault:name=>{if(name==='quarantined')throw Error('SIMULATED_CRASH');}});p.begin(randomUUID(),ERASE_CONSENT);assert.throws(()=>p.erase(),/SIMULATED_CRASH/u);
 const dir=join(e.data+'.app-private',readdirSync(e.data+'.app-private').find(n=>n.startsWith('erasing-'))),file=join(dir,'data','contact.sqlite');writeFileSync(file,'CHANGED',{mode:0o600});assert.throws(()=>e.instance().erase(),/CHANGED/u);assert.equal(readFileSync(file,'utf8'),'CHANGED');assert.equal(existsSync(join(dir,'profile','account.sqlite')),true);
 }finally{e.close();}
});
test('restored, original, canceled and partial generations are included in clear',async()=>{
 const e=env();try{
  const original=new ContactStore({directory:e.data,passphrase,route}),snapshot=original.exportRecords(original.addDevice('backup').id,{provider:null,google_client:null});original.close();
  const records=new AppRecords(e.options,{protector}),archive=await createRecordBackup(snapshot,{protector});let preview=await records.preview(archive.bytes);await records.confirm(preview.id,RESTORE_CONSENT);
  const c=await records.context(),store=new ContactStore({directory:c.data,passphrase,route,initialize:true,recovery:c.recovery});store.close();c.publishDirectory();c.beforeReady();
  preview=await records.preview(archive.bytes);await records.confirm(preview.id,RESTORE_CONSENT);const partial=await records.context();mkdirSync(partial.data,{mode:0o700});writeFileSync(join(partial.data,'owner.sqlite'),'',{mode:0o600});writeFileSync(join(partial.data,'contact.sqlite'),'PARTIAL',{mode:0o600});records.cancel();
  const p=complete(e);assert.equal(p.status().phase,'done');new AppRecords(e.options,{protector});p.fresh();assert.equal(readdirSync(e.data+'.app-private/records').length,0);
 }finally{e.close();}
});
test('metadata cannot name paths outside known storage roots',()=>{
 const e=env();try{const p=e.instance({fault:name=>{if(name==='planned')throw Error('SIMULATED_CRASH');}});p.begin(randomUUID(),ERASE_CONSENT);assert.throws(()=>p.erase(),/SIMULATED_CRASH/u);const path=e.data+'.app-private/erasure.json',v=JSON.parse(readFileSync(path));v.plan.data.push(['../outside','f',1,'a'.repeat(64)]);writeFileSync(path,JSON.stringify(v));assert.throws(()=>e.instance().erase(),/ERASE_INVALID/u);}finally{e.close();}
});
test('linked record paths are never followed',{skip:process.platform==='win32'},()=>{
 const e=env();try{const outside=join(e.root,'outside');writeFileSync(outside,'KEEP',{mode:0o600});symlinkSync(outside,join(e.data,'google-oauth-client.enc'));assert.throws(()=>e.instance().begin(randomUUID(),ERASE_CONSENT),/PRIVATE_PATH/u);assert.equal(readFileSync(outside,'utf8'),'KEEP');}finally{e.close();}
});

for(const phase of ['planned','moved-data','opened-guard-data','prepared-guard-data','published-guard-data','guarded-data','moved-profile','guarded-profile','guarded-localkey','quarantined','deleted-entry','removed-quarantine'])test('real process kill preserves deletion recovery at '+phase,async()=>{
 const e=env();try{
  const script=`import{AppPrivacy,ERASE_CONSENT}from ${JSON.stringify(new URL('../src/app-privacy.mjs',import.meta.url).href)};import{randomUUID}from'node:crypto';import{writeSync}from'node:fs';const p=new AppPrivacy(${JSON.stringify(e.options)},{fault:name=>{if(name===${JSON.stringify(phase)}){writeSync(1,'REACHED');process.kill(process.pid,'SIGKILL');}}});p.begin(randomUUID(),ERASE_CONSENT);p.erase();`;
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CHILD_TIMEOUT'));},20000);child.once('error',reject);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  assert.equal(out,'REACHED',err);assert.notEqual(result.code,0);new AppRecords(e.options,{protector});const p=e.instance();p.erase();assert.equal(p.status().phase,'done');p.fresh();assert.equal(existsSync(e.data),false);
 }finally{e.close();}
});

test('POSIX retains quarantined ownership through removal',{skip:process.platform==='win32'},()=>{
 const e=env();try{let checked=false;const p=e.instance({fault:phase=>{if(phase!=='deleted-entry'||checked)return;checked=true;const base=join(e.data+'.app-private','erasing-'+p.status().request,'profile','owner.sqlite');const contender=new DatabaseSync(base,{timeout:0});try{assert.throws(()=>contender.exec('BEGIN EXCLUSIVE'),/locked/u);}finally{contender.close();}}});complete(e,p);assert.equal(checked,true);}finally{e.close();}
});

test('a source owner racing the move is excluded by its lease or native rename admission',()=>{
 const e=env();let contender;try{let checked=false;const p=e.instance({fault:phase=>{if(phase!=='before-move-data'||checked)return;checked=true;contender=new DatabaseSync(join(e.data,'owner.sqlite'),{timeout:0});if(process.platform==='win32')contender.exec('BEGIN EXCLUSIVE');else{assert.throws(()=>contender.exec('BEGIN EXCLUSIVE'),/locked/u);contender.close();contender=null;}}});p.begin(randomUUID(),ERASE_CONSENT);
 if(process.platform==='win32'){assert.throws(()=>p.erase(),/EPERM|EACCES|EBUSY/u);assert.equal(existsSync(join(e.data,'contact.sqlite')),true);contender.close();contender=null;e.instance().erase();}else p.erase();assert.equal(checked,true);assert.equal(e.instance().status().phase,'done');
 }finally{contender?.close();e.close();}
});

for(const phase of ['published-barrier-profile','published-barrier-data'])test('clear accepts only the real interrupted recovery barrier pair at '+phase,async()=>{
 const e=env();try{
  const store=new ContactStore({directory:e.data,passphrase,route}),snapshot=store.exportRecords(store.addDevice('backup').id,{provider:null,google_client:null});store.close();
  const records=new AppRecords(e.options,{protector,fault:name=>{if(name===phase)throw Error('SIMULATED_RESTORE_CRASH');}}),archive=await createRecordBackup(snapshot,{protector}),preview=await records.preview(archive.bytes);await records.confirm(preview.id,RESTORE_CONSENT);
  const c=await records.context(),fresh=new ContactStore({directory:c.data,passphrase,route,initialize:true,recovery:c.recovery});fresh.close();c.publishDirectory();assert.throws(()=>c.beforeReady(),/SIMULATED_RESTORE_CRASH/u);
  assert.equal(lstatSync(phase.endsWith('profile')?e.profile:e.data).nlink,2);const p=complete(e);assert.equal(p.status().phase,'done');
 }finally{e.close();}
});
test('the same AppRecords instance can stage another backup after clear and fresh startup',async()=>{
 const e=env();try{
  const records=new AppRecords(e.options,{protector}),s=new ContactStore({directory:e.data,passphrase,route}),snapshot=s.exportRecords(s.addDevice('backup').id,{provider:null,google_client:null});s.close();const archive=await createRecordBackup(snapshot,{protector});
  const p=complete(e);p.fresh();const fresh=new ContactStore({directory:e.data,passphrase,route,initialize:true});p.completeFresh(p.status().request);fresh.close();
  const preview=await records.preview(archive.bytes);await records.confirm(preview.id,RESTORE_CONSENT);assert.equal(records.status().pending,true);
 }finally{e.close();}
});
test('fresh permission remains durable until ready and cannot clear a later erase intent',()=>{
 const e=env();try{const p=complete(e);p.fresh();const id=p.status().request;assert.equal(e.instance().status().phase,'new');assert.throws(()=>p.completeFresh(id));p.begin(randomUUID(),ERASE_CONSENT);assert.throws(()=>p.completeFresh(id),/PENDING/u);assert.equal(p.status().phase,'requested');}finally{e.close();}
});
for(const outside of [false,true])test('interrupted Google publication is accepted only with its owned in-scope twin: outside='+outside,async()=>{
 const {saveGoogleClientConfig}=await import('../src/google-client-config.mjs');const e=env();try{
  saveGoogleClientConfig({data:e.data,passphrase,route,client:{client_id:'123456-test.apps.googleusercontent.com',client_secret:'GOCSPX-fixture-only'}});
  const primary=join(e.data,'google-oauth-client.enc'),twin=outside?join(e.root,'outside-copy'):join(e.data,'.google-oauth-client-'+randomUUID()+'.tmp');linkSync(primary,twin);const before=readFileSync(primary);
  if(outside){assert.throws(()=>e.instance().begin(randomUUID(),ERASE_CONSENT),/PRIVATE_PATH_REQUIRED/u);assert.deepEqual(readFileSync(twin),before);}else assert.equal(complete(e).status().phase,'done');
 }finally{e.close();}
});
