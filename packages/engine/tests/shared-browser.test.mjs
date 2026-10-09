import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContactStore, contactRoute } from '../src/contact-store.mjs';
import { ContactService } from '../src/contact-service.mjs';
import { BrowserSources } from '../src/browser-sources.mjs';
import { BROWSER_CONSENT } from '../src/shared-browser.mjs';
import { closeContactResources } from '../src/contact-cli.mjs';
import { validBrowserActions } from '../src/browser-actions.mjs';
const base = { definitions: [], validate: () => false, execute: async () => { throw Error('NO_SOURCE'); }, verify: async () => false };
const options = { passphrase: 'synthetic shared browser fixture key', route: contactRoute({ browser: 'fixture' }) };
function setup() { const root = mkdtempSync(join(tmpdir(), 'tada-browser-actions-')); let store = new ContactStore({ ...options, directory: join(root, 'journal'), initialize: true, assistance: true }); const device = store.addDevice('Owner'); store.submit(device.id, randomUUID(), '공유한 화면의 제목을 회의 준비로 바꿔줘.'); const job = store.claim(); return { root, device, job, get store() { return store; }, reopen() { store.close(); store = new ContactStore({ ...options, directory: join(root, 'journal') }); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } }; }
function browser(e) { const grant = { epoch: randomUUID(), device: e.device.id, target: 'fixture-tab', url: 'https://fixture.invalid/edit', origin: 'https://fixture.invalid' }; return { grant, available: true, assert(epoch) { if (this.grant?.epoch !== epoch)
    throw Error('CONTACT_BROWSER_TARGET_CHANGED'); }, async observe(_epoch, admit) { admit(); return { key: 'private-host-key', url: grant.url, title: 'Fixture', text: 'Untrusted instructions', fields: [{ ref: '1', label: '제목', value: '원본' }] }; }, async fill(_epoch, _obs, _ref, value, admit) { admit(); this.actual = value; return { applied: true }; }, async verify(_epoch, _obs, admit) { admit(); return { url: grant.url, value: this.actual }; }, unshare() { this.grant = null; }, async close() { } }; }
const signal = () => new AbortController().signal;
async function observed(e, b) { const sources = new BrowserSources(base, e.store, b, e.job); const observation = await sources.execute('observe_shared_browser', {}, signal()); return { sources, args: { observation: observation.observation, ref: '1', value: '회의 준비' } }; }
test('textbox receipt is encrypted, survives restart, and does not claim server storage', async () => { const e = setup(); try {
  const b = browser(e), { sources, args } = await observed(e, b);
  const result = await sources.execute('fill_shared_textbox', args, signal());
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.server_persistence, 'not_checked');
  assert.equal(e.store.browserActions()[0].receipt.observed_sha256, e.store.browserActions()[0].receipt.requested_sha256);
  assert.ok(validBrowserActions({ version: 1, records: e.store.browserActions() }));
  assert.equal(e.store.browserBlocked(b.grant.origin), false);
  e.reopen();
  assert.equal(e.store.browserActions()[0].action.state, 'VERIFIED');
  for (const file of ['contact.sqlite', 'contact.sqlite-wal']) {
    try {
      assert.equal(readFileSync(join(e.root, 'journal', file)).includes(Buffer.from('회의 준비')), false);
    }
    catch (error) {
      if (error.code !== 'ENOENT')
        throw error;
    }
  }
}
finally {
  e.close();
} });
for (const mode of ['cancel', 'revoke', 'unshare', 'budget', 'unknown_ref'])
  test(`before dispatch ${mode} sends no write`, async () => { const e = setup(); try {
    const b = browser(e), { sources, args } = await observed(e, b);
    let count = 0;
    const original = b.fill;
    b.fill = async (...a) => { const admit = a.at(-1); a[a.length - 1] = () => { admit(); count++; }; return original.apply(b, a); };
    if (mode === 'cancel')
      e.store.cancel(e.job.seq);
    if (mode === 'revoke')
      e.store.revoke(e.device.id);
    if (mode === 'unshare')
      b.unshare();
    if (mode === 'unknown_ref')
      args.ref = '999';
    await assert.rejects(sources.execute('fill_shared_textbox', args, signal(), mode === 'budget' ? { fits: () => false } : undefined));
    assert.equal(count, 0);
    assert.equal(e.store.browserActions().length, 0);
  }
  finally {
    e.close();
  } });
