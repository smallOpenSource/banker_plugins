#!/usr/bin/env node
/**
 * OMC 패치 — 버전 고정 + 훅 결함 수정 + 자동 업데이트 차단.
 *
 *   node omc-patch.mjs              업데이트(5.3.0) + 패치 + 고정
 *   node omc-patch.mjs --check      진단만 (아무것도 바꾸지 않음)
 *   node omc-patch.mjs --revert     패치·고정 되돌리기
 *   node omc-patch.mjs --no-update  버전은 그대로 두고 패치만
 *
 * 활성 버전은 installed_plugins.json 의 oh-my-claudecode@omc 항목(version, installPath)에서
 * 읽는다. 캐시에 5.3.0 이 있다고 5.3.0 을 활성으로 보지 않는다(--no-update 는 활성 버전을 패치).
 * OMC_PATCH_INSTALLED=<json 경로> 로 읽을 파일을 바꿀 수 있다(시험용, --check 와 함께).
 *
 * OS: Windows / macOS / Linux 공통. 런처는 apply.cmd(Windows), apply.sh(그 외).
 * 배경과 근거는 같은 폴더의 README.md.
 */
import {
  readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync,
  unlinkSync, mkdirSync, rmSync, symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execFileSync } from "node:child_process";

const TARGET_VERSION = "5.3.0";
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

const argv = new Set(process.argv.slice(2));
const MODE = argv.has("--revert") ? "revert" : argv.has("--check") ? "check" : "apply";
const NO_UPDATE = argv.has("--no-update");

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
  try {
    const e = JSON.parse(readFileSync(INSTALLED, "utf8")).plugins?.[PLUGIN_KEY]?.[0];
    if (e) {
      if (typeof e.version === "string" && /^\d+\.\d+\.\d+$/.test(e.version) && versions.includes(e.version)) return { v: e.version, src: "installed_plugins.json" };
      const last = typeof e.installPath === "string" ? e.installPath.split(/[\\/]+/).filter(Boolean).pop() : null;
      if (last && versions.includes(last)) return { v: last, src: "installed_plugins.json installPath" };
    }
  } catch { /* 읽기·파싱 실패는 옛 규칙으로 */ }
  return { v: versions.includes(TARGET_VERSION) ? TARGET_VERSION : versions[0] || TARGET_VERSION, src: "추정: installed_plugins.json 에서 확인 못 함" };
}

