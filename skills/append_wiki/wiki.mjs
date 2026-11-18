#!/usr/bin/env node
/*
 * banker wiki fallback: OMC 5.8.4's seven wiki tools (wiki_ingest, wiki_add, wiki_query, wiki_list, wiki_read,
 * wiki_delete, wiki_lint) without OMC, for a session whose OMC MCP server does not load. Zero deps, node >= 16.7.
 *
 * It writes the same .omc/wiki an OMC session writes, so the two can share it, even at the same time:
 *  - the folder OMC picks (src/lib/worktree-paths.ts: the session's git toplevel, OMC_STATE_DIR/<projectId>,
 *    a .omc-workspace marker, the outermost superproject, $HOME/.omc for a folder outside git), and the same refusals
 *    of a workingDirectory in another repository;
 *  - the page format, slugs, append-on-same-title merge, index.md and log.md (src/hooks/wiki/storage.ts, ingest.ts);
 *  - OMC's lock (<wiki>/.wiki-lock.lock, O_EXCL, {"pid","timestamp"}, 5 s wait at 50 ms, a lock over 30 s old whose
 *    pid is dead is reaped) and its atomic write (.<name>.tmp.<uuid>, mode 0600, fsync, rename, folder fsync);
 *  - the response text of src/tools/wiki-tools.ts, byte for byte, so a reader of OMC's answers reads these too.
 * Input limits are the tools' declared zod schema (title <= 200, content <= 50,000, tags <= 20 of <= 50, ...).
 * It differs from OMC on purpose in three places, each a stop with an error and no file changed:
 *  - a page in the wiki has schemaVersion > 1 (a newer OMC format): ingest, add and delete do not write;
 *  - the page a title maps to exists but does not parse: OMC overwrites it (its body is lost), this does not;
 *  - wiki_delete of index.md, log.md or environment.md: OMC deletes it, this refuses.
 * After an ingest or add, when <wiki>/.obsidizer exists, each changed page goes through skills/obsidizer/obsidize.mjs
 * as hooks/obsidize-hook.mjs runs it (the hook watches MCP tool calls and so never sees this script).
 *
 * Usage: node wiki.mjs <tool> [--input '<json>' | --input-file <path>] [--json] [--profile=omc]
 *   <tool>   wiki_ingest | wiki_add | wiki_query | wiki_list | wiki_read | wiki_delete | wiki_lint (or without wiki_)
 *   --json   print the result as OMX's `omx wiki ... --json` does ({"created":[..],...}; {"error":".."} on an error)
 *   exit     0 done, 1 the tool reported an error (the text says why), 2 a usage error
 * --profile=omx (Codex's omx_wiki/) is not built yet.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESERVED = new Set(['index.md', 'log.md', 'environment.md']);
const CATEGORIES = ['architecture', 'decision', 'pattern', 'debugging', 'environment', 'session-log', 'reference', 'convention'];
const CONFIDENCES = ['high', 'medium', 'low'];
const SCHEMA_VERSION = 1;
const WORKSPACE_MARKER = '.omc-workspace';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const STALE_LOCK_MS = 30000;
const STALE_DAYS = 30;
const MAX_PAGE_SIZE = 10240;
const DAY_MS = 24 * 60 * 60 * 1000;
const OBSIDIZE_TIMEOUT_MS = 4000;
// The canonicalizer beside this skill: Claude Code plugin and npm package (skills/), the Codex npm copy
// (~/.codex/skills/banker-<name>/), the Codex plugin's renamed copy (codex/renamed-skills/append_wiki/).
const CANONICALIZERS = [
  path.join(HERE, '..', 'obsidizer', 'obsidize.mjs'),
  path.join(HERE, '..', 'banker-obsidizer', 'obsidize.mjs'),
  path.join(HERE, '..', '..', '..', 'skills', 'obsidizer', 'obsidize.mjs'),
];

// ============================================================================
// git probes (src/lib/worktree-paths.ts)
// ============================================================================

// The folder goes to git as -C, and git itself starts in the home folder: on Windows a bare "git" is looked up in
// the current folder first, so starting it in the project would let a git.exe there run (as in banker 0.16.2).
// git -C <dir> behaves as if started in <dir>, so the answers are the same as OMC's cwd: <dir>.
function git(args, cwd, english = false) {
  return execFileSync('git', ['-C', path.resolve(cwd), ...args], {
    cwd: os.homedir(),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 5000,
    ...(english ? { env: { ...process.env, LC_ALL: 'C' } } : {}),
  });
}

function gitErrorStderr(err) {
  if (Buffer.isBuffer(err.stderr)) return err.stderr.toString('utf8');
  if (typeof err.stderr === 'string') return err.stderr;
  return typeof err.message === 'string' ? err.message : '';
}

function isGitCommandPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  return ['git', 'git.exe', 'git.cmd', 'git.bat'].includes(path.basename(p));
}

function hasSignal(err) {
  return typeof err.signal === 'string' && err.signal.length > 0;
}

function isSpawnOfGit(err) {
  const syscall = typeof err.syscall === 'string' ? err.syscall.toLowerCase() : '';
  if (!syscall.includes('spawn')) return false;
  return syscall.includes('git') || isGitCommandPath(err.path);
}

// The git executable is not there (spawn ENOENT), as opposed to git failing.
function isGitMissing(err) {
  if (!err || typeof err !== 'object' || err.code !== 'ENOENT') return false;
  if (err.killed === true || typeof err.status === 'number' || hasSignal(err)) return false;
  return isSpawnOfGit(err);
}

function isNotARepository(err) {
  if (!err || typeof err !== 'object') return false;
  if (['ENOENT', 'ETIMEDOUT', 'EACCES'].includes(err.code) || hasSignal(err)) return false;
  return err.status === 128 && /(?:not a git repository|must be run in a work tree)/i.test(gitErrorStderr(err));
}

function realOrNull(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function expandForCompare(p) {
  const normalized = path.resolve(p);
  try {
    return fs.realpathSync.native(normalized);
  } catch {
    return realOrNull(normalized);
  }
}

function sameCanonicalPath(left, right) {
  const a = expandForCompare(left);
  const b = expandForCompare(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (process.platform !== 'win32') return false;
  const fold = (v) => v.replaceAll('/', '\\').toLowerCase();
  return fold(a) === fold(b);
}

function findGitMetadataDir(start) {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isCredibleRoot(root) {
  try {
    if (!fs.statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  const rootReal = realOrNull(root);
  const meta = rootReal && findGitMetadataDir(rootReal);
  return Boolean(meta) && sameCanonicalPath(meta, rootReal);
}

function classifyTopLevel(stdout, cwd) {
  const failed = { status: 'probe_failed' };
  const root = stdout.trim();
  if (root.length === 0 || !path.isAbsolute(root) || !isCredibleRoot(root)) return failed;
  const cwdReal = realOrNull(cwd);
  const meta = cwdReal && findGitMetadataDir(cwdReal);
  if (!meta || !sameCanonicalPath(meta, root)) return failed;
  return { status: 'ok', root: realOrNull(meta) ?? meta };
}

// `git rev-parse --show-toplevel`, judged as OMC's probeGitTopLevel judges it.
function probeTopLevel(cwd) {
  let stdout;
  try {
    stdout = git(['rev-parse', '--show-toplevel'], cwd, true);
  } catch (err) {
    if (isNotARepository(err)) return { status: 'not_a_repository' };
    return { status: isGitMissing(err) ? 'git_missing' : 'probe_failed' };
  }
  return classifyTopLevel(stdout, cwd);
}

function gitTopLevel(cwd) {
  const probe = probeTopLevel(cwd);
  return probe.status === 'ok' ? probe.root : null;
}

function isBareRepository(cwd) {
  try {
    return git(['rev-parse', '--is-bare-repository'], cwd, true).trim() === 'true';
  } catch {
    return false;
  }
}

function gitCommonDir(cwd) {
  try {
    return fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd).trim());
  } catch {
    return null;
  }
}

// ============================================================================
// The project root a tool call works on (resolveWorkingDirectoryOrLinkedWorktree)
// ============================================================================

const probeFailedMessage = (wd) => `workingDirectory '${wd}' git probe failed and was not used. `
  + 'Cross-repository access is not permitted; pass a path inside the current repository or start the session there.';
const trustedLabel = (root) => path.basename(root) || 'current repository';
const outsideMessage = (wd, trusted) => `workingDirectory '${wd}' is outside the trusted worktree root '${trustedLabel(trusted)}'.`;
const foreignMessage = (wd, trusted) => `workingDirectory '${wd}' belongs to a different repository than '${trustedLabel(trusted)}' and was not used. `
  + 'Cross-repository access is not permitted; pass a path inside the current repository or start the session there.';
const missingMessage = (wd) => `workingDirectory '${wd}' does not exist or is not accessible.`;

// The session's own root: its git toplevel, or the folder itself outside git.
function trustedRootOf(label) {
  const cwd = process.cwd();
  const probe = probeTopLevel(cwd);
  if (probe.status === 'probe_failed' || probe.status === 'git_missing') throw new Error(probeFailedMessage(label));
  if (probe.status === 'ok') return probe.root;
  const cwdReal = realOrSelf(cwd);
  if (fs.existsSync(path.join(cwdReal, '.git')) && !isBareRepository(cwdReal)) throw new Error(probeFailedMessage(label));
  return cwd;
}

// A workingDirectory inside a repository: the session's own, or a linked worktree of it.
function repositoryRoot(root, trusted, trustedReal, wd) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    throw new Error(missingMessage(wd));
  }
  if (sameCanonicalPath(rootReal, trustedReal)) return root;
  const trustedCommon = gitCommonDir(trusted);
  const providedCommon = gitCommonDir(root);
  if (trustedCommon && providedCommon && sameCanonicalPath(providedCommon, trustedCommon)) return root;
  throw new Error(foreignMessage(wd, trustedReal));
}

// A workingDirectory outside any repository: only a folder under the trusted root, which it then stands for.
function plainRoot(resolved, trusted, trustedReal, wd) {
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(missingMessage(wd));
  }
  if (fs.existsSync(path.join(real, '.git')) && !isBareRepository(real)) throw new Error(probeFailedMessage(wd));
  const meta = findGitMetadataDir(real);
  if (meta && !sameCanonicalPath(realOrSelf(meta), trustedReal)) throw new Error(probeFailedMessage(wd));
  const rel = path.relative(trustedReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(outsideMessage(wd, trusted));
  return trusted;
}

export function resolveRoot(workingDirectory) {
  const label = workingDirectory && workingDirectory.length > 0 ? workingDirectory : 'session cwd';
  const trusted = trustedRootOf(label);
  if (!workingDirectory) return trusted;
  const resolved = path.resolve(workingDirectory);
  const trustedReal = realOrSelf(trusted);
  const probe = probeTopLevel(resolved);
  if (probe.status === 'ok') return repositoryRoot(probe.root, trusted, trustedReal, workingDirectory);
  if (probe.status !== 'not_a_repository') throw new Error(probeFailedMessage(workingDirectory));
  return plainRoot(resolved, trusted, trustedReal, workingDirectory);
}

// ============================================================================
// Where .omc is (getOmcRoot)
// ============================================================================

const SENSITIVE_NAMES = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', 'ssh', '.pki',
  '.config', '.claude', '.claude.json', '.codex', '.gemini', '.cursor',
  '.vscode', '.ollama', '.docker', '.npm', '.cache', '.local',
  'desktop', 'documents', 'downloads', 'pictures', 'photos', 'music',
  'movies', 'videos', 'public', 'library',
]);
const isFsRoot = (dir) => path.dirname(dir) === dir;

function homeOrNull() {
  try {
    return path.resolve(os.homedir());
  } catch {
    return null;
  }
}

function findWorkspaceRoot(start) {
  if (process.env.OMC_DISABLE_MULTIREPO === '1') return null;
  let cursor;
  try {
    cursor = path.resolve(start || process.cwd());
  } catch {
    return null;
  }
  const home = homeOrNull();
  for (;;) {
    if (home && cursor === home) return null;
    if (fs.existsSync(path.join(cursor, WORKSPACE_MARKER))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function readMarkerConfig(workspaceRoot) {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, WORKSPACE_MARKER), 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sensitiveRoots() {
  const roots = [];
  const temp = (() => { try { return path.resolve(os.tmpdir()); } catch { return null; } })();
  if (temp) roots.push(temp);
  if (process.platform !== 'win32') return [...roots, '/var', '/usr', '/etc', '/opt', '/private/var'];
  roots.push('C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData');
  const drive = (/^[a-zA-Z]:/.exec(homeOrNull() || '') || [])[0];
  if (drive) roots.push(`${drive}\\Windows`, `${drive}\\Program Files`, `${drive}\\Program Files (x86)`, `${drive}\\ProgramData`);
  return roots;
}

function isWithinPath(ancestor, candidate) {
  const rel = path.relative(ancestor, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function underSensitiveRoot(candidate) {
  const fold = (v) => (process.platform === 'win32' ? v.toLowerCase() : v);
  return sensitiveRoots().some((root) => {
    const r = fold(realOrSelf(root));
    const c = fold(candidate);
    return c === r || isWithinPath(r, c);
  });
}

function isHome(candidate) {
  const home = homeOrNull();
  if (!home) return false;
  const real = realOrSelf(home);
  return candidate === real || (process.platform === 'win32' && candidate.toLowerCase() === real.toLowerCase());
}

function hasSensitiveAncestor(candidate) {
  for (let cursor = candidate; ; cursor = path.dirname(cursor)) {
    const name = path.basename(cursor);
    if (name.startsWith('.') && name !== '.omc') return true;
    if (SENSITIVE_NAMES.has(name.toLowerCase())) return true;
    if (isFsRoot(cursor)) return false;
  }
}

// OMC keeps no state at the home folder itself, a dot folder, a known personal folder, the temp or a system folder.
function isSensitiveLocation(dir) {
  let candidate;
  try {
    candidate = realOrSelf(path.resolve(dir));
  } catch {
    return true;
  }
  if (isHome(candidate) || hasSensitiveAncestor(candidate)) return true;
  if (candidate === '/tmp' || candidate === '/private/tmp' || isFsRoot(candidate)) return true;
  return underSensitiveRoot(candidate);
}

function safeHome() {
  const home = path.resolve(os.homedir());
  if (isFsRoot(home)) throw new Error('Cannot resolve a safe non-git OMC state root: home resolves to the filesystem root.');
  return home;
}

function nonGitAnchor(start) {
  try {
    const workspace = findWorkspaceRoot(path.resolve(start || process.cwd()));
    if (workspace && !isSensitiveLocation(workspace)) return workspace;
  } catch {
    // fall back to the home folder
  }
  return safeHome();
}

// The outermost superproject of a submodule, or null.
function superprojectRoot(cwd) {
  let anchor = null;
  let probe = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    let up;
    try {
      up = git(['rev-parse', '--show-superproject-working-tree'], probe, true).trim();
    } catch {
      break;
    }
    if (!up) break;
    anchor = up;
    probe = up;
  }
  return anchor;
}

const sha16 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const safeName = (text) => text.replace(/[^a-zA-Z0-9_-]/g, '_');

function workspaceIdentifier(workspaceRoot) {
  const cfg = readMarkerConfig(workspaceRoot);
  if (cfg.id && typeof cfg.id === 'string' && cfg.id.trim()) {
    const safeId = safeName(cfg.id.trim());
    return `${safeId}-${sha16(safeId)}`;
  }
  return `${safeName(path.basename(workspaceRoot))}-${sha16(workspaceRoot)}`;
}

// A linked worktree's main repository root, so every worktree of a repository shares one identifier.
function primaryRootOf(root) {
  try {
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root).trim();
    const isGitDir = path.basename(common) === '.git';
    const isSubmodule = common.includes(`${path.sep}.git${path.sep}modules`);
    const up = path.dirname(common);
    if (isGitDir && !isSubmodule && up && up !== root) return up;
  } catch {
    // not a repository: the root itself
  }
  return root;
}

function projectIdentifier(root) {
  const workspace = findWorkspaceRoot(root);
  if (workspace) return workspaceIdentifier(workspace);
  let remote = '';
  try {
    remote = git(['remote', 'get-url', 'origin'], root).trim();
  } catch {
    // no origin: the repository path names it
  }
  const primary = primaryRootOf(root);
  return `${safeName(path.basename(primary))}-${sha16(remote || primary)}`;
}

export function omcRootOf(root) {
  const stateDir = process.env.OMC_STATE_DIR;
  if (stateDir) {
    const id = !gitTopLevel(root) && !findWorkspaceRoot(root) ? 'non-git' : projectIdentifier(root);
    return path.join(stateDir, id);
  }
  const anchor = findWorkspaceRoot(root);
  if (anchor && !isSensitiveLocation(anchor)) return path.join(anchor, '.omc');
  const stateRoot = superprojectRoot(root) || root;
  if (!gitTopLevel(stateRoot)) return path.join(nonGitAnchor(stateRoot), '.omc');
  return path.join(stateRoot, '.omc');
}

/** The wiki folder a call with this workingDirectory (undefined: the session's) reads and writes. */
export function resolveWikiDir(workingDirectory) {
  return path.join(omcRootOf(resolveRoot(workingDirectory)), 'wiki');
}

