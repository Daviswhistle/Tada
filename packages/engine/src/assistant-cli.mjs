#!/usr/bin/env node
// Explicit foreground, local-only conversational preview. No listening HTTP control port.
import { createInterface } from 'node:readline';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OllamaLocal } from '../../providers/src/ollama-local.mjs';
import { NativeSources } from './native-sources.mjs';
import { ConversationAssistant } from './conversation.ts';

export function parseOptions(args) {
  const options = { roots: [], endpoint: 'http://127.0.0.1:11434', help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') { options.help = true; continue; }
    if (!['--model', '--broker', '--allow-read', '--endpoint'].includes(key)
        || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('ASSISTANT_ARGUMENTS');
    if (key !== '--allow-read' && seen.has(key)) throw new Error('ASSISTANT_DUPLICATE_OPTION');
    seen.add(key);
    const value = args[++i];
    if (key === '--allow-read') options.roots.push(resolve(value));
    else options[key.slice(2)] = value;
  }
  if (options.help) return options;
  if (!options.model || !options.broker || !isAbsolute(options.broker) || options.roots.length > 8) {
    throw new Error('ASSISTANT_MODEL_AND_ABSOLUTE_BROKER_REQUIRED');
  }
  return options;
}
export function terminalText(value) {
  return String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
}
const HELP = `Tada conversational preview (read-only, local model, session memory)

npm run assistant -- --model INSTALLED_LOCAL_MODEL --broker ABSOLUTE_TADA_READ_BROKER [--allow-read DIRECTORY]...

Build the gateway first: cargo build --locked -p tada-agentd --bin tada-read-broker
Run your own Ollama server with cloud disabled (OLLAMA_NO_CLOUD=1).
Choose an already installed local tool-capable model. This command never installs,
pulls a model, accesses provider credentials or switches to a paid/remote route.
--allow-read grants source directories once, not a required file for every request.
With no readable sources the assistant can converse and ask for missing context.

Type ordinary messages; /forget clears conversation, /exit exits. Ctrl+C cancels.
This preview reads small text files and answers; it cannot yet see your screen,
search the web, modify files, or resume conversation after process exit.
Source hash rechecks do not prove every semantic assertion in a model answer.
`;

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  const provider = new OllamaLocal(options);
  const sources = new NativeSources(options.broker, options.roots);
  const setup = AbortSignal.timeout(20000);
  await sources.initialize(setup);
  const identity = await provider.inspect(setup);
  process.stdout.write(`${terminalText(identity.model)} · local inference · read-only · session memory\n`);
  process.stdout.write('자료 경로 없이 자연스럽게 말씀하세요. 화면·웹·파일 수정은 아직 지원하지 않습니다.\n');
  const assistant = new ConversationAssistant(provider, sources);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let current;
  const interrupt = () => {
    if (current) current.abort();
    else input.close();
  };
  process.on('SIGINT', interrupt);
  try {
    if (process.stdin.isTTY) process.stdout.write('> ');
    for await (const line of input) {
      if (line === '/exit') break;
      if (line === '/forget') {
        assistant.forget();
        process.stdout.write('이 세션의 대화를 비웠습니다. 요청 한도는 초기화하지 않았습니다.\n');
      } else if (line.trim()) {
        current = new AbortController();
        try {
          const answer = await assistant.ask(line, current.signal);
          process.stdout.write(`${terminalText(answer.text)}\n`);
          for (const source of answer.sources) {
            process.stdout.write(`[${source.id}] ${terminalText(source.source + '/' + source.path)} · sha256 ${source.sha256}\n`);
          }
        } catch (error) {
          const code = /^[A-Z_]{1,64}$/u.test(error.message) ? error.message : 'ASSISTANT_FAILED';
          process.stderr.write(`${code}: 완료로 처리하지 않았습니다. /forget으로 대화를 비우거나 /exit로 종료하세요.\n`);
        } finally { current = undefined; }
      }
      if (process.stdin.isTTY) process.stdout.write('> ');
    }
  } finally {
    current?.abort();
    input.close();
    process.removeListener('SIGINT', interrupt);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = /^[A-Z_]{1,64}$/u.test(error.message) ? error.message : 'ASSISTANT_STARTUP_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
