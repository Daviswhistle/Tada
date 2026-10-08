import { randomUUID } from 'node:crypto';
import { validateFollowupProposal, followupTimezone } from './followup-contract.mjs';

const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
export const FOLLOWUP_TOOLS = [
  tool('list_followups', 'Read current commitments/proposals before reporting or revising work.', {
    status: { type: 'string', enum: ['active', 'all'] }, offset: { type: 'integer', minimum: 0, maximum: 1000 },
  }, ['status', 'offset']),
  tool('propose_followup', 'Stage user-requested work; owner confirmation of summary/time activates it. List first for updates. No source-file authorization, repeats, third-party sending or mailbox watching. Scheduled inference needs separate owner approval.', {
    operation_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$',
      description: 'Stable within this turn; reuse only for identical fields.' },
    target: { ...nullableString, description: 'New: null. Update: exact id from list_followups.' },
    expected_version: { type: 'integer', minimum: 0, description: 'New: 0. Update: current version from list_followups.' },
    title: { ...string, description: 'Nonempty user-requested title; max 240 UTF-8 bytes.' },
    details: { ...string, description: 'Preserve scope/result/authority; max 2400 UTF-8 bytes.' },
    state: { type: 'string', enum: ['open', 'waiting', 'done', 'cancelled'],
      description: 'New: open/waiting. Waiting needs an external dependency. done/cancelled need an existing target.' },
    waiting_for: { ...nullableString, description: 'Nonempty dependency for waiting; null otherwise.' },
    notify_at: { ...nullableString, description: 'User-authorized future ISO time, seconds and Z/offset; null for no alert.' },
    user_quote: { ...string, description: 'Exact nonempty request substring from CURRENT human message; max 1500 UTF-8 bytes.' },
  }, ['operation_id', 'target', 'expected_version', 'title', 'details', 'state', 'waiting_for', 'notify_at', 'user_quote']),
];

export class FollowupSources {
  #base; #store; #job; #proposals = new Map(); #timezone; #clock; #localReviews;
  constructor(base, store, job, timezone, clock = Date.now, localReviews = true) {
    this.#base = base; this.#store = store; this.#job = job;
    this.#timezone = followupTimezone(timezone); this.#clock = clock; this.#localReviews = localReviews;
    const names = base.definitions.map(d => d?.function?.name);
    if (FOLLOWUP_TOOLS.some(d => names.includes(d.function.name))) throw new Error('CONTACT_TOOL_COLLISION');
  }
  get definitions() { return [...this.#base.definitions, ...structuredClone(FOLLOWUP_TOOLS)]; }
  get hostContext() {
    const proactive = this.#store.proactiveStatus();
    const standing = proactive.available ? ` Daily proactive suggestions from saved conversation/work/documents are ${proactive.enabled ? 'enabled' : 'disabled'} in Settings. This does not authorize other background tasks, new source access or changes. The owner can control it in Settings.` : '';
    const base = this.#base.hostContext ? `${this.#base.hostContext}\n` : '';
    return `${base}Host time: ${new Date(this.#clock()).toISOString()}; timezone: ${this.#timezone}. Retrieve saved work before changes. Proposals need owner confirmation; do not investigate deferred work early.${this.#store.contactVersion >= 4 && this.#localReviews ? ' After saving, the owner may separately approve one local read-only review on its card or via /review COMMITMENT_ID VERSION in Telegram. Only an armed review runs later; a reminder alone does not. Review results do not prove completion.' : ' No automatic source reviews with this provider. Reminders never run a model; offer investigation now or a reminder.'}${standing}`; }
  get verificationKind() { return this.#base.verificationKind; }
  isEvidenceRead(name) { return this.#base.isEvidenceRead?.(name) === true; }
  assertCurrent(signal) { signal?.throwIfAborted(); this.#base.assertCurrent?.(signal); signal?.throwIfAborted(); }
  validate(name, args) {
    if (name === 'list_followups') return args && Object.keys(args).sort().join(',') === 'offset,status'
      && ['active', 'all'].includes(args.status) && Number.isSafeInteger(args.offset) && args.offset >= 0 && args.offset <= 1000;
    if (name === 'propose_followup') {
      try { validateFollowupProposal(args, this.#job.text, this.#clock()); return true; } catch { return false; }
    }
    return this.#base.validate(name, args);
  }
  async execute(name, args, signal, budget) {
    signal.throwIfAborted();
    if (!this.validate(name, args)) throw new Error('CONTACT_FOLLOWUP_INVALID');
    if (name === 'list_followups') return this.#store.followupPage(args.status, args.offset);
    if (name !== 'propose_followup') return this.#base.execute(name, args, signal, budget);
    const spec = validateFollowupProposal(args, this.#job.text, this.#clock());
    const response = id => {
      const result = { proposal_id: id, status: 'pending_owner_confirmation', activated: false,
        note: 'A review card will be committed with the answer. Do not say this is saved/active yet or promise a notification before the owner confirms.' };
      if (budget && !budget.fits(result)) throw Error('ASSISTANT_SOURCE_LIMIT');
      return result;
    };
    const old = this.#proposals.get(spec.operation_id);
    if (old) {
      // Both values already have the exact validated, flat scalar field set.
      // JSON object key order is not a change to the owner's work description.
      if (Object.keys(spec).some(key => old.spec[key] !== spec[key])) throw new Error('CONTACT_FOLLOWUP_ID_REUSED');
      return response(old.id);
    }
    if (this.#proposals.size >= 4) throw new Error('CONTACT_FOLLOWUP_LIMIT');
    if (spec.target !== null) {
      const item = this.#store.followup(spec.target);
      if (!item || item.version !== spec.expected_version) throw new Error('CONTACT_FOLLOWUP_STALE');
    }
    const proposal = { id: randomUUID(), spec, timezone: this.#timezone };
    const result = response(proposal.id);
    this.#proposals.set(spec.operation_id, proposal);
    return result;
  }
  verify(evidence, signal) { return this.#base.verify(evidence, signal); }
  proposals() { return structuredClone([...this.#proposals.values()]); }
}
