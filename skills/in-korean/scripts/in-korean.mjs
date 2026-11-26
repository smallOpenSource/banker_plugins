#!/usr/bin/env node
/*
 * in-korean: 매 프롬프트와 세션 시작(compaction 뒤 포함)에 "한국어로 답하라" 는 짧은 지시를 훅으로 넣어 답변 언어를
 * 한국어로 고정한다. 설정의 language 를 korean 으로 해도 영어로 답하는 모델을 막으려는 것이다.
 *
 *   node in-korean.mjs on     --runtime claude|codex   그 런타임의 사용자 훅에 banker 표지가 붙은 훅 2개를 넣음
 *   node in-korean.mjs off    --runtime claude|codex   그 훅만 뺌
 *   node in-korean.mjs status                         두 런타임의 상태
 *
 * 넣는 자리(플러그인 hooks.json 이 아니라 사용자 범위)
 * - Claude Code: <CLAUDE_CONFIG_DIR 또는 ~/.claude>/settings.json 의 hooks.SessionStart, hooks.UserPromptSubmit 맨 뒤 묶음.
 *   language 가 없으면 "korean" 을 함께 넣고 off 가 뺀다(있던 값은 두고, 한국어가 아니면 알림).
 * - Codex: <CODEX_HOME 또는 ~/.codex>/hooks.json 의 같은 두 이벤트 맨 뒤 묶음(앞 묶음 번호를 밀지 않아 다른 훅의 신뢰가
 *   그대로). banker 의 bin/lib/codex-hooks.mjs 와 같은 잠금(hooks.json.lock)을 쓴다. 신뢰해야 돈다(/hooks).
 * 훅 명령은 node 를 띄우지 않고 고정 JSON 한 줄을 찍는다(printf, echo, Write-Output. shellCommand 참고). JSON 의 한글은
 * \uXXXX 로 적어 명령 글이 ASCII 뿐이라 셸과 코드 페이지가 글자를 깨지 않는다. 명령 끝 주석 `# banker:in-korean` 이 표지다.
 * 처음 on 이 바꾸기 전 원래 바이트는 <파일>.in-korean.bak, 원래 파일과 hooks 와 language 의 유무는 <파일>.in-korean.json(off 뒤 둘 다 지움).
 *
 * 종료: 0 완료 또는 이미 그 상태, 1 거부나 사용법 오류(바꾼 것 없음), 2 예기치 못한 오류, 3 쓸 권한 없음(샌드박스 등).
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupFor, denied, isObject, readJson, readRecord, writeFresh, writeJson } from './settings-json.mjs';

export const MARK = 'banker:in-korean';
export const TEXT = '답변, 보고, 요약, 사용자에게 보이는 생각은 한국어로 씀. 서브에이전트나 도구의 영어 결과를 옮길 때도 한국어로 바꿔 씀. 코드, 명령, 경로, 식별자, 오류 메시지는 원문 그대로. 사용자가 다른 언어를 직접 요청한 글만 예외. (banker in-korean)';
export const EVENTS = ['SessionStart', 'UserPromptSubmit'];
export const RUNTIMES = ['claude', 'codex'];
const TIMEOUT = { claude: 5, codex: 10 };
const KOREAN = /^(korean|ko|ko-kr|한국어)$/i;

export function defaults(env = process.env) {
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'),
    codexDir: env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex'),
    platform: process.platform,
  };
}

// 훅이 찍을 JSON 한 줄. 한글과 ASCII 밖 글자는 \uXXXX 로 적어 ASCII 만 남긴다.
export function hookJson(event) {
  const json = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: TEXT } });
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// 셸마다 같은 JSON 한 줄을 찍는 명령. 작은따옴표 안이라 셸이 아무것도 풀지 않는다(TEXT 에 작은따옴표가 없음을 시험이 지킴).
// - posix: printf. zsh 와 macOS sh 의 echo 는 \u 를 풀 수 있어 쓰지 않는다.
// - both: Windows 의 Claude Code 는 Git Bash 로, Git Bash 가 없으면 PowerShell 로 돌린다(2.1.332). 둘 다 echo 가 글을
//   그대로 찍는다(bash 의 echo 는 기본으로 \ 를 풀지 않고, PowerShell 의 echo 는 Write-Output).
// - powershell: Windows 의 Codex 는 훅을 PowerShell 로 돌린다.
// 끝의 `# banker:in-korean` 은 세 셸 모두에서 주석이다.
export function shellCommand(event, shell) {
  const json = hookJson(event);
  if (shell === 'powershell') return `Write-Output '${json}' # ${MARK}`;
  if (shell === 'both') return `echo '${json}' # ${MARK}`;
  return `printf '%s\\n' '${json}' # ${MARK}`;
}

// 넣을 훅 항목. Codex 는 command(POSIX)와 commandWindows(PowerShell)를 함께 적어 OS 와 관계없이 같은 파일이다.
export function hookEntry(event, runtime, platform = process.platform) {
  if (runtime === 'codex') {
    return { type: 'command', command: shellCommand(event, 'posix'), commandWindows: shellCommand(event, 'powershell'), timeout: TIMEOUT.codex };
  }
  return { type: 'command', command: shellCommand(event, platform === 'win32' ? 'both' : 'posix'), timeout: TIMEOUT.claude };
}

const isOurs = (h) => isObject(h) && typeof h.command === 'string' && h.command.includes(`# ${MARK}`);

// 한 이벤트의 묶음들에 우리 훅을 둔다(entry 가 null 이면 뺀다). 우리 항목은 처음 것만 같은 자리에서 고치고 나머지는 뺀다.
// 없으면 맨 뒤 묶음으로 더한다. hooks 배열이 없는 모르는 꼴의 묶음은 그대로 둔다.
export function placeEvent(groups, entry) {
  let found = !entry;
  const fix = (h) => {
    if (!isOurs(h)) return [h];
    if (found) return [];
    found = true;
    return [entry];
  };
  const next = groups.map((g) => (isObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.flatMap(fix) } : g))
    .filter((g) => !isObject(g) || !Array.isArray(g.hooks) || g.hooks.length);
  if (!found) next.push({ hooks: [entry] });
  return next;
}

// 문서(설정 객체)의 hooks 를 바꾼 새 문서. remove 면 우리 훅을 빼고, 비는 이벤트와 우리가 만든 빈 hooks 를 지운다.
export function withHooks(doc, runtime, platform, remove, hadHooks = true) {
  const next = JSON.parse(JSON.stringify(doc));
  next.hooks ??= {};
  for (const ev of EVENTS) {
    const groups = placeEvent(next.hooks[ev] || [], remove ? null : hookEntry(ev, runtime, platform));
    if (groups.length) next.hooks[ev] = groups;
    else delete next.hooks[ev];
  }
  if (remove && !hadHooks && !Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

// 'on' | 'off' | 'stale'(표지는 있으나 항목이 이 판과 다름).
export function hookState(doc, runtime, platform) {
  const states = EVENTS.map((ev) => {
    const ours = (doc.hooks?.[ev] || []).flatMap((g) => (isObject(g) && Array.isArray(g.hooks) ? g.hooks : [])).filter(isOurs);
    if (!ours.length) return 'off';
    return ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(hookEntry(ev, runtime, platform)) ? 'on' : 'stale';
  });
  if (states.every((s) => s === 'on')) return 'on';
  return states.every((s) => s === 'off') ? 'off' : 'stale';
}

// hooks 와 두 이벤트의 꼴이 우리가 고칠 수 있는지. 까닭, 또는 ''.
function shapeWhy(file, data) {
  if (data.hooks !== undefined && !isObject(data.hooks)) return `${file} 의 hooks 가 객체가 아님`;
  const bad = EVENTS.find((ev) => data.hooks?.[ev] !== undefined && !Array.isArray(data.hooks[ev]));
  return bad ? `${file} 의 hooks.${bad} 가 배열이 아님` : '';
}

/* ---------- 설정 파일 ---------- */

