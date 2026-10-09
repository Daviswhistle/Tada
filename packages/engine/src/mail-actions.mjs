import { createHash, randomUUID } from 'node:crypto';

export const MAIL_SEND_CONSENT = 'send_exact_mail_once_v1';
export const MAIL_UPGRADE_CONSENT = 'backup_mail_records_v1';
const shape = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const mailId = value => typeof value === 'string' && /^mail-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export const gmailId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
export const mailAddress = value => typeof value === 'string' && value.length <= 254
  && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/u.test(value)
  && !value.includes('..') && !value.startsWith('.') && !value.includes('.@');
const subject = value => typeof value === 'string' && value.trim().length > 0 && value.isWellFormed()
  && Buffer.byteLength(value) <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
const messageId = value => typeof value === 'string' && /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,180}@[A-Za-z0-9.-]{1,180}>$/u.test(value);
const body = value => typeof value === 'string' && value.trim().length > 0 && value.isWellFormed()
  && Buffer.byteLength(value) <= 16384 && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value);
export function validMailReply(value) {
  return value === null || shape(value, 'gmail_id,thread_id,message_id,references,subject')
    && gmailId(value.gmail_id) && gmailId(value.thread_id) && messageId(value.message_id)
    && Array.isArray(value.references) && value.references.length <= 20 && value.references.every(messageId)
    && new Set(value.references).size === value.references.length && subject(value.subject);
}
export function validMailDraft(value) {
  if (!shape(value, 'account,to,cc,bcc,subject,body,reply') || !mailAddress(value.account)
      || !subject(value.subject) || !body(value.body) || !validMailReply(value.reply)
      || value.reply && value.subject !== value.reply.subject) return false;
  if (['to', 'cc', 'bcc'].some(k => !Array.isArray(value[k]) || value[k].length > 20 || !value[k].every(mailAddress))) return false;
  const recipients = [...value.to, ...value.cc, ...value.bcc].map(s => s.toLowerCase());
  return value.to.length > 0 && recipients.length <= 20 && new Set(recipients).size === recipients.length;
}
export const mailDigest = draft => createHash('sha256').update(JSON.stringify([
  draft.account, draft.to, draft.cc, draft.bcc, draft.subject, draft.body, draft.reply,
])).digest('hex');
const STATES = ['DRAFT', 'DISCARDED', 'DISPATCHING', 'ACCEPTED', 'UNCERTAIN', 'REJECTED', 'VERIFIED', 'APPLIED_MISMATCH'];
export function validMailAction(value) {
  if (!shape(value, 'version,id,turn,device,revision,created,updated,state,draft,sha256,attempt,result')
      || value.version !== 1 || !mailId(value.id) || !integer(value.turn) || value.turn < 1
      || !uuid(value.device) || !integer(value.revision) || value.revision < 1
      || !integer(value.created) || !integer(value.updated) || value.updated < value.created
      || !STATES.includes(value.state) || !validMailDraft(value.draft) || value.sha256 !== mailDigest(value.draft)) return false;
  if (['DRAFT', 'DISCARDED'].includes(value.state)) return value.attempt === null && value.result === null;
  const a = value.attempt;
  if (!shape(a, 'id,device,google_epoch,message_id,at') || !uuid(a.id) || !uuid(a.device) || !uuid(a.google_epoch)
      || a.message_id !== `<tada.${a.id}@local.tada.invalid>` || !integer(a.at) || a.at < value.created || a.at > value.updated) return false;
  if (value.state === 'DISPATCHING') return value.result === null;
  const r = value.result;
  if (!shape(r, 'at,basis,gmail_id,thread_id,http_status') || !integer(r.at) || r.at < a.at || r.at > value.updated
      || !(r.gmail_id === null || gmailId(r.gmail_id)) || !(r.thread_id === null || gmailId(r.thread_id))
      || !(r.http_status === null || integer(r.http_status) && r.http_status >= 100 && r.http_status <= 599)) return false;
  if (value.state === 'ACCEPTED') return r.basis === 'gmail_accepted_not_delivery' && r.gmail_id !== null && r.http_status >= 200 && r.http_status < 300;
  if (value.state === 'REJECTED') return r.basis === 'gmail_rejected' && r.gmail_id === null && r.thread_id === null && r.http_status >= 400 && r.http_status < 500;
  if (value.state === 'VERIFIED') return r.basis === 'sent_copy_matches_not_delivery' && r.gmail_id !== null && r.thread_id !== null;
  if (value.state === 'APPLIED_MISMATCH') return r.basis === 'sent_copy_mismatch' && r.gmail_id !== null;
  return ['outcome_unknown', 'not_found_is_not_unsent', 'read_unavailable', 'multiple_matches'].includes(r.basis);
}
export function prepareMailAction(turn, device, draft, now = Date.now()) {
  const record = { version: 1, id: `mail-${randomUUID()}`, turn, device, revision: 1, created: now, updated: now,
    state: 'DRAFT', draft: structuredClone(draft), sha256: mailDigest(draft), attempt: null, result: null };
  if (!validMailAction(record)) throw Error('CONTACT_MAIL_INVALID');
  return record;
}
export function startMailAction(record, device, epoch, now = Date.now()) {
  if (!validMailAction(record) || record.state !== 'DRAFT') throw Error('CONTACT_MAIL_ALREADY_DISPATCHED');
  const id = randomUUID(), at = Math.max(now, record.updated);
  const next = { ...record, state: 'DISPATCHING', updated: at,
    attempt: { id, device, google_epoch: epoch, message_id: `<tada.${id}@local.tada.invalid>`, at } };
  if (!validMailAction(next)) throw Error('CONTACT_MAIL_INVALID');
  return next;
}
export function finishMailAction(record, state, basis, details = {}, now = Date.now()) {
  if (!validMailAction(record) || ['DRAFT', 'DISCARDED', 'REJECTED', 'VERIFIED', 'APPLIED_MISMATCH'].includes(record.state)) throw Error('CONTACT_MAIL_STATE_INVALID');
  const at = Math.max(now, record.updated);
  const next = { ...record, state, updated: at, result: { at, basis, gmail_id: details.gmail_id ?? record.result?.gmail_id ?? null,
    thread_id: details.thread_id ?? record.result?.thread_id ?? null, http_status: details.http_status ?? record.result?.http_status ?? null } };
  if (!validMailAction(next)) throw Error('CONTACT_MAIL_INVALID');
  return next;
}
function encodedSubject(value) {
  const words = []; let part = '';
  for (const c of value) {
    if (Buffer.byteLength(part + c) > 42) { words.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`); part = ''; }
    part += c;
  }
  words.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`);
  return words.join('\r\n ');
}
export function mailMime(record) {
  if (!validMailAction(record) || record.state !== 'DISPATCHING') throw Error('CONTACT_MAIL_STATE_INVALID');
  const d = record.draft, a = record.attempt;
  const headers = [`From: ${d.account}`, `To: ${d.to.join(',\r\n ')}`,
    ...(d.cc.length ? [`Cc: ${d.cc.join(',\r\n ')}`] : []), ...(d.bcc.length ? [`Bcc: ${d.bcc.join(',\r\n ')}`] : []),
    `Subject: ${encodedSubject(d.subject)}`, `Date: ${new Date(a.at).toUTCString()}`, `Message-ID: ${a.message_id}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  if (d.reply) {
    headers.push(`In-Reply-To: ${d.reply.message_id}`);
    headers.push(`References: ${[...new Set([...d.reply.references, d.reply.message_id])].join('\r\n ')}`);
  }
  const content = Buffer.from(d.body.replaceAll('\n', '\r\n')).toString('base64').match(/.{1,76}/gu).join('\r\n');
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + content + '\r\n').toString('base64url');
}
