import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { superviseWindow } from '../src/windows-control.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('initial .NET UTF-8 preamble admits the first open across any chunk boundary', async () => {
  const bytes = Buffer.from('\ufeffTADA_OPEN_V1\r\n');
  for (let split = 0; split <= bytes.length; split++) {
    const input = new PassThrough(); let opened = 0;
    superviseWindow(input, { open: () => { opened++; }, stop() {}, failed: () => assert.fail('unexpected failure') });
    input.write(bytes.subarray(0, split)); input.write(bytes.subarray(split));
    await tick(); assert.equal(opened, 1);
    input.write(bytes); await tick(); assert.equal(opened, 1, 'later BOM is not accepted'); input.end();
  }
});
test('partial, repeated or misplaced preambles do not authorize a command', async () => {
  for (const prefix of [[0xef], [0xef, 0xbb], [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], [0x78, 0xef, 0xbb, 0xbf]]) {
    const input = new PassThrough(); let opened = 0;
    superviseWindow(input, { open: () => { opened++; }, stop() {}, failed() {} });
    input.write(Buffer.concat([Buffer.from(prefix), Buffer.from('TADA_OPEN_V1\n')]));
    await tick(); assert.equal(opened, 0);
    input.write(Buffer.from('TADA_OPEN_V1\n')); await tick(); assert.equal(opened, 1); input.end();
  }
});
test('only a bounded complete parent command opens; repeated clicks coalesce and EOF closes once', async () => {
  const input = new PassThrough(); let opens = 0, stops = 0, release;
  superviseWindow(input, { open: async () => { opens++; await new Promise(resolve => { release = resolve; }); }, stop: () => { stops++; }, failed: () => assert.fail('unexpected failure') });
  input.write(Buffer.from('TADA_')); input.write(Buffer.from('OPEN_V1\r\nTADA_OPEN_V1\n'));
  await tick(); assert.equal(opens, 1);
  input.write(Buffer.from('x'.repeat(100000) + '\nTA\rDA_OPEN_V1\ninvalid\n'));
  release(); await tick(); assert.equal(opens, 1);
  input.end(); await tick(); assert.equal(stops, 1);
  input.emit('error', Error('already closed')); assert.equal(stops, 1);
});
test('quit wins over a pending open and an open failure remains private fixed status', async () => {
  let stops = 0, opens = 0, failures = 0;
  const first = new PassThrough();
  superviseWindow(first, { open: () => { opens++; }, stop: () => { stops++; }, failed: () => { failures++; } });
  first.write(Buffer.from('TADA_OPEN_V1\n')); first.emit('end'); await tick(); assert.equal(opens, 0); assert.equal(stops, 1);
  const second = new PassThrough();
  superviseWindow(second, { open: async () => { throw Error('private URL not forwarded'); }, stop: () => {}, failed: () => { failures++; } });
  second.write(Buffer.from('TADA_OPEN_V1\n')); await tick(); assert.equal(failures, 1); second.end();
});
