/**
 * Estimated API request payload of a Claude Code session, for the HUD.
 *
 * Claude Code refuses a request over the API's 32MB limit ("Request too large
 * (max 32MB)") and measures it as the JSON size of the messages it sends
 * ("request_body_over_limit: body=…B (messages only)"). This applies the same
 * measure to the session transcript: everything Claude Code would send since the
 * last compact boundary (images and tool results included), picked with the same
 * filter it uses to build a request (see sentPart).
 *
 * Known gaps, all small next to the 8MB threshold in the sessions measured:
 * - the system prompt and tool schemas are not in the transcript, so the real
 *   request is a few hundred KB larger;
 * - after a rewind (Esc Esc) the abandoned branch stays counted until the next
 *   compaction;
 * - the few messages a compaction keeps verbatim before its boundary are not
 *   added back (13KB or less in each of the 53 compactions measured);
 * - tool results Claude Code clears at request time (microcompact, not seen in
 *   these transcripts) stay counted.
 *
 * The transcript only grows, so the scanned offset and running total are cached
 * per transcript under $TMPDIR/omc-hud-payload-<uid>/ and each render reads only
 * what was appended since the last one. A first render (or a rewritten
 * transcript) skims for the last compact boundary and parses only what follows it.
 *
 * On Linux $TMPDIR is usually the shared /tmp, where any account can create a
 * folder first. The uid in the folder name keeps accounts apart, and the cache is
 * used only while that folder is a real directory this account owns and no other
 * account can write to; otherwise every render rescans. macOS and Windows already
 * give each account its own temp folder.
 *
 * When a Claude Code update changes the transcript format or the request filter,
 * fix sentPart and bump CACHE_VERSION, so totals cached under the old rules are
 * rebuilt.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
// Shown from 25% of the limit (8MB) on, as an early warning like ctx.
export const SHOW_FROM_BYTES = REQUEST_LIMIT_BYTES / 4;

const MB = 1024 * 1024;
// The transcript is read in pieces of this size (exported for the tests).
export const CHUNK_BYTES = 8 * MB;
const NL = 0x0a;
const BOUNDARY_MARK = Buffer.from('"compact_boundary"');
// This account's uid, or null where there is none (Windows).
const UID = typeof process.getuid === "function" ? process.getuid() : null;
// Per-transcript estimate cache, one folder per account; payload-mon off deletes it
// when this account controls the folder (clearCache).
export const CACHE_DIR = join(tmpdir(), UID === null ? "omc-hud-payload" : `omc-hud-payload-${UID}`);
// Bump whenever sentPart changes, so cached totals from older rules are rebuilt.
const CACHE_VERSION = 2;
// The model Claude Code stamps on the API-error rows it shows but never sends.
const SYNTHETIC_MODEL = "<synthetic>";

const parseLine = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null; // torn or foreign line: nothing to count
  }
};

const isBoundary = (e) => e?.type === "system" && e.subtype === "compact_boundary";

// Rows Claude Code drops from a request: virtual rows and API-error stand-ins.
const isDropped = (e) => e.isVirtual === true || (e.isApiErrorMessage === true && e.message?.model === SYNTHETIC_MODEL);

// An attachment sends its rendered text (system reminders, CLAUDE.md, file
// mentions). An image @-mention is stored without one, since Claude Code renders
// it again for each request, so its base64 stands in. A PDF mention sends only a
// short note, and hook results and snapshots send nothing.
function attachmentPart(e) {
  if (e.rendered !== undefined) return e.rendered;
  const { type, content } = e.attachment ?? {};
  return type === "file" && content?.type === "image" ? content.file?.base64 : undefined;
}

// The part of an entry that goes into the request, mirroring Claude Code's own
// filter: user/assistant content (the compact summary included), local command
// output and attachments. Sidechains are subagents' own loops.
function sentPart(e) {
  if (!e || e.isSidechain) return undefined;
  if (e.type === "user" || e.type === "assistant") return isDropped(e) ? undefined : e.message?.content;
  if (e.type === "system") return e.subtype === "local_command" ? e.content : undefined;
  return e.type === "attachment" ? attachmentPart(e) : undefined;
}

const entryBytes = (e) => {
  const sent = sentPart(e);
  return sent == null ? 0 : Buffer.byteLength(JSON.stringify(sent));
};

// Reads [from, size) in chunks and hands each run of complete lines to
// onLines(buf, base): buf ends in "\n" and starts at file offset base. A last
// line still being written is left for the next render. Returns the offset just
// past the last complete line.
function readCompleteLines(fd, from, size, onLines) {
  let pos = from;
  let base = from;
  let carry = Buffer.alloc(0);
  while (pos < size) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos));
    const n = readSync(fd, chunk, 0, chunk.length, pos);
    if (n === 0) break;
    pos += n;
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
    const end = data.lastIndexOf(NL) + 1;
    if (end > 0) onLines(data.subarray(0, end), base);
    base += end;
    carry = data.subarray(end);
  }
  return base;
}

// Offset just past the last real compact boundary, 0 when there is none. Only
// lines holding the marker are parsed, so a 70MB transcript is skimmed in ~0.2s.
// Exported so the tests can pin where the count starts.
export function lastBoundaryEnd(fd, size) {
  let found = 0;
  readCompleteLines(fd, 0, size, (buf, base) => {
    for (let k = buf.indexOf(BOUNDARY_MARK); k !== -1; ) {
      const end = buf.indexOf(NL, k);
      if (isBoundary(parseLine(buf.toString("utf8", buf.lastIndexOf(NL, k) + 1, end)))) found = base + end + 1;
      k = buf.indexOf(BOUNDARY_MARK, end);
    }
  });
  return found;
}

// Running total over the complete lines in [from, size). A compact boundary
// starts it over: compaction replaces everything sent before it.
function sumEntries(fd, from, size, bytes) {
  let total = bytes;
  const offset = readCompleteLines(fd, from, size, (buf) => {
    for (let start = 0, end; (end = buf.indexOf(NL, start)) !== -1; start = end + 1) {
      const e = parseLine(buf.toString("utf8", start, end));
      total = isBoundary(e) ? 0 : total + entryBytes(e);
    }
  });
  return { offset, bytes: total };
}

const cacheFile = (dir, transcriptPath) =>
  join(dir, createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16) + ".json");

// Whether dir is a real folder (not a link) that this account owns and no other
// account can write to. Windows has no uid and gives each account its own temp.
function ownedDir(dir) {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && (UID === null || (st.uid === UID && (st.mode & 0o022) === 0));
  } catch {
    return false;
  }
}

const loadCache = (file) => {
  if (!ownedDir(dirname(file))) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// Write then rename, so a render running at the same time never reads half a
// file. The temp file is created fresh ("wx"), never written through whatever
// already sits at its name.
function saveCache(file, state) {
  try {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!ownedDir(dir)) return; // a folder this account does not control: no cache
    const tmp = `${file}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* the cache only saves time; the estimate stands without it */
  }
}

