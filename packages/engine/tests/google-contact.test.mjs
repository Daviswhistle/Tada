import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { serveContact } from '../src/contact-http.mjs';
import { GoogleConnection } from '../src/google-connection.mjs';
import { GoogleSources } from '../src/google-sources.mjs';
import { GOOGLE_SCOPES, validGoogleCredential, validGoogleDisconnect } from '../src/google-contract.mjs';
import { ConversationAssistant } from '../src/conversation.ts';
import { NativeSources, discoveryTools, validCall } from '../src/native-sources.mjs';
import { ChatGPTSubscription } from '../../providers/src/chatgpt-subscription.mjs';

const password = 'fixture-only-google-contact-secret';
const route = contactRoute({ fixture: 'google-contact' });
const clientId = '123456789012-test.apps.googleusercontent.com';
const clientSecret = 'test-only-client-secret-not-a-real-secret';
const accessToken = 'ACCESS_TOKEN_SYNTHETIC_TEST_ONLY_123456789';
const refreshToken = 'REFRESH_TOKEN_SYNTHETIC_TEST_ONLY_123456789';
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const reply = (content, toolCalls = undefined) => ({ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, input_tokens: 7, output_tokens: 5 });
const callTool = (name, args = {}) => ({ function: { name, arguments: args } });
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

// Literal v1 identity contract for owned, empty legacy fixtures only.
const LEGACY_V1_SCHEMA = `
CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, salt BLOB NOT NULL, proof TEXT NOT NULL, route TEXT NOT NULL, schema_hash TEXT NOT NULL) STRICT;
CREATE TABLE devices(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
CREATE TABLE turns(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, device TEXT NOT NULL REFERENCES devices(id), state TEXT NOT NULL CHECK(state IN('queued','running','answered','failed','cancelled','interrupted')), payload TEXT NOT NULL, answer TEXT, error TEXT, created INTEGER NOT NULL) STRICT;
CREATE TABLE requests(seq INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL REFERENCES turns(seq), state TEXT NOT NULL CHECK(state IN('reserved','observed','unknown')), input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0)) STRICT;
CREATE TABLE context(singleton INTEGER PRIMARY KEY CHECK(singleton=1), through_seq INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
PRAGMA user_version=1;
`;
function environment(version = 5) {
  const root = mkdtempSync(join(tmpdir(), 'tada-google-contact-'));
  const directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase: password, route, initialize: true,
    assistance: version >= 5, reviews: version >= 4, followups: version >= 3 });
  if (version === 1) {
    store.close();
    const db = new DatabaseSync(join(directory, 'contact.sqlite'));
    try {
      db.exec('DROP TABLE telegram_controls; DROP TABLE telegram_outbox; DROP TABLE telegram_binding; DROP TABLE telegram_config; PRAGMA user_version=1;');
      db.prepare('UPDATE identity SET schema_hash=? WHERE singleton=1').run(createHash('sha256').update(LEGACY_V1_SCHEMA).digest('hex'));
    } finally { db.close(); }
    store = new ContactStore({ directory, passphrase: password, route });
  }
  return { root, directory, get store() { return store; },
    reopen() { store.close(); store = new ContactStore({ directory, passphrase: password, route }); return store; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function makeCredential(device) {
  return { version: 1, epoch: randomUUID(), device, scopes: [...GOOGLE_SCOPES], refresh_token: refreshToken,
    email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false };
}

async function googleServer({ holdInbox = false, holdAuthorization = false, holdRefresh = false, holdRevoke = false,
  grantWideRevocation = false, largeContent = false, wrongScope = false, wrongRefreshScope = false, invalidGrant = false,
  malformedRefresh = false, oversizedRefresh = false, malformedProfile = false, mailContent = null, calendarFlags = null,
  responses = {} } = {}) {
  let authorizationCount = 0, refreshCount = 0, revokeCount = 0, inboxCount = 0, calendarCount = 0, profileCount = 0;
  let activeGrant = true;
  const fixtureNow = Date.now();
  let inboxStartedResolve, inboxClosedResolve, authorizationStartedResolve, authorizationClosedResolve;
  const inboxStarted = new Promise(resolve => { inboxStartedResolve = resolve; });
  const inboxClosed = new Promise(resolve => { inboxClosedResolve = resolve; });
  const authorizationStarted = new Promise(resolve => { authorizationStartedResolve = resolve; });
  const authorizationClosed = new Promise(resolve => { authorizationClosedResolve = resolve; });
  let refreshStartedResolve, refreshClosedResolve, releaseRefresh, revokeStartedResolve, releaseRevoke;
  const refreshStarted = new Promise(resolve => { refreshStartedResolve = resolve; });
  const refreshClosed = new Promise(resolve => { refreshClosedResolve = resolve; });
  const revokeStarted = new Promise(resolve => { revokeStartedResolve = resolve; });
  const revokeReleased = new Promise(resolve => { releaseRevoke = resolve; });
  const requests = [];
  const removedInbox = new Set(); let oldDates = false;
  const overridden = (res, name) => {
    const response = responses[name]; if (!response) return false;
    if (Object.hasOwn(response, 'raw')) {
      res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' }); res.end(response.raw);
    } else json(res, response.status ?? 200, response.value);
    return true;
  };
  const server = await new Promise((resolve, reject) => {
    const instance = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams.toString() });
      if (url.pathname === '/oauth2/token' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (form.get('client_id') !== clientId) return json(res, 400, { error: 'invalid_client' });
        if (form.has('client_secret') && form.get('client_secret') !== clientSecret) return json(res, 400, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          if (!form.get('code_verifier') || !form.get('redirect_uri')?.startsWith('http://127.0.0.1:')) return json(res, 400, { error: 'invalid_request' });
          authorizationCount++; authorizationStartedResolve();
          if (holdAuthorization) {
            await new Promise(resolve => { res.once('close', () => { authorizationClosedResolve(); resolve(); }); });
            return;
          }
          if (overridden(res, 'authorization')) return;
          activeGrant = true;
          return json(res, 200, { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600,
            scope: wrongScope ? GOOGLE_SCOPES[0] : GOOGLE_SCOPES.join(' ') });
        }
        if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== refreshToken) return json(res, 400, { error: 'invalid_request' });
        refreshCount++; refreshStartedResolve();
        if (holdRefresh) {
          const resumed = await new Promise(resolve => { releaseRefresh = () => resolve(true); res.once('close', () => { refreshClosedResolve(); resolve(false); }); });
          if (!resumed) return;
        }
        if (overridden(res, 'refresh')) return;
        if (invalidGrant || (grantWideRevocation && !activeGrant)) return json(res, 400, { error: 'invalid_grant' });
        if (malformedRefresh) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return; }
        return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600,
          scope: wrongRefreshScope ? GOOGLE_SCOPES[0] : GOOGLE_SCOPES.join(' '), ...(oversizedRefresh ? { extra: 'X'.repeat(20000) } : {}) });
      }
      if (url.pathname === '/oauth2/revoke' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        if (new URLSearchParams(Buffer.concat(chunks).toString()).get('token') !== refreshToken) return json(res, 400, { error: 'invalid_token' });
        revokeCount++; revokeStartedResolve(); if (holdRevoke) await revokeReleased;
        if (grantWideRevocation) activeGrant = false;
        res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (req.headers.authorization !== `Bearer ${accessToken}` || (grantWideRevocation && !activeGrant)) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/gmail/v1/users/me/profile') {
        profileCount++;
        if (overridden(res, 'profile')) return;
        if (malformedProfile) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return; }
        return json(res, 200, { emailAddress: 'owner@example.test', messagesTotal: 3, threadsTotal: 2, historyId: '123' });
      }
      if (url.pathname === '/gmail/v1/users/me/messages' && req.method === 'GET') {
        inboxCount++; inboxStartedResolve();
        if (holdInbox) {
          await new Promise(resolve => { res.once('close', () => { inboxClosedResolve(); resolve(); }); });
          return;
        }
        assert.match(url.searchParams.get('q') ?? '', /^in:inbox after:\d+ before:\d+$/u);
        assert.equal(url.searchParams.get('maxResults'), '20');
        if (overridden(res, 'inbox')) return;
        const messages = largeContent ? Array.from({ length: 20 }, (_item, i) => ({ id: `m${i + 1}`, threadId: `t${i + 1}` }))
          : [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }];
        return json(res, 200, { messages: messages.filter(item => !removedInbox.has(item.id)), nextPageToken: 'next-page' });
      }
      const message = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
      if (message && req.method === 'GET') {
        const id = message[1];
        const headers = mailContent?.headers ?? [{ name: 'From', value: id === 'm1' ? 'Casey <casey@example.test>' : 'Morgan <morgan@example.test>' },
          { name: 'Subject', value: id === 'm1' ? 'Quarterly preparation' : 'Follow-up' }, { name: 'Date', value: 'Thu, 08 Oct 2026 09:00:00 +0000' }];
        if (largeContent) { headers[0].value = '김'.repeat(250); headers[1].value = '일정🙂'.repeat(100); }
        const received = String(fixtureNow - (oldDates ? 30 * 86400000 : 60000));
        const metadataLabels = mailContent && Object.hasOwn(mailContent, 'metadataLabels') ? mailContent.metadataLabels : ['INBOX'];
        const fullLabels = mailContent && Object.hasOwn(mailContent, 'fullLabels') ? mailContent.fullLabels : ['INBOX'];
        const fullDate = mailContent && Object.hasOwn(mailContent, 'fullInternalDate') ? mailContent.fullInternalDate : received;
        if (url.searchParams.get('format') === 'metadata') return json(res, 200, { id, threadId: `t${id.slice(1)}`, labelIds: metadataLabels, snippet: largeContent ? '회의 준비😀'.repeat(150) : 'Please review the plan before the meeting.', internalDate: received, payload: { headers } });
        if (url.searchParams.get('format') === 'full' && mailContent?.payload) return json(res, 200, { id, threadId: `t${id.slice(1)}`, labelIds: fullLabels, internalDate: fullDate, payload: mailContent.payload });
        if (url.searchParams.get('format') === 'full') return json(res, 200, { id, threadId: `t${id.slice(1)}`, labelIds: fullLabels, internalDate: fullDate,
          payload: { headers, mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from(largeContent ? '함께 준비해요🙂\n'.repeat(800) : 'CONFIDENTIAL_EMAIL_BODY: please review the renewal dates.').toString('base64url') }, parts: [] },
            { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML_FALLBACK_SHOULD_NOT_RUN</p>').toString('base64url') }, parts: [] },
            { filename: 'agenda.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1' } },
          ] } });
        return json(res, 400, { error: 'format_required' });
      }
      if (url.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'GET') {
        calendarCount++;
        assert.ok(Date.parse(url.searchParams.get('timeMin')) <= Date.now() + 1000);
        assert.ok(Date.parse(url.searchParams.get('timeMax')) >= Date.now() + 6 * 86400000);
        assert.equal(url.searchParams.get('singleEvents'), 'true'); assert.equal(url.searchParams.get('orderBy'), 'startTime');
        assert.equal(url.searchParams.get('maxResults'), '20');
        if (overridden(res, 'calendar')) return;
        const day = new Date(fixtureNow + 2 * 86400000).toISOString().slice(0, 10);
        const start = new Date(fixtureNow + 3 * 86400000).toISOString();
        if (calendarFlags) return json(res, 200, { items: calendarFlags.map((flag, i) => ({ id: `flag-${i}`,
          summary: `Event ${i}`, start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString() },
          ...(flag === undefined ? {} : { endTimeUnspecified: flag }) })) });
        if (largeContent) return json(res, 200, { items: Array.from({ length: 20 }, (_item, i) => ({ id: `event-${i}`,
          summary: '준비🙂'.repeat(200), description: '회의 자료😀'.repeat(300), location: '서울🙂'.repeat(200),
          start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString() } })) });
        return json(res, 200, { items: [
          { id: 'all-day', summary: 'Planning day', start: { date: day }, end: { date: new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) } },
          { id: 'meeting', summary: 'Renewal meeting', description: 'Bring the account notes.', location: 'Room 4', start: { dateTime: start, timeZone: 'Asia/Seoul' }, end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString(), timeZone: 'Asia/Seoul' } },
          { id: 'cancelled', status: 'cancelled', summary: 'Removed', start: { date: day }, end: { date: day } },
          { id: 'bad-date', summary: 'Malformed', start: { date: '2026-02-30' }, end: { date: day } },
          { id: 'bad-datetime', summary: 'Malformed time', start: { dateTime: '2026-02-30T12:00:00Z' }, end: { dateTime: start } },
        ], nextPageToken: 'next-calendar-page' });
      }
      json(res, 404, { error: 'not_found' });
    });
    instance.once('error', reject); instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  return { address, requests, inboxStarted, inboxClosed, authorizationStarted, authorizationClosed, refreshStarted, refreshClosed, revokeStarted, releaseRevoke,
    resumeRefresh: () => { holdRefresh = false; releaseRefresh?.(); }, restoreRefreshScopes: () => { wrongRefreshScope = false; },
    removeInboxId: id => removedInbox.add(id), ageEmails: () => { oldDates = true; },
    counts: () => ({ authorizationCount, refreshCount, revokeCount, inboxCount, calendarCount, profileCount }),
    async close() { releaseRevoke(); await new Promise(resolve => server.close(resolve)); } };
}

function makeConnection(store, service, fake, { secret = clientSecret, onOpen = async () => true, clock = Date.now, fetchImpl = globalThis.fetch } = {}) {
  const connection = new GoogleConnection({ store, clientId, clientSecret: secret, openBrowser: onOpen, clock, fetchImpl,
    testEndpoints: { token: `${fake.address}/oauth2/token`, revoke: `${fake.address}/oauth2/revoke`,
      gmail: `${fake.address}/gmail/v1`, calendar: `${fake.address}/calendar/v3` } });
  service?.attachGoogle(connection);
  return connection;
}
async function withGoogleSources(serverOptions, check, base = noSources) {
  const e = environment(), fake = await googleServer(serverOptions), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  const connection = makeConnection(e.store, null, fake);
  e.store.submit(owner.id, randomUUID(), '최근 메일을 확인해줘.');
  const job = e.store.claim(), sources = new GoogleSources(base, e.store, connection, job), signal = new AbortController().signal;
  try { await check({ sources, signal, fake }); }
  finally { connection.close(); e.close(); await fake.close(); }
}
const textPart = (bytes, charset = 'UTF-8', mimeType = 'text/plain') => ({ mimeType,
  headers: [{ name: 'Content-Type', value: `${mimeType}; charset="${charset}"` }], body: { data: Buffer.from(bytes).toString('base64url') } });
const evidenceOf = result => ({ id: 'S1', source: result.source, path: result.path, sha256: result.sha256, observed_at: result.observed_at });

