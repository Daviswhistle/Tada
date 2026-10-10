// Real owned Chrome, file chooser, HTTP upload/readback and encrypted journal.
// This is mechanics validation, not real-model or live-account acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SharedBrowser, BROWSER_CONSENT, BROWSER_FILE_CONSENT } from '../../packages/engine/src/shared-browser.mjs';
import { fileCopy } from '../../packages/engine/src/browser-file-actions.mjs';
import { BrowserSources } from '../../packages/engine/src/browser-sources.mjs';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
const root=mkdtempSync(join(tmpdir(),'tada-shared-file-')),original=Buffer.from('\ufeffname,amount\r\n한솔,1200\r\n','utf16le'),path=join(root,'source.csv');
writeFileSync(path,original);let saved=null,attempts=0,dangerousGets=0;
const page=`<!doctype html><meta charset="utf-8"><title>명단 가져오기</title><h1>명단 가져오기</h1><form method="post" action="/upload"><label>CSV 파일<input id="file" name="file" type="file" accept=".csv"></label><label>계정<select id="account"><option>개인</option><option>다른 계정</option></select></label><button type="submit">가져오기</button></form><p id="status">UTF-8 CSV를 가져옵니다.</p><div id="result"></div><script>
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=document.querySelector('#file').files[0];const r=await fetch('/upload',{method:'POST',body:await f.arrayBuffer()});document.querySelector('#status').textContent=await r.text();if(r.ok)document.querySelector('#result').innerHTML='<a download="saved.csv" href="/download">저장된 명단 내려받기</a>';};</script>`;
const site=createServer(async(req,res)=>{
  if(/delete|send|%73|발송|logout|sign-out|log_out|%6c/u.test(req.url)){dangerousGets++;res.setHeader('Set-Cookie','synthetic_session=; Max-Age=0; Path=/');res.end(saved??'');return;}
  if(req.url==='/upload') {const parts=[];for await(const p of req)parts.push(p);const bytes=Buffer.concat(parts);attempts++;let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}
    if(!text || text.includes('\0')){res.writeHead(422);res.end('가져오기 실패: UTF-8 인코딩이 필요합니다.');return;}saved=bytes;res.end('가져오기 완료: 한솔 1명, 1200.');return;}
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/download'});res.end();return;}
  if(req.url.split('?')[0]==='/download'){res.writeHead(saved?200:404,{'Content-Type':'text/csv'});res.end(saved??'missing');return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'synthetic_session=fake-only; Path=/'});res.end(page);
});
await new Promise(r=>site.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${site.address().port}/import`;
const browser=new SharedBrowser({headless:true}),store=new ContactStore({directory:join(root,'journal'),passphrase:'synthetic file chrome fixture key',route:contactRoute({fixture:'file-smoke'}),initialize:true,assistance:true}),device=store.addDevice('Owner');
const base={definitions:[],validate:()=>false,execute:async()=>{throw Error('NO_SOURCE');},verify:async()=>false},signal=new AbortController().signal;
let sources;
try {
  await browser.open();const {targetId}=await browser.command('Target.createTarget',{url,browserContextId:(await browser.command('Target.getBrowserContexts')).browserContextIds[0]});
  const {sessionId}=await browser.command('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=>{const r=await browser.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error('FIXTURE_SCRIPT_ERROR');return r.result.value;};
  const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw Error('FIXTURE_TIMEOUT');};
  await until('!!document.querySelector("#file")');
  const {root:dom}=await browser.command('DOM.getDocument',{},sessionId),{nodeId}=await browser.command('DOM.querySelector',{nodeId:dom.nodeId,selector:'#file'},sessionId);
  await browser.command('DOM.setFileInputFiles',{nodeId,files:[path]},sessionId);
  await evaluate('document.querySelector("form").requestSubmit()');await until('document.querySelector("#status").textContent.includes("실패")');assert.equal(attempts,1);
  await browser.share(device.id,targetId,BROWSER_CONSENT,url);const excluded=await browser.observe(browser.grant.epoch,()=>{});assert.equal(excluded.files,undefined);
  await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);store.submit(device.id,randomUUID(),'이거 안 돼.');const job=store.claim();sources=new BrowserSources(base,store,browser,job);
  let view=await sources.execute('observe_shared_browser',{},signal);assert.match(view.text,/실패/);assert.equal(view.files.length,1);assert.equal(view.files[0].name,'source.csv');
  let file=await sources.execute('read_shared_file',{observation:view.observation,ref:view.files[0].ref,encoding:'auto'},signal);assert.equal(file.encoding,'utf-16le');
  await evaluate('document.querySelector("#account").selectedIndex=1');
  const stale=await sources.execute('replace_shared_file',{file:file.file,name:'source-fixed.csv',content:file.content,edits:[],submit:view.files[0].submitters[0].ref},signal);
  assert.equal(stale.verdict,'CONFIRMED_NOT_APPLIED');assert.equal(attempts,1);assert.deepEqual(readFileSync(path),original);
  await evaluate('document.querySelector("#account").selectedIndex=0');
  view=await sources.execute('observe_shared_browser',{},signal);file=await sources.execute('read_shared_file',{observation:view.observation,ref:view.files[0].ref,encoding:'auto'},signal);
  const applied=await sources.execute('replace_shared_file',{file:file.file,name:'source-fixed.csv',content:file.content,edits:[],submit:view.files[0].submitters[0].ref},signal);assert.equal(applied.state,'UNCERTAIN');assert.equal(applied.submitted,true);
  await until('!!document.querySelector("a[download]")');view=await sources.execute('observe_shared_browser',{},signal);assert.match(view.text,/가져오기 완료/);
  await evaluate('document.querySelector("a[download]").href="/redirect"');view=await sources.execute('observe_shared_browser',{},signal);
  await assert.rejects(sources.execute('verify_shared_file',{action_id:applied.action_id,observation:view.observation,ref:view.downloads[0].ref},signal));
  assert.equal(store.browserBlocked(new URL(url).origin),true);assert.equal(attempts,2);
  for(const target of ['/account/delete','/send-invitations','/%73%65%6e%64','/발송','/logout','/sign-out','/log_out','/로그아웃','/%6c%6f%67%6f%75%74']) {
    await evaluate(`document.querySelector('a[download]').href=${JSON.stringify(target)}`);
    const forbidden=await browser.observe(browser.grant.epoch,()=>{});assert.equal(forbidden.downloads.length,0,target);
    await assert.rejects(browser.download(browser.grant.epoch,forbidden,'download-1',()=>{},'unissued-result'));
  }
  await evaluate(`const link=document.querySelector('a[download]');link.href='/download';link.setAttribute('aria-label','Send invitations');`);
  assert.equal((await browser.observe(browser.grant.epoch,()=>{})).downloads.length,0);
  await evaluate(`{const link=document.querySelector('a[download]');link.removeAttribute('aria-label');link.title='Send invitations';}`);
  assert.equal((await browser.observe(browser.grant.epoch,()=>{})).downloads.length,0);
  await evaluate(`document.querySelector('a[download]').removeAttribute('title')`);
  const beforeDanger=await browser.observe(browser.grant.epoch,()=>{});
  await evaluate(`document.querySelector('a[download]').href='/account/delete'`);
  await assert.rejects(browser.download(browser.grant.epoch,beforeDanger,beforeDanger.downloads[0].ref,()=>{},'unissued-result'));
  assert.equal(dangerousGets,0);assert.equal(await evaluate('document.cookie'),'synthetic_session=fake-only');
  await evaluate('document.querySelector("a[download]").href="/download#result"');view=await sources.execute('observe_shared_browser',{},signal);
  const result=await sources.execute('verify_shared_file',{action_id:applied.action_id,observation:view.observation,ref:view.downloads[0].ref},signal);assert.equal(result.state,'UNCERTAIN');assert.equal(result.download_matches,true);assert.equal(store.browserBlocked(new URL(url).origin),true);
  assert.deepEqual(saved,Buffer.from(file.content));assert.deepEqual(readFileSync(path),original);assert.equal(attempts,2);
  assert.deepEqual(Buffer.from(store.browserFile(device.id,applied.action_id,'original').data,'base64'),original);
  // All file identities and submission order remain fixed after observation.
  mkdirSync(join(root,'other'));const attachment=join(root,'attachment.txt'),otherAttachment=join(root,'other','attachment.txt');
  writeFileSync(attachment,'first attachment');writeFileSync(otherAttachment,'different attachment');
  for(const mode of ['button_value','button_text','attachment_before','attachment_during','multiple_before','account_during','validation_changed','invalid_form']) {
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    await evaluate(`document.querySelector('form').onsubmit=e=>{e.preventDefault();globalThis.unexpectedSubmit=true;};
      const extra=document.createElement('input');extra.type='file';extra.id='extra';extra.name='extra';extra.multiple=true;document.querySelector('form').append(extra);
      const b=document.querySelector('button');b.name='operation';b.value='import';`);
    const select=async(selector,files)=>{const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files},sessionId);};
    await select('#file',[path]);await select('#extra',[attachment]);
    if(mode==='account_during')await evaluate(`const account=document.createElement('header');account.id='account-label';account.textContent='Account A';document.body.prepend(account);document.querySelector('#file').onchange=()=>account.textContent='Account B';`);
    if(mode==='validation_changed' || mode==='invalid_form')await evaluate(`const check=document.createElement('input');check.type='checkbox';check.required=true;document.querySelector('form').append(check);`);
    if(mode==='validation_changed')await evaluate(`document.querySelector('#file').onchange=()=>document.querySelector('button').formNoValidate=true`);
    if(mode==='button_value')await evaluate(`document.querySelector('#file').onchange=()=>document.querySelector('button').value='publish'`);
    if(mode==='button_text')await evaluate(`document.querySelector('#file').onchange=()=>document.querySelector('button').textContent='Publish publicly'`);
    if(mode==='attachment_during')await evaluate(`document.querySelector('#file').onchange=()=>{const transfer=new DataTransfer();transfer.items.add(new File(['changed attachment'],'attachment.txt'));document.querySelector('#extra').files=transfer.files;}`);
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);
    const epoch=browser.grant.epoch,observed=await browser.observe(epoch,()=>{}),field=observed.files[0],raw=await browser.readFile(epoch,observed,field.ref,()=>{});
    if(mode==='attachment_before')await select('#extra',[otherAttachment]);
    if(mode==='multiple_before')await select('#extra',[otherAttachment,attachment]);
    const guarded=await browser.replaceFile(epoch,observed,field.ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n')),field.submitters[0].ref,()=>{});
    if(mode.endsWith('_before'))assert.equal(guarded.applied,false,mode);else {assert.equal(guarded.applied,true,mode);assert.equal(guarded.submitted,false,mode);if(mode==='invalid_form')assert.equal(guarded.reason,'form_validation');}
    assert.equal(await evaluate('globalThis.unexpectedSubmit===true'),false,mode);assert.equal(attempts,2);
  }
  for(const scope of [...['Send invitations','Pay now','Upload and send','전송','결제','Submit'].map(title=>({title})),{title:'Import',value:'send_invitations'},{title:'Upload',action:'/checkout'},{title:'Import',aria:'Send invitations'},{title:'Upload',tooltip:'Send invitations'},{title:'Import',action:'/발송'},{title:'Import',action:'/%73%65%6e%64'},{title:'Import',action:'/%2573%2565%256e%2564'}]) {
    const {title}=scope;
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    await evaluate(`const scope=${JSON.stringify(scope)},button=document.querySelector('button');button.textContent=scope.title;if(scope.value)button.value=scope.value;if(scope.action)button.formAction=scope.action;if(scope.aria)button.setAttribute('aria-label',scope.aria);if(scope.tooltip)button.title=scope.tooltip;`);
    const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[path]},sessionId);
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);const observed=await browser.observe(browser.grant.epoch,()=>{});
    assert.equal(observed.files[0].submitters.length,0,title);
    const raw=await browser.readFile(browser.grant.epoch,observed,observed.files[0].ref,()=>{});
    const refused=await browser.replaceFile(browser.grant.epoch,observed,observed.files[0].ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n')),'submit-1',()=>{});
    assert.equal(refused.applied,false,title);assert.equal(attempts,2);
  }
  for(const kind of ['hidden_command','visible_command','csrf']) {
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    await evaluate(`const field=document.createElement('input');field.type=${JSON.stringify(kind==='visible_command'?'text':'hidden')};field.name=${JSON.stringify(kind==='csrf'?'_csrf':'operation')};field.value=${JSON.stringify(kind==='csrf'?'SYNTHETIC-CSRF':'send_invitations')};if(${JSON.stringify(kind)}==='csrf')document.querySelector('form').action='/%75pload';document.querySelector('form').append(field);globalThis.changed=0;document.querySelector('#file').onchange=()=>globalThis.changed++;document.querySelector('form').onsubmit=e=>e.preventDefault();`);
    const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[path]},sessionId);
    await evaluate('globalThis.changed=0');
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);const observed=await browser.observe(browser.grant.epoch,()=>{}),field=observed.files[0];
    assert.equal(field.replaceable,kind==='csrf');assert.equal(field.submitters.length,kind==='csrf'?1:0);
    const raw=await browser.readFile(browser.grant.epoch,observed,field.ref,()=>{});
    const attempted=await browser.replaceFile(browser.grant.epoch,observed,field.ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n')),kind==='csrf'?'submit-1':null,()=>{});
    assert.equal(attempted.applied,kind==='csrf');assert.equal(await evaluate('globalThis.changed'),kind==='csrf'?1:0);assert.equal(attempts,2);
  }
  // Unknown form controls may submit values even without native .name. Known
  // destinations must be checked before input/change, including automatic upload.
  for(const mode of ['custom_named','custom_formdata','cross_origin','other_target','contact_action','korean_action','encoded_action','nested_action','logout_action','nameless_password','nameless_otp']) {
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[path]},sessionId);
    await evaluate(`const mode=${JSON.stringify(mode)},form=document.querySelector('form');
      if(mode.startsWith('custom')){customElements.define('command-field',class extends HTMLElement{static formAssociated=true;constructor(){super();const internals=this.attachInternals();if(mode==='custom_formdata'){const payload=new FormData();payload.set('operation','send_invitations');internals.setFormValue(payload);}else internals.setFormValue('send_invitations');}});const command=document.createElement('command-field');if(mode==='custom_named')command.setAttribute('name','operation');form.append(command);}
      if(mode.startsWith('nameless')){const c=document.createElement('input');c.type=mode==='nameless_password'?'password':'text';if(mode==='nameless_otp')c.autocomplete='one-time-code';c.value='SYNTHETIC-SECRET';form.append(c);}
      if(mode==='cross_origin')form.action='http://localhost:'+location.port+'/upload';
      if(mode==='logout_action')form.action='/sign-out';
      if(mode==='other_target')form.target='_blank';if(mode==='contact_action')form.action='/send-invitations';if(mode==='korean_action')form.action='/발송';if(mode==='encoded_action')form.action='/%73%65%6e%64';if(mode==='nested_action')form.action='/%2573%2565%256e%2564';
      globalThis.changes=0;document.querySelector('#file').onchange=()=>{globalThis.changes++;fetch(form.action,{method:'POST',body:new FormData(form)});};form.onsubmit=e=>e.preventDefault();`);
    if(mode.startsWith('custom'))assert.equal(await evaluate("new FormData(document.querySelector('form')).get('operation')"),'send_invitations',mode);
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);const epoch=browser.grant.epoch,view=await browser.observe(epoch,()=>{}),field=view.files[0];
    assert.equal(field.replaceable,false,mode);assert.equal(field.submitters.length,0,mode);
    const raw=await browser.readFile(epoch,view,field.ref,()=>{});
    for(const submit of [null,'submit-1']){const result=await browser.replaceFile(epoch,view,field.ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n')),submit,()=>{});assert.equal(result.applied,false,mode);assert.equal(result.reason,'file_scope',mode);}
    assert.equal(await evaluate('globalThis.changes'),0,mode);assert.equal(attempts,2,mode);
  }
  for(const mode of ['account','form','file','label','hidden','removed'])for(const submit of [null,'submit-1']) {
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[path]},sessionId);
    await evaluate(`const mode=${JSON.stringify(mode)},field=document.querySelector('#file'),style=document.createElement('style');document.head.append(style);globalThis.changes=0;globalThis.submits=0;
      field.oninput=()=>{if(mode==='account')document.querySelector('#account').selectedIndex=1;if(mode==='form')field.form.action='/other-upload';if(mode==='file'){const t=new DataTransfer();t.items.add(new File(['other'],'other.csv'));field.files=t.files;}if(mode==='label')field.setAttribute('aria-label','Other account');if(mode==='hidden')style.sheet.insertRule('#file {visibility:hidden}',0);if(mode==='removed')field.remove();};
      field.onchange=()=>{globalThis.changes++;fetch('/upload',{method:'POST',body:field.files[0]});};document.querySelector('form').onsubmit=e=>{e.preventDefault();globalThis.submits++;};`);
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);
    const epoch=browser.grant.epoch,view=await browser.observe(epoch,()=>{}),field=view.files[0],raw=await browser.readFile(epoch,view,field.ref,()=>{});
    const result=await browser.replaceFile(epoch,view,field.ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n')),submit,()=>{});
    assert.equal(result.applied,true,mode);assert.equal(result.submitted,false,mode);assert.equal(result.reason,'target_changed',mode);assert.equal(result.result_key,undefined,mode);
    assert.deepEqual(await evaluate('[globalThis.changes,globalThis.submits]'),[0,0],mode);assert.equal(attempts,2,mode);
  }
  for(const mode of ['visible_secret','hidden_secret','nameless_secret','binary','multiple','large','hidden_text','disabled_text']) {
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[path]},sessionId);
    await evaluate(`const mode=${JSON.stringify(mode)},extra=document.createElement('input');extra.type='file';extra.name=mode==='nameless_secret'?'':'supplement';extra.id='extra';extra.multiple=true;document.querySelector('form').append(extra);
      if(mode.startsWith('hidden'))extra.hidden=true;if(mode==='disabled_text')extra.disabled=true;
      const transfer=new DataTransfer();transfer.items.add(new File([mode==='large'?'x'.repeat(32769):'SYNTHETIC-CREDENTIAL-CANARY'],mode.includes('secret')?'credentials.json':mode==='binary'?'attachment.pdf':'attachment.txt'));if(mode==='multiple')transfer.items.add(new File(['other'],'other.txt'));extra.files=transfer.files;
      globalThis.changes=0;document.querySelector('#file').onchange=()=>globalThis.changes++;document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/upload',{method:'POST',body:new FormData(e.target)});};`);
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);const epoch=browser.grant.epoch,observed=await browser.observe(epoch,()=>{}),field=observed.files.find(f=>f.name==='source.csv');
    assert.equal(field.replaceable,false,mode);assert.equal(field.submitters.length,0,mode);
    const raw=await browser.readFile(epoch,observed,field.ref,()=>{});
    for(const submit of [null,'submit-1']){const result=await browser.replaceFile(epoch,observed,field.ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('name,amount\n한솔,1200\n')),submit,()=>{});assert.equal(result.applied,false,mode);assert.equal(result.reason,'file_scope',mode);}
    assert.equal(await evaluate('globalThis.changes'),0,mode);assert.equal(attempts,2,mode);
  }
  // Identical markup can hide reordered control objects and change which file
  // a server reads first. Check actual identity/order after the change event.
  await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
  await evaluate(`const form=document.querySelector('form'),first=document.querySelector('#file').parentElement,second=first.cloneNode(true);first.after(second);
    [first,second].forEach((label,i)=>{const data=new DataTransfer();data.items.add(new File([i?'other':'source'],i?'second.csv':'first.csv'));label.querySelector('input').files=data.files;});
    first.querySelector('input').onchange=()=>form.insertBefore(second,first);globalThis.orderSubmitted=false;form.onsubmit=e=>{e.preventDefault();globalThis.orderSubmitted=true;};`);
  await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);
  {
    const epoch=browser.grant.epoch,observed=await browser.observe(epoch,()=>{}),field=observed.files[0],raw=await browser.readFile(epoch,observed,field.ref,()=>{});
    assert.deepEqual(observed.files.map(f=>f.name),['first.csv','second.csv']);
    const result=await browser.replaceFile(epoch,observed,field.ref,raw,fileCopy('fixed.csv','text/csv',Buffer.from('fixed')),field.submitters[0].ref,()=>{});
    assert.equal(result.applied,true);assert.equal(result.submitted,false);assert.equal(await evaluate('globalThis.orderSubmitted'),false);assert.equal(attempts,2);
    assert.deepEqual(await evaluate('[...document.querySelectorAll("input[type=file]")].map(e=>e.files[0].name)'),['second.csv','fixed.csv']);
  }
  for(const name of ['passwords.txt','credentials.json','secrets.log','tokens.md','id_rsa.txt']) {
    await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
    const secretPath=join(root,name);writeFileSync(secretPath,'SYNTHETIC ONLY');
    const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[secretPath]},sessionId);
    await browser.share(device.id,targetId,BROWSER_FILE_CONSENT,url);const observed=await browser.observe(browser.grant.epoch,()=>{});assert.equal(observed.files.length,0,name);
    await assert.rejects(browser.readFile(browser.grant.epoch,observed,'file-1',()=>{}));
  }
  for(const mode of ['missing_original','unchanged_example','cloned_example','hidden_example','ordinary_example','beyond_limit_example','changed_query','lost_response']) {
    const isolated=new ContactStore({directory:join(root,mode),passphrase:'synthetic isolated failure fixture',route:contactRoute({fixture:mode}),initialize:true,assistance:true});let scoped;
    const normalReplace=browser.replaceFile;
    try {
      const owner=isolated.addDevice('Fixture owner');isolated.submit(owner.id,randomUUID(),'이거 안 돼.');const job=isolated.claim();
      await browser.command('Page.navigate',{url},sessionId);await until('!!document.querySelector("#file") && !document.querySelector("#extra")');
      // Same bytes already exist before the new action. They must not prove it.
      await evaluate(`document.querySelector('#result').innerHTML='<a download="example.csv" href="/download">Earlier example</a>';document.querySelector('form').onsubmit=e=>e.preventDefault();`);
      if(mode==='changed_query')await evaluate(`document.querySelector('a[download]').href='/download?cache=0';document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('a[download]').href='/download?cache=1';};`);
      if(mode==='cloned_example')await evaluate(`document.querySelector('form').onsubmit=e=>{e.preventDefault();const old=document.querySelector('a[download]');old.replaceWith(old.cloneNode(true));};`);
      if(mode==='hidden_example')await evaluate(`const link=document.querySelector('a[download]');link.hidden=true;document.querySelector('form').onsubmit=e=>{e.preventDefault();link.hidden=false;};`);
      if(mode==='beyond_limit_example')await evaluate(`const link=document.querySelector('a[download]');for(let i=0;i<20;i++){const other=document.createElement('a');other.download='other.csv';other.href='/example-'+i;other.textContent='Old example '+i;link.before(other);}document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelectorAll('a[download]').forEach(a=>{if(a!==link)a.remove();});};`);
      if(mode==='ordinary_example')await evaluate(`const link=document.querySelector('a[download]');link.removeAttribute('download');document.querySelector('form').onsubmit=e=>{e.preventDefault();link.download='example.csv';};`);
      const selectedPath=join(root,mode+'.csv'),bytes=Buffer.from('name,amount\r\n한솔,1200\r\n');writeFileSync(selectedPath,bytes);
      const {root:d}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId:n}=await browser.command('DOM.querySelector',{nodeId:d.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId:n,files:[selectedPath]},sessionId);
      await browser.share(owner.id,targetId,BROWSER_FILE_CONSENT,url);scoped=new BrowserSources(base,isolated,browser,job);
      let view=await scoped.execute('observe_shared_browser',{},signal);const read=await scoped.execute('read_shared_file',{observation:view.observation,ref:view.files[0].ref,encoding:'auto'},signal);
      assert.deepEqual(saved,bytes);
      if(mode==='missing_original')unlinkSync(selectedPath);
      if(mode==='lost_response')browser.replaceFile=async(...args)=>{await normalReplace.apply(browser,args);throw Error('SYNTHETIC_LOST_REPLY');};
      const result=await scoped.execute('replace_shared_file',{file:read.file,name:'fixed.csv',content:null,edits:[],submit:'submit-1'},signal);
      assert.equal(result.state,mode==='missing_original'?'FAILED':'UNCERTAIN');if(mode==='missing_original')assert.equal(result.reason,'file_unavailable');
      view=await scoped.execute('observe_shared_browser',{},signal);
      if(mode==='changed_query'){const compared=await scoped.execute('verify_shared_file',{action_id:result.action_id,observation:view.observation,ref:view.downloads[0].ref},signal);assert.equal(compared.state,'UNCERTAIN');assert.equal(compared.download_matches,true);assert.equal(compared.server_persistence,'not_checked');}
      else await assert.rejects(scoped.execute('verify_shared_file',{action_id:result.action_id,observation:view.observation,ref:view.downloads[0].ref},signal));
      assert.equal(isolated.browserActions()[0].action.state,mode==='missing_original'?'FAILED':'UNCERTAIN');assert.equal(isolated.browserBlocked(new URL(url).origin),mode!=='missing_original');assert.equal(attempts,2);
    } finally {browser.replaceFile=normalReplace;await scoped?.close();isolated.close();}
  }
  console.log(JSON.stringify({passed:true,model:'none',account:'none',sandbox:'enabled',actual_upload:true,actual_download_readback:true,original_preserved:true,submitter_and_all_file_preconditions:true,native_submit_observed:true,fragment_readback:true,file_purpose_only:true,form_payload_bounded:true,credential_names_blocked:true,download_is_not_application_proof:true,excluded_attachments_blocked:true,control_order_preserved:true,cloned_download_rejected:true,hidden_old_download_rejected:true,event_preconditions_rechecked:true,ordinary_old_link_rejected:true,custom_form_controls_blocked:true,automatic_form_destination_checked:true,attempts}));
} finally {await sources?.close();await browser.close();store.close();await new Promise(r=>site.close(r));rmSync(root,{recursive:true,force:true});}
