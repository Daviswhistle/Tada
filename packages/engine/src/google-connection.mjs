import { EventEmitter } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseUniqueJson } from './json.mjs';
import { GOOGLE_SCOPES } from './google-contract.mjs';
import { openSystemBrowser } from './system-browser.mjs';
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_TOKEN_BYTES = 16384;
const MAX_JSON_BYTES = 262144;
const GOOGLE_STATUS_ERRORS = new Set(['authorization_denied', 'temporarily_unavailable', 'permission_denied', 'reconnect_required']);

const bytes = value => Buffer.byteLength(value, 'utf8');
const safeAccount = value => typeof value === 'string' && value.length <= 254
  && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const safeToken = value => typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);
const scopesMatch = value => Array.isArray(value) && value.length === GOOGLE_SCOPES.length
  && [...value].sort().join('\n') === [...GOOGLE_SCOPES].sort().join('\n');
const jsonHeaders = { 'Accept': 'application/json', 'Cache-Control': 'no-store' };

function assertResponseShape(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || required.some(key => !Object.hasOwn(value, key))) throw Error('CONTACT_GOOGLE_RESPONSE_INVALID');
}

async function boundedBody(response, maxBytes) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw Error('CONTACT_GOOGLE_RESPONSE_LIMIT');
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw Error('CONTACT_GOOGLE_RESPONSE_LIMIT');
    return buffer;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw Error('CONTACT_GOOGLE_RESPONSE_LIMIT'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

async function responseJson(response, maxBytes) {
  const body = await boundedBody(response, maxBytes);
  try {
    const result = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(body), maxBytes);
    assertResponseShape(result, []);
    return result;
  }
  catch { throw Error('CONTACT_GOOGLE_RESPONSE_INVALID'); }
}

function loopbackTestEndpoints(value) {
  if (value === undefined) return null;
  if (!value || Object.keys(value).sort().join(',') !== 'calendar,gmail,revoke,token'
      || Object.values(value).some(raw => {
        try {
          const url = new URL(raw);
          return url.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname)
            || !url.port || url.username || url.password || url.search || url.hash;
        } catch { return true; }
      })) throw Error('CONTACT_GOOGLE_TEST_ENDPOINT_INVALID');
  return Object.fromEntries(Object.entries(value).map(([key, url]) => [key, new URL(url).href.replace(/\/$/u, '')]));
}

