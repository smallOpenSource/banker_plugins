/**
 * instruction-toggle: puts one set of agent instructions where Claude Code and
 * Codex load them at every session start, and takes it out again.
 *
 * banker's tone-compact and anti-drm share this module. Each skill folder holds
 * a byte-identical copy, since Codex installs every skill folder on its own and
 * one skill cannot import from another. tone-compact's copy is the source:
 * `node scripts/sync-adapter.js` mirrors it, and the smoke test and anti-drm's
 * tests compare the two.
 *
 * Claude Code loads every rules file under <config>/rules/ (<config> is
 * $CLAUDE_CONFIG_DIR or ~/.claude) at session start and again after compaction.
 * turnOn writes banker-<slug>.md there and turnOff deletes it. A file at that
 * name that does not start with banker's mark belongs to someone else and is
 * left alone.
 *
 * Codex reads $CODEX_HOME/AGENTS.override.md when it holds any non-whitespace
 * text and $CODEX_HOME/AGENTS.md otherwise (CODEX_HOME defaults to ~/.codex).
 * turnOn adds one marked block at the end of AGENTS.md, or of the override when
 * the override has text of its own. No banker block counts as the override's
 * own text: banker's blocks alone there would hide AGENTS.md. When other
 * banker blocks alone fill the override, Codex reads only them; turnOn and the
 * status line say so, and those skills' turnOn moves them out. turnOff takes
 * the block out and gives back the bytes from before.
 *
 * The block sits inside OMX's USER:OMX:POLICY markers, the only part of a
 * generated AGENTS.md that `omx setup --merge-agents` carries over; a plain
 * `omx setup` with team mode on only refreshes the model table. `omx setup
 * --force`, confirming its overwrite prompt, or a plain `omx setup` with team
 * mode off replaces the file block and all; turnOn then has to run again. Text
 * other tools keep in these files is left alone, and the bytes from before each
 * change are kept in <file>.<slug>.bak. Markers count only as whole lines that
 * open and close in turn; a marker quoted inside a sentence, or an end before a
 * start, makes turnOn and turnOff refuse rather than guess where the block ends.
 * So does a file that is not UTF-8 (CP949, UTF-16): written back as text it
 * would lose its bytes. A folder or FIFO at a file's name is never read: a
 * FIFO would make the read wait forever. Nor is a socket or a link loop; and an
 * AGENTS.md that is a link to nothing is refused by turnOn, which would
 * otherwise create the file the link points at.
 *
 * Codex's files are read and written under a lock file (.banker-agents.lock in
 * the Codex folder), so both skills turned on at once keep both blocks; a lock
 * older than a minute is taken over.
 *
 * Results are { ok, message }; ok false means refused with nothing changed, or,
 * when a change of two files was refused at the second, with the first changed
 * and named in the message ("앞서 바꾼 파일").
 * Anything else that goes wrong throws.
 */
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** The banker skills that keep a block in Codex's instructions files. */
export const BANKER_SLUGS = ["tone-compact", "anti-drm"];
export const RUNTIMES = ["claude", "codex"];
// OMX keeps only these regions when `omx setup` rewrites a generated AGENTS.md.
export const KEEP_OPEN = "<!-- USER:OMX:POLICY:START -->";
export const KEEP_CLOSE = "<!-- USER:OMX:POLICY:END -->";

// The byte order mark an editor may put in front of a file.
const BOM = String.fromCharCode(0xfeff);
/** The text without the byte order mark an editor may put in front of it. */
export const noBom = (text) => (text.startsWith(BOM) ? text.slice(BOM.length) : text);
/** The text with CRLF line ends turned into LF. */
export const lf = (text) => text.replace(/\r\n/g, "\n");
/** How many times needle occurs in text. */
export const count = (text, needle) => text.split(needle).length - 1;
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// What sits at a name that is not a regular file: a folder, a FIFO, a socket, a device or a link loop.
// It is never read; reading a FIFO waits for a writer.
const SPECIAL = Object.freeze({ bytes: null, text: null, special: true });
// What sits at a name that is a link to nothing: Codex finds no file there, and writing would follow the link.
const DANGLING = Object.freeze({ bytes: null, text: null, dangling: true });
// An instructions file past this is no file of hand-written instructions: it is not read, so no .bak doubles it and a
// file past what Node reads at once (2 GiB) is a refusal, not a crash.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TOO_BIG = Object.freeze({ bytes: null, text: null, tooBig: true });
// What opening a name fails with when no regular file can be there: links that loop (ELOOP) or a socket (ENXIO,
// EOPNOTSUPP). macOS answers a socket with errno 102, which Node 22 does not name ("Unknown system error -102"), so
// the kind of what is there decides too.
const NOT_A_FILE = new Set(["ELOOP", "ENXIO", "EOPNOTSUPP"]);
// Whether path leads to something that is there and is no regular file: a folder, a socket, a FIFO or a device.
const notAFile = (path) => {
  try {
    return !statSync(path).isFile();
  } catch {
    return false;
  }
};

