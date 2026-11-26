#!/usr/bin/env node
/*
 * banker 은퇴 플러그인 알림 훅 (Claude Code SessionStart 전용).
 *
 * banker 가 지우기로 한 다른 플러그인(bin/lib/retired-plugins.mjs, 지금은 humanize-korean@im-not-ai)이 설치돼 있으면
 * 플러그인 id 마다 한 번, 지우는 명령을 systemMessage 로 알린다. 자동 업데이트로 새 판을 받아 update-banker 를 돌리지
 * 않은 사용자도 알게 하려는 것이다. 지우지는 않는다(훅은 5초 안에 끝나야 하고 사용자 설정을 바꾸면 안 된다).
 *
 * hooks/hooks.json(Claude Code)에만 등록한다. Codex 훅(codex/hooks.json, banker setup --codex)은 이 파일을 쓰지 않아
 * Codex 훅의 banker-hooks-rev 가 이 파일 때문에 바뀌지 않는다. Codex 에는 그 플러그인의 세 스킬이 없다.
 * 로컬 파일만 읽고 네트워크는 쓰지 않는다. 어떤 오류도 삼키고 늘 종료 0.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { retiredNoticeOnce } from '../bin/lib/retired-plugins.mjs';

// SessionStart 입력은 쓰지 않지만 다 읽어 보낸 쪽이 막히지 않게 한다.
function drainStdin() {
  return new Promise((done) => {
    process.stdin.on('data', () => {});
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  await drainStdin();
  const msg = retiredNoticeOnce();
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
}

// 직접 실행(훅)일 때만 돈다. realpath 가 읽지 못하는 경로는 resolve 로 비교한다.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === ranAs(fileURLToPath(import.meta.url))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
