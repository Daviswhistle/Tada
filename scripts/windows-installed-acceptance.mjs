// Native isolated installation acceptance. Never touches the owner's default
// install, account, startup entry or data. Registry test key is unique to root.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [bundleInput, reportPath, previousInput] = process.argv.slice(2);
if (process.platform !== 'win32' || !bundleInput || !reportPath) throw Error('NATIVE_ARGUMENTS');
const bundle = resolve(bundleInput), root = mkdtempSync(join(tmpdir(), 'tada-installed-'));
const installed = join(root, '설치 위치'), data = join(root, '대화 기록'), report = { platform: process.platform, node: process.version, checks: [] };
const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (file, args) => spawnSync(file, args, { encoding: 'utf8', timeout: 45000, windowsHide: true });
const install = (file, directory) => { const result = run(file, ['--install-root', directory]); assert.equal(result.status, 0, result.stderr || result.error?.message); };
const ps = code => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; " + code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim();
const q = value => "'" + value.replaceAll("'", "''") + "'";
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async probe => { for (let i = 0; i < 300; i++) { const result = await probe(); if (result) return result; await delay(100); } throw Error('NATIVE_TIMEOUT'); };
const children = []; let registered = false, startupName;
try {
  const installer = join(bundle, 'Tada.exe');
  const initialInstaller = previousInput ? join(resolve(previousInput), 'Tada.exe') : installer;
  install(initialInstaller, installed);
  const bootstrap = join(installed, 'Tada.exe'), pointer = readFileSync(join(installed, 'current.txt'), 'utf8');
  assert.equal(run(bootstrap, ['--verify']).status, 0);
  const version = pointer.split('\n')[1]; let payload = join(installed, 'versions', version);
  install(initialInstaller, installed);
  assert.equal(readFileSync(join(installed, 'current.txt'), 'utf8'), pointer);
  report.checks.push('native installation and repeat installation preserve one verified payload and atomic version pointer');
  const occupied = join(root, '사용 중'); mkdirSync(occupied); writeFileSync(join(occupied, 'personal.txt'), 'keep');
  assert.equal(run(installer, ['--install-root', occupied]).status, 1);
  assert.equal(readFileSync(join(occupied, 'personal.txt'), 'utf8'), 'keep');
  const linked = join(root, 'linked'); symlinkSync(occupied, linked, 'junction');
  assert.equal(run(installer, ['--install-root', linked]).status, 1); unlinkSync(linked);
  assert.equal(run(installer, ['--install-root', join(bundle, 'nested')]).status, 1);
  report.checks.push('occupied, linked and overlapping installation paths rejected without altering existing files');
  if (!previousInput) {
    // Repair known owned code without moving the damaged or possibly running copy.
    for (const damage of ['apps/contact/index.html', 'node/node.exe', 'Tada.exe']) {
      const before = readFileSync(join(installed, 'current.txt'), 'utf8');
      const damaged = join(installed, 'versions', before.split('\n')[1]);
      writeFileSync(join(damaged, damage), 'damaged test payload');
      install(installer, installed);
      const after = readFileSync(join(installed, 'current.txt'), 'utf8'); assert.notEqual(after, before);
      assert.equal(readFileSync(join(damaged, damage), 'utf8'), 'damaged test payload');
      assert.equal(run(bootstrap, ['--verify']).status, 0);
      install(installer, installed);
      assert.equal(readFileSync(join(installed, 'current.txt'), 'utf8'), after, 'healthy repair copy is reused');
    }
    writeFileSync(bootstrap, 'damaged bootstrap');
    install(installer, installed); assert.equal(run(bootstrap, ['--verify']).status, 0);
    payload = join(installed, 'versions', readFileSync(join(installed, 'current.txt'), 'utf8').split('\n')[1]);
    report.checks.push('HTML, native runtime, payload launcher and reserved bootstrap corruption repaired; old copies preserved and healthy repaired copy reused');
  }
  const startup = action => { const result = run(bootstrap, ['--startup-' + action]); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  if (!previousInput) {
    const activePointer = readFileSync(join(installed, 'current.txt'), 'utf8');
    assert.match(activePointer, /^Tada installed version 2\n[0-9a-f]{32}\n[0-9a-f]{64}\n[0-9a-f]{64}\n$/u);
    for (const changed of [
      activePointer.replace('version 2', 'version 3'),
      activePointer.replace(/[^\n]+\n$/u, '0'.repeat(64) + '\n'),
      activePointer.replace(/^(Tada installed version 2\n[^\n]+\n)[^\n]+/u, '$1' + '0'.repeat(64)),
      activePointer + 'unexpected\n',
      activePointer.replace(/^(Tada installed version 2\n)[^\n]+/u, '$1../escape'),
    ]) {
      writeFileSync(join(installed, 'current.txt'), changed);
      assert.equal(run(bootstrap, ['--startup-status']).status, 1);
    }
    writeFileSync(join(installed, 'current.txt'), activePointer);
    assert.equal(run(bootstrap, ['--verify']).status, 0);
    const longer = join(root, '설치 경로가 조금 긴 사용자 폴더');
    install(installer, longer);
    assert.equal(run(join(longer, 'Tada.exe'), ['--verify']).status, 0);
    const tooLong = join(root, 'x'.repeat(105));
    const rejected = run(installer, ['--install-root', tooLong]);
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /PathTooLongException/u);
    assert.equal(existsSync(tooLong), false);
    report.checks.push('short v2 copy names retain both full SHA-256 bindings, reject invalid pointers, and verify final long-user-path installations; unsupported paths leave no partial install');
    const link = join(installed, 'Tada.lnk');
    const target = ps(`$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut(${q(link)}); $l.TargetPath`);
    assert.equal(target, bootstrap);
    report.checks.push('the same shortcut creator targets the stable bootstrap in an isolated shortcut location');
  }
  assert.deepEqual(startup('status'), { registered: false });
  startupName = 'Tada-' + createHash('sha256').update(installed.toUpperCase()).digest('hex').slice(0, 20).toUpperCase();
  const registry = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  assert.equal(ps(`$k=Get-Item -LiteralPath ${q(registry)}; $v=$k.GetValue(${q(startupName)},$null); if($null -ne $v){'present'}`), '');
  registered = true; assert.deepEqual(startup('enable'), { registered: true });
  const command = ps(`Get-ItemPropertyValue -LiteralPath ${q(registry)} -Name ${q(startupName)}`);
  assert.equal(command, `"${bootstrap}" --background`);
  ps(`Set-ItemProperty -LiteralPath ${q(registry)} -Name ${q(startupName)} -Value 'fixture-conflict'`);
  assert.equal(run(bootstrap, ['--startup-disable']).status, 1);
  assert.equal(ps(`Get-ItemPropertyValue -LiteralPath ${q(registry)} -Name ${q(startupName)}`), 'fixture-conflict');
  ps(`Set-ItemProperty -LiteralPath ${q(registry)} -Name ${q(startupName)} -Value ${q(command)}`);
  assert.deepEqual(startup('disable'), { registered: false }); registered = false;
  report.checks.push('exact unique HKCU registration enabled, read back, collision protected and removed; no Task Scheduler job or other startup entry touched');
  const load = path => import(pathToFileURL(join(payload, path)).href);
  const { acquireAppInstance } = await load('packages/engine/src/app-instance.mjs');
  const { contactOptions } = await load('packages/engine/src/contact-cli.mjs');
  const options = contactOptions(['--data', data]);
  const direct = spawn(join(payload, 'Tada.exe'), ['--data', data], { stdio: 'ignore', windowsHide: true }); children.push(direct);
  await until(() => existsSync(data + '.app-private/window.json'));
  const instance = await acquireAppInstance(options); assert.equal(instance.existing, true);
  const url = new URL(instance.url), headers = { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('setup') };
  await until(async () => (await fetch(url.origin + '/state', { headers }).then(r => r.json())).stage === 'consent');
  if (previousInput) {
    install(installer, installed);
    const next = readFileSync(join(installed, 'current.txt'), 'utf8'); assert.notEqual(next, pointer);
    assert.equal(existsSync(payload), true); assert.equal(run(bootstrap, ['--verify']).status, 0);
    report.checks.push('installing a new payload retains the running previous version and changes only the next-launch pointer');
  }
  assert.equal(run(bootstrap, ['--data', data]).status, 0);
  await delay(1500);
  assert.equal((await acquireAppInstance(options)).url, instance.url);
  const childNode = parent => {
    const found = ps(`Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | Where-Object { $_.ExecutablePath -eq ${q(join(payload, 'node/node.exe'))} } | Select-Object -ExpandProperty ProcessId`);
    return found ? Number(found) : null;
  };
  let firstNode = childNode(direct.pid); assert.ok(firstNode);
  const currentPayload = join(installed, 'versions', readFileSync(join(installed, 'current.txt'), 'utf8').split('\n')[1]);
  // Exercise the same adapter used by Settings, not only native startup flags.
  const { WindowsBackgroundApp } = await import(pathToFileURL(join(currentPayload, 'packages/engine/src/windows-background-app.mjs')).href);
  const fixtureLocal = join(root, 'fixture-local-appdata');
  const settingsStartup = new WindowsBackgroundApp(contactOptions(['--data', join(fixtureLocal, 'Tada/conversation')]), {
    node: join(currentPayload, 'node/node.exe'), platform: 'win32', env: { LOCALAPPDATA: fixtureLocal, TADA_WINDOWS_SUPERVISED: '1' },
  });
  assert.equal((await settingsStartup.status(true)).available, true);
  registered = true;
  assert.equal((await settingsStartup.configure(true, 'same_assistant_background_v1', () => {})).enabled, true);
  assert.equal((await settingsStartup.status(true)).enabled, true);
  assert.equal((await settingsStartup.configure(false, null, () => {})).enabled, false); registered = false;
  report.checks.push('Settings startup adapter recognizes the actual current v2 payload and enables, reads back and disables its unique native registration');
  const duplicate = spawn(join(currentPayload, 'Tada.exe'), ['--background', '--data', data], { stdio: 'ignore', windowsHide: true }); children.push(duplicate);
  await until(() => duplicate.exitCode !== null); assert.equal(duplicate.exitCode, 0);
  assert.equal(alive(firstNode), true); assert.equal((await acquireAppInstance(options)).url, instance.url);
  report.checks.push('background relaunch exits against the existing owner instead of waiting to revive it after explicit stop');
  if (!previousInput) {
    const lost = firstNode; process.kill(lost);
    firstNode = await until(() => { const next = childNode(direct.pid); return next && next !== lost ? next : null; });
    await until(async () => { try { const probe = await acquireAppInstance(options, { timeoutMs: 1000 }); try { return probe.existing; } finally { if (!probe.existing) probe.close(); } } catch { return false; } });
    assert.equal(ps(`Get-CimInstance Win32_Process -Filter 'ProcessId=${firstNode}' | Select-Object -ExpandProperty CommandLine`).includes('--background'), false);
    const replacement = await acquireAppInstance(options); assert.equal(replacement.existing, true);
    const replacementUrl = new URL(replacement.url); assert.notEqual(replacement.url, instance.url);
    const replacementHeaders = { Authorization: 'Bearer ' + new URLSearchParams(replacementUrl.hash.slice(1)).get('setup') };
    await until(async () => (await fetch(replacementUrl.origin + '/state', { headers: replacementHeaders }).then(r => r.json())).stage === 'consent');
    report.checks.push('actual foreground setup recovered its crash into a visible replacement onboarding screen');
  }
  direct.kill();
  await until(() => !alive(firstNode));
  const free = await acquireAppInstance(options); assert.equal(free.existing, false); free.close();
  report.checks.push('installed bootstrap reopens the same conversation; killing only its launcher closes its Node host and releases the lease');
  // Bounded recovery with the background flag avoids opening browser windows.
  payload = join(installed, 'versions', readFileSync(join(installed, 'current.txt'), 'utf8').split('\n')[1]);
  const supervisor = spawn(join(payload, 'Tada.exe'), ['--background', '--data', data], { stdio: 'ignore', windowsHide: true }); children.push(supervisor);
  for (let attempt = 0; attempt < 4; attempt++) {
    const child = await until(() => childNode(supervisor.pid));
    process.kill(child); await until(() => !alive(child));
  }
  await until(() => supervisor.exitCode !== null); assert.equal(supervisor.exitCode, 1);
  report.checks.push('nonzero owned Node exits recover at most three times with backoff; no process tree or browser termination');
  const final = await acquireAppInstance(options); assert.equal(final.existing, false); final.close();
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; throw error;
} finally {
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
  if (registered && startupName) {
    ps(`Remove-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name ${q(startupName)} -ErrorAction Stop`);
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  // Only this test's unique temporary installation, after own children exit.
  await delay(1500); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(JSON.stringify(report));
