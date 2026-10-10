import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, situatedFileFixtures, runSituatedFiles } from '../evals/assistant-v1/situated-file-candidate.mjs';

test('situated fixtures keep the same vague requests across different application contexts',()=>{
  for(const variant of [1,2])assert.equal(situatedFileFixtures.find(f=>f.case==='A02'&&f.variant===variant).request,situatedFileFixtures.find(f=>f.case==='A03'&&f.variant===variant).request);
  assert.equal(situatedFileFixtures.length,4);
});
test('receiving CSV application parses quotes, separators, newlines and empty cells without dropping values',()=>{
  assert.deepEqual(parseCsv('\ufeffa,b,c\r\n"한,글","세미;콜론","인용 ""문구"""\r\n"여러\n줄",,끝\r\n'),[['a','b','c'],['한,글','세미;콜론','인용 "문구"'],['여러\n줄','','끝']]);
  assert.deepEqual(parseCsv('a,b\nx,""'),[['a','b'],['x','']]);
  for(const invalid of ['a;b\nc;d','a,b\nx','a,b\n"unfinished','a,b\n"x"invalid,y','a,b\nx\0,y'])assert.throws(()=>parseCsv(invalid));
});
for(const requestLimit of [0,-1,65,1.2,'48',NaN,Infinity,null])test(`file evaluation rejects invalid budget ${String(requestLimit)} before provider access`,async()=>{
  let accessed=false;
  await assert.rejects(runSituatedFiles({requestLimit,provider:{inspect(){accessed=true;throw Error('MUST_NOT_ACCESS');}}}),/EVAL_REQUEST_LIMIT_INVALID/);
  assert.equal(accessed,false);
});
