import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { createRecordBackup, openRecordBackup } from '../src/contact-backup.mjs';
import { ATTENTION_CONSENT } from '../src/attention.mjs';
import { OwnerContext } from '../src/owner-context.mjs';
import { MailSources } from '../src/mail-sources.mjs';
import { GOOGLE_SEND_SCOPES } from '../src/google-contract.mjs';
import { recoveryGroups, validateRecoveryGroups } from '../src/contact-recovery.mjs';
const passphrase = 'SYNTHETIC_RECOVERY_KEY_ONLY', route = contactRoute({fixture:'recovery'});
const cp = {version:1};
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'tada-recovery-')), stores = [];
  const open = (name, options = {}) => { const s = new ContactStore({directory:join(root,name),passphrase,route,...options}); stores.push(s); return s; };
  const old = open('old',{initialize:true,mail:true}), owner = old.addDevice('이전 기기');
  return {root,open,old,owner,close(){ for(const s of stores) s.close(); rmSync(root,{recursive:true,force:true}); }};
}
function start(s,d,text='현재 요청') { const seq=s.submit(d.id,randomUUID(),text).seq; assert.equal(s.claim()?.seq,seq); return seq; }
function finish(s,seq,text='저장한 답변',document=null,proposals=[]) { s.finish(seq,{text,sources:[],verification:'not_applicable'},cp,proposals,document); }
function google(s,d) { s.saveGoogleCredential(d.id,{version:2,send_enabled:true,epoch:randomUUID(),device:d.id,scopes:[...GOOGLE_SEND_SCOPES],refresh_token:'SYNTHETIC_REFRESH_TOKEN_ONLY_123',email:'owner@example.test',connected_at:Date.now(),last_checked:null,last_error:null,reconnect_required:false},null); }
function records(e) {
  const {old:s,owner:d}=e;
  const first=start(s,d,'계획 문서를 만들어줘'); const doc=s.prepareDocument(first,{title:'계획',format:'text',based_on:null}); finish(s,first,'원래 계획',doc);
  const edited=s.editDocument(d.id,{request_id:randomUUID(),based_on:first,title:'내 계획',content:'직접 바꾼 계획'}).document.id;
  const text='내일 회의 준비를 알려줘.', seq=start(s,d,text);
  const proposal={id:randomUUID(),timezone:'Asia/Seoul',spec:{operation_id:'meeting',target:null,expected_version:0,title:'회의 준비',details:'자료 챙기기',state:'open',waiting_for:null,notify_at:new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/u,'Z'),user_quote:text}};
  finish(s,seq,'알림 준비',null,[proposal]); s.confirmFollowup(d.id,proposal.id,'approve'); s.armReview(d.id,proposal.id,1,'one_local_read_only_review');
  google(s,d); const mailSeq=start(s,d,'메일 초안'); const mail=s.prepareMail(mailSeq,{account:'owner@example.test',to:['friend@example.test'],cc:[],bcc:[],subject:'준비',body:'자료입니다.',reply:null}); s.finish(mailSeq,{text:'메일 초안',sources:[]},cp,[],null,null,mail);
  s.telegramConfigure('333');s.telegramBind({bot:'333',chat:'555',user:'555',after_message:10}); const delivery=s.telegramClaimDelivery(); assert.equal(delivery.turn,null);
  const running=start(s,d,'진행 중인 과거 요청');
  for(let i=0;i<64;i++) { const req=s.reserve(running); s.observe(req,{input_tokens:2,output_tokens:1}); }
  const grant={device:d.id,epoch:randomUUID(),url:'https://example.test/form',origin:'https://example.test',target:'synthetic'};
  const action=s.admitBrowserAction(running,grant,{key:'doc-1',fields:[{ref:'field1',label:'입력'}]},'field1','과거 입력');
  const queued=s.submit(d.id,randomUUID(),'과거 대기 요청').seq;
  return {snapshot:s.exportRecords(d.id),first,edited,proposal,mail,delivery,running,queued,action,grant};
}
test('recovery keeps historical work outside execution, quotas, owner context and device authority',()=>{
 const e=fixture();try {
  const r=records(e), s=e.open('restored',{initialize:true,recovery:r.snapshot}), d=s.addDevice('새 기기');
  assert.equal(s.contactVersion,7); assert.notEqual(s.id,e.old.id); assert.equal(s.authenticate(e.owner.token),null);
  assert.equal(s.claim(),null); assert.equal(s.followupTick(Date.now()+7200000),0);assert.equal(s.reviewTick(Date.now()+7200000),0);assert.equal(s.telegramClaimDelivery(),null);
  assert.equal(s.turn(r.running),null);assert.equal(s.readTurn(r.running).state,'running');assert.equal(s.readTurn(r.queued).state,'queued');
  assert.equal(s.checkpoint().value,null);assert.equal(s.usage().requests,0);assert.equal(s.historicalUsage().requests,64);assert.equal(s.requestRoom(),64);
  assert.equal(s.googleCredential(),null);assert.equal(s.mobileCredential(),null);assert.equal(s.followup(r.proposal.id),null);
  assert.throws(()=>s.reserve(r.running),/REQUEST_STOPPED/u);assert.throws(()=>s.assertTurnAuthority(r.running),/REQUEST_STOPPED/u);
  assert.throws(()=>s.submit(d.id,r.snapshot.records.turns[0].request_id,'계획 문서를 만들어줘'),/REQUEST_ID_REUSED/u);
  assert.throws(()=>s.confirmFollowup(d.id,r.proposal.id,'approve'),/NOT_FOUND/u);
  assert.throws(()=>s.armReview(d.id,r.proposal.id,1,'one_local_read_only_review'),/STALE/u);
  assert.throws(()=>s.mailAction(r.mail.id),/MAIL_NOT_FOUND/u);assert.throws(()=>s.editMail(d.id,r.mail.id,1,r.mail.sha256,r.mail.draft),/MAIL_NOT_FOUND/u);
  assert.throws(()=>s.telegramDelivery(r.delivery.id,'unknown'),/DELIVERY_CONFLICT/u);
  const seq=start(s,d,'새로 부탁할게'), job=s.turn(seq);assert.ok(seq>r.queued);
  assert.deepEqual(new OwnerContext(s,job).snapshot().messages,[]);
  assert.equal(s.readHistory(r.running,seq).recovery.quarantined,true);
  const req=s.reserve(seq);assert.ok(req>64);s.observe(req,{input_tokens:1,output_tokens:1});
  const malicious={...r.proposal,id:randomUUID(),spec:{...r.proposal.spec,target:r.proposal.id,expected_version:1,user_quote:job.text}};
  assert.throws(()=>finish(s,seq,'변경',null,[malicious]),/FOLLOWUP_STALE/u);
  finish(s,seq,'새 답변');
  const db=new DatabaseSync(join(e.root,'restored','contact.sqlite'),{readOnly:true});
  try {for(const name of ['followups','followup_reviews','telegram_outbox','mail_actions']) assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n,0);}finally{db.close();}
  assert.ok(!readFileSync(join(e.root,'restored','contact.sqlite')).includes(Buffer.from('직접 바꾼 계획')));
 }finally{e.close();}
});
test('documents stay readable, accept new revisions, survive restart and repeated backup/recovery with original provenance',()=>{
 const e=fixture();try {
  const r=records(e), s=e.open('one',{initialize:true,recovery:r.snapshot}), d=s.addDevice('new');
  assert.equal(s.document(r.edited).content,'직접 바꾼 계획');assert.equal(s.latestDocument(r.first).id,r.edited);
  assert.throws(()=>s.editDocument(d.id,{request_id:randomUUID(),based_on:r.first,title:'오래된 수정',content:'안 됨'}),/STALE/u);
  const doc=s.editDocument(d.id,{request_id:randomUUID(),based_on:r.edited,title:'새 계획',content:'복원 후 바꾼 계획'}).document;
  assert.equal(doc.revision,3);assert.ok(!doc.recovery);s.close();
  const reopened=e.open('one');assert.equal(reopened.document(doc.id).content,'복원 후 바꾼 계획');
  const next=reopened.exportRecords(d.id); assert.equal(next.version,2); assert.equal(next.recovered.length,1);
  const again=e.open('two',{initialize:true,recovery:next});
  assert.equal(again.document(doc.id).revision,3);assert.equal(again.latestDocument(r.first).id,doc.id);assert.equal(again.claim(),null);
  assert.equal(again.readTurn(r.first).recovery.generation,r.snapshot.source.journal_id);assert.equal(again.readTurn(doc.id).recovery.generation,next.source.journal_id);
 }finally{e.close();}
});
test('unresolved restored browser effects block new writes until a fresh owner acknowledgement, preserving old receipt',()=>{
 const e=fixture();try{
  const r=records(e),s=e.open('restored',{initialize:true,recovery:r.snapshot}),d=s.addDevice('new');const seq=start(s,d);
  assert.equal(s.browserActions().length,0);assert.equal(s.browserBlocked(r.grant.origin,seq),true);
  assert.throws(()=>s.admitBrowserAction(seq,{...r.grant,device:d.id},{key:'new',fields:[]},'field','new'),/UNRESOLVED/u);
  const before=s.readBrowserActions(true)[0];assert.equal(before.action.state,'DISPATCHING');
  assert.throws(()=>s.resolveBrowserAction(d.id,r.action,'bad'),/CONSENT/u);
  s.resolveBrowserAction(d.id,r.action,'checked_browser_effect_allow_new_work_v1');assert.equal(s.browserBlocked(r.grant.origin,seq),false);
  const after=s.readBrowserActions()[0];assert.deepEqual(after.action,before.action);assert.equal(after.resolved,null);assert.equal(after.recovery.acknowledged,true);
  s.close(); const reopened=e.open('restored');assert.equal(reopened.browserBlocked(r.grant.origin),false);
 }finally{e.close();}
});
test('historical mail stays a saved observation and never reconciles or dispatches through fresh permissions',async()=>{
 const e=fixture();try{
  const r=records(e); // Turn a synthetic mail into an ambiguous send before export; no network.
  e.old.beginMailSend(e.owner.id,r.mail.id,1,r.mail.sha256,e.old.googleEpoch(),'send_exact_mail_once_v1');
  e.old.finishMailSend(r.mail.id,'UNCERTAIN','outcome_unknown');
  const s=e.open('restored',{initialize:true,recovery:e.old.exportRecords(e.owner.id)}),d=s.addDevice('new');google(s,d);
  const seq=start(s,d,'지난 메일 결과 알려줘');let reconciles=0;
  const sources=new MailSources({definitions:[],validate:()=>false},s,s.turn(seq),null,async()=>{reconciles++;throw Error('unexpected');});
  const result=await sources.execute('read_mail_action',{id:r.mail.id},new AbortController().signal);
  assert.equal(result.state,'UNCERTAIN');assert.equal(result.status_check.state,'saved');assert.equal(result.recovery.quarantined,true);assert.equal(reconciles,0);
  assert.throws(()=>s.beginMailSend(d.id,r.mail.id,1,r.mail.sha256,s.googleEpoch(),'send_exact_mail_once_v1'),/MAIL_NOT_FOUND/u);
 }finally{e.close();}
});
test('invalid import lineage is rejected before creating a new journal',()=>{
 const e=fixture();try{
  const r=records(e);
  for(const mutate of [s=>s.records.turns[1].answer.document.sha256='0'.repeat(64),s=>s.records.turns[1].answer.document.based_on=999,
    s=>s.records.mail_actions[0].payload.draft.body='modified',s=>s.records.followup_reviews[0].payload.device=randomUUID(),
    s=>s.records.browser_actions[0].payload.records[0].payload.value='modified',s=>s.records.turns[1].request_id=s.records.turns[0].request_id,
    s=>s.records.telegram_outbox[0].payload.group='bad',s=>s.records.followup_notices.push({}),s=>s.records.followups[0].payload.state='done']){
    const snapshot=structuredClone(r.snapshot);mutate(snapshot);assert.throws(()=>validateRecoveryGroups(recoveryGroups(snapshot)),/CONTACT_/u);
  }
 }finally{e.close();}
});
test('missing or modified encrypted historical rows fail closed on reopening',()=>{
 const e=fixture();try{
  const r=records(e),s=e.open('restored',{initialize:true,recovery:r.snapshot});s.close();
  const db=new DatabaseSync(join(e.root,'restored','contact.sqlite'));db.exec("DELETE FROM restored_records WHERE kind='turns' AND position=0");db.close();
  assert.throws(()=>e.open('restored'),/CONTACT_RECOVERY_INVALID/u);
 }finally{e.close();}
});

