/**
 * marker-block: puts one marked block of lines into a text file, replaces it or takes it out, and leaves every
 * byte outside the block as it was.
 *
 * The canonical copy is skills/init-dir/scripts/marker-block.mjs. tune-tmux and git-init carry byte-identical
 * copies, since Codex installs every skill folder on its own; scripts/sync-adapter.js mirrors and checks them.
 * Edit the canonical copy only.
 *
 * Policy (one place for every skill that edits a user's file):
 * - Markers are whole lines `<open> <id>:start <close>` and `<open> <id>:end <close>`, with the comment syntax
 *   given (`#` or `<!-- -->`). A marker inside a sentence, an unpaired marker, an end before a start or a second
 *   block is refused: nothing is cut on a guess.
 * - Bytes outside the block stay as they were. CRLF files get CRLF blocks, a byte order mark stays in front.
 *   A file that is not UTF-8 is refused.
 * - A folder, FIFO, socket or device at the name is refused without being read.
 * - A symbolic link is refused (refused: "symlink") unless followSymlink is set; then the file it leads to is
 *   written and the link stays a link. A link to nothing is refused either way ("dangling").
 * - A file with two or more hard links is refused ("hardlink"): the rename below would split them.
 * - A file owned by another user is refused ("owner"). The permission bits of the file carry over to the new
 *   file. Windows has no owner or permission bits to check.
 * - Writes go to a temp file in the same folder and a rename. A failed write removes the temp file.
 * - When the bytes change, the first original is kept in `<file>.<skill>.bak`; an existing backup is never
 *   overwritten. Something else at that name (a link, a folder) refuses the change (backup), so no original is lost.
 *
 * Results are { ok, changed, refused?, message, path, file }. Callers map refused to exit status 1.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Comment syntaxes. */
export const HTML = Object.freeze({ open: "<!--", close: "-->" });
export const HASH = Object.freeze({ open: "#", close: "" });

const BOM = "\u{FEFF}";
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_BYTES = 32 * 1024 * 1024;
const NEW_FILE_MODE = 0o644;
const BACKUP_MODE = 0o600;

/** The start and end marker lines for id in a comment syntax. */
export function markers(comment, id) {
  const tail = comment.close ? ` ${comment.close}` : "";
  return { start: `${comment.open} ${id}:start${tail}`, end: `${comment.open} ${id}:end${tail}` };
}

const refusal = (code, message, path) => ({ ok: false, changed: false, refused: code, message, path });
const bare = (line) => line.replace(/\r?\n$/, "").replace(/[ \t]+$/, "");
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const readlinkOr = (path) => {
  try {
    return readlinkSync(path);
  } catch {
    return "?";
  }
};
const nativeReal = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};
const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// Where the bytes live: the path itself, or with followSymlink the file a link leads to.
function locate(path, follow) {
  const lst = lstatSync(path, { throwIfNoEntry: false });
  if (!lst) return { file: path, exists: false };
  if (!lst.isSymbolicLink()) return { file: path, exists: true };
  const target = readlinkOr(path);
  if (!follow) return { refuse: refusal("symlink", `심볼릭 링크라 그대로 둠: ${path} -> ${target}`, path) };
  const real = realOrNull(path);
  if (real === null) return { refuse: refusal("dangling", `끊어진 링크라 그대로 둠: ${path} -> ${target}`, path) };
  return { file: real, exists: true, link: path };
}

// Why the file at file may not be read or replaced, or null.
function fileProblem(st, file, uid) {
  if (!st.isFile()) return refusal("special", `일반 파일이 아니라 그대로 둠: ${file}`, file);
  if (st.nlink > 1) return refusal("hardlink", `하드 링크가 ${st.nlink}개라 그대로 둠: ${file}`, file);
  if (uid !== undefined && st.uid !== uid) return refusal("owner", `다른 사용자 소유라 그대로 둠: ${file}`, file);
  if (st.size > MAX_BYTES) return refusal("too-big", `32MiB 보다 커서 그대로 둠: ${file}`, file);
  return null;
}

