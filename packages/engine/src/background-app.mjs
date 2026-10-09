// Local OS startup for this exact assistant. No shell, credentials, alternate
// account or data directory is accepted from the browser.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKGROUND_CONSENT = 'same_assistant_background_v1';
const entry = fileURLToPath(new URL('./start-app.mjs', import.meta.url));
const command = args => new Promise((resolve, reject) => execFile('systemctl', ['--user', ...args],
  { timeout: 10000, maxBuffer: 16384, encoding: 'utf8' }, (error, stdout) => error ? reject(Error('CONTACT_BACKGROUND_UNAVAILABLE')) : resolve(stdout)));
const quote = value => {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value)) throw Error('CONTACT_BACKGROUND_SETTINGS_INVALID');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
};
export function backgroundArguments(options) {
  if (options.askPassphrase || options.telegram || options.logout) throw Error('CONTACT_BACKGROUND_SETTINGS_INVALID');
  const args = ['--background', '--data', resolve(options.data), '--provider', options.provider];
  for (const key of ['model', 'chatgpt-profile', 'broker', 'port', 'origin', 'bind', 'tls-cert', 'tls-key', 'timezone']) {
    if (options[key] !== undefined) args.push('--' + key, ['chatgpt-profile', 'broker', 'tls-cert', 'tls-key'].includes(key) ? resolve(options[key]) : String(options[key]));
  }
  if (options.provider === 'ollama') args.push('--endpoint', options.endpoint);
  for (const root of options.roots) args.push('--allow-read', resolve(root));
  return args;
}
export function backgroundUnit(options, node = process.execPath, script = entry) {
  if (!isAbsolute(node) || !isAbsolute(script)) throw Error('CONTACT_BACKGROUND_SETTINGS_INVALID');
  return '# Tada same-assistant background v1\n[Unit]\nDescription=Tada personal assistant\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nType=exec\n'
    + `ExecStart=${[node, '--experimental-strip-types', script, ...backgroundArguments(options)].map(quote).join(' ')}\n`
    + 'UnsetEnvironment=TADA_GOOGLE_OAUTH_CLIENT_ID TADA_GOOGLE_OAUTH_CLIENT_SECRET\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=30\nUMask=0077\nStandardInput=null\nStandardOutput=null\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n';
}
function checkPath(path, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    || s.uid !== process.getuid() || (s.mode & (directory ? 0o022 : 0o077))) throw Error('CONTACT_BACKGROUND_PATH_INVALID');
}
function present(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export class BackgroundApp {
  #root; #path; #unit; #content; #command; #available; #background; #busy = false; #cached = null; #at = 0; #handoff; #refresh = null;
  constructor(options, { directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
    run = command, platform = process.platform, background = false, handoff = async () => {}, node, script } = {}) {
    this.#root = resolve(directory);
    this.#unit = `tada-${createHash('sha256').update(resolve(options.data)).digest('hex').slice(0, 20)}.service`;
    this.#path = join(this.#root, this.#unit); this.#content = backgroundUnit(options, node, script);
    this.#command = run; this.#available = platform === 'linux'; this.#background = background; this.#handoff = handoff;
  }
  #inspect() {
    for (let at = this.#root; dirname(at) !== at; at = dirname(at)) if (present(at) && lstatSync(at).isSymbolicLink()) throw Error('CONTACT_BACKGROUND_PATH_INVALID');
    if (present(this.#root)) checkPath(this.#root, true);
    if (present(this.#path)) {
      checkPath(this.#path);
      if (lstatSync(this.#path).size > 16384 || readFileSync(this.#path, 'utf8') !== this.#content) throw Error('CONTACT_BACKGROUND_SETTINGS_IN_USE');
      return true;
    }
    return false;
  }
  async status(force = false) {
    if (!this.#available) return { available: false, enabled: false, running: false, managed: false, error: null };
    if (!force && this.#cached && Date.now() - this.#at < 5000) return this.#cached;
    if (!this.#refresh) this.#refresh = this.#readStatus().finally(() => { this.#refresh = null; });
    if (force) return this.#refresh;
    return this.#cached ?? { available: false, enabled: false, running: false, managed: this.#background, error: null, checking: true };
  }
  async #readStatus() {
    let state;
    try {
      await this.#command(['show', '--property=Version']);
      const installed = this.#inspect();
      const raw = installed ? await this.#command(['show', this.#unit, '--property=UnitFileState,ActiveState,SubState']) : '';
      const fields = Object.fromEntries(raw.trim().split('\n').filter(line => line.includes('=')).map(line => line.split('=')));
      state = { available: true, enabled: fields.UnitFileState === 'enabled', running: fields.ActiveState === 'active',
        managed: this.#background, error: fields.ActiveState === 'failed' ? 'CONTACT_BACKGROUND_STOPPED' : null };
    } catch (error) {
      state = { available: false, enabled: false, running: false, managed: this.#background,
        error: /^CONTACT_BACKGROUND_/u.test(error.message) ? error.message : 'CONTACT_BACKGROUND_UNAVAILABLE' };
    }
    this.#cached = state; this.#at = Date.now(); return state;
  }
  async configure(enabled, consent, authorize, prepare = () => {}) {
    if (typeof enabled !== 'boolean' || (enabled ? consent !== BACKGROUND_CONSENT : consent !== null)) throw Error('CONTACT_BACKGROUND_CONSENT_REQUIRED');
    authorize();
    if (this.#busy) throw Error('CONTACT_BACKGROUND_BUSY');
    this.#busy = true;
    try {
      if (!(await this.status(true)).available) throw Error('CONTACT_BACKGROUND_UNAVAILABLE');
      authorize();
      const installed = this.#inspect();
      if (enabled) {
        prepare(); authorize();
        if (!installed) {
          mkdirSync(this.#root, { recursive: true, mode: 0o700 }); this.#inspect();
          const temporary = join(this.#root, `.tada-${randomUUID()}.tmp`);
          try { writeFileSync(temporary, this.#content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.#path); }
          finally { if (existsSync(temporary)) unlinkSync(temporary); }
        }
        await this.#command(['daemon-reload']); authorize();
        await this.#command(['enable', this.#unit]); authorize();
        await this.#command(['start', this.#unit]);
      } else if (installed) {
        await this.#command(['disable', this.#unit]);
      }
      // A concurrent UI probe may have observed the state before start/disable.
      // Finish that probe before requesting the post-action observation.
      await this.#refresh;
      this.#at = 0;
      const state = await this.status(true);
      if (enabled && (!state.enabled || !state.running)) throw Error('CONTACT_BACKGROUND_START_FAILED');
      return { ...state, transfer: enabled && !this.#background };
    } finally { this.#busy = false; }
  }
  async handoff() { if (!this.#background) await this.#handoff(); }
}
