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
 * `<CODEX_HOME>/plugins/cache/<마켓플레이스>/banker/<판>/{skills,codex/skills,codex/command-skills,codex/renamed-skills}/<name>/`
 * 에 있다. 두 길의 경로를 모두 센다. Codex 가 다른 이름으로 부르는 스킬(setup-omc 는 Codex 에서 setup-omx)은 Codex 이름으로
 * 설치를 확인한 뒤 Claude 이름으로 센다(bin/lib/codex-names.mjs, codex/manifest.json 의 codexName 에서 생성). 개인화 알림의
 * 바뀐 스킬 목록(skill-changes.json)도 Claude 이름이라 두 런타임의 셈이 한 이름으로 맞는다.
 * 도구 호출마다 도는 PreToolUse 대신 턴마다 한 번 도는 Stop 에서, 훅 입력의 transcript_path(rollout) 중
 * 이번 턴(task_started 의 turn_id 뒤)의 두 기록에 `skills/banker-<name>/SKILL.md` 가 있으면 센다. 나눠 읽어도 한 번이고, Stop 이 한 턴에 두 번 와도
 * (턴, 이름)마다 configDir 의 codex-count-turns.d 에 표지 파일을 만든 훅만 센다(옛 판과는 codex-count-turns 를 함께 봄).
 * 기록은 끝에서부터 32 MB 를 줄로 읽고, 턴 시작이 그 밖이면 256 MB 까지 바이트로 찾는다.
 *
 * fail-closed 규약은 Claude 쪽과 같다(telemetry-count-codex.test.mjs 가 검증):
 *  - countingActive() 가 아니면 로컬 쓰기조차 하지 않는다.
 *  - 이름은 SKILL_NAME_RE 전체 일치이고 이 Codex 에 설치된 banker 스킬(<CODEX_HOME>/skills/banker-<name>/SKILL.md, 또는
 *    기록의 경로 그대로 <CODEX_HOME>/plugins/cache/ 아래에 있는 플러그인의 SKILL.md)만.
 *    모델이 `echo skills/banker-<아무 글>/SKILL.md` 를 돌려 체크인의 이름 칸으로 글을 내보내지 못하게 한다. 턴 키 파일은 일반 파일만 읽고, 링크 자리에 쓰지 않는다.
 *  - 어떤 오류도 삼키고 항상 exit 0. 도구 호출을 절대 막지 않는다. 표준 출력은 비운다.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { CLAUDE_NAMES } from '../bin/lib/codex-names.mjs';
import { codexHomeOf, hookPlaces, pluginRoutes, writableRootsNote } from '../bin/lib/codex-routes.mjs';
import { appendUsageLog, CODEX_SHAPE_MISS_PATH, configDir, countingActive, randomHex, readRegular, recordUsedSkill, SKILL_NAME_RE, writeByRename } from '../bin/lib/telemetry-config.mjs';

export { codexHomeOf };

const SKILL_PATH_RE = /skills[\\/]+banker-([a-z0-9_-]{1,64})[\\/]+SKILL\.md/g;
// 플러그인 길: plugins/cache/<마켓플레이스>/banker/<판>/<스킬 폴더>/<name>/SKILL.md. 1 마켓플레이스, 2 판, 3 스킬 폴더, 4 이름.
// 대소문자를 가리지 않는 파일 시스템에서 `FRONT-QA` 같은 변형이 다른 이름으로 세어지지 않게 i 를 두지 않는다.
const PLUGIN_PATH_RE = /plugins[\\/]+cache[\\/]+([A-Za-z0-9._-]{1,80})[\\/]+banker[\\/]+([A-Za-z0-9._-]{1,80})[\\/]+(skills|codex[\\/]+skills|codex[\\/]+command-skills|codex[\\/]+renamed-skills)[\\/]+([a-z0-9_-]{1,64})[\\/]+SKILL\.md/g;
const KEEP_TURNS = 100;
export const TURNS_FILE = () => join(configDir(), 'codex-count-turns');
// 센 (턴, 이름)마다 하나씩 만드는 표지 파일의 폴더, 기록 끝 256 MB 안에서도 턴 시작을 못 찾은 일을 적는 한 줄 파일.
export const MARKS_DIR = () => join(configDir(), 'codex-count-turns.d');
export const FAR_NOTE_FILE = () => join(configDir(), 'codex-count-note');
const requireBuiltin = createRequire(import.meta.url);

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
const isUserMessage = (rec) => rec?.type === 'response_item' && rec.payload?.type === 'message' && rec.payload.role === 'user';

