// Execute the actual browser client for async form behavior. This small DOM/HTTP
// fixture is not a substitute for the separate real Chromium rendering checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../apps/contact/app.js', import.meta.url), 'utf8');
const parserSource = readFileSync(new URL('../../../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', import.meta.url), 'utf8');
function client({ parser = true } = {}) {
  const elements = new Map();
  let focused = null, offline = false;
  class Element {
    value = ''; hidden = false; disabled = false; textContent = ''; children = []; className = ''; parentNode = null; attributes = new Map(); scrolls = [];
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) {
      if (elements.get(this.id) === this) elements.delete(this.id);
      this.attributes.set('id', String(value)); elements.set(String(value), this);
    }
    setAttribute(name, value) { if (name === 'id') this.id = value; else this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    focus() { focused = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.onclose?.(); }
    scrollIntoView(options) { this.scrolls.push(options); }
    insert(index, items) {
      for (const item of items) {
        if (item.parentNode) item.parentNode.children.splice(item.parentNode.children.indexOf(item), 1);
        item.parentNode = this;
      }
      this.children.splice(index, 0, ...items);
    }
    append(...items) { this.insert(this.children.length, items); }
    prepend(...items) { this.insert(0, items); }
    before(...items) { this.parentNode?.insert(this.parentNode.children.indexOf(this), items); }
    replaceChildren(...items) { for (const item of this.children) item.parentNode = null; this.children = []; this.append(...items); }
    querySelectorAll(selector) {
      const match = /^([a-z][a-z0-9]*)(?:\.([a-z-]+))?$/u.exec(selector); assert.ok(match, 'fixture supports tag/class selectors');
      const found = [];
      const visit = node => { for (const item of node.children) {
        if (item.tagName === match[1].toUpperCase() && (!match[2] || item.className.split(/\s+/u).includes(match[2]))) found.push(item);
        visit(item);
      } };
      visit(this); return found;
    }
  }
  const body = new Element('body'); body.scrollHeight = 100;
  const get = id => { if (!elements.has(id)) { const item = new Element(); item.id = id; body.append(item); } return elements.get(id); };
  const calls = [], pending = [], handlers = new Map();
  const state = { assistant: 'fixture', device: 'fixture-device', turns: [], next_before: null,
    usage: {}, messaging: {}, followups: { available: false }, host_stopping: false };
  const context = {
    URLSearchParams, atob, crypto: { randomUUID },
    location: { hash: '#pair=fixture', pathname: '/' }, history: { replaceState() {} },
    document: { getElementById: get, hidden: false, body,
      createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }), createDocumentFragment: () => new Element() },
    window: { innerHeight: 800, scrollY: 0, scrollTo() {} },
    EventSource: class { addEventListener() {} close() {} },
    fetch: (path, options) => {
      if (offline) return Promise.reject(Error('fixture network loss'));
      calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
      if (path === '/api/turns') return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
      if (handlers.has(path)) return Promise.resolve({ ok: true, status: 200, json: async () => handlers.get(path)() });
      assert.equal(path, '/api/state');
      return Promise.resolve({ ok: true, status: 200, json: async () => state });
    },
  };
  vm.createContext(context);
  if (parser) vm.runInContext(parserSource, context, { filename: 'actual-markdown.js' });
  vm.runInContext(source, context, { filename: 'actual-contact-app.js' });
  return { get, calls, pending, state, setOffline: value => { offline = value; }, get focused() { return focused; }, handle: (path, callback) => handlers.set(path, callback), refresh: () => vm.runInContext('refresh()', context), submit: () => get('message-form').onsubmit({ preventDefault() {} }),
    accept: () => pending.shift().resolve({ ok: true, status: 202, json: async () => ({ seq: 1 }) }),
    reject: () => pending.shift().reject(Error('fixture network loss')) };
}

test('an accepted message does not erase the next draft typed while its request was in flight', async () => {
  const c = client(); c.get('message').value = 'First instruction';
  const sending = c.submit(); assert.equal(c.get('send').disabled, true);
  c.get('message').value = 'The next instruction I am still writing';
  c.accept(); await sending;
  assert.equal(c.get('message').value, 'The next instruction I am still writing');
  assert.equal(c.get('send').disabled, false);
});