async function contactNetwork(store, service) {
  const origin = 'http://127.0.0.1:9178';
  const host = await serveContact({ store, service, origin, port: 0 });
  const address = `http://127.0.0.1:${host.address.port}`;
  const call = (path, body, cookie = '') => new Promise((resolve, reject) => {
    const req = request(address + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Host: '127.0.0.1:9178', Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pairUrl = new URL(host.pair()); const code = new URLSearchParams(pairUrl.hash.slice(1)).get('pair');
  const paired = await call('/api/pair', { code, name: 'Google test' });
  assert.equal(paired.status, 200);
  const cookie = String(paired.headers['set-cookie'][0]).split(';')[0];
  return { host, call, cookie };
}

for (const version of [1, 2, 3, 4]) test(`v${version} Google connection requires explicit journal upgrade before OAuth and preserves existing records`, async () => {
  const e = environment(version), fake = await googleServer(), owner = e.store.addDevice('Owner'); let opened = 0;
  const seq = e.store.submit(owner.id, randomUUID(), '이전 대화를 보존해줘.').seq;
  e.store.claim(); e.store.finish(seq, { text: '이전 답변입니다.', sources: [] }, new ConversationAssistant({}, noSources).checkpoint());
  const service = new ContactService(e.store, { chat: async () => reply('ok') }, noSources);
  const connection = makeConnection(e.store, service, fake, { onOpen: async () => { opened++; return true; } });
  const network = await contactNetwork(e.store, service), identity = e.store.id;
  try {
    const status = (await network.call('/api/state', undefined, network.cookie)).json().google;
    assert.equal(status.available, true); assert.equal(status.configured, true);
    assert.equal(status.state, 'upgrade_required'); assert.equal(status.connected, false); assert.equal(status.pending, false);
    await assert.rejects(connection.connect(owner.id, 'google_readonly_v1'), /CONTACT_ASSISTANCE_UPGRADE_REQUIRED/u);
    const rejected = await network.call('/api/google/connect', { consent: 'google_readonly_v1' }, network.cookie);
    assert.equal(rejected.status, 400); assert.deepEqual(rejected.json(), { error: 'CONTACT_ASSISTANCE_UPGRADE_REQUIRED' });
    assert.equal(opened, 0); assert.deepEqual(fake.requests, []);
    assert.equal(connection.status().state, 'upgrade_required'); assert.equal(connection.status().error, null);
    assert.equal(e.store.contactVersion, version); assert.equal(e.store.id, identity);
    e.reopen(); assert.equal(e.store.contactVersion, version); assert.equal(e.store.id, identity);
    assert.equal(e.store.turn(seq).answer.text, '이전 답변입니다.'); assert.equal(e.store.googleCredential(), null);
  } finally { await network.host.close(); await service.close(); e.close(); await fake.close(); }
});

test('Google Settings consent opens a PKCE loopback flow, rejects stale/duplicate state and keeps tokens out of API state', async () => {
  const e = environment(); const fake = await googleServer();
  const device = e.store.addDevice('Owner'); let opened = '';
  const service = new ContactService(e.store, { chat: async () => reply('ok') }, noSources);
  const connection = makeConnection(e.store, service, fake, { onOpen: async url => { opened = url; return true; } });
  const network = await contactNetwork(e.store, service);
  try {
    const initial = (await network.call('/api/state', undefined, network.cookie)).json().google;
    assert.equal(initial.configured, true); assert.equal(initial.state, 'disconnected');
    const started = await network.call('/api/google/connect', { consent: 'google_readonly_v1' }, network.cookie);
    assert.equal(started.status, 202); assert.deepEqual(started.json(), { state: 'waiting' });
    const auth = new URL(opened);
    assert.equal(auth.origin, 'https://accounts.google.com'); assert.equal(auth.pathname, '/o/oauth2/v2/auth');
    assert.equal(auth.searchParams.get('response_type'), 'code'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('access_type'), 'offline'); assert.equal(auth.searchParams.get('prompt'), 'consent');
    assert.equal(auth.searchParams.get('scope'), GOOGLE_SCOPES.join(' ')); assert.equal(auth.searchParams.has('openid'), false);
    assert.match(auth.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/u);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1'); assert.equal(callback.pathname, '/oauth2/callback');
    const state = auth.searchParams.get('state');
    const stale = new URL(callback); stale.searchParams.set('state', `${state.slice(0, -1)}${state.endsWith('x') ? 'y' : 'x'}`); stale.searchParams.set('code', 'fake_code');
    assert.equal((await fetch(stale, { redirect: 'manual' })).status, 400);
    const multibyte = new URL(callback); multibyte.searchParams.set('state', `${state.slice(0, -1)}한`); multibyte.searchParams.set('code', 'fake_code');
    assert.equal(multibyte.searchParams.get('state').length, state.length);
    assert.equal((await fetch(multibyte, { redirect: 'manual' })).status, 400);
    // A malformed callback must not crash either the listener or contact host.
    assert.equal((await network.call('/api/state', undefined, network.cookie)).status, 200);
    const duplicate = new URL(callback); duplicate.searchParams.set('state', state); duplicate.searchParams.append('state', state); duplicate.searchParams.set('code', 'fake_code');
    assert.equal((await fetch(duplicate, { redirect: 'manual' })).status, 400);
    for (const key of ['code', 'error']) {
      const repeated = new URL(callback); repeated.searchParams.set('state', state);
      repeated.searchParams.append(key, 'fake'); repeated.searchParams.append(key, 'fake');
      assert.equal((await fetch(repeated, { redirect: 'manual' })).status, 400);
    }
    const valid = new URL(callback); valid.searchParams.set('state', state); valid.searchParams.set('code', 'synthetic_authorization_code');
    // Provider callback extensions are informational. The token response still
    // determines granted scopes; these cannot broaden a saved credential.
    valid.searchParams.set('scope', 'https://www.googleapis.com/auth/drive'); valid.searchParams.set('authuser', '0');
    valid.searchParams.set('prompt', 'consent'); valid.searchParams.set('hd', 'example.test');
    valid.searchParams.append('provider_extension', 'one'); valid.searchParams.append('provider_extension', 'two');
    const completed = await fetch(valid);
    assert.match(await completed.text(), /Google 계정 연결 완료/u);
    const saved = e.store.googleCredential();
    assert.equal(saved.email, 'owner@example.test'); assert.deepEqual(saved.scopes, GOOGLE_SCOPES);
    assert.equal(saved.refresh_token, refreshToken); assert.equal(validGoogleCredential(saved), true);
    const stateResponse = await network.call('/api/state', undefined, network.cookie);
    const stateText = stateResponse.text;
    assert.equal(stateResponse.json().google.connected, true);
    for (const secret of [clientSecret, accessToken, refreshToken]) assert.equal(stateText.includes(secret), false);
    assert.equal(connection.status().pending, false);
    const raw = readFileSync(join(e.directory, 'contact.sqlite'));
    assert.equal(raw.includes(Buffer.from(refreshToken)), false);
    const app = readFileSync(new URL('../../../apps/contact/app.js', import.meta.url), 'utf8');
    assert.match(app, /api\/google\/connect/u); assert.match(app, /api\/google\/disconnect/u);
    assert.match(app, /최근 7일 받은편지함/u); assert.match(app, /선택한 Tada 모델로 전송/u);
    const disconnected = await network.call('/api/google/disconnect', {}, network.cookie);
    assert.equal(disconnected.status, 200); assert.equal(disconnected.json().local_removed, true); assert.equal(disconnected.json().remote_revoked, true);
    assert.equal(fake.counts().revokeCount, 1); assert.equal(e.store.googleCredential(), null);
    const finalState = (await network.call('/api/state', undefined, network.cookie)).text;
    for (const secret of [clientSecret, accessToken, refreshToken]) assert.equal(finalState.includes(secret), false);
  } finally { await network.host.close(); await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('Google read tools use bounded Gmail/Calendar GETs, preserve all-day events and verify account-bound evidence', async () => {
  const e = environment(); const fake = await googleServer(); const device = e.store.addDevice('Owner');
  const credential = makeCredential(device.id); e.store.saveGoogleCredential(device.id, credential, null);
  const connection = makeConnection(e.store, null, fake);
  const seq = e.store.submit(device.id, randomUUID(), '지난 메일과 다음 미팅을 보고 준비할 내용을 정리해줘.').seq;
  const job = e.store.claim(); assert.equal(job.seq, seq);
  const sources = new GoogleSources(noSources, e.store, connection, job);
  try {
    assert.deepEqual(sources.definitions.map(tool => tool.function.name), ['list_recent_emails', 'read_email', 'list_upcoming_events']);
    assert.equal(sources.validate('read_email', { id: 'invented' }), false);
    const signal = new AbortController().signal;
    const inbox = await sources.execute('list_recent_emails', {}, signal);
    const events = await sources.execute('list_upcoming_events', {}, signal);
    assert.equal(inbox.truncated, true); assert.equal(inbox.max_results, 20);
    assert.equal(events.truncated, true); assert.equal(events.max_results, 20);
    const inboxData = JSON.parse(inbox.content); const calendarData = JSON.parse(events.content);
    assert.equal(inboxData.emails.length, 2); assert.equal(inboxData.emails[0].subject, 'Quarterly preparation');
    const allDay = calendarData.events.find(event => event.start.date && event.end.date); assert.ok(allDay);
    assert.equal(Date.parse(allDay.end.date) - Date.parse(allDay.start.date), 86400000); assert.equal(allDay.endTimeUnspecified, false);
    assert.equal(calendarData.events.some(event => ['cancelled', 'bad-date', 'bad-datetime'].includes(event.id)), false);
    assert.match(inbox.sha256, /^[a-f0-9]{64}$/u); assert.match(events.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Date.parse(inbox.observed_at)); assert.ok(Date.parse(events.observed_at));
    const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.match(email.content, /CONFIDENTIAL_EMAIL_BODY/u); assert.doesNotMatch(email.content, /HTML_FALLBACK|agenda\.pdf/u);
    const emailEvidence = { id: 'S1', source: email.source, path: email.path, sha256: email.sha256, observed_at: email.observed_at };
    const inboxEvidence = { id: 'S2', source: inbox.source, path: inbox.path, sha256: inbox.sha256, observed_at: inbox.observed_at };
    const eventsEvidence = { id: 'S3', source: events.source, path: events.path, sha256: events.sha256, observed_at: events.observed_at };
    assert.equal(await sources.verify(emailEvidence, signal), true);
    assert.equal(await sources.verify(inboxEvidence, signal), true);
    assert.equal(await sources.verify(eventsEvidence, signal), true);
    assert.equal(await sources.verify({ ...emailEvidence, source: 'Gmail (other@example.test)' }, signal), false);
    assert.equal(fake.counts().refreshCount, 1);
    const list = fake.requests.find(item => item.path === '/gmail/v1/users/me/messages');
    assert.ok(list.query.includes('in%3Ainbox') || list.query.includes('in%3Ainbox'));
    assert.ok(fake.requests.some(item => item.path.endsWith('/messages/m1') && item.query.includes('format=metadata')));
    assert.ok(fake.requests.some(item => item.path.endsWith('/messages/m1') && item.query.includes('format=full')));
    assert.ok(fake.requests.some(item => item.path === '/calendar/v3/calendars/primary/events'));
    await assert.rejects(connection.apiJson(device.id, credential.epoch, new URL('https://attacker.example/api'), signal), /URL_REJECTED/u);
  } finally { connection.close(); e.close(); await fake.close(); }
});

test('calendar unspecified ends preserve meaning, documented defaults and flag-only evidence changes', async () => {
  const flags = [true, false, undefined];
  await withGoogleSources({ calendarFlags: flags }, async ({ sources, signal }) => {
    const result = await sources.execute('list_upcoming_events', {}, signal), events = JSON.parse(result.content).events;
    assert.deepEqual(events.map(event => event.endTimeUnspecified), [true, false, false]);
    assert.ok(events[0].end.dateTime); // Google's compatibility value remains explicitly marked.
    const guidance = sources.definitions.find(tool => tool.function.name === 'list_upcoming_events').function.description;
    assert.match(guidance, /compatibility value/u); assert.match(guidance, /do not infer duration or free time/u); assert.match(guidance, /end is exclusive/u);
    const evidence = evidenceOf(result); assert.equal(await sources.verify(evidence, signal), true);
    flags[2] = false; assert.equal(await sources.verify(evidence, signal), true);
    flags[0] = false; assert.equal(await sources.verify(evidence, signal), false);
  });
});

test('calendar endTimeUnspecified rejects malformed values instead of coercing them to a fixed end', async () => {
  for (const flag of [null, 0, 'false']) await withGoogleSources({ calendarFlags: [flag] }, async ({ sources, signal }) => {
    await assert.rejects(sources.execute('list_upcoming_events', {}, signal), /CONTACT_GOOGLE_SOURCE_INVALID/u);
  });
});

test('zoned local calendar times preserve their wall time, fractions and IANA zone in evidence without a guessed instant', async () => {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const events = [{ id: 'local-zone', summary: '서울 미팅', start: { dateTime: `${day}T09:00:00.123456789`, timeZone: 'Asia/Seoul' },
    end: { dateTime: `${day}T10:00:00`, timeZone: 'Asia/Seoul' } }];
  await withGoogleSources({ responses: { calendar: { value: { items: events } } } }, async ({ sources, signal }) => {
    const result = await sources.execute('list_upcoming_events', {}, signal), data = JSON.parse(result.content);
    assert.deepEqual(data.events[0].start, events[0].start); assert.deepEqual(data.events[0].end, events[0].end);
    assert.equal(data.events.length, 1); assert.equal(data.truncated, false); assert.equal(data.omitted_events, undefined);
    const guide = sources.definitions.find(tool => tool.function.name === 'list_upcoming_events').function.description;
    assert.match(guide, /local time in timeZone/u); assert.match(guide, /do not assume UTC or resolve DST/u);
    const evidence = evidenceOf(result); assert.equal(await sources.verify(evidence, signal), true);
    events[0].start.timeZone = 'Asia/Tokyo'; assert.equal(await sources.verify(evidence, signal), false);
  });
});

test('offset-bearing and all-day calendar values stay compatible while explicit zone-only changes invalidate evidence', async () => {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  const events = [
    { id: 'explicit-zone', start: { dateTime: `${day}T09:00:00+09:00`, timeZone: 'Asia/Seoul' }, end: { dateTime: `${day}T10:00:00+09:00`, timeZone: 'Asia/Seoul' } },
    { id: 'offset-only', start: { dateTime: `${day}T00:00:00Z` }, end: { dateTime: `${day}T01:00:00Z` } },
    { id: 'all-day-zone', start: { date: day, timeZone: 'Asia/Seoul' }, end: { date: next, timeZone: 'Asia/Seoul' } },
  ];
  await withGoogleSources({ responses: { calendar: { value: { items: events } } } }, async ({ sources, signal }) => {
    const result = await sources.execute('list_upcoming_events', {}, signal), data = JSON.parse(result.content);
    assert.equal(data.events.length, 3); assert.equal(data.truncated, false);
    for (let i = 0; i < events.length; i++) { assert.deepEqual(data.events[i].start, events[i].start); assert.deepEqual(data.events[i].end, events[i].end); }
    assert.equal(await sources.verify(evidenceOf(result), signal), true);
    events[0].end.timeZone = 'Asia/Tokyo'; assert.equal(await sources.verify(evidenceOf(result), signal), false);
  });
});

test('invalid local calendar components or zones are explicitly omitted and cannot become a complete empty list', async () => {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const invalid = [
    { dateTime: `${day}T09:00:00` }, { dateTime: `${day}T09:00:00`, timeZone: null },
    { dateTime: `${day}T09:00:00`, timeZone: 'Mars/Olympus' }, { dateTime: `${day}T09:00:00`, timeZone: '+09:00' },
    { dateTime: '2026-02-30T09:00:00', timeZone: 'Asia/Seoul' },
    ...['24:00:00', '09:60:00', '09:00:60'].map(time => ({ dateTime: `${day}T${time}`, timeZone: 'Asia/Seoul' })),
    { dateTime: `${day}T09:00:00+24:00` }, { dateTime: `${day}T09:00:00+09:60` },
    { dateTime: `${day}T09:00:00Z`, timeZone: 'Invalid/Zone' }, { date: '2026-02-30' },
  ];
  const events = invalid.map((start, i) => ({ id: `bad-zone-${i}`, start, end: { dateTime: `${day}T10:00:00`, timeZone: 'Asia/Seoul' } }));
  const responses = { calendar: { value: { items: events } } };
  await withGoogleSources({ responses }, async ({ sources, signal }) => {
    const result = await sources.execute('list_upcoming_events', {}, signal), data = JSON.parse(result.content);
    assert.deepEqual(data.events, []); assert.equal(data.truncated, true); assert.equal(data.omitted_events, invalid.length);
    assert.equal(result.truncated, true); assert.equal(await sources.verify(evidenceOf(result), signal), true);
    events.pop(); assert.equal(await sources.verify(evidenceOf(result), signal), false);
  });
  responses.calendar.value.items = [{ id: 'cancelled', status: 'cancelled' }];
  await withGoogleSources({ responses }, async ({ sources, signal }) => {
    const data = JSON.parse((await sources.execute('list_upcoming_events', {}, signal)).content);
    assert.deepEqual(data.events, []); assert.equal(data.truncated, false); assert.equal(data.omitted_events, undefined);
  });
});

test('OAuth callback finishes without completion-page navigation and disconnect contains a late exchange rejection', async () => {
  const e = environment(); const fake = await googleServer(); const device = e.store.addDevice('Owner'); let opened;
  const connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    await connection.connect(device.id, 'google_readonly_v1');
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    assert.equal(connection.status().connected, true);
    // Deliberately do not visit /oauth2/complete. The bounded cleanup timer must
    // release the attempt so another owner-requested connection can start.
    await new Promise(resolve => setTimeout(resolve, 1150));
    await assert.rejects(fetch(callback, { redirect: 'manual' }), /fetch failed/u);
    assert.deepEqual(await connection.connect(device.id, 'google_readonly_v1'), { state: 'waiting' });
    await connection.disconnect(device.id);
  } finally { connection.close(); e.close(); await fake.close(); }

  const second = environment(); const held = await googleServer({ holdAuthorization: true }); const owner = second.store.addDevice('Owner');
  // Reconnecting an existing credential exercises cancellation while a callback
  // still carries the old epoch. It must never record an error into removed data.
  second.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  let heldUrl;
  const late = makeConnection(second.store, null, held, { onOpen: async url => { heldUrl = url; return true; } });
  try {
    await late.connect(owner.id, 'google_readonly_v1');
    const auth = new URL(heldUrl), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    const response = fetch(callback, { redirect: 'manual' });
    await held.authorizationStarted;
    const disconnected = await late.disconnect(owner.id);
    assert.equal(disconnected.remote_revoked, true);
    assert.equal((await response).status, 303); await held.authorizationClosed;
    assert.equal(second.store.googleCredential(), null);
    assert.equal(late.status().error, null); assert.equal(late.status().pending, false);
  } finally { late.close(); second.close(); await held.close(); }
});

test('the contact host cancels a first OAuth attempt immediately and admits a fresh retry', async () => {
  const e = environment(), fake = await googleServer(); let opens = 0;
  const service = new ContactService(e.store, { chat: async () => reply('ok') }, noSources);
  const connection = makeConnection(e.store, service, fake, { onOpen: async () => { opens++; return true; } });
  const network = await contactNetwork(e.store, service);
  try {
    assert.equal((await network.call('/api/google/connect', { consent: 'google_readonly_v1' }, network.cookie)).status, 202);
    let status = (await network.call('/api/state', undefined, network.cookie)).json().google;
    assert.equal(status.pending, true); assert.equal(status.has_credential, false);
    const canceled = await network.call('/api/google/disconnect', {}, network.cookie);
    assert.equal(canceled.status, 200); assert.deepEqual(canceled.json(), { local_removed: true, remote_revoked: null });
    status = (await network.call('/api/state', undefined, network.cookie)).json().google;
    assert.equal(status.pending, false); assert.equal(status.has_credential, false);
    assert.deepEqual(status.last_disconnect, { local_removed: true, remote_revoked: null });
    assert.equal((await network.call('/api/google/connect', { consent: 'google_readonly_v1' }, network.cookie)).status, 202);
    assert.equal(opens, 2); assert.equal(fake.requests.length, 0);
  } finally { await network.host.close(); await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('a larger connected provider can inspect a broad overview and verify that exact overview', async () => {
  const e = environment(), fake = await googleServer({ largeContent: true }), device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const connection = makeConnection(e.store, null, fake);
  e.store.submit(device.id, randomUUID(), 'Read my recent inbox');
  const source = new GoogleSources(noSources, e.store, connection, e.store.claim()), signal = new AbortController().signal;
  try {
    const budget = { contextLimitBytes: 65536, fits: value => Buffer.byteLength(JSON.stringify(value)) < 28000 };
    const overview = await source.execute('list_recent_emails', {}, signal, budget);
    assert.ok(JSON.parse(overview.content).emails.length >= 10);
    const first = await source.execute('read_email', { id: 'm1' }, signal, budget);
    const second = await source.execute('read_email', { id: 'm2' }, signal, budget);
    assert.ok(first.content.length > 100); assert.ok(second.content.length > 100);
    assert.equal(await source.verify(overview, signal), true);
    assert.equal(await source.verify(first, signal), true); assert.equal(await source.verify(second, signal), true);
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const measure of ['normalized', 'subscription']) test(`large multibyte Google lists/body fit combined native tools and ${measure} request context`, async () => {
  const e = environment(); const fake = await googleServer({ largeContent: true }); const device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const measurements = []; const observed = new Map();
  const native = new NativeSources(process.execPath, []); await native.initialize(new AbortController().signal);
  const subscription = new ChatGPTSubscription({ account: {}, model: 'synthetic-fixture-model' });
  const actualBytes = (messages, tools) => measure === 'subscription' ? subscription.contextBytes(messages, tools)
    : Buffer.byteLength(JSON.stringify({ messages, tools }));
  const model = { async chat(messages, tools) {
    const contextBytes = actualBytes(messages, tools); measurements.push(contextBytes);
    assert.ok(contextBytes <= 14000);
    for (const tool of discoveryTools) assert.ok(tools.some(item => item.function.name === tool.function.name));
    assert.match(messages[0].content, /reply status cannot be checked/u);
    const current = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1);
    for (const message of current.filter(message => message.role === 'tool')) {
      const result = JSON.parse(message.content); observed.set(message.tool_name, result); assert.equal(result.error, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
      assert.doesNotMatch(result.content, /\uFFFD/u);
    }
    if (!observed.has('list_recent_emails')) return reply('', [callTool('list_recent_emails'), callTool('list_upcoming_events')]);
    if (!observed.has('read_email')) return reply('', [callTool('read_email', { id: JSON.parse(observed.get('list_recent_emails').content).emails[0].id })]);
    return reply('받은편지함 [S1]과 다가오는 일정 [S2], 선택한 메일 발췌 [S3]를 확인했어요. 목록과 본문은 일부만 보았고, 실제 답장 여부는 확인할 수 없어요.');
  } };
  if (measure === 'subscription') model.contextBytes = actualBytes;
  const service = new ContactService(e.store, model, native); const connection = makeConnection(e.store, service, fake);
  try {
    const { seq } = service.submit(device.id, randomUUID(), '메일과 다음 미팅을 함께 살펴보고 준비할 내용을 정리해줘.');
    await service.idle(); const turn = e.store.turn(seq);
    assert.equal(turn.state, 'answered', JSON.stringify({ turn, measurements, observed: [...observed] })); assert.equal(turn.answer.sources.length, 3);
    assert.equal(measurements.length, 3);
    const inbox = JSON.parse(observed.get('list_recent_emails').content), calendar = JSON.parse(observed.get('list_upcoming_events').content);
    assert.equal(inbox.truncated, true); assert.equal(calendar.truncated, true);
    assert.ok(inbox.emails.length > 0 && inbox.emails.length < 20);
    assert.ok(calendar.events.length > 0 && calendar.events.length < 20);
    assert.equal(inbox.reply_status, 'unavailable_inbox_only_no_sent_mail_or_thread_check');
    const email = observed.get('read_email'), body = email.content.slice(email.content.indexOf('\n\n') + 2);
    assert.equal(email.truncated, true); assert.equal(email.max_body_bytes, 4096);
    assert.ok(Buffer.byteLength(body) > 0 && Buffer.byteLength(body) <= 4096);
    assert.match(email.path, /^messages\/m1\?body_bytes=\d+$/u);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const changed of [false, true]) test(`real native excerpts in a Google batch preserve the full-file hash${changed ? ' and reject changes outside the excerpt' : ''}`, {
  skip: process.env.TADA_TEST_READ_BROKER ? false : 'Set TADA_TEST_READ_BROKER to the compiled Rust read broker for this integration test',
}, async () => {
  const e = environment(), fake = await googleServer(), device = e.store.addDevice('Owner');
  const notes = join(e.root, 'notes'); mkdirSync(notes);
  const content = '미팅 준비🙂\n'.repeat(320) + 'ORIGINAL_TAIL', path = join(notes, 'brief.txt'); writeFileSync(path, content);
  const originalHash = createHash('sha256').update(content).digest('hex');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const native = new NativeSources(process.env.TADA_TEST_READ_BROKER, [notes]); await native.initialize(new AbortController().signal);
  const subscription = new ChatGPTSubscription({ account: {}, model: 'synthetic-fixture-model' });
  let phase = 0, excerpt; const measurements = [];
  const model = { contextBytes: (messages, tools) => subscription.contextBytes(messages, tools), async chat(messages, tools) {
    measurements.push(this.contextBytes(messages, tools)); assert.ok(measurements.at(-1) <= 14000);
    assert.ok(tools.some(tool => tool.function.name === 'read_document')); assert.ok(tools.some(tool => tool.function.name === 'list_followups'));
    if (phase++ === 0) return reply('', [callTool('list_sources')]);
    if (phase === 2) return reply('', [callTool('list_files', { source: 's1', directory: '.' })]);
    if (phase === 3) return reply('', [callTool('list_recent_emails'), callTool('read_file', { source: 's1', path: 'brief.txt' })]);
    const email = JSON.parse(messages.findLast(message => message.tool_name === 'list_recent_emails').content);
    excerpt = JSON.parse(messages.findLast(message => message.tool_name === 'read_file').content);
    assert.equal(email.error, undefined); assert.equal(email.evidence_id, 'S1');
    assert.equal(excerpt.error, undefined); assert.equal(excerpt.evidence_id, 'S2'); assert.equal(excerpt.truncated, true);
    assert.equal(excerpt.path, 'brief.txt'); assert.equal(excerpt.sha256, originalHash); assert.equal(excerpt.bytes, Buffer.byteLength(content));
    assert.ok(excerpt.content.length > 0 && excerpt.content.length < content.length); assert.ok(content.startsWith(excerpt.content));
    assert.equal(excerpt.excerpt_bytes, Buffer.byteLength(excerpt.content)); assert.doesNotMatch(excerpt.content, /\uFFFD/u);
    if (changed) { writeFileSync(path, content.slice(0, -1) + 'X'); assert.ok(readFileSync(path, 'utf8').startsWith(excerpt.content)); }
    return reply('최근 메일 [S1]과 허용된 메모의 발췌 [S2]를 확인했어요. 메모 본문은 일부만 읽었습니다.');
  } };
  const service = new ContactService(e.store, model, native), connection = makeConnection(e.store, service, fake);
  try {
    const { seq } = service.submit(device.id, randomUUID(), '최근 메일과 메모를 같이 읽고 미팅을 준비해줘.'); await service.idle();
    const turn = e.store.turn(seq); assert.equal(measurements.length, 4, JSON.stringify(turn));
    if (changed) { assert.equal(turn.state, 'failed'); assert.equal(turn.error, 'SOURCE_CHANGED_REOBSERVE_REQUIRED'); assert.equal(turn.answer, null); }
    else { assert.equal(turn.state, 'answered', JSON.stringify(turn)); assert.equal(turn.answer.sources.length, 2); assert.equal(turn.answer.sources[1].sha256, originalHash); }
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('a source that ignores context budget is rejected before evidence and the next subscription request can still answer', async () => {
  const e = environment(), fake = await googleServer(), device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const oversized = { source: 's1', path: 'brief.txt', content: 'OVERSIZED_PRIVATE_FILE '.repeat(700), sha256: 'a'.repeat(64), observed_at: new Date().toISOString() };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < 32768);
  let verified = 0;
  const base = { definitions: discoveryTools, validate: validCall, async execute(name) {
    if (name === 'list_sources') return { sources: [{ source: 's1', label: 'notes' }] };
    if (name === 'list_files') return { source: 's1', files: ['brief.txt'] };
    return oversized;
  }, async verify() { verified++; return true; } };
  const subscription = new ChatGPTSubscription({ account: {}, model: 'synthetic-fixture-model' }); let phase = 0;
  const model = { contextBytes: (messages, tools) => subscription.contextBytes(messages, tools), async chat(messages, tools) {
    assert.ok(this.contextBytes(messages, tools) <= 14000); assert.equal(JSON.stringify(messages).includes('OVERSIZED_PRIVATE_FILE'), false);
    if (phase++ === 0) return reply('', [callTool('list_sources')]);
    if (phase === 2) return reply('', [callTool('list_files', { source: 's1', directory: '.' })]);
    if (phase === 3) return reply('', [callTool('list_recent_emails'), callTool('read_file', { source: 's1', path: 'brief.txt' })]);
    const rejected = JSON.parse(messages.findLast(message => message.tool_name === 'read_file').content);
    assert.deepEqual(rejected, { error: 'ASSISTANT_SOURCE_LIMIT', performed: false });
    assert.equal(JSON.parse(messages.findLast(message => message.tool_name === 'list_recent_emails').content).evidence_id, 'S1');
    return reply('최근 메일을 확인했어요. [S1] 메모 내용은 이번 답변에서 확인하지 못했습니다.');
  } };
  const service = new ContactService(e.store, model, base), connection = makeConnection(e.store, service, fake);
  try {
    const { seq } = service.submit(device.id, randomUUID(), '메일과 메모를 함께 정리해줘.'); await service.idle();
    const turn = e.store.turn(seq); assert.equal(turn.state, 'answered', JSON.stringify(turn));
    assert.equal(phase, 4); assert.equal(turn.answer.sources.length, 1); assert.equal(verified, 0);
    assert.equal(e.store.checkpoint().value.evidence.length, 1); assert.equal(e.store.checkpoint().value.nextEvidence, 2);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const name of ['prepare_document', 'propose_followup']) test(`${name} context rejection leaves no staged artifact when a small final answer commits`, async () => {
  const e = environment(), device = e.store.addDevice('Owner'), text = '다음 미팅 준비를 기억해줘.';
  const args = name === 'prepare_document' ? { title: '미팅 준비', format: 'text', based_on: null }
    : { operation_id: 'prepare_meeting', target: null, expected_version: 0, title: '미팅 준비', details: '미팅 준비 내용을 정리하기',
      state: 'open', waiting_for: null, notify_at: null, user_quote: text };
  const stagedCall = reply('', [callTool(name, args)]), error = { error: 'ASSISTANT_SOURCE_LIMIT', performed: false };
  const bytes = (messages, tools) => Buffer.byteLength(JSON.stringify({ messages, tools }));
  let envelopeBytes, phase = 0;
  const model = { contextBytes(messages, tools) {
    if (envelopeBytes === undefined) {
      // A fixed synthetic provider envelope leaves room for the failure, but
      // not the larger staging receipt. It stays constant for this whole turn.
      const failedBatch = [...messages, stagedCall.message, { role: 'tool', tool_name: name, content: JSON.stringify(error) }];
      envelopeBytes = 14000 - bytes(failedBatch, tools) - 16;
      assert.ok(envelopeBytes >= 0);
    }
    return bytes(messages, tools) + envelopeBytes;
  }, async chat(messages, tools) {
    assert.ok(this.contextBytes(messages, tools) <= 14000);
    if (phase++ === 0) return stagedCall;
    assert.deepEqual(JSON.parse(messages.findLast(message => message.tool_name === name).content), error);
    return reply('이번에는 저장하지 못했어요.');
  } };
  const service = new ContactService(e.store, model, noSources);
  try {
    const { seq } = service.submit(device.id, randomUUID(), text); await service.idle();
    const turn = e.store.turn(seq); assert.equal(turn.state, 'answered', JSON.stringify(turn)); assert.equal(phase, 2);
    assert.equal(turn.answer.text, '이번에는 저장하지 못했어요.'); assert.equal(e.store.document(seq), null);
    assert.deepEqual(e.store.documentPage().documents, []); assert.deepEqual(e.store.followupState().proposals, []);
    assert.deepEqual(e.store.followupPage().items, []);
  } finally { await service.close(); e.close(); }
});

test('real SQLite and ContactService compose email/calendar into one answer and redact raw account content from checkpoints', async () => {
  const e = environment(); const fake = await googleServer(); const device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const seen = [];
  const model = { async chat(messages, tools) {
    seen.push(messages);
    const current = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1);
    const toolNames = current.filter(message => message.role === 'tool').map(message => message.tool_name);
    if (!toolNames.includes('list_recent_emails')) return reply('', [callTool('list_recent_emails'), callTool('list_upcoming_events')]);
    if (!toolNames.includes('read_email')) return reply('', [callTool('read_email', { id: 'm1' })]);
    assert.ok(tools.some(tool => tool.function.name === 'read_email'));
    return reply('최근 메일은 갱신 날짜 검토를 요청하고 [S3], 다가오는 일정은 준비 미팅입니다 [S2]. 받은편지함에는 두 메시지가 있어요 [S1].');
  } };
  const service = new ContactService(e.store, model, noSources); const connection = makeConnection(e.store, service, fake);
  try {
    const result = service.submit(device.id, randomUUID(), '메일과 다음 일정을 보고 미팅을 준비해줘.');
    await service.idle();
    const turn = e.store.turn(result.seq);
    assert.equal(turn.state, 'answered'); assert.equal(turn.answer.verification, 'cited_sources_rechecked');
    assert.equal(turn.answer.sources.length, 3);
    assert.match(turn.answer.text, /\[S3\]/u); assert.match(turn.answer.text, /\[S2\]/u);
    const checkpoint = e.store.checkpoint().value;
    assert.equal(JSON.stringify(checkpoint).includes('CONFIDENTIAL_EMAIL_BODY'), false);
    assert.equal(JSON.stringify(checkpoint).includes('Quarterly preparation'), false);
    assert.equal(JSON.stringify(checkpoint).includes(accessToken), false);
    assert.equal(JSON.stringify(seen).includes(accessToken), false); assert.equal(JSON.stringify(seen).includes(refreshToken), false);
    assert.equal(JSON.stringify(seen).includes(clientSecret), false);
    assert.equal(fake.counts().refreshCount, 1);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('an empty saved conversation can surface a cited Google suggestion; NO_NEW_SUGGESTION stays quiet the next day', async () => {
  const e = environment(); const fake = await googleServer(); const device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  let day = 0;
  const model = { async chat(messages, tools) {
    const current = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1);
    if (!current.some(message => message.role === 'tool')) {
      day++;
      assert.ok(tools.some(tool => tool.function.name === 'list_recent_emails'));
      assert.ok(tools.some(tool => tool.function.name === 'list_upcoming_events'));
      return reply('', [callTool('list_recent_emails'), callTool('list_upcoming_events')]);
    }
    if (day === 1 && !current.some(message => message.role === 'tool' && message.tool_name === 'read_email')) {
      return reply('', [callTool('read_email', { id: 'm1' })]);
    }
    return day === 1
      ? reply('최근 메일의 갱신 날짜를 다음 주 준비 미팅에서 확인하면 좋겠어요 [S3] [S2].')
      : reply('NO_NEW_SUGGESTION');
  } };
  const service = new ContactService(e.store, model, noSources); const connection = makeConnection(e.store, service, fake);
  const noon = Date.parse('2026-10-08T03:00:00Z');
  try {
    e.store.configureProactive(device.id, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', noon);
    assert.equal(e.store.proactiveTick(noon, true), 1);
    service.start(); await service.idle();
    const first = e.store.page().turns.at(-1);
    assert.equal(first.origin, 'proactive'); assert.equal(first.answer.quiet, undefined);
    assert.equal(first.answer.sources.length, 2); assert.match(first.answer.text, /\[S3\].*\[S2\]/u);
    assert.equal(e.store.proactiveTick(noon + 86400000, true), 1);
    service.start(); await service.idle();
    const second = e.store.page().turns.at(-1);
    assert.equal(second.origin, 'proactive'); assert.equal(second.answer.quiet, true);
    assert.equal(e.store.page().turns.filter(turn => turn.origin === 'proactive').length, 2);
    assert.equal(fake.counts().calendarCount, 3);
    assert.equal(e.store.proactiveTick(noon + 86400000, true), 0);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const citeSaved of [true, false]) test(`proactive citation freshness follows verified saved evidence alongside Google: ${citeSaved}`, async () => {
  const e = environment(); const fake = await googleServer(); const device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const seq = e.store.submit(device.id, randomUUID(), '분석 문서를 보관해줘.').seq; e.store.claim();
  const evidence = { id: 'S1', source: 'saved fixture', path: 'supplier.txt', sha256: 'a'.repeat(64), observed_at: '2026-10-01T00:00:00Z' };
  const cp = new ConversationAssistant({}, noSources).checkpoint();
  cp.history = [{ role: 'user', content: '분석 문서를 보관해줘.' }, { role: 'assistant', content: 'Saved document. Use read_document.' }];
  cp.evidence = [evidence]; cp.nextEvidence = 2;
  const document = e.store.prepareDocument(seq, { title: '이전 분석', format: 'text', based_on: null });
  e.store.finish(seq, { text: '당시 납기는 미정입니다. [S1]', sources: [evidence] }, cp, [], document);
  let calls = 0;
  const model = { async chat() {
    return ++calls === 1 ? reply('', [callTool('read_document', { id: seq }), callTool('list_upcoming_events'), callTool('list_recent_emails')])
      : reply(citeSaved ? '저장된 분석에는 당시 납기가 미정이라고 되어 있어요 [S1]. 다가오는 일정에서 납기를 확인하면 좋겠어요 [S2].'
        : '현재 확인한 일정의 미팅 전에 질문 목록을 준비하면 좋겠어요 [S2].');
  } };
  const service = new ContactService(e.store, model, { ...noSources, verify: async () => { throw Error('UNAUTHORIZED_EXTERNAL_READ'); } });
  const connection = makeConnection(e.store, service, fake);
  const noon = Date.parse('2026-10-08T03:00:00Z');
  try {
    e.store.configureProactive(device.id, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', noon);
    assert.equal(e.store.proactiveTick(noon, true), 1); service.start(); await service.idle();
    const turn = e.store.page().turns.at(-1);
    assert.equal(turn.state, 'answered'); assert.equal(turn.answer.verification, citeSaved ? 'saved_document_sources_checked' : 'cited_sources_rechecked');
    assert.equal(turn.answer.sources.length, citeSaved ? 2 : 1); assert.equal(calls, 2);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const action of ['disconnect', 'first_connect', 'reconnect']) test(`actual native scheduled review survives unrelated Google ${action} and commits its verified result`, {
  skip: process.env.TADA_TEST_READ_BROKER ? false : 'Set TADA_TEST_READ_BROKER to the compiled Rust read broker for this integration test',
}, async () => {
  const e = environment(), fake = await googleServer(), owner = e.store.addDevice('Owner');
  const notes = join(e.root, 'notes'); mkdirSync(notes); const text = '검토할 원문: 준비 자료를 확인해 주세요.';
  writeFileSync(join(notes, 'report.txt'), text);
  const native = new NativeSources(process.env.TADA_TEST_READ_BROKER, [notes]); await native.initialize(new AbortController().signal);
  const prior = action === 'first_connect' ? null : makeCredential(owner.id);
  if (prior) e.store.saveGoogleCredential(owner.id, prior, null);
  const requestText = '보고서를 다시 확인할 일로 기억해 줘.', due = Date.now() + 3600000;
  const seq = e.store.submit(owner.id, randomUUID(), requestText).seq; e.store.claim();
  const proposal = randomUUID(), spec = { operation_id: 'review_report', target: null, expected_version: 0,
    title: '보고서 확인', details: '현재 보고서를 읽고 준비할 내용을 정리하기', state: 'open', waiting_for: null,
    notify_at: new Date(due).toISOString().replace(/\.\d{3}Z$/u, 'Z'), user_quote: requestText };
  e.store.finish(seq, { text: '확인할 업무를 제안했어요.', sources: [] }, new ConversationAssistant({}, noSources).checkpoint(),
    [{ id: proposal, spec, timezone: 'Asia/Seoul' }]);
  const work = e.store.confirmFollowup(owner.id, proposal, 'approve');
  e.store.armReview(owner.id, work.commitment, work.version, 'one_local_read_only_review');
  assert.equal(e.store.reviewTick(due), 1);
  let phase = 0, signal, release, ready; const reviewing = new Promise(resolve => { ready = resolve; });
  const model = { chat: async (messages, tools, currentSignal) => {
    assert.deepEqual(tools.map(tool => tool.function.name), ['list_sources', 'list_files', 'read_file']);
    assert.match(messages[0].content, /ONE-TIME scheduled local read-only review/u);
    if (phase++ === 0) return reply('', [callTool('list_sources')]);
    if (phase === 2) return reply('', [callTool('list_files', { source: 's1', directory: '.' })]);
    if (phase === 3) return reply('', [callTool('read_file', { source: 's1', path: 'report.txt' })]);
    const file = JSON.parse(messages.findLast(message => message.tool_name === 'read_file').content);
    assert.equal(file.content, text); assert.equal(file.evidence_id, 'S1'); signal = currentSignal;
    return new Promise(resolve => { release = resolve; ready(); });
  } };
  const service = new ContactService(e.store, model, native); let opened;
  const connection = makeConnection(e.store, service, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    service.start(); await reviewing;
    if (action === 'disconnect') assert.equal((await service.disconnectGoogle(owner.id)).local_removed, true);
    else {
      await service.connectGoogle(owner.id, 'google_readonly_v1');
      const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
      assert.match(await (await fetch(callback)).text(), /Google 계정 연결 완료/u);
      assert.equal(connection.status().connected, true); assert.notEqual(e.store.googleCredential().epoch, prior?.epoch);
    }
    assert.equal(signal.aborted, false); release(reply('원문을 확인했어요. 다음으로 준비 자료를 정리하세요. [S1]')); await service.idle();
    const result = e.store.reviewState(work.commitment, work.version), saved = e.store.turn(result.turn);
    assert.equal(result.state, 'answered'); assert.equal(saved.state, 'answered'); assert.equal(saved.answer.sources.length, 1);
    assert.equal(saved.answer.sources[0].sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(saved.answer.verification, 'cited_sources_rechecked'); assert.equal(e.store.followup(work.commitment).state, 'open');
    assert.equal(e.store.armReview(owner.id, work.commitment, work.version, 'one_local_read_only_review').state, 'answered');
    assert.equal(fake.counts().inboxCount, 0); assert.equal(fake.counts().calendarCount, 0);
  } finally { release?.(reply('cleanup')); await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const origin of ['normal', 'proactive']) for (const action of ['disconnect', 'reconnect']) test(`${origin} turn with a Google snapshot still stops on ${action}`, async () => {
  const e = environment(), fake = await googleServer(), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  let signal, release, ready; const modelStarted = new Promise(resolve => { ready = resolve; });
  const model = { chat: async (_messages, tools, currentSignal) => {
    assert.ok(tools.some(tool => tool.function.name === 'list_upcoming_events')); signal = currentSignal;
    return new Promise(resolve => { release = resolve; ready(); });
  } };
  const service = new ContactService(e.store, model, noSources); let opened;
  const connection = makeConnection(e.store, service, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    if (origin === 'proactive') {
      const noon = Date.parse('2026-10-08T03:00:00Z');
      e.store.configureProactive(owner.id, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', noon);
      assert.equal(e.store.proactiveTick(noon, true), 1); service.start();
    } else service.submit(owner.id, randomUUID(), '메일과 일정을 정리해줘.');
    await modelStarted; const seq = e.store.page().turns.at(-1).seq;
    if (action === 'disconnect') await service.disconnectGoogle(owner.id);
    else {
      await service.connectGoogle(owner.id, 'google_readonly_v1');
      const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
      assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    }
    assert.equal(signal.aborted, true); release(reply('늦게 도착한 답변')); await service.idle();
    assert.notEqual(e.store.turn(seq).state, 'answered'); assert.equal(e.store.turn(seq).answer, null);
  } finally { release?.(reply('cleanup')); await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('disconnect aborts in-flight Gmail reads and a late model answer cannot be admitted', async () => {
  const e = environment(); const fake = await googleServer({ holdInbox: true }); const device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  let releaseModel;
  let modelCalls = 0;
  const model = { async chat() {
    if (modelCalls++ === 0) return reply('', [callTool('list_recent_emails')]);
    return new Promise(resolve => { releaseModel = resolve; });
  } };
  const service = new ContactService(e.store, model, noSources); const connection = makeConnection(e.store, service, fake);
  try {
    const { seq } = service.submit(device.id, randomUUID(), '지난 메일을 확인해줘.');
    await fake.inboxStarted;
    const disconnected = await service.disconnectGoogle(device.id);
    assert.equal(disconnected.local_removed, true); assert.equal(e.store.googleCredential(), null);
    await fake.inboxClosed; await service.idle();
    assert.equal(e.store.turn(seq).answer, null);
    assert.notEqual(e.store.turn(seq).state, 'answered');
    assert.equal(fake.counts().revokeCount, 1);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }

  const second = environment(); const modelServer = await googleServer(); const owner = second.store.addDevice('Owner');
  second.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  let finish;
  const slowModel = { async chat() { return new Promise(resolve => { finish = resolve; }); } };
  const secondService = new ContactService(second.store, slowModel, noSources); const secondConnection = makeConnection(second.store, secondService, modelServer);
  try {
    const { seq } = secondService.submit(owner.id, randomUUID(), '메일 내용을 정리해줘.');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function');
    await secondService.disconnectGoogle(owner.id);
    finish(reply('늦게 도착한 답변')); await secondService.idle();
    assert.notEqual(second.store.turn(seq).state, 'answered'); assert.equal(second.store.turn(seq).answer, null);
  } finally { await secondService.close(); secondConnection.close(); second.close(); await modelServer.close(); }
});

test('late remote revoke completion cannot cancel a newer unrelated ContactService turn', async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: true }), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  let releaseModel, started; const modelStarted = new Promise(resolve => { started = resolve; });
  const service = new ContactService(e.store, { async chat(_messages, tools) {
    assert.equal(tools.some(tool => tool.function.name === 'list_recent_emails'), false);
    started(); return new Promise(resolve => { releaseModel = resolve; });
  } }, noSources), connection = makeConnection(e.store, service, fake);
  const changes = []; connection.on('change', change => changes.push(change.authorityChanged));
  try {
    const disconnecting = service.disconnectGoogle(owner.id); await fake.revokeStarted;
    assert.equal(e.store.googleCredential(), null); assert.equal(changes.filter(Boolean).length, 1);
    const { seq } = service.submit(owner.id, randomUUID(), '짧게 인사해줘.'); await modelStarted;
    fake.releaseRevoke(); assert.deepEqual(await disconnecting, { local_removed: true, remote_revoked: true });
    assert.equal(changes.filter(Boolean).length, 1);
    releaseModel(reply('안녕하세요.')); await service.idle();
    assert.equal(e.store.turn(seq).state, 'answered'); assert.equal(e.store.turn(seq).answer.text, '안녕하세요.');
  } finally { fake.releaseRevoke(); releaseModel?.(reply('done')); await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('Google reconnect waits for grant-wide revocation before opening OAuth and remains usable afterward', async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: true, grantWideRevocation: true }), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null); let opened, opens = 0;
  let connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; opens++; return true; } });
  try {
    const disconnecting = connection.disconnect(owner.id); await fake.revokeStarted;
    const connecting = connection.connect(owner.id, 'google_readonly_v1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connection.status().pending, true); assert.equal(opens, 0); assert.equal(fake.counts().authorizationCount, 0);
    await assert.rejects(connection.connect(owner.id, 'google_readonly_v1'), /CONTACT_GOOGLE_BUSY/u);
    fake.releaseRevoke(); assert.equal((await disconnecting).remote_revoked, true);
    assert.deepEqual(await connecting, { state: 'waiting' }); assert.equal(opens, 1);
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    const grant = e.store.googleCredential(); assert.equal(connection.status().connected, true);
    assert.equal(e.store.googleDisconnectStatus(), null);
    const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    assert.equal((await connection.apiJson(owner.id, grant.epoch, profile, new AbortController().signal)).emailAddress, 'owner@example.test');
    assert.equal(fake.counts().refreshCount, 1);
    connection.close(); e.reopen(); connection = makeConnection(e.store, null, fake);
    assert.equal(connection.status().last_disconnect, null); assert.equal(e.store.googleDisconnectStatus(), null);
    assert.equal((await connection.apiJson(owner.id, grant.epoch, profile, new AbortController().signal)).emailAddress, 'owner@example.test');
    assert.equal(fake.counts().refreshCount, 2);
    assert.equal(fake.counts().revokeCount, 1); assert.equal(fake.counts().authorizationCount, 1);
  } finally { fake.releaseRevoke(); connection.close(); e.close(); await fake.close(); }
});

test('a queued OAuth attempt canceled before revoke completion never opens a browser or exchanges tokens', async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: true }), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null); let opens = 0;
  const connection = makeConnection(e.store, null, fake, { onOpen: async () => { opens++; return true; } });
  try {
    const disconnecting = connection.disconnect(owner.id); await fake.revokeStarted;
    const connecting = connection.connect(owner.id, 'google_readonly_v1');
    const rejected = assert.rejects(connecting, /CONTACT_GOOGLE_AUTHORITY_CHANGED/u);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(connection.status().pending, true); assert.equal(opens, 0);
    assert.deepEqual(await connection.disconnect(owner.id), { local_removed: true, remote_revoked: null });
    assert.equal(connection.status().pending, false);
    fake.releaseRevoke(); assert.equal((await disconnecting).remote_revoked, true); await rejected;
    assert.equal(opens, 0); assert.equal(fake.counts().authorizationCount, 0); assert.equal(fake.counts().revokeCount, 1);
  } finally { fake.releaseRevoke(); connection.close(); e.close(); await fake.close(); }
});

test('revoke timeout releases queued OAuth with remote uncertainty preserved across restart and no hidden retry', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal); let deadline;
  t.mock.method(AbortSignal, 'timeout', ms => ms === 3000 ? (deadline = new AbortController()).signal : originalTimeout(ms));
  const e = environment(), fake = await googleServer({ holdRevoke: true }), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null); let opens = 0;
  let connection = makeConnection(e.store, null, fake, { onOpen: async () => { opens++; return true; } });
  try {
    const disconnecting = connection.disconnect(owner.id); await fake.revokeStarted; assert.ok(deadline);
    const connecting = connection.connect(owner.id, 'google_readonly_v1');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(opens, 0);
    deadline.abort(new DOMException('Synthetic revoke deadline', 'TimeoutError'));
    assert.deepEqual(await disconnecting, { local_removed: true, remote_revoked: false });
    assert.deepEqual(await connecting, { state: 'waiting' }); assert.equal(opens, 1);
    assert.equal(connection.status().last_disconnect.remote_revoked, false);
    await connection.disconnect(owner.id); assert.equal(connection.status().last_disconnect.remote_revoked, false);
    connection.close(); e.reopen(); connection = makeConnection(e.store, null, fake);
    assert.deepEqual(connection.status().last_disconnect, { local_removed: true, remote_revoked: false });
    assert.equal(e.store.googleCredential(), null);
    assert.equal(JSON.stringify(connection.status()).includes(refreshToken), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.counts().revokeCount, 1); assert.equal(fake.counts().authorizationCount, 0);
  } finally { fake.releaseRevoke(); connection.close(); e.close(); await fake.close(); }
});

test('an interrupted revoke leaves a token-free encrypted receipt and reopening never retries or admits a late completion', async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: true }), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  const first = makeConnection(e.store, null, fake); let resumed;
  try {
    const disconnecting = first.disconnect(owner.id); await fake.revokeStarted;
    assert.equal(e.store.googleCredential(), null);
    assert.deepEqual(e.store.googleDisconnectStatus(), { local_removed: true, remote_revoked: false });
    const db = new DatabaseSync(join(e.directory, 'contact.sqlite'), { readOnly: true });
    try {
      const sealed = db.prepare("SELECT payload FROM assistance_settings WHERE name='google_disconnect'").get().payload;
      assert.equal(sealed.includes(refreshToken), false); assert.equal(sealed.includes(accessToken), false);
      assert.equal(sealed.includes('remote_revoked'), false);
    } finally { db.close(); }
    first.close(); e.reopen(); resumed = makeConnection(e.store, null, fake);
    assert.equal(resumed.status().connected, false); assert.equal(resumed.status().has_credential, false);
    assert.deepEqual(resumed.status().last_disconnect, { local_removed: true, remote_revoked: false });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(fake.counts().revokeCount, 1); assert.equal(fake.counts().refreshCount, 0);
    fake.releaseRevoke(); assert.equal((await disconnecting).remote_revoked, true);
    assert.deepEqual(resumed.status().last_disconnect, { local_removed: true, remote_revoked: false });
    assert.deepEqual(e.store.googleDisconnectStatus(), resumed.status().last_disconnect);
  } finally { fake.releaseRevoke(); first.close(); resumed?.close(); e.close(); await fake.close(); }
});

test('late revoke completion cannot replace a newer credential or a newer removal receipt', async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: true }), owner = e.store.addDevice('Owner');
  const old = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, old, null);
  const connection = makeConnection(e.store, null, fake);
  try {
    const disconnecting = connection.disconnect(owner.id); await fake.revokeStarted;
    const next = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, next, null);
    assert.equal(e.store.googleDisconnectStatus(), null); assert.equal(connection.status().last_disconnect, null);
    assert.equal(e.store.noteGoogleDisconnect(old.epoch, true), false);
    assert.equal(e.store.googleCredential().epoch, next.epoch);
    e.store.clearGoogleCredential(owner.id);
    fake.releaseRevoke(); assert.equal((await disconnecting).remote_revoked, true);
    assert.deepEqual(e.store.googleDisconnectStatus(), { local_removed: true, remote_revoked: false });
    assert.equal(e.store.noteGoogleDisconnect(old.epoch, true), false);
    assert.equal(e.store.noteGoogleDisconnect(next.epoch, true), true);
    assert.deepEqual(e.store.googleDisconnectStatus(), { local_removed: true, remote_revoked: true });
  } finally { fake.releaseRevoke(); connection.close(); e.close(); await fake.close(); }
});

test('credential deletion rolls back if writing the revoke receipt fails', () => {
  const e = environment(), owner = e.store.addDevice('Owner'), grant = makeCredential(owner.id);
  try {
    e.store.saveGoogleCredential(owner.id, grant, null);
    const db = new DatabaseSync(join(e.directory, 'contact.sqlite'));
    try { db.exec("CREATE TRIGGER reject_revoke_receipt BEFORE INSERT ON assistance_settings WHEN NEW.name='google_disconnect' BEGIN SELECT RAISE(ABORT,'fixture receipt rejection'); END;"); }
    finally { db.close(); }
    assert.throws(() => e.store.clearGoogleCredential(owner.id), /CONTACT_STORAGE_FAILED/u);
    e.reopen(); assert.equal(e.store.googleCredential().epoch, grant.epoch); assert.equal(e.store.googleDisconnectStatus(), null);
  } finally { e.close(); }
});

for (const queued of [false, true]) test(`canceling OAuth without credentials preserves an active ordinary ContactService turn: queued=${queued}`, async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: queued }), owner = e.store.addDevice('Owner');
  if (queued) e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  let releaseModel, started, modelSignal, opens = 0;
  const modelStarted = new Promise(resolve => { started = resolve; });
  const service = new ContactService(e.store, { async chat(_messages, tools, signal) {
    assert.equal(tools.some(tool => tool.function.name === 'list_recent_emails'), false);
    modelSignal = signal; started(); return new Promise(resolve => { releaseModel = resolve; });
  } }, noSources), connection = makeConnection(e.store, service, fake, { onOpen: async () => { opens++; return true; } });
  const changes = []; connection.on('change', change => changes.push(change.authorityChanged));
  let disconnecting;
  try {
    if (queued) { disconnecting = service.disconnectGoogle(owner.id); await fake.revokeStarted; }
    const connecting = service.connectGoogle(owner.id, 'google_readonly_v1');
    const connected = queued ? assert.rejects(connecting, /CONTACT_GOOGLE_AUTHORITY_CHANGED/u) : connecting;
    if (!queued) await connected;
    const { seq } = service.submit(owner.id, randomUUID(), '짧게 인사해줘.'); await modelStarted;
    assert.equal(connection.status().pending, true);
    assert.deepEqual(await service.disconnectGoogle(owner.id), { local_removed: true, remote_revoked: null });
    assert.equal(modelSignal.aborted, false); assert.equal(connection.status().pending, false);
    if (queued) { fake.releaseRevoke(); await disconnecting; await connected; }
    assert.equal(changes.filter(Boolean).length, queued ? 1 : 0); assert.equal(opens, queued ? 0 : 1);
    releaseModel(reply('안녕하세요.')); await service.idle();
    assert.equal(e.store.turn(seq).state, 'answered'); assert.equal(e.store.turn(seq).answer.text, '안녕하세요.');
  } finally { fake.releaseRevoke(); releaseModel?.(reply('done')); await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('a completed revoke cannot overwrite a queued OAuth permission error', async () => {
  const e = environment(), fake = await googleServer({ holdRevoke: true, wrongScope: true }), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null); let opened;
  const connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    const disconnecting = connection.disconnect(owner.id); await fake.revokeStarted;
    const connecting = connection.connect(owner.id, 'google_readonly_v1');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, undefined);
    fake.releaseRevoke(); assert.equal((await disconnecting).remote_revoked, true);
    await connecting; assert.equal(connection.status().last_disconnect, null);
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    assert.equal(connection.status().error, 'permission_denied');
    assert.equal(connection.status().error, 'permission_denied'); assert.equal(connection.status().last_disconnect, null);
    assert.equal(e.store.googleCredential(), null);
  } finally { fake.releaseRevoke(); connection.close(); e.close(); await fake.close(); }
});

test('refresh scope reduction persists permission/reconnect state and blocks reads until a new successful connection', async () => {
  const e = environment(), fake = await googleServer({ wrongRefreshScope: true }), owner = e.store.addDevice('Owner');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null);
  let connection = makeConnection(e.store, null, fake), opened; const signal = new AbortController().signal;
  const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  try {
    await assert.rejects(connection.apiJson(owner.id, grant.epoch, profile, signal), /CONTACT_GOOGLE_SCOPE_DENIED/u);
    let status = connection.status(); assert.equal(status.connected, false); assert.equal(status.state, 'reconnect_required');
    assert.equal(status.error, 'permission_denied'); assert.equal(e.store.googleCredential().reconnect_required, true);
    assert.equal(e.store.googleConnected(), false); assert.equal(connection.captureGrant(owner.id).connected, false);
    const count = fake.requests.length;
    await assert.rejects(connection.apiJson(owner.id, grant.epoch, profile, signal), /CONTACT_GOOGLE_RECONNECT_REQUIRED/u);
    assert.equal(fake.requests.length, count); assert.equal(fake.counts().profileCount, 0);
    connection.close(); e.reopen();
    connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; return true; } });
    status = connection.status(); assert.equal(status.connected, false); assert.equal(status.error, 'permission_denied');
    await assert.rejects(connection.apiJson(owner.id, grant.epoch, profile, signal), /CONTACT_GOOGLE_RECONNECT_REQUIRED/u);
    assert.equal(fake.requests.length, count);
    fake.restoreRefreshScopes(); await connection.connect(owner.id, 'google_readonly_v1');
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    const newGrant = e.store.googleCredential(); assert.notEqual(newGrant.epoch, grant.epoch);
    assert.equal(connection.status().connected, true); assert.equal(connection.status().error, null);
    assert.equal((await connection.apiJson(owner.id, newGrant.epoch, profile, signal)).emailAddress, 'owner@example.test');
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const stage of ['refresh', 'api']) for (const cause of ['timeout', 'caller', 'epoch']) test(`${stage} ${cause} distinguishes temporary failure from authority cancellation without stale status writes`, async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal); let deadline;
  t.mock.method(AbortSignal, 'timeout', ms => ms === (stage === 'refresh' ? 12000 : 10000)
    ? (deadline = new AbortController()).signal : originalTimeout(ms));
  const e = environment(), fake = await googleServer({ holdRefresh: stage === 'refresh', holdInbox: stage === 'api' }), owner = e.store.addDevice('Owner');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null);
  const connection = makeConnection(e.store, null, fake), caller = new AbortController();
  const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  const inbox = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages'), now = Math.floor(Date.now() / 1000);
  inbox.searchParams.set('q', `in:inbox after:${now - 7 * 86400} before:${now}`); inbox.searchParams.set('maxResults', '20');
  try {
    const pending = connection.apiJson(owner.id, grant.epoch, stage === 'refresh' ? profile : inbox, caller.signal);
    const rejected = assert.rejects(pending, cause === 'timeout' ? /CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE/u : /CONTACT_GOOGLE_AUTHORITY_CHANGED/u);
    await (stage === 'refresh' ? fake.refreshStarted : fake.inboxStarted); assert.ok(deadline);
    let replacement;
    if (cause === 'timeout') deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
    else if (cause === 'caller') caller.abort();
    else {
      const disconnecting = connection.disconnect(owner.id);
      replacement = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, replacement, null);
      await disconnecting;
    }
    await rejected;
    // Canceling a read leaves account refresh available to other current reads.
    if (stage === 'refresh' && cause === 'caller') fake.resumeRefresh();
    await (stage === 'refresh' ? fake.refreshClosed : fake.inboxClosed);
    const current = e.store.googleCredential();
    assert.equal(current.epoch, replacement?.epoch ?? grant.epoch);
    assert.equal(current.last_error, cause === 'timeout' ? 'temporarily_unavailable' : null);
    assert.equal(current.reconnect_required, false); assert.equal(connection.status().connected, true);
    if (replacement) assert.equal(current.last_checked, null);
    if (cause === 'timeout') {
      assert.equal(fake.counts().refreshCount, 1); fake.resumeRefresh();
      assert.equal((await connection.apiJson(owner.id, grant.epoch, profile, new AbortController().signal)).emailAddress, 'owner@example.test');
      assert.equal(connection.status().error, null);
    }
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const [stage, kind] of [['refresh', 'invalid'], ['refresh', 'limit'], ['api', 'invalid'], ['api', 'limit']]) test(`${stage} upstream response ${kind} preserves its diagnostic and records a temporary recovery state`, async () => {
  const e = environment(), fake = await googleServer({ malformedRefresh: stage === 'refresh' && kind === 'invalid',
    oversizedRefresh: stage === 'refresh' && kind === 'limit', malformedProfile: stage === 'api' && kind === 'invalid' }), owner = e.store.addDevice('Owner');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null);
  const connection = makeConnection(e.store, null, fake);
  try {
    await assert.rejects(connection.apiJson(owner.id, grant.epoch, new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile'),
      new AbortController().signal, stage === 'api' && kind === 'limit' ? 10 : 65536),
    kind === 'invalid' ? /CONTACT_GOOGLE_RESPONSE_INVALID/u : /CONTACT_GOOGLE_RESPONSE_LIMIT/u);
    assert.equal(e.store.googleCredential().last_error, 'temporarily_unavailable'); assert.equal(connection.status().error, 'temporarily_unavailable');
    assert.equal(connection.status().connected, true); assert.equal(e.store.googleCredential().reconnect_required, false);
  } finally { connection.close(); e.close(); await fake.close(); }
});

test('non-object Google JSON cannot issue list evidence or advance a successful check; genuine empty objects and arrays remain valid', async () => {
  const e = environment(), responses = {}, fake = await googleServer({ responses }), owner = e.store.addDevice('Owner');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null); let now = Date.now();
  const connection = makeConnection(e.store, null, fake, { clock: () => now }), signal = new AbortController().signal;
  const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  e.store.submit(owner.id, randomUUID(), '최근 메일과 일정을 확인해줘.');
  const sources = new GoogleSources(noSources, e.store, connection, e.store.claim());
  try {
    await connection.apiJson(owner.id, grant.epoch, profile, signal); const checked = e.store.googleCredential().last_checked;
    for (const value of [[], 'not an object', 42, true, false, null]) {
      now += 1000; responses.inbox = responses.calendar = { value };
      for (const name of ['list_recent_emails', 'list_upcoming_events']) await assert.rejects(sources.execute(name, {}, signal), /CONTACT_GOOGLE_RESPONSE_INVALID/u);
      const current = e.store.googleCredential();
      assert.equal(current.last_checked, checked); assert.equal(current.last_error, 'temporarily_unavailable');
      assert.equal(current.epoch, grant.epoch); assert.equal(current.reconnect_required, false);
      const before = fake.requests.length;
      assert.equal(await sources.verify({ source: 'Gmail (owner@example.test)', path: 'inbox?from=1&to=2', sha256: '0'.repeat(64) }, signal), false);
      assert.equal(fake.requests.length, before);
    }
    responses.inbox = responses.calendar = { value: {} }; now += 1000;
    const inbox = await sources.execute('list_recent_emails', {}, signal), events = await sources.execute('list_upcoming_events', {}, signal);
    assert.deepEqual(JSON.parse(inbox.content).emails, []); assert.deepEqual(JSON.parse(events.content).events, []);
    assert.equal(await sources.verify(evidenceOf(inbox), signal), true); assert.equal(await sources.verify(evidenceOf(events), signal), true);
    responses.inbox = { value: { messages: [] } }; responses.calendar = { value: { items: [] } };
    assert.equal(await sources.verify(evidenceOf(inbox), signal), true); assert.equal(await sources.verify(evidenceOf(events), signal), true);
    assert.equal(e.store.googleCredential().last_checked, now); assert.equal(connection.status().error, null);
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const invalid of [true, false]) test(`actual conversation ${invalid ? 'rejects malformed JSON as verified empty lists' : 'accepts genuine empty lists with verified evidence'}`, async () => {
  const e = environment(), fake = await googleServer({ responses: { inbox: { value: invalid ? [] : {} }, calendar: { value: invalid ? null : { items: [] } } } }), owner = e.store.addDevice('Owner');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null); let calls = 0;
  const model = { chat: async messages => {
    if (++calls === 1) return reply('', [callTool('list_recent_emails'), callTool('list_upcoming_events')]);
    for (const name of ['list_recent_emails', 'list_upcoming_events']) {
      const output = JSON.parse(messages.findLast(message => message.tool_name === name).content);
      if (invalid) { assert.deepEqual(output, { error: 'CONTACT_GOOGLE_RESPONSE_INVALID', performed: false }); }
      else { assert.match(output.evidence_id, /^S[12]$/u); assert.deepEqual(JSON.parse(output.content)[name === 'list_recent_emails' ? 'emails' : 'events'], []); }
    }
    return reply('확인한 범위에 메일과 일정이 없어요. [S1] [S2]');
  } };
  const service = new ContactService(e.store, model, noSources), connection = makeConnection(e.store, service, fake);
  try {
    const { seq } = service.submit(owner.id, randomUUID(), '최근 메일과 다가오는 일정을 확인해줘.'); await service.idle();
    const turn = e.store.turn(seq);
    if (invalid) {
      assert.equal(turn.state, 'failed'); assert.equal(turn.error, 'ASSISTANT_UNGROUNDED_ANSWER'); assert.equal(turn.answer, null);
      assert.equal(connection.status().error, 'temporarily_unavailable'); assert.equal(calls, 3);
    } else {
      assert.equal(turn.state, 'answered'); assert.equal(turn.answer.verification, 'cited_sources_rechecked');
      assert.equal(turn.answer.sources.length, 2); assert.equal(calls, 2);
    }
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const cause of ['caller', 'epoch']) test(`late malformed API body after ${cause} cancellation cannot write stale temporary status`, async () => {
  const e = environment(), responses = {}, fake = await googleServer({ responses }), owner = e.store.addDevice('Owner');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null);
  let defer = false, release, started; const bodyStarted = new Promise(resolve => { started = resolve; });
  const fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (!defer || new URL(url).pathname !== '/gmail/v1/users/me/profile') return response;
    const payload = await response.arrayBuffer();
    return new Response(new ReadableStream({ pull(controller) {
      return new Promise(resolve => { release = () => { release = null; controller.enqueue(new Uint8Array(payload)); controller.close(); resolve(); }; started(); });
    } }, { highWaterMark: 0 }),
      { status: response.status, headers: response.headers });
  };
  const connection = makeConnection(e.store, null, fake, { fetchImpl }), caller = new AbortController();
  const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  try {
    await connection.apiJson(owner.id, grant.epoch, profile, caller.signal);
    const prior = e.store.googleCredential(); defer = true; responses.profile = { value: [] };
    const pending = connection.apiJson(owner.id, grant.epoch, profile, caller.signal);
    const rejected = assert.rejects(pending, /CONTACT_GOOGLE_AUTHORITY_CHANGED/u); await bodyStarted;
    let replacement;
    if (cause === 'caller') caller.abort();
    else { e.store.clearGoogleCredential(owner.id); replacement = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, replacement, null); }
    release(); await rejected;
    assert.deepEqual(e.store.googleCredential(), replacement ?? prior); assert.equal(connection.status().error, null);
  } finally { release?.(); connection.close(); e.close(); await fake.close(); }
});

