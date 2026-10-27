#!/usr/bin/env node
/*
 * banker obsidizer PostToolUse hook — thin gate + dispatcher.
 *
 * Fires after an OMC wiki write (the matcher lives in hooks.json) and canonicalizes only
 * the page(s) that write touched, by delegating to skills/obsidizer/obsidize.mjs. There is
 * exactly one canonicalizer: no frontmatter/link/tag logic belongs in this file, and the
 * armed hook and a bare `obsidizer` run therefore apply a byte-identical ruleset.
 *
 * Invariants (each is enforced by a test in obsidize-hook.test.mjs):
 *  - Pure filesystem. It never calls back into an MCP tool — this hook fires ON wiki
 *    writes, so issuing one would re-enter and loop. No tool identifier appears below.
 *  - Armed by <wikiDir>/.obsidizer. Absent => exit 0 having changed nothing, logged nothing.
 *  - Atomicity and read-back CAS live inside the canonicalizer, so both entry points
 *    inherit them. This file must not defeat them: it never pre-processes a page and
 *    never writes one itself.
 *  - Exits 0 on every path. A hook cannot block or alter a tool result and must not try.
 *  - Every error appends exactly one line to <wikiDir>/.obsidizer-hook.log. Exit 0 hides
 *    stderr too, so that log is the only channel by which a permanently broken hook is
 *    discoverable rather than silently doing nothing forever. Only a regular file there is
 *    written: a link (a cloned repository can carry one) or a pipe gets no line.
 *
 * Codex (`--codex`): Codex has no wiki MCP, so a wiki write is a shell call to the `omx wiki` CLI, and Codex fires
 * PostToolUse with tool_name Bash, tool_input.command and the command's stdout as tool_response (Codex 0.144.5).
 * Only a command that runs `omx wiki` ingest or add goes on; every other shell call ends before any file is read. The
 * vault is omx_wiki/ under the session cwd (the CLI writes under the cwd it runs in), and the page names come from the
 * CLI's JSON (`{"created":["a.md"],...}`), which the same name pattern reads. The OMX wiki keeps the OMC page schema
 * and reserved files, so the canonicalizer runs with the same profile.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANONICALIZER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'obsidizer', 'obsidize.mjs');
const FLAG = '.obsidizer';
const LOG = '.obsidizer-hook.log';
const LOG_REASON_MAX = 500;
// Append, never through a link, and never wait for a pipe's reader. Windows has neither flag: there the log place is
// looked at first and a link is left alone (one swapped in after that look is still followed there).
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOG_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW | (constants.O_NONBLOCK ?? 0);
// OMC owns these three. index.md is rewritten on every ingest, so it is always the freshest
// file in the vault — the scan fallback below would target it first without this guard.
const RESERVED = new Set(['index.md', 'log.md', 'environment.md']);
// Scan fallback: how recently a page must have changed to count as "this write touched it".
const RECENT_MS = 10_000;
// Stay inside the `timeout: 5` declared in hooks.json.
const CANONICALIZE_TIMEOUT_MS = 4000;
const CODEX = process.argv.includes('--codex');
// A statement that IS `omx wiki ingest|add` (omx its first word, PowerShell's `&` allowed before it), with or without
// the wiki_ prefix the CLI also takes, and omx.cmd/omx.ps1 on Windows. A command may set the JSON up first
// (`$j = '...'; omx wiki <ingest> --input $j`, as models write it for PowerShell), so each statement split at
// `;`, `&&`, `||` and line ends is looked at. `echo omx wiki add` is not one. The split ignores quotes, so a quoted
// `;` can wake the hook too: what keeps a woken hook inside the vault is the rest (the CLI's JSON names, regular
// single-name pages in a real omx_wiki/ of the session folder).
const OMX_WIKI_WRITE_RE = /^\s*(?:&\s*)?['"]?omx(?:\.cmd|\.ps1)?['"]?\s+wiki\s+(?:wiki_)?(?:ingest|add)\b/;
const STATEMENT_END = /;|&&|\|\||\r?\n/;
const PAGE_NAME_RE = /^[\w.-]+\.md$/;

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

function log(wikiDir, tool, reason) {
  // One line of plain text: whitespace and control characters (ESC among them) fold to a space, and a long reason is cut.
  const text = String(reason).replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  const line = `${new Date().toISOString()}\t${tool}\t${text.length > LOG_REASON_MAX ? `${text.slice(0, LOG_REASON_MAX)}...` : text}\n`;
  const at = join(wikiDir, LOG);
  try {
    if (!NO_FOLLOW && isLink(at)) return;
    const fd = openSync(at, LOG_FLAGS, 0o600);
    try {
      const st = fstatSync(fd);
      if (st.isFile() && st.nlink === 1) writeSync(fd, line); // a hard link to a file elsewhere gets no line
    } finally {
      closeSync(fd);
    }
  } catch {
    // The log is best-effort; the failure path must never throw.
  }
}

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function wikiDirCandidates(root) {
  if (CODEX) return root ? [join(root, 'omx_wiki')] : [];
  const dirs = [];
  // OMC relocates state to <OMC_STATE_DIR>/<projectId>/wiki. projectId is an OMC internal
  // we must not reimplement, so enumerate the candidates instead of deriving the name.
  const stateDir = process.env.OMC_STATE_DIR;
  if (stateDir) {
    try {
      for (const entry of readdirSync(stateDir)) dirs.push(join(stateDir, entry, 'wiki'));
    } catch {
      // Unreadable OMC_STATE_DIR — fall through to the default layout.
    }
  }
  if (root) dirs.push(join(root, '.omc', 'wiki'));
  return dirs;
}

// The flag both arms the hook and identifies which vault it may touch.
function findArmedWikiDir(root) {
  return wikiDirCandidates(root).find((dir) => isDir(dir) && existsSync(join(dir, FLAG)) && (!CODEX || ownDir(root, dir))) ?? null;
}

// Codex runs this hook outside its sandbox, so the vault must really be omx_wiki/ inside the session folder: not a
// link (nor under one) that a sandboxed session or a cloned repository could point at another project's wiki.
function ownDir(root, dir) {
  try {
    return !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === join(realpathSync(root), basename(dir));
  } catch {
    return false;
  }
}

// Codex: only a regular page with one name, so a link or a hard link cannot carry the rewrite out of the vault,
// and a pipe cannot hold the hook.
function plainPage(path) {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.nlink === 1;
  } catch {
    return false;
  }
}

// Codex: the pages the `omx wiki` CLI's JSON says it wrote ({"created":[..],"updated":[..]}); else none. Other
// output may come before it, so the whole output and then each line from the end is tried.
function cliResult(stdout) {
  const text = String(stdout ?? '');
  for (const part of [text, ...text.split(/\r?\n/).reverse()]) {
    try {
      const out = JSON.parse(part);
      if (out && typeof out === 'object' && (Array.isArray(out.created) || Array.isArray(out.updated))) return out;
    } catch {
      // not this one
    }
  }
  return null;
}

function namesFromCli(stdout) {
  const out = cliResult(stdout);
  const list = [out?.created, out?.updated].filter(Array.isArray).flat();
  return [...new Set(list.filter((n) => typeof n === 'string' && PAGE_NAME_RE.test(n)))];
}

function namesFromResponse(toolResponse) {
  // The payload carries no file path; the tool's own response text names the slugs it wrote
  // ("- Created: a.md" / "Path: .omc/wiki/a.md"). Stringify first — the response arrives as
  // text or as a structured content array depending on how the server is wired.
  const text = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '');
  return [...new Set([...text.matchAll(/[\w.-]+\.md/g)].map((match) => match[0]))];
}

function namesFromScan(wikiDir) {
  const cutoff = Date.now() - RECENT_MS;
  return readdirSync(wikiDir).filter((file) => {
    if (!file.endsWith('.md')) return false;
    try { return statSync(join(wikiDir, file)).mtimeMs >= cutoff; } catch { return false; }
  });
}

function resolvePages(wikiDir, toolResponse) {
  if (CODEX) {
    return namesFromCli(toolResponse).filter((name) => !RESERVED.has(name)).map((name) => join(wikiDir, name)).filter(plainPage);
  }
  const names = namesFromResponse(toolResponse);
  return (names.length > 0 ? names : namesFromScan(wikiDir))
    .filter((name) => !RESERVED.has(name))
    .map((name) => join(wikiDir, name))
    .filter((path) => existsSync(path));
}

// The hook payload, or the error that kept it from being read.
async function readPayload() {
  try {
    return { payload: JSON.parse(await readStdin()), error: null };
  } catch (err) {
    return { payload: null, error: err };
  }
}

// Why a canonicalizer run failed, or null when it ran and reported JSON.
function runFailure(run) {
  if (run.error) return `canonicalizer did not run: ${run.error.message}`;
  if (run.status !== 0) return `canonicalizer exited ${run.status}: ${run.stderr || run.stdout}`;
  try {
    JSON.parse(run.stdout);
    return null;
  } catch {
    return 'canonicalizer report was not json';
  }
}

// Codex: the canonicalizer runs in the vault folder on a bare page name, after it checks the folder is the one
// looked at here (dev:ino), so swapping omx_wiki/ for a link after the check cannot lead it outside.
function codexArgs(wikiDir, page) {
  const st = lstatSync(wikiDir, { bigint: true });
  if (!st.isDirectory()) throw new Error('omx_wiki is no folder');
  return { args: [basename(page), '--page', `--vault=${st.dev}:${st.ino}`], cwd: wikiDir };
}

// Canonicalizes one page; a failure appends its one log line.
function canonicalize(wikiDir, tool, page) {
  const at = CODEX ? codexArgs(wikiDir, page) : { args: [page], cwd: undefined };
  const run = spawnSync(process.execPath, [CANONICALIZER, ...at.args, '--profile=omc', '--json'], {
    cwd: at.cwd,
    encoding: 'utf8',
    timeout: CANONICALIZE_TIMEOUT_MS,
    windowsHide: true,
  });
  const why = runFailure(run);
  if (why) log(wikiDir, tool, `${basename(page)}: ${why}`);
}

// A write can be redirected with workingDirectory; fall back to the session cwd.
function writeRoot(payload) {
  if (CODEX) return payload?.cwd || process.cwd();
  return payload?.tool_input?.workingDirectory || payload?.cwd || process.cwd();
}

// Codex fires this after every shell call; only an `omx wiki` write is ours.
function codexWikiWrite(payload) {
  const command = payload?.tool_input?.command;
  return typeof command === 'string' && command.split(STATEMENT_END).some((part) => OMX_WIKI_WRITE_RE.test(part));
}

async function main() {
  const { payload, error } = await readPayload();
  if (CODEX && !error && !codexWikiWrite(payload)) return;
  const wikiDir = findArmedWikiDir(writeRoot(payload));
  if (!wikiDir) return; // Not armed: change nothing, log nothing.

  const tool = payload?.tool_name ?? 'unknown';
  try {
    if (error) return log(wikiDir, tool, `unreadable hook payload: ${error.message}`);
    if (!existsSync(CANONICALIZER)) return log(wikiDir, tool, `canonicalizer missing at ${CANONICALIZER}`);
    for (const page of resolvePages(wikiDir, payload.tool_response)) canonicalize(wikiDir, tool, page);
  } catch (err) {
    log(wikiDir, tool, `unexpected: ${err.message}`);
  }
}

main()
  .catch(() => {}) // An un-canonicalized page is not-yet-formatted; the next bare run repairs it.
  .finally(() => process.exit(0));