// ============================================================================
// Atomic write (src/lib/atomic-write.ts) and the wiki lock (src/lib/file-lock.ts)
// ============================================================================

function writeAll(fd, content) {
  const bytes = Buffer.from(content, 'utf-8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error('atomic write made no progress');
    offset += written;
  }
  if (fs.fstatSync(fd).size !== bytes.length) throw new Error('atomic write size verification failed');
}

function sameIdentity(a, b) {
  if (a.ino !== b.ino) return false;
  if (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)) return true;
  return a.dev === b.dev;
}

function isPrivateSingleLink(st) {
  if (process.platform === 'win32') return st.isFile() && Number(st.nlink) <= 1;
  return st.isFile() && Number(st.nlink) === 1 && (Number(st.mode) & 0o777) === 0o600;
}

// The temporary file is the one opened (not swapped for a link or another file) before it is published.
function checkTemp(fd, tempPath) {
  const own = fs.fstatSync(fd, { bigint: true });
  let named;
  try {
    named = fs.lstatSync(tempPath, { bigint: true });
  } catch {
    throw new Error('atomic write temporary file was replaced before rename');
  }
  if (!isPrivateSingleLink(own) || !isPrivateSingleLink(named)) {
    throw new Error('atomic write temporary file must be a private regular single-link file');
  }
  if (!sameIdentity(own, named)) throw new Error('atomic write temporary file was replaced before rename');
}