function injectedPath(rec) {
  if (!isUserMessage(rec) || !Array.isArray(rec.payload.content)) return '';
  const text = rec.payload.content[0]?.text;
  return typeof text === 'string' ? (SKILL_HEAD_RE.exec(text)?.[1] ?? '') : '';
}

// 이번 턴(turn_id 의 task_started 뒤)의 도구 호출과 넣은 스킬 머리에서 읽은 banker 스킬 이름. 사용자 글과 모델 답은 세지 않는다.
// 턴 시작은 대개 기록 끝 가까이에 있으므로 끝 1 MB 부터 읽고, 못 찾으면 두 배씩 max 까지 넓힌다.
// 그래도 없으면 farSkills 가 그 앞을 바이트로 찾는다(한 턴이 32 MB 를 넘게 쓴 경우).
// 기록 전체를 읽고도 task_started 가 하나도 없으면 null: Codex 는 턴마다 task_started 를 쓰므로 기록 형식이 바뀐 것이다.
// 이 턴의 것만 없을 때(시작이 기록되지 않는 턴)는 형식 변경으로 보지 않는다.
export function turnSkills(file, turnId, max = MAX_READ, far = {}) {
  for (let size = Math.min(FIRST_READ, max); ; size = Math.min(size * 2, max)) {
    const { lines, whole } = tailLines(file, size);
    const start = turnStart(lines, turnId);
    if (start >= 0) return skillsAfter(lines, start);
    if (whole) return lines.some((l) => l.trim()) && !lines.some((l) => l.includes('"task_started"')) ? null : [];
    if (size >= max) return farSkills(file, turnId, max, far);
  }
}

// 기록 끝 max 바이트 앞에서 이 턴의 시작을 찾는다. 끝에서 앞으로 chunk 씩 읽어 Buffer.lastIndexOf 로 턴 id 를 찾고
// (문자열로 바꾸지 않음, 조각 경계는 4 KB 겹쳐 읽음), 그 줄에 task_started 가 있으면 거기서부터 chunk 씩 앞으로 읽으며
// 이름만 모은다. 기록 끝에서 cap 바이트까지, ms 밀리초까지만(훅 시간 제한 5초). 못 찾으면 빈 목록에 far 표시를 단다.
const FAR_READ = 256 << 20;
const FAR_CHUNK = 32 << 20;
const FAR_MS = 2000;
const OVERLAP = 4 << 10;
const NL = 0x0a;
export function farSkills(file, turnId, max, { cap = FAR_READ, chunk = FAR_CHUNK, ms = FAR_MS } = {}) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const size = fstatSync(fd).size;
    const deadline = Date.now() + ms;
    const at = findStart(fd, { size, needle: Buffer.from(`"${turnId}"`), from: size - max, floor: Math.max(0, size - cap), chunk, deadline });
    if (at < 0) return Object.assign([], { far: true });
    return [...namesFrom(fd, at, size, chunk, deadline)];
  } finally {
    closeSync(fd);
  }
}

function readAt(fd, start, len) {
  const buf = Buffer.alloc(len);
  return buf.subarray(0, readSync(fd, buf, 0, len, start));
}

