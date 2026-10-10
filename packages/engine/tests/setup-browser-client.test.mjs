import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../../../apps/contact/setup.js', import.meta.url), 'utf8');
const token = 'a'.repeat(43);
const storage = (data = new Map()) => ({ data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) });
async function client({ hash = '', local = storage(), session = storage(), status = 200, state = {stage:'consent',revision:'fixture-state'}, fetcher } = {}) {
  const elements = new Map(), calls = [], events = new Map(); let reloads = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', value: '', replaceChildren() {} }); return elements.get(id); };
  const navigations=[];const location = { hash, pathname: '/', replace:url=>navigations.push(url), reload: () => { reloads++; } };
  const context = { crypto:{randomUUID}, URLSearchParams, AbortController, clearTimeout, location, history: { replaceState() { location.hash = ''; } },
    window: { localStorage: local, sessionStorage: session, addEventListener: (name, handler) => events.set(name, handler) },
    document: { getElementById: get, querySelectorAll: () => [], createElement: () => ({}) }, setTimeout() {},
    fetch: async (path, options) => { calls.push({ path, authorization: options.headers.Authorization }); return fetcher ? fetcher(path,options) : { status, ok: status === 200, json: async () => state }; },
  };
  vm.createContext(context); vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, location, events, local, session, navigations, poll:()=>context.poll(), render:value=>context.render(value), reloads: () => reloads };
}
test('the same running setup resumes after browser restart loses session storage and fragment', async () => {
  const local = storage();
  const first = await client({ hash: '#setup=' + token, local });
  assert.equal(first.location.hash, ''); assert.equal(first.calls[0].authorization, 'Bearer ' + token);
  const reopened = await client({ local, session: storage() });
  assert.equal(reopened.calls[0].authorization, 'Bearer ' + token);
  assert.equal(reopened.get('consent').hidden, false);
});
test('a rejected startup token is cleared and shows an error instead of indefinite preparation', async () => {
  const local = storage(new Map([['tada-setup', token]])), session = storage(new Map([['tada-setup', token]]));
  const c = await client({ local, session, status: 401 });
  assert.equal(local.data.size, 0); assert.equal(session.data.size, 0);
  assert.equal(c.get('error').hidden, false); assert.equal(c.get('retry').hidden, true);
  assert.match(c.get('description').textContent, /연결이 만료/u);
});
test('a fresh capability link replaces stale storage and reopening it in the same tab reloads', async () => {
  const local = storage(new Map([['tada-setup', 'b'.repeat(43)]]));
  const c = await client({ hash: '#setup=' + token, local });
  assert.equal(c.calls[0].authorization, 'Bearer ' + token); assert.equal(local.getItem('tada-setup'), token);
  c.location.hash = '#setup=' + 'c'.repeat(43); c.events.get('hashchange')(); assert.equal(c.reloads(), 1);
  c.location.hash = '#setup=invalid'; c.events.get('hashchange')(); assert.equal(c.reloads(), 1);
});
test('blocked browser storage still permits the explicit startup link without leaking it into the URL', async () => {
  const unavailable = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  const c = await client({ hash: '#setup=' + token, local: unavailable, session: unavailable });
  assert.equal(c.calls[0].authorization, 'Bearer ' + token); assert.equal(c.location.hash, '');
});


