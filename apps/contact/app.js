// Browser receives visible turns, never private tool context, host secrets or an execution API.
const $ = id => document.getElementById(id);
const link = new URLSearchParams(location.hash.slice(1));
let code = link.get('pair');
const autoPair = link.get('auto') === '1';
if (location.hash) history.replaceState(null, '', location.pathname);
let channel, nextBefore = null, requestGeneration = 0, rendered = '', pending = null, known = false;
let turns = new Map();
const notice = text => { $('notice').textContent = text; $('notice').hidden = !text; };
const errors = {
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
  CONTACT_REQUEST_LIMIT: '설정된 모델 요청 한도에 도달했습니다. 기존 대화와 답변은 그대로 남아 있습니다.',
  CONTACT_QUEUE_LIMIT: '대기 중인 요청이 많습니다. 접수된 일은 그대로 진행합니다.',
  CONTACT_FOLLOWUP_DEVICE_EXPIRES: '알림 시각이 이 기기의 접근권 유효기간을 넘습니다. 연결을 갱신하거나 더 가까운 시각으로 다시 맡겨 주세요.',
  CONTACT_FOLLOWUP_STALE: '다른 기기에서 업무가 먼저 바뀌었습니다. 최신 내용에 맞춰 다시 이야기해 주세요.',
  CONTACT_FOLLOWUP_EXPIRED: '제안의 유효시간이 지났습니다. 현재 의도와 시각을 확인해 새로 맡겨 주세요.',
  CONTACT_FOLLOWUP_TIME_INVALID: '확인 시각이 지났거나 날짜·시간대가 유효하지 않습니다. 새 시각으로 이야기해 주세요.',
  CONTACT_FOLLOWUP_DECISION_CONFLICT: '이미 처리되거나 다른 변경으로 대체된 제안입니다. 최신 업무 기록을 확인해 주세요.',
  CONTACT_GOOGLE_NOT_CONFIGURED: '이 Tada에서는 아직 Google 연결을 준비하지 못했어요. 계정이나 연결 키를 직접 입력할 필요는 없습니다.',
  CONTACT_GOOGLE_CONSENT_REQUIRED: 'Google에서 읽을 항목과 선택한 모델로의 전송 안내를 확인해 주세요.',
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
async function api(path, data) {
  let response;
  try { response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); }
  catch { throw Error('연결이 잠시 끊겼어요. 작성한 내용은 그대로 있어요.'); }
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) paired(false);
    const error = new Error(errors[body.error] ?? '요청을 처리하지 못했습니다. 기존 접수 상태를 확인한 뒤 다시 시도해 주세요.');
    error.authenticationRequired = response.status === 401; throw error;
  }
  return body;
}
function paired(yes) {
  $('pairing').hidden = yes; $('conversation').hidden = !yes; $('composer').hidden = !yes; $('logout').hidden = !yes; $('settings').hidden = !yes; if (!yes) $('followups').hidden = true;
  if (!yes) { $('mobile-token').value = ''; requestGeneration++; $('provider-info').textContent = ''; $('provider-info').hidden = true; $('plan-usage').hidden = true; }
  if (!yes) { channel?.close(); channel = null; $('pair-form').hidden = !code; $('pair-help').textContent = code ? '링크는 한 번만 사용할 수 있습니다. 연결한 기기는 호스트에서 따로 해제할 수 있습니다.' : '컴퓨터에서 Tada를 다시 열면 연결할 수 있어요. 다른 기기에서는 새 연결 링크를 열어 주세요.'; }
}
const stateText = { queued: '접수했어요. 앞선 대화에 이어 처리할게요.', running: '확인하고 있어요. 다른 기기로 옮겨도 괜찮아요.',
  cancelled: '이 요청은 취소했어요.', interrupted: 'Tada가 멈춰 답변을 끝내지 못했어요. 요청은 남아 있어요.',
  failed: '이번 요청의 답변을 완료하지 못했어요. 앞선 대화는 보존했어요.' };
