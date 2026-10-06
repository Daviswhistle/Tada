import { drainBrowserStderr } from './browser-diagnostics.mjs';
// Scheduled-review browser regression, with synthetic model replies and test-owned work fixtures. No product tool or hidden
// runtime fixture mode is added. CDP is connected to this owned test child by pipe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';

const executable = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => existsSync(path));
if (!executable) throw Error('BROWSER_ENVIRONMENT_MISSING'); // never count missing coverage as passed
const root = mkdtempSync(join(tmpdir(), 'tada-review-browser-'));
const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'browser-only synthetic fixture secret', route: contactRoute({ fixture: 'browser' }), initialize: true, reviews: true });
const sources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
let release, requests = 0;
const service = new ContactService(store, { async chat(messages) {
  requests++;
  assert.match(messages[0].content, /ONE-TIME scheduled/);
  await new Promise(resolve => { release = resolve; });
  return { message: { role: 'assistant', content: '허용된 자료가 연결되지 않아 보고서 내용은 확인하지 못했어요. 다음 행동은 자료 연결입니다. <script>window.injection=true</script>' }, input_tokens: 5, output_tokens: 8 };
} }, sources);
const host = await serveContact({ store, service, origin: 'http://127.0.0.1:9188', port: 9188 });
const chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-pipe', `--user-data-dir=${join(root, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
const browserDiagnostics = drainBrowserStderr(chrome);
let sequence = 0, buffered = Buffer.alloc(0); const pending = new Map(), exceptions = [], dialogs = [];
chrome.stdio[4].on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  for (let at; (at = buffered.indexOf(0)) >= 0;) {
    const message = JSON.parse(buffered.subarray(0, at).toString()); buffered = buffered.subarray(at + 1);
    if (message.method === 'Page.javascriptDialogOpening') dialogs.push(message);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const waiting = pending.get(message.id);
    if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer); message.error ? waiting.no(Error(message.error.message)) : waiting.yes(message.result); }
  }
});
chrome.on('error', error => { for (const item of pending.values()) { clearTimeout(item.timer); item.no(error); } pending.clear(); });
chrome.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.no(Error('BROWSER_EXITED')); } pending.clear(); });
function command(method, params = {}, sessionId) {
  return new Promise((yes, no) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); no(Error(`CDP_TIMEOUT:${method}; ${JSON.stringify(browserDiagnostics())}`)); }, 10000);
    pending.set(id, { yes, no, timer }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function page(context, width) {
  const target = await command('Target.createTarget', { url: 'about:blank', browserContextId: context });
  const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await command('Runtime.enable', {}, sessionId);
  await command('Page.enable', {}, sessionId);
  await command('Emulation.setDeviceMetricsOverride', { width, height: 844, mobile: width < 600, deviceScaleFactor: 1 }, sessionId);
  return { target: target.targetId, sessionId };
}
async function evaluate(page, expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
  return result.result.value;
}
async function until(page, expression) {
  for (let n = 0; n < 80; n++) {
    try { if (await evaluate(page, expression)) return; } catch { /* navigation may replace the execution context */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`BROWSER_CHECK_TIMEOUT:${expression}`);
}
async function open(page, url) {
  const result = await command('Page.navigate', { url }, page.sessionId);
  assert.equal(result.errorText, undefined);
  await until(page, '!!document.getElementById("pair-form")');
}
async function pair(page, label) {
  await open(page, host.pair());
  await evaluate(page, `document.getElementById('device-name').value=${JSON.stringify(label)};document.querySelector('#pair-form button').click()`);
  await until(page, '!document.getElementById("composer").hidden');
  assert.equal(await evaluate(page, 'location.hash'), '');
}
async function send(page, text) {
  await evaluate(page, `document.getElementById('message').value=${JSON.stringify(text)};document.getElementById('send').click()`);
}
async function confirmButton(page, accept) {
  const clicked = evaluate(page, "[...document.querySelectorAll('#followup-items button')].find(b=>b.textContent==='이 시각에 직접 확인하고 알려줘').click()");
  for (let n = 0; n < 80 && !dialogs.length; n++) await new Promise(r => setTimeout(r, 50));
  assert.ok(dialogs.length, 'real Chromium confirmation dialog must open');
  const dialog = dialogs.shift(); assert.equal(dialog.sessionId, page.sessionId);
  assert.match(dialog.params.message, /보고서 비용 재확인/);
  assert.match(dialog.params.message, /최대 8회/);
  assert.match(dialog.params.message, /파일 수정/);
  await command('Page.handleJavaScriptDialog', { accept }, page.sessionId); await clicked;
}
try {
  const version = await command('Browser.getVersion');
  const firstContext = (await command('Target.createBrowserContext')).browserContextId;
  const secondContext = (await command('Target.createBrowserContext')).browserContextId;
  let phone = await page(firstContext, 390); const pc = await page(secondContext, 1280);
  await pair(phone, '휴대폰 시험'); await pair(pc, 'PC 시험');
  const owner = store.devices().find(d => d.name === 'PC 시험').id;
  const userText = '보고서 비용을 나중에 다시 확인할 일로 기억해줘.';
  const turn = store.submit(owner, randomUUID(), userText); store.claim();
  const time = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const proposal = { id: randomUUID(), timezone: 'Asia/Seoul', spec: {
    operation_id: 'browser_review_fixture', target: null, expected_version: 0,
    title: '보고서 비용 재확인', details: '최신 비용과 다음 행동을 정리해 주세요.',
    state: 'open', waiting_for: null, notify_at: time, user_quote: userText,
  } };
  store.finish(turn.seq, { text: '확인할 업무 내용과 시각을 제안했어요.', sources: [] }, new ConversationAssistant({}, sources).checkpoint(), [proposal]);
  service.emit('change');
  await until(phone, 'document.querySelectorAll("#followup-proposals button").length===2');
  await evaluate(phone, "[...document.querySelectorAll('#followup-proposals button')].find(b=>b.textContent==='이대로 맡기기').click()");
  await until(pc, 'document.querySelectorAll("#followup-items button").length===1');
  const work = store.followupPage('active').items[0];
  assert.equal(store.reviewState(work.id, 1), null); assert.equal(requests, 0);
  await confirmButton(pc, false);
  assert.equal(store.reviewState(work.id, 1), null); assert.equal(requests, 0);
  await confirmButton(pc, true);
  await until(phone, "document.getElementById('followup-items').textContent.includes('자동 확인 예약됨')");
  assert.equal(store.reviewState(work.id, 1).state, 'armed'); assert.equal(requests, 0);
  assert.ok(await evaluate(phone, 'document.documentElement.scrollWidth <= innerWidth'));
  // The due clock is simulated in this browser regression; reviews.test.mjs
  // separately exercises the actual one-second host timer without manual ticks.
  await command('Target.closeTarget', { targetId: phone.target });
  assert.equal(service.tickFollowups(Date.parse(time)), 2); service.start();
  await until(pc, "document.getElementById('followup-items').textContent.includes('자료를 확인하는 중')");
  assert.ok(release); release(); await service.idle();
  await until(pc, "document.getElementById('followup-items').textContent.includes('확인 결과가 대화에 있어요')");
  phone = await page(firstContext, 390); await open(phone, 'http://127.0.0.1:9188');
  await until(phone, 'document.querySelectorAll(".answer").length===2');
  assert.equal(await evaluate(phone, '!!window.injection'), false);
  assert.ok(await evaluate(phone, 'document.documentElement.scrollWidth <= innerWidth'));
  assert.ok((await evaluate(phone, 'document.querySelectorAll(".answer")[1].textContent')).includes('<script>'));
  const current = store.followup(work.id); assert.equal(current.state, 'open'); assert.equal(requests, 1);
  assert.deepEqual(exceptions, []);
  if (process.env.TADA_REVIEW_SCREENSHOT) {
    const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, phone.sessionId);
    writeFileSync(process.env.TADA_REVIEW_SCREENSHOT, Buffer.from(result.data, 'base64'));
  }
  console.log(JSON.stringify({ kind: 'actual_browser_scheduled_review_regression', browser: version.product,
    independent_browser_contexts: 2, viewports: [390, 1280], exact_dialog_decline_and_accept: true,
    closed_page_review_completed: true, rejoined_shared_conversation: true, work_not_marked_done: true,
    model_text_not_executed: true, horizontal_overflow: false, model_calls: requests,
    model: 'synthetic', proposal: 'test_owned_fixture', due_clock: 'simulated',
    physical_devices: false, remote_vpn: 'not_run', public_deployment: false }));

} finally {
  release?.();
  try { await command('Browser.close'); } catch { /* child cleanup below */ }
  if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await once(chrome, 'exit'); }
  await host.close(); await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
}