test('restore entry keeps a ready conversation on the preview screen and close returns to it',async()=>{
 const c=await client({hash:'#setup='+token+'&recover=1',state:{stage:'ready',revision:'a',restore_available:true,url:'http://127.0.0.1:9001/'}});
 assert.equal(c.navigations.length,0);assert.equal(c.get('restore-panel').hidden,false);assert.equal(c.get('ready').hidden,true);
 c.get('restore-close').onclick();assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);assert.equal(c.get('restore-code').value,'');
});
test('a restore navigation uses only the original launch authority already held by this browser',async()=>{
 const local=storage(new Map([['tada-setup',token]]));
 const c=await client({hash:'#recover=1',local,state:{stage:'ready',revision:'a',restore_available:true,url:'http://127.0.0.1:9001/'}});
 assert.equal(c.calls[0].authorization,'Bearer '+token);assert.equal(c.get('restore-panel').hidden,false);assert.equal(c.navigations.length,0);
 const unpaired=await client({hash:'#recover=1',status:401});assert.notEqual(unpaired.calls[0].authorization,'Bearer '+token);assert.equal(unpaired.get('restore-panel').hidden,true);
});
test('late preview completion cannot redisplay a replaced file and file replacement remains usable',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>path==='/state'?{status:200,ok:true,json:async()=>({stage:'ready',revision:'a',restore_available:true,url:'http://127.0.0.1:9001/'})}:await gate});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];const pending=c.get('restore-preview').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(c.get('restore-preview').disabled,true);
 c.get('restore-file').onchange();assert.equal(c.get('restore-preview').disabled,false);
 release({status:200,ok:true,json:async()=>({preview:{id:'stale',created_at:0,turns:1,documents:0,work:0}})});await pending;assert.equal(c.get('restore-summary').hidden,true);
});
test('binary preview authorization loss clears the code and capability and shows a usable expiration message',async()=>{
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>({status:path==='/state'?200:401,ok:path==='/state',json:async()=>({stage:'ready',revision:'a',restore_available:true,url:'http://127.0.0.1:9001/'})})});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];c.get('restore-code').value='SYNTHETIC_CODE';await c.get('restore-preview').onclick();assert.equal(c.local.data.size,0);assert.equal(c.session.data.size,0);assert.equal(c.get('restore-code').value,'');assert.equal(c.get('restore-panel').hidden,true);assert.equal(c.get('error').hidden,false);assert.match(c.get('description').textContent,/만료/u);
});
test('reconnection shows the archive account with cancellation in consent, login and model stages',async()=>{
 const c=await client({hash:'#setup='+token+'&recover=1'});
 for(const stage of ['consent','login','model']){c.render({stage,revision:stage,restoring:true,restore_available:true,restore_account:'fixture@example.invalid',models:[{name:'Fixture'}]});assert.equal(c.get('restore-panel').hidden,true);assert.equal(c.get('restore-cancel').hidden,false);assert.match(c.get('description').textContent,/fixture@example.invalid/u);}
 c.render({stage:'ready',revision:'completed',restored:true,restoring:true,url:'http://127.0.0.1:9001/'});assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);
});

test('opening restore again after a completed restore does not redirect back before preview',async()=>{
 const c=await client({hash:'#setup='+token+'&recover=1',state:{stage:'ready',revision:'previously-restored',restore_available:true,restoring:false,restored:true,url:'http://127.0.0.1:9001/'}});assert.equal(c.get('restore-panel').hidden,false);assert.equal(c.navigations.length,0);
});
test('a host failure after activation still enters the restored conversation when retry becomes ready',async()=>{
 const c=await client({hash:'#setup='+token+'&recover=1'});
 c.render({stage:'preparing',revision:'restoring',restore_available:true,restoring:true});
 c.render({stage:'error',revision:'port-in-use',restore_available:true,restoring:true,message:'지금 연결할 수 없어요.',retryable:true});
 c.render({stage:'preparing',revision:'retry',restore_available:true,restoring:false});
 c.render({stage:'ready',revision:'recovered',restore_available:true,restoring:false,restored:false,url:'http://127.0.0.1:9001/'});
 assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);assert.equal(c.get('restore-panel').hidden,true);
});
test('a delayed pre-confirmation ready response cannot send restoration back to the old conversation',async()=>{
 let calls=0,release;const old={stage:'ready',revision:'old',restore_available:true,url:'http://127.0.0.1:9000/#pair=old'};
 const ok=value=>({status:200,ok:true,json:async()=>value});
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>{
  if(path==='/recovery/preview')return ok({preview:{id:'preview',created_at:0,turns:1,documents:0,work:0}});
  if(path==='/action')return ok({});
  calls++;if(calls===1)return ok(old);if(calls===2)return new Promise(resolve=>{release=()=>resolve(ok(old));});
  return ok({stage:'restoring',revision:'new',restore_available:true,restoring:false});
 }});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();
 const delayed=c.poll();await c.get('restore-confirm').onclick();assert.equal(c.navigations.length,0);
 release();await delayed;assert.equal(c.navigations.length,0);assert.equal(c.get('restore-panel').hidden,true);
 c.render({stage:'consent',revision:'login',restore_available:true,restoring:true,restore_request:'preview'});assert.equal(c.get('consent').hidden,false);
 c.render({stage:'ready',revision:'done',restore_available:true,restored:true,url:'http://127.0.0.1:9001/'});assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);
});
for(const legacy of [true,false])test(`restore preview discloses a fresh workspace selection only for legacy archives: ${legacy}`,async()=>{
 const state={stage:'ready',revision:'a',restore_available:true,url:'http://127.0.0.1:9001/'};
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>({status:200,ok:true,json:async()=>path==='/state'?state:{preview:{id:'preview',created_at:0,turns:1,documents:0,work:0,new_registration_required:legacy}}})});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();
 assert.equal(c.get('restore-registration').hidden,!legacy);
 if(legacy){assert.match(c.get('restore-registration').textContent,/워크스페이스/u);assert.match(c.get('restore-confirm').textContent,/새로 연결/u);}else assert.equal(c.get('restore-confirm').textContent,'이 기록으로 복원');
});

