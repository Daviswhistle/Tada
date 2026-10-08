import { ProactiveSources } from './proactive-sources.mjs';
import { EventEmitter } from 'node:events';
import { DocumentSources } from './document-sources.mjs';
import { ConversationAssistant } from './conversation.ts';
import { ReviewSources } from './review-sources.mjs';
import { FollowupSources } from './followup-sources.mjs';
import { followupTimezone } from './followup-contract.mjs';

const safeCode = error => /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'ASSISTANT_FAILED';
export class ContactService extends EventEmitter {
  #store; #model; #sources; #active; #drain; #stopped = false; #timer; #timezone;
  constructor(store, model, sources, { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    super();
    this.#store = store; this.#model = model; this.#sources = sources; this.#timezone = followupTimezone(timezone);
  }
  start() {
    if (!this.#timer && !this.#stopped && this.#store.contactVersion >= 3) {
      this.#timer = setInterval(() => {
        try { if (this.tickFollowups()) { this.emit('change'); this.start(); } }
        catch (error) { this.#stopped = true; clearInterval(this.#timer); this.#active?.abort.abort(); this.emit('fault', safeCode(error)); }
      }, 1000);
      this.#timer.unref();
      this.tickFollowups();
    }
    if (!this.#drain && !this.#stopped) {
      // Schedule outside request handling. Disconnecting the requester neither
      // cancels the accepted turn nor holds an HTTP response open for the model.
      this.#drain = Promise.resolve().then(() => this.#run()).catch(error => {
        this.#stopped = true;
        this.emit('fault', safeCode(error));
      }).finally(() => { this.#drain = null; });
    }
  }
  submit(device, requestId, text) {
    if (this.#stopped) throw new Error('CONTACT_HOST_STOPPING');
    const accepted = this.#store.submit(device, requestId, text);
    this.emit('change'); this.start();
    return accepted;
  }
  cancel(seq) {
    const changed = this.#store.cancel(seq);
    if (this.#active?.seq === seq) this.#active.abort.abort();
    this.emit('change');
    return changed;
  }
  revoke(device) {
    this.#store.revoke(device);
    this.#abortStale();
    if (this.#active?.device === device) this.#active.abort.abort();
    this.emit('change');
  }
  async #run() {
    while (!this.#stopped) {
      const job = this.#store.claim();
      if (!job) break;
      const abort = new AbortController();
      this.#active = { seq: job.seq, device: job.device, abort };
      this.emit('change');
      try {
        const metered = { chat: async (messages, tools, signal) => {
          signal.throwIfAborted();
          const id = this.#store.reserve(job.seq);
          let response;
          try { response = await this.#model.chat(messages, tools, signal); }
          catch (error) { this.#store.observe(id, null); throw error; }
          this.#store.observe(id, response); // before discarding any late result
          signal.throwIfAborted();
          return response;
        } };
        if (typeof this.#model.contextBytes === 'function') metered.contextBytes = (messages, tools) => this.#model.contextBytes(messages, tools);
        const proactive = this.#store.proactiveForTurn(job.seq);
        const review = this.#store.reviewForTurn(job.seq);
        if (review && !this.localReviews) throw Error('CONTACT_REVIEW_LOCAL_PROVIDER_REQUIRED');
        const base = review ? new ReviewSources(this.#sources, this.#store, job, review)
          : this.#store.contactVersion >= 3
          ? new FollowupSources(this.#sources, this.#store, job, this.#timezone, Date.now, this.localReviews) : this.#sources;
        const sources = proactive ? new ProactiveSources(this.#store, job) : review ? base : new DocumentSources(base, this.#store, job);
        const assistant = new ConversationAssistant(metered, sources);
        const prior = this.#store.checkpoint();
        assistant.restore(prior.value ?? assistant.checkpoint(), this.#store.usage());
        for (const stopped of this.#store.stoppedSince(prior.through, job.seq)) {
          if (stopped.origin !== 'proactive') assistant.noteStopped(stopped.text, stopped.state);
        }
        const answer = await assistant.ask(job.text, abort.signal);
        abort.signal.throwIfAborted();
        const proposals = !proactive && base instanceof FollowupSources ? base.proposals() : [];
        const document = !answer.refused && sources instanceof DocumentSources ? sources.prepared() : null;
        const checkpoint = assistant.checkpoint();
        // The full document stays in the encrypted answer. Persist a compact
        // receipt in model context; read_document retrieves it when needed.
        for (const message of checkpoint.history) {
          if (message.role === 'tool' && message.tool_name === 'read_document') {
            const newline = message.content.indexOf('\n');
            const result = JSON.parse(newline < 0 ? message.content : message.content.slice(0, newline));
            if (newline >= 0 || typeof result.content === 'string') { delete result.content; message.content = JSON.stringify({ ...result, note: 'Read again for the full document.' }); }
          }
        }
        if (document) {
          const currentUser = checkpoint.history.findLastIndex(message => message.role === 'user');
          checkpoint.history.splice(currentUser + 1, checkpoint.history.length, { role: 'assistant', content: `Saved document: ${JSON.stringify({ id: document.id, root: document.root, based_on: document.based_on, title: document.title, revision: document.revision })}. Use read_document for content.` });
        }
        if (proposals.length) {
          const notice = '\n\n맡긴 일의 내용·시각을 확인해 확정해 주세요. 아래 제안은 아직 저장 확정·알림 예약 전입니다.';
          if (document) {
            answer.notice = notice.trim(); checkpoint.history.push({ role: 'assistant', content: notice.trim() });
          } else {
            answer.text += notice;
            const last = checkpoint.history[checkpoint.history.length - 1];
            if (last.provider_state) checkpoint.history.push({ role: 'assistant', content: notice.trim() });
            else last.content = answer.text;
          }
        }
        this.#store.finish(job.seq, answer, checkpoint, proposals, document);
      } catch (error) {
        this.#store.fail(job.seq, safeCode(error), this.#stopped ? 'interrupted' : 'failed');
      } finally {
        this.#active = null;
        this.emit('change');
      }
    }
  }
  configureProactive(device, enabled, consent) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    const result = this.#store.configureProactive(device, enabled, consent, this.#timezone);
    this.#abortStale(); this.emit('change'); this.start(); return result;
  }
  confirmFollowup(device, id, decision) {
    if (this.#stopped) throw new Error('CONTACT_HOST_STOPPING');
    const result = this.#store.confirmFollowup(device, id, decision);
    this.#abortStale(); this.emit('change'); return result;
  }
  armReview(device, commitment, version, consent) {
    if (this.#stopped) throw new Error('CONTACT_HOST_STOPPING');
    if (!this.localReviews) throw Error('CONTACT_REVIEW_LOCAL_PROVIDER_REQUIRED');
    const result = this.#store.armReview(device, commitment, version, consent);
    this.emit('change'); return result;
  }
  cancelReview(device, commitment, version) {
    const result = this.#store.cancelReview(device, commitment, version);
    this.#abortStale(); this.emit('change'); return result;
  }
  #abortStale() {
    if (this.#active && this.#store.turn(this.#active.seq)?.state !== 'running') this.#active.abort.abort();
  }
  tickFollowups(now = Date.now()) {
    if (this.#stopped || this.#store.contactVersion < 3) return 0;
    const queued = this.localReviews ? this.#store.reviewTick(now) : 0;
    this.#abortStale();
    return queued + this.#store.followupTick(now) + this.#store.proactiveTick(now);
  }
  get localReviews() { return !this.#model.identity || this.#model.identity.provider === 'ollama-local'; }
  get providerStatus() {
    const identity = this.#model.identity;
    return identity ? { provider: identity.provider, model: identity.display_name ?? identity.model,
      account: identity.account_label ?? null, usage_url: identity.provider === 'chatgpt-subscription' ? 'https://chatgpt.com/settings/usage' : null } : null;
  }
  get stopped() { return this.#stopped; }
  async idle() { await this.#drain; }
  async close() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#active?.abort.abort();
    await this.#drain;
  }
}
