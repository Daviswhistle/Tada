// Execute the actual browser client for async form behavior. This small DOM/HTTP
// fixture is not a substitute for the separate real Chromium rendering checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../apps/contact/app.js', import.meta.url), 'utf8');
const parserSource = readFileSync(new URL('../../../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', import.meta.url), 'utf8');
function client({ parser = true, hash = '#pair=fixture', initiallyOffline = false } = {}) {
  const elements = new Map();
  let focused = null, offline = initiallyOffline, clock = 0, timerId = 0;
  const timers = new Map(), streams = [], browserEvents = new Map(), stateResponses = [];
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async ms => {
    const end = clock + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    clock = end; await flush();
  };
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
  const calls = [], pending = [], handlers = new Map(), replies = new Map();
  const state = { assistant: 'fixture', device: 'fixture-device', turns: [], next_before: null,
    usage: {}, messaging: {}, followups: { available: false }, host_stopping: false };
  const context = {
    URL, URLSearchParams, atob, AbortController, TextEncoder, performance: { now: () => clock }, crypto: { randomUUID },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    location: { hash, pathname: '/' }, history: { replaceState() {} },
    document: { getElementById: get, hidden: false, body, addEventListener: (name, fn) => browserEvents.set(name, fn),
      createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }), createDocumentFragment: () => new Element() },
    window: { innerHeight: 800, scrollY: 0, scrollTo() {}, confirm: () => true, addEventListener: (name, fn) => browserEvents.set(name, fn) },
    EventSource: class {
      readyState = 1; listeners = new Map();
      constructor() { streams.push(this); }
      addEventListener(name, fn) { this.listeners.set(name, fn); }
      close() { this.readyState = 2; }
      emit(name) { if (name === 'error') this.onerror?.(); else this.listeners.get(name)?.(); }
    },
    fetch: (path, options) => {
      calls.push({ path, body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
      if (offline) return Promise.reject(Error('fixture network loss'));
      if (replies.has(path)) return Promise.resolve().then(() => replies.get(path)(options));
      if (path === '/api/turns') return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
      if (handlers.has(path)) return Promise.resolve({ ok: true, status: 200, json: async () => handlers.get(path)() });
      assert.equal(path, '/api/state');
      if (stateResponses.length) return stateResponses.shift()(options);
      return Promise.resolve({ ok: true, status: 200, json: async () => state });
    },
  };
  vm.createContext(context);
  if (parser) vm.runInContext(parserSource, context, { filename: 'actual-markdown.js' });
  vm.runInContext(source, context, { filename: 'actual-contact-app.js' });
  return { get, calls, pending, state, streams, timers, advance, flush,
    browserEvent: (name, event) => browserEvents.get(name)?.(event), respond: (path, callback) => replies.set(path, callback),
    queueState: fn => stateResponses.push(fn),
    setOffline: value => { offline = value; }, get focused() { return focused; }, handle: (path, callback) => handlers.set(path, callback), refresh: () => vm.runInContext('refresh()', context), submit: () => get('message-form').onsubmit({ preventDefault() {} }),
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
  assert.match(c.get('settings-notice').textContent, /연결이 잠시 끊겼어요/);
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

test('table contents allow owner-clicked web links but never active HTML, automatic remote resources or event attributes', async () => {
  const c = client();
  const text = '| 자료 | 내용 |\n| --- | --- |\n| [메일](https://example.invalid/private) | <img src=x onerror=bad()> |\n| ![그림](https://example.invalid/track) | [실행](javascript:bad()) |';
  c.state.turns = [{ seq: 1, state: 'answered', text: '정리', answer: { text, sources: [] } }];
  await c.refresh();
  const answer = c.get('messages').querySelectorAll('div.answer')[0];
  const contents = element => element.textContent + element.children.map(contents).join('');
  assert.equal(answer.querySelectorAll('table').length, 1);
  for (const tag of ['img', 'script', 'iframe', 'style', 'input']) assert.equal(answer.querySelectorAll(tag).length, 0);
  const links = answer.querySelectorAll('a'); assert.equal(links.length, 1); assert.equal(links[0].getAttribute('href'), 'https://example.invalid/private');
  assert.equal(links[0].getAttribute('target'), '_blank'); assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
  for (const value of ['메일', '<img src=x onerror=bad()>', '그림 (https://example.invalid/track)', '[실행](javascript:bad())']) assert.ok(contents(answer).includes(value));
  const visit = node => { for (const [key] of node.attributes) assert.ok(!/^on|^(?:src|style|id)$/u.test(key) && (key !== 'href' || node.tagName === 'A')); for (const child of node.children) visit(child); };
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

test('citations open HTTP(S) only without referrers; credential, relative and executable links stay inert', async () => {
  const c = client();
  c.state.turns = [{ seq: 1, state: 'answered', text: '자료 조사', answer: { verification: 'provider_web_report_checked', sources: [{ id: 'S1', source: 'ChatGPT public web research', path: 'report-1' }], text: '[공식](https://example.org/source) [자료](http://example.org/info) [비밀](https://user:password@example.org/) [상대](/api/logout) [메일](mailto:someone@example.org) [코드](javascript:bad()) ![원격](https://example.org/track)' } }];
  await c.refresh(); const answer = c.get('messages').querySelectorAll('div.answer')[0], links = answer.querySelectorAll('a');
  assert.deepEqual(links.map(e => e.getAttribute('href')), ['https://example.org/source', 'http://example.org/info']);
  assert.ok(links.every(e => e.getAttribute('rel') === 'noopener noreferrer' && e.getAttribute('target') === '_blank'));
  assert.equal(answer.querySelectorAll('img').length, 0);
  const contents = e => e.textContent + e.children.map(contents).join('');
  assert.match(contents(c.get('messages')), /각 웹페이지를 별도로 다시 검증한 것은 아닙니다/);
});

test('persisted public citations remain clickable when the model answer contains only a source ID',async()=>{
 const c=client();c.state.turns=[{seq:1,state:'answered',text:'자료 조사',answer:{text:'확인한 결과입니다. [S1]',verification:'provider_web_report_checked',sources:[{id:'S1',source:'ChatGPT public web research',path:'report-1',citations:[{url:'https://example.org/primary',title:'공식 원문'},{url:'javascript:bad()',title:'실행 금지'},{url:'https://user:secret@example.org',title:'인증 포함 금지'}]}]}}];
 await c.refresh();const links=c.get('messages').querySelectorAll('a');
 assert.deepEqual(links.map(a=>a.getAttribute('href')),['https://example.org/primary']);assert.equal(links[0].textContent,'공식 원문');assert.equal(links[0].getAttribute('rel'),'noopener noreferrer');
});

const visibleText = node => node.textContent + node.children.map(visibleText).join('');
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });

test('a terminal event stream recovers completed work without resubmission or losing a draft', async () => {
  const c = client(); c.state.turns = [{ seq: 1, text: 'Prepare my meeting', state: 'running' }]; await c.refresh();
  c.get('message').value = 'The next draft'; const dead = c.streams[0]; dead.readyState = 2; dead.emit('error');
  c.state.turns[0] = { ...c.state.turns[0], state: 'answered', answer: { text: 'Meeting prepared', sources: [] } };
  await c.advance(1999); assert.match(visibleText(c.get('messages')), /확인하고 있어요/);
  await c.advance(1); assert.match(visibleText(c.get('messages')), /Meeting prepared/);
  assert.equal(c.streams.length, 2); assert.equal(c.get('message').value, 'The next draft');
  assert.ok(c.calls.every(call => call.path === '/api/state')); assert.equal(c.timers.size, 1);
  const reads = c.calls.length; dead.emit('changed'); dead.emit('error'); await c.flush();
  assert.equal(c.calls.length, reads, 'detached event handlers cannot change the active connection');
  assert.equal(c.get('connection').textContent, '이야기할 준비가 됐어요');
});

test('a quiet but stuck event stream is checked periodically without replacing a healthy stream', async () => {
  const c = client(); await c.refresh();
  c.state.turns = [{ seq: 1, text: 'Work', state: 'answered', answer: { text: 'Saved result', sources: [] } }];
  await c.advance(30000); assert.match(visibleText(c.get('messages')), /Saved result/);
  assert.equal(c.calls.length, 2); assert.equal(c.streams.length, 1); assert.equal(c.timers.size, 1);
  await c.advance(30000); assert.equal(c.calls.length, 3);
});

test('initial read failure retries with bounded backoff and succeeds without a pairing or message POST', async () => {
  const c = client({ hash: '', initiallyOffline: true }); await c.flush();
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    const count = c.calls.length; await c.advance(delay - 1); assert.equal(c.calls.length, count);
    await c.advance(1); assert.equal(c.calls.length, count + 1); assert.equal(c.timers.size, 1);
  }
  c.setOffline(false); c.get('message').value = 'Kept'; await c.advance(30000);
  assert.equal(c.get('conversation').hidden, false); assert.equal(c.get('message').value, 'Kept');
  assert.equal(c.get('notice').textContent, ''); assert.ok(c.calls.every(call => call.path === '/api/state'));
});

test('a hung state response is aborted and recovered after the read timeout', async () => {
  const c = client(); let signal;
  c.queueState(options => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))); });
  const reading = c.refresh(); await c.advance(9999); assert.equal(signal.aborted, false);
  await c.advance(1); await reading; assert.equal(signal.aborted, true);
  assert.equal(c.get('connection').textContent, '다시 연결하는 중'); await c.advance(2000);
  assert.equal(c.get('connection').textContent, '이야기할 준비가 됐어요'); assert.equal(c.calls.length, 2);
});

