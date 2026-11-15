#!/usr/bin/env node
/*
 * banker 의 Codex 플러그인 Stop 훅 하나. 두 일을 차례로 한다.
 *
 * 1. ralph 계속(ralph-continue-codex.mjs 의 decide): 이 세션이 시작한 banker ralph 실행이 끝나지 않았으면
 *    `{"decision":"block","reason":...}` 을 표준 출력에 쓴다. 먼저 하는 까닭: 세기가 늦거나 실패해도 이 판정은 나간다.
 * 2. 사용량 세기(telemetry-count-codex.mjs 의 countStop): 이번 턴에 쓴 banker 스킬을 센다.
 *
 * - 하나로 묶은 까닭: Codex 0.169.0 은 플러그인 훅을 돌릴 때마다, 그 훅의 시간 제한 안에서 플러그인 폴더 전체의 해시를
 *   먼저 구한다(plugin_trust.rs). Stop 훅이 둘이면 턴 끝마다 그 해시와 셸, node 를 두 번 치렀다. 느린 Windows PC 에서
 *   둘 다 시간 제한을 넘긴 보고가 있다.
 * - npm 길(banker setup --codex)은 두 훅을 그대로 둔다: 사용자 범위 훅은 플러그인 폴더 해시를 구하지 않는다.
 * - 끄기는 전과 같다: BANKER_NO_RALPH_CONTINUE, BANKER_NO_TELEMETRY.
 * - 어떤 오류도 삼키고 항상 exit 0. 막지 않을 때 표준 출력은 비운다.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decide } from './ralph-continue-codex.mjs';
import { countStop } from './telemetry-count-codex.mjs';

const MAX_INPUT = 32 << 20; // 이보다 큰 입력은 읽기를 그친다(그 입력은 JSON 으로 읽히지 않아 아무 일도 하지 않음)

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

// 훅 입력 하나로 두 일을 한다. write 는 표준 출력(시험이 바꿈).
export function onStop(payload, { write = (s) => process.stdout.write(s), count = countStop, ralph = decide } = {}) {
  try {
    const reason = ralph(payload);
    if (reason) write(`${JSON.stringify({ decision: 'block', reason })}\n`);
  } catch { /* 판정 못 함: 막지 않는다 */ }
  try {
    count(payload);
  } catch { /* 다음 턴에 */ }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  onStop(payload);
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) main().catch(() => {}).finally(() => process.exit(0));
