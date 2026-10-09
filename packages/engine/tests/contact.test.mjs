import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { serveContact, validateContactAddress } from '../src/contact-http.mjs';
import { ConversationAssistant } from '../src/conversation.ts';

const passphrase = 'test-only secret with sufficient length';
const route = contactRoute({ fixture: true });
const noSources = { definitions: [], validate: () => false, execute: async () => { throw Error('TEST_NO_TOOLS'); }, verify: async () => false };
const response = text => ({ message: { role: 'assistant', content: text }, input_tokens: 5, output_tokens: 3 });
function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tada-contact-test-'));
  const directory = join(root, 'private');
  let store = new ContactStore({ directory, passphrase, route, initialize: true, ...options });
  return { root, directory, get store() { return store; },
    reopen() { store.close(); store = new ContactStore({ directory, passphrase, route }); return store; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const pairedDevice = store => store.addDevice('Test device');
async function serverFor(store, service, extra = {}) {
  const origin = 'http://127.0.0.1:9177';
  const host = await serveContact({ store, service, origin, port: 0, ...extra });
  const address = `http://127.0.0.1:${host.address.port}`;
  const call = (path, body, cookie = '', extra = {}) => new Promise((yes, no) => {
    const req = request(address + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:9177', Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...extra } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item) headers.append(key, item);
        yes({ status: res.statusCode, headers, json: async () => JSON.parse(text), text: async () => text });
      });
    });
    req.on('error', no);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const pair = async name => {
    const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
    const res = await call('/api/pair', { code, name }); assert.equal(res.status, 200);
    return { cookie: res.headers.get('set-cookie').split(';')[0], id: (await res.json()).device, code };
  };
  return { host, call, pair };
}

test('two independently paired clients share actual accepted conversation and follow-up after host restart', async () => {
  const env = setup(); let seen = [];
  const model = { async chat(messages) { seen.push(messages); return response(seen.length === 1 ? '내일 논의할 세 가지를 정리했어요.' : '핵심 한 가지만 남겼어요.'); } };
  let service = new ContactService(env.store, model, noSources);
  let network = await serverFor(env.store, service);
  try {
    const phone = await network.pair('Phone'), laptop = await network.pair('Laptop');
    const id = randomUUID();
    const sent = await network.call('/api/turns', { request_id: id, text: '내일 이야기할 내용을 같이 정리하자.' }, phone.cookie);
    assert.equal(sent.status, 202);
    await service.idle();
    const fromLaptop = await (await network.call('/api/state', undefined, laptop.cookie)).json();
    assert.equal(fromLaptop.turns[0].answer.text, '내일 논의할 세 가지를 정리했어요.');
    assert.equal(fromLaptop.turns[0].request_id, id);
    const identity = fromLaptop.assistant;
    await network.host.close(); await service.close(); env.reopen();
    service = new ContactService(env.store, model, noSources); network = await serverFor(env.store, service);
    const replay = await (await network.call('/api/turns', { request_id: id, text: '내일 이야기할 내용을 같이 정리하자.' }, phone.cookie)).json();
    assert.equal(replay.replay, true); await service.idle(); assert.equal(seen.length, 1);
    await network.call('/api/turns', { request_id: randomUUID(), text: '그중 핵심만 짧게 말해줘.' }, laptop.cookie);
    await service.idle();
    const state = await (await network.call('/api/state', undefined, phone.cookie)).json();
    assert.equal(state.assistant, identity); assert.equal(state.turns.length, 2);
    assert.equal(state.turns[1].answer.text, '핵심 한 가지만 남겼어요.');
    assert.ok(seen[1].some(m => m.role === 'user' && m.content === '내일 이야기할 내용을 같이 정리하자.'));
    assert.ok(seen[1].some(m => m.role === 'assistant' && m.content === '내일 논의할 세 가지를 정리했어요.'));
    assert.equal(state.usage.requests, 2);
    assert.equal(Object.hasOwn(state, 'checkpoint'), false);
  } finally { await network.host.close(); await service.close(); env.close(); }
});

test('separate localhost assistants coexist in one browser cookie jar and logout affects only its journal', async () => {
  const a = setup(), b = setup();
  const serviceA = new ContactService(a.store, {}, noSources), serviceB = new ContactService(b.store, {}, noSources);
  const networkA = await serverFor(a.store, serviceA), networkB = await serverFor(b.store, serviceB);
  try {
    const first = await networkA.pair('Browser A'), second = await networkB.pair('Browser B');
    assert.notEqual(first.cookie.split('=')[0], second.cookie.split('=')[0]);
    const jar = `${first.cookie}; ${second.cookie}`;
    const stateA = await networkA.call('/api/state', undefined, jar), stateB = await networkB.call('/api/state', undefined, jar);
    assert.equal(stateA.status, 200); assert.equal(stateB.status, 200);
    assert.equal((await stateA.json()).assistant, a.store.id); assert.equal((await stateB.json()).assistant, b.store.id);
    assert.equal((await networkA.call('/api/state', undefined, second.cookie)).status, 401);
    const logout = await networkB.call('/api/logout', {}, jar);
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await networkB.call('/api/state', undefined, jar)).status, 401);
    assert.equal((await networkA.call('/api/state', undefined, jar)).status, 200);
  } finally { await networkA.host.close(); await networkB.host.close(); await serviceA.close(); await serviceB.close(); a.close(); b.close(); }
});