// task_started 와 이 턴 id 가 한 줄에 있는 마지막 자리(파일 위치). 없으면 -1.
function findStart(fd, { size, needle, from, floor, chunk, deadline }) {
  const mark = Buffer.from('"task_started"');
  for (let end = from; end > floor && Date.now() <= deadline; end -= chunk) {
    const lo = Math.max(floor, end - chunk);
    const buf = readAt(fd, lo, Math.min(end + OVERLAP, size) - lo);
    for (let i = buf.lastIndexOf(needle); i >= 0; i = i > 0 ? buf.lastIndexOf(needle, i - 1) : -1) {
      const ls = buf.lastIndexOf(NL, i) + 1;
      const le = buf.indexOf(NL, i);
      const at = buf.subarray(ls, le < 0 ? buf.length : le).indexOf(mark);
      if (at >= 0) return lo + ls + at;
    }
  }
  return -1;
}

// at(턴 시작 줄) 뒤로 기록 끝까지 chunk 씩 읽으며 SKILL.md 가 든 줄만 문자열로 바꿔 이름을 모은다.
function namesFrom(fd, at, size, chunk, deadline) {
  const names = new Set();
  let carry = Buffer.alloc(0);
  let skip = true; // 턴 시작 줄의 남은 부분
  for (let pos = at; pos < size && Date.now() <= deadline; pos += chunk) {
    let buf = Buffer.concat([carry, readAt(fd, pos, Math.min(chunk, size - pos))]);
    carry = Buffer.alloc(0);
    if (skip) {
      const nl = buf.indexOf(NL);
      if (nl < 0) continue;
      [buf, skip] = [buf.subarray(nl + 1), false];
    }
    const cut = pos + chunk >= size ? buf.length : buf.lastIndexOf(NL) + 1;
    linesWithSkill(buf.subarray(0, cut), names);
    carry = buf.subarray(cut);
  }
  return names;
}

