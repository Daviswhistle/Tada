// Real sandboxed Chromium, synthetic loopback page. No account/model access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SharedBrowser, BROWSER_CONSENT } from '../../packages/engine/src/shared-browser.mjs';

const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>계정 선택</title>
    <label>계정<select id="account" name="username"><option value="personal">개인</option><option value="team">공용</option></select></label>
    <label>공용 저장<input id="shared" type="checkbox"></label>
    <label>제목<input id="title" value="원본"></label>
    <input id="transparent" style="opacity:0" value="private-transparent">
    <span style="opacity:0"><input value="private-ancestor"></span>
    <input style="width:0;height:0;padding:0;border:0" value="private-zero">
    <span style="display:block;width:0;height:0;overflow:hidden"><input value="private-clipped"></span>
    <input style="clip-path:inset(100%)" value="private-path">
    <div style="opacity:0">private-hidden-text</div>
    <div style="height:0;overflow:hidden">private-clipped-text</div>
    <input aria-label="API key" value="private-aria">
    <label>인증 코드<input value="private-label"></label>
    <input placeholder="Access token" value="private-placeholder">
    <span id="credential-label">Password</span><input aria-labelledby="credential-label" value="private-labelledby">
    <span hidden id="hidden-label">API key</span><input aria-labelledby="hidden-label" value="private-hidden-label">
    <label style="display:none" for="hidden-linked">Access token</label><input id="hidden-linked" value="private-hidden-linked">
    <label>비밀번호<textarea>private-textarea</textarea></label>
    <label>Verification code<input autocomplete="off" value="private-otp"></label>
    <input aria-label="Security code" value="private-security-code">
    <input placeholder="인증 번호" value="private-korean-code">
    <label>PIN<input value="private-pin"></label>
    <label>Card number<input value="private-card"></label>
    <input aria-label="CVV" value="private-cvv">
    <input id="private-context" type="hidden" value="private-original">
    <div style="filter:opacity(0)">private-filter-text</div>
    <input style="mask-image:linear-gradient(transparent,transparent)" value="private-mask">
    <p>${'가나다'.repeat(3700)}</p>
    <script>window.writes=[];document.querySelector('#title').oninput=e=>writes.push({value:e.target.value,account:document.querySelector('#account').value});</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = new SharedBrowser({ headless: true });
