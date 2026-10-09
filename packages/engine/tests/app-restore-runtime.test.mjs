// Synthetic accounts only: exercise the real subscription login, CLI, SQLite,
// encrypted key/config and generation switch. No external request is admitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { AppRecords,RESTORE_CONSENT } from '../src/app-records.mjs';
import { ContactStore,contactRoute } from '../src/contact-store.mjs';
import { contactStorageKey } from '../src/contact-key.mjs';
import { createRecordBackup } from '../src/contact-backup.mjs';
import { main } from '../src/contact-cli.mjs';
import { loadGoogleClientConfig } from '../src/google-client-config.mjs';
import { ChatGPTStore } from '../../providers/src/chatgpt-store.mjs';
const protector={kind:'windows-dpapi-v1',protect:async key=>Buffer.from(key),unprotect:async key=>Buffer.from(key)};
const passphrase='SYNTHETIC_RESTORE_SOURCE_KEY',sourceRoute=contactRoute({fixture:'restore-runtime'});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
let nextPort=18000+process.pid%10000;
async function port(){for(let attempt=0;attempt<100;attempt++){const s=createServer(),p=nextPort++;try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(p,'127.0.0.1',resolve);});await new Promise(resolve=>s.close(resolve));return p;}catch(error){if(error.code!=='EADDRINUSE')throw error;}}throw Error('NO_FIXTURE_PORT');}
function fixture(){const root=mkdtempSync(join(tmpdir(),'tada-restore-runtime-')),data=join(root,'conversation');mkdirSync(data+'.app-private',{mode:0o700});mkdirSync(data,{mode:0o700});writeFileSync(join(data,'original'),'ORIGINAL_UNTOUCHED',{mode:0o600});return{root,data,close:()=>rmSync(root,{recursive:true,force:true})};}
async function stage(f,provider,options={}){
 const source=new ContactStore({directory:join(f.root,'source'),passphrase,route:sourceRoute,initialize:true,mail:true});let snapshot;
 try{const device=source.addDevice('synthetic old device');source.submit(device.id,'historical-request','예전 요청은 다시 실행하지 마세요');snapshot=source.exportRecords(device.id,{provider,google_client:{client_id:'1234567890-fixture.apps.googleusercontent.com',client_secret:'FAKE_GOOGLE_CLIENT_SECRET'}});}finally{source.close();}
 const archive=await createRecordBackup(snapshot,{protector});const records=new AppRecords({...options,data:f.data,provider:provider.kind==='chatgpt-subscription'?'chatgpt':'ollama'},{protector});const preview=await records.preview(archive.bytes);assert.equal(preview.new_registration_required,provider.kind==='chatgpt-subscription'&&!provider.client_id);await records.confirm(preview.id,RESTORE_CONSENT);return records;
}