for (const reconnect of [false, true]) test(`profile HTTP 403 before body parsing reports permission denial and ${reconnect ? 'preserves the previous grant' : 'saves no new credentials'}`, async () => {
  const e = environment(), fake = await googleServer({ responses: { profile: { status: 403, raw: 'not JSON' } } }), owner = e.store.addDevice('Owner');
  const prior = reconnect ? makeCredential(owner.id) : null;
  if (prior) e.store.saveGoogleCredential(owner.id, prior, null);
  let opened; const connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    await connection.connect(owner.id, 'google_readonly_v1');
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.match(await (await fetch(callback)).text(), /Google 계정 연결을 마치지 못했어요/u);
    assert.equal(connection.status().error, 'permission_denied'); assert.equal(connection.status().connected, reconnect);
    assert.equal(fake.counts().authorizationCount, 1); assert.equal(fake.counts().profileCount, 1);
    const current = e.store.googleCredential();
    if (prior) {
      for (const field of ['epoch', 'email', 'refresh_token', 'scopes', 'connected_at']) assert.deepEqual(current[field], prior[field]);
      assert.equal(current.reconnect_required, false); assert.equal(current.last_error, 'permission_denied'); assert.equal(e.store.googleConnected(), true);
    } else assert.equal(current, null);
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const stage of ['authorization', 'profile']) test(`${stage} malformed top-level JSON cannot create a Google credential`, async () => {
  const e = environment(), fake = await googleServer({ responses: { [stage]: { value: [] } } }), owner = e.store.addDevice('Owner');
  let opened; const connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    await connection.connect(owner.id, 'google_readonly_v1');
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    assert.equal(e.store.googleCredential(), null); assert.equal(connection.status().error, 'temporarily_unavailable');
    assert.equal(fake.counts().profileCount, stage === 'authorization' ? 0 : 1);
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const status of [401, 503]) test(`profile HTTP ${status} keeps temporary recovery semantics and saves no credentials`, async () => {
  const e = environment(), fake = await googleServer({ responses: { profile: { status, value: { error: 'synthetic failure' } } } }), owner = e.store.addDevice('Owner');
  let opened; const connection = makeConnection(e.store, null, fake, { onOpen: async url => { opened = url; return true; } });
  try {
    await connection.connect(owner.id, 'google_readonly_v1');
    const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic_code');
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303);
    assert.equal(e.store.googleCredential(), null); assert.equal(connection.status().error, 'temporarily_unavailable');
  } finally { connection.close(); e.close(); await fake.close(); }
});

test('credential validators reject unknown fields/missing scopes; refresh is singleflight and resumes after encrypted-store restart', async () => {
  const e = environment(); const fake = await googleServer(); const device = e.store.addDevice('Owner');
  const grant = makeCredential(device.id);
  assert.equal(validGoogleCredential(grant), true);
  assert.equal(validGoogleCredential({ ...grant, unexpected: true }), false);
  assert.equal(validGoogleCredential({ ...grant, scopes: [GOOGLE_SCOPES[0]] }), false);
  const receipt = { version: 1, epoch: grant.epoch, remote_revoked: false };
  assert.equal(validGoogleDisconnect(receipt), true); assert.equal(validGoogleDisconnect({ ...receipt, remote_revoked: true }), true);
  assert.equal(validGoogleDisconnect({ ...receipt, refresh_token: refreshToken }), false);
  assert.equal(validGoogleDisconnect({ ...receipt, remote_revoked: 'false' }), false);
  assert.equal(validGoogleDisconnect({ ...receipt, version: 2 }), false);
  e.store.saveGoogleCredential(device.id, grant, null);
  const first = makeConnection(e.store, null, fake); const signal = new AbortController().signal;
  const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  const calendar = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  const now = Date.now();
  for (const [key, value] of Object.entries({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86400000).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '20' })) calendar.searchParams.set(key, value);
  try {
    await Promise.all([first.apiJson(device.id, grant.epoch, profile, signal, 65536), first.apiJson(device.id, grant.epoch, calendar, signal, 65536)]);
    assert.equal(fake.counts().refreshCount, 1);
    const raw = readFileSync(join(e.directory, 'contact.sqlite'));
    assert.equal(raw.includes(Buffer.from(refreshToken)), false);
    first.close(); e.reopen();
    const restored = makeConnection(e.store, null, fake);
    try {
      const current = e.store.googleCredential();
      await restored.apiJson(device.id, current.epoch, profile, signal, 65536);
      assert.equal(fake.counts().refreshCount, 2);
      assert.equal(restored.status().connected, true);
    } finally { restored.close(); }
  } finally { first.close(); e.close(); await fake.close(); }
});