test('Google settings use the inserted controls and render configuration, account and pending states without connecting automatically', async () => {
  const c = client(), section = c.get('google-settings');
  assert.equal(section.parentNode, c.get('google-settings-slot'));
  assert.equal(c.get('google-status').getAttribute('role'), 'status');
  assert.ok(section.children.includes(c.get('google-connect')));
  const consent = c.get('google-consent'), details = c.get('google-scope-details');
  assert.ok(section.children.indexOf(consent) < section.children.indexOf(c.get('google-connect')));
  assert.match(consent.textContent, /선택한 Tada 모델로 전송/u); assert.match(consent.textContent, /따로 켜면.*설정한 주기.*같은 범위/u);
  assert.equal(details.tagName, 'DETAILS'); assert.equal(details.children[0].tagName, 'SUMMARY');
  assert.equal(details.children[0].textContent, '확인하는 자료와 범위');
  assert.ok(section.children.indexOf(details) > section.children.indexOf(c.get('google-connect')));
  c.state.google = { available: true, configured: false, connected: false, pending: false, has_credential: false };
  await c.refresh();
  assert.equal(section.hidden, false); assert.equal(c.get('google-connect').disabled, true);
  assert.equal(c.get('google-disconnect').hidden, true); assert.match(c.get('google-status').textContent, /연결 설정/u);
  c.state.google = { available: true, configured: true, connected: true, pending: false, has_credential: true, account: 'owner@example.test' };
  await c.refresh();
  assert.equal(c.get('google-connect').disabled, false); assert.equal(c.get('google-connect').textContent, 'Google 다시 연결');
  assert.equal(c.get('google-disconnect').hidden, false); assert.match(c.get('google-status').textContent, /owner@example\.test/u);
  c.state.google.pending = true; await c.refresh();
  assert.equal(c.get('google-connect').disabled, true); assert.match(c.get('google-status').textContent, /Google 권한 화면/u);
  assert.doesNotMatch(c.get('google-status').textContent, /열었어요/u);
  assert.equal(c.get('google-disconnect').textContent, '연결 취소 및 Google 연결 해제');
  assert.ok(c.calls.every(call => call.path === '/api/state'));
});

test('Google settings require journal update before OAuth and use the existing on-screen backup recovery guidance', async () => {
  const c = client(); c.get('message').value = '작성 중인 다음 요청';
  c.state.google = { available: true, configured: true, state: 'upgrade_required', connected: false, pending: false, has_credential: false };
  await c.refresh();
  assert.equal(c.get('google-settings').hidden, false); assert.equal(c.get('google-connect').disabled, true);
  assert.equal(c.get('google-disconnect').hidden, true);
  assert.match(c.get('google-status').textContent, /Tada를 다시 열어 기록 업데이트.*원본은 먼저 백업/u);
  assert.doesNotMatch(c.get('google-status').textContent, /CONTACT_|다시 시도/u);
  assert.equal(c.get('message').value, '작성 중인 다음 요청'); assert.ok(c.calls.every(call => call.path === '/api/state'));
  c.state.google.state = 'disconnected'; await c.refresh();
  assert.equal(c.get('google-connect').disabled, false);
});

for (const reconnect of [false, true]) test(`profile permission denial uses existing policy guidance ${reconnect ? 'while retaining the prior account' : 'without claiming a connected account'}`, async () => {
  const c = client(); c.state.google = { available: true, configured: true, connected: reconnect, pending: false,
    has_credential: reconnect, state: reconnect ? 'connected' : 'disconnected', account: reconnect ? 'owner@example.test' : null, error: 'permission_denied' };
  await c.refresh();
  assert.match(c.get('google-status').textContent, /Google 계정이나 조직 정책.*읽기 권한을 허용하지/u);
  assert.doesNotMatch(c.get('google-status').textContent, /다시 시도|CONTACT_|연결됐어요/u);
  assert.equal(c.get('google-connect').disabled, false); assert.equal(c.get('google-disconnect').hidden, !reconnect);
  assert.ok(c.calls.every(call => call.path === '/api/state'));
});

test('a first Google OAuth attempt can be canceled and retried on screen without claiming removed credentials', async () => {
  const c = client();
  c.state.google = { available: true, configured: true, connected: false, pending: false, has_credential: false };
  c.handle('/api/google/connect', () => { c.state.google.pending = true; return { state: 'waiting' }; });
  c.handle('/api/google/disconnect', () => {
    const result = { local_removed: true, remote_revoked: null };
    c.state.google.pending = false; c.state.google.last_disconnect = result; return result;
  });
  await c.refresh(); await c.get('google-connect').onclick();
  assert.equal(c.get('google-connect').disabled, true);
  assert.equal(c.get('google-disconnect').hidden, false); assert.equal(c.get('google-disconnect').textContent, '연결 취소');
  await c.get('google-disconnect').onclick();
  assert.equal(c.get('google-disconnect').hidden, true); assert.equal(c.get('google-connect').disabled, false);
  assert.match(c.get('notice').textContent, /Google 연결을 취소했어요/u);
  assert.doesNotMatch(c.get('notice').textContent, /자격 증명/u);
  assert.match(c.get('google-status').textContent, /Google 연결을 취소했어요/u);
  await c.get('google-connect').onclick();
  assert.equal(c.calls.filter(item => item.path === '/api/google/connect').length, 2);
  assert.equal(c.get('google-disconnect').hidden, false);
});

