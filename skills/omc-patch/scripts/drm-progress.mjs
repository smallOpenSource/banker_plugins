#!/usr/bin/env node
/**
 * DRM 대응 패치 — OMC ralph 의 진행 기록 이름을 progress.txt 에서 progress.md 로 바꾼다.
 *
 *   node drm-progress.mjs --check                 진단만 (아무것도 바꾸지 않음)
 *   node drm-progress.mjs                         활성 판에 적용
 *   node drm-progress.mjs --revert                설치된 모든 판을 되돌림
 *   node drm-progress.mjs --root <플러그인 폴더> [--check | --revert]
 *                                                 그 폴더 하나만 다룸
 *
 * 망분리 PC 의 DRM 은 .txt 파일을 암호화한다. 그러면 OMC ralph 가 만든 .omc/progress.txt 를
 * 훅도 에이전트도 다시 읽지 못한다. 기록의 내용은 이미 마크다운("# Ralph Progress Log")이라 이름만 바꾼다.
 *
 * 고치는 파일(판 폴더 기준). 셋 중 하나만 바뀌면 훅은 .md 에, CLI 는 .txt 에 쓰게 되므로 셋을 함께 바꾼다.
 *   dist/hooks/ralph/progress.js   훅이 쓰는 상수 PROGRESS_FILENAME
 *   bridge/cli.cjs                 omc CLI 번들의 같은 상수
 *   skills/ralph/SKILL.md          에이전트에게 주는 지시의 파일 이름
 * 옛 progress.txt 는 이어 읽지 않는다. DRM 이 암호화한 파일은 읽을 수 없고, 그 파일로 돌아가면 계속 그 파일에 쓴다.
 * 원본은 같은 자리에 .omcbak 으로 남는다(omc-patch.mjs 와 같은 이름). OMC 자동 업데이트가 새 판을 깔면
 * 새 판에는 패치가 없으므로 다시 적용한다.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const OLD = "progress.txt";
const NEW = "progress.md";
const PLUGIN_KEY = "oh-my-claudecode@omc";
const CACHE = join(homedir(), ".claude", "plugins", "cache", "omc", "oh-my-claudecode");
const INSTALLED = join(homedir(), ".claude", "plugins", "installed_plugins.json");
const OMC_NAMES = [[".claude-plugin/plugin.json", "oh-my-claudecode"], ["package.json", "oh-my-claude-sisyphus"]];

// 코드 파일은 상수 한 자리만 바꾼다. 그 자리가 정확히 하나가 아니면 처음 보는 모양이라 고치지 않는다.
// 문서는 이름이 나오는 모든 자리를 바꾼다.
const FILES = [
  { rel: "dist/hooks/ralph/progress.js", code: true },
  { rel: "bridge/cli.cjs", code: true },
  { rel: "skills/ralph/SKILL.md", code: false },
];
const constRe = (name) => new RegExp(`PROGRESS_FILENAME = (['"])${name.replace(".", "\\.")}\\1`, "g");
const OLD_CONST = constRe(OLD);
const NEW_CONST = constRe(NEW);
const OLD_WORD = /(?<![A-Za-z0-9_-])progress\.txt(?![A-Za-z0-9_])/g;

const log = (s = "") => console.log(s);
const bad = (s) => console.log(`  [!] ${s}`);
const ok = (s) => console.log(`  ok  ${s}`);
const count = (src, re) => (src.match(re) || []).length;

/** 원본 글을 패치한 글. 바꿀 자리의 모양이 맞지 않으면 null. */
export function transform(src, code) {
  if (code) return count(src, OLD_CONST) === 1 ? src.replace(OLD_CONST, (_, q) => `PROGRESS_FILENAME = ${q}${NEW}${q}`) : null;
  return count(src, OLD_WORD) > 0 ? src.replace(OLD_WORD, NEW) : null;
}