test('authenticated legacy connections migrate without a new device and cannot bypass invalid scoped cookies', async () => {
  const e = setup(); let service = new ContactService(e.store, {}, noSources), network = await serverFor(e.store, service);
  try {
    const device = e.store.addDevice('Existing browser'), legacy = `tada_local=${device.token}`;
    const response = await network.call('/api/state', undefined, legacy);
    assert.equal(response.status, 200); assert.equal((await response.json()).device, device.id);
    const cookie = response.headers.get('set-cookie').split(';')[0], name = cookie.split('=')[0];
    assert.match(name, /^tada_local_[a-f0-9]{24}$/u);
    assert.ok(cookie.endsWith(`=${device.token}`)); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await network.call('/api/state', undefined, `${name}=invalid; ${legacy}`)).status, 401);
    assert.equal((await network.call('/api/state', undefined, `${cookie}; ${cookie}; ${legacy}`)).status, 401);
    assert.equal((await network.call('/api/state', undefined, `${legacy}; ${legacy}`)).status, 401);
    await network.host.close(); await service.close(); e.reopen();
    service = new ContactService(e.store, {}, noSources); network = await serverFor(e.store, service);
    const restored = await network.call('/api/state', undefined, cookie);
    assert.equal(restored.status, 200); assert.equal((await restored.json()).device, device.id);
    assert.equal(restored.headers.get('set-cookie'), null);
    e.store.revoke(device.id);
    const rejected = await network.call('/api/state', undefined, legacy);
    assert.equal(rejected.status, 401); assert.equal(rejected.headers.get('set-cookie'), null);
  } finally { await network.host.close(); await service.close(); e.close(); }
});

test('closing an HTTP client does not cancel an accepted request and completion is available to another client', async () => {
  const env = setup(); let finish;
  const model = { chat: () => new Promise(resolve => { finish = resolve; }) };
  const service = new ContactService(env.store, model, noSources);
  const network = await serverFor(env.store, service);
  try {
    const phone = await network.pair('Phone'), other = await network.pair('Other');
    const res = await network.call('/api/turns', { request_id: randomUUID(), text: '생각을 정리해줘.' }, phone.cookie);
    const seq = (await res.json()).seq;
    assert.equal(env.store.turn(seq).state, 'running');
    // The original HTTP exchange has ended, but the host still owns the model.
    assert.ok(finish); finish(response('정리한 답변입니다.'));
    await service.idle();
    const state = await (await network.call('/api/state', undefined, other.cookie)).json();
    assert.equal(state.turns[0].state, 'answered');
    assert.equal(state.turns[0].answer.text, '정리한 답변입니다.');
  } finally { await network.host.close(); await service.close(); env.close(); }
});

