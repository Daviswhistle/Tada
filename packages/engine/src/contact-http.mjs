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
  ['/markdown.js', ['text/javascript; charset=utf-8', new URL('../../../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', import.meta.url)]],
  ['/third-party-notices.txt', ['text/plain; charset=utf-8', new URL('../../../apps/contact/third-party-notices.txt', import.meta.url)]],
  ['/app.js', ['text/javascript; charset=utf-8', new URL('../../../apps/contact/app.js', import.meta.url)]],
  ['/app.css', ['text/css; charset=utf-8', new URL('../../../apps/contact/app.css', import.meta.url)]],
]);
function object(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== [...keys].sort().join(',')) throw new Error('CONTACT_REQUEST_INVALID');
}
async function jsonBody(req, limit = 8192) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('CONTACT_CONTENT_TYPE');
  const chunks = []; let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > limit) throw new Error('CONTACT_BODY_LIMIT');
    chunks.push(chunk);
  }
  return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), limit);
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
export async function serveContact({ store, service, origin, bind = '127.0.0.1', port, tls, mobile = null, background = null, recovery = null, privacy = null, messaging = () => store.messagingStatus() }) {
  const url = validateContactAddress({ origin, bind, port, tls });
  // Hold one matching UI version for this host's lifetime, including its parser.
  // Updating files on disk cannot mix old HTML with a new client or missing bundle.
  const loadedAssets = new Map([...assets].map(([path, [type, file]]) => [path, [type, readFileSync(file)]]));
  const legacyCookieName = url.protocol === 'https:' ? '__Host-tada' : 'tada_local';
  // Browser cookies are shared across ports. Keep independently stored
  // assistants from replacing each other's connection, even on localhost.
  // Journal identity remains stable when this host restarts on another port.
  const cookieName = `${legacyCookieName}_${sha(store.id).slice(0, 24)}`;
  const pairing = new Map();
  const streams = new Set();
  const viewInstance = randomBytes(16).toString('hex');
  let pairWindow = Date.now(), pairAttempts = 0, appPair;
  const cookieOf = req => {
    const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim());
    const scoped = cookies.filter(s => s.startsWith(`${cookieName}=`));
    // An invalid/duplicate scoped cookie must not fall back to another token.
    if (scoped.length) return { token: scoped.length === 1 ? scoped[0].slice(cookieName.length + 1) : '', legacy: false };
    const legacy = cookies.filter(s => s.startsWith(`${legacyCookieName}=`));
    return { token: legacy.length === 1 ? legacy[0].slice(legacyCookieName.length + 1) : '', legacy: true };
  };
  const tokenOf = req => cookieOf(req).token;
  const setCookie = (token, age = 30 * 86400) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
  const send = (res, status, value, extra = {}) => {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(value));
  };
  const assertAccepting = () => { if (service.stopped) throw Error('CONTACT_HOST_STOPPING'); };
  const readBody = async (req, limit) => { const data = await jsonBody(req, limit); assertAccepting(); return data; };
  const listener = async (req, res) => {
    const timer = setTimeout(() => { req.destroy(); }, req.url === '/api/records/backup' ? 30000 : 10000);
    try {
      // Do not infer an origin or principal from attacker-controlled Forwarded,
      // X-Forwarded-Host/User or proxy identity headers.
      // Serve the public entry document across ports/schemes (including HTTPS).
      // No private data is in it; API requests still require the exact origin.
      const entryNavigation = req.method === 'GET' && req.url === '/'
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
        && ['same-site', 'cross-site'].includes(req.headers['sec-fetch-site']);
      if (req.headers.host !== url.host || (req.headers.origin && req.headers.origin !== origin)
          || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']) && !entryNavigation)) {
        return send(res, 403, { error: 'CONTACT_ORIGIN_REJECTED' });
      }
      const target = new URL(req.url, origin);
      if (req.method === 'GET' && loadedAssets.has(target.pathname) && !target.search) {
        const [type, content] = loadedAssets.get(target.pathname);
        res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(content); return;
      }
      if (req.method === 'POST' && req.headers.origin !== origin) return send(res, 403, { error: 'CONTACT_ORIGIN_REQUIRED' });
      if (req.method === 'POST') assertAccepting();
      if (req.method === 'POST' && target.pathname === '/api/pair' && !target.search) {
        if (Date.now() - pairWindow > 60000) { pairAttempts = 0; pairWindow = Date.now(); }
        if (++pairAttempts > 20) return send(res, 429, { error: 'CONTACT_PAIR_RATE_LIMIT' });
        const data = await readBody(req); object(data, ['code', 'name']);
        if (typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(data.code)) return send(res, 403, { error: 'CONTACT_PAIR_REJECTED' });
        const key = sha(data.code), expiry = pairing.get(key);
        if (!expiry || expiry < Date.now()) return send(res, 403, { error: 'CONTACT_PAIR_REJECTED' });
        const device = store.addDevice(data.name);
        pairing.delete(key);
        return send(res, 200, { device: device.id }, { 'Set-Cookie': setCookie(device.token) });
      }
      const cookie = cookieOf(req), device = store.authenticate(cookie.token);
      if (!device) return send(res, 401, { error: 'CONTACT_PAIR_REQUIRED' });
      // Preserve an existing connection only after this journal authenticates
      // its legacy token. Other still-running versions may need that cookie.
      if (cookie.legacy) res.setHeader('Set-Cookie', setCookie(cookie.token));
      if(req.method==='POST' && target.pathname==='/api/records/privacy' && !target.search){
        const data=await readBody(req);object(data,[]);assertAccepting();store.assertDevice(device);
        if(!privacy)return send(res,409,{error:'CONTACT_APP_ERASE_UNAVAILABLE'});return send(res,200,{url:privacy()});
      }
      if (req.method === 'POST' && target.pathname === '/api/records/restore' && !target.search) {
        const data=await readBody(req);object(data,[]);assertAccepting();store.assertDevice(device);
        if (!recovery) return send(res,409,{error:'CONTACT_APP_RECOVERY_UNAVAILABLE'});
        return send(res,200,{url:recovery()});
      }
      if (req.method === 'POST' && target.pathname === '/api/records/backup' && !target.search) {
        const data = await readBody(req); object(data, ['portable', 'consent']);
        const backup = await service.backupRecords(device, data.portable, data.consent);
        assertAccepting(); store.assertDevice(device);
        if (res.destroyed) return;
        res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': backup.bytes.length,
          'Content-Disposition': `attachment; filename="tada-records-${new Date(backup.created_at).toISOString().slice(0,10)}.tadabackup"`,
          ...(backup.recoveryCode ? { 'X-Tada-Recovery-Code': backup.recoveryCode } : {}) });
        res.end(backup.bytes); return;
      }
      if (req.method === 'GET' && /^\/api\/mail\/mail-[a-f0-9-]{36}$/u.test(target.pathname) && !target.search) {
        return send(res, 200, { mail: store.readMailAction(target.pathname.split('/').at(-1)) });
      }
      if (req.method === 'POST' && ['/api/mail/edit', '/api/mail/discard', '/api/mail/send', '/api/mail/reconcile'].includes(target.pathname) && !target.search) {
        const data = await readBody(req, 49152);
        const action = target.pathname.split('/').at(-1);
        object(data, action === 'reconcile' ? ['id'] : action === 'edit' ? ['id', 'revision', 'sha256', 'draft'] : action === 'send' ? ['id', 'revision', 'sha256', 'consent'] : ['id', 'revision', 'sha256']);
        const mail = action === 'edit' ? service.editMail(device, data) : action === 'discard' ? service.discardMail(device, data)
          : action === 'send' ? await service.sendMail(device, data) : await service.reconcileMail(device, data.id);
        store.assertDevice(device); return send(res, 200, { mail });
      }
      if (req.method === 'POST' && target.pathname === '/api/google/disable-mail' && !target.search) {
        const data = await readBody(req); object(data, []); return send(res, 200, service.disableMail(device));
      }
      if (req.method === 'GET' && /^\/api\/documents\/[1-9][0-9]*\/edit$/u.test(target.pathname) && !target.search) {
        const document = store.latestDocument(Number(target.pathname.split('/').at(-2)));
        if (!document) return send(res, 404, { error: 'CONTACT_DOCUMENT_NOT_FOUND' });
        return send(res, 200, { document });
      }
      if (req.method === 'POST' && target.pathname === '/api/documents/edit' && !target.search) {
        const data = await readBody(req, 32768); object(data, ['request_id', 'based_on', 'title', 'content']);
        return send(res, 200, service.editDocument(device, data));
      }
      if (req.method === 'GET' && /^\/api\/documents\/[1-9][0-9]*$/u.test(target.pathname) && !target.search) {
        const document = store.document(Number(target.pathname.split('/').at(-1)));
        if (!document) return send(res, 404, { error: 'CONTACT_DOCUMENT_NOT_FOUND' });
        const extension = document.format === 'markdown' ? 'md' : 'txt';
        const content = document.content + (document.author === 'owner' ? '\n\n---\n직접 수정한 문서입니다. 아래 참고 자료는 이전 버전에서 이어받았으며 수정한 내용의 검증을 뜻하지 않습니다.\n' : '') + (document.sources.length ? '\n\n---\n참고 자료\n' + document.sources.map(source =>
          `[${source.id}] ${source.source}/${source.path} · 확인 시각 ${source.observed_at}`
          + (source.citations?.length ? '\n' + source.citations.map(citation => {
            // Titles are untrusted provider text, even inside a downloaded Markdown file.
            const title = document.format === 'markdown' ? citation.title.replace(/[\\`*_{}\[\]()#+.!<>|~-]/gu, '\\$&') : citation.title;
            const url = new URL(citation.url).href;
            return document.format === 'markdown' ? `  ${title} · <${url}>` : `  ${title} · ${url}`;
          }).join('\n') : '')).join('\n') + '\n' : '');
        res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="tada-document-${document.id}-v${document.revision}.${extension}"`,
          'Content-Length': Buffer.byteLength(content), 'X-Content-SHA256': sha(content) });
        res.end(content); return;
      }
      if (req.method === 'GET' && target.pathname === '/api/state') {
        if ([...target.searchParams.keys()].some(key => key !== 'before') || target.searchParams.getAll('before').length > 1) throw new Error('CONTACT_CURSOR_INVALID');
        const before = target.searchParams.has('before') ? Number(target.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
        const startup = background ? await background.status() : null; store.assertDevice(device);
        return send(res, 200, { assistant: store.id, device, document_editing: store.contactVersion >= 5, ...store.page(before), usage: store.historicalUsage(), recovery: store.recoveryStatus(), record_restore_available: !!recovery, record_erase_available: !!privacy, continuing_use: store.useStatus(), messaging: messaging(), followups: { ...store.followupState(), view_revision: sha(`${viewInstance}:${store.changeCount()}`), reviews_available: store.contactVersion >= 4 && service.localReviews }, provider: service.providerStatus, proactive: store.proactiveStatus(), google: service.googleStatus(), browser: service.browserStatus(device), mobile: mobile?.status() ?? null, background: startup, host_stopping: service.stopped });
      }
      if (req.method === 'POST' && target.pathname === '/api/background' && !target.search && background) {
        const data = await readBody(req); object(data, ['enabled', 'consent']);
        const { transfer, ...state } = await background.configure(data.enabled, data.consent, () => { assertAccepting(); store.assertDevice(device); });
        // Deliver the accepted setting before releasing this runtime's lease.
        if (transfer) {
          let transferred = false;
          const handoff = () => { if (!transferred) { transferred = true; void background.handoff().catch(() => service.emit('change')); } };
          if (res.destroyed) handoff(); else { res.once('finish', handoff); res.once('close', handoff); }
        }
        return send(res, 200, { ...state, transferring: transfer === true });
      }
      if (req.method === 'POST' && target.pathname === '/api/followup-delegation' && !target.search) {
        const data = await readBody(req); object(data, ['enabled', 'consent']);
        const result = store.configureFollowupDelegation(device, data.enabled, data.consent);
        service.emit('change'); return send(res, 200, result);
      }
      if (req.method === 'POST' && target.pathname === '/api/continuing-use' && !target.search) {
        const data = await readBody(req); object(data, ['enabled', 'consent']);
        const result = store.configureContinuingUse(device, data.enabled, data.consent);
        service.emit('change'); return send(res, 200, result);
      }
      if (req.method === 'POST' && target.pathname === '/api/proactive' && !target.search) {
        const data = await readBody(req); object(data, ['enabled', 'consent']);
        return send(res, 200, service.configureProactive(device, data.enabled, data.consent));
      }
      if (req.method === 'GET' && target.pathname === '/api/browser/tabs' && !target.search) return send(res, 200, { tabs: await service.browserTabs(device) });
      if (req.method === 'POST' && target.pathname === '/api/browser/open' && !target.search) {
        object(await readBody(req), []); return send(res, 200, await service.openBrowser(device));
      }
      if (req.method === 'POST' && target.pathname === '/api/browser/share' && !target.search) {
        const data = await readBody(req); object(data, ['target', 'consent', 'url']);
        if (typeof data.target !== 'string' || data.target.length > 200) throw Error('CONTACT_REQUEST_INVALID');
        return send(res, 200, await service.shareBrowser(device, data.target, data.consent, data.url));
      }
      if (req.method === 'POST' && target.pathname === '/api/browser/stop' && !target.search) {
        object(await readBody(req), []); return send(res, 200, service.unshareBrowser(device));
      }
      if (req.method === 'POST' && target.pathname === '/api/browser/resolve' && !target.search) {
        const data = await readBody(req); object(data, ['id', 'consent']);
        return send(res, 200, service.resolveBrowser(device, data.id, data.consent));
      }
      if (req.method === 'POST' && target.pathname === '/api/google/connect' && !target.search) {
        const data = await readBody(req); object(data, ['consent']); store.assertDevice(device);
        return send(res, 202, await service.connectGoogle(device, data.consent));
      }
      if (req.method === 'POST' && target.pathname === '/api/google/related-mail' && !target.search) {
        const data = await readBody(req); object(data, ['enabled', 'consent']);
        return send(res, 200, service.configureRelatedMail(device, data.enabled, data.consent));
      }
      if (req.method === 'POST' && target.pathname === '/api/google/disconnect' && !target.search) {
        const data = await readBody(req); object(data, []); store.assertDevice(device);
        return send(res, 200, await service.disconnectGoogle(device));
      }
      if (req.method === 'POST' && target.pathname.startsWith('/api/mobile/') && !target.search && mobile) {
        const data = await readBody(req);
        // Recheck after body receipt and inside the controller after async inspection.
        store.assertDevice(device);
        if (target.pathname === '/api/mobile/connect') {
          object(data, ['token', 'consent']); return send(res, 200, await mobile.connect(device, data.token, data.consent));
        }
        if (target.pathname === '/api/mobile/reconnect') { object(data, []); return send(res, 200, await mobile.reconnect(device)); }
        if (target.pathname === '/api/mobile/pair') { object(data, []); return send(res, 200, mobile.pair(device)); }
        if (target.pathname === '/api/mobile/approve') { object(data, ['candidate']); return send(res, 200, mobile.approve(device, data.candidate)); }
        if (target.pathname === '/api/mobile/disconnect') { object(data, []); return send(res, 200, await mobile.disconnect(device)); }
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
        const data = await readBody(req); object(data, ['request_id', 'text']);
        // Authentication is checked again on durable admission and each model
        // request: a slow body cannot race a device revocation into new work.
        return send(res, 202, service.submit(device, data.request_id, data.text));
      }
      if (req.method === 'POST' && target.pathname === '/api/cancel' && !target.search) {
        const data = await readBody(req); object(data, ['seq']);
        if (!Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error('CONTACT_REQUEST_INVALID');
        if (!store.authenticate(tokenOf(req))) return send(res, 401, { error: 'CONTACT_PAIR_REQUIRED' });
        return send(res, 200, { changed: service.cancel(data.seq) });
      }
      if (req.method === 'GET' && target.pathname === '/api/followups') {
        if ([...target.searchParams.keys()].some(k => k !== 'offset') || target.searchParams.getAll('offset').length > 1) throw new Error('CONTACT_CURSOR_INVALID');
        return send(res, 200, store.followupPage('all', Number(target.searchParams.get('offset') ?? 0)));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/decision' && !target.search) {
        const data = await readBody(req); object(data, ['proposal_id', 'decision']);
        return send(res, 200, service.confirmFollowup(device, data.proposal_id, data.decision));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/review' && !target.search) {
        const data = await readBody(req); object(data, ['commitment', 'version', 'consent']);
        return send(res, 200, service.armReview(device, data.commitment, data.version, data.consent));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/review/cancel' && !target.search) {
        const data = await readBody(req); object(data, ['commitment', 'version']);
        return send(res, 200, service.cancelReview(device, data.commitment, data.version));
      }
      if (req.method === 'POST' && target.pathname === '/api/followups/seen' && !target.search) {
        const data = await readBody(req); object(data, ['notice_id']);
        store.dismissFollowupNotice(device, data.notice_id); service.emit('change');
        return send(res, 200, { acknowledged: true });
      }
      if (req.method === 'POST' && target.pathname === '/api/logout' && !target.search) {
        const data = await readBody(req); object(data, []);
        service.revoke(device);
        return send(res, 200, { disconnected: true }, { 'Set-Cookie': setCookie('', 0) });
      }
      send(res, 404, { error: 'CONTACT_ROUTE_NOT_FOUND' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.message === 'CONTACT_HOST_STOPPING' ? 503 : 400, { error: /^CONTACT_[A-Z_]+$/u.test(error.message) ? error.message : 'CONTACT_REQUEST_REJECTED' });
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
    pair({ replaceApp = false } = {}) {
      if (replaceApp && appPair && pairing.get(appPair.key) > Date.now()) return `${origin}/#pair=${appPair.code}`;
      if (replaceApp && appPair) pairing.delete(appPair.key);
      for (const [key, expiry] of pairing) if (expiry < Date.now()) pairing.delete(key);
      if (pairing.size >= 8) throw new Error('CONTACT_PAIR_LIMIT');
      const code = randomBytes(32).toString('base64url');
      pairing.set(sha(code), Date.now() + 5 * 60000);
      if (replaceApp) appPair = { key: sha(code), code };
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