test('the default unconnected Google adapter preserves permitted native file citations', async () => {
  const e = environment(), notes = join(e.root, 'notes'); mkdirSync(notes); writeFileSync(join(notes, 'brief.txt'), '미팅 준비 정보입니다.');
  const device = e.store.addDevice('Owner');
  const native = process.env.TADA_TEST_READ_BROKER ? new NativeSources(process.env.TADA_TEST_READ_BROKER, [notes]) : {
    definitions: discoveryTools,
    validate: (name, args) => validCall(name, args) && (name === 'list_sources' || args.source === 's1'),
    async execute(name) {
      if (name === 'list_sources') return { sources: [{ source: 's1', label: 'permitted fixture notes' }] };
      if (name === 'list_files') return { source: 's1', files: ['brief.txt'] };
      const content = readFileSync(join(notes, 'brief.txt'), 'utf8');
      return { source: 's1', path: 'brief.txt', content, sha256: createHash('sha256').update(content).digest('hex'), observed_at: new Date().toISOString() };
    },
    async verify(evidence) { return evidence.sha256 === (await this.execute('read_file')).sha256; },
  };
  if (native.initialize) await native.initialize(new AbortController().signal);
  let phase = 0, checks = 0; const verify = native.verify.bind(native);
  native.verify = async (...args) => { checks++; return verify(...args); };
  const model = { chat: async () => [reply('', [callTool('list_sources')]), reply('', [callTool('list_files', { source: 's1', directory: '.' })]),
    reply('', [callTool('read_file', { source: 's1', path: 'brief.txt' })]), reply('미팅 준비 정보입니다. [S1]')][phase++] };
  const service = new ContactService(e.store, model, native), connection = new GoogleConnection({ store: e.store }); service.attachGoogle(connection);
  try {
    const { seq } = service.submit(device.id, randomUUID(), '허용된 메모에서 미팅 정보를 찾아줘.'); await service.idle();
    assert.equal(connection.status().configured, false); assert.equal(e.store.turn(seq).state, 'answered');
    assert.equal(e.store.turn(seq).answer.verification, 'cited_sources_rechecked'); assert.equal(checks, 1);
  } finally { await service.close(); connection.close(); e.close(); }
});

