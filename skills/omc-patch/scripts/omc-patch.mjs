#!/usr/bin/env node
/**
 * OMC 패치 — 버전 고정 + 훅 결함 수정 + 자동 업데이트 차단.
 *
 *   node omc-patch.mjs              업데이트(5.7.0) + 패치 + 고정
 *   node omc-patch.mjs --check      진단만 (아무것도 바꾸지 않음)
 *   node omc-patch.mjs --revert     패치·고정 되돌리기
 *   node omc-patch.mjs --no-update  버전은 그대로 두고 패치만
 *   node omc-patch.mjs --root <플러그인 폴더> [--check | --revert]
 *                                   그 폴더의 hooks/hooks.json 과 scripts/ 만 다룬다(번들 사본, 활성 캐시 폴더 하나).
 *                                   installed_plugins.json, 마켓플레이스 origin, 판은 건드리지 않는다.
 *                                   이름표(.claude-plugin/plugin.json 의 name, 없으면 package.json 의 name)가
 *                                   OMC 가 아니면 멈춘다.
 *   node omc-patch.mjs --scan <파일>...
 *                                   헬퍼 선언의 블록 깊이와 래핑 자리를 JSON 으로 낸다(읽기 전용).
 *
 * 활성 버전은 installed_plugins.json 의 oh-my-claudecode@omc 항목(version, installPath)에서
 * 읽는다. 캐시에 TARGET_VERSION 이 있다고 그것을 활성으로 보지 않는다(--no-update 는 활성 버전을 패치).
 * OMC_PATCH_INSTALLED=<json 경로> 로 읽을 파일을 바꿀 수 있다(시험용, --check 와 함께).
 *
 * OS: Windows / macOS / Linux 공통. 런처(apply.cmd, apply.sh)와 배경 문서(README.md)는
 * 킷 배포 폴더에만 있다. 이 파일만 옮겨 쓰는 곳(예: 스킬 폴더)에는 없다.
 */
import {
  readFileSync, writeFileSync, writeSync, existsSync, copyFileSync, readdirSync,
  unlinkSync, mkdirSync, rmSync, symlinkSync, lstatSync, realpathSync,
} from "node:fs";
import { join, dirname, resolve, sep as PATH_SEP, delimiter as PATH_LIST_SEP } from "node:path";
import { homedir, hostname } from "node:os";
import { execFileSync } from "node:child_process";

// 인자 없는 apply 가 맞춰 놓는 판. banker 의 omc-patch 스킬은 늘 --no-update 로 돌려 이 값으로 판을 바꾸지 않는다.
const TARGET_VERSION = "5.7.0";
// 3초는 좁았다. 이 예산은 «정상이지만 느린» 로드까지 잘라내는데, 파일 스캔이 8.2배 느려진
// 이 PC 가 정확히 그 조건이다(실측: 4초 지연에서 session-end 가 조용히 건너뛰어졌다).
// 대안이 «무한 정지» 인 자리에만 걸리므로 넉넉히 잡는다.
const IMPORT_TIMEOUT_MS = 10000;
// 타임아웃이 걸렸다는 것은 그 import 가 사실상 끝나지 않는다는 뜻이다. 훅은 완료 신호를
// 내고 제 할 일을 끝내지만, 매달린 로드가 이벤트 루프를 붙잡아 «프로세스는 남는다»
// (실측: 신호는 3초에 나왔는데 12초까지 살아 있어 강제종료해야 했다). 신호를 낼 시간을
// 준 뒤 스스로 끝내 프로세스 누적을 막는다.
const EXIT_GRACE_MS = 2000;
const MARKETPLACE = "omc";
const PLUGIN_KEY = "oh-my-claudecode@omc";
const REPO_URL = "https://github.com/Yeachan-Heo/oh-my-claudecode.git";

const args = process.argv.slice(2);
const argv = new Set(args);
const MODE = argv.has("--revert") ? "revert" : argv.has("--check") ? "check" : "apply";
const NO_UPDATE = argv.has("--no-update");
// --root <플러그인 폴더>: 이 PC 의 설치 상태와 상관없이 그 폴더 하나만 고친다. 번들 사본처럼
// 판 폴더도 installed_plugins.json 도 없는 트리나, 활성 캐시 폴더 하나만 고칠 때 쓴다.
// 값이 없거나 다음 플래그면 멈춘다.
const ROOT_AT = args.indexOf("--root");
const ROOT_ARG = ROOT_AT >= 0 ? args[ROOT_AT + 1] : null;
const ROOT = ROOT_ARG && !ROOT_ARG.startsWith("--") ? resolve(ROOT_ARG) : null;
const SCAN_AT = args.indexOf("--scan");

const CFG = join(homedir(), ".claude");
const PLUGINS = join(CFG, "plugins");
const CACHE = join(PLUGINS, "cache", MARKETPLACE, "oh-my-claudecode");
const MARKET = join(PLUGINS, "marketplaces", MARKETPLACE);
// OMC_PATCH_INSTALLED: 시험용. installed_plugins.json 대신 읽을 JSON 경로(읽기 전용 용도).
const INSTALLED = process.env.OMC_PATCH_INSTALLED || join(PLUGINS, "installed_plugins.json");
const PINFILE = join(CFG, "omc-local-patches", "PINNED");

const log = (s = "") => console.log(s);
const bad = (s) => console.log(`  [!] ${s}`);
const ok = (s) => console.log(`  ok  ${s}`);

// dist/ 로드가 hang 하면 main() 이 시작조차 못 해 킬스위치·타임아웃·완료신호가
// 한꺼번에 무력화된다(실측: 도구 호출 하나가 63.8분 정지, 훅 프로세스 34개 누적).
//
// 타임아웃 시 null 이 아니라 빈 객체를 돌려주는 것이 중요하다. 호출부 다수가
//   const { a, b } = await import(...)
// 형태의 구조 분해라서 null 이면 그 자리에서 TypeError 로 죽는다. 빈 객체면 각
// 심볼이 undefined 가 되고, 호출부에 이미 있는 null 검사/try-catch 가 no-op
// 경로를 태운다. 정상 로드 시에는 동작이 전혀 바뀌지 않는다.
const HELPER = `
// --- OMC local patch: bound top-level dynamic import (see ~/.claude/omc-local-patches/README.md)
const __omcRaceImport = (p) => {
  let t;
  const timed = new Promise((res) => {
    // 이 타이머는 ref 된 채로 두어야 한다. unref 하면 «대기 중인 I/O 가 없는» 매달림에서
    // Node 가 unsettled top-level await 를 감지해 먼저 exit 13 으로 빠지고, 타이머는
    // 뜨지도 못한다(실측: 원본과 패치본이 똑같이 150ms 안에 죽었다). import 가 정상적으로
    // 끝나면 아래에서 clearTimeout 하므로 정상 경로는 한 톨도 느려지지 않는다.
    t = setTimeout(() => {
      const k = setTimeout(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0), ${EXIT_GRACE_MS});
      if (k && k.unref) k.unref();
      // 빈 객체를 돌려주는 것이 중요하다. 호출부 다수가 \`const { a } = await import(...)\`
      // 형태의 구조 분해라서 null 이면 그 자리에서 TypeError 로 죽는다. 빈 객체면 각
      // 심볼이 undefined 가 되고, 호출부에 이미 있는 null 검사/try-catch 가 no-op 경로를 탄다.
      res({});
    }, ${IMPORT_TIMEOUT_MS});
  });
  const settled = p.then(
    (m) => { clearTimeout(t); return m; },
    (e) => { clearTimeout(t); throw e; },
  );
  return Promise.race([settled, timed]);
};
// --- end OMC local patch
`;

const semverDesc = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
};
const installedVersions = () =>
  existsSync(CACHE) ? readdirSync(CACHE).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(semverDesc) : [];

