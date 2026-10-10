// Product-owned sandboxed Chrome + actual ContactService. Synthetic model and
// loopback sites only; this is not real-model understanding or account proof.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SharedBrowser, BROWSER_CONSENT, BROWSER_FILE_CONSENT } from '../../packages/engine/src/shared-browser.mjs';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { BrowserSources } from '../../packages/engine/src/browser-sources.mjs';
const root = mkdtempSync(join(tmpdir(), 'tada-shared-smoke-')), writes = [];
const site = createServer((req, res) => { if (req.url === '/save') {
  let body = '';
  req.on('data', b => body += b);
  req.on('end', () => { writes.push(body); res.end('saved'); });
  return;
} res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><title>회의 준비</title><h1>행사 안내</h1><form><label>제목<input id="title" name="title" value="원본"></label><label>비밀번호<input type="password" value="fixture-secret"></label><label>참고<textarea id="note">유지할 메모</textarea></label><input hidden value="hidden-private"><input disabled value="disabled-private"><button type="submit">전송</button></form><script>document.querySelector('#title').addEventListener('input',e=>{fetch('/save',{method:'POST',body:e.target.value});if(e.target.value==='변환')e.target.value='사이트에서 변환함';});document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submitted=true;};</script>`); });
await new Promise(r => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/edit`;
const browser = new SharedBrowser({ headless: true });
const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'sandbox browser synthetic journal key', route: contactRoute({ smoke: 'shared-browser' }), initialize: true, assistance: true });
const device = store.addDevice('Fixture owner');
const base = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
let service;
try {
  await browser.open();
  const target = (await browser.command('Target.createTarget', { url, browserContextId: (await browser.command('Target.getBrowserContexts')).browserContextIds[0] })).targetId;
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId: target, flatten: true });
  const evaluate = async (expression) => { const r = await browser.command('Runtime.evaluate', { expression, returnByValue: true }, sessionId); if (r.exceptionDetails)
    throw Error('FIXTURE_SCRIPT_ERROR'); return r.result.value; };
  for (let i = 0; i < 50 && !await evaluate('!!document.querySelector("#title")'); i++)
    await new Promise(r => setTimeout(r, 100));
  await browser.share(device.id, target, BROWSER_CONSENT, url);
  let step = 0;
  const result = content => ({ message: { role: 'assistant', content }, input_tokens: 1, output_tokens: 1 });
  const call = (name, args) => ({ ...result(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
  service = new ContactService(store, { async chat(messages, tools) { if(tools.some(t=>t.function.name==='work_on_shared_browser')) return messages.some(m=>m.tool_name==='work_on_shared_browser') ? result('제목 입력값을 확인했어요.') : call('work_on_shared_browser',{}); if (++step === 1)
      return call('observe_shared_browser', {}); if (step === 2) {
      const observed = JSON.parse(messages.at(-1).content);
      assert.equal(observed.fields.length, 2);
      assert.equal(JSON.stringify(observed).includes('fixture-secret'), false);
      const field = observed.fields.find(f => f.label === '제목');
      assert.ok(field);
      return call('fill_shared_textbox', { observation: observed.observation, ref: field.ref, value: '회의 준비 완료' });
    } return result('제목 입력값을 확인했어요. 서버 저장은 확인하지 않았어요.'); } }, base);
  service.attachBrowser(browser);
  const accepted = service.submit(device.id, randomUUID(), '현재 공유한 안내의 제목에 회의 준비 완료라고 입력해줘.');
  await service.idle();
  assert.equal(store.turn(accepted.seq).state, 'answered');
  assert.equal(store.browserActions()[0].action.state, 'VERIFIED');
  assert.equal(await evaluate('document.querySelector("#title").value'), '회의 준비 완료');
  assert.equal(await evaluate('!!window.submitted'), false);
  for (let i = 0; i < 30 && !writes.length; i++)
    await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(writes, ['회의 준비 완료'], 'fixture server independently observes autosave, unlike product DOM-only receipt');
  const job = () => { store.submit(device.id, randomUUID(), '제목 입력을 바꿔줘.'); return store.claim(); };
  let active = job(), sources = new BrowserSources(base, store, browser, active), view = await sources.execute('observe_shared_browser', {}, new AbortController().signal);
  await evaluate('document.querySelector("#title").value="직접 수정한 내용"');
  let receipt = await sources.execute('fill_shared_textbox', { observation: view.observation, ref: view.fields[0].ref, value: '덮어쓰면 안 됨' }, new AbortController().signal);
  assert.equal(receipt.verdict, 'CONFIRMED_NOT_APPLIED');
  assert.equal(await evaluate('document.querySelector("#title").value'), '직접 수정한 내용');
  store.cancel(active.seq);
  active = job();
  sources = new BrowserSources(base, store, browser, active);
  view = await sources.execute('observe_shared_browser', {}, new AbortController().signal);
  receipt = await sources.execute('fill_shared_textbox', { observation: view.observation, ref: view.fields[0].ref, value: '변환' }, new AbortController().signal);
  assert.equal(receipt.verdict, 'APPLIED_MISMATCH');
  assert.equal(await evaluate('document.querySelector("#title").value'), '사이트에서 변환함');
  store.cancel(active.seq);
  // Preparation must detect changed targets before showing an approval card.
  let staged=0;
  active=job();sources=new BrowserSources(base,store,browser,active,{prepare:()=>{staged++;return {state:'awaiting_owner_confirmation'};}});
  view=await sources.execute('observe_shared_browser',{},new AbortController().signal);
  await evaluate('document.querySelector("#title").value="New owner edit"');
  receipt=await sources.execute('prepare_browser_text_transfer',{observation:view.observation,ref:view.fields[0].ref,value:'Private transfer'},new AbortController().signal);
  assert.equal(receipt.state,'not_prepared');assert.equal(staged,0);
  view=await sources.execute('observe_shared_browser',{},new AbortController().signal);
  receipt=await sources.execute('prepare_browser_text_transfer',{observation:view.observation,ref:view.fields[0].ref,value:'Private transfer'},new AbortController().signal);
  assert.equal(receipt.state,'awaiting_owner_confirmation');assert.equal(staged,1);
  assert.equal(await evaluate('document.querySelector("#title").value'),'New owner edit');
  store.cancel(active.seq);await browser.release(browser.grant.epoch);
  await evaluate(`document.body.innerHTML='<form method="post"><label>CSV<input id="file" type="file"></label><button type="submit">Import</button></form>';window.fileEvents=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.fileEvents++;};document.querySelector('#file').onchange=()=>window.fileEvents++;const dt=new DataTransfer();dt.items.add(new File(['name,value\\noriginal,1'], 'original.csv', {type:'text/csv'}));document.querySelector('#file').files=dt.files;`);
  await browser.share(device.id,target,BROWSER_FILE_CONSENT,url);
  active=job();sources=new BrowserSources(base,store,browser,active,{prepare:()=>{staged++;return {state:'awaiting_owner_confirmation'};}});
  view=await sources.execute('observe_shared_browser',{},new AbortController().signal);
  let file=await sources.execute('read_shared_file',{observation:view.observation,ref:view.files[0].ref,encoding:'auto'},new AbortController().signal);
  await evaluate('document.querySelector("button").textContent="Open"');
  receipt=await sources.execute('prepare_browser_file_transfer',{file:file.file,name:'private.csv',content:'private replacement',edits:[],submit:view.files[0].submitters[0].ref},new AbortController().signal);
  assert.equal(receipt.state,'not_prepared');assert.equal(staged,1);
  view=await sources.execute('observe_shared_browser',{},new AbortController().signal);
  file=await sources.execute('read_shared_file',{observation:view.observation,ref:view.files[0].ref,encoding:'auto'},new AbortController().signal);
  receipt=await sources.execute('prepare_browser_file_transfer',{file:file.file,name:'private.csv',content:'private replacement',edits:[],submit:view.files[0].submitters[0].ref},new AbortController().signal);
  assert.equal(receipt.state,'awaiting_owner_confirmation');assert.equal(staged,2);
  assert.equal(await evaluate('window.fileEvents'),0);assert.equal(await evaluate('document.querySelector("#file").files[0].name'),'original.csv');
  store.cancel(active.seq);
  const oldEpoch = browser.grant.epoch;
  await browser.command('Page.navigate', { url: url + '?other' }, sessionId);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(browser.grant, null);
  await assert.rejects(browser.observe(oldEpoch, () => { }));
  console.log(JSON.stringify({ passed: true, sandbox: 'enabled', actual_dom_fill: true, autosave_observed_by_fixture: true, submit: false, owner_edit_preserved: true, mismatch_preserved: true, navigation_invalidates: true, text_file_preflight:true, preflight_events:0, model: 'synthetic', account: 'none' }));
}
finally {
  await service?.close();
  await browser.close();
  store.close();
  await new Promise(r => site.close(r));
  rmSync(root, { recursive: true, force: true });
}