test('cancelled late answer is withheld, observed usage kept, and same assistant continues with the next user message', async () => {
  const env = setup(); let release, called = 0; const histories = [];
  const model = { async chat(messages) { histories.push(messages); called++; return called === 1 ? new Promise(resolve => { release = resolve; }) : response('다른 이야기를 이어갈게요.'); } };
  const service = new ContactService(env.store, model, noSources);
  try {
    const device = pairedDevice(env.store).id;
    const one = service.submit(device, randomUUID(), '이 일은 잠시 맡아줘.');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(release); service.cancel(one.seq);
    service.submit(device, randomUUID(), '그건 그만하고 다른 이야기를 하자.');
    release(response('취소 뒤 도착한 답변')); await service.idle();
    const turns = env.store.page().turns;
    assert.equal(turns[0].state, 'cancelled'); assert.equal(turns[0].answer, null);
    assert.equal(turns[1].state, 'answered'); assert.equal(env.store.usage().requests, 2);
    assert.equal(env.store.usage().input_tokens, 10);
    assert.ok(histories[1].some(m => m.content.includes('cancelled')));
    assert.ok(!histories[1].some(m => m.content.includes('취소 뒤 도착한 답변')));
  } finally { await service.close(); env.close(); }
});

test('unstarted queued requests survive reopen while a running request is not silently resent', async () => {
  const env = setup();
  try {
    const device = pairedDevice(env.store).id;
    const first = env.store.submit(device, randomUUID(), '첫 번째');
    env.store.claim(); env.store.reserve(first.seq);
    const second = env.store.submit(device, randomUUID(), '두 번째');
    env.reopen();
    assert.equal(env.store.turn(first.seq).state, 'interrupted');
    assert.equal(env.store.turn(second.seq).state, 'queued');
    assert.deepEqual(env.store.usage(), { requests: 1, input_tokens: 0, output_tokens: 0, unknown_requests: 1 });
    const seen = [];
    const service = new ContactService(env.store, { async chat(messages) { seen.push(messages); return response('새로 접수한 두 번째 답변'); } }, noSources);
    service.start(); await service.idle(); await service.close();
    assert.equal(seen.length, 1); assert.equal(env.store.turn(second.seq).state, 'answered');
    assert.ok(seen[0].some(m => m.content.includes('interrupted')));
    assert.equal(env.store.usage().requests, 2);
  } finally { env.close(); }
});

test('revoke one device aborts only its pending work and blocks its existing cookie without deleting shared history', async () => {
  const env = setup(); let release;
  const service = new ContactService(env.store, { chat: () => new Promise(resolve => { release = resolve; }) }, noSources);
  const network = await serverFor(env.store, service);
  try {
    const a = await network.pair('A'), b = await network.pair('B');
    await network.call('/api/turns', { request_id: randomUUID(), text: '기다리는 요청' }, a.cookie);
    service.revoke(a.id); release(response('늦은 답변')); await service.idle();
    assert.equal((await network.call('/api/state', undefined, a.cookie)).status, 401);
    assert.equal((await network.call('/api/state', undefined, b.cookie)).status, 200);
    assert.equal(env.store.page().turns[0].state, 'cancelled');
  } finally { await network.host.close(); await service.close(); env.close(); }
});

