// Actual abrupt process termination; isolated synthetic records and loopback mail only.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ContactStore, contactRoute } from '../packages/engine/src/contact-store.mjs';
import { ContactService } from '../packages/engine/src/contact-service.mjs';
import { serveContact } from '../packages/engine/src/contact-http.mjs';
import { ConversationAssistant } from '../packages/engine/src/conversation.ts';
import { GoogleConnection } from '../packages/engine/src/google-connection.mjs';
import { GOOGLE_SEND_SCOPES } from '../packages/engine/src/google-contract.mjs';
import { MAIL_SEND_CONSENT } from '../packages/engine/src/mail-actions.mjs';
const base = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const origin = 'http://127.0.0.1:9177';
const options = root => ({ directory: join(root, 'journal'), passphrase: 'SYNTHETIC_CRASH_RECORDS_ONLY', route: contactRoute({ fixture: 'crash-acceptance' }) });
async function until(probe, label) { for (let i = 0; i < 1000; i++) { const result = await probe(); if (result) return result; await delay(10); } throw Error(`TIMEOUT: ${label}`); }
const response = () => ({ message: { role: 'assistant', content: '합성 응답입니다.' }, input_tokens: 3, output_tokens: 2 });
if (process.argv[2] === '--host') {
  const [root, stage, remote] = process.argv.slice(3);
  const store = new ContactStore({ ...options(root), initialize: stage === 'initial', mail: true });
  let calls = 0; const faults = [];
  const model = { identity: { provider: 'chatgpt-subscription', model: 'synthetic-crash-adapter' }, contextLimitBytes: 65536,
    async chat(messages) {
      calls++;
      if (stage === 'initial' && messages.findLast(m => m.role === 'user')?.content === '중단 경계를 측정해 줘.') {
        process.send({ type: 'entered' }); return new Promise(() => {});
      }
      return response();
    } };
  const service = new ContactService(store, model, base); service.on('fault', x => faults.push(x));
  if (remote) service.attachGoogle(new GoogleConnection({ store, clientId: 'fixture-crash.apps.googleusercontent.com', clientSecret: 'fixture-only',
    testEndpoints: { token: `${remote}/token`, revoke: `${remote}/revoke`, gmail: `${remote}/gmail/v1`, calendar: `${remote}/calendar/v3` } }));
  const host = await serveContact({ store, service, origin, port: 0 });
  process.on('message', async message => {
    try {
      let value;
      if (message.command === 'snapshot') value = { calls, faults, page: store.page(), usage: store.usage(), checkpoint: store.checkpoint(), mail: message.id ? store.mailAction(message.id) : null };
      else if (message.command === 'seed-mail') {
        const device = message.device;
        store.saveGoogleCredential(device, { version: 2, send_enabled: true, epoch: randomUUID(), device, scopes: [...GOOGLE_SEND_SCOPES],
          refresh_token: 'SYNTHETIC_REFRESH_TOKEN_ONLY_123456789', email: 'owner@example.test', connected_at: Date.now(), last_checked: null, last_error: null, reconnect_required: false }, null);
        const text = '합성 메일을 준비해 줘.', seq = store.submit(device, randomUUID(), text).seq; store.claim();
        const record = store.prepareMail(seq, { account: 'owner@example.test', to: ['receiver@example.test'], cc: [], bcc: [], subject: '합성 종료 시험', body: '이 메일은 실제 외부로 전달되지 않습니다.', reply: null });
        const cp = new ConversationAssistant({}, base).checkpoint(); cp.history = [{ role: 'user', content: text }, { role: 'assistant', content: '초안을 준비했어요.' }];
        store.finish(seq, { text: cp.history[1].content, sources: [] }, cp, [], null, null, record); value = record;
      } else if (message.command === 'close') { await service.close(); await host.close(); store.close(); value = true; }
      else throw Error('FIXTURE_COMMAND');
      process.send({ type: 'reply', key: message.key, value }, () => { if (message.command === 'close') process.disconnect(); });
    } catch (error) { process.send({ type: 'reply', key: message.key, error: String(error.stack) }); }
  });
  service.start(); await service.idle();
  process.send({ type: 'ready', port: host.address.port, pair: host.pair() });
} else {
  const output = process.argv[2]; assert.ok(output && process.argv.length === 3, 'Usage: node --experimental-strip-types scripts/contact-crash-acceptance.mjs REPORT.json');
  const report = { version: 1, started: new Date().toISOString(), platform: process.platform, node: process.version, planned: { inference: 50, mail: 50 }, samples: [], passed: false,
    scope: 'Actual ContactService/HTTP child SIGKILL and same encrypted journal restart. Synthetic model and independently retained loopback mail server; no owner data, real provider or external delivery. Not the whole 1000-transition release suite.' };
  try {
    for (const kind of ['inference', 'mail']) for (let index = 0; index < 50; index++) {
      const sample = { kind, index, passed: false }; report.samples.push(sample);
      await trial(kind, index, sample); sample.passed = true;
      if ((index + 1) % 10 === 0) console.log(`${kind}: ${index + 1}/50`);
    }
    report.passed = true;
  } catch (error) { report.error = String(error.stack); process.exitCode = 1; }
  finally { report.finished = new Date().toISOString(); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ passed: report.passed, samples: report.samples.length, error: report.error })); }
}
function launch(root, stage, remote = '') {
  const child = fork(fileURLToPath(import.meta.url), ['--host', root, stage, remote], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; let stderr = '', failure; child.stderr.on('data', x => { stderr = (stderr + x).slice(-4096); });
  child.on('error', error => { failure ??= error; });
  child.on('message', x => messages.push(x));
  const wait = async predicate => until(() => {
    if (failure) throw failure;
    const at = messages.findIndex(predicate); if (at !== -1) return messages.splice(at, 1)[0];
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`CHILD_EXIT: ${child.exitCode}/${child.signalCode} ${stderr}`);
    return null;
  }, 'child IPC');
  const command = async (command, args = {}) => {
    const key = randomUUID();
    child.send({ command, key, ...args }, error => { if (error) failure ??= error; });
    const reply = await wait(x => x.type === 'reply' && x.key === key); assert.equal(reply.error, undefined); return reply.value;
  };
  const kill = async (measured = false) => {
    if (measured) { assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); }
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const end = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true);
    let timer;
    try {
      const [code, signal] = await Promise.race([end, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CHILD_KILL_TIMEOUT')), 10000); })]);
      if (measured) assert.equal(signal, 'SIGKILL');
      return { requested: 'SIGKILL', code, signal };
    } finally { clearTimeout(timer); }
  };
  return { child, wait, command, kill };
}
function http(port, path, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Host: '127.0.0.1:9177', Origin: origin, 'Content-Type': 'application/json', Cookie: cookie } }, res => {
      res.on('error', reject); res.on('aborted', () => reject(Error('HTTP_ABORTED')));
      const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(10000, () => req.destroy(Error('HTTP_TIMEOUT'))); req.on('error', reject); req.end(JSON.stringify(body));
  });
}
function sentCopy(raw) {
  const mime = Buffer.from(raw, 'base64url').toString('utf8'), split = mime.indexOf('\r\n\r\n'); assert.ok(split > 0);
  const headers = mime.slice(0, split).replace(/\r\n[ \t]+/gu, ' ').split('\r\n').map(line => { const at = line.indexOf(':'); return { name: line.slice(0, at), value: line.slice(at + 1).trim() }; });
  return { id: 'sent1', threadId: 'thread1', labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from(mime.slice(split + 4).replaceAll('\r\n', ''), 'base64').toString('base64url') } } };
}
async function trial(kind, index, sample) {
  const root = mkdtempSync(join(tmpdir(), 'tada-hard-crash-')); let host, remote, remoteError, posts = 0, copy, reads = 0;
  const available = index % 2 === 0;
  try {
    if (kind === 'mail') {
      const handle = async (req, res) => {
        const path = new URL(req.url, 'http://127.0.0.1').pathname; const chunks = []; for await (const chunk of req) chunks.push(chunk);
        let body;
        if (path === '/token') body = { access_token: 'SYNTHETIC_ACCESS_TOKEN_ONLY_123456789', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SEND_SCOPES.join(' ') };
        else if (req.method === 'POST' && path.endsWith('/send')) { copy = sentCopy(JSON.parse(Buffer.concat(chunks).toString()).raw); posts++; return; /* Persist actual bytes; deliberately no response. */ }
        else if (req.method === 'GET') { reads++; if (!available) { res.statusCode = 503; body = { error: 'synthetic unavailable' }; } else body = path.endsWith('/messages') ? { messages: [{ id: copy.id }] } : copy; }
        else { res.statusCode = 404; body = {}; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
      };
      remote = createServer((req, res) => { void handle(req, res).catch(error => { remoteError ??= error; res.destroy(); }); });
      remote.on('error', error => { remoteError ??= error; });
      const listening = once(remote, 'listening'); remote.listen(0, '127.0.0.1'); await listening;
    }
    const endpoint = remote ? `http://127.0.0.1:${remote.address().port}` : '';
    host = launch(root, 'initial', endpoint); const ready = await host.wait(x => x.type === 'ready');
    const code = new URLSearchParams(new URL(ready.pair).hash.slice(1)).get('pair');
    const paired = await http(ready.port, '/api/pair', { code, name: 'Synthetic crash device' }); assert.equal(paired.status, 200);
    const cookie = paired.headers['set-cookie'][0].split(';')[0]; let before, record, interrupted, requestId, pending;
    if (kind === 'inference') {
      const canary = await http(ready.port, '/api/turns', { request_id: randomUUID(), text: '합성 대화를 시작해 줘.' }, cookie); assert.equal(canary.status, 202);
      before = await until(async () => { const s = await host.command('snapshot'); return s.page.turns.find(t => t.seq === canary.body.seq)?.state === 'answered' ? s : null; }, 'canary answer');
      assert.equal(before.calls, 1); requestId = randomUUID();
      interrupted = await http(ready.port, '/api/turns', { request_id: requestId, text: '중단 경계를 측정해 줘.' }, cookie); assert.equal(interrupted.status, 202);
      await host.wait(x => x.type === 'entered');
      const active = await host.command('snapshot'); assert.equal(active.calls, 2); assert.equal(active.usage.requests, 2); assert.equal(active.page.turns.find(t => t.seq === interrupted.body.seq).state, 'running');
    } else {
      record = await host.command('seed-mail', { device: paired.body.device });
      pending = http(ready.port, '/api/mail/send', { id: record.id, revision: record.revision, sha256: record.sha256, consent: MAIL_SEND_CONSENT }, cookie).then(value => ({ value }), error => ({ error: error.code ?? error.message }));
      await until(() => { if (remoteError) throw remoteError; return posts === 1; }, 'remote accepted POST'); before = await host.command('snapshot', { id: record.id }); assert.equal(before.mail.state, 'DISPATCHING');
      assert.ok(before.mail.attempt); assert.ok(copy.payload.headers.some(h => h.name.toLowerCase() === 'message-id'));
    }
    sample.termination = await host.kill(true); if (pending) { const lost = await pending; assert.ok(lost.error, 'send response must be absent at kill'); }
    host = launch(root, 'restart', endpoint); const restarted = await host.wait(x => x.type === 'ready');
    const recovered = await host.command('snapshot', { ...(record ? { id: record.id } : {}) }); assert.equal(recovered.calls, 0); assert.deepEqual(recovered.faults, []);
    assert.deepEqual(recovered.checkpoint, before.checkpoint);
    if (kind === 'inference') {
      const interruptedTurn = recovered.page.turns.find(t => t.seq === interrupted.body.seq);
      assert.equal(interruptedTurn.state, 'interrupted'); assert.equal(interruptedTurn.error, 'HOST_RESTARTED'); assert.ok(!interruptedTurn.answer);
      assert.equal(recovered.usage.requests, 2); assert.equal(recovered.usage.unknown_requests, 1);
      assert.deepEqual(recovered.page.turns.find(t => t.seq === before.page.turns[0].seq), before.page.turns[0]);
      const replay = await http(restarted.port, '/api/turns', { request_id: requestId, text: '중단 경계를 측정해 줘.' }, cookie);
      assert.equal(replay.status, 202); assert.deepEqual(replay.body, { seq: interrupted.body.seq, replay: true });
      const after = await host.command('snapshot'); assert.equal(after.calls, 0); assert.equal(after.usage.requests, 2);
      const next = await http(restarted.port, '/api/turns', { request_id: randomUUID(), text: '새 합성 대화를 이어가 줘.' }, cookie); assert.equal(next.status, 202);
      const final = await until(async () => { const s = await host.command('snapshot'); return s.page.turns.find(t => t.seq === next.body.seq)?.state === 'answered' ? s : null; }, 'new answer after recovery');
      assert.equal(final.calls, 1); assert.equal(final.usage.requests, 3); assert.equal(final.usage.unknown_requests, 1); assert.deepEqual(final.faults, []);
      sample.requests_after_restart = final.usage.requests; sample.unknown_requests = final.usage.unknown_requests;
    } else {
      assert.equal(recovered.mail.state, 'UNCERTAIN'); assert.deepEqual(recovered.mail.attempt, before.mail.attempt); assert.deepEqual(recovered.mail.draft, record.draft); assert.equal(recovered.mail.sha256, record.sha256); assert.equal(posts, 1);
      const replay = await http(restarted.port, '/api/mail/send', { id: record.id, revision: record.revision, sha256: record.sha256, consent: MAIL_SEND_CONSENT }, cookie);
      assert.equal(replay.status, 400); assert.equal(replay.body.error, 'CONTACT_MAIL_ALREADY_DISPATCHED'); assert.equal(posts, 1);
      const checked = await http(restarted.port, '/api/mail/reconcile', { id: record.id }, cookie);
      assert.equal(checked.status, 200); assert.equal(checked.body.mail.state, available ? 'VERIFIED' : 'UNCERTAIN'); assert.ok(reads > 0); assert.equal(posts, 1);
      const final = await host.command('snapshot'); assert.equal(final.calls, 0); assert.deepEqual(final.faults, []); sample.query_available = available; sample.state = checked.body.mail.state; sample.remote_posts = posts; sample.remote_reads = reads;
    }
    await host.command('close'); await until(() => host.child.exitCode !== null, 'orderly fixture cleanup');
    if (remoteError) throw remoteError;
  } finally {
    try { await host?.kill(); }
    finally {
      try { if (remote) { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); } }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
}
