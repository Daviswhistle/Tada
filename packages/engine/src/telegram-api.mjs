// The only production endpoint is Telegram's official HTTPS Bot API. Credentials
// stay in this trusted transport, never in model tools, logs or browser state.
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { parseUniqueJson } from './json.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0 && value < 2 ** 52;
const METHODS = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage']);
const hash = value => createHash('sha256').update(value).digest('hex');
export class TelegramFault extends Error {
  constructor(code, { retryAfter = null, definitelyRejected = false } = {}) {
    super(code); this.retryAfter = retryAfter; this.definitelyRejected = definitelyRejected;
  }
}
export class TelegramAPI {
  #token; #request; #active = new Set(); #closed = false; #bot;
  // Injection is a trusted-host test seam, not a CLI endpoint override.
  constructor(token, requestFactory = httpsRequest) {
    if (typeof token !== 'string' || !/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,128}$/u.test(token)) throw new TelegramFault('CONTACT_TELEGRAM_TOKEN_INVALID');
    this.#token = token; this.#request = requestFactory;
  }
  async #call(method, input, signal, timeout = 35000) {
    if (this.#closed) throw new TelegramFault('CONTACT_TELEGRAM_CLOSED');
    if (!METHODS.has(method)) throw new TelegramFault('CONTACT_TELEGRAM_METHOD_REJECTED');
    if (signal?.aborted) throw new TelegramFault('CONTACT_TELEGRAM_CANCELLED');
    const encoded = Buffer.from(JSON.stringify(input));
    if (encoded.length > 32768) throw new TelegramFault('CONTACT_TELEGRAM_BODY_LIMIT');
    return await new Promise((resolve, reject) => {
      let req, res, done = false, status = 0, bytes = 0;
      const chunks = [];
      const finish = (error, value) => {
        if (done) return; done = true;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        this.#active.delete(req);
        if (error) { res?.destroy(); req?.destroy(); reject(error); }
        else resolve(value);
      };
      const cancel = () => finish(new TelegramFault('CONTACT_TELEGRAM_CANCELLED'));
      const timer = setTimeout(() => finish(new TelegramFault('CONTACT_TELEGRAM_TIMEOUT')), timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        req = this.#request({ protocol: 'https:', hostname: 'api.telegram.org', port: 443,
          path: `/bot${this.#token}/${method}`, method: 'POST', agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': encoded.length, Accept: 'application/json' } }, incoming => {
          res = incoming; status = res.statusCode;
          if (done) { res.destroy(); return; }
          if (status >= 300 && status < 400) { finish(new TelegramFault('CONTACT_TELEGRAM_REDIRECT_REJECTED')); return; }
          res.on('error', () => finish(new TelegramFault('CONTACT_TELEGRAM_NETWORK')));
          res.on('aborted', () => finish(new TelegramFault('CONTACT_TELEGRAM_NETWORK')));
          res.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 262144) { finish(new TelegramFault('CONTACT_TELEGRAM_RESPONSE_LIMIT')); return; }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (done) return;
            try {
              const body = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), 262144);
              if (!body || typeof body.ok !== 'boolean') throw new TelegramFault('CONTACT_TELEGRAM_PROTOCOL');
              if (!body.ok) {
                const error = body.error_code;
                if (!Number.isInteger(error)) throw new TelegramFault('CONTACT_TELEGRAM_PROTOCOL');
                const retry = body.parameters?.retry_after;
                const retryAfter = error === 429 && Number.isInteger(retry) && retry > 0 && retry <= 86400 ? retry : null;
                throw new TelegramFault(error === 401 || error === 403 ? 'CONTACT_TELEGRAM_ACCESS_DENIED'
                  : error === 409 ? 'CONTACT_TELEGRAM_POLL_CONFLICT' : error === 429 ? 'CONTACT_TELEGRAM_RATE_LIMIT'
                    : 'CONTACT_TELEGRAM_REJECTED', { retryAfter, definitelyRejected: [400,401,403,409,429].includes(error) && status < 500 });
              }
              if (status !== 200 || body.result === undefined) throw new TelegramFault('CONTACT_TELEGRAM_PROTOCOL');
              finish(null, body.result);
            } catch (error) { finish(error instanceof TelegramFault ? error : new TelegramFault('CONTACT_TELEGRAM_PROTOCOL')); }
          });
        });
        this.#active.add(req);
        req.on('error', () => finish(new TelegramFault('CONTACT_TELEGRAM_NETWORK')));
        req.on('close', () => { if (!done) finish(new TelegramFault('CONTACT_TELEGRAM_NETWORK')); });
        req.end(encoded);
      } catch { finish(new TelegramFault('CONTACT_TELEGRAM_NETWORK')); }
    });
  }
  async inspect(signal) {
    const me = await this.#call('getMe', {}, signal);
    if (!positive(me?.id) || me.is_bot !== true || typeof me.username !== 'string'
        || !/^[A-Za-z0-9_]{5,32}$/u.test(me.username) || String(me.id) !== this.#token.split(':')[0]) throw new TelegramFault('CONTACT_TELEGRAM_IDENTITY_MISMATCH');
    const webhook = await this.#call('getWebhookInfo', {}, signal);
    if (!webhook || typeof webhook.url !== 'string') throw new TelegramFault('CONTACT_TELEGRAM_PROTOCOL');
    if (webhook.url !== '') throw new TelegramFault('CONTACT_TELEGRAM_WEBHOOK_PRESENT');
    this.#bot = String(me.id);
    return { id: this.#bot, username: me.username };
  }
  async updates(offset, signal) {
    if (!this.#bot) throw new TelegramFault('CONTACT_TELEGRAM_NOT_INSPECTED');
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new TelegramFault('CONTACT_TELEGRAM_CURSOR_INVALID');
    const values = await this.#call('getUpdates', { ...(offset === undefined ? {} : { offset }), timeout: 25,
      limit: 20, allowed_updates: ['message'] }, signal);
    if (!Array.isArray(values) || values.length > 20 || values.some((v, i) => !Number.isSafeInteger(v?.update_id)
        || v.update_id < 0 || v.update_id === Number.MAX_SAFE_INTEGER || (i && v.update_id <= values[i - 1].update_id))) throw new TelegramFault('CONTACT_TELEGRAM_PROTOCOL');
    return values;
  }
  async send(delivery, signal) {
    if (!this.#bot || delivery.bot !== this.#bot || !positive(Number(delivery.chat))
        || String(Number(delivery.chat)) !== delivery.chat || typeof delivery.text !== 'string'
        || !delivery.text.trim() || delivery.text.length > 4096) throw new TelegramFault('CONTACT_TELEGRAM_SEND_INVALID');
    const message = await this.#call('sendMessage', { chat_id: delivery.chat, text: delivery.text,
      link_preview_options: { is_disabled: true }, protect_content: true }, signal, 20000);
    if (!positive(message?.message_id) || message.chat?.type !== 'private' || String(message.chat.id) !== delivery.chat
        || message.from?.is_bot !== true || String(message.from.id) !== this.#bot || message.text !== delivery.text) throw new TelegramFault('CONTACT_TELEGRAM_RECEIPT_MISMATCH');
    return { message_id: message.message_id, chat: delivery.chat, bot: this.#bot, text_hash: hash(delivery.text) };
  }
  close() { this.#closed = true; for (const request of this.#active) request.destroy(); this.#active.clear(); this.#token = ''; }
}