for (const status of [200, 401, 503]) test(`superseded state response ${status} cannot overwrite the newer authenticated state`, async () => {
  const c = client(); let finish;
  c.queueState(() => new Promise(resolve => { finish = resolve; })); const old = c.refresh();
  await c.refresh(); finish(response(status, status === 200 ? { ...c.state, host_stopping: true } : { error: 'CONTACT_PAIR_REQUIRED' })); await old;
  assert.equal(c.get('conversation').hidden, false); assert.equal(c.get('connection').textContent, '이야기할 준비가 됐어요');
  assert.equal(c.timers.size, 1); assert.equal(c.streams.length, 1);
});

for (const action of ['logout', 'revocation']) test(`${action} stops retries, rejects late state, and ignores old events and foreground wakeups`, async () => {
  const c = client(); await c.refresh(); const stream = c.streams[0]; let finish;
  c.queueState(() => new Promise(resolve => { finish = resolve; })); const old = c.refresh();
  if (action === 'logout') { c.handle('/api/logout', () => ({})); await c.get('logout').onclick(); }
  else { c.queueState(() => Promise.resolve(response(401, { error: 'CONTACT_PAIR_REQUIRED' }))); await c.refresh(); }
  finish(response(200, c.state)); await old;
  const count = c.calls.length; stream.emit('changed'); stream.emit('error'); c.browserEvent('online'); c.browserEvent('visibilitychange'); await c.advance(90000);
  assert.equal(c.calls.length, count); assert.equal(c.get('conversation').hidden, true); assert.equal(stream.readyState, 2); assert.equal(c.timers.size, 0);
});

test('an uncertain submitted message keeps its request identity throughout automatic recovery', async () => {
  const c = client(); await c.refresh(); c.get('message').value = 'Original work';
  const first = c.submit(); c.reject(); await first;
  const id = c.calls.find(call => call.path === '/api/turns').body.request_id;
  c.streams[0].readyState = 2; c.streams[0].emit('error'); await c.advance(2000); await c.advance(30000);
  assert.equal(c.calls.filter(call => call.path === '/api/turns').length, 1); assert.equal(c.get('message').value, 'Original work');
  const explicitRetry = c.submit(); assert.equal(c.calls.filter(call => call.path === '/api/turns').at(-1).body.request_id, id); c.accept(); await explicitRetry;
});

