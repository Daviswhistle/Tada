// Explicit development entry point for the pinned Node runtime. No model SDK,
// provider credential, shell execution, database access or network tool exists.
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { parseUniqueJson } from './json.mjs';
import { runDigestSession } from './session.ts';

const MAX = 16384;
const mode = process.argv[2] ?? 'normal';
const input = process.stdin;
const output = process.stdout;
let failed;
input.on('error', () => { failed = new Error('ENGINE_PIPE_FAILED'); });
output.on('error', () => { failed = new Error('ENGINE_PIPE_FAILED'); });

function exact(n) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      input.off('readable', inspect);
      input.off('end', inspect);
      input.off('error', error);
      input.off('close', inspect);
    };
    const error = () => { clean(); reject(new Error('ENGINE_PIPE_FAILED')); };
    const inspect = () => {
      if (failed) return error();
      const chunk = input.read(n);
      if (chunk !== null) {
        clean();
        if (chunk.length !== n) reject(new Error('ENGINE_PARTIAL_FRAME'));
        else resolve(chunk);
      } else if (input.readableEnded || input.destroyed) {
        clean(); reject(new Error('ENGINE_PARTIAL_FRAME'));
      }
    };
    input.on('readable', inspect);
    input.on('end', inspect);
    input.on('close', inspect);
    input.on('error', error);
    inspect();
  });
}
let received = 0;
let sent = 0;
const io = {
  async receive() {
    if (++received > 8) throw new Error('ENGINE_MESSAGE_LIMIT');
    const header = await exact(4);
    const n = header.readUInt32BE();
    if (n === 0 || n > MAX) throw new Error('ENGINE_FRAME_LIMIT');
    const bytes = await exact(n);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseUniqueJson(text);
  },
  async send(value) {
    if (++sent > 8 || failed) throw new Error('ENGINE_MESSAGE_LIMIT');
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.length === 0 || body.length > MAX) throw new Error('ENGINE_FRAME_LIMIT');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    await new Promise((resolve, reject) => {
      output.write(Buffer.concat([header, body]), (err) => err ? reject(new Error('ENGINE_PIPE_FAILED')) : resolve());
    });
  },
};
try {
  const pinned = readFileSync(new URL('../../../.node-version', import.meta.url), 'utf8').trim();
  if (process.versions.node !== pinned) throw new Error('ENGINE_NODE_VERSION');
  const modelMode = mode.startsWith('model-');
  if (!['normal', 'lost-reply', 'cancel-before-invoke', 'env-canary', 'hang'].includes(mode) && !modelMode) {
    throw new Error('ENGINE_FIXTURE_UNKNOWN');
  }
  if (mode === 'env-canary' && ['TADA_SECRET_CANARY','OPENAI_API_KEY','NODE_OPTIONS','PYTHONPATH'].some((k) => process.env[k] !== undefined)) {
    throw new Error('ENGINE_ENV_LEAK');
  }
  if (mode === 'hang') {
    input.resume();
    await new Promise(() => {});
  }
  if (modelMode) {
    // The normal Rust host never accepts fixture modes. MockProvider validates
    // the finite scenario list; neither a SDK nor a live endpoint is selected.
    const { runMockModelSession } = await import('./model-session.mjs');
    await runMockModelSession(io, mode.slice(6));
  } else {
    await runDigestSession(io, mode === 'lost-reply');
  }
  input.destroy();
  await new Promise((resolve) => output.end(resolve));
} catch {
  // Never echo a raw host message, schema instance, path or stack trace.
  input.destroy();
  process.stderr.write('ENGINE_SESSION_FAILED\n');
  process.exitCode = 1;
}