// What a failed open of path means: null for nothing there, DANGLING for a link to nothing, SPECIAL for a folder,
// a socket or a link loop. Any other failure (permissions) is not "missing" and propagates.
function openFailure(path, e) {
  if (e.code === "ENOENT" || e.code === "ENOTDIR") return isLink(path) ? DANGLING : null;
  if (e.code === "EISDIR" || NOT_A_FILE.has(e.code) || notAFile(path)) return SPECIAL;
  throw e;
}

// A file's bytes and text, null when there is no such file. text is null when
// the bytes are not UTF-8, which callers refuse: decoding them would replace
// them with U+FFFD for good. A folder, a socket, a link loop or anything but a
// regular file is SPECIAL, and a link to nothing is DANGLING: the name is
// opened without blocking and not read.
function readFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    return openFailure(path, e);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return SPECIAL;
    if (st.size > MAX_FILE_BYTES) return TOO_BIG;
    const bytes = readFileSync(fd);
    try {
      return { bytes, text: UTF8.decode(bytes) };
    } catch {
      return { bytes, text: null };
    }
  } finally {
    closeSync(fd);
  }
}

/** A result that did, or found already done, what was asked. */
export const done = (message) => ({ ok: true, message });
/** A result that refused and changed nothing, unless its message names a file changed before (applied). */
export const refuse = (message) => ({ ok: false, message });

/** A skill's marks: the first line of its rules file, and the lines around its Codex block. */
export function markersOf(slug) {
  return { ownerMark: `<!-- banker ${slug}`, open: `<!-- banker:${slug}:start -->`, close: `<!-- banker:${slug}:end -->` };
}

/**
 * What one skill's toggle needs: its slug and marks, the first line of its
 * rules file, and two texts it words its own way: the status of rules that
 * differ from the ones given (staleText), and what turnOn says when it replaced
 * them (updatedText).
 */
export function toggleSpec({ slug, staleText, updatedText }) {
  const marks = markersOf(slug);
  const header = `${marks.ownerMark}: banker 가 관리하는 파일입니다. 끄려면 ${slug} 에 off 를 실행하세요. -->`;
  return { slug, ...marks, header, staleText, updatedText };
}

/**
 * Replaces file through a fresh temp file ("wx") and a rename: a link planted
 * at either name is replaced rather than written through, and a write that
 * fails leaves the old file as it was.
 */
export function writeFresh(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, data, { flag: "wx", mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Whether an error is about permissions or a read-only file system. */
export const denied = (e) => e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS";

/**
 * A path or an error text as a message shows it. Control, format, line and
 * paragraph separator, private-use, unassigned and variation selector
 * characters become "?": a path from the environment cannot start a line of
 * its own, reorder the text around it, or hide text after a visible letter.
 * So do letters that print as nothing (default-ignorable ones such as U+3164),
 * the braille blank and spaces other than the ASCII one, which hide text as blanks.
 */
// Marks drawn over or around the letter before them (a stroke, a slash, a ring), which make a name look like another.
// U+0338 stays after a sign it makes another of in a decomposed name (= and U+0338 are ≠ in NFD, as macOS may keep it).
const OVERLAY = /[\p{Me}\u{0334}-\u{0337}\u{20d2}\u{20d3}\u{20d8}-\u{20da}\u{20e5}\u{20e6}\u{20ea}\u{20eb}]|(?<![<=>\u{2190}\u{2192}\u{2194}\u{21d0}\u{21d2}\u{21d4}\u{2203}\u{2208}\u{220b}\u{2223}\u{2225}\u{223c}\u{2243}\u{2245}\u{2248}\u{224d}\u{2261}\u{2264}\u{2265}\u{2272}\u{2273}\u{2276}\u{2277}\u{227a}-\u{227d}\u{2282}\u{2283}\u{2286}\u{2287}\u{2291}\u{2292}\u{22a2}\u{22a8}\u{22a9}\u{22ab}\u{22b2}-\u{22b5}\u{2add}])\u{0338}/gu;

export const where = (value) =>
  String(value).replace(OVERLAY, "?").replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}\u{2800}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}]/gu,
    "?",
  );

// ---- Claude Code: one rules file that is banker's alone ----

const claudeFile = (t, o) => join(o.claudeDir, "rules", `banker-${t.slug}.md`);
const claudeText = (t, rules) => `${t.header}\n${rules}\n`;

// "off", "foreign" (not banker's file), or, when rules are given, "on" or
// "stale" (other rules); without rules a banker file is "ours".
function claudeState(t, file, rules) {
  if (file === null || file.dangling) return "off";
  if (file.text === null) return "foreign";
  const body = lf(noBom(file.text));
  if (!body.startsWith(t.ownerMark)) return "foreign";
  if (rules === undefined) return "ours";
  return body === claudeText(t, rules) ? "on" : "stale";
}

