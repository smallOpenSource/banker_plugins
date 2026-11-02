#!/usr/bin/env node
/**
 * init-dir: makes a project's managed folders (logs, scripts, work, mockup, tests, docs, KB), gives each newly
 * made folder its template files, and records every managed folder's purpose in AGENTS.md and CLAUDE.md.
 *
 *   node init-dir.mjs [apply] --runtime claude|codex [--root <dir>] [--only=<folder,...>] [--follow-symlink]
 *                     [--dry-run] [--json]
 *   node init-dir.mjs status [--root <dir>] [--json]
 *
 * - A folder that is already there gets no template file, only its purpose passed on.
 * - A new folder gets all its templates or does not appear: they are written into a temp folder beside it, which
 *   is then renamed into place. A failure removes the temp folder and exits 1, so the next run starts clean.
 *   A temp folder left by a killed run is reported by status and apply ("남은 임시 폴더"), never removed.
 * - The block goes into each of AGENTS.md and CLAUDE.md that exists (exact names). With neither, the runtime's
 *   file is made (claude: CLAUDE.md, codex: AGENTS.md). In AGENTS.md the block sits inside its own
 *   USER:OMX:POLICY pair at the end, so `omx setup --merge-agents` keeps it.
 * - The block lists every managed folder on disk, so the same disk gives the same bytes.
 * - marker-block.mjs refuses links (unless --follow-symlink), hard links, other owners, broken markers and files
 *   that are not UTF-8; a refusal changes nothing.
 *
 * Exit status: 0 done (nothing to change included), 1 refused or a write failed, 2 usage error, 3 environment
 * (only a differently cased instructions file on a case-sensitive file system, or the root is HOME or a file
 * system root). No network is used.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HTML, applyBlocks } from "./marker-block.mjs";
import { FOLDERS, PURPOSES, blockBody, summaryLines, writeTemplates } from "./templates.mjs";

export const USAGE = [
  "init-dir: 프로젝트 관리 폴더(logs, scripts, work, mockup, tests, docs, KB)를 만들고 폴더 목적을 AGENTS.md, CLAUDE.md 에 기록",
  "사용법: node init-dir.mjs [apply] --runtime claude|codex [--root <dir>] [--only=<폴더,...>] [--follow-symlink] [--dry-run] [--json]",
  "        node init-dir.mjs status [--root <dir>] [--json]",
  "종료 코드: 0 성공(바뀐 것 없음 포함), 1 거부나 쓰기 실패, 2 사용 오류, 3 환경(대소문자 충돌, 루트가 HOME 이나 파일 시스템 루트)",
].join("\n");

const POLICY = { open: "<!-- USER:OMX:POLICY:START -->", close: "<!-- USER:OMX:POLICY:END -->" };
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"];
const FLAGS = { "--follow-symlink": "follow", "--dry-run": "dryRun", "--json": "json", "--help": "help", "-h": "help" };
const VALUES = { "--runtime": "runtime", "--root": "root", "--only": "only" };
const SUBCOMMANDS = new Set(["apply", "status"]);
const fail = (code, error, extra = {}) => ({ code, error, ...extra });

function splitArg(a) {
  const eq = a.indexOf("=");
  return a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
}

/** The options in argv, or { error } (exit 2). */
function parseArgs(argv) {
  const o = { cmd: "apply", runtime: null, root: process.cwd(), only: null, follow: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = splitArg(argv[i]);
    if (FLAGS[name] && inline === undefined) {
      o[FLAGS[name]] = true;
      continue;
    }
    if (VALUES[name]) {
      const value = inline ?? argv[++i];
      if (!value) return { error: `${name} 에 값이 없음` };
      o[VALUES[name]] = value;
      continue;
    }
    if (i === 0 && SUBCOMMANDS.has(name)) o.cmd = name;
    else return { error: `모르는 인자: ${argv[i]}` };
  }
  return o;
}

/** The folder names in an --only value, case-insensitive, as FOLDERS spells them; or { error }. */
function normalizeOnly(value) {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !FOLDERS.some((f) => f.toLowerCase() === n.toLowerCase()));
  if (unknown.length > 0) return { error: `모르는 폴더 이름: ${unknown.join(", ")} (쓸 수 있는 이름: ${FOLDERS.join(", ")})` };
  if (names.length === 0) return { error: "--only 에 폴더 이름이 없음" };
  return { folders: FOLDERS.filter((f) => names.some((n) => n.toLowerCase() === f.toLowerCase())) };
}