function git(args, cwd = MARKET) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ── 1. 업데이트 ──────────────────────────────────────────────────────────────
function ensureVersion() {
  const have = installedVersions();
  if (have.includes(TARGET_VERSION)) { ok(`${TARGET_VERSION} 설치되어 있음`); return true; }
  if (MODE === "check") { bad(`${TARGET_VERSION} 미설치 (설치된 버전: ${have.join(", ") || "없음"})`); return false; }
  if (!existsSync(MARKET)) { bad(`마켓플레이스 없음: ${MARKET}\n      Claude Code 에서 marketplace 를 먼저 추가하십시오: ${REPO_URL}`); return false; }
  if (!existsSync(join(MARKET, ".git"))) { bad(`마켓플레이스 폴더가 git 저장소가 아님: ${MARKET}`); return false; }

  // git 과 tar 에 의존한다. Windows 10+ / macOS / 대부분의 Linux 배포판에는 둘 다 있지만,
  // 최소 설치 컨테이너나 tar 없는 환경에서는 없을 수 있다. 여기서 못 찾으면 아래에서
  // execFileSync 가 ENOENT 로 죽어 원인이 안 보이므로, 먼저 확인하고 무엇이 없는지 말한다.
  for (const [cmd, why] of [["git", "마켓플레이스에서 소스를 꺼내는 데"], ["tar", "그 소스를 푸는 데"]]) {
    try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); }
    catch { bad(`${cmd} 를 찾을 수 없습니다 (${why} 필요). 설치한 뒤 다시 실행하거나, --no-update 로 패치만 적용하십시오.`); return false; }
  }

  log(`  ${TARGET_VERSION} 설치 중...`);
  try { git(["fetch", "--tags", "--quiet", "origin"]); } catch { /* 오프라인이어도 로컬 태그가 있으면 진행 */ }
  let sha;
  try { sha = git(["rev-parse", `v${TARGET_VERSION}^{}`]); }
  catch { bad(`태그 v${TARGET_VERSION} 를 마켓플레이스에서 찾을 수 없음`); return false; }

  const dest = join(CACHE, TARGET_VERSION);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // git archive | tar 로 소스를 편다. 저장소에 dist/ 가 포함되어 빌드는 불필요하다.
  execFileSync("git", ["-C", MARKET, "archive", `v${TARGET_VERSION}`, "-o", join(dest, "_src.tar")], { stdio: "ignore" });
  execFileSync("tar", ["-xf", join(dest, "_src.tar"), "-C", dest], { stdio: "ignore" });
  unlinkSync(join(dest, "_src.tar"));

  // node_modules 는 복사하지 않고 직전 버전 것을 링크한다. Windows 는 junction
  // (관리자 권한 불필요), POSIX 는 type 인자가 무시되고 디렉터리 symlink 가 된다.
  const prev = have.find((v) => v !== TARGET_VERSION);
  const nm = join(dest, "node_modules");
  if (!existsSync(nm) && prev && existsSync(join(CACHE, prev, "node_modules"))) {
    try { symlinkSync(join(CACHE, prev, "node_modules"), nm, "junction"); ok(`node_modules → ${prev} 링크`); }
    catch (e) { bad(`node_modules 링크 실패(${e.code}). \`npm install\` 이 필요할 수 있음`); }
  } else if (!existsSync(nm)) {
    bad(`node_modules 없음. ${dest} 에서 \`npm install --omit=dev\` 를 실행하십시오`);
  }

  // 활성 버전 전환
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

function scanTopLevelAwaitImports(src) {
  const n = src.length;
  const fnStack = [];
  const hits = [];
  let i = 0, prev = "", prevIdx = -1;

  const wordEndingAt = (j) => {
    let e = j;
    while (j >= 0 && ID_CH.test(src[j])) j--;
    return src.slice(j + 1, e + 1);
  };
  const backSkip = (j) => {
    for (;;) {
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j >= 1 && src[j] === "/" && src[j - 1] === "*") {           // */ 로 끝나는 주석
        const s = src.lastIndexOf("/*", j - 1);
        if (s < 0) return -1;
        j = s - 1; continue;
      }
      return j;
    }
  };
  const skipString = (q) => {
    i++;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === q) { i++; return; }
      if (q === "`" && c === "$" && src[i + 1] === "{") {
        i += 2;
        let d = 1;
        while (i < n && d > 0) {
          const k = src[i];
          if (k === "\\") { i += 2; continue; }
          if (k === "'" || k === '"' || k === "`") { skipString(k); continue; }
          if (k === "{") d++;
          else if (k === "}") d--;
          i++;
        }
        continue;
      }
      i++;
    }
  };
  // 이 중괄호가 «함수 몸통» 을 여는가
  const isFunctionBrace = (at) => {
    let j = backSkip(at - 1);
    if (j < 0) return false;
    if (src[j] === ">" && src[j - 1] === "=") return true;             // () => {
    if (src[j] !== ")") return false;                                  // class/객체/블록
    let d = 0;
    for (; j >= 0; j--) {                                              // 짝 맞는 ( 찾기
      if (src[j] === ")") d++;
      else if (src[j] === "(") { if (--d === 0) break; }
    }
    if (j < 0) return false;
    const k = backSkip(j - 1);
    if (k < 0 || !ID_CH.test(src[k])) return false;
    return !BLOCK_KW.has(wordEndingAt(k));                             // if/for/while/catch… 은 블록
  };

  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") { skipString(c); prev = c; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/") {
      const asRegex = prev === "" || REGEX_PREV_CH.has(prev)
        || (prevIdx >= 0 && ID_CH.test(prev) && REGEX_PREV_KW.has(wordEndingAt(prevIdx)));
      if (asRegex) {
        i++;
        let inClass = false;
        while (i < n) {
          const k = src[i];
          if (k === "\\") { i += 2; continue; }
          if (k === "[") inClass = true;
          else if (k === "]") inClass = false;
          else if (k === "/" && !inClass) { i++; break; }
          else if (k === "\n") break;
          i++;
        }
        while (i < n && ID_CH.test(src[i])) i++;                       // 플래그
        prev = "/"; prevIdx = i - 1; continue;
      }
    }
    if (c === "{") { fnStack.push(isFunctionBrace(i)); i++; prev = "{"; prevIdx = i - 1; continue; }
    if (c === "}") { fnStack.pop(); i++; prev = "}"; prevIdx = i - 1; continue; }
    if (c === "a" && !(i > 0 && ID_CH.test(src[i - 1])) && /^await\s+import\s*\(/.test(src.slice(i, i + 40))) {
      if (!fnStack.some(Boolean)) hits.push(i);
    }
    prev = c; prevIdx = i; i++;
  }
  return hits;
}

