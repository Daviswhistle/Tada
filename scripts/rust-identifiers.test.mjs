import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, rustFieldName } from './generate-contracts.mjs';

test('Rust keyword fields use raw identifiers without changing wire keys', () => {
  for (const key of ['ref', 'type', 'match', 'async', 'await', 'dyn', 'gen', 'try', 'yield']) {
    assert.equal(rustFieldName(key), `r#${key}`);
  }
  for (const key of ['reference', 'ref_', 'task_id', 'safe', 'raw', 'union']) {
    assert.equal(rustFieldName(key), key);
  }
});

test('invalid or unrepresentable field names fail generation explicitly', () => {
  for (const key of ['self', 'super', 'crate', 'Self', '_', 'r#ref', 'some-name', '1name']) {
    assert.throws(() => rustFieldName(key));
  }
});

test('InputSnapshot generation fixes the compile failure, not the JSON contract', () => {
  const output = generate();
  const rust = output.get('crates/contracts/src/generated.rs');
  const typescript = output.get('packages/contracts/src/generated/types.ts');
  assert.match(rust, /pub struct InputSnapshot \{\n    pub r#ref: NonEmptyString,/);
  assert.doesNotMatch(rust, /pub ref:/);
  assert.match(typescript, /export interface InputSnapshot \{\n  ref: NonEmptyString;/);
  assert.doesNotMatch(typescript, /r#ref/);
});
