const $ = id => document.getElementById(id);
const storageKey = 'tada-setup';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
let token = new URLSearchParams(location.hash.slice(1)).get('setup');
history.replaceState(null, '', location.pathname);
// Keep access to this still-running local server across desktop/browser restarts.
// A server restart invalidates the token; no provider credentials are stored here.
for (const name of ['localStorage', 'sessionStorage']) {
  try { if (!validToken(token)) token = window[name].getItem(storageKey); } catch { /* storage can be unavailable */ }
}
if (!validToken(token)) token = null;
for (const name of ['localStorage', 'sessionStorage']) {
  try { if (token) window[name].setItem(storageKey, token); } catch { /* memory-only startup remains usable */ }
}
window.addEventListener('hashchange', () => {
  if (validToken(new URLSearchParams(location.hash.slice(1)).get('setup'))) location.reload();
});
let current, busy = false, stopped = false;
const feedback = text => { $('feedback').textContent = text; $('feedback').hidden = !text; };
async function request(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 401) {
    stopped = true;
    for (const name of ['localStorage', 'sessionStorage']) { try { window[name].removeItem(storageKey); } catch { /* unavailable storage */ } }
    const message = '이 시작 화면의 연결이 만료됐어요. Tada를 다시 실행하면 저장된 계정으로 이어갈 수 있어요.';
    render({ stage: 'error', revision: 'unauthorized', message, retryable: false });
    throw Error(message);
  }
  if (!response.ok) throw Error('화면 상태가 바뀌었어요. 잠시 후 다시 눌러 주세요.');
  return response.json();
}
const copy = {
  preparing: ['준비 중', '이어서 열고 있어요.', '저장된 연결과 대화를 확인하고 있어요.'],
  consent: ['반가워요', '머릿속에 있는 일,\n하나씩 맡겨보세요.', '쓰고 있는 ChatGPT 계정을 연결하면 시작할 수 있어요.'],
  login: ['계정 연결', '로그인을 기다리고 있어요.', '새 창에서 ChatGPT에 로그인해 주세요.'],
  model: ['연결됐어요', '이제 이야기해 볼까요?', '계정에서 사용할 수 있는 모델을 가져왔어요.'],
  ready: ['준비됐어요', '대화로 이어갈게요.', '다음부터도 같은 대화에서 만나요.'],
  error: ['잠깐 멈췄어요', '여기서 다시 이어가세요.', ''],
};
function render(state) {
  if (current?.revision === state.revision) return;
  current = state;
  const [step, title, description] = copy[state.stage] ?? copy.error;
  $('step').textContent = step; $('title').textContent = title; $('description').textContent = state.message ?? description;
  for (const id of ['consent', 'login', 'model', 'ready', 'error']) $(id).hidden = id !== state.stage;
  $('retry').hidden = state.retryable === false;
  $('upgrade').hidden = state.upgrade !== true;
  $('retry').textContent = state.reauthorize ? 'ChatGPT 다시 연결하기' : '다시 열기';
  if (state.stage === 'login') $('login-link').href = state.url;
  if (state.stage === 'model') {
    $('models').replaceChildren(...state.models.map((model, i) => {
      const option = document.createElement('option'); option.value = String(i + 1); option.textContent = model.name; return option;
    }));
    $('model-default').textContent = state.models[0]?.name ?? '';
  }
  if (state.stage === 'ready') { $('continue').href = state.url; location.replace(state.url); }
}
async function poll() {
  if (stopped) return;
  try { render(await request('/state')); feedback(''); }
  catch (error) { feedback(error.message === 'Failed to fetch' ? 'Tada와 연결이 끊겼어요. 앱이 실행 중이면 다시 연결됩니다.' : error.message); }
  if (!stopped) setTimeout(poll, 700);
}
async function act(action, value = null) {
  if (busy || !current) return;
  busy = true;
  const buttons = document.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
  try { await request('/action', { action, value, revision: current.revision }); render(await request('/state')); feedback(''); }
  catch (error) { feedback(error.message); }
  finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
}
$('connect').onclick = () => act('answer', true);
$('model-next').onclick = () => act('answer', $('models').value);
$('models').onchange = () => { $('model-default').textContent = $('models').selectedOptions[0].textContent; };
$('cancel-login').onclick = () => act('cancel');
$('retry').onclick = () => act('retry');
$('upgrade').onclick = () => act('upgrade', true);
poll();
