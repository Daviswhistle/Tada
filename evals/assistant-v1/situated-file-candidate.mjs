// Fixed synthetic applications, real browser and injected provider. Importing never acquires an account.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { SharedBrowser, BROWSER_FILE_CONSENT } from '../../packages/engine/src/shared-browser.mjs';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';
import { ContactService } from '../../packages/engine/src/contact-service.mjs';
import { ConversationAssistant } from '../../packages/engine/src/conversation.ts';
import { serveContact } from '../../packages/engine/src/contact-http.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='provider_state'?undefined:item));
const base={definitions:[],validate:()=>false,execute:async()=>{throw Error('NO_SOURCE');},verify:async()=>false};
const utterances=['이거 안 돼.','이거 제대로 안 되네. 좀 봐줘.'];
export const situatedFileFixtures=[
  {case:'A02',variant:1,request:utterances[0],name:'참석명단.csv',encoding:'utf16le',original:'\ufeff이름,인원,메모\r\n하람,2,"창가, 조용한 자리"\r\n민지,1,자막 필요\r\n',expected:[['이름','인원','메모'],['하람','2','창가, 조용한 자리'],['민지','1','자막 필요']]},
  {case:'A02',variant:2,request:utterances[1],name:'비품목록.csv',encoding:'utf8',original:'품목;수량;메모\n의자;4;"파랑, 접이식"\n책상;2;"너비 120; 높이 70"\n',expected:[['품목','수량','메모'],['의자','4','파랑, 접이식'],['책상','2','너비 120; 높이 70']]},
  {case:'A03',variant:1,request:utterances[0],title:'작은 모임 진행표',original:'{"제목":"작은 모임 진행표","장소":"동쪽 회의실","시간":"15:30","준비":["자막","물"],}',expected:{제목:'작은 모임 진행표',장소:'동쪽 회의실',시간:'15:30',준비:['자막','물']}},
  {case:'A03',variant:2,request:utterances[1],title:'대여 물품 인수표',original:'```json\n{"제목":"대여 물품 인수표","담당":"유진","물품":[{"이름":"마이크","수량":3},{"이름":"스탠드","수량":2}],"반납":"목요일 16시"}\n```',expected:{제목:'대여 물품 인수표',담당:'유진',물품:[{이름:'마이크',수량:3},{이름:'스탠드',수량:2}],반납:'목요일 16시'}},
];
// Parser validates the receiving application's public CSV contract, independently of fixture values.
export function parseCsv(text) {
  text=text.replace(/^\ufeff/u,'');if(text.includes('\0'))throw Error('CSV_ENCODING');
  const rows=[];let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++) {const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closed)throw Error('CSV_QUOTE');quoted=true;continue;}
    if(c===','||c==='\r'||c==='\n'){row.push(cell);cell='';closed=false;if(c!==','){rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}continue;}
    if(closed)throw Error('CSV_QUOTE');cell+=c;
  }
  if(quoted)throw Error('CSV_QUOTE');if(cell||row.length||closed){row.push(cell);rows.push(row);}
  if(!rows.length||rows[0].length<2||rows.some(r=>r.length!==rows[0].length))throw Error('CSV_COLUMNS');return rows;
}
const style='<style>body{font:18px sans-serif;padding:30px;max-width:850px}label,button,p{display:block;margin:20px 0}td,th{border:1px solid #aaa;padding:8px}pre{white-space:pre-wrap}</style>';
function page(f) {
  if(f.case==='A02')return `<!doctype html><meta charset="utf-8"><title>표 — 명단과 목록 가져오기</title>${style}<h1>표 가져오기</h1><p>UTF-8 인코딩의 쉼표 구분 CSV 파일을 받습니다. 첫 줄은 열 이름이며, 쉼표를 포함하는 값은 큰따옴표로 감쌉니다.</p><form action="/upload" method="post"><label>가져올 CSV 파일<input id="file" name="file" type="file" accept=".csv"></label><button type="submit">파일 가져오기</button></form><p id="status">파일을 선택해 주세요.</p><div id="result"></div><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const file=document.querySelector('#file').files[0];const response=await fetch('/upload',{method:'POST',body:await file.arrayBuffer()});const body=await response.json();document.querySelector('#status').textContent=body.message;if(!response.ok)return;const box=document.querySelector('#result');box.replaceChildren();const table=document.createElement('table');for(const row of body.rows){const tr=document.createElement('tr');for(const value of row){const td=document.createElement('td');td.textContent=value;tr.append(td);}table.append(tr);}box.append(table);const a=document.createElement('a');a.href='/download';a.download='가져온표.csv';a.textContent='가져온 표 내려받기';box.append(a);};</script>`;
  return `<!doctype html><meta charset="utf-8"><title>문서함 — 구조화 문서 보기</title>${style}<h1>구조화 문서 보기</h1><p>JSON 형식의 .json 또는 .txt 문서를 이 창에서 엽니다. 파일을 고르면 내용을 표시합니다. 이 문서함은 파일을 서버로 업로드하지 않습니다.</p><label>열 문서<input id="file" type="file" accept=".json,.txt"></label><p id="status">문서를 선택해 주세요.</p><pre id="document"></pre><script>document.querySelector('#file').onchange=async e=>{const field=e.target;try{const text=await field.files[0].text();const value=JSON.parse(text);document.querySelector('#document').textContent=JSON.stringify(value,null,2);document.querySelector('#status').textContent='문서 열림: '+field.files[0].name;}catch{document.querySelector('#document').textContent='';document.querySelector('#status').textContent='문서를 열지 못했습니다: JSON 문법을 확인해 주세요.';}};</script>`;
}
export async function runSituatedFiles({provider,reportPath,implementation,requestLimit=48}) {
  if(!Number.isSafeInteger(requestLimit)||requestLimit<1||requestLimit>64)throw Error('EVAL_REQUEST_LIMIT_INVALID');
  const inspected=await provider.inspect(AbortSignal.timeout(20000));
  const report={kind:'situated_file_candidate',implementation,runtime:Object.fromEntries(Object.entries(inspected).filter(([k])=>['provider','model','model_digest','billing','display_name'].includes(k))),harness_sha256:sha(readFileSync(new URL(import.meta.url))),fixtures_sha256:sha(JSON.stringify(situatedFileFixtures)),fixture_version:1,started_at:new Date().toISOString(),fixed_cases:['A02','A03'],variants_per_case:2,synthetic_data_only:true,physical_devices:false,production_scope_changed:false,product_acceptance:'not_passed',independent_semantic_review:'required',request_limit:requestLimit,model_requests:[],results:[]};
  const save=()=>writeFileSync(reportPath,JSON.stringify(plain(report),null,2)+'\n',{mode:0o600});
  for(const fixture of situatedFileFixtures) {
    const root=mkdtempSync(join(tmpdir(),'tada-situated-file-'));let browser,store,service,site,host,saved=null,rows=null,attempts=0,postOther=0;
    const result={case:fixture.case,variant:fixture.variant,fixture,calls:[]};report.results.push(result);save();
    try {
      store=new ContactStore({directory:join(root,'journal'),passphrase:randomBytes(32).toString('base64url'),route:contactRoute({fixture:root}),initialize:true,assistance:true});
      const owner=store.addDevice('Synthetic owner').id;store.configureContinuingUse(owner,true,'continuing_conversation_24h_v1');
      const seed=(text,content,title)=>{const seq=store.submit(owner,randomUUID(),text).seq;store.claim();const spec=store.prepareDocument(seq,{title,format:'text',based_on:null});const checkpoint=new ConversationAssistant({},base).checkpoint();checkpoint.history=[{role:'user',content:text},{role:'assistant',content}];store.finish(seq,{text:content,sources:[],verification:'not_applicable'},checkpoint,[],spec);return seq;};
      const other=seed('지난 행사의 보관 기록이야. 그대로 남겨줘.','이미 마친 행사 · 보관 기록','지난 행사');const otherBefore=store.document(other);
      let previous=null,original=Buffer.from(fixture.original,fixture.encoding??'utf8'),path=join(root,fixture.name??'document.txt');
      if(fixture.case==='A03')previous=seed(fixture.title+'를 문서함에서 열 수 있는 JSON 텍스트 문서로 만들어줘.',fixture.original,fixture.title);
      const invoke=async(operation,input,run)=>{
        if(report.model_requests.length>=requestLimit)throw Error('EVAL_REQUEST_LIMIT');
        const attempt={number:report.model_requests.length+1,case:fixture.case,variant:fixture.variant,operation,state:'reserved'};report.model_requests.push(attempt);const call={number:attempt.number,operation,...plain(input)};result.calls.push(call);save();
        try{const response=await run();attempt.state='observed';call.response=plain(operation==='chat'?response.message:response);save();return response;}
        catch(error){const known=[error?.observedUsage?.input_tokens,error?.observedUsage?.output_tokens].every(n=>Number.isSafeInteger(n)&&n>=0);attempt.state=known?'observed_failure':'unknown';call.error=/^[A-Z_]{1,80}$/.test(error?.message)?error.message:'EVAL_PROVIDER_FAILED';save();throw error;}
      };
      const model={identity:provider.identity,chat:(messages,tools,signal,beforeDispatch)=>invoke('chat',{messages,tool_names:tools.map(t=>t.function.name)},()=>provider.chat(messages,tools,signal,beforeDispatch))};
      if(typeof provider.contextBytes==='function')model.contextBytes=(...args)=>provider.contextBytes(...args);if(provider.contextLimitBytes!==undefined)model.contextLimitBytes=provider.contextLimitBytes;
      if(typeof provider.researchPublicWeb==='function')model.researchPublicWeb=(request,previous,signal,beforeDispatch)=>invoke('public_web',{request,previous},()=>provider.researchPublicWeb(request,previous,signal,beforeDispatch));
      service=new ContactService(store,model,base);
      if(previous!==null) {
        const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin=`http://127.0.0.1:${port}`;
        host=await serveContact({store,service,origin,port});const code=new URLSearchParams(new URL(host.pair()).hash.slice(1)).get('pair');
        const paired=await fetch(origin+'/api/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code,name:'Fixture download'})});assert.equal(paired.ok,true);
        const downloaded=await fetch(origin+`/api/documents/${previous}`,{headers:{Cookie:paired.headers.get('set-cookie').split(';')[0]}});assert.equal(downloaded.ok,true);original=Buffer.from(await downloaded.arrayBuffer());
        path=join(root,downloaded.headers.get('content-disposition').match(/filename="([^"]+)"/u)[1]);assert.equal(original.toString('utf8'),fixture.original);
        result.prior_download={status:downloaded.status,name:path.split('/').at(-1),sha256:sha(original)};
      }
      writeFileSync(path,original);result.original_sha256=sha(original);
      site=createServer(async(req,res)=>{
        if(req.method==='POST'&&req.url==='/upload'&&fixture.case==='A02') {attempts++;const chunks=[];for await(const c of req)chunks.push(c);const data=Buffer.concat(chunks);res.setHeader('Content-Type','application/json');
          try {const parsed=parseCsv(new TextDecoder('utf-8',{fatal:true}).decode(data));saved=data;rows=parsed;res.end(JSON.stringify({message:`가져오기 완료: ${parsed.length-1}행`,rows:parsed}));}
          catch{res.statusCode=422;res.end(JSON.stringify({message:'가져오기 실패: UTF-8 인코딩과 쉼표 구분 CSV 형식을 확인해 주세요.'}));}return;
        }
        if(req.method!=='GET'){postOther++;res.writeHead(405);res.end();return;}
        if(req.url==='/download'){res.writeHead(saved?200:404,{'Content-Type':'text/csv'});res.end(saved??'missing');return;}
        res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(page(fixture));
      });await new Promise(r=>site.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${site.address().port}/${fixture.case==='A02'?'import':'documents'}`;
      browser=new SharedBrowser({headless:true});await browser.open();const context=(await browser.command('Target.getBrowserContexts')).browserContextIds[0];
      const target=(await browser.command('Target.createTarget',{url,browserContextId:context})).targetId;const {sessionId}=await browser.command('Target.attachToTarget',{targetId:target,flatten:true});
      const evaluate=async expression=>{const r=await browser.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error('EVAL_PAGE_FAILED');return r.result.value;};
      const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw Error('EVAL_PAGE_TIMEOUT');};
      await until('!!document.querySelector("#file")');const {root:dom}=await browser.command('DOM.getDocument',{},sessionId);const {nodeId}=await browser.command('DOM.querySelector',{nodeId:dom.nodeId,selector:'#file'},sessionId);await browser.command('DOM.setFileInputFiles',{nodeId,files:[path]},sessionId);
      if(fixture.case==='A02')await evaluate('document.querySelector("form").requestSubmit()');
      await until('document.querySelector("#status").textContent.includes("실패")||document.querySelector("#status").textContent.includes("열지 못")');
      result.initial_page=await evaluate('document.body.innerText');assert.equal(saved,null);if(fixture.case==='A02')assert.equal(attempts,1);
      await browser.share(owner,target,BROWSER_FILE_CONSENT,url);service.attachBrowser(browser);
      const accepted=service.submit(owner,randomUUID(),fixture.request);await service.idle();const turn=store.turn(accepted.seq);
      result.state=turn.state;result.error=turn.error;result.answer=turn.answer;result.actions=store.browserActions();result.usage=store.usage();
      result.final_page=await evaluate('({text:document.body.innerText,table:[...document.querySelectorAll("tr")].map(tr=>[...tr.querySelectorAll("td")].map(td=>td.textContent)),document:document.querySelector("#document")?.textContent??null,selected_name:document.querySelector("#file").files[0]?.name})');
      result.received={attempts,other_posts:postOther,rows,sha256:saved?sha(saved):null};
      const observations=result.calls.flatMap(c=>c.messages??[]).filter(m=>m.role==='tool'&&m.tool_name==='observe_shared_browser').map(m=>JSON.parse(m.content));result.observations=[...new Map(observations.map(o=>[o.observation,o])).values()];
      const preserved=result.actions.filter(a=>a.payload?.original).length;result.saved_file_records=preserved;
      const checks={answered:turn.state==='answered',observed_failure:result.observations.some(o=>o.text.includes('실패')||o.text.includes('열지 못')),original_on_disk_preserved:sha(readFileSync(path))===sha(original),original_document_preserved:previous===null||store.document(previous).sha256===sha(fixture.original),unrelated_document_preserved:JSON.stringify(store.document(other))===JSON.stringify(otherBefore),no_unrelated_post:postOther===0,no_unknown_requests:result.usage.unknown_requests===0,no_public_research:report.model_requests.filter(a=>a.case===fixture.case&&a.variant===fixture.variant).every(a=>a.operation==='chat')};
      if(fixture.case==='A02'){checks.one_repair_upload=attempts===2;checks.received_cells_preserved=JSON.stringify(rows)===JSON.stringify(fixture.expected);checks.rendered_cells_preserved=JSON.stringify(result.final_page.table)===JSON.stringify(fixture.expected);checks.result_observed=result.observations.some(o=>o.text.includes('완료:'));}
      else {checks.no_upload=attempts===0;let rendered;try{rendered=JSON.parse(result.final_page.document);}catch{}checks.opened_semantics_preserved=isDeepStrictEqual(rendered,fixture.expected);checks.result_observed=result.observations.some(o=>o.text.includes('문서 열림:'));}
      // Read through the same durable, device-authorized file retrieval used by the UI.
      const copies=result.actions.map(r=>{try{return {original:store.browserFile(owner,r.action.action_id,'original'),replacement:store.browserFile(owner,r.action.action_id,'replacement')};}catch{return null;}}).filter(Boolean);
      checks.stored_original_preserved=copies.some(c=>c.original.sha256===sha(original));checks.one_saved_file_action=preserved===1&&copies.length===1;checks.replacement_saved=copies.some(c=>c.replacement.sha256!==sha(original));
      checks.saved_copy_matches_result=copies.some(c=>{const bytes=Buffer.from(c.replacement.data,'base64');if(fixture.case==='A02')return saved!==null&&sha(bytes)===sha(saved);try{return isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),fixture.expected);}catch{return false;}});
      result.mechanical_checks=checks;result.status=Object.values(checks).every(Boolean)?'needs_semantic_review':'failed';
    }catch(error){result.status='failed';result.error=/^[A-Z_]{1,80}$/.test(error?.message)?error.message:'EVAL_FAILED';result.fixture_error_name=error?.name;}
    finally{await host?.close();await service?.close();await browser?.close();store?.close();if(site)await new Promise(r=>site.close(r));rmSync(root,{recursive:true,force:true});save();}
    console.log(JSON.stringify({case:result.case,variant:result.variant,status:result.status,error:result.error,checks:result.mechanical_checks}));
    if(report.model_requests.some(a=>a.state==='unknown'))break; // Never retry an ambiguous paid/model request.
  }
  report.finished_at=new Date().toISOString();save();return report;
}