// The file's stat and bytes, opened without blocking so a FIFO planted after the look never waits. id: the same
// file's bigint stat for telling files apart (an NTFS file id passes 2^53, so as a Number two files can share one).
function readChecked(file, uid) {
  const first = statSync(file);
  const problem = fileProblem(first, file, uid);
  if (problem) return { refuse: problem };
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    const late = fileProblem(st, file, uid);
    return late ? { refuse: late } : { st, id: fstatSync(fd, { bigint: true }), bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

// What one line is: "start", "end", "inline" (a marker inside other text) or null.
function kindOf(line, mk) {
  const b = bare(line);
  if (b === mk.start) return "start";
  if (b === mk.end) return "end";
  return line.includes(mk.start) || line.includes(mk.end) ? "inline" : null;
}

// Takes line i of kind into state; returns why the markers are broken, or null.
function step(state, kind, i) {
  if (kind === "inline") return `문장 안에 표지가 있음(${i + 1}행)`;
  if (kind === "start") {
    if (state.open !== -1 || state.found) return `표지 짝이 맞지 않거나 블록이 둘 이상(${i + 1}행)`;
    state.open = i;
  } else if (kind === "end") {
    if (state.open === -1) return `끝 표지가 시작 표지보다 먼저(${i + 1}행)`;
    state.found = { first: state.open, last: i };
    state.open = -1;
  }
  return null;
}

/** The block's first and last line in lines, null when there is none, or { error } when markers are broken. */
export function findBlock(lines, mk) {
  const state = { open: -1, found: null };
  for (let i = 0; i < lines.length; i++) {
    const error = step(state, kindOf(lines[i], mk), i);
    if (error) return { error };
  }
  if (state.open !== -1) return { error: `짝 없는 시작 표지(${state.open + 1}행)` };
  return state.found;
}

// Whether line i sits inside an open wrap region (more wrap opens than closes before it).
function insideWrap(lines, i, wrap) {
  let depth = 0;
  for (let j = 0; j < i; j++) {
    const b = bare(lines[j]);
    if (b === wrap.open) depth++;
    else if (b === wrap.close && depth > 0) depth--;
  }
  return depth > 0;
}

// The span [first, last] widened to wrap lines directly around it, and whether new text must bring its own wrap.
function spanOf(lines, found, wrap) {
  if (!wrap) return { ...found, wrapNew: false };
  const wrapped = found.first > 0 && bare(lines[found.first - 1]) === wrap.open && bare(lines[found.last + 1] ?? "") === wrap.close;
  if (wrapped) return { first: found.first - 1, last: found.last + 1, wrapNew: true };
  return { ...found, wrapNew: !insideWrap(lines, found.first, wrap) };
}

const blockText = (mk, body, wrap, eol) => {
  const inner = [mk.start, ...body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"), mk.end];
  return [...(wrap ? [wrap.open, ...inner, wrap.close] : inner), ""].join(eol);
};

// The text with the block put in, replaced or (body null) taken out. Appending puts one line break between the
// text and the block; taking a block out at the end of the file takes that break back, so add then remove gives
// the bytes from before.
function render(text, found, o) {
  const lines = text.split(/(?<=\n)/);
  const eol = eolOf(text);
  if (!found) {
    if (o.body === null) return text;
    return text === "" ? blockText(o.mk, o.body, o.wrap, eol) : text + eol + blockText(o.mk, o.body, o.wrap, eol);
  }
  const span = spanOf(lines, found, o.wrap);
  const before = lines.slice(0, span.first).join("");
  const after = lines.slice(span.last + 1).join("");
  if (o.body !== null) return before + blockText(o.mk, o.body, span.wrapNew ? o.wrap : null, eol) + after;
  return after === "" ? before.replace(/\r?\n$/, "") : before + after;
}

function checkBody(o) {
  if (o.body === null) return;
  const forbidden = [o.mk.start, o.mk.end, ...(o.wrap ? [o.wrap.open, o.wrap.close] : [])];
  if (o.body.split(/\r?\n/).some((line) => forbidden.includes(bare(line)))) throw new Error("block body holds a marker line");
}

// The new bytes for the old ones, or { refuse } when the old ones may not be edited.
function nextBytes(bytes, o, file) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { refuse: refusal("encoding", `UTF-8 이 아니라 그대로 둠: ${file}`, file) };
  }
  const bom = text.startsWith(BOM) ? BOM : "";
  const plain = text.slice(bom.length);
  const found = findBlock(plain.split(/(?<=\n)/), o.mk);
  if (found?.error) return { refuse: refusal("markers", `표지 손상이라 그대로 둠: ${file}: ${found.error}`, file) };
  return { bytes: Buffer.from(bom + render(plain, found, o), "utf8") };
}

const options = (opts) => ({
  mk: markers(opts.comment, opts.id),
  body: opts.body ?? null,
  wrap: opts.wrap ?? null,
  skill: opts.skill,
  follow: opts.followSymlink === true,
  readOnly: opts.readOnly === true, // a plan only read (never committed): no backup spot to check
  uid: "uid" in opts ? opts.uid : process.getuid?.(),
});

// A file not there yet is named by its folder as the file system spells it (one key for a linked parent, an 8.3 name
// or the folder in another case) and its own name as given. Two names differing only in case still get two keys:
// where the file system takes them for one file, applyBlocks meets that when the second create finds the first.
const newFileKey = (file) => `path:${join(nativeReal(dirname(resolve(file))), basename(file))}`;

// The key of a file that is there now, as planBlock gives it, or null when it cannot be read.
function keyNow(file) {
  try {
    const id = statSync(file, { bigint: true });
    return id.ino === 0n ? `path:${nativeReal(file)}` : `ino:${id.dev}:${id.ino}`;
  } catch {
    return null;
  }
}

/**
 * Works out what applyBlock would write, without writing: { ok, changed, refused?, message, path, file, key,
 * before, after, mode }. key names the file (device and inode, or the path of a file not there yet).
 */
export function planBlock(path, opts) {
  const o = options(opts);
  checkBody(o);
  const at = locate(path, o.follow);
  if (at.refuse) return at.refuse;
  if (!at.exists) {
    const after = o.body === null ? null : Buffer.from(blockText(o.mk, o.body, o.wrap, "\n"), "utf8");
    return { ok: true, changed: after !== null, path, file: at.file, key: newFileKey(at.file), before: null, after, mode: NEW_FILE_MODE };
  }
  const read = readChecked(at.file, o.uid);
  if (read.refuse) return read.refuse;
  const next = nextBytes(read.bytes, o, at.file);
  if (next.refuse) return next.refuse;
  const changed = !next.bytes.equals(read.bytes);
  // A change keeps the first original in <file>.<skill>.bak: something else there (a link, a folder) is refused now,
  // in the plan, so a dry run, a status and a check say so before anything is written.
  const bakWhy = changed && !o.readOnly ? backupSpotWhy(`${at.file}.${o.skill}.bak`) : null;
  if (bakWhy) return refusal("backup", `${bakWhy}: ${at.file}.${o.skill}.bak`, path);
  // ino 0 (a file system without file ids) tells nothing apart: then the path as the file system spells it is the
  // key (realpathSync.native gives one spelling for names that differ only in case where case is ignored).
  const key = read.id.ino === 0n ? `path:${nativeReal(at.file)}` : `ino:${read.id.dev}:${read.id.ino}`;
  return { ok: true, changed, path, file: at.file, key, before: read.bytes, after: next.bytes, mode: read.st.mode & 0o7777 };
}

// Writes data to a fresh temp file beside file and renames it over file.
function writeAtomic(file, data, mode) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    fd = null;
    if (process.platform !== "win32") chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Opens a file not there yet, as "wx" does, and makes sure the name is the file made. Anything at the name, a link to
// nothing among them, is EEXIST: Windows opens "wx" through a link to nothing and makes the file it leads to (macOS
// and Linux answer EEXIST), so the name is looked at first, and a link planted between that look and the open is
// caught after it by comparing the opened file with the name; the empty file made through it is taken back.
function openFresh(path, mode) {
  if (lstatSync(path, { throwIfNoEntry: false })) throw eexist(path);
  const fd = openSync(path, "wx", mode);
  let made;
  let st;
  try {
    made = fstatSync(fd, { bigint: true });
    st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    return fd; // cannot look (ESTALE, EPERM): the file is the caller's, as a plain "wx" leaves it
  }
  if (st && !st.isSymbolicLink() && (made.ino === 0n || (st.dev === made.dev && st.ino === made.ino))) return fd;
  closeSync(fd);
  if (st?.isSymbolicLink()) takeBack(path, made);
  throw eexist(path);
}

const eexist = (path) => Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST", path });

// Removes the file an open made through the link at path, while it is still that empty file.
function takeBack(path, made) {
  try {
    const target = realpathSync(path);
    const st = statSync(target, { bigint: true });
    if (st.dev === made.dev && st.ino === made.ino && st.size === 0n) rmSync(target, { force: true });
  } catch {
    // the link changed again: nothing of ours to find
  }
}

// Writes bytes to a file not there yet (openFresh) and closes it. A write that fails takes the empty file away again
// while the name is still that file, so no empty file stands for a first original later.
function writeFresh(path, bytes, mode) {
  const fd = openFresh(path, mode);
  try {
    writeFileSync(fd, bytes);
  } catch (e) {
    try {
      const made = fstatSync(fd, { bigint: true });
      const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (st && st.isFile() && st.dev === made.dev && st.ino === made.ino) rmSync(path, { force: true });
    } catch {
      // cannot tell the name is still that file: it stays, and the write's own error is what is reported
    }
    throw e;
  } finally {
    closeSync(fd);
  }
}

// Why the backup spot cannot take the first original, or null: something that is not a regular file there, or a look
// that fails (EPERM on Windows for a .bak being deleted, and the like).
function backupSpotWhy(bak) {
  try {
    const st = lstatSync(bak, { throwIfNoEntry: false });
    return st && !st.isFile() ? "백업 자리에 일반 파일이 아닌 것이 있어 그대로 둠" : null;
  } catch (e) {
    return `백업 자리를 확인하지 못해 그대로 둠(${e.code || e.message})`;
  }
}

// Keeps the first original: writes <file>.<skill>.bak only when nothing is at that name yet. { bak } (null when a
// regular file there is the first original already), or { refuse } when something else is there (a link, a folder):
// then the file is not changed, as its original would have nowhere to go.
function backup(file, skill, bytes) {
  const bak = `${file}.${skill}.bak`;
  const there = (st) => (st.isFile() ? { bak: null } : { refuse: refusal("backup", `백업 자리에 일반 파일이 아닌 것이 있어 그대로 둠: ${bak}`, file) });
  const st = lstatSync(bak, { throwIfNoEntry: false });
  if (st) return there(st);
  try {
    writeFresh(bak, bytes, BACKUP_MODE);
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const now = lstatSync(bak, { throwIfNoEntry: false }); // made since the look
    return now ? there(now) : { refuse: refusal("backup", `백업을 만들지 못해 그대로 둠: ${bak}`, file) };
  }
  return { bak };
}

/**
 * Writes what planBlock worked out. A plan that changes nothing or was refused is returned as a result. A file planned
 * as new that is there by the write (made or linked since the plan) is not touched: the result is a refusal with
 * raced: true, which applyBlocks answers by planning that file again.
 */
export function commitBlock(plan, skill) {
  if (!plan.ok) return plan;
  const result = { ok: true, changed: plan.changed, path: plan.path, file: plan.file };
  if (!plan.changed) return { ...result, message: `변경 없음: ${plan.path}` };
  if (plan.before === null && plan.after !== null) {
    try {
      writeFresh(plan.file, plan.after, plan.mode);
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      return { ...refusal("raced", `계획한 뒤 그 이름에 파일이나 링크가 생겨 그대로 둠: ${plan.path}`, plan.path), raced: true };
    }
    return { ...result, created: true, message: `새로 만듦: ${plan.path}` };
  }
  const kept = backup(plan.file, skill, plan.before);
  if (kept.refuse) return kept.refuse;
  writeAtomic(plan.file, plan.after, plan.mode);
  return { ...result, backup: kept.bak, message: `바꿈: ${plan.path}` };
}

/** Puts in, replaces or (body null) takes out the block in one file. dryRun plans only. */
export function applyBlock(path, opts) {
  const plan = planBlock(path, opts);
  if (opts.dryRun || !plan.ok) return plan;
  return commitBlock(plan, opts.skill);
}

/**
 * Applies blocks to several files, each entry { path, ...opts }. Every file is planned first: one refusal and
 * none is written. Two entries naming one file (after links are followed) write it once, by the first entry.
 * A file that changes between the plans and the writes (raced) is planned again; a refusal then comes back as
 * { ok: false, partial: true }, the entries before it being written already.
 */
export function applyBlocks(entries, { dryRun = false } = {}) {
  const plans = entries.map((e) => ({ entry: e, plan: planBlock(e.path, e) }));
  const refused = plans.filter((p) => !p.plan.ok).map((p) => p.plan);
  if (refused.length > 0) return { ok: false, refused, results: plans.map((p) => p.plan) };
  const seen = new Map();
  const once = (plan) => ({ ok: true, changed: false, path: plan.path, file: plan.file, sameAs: seen.get(plan.key), message: `같은 파일이라 한 번만 씀: ${plan.path}` });
  const write = (entry, plan) => {
    const done = dryRun ? plan : commitBlock(plan, entry.skill);
    if (!done.ok) return done;
    seen.set(plan.key, plan.path);
    const now = done.created ? keyNow(plan.file) : null; // a file made now is that file to later spellings too
    if (now && !seen.has(now)) seen.set(now, plan.path);
    return done;
  };
  const results = plans.map(({ entry, plan }) => {
    if (seen.has(plan.key)) return once(plan);
    const done = write(entry, plan);
    if (!done.raced) return done;
    // Made since the plan: by an earlier entry under another spelling (a case-insensitive file system), or by another
    // program. Plan it again as what is there now.
    const again = planBlock(entry.path, entry);
    if (!again.ok) return again;
    return seen.has(again.key) ? once(again) : write(entry, again);
  });
  const late = results.filter((r) => r.ok === false);
  return late.length > 0 ? { ok: false, partial: true, refused: late, results } : { ok: true, refused: [], results };
}
