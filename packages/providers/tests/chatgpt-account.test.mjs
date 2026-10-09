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


for (const browser of [false, true]) test(`actual ${browser ? 'browser setup' : 'default CLI'} signs in, opens the shared host and resumes`, async () => {
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
    for (const mode of (browser ? ['init', 'resume'] : ['init', 'wrong-model', 'resume', 'logout'])) {
      const available = createServer(); available.listen(0, '127.0.0.1'); await once(available, 'listening');
      const port = available.address().port; await new Promise(resolve => available.close(resolve));
      if (mode === 'wrong-model') env.mode = 'second-model';
      const questions = mode === 'init' ? ['YES'] : [];
      const args = ['--data', mode === 'init' ? directory + '/' : directory, '--port', String(port), ...(mode === 'init' && !browser ? ['--model', 'fixture-model'] : mode === 'wrong-model' ? ['--model', 'alternative-model'] : []), ...(mode === 'init' ? ['--init'] : mode === 'logout' ? ['--logout'] : [])];
      const source = `
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        import {EventEmitter} from 'node:events';
        const require=createRequire(import.meta.url), questions=${JSON.stringify(questions)};
        require('node:readline/promises').createInterface=()=>Object.assign(new EventEmitter(), {
          question:async()=>{if(!questions.length)throw Error('EXTRA_QUESTION');return questions.shift()},
          close(){this.emit('close')}, async *[Symbol.asyncIterator](){yield '/quit'}
        });
        syncBuiltinESMExports();
        Object.defineProperty(process.stdin,'isTTY',{value:${!browser}});Object.defineProperty(process.stdout,'isTTY',{value:${!browser}});
        const nativeFetch=globalThis.fetch;
        globalThis.fetch=(url, options)=> {
          if(!String(url).startsWith('https://auth.openai.com/') && !String(url).startsWith('https://api.openai.com/'))throw Error('FIXTURE_DESTINATION');
          return nativeFetch('http://127.0.0.1:${upstream.address().port}/?target='+encodeURIComponent(url),options);
        };
        const {main}=await import(${JSON.stringify(new URL('../../engine/src/contact-cli.mjs', import.meta.url).href)});
        const ui=${browser} ? {
          signal:new AbortController().signal,
          consent:async()=>{if(questions.shift()!=='YES')throw Error('EXTRA_CONSENT');return true},
          login:url=>console.log(url),
          selectModel:async models=>{if(models[0].name!=='Fixture Model')throw Error('MODEL_CATALOG');return '1'},
          ready:entry=>{const url=typeof entry==='function'?entry():entry;if(!url.includes('#pair=')||!url.endsWith('&auto=1'))throw Error('MISSING_CONVERSATION');console.log('BROWSER_READY')},
          wait:async()=>{}, fail:()=>{throw Error('SERVICE_FAULT')}
        } : undefined;
        await main(${JSON.stringify(args)}, {keyProvider:async()=>${JSON.stringify(passphrase)},ui});
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
      if (mode !== 'logout') assert.ok(stdout.includes(browser ? 'BROWSER_READY' : 'Tada 연락 호스트가 열렸습니다'));
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

// These exercise the same runtime used by npm start, with owned HTTP/SQLite
// and synthetic OAuth. No live account or external model is invoked.
async function browserSetup(run, nativeFetch) {
  const { serveSetup } = await import('../../engine/src/app-setup.mjs');
  const host = await serveSetup({ run });
  const url = new URL(host.url), token = new URLSearchParams(url.hash.slice(1)).get('setup');
  const state = () => nativeFetch(url.origin + '/state', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
  const until = async stage => {
    for (let n = 0; n < 200; n++) { const value = await state(); if (value.stage === stage) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('SETUP_STAGE_TIMEOUT:' + stage);
  };
  const action = (view, action, value = null) => nativeFetch(url.origin + '/action', { method: 'POST',
    headers: { Origin: url.origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: view.revision, action, value }) });
  return { host, state, until, action };
}

test('cancelling setup after OAuth while models load never dispatches an existing queued request', async () => {
  const { ContactStore, contactRoute } = await import('../../engine/src/contact-store.mjs');
  const { main } = await import('../../engine/src/contact-cli.mjs');
  const { randomUUID } = await import('node:crypto');
  const env = setup(), nativeFetch = globalThis.fetch;
  let browser, release, reached, modelRequests = 0, inference = 0, requestSignal;
  const gate = new Promise(resolve => { release = resolve; });
  const modelReached = new Promise(resolve => { reached = resolve; });
  try {
    await login(env); const profile = env.store.read(); env.store.save({ ...profile, model: 'fixture-model' });
    await env.account.stop(); env.store.close();
    const data = join(env.root, 'contact');
    const route = contactRoute({ version: 1, provider: 'chatgpt-subscription', model: 'fixture-model',
      digest: createHash('sha256').update('oaiapp_fixture:fixture-subject:fixture-model').digest('hex'), endpoint: 'https://api.openai.com/v1', scopes: [] });
    const journal = new ContactStore({ directory: data, passphrase, route, initialize: true, followups: true, reviews: true });
    const device = journal.addDevice('Fixture'); journal.submit(device.id, randomUUID(), 'Queued before the cancelled setup'); journal.close();
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/models') && ++modelRequests === 1) { requestSignal = options.signal; reached(); await gate; }
      if (String(url).endsWith('/responses')) { inference++; throw Error('INFERENCE_AFTER_CANCEL'); }
      return env.fetcher(url, options);
    };
    browser = await browserSetup(ui => main(['--data', data, '--chatgpt-profile', env.directory, '--login'], { ui, keyProvider: async () => passphrase }), nativeFetch);
    await browser.action(await browser.until('consent'), 'answer', true);
    const view = await browser.until('login'), auth = new URL(view.url); env.setNonce(auth.searchParams.get('nonce'));
    const callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic-code');
    assert.equal((await nativeFetch(callback)).status, 200);
    await modelReached;
    assert.equal((await browser.action(await browser.state(), 'cancel')).status, 200);
    assert.equal(requestSignal.aborted, true); release(); await browser.until('error');
    assert.equal(inference, 0);
    const reopened = new ContactStore({ directory: data, passphrase, route });
    assert.equal(reopened.usage().requests, 0); assert.equal(reopened.turn(1).state, 'queued'); reopened.close();
  } finally { release(); await browser?.host.close(); globalThis.fetch = nativeFetch; env.close(); }
});

test('a saved token rejected by the server recovers through explicit browser login on retry', async () => {
  const { main } = await import('../../engine/src/contact-cli.mjs');
  const env = setup(), nativeFetch = globalThis.fetch; let browser, catalogs = 0;
  try {
    await login(env); const client = env.store.read().client; await env.account.stop(); env.store.close();
    globalThis.fetch = async url => {
      assert.equal(String(url), 'https://api.openai.com/v1/models'); catalogs++;
      return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    };
    browser = await browserSetup(ui => main(['--data', join(env.root, 'contact'), '--init', '--chatgpt-profile', env.directory], { ui, keyProvider: async () => passphrase }), nativeFetch);
    const error = await browser.until('error'); assert.equal(error.reauthorize, true);
    await browser.action(error, 'retry');
    await browser.action(await browser.until('consent'), 'answer', true);
    const view = await browser.until('login');
    assert.equal(new URL(view.url).searchParams.get('client_id'), client);
    assert.equal(catalogs, 1, 'retry must reach login instead of replaying the rejected catalog request');
  } finally { await browser?.host.close(); globalThis.fetch = nativeFetch; env.close(); }
});

for (const version of [2, 3, 4, 5]) test(`browser recovery upgrades v${version} only after explicit backup consent and keeps the same history`, async () => {
  const { ContactStore, contactRoute } = await import('../../engine/src/contact-store.mjs');
  const { main } = await import('../../engine/src/contact-cli.mjs');
  const { randomUUID } = await import('node:crypto');
  const { readdirSync } = await import('node:fs');
  const env = setup(), nativeFetch = globalThis.fetch; let browser, journal;
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  try {
    await login(env); env.store.save({ ...env.store.read(), model: 'fixture-model' }); await env.account.stop(); env.store.close();
    const data = join(env.root, 'contact');
    const route = contactRoute({ version: 1, provider: 'chatgpt-subscription', model: 'fixture-model',
      digest: createHash('sha256').update('oaiapp_fixture:fixture-subject:fixture-model').digest('hex'), endpoint: 'https://api.openai.com/v1', scopes: [] });
    journal = new ContactStore({ directory: data, passphrase, route, initialize: true, followups: version >= 3, reviews: version >= 4, assistance: version >= 5 });
    const id = journal.id, device = journal.addDevice('Fixture');
    const accepted = journal.submit(device.id, randomUUID(), 'Keep my original history'); journal.cancel(accepted.seq); journal.close();
    globalThis.fetch = env.fetcher;
    browser = await browserSetup(ui => main(['--data', data, '--chatgpt-profile', env.directory, '--port', String(port)], { ui, keyProvider: async () => passphrase }), nativeFetch);
    const failed = await browser.until('error'); assert.equal(failed.upgrade, true); assert.equal(failed.retryable, false);
    assert.match(failed.message, /원본을 백업/u);
    assert.equal((await browser.action(failed, 'retry')).status, 409);
    assert.equal((await browser.action(failed, 'upgrade', false)).status, 409);
    journal = new ContactStore({ directory: data, passphrase, route }); assert.equal(journal.contactVersion, version); journal.close();
    assert.equal(readdirSync(data).filter(name => name.startsWith('before-')).length, 0);
    assert.equal((await browser.action(failed, 'upgrade', true)).status, 200);
    await browser.until('ready'); await browser.host.close();
    journal = new ContactStore({ directory: data, passphrase, route });
    assert.equal(journal.contactVersion, 6); assert.equal(journal.id, id);
    assert.equal(journal.turn(accepted.seq).text, 'Keep my original history');
    assert.equal(journal.turn(accepted.seq).state, 'cancelled');
    assert.equal(readdirSync(data).filter(name => name.startsWith('before-')).length, 6 - version);
    assert.equal(journal.usage().requests, 0);
  } finally { journal?.close(); await browser?.host.close(); globalThis.fetch = nativeFetch; env.close(); }
});

for (const bytes of [614000, 2 * 1024 * 1024 + 1]) test(`account catalog has a separate bounded metadata budget: ${bytes}`, async () => {
  const env = setup();
  try {
    await login(env);
    const account = new ChatGPTAccount(env.store, { fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(options.redirect, 'error');
      return json({ models: [{ slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list', metadata: 'x'.repeat(bytes) }] });
    } });
    if (bytes > 2 * 1024 * 1024) await assert.rejects(account.models(), /CHATGPT_RESPONSE_LIMIT/);
    else assert.deepEqual(await account.models(), [{ slug: 'fixture-model', display_name: 'Fixture Model' }]);
    await account.stop();
  } finally { env.close(); }
});
test('catalog allowance does not increase the default authentication JSON response limit', async () => {
  const { jsonResponse } = await import('../src/chatgpt-http.mjs');
  await assert.rejects(jsonResponse(async () => json({ metadata: 'x'.repeat(300000) }), 'https://auth.openai.com/fixture', {}), /CHATGPT_RESPONSE_LIMIT/);
});
