// Execute the actual browser client for async form behavior. This small DOM/HTTP
// fixture is not a substitute for the separate real Chromium rendering checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../apps/contact/app.js', import.meta.url), 'utf8');
function client() {
  class Element {
    value = ''; hidden = false; disabled = false; textContent = ''; children = [];
    focus() {}
    append(...items) { this.children.push(...items); }
    prepend(...items) { this.children.unshift(...items); }
    replaceChildren(...items) { this.children = items; }
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const calls = [], pending = [];
  const state = { assistant: 'fixture', device: 'fixture-device', turns: [], next_before: null,
    usage: {}, messaging: {}, followups: { available: false }, host_stopping: false };
  const context = {
    URLSearchParams, crypto: { randomUUID },
    location: { hash: '#pair=fixture', pathname: '/' }, history: { replaceState() {} },
    document: { getElementById: get, hidden: false, body: { scrollHeight: 100 },
      createElement: () => new Element(), createDocumentFragment: () => new Element() },
    window: { innerHeight: 800, scrollY: 0, scrollTo() {} },
    EventSource: class { addEventListener() {} close() {} },
    fetch: (path, options) => {
      calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
      if (path === '/api/turns') return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
      assert.equal(path, '/api/state');
      return Promise.resolve({ ok: true, status: 200, json: async () => state });
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'actual-contact-app.js' });
  return { get, calls, pending, state, refresh: () => vm.runInContext('refresh()', context), submit: () => get('message-form').onsubmit({ preventDefault() {} }),
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
  assert.ok(c.get('message').value.includes('어디서부터'));
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
