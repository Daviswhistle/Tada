import { BACKUP_CONSENT, createRecordBackup } from './contact-backup.mjs';
import { MailSources } from './mail-sources.mjs';
import { SavedFileSources } from './saved-file-sources.mjs';
import { BrowserSources } from './browser-sources.mjs';
import { observeAttention, eventKey, reminderDue, reminderText } from './attention.mjs';
import { createHash } from 'node:crypto';
import { ProactiveSources } from './proactive-sources.mjs';
import { EventEmitter } from 'node:events';
import { OwnerContext } from './owner-context.mjs';
import { DocumentSources } from './document-sources.mjs';
import { ConversationAssistant } from './conversation.ts';
import { ReviewSources } from './review-sources.mjs';
import { preparePersonalRequest } from './personal-request.mjs';
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
  #maintenance = null;
  #store; #model; #sources; #active; #drain; #stopped = false; #timer; #timezone; #google = null; #browser = null; #attention = null; #attentionAbort = null; #wakeRequested = false; #mailOperations = new Map(); #backupConfig; #backupOperation = null;
  constructor(store, model, sources, { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, backup = {} } = {}) {
    super();
    this.#store = store; this.#model = model; this.#sources = sources; this.#timezone = followupTimezone(timezone);
    this.#backupConfig = { connection: structuredClone(backup.connection ?? { provider: null, google_client: null }), protector: backup.protector };
  }
  async backupRecords(device, portable, consent) {
    this.#store.assertDevice(device);
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    if (consent !== BACKUP_CONSENT || typeof portable !== 'boolean') throw Error('CONTACT_BACKUP_CONSENT_REQUIRED');
    if (this.#backupOperation) throw Error('CONTACT_BACKUP_BUSY');
    const snapshot = this.#store.exportRecords(device, this.#backupConfig.connection);
    const operation = createRecordBackup(snapshot, { portable, protector: this.#backupConfig.protector });
    this.#backupOperation = operation;
    try {
      const result = await operation;
      if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
      this.#store.assertDevice(device);
      return result;
    } finally { if (this.#backupOperation === operation) this.#backupOperation = null; }
  }
  attachBrowser(browser) { if (this.#browser) throw Error('CONTACT_BROWSER_ALREADY_ATTACHED'); this.#browser = browser; browser.on?.('change', () => this.emit('change')); }
  browserStatus(device) {
    const grant = this.#browser?.grant;
    return { available: !!this.#browser?.available, shared: grant ? { url: grant.url, origin: grant.origin, for_this_device: grant.device === device, files: grant.files === true } : null,
      actions: [...new Map([...this.#store.readBrowserActions().slice(0,10), ...this.#store.readBrowserActions(true).filter(r => !r.resolved)].map(r => [r.action.action_id, r])).values()].map(r => ({ id: r.action.action_id, turn: r.turn, origin: r.origin, field: r.payload.label, requested: r.payload.value, file: r.payload.acceptance === 'selected_file_result', download_matches: r.receipt?.observed_sha256 ? r.receipt.observed_sha256===r.payload.replacement?.sha256 : null, state: r.action.state, verdict: r.action.reconciliation_verdict, resolved: !!r.resolved || !!r.recovery?.acknowledged, ...(r.recovery ? {recovery:r.recovery} : {}) })) };
  }
  async openBrowser(device) { this.#store.assertDevice(device); if (!this.#browser || this.#stopped) throw Error('CONTACT_BROWSER_UNAVAILABLE'); await this.#browser.open(); if (this.#stopped) throw Error('CONTACT_HOST_STOPPING'); this.#store.assertDevice(device); return this.browserStatus(device); }
  async browserTabs(device) { this.#store.assertDevice(device); if (!this.#browser) return []; const tabs = await this.#browser.tabs(); this.#store.assertDevice(device); return tabs; }
  async shareBrowser(device, target, consent, url) {
    this.#store.assertDevice(device); if (!this.#browser || this.#stopped) throw Error('CONTACT_BROWSER_UNAVAILABLE');
    let shared;
    try { shared = await this.#browser.share(device, target, consent, url); if (this.#stopped) throw Error('CONTACT_HOST_STOPPING'); this.#store.assertDevice(device); }
    catch (error) { if (shared && this.#browser.grant?.epoch === shared.epoch) this.#browser.unshare(); throw error; }
    this.emit('change'); return this.browserStatus(device);
  }
  unshareBrowser(device) { this.#store.assertDevice(device); this.#browser?.unshare(); this.emit('change'); return this.browserStatus(device); }
  resolveBrowser(device, id, consent) { this.#store.resolveBrowserAction(device, id, consent); this.emit('change'); return this.browserStatus(device); }
  start() {
    if (!this.#timer && !this.#stopped && this.#store.contactVersion >= 3) {
      this.#timer = setInterval(() => {
        try {
          if (this.#active && !this.#active.abort.signal.aborted) {
            try { this.#store.assertDevice(this.#active.device); }
            catch { this.#active.abort.abort(); this.#google?.deviceRevoked(this.#active.device); }
          }
          const now = Date.now(), previous = this.#maintenance;
          if (!this.#active && previous && now >= previous.checkedAt && now < previous.until
              && performance.now() < previous.monotonicUntil && this.#store.changeCount() === previous.changes) return;
          this.#google?.sweepAuthority();
          this.checkAttention();
          if (this.tickFollowups()) { this.emit('change'); this.start(); }
          const until = this.#store.nextMaintenanceAt(now);
          this.#maintenance = { checkedAt: now, until, monotonicUntil: performance.now() + Math.max(0, until - now), changes: this.#store.changeCount() };
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
  editDocument(device, input) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    const saved = this.#store.editDocument(device, input); this.emit('change'); return saved;
  }
  cancel(seq) {
    const changed = this.#store.cancel(seq);
    if (this.#active?.seq === seq) this.#active.abort.abort();
    this.emit('change');
    return changed;
  }
  revoke(device) {
    this.#google?.deviceRevoked(device);
    if (this.#browser?.grant?.device === device) this.#browser.unshare();
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
      const attemptedTools = []; let providerFailure, browserSources;
      try {
        const proactive = this.#store.proactiveForTurn(job.seq);
        const review = this.#store.reviewForTurn(job.seq);
        if (review && !this.localReviews) throw Error('CONTACT_REVIEW_LOCAL_PROVIDER_REQUIRED');
        // Local review grants are deliberately composed without Google. Normal
        // turns and the separately opted-in daily suggestion path may use it.
        const google = review || !this.#google ? null : new GoogleSources(this.#sources, this.#store, this.#google, job);
        this.#active.google = google;
        const ownerContext = !review && !proactive ? new OwnerContext(this.#store, job) : null;
        const delegation = !review && !proactive ? this.#store.captureFollowupDelegation() : null;
        const interactive = !review && !proactive && this.#browser ? (browserSources = new BrowserSources(google ?? this.#sources, this.#store, this.#browser, job)) : google ?? this.#sources;
        const mailSources = !review && !proactive && this.#store.contactVersion >= 6 ? new MailSources(interactive, this.#store, job, google, (id, signal) => this.reconcileMail(job.device, id, signal)) : null;
        const interactiveTools = !review && !proactive ? new SavedFileSources(mailSources ?? interactive, this.#store, job) : mailSources ?? interactive;
        const base = review ? new ReviewSources(this.#sources, this.#store, job, review)
          : this.#store.contactVersion >= 3
          ? new FollowupSources(interactiveTools, this.#store, job, this.#timezone, Date.now, this.localReviews, delegation, signal => preparePersonalRequest({ model: metered, store: this.#store, job, timezone: this.#timezone, epoch: delegation, signal, ownerContext })) : interactiveTools;
        const continuing = this.#store.continuingUseEnabled();
        const research = !proactive && !review && typeof this.#model.researchPublicWeb === 'function' ? async signal => {
          const admit = () => { signal.throwIfAborted(); this.#store.assertTurnAuthority(job.seq); sources.assertCurrent?.(signal); };
          admit();
          if (this.#store.requestAllowance(job.seq) < 2) throw Error('CONTACT_REQUEST_LIMIT');
          const previous = ownerContext.snapshot(signal);
          const id = this.#store.reserve(job.seq); let response;
          try { response = await this.#model.researchPublicWeb(job.text, previous, signal, admit); }
          catch (error) { this.#store.observe(id, error?.observedUsage ?? null); providerFailure = failureDetails(error); throw error; }
          this.#store.observe(id, response);
          signal.throwIfAborted(); this.#store.assertTurnAuthority(job.seq); sources.assertCurrent?.(signal);
          return response.report;
        } : null;
        const sources = proactive ? new ProactiveSources(this.#store, job, google) : review ? base : new DocumentSources(base, this.#store, job, { history: continuing, research, ownerContext });
        const metered = { chat: async (messages, tools, signal, beforeDispatch) => {
          const admit = () => { signal.throwIfAborted(); this.#store.assertTurnAuthority(job.seq); sources.assertCurrent?.(signal); beforeDispatch?.(); };
          admit();
          const id = this.#store.reserve(job.seq);
          let response;
          try { response = await this.#model.chat(messages, tools, signal, admit); }
          catch (error) { this.#store.observe(id, error?.observedUsage ?? null); providerFailure = failureDetails(error); throw error; }
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
        // Keep historical citation IDs reserved without importing old model
        // context, usage, tool grants or owner instructions.
        const checkpointStart = prior.value ?? assistant.checkpoint();
        assistant.restore({ ...checkpointStart, nextEvidence: Math.max(checkpointStart.nextEvidence, this.#store.recoveredEvidenceNext()) }, this.#store.usage());
        for (const stopped of this.#store.stoppedSince(prior.through, job.seq)) {
          if (stopped.origin !== 'proactive') assistant.noteStopped(stopped.text, stopped.state);
        }
        assistant.noteContext(this.#store.reminderContext(prior.through, job.seq));
        const answer = await assistant.ask(job.text, abort.signal);
        abort.signal.throwIfAborted(); sources.assertCurrent?.(abort.signal);
        const proposals = !answer.refused && !proactive && base instanceof FollowupSources ? base.proposals() : [];
        const document = !answer.refused && sources instanceof DocumentSources ? sources.prepared() : null;
        const mail = !answer.refused ? mailSources?.prepared() ?? null : null;
        const checkpoint = assistant.checkpoint();
        // Isolated personal-work intake uses this same durable meter. Include
        // its requests in both visible usage and the continuing checkpoint.
        answer.usage = this.#store.usage(); checkpoint.usage = { ...answer.usage };
        // The full document stays in the encrypted answer. Persist a compact
        // receipt in model context; read_document retrieves it when needed.
        const privateGoogleTools = new Set(['list_recent_emails', 'read_email', 'list_upcoming_events', 'search_related_emails', 'read_email_thread', 'read_mail_action', 'prepare_mail', 'list_mail_actions']);
        for (const message of checkpoint.history) {
          if (message.role === 'tool' && message.tool_name === 'observe_shared_browser') message.content = JSON.stringify({ note: 'Shared browser observations expire. Observe the currently shared page again.' });
          if (message.role === 'tool' && message.tool_name === 'read_saved_file') message.content = JSON.stringify({ note: 'Saved file content is not retained in the checkpoint. Use list_saved_files/read_saved_file when needed.' });
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
        const directIds = proposals.length && base instanceof FollowupSources ? base.directProposalIds() : [];
        if (directIds.length) {
          answer.notice = `요청하신 개인 할 일·알림 ${directIds.length}건의 변경을 저장했어요. 아래 맡긴 일에서 내용과 시각을 확인할 수 있어요.${proposals.length > directIds.length ? ` 별도 제안 ${proposals.length - directIds.length}건은 확인 후 저장됩니다.` : ''}`;
          checkpoint.history.push({ role: 'assistant', content: answer.notice });
        } else if (proposals.length) {
          const notice = '\n\n맡긴 일의 내용·시각을 확인해 확정해 주세요. 아래 제안은 아직 저장 확정·알림 예약 전입니다.';
          if (document) {
            answer.notice = notice.trim(); checkpoint.history.push({ role: 'assistant', content: notice.trim() });
          } else {
            answer.text += notice;
            const last = checkpoint.history[checkpoint.history.length - 1];
            if (!last || last.provider_state) checkpoint.history.push({ role: 'assistant', content: notice.trim() });
            else last.content = answer.text;
          }
        }
        if (mail) {
          const notice = '메일 초안을 저장했어요. 아직 보내지 않았습니다. 컴퓨터의 Tada 대화에서 메일 초안·발송 결과 확인을 열어 검토하고 보내 주세요.';
          answer.notice = [answer.notice, notice].filter(Boolean).join('\n\n');
          checkpoint.history.push({ role: 'assistant', content: `Local mail draft ${mail.id} saved for owner review; not sent. Use read_mail_action for its current state.` });
        }
        const browserActions = this.#store.readBrowserActions().filter(r => r.turn === job.seq);
        if (browserActions.length) {
          const fileActions=browserActions.filter(r=>r.payload.acceptance==='selected_file_result'),textActions=browserActions.filter(r=>r.payload.acceptance!=='selected_file_result');
          const matchingFiles=fileActions.filter(r=>r.receipt?.observed_sha256===r.payload.replacement.sha256).length;
          const verified=textActions.filter(r=>r.action.state==='VERIFIED').length;
          const unresolved=browserActions.filter(r=>['UNCERTAIN','ACKNOWLEDGED','DISPATCHING'].includes(r.action.state)).length;
          const notices=[];
          if(fileActions.length)notices.push(`원본과 수정본 ${fileActions.length}쌍을 보존했어요. ${matchingFiles ? `${matchingFiles}건은 다운로드한 파일이 수정본과 일치했어요. ` : ''}아래 링크에서 두 파일을 내려받을 수 있어요. 화면에 표시된 결과와 별개로, 이번 변경의 최종 반영을 자동으로 확정하지는 못했어요.`);
          if(textActions.length)notices.push(`${verified ? `브라우저 입력 ${verified}건의 현재 값을 확인했어요.` : unresolved ? '브라우저 입력 결과를 확정하지 못했어요.' : '브라우저 입력은 적용되지 않았어요.'} 이 텍스트 입력의 서버 저장·전송 완료 여부는 확인하지 않았어요.`);
          if(unresolved)notices.push(`${unresolved}건은 결과 확인이 필요해 같은 사이트의 새 입력을 멈췄어요.`);
          const links=fileActions.map((r,i)=>`파일 ${i+1}: [원본 내려받기](/api/browser/files/${r.action.action_id}/original) · [수정본 내려받기](/api/browser/files/${r.action.action_id}/replacement)`);
          const notice=[notices.join(' '),...links].join('\n\n');
          answer.notice = [answer.notice, notice].filter(Boolean).join('\n\n');
          checkpoint.history.push({ role: 'assistant', content: notice });
        }
        sources.assertCurrent?.(abort.signal);
        this.#store.finish(job.seq, answer, checkpoint, proposals, document, directIds.length ? { epoch: delegation, proposal_ids: directIds } : null, mail);
      } catch (error) {
        this.#store.fail(job.seq, safeCode(error), this.#stopped ? 'interrupted' : 'failed');
        const details = failureDetails(error);
        if (providerFailure?.code === details.code) Object.assign(details, providerFailure);
        this.emit('turn-failed', { turn: job.seq, ...details, attempted_tools: attemptedTools });
      } finally {
        await browserSources?.close();
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
      this.#maintenance = null;
      if (change?.authorityChanged) { this.#attentionAbort?.abort(); if (this.#active?.google) this.#active.abort.abort(); }
      this.emit('change');
    });
  }
  async mailOperation(device, id, operation) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    this.#store.assertDevice(device);
    if (!this.#google) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED');
    if (this.#mailOperations.has(id)) throw Error('CONTACT_MAIL_BUSY');
    const pending = Promise.resolve().then(() => { if (this.#stopped) throw Error('CONTACT_HOST_STOPPING'); return operation(); });
    this.#mailOperations.set(id, pending); this.emit('change');
    try { return await pending; }
    finally { this.#mailOperations.delete(id); this.emit('change'); }
  }
  sendMail(device, input) {
    return this.mailOperation(device, input.id, async () => {
      const receipt = await this.#google.sendMail(device, input.id, input.revision, input.sha256, input.consent);
      this.emit('change');
      if (this.#stopped || !['ACCEPTED', 'UNCERTAIN'].includes(receipt.state)) return receipt;
      try { return await this.#google.reconcileMail(device, input.id, new AbortController().signal); }
      catch { return receipt; }
    });
  }
  reconcileMail(device, id, signal) { return this.mailOperation(device, id, () => this.#google.reconcileMail(device, id, signal)); }
  editMail(device, input) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    const result = this.#store.editMail(device, input.id, input.revision, input.sha256, input.draft); this.emit('change'); return result;
  }
  discardMail(device, input) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    const result = this.#store.discardMail(device, input.id, input.revision, input.sha256); this.emit('change'); return result;
  }
  disableMail(device) { if (!this.#google) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED'); return this.#google.disableMail(device); }
  googleStatus() { return this.#google?.status() ?? { available: false, configured: false, connected: false, pending: false, state: 'unavailable', account: null, last_checked: null, error: null, last_disconnect: null }; }
  connectGoogle(device, consent) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    if (!this.#google) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED');
    return this.#google.connect(device, consent);
  }
  configureRelatedMail(device, enabled, consent) {
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    if (!this.#google) throw Error('CONTACT_GOOGLE_NOT_CONFIGURED');
    return this.#google.configureRelatedMail(device, enabled, consent);
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
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
    if (!delivery.turn) return true;
    const notice = this.#store.attentionDelivery(delivery.turn);
    if (!notice) return true;
    if (notice.stopped || !this.#google) return false;
    const observation = await observeAttention(this.#store, this.#google, notice.ticket, signal, Date.now(), true);
    if (this.#stopped) throw Error('CONTACT_HOST_STOPPING');
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
    while (this.#drain || this.#mailOperations.size || this.#backupOperation) {
      await Promise.allSettled([...(this.#drain ? [this.#drain] : []), ...(this.#backupOperation ? [this.#backupOperation] : []), ...this.#mailOperations.values()]);
    }
    // No asynchronous gap between draining admitted work and closing admission.
    this.#stopped = true; clearInterval(this.#timer); this.#attentionAbort?.abort();
    this.emit('change');
  }
  beginStop() {
    const changed = !this.#stopped;
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#attentionAbort?.abort(); this.#active?.abort.abort();
    this.#browser?.unshare(); this.#google?.close();
    if (changed) this.emit('change');
  }
  async close() {
    this.beginStop();
    await this.#attention;
    this.#active?.abort.abort();
    await this.#drain;
    await Promise.allSettled([...this.#mailOperations.values(), ...(this.#backupOperation ? [this.#backupOperation] : [])]);
    await this.#browser?.close();
  }
}