const wait = async predicate => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('FIXTURE_WAIT_TIMEOUT');
};
try {
  await browser.open();
  let { browserContextIds: [context] } = await browser.command('Target.getBrowserContexts');
  const { targetInfos } = await browser.command('Target.getTargets');
  const target = targetInfos.find(t => t.browserContextId === context && t.type === 'page').targetId;
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId: target, flatten: true });
  await browser.command('Page.navigate', { url }, sessionId);
  const evaluate = async expression => {
    const r = await browser.command('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw Error('FIXTURE_EVALUATION_FAILED');
    return r.result.value;
  };
  await wait(() => evaluate('!!document.querySelector("#title")'));
  const original = browser.command.bind(browser), sessions = [], events = [];
  let stopDuringShare = false;
  browser.command = async (method, params, ...args) => {
    if (method === 'Runtime.callFunctionOn') events.push(params.executionContextId);
    const result = await original(method, params, ...args);
    if (method === 'Target.attachToTarget') sessions.push(result.sessionId);
    if (method === 'Page.createIsolatedWorld' && stopDuringShare) { stopDuringShare = false; browser.unshare(); }
    return result;
  };
  await browser.share('fixture-owner', target, BROWSER_CONSENT, url);
  const epoch = browser.grant.epoch;
  let observation = await browser.observe(epoch, () => {});
  assert.deepEqual(observation.fields.map(f => f.label), ['제목']);
  assert.equal(JSON.stringify(observation).includes('private-'), false);
  assert.equal(observation.context_fields.find(f => f.type === 'select-one').value, '개인');
  await evaluate('document.querySelector("#account").value="team"');
  assert.deepEqual(await browser.fill(epoch, observation, observation.fields[0].ref, '잘못된 계정', () => {}), { applied: false, reason: 'target_changed' });
  assert.deepEqual(await evaluate('writes'), []);
  observation = await browser.observe(epoch, () => {});
  await evaluate('document.querySelector("#private-context").value="private-changed"');
  assert.equal((await browser.fill(epoch, observation, observation.fields[0].ref, '다른 비공개 상태', () => {})).applied, false);
  assert.deepEqual(await evaluate('writes'), []);
  observation = await browser.observe(epoch, () => {});
  await evaluate('document.body.insertAdjacentHTML("beforeend", \'<input id="new-checkbox" type="checkbox" checked>\')');
  assert.equal((await browser.fill(epoch, observation, observation.fields[0].ref, '새 공개 설정', () => {})).applied, false);
  assert.deepEqual(await evaluate('writes'), []);
  await evaluate('document.querySelector("#new-checkbox").remove()');
  observation = await browser.observe(epoch, () => {});
  assert.equal(observation.context_fields.find(f => f.type === 'select-one').value, '공용');
  await evaluate('document.querySelector("#shared").checked=true');
  assert.equal((await browser.fill(epoch, observation, observation.fields[0].ref, '잘못된 범위', () => {})).applied, false);
  assert.deepEqual(await evaluate('writes'), []);
  observation = await browser.observe(epoch, () => {});
  await evaluate('document.querySelector("#title").style.opacity="0"');
  assert.equal((await browser.fill(epoch, observation, observation.fields[0].ref, '숨겨진 대상', () => {})).applied, false);
  assert.deepEqual(await evaluate('writes'), []);
  await evaluate('document.querySelector("#title").style.opacity="1"');

  // Moving the same node to another form keeps values and control order but
  // changes which hidden account the site's autosave handler will use.
  await evaluate(`document.querySelector('#title').outerHTML='<input type="hidden" name="account" form="personal" value="personal"><input type="hidden" name="account" form="team" value="team"><form id="personal" action="/edit"><span id="group"><input id="draft" value="original"></span></form><form id="team" action="/edit"></form>'; window.formWrites=[];document.querySelector('#draft').oninput=e=>formWrites.push({account:e.target.form.elements.account.value,value:e.target.value});`);
  observation = await browser.observe(epoch, () => {});
  const draft = observation.fields.find(f => f.value === 'original');
  await evaluate('document.querySelector("#team").append(document.querySelector("#group"))');
  assert.deepEqual(await browser.fill(epoch, observation, draft.ref, 'wrong account', () => {}), { applied: false, reason: 'target_changed' });
  assert.deepEqual(await evaluate('formWrites'), []);
  await evaluate('document.querySelector("#personal").append(document.querySelector("#group"));document.querySelector("#draft").oninput=e=>document.querySelector("#team").append(document.querySelector("#group"));document.querySelector("#draft").onchange=e=>formWrites.push({account:e.target.form.id,value:e.target.value})');
  observation = await browser.observe(epoch, () => {});
  assert.equal((await browser.fill(epoch, observation, observation.fields.find(f => f.value === 'original').ref, 'moved during input', () => {})).applied, true);
  assert.equal(await browser.verify(epoch, observation, () => {}), null);
  assert.deepEqual(await evaluate('formWrites'), []);
  // Non-visible markup and resolved relative destinations are private guards.
  await evaluate('document.querySelector("#team").setAttribute("action","draft");document.head.insertAdjacentHTML("beforeend", \'<base href="/personal/">\');document.querySelector("#draft").oninput=e=>formWrites.push({destination:e.target.form.action,value:e.target.value})');
  for (const change of [
    'document.querySelector("base").href="/team/"',
    'document.querySelector("#team").dataset.account="shared"',
    'document.querySelector("#team").method="post"',
    'document.querySelector("#team").action="/other"',
  ]) {
    observation = await browser.observe(epoch, () => {});
    await evaluate(change);
    assert.deepEqual(await browser.fill(epoch, observation, observation.fields[0].ref, 'wrong destination', () => {}), { applied: false, reason: 'target_changed' });
    assert.deepEqual(await evaluate('formWrites'), []);
  }
  await evaluate('window.inputCount=0;window.changeCount=0;document.querySelector("#draft").oninput=()=>inputCount++;document.querySelector("#draft").onchange=()=>changeCount++');
  observation = await browser.observe(epoch, () => {});
  assert.equal((await browser.fill(epoch, observation, observation.fields[0].ref, 'ordinary typing', () => {})).applied, true);
  assert.equal((await browser.verify(epoch, observation, () => {})).value, 'ordinary typing');
  assert.deepEqual(await evaluate('({input:inputCount,change:changeCount})'), { input: 1, change: 0 });
  // Bounds are checked while traversing; large private markup is not returned.
  await evaluate('document.body.dataset.large="x".repeat(524289)');
  await assert.rejects(browser.observe(epoch, () => {}), /OBSERVATION_FAILED/);
  await evaluate('delete document.body.dataset.large');
  observation = await browser.observe(epoch, () => {});
  await evaluate('document.body.dataset.large="x".repeat(524289)');
  assert.deepEqual(await browser.fill(epoch, observation, observation.fields[0].ref, 'oversized', () => {}), { applied: false, reason: 'target_changed' });
  await evaluate('delete document.body.dataset.large');

  assert.deepEqual(await evaluate('({input:inputCount,change:changeCount})'), { input: 1, change: 0 });
  await evaluate('const large=document.createElement("div");large.id="large-markup";large.append(...Array.from({length:10001},()=>document.createElement("span")));document.body.append(large)');
  await assert.rejects(browser.observe(epoch, () => {}), /OBSERVATION_FAILED/);
  await evaluate('document.querySelector("#large-markup").remove()');

  // Inherited disabled and inert state also make an ordinary textbox inactive.
  await evaluate('document.querySelector("#team").innerHTML="<fieldset id=disabled-scope><input id=inactive value=original></fieldset>"');
  observation = await browser.observe(epoch, () => {});
  const inactive = observation.fields.find(f => f.value === 'original');
  await evaluate('document.querySelector("#disabled-scope").disabled=true');
  assert.equal((await browser.fill(epoch, observation, inactive.ref, 'disabled', () => {})).applied, false);
  observation = await browser.observe(epoch, () => {});
  assert.equal(observation.fields.length, 0);
  await evaluate('document.querySelector("#disabled-scope").disabled=false;document.querySelector("#disabled-scope").inert=true');
  observation = await browser.observe(epoch, () => {});
  assert.equal(observation.fields.length, 0);
  await evaluate('document.querySelector("#disabled-scope").inert=false');

  // Independently inspect the product-owned isolated world's retention.
  for (let i = 0; i < 24; i++) observation = await browser.observe(epoch, () => {});
  assert.equal(new Set(events).size, 1);
  const isolated = events.at(-1);
  const retained = async () => (await original('Runtime.evaluate', {
    expression: 'Object.keys(globalThis).filter(k=>k.startsWith("__tada_"))', contextId: isolated, returnByValue: true,
  }, sessionId)).result.value;
  assert.equal((await retained()).length, 1);
  await browser.release(epoch);
  assert.equal((await retained()).length, 0);
  await browser.observe(epoch, () => {});
  browser.unshare();
  await wait(async () => (await retained()).length === 0);
  assert.equal(browser.grant, null);
  for (let i = 0; i < 10; i++) {
    await browser.share('fixture-owner', target, BROWSER_CONSENT, url);
    browser.unshare();
  }
  stopDuringShare = true;
  await assert.rejects(browser.share('fixture-owner', target, BROWSER_CONSENT, url), /TARGET_CHANGED/);
  assert.equal(browser.grant, null);
  await wait(async () => {
    for (const id of sessions) {
      try { await original('Runtime.evaluate', { expression: '1', returnByValue: true }, id); return false; }
      catch (error) { assert.match(error.message, /COMMAND_FAILED/); }
    }
    return true;
  });

  // Closing the last window must discard its private context and cookies.
  await browser.share('fixture-owner', target, BROWSER_CONSENT, url);
  await evaluate('document.cookie="fixture_session=old; path=/"');
  assert.match(await evaluate('document.cookie'), /fixture_session/);
  await browser.command('Target.closeTarget', { targetId: target });
  await wait(async () => !(await browser.command('Target.getBrowserContexts')).browserContextIds.includes(context));
  assert.equal(browser.grant, null);
  await browser.open();
  const contexts = await browser.command('Target.getBrowserContexts');
  assert.equal(contexts.browserContextIds.length, 1);
  assert.notEqual(contexts.browserContextIds[0], context);
  const pages = (await browser.command('Target.getTargets')).targetInfos.filter(t => t.browserContextId === contexts.browserContextIds[0] && t.type === 'page');
  assert.equal(pages.length, 1);
  assert.deepEqual((await browser.command('Storage.getCookies', { browserContextId: contexts.browserContextIds[0] })).cookies, []);
  console.log(JSON.stringify({ passed: true, selected_account_and_checkbox_guard: true, form_owner_guard: true, private_dom_metadata_guard: true, resolved_destination_guard: true, single_input_no_change: true, bounded_markup: true, inherited_disabled_and_inert_guard: true, private_control_state_guard: true, added_control_guard: true, visible_and_hidden_sensitive_labels_excluded: true, invisible_text_and_fields_excluded: true, invisible_dispatch_blocked: true, bounded_snapshot_retention: true, release_and_unshare_cleanup: true, old_cdp_sessions_detached: true, reopen_fresh_private_context: true, sandbox: 'enabled', model: 'none', accounts: 'none' }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
