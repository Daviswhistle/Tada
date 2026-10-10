import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { acquireAppInstance } from '../src/app-instance.mjs';
import { startApp } from '../src/start-app.mjs';
import { contactOptions } from '../src/contact-cli.mjs';
function protector() {
  const key = randomBytes(32);
  return { async protect(bytes) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }, async unprotect(bytes) {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  } };
}

test('relaunch reopens the same protected window and rotates its entry without another runtime; restart releases ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-instance-')), data = join(root, 'conversation'), os = protector();
  let first, second, third, runs = 0, entries = 0;
  const opened = [], instance = options => acquireAppInstance(options, { protector: os });
  const run = async (_args, { ui }) => {
    runs++; if (runs === 1) mkdirSync(data);
    ui.ready(() => 'http://127.0.0.1:8787/#entry=' + ++entries); await ui.wait();
  };
  try {
    first = await startApp(['--data', data, '--model', 'fixture'], { run, instance, open: async url => { opened.push(url); } });
    second = await startApp(['--model', 'fixture', '--data', data], { run, instance, open: async url => { opened.push(url); } });
    assert.equal(first.url, second.url); assert.equal(runs, 1); assert.equal(entries, 2);
    assert.deepEqual(opened, [first.url, first.url]);
    const secret = new URLSearchParams(new URL(first.url).hash.slice(1)).get('setup');
    assert.equal(readFileSync(data + '.app-private/window.json', 'utf8').includes(secret), false);
    await assert.rejects(acquireAppInstance(contactOptions(['--data', data, '--port', '8799']), { protector: os }), /SETTINGS_IN_USE/);
    await second.close();
    const state = await fetch(new URL(first.url).origin + '/state', { headers: { Authorization: 'Bearer ' + secret } });
    assert.equal(state.status, 200, 'closing a relaunch does not stop the original owner');
    await first.close(); await first.close();
    third = await startApp(['--data', data, '--model', 'fixture'], { run, instance, open: async () => {} });
    assert.notEqual(first.url, third.url); assert.equal(runs, 2);
  } finally { await third?.close(); await second?.close(); await first?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('instance discovery rejects a symlinked private directory', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-path-')), data = join(root, 'conversation'), target = join(root, 'other');
  mkdirSync(target); symlinkSync(target, data + '.app-private');
  try { await assert.rejects(acquireAppInstance(contactOptions(['--data', data]), { protector: protector() }), /PRIVATE_PATH_REQUIRED/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux service handoff waits for the existing lease, opens no browser, and never repeats initialization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-background-owner-')), data = join(root, 'conversation'), os = protector();
  let first, second, pending, runs = 0; const opened = [], argsSeen = [], written = [];
  const instance = (options, config) => acquireAppInstance(options, { ...config, protector: os });
  const run = async (args, { ui }) => { runs++; argsSeen.push(args); if (runs === 1) mkdirSync(data); ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait(); };
  const stdout = process.stdout.write;
  try {
    first = await startApp(['--data', data], { run, instance, platform: 'linux', open: async url => { opened.push(url); } });
    process.stdout.write = function (chunk, ...rest) { written.push(String(chunk)); const callback = rest.find(value => typeof value === 'function'); callback?.(); return true; };
    pending = startApp(['--background', '--data', data], { run, instance, platform: 'linux', open: async url => { opened.push(url); } });
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(runs, 1);
    await first.close(); second = await pending;
    assert.equal(runs, 2); assert.equal(opened.length, 1);
    assert.equal(argsSeen[1].includes('--init'), false); assert.equal(argsSeen[1].includes('--background'), false);
    assert.equal(written.join('').includes('#setup='), false);
    await assert.rejects(startApp(['--background', '--init', '--data', data]), /SETTINGS_INVALID/);
  } finally { process.stdout.write = stdout; await second?.close(); await first?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('explicit initialization retries the newly created journal after a contact port collision', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createHash } = await import('node:crypto');
  const { ChatGPTStore } = await import('../../providers/src/chatgpt-store.mjs');
  const { ContactStore, contactRoute } = await import('../src/contact-store.mjs');
  const { main } = await import('../src/contact-cli.mjs');
  const root = mkdtempSync(join(tmpdir(), 'tada-app-init-retry-')), data = join(root, 'conversation'), os = protector();
  const passphrase = 'synthetic setup retry fixture passphrase';
  const account = new ChatGPTStore({ directory: data + '.chatgpt-private', passphrase });
  account.save({ ...account.read(), client: 'oaiapp_fixture', subject: 'fixture-subject', email: 'fixture@example.invalid', model: 'fixture-model',
    tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_at: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] } });
  account.close();
  const blocker = createServer((_req, res) => { res.writeHead(404); res.end(); });
  blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port, nativeFetch = globalThis.fetch; let app, initialized = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, options);
    assert.equal(String(url), 'https://api.openai.com/v1/models');
    return new Response(JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const route = contactRoute({ version: 1, provider: 'chatgpt-subscription', model: 'fixture-model',
    digest: createHash('sha256').update('oaiapp_fixture:fixture-subject:fixture-model').digest('hex'), endpoint: 'https://api.openai.com/v1', scopes: [] });
  try {
    app = await startApp(['--data', data, '--init', '--port', String(port)], { open: async () => {},
      instance: options => acquireAppInstance(options, { protector: os }),
      run: (args, { ui }) => main(args, { keyProvider: async () => passphrase, ui: { ...ui, initialized() { initialized++; ui.initialized(); } } }) });
    const url = new URL(app.url), headers = { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('setup') };
    const until = async stage => {
      for (let i = 0; i < 200; i++) { const state = await nativeFetch(url.origin + '/state', { headers }).then(r => r.json()); if (state.stage === stage) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw Error('SETUP_STAGE_TIMEOUT:' + stage);
    };
    const failed = await until('error'); assert.match(failed.message, /주소가 이미 사용/u);
    const before = new ContactStore({ directory: data, passphrase, route }); const id = before.id; before.close();
    await new Promise(resolve => blocker.close(resolve));
    assert.equal((await nativeFetch(url.origin + '/action', { method: 'POST', headers: { ...headers, Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: failed.revision, action: 'retry', value: null }) })).status, 200);
    const ready = await until('ready'); assert.ok(ready.url.startsWith(`http://127.0.0.1:${port}/#pair=`));
    assert.equal(initialized, 1);
    await app.close();
    const after = new ContactStore({ directory: data, passphrase, route }); assert.equal(after.id, id); after.close();
  } finally { await app?.close(); if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); globalThis.fetch = nativeFetch; rmSync(root, { recursive: true, force: true }); }
});