test('canceling reconnection reports the existing credential removal accurately', async () => {
  const c = client();
  c.state.google = { available: true, configured: true, connected: true, pending: true, has_credential: true, account: 'owner@example.test' };
  c.handle('/api/google/disconnect', () => {
    const result = { local_removed: true, remote_revoked: true };
    Object.assign(c.state.google, { connected: false, pending: false, has_credential: false, last_disconnect: result }); return result;
  });
  await c.refresh(); assert.equal(c.get('google-disconnect').textContent, '연결 취소 및 Google 연결 해제');
  await c.get('google-disconnect').onclick();
  assert.match(c.get('notice').textContent, /자격 증명을 지웠어요/u);
  assert.match(c.get('google-status').textContent, /자격 증명을 지웠어요/u);
});

for (const error of ['CONTACT_GOOGLE_RECONNECT_REQUIRED', 'CONTACT_GOOGLE_SCOPE_DENIED', 'CONTACT_GOOGLE_PERMISSION_DENIED']) test(`a failed Google turn offers actionable settings recovery without resubmitting: ${error}`, async () => {
  const c = client();
  const reconnect = error !== 'CONTACT_GOOGLE_PERMISSION_DENIED';
  c.state.google = { available: true, configured: true, connected: !reconnect, pending: false, has_credential: true,
    state: reconnect ? 'reconnect_required' : 'connected', error: error === 'CONTACT_GOOGLE_RECONNECT_REQUIRED' ? 'reconnect_required' : 'permission_denied' };
  c.state.turns = [{ seq: 1, request_id: randomUUID(), text: '최근 메일을 확인해줘.', state: 'failed', error }];
  c.get('message').value = '작성 중인 새 이야기'; await c.refresh();
  const status = c.get('messages').children[0].children[0].children[1];
  assert.match(status.textContent, /Google/u); assert.match(status.textContent, /설정/u);
  assert.doesNotMatch(status.textContent, /CONTACT_|이번 요청의 답변을 완료하지 못했어요/u);
  const action = status.children.find(button => button.textContent === 'Google 연결 설정'); assert.ok(action);
  assert.notEqual(c.get('settings').open, true); action.onclick();
  assert.equal(c.get('settings').open, true); assert.equal(c.focused, c.get('google-status'));
  assert.equal(c.get('google-status').tabIndex, -1); assert.equal(c.get('google-status').scrolls.at(-1).block, 'nearest');
  assert.match(c.get('google-status').textContent, reconnect ? /Google 연결을 다시/u : /읽기 권한을 허용하지/u);
  assert.equal(c.get('message').value, '작성 중인 새 이야기');
  assert.equal(c.calls.filter(call => call.path !== '/api/state').length, 0);
});

for (const error of ['CONTACT_GOOGLE_TEMPORARILY_UNAVAILABLE', 'CONTACT_GOOGLE_RESPONSE_INVALID']) test(`a temporary Google failure explains a new explicit request without reconnecting or replaying: ${error}`, async () => {
  const c = client(); c.state.turns = [{ seq: 1, text: '메일을 확인해줘.', state: 'failed', error }]; await c.refresh();
  const status = c.get('messages').children[0].children[0].children[1];
  assert.match(status.textContent, /Google/u); assert.match(status.textContent, /잠시 후 새로/u); assert.match(status.textContent, /자동으로 다시 실행하지 않았어요/u);
  assert.doesNotMatch(status.textContent, /CONTACT_|다시 연결/u);
  assert.equal(status.children.some(button => button.textContent === 'Google 연결 설정'), false);
  assert.equal(c.calls.filter(call => call.path !== '/api/state').length, 0);
});

test('a Google response size failure offers a narrower request or different material without suggesting a blind retry', async () => {
  const c = client(); c.state.turns = [{ seq: 1, text: '메일을 확인해줘.', state: 'failed', error: 'CONTACT_GOOGLE_RESPONSE_LIMIT' }]; await c.refresh();
  const status = c.get('messages').children[0].children[0].children[1];
  assert.match(status.textContent, /Google.*너무 커/u); assert.match(status.textContent, /내용을 좁히거나 다른 자료/u);
  assert.match(status.textContent, /자동으로 다시 실행하지 않았어요/u); assert.doesNotMatch(status.textContent, /CONTACT_|잠시 후|다시 연결/u);
  assert.equal(status.children.some(button => button.textContent === 'Google 연결 설정'), false);
  assert.equal(c.calls.filter(call => call.path !== '/api/state').length, 0);
});

