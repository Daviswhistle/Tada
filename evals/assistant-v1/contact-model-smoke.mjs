// Real local inference through two authenticated HTTP clients and a reopened
// encrypted journal. This is not a full assistant/phone/notification evaluation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { OllamaLocal } from '../../packages/providers/src/ollama-local.mjs';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';

const model = process.argv[2];
if (!model) throw Error('Choose an installed local model explicitly');
const provider = new OllamaLocal({ model });
const runtime = await provider.inspect(AbortSignal.timeout(20000));
const route = contactRoute(runtime), passphrase = randomBytes(32).toString('base64url');
const root = mkdtempSync(join(tmpdir(), 'tada-contact-live-')), directory = join(root, 'private');
const sources = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_CONNECTED_SOURCE'); }, verify: async () => false };
let store = new ContactStore({ directory, passphrase, route, initialize: true });
let service, host;
const origin = 'http://127.0.0.1:9177';
function call(path, body, cookie = '') {
  return new Promise((yes, no) => {
    const req = request({ hostname: '127.0.0.1', port: host.address.port, path,
      method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1:9177', Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          assert.ok(res.statusCode >= 200 && res.statusCode < 300, `HTTP ${res.statusCode}`);
          yes({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), cookie: res.headers['set-cookie']?.[0].split(';')[0] });
        } catch (error) { no(error); }
      });
    }); req.on('error', no); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function start() {
  service = new ContactService(store, provider, sources);
  host = await serveContact({ store, service, origin, port: 0 }); service.start();
}
async function pair(name) {
  const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
  return (await call('/api/pair', { code, name })).cookie;
}
try {
  await start(); const phone = await pair('Phone'), pc = await pair('PC');
  const first = 'I am preparing for a chemistry exam on Friday. Help me think of a manageable plan for today in two sentences.';
  await call('/api/turns', { request_id: randomUUID(), text: first }, phone);
  // The phone request is already closed. The host, not that client, owns work.
  await service.idle();
  const fromPC = (await call('/api/state', undefined, pc)).body;
  assert.equal(fromPC.turns[0].state, 'answered');
  const before = fromPC.usage.requests;
  await host.close(); await service.close(); store.close();
  store = new ContactStore({ directory, passphrase, route }); await start();
  const followup = 'What am I preparing for, and on which day? One short sentence, please.';
  await call('/api/turns', { request_id: randomUUID(), text: followup }, pc); await service.idle();
  const fromPhone = (await call('/api/state', undefined, phone)).body;
  const last = fromPhone.turns[1];
  const checks = {
    same_assistant: fromPC.assistant === fromPhone.assistant,
    two_paired_clients: fromPC.device !== fromPhone.device,
    retained_original: fromPhone.turns[0].text === first && fromPhone.turns[0].answer.text === fromPC.turns[0].answer.text,
    reply_after_reopen: last.state === 'answered',
    remembers_subject: /chemistry/iu.test(last.answer?.text ?? ''),
    remembers_day: /Friday/iu.test(last.answer?.text ?? ''),
    no_replayed_inference: fromPhone.usage.requests === before + 1,
    no_browser_checkpoint: !Object.hasOwn(fromPhone, 'checkpoint'),
  };
  console.log(JSON.stringify({ kind: 'real_local_contact_continuity', commit: process.env.GITHUB_SHA ?? 'local-unrecorded', runtime,
    scenario: [first, followup], responses: fromPhone.turns.map(t => t.answer?.text), checks,
    usage: fromPhone.usage, synthetic_personal_context: true, public_deployment: false,
    physical_phone: false, broad_assistant_suite: 'not_run' }, null, 2));
  assert.ok(Object.values(checks).every(Boolean), 'Keep failed continuity checks in evidence');
} finally { await host?.close(); await service?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
