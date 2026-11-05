#!/usr/bin/env node
/*
 * banker ralph 계속 훅 (Codex Stop). Claude Code 의 OMC ralph 처럼, banker 의 Codex ralph 실행이 끝나기 전에 턴이
 * 끝나려 하면 계속하라는 이유를 돌려준다(`{"decision":"block","reason":...}`, OMX 의 Stop 훅과 같은 출력).
 *
 * - 막는 때: 훅 입력의 session_id 가 그 실행을 시작한 세션(start 때의 CODEX_THREAD_ID)이고, 그 실행이 이 작업 폴더의
 *   저장소에서 active 일 때만. 검토자 같은 하위 에이전트 세션과 다른 세션은 막지 않는다.
 * - 기록이나 게이트 증거가 바뀌지 않은 채 다섯 번 멈추려 하면 놓아준다(같은 턴의 두 번째 훅은 세지 않음).
 *   판정은 codex/skills/ralph/scripts/ralph-state.mjs 의 continueFor() 가 한다.
 * - BANKER_NO_RALPH_CONTINUE 가 있으면 아무것도 하지 않는다.
 * - 어떤 오류도 삼키고 항상 exit 0. 막지 않을 때 표준 출력은 비운다.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { continueFor } from '../codex/skills/ralph/scripts/ralph-state.mjs';

const MAX_INPUT = 1 << 20;

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_INPUT) process.stdin.destroy();
    });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('close', () => resolvePromise(data));
    process.stdin.on('error', () => resolvePromise(''));
  });
}

// The reason to keep the turn going for this hook input, or null.
export function decide(input, env = process.env, platform = process.platform) {
  if (env.BANKER_NO_RALPH_CONTINUE) return null;
  if (!input || typeof input !== 'object') return null;
  return continueFor({ cwd: input.cwd, sessionId: input.session_id, turnId: input.turn_id }, { env, platform });
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const reason = decide(input);
    if (reason) process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
  } catch {
    /* never in the way: no output, exit 0 */
  }
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) main().then(() => process.exit(0));
