import { mailAddress, mailId } from './mail-actions.mjs';
const tool = (name, description, properties) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } } });
const recipients = { type: 'array', items: { type: 'string' }, maxItems: 20 };
export const MAIL_TOOLS = [
  tool('list_mail_actions', 'List saved drafts/outcomes; before=null, then next_before. Match requested action/attempt, not newest draft. Read pending outcome.', { before: { type: ['integer', 'null'], minimum: 1 } }),
  tool('read_mail_action', 'Read draft/outcome; check pending send in Gmail. status_check says fresh/unavailable/saved. VERIFIED=matching SENT copy, never delivery/read. Never resend.', { id: { type: 'string' } }),
  tool('prepare_mail', 'Save ONE unsent draft with answer, not prepare_document. Plain body; no preamble/[S#]. Never guess recipients: reply_addresses first; absent→from_addresses, unavailable→ask. reply_to=null(new) or read_email id from THIS turn; host keeps subject/thread.', {
    to: recipients, cc: recipients, bcc: recipients, subject: { type: 'string', maxLength: 500 },
    body: { type: 'string', maxLength: 16384 }, reply_to: { type: ['string', 'null'] },
  }),
];
export class MailSources {
  #base; #store; #job; #google; #reconcile; #draft = null;
  constructor(base, store, job, google, reconcile = null) {
    this.#base = base; this.#store = store; this.#job = job; this.#google = google; this.#reconcile = reconcile;
    if (base.definitions.some(t => MAIL_TOOLS.some(m => m.function.name === t.function?.name))) throw Error('CONTACT_TOOL_COLLISION');
  }
  get definitions() { return [...this.#base.definitions, ...structuredClone(MAIL_TOOLS)]; }
  get hostContext() { return (this.#base.hostContext ?? '') + ' Mail reaches selected model. Owner sends exact reviewed card only. For send checks, match actual send attempts, not newer unsent drafts; read the pending receipt. Receipts never prove delivery.'; }
  get verificationKind() { return this.#base.verificationKind; }
  isEvidenceRead(name) { return this.#base.isEvidenceRead?.(name) === true; }
  assertCurrent(signal) {
    signal?.throwIfAborted(); this.#base.assertCurrent?.(signal);
    if (this.#draft) this.#store.assertPreparedMail(this.#job.seq, this.#draft);
  }
  validate(name, args) {
    if (!MAIL_TOOLS.some(t => t.function.name === name)) return this.#base.validate(name, args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    if (name === 'list_mail_actions') return Object.keys(args).join(',') === 'before' && (args.before === null || Number.isSafeInteger(args.before) && args.before > 0);
    if (name === 'read_mail_action') return Object.keys(args).join(',') === 'id' && mailId(args.id);
    return Object.keys(args).sort().join(',') === 'bcc,body,cc,reply_to,subject,to'
      && ['to','cc','bcc'].every(k => Array.isArray(args[k]) && args[k].length <= 20 && args[k].every(mailAddress))
      && args.to.length > 0 && typeof args.subject === 'string' && typeof args.body === 'string'
      && (args.reply_to === null || typeof args.reply_to === 'string');
  }
  async execute(name, args, signal, budget) {
    this.assertCurrent(signal); this.#store.assertTurnAuthority(this.#job.seq);
    if (!this.validate(name, args)) throw Error('CONTACT_MAIL_INVALID');
    if (!MAIL_TOOLS.some(t => t.function.name === name)) return this.#base.execute(name, args, signal, budget);
    let result, prepared;
    if (name === 'list_mail_actions') {
      const page = this.#store.mailActions(args.before);
      result = { ...page, records: page.records.map(r => ({ id: r.id, turn: r.turn, revision: r.revision, state: r.state, created_at: new Date(r.created).toISOString(), send_attempted_at: r.attempt ? new Date(r.attempt.at).toISOString() : null, subject: [...r.draft.subject].slice(0, 120).join(''), first_recipient: r.draft.to[0], recipient_count: r.draft.to.length + r.draft.cc.length + r.draft.bcc.length, result: r.result })) };
      while (result.records.length > 1 && budget && !budget.fits(result)) { result.records.pop(); result.next_before = result.records.at(-1).turn; }
    } else if (name === 'read_mail_action') {
      let record = this.#store.mailAction(args.id);
      let status = { state: 'saved', attempted: false };
      if (['ACCEPTED', 'UNCERTAIN'].includes(record.state)) {
        status = { state: 'unavailable', attempted: false };
        if (this.#reconcile) {
          try {
            record = await this.#reconcile(args.id, signal);
            status = { state: record.result?.basis === 'read_unavailable' ? 'unavailable' : 'fresh', attempted: true };
          } catch {
            // A busy/offline reader never turns saved uncertainty into a resend.
            // Authority/cancellation is checked again before admitting any data.
            record = this.#store.mailAction(args.id);
          }
        }
      }
      this.assertCurrent(signal); this.#store.assertTurnAuthority(this.#job.seq);
      result = { ...record, status_check: status };
      if (budget && !budget.fits(result)) {
        result = { ...result, draft: { ...record.draft }, omitted_fields: ['draft.body'], sha256_basis: 'full_saved_draft_not_partial_result' };
        delete result.draft.body;
      }
    }
    else {
      if (this.#draft) throw Error('CONTACT_MAIL_ALREADY_PREPARED');
      const account = this.#store.assertGoogleAuthority(this.#job.device, this.#store.googleEpoch());
      const reply = args.reply_to === null ? null : await this.#google?.replyReference(args.reply_to, signal);
      if (args.reply_to !== null && !reply) throw Error('CONTACT_MAIL_REPLY_READ_REQUIRED');
      prepared = this.#store.prepareMail(this.#job.seq, { account: account.email, to: args.to, cc: args.cc, bcc: args.bcc,
        subject: reply ? reply.subject : args.subject, body: args.body.replaceAll('\r\n', '\n'), reply });
      result = { id: prepared.id, revision: prepared.revision, state: 'prepared_for_owner_review', sent: false };
    }
    if (budget && !budget.fits(result)) throw Error('ASSISTANT_SOURCE_LIMIT');
    this.assertCurrent(signal); this.#store.assertTurnAuthority(this.#job.seq); if (prepared) this.#draft = prepared;
    return structuredClone(result);
  }
  verify(evidence, signal) { this.assertCurrent(signal); return this.#base.verify(evidence, signal); }
  prepared() { return this.#draft ? structuredClone(this.#draft) : null; }
}
