#!/usr/bin/env node
/**
 * run-folder: the private run folders of ralph-qa and ultraqa, and the work tree snapshot their gate evidence is judged
 * against. The source of truth is skills/ralph-qa/references/run-folder.mjs; skills/ultraqa/references holds a
 * byte-identical copy (scripts/sync-adapter.js).
 *
 *   bases(ctx)                        { base, known }: this run's base, and every base a run of any version used
 *   sharedAbove(p)                    the nearest folder above p every account may write in, or null (POSIX)
 *   readyBase(ctx, base)              makes the base, private (POSIX), or stops
 *   makeRunFolder(ctx, kind)          <base>/<kind>.<six letters and digits>, private, with its marker .<kind>
 *   runFolder(dir, ctx, kinds)        { d, kind } for such a folder right under a known private base, else a stop
 *   removeMarked(p, marker)           the folder's contents, then its marker, then the folder
 *   removeRunFolder(dir, ctx, kinds)  one run folder, checked as runFolder checks it; nothing outside it
 *   snapshot(repo, env)               (async) HEAD, the status, the untracked files' content hashes, one fingerprint
 *   requireGitTree(repo, env, flag)   the work tree's root, or the stop not-a-git-tree naming the folder it checked
 *   spawnFiles(exe, args, opts)       spawnSync with files, not pipes, for the child's input and output
 *   hashFile(createHash, p)           a file's sha256 read in pieces (a file past 2 GiB is no Buffer)
 *
 * ctx is { env, platform }. A base is never /tmp: another account may put files there (gemini, a ralph-qa seat, reads
 * a .env it finds walking up from its folder). No shell and no network: git runs as a program with its arguments.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// A stop: `code` names it, the message is a Korean line (the caller puts its name before it), `detail` the paths or
// lines it concerns.
export class Stop extends Error {
  constructor(code, message, detail = []) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const lstatOr = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const isFile = (p) => Boolean(lstatOr(p)?.isFile());
const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const homeOf = (ctx) => (ctx.platform === "win32" ? ctx.env.USERPROFILE : ctx.env.HOME) || homedir();
const norm = (ctx, p) => (ctx.platform === "win32" ? p.toLowerCase() : p);
const realOr = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

// A folder only this account may write in (POSIX: its own, no group or other write bit).
export function privateDir(p) {
  try {
    const st = statSync(p);
    return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}
const insideHome = (ctx, p) => norm(ctx, realOr(p)).startsWith(norm(ctx, realOr(homeOf(ctx))) + sep);

// The base for this run's folders, and every base a run of any version may have used, for the day rule. Linux: an
// XDG_RUNTIME_DIR, macOS: a $TMPDIR (its own per account by default), of this account's own and not below a shared
// folder (/tmp) the home is not below, else ~/.cache; Windows: %TEMP% when it is inside the home, else ~/.cache (the
// old Git Bash runs used ~/.cache).
const OWN_TEMP = { linux: "XDG_RUNTIME_DIR", darwin: "TMPDIR" };
export function bases(ctx) {
  const cache = join(homeOf(ctx), ".cache");
  const base = baseOn(ctx, cache);
  const own = ctx.env[OWN_TEMP[ctx.platform]];
  return { base, known: [...new Set([base, cache, ...(own ? [resolve(own)] : [])])] };
}

function baseOn(ctx, cache) {
  const { env } = ctx;
  if (ctx.platform === "win32") return env.TEMP && insideHome(ctx, env.TEMP) ? resolve(env.TEMP) : cache;
  const own = env[OWN_TEMP[ctx.platform]];
  return own && isAbsolute(own) && privateDir(own) && !belowSharedAlone(ctx, own) ? resolve(own) : cache;
}

const belowSharedAlone = (ctx, p) => Boolean(sharedAbove(p)) && !sharedAbove(homeOf(ctx));

// The nearest folder above p, by its real path, that every account may write in (/tmp, /var/tmp, /dev/shm), or null.
// A private folder there is still a folder whose parents another account fills: gemini reads the .env it finds
// walking up to the root. An XDG_RUNTIME_DIR or $TMPDIR below one is refused unless the home is below one too (a test
// box's account under /tmp): then ~/.cache is no better. POSIX only.
export function sharedAbove(p) {
  for (let d = dirname(realOr(resolve(p))); ; d = dirname(d)) {
    try {
      if ((statSync(d).mode & 0o002) !== 0) return d;
    } catch {
      /* not there or not readable: the next one up */
    }
    if (dirname(d) === d) return null;
  }
}

export function readyBase(ctx, base) {
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Stop("base-not-writable", `기준 폴더를 만들 수 없다(${e.code}): ${base}`);
  }
  if (ctx.platform !== "win32" && !privateDir(base)) throw new Stop("base-not-private", `기준 폴더를 다른 계정도 쓸 수 있다: ${base}`);
}

