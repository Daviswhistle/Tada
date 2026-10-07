// App-owned storage key, wrapped by the signed-in Windows user (also from WSL).
// No provider credentials or other applications' vault entries are accessed.
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { release } from 'node:os';

const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($request.data)
  $entropy = [Text.Encoding]::UTF8.GetBytes('com.daviswhistle.tada.contact-storage.v1')
  if ($request.operation -eq 'protect') {
    if ($bytes.Length -ne 32) { throw 'INVALID' }
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($request.operation -eq 'unprotect') {
    if ($bytes.Length -gt 8192) { throw 'INVALID' }
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($result.Length -ne 32) { throw 'INVALID' }
  } else { throw 'INVALID' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { [Console]::Error.Write('TADA_OS_PROTECTION_FAILED'); exit 1 }
finally {
  if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($result) { [Array]::Clear($result, 0, $result.Length) }
}
`;

export function windowsProtector() {
  const binary = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : process.platform === 'linux' && /microsoft/iu.test(release())
      ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : null;
  if (!binary || !existsSync(binary)) throw Error('CONTACT_OS_PROTECTION_UNAVAILABLE');
  async function invoke(operation, bytes) {
    return new Promise((resolve, reject) => {
      const child = execFile(binary, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16384 }, (error, stdout) => {
          if (error || !/^[A-Za-z0-9+/]+={0,2}$/u.test(stdout) || stdout.length > 12000) { reject(Error('CONTACT_OS_PROTECTION_FAILED')); return; }
          const result = Buffer.from(stdout, 'base64');
          if ((operation === 'unprotect' && result.length !== 32) || !result.length || result.length > 8192) {
            result.fill(0); reject(Error('CONTACT_OS_PROTECTION_FAILED')); return;
          }
          resolve(result);
        });
      child.stdin.on('error', () => {}); // The callback reports early child exit.
      child.stdin.end(JSON.stringify({ operation, data: bytes.toString('base64') }));
    });
  }
  return { kind: 'windows-dpapi-v1', protect: bytes => invoke('protect', bytes), unprotect: bytes => invoke('unprotect', bytes) };
}

function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw Error('CONTACT_KEY_PATH_REJECTED');
}

export async function contactStorageKey({ data, profile, initialize = false, protector }) {
  const root = resolve(profile ?? `${resolve(data)}.key-private`), path = join(root, 'storage-key.sqlite');
  const artifacts = [join(resolve(data), 'contact.sqlite'), ...(profile ? [join(resolve(profile), 'account.sqlite')] : [])];
  // Missing keys never silently replace the key of already encrypted data.
  if (!existsSync(path) && (!initialize || artifacts.some(existsSync))) throw Error('CONTACT_STORAGE_KEY_MISSING');
  protector ??= windowsProtector();
  for (let at = root; dirname(at) !== at; at = dirname(at)) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw Error('CONTACT_KEY_PATH_REJECTED');
  }
  mkdirSync(root, { recursive: true, mode: 0o700 }); privatePath(root, true);
  if (!existsSync(path)) { try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  privatePath(path);
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) privatePath(path + suffix);
  let db, key;
  try {
    db = new DatabaseSync(path, { timeout: 0 });
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS storage_key (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, kind TEXT NOT NULL, wrapped BLOB NOT NULL) STRICT;');
    const record = db.prepare('SELECT version,kind,wrapped FROM storage_key WHERE id=1').get();
    if (record) {
      if (record.version !== 1 || record.kind !== protector.kind || !(record.wrapped instanceof Uint8Array) || record.wrapped.length > 8192) throw Error('CONTACT_STORAGE_KEY_INVALID');
      key = await protector.unprotect(Buffer.from(record.wrapped));
    } else {
      if (!initialize || artifacts.some(existsSync)) throw Error('CONTACT_STORAGE_KEY_MISSING');
      key = randomBytes(32);
      const wrapped = await protector.protect(key);
      if (!(wrapped instanceof Uint8Array) || !wrapped.length || wrapped.length > 8192) throw Error('CONTACT_STORAGE_KEY_INVALID');
      db.prepare('INSERT INTO storage_key VALUES(1,1,?,?)').run(protector.kind, wrapped);
    }
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('CONTACT_STORAGE_KEY_INVALID');
    db.exec('COMMIT');
    return key.toString('base64url');
  } catch (error) {
    if (/^CONTACT_[A-Z_]+$/u.test(error?.message)) throw error;
    throw Error('CONTACT_STORAGE_KEY_UNAVAILABLE');
  } finally { key?.fill(0); db?.close(); }
}