function render() {
  const list = [...turns.values()].filter(t => !t.answer?.quiet && (t.origin !== 'proactive' || t.state === 'answered')).sort((a, b) => a.seq - b.seq);
  const fingerprint = JSON.stringify(list);
  if (fingerprint === rendered) return;
  const nearEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
  const old = JSON.parse(rendered || '[]');
  if (known && document.hidden && globalThis.Notification?.permission === 'granted'
      && list.some(t => t.state === 'answered' && !old.some(o => o.seq === t.seq && o.state === 'answered'))) {
    try { new Notification('Tada', { body: '새 답변이 준비됐어요.', tag: 'tada-answer' }); }
    catch { /* Some mobile browsers require a service worker. Keep the answer visible. */ }
  }
  rendered = fingerprint; known = true;
  $('empty').hidden = !!list.length;
  const fragment = document.createDocumentFragment();
  for (const turn of list) {
    const article = document.createElement('article'); article.className = 'turn';
    const user = document.createElement('div'); user.className = turn.origin === 'proactive' ? 'eyebrow' : 'user'; user.textContent = turn.origin === 'proactive' ? '먼저 챙겨봤어요' : turn.text; article.append(user);
    if (turn.answer) {
      if (turn.answer.document) {
        const doc = turn.answer.document, card = document.createElement('div'); card.className = 'document-card';
        const title = document.createElement('strong'); title.textContent = `${doc.title} · 버전 ${doc.revision}`;
        const download = document.createElement('a'); download.textContent = '문서 내려받기';
        download.href = `/api/documents/${doc.id}`; download.setAttribute('download', '');
        card.append(title, download); article.append(card);
      }
      const answer = document.createElement('div'); answer.className = 'answer'; answer.textContent = turn.answer.text; article.append(answer);
      if (turn.answer.notice) { const note = document.createElement('p'); note.className = 'status'; note.textContent = turn.answer.notice; article.append(note); }
      if (turn.answer.sources.length) {
        const details = document.createElement('details'); details.className = 'source-list';
        const summary = document.createElement('summary'); summary.textContent = turn.answer.verification === 'saved_document_sources_checked' ? '저장된 문서의 당시 참고 자료' : '참고한 자료'; details.append(summary);
        for (const source of turn.answer.sources) { const item = document.createElement('div'); item.textContent = `[${source.id}] ${source.source}/${source.path}${turn.answer.verification === 'saved_document_sources_checked' ? ' · 당시 확인 시각 ' + source.observed_at : ''}`; details.append(item); }
        article.append(details);
      }
    } else {
      const status = document.createElement('div'); status.className = 'status'; status.textContent = stateText[turn.state] ?? '상태 확인 중';
      if (turn.error === 'CHATGPT_USAGE_LIMIT') status.textContent = 'Tada에서 사용할 수 있는 ChatGPT 한도에 도달했어요. ChatGPT 설정에서 사용량을 확인한 뒤 다시 말씀해 주세요. 자동 재요청하지 않았어요.';
      if (turn.error === 'CHATGPT_USAGE_UNAVAILABLE') status.textContent = '지금 ChatGPT 사용 가능 여부를 확인하지 못했어요. 연결과 대화는 보존했어요. 잠시 후 다시 말씀해 주세요.';
      if (turn.error === 'CHATGPT_TEMPORARILY_UNAVAILABLE') status.textContent = '지금 ChatGPT 연결 서비스를 사용할 수 없어요. 연결과 대화는 보존했어요. 잠시 후 다시 말씀해 주세요.';
      if (['CHATGPT_PLAN_UNAVAILABLE', 'CHATGPT_PERMISSION_DENIED'].includes(turn.error)) status.textContent = '선택한 ChatGPT 계정이나 워크스페이스 정책에서 이 연결을 허용하지 않아요. 계정 설정을 확인해 주세요. 다른 결제 방식으로 전환하지 않았어요.';
      if (['CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_REFRESH_UNCERTAIN'].includes(turn.error)) status.textContent = 'ChatGPT 연결을 갱신해야 해요. 컴퓨터에서 Tada 연결을 다시 열어 로그인해 주세요. 대화는 보존했어요.';
      if (['failed', 'interrupted'].includes(turn.state) && turn.error?.startsWith('CONTACT_GOOGLE_') && Object.hasOwn(errors, turn.error)) status.textContent = errors[turn.error];
      if (['failed', 'interrupted'].includes(turn.state) && ['CONTACT_GOOGLE_RECONNECT_REQUIRED', 'CONTACT_GOOGLE_SCOPE_DENIED', 'CONTACT_GOOGLE_PERMISSION_DENIED'].includes(turn.error)) {
        const settings = document.createElement('button'); settings.type = 'button'; settings.textContent = 'Google 연결 설정';
        settings.onclick = () => {
          $('settings').open = true;
          googleStatus.scrollIntoView({ block: 'nearest' }); googleStatus.focus({ preventScroll: true });
        };
        status.append(settings);
      }
      if (['queued', 'running'].includes(turn.state)) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소';
        cancel.onclick = () => api('/api/cancel', { seq: turn.seq }).then(() => refresh()).catch(e => notice(e.message)); status.append(cancel);
      }
      if (turn.origin !== 'proactive' && ['failed', 'interrupted'].includes(turn.state)) {
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
      article.append(status);
    }
    fragment.append(article);
  }
  $('messages').replaceChildren(fragment);
  if (nearEnd) window.scrollTo(0, document.body.scrollHeight);
}
async function refresh(older = false, quiet = false) {
  const generation = ++requestGeneration;
  try {
    const result = await api(`/api/state${older && nextBefore ? `?before=${nextBefore}` : ''}`);
    if (generation !== requestGeneration) return;
    paired(true);
    $('connection').textContent = result.host_stopping ? '잠시 멈추는 중' : '이야기할 준비가 됐어요';
    for (const turn of result.turns) turns.set(turn.seq, turn);
    if (older || nextBefore === null) nextBefore = result.next_before;
    $('older').hidden = nextBefore === null;
    render();
    renderFollowups(result.followups);
    renderAssistance(result);
    $('provider-info').textContent = result.provider ? `${result.provider.provider === 'chatgpt-subscription' ? 'ChatGPT 구독' : '로컬 모델'} · ${result.provider.model}${result.provider.account ? ' · ' + result.provider.account : ''}` : '';
    $('provider-info').hidden = !result.provider;
    $('plan-usage').hidden = !result.provider?.usage_url;
    $('capability-info').textContent = result.provider?.provider === 'chatgpt-subscription'
      ? '창을 닫아도 접수한 요청은 호스트에서 이어집니다. 문서 작성·수정·내려받기·허용된 자료 조사·맡긴 일 기록·일회성 알림을 지원합니다. Google 계정을 연결하면 현재 대화에서 최근 메일과 다가오는 일정을 읽을 수 있고, 먼저 챙겨보기를 별도로 켜면 같은 범위에서 하루 한 번 살펴봅니다. 메일·일정의 예약 재확인은 지원하지 않습니다.'
      : '창을 닫아도 접수한 요청은 호스트에서 이어집니다. 문서 작성·수정·내려받기·허용된 자료 조사·맡긴 일 기록·일회성 알림·별도 승인한 로컬 자료 재확인을 지원합니다.';
    if (result.messaging?.suspended) notice('텔레그램 연락이 중지됐어요. 이 화면의 대화와 결과는 유지돼요. 호스트에서 연락 상태를 확인해 주세요.');
    else if (result.messaging?.paired && result.messaging?.enabled === false) notice('이번 호스트 실행에서는 텔레그램 연락이 꺼져 있어요. 이 화면에서 계속 이야기할 수 있어요.');
    const unknown = result.messaging?.deliveries?.unknown ?? 0;
    if (unknown) notice('일부 텔레그램 알림은 전달 여부를 확인하지 못했어요. 중복 발송하지 않았고, 답변은 이 대화에서 확인할 수 있어요.');
    if (!channel) {
      channel = new EventSource('/api/events');
      channel.addEventListener('changed', () => refresh());
      channel.onerror = () => { $('connection').textContent = '재연결 중 · 접수한 요청은 유지됩니다'; };
    }
    return true;
  } catch (error) { $('connection').textContent = '다시 연결하는 중'; if (!quiet) notice(error.message); return error.authenticationRequired ? false : undefined; }
}
$('pair-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/pair', { code, name: $('device-name').value }); code = null; notice(''); await refresh(); }
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
const workStates = { open: '챙길 일', waiting: '회신·조건 대기', done: '사용자 확인 완료', cancelled: '취소' };
function element(tag, text, className) {
  const item = document.createElement(tag); item.textContent = text;
  if (className) item.className = className;
  return item;
}
const googleSection = document.createElement('section');
googleSection.id = 'google-settings';
googleSection.hidden = true;
googleSection.append(element('h2', 'Gmail과 일정 연결'));
const googleConsent = element('p', '최근 메일과 다가오는 일정을 읽고, 필요한 발췌를 선택한 Tada 모델로 전송해요. 먼저 챙겨보기를 따로 켜면 같은 범위에서 하루 한 번 살펴봅니다.', 'muted');
googleConsent.id = 'google-consent'; googleSection.append(googleConsent);
const googleStatus = element('p', '', 'muted'); googleStatus.id = 'google-status'; googleStatus.setAttribute('role', 'status'); googleStatus.tabIndex = -1; googleSection.append(googleStatus);
const googleConnect = element('button', '내용을 확인하고 Google 연결'); googleConnect.id = 'google-connect'; googleConnect.type = 'button'; googleSection.append(googleConnect);
const googleDisconnect = element('button', 'Google 연결 해제'); googleDisconnect.id = 'google-disconnect'; googleDisconnect.type = 'button'; googleDisconnect.hidden = true; googleSection.append(googleDisconnect);
const googleDetails = document.createElement('details'); googleDetails.id = 'google-scope-details';
googleDetails.append(element('summary', '확인하는 자료와 범위'));
googleDetails.append(element('p', '최근 7일 받은편지함의 보낸 사람·제목·미리보기와 필요한 메일의 짧은 본문, 앞으로 7일 기본 캘린더 일정만 읽어요. 목록은 각각 최대 20개이며, 자료가 많으면 일부만 살펴봅니다.', 'muted'));
googleDetails.append(element('p', '보낸편지함과 전체 대화는 읽지 않아 답장 여부는 확인할 수 없어요. 메일 발송·일정 변경·첨부 다운로드는 하지 않습니다. Google 권한 화면에서도 읽기 범위를 확인할 수 있어요.', 'muted'));
googleSection.append(googleDetails);
$('proactive-settings').before(googleSection);
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
  if (reviewsAvailable && item.id && ['open', 'waiting'].includes(item.state) && item.notify_at) {
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
function renderFollowups(state) {
  reviewsAvailable = state?.reviews_available === true;
  $('followups').hidden = !state?.available;
  if (!state?.available) return;
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
  if (followupOffset === null) return;
  try {
    const result = await api(`/api/followups?offset=${followupOffset}`);
    if (followupOffset === 0) $('followup-items').replaceChildren();
    for (const item of result.items) $('followup-items').append(workCard(item));
    followupOffset = result.next_offset; $('followup-more').hidden = followupOffset === null;
  } catch (error) { notice(error.message); }
};

for (const [id, text] of [['suggest-plan', '새 프로젝트를 시작할 때 확인할 항목을 체크리스트 문서로 만들어줘.'], ['suggest-remember', '잊지 않게 챙겨줬으면 하는 일이 있어.']]) {
  $(id).onclick = () => { if (!$('message').value.trim()) $('message').value = text; $('message').focus(); };
}
let proactiveEnabled = false;
function renderGoogle(state) {
  googleSection.hidden = state?.available !== true;
  if (!state?.available) return;
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
function renderAssistance(result) {
  renderGoogle(result.google);
  const proactiveCopy = $('proactive-settings').querySelectorAll('p.muted');
  proactiveCopy[1].textContent = result.google?.connected
    ? '현재 선택한 모델의 사용량을 씁니다. 연결된 Google 계정은 이 설정을 켠 경우에만 최근 메일과 다가오는 일정을 하루 한 번 살펴봅니다.'
    : '현재 선택한 모델의 사용량을 씁니다. Google 연결만으로 먼저 챙겨보기가 켜지지는 않습니다.';
  const state = result.proactive;
  proactiveEnabled = state?.enabled === true;
  $('proactive-settings').hidden = !state?.available;
  $('proactive-toggle').textContent = proactiveEnabled ? '먼저 챙겨보기 끄기' : '먼저 챙겨보기 켜기';
  $('proactive-status').textContent = proactiveEnabled
    ? (state.blocked_reason === 'usage_limit' ? '현재 Tada 사용 한도에 가까워 먼저 챙겨보기를 멈췄어요. 남은 한도는 직접 맡기는 대화에 남겨둡니다.'
      : state.last?.state === 'failed' || state.last?.state === 'interrupted' ? '최근 확인을 끝내지 못했어요. 기록은 남아 있고 자동으로 재시도하지 않아요.'
      : result.google?.connected ? '켜져 있어요. 최근 메일과 다가오는 일정도 하루 한 번 확인하며, 새 제안이 없으면 조용히 기다려요.'
      : '켜져 있어요. 도움이 될 새 내용이 없으면 조용히 기다려요.')
    : '꺼져 있어요. 켜면 같은 비서가 먼저 챙겨봅니다.';
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
$('proactive-toggle').onclick = async () => {
  const button = $('proactive-toggle'); button.disabled = true;
  try { await api('/api/proactive', { enabled: !proactiveEnabled, consent: proactiveEnabled ? null : 'daily_conversation_suggestions_v1' }); notice(''); await refresh(); }
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
      notice('연결이 잠시 끊겼어요. 기존 기기로 다시 연결하고 있어요.');
      setTimeout(openConversation, 2000); return;
    }
    try { await api('/api/pair', { code, name: '내 컴퓨터' }); code = null; notice(''); await refresh(); }
    catch (error) { paired(false); notice(error.message); }
  } else if (code) { paired(false); $('connection').textContent = '새 기기 연결'; } else await refresh();
}
openConversation();