// One folder by mkdtemp under the base, with its marker.
export function makeRunFolder(ctx, kind) {
  const { base } = bases(ctx);
  readyBase(ctx, base);
  let d;
  try {
    d = mkdtempSync(join(base, `${kind}.`));
    writeFileSync(join(d, `.${kind}`), "", { mode: 0o600 });
  } catch (e) {
    if (d) rmSync(d, { recursive: true, force: true });
    throw new Stop("base-not-writable", `기준 폴더에 쓸 수 없다(${e.code}): ${base}`);
  }
  return { dir: d, base };
}

// The folder's parent, by its real path, is one of the known bases by theirs (macOS's /var is a link to /private/var:
// either form names the same base), and only this account may write in it (POSIX).
export function underBase(ctx, d) {
  const parent = norm(ctx, realOr(dirname(d)));
  const known = bases(ctx).known.some((b) => norm(ctx, realOr(b)) === parent);
  return known && (ctx.platform === "win32" || privateDir(dirname(d)));
}

const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A folder made as makeRunFolder makes one, of one of `kinds`: named <kind>.<letters and digits>, a folder and no link,
// with its marker, right under a known base that only this account may write in.
export function runFolder(dir, ctx, kinds) {
  const d = resolve(String(dir));
  const kind = kinds.find((k) => new RegExp(`^${escaped(k)}\\.[A-Za-z0-9]+$`).test(basename(d)));
  if (!kind || !lstatOr(d)?.isDirectory() || !isFile(join(d, `.${kind}`))) {
    throw new Stop("not-a-run-folder", `init 이 만든 폴더가 아니다: ${d}`);
  }
  if (!underBase(ctx, d)) throw new Stop("not-a-run-folder", `알려진 기준 폴더 바로 아래의 실행 폴더가 아니다: ${d}`);
  return { d, kind };
}

// A marked folder removed, its marker last: a removal that stops part way leaves a folder the next cleanup still knows.
// One that cannot be removed gets back its marker (if the removal reached it) and its times, so it stays a marked folder.
export function removeMarked(p, marker) {
  const was = lstatOr(p);
  try {
    for (const name of listDir(p).filter((n) => n !== marker)) rmSync(join(p, name), { recursive: true, force: true, maxRetries: 3 });
    rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    keepMarked(p, marker, was);
    throw e;
  }
}

function keepMarked(p, marker, was) {
  try {
    if (!lstatOr(p)?.isDirectory()) return;
    if (!isFile(join(p, marker))) writeFileSync(join(p, marker), "", { flag: "wx", mode: 0o600 });
    if (was) utimesSync(p, was.atime, was.mtime);
  } catch {
    /* the folder takes no marker or times either */
  }
}

// One run folder and nothing else: a path a record names outside it is the caller's to report, never to remove.
export function removeRunFolder(dir, ctx, kinds) {
  const { d, kind } = runFolder(dir, ctx, kinds);
  try {
    removeMarked(d, `.${kind}`);
  } catch (e) {
    throw new Stop("cleanup-left", "실행 폴더를 다 지우지 못했다. 사용자에게 경로를 알린다", [`${d} (${e.code || e.message})`]);
  }
  return { removed: d };
}

// ---- a program with files for its input and output

// spawnSync with the child's stdin, stdout and stderr on files in a private temporary folder, read back into
// r.stdout and r.stderr (Buffers) and removed. Node's own pipes are AF_UNIX socket pairs, and the Codex Linux sandbox
// refuses their setsockopt: a pipe child's output can be lost and spawnSync reports EPERM though the program ran.
// A file descriptor works there. Without a temporary folder it falls back to the pipes. With `digest` (a function
// of the stdout file's path, or of the Buffer on the pipe fallback) r.stdout is what it gives, and the output, which
// may pass 2 GiB, is never read whole.
export function spawnFiles(exe, args, { input, digest, ...opts } = {}) {
  let t;
  try {
    t = mkdtempSync(join(tmpdir(), "rq-io-"));
  } catch {
    const r = spawnSync(exe, args, { ...opts, input });
    return digest && r.stdout ? { ...r, stdout: digest(r.stdout) } : r;
  }
  const fds = [];
  const open = (name, flags) => (fds.push(openSync(join(t, name), flags, 0o600)), fds[fds.length - 1]);
  try {
    if (input !== undefined) writeFileSync(join(t, "in"), input, { mode: 0o600 });
    const stdio = [input === undefined ? "ignore" : open("in", "r"), open("out", "wx"), open("err", "wx")];
    const r = spawnSync(exe, args, { ...opts, stdio });
    return { ...r, stdout: (digest || readFileSync)(join(t, "out")), stderr: readFileSync(join(t, "err")) };
  } finally {
    for (const fd of fds) closeSync(fd);
    rmSync(t, { recursive: true, force: true });
  }
}

