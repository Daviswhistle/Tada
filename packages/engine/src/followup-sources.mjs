import { randomUUID } from 'node:crypto';
import { validateFollowupProposal, followupTimezone } from './followup-contract.mjs';

const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
export const FOLLOWUP_TOOLS = [
  tool('list_followups', 'Read current commitments/proposals before reporting or revising work.', {
    status: { type: 'string', enum: ['active', 'all'] }, offset: { type: 'integer', minimum: 0 },
  }, ['status', 'offset']),
  tool('propose_followup', 'Stage work for owner confirmation of summary/time. List before updates. No file grants, repeats, third-party sending or mailbox watching; inference needs separate approval.', {
    operation_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$',
      description: 'Turn-stable; reuse only identical fields.' },
    target: { ...nullableString, description: 'New=null; update=list_followups id.' },
    expected_version: { type: 'integer', minimum: 0, description: 'New=0; update=current listed version.' },
    title: { ...string, description: 'Requested title, 1-240 UTF-8 bytes.' },
    details: { ...string, description: 'Scope/result/authority; max 2400 UTF-8 bytes.' },
    state: { type: 'string', enum: ['open', 'waiting', 'done', 'cancelled'],
      description: 'New=open/waiting; waiting needs dependency; done/cancelled need target.' },
    waiting_for: { ...nullableString, description: 'Waiting dependency; else null.' },
    notify_at: { ...nullableString, description: 'Authorized future YYYY-MM-DDTHH:mm:ssZ/offset; no fractions. null=no alert.' },
    user_quote: { ...string, description: 'Exact CURRENT owner request substring; 1-1500 UTF-8 bytes.' },
  }, ['operation_id', 'target', 'expected_version', 'title', 'details', 'state', 'waiting_for', 'notify_at', 'user_quote']),
];