test('pairing is one-use and source browsing, arbitrary commands and cross-origin requests are not remote APIs', async () => {
  const env = setup(); const service = new ContactService(env.store, { chat: async () => response('hello') }, noSources);
  const network = await serverFor(env.store, service);
  try {
    const a = await network.pair('A');
    assert.equal((await network.call('/api/pair', { code: a.code, name: 'B' })).status, 403);
    assert.equal((await network.call('/api/state', undefined, '', { 'X-Forwarded-User': a.id })).status, 401);
    assert.equal((await network.call('/api/state', undefined, a.cookie, { Host: 'attacker.invalid' })).status, 403);
    assert.equal((await network.call('/api/turns', {}, a.cookie, { Origin: 'https://attacker.invalid' })).status, 403);
    const navigation = { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    assert.equal((await network.call('/', undefined, '', navigation)).status, 200);
    assert.equal((await network.call('/api/state', undefined, a.cookie, navigation)).status, 403);
    assert.equal((await network.call('/', undefined, '', { ...navigation, 'Sec-Fetch-Site': 'cross-site' })).status, 200);
    assert.equal((await network.call('/api/state', undefined, a.cookie, { ...navigation, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await network.call('/', undefined, '', { ...navigation, 'Sec-Fetch-Mode': 'cors' })).status, 403);
    for (const path of ['/api/shell', '/api/policy', '/api/checkpoint', '/api/files']) assert.equal((await network.call(path, {}, a.cookie)).status, 404);
    assert.equal((await network.call('/api/turns', '{"request_id":"1111111111111111","text":"a","text":"b"}', a.cookie)).status, 400);
    assert.equal((await network.call('/api/turns', { request_id: randomUUID(), text: 'a', authority: 'admin' }, a.cookie)).status, 400);
    assert.equal(env.store.page().turns.length, 0);
  } finally { await network.host.close(); await service.close(); env.close(); }
});

test('request ID replay is global to the same assistant but never rebinds changed text', () => {
  const env = setup();
  try {
    const a = pairedDevice(env.store), b = pairedDevice(env.store); const id = randomUUID();
    const first = env.store.submit(a.id, id, 'hello');
    assert.deepEqual(env.store.submit(b.id, id, 'hello'), { seq: first.seq, replay: true });
    assert.throws(() => env.store.submit(b.id, id, 'different'), /CONTACT_REQUEST_ID_REUSED/);
    assert.equal(env.store.page().turns.length, 1);
  } finally { env.close(); }
});

test('private text and authentication tokens are absent from persisted SQLite/WAL bytes', () => {
  const env = setup();
  try {
    const device = pairedDevice(env.store), marker = `PRIVATE_CONTENT_${randomUUID()}`;
    env.store.submit(device.id, randomUUID(), marker);
    for (const name of ['contact.sqlite', 'contact.sqlite-wal']) {
      const raw = readFileSync(join(env.directory, name));
      assert.equal(raw.includes(Buffer.from(marker)), false);
      assert.equal(raw.includes(Buffer.from(device.token)), false);
      assert.equal(raw.includes(Buffer.from(passphrase)), false);
    }
  } finally { env.close(); }
});

test('wrong unlock secret, changed route, corrupted ciphertext and schema versions fail before recovery', () => {
  const env = setup();
  try {
    const device = pairedDevice(env.store); env.store.submit(device.id, randomUUID(), 'secret'); env.store.close();
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase: 'wrong passphrase long enough', route }), /CONTACT_UNLOCK_OR_INTEGRITY_FAILED/);
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route: 'f'.repeat(64) }), /CONTACT_ROUTE_CHANGED/);
    const db = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    db.exec("UPDATE turns SET payload='invalid'"); db.close();
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route }), /CONTACT_UNLOCK_OR_INTEGRITY_FAILED/);
  } finally { env.close(); }
});

test('second live store cannot reclaim ownership and a crashed process releases the kernel lock', async () => {
  const env = setup();
  try {
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route }), /CONTACT_ALREADY_OWNED/);
    env.store.close();
    const module = new URL('../src/contact-store.mjs', import.meta.url).href;
    // A live process is not itself a live store. Keep the owner reachable and
    // exercised so SQLite finalization cannot release an otherwise unused lock.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {ContactStore} from ${JSON.stringify(module)};
      const store = new ContactStore(${JSON.stringify({ directory: env.directory, passphrase, route })});
      console.log('locked'); setInterval(()=>{ store.page(); },1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    try {
      await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(Error('CHILD_START_TIMEOUT')), 10000).unref())]);
      assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route }), /CONTACT_ALREADY_OWNED/);
    } finally { child.kill('SIGKILL'); await exit; }
    env.reopen(); assert.ok(env.store.id);
  } finally { env.close(); }
});

test('completed answer and private context commit together; a broken commit cannot advertise success', () => {
  const env = setup();
  try {
    const device = pairedDevice(env.store); const { seq } = env.store.submit(device.id, randomUUID(), 'hello'); env.store.claim();
    const db = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    db.exec("CREATE TRIGGER inject BEFORE INSERT ON context BEGIN SELECT RAISE(ABORT,'test only'); END;"); db.close();
    assert.throws(() => env.store.finish(seq, { text: 'answer', sources: [] }, { version: 1 }), /CONTACT_STORAGE_FAILED/);
    env.store.close();
    const check = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    assert.equal(check.prepare('SELECT state FROM turns').get().state, 'running');
    assert.equal(check.prepare('SELECT answer FROM turns').get().answer, null); check.close();
  } finally { env.close(); }
});

test('state pagination preserves the full history and does not claim the first page is complete', () => {
  const env = setup();
  try {
    const device = pairedDevice(env.store);
    for (let i = 0; i < 55; i++) { const row = env.store.submit(device.id, randomUUID(), `message ${i}`); env.store.cancel(row.seq); }
    const first = env.store.page(); assert.equal(first.turns.length, 50); assert.equal(first.next_before, 6);
    const second = env.store.page(first.next_before); assert.equal(second.turns.length, 5); assert.equal(second.next_before, null);
  } finally { env.close(); }
});

