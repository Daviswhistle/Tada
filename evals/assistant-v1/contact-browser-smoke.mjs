import { drainBrowserStderr } from './browser-diagnostics.mjs';
// Browser UI regression only, with synthetic replies. No product tool or hidden
// runtime fixture mode is added. CDP is connected to this owned test child by pipe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';

const executable = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => existsSync(path));
if (!executable) throw Error('BROWSER_ENVIRONMENT_MISSING'); // never count missing coverage as passed
const root = mkdtempSync(join(tmpdir(), 'tada-browser-'));
const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'browser-only synthetic fixture secret', route: contactRoute({ fixture: 'browser' }), initialize: true });
const sources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
let release, requests = 0;
const service = new ContactService(store, { async chat() {
  if (++requests === 1) await new Promise(resolve => { release = resolve; });
  return { message: { role: 'assistant', content: requests === 1 ? '첫 번째 기기의 답변입니다.' : '같은 대화를 이어서 답했어요. <script>window.injection=true</script>' }, input_tokens: 5, output_tokens: 8 };
} }, sources);
const host = await serveContact({ store, service, origin: 'http://127.0.0.1:9187', port: 9187 });
const chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-pipe', `--user-data-dir=${join(root, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
const browserDiagnostics = drainBrowserStderr(chrome);
let sequence = 0, buffered = Buffer.alloc(0); const pending = new Map(), exceptions = [];
chrome.stdio[4].on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  for (let at; (at = buffered.indexOf(0)) >= 0;) {
    const message = JSON.parse(buffered.subarray(0, at).toString()); buffered = buffered.subarray(at + 1);
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
  let state;
  try { state = await evaluate(page, `({ ready: document.readyState,
    pair_handler: typeof document.getElementById('pair-form')?.onsubmit,
    composer_hidden: document.getElementById('composer')?.hidden,
    connection: document.getElementById('connection')?.textContent,
    notice: document.getElementById('notice')?.textContent })`); }
  catch { state = 'execution_context_unavailable'; }
  throw Error(`BROWSER_CHECK_TIMEOUT:${expression}; ${JSON.stringify({ state, exceptions, ...browserDiagnostics() })}`);
}
async function open(page, url) {
  const result = await command('Page.navigate', { url }, page.sessionId);
  assert.equal(result.errorText, undefined);
  // A parsed form can exist before its deferred app script has installed the
  // handlers. Do not race a default form submission against application startup.
  await until(page, 'typeof document.getElementById("pair-form")?.onsubmit === "function"');
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
try {
  const version = await command('Browser.getVersion');
  const firstContext = (await command('Target.createBrowserContext')).browserContextId;
  const secondContext = (await command('Target.createBrowserContext')).browserContextId;
  let phone = await page(firstContext, 390); const pc = await page(secondContext, 1280);
  await pair(phone, '휴대폰'); await pair(pc, 'PC');
  // Delay the already-real HTTP admission response in this test page only.
  // The user can type the next draft before the first admission settles.
  await evaluate(phone, `(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (args[0] === '/api/turns') await new Promise(resolve => {
        window.fixtureReleaseAdmission = () => { window.fetch = original; resolve(); };
      });
      return response;
    };
  })()`);
  await send(phone, '오늘 이야기할 것을 같이 정리하자.');
  await until(phone, "typeof window.fixtureReleaseAdmission === 'function'");
  await evaluate(phone, "document.getElementById('message').value='아직 쓰고 있는 다음 메시지';window.fixtureReleaseAdmission()");
  await until(phone, "!document.getElementById('send').disabled");
  assert.equal(await evaluate(phone, "document.getElementById('message').value"), '아직 쓰고 있는 다음 메시지');
  await until(pc, 'document.querySelectorAll(".turn").length===1');
  assert.ok(release, 'model request must already be owned by the host');
  await command('Target.closeTarget', { targetId: phone.target });
  release(); await service.idle();
  await until(pc, 'document.querySelectorAll(".answer").length===1');
  await send(pc, '아까 이야기한 것만 짧게 말해줘.');
  await until(pc, 'document.querySelectorAll(".answer").length===2');
  phone = await page(firstContext, 390); await open(phone, 'http://127.0.0.1:9187');
  await until(phone, 'document.querySelectorAll(".answer").length===2');
  assert.equal(await evaluate(phone, '!!window.injection'), false);
  assert.ok(await evaluate(phone, 'document.documentElement.scrollWidth <= innerWidth'));
  assert.ok((await evaluate(phone, 'document.querySelectorAll(".answer")[1].textContent')).includes('<script>'));
  const devices = store.devices(); service.revoke(devices.find(d => d.name === '휴대폰').id);
  await evaluate(phone, 'refresh()'); await until(phone, '!document.getElementById("pairing").hidden');
  await evaluate(pc, 'refresh()'); await until(pc, '!document.getElementById("composer").hidden');
  assert.equal(requests, 2); assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ kind: 'actual_browser_contact_regression', browser: version.product,
    independent_browser_contexts: 2, viewports: [390, 1280], closed_page_work_completed: true,
    rejoined_shared_conversation: true, single_device_revocation: true, new_draft_preserved: true, model_text_not_executed: true,
    model: 'synthetic', physical_devices: false, remote_vpn: 'not_run', public_deployment: false }));
} finally {
  release?.();
  try { await command('Browser.close'); } catch { /* child cleanup below */ }
  if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await once(chrome, 'exit'); }
  await host.close(); await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
}
