// Build-time helper. This file is not included in the user's application.
import { cpSync, existsSync, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['packages/engine/src', 'packages/providers/src', 'packages/contracts/src', 'packages/contracts/schema', 'apps/contact'];
export function bundleFiles(root) {
  const files = [], seen = new Set();
  function walk(relative) {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('BUNDLE_LINK');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(relative ? `${relative}/${entry}` : entry);
    } else {
      if (!stat.isFile() || relative.split('/').some(part => /[:\\]/u.test(part) || /[. ]$/u.test(part)) || seen.has(relative.toLowerCase())) throw Error('BUNDLE_PATH');
      seen.add(relative.toLowerCase());
      files.push({ path: relative, size: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  }
  walk(''); return files;
}
export function stageWindowsBundle(out) {
  if (existsSync(out)) throw Error('BUNDLE_OUTPUT_EXISTS');
  mkdirSync(out, { recursive: true });
  for (const relative of [...roots, 'package.json', 'package-lock.json', '.node-version', 'LICENSE']) cpSync(join(source, relative), join(out, relative), { recursive: true, dereference: false });
  bundleFiles(out); // Reject accidental symlinks before installing dependencies.
}
export function manifestWindowsBundle(out) {
  if (existsSync(join(out, 'bundle.json')) || existsSync(join(out, 'Tada.exe'))) throw Error('BUNDLE_ALREADY_FINALIZED');
  if (!existsSync(join(out, '.node-version'))) throw Error('BUNDLE_RUNTIME_MISSING:.node-version');
  if (readFileSync(join(out, '.node-version'), 'utf8').trim() !== process.versions.node) throw Error('BUNDLE_NODE_VERSION');
  const files = bundleFiles(out);
  for (const file of ['node/node.exe', 'bin/tada-read-broker.exe', 'node_modules/ajv/package.json', 'node_modules/ajv-formats/package.json', 'node_modules/markdown-it/dist/browser/markdown-it.umd.min.js']) {
    if (!files.some(entry => entry.path === file)) throw Error('BUNDLE_RUNTIME_MISSING:' + file);
  }
  const app = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  const manifest = { version: 1, platform: 'win32-x64', appVersion: app.version, files };
  writeFileSync(join(out, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, out, ...extra] = process.argv.slice(2);
  if (!out || extra.length || !['stage', 'manifest'].includes(operation)) throw Error('BUNDLE_BUILD_ARGUMENTS');
  if (operation === 'stage') stageWindowsBundle(resolve(out)); else manifestWindowsBundle(resolve(out));
}