function claudeOn(t, o, getRules) {
  const file = claudeFile(t, o);
  const shown = where(file);
  if (!isDir(o.claudeDir)) return refuse(`Claude Code 설정 폴더가 없습니다: ${where(o.claudeDir)}`);
  const rules = getRules();
  const state = claudeState(t, readFile(file), rules);
  if (state === "foreign") return refuse(`같은 이름의 다른 파일이 있어 그대로 두었습니다: ${shown}`);
  if (state === "on") return done(`Claude Code: 이미 켜져 있습니다 (변경 없음). ${shown}`);
  const wasLink = isLink(file);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
    writeFresh(file, claudeText(t, rules));
  } catch (e) {
    if (denied(e)) return refuse(`쓸 권한이 없어 켜지 못했습니다 (${e.code}): ${shown}`);
    throw e;
  }
  const words = state === "stale" ? `Claude Code: ${t.updatedText}. ${shown}` : `Claude Code: 켰습니다. 다음 세션부터 자동 적용됩니다. ${shown}`;
  return done(wasLink ? `${words}\n${LINK_REPLACED}` : words);
}

/** The note for a name that was a link (to nothing, or to an older copy) and is now a regular file. */
export const LINK_REPLACED = "참고: 링크였던 자리를 일반 파일로 바꿨습니다. 링크가 가리키던 곳은 건드리지 않았습니다.";

function claudeOff(t, o) {
  const file = claudeFile(t, o);
  const state = claudeState(t, readFile(file));
  if (state === "off") return done("Claude Code: 이미 꺼져 있습니다 (변경 없음).");
  if (state === "foreign") return refuse(`같은 이름의 다른 파일이 있어 그대로 두었습니다: ${where(file)}`);
  try {
    rmSync(file);
  } catch (e) {
    if (denied(e)) return refuse(`지울 권한이 없어 끄지 못했습니다 (${e.code}): ${where(file)}`);
    throw e;
  }
  return done(`Claude Code: 껐습니다. 다음 세션부터 적용되지 않습니다. ${where(file)}`);
}

// ---- Codex: one block in the global instructions file Codex reads ----

const lineBare = (line) => line.replace(/\r?\n$/, "");
// A line without its line break, and the first one without the byte order mark
// an editor may put in front of it.
const bareAt = (lines, i) => (i === 0 ? noBom(lineBare(lines[i])) : lineBare(lines[i]));

// One block's place in the text: [from, to) runs from its first line (the keep
// marker when one wraps it directly) through the end of its last line; cut is
// from minus the line break `on` puts before the block, and blankBefore says
// whether that break makes a blank line of its own.
function spanOf(lines, offsets, first, last) {
  const wrapped =
    first > 0 &&
    last + 1 < lines.length &&
    bareAt(lines, first - 1) === KEEP_OPEN &&
    bareAt(lines, last + 1) === KEEP_CLOSE;
  const top = wrapped ? first - 1 : first;
  const bottom = wrapped ? last + 1 : last;
  const before = top > 0 ? lines[top - 1] : "";
  const joint = before.endsWith("\r\n") ? 2 : before.endsWith("\n") ? 1 : 0;
  const blankBefore = before !== "" && lineBare(before) === "";
  return { cut: offsets[top] - joint, from: offsets[top], to: offsets[bottom] + lines[bottom].length, blankBefore };
}

// Where each line starts in the text.
function lineOffsets(lines) {
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length;
  }
  return offsets;
}

// Any management marker, a banker block's or OMX's, anywhere on a line.
const ANY_MARKER = /<!-- (?:banker:[a-z0-9-]+:(?:start|end)|USER:OMX:POLICY:(?:START|END)) -->/;

/**
 * Whether text quotes any management marker. Rules must not: a block holding
 * one would be refused as soon as it is written, and could never come out.
 */
export const hasMarker = (text) => ANY_MARKER.test(text);
// Whether a marker sits between a block's first and last line: then its end was
// moved, by hand or by an editor, and cutting to it would take other text along.
const markerInside = (lines, first, last) => lines.slice(first + 1, last).some((line) => ANY_MARKER.test(line));

/**
 * Where the blocks between whole lines `open` and `close` sit in text, or null
 * when those markers are not whole lines that open and close in turn, or when
 * another management marker sits inside a block. turnOn and turnOff refuse
 * null, so a marker quoted inside a sentence, or an end put back by hand around
 * other text, can never make them cut the user's own text.
 */
export function blockSpansOf(text, open, close) {
  const lines = text.split(/(?<=\n)/);
  const offsets = lineOffsets(lines);
  const spans = [];
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    const bare = bareAt(lines, i);
    if (bare === open && first === -1) first = i;
    else if (bare === close && first !== -1) {
      if (markerInside(lines, first, i)) return null;
      spans.push(spanOf(lines, offsets, first, i));
      first = -1;
    } else if (lines[i].includes(open) || lines[i].includes(close)) return null;
  }
  return first === -1 ? spans : null;
}

