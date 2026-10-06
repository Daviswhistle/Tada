#!/usr/bin/env node
// Explicit owner-run contact host. No public deployment, account purchase or
// automatic provider fallback; the browser never configures the model/read roots.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContactStore, contactRoute } from './contact-store.mjs';
import { ContactService } from './contact-service.mjs';
import { serveContact, validateContactAddress } from './contact-http.mjs';
import { followupTimezone } from './followup-contract.mjs';

export const HELP = `Tada contact host — one continuing conversation across browsers and optional private messaging

npm run contact -- --data DIRECTORY --init --model INSTALLED_LOCAL_MODEL
npm run contact -- --data DIRECTORY --model INSTALLED_LOCAL_MODEL

Optional: --telegram (explicit private Telegram contact, same conversation)
          --upgrade-contact (back up and upgrade an existing contact journal to v4)
          --timezone IANA_ZONE (display and resolve times, e.g. Asia/Seoul)
          --broker ABSOLUTE_READ_BROKER --allow-read DIRECTORY (repeatable)
          --endpoint http://127.0.0.1:11434
          --port 8787 --origin https://YOUR_PRIVATE_CONTACT_HOST
          --bind ADDRESS --tls-cert FILE --tls-key FILE

Default browser address: http://127.0.0.1:8787 on this computer only. For browser
access from a phone outside your network, use an explicitly configured private HTTPS proxy/VPN, or your own TLS
certificate. Non-loopback plaintext listeners are rejected. No tunnel is installed.

The owner enters an encryption passphrase here (hidden; at least 16 characters).
--init creates a NEW private directory; later starts unlock the same journal.
The selected local Ollama model must already be installed, with cloud disabled.
No API key, paid inference, cloud host or model download is selected automatically.

Host controls: /telegram-pair, /telegram-approve CANDIDATE_ID, /telegram-status,
/pair (five-minute, one-use link), /devices, /revoke DEVICE_ID, /quit.
A paired browser can converse, see accepted requests/results and cancel a request.
Browser disconnect does not cancel accepted work. Host interruption is recorded;
an in-flight model call is not automatically replayed after restart.

Current work: conversation and approved local text research. Optional Telegram
private chat uses this same history and delivers results with the browser closed.
The bot token is entered here, hidden; a linking attempt requires local owner
approval. Telegram processes these chat messages and answers; this is not a
Secret Chat or an end-to-end encryption claim. No public inbound port is needed
for Telegram polling. Browser-origin result alerts contain no answer body.
Saved work and one-time check-in reminders share this conversation. Proposed
contents/times must first be confirmed in a browser or with /confirm PROPOSAL_ID
in the paired Telegram chat. Reminders must fall within the approving device's
remaining access lifetime (at most 30 days). After saving a timed commitment,
a paired owner may SEPARATELY approve one local read-only review in its browser
card or with /review COMMITMENT_ID VERSION in Telegram. This uses the SAME local
model, allowed sources, conversation and usage ledger (up to eight requests per
review, not a new allowance). /review-cancel COMMITMENT_ID VERSION cancels it.
No implicit action is authorized by a reminder. Tasks changed/cancelled or more
than 24 hours past their appointment before execution do not run. Unknown or
interrupted work is not retried. Waiting records do not monitor third-party replies.
Voice, mail/calendar, arbitrary actions, recurring jobs and automatic reply watching
remain unimplemented. Closed-tab results remain in the shared conversation. The host must
be running and reachable; sleep/power loss is not always-on service availability.
The inherited preview limits remain 64 model requests per journal and 14 KiB model
context. No automatic history deletion, reset, hidden compaction or budget refill.
`;
export function contactOptions(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = { roots: [], initialize: false, port: 8787, bind: '127.0.0.1', endpoint: 'http://127.0.0.1:11434' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--telegram' && !options.telegram) { options.telegram = true; continue; }
    if (key === '--upgrade-contact' && !options.upgrade) { options.upgrade = true; continue; }
    if (key === '--init' && !options.initialize) { options.initialize = true; continue; }
    if (!['--data', '--model', '--broker', '--allow-read', '--endpoint', '--origin', '--bind', '--port', '--tls-cert', '--tls-key', '--timezone'].includes(key)
        || !args[i + 1] || args[i + 1].startsWith('--') || (key !== '--allow-read' && seen.has(key))) throw new Error('CONTACT_OPTIONS_INVALID');
    seen.add(key); const value = args[++i];
    if (key === '--allow-read') options.roots.push(resolve(value));
    else options[key.slice(2)] = value;
  }
  if (!options.data || !options.model || options.roots.length > 8 || (options.roots.length && (!options.broker || !isAbsolute(options.broker)))
      || (!!options['tls-cert'] !== !!options['tls-key']) || !/^[0-9]+$/u.test(String(options.port))) throw new Error('CONTACT_OPTIONS_INVALID');
  options.timezone = followupTimezone(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  options.port = Number(options.port);
  if (options.port < 1 || options.port > 65535) throw new Error('CONTACT_OPTIONS_INVALID');
  options.origin ??= `http://127.0.0.1:${options.port}`;
  validateContactAddress({ ...options, tls: options['tls-cert'] ? {} : undefined });
  return options;
}
export async function hiddenPassphrase(input, output, label = '연락 기록 암호 (숨김): ') {
  output.write(label);
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  const abort = new AbortController();
  prompt.on('SIGINT', () => abort.abort()); prompt.on('close', () => abort.abort());
  try { return await prompt.question('', { signal: abort.signal }); }
  finally { prompt.close(); sink.destroy(); output.write('\n'); }
}
export async function telegramConsent(input, output) {
  const prompt = createInterface({ input, output, historySize: 0 });
  const abort = new AbortController();
  prompt.on('SIGINT', () => abort.abort()); prompt.on('close', () => abort.abort());
  try {
    return await prompt.question('텔레그램 개인 채팅을 같은 비서에 연결합니다. 이 채팅으로 맡긴 일의 답변에는 기존 대화·허용된 자료 내용이 포함될 수 있으며 Telegram 서버를 거칩니다. 본인 전용 봇에 연결하려면 YES: ', { signal: abort.signal }) === 'YES';
  } finally { prompt.close(); }
}
export async function main(args = process.argv.slice(2)) {
  const options = contactOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('CONTACT_OWNER_TERMINAL_REQUIRED');
  const { OllamaLocal } = await import('../../providers/src/ollama-local.mjs');
  const { NativeSources, runReadGateway } = await import('./native-sources.mjs');
  const provider = new OllamaLocal({ model: options.model, endpoint: options.endpoint });
  const signal = AbortSignal.timeout(20000);
  const identity = await provider.inspect(signal);
  const scopes = [];
  let sources = { definitions: [], validate: () => false, execute: async () => { throw new Error('CONTACT_NO_SOURCE'); }, verify: async () => false };
  if (options.roots.length) {
    sources = new NativeSources(options.broker, options.roots); await sources.initialize(signal);
    for (const root of options.roots) scopes.push({ path: root, identity: (await runReadGateway(options.broker, root, '-', 'scope', '.', 0, signal)).identity });
  }
  const route = contactRoute({ version: 1, provider: identity.provider, model: identity.model,
    digest: identity.model_digest, endpoint: options.endpoint, scopes });
  let passphrase = await hiddenPassphrase(process.stdin, process.stdout);
  if (options.initialize && passphrase !== await hiddenPassphrase(process.stdin, process.stdout, '같은 암호 다시 입력: ')) throw new Error('CONTACT_PASSPHRASE_MISMATCH');
  let store;
  try { store = new ContactStore({ directory: options.data, passphrase, route, initialize: options.initialize, followups: options.initialize, reviews: options.initialize }); }
  finally { passphrase = ''; } // JS string clearing is not guaranteed secure zeroization.
  const service = new ContactService(store, provider, sources, { timezone: options.timezone });
  let host, prompt, telegram;
  try {
    if (options.upgrade) {
      const messagingBackup = await store.upgradeMessaging();
      const followupBackup = await store.upgradeFollowups();
      const reviewBackup = await store.upgradeReviews();
      for (const path of [messagingBackup, followupBackup, reviewBackup].filter(Boolean)) process.stdout.write(`이전 연락 기록 백업: ${path}\n`);
      process.stdout.write('연락 기록 v4 · 맡긴 일과 일회성 자동 확인을 사용할 수 있습니다.\n');
    }
    if (store.contactVersion !== 4) throw new Error('CONTACT_REVIEW_UPGRADE_REQUIRED');
    if (options.telegram) {
      if (store.contactVersion < 2) throw new Error('CONTACT_MESSAGING_UPGRADE_REQUIRED');
      if (!await telegramConsent(process.stdin, process.stdout)) throw new Error('CONTACT_TELEGRAM_CONSENT_REQUIRED');
      const { TelegramAPI } = await import('./telegram-api.mjs');
      const { TelegramContact } = await import('./telegram-contact.mjs');
      let token = await hiddenPassphrase(process.stdin, process.stdout, '본인 전용 Telegram Bot 토큰 (숨김·이번 실행만): ');
      let api;
      try { api = new TelegramAPI(token); } finally { token = ''; }
      telegram = new TelegramContact(store, service, api);
      await telegram.initialize();
      telegram.on('pairing', ({ candidate, user }) => process.stdout.write(`텔레그램 연결 요청 · 사용자 ID ${user}. 본인이 방금 연 채팅인지 확인한 뒤 /telegram-approve ${candidate}\n`));
      telegram.on('status', code => process.stderr.write(`텔레그램 연락 상태: ${code}. 브라우저의 대화와 결과는 유지됩니다.\n`));
    }
    const tls = options['tls-cert'] ? { cert: readFileSync(options['tls-cert']), key: readFileSync(options['tls-key']) } : undefined;
    host = await serveContact({ store, service, origin: options.origin, bind: options.bind, port: options.port, tls, messaging: () => ({ enabled: !!telegram, ...(telegram ? telegram.status() : store.messagingStatus()) }) });
    process.stdout.write(`Tada 연락 호스트가 열렸습니다. 연결 링크는 본인 기기에서만 사용하세요.\n${host.pair()}\n`);
    process.stdout.write('/pair · /devices · /revoke DEVICE_ID · /quit\n');
    if (telegram) {
      if (!store.telegramBinding()?.live) process.stdout.write(`본인 Telegram 앱에서 열고 호스트에서 승인하세요:\n${telegram.pair()}\n`);
      process.stdout.write('/telegram-pair · /telegram-approve CANDIDATE_ID · /telegram-status\n');
      telegram.start();
    }
    prompt = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
    prompt.on('SIGINT', () => prompt.close());
    service.on('fault', () => { process.stderr.write('연락 기록을 안전하게 처리하지 못해 호스트를 중지합니다.\n'); prompt.close(); });
    service.start();
    for await (const line of prompt) {
      if (line === '/quit') break;
      if (line === '/telegram-status' && telegram) process.stdout.write(`${JSON.stringify(telegram.status())}\n`);
      else if (line === '/telegram-pair' && telegram) {
        try { process.stdout.write(`${telegram.pair()}\n`); } catch { process.stdout.write('먼저 기존 Telegram 기기를 해제하거나 연결 상태를 확인해 주세요.\n'); }
      } else if (/^\/telegram-approve [a-f0-9-]{36}$/u.test(line) && telegram) {
        try { process.stdout.write(`Telegram 연결 승인: ${telegram.approve(line.slice(18))}\n`); }
        catch { process.stdout.write('연결 요청이 만료됐거나 이미 연결돼 있습니다. 새 연결 요청을 확인해 주세요.\n'); }
      } else if (line === '/pair') process.stdout.write(`${host.pair()}\n`);
      else if (line === '/devices') {
        for (const device of store.devices()) {
          const name = device.name.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
          process.stdout.write(`${device.id} · ${name} · ${device.revoked ? '연결 해제' : '등록됨'}\n`);
        }
      } else if (/^\/revoke [a-f0-9-]{36}$/u.test(line)) service.revoke(line.slice(8));
      else process.stdout.write('대화는 연결한 브라우저에서 하세요. 호스트 명령: /pair, /devices, /revoke DEVICE_ID, /quit\n');
    }
  } finally { prompt?.close(); await telegram?.close(); await host?.close(); await service.close(); store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${/^CONTACT_[A-Z_]+$/u.test(error.message) ? error.message : 'CONTACT_STARTUP_FAILED'}\n`); process.exitCode = 1; });
}