test('a proactive old native checkpoint cannot cause fresh filesystem verification without reading a saved document', async () => {
  const e = environment(), fake = await googleServer(), device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  const seq = e.store.submit(device.id, randomUUID(), '이전 분석을 확인해줘.').seq; e.store.claim();
  const evidence = { id: 'S1', source: 's1', path: 'brief.txt', sha256: 'a'.repeat(64), observed_at: '2026-10-01T00:00:00Z' };
  const cp = new ConversationAssistant({}, noSources).checkpoint();
  cp.history = [{ role: 'user', content: '이전 분석을 확인해줘.' }, { role: 'assistant', content: '이전 분석입니다. [S1]' }];
  cp.evidence = [evidence]; cp.nextEvidence = 2;
  e.store.finish(seq, { text: '이전 분석입니다. [S1]', sources: [evidence] }, cp);
  let nativeChecks = 0;
  const service = new ContactService(e.store, { chat: async () => reply('이전 분석에서 다음 할 일이 보입니다. [S1]') },
    { ...noSources, verify: async () => { nativeChecks++; return true; } });
  const connection = makeConnection(e.store, service, fake), noon = Date.parse('2026-10-08T03:00:00Z');
  try {
    e.store.configureProactive(device.id, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', noon);
    assert.equal(e.store.proactiveTick(noon, true), 1); service.start(); await service.idle();
    const turn = e.store.page().turns.at(-1);
    assert.equal(turn.state, 'failed'); assert.equal(turn.answer, null);
    assert.equal(nativeChecks, 0); assert.equal(fake.requests.length, 0);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const connected of [false, true]) test(`revoking an unused spare device preserves another device's active answer: Google connected=${connected}`, async () => {
  const e = environment(), fake = await googleServer(), owner = e.store.addDevice('Owner'), spare = e.store.addDevice('Spare');
  if (connected) e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  let finish, begin; const started = new Promise(resolve => { begin = resolve; });
  const service = new ContactService(e.store, { chat: async () => { begin(); return new Promise(resolve => { finish = resolve; }); } }, noSources);
  const connection = connected ? makeConnection(e.store, service, fake) : new GoogleConnection({ store: e.store });
  if (!connected) service.attachGoogle(connection);
  try {
    const { seq } = service.submit(owner.id, randomUUID(), '인사해줘.'); await started;
    service.revoke(spare.id); finish(reply('안녕하세요.')); await service.idle();
    assert.equal(e.store.turn(seq).state, 'answered'); assert.equal(e.store.turn(seq).answer.text, '안녕하세요.');
    assert.throws(() => e.store.assertDevice(spare.id), /DEVICE_REVOKED/u);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('persisted or unissued Google evidence cannot fetch historical ranges; a body requires current inbox membership and date', async () => {
  const e = environment(), fake = await googleServer(), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  const connection = makeConnection(e.store, null, fake), seq = e.store.submit(owner.id, randomUUID(), '최근 자료를 확인해줘.').seq;
  const job = e.store.claim(); assert.equal(job.seq, seq);
  const sources = new GoogleSources(noSources, e.store, connection, job), signal = new AbortController().signal;
  const old = Date.now() - 30 * 86400000, from = Math.floor(old / 1000), to = from + 7 * 86400;
  try {
    const oldPaths = [
      ['Gmail (owner@example.test)', `inbox?from=${from}&to=${to}`],
      ['Gmail (owner@example.test)', 'messages/m1?body_bytes=4096'],
      ['Google Calendar (owner@example.test)', `primary/events?from=${encodeURIComponent(new Date(old).toISOString())}&to=${encodeURIComponent(new Date(old + 7 * 86400000).toISOString())}`],
    ];
    for (const [source, path] of oldPaths) assert.equal(await sources.verify({ id: 'S1', source, path, sha256: 'a'.repeat(64), observed_at: new Date(old).toISOString() }, signal), false);
    assert.equal(fake.requests.length, 0);
    const inbox = await sources.execute('list_recent_emails', {}, signal);
    const currentEvidence = { id: 'S1', source: inbox.source, path: inbox.path, sha256: inbox.sha256, observed_at: inbox.observed_at };
    assert.equal(await sources.verify(currentEvidence, signal), true);
    const laterTurn = new GoogleSources(noSources, e.store, connection, job), before = fake.requests.length;
    assert.equal(await laterTurn.verify(currentEvidence, signal), false); assert.equal(fake.requests.length, before);
    fake.removeInboxId('m1');
    await assert.rejects(sources.execute('read_email', { id: 'm1' }, signal), /SOURCE_STALE/u);
    assert.equal(fake.requests.some(item => item.path.endsWith('/messages/m1') && item.query.includes('format=full')), false);
    const email = await sources.execute('read_email', { id: 'm2' }, signal);
    const fullCount = fake.requests.filter(item => item.query.includes('format=full')).length;
    fake.ageEmails();
    assert.equal(await sources.verify({ id: 'S2', source: email.source, path: email.path, sha256: email.sha256, observed_at: email.observed_at }, signal), false);
    assert.equal(fake.requests.filter(item => item.query.includes('format=full')).length, fullCount);
  } finally { connection.close(); e.close(); await fake.close(); }
});

test('metadata that has left INBOX is omitted before its private fields can enter a list or body result', async () => {
  const mailContent = { headers: [{ name: 'Subject', value: 'ARCHIVED_PRIVATE_SUBJECT' }], metadataLabels: ['IMPORTANT'] };
  await withGoogleSources({ mailContent }, async ({ sources, signal, fake }) => {
    const list = await sources.execute('list_recent_emails', {}, signal), data = JSON.parse(list.content);
    assert.deepEqual(data.emails, []); assert.equal(data.truncated, true);
    assert.equal(JSON.stringify(list).includes('ARCHIVED_PRIVATE_SUBJECT'), false);
    assert.equal(sources.validate('read_email', { id: 'm1' }), false);
    assert.equal(fake.requests.some(item => item.query.includes('format=full')), false);
  });
  delete mailContent.metadataLabels;
  await withGoogleSources({ mailContent }, async ({ sources, signal, fake }) => {
    await sources.execute('list_recent_emails', {}, signal);
    mailContent.metadataLabels = [];
    await assert.rejects(sources.execute('read_email', { id: 'm1' }, signal), /CONTACT_GOOGLE_SOURCE_STALE/u);
    assert.equal(fake.requests.some(item => item.query.includes('format=full')), false);
  });
});

test('full-message INBOX/date races fail before private body admission and reverification rejects an archived message', async () => {
  for (const changed of [{ fullLabels: [] }, { fullLabels: null }, { fullLabels: undefined },
    { fullInternalDate: String(Date.now() - 30 * 86400000) }]) {
    const mailContent = { payload: textPart(Buffer.from('OUT_OF_SCOPE_BODY')), ...changed };
    await withGoogleSources({ mailContent }, async ({ sources, signal, fake }) => {
      const list = await sources.execute('list_recent_emails', {}, signal);
      await assert.rejects(sources.execute('read_email', { id: 'm1' }, signal), /CONTACT_GOOGLE_SOURCE_STALE/u);
      const before = fake.requests.length;
      assert.equal(await sources.verify({ ...evidenceOf(list), path: 'messages/m1?body_bytes=4096' }, signal), false);
      assert.equal(fake.requests.length, before);
    });
  }
  const mailContent = { payload: textPart(Buffer.from('Still in inbox')) };
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    await sources.execute('list_recent_emails', {}, signal); const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(await sources.verify(evidenceOf(email), signal), true);
    mailContent.fullLabels = ['IMPORTANT']; assert.equal(await sources.verify(evidenceOf(email), signal), false);
  });
});

test('an archive race returns a bounded tool error without sending the raced body to the model', async () => {
  const e = environment(), mailContent = { payload: textPart(Buffer.from('OUT_OF_SCOPE_BODY')) }, fake = await googleServer({ mailContent }), device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  let phase = 0;
  const model = { async chat(messages) {
    assert.equal(JSON.stringify(messages).includes('OUT_OF_SCOPE_BODY'), false);
    if (phase++ === 0) return reply('', [callTool('list_recent_emails')]);
    if (phase === 2) { mailContent.fullLabels = []; return reply('', [callTool('read_email', { id: 'm1' })]); }
    assert.deepEqual(JSON.parse(messages.findLast(message => message.tool_name === 'read_email').content),
      { error: 'CONTACT_GOOGLE_SOURCE_STALE', performed: false });
    return reply('받은편지함 목록을 확인했어요. [S1] 선택한 메일 본문은 현재 범위에서 확인하지 못했습니다.');
  } };
  const service = new ContactService(e.store, model, noSources), connection = makeConnection(e.store, service, fake);
  try {
    const { seq } = service.submit(device.id, randomUUID(), '최근 메일 내용을 확인해줘.'); await service.idle();
    const turn = e.store.turn(seq); assert.equal(turn.state, 'answered', JSON.stringify(turn)); assert.equal(turn.answer.sources.length, 1);
    assert.equal(e.store.checkpoint().value.nextEvidence, 2);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

for (const measure of ['normalized', 'subscription']) test(`a long-history email/calendar batch reserves its actual failure response in ${measure} context`, async () => {
  const native = new NativeSources(process.execPath, []); await native.initialize(new AbortController().signal);
  const subscription = new ChatGPTSubscription({ account: {}, model: 'synthetic-fixture-model' }), measured = [];
  const actualBytes = (messages, tools) => measure === 'subscription' ? subscription.contextBytes(messages, tools)
    : Buffer.byteLength(JSON.stringify({ messages, tools }));
  const mailContent = { payload: textPart(Buffer.from('A'.repeat(10000))) };
  await withGoogleSources({ mailContent }, async ({ sources }) => {
    let phase = 0;
    const model = { async chat(messages, tools) {
      measured.push(actualBytes(messages, tools)); assert.ok(measured.at(-1) <= 14000);
      if (phase++ === 0) return reply('', [callTool('list_recent_emails')]);
      if (phase === 2) return reply('', [callTool('read_email', { id: 'm1' }), callTool('list_upcoming_events')]);
      const read = JSON.parse(messages.findLast(message => message.tool_name === 'read_email').content);
      const calendar = JSON.parse(messages.findLast(message => message.tool_name === 'list_upcoming_events').content);
      assert.equal(read.error, undefined); assert.equal(read.evidence_id, 'S2'); assert.equal(read.truncated, true);
      assert.equal(calendar.error, 'CONTACT_GOOGLE_CONTEXT_LIMIT'); assert.equal(calendar.performed, false);
      return reply('메일에서 준비 내용을 확인했어요. [S2] 일정은 이번 답변에서 확인하지 못했어요.');
    } };
    if (measure === 'subscription') model.contextBytes = actualBytes;
    const assistant = new ConversationAssistant(model, sources), checkpoint = assistant.checkpoint();
    checkpoint.history = [{ role: 'user', content: 'Prior discussion' }, { role: 'assistant', content: 'Z'.repeat(3500) }]; assistant.restore(checkpoint);
    const answer = await assistant.ask('Prepare for the meeting using the recent email and calendar.');
    assert.equal(answer.sources.length, 1); assert.equal(answer.sources[0].id, 'S2');
    assert.equal(measured.length, 3); assert.ok(measured.at(-1) > 13900, JSON.stringify(measured));
  }, native);
});

test('MIME B/Q headers decode case-insensitive and adjacent words before UTF-8 truncation', async () => {
  const b = value => `=?uTf-8?b?${Buffer.from(value).toString('base64')}?=`;
  const q = value => `=?UTF-8?q?${[...Buffer.from(value)].map(byte => byte === 32 ? '_' : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')}?=`;
  const mailContent = { headers: [{ name: 'From', value: `${b('김비서')} <sender@example.test>` },
    { name: 'Subject', value: `${b('미팅')}\r\n\t${q(' 준비')}` }] };
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    const inbox = JSON.parse((await sources.execute('list_recent_emails', {}, signal)).content);
    assert.equal(inbox.emails[0].from, '김비서 <sender@example.test>'); assert.equal(inbox.emails[0].subject, '미팅 준비');
    const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.match(email.content, /From: 김비서 <sender@example.test>\nFrom addresses \(available\): sender@example.test\nReply-To \(absent\): \nSubject: 미팅 준비/u);
    assert.doesNotMatch(email.content, /=\?|\uFFFD/u); assert.equal(await sources.verify(evidenceOf(email), signal), true);
  });
  mailContent.headers[1].value = Array.from({ length: 30 }, () => b('안녕하세요')).join(' ');
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    const email = JSON.parse((await sources.execute('list_recent_emails', {}, signal)).content).emails[0];
    assert.equal(email.subject, '안녕하세요'.repeat(30).slice(0, 83));
    assert.ok(Buffer.byteLength(email.subject) <= 250); assert.doesNotMatch(email.subject, /=\?|\uFFFD/u);
  });
});

test('unsupported or malformed MIME headers mark only their field unavailable and preserve other inbox data', async () => {
  for (const subject of ['=?X-UNKNOWN?B?SGVsbG8=?=', '=?UTF-8?B?!!!!?=', '=?UTF-8?Q?bad=ZZ?=', '=?UTF-8?B?wyg=?=']) {
    const mailContent = { headers: [{ name: 'From', value: 'Sender <sender@example.test>' }, { name: 'Subject', value: subject }] };
    await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
      const emails = JSON.parse((await sources.execute('list_recent_emails', {}, signal)).content).emails;
      assert.equal(emails.length, 2); assert.equal(emails[0].from, 'Sender <sender@example.test>');
      assert.equal(emails[0].subject, ''); assert.deepEqual(emails[0].unavailable_headers, ['subject']);
      const email = await sources.execute('read_email', { id: 'm1' }, signal);
      assert.deepEqual(email.unavailable_headers, ['subject']); assert.match(email.content, /Unavailable headers: subject/u);
    });
  }
});

for (const [charset, bytes, expected, mimeType = 'text/plain'] of [
  ['UTF-8', Buffer.from('회의를 준비해요🙂'), '회의를 준비해요🙂'],
  ['EUC-KR', Buffer.from('bec8b3e7c7cfbcbcbfe4', 'hex'), '안녕하세요'],
  ['ISO-8859-1', Buffer.from('Réunion au café', 'latin1'), 'Réunion au café'],
  ['ISO-8859-1', Buffer.from('<p>Réunion au café</p><script>do not execute</script>', 'latin1'), 'Réunion au café', 'text/html'],
]) test(`${charset} ${mimeType} mail preserves decoded meaning through evidence verification`, async () => {
  await withGoogleSources({ mailContent: { payload: textPart(bytes, charset, mimeType) } }, async ({ sources, signal }) => {
    await sources.execute('list_recent_emails', {}, signal);
    const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.content.slice(email.content.indexOf('\n\n') + 2).trim(), expected);
    assert.equal(email.body_status, 'available'); assert.equal(email.truncated, false); assert.doesNotMatch(email.content, /\uFFFD/u);
    assert.equal(await sources.verify(evidenceOf(email), signal), true);
  });
});