/**
 * Deletes the estimate cache at dir, but only a folder this account controls:
 * one another account created first is left alone, as it was never used.
 */
export function clearCache(dir = CACHE_DIR) {
  if (ownedDir(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Estimated request payload, in bytes, of the session whose transcript is at
 * transcriptPath. Throws when the transcript cannot be read.
 */
export function estimatePayloadBytes(transcriptPath, cacheDir = CACHE_DIR) {
  const fd = openSync(transcriptPath, "r");
  try {
    const { size, ino } = fstatSync(fd);
    const file = cacheFile(cacheDir, transcriptPath);
    const c = loadCache(file);
    // Resume only a cache of these rules, for this file, which has not shrunk since.
    const resume = c?.v === CACHE_VERSION && c.path === transcriptPath && c.ino === ino && c.offset <= size;
    const state = resume
      ? c
      : { v: CACHE_VERSION, path: transcriptPath, ino, offset: lastBoundaryEnd(fd, size), bytes: 0 };
    const next = { ...state, ...sumEntries(fd, state.offset, size, state.bytes) };
    if (!resume || next.offset !== state.offset) saveCache(file, next);
    return next.bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * The HUD segment, "payload:28%/9.0MB" (share of the 32MB limit / size), in the
 * 5h/wk layout the wrapper colors like ctx; "" below 8MB.
 */
export function payloadSegment(bytes) {
  if (!(bytes >= SHOW_FROM_BYTES)) return "";
  const pct = Math.floor((bytes / REQUEST_LIMIT_BYTES) * 100);
  return `payload:${pct}%/${(bytes / MB).toFixed(1)}MB`;
}
