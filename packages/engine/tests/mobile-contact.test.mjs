import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { MobileContact } from '../src/mobile-contact.mjs';
import { serveContact } from '../src/contact-http.mjs';
const token = '123456789:fixture_only_not_a_real_token', consent = 'private_telegram_contact_v1';
const noSources = { definitions: [], validate: () => false, execute: async () => {}, verify: async () => false };
const sha = text => createHash('sha256').update(text).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(10); } throw Error('TEST_TIMEOUT'); };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tada-mobile-')), directory = join(root, 'private');
  const route = contactRoute({ fixture: 'mobile' }), passphrase = 'fixture only mobile passphrase';
  let store = new ContactStore({ directory, route, passphrase, initialize: true, assistance: true });
  const updates = [], effects = []; let inspections = 0;
  const makeAPI = value => {
    assert.equal(value, token);
    return { inspect: async () => { inspections++; return { id: '123456789', username: 'TadaFixtureBot' }; },
      updates: async (_cursor, signal) => { await pause(10); if (signal.aborted) throw Error('CONTACT_TELEGRAM_CANCELLED'); return updates.splice(0); },
      send: async delivery => { effects.push(delivery); return { message_id: effects.length, bot: delivery.bot, chat: delivery.chat, text_hash: sha(delivery.text) }; }, close() {} };
  };
  let service = new ContactService(store, { chat: async () => ({ message: { role: 'assistant', content: '같은 대화를 이어서 답해요.' }, input_tokens: 3, output_tokens: 4 }) }, noSources);
  let mobile = new MobileContact(store, service, makeAPI);
  return { root, directory, get store() { return store; }, get service() { return service; }, get mobile() { return mobile; }, get inspections() { return inspections; }, updates, effects,
    async reopen() { await mobile.close(); await service.close(); store.close(); store = new ContactStore({ directory, route, passphrase }); service = new ContactService(store, {}, noSources); mobile = new MobileContact(store, service, makeAPI); await mobile.restore(); },
    async close() { await mobile.close(); await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function message(n, text, uid = 987654321) { return { update_id: n, message: { message_id: n, chat: { id: uid, type: 'private' }, from: { id: uid, is_bot: false }, text } }; }

test('screen connection requires consent; encrypted credential restores and disconnect stops future network work', async () => {
  const e = fixture();
  try {
    const d = e.store.addDevice('desktop');
    await assert.rejects(e.mobile.connect(d.id, token, 'yes'), /CONSENT_REQUIRED/); assert.equal(e.inspections, 0);
    await e.mobile.connect(d.id, token, consent);
    assert.equal(e.mobile.status().configured, true); assert.equal(JSON.stringify(e.mobile.status()).includes(token), false);
    await e.reopen(); assert.equal(e.inspections, 2); assert.equal(e.mobile.status().enabled, true);
    assert.equal(readFileSync(join(e.directory, 'contact.sqlite')).includes(Buffer.from(token)), false);
    await e.mobile.disconnect(d.id); assert.equal(e.store.mobileCredential(), null);
    await e.reopen(); assert.equal(e.inspections, 2); assert.equal(e.mobile.status().enabled, false);
  } finally { await e.close(); }
});

test('phone pairing requires owner confirmation, rejects outsiders and shares the same conversation', async () => {
  const e = fixture();
  try {
    const d = e.store.addDevice('desktop');
    e.service.submit(d.id, randomUUID(), '휴대폰에서도 이 대화를 이어갈게.'); await e.service.idle();
    await e.mobile.connect(d.id, token, consent);
    const link = e.mobile.pair(d.id); assert.deepEqual(e.mobile.pair(d.id), link);
    const code = new URL(link.url).searchParams.get('start');
    e.updates.push(message(1, '/start ' + code)); await until(() => e.mobile.status().candidates.length === 1);
    assert.equal(e.effects.length, 0); assert.equal(e.store.messagingStatus().paired, false);
    e.updates.push(message(2, '승인 전')); await pause(150); assert.equal(e.store.page().turns.length, 1);
    e.mobile.approve(d.id, e.mobile.status().candidates[0].candidate);
    e.updates.push(message(3, '외부인', 555555), message(4, '앞서 하던 이야기 이어가자.'));
    await until(() => e.store.page().turns.length === 2 && e.store.page().turns.at(-1).state === 'answered');
    assert.equal(e.store.page().turns.at(-1).text, '앞서 하던 이야기 이어가자.');
    assert.ok(e.store.checkpoint().value.history.some(m => m.content.includes('휴대폰에서도')));
    await e.mobile.disconnect(d.id); assert.equal(e.store.messagingStatus().paired, false);
  } finally { await e.close(); }
});

test('HTTP configuration is authenticated, exact-shape and never returns a credential', async () => {
  const e = fixture(); let host;
  try {
    const origin = 'http://127.0.0.1:9346';
    host = await serveContact({ store: e.store, service: e.service, origin, port: 0, mobile: e.mobile });
    const d = e.store.addDevice('desktop');
    const call = (path, body, cookie = d.token, suppliedOrigin = origin) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: host.address.port, path, method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1:9346', Origin: suppliedOrigin, Cookie: `tada_local=${cookie}`, 'Content-Type': 'application/json' } }, res => {
        const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts)) }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    assert.equal((await call('/api/mobile/connect', { token, consent }, '')).status, 401);
    assert.equal((await call('/api/mobile/connect', { token, consent }, d.token, 'http://evil.invalid')).status, 403);
    assert.equal((await call('/api/mobile/connect', { token, consent, extra: true })).status, 400);
    assert.equal((await call('/api/mobile/connect', { token, consent })).status, 200);
    assert.equal((await call('/api/mobile/reconnect', {}, '')).status, 401);
    assert.equal((await call('/api/mobile/reconnect', {})).status, 200);
    const state = await call('/api/state'); assert.equal(JSON.stringify(state).includes(token), false);
    assert.equal((await call('/api/proactive', { enabled: true, consent: 'daily_conversation_suggestions_v1' })).status, 200);
    assert.equal(e.store.proactiveStatus().enabled, true);
    assert.equal((await call('/api/proactive', { enabled: false, consent: null })).status, 200);
    e.service.revoke(d.id);
    assert.equal((await call('/api/mobile/pair', {})).status, 401);
  } finally { await host?.close(); await e.close(); }
});