test('an unknown Google failure remains generic without exposing a diagnostic or offering account recovery', async () => {
  const c = client(); c.state.turns = [{ seq: 1, text: '메일을 확인해줘.', state: 'failed', error: 'CONTACT_GOOGLE_UNKNOWN_FAILURE' }]; await c.refresh();
  const status = c.get('messages').children[0].children[0].children[1];
  assert.equal(status.textContent, '이번 요청의 답변을 완료하지 못했어요. 앞선 대화는 보존했어요.');
  assert.equal(status.children.some(button => button.textContent === 'Google 연결 설정'), false);
  assert.doesNotMatch(status.textContent, /CONTACT_|UNKNOWN/u);
});

test('duplicate form submission during admission cannot overlap or steal the next draft', async () => {
  const c = client(); c.get('message').value = 'First instruction';
  const first = c.submit(); c.get('message').value = 'Second instruction';
  const second = c.submit();
  const sent = c.calls.filter(item => item.path === '/api/turns');
  // Settle all admitted HTTP calls before asserting, so a regression does not
  // strand promises or turn a failed assertion into a test-runner hang.
  while (c.pending.length) c.accept();
  await Promise.all([first, second]);
  assert.equal(sent.length, 1);
  assert.equal(c.get('message').value, 'Second instruction');
  const third = c.submit(); c.accept(); await third;
  assert.equal(c.calls.filter(item => item.path === '/api/turns').length, 2);
  assert.equal(c.get('message').value, '');
});

test('an uncertain admission preserves the draft and retries with its original request ID', async () => {
  const c = client(); c.get('message').value = 'Do not duplicate this instruction';
  const first = c.submit(); c.reject(); await first;
  assert.equal(c.get('message').value, 'Do not duplicate this instruction');
  const second = c.submit(); c.accept(); await second;
  const calls = c.calls.filter(item => item.path === '/api/turns');
  assert.equal(calls.length, 2); assert.equal(calls[0].body.request_id, calls[1].body.request_id);
  assert.equal(c.get('message').value, '');
});


test('suggestions preserve an existing draft and never submit on behalf of the user', () => {
  const c = client(); c.get('message').value = 'My unfinished thought';
  c.get('suggest-plan').onclick();
  assert.equal(c.get('message').value, 'My unfinished thought');
  c.get('message').value = ''; c.get('suggest-plan').onclick();
  assert.ok(c.get('message').value.includes('문서로 만들어줘'));
  assert.equal(c.calls.length, 0);
});

test('Enter during Korean composition and Shift+Enter never submit a message', () => {
  const c = client(); let sent = 0;
  c.get('message-form').requestSubmit = () => { sent++; };
  const key = event => c.get('message').onkeydown({ key: 'Enter', preventDefault() {}, ...event });
  key({ isComposing: true }); key({ keyCode: 229 }); key({ shiftKey: true });
  assert.equal(sent, 0); key({}); assert.equal(sent, 1);
});

test('recovering an interrupted request keeps a new draft and requires an explicit send', async () => {
  const c = client(); c.state.turns = [{ seq: 1, text: 'The interrupted request', state: 'interrupted' }];
  await c.refresh();
  const fragment = c.get('messages').children[0], article = fragment.children[0];
  const retry = article.children[1].children[0];
  c.get('message').value = 'A new thought'; retry.onclick();
  assert.equal(c.get('message').value, 'A new thought');
  c.get('message').value = ''; retry.onclick();
  assert.equal(c.get('message').value, 'The interrupted request');
  assert.equal(c.calls.filter(call => call.path === '/api/turns').length, 0);
});

test('explicit rewrite of a confirmed failed admission uses a fresh ID while uncertain replay keeps its old ID', async () => {
  const c = client(); c.get('message').value = 'Try this work';
  const admission = c.submit(); c.reject(); await admission;
  const original = c.calls.find(call => call.path === '/api/turns').body.request_id;
  c.state.turns = [{ seq: 1, request_id: original, text: 'Try this work', state: 'failed' }]; await c.refresh();
  // The original failed-admission draft is still present. Explicit retry must
  // not require deleting that identical draft first.
  c.get('messages').children[0].children[0].children[1].children[0].onclick();
  const next = c.submit(); c.accept(); await next;
  assert.notEqual(c.calls.filter(call => call.path === '/api/turns')[1].body.request_id, original);
});