test('ordinary reopen ignores completed launch actions without silently accepting new actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-actions-')), data = join(root, 'conversation'), os = protector();
  const instance = options => acquireAppInstance(options, { protector: os });
  let app, runs = 0;
  const run = async (_args, { ui }) => { runs++; ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait(); };
  try {
    app = await startApp(['--data', data, '--login', '--upgrade-contact'], { run, instance, open: async () => {} });
    const plain = await instance(contactOptions(['--data', data]));
    const repeat = await instance(contactOptions(['--data', data, '--login', '--upgrade-contact']));
    assert.equal(plain.url, app.url); assert.equal(repeat.url, app.url); assert.equal(runs, 1);
    await app.close();
    app = await startApp(['--data', data], { run, instance, open: async () => {} });
    for (const flag of ['--login', '--upgrade-contact']) {
      await assert.rejects(instance(contactOptions(['--data', data, flag])), /ACTION_REQUIRES_RESTART/);
    }
    assert.equal(runs, 2);
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('window publication failure opens a useful error screen and releases ownership before any runtime starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-app-publish-')), data = join(root, 'conversation');
  const broken = { ...protector(), async protect() { throw Error('CONTACT_OS_PROTECTION_FAILED'); } };
  let app, runs = 0; const opened = [];
  try {
    app = await startApp(['--data', data], { instance: options => acquireAppInstance(options, { protector: broken }),
      run: async () => { runs++; }, open: async url => { opened.push(url); } });
    assert.equal(runs, 0); assert.deepEqual(opened, [app.url]);
    const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('setup');
    const state = await fetch(url.origin + '/state', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    assert.equal(state.stage, 'error'); assert.equal(state.retryable, false); assert.match(state.message, /Windows 계정/u);
    const replacement = await acquireAppInstance(contactOptions(['--data', data]), { protector: protector() });
    assert.equal(replacement.existing, false); replacement.close();
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('relative TLS paths reopen the same instance after absolute background launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-tls-reopen-')), data = join(root, 'conversation'), os = protector();
  const cert = join(root, 'cert.pem'), key = join(root, 'key.pem'); let app, reopened, runs = 0;
  const instance = (options, config) => acquireAppInstance(options, { ...config, protector: os });
  const run = async (_args, { ui }) => { runs++; mkdirSync(data); ui.ready('https://localhost:8787/#entry=fixture'); await ui.wait(); };
  try {
    app = await startApp(['--data', data, '--origin', 'https://localhost:8787', '--tls-cert', cert, '--tls-key', key], { instance, run, open: async () => {} });
    reopened = await startApp(['--data', data, '--origin', 'https://localhost:8787', '--tls-cert', relative(process.cwd(), cert), '--tls-key', relative(process.cwd(), key)], { instance, run, open: async () => {} });
    assert.equal(runs, 1); assert.equal(reopened.url, app.url);
  } finally { await reopened?.close(); await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('browser launch failure closes its new host and lease; a failed reopen preserves the existing owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-browser-failed-')), data = join(root, 'conversation'), os = protector();
  const instance = options => acquireAppInstance(options, { protector: os });
  const signals = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  let app, failedURL;
  const run = async (_args, { ui }) => { ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait(); };
  try {
    await assert.rejects(startApp(['--data', data], { instance, run, open: async url => { failedURL = url; return false; } }), /CONTACT_APP_BROWSER_UNAVAILABLE/);
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), signals);
    await assert.rejects(fetch(new URL(failedURL).origin));
    app = await startApp(['--data', data], { instance, run, open: async () => true });
    await assert.rejects(startApp(['--data', data], { instance, run, open: async () => false }), /CONTACT_APP_BROWSER_UNAVAILABLE/);
    assert.equal((await fetch(new URL(app.url).origin)).status, 200);
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an unavailable browser also closes the failure screen', async () => {
  let failedURL;
  await assert.rejects(startApp([], { instance: async () => { throw Error('CONTACT_OS_PROTECTION_FAILED'); }, open: async url => { failedURL = url; return false; } }), /CONTACT_APP_BROWSER_UNAVAILABLE/);
  await assert.rejects(fetch(new URL(failedURL).origin));
});

