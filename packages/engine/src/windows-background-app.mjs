// Installed Windows startup manages one exact per-user Run entry. The native
// launcher owns recovery; disabling future startup never stops a running host.
import { execFile } from 'node:child_process';
import { dirname, basename, join, resolve } from 'node:path';
import { BACKGROUND_CONSENT } from './background-app.mjs';
const unavailable = () => ({ available: false, enabled: false, running: false, managed: false, error: null, platform: 'win32' });
const execute = (file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 1024, encoding: 'utf8' },
  (error, stdout) => error ? reject(Error('CONTACT_BACKGROUND_UNAVAILABLE')) : resolve(stdout)));
export class WindowsBackgroundApp {
  #launcher; #run; #busy = false; #managed; #available; #cached = null; #at = 0; #refresh = null;
  constructor(options, { node = process.execPath, env = process.env, run = execute, platform = process.platform } = {}) {
    this.#run = run; this.#managed = env.TADA_WINDOWS_SUPERVISED === '1';
    const payload = dirname(dirname(node)), versions = dirname(payload), root = dirname(versions);
    this.#launcher = join(root, 'Tada.exe');
    // Run registration only supports the installed launcher's fixed default
    // route. Never silently discard CLI account, provider, model or source args.
    this.#available = platform === 'win32' && this.#managed && basename(versions) === 'versions' && /^[0-9a-f]{64}(?:-[0-9a-f]{32})?$/u.test(basename(payload))
      && !!env.LOCALAPPDATA && resolve(options.data) === resolve(env.LOCALAPPDATA, 'Tada', 'conversation')
      && options.provider === 'chatgpt' && !options.askPassphrase && !options.telegram && !options.logout
      && !options.login && !options.upgrade && options.roots.length === 0
      && options.port === 8787 && options.bind === '127.0.0.1' && options.origin === 'http://127.0.0.1:8787'
      && options.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone
      && ['model', 'chatgpt-profile', 'broker', 'tls-cert', 'tls-key'].every(key => options[key] === undefined);
  }
  async #action(action) {
    const raw = await this.#run(this.#launcher, ['--startup-' + action]);
    let state; try { state = JSON.parse(raw); } catch { throw Error('CONTACT_BACKGROUND_UNAVAILABLE'); }
    if (!state || Object.keys(state).join(',') !== 'registered' || typeof state.registered !== 'boolean') throw Error('CONTACT_BACKGROUND_UNAVAILABLE');
    return { available: true, enabled: state.registered, running: true, managed: this.#managed, error: null, platform: 'win32', startup: 'registered_only' };
  }
  async status(force = false) {
    if (!this.#available) return unavailable();
    if (!force && this.#cached && (this.#busy || Date.now() - this.#at < 5000)) return this.#cached;
    if (!this.#refresh) this.#refresh = this.#readStatus().finally(() => { this.#refresh = null; });
    if (force) return this.#refresh;
    return this.#cached ?? { ...unavailable(), managed: this.#managed, checking: true };
  }
  async #readStatus() {
    try { this.#cached = await this.#action('status'); }
    catch { this.#cached = { ...unavailable(), managed: this.#managed, error: 'CONTACT_BACKGROUND_UNAVAILABLE' }; }
    this.#at = Date.now(); return this.#cached;
  }
  async configure(enabled, consent, authorize, prepare = () => {}) {
    if (typeof enabled !== 'boolean' || (enabled ? consent !== BACKGROUND_CONSENT : consent !== null)) throw Error('CONTACT_BACKGROUND_CONSENT_REQUIRED');
    authorize(); if (this.#busy) throw Error('CONTACT_BACKGROUND_BUSY'); this.#busy = true;
    try {
      if (!this.#available || !(await this.status(true)).available) throw Error('CONTACT_BACKGROUND_UNAVAILABLE');
      if (enabled) prepare(); authorize();
      const state = await this.#action(enabled ? 'enable' : 'disable');
      if (state.enabled !== enabled) throw Error('CONTACT_BACKGROUND_START_FAILED');
      this.#cached = state; this.#at = Date.now(); return { ...state, transfer: false };
    } finally { this.#busy = false; }
  }
  async handoff() {}
}
