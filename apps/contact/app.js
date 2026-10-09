// Browser receives visible turns, never private tool context, host secrets or an execution API.
const connectionLost = '연결이 잠시 끊겼어요. 작성한 내용은 그대로 있어요.';
const $ = id => document.getElementById(id);
let mailSendUnknown = false, mailRecord = null, mailTarget = null, mailBusy = false, mailDirty = false, mailGoogle = null, mailDisableBusy = false, mailGeneration = 0, mailDiscardAction = null, mailRead = null, mailRefresh = null;
const link = new URLSearchParams(location.hash.slice(1));
let code = link.get('pair');
const autoPair = link.get('auto') === '1';
if (location.hash) history.replaceState(null, '', location.pathname);
let channel, nextBefore = null, requestGeneration = 0, rendered = '', pending = null, known = false;
let turns = new Map();
let browserBusy = false, browserView = null;
let documentEditing = false, editorState = null, editorGeneration = 0, editorBusy = false, editorBackups = [], editorDiscard = null;
let connectionStopped = false, recoveryEnabled = false, recoveryTimer = null, recoveryAt = 0, recoveryDelay = 2000, stateRequest = null;
function clearRecoveryTimer() { clearTimeout(recoveryTimer); recoveryTimer = null; recoveryAt = 0; }
function scheduleRecovery(delay) {
  if (!recoveryEnabled) return;
  const at = performance.now() + delay;
  // Repeated stream failures must not postpone an already scheduled read.
  if (recoveryTimer !== null && recoveryAt <= at) return;
  clearRecoveryTimer(); recoveryAt = at;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (!recoveryEnabled) return;
    if (stateRequest) { scheduleRecovery(1000); return; }
    // Only state reads are retried. Pairing still requires a definitive 401;
    // an ambiguous message submission is never sent again by this timer.
    if (code && autoPair) openConversation(); else refresh(false, true);
  }, delay);
}
function subscribe() {
  if (channel?.readyState === 2) { channel.close(); channel = null; }
  if (channel) return;
  const current = channel = new EventSource('/api/events');
  current.addEventListener('changed', () => { if (channel === current && recoveryEnabled) refresh(false, true); });
  current.onerror = () => {
    if (channel !== current || !recoveryEnabled) return;
    if (current.readyState === 2) { current.close(); channel = null; }
    $('connection').textContent = '재연결 중 · 접수한 요청은 유지됩니다';
    scheduleRecovery(recoveryDelay);
  };
}
function resumeConnection() {
  if (!recoveryEnabled || stateRequest) return;
  if (code && autoPair) openConversation(); else refresh(false, true);
}
window.addEventListener('online', resumeConnection);
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeConnection(); });
const notice = text => {
  $('notice').textContent = text; $('notice').hidden = !text || $('settings').open;
  $('settings-notice').textContent = text; $('settings-notice').hidden = !text || !$('settings').open;
};
let continuingEnabled = false, delegationEnabled = false, delegationBusy = false;
let backgroundEnabled = false, backgroundBusy = false;
const settingsPages = ['care', 'accounts', 'mobile', 'records'];
function showSettingsPage(page) {
  $('settings-content').scrollTop = 0;
  for (const name of settingsPages) {
    $('settings-' + name).hidden = name !== page;
    $('settings-nav-' + name).setAttribute('aria-pressed', String(name === page));
  }
}
function openSettings(page = 'care') {
  showSettingsPage(page);
  if (!$('settings').open) $('settings').showModal();
  notice($('notice').textContent);
}
$('settings-open').onclick = () => openSettings();
$('settings-close').onclick = () => { if (canCloseBackup()) $('settings').close(); };
$('settings').oncancel = event => { if (!canCloseBackup()) event.preventDefault(); };
$('settings').onclose = () => { clearBackup(); $('mobile-token').value = ''; $('settings-open').focus(); notice($('settings-notice').textContent); };
for (const name of settingsPages) $('settings-nav-' + name).onclick = () => showSettingsPage(name);
$('settings-contact-link').onclick = () => { showSettingsPage('mobile'); $('settings-nav-mobile').focus(); };
const errors = {
  CONTACT_BACKUP_BUSY: '다른 백업을 만들고 있어요. 잠시 후 다시 시도해 주세요.',
  CONTACT_BACKUP_TOO_LARGE: '기록이 현재 백업 용량 한도를 넘었어요. 원래 기록은 그대로 보관되어 있습니다.',
  CONTACT_OS_PROTECTION_UNAVAILABLE: '이 환경에서 Windows 계정 보호를 사용할 수 없어 백업을 만들지 않았어요.',
  CONTACT_OS_PROTECTION_FAILED: 'Windows 계정으로 백업을 보호하지 못했어요. 기록은 유지되며 다시 시도할 수 있습니다.',
  CONTACT_BACKUP_INVALID: '기록의 형식을 확인하지 못해 백업을 만들지 않았어요. 원래 기록은 그대로 있습니다.',
  CONTACT_BROWSER_DISPLAY_UNAVAILABLE: '현재 실행 환경에서 화면을 열 수 없어요. 데스크톱에 로그인한 뒤 Tada를 다시 열어 주세요.',
  CONTACT_BROWSER_COMMAND_FAILED: '브라우저 화면이 바뀌어 작업을 마치지 못했어요. 현재 페이지를 확인해 주세요.',
  CONTACT_BROWSER_OBSERVATION_FAILED: '이 화면은 읽거나 입력할 수 없어요. 일반 웹 페이지의 입력란을 공유해 주세요.',
  CONTACT_BROWSER_UNAVAILABLE: '이 컴퓨터에서 지원하는 브라우저를 찾지 못했어요. Chrome을 설치한 뒤 다시 열어 주세요. Windows에서는 Edge도 사용할 수 있어요.',
  CONTACT_BROWSER_DISCONNECTED: '전용 브라우저 연결이 끝났어요. 창을 다시 열고 필요한 탭을 공유해 주세요.',
  CONTACT_BROWSER_TARGET_CHANGED: '공유한 페이지나 입력란이 바뀌었어요. 현재 탭을 다시 공유해 주세요.',
  CONTACT_BROWSER_EFFECT_UNRESOLVED: '앞선 입력 결과를 확인하지 못해 같은 사이트의 새 입력을 멈췄어요. 브라우저에서 실제 상태를 확인해 주세요.',
  CONTACT_BROWSER_ACTION_LIMIT: '브라우저 작업 보관 한도에 도달해 새 입력을 멈췄어요. 기존 기록은 유지됩니다.',
  CONTACT_BROWSER_RESPONSE_UNKNOWN: '브라우저 응답을 확인하지 못했어요. 입력한 내용은 반복하지 않고 실제 화면을 확인해 주세요.',
  CONTACT_BROWSER_CONSENT_REQUIRED: '공유할 탭과 입력 허용 범위를 확인해 주세요.',

  CONTACT_DOCUMENT_INVALID: '문서 제목과 내용을 확인해 주세요. 비어 있거나 너무 긴 문서는 저장할 수 없어요.',
  CONTACT_DOCUMENT_NOT_FOUND: '이 문서를 찾지 못했어요. 대화에서 문서를 다시 열어 주세요.',
  CONTACT_DOCUMENT_READ_REQUIRED: '최신 문서를 읽지 않아 수정본을 저장하지 않았어요. 다시 수정해 달라고 말씀해 주세요.',
  CONTACT_DOCUMENT_STALE: '그사이 새 버전이 저장됐어요. 작성한 내용은 그대로 두었어요. 최신 버전을 확인해 주세요.',
  CONTACT_DOCUMENT_EDIT_UPGRADE_REQUIRED: 'Tada를 다시 열어 기록 업데이트를 마치면 직접 수정할 수 있어요. 기존 문서는 그대로 보관돼요.',
  CONTACT_HISTORY_DISABLED: '이전 대화 사용 설정이 바뀌어 이번 작업을 중지했어요. 현재 설정을 확인한 뒤 다시 말씀해 주세요.',
  CONTACT_FOLLOWUP_DELEGATION_CONSENT_REQUIRED: '대화로 맡길 개인 할 일과 알림의 범위를 확인해 주세요.',
  CONTACT_FOLLOWUP_DELEGATION_CHANGED: '대화로 맡기기 설정이 바뀌어 이번 변경을 저장하지 않았어요. 현재 설정을 확인한 뒤 다시 말씀해 주세요.',
  CONTACT_BACKGROUND_UNAVAILABLE: '이 환경에서는 자동 실행을 준비하지 못했어요. 현재 대화는 계속 사용할 수 있습니다.',
  CONTACT_BACKGROUND_SETTINGS_IN_USE: '다른 실행 설정이 저장돼 있어 덮어쓰지 않았어요. 기존 실행 설정을 확인해야 합니다.',
  CONTACT_BACKGROUND_GOOGLE_SETTINGS_REQUIRED: '현재 Google 연결은 이 실행 창의 설정을 사용하고 있어 자동 실행으로 옮기지 않았어요. 같은 연결 설정을 저장한 뒤 켜야 합니다. 지금 대화는 계속 사용할 수 있어요.',
  CONTACT_BACKGROUND_BUSY: '자동 실행을 준비하고 있어요. 잠시 후 다시 확인해 주세요.',
  CONTACT_BACKGROUND_START_FAILED: '자동 실행 설정은 저장했지만 시작을 확인하지 못했어요. 현재 비서는 계속 실행됩니다. 잠시 후 다시 켜 주세요.',
  CONTACT_BACKGROUND_CONSENT_REQUIRED: '같은 계정과 대화로 자동 실행하는 안내를 확인해 주세요.',
  CONTACT_HOST_STOPPING: 'Tada가 요청 접수를 멈췄어요. 작성한 내용은 유지됩니다. 다시 연결되면 보내 주세요.',
  CONTACT_PROACTIVE_CONSENT_REQUIRED: '먼저 챙겨보기의 범위와 사용량 안내를 확인해 주세요.',
  CONTACT_ASSISTANCE_UPGRADE_REQUIRED: 'Tada를 다시 열어 기록 업데이트를 완료해 주세요. 원본은 먼저 백업합니다.',
  CONTACT_MOBILE_BUSY: '휴대폰 연결을 확인하고 있어요. 잠시 후 다시 시도해 주세요.',
  CONTACT_MOBILE_RECONNECT: 'Telegram 연결을 다시 확인해야 해요. 연결 키를 확인하고 다시 연결해 주세요.',
  CONTACT_TELEGRAM_TOKEN_INVALID: 'BotFather가 준 연결 키 전체를 붙여 넣어 주세요.',
  CONTACT_TELEGRAM_ACCESS_DENIED: 'Telegram이 연결 키를 허용하지 않았어요. BotFather에서 현재 키를 확인해 주세요.',
  CONTACT_TELEGRAM_WEBHOOK_PRESENT: '다른 서비스가 사용하는 봇이에요. Tada 전용 봇을 만들어 연결해 주세요.',
  CONTACT_TELEGRAM_BOT_CHANGED: '이 대화에 연결했던 봇과 달라요. 기존 봇의 연결 키를 사용해 주세요.',
  CONTACT_TELEGRAM_POLL_CONFLICT: '다른 프로그램이 이 봇에 연결 중이에요. 그 연결을 종료하고 다시 연결해 주세요.',

  CONTACT_REVIEW_LOCAL_PROVIDER_REQUIRED: '예약된 자료 재확인은 현재 로컬 모델에서만 지원합니다. 지금 대화로 자료 확인을 맡길 수 있습니다.',
  CONTACT_REVIEW_UPGRADE_REQUIRED: '이 호스트는 자동 확인용 기록 전환이 필요합니다. 호스트에서 --upgrade-contact로 백업 후 전환해 주세요.',
  CONTACT_REVIEW_CONSENT_REQUIRED: '일회성 로컬 확인 범위를 명시적으로 승인해야 합니다.',
  CONTACT_REVIEW_TIME_REQUIRED: '미래의 확인 시각이 있는 진행 중 업무에만 자동 확인을 맡길 수 있습니다.',
  CONTACT_PAIR_REQUIRED: '이 기기의 연결을 확인해야 합니다. 컴퓨터에서 Tada를 다시 열어 연결해 주세요.',
  CONTACT_PAIR_REJECTED: '연결 링크가 만료됐거나 이미 사용됐습니다. 새 링크로 연결해 주세요.',
  CONTACT_REQUEST_LIMIT: '현재 사용할 수 있는 AI 한도에 도달했어요. 설정 → 연결된 계정에서 사용 여유와 다시 가능한 시각을 확인하세요. 대화와 결과는 보존됩니다.',
  ASSISTANT_SESSION_REQUEST_LIMIT: '현재 사용할 수 있는 AI 한도에 도달했어요. 설정 → 연결된 계정에서 사용 여유를 확인하세요.',
  CONTACT_USAGE_CONSENT_REQUIRED: '지속 사용의 범위와 사용량 안내를 확인해 주세요.',
  CONTACT_QUEUE_LIMIT: '대기 중인 요청이 많습니다. 접수된 일은 그대로 진행합니다.',
  CONTACT_FOLLOWUP_DEVICE_EXPIRES: '알림 시각이 이 기기의 접근권 유효기간을 넘습니다. 연결을 갱신하거나 더 가까운 시각으로 다시 맡겨 주세요.',
  CONTACT_FOLLOWUP_STALE: '다른 기기에서 업무가 먼저 바뀌었습니다. 최신 내용에 맞춰 다시 이야기해 주세요.',
  CONTACT_FOLLOWUP_EXPIRED: '제안의 유효시간이 지났습니다. 현재 의도와 시각을 확인해 새로 맡겨 주세요.',
  CONTACT_FOLLOWUP_TIME_INVALID: '확인 시각이 지났거나 날짜·시간대가 유효하지 않습니다. 새 시각으로 이야기해 주세요.',
  CONTACT_FOLLOWUP_DECISION_CONFLICT: '이미 처리되거나 다른 변경으로 대체된 제안입니다. 최신 업무 기록을 확인해 주세요.',
  CONTACT_MAIL_INVALID: '메일 주소·제목·내용을 확인해 주세요. 받는 사람은 최대 20명, 내용은 16 KiB까지 보관할 수 있어요.',
  CONTACT_MAIL_DRAFT_CHANGED: '다른 곳에서 초안이 바뀌었어요. 지금 입력은 유지했습니다. 최신 상태를 확인한 뒤 다시 수정해 주세요.',
  CONTACT_MAIL_ALREADY_DISPATCHED: '이 초안은 이미 발송을 시작했거나 정리한 기록이에요. 최신 상태를 확인해 주세요. 자동 재발송하지 않습니다.',
  CONTACT_MAIL_STATE_INVALID: '이 상태에서는 요청한 작업을 할 수 없어요. 최신 상태를 확인해 주세요.',
  CONTACT_MAIL_BUSY: '이 메일의 발송 또는 결과 확인이 진행 중이에요. 잠시 뒤 최신 상태를 확인해 주세요.',
  CONTACT_MAIL_SEND_PERMISSION_REQUIRED: 'Google에서 이 계정의 발송 권한을 먼저 연결해 주세요.',
  CONTACT_MAIL_CONSENT_REQUIRED: '받는 사람과 내용을 확인한 뒤 이 내용으로 보내기를 눌러 주세요.',
  CONTACT_MAIL_ACCOUNT_CHANGED: '초안을 만든 Google 계정과 현재 계정이 달라요. 초안의 계정을 다시 연결해 주세요.',
  CONTACT_MAIL_REPLY_READ_REQUIRED: '답장할 원본 메일을 이번 대화에서 먼저 읽어야 해요. 원본을 확인해 답장 초안을 다시 요청해 주세요.',
  CONTACT_MAIL_UPGRADE_REQUIRED: 'Tada를 다시 열고 기록 백업·업데이트를 마치면 메일 초안을 이어 쓸 수 있어요.',
  CONTACT_MAIL_NOT_FOUND: '이 메일 기록을 찾지 못했어요. 대화에서 다시 확인해 주세요.',
  CONTACT_GOOGLE_NOT_CONFIGURED: '이 Tada에서는 아직 Google 연결을 준비하지 못했어요. 계정이나 연결 키를 직접 입력할 필요는 없습니다.',
  CONTACT_GOOGLE_CONSENT_REQUIRED: 'Google에서 읽을 항목과 선택한 모델로의 전송 안내를 확인해 주세요.',
  CONTACT_GOOGLE_RELATED_CONSENT_REQUIRED: '관련 메일을 검색하고 보낸 기록을 확인할 범위를 먼저 확인해 주세요.',
  CONTACT_GOOGLE_SEARCH_LIMIT: '이번에는 메일 검색 결과 세 페이지까지 확인했어요. 찾지 못한 자료는 검색 범위를 좁혀 이어서 확인할 수 있어요.',
  CONTACT_GOOGLE_BUSY: 'Google 연결을 이미 확인 중이에요. 브라우저의 권한 화면을 마친 뒤 돌아와 주세요.',
  CONTACT_GOOGLE_BROWSER_FAILED: '이 컴퓨터에서 Google 권한 화면을 열지 못했어요. 브라우저를 확인한 뒤 다시 시도해 주세요.',
  CONTACT_GOOGLE_CONNECT_FAILED: 'Google 연결을 시작하지 못했어요. Tada 설정에서 다시 시도해 주세요.',
  CONTACT_GOOGLE_AUTHORITY_CHANGED: 'Google 연결이나 기기 권한이 바뀌어 확인을 멈췄어요. 현재 연결 상태를 확인해 주세요.',
  CONTACT_GOOGLE_RECONNECT_REQUIRED: 'Google을 다시 연결해야 해요. 설정의 Gmail과 일정 연결에서 다시 연결한 뒤 말씀해 주세요. 대화와 이전 답변은 보존했어요.',
  CONTACT_GOOGLE_SCOPE_DENIED: 'Google에서 필요한 읽기 권한을 허용하지 않았어요. 설정에서 다시 연결해 주세요.',
  CONTACT_GOOGLE_PERMISSION_DENIED: 'Google 계정이나 조직 설정에서 읽기 권한을 허용하지 않았어요. Tada 설정에서 연결 상태와 허용한 권한을 확인해 주세요.',
  CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE: 'Google 정보를 지금 확인하지 못했어요. 잠시 후 새로 말씀해 주세요. 대화는 보존했고 자동으로 다시 실행하지 않았어요.',
  CONTACT_GOOGLE_RESPONSE_INVALID: 'Google에서 받은 정보를 확인할 수 없어 답변을 멈췄어요. 잠시 후 새로 말씀해 주세요. 대화는 보존했고 자동으로 다시 실행하지 않았어요.',
  CONTACT_GOOGLE_RESPONSE_LIMIT: 'Google에서 받은 자료가 너무 커 확인을 마치지 못했어요. 요청 내용을 좁히거나 다른 자료로 이어서 말씀해 주세요. 대화는 보존했고 자동으로 다시 실행하지 않았어요.',
};
async function api(path, data, options = {}) {
  if (data !== undefined) invalidateFollowups();
  let response, body;
  try { response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: options.signal });
    body = await response.json(); }
  catch { throw Error(connectionLost); }
  if (!response.ok) {
    if (response.status === 401 && options.handleAuthentication !== false) paired(false);
    const error = new Error(errors[body.error] ?? '요청을 처리하지 못했습니다. 기존 접수 상태를 확인한 뒤 다시 시도해 주세요.');
    error.authenticationRequired = response.status === 401; error.code = body.error; throw error;
  }
  return body;
}
function paired(yes, stopConnection = true) {
  $('pairing').hidden = yes; $('conversation').hidden = !yes; $('composer').hidden = !yes; $('logout').hidden = !yes; $('settings-open').hidden = !yes; if (!yes && $('settings').open) $('settings').close(); if (!yes) $('followups').hidden = true;
  if (!yes) { clearBackup(); mailGeneration++; if ($('mail-editor').open) $('mail-editor').close(); mailRecord = null; mailDirty = false; for (const name of ['to','cc','bcc','subject','body']) $(`mail-${name}`).value = ''; editorGeneration++; if ($('document-editor').open) $('document-editor').close(); connectionStopped = stopConnection; invalidateFollowups(); recoveryEnabled = false; clearRecoveryTimer(); stateRequest?.abort(); stateRequest = null; $('mobile-token').value = ''; requestGeneration++; $('provider-info').textContent = ''; $('provider-info').hidden = true; $('plan-usage').hidden = true; }
  if (!yes) { channel?.close(); channel = null; $('pair-form').hidden = !code; $('pair-help').textContent = code ? '링크는 한 번만 사용할 수 있습니다. 연결한 기기는 호스트에서 따로 해제할 수 있습니다.' : '컴퓨터에서 Tada를 다시 열면 연결할 수 있어요. 다른 기기에서는 새 연결 링크를 열어 주세요.'; }
}
let backupRequest = null, backupUrl = null, backupCodePending = false;
function canCloseBackup() {
  return !backupCodePending || window.confirm('복구 코드를 따로 보관했나요? 닫으면 이 코드를 다시 표시할 수 없습니다.');
}
function clearBackup() {
  backupRequest?.abort(); backupRequest = null;
  if (backupUrl) URL.revokeObjectURL(backupUrl);
  backupUrl = null; backupCodePending = false; $('backup-code').value = '';
  $('backup-download').removeAttribute('href'); $('backup-result').hidden = true;
  $('backup-create').disabled = false; $('backup-portable').disabled = false;
  $('backup-status').textContent = '';
}
$('backup-code-saved').onclick = () => { backupCodePending = false; $('backup-code-saved').hidden = true; $('backup-create').disabled = false; };
$('records-restore').onclick = async () => {
  $('records-restore').disabled=true;
  try { const result=await api('/api/records/restore',{});if(!/^http:\/\/127\.0\.0\.1:[0-9]+\/#recover=1$/u.test(result.url))throw Error('복원 화면을 열지 못했어요. Tada를 다시 열어 주세요.');location.assign(result.url); }
  catch(error){notice(error.message);}finally{$('records-restore').disabled=false;}
};
$('backup-create').onclick = async () => {
  if (backupRequest || backupCodePending) return;
  clearBackup(); const portable = $('backup-portable').checked === true;
  const abort = new AbortController(); backupRequest = abort;
  $('backup-create').disabled = true; $('backup-portable').disabled = true;
  $('backup-status').textContent = '기록을 암호화하고 있어요…';
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error('백업을 준비하는 데 시간이 걸리고 있어요. 잠시 후 다시 시도해 주세요.')); }, 30000); });
  try {
    const result = await Promise.race([timeout, (async () => {
      const response = await fetch('/api/records/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', signal: abort.signal, body: JSON.stringify({ portable, consent: 'encrypted_record_backup_v1' }) });
      if (!response.ok) {
        const body = await response.json();
        const error = Error(errors[body.error] ?? '백업 파일을 만들지 못했어요. 원래 기록은 그대로 있습니다.');
        error.authenticationRequired = response.status === 401; throw error;
      }
      const code = response.headers.get('X-Tada-Recovery-Code');
      if (portable && !/^TADA1-[A-Za-z0-9_-]{32}$/u.test(code ?? '') || !portable && code !== null) throw Error('복구 정보를 확인하지 못해 파일을 저장하지 않았어요. 다시 시도해 주세요.');
      const blob = await response.blob();
      if (!blob.size || blob.size > 33570900) throw Error('백업 파일을 확인하지 못했어요. 다시 시도해 주세요.');
      return { blob, code };
    })()]);
    if (backupRequest !== abort || abort.signal.aborted) return;
    backupUrl = URL.createObjectURL(result.blob); $('backup-download').href = backupUrl;
    $('backup-download').download = `tada-records-${new Date().toISOString().slice(0,10)}.tadabackup`;
    $('backup-result').hidden = false; $('backup-recovery').hidden = !portable;
    $('backup-code').value = result.code ?? ''; backupCodePending = portable; $('backup-code-saved').hidden = false;
    $('backup-status').textContent = '백업 파일이 준비됐어요. 아래 다운로드를 눌러 저장해 주세요.';
    $('backup-download').focus();
  } catch (error) {
    if (backupRequest !== abort) return;
    if (error.authenticationRequired) { paired(false); notice('기기 연결이 해제되어 백업을 받지 않았어요. 다시 연결해 주세요.'); }
    else $('backup-status').textContent = abort.signal.aborted ? '백업 연결이 끝났어요. 원래 기록은 유지됩니다. 다시 시도해 주세요.' : error.message;
  } finally {
    clearTimeout(timer);
    if (backupRequest === abort) { backupRequest = null; $('backup-create').disabled = backupCodePending; $('backup-portable').disabled = false; }
  }
};
const stateText = { queued: '접수했어요. 앞선 대화에 이어 처리할게요.', running: '확인하고 있어요. 다른 기기로 옮겨도 괜찮아요.',
  cancelled: '이 요청은 취소했어요.', interrupted: 'Tada가 멈춰 답변을 끝내지 못했어요. 요청은 남아 있어요.',
  failed: '이번 요청의 답변을 완료하지 못했어요. 앞선 대화는 보존했어요.' };
