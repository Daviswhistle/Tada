import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {runPublicResearch} from '../evals/assistant-v1/public-research-candidate.mjs';
test('public research evaluator uses supplied provider profile and retains evidence without grading its own answers',async()=>{
 const root=mkdtempSync(join(tmpdir(), 'tada-web-eval-test-'));let inspected=false;
 const provider={identity:{provider:'chatgpt-subscription',model:'synthetic-model',billing:'chatgpt-plan',account_label:'ACCOUNT_CANARY'},contextLimitBytes:65536,contextBytes:(m,t)=>Buffer.byteLength(JSON.stringify({m,t})),
 inspect:async()=>{inspected=true;return provider.identity;},
 chat:async(messages,tools,signal,beforeDispatch)=>{
  signal.throwIfAborted();assert.equal(typeof beforeDispatch,'function');beforeDispatch();
  assert.equal(inspected,true);assert.ok(!JSON.stringify(messages).includes('A01'));assert.ok(!JSON.stringify(messages).includes('completion_checks'));
  const last=messages.at(-1),done=last.role==='tool'||last.content.includes('새 검색이나 거래는 하지 마');
  return {message:{role:'assistant',content:done?'자료입니다. [공식](https://example.org/) [S1]':'',tool_calls:done?[]:[{function:{name:'research_public_web',arguments:{}}}]},input_tokens:1,output_tokens:1};
 },researchPublicWeb:async(request,previous,signal,beforeDispatch)=>{signal.throwIfAborted();assert.equal(typeof beforeDispatch,'function');beforeDispatch();assert.equal(inspected,true);assert.equal(previous.messages.length,1);return {report:{searches:1,parts:[{text:'자료',citations:[{url:'https://example.org/',title:'공식',start:0,end:2}]}]},input_tokens:1,output_tokens:1};}};
 try{const report=await runPublicResearch({provider,implementation:'fixture',reportPath:root+'/report.json'});
  assert.equal(report.results.length,2);assert.equal(report.model_requests.length,8);assert.ok(report.results.every(r=>r.status==='needs_semantic_review'&&r.mechanical_checks.answered&&r.execution_profile.local_reviews===false));
  assert.ok(!readFileSync(root+'/report.json','utf8').includes('ACCOUNT_CANARY'));assert.equal(report.product_acceptance,'not_passed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
