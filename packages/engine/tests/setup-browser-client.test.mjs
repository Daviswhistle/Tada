import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../../../apps/contact/setup.js', import.meta.url), 'utf8');
const token = 'a'.repeat(43);
const storage = (data = new Map()) => ({ data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) });
async function client({ hash = '', local = storage(), session = storage(), status = 200 } = {}) {
  const elements = new Map(), calls = [], events = new Map(); let reloads = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', replaceChildren() {} }); return elements.get(id); };
  const location = { hash, pathname: '/', reload: () => { reloads++; } };
  const context = { URLSearchParams, location, history: { replaceState() { location.hash = ''; } },
    window: { localStorage: local, sessionStorage: session, addEventListener: (name, handler) => events.set(name, handler) },
    document: { getElementById: get, querySelectorAll: () => [], createElement: () => ({}) }, setTimeout() {},
    fetch: async (path, options) => { calls.push({ path, authorization: options.headers.Authorization }); return { status, ok: status === 200, json: async () => ({ stage: 'consent', revision: 'fixture-state' }) }; },
  };
  vm.createContext(context); vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, location, events, local, session, reloads: () => reloads };
}
test('the same running setup resumes after browser restart loses session storage and fragment', async () => {
  const local = storage();
  const first = await client({ hash: '#setup=' + token, local });
  assert.equal(first.location.hash, ''); assert.equal(first.calls[0].authorization, 'Bearer ' + token);
  const reopened = await client({ local, session: storage() });
  assert.equal(reopened.calls[0].authorization, 'Bearer ' + token);
  assert.equal(reopened.get('consent').hidden, false);
});
test('a rejected startup token is cleared and shows an error instead of indefinite preparation', async () => {
  const local = storage(new Map([['tada-setup', token]])), session = storage(new Map([['tada-setup', token]]));
  const c = await client({ local, session, status: 401 });
  assert.equal(local.data.size, 0); assert.equal(session.data.size, 0);
  assert.equal(c.get('error').hidden, false); assert.equal(c.get('retry').hidden, true);
  assert.match(c.get('description').textContent, /연결이 만료/u);
});
test('a fresh capability link replaces stale storage and reopening it in the same tab reloads', async () => {
  const local = storage(new Map([['tada-setup', 'b'.repeat(43)]]));
  const c = await client({ hash: '#setup=' + token, local });
  assert.equal(c.calls[0].authorization, 'Bearer ' + token); assert.equal(local.getItem('tada-setup'), token);
  c.location.hash = '#setup=' + 'c'.repeat(43); c.events.get('hashchange')(); assert.equal(c.reloads(), 1);
  c.location.hash = '#setup=invalid'; c.events.get('hashchange')(); assert.equal(c.reloads(), 1);
});
test('blocked browser storage still permits the explicit startup link without leaking it into the URL', async () => {
  const unavailable = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  const c = await client({ hash: '#setup=' + token, local: unavailable, session: unavailable });
  assert.equal(c.calls[0].authorization, 'Bearer ' + token); assert.equal(c.location.hash, '');
});