test('auto-pair after an initial outage uses one read retry loop and pairs only after a definitive authentication denial', async () => {
  const c = client({ hash: '#pair=fixture&auto=1', initiallyOffline: true }); await c.flush();
  assert.equal(c.timers.size, 1); await c.advance(2000); assert.equal(c.timers.size, 1);
  assert.ok(c.calls.every(call => call.path === '/api/state'));
  c.setOffline(false); c.queueState(() => Promise.resolve(response(401, { error: 'CONTACT_PAIR_REQUIRED' })));
  c.handle('/api/pair', () => ({})); await c.advance(4000);
  assert.equal(c.calls.filter(call => call.path === '/api/pair').length, 1); assert.equal(c.get('conversation').hidden, false); assert.equal(c.timers.size, 1);
});

test('network return observes current state promptly while preserving a draft', async () => {
  const c = client(); await c.refresh(); c.setOffline(true); await c.refresh();
  c.get('message').value = 'Draft'; c.setOffline(false); c.browserEvent('online'); await c.flush();
  assert.equal(c.get('connection').textContent, '이야기할 준비가 됐어요'); assert.equal(c.get('message').value, 'Draft');
  assert.equal(c.timers.size, 1); assert.ok(c.calls.every(call => call.path === '/api/state'));
});

test('a state response whose body stalls is covered by the same bounded read timeout', async () => {
  const c = client(); let signal;
  c.queueState(options => { signal = options.signal; return Promise.resolve({ ok: true, status: 200,
    json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('body aborted')))) }); });
  const reading = c.refresh(); await c.flush(); await c.advance(10000); await reading;
  assert.equal(signal.aborted, true); await c.advance(2000); assert.equal(c.get('conversation').hidden, false);
});

test('ambiguous automatic pairing is not retried by the recovery timer', async () => {
  const c = client({ hash: '#pair=fixture&auto=1', initiallyOffline: true }); await c.flush(); c.setOffline(false);
  c.queueState(() => Promise.resolve(response(401, { error: 'CONTACT_PAIR_REQUIRED' })));
  c.handle('/api/pair', () => { throw Error('Ambiguous pairing transport'); }); await c.advance(2000);
  const count = c.calls.length; await c.advance(90000); c.browserEvent('online'); await c.flush();
  assert.equal(c.calls.length, count); assert.equal(c.calls.filter(call => call.path === '/api/pair').length, 1);
  assert.equal(c.get('conversation').hidden, true); assert.equal(c.timers.size, 0);
});


test('repeated reconnect errors cannot postpone the earliest scheduled state read', async () => {
 const c=client(); await c.refresh(); c.setOffline(true); const stream=c.streams[0]; stream.readyState=0; stream.emit('error');
 await c.advance(2000); await c.advance(2000);
 c.setOffline(false); c.state.turns=[{seq:1,text:'Work',state:'answered',answer:{text:'Saved during outage',sources:[]}}];
 for(let i=0;i<20;i++){await c.advance(3000);stream.emit('error');}
 assert.match(visibleText(c.get('messages')),/Saved during outage/);
 assert.ok(c.calls.length>3); assert.equal(c.timers.size,1); assert.ok(c.calls.every(call=>call.path==='/api/state'));
});

test('unchanged observations retain the expanded historical work page while changed work is refreshed',async()=>{
 const c=client(); const item={id:'current',title:'Current work',details:'Current',state:'open',notify_at:null,timezone:'Asia/Seoul'};
 c.state.followups={available:true,reviews_available:false,items:[item],proposals:[],notices:[]};
 c.handle('/api/followups?offset=0',()=>({items:[{...item,id:'past',title:'Earlier completed work',state:'done'}],next_offset:null}));
 await c.refresh(); await c.get('followup-more').onclick();
 assert.match(visibleText(c.get('followup-items')),/Earlier completed work/);
 await c.advance(30000); assert.match(visibleText(c.get('followup-items')),/Earlier completed work/);
 assert.equal(c.get('followup-more').hidden,true);
 c.state.followups.items[0]={...item,title:'Changed current work'}; await c.advance(30000);
 assert.match(visibleText(c.get('followup-items')),/Changed current work/);
 assert.doesNotMatch(visibleText(c.get('followup-items')),/Earlier completed work/);
 assert.equal(c.get('followup-more').hidden,false);
});


test('an action on a later work page invalidates the passive cache and exposes the current reservation and cancellation',async()=>{
 const c=client();
 const items=Array.from({length:6},(_,i)=>({id:randomUUID(),version:1,title:`Work ${i+1}`,details:'Review',state:'open',notify_at:new Date(Date.now()+3600000).toISOString(),timezone:'Asia/Seoul',review:null}));
 c.state.followups={available:true,reviews_available:true,items:structuredClone(items.slice(0,5)),proposals:[],notices:[]};
 c.handle('/api/followups?offset=0',()=>({items:structuredClone(items.slice(0,5)),next_offset:5}));
 c.handle('/api/followups?offset=5',()=>({items:structuredClone(items.slice(5)),next_offset:null}));
 c.handle('/api/followups/review',()=>{items[5].review={state:'armed'};return {};});
 c.handle('/api/followups/review/cancel',()=>{items[5].review={state:'cancelled'};return {};});
 const showAll=async()=>{await c.get('followup-more').onclick();await c.get('followup-more').onclick();};
 await c.refresh();await showAll();
 await c.get('followup-items').children[5].children.find(n=>n.tagName==='BUTTON').onclick();
 assert.equal(c.get('followup-more').hidden,false);await showAll();
 assert.match(visibleText(c.get('followup-items').children[5]),/자동 확인 예약됨/);
 await c.get('followup-items').children[5].children.find(n=>n.textContent==='자동 확인 취소').onclick();
 await showAll();assert.match(visibleText(c.get('followup-items').children[5]),/자동 확인이 취소됐어요/);
 // A change event invalidates a page even if the first five records are equal.
 c.state.followups.view_revision='changed-elsewhere';c.streams[0].emit('changed');await c.flush();assert.equal(c.get('followup-more').hidden,false);
 assert.equal(c.get('followup-items').children.length,5);
});


