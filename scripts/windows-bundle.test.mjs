import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFiles, manifestWindowsBundle } from './windows-bundle.mjs';
import { browserCandidates } from '../packages/engine/src/shared-browser.mjs';
test('Windows browser discovery includes native Chrome and Edge without requiring a Linux installation', () => {
  const paths = browserCandidates('win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\사용자\\AppData\\Local' });
  assert.ok(paths.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(paths.includes('C:\\Users\\사용자\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.equal(paths.some(path => path.startsWith('/usr')), false);
  assert.deepEqual(browserCandidates('win32', {}), []);
});
test('bundle hashes actual bytes and rejects missing runtime, case collisions and symlinks', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tada-bundle-'));
  try {
    mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', 'example'), 'hello');
    assert.deepEqual(bundleFiles(root), [{ path: 'nested/example', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }]);
    assert.throws(() => manifestWindowsBundle(root), /RUNTIME_MISSING/);
    writeFileSync(join(root, 'nested', 'Example'), 'different'); assert.throws(() => bundleFiles(root), /BUNDLE_PATH/);
    rmSync(join(root, 'nested', 'Example')); symlinkSync(join(root, 'nested', 'example'), join(root, 'link'));
    assert.throws(() => bundleFiles(root), /BUNDLE_LINK/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