test('request allowance and uncertain observation are durable and not refilled by reopening', () => {
  const env = setup();
  try {
    const device = pairedDevice(env.store); const turn = env.store.submit(device.id, randomUUID(), 'hello'); env.store.claim();
    for (let i = 0; i < 64; i++) env.store.observe(env.store.reserve(turn.seq), i === 63 ? null : response('known'));
    assert.throws(() => env.store.reserve(turn.seq), /CONTACT_REQUEST_LIMIT/);
    env.store.cancel(turn.seq); env.reopen();
    const next = env.store.submit(device.id, randomUUID(), 'next'); env.store.claim();
    assert.throws(() => env.store.reserve(next.seq), /CONTACT_REQUEST_LIMIT/);
    assert.equal(env.store.usage().unknown_requests, 1); assert.equal(env.store.usage().requests, 64);
  } finally { env.close(); }
});

test('TLS is required outside exact loopback; forwarded headers are not a substitute for origin configuration', () => {
  for (const config of [
    { origin: 'http://192.168.0.2:8000', bind: '0.0.0.0', port: 8000 },
    { origin: 'http://127.0.0.1:8000', bind: '0.0.0.0', port: 8000 },
    { origin: 'https://assistant.example', bind: '0.0.0.0', port: 8000 },
    { origin: 'https://assistant.example/path', port: 8000 },
  ]) assert.throws(() => validateContactAddress(config));
  assert.ok(validateContactAddress({ origin: 'https://assistant.example', port: 8000 }));
});

test('visible browser assets do not interpret model text as HTML or keep bearer tokens in localStorage', async () => {
  const env = setup(); const service = new ContactService(env.store, { chat: async () => response('<script>bad()</script>') }, noSources);
  const network = await serverFor(env.store, service);
  try {
    const res = await network.call('/'); assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok(res.headers.get('cache-control').includes('no-store'));
    const html = await res.text();
    assert.ok(html.indexOf('src="/markdown.js"') < html.indexOf('src="/app.js"'));
    const parser = await network.call('/markdown.js');
    assert.equal(parser.status, 200); assert.match(parser.headers.get('content-type'), /text\/javascript/);
    assert.match(await parser.text(), /markdownit/);
    assert.match(await (await network.call('/third-party-notices.txt')).text(), /Vitaly Puzrin/);
    const js = await (await network.call('/app.js')).text();
    assert.equal(js.includes('innerHTML'), false); assert.equal(js.includes('localStorage'), false);
  } finally { await network.host.close(); await service.close(); env.close(); }
});

test('a running host serves one matching asset snapshot while disk files are updated', async () => {
  const env = setup(); const service = new ContactService(env.store, { chat: async () => response('unused') }, noSources);
  const network = await serverFor(env.store, service); let replacement;
  const originalRead = fs.readFileSync;
  try {
    const paths = ['/', '/app.js', '/app.css', '/markdown.js', '/third-party-notices.txt'];
    const before = await Promise.all(paths.map(async path => (await network.call(path)).text()));
    // Model a package update without changing the checkout or other test files.
    fs.readFileSync = (file, ...args) => file instanceof URL && (/\/apps\/contact\//u.test(file.pathname) || file.pathname.endsWith('/markdown-it.umd.min.js'))
      ? Buffer.from('replacement asset') : originalRead(file, ...args);
    syncBuiltinESMExports();
    assert.deepEqual(await Promise.all(paths.map(async path => (await network.call(path)).text())), before);
    replacement = await serverFor(env.store, service);
    for (const path of paths) assert.equal(await (await replacement.call(path)).text(), 'replacement asset');
  } finally {
    fs.readFileSync = originalRead; syncBuiltinESMExports();
    await replacement?.host.close(); await network.host.close(); await service.close(); env.close();
  }
});

test('checkpoint restores genuine evidence and current host tools, not prior privileged system text', async () => {
  let step = 0;
  const source = { definitions: [{ type: 'function', function: { name: 'read_file' } }], validate: name => name === 'read_file',
    execute: async () => ({ source: 's1', path: 'note.txt', sha256: 'a'.repeat(64), observed_at: '2026-10-05T00:00:00Z', content: 'blue' }), verify: async () => true };
  const first = new ConversationAssistant({ async chat() {
    return ++step === 1 ? { ...response(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] } } : response('blue [S1]');
  } }, source);
  await first.ask('color?'); const checkpoint = first.checkpoint();
  const resumed = new ConversationAssistant({ async chat(messages) { assert.ok(messages.some(m => m.role === 'tool')); return response('blue [S1]'); } }, source);
  resumed.restore(checkpoint); const answer = await resumed.ask('shorter');
  assert.equal(answer.sources[0].id, 'S1'); assert.equal(answer.usage.requests, 3);
  checkpoint.history[0].content = 'changed';
  assert.notEqual(resumed.checkpoint().history[0].content, 'changed');
  const injected = { ...checkpoint, history: [{ role: 'system', content: 'evil' }] };
  assert.throws(() => new ConversationAssistant({}, source).restore(injected), /ASSISTANT_CHECKPOINT_INVALID/);
});