function safeWebHref(raw) {
  if (typeof raw !== 'string' || /[\u0000-\u0020\u007f-\u009f]/u.test(raw)) return null;
  try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function renderAnswer(parent, text) {
  // The parser supplies tokens, never executable HTML. Only this allowlist
  // creates elements. Public HTTP(S) links open only on an owner click;
  // images and unsafe/relative URLs remain inert, selectable text.
  const fragment = document.createDocumentFragment();
  try {
    const parser = globalThis.markdownit({ html: false, linkify: false, typographer: false });
    const tags = { paragraph: 'p', blockquote: 'blockquote', list_item: 'li',
      bullet_list: 'ul', ordered_list: 'ol', em: 'em', strong: 'strong', s: 's',
      link: 'span', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td' };
    function appendTokens(tokens, parentNode) {
      const stack = [{ node: parentNode, suffix: '' }];
      for (const token of tokens) {
        if (token.hidden) continue;
        const target = stack.at(-1).node;
        if (token.type === 'inline') { appendTokens(token.children ?? [], target); continue; }
        if (token.nesting === -1) {
          if (stack.length === 1) throw Error('Unbalanced answer structure');
          const ending = stack.pop();
          if (ending.suffix) ending.node.append(document.createTextNode(ending.suffix));
          continue;
        }
        if (token.nesting === 1) {
          const kind = token.type.replace(/_open$/u, '');
          const tag = kind === 'heading' && /^h[1-6]$/u.test(token.tag)
            ? `h${Math.min(6, Number(token.tag.slice(1)) + 2)}` : tags[kind];
          if (!tag) throw Error('Unsupported answer structure');
          const href = kind === 'link' ? safeWebHref(token.attrGet('href')) : null;
          const element = document.createElement(href ? 'a' : tag);
          if (href) { element.setAttribute('href', href); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); }
          if (tag === 'ol') {
            const start = token.attrGet('start');
            if (start !== null && /^\d{1,9}$/u.test(start)) element.setAttribute('start', start);
          }
          if (tag === 'th' || tag === 'td') {
            const alignment = { 'text-align:left': 'left', 'text-align:center': 'center', 'text-align:right': 'right' }[token.attrGet('style')];
            if (alignment) element.className = `align-${alignment}`;
            if (tag === 'th') element.setAttribute('scope', 'col');
          }
          if (tag === 'table') {
            const wrapper = document.createElement('div'); wrapper.className = 'answer-table';
            wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '표 — 넓으면 좌우로 스크롤할 수 있어요'); wrapper.setAttribute('tabindex', '0');
            wrapper.append(element);
            const hint = document.createElement('p'); hint.className = 'table-scroll-hint'; hint.textContent = '표를 좌우로 넘겨 나머지 내용을 볼 수 있어요.'; target.append(hint, wrapper);
          } else target.append(element);
          stack.push({ node: element, suffix: kind === 'link' && !href ? ` (${token.attrGet('href') ?? ''})` : '' });
          continue;
        }
        if (['text', 'html_inline', 'html_block'].includes(token.type)) {
          target.append(document.createTextNode(token.content)); continue;
        }
        if (token.type === 'softbreak') { target.append(document.createTextNode('\n')); continue; }
        if (['code_inline', 'code_block', 'fence'].includes(token.type)) {
          const code = document.createElement('code'); code.textContent = token.content;
          if (token.type === 'code_inline') target.append(code);
          else { const pre = document.createElement('pre'); pre.append(code); target.append(pre); }
          continue;
        }
        if (token.type === 'image') {
          const label = document.createElement('span'); appendTokens(token.children ?? [], label);
          label.append(document.createTextNode(` (${token.attrGet('src') ?? ''})`)); target.append(label); continue;
        }
        if (token.type === 'hardbreak' || token.type === 'hr') {
          target.append(document.createElement(token.type === 'hr' ? 'hr' : 'br')); continue;
        }
        throw Error('Unsupported answer structure');
      }
      if (stack.length !== 1) throw Error('Unbalanced answer structure');
    }
    appendTokens(parser.parse(text, {}), fragment);
    parent.append(fragment);
  } catch {
    // Preserve the whole answer even if the parser is unavailable or fails.
    const paragraph = document.createElement('p'); paragraph.textContent = text; parent.append(paragraph);
  }
}
function render() {
  const list = [...turns.values()].filter(t => !t.answer?.quiet && (t.origin !== 'proactive' || t.state === 'answered')).sort((a, b) => a.seq - b.seq);
  const fingerprint = JSON.stringify(list);
  if (fingerprint === rendered) return;
  const nearEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
  const old = JSON.parse(rendered || '[]');
  if (known && document.hidden && globalThis.Notification?.permission === 'granted'
      && list.some(t => !t.recovery && t.origin !== 'owner_edit' && t.state === 'answered' && !old.some(o => o.seq === t.seq && o.state === 'answered'))) {
    try { new Notification('Tada', { body: '새 답변이 준비됐어요.', tag: 'tada-answer' }); }
    catch { /* Some mobile browsers require a service worker. Keep the answer visible. */ }
  }
  rendered = fingerprint; known = true;
  $('empty').hidden = !!list.length;
  const fragment = document.createDocumentFragment();
  for (const turn of list) {
    const article = document.createElement('article'); article.className = 'turn';
    const user = document.createElement('div'); user.className = ['proactive', 'owner_edit'].includes(turn.origin) ? 'eyebrow' : 'user'; user.textContent = turn.origin === 'owner_edit' ? '직접 수정했어요' : turn.origin === 'proactive' ? (turn.answer?.calendar_reminder ? '일정 알림' : '먼저 챙겨봤어요') : turn.text; article.append(user);
    if (turn.recovery) article.append(element('p', `복원한 기록 · ${new Date(turn.recovery.snapshot_at).toLocaleString('ko-KR')} 당시 상태 · 이전 작업은 다시 실행하지 않아요.`, 'muted'));
    if (turn.answer) {
      if (turn.answer.mail_action_id) {
        const card = document.createElement('div'); card.className = 'document-card';
        const open = document.createElement('button'); open.type = 'button'; open.textContent = '메일 초안·발송 결과 확인';
        open.onclick = () => openMail(turn.answer.mail_action_id); card.append(open); article.append(card);
      }
      if (turn.answer.document) {
        const doc = turn.answer.document, card = document.createElement('div'); card.className = 'document-card';
        const title = document.createElement('strong'); title.textContent = `${doc.title} · 버전 ${doc.revision}`;
        const download = document.createElement('a'); download.textContent = '문서 내려받기';
        download.href = `/api/documents/${doc.id}`; download.setAttribute('download', '');
        const actions = document.createElement('div'); actions.className = 'document-actions'; actions.append(download);
        if (documentEditing) {
          const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '직접 수정';
          edit.onclick = () => openDocumentEditor(doc.id); actions.append(edit);
        }
        card.append(title, actions); article.append(card);
        if (turn.origin === 'owner_edit') { const note = document.createElement('p'); note.className = 'muted'; note.textContent = '직접 수정한 버전 · 참고 자료는 이전 버전에서 이어받은 기록입니다.'; article.append(note); }
      }
      const answer = document.createElement('div'); answer.className = 'answer'; renderAnswer(answer, turn.answer.text); article.append(answer);
      if (turn.answer.notice) { const note = document.createElement('p'); note.className = 'status'; note.textContent = turn.answer.notice; article.append(note); }
      if (turn.answer.sources.length) {
        const details = document.createElement('details'); details.className = 'source-list';
        const summary = document.createElement('summary'); summary.textContent = turn.answer.verification === 'saved_document_sources_checked' ? '저장된 문서의 당시 참고 자료' : '참고한 자료'; details.append(summary);
        if (turn.answer.verification === 'provider_web_report_checked') { const note = document.createElement('p'); note.textContent = '웹 출처는 연결된 AI의 검색 결과입니다. Tada가 각 웹페이지를 별도로 다시 검증한 것은 아닙니다.'; details.append(note); }
        for (const source of turn.answer.sources) {
          const item = document.createElement('div');
          if (source.source === 'ChatGPT public web research') {
            const date = new Date(source.observed_at);
            const time = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date) : '';
            item.textContent = `[${source.id}] 공개 웹 조사${time ? ' · ' + time : ''}`;
            if (Array.isArray(source.citations)) {
              const list = document.createElement('ul');
              for (const citation of source.citations) {
                const href = safeWebHref(citation?.url); if (!href) continue;
                const row = document.createElement('li'), link = document.createElement('a');
                link.textContent = citation.title || href; link.setAttribute('href', href);
                link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
                row.append(link); list.append(row);
              }
              item.append(list);
            }
          } else item.textContent = `[${source.id}] ${source.source}/${source.path}${['saved_document_sources_checked', 'provider_web_report_checked'].includes(turn.answer.verification) ? ' · 당시 확인 시각 ' + source.observed_at : ''}`;
          details.append(item);
        }
        article.append(details);
      }
    } else {
      const status = document.createElement('div'); status.className = 'status'; status.textContent = stateText[turn.state] ?? '상태 확인 중';
      if (turn.error === 'CHATGPT_USAGE_LIMIT') status.textContent = 'Tada에서 사용할 수 있는 ChatGPT 한도에 도달했어요. ChatGPT 설정에서 사용량을 확인한 뒤 다시 말씀해 주세요. 자동 재요청하지 않았어요.';
      if (turn.error === 'CHATGPT_USAGE_UNAVAILABLE') status.textContent = '지금 ChatGPT 사용 가능 여부를 확인하지 못했어요. 연결과 대화는 보존했어요. 잠시 후 다시 말씀해 주세요.';
      if (turn.error === 'CHATGPT_TEMPORARILY_UNAVAILABLE') status.textContent = '지금 ChatGPT 연결 서비스를 사용할 수 없어요. 연결과 대화는 보존했어요. 잠시 후 다시 말씀해 주세요.';
      if (['CHATGPT_PLAN_UNAVAILABLE', 'CHATGPT_PERMISSION_DENIED'].includes(turn.error)) status.textContent = '선택한 ChatGPT 계정이나 워크스페이스 정책에서 이 연결을 허용하지 않아요. 계정 설정을 확인해 주세요. 다른 결제 방식으로 전환하지 않았어요.';
      if (['CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_REFRESH_UNCERTAIN'].includes(turn.error)) status.textContent = 'ChatGPT 연결을 갱신해야 해요. 컴퓨터에서 Tada 연결을 다시 열어 로그인해 주세요. 대화는 보존했어요.';
      if (['failed', 'interrupted'].includes(turn.state) && Object.hasOwn(errors, turn.error)) status.textContent = errors[turn.error];
      if (['failed', 'interrupted'].includes(turn.state) && ['CONTACT_GOOGLE_RECONNECT_REQUIRED', 'CONTACT_GOOGLE_SCOPE_DENIED', 'CONTACT_GOOGLE_PERMISSION_DENIED'].includes(turn.error)) {
        const settings = document.createElement('button'); settings.type = 'button'; settings.textContent = 'Google 연결 설정';
        settings.onclick = () => {
          openSettings('accounts');
          googleStatus.scrollIntoView({ block: 'nearest' }); googleStatus.focus({ preventScroll: true });
        };
        status.append(settings);
      }
      if (!turn.recovery && ['queued', 'running'].includes(turn.state)) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소';
        cancel.onclick = () => api('/api/cancel', { seq: turn.seq }).then(() => refresh()).catch(e => notice(e.message)); status.append(cancel);
      }
      if (!turn.recovery && turn.origin !== 'proactive' && ['failed', 'interrupted'].includes(turn.state)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '이 요청 다시 작성';
        retry.onclick = () => {
          if ($('send').disabled) { notice('접수 확인이 끝나면 다시 작성할 수 있어요. 잠시만 기다려 주세요.'); return; }
          if ($('message').value.trim() && $('message').value.trim() !== turn.text) { notice('작성 중인 이야기를 먼저 보내거나 비워 주세요. 덮어쓰지 않을게요.'); return; }
          if (pending && pending.request_id !== turn.request_id) { notice('방금 보낸 이야기의 접수 여부를 먼저 확인해야 해요. 보내기를 누르면 같은 요청으로 확인할게요.'); return; }
          pending = null; // Confirmed terminal request + explicit rewrite is a new submission.
          $('message').value = turn.text; $('message').focus(); notice('내용을 확인하고 보내 주세요. 아직 다시 실행하지 않았어요.');
        };
        status.append(retry);
      }
      if (turn.recovery) status.textContent = `백업 당시 상태: ${{queued:'접수됨',running:'진행 중',failed:'실패',interrupted:'중단됨',cancelled:'취소됨'}[turn.state] ?? turn.state} · 복원 후 실행하지 않음`;
      article.append(status);
    }
    fragment.append(article);
  }
  $('messages').replaceChildren(fragment);
  if (nearEnd) window.scrollTo(0, document.body.scrollHeight);
}
async function refresh(older = false, quiet = false) {
  if (connectionStopped) return;
  const generation = ++requestGeneration;
  recoveryEnabled = true; clearRecoveryTimer(); stateRequest?.abort();
  const controller = stateRequest = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await api(`/api/state${older && nextBefore ? `?before=${nextBefore}` : ''}`, undefined, { signal: controller.signal, handleAuthentication: false });
    if (generation !== requestGeneration) return;
    $('records-restore').hidden = result.record_restore_available !== true;
    if (documentEditing !== (result.document_editing === true)) { documentEditing = result.document_editing === true; rendered = ''; }
    paired(true);
    if ($('notice').textContent === connectionLost) notice('');
    $('connection').textContent = result.host_stopping ? '잠시 멈추는 중' : '이야기할 준비가 됐어요';
    for (const turn of result.turns) turns.set(turn.seq, turn);
    if (older || nextBefore === null) nextBefore = result.next_before;
    $('older').hidden = nextBefore === null;
    render();
    renderFollowups(result.followups);
    renderAssistance(result);
    void refreshOpenMail();
    $('provider-info').textContent = result.provider ? `${result.provider.provider === 'chatgpt-subscription' ? 'ChatGPT 구독' : '로컬 모델'} · ${result.provider.model}${result.provider.account ? ' · ' + result.provider.account : ''}` : '';
    $('provider-info').hidden = !result.provider;
    $('plan-usage').hidden = !result.provider?.usage_url;
    $('capability-info').textContent = result.provider?.provider === 'chatgpt-subscription'
      ? '창을 닫아도 접수한 요청은 호스트에서 이어집니다. 문서 작성·수정·내려받기·공개 웹 조사·허용된 자료 조사·맡긴 일 기록·일회성 알림을 지원합니다. 웹 조사는 현재 부탁과 최근 말씀, 이번 대화에서 찾아 읽은 이전 말씀을 바탕으로 기존 구독에서 처리하며, 계정의 검색 지원 여부와 사용량 한도가 적용됩니다. Google 계정을 연결하면 현재 대화에서 최근 메일과 다가오는 일정을 읽을 수 있고, 먼저 챙겨보기를 켜면 같은 범위를 자동으로 살펴봅니다. 수시 확인을 켜면 15분마다 변화를 확인하고 일정 시각도 챙깁니다.'
      : '창을 닫아도 접수한 요청은 호스트에서 이어집니다. 문서 작성·수정·내려받기·허용된 자료 조사·맡긴 일 기록·일회성 알림·별도 승인한 로컬 자료 재확인을 지원합니다.';
    if (result.messaging?.suspended) notice('텔레그램 연락이 중지됐어요. 이 화면의 대화와 결과는 유지돼요. 호스트에서 연락 상태를 확인해 주세요.');
    else if (result.messaging?.paired && result.messaging?.enabled === false) notice('이번 호스트 실행에서는 텔레그램 연락이 꺼져 있어요. 이 화면에서 계속 이야기할 수 있어요.');
    const unknown = result.messaging?.deliveries?.unknown ?? 0;
    if (unknown) notice('일부 텔레그램 알림은 전달 여부를 확인하지 못했어요. 중복 발송하지 않았고, 답변은 이 대화에서 확인할 수 있어요.');
    subscribe(); recoveryDelay = 2000; clearRecoveryTimer(); scheduleRecovery(30000);
    return true;
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (error.authenticationRequired) { paired(false); $('connection').textContent = '기기 연결이 필요해요'; if (!quiet) notice(error.message); return false; }
    $('connection').textContent = '다시 연결하는 중'; if (!quiet) notice(error.message);
    scheduleRecovery(recoveryDelay); recoveryDelay = Math.min(30000, recoveryDelay * 2);
  } finally {
    clearTimeout(timeout); if (stateRequest === controller) stateRequest = null;
  }
}
$('pair-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/pair', { code, name: $('device-name').value }); code = null; connectionStopped = false; notice(''); await refresh(); }
  catch (error) { notice(error.message); }
};
$('message-form').onsubmit = async event => {
  event.preventDefault();
  if ($('send').disabled) return;
  const text = $('message').value.trim(); if (!text) return;
  if (!pending || pending.text !== text) pending = { request_id: crypto.randomUUID(), text };
  $('send').disabled = true;
  try {
    await api('/api/turns', pending); pending = null;
    // Admission may finish after the owner has started composing another turn.
    // Clear only the submitted text, never a newer draft.
    if ($('message').value.trim() === text) $('message').value = '';
    notice(''); await refresh();
  }
  catch (error) { notice(`${error.message} 다시 보내기를 누르면 접수 여부부터 확인할게요.`); }
  finally { $('send').disabled = false; }
};
$('older').onclick = () => refresh(true);
$('logout').onclick = async () => { try { await api('/api/logout', {}); turns.clear(); rendered = ''; $('messages').replaceChildren(); paired(false); } catch (error) { notice(error.message); } };
$('notifications').onclick = async () => {
  if (!('Notification' in globalThis)) { notice('이 브라우저는 현재 알림을 지원하지 않습니다. 대화에서 결과를 확인할 수 있어요.'); return; }
  let result;
  try { result = await Notification.requestPermission(); }
  catch { notice('이 브라우저에서는 알림을 켜지 못했어요. 대화의 결과는 그대로 보존됩니다.'); return; }
  notice(result === 'granted' ? '이 페이지가 열려 있는 동안 답변 알림을 보냅니다. 브라우저를 완전히 닫은 뒤의 푸시 알림은 아직 지원하지 않습니다.' : '알림을 켜지 않아도 결과는 대화에 보존됩니다.');
};