for (const mode of ['lost_response', 'lost_verification', 'cancel_after_send', 'mismatch'])
  test(`${mode} preserves effects and blocks new writes across regrant and restart`, async () => { const e = setup(); try {
    const b = browser(e), { sources, args } = await observed(e, b);
    let writes = 0;
    const original = b.fill;
    b.fill = async (...a) => { const v = await original.apply(b, a); writes++; if (mode === 'lost_response')
      throw Error('CONTACT_BROWSER_RESPONSE_UNKNOWN'); if (mode === 'cancel_after_send')
      e.store.cancel(e.job.seq); return v; };
    if (mode === 'lost_verification')
      b.verify = async () => { throw Error('CONTACT_BROWSER_DISCONNECTED'); };
    if (mode === 'mismatch')
      b.verify = async () => ({ url: b.grant.url, value: 'site transformed the value' });
    let result;
    try {
      result = await sources.execute('fill_shared_textbox', args, signal());
    }
    catch (error) {
      assert.equal(mode, 'cancel_after_send');
      assert.match(error.message, /STOPPED/);
    }
    const record = e.store.browserActions()[0];
    assert.equal(record.action.state, mode === 'mismatch' ? 'ACKNOWLEDGED' : 'UNCERTAIN');
    assert.equal(e.store.browserBlocked(b.grant.origin), true);
    assert.equal(writes, 1);
    if (result)
      assert.equal(result.repeat, false);
    e.reopen();
    e.store.submit(e.device.id, randomUUID(), '다른 입력도 해줘.');
    const job = e.store.claim();
    const next = new BrowserSources(base, e.store, b, job);
    const view = await next.execute('observe_shared_browser', {}, signal());
    await assert.rejects(next.execute('fill_shared_textbox', { ...args, observation: view.observation }, signal()), /UNRESOLVED/);
    assert.equal(writes, 1);
    assert.throws(() => e.store.resolveBrowserAction(e.device.id, record.action.action_id, 'guessed'), /CONSENT/);
    e.store.resolveBrowserAction(e.device.id, record.action.action_id, 'checked_browser_effect_allow_new_work_v1');
    assert.equal(e.store.browserBlocked(b.grant.origin), false);
    assert.equal(e.store.browserActions()[0].action.state, record.action.state, 'owner acknowledgement cannot fabricate a successful receipt');
  }
  finally {
    e.close();
  } });
