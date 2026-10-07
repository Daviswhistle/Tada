import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, chmodSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { ChatGPTStore } from '../src/chatgpt-store.mjs';
import { ChatGPTAccount } from '../src/chatgpt-account.mjs';
const passphrase = 'synthetic account fixture passphrase';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tada-auth-test-')), directory = join(root, 'profile');
  const store = new ChatGPTStore({ directory, passphrase });
  const calls = []; let nonce, mode = 'ok', tokenCalls = 0, releaseToken;
  const tokenGate = new Promise(resolve => { releaseToken = resolve; });
  const fetcher = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.redirect, 'error');
    if (url.endsWith('/openid-configuration')) return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/keys', revocation_endpoint: 'https://auth.openai.com/revoke' });
    if (url.endsWith('/keys')) return json({ keys: [jwk] });
    if (url.endsWith('/revoke')) { if (mode === 'network') throw Error('synthetic private diagnostic'); return new Response(null, { status: 200 }); }
    if (url.endsWith('/models')) return json({ models: [{ slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list' }, ...(mode === 'second-model' ? [{ slug: 'alternative-model', display_name: 'Alternative', visibility: 'list' }] : [])] });
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
    tokenCalls++;
    if (mode === 'delay') await tokenGate;
    const data = options.body;
    assert.equal(data.get('resource'), 'https://api.openai.com/v1'); assert.equal(data.get('client_id'), 'oaiapp_fixture');
    if (mode === 'exchange') return new Response(null, { status: 400 });
    if (mode === 'lost-refresh' && data.get('grant_type') === 'refresh_token') throw Error('lost response after simulated rotation');
    if (mode === 'server-refresh' && data.get('grant_type') === 'refresh_token') return new Response(JSON.stringify({ error: 'server_error' }), { status: 500 });
    if (mode === 'invalid-refresh' && data.get('grant_type') === 'refresh_token') return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private fixture diagnostic' }), { status: 400 });
    if (data.get('grant_type') === 'refresh_token') {
      assert.equal(data.has('scope'), false);
      return json({ access_token: 'fake-refreshed-access', refresh_token: 'fake-rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    const token = await new SignJWT({ nonce: mode === 'nonce' ? 'wrong' : nonce, email: 'fixture@example.invalid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(mode === 'issuer' ? 'https://attacker.invalid' : 'https://auth.openai.com')
      .setAudience(mode === 'audience' ? 'wrong' : 'oaiapp_fixture').setSubject(mode === 'subject' ? 'other-subject' : 'fixture-subject')
      .setIssuedAt().setExpirationTime(mode === 'expired' ? '0s' : '5m').sign(privateKey);
    return json({ access_token: 'fake-access-not-a-secret', refresh_token: 'fake-refresh-not-a-secret', id_token: mode === 'signature' ? token.slice(0, -10) + 'xxxxxxxxxx' : token,
      token_type: 'Bearer', expires_in: 3600, scope: mode === 'scope' ? 'openid' : 'openid chatgpt.tokens.use.direct' });
  };
  const account = new ChatGPTAccount(store, { fetcher });
  async function begin(options) {
    const attempt = await account.beginLogin(options); const auth = new URL(attempt.url); nonce = auth.searchParams.get('nonce');
    assert.equal(auth.origin, 'https://auth.openai.com'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('client_id', 'oaiapp_fixture');
    return { ...attempt, auth, callback };
  }
  return { root, directory, store, account, calls, begin, fetcher, releaseToken, setNonce(value) { nonce = value; }, set mode(v) { mode = v; }, get tokenCalls() { return tokenCalls; }, close() { account.stop(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function login(env) { const a = await env.begin(); assert.equal((await fetch(a.callback)).status, 200); await a.done; return a; }

test('official login creates a protected profile, reuses registration and resumes after encrypted restart', async () => {
  const env = setup();
  try {
    const first = await login(env), profile = env.account.profile;
    assert.equal(first.auth.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(first.auth.searchParams.get('agent_name_hint'), 'Tada');
    const exchange = env.calls.find(call => call.url.endsWith('/oauth/token')).options.body;
    assert.equal(first.auth.searchParams.get('code_challenge'), createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'));
    assert.equal(exchange.get('redirect_uri'), first.auth.searchParams.get('redirect_uri'));
    assert.equal(profile.subject, 'fixture-subject');
    assert.equal(readFileSync(join(env.directory, 'account.sqlite')).includes(Buffer.from('fake-access-not-a-secret')), false);
    const second = await env.begin();
    assert.equal(second.auth.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(second.auth.searchParams.has('agent_name_hint'), false);
    assert.notEqual(first.auth.searchParams.get('state'), second.auth.searchParams.get('state'));
    assert.equal(first.auth.searchParams.get('ext_agent_host_id'), second.auth.searchParams.get('ext_agent_host_id'));
    second.callback.searchParams.delete('client_id'); await fetch(second.callback); await second.done;
    assert.deepEqual(await env.account.models(), [{ slug: 'fixture-model', display_name: 'Fixture Model' }]);
    env.account.stop(); env.store.close();
    const reopened = new ChatGPTStore({ directory: env.directory, passphrase });
    assert.equal(reopened.read().tokens.access_token, 'fake-access-not-a-secret'); reopened.close();
    assert.throws(() => new ChatGPTStore({ directory: env.directory, passphrase: 'wrong long fixture passphrase' }), /UNLOCK_FAILED/);
  } finally { env.close(); }
});

test('callback state, duplicates, denial and returning client mismatch never exchange tokens', async () => {
  const env = setup();
  try {
    const a = await env.begin(), wrong = new URL(a.callback); wrong.searchParams.set('state', 'wrong');
    assert.equal((await fetch(wrong)).status, 400); assert.equal(env.tokenCalls, 0);
    const duplicate = new URL(a.callback); duplicate.searchParams.append('state', duplicate.searchParams.get('state'));
    assert.equal((await fetch(duplicate)).status, 400); assert.equal(env.tokenCalls, 0);
    a.callback.searchParams.set('error', 'access_denied'); await fetch(a.callback); await assert.rejects(a.done, /LOGIN_DENIED/);
    assert.equal(env.tokenCalls, 0);
    await login(env); const b = await env.begin(); b.callback.searchParams.set('client_id', 'oaiapp_other');
    await fetch(b.callback); await assert.rejects(b.done, /REGISTRATION_REJECTED/); assert.equal(env.tokenCalls, 1);
  } finally { env.close(); }
});

for (const mode of ['nonce', 'issuer', 'audience', 'expired', 'signature', 'scope', 'subject']) test(`rejects ${mode} without replacing the active account`, async () => {
  const env = setup();
  try {
    await login(env); const before = env.store.read(); env.mode = mode;
    const a = await env.begin(); await fetch(a.callback); await assert.rejects(a.done, /IDENTITY_REJECTED|PLAN_PERMISSION_REQUIRED|ACCOUNT_CHANGED/);
    if (mode === 'scope') { assert.equal(env.store.read().tokens, null); assert.equal(env.store.read().subject, before.subject); assert.equal(env.store.read().needs_consent, true); }
    else assert.deepEqual(env.store.read(), before);
  } finally { env.close(); }
});

test('failed initial exchange retains issued registration and timeout closes pending login', async () => {
  const env = setup();
  try {
    env.mode = 'exchange'; const a = await env.begin(); await fetch(a.callback); await assert.rejects(a.done, /REQUEST_REJECTED/);
    assert.equal(env.store.read().client, 'oaiapp_fixture'); assert.equal(env.store.read().tokens, null);
    const b = await env.account.beginLogin({ timeoutMs: 10 }); await assert.rejects(b.done, /LOGIN_TIMEOUT/);
    await assert.rejects(fetch(new URL(b.url).searchParams.get('redirect_uri')));
  } finally { env.close(); }
});

test('profile locks exclude another host and refresh rotation is serialized', async () => {
  const env = setup();
  try {
    assert.throws(() => new ChatGPTStore({ directory: env.directory, passphrase }), /PROFILE_IN_USE/);
    await login(env); const profile = env.store.read(); profile.tokens.expires_at = 0; env.store.save(profile);
    assert.deepEqual(await Promise.all([env.account.accessToken(), env.account.accessToken()]), ['fake-refreshed-access', 'fake-refreshed-access']);
    assert.equal(env.tokenCalls, 2); assert.equal(env.store.read().tokens.refresh_token, 'fake-rotated-refresh');
    const client = env.store.read().client;
    assert.deepEqual(await env.account.logout(), { revoked: true }); assert.equal(env.store.read().tokens, null); assert.equal(env.store.read().client, client);
  } finally { env.close(); }
});

test('unconfirmed revocation still clears local credentials and never claims remote success', async () => {
  const env = setup();
  try { await login(env); env.mode = 'network'; assert.deepEqual(await env.account.logout(), { revoked: false }); assert.equal(env.store.read().tokens, null); }
  finally { env.close(); }
});

test('profile rejects shared permissions and hard-linked credential files', () => {
  const env = setup();
  try {
    env.store.close();
    if (process.platform !== 'win32') { chmodSync(env.directory, 0o755); assert.throws(() => new ChatGPTStore({ directory: env.directory, passphrase }), /PRIVATE_PROFILE_REQUIRED/); chmodSync(env.directory, 0o700); }
    linkSync(join(env.directory, 'account.sqlite'), join(env.root, 'linked'));
    assert.throws(() => new ChatGPTStore({ directory: env.directory, passphrase }), /PRIVATE_PROFILE_REQUIRED/);
  } finally { env.close(); }
});


test('actual default CLI signs in, opens the shared host, restarts without login and logs out', async () => {
  const env = setup();
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const result = await env.fetcher(new URL(req.url, 'http://fixture').searchParams.get('target'), {
        redirect: 'error', body: new URLSearchParams(raw), headers: req.headers,
      });
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text());
    } catch { res.writeHead(500); res.end('{}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  try {
    const directory = join(env.root, 'contact');
    for (const mode of ['init', 'wrong-model', 'resume', 'logout']) {
      const available = createServer(); available.listen(0, '127.0.0.1'); await once(available, 'listening');
      const port = available.address().port; await new Promise(resolve => available.close(resolve));
      if (mode === 'wrong-model') env.mode = 'second-model';
      const questions = mode === 'init' ? ['YES'] : [];
      const args = ['--data', mode === 'init' ? directory + '/' : directory, '--port', String(port), ...(mode === 'init' ? ['--model', 'fixture-model'] : mode === 'wrong-model' ? ['--model', 'alternative-model'] : []), ...(mode === 'init' ? ['--init'] : mode === 'logout' ? ['--logout'] : [])];
      const source = `
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        import {EventEmitter} from 'node:events';
        const require=createRequire(import.meta.url), questions=${JSON.stringify(questions)};
        require('node:readline/promises').createInterface=()=>Object.assign(new EventEmitter(), {
          question:async()=>{if(!questions.length)throw Error('EXTRA_QUESTION');return questions.shift()},
          close(){this.emit('close')}, async *[Symbol.asyncIterator](){yield '/quit'}
        });
        syncBuiltinESMExports();
        Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});
        const nativeFetch=globalThis.fetch;
        globalThis.fetch=(url, options)=> {
          if(!String(url).startsWith('https://auth.openai.com/') && !String(url).startsWith('https://api.openai.com/'))throw Error('FIXTURE_DESTINATION');
          return nativeFetch('http://127.0.0.1:${upstream.address().port}/?target='+encodeURIComponent(url),options);
        };
        const {main}=await import(${JSON.stringify(new URL('../../engine/src/contact-cli.mjs', import.meta.url).href)});
        await main(${JSON.stringify(args)}, {keyProvider:async()=>${JSON.stringify(passphrase)}});
        if(questions.length)throw Error('SETUP_NOT_CONSUMED'); console.log('CLI_FIXTURE_COMPLETE');
      `;
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', callbackStarted = false;
      child.stdout.on('data', bytes => {
        stdout += bytes;
        const found = stdout.match(/https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?[^\s]+/u);
        if (!found || callbackStarted) return;
        callbackStarted = true;
        const auth = new URL(found[0]); env.setNonce(auth.searchParams.get('nonce'));
        const callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('client_id', 'oaiapp_fixture');
        fetch(callback).catch(() => child.kill('SIGTERM'));
      });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      const [exit] = await once(child, 'exit'); clearTimeout(timer);
      if (mode === 'wrong-model') { assert.equal(exit, 1); assert.ok(stderr.includes('CONTACT_ROUTE_CHANGED')); continue; }
      assert.equal(exit, 0, stderr); assert.ok(stdout.includes('CLI_FIXTURE_COMPLETE'));
      assert.ok(!stdout.includes('암호 (')); assert.ok(stdout.includes('별도 Tada 암호는 필요하지 않습니다'));
      if (mode !== 'logout') assert.ok(stdout.includes('Tada 연락 호스트가 열렸습니다'));
      assert.equal(callbackStarted, mode === 'init');
    }
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); env.close(); }
});


test('a timed-out login cannot activate tokens from a late exchange', async () => {
  const env = setup();
  try {
    env.mode = 'delay'; const attempt = await env.begin({ timeoutMs: 80 });
    const callback = fetch(attempt.callback).catch(() => null);
    await assert.rejects(attempt.done, /LOGIN_TIMEOUT/);
    assert.equal(env.tokenCalls, 1); assert.equal(env.store.read().tokens, null);
    env.releaseToken(); await callback;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(env.store.read().tokens, null);
  } finally { env.releaseToken(); env.close(); }
});


test('plan permission can be enabled after decline without forcing consent on ordinary sign-in', async () => {
  const env = setup();
  try {
    env.mode = 'scope'; const first = await env.begin(); await fetch(first.callback); await assert.rejects(first.done, /PLAN_PERMISSION_REQUIRED/);
    assert.equal(env.account.profile.subject, 'fixture-subject'); assert.equal(env.account.profile.connected, false);
    env.mode = 'ok'; const retry = await login(env);
    assert.equal(retry.auth.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.equal(retry.auth.searchParams.get('prompt'), 'consent');
    assert.ok(retry.auth.searchParams.get('scope').split(' ').includes('chatgpt.tokens.use.direct'));
    assert.equal((await login(env)).auth.searchParams.has('prompt'), false);
  } finally { env.close(); }
});

test('cancelling one caller preserves a rotating refresh and the next request uses it', async () => {
  const env = setup();
  try {
    await login(env); const profile = env.store.read(); profile.tokens.expires_at = 0; env.store.save(profile);
    env.mode = 'delay'; const abort = new AbortController(), pending = env.account.accessToken(abort.signal);
    for (let n = 0; n < 100 && env.tokenCalls < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(env.tokenCalls, 2); abort.abort(); await assert.rejects(pending, /ASSISTANT_CANCELLED/);
    env.releaseToken();
    assert.equal(await env.account.accessToken(), 'fake-refreshed-access');
    assert.equal(env.tokenCalls, 2); assert.equal(env.store.read().tokens.refresh_token, 'fake-rotated-refresh');
    await env.account.logout();
    assert.equal(env.calls.find(call => call.url.endsWith('/revoke')).options.body.get('token'), 'fake-rotated-refresh');
  } finally { env.releaseToken(); await env.account.stop(); env.close(); }
});

test('a confirmed unusable refresh is cleared without replaying it or discarding registration', async () => {
  const env = setup();
  try {
    await login(env); const profile = env.store.read(); profile.tokens.expires_at = 0; env.store.save(profile); env.mode = 'invalid-refresh';
    await assert.rejects(env.account.accessToken(), /SIGN_IN_REQUIRED/);
    assert.equal(env.store.read().tokens, null); assert.equal(env.store.read().client, 'oaiapp_fixture');
    await assert.rejects(env.account.accessToken(), /SIGN_IN_REQUIRED/); assert.equal(env.tokenCalls, 2);
  } finally { env.close(); }
});


for (const mode of ['lost-refresh', 'server-refresh']) test(`${mode} remains marked across restart without token replay and recovers through login`, async () => {
  const env = setup(); let reopened, account;
  try {
    await login(env); const profile = env.store.read(); profile.tokens.expires_at = 0; env.store.save(profile); env.mode = mode;
    await assert.rejects(env.account.accessToken(), /REFRESH_UNCERTAIN/);
    assert.equal(env.store.read().refresh_pending, true); assert.ok(env.store.read().tokens);
    await assert.rejects(env.account.accessToken(), /REFRESH_UNCERTAIN/); assert.equal(env.tokenCalls, 2);
    await env.account.stop(); env.store.close();
    reopened = new ChatGPTStore({ directory: env.directory, passphrase }); account = new ChatGPTAccount(reopened, { fetcher: env.fetcher });
    assert.equal(account.profile.connected, false);
    await assert.rejects(account.accessToken(), /REFRESH_UNCERTAIN/); assert.equal(env.tokenCalls, 2);
    env.mode = 'ok'; const attempt = await account.beginLogin(), auth = new URL(attempt.url);
    env.setNonce(auth.searchParams.get('nonce'));
    assert.equal(auth.searchParams.get('client_id'), 'oaiapp_fixture');
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic-recovery-code');
    assert.equal((await fetch(callback)).status, 200); await attempt.done;
    assert.equal(account.profile.connected, true); assert.equal(reopened.read().refresh_pending, false);
    assert.equal(await account.accessToken(), 'fake-access-not-a-secret'); assert.equal(env.tokenCalls, 3);
  } finally { await account?.stop(); reopened?.close(); env.close(); }
});
