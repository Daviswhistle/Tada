// Chromium stderr is a pipe, not an unlimited log sink. Always drain it so a
// verbose child cannot stall before replying on its debugging pipe. Keep only
// a bounded diagnostic tail; do not change browser policy or command deadlines.
export function drainBrowserStderr(child, limit = 8192) {
  if (!child?.stderr || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) {
    throw new Error('BROWSER_DIAGNOSTICS_CONFIGURATION');
  }
  let tail = Buffer.alloc(0), bytes = 0;
  child.stderr.on('data', chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    tail = Buffer.concat([tail, data]).subarray(-limit);
  });
  return () => ({ stderr_bytes: bytes,
    stderr_tail: tail.toString('utf8').replace(/#pair=[A-Za-z0-9_-]+/gu, '#pair=[redacted]'),
    exit_code: child.exitCode, signal: child.signalCode });
}
