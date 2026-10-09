import { observeAttention, eventKey, reminderDue, reminderText } from './attention.mjs';
import { createHash } from 'node:crypto';
import { ProactiveSources } from './proactive-sources.mjs';
import { EventEmitter } from 'node:events';
import { DocumentSources } from './document-sources.mjs';
import { ConversationAssistant } from './conversation.ts';
import { ReviewSources } from './review-sources.mjs';
import { FollowupSources } from './followup-sources.mjs';
import { GoogleSources } from './google-sources.mjs';
import { followupTimezone } from './followup-contract.mjs';

function failureDetails(error) {
  const code = /^(?:ASSISTANT|CHATGPT|CONTACT|OLLAMA)_[A-Z_]{1,54}$/u.test(error?.message) ? error.message : 'ASSISTANT_FAILED';
  const details = { code };
  if (code.startsWith('CHATGPT_')) {
    if (typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,95}$/u.test(error.code)) details.provider_code = error.code;
    if (Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599) details.status = error.status;
    if (typeof error.param === 'string' && error.param.length <= 100 && /^(?:input|tools|model|reasoning|service_tier|stream|store|scope)(?:\.[a-z_]+|\[[0-9]+\])*$/u.test(error.param)) details.param = error.param;
    if (['oauth_error', 'error_object', 'detail', 'unrecognized'].includes(error.body_shape)) details.body_shape = error.body_shape;
    if (['response.failed', 'error'].includes(error.event_type)) details.event_type = error.event_type;
    if (['server_error', 'invalid_request_error', 'rate_limit_error', 'authentication_error', 'permission_error'].includes(error.error_type)) details.error_type = error.error_type;
    if (['object', 'absent', 'other'].includes(error.error_shape)) details.error_shape = error.error_shape;
  }
  return details;
}
const safeCode = error => /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'ASSISTANT_FAILED';
export class ContactService extends EventEmitter {
  #store; #model; #sources; #active; #drain; #stopped = false; #timer; #timezone; #google = null; #attention = null; #attentionAbort = null; #wakeRequested = false;
  constructor(store, model, sources, { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    super();
    this.#store = store; this.#model = model; this.#sources = sources; this.#timezone = followupTimezone(timezone);
  }
  start() {
    if (!this.#timer && !this.#stopped && this.#store.contactVersion >= 3) {
      this.#timer = setInterval(() => {
        try {
          if (this.#active && !this.#active.abort.signal.aborted) {
            try { this.#store.assertDevice(this.#active.device); }
            catch { this.#active.abort.abort(); this.#google?.deviceRevoked(this.#active.device); }
          }
          this.#google?.sweepAuthority();
          this.checkAttention();
          if (this.tickFollowups()) { this.emit('change'); this.start(); }
        }
        catch (error) { this.#stopped = true; clearInterval(this.#timer); this.#active?.abort.abort(); this.emit('fault', safeCode(error)); }
      }, 1000);
      this.#timer.unref();
      this.tickFollowups(); this.checkAttention();
    }
    this.#wakeRequested = true;
    if (!this.#drain && !this.#stopped) {
      // Schedule outside request handling. Disconnecting the requester neither
      // cancels the accepted turn nor holds an HTTP response open for the model.
      this.#drain = Promise.resolve().then(() => { this.#wakeRequested = false; return this.#run(); }).catch(error => {
        this.#stopped = true;
        this.emit('fault', safeCode(error));
      }).finally(() => { this.#drain = null; if (this.#wakeRequested && !this.#stopped) this.start(); });
    }
  }
  submit(device, requestId, text) {
    if (this.#stopped) throw new Error('CONTACT_HOST_STOPPING');
    const accepted = this.#store.submit(device, requestId, text);
    if (!accepted.replay && this.#active && this.#store.proactiveForTurn(this.#active.seq)) this.#active.abort.abort();
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
    this.#google?.deviceRevoked(device);
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
      this.#active = { seq: job.seq, device: job.device, abort, google: null };
      this.emit('change');
      const attemptedTools = []; let providerFailure;
      try {
        const proactive = this.#store.proactiveForTurn(job.seq);
        const review = this.#store.reviewForTurn(job.seq);
        if (review && !this.localReviews) throw Error('CONTACT_REVIEW_LOCAL_PROVIDER_REQUIRED');
        // Local review grants are deliberately composed without Google. Normal
        // turns and the separately opted-in daily suggestion path may use it.
        const google = review || !this.#google ? null : new GoogleSources(this.#sources, this.#store, this.#google, job);
        this.#active.google = google;
        const base = review ? new ReviewSources(this.#sources, this.#store, job, review)
          : this.#store.contactVersion >= 3
          ? new FollowupSources(google ?? this.#sources, this.#store, job, this.#timezone, Date.now, this.localReviews) : (google ?? this.#sources);
        const continuing = this.#store.continuingUseEnabled();
        const sources = proactive ? new ProactiveSources(this.#store, job, google) : review ? base : new DocumentSources(base, this.#store, job, { history: continuing });
        const metered = { chat: async (messages, tools, signal) => {
          signal.throwIfAborted(); this.#store.assertTurnAuthority(job.seq); sources.assertCurrent?.(signal);
          const id = this.#store.reserve(job.seq);
          let response;
          try { response = await this.#model.chat(messages, tools, signal); }
          catch (error) { this.#store.observe(id, null); providerFailure = failureDetails(error); throw error; }
          this.#store.observe(id, response); // before discarding any late result
          signal.throwIfAborted(); sources.assertCurrent?.(signal);
          return response;
        } };
        if (typeof this.#model.contextBytes === 'function') metered.contextBytes = (messages, tools) => this.#model.contextBytes(messages, tools);
        if (this.#model.contextLimitBytes !== undefined) metered.contextLimitBytes = this.#model.contextLimitBytes;
        // Rolling allowance may recover while a provider response is pending.
        // The durable reserve above owns admission at every request, including
        // legacy review/proactive limits; do not freeze that allowance here.
        const assistant = new ConversationAssistant(metered, sources, event => {
          if (event.kind === 'tool_call' && typeof event.name === 'string' && /^[a-z_]{1,64}$/u.test(event.name) && attemptedTools.length < 24) attemptedTools.push(event.name);
        }, { continuing, requestLimit: continuing ? Number.MAX_SAFE_INTEGER : 64 });
        const prior = this.#store.checkpoint();
        assistant.restore(prior.value ?? assistant.checkpoint(), this.#store.usage());
        for (const stopped of this.#store.stoppedSince(prior.through, job.seq)) {
          if (stopped.origin !== 'proactive') assistant.noteStopped(stopped.text, stopped.state);
        }
        assistant.noteContext(this.#store.reminderContext(prior.through, job.seq));
        const answer = await assistant.ask(job.text, abort.signal);
        abort.signal.throwIfAborted(); sources.assertCurrent?.(abort.signal);
        const proposals = !proactive && base instanceof FollowupSources ? base.proposals() : [];
        const document = !answer.refused && sources instanceof DocumentSources ? sources.prepared() : null;
        const checkpoint = assistant.checkpoint();
        // The full document stays in the encrypted answer. Persist a compact
        // receipt in model context; read_document retrieves it when needed.
        const privateGoogleTools = new Set(['list_recent_emails', 'read_email', 'list_upcoming_events']);
        for (const message of checkpoint.history) {
          if (message.role === 'tool' && message.tool_name === 'read_document') {
            const newline = message.content.indexOf('\n');
            const result = JSON.parse(newline < 0 ? message.content : message.content.slice(0, newline));
            if (newline >= 0 || typeof result.content === 'string') { delete result.content; message.content = JSON.stringify({ ...result, note: 'Read again for the full document.' }); }
          }
          if (message.role === 'tool' && privateGoogleTools.has(message.tool_name)) {
            // Mail/calendar bodies and summaries are transient model input. The
            // final answer and compact evidence receipt remain in encrypted history.
            message.content = JSON.stringify({ note: 'Google account content was not retained in the checkpoint. Re-read current account data when needed.' });
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
        sources.assertCurrent?.(abort.signal);
        this.#store.finish(job.seq, answer, checkpoint, proposals, document);
      } catch (error) {
        this.#store.fail(job.seq, safeCode(error), this.#stopped ? 'interrupted' : 'failed');
        const details = failureDetails(error);
        if (providerFailure?.code === details.code) Object.assign(details, providerFailure);
        this.emit('turn-failed', { turn: job.seq, ...details, attempted_tools: attemptedTools });
      } finally {
        this.#active = null;
        this.emit('change');
      }
    }
  }
  configureProactive(device, enabled, consent) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    const result = this.#store.configureProactive(device, enabled, consent, this.#timezone);
    this.#attentionAbort?.abort();
    this.#abortStale(); this.emit('change'); this.start(); return result;
  }
  attachGoogle(connection) {
    if (!connection || typeof connection.connect !== 'function' || typeof connection.status !== 'function' || this.#google) throw Error('CONTACT_GOOGLE_SETUP_INVALID');
    this.#google = connection;
    connection.on('change', change => {
      if (change?.authorityChanged) { this.#attentionAbort?.abort(); if (this.#active?.google) this.#active.abort.abort(); }
      this.emit('change');
    });
  }
  googleStatus() { return this.#google?.status() ?? { available: false, configured: false, connected: false, pending: false, state: 'unavailable', account: null, last_checked: null, error: null, last_disconnect: null }; }
  connectGoogle(device, consent) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    if (!this.#google) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED');
    return this.#google.connect(device, consent);
  }
  async disconnectGoogle(device) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    if (!this.#google) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED');
    const result = await this.#google.disconnect(device);
    this.emit('change'); return result;
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
    return queued + this.#store.followupTick(now) + this.#store.proactiveTick(now, this.#google?.status().connected === true);
  }
  async validateDelivery(delivery, signal) {
    if (!delivery.turn) return true;
    const notice = this.#store.attentionDelivery(delivery.turn);
    if (!notice) return true;
    if (notice.stopped || this.#stopped || !this.#google) return false;
    const observation = await observeAttention(this.#store, this.#google, notice.ticket, signal, Date.now(), true);
    this.#store.assertAttentionDelivery(delivery.id, delivery.turn, notice.ticket);
    const event = observation.events.find(item => eventKey(observation.account, item) === notice.key);
    // Missing in a partial page is not cancellation, but also not permission to
    // send a stale scheduled alert. The existing in-app historical record stays.
    return !!event && reminderDue(event, Date.now(), notice.ticket.timezone)
      && reminderText(event, notice.created, notice.ticket.timezone) === notice.text;
  }
  checkAttention(now = Date.now()) {
    if (this.#attention || this.#stopped) return this.#attention;
    const ticket = this.#store.claimAttention(now);
    if (!ticket) return null;
    const abort = new AbortController(); this.#attentionAbort = abort;
    this.#attention = Promise.resolve().then(async () => {
      try {
        const observation = ticket.google_epoch ? await observeAttention(this.#store, this.#google, ticket, abort.signal, now)
          : { fingerprint: createHash('sha256').update(ticket.local_fingerprint).digest('hex'), events: [], truncated: false, observed_at: now };
        abort.signal.throwIfAborted();
        const changed = this.#store.finishAttention(ticket, observation, Math.max(now, Date.now()));
        if (changed) this.start();
      } catch (error) { this.#store.failAttention(ticket, safeCode(error)); }
      finally { this.emit('change'); }
    }).catch(error => { this.#stopped = true; this.#active?.abort.abort(); this.emit('fault', safeCode(error)); })
      .finally(() => { this.#attention = null; this.#attentionAbort = null; });
    return this.#attention;
  }
  get localReviews() { return !this.#model.identity || this.#model.identity.provider === 'ollama-local'; }
  get providerStatus() {
    const identity = this.#model.identity;
    return identity ? { provider: identity.provider, model: identity.display_name ?? identity.model,
      account: identity.account_label ?? null, usage_url: identity.provider === 'chatgpt-subscription' ? 'https://chatgpt.com/settings/usage' : null } : null;
  }
  get stopped() { return this.#stopped; }
  async idle() { while (this.#drain) await this.#drain; }
  async stopWhenIdle() {
    while (this.#drain) await this.#drain;
    // No asynchronous gap between draining admitted work and closing admission.
    this.#stopped = true; clearInterval(this.#timer); this.#attentionAbort?.abort();
    this.emit('change');
  }
  async close() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#attentionAbort?.abort(); this.#active?.abort.abort();
    await this.#attention;
    this.#google?.close();
    this.#active?.abort.abort();
    await this.#drain;
  }
}
