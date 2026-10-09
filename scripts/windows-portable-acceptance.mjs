// Native Windows acceptance. Uses fresh temporary records, no model or accounts.
// Opens the ordinary setup page in the system browser. Stops only its own hosts.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const [bundlePath, reportPath, ...extra] = process.argv.slice(2);
if (process.platform !== 'win32' || !bundlePath || !reportPath || extra.length) throw Error('NATIVE_ACCEPTANCE_ARGUMENTS');
const root = mkdtempSync(join(tmpdir(), 'tada-portable-acceptance-'));
const bundle = join(root, 'Tada 실행 시험'), moved = join(root, 'Tada 다른 위치'), data = join(root, '새 대화');
const report = { platform: process.platform, node: process.version, checks: [] }, children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const nativeShell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const environment = { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), NODE_OPTIONS: '--require=must-not-be-loaded', NODE_PATH: 'must-not-be-loaded', TADA_GOOGLE_OAUTH_CLIENT_ID: 'must-not-be-used' };
const verify = path => spawnSync(join(path, 'Tada.exe'), ['--verify'], { windowsHide: true, timeout: 30000, env: environment }).status;
function childPID(parent, binary) {
  const expression = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | Where-Object { $_.ExecutablePath -eq '${binary.replaceAll("'", "''")}' } | Select-Object -ExpandProperty ProcessId`;
  const result = execFileSync(nativeShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(expression, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim();
  if (!result) return null;
  assert.match(result, /^\d+$/u); return Number(result);
}
async function launch(path, existing = false) {
  const descriptor = data + '.app-private/window.json', previous = existsSync(descriptor) ? readFileSync(descriptor, 'utf8') : null;
  const child = spawn(join(path, 'Tada.exe'), ['--data', data], { env: environment, windowsHide: true, stdio: 'ignore' });
  const record = { child, host: null }; children.push(record);
  if (existing) {
    let timer;
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('REOPEN_TIMEOUT')), 30000); })]).finally(() => clearTimeout(timer));
    assert.equal(code, 0); return record;
  }
  for (let i = 0; i < 100; i++) {
    if (existsSync(descriptor) && readFileSync(descriptor, 'utf8') !== previous) break;
    await delay(100);
  }
  record.host = childPID(child.pid, join(path, 'node/node.exe'));
  assert.ok(record.host, 'launcher must own its bundled Node process');
  return record;
}
function stop(record) {
  if (record.child.exitCode === null && !record.child.killed) record.child.kill();
  if (record.host) { try { process.kill(record.host); } catch (error) { if (error.code !== 'ESRCH') throw error; } finally { record.host = null; } }
}
try {
  cpSync(resolve(bundlePath), bundle, { recursive: true });
  assert.equal(verify(bundle), 0); report.checks.push('embedded manifest and bundled runtime verified');
  const target = join(bundle, 'packages/engine/src/start-app.mjs'), original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from('\n// altered')])); assert.equal(verify(bundle), 1); writeFileSync(target, original);
  renameSync(join(bundle, 'node/node.exe'), join(root, 'hidden-node.exe')); assert.equal(verify(bundle), 1); renameSync(join(root, 'hidden-node.exe'), join(bundle, 'node/node.exe'));
  writeFileSync(join(bundle, 'unexpected.js'), 'extra'); assert.equal(verify(bundle), 1); rmSync(join(bundle, 'unexpected.js'));
  const manifestPath = join(bundle, 'bundle.json'), manifest = readFileSync(manifestPath);
  writeFileSync(manifestPath, '{}'); assert.equal(verify(bundle), 1); writeFileSync(manifestPath, manifest);
  renameSync(join(bundle, 'node'), join(root, 'linked-node')); symlinkSync(join(root, 'linked-node'), join(bundle, 'node'), 'junction');
  assert.equal(verify(bundle), 1); unlinkSync(join(bundle, 'node')); renameSync(join(root, 'linked-node'), join(bundle, 'node'));
  assert.equal(verify(bundle), 0); report.checks.push('changed, missing, additional files, manifest and junction rejected');
  const files = join(root, 'read fixture'); mkdirSync(files); writeFileSync(join(files, 'note.txt'), 'native broker fixture');
  const broker = (identity, operation, path) => {
    const result = spawnSync(join(bundle, 'bin/tada-read-broker.exe'), [files, identity, operation, path, '0'], { encoding: 'utf8', windowsHide: true, env: environment });
    return { status: result.status, body: JSON.parse(result.stdout) };
  };
  const scope = broker('-', 'scope', '.'); assert.equal(scope.status, 0); assert.equal(scope.body.ok, true);
  const read = broker(scope.body.data.identity, 'read', 'note.txt'); assert.equal(read.status, 0); assert.equal(read.body.ok, true);
  assert.equal(read.body.data.content, 'native broker fixture');
  assert.equal(broker(scope.body.data.identity, 'read', '../note.txt').body.ok, false);
  report.checks.push('bundled native read broker reads scoped fixture and rejects traversal without developer runtimes');
  const load = path => import(pathToFileURL(join(bundle, path)).href);
  const { acquireAppInstance } = await load('packages/engine/src/app-instance.mjs');
  const { contactOptions } = await load('packages/engine/src/contact-cli.mjs');
  const options = contactOptions(['--data', data]);
  const first = await launch(bundle);
  const instance = await acquireAppInstance(options); assert.equal(instance.existing, true);
  const url = new URL(instance.url), headers = { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('setup') };
  let state;
  for (let i = 0; i < 100; i++) { state = await fetch(url.origin + '/state', { headers }).then(r => r.json()); if (state.stage !== 'preparing') break; await delay(100); }
  assert.equal(state.stage, 'consent'); assert.match(await fetch(url.origin).then(r => r.text()), /tada/iu);
  report.checks.push('fresh Windows DPAPI storage reaches subscription consent without developer tools or inherited Node options');
  const { SharedBrowser, BROWSER_CONSENT, browserCandidates } = await load('packages/engine/src/shared-browser.mjs');
  const fixture = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<title>Tada native fixture</title><label>제목<input name="title" value="처음"></label>'); });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  try {
    for (const executable of browserCandidates().filter(existsSync).filter((value, index, all) => all.findIndex(other => other.endsWith('msedge.exe') === value.endsWith('msedge.exe')) === index)) {
      const browser = new SharedBrowser({ executable, headless: true });
      try {
        await browser.open();
        const context = (await browser.command('Target.getBrowserContexts')).browserContextIds[0];
        const fixtureURL = `http://127.0.0.1:${fixture.address().port}/`;
        const { targetId } = await browser.command('Target.createTarget', { url: fixtureURL, browserContextId: context });
        await delay(500);
        const grant = await browser.share(randomUUID(), targetId, BROWSER_CONSENT, fixtureURL);
        const observation = await browser.observe(grant.epoch, () => {}); assert.equal(observation.fields.length, 1);
        await browser.fill(grant.epoch, observation, observation.fields[0].ref, '회의 준비', () => {});
        assert.equal((await browser.verify(grant.epoch, observation, () => {})).value, '회의 준비');
        report.checks.push(executable.endsWith('msedge.exe') ? 'native Edge shared textbox verified' : 'native Chrome shared textbox verified');
        if (!executable.endsWith('msedge.exe')) {
          const { targetId: setupTarget } = await browser.command('Target.createTarget', { url: instance.url, browserContextId: context });
          const { sessionId } = await browser.command('Target.attachToTarget', { targetId: setupTarget, flatten: true });
          await browser.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
          await delay(1000);
          const screenshot = await browser.command('Page.captureScreenshot', { format: 'png' }, sessionId);
          writeFileSync(resolve(reportPath) + '.png', Buffer.from(screenshot.data, 'base64'));
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => fixture.close(resolve)); }

  const keyPath = data + '.chatgpt-private/storage-key.sqlite', keyBefore = sha(keyPath);
  await launch(bundle, true); assert.equal((await acquireAppInstance(options)).url, instance.url);
  cpSync(bundle, moved, { recursive: true }); await launch(moved, true); assert.equal((await acquireAppInstance(options)).url, instance.url);
  assert.equal(sha(keyPath), keyBefore); report.checks.push('same and relocated bundles reopen one host and preserve protected storage key');
  stop(first); await delay(1000);
  const restarted = await launch(moved);
  const again = await acquireAppInstance(options); assert.equal(again.existing, true); assert.notEqual(again.url, instance.url);
  assert.equal(sha(keyPath), keyBefore); stop(restarted);
  report.checks.push('restart from relocated bundle preserves protected key and reacquires ownership');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1;
} finally {
  for (const record of children) stop(record);
  await delay(1000);
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { report.cleanup = 'pending'; writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report));
}