test('calendar notices keep proactive provenance without restoring schedules or old owner intent',()=>{
 const e=fixture();try{
  const s=e.old,d=e.owner;google(s,d);const now=Date.now();
  s.configureProactive(d.id,true,ATTENTION_CONSENT,'Asia/Seoul',now);
  const ticket=s.claimAttention(now);assert.ok(ticket);
  s.finishAttention(ticket,{fingerprint:'a'.repeat(64),events:[{id:'event-1',title:'약속',start:now+20*60000,day:null}],truncated:false,observed_at:now,account:'owner@example.test'},now);
  const notice=s.page().turns.find(t=>t.answer?.calendar_reminder);assert.ok(notice);
  const restored=e.open('restored',{initialize:true,recovery:s.exportRecords(d.id)}),owner=restored.addDevice('new');
  assert.equal(restored.readTurn(notice.seq).origin,'proactive');assert.equal(restored.readTurn(notice.seq).answer.observed_at,now);
  assert.equal(restored.proactiveStatus().enabled,false);assert.equal(restored.claimAttention(now+3600000),null);
  const seq=start(restored,owner);assert.deepEqual(new OwnerContext(restored,restored.turn(seq)).snapshot().messages,[]);
 }finally{e.close();}
});
test('merged history cursors preserve every original and fresh turn, and v2 encrypted rebackup round trips',async()=>{
 const e=fixture();try{
  for(let i=0;i<61;i++){const seq=start(e.old,e.owner,`원본 ${i}`);finish(e.old,seq);}
  const first=e.old.exportRecords(e.owner.id),s=e.open('restored',{initialize:true,recovery:first}),d=s.addDevice('new');
  const seq=start(s,d,'새 요청');finish(s,seq);
  const one=s.page(),two=s.page(one.next_before);assert.equal(one.turns.length,50);assert.equal(two.turns.length,12);assert.equal(two.next_before,null);
  assert.deepEqual([...two.turns,...one.turns].map(t=>t.seq),Array.from({length:62},(_,i)=>i+1));
  const protector={kind:'windows-dpapi-v1',protect:async key=>Buffer.from(key),unprotect:async bytes=>Buffer.from(bytes)};
  const snapshot=s.exportRecords(d.id), archive=await createRecordBackup(snapshot,{protector,portable:true});
  const read=await openRecordBackup(archive.bytes,{recoveryCode:archive.recoveryCode});assert.deepEqual(read,snapshot);
  const twice=e.open('twice',{initialize:true,recovery:read});assert.equal(twice.page().turns.at(-1).recovery.generation,snapshot.source.journal_id);
  const corrupt=structuredClone(snapshot);corrupt.recovered=[structuredClone(snapshot)];assert.throws(()=>recoveryGroups(corrupt),/BACKUP_INVALID/u);
 }finally{e.close();}
});