// A file's sha256 in pieces of 1 MiB: readFileSync stops at 2 GiB (ERR_FS_FILE_TOO_LARGE). `createHash` comes from
// the caller (this module loads node:crypto only inside snapshot).
export function hashFile(createHash, p) {
  const h = createHash("sha256");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

// ---- the work tree snapshot

// git as a program, from the home folder (Windows looks in the working folder first for a bare name; a home that is
// not there, as in a test's env, gives the temporary folder), with no fsmonitor program and no external diff or text
// conversion.
function git(repo, env, args, digest) {
  const cwd = existsSync(homedir()) ? homedir() : tmpdir();
  const r = spawnFiles("git", ["-c", "core.fsmonitor=false", "-C", repo, ...args], { cwd, env, maxBuffer: 1 << 30, windowsHide: true, digest });
  return { ok: r.status === 0, out: r.stdout || Buffer.alloc(0), err: String(r.stderr || r.error?.code || "") };
}

// The untracked entries of `git status --porcelain=v1 -z` (a rename or copy entry carries its old name next).
function untrackedOf(raw) {
  const parts = String(raw).split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const e = parts[i];
    if (e.startsWith("?? ")) out.push(e.slice(3));
    else if (/^[RC]/.test(e)) i += 1;
  }
  return out.sort();
}

// A gate's evidence needs a git work tree: in a folder without one the fingerprint sees no change, so no record of
// it could ever hold (the conjunct's `unverifiable`). Stopped before anything runs, with the absolute folder it checked
// (`checked`, also in detail) and what to do: a call from outside the repo without `flag` checked the wrong folder.
export function requireGitTree(repo, env = process.env, flag = "--cwd") {
  const checked = resolve(repo);
  const top = git(checked, env, ["rev-parse", "--show-toplevel"]);
  if (top.ok) return String(top.out).trim();
  const e = new Stop("not-a-git-tree", `git 저장소가 아니다(검사한 폴더: ${checked}). 이 폴더가 대상 저장소가 아니면 검사할 저장소를 ${flag} 로 주십시오. 대상 저장소가 맞으면 작업 트리 지문이 변경을 보지 못해 게이트 증거를 만들 수 없다: 사용자가 git init 과 첫 커밋을 하거나, 게이트 없이 돈다`, [checked]);
  e.checked = checked;
  throw e;
}

// An untracked entry's content hash: a link's target, a file's bytes (in pieces), or what it is when it is neither.
function contentHash(root, rel, hash, createHash) {
  const p = join(root, rel);
  const st = lstatOr(p);
  if (st?.isSymbolicLink()) return hash(Buffer.from(`link\0${readlinkSync(p)}`));
  if (st?.isFile()) return hashFile(createHash, p);
  return hash(Buffer.from(st ? "other" : "gone"));
}

// What a gate's result was judged on: HEAD, the status, the diff against HEAD (the index and the work tree) and every
// untracked file's content, hashed together; the diffs and the files are hashed in pieces, never read whole. A tree
// with no git has one fingerprint per folder: changes go unseen (`git: false`, which the gate conjunct does not take).
// Files git ignores are outside it: a build or a test run makes them anew every time.
export async function snapshot(repo, env = process.env) {
  const { createHash } = await import("node:crypto");
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  const digest = (src) => (Buffer.isBuffer(src) ? hash(src) : hashFile(createHash, src));
  const top = git(resolve(repo), env, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { git: false, head: null, untracked: [], fingerprint: hash(`no-git\0${resolve(repo)}`) };
  const root = String(top.out).trim();
  const head = git(root, env, ["rev-parse", "--verify", "-q", "HEAD"]);
  const status = git(root, env, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const diffArgs = ["--binary", "--no-ext-diff", "--no-textconv"];
  const diffs = (head.ok ? [["diff", "HEAD"]] : [["diff", "--cached"], ["diff"]]).map((a) => git(root, env, [...a, ...diffArgs], digest));
  const failed = [status, ...diffs].find((r) => !r.ok);
  if (failed) throw new Stop("git-failed", `작업 트리를 읽지 못했다: ${failed.err.split("\n")[0]}`);
  const untracked = untrackedOf(status.out).map((path) => ({ path, sha256: contentHash(root, path, hash, createHash) }));
  const headId = head.ok ? String(head.out).trim() : null;
  const parts = [`head\0${headId}`, `status\0${hash(status.out)}`, ...diffs.map((r) => `diff\0${r.out}`), ...untracked.map((u) => `new\0${u.path}\0${u.sha256}`)];
  return { git: true, root, head: headId, untracked, fingerprint: hash(parts.join("\n")) };
}