// 자리별 상태. 이미 손으로 Promise.race 를 두른 자리는 건드리지 않는다(4.15.7 에 그런 것이 둘 있다).
function siteInfo(src) {
  if (src.includes("__omcRaceImport")) return { state: "patched", sites: [] };
  const all = scanTopLevelAwaitImports(src);
  if (!all.length) return { state: "n/a", sites: [] };
  const open = all.filter((p) => !/Promise\.race/.test(src.slice(Math.max(0, p - 300), p)));
  if (!open.length) return { state: "guarded", sites: [] };
  return { state: "needs", sites: open };
}

const needsPatch = (src) => siteInfo(src).state;

function transform(src) {
  const info = siteInfo(src);
  if (info.state !== "needs") return null;
  const edits = [];
  for (const start of info.sites) {
    const open = src.indexOf("(", src.indexOf("import", start));
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { end = i; break; }
    }
    if (end !== -1) edits.push({ start, end });
  }
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
  let done = 0, skip = 0, fail = 0, need = 0;
  const foreign = [];
  // revert 는 scripts/ 전체를 훑는다. hooks.json 기반 목록은 두 번 새는데, 실측으로
  // 4.15.7 이 둘 다 겪었다 — PostToolUse 를 지우면 그 스크립트가 목록에서 빠지고(그래서
  // .omcbak 이 있어도 안 돌아온다), 손으로 고친 파일은 .omcbak 조차 없어 아예 안 보인다.
  const names = MODE === "revert"
    ? readdirSync(join(root, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort()
    : hookNames(root);
  for (const n of names) {
    const f = join(root, "scripts", `${n}.mjs`);
    const bak = `${f}.omcbak`;
    if (!existsSync(f)) continue;

    if (MODE === "revert") {
      if (existsSync(bak)) { copyFileSync(bak, f); unlinkSync(bak); log(`  되돌림  ${n}`); done++; continue; }
      // 백업이 없는데 이미 감싸여 있다면 «이 도구가 아닌 손» 이 고친 것이다. 되돌릴 원본이
      // 디스크에 없으니 조용히 넘기지 않고 이름을 댄다(실측: 4.15.7 의 두 파일이 그랬다).
      // 주의: 손 패치는 `await import(` 를 `await Promise.race([import(` 로 «바꿔치기» 하므로
      // await import 패턴 자체가 사라진다. siteInfo 로는 잡히지 않아 원문에서 직접 찾는다.
      if (looksHandPatched(readFileSync(f, "utf8"))) foreign.push(n);
      continue;
    }
    const st = needsPatch(readFileSync(f, "utf8"));
    if (st !== "needs") { skip++; continue; }
    if (MODE === "check") { bad(`패치 필요: ${n}`); need++; continue; }

    const out = transform(readFileSync(f, "utf8"));
    if (!out) { bad(`변환 실패: ${n}`); fail++; continue; }
    if (!existsSync(bak)) copyFileSync(f, bak);
    writeFileSync(f, out, "utf8");
    const err = syntaxError(f);
    if (err) { copyFileSync(bak, f); bad(`문법오류로 롤백: ${n}\n      ${err}`); fail++; continue; }
    done++;
  }
  return { done, skip, fail, need, foreign };
}

// ── 3. PostToolUse 훅 제거 ───────────────────────────────────────────────────
function patchHooksJson(root) {
  const hj = join(root, "hooks", "hooks.json");
  const bak = `${hj}.omcbak`;
  if (!existsSync(hj)) return "no-file";
  if (MODE === "revert") {
    if (existsSync(bak)) { copyFileSync(bak, hj); unlinkSync(bak); log("  되돌림  hooks.json"); return "reverted"; }
    // 이 도구가 만든 백업이 없어도, 손으로 만든 백업이 남아 있을 수 있다(실측: 4.15.7 의
    // hooks.json.bak-20260906-postoolremove). PostToolUse 를 담고 있는 유효한 JSON 이
    // 딱 하나면 그것이 제거 직전 상태다 — 무엇을 썼는지 밝히고 되돌린다.
    const dir = join(root, "hooks");
    const cands = readdirSync(dir)
      .filter((f) => f.startsWith("hooks.json.") && f !== "hooks.json.omcbak")
      .filter((f) => {
        try { return !!JSON.parse(readFileSync(join(dir, f), "utf8"))?.hooks?.PostToolUse; }
        catch { return false; }
      });
    if (cands.length === 1) {
      copyFileSync(join(dir, cands[0]), hj);
      log(`  되돌림  hooks.json  (수동 백업 사용: ${cands[0]})`);
      return "reverted";
    }
    if (cands.length > 1) { bad(`hooks.json 수동 백업이 여러 개라 자동 복구하지 않음: ${cands.join(", ")}`); return "ambiguous"; }
    return "no-backup";
  }
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
// PINNED 파일에 적어 두고 --revert 로 복구한다). 저장소 자체는 그대로라
// 이미 받은 태그로 재설치·검증이 가능하다.
function pinMarketplace() {
  if (!existsSync(MARKET)) return "no-marketplace";
  // 마켓플레이스 폴더가 제 git 저장소가 아니면 git 이 위쪽 저장소(예: dotfiles 로 관리하는
  // ~/.claude)를 찾아 그 origin 을 바꾼다. 제 .git 이 있을 때만 고정하고 되돌린다.
  if (!existsSync(join(MARKET, ".git"))) return "no-git";
  let url;
  try { url = git(["remote", "get-url", "origin"]); } catch { return "no-remote"; }

  if (MODE === "revert") {
    // 원본 URL 은 현재 origin 안에 그대로 들어 있다(`omc-pinned://` + 원본). 파일이 아니라
    // 거기서 복원한다. PINNED 는 배포 폴더에 같이 딸려 오므로 다른 PC 의 값일 수 있고,
    // PINFILE 은 스크립트 위치가 아니라 homedir() 기준이라 그 사실이 눈에 띄지도 않는다.
    const PIN_PREFIX = "omc-pinned://";
    let restored = null;
    if (url.startsWith(PIN_PREFIX)) restored = url.slice(PIN_PREFIX.length);
    if (existsSync(PINFILE)) {
      let saved = {};
      try { saved = JSON.parse(readFileSync(PINFILE, "utf8")); } catch { /* 깨졌으면 무시 */ }
      if (saved.host && saved.host !== hostname()) {
        bad(`PINNED 는 다른 기기(${saved.host})의 기록입니다 — 그 값은 쓰지 않고 현재 origin 에서 복원합니다.`);
      }
      if (!restored && saved.originUrl) restored = saved.originUrl;
      unlinkSync(PINFILE);
    }
    if (!restored) return "not-pinned";
    try { git(["remote", "set-url", "origin", restored]); } catch { /* noop */ }
    return "unpinned";
  }
  if (url.startsWith("omc-pinned://")) return "already";
  if (MODE === "check") { bad(`마켓플레이스 미고정 (origin=${url})`); return "needs"; }

  mkdirSync(dirname(PINFILE), { recursive: true });
  // host 를 남긴다. 이 폴더는 통째로 복사해 배포하므로 PINNED 도 같이 딸려 가는데,
  // PINFILE 은 스크립트 위치가 아니라 homedir() 기준이라 남의 기록인 줄 모르고 쓰기 쉽다.
  writeFileSync(PINFILE, JSON.stringify({ originUrl: url, pinnedAt: new Date().toISOString(), version: TARGET_VERSION, host: hostname() }, null, 2) + "\n", "utf8");
  git(["remote", "set-url", "origin", `omc-pinned://${url}`]);
  return "pinned";
}

// ── main ─────────────────────────────────────────────────────────────────────
log(`OMC 패치  (대상 ${TARGET_VERSION})  모드: ${MODE}${NO_UPDATE ? " --no-update" : ""}`);
log(`플랫폼: ${process.platform}  node ${process.version}`);
log();

if (!existsSync(INSTALLED)) { bad(`Claude Code 플러그인 설정을 찾을 수 없음: ${INSTALLED}`); process.exit(1); }

log("[1/4] 버전");
if (NO_UPDATE) log("  건너뜀 (--no-update)");
else if (MODE === "revert") log("  건너뜀 (revert 는 버전을 되돌리지 않음 — README 의 롤백 절차 참고)");
else if (!ensureVersion() && MODE !== "check") { bad("버전 확보 실패 — 중단"); process.exit(1); }

const versions = installedVersions();
// [1/4] 뒤에 계산해야 일반 apply 가 TARGET_VERSION 으로 전환한 결과가 반영된다.
const { v: active, src: activeSrc } = activeVersion();
if (MODE !== "revert" && (MODE === "check" || NO_UPDATE)) {
  log(`  활성 버전: ${active} (${activeSrc})`);
  if (active !== TARGET_VERSION) {
    log(`  활성 버전이 대상(${TARGET_VERSION})과 다름 — 기본 apply 는 ${TARGET_VERSION} 로 전환하고, --no-update 는 활성 버전(${active})을 그 자리에서 패치함`);
  }
}
// apply 는 활성 버전만 손댄다. revert 와 check 는 설치된 모든 버전을 훑는다 —
// 여러 버전이 나란히 있을 때 이전 버전에 수정이 남으면, 롤백했을 때 예상과 다른
// 상태가 된다(실제로 4.15.7 의 hooks.json 수정이 그렇게 남았다).
const targets = MODE === "apply" ? [active] : (versions.length ? versions : [active]);
if (!existsSync(join(CACHE, active))) { bad(`설치 경로 없음: ${join(CACHE, active)}`); process.exit(1); }

log();
log(`[2/4] 훅 패치${MODE === "apply" ? `  (${active})` : `  (대상 ${targets.length}개 버전)`}`);
const r = { done: 0, skip: 0, fail: 0, need: 0 };
const needBy = {};
const foreignBy = {};
for (const v of targets) {
  const root = join(CACHE, v);
  if (!existsSync(root)) continue;
  if (targets.length > 1) log(`  — ${v}`);
  const x = patchHooks(root);
  needBy[v] = x.need;
  for (const k of ["done", "skip", "fail", "need"]) r[k] += x[k];
  if (x.foreign?.length) foreignBy[v] = x.foreign;
}
log(`  ${MODE === "check" ? `패치 필요 ${r.need}건` : MODE === "revert" ? `되돌림 ${r.done}건` : `패치 ${r.done}건 / 실패 ${r.fail}건`} / 대상 아님 ${r.skip}건`);
// 이 도구가 만들지 않은 수정은 되돌릴 원본이 디스크에 없다. 조용히 넘기면 «완전히
// 되돌렸다» 는 잘못된 인상을 준다 — 무엇이 남았고 어떻게 되찾는지 정확히 말한다.
for (const [v, list] of Object.entries(foreignBy)) {
  bad(`${v}: 이 도구가 만들지 않은 수정이 남아 있습니다 — ${list.join(", ")}`);
  log(`      백업(.omcbak)이 없어 되돌릴 원본이 디스크에 없습니다. 원본이 필요하면:`);
  log(`      git -C "${MARKET}" archive v${v} scripts/<이름>.mjs | tar -x -C "${join(CACHE, v)}"`);
}

log();
log("[3/4] PostToolUse 훅 제거");
const hjNeedBy = {};
for (const v of targets) {
  const root = join(CACHE, v);
  if (!existsSync(root)) continue;
  const hj = patchHooksJson(root);
  const tag = targets.length > 1 ? `${v}: ` : "";
  if (Array.isArray(hj)) ok(`${tag}제거: ${hj.join(", ")}`);
  else if (hj === "already") ok(`${tag}이미 제거됨`);
  else if (hj === "needs") hjNeedBy[v] = true;
  else if (hj === "reverted" || hj === "ambiguous") { /* patchHooksJson 이 출력함 */ }
  else if (hj === "no-backup") ok(`${tag}되돌릴 백업 없음 (이 도구가 지운 적 없음)`);
  else if (hj === "no-file") bad(`${tag}hooks.json 파일 자체가 없음`);
}

log();
log("[4/4] 자동 업데이트 차단");
// Claude Code 는 세션 시작 후 최대 10분 지연으로 마켓플레이스를 자동 fetch 한다.
// 공식 차단 수단은 두 가지뿐이고 각각 한계가 있어, 현재 상태를 같이 보여준다.
//   - DISABLE_AUTOUPDATER=1 : 확실하지만 전역(다른 마켓플레이스도 멈춤)
//   - /plugin UI 의 마켓플레이스별 토글 : omc 만 끄지만 UI 상태라 파일로 확인 불가
try {
  const st = JSON.parse(readFileSync(join(CFG, "settings.json"), "utf8"));
  const off = st?.env?.DISABLE_AUTOUPDATER;
  log(`  DISABLE_AUTOUPDATER: ${off ? `${off} (전역 차단 중)` : "미설정 (다른 마켓플레이스는 계속 자동 업데이트)"}`);
} catch { /* settings.json 이 없거나 읽을 수 없으면 표시만 생략 */ }
const pin = pinMarketplace();
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

log();
if (MODE === "check") {
  // 판정은 «활성 버전» 기준이다. apply 는 활성 버전만 손대므로, 판정만 모든 버전을 보면
  // 캐시에 옛 버전이 남아 있는 한 apply 를 몇 번 돌려도 영원히 «미적용» 으로 나온다
  // (3-OS 에서 동일하게 재현). 비활성 버전은 정보로만 알린다.
  const clean = (needBy[active] || 0) === 0 && !hjNeedBy[active] && pin !== "needs";
  const others = targets.filter((v) => v !== active && ((needBy[v] || 0) > 0 || hjNeedBy[v]));
  log(clean ? "결과: 모두 적용된 상태입니다." : "결과: 적용되지 않은 항목이 있습니다. 인자 없이 다시 실행하십시오.");
  if (others.length) {
    log(`    참고: 비활성 버전 ${others.join(", ")} 에 미적용분이 있습니다.`);
    log("          지금 쓰이지 않는 버전이라 판정에 넣지 않았습니다. 그 버전으로 되돌릴 계획이면 함께 적용하십시오.");
  }
} else if (MODE === "revert") {
  log("되돌리기 완료. Claude Code 를 재시작해야 반영됩니다.");
} else {
  log(`완료. 실패 ${r.fail}건.`);
  log("    훅 스크립트 패치는 즉시 적용됩니다 (훅이 호출될 때마다 파일을 새로 읽습니다).");
  log("[!] PostToolUse 훅 제거는 hooks.json 변경이라 각 세션이 다시 시작될 때부터 적용됩니다.");
}
process.exit(r.fail > 0 ? 1 : 0);
