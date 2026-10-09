import { decodeHeader } from './google-sources.mjs';
import { gmailId, mailAddress } from './mail-actions.mjs';
const header = (headers, name) => {
  const matches = headers.filter(h => typeof h?.name === 'string' && h.name.toLowerCase() === name);
  if (matches.length > 1 || matches.some(h => typeof h.value !== 'string')) throw Error('CONTACT_MAIL_RECEIPT_INVALID');
  return matches[0]?.value ?? '';
};
function addresses(value) {
  if (!value) return [];
  return value.replace(/\r?\n[ \t]+/gu, ' ').split(',').map(part => {
    const raw = part.trim(), bracket = /^(?:[^<>]*)<([^<>]+)>$/u.exec(raw);
    const address = bracket ? bracket[1] : raw;
    if (!mailAddress(address)) throw Error('CONTACT_MAIL_RECEIPT_INVALID');
    return address.toLowerCase();
  }).sort();
}
// Gmail's stored SENT copy is observable evidence, never recipient delivery.
// Unsupported/ambiguous MIME remains unknown; it cannot authorize a resend.
export function compareSentMail(record, message) {
  if (!gmailId(message?.id) || !gmailId(message.threadId) || !Array.isArray(message.labelIds)
      || !message.labelIds.includes('SENT') || !Array.isArray(message.payload?.headers)) return null;
  const p = message.payload, h = p.headers, d = record.draft;
  try {
    if (header(h, 'message-id').trim() !== record.attempt.message_id) return null;
    if (p.mimeType !== 'text/plain' || p.parts?.length || p.filename || p.body?.attachmentId
        || typeof p.body?.data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/u.test(p.body.data)) return null;
    // The Gmail body is transport-decoded, but charset still determines the
    // text a recipient sees. Accept only our supported plain UTF-8 MIME shape.
    const contentType = header(h, 'content-type').replace(/\r?\n[ \t]+/gu, ' ').trim();
    if (!/^text\/plain\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/iu.test(contentType)) return null;
    const bytes = Buffer.from(p.body.data, 'base64url');
    if (bytes.toString('base64url') !== p.body.data.replace(/=+$/u, '') || bytes.length > 32768) return null;
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return same(addresses(header(h, 'from')), [d.account.toLowerCase()])
      && ['to', 'cc', 'bcc'].every(k => same(addresses(header(h, k)), d[k].map(s => s.toLowerCase()).sort()))
      && decodeHeader(header(h, 'subject')) === d.subject && body === d.body
      && (!d.reply || message.threadId === d.reply.thread_id && header(h, 'in-reply-to').trim() === d.reply.message_id
        && same(header(h, 'references').trim().split(/\s+/u), [...new Set([...d.reply.references, d.reply.message_id])]));
  } catch { return null; }
}
