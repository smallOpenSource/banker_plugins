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
 * OMC_PATCH_INSTALLED=<json 경로> 로 읽을 파일을 바꿀 수 있다(시험용, --check 에서만 받음).
 *
 * OS: Windows / macOS / Linux 공통. 런처(apply.cmd, apply.sh)와 배경 문서(README.md)는
 * 킷 배포 폴더에만 있다. 이 파일만 옮겨 쓰는 곳(예: 스킬 폴더)에는 없다.
 */
import {
  readFileSync, writeFileSync, writeSync, existsSync, copyFileSync, readdirSync,
  unlinkSync, mkdirSync, rmSync, symlinkSync, lstatSync, realpathSync,
  chmodSync, renameSync, statSync, accessSync, openSync, fstatSync, closeSync, fsyncSync, constants as FS_CONST,
} from "node:fs";
import { join, dirname, basename, resolve, sep as PATH_SEP, delimiter as PATH_LIST_SEP } from "node:path";
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
// OMC_PATCH_INSTALLED: 시험용. --check 일 때만 installed_plugins.json 대신 읽을 JSON 경로(읽기 전용). 적용과 되돌리기는
// 늘 Claude Code 가 읽는 파일을 본다 — 다른 파일이 정한 판을 패치하거나 그 파일에 쓰지 않게.
const INSTALLED = (MODE === "check" && process.env.OMC_PATCH_INSTALLED) || join(PLUGINS, "installed_plugins.json");
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
// --- OMC local patch: bound top-level dynamic import (made by omc-patch; undo with omc-patch --revert)
const __omcRaceImport = (p) => {
  let t;
  const timed = new Promise((res) => {
    // 이 타이머는 ref 된 채로 두어야 한다. unref 하면 «대기 중인 I/O 가 없는» 매달림에서
    // Node 가 unsettled top-level await 를 감지해 먼저 exit 13 으로 빠지고, 타이머는
    // 뜨지도 못한다(실측: 원본과 패치본이 똑같이 150ms 안에 죽었다). import 가 정상적으로
    // 끝나면 아래에서 clearTimeout 하므로 정상 경로는 한 톨도 느려지지 않는다.
    t = setTimeout(() => {
      // 훅이 일을 건너뛴 것을 알 수 있게 한 줄 남긴다. 종료 코드는 바꾸지 않는다(0 이 아니면 Claude Code 가 훅 오류로 본다). 닫힌 stderr 의 쓰기 오류는 뒤에 error 이벤트로 오므로 먼저 받아 둔다.
      try { process.stderr.on('error', () => {}); process.stderr.write('[OMC local patch] import 가 ${IMPORT_TIMEOUT_MS / 1000}초 안에 끝나지 않아 빈 모듈로 진행합니다\\n'); } catch { /* 알림만 */ }
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
  try { return JSON.parse(readRegular(INSTALLED, "utf8")).plugins?.[PLUGIN_KEY]?.[0] || null; }
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
// 지우는 목록(`git rev-parse --local-env-vars`, git 2.43)의 고정 사본이다. 실행할 때 이 PC 의 git 이 말하는 목록을
// 더한다(gitRepoVars). Windows 는 변수 이름의 대소문자를 가리지 않는다.
const GIT_REPO_VARS = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);

// 지울 변수: 고정 목록에 이 PC 의 git 이 말하는 목록을 더한다. 새 git 이 변수를 더해도 따라간다. git 을 부를 수
// 없으면 고정 목록만 쓴다. 처음 한 번만 묻는다.
let repoVars = null;
function gitRepoVars() {
  if (repoVars) return repoVars;
  repoVars = new Set(GIT_REPO_VARS);
  try {
    // 이름으로 부르는 프로그램(git, tar)은 홈 폴더에서 돌린다. Windows 는 현재 폴더의 git.exe 를 PATH 보다 먼저 찾는다.
    const out = execFileSync("git", ["rev-parse", "--local-env-vars"], { cwd: homedir(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const v of out.split(/\s+/)) if (/^GIT_[A-Z0-9_]+$/.test(v)) repoVars.add(v);
  } catch { /* 고정 목록만 */ }
  return repoVars;
}

// 환경 변수로 준 git 설정은 모든 호출에서 지운다. 그 값이 origin 을 바꿔 보이게 할 수 있다. 업데이트 경로의 fetch 에만
// 프록시와 TLS 신뢰 설정(회사망의 http.proxy 같은 값)을 다시 번호를 매겨 넘긴다. url.*.insteadOf 는 다른 저장소의 태그를
// 받아 오고 core.hooksPath 는 훅을 돌리므로 넘기지 않는다. GIT_CONFIG_PARAMETERS(`git -c`)도 넘기지 않는다.
const isEnvConfig = (k) => /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(k.toUpperCase());
const FETCH_KEYS = /^https?\.(proxy|sslcainfo|sslverify|proxyauthmethod)$/i;
// 많아야 64쌍을 보고, 빠진 키에서 멈춘다(엄청난 GIT_CONFIG_COUNT 를 끝까지 돌지 않는다).
function fetchConfig(env) {
  const kept = [];
  for (let i = 0; i < Math.min(Number(env.GIT_CONFIG_COUNT) || 0, 64); i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    if (key === undefined) break;
    if (FETCH_KEYS.test(key)) kept.push([key, env[`GIT_CONFIG_VALUE_${i}`] ?? ""]);
  }
  const out = kept.length ? { GIT_CONFIG_COUNT: String(kept.length) } : {};
  kept.forEach(([k, v], i) => Object.assign(out, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
  return out;
}

// 업데이트 fetch 만 받는 값. 받는 속도가 초당 1000바이트 밑으로 30초 이어지면 git(curl)이 스스로 끊고, 자격 증명을 터미널에서 묻지 않는다.
const NET_ENV = { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "30", GIT_TERMINAL_PROMPT: "0" };
// fetch 전체의 시간 제한(ms). 응답하지 않는 망(연결을 붙잡는 방화벽, TLS 블랙홀)에서 멈추지 않게 한다. 시험이 줄일 수 있게
// OMC_PATCH_FETCH_TIMEOUT_MS 를 받되 줄이기만 한다. 0 이하나 숫자가 아니면 버린다. 문서에 적지 않는 시험용 장치다.
const FETCH_TIMEOUT_MS = Math.min(Number(process.env.OMC_PATCH_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.OMC_PATCH_FETCH_TIMEOUT_MS) : 120000, 120000);
// 마켓플레이스의 .git 이 깨졌으면(중단된 clone) git 은 위로 올라가 다음 저장소(dotfiles 로 관리하는 ~/.claude 등)를
// 고른다. 바로 위 폴더를 천장(GIT_CEILING_DIRECTORIES)으로 두어 마켓플레이스 밖으로 나가지 못하게 한다.
// 마켓플레이스가 링크면 실제 경로 쪽 위 폴더도 막는다. 셸에 있던 천장 값은 대소문자와 상관없이 이 값으로 바꾼다.
const gitEnv = ({ network = false } = {}) => {
  const vars = gitRepoVars();
  const drop = (k) => isEnvConfig(k) || vars.has(k.toUpperCase()) || k.toUpperCase() === "GIT_CEILING_DIRECTORIES";
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop(k)));
  if (network) Object.assign(env, fetchConfig(process.env), NET_ENV);
  env.GIT_CEILING_DIRECTORIES = [...new Set([dirname(MARKET), dirname(realOr(MARKET))])].join(PATH_LIST_SEP);
  return env;
};

function git(args, cwd = MARKET, opts = {}) {
  return execFileSync("git", args, { cwd, env: gitEnv(opts), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout }).trim();
}

// ── 1. 업데이트 ──────────────────────────────────────────────────────────────
function ensureVersion() {
  const have = installedVersions();
  if (have.includes(TARGET_VERSION)) return useCached();
  if (MODE === "check") { bad(`${TARGET_VERSION} 미설치 (설치된 버전: ${have.join(", ") || "없음"})`); return false; }
  if (!canInstallTarget()) return false;

  log(`  ${TARGET_VERSION} 설치 중...`);
  const sha = targetSha();
  if (sha === null) return false;
  const dest = join(CACHE, TARGET_VERSION);
  unpackTarget(dest);
  linkNodeModules(dest, have);
  return switchActive(sha);
}

// TARGET_VERSION 이 캐시에 있을 때. 이미 활성이면 끝, 아니면 마켓플레이스 태그의 커밋으로 전환한다.
// 전환도 마켓플레이스와 git 이 있어야 하므로 먼저 확인한다(풀지 않으므로 tar 는 없어도 된다).
function useCached() {
  const now = activeVersion().v;
  if (MODE === "check" || now === TARGET_VERSION) { ok(`${TARGET_VERSION} 설치되어 있음`); return true; }
  log(`  ${TARGET_VERSION} 은 캐시에 있으나 활성 판은 ${oneLine(now)} 입니다. 전환합니다`);
  if (!canInstallTarget({ tar: false })) return false;
  const sha = targetSha();
  return sha === null ? false : switchActive(sha);
}

// 마켓플레이스가 제 git 저장소이고 git 이 있어야 TARGET_VERSION 의 커밋을 찾고, 풀려면 tar 도 있어야 한다.
function canInstallTarget({ tar = true } = {}) {
  if (!existsSync(MARKET)) { bad(`마켓플레이스 없음: ${oneLine(MARKET)}\n      Claude Code 에서 marketplace 를 먼저 추가하십시오: ${REPO_URL}`); return false; }
  if (!existsSync(join(MARKET, ".git"))) { bad(`마켓플레이스 폴더가 git 저장소가 아님: ${oneLine(MARKET)}`); return false; }

  // git 과 tar 에 의존한다. Windows 10+ / macOS / 대부분의 Linux 배포판에는 둘 다 있지만,
  // 최소 설치 컨테이너나 tar 없는 환경에서는 없을 수 있다. 여기서 못 찾으면 아래에서
  // execFileSync 가 ENOENT 로 죽어 원인이 안 보이므로, 먼저 확인하고 무엇이 없는지 말한다.
  const tools = [["git", "마켓플레이스에서 소스를 꺼내는 데"], ["tar", "그 소스를 푸는 데"]].slice(0, tar ? 2 : 1);
  for (const [cmd, why] of tools) {
    try { execFileSync(cmd, ["--version"], { cwd: homedir(), stdio: "ignore" }); }
    catch { bad(`${cmd} 를 찾을 수 없습니다 (${why} 필요). 설치한 뒤 다시 실행하거나, --no-update 로 패치만 적용하십시오.`); return false; }
  }
  return true;
}

// origin 에서 태그를 받는다. 받았으면 null, 받지 못했으면 그 까닭 한 줄. 이 도구가 고정한 origin 은 받을 수 없으므로
// 부르지 않고 그렇다고 한다(git 은 "remote helper" 오류만 낸다). curl 은 비밀번호 안의 `/` 를 호스트의 끝으로 읽어 사용자
// 정보 조각을 문구에 싣는다("Port number ended with 'Q'", "Could not resolve host: alice"). 그래서 다음이면 문구는 싣지
// 않고 git 이 어떻게 끝났는지만 댄다: origin 에 사용자 정보가 있음, git 의 오류 줄에 사용자 정보가 든 주소가 남음(전역
// insteadOf 가 더한 것. gitError 가 가린 자리 `//***@` 로 안다), 프록시 주소를 curl 이 잘못 읽을 수 있음(proxyMisread).
// 바른 꼴의 사용자 정보는 git 이 줄에서 떼고 curl 도 제대로 읽어, 그 줄은 그대로 싣는다.
function fetchTags() {
  const url = originUrl();
  if (typeof url === "string" && url.startsWith("omc-pinned://")) return "origin 이 고정되어 있음(omc-pinned://). 받으려면 먼저 --revert 로 고정을 푸십시오";
  try { git(["fetch", "--tags", "--quiet", "origin"], MARKET, { network: true, timeout: FETCH_TIMEOUT_MS }); return null; }
  catch (e) {
    if (e.code === "ETIMEDOUT") return `${FETCH_TIMEOUT_MS / 1000}초 안에 끝나지 않아 끊음(응답하지 않는 망일 수 있음)`;
    const why = gitError(e);
    const ended = `git 이 종료 ${oneLine(e.status ?? e.signal)} 로 끝남`;
    if (hasUserinfo(url) || why.includes("//***@")) return `${ended}(주소에 사용자 정보가 있어 git 의 문구는 싣지 않음)`;
    if (proxyMisread()) return `${ended}(프록시 주소의 사용자 정보를 curl 이 잘못 읽을 수 있어 git 의 문구는 싣지 않음)`;
    return why;
  }
}

// 주소의 사용자 정보(처음 `//` 뒤부터, 없으면 처음부터 마지막 `@` 까지)에 날 `/` `?` `#` `\` 가 있는지. curl 은 그 앞에서
// authority 를 끊는다. 그러면 사용자 이름이 호스트가 되고 비밀번호 앞부분이 포트가 된다.
const brokenUserinfo = (v) => {
  const s = String(v);
  const at = s.lastIndexOf("@");
  const i = s.indexOf("//");
  return at !== -1 && /[/?#\\]/.test(s.slice(i !== -1 && i < at ? i + 2 : 0, at));
};

// 태그 받기가 쓸 수 있는 프록시 주소 가운데 curl 이 잘못 읽을 것이 있는지. 프록시 주소는 git 의 줄에 실리지 않아
// ("Could not resolve proxy: alice" 처럼 호스트만) 설정에서 본다: curl 이 읽는 환경 변수와 git 이 넘기는 `*.proxy` 설정
// (태그 받기와 같은 환경, `http.proxy`, `http.<url>.proxy`, `remote.origin.proxy`).
function proxyMisread() {
  const env = Object.entries(process.env).filter(([k]) => /^(https?|all)_proxy$/i.test(k)).map(([, v]) => v);
  let cfg = [];
  try { cfg = git(["config", "--get-regexp", "\\.proxy$"], MARKET, { network: true }).split("\n").map((l) => l.slice(l.indexOf(" ") + 1)); }
  catch { /* 그런 설정이 없으면 git 은 종료 1 */ }
  return [...env, ...cfg].some(brokenUserinfo);
}

// URL 에 사용자 정보가 있는지(redactUrl 이 가리는 자리: 처음 `//` 뒤부터 마지막 `@` 까지).
const hasUserinfo = (url) => {
  const s = String(url);
  const i = s.indexOf("//");
  return i !== -1 && s.lastIndexOf("@") > i + 1;
};

// 태그 v<TARGET_VERSION> 의 커밋. 못 찾으면 null. 받지 못해도 로컬 태그가 있으면 진행한다(오프라인). 없으면 받지 못한 까닭도 댄다.
function targetSha() {
  const why = fetchTags();
  try { return git(["rev-parse", `v${TARGET_VERSION}^{}`]); }
  catch {
    bad(`태그 v${TARGET_VERSION} 를 마켓플레이스에서 찾을 수 없음`);
    if (why) log(`      origin 에서 태그를 받지 못함: ${why}`);
    return null;
  }
}

// git archive | tar 로 소스를 편다. 저장소에 dist/ 가 포함되어 빌드는 불필요하다.
function unpackTarget(dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  git(["archive", `v${TARGET_VERSION}`, "-o", join(dest, "_src.tar")]);
  execFileSync("tar", ["-xf", join(dest, "_src.tar"), "-C", dest], { cwd: homedir(), stdio: "ignore" });
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
    bad(`node_modules 없음. ${oneLine(dest)} 에서 \`npm install --omit=dev\` 를 실행하십시오`);
  }
}

// installed_plugins.json 을 읽는다. 읽지 못하거나 JSON 이 아니면 이름과 이유를 대고 undefined(파일 글은 내지 않는다).
// 읽은 값이 0, false, "", null 이어도 그 값을 돌려준다 — 실패와 섞이면 이유 없이 멈춘다.
function readInstalled() {
  try { return JSON.parse(readRegular(INSTALLED, "utf8")); }
  catch (err) { bad(`읽지 못함: installed_plugins.json (${err instanceof SyntaxError ? "JSON 이 아님" : failWhy(err)})`); return undefined; }
}

// installPath 의 마지막 칸(판)을 v 로 바꾼다. 구분자는 그 경로가 쓰는 것을 따른다.
function withVersion(installPath, v) {
  const sep = installPath.includes("//") ? "//" : installPath.includes("\\") ? "\\" : "/";
  return installPath.split(sep).slice(0, -1).concat(v).join(sep);
}

// 활성 버전 전환. installed_plugins.json 을 읽거나 쓰지 못하면 이름과 이유를 대고 false(호출부가 중단한다).
// 완료 줄의 앞 판은 바꾸기 전 항목의 version 이다(캐시 목록의 첫 판이 아니라).
function switchActive(sha) {
  const j = readInstalled();
  if (j === undefined) return false;
  let from;
  try {
    const e = j?.plugins?.[PLUGIN_KEY]?.[0];
    if (!e) { bad(`installed_plugins.json 에 ${PLUGIN_KEY} 항목이 없음 — 수동 확인 필요`); return false; }
    from = typeof e.version === "string" ? e.version : "?";
    backup(INSTALLED, `${INSTALLED}.omcbak`);
    e.installPath = withVersion(e.installPath, TARGET_VERSION);
    e.version = TARGET_VERSION;
    e.gitCommitSha = sha;
    e.lastUpdated = new Date().toISOString();
    writeAtomic(INSTALLED, JSON.stringify(j, null, 2) + "\n");
  } catch (err) {
    bad(`쓰지 못함: installed_plugins.json (${failWhy(err)})`);
    return false;
  }
  ok(`${oneLine(from)} → ${TARGET_VERSION} (sha ${sha.slice(0, 12)})`);
  return true;
}

// ── 쓰기 ─────────────────────────────────────────────────────────────────────
// 같은 폴더의 새 임시 파일(있으면 실패하는 열기)에 쓴 뒤 rename 으로 바꾼다. 하드 링크로 이어진 다른 이름(폴더 밖
// 파일)의 내용은 그대로 둔다. 쓸 파일이 링크면 쓰는 때의 실제 경로에서 바꿔 링크를 남긴다. 그래서 확인 뒤 그 자리가
// 폴더 밖 링크로 바뀌면 그 실제 파일이 바뀐다(확인과 쓰기 사이의 틈은 줄었을 뿐 없지 않다). follow 가 false 면
// 링크를 따라가지 않고 그 이름 자리를 새 파일로 바꾼다(링크는 사라지고 링크가 가리키던 파일은 그대로다. 고정 기록).
// 권한은 mode 를 주면 그 값, 아니면 원래 파일의 것(없으면 0644)이다. 임시 파일을 만들 때부터 그 권한으로 연다(umask 가
// 줄인 비트는 chmod 가 맞춘다). 만든 뒤에 맞추면 그 사이 기본 권한(0664 등)으로 남이 읽을 수 있다.
function writeAtomic(file, data, mode, { follow = true } = {}) {
  const real = follow ? realOr(file) : file;
  const tmp = join(dirname(real), `.${basename(real)}.omc-tmp-${process.pid}`);
  const m = mode ?? modeOf(real);
  rmSync(tmp, { force: true });
  try {
    writeSynced(tmp, data, m);
    chmodSync(tmp, m);
    renameRetry(tmp, real);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// 새 임시 파일(있으면 실패하는 열기)에 쓰고 디스크까지 내린다. 내리지 않고 rename 하면 전원이 나가거나 NFS 에서
// 새 이름 아래 짧거나 빈 파일이 남을 수 있다(OMC 의 atomicWriteFileSync, obsidizer 의 writeTemp 와 같은 꼴).
function writeSynced(tmp, data, mode) {
  const fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// 파일의 권한 비트. 읽을 수 없으면 0644.
function modeOf(p) {
  try { return statSync(p).mode & 0o777; } catch { return 0o644; }
}

// Windows 에서 다른 프로세스가 연 파일은 rename 이 잠시 거부된다(EPERM, EBUSY, EACCES). 100ms 간격으로 5번까지 다시 한다.
const RENAME_PAUSE = new Int32Array(new SharedArrayBuffer(4));
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; }
    catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(RENAME_PAUSE, 0, 0, 100);
    }
  }
}

// 백업을 만든다. 이미 있으면 그대로 둔다(적용은 그 전에 freshBackup 으로 지금 원본과 맞춘다). 있으면 실패하는 복사라 확인과
// 복사 사이에 틈이 없다.
function backup(file, bak) {
  try { copyFileSync(file, bak, FS_CONST.COPYFILE_EXCL); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
}

// 적용 직전에 본다. 이미 있는 백업이 지금 원본(패치 전)과 다르면 그 백업은 옛 원본이다(같은 판 폴더에 새 원본이 깔림). 지금
// 원본으로 바꿔야 나중의 되돌리기가 새 원본을 돌려준다. 정상 흐름에서는 둘이 같아 바꾸지 않는다. 백업이 없으면 backup 이 만든다.
// 다시 읽은 글이 원본이 아니면(isOriginal 이 거짓) 바꾸지 않는다. 같이 돈 다른 실행이 이 실행의 두 읽기 사이에 먼저 패치했으면 그
// 글은 패치본이고, 그것을 백업에 쓰면 되돌리기가 패치본을 돌려준다. 확인한 글을 그대로 쓰므로 확인과 쓰기 사이에 틈이 없다.
function freshBackup(file, bak, name, isOriginal) {
  const saved = readBackup(bak);
  if (saved === null) return;
  const now = readRegular(file);
  if (saved.equals(now) || !isOriginal(now.toString("utf8"))) return;
  writeAtomic(bak, now, modeOf(bak), { follow: false });
  ok(`옛 백업을 지금 원본으로 바꿈: ${shown(name)}`);
}

// 일반 파일만 읽는다. FIFO 는 열기만 하고 읽지 않으며, 폴더와 소켓, 장치는 던진다(형제 도구의 읽기와 같은 꼴).
function readRegular(p, enc) {
  const fd = openSync(p, FS_CONST.O_RDONLY | (FS_CONST.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error("일반 파일이 아님"), { code: "ENOTFILE" });
    return readFileSync(fd, enc);
  } finally {
    closeSync(fd);
  }
}

// 쓰기 실패의 이유 한 줄.
const failWhy = (e) => oneLine(e.code || e.message);

// ── 2. 훅 패치 ───────────────────────────────────────────────────────────────
// 훅 글을 읽는다. 읽지 못하면(권한, 일반 파일이 아님) 이름과 이유를 대고 null. check 는 확인하지 못한 것이라 모두 적용으로 보지 않는다.
function readHook(n, f, r) {
  try { return readRegular(f, "utf8"); }
  catch (e) {
    // 읽지 못한 훅은 --check 에서도 실패다. "패치 필요" 로 세면 결과 줄이 적용을 권하는데, 그 적용도 같은 읽기에서 실패한다.
    bad(`읽지 못함: ${shown(n)} (${failWhy(e)})`);
    r.fail++;
    r.failed.push(f);
    if (MODE === "check") r.unread++;
    return null;
  }
}

// hooks.json 과 그 백업이 부르는 훅 이름. 읽지 못하는 파일은 건너뛴다. hooks.json 은 [3/4] 가 이름과 이유를 대고 센다.
function hookNames(root) {
  const files = [join(root, "hooks", "hooks.json"), `${join(root, "hooks", "hooks.json")}.omcbak`];
  const readOrEmpty = (f) => { try { return readRegular(f, "utf8"); } catch { return ""; } };
  const src = files.filter(existsSync).map(readOrEmpty).join("");
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

// 백업의 글. 없거나 읽으려는 순간 사라졌으면 null(다른 실행이 먼저 되돌렸을 수 있다). 그 밖에 읽지 못하면 backupRead 표시를 달아
// 던진다 — 쓰기 실패와 같은 catch 가 "읽지 못함" 으로 알리게.
function readBackup(bak) {
  try { return readRegular(bak); }
  catch (e) { if (e.code === "ENOENT") return null; throw Object.assign(e, { backupRead: true }); }
}

// 이 도구가 아닌 «손» 이 import 를 감싼 흔적. 4.15.7 의 손 수정은 최상위의 `await import(` 를
// `await Promise.race([import(` 로 바꿔치기했다. 그 모양이 최상위(함수 밖) 코드 자리에 있을 때만 손 수정으로 본다.
// 문자열, 주석, 함수 몸통 안의 같은 모양이나 import 가 첫 원소가 아닌 race 는 상류 코드일 수 있어 세지 않는다.
const HAND_PATCH = /^await\s+Promise\.race\s*\(\s*\[\s*import\s*\(/;
function looksHandPatched(src) {
  if (src.includes("__omcRaceImport")) return false;
  let found = false;
  scanTopLevelAwaitImports(src, (i, fnStack) => {
    if (found || src[i] !== "a" || fnStack.some(Boolean) || (i > 0 && ID_CH.test(src[i - 1]))) return;
    found = HAND_PATCH.test(src.slice(i, i + 80));
  });
  return found;
}

// 패치(이 도구의 헬퍼, 손 패치)가 없는 글인가. 적용이 옛 백업을 바꾸기 전에 지금 글이 원본인지 본다.
const unpatched = (src) => !src.includes("__omcRaceImport") && !looksHandPatched(src);

function patchHooks(root) {
  const r = { done: 0, skip: 0, fail: 0, need: 0, misplaced: 0, unread: 0, foreign: [], orphan: [], failed: [] };
  // revert 는 scripts/ 전체를 훑는다. hooks.json 기반 목록은 두 번 새는데, 실측으로
  // 4.15.7 이 둘 다 겪었다 — PostToolUse 를 지우면 그 스크립트가 목록에서 빠지고(그래서
  // .omcbak 이 있어도 안 돌아온다), 손으로 고친 파일은 .omcbak 조차 없어 아예 안 보인다.
  const names = MODE === "revert" ? scriptNames(root, r) : hookNames(root);
  for (const n of names) {
    const f = join(root, "scripts", `${n}.mjs`);
    if (!existsSync(f)) continue;
    if (MODE === "revert") revertScript(root, n, f, r);
    else checkOrPatchScript(root, n, f, r);
  }
  return r;
}

// revert 가 훑는 이름: scripts/ 의 .mjs 전부. scripts/ 가 없는 판 폴더는 되돌릴 훅이 없어 한 줄로 알리고 넘어간다.
// 그 밖에 목록을 읽지 못하면(파일, 권한) 이름과 이유를 대고 실패로 센다 — 다음 판과 [3/4], [4/4] 는 그대로 간다.
function scriptNames(root, r) {
  const dir = join(root, "scripts");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort();
  } catch (e) {
    if (e.code === "ENOENT") log("  건너뜀: scripts 폴더 없음");
    else { bad(`읽지 못함: scripts (${failWhy(e)}): ${oneLine(dir)}`); r.fail++; r.failed.push(dir); }
    return [];
  }
}

function revertScript(root, n, f, r) {
  const bak = `${f}.omcbak`;
  if (existsSync(bak) && restoreScript(root, n, f, bak, r)) return;
  // 백업이 없는데 이미 감싸여 있으면 되돌릴 원본이 디스크에 없다. 조용히 넘기지 않고 이름을 댄다.
  //   - 우리 헬퍼가 있으면: 이 도구나 옛 킷이 고쳤는데 백업이 사라진 파일(복사해 온 폴더 등)
  //   - 손 패치: `await import(` 를 `await Promise.race([import(` 로 «바꿔치기» 해서 await import
  //     패턴 자체가 사라진다. siteInfo 로는 잡히지 않아 원문에서 직접 찾는다(실측: 4.15.7 의 두 파일)
  const src = readHook(n, f, r);
  if (src === null) return;
  if (src.includes("__omcRaceImport")) r.orphan.push(n);
  else if (looksHandPatched(src)) r.foreign.push(n);
}

// 되돌리기 전에 본다(쓰기 조건 뒤). 지금 파일에 패치(헬퍼, 손 패치)가 없고 글이 백업과 다르면 그 사이 같은 판 폴더에 새 원본이
// 깔린 것이다. 옛 백업을 덮으면 새 원본을 잃는다. 그 이유를, 아니면 null. 어느 쪽이든 읽지 못하면 판단하지 않는다(전처럼 복구).
const STALE = "지금 파일에 패치가 없고 백업과 글이 다름. 백업이 옛 원본일 수 있음";
function staleWhy(f, bak) {
  let now, saved;
  try {
    now = readRegular(f, "utf8");
    saved = readRegular(bak, "utf8");
  } catch {
    return null;
  }
  if (now.includes("__omcRaceImport") || looksHandPatched(now)) return null;
  return now === saved ? null : STALE;
}

// 백업으로 되돌린다. 쓸 수 없는 자리거나 쓰지 못하면 이유를 대고 실패로 센다. 백업이 읽으려는 순간 사라졌으면 false
// (다른 실행이 먼저 되돌렸을 수 있다. 호출부가 백업 없음으로 다시 본다).
function restoreScript(root, n, f, bak, r) {
  const why = whyNotWrite(root, f, bak) ?? staleWhy(f, bak) ?? restoreFrom(f, bak);
  if (why === GONE) return false;
  if (!why) {
    log(`  되돌림  ${shown(n)}`); r.done++;
    const left = dropBackup(bak);
    if (left) { bad(`되돌렸으나 백업을 지우지 못함: ${shown(n)} (${left}): ${oneLine(bak)}`); r.fail++; r.failed.push(f); }
    return true;
  }
  bad(`되돌리지 않음: ${shown(n)} (${why})`);
  // 옛 도구가 폴더 밖 링크 너머에서 고친 파일이다. 이 도구는 폴더 밖에 쓰지 않으므로 손 복구 방법을 알린다.
  if (why === OUTSIDE) log(`      ${handRestoreHint(bak, f)}`);
  r.fail++; r.failed.push(f);
  return true;
}

// 링크 너머의 일반 파일(1MiB 이하)이 백업을 이 도구가 패치한 글과 같은가. 옛 도구가 링크를 따라가 거기서 고친 파일이면 참이다.
// 헬퍼 이름만 든 다른 파일(메모, 손으로 고친 파일)은 거짓이다 — 거기에 백업을 덮어쓰라고 하면 그 파일의 글을 잃는다.
// 다른 자리에 헬퍼를 넣던 옛 킷의 패치본과 옛 헬퍼로 패치한 파일도 거짓이라 "먼저 확인" 쪽으로 간다(보수 쪽).
const PEEK_MAX = 1 << 20;
function patchedByOldTool(p, bak) {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > PEEK_MAX) return false;
    const patched = transform(readRegular(bak, "utf8"));
    return patched !== null && patched === readRegular(p, "utf8");
  } catch {
    return false;
  }
}

// 손 복구 안내. 링크 너머의 파일이 이 도구의 패치본일 때만 백업으로 덮어쓰라고 하고, 아니면 링크부터 확인하게 한다.
function handRestoreHint(bak, f) {
  const target = realOr(f);
  return patchedByOldTool(target, bak)
    ? `손으로 되돌리려면 ${oneLine(realOr(bak))} 의 내용을 확인한 뒤 ${oneLine(target)} 에 덮어쓰고 백업을 지우십시오.`
    : `링크가 가리키는 ${oneLine(target)} 의 글은 지금 이 도구가 만드는 패치본과 같지 않거나 읽어 확인할 수 없습니다. 덮어쓰지 말고 링크가 가리키는 곳이 맞는지 먼저 확인하십시오.`;
}

// 백업의 내용으로 파일을 바꾼다. 쓰지 못하면 그 이유, 백업이 읽으려는 순간 사라졌으면 GONE, 아니면 null.
const GONE = "백업이 먼저 사라짐";
function restoreFrom(f, bak) {
  let data;
  try { data = readRegular(bak); }
  catch (e) { return e.code === "ENOENT" ? GONE : `읽지 못함: ${failWhy(e)}`; }
  try { writeAtomic(f, data); return null; }
  catch (e) { return `쓰지 못함: ${failWhy(e)}`; }
}

// 되돌린 뒤 백업을 지운다. 다른 실행이 먼저 지웠으면(ENOENT) 된 것이다. 못 지우면 그 이유, 아니면 null.
function dropBackup(bak) {
  try { unlinkSync(bak); return null; }
  catch (e) { return e.code === "ENOENT" ? null : failWhy(e); }
}

function checkOrPatchScript(root, n, f, r) {
  const text = readHook(n, f, r);
  if (text === null) return;
  const info = siteInfo(text);
  // 헬퍼 자리 결함은 check 와 apply 모두 이름을 댄다. 이미 감싼 파일이라 transform 으로는
  // 고칠 수 없으므로 apply 도 건드리지 않고, 되돌린 뒤 다시 적용하라고 안내한다(misplacedHint).
  if (info.state === "misplaced") { bad(`헬퍼 자리 결함: ${n} (${info.why})`); r.misplaced++; return; }
  if (info.state !== "needs") { r.skip++; return; }
  const bak = `${f}.omcbak`;
  const why = whyNotWrite(root, f, bak);
  // --check 도 쓰기 조건을 본다. apply 에서야 «쓰지 않음» 이 되는 파일을 진단에서 미리 알린다.
  if (MODE === "check") { bad(why ? `패치 필요, 쓸 수 없음: ${n} (${why})` : `패치 필요: ${n}`); r.need++; return; }
  if (why) { bad(`쓰지 않음: ${n} (${why})`); r.fail++; return; }
  const out = transform(text);
  if (!out) { bad(`변환 실패: ${n}`); r.fail++; return; }
  if (writePatched(f, bak, out, n)) r.done++;
  else r.fail++;
}

// 패치한 글을 쓴다. 백업을 먼저 만들고, 쓴 파일이 문법 검사를 통과하지 못하면 백업으로 되돌린다. 성공이면 true.
// 쓰지 못하면 이유를 대고 false 다(예전에는 예외로 멈췄다).
function writePatched(f, bak, out, n) {
  try {
    freshBackup(f, bak, n, unpatched);
    backup(f, bak);
    writeAtomic(f, out);
  } catch (e) {
    bad(e.backupRead ? `읽지 못함: ${n} 의 백업 (${failWhy(e)})` : `쓰지 못함: ${n} (${failWhy(e)})`);
    return false;
  }
  const err = syntaxError(f);
  if (!err) return true;
  try {
    writeAtomic(f, readRegular(bak));
  } catch (e) {
    bad(`롤백도 실패: ${n} (${failWhy(e)}). ${oneLine(realOr(bak))} 으로 손수 되돌리십시오\n      ${oneLine(err)}`);
    return false;
  }
  bad(`문법오류로 롤백: ${n}\n      ${oneLine(err)}`);
  return false;
}

// 폴더 밖 쓰기를 거부한 이유. 되돌리기는 이 이유일 때 손 복구 방법을 함께 알린다.
const OUTSIDE = "파일이 플러그인 폴더 밖에 있음";

// 쓰기 전에 본다. 쓸 파일이 (링크를 따라가서) 플러그인 폴더 밖이거나 백업 자리가 링크, 또는 일반 파일이 아닌 것(FIFO,
// 폴더)이면 그 이유를, 아니면 null. 백업 자리가 깨진 링크면 existsSync 는 false 라, 복사가 링크가 가리키는 곳에 쓴다.
// 일반 파일이 아닌 백업 자리는 있으면 실패하는 복사가 EEXIST 로 끝나 "처음 백업" 으로 보이므로, 백업 없이 패치하게 된다.
function whyNotWrite(root, file, bak) {
  if (isLink(bak)) return "백업 자리가 링크";
  if (notRegularAt(bak)) return "백업 자리가 일반 파일이 아님";
  if (!insideRoot(root, file)) return OUTSIDE;
  return notWritable(file);
}

// 그 자리에 일반 파일도 링크도 아닌 것(FIFO, 폴더, 장치)이 있으면 true. 없는 자리는 false.
function notRegularAt(p) {
  try {
    const st = lstatSync(p);
    return !st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// 있는 자리가 일반 파일이 아니거나(FIFO, 폴더, 장치) 이 계정이 쓸 수 없으면 그 이유. 새 파일로 바꿔 쓰는 방식이 파일 권한을
// 우회하지 않게 하고, 특수 파일을 일반 파일로 바꾸지 않게 한다. 없는 자리는 괜찮다.
function notWritable(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile()) return "일반 파일이 아님";
  try { accessSync(file, FS_CONST.W_OK); } catch { return "쓸 권한이 없음"; }
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
// [3/4] 에서 지금 다루는 판의 이름표(`5.6.1: `, 판이 하나면 빈 글). hooks.json 의 [!] 줄도 어느 판의 것인지 알려야 한다.
let hjTag = "";
const hjBad = (s) => bad(`${hjTag}${s}`);

function patchHooksJson(root) {
  const hj = join(root, "hooks", "hooks.json");
  if (!existsSync(hj)) return "no-file";
  const why = whyNotWrite(root, hj, `${hj}.omcbak`);
  if (why && MODE !== "check") { hjBad(`hooks.json 을 건드리지 않음 (${why})`); return "unsafe"; }
  try {
    return MODE === "revert" ? revertHooksJson(root, hj) : removePostToolUse(hj, why);
  } catch (e) {
    hjBad(hooksJsonFailure(e));
    return "unsafe";
  }
}

// JSON 오류 문구는 파일의 글을 담으므로 내지 않는다. check 는 읽기만 하므로 실패도 읽기다.
function hooksJsonFailure(e) {
  const why = e instanceof SyntaxError ? "JSON 이 아님" : failWhy(e);
  if (e.backupRead) return `hooks.json 의 백업을 읽지 못함 (${why})`;
  return e instanceof SyntaxError || e.reading || MODE === "check" ? `hooks.json 을 읽지 못함 (${why})` : `hooks.json 을 쓰지 못함 (${why})`;
}

// hooks.json 의 글. 읽기 실패에는 reading 표시를 달아 던진다 — 쓰기 실패와 같은 catch 가 맞는 문구를 고르게.
function readHooksJson(hj) {
  try { return readRegular(hj, "utf8"); }
  catch (e) { throw Object.assign(e, { reading: true }); }
}

// 되돌린 결과. ambiguous 와 linked 는 hooks.json 을 되돌리지 못하고 남긴 것이라 끝 줄이 센다.
function revertHooksJson(root, hj) {
  const bak = `${hj}.omcbak`;
  const saved = readBackup(bak);
  if (saved !== null) {
    if (staleHooksJson(hj, saved)) { hjBad(`hooks.json 을 되돌리지 않음 (지금 파일에 PostToolUse 가 있고 백업과 글이 다름. 백업이 옛 원본일 수 있음)`); return "unsafe"; }
    writeAtomic(hj, saved);
    log(`  되돌림  ${hjTag}hooks.json`);
    const left = dropBackup(bak);
    if (left) { hjBad(`되돌렸으나 hooks.json 의 백업을 지우지 못함 (${left}): ${oneLine(bak)}`); return "unsafe"; }
    return "reverted";
  }
  // 이 도구의 백업이 없을 때 PostToolUse 가 그대로면 되돌릴 것이 없다. 옆의 수동 백업으로 덮어쓰면
  // 지금 내용을 잃는다. 읽지 못하면 PostToolUse 가 있는지 모르므로 "되돌릴 것 없음" 이라 하지 않는다
  // (위 catch 가 읽기 실패로 알리고 센다). 깨진 JSON 은 아래 수동 백업 찾기로 넘긴다.
  readHooksJson(hj);
  if (hasPostToolUse(hj)) return "no-backup";
  // 손으로 만든 백업이 남아 있을 수 있다(실측: 4.15.7 의 hooks.json.bak-20260906-postoolremove).
  // PostToolUse 를 담고 있는 유효한 JSON 이 딱 하나면 그것이 제거 직전 상태다 — 무엇을 썼는지 밝히고 되돌린다.
  const dir = dirname(hj);
  const { usable, unsafe } = manualBackups(root, dir);
  if (unsafe.length) hjBad(`hooks.json 수동 백업 후보가 링크이거나 플러그인 폴더 밖이라 쓰지 않음: ${unsafe.map(shown).join(", ")}`);
  if (usable.length === 1) {
    writeAtomic(hj, readRegular(join(dir, usable[0])));
    log(`  되돌림  ${hjTag}hooks.json  (수동 백업 사용: ${shown(usable[0])})`);
    return "reverted";
  }
  if (usable.length > 1) { hjBad(`hooks.json 수동 백업이 여러 개라 자동 복구하지 않음: ${usable.map(shown).join(", ")}`); return "ambiguous"; }
  return unsafe.length ? "linked" : "no-backup";
}

// 파일에서 읽은 값(파일 이름, PINNED 의 host)과 출력하는 경로를 출력에 넣을 때 쓴다. 줄바꿈과 제어 문자를 ? 로 바꾸고 길이를 자른다.
// SKILL 은 [!] 줄을 그대로 보고하라고 하므로, 값이 제 줄을 새로 시작하면 도구가 낸 줄처럼 읽힌다.
// 바꾸는 문자: 제어 문자(Cc), 서식 문자(Cf: 폭 없는 공백, 방향 표시, 단어 결합자, 태그 문자), 줄과 문단 구분자,
// 사용자 영역과 미할당, 변이 선택자, 기본 무시 글자(U+3164 같은 빈 글자), 점자 빈칸, ASCII 밖 공백.
// 태그 문자는 보이지 않는 ASCII 로 읽혀 출력을 읽는 에이전트에게 지시를 숨길 수 있다.
// oneLine 은 길이를 두고(URL), shown 은 120자로 자른다(이름, host).
const UNSAFE_CH = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}\u{2800}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}]/gu;
const oneLine = (s) => String(s).replace(UNSAFE_CH, "?");
const shown = (s) => oneLine(s).slice(0, 120);
// 처리하지 못한 오류도 스택 트레이스 대신 정화한 한 줄과 종료 1 로 끝낸다. 오류 문구는 경로를 담아 줄바꿈이 들 수 있다.
// 시스템 오류(code 가 있는 것)가 아닌 도구 자신의 결함이면 어디서 났는지 앞 세 곳만 정화해 보인다.
process.on("uncaughtException", (e) => {
  bad(`처리하지 못한 오류: ${oneLine(e?.message ?? e)}`);
  if (!e?.code) for (const l of String(e?.stack ?? "").split("\n").filter((x) => /^\s+at /.test(x)).slice(0, 3)) log(`      ${oneLine(l.trim())}`);
  process.exit(1);
});
// URL 의 사용자 정보와 쿼리의 값(이름과 상관없이)을 가린다. 출력과 기록에 비밀이 남지 않는다. 사용자 정보는 처음 `//` 뒤부터
// 마지막 `@` 까지다(공백, 탭, 비밀번호 안의 `/` `?` `#` `@` 도). 경로나 쿼리에 `@` 가 든 URL 은 호스트까지 가려진다 — 비밀번호를
// 놓치는 것보다 낫다. `//` 가 없는 ssh 꼴(`git@host:`)은 그대로다. 위치로 찾아 길이에 비례해 끝난다(`//.*@` 꼴 정규식은 `@` 없이
// `/` 가 많은 글에서 길이의 제곱만큼 걸린다). 쿼리의 이름 칸은 `?` 를 받지 않는다. 받으면 `=` 없는 `?` 가 많은 origin 에서
// 시작 자리마다 끝까지 읽어 길이의 제곱만큼 걸린다.
function redactUrl(url) {
  let s = String(url);
  const i = s.indexOf("//");
  const at = s.lastIndexOf("@");
  if (i !== -1 && at > i + 1) s = `${s.slice(0, i + 2)}***${s.slice(at)}`;
  return s.replace(/([?&][^=&#\s?]*=)[^&#\s]*/g, "$1***");
}

// URL 의 scheme 과 host 까지만. 비밀은 사용자 정보와 쿼리 밖(경로, 조각, `;` 매개변수)에도 들 수 있어 나머지는 버린다.
// scp 꼴(`git@host:org/repo.git`)은 host 만이다. 파서가 host 로 읽어도 host 모양(이름이나 [IPv6], 선택 포트)이 아니면
// 보이지 않는다(ssh 같은 scheme 은 host 뒤의 `;k=...` 까지 host 로 읽는다).
const HOST_SHAPE = /^(?:[A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
// `scheme://` 뒤 첫 `/` `?` `#` `\` 앞까지(파서가 읽는 authority). 비밀번호에 그 글자가 날로 들면 파서는 그 앞의 `이름:숫자` 를
// host:port 로 읽고 `@` 를 경로로 보낸다. 사용자 이름에도 날 `@` 가 들면(이메일 주소) 그 뒤의 `도메인:숫자` 를 읽는다. 그래서
// authority 뒤에 `@` 가 있으면 host 를 믿지 않는다(가림이 마지막 `@` 까지인 것과 같은 쪽. 경로에 `@` 가 든 URL 은 host 도 감춘다).
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#\\]*)/;
function hostOnly(url) {
  let scheme = "", host;
  const auth = AUTHORITY.exec(String(url));
  if (auth && String(url).includes("@", auth[0].length)) return "(호스트를 알아볼 수 없음)";
  try {
    const u = new URL(String(url));
    if (!u.host) return "(호스트가 없는 URL 또는 로컬 경로)";
    [scheme, host] = [`${u.protocol}//`, u.host];
  } catch {
    const scp = /^(?:[^@/:]+@)?([^:/]+):(?!\/\/)/.exec(String(url));
    if (!scp) return "(URL 꼴이 아님)";
    host = scp[1];
  }
  return HOST_SHAPE.test(host) ? `${scheme}${host}` : "(호스트를 알아볼 수 없음)";
}

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

// 되돌리기 전에 본다. 이 도구가 지운 PostToolUse 가 지금 hooks.json 에 다시 있고 글이 백업과 다르면 그 사이 새 hooks.json 이
// 깔린 것이다. 옛 백업을 덮으면 새 훅 등록을 잃는다. 읽지 못하면 판단하지 않는다(전처럼 복구).
function staleHooksJson(hj, saved) {
  let now;
  try { now = readRegular(hj); } catch { return false; }
  return !now.equals(saved) && hasPostToolUse(hj);
}

// 글이 PostToolUse 가 든 JSON 인가. 적용이 옛 hooks.json 백업을 바꾸기 전에 지금 글이 원본(지우기 전)인지도 본다.
const postToolUseIn = (text) => {
  try { return !!JSON.parse(text)?.hooks?.PostToolUse; }
  catch { return false; }
};
const hasPostToolUse = (p) => {
  try { return postToolUseIn(readRegular(p, "utf8")); }
  catch { return false; }
};

function removePostToolUse(hj, why) {
  const bak = `${hj}.omcbak`;
  const j = JSON.parse(readHooksJson(hj));
  if (!j.hooks?.PostToolUse) return "already";
  const list = j.hooks.PostToolUse.flatMap((g) => (g.hooks || []).map((h) => (h.command || "").match(/([\w-]+)\.mjs/)?.[1] || "?"));
  if (MODE === "check") { hjBad(`hooks.json PostToolUse 남아있음${why ? `, 쓸 수 없음 (${why})` : ""}: ${list.join(", ")}`); return "needs"; }
  freshBackup(hj, bak, `${hjTag}hooks.json`, postToolUseIn);
  backup(hj, bak);
  delete j.hooks.PostToolUse;
  writeAtomic(hj, JSON.stringify(j, null, 2) + "\n");
  try { JSON.parse(readRegular(hj, "utf8")); return list; }
  catch { writeAtomic(hj, readRegular(bak)); hjBad("hooks.json 손상으로 롤백"); return "failed"; }
}

// ── 4. 자동 업데이트 차단 ────────────────────────────────────────────────────
//
// Claude Code 는 마켓플레이스 git 저장소를 갱신한 뒤 플러그인을 새 버전으로
// 올릴 수 있다. 그러면 위 패치가 통째로 덮어써진다. 로컬에서 막을 수 있는
// 지점은 "마켓플레이스 저장소가 새 커밋을 가져오지 못하게" 하는 것뿐이다.
// origin remote 의 URL 을 무효 주소로 바꿔 fetch 를 실패시킨다(원래 URL 은
// `omc-pinned://` 뒤에 그대로 남기고 --revert 가 거기서 복구한다. PINNED 파일은 기록이다).
// 저장소 자체는 그대로라 이미 받은 태그로 재설치·검증이 가능하다.

// origin 의 원문. `git remote get-url` 은 전역 insteadOf 를 펼친 값을 내서, 그 값이 고정되고 되돌린 뒤에도 원래
// 값 대신 남았다. 설정 값을 그대로 읽는다. 없으면(git 이 1 로 끝남) null.
// git 이 그 밖의 까닭으로 읽지 못하면(git 없음, 다른 계정 저장소 거부, 깨진 설정) { unreadable } 이다. 없는 것으로 보면
// 고정과 되돌리기가 하지 않은 일을 했다고 끝난다.
function originUrl() {
  try { return git(["config", "--get", "remote.origin.url"]); }
  catch (e) { return e.status === 1 ? null : { unreadable: gitError(e) }; }
}

// git 오류의 원인 줄: `fatal:` 이나 `error:` 로 시작하는 첫 줄, 없으면 첫 줄(`warning:` 이 먼저 올 수 있다).
// 정화하고 URL 의 인증 정보를 가린다. git 이 오류 문구 없이 끝나면 Node 의 문구(명령 줄 전체, 곧 URL 전체가 든다)를
// 쓰지 않고 어떻게 끝났는지만 댄다.
const gitError = (e) => {
  const lines = String(e.stderr || "").split("\n").filter((l) => l.trim());
  if (!lines.length) {
    return e.status == null && !e.signal && e.code ? `git 을 실행하지 못함 (${oneLine(e.code)})` : `git 이 오류 문구 없이 끝남 (${oneLine(e.signal || e.status)})`;
  }
  const line = lines.find((l) => /^(fatal|error):/.test(l)) || lines[0];
  return oneLine(redactUrl(line)).slice(0, 200);
};

function pinMarketplace() {
  if (!existsSync(MARKET)) return "no-marketplace";
  // 마켓플레이스 폴더가 제 git 저장소가 아니면 git 이 위쪽 저장소(예: dotfiles 로 관리하는
  // ~/.claude)를 찾아 그 origin 을 바꾼다. 제 .git 이 있을 때만 고정하고 되돌린다. .git 이 있어도
  // 깨졌으면 git 이 위로 올라가는데, 그것은 gitEnv 의 천장이 막는다(origin 을 못 읽어 no-remote).
  if (!existsSync(join(MARKET, ".git"))) return "no-git";
  const url = originUrl();
  if (url === null) return "no-remote";
  if (typeof url !== "string") { bad(`origin 을 읽지 못함 (${url.unreadable}): ${oneLine(MARKET)}`); return "origin-unreadable"; }

  if (MODE === "revert") return unpinMarketplace(url);
  if (url.startsWith("omc-pinned://")) return alreadyPinned();
  if (MODE === "check") { bad(`마켓플레이스 미고정 (origin=${oneLine(redactUrl(url))})`); return "needs"; }

  try { git(["remote", "set-url", "--", "origin", `omc-pinned://${url}`]); }
  catch (e) { bad(`고정 실패: origin 을 바꾸지 못했습니다 (${gitError(e)})`); return "pin-failed"; }
  return writePinRecord() ? "pinned" : "record-failed";
}

// host 를 남긴다. 이 폴더는 통째로 복사해 배포하므로 PINNED 도 같이 딸려 가는데,
// PINFILE 은 스크립트 위치가 아니라 homedir() 기준이라 남의 기록인 줄 모르고 쓰기 쉽다.
// URL 은 남기지 않는다. 원래 URL 은 origin 의 `omc-pinned://` 뒤에 있고, 인증 정보가 든 URL 이 기록에 남는다.
// 고정이 된 뒤에만 쓴다. 실패한 고정의 기록은 남기지 않는다. 기록을 쓰지 못하면 고정은 둔 채 실패로 센다.
// 덮어쓴 옛 기록에 URL 칸이 있었고 같은 파일의 다른 이름이 있으면, 그쪽에 남은 칸을 알리고 실패로 센다.
// 판은 패치한 활성 판이다(--no-update 면 그 판, 인자 없는 적용이면 전환한 판). 기록 폴더는 처음 만들 때 이 계정만 쓰게(0700) 한다.
function writePinRecord() {
  let ino = null;
  let held = null;
  try {
    mkdirSync(dirname(PINFILE), { recursive: true, mode: 0o700 });
    if (isLink(PINFILE)) throw new Error("링크라 따라가 쓰지 않음");
    held = urlInRecord();
    ino = held ? sharedIno() : null;
    writeAtomic(PINFILE, JSON.stringify({ pinnedAt: new Date().toISOString(), version: active, host: hostname() }, null, 2) + "\n", 0o600, { follow: false });
  } catch (e) {
    bad(`고정 기록(PINNED)을 쓰지 못함 (${failWhy(e)}). origin 은 고정됨: ${oneLine(PINFILE)}`);
    return false;
  }
  return ino === null ? true : sharedLeft(sharedWhy(held), ino);
}

// 덮어쓰거나 지울 옛 기록이 URL 을 담는가. "yes" 는 JSON 의 최상위 칸을 봄, "maybe" 는 읽지 못했거나 JSON 이 아닌 글에
// originUrl 이 있음(칸인지 모름), null 은 없음(일반 파일로 이어지지 않는 자리 포함). 같은 파일의 다른 이름을 알릴지와
// 그 문구("남음", "남았을 수 있음")를 가른다.
function urlInRecord() {
  let text;
  try { text = pinRecordText(); } catch { return "maybe"; }
  if (text === null) return null;
  const { ok, rec } = parseRecord(text);
  if (ok) return hasUrlKey(rec) ? "yes" : null;
  return text.includes("originUrl") ? "maybe" : null;
}

// 이미 고정된 origin. 옛 기록의 URL 칸을 지우지 못했으면 고정은 그대로 두고 실패로 센다.
// --check 는 쓰지 않고 그 칸이 남았는지만 알린다. 모두 적용됐다고 하면 SKILL 이 적용을 건너뛰어, 이미 적용한 PC 에는
// 그 칸을 지울 적용이 오지 않는다(고정된 OMC 는 업데이트도 오지 않는다).
function alreadyPinned() {
  if (MODE === "check") return pinUrlCheck();
  return scrubPinRecord() ? "already" : "scrub-failed";
}

// 옛 도구가 남긴 고정 기록의 URL(인증 정보가 들 수 있음)을 지우고 이 계정만 읽게(0600) 한다.
// 할 일이 없거나 지웠으면 true 다. 지우지 못했거나 기록을 읽지 못해 확인하지 못했으면 [!] 로 알리고 false 다.
function scrubPinRecord() {
  const left = pinUrlLeftover();
  if (!left) return true;
  if (left.why) return pinUrlLeft(left.why);
  delete left.rec.originUrl;
  const ino = sharedIno();
  try { writeAtomic(PINFILE, JSON.stringify(left.rec, null, 2) + "\n", 0o600, { follow: false }); }
  catch (e) { return pinUrlLeft(`지우지 못함 (쓰지 못함: ${failWhy(e)})`); }
  return ino === null ? true : sharedLeft(SHARED_WHY, ino);
}
const SHARED_WHY = "이 이름에서만 지움 (같은 파일의 다른 이름이 있어 그쪽에는 남음)";
const SHARED_MAYBE_WHY = "이 이름에서만 지움 (같은 파일의 다른 이름이 있어 그쪽에 남았을 수 있음)";
const sharedWhy = (held) => (held === "yes" ? SHARED_WHY : SHARED_MAYBE_WHY);
const SHARED_CHECK_WHY = "이 이름에서만 지울 수 있음 (같은 파일의 다른 이름이 있어 그쪽에는 남음)";

// 기록에 같은 파일의 다른 이름(하드 링크)이 있으면 그 파일의 inode(Windows 는 파일 ID, 정밀도를 잃지 않게 BigInt)다.
// 없거나 확인하지 못하면 null. 이 이름을 rename 이나 unlink 로 바꾼 뒤에는 그 번호가 다른 이름들에만 남는다.
function sharedIno() {
  try {
    const st = lstatSync(PINFILE, { bigint: true });
    return st.nlink > 1n ? st.ino : null;
  } catch {
    return null;
  }
}
const sharedLeft = (what, ino) => pinUrlLeft(what, `\n      다른 이름은 같은 파일 시스템에서 inode(Windows 는 파일 ID) ${ino} 로 찾습니다.`);

// --check 의 판정. 남은 칸을 적용이 지울 수 있으면 scrub-needs, 이 도구로 지울 수 없으면 그 까닭을 알리고
// scrub-blocked 다. 기록을 읽지 못했거나 JSON 이 아니어서 칸이 있는지 모르면 scrub-unsure 다. 남은 칸이 없으면 already 다.
function pinUrlCheck() {
  const left = pinUrlLeftover();
  if (!left) return "already";
  const why = left.why || pinDirWhy();
  const ino = why ? null : sharedIno();
  if (why || ino !== null) {
    if (why) pinUrlLeft(why);
    else sharedLeft(SHARED_CHECK_WHY, ino);
    return left.unsure ? "scrub-unsure" : "scrub-blocked";
  }
  bad(`고정 기록(PINNED)에 옛 URL 칸이 남아 있음 (적용하면 지움): ${oneLine(PINFILE)}`);
  return "scrub-needs";
}

// 적용이 새 임시 파일을 만들 폴더에 쓸 수 없으면 그 까닭이다. --check 는 쓰지 않고 권한만 본다.
function pinDirWhy() {
  try { accessSync(dirname(realOr(PINFILE)), FS_CONST.W_OK); return null; }
  catch (e) { return `지울 수 없음 (쓰지 못함: ${failWhy(e)})`; }
}

// 고정 기록에 남은 옛 URL 칸. 없으면 null 이다. 있으면 그 칸을 뺄 기록(rec)이나 이 도구가 지우지 못하는 까닭(why)이다.
// 글에 그 이름이 있어도 최상위 칸이 아니면 없는 것이다. 링크인 기록은 따라가 쓰지 않으므로(사용자가 고친다) 링크에는
// rec 를 내지 않는다.
function pinUrlLeftover() {
  let text;
  try { text = pinRecordText(); }
  catch (e) { return { why: `확인하지 못함 (읽지 못함: ${failWhy(e)})`, unsure: true }; }
  if (text === null) return null;
  const { ok, rec } = parseRecord(text);
  if (ok ? !hasUrlKey(rec) : !text.includes("originUrl")) return null;
  if (isLink(PINFILE)) return { why: "지울 수 없음 (링크라 따라가 쓰지 않음)" };
  // JSON 이 아닌 글은 originUrl 이 칸인지 알 수 없다. 읽지 못한 기록과 함께 "남았을 수 있음" 이다(unsure).
  return ok ? { rec } : { why: "지울 수 없음 (JSON 이 아님)", unsure: true };
}

// 기록의 글을 JSON 으로 읽는다. 읽히면 ok 가 true 다. 최상위 칸만 본다: 글에 그 이름이 있어도 칸이 아니면 없는 것이다.
function parseRecord(text) {
  try { return { ok: true, rec: JSON.parse(text) }; }
  catch { return { ok: false }; }
}
const hasUrlKey = (rec) => !!rec && typeof rec === "object" && "originUrl" in rec;

// 고정 기록의 글. 없거나 일반 파일로 이어지지 않으면(폴더, FIFO, 소켓, 끊어진 링크, 링크 고리) null 이다. 그런 자리에는
// URL 이 들 수 없다. 읽지 못하면 던진다. stat 으로 먼저 걸러야 소켓에서 열기 오류(ENXIO)가 나지 않고, 연 뒤 다시 보아야
// stat 과 읽기 사이에 FIFO 로 바뀐 자리에서 멈추지 않는다.
function pinRecordText() {
  try {
    return statSync(PINFILE).isFile() ? readRegular(PINFILE, "utf8") : null;
  } catch (e) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "ENOTFILE"].includes(e.code)) return null;
    throw e;
  }
}

// 옛 URL 칸이 남았을 수 있음을 알린다. 인증 정보가 든 URL 이 남을 수 있어 적용과 되돌리기는 실패로 센다.
// 기록의 글은 내지 않는다. more 는 경로 줄 뒤에 붙일 줄이다.
function pinUrlLeft(what, more = "") {
  bad(`고정 기록(PINNED)의 옛 URL 칸을 ${what}.\n      인증 정보가 든 URL 이 남았을 수 있습니다: ${oneLine(PINFILE)}${more}`);
  return false;
}

// 원본 URL 은 현재 origin 안에 그대로 들어 있다(`omc-pinned://` + 원본). 거기서만 복원한다.
// PINNED 의 값으로 origin 을 쓰지 않는다. PINNED 는 배포 폴더에 같이 딸려 오므로 다른 PC 의 값일 수 있고,
// host 가 없는 기록은 어느 기기의 것인지 모른다. origin 이 고정 상태가 아니면 되돌릴 것도 없다.
// 고정 기록은 이 뒤에 dropPinRecord 가 지운다. 기록을 지우지 못해도 origin 은 되돌린다.
function unpinMarketplace(url) {
  const PIN_PREFIX = "omc-pinned://";
  const restored = url.startsWith(PIN_PREFIX) ? url.slice(PIN_PREFIX.length) : "";
  if (!restored) return "not-pinned";
  try { git(["remote", "set-url", "--", "origin", restored]); }
  catch (e) {
    bad(`고정 해제 실패: origin 을 되돌리지 못했습니다 (${gitError(e)})`);
    log(`      원래 URL(호스트까지만): ${oneLine(hostOnly(restored))}. 원문은 origin 의 omc-pinned:// 뒤에 그대로 있습니다.`);
    return "unpin-failed";
  }
  return "unpinned";
}

// PINNED 를 지운다. 지웠거나 지울 것이 없으면 true 다. 깨진 기록(JSON 이 아니거나, null 처럼 객체가 아닌 값)은 말없이
// 지운다. 링크는 링크만 지우는데, 링크 너머에 옛 URL 칸이 있거나 그것을 확인하지 못하면 링크를 두고 알린다(링크 너머는
// 쓰지 않음). 지우지 못해도(읽기 전용 폴더, 폴더인 PINNED) 알린다. 둘 다 false 다. 일반 파일이 아니면 읽지 않는다(FIFO).
function dropPinRecord() {
  if (!pinRecordThere()) return true;
  const left = isLink(PINFILE) && pinUrlLeftover();
  if (left) return pinUrlLeft(left.why);
  let saved = null;
  try { saved = JSON.parse(pinRecordText()); } catch { /* 깨졌거나 읽지 못하면 무시 */ }
  const held = urlInRecord();
  const ino = held ? sharedIno() : null;
  try { unlinkSync(PINFILE); }
  catch (e) {
    bad(`고정 기록(PINNED)을 지우지 못함 (${failWhy(e)}): ${oneLine(PINFILE)}`);
    return false;
  }
  warnForeignPin(saved);
  return ino === null ? true : sharedLeft(sharedWhy(held), ino);
}

// 고정 기록 자리에 무엇이 있는가(끊어진 링크 포함). 위 폴더를 열 수 없어 확인하지 못하면 있는 것으로 본다.
function pinRecordThere() {
  try { lstatSync(PINFILE); return true; }
  catch (e) { return !["ENOENT", "ENOTDIR"].includes(e.code); }
}

// 다른 기기의 기록이면 알린다. 그 값은 쓰지 않는다.
function warnForeignPin(saved) {
  if (saved && typeof saved === "object" && typeof saved.host === "string" && saved.host && saved.host !== hostname()) {
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
    try { name = JSON.parse(readRegular(join(root, rel), "utf8")).name; } catch { continue; }
    if (name === undefined) continue;
    if (name === want) return null;
    // 파일에서 읽은 값이다. JSON.stringify 는 U+2028, U+202E 같은 글자를 그대로 두므로 oneLine 을 거친다.
    const quoted = oneLine(JSON.stringify(name));
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
    try { return { file, ...publicFacts(scanFacts(readRegular(file, "utf8"))) }; }
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
  ? `OMC 패치  (대상 폴더 ${oneLine(ROOT)})  모드: ${MODE}`
  : `OMC 패치  (대상 ${TARGET_VERSION})  모드: ${MODE}${NO_UPDATE ? " --no-update" : ""}`);
log(`플랫폼: ${process.platform}  node ${process.version}`);
log();

// targets 는 «고칠 플러그인 폴더» 의 이름표 목록이다. 기본은 캐시의 판 번호이고, --root 는
// 그 폴더 경로 하나다. rootOf 가 이름표를 폴더로 바꾼다.
let active, targets;
// installed_plugins.json 에서 활성 판을 찾지 못해 추정했는가. 적용은 멈추고 --check 는 그렇다고 결과 줄에 낸다.
let activeGuessed = false;
const rootOf = (v) => (ROOT ? v : join(CACHE, v));
// 헬퍼 자리 결함은 이 판의 apply 로 고칠 수 없다(이미 감싼 파일). 원본으로 되돌린 뒤 다시 적용한다.
// 되돌리기는 그 폴더 하나만 한다. 인자 없는 --revert 는 설치된 모든 판을 되돌리고 고정까지 푼다.
// active 는 아래에서 정해지므로 쓰는 자리에서 부른다.
const misplacedHint = () => (ROOT
  ? "--revert --root 로 되돌린 뒤 같은 --root 로 다시 적용하십시오."
  : `--revert --root "${oneLine(join(CACHE, active))}" 로 활성 폴더만 되돌린 뒤 다시 적용하십시오.`);
if (ROOT) {
  // 그 폴더 하나만 고친다(판 폴더도 installed_plugins.json 도 없는 번들 사본, 또는 활성 캐시 폴더).
  // 판 바꾸기([1/4])와 마켓플레이스 고정([4/4])은 하지 않는다 — 그 둘은 이 PC 의 설정이고 이 폴더의 것이 아니다.
  if (!existsSync(join(ROOT, "hooks", "hooks.json")) || !existsSync(join(ROOT, "scripts"))) {
    bad(`플러그인 폴더가 아님 (hooks/hooks.json 과 scripts/ 가 있어야 함): ${oneLine(ROOT)}`);
    process.exit(1);
  }
  const other = otherPluginName(ROOT);
  if (other) { bad(`OMC 플러그인 폴더가 아님 (${other}): ${oneLine(ROOT)}`); process.exit(1); }
  log("[1/4] 버전");
  log("  건너뜀 (--root 는 판을 바꾸지 않음)");
  active = ROOT;
  targets = [ROOT];
} else {
  if (!existsSync(INSTALLED)) { bad(`Claude Code 플러그인 설정을 찾을 수 없음: ${oneLine(INSTALLED)}`); process.exit(1); }

  log("[1/4] 버전");
  if (NO_UPDATE) log("  건너뜀 (--no-update)");
  else if (MODE === "revert") log("  건너뜀 (revert 는 버전을 되돌리지 않음 — 킷 배포 폴더 README 의 롤백 절차 참고)");
  else if (!ensureVersion() && MODE !== "check") { bad("버전 확보 실패 — 중단"); process.exit(1); }

  const versions = installedVersions();
  // [1/4] 뒤에 계산해야 일반 apply 가 TARGET_VERSION 으로 전환한 결과가 반영된다.
  const { v, src: activeSrc } = activeVersion();
  active = v;
  activeGuessed = activeSrc.startsWith("추정");
  if (MODE !== "revert" && (MODE === "check" || NO_UPDATE)) {
    log(`  활성 버전: ${oneLine(active)} (${activeSrc})`);
    if (active !== TARGET_VERSION) {
      log(`  활성 버전이 대상(${TARGET_VERSION})과 다름 — 기본 apply 는 ${TARGET_VERSION} 로 전환하고, --no-update 는 활성 버전(${oneLine(active)})을 그 자리에서 패치함`);
    }
  }
  // 추정한 판에 적용하면 Claude Code 가 쓰는 판은 그대로 남고, 그 뒤 --check 는 추정한 판을 보고 적용됐다고 한다. 쓰기 전에 멈춘다.
  if (MODE === "apply" && activeGuessed) {
    bad(`활성 버전을 installed_plugins.json 에서 확인하지 못해 적용하지 않음 (추정한 판 ${oneLine(active)})`);
    process.exit(1);
  }
  // apply 는 활성 버전만 손댄다. revert 와 check 는 설치된 모든 버전을 훑는다 —
  // 여러 버전이 나란히 있을 때 이전 버전에 수정이 남으면, 롤백했을 때 예상과 다른
  // 상태가 된다(실제로 4.15.7 의 hooks.json 수정이 그렇게 남았다).
  targets = MODE === "apply" ? [active] : (versions.length ? versions : [active]);
  if (!existsSync(join(CACHE, active))) { bad(`설치 경로 없음: ${oneLine(join(CACHE, active))}`); process.exit(1); }
}

log();
log(`[2/4] 훅 패치${MODE === "apply" || ROOT ? `  (${oneLine(active)})` : `  (대상 ${targets.length}개 버전)`}`);
const r = { done: 0, skip: 0, fail: 0, need: 0, misplaced: 0 };
const needBy = {};
const misplacedBy = {};
const unreadBy = {};
const foreignBy = {};
const orphanBy = {};
// 되돌리기 끝 줄이 세는 파일. 쓰지 못한 것(failed)과 백업이 없어 남은 것(left)이다. 링크로 이어진 판 폴더는
// 같은 파일을 여러 이름으로 보이므로 fileKey 로 한 번만 센다. 위 [2/4] 줄의 건수는 판 폴더마다 센다.
const failed = new Set();
const left = new Set();
for (const v of targets) {
  const root = rootOf(v);
  if (!existsSync(root)) continue;
  if (targets.length > 1) log(`  — ${oneLine(v)}`);
  const x = patchHooks(root);
  needBy[v] = x.need;
  misplacedBy[v] = x.misplaced;
  unreadBy[v] = x.unread;
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
  bad(`${oneLine(v)}: ${what} — ${list.map(shown).join(", ")}`);
  log(`      백업(.omcbak)이 없어 되돌릴 원본이 디스크에 없습니다. 원본이 필요하면:`);
  if (ROOT) log(`      같은 판의 상류 원본에서 scripts/<이름>.mjs 를 다시 가져오십시오.`);
  else {
    log(`      git -C "${oneLine(MARKET)}" archive -o "<임시 tar>" v${oneLine(v)} scripts/<이름>.mjs`);
    log(`      tar -xf "<임시 tar>" -C "${oneLine(join(CACHE, v))}"`);
    log("      <임시 tar> 는 새로 만든 임시 폴더(bash: mktemp -d) 안의 파일로 정하고, 다 쓴 뒤 폴더째 지우십시오.");
  }
}
for (const [v, list] of Object.entries(foreignBy)) reportNoBackup(v, list, "이 도구가 만들지 않은 수정이 남아 있습니다");
for (const [v, list] of Object.entries(orphanBy)) reportNoBackup(v, list, "패치는 있는데 백업이 없어 되돌리지 못했습니다");

log();
log("[3/4] PostToolUse 훅 제거");
const hjNeedBy = {};
const hjFailBy = {};
for (const v of targets) {
  const root = rootOf(v);
  if (!existsSync(root)) continue;
  const tag = targets.length > 1 ? `${v}: ` : "";
  hjTag = tag;
  const hj = patchHooksJson(root);
  if (Array.isArray(hj)) ok(`${tag}제거: ${hj.join(", ")}`);
  else if (hj === "already") ok(`${tag}이미 제거됨`);
  else if (hj === "needs") hjNeedBy[v] = true;
  else if (hj === "reverted" || hj === "ambiguous" || hj === "linked") { /* patchHooksJson 이 출력함 */ }
  else if (hj === "no-backup") ok(`${tag}되돌릴 백업 없음 (이 도구가 지운 적 없음)`);
  else if (hj === "no-file") bad(`${tag}hooks.json 파일 자체가 없음`);
  // "failed" 는 고친 hooks.json 이 JSON 으로 읽히지 않아 되돌린 경우다. 고치지 못했으니 실패로 센다.
  else if (hj === "unsafe" || hj === "failed") { r.fail++; hjFailBy[v] = true; failed.add(fileKey(join(root, "hooks", "hooks.json"))); }
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
    const st = JSON.parse(readRegular(join(CFG, "settings.json"), "utf8"));
    const off = st?.env?.DISABLE_AUTOUPDATER;
    log(`  DISABLE_AUTOUPDATER: ${off ? `${oneLine(off)} (전역 차단 중)` : "미설정 (다른 마켓플레이스는 계속 자동 업데이트)"}`);
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
    "pin-failed": () => {},
    "origin-unreadable": () => {},
    "unpin-failed": () => {},
    "record-failed": () => {},
    "scrub-failed": () => ok("이미 고정됨"),
    "scrub-needs": () => ok("이미 고정됨"),
    "scrub-blocked": () => ok("이미 고정됨"),
    "scrub-unsure": () => ok("이미 고정됨"),
  }[pin] || (() => {}))();
  // 마켓플레이스를 못 찾아 고정하지 않은 PC 에도 옛 판이 남긴 기록은 있을 수 있다. 같은 판정으로 다룬다.
  if (MODE !== "revert" && ["no-marketplace", "no-git", "no-remote"].includes(pin)) {
    const rec = alreadyPinned();
    if (rec !== "already") pin = rec;
  }
  if (["pin-failed", "origin-unreadable", "unpin-failed", "record-failed", "scrub-failed"].includes(pin)) {
    r.fail++;
    failed.add(["record-failed", "scrub-failed"].includes(pin) ? "PINNED" : "origin");
  }
  // 되돌리기는 origin 을 다룬 뒤 고정 기록을 지운다. 지우지 못하면 origin 과 따로 실패로 센다.
  if (MODE === "revert" && !dropPinRecord()) {
    r.fail++;
    failed.add("PINNED");
  }
}

log();
if (MODE === "check") {
  // 판정은 «활성 버전» 기준이다. apply 는 활성 버전만 손대므로, 판정만 모든 버전을 보면
  // 캐시에 옛 버전이 남아 있는 한 apply 를 몇 번 돌려도 영원히 «미적용» 으로 나온다
  // (3-OS 에서 동일하게 재현). 비활성 버전은 정보로만 알린다.
  // 헬퍼 자리 결함이 하나라도 있으면 «모두 적용» 이 아니다. 다시 적용만으로는 안 고쳐지므로
  // 그 안내를 먼저 낸다(되돌린 뒤 적용하면 «패치 필요» 항목도 함께 처리된다).
  const misplacedActive = misplacedBy[active] || 0;
  const unreadActive = unreadBy[active] || 0;
  const pinNeeds = ["needs", "scrub-needs", "scrub-blocked", "scrub-unsure"].includes(pin);
  const pinUnread = pin === "origin-unreadable";
  const toApply = (needBy[active] || 0) > 0 || !!hjNeedBy[active];
  const clean = !toApply && !hjFailBy[active] && !pinNeeds && !pinUnread && misplacedActive === 0 && !unreadActive && !activeGuessed;
  // 고정 기록 줄이 결과가 되는 때는 적용으로 고칠 항목이 없고 그 줄만 남은 때다. 고칠 항목이 함께 있으면 그 항목이 결과이고
  // 고정 기록 줄은 참고로 알린다(적용은 훅을 패치하고 그 칸은 남겨 실패로 센다).
  const pinOnly = !toApply && !hjFailBy[active] && !misplacedActive && !unreadActive && !activeGuessed;
  const PIN_LINES = {
    "scrub-blocked": "결과: 고정 기록(PINNED)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다. 위의 [!] 줄을 확인하십시오.",
    "scrub-unsure": "결과: 고정 기록(PINNED)을 확인하지 못했습니다. 옛 URL 칸이 남았을 수 있습니다. 위의 [!] 줄을 확인하십시오.",
  };
  const rerun = ROOT ? "--check 없이 같은 --root 로 다시 실행하십시오."
    : NO_UPDATE ? "--check 없이 --no-update 로 다시 실행하십시오." : "인자 없이 다시 실행하십시오.";
  // 결과 줄 표. 위에서부터 처음 맞는 줄 하나를 낸다. SKILL 1단계의 결과 줄 표도 이 순서다.
  const RESULTS = [
    [activeGuessed, "결과: 활성 버전을 확인하지 못했습니다. 위의 활성 버전 줄을 확인하십시오."],
    [hjFailBy[active], "결과: hooks.json 을 확인하지 못했습니다. 위의 [!] 줄을 확인하십시오."],
    [unreadActive, "결과: 훅 스크립트를 확인하지 못했습니다. 위의 [!] 줄을 확인하십시오."],
    [pinUnread, "결과: 마켓플레이스 origin 을 확인하지 못했습니다. 위의 [!] 줄을 확인하십시오."],
    [misplacedActive, `결과: 헬퍼 자리 결함 ${misplacedActive}건이 있습니다. ${misplacedHint()}`],
    [pinOnly && pin === "scrub-blocked", PIN_LINES["scrub-blocked"]],
    [pinOnly && pin === "scrub-unsure", PIN_LINES["scrub-unsure"]],
    [!clean, `결과: 적용되지 않은 항목이 있습니다. ${rerun}`],
    [true, "결과: 모두 적용된 상태입니다."],
  ];
  log(RESULTS.find(([when]) => when)[1]);
  if (PIN_LINES[pin] && !pinOnly) {
    log(`    참고: ${PIN_LINES[pin].slice("결과: ".length)}`);
    log(`          ${pin === "scrub-unsure" ? "칸이 남아 있으면 적용도 지우지 못하고" : "적용해도 그곳의 칸은 남고"}, 적용은 이 항목을 실패로 세어 종료 1 로 끝납니다.`);
  }
  const others = targets.filter((v) => v !== active && ((needBy[v] || 0) > 0 || hjNeedBy[v] || (misplacedBy[v] || 0) > 0));
  const unreadable = targets.filter((v) => v !== active && hjFailBy[v]);
  if (unreadable.length) log(`    참고: 비활성 버전 ${unreadable.map(oneLine).join(", ")} 의 hooks.json 을 확인하지 못했습니다. 판정에는 넣지 않았습니다.`);
  const unreadHooks = targets.filter((v) => v !== active && unreadBy[v]);
  if (unreadHooks.length) log(`    참고: 비활성 버전 ${unreadHooks.map(oneLine).join(", ")} 의 훅 스크립트를 확인하지 못했습니다. 판정에는 넣지 않았습니다.`);
  if (others.length) {
    log(`    참고: 비활성 버전 ${others.map(oneLine).join(", ")} 에 미적용분이 있습니다.`);
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
// --check 가 활성 판을 추정했으면 확인하지 못한 것이라 종료 1 이다(읽지 못한 hooks.json, 훅, origin 과 같다).
process.exit(r.fail > 0 || left.size > 0 || (MODE === "check" && activeGuessed) ? 1 : 0);
