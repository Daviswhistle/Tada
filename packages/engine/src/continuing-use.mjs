// Explicit host-owned use policy. A request with an uncertain outcome still
// occupies its place in the window; this never changes the lifetime ledger.
export const CONTINUING_CONSENT = 'continuing_conversation_24h_v1';
export const REQUEST_WINDOW = 86400000;
export const REQUEST_LIMIT = 64;
const count = n => Number.isSafeInteger(n) && n >= 0;
export function validContinuingUse(value) {
  return !!value && Object.keys(value).sort().join(',') === 'clock_at,device,enabled,last_request,receipts,version'
    && value.version === 1 && typeof value.enabled === 'boolean'
    && typeof value.device === 'string' && /^[a-zA-Z0-9_-]{16,80}$/u.test(value.device)
    && count(value.clock_at) && count(value.last_request) && Array.isArray(value.receipts) && value.receipts.length <= REQUEST_LIMIT
    && value.receipts.every((r, i) => r && Object.keys(r).sort().join(',') === 'at,id'
      && count(r.id) && r.id > 0 && r.id <= value.last_request && count(r.at) && r.at <= value.clock_at
      && (!i || r.id > value.receipts[i - 1].id && r.at >= value.receipts[i - 1].at));
}
export function useWindow(value, now) {
  if (!validContinuingUse(value) || !count(now)) throw Error('CONTACT_USAGE_POLICY_INVALID');
  const clock = Math.max(now, value.clock_at);
  return { ...value, clock_at: clock, receipts: value.receipts.filter(r => r.at > clock - REQUEST_WINDOW) };
}
