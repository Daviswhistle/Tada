// Application-owned record generations. A restore never overwrites a journal or
// puts historical work back into an executable queue. The stable app lease must
// remain owned for this object's lifetime, including account reconnection.
import { lstatSync, mkdirSync, readdirSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readSync, linkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRecordBackup, openRecordBackup, backupSummary, MAX_BACKUP_BYTES } from './contact-backup.mjs';
import { recoveryGroups, validateRecoveryGroups } from './contact-recovery.mjs';
import { windowsProtector } from './contact-key.mjs';
import { parseUniqueJson } from './json.mjs';

export const RESTORE_CONSENT = 'restore_records_with_fresh_connections_v1';
const barrier = Buffer.from('Tada records are preserved in the current application record generation.\n');
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v);
const exact = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const ownerSidecar = name => /^owner\.sqlite-(?:journal|wal|shm)$/u.test(name);
const modelName = v => typeof v==='string' && v.length>0 && v.length<=256 && !/[\x00-\x1f\x7f]/u.test(v);
const fail = (code = 'INVALID') => { throw Error('CONTACT_APP_RECOVERY_' + code); };
function stat(path) { return lstatSync(path, { throwIfNoEntry: false }); }
function owned(path, directory = false, links = 1) {
  const value = stat(path);
  if (!value || value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== links)
      || process.platform !== 'win32' && (value.uid !== process.getuid() || value.mode & 0o077)) fail('PRIVATE_PATH_REQUIRED');
  return value;
}
function parents(path) {
  for(let at=resolve(path);dirname(at)!==at;at=dirname(at)) if(stat(at)?.isSymbolicLink()) fail('PRIVATE_PATH_REQUIRED');
}
function syncDirectory(path) {
  if (process.platform === 'win32') return; // Files are flushed; no power-loss claim for directory rename on Windows.
  const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
function read(path, max, links = 1) {
  const before=owned(path,false,links);if(before.size>max) fail();
  const fd=openSync(path,'r');try{const bytes=readFileSync(fd);if(bytes.length>max) fail();return bytes;}finally{closeSync(fd);}
}
function atomic(path, bytes) {
  if(stat(path)) owned(path);
  const temporary=join(dirname(path),`.record-${randomUUID()}.tmp`);let fd;
  try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path);syncDirectory(dirname(path));}
  finally{if(fd!==undefined)closeSync(fd);if(stat(temporary))unlinkSync(temporary);}
}
function tree(path) {
  const result=[];if(!stat(path))return null;parents(path);owned(path,true);
  const walk=(at,relative,depth)=>{
    if(depth>8||result.length>10000)fail('TOO_LARGE');
    for(const name of readdirSync(at).sort()){
      if(result.length>=10000)fail('TOO_LARGE');
      const child=join(at,name),part=relative?relative+'/'+name:name,s=stat(child);
      if(s?.isDirectory()&&!s.isSymbolicLink()){owned(child,true);result.push([part,'directory']);walk(child,part,depth+1);}
      else{owned(child);if(!relative&&ownerSidecar(name))continue;const hash=createHash('sha256'),fd=openSync(child,'r'),buffer=Buffer.alloc(65536);try{let count;while((count=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count));}finally{closeSync(fd);}result.push([part,s.size,hash.digest('hex')]);}
    }
  };walk(path,'',0);return result;
}
const sameTree=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const isBarrier=path=>{try{return read(path,barrier.length).equals(barrier);}catch{return false;}};

// link() is an exclusive atomic publication, unlike rename() on POSIX. If a
// crash leaves the private preparation name, recognize only that exact inode
// and finish unlinking it before ordinary single-link checks resume.
function finishBarrier(path, prepared) {
  const a=stat(path),b=stat(prepared);
  if(a&&b&&a.dev===b.dev&&a.ino===b.ino&&a.nlink===2&&b.nlink===2){
    if(!read(path,barrier.length,2).equals(barrier)||!read(prepared,barrier.length,2).equals(barrier))fail('ORIGINAL_CHANGED');
    unlinkSync(prepared);syncDirectory(dirname(prepared));syncDirectory(dirname(path));
  }
}
function publishBarrier(path, prepared, fault, kind) {
  if(!stat(prepared))atomic(prepared,barrier);
  if(!isBarrier(prepared))fail('ORIGINAL_CHANGED');
  fault('prepared-barrier-'+kind);linkSync(prepared,path);syncDirectory(dirname(path));
  fault('published-barrier-'+kind);finishBarrier(path,prepared);
}