// 실제 활성 버전은 Claude Code 가 읽는 installed_plugins.json 이 정한다(자동 업데이트로
// 캐시에 더 새 버전이 생겨도 TARGET_VERSION 이 활성이라는 보장은 없다). version 필드 →
// installPath 마지막 구간 → 옛 규칙(TARGET 이 캐시에 있으면 TARGET, 아니면 최신) 순으로 본다.
function activeVersion() {
  const versions = installedVersions();
  const found = entryVersion(installedEntry(), versions);
  if (found) return found;
  return { v: versions.includes(TARGET_VERSION) ? TARGET_VERSION : versions[0] || TARGET_VERSION, src: "추정: installed_plugins.json 에서 확인 못 함" };
}

// installed_plugins.json 의 omc 항목. 읽기·파싱 실패는 null(옛 규칙으로).
function installedEntry() {
  try { return JSON.parse(readFileSync(INSTALLED, "utf8")).plugins?.[PLUGIN_KEY]?.[0] || null; }
  catch { return null; }
}

// 항목의 version 필드, 없으면 installPath 마지막 구간. 캐시에 있는 판이어야 한다.
function entryVersion(e, versions) {
  if (!e) return null;
  if (typeof e.version === "string" && /^\d+\.\d+\.\d+$/.test(e.version) && versions.includes(e.version)) return { v: e.version, src: "installed_plugins.json" };
  const last = typeof e.installPath === "string" ? e.installPath.split(/[\\/]+/).filter(Boolean).pop() : null;
  if (last && versions.includes(last)) return { v: last, src: "installed_plugins.json installPath" };
  return null;
}

// git 이 일할 저장소를 cwd 와 상관없이 정하는 변수. git 훅처럼 GIT_DIR 을 내보낸 셸에서 이 도구를 부르면
// 마켓플레이스가 아니라 그 저장소의 origin 을 고정했다(/tmp 에서 재현). git 이 다른 저장소로 옮겨 갈 때
// 지우는 목록(`git rev-parse --local-env-vars`, git 2.43)과 같다. Windows 는 변수 이름의 대소문자를 가리지 않는다.
const GIT_REPO_VARS = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);
// 마켓플레이스의 .git 이 깨졌으면(중단된 clone) git 은 위로 올라가 다음 저장소(dotfiles 로 관리하는 ~/.claude 등)를
// 고른다. 바로 위 폴더를 천장(GIT_CEILING_DIRECTORIES)으로 두어 마켓플레이스 밖으로 나가지 못하게 한다.
// 마켓플레이스가 링크면 실제 경로 쪽 위 폴더도 막는다. 셸에 있던 천장 값은 대소문자와 상관없이 이 값으로 바꾼다.
const gitEnv = () => {
  const drop = (k) => GIT_REPO_VARS.has(k.toUpperCase()) || k.toUpperCase() === "GIT_CEILING_DIRECTORIES";
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop(k)));
  env.GIT_CEILING_DIRECTORIES = [...new Set([dirname(MARKET), dirname(realOr(MARKET))])].join(PATH_LIST_SEP);
  return env;
};

function git(args, cwd = MARKET) {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ── 1. 업데이트 ──────────────────────────────────────────────────────────────
function ensureVersion() {
  const have = installedVersions();
  if (have.includes(TARGET_VERSION)) { ok(`${TARGET_VERSION} 설치되어 있음`); return true; }
  if (MODE === "check") { bad(`${TARGET_VERSION} 미설치 (설치된 버전: ${have.join(", ") || "없음"})`); return false; }
  if (!canInstallTarget()) return false;

  log(`  ${TARGET_VERSION} 설치 중...`);
  const sha = targetSha();
  if (sha === null) return false;
  const dest = join(CACHE, TARGET_VERSION);
  unpackTarget(dest);
  linkNodeModules(dest, have);
  return switchActive(sha, have);
}

// 마켓플레이스가 제 git 저장소이고 git 과 tar 가 있어야 TARGET_VERSION 을 꺼낼 수 있다.
function canInstallTarget() {
  if (!existsSync(MARKET)) { bad(`마켓플레이스 없음: ${MARKET}\n      Claude Code 에서 marketplace 를 먼저 추가하십시오: ${REPO_URL}`); return false; }
  if (!existsSync(join(MARKET, ".git"))) { bad(`마켓플레이스 폴더가 git 저장소가 아님: ${MARKET}`); return false; }

  // git 과 tar 에 의존한다. Windows 10+ / macOS / 대부분의 Linux 배포판에는 둘 다 있지만,
  // 최소 설치 컨테이너나 tar 없는 환경에서는 없을 수 있다. 여기서 못 찾으면 아래에서
  // execFileSync 가 ENOENT 로 죽어 원인이 안 보이므로, 먼저 확인하고 무엇이 없는지 말한다.
  for (const [cmd, why] of [["git", "마켓플레이스에서 소스를 꺼내는 데"], ["tar", "그 소스를 푸는 데"]]) {
    try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); }
    catch { bad(`${cmd} 를 찾을 수 없습니다 (${why} 필요). 설치한 뒤 다시 실행하거나, --no-update 로 패치만 적용하십시오.`); return false; }
  }
  return true;
}

// 태그 v<TARGET_VERSION> 의 커밋. 못 찾으면 null.
function targetSha() {
  try { git(["fetch", "--tags", "--quiet", "origin"]); } catch { /* 오프라인이어도 로컬 태그가 있으면 진행 */ }
  try { return git(["rev-parse", `v${TARGET_VERSION}^{}`]); }
  catch { bad(`태그 v${TARGET_VERSION} 를 마켓플레이스에서 찾을 수 없음`); return null; }
}

// git archive | tar 로 소스를 편다. 저장소에 dist/ 가 포함되어 빌드는 불필요하다.
function unpackTarget(dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  git(["archive", `v${TARGET_VERSION}`, "-o", join(dest, "_src.tar")]);
  execFileSync("tar", ["-xf", join(dest, "_src.tar"), "-C", dest], { stdio: "ignore" });
  unlinkSync(join(dest, "_src.tar"));
}

// node_modules 는 복사하지 않고 직전 버전 것을 링크한다. Windows 는 junction
// (관리자 권한 불필요), POSIX 는 type 인자가 무시되고 디렉터리 symlink 가 된다.
function linkNodeModules(dest, have) {
  const prev = have.find((v) => v !== TARGET_VERSION);
  const nm = join(dest, "node_modules");
  if (!existsSync(nm) && prev && existsSync(join(CACHE, prev, "node_modules"))) {
    try { symlinkSync(join(CACHE, prev, "node_modules"), nm, "junction"); ok(`node_modules → ${prev} 링크`); }
    catch (e) { bad(`node_modules 링크 실패(${e.code}). \`npm install\` 이 필요할 수 있음`); }
  } else if (!existsSync(nm)) {
    bad(`node_modules 없음. ${dest} 에서 \`npm install --omit=dev\` 를 실행하십시오`);
  }
}

// 활성 버전 전환
function switchActive(sha, have) {
  const j = JSON.parse(readFileSync(INSTALLED, "utf8"));
  const e = j.plugins?.[PLUGIN_KEY]?.[0];
  if (!e) { bad(`installed_plugins.json 에 ${PLUGIN_KEY} 항목이 없음 — 수동 확인 필요`); return false; }
  if (!existsSync(`${INSTALLED}.omcbak`)) copyFileSync(INSTALLED, `${INSTALLED}.omcbak`);
  const sep = e.installPath.includes("//") ? "//" : e.installPath.includes("\\") ? "\\" : "/";
  e.installPath = e.installPath.split(sep).slice(0, -1).concat(TARGET_VERSION).join(sep);
  e.version = TARGET_VERSION;
  e.gitCommitSha = sha;
  e.lastUpdated = new Date().toISOString();
  writeFileSync(INSTALLED, JSON.stringify(j, null, 2) + "\n", "utf8");
  ok(`${have[0] || "없음"} → ${TARGET_VERSION} (sha ${sha.slice(0, 12)})`);
  return true;
}

