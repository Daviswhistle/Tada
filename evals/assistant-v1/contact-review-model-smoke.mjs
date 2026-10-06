// Live-model qualification of the contact path, not an assistant-v1 acceptance
// substitute. Fixture facts/oracles are never injected as system instructions.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { modelDiagnostics } from './model-diagnostics.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { request } from 'node:http';
import { OllamaLocal } from '../../packages/providers/src/ollama-local.mjs';
import { NativeSources, runReadGateway } from '../../packages/engine/src/native-sources.mjs';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';

const [binary, model] = process.argv.slice(2);
assert.ok(binary && isAbsolute(binary) && model, 'Choose the absolute read broker and installed local model explicitly');
const RealDate = Date;
const root = mkdtempSync(join(tmpdir(), 'tada-live-review-'));
const directory = join(root, 'journal'), documents = join(root, 'notes');
mkdirSync(documents);
const file = join(documents, 'launch-notes.md');
writeFileSync(file, '# Launch notes\nThe release gate has not been assigned.\n');
const sha = text => createHash('sha256').update(text).digest('hex');
const passphrase = randomBytes(32).toString('base64url');
const origin = 'http://127.0.0.1:9179';
let store, service, host, stage = 'setup', clockAdvanced = false;
const diagnostics = modelDiagnostics();
let modelRequest = 0;
const observed = [], checks = {}, evidence = {
  kind: 'real_local_contact_review', commit: process.env.GITHUB_SHA ?? 'local-unrecorded',
  fixture_data: true, due_clock: 'consistent_Date_only_fixture', io_deadlines: 'real_timers',
  wall_clock_started: new RealDate().toISOString(), physical_phone: false,
  telegram: 'not_run', broad_assistant_suite: 'not_run',
};
async function rpc(path, body, cookie = '') {
  return await new Promise((yes, no) => {
    const req = request({ hostname: '127.0.0.1', port: host.address.port, path,
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:9179', Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 262144) { res.destroy(); no(Error('CONTACT_EVAL_RESPONSE_LIMIT')); return; }
        chunks.push(chunk);
      });
      res.on('error', no);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.ok(res.statusCode >= 200 && res.statusCode < 300, `HTTP ${res.statusCode}: ${value.error ?? 'rejected'}`);
          yes({ value, cookie: res.headers['set-cookie']?.[0].split(';')[0] });
        } catch (error) { no(error); }
      });
    });
    req.on('error', no);
    req.setTimeout(10000, () => req.destroy(Error('CONTACT_EVAL_HTTP_TIMEOUT')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function start(provider, sources) {
  service = new ContactService(store, provider, sources, { timezone: 'UTC' });
  host = await serveContact({ store, service, origin, port: 0 });
  service.start();
}
async function stop() {
  await host?.close(); host = undefined;
  await service?.close(); service = undefined;
  store?.close();
}
async function pair(name) {
  const code = new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
  return (await rpc('/api/pair', { code, name })).cookie;
}
const check = (name, value) => { checks[name] = !!value; assert.equal(checks[name], true, name); };
try {
  const provider = new OllamaLocal({ model });
  const runtime = await provider.inspect(AbortSignal.timeout(20000)); evidence.runtime = runtime;
  const observedModel = { chat: async (messages, tools, signal) => {
    const request = ++modelRequest;
    diagnostics.record({ request, stage, kind: 'request',
      registered_tools: tools.map(tool => tool.function?.name),
      recent_tool_results: messages.filter(message => message.role === 'tool').slice(-8) });
    if (stage === 'scheduled_review') {
      const times = /Host time: (\S+)\. Due time: (\S+)\./u.exec(messages[0].content);
      check('scheduled_model_sees_due_time', !!times && Date.parse(times[1]) >= Date.parse(times[2]));
    }
    try {
      const response = await provider.chat(messages, tools, signal);
      diagnostics.record({ request, stage, kind: 'response', message: response.message,
        input_tokens: response.input_tokens, output_tokens: response.output_tokens });
      return response;
    } catch (error) {
      diagnostics.record({ request, stage, kind: 'error', code: /^[A-Z_]+$/u.test(error.message) ? error.message : 'PROVIDER_FAILURE' });
      throw error;
    }
  } };
  const native = new NativeSources(binary, [documents]);
  await native.initialize(AbortSignal.timeout(20000));
  const scope = await runReadGateway(binary, documents, '-', 'scope');
  const route = contactRoute({ runtime, source: documents, identity: scope.identity });
  // Instrument actual gateway calls without changing definitions, arguments,
  // returned data or grant decisions. The product chooses its own observations.
  const sources = {
    definitions: native.definitions,
    validate: (...args) => native.validate(...args),
    execute: async (...args) => {
      const result = await native.execute(...args);
      observed.push({ stage, tool: args[0], source: result.source, path: result.path, sha256: result.sha256 });
      return result;
    },
    verify: async (...args) => {
      const valid = await native.verify(...args);
      observed.push({ stage, tool: 'citation_recheck', sha256: args[0].sha256 });
      return valid;
    },
  };
  store = new ContactStore({ directory, passphrase, route, initialize: true, reviews: true });
  const identity = store.id;
  await start(observedModel, sources);
  const phone = await pair('Phone HTTP client'), pc = await pair('PC HTTP client');
  const due = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const utterance = `Remember to check the launch status at ${due} and tell me the blocker, its exact release gate, and the next action. Do not check it yet.`;
  evidence.user_utterance = utterance;
  stage = 'proposal';
  await rpc('/api/turns', { request_id: randomUUID(), text: utterance }, phone);
  await service.idle();
  const pending = (await rpc('/api/state', undefined, pc)).value;
  check('ordinary_utterance_answered', pending.turns.at(-1)?.state === 'answered');
  check('one_model_proposal', pending.followups.proposals.length === 1);
  const proposal = pending.followups.proposals[0];
  evidence.model_proposal = proposal.spec;
  check('requested_time_preserved', Date.parse(proposal.spec.notify_at) === Date.parse(due));
  check('not_activated_from_prose', pending.followups.items.length === 0);
  const saved = (await rpc('/api/followups/decision', { proposal_id: proposal.id, decision: 'approve' }, pc)).value;
  check('save_is_not_review_permission', store.reviewState(saved.commitment, saved.version) === null);
  await rpc('/api/followups/review', { commitment: saved.commitment, version: saved.version,
    consent: 'one_local_read_only_review' }, pc);
  const before = store.usage().requests;
  // New fixture facts exist ONLY in a permitted file, not in the prompt, saved
  // proposal or a fabricated tool response. The model must discover and read it.
  const gate = `gate-${randomBytes(4).toString('hex')}`;
  const updated = `# Launch notes\nStatus: blocked.\nRelease gate: ${gate}\nBlocker: safety sign-off from the release owner is missing.\nNext action: request that sign-off before launching.\n`;
  writeFileSync(file, updated);
  await stop();
  store = new ContactStore({ directory, passphrase, route });
  await start(observedModel, sources); await service.idle();
  check('same_assistant_after_restart', store.id === identity);
  check('no_early_or_replayed_inference', store.usage().requests === before);
  stage = 'scheduled_review';
  // Advance this evaluator's Date consistently, not just reviewTick's argument.
  // Otherwise the model sees a future appointment while being asked to execute
  // it now. Network deadlines and the host interval keep their real timers.
  mock.timers.enable({ apis: ['Date'], now: Date.parse(due) }); clockAdvanced = true;
  evidence.simulated_host_time = new Date().toISOString();
  service.tickFollowups(); service.start(); await service.idle();
  const review = store.reviewState(saved.commitment, saved.version);
  evidence.review = review;
  check('review_answered', review.state === 'answered');
  const answer = store.turn(review.turn).answer;
  check('new_file_read_during_review', observed.some(o => o.stage === stage && o.tool === 'read_file' && o.sha256 === sha(updated)));
  check('current_source_cited_and_rechecked', answer.sources.some(s => s.sha256 === sha(updated))
    && observed.some(o => o.stage === stage && o.tool === 'citation_recheck' && o.sha256 === sha(updated)));
  check('new_gate_reported', answer.text.includes(gate));
  check('work_not_marked_done', store.followup(saved.commitment).state === 'open'
    || store.followup(saved.commitment).state === 'waiting');
  const reviewRequests = store.usage().requests - before;
  check('existing_bounded_budget_used', reviewRequests > 0 && reviewRequests <= 8);
  check('no_duplicate_due_turn', store.reviewTick(Date.parse(due) + 1000) === 0);
  await stop();
  store = new ContactStore({ directory, passphrase, route });
  stage = 'followup'; await start(observedModel, sources); await service.idle();
  check('completed_review_not_replayed', store.usage().requests === before + reviewRequests);
  const followup = 'What is the exact release gate we just found? One short sentence.';
  evidence.followup_utterance = followup;
  await rpc('/api/turns', { request_id: randomUUID(), text: followup }, phone); await service.idle();
  const result = (await rpc('/api/state', undefined, pc)).value;
  check('other_device_sees_same_conversation', result.assistant === identity && result.turns.length === 3);
  check('followup_retains_observed_gate', result.turns.at(-1)?.state === 'answered'
    && result.turns.at(-1).answer.text.includes(gate));
} catch (error) {
  evidence.failure = { stage, message: error.message };
  process.exitCode = 1;
} finally {
  evidence.checks = checks; evidence.observations = observed;
  evidence.model_diagnostics = diagnostics.snapshot();
  evidence.wall_clock_finished = new RealDate().toISOString();
  if (store) {
    try {
      evidence.turns = store.page().turns.map(t => ({ text: t.text, state: t.state, answer: t.answer, error: t.error }));
      evidence.usage = store.usage();
    } catch { evidence.store_readback = 'unavailable'; }
  }
  console.log(JSON.stringify(evidence, null, 2));
  try { await stop(); } finally { if (clockAdvanced) mock.timers.reset(); rmSync(root, { recursive: true, force: true }); }
}