test('legacy Telegram payloads remain readable without acquiring delivery authority',()=>{
 const e=fixture();try{
  const snapshot=records(e).snapshot, first=snapshot.records.telegram_outbox[0];
  delete first.payload.group;
  snapshot.records.telegram_outbox.push({...structuredClone(first),id:'f'.repeat(64)});
  const s=e.open('legacy',{initialize:true,recovery:snapshot});
  assert.equal(s.telegramClaimDelivery(),null);const d=s.addDevice('new');
  assert.equal(s.exportRecords(d.id).recovered[0].records.telegram_outbox.length,snapshot.records.telegram_outbox.length);
  s.close();assert.equal(e.open('legacy').telegramClaimDelivery(),null);
 }finally{e.close();}
});
test('a restored journal accepts its dedicated Google client without restoring a user grant',async()=>{
 const {saveGoogleClientConfig,loadGoogleClientConfig}=await import('../src/google-client-config.mjs');
 const e=fixture();try{
  const s=e.open('restored',{initialize:true,recovery:e.old.exportRecords(e.owner.id)});s.close();
  const data=join(e.root,'restored'),client={client_id:'synthetic-recovery.apps.googleusercontent.com',client_secret:'SYNTHETIC_CLIENT_ONLY'};
  assert.deepEqual(saveGoogleClientConfig({data,passphrase,client,route}),{saved:true});
  const reopened=e.open('restored');assert.equal(reopened.googleCredential(),null);
  assert.deepEqual(loadGoogleClientConfig({data,passphrase,env:{},store:reopened}),{clientId:client.client_id,clientSecret:client.client_secret});
 }finally{e.close();}
});
test('repeated recovery beyond 32 generations preserves provenance and large encrypted manifests across restart',()=>{
 const e=fixture();try{
  const base=e.old.exportRecords(e.owner.id);base.records.devices=[];
  // Realistic maximum-length client configurations make the manifest exceed
  // an ordinary conversation payload; only the archive manifest has this bound.
  base.connection.google_client={client_id:'synthetic-recovery.apps.googleusercontent.com',client_secret:'x'.repeat(4096)};
  const prior=Array.from({length:80},()=>({...structuredClone(base),source:{...base.source,journal_id:randomUUID()}}));
  const snapshot={...structuredClone(base),version:2,source:{...base.source,schema_version:7},recovered:prior};
  const s=e.open('many',{initialize:true,recovery:snapshot}),d=s.addDevice('new');
  const next=s.exportRecords(d.id);assert.equal(next.recovered.length,81);s.close();
  const reopened=e.open('many');assert.equal(reopened.exportRecords(d.id).recovered.length,81);
  const twice=e.open('twice',{initialize:true,recovery:next}),d2=twice.addDevice('another');
  assert.equal(twice.exportRecords(d2.id).recovered.length,82);assert.equal(twice.claim(),null);
 }finally{e.close();}
});
test('archive creation applies the same total record limit as recovery across generations',async()=>{
 const {validateBackupSnapshot}=await import('../src/contact-backup.mjs');
 const e=fixture();try{
  const base=e.old.exportRecords(e.owner.id),device=base.records.devices[0];
  // 200,000 short device rows fit within the byte limit; current rows count too.
  const uuid=i=>`00000000-0000-0000-0000-${i.toString(16).padStart(12,'0')}`;
  const prior=[0,1].map(g=>({...structuredClone(base),source:{...base.source,journal_id:uuid(300000+g)},records:{...structuredClone(base.records),devices:Array.from({length:100000},(_,i)=>({...device,id:uuid(g*100000+i),name:'d'}))}}));
  const snapshot={...structuredClone(base),version:2,source:{...base.source,schema_version:7},recovered:prior};
  const within={...snapshot,records:{...snapshot.records,devices:[]}};assert.doesNotThrow(()=>validateBackupSnapshot(within));
  assert.throws(()=>validateBackupSnapshot(snapshot),/CONTACT_BACKUP_TOO_LARGE/u);
  let protectedKeys=0;await assert.rejects(createRecordBackup(snapshot,{protector:{kind:'windows-dpapi-v1',protect:async()=>{protectedKeys++;return Buffer.alloc(32);}}}),/CONTACT_BACKUP_TOO_LARGE/u);
  assert.equal(protectedKeys,0);
 }finally{e.close();}
});