// ── 2. 훅 패치 ───────────────────────────────────────────────────────────────
function hookNames(root) {
  const files = [join(root, "hooks", "hooks.json"), `${join(root, "hooks", "hooks.json")}.omcbak`];
  const src = files.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("");
  return [...new Set([...src.matchAll(/scripts\/([\w-]+)\.mjs/g)].map((m) => m[1]))].sort();
}

// ── 어디가 «진짜» 모듈 최상위인가 ────────────────────────────────────────────
// 예전 판정은 "`function main(` 보다 텍스트상 앞이면 top-level" 이었다. 이것은 틀렸다.
// 실측으로 v5.3.0 의 대상 16곳 중 5곳이 다른 함수 몸통 안이었고(recordToolInvocation,
// loadRuntimeModules ×2, runSessionEndHook, runWikiSessionEndHook), 그 자리들은 모듈
// 평가를 막지 못한다 — 이미 try/catch 안이라 실패해도 훅은 끝까지 간다. 거기에 예산을
// 걸면 «정상이지만 느린» 호출만 잘라낸다(실측: session-end 가 4초 지연에서 조용히 스킵).
//
// 그래서 문자열·템플릿·주석·정규식을 건너뛰며 중괄호를 세고, 각 중괄호가 «함수 몸통» 인지
// 단순 «블록» 인지 구분해 함수 스택을 유지한다. 함수 스택이 빈 상태에서 나온 await import
// 만 진짜 최상위다 — 최상위 `try { }` 안에 있어도 최상위다(persistent-mode 가 그렇다).
const ID_CH = /[A-Za-z0-9_$]/;
const BLOCK_KW = new Set(["if", "for", "while", "switch", "catch", "with", "do"]);
const REGEX_PREV_CH = new Set("(,=:[!&|?{};+-*%~^".split(""));
const REGEX_PREV_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete",
  "void", "case", "do", "else", "yield", "await"]);

// probe(i, fnStack) 를 주면 코드 글자(문자열·주석·정규식·중괄호가 아닌 자리)마다 부른다.
// --scan 이 같은 토크나이저로 헬퍼 선언의 깊이를 재는 데 쓴다. 패치 경로는 probe 없이 부른다.
function scanTopLevelAwaitImports(src, probe) {
  const s = { src, n: src.length, i: 0, prev: "", prevIdx: -1, fnStack: [], hits: [] };
  while (s.i < s.n) {
    if (!skipNonCode(s)) stepCode(s, probe);
  }
  return s.hits;
}

const wordEndingAt = (src, j) => {
  const e = j;
  while (j >= 0 && ID_CH.test(src[j])) j--;
  return src.slice(j + 1, e + 1);
};

// j 에서 거꾸로 공백과 /* */ 주석을 건너뛴 자리. 주석의 시작이 없으면 -1.
function backSkip(src, j) {
  for (;;) {
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (!(j >= 1 && src[j] === "/" && src[j - 1] === "*")) return j;  // */ 로 끝나는 주석이 아님
    const s = src.lastIndexOf("/*", j - 1);
    if (s < 0) return -1;
    j = s - 1;
  }
}

// 아래 함수들은 토크나이저 상태 s 를 함께 쓴다. src 와 n(길이), i(지금 자리), prev 와
// prevIdx(직전 코드 글자와 그 자리), fnStack(열린 중괄호마다 함수 몸통이면 true), hits.

// 주석, 문자열, 공백, 정규식이면 건너뛰고 true. 코드 글자면 그대로 두고 false.
function skipNonCode(s) {
  const c = s.src[s.i];
  if (skipComment(s)) return true;
  if (c === "'" || c === '"' || c === "`") { skipString(s, c); s.prev = c; return true; }
  if (/\s/.test(c)) { s.i++; return true; }
  if (c === "/" && startsRegex(s)) { skipRegex(s); return true; }
  return false;
}

function skipComment(s) {
  const { src, n } = s;
  if (src[s.i] !== "/") return false;
  if (src[s.i + 1] === "/") {
    while (s.i < n && src[s.i] !== "\n") s.i++;
    return true;
  }
  if (src[s.i + 1] !== "*") return false;
  const e = src.indexOf("*/", s.i + 2);
  s.i = e < 0 ? n : e + 2;
  return true;
}

// s.i 는 여는 따옴표. 닫는 따옴표 다음으로 옮긴다. 템플릿의 ${ } 는 skipTemplateExpr 가 맡는다.
function skipString(s, q) {
  const { src, n } = s;
  s.i++;
  while (s.i < n) {
    const c = src[s.i];
    if (c === "\\") { s.i += 2; continue; }
    if (c === q) { s.i++; return; }
    if (q === "`" && c === "$" && src[s.i + 1] === "{") { skipTemplateExpr(s); continue; }
    s.i++;
  }
}

// s.i 는 ${ 의 $. 짝 맞는 } 다음으로 옮긴다. 그 안의 문자열은 다시 skipString 으로 건너뛴다.
function skipTemplateExpr(s) {
  const { src, n } = s;
  s.i += 2;
  let d = 1;
  while (s.i < n && d > 0) {
    const k = src[s.i];
    if (k === "\\") { s.i += 2; continue; }
    if (k === "'" || k === '"' || k === "`") { skipString(s, k); continue; }
    if (k === "{") d++;
    else if (k === "}") d--;
    s.i++;
  }
}

// 여기의 / 가 나눗셈이 아니라 정규식을 여는가. 직전 코드 글자나 직전 낱말로 정한다.
function startsRegex(s) {
  const { src, prev, prevIdx } = s;
  return prev === "" || REGEX_PREV_CH.has(prev)
    || (prevIdx >= 0 && ID_CH.test(prev) && REGEX_PREV_KW.has(wordEndingAt(src, prevIdx)));
}

// s.i 는 정규식을 여는 /. 닫는 / 와 플래그 다음으로 옮긴다. 줄이 끝나면 거기서 멈춘다.
function skipRegex(s) {
  const { src, n } = s;
  s.i++;
  let inClass = false;
  while (s.i < n) {
    const k = src[s.i];
    if (k === "\\") { s.i += 2; continue; }
    if (k === "[") inClass = true;
    else if (k === "]") inClass = false;
    else if (k === "/" && !inClass) { s.i++; break; }
    else if (k === "\n") break;
    s.i++;
  }
  skipWord(s);                                                       // 플래그
  s.prev = "/"; s.prevIdx = s.i - 1;
}

function skipWord(s) {
  while (s.i < s.n && ID_CH.test(s.src[s.i])) s.i++;
}

// 코드 글자 하나. 중괄호면 함수 스택을 바꾸고, 함수 밖의 `await import(` 면 hits 에 넣는다.
function stepCode(s, probe) {
  const { src } = s;
  const c = src[s.i];
  if (c === "{" || c === "}") {
    if (c === "{") s.fnStack.push(isFunctionBrace(src, s.i));
    else s.fnStack.pop();
    s.i++; s.prev = c; s.prevIdx = s.i - 1;
    return;
  }
  if (c === "a" && isAwaitImportAt(src, s.i) && !s.fnStack.some(Boolean)) s.hits.push(s.i);
  if (probe) probe(s.i, s.fnStack);
  s.prev = c; s.prevIdx = s.i; s.i++;
}