const PLACES = {
  claude: { dir: 'claudeDir', file: 'settings.json', name: 'Claude Code', links: true },
  codex: { dir: 'codexDir', file: 'hooks.json', name: 'Codex', links: false },
};
export const fileOf = (rt, o) => join(o[PLACES[rt].dir], PLACES[rt].file);
const recordOf = (file) => `${file}.in-korean.json`;
const backupOf = (file) => `${file}.in-korean.bak`;

// { file, doc } 또는 { why }. Codex hooks.json 의 링크는 고치지 않는다(Codex 가 신뢰를 파일 경로로 기록하고, banker 의
// codex-hooks.mjs 도 거부). Claude Code settings.json 의 링크(dotfiles)는 따라가 그 너머 파일을 바꾼다.
export function load(rt, o) {
  const p = PLACES[rt];
  if (!existsSync(o[p.dir])) return { why: `${p.name} 설정 폴더가 없음(${o[p.dir]})` };
  const file = fileOf(rt, o);
  if (!p.links && lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return { why: `${file} 이 링크임` };
  const r = readJson(file);
  if (r.why) return { why: r.why };
  const why = shapeWhy(file, r.data);
  return why ? { why } : { file, doc: r };
}

function languageNote(lang) {
  if (lang === undefined || (typeof lang === 'string' && KOREAN.test(lang.trim()))) return '';
  return `\n- 참고: settings.json 의 language 가 ${JSON.stringify(lang)} 임. 바꾸지 않았고, 훅이 한국어로 고정함`;
}

const TRUST = 'Codex 를 다시 열면 뜨는 Hooks need review 창이나 /hooks 에서 banker in-korean 훅 2개를 신뢰해야 돎';
const AFTER_ON = {
  claude: '새 세션부터 적용. 실행 중인 세션은 설정 파일 감시로 곧 읽고, 안 되면 다시 시작',
  codex: TRUST,
};

function onIn(rt, o) {
  const { file, doc, why } = load(rt, o);
  if (why) return refuse(why);
  const next = withHooks(doc.data, rt, o.platform, false);
  // Claude Code 만 language 가 있다. 없으면 "korean" 을 넣는다(Claude Code 가 답변 언어로 쓰는 값).
  const addLang = rt === 'claude' && doc.data.language === undefined;
  if (addLang) next.language = 'korean';
  const note = rt === 'claude' ? languageNote(doc.data.language) : '';
  if (JSON.stringify(next) === JSON.stringify(doc.data)) return { code: 0, message: `이미 켜져 있음 (${file})${note}\n- ${AFTER_ON[rt]}` };
  // 처음 on 의 기록을 지킨다: 다시 on 해도 원래 파일 유무, hooks 유무, language 가 남는다.
  const record = readRecord(recordOf(file)) ?? { existed: doc.exists, hadHooks: doc.data.hooks !== undefined, addedLanguage: addLang };
  const backup = backupFor(backupOf(file), recordOf(file)); // 두 번째 on 은 첫 원본 백업을 덮지 않음
  writeFresh(recordOf(file), `${JSON.stringify(record)}\n`, 0o600);
  writeJson(file, next, { bom: doc.bom, style: doc.style, raw: doc.raw, backup });
  const lang = addLang ? '\n- language 가 없어 "korean" 을 넣음(off 가 뺌)' : note;
  return { code: 0, message: `켬: ${PLACES[rt].name} 훅 SessionStart, UserPromptSubmit (${file})${lang}\n- ${AFTER_ON[rt]}` };
}

// off 의 쓰기. on 이 새로 만든 파일이 다시 비면 지운다.
function writeOff(file, doc, next, record) {
  if (record?.existed === false && !Object.keys(next).length) rmSync(file, { force: true });
  else writeJson(file, next, { bom: doc.bom, style: doc.style });
}

// 우리 묶음 뒤에 다른 묶음이 있는지(빼면 그 묶음의 번호가 밀려 Codex 가 신뢰를 다시 물음).
function shiftsOthers(data) {
  return EVENTS.some((ev) => {
    const groups = data.hooks?.[ev] || [];
    const at = groups.findIndex((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs));
    return at >= 0 && at < groups.length - 1;
  });
}

// off 가 쓸 새 문서. 기록이 없으면 hooks 유무는 지금 파일을 따른다(비어도 hooks 를 남김).
function offDoc(rt, o, data, record) {
  const hadHooks = record ? record.hadHooks !== false : data.hooks !== undefined;
  const next = withHooks(data, rt, o.platform, true, hadHooks);
  const dropLang = Boolean(record?.addedLanguage) && next.language === 'korean';
  if (dropLang) delete next.language;
  return { next, dropLang };
}

function offIn(rt, o) {
  const { file, doc, why } = load(rt, o);
  if (why) return refuse(why);
  const record = readRecord(recordOf(file));
  const { next, dropLang } = offDoc(rt, o, doc.data, record);
  const same = JSON.stringify(next) === JSON.stringify(doc.data);
  if (!same) writeOff(file, doc, next, record);
  // 기록과 백업은 쓴 뒤에 지운다: 쓰기가 실패하면 다음 off 가 기록으로 language 를 뺄 수 있다.
  rmSync(recordOf(file), { force: true });
  if (record) rmSync(backupOf(file), { force: true });
  if (same) return { code: 0, message: `이미 꺼져 있음 (${file})` };
  const shifted = rt === 'codex' && shiftsOthers(doc.data) ? '\n- 뒤에 더해진 다른 훅은 /hooks 에서 다시 신뢰해야 할 수 있음' : '';
  return { code: 0, message: `끔: ${PLACES[rt].name} 훅을 뺌${dropLang ? ', on 이 넣은 language 도 뺌' : ''} (${file})${shifted}` };
}

/* ---------- Codex hooks.json 잠금 ---------- */

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 10초 넘은 잠금은 죽은 쓰기로 보고 치운다. true: 치웠거나 그사이 풀림.
function clearStale(lock) {
  try {
    if (Date.now() - lstatSync(lock).mtimeMs <= 10000) return false;
    rmdirSync(lock);
    return true;
  } catch {
    return !existsSync(lock);
  }
}

// hooks.json 옆의 잠금 폴더(banker codex-hooks.mjs, teamwork 와 같은 규칙). 5초 안에 못 얻으면 바꾸지 않는다.
// Codex 홈이 없으면(ENOENT) 잠금 없이 fn 이 까닭을 알린다.
export function withHooksLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code === 'ENOENT') return fn();
      if (e.code !== 'EEXIST') throw e;
      if (i > 200) return refuse(`${file} 의 잠금(${lock})을 얻지 못함. 다른 banker 나 teamwork 가 돌고 있지 않으면 그 폴더를 확인`);
      if (!clearStale(lock)) pause(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export const turnOn = (rt, o) => (rt === 'codex' ? withHooksLock(fileOf(rt, o), () => onIn(rt, o)) : onIn(rt, o));
export const turnOff = (rt, o) => (rt === 'codex' ? withHooksLock(fileOf(rt, o), () => offIn(rt, o)) : offIn(rt, o));

/* ---------- 상태와 명령줄 ---------- */

const LABEL = { on: '켜짐', off: '꺼짐', stale: '켜짐, 단 훅이 이 판과 다름 (on 으로 갱신)' };

function stateLine(rt, o) {
  const loaded = load(rt, o);
  const name = PLACES[rt].name;
  if (loaded.why) return `- ${name}: 읽지 못함 (${loaded.why})`;
  const s = hookState(loaded.doc.data, rt, o.platform);
  const lang = rt === 'claude' ? `, language = ${JSON.stringify(loaded.doc.data.language) ?? '(없음)'}` : '';
  return `- ${name}: ${LABEL[s]} (${loaded.file}${lang})${rt === 'codex' && s !== 'off' ? `\n  - ${TRUST}` : ''}`;
}

export const status = (o) => ({ code: 0, message: ['in-korean 상태', ...RUNTIMES.map((rt) => stateLine(rt, o))].join('\n') });

const refuse = (why) => ({ code: 1, message: `거부: ${why}. 아무것도 바꾸지 않음` });
const USAGE = '사용법: in-korean on | off | status [--runtime claude|codex]';

// argv 에서 --runtime x 나 --runtime=x 를 뺀다. { runtime(없으면 null), rest }.
function takeRuntime(argv) {
  const rest = [];
  let runtime = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime') runtime = (argv[++i] ?? '').toLowerCase();
    else if (argv[i].startsWith('--runtime=')) runtime = argv[i].slice(10).toLowerCase();
    else rest.push(argv[i]);
  }
  return { runtime, rest };
}

