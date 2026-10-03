import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateModel } from './generate-model-contracts.mjs';
const schema=JSON.parse(readFileSync(new URL('../packages/contracts/schema/model.v1.json',import.meta.url),'utf8'));
test('model generation is deterministic and matches both committed languages',()=>{
  assert.deepEqual(generateModel(),generateModel());
  for(const [path,content] of generateModel())assert.equal(readFileSync(new URL('../'+path,import.meta.url),'utf8'),content);
});
test('model generator rejects open objects nonlocal refs and unsupported schema vocabulary',()=>{
  for(const change of [
    (s)=>{s.$defs.ModelTextDelta.additionalProperties=true;},
    (s)=>{s.$defs.ModelTextDelta.properties.request_id.$ref='https://example.invalid/schema';},
    (s)=>{s.$defs.ModelTextDelta.properties.value.format='uri';},
    (s)=>{s.$defs.ModelTextDelta.required.push('invented');},
    (s)=>{s.$defs.ModelEvent.oneOf=[{type:'string'},{type:'integer'}];},
  ]){const bad=structuredClone(schema);change(bad);assert.throws(()=>generateModel(bad));}
});
test('Rust raw type identifier does not alter model event wire spelling',()=>{
  const rust=generateModel().get('crates/contracts/src/model.rs');
  assert.ok(rust.includes('pub r#type: String'));assert.ok(!rust.includes('pub type:'));
});