const isAwaitImportAt = (src, i) => !(i > 0 && ID_CH.test(src[i - 1])) && /^await\s+import\s*\(/.test(src.slice(i, i + 40));

// 이 중괄호가 «함수 몸통» 을 여는가
function isFunctionBrace(src, at) {
  let j = backSkip(src, at - 1);
  if (j < 0) return false;
  if (src[j] === ">" && src[j - 1] === "=") return true;             // () => {
  if (src[j] !== ")") return false;                                  // class/객체/블록
  j = openParenOf(src, j);                                           // 짝 맞는 ( 찾기
  if (j < 0) return false;
  const k = backSkip(src, j - 1);
  if (k < 0 || !ID_CH.test(src[k])) return false;
  return !BLOCK_KW.has(wordEndingAt(src, k));                        // if/for/while/catch… 은 블록
}

// j 의 ) 와 짝인 ( 의 자리. 없으면 -1.
function openParenOf(src, j) {
  let d = 0;
  for (; j >= 0; j--) {
    if (src[j] === ")") d++;
    else if (src[j] === "(" && --d === 0) return j;
  }
  return -1;
}

// 자리별 상태. 이미 손으로 Promise.race 를 두른 자리는 건드리지 않는다(4.15.7 에 그런 것이 둘 있다).
// 이미 감싼 파일이라도 헬퍼가 쓰일 수 없는 자리면(옛 판의 자리) «패치됨» 이 아니라 «misplaced» 다.
// 그 상태를 «패치됨» 으로 넘기면 --check 가 결함 트리에 «모두 적용» 을 낸다(2026-10-12 실측).
function siteInfo(src) {
  if (src.includes("__omcRaceImport")) {
    const why = helperDefect(scanFacts(src));
    return why ? { state: "misplaced", sites: [], why } : { state: "patched", sites: [] };
  }
  const all = scanTopLevelAwaitImports(src);
  if (!all.length) return { state: "n/a", sites: [] };
  const open = all.filter((p) => !/Promise\.race/.test(src.slice(Math.max(0, p - 300), p)));
  if (!open.length) return { state: "guarded", sites: [] };
  return { state: "needs", sites: open };
}

// 헬퍼가 쓰일 수 없는 자리면 그 이유를, 제자리면 null 을 낸다.
//   - 선언이 블록 안(깊이 1 이상): 다른 블록의 자리에서 ReferenceError(옛 킷이 남긴 자리)
//   - 선언을 못 찾음: 이름만으로는 «패치됨» 이라 할 근거가 없다. 앞쪽 글을 토크나이저가 잘못
//     읽어 선언이 문자열 안으로 보였을 수도 있다
//   - 최상위 사용이 선언보다 앞: 그 자리가 먼저 돌아 const, let 은 TDZ 의 ReferenceError, var 는
//     undefined 호출. function 선언은 끌어올려져 앞에서 불러도 된다. 순서는 줄이 아니라 글자 자리로 본다
function helperDefect({ helperDecls, wrapped }) {
  const inBlock = helperDecls.find((d) => d.depth !== 0);
  if (inBlock) return `헬퍼 선언 :${inBlock.line} 이 블록 안, 깊이 ${inBlock.depth}`;
  if (!helperDecls.length) return "헬퍼 선언을 찾지 못함";
  const decl = helperDecls[0];
  const first = wrapped.find((w) => !w.inFunction);
  if (first && first.at < decl.at && decl.kind !== "function") return `헬퍼 선언 :${decl.line} 이 첫 사용 :${first.line} 보다 뒤`;
  return null;
}

function transform(src) {
  const info = siteInfo(src);
  if (info.state !== "needs") return null;
  const edits = importSpans(src, info.sites);
  if (!edits.length) return null;
  let out = src;
  for (const e of edits.reverse()) {
    const expr = out.slice(e.start + out.slice(e.start).indexOf("import"), e.end + 1);
    out = `${out.slice(0, e.start)}await __omcRaceImport(${expr})${out.slice(e.end + 1)}`;
  }
  // 헬퍼는 모듈 맨 앞(셔뱅 줄이 있으면 그 다음)에 넣는다. "첫 사용 지점의 줄 시작" 앞에 넣던
  // 예전 방식은 그 지점이 최상위 `try { }` 같은 블록 안이면 헬퍼도 그 블록에 갇혀, 다른 블록의
  // 자리에서 ReferenceError 가 났다(OMC 5.6.x project-memory-session.mjs. 훅의 catch 가 삼켜
  // 기능이 조용히 꺼졌다). 정적 import 는 끌어올려지므로 그 앞에 두어도 되고, 여러 줄
  // `import {` ... `} from` 한가운데를 뚫을 일도 없다.
  if (!out.includes("await __omcRaceImport")) return null;
  const ls = out.startsWith("#!") ? out.indexOf("\n") + 1 : 0;
  return out.slice(0, ls) + HELPER + out.slice(ls);
}

// 감쌀 자리마다 `await` 에서 import( 의 짝 맞는 ) 까지.
function importSpans(src, sites) {
  const edits = [];
  for (const start of sites) {
    const end = closingParenOf(src, src.indexOf("(", src.indexOf("import", start)));
    if (end !== -1) edits.push({ start, end });
  }
  return edits;
}

// open 의 ( 와 짝인 ) 의 자리. 없으면 -1.
function closingParenOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

// ── 읽기 전용 진단 (--scan) ──────────────────────────────────────────────────
// 패치가 «제자리» 에 앉았는지를 위 토크나이저 하나로 잰다. 시험이 토크나이저를 따로 가지면
// 패치가 고르는 자리와 시험이 재는 자리가 서로 다른 규칙을 따르게 된다.
//   helperDecls  헬퍼 선언마다 { line, depth }. depth 는 둘러싼 중괄호 수(함수 몸통과 블록).
//                0 이어야 최상위 문장이다. 블록 안 const 는 블록 범위라 다른 블록의 자리에서
//                ReferenceError 가 나고, 훅의 catch 가 그것을 삼킨다(옛 자리 결함).
//   wrapped      `await __omcRaceImport(` 자리마다 { line, inFunction }. 패치는 최상위 자리만 감싼다.
//   unwrapped    아직 감싸지지 않은 최상위 `await import(` 의 줄.
function scanFacts(src) {
  const lineOf = (at) => src.slice(0, at).split("\n").length;
  const helperDecls = [], wrapped = [];
  const unwrapped = scanTopLevelAwaitImports(src, (i, fnStack) => {
    const ch = src[i];
    if (ch !== "c" && ch !== "l" && ch !== "v" && ch !== "f" && ch !== "a") return;
    if (i > 0 && ID_CH.test(src[i - 1])) return;
    const head = src.slice(i, i + 48);
    const decl = /^(const|let|var|function)\s+__omcRaceImport\b/.exec(head);
    if (decl) helperDecls.push({ line: lineOf(i), depth: fnStack.length, at: i, kind: decl[1] });
    else if (/^await\s+__omcRaceImport\s*\(/.test(head)) wrapped.push({ line: lineOf(i), inFunction: fnStack.some(Boolean), at: i });
  }).map(lineOf);
  return { helperDecls, wrapped, unwrapped };
}

// --scan 이 내는 칸. at 과 kind 는 판정용이라 내보내지 않는다(출력 형식은 그대로 둔다).
const publicFacts = ({ helperDecls, wrapped, unwrapped }) => ({
  helperDecls: helperDecls.map(({ line, depth }) => ({ line, depth })),
  wrapped: wrapped.map(({ line, inFunction }) => ({ line, inFunction })),
  unwrapped,
});

function syntaxError(file) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] }); return null; }
  catch (e) {
    const msg = String(e.stderr || e.message || "");
    return (msg.split("\n").find((l) => /SyntaxError|Error:/.test(l)) || msg.split("\n")[0] || "unknown").trim().slice(0, 110);
  }
}

