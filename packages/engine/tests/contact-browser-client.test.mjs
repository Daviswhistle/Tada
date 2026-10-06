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
  vm.runInNewContext(source, context, { filename: 'actual-contact-app.js' });
  return { get, calls, pending, submit: () => get('message-form').onsubmit({ preventDefault() {} }),
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
