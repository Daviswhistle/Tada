import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, validateContract } from '../src/index.mjs';
import { generateWorker } from '../../../scripts/generate-worker-contracts.mjs';

const cases = JSON.parse(readFileSync(new URL('../../../fixtures/worker/v1/cases.json', import.meta.url), 'utf8'));
assert.equal(cases.length, 41, 'fixed worker wire denominator');
for (const fixture of cases) {
  test(fixture.name, () => {
    const checked = validateContract(fixture.contract, fixture.value);
    assert.equal(checked.valid, fixture.valid);
    assert.ok(!JSON.stringify(checked.errors).includes('FAKE_SECRET_CANARY'));
    if (fixture.valid) assert.deepEqual(parseContract(fixture.contract, fixture.value), fixture.value);
    else assert.throws(() => parseContract(fixture.contract, fixture.value));
  });
}
test('worker generation is deterministic and matches committed outputs', () => {
  for (const [path, content] of generateWorker()) {
    assert.equal(content, readFileSync(new URL('../../../' + path, import.meta.url), 'utf8'));
    assert.equal(content, generateWorker().get(path));
  }
});
test('worker generator refuses external references and open objects', () => {
  const source = JSON.parse(readFileSync(new URL('../schema/worker.v1.json', import.meta.url), 'utf8'));
  for (const mutate of [
    s => { s.$defs.WorkerArguments.properties.expected_hash.$ref = 'https://example.invalid/schema'; },
    s => { s.$defs.WorkerArguments.additionalProperties = true; },
    s => { s.$defs.WorkerArguments.properties.expected_hash.custom_keyword = true; },
  ]) {
    const bad = structuredClone(source); mutate(bad);
    assert.throws(() => generateWorker(bad));
  }
});