// A block, banker's or any USER:OMX:POLICY one, right after a line break.
const BLOCK_NEXT = /^\r?\n(?:<!-- USER:OMX:POLICY:START -->|<!-- banker:)/;

// The text without its blocks: exactly what it was before `on` added them. The
// line break `on` put in front goes with the block when the block ends the file
// or has a blank line of its own in front; with other text after it, the break
// stays, so the lines on either side never run together. When another block
// follows, its own leading break keeps the lines apart, so this one goes too:
// two blocks taken out in the order they went in then leave a text that had no
// final line break as it was.
function strip(text, spans) {
  let out = "";
  let at = 0;
  for (const s of spans) {
    const keepBreak = s.to < text.length && !s.blankBefore && !BLOCK_NEXT.test(text.slice(s.to));
    out += text.slice(at, keepBreak ? s.from : s.cut);
    at = s.to;
  }
  return out + text.slice(at);
}

// Whether text holds anything but whitespace, the way Codex judges a file empty:
// Rust's trim, which strips the Unicode White_Space set and, unlike
// JavaScript's trim, keeps a byte order mark.
const hasContent = (text) => /\P{White_Space}/u.test(text);

// The text without any banker skill's blocks. A skill whose markers do not pair
// up keeps its text, which then counts as content: nothing is cut on a guess.
function withoutBankerBlocks(text) {
  return BANKER_SLUGS.reduce((out, slug) => {
    const { open, close } = markersOf(slug);
    const spans = blockSpansOf(out, open, close);
    return spans === null ? out : strip(out, spans);
  }, text);
}

// The banker skills other than t with a block in text.
const otherBlocks = (t, text) =>
  BANKER_SLUGS.filter((slug) => {
    if (slug === t.slug) return false;
    const { open, close } = markersOf(slug);
    const spans = blockSpansOf(text, open, close);
    return spans !== null && spans.length > 0;
  });

const special = (f) => f.special === true;
const tooBig = (f) => f.tooBig === true;
const binary = (f) => f.bytes !== null && f.text === null;
const unpaired = (f) => f.spans === null;
const hasBlock = (f) => f.spans !== null && f.spans.length > 0;
const stripped = (f) => (f.text === null ? "" : strip(f.text, f.spans));

/** Whether two bigint stats name one file: one device and one inode, where the file system gives inodes at all. */
export const sameInode = (x, y) => x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;

// Whether two paths name one file: a link (both resolve to one real path) or a hard link (one inode). A file system
// that gives no inode numbers (0) cannot say so for hard links, so those count as two files.
function sameFile(a, b) {
  try {
    if (realpathSync(a) === realpathSync(b)) return true;
    return sameInode(statSync(a, { bigint: true }), statSync(b, { bigint: true }));
  } catch {
    return false;
  }
}

// Both global instruction files with their bytes and text (null when absent;
// text null when not UTF-8) and blocks (null when the markers do not pair up).
// The block's place (target) is the override when the override has text of its
// own, AGENTS.md otherwise. shadowers names the other banker skills whose
// blocks alone fill the override: Codex then reads the override, not AGENTS.md.
// An override that is a link or a hard link to AGENTS.md is one file with it.
function codexFiles(t, o) {
  const read = (name) => {
    const path = join(o.codexDir, name);
    const file = readFile(path);
    if (file === null || file.special || file.dangling || file.tooBig) {
      return { path, bytes: null, text: null, spans: [], special: file?.special === true, dangling: file?.dangling === true, tooBig: file?.tooBig === true };
    }
    return { path, ...file, spans: file.text === null ? null : blockSpansOf(file.text, t.open, t.close) };
  };
  const override = read("AGENTS.override.md");
  const main = read("AGENTS.md");
  if (override.bytes !== null && main.bytes !== null && sameFile(override.path, main.path)) {
    // One file under both names: Codex reads it either way, so it is AGENTS.md alone.
    const none = { path: override.path, bytes: null, text: null, spans: [] };
    return { target: main, other: none, all: [none, main], shadowers: [] };
  }
  const ownContent = binary(override) || (override.text !== null && hasContent(withoutBankerBlocks(override.text)));
  const target = ownContent ? override : main;
  const shadowers = ownContent || override.text === null ? [] : otherBlocks(t, override.text);
  return { target, other: target === override ? main : override, all: [override, main], shadowers };
}

const blockFor = (t, rules, eol) => [KEEP_OPEN, t.open, ...rules.split("\n"), t.close, KEEP_CLOSE, ""].join(eol);
// A block's text compared without line-break style, a leading byte order mark
// or the final line break, which editors add and drop.
const normBlock = (text) => noBom(lf(text)).replace(/\n$/, "");
// The block exactly as `on` writes it, and only once.
const blockCurrent = (t, f, rules) =>
  f.spans.length === 1 && normBlock(f.text.slice(f.spans[0].from, f.spans[0].to)) === normBlock(blockFor(t, rules, "\n"));