// Lease sidecars are transient SQLite machinery, not user records. Validate
// their ownership before SQLite touches them, but never fingerprint their bytes.
function sourceOwner(root) {
  if(!stat(root))return null;owned(root,true);
  const path=join(root,'owner.sqlite');
  if(!stat(path)){
    if(stat(join(root,'contact.sqlite'))||stat(join(root,'account.sqlite')))fail('SOURCE_IN_USE');
    return null;
  }
  owned(path);for(const suffix of ['-journal','-wal','-shm'])if(stat(path+suffix))owned(path+suffix);
  const owner=new DatabaseSync(path,{timeout:0});
  try{owner.exec('BEGIN EXCLUSIVE');return owner;}catch{owner.close();fail('SOURCE_IN_USE');}
}

export class AppRecords {
  #options;#root;#protector;#preview=null;#busy=false;#fault;
  constructor(options,{protector,fault=()=>{}}={}){
    this.#options=options;this.#protector=protector;this.#fault=fault;
    const app=resolve(options.data)+'.app-private';parents(app);owned(app,true);
    this.#root=join(app,'records');if(!stat(this.#root))mkdirSync(this.#root,{mode:0o700});owned(this.#root,true);
  }
  get available(){return !this.#options.askPassphrase&&!this.#options.telegram&&!this.#options['chatgpt-profile'];}
  #path(name){return join(this.#root,name);}
  #json(name){const path=this.#path(name);return stat(path)?parseUniqueJson(read(path,262144).toString('utf8'),262144):null;}
  #write(name,value){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>262144)fail('TOO_LARGE');atomic(this.#path(name),bytes);}
  #pending(){
    const p=this.#json('pending.json');if(p===null)return null;
    if(!exact(p,'version,id,phase,previous,original')||p.version!==1||!uuid(p.id)||!['staged','prepared','active'].includes(p.phase)
      || !(p.previous===null||uuid(p.previous)) || !(p.original===null||exact(p.original,'data,profile,guard'))
      || p.original!==null&&(![p.original.data,p.original.profile].every(v=>v===null||Array.isArray(v))||typeof p.original.guard!=='boolean'))fail();
    owned(this.#path(p.id),true);return p;
  }
  #active(){const a=this.#json('active.json');if(a===null)return null;if(!exact(a,'version,id')||a.version!==1||!uuid(a.id))fail();owned(this.#path(a.id),true);return a.id;}
  status(){if(!this.available)return{available:false,pending:false};const p=this.#pending();return{available:true,pending:!!p&&p.phase!=='active'};}
  async preview(bytes,recoveryCode=null){
    if(!this.available)fail('UNAVAILABLE');if(this.#busy||this.#pending()?.phase!=='active'&&this.#pending()!==null)fail('PENDING');
    this.#busy=true;try{
      const snapshot=await openRecordBackup(bytes,{recoveryCode,protector:this.#protector??windowsProtector()});
      validateRecoveryGroups(recoveryGroups(snapshot));
      const provider=snapshot.connection.provider;
      if(provider&&provider.kind!==(this.#options.provider==='chatgpt'?'chatgpt-subscription':'ollama-local'))fail('PROVIDER_MISMATCH');
      this.#preview={id:randomUUID(),snapshot,expires:Date.now()+10*60000};
      return{id:this.#preview.id,...backupSummary(snapshot),new_registration_required:provider?.kind==='chatgpt-subscription'&&!provider.client_id};
    }finally{this.#busy=false;}
  }
  clearPreview(){this.#preview=null;}
  async confirm(id,consent){
    if(consent!==RESTORE_CONSENT)fail('CONSENT_REQUIRED');
    if(this.#busy||!this.#preview||this.#preview.id!==id||this.#preview.expires<Date.now())fail('PREVIEW_EXPIRED');
    const pending=this.#pending();if(pending&&pending.phase!=='active')fail('PENDING');
    this.#busy=true;try{
      const archive=await createRecordBackup(this.#preview.snapshot,{protector:this.#protector??windowsProtector()});
      const generation=randomUUID(),directory=this.#path(generation);mkdirSync(directory,{mode:0o700});
      atomic(join(directory,'snapshot.tadabackup'),archive.bytes);
      this.#write('pending.json',{version:1,id:generation,phase:'staged',previous:this.#active(),original:null});
      this.#preview=null;return{pending:true};
    }finally{this.#busy=false;}
  }
  canCancel(){const p=this.#pending();return !!p&&p.phase==='staged'&&p.original===null&&this.#active()===p.previous;}
  cancel(){
    if(this.#busy)fail('PENDING');const p=this.#pending();
    if(!p||p.phase!=='staged'||p.original!==null||this.#active()!==p.previous)fail('CANNOT_CANCEL');
    const target=join(this.#path(p.id),'cancelled.json');if(stat(target))fail();
    renameSync(this.#path('pending.json'),target);syncDirectory(this.#root);syncDirectory(dirname(target));
  }
  async context(){
    const pending=this.#pending(),active=this.#active();
    if((pending||active)&&!this.available)fail('UNAVAILABLE');
    if(pending?.phase==='active'&&active!==pending.id)fail();
    const restoring=pending&&pending.phase!=='active',id=restoring?pending.id:active;
    if(!id)return null;
    const root=this.#path(id);owned(root,true);
    const snapshot=await openRecordBackup(read(join(root,'snapshot.tadabackup'),MAX_BACKUP_BYTES+17000),{protector:this.#protector??windowsProtector()});
    validateRecoveryGroups(recoveryGroups(snapshot));
    const provider=snapshot.connection.provider;
    if(provider&&provider.kind!==(this.#options.provider==='chatgpt'?'chatgpt-subscription':'ollama-local'))fail('PROVIDER_MISMATCH');
    const committed=join(root,'conversation'),profile=this.#options.provider==='chatgpt'?join(root,'profile'):undefined;
    const present=!!stat(join(committed,'contact.sqlite'));
    if(!present&&(!restoring||stat(committed)))fail('ACTIVE_MISSING');
    // Until activation succeeds, no work may run in this database. Rebuild a
    // fresh candidate on retry so changed model/catalog routes cannot trap it.
    const initialized=present&&!restoring;
    // A killed initialization can leave a partial SQLite directory. Build a new
    // isolated candidate each time and publish only after its store is closed.
    const data=initialized?committed:join(root,'initializing-'+randomUUID());
    const choice=this.#json(id+'/model-choice.json');
    if(choice!==null && (!exact(choice,'version,requested,selected') || choice.version!==1
      || !(choice.requested===null||modelName(choice.requested)) || !modelName(choice.selected)))fail();
    return{data,profile,keyProfile:join(root,'profile'),initialize:!initialized,recovery:initialized?null:snapshot,
      publishDirectory:initialized?null:()=>{
        const current=this.#pending();if(!current||current.id!==id||current.phase==='active')fail();
        owned(data,true);let owner;
        try{
          if(stat(committed)){
            owner=sourceOwner(committed);
            if(process.platform==='win32'){owner?.close();owner=null;}
            renameSync(committed,join(root,'prepared-'+randomUUID()));syncDirectory(root);
            // SQLite closes its journal by the old pathname. Finish that close
            // before a new database can acquire a lease at the reused path.
            owner?.close();owner=null;
          }
          renameSync(data,committed);syncDirectory(root);this.#fault('published-candidate');return committed;
        }finally{owner?.close();}
      },
      expectedClient:provider?.client_id??null,expectedLabel:provider?.label??null,expectedSubject:provider?.kind==='chatgpt-subscription'?provider.subject:null,model:provider?.model??null,
      modelChoice:choice?.requested===(this.#options.model??null)?choice.selected:null,
      saveModelChoice:restoring?selected=>{
        const current=this.#pending();if(!modelName(selected)||!current||current.id!==id||current.phase==='active')fail();
        this.#write(id+'/model-choice.json',{version:1,requested:this.#options.model??null,selected});
      }:null,
      googleClient:initialized?null:snapshot.connection.google_client,restoring:!!restoring,
      beforeReady:()=>{if(restoring)this.activate(id);else this.#verifyBarriers();}};
  }
  #originalPaths(){const data=resolve(this.#options.data);return{data,profile:data+(this.#options.provider==='chatgpt'?'.chatgpt-private':'.key-private')};}
  #verifyBarriers(){for(const path of Object.values(this.#originalPaths()))if(!isBarrier(path))fail('BARRIER_CHANGED');}
  activate(id){
    const p=this.#pending();if(!p||p.id!==id)fail();
    if(p.phase==='active'){this.#verifyBarriers();return;}
    const paths=this.#originalPaths(),destination=this.#path(id),archive=join(destination,'original');
    for(const kind of ['profile','data'])finishBarrier(paths[kind],join(destination,'barrier-'+kind));
    const roots=p.previous?[join(this.#path(p.previous),'profile'),join(this.#path(p.previous),'conversation')]
      :Object.entries(paths).map(([kind,path])=>stat(path)?.isDirectory()?path:join(archive,kind));
    const owners=[];
    const release=()=>{for(const owner of owners.splice(0))owner.close();};
    try{
      for(const root of roots){const owner=sourceOwner(root);if(owner)owners.push(owner);}
      // Windows forbids moving any source with an open SQLite handle. Check
      // both leases first, then let exclusive rename admission enforce races.
      // POSIX permits rename of open files, so retain its locks through commit.
      if(process.platform==='win32'&&!p.previous)release();
      return this.#activateOwned(p,paths,destination,archive);
    }finally{release();}
  }
  #activateOwned(p,paths,destination,archive){
    const id=p.id;
    if(p.previous){
      if(![p.previous,id].includes(this.#active()))fail();this.#verifyBarriers();
    }else{
      if(p.original===null){
        // Old account/SQLite handles have already been drained and closed by setup.
        parents(paths.data);parents(paths.profile);
        const data=tree(paths.data),profile=tree(paths.profile);
        if([paths.data,paths.profile].some(path=>stat(path)&&stat(path).dev!==stat(destination).dev))fail('DIFFERENT_VOLUME');
        p.original={data,profile,guard:data===null};this.#write('pending.json',p);this.#fault('recorded-original');
      }
      if(!stat(archive))mkdirSync(archive,{mode:0o700});owned(archive,true);
      // A missing default data directory would make old launchers add --init.
      // Keep an owned guard there until the old profile path is blocked by a file.
      if(p.original.guard&&!isBarrier(paths.profile)&&!stat(paths.data)){
        // Never reuse a candidate that could contain a killed atomic write.
        // Incomplete candidates stay private; only a complete guard is moved.
        const guard=join(destination,'guard-pending-'+randomUUID());mkdirSync(guard,{mode:0o700});owned(guard,true);
        this.#fault('preparing-guard');
        atomic(join(guard,'tada-recovery-guard'),Buffer.from(id));renameSync(guard,paths.data);syncDirectory(dirname(paths.data));
      }
      this.#fault('guarded-data');
      for(const kind of ['profile','data']){
        const original=paths[kind],saved=join(archive,kind),expected=p.original[kind];
        if(isBarrier(original)){
          if(expected!==null&&!sameTree(tree(saved),expected))fail('ORIGINAL_CHANGED');
          continue;
        }
        if(stat(saved)){
          if(stat(original)||!sameTree(tree(saved),expected))fail('ORIGINAL_CHANGED');
        }else if(expected!==null){
          if(!sameTree(tree(original),expected))fail('ORIGINAL_CHANGED');
          renameSync(original,saved);syncDirectory(dirname(original));syncDirectory(archive);
          if(!sameTree(tree(saved),expected))fail('ORIGINAL_CHANGED');
        }else if(stat(original)){
          if(kind!=='data'||!p.original.guard||readdirSync(original).join(',')!=='tada-recovery-guard'||read(join(original,'tada-recovery-guard'),64).toString()!==id)fail('ORIGINAL_CHANGED');
          // Preserve even the generated guard; never remove a user directory.
          renameSync(original,join(archive,'guard'));syncDirectory(dirname(original));syncDirectory(archive);
        }
        this.#fault('saved-'+kind);
        publishBarrier(original,join(destination,'barrier-'+kind),this.#fault,kind);
        this.#fault('blocked-'+kind);
      }
      this.#verifyBarriers();
    }
    p.phase='prepared';this.#write('pending.json',p);this.#fault('before-pointer');
    this.#write('active.json',{version:1,id});this.#fault('after-pointer');
    p.phase='active';this.#write('pending.json',p);
  }
}
