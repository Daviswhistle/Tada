import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract, parseContract } from '../src/index.mjs';

const cases = JSON.parse(readFileSync(new URL('../../../fixtures/contracts/v1/cases.json', import.meta.url), 'utf8'));
for (const c of cases) {
  test(c.name, () => {
    const before = structuredClone(c.instance);
    const result = validateContract(c.contract, c.instance);
    assert.equal(result.valid, c.valid, `${c.name}: ${result.errors.join(', ')}`);
    assert.deepEqual(c.instance, before, 'validation must not coerce, remove fields, or fill defaults');
    assert(!JSON.stringify(result).includes('DO_NOT_LOG_THIS_SECRET'));
    if (c.valid) assert.deepEqual(parseContract(c.contract, c.instance), c.instance);
    else assert.throws(() => parseContract(c.contract, c.instance));
  });
}
test('unknown contract names fail closed', () => {
  assert.equal(validateContract('Unknown', {}).valid, false);
});
