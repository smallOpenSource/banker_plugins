#!/usr/bin/env node
/*
 * banker 텔레메트리 count 훅 (Codex Stop) - Codex 세션이 banker 스킬을 쓴 턴이 끝날 때 로컬 usage-log 에
 * `banker:<name>\t<hour>` 한 줄을 남긴다. Claude Code 의 telemetry-count(.mjs, -skill.mjs)에 해당한다.
 *
 * Codex 0.144.5 실측으로 스킬이 쓰이는 길은 둘이다.
 *  - 모델이 고른 스킬: 도구 호출로 SKILL.md 를 읽는다(Bash `cat <CODEX_HOME>/skills/banker-<name>/SKILL.md`).
 *  - 사용자가 $banker-<name> 으로 부른 스킬: Codex 가 도구 호출 없이 `<skill>\n<name>..</name>\n<path>..</path>` 로
 *    시작하는 사용자 역할 메시지로 본문을 넣는다. 이때는 머리의 <path> 줄만 보고 본문은 보지 않는다.
 * 도구 호출마다 도는 PreToolUse 대신 턴마다 한 번 도는 Stop 에서, 훅 입력의 transcript_path(rollout) 중
 * 이번 턴(task_started 의 turn_id 뒤)의 두 기록에 `skills/banker-<name>/SKILL.md` 가 있으면 센다. 나눠 읽어도 한 번이고, Stop 이 한 턴에 두 번 와도
 * 최근 턴 키(configDir 의 codex-count-turns)로 한 번만 센다. 기록은 끝에서부터 32 MB 까지만 읽는다.
 *
 * fail-closed 규약은 Claude 쪽과 같다(telemetry-count-codex.test.mjs 가 검증):
 *  - countingActive() 가 아니면 로컬 쓰기조차 하지 않는다.
 *  - 이름은 SKILL_NAME_RE 전체 일치이고 이 Codex 에 설치된 banker 스킬(<CODEX_HOME>/skills/banker-<name>/SKILL.md)만.
 *    모델이 `echo skills/banker-<아무 글>/SKILL.md` 를 돌려 체크인의 이름 칸으로 글을 내보내지 못하게 한다. 턴 키 파일은 일반 파일만 읽고, 링크 자리에 쓰지 않는다.
 *  - 어떤 오류도 삼키고 항상 exit 0. 도구 호출을 절대 막지 않는다. 표준 출력은 비운다.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { appendUsageLog, CODEX_SHAPE_MISS_PATH, configDir, countingActive, readRegular, recordUsedSkill, SKILL_NAME_RE, writeByRename } from '../bin/lib/telemetry-config.mjs';

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

const MAX_READ = 32 << 20;
const FIRST_READ = 1 << 20;

// 글에 나오는 banker 스킬 이름(banker:<name>), 중복 없이.
export function namesIn(text, names = new Set()) {
  for (const m of text.matchAll(SKILL_PATH_RE)) {
    const name = `banker:${m[1]}`;
    if (SKILL_NAME_RE.test(name)) names.add(name);
  }
  return names;
}

// rollout 끝에서 max 바이트의 줄과, 파일 전체를 읽었는지. 일반 파일만: 기다리지 않게 O_NONBLOCK 으로 열고 연 것을 fstat 으로 본다. 앞에서 잘린 첫 줄은 버린다.
function tailLines(file, max) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return { lines: [], whole: true };
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

const isCall = (rec) => rec?.type === 'response_item' && /_call$/.test(String(rec?.payload?.type ?? ''));
const SKILL_HEAD_RE = /^<skill>\n<name>[^\n<]{1,80}<\/name>\n<path>([^\n<]{1,4096})<\/path>\n/;

// $banker-<name> 으로 부른 스킬을 Codex 가 넣은 메시지의 <path>. 그 밖의 기록은 ''.
function injectedPath(rec) {
  const p = rec?.payload;
  if (rec?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return '';
  const text = p.content[0]?.text;
  return typeof text === 'string' ? (SKILL_HEAD_RE.exec(text)?.[1] ?? '') : '';
}

// 이번 턴(turn_id 의 task_started 뒤)의 도구 호출과 넣은 스킬 머리에서 읽은 banker 스킬 이름. 사용자 글과 모델 답은 세지 않는다.
// 턴 시작은 대개 기록 끝 가까이에 있으므로 끝 1 MB 부터 읽고, 못 찾으면 두 배씩 max 까지 넓힌다.
// 기록 전체를 읽고도 이 턴의 시작이 없으면 null: Codex 는 턴마다 task_started 를 쓰므로 기록 형식이 바뀐 것이다.
export function turnSkills(file, turnId, max = MAX_READ) {
  for (let size = Math.min(FIRST_READ, max); ; size = Math.min(size * 2, max)) {
    const { lines, whole } = tailLines(file, size);
    const start = turnStart(lines, turnId);
    if (start >= 0) return skillsAfter(lines, start);
    if (whole) return lines.some((l) => l.trim()) ? null : [];
    if (size >= max) return [];
  }
}

// rollout 첫 기록(session_meta)의 Codex 판. Codex 기록이 아니면 ''.
export function codexVersionOf(file) {
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return '';
      const buf = Buffer.alloc(Math.min(fstatSync(fd).size, 1 << 20));
      readSync(fd, buf, 0, buf.length, 0);
      const rec = JSON.parse(buf.toString('utf8').split('\n')[0]);
      return rec?.type === 'session_meta' ? String(rec.payload?.cli_version ?? '?').slice(0, 40) : '';
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

// 이 Codex 판의 기록을 읽지 못했음을 남긴다(같은 판은 한 번만). 다음 세션 시작 때 update-notify --codex 가 알린다.
function noteShapeMiss(file) {
  const version = codexVersionOf(file);
  if (!version) return;
  let prev = {};
  try { prev = JSON.parse(readRegular(CODEX_SHAPE_MISS_PATH)); } catch { /* 없음 */ }
  if (prev?.version !== version) writeByRename(CODEX_SHAPE_MISS_PATH, JSON.stringify({ version, notified: false }));
}

