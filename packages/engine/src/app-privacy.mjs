// Owner-confirmed deletion for the normal app's exact local storage roots.
// The stable app lease stays held. No external account revocation is implied.
import { lstatSync, readdirSync, mkdirSync, readFileSync, openSync, closeSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync, rmdirSync, linkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseUniqueArchiveJson } from './json.mjs';
export const ERASE_CONSENT='erase_local_records_and_connections_v1';
const guard=Buffer.from('Tada local records were removed. Start fresh from the owner setup window.\n');
const oldGuard=Buffer.from('Tada records are preserved in the current application record generation.\n');
const idPattern='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const uuid=v=>typeof v==='string'&&new RegExp('^'+idPattern+'$','u').test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const fail=(code='INVALID')=>{throw Error('CONTACT_APP_ERASE_'+code);};
const stat=p=>lstatSync(p,{throwIfNoEntry:false});
function owned(p,directory=false,links=1){const s=stat(p);if(!s||s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()||s.nlink!==links)||process.platform!=='win32'&&(s.uid!==process.getuid()||s.mode&0o077))fail('PRIVATE_PATH_REQUIRED');return s;}
function parents(p){for(let at=resolve(p);dirname(at)!==at;at=dirname(at))if(stat(at)?.isSymbolicLink())fail('PRIVATE_PATH_REQUIRED');}
function sync(p){if(process.platform==='win32')return;const fd=openSync(p,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(p,value){const tmp=join(dirname(p),'.erase-'+randomUUID()+'.tmp');let fd;try{if(stat(p))owned(p);fd=openSync(tmp,'wx',0o600);writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,p);sync(dirname(p));}finally{if(fd!==undefined)closeSync(fd);if(stat(tmp))unlinkSync(tmp);}}
function hash(p,links=1){owned(p,false,links);const h=createHash('sha256'),fd=openSync(p,'r'),b=Buffer.alloc(65536);try{let n;while((n=readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex');}finally{closeSync(fd);}}
function matches(p,bytes,links=1){try{return owned(p,false,links).size===bytes.length&&readFileSync(p).equals(bytes);}catch{return false;}}
const lease=n=>/^owner\.sqlite-(journal|wal|shm)$/u.test(n);
const sqlite=n=>/^(owner|account|storage-key|contact)\.sqlite(?:-(journal|wal|shm))?$/u.test(n);
const temp=(name,prefix)=>new RegExp('^'+prefix+idPattern+'\\.tmp$','u').test(name);
function childType(type,name){
 if(type==='data')return /^(owner|contact)\.sqlite(?:-(journal|wal|shm))?$/u.test(name)||new RegExp('^before-(messaging|reviews|followups|assistance|mail)-'+idPattern+'\\.sqlite(?:-(journal|wal|shm))?$','u').test(name)||name==='google-oauth-client.enc'||name==='tada-recovery-guard'||temp(name,'\\.google-oauth-client-')||temp(name,'\\.record-')?'file':null;
 if(type==='profile')return sqlite(name)&&!/^(contact)\./u.test(name)?'file':null;
 if(type==='records')return ['active.json','pending.json'].includes(name)||temp(name,'\\.record-')?'file':uuid(name)?'generation':null;
 if(type==='generation'){
  if(['snapshot.tadabackup','model-choice.json','cancelled.json','barrier-data','barrier-profile'].includes(name)||temp(name,'\\.record-'))return'file';
  if(name==='profile')return'profile';if(name==='conversation'||new RegExp('^(initializing|prepared|guard-pending)-'+idPattern+'$','u').test(name))return'data';if(name==='original')return'original';
 }
 if(type==='original')return name==='profile'?'profile':['data','guard'].includes(name)?'data':null;
 return null;
}
function googleLinks(path){
 const s=stat(path);if(s?.nlink!==2)return 1;
 const root=dirname(path),primary=join(root,'google-oauth-client.enc'),a=stat(primary);
 if(!a||a.nlink!==2||a.dev!==s.dev||a.ino!==s.ino)return 1;
 const peers=readdirSync(root).filter(n=>temp(n,'\\.google-oauth-client-')).filter(n=>{const b=stat(join(root,n));return b?.nlink===2&&b.dev===a.dev&&b.ino===a.ino;});
 if(peers.length!==1)return 1;owned(primary,false,2);owned(join(root,peers[0]),false,2);return 2;
}
function inventory(root,type){
 if(!stat(root))return null;parents(root);
 if(!stat(root).isDirectory()){
  if(type==='records'||!matches(root,oldGuard)&&!matches(root,guard))fail('UNKNOWN_FILES');
  return [['','f',stat(root).size,hash(root)]];
 }
 owned(root,true);const rows=[['','d']],walk=(p,t,rel,depth)=>{
  if(depth>8)fail('TOO_LARGE');
  for(const name of readdirSync(p).sort()){
   if(rows.length>=10000)fail('TOO_LARGE');const kind=childType(t,name);if(!kind)fail('UNKNOWN_FILES');
   const at=join(p,name),part=rel?rel+'/'+name:name;
   if(kind==='file'){const links=t==='data'?googleLinks(at):1,s=owned(at,false,links);rows.push([part,lease(name)?'l':'f',s.size,lease(name)?null:hash(at,links)]);}
   else{owned(at,true);rows.push([part,'d']);walk(at,kind,part,depth+1);}
  }
 };walk(root,type,'',0);return rows;
}
const canonical=rows=>rows?.filter(r=>r[1]!=='l');
const identical=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function subset(actual,expected){
 if(actual===null)return true;if(expected===null)return false;
 const byPath=new Map(expected.map(r=>[r[0],r]));
 return actual.every(row=>row[1]==='l'||JSON.stringify(row)===JSON.stringify(byPath.get(row[0])));
}
function lock(root,rows){
 const locks=[];try{
  for(const row of rows??[]){
   if(row[1]!=='f'||!/(^|\/)owner\.sqlite$/u.test(row[0]))continue;
   const p=join(root,row[0]);owned(p);for(const s of ['-journal','-wal','-shm'])if(stat(p+s))owned(p+s);
   const db=new DatabaseSync(p,{timeout:0});try{db.exec('BEGIN EXCLUSIVE');locks.push(db);}catch{db.close();fail('IN_USE');}
  }
  for(const row of rows??[])if(row[1]==='f'&&/(^|\/)(contact|account)\.sqlite$/u.test(row[0])&&!rows.some(r=>r[0]===(row[0].includes('/')?row[0].slice(0,row[0].lastIndexOf('/')+1):'')+'owner.sqlite'))fail('IN_USE');
  return locks;
 }catch(e){for(const db of locks)db.close();throw e;}
}
const guardName=name=>new RegExp('^guard-(data|profile|localkey)-'+idPattern+'$','u').test(name);
function finishBarriers(directory,sources){
 for(const name of readdirSync(directory).filter(guardName)){
  const kind=name.split('-')[1],prepared=join(directory,name),path=sources[kind].path,a=stat(path),b=stat(prepared);
  if(a&&b&&a.dev===b.dev&&a.ino===b.ino&&a.nlink===2&&b.nlink===2){
   if(!matches(path,guard,2)||!matches(prepared,guard,2))fail('CHANGED');unlinkSync(prepared);sync(directory);sync(dirname(path));
  }else owned(prepared);
 }
}
function barrier(path,directory,kind,fault){
 if(stat(path)){if(!matches(path,guard))fail('CHANGED');return;}
 // A killed preparation may be partial. Preserve it and use a fresh candidate.
 const prepared=join(directory,'guard-'+kind+'-'+randomUUID()),fd=openSync(prepared,'wx',0o600);
 try{fault('opened-guard-'+kind);writeFileSync(fd,guard);fsyncSync(fd);}finally{closeSync(fd);}
 fault('prepared-guard-'+kind);linkSync(prepared,path);sync(dirname(path));fault('published-guard-'+kind);unlinkSync(prepared);sync(directory);
}
export class AppPrivacy {
 #root;#path;#sources;#available;#fault;
 constructor(options,{fault=()=>{}}={}){
  const data=resolve(options.data);this.#root=data+'.app-private';parents(this.#root);owned(this.#root,true);
  this.#path=join(this.#root,'erasure.json');this.#sources={data:{path:data,type:'data'},profile:{path:data+'.chatgpt-private',type:'profile'},localkey:{path:data+'.key-private',type:'profile'},records:{path:join(this.#root,'records'),type:'records'}};
  this.#available=!options.askPassphrase&&!options.telegram&&!options['chatgpt-profile'];this.#fault=fault;
 }
 get available(){return this.#available;}
 #read(){
  if(!stat(this.#path))return null;const s=owned(this.#path);if(s.size>4*1024*1024)fail();
  const v=parseUniqueArchiveJson(readFileSync(this.#path,'utf8'),4*1024*1024);
  if(!exact(v,'version,id,phase,plan')||v.version!==1||!uuid(v.id)||!['requested','moving','deleting','done','fresh','new'].includes(v.phase))fail();
  if(['moving','deleting'].includes(v.phase)){
   if(!exact(v.plan,'data,profile,localkey,records'))fail();
   for(const [key,rows]of Object.entries(v.plan)){
    if(rows===null)continue;if(!Array.isArray(rows)||rows.length>10000)fail();const seen=new Set();
    for(const r of rows){
     if(!Array.isArray(r)||typeof r[0]!=='string'||seen.has(r[0])||r[0].length>1024)fail();seen.add(r[0]);
     let type=this.#sources[key].type;for(const part of r[0]?r[0].split('/'):[]){type=childType(type,part);if(!type)fail();}
     if(r[1]==='d'){if(r.length!==2||type==='file')fail();}
     else if(r[1]==='f'||r[1]==='l'){if(r.length!==4||r[0]!==''&&type!=='file'||!Number.isSafeInteger(r[2])||r[2]<0||(r[1]==='l'?r[3]!==null||!lease(r[0].split('/').at(-1)):typeof r[3]!=='string'||!/^[a-f0-9]{64}$/u.test(r[3])))fail();}
     else fail();
    }
   }
  }else if(v.plan!==null)fail();
  return v;
 }
 #write(v){if(Buffer.byteLength(JSON.stringify(v))>4*1024*1024)fail('TOO_LARGE');atomic(this.#path,v);}
 #directory(v){return join(this.#root,'erasing-'+v.id);}
 status(){const v=this.#read();return{available:this.available,phase:v?.phase??null,request:v?.id??null};}
 begin(id,consent){
  if(!this.available)fail('UNAVAILABLE');if(consent!==ERASE_CONSENT||!uuid(id))fail('CONSENT_REQUIRED');if(this.#read() && this.#read().phase!=='new')fail('PENDING');
  this.#settleRecoveryBarriers();
  for(const source of Object.values(this.#sources))inventory(source.path,source.type);
  this.#write({version:1,id,phase:'requested',plan:null});this.#fault('requested');
 }
 erase(){
  let v=this.#read();if(!v||!this.available||['done','fresh','new'].includes(v.phase))fail();
  const directory=this.#directory(v);if(!stat(directory))mkdirSync(directory,{mode:0o700});owned(directory,true);finishBarriers(directory,this.#sources);
  const owners=[];const release=()=>{let failure;for(const db of owners.splice(0))try{db.close();}catch(e){failure??=e;}if(failure)throw failure;};
  try{
   for(const [key,source]of Object.entries(this.#sources))for(const root of [source.path,join(directory,key)]){
    const rows=inventory(root,source.type);owners.push(...lock(root,rows));
   }
   if(v.phase==='requested'){
    v={...v,phase:'moving',plan:Object.fromEntries(Object.entries(this.#sources).map(([key,s])=>[key,inventory(s.path,s.type)]))};this.#write(v);this.#fault('planned');
   }
   if(v.phase==='moving'){
    // Native Windows excludes a racing open SQLite owner at directory rename.
    if(process.platform==='win32')release();
    for(const [key,source]of Object.entries(this.#sources)){
     const saved=join(directory,key),expected=v.plan[key];
     if(stat(saved)){
      if(!identical(inventory(saved,source.type),expected))fail('CHANGED');
      if(key==='records'&&stat(source.path)){if(!identical(inventory(source.path,source.type),[['','d']]))fail('CHANGED');rmdirSync(source.path);}
      else if(stat(source.path)&&!matches(source.path,guard))fail('CHANGED');
     }else if(expected!==null){
      if(!identical(inventory(source.path,source.type),expected))fail('CHANGED');
      this.#fault('before-move-'+key);renameSync(source.path,saved);sync(dirname(source.path));sync(directory);this.#fault('moved-'+key);
     }else if(stat(source.path)&&!(key!=='records'&&matches(source.path,guard))){
      if(key!=='records'||!identical(inventory(source.path,source.type),[['','d']]))fail('CHANGED');rmdirSync(source.path);
     }
     if(key!=='records')barrier(source.path,directory,key,this.#fault);this.#fault('guarded-'+key);
    }
    v={...v,phase:'deleting'};this.#write(v);this.#fault('quarantined');
   }
  }catch(error){release();throw error;}
  if(process.platform==='win32')release();
  try{
  // Validate all remaining targets before removing any file. Never rm -r.
  const remaining=[];
  for(const [key,source]of Object.entries(this.#sources)){
   if(key!=='records'&&!matches(source.path,guard))fail('CHANGED');
   if(key==='records'&&stat(source.path)&&!identical(inventory(source.path,source.type),[['','d']]))fail('CHANGED');
   const root=join(directory,key),rows=inventory(root,source.type);if(!subset(rows,v.plan[key]))fail('CHANGED');remaining.push({root,rows});
  }
  const allowed=new Set(Object.keys(this.#sources));const guards=readdirSync(directory).filter(guardName);if(readdirSync(directory).some(n=>!allowed.has(n)&&!guardName(n)))fail('CHANGED');for(const name of guards)owned(join(directory,name));
  for(const {root,rows}of remaining)for(const row of [...rows??[]].sort((a,b)=>{const rank=r=>r[1]==='d'?2:/(^|\/)owner\.sqlite$/u.test(r[0])?1:0;return rank(a)-rank(b)||b[0].split('/').length-a[0].split('/').length||(a[0]===''?1:b[0]===''?-1:0);})){
   const path=row[0]?join(root,row[0]):root;
   if(row[1]==='d'){owned(path,true);rmdirSync(path);}else{const links=googleLinks(path);owned(path,false,links);if(row[1]==='f'&&(stat(path).size!==row[2]||hash(path,links)!==row[3]))fail('CHANGED');unlinkSync(path);}
   sync(dirname(path));this.#fault('deleted-entry');
  }
  for(const name of guards){owned(join(directory,name));unlinkSync(join(directory,name));}rmdirSync(directory);sync(this.#root);this.#fault('removed-quarantine');this.#write({...v,phase:'done',plan:null});this.#fault('done');return this.status();
  }finally{release();}
 }
 #settleRecoveryBarriers(){
  const root=this.#sources.records.path;if(!stat(root))return;owned(root,true);
  for(const name of readdirSync(root).filter(uuid)){
   const generation=join(root,name);owned(generation,true);
   for(const [kind,targets]of [['data',[this.#sources.data.path]],['profile',[this.#sources.profile.path,this.#sources.localkey.path]]]){
    const prepared=join(generation,'barrier-'+kind),b=stat(prepared);if(!b||b.nlink!==2)continue;
    for(const path of targets){const a=stat(path);if(a&&a.dev===b.dev&&a.ino===b.ino&&a.nlink===2){
     if(!matches(path,oldGuard,2)||!matches(prepared,oldGuard,2))fail('CHANGED');unlinkSync(prepared);sync(generation);sync(dirname(path));break;
    }}
   }
  }
 }
 fresh(){
  const v=this.#read();if(v?.phase==='new')return this.status();if(!v||!['done','fresh'].includes(v.phase))fail();
  if(stat(this.#directory(v)))fail('CHANGED');
  for(const [key,s]of Object.entries(this.#sources)){
   if(key==='records'){if(stat(s.path)&&!identical(inventory(s.path,s.type),[['','d']]))fail('CHANGED');}
   else if(!(v.phase==='fresh'&&!stat(s.path))&&!matches(s.path,guard))fail('CHANGED');
  }
  this.#write({...v,phase:'fresh',plan:null});this.#fault('fresh');
  for(const [key,s]of Object.entries(this.#sources))if(key!=='records'&&stat(s.path)){if(!matches(s.path,guard))fail('CHANGED');unlinkSync(s.path);sync(dirname(s.path));this.#fault('fresh-'+key);}
  const records=this.#sources.records.path;if(!stat(records))mkdirSync(records,{mode:0o700});owned(records,true);sync(this.#root);
  this.#write({...v,phase:'new',plan:null});this.#fault('fresh-ready');return this.status();
 }
 completeFresh(id){
  const v=this.#read();if(!v||v.phase!=='new'||v.id!==id)fail('PENDING');
  owned(this.#sources.data.path,true);owned(join(this.#sources.data.path,'contact.sqlite'));owned(this.#sources.records.path,true);
  unlinkSync(this.#path);sync(this.#root);
 }
}