// The text with the block at the end, one line break between them; an empty
// file gets the block alone. strip() undoes exactly this.
function withBlock(t, text, rules) {
  const eol = eolOf(text);
  return text === "" ? blockFor(t, rules, eol) : text + eol + blockFor(t, rules, eol);
}

// The state when the block is not in its place: "hidden" (only in an override with no text of its own),
// "hiddenbroken" (the same, with AGENTS.md a link to nothing, so on cannot move it), "misplaced" (only in AGENTS.md
// while Codex reads the override), "dangling" (nowhere, and AGENTS.md is a link to nothing that on must not write
// through) or "off".
function placeState(files) {
  if (hasBlock(files.other)) {
    if (files.other !== files.all[0]) return "misplaced";
    return files.target.dangling ? "hiddenbroken" : "hidden";
  }
  return files.target.dangling ? "dangling" : "off";
}

// "off", "on", "stale", "misplaced" (only in AGENTS.md while Codex reads the
// override, so not applied), "hidden" (in the override with no text of its own,
// applied but hiding AGENTS.md), "dangling" (nowhere, and AGENTS.md is a link to
// nothing), "unpaired", "notutf8", "toobig" (a file past 32 MiB, left unread) or
// "notregular" (a folder, FIFO, socket or link loop at a file's name). Without
// rules any block in its place counts as "on".
function codexState(t, files, rules) {
  if (files.all.some(special)) return "notregular";
  if (files.all.some(tooBig)) return "toobig";
  if (files.all.some(binary)) return "notutf8";
  if (files.all.some(unpaired)) return "unpaired";
  if (!hasBlock(files.target)) return placeState(files);
  if (rules === undefined) return "on";
  return blockCurrent(t, files.target, rules) && !hasBlock(files.other) ? "on" : "stale";
}

// Why these files cannot be written, or "" when they can. The folder counts
// too: the .bak is written through a temp file beside the file.
function writeBlocked(changes) {
  for (const { file } of changes) {
    for (const path of file.bytes === null ? [dirname(file.path)] : [file.path, dirname(file.path)]) {
      try {
        accessSync(path, constants.W_OK);
      } catch (e) {
        return `쓸 권한이 없어 그대로 두었습니다 (${where(e.code || e.message)}): ${where(path)}`;
      }
    }
  }
  return "";
}

// Writes each file in place, so a symlinked AGENTS.md stays a link and its
// target changes, after keeping the old bytes in a .bak only this account can
// read (the file may be a link into a private folder). A new file gets 0644
// whatever the umask allows more. A file left empty is removed, unless it is a
// link or has other names (a hard link), whose other names would keep the old
// text: it is emptied instead. Codex skips an empty file anyway.
// A file that was not there when it was read is created only if it still is not ("wx"): a name that appeared in
// between, a link planted there among them, is not written through.
function apply(t, changes) {
  for (const { file, after } of changes) {
    if (file.bytes !== null) writeFresh(`${file.path}.${t.slug}.bak`, file.bytes, 0o600);
    if (after === "" && !isLink(file.path) && !hasOtherNames(file.path)) rmSync(file.path, { force: true });
    else writeFileSync(file.path, after, { mode: 0o644, flag: file.bytes === null ? "wx" : "w" });
  }
}

// Applies the changes, or the refusal for a write that failed with nothing of the file changed: a name that
// appeared in between (EEXIST), a folder where the write goes (EISDIR; Windows answers a rename onto one with EPERM),
// or a write a sandbox refused after access() allowed it. The refusal names the place the system refused (a rename's
// target, as the backup, or the file it was about), and a file changed before the failing one. Other errors propagate.
function applied(t, changes) {
  let i = 0;
  try {
    for (; i < changes.length; i++) apply(t, [changes[i]]);
  } catch (e) {
    if (e.code !== "EEXIST" && e.code !== "EISDIR" && !denied(e)) throw e;
    const at = [e.dest, e.path].find((p) => typeof p === "string") ?? changes[i].file.path;
    const before = i === 0 ? "" : `\n앞서 바꾼 파일: ${changes.slice(0, i).map((c) => where(c.file.path)).join(", ")}`;
    return refuse(`${refusedWhy(e, at)}: ${where(at)}${before}`);
  }
  return null;
}

// Why a write applied() refuses failed: a name that appeared in between, something that is no regular file at the
// place it went (a folder), or permissions.
function refusedWhy(e, at) {
  if (e.code === "EEXIST") return "쓰는 사이에 같은 이름이 생겨 그대로 두었습니다";
  if (notAFile(at)) return "일반 파일이 아니라 그대로 두었습니다";
  return `쓸 권한이 없어 그대로 두었습니다 (${where(e.code)})`;
}

