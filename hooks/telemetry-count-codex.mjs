#!/usr/bin/env node
/*
 * banker 텔레메트리 count 훅 (Codex Stop) - Codex 세션이 banker 스킬을 쓴 턴이 끝날 때 로컬 usage-log 에
 * `banker:<name>\t<hour>` 한 줄을 남긴다. Claude Code 의 telemetry-count(.mjs, -skill.mjs)에 해당한다.
 *
 * Codex 0.144.5 실측으로 스킬이 쓰이는 길은 둘이다.
 *  - 모델이 고른 스킬: 도구 호출로 SKILL.md 를 읽는다(Bash `cat <CODEX_HOME>/skills/banker-<name>/SKILL.md`).
 *  - 사용자가 $banker-<name> 으로 부른 스킬: Codex 가 도구 호출 없이 `<skill>\n<name>..</name>\n<path>..</path>` 로
 *    시작하는 사용자 역할 메시지로 본문을 넣는다. 이때는 머리의 <path> 줄만 보고 본문은 보지 않는다.
 * Codex 플러그인으로 설치한 banker(codex plugin add, $banker:<name>)는 SKILL.md 가
 * `<CODEX_HOME>/plugins/cache/<마켓플레이스>/banker/<판>/{skills,codex/skills,codex/command-skills}/<name>/` 에 있다.
 * 두 길의 경로를 모두 센다.
 * 도구 호출마다 도는 PreToolUse 대신 턴마다 한 번 도는 Stop 에서, 훅 입력의 transcript_path(rollout) 중
 * 이번 턴(task_started 의 turn_id 뒤)의 두 기록에 `skills/banker-<name>/SKILL.md` 가 있으면 센다. 나눠 읽어도 한 번이고, Stop 이 한 턴에 두 번 와도
 * 최근 턴 키(configDir 의 codex-count-turns)로 한 번만 센다. 기록은 끝에서부터 32 MB 까지만 읽는다.
 *
 * fail-closed 규약은 Claude 쪽과 같다(telemetry-count-codex.test.mjs 가 검증):
 *  - countingActive() 가 아니면 로컬 쓰기조차 하지 않는다.
 *  - 이름은 SKILL_NAME_RE 전체 일치이고 이 Codex 에 설치된 banker 스킬(<CODEX_HOME>/skills/banker-<name>/SKILL.md, 또는
 *    기록의 경로 그대로 <CODEX_HOME>/plugins/cache/ 아래에 있는 플러그인의 SKILL.md)만.
 *    모델이 `echo skills/banker-<아무 글>/SKILL.md` 를 돌려 체크인의 이름 칸으로 글을 내보내지 못하게 한다. 턴 키 파일은 일반 파일만 읽고, 링크 자리에 쓰지 않는다.
 *  - 어떤 오류도 삼키고 항상 exit 0. 도구 호출을 절대 막지 않는다. 표준 출력은 비운다.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { codexHomeOf, pluginRoutes } from '../bin/lib/codex-routes.mjs';
import { appendUsageLog, CODEX_SHAPE_MISS_PATH, configDir, countingActive, randomHex, readRegular, recordUsedSkill, SKILL_NAME_RE, writeByRename } from '../bin/lib/telemetry-config.mjs';

export { codexHomeOf };

const SKILL_PATH_RE = /skills[\\/]+banker-([a-z0-9_-]{1,64})[\\/]+SKILL\.md/g;
// 플러그인 길: plugins/cache/<마켓플레이스>/banker/<판>/<스킬 폴더>/<name>/SKILL.md. 1 마켓플레이스, 2 판, 3 스킬 폴더, 4 이름.
// 대소문자를 가리지 않는 파일 시스템에서 `FRONT-QA` 같은 변형이 다른 이름으로 세어지지 않게 i 를 두지 않는다.
const PLUGIN_PATH_RE = /plugins[\\/]+cache[\\/]+([A-Za-z0-9._-]{1,80})[\\/]+banker[\\/]+([A-Za-z0-9._-]{1,80})[\\/]+(skills|codex[\\/]+skills|codex[\\/]+command-skills)[\\/]+([a-z0-9_-]{1,64})[\\/]+SKILL\.md/g;
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

// 글에 나오는 banker 스킬, 중복 없이. npm 길은 'banker:<name>', 플러그인 길은 'banker:<name>\t<홈 기준 SKILL.md 상대 경로>'
// (설치 확인에 쓰고, 셀 때는 이름만 남긴다).
export function namesIn(text, names = new Set()) {
  for (const m of text.matchAll(SKILL_PATH_RE)) {
    const name = `banker:${m[1]}`;
    if (SKILL_NAME_RE.test(name)) names.add(name);
  }
  for (const m of text.matchAll(PLUGIN_PATH_RE)) {
    const name = `banker:${m[4]}`;
    if (m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..' || !SKILL_NAME_RE.test(name)) continue;
    names.add(`${name}\t${['plugins', 'cache', m[1], 'banker', m[2], ...m[3].split(/[\\/]+/), m[4], 'SKILL.md'].join('/')}`);
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
// 기록 전체를 읽고도 task_started 가 하나도 없으면 null: Codex 는 턴마다 task_started 를 쓰므로 기록 형식이 바뀐 것이다.
// 이 턴의 것만 없을 때(시작이 기록되지 않는 턴)는 형식 변경으로 보지 않는다.
export function turnSkills(file, turnId, max = MAX_READ) {
  for (let size = Math.min(FIRST_READ, max); ; size = Math.min(size * 2, max)) {
    const { lines, whole } = tailLines(file, size);
    const start = turnStart(lines, turnId);
    if (start >= 0) return skillsAfter(lines, start);
    if (whole) return lines.some((l) => l.trim()) && !lines.some((l) => l.includes('"task_started"')) ? null : [];
    if (size >= max) return [];
  }
}

// rollout 첫 기록(session_meta)의 Codex 판. Codex 기록이 아니면 ''.
export function codexVersionOf(file) {
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return '';
      const buf = Buffer.alloc(Math.min(fstatSync(fd).size, 8 << 20)); // session_meta 는 지침을 품어 클 수 있다
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

// 이 Codex 에 설치된 banker 스킬인지. 플러그인 길은 그 홈의 config.toml 에 켜져 있는 banker@<마켓플레이스> 의 것이고,
// 기록의 경로 그대로 plugins/cache 아래에 있어야 한다(지운 플러그인이 남긴 폴더나 다른 마켓플레이스의 banker 는 세지 않음).
export function installed(entry, home, routes = pluginRoutes(home)) {
  const [name, rel] = entry.split('\t');
  if (rel) return routes.includes(`banker@${rel.split('/')[2]}`) && existsSync(join(home, ...rel.split('/')));
  return existsSync(join(home, 'skills', `banker-${name.slice('banker:'.length)}`, 'SKILL.md'));
}

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
  const routes = got.some((n) => n.includes('\t')) ? pluginRoutes(home) : []; // config.toml 은 한 번만 읽는다
  const names = [...new Set(got.filter((n) => installed(n, home, routes)).map((n) => n.split('\t')[0]))];
  if (!names.length) return [];
  return withTurnsLock(() => {
    const seen = readTurns();
    const fresh = names.filter((n) => !seen.includes(`${key}\t${n}`));
    if (!fresh.length) return [];
    for (const n of fresh) {
      appendUsageLog(n);
      recordUsedSkill(n);
    }
    writeTurns([...seen, ...fresh.map((n) => `${key}\t${n}`)]);
    return fresh;
  });
}

// npm 길과 플러그인 길의 Stop 훅이 같은 턴에 함께 돌면 둘 다 턴 키를 읽고 셀 수 있다. 턴 키를 읽고 쓰는 동안
// codex-count-turns.lock 폴더를 잡는다(mkdir 은 이미 있으면 실패하고 링크를 따라가지 않아 둘 중 하나만 잡음).
// 2초 안에 못 잡으면 잡은 쪽이 이 턴을 세므로 세지 않는다. 잠금은 몇 ms 만 잡으므로 훅 시간 제한(5초)보다 조금 긴
// 6초가 지난 잠금은 죽은 훅의 것이다: 고유 이름으로 옮겨(rename 은 하나만 성공) 지운 뒤 다시 잡는다. 옮긴 것이
// 새것이면(그사이 다른 훅이 넘겨받아 잡은 것) 그 훅에 이 턴을 맡기고 물러난다.
// configDir 을 만들 수 없거나 잠금 폴더를 만들 수 없는 다른 오류면 잠금 없이 전처럼 센다.
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 6000;
export function withTurnsLock(fn, { wait = LOCK_WAIT_MS } = {}) {
  const lock = `${TURNS_FILE()}.lock`;
  try {
    mkdirSync(configDir(), { recursive: true });
  } catch {
    return fn();
  }
  const end = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') return fn();
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        const old = `${lock}.stale-${process.pid}-${randomHex()}`;
        renameSync(lock, old);
        // 본 것과 옮긴 것 사이에 다른 훅이 낡은 잠금을 치우고 새로 잡았을 수 있다. 옮긴 것이 새것이면 그 훅이 이
        // 턴을 세는 중이므로 세지 않고 물러난다. 돌려놓지 않는다(그사이 세 번째 훅이 잡은 잠금을 덮을 수 있다).
        // 옮긴 폴더는 다음에 잠금을 잡은 훅이 치운다.
        if (Date.now() - statSync(old).mtimeMs <= LOCK_STALE_MS) return [];
        rmdirSync(old);
        continue;
      }
    } catch { /* 방금 풀렸거나 다른 훅이 먼저 치움: 다시 잡아 본다 */ }
    if (Date.now() >= end) return [];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try {
    dropMovedLocks(lock);
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* 이미 없음 */ }
  }
}

// 넘겨받다 물러난 훅이 남긴 옮긴 잠금(<잠금>.stale-*) 가운데 오래된 것을 지운다.
function dropMovedLocks(lock) {
  const dir = configDir();
  const prefix = `${lock.slice(dir.length + 1)}.stale-`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        if (Date.now() - statSync(join(dir, name)).mtimeMs > LOCK_STALE_MS) rmdirSync(join(dir, name));
      } catch { /* 다른 훅이 먼저 지움 */ }
    }
  } catch { /* 다음에 */ }
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