for(const requestedModel of [null,'unavailable-model'])test(`actual subscription restore reconnects the bound identity and preserves a replacement model across restart: ${requestedModel}`,async()=>{
 const f=fixture(),nativeFetch=globalThis.fetch;let nonce,wrong=true,wrongClient=true,callbacks=[],ready=0,modelCalls=0,requestCalls=0,consents=0,picks=0;const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'restore-fixture',use:'sig',alg:'RS256'};
 const records=await stage(f,{kind:'chatgpt-subscription',subject:'expected-fixture-owner',label:'fixture@example.invalid',model:'fixture-model',client_id:'oaiapp_fixture'},{...(requestedModel?{model:requestedModel}:{})});
 globalThis.fetch=async(url,options)=>{
  const target=String(url);
  if(target.startsWith('http://127.0.0.1:'))return nativeFetch(url,options);
  if(target==='https://auth.openai.com/.well-known/openid-configuration')return json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/keys',revocation_endpoint:'https://auth.openai.com/revoke'});
  if(target==='https://auth.openai.com/keys')return json({keys:[jwk]});
  if(target==='https://api.openai.com/v1/models'){modelCalls++;return json({models:[{slug:'fixture-model',display_name:'Fixture Model',visibility:'list'}]});}
  if(target==='https://auth.openai.com/api/accounts/oauth/token'){
   const token=await new SignJWT({nonce,email:'fixture@example.invalid'}).setProtectedHeader({alg:'RS256',kid:'restore-fixture'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_fixture').setSubject(wrong?'wrong-fixture-owner':'expected-fixture-owner').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
   return json({access_token:'FAKE_NEW_ACCESS',refresh_token:'FAKE_NEW_REFRESH',token_type:'Bearer',expires_in:3600,scope:'openid chatgpt.tokens.use.direct',id_token:token});
  }
  requestCalls++;throw Error('FIXTURE_REJECTS_EXTERNAL_REQUEST: '+target);
 };
 const args=['--data',f.data,'--port',String(await port()),...(requestedModel?['--model',requestedModel]:[])];
 const run=async()=>{
  const context=await records.context();const ui={signal:new AbortController().signal,consent:async()=>{consents++;return true;},login:url=>{const auth=new URL(url);assert.equal(auth.searchParams.get('client_id'),'oaiapp_fixture');nonce=auth.searchParams.get('nonce');const callback=new URL(auth.searchParams.get('redirect_uri'));callback.searchParams.set('state',auth.searchParams.get('state'));callback.searchParams.set('client_id',wrongClient?'oaiapp_another_workspace':'oaiapp_fixture');callback.searchParams.set('code','synthetic-only');callbacks.push(nativeFetch(callback));},selectModel:async()=>{assert.ok(requestedModel);picks++;return '1';},ready:()=>{ready++;assert.ok(lstatSync(f.data).isFile());},wait:async()=>{},fail:()=>{throw Error('RUNTIME_FAULT');}};
  await main(args,{ui,storageContext:context,keyProvider:options=>contactStorageKey({...options,protector})});
 };
 try{
  await assert.rejects(run(),/CHATGPT_REGISTRATION_REJECTED/u);assert.equal(ready,0);assert.equal(modelCalls,0);wrongClient=false;
  await assert.rejects(run(),/CHATGPT_ACCOUNT_CHANGED/u);assert.equal(ready,0);assert.equal(modelCalls,0);assert.equal(readFileSync(join(f.data,'original'),'utf8'),'ORIGINAL_UNTOUCHED');assert.equal(records.canCancel(),true);
  let context=await records.context();let key=await contactStorageKey({data:context.data,profile:context.keyProfile,initialize:true,protector});let profile=new ChatGPTStore({directory:context.profile,passphrase:key});assert.equal(profile.read().subject,'expected-fixture-owner');assert.equal(profile.read().client,'oaiapp_fixture');assert.equal(profile.read().tokens,null);profile.close();
  wrong=false;await run();assert.equal(ready,1);await run();assert.equal(ready,2);assert.equal(consents,3);assert.equal(requestCalls,0);assert.equal(picks,requestedModel?1:0);
  if(requestedModel){const reopened=new AppRecords({data:f.data,provider:'chatgpt',model:requestedModel},{protector});assert.equal((await reopened.context()).modelChoice,'fixture-model');const changed=new AppRecords({data:f.data,provider:'chatgpt',model:'deliberate-new-model'},{protector});assert.equal((await changed.context()).modelChoice,null);}
  context=await records.context();key=await contactStorageKey({data:context.data,profile:context.keyProfile,protector});profile=new ChatGPTStore({directory:context.profile,passphrase:key});assert.equal(profile.read().tokens.access_token,'FAKE_NEW_ACCESS');profile.close();
  // Open using the route created by the actual provider, not the source route.
  const { DatabaseSync }=await import('node:sqlite');const db=new DatabaseSync(join(context.data,'contact.sqlite'),{readOnly:true});const route=db.prepare("SELECT route FROM identity WHERE singleton=1").get().route;db.close();
  const store=new ContactStore({directory:context.data,passphrase:key,route});assert.equal(store.claim(),null);assert.ok(store.readTurn(1).recovery);const config=loadGoogleClientConfig({data:context.data,passphrase:key,store,env:{}});assert.equal(config.clientSecret,'FAKE_GOOGLE_CLIENT_SECRET');assert.equal(store.googleCredential(),null);store.close();
 }finally{await Promise.allSettled(callbacks);globalThis.fetch=nativeFetch;f.close();}
});

test('local-model restore retains a stable fresh key across candidate-directory publication and restart',async()=>{
 const f=fixture(),nativeFetch=globalThis.fetch;let ready=0,calls=0;
 const records=await stage(f,{kind:'ollama-local',subject:null,label:null,model:'fixture-local'});
 const upstream=createServer((req,res)=>{calls++;req.resume();const body=req.url==='/api/tags'?{models:[{name:'fixture-local:latest',size:1024,digest:'a'.repeat(64)}]}:req.url==='/api/show'?{capabilities:['completion','tools'],details:{format:'gguf'}}:req.url==='/api/version'?{version:'0.0.fixture'}:null;res.writeHead(body?200:400,{'content-type':'application/json'});res.end(JSON.stringify(body));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 globalThis.fetch=async()=>{throw Error('FIXTURE_REJECTS_EXTERNAL_REQUEST');};
 try{for(let n=0;n<2;n++){const context=await records.context();await main(['--data',f.data,'--provider','ollama','--model','fixture-local','--endpoint','http://127.0.0.1:'+upstream.address().port,'--port',String(await port())],{storageContext:context,keyProvider:options=>contactStorageKey({...options,protector}),ui:{signal:new AbortController().signal,ready:()=>{ready++;},wait:async()=>{},fail:()=>{throw Error('RUNTIME_FAULT');}}});}assert.equal(ready,2);assert.equal(calls,6);assert.equal((await records.context()).initialize,false);}finally{globalThis.fetch=nativeFetch;await new Promise(resolve=>upstream.close(resolve));f.close();}
});

test('a catalog change after staged publication rebuilds only the inactive candidate and reaches the new model',async()=>{
 const f=fixture(),nativeFetch=globalThis.fetch;let original,models=['model-a'],picks=0,ready=0;
 try{
  rmSync(f.data,{recursive:true});original=new ContactStore({directory:f.data,passphrase,route:sourceRoute,initialize:true});
  const records=await stage(f,{kind:'chatgpt-subscription',subject:'fixture-owner',label:'fixture@example.invalid',model:'model-a',client_id:'oaiapp_fixture'});
  let c=await records.context();const key=await contactStorageKey({data:c.data,profile:c.keyProfile,initialize:true,protector});
  const profile=new ChatGPTStore({directory:c.profile,passphrase:key});profile.save({...profile.read(),client:'oaiapp_fixture',subject:'fixture-owner',email:'fixture@example.invalid',tokens:{access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',scopes:['chatgpt.tokens.use.direct'],expires_at:Date.now()+3600000}});profile.close();
  globalThis.fetch=async url=>{assert.equal(String(url),'https://api.openai.com/v1/models');return json({models:models.map(slug=>({slug,display_name:slug,visibility:'list'}))});};
  const args=['--data',f.data,'--port',String(await port())];
  const run=async()=>main(args,{storageContext:await records.context(),keyProvider:o=>contactStorageKey({...o,protector}),ui:{signal:new AbortController().signal,selectModel:async()=>{picks++;return '1';},ready:()=>{ready++;},wait:async()=>{},fail:()=>{throw Error('RUNTIME_FAULT');}}});
  await assert.rejects(run(),/SOURCE_IN_USE/u);assert.equal(ready,0);original.close();original=null;
  models=['model-b'];await run();assert.equal(ready,1);assert.equal(picks,1);await run();assert.equal(ready,2);assert.equal(picks,1);
  c=await records.context();assert.equal(c.restoring,false);assert.equal(c.modelChoice,'model-b');
  // Once active, a new unavailable catalog must not silently reinitialize history.
  const before=readFileSync(join(c.data,'contact.sqlite'));models=['model-c'];await assert.rejects(run(),/CHATGPT_MODEL_UNAVAILABLE/u);assert.deepEqual(readFileSync(join(c.data,'contact.sqlite')),before);
 }finally{original?.close();globalThis.fetch=nativeFetch;f.close();}
});