test('HTML mail preserves text, quoted attributes, entities and breaks while excluding comments and nested active content', async () => {
  const html = `<DIV title="x > y">회의&nbsp;안내 &amp; &#x1F642;<br>금요일</DIV><p>&lt;자료&gt; &quot;확인&quot; &#39;완료&#39;</p>
<!-- SECRET_COMMENT <div>hidden</div> -->
<script/>if (x < y) SECRET_SCRIPT;</script><style/>p{content:"<"} SECRET_STYLE</style>
<noscript/><p>SECRET_NOSCRIPT</p></noscript><iframe/><p>SECRET_IFRAME</p></iframe>
<svg><svg><text>SECRET_SVG_INNER</text></svg><text>SECRET_SVG_OUTER</text></svg><svg/>
<object/><object>SECRET_OBJECT_INNER</object>SECRET_OBJECT_OUTER</object>
<hr><a href="https://example.test">끝</a>`;
  await withGoogleSources({ mailContent: { payload: textPart(Buffer.from(html), 'UTF-8', 'text/html') } }, async ({ sources, signal, fake }) => {
    await sources.execute('list_recent_emails', {}, signal);
    const email = await sources.execute('read_email', { id: 'm1' }, signal), text = email.content.slice(email.content.indexOf('\n\n') + 2);
    assert.match(text, /^회의 안내 & 🙂\n금요일\n<자료> "확인" '완료'/u);
    assert.match(text, /\n\n끝$/u); assert.doesNotMatch(text, /SECRET_|https:/u);
    assert.equal(email.body_status, 'available'); assert.equal(email.truncated, false);
    assert.equal(await sources.verify(evidenceOf(email), signal), true);
    assert.ok(fake.requests.every(item => !item.path.includes('/attachments/')));
  });
});