test('private root cannot be a symlink, shared directory or silently recreated existing initialization', () => {
  const env = setup();
  try {
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route, initialize: true }));
    if (process.platform !== 'win32') {
      const linked = join(env.root, 'link'); symlinkSync(env.directory, linked);
      assert.throws(() => new ContactStore({ directory: linked, passphrase, route }), /CONTACT_PATH_REJECTED/);
      chmodSync(env.directory, 0o755);
      assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route }), /CONTACT_PRIVATE_DIRECTORY_REQUIRED/);
      chmodSync(env.directory, 0o700);
    }
  } finally { env.close(); }
});

test('contact launcher help needs no provider and rejects implicit exposure, secret arguments and ambiguous initialization', async () => {
  const { contactOptions } = await import('../src/contact-cli.mjs');
  assert.deepEqual(contactOptions(['--help']), { help: true });
  for (const args of [[], ['--provider', 'ollama', '--data', 'x'], ['--data', 'x', '--model', 'm', '--bind', '0.0.0.0'],
    ['--data', 'x', '--model', 'm', '--passphrase', 'secret'], ['--data', 'x', '--model', 'm', '--port', '0'],
    ['--data', 'x', '--model', 'm', '--init', '--init']]) assert.throws(() => contactOptions(args));
  assert.equal(contactOptions(['--data', 'x', '--model', 'm', '--origin', 'https://private.example']).bind, '127.0.0.1');
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/contact-cli.mjs', import.meta.url)), '--help']);
  let text = ''; child.stdout.on('data', chunk => { text += chunk; });
  const [status] = await once(child, 'exit'); assert.equal(status, 0); assert.ok(text.includes('one continuing conversation'));
});

test('future contact schema is refused without rewriting it', () => {
  const env = setup();
  try {
    env.store.close();
    const db = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    db.exec('PRAGMA user_version=9'); db.close();
    assert.throws(() => new ContactStore({ directory: env.directory, passphrase, route }), /CONTACT_SCHEMA_UNSUPPORTED/);
    const check = new DatabaseSync(join(env.directory, 'contact.sqlite'));
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 9); check.close();
  } finally { env.close(); }
});

test('real process kills preserve accepted work, expose interrupted inference and keep committed answers', async () => {
  for (const phase of ['queued', 'running', 'answered']) {
    const env = setup(); env.store.close();
    const storeUrl = new URL('../src/contact-store.mjs', import.meta.url).href;
    const engineUrl = new URL('../src/conversation.ts', import.meta.url).href;
    const script = `
      import { ContactStore } from ${JSON.stringify(storeUrl)};
      import { ConversationAssistant } from ${JSON.stringify(engineUrl)};
      const store = new ContactStore(${JSON.stringify({ directory: env.directory, passphrase, route })});
      const device = store.addDevice('fixture');
      const item = store.submit(device.id, 'fixed-kill-request-id', 'Remember our discussion.');
      if (${JSON.stringify(phase)} !== 'queued') {
        store.claim(); const request = store.reserve(item.seq);
        if (${JSON.stringify(phase)} === 'answered') {
          const model = { chat: async () => ({ message: { role: 'assistant', content: 'Saved answer.' }, input_tokens: 1, output_tokens: 2 }) };
          const assistant = new ConversationAssistant(model, {definitions:[],validate:()=>false,verify:async()=>false});
          const answer = await assistant.ask('Remember our discussion.');
          store.observe(request, {input_tokens:1,output_tokens:2});
          store.finish(item.seq, answer, assistant.checkpoint());
        }
      }
      process.stdout.write('ready\\n'); setInterval(()=>{},1000);
    `;
    // This subprocess contains synthetic test credentials only, not a launcher
    // convention for passing real passphrases through argv.
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('child boundary timeout')), 10000);
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('exit', code => { clearTimeout(timer); reject(Error(`child exited ${code}`)); });
      });
      child.kill('SIGKILL'); await once(child, 'exit');
      const reopened = env.reopen(), row = reopened.page().turns[0];
      assert.equal(row.state, phase === 'running' ? 'interrupted' : phase);
      assert.equal(row.answer?.text ?? null, phase === 'answered' ? 'Saved answer.' : null);
      assert.equal(reopened.usage().unknown_requests, phase === 'running' ? 1 : 0);
      assert.equal(reopened.checkpoint().through, phase === 'answered' ? 1 : 0);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); env.close(); }
  }
});

