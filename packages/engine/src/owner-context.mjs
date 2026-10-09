// Current-turn host selection, not model-supplied context or persisted authority.
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected;
export function validOwnerContext(value) {
  if (!keys(value, 'messages,omitted,version') || value.version !== 1 || typeof value.omitted !== 'boolean'
      || !Array.isArray(value.messages) || value.messages.length > 8 || Buffer.byteLength(JSON.stringify(value)) > 8192) return false;
  let last = 0, recent = 0, retrieved = 0;
  return value.messages.every(item => {
    if (!keys(item, 'created_at,id,selection,state,text') || !Number.isSafeInteger(item.id) || item.id <= last
        || typeof item.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item.created_at)
        || !Number.isFinite(Date.parse(item.created_at)) || new Date(item.created_at).toISOString() !== item.created_at
        || !['queued', 'running', 'answered', 'failed', 'cancelled', 'interrupted'].includes(item.state)
        || typeof item.text !== 'string' || !item.text.trim() || Buffer.byteLength(item.text) > 4096
        || !['recent', 'read_history'].includes(item.selection)) return false;
    last = item.id;
    if (item.selection === 'recent') recent++; else retrieved++;
    return recent <= 4 && retrieved <= 4;
  });
}

export class OwnerContext {
  #store; #job; #revision; #read = new Set(); #omitted = false;
  constructor(store, job) { this.#store = store; this.#job = job; this.#revision = store.historyRevision(); }
  assertCurrent(signal) {
    signal?.throwIfAborted(); this.#store.assertTurnAuthority(this.#job.seq);
    if (this.#read.size && (!this.#store.continuingUseEnabled() || this.#revision !== this.#store.historyRevision())) throw Error('CONTACT_HISTORY_DISABLED');
  }
  #owner(id) {
    if (!Number.isSafeInteger(id) || id < 1 || id >= this.#job.seq) return null;
    const turn = this.#store.turn(id);
    if (!turn || ['proactive', 'owner_edit'].includes(turn.origin) || this.#store.proactiveForTurn(id) || this.#store.reviewForTurn(id)) return null;
    return turn;
  }
  read(id, signal) {
    this.assertCurrent(signal);
    if (!this.#store.continuingUseEnabled() || this.#revision !== this.#store.historyRevision()) throw Error('CONTACT_HISTORY_DISABLED');
    if (!this.#owner(id)) return;
    this.#read.delete(id); this.#read.add(id);
    if (this.#read.size > 4) { this.#read.delete(this.#read.values().next().value); this.#omitted = true; }
  }
  snapshot(signal, limit = 8192) {
    this.assertCurrent(signal);
    if (!Number.isSafeInteger(limit) || limit < 128 || limit > 8192) throw Error('CONTACT_HISTORY_INVALID');
    const output = { version: 1, messages: [], omitted: this.#omitted };
    const selected = new Set();
    const add = (turn, selection) => {
      if (!turn || selected.has(turn.seq)) return;
      selected.add(turn.seq);
      const item = { id: turn.seq, created_at: new Date(turn.created).toISOString(), state: turn.state, text: turn.text, selection };
      const candidate = { ...output, messages: [...output.messages, item].sort((a, b) => a.id - b.id) };
      // Whole utterances only: never cut off a negation or a correction.
      if (Buffer.byteLength(JSON.stringify(candidate)) > limit) output.omitted = true;
      else output.messages = candidate.messages;
    };
    // Explicitly read records have priority over the short recency window.
    for (const id of [...this.#read].reverse()) add(this.#owner(id), 'read_history');
    let recent = 0;
    for (const turn of this.#store.page(this.#job.seq).turns.reverse()) {
      if (!this.#owner(turn.seq) || this.#read.has(turn.seq)) continue;
      if (recent++ === 4) { output.omitted = true; break; }
      add(turn, 'recent');
    }
    if (!validOwnerContext(output)) throw Error('CONTACT_HISTORY_INVALID');
    return output;
  }
}