function checkPublished(fd, filePath) {
  let named;
  try {
    named = fs.lstatSync(filePath, { bigint: true });
  } catch {
    throw new Error('atomic write target was replaced at publication');
  }
  if (!named.isFile() || !sameIdentity(fs.fstatSync(fd, { bigint: true }), named)) {
    throw new Error('atomic write target was replaced at publication');
  }
}

function syncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // some platforms cannot fsync a folder
  }
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp.${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  let published = false;
  try {
    writeAll(fd, content);
    fs.fsyncSync(fd);
    checkTemp(fd, tempPath);
    renameRetry(tempPath, filePath);
    checkPublished(fd, filePath);
    published = true;
  } finally {
    fs.closeSync(fd);
    if (!published) unlinkQuiet(tempPath);
  }
  syncDir(dir);
}

// Windows refuses a rename onto a file another process has open or is replacing at that moment (EPERM, EBUSY,
// EACCES); measured on the Windows test box with two writers creating .omc/.gitignore together. It clears within
// milliseconds, so the rename is tried again for up to about two seconds there. Other systems rename atomically.
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
function renameRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || !RENAME_BUSY.has(err.code) || attempt >= 20) throw err;
      Atomics.wait(PAUSE, 0, 0, 10 * attempt);
    }
  }
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

