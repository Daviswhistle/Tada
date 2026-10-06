// Opt-in evaluator diagnostics only. Use with disposable fixture conversations,
// never a personal journal. Records normalized tool messages, not hidden model
// reasoning, credentials, or a replacement input. Capture is strictly bounded.
export function modelDiagnostics(maxBytes = 65536) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) {
    throw new Error('MODEL_DIAGNOSTICS_LIMIT');
  }
  let capturedBytes = 0, omitted = 0;
  const events = [];
  return {
    record(event) {
      const text = JSON.stringify(event), bytes = Buffer.byteLength(text);
      if (capturedBytes + bytes > maxBytes) { omitted++; return; }
      events.push(JSON.parse(text)); capturedBytes += bytes;
    },
    snapshot() { return structuredClone({ max_bytes: maxBytes, captured_bytes: capturedBytes, omitted_events: omitted, events }); },
  };
}