function validate(o) {
  if (o.runtime !== null && o.runtime !== "claude" && o.runtime !== "codex") return `--runtime 은 claude 나 codex: ${o.runtime}`;
  if (o.cmd === "apply" && o.runtime === null) return "--runtime claude|codex 가 필요함";
  return null;
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// Whether a and b are one folder: device and inode (bigint, as NTFS file ids pass 2^53), or where the file system has
// no inode numbers, the path as the file system spells it (realpathSync.native gives one spelling for names that differ
// only in case, an 8.3 short name or a linked parent), case folded on Windows and macOS. A string compare of the JS
// realpath let `--root c:\users\me` (or /users/me on macOS) pass the HOME refusal.
function sameDir(a, b) {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    if (x.ino !== 0n && y.ino !== 0n) return x.dev === y.dev && x.ino === y.ino;
  } catch {
    // one is gone: the spellings below decide
  }
  const spell = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return real(p);
    }
  };
  const fold = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  return fold(spell(a)) === fold(spell(b));
}

// The root folder, or a failure: missing (2), HOME or a file system root (3).
function checkRoot(rootArg) {
  const root = resolve(rootArg);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return fail(2, `루트 폴더가 없음: ${root}`);
  const r = real(root);
  if (sameDir(root, homedir())) return fail(3, `루트가 HOME 이라 거부: ${root}. 프로젝트 폴더에서 실행하거나 --root 로 지정`);
  if (parse(r).root === r) return fail(3, `루트가 파일 시스템 루트라 거부: ${root}`);
  return { root };
}

/**
 * The instructions files to write, AGENTS.md first: the exact names present, or on a case-insensitive file system
 * the name as it is on disk. A differently cased name alone on a case-sensitive file system is a conflict.
 */
function instructionFiles(root, runtime) {
  const listing = readdirSync(root);
  const files = [];
  const conflicts = [];
  for (const exact of INSTRUCTION_NAMES) {
    const variant = listing.find((n) => n !== exact && n.toLowerCase() === exact.toLowerCase());
    if (listing.includes(exact)) files.push(exact);
    else if (variant && lstatSync(join(root, exact), { throwIfNoEntry: false })) files.push(variant);
    else if (variant) conflicts.push(variant);
  }
  if (conflicts.length > 0) return { conflicts };
  if (files.length === 0 && runtime) files.push(runtime === "codex" ? "AGENTS.md" : "CLAUDE.md");
  return { files };
}

// Each managed folder: there (a folder, or a link to one), blocked (something else at the name), wanted.
function folderStates(root, wanted) {
  return FOLDERS.map((name) => {
    const path = join(root, name);
    const st = statSync(path, { throwIfNoEntry: false });
    const blocked = st ? !st.isDirectory() : lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    return { name, exists: st?.isDirectory() === true, blocked, wanted: wanted.includes(name) };
  });
}

function overrideWarning(root) {
  const path = join(root, "AGENTS.override.md");
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return null;
  const why = "Codex 는 이 폴더의 AGENTS.md 대신 AGENTS.override.md 를 읽을 수 있음. init-dir 은 override 에 쓰지 않음";
  if (!st.isFile()) return `경고: AGENTS.override.md 가 일반 파일이 아님(내용 확인 안 함). ${why}`;
  if (st.size > 32 * 1024 * 1024) return `경고: AGENTS.override.md 가 32MiB 보다 큼(내용 확인 안 함). ${why}`;
  return /\S/.test(readFileSync(path, "utf8")) ? `경고: AGENTS.override.md 에 내용이 있음. ${why}` : null;
}

const LEFTOVER_RE = new RegExp(`^\\.(?:${FOLDERS.join("|")})\\.init-dir-[0-9a-f]+$`);

// The temp folders (.<name>.init-dir-<random>) a killed run left in root, one warning line each.
function leftoverWarnings(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LEFTOVER_RE.test(e.name))
    .map((e) => `남은 임시 폴더: ${join(root, e.name)} (지워도 됨)`)
    .sort();
}

