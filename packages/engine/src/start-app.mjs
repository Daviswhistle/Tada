import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, contactOptions } from './contact-cli.mjs';
import { acquireAppInstance } from './app-instance.mjs';
import { serveSetup } from './app-setup.mjs';
import { openSystemBrowser } from './system-browser.mjs';
import { BackgroundApp } from './background-app.mjs';
import { WindowsBackgroundApp } from './windows-background-app.mjs';
import { superviseWindow } from './windows-control.mjs';

export function appArguments(args, { initialize = true } = {}) {
  if (args.includes('--help') || args.includes('-h')) return args;
  const result = [...args];
  if (!result.includes('--data')) result.push('--data', join(homedir(), '.local', 'share', 'tada', 'conversation'));
  const options = contactOptions(result);
  // Only an absent directory may be initialized. Existing data is never replaced.
  if (initialize && !existsSync(resolve(options.data)) && !options.initialize) result.push('--init');
  return result;
}
export async function openAppBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/#setup=[A-Za-z0-9_-]{43}$/u.test(url)) throw Error('INVALID_APP_URL');
  return openSystemBrowser(url);
}
export async function startApp(args = process.argv.slice(2), { open = openAppBrowser, run = main, instance = acquireAppInstance, signal, onReady = () => {}, platform = process.platform, backgroundFactory = (options, config) => platform === 'win32' ? new WindowsBackgroundApp(options, config) : new BackgroundApp(options, config) } = {}) {
  if (args.includes('--help') || args.includes('-h')) return main(['--help']);
  if (args.filter(arg => arg === '--background').length > 1) throw Error('CONTACT_OPTIONS_INVALID');
  const backgroundMode = args.includes('--background'); args = args.filter(arg => arg !== '--background');
  if (backgroundMode && args.some(arg => ['--init', '--login', '--upgrade-contact'].includes(arg))) throw Error('CONTACT_BACKGROUND_SETTINGS_INVALID');
  const launchArgs = value => appArguments(value, { initialize: !backgroundMode });
  // Validate before opening a browser. Recompute only initialization on retry.
  const options = contactOptions(launchArgs(args));
  const show = async url => {
    if (backgroundMode) return;
    process.stdout.write(`Tada를 열고 있어요. 창이 열리지 않으면 아래 주소를 여세요.\n${url}\n`);
    if (await open(url) === false) throw Error('CONTACT_APP_BROWSER_UNAVAILABLE');
  };
  const showFailure = async error => {
    if (signal?.aborted) throw signal.reason;
    if (backgroundMode) throw error;
    error.retryable = false;
    const setup = await serveSetup({ run: async () => { throw error; } });
    let closing;
    const close = () => closing ??= (async () => { signal?.removeEventListener('abort', shutdown); await setup.close(); })();
    const shutdown = () => { void close(); };
    signal?.addEventListener('abort', shutdown, { once: true });
    if (signal?.aborted) { await close(); throw signal.reason; }
    try { await show(setup.url); return { ...setup, close }; }
    catch (failure) { await close(); throw failure; }
  };
  let slot;
  try { slot = await instance(options, backgroundMode && platform !== 'win32' ? { reopen: false, timeoutMs: Infinity, signal } : { signal }); }
  catch (error) {
    // Unsupported platform or inaccessible launch metadata still gets an on-screen explanation.
    return showFailure(error);
  }
  if (signal?.aborted) { slot.close(); throw signal.reason; }
  if (slot.existing) { await show(slot.url); return { url: slot.url, close: async () => {} }; }
  let setup, initialized = false;
  try {
    const background = backgroundFactory(options, { background: backgroundMode, handoff: async () => { await close(); } });
    setup = await serveSetup({ autoStart: false, autoRetry: backgroundMode, run: ui => run(launchArgs(initialized ? args.filter(arg => arg !== '--init') : args),
      { ui: { ...ui, initialized: () => { initialized = true; }, ready: source => { ui.ready(source); onReady(); } }, background }) });
    await slot.publish(setup.url);
  } catch (error) { await setup?.close(); slot.close(); return showFailure(error); }
  let closing;
  const close = () => closing ??= (async () => {
    signal?.removeEventListener('abort', shutdown);
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    try { await setup.close(); } finally { slot.close(); }
  })();
  const shutdown = () => { void close(); };
  signal?.addEventListener('abort', shutdown, { once: true });
  if (signal?.aborted) { await close(); throw signal.reason; }
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  setup.start();
  try { await show(setup.url); } catch (error) { await close(); throw error; }
  return { ...setup, close, owned: true, reopen: async () => {
    if (closing || signal?.aborted) return;
    if (await open(setup.url) === false) throw Error('CONTACT_APP_BROWSER_UNAVAILABLE');
  } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parent = new AbortController();
  const supervised = process.platform === 'win32' && process.env.TADA_WINDOWS_SUPERVISED === '1';
  let app;
  if (supervised) superviseWindow(process.stdin, {
    stop: () => parent.abort(),
    open: () => app?.reopen?.(),
    failed: () => process.stdout.write('\u001eTADA_OPEN_FAILED_V1\n'),
  });
  startApp(process.argv.slice(2), { signal: parent.signal, onReady: () => {
    if (supervised && !parent.signal.aborted) process.stdout.write('\u001eTADA_ASSISTANT_READY_V1\n');
  } }).then(result => {
    app = result;
    if (supervised && app?.owned && !parent.signal.aborted) process.stdout.write('\u001eTADA_HOST_OPEN_V1\n');
  }).catch(() => {
    if (!parent.signal.aborted) { process.stderr.write('Tada를 열지 못했어요. 실행 설정을 확인해 주세요.\n'); process.exitCode = 1; }
  });
}
