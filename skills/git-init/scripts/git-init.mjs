#!/usr/bin/env node
/**
 * git-init: makes the first commit of a folder that is not a git repository yet, so worktrees and other parallel
 * work can start from it. Writes a .gitignore that keeps secrets and local state out, scans what would be
 * tracked for secrets, then runs `git init`, `git add .` and `git commit -m "init"`.
 *
 *   node git-init.mjs [check|run] [--root <dir>] [--branch <name>] [--local-identity "<name> <<mail>>"] [--nested]
 *                     [--accept <file:line:kind>]... [--follow-symlink] [--json]
 *
 * - check (the default) writes nothing: it shows the .gitignore block, the number of files that would be tracked
 *   and the scan result.
 * - The .gitignore is written new, or the missing patterns go into a `# banker:git-init:start` .. `:end` block at
 *   its end through marker-block.mjs (links refused unless --follow-symlink, first original kept in
 *   .gitignore.git-init.bak).
 * - The files to track are listed with an empty temp repository (`--git-dir` in the temp folder, `--work-tree`
 *   the root), so the root gets no .git before the scan passes.
 * - Names that hold keys (.env, *.pem, .npmrc, ...) block the commit and cannot be accepted. Content hits from
 *   payload-scan.mjs are reported as file:line:kind only, never the value; --accept passes one exact
 *   file:line:kind the user confirmed as a false hit.
 * - After `git add .` the staged names must equal the scanned list, or nothing is committed.
 *
 * Exit status: 0 committed (or check found nothing), 1 scan hits, a write refused or a git step failed, 2 usage
 * error, 3 precondition (no git, root is HOME or a file system root, GIT_DIR or GIT_WORK_TREE set, already in a
 * repository, a .git below the root, no commit identity). No network is used.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { HASH, commitBlock, findBlock, markers, planBlock } from "./marker-block.mjs";
import { scan } from "./payload-scan.mjs";

// The folder programs start in: the home folder (Windows looks for a program in the working folder first, so a
// program planted in the folder worked on never runs), or the temp folder when there is no home folder.
const runDir = () => (existsSync(homedir()) ? homedir() : tmpdir());

const USAGE = [
  "git-init: 민감 정보를 빼는 .gitignore 를 쓰고 비밀값을 스캔한 뒤 git init, git add ., git commit -m \"init\" 으로 첫 커밋을 만듦(check 는 계획만)",
  "사용법: node git-init.mjs [check|run] [--root <dir>] [--branch <이름>] [--local-identity \"<이름> <<메일>>\"] [--nested]",
  "        [--accept <파일:줄:종류>]... [--follow-symlink] [--json]",
  "종료 코드: 0 커밋 완료(check 는 걸림 없음), 1 스캔 걸림이나 쓰기 거부나 git 단계 실패, 2 사용 오류, 3 선행 조건 실패(아무것도 안 바꿈)",
].join("\n");

/** The .gitignore patterns git-init makes sure of. Every name NAME_RULES blocks has one, so a file blocked by name
 * is left out by the .gitignore and stops the commit only when a user `!` pattern brings it back. */
export const PATTERNS = Object.freeze([
  ".env", ".env.*", "!.env.example", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "id_rsa*", "id_ecdsa*",
  "id_ed25519*", "credentials.json", "*.tfstate", "*.tfstate.*", ".aws/", ".ssh/", ".omc/", ".omx/", "node_modules/",
  ".npmrc", ".netrc", "_netrc", ".pgpass", ".DS_Store", "Thumbs.db", ".gitignore.git-init.bak",
  ".*.init-dir-*/",
]);