const blockEntries = (root, files, present, follow) =>
  files.map((name) => ({
    path: join(root, name),
    name,
    comment: HTML,
    id: "banker:init-dir",
    body: blockBody(present),
    skill: "init-dir",
    wrap: name.toLowerCase() === "agents.md" ? POLICY : null,
    followSymlink: follow,
  }));

function instructionStatus(r) {
  if (r.ok === false) return `refused:${r.refused}`;
  if (r.sameAs) return "same-file";
  if (!r.changed) return "unchanged";
  return r.created || r.before === null ? "created" : "updated";
}

// Everything decided before anything is written: a refusal here leaves the disk as it was.
function prepare(o) {
  const at = checkRoot(o.root);
  if (at.error) return at;
  const { root } = at;
  const inst = instructionFiles(root, o.runtime);
  if (inst.conflicts) return fail(3, `경고: 대소문자가 다른 지시 파일만 있음: ${inst.conflicts.join(", ")}. 이 파일 시스템은 대소문자를 구분하므로 AGENTS.md, CLAUDE.md 와 다른 파일임. 아무 파일도 만들지 않음. 이름을 바꾼 뒤 다시 실행`);
  const wanted = o.only === null ? FOLDERS : o.only;
  const folders = folderStates(root, wanted);
  const blocked = folders.filter((f) => f.wanted && f.blocked).map((f) => f.name);
  if (blocked.length > 0) return fail(1, `폴더 자리에 폴더가 아닌 것이 있어 거부: ${blocked.join(", ")}. 아무것도 바꾸지 않음`);
  const present = folders.filter((f) => f.exists || f.wanted).map((f) => f.name);
  const entries = blockEntries(root, inst.files, present, o.follow);
  const plan = applyBlocks(entries, { dryRun: true });
  if (!plan.ok) return fail(1, `지시 파일 거부: ${plan.refused.map((r) => r.message).join("; ")}. 아무것도 바꾸지 않음`);
  return { root, folders, present, entries, plan, warnings: [overrideWarning(root)].filter(Boolean) };
}

