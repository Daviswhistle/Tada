// Structured proposals, not phrase matching. A model cannot activate a reminder:
// only the authenticated owner's review of this exact immutable proposal can.
export const FOLLOWUP_STATES = ['open', 'waiting', 'done', 'cancelled'];
export const isFollowupId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).sort().join(',') === [...keys].sort().join(',');
const bounded = (value, bytes) => typeof value === 'string' && value.trim().length > 0
  && value.isWellFormed() && Buffer.byteLength(value) <= bytes && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
export function followupTimezone(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('CONTACT_TIMEZONE_INVALID');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new Error('CONTACT_TIMEZONE_INVALID'); }
  return value;
}
export function followupInstant(value) {
  // Require an explicit offset, reject ambiguous local strings and Date.parse's
  // normalization of impossible calendar dates. No guessed timezone correction.
  if (typeof value !== 'string') throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
  const m = /^(20[0-9]{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!m) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
  const [, year, month, day, hour, minute, second, offset] = m;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if ([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .some((v, i) => v !== parts[i])) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59
    || (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0))) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time)) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
  return time;
}
export function validateFollowupProposal(value, userText, now = Date.now()) {
  if (!exact(value, ['operation_id', 'target', 'expected_version', 'title', 'details', 'state', 'waiting_for', 'notify_at', 'user_quote'])
      || !bounded(value.operation_id, 64) || !/^[A-Za-z0-9_-]+$/u.test(value.operation_id)
      || !bounded(value.title, 240) || !bounded(value.details, 2400) || !bounded(value.user_quote, 1500)
      || typeof userText !== 'string' || !userText.includes(value.user_quote)
      || !FOLLOWUP_STATES.includes(value.state)
      || !(value.waiting_for === null || bounded(value.waiting_for, 500))) throw new Error('CONTACT_FOLLOWUP_INVALID');
  if (value.target === null ? value.expected_version !== 0 || !['open', 'waiting'].includes(value.state)
    : !isFollowupId(value.target) || !Number.isSafeInteger(value.expected_version) || value.expected_version < 1) throw new Error('CONTACT_FOLLOWUP_INVALID');
  if ((value.state === 'waiting') !== (value.waiting_for !== null)) throw new Error('CONTACT_FOLLOWUP_INVALID');
  if (value.notify_at !== null) {
    const time = followupInstant(value.notify_at);
    if (!['open', 'waiting'].includes(value.state) || time <= now || time > now + 366 * 86400000) throw new Error('CONTACT_FOLLOWUP_TIME_INVALID');
  }
  return JSON.parse(JSON.stringify(value));
}
export function followupReviewText(proposal) {
  const spec = proposal.spec;
  const state = { open: '챙길 일', waiting: '회신·조건 대기', done: '사용자 확인 완료', cancelled: '취소' }[spec.state];
  return `맡긴 일 확인 · ${spec.title}\n${spec.details}\n상태: ${state}${spec.waiting_for ? `\n기다리는 것: ${spec.waiting_for}` : ''}\n${spec.notify_at ? `확인 시각: ${spec.notify_at} (${proposal.timezone} 표시 기준도 연락 화면에서 확인)` : '시간 알림 없음'}\n아직 확정되지 않았어요. 이 내용대로 저장하려면 /confirm ${proposal.id}\n제안을 버리려면 /dismiss ${proposal.id}`;
}
