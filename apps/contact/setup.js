const $ = id => document.getElementById(id);
const storageKey = 'tada-setup';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
const entryOptions = new URLSearchParams(location.hash.slice(1));
let updateView=entryOptions.get('upgrade')==='1' && entryOptions.get('privacy')!=='1' && entryOptions.get('recover')!=='1';
let privacyView=entryOptions.get('privacy')==='1',eraseSubmitted=null,freshSubmitted=false;
let restoreView = entryOptions.get('recover') === '1', restoreSubmitted = false, sawRestoring = false, restorePreview = null, restoreController = null, restoreGeneration = 0;
let token = entryOptions.get('setup');
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
let current, busy = false, stopped = false, stateEpoch = 0;
const feedback = text => { $('feedback').textContent = text; $('feedback').hidden = !text; };
function checkAuthorization(response){
  if(response.status!==401)return;
  stopped=true;clearRestore();restoreView=false;
  for(const name of ['localStorage','sessionStorage']){try{window[name].removeItem(storageKey);}catch{}}
  const message='이 시작 화면의 연결이 만료됐어요. Tada를 다시 실행하면 저장된 계정으로 이어갈 수 있어요.';
  privacyView=false;updateView=false;eraseSubmitted=null;freshSubmitted=false;
  render({stage:'error',revision:'unauthorized',message,retryable:false});throw Object.assign(Error(message),{rejected:true});
}
async function request(path, body, accepted = () => {}) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  checkAuthorization(response);
  if (!response.ok) {let result;try{result=await response.json();}catch{}throw Object.assign(Error(typeof result?.message==='string'?result.message:'화면 상태가 바뀌었어요. 잠시 후 다시 눌러 주세요.'),{rejected:true});}
  accepted();return response.json();
}
const copy = {
  preparing: ['준비 중', '이어서 열고 있어요.', '저장된 연결과 대화를 확인하고 있어요.'],
  consent: ['반가워요', '머릿속에 있는 일,\n하나씩 맡겨보세요.', '쓰고 있는 ChatGPT 계정을 연결하면 시작할 수 있어요.'],
  login: ['계정 연결', '로그인을 기다리고 있어요.', '새 창에서 ChatGPT에 로그인해 주세요.'],
  model: ['연결됐어요', '이제 이야기해 볼까요?', '계정에서 사용할 수 있는 모델을 가져왔어요.'],
  ready: ['준비됐어요', '대화로 이어갈게요.', '다음부터도 같은 대화에서 만나요.'],
  updating: ['기록 업데이트', '기록을 이어 쓸 준비를 하고 있어요.', '진행 중인 일을 마친 뒤 원본을 백업하고 업데이트합니다.'],
  restoring: ['기록 복원', '선택한 기록을 준비하고 있어요.', '진행 중인 작업을 정리하고 있습니다.'],
  erasing: ['기록 삭제', '기록과 연결을 삭제하고 있어요.', '진행 중인 일을 종료한 뒤 이 Tada의 기록을 지웁니다.'],
  erase_pending: ['기록 삭제', '삭제를 이어가 주세요.', '이전 비서의 실행은 멈춰 있습니다. 남은 삭제를 완료해 주세요.'],
  erased: ['삭제 완료', '이 Tada의 기록을 삭제했어요.', '계정 연결과 예약된 작업도 이 컴퓨터에서 제거했습니다.'],
  error: ['잠깐 멈췄어요', '여기서 다시 이어가세요.', ''],
};
function render(state) {
  if (current?.revision === state.revision) return;
  current = state;
  if(freshSubmitted&&!state.erase_phase){freshSubmitted=false;eraseSubmitted=null;privacyView=false;}
  const [step, title, description] = state.stage === 'error' && state.upgrade === true
    ? ['업데이트 준비', '새 기능을 준비했어요.', ''] : copy[state.stage] ?? copy.error;
  $('step').textContent = step; $('title').textContent = title; $('description').textContent = (state.message ?? description)
    + (state.retry_at ? ` ${new Date(state.retry_at).toLocaleTimeString()}에 자동으로 다시 연결합니다.` : '');
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
  if(state.restore_error&&(!restoreSubmitted||state.restore_request===restoreSubmitted)){if(restoreSubmitted||sawRestoring){restorePreview=null;$('restore-summary').hidden=true;}restoreSubmitted=false;sawRestoring=false;if(!restorePreview)$('restore-feedback').textContent=state.restore_error;}
  if (state.restoring&&(!restoreSubmitted||state.restore_request===restoreSubmitted)) sawRestoring=true;
  if (state.stage==='ready' && (restoreSubmitted&&state.restore_request===restoreSubmitted || sawRestoring)) {restoreView=false;restoreSubmitted=false;sawRestoring=false;clearRestore();}
  const reconnecting=state.restoring && ['consent','login','model'].includes(state.stage);
  $('restore-cancel').hidden=!reconnecting;
  $('cancel-login').hidden=!!state.restoring;
  if(reconnecting){$('step').textContent='기록 복원 · 계정 연결';$('title').textContent='백업의 계정으로 이어가세요.';$('description').textContent=(state.restore_account?state.restore_account+' 계정을 다시 연결해 주세요. ':'')+'로그인을 마치면 보관한 대화와 문서로 이어집니다.';}
  $('restore-abandon').hidden = state.cancel_restore !== true;
  const panel=restoreView && state.restore_available===true && !state.restoring && state.stage!=='restoring';
  $('restore-panel').hidden=!panel;
  $('setup-main').className=panel || state.restoring || state.stage==='restoring' ? 'setup-main setup-recovery' : 'setup-main';
  if(panel){$('step').textContent='내 기록';$('title').textContent='백업에서 이어가기';$('description').textContent='먼저 백업 내용을 확인한 뒤 복원을 선택하세요.';}
  $('restore-open').hidden=state.stage==='updating' || state.restore_available!==true || panel || state.restoring || state.stage==='restoring';
  if(panel && state.stage==='error' && restoreSubmitted && state.restore_request===restoreSubmitted){restoreSubmitted=false;restorePreview=null;$('restore-summary').hidden=true;$('restore-feedback').textContent=state.message ?? '복원을 시작하지 못했어요. 백업 내용을 다시 확인해 주세요.';}
  if(panel) for(const id of ['consent','login','model','ready','error'])$(id).hidden=true;
  if (state.stage === 'ready') { $('continue').href = state.url; if(state.upgrade_available!==true)updateView=false; if(!restoreView&&!privacyView&&!updateView)location.replace(state.url); }

  const updatePanel=updateView && state.stage==='ready' && state.upgrade_available===true;
  $('update-panel').hidden=!updatePanel;
  if(updatePanel){
    for(const id of ['consent','login','model','ready','error','restore-open','privacy-open'])$(id).hidden=true;
    $('step').textContent='기록 업데이트';$('title').textContent='메일 초안도 이어서 보관하세요.';
    $('description').textContent='지금 대화와 메일 읽기는 그대로 사용할 수 있어요. 필요할 때 업데이트하세요.';
    $('setup-main').className='setup-main setup-recovery';
  }
  const deleting=!!state.erase_phase || ['erasing','erase_pending','erased'].includes(state.stage);
  const privacyPanel=privacyView && state.erase_available===true && !deleting;
  $('privacy-panel').hidden=!privacyPanel;$('privacy-progress').hidden=!deleting;
  $('privacy-open').hidden=state.stage==='updating' || updatePanel || state.erase_available!==true || privacyPanel || restoreView || state.restoring || state.stage==='restoring';
  $('privacy-close').hidden=!!eraseSubmitted;
  $('privacy-confirm').disabled=$('privacy-confirmed').checked!==true;
  $('privacy-resume').hidden=state.stage!=='erase_pending' || state.retryable===false || ['done','fresh'].includes(state.erase_phase);
  $('privacy-fresh').hidden=!['done','fresh'].includes(state.erase_phase);
  $('privacy-progress-text').textContent=state.stage==='erased'?'다운로드한 백업과 외부 서비스에 남은 데이터는 삭제하지 않았습니다. 저장 장치의 물리적 복구 불가능성을 보장하는 삭제는 아닙니다.':'';
  if(privacyPanel || deleting){
    for(const id of ['consent','login','model','ready','error','restore-panel','restore-open','restore-cancel'])$(id).hidden=true;
    $('setup-main').className='setup-main setup-recovery';
    if(privacyPanel){$('step').textContent='내 기록';$('title').textContent='기록과 연결 삭제';$('description').textContent=eraseSubmitted?'삭제 요청의 접수 여부를 확인하고 있어요. 연결되면 진행 상태를 표시합니다.':'삭제할 범위를 확인해 주세요.';}
  }


}
async function poll() {
  if (stopped) return;
  const epoch=stateEpoch;
  try { if(!busy){const state=await request('/state');if(epoch===stateEpoch&&!busy){render(state);feedback('');}} }
  catch (error) { if(epoch===stateEpoch&&!busy)feedback(error.message === 'Failed to fetch' ? 'Tada와 연결이 끊겼어요. 앱이 실행 중이면 다시 연결됩니다.' : error.message); }
  if (!stopped) setTimeout(poll, 700);
}
async function act(action, value = null, onFailure = () => {}) {
  if (busy || !current) return;
  busy = true;stateEpoch++;
  const buttons = document.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
  let accepted=false;
  try { await request('/action', { action, value, revision: current.revision },()=>{accepted=true;}); render(await request('/state')); feedback(''); return true; }
  catch (error) { onFailure(error);feedback(error.message==='Failed to fetch'?'요청 결과를 아직 확인하지 못했어요. 연결되면 진행 상태를 다시 확인합니다.':error.message); return accepted||!error.rejected; }
  finally { busy = false; buttons.forEach(button => { button.disabled = false; });$('privacy-confirm').disabled=$('privacy-confirmed').checked!==true; }
}
function clearRestore(){$('restore-preview').disabled=false;restoreGeneration++;restoreController?.abort();restoreController=null;restorePreview=null;$('restore-file').value='';$('restore-code').value='';$('restore-summary').hidden=true;$('restore-feedback').textContent='';}
function rerender(){if(current){const state=current;current=null;render(state);}}
$('restore-open').onclick=()=>{updateView=false;restoreView=true;rerender();};
$('restore-close').onclick=()=>{restoreView=false;clearRestore();rerender();};
$('restore-file').onchange=()=>{$('restore-preview').disabled=false;restoreGeneration++;restoreController?.abort();restorePreview=null;$('restore-summary').hidden=true;};
$('restore-preview').onclick=async()=>{
  const file=$('restore-file').files?.[0];if(!file){$('restore-feedback').textContent='백업 파일을 선택해 주세요.';return;}
  if(file.size>33571432){$('restore-feedback').textContent='이 백업은 현재 열 수 있는 크기를 넘었어요.';return;}
  restoreController?.abort();const controller=restoreController=new AbortController(),generation=++restoreGeneration;
  const timeout=setTimeout(()=>controller.abort(),30000);$('restore-preview').disabled=true;restorePreview=null;$('restore-summary').hidden=true;$('restore-feedback').textContent='암호화한 백업 내용을 확인하고 있어요.';
  try{
    let bytes;try{bytes=await file.arrayBuffer();}catch{throw Error('선택한 파일을 읽지 못했어요. 파일이 있는지 확인하고 다시 선택해 주세요.');}if(controller.signal.aborted)throw Error();
    const code=$('restore-code').value.trim();
    const response=await fetch('/recovery/preview',{method:'POST',cache:'no-store',credentials:'omit',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream',...(code?{'X-Tada-Recovery-Code':code}:{})},body:bytes});
    checkAuthorization(response);const result=await response.json();if(!response.ok)throw Error(result.message || '백업을 확인하지 못했어요.');
    if(generation!==restoreGeneration||controller.signal.aborted)return;
    restorePreview=result.preview;$('restore-code').value='';
    $('restore-description').textContent=`${new Date(restorePreview.created_at).toLocaleString()} 백업 · 대화 ${restorePreview.turns}개 · 문서 ${restorePreview.documents}개 · 지난 업무 ${restorePreview.work}개${restorePreview.account?` · ${restorePreview.account}`:''}`;
    $('restore-registration').hidden=restorePreview.new_registration_required!==true;
    $('restore-registration').textContent='이전 백업에는 ChatGPT 연결 등록 정보가 없어요. 같은 사용자 계정으로 새 연결을 만들며, 로그인 화면에서 선택하는 워크스페이스의 사용량·개인정보 설정으로 이 대화를 이어갑니다. 원래 워크스페이스인지 직접 확인해 주세요.';
    $('restore-confirm').textContent=restorePreview.new_registration_required?'워크스페이스를 새로 연결해 복원':'이 기록으로 복원';
    $('restore-summary').hidden=false;$('restore-feedback').textContent='백업 내용을 확인했어요. 현재 대화는 아직 바꾸지 않았습니다.';
  }catch(error){if(generation===restoreGeneration)$('restore-feedback').textContent=controller.signal.aborted?'확인 시간이 지났어요. 다시 시도해 주세요.':error.message || '백업을 확인하지 못했어요.';}
  finally{clearTimeout(timeout);if(generation===restoreGeneration){$('restore-preview').disabled=false;restoreController=null;}}
};
$('restore-confirm').onclick=async()=>{if(!restorePreview)return;restoreSubmitted=restorePreview.id;if(!await act('restore',{id:restorePreview.id,consent:'restore_records_with_fresh_connections_v1'}))restoreSubmitted=false;};
async function cancelRestore(action){restoreView=false;clearRestore();if(!await act(action)){restoreView=true;rerender();}}
$('restore-abandon').onclick=()=>cancelRestore('cancel_restore');
$('restore-cancel').onclick=()=>cancelRestore('cancel');
$('connect').onclick = () => act('answer', true);
$('model-next').onclick = () => act('answer', $('models').value);
$('models').onchange = () => { $('model-default').textContent = $('models').selectedOptions[0].textContent; };
$('cancel-login').onclick = () => current?.restoring ? cancelRestore('cancel') : act('cancel');
$('retry').onclick = () => act('retry');
$('upgrade').onclick = () => act('upgrade', true);
$('update-confirm').onclick=()=>act('upgrade',true);
$('update-later').onclick=()=>{updateView=false;rerender();};
poll();

$('privacy-open').onclick=()=>{updateView=false;privacyView=true;restoreView=false;clearRestore();rerender();};
$('privacy-close').onclick=()=>{if(eraseSubmitted)return;privacyView=false;$('privacy-confirmed').checked=false;rerender();};
$('privacy-confirmed').onchange=()=>{$('privacy-confirm').disabled=$('privacy-confirmed').checked!==true;};
$('privacy-confirm').onclick=async()=>{
  if($('privacy-confirmed').checked!==true || busy)return;
  eraseSubmitted??=crypto.randomUUID();let failure;
  $('privacy-feedback').hidden=true;
  if(!await act('erase',{id:eraseSubmitted,consent:'erase_local_records_and_connections_v1'},error=>{failure=error.message;})){eraseSubmitted=null;$('privacy-feedback').textContent=failure??'삭제를 시작하지 못했어요.';$('privacy-feedback').hidden=false;}
  rerender();
};
$('privacy-resume').onclick=()=>act('resume_erase');
$('privacy-fresh').onclick=async()=>{freshSubmitted=true;if(!await act('start_fresh',true))freshSubmitted=false;rerender();};