const SKILL_BYTES = Buffer.from('SKILL.md');
function linesWithSkill(buf, names) {
  for (let hit = buf.indexOf(SKILL_BYTES); hit >= 0;) {
    const le = buf.indexOf(NL, hit);
    const end = le < 0 ? buf.length : le;
    lineNames(buf.toString('utf8', buf.lastIndexOf(NL, hit) + 1, end), names);
    hit = buf.indexOf(SKILL_BYTES, end);
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
  for (const line of lines.slice(start + 1)) lineNames(line, names);
  return [...names];
}

function lineNames(line, names) {
  if (!line.includes('SKILL.md')) return;
  let rec;
  try { rec = JSON.parse(line); } catch { return; }
  if (isCall(rec)) namesIn(JSON.stringify(rec.payload), names);
  else namesIn(injectedPath(rec), names);
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

// 'banker:<Codex 이름>' 을 'banker:<Claude 이름>' 으로. 이름이 같은 스킬은 그대로.
export function claudeName(entry) {
  const name = entry.slice('banker:'.length);
  return Object.hasOwn(CLAUDE_NAMES, name) ? `banker:${CLAUDE_NAMES[name]}` : entry;
}

// 이 턴에 아직 세지 않은 이름만 센다. far 는 기록 읽기 한도(시험이 낮춤): max 줄로 읽는 끝 부분, 그 밖은 farSkills 의 것.
export function countOnce(payload, far = {}) {
  const key = turnKey(payload);
  const file = typeof payload?.transcript_path === 'string' ? payload.transcript_path : '';
  const home = codexHomeOf(file);
  const got = readTurn(key, file, payload, far);
  if (got === null) {
    noteShapeMiss(file);
    return [];
  }
  if (got.far) noteFar(key);
  const routes = got.some((n) => n.includes('\t')) ? pluginRoutes(home) : []; // config.toml 은 한 번만 읽는다
  const names = [...new Set(got.filter((n) => installed(n, home, routes)).map((n) => claudeName(n.split('\t')[0])))];
  if (!names.length) return [];
  return withTurnsLock(() => countFresh(key, names));
}

function readTurn(key, file, payload, far) {
  return key && file ? turnSkills(file, payload.turn_id, far.max ?? MAX_READ, far) : [];
}

// 옛 판(0.22.0 까지)은 codex-count-turns 만 보고, 이 판은 (턴, 이름)마다 표지 파일을 wx 로 만든 훅만 센다.
// 옛 파일에 이미 있는 것은 표지만 만들고 세지 않는다. 센 것은 옛 판이 다시 세지 않게 옛 파일에도 적는다.
function countFresh(key, names) {
  const seen = readTurns();
  const fresh = names.filter((n) => markTurn(key, n) && !seen.includes(`${key}\t${n}`));
  for (const n of fresh) {
    appendUsageLog(n);
    recordUsedSkill(n);
  }
  if (fresh.length) writeTurns([...seen, ...fresh.map((n) => `${key}\t${n}`)]);
  dropOldMarks();
  return fresh;
}

// (턴, 이름)의 표지를 이 훅이 만들었는지. 만들기는 wx(이미 있으면 실패, 링크도 따라가지 않음)라 함께 도는 훅 가운데
// 하나만 성공한다. 표지 폴더가 링크이거나 남의 폴더이면, 또 Windows 의 wx 가 끊어진 링크를 따라가 만든 것이면 세지 않는다.
// Windows 의 wx 는 끊어진 링크를 따라가 그 대상을 만들므로, 그 자리에 무엇이든(끊어진 링크 포함) 있으면 열지 않는다.
function markTurn(key, name) {
  const dir = MARKS_DIR();
  const file = join(dir, markName(`${key}\t${name}`));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) return false;
    if (taken(file)) return false;
    closeSync(openSync(file, 'wx', 0o600));
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function taken(file) {
  try {
    lstatSync(file);
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

// 표지 이름: sha256 앞 32자. node:crypto 는 셀 것이 있을 때만 불러오고, crypto 없이 빌드한 Node 에서는 FNV-1a 넷.
function markName(text) {
  try {
    return requireBuiltin('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 32);
  } catch {
    let out = '';
    for (let seed = 0; seed < 4; seed++) {
      let h = (0x811c9dc5 ^ seed) >>> 0;
      for (const c of Buffer.from(text)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
      out += h.toString(16).padStart(8, '0');
    }
    return out;
  }
}

// 이틀 지난 표지를 지운다. Codex 는 끝난 턴에 Stop 을 다시 보내지 않는다.
const MARK_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
function dropOldMarks() {
  const dir = MARKS_DIR();
  try {
    for (const name of readdirSync(dir)) {
      try {
        if (Date.now() - lstatSync(join(dir, name)).mtimeMs > MARK_KEEP_MS) rmSync(join(dir, name), { force: true });
      } catch { /* 다른 훅이 먼저 지움 */ }
    }
  } catch { /* 다음에 */ }
}

// 턴 시작이 기록 끝 256 MB 밖이라 세지 않은 일을 한 줄로 남긴다(마지막 한 번만).
function noteFar(key) {
  try {
    writeByRename(FAR_NOTE_FILE(), `${new Date().toISOString()}\t${key}\t턴 시작이 기록 끝 256 MB 밖, 이 턴은 세지 않음\n`);
  } catch { /* 기록만 못 함 */ }
}

// npm 길과 플러그인 길의 Stop 훅이 같은 턴에 함께 돌면 둘 다 턴 키를 읽고 셀 수 있다. 셀지는 표지 파일(markTurn)이
// 정하고, 잠금은 codex-count-turns 를 읽고 고쳐 쓰는 동안 잡는다(mkdir 은 이미 있으면 실패하고 링크를 따라가지 않음).
// 2초 안에 못 잡으면 잠금 없이 표지로 정한다. 잠금은 몇 ms 만 잡으므로 훅 시간 제한(5초)보다 조금 긴 6초가 지난
// 잠금은 죽은 훅의 것이다: 고유 이름으로 옮겨(rename 은 하나만 성공) 지운 뒤 다시 잡는다. 옮긴 것이 새것이면(그사이
// 다른 훅이 넘겨받아 잡은 것) 그 훅에 이 턴을 맡기고 세지 않고 물러난다.
// configDir 을 만들 수 없거나 잠금 폴더를 만들 수 없는 다른 오류면 잠금 없이 표지로 정한다.
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
  const token = `${process.pid}-${randomHex()}`;
  for (;;) {
    const got = takeLock(lock, token);
    if (got === 'error') return fn();
    if (got === 'held') break;
    const old = takeOverStale(lock);
    if (old === 'backoff') return [];
    if (old === 'retry') continue;
    if (Date.now() >= end) return fn();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try {
    dropMovedLocks(lock);
    return fn();
  } finally {
    releaseLock(lock, token);
  }
}

// 'held' 잡음, 'busy' 다른 훅이 잡고 있음, 'error' 잠금 폴더를 만들 수 없음.
function takeLock(lock, token) {
  try {
    mkdirSync(lock);
  } catch (e) {
    return e?.code === 'EEXIST' ? 'busy' : 'error';
  }
  try { writeFileSync(join(lock, 'owner'), token, { flag: 'wx' }); } catch { /* 표시 없이도 잠금은 잡았다 */ }
  return 'held';
}

// 낡은 잠금을 넘겨받는다. 'retry' 치웠으니 다시 잡기, 'backoff' 물러남, 'live' 살아 있는 잠금(또는 방금 풀림).
function takeOverStale(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return 'live';
    const old = `${lock}.stale-${process.pid}-${randomHex()}`;
    renameSync(lock, old);
    // 본 것과 옮긴 것 사이에 다른 훅이 낡은 잠금을 치우고 새로 잡았을 수 있다. 옮긴 것이 새것이면 그 훅이 이
    // 턴을 세는 중이므로 세지 않고 물러난다. 돌려놓지 않는다(그사이 세 번째 훅이 잡은 잠금을 덮을 수 있다).
    // 옮긴 폴더는 다음에 잠금을 잡은 훅이 치운다.
    if (Date.now() - statSync(old).mtimeMs <= LOCK_STALE_MS) return 'backoff';
    rmSync(old, { recursive: true, force: true });
    return 'retry';
  } catch {
    return 'live'; // 방금 풀렸거나 다른 훅이 먼저 치움: 다시 잡아 본다
  }
}

// 잠금 폴더 안의 주인 표시(owner)가 이 훅의 것일 때만 놓는다. 넘겨받던 훅이 이 잠금을 옮기고 다른 훅이 그 이름을
// 새로 잡았으면, 그 훅의 잠금은 지우지 않는다.
function releaseLock(lock, token) {
  try {
    if (readFileSync(join(lock, 'owner'), 'utf8') !== token) return;
    rmSync(join(lock, 'owner'), { force: true });
    rmdirSync(lock);
  } catch { /* 없거나 남의 것 */ }
}

// 넘겨받다 물러난 훅이 남긴 옮긴 잠금(<잠금>.stale-*) 가운데 오래된 것을 지운다.
function dropMovedLocks(lock) {
  const dir = configDir();
  const prefix = `${lock.slice(dir.length + 1)}.stale-`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        if (Date.now() - statSync(join(dir, name)).mtimeMs > LOCK_STALE_MS) rmSync(join(dir, name), { recursive: true, force: true });
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
  // 이 훅이 도는 곳이 config.toml 의 writable_roots 아래면 세지 않고 까닭만 stderr 로(세션 시작 훅은 systemMessage 로 알림).
  let unsafe = '';
  try { unsafe = writableRootsNote(codexHomeOf(payload?.transcript_path), hookPlaces(import.meta.url)); } catch { /* 읽지 못하면 전처럼 */ }
  if (unsafe) { process.stderr.write(`${unsafe}\n`); return; }
  countOnce(payload);
}

if (process.argv[1] && /telemetry-count-codex\.mjs$/.test(process.argv[1])) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
