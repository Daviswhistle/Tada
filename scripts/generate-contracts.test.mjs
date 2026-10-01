import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generate, lint } from './generate-contracts.mjs';
import { isActionTransitionAllowed } from '../packages/contracts/src/generated/action-transitions.mjs';

test('generation is deterministic and checked-in outputs match', () => {
  assert.deepEqual(generate(), generate());
  for (const [path, content] of generate()) assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), content);
});
test('unsupported schema vocabulary and external references fail closed', () => {
  assert.throws(() => lint({ type: 'string', imaginaryValidation: true }));
  assert.throws(() => lint({ $ref: 'https://attacker.example/schema' }));
  assert.throws(() => lint({ $ref: '#/$defs/DoesNotExist' }));
});
test('dispatch must follow preparation, never uncertainty or verification', () => {
  assert.equal(isActionTransitionAllowed('PREPARED', 'DISPATCHING'), true);
  for (const state of ['PROPOSED', 'AUTHORIZED', 'UNCERTAIN', 'VERIFIED', 'COMPENSATED', 'REJECTED']) {
    assert.equal(isActionTransitionAllowed(state, 'DISPATCHING'), false);
  }
  assert.equal(isActionTransitionAllowed('__proto__', 'DISPATCHING'), false);
  assert.equal(isActionTransitionAllowed('FAILED', 'AUTHORIZED'), true);
});
test('user supplied design source remains byte-identical', () => {
  const source = readFileSync(new URL('../docs/design/source-2026-09-30.md', import.meta.url));
  const expected = readFileSync(new URL('../docs/design/source.sha256', import.meta.url), 'utf8').split(' ')[0];
  assert.equal(createHash('sha256').update(source).digest('hex'), expected);
  assert.equal(expected, 'adef0d1d29fd69bee443e5b2d91a9852252ac39fa3fff1af061d704464885e4b');
});