test('bounded malformed HTML is rejected promptly without evidence and remains unavailable on reverification', async () => {
  for (const html of ['<'.repeat(190000), '<!--'.repeat(45000), '<script>'.repeat(22000), '<div title="' + ' '.repeat(180000)]) {
    const mailContent = { payload: textPart(Buffer.from('<p>Earlier readable body.</p>'), 'UTF-8', 'text/html') };
    await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
      await sources.execute('list_recent_emails', {}, signal);
      const previous = await sources.execute('read_email', { id: 'm1' }, signal);
      mailContent.payload = textPart(Buffer.from(html), 'UTF-8', 'text/html');
      let started = performance.now();
      assert.equal(await sources.verify(evidenceOf(previous), signal), false);
      assert.ok(performance.now() - started < 4000, 'malformed HTML must not block the event loop for seconds');
      started = performance.now();
      await assert.rejects(sources.execute('read_email', { id: 'm2' }, signal), /CONTACT_GOOGLE_BODY_UNAVAILABLE/u);
      assert.ok(performance.now() - started < 4000, 'the second read must also reject promptly without evidence');
    });
  }
});

test('unknown charset, malformed UTF-8 and malformed base64 bodies fail explicitly without issuing empty evidence', async () => {
  const invalid = [textPart(Buffer.from('Some text'), 'X-UNKNOWN'), textPart(Buffer.from([0xc3, 0x28]))];
  invalid.push({ mimeType: 'text/plain', body: { data: '@@@' } });
  for (const payload of invalid) await withGoogleSources({ mailContent: { payload } }, async ({ sources, signal, fake }) => {
    const inbox = await sources.execute('list_recent_emails', {}, signal);
    await assert.rejects(sources.execute('read_email', { id: 'm1' }, signal), /CONTACT_GOOGLE_BODY_UNAVAILABLE/u);
    const before = fake.requests.length;
    assert.equal(await sources.verify({ ...evidenceOf(inbox), path: 'messages/m1?body_bytes=4096' }, signal), false);
    assert.equal(fake.requests.length, before);
  });
});

