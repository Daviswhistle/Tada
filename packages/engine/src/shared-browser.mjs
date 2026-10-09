// Only a browser child started here is controllable. No profile import, port
// discovery, arbitrary model JavaScript, shell commands or sandbox bypass.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const BROWSER_CONSENT = 'shared_browser_text_input_v1';
export function browserURL(value) {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && value.length <= 4096 ? u : null;
  }
  catch {
    return null;
  }
}
const visible = `e => {
  if (!e.isConnected || !e.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true})) return false;
  const obscured = style => style.clipPath!=='none' || style.clip!=='auto' || style.maskImage!=='none' || style.filter.includes('url(') || style.filter.split('opacity(').slice(1).some(part=>parseFloat(part)===0);
  const own=getComputedStyle(e), rect=e.getBoundingClientRect();
  if (obscured(own)) return false;
  if (rect.width<=0 || rect.height<=0 || parseFloat(own.width)===0 || parseFloat(own.height)===0) return false;
  let left=rect.left,right=rect.right,top=rect.top,bottom=rect.bottom;
  for (let p=e.parentElement;p;p=p.parentElement) {
    const style=getComputedStyle(p), area=p.getBoundingClientRect();
    if (obscured(style)) return false;
    if (['hidden','clip'].includes(style.overflowX)) { left=Math.max(left,area.left);right=Math.min(right,area.right); }
    if (['hidden','clip'].includes(style.overflowY)) { top=Math.max(top,area.top);bottom=Math.min(bottom,area.bottom); }
    if(right<=left || bottom<=top)return false;
  }
  return true;
}`;
// Executed in an isolated world: page code cannot replace these DOM prototypes
// or read the host's element references. The DOM itself remains untrusted data.
const capture = `function(key, previous) {
  if(previous)delete globalThis[previous];
  const visible = ${visible};
  // Structural metadata can change the destination without changing visible
  // text. Compare a bounded private DOM snapshot, never returned to the model.
  const markupOf = () => {
    const walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_ALL), ids=new Map(), rows=[];
    let node=walker.currentNode, chars=0, attributes=0;
    const bounded = value => { chars+=value.length;if(chars>524288)throw Error('PAGE_TOO_LARGE');return value; };
    do {
      if(rows.length>=10000)throw Error('PAGE_TOO_LARGE');
      const attrs=[];
      if(node.attributes)for(const attr of node.attributes) {
        if(++attributes>20000)throw Error('PAGE_TOO_LARGE');
        attrs.push([bounded(attr.name),bounded(attr.value)]);
      }
      rows.push([node.nodeType,bounded(node.nodeName),bounded(node.namespaceURI || ''),ids.get(node.parentNode) ?? -1,bounded(node.nodeValue || ''),attrs]);
      ids.set(node,rows.length);
    } while((node=walker.nextNode()));
    return JSON.stringify(rows);
  };
  const markup=markupOf(), baseURI=document.baseURI;
  // Only rendered text crosses into model context. Control values are handled
  // separately, so a credential textarea cannot leak through its text node.
  const renderedText = (root, visibleOnly=true) => {
    if(!root)return '';
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT), parts=[];
    let node,count=0,length=0;
    while((node=walker.nextNode())) {
      if(++count>10000)throw Error('PAGE_TOO_LARGE');
      const parent=node.parentElement;
      if(!parent || parent.closest('input,textarea,select,script,style,noscript,template') || visibleOnly && !visible(parent))continue;
      const text=node.textContent.trim();
      if(!text)continue;
      length+=text.length;if(length>100000)throw Error('PAGE_TOO_LARGE');
      parts.push(text);
    }
    return parts.join('\\n');
  };
  const labels = (e,visibleOnly=true) => [...(e.labels || [])].map(l=>renderedText(l,visibleOnly)).join(' ');
  const aria = (e,visibleOnly=true) => (e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id=>renderedText(document.getElementById(id),visibleOnly)).join(' ');
  const label = e => (labels(e) || e.getAttribute('aria-label') || aria(e) || e.placeholder || e.name || '').slice(0,300);
  const safe = e => {
    const meaning=[e.autocomplete,e.name,e.id,e.getAttribute('aria-label'),aria(e,false),e.placeholder,labels(e,false)].join(' ');
    return !['password','hidden','file'].includes(e.type) && meaning.length<=4096 && !/password|passphrase|one-time-code|cc-|secret|token|credential|api[\\s_-]*key|(?:verification|security|authentication|auth|access|recovery|backup)[\\s_-]*code|one[\\s_-]*time|(?:^|[^a-z])(?:otp|pin|cvv|cvc|2fa|mfa)(?:$|[^a-z])|card[\\s_-]*(?:number|verification)|비밀번호|인증[\\s_-]*(?:코드|번호)|보안[\\s_-]*(?:키|코드|번호)|일회용|카드[\\s_-]*번호/i.test(meaning) && (e.tagName==='SELECT' || !/username/i.test(meaning));
  };
  const eligible = e => safe(e) && visible(e) && !e.matches(':disabled') && !e.closest('[inert]') && !e.readOnly && (e.tagName === 'TEXTAREA' || e.tagName === 'INPUT' && ['text','search'].includes(e.type));
  const signature = e => JSON.stringify([e.tagName,e.type,e.name,e.id,e.getAttribute('aria-label'),label(e),e.getAttribute('form'),e.form?.action,e.form?.method,e.autocomplete,e.maxLength,e.disabled,e.readOnly]);
  const collect = () => [...document.querySelectorAll('input,textarea,select')];
  const controls = collect();
  if(controls.length>200 || controls.some(e=>e.value.length>8000))throw Error('PAGE_TOO_LARGE');
  // Private preconditions stay in this isolated page world; excluded control
  // values are never returned to the host/model or persisted in its journal.
  const controlState = e => JSON.stringify([e.tagName,e.type,e.name,e.id,e.value,e.checked,e.disabled,e.readOnly,e.multiple,visible(e),e.tagName==='SELECT'?[...e.options].map(o=>[o.value,o.label,o.selected]):null]);
  const states = controls.map(e=>({e,form:e.form,state:controlState(e)}));
  const publicControls=controls.filter(e=>safe(e)&&visible(e));
  const all = publicControls.filter(eligible);
  const entries = all.slice(0,40).map((e,i)=>({ e, form:e.form, ref: String(i+1), value: e.value, signature: signature(e), surrounding: (e.form || e.parentElement)?.innerText ?? '' }));
  if (entries.some(x=>x.value.length>8000 || x.surrounding.length>100000)) throw Error('PAGE_TOO_LARGE');
  if ((document.body?.innerText || '').length > 100000) throw Error('PAGE_TOO_LARGE');
  const text=renderedText(document.body);
  globalThis[key] = { document, markup, markupOf, baseURI, url: location.href, title: document.title, body: document.body?.innerText || '', text, renderedText, entries, eligible, signature, states, controlState, collect };
  return { url: location.href, title: document.title.slice(0,300), text: text.slice(0,12000), truncated: text.length>12000 || all.length>40 || publicControls.filter(e=>!eligible(e)).length>40, fields: entries.map(x=>({ ref:x.ref, label:label(x.e), value:x.value.slice(0,2000), truncated:x.value.length>2000, type:x.e.tagName.toLowerCase(),max_length:x.e.maxLength<0?null:x.e.maxLength })), context_fields: publicControls.filter(e=>!eligible(e)).slice(0,40).map(e=>({label:label(e),type:e.type,value:e.tagName==='SELECT'?[...e.selectedOptions].map(o=>o.label).join(', ').slice(0,300):['checkbox','radio'].includes(e.type)?e.checked:e.value.slice(0,300)})) };
}`;
const fill = `function(key, ref, value) {
  const s=globalThis[key], item=s?.entries.find(x=>x.ref===ref), e=item?.e;
  try { if(!s || s.markup!==s.markupOf())return { applied:false, reason:'target_changed' }; } catch { return { applied:false, reason:'target_changed' }; }
  if (s.document!==document || document.baseURI!==s.baseURI || location.href!==s.url || document.title!==s.title || (document.body?.innerText || '')!==s.body || s.renderedText(document.body)!==s.text || !e?.isConnected || !s.eligible(e) || s.collect().length!==s.states.length || s.collect().some((node,i)=>node!==s.states[i].e) || s.states.some(x=>!x.e.isConnected || x.e.form!==x.form || s.controlState(x.e)!==x.state) || s.signature(e)!==item.signature || e.value!==item.value || (e.form || e.parentElement)?.innerText!==item.surrounding) return { applied:false, reason:'target_changed' };
  if (e.maxLength>=0 && value.length>e.maxLength) return { applied:false, reason:'field_limit' };
  // Invalidate the observation before events may navigate or mutate the page.
  delete globalThis[key];
  const setter=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;
  setter.call(e,value); e.dispatchEvent(new Event('input',{bubbles:true}));
  // Keep only the exact node for a subsequent, separate read. Never submit.
  globalThis[key]={ document, baseURI:s.baseURI, url:s.url, e, form:item.form, signature:item.signature, signatureOf:s.signature };
  return { applied:true };
}`;
const verify = `function(key) {
  const s=globalThis[key];
  if (!s || s.document!==document || document.baseURI!==s.baseURI || location.href!==s.url || !s.e?.isConnected || s.e.form!==s.form || s.signatureOf(s.e)!==s.signature) return null;
  return { url:location.href, value:s.e.value };
}`;
export class SharedBrowser extends EventEmitter {
  #child; #directory; #pending = new Map(); #seq = 0; #buffer = Buffer.alloc(0);
  #opening; #closing; #reset; #closed = false; #grant = null; #session = null;
  #generation = randomUUID(); #headless; #executable; #env; #context; #targets = new Set();
  #snapshot = null; #worldName = `tada-${randomUUID()}`;
  constructor({ headless = false, executable } = {}) {
    super(); this.#headless = headless; this.#env = { ...process.env };
    if (process.platform === 'linux' && /microsoft/iu.test(release()) && !this.#env.DISPLAY
        && existsSync('/mnt/wslg/.X11-unix/X0') && statSync('/mnt/wslg/.X11-unix/X0').isSocket()) this.#env.DISPLAY = ':0';
    this.#executable = executable ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : ''].find(p => p && existsSync(p));
  }
  get available() { return !!this.#executable; }
  get grant() { return this.#grant ? structuredClone(this.#grant) : null; }
  #fail() {
    this.#generation = randomUUID(); this.#grant = null; this.#session = null; this.#snapshot = null;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.no(Error('CONTACT_BROWSER_DISCONNECTED')); }
    this.#pending.clear(); this.emit('change');
  }
  command(method, params = {}, sessionId, admit = () => {}) {
    return new Promise((yes, no) => {
      if (!this.#child || this.#closed) return no(Error('CONTACT_BROWSER_DISCONNECTED'));
      const id = ++this.#seq;
      const timer = setTimeout(() => { this.#pending.delete(id); no(Error('CONTACT_BROWSER_RESPONSE_UNKNOWN')); }, 10000);
      this.#pending.set(id, { yes, no, timer });
      try {
        admit();
        this.#child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
          const p = this.#pending.get(id);
          if (error && p) { clearTimeout(p.timer); this.#pending.delete(id); p.no(Error('CONTACT_BROWSER_DISCONNECTED')); }
        });
      } catch (error) { clearTimeout(timer); this.#pending.delete(id); no(error); }
    });
  }
  async open() {
    if (this.#closed) throw Error('CONTACT_BROWSER_DISCONNECTED');
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().catch(async error => { await this.#shutdown(); throw error; });
    try { await this.#opening; } finally { this.#opening = null; }
  }
  async #open() {
    if (this.#closing) await this.#closing;
    if (this.#reset) await this.#reset;
    if (this.#closed) throw Error('CONTACT_BROWSER_DISCONNECTED');
    if (!this.available) throw Error('CONTACT_BROWSER_UNAVAILABLE');
    if (!this.#headless && process.platform === 'linux' && !this.#env.DISPLAY && !this.#env.WAYLAND_DISPLAY) throw Error('CONTACT_BROWSER_DISPLAY_UNAVAILABLE');
    if (!this.#child) {
      if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
      this.#directory = await mkdtemp(join(tmpdir(), 'tada-shared-browser-'));
      if (this.#closed) throw Error('CONTACT_BROWSER_DISCONNECTED');
      const child = this.#child = spawn(this.#executable, [...(this.#headless ? ['--headless=new'] : []),
        '--no-first-run', '--no-default-browser-check', '--no-startup-window', '--disable-extensions',
        '--disable-background-networking', '--disable-sync', '--remote-debugging-pipe', `--user-data-dir=${this.#directory}`],
        { env: this.#env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
      const failed = () => { if (this.#child === child) this.#fail(); };
      child.on('error', failed); child.stdio[3].on('error', failed);
      child.on('exit', () => { if (this.#child === child) { this.#fail(); this.#child = null; this.#context = null; this.#targets.clear(); } });
      child.stdio[4].on('data', chunk => {
        if (this.#child !== child) return;
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        if (this.#buffer.length > 4 * 1024 * 1024) { this.#fail(); child.kill('SIGTERM'); return; }
        for (let at; (at = this.#buffer.indexOf(0)) >= 0;) {
          const raw = this.#buffer.subarray(0, at); this.#buffer = this.#buffer.subarray(at + 1);
          let message;
          try { message = JSON.parse(raw.toString()); } catch { this.#fail(); child.kill('SIGTERM'); return; }
          const p = this.#pending.get(message.id);
          if (p) { clearTimeout(p.timer); this.#pending.delete(message.id); message.error ? p.no(Error('CONTACT_BROWSER_COMMAND_FAILED')) : p.yes(message.result); }
          else this.#event(message);
        }
      });
      await this.command('Browser.getVersion');
      await this.command('Target.setDiscoverTargets', { discover: true });
    }
    const { targetInfos } = await this.command('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page' && t.browserContextId === this.#context);
    if (pages.length) { await this.command('Target.activateTarget', { targetId: this.#grant?.target ?? pages[0].targetId }); return; }
    if (this.#context) await this.#endContext();
    if (this.#closed) throw Error('CONTACT_BROWSER_DISCONNECTED');
    this.#context = (await this.command('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
    const { targetId } = await this.command('Target.createTarget', { url: 'about:blank', browserContextId: this.#context, newWindow: true });
    this.#targets.add(targetId); this.emit('change');
  }
  #event(message) {
    const info = message.params?.targetInfo;
    if (['Target.targetCreated','Target.targetInfoChanged'].includes(message.method) && info?.type === 'page' && info.browserContextId === this.#context) this.#targets.add(info.targetId);
    if (message.method === 'Target.targetDestroyed' && this.#targets.delete(message.params.targetId)) {
      if (message.params.targetId === this.#grant?.target) this.unshare();
      if (!this.#targets.size) void this.#endContext();
    }
    if (this.#session && message.sessionId === this.#session.sessionId && (
      message.method === 'Page.frameNavigated' && !message.params.frame.parentId
      || message.method === 'Page.navigatedWithinDocument' && message.params.frameId === this.#session.frame && message.params.url !== this.#grant?.url)) this.unshare();
  }
  #endContext() {
    if (this.#reset) return this.#reset;
    this.unshare(); const context = this.#context; this.#context = null; this.#targets.clear();
    this.#reset = (context ? this.command('Target.disposeBrowserContext', { browserContextId: context }).catch(() => {}) : Promise.resolve())
      .finally(() => { this.#reset = null; this.emit('change'); });
    return this.#reset;
  }
  async tabs() {
    if (!this.#child) return [];
    const { targetInfos } = await this.command('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page' && t.browserContextId === this.#context && browserURL(t.url)).slice(0, 30).map(t => ({ id: t.targetId, title: t.title.slice(0, 300), url: t.url }));
  }
  async share(device, target, consent, expectedURL) {
    if (consent !== BROWSER_CONSENT) throw Error('CONTACT_BROWSER_CONSENT_REQUIRED');
    this.unshare(); const generation = this.#generation;
    const tab = (await this.tabs()).find(t => t.id === target);
    if (!tab || tab.url !== expectedURL) throw Error('CONTACT_BROWSER_TARGET_CHANGED');
    const { sessionId } = await this.command('Target.attachToTarget', { targetId: target, flatten: true });
    try {
      await this.command('Page.enable', {}, sessionId);
      const { frameTree } = await this.command('Page.getFrameTree', {}, sessionId);
      if (frameTree.frame.url !== tab.url || this.#generation !== generation) throw Error('CONTACT_BROWSER_TARGET_CHANGED');
      const { executionContextId } = await this.command('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: this.#worldName, grantUniveralAccess: false }, sessionId);
      if (this.#generation !== generation) throw Error('CONTACT_BROWSER_TARGET_CHANGED');
      this.#session = { sessionId, context: executionContextId, frame: frameTree.frame.id };
      this.#grant = { epoch: randomUUID(), device, target, url: tab.url, origin: new URL(tab.url).origin };
      this.emit('change'); return this.grant;
    } catch (error) {
      await this.command('Target.detachFromTarget', { sessionId }).catch(() => {});
      throw error;
    }
  }
  #forget(snapshot) {
    if (!snapshot) return Promise.resolve();
    return this.command('Runtime.evaluate', { expression: `delete globalThis[${JSON.stringify(snapshot.key)}]`, contextId: snapshot.session.context, returnByValue: true }, snapshot.session.sessionId).catch(() => {});
  }
  async release(epoch) {
    const snapshot = this.#snapshot;
    if (snapshot?.epoch === epoch) { this.#snapshot = null; await this.#forget(snapshot); }
  }
  unshare() {
    const snapshot = this.#snapshot, session = this.#session; this.#snapshot = null;
    this.#generation = randomUUID(); this.#grant = null; this.#session = null;
    void this.#forget(snapshot).then(() => session ? this.command('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {}) : undefined);
    this.emit('change');
  }
  assert(epoch) { if (!this.#grant || this.#grant.epoch !== epoch || !this.#session) throw Error('CONTACT_BROWSER_TARGET_CHANGED'); }
  async #call(fn, args, admit = () => {}) {
    const session = this.#session;
    if (!session) throw Error('CONTACT_BROWSER_NOT_SHARED');
    const result = await this.command('Runtime.callFunctionOn', { functionDeclaration: fn, arguments: args.map(value => ({ value })), executionContextId: session.context, returnByValue: true }, session.sessionId, admit);
    if (result.exceptionDetails) throw Error('CONTACT_BROWSER_OBSERVATION_FAILED');
    return result.result.value;
  }
  async observe(epoch, admit) {
    this.assert(epoch);
    const key = `__tada_${randomUUID().replaceAll('-', '')}`, snapshot = { key, epoch, session: this.#session };
    const prior = this.#snapshot; this.#snapshot = snapshot;
    try {
      const value = await this.#call(capture, [key, prior?.session.context === snapshot.session.context ? prior.key : null], admit);
      this.assert(epoch);
      if (value.url !== this.#grant.url) throw Error('CONTACT_BROWSER_TARGET_CHANGED');
      return { key, ...value };
    } catch (error) { if (this.#snapshot === snapshot) this.#snapshot = null; await this.#forget(snapshot); throw error; }
  }
  async fill(epoch, observation, ref, value, admit) {
    this.assert(epoch); return this.#call(fill, [observation.key, ref, value], () => { this.assert(epoch); admit(); });
  }
  async verify(epoch, observation, admit) { this.assert(epoch); return this.#call(verify, [observation.key], admit); }
  #shutdown() {
    if (this.#closing) return this.#closing;
    const child = this.#child; this.#child = null; this.#context = null; this.#targets.clear(); this.#buffer = Buffer.alloc(0); this.#fail();
    const directory = this.#directory; this.#directory = null;
    this.#closing = (async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
      });
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })().finally(() => { this.#closing = null; });
    return this.#closing;
  }
  async close() { this.#closed = true; this.unshare(); await this.#opening?.catch(() => {}); await this.#shutdown(); }
}
