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
import { contactStorageKey } from './contact-key.mjs';
import { GoogleConnection } from './google-connection.mjs';
import { openSystemBrowser } from './system-browser.mjs';

export const HELP = `Tada contact host — one continuing conversation across browsers and optional private messaging

npm run contact -- --data DIRECTORY --init
npm run contact -- --data DIRECTORY
npm run contact -- --data DIRECTORY --logout
npm run contact -- --provider ollama --data DIRECTORY --init --model INSTALLED_LOCAL_MODEL

Default: ChatGPT subscription via official Continue with ChatGPT login.
Optional: --provider chatgpt|ollama --model MODEL
          --chatgpt-profile DIRECTORY (default: DATA.chatgpt-private)
          --login (reauthorize saved registration) --logout (stop and disconnect profile)
          --ask-passphrase (explicit legacy/manual encryption mode)
          --telegram (explicit private Telegram contact, same conversation)
          --upgrade-contact (back up and upgrade an existing contact journal to v5)
          --timezone IANA_ZONE (display and resolve times, e.g. Asia/Seoul)
          --broker ABSOLUTE_READ_BROKER --allow-read DIRECTORY (repeatable)
          --endpoint http://127.0.0.1:11434
          --port 8787 --origin https://YOUR_PRIVATE_CONTACT_HOST
          --bind ADDRESS --tls-cert FILE --tls-key FILE

Default browser address: http://127.0.0.1:8787 on this computer only. For browser
access from a phone outside your network, use an explicitly configured private HTTPS proxy/VPN, or your own TLS
certificate. Non-loopback plaintext listeners are rejected. No tunnel is installed.

Windows/WSL protects the local encryption key with the signed-in Windows account.
No extra Tada password is requested. Native Linux/macOS automatic protection is
not yet supported. Existing password-protected records use --ask-passphrase.
--init creates a NEW private directory; later starts unlock the same journal.
ChatGPT sends conversation and approved source observations to OpenAI using the
selected account plan. Initial transmission consent is required. No API billing
fallback. Model choices come from that account. OAuth credentials stay encrypted
on this host; no other app credentials are used. Plan limits: https://chatgpt.com/settings/usage
With --provider ollama, the local model must already be installed with cloud disabled.

Host controls: /telegram-pair, /telegram-approve CANDIDATE_ID, /telegram-status,
/pair (five-minute, one-use link), /devices, /revoke DEVICE_ID, /quit.
A paired browser can converse, see accepted requests/results and cancel a request.
Browser disconnect does not cancel accepted work. Host interruption is recorded;
an in-flight model call is not automatically replayed after restart.

Current work: conversation, approved local text research, and read-only Google
Gmail/calendar when the host OAuth setup is configured. Optional Telegram
private chat uses this same history and delivers results with the browser closed.
The bot token is entered here, hidden; a linking attempt requires local owner
approval. Telegram processes these chat messages and answers; this is not a
Secret Chat or an end-to-end encryption claim. No public inbound port is needed
for Telegram polling. Browser-origin result alerts contain no answer body.
Saved work and one-time check-in reminders share this conversation. Proposed
contents/times must first be confirmed in a browser or with /confirm PROPOSAL_ID
in the paired Telegram chat. Reminders must fall within the approving device's
remaining access lifetime (at most 30 days). After saving a timed commitment,
when using Ollama, a paired owner may SEPARATELY approve one local read-only review in its browser
card or with /review COMMITMENT_ID VERSION in Telegram. This uses the SAME local
model, allowed sources, conversation and usage ledger (up to eight requests per
review, not a new allowance). /review-cancel COMMITMENT_ID VERSION cancels it.
No implicit action is authorized by a reminder. Tasks changed/cancelled or more
than 24 hours past their appointment before execution do not run. Unknown or
interrupted work is not retried. Waiting records do not monitor third-party replies.
Voice, mail/calendar writes, arbitrary actions, recurring jobs and automatic reply watching
remain unimplemented. Read-only Google access is available when the host's OAuth setup is configured
and the owner connects an account in Settings. Closed-tab results remain in the shared conversation. The host must
be running and reachable; sleep/power loss is not always-on service availability.
The inherited preview limits remain 64 model requests per journal and 14 KiB model
context. No automatic history deletion, reset, hidden compaction or budget refill.
`;
export function contactOptions(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = { roots: [], initialize: false, port: 8787, bind: '127.0.0.1', provider: 'chatgpt' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--ask-passphrase' && !options.askPassphrase) { options.askPassphrase = true; continue; }
    if (['--login', '--logout'].includes(key) && !options[key.slice(2)]) { options[key.slice(2)] = true; continue; }
    if (key === '--telegram' && !options.telegram) { options.telegram = true; continue; }
    if (key === '--upgrade-contact' && !options.upgrade) { options.upgrade = true; continue; }
    if (key === '--init' && !options.initialize) { options.initialize = true; continue; }
    if (!['--provider', '--chatgpt-profile', '--data', '--model', '--broker', '--allow-read', '--endpoint', '--origin', '--bind', '--port', '--tls-cert', '--tls-key', '--timezone'].includes(key)
        || !args[i + 1] || args[i + 1].startsWith('--') || (key !== '--allow-read' && seen.has(key))) throw new Error('CONTACT_OPTIONS_INVALID');
    seen.add(key); const value = args[++i];
    if (key === '--allow-read') options.roots.push(resolve(value));
    else options[key.slice(2)] = value;
  }
  if (!options.data || !['chatgpt', 'ollama'].includes(options.provider) || (options.provider === 'ollama' && (!options.model || options.login || options.logout || options['chatgpt-profile'])) || (options.provider === 'chatgpt' && options.endpoint) || (options.login && options.logout) || (options.logout && options.initialize) || options.roots.length > 8 || (options.roots.length && (!options.broker || !isAbsolute(options.broker)))
      || (!!options['tls-cert'] !== !!options['tls-key']) || !/^[0-9]+$/u.test(String(options.port))) throw new Error('CONTACT_OPTIONS_INVALID');
  if (options.provider === 'ollama') options.endpoint ??= 'http://127.0.0.1:11434';
  else options.endpoint = 'https://api.openai.com/v1';
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
const terminalText = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
async function ownerQuestion(label) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  const abort = new AbortController();
  prompt.on('SIGINT', () => abort.abort()); prompt.on('close', () => abort.abort());
  try { return await prompt.question(label, { signal: abort.signal }); } finally { prompt.close(); }
}
export async function main(args = process.argv.slice(2), { keyProvider = contactStorageKey, ui } = {}) {
  const options = contactOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (!ui && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('CONTACT_OWNER_TERMINAL_REQUIRED');
  if (ui && (options.askPassphrase || options.telegram || options.logout)) throw Error('CONTACT_APP_ADVANCED_MODE');
  let accountStore, account, store, service, host, prompt, telegram, mobile;
  const profile = options.provider === 'chatgpt' ? resolve(options['chatgpt-profile'] ?? `${resolve(options.data)}.chatgpt-private`) : undefined;
  let passphrase;
  if (options.askPassphrase) {
    process.stdout.write('기존 암호 방식으로 기록을 엽니다. ChatGPT 비밀번호가 아닌 Tada 보관 암호이며, 입력은 화면에 표시되지 않습니다.\n');
    for (;;) {
      passphrase = await hiddenPassphrase(process.stdin, process.stdout, 'Tada 보관 암호 (16~1024자): ');
      if (passphrase.length < 16 || passphrase.length > 1024) { process.stdout.write('암호는 16~1024자여야 합니다. 다시 입력해 주세요.\n'); continue; }
      if (!options.initialize || passphrase === await hiddenPassphrase(process.stdin, process.stdout, '같은 암호 다시 입력: ')) break;
      process.stdout.write('두 암호가 다릅니다. 처음부터 다시 입력해 주세요.\n');
    }
  } else {
    passphrase = await keyProvider({ data: options.data, profile, initialize: options.initialize });
    process.stdout.write('이 Windows 계정으로 대화와 연결 정보를 암호화해 보관합니다. 별도 Tada 암호는 필요하지 않습니다.\n');
  }
  try {
    ui?.signal.throwIfAborted();
    const requestSignal = () => ui ? AbortSignal.any([ui.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const { NativeSources, runReadGateway } = await import('./native-sources.mjs');
    let provider, identity;
    const signal = requestSignal();
    if (options.provider === 'chatgpt') {
      const { ChatGPTStore } = await import('../../providers/src/chatgpt-store.mjs');
      const { ChatGPTAccount } = await import('../../providers/src/chatgpt-account.mjs');
      const { ChatGPTSubscription } = await import('../../providers/src/chatgpt-subscription.mjs');
      accountStore = new ChatGPTStore({ directory: profile, passphrase });
      account = new ChatGPTAccount(accountStore);
      if (options.logout) {
        const result = await account.logout();
        process.stdout.write(result.revoked ? 'ChatGPT 연결을 해제했습니다. 대화 기록은 보존됩니다.\n' : '이 호스트의 인증 정보를 지웠습니다. 서버 연결 해제는 확인하지 못했습니다. ChatGPT 설정에서 Tada 연결을 해제해 주세요.\n');
        return;
      }
      if (!account.profile.connected || options.login || ui?.reauthorize) {
        const accepted = ui ? (await ui.consent() ? 'YES' : '') : await ownerQuestion('Continue with ChatGPT — Tada 대화와 허용한 자료의 조회 내용이 선택한 ChatGPT 계정으로 전송됩니다. 해당 계정의 구독 사용량과 본인이 허용한 크레딧 설정을 따르며 API 결제로 전환하지 않습니다. 크레딧 사용을 원하지 않으면 ChatGPT 동의 화면과 사용량 설정에서 허용하지 마세요. 연결하려면 YES: ');
        if (accepted !== 'YES') throw Error('CHATGPT_CONSENT_REQUIRED');
        const attempt = await account.beginLogin({ signal: ui?.signal });
        if (ui) ui.login(attempt.url);
        else process.stdout.write(`본인 브라우저에서 로그인하세요 (5분 이내):\n${attempt.url}\n`);
        await attempt.done;
      }
      const catalog = await account.models(requestSignal());
      const saved = accountStore.read();
      let model = options.model ?? saved.model;
      if (!model) {
        for (const [i, item] of catalog.entries()) process.stdout.write(`${i + 1}. ${terminalText(item.display_name)}\n`);
        const choice = ui ? await ui.selectModel(catalog.map(item => ({ name: terminalText(item.display_name) }))) : await ownerQuestion('사용할 모델 번호 (Enter: 1): ');
        if (!/^(?:[1-9][0-9]*)?$/u.test(choice)) throw Error('CHATGPT_MODEL_UNAVAILABLE');
        model = catalog[Number(choice || 1) - 1]?.slug;
      }
      provider = new ChatGPTSubscription({ account, model });
      identity = await provider.inspect(requestSignal());
      process.stdout.write(`ChatGPT · ${terminalText(provider.identity.account_label)} · ${terminalText(provider.identity.display_name)}\n`);
    } else {
      const { OllamaLocal } = await import('../../providers/src/ollama-local.mjs');
      provider = new OllamaLocal({ model: options.model, endpoint: options.endpoint });
      identity = await provider.inspect(signal);
    }
    const scopes = [];
    let sources = { definitions: [], validate: () => false, execute: async () => { throw new Error('CONTACT_NO_SOURCE'); }, verify: async () => false };
    if (options.roots.length) {
      sources = new NativeSources(options.broker, options.roots); await sources.initialize(requestSignal());
      for (const root of options.roots) scopes.push({ path: root, identity: (await runReadGateway(options.broker, root, '-', 'scope', '.', 0, requestSignal())).identity });
    }
    ui?.signal.throwIfAborted();
    const route = contactRoute({ version: 1, provider: identity.provider, model: identity.model,
      digest: identity.model_digest, endpoint: options.endpoint, scopes });
    store = new ContactStore({ directory: options.data, passphrase, route, initialize: options.initialize, followups: options.initialize, reviews: options.initialize, assistance: options.initialize });
    if (options.initialize) ui?.initialized?.();
    if (accountStore) accountStore.save({ ...accountStore.read(), model: provider.model });
    passphrase = '';
    service = new ContactService(store, provider, sources, { timezone: options.timezone });
    const google = new GoogleConnection({ store, clientId: process.env.TADA_GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.TADA_GOOGLE_OAUTH_CLIENT_SECRET ?? '', openBrowser: openSystemBrowser });
    service.attachGoogle(google);
    if (options.upgrade || ui?.upgrade === true) {
      const messagingBackup = await store.upgradeMessaging();
      const followupBackup = await store.upgradeFollowups();
      const reviewBackup = await store.upgradeReviews();
      const assistanceBackup = await store.upgradeAssistance();
      for (const path of [messagingBackup, followupBackup, reviewBackup, assistanceBackup].filter(Boolean)) process.stdout.write(`이전 연락 기록 백업: ${path}\n`);
      process.stdout.write('연락 기록 v5 · 먼저 챙겨보기와 휴대폰 연결을 설정할 수 있습니다.\n');
    }
    if (store.contactVersion < 5) throw new Error('CONTACT_ASSISTANCE_UPGRADE_REQUIRED');
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
    if (!options.telegram) {
      const { MobileContact } = await import('./mobile-contact.mjs');
      mobile = new MobileContact(store, service); await mobile.restore();
    }
    const tls = options['tls-cert'] ? { cert: readFileSync(options['tls-cert']), key: readFileSync(options['tls-key']) } : undefined;
    host = await serveContact({ store, service, origin: options.origin, bind: options.bind, port: options.port, tls, mobile, messaging: () => (mobile ? mobile.status() : { enabled: !!telegram, ...(telegram ? telegram.status() : store.messagingStatus()) }) });
    if (ui) {
      service.on('fault', () => ui.fail());
      ui.signal.throwIfAborted();
      ui.ready(() => host.pair({ replaceApp: true }) + '&auto=1');
      service.start();
      await ui.wait();
      return;
    }
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
  } finally { passphrase = ''; prompt?.close(); await mobile?.close(); await telegram?.close(); await host?.close(); await service?.close(); store?.close(); await account?.stop(); accountStore?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const messages = {
      CHATGPT_CONSENT_REQUIRED: 'ChatGPT 연결을 진행하지 않았습니다. 다시 실행하면 연결할 수 있습니다.',
      CHATGPT_PROFILE_UNLOCK_FAILED: '계정 연결 기록을 열지 못했습니다. 기존 보호 키 또는 수동 모드의 암호를 확인해 주세요. 기록을 새로 만들거나 덮어쓰지 않았습니다.',
      CONTACT_KEY_PATH_REJECTED: '보호 키 위치의 접근 권한이나 파일 형식을 확인해야 합니다. 기존 파일을 삭제하지 말고 안전한 본인 전용 경로인지 확인해 주세요.',
      CONTACT_STORAGE_KEY_MISSING: '기록의 보호 키를 찾지 못했습니다. 자동 보호로 만든 기록은 원래 보호 키 백업을 복원하세요. 이전에 직접 암호를 설정한 기록만 --ask-passphrase로 열 수 있습니다. 기존 기록은 변경하지 않았습니다.',
      CONTACT_OS_PROTECTION_UNAVAILABLE: '이 환경에서는 Windows 계정의 자동 보호를 사용할 수 없습니다. Windows/WSL에서 실행해 주세요. 기존 수동 암호 기록은 --ask-passphrase로 열 수 있습니다.',
      CONTACT_OS_PROTECTION_FAILED: 'Windows 계정으로 보호 키를 열지 못했습니다. 기록을 만든 Windows 계정으로 실행해 주세요. 새 키로 교체하지 않았습니다.',
      CONTACT_STORAGE_KEY_UNAVAILABLE: '보호 키를 열지 못했습니다. 다른 Tada 실행이 있다면 종료 후 다시 시도해 주세요. 계속되면 보호 키 파일을 삭제하지 말고 오류를 확인해 주세요.',
      CONTACT_STORAGE_KEY_INVALID: '보호 키 형식이 맞지 않거나 손상됐습니다. 기존 키를 덮어쓰지 않았습니다. 보호 키 백업을 확인해 주세요.',
      CONTACT_ROUTE_CHANGED: '이 기록의 계정·모델·자료 범위가 다릅니다. 원래 설정으로 다시 열거나 새 --data 경로를 사용하세요. 기존 기록은 전송하지 않았습니다.',
    };
    process.stderr.write(`${error.name === 'AbortError' ? '입력을 취소했습니다. 다시 실행하면 이어서 설정할 수 있습니다.' : messages[error.message] ?? (/^(?:CONTACT|CHATGPT)_[A-Z_]+$/u.test(error.message) ? error.message : 'Tada를 시작하지 못했습니다.')}\n`);
    process.exitCode = 1;
  });
}
