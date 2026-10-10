import { SECRET_FILE_PATTERN } from './browser-file-actions.mjs';
// Fixed isolated-world operations. No JavaScript, path or fetch URL is supplied
// by the model. References come only from the current shared-page observation.
export const fileCapture = `
  const shareableFile = (e,f) => visible(e) && !e.matches(':disabled') && !e.closest('[inert]') && safeMeaning(e) && f.size<=32768 && !f.name.startsWith('.') && !/${SECRET_FILE_PATTERN}/i.test(f.name) && /\\.(txt|csv|tsv|json|md|log)$/i.test(f.name);
  const fileEntries = filesAllowed ? controls.filter(e=>e.type==='file' && e.files.length===1 && shareableFile(e,e.files[0])).slice(0,20).map((e,i)=>({e,form:e.form,file:e.files[0],ref:'file-'+(i+1),signature:signature(e)})) : [];
  const sameOrigin = href => { try { const u=new URL(href);return u.origin===location.origin && !u.username && !u.password && ['http:','https:'].includes(u.protocol); } catch { return false; } };
  // File sharing is not a general button-click grant. Ambiguous labels and
  // known contact/payment/account operations get no submit reference.
  const safePurpose = value => {
    let text=String(value);
    // DOM URL properties percent-encode non-ASCII paths. Nested escapes must
    // not hide a known excluded destination either; unknown encodings fail closed.
    for(let depth=0;depth<5;depth++) {
      if(/send|invit|publish|payment|purchase|checkout|billing|subscribe|delete|remove|log[\\s_-]*(?:in|out)|sign[\\s_-]*(?:in|out)|account|password|발송|보내|전송|초대|공개|게시|결제|구매|구독|삭제|로그인|로그아웃|계정|비밀번호/i.test(text))return false;
      let decoded;try{decoded=decodeURIComponent(text);}catch{return false;}
      if(decoded===text)return true;text=decoded;
    }
    return false;
  };
  const filePurpose = (e,form) => {
    const title=(renderedText(e)||e.getAttribute('aria-label')||e.value||'').trim();
    const meaning=[title,e.title,e.name,e.id,e.value,e.getAttribute('aria-label'),aria(e,false),e.hasAttribute('formaction')?e.formAction:form?.action].join(' ');
    return /^(?:(?:파일|명단|자료|문서|목록|csv|json|text|file|document|data|list)\\s*)?(?:가져오기|업로드|열기|import|upload|open)(?:\\s+(?:file|document|data|list|csv|json|text))?$/i.test(title)
      && safePurpose(meaning);
  };
  // Only file payloads and standard anti-CSRF fields may be submitted.
  // Other hidden/visible named controls can encode actions or recipients.
  const fileForm = form => !form || sameOrigin(form.action) && ['', '_self'].includes(form.target)
    && safePurpose(form.action) && [...form.elements].every(c=>{
    // Unknown form-associated elements can submit values without a .name property.
    if(!['INPUT','SELECT','TEXTAREA','BUTTON','FIELDSET','OUTPUT'].includes(c.tagName))return false;
    if(['FIELDSET','OUTPUT'].includes(c.tagName))return true;
    const csrf=c.type==='hidden' && /^(?:_?csrf(?:_token)?|authenticity_token|__RequestVerificationToken)$/i.test(c.name);
    if(c.type==='password' || !csrf && !safeMeaning(c))return false;
    if(c.type==='file')return c.files.length===0 || c.files.length===1 && shareableFile(c,c.files[0]);
    if(!c.name || c.matches(':disabled') || ['button','submit','reset','image'].includes(c.type) || ['checkbox','radio'].includes(c.type)&&!c.checked)return true;
    return c.type==='hidden' && /^(?:_?csrf(?:_token)?|authenticity_token|__RequestVerificationToken)$/i.test(c.name);
  });
  const submitAllowed = (e,form) => e && e.isConnected && e.form===form && visible(e) && !e.matches(':disabled') && !e.closest('[inert]') && safeMeaning(e) && e.type==='submit' && form && fileForm(form) && filePurpose(e,form) && (e.hasAttribute('formmethod')?e.formMethod:form.method).toLowerCase()==='post' && sameOrigin(e.hasAttribute('formaction')?e.formAction:form.action) && ['', '_self'].includes(e.hasAttribute('formtarget')?e.formTarget:form.target) && ![...form.elements].some(c=>c.type==='password' || c.type!=='hidden' && c.type!=='file' && !safeMeaning(c));
  const fileStates = filesAllowed ? controls.filter(e=>e.type==='file').map(e=>({e,files:[...e.files]})) : [];
  const submitters = filesAllowed ? [...document.querySelectorAll('button,input[type=submit]')].filter(e=>fileEntries.some(f=>submitAllowed(e,f.form))).slice(0,20).map((e,i)=>({e,form:e.form,ref:'submit-'+(i+1),signature:signature(e),value:e.value,text:renderedText(e),action:e.hasAttribute('formaction')?e.formAction:e.form.action,method:e.hasAttribute('formmethod')?e.formMethod:e.form.method,target:e.hasAttribute('formtarget')?e.formTarget:e.form.target})) : [];
  // Keep all pre-existing link destinations private, including hidden and
  // beyond-display-limit anchors. Visibility or DOM recreation is not a new result.
  const downloadURLs = filesAllowed ? [...new Set([...document.querySelectorAll('a[href]')].filter(e=>sameOrigin(e.href)).map(e=>{const u=new URL(e.href);u.hash='';return u.href;}))] : [];
  const safeDownload=e=>e.isConnected && visible(e) && sameOrigin(e.href) && safeMeaning(e) && safePurpose([e.href,e.title,renderedText(e),e.download,e.getAttribute('aria-label'),aria(e,false)].join(' '));
  const links = filesAllowed ? [...document.querySelectorAll('a[download]')].filter(safeDownload).slice(0,20).map((e,i)=>({e,href:e.href,ref:'download-'+(i+1),label:renderedText(e).slice(0,300),name:e.download.slice(0,200)})) : [];
`;
export const fileSnapshot = `
  const saved=globalThis[key];
  saved.fileEntries=fileEntries; saved.fileStates=fileStates; saved.links=links; saved.downloadURLs=downloadURLs; saved.submitters=submitters; saved.submitAllowed=submitAllowed; saved.fileForm=fileForm; saved.safeDownload=safeDownload;
  saved.current=()=> {
    try { return globalThis[key]===saved && saved.document===document && saved.markup===saved.markupOf() && document.baseURI===saved.baseURI && location.href===saved.url && document.title===saved.title && (document.body?.innerText||'')===saved.body && saved.renderedText(document.body)===saved.text && saved.collect().length===saved.states.length && saved.collect().every((e,i)=>e===saved.states[i].e) && saved.states.every(x=>x.e.isConnected&&x.e.form===x.form&&saved.controlState(x.e)===x.state) && fileStates.every(x=>x.e.files.length===x.files.length && x.files.every((f,i)=>x.e.files[i]===f)) && fileEntries.every(x=>x.e.isConnected && x.e.form===x.form && x.e.files.length===1 && x.e.files[0]===x.file && saved.signature(x.e)===x.signature); } catch { return false; }
  };
`;
export const filePublic = `...(filesAllowed ? { files:fileEntries.map(x=>({ref:x.ref,label:label(x.e),name:x.file.name,replaceable:fileForm(x.form),size:x.file.size,type:x.file.type,submitters:submitters.filter(b=>b.form===x.form).map(b=>({ref:b.ref,label:(renderedText(b.e)||b.e.value||b.e.getAttribute('aria-label')||'').slice(0,300)}))})), downloads:links.map(x=>({ref:x.ref,label:x.label,name:x.name})) } : {})`;
export const readSelectedFile = `async function(key,ref) {
  const s=globalThis[key], item=s?.fileEntries.find(x=>x.ref===ref);
  if(!item || !s.current())throw Error('TARGET_CHANGED');
  const bytes=new Uint8Array(await item.file.arrayBuffer());
  if(bytes.length>32768 || !s.current())throw Error('TARGET_CHANGED');
  let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
  return {name:item.file.name,type:item.file.type,data:btoa(binary)};
}`;
export const replaceSelectedFile = `async function(key,ref,original,replacement,submitRef,resultKey) {
  const s=globalThis[key], item=s?.fileEntries.find(x=>x.ref===ref), button=submitRef===null?null:s?.submitters.find(x=>x.ref===submitRef&&x.form===item?.form);
  const validButton=()=>!button || s.submitAllowed(button.e,button.form) && s.signature(button.e)===button.signature && button.e.value===button.value && s.renderedText(button.e)===button.text && (button.e.hasAttribute('formaction')?button.e.formAction:button.form.action)===button.action && (button.e.hasAttribute('formmethod')?button.e.formMethod:button.form.method)===button.method && (button.e.hasAttribute('formtarget')?button.e.formTarget:button.form.target)===button.target;
  if(item && !s.fileForm(item.form))return {applied:false,reason:'file_scope'};
  if(!item || submitRef!==null&&!button || !s.current() || !validButton())return {applied:false,reason:'target_changed'};
  let bytes;try{bytes=new Uint8Array(await item.file.arrayBuffer());}catch{return {applied:false,reason:'file_unavailable'};}let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
  if(btoa(binary)!==original.data || item.file.name!==original.name || item.file.type!==original.type || !s.current() || !validButton())return {applied:false,reason:'target_changed'};
  const next=Uint8Array.from(atob(replacement.data),c=>c.charCodeAt(0));
  if(next.length>32768)throw Error('FILE_TOO_LARGE');
  const file=new File([next],replacement.name,{type:replacement.type}), transfer=new DataTransfer();transfer.items.add(file);
  delete globalThis[key];
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set.call(item.e,transfer.files);
  const appliedState=s.controlState(item.e);
  const stable=()=>{try{return s.markupOf()===s.markup && document.title===s.title && (document.body?.innerText||'')===s.body && s.renderedText(document.body)===s.text && document===s.document && location.href===s.url && document.baseURI===s.baseURI && item.e.isConnected && item.e.form===item.form && item.e.files.length===1 && item.e.files[0]===file && s.signature(item.e)===item.signature && s.controlState(item.e)===appliedState && s.fileForm(item.form) && s.collect().length===s.states.length && s.collect().every((e,i)=>e===s.states[i].e) && s.states.every(x=>x.e===item.e || x.e.isConnected && x.e.form===x.form && s.controlState(x.e)===x.state) && s.fileStates.every(x=>x.e===item.e || x.e.files.length===x.files.length && x.files.every((f,i)=>x.e.files[i]===f)) && validButton();}catch{return false;}};
  item.e.dispatchEvent(new Event('input',{bubbles:true}));
  if(!stable())return {applied:true,submitted:false,reason:'target_changed'};
  item.e.dispatchEvent(new Event('change',{bubbles:true}));
  let submitted=false,reason=button?'target_changed':null;
  if(button && stable()) {
    let invalid=false;
    const onSubmit=event=>{if(event.isTrusted && event.target===item.form && event.submitter===button.e)submitted=true;};
    const onInvalid=event=>{if(event.isTrusted)invalid=true;};
    item.form.addEventListener('submit',onSubmit,true);item.form.addEventListener('invalid',onInvalid,true);
    try { HTMLFormElement.prototype.requestSubmit.call(item.form,button.e); }
    finally { item.form.removeEventListener('submit',onSubmit,true);item.form.removeEventListener('invalid',onInvalid,true); }
    reason=submitted?null:invalid?'form_validation':'submission_not_observed';
  }
  if(submitRef===null || submitted)globalThis[resultKey]={document,url:location.href,field:item.e,file,downloadURLs:s.downloadURLs};
  return {applied:true,submitted,reason,...(submitRef===null || submitted ? {result_key:resultKey} : {})};
}`;
export const readDownload = `async function(key,ref,resultKey) {
  const effect=globalThis[resultKey];
  const networkURL=href=>{const u=new URL(href);u.hash='';return u.href;};
  const s=globalThis[key], link=s?.links.find(x=>x.ref===ref);
  if(!link || !s.current() || !s.safeDownload(link.e) || link.e.href!==link.href)throw Error('TARGET_CHANGED');
  if(!effect || effect.document!==document || effect.url!==location.href || !effect.field.isConnected || effect.field.files.length!==1 || effect.field.files[0]!==effect.file || effect.downloadURLs.includes(networkURL(link.href)))throw Error('RESULT_NOT_BOUND');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),7000);
  try {
    const network=new URL(link.href);network.hash='';
    const response=await fetch(network.href,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal:abort.signal});
    if(!response.ok || response.url!==network.href || Number(response.headers.get('content-length')||0)>32768 || !response.body)throw Error('DOWNLOAD_UNAVAILABLE');
    const reader=response.body.getReader();let binary='',count=0;
    while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>32768){await reader.cancel();throw Error('FILE_TOO_LARGE');}for(const b of value)binary+=String.fromCharCode(b);}
    if(!s.current() || link.e.href!==link.href)throw Error('TARGET_CHANGED');
    return {data:btoa(binary)};
  } finally {clearTimeout(timer);}
}`;