for(const stop of ['logout','revocation'])test(`late admitted message cannot restart recovery after ${stop}`,async()=>{
 const c=client();await c.refresh();c.get('message').value='Submitted before leaving';const sending=c.submit();
 if(stop==='logout'){c.handle('/api/logout',()=>({}));await c.get('logout').onclick();}
 else{c.queueState(()=>Promise.resolve(response(401,{error:'CONTACT_PAIR_REQUIRED'})));await c.refresh();}
 c.setOffline(true);const count=c.calls.length;c.accept();await sending;c.browserEvent('online');c.browserEvent('visibilitychange');await c.advance(120000);
 assert.equal(c.calls.length,count);assert.equal(c.timers.size,0);assert.equal(c.get('conversation').hidden,true);
});

test('an explicitly successful pairing can start observation after a stopped connection',async()=>{
 const c=client();await c.refresh();c.handle('/api/logout',()=>({}));await c.get('logout').onclick();
 c.handle('/api/pair',()=>({}));await c.get('pair-form').onsubmit({preventDefault(){}});
 assert.equal(c.get('conversation').hidden,false);assert.equal(c.timers.size,1);
});

test('an uncertain work mutation invalidates the view before polling, without replaying the mutation',async()=>{
 const c=client();const item={id:randomUUID(),version:1,title:'Outside first page',details:'Review',state:'open',notify_at:new Date(Date.now()+3600000).toISOString(),timezone:'Asia/Seoul',review:{state:'armed'}};
 c.state.followups={available:true,reviews_available:true,items:[],proposals:[],notices:[],view_revision:'initial'};
 c.handle('/api/followups?offset=0',()=>({items:[structuredClone(item)],next_offset:null}));
 c.handle('/api/followups/review/cancel',()=>{item.review.state='cancelled';throw Error('Response lost');});
 await c.refresh();await c.get('followup-more').onclick();await c.get('followup-items').children[0].children.find(n=>n.textContent==='자동 확인 취소').onclick();
 await c.advance(30000);assert.equal(c.get('followup-more').hidden,false);await c.get('followup-more').onclick();
 assert.match(visibleText(c.get('followup-items')),/자동 확인이 취소됐어요/);
 assert.equal(c.calls.filter(x=>x.path==='/api/followups/review/cancel').length,1);
});

test('a host revision refreshes work outside the first page even when the change event is lost',async()=>{
 const c=client();const item={id:randomUUID(),title:'Historical work',details:'Old state',state:'open',notify_at:null,timezone:'Asia/Seoul'};
 c.state.followups={available:true,reviews_available:false,items:[],proposals:[],notices:[],view_revision:'first'};
 c.handle('/api/followups?offset=0',()=>({items:[structuredClone(item)],next_offset:null}));
 await c.refresh();await c.get('followup-more').onclick();c.streams[0].emit('changed');await c.flush();
 assert.match(visibleText(c.get('followup-items')),/Historical work/,'unchanged heartbeat preserves the expanded list');
 item.state='done';c.state.followups.view_revision='second';await c.advance(30000);
 assert.equal(c.get('followup-more').hidden,false);await c.get('followup-more').onclick();assert.match(visibleText(c.get('followup-items')),/완료로 기록/);
});

for (const change of ['cancel', 'logout', 'reconnect']) test(`a late work page cannot overwrite the view after ${change}`, async () => {
  const c = client(); let finish;
  const item = { id: randomUUID(), version: 1, title: 'Work', details: 'Review', state: 'open', notify_at: new Date(Date.now() + 3600000).toISOString(), timezone: 'Asia/Seoul', review: { state: 'armed' } };
  c.state.followups = { available: true, reviews_available: true, items: [structuredClone(item)], proposals: [], notices: [], view_revision: 'first' };
  c.handle('/api/followups?offset=0', () => new Promise(resolve => { finish = resolve; }));
  await c.refresh(); const page = c.get('followup-more').onclick(); await c.flush();
  if (change === 'cancel') {
    c.state.followups.items[0].review.state = 'cancelled'; c.state.followups.view_revision = 'second';
    c.streams[0].emit('changed'); await c.flush();
  } else {
    c.handle('/api/logout', () => ({})); await c.get('logout').onclick();
    if (change === 'reconnect') { c.handle('/api/pair', () => ({})); await c.get('pair-form').onsubmit({ preventDefault() {} }); }
  }
  finish({ items: [{ ...item, title: 'Stale page' }], next_offset: null }); await page; await c.advance(30000);
  assert.doesNotMatch(visibleText(c.get('followup-items')), /Stale page/);
  if (change === 'cancel') {
    assert.match(visibleText(c.get('followup-items')), /자동 확인이 취소됐어요/);
    assert.doesNotMatch(visibleText(c.get('followup-items')), /자동 확인 예약됨|자동 확인 취소/);
  } else assert.equal(c.get('conversation').hidden, change === 'logout');
});

test('an unchanged heartbeat admits a pending work page once even with duplicate page requests', async () => {
  const c = client(), finishes = [];
  c.state.followups = { available: true, reviews_available: false, items: [], proposals: [], notices: [], view_revision: 'first' };
  c.handle('/api/followups?offset=0', () => new Promise(resolve => { finishes.push(resolve); }));
  await c.refresh(); const first = c.get('followup-more').onclick(), second = c.get('followup-more').onclick(); await c.flush();
  c.streams[0].emit('changed'); await c.flush();
  const item = { id: randomUUID(), title: 'Historical work', details: 'Work', state: 'done', notify_at: null, timezone: 'Asia/Seoul' };
  finishes[0]({ items: [item], next_offset: 5 }); await first;
  finishes[1]({ items: [item], next_offset: 5 }); await second;
  assert.equal(c.get('followup-items').children.length, 1);
  assert.match(visibleText(c.get('followup-items')), /Historical work/);
});

