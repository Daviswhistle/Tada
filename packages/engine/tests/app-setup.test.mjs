import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSetup } from '../src/app-setup.mjs';
import { appArguments } from '../src/start-app.mjs';

const turn = () => new Promise(resolve => setTimeout(resolve, 10));
async function client(run, options = {}) {
  const host = await serveSetup({ run, ...options });
  const url = new URL(host.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('setup');
  const get = () => fetch(`${origin}/state`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const action = (state, action, value = null, overrides = {}) => fetch(`${origin}/action`, { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...overrides },
    body: JSON.stringify({ revision: state.revision, action, value }) });
  const until = async stage => { for (let i = 0; i < 100; i++) { const state = await get(); if (state.stage === stage) return state; await turn(); } throw Error(`SETUP_NOT_${stage}`); };
  return { host, origin, token, get, action, until };
}

test('setup exposes no owner state without its local capability and rejects foreign origins and stale answers', async () => {
  let accepted = 0;
  const c = await client(async ui => { await ui.consent(); accepted++; await ui.selectModel([{ name: 'Fixture' }]); ui.ready('http://127.0.0.1:8787/#pair=fixture'); await ui.wait(); });
  try {
    const consent = await c.until('consent');
    assert.equal((await fetch(`${c.origin}/state`)).status, 401);
    const page = await fetch(c.origin); assert.equal((await page.text()).includes(c.token), false);
    assert.equal((await c.action(consent, 'answer', true, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal(await new Promise(resolve => { const req = request(c.origin + '/state', { headers: { Host: 'foreign.invalid', Authorization: 'Bearer ' + c.token } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); }), 403);
    assert.equal((await c.action(consent, 'answer', true, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(accepted, 0);
    assert.equal((await c.action(consent, 'answer', true)).status, 200);
    const model = await c.until('model');
    assert.equal((await c.action(consent, 'answer', true)).status, 409);
    assert.equal((await c.action(model, 'answer', '2')).status, 409);
    assert.equal((await c.action(model, 'answer', '1')).status, 200);
    assert.equal((await c.until('ready')).url.includes('#pair='), true);
    assert.equal(accepted, 1);
  } finally { await c.host.close(); }
});

test('cancel waits for the old runtime to finish before retry, hides diagnostics and creates fresh consent', async () => {
  let running = 0, maximum = 0, attempts = 0;
  const c = await client(async ui => {
    running++; maximum = Math.max(maximum, running); attempts++;
    try {
      await ui.consent(); ui.login('https://auth.openai.com/fixture'); await ui.wait();
      throw Error('PRIVATE_FIXTURE_DIAGNOSTIC');
    } finally { running--; }
  });
  try {
    const first = await c.until('consent'); await c.action(first, 'answer', true);
    const login = await c.until('login'); await c.action(login, 'cancel');
    const error = await c.until('error'); assert.equal(JSON.stringify(error).includes('PRIVATE_FIXTURE'), false);
    await c.action(error, 'retry');
    const next = await c.until('consent'); assert.notEqual(first.revision, next.revision);
    assert.equal(attempts, 2); assert.equal(maximum, 1);
    assert.equal((await c.action(first, 'answer', true)).status, 409);
  } finally { await c.host.close(); }
  assert.equal(running, 0);
});

test('app selects stable default storage and never automatically initializes an existing directory on retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-args-'));
  try {
    const data = join(root, 'conversation');
    assert.equal(appArguments(['--data', data]).includes('--init'), true);
    assert.equal(appArguments(['--data', data], { initialize: false }).includes('--init'), false);
    mkdirSync(data);
    assert.equal(appArguments(['--data', data]).includes('--init'), false);
    assert.equal(appArguments(['--data', data, '--init']).includes('--init'), true, 'explicit creation is not silently changed before this run creates a journal');
    assert.throws(() => appArguments(['--port', 'not-a-port']));
    const defaults = appArguments([]); assert.ok(defaults.includes('--data'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background setup recovers transient startup observations without restarting an active conversation', async () => {
  let attempts = 0;
  const c = await client(async ui => {
    attempts++;
    if (attempts === 1) throw Error('CHATGPT_NETWORK_FAILED');
    ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait();
  }, { autoRetry: true, retryDelays: [100] });
  try {
    const error = await c.until('error'); assert.ok(error.retry_at > Date.now());
    await c.until('ready'); assert.equal(attempts, 2);
    await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(attempts, 2);
  } finally { await c.host.close(); }
});

for (const code of ['CHATGPT_REFRESH_UNCERTAIN', 'CONTACT_OS_PROTECTION_FAILED', 'CONTACT_ASSISTANCE_UPGRADE_REQUIRED', 'CONTACT_MAIL_UPGRADE_REQUIRED']) {
  test(`background setup leaves ${code} for owner recovery instead of retrying`, async () => {
    let attempts = 0;
    const c = await client(async () => { attempts++; throw Error(code); }, { autoRetry: true, retryDelays: [10] });
    try { const state = await c.until('error'); assert.equal(state.retry_at, undefined); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(attempts, 1); }
    finally { await c.host.close(); }
  });
}
test('background retry is cancelled by shutdown and never replays an interactive login exchange', async () => {
  let attempts = 0;
  const a = await client(async () => { attempts++; throw Error('CHATGPT_NETWORK_FAILED'); }, { autoRetry: true, retryDelays: [80] });
  await a.until('error'); await a.host.close(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(attempts, 1);
  const b = await client(async ui => { attempts++; ui.login('https://auth.openai.com/fixture'); throw Error('CHATGPT_NETWORK_FAILED'); }, { autoRetry: true, retryDelays: [10] });
  try { const state = await b.until('error'); assert.equal(state.retry_at, undefined); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(attempts, 2); }
  finally { await b.host.close(); }
});

test('real listen collisions recover automatically when the address is released', async () => {
  const { createServer } = await import('node:net');
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port; let attempts = 0;
  const c = await client(async ui => {
    attempts++; const listener = createServer();
    try {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
      ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait();
    } finally { if (listener.listening) await new Promise(resolve => listener.close(resolve)); }
  }, { autoRetry: true, retryDelays: [100] });
  try {
    assert.ok((await c.until('error')).retry_at);
    await new Promise(resolve => blocker.close(resolve)); await c.until('ready'); assert.equal(attempts, 2);
  } finally { if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); await c.host.close(); }
});
test('provider read timeout retries before interaction but owner cancellation does not', async () => {
  const { response } = await import('../../providers/src/chatgpt-http.mjs'); let attempts = 0;
  const c = await client(async ui => {
    attempts++;
    if (attempts === 1) await response(async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'https://example.invalid/fixture', { signal: AbortSignal.any([ui.signal, AbortSignal.timeout(20)]) });
    ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait();
  }, { autoRetry: true, retryDelays: [100] });
  try { assert.ok((await c.until('error')).retry_at); await c.until('ready'); assert.equal(attempts, 2); }
  finally { await c.host.close(); }
  const cancelled = await client(async ui => { ui.login('https://auth.openai.com/fixture'); await ui.wait(); throw Error('ASSISTANT_CANCELLED'); }, { autoRetry: true, retryDelays: [10] });
  try {
    await cancelled.action(await cancelled.until('login'), 'cancel');
    assert.equal((await cancelled.until('error')).retry_at, undefined);
  } finally { await cancelled.host.close(); }
});

test('restore preview is authenticated and does not stop the running assistant; confirmation drains it before reconnecting',async()=>{
 const { RESTORE_CONSENT }=await import('../src/app-records.mjs');
 let running=0,maximum=0,starts=0,pending=false,confirmed=0,previews=0,cancels=0;
 const records={available:true,clearPreview(){},canCancel:()=>pending,preview:async bytes=>{previews++;assert.equal(bytes.toString(),'synthetic-backup');return{id:'preview-only'};},confirm:async(id,consent)=>{assert.equal(id,'preview-only');assert.equal(consent,RESTORE_CONSENT);confirmed++;pending=true;},cancel(){pending=false;cancels++;}};
 const c=await client(async ui=>{running++;starts++;maximum=Math.max(maximum,running);try{ui.recordRestore(pending);if(pending)await ui.consent();ui.ready('http://127.0.0.1:8787/#pair=fixture',pending);await ui.wait();await new Promise(resolve=>setTimeout(resolve,20));}finally{running--;}},{records});
 const upload=extra=>fetch(c.origin+'/recovery/preview',{method:'POST',headers:{Origin:c.origin,Authorization:'Bearer '+c.token,'Content-Type':'application/octet-stream',...extra},body:'synthetic-backup'});
 try{const original=await c.until('ready');assert.equal((await upload({Authorization:'Bearer invalid'})).status,401);assert.equal((await upload({Origin:'https://foreign.invalid'})).status,403);assert.equal(previews,0);assert.equal((await upload()).status,200);assert.equal(starts,1);assert.equal(running,1);
  assert.equal((await c.action(original,'restore',{id:'preview-only',consent:'wrong'})).status,409);assert.equal(confirmed,0);
  assert.equal((await c.action(original,'restore',{id:'preview-only',consent:RESTORE_CONSENT})).status,202);
  const reconnect=await c.until('consent');assert.equal(reconnect.restoring,true);assert.equal(starts,2);assert.equal(maximum,1);assert.equal((await c.action(original,'restore',{id:'preview-only',consent:RESTORE_CONSENT})).status,409);
  assert.equal((await c.action(reconnect,'cancel')).status,200);const resumed=await c.until('ready');assert.equal(resumed.restored,false);assert.equal(cancels,1);assert.equal(starts,3);assert.equal(maximum,1);
 }finally{await c.host.close();}assert.equal(running,0);
});
test('failed restore confirmation leaves the old runtime reachable and never aborts its work',async()=>{
 const { RESTORE_CONSENT }=await import('../src/app-records.mjs');let stopped=false;
 const records={available:true,clearPreview(){},canCancel:()=>false,confirm:async()=>{throw Error('CONTACT_APP_RECOVERY_PREVIEW_EXPIRED');}};
 const c=await client(async ui=>{ui.ready('http://127.0.0.1:8787/#pair=fixture');await ui.wait();stopped=true;},{records});
 try{await c.action(await c.until('ready'),'restore',{id:'expired',consent:RESTORE_CONSENT});const s=await c.until('ready');assert.match(s.url,/#pair=/u);assert.equal(stopped,false);assert.match(s.restore_error,/확인 시간이/u);}finally{await c.host.close();}
});

test('ready ends the restoration stage so later settings links can open another preview',async()=>{
 const c=await client(async ui=>{ui.recordRestore(true,'fixture@example.invalid');ui.ready('http://127.0.0.1:8787/#pair=fixture',true);await ui.wait();},{records:{available:true,clearPreview(){}}});try{const s=await c.until('ready');assert.equal(s.restoring,false);assert.equal(s.restore_account,null);assert.equal(s.restored,true);}finally{await c.host.close();}
});

for(const site of ['same-site','cross-site'])test(`conversation-to-setup document navigation allows ${site} while APIs still require same origin`,async()=>{
 const c=await client(async ui=>{ui.ready('http://127.0.0.1:8787/#pair=fixture');await ui.wait();});try{const h={'Sec-Fetch-Site':site,'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};const page=await new Promise((resolve,reject)=>{const req=request(c.origin,{headers:h},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end();});assert.equal(page.status,200);assert.match(page.text,/Tada — 시작하기/u);
 assert.equal((await fetch(c.origin+'/state',{headers:{...h,Authorization:'Bearer '+c.token}})).status,403);assert.equal((await c.action(await c.until('ready'),'retry',null,{'Sec-Fetch-Site':site})).status,403);
 assert.equal((await fetch(c.origin,{headers:{...h,'Sec-Fetch-Mode':'cors'}})).status,403);
 }finally{await c.host.close();}
});
test('corrupted recovery metadata does not turn an ordinary setup failure into an unhandled rejection',async()=>{
 const c=await client(async ui=>{ui.recordRestore(true);throw Error('CONTACT_APP_RECOVERY_INVALID');},{records:{available:true,clearPreview(){},canCancel(){throw Error('BAD_PENDING_METADATA');}}});try{const s=await c.until('error');assert.equal(s.cancel_restore,false);assert.match(s.message,/복원 준비 정보/u);}finally{await c.host.close();}
});

test('failed runtime cleanup blocks generation activation and another runtime until the process restarts',async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');let starts=0,confirmations=0;
 const c=await client(async ui=>{starts++;ui.ready('http://127.0.0.1:8787/#pair=fixture');await ui.wait();const error=Error('CONTACT_APP_CLOSE_FAILED');error.retryable=false;throw error;},{records:{available:true,clearPreview(){},canCancel:()=>true,confirm:async()=>{confirmations++;}}});
 try{await c.action(await c.until('ready'),'restore',{id:'fixture',consent:RESTORE_CONSENT});const s=await c.until('error');assert.equal(s.retryable,false);assert.equal(s.resume_url,undefined);assert.equal(starts,1);assert.match(s.message,/완전히 종료/u);assert.equal((await c.action(s,'retry')).status,409);assert.equal((await c.action(s,'restore',{id:'fixture',consent:RESTORE_CONSENT})).status,409);assert.equal(confirmations,1);}finally{await c.host.close();}
});

test('an unreadable staged archive still offers return to unchanged originals before any preservation move',async()=>{
 let pending=true,cancelled=0;const c=await client(async ui=>{if(pending)throw Error('CONTACT_BACKUP_CANNOT_OPEN');ui.ready('http://127.0.0.1:8787/#pair=fixture');await ui.wait();},{records:{available:true,clearPreview(){},canCancel:()=>pending,cancel(){cancelled++;pending=false;}}});try{const s=await c.until('error');assert.equal(s.cancel_restore,true);assert.equal((await c.action(s,'cancel_restore')).status,200);await c.until('ready');assert.equal(cancelled,1);}finally{await c.host.close();}
});
test('a failed confirmation never returns a closed real contact host, even when its entry getter still returns a URL',async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');
 const {ContactStore,contactRoute}=await import('../src/contact-store.mjs');
 const {ContactService}=await import('../src/contact-service.mjs');const {serveContact}=await import('../src/contact-http.mjs');
 const root=mkdtempSync(join(tmpdir(),'tada-closed-recovery-'));
 const store=new ContactStore({directory:join(root,'data'),passphrase:'SYNTHETIC_CLOSED_HOST_KEY',route:contactRoute({fixture:'closed-host'}),initialize:true});
 const service=new ContactService(store,{}, {definitions:[],validate:()=>false,verify:async()=>false,execute:async()=>{throw Error('NO_SOURCE');}});
 let stop,fail,contact,stopped=false;
 const c=await client(async ui=>{
  contact=await serveContact({store,service,origin:'http://127.0.0.1:0',port:0});
  ui.ready(()=>contact.pair({replaceApp:true}));await new Promise(resolve=>{stop=resolve;});
  await contact.close();stopped=true;
 },{records:{available:true,clearPreview(){},canCancel:()=>false,confirm:()=>new Promise((resolve,reject)=>{fail=reject;})}});
 try{
  await c.action(await c.until('ready'),'restore',{id:'fixture',consent:RESTORE_CONSENT});stop();
  for(let i=0;i<100&&!stopped;i++)await turn();assert.equal(stopped,true);
  assert.equal(typeof contact.pair({replaceApp:true}),'string'); // The real getter does not assert liveness.
  fail(Error('CONTACT_APP_RECOVERY_PREVIEW_EXPIRED'));const s=await c.until('error');
  assert.equal(s.resume_url,undefined);assert.equal(s.retryable,true);assert.match(s.message,/확인 시간이/u);
 }finally{stop?.();await c.host.close();await contact?.close();await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('a paired device receives no setup authority and cannot regain access after revocation',async()=>{
 const {ContactStore,contactRoute}=await import('../src/contact-store.mjs');const {ContactService}=await import('../src/contact-service.mjs');const {serveContact}=await import('../src/contact-http.mjs');
 const root=mkdtempSync(join(tmpdir(),'tada-recovery-authority-')),store=new ContactStore({directory:join(root,'data'),passphrase:'SYNTHETIC_AUTHORITY_KEY',route:contactRoute({fixture:'authority'}),initialize:true}),device=store.addDevice('paired browser');
 const service=new ContactService(store,{}, {definitions:[],validate:()=>false,verify:async()=>false,execute:async()=>{throw Error('NO_SOURCE');}});let contact,recovery,confirmed=0;
 const c=await client(async ui=>{recovery=ui.recovery;ui.ready('http://127.0.0.1:9001/#pair=owner-only');await ui.wait();},{records:{available:true,clearPreview(){},canCancel:()=>false,confirm:async()=>{confirmed++;}}});
 const call=path=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:contact.address.port,path,method:path.endsWith('restore')?'POST':'GET',headers:{Host:'127.0.0.1:0',Origin:'http://127.0.0.1:0',Cookie:'tada_local='+device.token,'Content-Type':'application/json'}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(path.endsWith('restore')?'{}':undefined);});
 try{
  await c.until('ready');contact=await serveContact({store,service,origin:'http://127.0.0.1:0',port:0,recovery});
  const result=await call('/api/records/restore');assert.equal(result.status,200);assert.equal(result.body.url,c.origin+'/#recover=1');assert.ok(!JSON.stringify(result).includes(c.token));
  assert.equal((await fetch(c.origin+'/state')).status,401);service.revoke(device.id);assert.equal((await call('/api/state')).status,401);
  assert.equal((await fetch(c.origin+'/state',{headers:{Authorization:'Bearer '+device.token}})).status,401);
  assert.equal((await fetch(c.origin+'/action',{method:'POST',headers:{Origin:c.origin,Authorization:'Bearer '+device.token,'Content-Type':'application/json'},body:JSON.stringify({action:'restore',value:{id:'fixture',consent:'restore_records_with_fresh_connections_v1'},revision:'any'})})).status,401);
  assert.equal(confirmed,0);assert.equal((await c.get()).stage,'ready');
 }finally{await c.host.close();await contact?.close();await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('confirmation failure waits for aborted host cleanup before offering a usable retry',async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');
 const {ContactStore,contactRoute}=await import('../src/contact-store.mjs');const {ContactService}=await import('../src/contact-service.mjs');const {serveContact}=await import('../src/contact-http.mjs');
 const root=mkdtempSync(join(tmpdir(),'tada-draining-recovery-')),store=new ContactStore({directory:join(root,'data'),passphrase:'SYNTHETIC_DRAINING_HOST_KEY',route:contactRoute({fixture:'draining'}),initialize:true});
 const service=new ContactService(store,{}, {definitions:[],validate:()=>false,verify:async()=>false,execute:async()=>{throw Error('NO_SOURCE');}});
 let release,fail,abort,contact,closed=false,starts=0;const draining=new Promise(resolve=>{release=resolve;});
 const c=await client(async ui=>{
  starts++;abort=ui.fail;contact=await serveContact({store,service,origin:'http://127.0.0.1:0',port:0});ui.ready(()=>contact.pair({replaceApp:true}));
  await ui.wait();await contact.close();closed=true;if(starts===1)await draining;
 },{records:{available:true,clearPreview(){},canCancel:()=>false,confirm:()=>new Promise((resolve,reject)=>{fail=reject;})}});
 try{
  await c.action(await c.until('ready'),'restore',{id:'fixture',consent:RESTORE_CONSENT});abort();
  for(let i=0;i<100&&!closed;i++)await turn();assert.equal(closed,true);fail(Error('CONTACT_APP_RECOVERY_PREVIEW_EXPIRED'));await turn();
  const waiting=await c.get();assert.equal(waiting.stage,'restoring');assert.equal(waiting.resume_url,undefined);
  release();const error=await c.until('error');assert.equal(error.retryable,true);assert.equal(error.resume_url,undefined);
  assert.equal((await c.action(error,'retry')).status,200);await c.until('ready');assert.equal(starts,2);
 }finally{release();await c.host.close();await contact?.close();await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

for(const stage of ['consent','model'])test(`failed confirmation preserves the live ${stage} question and it can still be answered`,async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');let answered=0;
 const c=await client(async ui=>{await(stage==='consent'?ui.consent():ui.selectModel([{name:'Fixture'}]));answered++;ui.ready('http://127.0.0.1:8787/#pair=fixture');await ui.wait();},{records:{available:true,clearPreview(){},canCancel:()=>false,confirm:async()=>{throw Error('CONTACT_APP_RECOVERY_PREVIEW_EXPIRED');}}});
 try{await c.action(await c.until(stage),'restore',{id:'expired',consent:RESTORE_CONSENT});const s=await c.until(stage);assert.match(s.restore_error,/확인 시간이/u);assert.equal((await c.action(s,'answer',stage==='consent'?true:'1')).status,200);assert.match((await c.until('ready')).restore_error,/확인 시간이/u);assert.equal(answered,1);}finally{await c.host.close();}
});
test('late original readiness cannot overwrite the restoration transition',async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');let finishStart,confirm,starts=0,oldReady=false;
 const c=await client(async ui=>{if(++starts===1){await new Promise(resolve=>{finishStart=resolve;});ui.ready('http://127.0.0.1:8787/#pair=old');oldReady=true;await ui.wait();}else{ui.recordRestore(true);await ui.consent();await ui.wait();}},{records:{available:true,clearPreview(){},canCancel:()=>false,confirm:()=>new Promise(resolve=>{confirm=resolve;})}});
 try{await c.action(await c.until('preparing'),'restore',{id:'valid',consent:RESTORE_CONSENT});finishStart();for(let i=0;i<100&&!oldReady;i++)await turn();assert.equal(oldReady,true);const s=await c.get();assert.equal(s.stage,'restoring');assert.equal(s.url,undefined);assert.equal(s.restore_request,'valid');confirm();const next=await c.until('consent');assert.equal(next.restoring,true);assert.equal(next.restore_request,'valid');assert.equal(starts,2);}finally{finishStart?.();confirm?.();await c.host.close();}
});
test('refreshing an original ready URL retains the failed-confirmation notice',async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');let version=0;
 const c=await client(async ui=>{ui.ready(()=>`http://127.0.0.1:8787/#pair=fixture${++version}`);await ui.wait();},{records:{available:true,clearPreview(){},canCancel:()=>false,confirm:async()=>{throw Error('CONTACT_APP_RECOVERY_PREVIEW_EXPIRED');}}});
 try{await c.action(await c.until('ready'),'restore',{id:'expired',consent:RESTORE_CONSENT});const s=await c.until('ready');assert.match(s.restore_error,/확인 시간이/u);assert.match((await c.get()).restore_error,/확인 시간이/u);}finally{await c.host.close();}
});

test('restore outcome identifiers reject malformed values before confirmation or publication',async()=>{
 const {RESTORE_CONSENT}=await import('../src/app-records.mjs');let confirmed=0;
 const c=await client(async ui=>{ui.ready('http://127.0.0.1:8787/#pair=fixture');await ui.wait();},{records:{available:true,clearPreview(){},confirm:async()=>{confirmed++;}}});
 try{for(const id of [null,{},[],7,'','a'.repeat(129),'bad\nname'])assert.equal((await c.action(await c.until('ready'),'restore',{id,consent:RESTORE_CONSENT})).status,409);assert.equal(confirmed,0);assert.equal((await c.get()).restore_request,undefined);}finally{await c.host.close();}
});