export class FollowupSources {
  #base; #store; #job; #proposals = new Map(); #timezone; #clock; #localReviews; #delegation; #prepare; #directResult = null; #directIds = new Set();
  constructor(base, store, job, timezone, clock = Date.now, localReviews = true, delegation = null, prepare = null) {
    this.#base = base; this.#store = store; this.#job = job; this.#delegation = delegation; this.#prepare = prepare;
    this.#timezone = followupTimezone(timezone); this.#clock = clock; this.#localReviews = localReviews;
    const names = base.definitions.map(d => d?.function?.name);
    if (FOLLOWUP_TOOLS.some(d => names.includes(d.function.name)) || delegation !== null && names.includes('apply_personal_request')) throw new Error('CONTACT_TOOL_COLLISION');
  }
  get definitions() {
    const tools = structuredClone(FOLLOWUP_TOOLS);
    if (this.#delegation !== null) tools.push(tool('apply_personal_request',
      'Apply explicit personal-work/one-time reminder from CURRENT owner message. Host interprets owner messages/saved work, never sources/assistant output. read_history resolves old references first. No external actions; suggestions→propose_followup.', {}, []));
    return [...this.#base.definitions, ...tools];
  }
  get delegation() { return this.#delegation; }
  get hostContext() {
    const proactive = this.#store.proactiveStatus();
    const connectedGoogle = ['list_recent_emails', 'list_upcoming_events'].every(name => this.#base.definitions.some(tool => tool.function.name === name));
    const standing = !proactive.available ? '' : !proactive.enabled
      ? ' Proactive care is DISABLED; armed reminders/reviews are unchanged; current settings override past claims.'
      : ` Proactive care is ENABLED; mode ${proactive.mode}; checks ${connectedGoogle ? 'permitted mail/calendar changes and saved work' : 'saved conversation/work; Google mail/calendar unavailable'} ${proactive.mode === 'continuous' ? 'every 15 minutes, AI at most four times daily 09:00-21:00' : 'once daily 09:00-21:00'}.${connectedGoogle && proactive.mode === 'continuous' ? ' Event alerts: 30 minutes before timed events, all-day mornings.' : ''} Runs while host awake/running without user messages. Preferences inform checks; acknowledgement changes no schedules/access. Current settings override past claims.`;
    const base = this.#base.hostContext ? `${this.#base.hostContext}\n` : '';
    return `${base}Host time: ${new Date(this.#clock()).toISOString()}; timezone: ${this.#timezone}. Retrieve saved work before changes. ${this.#delegation === null ? 'Proposals need owner confirmation' : 'Personal-work delegation is enabled; propose_followup ALWAYS needs confirmation, including source suggestions'}; do not investigate deferred work early.${this.#store.contactVersion >= 4 && this.#localReviews ? ' Owner may arm one local read-only review on its card or Telegram /review COMMITMENT_ID VERSION. Reminders alone never run a model; review results do not prove completion.' : ' Per-task LOCAL FILE reviews are unavailable; enabled proactive care is separate. Reminders alone never run a model.'}${standing}`; }
  get verificationKind() { return this.#base.verificationKind; }
  isEvidenceRead(name) { return this.#base.isEvidenceRead?.(name) === true; }
  assertCurrent(signal) { signal?.throwIfAborted(); this.#base.assertCurrent?.(signal); if (this.#directIds.size && this.#delegation !== null) this.#store.assertFollowupDelegation(this.#delegation); signal?.throwIfAborted(); }
  validate(name, args) {
    if (name === 'apply_personal_request') return this.#delegation !== null && args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0;
    if (name === 'list_followups') return args && Object.keys(args).sort().join(',') === 'offset,status'
      && ['active', 'all'].includes(args.status) && Number.isSafeInteger(args.offset) && args.offset >= 0 && (this.#store.continuingUseEnabled() || args.offset <= 1000);
    if (name === 'propose_followup') {
      try { validateFollowupProposal(args, this.#job.text, this.#clock()); return true; } catch { return false; }
    }
    return this.#base.validate(name, args);
  }
  async execute(name, args, signal, budget) {
    signal.throwIfAborted();
    if (!this.validate(name, args)) throw new Error('CONTACT_FOLLOWUP_INVALID');
    if (name === 'list_followups') return this.#store.followupPage(args.status, args.offset);
    if (name === 'apply_personal_request') {
      this.#store.assertFollowupDelegation(this.#delegation);
      if (typeof this.#prepare !== 'function') throw Error('CONTACT_FOLLOWUP_INVALID');
      this.#directResult ??= this.#prepare(signal);
      const prepared = await this.#directResult;
      signal.throwIfAborted();
      this.#store.assertFollowupDelegation(this.#delegation); this.#store.assertTurnAuthority(this.#job.seq);
      const proposals = prepared.proposals.map(p => ({ ...p, spec: { ...p.spec, operation_id: `direct_${p.id}` } }));
      if (this.#proposals.size + proposals.filter(p => !this.#directIds.has(p.id)).length > 4) throw Error('CONTACT_FOLLOWUP_LIMIT');
      const receipt = { status: proposals.length ? 'commit_with_answer' : 'no_direct_change', activated: false,
        changes: proposals.map(p => ({ id: p.id, title: p.spec.title, state: p.spec.state, notify_at: p.spec.notify_at })),
        explanation: prepared.explanation, note: 'Only these independently prepared changes commit with the final answer. Other proposals still need owner confirmation.' };
      if (budget && !budget.fits(receipt)) throw Error('ASSISTANT_SOURCE_LIMIT');
      for (const proposal of proposals) { this.#proposals.set(proposal.spec.operation_id, proposal); this.#directIds.add(proposal.id); }
      return receipt;
    }
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
      if (this.#directIds.has(old.id)) throw Error('CONTACT_FOLLOWUP_ID_REUSED');
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
  directProposalIds() { return [...this.#directIds]; }
  proposals() { return structuredClone([...this.#proposals.values()]); }
}