test('a stale page failure after logout does not replace current connection guidance', async () => {
  const c = client(); let fail;
  c.state.followups = { available: true, reviews_available: false, items: [], proposals: [], notices: [] };
  c.handle('/api/followups?offset=0', () => new Promise((resolve, reject) => { fail = reject; }));
  await c.refresh(); const page = c.get('followup-more').onclick(); await c.flush();
  c.handle('/api/logout', () => ({})); await c.get('logout').onclick(); const notice = c.get('notice').textContent;
  fail(Error('Late page failure')); await page;
  assert.equal(c.get('notice').textContent, notice); assert.equal(c.timers.size, 0);
});

const editorFixture = async () => {
  const c = client(), doc = { version: 1, id: 1, root: 1, revision: 1, based_on: null, title: '회의 안내', format: 'markdown', content: '14시 · 2층', sources: [] };
  c.state.document_editing = true; c.state.turns = [{ seq: 1, text: '문서 작성', state: 'answered', answer: { text: doc.content, sources: [], document: doc } }];
  c.handle('/api/documents/1/edit', () => ({ document: doc })); await c.refresh();
  const button = c.get('messages').querySelectorAll('button').find(b => b.textContent === '직접 수정'); assert.ok(button); await button.onclick();
  return { c, doc };
};
test('document drafts survive conversation updates, close/reopen and temporary disconnection without HTML execution', async () => {
  const { c, doc } = await editorFixture();
  const draft = '<script>keep as text</script>15시 · 1층'; c.get('document-editor-content').value = draft;
  c.state.turns.push({ seq: 2, text: '다른 대화', state: 'answered', answer: { text: '새 답변', sources: [] } }); await c.refresh();
  assert.equal(c.get('document-editor-content').value, draft); assert.equal(c.get('document-editor').open, true);
  c.get('document-editor-close').onclick(); assert.equal(c.get('document-editor').open, false);
  await c.get('messages').querySelectorAll('button').find(b => b.textContent === '직접 수정').onclick();
  assert.equal(c.get('document-editor-content').value, draft); assert.equal(c.get('document-editor').open, true);
  let prevented = false; c.browserEvent('beforeunload', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  c.setOffline(true); await c.refresh(); assert.equal(c.get('document-editor-content').value, draft);
  assert.equal(doc.content, '14시 · 2층'); assert.equal(c.get('document-editor-content').children.length, 0);
});
test('lost document-save response freezes the exact draft and explicitly retries its original request ID', async () => {
  const { c, doc } = await editorFixture(); c.get('document-editor-content').value = '15시 · 1층'; let attempts = 0;
  c.respond('/api/documents/edit', options => {
    const body = JSON.parse(options.body); if (++attempts === 1) throw Error('lost after commit');
    return { ok: true, status: 200, json: async () => ({ document: { ...doc, id: 2, version: 2, revision: 2, based_on: 1, author: 'owner', content: body.content } }) };
  });
  const submit = () => c.get('document-editor-form').onsubmit({ preventDefault() {} });
  await submit(); assert.equal(c.get('document-editor-save').textContent, '저장 확인'); assert.equal(c.get('document-editor-content').readOnly, true);
  assert.equal(c.get('document-editor-discard').disabled, true); await c.refresh();
  assert.equal(c.calls.filter(x => x.path === '/api/documents/edit').length, 1, 'background reads never replay a write');
  await submit(); const writes = c.calls.filter(x => x.path === '/api/documents/edit'); assert.equal(writes.length, 2); assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(c.get('document-editor-content').readOnly, false); assert.match(c.get('document-editor-version').textContent, /버전 2/);
  assert.equal(c.calls.filter(x => x.path === '/api/turns').length, 0);
});
test('conflicting document edits expose the latest version separately and retain the owner draft when switching bases', async () => {
  const { c, doc } = await editorFixture(), draft = '내가 쓴 내용 15시'; c.get('document-editor-content').value = draft;
  const newer = { ...doc, id: 3, revision: 2, content: '다른 기기에서 새로 고친 내용', title: '새 제목' };
  c.handle('/api/documents/1/edit', () => ({ document: newer }));
  c.respond('/api/documents/edit', () => ({ ok: false, status: 400, json: async () => ({ error: 'CONTACT_DOCUMENT_STALE' }) }));
  await c.get('document-editor-form').onsubmit({ preventDefault() {} });
  assert.equal(c.get('document-editor-content').value, draft); assert.equal(c.get('document-conflict').hidden, false);
  assert.match(c.get('document-conflict-content').textContent, /다른 기기/);
  c.get('document-use-latest').onclick(); assert.equal(c.get('document-editor-content').value, newer.content);
  assert.ok(c.get('document-draft-backup-content').textContent.includes(draft)); assert.equal(c.get('document-draft-backup').hidden, false);
  assert.match(c.get('document-editor-version').textContent, /버전 2/);
});
test('an edit read arriving after authentication expires cannot reopen private document UI', async () => {
  const { c } = await editorFixture(); c.get('document-editor-close').onclick(); let release;
  c.respond('/api/documents/1/edit', () => new Promise(resolve => { release = resolve; }));
  const opening = c.get('messages').querySelectorAll('button').find(b => b.textContent === '직접 수정').onclick(); await c.flush();
  c.queueState(async () => ({ ok: false, status: 401, json: async () => ({ error: 'CONTACT_PAIR_REQUIRED' }) })); await c.refresh();
  release({ ok: true, status: 200, json: async () => ({ document: { id: 1, title: 'Late secret', content: 'late' } }) }); await opening;
  assert.equal(c.get('document-editor').open, false); assert.notEqual(c.get('document-editor-name').value, 'Late secret');
});

test('oversized document drafts stay editable without submitting an ambiguous save', async () => {
  const { c } = await editorFixture(); const draft = '한'.repeat(3000); c.get('document-editor-content').value = draft;
  await c.get('document-editor-form').onsubmit({ preventDefault() {} });
  assert.equal(c.calls.filter(x => x.path === '/api/documents/edit').length, 0);
  assert.equal(c.get('document-editor-content').value, draft); assert.notEqual(c.get('document-editor-content').readOnly, true);
  assert.match(c.get('document-editor-notice').textContent, /내용이 너무 길어요/);
});

test('conflict backups survive reopens, subsequent conflicts and saves until explicitly discarded', async () => {
  const { c, doc } = await editorFixture(); const submit = () => c.get('document-editor-form').onsubmit({ preventDefault() {} });
  c.get('document-editor-content').value = 'First unsaved owner draft';
  let latest = { ...doc, id: 2, revision: 2, content: 'Latest content' };
  c.handle('/api/documents/1/edit', () => ({ document: latest }));
  c.respond('/api/documents/edit', () => ({ ok: false, status: 400, json: async () => ({ error: 'CONTACT_DOCUMENT_STALE' }) }));
  await submit(); c.get('document-use-latest').onclick();
  c.get('document-editor-close').onclick();
  await c.get('messages').querySelectorAll('button').find(b => b.textContent === '직접 수정').onclick();
  assert.equal(c.get('document-draft-backup').hidden, false); assert.match(c.get('document-draft-backup-content').textContent, /First unsaved/);
  let warned = 0; c.browserEvent('beforeunload', { preventDefault() { warned++; } }); assert.equal(warned, 1);
  c.get('document-editor-content').value = 'Second unsaved owner draft';
  latest = { ...latest, id: 3, revision: 3, content: 'Third version' }; c.handle('/api/documents/2/edit', () => ({ document: latest }));
  await submit(); c.get('document-use-latest').onclick();
  assert.match(c.get('document-draft-backup-content').textContent, /First unsaved/); assert.match(c.get('document-draft-backup-content').textContent, /Second unsaved/);
  c.respond('/api/documents/edit', () => ({ ok: true, status: 200, json: async () => ({ document: { ...latest, id: 4, revision: 4 } }) }));
  await submit(); assert.equal(c.get('document-draft-backup').hidden, false);
  c.browserEvent('beforeunload', { preventDefault() { warned++; } }); assert.equal(warned, 2);
  c.get('document-backup-discard').onclick(); assert.equal(c.get('document-discard-confirm').hidden, false);
  c.get('document-discard-keep').onclick(); assert.equal(c.get('document-draft-backup').hidden, false);
  c.get('document-backup-discard').onclick(); c.get('document-discard-confirmed').onclick(); assert.equal(c.get('document-draft-backup').hidden, true);
  c.browserEvent('beforeunload', { preventDefault() { warned++; } }); assert.equal(warned, 2);
});

test('discarding an edited draft uses an inline confirmation and cancel retains the draft', async () => {
  const { c } = await editorFixture(); c.get('document-editor-content').value = 'Keep this draft';
  c.get('document-editor-discard').onclick(); assert.equal(c.get('document-discard-confirm').hidden, false); assert.equal(c.get('document-editor').open, true);
  c.get('document-discard-keep').onclick(); assert.equal(c.get('document-discard-confirm').hidden, true); assert.equal(c.get('document-editor-content').value, 'Keep this draft');
  c.get('document-editor-discard').onclick(); c.get('document-discard-confirmed').onclick(); assert.equal(c.get('document-editor').open, false);
  let warned = false; c.browserEvent('beforeunload', { preventDefault() { warned = true; } }); assert.equal(warned, false);
});

test('Windows startup reports registration separately from login execution and leaves the current draft intact', async () => {
  const c = client(); c.state.background = { available: true, enabled: false, running: true, managed: true, platform: 'win32', startup: 'registered_only' };
  await c.refresh(); c.get('message').value = '작성 중';
  c.handle('/api/background', () => { c.state.background.enabled = true; return { ...c.state.background, transferring: false }; });
  await c.get('background-toggle').onclick();
  assert.match(c.get('background-status').textContent, /등록돼/);
  assert.match(c.get('background-environment').textContent, /시작 앱/);
  assert.doesNotMatch(c.get('background-status').textContent, /종료 후 복구도 준비/);
  assert.equal(c.get('message').value, '작성 중');
});
async function mailFixture({ failLoad = false } = {}) {
  const c = client(), record = { version: 1, id: 'mail-11111111-1111-4111-8111-111111111111', turn: 1, revision: 1, state: 'DRAFT', sha256: 'a'.repeat(64), draft: { account: 'owner@example.test', to: ['recipient@example.test'], cc: [], bcc: ['private@example.test'], subject: '미팅 안내', body: '금요일에 뵙겠습니다.', reply: null } };
  c.state.google = { available: true, configured: true, connected: true, has_credential: true, account: record.draft.account, mail: { ready: true, enabled: true } };
  c.state.turns = [{ seq: 1, text: '초안을 준비해 줘', state: 'answered', answer: { text: '초안을 확인해 주세요.', sources: [], mail_action_id: record.id } }];
  c.handle(`/api/mail/${record.id}`, () => ({ mail: record }));
  if (failLoad) c.respond(`/api/mail/${record.id}`, () => { throw Error('Synthetic first load failure'); });
  await c.refresh();
  await c.get('messages').querySelectorAll('button').find(b => b.textContent === '메일 초안·발송 결과 확인').onclick();
  return { c, record };
}
test('mail editor displays every recipient, blocks unsaved sends and preserves inputs on CAS conflict', async () => {
  const { c, record } = await mailFixture();
  assert.equal(c.get('mail-bcc').value, 'private@example.test'); assert.equal(c.get('mail-send').disabled, false);
  c.get('mail-body').value = '직접 쓴 내용 <script>plain text</script>'; c.get('mail-form').oninput();
  assert.equal(c.get('mail-send').disabled, true);
  c.respond('/api/mail/edit', () => ({ ok: false, status: 400, json: async () => ({ error: 'CONTACT_MAIL_DRAFT_CHANGED' }) }));
  c.get('mail-form').onsubmit({ preventDefault() {} }); await c.flush();
  assert.equal(c.get('mail-body').value, '직접 쓴 내용 <script>plain text</script>'); assert.match(c.get('mail-error').textContent, /다른 곳/u);
  assert.equal(record.draft.body, '금요일에 뵙겠습니다.'); c.get('mail-close').onclick(); assert.equal(c.get('mail-editor').open, true);
  c.get('mail-keep').onclick(); assert.equal(c.get('mail-editor').open, true);
  assert.equal(c.calls.filter(call => call.path === '/api/mail/send').length, 0);
});
test('lost send response disables repeat sending until a read resolves current state', async () => {
  const { c, record } = await mailFixture();
  c.respond('/api/mail/send', () => { throw Error('synthetic response lost'); });
  c.get('mail-send').onclick(); await c.flush();
  assert.equal(c.get('mail-send').disabled, true); assert.match(c.get('mail-error').textContent, /다시 보내지/u);
  record.state = 'UNCERTAIN'; await c.get('mail-reload').onclick(); await c.flush();
  assert.equal(c.get('mail-send').hidden, true); assert.equal(c.get('mail-reconcile').hidden, false);
  assert.equal(c.calls.filter(call => call.path === '/api/mail/send').length, 1);
});
test('revoked connection closes mail editor and drops late private response', async () => {
  const { c, record } = await mailFixture(); let release;
  c.respond(`/api/mail/${record.id}`, () => new Promise(resolve => { release = resolve; }));
  c.get('mail-reload').onclick(); await c.flush();
  c.respond('/api/state', () => ({ ok: false, status: 401, json: async () => ({ error: 'CONTACT_PAIR_REQUIRED' }) }));
  await c.refresh(); assert.equal(c.get('mail-editor').open, false); assert.equal(c.get('mail-body').value, '');
  release({ ok: true, status: 200, json: async () => ({ mail: record }) }); await c.flush();
  assert.equal(c.get('mail-body').value, ''); assert.equal(c.get('mail-editor').open, false);
});
test('mail state refresh follows another device without overwriting an in-progress edit', async () => {
  const { c, record } = await mailFixture();
  c.handle(`/api/mail/${record.id}`, () => ({ mail: { ...record, state: 'ACCEPTED' } }));
  await c.refresh(); await c.flush(); assert.equal(c.get('mail-send').hidden, true);
  c.handle(`/api/mail/${record.id}`, () => ({ mail: record })); await c.get('mail-reload').onclick(); await c.flush();
  let release; c.respond(`/api/mail/${record.id}`, () => new Promise(resolve => { release = resolve; }));
  await c.refresh(); await c.flush(); c.get('mail-body').value = '작성 중인 새 내용'; c.get('mail-form').oninput();
  release({ ok: true, status: 200, json: async () => ({ mail: { ...record, state: 'ACCEPTED' } }) }); await c.flush();
  assert.equal(c.get('mail-body').value, '작성 중인 새 내용'); assert.equal(c.get('mail-send').disabled, true);
});

test('mail initial read failure retains its target for retry and cannot edit or send before loading', async () => {
  const { c, record } = await mailFixture({ failLoad: true });
  assert.equal(c.get('mail-form').hidden, true); assert.equal(c.get('mail-reload').disabled, false);
  for (const name of ['mail-save', 'mail-discard', 'mail-send', 'mail-reconcile']) assert.equal(c.get(name).disabled, true);
  assert.doesNotThrow(() => c.get('mail-send').onclick());
  c.respond(`/api/mail/${record.id}`, () => ({ ok: true, status: 200, json: async () => ({ mail: record }) }));
  await c.get('mail-reload').onclick(); await c.flush();
  assert.equal(c.get('mail-form').hidden, false); assert.equal(c.get('mail-to').value, record.draft.to[0]); assert.equal(c.get('mail-send').disabled, false);
  assert.equal(c.calls.filter(call => call.path === '/api/mail/send').length, 0);
});

test('mail unsaved edits warn before tab exit until saved or explicitly discarded', async () => {
  const { c, record } = await mailFixture();
  const warning = () => { let warned = false; c.browserEvent('beforeunload', { preventDefault() { warned = true; } }); return warned; };
  assert.equal(warning(), false);
  c.get('mail-body').value = '저장하기 전 수정'; c.get('mail-form').oninput(); assert.equal(warning(), true);
  c.handle('/api/mail/edit', () => ({ mail: { ...record, revision: 2, draft: { ...record.draft, body: '저장하기 전 수정' } } }));
  c.get('mail-form').onsubmit({ preventDefault() {} }); await c.flush(); assert.equal(warning(), false);
  c.get('mail-to').value = 'new@example.test'; c.get('mail-form').oninput(); assert.equal(warning(), true);
  c.get('mail-close').onclick(); c.get('mail-keep').onclick(); assert.equal(warning(), true);
  c.get('mail-close').onclick(); c.get('mail-discard-yes').onclick(); assert.equal(warning(), false);
});

for (const phase of ['headers', 'body']) test(`stalled mail ${phase} read times out and reload recovers without sending`, async () => {
  const { c, record } = await mailFixture(); c.get('mail-close').onclick();
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  c.respond(`/api/mail/${record.id}`, () => phase === 'headers' ? stalled : { ok: true, status: 200, json: () => stalled });
  const opening = c.get('messages').querySelectorAll('button').find(b => b.textContent === '메일 초안·발송 결과 확인').onclick(); await c.flush();
  const request = c.calls.filter(call => call.path === `/api/mail/${record.id}`).at(-1);
  assert.equal(c.get('mail-reload').disabled, true);
  await c.advance(15000); await opening;
  assert.equal(request.signal.aborted, true); assert.equal(c.get('mail-reload').disabled, false);
  assert.match(c.get('mail-error').textContent, /연결/u);
  c.respond(`/api/mail/${record.id}`, () => ({ ok: true, status: 200, json: async () => ({ mail: { ...record, revision: 2 } }) }));
  await c.get('mail-reload').onclick(); assert.match(c.get('mail-account').textContent, /수정 2/u);
  release(phase === 'headers' ? { ok: true, status: 200, json: async () => ({ mail: record }) } : { mail: record }); await c.flush();
  assert.match(c.get('mail-account').textContent, /수정 2/u);
  assert.equal(c.calls.filter(call => call.path === '/api/mail/send').length, 0);
});

test('closing a pending mail read aborts immediately and late data cannot overwrite a reopened card', async () => {
  const { c, record } = await mailFixture(); c.get('mail-close').onclick(); let release;
  c.respond(`/api/mail/${record.id}`, () => new Promise(resolve => { release = resolve; }));
  const open = () => c.get('messages').querySelectorAll('button').find(b => b.textContent === '메일 초안·발송 결과 확인').onclick();
  const opening = open(); await c.flush(); const request = c.calls.filter(call => call.path === `/api/mail/${record.id}`).at(-1);
  c.get('mail-editor').oncancel({ preventDefault() {} }); await opening;
  assert.equal(c.get('mail-editor').open, false); assert.equal(request.signal.aborted, true);
  c.respond(`/api/mail/${record.id}`, () => ({ ok: true, status: 200, json: async () => ({ mail: { ...record, revision: 3 } }) }));
  await open(); release({ ok: true, status: 200, json: async () => ({ mail: record }) }); await c.flush();
  assert.equal(c.get('mail-editor').open, true); assert.match(c.get('mail-account').textContent, /수정 3/u);
  assert.equal(c.get('mail-send').disabled, false);
});

test('stalled send wait becomes uncertain, unlocks close and never replays the POST', async () => {
  const { c, record } = await mailFixture(); let release;
  c.respond('/api/mail/send', () => ({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) }));
  c.get('mail-send').onclick(); await c.flush(); c.get('mail-close').onclick(); assert.equal(c.get('mail-editor').open, true);
  await c.advance(30000); await c.flush();
  assert.equal(c.get('mail-send').disabled, true); assert.equal(c.get('mail-reload').disabled, false);
  assert.match(c.get('mail-error').textContent, /다시 보내지/u);
  c.get('mail-close').onclick(); assert.equal(c.get('mail-editor').open, false);
  release({ mail: { ...record, state: 'ACCEPTED' } }); await c.flush();
  assert.equal(c.get('mail-editor').open, false); assert.equal(c.calls.filter(call => call.path === '/api/mail/send').length, 1);
});

