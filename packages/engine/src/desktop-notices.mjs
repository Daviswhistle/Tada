// Presentation deduplication only. Authority always comes from ContactStore.
// A separate encrypted file keeps old journal schemas readable by old binaries.
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { lstatSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const limit = 1024 * 1024;
const fail = () => { throw Error('CONTACT_DESKTOP_NOTICES_UNAVAILABLE'); };
const counter = n => Number.isSafeInteger(n) && n >= 0;
function valid(value) {
  return value && Object.keys(value).sort().join(',') === 'notices,pending,through,version' && value.version === 1 && counter(value.through)
    && Array.isArray(value.pending) && value.pending.length <= 32 && new Set(value.pending).size === value.pending.length
    && value.pending.every(n => counter(n) && n > 0 && n <= value.through)
    && Array.isArray(value.notices) && value.notices.length <= 10000 && new Set(value.notices).size === value.notices.length
    && value.notices.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id));
}
function owned(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit
      || process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) fail();
}
function present(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export class DesktopNotices {
  #root; #key; #aad; #state; #bytes;
  constructor(root, key, journal) { this.#root = root; this.#key = key; this.#aad = Buffer.from(`${journal}:desktop-notices:v1`); }
  prepare(baseline) {
    if (this.#state) return;
    try {
      const path = join(this.#root, 'desktop-notices.v1.enc'), stat = present(path);
      if (!stat) { this.save(baseline()); return; }
      owned(stat);
      const fd = openSync(path, 'r'); let bytes;
      try { const actual = fstatSync(fd); owned(actual); if (stat.dev !== actual.dev || stat.ino !== actual.ino) fail(); bytes = readFileSync(fd); }
      finally { closeSync(fd); }
      if (bytes.length < 28 || bytes.length > limit) fail();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(this.#aad); decipher.setAuthTag(bytes.subarray(-16));
      const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
      if (!valid(value)) fail(); this.#state = value; this.#bytes = bytes;
    } catch { fail(); }
  }
  get state() { if (!this.#state) fail(); return structuredClone(this.#state); }
  save(value) {
    if (!valid(value)) fail();
    if (JSON.stringify(value) === JSON.stringify(this.#state)) return;
    const temporary = join(this.#root, `.desktop-notices-${randomUUID()}.tmp`), path = join(this.#root, 'desktop-notices.v1.enc'); let fd;
    try {
      const old = present(path); if (old) owned(old);
      if (this.#state && (!old || !readFileSync(path).equals(this.#bytes))) fail();
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce); cipher.setAAD(this.#aad);
      const bytes = Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
      if (bytes.length > limit) fail();
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
      if (process.platform !== 'win32') { fd = openSync(this.#root, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined; }
      this.#state = structuredClone(value); this.#bytes = bytes;
    } catch { fail(); }
    finally { if (fd !== undefined) closeSync(fd); if (present(temporary)) unlinkSync(temporary); }
  }
}
