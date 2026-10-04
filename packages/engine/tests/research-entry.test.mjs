import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { HELP, parseOptions, hiddenKey } from '../src/research-cli.mjs';
import { plainText, answerHtml, terminalAnswer, saveAnswer } from '../src/answer-view.mjs';
import { parseUniqueJson } from '../src/json.mjs';
import { decodeResearchResponse } from '../../providers/src/research.ts';
import { MODEL, KEY, responseFixture } from '../../providers/tests/research-fixtures.mjs';
const answer = () => decodeResearchResponse(JSON.stringify(responseFixture()), MODEL);

test('help and invalid arguments expose no provider key or hidden runtime mode', () => {
  assert.equal(parseOptions(['--help']).help, true);
  assert.equal(parseOptions([]).model, null);
  assert.deepEqual(parseOptions(['--model', MODEL]), { model: MODEL, help: false });
  assert.throws(() => parseOptions(['--key', KEY]), error => !String(error).includes(KEY));
  assert.match(HELP, /No task JSON, attachment or source list/u);
  assert.match(HELP, /There is no strict dollar cap or restart-safe accounting/u);
});

test('actual CLI child help succeeds without credentials; piped input is rejected before any request', () => {
  const cli = fileURLToPath(new URL('../src/research-cli.mjs', import.meta.url));
  const env = { ...process.env, OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY };
  for (const args of [['--help'], ['--key', KEY], ['--model', MODEL]]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { env, input: `${KEY}\n`, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, args[0] === '--help' ? 0 : 1);
    assert.equal(result.stdout.includes(KEY), false); assert.equal(result.stderr.includes(KEY), false);
    if (args[0] === '--help') assert.match(result.stdout, /conversational public research/u);
  }
});

test('secret prompt accepts typed input without echo or command history', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', part => { text += part.toString(); });
  const pending = hiddenKey(input, output);
  input.write(`${KEY}\r`);
  assert.equal(await pending, KEY);
  assert.equal(text.includes(KEY), false); assert.match(text, /hidden/u);
  input.destroy(); output.destroy();
});

test('end of input while reading a key cancels instead of leaving an unresolved prompt', async () => {
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  const pending = hiddenKey(input, output); input.end();
  await assert.rejects(pending);
  input.destroy(); output.destroy();
});

test('terminal text removes control and bidi sequences without removing ordinary Korean text', () => {
  const text = '\x1b]52;clipboard\x07안녕하세요\u202e\x9b31m';
  const rendered = plainText(text);
  assert.match(rendered, /안녕하세요/u);
  assert.doesNotMatch(rendered, /[\x1b\x07\x9b\u202e]/u);
  const a = answer(); a.parts[0].text = text;
  assert.doesNotMatch(terminalAnswer(a), /[\x1b\x07\x9b\u202e]/u);
});

test('HTML exports escape model text and make actual cited sources clickable without embedding resources', () => {
  const a = answer(); a.parts[0].text = '<script>bad()</script><img src="https://evil.example/">';
  a.parts[0].citations[0].title = '<img onerror="bad()">';
  const html = answerHtml(a);
  assert.match(html, /&lt;script&gt;/u); assert.doesNotMatch(html, /<script>|<img /u);
  assert.match(html, /href="https:\/\/example.org\/source"/u);
  assert.match(html, /Content-Security-Policy/u); assert.match(html, /default-src 'none'/u);
  assert.equal(html.includes('OPAQUE_FAKE'), false);
  a.parts[0].citations[0].url = 'javascript:bad()';
  assert.throws(() => answerHtml(a));
});

test('user export writes one answer file and refuses existing files without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tada-answer-'));
  try {
    const target = join(root, 'answer.html');
    await saveAnswer(answer(), target);
    const text = await readFile(target, 'utf8');
    assert.match(text, /A sourced answer/u); assert.equal(text.includes(KEY), false);
    assert.equal(text.includes('OPAQUE_FAKE'), false);
    await assert.rejects(saveAnswer(answer(), target), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('user export cannot follow an occupied path to overwrite another file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tada-export-'));
  try {
    const target = join(root, 'original.html'); await writeFile(target, 'USER_CONTENT');
    // A hard link is available without elevated symlink privileges on Windows.
    const { link } = await import('node:fs/promises');
    const alias = join(root, 'alias.html'); await link(target, alias);
    await assert.rejects(saveAnswer(answer(), alias), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), 'USER_CONTENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('larger provider parsing is explicit and never relaxes the existing 16 KiB worker default', () => {
  const raw = JSON.stringify({ text: 'x'.repeat(20_000) });
  assert.throws(() => parseUniqueJson(raw), /ENGINE_INVALID_JSON/u);
  assert.equal(parseUniqueJson(raw, 30_000).text.length, 20_000);
  for (const bound of [0, -1, 1.5, Infinity, 1_048_577]) assert.throws(() => parseUniqueJson('{}', bound), /ENGINE_INVALID_JSON/u);
  assert.throws(() => parseUniqueJson('{"same":1,"s\\u0061me":2}', 30_000), /ENGINE_INVALID_JSON/u);
});

test('foreground conversation setup hidden key follow-up usage export and exit work in one child process', async () => {
  const { spawn } = await import('node:child_process');
  const { readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'tada-conversation-cli-'));
  const fixture = fileURLToPath(new URL('./research-process-fixture.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-strip-types', fixture], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', diagnostics = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { diagnostics += value; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.once('error', () => {});
  let cursor = 0;
  const wait = async (needle) => {
    const deadline = Date.now() + 5000;
    while (!output.slice(cursor).includes(needle)) {
      assert.equal(child.exitCode, null, `child exited before ${needle}: ${diagnostics}`);
      assert.ok(Date.now() < deadline, `missing ${needle}; observed=${output}; stderr=${diagnostics}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    cursor = output.indexOf(needle, cursor) + needle.length;
  };
  try {
    await wait('시작하려면 YES: '); child.stdin.write('YES\n');
    await wait('OpenAI API key (hidden; this session only): '); child.stdin.write(`${KEY}\n`);
    await wait('나: '); child.stdin.write('그 서비스를 조사해줘.\n');
    await wait('Tada: A sourced answer.');
    await wait('나: '); child.stdin.write('아까 답변을 더 쉽게 고쳐줘.\n');
    await wait('Tada: A sourced answer.');
    await wait('나: '); child.stdin.write('/usage\n');
    await wait('"requests": 2');
    await wait('나: '); child.stdin.write('/save\n');
    await wait('저장: ');
    await wait('나: '); child.stdin.write('/quit\n');
    const status = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('CLI_EXIT_TIMEOUT')), 5000); timer.unref(); })]);
    assert.equal(status.code, 0, diagnostics); assert.match(output, /TEST_ONLY_FOREGROUND_FLOW_PASSED/u);
    assert.equal(output.includes(KEY), false); assert.equal(diagnostics.includes(KEY), false);
    const entries = await readdir(root); assert.equal(entries.length, 1);
    assert.match(entries[0], /^tada-answer-.*\.html$/u);
    const saved = await readFile(join(root, entries[0]), 'utf8');
    assert.match(saved, /resp_cli_2/u); assert.equal(saved.includes('OPAQUE_FAKE'), false);
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