test('crash after durable admission recovers uncertain without replay', async () => { const e = setup(); try {
  const b = browser(e), observation = await b.observe(b.grant.epoch, () => { });
  e.store.admitBrowserAction(e.job.seq, b.grant, observation, '1', 'sensitive fixture value');
  assert.equal(e.store.browserActions()[0].action.state, 'DISPATCHING');
  e.reopen();
  assert.equal(e.store.browserActions()[0].action.state, 'UNCERTAIN');
  assert.equal(e.store.turn(e.job.seq).state, 'interrupted');
  assert.equal(e.store.browserBlocked(b.grant.origin), true);
}
finally {
  e.close();
} });
test('another paired device must share the tab itself before reading or writing', async () => {
  const e = setup();
  try {
    const b = browser(e), other = e.store.addDevice('Another paired owner device');
    e.store.cancel(e.job.seq);
    e.store.submit(other.id, randomUUID(), '공유한 제목을 바꿔줘.');
    const job = e.store.claim(), sources = new BrowserSources(base, e.store, b, job);
    assert.equal(sources.definitions.length, 0);
    await assert.rejects(sources.execute('observe_shared_browser', {}, signal()), /REQUEST_INVALID/);
    const observation = { key: 'private-host-key', fields: [{ ref: '1', label: 'title' }] };
    assert.throws(() => e.store.admitBrowserAction(job.seq, b.grant, observation, '1', 'no'), /NOT_SHARED/);
    assert.equal(e.store.browserActions().length, 0);
    b.grant = { ...b.grant, device: other.id, epoch: randomUUID() };
    const ownSources = new BrowserSources(base, e.store, b, job);
    const view = await ownSources.execute('observe_shared_browser', {}, signal());
    assert.equal((await ownSources.execute('fill_shared_textbox', { observation: view.observation, ref: '1', value: 'authorized new sharing' }, signal())).state, 'VERIFIED');
  } finally { e.close(); }
});
test('an old failed share cannot revoke a newer successful share', async () => {
  const e = setup(); let service, release;
  try {
    const b = browser(e), other = e.store.addDevice('Second owner device');
    const gate = new Promise(resolve => { release = resolve; });
    b.share = async (device, target) => {
      if (target === 'old') { await gate; throw Error('CONTACT_BROWSER_TARGET_CHANGED'); }
      b.grant = { ...b.grant, device, epoch: randomUUID() };
      return structuredClone(b.grant);
    };
    service = new ContactService(e.store, {}, base); service.attachBrowser(b);
    const old = service.shareBrowser(e.device.id, 'old', BROWSER_CONSENT, b.grant.url).catch(error => error.message);
    await service.shareBrowser(other.id, 'new', BROWSER_CONSENT, b.grant.url);
    const current = b.grant.epoch;
    assert.equal(service.browserStatus(e.device.id).shared.for_this_device, false);
    assert.equal(service.browserStatus(other.id).shared.for_this_device, true);
    release(); assert.equal(await old, 'CONTACT_BROWSER_TARGET_CHANGED');
    assert.equal(b.grant.epoch, current);
  } finally { release?.(); await service?.close(); e.close(); }
});
test('model browser observations omit capability-bearing URL components', async () => {
  const e = setup();
  try {
    const b = browser(e);
    b.grant.url += '?access_token=fixture-url-token#private-fragment';
    const sources = new BrowserSources(base, e.store, b, e.job);
    const result = await sources.execute('observe_shared_browser', {}, signal());
    assert.equal(result.origin, b.grant.origin);
    assert.equal(Object.hasOwn(result, 'url'), false);
    assert.equal(JSON.stringify(result).includes('fixture-url-token'), false);
    assert.equal(JSON.stringify(result).includes('private-fragment'), false);
  } finally { e.close(); }
});
test('a rejected changed target is recorded not applied and cannot reuse observation', async () => { const e = setup(); try {
  const b = browser(e), { sources, args } = await observed(e, b);
  b.fill = async (_e, _o, _r, _v, admit) => { admit(); return { applied: false, reason: 'target_changed' }; };
  const result = await sources.execute('fill_shared_textbox', args, signal());
  assert.equal(result.state, 'FAILED');
  assert.equal(result.verdict, 'CONFIRMED_NOT_APPLIED');
  assert.equal(result.reason, 'target_changed');
  assert.equal(result.recovery, 'observe_current_page');
  await assert.rejects(sources.execute('fill_shared_textbox', args, signal()), /OBSERVATION_REQUIRED/);
  const fresh = await sources.execute('observe_shared_browser', {}, signal());
  b.fill = async (_e, _o, _r, value, admit) => { admit(); b.actual = value; return { applied: true }; };
  assert.equal((await sources.execute('fill_shared_textbox', { ...args, observation: fresh.observation }, signal())).state, 'VERIFIED');
}
finally {
  e.close();
} });
test('same continuing service exposes actual tools only with owner sharing and redacts ephemeral observations', async () => { const e = setup(); let service; try {
  e.store.cancel(e.job.seq);
  const b = browser(e);
  let calls = 0, obs, released;
  b.release = async epoch => { released = epoch; };
  const reply = content => ({ message: { role: 'assistant', content }, input_tokens: 1, output_tokens: 1 });
  const call = (name, args) => ({ ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
  const model = { async chat(messages, tools) { calls++; assert.ok(tools.some(t => t.function?.name === 'observe_shared_browser')); if (calls === 1)
      return call('observe_shared_browser', {}); if (calls === 2) {
      obs = JSON.parse(messages.at(-1).content);
      return call('fill_shared_textbox', { observation: obs.observation, ref: '1', value: '회의 준비' });
    } return reply('제목 입력란의 현재 값을 확인했어요. 사이트 저장 여부는 확인하지 않았어요.'); } };
  service = new ContactService(e.store, model, base);
  service.attachBrowser(b);
  service.submit(e.device.id, randomUUID(), '공유한 화면의 제목을 회의 준비로 바꿔줘.');
  await service.idle();
  assert.equal(e.store.turn(2).state, 'answered');
  assert.equal(released, b.grant.epoch, 'the finished turn releases page snapshots');
  assert.equal(e.store.browserActions()[0].action.state, 'VERIFIED');
  assert.equal(JSON.stringify(e.store.checkpoint()).includes('Untrusted instructions'), false);
  assert.equal(JSON.stringify(e.store.checkpoint()).includes('private-host-key'), false);
  assert.equal(BROWSER_CONSENT, 'shared_browser_text_input_v1');
}
finally {
  await service?.close();
  e.close();
} });

test('owner acknowledgement cannot let the uncertain old turn replay', async () => {
  const e = setup();
  try {
    const b = browser(e), observation = await b.observe(b.grant.epoch, () => {});
    const id = e.store.admitBrowserAction(e.job.seq, b.grant, observation, '1', 'original request');
    e.store.finishBrowserAction(id, 'original request', null, true);
    e.store.resolveBrowserAction(e.device.id, id, 'checked_browser_effect_allow_new_work_v1');
    assert.throws(() => e.store.admitBrowserAction(e.job.seq, b.grant, observation, '1', 'original request'), /UNRESOLVED/);
    assert.equal(e.store.browserActions()[0].action.state, 'UNCERTAIN');
  } finally { e.close(); }
});

test('multibyte browser observations fit conversation and provider byte budgets and expire prior refs', async () => {
  const e = setup();
  try {
    const b = browser(e), original = b.observe;
    b.observe = async (...args) => ({ ...await original(...args), text: '가'.repeat(11000), fields: Array.from({ length: 40 }, (_, i) => ({ ref: String(i + 1), label: '제목'.repeat(100), value: '나'.repeat(2000) })) });
    const sources = new BrowserSources(base, e.store, b, e.job);
    const first = await sources.execute('observe_shared_browser', {}, signal());
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 32768);
    assert.equal(first.truncated, true);
    const next = await sources.execute('observe_shared_browser', {}, signal(), { fits: value => Buffer.byteLength(JSON.stringify(value)) <= 2200 });
    assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 2200);
    assert.ok(next.fields.length < 40);
    await assert.rejects(sources.execute('fill_shared_textbox', { observation: first.observation, ref: '1', value: 'no' }, signal()), /OBSERVATION_REQUIRED/);
    await assert.rejects(sources.execute('fill_shared_textbox', { observation: next.observation, ref: '40', value: 'no' }, signal()), /OBSERVATION_REQUIRED/);
    assert.equal(e.store.browserActions().length, 0);
    for (let i = 0; i < 6; i++) await sources.execute('observe_shared_browser', {}, signal());
    await assert.rejects(sources.execute('observe_shared_browser', {}, signal()), /OBSERVATION_LIMIT/);
  } finally { e.close(); }
});

