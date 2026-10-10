import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

for (const [name, source, expected] of [
  ['spawn failure', "process.execPath += '-missing-fixture-node';", /ENOENT/],
  ['IPC send failure', "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const fork=cp.fork; cp.fork=(...args)=>{const child=fork(...args); child.send=(message,callback)=>{process.nextTick(()=>callback(Error('SYNTHETIC_IPC_CLOSED'))); return false;}; return child;}; syncBuiltinESMExports();", /SYNTHETIC_IPC_CLOSED/],
  ['child error event', "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const fork=cp.fork; cp.fork=(...args)=>{const child=fork(...args); child.send=()=>{process.nextTick(()=>child.emit('error',Error('SYNTHETIC_CHILD_ERROR'))); return false;}; return child;}; syncBuiltinESMExports();", /SYNTHETIC_CHILD_ERROR/],
  // Skip only the unrelated inference group in this injected failure regression.
  ['malformed MIME', "const iterator=Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator]=function(){return iterator.call(this.length===2&&this[0]==='inference'&&this[1]==='mail'?['mail']:this);}; const original=globalThis.fetch; globalThis.fetch=(url,options)=>original(url,options?.method==='POST'&&String(url).endsWith('/send')?{...options,body:JSON.stringify({raw:Buffer.from('SYNTHETIC_MALFORMED_MIME').toString('base64url')})}:options);", /ERR_ASSERTION/],
]) test(`crash harness ${name} writes failure report and removes its fixture`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tada-crash-error-'));
  const output = join(root, 'report.json'), pidsFile = join(root, 'child-pids');
  await writeFile(pidsFile, '');
  const observed = "import observedCP from 'node:child_process'; import {syncBuiltinESMExports as syncObserved} from 'node:module'; import {appendFileSync} from 'node:fs'; const observedFork=observedCP.fork; observedCP.fork=(...args)=>{const child=observedFork(...args); if(child.pid)appendFileSync(process.env.TADA_FIXTURE_PID_FILE,String(child.pid)+'\\n'); return child;}; syncObserved(); ";
  const childPids = async () => (await readFile(pidsFile, 'utf8')).trim().split(/\s+/u).filter(Boolean).map(Number);
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['--experimental-strip-types', '--import', `data:text/javascript,${encodeURIComponent(observed + source)}`,
      fileURLToPath(new URL('./contact-crash-acceptance.mjs', import.meta.url)), output],
    { env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root, TADA_FIXTURE_PID_FILE: pidsFile }, timeout: 15000 }), error => error.code === 1);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.passed, false); assert.match(report.error, expected);
    assert.equal(report.samples.length, 1); assert.equal(report.samples[0].passed, false);
    assert.deepEqual((await readdir(root)).sort(), ['child-pids', 'report.json']);
    for (const pid of await childPids()) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally {
    for (const pid of await childPids()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(root, { recursive: true, force: true });
  }
});
