#!/usr/bin/env node
/*
 * banker 텔레메트리 count 훅 (Codex PreToolUse) - Codex 세션이 banker 스킬을 쓸 때 로컬 usage-log 에
 * `banker:<name>\t<hour>` 한 줄을 남긴다. Claude Code 의 telemetry-count(.mjs, -skill.mjs)에 해당한다.
 *
 * Codex 는 스킬을 쓸 때(사용자가 $banker-<name> 으로 부르든 모델이 고르든) 도구 호출로 그 SKILL.md 를 읽는다
 * (Codex 0.144.5 실측: Bash `cat <CODEX_HOME>/skills/banker-<name>/SKILL.md`, MCP 읽기 도구도 PreToolUse 에 온다).
 * 그래서 도구 입력에 `skills/banker-<name>/SKILL.md` 가 있으면 그 이름을 센다. 한 턴에 나눠 읽어도
 * (sed -n 1,200p 다음 200,400p) 한 번만 센다: 최근 턴 키를 configDir 의 codex-count-turns 에 둔다.
 *
 * fail-closed 규약은 Claude 쪽과 같다(telemetry-count-codex.test.mjs 가 검증):
 *  - countingActive() 가 아니면 로컬 쓰기조차 하지 않는다.
 *  - 이름은 SKILL_NAME_RE 전체 일치만. 턴 키 파일은 일반 파일만 읽고, 링크 자리에 쓰지 않는다.
 *  - 어떤 오류도 삼키고 항상 exit 0. 도구 호출을 절대 막지 않는다. 표준 출력은 비운다.
 */
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendUsageLog, configDir, countingActive, readRegular, recordUsedSkill, SKILL_NAME_RE } from '../bin/lib/telemetry-config.mjs';

const SKILL_PATH_RE = /skills[\\/]+banker-([a-z0-9_-]{1,64})[\\/]+SKILL\.md/gi;
const KEEP_TURNS = 100;
export const TURNS_FILE = () => join(configDir(), 'codex-count-turns');

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

// 도구 입력에 나오는 banker 스킬 이름(banker:<name>), 중복 없이.
export function skillNames(payload) {
  const text = JSON.stringify(payload?.tool_input ?? '');
  const names = new Set();
  for (const m of text.matchAll(SKILL_PATH_RE)) {
    const name = `banker:${m[1]}`;
    if (SKILL_NAME_RE.test(name)) names.add(name);
  }
  return [...names];
}

const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

// 이 턴의 키. session_id 와 turn_id 가 모양이 맞을 때만(파일 한 줄 형식을 깨지 않게).
export function turnKey(payload) {
  const s = payload?.session_id;
  const t = payload?.turn_id;
  return typeof s === 'string' && typeof t === 'string' && ID_RE.test(s) && ID_RE.test(t) ? `${s}:${t}` : null;
}

function readTurns() {
  try {
    return readRegular(TURNS_FILE()).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// 링크나 일반 파일이 아닌 자리에는 쓰지 않는다. 새 파일을 만들어 바꿔 넣는다.
function writeTurns(lines) {
  const file = TURNS_FILE();
  try {
    if (!lstatSync(file).isFile()) return;
  } catch (e) {
    if (e?.code !== 'ENOENT') return;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${lines.slice(-KEEP_TURNS).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

// 이 턴에 아직 세지 않은 이름만 센다.
export function countOnce(payload) {
  const names = skillNames(payload);
  const key = turnKey(payload);
  if (!names.length || !key) return [];
  const seen = readTurns();
  const fresh = names.filter((n) => !seen.includes(`${key}\t${n}`));
  if (!fresh.length) return [];
  for (const n of fresh) {
    appendUsageLog(n);
    recordUsedSkill(n);
  }
  writeTurns([...seen, ...fresh.map((n) => `${key}\t${n}`)]);
  return fresh;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!countingActive()) return;
  countOnce(payload);
}

if (process.argv[1] && /telemetry-count-codex\.mjs$/.test(process.argv[1])) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