test('separately stored body is unavailable; partial inline text declares omissions and never fetches attachments', async () => {
  const separate = { mimeType: 'text/plain', body: { size: 80, attachmentId: 'separate-body' } }, mailContent = { payload: separate };
  await withGoogleSources({ mailContent }, async ({ sources, signal, fake }) => {
    await sources.execute('list_recent_emails', {}, signal);
    await assert.rejects(sources.execute('read_email', { id: 'm1' }, signal), /CONTACT_GOOGLE_BODY_UNAVAILABLE/u);
    assert.equal(fake.requests.some(item => item.path.includes('/attachments/')), false);
  });
  mailContent.payload = { mimeType: 'multipart/mixed', parts: [textPart(Buffer.from('읽은 본문입니다.')), separate,
    textPart(Buffer.from('Unknown encoding'), 'X-UNKNOWN'), textPart(Buffer.from([0xc3, 0x28])),
    { mimeType: 'application/pdf', filename: 'agenda.pdf', body: { attachmentId: 'real-attachment' } }] };
  await withGoogleSources({ mailContent }, async ({ sources, signal, fake }) => {
    await sources.execute('list_recent_emails', {}, signal);
    const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.body_status, 'partial'); assert.equal(email.truncated, true);
    assert.deepEqual(email.omitted_body_parts, ['malformed_text', 'separately_stored_text', 'unsupported_charset']);
    assert.match(email.content, /Body status: partial; omitted parts: malformed_text, separately_stored_text, unsupported_charset\n\n읽은 본문입니다\./u);
    assert.equal(await sources.verify(evidenceOf(email), signal), true);
    mailContent.payload = separate;
    assert.equal(await sources.verify(evidenceOf(email), signal), false);
    assert.equal(fake.requests.some(item => item.path.includes('/attachments/')), false);
  });
});

test('an empty plain alternative uses readable HTML while a truly empty inline body remains distinguishable', async () => {
  const mailContent = { payload: { mimeType: 'multipart/alternative', parts: [textPart(Buffer.from('')),
    textPart(Buffer.from('<p>회의 준비 자료입니다.</p>'), 'UTF-8', 'text/html')] } };
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    await sources.execute('list_recent_emails', {}, signal);
    const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.content.slice(email.content.indexOf('\n\n') + 2), '회의 준비 자료입니다.');
    assert.equal(email.body_status, 'available'); assert.equal(email.truncated, false);
  });
  mailContent.payload = textPart(Buffer.from(''));
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    await sources.execute('list_recent_emails', {}, signal);
    const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.content.slice(email.content.indexOf('\n\n') + 2), '');
    assert.equal(email.body_status, 'available'); assert.equal(email.truncated, false); assert.equal(await sources.verify(evidenceOf(email), signal), true);
  });
});

test('mixed MIME keeps an HTML main body and plain footer in order while each alternative selects its own representation', async () => {
  const html = textPart(Buffer.from('<p>Main body: deadline Friday.</p>'), 'UTF-8', 'text/html');
  const footer = textPart(Buffer.from('Legal notice: internal use.'));
  const mailContent = { payload: { mimeType: 'multipart/mixed', parts: [html, footer] } };
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    await sources.execute('list_recent_emails', {}, signal); const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.content.slice(email.content.indexOf('\n\n') + 2), 'Main body: deadline Friday.\nLegal notice: internal use.');
    assert.equal(email.body_status, 'available'); assert.equal(email.truncated, false); assert.equal(await sources.verify(evidenceOf(email), signal), true);
  });
  mailContent.payload.parts[0] = { mimeType: 'multipart/alternative', parts: [textPart(Buffer.from('Plain main: deadline Friday.')), html] };
  await withGoogleSources({ mailContent }, async ({ sources, signal }) => {
    await sources.execute('list_recent_emails', {}, signal); const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.content.slice(email.content.indexOf('\n\n') + 2), 'Plain main: deadline Friday.\nLegal notice: internal use.');
    assert.equal(email.truncated, false); assert.equal(await sources.verify(evidenceOf(email), signal), true);
  });
});

test('filename-free attachment dispositions exclude inline text and container subtrees even with case, folding and duplicates', async () => {
  const secret = textPart(Buffer.from('PRIVATE_ATTACHMENT_TEXT'));
  const attachment = headers => ({ ...secret, headers: [...secret.headers, ...headers] });
  const mailContent = { payload: { mimeType: 'multipart/mixed', parts: [textPart(Buffer.from('Permitted mail body.')),
    attachment([{ name: 'Content-Disposition', value: 'attachment' }]),
    attachment([{ name: 'cOnTeNt-dIsPoSiTiOn', value: 'AtTaChMeNt;\r\n\tcreation-date="today"' }]),
    attachment([{ name: 'Content-Disposition', value: 'inline' }, { name: 'Content-Disposition', value: 'attachment' }]),
    { mimeType: 'multipart/mixed', headers: [{ name: 'Content-Disposition', value: 'ATTACHMENT' }], parts: [secret] },
    { ...textPart(Buffer.from('Visible inline footer.')), headers: [{ name: 'Content-Disposition', value: 'inline' }] },
  ] } };
  await withGoogleSources({ mailContent }, async ({ sources, signal, fake }) => {
    await sources.execute('list_recent_emails', {}, signal); const email = await sources.execute('read_email', { id: 'm1' }, signal);
    assert.equal(email.content.slice(email.content.indexOf('\n\n') + 2), 'Permitted mail body.\nVisible inline footer.');
    assert.equal(email.content.includes('PRIVATE_ATTACHMENT_TEXT'), false); assert.equal(email.body_status, 'available');
    assert.equal(await sources.verify(evidenceOf(email), signal), true); assert.equal(fake.requests.some(item => item.path.includes('/attachments/')), false);
  });
});

for (const scenario of ['corrected', 'corrected_empty', 'ignored', 'calendar_failed']) test(`daily check cannot claim nothing is new without reading connected mail and calendar: ${scenario}`, async () => {
  const e = environment(), fake = await googleServer(scenario === 'calendar_failed' ? { responses: { calendar: { status: 503, value: {} } } } : scenario === 'corrected_empty' ? { responses: { inbox: { value: { messages: [] } }, calendar: { value: { items: [] } } } } : {});
  const device = e.store.addDevice('Owner'); e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  let calls = 0;
  const model = { async chat(messages) {
    calls++;
    assert.match(messages[0].content, /owner timezone: Asia\/Seoul/);
    assert.match(messages[0].content, /deadline getting closer/);
    if (calls === 1) return reply('NO_NEW_SUGGESTION');
    assert.ok(messages.some(message => message.role === 'system' && message.content.includes('daily check is incomplete')));
    if (scenario === 'ignored') return reply('NO_NEW_SUGGESTION');
    if (calls === 2) return reply('', [callTool('list_recent_emails'), callTool('list_upcoming_events')]);
    return reply('NO_NEW_SUGGESTION');
  } };
  const service = new ContactService(e.store, model, noSources), connection = makeConnection(e.store, service, fake);
  try {
    const noon = Date.parse('2026-10-08T03:00:00Z');
    e.store.configureProactive(device.id, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', noon);
    assert.equal(e.store.proactiveTick(noon, true), 1); service.start(); await service.idle();
    const turn = e.store.page().turns.at(-1);
    if (scenario.startsWith('corrected')) {
      assert.equal(turn.state, 'answered'); assert.equal(turn.answer.quiet, true);
      assert.equal(fake.counts().inboxCount, 1); assert.equal(fake.counts().calendarCount, 1);
    } else {
      assert.equal(turn.state, 'failed'); assert.equal(turn.error, 'ASSISTANT_INCOMPLETE_CHECK');
      assert.equal(turn.answer, null);
    }
    assert.equal(calls, scenario === 'ignored' ? 2 : 3);
    assert.equal(e.store.checkpoint().through, 0);
    assert.equal(e.store.proactiveTick(noon + 1000, true), 0);
    assert.equal(e.store.usage().requests, calls);
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});


for (const cause of ['cancel', 'revoke']) test(`the first refresh caller's ${cause} does not cancel another current account read`, async () => {
  const e = environment(), fake = await googleServer({ holdRefresh: true }), owner = e.store.addDevice('Owner'), firstDevice = e.store.addDevice('First reader');
  const grant = makeCredential(owner.id); e.store.saveGoogleCredential(owner.id, grant, null);
  const connection = makeConnection(e.store, null, fake), caller = new AbortController();
  const profile = new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  try {
    const first = connection.apiJson(firstDevice.id, grant.epoch, profile, caller.signal);
    const rejected = assert.rejects(first, /CONTACT_/u);
    await fake.refreshStarted;
    const second = connection.apiJson(owner.id, grant.epoch, profile, new AbortController().signal);
    if (cause === 'cancel') { caller.abort(); await rejected; }
    else { connection.deviceRevoked(firstDevice.id); e.store.revoke(firstDevice.id); }
    fake.resumeRefresh(); await rejected;
    assert.equal((await second).emailAddress, 'owner@example.test');
    assert.equal(fake.counts().refreshCount, 1); assert.equal(connection.status().connected, true);
  } finally { connection.close(); e.close(); await fake.close(); }
});

for (const mode of ['citation_correction', 'argument_correction', 'missing_calendar']) test(`bounded proactive responses preserve a final conclusion without hiding missing reads: ${mode}`, async () => {
  const complete = mode !== 'missing_calendar';
  const e = environment(), fake = await googleServer(), device = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(device.id, makeCredential(device.id), null);
  let calls = 0;
  const model = { async chat(messages, tools) {
    calls++;
    assert.match(messages[0].content, new RegExp(`${5 - calls} model responses remaining`));
    if (calls === 1) return reply('', [callTool('list_followups', { status: 'active', offset: 0 }), callTool('list_recent_emails'), ...(complete ? [callTool('list_upcoming_events')] : [])]);
    if (calls === 2) return reply('', [callTool('read_email', { id: 'm1' })]);
    if (calls === 3) return mode === 'argument_correction'
      ? reply('', [callTool('list_followups', { status: 'active', offset: '0' })])
      : reply(complete ? '갱신 날짜를 준비 미팅에서 확인하면 좋겠어요.' : 'NO_NEW_SUGGESTION');
    assert.equal(calls, 4); assert.deepEqual(tools, []);
    if (mode === 'argument_correction') {
      const correction = JSON.parse(messages.at(-1).content);
      assert.equal(correction.error, 'CALL_ARGUMENTS_OR_SOURCE_INVALID');
      assert.equal(correction.performed, false);
    }
    return reply(complete ? '최근 메일의 갱신 날짜를 준비 미팅에서 확인하면 좋겠어요 [S3] [S2].' : 'NO_NEW_SUGGESTION');
  } };
  const service = new ContactService(e.store, model, noSources), connection = makeConnection(e.store, service, fake);
  try {
    const noon = Date.parse('2026-10-08T03:00:00Z');
    e.store.configureProactive(device.id, true, 'daily_conversation_suggestions_v1', 'Asia/Seoul', noon);
    assert.equal(e.store.proactiveTick(noon, true), 1); service.start(); await service.idle();
    const turn = e.store.page().turns.at(-1);
    assert.equal(calls, 4); assert.equal(e.store.usage().requests, 4);
    assert.equal(turn.state, complete ? 'answered' : 'failed');
    if (complete) { assert.equal(turn.answer.verification, 'cited_sources_rechecked'); assert.equal(turn.answer.sources.length, 2); }
    else { assert.equal(turn.error, 'ASSISTANT_INCOMPLETE_CHECK'); assert.equal(turn.answer, null); }
  } finally { await service.close(); connection.close(); e.close(); await fake.close(); }
});

test('related-mail HTTP setting rejects wrong consent and unknown fields, and persists only the explicit grant', async () => {
  const e = environment(), fake = await googleServer(), owner = e.store.addDevice('Owner');
  e.store.saveGoogleCredential(owner.id, makeCredential(owner.id), null);
  const service = new ContactService(e.store, { chat: async () => reply('ok') }, noSources);
  makeConnection(e.store, service, fake);
  const network = await contactNetwork(e.store, service);
  try {
    const initial = (await network.call('/api/state', undefined, network.cookie)).json().google;
    assert.equal(initial.related_mail.enabled, false);
    assert.equal((await network.call('/api/google/related-mail', { enabled: true, consent: 'google_readonly_v1' }, network.cookie)).status, 400);
    assert.equal((await network.call('/api/google/related-mail', { enabled: true, consent: 'related_mail_readonly_v1', extra: true }, network.cookie)).status, 400);
    assert.equal(e.store.relatedMailEpoch(), null);
    assert.equal((await network.call('/api/google/related-mail', { enabled: true, consent: 'related_mail_readonly_v1' })).status, 401);
    assert.equal((await network.call('/api/google/related-mail', { enabled: true, consent: 'related_mail_readonly_v1' }, network.cookie)).status, 200);
    const state = (await network.call('/api/state', undefined, network.cookie)).json();
    assert.equal(state.google.related_mail.enabled, true); assert.equal(fake.requests.length, 0);
    assert.equal(JSON.stringify(state).includes(refreshToken), false);
    assert.equal((await network.call('/api/google/related-mail', { enabled: false, consent: null }, network.cookie)).status, 200);
    assert.equal(e.store.relatedMailEpoch(), null);
  } finally { await network.host.close(); await service.close(); e.close(); await fake.close(); }
});