// Older than 30 s and its owner (the pid inside) dead or unknown.
function isLockStale(lockPath) {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs < STALE_LOCK_MS) return false;
  } catch {
    return false;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (payload.pid && isProcessAlive(payload.pid)) return false;
  } catch {
    // unreadable: stale when old enough
  }
  return true;
}

function openLock(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    unlinkQuiet(lockPath);
    throw err;
  }
  return { fd, path: lockPath };
}

function tryLock(lockPath) {
  const handle = openLock(lockPath);
  if (handle || !isLockStale(lockPath)) return handle;
  unlinkQuiet(lockPath);
  try {
    return openLock(lockPath);
  } catch {
    return null;
  }
}

function acquireLock(lockPath) {
  const first = tryLock(lockPath);
  if (first) return first;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    Atomics.wait(cell, 0, 0, Math.min(LOCK_RETRY_MS, deadline - Date.now()));
    const handle = tryLock(lockPath);
    if (handle) return handle;
  }
  return null;
}

// ============================================================================
// Storage (src/hooks/wiki/storage.ts)
// ============================================================================

/** Create the wiki folder and keep wiki/ in <omc root>/.gitignore. */
function ensureWikiDir(ctx) {
  if (!fs.existsSync(ctx.wikiDir)) fs.mkdirSync(ctx.wikiDir, { recursive: true });
  const ignore = path.join(ctx.omcRoot, '.gitignore');
  const has = () => fs.existsSync(ignore) && fs.readFileSync(ignore, 'utf-8').includes('wiki/');
  try {
    if (!fs.existsSync(ignore)) return atomicWrite(ignore, 'wiki/\n');
    const content = fs.readFileSync(ignore, 'utf-8');
    if (!content.includes('wiki/')) atomicWrite(ignore, `${content.trimEnd()}\nwiki/\n`);
  } catch (err) {
    // This runs before the lock, as in OMC: another writer may be making the same file. Its result is what is wanted.
    if (!has()) throw err;
  }
}

function withWikiLock(ctx, fn) {
  ensureWikiDir(ctx);
  const lockPath = path.join(ctx.wikiDir, '.wiki-lock.lock');
  const handle = acquireLock(lockPath);
  if (!handle) throw new Error(`Failed to acquire file lock: ${lockPath}`);
  try {
    return fn();
  } finally {
    try { fs.closeSync(handle.fd); } catch { /* already closed */ }
    unlinkQuiet(handle.path);
  }
}

const unquote = (v) => {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
};
const escapeYaml = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
const unescapeYaml = (v) => v.replace(/\\(\\|"|n|r)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch));

function parseSimpleYaml(yaml) {
  const result = {};
  for (const line of yaml.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = unescapeYaml(unquote(value));
    else if (value.startsWith("'") && value.endsWith("'")) value = unquote(value);
    if (key) result[key] = value;
  }
  return result;
}

// One character inside a quoted item: returns how many more characters it took (an escape or a doubled quote).
function quotedChar(st, inner, i) {
  const ch = inner[i];
  st.current += ch;
  const escaped = st.quote === '"' && ch === '\\' && i + 1 < inner.length;
  const doubled = st.quote === "'" && ch === "'" && inner[i + 1] === "'";
  if (escaped || doubled) {
    st.current += inner[i + 1];
    return 1;
  }
  if (ch === st.quote) st.quote = null;
  return 0;
}

// The inside of `[a, "b, c"]` split on commas outside quotes; a quote opens only at the start of an item.
function splitFlowItems(inner) {
  const st = { items: [], current: '', quote: null };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (st.quote) {
      i += quotedChar(st, inner, i);
    } else if ((ch === '"' || ch === "'") && st.current.trim() === '') {
      st.quote = ch;
      st.current += ch;
    } else if (ch === ',') {
      st.items.push(st.current);
      st.current = '';
    } else {
      st.current += ch;
    }
  }
  st.items.push(st.current);
  return st.items;
}

function parseYamlArray(value) {
  if (!value) return [];
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) return trimmed ? [trimmed] : [];
  return splitFlowItems(trimmed.slice(1, -1)).map((item) => {
    const scalar = item.trim();
    const bare = unquote(scalar);
    return scalar.startsWith('"') && scalar.endsWith('"') ? unescapeYaml(bare) : bare;
  }).filter(Boolean);
}

export function parseFrontmatter(raw) {
  const normalized = (raw.startsWith('\uFEFF') ? raw.slice(1) : raw).replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const fm = parseSimpleYaml(match[1]);
  return {
    frontmatter: {
      title: String(fm.title || ''),
      tags: parseYamlArray(fm.tags),
      created: String(fm.created || new Date().toISOString()),
      updated: String(fm.updated || new Date().toISOString()),
      sources: parseYamlArray(fm.sources),
      links: parseYamlArray(fm.links),
      category: fm.category || 'reference',
      confidence: fm.confidence || 'medium',
      schemaVersion: Number(fm.schemaVersion) || SCHEMA_VERSION,
    },
    content: match[2],
  };
}

export function serializePage(page) {
  const fm = page.frontmatter;
  const list = (items) => `[${items.map((x) => `"${escapeYaml(x)}"`).join(', ')}]`;
  const yaml = [
    `title: "${escapeYaml(fm.title)}"`,
    `tags: ${list(fm.tags)}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `sources: ${list(fm.sources)}`,
    `links: ${list(fm.links)}`,
    `category: ${fm.category}`,
    `confidence: ${fm.confidence}`,
    `schemaVersion: ${fm.schemaVersion}`,
  ].join('\n');
  return `---\n${yaml}\n---\n${page.content}`;
}

export function titleToSlug(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  if (base) return `${base}.md`;
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  return `page-${Math.abs(hash).toString(16).padStart(8, '0')}.md`;
}

function safeWikiPath(wikiDir, filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  const filePath = path.join(wikiDir, filename);
  return path.resolve(filePath).startsWith(path.resolve(wikiDir) + path.sep) ? filePath : null;
}

function readPage(ctx, filename) {
  const filePath = safeWikiPath(ctx.wikiDir, filename);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
    return parsed ? { filename, frontmatter: parsed.frontmatter, content: parsed.content } : null;
  } catch {
    return null;
  }
}

function listPages(ctx) {
  if (!fs.existsSync(ctx.wikiDir)) return [];
  return fs.readdirSync(ctx.wikiDir).filter((f) => f.endsWith('.md') && !RESERVED.has(f)).sort();
}

function readAllPages(ctx) {
  return listPages(ctx).map((f) => readPage(ctx, f)).filter((p) => p !== null);
}

function readWikiFile(ctx, name) {
  const p = path.join(ctx.wikiDir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function writePageUnsafe(ctx, page) {
  if (RESERVED.has(page.filename)) throw new Error(`Cannot write to reserved wiki file: ${page.filename}`);
  ensureWikiDir(ctx);
  const filePath = safeWikiPath(ctx.wikiDir, page.filename);
  if (!filePath) throw new Error(`Invalid wiki page filename: ${page.filename}`);
  atomicWrite(filePath, serializePage(page));
}

function indexLine(page) {
  const summary = page.content.split('\n').find((l) => l.trim().length > 0)?.trim() || '';
  const truncated = summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  return `- [${page.frontmatter.title}](${page.filename}) \u2014 ${truncated}`;
}

function updateIndexUnsafe(ctx) {
  const pages = readAllPages(ctx);
  const byCategory = new Map();
  for (const page of pages) {
    const cat = page.frontmatter.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(page);
  }
  const lines = ['# Wiki Index', '', `> ${pages.length} pages | Last updated: ${new Date().toISOString()}`, ''];
  for (const cat of [...byCategory.keys()].sort()) {
    lines.push(`## ${cat}`, '', ...byCategory.get(cat).map(indexLine), '');
  }
  ensureWikiDir(ctx);
  atomicWrite(path.join(ctx.wikiDir, 'index.md'), lines.join('\n'));
}

