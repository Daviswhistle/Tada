import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { AUTH, API, authURL, jsonResponse, response } from './chatgpt-http.mjs';
const tokenEndpoint = `${AUTH}/api/accounts/oauth/token`;
const grantScope = 'chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const safeString = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\r\n]/u.test(value);
const clientId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value) && value !== 'dynamic_agent_client';
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class ChatGPTAccount {
  #store; #fetch; #refresh; #discovery; #stop = new AbortController(); #login;
  constructor(store, { fetcher = globalThis.fetch } = {}) { this.#store = store; this.#fetch = fetcher; }
  get profile() {
    const { host, client, subject, email, tokens, refresh_pending } = this.#store.read();
    return { host, client, subject, email, connected: !!tokens && !refresh_pending };
  }
  #signal(signal) { return signal ? AbortSignal.any([signal, this.#stop.signal]) : this.#stop.signal; }
  async #metadata(signal) {
    if (!this.#discovery) {
      const data = await jsonResponse(this.#fetch, `${AUTH}/.well-known/openid-configuration`, { signal });
      if (data.issuer !== AUTH) throw Error('CHATGPT_DISCOVERY_INVALID');
      this.#discovery = { jwks: authURL(data.jwks_uri), revoke: authURL(data.revocation_endpoint) };
    }
    return this.#discovery;
  }
  #tokens(raw, previous) {
    const scopes = raw.scope === undefined && previous ? previous.scopes : typeof raw.scope === 'string' ? raw.scope.split(/\s+/u) : [];
    if (!scopes.includes(grantScope)) throw Error('CHATGPT_PLAN_PERMISSION_REQUIRED');
    if (!safeString(raw.access_token) || raw.token_type?.toLowerCase() !== 'bearer'
      || !Number.isSafeInteger(raw.expires_in) || raw.expires_in <= 0 || raw.expires_in > 86400 * 365
      || !(safeString(raw.refresh_token) || (raw.refresh_token === undefined && safeString(previous?.refresh_token)))) throw Error('CHATGPT_TOKEN_INVALID');
    return { access_token: raw.access_token, refresh_token: raw.refresh_token ?? previous.refresh_token,
      id_token: raw.id_token ?? previous?.id_token, scopes, expires_at: Date.now() + raw.expires_in * 1000 };
  }
  async #identity(token, client, signal, nonce) {
    try {
      const metadata = await this.#metadata(signal);
      const keys = await jsonResponse(this.#fetch, metadata.jwks, { signal });
      const { payload } = await jwtVerify(token, createLocalJWKSet(keys), { issuer: AUTH, audience: client, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] });
      if (!safeString(payload.sub) || (nonce !== undefined && !equal(payload.nonce, nonce))) throw Error();
      return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
    } catch { throw Error('CHATGPT_IDENTITY_REJECTED'); }
  }
  async beginLogin({ signal, timeoutMs = 300000 } = {}) {
    if (this.#login) throw Error('CHATGPT_LOGIN_IN_PROGRESS');
    const attemptAbort = new AbortController();
    const combined = AbortSignal.any([this.#signal(signal), attemptAbort.signal]); combined.throwIfAborted();
    const selected = this.#store.read(), state = random(), nonce = random(), verifier = random();
    let finish, fail, timer, used = false, settled = false;
    const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // The caller may display a URL before awaiting done; never emit an unhandled rejection.
    done.catch(() => {});
    const server = createServer();
    const cancel = () => settle(Error('CHATGPT_LOGIN_CANCELLED'));
    const cleanup = () => { clearTimeout(timer); combined.removeEventListener('abort', cancel); server.close(); server.closeAllConnections(); this.#login = null; };
    const settle = (error, value) => { if (settled) return; settled = true; cleanup(); attemptAbort.abort(); if (error) fail(error); else finish(value); };
    this.#login = cancel;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
      server.on('request', async (req, res) => {
        const send = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" }); res.end(text); };
        let url;
        try { url = new URL(req.url, redirect); } catch { send(400, '잘못된 로그인 응답입니다.'); return; }
        if (req.method !== 'GET' || req.headers.host !== new URL(redirect).host || url.pathname !== '/auth/callback' || req.url.length > 16384 || used) { send(400, '잘못된 로그인 응답입니다.'); return; }
        for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) { send(400, '잘못된 로그인 응답입니다.'); return; }
        if (!equal(url.searchParams.get('state'), state)) { send(400, '로그인 요청이 일치하지 않습니다.'); return; }
        used = true;
        try {
          if (url.searchParams.has('error')) throw Error('CHATGPT_LOGIN_DENIED');
          const client = url.searchParams.get('client_id') ?? selected.client;
          const code = url.searchParams.get('code');
          if (!clientId(client) || !safeString(code) || (selected.client && client !== selected.client)) throw Error('CHATGPT_REGISTRATION_REJECTED');
          // Retain registration even if this one-use code expires. Tokens are not yet active.
          this.#store.save({ ...selected, client });
          const raw = await jsonResponse(this.#fetch, tokenEndpoint, { method: 'POST', signal: combined,
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client, code, code_verifier: verifier, redirect_uri: redirect, resource: API }) });
          const identity = await this.#identity(raw.id_token, client, combined, nonce);
          if (selected.subject && selected.subject !== identity.subject) throw Error('CHATGPT_ACCOUNT_CHANGED');
          let tokens;
          try { tokens = this.#tokens(raw); }
          catch (error) {
            if (error.message === 'CHATGPT_PLAN_PERMISSION_REQUIRED') this.#store.save({ ...selected, client, ...identity, tokens: null, needs_consent: true, refresh_pending: false });
            throw error;
          }
          combined.throwIfAborted();
          this.#store.save({ ...selected, client, ...identity, tokens, needs_consent: false, refresh_pending: false });
          send(200, 'Tada에 연결했습니다. 이 창을 닫고 Tada로 돌아가세요.');
          // Let the success response flush before closing the listener.
          res.once('finish', () => settle(null, this.profile));
        } catch (error) {
          send(400, 'Tada 로그인에 실패했습니다. Tada로 돌아가 다시 연결해 주세요.');
          res.once('finish', () => settle(Error(/^CHATGPT_[A-Z_]+$/u.test(error?.message) ? error.message : 'CHATGPT_LOGIN_FAILED')));
        }
      });
      const url = new URL(`${AUTH}/api/accounts/authorize`);
      const params = { client_id: selected.client ?? 'dynamic_agent_client', ext_agent_host_id: selected.host,
        response_type: 'code', redirect_uri: redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: API,
        state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
      if (!selected.client) params.agent_name_hint = 'Tada';
      if (selected.needs_consent) params.prompt = 'consent';
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      combined.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => settle(Error('CHATGPT_LOGIN_TIMEOUT')), timeoutMs);
      if (combined.aborted) cancel();
      return { url: url.href, done, cancel };
    } catch { cleanup(); throw Error('CHATGPT_LOGIN_START_FAILED'); }
  }
  async accessToken(signal) {
    const combined = this.#signal(signal); combined.throwIfAborted();
    const profile = this.#store.read();
    if (profile.refresh_pending && !this.#refresh) throw Error('CHATGPT_REFRESH_UNCERTAIN');
    if (!profile.tokens || !profile.subject) throw Error('CHATGPT_SIGN_IN_REQUIRED');
    if (profile.tokens.expires_at > Date.now() + 60000) return profile.tokens.access_token;
    if (!this.#refresh) this.#refresh = this.#renew(profile, AbortSignal.timeout(20000)).finally(() => { this.#refresh = null; });
    // Cancellation stops this caller, not an already-applied rotating grant.
    // Keep the bounded refresh owned until credentials are saved atomically.
    await new Promise((resolve, reject) => {
      const cancel = () => reject(Error('ASSISTANT_CANCELLED'));
      combined.addEventListener('abort', cancel, { once: true });
      this.#refresh.then(() => { combined.removeEventListener('abort', cancel); resolve(); }, error => { combined.removeEventListener('abort', cancel); reject(error); });
      if (combined.aborted) cancel();
    });
    combined.throwIfAborted();
    return this.#store.read().tokens.access_token;
  }
  async #renew(profile, signal) {
    // A crash or ambiguous transport must not replay a possibly rotated token.
    // Preserve credentials for explicit recovery/revocation, but stop their use.
    this.#store.save({ ...profile, refresh_pending: true });
    const raw = await jsonResponse(this.#fetch, tokenEndpoint, { method: 'POST', signal,
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.client, refresh_token: profile.tokens.refresh_token, resource: API }) }).catch(error => {
        if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) {
          this.#store.save({ ...profile, tokens: null, refresh_pending: false }); throw Error('CHATGPT_SIGN_IN_REQUIRED');
        }
        throw Error('CHATGPT_REFRESH_UNCERTAIN');
      });
    if (raw.id_token !== undefined) {
      const identity = await this.#identity(raw.id_token, profile.client, signal);
      if (identity.subject !== profile.subject) throw Error('CHATGPT_ACCOUNT_CHANGED');
    }
    let tokens;
    try { tokens = this.#tokens(raw, profile.tokens); }
    catch (error) {
      if (error.message === 'CHATGPT_PLAN_PERMISSION_REQUIRED') this.#store.save({ ...profile, tokens: null, needs_consent: true, refresh_pending: false });
      throw error;
    }
    signal.throwIfAborted();
    this.#store.save({ ...profile, tokens, refresh_pending: false });
  }
  async models(signal) {
    const combined = this.#signal(signal), token = await this.accessToken(combined);
    const raw = await jsonResponse(this.#fetch, `${API}/models`, { signal: combined, headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(raw.models)) throw Error('CHATGPT_CATALOG_INVALID');
    const models = raw.models.filter(item => item.visibility === 'list');
    if (!models.length || models.length > 200 || models.some(item => typeof item.slug !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(item.slug)
      || typeof item.display_name !== 'string' || item.display_name.length > 200 || /[\x00-\x1f\x7f]/u.test(item.display_name))) throw Error('CHATGPT_CATALOG_INVALID');
    return models.map(({ slug, display_name }) => ({ slug, display_name }));
  }
  async logout() {
    await this.stop();
    const profile = this.#store.read(); let revoked = !profile.tokens;
    try {
      if (profile.tokens) {
        const signal = AbortSignal.timeout(15000), metadata = await this.#metadata(signal);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await response(this.#fetch, metadata.revoke, { method: 'POST', signal,
              body: new URLSearchParams({ token: profile.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: profile.client }) });
            revoked = res.status === 200; await res.body?.cancel(); break;
          } catch (error) {
            if (signal.aborted || attempt === 2 || !(error.status >= 500 || error.message === 'CHATGPT_NETWORK_FAILED')) throw error;
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
      }
    } catch { /* Always clear locally; caller must disclose unconfirmed revocation. */ }
    this.#store.save({ ...profile, tokens: null, refresh_pending: false }); return { revoked };
  }
  stop() { this.#stop.abort(); this.#login?.(); return this.#refresh?.catch(() => {}) ?? Promise.resolve(); }
}