// Whether the file at path is also reachable under another name: a hard link.
function hasOtherNames(path) {
  try {
    return lstatSync(path).nlink > 1;
  } catch {
    return false;
  }
}

// The lock both banker skills take while they read and write Codex's instructions files: two on's at once would
// each write the file back with only their own block. A lock is held for milliseconds; one older than a minute was
// left by a run that died.
const LOCK = ".banker-agents.lock";
const LOCK_STALE_MS = 60_000;
const LOCK_STEP_MS = 50;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

// Makes the lock file: "taken", "held" when one is there already, or "stale" when a network share answered with a
// stale file handle (ESTALE), which the next try may not. A lock file this try made but could not write is taken
// away again while the name still holds that very file (one device and one inode), so it keeps no one waiting; "left"
// when it may still be there (no stats or no inode number to prove it is that file, or the share could not say).
// Any other error (permissions, EIO) throws, after the same taking away.
function tryLock(path, token) {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return "held";
    if (e.code === "ESTALE") return "stale";
    throw e;
  }
  const failed = writeToken(fd, token);
  if (failed === null) return "taken";
  const gone = dropMade(path, failed.made, token);
  if (failed.error.code !== "ESTALE") throw failed.error;
  return gone ? "stale" : "left";
}

// Writes the token into the lock file just made and closes it: null when both went well, else the first error and
// the file's bigint stats (null when they could not be had). A share often reports a failed write at the close.
function writeToken(fd, token) {
  let made = null;
  let error = null;
  try {
    made = fstatSync(fd, { bigint: true });
    writeFileSync(fd, token);
  } catch (e) {
    error = e;
  }
  try {
    closeSync(fd);
  } catch (e) {
    error ??= e;
  }
  return error === null ? null : { made, error };
}

// Removes the lock file a failed try made, only while the name still holds it (one device and one inode): true when
// that file is not there any more, false when it may be (the share could not say, or gives no inode number; such a
// lock goes stale in a minute).
function dropMade(path, made, token) {
  if (made === null || made.ino === 0n) return false;
  try {
    if (sameInode(made, lstatSync(path, { bigint: true })) && heldWords(path, token)) rmSync(path, { force: true });
    return true;
  } catch (e) {
    return e.code === "ENOENT";
  }
}

// Whether the lock file holds no words but a start of this run's token (none, or a write cut short): a lock another
// run made at the name in between can get the very inode number, but it holds that run's own token, so it stays.
function heldWords(path, token) {
  const text = readFile(path)?.text;
  return typeof text === "string" && token.startsWith(text);
}

// Removes a lock a dead run left. The name itself is looked at, not where it leads: a link to nothing or a link loop
// there is a lock like any other. A lock dated more than a minute away either way (a clock set back) is stale too.
// A folder there is none of this module's: it stays, and the wait ends in a refusal. A name gone in between, or a
// network share's stale file handle (ESTALE) at the look or the removal, is left for the next round.
function dropStale(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ESTALE") return;
    throw e;
  }
  if (st.isDirectory() || Math.abs(Date.now() - st.mtimeMs) <= LOCK_STALE_MS) return;
  try {
    rmSync(path, { force: true });
  } catch (e) {
    if (e.code !== "ESTALE") throw e;
  }
}

// Takes the lock: { path, token }, or { path, why } once the wait ends without it: why is "stale" when the last try
// met a stale file handle instead of a lock, or a lock this run made could not be taken away again, else "held". Every round that does not take the lock rests, so no answer
// of the file system makes the wait spin; the deadline is looked at every round, so no lock spot keeps it going past.
function takeLock(dir, waitMs) {
  const path = join(dir, LOCK);
  const token = `${process.pid} ${Date.now()} ${Math.random()}`;
  const until = Date.now() + waitMs;
  // a made lock this run could not take away again names ESTALE as the cause, not another banker run
  let left = false;
  for (;;) {
    const got = tryLock(path, token);
    if (got === "taken") return { path, token };
    left ||= got === "left";
    if (Date.now() >= until) return { path, why: left ? "stale" : got };
    if (got === "held") dropStale(path);
    Atomics.wait(SLEEP, 0, 0, LOCK_STEP_MS);
  }
}

// Gives the lock back while it is still this run's. The name is opened without blocking: a pipe put there is not
// this run's lock and stays. A network share's stale file handle (ESTALE) is tried again after a rest, three times
// at most; a lock still left goes stale in a minute.
function dropLock(lock) {
  for (let tried = 1; ; tried++) {
    try {
      if (readFile(lock.path)?.text === lock.token) rmSync(lock.path, { force: true });
      return;
    } catch (e) {
      if (e.code !== "ESTALE" || tried >= 3) return; /* already gone, or not this run's to take away */
      Atomics.wait(SLEEP, 0, 0, LOCK_STEP_MS);
    }
  }
}