function appendLogUnsafe(ctx, entry) {
  ensureWikiDir(ctx);
  const logPath = path.join(ctx.wikiDir, 'log.md');
  const line = `## [${entry.timestamp}] ${entry.operation}\n`
    + `- **Pages:** ${entry.pagesAffected.join(', ') || 'none'}\n`
    + `- **Summary:** ${entry.summary}\n\n`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Wiki Log\n\n';
  atomicWrite(logPath, existing + line);
}

function appendLog(ctx, entry) {
  withWikiLock(ctx, () => appendLogUnsafe(ctx, entry));
}

// Deliberate difference: a page in a newer OMC format stops every write that rewrites pages or the index.
function refuseNewerSchema(ctx) {
  const newer = readAllPages(ctx).find((p) => p.frontmatter.schemaVersion > SCHEMA_VERSION);
  if (newer) {
    throw new Error(`Wiki page ${newer.filename} has schemaVersion ${newer.frontmatter.schemaVersion}, newer than the `
      + `${SCHEMA_VERSION} this fallback writes; nothing was changed. Use the OMC wiki tools of that version.`);
  }
}

// ============================================================================
// Operations (src/hooks/wiki/ingest.ts, query.ts, lint.ts)
// ============================================================================

function extractWikiLinks(content) {
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => titleToSlug(m.slice(2, -2).trim())))];
}

function createPage(slug, input, now) {
  return {
    filename: slug,
    frontmatter: {
      title: input.title,
      tags: [...new Set(input.tags)],
      created: now,
      updated: now,
      sources: input.sources || [],
      links: extractWikiLinks(input.content),
      category: input.category,
      confidence: input.confidence || 'medium',
      schemaVersion: SCHEMA_VERSION,
    },
    content: `\n# ${input.title}\n\n${input.content}\n`,
  };
}

function mergePage(existing, input, now) {
  const rank = { high: 3, medium: 2, low: 1 };
  const fm = existing.frontmatter;
  const keepNew = (rank[input.confidence || 'medium'] || 2) >= (rank[fm.confidence] || 2);
  return {
    filename: existing.filename,
    frontmatter: {
      ...fm,
      tags: [...new Set([...fm.tags, ...input.tags])],
      updated: now,
      sources: [...new Set([...fm.sources, ...(input.sources || [])])],
      links: [...new Set([...fm.links, ...extractWikiLinks(input.content)])],
      confidence: keepNew ? (input.confidence || 'medium') : fm.confidence,
    },
    content: `${existing.content.trimEnd()}\n\n---\n\n## Update (${now})\n\n${input.content}\n`,
  };
}

// Deliberate difference: OMC takes a page it cannot parse for no page and writes a new one over it.
function refuseUnparsable(ctx, slug, existing) {
  const filePath = safeWikiPath(ctx.wikiDir, slug);
  if (!existing && filePath && fs.existsSync(filePath)) {
    throw new Error(`Existing wiki page ${slug} has no readable frontmatter, so it was not overwritten; `
      + 'fix or remove it first.');
  }
}

// The page an ingest would merge into, after the stops; run once before the lock (so a stop changes no file, not
// even the .gitignore the lock's setup writes) and again under it.
function ingestTarget(ctx, slug) {
  if (RESERVED.has(slug)) throw new Error(`Cannot write to reserved wiki file: ${slug}`);
  refuseNewerSchema(ctx);
  const existing = readPage(ctx, slug);
  refuseUnparsable(ctx, slug, existing);
  return existing;
}

function ingestKnowledge(ctx, input) {
  const slug = titleToSlug(input.title);
  const now = new Date().toISOString();
  const result = { created: [], updated: [], totalAffected: 0 };
  ingestTarget(ctx, slug);
  withWikiLock(ctx, () => {
    const existing = ingestTarget(ctx, slug);
    writePageUnsafe(ctx, existing ? mergePage(existing, input, now) : createPage(slug, input, now));
    (existing ? result.updated : result.created).push(slug);
    updateIndexUnsafe(ctx);
    appendLogUnsafe(ctx, {
      timestamp: now,
      operation: 'ingest',
      pagesAffected: [...result.created, ...result.updated],
      summary: existing ? `Updated "${input.title}" with new content` : `Created new page "${input.title}"`,
    });
  });
  result.totalAffected = result.created.length + result.updated.length;
  return result;
}

export function tokenize(text) {
  const lower = text.toLowerCase();
  const latin = /[a-z0-9\u00C0-\u024F]+/g;
  const cjk = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]+/g;
  const tokens = [...(lower.match(latin) || [])];
  for (const segment of lower.match(cjk) || []) {
    for (let i = 0; i < segment.length; i++) tokens.push(segment[i]);
    for (let i = 0; i < segment.length - 1; i++) tokens.push(segment.slice(i, i + 2));
  }
  const rest = lower.replace(latin, ' ').replace(cjk, ' ').split(/\s+/).filter((t) => t.length > 0 && /\p{L}/u.test(t));
  return [...tokens, ...rest];
}

function tagScore(page, filterTags, terms) {
  const tags = page.frontmatter.tags;
  let score = 0;
  if (filterTags && filterTags.length > 0) {
    score += filterTags.filter((t) => tags.some((pt) => pt.toLowerCase() === t.toLowerCase())).length * 3;
  }
  for (const term of terms) if (tags.some((t) => t.toLowerCase().includes(term))) score += 2;
  return score;
}