test('launcher loss aborts a waiting instance and closes an owned setup without touching another owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-parent-loss-')), data = join(root, 'conversation'), os = protector();
  let app;
  const controller = new AbortController();
  const instance = (options, config) => acquireAppInstance(options, { ...config, protector: os });
  try {
    app = await startApp(['--data', data], { instance, signal: controller.signal, open: async () => {},
      run: async (_args, { ui }) => { mkdirSync(data); ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait(); } });
    const waiting = new AbortController();
    const pending = acquireAppInstance(contactOptions(['--data', data]), { protector: os, reopen: false, timeoutMs: Infinity, signal: waiting.signal });
    waiting.abort(); await assert.rejects(pending, /aborted/u);
    assert.equal((await instance(contactOptions(['--data', data]))).existing, true);
    controller.abort(); await app.close();
    const released = await instance(contactOptions(['--data', data])); assert.equal(released.existing, false); released.close();
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('launcher loss also closes a startup failure screen without leaving a host', async () => {
  const parent = new AbortController(); let app;
  try {
    app = await startApp(['--data', '/unused-parent-failure'], { signal: parent.signal, instance: async () => { throw Error('CONTACT_APP_PRIVATE_PATH_REQUIRED'); }, open: async () => {} });
    assert.equal((await fetch(new URL(app.url).origin)).status, 200);
    parent.abort(); await app.close();
    await assert.rejects(fetch(new URL(app.url).origin));
  } finally { await app?.close(); }
});

test('foreground recovery before model selection preserves visible setup and initializes the journal once', async () => {
  const { existsSync } = await import('node:fs');
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { ChatGPTStore } = await import('../../providers/src/chatgpt-store.mjs');
  const { main } = await import('../src/contact-cli.mjs');
  const root = mkdtempSync(join(tmpdir(), 'tada-onboarding-recovery-')), data = join(root, 'conversation');
  const passphrase = 'synthetic onboarding recovery passphrase';
  const account = new ChatGPTStore({ directory: data + '.chatgpt-private', passphrase });
  account.save({ ...account.read(), client: 'oaiapp_fixture', subject: 'fixture-subject', email: 'fixture@example.invalid',
    tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_at: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] } });
  account.close();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const nativeFetch = globalThis.fetch, opened = []; let first, recovered, ready = 0, initialized = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, options);
    assert.equal(String(url), 'https://api.openai.com/v1/models');
    return new Response(JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const os = protector(), fixture = {
    instance: (options, config) => acquireAppInstance(options, { ...config, protector: os }),
    open: async url => { opened.push(url); }, onReady: () => { ready++; }, backgroundFactory: () => ({}),
    run: (args, { ui }) => main(args, { keyProvider: async () => passphrase, ui: { ...ui, initialized() { initialized++; ui.initialized(); } } }),
  };
  const endpoint = app => { const url = new URL(app.url); return { origin: url.origin, headers: { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('setup') } }; };
  const until = async (app, stage) => {
    const { origin, headers } = endpoint(app);
    for (let i = 0; i < 200; i++) { const state = await nativeFetch(origin + '/state', { headers }).then(r => r.json()); if (state.stage === stage) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('SETUP_STAGE_TIMEOUT:' + stage);
  };
  try {
    first = await startApp(['--data', data, '--port', String(port)], fixture);
    await until(first, 'model'); assert.equal(ready, 0); assert.equal(existsSync(data), false); await first.close();
    recovered = await startApp(['--data', data, '--port', String(port)], fixture);
    const model = await until(recovered, 'model'); assert.equal(ready, 0);
    assert.equal(opened.length, 2); assert.notEqual(opened[0], opened[1]);
    const { origin, headers } = endpoint(recovered);
    const action = await nativeFetch(origin + '/action', { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: model.revision, action: 'answer', value: '1' }) });
    assert.equal(action.status, 200); await until(recovered, 'ready');
    assert.equal(ready, 1); assert.equal(initialized, 1); assert.equal(existsSync(join(data, 'contact.sqlite')), true);
  } finally { await recovered?.close(); await first?.close(); globalThis.fetch = nativeFetch; rmSync(root, { recursive: true, force: true }); }
});