test('an older failed request with identical text cannot replace an uncertain admission identity', async () => {
  const c = client(); c.get('message').value = 'Try this work';
  const admission = c.submit(); c.reject(); await admission;
  const original = c.calls.find(call => call.path === '/api/turns').body.request_id;
  c.state.turns = [{ seq: 1, request_id: randomUUID(), text: 'Try this work', state: 'failed' }]; await c.refresh();
  c.get('messages').children[0].children[0].children[1].children[0].onclick();
  assert.equal(c.get('message').value, 'Try this work');
  const next = c.submit(); c.accept(); await next;
  assert.equal(c.calls.filter(call => call.path === '/api/turns')[1].body.request_id, original);
});

test('confirmation distinguishes the two local times during the daylight-saving fallback', async () => {
  const c = client();
  c.state.followups = { available: true, proposals: [], notices: [], items: [
    { title: 'First', details: '', state: 'open', notify_at: '2026-11-01T05:30:00Z', timezone: 'America/New_York' },
    { title: 'Second', details: '', state: 'open', notify_at: '2026-11-01T06:30:00Z', timezone: 'America/New_York' },
  ] };
  await c.refresh();
  const cards = c.get('followup-items').children;
  const a = cards[0].children[3].textContent, b = cards[1].children[3].textContent;
  assert.notEqual(a, b); assert.match(a, /GMT-4/u); assert.match(b, /GMT-5/u);
});

test('rewrite waits for admission to settle so its late response cannot erase a restored draft', async () => {
  const c = client(); c.get('message').value = 'Retry this work';
  const admission = c.submit();
  const original = c.calls.find(call => call.path === '/api/turns').body.request_id;
  c.state.turns = [{ seq: 1, request_id: original, text: 'Retry this work', state: 'failed' }]; await c.refresh();
  const retry = c.get('messages').children[0].children[0].children[1].children[0];
  retry.onclick(); assert.match(c.get('notice').textContent, /접수 확인/u);
  c.accept(); await admission;
  retry.onclick(); assert.equal(c.get('message').value, 'Retry this work');
  const next = c.submit(); c.accept(); await next;
  assert.notEqual(c.calls.filter(call => call.path === '/api/turns')[1].body.request_id, original);
});

test('settings navigation keeps account actions separate and closes without retaining the mobile secret', () => {
  const c = client(); c.get('settings-open').onclick();
  assert.equal(c.get('settings').open, true);
  assert.equal(c.get('settings-care').hidden, false); assert.equal(c.get('settings-accounts').hidden, true);
  c.get('settings-nav-accounts').onclick();
  assert.equal(c.get('settings-care').hidden, true); assert.equal(c.get('settings-accounts').hidden, false);
  assert.equal(c.get('settings-nav-accounts').getAttribute('aria-pressed'), 'true');
  c.get('settings-contact-link').onclick();
  assert.equal(c.get('settings-mobile').hidden, false); assert.equal(c.focused, c.get('settings-nav-mobile'));
  c.get('mobile-token').value = 'fixture-not-a-real-secret'; c.get('settings-close').onclick();
  assert.equal(c.get('settings').open, false); assert.equal(c.get('mobile-token').value, '');
  assert.equal(c.focused, c.get('settings-open'));
  assert.equal(c.calls.length, 0);
});

test('a connection error is visible inside the modal and remains available after closing it', async () => {
  const c = client(); c.get('settings-open').onclick(); c.get('settings-nav-mobile').onclick();
  c.handle('/api/mobile/connect', () => { throw Error('Fixture connection unavailable'); });
  c.get('mobile-token').value = 'fixture-not-a-real-secret';
  await c.get('mobile-form').onsubmit({ preventDefault() {} });
  assert.equal(c.get('settings-notice').hidden, false);
  assert.match(c.get('settings-notice').textContent, /Fixture connection unavailable/);
  assert.equal(c.get('notice').hidden, true);
  c.get('settings-close').onclick();
  assert.equal(c.get('notice').hidden, false); assert.equal(c.get('settings-notice').hidden, true);
});

test('continuing use requires its explicit settings action and reports remaining requests and recovery time', async () => {
  const c = client(); c.state.continuing_use = { available: true, enabled: false, remaining: 12 };
  await c.refresh(); assert.equal(c.calls.filter(x => x.path === '/api/continuing-use').length, 0);
  c.handle('/api/continuing-use', () => { c.state.continuing_use = { available: true, enabled: true, remaining: 12 }; return {}; });
  await c.get('continuing-toggle').onclick();
  const sent = c.calls.find(x => x.path === '/api/continuing-use');
  assert.deepEqual(sent.body, { enabled: true, consent: 'continuing_conversation_24h_v1' });
  assert.match(c.get('continuing-status').textContent, /12회/);
  c.state.continuing_use = { available: true, enabled: true, remaining: 0, resumes_at: Date.now() + 1000 }; await c.refresh();
  assert.match(c.get('continuing-status').textContent, /다시 사용 가능/);
});