function titleScore(page, queryLower, terms) {
  const title = page.frontmatter.title.toLowerCase();
  if (title.includes(queryLower)) return 5;
  return terms.filter((term) => title.includes(term)).length * 2;
}

function contentScore(page, terms) {
  const lower = page.content.toLowerCase();
  let score = 0;
  let snippet = '';
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx === -1) continue;
    score += 1;
    if (snippet) continue;
    const start = Math.max(0, idx - 40);
    const end = Math.min(lower.length, idx + term.length + 80);
    const raw = page.content.slice(start, end).replace(/\n+/g, ' ').trim();
    snippet = (start > 0 ? '...' : '') + raw + (end < lower.length ? '...' : '');
  }
  return { score, snippet };
}

function defaultSnippet(page) {
  const line = page.content.split('\n').find((l) => l.trim().length > 0)?.trim() || '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function queryWiki(ctx, queryText, options) {
  const { tags: filterTags, category, limit = 20 } = options;
  const queryLower = queryText.toLowerCase();
  const terms = tokenize(queryText);
  const matches = [];
  for (const page of readAllPages(ctx)) {
    if (category && page.frontmatter.category !== category) continue;
    const found = contentScore(page, terms);
    const score = tagScore(page, filterTags, terms) + titleScore(page, queryLower, terms) + found.score;
    if (score > 0) matches.push({ page, snippet: found.snippet || defaultSnippet(page), score });
  }
  matches.sort((a, b) => b.score - a.score);
  const limited = matches.slice(0, limit);
  appendLog(ctx, {
    timestamp: new Date().toISOString(),
    operation: 'query',
    pagesAffected: limited.map((m) => m.page.filename),
    summary: `Query "${queryText}" \u2192 ${limited.length} results (of ${matches.length} total)`,
  });
  return limited;
}

function pageIssues(page, incoming, filenames, now) {
  const { title, updated, links, confidence } = page.frontmatter;
  const issue = (severity, type, message) => ({ page: page.filename, severity, type, message });
  const issues = [];
  if (!incoming.has(page.filename) || incoming.get(page.filename).size === 0) {
    issues.push(issue('info', 'orphan', `No other pages link to "${title}"`));
  }
  const updatedAt = new Date(updated).getTime();
  if (now - updatedAt > STALE_DAYS * DAY_MS) {
    issues.push(issue('warning', 'stale', `"${title}" not updated in ${Math.floor((now - updatedAt) / DAY_MS)} days`));
  }
  for (const link of links.filter((l) => !filenames.has(l))) {
    issues.push(issue('error', 'broken-ref', `Broken link to "${link}" from "${title}"`));
  }
  if (confidence === 'low') issues.push(issue('info', 'low-confidence', `"${title}" has low confidence \u2014 consider verifying or removing`));
  const size = Buffer.byteLength(page.content, 'utf-8');
  if (size > MAX_PAGE_SIZE) {
    issues.push(issue('warning', 'oversized', `"${title}" is ${(size / 1024).toFixed(1)}KB \u2014 consider splitting into smaller pages`));
  }
  return issues;
}

function groupContradictions(group) {
  const out = [];
  const contradiction = (severity, message) => ({ page: group[0].filename, severity, type: 'structural-contradiction', message });
  const confidences = new Set(group.map((p) => p.frontmatter.confidence));
  if (confidences.size > 1 && confidences.has('high') && confidences.has('low')) {
    out.push(contradiction('warning', `Conflicting confidence levels for related pages: ${group.map((p) => `"${p.frontmatter.title}"`).join(', ')}`));
  }
  const tagCategories = new Map();
  for (const page of group) {
    for (const tag of page.frontmatter.tags) {
      if (!tagCategories.has(tag)) tagCategories.set(tag, new Set());
      tagCategories.get(tag).add(page.frontmatter.category);
    }
  }
  const mixed = [...tagCategories].find(([, cats]) => cats.size > 1);
  if (mixed) out.push(contradiction('info', `Tag "${mixed[0]}" appears in pages with different categories: ${[...mixed[1]].join(', ')}`));
  return out;
}

function structuralContradictions(pages) {
  const groups = new Map();
  for (const page of pages) {
    const prefix = page.filename.split('-').slice(0, 2).join('-');
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(page);
  }
  return [...groups.values()].filter((g) => g.length >= 2).flatMap(groupContradictions);
}

function lintWiki(ctx) {
  const pages = readAllPages(ctx);
  const filenames = new Set(pages.map((p) => p.filename));
  const incoming = new Map();
  for (const page of pages) {
    for (const link of page.frontmatter.links) {
      if (!incoming.has(link)) incoming.set(link, new Set());
      incoming.get(link).add(page.filename);
    }
  }
  const now = Date.now();
  const issues = [...pages.flatMap((p) => pageIssues(p, incoming, filenames, now)), ...structuralContradictions(pages)];
  const count = (type) => issues.filter((i) => i.type === type).length;
  const stats = {
    totalPages: pages.length, orphanCount: count('orphan'), staleCount: count('stale'), brokenRefCount: count('broken-ref'),
    lowConfidenceCount: count('low-confidence'), oversizedCount: count('oversized'), contradictionCount: count('structural-contradiction'),
  };
  appendLog(ctx, {
    timestamp: new Date().toISOString(),
    operation: 'lint',
    pagesAffected: [...new Set(issues.map((i) => i.page))],
    summary: `Lint: ${issues.length} issues (${stats.orphanCount} orphan, ${stats.staleCount} stale, ${stats.brokenRefCount} broken, ${stats.contradictionCount} contradictions)`,
  });
  return { issues, stats };
}

// ============================================================================
// The seven tools (src/tools/wiki-tools.ts): response text, and the OMX JSON shape for --json
// ============================================================================

const searchedSuffix = (root, pages) => ` (searched ${pages} page${pages === 1 ? '' : 's'} in ${path.basename(root)}/.omc/wiki)`;
const pageFile = (page) => (page.endsWith('.md') ? page : `${page}.md`);
const failure = (text) => ({ isError: true, text, data: { error: text } });

function toolIngest(ctx, a) {
  const result = ingestKnowledge(ctx, {
    title: a.title, content: a.content, tags: a.tags, category: a.category, sources: a.sources, confidence: a.confidence,
  });
  const text = `Wiki ingest complete.\n- Created: ${result.created.join(', ') || 'none'}\n`
    + `- Updated: ${result.updated.join(', ') || 'none'}\n- Total affected: ${result.totalAffected}`;
  return { text, data: result };
}