test('confirmation failure remains visible inside preview rather than disappearing behind its panel',async()=>{
 let state={stage:'ready',revision:'ready',restore_available:true,url:'http://127.0.0.1:9001/'};
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>{if(path==='/recovery/preview')return{status:200,ok:true,json:async()=>({preview:{id:'preview',created_at:0,turns:1,documents:0,work:0}})};if(path==='/action')state={stage:'error',revision:'failed',restore_available:true,restoring:false,message:'백업 확인 시간이 지났어요.',restore_request:'preview'};return{status:200,ok:true,json:async()=>state};}});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();assert.equal(c.get('restore-summary').hidden,false);await c.get('restore-confirm').onclick();assert.equal(c.get('restore-panel').hidden,false);assert.equal(c.get('restore-summary').hidden,true);assert.match(c.get('restore-feedback').textContent,/시간이 지났/u);
});

for(const accepted of [true,false])test(`restore admission is distinguished from a later state-read failure: ${accepted}`,async()=>{
 let admitted=false,failRead=false;const old={stage:'ready',revision:'old',url:'http://127.0.0.1:9001/',restore_available:true};
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>{
  if(path==='/recovery/preview')return{ok:true,status:200,json:async()=>({preview:{id:'preview',created_at:1,turns:1,documents:0,work:0}})};
  if(path==='/action'){admitted=accepted;failRead=accepted;return{ok:accepted,status:accepted?202:409,json:async()=>({})};}
  if(failRead){failRead=false;throw Error('Failed to fetch');}
  return{ok:true,status:200,json:async()=>admitted?{...old,revision:'new',url:'http://127.0.0.1:9002/',restored:true,restore_request:'preview'}:old};
 }});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();await c.get('restore-confirm').onclick();assert.equal(c.navigations.length,0);await c.poll();
 assert.deepEqual(c.navigations,accepted?['http://127.0.0.1:9002/']:[]);
});
test('a failed confirmation notice preserves the original model screen behind the restore panel',async()=>{
 const c=await client({hash:'#setup='+token+'&recover=1',state:{stage:'model',revision:'model',restore_available:true,models:[{name:'Fixture'}]}});
 c.render({stage:'model',revision:'failed',restore_available:true,models:[{name:'Fixture'}],restore_error:'백업 확인 시간이 지났어요.'});
 assert.equal(c.get('restore-panel').hidden,false);assert.equal(c.get('restore-summary').hidden,true);assert.match(c.get('restore-feedback').textContent,/확인 시간이/u);
 c.get('restore-close').onclick();assert.equal(c.get('model').hidden,false);assert.equal(c.navigations.length,0);
});

