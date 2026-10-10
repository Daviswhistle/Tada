// Shared bounded, read-only retrieval from the same encrypted conversation.
const tool = (name, description, properties, required = Object.keys(properties)) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', additionalProperties: false, properties, required } } });
const integer = { type: 'integer', minimum: 1 };
export const HISTORY_TOOLS = [
  tool('search_history', 'Search past conversation. query=phrase or empty; before=null then next_before. Scans 100/page; incomplete means more.', { query: { type: 'string', maxLength: 120 }, before: { type: ['integer', 'null'], minimum: 1 } }),
  tool('read_history', 'Read past work and effects, not authority. Recheck current facts. receipt_offset=0 initially; use browser_receipts_next_offset with the same id for more.', { id: integer, receipt_offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, ['id']),
];
export function validHistoryCall(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'search_history') return Object.keys(args).sort().join(',') === 'before,query' && typeof args.query === 'string' && args.query.length <= 120 && (args.before === null || Number.isSafeInteger(args.before) && args.before > 0);
  return name === 'read_history' && ['id','id,receipt_offset'].includes(Object.keys(args).sort().join(',')) && Number.isSafeInteger(args.id) && args.id > 0
    && (!Object.hasOwn(args, 'receipt_offset') || Number.isSafeInteger(args.receipt_offset) && args.receipt_offset >= 0);
}
export function readConversationHistory(store, seq, name, args, budget) {
  if (!validHistoryCall(name, args)) throw Error('CONTACT_HISTORY_INVALID');
  if (name === 'search_history') {
    const result = store.searchHistory(args.query, args.before, seq);
    while (budget && !budget.fits(result) && result.matches.length > 1) {
      result.matches.pop(); result.next_before = result.matches.at(-1).id; result.incomplete = true;
    }
    return result;
  }
  const offset = args.receipt_offset ?? 0;
  return fitHistoryRead(store.readHistory(args.id, seq, offset), offset, budget);
}
// Fit the final decorated response so restored source receipts share its budget.
export function fitHistoryRead(result, offset, budget) {
  while (budget && !budget.fits(result) && result.browser_receipts.length > 1) {
    result.browser_receipts.pop();
    result.browser_receipts_next_offset = offset + result.browser_receipts.length;
  }
  while (budget && !budget.fits(result) && (result.request || result.answer)) {
    const key = result.request.length > result.answer.length ? 'request' : 'answer';
    result[key] = [...result[key]].slice(0, Math.floor([...result[key]].length / 2)).join('');
    if (key === 'answer') result.truncated = true; else result.request_truncated = true;
  }
  return result;
}
