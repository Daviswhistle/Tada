// An opt-in contact surface, not the privileged daemon control API.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseUniqueJson } from './json.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const assets = new Map([
  ['/', ['text/html; charset=utf-8', new URL('../../../apps/contact/index.html', import.meta.url)]],
  ['/app.js', ['text/javascript; charset=utf-8', new URL('../../../apps/contact/app.js', import.meta.url)]],
  ['/app.css', ['text/css; charset=utf-8', new URL('../../../apps/contact/app.css', import.meta.url)]],
]);
function object(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== [...keys].sort().join(',')) throw new Error('CONTACT_REQUEST_INVALID');
}
async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('CONTACT_CONTENT_TYPE');
  const chunks = []; let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > 8192) throw new Error('CONTACT_BODY_LIMIT');
    chunks.push(chunk);
  }
  return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), 8192);
}
export function validateContactAddress({ origin, bind = '127.0.0.1', port, tls }) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)
      || !Number.isInteger(port) || port < 0 || port > 65535 || typeof bind !== 'string') throw new Error('CONTACT_ADDRESS_INVALID');
  if (url.protocol === 'http:' && (url.hostname !== '127.0.0.1' || bind !== '127.0.0.1' || tls)) throw new Error('CONTACT_REMOTE_TLS_REQUIRED');
  if (bind !== '127.0.0.1' && !tls) throw new Error('CONTACT_REMOTE_TLS_REQUIRED');
  if (tls && url.protocol !== 'https:') throw new Error('CONTACT_REMOTE_TLS_REQUIRED');
  return url;
}
export async function serveContact({ store, service, origin, bind = '127.0.0.1', port, tls, messaging = () => store.messagingStatus() }) {
  const url = validateContactAddress({ origin, bind, port, tls });
  const cookieName = url.protocol === 'https:' ? '__Host-tada' : 'tada_local';
  const pairing = new Map();
  const streams = new Set();
  let pairWindow = Date.now(), pairAttempts = 0;
  const tokenOf = req => {
    const items = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
    return items.length === 1 ? items[0].slice(cookieName.length + 1) : '';
  };
  const setCookie = (token, age = 30 * 86400) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
  const send = (res, status, value, extra = {}) => {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(value));
  };
  const listener = async (req, res) => {
    const timer = setTimeout(() => { req.destroy(); }, 10000);
    try {
      // Do not infer an origin or principal from attacker-controlled Forwarded,
      // X-Forwarded-Host/User or proxy identity headers.
      if (req.headers.host !== url.host || (req.headers.origin && req.headers.origin !== origin)
          || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
        return send(res, 403, { error: 'CONTACT_ORIGIN_REJECTED' });
      }
      const target = new URL(req.url, origin);
      if (req.method === 'GET' && assets.has(target.pathname) && !target.search) {
        const [type, file] = assets.get(target.pathname);
        res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(readFileSync(file)); return;
      }
      if (req.method === 'POST' && req.headers.origin !== origin) return send(res, 403, { error: 'CONTACT_ORIGIN_REQUIRED' });
      if (req.method === 'POST' && target.pathname === '/api/pair' && !target.search) {
        if (Date.now() - pairWindow > 60000) { pairAttempts = 0; pairWindow = Date.now(); }
        if (++pairAttempts > 20) return send(res, 429, { error: 'CONTACT_PAIR_RATE_LIMIT' });
        const data = await jsonBody(req); object(data, ['code', 'name']);
        if (typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(data.code)) return send(res, 403, { error: 'CONTACT_PAIR_REJECTED' });
        const key = sha(data.code), expiry = pairing.get(key);
        if (!expiry || expiry < Date.now()) return send(res, 403, { error: 'CONTACT_PAIR_REJECTED' });
        const device = store.addDevice(data.name);
        pairing.delete(key);
        return send(res, 200, { device: device.id }, { 'Set-Cookie': setCookie(device.token) });
      }
      const device = store.authenticate(tokenOf(req));
      if (!device) return send(res, 401, { error: 'CONTACT_PAIR_REQUIRED' });
      if (req.method === 'GET' && target.pathname === '/api/state') {
        if ([...target.searchParams.keys()].some(key => key !== 'before') || target.searchParams.getAll('before').length > 1) throw new Error('CONTACT_CURSOR_INVALID');
        const before = target.searchParams.has('before') ? Number(target.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
        return send(res, 200, { assistant: store.id, device, ...store.page(before), usage: store.usage(), messaging: messaging(), followups: store.followupState(), host_stopping: service.stopped });
      }
      if (req.method === 'GET' && target.pathname === '/api/events' && !target.search) {
        if (streams.size >= 16) return send(res, 429, { error: 'CONTACT_CONNECTION_LIMIT' });
        clearTimeout(timer);
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const client = { res, token: tokenOf(req) };
        streams.add(client);
        res.write('event: changed\ndata: {}\n\n');
        req.on('close', () => { streams.delete(client); });
        return;
      }
      if (req.method === 'POST' && target.pathname === '/api/turns' && !target.search) {
        const data = await jsonBody(req); object(data, ['request_id', 'text']);
        // Authentication is checked again on durable admission and each model
        // request: a slow body cannot race a device revocation into new work.
        return send(res, 202, service.submit(device, data.request_id, data.text));
      }
      if (req.method === 'POST' && target.pathname === '/api/cancel' && !target.search) {
        const data = await jsonBody(req); object(data, ['seq']);
        if (!Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error('CONTACT_REQUEST_INVALID');
        if (!store.authenticate(tokenOf(req))) return send(res, 401, { error: 'CONTACT_PAIR_REQUIRED' });
        return send(res, 200, { changed: service.cancel(data.seq) });
      }
      if (req.method === 'GET' && target.pathname === '/api/followups') {
        if ([...target.searchParams.keys()].some(k => k !== 'offset') || target.searchParams.getAll('offset').length > 1) throw new Error('CONTACT_CURSOR_INVALID');
        return send(res, 200, store.followupPage('all', Number(target.searchParams.get('offset') ?? 0)));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/decision' && !target.search) {
        const data = await jsonBody(req); object(data, ['proposal_id', 'decision']);
        return send(res, 200, service.confirmFollowup(device, data.proposal_id, data.decision));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/review' && !target.search) {
        const data = await jsonBody(req); object(data, ['commitment', 'version', 'consent']);
        return send(res, 200, service.armReview(device, data.commitment, data.version, data.consent));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/review/cancel' && !target.search) {
        const data = await jsonBody(req); object(data, ['commitment', 'version']);
        return send(res, 200, service.cancelReview(device, data.commitment, data.version));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/seen' && !target.search) {
        const data = await jsonBody(req); object(data, ['notice_id']);
        store.dismissFollowupNotice(device, data.notice_id); service.emit('change');
        return send(res, 200, { acknowledged: true });
      }
      if (req.method === 'POST' && target.pathname === '/api/logout' && !target.search) {
        const data = await jsonBody(req); object(data, []);
        service.revoke(device);
        return send(res, 200, { disconnected: true }, { 'Set-Cookie': setCookie('', 0) });
      }
      send(res, 404, { error: 'CONTACT_ROUTE_NOT_FOUND' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, 400, { error: /^CONTACT_[A-Z_]+$/u.test(error.message) ? error.message : 'CONTACT_REQUEST_REJECTED' });
      else if (!res.destroyed) res.destroy();
    } finally { clearTimeout(timer); }
  };
  const server = tls ? httpsServer({ ...tls, minVersion: 'TLSv1.2' }, listener) : httpServer(listener);
  server.maxConnections = 32;
  server.maxHeadersCount = 32;
  server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const changed = () => {
    for (const client of streams) {
      let live = false;
      try { live = !!store.authenticate(client.token); } catch { /* unavailable store closes subscriptions */ }
      if (!live || !client.res.write('event: changed\ndata: {}\n\n')) { client.res.end(); streams.delete(client); }
    }
  };
  service.on('change', changed);
  const heartbeat = setInterval(changed, 15000); heartbeat.unref();
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, bind, yes); });
  } catch (error) { clearInterval(heartbeat); service.off('change', changed); throw error; }
  return {
    address: server.address(),
    pair() {
      for (const [key, expiry] of pairing) if (expiry < Date.now()) pairing.delete(key);
      if (pairing.size >= 8) throw new Error('CONTACT_PAIR_LIMIT');
      const code = randomBytes(32).toString('base64url');
      pairing.set(sha(code), Date.now() + 5 * 60000);
      return `${origin}/#pair=${code}`;
    },
    async close() {
      clearInterval(heartbeat); service.off('change', changed); pairing.clear();
      for (const client of streams) client.res.end();
      streams.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