const ID = "banker:git-init";
const SKILL = "git-init";
const BLOCK_HEAD = "# 비밀값과 로컬 상태를 커밋에서 뺌(banker git-init)";
const SCAN_MAX = 2 * 1024 * 1024;
const WARN_BYTES = 100 * 1024 * 1024;
const COMMIT_TIMEOUT_MS = 120000;
const STRIP_ENV = ["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];
const FLAGS = { "--nested": "nested", "--follow-symlink": "follow", "--json": "json", "--help": "help", "-h": "help" };
const VALUES = { "--root": "root", "--branch": "branch", "--local-identity": "identity" };
const SUBCOMMANDS = new Set(["check", "run"]);
const ACCEPT_RE = /^(.+):([1-9]\d*):([a-z0-9-]+)$/;
const IDENTITY_RE = /^\s*([^<>\r\n]*[^<>\s])\s*<([^<>\s]+@[^<>\s]+)>\s*$/;
// File names that hold keys or credentials: blocked by name, whatever their content.
const NAME_RULES = [
  /^\.env$/i, /^\.env\..+/i, /\.(?:pem|key|p12|pfx|jks|keystore)$/i, /^id_(?:rsa|ecdsa|ed25519)(?!.*\.pub$)/i,
  /^credentials\.json$/i, /\.tfstate(?:\..+)?$/i, /^\.npmrc$/i, /^[._]netrc$/i, /^\.pgpass$/i,
];
const fail = (code, error, report) => ({ code, error, report });

function splitArg(a) {
  const eq = a.indexOf("=");
  return a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
}

// Stores the value of option name (inline or the next argv item); returns the index of its last item, or { error }.
function takeValue(o, name, inline, argv, i) {
  const value = inline ?? argv[i + 1];
  if (!value) return { error: `${name} 에 값이 없음` };
  if (name === "--accept") o.accept.push(value);
  else o[VALUES[name]] = value;
  return inline === undefined ? i + 1 : i;
}

/** The options in argv, or { error } (exit 2). --accept may be given more than once. */
function parseArgs(argv) {
  const o = { cmd: "check", root: process.cwd(), branch: null, identity: null, nested: false, accept: [], follow: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = splitArg(argv[i]);
    if (FLAGS[name] && inline === undefined) {
      o[FLAGS[name]] = true;
      continue;
    }
    if (VALUES[name] || name === "--accept") {
      const next = takeValue(o, name, inline, argv, i);
      if (next.error) return next;
      i = next;
      continue;
    }
    if (i === 0 && SUBCOMMANDS.has(name)) o.cmd = name;
    else return { error: `모르는 인자: ${argv[i]}` };
  }
  return o;
}

/** { name, email } from "<name> <<mail>>", or null. */
function parseIdentity(text) {
  const m = IDENTITY_RE.exec(text);
  return m ? { name: m[1], email: m[2] } : null;
}

function validate(o) {
  const bad = o.accept.find((a) => !ACCEPT_RE.test(a));
  if (bad) return `--accept 는 <파일>:<줄>:<종류> 꼴: ${bad}`;
  if (o.identity !== null && !parseIdentity(o.identity)) return `--local-identity 는 "<이름> <<메일>>" 꼴: ${o.identity}`;
  return null;
}

function gitEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

// On Windows git is a wrapper (cmd\git.exe) that starts the real git: a time limit on the wrapper alone leaves the real
// git running, which can still make the commit after the failure was reported. With a time limit, git runs under this
// small Node supervisor instead, which ends the whole tree with System32's taskkill /T /F and exits 124.
const TREE_SUPERVISOR = [
  "const {spawn,spawnSync}=require('child_process');const p=require('path');",
  "const [ms,...a]=process.argv.slice(1);",
  "const c=spawn('git',a,{stdio:'inherit',windowsHide:true});",
  "const t=setTimeout(()=>{spawnSync(p.win32.join(process.env.SystemRoot||'C:\\\\Windows','System32','taskkill.exe'),['/T','/F','/PID',String(c.pid)],{stdio:'ignore',windowsHide:true});process.exit(124)},Number(ms));",
  "c.on('error',()=>process.exit(127));c.on('exit',(code)=>{clearTimeout(t);process.exit(code==null?1:code)});",
].join("");

// Runs git on the folder cwd (git -C), started from the home folder: Windows looks for a program in the working folder
// first, so a git.exe inside the folder being initialized never runs. Never throws. ok is false when git could not
// start or exited non-zero; a time-out is error.code ETIMEDOUT.
function git(args, cwd, { env, timeout } = {}) {
  const opts = { cwd: runDir(), encoding: "utf8", env: gitEnv(env), killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024, windowsHide: true };
  const argv = ["-C", cwd, ...args];
  if (timeout && process.platform === "win32") {
    const r = spawnSync(process.execPath, ["-e", TREE_SUPERVISOR, String(timeout), ...argv], { ...opts, timeout: timeout + 30000 });
    const error = r.status === 124 ? Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" }) : r.error;
    return { ok: !error && r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim(), error };
  }
  const r = spawnSync("git", argv, { ...opts, timeout });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim(), error: r.error };
}