test('a failed confirmation remains a failure even if the old runtime finishes startup before the next poll',async()=>{
 let attempted=false;const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>{
  if(path==='/recovery/preview')return{ok:true,status:200,json:async()=>({preview:{id:'preview',created_at:1,turns:1,documents:0,work:0}})};
  if(path==='/action'){attempted=true;return{ok:true,status:202,json:async()=>({})};}
  return{ok:true,status:200,json:async()=>attempted?{stage:'ready',revision:'old-ready',url:'http://127.0.0.1:9001/',restore_available:true,restore_request:'preview',restore_error:'백업 확인 시간이 지났어요.'}:{stage:'preparing',revision:'old-starting',restore_available:true}};
 }});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();await c.get('restore-confirm').onclick();
 assert.deepEqual(c.navigations,[]);assert.equal(c.get('restore-summary').hidden,true);assert.match(c.get('restore-feedback').textContent,/확인 시간이/u);
 c.get('restore-close').onclick();assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);
});

test('a retained old confirmation error cannot erase a newly checked backup when startup advances',async()=>{
 const initial={stage:'preparing',revision:'failed-old',restore_available:true,restore_error:'백업 확인 시간이 지났어요.'};
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>({ok:true,status:200,json:async()=>path==='/recovery/preview'?{preview:{id:'new-preview',created_at:1,turns:1,documents:0,work:0}}:initial})});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();assert.equal(c.get('restore-summary').hidden,false);
 c.render({...initial,stage:'ready',revision:'old-start-finished',url:'http://127.0.0.1:9001/'});assert.equal(c.get('restore-summary').hidden,false);assert.deepEqual(c.navigations,[]);
});

for(const reachedServer of [true,false])test(`lost action response waits for the matching restoration outcome: reached server=${reachedServer}`,async()=>{
 let requested=false;const old={stage:'ready',revision:'old',url:'http://127.0.0.1:9001/',restore_available:true,restored:true,restore_request:'earlier-attempt',restore_error:'이전 복원 실패'};
 const c=await client({hash:'#setup='+token+'&recover=1',fetcher:async path=>{
  if(path==='/recovery/preview')return{ok:true,status:200,json:async()=>({preview:{id:'this-preview',created_at:1,turns:1,documents:0,work:0}})};
  if(path==='/action'){requested=true;throw TypeError('Failed to fetch');}
  return{ok:true,status:200,json:async()=>requested&&reachedServer?{...old,revision:'new',url:'http://127.0.0.1:9002/',restored:true,restore_error:undefined,restore_request:'this-preview'}:old};
 }});
 c.get('restore-file').files=[{size:10,arrayBuffer:async()=>new ArrayBuffer(10)}];await c.get('restore-preview').onclick();await c.get('restore-confirm').onclick();await c.poll();
 assert.deepEqual(c.navigations,reachedServer?['http://127.0.0.1:9002/']:[]);assert.equal(c.calls.filter(c=>c.path==='/action').length,1);
 if(!reachedServer){c.render({...old,revision:'late',restore_error:undefined,restore_request:'this-preview',url:'http://127.0.0.1:9002/'});assert.deepEqual(c.navigations,['http://127.0.0.1:9002/']);}
});