test('background startup is explicit, shows managed state, and preserves the current draft during transfer', async () => {
  const c = client(); c.state.background = { available: true, enabled: false, running: false, managed: false };
  await c.refresh(); assert.equal(c.calls.some(call => call.path === '/api/background'), false);
  c.get('message').value = 'Still writing this next instruction';
  c.handle('/api/background', () => { c.state.background = { available: true, enabled: true, running: true, managed: true }; return { ...c.state.background, transferring: true }; });
  await c.get('background-toggle').onclick();
  assert.deepEqual(c.calls.find(call => call.path === '/api/background').body, { enabled: true, consent: 'same_assistant_background_v1' });
  assert.equal(c.get('message').value, 'Still writing this next instruction');
  assert.match(c.get('background-status').textContent, /백그라운드에서 실행 중/);
  assert.equal(c.get('background-toggle').textContent, '다음 자동 시작 끄기');
});

test('successful reconnect clears only a transport notice and keeps unrelated recovery warnings', async () => {
  const c = client(); await c.refresh(); c.get('message').value = 'Preserved draft';
  c.setOffline(true); await c.refresh();
  assert.match(c.get('notice').textContent, /연결이 잠시/);
  c.setOffline(false); await c.refresh();
  assert.equal(c.get('notice').textContent, ''); assert.equal(c.get('message').value, 'Preserved draft');
  c.get('notice').textContent = 'Delivery outcome remains unknown'; await c.refresh();
  assert.equal(c.get('notice').textContent, 'Delivery outcome remains unknown');
});

test('successful account observation cannot overwrite a failed proactive proposal status', async () => {
  const c = client(); c.state.proactive = { available: true, enabled: true, mode: 'continuous', timezone: 'Asia/Seoul',
    last: { state: 'failed', created: Date.parse('2026-10-09T00:05:00Z') },
    attention: { observed_at: Date.parse('2026-10-09T00:20:00Z'), google_observed: true, error: null } };
  await c.refresh();
  assert.match(c.get('proactive-last').textContent, /확인 실패/);
  assert.match(c.get('attention-last').textContent, /자료 확인 완료/);
  assert.equal(c.get('attention-last-row').hidden, false);
  assert.match(c.get('proactive-status').textContent, /제안·알림 처리를 끝내지 못/);
  c.state.proactive.attention.google_observed = false; await c.refresh();
  assert.equal(c.get('attention-last-row').hidden, true, 'a local-only observation is not presented as a mailbox/calendar read');
  c.state.proactive.attention.google_observed = true;
  c.state.proactive.mode = 'daily'; await c.refresh(); assert.equal(c.get('attention-last-row').hidden, true);
});