function toolAdd(ctx, a) {
  const slug = titleToSlug(a.title);
  if (readPage(ctx, slug)) {
    return failure(`Page "${slug}" already exists. Use wiki_ingest to merge content into it, or wiki_delete to remove it first.`);
  }
  const result = ingestKnowledge(ctx, { title: a.title, content: a.content, tags: a.tags || [], category: a.category || 'reference' });
  return { text: `Wiki page created: ${result.created[0]}\nPath: .omc/wiki/${result.created[0]}`, data: result };
}

function toolQuery(ctx, a) {
  const matches = queryWiki(ctx, a.query, { tags: a.tags, category: a.category, limit: a.limit });
  if (matches.length === 0) {
    return { text: `No wiki pages match "${a.query}".${searchedSuffix(ctx.root, listPages(ctx).length)}`, data: [] };
  }
  const results = matches.map((m, i) => {
    const fm = m.page.frontmatter;
    return `### ${i + 1}. ${fm.title} (${fm.category}, ${fm.confidence})\n`
      + `**File:** ${m.page.filename} | **Tags:** ${fm.tags.join(', ')} | **Score:** ${m.score}\n`
      + `**Snippet:** ${m.snippet}`;
  });
  return { text: `## Wiki Query: "${a.query}"\n\n${matches.length} results:\n\n${results.join('\n\n')}`, data: matches };
}

function toolLint(ctx) {
  const report = lintWiki(ctx);
  const s = report.stats;
  if (report.issues.length === 0) return { text: `Wiki lint: ${s.totalPages} pages, no issues found.`, data: report };
  const lines = report.issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.type}: ${i.message}`);
  const text = `## Wiki Lint Report\n\n**${s.totalPages} pages**, ${report.issues.length} issues:\n\n${lines.join('\n')}`
    + `\n\n**Summary:** ${s.orphanCount} orphan, ${s.staleCount} stale, ${s.brokenRefCount} broken refs, `
    + `${s.contradictionCount} contradictions, ${s.oversizedCount} oversized`;
  return { text, data: report };
}

function toolList(ctx) {
  const index = readWikiFile(ctx, 'index.md');
  const pages = listPages(ctx);
  const data = { pages, index };
  if (index) return { text: index, data };
  if (pages.length === 0) return { text: `Wiki is empty.${searchedSuffix(ctx.root, 0)} Use wiki_add or wiki_ingest to create pages.`, data };
  return { text: `Wiki has ${pages.length} pages but no index. Pages:\n${pages.map((p) => `- ${p}`).join('\n')}`, data };
}

function toolRead(ctx, a) {
  const filename = pageFile(a.page);
  const page = readPage(ctx, filename);
  if (!page) return failure(`Wiki page not found: ${filename}`);
  const fm = page.frontmatter;
  const header = [
    `## ${fm.title}`,
    `**Category:** ${fm.category} | **Confidence:** ${fm.confidence} | **Updated:** ${fm.updated}`,
    `**Tags:** ${fm.tags.join(', ')}`,
    fm.links.length > 0 ? `**Links:** ${fm.links.join(', ')}` : '',
    fm.sources.length > 0 ? `**Sources:** ${fm.sources.join(', ')}` : '',
    '',
  ].filter(Boolean).join('\n');
  return { text: `${header}\n${page.content}`, data: page };
}

function deletePageLocked(ctx, filename) {
  return withWikiLock(ctx, () => {
    const filePath = safeWikiPath(ctx.wikiDir, filename);
    if (!filePath || !fs.existsSync(filePath)) return false;
    refuseNewerSchema(ctx);
    fs.unlinkSync(filePath);
    updateIndexUnsafe(ctx);
    return true;
  });
}

// index.md, log.md, environment.md, or another spelling of one that names the same file (a case-blind disk).
function isReservedFile(ctx, filename) {
  if (RESERVED.has(filename)) return true;
  if (!RESERVED.has(filename.toLowerCase())) return false;
  try {
    const st = (n) => fs.statSync(path.join(ctx.wikiDir, n), { bigint: true });
    return sameIdentity(st(filename), st(filename.toLowerCase()));
  } catch {
    return false;
  }
}

function toolDelete(ctx, a) {
  const filename = pageFile(a.page);
  // Deliberate difference: OMC deletes its own index.md, log.md and environment.md when asked to.
  if (isReservedFile(ctx, filename)) throw new Error(`Cannot delete reserved wiki file: ${filename}`);
  refuseNewerSchema(ctx);
  if (!deletePageLocked(ctx, filename)) return failure(`Wiki page not found: ${filename}`);
  appendLog(ctx, { timestamp: new Date().toISOString(), operation: 'delete', pagesAffected: [filename], summary: `Deleted page "${filename}"` });
  return { text: `Deleted wiki page: ${filename}`, data: { deleted: true, page: filename } };
}

// ============================================================================
// Input validation: the tools' zod schemas (src/tools/wiki-tools.ts)
// ============================================================================

const str = (max) => ({ type: 'string', max });
const arr = (items, max) => ({ type: 'array', items, max });
const oneOf = (values) => ({ type: 'enum', values });
const optional = (spec) => ({ ...spec, optional: true });
const WD = { workingDirectory: optional(str()) };

const TOOLS = {
  wiki_ingest: {
    run: toolIngest, prefix: 'Error ingesting into wiki: ',
    schema: { title: str(200), content: str(50000), tags: arr(str(50), 20), category: oneOf(CATEGORIES),
      sources: optional(arr(str(100), 10)), confidence: optional(oneOf(CONFIDENCES)), ...WD },
  },
  wiki_query: {
    run: toolQuery, prefix: 'Error querying wiki: ',
    schema: { query: str(), tags: optional(arr(str())), category: optional(oneOf(CATEGORIES)),
      limit: optional({ type: 'int', min: 1, max: 50 }), ...WD },
  },
  wiki_lint: { run: toolLint, prefix: 'Error linting wiki: ', schema: { ...WD } },
  wiki_add: {
    run: toolAdd, prefix: 'Error adding wiki page: ',
    schema: { title: str(200), content: str(50000), tags: optional(arr(str(50), 20)), category: optional(oneOf(CATEGORIES)), ...WD },
  },
  wiki_list: { run: toolList, prefix: 'Error listing wiki: ', schema: { ...WD } },
  wiki_read: { run: toolRead, prefix: 'Error reading wiki page: ', schema: { page: str(), ...WD } },
  wiki_delete: { run: toolDelete, prefix: 'Error deleting wiki page: ', schema: { page: str(), ...WD } },
};
export const TOOL_NAMES = Object.keys(TOOLS);

function checkArray(spec, value, name) {
  if (!Array.isArray(value)) return `${name} must be an array`;
  if (spec.max !== undefined && value.length > spec.max) return `${name} must have at most ${spec.max} items`;
  for (let i = 0; i < value.length; i++) {
    const why = checkValue(spec.items, value[i], `${name}[${i}]`);
    if (why) return why;
  }
  return null;
}

