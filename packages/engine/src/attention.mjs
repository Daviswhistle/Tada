// Host-owned observation and timing. External text never chooses permissions,
// recipients, model budgets or the reminder policy.
import { isFollowupId } from './followup-contract.mjs';
import { checkedDatePart } from './google-sources.mjs';
import { createHash } from 'node:crypto';
export const ATTENTION_CONSENT = 'connected_attention_v2';
export const ATTENTION_INTERVAL = 15 * 60_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' ? [...value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '')].slice(0, 200).join('') : '';
export function localDay(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}
export function localHour(now, timezone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}
export function attentionEvent(item) {
  if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(item.id)) return null;
  if (item.status === 'cancelled' || item.attendees?.some(a => a.self && a.responseStatus === 'declined')) return null;
  const checked = checkedDatePart(item.start); if (!checked) return null;
  const start = checked.dateTime;
  // Offsetless wall times cannot be resolved without inventing a DST choice.
  const instant = typeof start === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(start) ? Date.parse(start) : NaN;
  const day = checked.date;
  if (!Number.isSafeInteger(instant) && !(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day)) return null;
  return { id: item.id, title: text(item.summary) || '(제목 없음)', start: Number.isSafeInteger(instant) ? instant : null, day: Number.isSafeInteger(instant) ? null : day };
}
export function eventKey(account, event) { return digest([account.toLowerCase(), 'primary', event.id, event.start, event.day]); }
export function reminderDue(event, now, timezone) {
  return event.start === null ? event.day === localDay(now, timezone) && localHour(now, timezone) >= 9 && localHour(now, timezone) < 21
    : now >= event.start - 30 * 60_000 && now < event.start;
}
export function reminderText(event, now, timezone) {
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(event.start ?? now);
  return event.start === null ? `오늘 종일 일정이 있어요: ${event.title}\nGoogle Calendar에서 방금 확인했어요. 필요한 준비를 챙겨 주세요.`
    : `${time}에 ${event.title} 일정이 있어요.\n시작까지 ${Math.max(1, Math.ceil((event.start - now) / 60_000))}분 남았어요. Google Calendar에서 방금 확인했어요.`;
}
export async function observeAttention(store, connection, ticket, signal, now = Date.now(), calendarOnly = false) {
  const snapshot = connection.captureGrant(ticket.device);
  if (!snapshot?.connected || snapshot.epoch !== ticket.google_epoch) throw Error('CONTACT_GOOGLE_AUTHORITY_CHANGED');
  const guard = () => { signal.throwIfAborted(); store.assertAttention(ticket, calendarOnly); connection.assertSnapshot(ticket.device, snapshot, calendarOnly); };
  const get = async url => { guard(); const result = await connection.apiJson(ticket.device, snapshot.epoch, url, signal, 262144); guard(); return result; };
  const mailURL = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  mailURL.searchParams.set('q', `in:inbox after:${Math.floor((now - 7 * 86400000) / 1000)} before:${Math.floor(now / 1000)}`);
  mailURL.searchParams.set('maxResults', '20');
  const sentURL = new URL(mailURL);
  sentURL.searchParams.set('q', `in:sent -in:spam -in:trash -in:drafts after:${Math.floor((now - 7 * 86400000) / 1000)} before:${Math.floor(now / 1000)}`);
  const calendarURL = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  for (const [key, value] of Object.entries({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86400000).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '20', timeZone: 'UTC' })) calendarURL.searchParams.set(key, value);
  const [mailResult, calendarResult, sentResult] = await Promise.allSettled([calendarOnly ? Promise.resolve({}) : get(mailURL), get(calendarURL),
    !calendarOnly && snapshot.related_mail_epoch ? get(sentURL) : Promise.resolve({})]);
  guard();
  if (calendarResult.status === 'rejected') throw calendarResult.reason;
  const calendar = calendarResult.value;
  if (calendar.items !== undefined && !Array.isArray(calendar.items)) throw Error('CONTACT_GOOGLE_SOURCE_INVALID');
  let mail = {}, ids = [], error = null;
  try {
    if (mailResult.status === 'rejected') throw mailResult.reason;
    mail = mailResult.value;
    if (mail.messages !== undefined && !Array.isArray(mail.messages)) throw Error('CONTACT_GOOGLE_SOURCE_INVALID');
    ids = (mail.messages ?? []).slice(0, 20).map(item => item?.id);
    if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(id))) throw Error('CONTACT_GOOGLE_SOURCE_INVALID');
  } catch (failure) {
    // Mail transport/response failure does not erase a current calendar read.
    // Authority is still checked for the shared account before admitting either.
    error = /^[A-Z_]{1,64}$/u.test(failure?.message) ? failure.message : 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE';
    mail = {}; ids = [];
  }
  let sent = {}, sentIds = [];
  try {
    if (sentResult.status === 'rejected') throw sentResult.reason;
    sent = sentResult.value;
    if (sent.messages !== undefined && !Array.isArray(sent.messages)) throw Error('CONTACT_GOOGLE_SOURCE_INVALID');
    sentIds = (sent.messages ?? []).slice(0, 20).map(item => item?.id);
    if (sentIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(id))) throw Error('CONTACT_GOOGLE_SOURCE_INVALID');
  } catch (failure) {
    error ??= /^[A-Z_]{1,64}$/u.test(failure?.message) ? failure.message : 'CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE';
    sent = {}; sentIds = [];
  }
  const raw = (calendar.items ?? []).slice(0, 20), events = raw.map(attentionEvent).filter(Boolean);
  const omitted = raw.some(item => item?.status !== 'cancelled' && !item?.attendees?.some(a => a.self && a.responseStatus === 'declined') && !attentionEvent(item));
  const truncated = omitted || !!mail.nextPageToken || !!sent.nextPageToken || !!calendar.nextPageToken || raw.length >= 20 || ids.length >= 20 || sentIds.length >= 20;
  guard();
  return { fingerprint: digest([ids.sort(), raw.toSorted((a, b) => String(a?.id).localeCompare(String(b?.id))),
    ...(snapshot.related_mail_epoch ? [sentIds.sort()] : [])]), events, truncated, error, account: snapshot.email, observed_at: now };
}
export function validAttention(value) {
  const keys = ['version', 'epoch', 'google_epoch', 'observed_at', 'error', 'fingerprint', 'model_next_at', 'model_day', 'model_runs', 'notified'];
  return value && Object.keys(value).sort().join(',') === keys.sort().join(',') && value.version === 1
    && isFollowupId(value.epoch) && (value.google_epoch === null || isFollowupId(value.google_epoch))
    && [value.observed_at, value.model_next_at, value.model_runs].every(n => Number.isSafeInteger(n) && n >= 0)
    && (value.error === null || /^[A-Z_]{1,64}$/u.test(value.error))
    && (value.fingerprint === null || /^[a-f0-9]{64}$/u.test(value.fingerprint)) && (value.model_day === '' || /^\d{4}-\d{2}-\d{2}$/u.test(value.model_day))
    && Array.isArray(value.notified) && value.notified.length <= 200 && value.notified.every(n => n && Object.keys(n).sort().join(',') === 'active,key,turn,until'
      && typeof n.active === 'boolean'
      && /^[a-f0-9]{64}$/u.test(n.key) && Number.isSafeInteger(n.turn) && n.turn > 0 && Number.isSafeInteger(n.until));
}
