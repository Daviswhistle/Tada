// Validate raw JSON before JSON.parse can discard duplicate keys. No repairs.
export function parseUniqueJson(text, maxBytes = 16384) {
  const fail = () => { throw new Error('ENGINE_INVALID_JSON'); };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144
      || typeof text !== 'string' || new TextEncoder().encode(text).length > maxBytes) fail();
  let at = 0;
  const ws = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  function string() {
    if (text[at] !== '"') fail();
    const start = at++;
    let closed = false;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') { closed = true; break; }
      if (c === '\\') at++;
    }
    if (!closed) fail();
    let value;
    try { value = JSON.parse(text.slice(start, at)); } catch { fail(); }
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) fail();
      } else if (code >= 0xdc00 && code <= 0xdfff) fail();
    }
    return value;
  }
  function value(depth) {
    if (depth > 64) fail();
    ws();
    const c = text[at];
    if (c === '"') { string(); return; }
    if (c === '{' || c === '[') {
      const object = c === '{';
      const close = object ? '}' : ']';
      const keys = new Set();
      at++; ws();
      if (text[at] === close) { at++; return; }
      for (;;) {
        if (object) {
          ws(); const key = string();
          if (keys.has(key)) fail();
          keys.add(key); ws();
          if (text[at++] !== ':') fail();
        }
        value(depth + 1); ws();
        if (text[at] === close) { at++; return; }
        if (text[at++] !== ',') fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) fail();
    if (!['true','false','null'].includes(token[0]) && !Number.isFinite(Number(token[0]))) fail();
    at += token[0].length;
  }
  value(0); ws();
  if (at !== text.length) fail();
  try { return JSON.parse(text); } catch { fail(); }
}
