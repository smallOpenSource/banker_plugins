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
 *    discoverable rather than silently doing nothing forever.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANONICALIZER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'obsidizer', 'obsidize.mjs');
const FLAG = '.obsidizer';
const LOG = '.obsidizer-hook.log';
const LOG_REASON_MAX = 500;
// OMC owns these three. index.md is rewritten on every ingest, so it is always the freshest
// file in the vault — the scan fallback below would target it first without this guard.
const RESERVED = new Set(['index.md', 'log.md', 'environment.md']);
// Scan fallback: how recently a page must have changed to count as "this write touched it".
const RECENT_MS = 10_000;
// Stay inside the `timeout: 5` declared in hooks.json.
const CANONICALIZE_TIMEOUT_MS = 4000;

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
  try {
    appendFileSync(join(wikiDir, LOG), line);
  } catch {
    // The log is best-effort; the failure path must never throw.
  }
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function wikiDirCandidates(root) {
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
  return wikiDirCandidates(root).find((dir) => isDir(dir) && existsSync(join(dir, FLAG))) ?? null;
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

// Canonicalizes one page; a failure appends its one log line.
function canonicalize(wikiDir, tool, page) {
  const run = spawnSync(process.execPath, [CANONICALIZER, page, '--profile=omc', '--json'], {
    encoding: 'utf8',
    timeout: CANONICALIZE_TIMEOUT_MS,
    windowsHide: true,
  });
  const why = runFailure(run);
  if (why) log(wikiDir, tool, `${basename(page)}: ${why}`);
}

// A write can be redirected with workingDirectory; fall back to the session cwd.
function writeRoot(payload) {
  return payload?.tool_input?.workingDirectory || payload?.cwd || process.cwd();
}

async function main() {
  const { payload, error } = await readPayload();
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