let followupOffset = null;
let reviewsAvailable = false;
const workStates = { open: '챙길 일', waiting: '회신·조건 대기', done: '완료로 기록', cancelled: '취소' };
function element(tag, text, className) {
  const item = document.createElement(tag); item.textContent = text;
  if (className) item.className = className;
  return item;
}
const googleSection = document.createElement('section');
googleSection.id = 'google-settings';
googleSection.hidden = true; googleSection.className = 'setting-card';
googleSection.append(element('h2', 'Gmail과 일정 연결'));
const googleConsent = element('p', '최근 메일과 다가오는 일정을 읽고, 필요한 발췌를 선택한 Tada 모델로 전송해요. 먼저 챙겨보기를 따로 켜면 설정한 주기에 맞춰 같은 범위를 자동으로 살펴봅니다.', 'muted');
googleConsent.id = 'google-consent'; googleSection.append(googleConsent);
const googleStatus = element('p', '', 'muted'); googleStatus.id = 'google-status'; googleStatus.setAttribute('role', 'status'); googleStatus.tabIndex = -1; googleSection.append(googleStatus);
const googleConnect = element('button', '내용을 확인하고 Google 연결'); googleConnect.id = 'google-connect'; googleConnect.type = 'button'; googleSection.append(googleConnect);
const googleDisconnect = element('button', 'Google 연결 해제'); googleDisconnect.id = 'google-disconnect'; googleDisconnect.type = 'button'; googleDisconnect.hidden = true; googleSection.append(googleDisconnect);
const googleDetails = document.createElement('details'); googleDetails.id = 'google-scope-details';
googleDetails.append(element('summary', '확인하는 자료와 범위'));
googleDetails.append(element('p', '최근 7일 받은편지함의 보낸 사람·제목·미리보기와 필요한 메일의 짧은 본문, 앞으로 7일 기본 캘린더 일정만 읽어요. 목록은 각각 최대 20개이며, 자료가 많으면 일부만 살펴봅니다.', 'muted'));
const googleReplyScope = element('p', '', 'muted'); googleDetails.append(googleReplyScope);
googleSection.append(googleDetails);
const relatedMail = document.createElement('div'); relatedMail.id = 'related-mail-settings'; relatedMail.hidden = true;
relatedMail.append(element('h3', '관련 메일까지 찾아보기'));
relatedMail.append(element('p', '필요한 주제나 사람으로 이전 메일을 찾고, 같은 메일 대화의 보낸 기록을 함께 확인해요. 받은편지함 밖의 보관·발신 메일도 포함하며, 필요한 발췌는 선택한 Tada 모델로 전송합니다.', 'muted'));
const relatedDetails = document.createElement('details'); relatedDetails.append(element('summary', '추가로 읽는 범위'));
relatedDetails.append(element('p', '검색은 한 번에 20개씩, 대화 한 차례에 최대 세 페이지입니다. 선택한 메일 대화의 최근 20개 제목·보낸 사람·미리보기와 필요한 본문 최대 4 KiB를 읽어요. 먼저 챙겨보기가 켜져 있으면 같은 범위를 활용하며 최근 7일 발신 메일 최대 20개의 변화도 확인합니다. 스팸·휴지통·임시보관·첨부는 읽지 않고 메일을 보내거나 수정하지 않습니다. Google을 다시 연결하면 이 설정도 다시 선택해야 해요.', 'muted'));
relatedMail.append(relatedDetails);
const relatedStatus = element('p', '', 'muted'); relatedStatus.id = 'related-mail-status'; relatedStatus.setAttribute('role', 'status');
const relatedToggle = element('button', '범위를 확인하고 켜기'); relatedToggle.id = 'related-mail-toggle'; relatedToggle.type = 'button';
relatedMail.append(relatedStatus, relatedToggle); googleSection.append(relatedMail);
const mailDisable = element('button', 'Tada에서 메일 발송 끄기'); mailDisable.type = 'button'; mailDisable.hidden = true; googleSection.append(mailDisable);
mailDisable.onclick = async () => {
  if (mailDisableBusy) return; mailDisableBusy = true; renderGoogle(mailGoogle);
  try { await mailRequest('/api/google/disable-mail', {}); await refresh(); }
  catch (error) { notice(error.message); }
  finally { mailDisableBusy = false; renderGoogle(mailGoogle); }
};
$('google-settings-slot').append(googleSection);
let relatedEnabled = false, relatedBusy = false;
relatedToggle.onclick = async () => {
  if (relatedBusy) return;
  relatedBusy = true; relatedToggle.disabled = true;
  try {
    await api('/api/google/related-mail', { enabled: !relatedEnabled, consent: relatedEnabled ? null : 'related_mail_readonly_v1' });
    notice('');
  } catch (error) { notice(error.message); }
  finally { relatedBusy = false; relatedToggle.disabled = false; await refresh(); }
};
function when(value, timezone) {
  if (value === null) return '시간 알림 없음';
  try { return new Intl.DateTimeFormat('ko', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' }).format(new Date(value)) + ` · ${timezone}`; }
  catch { return value; }
}
function workCard(item) {
  const card = element('article', '', 'work-card');
  card.append(element('strong', item.title), element('p', item.details), element('p', workStates[item.state] ?? item.state, 'muted'));
  if (item.waiting_for) card.append(element('p', `기다리는 것: ${item.waiting_for} · 외부 회신을 자동 조회하지는 않습니다.`, 'muted'));
  card.append(element('p', when(item.notify_at, item.timezone), 'muted'));
  if (item.notification_status === 'suspended_device') card.append(element('p', '이 일을 확정한 기기의 접근권이 만료·해제돼 알림은 중지됐어요. 기록은 남아 있어요. 다시 챙기려면 현재 기기에서 변경을 맡겨 주세요.', 'muted'));
  if (item.recovery) card.append(element('p', '복원한 업무 기록 · 알림과 자동 확인은 실행되지 않아요. 다시 맡기려면 새 요청으로 말씀해 주세요.', 'muted'));
  if (!item.recovery && reviewsAvailable && item.id && ['open', 'waiting'].includes(item.state) && item.notify_at) {
    if (!item.review && Date.parse(item.notify_at) > Date.now()) {
      const button = element('button', '이 시각에 직접 확인하고 알려줘'); button.type = 'button';
      button.onclick = async () => {
        const consent = `${item.title}\n${item.details}\n${when(item.notify_at, item.timezone)}\n\n이 업무 버전만 한 번 자동 확인합니다. 현재 허용된 로컬 자료 읽기와 로컬 모델 최대 8회 호출을 사용하며, 기존 전체 사용 한도를 공유합니다. 메일·웹 조회, 파일 수정, 다른 사람에게 연락은 하지 않습니다. 호스트가 실행 중이어야 하고 24시간 넘게 늦으면 실행하지 않습니다. 진행할까요?`;
        if (!window.confirm(consent)) return;
        button.disabled = true;
        try { await api('/api/followups/review', { commitment: item.id, version: item.version, consent: 'one_local_read_only_review' }); notice(''); await refresh(); }
        catch (error) { notice(error.message); button.disabled = false; }
      };
      card.append(button);
    } else if (item.review) {
      const states = { armed: '자동 확인 예약됨', queued: '자동 확인 접수됨', running: '자료를 확인하는 중', answered: '확인 결과가 대화에 있어요', failed: '확인을 마치지 못했어요. 대화에서 확인해 주세요', interrupted: '호스트 중단으로 확인을 마치지 못했어요. 자동 재실행하지 않았어요', cancelled: '자동 확인이 취소됐어요' };
      card.append(element('p', states[item.review.state] ?? item.review.state, 'muted'));
      if (item.review.error === 'CONTACT_REVIEW_MISSED') card.append(element('p', '예약 시각보다 24시간 이상 늦어 자동 실행하지 않았어요.', 'muted'));
      if (['armed', 'queued', 'running'].includes(item.review.state)) {
        const cancel = element('button', '자동 확인 취소'); cancel.type = 'button';
        cancel.onclick = () => api('/api/followups/review/cancel', { commitment: item.id, version: item.version }).then(() => refresh()).catch(e => notice(e.message));
        card.append(cancel);
      }
    }
  }
  return card;
}
let followupSnapshot = null, followupViewGeneration = 0;
function invalidateFollowups() { followupSnapshot = null; followupViewGeneration++; }
function renderFollowups(state) {
  reviewsAvailable = state?.reviews_available === true;
  $('followups').hidden = !state?.available;
  if (!state?.available) { invalidateFollowups(); return; }
  const snapshot = JSON.stringify(state);
  // The host revision includes changes outside this first page and changes
  // after a lost response; heartbeats alone do not invalidate the view.
  if (followupSnapshot === snapshot) return;
  followupSnapshot = snapshot; followupViewGeneration++;
  $('followup-items').replaceChildren(...state.items.map(workCard));
  $('work-count').textContent = state.items.length ? String(state.items.length) : '';
  $('work-empty').hidden = !!state.items.length;
  // Historical pages use the same list API as the model; refresh returns the
  // active first page so stale completed/cancelled data is not mistaken for live.
  followupOffset = 0;
  $('followup-more').hidden = false;
  const proposals = state.proposals.map(p => {
    const card = workCard({ ...p.spec, timezone: p.timezone });
    card.prepend(element('p', '내용·시각 확인 후 확정 · 아직 예약 전', 'eyebrow'));
    card.append(element('p', `이렇게 말씀하셨어요: ${p.spec.user_quote}`, 'muted'));
    for (const [decision, label] of [['approve', '이대로 맡기기'], ['reject', '제안 버리기']]) {
      const button = element('button', label); button.type = 'button';
      button.onclick = async () => {
        button.disabled = true;
        try { await api('/api/followups/decision', { proposal_id: p.id, decision }); notice(''); await refresh(); }
        catch (error) { notice(error.message); button.disabled = false; }
      };
      card.append(button);
    }
    return card;
  });
  $('followup-proposals').replaceChildren(...proposals);
  $('followup-notices').replaceChildren(...state.notices.map(n => {
    const card = element('article', '', 'work-card check-in');
    card.append(element('strong', n.text), element('p', n.details), element('p', when(n.scheduled_at, n.timezone), 'muted'));
    const button = element('button', '확인했어요'); button.type = 'button';
    button.onclick = () => api('/api/followups/seen', { notice_id: n.id }).then(() => refresh()).catch(e => notice(e.message));
    card.append(button); return card;
  }));
}
$('followup-more').onclick = async () => {
  if (connectionStopped || followupOffset === null) return;
  const offset = followupOffset, generation = followupViewGeneration;
  const current = () => !connectionStopped && generation === followupViewGeneration && offset === followupOffset;
  try {
    const result = await api(`/api/followups?offset=${offset}`, undefined, { handleAuthentication: false });
    // A page belongs to the view that requested it. A newer state, mutation or
    // connection must not be overwritten by a delayed page (or its error).
    if (!current()) return;
    if (offset === 0) $('followup-items').replaceChildren();
    for (const item of result.items) $('followup-items').append(workCard(item));
    followupOffset = result.next_offset; $('followup-more').hidden = followupOffset === null;
  } catch (error) {
    if (!current()) return;
    if (error.authenticationRequired) paired(false);
    notice(error.message);
  }
};

for (const [id, text] of [['suggest-plan', '새 프로젝트를 시작할 때 확인할 항목을 체크리스트 문서로 만들어줘.'], ['suggest-remember', '잊지 않게 챙겨줬으면 하는 일이 있어.']]) {
  $(id).onclick = () => { if (!$('message').value.trim()) $('message').value = text; $('message').focus(); };
}
let proactiveEnabled = false; let proactiveMode = 'daily';
function renderGoogle(state) {
  mailGoogle = state; updateMailControls();
  googleSection.hidden = state?.available !== true;
  if (!state?.available) return;
  mailDisable.hidden = state.mail?.enabled !== true && state.mail?.connecting !== true;
  mailDisable.disabled = mailDisableBusy;
  mailDisable.textContent = state.mail?.connecting ? '발송 권한 연결 취소 · 읽기 연결 유지' : 'Tada에서 메일 발송 끄기';
  relatedEnabled = state.related_mail?.enabled === true;
  relatedMail.hidden = !state.has_credential;
  relatedToggle.disabled = relatedBusy || !state.connected || state.pending;
  relatedToggle.textContent = relatedEnabled ? '관련 메일 탐색 끄기' : '범위를 확인하고 켜기';
  relatedToggle.setAttribute('aria-pressed', String(relatedEnabled));
  relatedStatus.textContent = relatedEnabled ? '켜져 있어요. 관련 메일과 보낸 기록을 함께 확인합니다.' : '꺼져 있어요. 최근 7일 받은편지함만 확인합니다.';
  googleReplyScope.textContent = relatedEnabled
    ? '아래의 관련 메일 탐색도 켜져 있어요. 이 읽기 기능은 메일 발송·일정 변경·첨부 다운로드를 하지 않습니다.'
    : '보낸편지함과 전체 대화는 읽지 않아 답장 여부는 확인할 수 없어요. 이 읽기 기능은 메일 발송·일정 변경·첨부 다운로드를 하지 않습니다. Google 권한 화면에서도 읽기 범위를 확인할 수 있어요.';
  googleConnect.disabled = !state.configured || state.pending || state.state === 'upgrade_required';
  googleConnect.textContent = state.connected || state.state === 'reconnect_required' ? 'Google 다시 연결' : '내용을 확인하고 Google 연결';
  googleDisconnect.hidden = !state.has_credential && !state.pending;
  googleDisconnect.textContent = state.has_credential ? state.pending ? '연결 취소 및 Google 연결 해제' : 'Google 연결 해제' : '연결 취소';
  googleStatus.textContent = state.state === 'upgrade_required' ? errors.CONTACT_ASSISTANCE_UPGRADE_REQUIRED
    : !state.configured ? state.has_credential
    ? '이 호스트의 Google 연결 설정이 없어 계정 자료를 읽지 않습니다. 저장된 연결은 아래에서 해제할 수 있어요.'
    : 'Google 연결을 아직 준비하지 않았어요. Tada의 연결 설정이 필요합니다.'
    : state.pending ? 'Google 연결을 준비하고 있어요. 이 컴퓨터에서 Google 권한 화면이 열리면 허용을 마친 뒤 돌아와 주세요.'
    : state.error === 'reconnect_required' || state.state === 'reconnect_required' ? 'Google 연결을 다시 해야 해요. 답변과 저장된 대화는 그대로 남아 있습니다.'
    : state.error === 'permission_denied' ? 'Google 계정이나 조직 정책에서 필요한 읽기 권한을 허용하지 않았어요.'
    : state.error === 'temporarily_unavailable' ? `Google 정보를 확인하지 못했어요.${state.last_checked ? ` 최근 확인 ${new Date(state.last_checked).toLocaleString()}.` : ''} 다시 시도해 주세요.`
    : state.error === 'authorization_denied' ? state.connected ? `${state.account}의 이전 연결은 유지돼요. 새 연결은 완료하지 않았습니다.` : 'Google 연결을 완료하지 않았어요. 원하면 다시 연결할 수 있어요.'
    : state.connected ? `${state.account} 계정이 연결됐어요.${state.last_checked ? ` 최근 확인 ${new Date(state.last_checked).toLocaleString()}.` : ''}`
    : state.last_disconnect?.local_removed ? state.last_disconnect.remote_revoked === null
      ? 'Google 연결을 취소했어요. 원하면 바로 다시 연결할 수 있어요.'
      : state.last_disconnect.remote_revoked === true
      ? 'Google 연결을 해제했고 이 컴퓨터의 자격 증명을 지웠어요.'
      : '이 컴퓨터의 자격 증명은 지웠어요. Google 서버의 연결 해제는 확인하지 못했습니다.'
    : '아직 연결하지 않았어요.';
}
$('delegation-toggle').onclick = async () => {
  if (delegationBusy) return;
  delegationBusy = true; $('delegation-toggle').disabled = true;
  try {
    await api('/api/followup-delegation', { enabled: !delegationEnabled, consent: delegationEnabled ? null : 'personal_followups_v1' });
    notice(''); await refresh();
  } catch (error) { notice(error.message); }
  finally { delegationBusy = false; $('delegation-toggle').disabled = false; }
};
function renderAssistance(result) {
  const delegation = result.followups?.delegation;
  delegationEnabled = delegation?.enabled === true;
  $('delegation-settings').hidden = !delegation?.available;
  $('delegation-toggle').disabled = delegationBusy;
  $('delegation-toggle').textContent = delegationEnabled ? '변경할 때마다 다시 확인하기' : '개인 할 일과 알림 맡기기';
  $('delegation-status').textContent = delegationEnabled ? '부탁하신 할 일과 알림을 바로 처리해요.' : '현재는 저장하기 전에 내용과 시각을 한 번 더 확인해요.';
  const use = result.continuing_use;
  const background = result.background;
  backgroundEnabled = background?.enabled === true;
  $('background-settings').hidden = !background;
  $('background-toggle').disabled = backgroundBusy || !background?.available;
  $('background-toggle').textContent = backgroundEnabled ? '다음 자동 시작 끄기' : '자동 실행 켜기';
  $('background-toggle').setAttribute('aria-pressed', String(backgroundEnabled));
  $('background-environment').textContent = background?.platform === 'win32'
    ? 'Windows 로그인 시 이 비서를 다시 열도록 등록합니다. Windows 설정의 시작 앱에서 Tada를 허용해야 하며, 로그아웃하거나 컴퓨터가 꺼져 있거나 잠들면 멈춰요. 작업 표시줄의 Tada 아이콘에서 대화를 다시 열거나 작업을 멈추고 종료할 수 있어요. 종료해도 대화와 계정은 보존하며, 대기 중인 요청은 다음 실행 때 이어갑니다. 자동 시작을 꺼도 지금 실행 중인 비서는 유지됩니다.'
    : 'Linux 사용자 서비스로 실행합니다. WSL에서는 Windows의 Linux 환경이 시작될 때 함께 켜집니다. 컴퓨터가 꺼져 있거나 잠들면 멈춰요. 자동 시작을 꺼도 지금 실행 중인 비서와 기록은 유지됩니다.';
  $('background-status').textContent = background?.checking ? '자동 실행 환경을 확인하고 있어요.' : !background?.available ? '이 환경의 자동 실행을 확인하지 못했어요. 현재 대화는 계속 사용할 수 있습니다.'
    : background.error ? '자동 실행이 멈췄어요. 다시 켜서 연결할 수 있습니다.'
    : backgroundEnabled && background.platform === 'win32' ? '이 비서는 실행 중이며, 다음 Windows 로그인 때 시작하도록 등록돼 있어요.'
    : backgroundEnabled ? (background.managed && background.running ? '백그라운드에서 실행 중이에요. 다음 시작과 종료 후 복구도 준비됐어요.' : '자동 실행을 켰어요. 접수한 일을 마치면 백그라운드 실행으로 이어집니다.')
    : '다음 자동 시작은 꺼져 있어요. 지금 실행 중인 비서는 계속 사용할 수 있습니다.';
  continuingEnabled = use?.enabled === true;
  $('continuing-settings').hidden = !use?.available;
  $('continuing-toggle').textContent = continuingEnabled ? '지속 사용 끄기' : '지속 사용 켜기';
  $('continuing-toggle').setAttribute('aria-pressed', String(continuingEnabled));
  $('continuing-status').textContent = continuingEnabled
    ? `최근 24시간 기준 ${use.remaining}회 여유가 있어요.${use.resumes_at ? ' 다시 사용 가능: ' + new Date(use.resumes_at).toLocaleString() : ''}`
    : '이전 기록의 일회성 사용 한도가 적용 중이에요. 지속 사용을 켜면 기록을 그대로 이어갑니다.';
  renderGoogle(result.google);
  renderBrowser(result.browser);
  $('proactive-scope').textContent = result.google?.connected
    ? '현재 선택한 모델의 사용량을 씁니다. 연결된 Google 계정은 이 설정을 켠 경우에만 최근 메일과 다가오는 일정을 하루 한 번 살펴봅니다.'
    : '현재 선택한 모델의 사용량을 씁니다. Google 연결만으로 먼저 챙겨보기가 켜지지는 않습니다.';
  const state = result.proactive;
  proactiveEnabled = state?.enabled === true;
  proactiveMode = state?.mode ?? 'daily';
  $('proactive-upgrade').hidden = proactiveMode === 'continuous' || !state?.mode;
  $('proactive-upgrade-info').hidden = proactiveMode === 'continuous' || !state?.mode;
  $('proactive-cadence').textContent = proactiveMode === 'continuous' ? '메일·일정 15분마다 · 시간 일정 30분 전 알림' : '하루 한 번 · 오전 9시~오후 9시';
  $('proactive-budget').textContent = proactiveMode === 'continuous' ? '변화가 있을 때 하루 최대 4번 판단 · 모델 요청 최대 16회' : '현재 모델로 하루 최대 4회 요청';
  $('proactive-last').textContent = state?.last ? new Intl.DateTimeFormat('ko-KR', { timeZone: state.timezone ?? undefined, month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(state.last.created) + ({ queued: ' · 대기', running: ' · 확인 중', failed: ' · 확인 실패', interrupted: ' · 중단', cancelled: ' · 취소', answered: ' · 처리 완료' }[state.last.state] ?? '') : '아직 확인 전';
  $('attention-last-row').hidden = proactiveMode !== 'continuous' || state?.attention?.google_observed !== true;
  $('attention-last').textContent = state?.attention?.observed_at ? new Intl.DateTimeFormat('ko-KR', { timeZone: state.timezone, month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(state.attention.observed_at) + (state.attention.error ? ' · 일부 확인 실패' : ' · 자료 확인 완료') : '아직 확인 전';
  if (proactiveMode === 'continuous') $('proactive-scope').textContent = '최근 7일 받은편지함과 앞으로 7일 기본 캘린더를 각각 최대 20개 살펴봅니다. 새 메일·일정 변화와 날짜가 바뀔 때 필요한 내용을 현재 모델로 판단합니다. 새로운 내용이 없으면 모델을 호출하지 않습니다. 종일 일정은 오전 9시 이후, 시간 일정은 야간에도 30분 전에 알립니다.';
  $('proactive-settings').hidden = !state?.available;
  $('proactive-toggle').setAttribute('aria-pressed', String(proactiveEnabled));
  $('proactive-toggle').textContent = proactiveEnabled ? '먼저 챙겨보기 끄기' : '먼저 챙겨보기 켜기';
  $('proactive-status').textContent = proactiveEnabled
    ? (state.attention?.error ? '최근 자동 확인을 마치지 못했어요. 확인하지 못한 정보는 다음 주기에 다시 살펴봅니다. 현재 확인된 일정의 알림은 계속됩니다.'
      : state.blocked_reason === 'usage_limit' ? (proactiveMode === 'continuous' ? '새 제안을 판단하는 AI 사용은 잠시 멈췄어요. 일정 확인과 시각 알림은 계속됩니다.' : '현재 Tada 사용 한도에 가까워 먼저 챙겨보기를 멈췄어요. 남은 한도는 직접 맡기는 대화에 남겨둡니다.')
      : state.last?.state === 'failed' || state.last?.state === 'interrupted' ? '최근 제안·알림 처리를 끝내지 못했어요. 기록은 보존했어요. 새로운 내용이 생기면 다음 확인 때 다시 챙깁니다.'
      : result.google?.connected ? '켜져 있어요. 메일과 일정을 확인하고, 가까워진 기한과 필요한 일을 먼저 알려드려요.'
      : '켜져 있어요. 맡긴 일과 대화에서 챙길 일을 먼저 찾아요.')
    : '꺼져 있어요. 켜면 말을 걸지 않아도 먼저 살펴봅니다.';
  const mobile = result.mobile;
  $('mobile-settings').hidden = !mobile?.available;
  if (!mobile?.available) return;
  $('mobile-status').textContent = mobile.suspended || mobile.error ? '연결을 다시 확인해야 해요. 저장된 연결로 다시 시도해 주세요.'
    : mobile.paired && mobile.enabled ? (mobile.online ? '연결됐어요. Telegram에서 바로 이야기하세요.' : 'Telegram 연결을 확인하고 있어요. 대화는 그대로 보관됩니다.')
    : mobile.enabled ? '이제 휴대폰에서 링크를 열고 연결을 마쳐 주세요.' : '아직 연결하지 않았어요.';
  $('mobile-reconnect').hidden = !mobile.configured || (mobile.enabled && !mobile.suspended && !mobile.error);
  $('mobile-form').hidden = mobile.enabled && !mobile.suspended && !mobile.error;
  $('mobile-pair').hidden = !mobile.enabled || mobile.paired || mobile.suspended;
  $('mobile-disconnect').hidden = !mobile.configured && !mobile.enabled && !mobile.paired;
  if (mobile.paired || !mobile.enabled) {
    $('mobile-link').hidden = true; $('mobile-copy').hidden = true; $('mobile-link-help').hidden = true;
  }
  $('mobile-candidates').replaceChildren(...(mobile.candidates ?? []).map(candidate => {
    const card = element('div', '', 'mobile-candidate');
    card.append(element('p', `Telegram 사용자 ${candidate.user}의 연결 요청입니다. 본인이 방금 시작을 눌렀을 때만 연결해 주세요.`, 'muted'));
    const approve = element('button', '내 휴대폰이 맞아요'); approve.type = 'button';
    approve.onclick = async () => {
      approve.disabled = true;
      try { await api('/api/mobile/approve', { candidate: candidate.candidate }); notice('휴대폰과 연결됐어요. 같은 비서에게 이야기해 보세요.'); await refresh(); }
      catch (error) { notice(error.message); approve.disabled = false; }
    };
    card.append(approve); return card;
  }));
}
$('google-connect').onclick = async () => {
  googleConnect.disabled = true;
  try { await api('/api/google/connect', { consent: 'google_readonly_v1' }); notice(''); await refresh(); }
  catch (error) { notice(error.message); await refresh(); }
};
$('google-disconnect').onclick = async () => {
  googleDisconnect.disabled = true;
  try {
    const result = await api('/api/google/disconnect', {});
    notice(result.remote_revoked === null ? 'Google 연결을 취소했어요. 원하면 바로 다시 연결할 수 있어요.' : result.remote_revoked === true
      ? 'Google 연결을 해제했고 이 컴퓨터의 자격 증명을 지웠어요. 이전 대화와 답변은 보존됩니다.'
      : '이 컴퓨터의 Google 자격 증명을 지웠어요. Google 서버 연결은 확인하지 못했습니다. 이전 대화와 답변은 보존됩니다.');
    await refresh();
  } catch (error) { notice(error.message); }
  finally { googleDisconnect.disabled = false; }
};
$('continuing-toggle').onclick = async () => {
  const button = $('continuing-toggle'); button.disabled = true;
  try { await api('/api/continuing-use', { enabled: !continuingEnabled, consent: continuingEnabled ? null : 'continuing_conversation_24h_v1' }); await refresh(false, true); }
  catch (error) { notice(error.message); }
  finally { button.disabled = false; }
};
$('background-toggle').onclick = async () => {
  if (backgroundBusy) return;
  backgroundBusy = true;
  const button = $('background-toggle'); button.disabled = true;
  try {
    const result = await api('/api/background', { enabled: !backgroundEnabled, consent: backgroundEnabled ? null : 'same_assistant_background_v1' });
    backgroundEnabled = result.enabled === true;
    notice(result.transferring ? '자동 실행을 켰어요. 접수한 일을 마친 뒤 잠시 다시 연결합니다. 작성 중인 이야기는 그대로 두세요.' : result.enabled ? '다음 로그인 때 이 비서를 열도록 등록했어요. 지금 대화는 계속됩니다.' : '다음 자동 시작을 껐어요. 지금 대화는 계속됩니다.');
    await refresh(false, true);
  } catch (error) { notice(error.message); }
  finally { backgroundBusy = false; button.disabled = false; }
};
$('proactive-upgrade').onclick = async () => {
  const button = $('proactive-upgrade'); button.disabled = true;
  try { await api('/api/proactive', { enabled: true, consent: 'connected_attention_v2' }); notice(''); await refresh(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('proactive-toggle').onclick = async () => {
  const button = $('proactive-toggle'); button.disabled = true;
  try { await api('/api/proactive', { enabled: !proactiveEnabled, consent: proactiveEnabled ? null : proactiveMode === 'continuous' ? 'connected_attention_v2' : 'daily_conversation_suggestions_v1' }); notice(''); await refresh(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('mobile-form').onsubmit = async event => {
  event.preventDefault(); const button = $('mobile-connect'); button.disabled = true;
  const token = $('mobile-token').value.trim(); $('mobile-token').value = '';
  try { await api('/api/mobile/connect', { token, consent: 'private_telegram_contact_v1' }); notice(''); await refresh(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('mobile-reconnect').onclick = async () => {
  const button = $('mobile-reconnect'); button.disabled = true;
  try { await api('/api/mobile/reconnect', {}); notice(''); await refresh(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('mobile-pair').onclick = async () => {
  try {
    const result = await api('/api/mobile/pair', {});
    $('mobile-link').href = result.url; $('mobile-link').hidden = false; $('mobile-copy').hidden = false; $('mobile-link-help').hidden = false;
  } catch (error) { notice(error.message); }
};
$('mobile-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('mobile-link').href); notice('연결 링크를 복사했어요. 본인 휴대폰에서 열어 주세요.'); }
  catch { notice('복사하지 못했어요. 연결 링크를 길게 누르거나 마우스 오른쪽 버튼으로 복사해 주세요.'); }
};
$('mobile-disconnect').onclick = async () => {
  const button = $('mobile-disconnect'); button.disabled = true;
  try { await api('/api/mobile/disconnect', {}); notice('휴대폰 연결을 해제했어요. 대화는 그대로 보관됩니다.'); await refresh(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};

$('message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); $('message-form').requestSubmit();
  }
};
async function openConversation() {
  if (code && autoPair) {
    // A returning browser keeps its existing device and any work authorized by it.
    const restored = await refresh(false, true);
    if (restored === true) { code = null; notice(''); return; }
    if (restored !== false) {
      notice(connectionLost); return;
    }
    try { await api('/api/pair', { code, name: '내 컴퓨터' }); code = null; connectionStopped = false; notice(''); await refresh(); }
    catch (error) { paired(false); notice(error.message); }
  } else if (code) { paired(false, false); $('connection').textContent = '새 기기 연결'; } else await refresh();
}
openConversation();

// The editor is outside the rendered conversation: events never replace drafts.
function editorNotice(text) { $('document-editor-notice').textContent = text; $('document-editor-notice').hidden = !text; }
function editorDirty() { return editorState && ($('document-editor-name').value !== editorState.document.title || $('document-editor-content').value !== editorState.document.content); }
function editorUnsaved() { return editorDirty() || editorState?.pending || editorBackups.length > 0; }
function renderEditorBackups() {
  $('document-draft-backup').hidden = editorBackups.length === 0;
  $('document-draft-backup-content').textContent = editorBackups.join('\n\n────────\n\n');
}
function editorLock(locked) {
  $('document-editor-name').readOnly = locked; $('document-editor-content').readOnly = locked;
  $('document-editor-save').disabled = editorBusy; $('document-editor-discard').disabled = locked; $('document-backup-discard').disabled = locked;
}
function clearEditorDiscard() { editorDiscard = null; $('document-discard-confirm').hidden = true; }
function askEditorDiscard(target) {
  editorDiscard = target;
  $('document-discard-message').textContent = target === 'editor' ? '저장하지 않은 수정과 보관 초안을 버릴까요? 저장된 문서는 그대로 보관됩니다.' : '필요한 내용을 옮겼나요? 보관 초안만 버리고 현재 편집 내용과 저장된 문서는 그대로 둡니다.';
  $('document-discard-confirm').hidden = false; $('document-discard-keep').focus();
}
function closeDiscardedEditor() {
  editorState = null; editorBackups = []; renderEditorBackups(); clearEditorDiscard(); editorGeneration++; $('document-editor').close();
}
function fillDocumentEditor(doc) {
  clearEditorDiscard();
  editorState = { document: doc, pending: null, latest: null };
  $('document-editor-name').value = doc.title; $('document-editor-content').value = doc.content;
  $('document-editor-version').textContent = `버전 ${doc.revision}에서 수정 · 저장하면 새 버전으로 남습니다`;
  $('document-conflict').hidden = true; $('document-editor-save').textContent = '새 버전 저장'; editorLock(false); renderEditorBackups();
}
async function openDocumentEditor(id) {
  if (connectionStopped || !documentEditing) return;
  if (editorState && editorUnsaved()) {
    if (!$('document-editor').open) $('document-editor').showModal();
    if (!editorDirty() && !editorState.pending && editorBackups.length) {
      $('document-draft-backup').open = true;
      editorNotice('이전 편집 초안이 남아 있어요. 필요한 내용을 옮기거나 보관 초안 지우기를 선택해 주세요.');
    } else editorNotice('작성 중인 수정이 있어요. 먼저 저장하거나 수정 취소를 선택해 주세요.'); return;
  }
  const generation = ++editorGeneration;
  try {
    const result = await api(`/api/documents/${id}/edit`);
    if (generation !== editorGeneration || connectionStopped) return;
    fillDocumentEditor(result.document);
    editorNotice(result.document.id !== id ? '이 문서의 최신 버전을 열었어요. 이전 버전도 대화에 보관돼 있어요.' : '');
    if (!$('document-editor').open) $('document-editor').showModal(); $('document-editor-content').focus();
  } catch (error) { if (generation === editorGeneration) notice(error.message); }
}
$('document-editor-close').onclick = () => $('document-editor').close();
$('document-editor-discard').onclick = () => {
  if (editorBusy || editorState?.pending) return;
  if (editorUnsaved()) { askEditorDiscard('editor'); return; }
  closeDiscardedEditor();
};
$('document-use-latest').onclick = () => {
  if (!editorState?.latest || editorBusy || editorState.pending) return;
  if (editorDirty()) editorBackups.push($('document-editor-name').value + '\n\n' + $('document-editor-content').value);
  const latest = editorState.latest; fillDocumentEditor(latest);
  editorNotice('최신 버전에서 이어 쓰세요. 전환하기 전에 작성한 내용도 아래에 남겨뒀어요.');
};
$('document-backup-discard').onclick = () => {
  if (editorBusy || editorState?.pending || !editorBackups.length) return;
  askEditorDiscard('backups');
};
$('document-discard-keep').onclick = clearEditorDiscard;
$('document-discard-confirmed').onclick = () => {
  if (editorBusy || editorState?.pending || !editorDiscard) return;
  if (editorDiscard === 'editor') closeDiscardedEditor();
  else { editorBackups = []; renderEditorBackups(); clearEditorDiscard(); }
};
$('document-editor-form').onsubmit = async event => {
  event.preventDefault(); if (!editorState || editorBusy || connectionStopped) return;
  clearEditorDiscard();
  if (!editorState.pending) {
    const title = $('document-editor-name').value.trim(), content = $('document-editor-content').value;
    if (!title || !content.trim()) { editorNotice('제목과 내용을 입력해 주세요.'); return; }
    if (new TextEncoder().encode(content).length > 4096) { editorNotice('내용이 너무 길어요. 한 문서에는 한글 약 1,300자 분량을 저장할 수 있어요. 내용을 나누거나 줄여 주세요.'); return; }
    editorState.pending = { request_id: crypto.randomUUID(), based_on: editorState.document.id, title, content };
  }
  const state = editorState, generation = editorGeneration; editorBusy = true; editorLock(true);
  try {
    const saved = await api('/api/documents/edit', state.pending);
    if (generation !== editorGeneration || state !== editorState || connectionStopped) return;
    fillDocumentEditor(saved.document); editorNotice('새 버전을 저장했어요. 비서에게 이어서 수정을 맡길 수 있어요.');
    await refresh();
  } catch (error) {
    if (generation !== editorGeneration || state !== editorState || connectionStopped) return;
    if (['CONTACT_DOCUMENT_INVALID', 'CONTACT_DOCUMENT_NOT_FOUND', 'CONTACT_DOCUMENT_STALE', 'CONTACT_DOCUMENT_EDIT_UPGRADE_REQUIRED', 'CONTACT_DEVICE_REVOKED', 'CONTACT_PAIR_REQUIRED', 'CONTACT_REQUEST_ID_REUSED', 'CONTACT_HOST_STOPPING', 'CONTACT_QUEUE_LIMIT'].includes(error.code)) { state.pending = null; editorLock(false); }
    editorNotice(error.message + (state.pending ? ' 저장 확인을 누르면 같은 수정의 저장 여부를 확인합니다.' : ''));
    if (error.code === 'CONTACT_DOCUMENT_STALE') {
      try {
        const result = await api(`/api/documents/${state.document.id}/edit`);
        if (generation !== editorGeneration || state !== editorState || connectionStopped) return;
        state.latest = result.document; $('document-conflict-content').textContent = result.document.title + '\n\n' + result.document.content; $('document-conflict').hidden = false;
      } catch { /* Keep the owner's draft even when the conflict lookup is unavailable. */ }
    }
  } finally {
    editorBusy = false;
    $('document-editor-save').disabled = false;
    $('document-editor-save').textContent = editorState?.pending ? '저장 확인' : '새 버전 저장';
    editorLock(!!editorState?.pending);
  }
};
window.addEventListener('beforeunload', event => { if (editorUnsaved() || mailDirty || backupCodePending) { event.preventDefault(); event.returnValue = ''; } });

function renderBrowser(state) {
  browserView = state;
  $('browser-settings').hidden = !state;
  $('browser-status').textContent = state?.shared ? `${state.shared.for_this_device ? '공유 중' : '다른 기기에서 공유 중'} · ${state.shared.origin}${state.shared.for_this_device ? '' : ' · 이 기기에서 사용하려면 아래에서 탭을 선택해 주세요.'}` : state?.available ? '공유한 탭이 없어요.' : '이 환경에서는 전용 브라우저를 찾지 못했어요.';
  $('browser-stop').hidden = !state?.shared;
  $('browser-sharing').hidden = !state?.shared;
  $('browser-sharing-label').textContent = state?.shared ? `${state.shared.for_this_device ? 'Tada와 공유 중' : '다른 기기에서 공유 중'} · ${state.shared.origin}` : '';
  for (const name of ['browser-open', 'browser-refresh']) $(name).disabled = browserBusy || !state?.available;
  $('browser-stop').disabled = browserBusy; $('browser-sharing-stop').disabled = browserBusy;
  const list = $('browser-actions'); list.replaceChildren();
  for (const action of state?.actions ?? []) {
    if (action.resolved || !['UNCERTAIN', 'ACKNOWLEDGED', 'DISPATCHING'].includes(action.state)) continue;
    const box = element('div', '', 'browser-action');
    box.append(element('p', `${action.field || '입력란'} · 요청한 내용: ${action.requested}`, 'muted'));
    box.append(element('p', `${action.origin} · ${action.recovery ? (action.verdict === 'APPLIED_MISMATCH' ? '백업 당시 입력은 적용됐지만 요청한 값과 달랐어요. 현재 사이트 내용을 확인해 주세요.' : '백업 당시 결과가 미확인 상태입니다. 현재 사이트 내용을 확인해 주세요.') : action.state === 'DISPATCHING' ? '입력 결과를 확인하고 있어요.' : action.verdict === 'APPLIED_MISMATCH' ? '입력은 적용됐지만 요청한 값과 달라요.' : '입력 결과가 불확실해 새 입력을 멈췄어요.'}`));
    if (action.recovery || action.state !== 'DISPATCHING') {
      box.append(element('p', '사이트에서 실제 내용을 먼저 확인해 주세요. 아래 버튼은 이전 결과를 성공으로 바꾸거나 같은 입력을 반복하지 않고, 새로 부탁하는 작업을 허용합니다.', 'muted'));
      const button = element('button', '실제 상태를 확인했어요 · 새 작업 허용'); button.type = 'button'; button.disabled = browserBusy;
      button.onclick = () => browserTask(async () => renderBrowser(await api('/api/browser/resolve', { id: action.id, consent: 'checked_browser_effect_allow_new_work_v1' })));
      box.append(button);
    }
    list.append(box);
  }
}
async function browserTask(action) {
  if (browserBusy) return; browserBusy = true; renderBrowser(browserView);
  try { await action(); notice(''); } catch (error) { notice(error.message); }
  finally { browserBusy = false; renderBrowser(browserView); }
}
$('browser-open').onclick = () => browserTask(async () => { renderBrowser(await api('/api/browser/open', {})); $('browser-tabs').replaceChildren(element('p', '열린 전용 브라우저에서 사이트에 접속한 뒤 “공유할 탭 찾기”를 눌러 주세요.', 'muted')); });
$('browser-refresh').onclick = () => browserTask(async () => {
  const { tabs } = await api('/api/browser/tabs'); const list = $('browser-tabs'); list.replaceChildren();
  if (!tabs.length) list.append(element('p', '전용 브라우저에서 필요한 사이트를 열어 주세요.', 'muted'));
  for (const tab of tabs) {
    const row = element('div', '', 'browser-tab'); row.append(element('strong', tab.title || '제목 없는 탭'), element('p', tab.url, 'muted'));
    const button = element('button', '이 탭 읽기와 입력 허용'); button.type = 'button';
    button.onclick = () => browserTask(async () => { renderBrowser(await api('/api/browser/share', { target: tab.id, url: tab.url, consent: 'shared_browser_text_input_v1' })); list.replaceChildren(); });
    row.append(button); list.append(row);
  }
});
const stopBrowser = () => browserTask(async () => renderBrowser(await api('/api/browser/stop', {})));
$('browser-stop').onclick = stopBrowser; $('browser-sharing-stop').onclick = stopBrowser;

const mailStates = { DRAFT: '초안 · 아직 보내지 않았어요.', DISCARDED: '정리한 초안 · 발송하지 않았어요.', DISPATCHING: '발송을 확인하고 있어요. 다시 보내지 마세요.', ACCEPTED: 'Gmail이 메일을 접수했어요. 받는 사람의 수신 여부는 아직 알 수 없어요.', VERIFIED: '보낸편지함에서 받는 사람과 내용이 일치하는 사본을 확인했어요. 수신·열람 확인은 아닙니다.', UNCERTAIN: '발송 결과를 확인하지 못했어요. 중복 발송을 막기 위해 다시 보내지 않습니다. 보낸편지함에서 결과를 확인해 주세요.', REJECTED: 'Gmail이 발송 요청을 거절했어요. 이 메일은 자동으로 다시 보내지 않습니다.', APPLIED_MISMATCH: '보낸편지함 사본이 승인한 내용과 달라요. Gmail에서 확인해 주세요. 자동 재발송하지 않습니다.' };
function mailError(text = '') { $('mail-error').textContent = text; $('mail-error').hidden = !text; }
function updateMailControls() {
  $('mail-form').hidden = !mailRecord;
  if (!mailRecord) {
    for (const name of ['mail-save', 'mail-discard', 'mail-send', 'mail-reconcile', 'mail-connect']) { $(name).disabled = true; $(name).hidden = true; }
    for (const name of ['mail-send-note', 'mail-permission', 'mail-unsaved', 'mail-reply']) $(name).hidden = true;
    $('mail-reload').disabled = mailBusy || !mailTarget;
    $('mail-status').textContent = mailBusy ? '메일 내용을 불러오고 있어요.' : '최신 상태 확인을 눌러 메일을 다시 불러와 주세요.';
    return;
  }
  if (mailRecord.recovery) {
    for (const name of ['to','cc','bcc','subject','body']) $(`mail-${name}`).readOnly = true;
    for (const name of ['mail-save','mail-discard','mail-send','mail-reconcile','mail-connect','mail-send-note','mail-permission','mail-unsaved']) $(name).hidden = true;
    $('mail-reload').disabled = mailBusy;
    $('mail-status').textContent = `복원한 메일 기록 · 백업 당시 상태: ${mailRecord.state === 'DISPATCHING' ? '발송 요청 중 · 결과 미확인' : mailStates[mailRecord.state]} 복원 후 발송하거나 다시 조회하지 않았어요.`;
    return;
  }
  $('mail-connect').hidden = false;
  const draft = mailRecord.state === 'DRAFT', connected = mailGoogle?.connected === true && mailGoogle?.account === mailRecord.draft.account;
  const enabled = connected && mailGoogle?.mail?.enabled === true;
  for (const name of ['to','cc','bcc','subject','body']) $(`mail-${name}`).readOnly = !draft || mailBusy || name === 'subject' && !!mailRecord.draft.reply;
  $('mail-save').hidden = !draft; $('mail-save').disabled = mailBusy || !mailDirty;
  $('mail-discard').hidden = !draft; $('mail-discard').disabled = mailBusy;
  $('mail-send').hidden = !draft; $('mail-send-note').hidden = !draft;
  $('mail-send').disabled = mailBusy || mailDirty || mailSendUnknown || !enabled || !draft;
  $('mail-unsaved').hidden = !mailDirty;
  $('mail-permission').hidden = !draft || enabled || !connected;
  $('mail-connect').disabled = mailBusy || mailGoogle?.pending === true && mailGoogle?.mail?.connecting !== true;
  $('mail-connect').textContent = mailGoogle?.mail?.connecting ? '발송 권한 연결 취소 · 읽기 연결 유지' : 'Google에서 발송 권한 연결';
  $('mail-reconcile').hidden = !['ACCEPTED','UNCERTAIN'].includes(mailRecord.state);
  $('mail-reconcile').disabled = mailBusy || !connected;
  $('mail-reload').disabled = mailBusy;
  $('mail-status').textContent = mailStates[mailRecord.state] + (draft && !connected ? ' 초안의 Google 계정을 설정에서 다시 연결해 주세요.' : '');
}
function paintMail(record) {
  mailRecord = record; mailDirty = false; mailSendUnknown = false;
  const d = record.draft;
  for (const name of ['to','cc','bcc']) $(`mail-${name}`).value = d[name].join(', ');
  $('mail-subject').value = d.subject; $('mail-body').value = d.body;
  $('mail-account').textContent = `보내는 계정: ${d.account} · 수정 ${record.revision}`;
  $('mail-reply').hidden = !d.reply; updateMailControls();
}
// Bound both response headers and JSON consumption. Aborting a write only stops
// waiting in this window; it never claims that the host canceled the operation.
async function mailRequest(path, data, controller = new AbortController()) {
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(Error(connectionLost));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    else timer = setTimeout(() => controller.abort(), data === undefined ? 15000 : 30000);
  });
  try { return await Promise.race([api(path, data, { signal: controller.signal, handleAuthentication: false }), stopped]); }
  catch (error) { if (error.authenticationRequired && !controller.signal.aborted) paired(false); throw error; }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
}
async function refreshOpenMail() {
  if (!mailRecord || mailBusy || mailDirty || mailSendUnknown || mailRefresh) return;
  const snapshot = mailRecord, generation = mailGeneration, controller = mailRefresh = new AbortController();
  try {
    const { mail } = await mailRequest(`/api/mail/${snapshot.id}`, undefined, controller);
    if (generation === mailGeneration && mailRecord === snapshot && !mailBusy && !mailDirty) paintMail(mail);
  } catch { /* Normal connection recovery owns errors; never replay a send. */ }
  finally { if (mailRefresh === controller) mailRefresh = null; }
}
async function loadMail(id) {
  mailRead?.abort(); mailRefresh?.abort();
  const generation = ++mailGeneration, controller = mailRead = new AbortController();
  mailBusy = true; updateMailControls(); mailError();
  try { const result = await mailRequest(`/api/mail/${id}`, undefined, controller); if (generation === mailGeneration) paintMail(result.mail); }
  catch (error) { if (generation === mailGeneration) mailError(error.message); }
  finally { if (mailRead === controller) mailRead = null; if (generation === mailGeneration) { mailBusy = false; updateMailControls(); } }
}
async function openMail(id) { mailTarget = id; mailRecord = null; mailDirty = false; mailSendUnknown = false; $('mail-editor').showModal(); await loadMail(id); }
function discardMailInput(text, action) {
  mailDiscardAction = action; $('mail-discard-text').textContent = text; $('mail-discard-confirm').hidden = false;
}
function closeMail() {
  if (mailBusy && !mailRead) { mailError('작업을 확인하고 있어요. 잠시 기다려 주세요. 응답이 지연되면 최신 상태를 확인할 수 있습니다.'); return; }
  if (mailDirty) { discardMailInput('저장하지 않은 수정을 버리고 닫을까요? 저장된 초안은 남아 있어요.', () => { mailDirty = false; $('mail-editor').close(); }); return; }
  $('mail-editor').close();
}
$('mail-close').onclick = closeMail;
$('mail-editor').oncancel = event => { event.preventDefault(); closeMail(); };
$('mail-editor').onclose = () => { mailGeneration++; mailRead?.abort(); mailRead = null; mailRefresh?.abort(); mailRefresh = null; mailBusy = false; mailRecord = null; mailTarget = null; mailDirty = false; mailDiscardAction = null; $('mail-discard-confirm').hidden = true; };
$('mail-form').oninput = () => { mailDirty = true; updateMailControls(); };
$('mail-keep').onclick = () => { mailDiscardAction = null; $('mail-discard-confirm').hidden = true; };
$('mail-discard-yes').onclick = () => { const action = mailDiscardAction; mailDiscardAction = null; $('mail-discard-confirm').hidden = true; action?.(); };
$('mail-reload').onclick = () => {
  if (!mailTarget || mailBusy) return;
  if (mailDirty) discardMailInput('저장하지 않은 수정을 버리고 최신 내용을 불러올까요?', () => loadMail(mailTarget));
  else return loadMail(mailTarget);
};
async function changeMail(path, data) {
  if (mailBusy) return;
  const generation = ++mailGeneration; mailRefresh?.abort();
  mailBusy = true; updateMailControls(); mailError();
  try { const result = await mailRequest(path, data); if (generation === mailGeneration) paintMail(result.mail); }
  catch (error) { if (generation !== mailGeneration) return; if (path === '/api/mail/send') mailSendUnknown = true; mailError(error.message + (path === '/api/mail/send' ? ' 응답을 놓쳤을 수 있어요. 최신 상태를 확인하세요. 다시 보내지 마세요.' : '')); }
  finally { if (generation === mailGeneration) { mailBusy = false; updateMailControls(); await refresh(); } }
}
const mailIdentity = () => ({ id: mailRecord.id, revision: mailRecord.revision, sha256: mailRecord.sha256 });
$('mail-form').onsubmit = event => {
  event.preventDefault(); if (!mailRecord || !mailDirty) return;
  const draft = { ...mailRecord.draft, subject: $('mail-subject').value, body: $('mail-body').value };
  for (const name of ['to','cc','bcc']) draft[name] = $(`mail-${name}`).value.trim() ? $(`mail-${name}`).value.split(',').map(s => s.trim()) : [];
  changeMail('/api/mail/edit', { ...mailIdentity(), draft });
};
$('mail-discard').onclick = () => { if (!mailRecord || mailBusy) return; discardMailInput('이 초안을 정리할까요? 발송하지 않고 기록으로 남깁니다.', () => changeMail('/api/mail/discard', mailIdentity())); };
$('mail-send').onclick = () => { if (mailRecord && !mailBusy && !mailDirty) changeMail('/api/mail/send', { ...mailIdentity(), consent: 'send_exact_mail_once_v1' }); };
$('mail-reconcile').onclick = () => { if (mailRecord && !mailBusy) return changeMail('/api/mail/reconcile', { id: mailRecord.id }); };
$('mail-connect').onclick = async () => {
  if (mailBusy) return; const generation = ++mailGeneration; mailRefresh?.abort();
  mailBusy = true; updateMailControls(); mailError();
  try { if (mailGoogle?.mail?.connecting) await mailRequest('/api/google/disable-mail', {});
    else await mailRequest('/api/google/connect', { consent: 'google_read_and_send_v1' }); }
  catch (error) { if (generation === mailGeneration) mailError(error.message); }
  finally { if (generation === mailGeneration) { mailBusy = false; await refresh(); updateMailControls(); } }
};