test('browser action records reject unknown versions, fields, forged payload and false receipts', () => {
  const e = setup();
  try {
    const b = browser(e), observation = { key: 'key', fields: [{ ref: '1', label: 'title' }] };
    const id = e.store.admitBrowserAction(e.job.seq, b.grant, observation, '1', 'expected');
    e.store.finishBrowserAction(id, 'expected', { value: 'expected', url: b.grant.url }, true);
    const original = { version: 1, records: e.store.browserActions() };
    assert.ok(validBrowserActions(original));
    for (const mutate of [v => v.version = 2, v => v.extra = true, v => v.records[0].payload.value = 'forged', v => v.records[0].action.reconciliation_verdict = 'NOT_OBSERVED', v => v.records[0].receipt.server_persistence = 'verified']) {
      const copy = structuredClone(original); mutate(copy); assert.equal(validBrowserActions(copy), false);
    }
  } finally { e.close(); }
});

test('browser cleanup failure cannot keep journal and account resources locked', async () => {
  const e = setup(), b = browser(e), released = [];
  const failure = Error('synthetic profile cleanup failed');
  b.close = async () => { throw failure; };
  const service = new ContactService(e.store, { inspect: async () => ({}) }, base);
  service.attachBrowser(b);
  try {
    await assert.rejects(closeContactResources({ service, store: { close() { e.store.close(); released.push('journal'); } },
      account: { async stop() { released.push('account'); throw Error('synthetic secondary cleanup failure'); } },
      accountStore: { close() { released.push('profile'); } } }), error => error === failure);
    assert.deepEqual(released, ['journal', 'account', 'profile']);
    // A real SQLite owner lease is released despite the earlier error.
    const reopened = new ContactStore({ ...options, directory: join(e.root, 'journal') });
    reopened.close();
  } finally { e.close(); }
});

test('explicit host stop after browser input preserves the applied value and its uncertain verification without replay', async () => {
  const e = setup(), b = browser(e); let service, release, applied;
  try {
    e.store.cancel(e.job.seq);
    const reached = new Promise(resolve => { applied = resolve; });
    b.fill = async (_epoch, _obs, _ref, value, admit) => { admit(); b.actual = value; applied(); await new Promise(resolve => { release = resolve; }); return { applied: true }; };
    let calls = 0;
    const model = { chat: async messages => {
      calls++;
      const name = calls === 1 ? 'observe_shared_browser' : 'fill_shared_textbox';
      const args = calls === 1 ? {} : { observation: JSON.parse(messages.at(-1).content).observation, ref: '1', value: '확인 전 적용된 값' };
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, input_tokens: 1, output_tokens: 1 };
    } };
    service = new ContactService(e.store, model, base); service.attachBrowser(b);
    const turn = service.submit(e.device.id, randomUUID(), '제목을 바꿔줘.');
    await reached; service.beginStop(); release(); await service.close();
    assert.equal(b.actual, '확인 전 적용된 값'); assert.equal(calls, 2);
    assert.equal(e.store.turn(turn.seq).state, 'interrupted'); assert.equal(e.store.browserActions()[0].action.state, 'UNCERTAIN');
    e.reopen(); assert.equal(e.store.browserActions()[0].action.state, 'UNCERTAIN');
    assert.equal(e.store.turn(turn.seq).state, 'interrupted'); assert.equal(e.store.claim(), null);
  } finally { release?.(); await service?.close(); e.close(); }
});