// Runs fn holding the lock; a lock another run keeps past the wait is a refusal. A folder this account cannot write
// takes no lock, and nothing in it can be written either: fn then only reads, and writeBlocked refuses any change,
// so "already on" and "already off" answer as before.
function locked(o, fn) {
  let lock;
  try {
    lock = takeLock(o.codexDir, o.lockWaitMs ?? 5000);
  } catch (e) {
    if (denied(e)) return fn();
    throw e;
  }
  if (!lock.token) {
    return refuse(lock.why === "stale"
      ? `네트워크 공유가 잠금 자리에 계속 ESTALE(오래된 파일 핸들)을 돌려줘 그대로 두었습니다: ${where(lock.path)}`
      : `다른 banker 지침 작업이 끝나지 않아 그대로 두었습니다: ${where(lock.path)}`);
  }
  try {
    return fn();
  } finally {
    dropLock(lock);
  }
}

const OMX_NOTE =
  "참고: omx setup 이 AGENTS.md 를 새로 만들면(--force, 덮어쓰기 확인, team 모드를 끈 상태의 omx setup) 이 블록이 사라집니다. 그 뒤에는 on 을 다시 실행하세요. --merge-agents 와 기본 omx setup 은 블록을 남깁니다.";

// The note for a block other banker blocks keep from being read.
const shadowNote = (files) =>
  files.shadowers.length === 0
    ? ""
    : `\n주의: AGENTS.override.md 에 다른 banker 블록(${files.shadowers.join(", ")})만 있어 Codex 가 AGENTS.md 를 읽지 않습니다. 그 스킬에서 on 을 실행해 블록을 옮기세요.`;

// The file a refused state is about: the folder or FIFO, the file that is not UTF-8, or the one whose markers do
// not pair up; null in any other state.
function problemFile(files, state) {
  const which = { notregular: special, toobig: tooBig, notutf8: binary, unpaired }[state];
  return which ? files.all.find(which) : null;
}

// The refusal for files on and off must not touch, or null.
function codexRefusal(t, files, state) {
  const file = problemFile(files, state);
  if (!file) return null;
  const why = {
    notregular: "일반 파일이 아니라 그대로 두었습니다",
    toobig: "32MiB 보다 큰 파일이라 그대로 두었습니다",
    notutf8: "UTF-8 이 아닌 파일이라 그대로 두었습니다",
    unpaired: `${t.slug} 표시의 짝이 맞지 않아 그대로 두었습니다`,
  }[state];
  return refuse(`${why}: ${where(file.path)}`);
}

// What codexOn says it did. A block Codex does not read, because other banker
// blocks alone fill the override, says so in its first words.
function onWords(t, state, unread) {
  if (state === "on") return unread ? "이미 AGENTS.md 에 있지만 지금은 적용되지 않습니다 (변경 없음)" : "이미 켜져 있습니다 (변경 없음)";
  if (unread) return "AGENTS.md 에 넣었지만 지금은 적용되지 않습니다";
  const moved = "블록을 맞는 파일로 옮겼습니다";
  return { stale: t.updatedText, misplaced: moved, hidden: moved }[state] ?? "켰습니다. 다음 세션부터 자동 적용됩니다";
}

function codexOn(t, o, getRules) {
  if (!isDir(o.codexDir)) return refuse(`Codex 설정 폴더가 없습니다: ${where(o.codexDir)}`);
  return locked(o, () => codexOnHeld(t, o, getRules));
}

function codexOnHeld(t, o, getRules) {
  const rules = getRules();
  const files = codexFiles(t, o);
  const state = codexState(t, files, rules);
  const refusal = codexRefusal(t, files, state);
  if (refusal) return refusal;
  if (files.target.dangling) return refuse(`끊어진 링크라 그대로 두었습니다: ${where(files.target.path)}`);
  const words = onWords(t, state, files.shadowers.length > 0);
  const tail = `${where(files.target.path)}${shadowNote(files)}`;
  if (state === "on") return done(`Codex: ${words}. ${tail}`);
  const changes = [{ file: files.target, after: withBlock(t, stripped(files.target), rules) }];
  if (hasBlock(files.other)) changes.push({ file: files.other, after: stripped(files.other) });
  const why = writeBlocked(changes);
  if (why) return refuse(why);
  const failed = applied(t, changes);
  if (failed) return failed;
  const note = files.target === files.all[1] ? `\n${OMX_NOTE}` : "";
  return done(`Codex: ${words}. ${tail}${note}`);
}

function codexOff(t, o) {
  if (!isDir(o.codexDir)) return done(`Codex: 설정 폴더가 없어 끌 것이 없습니다 (변경 없음). ${where(o.codexDir)}`);
  return locked(o, () => codexOffHeld(t, o));
}

