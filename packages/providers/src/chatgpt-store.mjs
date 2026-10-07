// One encrypted profile and one process owner. SQLite releases the owner on crash.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
function check(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw Error('CHATGPT_PRIVATE_PROFILE_REQUIRED');
}
export class ChatGPTStore {
  #db; #owner; #key; #salt; #closed = false;
  constructor({ directory, passphrase }) {
    if (typeof passphrase !== 'string' || passphrase.length < 16 || passphrase.length > 1024) throw Error('CHATGPT_PASSPHRASE_REQUIRED');
    const root = resolve(directory);
    for (let path = root; dirname(path) !== path; path = dirname(path)) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('CHATGPT_PRIVATE_PROFILE_REQUIRED');
    }
    mkdirSync(root, { recursive: true, mode: 0o700 }); check(root, true);
    for (const name of ['owner.sqlite', 'account.sqlite']) {
      const path = join(root, name);
      if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
      check(path);
      for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) check(path + suffix);
    }
    try {
      this.#owner = new DatabaseSync(join(root, 'owner.sqlite'), { timeout: 0 });
      try { this.#owner.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE'); }
      catch { throw Error('CHATGPT_PROFILE_IN_USE'); }
      this.#db = new DatabaseSync(join(root, 'account.sqlite'));
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, payload BLOB NOT NULL) STRICT;');
      const row = this.#db.prepare('SELECT salt,payload FROM profile WHERE id=1').get();
      this.#salt = row ? Buffer.from(row.salt) : randomBytes(32);
      this.#key = scryptSync(passphrase, this.#salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      if (!row) this.save({ version: 1, host: `urn:uuid:${randomUUID()}`, client: null, subject: null, email: null, tokens: null });
      this.read();
    } catch (error) { this.close(); throw error; }
  }
  read() {
    if (this.#closed) throw Error('CHATGPT_PROFILE_CLOSED');
    try {
      const bytes = Buffer.from(this.#db.prepare('SELECT payload FROM profile WHERE id=1').get().payload);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('tada.chatgpt.profile.v1')); decipher.setAuthTag(bytes.subarray(12, 28));
      const record = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (record.version !== 1 || typeof record.host !== 'string') throw Error();
      return record;
    } catch { throw Error('CHATGPT_PROFILE_UNLOCK_FAILED'); }
  }
  save(record) {
    if (this.#closed) throw Error('CHATGPT_PROFILE_CLOSED');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from('tada.chatgpt.profile.v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    this.#db.prepare('INSERT INTO profile VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(this.#salt, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
  }
  close() {
    if (this.#closed) return; this.#closed = true;
    try { this.#db?.close(); } finally { this.#key?.fill(0); this.#owner?.close(); }
  }
}
