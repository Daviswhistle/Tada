import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract, parseContract } from '../src/index.mjs';
const rows=JSON.parse(readFileSync(new URL('../../../fixtures/model-events.v1.json',import.meta.url),'utf8'));
assert.equal(rows.length,36,'fixed shared model-wire denominator');
for(const row of rows)test(`model wire: ${row.name}`,()=>{
  assert.equal(validateContract('ModelEvent',row.value).valid,row.valid);
  if(row.valid)assert.deepEqual(parseContract('ModelEvent',row.value),row.value);
});