test('answers show paragraphs, emphasis, numbered steps and literal code without interpreting HTML or remote resources', async () => {
  const c = client();
  const text = '### 준비할 일\n\n**내일 오후 3시**까지 정해 주세요.\n확인한 근거입니다. [S1]\n\n7. 참석 인원 정하기\n9. `마이크` 필요 여부 확인\n\n- 첫 번째\n- 두 번째\n\n```html\n<img src="https://example.invalid/private">\n**literal code**\n```\n\n<script>bad()</script> ![image](https://example.invalid/track) [link](javascript:bad())';
  c.state.turns = [{ seq: 1, state: 'answered', text: '도와줘', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  assert.equal(contents(answer.querySelectorAll('h5')[0]), '준비할 일');
  assert.equal(contents(answer.querySelectorAll('strong')[0]), '내일 오후 3시');
  assert.equal(answer.querySelectorAll('ol')[0].getAttribute('start'), '7');
  assert.equal(answer.querySelectorAll('ol')[0].children.length, 2);
  assert.equal(answer.querySelectorAll('ul')[0].children.length, 2);
  assert.equal(contents(answer.querySelectorAll('pre')[0]), '<img src="https://example.invalid/private">\n**literal code**\n');
  assert.equal(answer.querySelectorAll('pre')[0].querySelectorAll('strong').length, 0);
  for (const tag of ['img', 'script', 'a', 'iframe', 'style']) assert.equal(answer.querySelectorAll(tag).length, 0);
  for (const visible of ['<script>bad()</script>', 'image (https://example.invalid/track)', '[link](javascript:bad())']) assert.ok(contents(answer).includes(visible));
  assert.equal(c.state.turns[0].answer.text, text, 'stored and downloadable text is not rewritten');
});

test('unclosed fenced code remains visible and quotations retain their structure', async () => {
  const c = client();
  c.state.turns = [{ seq: 1, state: 'answered', text: '도와줘', answer: { text: '> 인용\n\n~~~text\n<tag>\n- literal list\n**literal**', sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  assert.equal(contents(answer.querySelectorAll('blockquote')[0]), '인용');
  assert.equal(contents(answer.querySelectorAll('pre')[0]), '<tag>\n- literal list\n**literal**');
  assert.equal(answer.querySelectorAll('li').length, 0);
  assert.equal(answer.querySelectorAll('strong').length, 0);
});

test('code delimiters, nested work lists and spaced fence info preserve their meaning', async () => {
  const c = client();
  const text = '``printf `whoami` ``\n\n- 회의 A\n  - 준비 A\n    - 세부 A\n- 회의 B\n\n``` python\nprint("ready")\n```\n\n**뒤에 오는 경고**';
  c.state.turns = [{ seq: 1, state: 'answered', text: '도와줘', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  assert.equal(contents(answer.querySelectorAll('code')[0]), 'printf `whoami` ');
  const outer = answer.querySelectorAll('ul')[0];
  assert.equal(outer.children.length, 2);
  assert.equal(outer.children[0].querySelectorAll('ul').length, 2);
  assert.equal(outer.children[1].querySelectorAll('ul').length, 0);
  assert.equal(contents(answer.querySelectorAll('pre')[0]), 'print("ready")\n');
  assert.equal(contents(answer.querySelectorAll('strong')[0]), '뒤에 오는 경고');
  assert.equal(answer.querySelectorAll('pre')[0].querySelectorAll('strong').length, 0);
});

test('links, images and HTML remain inert while their readable content is preserved', async () => {
  const c = client();
  const text = '[링크](javascript:bad()) ![그림](https://example.invalid/tracking.png)\n\n<img src=x onerror=bad()>\n\n안내 <b onclick="bad()">본문</b>';
  c.state.turns = [{ seq: 1, state: 'answered', text: '도와줘', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  for (const tag of ['a', 'img', 'b', 'script', 'iframe']) assert.equal(answer.querySelectorAll(tag).length, 0);
  assert.ok(contents(answer).includes('[링크](javascript:bad())'));
  assert.match(contents(answer), /그림 \(https:\/\/example.invalid\/tracking.png\)/);
  assert.match(contents(answer), /<img src=x onerror=bad\(\)>/);
  assert.match(contents(answer), /<b onclick="bad\(\)">본문<\/b>/);
});

test('missing formatting script falls back to the complete original answer', async () => {
  const c = client({ parser: false }), text = '## 그대로\n\n**내용**\n\n``` python\nprint("보존")';
  c.state.turns = [{ seq: 1, state: 'answered', text: '도와줘', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  assert.equal(answer.querySelectorAll('p')[0].textContent, text);
});

test('personal-work delegation is an explicit settings choice and keeps the current draft', async () => {
  const c = client();
  c.state.followups.delegation = { available: true, enabled: false };
  await c.refresh(); assert.equal(c.get('delegation-settings').hidden, false);
  assert.equal(c.calls.some(call => call.path === '/api/followup-delegation'), false);
  c.get('message').value = '아직 작성 중인 다음 부탁';
  c.handle('/api/followup-delegation', () => {
    c.state.followups.delegation.enabled = !c.state.followups.delegation.enabled; return c.state.followups.delegation;
  });
  await c.get('delegation-toggle').onclick();
  assert.deepEqual(c.calls.find(call => call.path === '/api/followup-delegation').body, { enabled: true, consent: 'personal_followups_v1' });
  assert.match(c.get('delegation-status').textContent, /바로 처리/);
  assert.equal(c.get('message').value, '아직 작성 중인 다음 부탁');
  await c.get('delegation-toggle').onclick();
  assert.deepEqual(c.calls.findLast(call => call.path === '/api/followup-delegation').body, { enabled: false, consent: null });
  assert.match(c.get('delegation-status').textContent, /한 번 더 확인/);
});

test('a failed delegated save explains expired device coverage without claiming an active reminder', async () => {
  const c = client(); c.state.turns = [{ seq: 1, state: 'failed', text: '내년에 알려줘', error: 'CONTACT_FOLLOWUP_DEVICE_EXPIRES' }];
  await c.refresh();
  const status = c.get('messages').querySelectorAll('div.status')[0];
  assert.match(status.textContent, /기기의 접근권 유효기간/);
  assert.doesNotMatch(status.textContent, /CONTACT_|저장했어요/);
});

test('related-mail access is an explicit on-screen choice, reflects revocation, and preserves the current draft', async () => {
  const c = client();
  c.state.google = { available: true, configured: true, connected: true, has_credential: true, state: 'connected', account: 'owner@example.test', related_mail: { enabled: false } };
  await c.refresh();
  assert.equal(c.get('related-mail-settings').hidden, false);
  assert.equal(c.get('related-mail-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(c.calls.some(call => call.path === '/api/google/related-mail'), false);
  c.get('message').value = '아직 쓰는 중인 메시지';
  c.handle('/api/google/related-mail', () => { c.state.google.related_mail.enabled = !c.state.google.related_mail.enabled; return c.state.google.related_mail; });
  await c.get('related-mail-toggle').onclick();
  assert.deepEqual(c.calls.find(call => call.path === '/api/google/related-mail').body, { enabled: true, consent: 'related_mail_readonly_v1' });
  assert.equal(c.get('related-mail-toggle').getAttribute('aria-pressed'), 'true');
  assert.match(c.get('related-mail-status').textContent, /보낸 기록/u);
  await c.get('related-mail-toggle').onclick();
  assert.equal(c.get('related-mail-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(c.get('message').value, '아직 쓰는 중인 메시지');
  c.state.google.pending = true; await c.refresh(); assert.equal(c.get('related-mail-toggle').disabled, true);
});


test('planning tables retain headers, emphasis, escaped pipes and citations with safe scroll regions', async () => {
  const c = client();
  const text = '| 우선 | 할 일 | 기한 |\n| :--- | :---: | ---: |\n| **1** | 승인 확인 [S1] | 오늘 17시 |\n| 2 | `a\\|b` 확인 | 내일 |';
  c.state.turns = [{ seq: 1, state: 'answered', text: '이번 주 정리', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  const region = answer.querySelectorAll('div.answer-table')[0];
  assert.equal(region.getAttribute('tabindex'), '0'); assert.equal(region.getAttribute('role'), 'region');
  assert.equal(region.querySelectorAll('table').length, 1);
  assert.deepEqual(region.querySelectorAll('th').map(contents), ['우선', '할 일', '기한']);
  assert.ok(region.querySelectorAll('th').every(cell => cell.getAttribute('scope') === 'col'));
  assert.equal(region.querySelectorAll('th')[1].className, 'align-center');
  assert.equal(region.querySelectorAll('th')[2].className, 'align-right');
  assert.deepEqual(region.querySelectorAll('td').map(contents), ['1', '승인 확인 [S1]', '오늘 17시', '2', 'a|b 확인', '내일']);
  assert.equal(contents(region.querySelectorAll('strong')[0]), '1');
  assert.equal(contents(region.querySelectorAll('code')[0]), 'a|b');
  assert.equal(c.state.turns[0].answer.text, text);
});

test('table contents cannot create active HTML, remote resources or event attributes', async () => {
  const c = client();
  const text = '| 자료 | 내용 |\n| --- | --- |\n| [메일](https://example.invalid/private) | <img src=x onerror=bad()> |\n| ![그림](https://example.invalid/track) | [실행](javascript:bad()) |';
  c.state.turns = [{ seq: 1, state: 'answered', text: '정리', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  assert.equal(answer.querySelectorAll('table').length, 1);
  for (const tag of ['a', 'img', 'script', 'iframe', 'style', 'input']) assert.equal(answer.querySelectorAll(tag).length, 0);
  for (const value of ['메일 (https://example.invalid/private)', '<img src=x onerror=bad()>', '그림 (https://example.invalid/track)', '[실행](javascript:bad())']) assert.ok(contents(answer).includes(value));
  const visit = node => { for (const [key] of node.attributes) assert.ok(!/^on|^(?:href|src|style|id)$/u.test(key)); for (const child of node.children) visit(child); };
  visit(answer);
});

test('table-like code stays code and malformed separators do not lose text', async () => {
  const c = client();
  const text = '```text\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n\n| 제목 | 내용 |\n| 잘못된 구분 | 선 |\n| 원문 | 유지 |';
  c.state.turns = [{ seq: 1, state: 'answered', text: '정리', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  assert.equal(answer.querySelectorAll('table').length, 0);
  assert.equal(contents(answer.querySelectorAll('pre')[0]), '| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  assert.ok(contents(answer).includes('| 원문 | 유지 |'));
});
