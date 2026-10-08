// A local owner-only setup window. It delegates to the existing contact runtime;
// provider credentials and storage keys never enter the browser.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseUniqueJson } from './json.mjs';

const assets = new Map([
  ['/', ['text/html; charset=utf-8', 'setup.html']],
  ['/setup.js', ['text/javascript; charset=utf-8', 'setup.js']],
  ['/app.css', ['text/css; charset=utf-8', 'app.css']],
]);
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
const messages = {
  CONTACT_ASSISTANCE_UPGRADE_REQUIRED: '먼저 챙겨보기와 휴대폰 연결을 추가하려면 기록 업데이트가 필요해요. 원본을 백업한 뒤 기존 대화를 그대로 이어갑니다.',
  CONTACT_REVIEW_UPGRADE_REQUIRED: '이전 버전에서 남긴 대화예요. 먼저 원본을 백업하고, 지금 버전에서 이어 쓸 수 있도록 기록을 업데이트할 수 있어요.',
  CONTACT_APP_ACTION_REQUIRES_RESTART: '다시 연결하거나 기록을 업데이트하려면 실행 중인 Tada를 종료한 뒤 다시 열어 주세요. 대화는 그대로 보관돼요.',
  CONTACT_APP_SETTINGS_IN_USE: 'Tada가 다른 설정으로 실행 중이에요. 현재 열린 Tada를 종료한 뒤 새 설정으로 열어 주세요.',
  CONTACT_APP_WINDOW_UNAVAILABLE: '실행 중인 Tada에 연결하지 못했어요. 잠시 후 Tada를 다시 열어 주세요.',
  CONTACT_APP_PRIVATE_PATH_REQUIRED: 'Tada의 시작 정보를 안전하게 보관할 수 없어요. 본인 전용 저장 위치인지 확인해 주세요.',
  CHATGPT_RESPONSE_LIMIT: 'ChatGPT에서 받은 정보가 Tada의 처리 범위를 넘었어요. 연결된 계정은 보존돼요. Tada 업데이트가 필요합니다.',
  CHATGPT_NETWORK_FAILED: 'ChatGPT에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 열어 주세요. 저장된 계정은 그대로예요.',
  CHATGPT_PROFILE_IN_USE: '같은 ChatGPT 연결을 다른 Tada에서 사용 중이에요. 그 Tada를 종료한 뒤 다시 열어 주세요.',
  CHATGPT_SIGN_IN_REQUIRED: 'ChatGPT 연결이 만료됐어요. 다시 연결하면 같은 대화로 돌아올 수 있어요.',
  CHATGPT_REFRESH_UNCERTAIN: 'ChatGPT 연결을 다시 확인해야 해요. 다시 로그인하면 같은 대화를 이어갈 수 있어요.',
  CHATGPT_LOGIN_CANCELLED: '연결을 멈췄어요. 준비되면 다시 시작하세요.',
  CHATGPT_LOGIN_DENIED: '로그인을 완료하지 않았어요. 원할 때 다시 연결할 수 있어요.',
  CHATGPT_LOGIN_TIMEOUT: '로그인 시간이 지났어요. 새 로그인 창을 열어 이어갈 수 있어요.',
  CHATGPT_ACCOUNT_CHANGED: '이 대화를 시작한 ChatGPT 계정으로 로그인해 주세요. 기존 대화는 다른 계정으로 보내지 않았어요.',
  CHATGPT_PLAN_PERMISSION_REQUIRED: 'ChatGPT에서 구독 사용을 허용해야 연결할 수 있어요. 다시 로그인해 연결 권한을 확인해 주세요.',
  CHATGPT_PLAN_UNAVAILABLE: '이 계정에서는 현재 Tada 연결을 사용할 수 없어요. ChatGPT의 계정과 워크스페이스 설정을 확인해 주세요.',
  CONTACT_OS_PROTECTION_UNAVAILABLE: '현재는 Windows 또는 WSL에서 시작할 수 있어요. 이 기기의 자동 기록 보호를 아직 지원하지 않아요.',
  CONTACT_OS_PROTECTION_FAILED: '기록을 만든 Windows 계정으로 실행해 주세요. 기존 대화와 보호 키는 그대로 두었어요.',
  CONTACT_STORAGE_KEY_MISSING: '기록을 여는 보호 키를 찾지 못했어요. 원래 기기의 키 백업이 필요해요. 기록을 새로 덮어쓰지 않았어요.',
  CONTACT_ROUTE_CHANGED: '이 대화를 시작한 계정·모델·자료 설정과 달라요. 원래 설정으로 열어야 같은 대화를 이어갈 수 있어요.',
  CONTACT_ALREADY_OWNED: 'Tada가 다른 창에서 실행 중이에요. 이미 열린 Tada로 돌아가 주세요.',
  EADDRINUSE: '대화 창의 주소가 이미 사용 중이에요. 실행 중인 Tada가 있다면 그 창으로 돌아가 주세요.',
  CONTACT_APP_ADVANCED_MODE: '이전 암호 기록과 Telegram의 고급 설정은 아직 시작 화면에서 열 수 없어요. 기존 실행 방법으로 기록을 열어 주세요.',
};
export function setupError(error) {
  return messages[error?.code] ?? messages[error?.message] ?? (error?.name === 'AbortError' ? messages.CHATGPT_LOGIN_CANCELLED : 'Tada를 여는 중 문제가 생겼어요. 연결을 확인하고 다시 시도해 주세요. 기존 기록은 지우지 않았어요.');
}
export async function serveSetup({ run, autoStart = true }) {
  const secret = randomBytes(32).toString('base64url');
  let origin, state = { stage: 'preparing', revision: randomUUID() }, task, controller, answer, entry, closed = false;
  const publish = (stage, fields = {}) => { state = { stage, revision: randomUUID(), ...fields }; };
  const start = (reauthorize = false, upgrade = false) => {
    if (task || closed) return false;
    controller = new AbortController();
    const signal = controller.signal;
    entry = null; publish('preparing');
    const ask = (stage, fields = {}) => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { answer = null; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      publish(stage, fields);
      answer = value => { answer = null; signal.removeEventListener('abort', abort); resolve(value); };
    });
    const ui = {
      signal, reauthorize, upgrade,
      consent: () => ask('consent'),
      login: url => { signal.throwIfAborted(); publish('login', { url }); },
      selectModel: models => ask('model', { models }),
      ready: source => { signal.throwIfAborted(); entry = typeof source === 'function' ? source : () => source; publish('ready', { url: entry() }); },
      wait: () => new Promise(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
      }),
      fail: () => controller.abort(Error('CONTACT_STORAGE_FAILED')),
    };
    task = Promise.resolve().then(() => run(ui)).catch(error => {
      const needsUpgrade = !signal.aborted && ['CONTACT_REVIEW_UPGRADE_REQUIRED', 'CONTACT_ASSISTANCE_UPGRADE_REQUIRED'].includes(error?.message);
      if (!closed) publish('error', { message: setupError(signal.aborted ? signal.reason : error), retryable: !needsUpgrade && error?.retryable !== false, upgrade: needsUpgrade, reauthorize: ['CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_REFRESH_UNCERTAIN', 'CHATGPT_PLAN_PERMISSION_REQUIRED'].includes(error?.message) });
    }).finally(() => {
      task = null; answer = null;
      if (!closed && state.stage !== 'error') publish('error', { message: 'Tada가 멈췄어요. 다시 열면 저장된 대화를 이어갈 수 있어요.' });
    });
    return true;
  };
  const send = (res, status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const timer = setTimeout(() => req.destroy(), 10000);
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
        || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(res, 403, {});
      if (req.method === 'GET' && assets.has(req.url)) {
        const [type, file] = assets.get(req.url);
        res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(readFileSync(new URL(`../../../apps/contact/${file}`, import.meta.url))); return;
      }
      const provided = req.headers.authorization ?? '';
      const expected = `Bearer ${secret}`;
      if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return send(res, 401, {});
      if (req.method === 'GET' && req.url === '/state') {
        if (state.stage === 'ready' && entry) {
          const url = entry();
          if (url !== state.url) publish('ready', { url });
        }
        return send(res, 200, state);
      }
      if (req.method !== 'POST' || req.url !== '/action' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(res, 403, {});
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024) throw Error(); chunks.push(chunk); }
      const body = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'action,revision,value' || body.revision !== state.revision) return send(res, 409, {});
      if (body.action === 'retry' && body.value === null && state.stage === 'error' && state.retryable !== false && !task) start(state.reauthorize === true);
      else if (body.action === 'upgrade' && body.value === true && state.stage === 'error' && state.upgrade === true && !task) start(false, true);
      else if (body.action === 'cancel' && body.value === null && ['login', 'model', 'consent'].includes(state.stage)) controller.abort(new DOMException('Cancelled', 'AbortError'));
      else if (body.action === 'answer' && answer && ((state.stage === 'consent' && body.value === true)
        || (state.stage === 'model' && typeof body.value === 'string' && /^[1-9][0-9]*$/u.test(body.value) && Number(body.value) <= state.models.length))) {
        const complete = answer; publish('preparing'); complete(body.value);
      } else return send(res, 409, {});
      send(res, 200, {});
    } catch { if (!res.headersSent) send(res, 400, {}); }
    finally { clearTimeout(timer); }
  });
  server.maxConnections = 16; server.maxHeadersCount = 24; server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (autoStart) start();
  return { url: `${origin}/#setup=${secret}`, start, async close() {
    closed = true; controller?.abort(new DOMException('Closed', 'AbortError'));
    await task;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