// 이 도구가 아닌 «손» 이 import 를 감싼 흔적. 우리 헬퍼는 안 쓰고 Promise.race 를
// import 바로 앞에 직접 붙인 모양이다.
const looksHandPatched = (src) =>
  !src.includes("__omcRaceImport") && /Promise\.race\s*\(\s*\[?[\s\S]{0,120}?\bimport\s*\(/.test(src);

function patchHooks(root) {
  const r = { done: 0, skip: 0, fail: 0, need: 0, misplaced: 0, foreign: [], orphan: [], failed: [] };
  // revert 는 scripts/ 전체를 훑는다. hooks.json 기반 목록은 두 번 새는데, 실측으로
  // 4.15.7 이 둘 다 겪었다 — PostToolUse 를 지우면 그 스크립트가 목록에서 빠지고(그래서
  // .omcbak 이 있어도 안 돌아온다), 손으로 고친 파일은 .omcbak 조차 없어 아예 안 보인다.
  const names = MODE === "revert"
    ? readdirSync(join(root, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort()
    : hookNames(root);
  for (const n of names) {
    const f = join(root, "scripts", `${n}.mjs`);
    if (!existsSync(f)) continue;
    if (MODE === "revert") revertScript(root, n, f, r);
    else checkOrPatchScript(root, n, f, r);
  }
  return r;
}

function revertScript(root, n, f, r) {
  const bak = `${f}.omcbak`;
  if (existsSync(bak)) {
    const why = whyNotWrite(root, f, bak);
    if (why) { bad(`되돌리지 않음: ${shown(n)} (${why})`); r.fail++; r.failed.push(f); return; }
    copyFileSync(bak, f); unlinkSync(bak); log(`  되돌림  ${shown(n)}`); r.done++; return;
  }
  // 백업이 없는데 이미 감싸여 있으면 되돌릴 원본이 디스크에 없다. 조용히 넘기지 않고 이름을 댄다.
  //   - 우리 헬퍼가 있으면: 이 도구나 옛 킷이 고쳤는데 백업이 사라진 파일(복사해 온 폴더 등)
  //   - 손 패치: `await import(` 를 `await Promise.race([import(` 로 «바꿔치기» 해서 await import
  //     패턴 자체가 사라진다. siteInfo 로는 잡히지 않아 원문에서 직접 찾는다(실측: 4.15.7 의 두 파일)
  const src = readFileSync(f, "utf8");
  if (src.includes("__omcRaceImport")) r.orphan.push(n);
  else if (looksHandPatched(src)) r.foreign.push(n);
}

function checkOrPatchScript(root, n, f, r) {
  const info = siteInfo(readFileSync(f, "utf8"));
  // 헬퍼 자리 결함은 check 와 apply 모두 이름을 댄다. 이미 감싼 파일이라 transform 으로는
  // 고칠 수 없으므로 apply 도 건드리지 않고, 되돌린 뒤 다시 적용하라고 안내한다(misplacedHint).
  if (info.state === "misplaced") { bad(`헬퍼 자리 결함: ${n} (${info.why})`); r.misplaced++; return; }
  if (info.state !== "needs") { r.skip++; return; }
  if (MODE === "check") { bad(`패치 필요: ${n}`); r.need++; return; }

  const bak = `${f}.omcbak`;
  const why = whyNotWrite(root, f, bak);
  if (why) { bad(`쓰지 않음: ${n} (${why})`); r.fail++; return; }
  const out = transform(readFileSync(f, "utf8"));
  if (!out) { bad(`변환 실패: ${n}`); r.fail++; return; }
  if (!existsSync(bak)) copyFileSync(f, bak);
  writeFileSync(f, out, "utf8");
  const err = syntaxError(f);
  if (err) { copyFileSync(bak, f); bad(`문법오류로 롤백: ${n}\n      ${err}`); r.fail++; return; }
  r.done++;
}

// 쓰기 전에 본다. 쓸 파일이 (링크를 따라가서) 플러그인 폴더 밖이거나 백업 자리가 링크면 그 이유를,
// 아니면 null. 백업 자리가 깨진 링크면 existsSync 는 false 라, copyFileSync 가 링크가 가리키는 곳에 쓴다.
function whyNotWrite(root, file, bak) {
  if (isLink(bak)) return "백업 자리가 링크";
  if (!insideRoot(root, file)) return "파일이 플러그인 폴더 밖에 있음";
  return null;
}

const isLink = (p) => {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
};

// 실제 경로로 p 가 root 안인가. 버전 폴더 자체가 링크(옛 판이 새 판을 가리킴)여도 root 를 같이
// 풀므로 맞다. Windows 는 경로의 대소문자를 구분하지 않아 소문자로 비교한다.
function insideRoot(root, p) {
  const fold = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
  try { return fold(realpathSync(p)).startsWith(fold(realpathSync(root)) + PATH_SEP); }
  catch { return false; }
}

// 실제 경로. 풀 수 없으면 받은 그대로.
const realOr = (p) => {
  try { return realpathSync(p); } catch { return p; }
};

// 같은 파일인지 셀 때 쓰는 열쇠. Windows 는 경로의 대소문자를 가리지 않아 소문자로 접는다. junction 이 대상을
// 캐시 경로와 다른 글자로 적어 두면 같은 파일이 다른 철자로 풀리기 때문이다.
const fileKey = (p) => (process.platform === "win32" ? realOr(p).toLowerCase() : realOr(p));

// ── 3. PostToolUse 훅 제거 ───────────────────────────────────────────────────
function patchHooksJson(root) {
  const hj = join(root, "hooks", "hooks.json");
  if (!existsSync(hj)) return "no-file";
  if (MODE !== "check") {
    const why = whyNotWrite(root, hj, `${hj}.omcbak`);
    if (why) { bad(`hooks.json 을 건드리지 않음 (${why})`); return "unsafe"; }
  }
  return MODE === "revert" ? revertHooksJson(root, hj) : removePostToolUse(hj);
}

// 되돌린 결과. ambiguous 와 linked 는 hooks.json 을 되돌리지 못하고 남긴 것이라 끝 줄이 센다.
function revertHooksJson(root, hj) {
  const bak = `${hj}.omcbak`;
  if (existsSync(bak)) { copyFileSync(bak, hj); unlinkSync(bak); log("  되돌림  hooks.json"); return "reverted"; }
  // 이 도구의 백업이 없을 때 PostToolUse 가 그대로면 되돌릴 것이 없다. 옆의 수동 백업으로 덮어쓰면
  // 지금 내용을 잃는다.
  if (hasPostToolUse(hj)) return "no-backup";
  // 손으로 만든 백업이 남아 있을 수 있다(실측: 4.15.7 의 hooks.json.bak-20260906-postoolremove).
  // PostToolUse 를 담고 있는 유효한 JSON 이 딱 하나면 그것이 제거 직전 상태다 — 무엇을 썼는지 밝히고 되돌린다.
  const dir = dirname(hj);
  const { usable, unsafe } = manualBackups(root, dir);
  if (unsafe.length) bad(`hooks.json 수동 백업 후보가 링크이거나 플러그인 폴더 밖이라 쓰지 않음: ${unsafe.map(shown).join(", ")}`);
  if (usable.length === 1) {
    copyFileSync(join(dir, usable[0]), hj);
    log(`  되돌림  hooks.json  (수동 백업 사용: ${shown(usable[0])})`);
    return "reverted";
  }
  if (usable.length > 1) { bad(`hooks.json 수동 백업이 여러 개라 자동 복구하지 않음: ${usable.map(shown).join(", ")}`); return "ambiguous"; }
  return unsafe.length ? "linked" : "no-backup";
}

// 파일에서 읽은 값(파일 이름, PINNED 의 host)을 출력에 넣을 때 쓴다. 줄바꿈과 제어 문자를 ? 로 바꾸고 길이를 자른다.
// SKILL 은 [!] 줄을 그대로 보고하라고 하므로, 값이 제 줄을 새로 시작하면 도구가 낸 줄처럼 읽힌다.
// 줄을 바꾸거나 글자 순서를 바꾸는 문자: C0 과 C1 제어 문자, 폭 없는 공백과 방향 표시, 줄과 문단 구분자,
// 방향 덮어쓰기와 격리, BOM. oneLine 은 길이를 두고(URL), shown 은 120자로 자른다(이름, host).
const UNSAFE_CH = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
const oneLine = (s) => String(s).replace(UNSAFE_CH, "?");
const shown = (s) => oneLine(s).slice(0, 120);

// hooks.json 옆의 수동 백업 후보. usable 은 PostToolUse 를 담은 유효한 JSON 이다. 링크로 심은 후보는
// unsafe 로 따로 두고 읽지도 않는다. 폴더 밖 파일(PostToolUse 키가 있는 settings.json 등)이 hooks.json 이 된다.
function manualBackups(root, dir) {
  const usable = [], unsafe = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("hooks.json.") || f === "hooks.json.omcbak") continue;
    const p = join(dir, f);
    if (isLink(p) || !insideRoot(root, p)) unsafe.push(f);
    else if (hasPostToolUse(p)) usable.push(f);
  }
  return { usable, unsafe };
}

const hasPostToolUse = (p) => {
  try { return !!JSON.parse(readFileSync(p, "utf8"))?.hooks?.PostToolUse; }
  catch { return false; }
};

function removePostToolUse(hj) {
  const bak = `${hj}.omcbak`;
  const j = JSON.parse(readFileSync(hj, "utf8"));
  if (!j.hooks?.PostToolUse) return "already";
  const list = j.hooks.PostToolUse.flatMap((g) => (g.hooks || []).map((h) => (h.command || "").match(/([\w-]+)\.mjs/)?.[1] || "?"));
  if (MODE === "check") { bad(`hooks.json PostToolUse 남아있음: ${list.join(", ")}`); return "needs"; }
  if (!existsSync(bak)) copyFileSync(hj, bak);
  delete j.hooks.PostToolUse;
  writeFileSync(hj, JSON.stringify(j, null, 2) + "\n", "utf8");
  try { JSON.parse(readFileSync(hj, "utf8")); return list; }
  catch { copyFileSync(bak, hj); bad("hooks.json 손상으로 롤백"); return "failed"; }
}

// ── 4. 자동 업데이트 차단 ────────────────────────────────────────────────────
//
// Claude Code 는 마켓플레이스 git 저장소를 갱신한 뒤 플러그인을 새 버전으로
// 올릴 수 있다. 그러면 위 패치가 통째로 덮어써진다. 로컬에서 막을 수 있는
// 지점은 "마켓플레이스 저장소가 새 커밋을 가져오지 못하게" 하는 것뿐이다.
// origin remote 의 URL 을 무효 주소로 바꿔 fetch 를 실패시킨다(원래 URL 은
// `omc-pinned://` 뒤에 그대로 남기고 --revert 가 거기서 복구한다. PINNED 파일은 기록이다).
// 저장소 자체는 그대로라 이미 받은 태그로 재설치·검증이 가능하다.
function pinMarketplace() {
  if (!existsSync(MARKET)) return "no-marketplace";
  // 마켓플레이스 폴더가 제 git 저장소가 아니면 git 이 위쪽 저장소(예: dotfiles 로 관리하는
  // ~/.claude)를 찾아 그 origin 을 바꾼다. 제 .git 이 있을 때만 고정하고 되돌린다. .git 이 있어도
  // 깨졌으면 git 이 위로 올라가는데, 그것은 gitEnv 의 천장이 막는다(origin 을 못 읽어 no-remote).
  if (!existsSync(join(MARKET, ".git"))) return "no-git";
  let url;
  try { url = git(["remote", "get-url", "origin"]); } catch { return "no-remote"; }

  if (MODE === "revert") return unpinMarketplace(url);
  if (url.startsWith("omc-pinned://")) return "already";
  if (MODE === "check") { bad(`마켓플레이스 미고정 (origin=${oneLine(url)})`); return "needs"; }

  mkdirSync(dirname(PINFILE), { recursive: true });
  // host 를 남긴다. 이 폴더는 통째로 복사해 배포하므로 PINNED 도 같이 딸려 가는데,
  // PINFILE 은 스크립트 위치가 아니라 homedir() 기준이라 남의 기록인 줄 모르고 쓰기 쉽다.
  writeFileSync(PINFILE, JSON.stringify({ originUrl: url, pinnedAt: new Date().toISOString(), version: TARGET_VERSION, host: hostname() }, null, 2) + "\n", "utf8");
  git(["remote", "set-url", "origin", `omc-pinned://${url}`]);
  return "pinned";
}

// 원본 URL 은 현재 origin 안에 그대로 들어 있다(`omc-pinned://` + 원본). 거기서만 복원한다.
// PINNED 의 값으로 origin 을 쓰지 않는다. PINNED 는 배포 폴더에 같이 딸려 오므로 다른 PC 의 값일 수 있고,
// host 가 없는 기록은 어느 기기의 것인지 모른다. origin 이 고정 상태가 아니면 되돌릴 것도 없다.
function unpinMarketplace(url) {
  const PIN_PREFIX = "omc-pinned://";
  if (existsSync(PINFILE)) dropPinRecord();
  const restored = url.startsWith(PIN_PREFIX) ? url.slice(PIN_PREFIX.length) : "";
  if (!restored) return "not-pinned";
  try { git(["remote", "set-url", "origin", restored]); } catch { /* noop */ }
  return "unpinned";
}

// PINNED 를 지운다. 다른 기기의 기록이면 알린다. 깨진 기록(JSON 이 아니거나, null 처럼 객체가 아닌 값)은 말없이 지운다.
function dropPinRecord() {
  let saved = null;
  try { saved = JSON.parse(readFileSync(PINFILE, "utf8")); } catch { /* 깨졌으면 무시 */ }
  unlinkSync(PINFILE);
  if (saved && typeof saved === "object" && saved.host && saved.host !== hostname()) {
    bad(`PINNED 는 다른 기기(${shown(saved.host)})의 기록입니다 — 그 값은 쓰지 않습니다.`);
  }
}

// --root 폴더의 이름표. .claude-plugin/plugin.json 의 name 이 있으면 그것으로, 없으면 package.json 의 name
// 으로 정한다. OMC 가 아니면 그 설명을, 아니면 null. 둘 다 없거나 읽을 수 없으면 확인할 길이 없어 null 이다
// (번들 사본에는 없을 수 있다). 다른 폴더를 잘못 준 실수를 막는 확인이다. 폴더 밖 쓰기를 막는 것은 whyNotWrite.
const OMC_NAMES = [[".claude-plugin/plugin.json", "oh-my-claudecode"], ["package.json", "oh-my-claude-sisyphus"]];
function otherPluginName(root) {
  for (const [rel, want] of OMC_NAMES) {
    let name;
    try { name = JSON.parse(readFileSync(join(root, rel), "utf8")).name; } catch { continue; }
    if (name === undefined) continue;
    if (name === want) return null;
    const quoted = JSON.stringify(name);
    return `${rel} 의 name 이 ${quoted.length > 80 ? `${quoted.slice(0, 80)}...` : quoted}`;
  }
  return null;
}

// ── 인자 확인 ────────────────────────────────────────────────────────────
// 모르는 인자를 말없이 넘기면 --dry-run 이 실제로 적용하고, --root=<폴더> 가 무시돼 --revert 가 모든 판을
// 되돌리고 고정까지 푼다. 아는 꼴이 아니면 아무것도 읽거나 쓰기 전에 멈춘다.
const USAGE = [
  "사용법:",
  `  node omc-patch.mjs              업데이트(${TARGET_VERSION}) + 패치 + 고정`,
  "  node omc-patch.mjs --check      진단만 (아무것도 바꾸지 않음)",
  "  node omc-patch.mjs --revert     패치와 고정 되돌리기",
  "  node omc-patch.mjs --no-update  버전은 그대로 두고 패치만",
  "  node omc-patch.mjs --root <플러그인 폴더> [--check | --revert]",
  "  node omc-patch.mjs --scan <파일>...",
].join("\n");
const FLAGS = new Set(["--check", "--revert", "--no-update"]);

// 인자 목록의 문제, 없으면 null. --scan 은 첫 인자일 때만 뒤를 모두 파일로 본다. --root 는 다음 인자를
// 값으로 가져가고, 값이 없거나 플래그인 경우는 main 의 확인이 맡는다.
function argProblem(list) {
  if (list[0] === "--scan") return null;
  let roots = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (FLAGS.has(a)) continue;
    if (a === "--root") { roots++; i++; continue; }
    if (a === "--scan") return "--scan 은 첫 인자로만 쓸 수 있습니다";
    if (a.startsWith("--root=")) return "--root 와 폴더는 띄어 쓰십시오: --root <폴더>";
    return `알 수 없는 인자: ${shown(a)}`;
  }
  return roots > 1 ? "--root 는 한 번만 쓸 수 있습니다" : null;
}

if (args[0] !== "--scan" && (argv.has("--help") || argv.has("-h"))) { log(USAGE); process.exit(0); }
{
  const problem = argProblem(args);
  if (problem) { bad(problem); log(USAGE); process.exit(1); }
}

// ── --scan: 사실만 내고 끝낸다 ───────────────────────────────────────────────
// 아래 main 보다 먼저 끝나야 한다. 이 모드는 installed_plugins.json 도 플러그인 캐시도 읽지 않는다.
// 결과는 입력 순서대로 JSON 배열 한 줄이다. 동기 쓰기로 내보내야 process.exit 가 잘라먹지 않는다.
if (SCAN_AT >= 0) {
  const files = args.slice(SCAN_AT + 1);
  if (!files.length) { console.error("--scan 뒤에 파일 경로가 필요합니다."); process.exit(1); }
  const out = files.map((file) => {
    try { return { file, ...publicFacts(scanFacts(readFileSync(file, "utf8"))) }; }
    catch (e) { return { file, error: String(e.code || e.message) }; }
  });
  writeSync(1, JSON.stringify(out) + "\n");
  process.exit(out.some((x) => x.error) ? 1 : 0);
}

// ── main ─────────────────────────────────────────────────────────────────────
if (ROOT_AT >= 0 && !ROOT) { bad("--root 뒤에 플러그인 폴더 경로가 필요합니다."); process.exit(1); }
// --check 는 읽기 전용이다. --revert 와 함께 받으면 예전에는 되돌리기가 이겨 파일을 썼다. 무엇도 하지 않고 멈춘다.
if (argv.has("--check") && argv.has("--revert")) {
  bad("--check 와 --revert 는 함께 쓸 수 없습니다. 진단만 하려면 --check 만 주십시오.");
  process.exit(1);
}
log(ROOT
  ? `OMC 패치  (대상 폴더 ${ROOT})  모드: ${MODE}`
  : `OMC 패치  (대상 ${TARGET_VERSION})  모드: ${MODE}${NO_UPDATE ? " --no-update" : ""}`);
log(`플랫폼: ${process.platform}  node ${process.version}`);
log();

// targets 는 «고칠 플러그인 폴더» 의 이름표 목록이다. 기본은 캐시의 판 번호이고, --root 는
// 그 폴더 경로 하나다. rootOf 가 이름표를 폴더로 바꾼다.
let active, targets;
const rootOf = (v) => (ROOT ? v : join(CACHE, v));
// 헬퍼 자리 결함은 이 판의 apply 로 고칠 수 없다(이미 감싼 파일). 원본으로 되돌린 뒤 다시 적용한다.
// 되돌리기는 그 폴더 하나만 한다. 인자 없는 --revert 는 설치된 모든 판을 되돌리고 고정까지 푼다.
// active 는 아래에서 정해지므로 쓰는 자리에서 부른다.
const misplacedHint = () => (ROOT
  ? "--revert --root 로 되돌린 뒤 같은 --root 로 다시 적용하십시오."
  : `--revert --root "${join(CACHE, active)}" 로 활성 폴더만 되돌린 뒤 다시 적용하십시오.`);
if (ROOT) {
  // 그 폴더 하나만 고친다(판 폴더도 installed_plugins.json 도 없는 번들 사본, 또는 활성 캐시 폴더).
  // 판 바꾸기([1/4])와 마켓플레이스 고정([4/4])은 하지 않는다 — 그 둘은 이 PC 의 설정이고 이 폴더의 것이 아니다.
  if (!existsSync(join(ROOT, "hooks", "hooks.json")) || !existsSync(join(ROOT, "scripts"))) {
    bad(`플러그인 폴더가 아님 (hooks/hooks.json 과 scripts/ 가 있어야 함): ${ROOT}`);
    process.exit(1);
  }
  const other = otherPluginName(ROOT);
  if (other) { bad(`OMC 플러그인 폴더가 아님 (${other}): ${ROOT}`); process.exit(1); }
  log("[1/4] 버전");
  log("  건너뜀 (--root 는 판을 바꾸지 않음)");
  active = ROOT;
  targets = [ROOT];
} else {
  if (!existsSync(INSTALLED)) { bad(`Claude Code 플러그인 설정을 찾을 수 없음: ${INSTALLED}`); process.exit(1); }

  log("[1/4] 버전");
  if (NO_UPDATE) log("  건너뜀 (--no-update)");
  else if (MODE === "revert") log("  건너뜀 (revert 는 버전을 되돌리지 않음 — 킷 배포 폴더 README 의 롤백 절차 참고)");
  else if (!ensureVersion() && MODE !== "check") { bad("버전 확보 실패 — 중단"); process.exit(1); }

  const versions = installedVersions();
  // [1/4] 뒤에 계산해야 일반 apply 가 TARGET_VERSION 으로 전환한 결과가 반영된다.
  const { v, src: activeSrc } = activeVersion();
  active = v;
  if (MODE !== "revert" && (MODE === "check" || NO_UPDATE)) {
    log(`  활성 버전: ${active} (${activeSrc})`);
    if (active !== TARGET_VERSION) {
      log(`  활성 버전이 대상(${TARGET_VERSION})과 다름 — 기본 apply 는 ${TARGET_VERSION} 로 전환하고, --no-update 는 활성 버전(${active})을 그 자리에서 패치함`);
    }
  }
  // apply 는 활성 버전만 손댄다. revert 와 check 는 설치된 모든 버전을 훑는다 —
  // 여러 버전이 나란히 있을 때 이전 버전에 수정이 남으면, 롤백했을 때 예상과 다른
  // 상태가 된다(실제로 4.15.7 의 hooks.json 수정이 그렇게 남았다).
  targets = MODE === "apply" ? [active] : (versions.length ? versions : [active]);
  if (!existsSync(join(CACHE, active))) { bad(`설치 경로 없음: ${join(CACHE, active)}`); process.exit(1); }
}

log();
log(`[2/4] 훅 패치${MODE === "apply" || ROOT ? `  (${active})` : `  (대상 ${targets.length}개 버전)`}`);
const r = { done: 0, skip: 0, fail: 0, need: 0, misplaced: 0 };
const needBy = {};
const misplacedBy = {};
const foreignBy = {};
const orphanBy = {};
// 되돌리기 끝 줄이 세는 파일. 쓰지 못한 것(failed)과 백업이 없어 남은 것(left)이다. 링크로 이어진 판 폴더는
// 같은 파일을 여러 이름으로 보이므로 fileKey 로 한 번만 센다. 위 [2/4] 줄의 건수는 판 폴더마다 센다.
const failed = new Set();
const left = new Set();
for (const v of targets) {
  const root = rootOf(v);
  if (!existsSync(root)) continue;
  if (targets.length > 1) log(`  — ${v}`);
  const x = patchHooks(root);
  needBy[v] = x.need;
  misplacedBy[v] = x.misplaced;
  for (const k of ["done", "skip", "fail", "need", "misplaced"]) r[k] += x[k];
  if (x.foreign?.length) foreignBy[v] = x.foreign;
  if (x.orphan?.length) orphanBy[v] = x.orphan;
  for (const n of [...x.foreign, ...x.orphan]) left.add(fileKey(join(root, "scripts", `${n}.mjs`)));
  for (const p of x.failed) failed.add(fileKey(p));
}
log(`  ${MODE === "check" ? `패치 필요 ${r.need}건` : MODE === "revert" ? `되돌림 ${r.done}건${r.fail ? ` / 실패 ${r.fail}건` : ""}` : `패치 ${r.done}건 / 실패 ${r.fail}건`}${r.misplaced ? ` / 헬퍼 자리 결함 ${r.misplaced}건` : ""} / 대상 아님 ${r.skip}건`);
// 백업이 없어 되돌리지 못한 파일은 되돌릴 원본이 디스크에 없다. 조용히 넘기면 «완전히
// 되돌렸다» 는 잘못된 인상을 준다 — 무엇이 남았고 어떻게 되찾는지 정확히 말한다.
function reportNoBackup(v, list, what) {
  bad(`${v}: ${what} — ${list.map(shown).join(", ")}`);
  log(`      백업(.omcbak)이 없어 되돌릴 원본이 디스크에 없습니다. 원본이 필요하면:`);
  if (ROOT) log(`      같은 판의 상류 원본에서 scripts/<이름>.mjs 를 다시 가져오십시오.`);
  else log(`      git -C "${MARKET}" archive v${v} scripts/<이름>.mjs | tar -x -C "${join(CACHE, v)}"`);
}
for (const [v, list] of Object.entries(foreignBy)) reportNoBackup(v, list, "이 도구가 만들지 않은 수정이 남아 있습니다");
for (const [v, list] of Object.entries(orphanBy)) reportNoBackup(v, list, "패치는 있는데 백업이 없어 되돌리지 못했습니다");

log();
log("[3/4] PostToolUse 훅 제거");
const hjNeedBy = {};
for (const v of targets) {
  const root = rootOf(v);
  if (!existsSync(root)) continue;
  const hj = patchHooksJson(root);
  const tag = targets.length > 1 ? `${v}: ` : "";
  if (Array.isArray(hj)) ok(`${tag}제거: ${hj.join(", ")}`);
  else if (hj === "already") ok(`${tag}이미 제거됨`);
  else if (hj === "needs") hjNeedBy[v] = true;
  else if (hj === "reverted" || hj === "ambiguous" || hj === "linked") { /* patchHooksJson 이 출력함 */ }
  else if (hj === "no-backup") ok(`${tag}되돌릴 백업 없음 (이 도구가 지운 적 없음)`);
  else if (hj === "no-file") bad(`${tag}hooks.json 파일 자체가 없음`);
  else if (hj === "unsafe") { r.fail++; failed.add(fileKey(join(root, "hooks", "hooks.json"))); }
  if (hj === "ambiguous" || hj === "linked") left.add(fileKey(join(root, "hooks", "hooks.json")));
}

log();
log("[4/4] 자동 업데이트 차단");
let pin = "skipped";
if (ROOT) {
  log("  건너뜀 (--root 는 마켓플레이스와 settings.json 을 건드리지 않음)");
} else {
  // Claude Code 는 세션 시작 후 최대 10분 지연으로 마켓플레이스를 자동 fetch 한다.
  // 공식 차단 수단은 두 가지뿐이고 각각 한계가 있어, 현재 상태를 같이 보여준다.
  //   - DISABLE_AUTOUPDATER=1 : 확실하지만 전역(다른 마켓플레이스도 멈춤)
  //   - /plugin UI 의 마켓플레이스별 토글 : omc 만 끄지만 UI 상태라 파일로 확인 불가
  try {
    const st = JSON.parse(readFileSync(join(CFG, "settings.json"), "utf8"));
    const off = st?.env?.DISABLE_AUTOUPDATER;
    log(`  DISABLE_AUTOUPDATER: ${off ? `${off} (전역 차단 중)` : "미설정 (다른 마켓플레이스는 계속 자동 업데이트)"}`);
  } catch { /* settings.json 이 없거나 읽을 수 없으면 표시만 생략 */ }
  pin = pinMarketplace();
  ({
    pinned: () => ok("마켓플레이스 고정 (origin fetch 차단)"),
    already: () => ok("이미 고정됨"),
    unpinned: () => ok("고정 해제 (origin 복구)"),
    "not-pinned": () => ok("고정된 적 없음"),
    needs: () => {},
    "no-marketplace": () => bad("마켓플레이스 디렉터리 없음 — 고정 불필요"),
    "no-git": () => bad("마켓플레이스 폴더가 git 저장소가 아님 — 고정하지 않음"),
    "no-remote": () => ok("origin remote 없음 — 이미 fetch 불가"),
  }[pin] || (() => {}))();
}

log();
if (MODE === "check") {
  // 판정은 «활성 버전» 기준이다. apply 는 활성 버전만 손대므로, 판정만 모든 버전을 보면
  // 캐시에 옛 버전이 남아 있는 한 apply 를 몇 번 돌려도 영원히 «미적용» 으로 나온다
  // (3-OS 에서 동일하게 재현). 비활성 버전은 정보로만 알린다.
  // 헬퍼 자리 결함이 하나라도 있으면 «모두 적용» 이 아니다. 다시 적용만으로는 안 고쳐지므로
  // 그 안내를 먼저 낸다(되돌린 뒤 적용하면 «패치 필요» 항목도 함께 처리된다).
  const misplacedActive = misplacedBy[active] || 0;
  const clean = (needBy[active] || 0) === 0 && !hjNeedBy[active] && pin !== "needs" && misplacedActive === 0;
  const others = targets.filter((v) => v !== active && ((needBy[v] || 0) > 0 || hjNeedBy[v] || (misplacedBy[v] || 0) > 0));
  log(clean ? "결과: 모두 적용된 상태입니다."
    : misplacedActive ? `결과: 헬퍼 자리 결함 ${misplacedActive}건이 있습니다. ${misplacedHint()}`
    : ROOT ? "결과: 적용되지 않은 항목이 있습니다. --check 없이 같은 --root 로 다시 실행하십시오."
    : NO_UPDATE ? "결과: 적용되지 않은 항목이 있습니다. --check 없이 --no-update 로 다시 실행하십시오."
    : "결과: 적용되지 않은 항목이 있습니다. 인자 없이 다시 실행하십시오.");
  if (others.length) {
    log(`    참고: 비활성 버전 ${others.join(", ")} 에 미적용분이 있습니다.`);
    log("          지금 쓰이지 않는 버전이라 판정에 넣지 않았습니다. 그 버전으로 되돌릴 계획이면 함께 적용하십시오.");
  }
} else if (MODE === "revert") {
  // 백업이 없어 남은 파일과 hooks.json 도 «끝내지 못함» 이다. 완료라고 하면 남은 것을 보지 못하고 넘어간다.
  const why = [failed.size && `실패 ${failed.size}건`, left.size && `되돌리지 못한 것 ${left.size}건`].filter(Boolean);
  log(why.length
    ? `되돌리기를 끝내지 못했습니다. ${why.join(", ")}. 위의 [!] 줄을 확인하십시오.`
    : "되돌리기 완료. Claude Code 를 재시작해야 반영됩니다.");
} else {
  log(`완료. 실패 ${r.fail}건.`);
  if (r.misplaced) log(`[!] 헬퍼 자리 결함 ${r.misplaced}건은 고치지 않았습니다. ${misplacedHint()}`);
  log("    훅 스크립트 패치는 즉시 적용됩니다 (훅이 호출될 때마다 파일을 새로 읽습니다).");
  log("[!] PostToolUse 훅 제거는 hooks.json 변경이라 각 세션이 다시 시작될 때부터 적용됩니다.");
}
process.exit(r.fail > 0 || left.size > 0 ? 1 : 0);