export class GoogleConnection extends EventEmitter {
  #store; #clientId; #clientSecret; #openBrowser; #fetch; #clock; #endpoints;
  #attempt = null; #revocation = null; #access = new Map(); #refreshes = new Map(); #epochAborts = new Map(); #expiredEpoch = null; #lastError = null; #lastDisconnect = null;
  constructor({ store, clientId = '', clientSecret = '', openBrowser = openSystemBrowser,
    fetchImpl = globalThis.fetch, clock = Date.now, testEndpoints } = {}) {
    super();
    if (!store || typeof store.assertDevice !== 'function' || typeof store.googleCredential !== 'function'
        || typeof openBrowser !== 'function' || typeof fetchImpl !== 'function' || typeof clock !== 'function') throw Error('CONTACT_GOOGLE_SETUP_INVALID');
    if (typeof clientId !== 'string' || clientId.length > 200 || typeof clientSecret !== 'string' || clientSecret.length > 4096) throw Error('CONTACT_GOOGLE_SETUP_INVALID');
    this.#store = store; this.#clientId = clientId; this.#clientSecret = clientSecret;
    this.#openBrowser = openBrowser; this.#fetch = fetchImpl; this.#clock = clock; this.#endpoints = loopbackTestEndpoints(testEndpoints);
    this.#lastDisconnect = this.#store.googleDisconnectStatus();
  }
  #endpoint(name, fixed) { return this.#endpoints?.[name] ?? fixed; }
  #configured() { return /^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/u.test(this.#clientId); }
  #apiEndpoint(name, fixedBase, path) {
    const base = this.#endpoints?.[name];
    return base ? new URL(`${base.replace(/\/$/u, '')}${path}`) : new URL(`${fixedBase}${path}`);
  }
  #changed(authorityChanged = false) { this.emit('change', { authorityChanged }); }
  #assertDevice(device) { this.#store.assertDevice(device); }
  #assertAttempt(attempt) {
    if (this.#attempt !== attempt || attempt.closed || attempt.controller.signal.aborted) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
    this.#assertDevice(attempt.device);
  }
  #epochSignal(epoch) {
    let controller = this.#epochAborts.get(epoch);
    if (!controller) { controller = new AbortController(); this.#epochAborts.set(epoch, controller); }
    return controller.signal;
  }
  #stopEpoch(epoch) {
    if (!epoch) return;
    this.#epochAborts.get(epoch)?.abort(); this.#epochAborts.delete(epoch); this.#access.delete(epoch); this.#refreshes.delete(epoch);
    this.#expiredEpoch = epoch;
  }
  captureGrant(device) {
    this.#assertDevice(device);
    const credential = this.#store.googleCredential();
    if (!credential) return null;
    let ownerLive = true;
    try { this.#assertDevice(credential.device); } catch { ownerLive = false; }
    return { epoch: credential.epoch, email: credential.email,
      connected: this.#configured() && ownerLive && !credential.reconnect_required && scopesMatch(credential.scopes) };
  }
  assertSnapshot(device, snapshot) {
    this.#assertDevice(device);
    const current = this.#store.googleCredential();
    if ((snapshot?.epoch ?? null) !== (current?.epoch ?? null)) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
    if (current) {
      if (!scopesMatch(current.scopes)) throw Error('CONTACT_GOOGLE_SCOPE_DENIED');
      if (snapshot?.connected) this.#assertDevice(current.device);
      if (snapshot?.connected && current.reconnect_required) throw Error('CONTACT_GOOGLE_RECONNECT_REQUIRED');
    }
    return current;
  }
  status() {
    const credential = this.#store.googleCredential();
    let ownerLive = false;
    if (credential) { try { this.#assertDevice(credential.device); ownerLive = true; } catch { /* expired/revoked grant is not usable */ } }
    const configured = this.#configured(), ready = this.#store.contactVersion >= 5;
    const reconnect = !!credential && (!ownerLive || credential.reconnect_required || !scopesMatch(credential.scopes));
    const pending = !!this.#attempt && !this.#attempt.completed;
    return { available: true, configured, connected: ready && configured && !!credential && ownerLive && !credential.reconnect_required && scopesMatch(credential.scopes),
      has_credential: !!credential,
      pending, state: !ready ? 'upgrade_required' : !configured ? 'not_configured' : pending ? 'connecting'
        : !credential ? 'disconnected' : reconnect ? 'reconnect_required' : 'connected',
      account: credential?.email ?? null, last_checked: credential?.last_checked ?? null,
      error: credential?.last_error ?? this.#lastError, last_disconnect: credential ? null : this.#lastDisconnect };
  }
  async connect(device, consent) {
    if (!this.#configured()) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED');
    if (consent !== 'google_readonly_v1') throw Error('CONTACT_GOOGLE_CONSENT_REQUIRED');
    this.#assertDevice(device);
    if (this.#store.contactVersion < 5) throw Error('CONTACT_ASSISTANCE_UPGRADE_REQUIRED');
    if (this.#attempt) throw Error('CONTACT_GOOGLE_BUSY');
    const previous = this.#store.googleCredential();
    const attempt = { device, previousEpoch: previous?.epoch ?? null, epoch: randomBytes(32).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'), controller: new AbortController(), server: null,
      timer: null, redirectUri: null, processing: false, closed: false, completed: false };
    const revocation = this.#revocation;
    this.#attempt = attempt;
    if (!revocation && this.#lastDisconnect?.remote_revoked !== false) this.#lastDisconnect = null;
    try {
      if (revocation) {
        // Google revokes the whole project grant, including tokens issued by a
        // concurrent authorization. Keep this queued attempt cancelable while
        // the existing bounded revoke finishes, before opening any listener.
        this.#changed();
        const result = await revocation;
        this.#assertAttempt(attempt);
        if (result.remote_revoked) this.#lastDisconnect = null;
      }
      const server = httpServer((req, res) => {
        void this.#callback(attempt, req, res).catch(() => {
          // Contain callback failures at the HTTP boundary, including storage
          // authority changing while an asynchronous exchange is finishing.
          this.#finishAttempt(attempt, attempt.closed ? null : 'temporarily_unavailable');
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
            res.end('Google 계정을 연결하지 못했어요. Tada 설정에서 다시 연결해 주세요.');
          }
        });
      });
      server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
      attempt.server = server;
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
      });
      this.#assertAttempt(attempt);
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('CONTACT_GOOGLE_CALLBACK_FAILED');
      attempt.redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
      const challenge = createHash('sha256').update(attempt.verifier).digest('base64url');
      const url = new URL(AUTHORIZATION_ENDPOINT);
      for (const [key, value] of Object.entries({ client_id: this.#clientId, redirect_uri: attempt.redirectUri,
        response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', include_granted_scopes: 'false',
        code_challenge: challenge, code_challenge_method: 'S256', state: attempt.epoch, prompt: 'consent' })) url.searchParams.set(key, value);
      const opened = await this.#openBrowser(url.href);
      this.#assertAttempt(attempt);
      if (opened !== true) throw Error('CONTACT_GOOGLE_BROWSER_FAILED');
      attempt.timer = setTimeout(() => this.#finishAttempt(attempt, 'authorization_denied'), 5 * 60 * 1000);
      attempt.timer.unref();
      this.#lastError = null; this.#changed();
      return { state: 'waiting' };
    } catch (error) {
      this.#finishAttempt(attempt, 'authorization_denied');
      if (/^CONTACT_GOOGLE_[A-Z_]+$/u.test(error?.message)) throw error;
      throw Error('CONTACT_GOOGLE_CONNECT_FAILED');
    }
  }
  #callbackPage(res, successful) {
    if (res.destroyed || res.writableEnded) return;
    const text = successful ? '이 창을 닫고 Tada로 돌아가세요.' : '이 창을 닫고 Tada 설정에서 다시 연결해 주세요.';
    res.writeHead(303, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Location: '/oauth2/complete' });
    res.end(text);
  }
  async #callback(attempt, req, res) {
    const address = attempt.server?.address();
    const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    if (req.method !== 'GET' || req.url === undefined || req.headers.host !== expectedHost || bytes(req.url) > 4096
        || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      res.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end('Not found'); return;
    }
    if (req.method === 'GET' && req.url === '/oauth2/complete') {
      const successful = attempt.completed;
      const body = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${successful ? 'Google 계정 연결 완료' : 'Tada 연결'}</title><body><main><h1>${successful ? 'Google 계정 연결 완료' : 'Google 계정 연결을 마치지 못했어요'}</h1><p>${successful ? '이 창을 닫고 Tada로 돌아가세요.' : '이 창을 닫고 Tada 설정에서 다시 연결해 주세요.'}</p></main></body></html>`;
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.end(body); return;
    }
    if (!req.url.startsWith('/oauth2/callback?')) {
      res.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end('Not found'); return;
    }
    let callback;
    try { callback = new URL(req.url, `http://${expectedHost}`); } catch {
      res.writeHead(400, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    // OAuth response extensions (scope/authuser/prompt/hd and unknown fields)
    // are ignored, never used for account identity or scope authority. Google's
    // code-model guide requires ignoring unrecognized response parameters.
    if (['state', 'code', 'error'].some(key => callback.searchParams.getAll(key).length > 1)) {
      res.writeHead(400, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    const state = callback.searchParams.get('state') ?? '';
    const receivedState = Buffer.from(state, 'utf8'), expectedState = Buffer.from(attempt.epoch, 'utf8');
    if (receivedState.length !== expectedState.length || !timingSafeEqual(receivedState, expectedState) || attempt.processing || attempt.closed) {
      res.writeHead(400, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    const code = callback.searchParams.get('code'); const providerError = callback.searchParams.get('error');
    if ((code === null) === (providerError === null) || (code !== null && (!/^[\x21-\x7e]{1,4096}$/u.test(code)))) {
      res.writeHead(400, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    attempt.processing = true; clearTimeout(attempt.timer);
    let successful = false;
    try {
      this.#assertAttempt(attempt);
      if (providerError !== null) throw Error('CONTACT_GOOGLE_AUTHORIZATION_DENIED');
      const tokens = await this.#exchangeCode(attempt, code);
      this.#assertAttempt(attempt);
      const profile = await this.#profile(attempt, tokens.access_token);
      this.#assertAttempt(attempt);
      const current = this.#store.googleCredential();
      if ((current?.epoch ?? null) !== attempt.previousEpoch) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
      const grant = { version: 1, epoch: randomUUID(), device: attempt.device,
        scopes: [...GOOGLE_SCOPES], refresh_token: tokens.refresh_token, email: profile.emailAddress,
        connected_at: this.#clock(), last_checked: this.#clock(), last_error: null, reconnect_required: false };
      this.#store.saveGoogleCredential(attempt.device, grant, attempt.previousEpoch);
      successful = true; this.#lastError = null; this.#lastDisconnect = null;
      this.#expiredEpoch = null;
      this.#stopEpoch(attempt.previousEpoch);
      this.#changed(true);
    } catch (error) {
      const code = error?.message === 'CONTACT_GOOGLE_AUTHORIZATION_DENIED' ? 'authorization_denied'
        : error?.message === 'CONTACT_GOOGLE_PERMISSION_DENIED' || error?.message === 'CONTACT_GOOGLE_SCOPE_DENIED' ? 'permission_denied'
        : error?.message === 'CONTACT_GOOGLE_AUTHORITY_CHANGED' || error?.message === 'CONTACT_DEVICE_REVOKED' ? null
        : 'temporarily_unavailable';
      // Disconnect/revoke/close may have canceled this attempt during the HTTP
      // exchange. A late callback must not update removed credentials or status.
      if (!attempt.closed && this.#attempt === attempt) {
        this.#lastError = code;
        if (code && attempt.previousEpoch && this.#store.googleCredential()?.epoch === attempt.previousEpoch) {
          this.#store.noteGoogleError(attempt.previousEpoch, code, this.#clock());
        }
        this.#changed();
      }
    } finally {
      attempt.completed = successful;
      this.#callbackPage(res, successful);
      // Give the browser time to follow the clean-URL redirect, but release the
      // listener and attempt even if that navigation never occurs.
      if (!attempt.closed) {
        attempt.timer = setTimeout(() => this.#finishAttempt(attempt, null), 1000);
        attempt.timer.unref();
      }
    }
  }
  async #exchangeCode(attempt, code) {
    this.#assertAttempt(attempt);
    const form = new URLSearchParams({ client_id: this.#clientId, code, code_verifier: attempt.verifier,
      grant_type: 'authorization_code', redirect_uri: attempt.redirectUri });
    if (this.#clientSecret) form.set('client_secret', this.#clientSecret);
    const response = await this.#fetch(this.#endpoint('token', TOKEN_ENDPOINT), { method: 'POST', redirect: 'error', signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(12000)]),
      headers: { ...jsonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    this.#assertAttempt(attempt);
    const result = await responseJson(response, MAX_TOKEN_BYTES);
    this.#assertAttempt(attempt);
    if (!response.ok) throw Error(result?.error === 'access_denied' ? 'CONTACT_GOOGLE_AUTHORIZATION_DENIED'
      : result?.error === 'invalid_scope' ? 'CONTACT_GOOGLE_PERMISSION_DENIED' : 'CONTACT_GOOGLE_TOKEN_EXCHANGE_FAILED');
    assertResponseShape(result, ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type']);
    const granted = typeof result.scope === 'string' ? result.scope.split(' ').filter(Boolean).sort() : [];
    if (!safeToken(result.access_token) || !safeToken(result.refresh_token) || result.token_type !== 'Bearer'
        || !Number.isSafeInteger(result.expires_in) || result.expires_in < 60 || result.expires_in > 86400
        || granted.join('\n') !== [...GOOGLE_SCOPES].sort().join('\n')) throw Error('CONTACT_GOOGLE_SCOPE_DENIED');
    return result;
  }
  async #profile(attempt, accessToken) {
    this.#assertAttempt(attempt);
    const response = await this.#fetch(this.#apiEndpoint('gmail', GMAIL_BASE, '/users/me/profile'), { method: 'GET', redirect: 'error', signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(10000)]),
      headers: { ...jsonHeaders, Authorization: `Bearer ${accessToken}` } });
    this.#assertAttempt(attempt);
    if (response.status === 403) throw Error('CONTACT_GOOGLE_PERMISSION_DENIED');
    const result = await responseJson(response, 65536);
    this.#assertAttempt(attempt);
    if (!response.ok || !safeAccount(result?.emailAddress)) throw Error('CONTACT_GOOGLE_PROFILE_FAILED');
    return result;
  }
  #finishAttempt(attempt, error) {
    if (attempt.closed) return;
    attempt.closed = true; clearTimeout(attempt.timer); attempt.controller.abort();
    attempt.server?.close();
    if (this.#attempt === attempt) this.#attempt = null;
    if (error && GOOGLE_STATUS_ERRORS.has(error)) this.#lastError = error;
    this.#changed();
  }
  #assertAuthority(device, epoch, signal) {
    if (signal?.aborted) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
    const grant = this.#store.assertGoogleAuthority(device, epoch);
    if (signal?.aborted) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
    return grant;
  }
  #requestFailure(error, device, epoch, callerSignal, epochSignal, timeoutSignal) {
    if (callerSignal?.aborted || epochSignal.aborted) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
    const malformed = /^CONTACT_GOOGLE_RESPONSE_(?:LIMIT|INVALID)$/u.test(error?.message);
    if (!timeoutSignal.aborted && /^CONTACT_GOOGLE_(?:AUTHORITY_CHANGED|RECONNECT_REQUIRED|SCOPE_DENIED|PERMISSION_DENIED|TEMPORARILY_UNAVAILABLE)$/u.test(error?.message)) throw error;
    // A deadline is a temporary transport failure, not a changed grant. Check
    // the current epoch before recording it so canceled work cannot mark a new
    // connection unavailable.
    const current = this.#assertAuthority(device, epoch, callerSignal);
    this.#store.noteGoogleError(epoch, 'temporarily_unavailable', malformed ? current.last_checked : this.#clock()); this.#changed();
    if (malformed && !timeoutSignal.aborted) throw error;
    throw Error('CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE');
  }
  async #refresh(device, epoch, sourceSignal) {
    const grant = this.#assertAuthority(device, epoch, sourceSignal);
    const cached = this.#access.get(epoch);
    if (cached && cached.expires_at > this.#clock() + 30000) return cached.token;
    let pending = this.#refreshes.get(epoch);
    if (!pending) {
      const epochSignal = this.#epochSignal(epoch), timeoutSignal = AbortSignal.timeout(12000);
      const signal = AbortSignal.any([sourceSignal, epochSignal, timeoutSignal]);
      pending = (async () => {
        try {
          const current = this.#assertAuthority(device, epoch, signal);
          const form = new URLSearchParams({ client_id: this.#clientId, refresh_token: current.refresh_token, grant_type: 'refresh_token' });
          if (this.#clientSecret) form.set('client_secret', this.#clientSecret);
          const response = await this.#fetch(this.#endpoint('token', TOKEN_ENDPOINT), { method: 'POST', redirect: 'error', signal,
            headers: { ...jsonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          this.#assertAuthority(device, epoch, signal);
          const result = await responseJson(response, MAX_TOKEN_BYTES);
          this.#assertAuthority(device, epoch, signal);
          if (!response.ok) {
            const error = result?.error === 'invalid_grant' ? 'CONTACT_GOOGLE_RECONNECT_REQUIRED'
              : result?.error === 'invalid_scope' ? 'CONTACT_GOOGLE_SCOPE_DENIED' : 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE';
            this.#store.noteGoogleError(epoch, error.endsWith('RECONNECT_REQUIRED') ? 'reconnect_required'
              : error.endsWith('SCOPE_DENIED') ? 'permission_denied' : 'temporarily_unavailable', this.#clock(), error.endsWith('SCOPE_DENIED'));
            this.#changed(); throw Error(error);
          }
          if (!safeToken(result?.access_token) || result.token_type !== 'Bearer'
              || !Number.isSafeInteger(result.expires_in) || result.expires_in < 60 || result.expires_in > 86400) throw Error('CONTACT_GOOGLE_RESPONSE_INVALID');
          if (result.scope !== undefined && (typeof result.scope !== 'string'
              || result.scope.split(' ').filter(Boolean).sort().join('\n') !== [...GOOGLE_SCOPES].sort().join('\n'))) {
            this.#store.noteGoogleError(epoch, 'permission_denied', this.#clock(), true);
            this.#access.delete(epoch); this.#changed(); throw Error('CONTACT_GOOGLE_SCOPE_DENIED');
          }
          if (result.refresh_token !== undefined) {
            if (!safeToken(result.refresh_token)) throw Error('CONTACT_GOOGLE_RESPONSE_INVALID');
            this.#store.rotateGoogleRefresh(epoch, current.refresh_token, result.refresh_token);
          }
          this.#store.noteGoogleCheck(epoch, this.#clock()); this.#lastError = null;
          const token = { token: result.access_token, expires_at: this.#clock() + result.expires_in * 1000 };
          this.#access.set(epoch, token); this.#changed(); return token.token;
        } catch (error) { this.#requestFailure(error, device, epoch, sourceSignal, epochSignal, timeoutSignal); }
      })().finally(() => { if (this.#refreshes.get(epoch) === pending) this.#refreshes.delete(epoch); });
      this.#refreshes.set(epoch, pending);
    }
    const token = await pending;
    this.#assertAuthority(device, epoch, sourceSignal);
    return token;
  }
  async apiJson(device, epoch, url, signal, maxBytes = MAX_JSON_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JSON_BYTES) throw Error('CONTACT_GOOGLE_RESPONSE_LIMIT');
    // The URL must be produced by this module's fixed API builders. No model
    // supplied URL is accepted at this boundary.
    if (!(url instanceof URL)) throw Error('CONTACT_GOOGLE_URL_REJECTED');
    const gmailOrigin = new URL(GMAIL_BASE).origin, calendarOrigin = new URL(CALENDAR_BASE).origin;
    const gmailRequest = url.origin === gmailOrigin && url.pathname.startsWith('/gmail/v1/');
    const calendarRequest = url.origin === calendarOrigin && url.pathname.startsWith('/calendar/v3/');
    if (!gmailRequest && !calendarRequest) throw Error('CONTACT_GOOGLE_URL_REJECTED');
    let requestUrl = url;
    if (this.#endpoints && gmailRequest) requestUrl = new URL(`${url.pathname}${url.search}`, new URL(this.#endpoints.gmail).origin);
    if (this.#endpoints && calendarRequest) requestUrl = new URL(`${url.pathname}${url.search}`, new URL(this.#endpoints.calendar).origin);
    for (let attempt = 0; attempt < 2; attempt++) {
      this.#assertAuthority(device, epoch, signal);
      const token = await this.#refresh(device, epoch, signal);
      const epochSignal = this.#epochSignal(epoch), timeoutSignal = AbortSignal.timeout(10000);
      const requestSignal = AbortSignal.any([signal, epochSignal, timeoutSignal]);
      try {
        this.#assertAuthority(device, epoch, requestSignal);
        const response = await this.#fetch(requestUrl, { method: 'GET', redirect: 'error', signal: requestSignal,
          headers: { ...jsonHeaders, Authorization: `Bearer ${token}` } });
        this.#assertAuthority(device, epoch, requestSignal);
        if (response.status === 401 && attempt === 0) { this.#access.delete(epoch); continue; }
        if (response.status === 401) {
          this.#store.noteGoogleError(epoch, 'reconnect_required', this.#clock()); this.#changed();
          throw Error('CONTACT_GOOGLE_RECONNECT_REQUIRED');
        }
        if (response.status === 403) {
          this.#store.noteGoogleError(epoch, 'permission_denied', this.#clock()); this.#changed();
          throw Error('CONTACT_GOOGLE_PERMISSION_DENIED');
        }
        if (!response.ok) {
          this.#store.noteGoogleError(epoch, 'temporarily_unavailable', this.#clock()); this.#changed();
          throw Error('CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE');
        }
        const result = await responseJson(response, maxBytes);
        this.#assertAuthority(device, epoch, requestSignal);
        this.#store.noteGoogleCheck(epoch, this.#clock()); this.#assertAuthority(device, epoch, requestSignal); this.#changed();
        return result;
      } catch (error) {
        this.#requestFailure(error, device, epoch, signal, epochSignal, timeoutSignal);
      }
    }
    throw Error('CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE');
  }
  async disconnect(device) {
    this.#assertDevice(device);
    // Remove local authority before attempting Google's best-effort revoke.
    const removed = this.#store.clearGoogleCredential(device);
    const localStatus = { local_removed: true, remote_revoked: removed?.refresh_token ? false : null };
    if (removed || (!this.#revocation && this.#lastDisconnect?.remote_revoked !== false)) this.#lastDisconnect = localStatus;
    let revocation;
    if (removed?.refresh_token) {
      // Publish the pending promise before notifying listeners: a new connect
      // triggered by the local change must wait for the old grant's revoke.
      const pending = Promise.resolve().then(async () => {
        let remoteRevoked;
        try {
          const form = new URLSearchParams({ token: removed.refresh_token });
          const response = await this.#fetch(this.#endpoint('revoke', REVOKE_ENDPOINT), { method: 'POST', redirect: 'error',
            signal: AbortSignal.timeout(3000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jsonHeaders }, body: form.toString() });
          remoteRevoked = response.status === 200;
        } catch { remoteRevoked = false; }
        const result = { local_removed: true, remote_revoked: remoteRevoked };
        // Local removal already committed an unconfirmed receipt. A closed
        // journal keeps that uncertainty; no token is retained for a retry.
        let current = false;
        try { current = this.#store.noteGoogleDisconnect(removed.epoch, remoteRevoked); }
        catch (error) { if (error?.message !== 'CONTACT_STORE_UNAVAILABLE') throw error; }
        if (current && this.#lastDisconnect === localStatus) { this.#lastDisconnect = result; this.#changed(); }
        return result;
      }).finally(() => { if (this.#revocation === pending) this.#revocation = null; });
      this.#revocation = revocation = pending;
    }
    if (this.#attempt) this.#finishAttempt(this.#attempt, 'authorization_denied');
    if (removed) this.#stopEpoch(removed.epoch);
    this.#lastError = null; this.#changed(!!removed);
    return revocation ?? localStatus;
  }
  deviceRevoked(device) {
    if (this.#attempt?.device === device) this.#finishAttempt(this.#attempt, 'authorization_denied');
    const credential = this.#store.googleCredential();
    if (credential?.device === device) {
      this.#stopEpoch(credential.epoch);
      this.#changed(true);
    }
  }
  sweepAuthority() {
    const attempt = this.#attempt;
    if (attempt) {
      try { this.#assertDevice(attempt.device); }
      catch { this.#finishAttempt(attempt, 'authorization_denied'); }
    }
    const credential = this.#store.googleCredential();
    if (credential) {
      try { this.#assertDevice(credential.device); }
      catch {
        if (this.#expiredEpoch !== credential.epoch) {
          this.#stopEpoch(credential.epoch);
          this.#changed(true);
        }
      }
    }
  }
  close() {
    if (this.#attempt) this.#finishAttempt(this.#attempt, 'authorization_denied');
    for (const controller of this.#epochAborts.values()) controller.abort();
    this.#epochAborts.clear(); this.#access.clear(); this.#refreshes.clear();
  }
}
