import { drainBrowserStderr } from './browser-diagnostics.mjs';
// Browser UI regression only, with synthetic replies. No product tool or hidden
// runtime fixture mode is added. CDP is connected to this owned test child by pipe.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { serveSetup } from '../../packages/engine/src/app-setup.mjs';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';

const executable = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => existsSync(path));
if (!executable) throw Error('BROWSER_ENVIRONMENT_MISSING'); // never count missing coverage as passed
const root = mkdtempSync(join(tmpdir(), 'tada-browser-'));
const store = new ContactStore({ directory: join(root, 'journal'), passphrase: 'browser-only synthetic fixture secret', route: contactRoute({ fixture: 'browser' }), initialize: true });
const sources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const subscriptionFixture = process.argv.includes('--subscription-fixture');
let release, requests = 0;
const service = new ContactService(store, { ...(subscriptionFixture ? { identity: { provider: 'chatgpt-subscription', model: 'fixture-model', display_name: 'Fixture Model', account_label: 'fixture@example.invalid' } } : {}), async chat() {
  if (++requests === 1) await new Promise(resolve => { release = resolve; });
  return { message: { role: 'assistant', content: requests === 1 ? '첫 번째 기기의 답변입니다.' : '같은 대화를 이어서 답했어요. <script>window.injection=true</script>' }, input_tokens: 5, output_tokens: 8 };
} }, sources);
const tlsFixture = process.argv.includes('--tls-fixture');
const origin = `${tlsFixture ? 'https' : 'http'}://127.0.0.1:9187`;
let tls;
if (tlsFixture) {
  // Disposable certificate in the owned test directory; no system trust changes.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  tls = { key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) };
}
const host = await serveContact({ store, service, origin, port: 9187, tls });
let finishSetupLogin;
const setup = await serveSetup({ run: async ui => {
  await ui.consent(); ui.login('https://auth.openai.com/fixture-not-opened');
  await new Promise(resolve => { finishSetupLogin = resolve; ui.signal.addEventListener('abort', resolve, { once: true }); });
  await ui.selectModel([{ name: 'Fixture Model' }]);
  ui.ready(host.pair() + '&auto=1'); await ui.wait();
} });
const chrome = spawn(executable, ['--headless=new', ...(tlsFixture ? ['--ignore-certificate-errors'] : []), '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-pipe', `--user-data-dir=${join(root, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
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
function command(method, params = {}, sessionId, timeoutMs = 10000) {
  return new Promise((yes, no) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); no(Error(`CDP_TIMEOUT:${method}; ${JSON.stringify(browserDiagnostics())}`)); }, timeoutMs);
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
  // A new pair fragment on the same URL is otherwise only a same-document
  // navigation and would not exercise startup again.
  await command('Page.navigate', { url: 'about:blank' }, page.sessionId);
  await until(page, "location.href === 'about:blank'");
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
  // Give cold process bootstrap its own bounded budget. Screen actions keep
  // their existing 10s command / 8s condition limits and all assertions.
  // Reference: https://playwright.dev/docs/api/class-browsertype#browser-type-launch
  const startupStarted = performance.now();
  const version = await command('Browser.getVersion', {}, undefined, 30000);
  const browserStartupMs = Math.round(performance.now() - startupStarted);
  const firstContext = (await command('Target.createBrowserContext')).browserContextId;
  const secondContext = (await command('Target.createBrowserContext')).browserContextId;
  let phone = await page(firstContext, 390); const pc = await page(secondContext, 1280);
  await command('Page.navigate', { url: setup.url }, pc.sessionId);
  await until(pc, '!document.getElementById("consent")?.hidden');
  assert.equal(await evaluate(pc, 'location.hash'), '');
  const setupShot = await command('Page.captureScreenshot', { format: 'png' }, pc.sessionId);
  writeFileSync('/tmp/tada-experience-setup.png', Buffer.from(setupShot.data, 'base64'));
  await evaluate(pc, 'document.getElementById("connect").click()');
  await until(pc, '!document.getElementById("login").hidden');
  finishSetupLogin();
  await until(pc, '!document.getElementById("model").hidden');
  await evaluate(pc, 'document.getElementById("model-next").click()');
  await until(pc, 'document.getElementById("composer")?.hidden===false');
  const deviceCount = store.devices().length;
  await open(pc, host.pair() + '&auto=1');
  await until(pc, '!document.getElementById("composer").hidden');
  assert.equal(store.devices().length, deviceCount, 'reopening must reuse the current device');
  await pair(phone, '휴대폰');
  const filler = [];
  while (store.devices().filter(device => !device.revoked).length < 8) filler.push(store.addDevice('Owned capacity fixture').id);
  const fullDeviceCount = store.devices().length;
  const retryScript = await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch; let lost = false; window.fixturePairRequests = 0;
    window.fetch = (...args) => {
      if (args[0] === '/api/state' && !lost) { lost = true; return Promise.reject(new TypeError('Failed to fetch')); }
      if (args[0] === '/api/pair') window.fixturePairRequests++;
      return originalFetch(...args);
    };
  ` }, pc.sessionId);
  await open(pc, host.pair() + '&auto=1');
  await until(pc, '!document.getElementById("composer").hidden');
  assert.equal(await evaluate(pc, 'window.fixturePairRequests'), 0);
  assert.equal(store.devices().length, fullDeviceCount, 'a lost state response must not replace the valid device');
  await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: retryScript.identifier }, pc.sessionId);
  for (const id of filler) service.revoke(id);
  for (const [view, label] of [[pc, 'desktop'], [phone, 'mobile']]) {
    assert.ok(await evaluate(view, 'document.documentElement.scrollWidth <= innerWidth'));
    const shot = await command('Page.captureScreenshot', { format: 'png' }, view.sessionId);
    writeFileSync('/tmp/tada-experience-' + label + '.png', Buffer.from(shot.data, 'base64'));
  }
  await evaluate(pc, 'document.getElementById("suggest-plan").click()');
  assert.ok((await evaluate(pc, 'document.getElementById("message").value')).includes('문서로 만들어줘'));
  assert.equal(requests, 0, 'a suggestion drafts but never sends a message');
  await evaluate(pc, 'document.getElementById("message").value=""');
  if (subscriptionFixture) {
    for (const view of [phone, pc]) {
      await until(view, 'document.getElementById("provider-info").textContent.includes("ChatGPT 구독")');
      assert.equal(await evaluate(view, 'document.getElementById("plan-usage").hidden'), false);
      assert.ok(await evaluate(view, 'document.documentElement.scrollWidth <= innerWidth'));
    }
    assert.equal(service.localReviews, false);
  }
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
  phone = await page(firstContext, 390); await open(phone, origin);
  await until(phone, 'document.querySelectorAll(".answer").length===2');
  assert.equal(await evaluate(phone, '!!window.injection'), false);
  assert.ok(await evaluate(phone, 'document.documentElement.scrollWidth <= innerWidth'));
  assert.ok((await evaluate(phone, 'document.querySelectorAll(".answer")[1].textContent')).includes('<script>'));
  const devices = store.devices(); service.revoke(devices.find(d => d.name === '휴대폰').id);
  await evaluate(phone, 'refresh()'); await until(phone, '!document.getElementById("pairing").hidden');
  assert.equal(await evaluate(phone, 'document.getElementById("provider-info").textContent'), '');
  assert.equal(await evaluate(phone, 'document.getElementById("plan-usage").hidden'), true);
  await evaluate(pc, 'refresh()'); await until(pc, '!document.getElementById("composer").hidden');
  // A state response admitted before logout must not restore account metadata.
  await evaluate(pc, `(() => {
    const original = window.fetch; let held = false;
    window.fetch = async (...args) => {
      if (args[0] !== '/api/state' || held) return original(...args);
      held = true; const response = await original(...args);
      await new Promise(resolve => { window.fixtureReleaseState = () => { window.fetch = original; resolve(); }; });
      return response;
    };
    window.fixtureRefresh = refresh();
  })()`);
  await until(pc, "typeof window.fixtureReleaseState === 'function'");
  await evaluate(pc, "document.getElementById('logout').click()");
  await until(pc, '!document.getElementById("pairing").hidden');
  await evaluate(pc, 'window.fixtureReleaseState(); window.fixtureRefresh');
  assert.equal(await evaluate(pc, 'document.getElementById("provider-info").textContent'), '');
  assert.equal(await evaluate(pc, 'document.getElementById("provider-info").hidden && document.getElementById("plan-usage").hidden && !document.getElementById("pairing").hidden'), true);
  assert.equal(requests, 2); assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ kind: 'actual_browser_contact_regression', browser: version.product,
    browser_startup_ms: browserStartupMs, startup_timeout_ms: 30000, command_timeout_ms: 10000,
    independent_browser_contexts: 2, viewports: [390, 1280], closed_page_work_completed: true,
    rejoined_shared_conversation: true, single_device_revocation: true, account_cleared_on_disconnect: true, late_state_after_logout_rejected: true, new_draft_preserved: true, model_text_not_executed: true,
    browser_setup_to_conversation: true, https_handoff_fixture: tlsFixture, transient_state_failure_preserves_device_at_capacity: true, saved_device_reused: true, suggestions_do_not_send: true,
    model: 'synthetic', subscription_ui_fixture: subscriptionFixture, physical_devices: false, remote_vpn: 'not_run', public_deployment: false }));
} finally {
  release?.();
  try { await command('Browser.close'); } catch { /* child cleanup below */ }
  if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await once(chrome, 'exit'); }
  await setup.close(); await host.close(); await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
}