for (const read of ['local-document','web-document','web-history']) for (const freshFirst of [false,true]) test(`actual conversation reuses restored ${read} citations without collision; freshFirst=${freshFirst}`,async()=>{
 const {ContactService}=await import('../src/contact-service.mjs');
 const {discoveryTools,validCall}=await import('../src/native-sources.mjs');
 const e=fixture();let service;
 try{
  const oldSeq=start(e.old,e.owner,'자료를 정리해줘'), document=read.endsWith('document') ? e.old.prepareDocument(oldSeq,{title:'기존 자료',format:'text',based_on:null}) : null;
  const source={id:'S1',source:read==='local-document'?'old-source':'ChatGPT public web research',path:read==='local-document'?'old.txt':`report-${oldSeq}`,sha256:'a'.repeat(64),observed_at:'2026-10-08T00:00:00Z',...(read==='local-document'?{}:{citations:[{url:'https://example.test/old',title:'옛 공개 자료'}]})};
  e.old.finish(oldSeq,{text:'백업 당시 확인한 내용 [S1]',sources:[source],verification:'cited_sources_rechecked'},cp,[],document);
  const snapshot=e.old.exportRecords(e.owner.id),s=e.open('restored',{initialize:true,recovery:snapshot}),d=s.addDevice('new');
  if(read==='web-history') s.configureContinuingUse(d.id,true,'continuing_conversation_24h_v1');
  let originalChecks=0;
  const sources={definitions:discoveryTools,validate:validCall,
   execute:async()=>({source:'new-source',path:'new.txt',content:'현재 자료',sha256:'b'.repeat(64),observed_at:'2026-10-10T00:00:00Z'}),
   verify:async evidence=>{if(evidence.source==='old-source'){originalChecks++;return false;}return true;}};
  const call=(name,args)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]},input_tokens:1,output_tokens:1});
  const result=content=>({message:{role:'assistant',content},input_tokens:1,output_tokens:1});
  const readOld=call(document?'read_document':'read_history',{id:oldSeq}),readNew=call('read_file',{source:'new-source',path:'new.txt'});
  const steps=[...(freshFirst?[readNew,readOld]:[readOld,readNew]),...(document?[call('prepare_document',{title:'새 정리',format:'text',based_on:oldSeq})]:[]),result('백업 당시 내용 [S1]. 새 자료 [S2].')];
  service=new ContactService(s,{chat:async()=>{assert.ok(steps.length,'unexpected model call');return steps.shift();}},sources);
  const seq=service.submit(d.id,randomUUID(),'이전 자료와 새 자료를 정리해줘').seq;await service.idle();
  assert.equal(s.turn(seq).state,'answered',s.turn(seq).error);assert.equal(steps.length,0);assert.equal(originalChecks,0);
  assert.deepEqual(s.turn(seq).answer.sources.map(v=>v.id).sort(),['S1','S2']);assert.equal(s.checkpoint().value.nextEvidence,3);
  assert.equal(s.readTurn(oldSeq).answer.sources[0].id,'S1');assert.equal(s.readTurn(oldSeq).answer.text,'백업 당시 확인한 내용 [S1]');
  if(document) {assert.equal(s.document(seq).revision,2);assert.equal(s.turn(seq).answer.verification,read==='local-document'?'saved_document_sources_checked':'provider_web_report_checked');}
  await service.close();service=null;s.close();
  const reopened=e.open('restored');assert.equal(reopened.checkpoint().value.nextEvidence,3);assert.equal(reopened.recoveredEvidenceNext(),2);
  const secondSteps=[call('read_file',{source:'new-source',path:'new.txt'}),result('새로 확인한 자료 [S3].')];
  service=new ContactService(reopened,{chat:async()=>{assert.ok(secondSteps.length);return secondSteps.shift();}},sources);
  const again=service.submit(d.id,randomUUID(),'현재 자료를 다시 확인해줘').seq;await service.idle();
  assert.equal(reopened.turn(again).state,'answered',reopened.turn(again).error);assert.equal(reopened.turn(again).answer.sources[0].id,'S3');
  const rebackup=reopened.exportRecords(d.id);await service.close();service=null;reopened.close();
  const twice=e.open('twice',{initialize:true,recovery:rebackup});assert.equal(twice.recoveredEvidenceNext(),4);
  assert.deepEqual(twice.readTurn(seq).answer.sources.map(v=>v.id).sort(),['S1','S2']);
 }finally{await service?.close();e.close();}
});
test('recovery rejects conflicting citation identities and unsafe citation counters',()=>{
 const e=fixture();try{
  const a=start(e.old,e.owner),bSource={id:'S1',source:'test',path:'old.txt',sha256:'a'.repeat(64),observed_at:'2026-10-08T00:00:00Z'};
  e.old.finish(a,{text:'자료 [S1]',sources:[bSource]},cp);
  const base=e.old.exportRecords(e.owner.id);
  for(const id of ['other','S9007199254740991']) {const bad=structuredClone(base);bad.records.turns[0].answer.sources[0].id=id;assert.throws(()=>validateRecoveryGroups(recoveryGroups(bad)),/RECOVERY_INVALID/u);}
  const b=start(e.old,e.owner);e.old.finish(b,{text:'다른 자료 [S1]',sources:[{...bSource,sha256:'b'.repeat(64)}]},cp);
  assert.throws(()=>validateRecoveryGroups(recoveryGroups(e.old.exportRecords(e.owner.id))),/RECOVERY_INVALID/u);
 }finally{e.close();}
});