test('mail reads honor current authentication loss but ignore an aborted late 401', async () => {
  const { c, record } = await mailFixture(); let release;
  c.respond(`/api/mail/${record.id}`, () => new Promise(resolve => { release = resolve; }));
  const loading = c.get('mail-reload').onclick(); await c.flush(); c.get('mail-close').onclick(); await loading;
  c.respond(`/api/mail/${record.id}`, () => ({ ok: true, status: 200, json: async () => ({ mail: record }) }));
  await c.get('messages').querySelectorAll('button').find(b => b.textContent === '메일 초안·발송 결과 확인').onclick();
  release({ ok: false, status: 401, json: async () => ({ error: 'CONTACT_PAIR_REQUIRED' }) }); await c.flush();
  assert.equal(c.get('mail-editor').open, true); assert.equal(c.get('conversation').hidden, false);
  c.respond(`/api/mail/${record.id}`, () => ({ ok: false, status: 401, json: async () => ({ error: 'CONTACT_PAIR_REQUIRED' }) }));
  await c.get('mail-reload').onclick();
  assert.equal(c.get('mail-editor').open, false); assert.equal(c.get('conversation').hidden, true); assert.equal(c.get('mail-body').value, '');
});

for (const surface of ['card', 'settings']) test(`cancel pending send permission from ${surface} keeps the existing readable connection and allows another attempt`, async () => {
  const { c } = await mailFixture(); c.state.google.mail.enabled = false; await c.refresh();
  c.handle('/api/google/connect', () => { c.state.google.pending = true; c.state.google.mail.connecting = true; return { state: 'waiting' }; });
  c.handle('/api/google/disable-mail', () => { c.state.google.pending = false; c.state.google.mail.connecting = false; return { enabled: false }; });
  await c.get('mail-connect').onclick();
  const cancel = surface === 'card' ? c.get('mail-connect') : c.get('google-settings-slot').querySelectorAll('button').find(b => b.textContent === '발송 권한 연결 취소 · 읽기 연결 유지');
  assert.ok(cancel); assert.equal(cancel.hidden, false); assert.equal(cancel.disabled, false);
  await cancel.onclick();
  assert.equal(c.state.google.connected, true); assert.equal(c.state.google.has_credential, true); assert.equal(c.state.google.pending, false);
  assert.equal(c.get('mail-connect').disabled, false); assert.equal(c.calls.filter(call => call.path === '/api/google/disconnect').length, 0);
  assert.equal(c.calls.filter(call => call.path === '/api/google/disable-mail').length, 1);
  await c.get('mail-connect').onclick(); assert.equal(c.calls.filter(call => call.path === '/api/google/connect').length, 2);
});

test('read-only reconnection is not mislabeled as a cancelable send permission upgrade', async () => {
  const { c } = await mailFixture(); c.state.google.mail = { ready: true, enabled: false, connecting: false }; c.state.google.pending = true;
  await c.refresh(); assert.equal(c.get('mail-connect').disabled, true);
  const disable = c.get('google-settings-slot').querySelectorAll('button').find(b => b.textContent === 'Tada에서 메일 발송 끄기');
  assert.equal(disable.hidden, true); assert.equal(c.calls.filter(call => call.path === '/api/google/disable-mail').length, 0);
});