test('revocation during inspection cannot persist a bot identity or prevent the next owner connection', async () => {
  const e = fixture(); let mobile, release;
  try {
    const d = e.store.addDevice('revoked during connect');
    const waiting = new Promise(resolve => { release = resolve; });
    mobile = new MobileContact(e.store, e.service, () => ({
      inspect: async () => { await waiting; return { id: '123456789', username: 'TadaFixtureBot' }; }, close() {},
    }));
    const connecting = mobile.connect(d.id, token, consent);
    e.service.revoke(d.id); release(); await assert.rejects(connecting, /DEVICE_REVOKED/);
    assert.equal(e.store.mobileCredential(), null);
    // telegramConfigure used to be committed before the revocation recheck.
    assert.doesNotThrow(() => e.store.telegramConfigure('222222222'));
  } finally { release?.(); await mobile?.close(); await e.close(); }
});

test('a temporary startup failure recovers with the encrypted credential without new technical input', async () => {
  const e = fixture(); let mobile;
  try {
    const d = e.store.addDevice('owner'); e.store.saveMobileCredential(d.id, token);
    let fail = true, inspected = 0;
    mobile = new MobileContact(e.store, e.service, saved => {
      assert.equal(saved, token);
      return { inspect: async () => { inspected++; if (fail) throw Error('CONTACT_TELEGRAM_NETWORK'); return { id: '123456789', username: 'TadaFixtureBot' }; },
        updates: async () => { await pause(10); return []; }, close() {} };
    });
    await mobile.restore(); assert.equal(mobile.status().enabled, false); assert.equal(mobile.status().configured, true);
    fail = false; const recovered = await mobile.reconnect(d.id);
    assert.equal(recovered.enabled, true); assert.equal(recovered.error, null); assert.equal(inspected, 2);
    assert.equal(JSON.stringify(recovered).includes(token), false);
    e.service.revoke(d.id); await assert.rejects(mobile.reconnect(d.id), /DEVICE_REVOKED/); assert.equal(inspected, 2);
  } finally { await mobile?.close(); await e.close(); }
});

test('shutdown during mobile account inspection admits neither new credentials nor polling', async () => {
  const e = fixture(); let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const mobile = new MobileContact(e.store, e.service, () => ({
    inspect: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { id: '123456789', username: 'TadaFixtureBot' }; },
    updates: () => assert.fail('No new polling after stop'), close() {},
  }));
  try {
    const device = e.store.addDevice('Computer');
    const connecting = mobile.connect(device.id, token, consent); await started;
    e.service.beginStop(); release(); await assert.rejects(connecting, /HOST_STOPPING/);
    assert.equal(e.store.mobileCredential(), null); assert.equal(mobile.status().enabled, false);
  } finally { release?.(); await mobile.close(); await e.close(); }
});
