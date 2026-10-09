// Reopen the same local app instead of starting a competing contact runtime.
// Only an OS-wrapped setup capability is persisted. The SQLite lease is held
// until the setup server and contact runtime have both stopped.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { windowsProtector } from './contact-key.mjs';

function check(path, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    || (process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077)))) throw Error('CONTACT_APP_PRIVATE_PATH_REQUIRED');
}
export async function acquireAppInstance(options, { protector = windowsProtector(), timeoutMs = 20000, reopen = true, signal } = {}) {
  signal?.throwIfAborted();
  const root = `${resolve(options.data)}.app-private`, lease = join(root, 'owner.sqlite'), descriptor = join(root, 'window.json');
  const normalized = { ...options, data: resolve(options.data) }; delete normalized.initialize;
  const actions = { login: !!options.login, upgrade: !!options.upgrade };
  delete normalized.login; delete normalized.upgrade;
  for (const key of ['chatgpt-profile', 'tls-cert', 'tls-key']) if (normalized[key]) normalized[key] = resolve(normalized[key]);
  const signature = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
  for (let at = root; dirname(at) !== at; at = dirname(at)) if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw Error('CONTACT_APP_PRIVATE_PATH_REQUIRED');
  mkdirSync(root, { recursive: true, mode: 0o700 }); check(root, true);
  if (!existsSync(lease)) { try { closeSync(openSync(lease, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  check(lease);
  for (const suffix of ['-journal', '-wal', '-shm']) if (existsSync(lease + suffix)) check(lease + suffix);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const db = new DatabaseSync(lease, { timeout: 0 });
    try {
      db.exec('BEGIN EXCLUSIVE');
      return { existing: false, async publish(url) {
        const parsed = new URL(url), secret = new URLSearchParams(parsed.hash.slice(1)).get('setup');
        if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/$/u.test(parsed.origin + parsed.pathname) || !/^[A-Za-z0-9_-]{43}$/u.test(secret ?? '')) throw Error('CONTACT_APP_WINDOW_INVALID');
        const bytes = Buffer.from(secret, 'base64url'); let wrapped;
        try { wrapped = await protector.protect(bytes); } finally { bytes.fill(0); }
        if (existsSync(descriptor)) check(descriptor);
        const temporary = join(root, `window-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, JSON.stringify({ version: 1, signature, actions, origin: parsed.origin, wrapped: Buffer.from(wrapped).toString('base64') }), { flag: 'wx', mode: 0o600 });
          renameSync(temporary, descriptor);
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }, close() { db.close(); } };
    } catch (error) { db.close(); if (![5, 6].includes(error.errcode)) throw error; }
    // An owner may still be publishing its window. Never create a second runtime
    // or replace its descriptor. If it exits, the next lease attempt takes over.
    if (reopen && existsSync(descriptor)) {
      check(descriptor);
      try {
        if (lstatSync(descriptor).size > 16384) throw Error('CONTACT_APP_WINDOW_INVALID');
        const record = JSON.parse(readFileSync(descriptor, 'utf8'));
        if (record.version !== 1 || !/^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(record.origin) || typeof record.wrapped !== 'string') throw Error('CONTACT_APP_WINDOW_INVALID');
        const bytes = await protector.unprotect(Buffer.from(record.wrapped, 'base64'));
        let token; try { if (bytes.length !== 32) throw Error('CONTACT_APP_WINDOW_INVALID'); token = bytes.toString('base64url'); } finally { bytes.fill(0); }
        const headers = { Authorization: `Bearer ${token}` };
        const response = await fetch(record.origin + '/state', { headers, redirect: 'error', signal: AbortSignal.timeout(1000) });
        if (!response.ok) throw Error('CONTACT_APP_WINDOW_UNAVAILABLE');
        await response.json();
        if (record.signature !== signature) throw Error('CONTACT_APP_SETTINGS_IN_USE');
        if (Object.keys(actions).some(key => actions[key] && record.actions?.[key] !== true)) throw Error('CONTACT_APP_ACTION_REQUIRES_RESTART');
        return { existing: true, url: `${record.origin}/#setup=${token}`, close() {} };
      } catch (error) {
        if (['CONTACT_APP_SETTINGS_IN_USE', 'CONTACT_APP_ACTION_REQUIRES_RESTART', 'CONTACT_APP_PRIVATE_PATH_REQUIRED'].includes(error.message)) throw error;
      }
    }
    if (Date.now() >= deadline) throw Error('CONTACT_APP_WINDOW_UNAVAILABLE');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