function turnStart(lines, turnId) {
  let start = lines.length - 1;
  while (start >= 0 && !(lines[start].includes('"task_started"') && lines[start].includes(turnId))) start--;
  return start;
}

function skillsAfter(lines, start) {
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    if (!line.includes('SKILL.md')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (isCall(rec)) namesIn(JSON.stringify(rec.payload), names);
    else namesIn(injectedPath(rec), names);
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

// 이 세션의 Codex 홈: rollout 이 <홈>/sessions/YYYY/MM/DD/ 에 있으면 그 홈(상대 경로 CODEX_HOME 도 Codex 가 푼 그대로),
// 아니면 CODEX_HOME, 그것도 없으면 ~/.codex.
export function codexHomeOf(transcript, env = process.env) {
  const sessions = dirname(dirname(dirname(dirname(String(transcript)))));
  if (isAbsolute(String(transcript)) && basename(sessions) === 'sessions') return dirname(sessions);
  return env.CODEX_HOME || join(homedir(), '.codex');
}

// 이 Codex 에 설치된 banker 스킬인지.
export const installed = (name, home) => existsSync(join(home, 'skills', `banker-${name.slice('banker:'.length)}`, 'SKILL.md'));

// 이 턴에 아직 세지 않은 이름만 센다.
export function countOnce(payload) {
  const key = turnKey(payload);
  const file = typeof payload?.transcript_path === 'string' ? payload.transcript_path : '';
  const home = codexHomeOf(file);
  const got = key && file ? turnSkills(file, payload.turn_id) : [];
  if (got === null) {
    noteShapeMiss(file);
    return [];
  }
  const names = got.filter((n) => installed(n, home));
  if (!names.length) return [];
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