// One new folder with every template, or none of it. The templates go into root/.<name>.init-dir-<random> (same
// parent, so same volume) and that folder is renamed to root/<name>. Rename of a folder whose target is absent
// works on every OS: on Windows libuv calls MoveFileExW(MOVEFILE_REPLACE_EXISTING), which moves a directory when
// the target does not exist and fails with EPERM when a directory is there (directories are never replaced). On
// any failure the temp folder is removed and the error rethrown. Returns the rel paths written, or null when a
// folder appeared at the name meanwhile (then it is left alone).
function makeFolder(root, name) {
  const tmp = join(root, `.${name}.init-dir-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmp);
  try {
    const files = writeTemplates(root, name, tmp);
    renameSync(tmp, join(root, name));
    return files;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory()) return null;
    throw e;
  }
}

// Makes the wanted folders that are not there, each with its templates.
function makeFolders(root, folders) {
  return folders
    .filter((f) => f.exists || f.wanted)
    .map((f) => {
      const files = f.exists ? null : makeFolder(root, f.name);
      return files ? { name: f.name, status: "created", files } : { name: f.name, status: "exists", files: [] };
    });
}

function plannedFolders(folders) {
  return folders.filter((f) => f.exists || f.wanted).map((f) => ({ name: f.name, status: f.exists ? "exists" : "planned", files: [] }));
}

function apply(o) {
  const p = prepare(o);
  if (p.error) return p;
  const folders = o.dryRun ? plannedFolders(p.folders) : makeFolders(p.root, p.folders);
  const done = o.dryRun ? p.plan : applyBlocks(p.entries);
  if (!done.ok) {
    const wrote = done.partial ? done.results.filter((r) => r.ok && r.changed).map((r) => r.path) : [];
    return fail(1, `지시 파일 거부: ${done.refused.map((r) => r.message).join("; ")}. 폴더는 만들었음${wrote.length ? `. 이미 쓴 파일: ${wrote.join(", ")}` : ""}`);
  }
  const instructions = done.results.map((r, i) => ({ file: p.entries[i].name, status: instructionStatus(r) }));
  const warnings = [...p.warnings, ...leftoverWarnings(p.root)];
  return { code: 0, report: { ok: true, command: "apply", root: p.root, runtime: o.runtime, dryRun: o.dryRun, folders, instructions, warnings, present: p.present } };
}

function status(o) {
  const at = checkRoot(o.root);
  if (at.error) return at;
  const inst = instructionFiles(at.root, null);
  const conflict = inst.conflicts ? `경고: 대소문자가 다른 지시 파일만 있음: ${inst.conflicts.join(", ")}` : null;
  const warnings = [overrideWarning(at.root), conflict, ...leftoverWarnings(at.root)].filter(Boolean);
  const present = folderStates(at.root, []).filter((f) => f.exists).map((f) => f.name);
  const folders = FOLDERS.map((name) => ({ name, status: present.includes(name) ? "exists" : "missing", files: [] }));
  const instructions = (inst.files ?? []).map((name) => {
    const r = applyBlocks(blockEntries(at.root, [name], present, o.follow), { dryRun: true }).results[0];
    return { file: name, status: r.ok ? (r.changed ? "stale" : "current") : `refused:${r.refused}` };
  });
  return { code: 0, report: { ok: true, command: "status", root: at.root, folders, instructions, warnings, present } };
}

const FOLDER_WORDS = { created: "만듦", exists: "있음(목적만 전달)", planned: "만들 예정", missing: "없음" };
const INSTRUCTION_WORDS = { created: "블록 씀(새로 만듦)", updated: "블록 씀", unchanged: "변경 없음", "same-file": "같은 파일이라 한 번만 씀", current: "블록 최신", stale: "블록 없음 또는 낡음(apply 실행)" };

function textLines(rep) {
  const head = `init-dir ${rep.command}${rep.dryRun ? " (dry-run, 바꾸지 않음)" : ""}: ${rep.root}`;
  const rows = [];
  for (const f of rep.folders) {
    rows.push(`| \`${f.name}/\` | ${rep.command === "status" && f.status === "exists" ? "있음" : FOLDER_WORDS[f.status]} |`);
    for (const file of f.files) rows.push(`| \`${file}\` | 만듦 |`);
  }
  for (const i of rep.instructions) rows.push(`| \`${i.file}\` | ${INSTRUCTION_WORDS[i.status] ?? `거부(${i.status})`} |`);
  const summary = summaryLines(rep.present);
  return [head, "", "| 대상 | 결과 |", "|---|---|", ...rows, "", ...rep.warnings, ...(rep.warnings.length ? [""] : []), "폴더 목적 요약", ...(summary.length ? summary : ["- (관리 폴더 없음)"])];
}

function jsonOf(rep) {
  const summary = FOLDERS.filter((f) => rep.present.includes(f)).map((f) => ({ folder: f, purpose: PURPOSES[f] }));
  const { present, ...rest } = rep;
  return JSON.stringify({ ...rest, summary });
}

// The options checked: { error } for a usage error, --only turned into folder names.
function options(argv) {
  const o = parseArgs(argv);
  if (o.error || o.help) return o;
  const bad = validate(o);
  if (bad) return { ...o, error: bad };
  if (o.only === null) return o;
  const only = normalizeOnly(o.only);
  return only.error ? { ...o, error: only.error } : { ...o, only: only.folders };
}

/** Runs init-dir with argv; returns { code, stdout, stderr } and writes nothing to the console. */
export function run(argv) {
  const o = options(argv);
  if (o.help) return { code: 0, stdout: USAGE, stderr: "" };
  if (o.error) return finish(o, fail(2, `${o.error}\n${USAGE}`));
  try {
    return finish(o, o.cmd === "status" ? status(o) : apply(o));
  } catch (e) {
    return finish(o, fail(1, `쓰기 실패: ${e.message}`));
  }
}

function finish(o, r) {
  if (r.error) {
    const out = o.json ? JSON.stringify({ ok: false, exit: r.code, error: r.error.split("\n")[0] }) : "";
    return { code: r.code, stdout: out, stderr: `init-dir: ${r.error}` };
  }
  return { code: r.code, stdout: o.json ? jsonOf(r.report) : textLines(r.report).join("\n"), stderr: "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(`${r.stdout}\n`);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exitCode = r.code;
}