function codexOffHeld(t, o) {
  const files = codexFiles(t, o);
  const refusal = codexRefusal(t, files, codexState(t, files));
  if (refusal) return refusal;
  const changes = files.all.filter(hasBlock).map((f) => ({ file: f, after: stripped(f) }));
  if (changes.length === 0) return done("Codex: 이미 꺼져 있습니다 (변경 없음).");
  const why = writeBlocked(changes);
  if (why) return refuse(why);
  const failed = applied(t, changes);
  if (failed) return failed;
  const paths = changes.map((c) => where(c.file.path)).join(", ");
  const baks = changes.map((c) => where(`${c.file.path}.${t.slug}.bak`)).join(", ");
  return done(`Codex: 껐습니다. 다음 세션부터 적용되지 않습니다. ${paths}\n지우기 전 파일: ${baks}`);
}

// ---- status ----

const STATE_TEXT = {
  on: "켜짐",
  ours: "켜짐 (규칙 버전 확인 불가)",
  off: "꺼짐",
  foreign: "꺼짐, 같은 이름의 다른 파일이 있음 (손대지 않음)",
  misplaced: "꺼짐, 단 블록이 Codex 가 읽지 않는 AGENTS.md 에 있음 (on 으로 옮김)",
  hidden: "켜짐, 단 AGENTS.override.md 에 블록만 있어 AGENTS.md 가 가려짐 (on 으로 옮김)",
  hiddenbroken: "켜짐, 단 AGENTS.override.md 에 블록만 있고 AGENTS.md 가 끊어진 링크라 on 이 블록을 옮기지 못함 (링크 확인 필요)",
  notutf8: "UTF-8 이 아닌 지침 파일이 있어 손대지 않음 (on, off 모두 거부)",
  notregular: "일반 파일이 아닌 지침 파일이 있어 손대지 않음 (on, off 모두 거부)",
  toobig: "32MiB 보다 큰 지침 파일이 있어 손대지 않음 (on, off 모두 거부)",
  unpaired: "표시의 짝이 맞지 않음 (on, off 모두 거부. 남은 표시 줄 정리 필요)",
  dangling: "꺼짐, 단 AGENTS.md 가 끊어진 링크라 on 이 거부함 (링크 확인 필요)",
};

// A state as the status line says it.
function stateText(t, { state, who }) {
  if (state === "stale") return t.staleText;
  if (state === "shadowed") {
    return `꺼짐, 단 AGENTS.override.md 에 다른 banker 블록(${who.join(", ")})만 있어 Codex 가 AGENTS.md 를 읽지 않음 (그 스킬에서 on 으로 옮김)`;
  }
  return STATE_TEXT[state] ?? state;
}

// One status line. Read failures are reported, not thrown: status is where an
// exit 2 sends the user to look.
function describe(t, name, look) {
  try {
    const found = look();
    return `- ${name}: ${stateText(t, found)} (${where(found.path)})`;
  } catch (e) {
    return `- ${name}: 읽을 수 없음 (${where(e.code || e.message)})`;
  }
}

function codexLook(t, o, rules) {
  if (!isDir(o.codexDir)) return { state: "설정 폴더 없음", path: o.codexDir };
  const files = codexFiles(t, o);
  const state = codexState(t, files, rules);
  const shadowed = files.shadowers.length > 0 && (state === "on" || state === "stale");
  return { state: shadowed ? "shadowed" : state, path: (problemFile(files, state) ?? files.target).path, who: files.shadowers };
}

/** One status line per runtime: "- Claude Code: ..." and "- Codex: ...". rules may be undefined. */
export function stateLines(t, o, rules) {
  return [
    describe(t, "Claude Code", () => {
      if (!isDir(o.claudeDir)) return { state: "설정 폴더 없음", path: o.claudeDir };
      return { state: claudeState(t, readFile(claudeFile(t, o)), rules), path: claudeFile(t, o) };
    }),
    describe(t, "Codex", () => codexLook(t, o, rules)),
  ];
}

/**
 * Whether a runtime holds the skill's rules in some form (current, older, in
 * the wrong file or with broken markers), so that changed rules should reach
 * it. Throws when a file cannot be read.
 */
export function present(t, runtime, o) {
  if (runtime === "claude") return isDir(o.claudeDir) && claudeState(t, readFile(claudeFile(t, o))) === "ours";
  return isDir(o.codexDir) && !["off", "notutf8", "notregular", "toobig", "dangling"].includes(codexState(t, codexFiles(t, o)));
}

const knownRuntime = (runtime) => {
  if (!RUNTIMES.includes(runtime)) throw new Error(`알 수 없는 런타임입니다: ${runtime}`);
};

/** Puts the rules where one runtime loads them. getRules runs after the config folder check. */
export function turnOn(t, runtime, o, getRules) {
  knownRuntime(runtime);
  return runtime === "claude" ? claudeOn(t, o, getRules) : codexOn(t, o, getRules);
}

/** Takes the rules out for one runtime; it never needs them. */
export function turnOff(t, runtime, o) {
  knownRuntime(runtime);
  return runtime === "claude" ? claudeOff(t, o) : codexOff(t, o);
}
