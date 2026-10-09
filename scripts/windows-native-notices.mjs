// Cargo metadata must come from the same locked source used to build the broker.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const [metadataPath, toolchainNotices, output, ...extra] = process.argv.slice(2);
if (!metadataPath || !toolchainNotices || !output || extra.length || existsSync(output)) throw Error('NATIVE_NOTICES_ARGUMENTS');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/u, ''));
mkdirSync(output, { recursive: true });
const packages = [];
for (const pkg of metadata.packages) {
  if (!pkg.source) continue;
  if (!pkg.license && !pkg.license_file) throw Error('NATIVE_LICENSE_MISSING:' + pkg.name);
  const root = dirname(pkg.manifest_path), folder = `${pkg.name}-${pkg.version}`;
  const notices = readdirSync(root).filter(name => /^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([.-]|$)/iu.test(name));
  if (pkg.license_file) {
    const name = basename(pkg.license_file);
    if (!notices.includes(name)) {
      mkdirSync(join(output, folder), { recursive: true }); cpSync(resolve(root, pkg.license_file), join(output, folder, name)); notices.push(name);
    }
  }
  for (const name of notices) {
    const target = join(output, folder, name);
    if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, name), target, { recursive: true }); }
  }
  packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, notices });
}
cpSync(toolchainNotices, join(output, 'rust-toolchain'), { recursive: true });
writeFileSync(join(output, 'native-dependencies.json'), JSON.stringify({ format: 1, packages }, null, 2) + '\n');
