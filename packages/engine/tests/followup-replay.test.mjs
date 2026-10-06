import test from 'node:test';
import assert from 'node:assert/strict';
import { FollowupSources, FOLLOWUP_TOOLS } from '../src/followup-sources.mjs';
import { validateFollowupProposal } from '../src/followup-contract.mjs';

const utterance = 'Remember to check the status tomorrow.';
const now = Date.UTC(2026, 9, 7);
const spec = () => ({ operation_id: 'remember_status', target: null, expected_version: 0,
  title: 'Check status', details: 'Inspect the latest status and report the next action.',
  state: 'open', waiting_for: null, notify_at: '2026-10-08T00:00:00Z', user_quote: utterance });
const port = () => new FollowupSources({ definitions: [], validate: () => false },
  { contactVersion: 4 }, { text: utterance }, 'UTC', () => now);

test('reordered keys in an identical validated proposal do not create a false operation-ID conflict', async () => {
  const sources = port(), value = spec(), signal = new AbortController().signal;
  const first = await sources.execute('propose_followup', value, signal);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  const repeated = await sources.execute('propose_followup', reordered, signal);
  assert.deepEqual(repeated, first);
  assert.equal(sources.proposals().length, 1);
  assert.deepEqual(sources.proposals()[0].spec, value);
});

test('a replay cannot change any immutable field or add undeclared authority', async () => {
  const sources = port(), value = spec(), signal = new AbortController().signal;
  await sources.execute('propose_followup', value, signal);
  const changed = [
    { title: 'Different title' }, { details: 'Different scope' },
    { notify_at: '2026-10-09T00:00:00Z' }, { notify_at: null },
    { state: 'waiting', waiting_for: 'An external reply' }, { user_quote: 'check the status' },
  ];
  for (const fields of changed) {
    await assert.rejects(sources.execute('propose_followup', { ...value, ...fields }, signal), /CONTACT_FOLLOWUP_ID_REUSED/);
  }
  for (const fields of [{ send_email: true }, { expected_version: '0' }, { target: 'null' }]) {
    await assert.rejects(sources.execute('propose_followup', { ...value, ...fields }, signal), /CONTACT_FOLLOWUP_INVALID/);
  }
  assert.equal(sources.proposals().length, 1);
});

test('proposal schema explains existing cross-field requirements without relaxing their validator', () => {
  const properties = FOLLOWUP_TOOLS.find(t => t.function.name === 'propose_followup').function.parameters.properties;
  for (const field of ['operation_id', 'target', 'expected_version', 'title', 'details', 'state', 'waiting_for', 'notify_at', 'user_quote']) {
    assert.ok(typeof properties[field].description === 'string' && properties[field].description.length > 10, field);
  }
  assert.doesNotThrow(() => validateFollowupProposal(spec(), utterance, now));
  for (const fields of [{ target: 'guessed-id' }, { expected_version: 1 }, { state: 'waiting' },
    { waiting_for: 'Not allowed on an open item' }, { user_quote: 'An invented authorization' },
    { notify_at: 'tomorrow' }, { notify_at: '2026-10-08T00:00:00' }]) {
    assert.throws(() => validateFollowupProposal({ ...spec(), ...fields }, utterance, now), /CONTACT_FOLLOWUP_/);
  }
});
