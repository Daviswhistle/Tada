// Private parent pipe: only a fixed open command, never a URL or account data.
// Closing the pipe stops this host; it does not revoke saved work or accounts.
export function superviseWindow(input, { open, stop, failed }) {
  let line = '', discarded = false, closed = false, opening = false, prefix = 0;
  const end = () => { if (!closed) { closed = true; stop(); } };
  input.on('data', chunk => {
    for (const byte of chunk) {
      // .NET Framework constructs its redirected stdin writer using the local
      // console encoding and may flush a UTF-8 BOM before our first write.
      // Accept that exact preamble only at stream start, including split chunks.
      if (prefix < 3) {
        if (byte === [0xef, 0xbb, 0xbf][prefix]) { prefix++; continue; }
        if (prefix > 0) discarded = true;
        prefix = 3;
      }
      if (byte === 10) {
        const command = !discarded && (line === 'TADA_OPEN_V1' || line === 'TADA_OPEN_V1\r'); line = ''; discarded = false;
        if (command && !closed && !opening) {
          opening = true;
          Promise.resolve().then(() => { if (!closed) return open(); })
            .catch(() => { if (!closed) failed(); }).finally(() => { opening = false; });
        }
      } else {
        if (line.length >= 32 || (byte < 32 && byte !== 13) || byte > 126) { discarded = true; line = ''; }
        else if (!discarded) line += String.fromCharCode(byte);
      }
    }
  });
  input.once('end', end); input.once('error', end);
  input.resume(); input.unref?.();
}