const CHECKS = {
  array: checkArray,
  enum: (spec, value, name) => (spec.values.includes(value) ? null : `${name} must be one of ${spec.values.join(', ')}`),
  int: (spec, value, name) => (Number.isInteger(value) && value >= spec.min && value <= spec.max
    ? null : `${name} must be an integer from ${spec.min} to ${spec.max}`),
  string: (spec, value, name) => {
    if (typeof value !== 'string') return `${name} must be a string`;
    return spec.max !== undefined && value.length > spec.max ? `${name} must be at most ${spec.max} characters` : null;
  },
};

function checkValue(spec, value, name) {
  return CHECKS[spec.type](spec, value, name);
}

/** Why an input breaks the tool's declared schema, or null. Unknown keys are ignored, as zod strips them. */
export function validateInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be a JSON object';
  for (const [name, spec] of Object.entries(TOOLS[tool].schema)) {
    if (input[name] === undefined) {
      if (spec.optional) continue;
      return `${name} is required`;
    }
    const why = checkValue(spec, input[name], name);
    if (why) return why;
  }
  return null;
}

// ============================================================================
// obsidizer: the hook's canonicalizer run, for the pages this call wrote
// ============================================================================

function obsidize(wikiDir, data) {
  if (!fs.existsSync(path.join(wikiDir, '.obsidizer'))) return;
  const canonicalizer = CANONICALIZERS.find((p) => fs.existsSync(p));
  if (!canonicalizer) {
    process.stderr.write(`wiki.mjs: obsidizer is on (${path.join(wikiDir, '.obsidizer')}) but obsidize.mjs is not beside this skill; run obsidizer on the wiki later\n`);
    return;
  }
  const pages = [...data.created, ...data.updated].filter((n) => !RESERVED.has(n)).map((n) => path.join(wikiDir, n));
  for (const page of pages.filter((p) => fs.existsSync(p))) {
    const run = spawnSync(process.execPath, [canonicalizer, page, '--profile=omc', '--json'], {
      encoding: 'utf8', timeout: OBSIDIZE_TIMEOUT_MS, windowsHide: true,
    });
    const why = run.error ? run.error.message : run.status !== 0 ? `exit ${run.status}: ${run.stderr || run.stdout}` : '';
    if (why) process.stderr.write(`wiki.mjs: obsidizer did not canonicalize ${path.basename(page)}: ${why.trim()}\n`);
  }
}

/**
 * Run one tool as OMC's MCP server would. Returns { isError, text, data }: text is OMC's response text, data the
 * OMX-shaped JSON result ({ error } when isError). The project is the process's cwd, as for OMC's server.
 */
export function runTool(name, input = {}) {
  const tool = TOOLS[name];
  if (!tool) return failure(`Unknown tool: ${name}`);
  const invalid = validateInput(name, input);
  if (invalid) return failure(`${tool.prefix}invalid input: ${invalid}`);
  let ctx;
  let out;
  try {
    const root = resolveRoot(input.workingDirectory);
    const omcRoot = omcRootOf(root);
    ctx = { root, omcRoot, wikiDir: path.join(omcRoot, 'wiki') };
    out = tool.run(ctx, input);
  } catch (err) {
    return failure(`${tool.prefix}${err instanceof Error ? err.message : String(err)}`);
  }
  if (!out.isError && (name === 'wiki_ingest' || name === 'wiki_add')) obsidize(ctx.wikiDir, out.data);
  return { isError: Boolean(out.isError), text: out.text, data: out.data };
}

// ============================================================================
// CLI
// ============================================================================

const USAGE = `usage: node wiki.mjs <tool> [--input '<json>' | --input-file <path>] [--json] [--profile=omc]
  tools: ${TOOL_NAMES.join(', ')} (the wiki_ prefix may be left out)
  exit: 0 done, 1 the tool reported an error, 2 a usage error`;

// The input file as text: UTF-8 (a BOM is dropped) or UTF-16 with its BOM. Anything else stops with exit 2 instead
// of writing U+FFFD into the wiki: Windows PowerShell 5.1's Set-Content writes the system code page (cp949 on Korean
// Windows) by default.
function decodeInputFile(bytes, file) {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  try {
    const text = new TextDecoder(utf16 || 'utf-8', { fatal: true }).decode(bytes);
    return text.startsWith('\uFEFF') ? text.slice(1) : text;
  } catch {
    throw new Error(`--input-file ${file} is not UTF-8 (or UTF-16 with a BOM); write it as UTF-8`);
  }
}

function readInput(flag, value) {
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  let raw = value;
  if (flag === '--input-file') {
    raw = decodeInputFile(fs.readFileSync(value), value);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid ${flag} JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${flag} must hold a JSON object`);
  return parsed;
}

// One argument into opts; returns how many more it took (the value of --input or --input-file).
function takeArg(opts, arg, next) {
  if (arg === '--json') opts.json = true;
  else if (arg === '--help' || arg === '-h') opts.help = true;
  else if (arg.startsWith('--profile=')) opts.profile = arg.slice('--profile='.length);
  else if (arg === '--input' || arg === '--input-file') {
    if (opts.inputs++) throw new Error('give --input or --input-file once');
    opts.input = readInput(arg, next);
    return 1;
  } else if (!arg.startsWith('-') && !opts.tool) opts.tool = arg.startsWith('wiki_') ? arg : `wiki_${arg}`;
  else throw new Error(`unknown argument: ${arg}`);
  return 0;
}

export function parseArgs(argv) {
  const opts = { tool: null, input: {}, json: false, profile: 'omc', help: false, inputs: 0 };
  for (let i = 0; i < argv.length; i++) i += takeArg(opts, argv[i], argv[i + 1]);
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`wiki.mjs: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help || !opts.tool) {
    (opts.help ? process.stdout : process.stderr).write(`${USAGE}\n`);
    return opts.help ? 0 : 2;
  }
  if (opts.profile !== 'omc') {
    process.stderr.write(`wiki.mjs: --profile=${opts.profile} is not built yet; only --profile=omc (.omc/wiki) is\n`);
    return 2;
  }
  if (!TOOLS[opts.tool]) {
    process.stderr.write(`wiki.mjs: unknown tool: ${opts.tool}\n${USAGE}\n`);
    return 2;
  }
  const result = runTool(opts.tool, opts.input);
  const out = opts.json ? JSON.stringify(result.data) : result.text;
  process.stdout.write(`${out}\n`);
  return result.isError ? 1 : 0;
}

// Run as a command only; a test imports the functions. Node resolves links for import.meta.url, not for argv[1].
function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
