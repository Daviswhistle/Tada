import { existsSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { main, contactOptions } from './contact-cli.mjs';
import { acquireAppInstance } from './app-instance.mjs';
import { serveSetup } from './app-setup.mjs';

export function appArguments(args) {
  if (args.includes('--help') || args.includes('-h')) return args;
  const result = [...args];
  if (!result.includes('--data')) result.push('--data', join(homedir(), '.local', 'share', 'tada', 'conversation'));
  const options = contactOptions(result);
  // Only an absent directory may be initialized. Existing data is never replaced.
  if (!existsSync(resolve(options.data)) && !options.initialize) result.push('--init');
  return result;
}
export async function openAppBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/#setup=[A-Za-z0-9_-]{43}$/u.test(url)) throw Error('INVALID_APP_URL');
  let executable, args;
  if (platform() === 'win32' || (platform() === 'linux' && /microsoft/iu.test(release()))) {
    executable = platform() === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    // The URL is generated locally and validated above; no shell/user text runs.
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`Start-Process '${url}'`, 'utf16le').toString('base64')];
  } else { executable = platform() === 'darwin' ? 'open' : 'xdg-open'; args = [url]; }
  return new Promise(resolve => execFile(executable, args, { timeout: 10000, windowsHide: true }, error => resolve(!error)));
}
export async function startApp(args = process.argv.slice(2), { open = openAppBrowser, run = main, instance = acquireAppInstance } = {}) {
  if (args.includes('--help') || args.includes('-h')) return main(['--help']);
  // Validate before opening a browser. Recompute only initialization on retry.
  const options = contactOptions(appArguments(args));
  const show = async url => {
    process.stdout.write(`Tada를 열고 있어요. 창이 열리지 않으면 아래 주소를 여세요.\n${url}\n`);
    await open(url);
  };
  const showFailure = async error => {
    error.retryable = false;
    const setup = await serveSetup({ run: async () => { throw error; } });
    await show(setup.url); return setup;
  };
  let slot;
  try { slot = await instance(options); }
  catch (error) {
    // Unsupported platform or inaccessible launch metadata still gets an on-screen explanation.
    return showFailure(error);
  }
  if (slot.existing) { await show(slot.url); return { url: slot.url, close: async () => {} }; }
  let setup, initialized = false;
  try {
    setup = await serveSetup({ autoStart: false, run: ui => run(appArguments(initialized ? args.filter(arg => arg !== '--init') : args),
      { ui: { ...ui, initialized: () => { initialized = true; } } }) });
    await slot.publish(setup.url);
  } catch (error) { await setup?.close(); slot.close(); return showFailure(error); }
  let closing;
  const close = () => closing ??= (async () => { await setup.close(); slot.close(); })();
  const shutdown = () => { void close(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  setup.start();
  await show(setup.url);
  return { ...setup, async close() { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); await close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startApp().catch(() => { process.stderr.write('Tada를 열지 못했어요. 실행 설정을 확인해 주세요.\n'); process.exitCode = 1; });
}
