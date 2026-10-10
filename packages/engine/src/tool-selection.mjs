// Large connected toolsets must leave room for the owner's request and actual
// observations. Selection changes exposure only, never the source's authority.
const NAME = 'select_tools';
export function boundedTools(base, contextLimit = 14000) {
  if (Buffer.byteLength(JSON.stringify(base.definitions)) <= contextLimit / 2) return base;
  return new SelectedTools(base);
}
class SelectedTools {
  #base; #selected = [];
  constructor(base) {
    if (base.definitions.some(t => t.function?.name === NAME)) throw Error('CONTACT_TOOL_COLLISION');
    this.#base = base;
  }
  get definitions() {
    const available = this.#base.definitions;
    if (!available.length) return [];
    return [{ type: 'function', function: { name: NAME,
      description: 'Choose tools needed next from the available names. Replaces the current selection; select again as needed. Does not execute work or grant access. Reads may unlock new names.',
      parameters: { type: 'object', additionalProperties: false, required: ['names'], properties: {
        names: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', enum: available.map(t => t.function.name) } },
      } } } }, ...available.filter(t => this.#selected.includes(t.function.name))];
  }
  get hostContext() { return (this.#base.hostContext ?? '') + ' Tool schemas are selected on demand to fit this model. Use select_tools, then call selected tools; selecting alone performs no work.'; }
  get verificationKind() { return this.#base.verificationKind; }
  get quietAnswer() { return this.#base.quietAnswer; }
  isEvidenceRead(name) { return this.#base.isEvidenceRead?.(name) === true; }
  assertCurrent(signal) { signal?.throwIfAborted(); this.#base.assertCurrent?.(signal); }
  completionIssue() { return this.#base.completionIssue?.() ?? null; }
  recallEvidence(evidence, signal) { return this.#base.recallEvidence?.(evidence, signal) ?? false; }
  verify(evidence, signal) { return this.#base.verify(evidence, signal); }
  validate(name, args) {
    if (name !== NAME) return this.#selected.includes(name) && this.#base.definitions.some(t => t.function.name === name) && this.#base.validate(name, args);
    return !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).join(',') === 'names'
      && Array.isArray(args.names) && args.names.length >= 1 && args.names.length <= 8
      && new Set(args.names).size === args.names.length
      && args.names.every(n => this.#base.definitions.some(t => t.function.name === n));
  }
  async execute(name, args, signal, budget) {
    this.assertCurrent(signal);
    if (!this.validate(name, args)) throw Error('CONTACT_TOOL_SELECTION_INVALID');
    if (name !== NAME) return this.#base.execute(name, args, signal, budget);
    const previous = this.#selected;
    this.#selected = [...args.names];
    const result = { selected: [...args.names], performed: false };
    // Measure the newly exposed schemas, and restore the old selection if the
    // provider cannot fit them. Never dispatch a tool on a failed selection.
    try {
      if (budget && !budget.fits(result)) throw Error('ASSISTANT_SOURCE_LIMIT');
      return result;
    } catch (error) { this.#selected = previous; throw error; }
  }
}