for (const field of ['title','url']) test(`real conversation Unicode ${field} bounds remain compatible with backup, recovery and restart`,async()=>{
 const {ContactService}=await import('../src/contact-service.mjs');
 const e=fixture();let service;
 try{
  const title=field==='title'?'한'.repeat(4096):'공개 자료',url='https://example.test/'+ '가'.repeat(field==='url'?2900:5);
  let count=0;
  const model={contextLimitBytes:65536,chat:async()=>({message:++count===1?{role:'assistant',content:'',tool_calls:[{function:{name:'research_public_web',arguments:{}}}]}:{role:'assistant',content:'공개 자료를 확인했어요. [S1]'},input_tokens:1,output_tokens:1}),researchPublicWeb:async()=>({report:{parts:[{text:'조사 자료',citations:[{url,title}]}]},input_tokens:1,output_tokens:1})};
  service=new ContactService(e.old,model,{definitions:[],validate:()=>false,verify:async()=>false});
  const seq=service.submit(e.owner.id,randomUUID(),'공개 자료를 확인해줘').seq;await service.idle();
  assert.equal(e.old.turn(seq).state,'answered',e.old.turn(seq).error);
  const snapshot=e.old.exportRecords(e.owner.id);
  const s=e.open('unicode',{initialize:true,recovery:snapshot});s.close();
  const reopened=e.open('unicode');assert.deepEqual(reopened.readTurn(seq).answer.sources[0].citations,[{url,title}]);
  for(const mutate of [s=>s.records.turns[0].answer.sources[0].citations[0].title='한'.repeat(4097),s=>s.records.turns[0].answer.sources[0].citations[0].url='https://example.test/'+ 'a'.repeat(8192),s=>s.records.turns[0].answer.sources[0].citations=Array.from({length:129},()=>({url:'https://example.test/',title:'x'}))]) {
   const invalid=structuredClone(snapshot);mutate(invalid);assert.throws(()=>validateRecoveryGroups(recoveryGroups(invalid)),/RECOVERY_INVALID/u);
  }
 }finally{await service?.close();e.close();}
});
