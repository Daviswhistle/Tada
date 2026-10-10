// Test-fixture lifecycle only; never attaches to an owner process.
import { once } from 'node:events';

export function fixtureMessage(child, { send, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', message); child.off('exit', exit); child.off('error', failure);
      if (error) reject(error); else resolve(value);
    };
    const message = value => finish(null, value);
    const exit = (code, signal) => finish(Error(`FIXTURE_EXIT: ${code}/${signal}`));
    const failure = error => finish(error);
    child.once('message', message); child.once('exit', exit); child.once('error', failure);
    timer = setTimeout(() => finish(Error('FIXTURE_IPC_TIMEOUT')), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) { exit(child.exitCode, child.signalCode); return; }
    if (send !== undefined) {
      try { child.send(send, error => { if (error) failure(error); }); }
      catch (error) { failure(error); }
    }
  });
}

export async function stopFixture(child) {
  const exited = () => !child.pid || child.exitCode !== null || child.signalCode !== null;
  const wait = async (action) => {
    if (exited()) return;
    const done = once(child, 'exit', { signal: AbortSignal.timeout(1000) });
    try { action(); } catch { /* A concurrent disconnect is handled by the exit wait. */ }
    await done;
  };
  if (exited()) return;
  try { await wait(() => child.connected ? child.disconnect() : child.kill('SIGTERM')); }
  catch { if (!exited()) await wait(() => child.kill('SIGKILL')); }
}