test('privacy handoff stays on the owner confirmation screen and requires its checkbox',async()=>{
 const c=await client({hash:'#setup='+token+'&privacy=1',state:{stage:'ready',revision:'p',erase_available:true,url:'http://127.0.0.1:9001/'}});
 assert.equal(c.navigations.length,0);assert.equal(c.get('privacy-panel').hidden,false);assert.equal(c.get('privacy-confirm').disabled,true);await c.get('privacy-confirm').onclick();assert.equal(c.calls.some(c=>c.path==='/action'),false);
 c.get('privacy-close').onclick();assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);
});
test('unknown erase response never opens the old conversation and fresh start is explicit',async()=>{
 let requestId,stage='ready';const old={stage:'ready',revision:'initial',erase_available:true,url:'http://127.0.0.1:9001/'};
 const c=await client({hash:'#setup='+token+'&privacy=1',fetcher:async(path,options)=>{
  if(path==='/action'){const action=JSON.parse(options.body);if(action.action==='erase'){requestId=action.value.id;throw TypeError('Failed to fetch');}stage='consent';return{ok:true,status:200,json:async()=>({})};}
  return{ok:true,status:200,json:async()=>stage==='ready'?old:stage==='erased'?{stage,revision:'done',erase_phase:'done',erase_request:requestId}:{stage,revision:'fresh',erase_phase:null,erase_available:true}};
 }});
 c.get('privacy-confirmed').checked=true;await c.get('privacy-confirm').onclick();assert.equal(c.navigations.length,0);assert.equal(c.get('privacy-close').hidden,true);await c.poll();assert.equal(c.navigations.length,0);
 stage='erased';await c.poll();assert.equal(c.get('privacy-fresh').hidden,false);assert.equal(c.get('privacy-panel').hidden,true);assert.equal(c.calls.filter(c=>c.path==='/action').length,1);
 await c.get('privacy-fresh').onclick();assert.equal(c.get('consent').hidden,false);assert.equal(c.get('privacy-panel').hidden,true);
});
test('interrupted deletion cannot expose old conversation, restore, or fresh start before completion',async()=>{
 const c=await client({hash:'#setup='+token,state:{stage:'erase_pending',revision:'pending',erase_phase:'deleting',retryable:true}});
 assert.equal(c.get('privacy-resume').hidden,false);assert.equal(c.get('privacy-fresh').hidden,true);assert.equal(c.get('restore-open').hidden,true);assert.equal(c.navigations.length,0);
 c.render({stage:'erase_pending',revision:'drain-failed',erase_phase:'requested',retryable:false});assert.equal(c.get('privacy-resume').hidden,true);
});

test('a rejected erase keeps its specific recovery explanation visible through unchanged polling',async()=>{
 const state={stage:'ready',revision:'r',erase_available:true,url:'http://127.0.0.1:9001/'};
 const c=await client({hash:'#setup='+token+'&privacy=1',fetcher:async path=>path==='/action'?{ok:false,status:400,json:async()=>({message:'보관 위치에 알 수 없는 파일이 있어 삭제를 멈췄어요.'})}:{ok:true,status:200,json:async()=>state}});
 c.get('privacy-confirmed').checked=true;await c.get('privacy-confirm').onclick();await c.poll();assert.equal(c.get('privacy-feedback').hidden,false);assert.match(c.get('privacy-feedback').textContent,/알 수 없는 파일/u);assert.equal(c.get('privacy-close').hidden,false);assert.equal(c.navigations.length,0);
 c.render({stage:'erase_pending',revision:'completed-after-error',erase_phase:'done'});assert.equal(c.get('privacy-resume').hidden,true);assert.equal(c.get('privacy-fresh').hidden,false);
});

test('optional update is an explicit choice and later returns to the continuing conversation',async()=>{
 const c=await client({hash:'#setup='+token+'&upgrade=1',state:{stage:'ready',revision:'a',upgrade_available:true,url:'http://127.0.0.1:9001/'}});
 assert.equal(c.navigations.length,0);assert.equal(c.get('update-panel').hidden,false);assert.equal(c.get('ready').hidden,true);
 c.get('update-later').onclick();assert.deepEqual(c.navigations,['http://127.0.0.1:9001/']);assert.equal(c.calls.filter(x=>x.path==='/action').length,0);
 const normal=await client({hash:'#setup='+token,state:{stage:'ready',revision:'a',upgrade_available:true,url:'http://127.0.0.1:9001/'}});
 assert.equal(normal.get('update-panel').hidden,true);assert.deepEqual(normal.navigations,['http://127.0.0.1:9001/']);
});
test('optional update progress does not redirect until a new ready runtime finishes it',async()=>{
 const c=await client({hash:'#setup='+token+'&upgrade=1',state:{stage:'ready',revision:'a',upgrade_available:true,url:'http://127.0.0.1:9001/'}});
 c.render({stage:'updating',revision:'b',upgrade_available:false});assert.equal(c.get('update-panel').hidden,true);assert.equal(c.navigations.length,0);
 c.render({stage:'ready',revision:'c',upgrade_available:false,url:'http://127.0.0.1:9002/'});assert.deepEqual(c.navigations,['http://127.0.0.1:9002/']);
});
