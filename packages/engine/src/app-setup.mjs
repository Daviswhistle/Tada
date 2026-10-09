// A local owner-only setup window. It delegates to the existing contact runtime;
// provider credentials and storage keys never enter the browser.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAX_BACKUP_BYTES } from './contact-backup.mjs';
import { RESTORE_CONSENT } from './app-records.mjs';
import { parseUniqueJson } from './json.mjs';

const assets = new Map([
  ['/', ['text/html; charset=utf-8', 'setup.html']],
  ['/setup.js', ['text/javascript; charset=utf-8', 'setup.js']],
  ['/app.css', ['text/css; charset=utf-8', 'app.css']],
]);
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
const messages = {
  CONTACT_APP_CLOSE_FAILED: '진행 중이던 작업이 모두 종료됐는지 확인하지 못해 기록 전환을 멈췄어요. Tada를 완전히 종료한 뒤 다시 열어 주세요. 기존 기록은 보존돼 있습니다.',
  CONTACT_APP_RECOVERY_SOURCE_IN_USE: '기존 기록을 사용하는 다른 Tada가 열려 있어요. 그 Tada를 종료한 뒤 복원을 다시 시도해 주세요. 기존 기록은 옮기지 않았습니다.',
  CONTACT_APP_RECOVERY_UNAVAILABLE: '이 실행 방식에서는 화면에서 복원할 수 없어요. 기본 Tada 앱으로 열어 주세요.',
  CONTACT_APP_RECOVERY_ACTIVE_MISSING: '복원한 기록 파일을 찾을 수 없어 시작을 멈췄어요. 보관된 원본과 백업은 덮어쓰지 않았습니다.',
  CONTACT_APP_RECOVERY_CLIENT_CHANGED: '복원 중 Google 연결 준비 정보가 바뀌어 시작을 멈췄어요. 기록과 기존 연결은 보존돼 있습니다.',
  CONTACT_APP_RECOVERY_CANNOT_CANCEL: '이미 기록 전환을 시작해 지금 취소할 수 없어요. 다시 열기를 눌러 복원을 마쳐 주세요. 원본은 따로 보관돼 있습니다.',
  CONTACT_APP_RECOVERY_TOO_LARGE: '기록 구조가 현재 복원할 수 있는 범위를 넘었어요. 기존 기록은 그대로입니다.',
  CONTACT_APP_RECOVERY_PENDING: '진행 중인 기록 복원이 있어요. 복원 계속하기를 눌러 이어가 주세요.',
  CONTACT_APP_RECOVERY_PREVIEW_EXPIRED: '백업 확인 시간이 지났어요. 파일을 다시 선택해 내용을 확인해 주세요.',
  CONTACT_APP_RECOVERY_PROVIDER_MISMATCH: '이 백업은 현재 선택한 AI 연결 방식과 달라요. 백업을 만든 연결 방식으로 Tada를 열어 주세요.',
  CONTACT_APP_RECOVERY_PRIVATE_PATH_REQUIRED: '기록 복원 위치에 안전하게 접근할 수 없어요. 원본은 보존돼 있습니다.',
  CONTACT_APP_RECOVERY_ORIGINAL_CHANGED: '기존 기록의 상태가 바뀌어 복원을 멈췄어요. 원본을 덮어쓰지 않았습니다.',
  CONTACT_APP_RECOVERY_BARRIER_CHANGED: '이전 기록의 보호 상태를 확인할 수 없어 시작을 멈췄어요. 원본과 복원 기록은 보존돼 있습니다.',
  CONTACT_APP_RECOVERY_INVALID: '복원 준비 정보를 확인할 수 없어요. 기록을 덮어쓰거나 이전 작업을 다시 실행하지 않았습니다.',
  CONTACT_APP_RECOVERY_DIFFERENT_VOLUME: '현재 기록과 복원 위치가 서로 다른 저장 장치에 있어 안전하게 전환하지 못했어요. 원본은 그대로입니다.',
  CONTACT_BACKUP_CANNOT_OPEN: '백업을 열지 못했어요. 백업을 만든 Windows 계정에서 열거나 이 백업의 복구 코드를 입력해 주세요.',
  CONTACT_BACKUP_INVALID: 'Tada 백업 파일인지 확인해 주세요. 파일이 손상됐거나 지원하지 않는 형식입니다.',
  CONTACT_BACKUP_TOO_LARGE: '이 백업은 현재 복원할 수 있는 크기를 넘었어요. 원본 기록은 그대로입니다.',
  CONTACT_RECOVERY_INVALID: '백업 기록의 연결 관계를 확인하지 못했어요. 원본을 변경하지 않았습니다.',
  CONTACT_BACKUP_RECOVERY_CODE_REQUIRED: '이 백업을 만들 때 받은 복구 코드를 확인해 주세요.',
  CONTACT_BACKUP_NOT_PORTABLE: '이 백업에는 복구 코드가 없어요. 백업을 만든 Windows 계정에서 열어 주세요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_PRIVATE_PATH_REQUIRED: 'Google 연결 준비 정보를 안전하게 읽을 수 없어요. Tada의 개인 저장 위치와 파일 접근 권한을 확인한 뒤 다시 열어 주세요. 기존 대화는 그대로예요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_KEY_REQUIRED: 'Google 연결 준비 정보를 여는 보호 키를 확인할 수 없어요. 원래 기기의 보호 키를 복원한 뒤 Tada를 다시 열어 주세요. 기존 대화는 지우지 않았어요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_INVALID: 'Google 연결 준비 정보를 확인할 수 없어요. 원래 기기의 보호 키와 설정 백업을 복원한 뒤 Tada를 다시 열어 주세요. 기존 대화와 파일은 지우지 않았어요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_EXISTS: 'Google 연결 준비 정보가 이미 저장돼 있어 덮어쓰지 않았어요. 기존 설정으로 Tada를 다시 열어 주세요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_SAVE_FAILED: 'Google 연결 준비 정보를 안전하게 저장하지 못했어요. 저장 공간과 개인 접근 권한을 확인한 뒤 다시 시도해 주세요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_OWNER_REQUIRED: 'Google 연결 준비 정보를 저장하려면 같은 Tada 기록을 안전하게 열어야 해요. 실행 중인 Tada를 종료한 뒤 기존 보호 키로 설정을 복원해 주세요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_GRANT_PRESENT: '이미 연결된 Google 계정의 앱 설정을 바꾸지 않았어요. 기존 설정을 사용하거나 Tada 설정에서 Google 연결을 해제한 뒤 다시 준비해 주세요.',
  CONTACT_GOOGLE_CLIENT_CONFIG_UPGRADE_REQUIRED: 'Google 연결 준비 정보를 저장하려면 기록 업데이트가 필요해요. Tada를 열고 원본을 백업한 뒤 기존 대화를 이어 쓸 수 있도록 업데이트해 주세요.',
  CONTACT_MAIL_UPGRADE_REQUIRED: '메일 초안과 발송 결과를 보관하려면 기록 업데이트가 필요해요. 원본을 백업한 뒤 기존 대화와 연결을 그대로 이어갑니다. 업데이트 자체로 메일 발송 권한이 켜지지는 않아요.',
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
  CHATGPT_REGISTRATION_REJECTED: '저장된 ChatGPT 연결과 일치하지 않아 시작을 멈췄어요. 원래 연결로 다시 로그인해 주세요. 기록은 그대로 보관돼 있습니다.',
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
export async function serveSetup({ run, autoStart = true, autoRetry = false, retryDelays = [5000, 30000, 120000, 300000, 900000], records = null }) {
  if (typeof autoRetry !== 'boolean' || !Array.isArray(retryDelays) || !retryDelays.length || retryDelays.some(ms => !Number.isSafeInteger(ms) || ms < 1)) throw Error('CONTACT_SETUP_OPTIONS_INVALID');
  const secret = randomBytes(32).toString('base64url');
  let runtimeView, restoreError=null, restoreRequest=null, origin, state = { stage: 'preparing', revision: randomUUID() }, task, controller, answer, entry, closed = false, retryTimer, attempts = 0, transitioning = false, recoveryTask = null, restoringRun = false, restoreAccount = null, cleanupFailed = false;
  const canCancelRestore = () => { try { return records?.canCancel() === true; } catch { return false; } };
  const publish = (stage, fields = {}) => { state = { stage, revision: randomUUID(), restore_available: records?.available === true, restoring: restoringRun, restore_account: restoreAccount, ...fields, ...(restoreError?{restore_error:restoreError}:{}), ...(restoreRequest?{restore_request:restoreRequest}:{}) }; };
  const publishRuntime = (stage, fields = {}) => { runtimeView={stage,fields};if(!closed&&!transitioning)publish(stage,fields); };
  const start = (reauthorize = false, upgrade = false) => {
    if (task || closed || transitioning || cleanupFailed) return false;
    clearTimeout(retryTimer); retryTimer = null;
    controller = new AbortController();
    const signal = controller.signal;
    signal.addEventListener('abort',()=>{entry=null;if(runtimeView?.stage==='ready')publishRuntime('preparing',{message:'진행 중인 작업을 정리하고 있어요.'});},{once:true});
    let retry = false, interactive = false;
    entry = null; restoringRun = false; restoreAccount = null; publishRuntime('preparing');
    const ask = (stage, fields = {}) => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      interactive = true;
      const abort = () => { answer = null; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      publishRuntime(stage, fields);
      answer = value => { answer = null; signal.removeEventListener('abort', abort); resolve(value); };
    });
    const ui = {
      signal, reauthorize, upgrade,
      recordRestore: (enabled, account = null) => { restoringRun=enabled;restoreAccount=account;publishRuntime(runtimeView.stage,runtimeView.fields); },
      consent: () => ask('consent'),
      login: url => { signal.throwIfAborted(); interactive = true; publishRuntime('login', { url }); },
      selectModel: models => ask('model', { models }),
      ready: (source, restored = false) => { signal.throwIfAborted(); attempts = 0; restoringRun = false; restoreAccount = null; entry = typeof source === 'function' ? source : () => source; publishRuntime('ready', { url: entry(), restored }); },
      recovery: records?.available ? () => `${origin}/#recover=1` : null,
      wait: () => new Promise(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
      }),
      fail: () => controller.abort(Error('CONTACT_STORAGE_FAILED')),
    };
    task = Promise.resolve().then(() => run(ui)).catch(error => {
      if(error?.message==='CONTACT_APP_CLOSE_FAILED')cleanupFailed=true;
      // Only transient startup observations are repeatable. Login exchanges,
      // uncertain refreshes, storage failures and admitted work are not retried.
      retry = autoRetry && error?.retryable !== false && !signal.aborted && !entry && !interactive && (['CHATGPT_NETWORK_FAILED', 'OLLAMA_UNAVAILABLE', 'EADDRINUSE', 'ASSISTANT_CANCELLED'].includes(error?.message) || error?.code === 'EADDRINUSE' || error?.status >= 500 && error?.status <= 599);
      const needsUpgrade = !signal.aborted && ['CONTACT_REVIEW_UPGRADE_REQUIRED', 'CONTACT_ASSISTANCE_UPGRADE_REQUIRED', 'CONTACT_MAIL_UPGRADE_REQUIRED'].includes(error?.message);
      publishRuntime('error', { cancel_restore: !cleanupFailed && canCancelRestore(), message: setupError(signal.aborted && !cleanupFailed ? signal.reason : error), retryable: !needsUpgrade && error?.retryable !== false, upgrade: needsUpgrade, reauthorize: ['CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_REFRESH_UNCERTAIN', 'CHATGPT_PLAN_PERMISSION_REQUIRED', 'CHATGPT_ACCOUNT_CHANGED'].includes(error?.message) });
    }).finally(() => {
      task = null; answer = null; entry = null;
      if (runtimeView.stage !== 'error') publishRuntime('error', { message: 'Tada가 멈췄어요. 다시 열면 저장된 대화를 이어갈 수 있어요.' });
      if (!closed && !transitioning && retry) {
        const delay = retryDelays[Math.min(attempts++, retryDelays.length - 1)];
        publish('error', { ...state, revision: randomUUID(), retry_at: Date.now() + delay });
        retryTimer = setTimeout(() => start(), delay); retryTimer.unref();
      }
    });
    return true;
  };
  const send = (res, status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const timer = setTimeout(() => req.destroy(), req.url === '/recovery/preview' ? 30000 : 10000);
    try {
      // The conversation and setup use separate loopback ports. Permit their
      // top-level navigation; API access still requires same-origin + capability.
      const localNavigation = req.method === 'GET' && req.url === '/'
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
        || (!localNavigation && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(res, 403, {});
      if (req.method === 'GET' && assets.has(req.url)) {
        const [type, file] = assets.get(req.url);
        res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(readFileSync(new URL(`../../../apps/contact/${file}`, import.meta.url))); return;
      }
      const provided = req.headers.authorization ?? '';
      const expected = `Bearer ${secret}`;
      if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return send(res, 401, {});
      if (req.method === 'POST' && req.url === '/recovery/preview') {
        if (!records?.available || transitioning || recoveryTask || req.headers.origin !== origin || req.headers['content-type'] !== 'application/octet-stream') return send(res,409,{});
        let size=0;const chunks=[];
        for await (const chunk of req) {size+=chunk.length;if(size>MAX_BACKUP_BYTES+17000)throw Error('CONTACT_BACKUP_TOO_LARGE');chunks.push(chunk);}
        const code=req.headers['x-tada-recovery-code'];
        const preview=await records.preview(Buffer.concat(chunks),code===undefined?null:code);
        if (closed || res.destroyed) {records.clearPreview();return;}
        return send(res,200,{preview});
      }
      if (req.method === 'GET' && req.url === '/state') {
        if (state.stage === 'ready' && entry) {
          const url = entry();
          if (url !== state.url) publish('ready', { url, restored:state.restored, ...(state.restore_error?{restore_error:state.restore_error}:{}) });
        }
        return send(res, 200, state);
      }
      if (req.method !== 'POST' || req.url !== '/action' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(res, 403, {});
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024) throw Error(); chunks.push(chunk); }
      const body = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'action,revision,value' || body.revision !== state.revision) return send(res, 409, {});
      if (body.action === 'cancel_restore' && body.value === null && state.stage === 'error' && !task && !transitioning && !recoveryTask && !cleanupFailed && canCancelRestore()) { records.cancel();start();return send(res,200,{}); }
      if (body.action === 'restore' && records?.available && !cleanupFailed && !transitioning && !recoveryTask
          && body.value && Object.keys(body.value).sort().join(',')==='consent,id' && typeof body.value.id==='string' && /^[A-Za-z0-9-]{1,128}$/u.test(body.value.id) && body.value.consent===RESTORE_CONSENT) {
        transitioning=true;restoreError=null;restoreRequest=body.value.id;clearTimeout(retryTimer);publish('restoring',{message:'진행 중인 작업을 정리하고 선택한 기록을 준비하고 있어요.'});
        recoveryTask=(async()=>{
          try {
            await records.confirm(body.value.id,body.value.consent);
            controller?.abort(new DOMException('Restoring records','AbortError'));await task;
            if(cleanupFailed)throw Error('CONTACT_APP_CLOSE_FAILED');
            transitioning=false;if(!closed)start();
          } catch(error) {
            if(controller?.signal.aborted)await task;transitioning=false;restoreError=setupError(error);
            if(!closed){
              if(task&&!controller.signal.aborted&&!cleanupFailed)publish(runtimeView.stage,{...runtimeView.fields,restore_error:setupError(error)});
              else publish('error',{message:setupError(error),retryable:!task&&!cleanupFailed});
            }
          }
          finally {recoveryTask=null;}
        })();
        return send(res,202,{});
      }
      if (body.action === 'retry' && body.value === null && state.stage === 'error' && state.retryable !== false && !task) start(state.reauthorize === true);
      else if (body.action === 'upgrade' && body.value === true && state.stage === 'error' && state.upgrade === true && !task) start(false, true);
      else if (body.action === 'cancel' && body.value === null && ['login', 'model', 'consent'].includes(state.stage)) {
        if (restoringRun && records && !recoveryTask) {
          transitioning=true;publish('restoring',{message:'복원을 취소하고 기존 대화로 돌아가고 있어요.'});controller.abort(new DOMException('Cancelled','AbortError'));
          recoveryTask=(async()=>{try{await task;if(cleanupFailed)throw Error('CONTACT_APP_CLOSE_FAILED');records.cancel();transitioning=false;if(!closed)start();}catch(error){transitioning=false;if(!closed)publish('error',{message:setupError(error),retryable:!cleanupFailed});}finally{recoveryTask=null;}})();
        } else controller.abort(new DOMException('Cancelled', 'AbortError'));
      }
      else if (body.action === 'answer' && answer && ((state.stage === 'consent' && body.value === true)
        || (state.stage === 'model' && typeof body.value === 'string' && /^[1-9][0-9]*$/u.test(body.value) && Number(body.value) <= state.models.length))) {
        const complete = answer; publishRuntime('preparing'); complete(body.value);
      } else return send(res, 409, {});
      send(res, 200, {});
    } catch(error) { if (!res.headersSent) send(res, 400, {message:setupError(error)}); }
    finally { clearTimeout(timer); }
  });
  server.maxConnections = 16; server.maxHeadersCount = 24; server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (autoStart) start();
  return { url: `${origin}/#setup=${secret}`, start, async close() {
    closed = true; clearTimeout(retryTimer); controller?.abort(new DOMException('Closed', 'AbortError'));
    await recoveryTask;await task;records?.clearPreview();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