const errText = (r) => r.err || r.error?.message;

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

/** [major, minor] of `git version x.y.z`, or null. */
function gitVersion(text) {
  const m = /(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Whether root or a folder above it is already a work tree: a failure (3), { parent } with --nested, or {}.
function existingRepo(root, nested) {
  const dotgit = join(root, ".git");
  if (lstatSync(dotgit, { throwIfNoEntry: false })) return fail(3, `이미 저장소: ${dotgit} 이 있음. git-init 은 저장소가 없는 폴더에서만 실행`);
  const r = git(["rev-parse", "--show-toplevel"], root, { env: { LC_ALL: "C", LANGUAGE: "C" } });
  if (!r.ok) return /not a git repository/i.test(r.err) ? {} : fail(3, `저장소 여부를 확인하지 못함: ${r.err || r.error?.message}`);
  const top = r.out.trim();
  if (real(top) === real(root)) return fail(3, `이미 저장소 안: ${top}`);
  if (!nested) return fail(3, `상위 폴더가 저장소: ${top}. 그 안에 따로 저장소를 만들려면 --nested`);
  return { parent: top };
}

// git runs and no GIT_DIR, GIT_WORK_TREE redirects it: { version } or a failure (3).
function gitReady() {
  const v = git(["--version"], tmpdir());
  if (!v.ok) return fail(3, `git 을 실행하지 못함: ${v.error?.code ?? v.err}. git 을 설치한 뒤 다시 실행`);
  for (const k of ["GIT_DIR", "GIT_WORK_TREE"]) if (process.env[k]) return fail(3, `${k} 환경 변수가 있어 거부. 그 변수를 지운 셸에서 다시 실행`);
  return { version: gitVersion(v.out) };
}

// A failure (2) when --branch is given and git does not take it as a branch name, else null.
function branchProblem(branch) {
  if (branch === null) return null;
  const b = git(["check-ref-format", "--branch", branch], tmpdir());
  return !b.ok || b.out.trim() !== branch ? fail(2, `브랜치 이름으로 쓸 수 없음: ${branch}`) : null;
}

// Everything checked before any temp folder or file is made: { root, version, parent } or a failure.
function preflight(o) {
  const g = gitReady();
  if (g.error) return g;
  const at = checkRoot(o.root);
  if (at.error) return at;
  const bad = branchProblem(o.branch);
  if (bad) return bad;
  const repo = existingRepo(at.root, o.nested);
  if (repo.error) return repo;
  return { root: at.root, version: g.version, parent: repo.parent ?? null };
}

function identityProblem(tmp, o) {
  if (o.identity !== null) return null;
  const missing = ["user.name", "user.email"].filter((k) => !git(["config", "--get", k], tmp).out.trim());
  if (missing.length === 0) return null;
  return fail(3, `커밋 신원 없음(${missing.join(", ")} 미설정). 이 저장소에만 두려면 --local-identity "<이름> <<메일>>". 모든 저장소에 두려면 사용자가 git config --global user.name "<이름>" 과 git config --global user.email "<메일>" 실행(git-init 은 실행하지 않음)`);
}

/** The PATTERNS not already a line of text outside git-init's own block. */
export function missingPatterns(text) {
  const lines = text.replace(/^\u{FEFF}/u, "").split(/(?<=\n)/);
  const found = findBlock(lines, markers(HASH, ID));
  const outside = found && !found.error ? [...lines.slice(0, found.first), ...lines.slice(found.last + 1)] : lines;
  const have = new Set(outside.map((l) => l.replace(/\r?\n$/, "").trimEnd()));
  return PATTERNS.filter((p) => !have.has(p));
}

// The .gitignore plan: { plan, missing } or { refuse }. A first plan with no body only reads the file.
function gitignorePlan(root, follow) {
  const path = join(root, ".gitignore");
  const opts = { comment: HASH, id: ID, skill: SKILL, followSymlink: follow };
  const probe = planBlock(path, { ...opts, body: null, readOnly: true }); // read only: never written
  if (!probe.ok) return { refuse: probe };
  const missing = missingPatterns(probe.before === null ? "" : probe.before.toString("utf8"));
  const plan = planBlock(path, { ...opts, body: missing.length > 0 ? [BLOCK_HEAD, ...missing].join("\n") : null });
  return plan.ok ? { plan, missing, existed: probe.before !== null } : { refuse: plan };
}

// The untracked, not ignored paths under root as git sees them through the temp repository; excludes go into
// its info/exclude. A nested repository shows as one entry ending in "/".
function listCandidates(tmp, root, excludes) {
  mkdirSync(join(tmp, ".git", "info"), { recursive: true });
  writeFileSync(join(tmp, ".git", "info", "exclude"), excludes.map((p) => `${p}\n`).join(""));
  const r = git(["--git-dir", join(tmp, ".git"), "--work-tree", root, "ls-files", "-o", "--exclude-standard", "-z"], root);
  if (!r.ok) throw new Error(`추적 후보 목록을 구하지 못함: ${r.err || r.error?.message}`);
  return r.out.split("\0").filter(Boolean).sort();
}

/** Whether the path (forward slashes, relative to the root) names a key or credential file. */
export function nameHit(rel) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => /^\.(?:aws|ssh)$/i.test(d))) return true;
  if (/^\.env\.example$/i.test(base)) return false;
  return NAME_RULES.some((re) => re.test(base));
}