test('Windows background relaunch exits against the existing owner instead of waiting to revive a stopped app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-windows-owner-')), data = join(root, 'conversation'), os = protector();
  let first, second, runs = 0; const opened = [];
  const config = { platform: 'win32', instance: (options, config) => acquireAppInstance(options, { ...config, protector: os }),
    backgroundFactory: () => ({}), open: async url => { opened.push(url); },
    run: async (_args, { ui }) => { runs++; ui.ready('http://127.0.0.1:8787/#entry=fixture'); await ui.wait(); } };
  try {
    first = await startApp(['--data', data], config); second = await startApp(['--background', '--data', data], config);
    assert.equal(second.owned, undefined); assert.equal(second.url, first.url); assert.equal(runs, 1); assert.equal(opened.length, 1);
    await first.reopen(); assert.equal(opened.length, 2); assert.equal(opened[1], first.url);
    await second.close(); await first.close(); await first.reopen(); assert.equal(opened.length, 2); assert.equal(runs, 1);
  } finally { await second?.close(); await first?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('normal app disables its own startup only after drain and before confirmed erasure',async()=>{
 const {randomUUID}=await import('node:crypto');const {ERASE_CONSENT}=await import('../src/app-privacy.mjs');
 const root=mkdtempSync(join(tmpdir(),'tada-app-erase-')),data=join(root,'conversation'),os=protector(),events=[];let app;
 const background={status:async()=>({available:true,enabled:true,error:null}),configure:async(enabled,consent,authorize)=>{authorize();assert.equal(enabled,false);assert.equal(consent,null);assert.deepEqual(events,['closed']);events.push('disabled');return{enabled:false};}};
 try{
  app=await startApp(['--data',data],{instance:options=>acquireAppInstance(options,{protector:os}),open:async()=>{},backgroundFactory:()=>background,run:async(_,{ui})=>{mkdirSync(data,{mode:0o700});ui.ready('http://127.0.0.1:9001/');await ui.wait();events.push('closed');}});
  const url=new URL(app.url),authorization='Bearer '+new URLSearchParams(url.hash.slice(1)).get('setup'),headers={Authorization:authorization};
  const state=()=>fetch(url.origin+'/state',{headers}).then(r=>r.json());let ready;for(let i=0;i<100;i++){ready=await state();if(ready.stage==='ready')break;await new Promise(r=>setTimeout(r,10));}assert.equal(ready.stage,'ready');
  const response=await fetch(url.origin+'/action',{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({action:'erase',revision:ready.revision,value:{id:randomUUID(),consent:ERASE_CONSENT}})});assert.equal(response.status,202);
  let done;for(let i=0;i<100;i++){done=await state();if(done.stage==='erased')break;await new Promise(r=>setTimeout(r,10));}assert.equal(done.stage,'erased');assert.deepEqual(events,['closed','disabled']);
 }finally{await app?.close();rmSync(root,{recursive:true,force:true});}
});

for(const interrupted of [false,true])test('background owner fresh-start creates new storage and survives onboarding restart: '+interrupted,async()=>{
 const {randomUUID}=await import('node:crypto');const {AppPrivacy,ERASE_CONSENT}=await import('../src/app-privacy.mjs');const {contactStorageKey}=await import('../src/contact-key.mjs');const {ContactStore,contactRoute}=await import('../src/contact-store.mjs');
 const root=mkdtempSync(join(tmpdir(),'tada-background-fresh-')),data=join(root,'conversation'),os={...protector(),kind:'windows-dpapi-v1'},route=contactRoute({fixture:'fresh-background'}),initialKey=await contactStorageKey({data,initialize:true,protector:os});
 const old=new ContactStore({directory:data,passphrase:initialKey,route,initialize:true});old.submit(old.addDevice('old').id,randomUUID(),'old work');old.close();
 const args=['--background','--provider','ollama','--model','synthetic-model','--data',data],initializations=[];let app,paused=false,newTurns=null;
 const config={instance:options=>acquireAppInstance(options,{protector:os}),open:async()=>{},backgroundFactory:()=>({status:async()=>({available:true,enabled:true,error:null}),configure:async()=>({enabled:false})}),run:async(raw,{ui})=>{
  const options=contactOptions(raw);initializations.push(options.initialize);const key=await contactStorageKey({data,initialize:options.initialize,protector:os});
  if(options.initialize&&interrupted&&!paused){paused=true;await ui.wait();return;}
  const store=new ContactStore({directory:data,passphrase:key,route,initialize:options.initialize});try{newTurns=store.page().turns.length;if(options.initialize)ui.initialized();ui.ready('http://127.0.0.1:9001/');await ui.wait();}finally{store.close();}
 }};
 const connect=app=>{const url=new URL(app.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('setup')};return{state:()=>fetch(url.origin+'/state',{headers}).then(r=>r.json()),act:(s,action,value)=>fetch(url.origin+'/action',{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({action,value,revision:s.revision})})};};
 const until=async(net,stage)=>{for(let i=0;i<100;i++){const s=await net.state();if(s.stage===stage)return s;await new Promise(r=>setTimeout(r,10));}throw Error('NOT_'+stage);};
 try{
  app=await startApp(args,config);let net=connect(app);await net.act(await until(net,'ready'),'erase',{id:randomUUID(),consent:ERASE_CONSENT});await net.act(await until(net,'erased'),'start_fresh',true);
  if(interrupted){for(let i=0;i<100&&!paused;i++)await new Promise(r=>setTimeout(r,10));assert.equal(paused,true);await app.close();assert.equal(new AppPrivacy({data,provider:'ollama'}).status().phase,'new');app=await startApp(args,config);net=connect(app);}
  const ready=await until(net,'ready');assert.equal(ready.restore_available,true);assert.equal(newTurns,0);assert.deepEqual(initializations,interrupted?[false,true,true]:[false,true]);assert.equal(new AppPrivacy({data,provider:'ollama'}).status().phase,null);
 }finally{await app?.close();rmSync(root,{recursive:true,force:true});}
});