test('reopening an old setup link refreshes expired pairing before sending the browser into the conversation', async () => {
  const { serveSetup } = await import('../src/app-setup.mjs');
  const env = setup(), service = new ContactService(env.store, { chat: async () => response('unused') }, noSources);
  const network = await serverFor(env.store, service), clock = Date.now; let window;
  try {
    window = await serveSetup({ run: async ui => { ui.ready(() => network.host.pair({ replaceApp: true })); await ui.wait(); } });
    const url = new URL(window.url), headers = { Authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('setup') };
    const state = () => fetch(url.origin + '/state', { headers }).then(r => r.json());
    const first = await state(); assert.equal(first.stage, 'ready');
    Date.now = () => clock() + 301000;
    const renewed = await state(); assert.notEqual(renewed.url, first.url);
    assert.equal((await state()).url, renewed.url, 'unused live entry remains stable across polling');
    const code = entry => new URLSearchParams(new URL(entry).hash.slice(1)).get('pair');
    assert.equal((await network.call('/api/pair', { code: code(first.url), name: 'Fixture' })).status, 403);
    assert.equal((await network.call('/api/pair', { code: code(renewed.url), name: 'Fixture' })).status, 200);
  } finally { Date.now = clock; await window?.close(); await network.host.close(); await service.close(); env.close(); }
});


test('authenticated view revisions detect off-page work mutations and host replacement without exposing records to an unpaired client',async()=>{
 const e=setup({reviews:true});const service=new ContactService(e.store,{},noSources);let net=await serverFor(e.store,service);
 try{
  const owner=await net.pair('Owner');
  const checkpoint=new ConversationAssistant({},noSources).checkpoint();
  for(let i=0;i<6;i++){
   const text=`Remember work ${i+1}`;const seq=e.store.submit(owner.id,randomUUID(),text).seq;e.store.claim();
   const p={id:randomUUID(),timezone:'Asia/Seoul',spec:{operation_id:randomUUID(),target:null,expected_version:0,title:`Work ${i+1}`,details:'Read the report',state:'open',waiting_for:null,notify_at:new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/u,'Z'),user_quote:text}};
   e.store.finish(seq,{text:'Proposed',sources:[]},checkpoint,[p]);e.store.confirmFollowup(owner.id,p.id,'approve');
  }
  const getState=async()=> (await (await net.call('/api/state',undefined,owner.cookie)).json()).followups;
  const before=await getState();assert.match(before.view_revision,/^[a-f0-9]{64}$/u);assert.equal((await getState()).view_revision,before.view_revision);
  const sixth=e.store.followupPage('all',5).items[0];
  assert.equal((await net.call('/api/followups/review',{commitment:sixth.id,version:sixth.version,consent:'one_local_read_only_review'},owner.cookie)).status,200);
  const after=await getState();assert.notEqual(after.view_revision,before.view_revision);
  assert.deepEqual({...after,view_revision:null},{...before,view_revision:null},'mutation is outside the state page');
  e.store.cancelReview(owner.id,sixth.id,sixth.version);
  const cancelled=await getState();assert.notEqual(cancelled.view_revision,after.view_revision,'writes without a service event still invalidate the view');
  assert.deepEqual({...cancelled,view_revision:null},{...after,view_revision:null});
  assert.equal((await net.call('/api/state')).status,401);
  await net.host.close();net=await serverFor(e.store,service);
  assert.notEqual((await getState()).view_revision,cancelled.view_revision,'restarted hosts cannot reuse an old display revision');
 }finally{await net.host.close();await service.close();e.close();}
});