// One file: { hits } for a text file of 2MB or less, otherwise why its content was not read.
function inspectFile(root, rel) {
  const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
  if (!st?.isFile()) return {};
  const large = st.size > WARN_BYTES;
  if (st.size > SCAN_MAX) return { unscanned: true, large };
  const bytes = readFileSync(join(root, rel));
  if (bytes.subarray(0, 8192).includes(0)) return { binary: true };
  return { hits: scan(bytes.toString("utf8")).hits };
}

/** Scans the listed files: name hits, content hits (file:line:kind), accepted ones, unscanned, binary and large files. */
function scanFiles(root, list, accept) {
  const r = { names: [], hits: [], accepted: [], unscanned: [], large: [], binaries: [] };
  const wanted = new Set(accept);
  for (const rel of list.filter((p) => !p.endsWith("/"))) {
    if (nameHit(rel)) r.names.push(rel);
    const f = inspectFile(root, rel);
    if (f.large) r.large.push(rel);
    if (f.unscanned) r.unscanned.push(rel);
    if (f.binary) r.binaries.push(rel);
    for (const h of f.hits ?? []) {
      const where = `${rel}:${h.line}:${h.kind}`;
      (wanted.has(where) ? r.accepted : r.hits).push(where);
    }
  }
  r.unmatched = accept.filter((a) => !r.accepted.includes(a));
  return r;
}

const blocked = (s) => s.names.length > 0 || s.hits.length > 0;

function baseReport(o, pre, branch, gi) {
  return {
    ok: true, command: o.cmd, root: pre.root, branch, parent: pre.parent,
    gitignore: { path: join(pre.root, ".gitignore"), status: gi.plan.changed ? (gi.existed ? "update" : "create") : "unchanged", added: gi.missing },
  };
}

function withScan(report, list, s) {
  return { ...report, ok: !blocked(s), candidates: list.filter((p) => !p.endsWith("/")).length, nameHits: s.names, hits: s.hits, accepted: s.accepted, unmatchedAccepts: s.unmatched, unscanned: s.unscanned, large: s.large, binary: s.binaries.length, binaries: s.binaries };
}

function check(o, ctx) {
  const list = [...ctx.planned];
  if (!ctx.gi.existed && ctx.gi.plan.changed && !list.includes(".gitignore")) list.push(".gitignore");
  const report = withScan(ctx.report, list, scanFiles(ctx.root, list, o.accept));
  return report.ok ? { code: 0, report } : fail(1, "걸림이 있어 run 하면 git init 하지 않고 멈춤", report);
}