// 명령줄의 꼴이 맞는지(런타임을 정하기 전).
function shapeOk(taken, command) {
  const badRuntime = taken.runtime !== null && !RUNTIMES.includes(taken.runtime);
  return taken.rest.length <= 1 && ['on', 'off', 'status'].includes(command) && !badRuntime;
}

export function parseArgs(argv, env = process.env) {
  const taken = takeRuntime(argv);
  const command = (taken.rest[0] ?? 'on').toLowerCase();
  if (!shapeOk(taken, command)) return { error: USAGE };
  const runtime = taken.runtime ?? (env.CLAUDECODE === '1' ? 'claude' : null);
  if (command !== 'status' && !runtime) return { error: `런타임을 정할 수 없음. --runtime claude 또는 --runtime codex 를 붙임\n${USAGE}` };
  return { command, runtime };
}

export function main(argv, o = defaults(), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.error) return { code: 1, message: args.error };
  try {
    if (args.command === 'status') return status(o);
    return (args.command === 'on' ? turnOn : turnOff)(args.runtime, o);
  } catch (e) {
    if (denied(e)) return { code: 3, message: `쓸 권한이 없음(${e.code}): ${e.path ?? ''}\nCodex 에서는 이 명령만 샌드박스 밖 실행 승인을 받아 다시 실행` };
    return { code: 2, message: `예기치 못한 오류로 중단함: ${e.message}\nstatus 로 상태를 확인` };
  }
}

// 직접 실행일 때만. 링크로 부른 경로도 같게 본다(realpath 가 못 읽으면 resolve 로 비교).
const invokedDirectly = () => {
  const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return Boolean(process.argv[1]) && ranAs(process.argv[1]) === fileURLToPath(import.meta.url);
};

if (invokedDirectly()) {
  const { code, message } = main(process.argv.slice(2));
  process.stdout.write(`${message}\n`);
  process.exitCode = code;
}
