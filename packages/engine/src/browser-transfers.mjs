import { createHash, randomUUID } from 'node:crypto';
export const TRANSFER_CONSENT = 'apply_browser_transfer_v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === 'consent,id,revision,sha256';

// Ephemeral owner previews, never scheduled work or model-owned authority.
// The selected bytes and original DOM snapshot cannot be changed by approval.
export class BrowserTransfers {
  #store; #browser; #changed; #revision = 0; #item = null; #operation = null;
  constructor(store, browser, changed) { this.#store = store; this.#browser = browser; this.#changed = changed; }
  get operation() { return this.#operation; }
  invalidate() {
    this.#revision++;
    const item = this.#item;
    if (!item) return;
    item.abort.abort();
    if (item.state === 'applying') return; // Its dispatched effect must finish reconciliation.
    this.#item = null;
    void this.#release(item.candidate.grant.epoch, item.candidate.observation.key);
  }
  async #release(epoch, key) { try { await this.#browser.release?.(epoch, key); } catch { /* Cleanup cannot rewrite an effect receipt. */ } }
  capture(job, google) {
    const revision = this.#revision, history = this.#store.historyRevision(), continuing = this.#store.continuingUseEnabled();
    const snapshot = google?.captureGrant(job.device) ?? null, grant = this.#browser.grant;
    const assertScope = () => {
      if (revision !== this.#revision || history !== this.#store.historyRevision() || continuing !== this.#store.continuingUseEnabled()) throw Error('CONTACT_BROWSER_TRANSFER_STALE');
      this.#store.assertDevice(job.device);
      if (!grant || grant.device !== job.device) throw Error('CONTACT_BROWSER_NOT_SHARED');
      this.#browser.assert(grant.epoch); google?.assertSnapshot(job.device, snapshot);
    };
    return {
      prepared: () => {
        const item = this.#item;
        if (!item || item.turn !== job.seq || item.state !== 'preparing') return false;
        try { this.#assert(item); return true; } catch { this.invalidate(); return false; }
      },
      stage: candidate => {
        assertScope(); this.#store.assertTurnAuthority(job.seq);
        if (this.#item || candidate.grant.epoch !== grant.epoch || candidate.grant.device !== job.device) throw Error('CONTACT_BROWSER_TRANSFER_STALE');
        const frozen = structuredClone(candidate), id = randomUUID();
        this.#item = { id, revision: 1, sha256: digest(frozen), turn: job.seq, device: job.device, candidate: frozen,
          expires: Date.now() + 300000, deadline: performance.now() + 300000, state: 'preparing', assertScope, abort: new AbortController(), result: null };
        return { state: 'awaiting_owner_confirmation', id };
      },
      publish: () => {
        const item = this.#item;
        if (!item || item.turn !== job.seq || item.state !== 'preparing') return false;
        try { this.#assert(item); this.#store.assertOwnerBrowserAuthority(job.seq, job.device); }
        catch { this.invalidate(); return false; }
        item.state = 'ready'; return true;
      },
      discard: () => { if (this.#item?.turn === job.seq && this.#item.state === 'preparing') this.invalidate(); },
    };
  }
  #assert(item) {
    item.abort.signal.throwIfAborted(); item.assertScope();
    if (Date.now() >= item.expires || performance.now() >= item.deadline) throw Error('CONTACT_BROWSER_TRANSFER_EXPIRED');
  }
  status(device) {
    const item = this.#item;
    if (!item || item.device !== device || item.state === 'preparing') return null;
    this.#store.assertDevice(device);
    if (item.state === 'ready') { try { this.#assert(item); } catch { this.invalidate(); return null; } }
    const c = item.candidate, field = c.kind === 'text' ? c.observation.fields.find(f => f.ref === c.ref) : c.observation.files.find(f => f.ref === c.ref);
    return { id: item.id, revision: item.revision, sha256: item.sha256, turn: item.turn, state: item.state, expires: item.expires,
      origin: c.grant.origin, field: field?.label ?? '', kind: c.kind,
      text: c.kind === 'text' ? c.value : Buffer.from(c.replacement.data, 'base64').toString('utf8'),
      filename: c.kind === 'file' ? c.replacement.name : null,
      submit: c.kind === 'file' && c.submit !== null ? field.submitters.find(s => s.ref === c.submit)?.label ?? '' : null,
      result: item.result };
  }
  discard(device, input) {
    this.#match(device, input);
    if (this.#item.state === 'applying') throw Error('CONTACT_BROWSER_TRANSFER_BUSY');
    this.invalidate(); this.#changed(); return null;
  }
  #match(device, input) {
    this.#store.assertDevice(device);
    const item = this.#item;
    if (!exact(input) || input.consent !== TRANSFER_CONSENT || !item || item.device !== device
        || input.id !== item.id || input.revision !== item.revision || input.sha256 !== item.sha256) throw Error('CONTACT_BROWSER_TRANSFER_STALE');
    return item;
  }
  approve(device, input) {
    const item = this.#match(device, input);
    if (item.state === 'applying') return this.#operation;
    if (item.state === 'finished') return Promise.resolve(this.status(device));
    if (item.state !== 'ready') throw Error('CONTACT_BROWSER_TRANSFER_STALE');
    this.#assert(item); this.#store.assertOwnerBrowserAuthority(item.turn, device);
    item.state = 'applying'; // Consume before the first asynchronous step.
    const operation = Promise.resolve().then(() => this.#apply(item)).finally(() => {
      if (this.#operation === operation) this.#operation = null;
      this.#changed();
    });
    this.#operation = operation; this.#changed(); return operation;
  }
  async #apply(item) {
    const c = item.candidate;
    const admit = () => { this.#assert(item); this.#store.assertOwnerBrowserAuthority(item.turn, item.device); };
    let id = null, record, response, reason = null;
    try {
      admit();
      const dispatch = () => { admit(); id = this.#store.admitOwnerBrowserTransfer(item.turn, c.grant, c, TRANSFER_CONSENT); };
      if (c.kind === 'text') {
        response = await this.#browser.fill(c.grant.epoch, c.observation, c.ref, c.value, dispatch);
        if (typeof response?.applied !== 'boolean') throw Error('CONTACT_BROWSER_RESPONSE_UNKNOWN');
        const observed = response.applied ? await this.#browser.verify(c.grant.epoch, c.observation, admit) : null;
        record = this.#store.finishBrowserAction(id, c.value, observed, response.applied);
      } else {
        response = await this.#browser.replaceFile(c.grant.epoch, c.observation, c.ref, c.original, c.replacement, c.submit, dispatch);
        if (typeof response?.applied !== 'boolean') throw Error('CONTACT_BROWSER_RESPONSE_UNKNOWN');
        record = this.#store.finishBrowserFileAction(id, response.applied);
      }
      reason = ['target_changed','field_limit'].includes(response.reason) ? response.reason : null;
    } catch (error) {
      if (id) record = c.kind === 'text' ? this.#store.finishBrowserAction(id, c.value, null, true) : this.#store.finishBrowserFileAction(id, true);
      else reason = /^[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'CONTACT_BROWSER_TRANSFER_STALE';
    } finally { await this.#release(c.grant.epoch); }
    item.state = 'finished';
    item.result = { id, state: record?.action.state ?? 'NOT_DISPATCHED', verdict: record?.action.reconciliation_verdict ?? 'NOT_OBSERVED',
      reason, submitted: response?.submitted === true, server_persistence: 'not_checked', repeat: false };
    if (item.abort.signal.aborted) { if (this.#item === item) this.#item = null; return null; }
    return this.status(item.device);
  }
}