function initRepo(root, branch, version, identity) {
  const modern = version && (version[0] > 2 || (version[0] === 2 && version[1] >= 28));
  const steps = [modern ? ["init", "-q", "-b", branch] : ["init", "-q"]];
  if (!modern) steps.push(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  const who = identity === null ? null : parseIdentity(identity);
  if (who) steps.push(["config", "--local", "user.name", who.name], ["config", "--local", "user.email", who.email]);
  for (const args of steps) {
    const r = git(args, root);
    if (!r.ok) return `git ${args[0]} 실패: ${errText(r)}`;
  }
  return null;
}

// git add . and the staged names compared with the scanned list: null when they match, else why not.
function stage(root, list) {
  const add = git(["add", "."], root);
  if (!add.ok) return `git add 실패: ${errText(add)}`;
  const d = git(["diff", "--cached", "--name-only", "--no-renames", "-z"], root);
  if (!d.ok) return `git diff --cached 실패: ${errText(d)}`;
  const staged = d.out.split("\0").filter(Boolean);
  const onlyStaged = staged.filter((p) => !list.includes(p));
  const onlyList = list.filter((p) => !staged.includes(p));
  if (onlyStaged.length === 0 && onlyList.length === 0) return null;
  return `스테이지된 파일이 스캔한 목록과 다름(스테이지에만: ${onlyStaged.slice(0, 20).join(", ") || "없음"} / 목록에만: ${onlyList.slice(0, 20).join(", ") || "없음"}). 커밋하지 않음`;
}

function commitInit(root) {
  const c = git(["commit", "-q", "-m", "init"], root, { timeout: COMMIT_TIMEOUT_MS });
  if (c.error?.code === "ETIMEDOUT") return { error: `git commit 이 ${COMMIT_TIMEOUT_MS / 1000}초 안에 끝나지 않아 멈춤(커밋 훅 확인)` };
  if (!c.ok) return { error: `git commit 실패: ${c.err || c.error?.message}` };
  const head = git(["rev-parse", "HEAD"], root).out.trim();
  const tracked = git(["ls-files", "-z"], root).out.split("\0").filter(Boolean).length;
  return { head, tracked };
}

function runSteps(o, ctx) {
  const done = commitBlock(ctx.gi.plan, SKILL);
  if (!done.ok) return fail(1, `.gitignore 거부: ${done.message}. git init 하지 않음`, { ...ctx.report, ok: false });
  const report = { ...ctx.report, gitignore: { ...ctx.report.gitignore, status: done.changed ? (done.created ? "created" : "updated") : "unchanged", backup: done.backup ?? null } };
  const list = listCandidates(ctx.tmp, ctx.root, []);
  const nested = list.filter((p) => p.endsWith("/"));
  if (nested.length > 0) return fail(1, `하위 폴더에 .git 이 있음(넣으면 gitlink 가 됨): ${nested.join(", ")}. git init 하지 않음`, { ...report, ok: false });
  const scanned = withScan(report, list, scanFiles(ctx.root, list, o.accept));
  if (!scanned.ok) return fail(1, "걸림이 있어 git init 하지 않음. .gitignore 변경은 남김", scanned);
  const why = initRepo(ctx.root, ctx.branch, ctx.version, o.identity) ?? stage(ctx.root, list);
  if (why) return fail(1, `${why}. ${join(ctx.root, ".git")} 은 남아 있음`, { ...scanned, ok: false });
  const c = commitInit(ctx.root);
  if (c.error) return fail(1, `${c.error}. ${join(ctx.root, ".git")} 은 남아 있음`, { ...scanned, ok: false });
  return { code: 0, report: { ...scanned, commit: c.head, tracked: c.tracked } };
}

// Work that needs the temp repository; the caller removes it.
function withTemp(o, pre, tmp) {
  const made = git(["init", "-q", tmp], tmpdir());
  if (!made.ok) throw new Error(`임시 저장소를 만들지 못함: ${errText(made)}`);
  if (real(tmp).startsWith(real(pre.root) + sep)) return fail(3, `임시 폴더가 루트 안에 있음: ${tmp}. TMPDIR 을 루트 밖으로 바꿔 다시 실행`);
  const who = identityProblem(tmp, o);
  if (who) return who;
  const gi = gitignorePlan(pre.root, o.follow);
  if (gi.refuse) return fail(1, `.gitignore 거부: ${gi.refuse.message}. 아무것도 바꾸지 않음`);
  const planned = listCandidates(tmp, pre.root, gi.missing);
  const nested = planned.filter((p) => p.endsWith("/"));
  if (nested.length > 0) return fail(3, `하위 폴더에 .git 이 있음(넣으면 gitlink 가 됨): ${nested.join(", ")}. 아무것도 바꾸지 않음`);
  const branch = o.branch ?? (git(["config", "--get", "init.defaultBranch"], tmp).out.trim() || "main");
  const ctx = { root: pre.root, version: pre.version, tmp, gi, planned, branch, report: baseReport(o, pre, branch, gi) };
  return o.cmd === "check" ? check(o, ctx) : runSteps(o, ctx);
}

function execute(o) {
  const pre = preflight(o);
  if (pre.error) return pre;
  const tmp = mkdtempSync(join(tmpdir(), "banker-git-init-"));
  try {
    return withTemp(o, pre, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const GITIGNORE_WORDS = { create: "새로 씀(예정)", update: "끝에 표지 블록(예정)", created: "새로 씀", updated: "끝에 표지 블록 씀", unchanged: "변경 없음" };

const listLine = (label, items) => (items.length > 0 ? [`- ${label}: ${items.join(", ")}`] : []);

function scanLines(rep) {
  return [
    `- 추적 후보: ${rep.candidates}개`,
    ...listLine("이름 걸림(--accept 로 넘길 수 없음, .gitignore 에 넣거나 옮김)", rep.nameHits),
    ...listLine("내용 걸림(파일:줄:종류)", rep.hits),
    ...listLine("확인으로 넘긴 항목", rep.accepted),
    ...listLine("맞는 걸림이 없어 쓰이지 않은 --accept", rep.unmatchedAccepts),
    ...listLine("내용 미스캔(2MB 초과)", rep.unscanned),
    ...listLine("내용 미스캔(바이너리)", rep.binaries),
    ...listLine("경고: 100MB 초과(원격 저장소가 거부할 수 있음)", rep.large),
  ];
}

function resultLines(rep, code) {
  if (rep.commit) {
    return [`- 커밋: ${rep.commit} init`, `- 추적 파일: ${rep.tracked}개`, "", `준비 완료: git worktree add <경로> -b <새 브랜치> 로 병렬 작업을 시작할 수 있음`, "이후 런타임 잡음 정리는 refresh-git-ignore"];
  }
  if (rep.command === "check") return ["", code === 0 ? "결과: 걸림 없음. run 으로 진행 가능" : "결과: 걸림이 있어 run 하면 멈춤"];
  return [];
}

function textLines(rep, code) {
  const gi = rep.gitignore;
  return [
    `git-init ${rep.command}${rep.command === "check" ? " (계획만, 바꾸지 않음)" : ""}: ${rep.root}`,
    ...(rep.parent ? [`- 상위 저장소 안에 따로 만듦(--nested): ${rep.parent}`] : []),
    `- 브랜치: ${rep.branch}`,
    `- .gitignore: ${GITIGNORE_WORDS[gi.status]}${gi.added.length > 0 && gi.status !== "unchanged" ? `, 패턴 ${gi.added.length}개: ${gi.added.join(" ")}` : ""}${gi.backup ? `, 첫 원본 ${gi.backup}` : ""}`,
    ...(rep.candidates === undefined ? [] : scanLines(rep)),
    ...resultLines(rep, code),
  ];
}

// The options checked, or { error } for a usage error.
function options(argv) {
  const o = parseArgs(argv);
  if (o.error || o.help) return o;
  const bad = validate(o);
  return bad ? { ...o, error: bad } : o;
}

/** Runs git-init with argv; returns { code, stdout, stderr } and writes nothing to the console. */
export function run(argv) {
  const o = options(argv);
  if (o.help) return { code: 0, stdout: USAGE, stderr: "" };
  if (o.error) return finish(o, fail(2, `${o.error}\n${USAGE}`));
  try {
    return finish(o, execute(o));
  } catch (e) {
    return finish(o, fail(1, `실패: ${e.message}`));
  }
}

function finish(o, r) {
  const stderr = r.error ? `git-init: ${r.error}` : "";
  if (o.json) {
    const body = r.report ? { ...r.report, ok: r.code === 0 } : { ok: false, command: o.cmd };
    return { code: r.code, stdout: JSON.stringify({ ...body, exit: r.code, ...(r.error ? { error: r.error.split("\n")[0] } : {}) }), stderr };
  }
  return { code: r.code, stdout: r.report ? textLines(r.report, r.code).join("\n") : "", stderr };
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(`${r.stdout}\n`);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exitCode = r.code;
}