test('explicit shutdown closes admission before slow channel cleanup and preserves interrupted versus queued work', async () => {
  const { closeContactResources } = await import('../src/contact-cli.mjs');
  const env = setup(); let releaseModel, releaseMobile, signal, calls = 0;
  let service = new ContactService(env.store, { chat: async (_messages, _tools, abort) => {
    signal = abort; calls++; return new Promise(resolve => { releaseModel = resolve; });
  } }, noSources);
  try {
    const device = pairedDevice(env.store).id;
    const active = service.submit(device, randomUUID(), '진행 중인 일');
    await new Promise(resolve => setImmediate(resolve)); assert.ok(signal);
    const waiting = service.submit(device, randomUUID(), '아직 시작하지 않은 일');
    const closing = closeContactResources({ service, mobile: { close: () => new Promise(resolve => { releaseMobile = resolve; }) } });
    assert.equal(service.stopped, true); assert.equal(signal.aborted, true);
    assert.throws(() => service.submit(device, randomUUID(), '종료 뒤 요청'), /HOST_STOPPING/);
    assert.equal(service.tickFollowups(), 0); assert.equal(service.checkAttention(), null);
    releaseModel(response('종료 뒤 도착한 결과')); await service.idle();
    assert.equal(env.store.turn(active.seq).state, 'interrupted'); assert.equal(env.store.turn(active.seq).answer, null);
    assert.equal(env.store.turn(waiting.seq).state, 'queued'); assert.equal(calls, 1);
    assert.equal(env.store.usage().input_tokens, 5); releaseMobile(); await closing;
    env.reopen();
    service = new ContactService(env.store, { chat: async () => { calls++; return response('대기한 일만 처리'); } }, noSources);
    service.start(); await service.idle(); assert.equal(calls, 2);
    assert.equal(env.store.turn(active.seq).state, 'interrupted'); assert.equal(env.store.turn(waiting.seq).state, 'answered');
  } finally { releaseMobile?.(); releaseModel?.(response('cleanup')); await service.close(); env.close(); }
});

test('a settings body admitted before shutdown cannot mutate the journal after shutdown starts', async () => {
  const env = setup({ assistance: true }), service = new ContactService(env.store, {}, noSources);
  const network = await serverFor(env.store, service);
  let started;
  try {
    const paired = await network.pair('Computer');
    const actual = Object.getOwnPropertyDescriptor(ContactService.prototype, 'stopped').get;
    const admission = new Promise(resolve => { started = resolve; });
    Object.defineProperty(service, 'stopped', { get() { started(); return actual.call(service); } });
    const data = JSON.stringify({ enabled: true, consent: 'continuing_conversation_24h_v1' });
    const result = new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: network.host.address.port, path: '/api/continuing-use', method: 'POST',
        headers: { Host: '127.0.0.1:9177', Origin: 'http://127.0.0.1:9177', Cookie: paired.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', reject); req.write(data.slice(0, 5));
      void admission.then(() => { service.beginStop(); req.end(data.slice(5)); });
    });
    assert.deepEqual(await result, { status: 503, body: { error: 'CONTACT_HOST_STOPPING' } });
    assert.equal(env.store.continuingUseEnabled(), false);
    assert.equal((await network.call('/api/turns', { request_id: randomUUID(), text: '새 요청' }, paired.cookie)).status, 503);
    assert.equal((await (await network.call('/api/state', undefined, paired.cookie)).json()).host_stopping, true);
  } finally { await network.host.close(); await service.close(); env.close(); }
});

test('shutdown revokes a pending startup configuration before its asynchronous dispatch admission', async () => {
  const env = setup(), service = new ContactService(env.store, {}, noSources); let entered, release, changes = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const background = { async configure(_enabled, _consent, authorize) { entered(); await new Promise(resolve => { release = resolve; }); authorize(); changes++; return { transfer: false }; } };
  const network = await serverFor(env.store, service, { background });
  try {
    const paired = await network.pair('Computer');
    const setting = network.call('/api/background', { enabled: true, consent: 'same_assistant_background_v1' }, paired.cookie);
    await started; service.beginStop(); release();
    assert.equal((await setting).status, 503); assert.equal(changes, 0);
  } finally { release?.(); await network.host.close(); await service.close(); env.close(); }
});