/** 지금 글의 상태: "original" | "patched" | "unknown". */
export function stateOf(src, code) {
  if (transform(src, code) !== null) return "original";
  if (code) return count(src, OLD_CONST) === 0 && count(src, NEW_CONST) === 1 ? "patched" : "unknown";
  return count(src, OLD_WORD) === 0 && src.includes(NEW) ? "patched" : "unknown";
}

// ── 파일 확인 ──────────────────────────────────────────────────────────────
function insideRoot(root, p) {
  const rel = relative(realpathSync(root), realpathSync(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 쓸 수 없는 까닭, 쓸 수 있으면 null. 링크는 플러그인 폴더 안을 가리킬 때만, 일반 파일만 받는다. */
function whyNot(root, p) {
  const l = lstatSync(p, { throwIfNoEntry: false });
  if (!l) return null;
  if (l.isSymbolicLink() && !insideRoot(root, p)) return "링크가 플러그인 폴더 밖을 가리킴";
  return statSync(p).isFile() ? null : "일반 파일이 아님";
}

function readText(p) {
  return readFileSync(p, "utf8");
}

/** 새 임시 파일을 디스크까지 내린 뒤 rename 으로 바꾼다. 링크면 링크가 가리키는 파일을 바꾼다. */
function writeAtomic(p, data) {
  const target = lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(p) : p;
  const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.drm-progress.tmp`);
  const fd = openSync(tmp, "wx", existsSync(target) ? statSync(target).mode & 0o777 : 0o644);
  try {
    writeSync(fd, data);
    try { fsyncSync(fd); } catch (e) { if (!["EINVAL", "ENOTSUP"].includes(e.code)) throw e; }
  } finally { closeSync(fd); }
  try { renameSync(tmp, target); } catch (e) { try { unlinkSync(tmp); } catch { /* 이미 없음 */ } throw e; }
}

function syntaxOk(p) {
  try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe", windowsHide: true }); return true; }
  catch { return false; }
}

// ── 판 폴더 하나 살피기 ────────────────────────────────────────────────────
/** 파일마다 { rel, code, path, bak, state, src, why }. state: missing | original | patched | unknown | unsafe | unreadable */
function survey(root) {
  return FILES.map((f) => {
    const path = join(root, f.rel);
    const item = { ...f, path, bak: `${path}.omcbak` };
    if (!existsSync(path)) return { ...item, state: "missing" };
    const why = whyNot(root, path) || whyNot(root, item.bak);
    if (why) return { ...item, state: "unsafe", why };
    try { item.src = readText(path); } catch (e) { return { ...item, state: "unreadable", why: e.code || e.message }; }
    return { ...item, state: stateOf(item.src, f.code) };
  });
}

function summarize(items) {
  const present = items.filter((x) => x.state !== "missing");
  if (!present.length) return "none";
  if (present.some((x) => ["unsafe", "unreadable", "unknown"].includes(x.state))) return "blocked";
  if (present.length < items.length) return "partial";
  return present.every((x) => x.state === "patched") ? "patched" : "needs";
}

function describe(x) {
  const word = {
    missing: "없음", original: "패치 필요", patched: "적용됨", unknown: "처음 보는 모양 (고치지 않음)",
    unsafe: `쓰지 않음 (${x.why})`, unreadable: `읽지 못함 (${x.why})`,
  }[x.state];
  return `${x.rel}: ${word}`;
}

// ── 적용 ──────────────────────────────────────────────────────────────────
/** 셋을 모두 바꾸거나 하나도 바꾸지 않는다. 실패 건수를 돌려준다. */
function applyRoot(root) {
  const items = survey(root);
  for (const x of items) log(`  ${describe(x)}`);
  const sum = summarize(items);
  if (sum === "none") { ok("이 판에는 ralph 진행 기록 코드가 없음. 할 일 없음"); return 0; }
  if (sum === "partial") { bad("세 파일 중 일부가 없어 고치지 않음 (한쪽만 바꾸면 훅과 CLI 가 다른 이름을 씀)"); return 1; }
  if (sum === "blocked") { bad("고칠 수 없는 파일이 있어 하나도 고치지 않음"); return 1; }
  if (sum === "patched") { ok("이미 적용됨"); return 0; }
  const todo = items.filter((x) => x.state === "original");
  const done = [];
  try {
    for (const x of todo) {
      keepBackup(x);
      writeAtomic(x.path, transform(x.src, x.code));
      done.push(x);
      if (x.code && !syntaxOk(x.path)) throw new Error(`${x.rel}: 고친 뒤 문법 오류`);
    }
  } catch (e) {
    bad(`${e.message || e} — 이번에 고친 파일을 원본으로 되돌림`);
    for (const x of done) writeAtomic(x.path, x.src);
    return 1;
  }
  for (const x of todo) ok(`패치: ${x.rel}`);
  return 0;
}

/** 백업이 없으면 만들고, 지금 원본과 다른 옛 백업이면 지금 원본으로 바꾼다. */
function keepBackup(x) {
  if (existsSync(x.bak) && readText(x.bak) === x.src) return;
  if (existsSync(x.bak)) ok(`옛 백업을 지금 원본으로 바꿈: ${x.rel}`);
  writeAtomic(x.bak, x.src);
}

// ── 되돌리기 ──────────────────────────────────────────────────────────────
/** 실패 건수를 돌려준다. 이 도구가 만든 글일 때만 백업으로 되돌린다. */
function revertRoot(root) {
  let fail = 0;
  for (const x of survey(root)) {
    if (!existsSync(x.bak)) { if (x.state === "patched") log(`  ${x.rel}: 백업 없음 (이 도구가 바꾸지 않았거나 원래 ${NEW})`); continue; }
    if (x.state === "unsafe" || x.state === "unreadable") { bad(`되돌리지 않음: ${x.rel} (${x.why})`); fail++; continue; }
    let orig;
    try { orig = readText(x.bak); } catch (e) { bad(`읽지 못함: ${x.rel} 의 백업 (${e.code || e.message})`); fail++; continue; }
    if (x.state === "missing") { log(`  ${x.rel}: 파일이 없어 백업을 그대로 둠`); continue; }
    if (x.src === orig) { unlinkSync(x.bak); ok(`백업 정리: ${x.rel} (이미 원본)`); continue; }
    if (transform(orig, x.code) !== x.src) {
      bad(`되돌리지 않음: ${x.rel} (지금 글이 이 도구의 패치본과 다름. 백업이 옛 원본일 수 있음)`);
      fail++;
      continue;
    }
    writeAtomic(x.path, orig);
    unlinkSync(x.bak);
    ok(`되돌림: ${x.rel}`);
  }
  return fail;
}

// ── 대상 판 ───────────────────────────────────────────────────────────────
function activeRoot() {
  try {
    const e = JSON.parse(readFileSync(INSTALLED, "utf8")).plugins?.[PLUGIN_KEY]?.[0];
    return e?.installPath && existsSync(e.installPath) ? e.installPath : null;
  } catch { return null; }
}

/** 캐시의 판 폴더. 링크로 같은 폴더를 가리키는 판은 한 번만 센다. */
function allRoots() {
  if (!existsSync(CACHE)) return [];
  const seen = new Set();
  return readdirSync(CACHE).map((v) => join(CACHE, v)).filter((p) => {
    let real;
    try { real = realpathSync(p); } catch { return false; }
    if (seen.has(real) || !statSync(real).isDirectory()) return false;
    seen.add(real);
    return true;
  });
}

/** 활성 판과 다른 실제 폴더의 판들. */
function othersThan(active) {
  const real = realpathSync(active);
  return allRoots().filter((p) => realpathSync(p) !== real);
}

function otherPluginName(root) {
  for (const [rel, want] of OMC_NAMES) {
    try {
      const name = JSON.parse(readFileSync(join(root, rel), "utf8")).name;
      if (typeof name === "string") return name === want ? null : name;
    } catch { /* 다음 이름표 */ }
  }
  return null;
}

// ── main ─────────────────────────────────────────────────────────────────
const USAGE = [
  "사용법:",
  "  node drm-progress.mjs --check     진단만",
  "  node drm-progress.mjs             활성 판에 적용",
  "  node drm-progress.mjs --revert    설치된 모든 판을 되돌림",
  "  node drm-progress.mjs --root <플러그인 폴더> [--check | --revert]",
].join("\n");

function parseArgs(list) {
  const o = { mode: "apply", root: null };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "--check" || a === "--revert") {
      if (o.mode !== "apply") return { error: "--check 와 --revert 는 함께 쓸 수 없습니다" };
      o.mode = a.slice(2);
    } else if (a === "--root" && list[i + 1] && !list[i + 1].startsWith("--") && !o.root) o.root = resolve(list[++i]);
    else if (a === "--help" || a === "-h") return { help: true };
    else return { error: `알 수 없는 인자: ${JSON.stringify(a)}` };
  }
  return o;
}

// 결과 줄. SKILL 의 표가 이 문구로 판정한다.
const RESULT = {
  blocked: "결과: 고칠 수 없는 파일이 있습니다. 위의 줄을 확인하십시오.",
  partial: "결과: 세 파일 중 일부가 없어 고치지 않습니다. OMC 설치가 온전한지 확인하십시오.",
  needs: "결과: 적용되지 않았습니다.",
  patched: "결과: 적용된 상태입니다.",
  none: "결과: 이 판에는 ralph 진행 기록 코드가 없어 할 일이 없습니다.",
};

/** anti-drm 설정이 .txt 를 막는지. SKILL 이 패치를 물을지 정하는 데 쓴다. 설정은 읽기만 한다. */
function antiDrmLine() {
  const file = process.env.BANKER_ANTI_DRM_CONFIG || join(homedir(), ".config", "banker", "anti-drm.json");
  if (!existsSync(file)) return "anti-drm: 설정 없음";
  try {
    const deny = JSON.parse(readFileSync(file, "utf8")).deny;
    const has = Array.isArray(deny) && deny.some((x) => String(x).toLowerCase() === ".txt");
    return `anti-drm: .txt ${has ? "금지" : "금지 안 함"} (${file})`;
  } catch { return `anti-drm: 설정을 읽지 못함 (${file})`; }
}

function checkRoots(roots, active) {
  log(`  ${antiDrmLine()}`);
  let sum = "none";
  for (const root of roots) {
    const items = survey(root);
    log(`  — ${root}${root === active ? " (활성)" : ""}`);
    for (const x of items) log(`    ${describe(x)}`);
    if (root === active) sum = summarize(items);
  }
  log();
  log(RESULT[sum]);
  return sum === "blocked" || sum === "partial" ? 1 : 0;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { log(USAGE); return 0; }
  if (o.error) { bad(o.error); log(USAGE); return 1; }
  if (o.root) {
    if (!existsSync(o.root) || !statSync(o.root).isDirectory()) { bad(`폴더가 아님: ${o.root}`); return 1; }
    const other = otherPluginName(o.root);
    if (other) { bad(`OMC 플러그인 폴더가 아님 (${other}): ${o.root}`); return 1; }
  }
  const active = o.root || activeRoot();
  log(`OMC DRM 대응 패치 (${OLD} 를 ${NEW} 로)  모드: ${o.mode}`);
  if (!active && o.mode !== "revert") { bad("활성 OMC 판을 installed_plugins.json 에서 찾지 못함"); return 1; }
  if (o.mode === "check") return checkRoots(o.root ? [o.root] : [active, ...othersThan(active)], active);
  if (o.mode === "apply") {
    log(`  대상: ${active}`);
    const fail = applyRoot(active);
    log();
    log(`완료. 실패 ${fail}건.`);
    return fail ? 1 : 0;
  }
  let fail = 0;
  for (const root of o.root ? [o.root] : allRoots()) { log(`  — ${root}`); fail += revertRoot(root); }
  log();
  log(fail ? `되돌리기를 끝내지 못했습니다. 실패 ${fail}건.` : "되돌리기 완료.");
  return fail ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
