// Real local-model smoke. Environment/oracle stay in this evaluator, not in model messages.
// This narrow two-variant run is not the full assistant-v1 product acceptance suite.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { OllamaLocal } from '../../packages/providers/src/ollama-local.mjs';
import { NativeSources } from '../../packages/engine/src/native-sources.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';

const binary = resolve(process.argv[2] ?? 'target/debug/tada-read-broker');
const model = process.argv[3];
if (!model) throw new Error('An explicitly installed local model is required');
const provider = new OllamaLocal({ model });
const identity = await provider.inspect(AbortSignal.timeout(20000));
const results = [];
const variants = [
  { owner: 'Nadia', blocker: 'certificate', action: 'renew', project: 'Cedar' },
  { owner: 'Mateo', blocker: 'packaging', action: 'replace', project: 'Cedar' },
];
for (let index = 0; index < variants.length; index++) {
  const expected = variants[index];
  const root = await mkdtemp(join(tmpdir(), 'tada-live-notes-'));
  const token = randomBytes(4).toString('hex');
  const projectDirectory = `work-${token}`;
  const trace = [];
  const utterance = 'What is blocking the Cedar launch, and who needs to do what next?';
  const followup = 'Make that shorter, in one sentence.';
  try {
    await mkdir(join(root, projectDirectory));
    await writeFile(join(root, 'index.md'), `Team documents are grouped under ${projectDirectory}. Other documents are unrelated personal notes.\n`);
    await writeFile(join(root, 'weather.md'), 'Unrelated: the weather was mild.\n');
    await writeFile(join(root, projectDirectory, `status-${token}.md`),
      `# Cedar launch status\nCurrent blocker: ${expected.blocker}.\nNext action: ${expected.owner} must ${expected.action} the ${expected.blocker} before launch.\nTracking code: ${token}.\n`);
    await writeFile(join(root, projectDirectory, 'other-project.md'), '# Willow\nWillow is complete and has no pending action. Owner: Sam.\n');
    const sources = new NativeSources(binary, [root]);
    await sources.initialize();
    // Only this synthetic evaluator records proposed tool arguments, to diagnose
    // rejected proposals. No prompt, reasoning text or oracle is logged/passed in.
    const observedModel = { async chat(messages, tools, signal) {
      const response = await provider.chat(messages, tools, signal);
      trace.push({ kind: 'model_proposals', calls: response.message.tool_calls ?? [] });
      return response;
    } };
    const assistant = new ConversationAssistant(observedModel, sources, event => trace.push(event));
    const first = await assistant.ask(utterance);
    const second = await assistant.ask(followup);
    const owner = new RegExp(expected.owner, 'iu');
    const blocker = new RegExp(expected.blocker, 'iu');
    const action = new RegExp(expected.action, 'iu');
    const checks = {
      correct_owner: owner.test(first.text) && owner.test(second.text),
      correct_blocker: blocker.test(first.text) && blocker.test(second.text),
      next_action: action.test(first.text) && action.test(second.text),
      sources_discovered: trace.some(e => e.kind === 'tool_call' && e.name === 'list_sources')
        && trace.some(e => e.kind === 'tool_call' && e.name === 'list_files'),
      actual_read: trace.some(e => e.kind === 'source_read' && e.evidence.path.endsWith(`status-${token}.md`)),
      citations_checked: first.verification === 'cited_sources_rechecked' && second.verification === 'cited_sources_rechecked',
      followup_shorter: second.text.length < first.text.length,
    };
    results.push({ variant: index + 1, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
      user: [utterance, followup], responses: [first.text, second.text], checks,
      observations: trace, usage: second.usage });
  } catch (error) {
    results.push({ variant: index + 1, status: 'failed', error: String(error.message), observations: trace });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const report = { kind: 'real_local_model_smoke', product_acceptance_suite: 'not_run',
  runtime: identity, commit: process.env.GITHUB_SHA ?? 'local-unrecorded',
  fixed_variants: variants.length, synthetic_data_only: true, results };
console.log(JSON.stringify(report, null, 2));
assert.equal(results.length, 2);
assert.ok(results.every(result => result.status === 'passed'), 'Every predetermined variant must pass; keep failed evidence');
