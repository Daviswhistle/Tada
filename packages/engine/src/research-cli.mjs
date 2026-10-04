#!/usr/bin/env node
// Explicit foreground API-key research. Never reads another app's credentials.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Conversation } from './research-conversation.ts';
import { openAIResearchProvider, RESEARCH_LIMITS, validateModel } from '../../providers/src/research.ts';
import { plainText, terminalAnswer, saveAnswer } from './answer-view.mjs';

export const HELP = `Tada — conversational public research (developer preview)

Usage: npm run assistant -- --web [--model MODEL_ID]

The program asks for explicit API billing consent and then an API key with hidden
input. It does not read API keys from environment variables or existing apps.
Use a Responses API model that supports web_search. There is no model fallback.

Talk normally after setup. No task JSON, attachment or source list is required.
Current sources: this foreground conversation + provider-hosted public web search.
Screen, files, email, calendar, phone calls and external writes are not connected.

/usage     See attempted requests and observed/uncertain token usage.
/clear     Clear conversation and prior answers, without refilling allowances.
/continue  Acknowledge an interrupted request before making a NEW paid request.
/save      Save the last answer as a new local HTML file with source links.
/quit      Clear in-memory context/key references and exit.
Ctrl+C     Stop the active request, or leave the prompt.

This API-key path is billed separately from ChatGPT subscriptions. Limits are
${RESEARCH_LIMITS.requests} attempted requests per process, ${RESEARCH_LIMITS.outputTokens} output/reasoning tokens and ${RESEARCH_LIMITS.toolCalls} built-in tool
calls per request; each HTTP operation has a ${RESEARCH_LIMITS.timeoutMs / 1000}-second deadline.
There is no strict dollar cap or restart-safe accounting for this preview.
No history is saved automatically. /save exports the answer only, not the key,
conversation, hidden reasoning or private continuation. store:false is not ZDR.
`;
export function parseOptions(args) {
  if (args.length === 0) return { model: null, help: false };
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { model: null, help: true };
  if (args.length === 2 && args[0] === '--model') {
    validateModel(args[1]); return { model: args[1], help: false };
  }
  // Never echo invalid argv: somebody may have pasted a credential there.
  throw new Error('ASSISTANT_INVALID_OPTIONS');
}
export async function hiddenKey(input, output) {
  output.write('OpenAI API key (hidden; this session only): ');
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const secretPrompt = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  const cancelled = new AbortController();
  secretPrompt.on('SIGINT', () => cancelled.abort());
  secretPrompt.on('close', () => cancelled.abort());
  try {
    return await secretPrompt.question('', { signal: cancelled.signal });
  } finally { secretPrompt.close(); sink.destroy(); output.write('\n'); }
}
const MESSAGES = {
  RESEARCH_HTTP_AUTH: '인증 또는 계정 접근이 거절됐습니다. 다른 계정으로 자동 전환하지 않았습니다.',
  RESEARCH_HTTP_CAPACITY: '제공자의 사용량 제한에 걸렸습니다. 자동 재요청은 하지 않았습니다.',
  RESEARCH_HTTP_REQUEST: '이 요청을 제공자가 지원하지 않거나 거절했습니다. 모델·기능 설정을 확인해야 합니다.',
  RESEARCH_HTTP_SERVER: '제공자 오류로 결과를 확인하지 못했습니다.',
  RESEARCH_INCOMPLETE: '응답이 완성되지 않았습니다. 부분 출력을 완료 결과로 사용하지 않았습니다.',
  RESEARCH_CANCELLED: '이번 요청을 중단했습니다. 이미 처리된 사용량이 취소되는 것은 아닙니다.',
  RESEARCH_TIMEOUT: '응답 제한 시간을 넘겼습니다. 자동 재전송하지 않았습니다.',
  RESEARCH_CONTEXT_LIMIT: '대화가 이 미리보기의 문맥 한도에 도달했습니다. 내용을 몰래 잘라 보내지 않았습니다.',
  CONVERSATION_REQUEST_LIMIT: '이번 실행의 요청 한도를 모두 사용했습니다.',
  CONVERSATION_INVALID_INPUT: '비어 있지 않은 일반 문장을 입력해 주세요. 한 메시지는 UTF-8 기준 16 KiB까지 받습니다.',
  CONVERSATION_ACKNOWLEDGEMENT_REQUIRED: '이전 요청의 결과나 사용량이 미확정입니다. /continue로 확인하기 전에는 새 요청을 보내지 않습니다.',
};
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('ASSISTANT_INTERACTIVE_TERMINAL_REQUIRED');
  process.stdout.write(`${HELP}\n`);
  const setup = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  let model;
  const setupCancelled = new AbortController();
  setup.on('SIGINT', () => setupCancelled.abort());
  setup.on('close', () => setupCancelled.abort());
  try {
    model = options.model ?? (await setup.question('사용할 모델 ID: ', { signal: setupCancelled.signal })).trim();
    validateModel(model);
    const consent = await setup.question('입력한 대화와 공개 웹 검색을 OpenAI API로 처리하며 비용이 발생합니다. 시작하려면 YES: ', { signal: setupCancelled.signal });
    if (consent !== 'YES') { process.stdout.write('연결하지 않았습니다.\n'); return; }
  } finally { setup.close(); }
  let key = await hiddenKey(process.stdin, process.stdout);
  let provider;
  try { provider = openAIResearchProvider(key); }
  finally { key = ''; }
  const session = new Conversation(model, provider);
  const prompt = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  let active = null;
  let closed = false;
  prompt.on('close', () => { closed = true; active?.abort(); });
  prompt.on('SIGINT', () => { if (active) active.abort(); else prompt.close(); });
  try {
    while (!closed) {
      let text;
      try { text = await prompt.question('\n나: '); } catch { break; }
      if (text === '/quit') break;
      if (text === '/usage') { process.stdout.write(`${JSON.stringify(session.status(), null, 2)}\n`); continue; }
      if (text === '/clear') { session.clearConversation(); process.stdout.write('대화와 답변을 지웠습니다. 사용량 한도와 미확정 상태는 유지합니다.\n'); continue; }
      if (text === '/continue') {
        if (session.requiresAcknowledgement) {
          if (!session.status().cleanupConfirmed) { process.stdout.write('로컬 요청 종료를 확인하지 못해 이 실행에서는 새 요청을 차단합니다.\n'); continue; }
          const confirm = await prompt.question('이전 요청은 과금됐을 수 있으며 다음 메시지는 새 유료 요청입니다. 동의하려면 YES: ');
          if (confirm === 'YES') session.acknowledgeFailure();
        }
        continue;
      }
      if (text === '/save') {
        const answer = session.latestAnswer;
        if (!answer) { process.stdout.write('저장할 완료 응답이 없습니다.\n'); continue; }
        const path = resolve(`tada-answer-${randomUUID()}.html`);
        try { await saveAnswer(answer, path); process.stdout.write(`저장: ${plainText(path)}\n`); }
        catch { process.stdout.write('파일을 저장하지 못했습니다. 기존 파일을 덮어쓰지 않았습니다.\n'); }
        continue;
      }
      active = new AbortController();
      try {
        const answer = await session.ask(text, active.signal);
        process.stdout.write(`\nTada: ${terminalAnswer(answer)}\n`);
      } catch (error) {
        const code = error?.code ?? error?.message;
        process.stdout.write(`\n${MESSAGES[code] ?? '완전하고 지원되는 응답을 확인하지 못했습니다. 원문 오류·부분 결과는 표시하지 않습니다.'}\n`);
        if (session.requiresAcknowledgement) process.stdout.write('사용량은 /usage에서 확인할 수 있습니다. 재전송하지 않았습니다.\n');
      } finally { active = null; }
    }
  } finally { prompt.close(); session.dispose(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Tada를 시작하지 못했습니다. --help로 지원 명령과 대화형 터미널 조건을 확인하세요.\n');
    process.exitCode = 1;
  });
}
