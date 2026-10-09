// Import-only evaluator. The caller owns the selected authorized provider.
// Real public-web observations; synthetic owner preferences and no private accounts.
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {ContactStore,contactRoute} from '../../packages/engine/src/contact-store.mjs';
import {ContactService} from '../../packages/engine/src/contact-service.mjs';
import {ConversationAssistant} from '../../packages/engine/src/conversation.ts';
const noSources={definitions:[],validate:()=>false,verify:async()=>false};
const plain=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='provider_state'?undefined:item));
export async function runPublicResearch({provider,implementation,reportPath,requestLimit=16}){
 if(!Number.isSafeInteger(requestLimit)||requestLimit<1||requestLimit>32)throw Error('EVAL_REQUEST_LIMIT_INVALID');
 const inspected=await provider.inspect(AbortSignal.timeout(20000));
 if(typeof provider.researchPublicWeb!=='function')throw Error('EVAL_WEB_PROVIDER_REQUIRED');
 const runtime=Object.fromEntries(Object.entries(inspected).filter(([key])=>['provider','model','model_digest','billing','display_name'].includes(key)));
 const report={kind:'same_contact_subscription_public_research',implementation,runtime,harness_sha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),started:new Date().toISOString(),fixed_cases:['A01'],variants:2,request_limit:requestLimit,model_requests:[],results:[],product_acceptance:'not_passed'};
 const save=()=>writeFileSync(reportPath,JSON.stringify(plain(report),null,2)+'\n',{mode:0o600});
 for(const variant of [
  {company:'Microsoft',history:'Microsoft를 장기 투자 관점에서 검토 중이야. 단기 주가 전망보다 이익과 현금흐름, AI 투자 부담, 현재 가격이 이미 기대를 얼마나 반영하는지가 중요해. 매수 주문을 내리는 건 아니고, 공개 자료를 보고 판단할 근거가 필요해.',ask:'그 회사 투자할 만한지 알아봐.'},
  {company:'Costco',history:'Costco가 분석 대상이야. 회원제 사업의 지속성과 수익성, 밸류에이션 부담을 중심으로 판단하고 싶어. 좋은 회사여도 현재 가격이 과하면 기다릴 수 있어. 거래나 계좌 조회는 하지 마.',ask:'아까 이야기한 회사, 지금 검토할 가치가 있는지 근거를 찾아 판단해줘.'},
 ]){
  const root=mkdtempSync(join(tmpdir(), 'tada-public-research-eval-'));let store,service;
  const result={company:variant.company,history:variant.history,utterance:variant.ask,turns:[],errors:[],status:'needs_semantic_review'};report.results.push(result);save();
  try{
   store=new ContactStore({directory:root+'/journal',passphrase:randomBytes(32).toString('base64url'),route:contactRoute({fixture:variant.company}),initialize:true,assistance:true});const device=store.addDevice('Synthetic owner').id;
   store.configureContinuingUse(device,true,'continuing_conversation_24h_v1');
   const seed=store.submit(device,randomUUID(),variant.history).seq;store.claim();const checkpoint=new ConversationAssistant({},noSources).checkpoint();checkpoint.history=[{role:'user',content:variant.history},{role:'assistant',content:'이 회사와 기준으로 살펴보겠습니다.'}];store.finish(seed,{text:'이 회사와 기준으로 살펴보겠습니다.',sources:[]},checkpoint);
   const record=(kind,input)=>{if(report.model_requests.length>=requestLimit)throw Error('EVAL_REQUEST_LIMIT');const item={company:variant.company,kind,input:plain(input),observed:false};report.model_requests.push(item);save();return item;};
   const model={identity:provider.identity,contextLimitBytes:provider.contextLimitBytes,contextBytes:(...args)=>provider.contextBytes(...args),chat:async(messages,tools,signal,beforeDispatch)=>{
    const item=record('conversation',{messages,offered:tools.map(t=>t.function.name)});const response=await provider.chat(messages,tools,signal,beforeDispatch);item.observed=true;item.response=plain(response);save();return response;
   },researchPublicWeb:async(request,previous,signal,beforeDispatch)=>{
    const item=record('public_web',{request,previous});
    try { const response=await provider.researchPublicWeb(request,previous,signal,beforeDispatch);item.observed=true;item.response=plain(response);save();return response; }
    catch(error){item.error=/^[A-Z_]+$/u.test(error?.message)?error.message:'EVAL_PROVIDER_FAILED';if(/^RESEARCH_[A-Z_]+$/u.test(error?.reason))item.reason=error.reason;item.usage_observed=!!error?.observedUsage;save();throw error;}
   }};
   service=new ContactService(store,model,noSources,{timezone:'Asia/Seoul'});service.on('turn-failed',failure=>result.errors.push(failure));
   result.execution_profile={provider:service.providerStatus.provider,local_reviews:service.localReviews};
   if(result.execution_profile.provider!==runtime.provider||service.localReviews!==(runtime.provider==='ollama-local'))throw Error('EVAL_PROVIDER_PROFILE_MISMATCH');
   service.submit(device,randomUUID(),variant.ask);await service.idle();const answer=store.turn(seed+1);result.turns.push(plain(answer));save();
   if(answer.state==='answered'&&answer.answer?.verification==='provider_web_report_checked'){
    service.submit(device,randomUUID(),'방금 조사한 근거만 써서 결론과 판단을 바꿀 조건을 세 줄로 줄여줘. 새 검색이나 거래는 하지 마.');await service.idle();result.turns.push(plain(store.turn(seed+2)));
   }
   result.usage=store.usage();result.mechanical_checks={answered:answer.state==='answered',web_report_cited:answer.answer?.verification==='provider_web_report_checked',real_web_observed:report.model_requests.some(r=>r.company===variant.company&&r.kind==='public_web'&&r.response?.report.searches>0),unknown_requests:store.usage().unknown_requests===0};save();
  }finally{await service?.close();store?.close();rmSync(root,{recursive:true,force:true});report.finished=new Date().toISOString();save();}
 }
 return report;
}
