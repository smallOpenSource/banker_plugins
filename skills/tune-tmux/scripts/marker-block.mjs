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
 *   overwritten.
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

// The file's stat and bytes, opened without blocking so a FIFO planted after the look never waits.
function readChecked(file, uid) {
  const first = statSync(file);
  const problem = fileProblem(first, file, uid);
  if (problem) return { refuse: problem };
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    const late = fileProblem(st, file, uid);
    return late ? { refuse: late } : { st, bytes: readFileSync(fd) };
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
  uid: "uid" in opts ? opts.uid : process.getuid?.(),
});

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
    return { ok: true, changed: after !== null, path, file: at.file, key: `path:${resolve(at.file)}`, before: null, after, mode: NEW_FILE_MODE };
  }
  const read = readChecked(at.file, o.uid);
  if (read.refuse) return read.refuse;
  const next = nextBytes(read.bytes, o, at.file);
  if (next.refuse) return next.refuse;
  const changed = !next.bytes.equals(read.bytes);
  const key = `ino:${read.st.dev}:${read.st.ino}`;
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

// Keeps the first original: writes <file>.<skill>.bak only when nothing is at that name yet.
function backup(file, skill, bytes) {
  const bak = `${file}.${skill}.bak`;
  if (lstatSync(bak, { throwIfNoEntry: false })) return null;
  const fd = openSync(bak, "wx", BACKUP_MODE);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return bak;
}

/** Writes what planBlock worked out. A plan that changes nothing or was refused is returned as a result. */
export function commitBlock(plan, skill) {
  if (!plan.ok) return plan;
  const result = { ok: true, changed: plan.changed, path: plan.path, file: plan.file };
  if (!plan.changed) return { ...result, message: `변경 없음: ${plan.path}` };
  if (plan.before === null && plan.after !== null) {
    const fd = openSync(plan.file, "wx", plan.mode);
    try {
      writeFileSync(fd, plan.after);
    } finally {
      closeSync(fd);
    }
    return { ...result, created: true, message: `새로 만듦: ${plan.path}` };
  }
  const bak = backup(plan.file, skill, plan.before);
  writeAtomic(plan.file, plan.after, plan.mode);
  return { ...result, backup: bak, message: `바꿈: ${plan.path}` };
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
 */
export function applyBlocks(entries, { dryRun = false } = {}) {
  const plans = entries.map((e) => ({ entry: e, plan: planBlock(e.path, e) }));
  const refused = plans.filter((p) => !p.plan.ok).map((p) => p.plan);
  if (refused.length > 0) return { ok: false, refused, results: plans.map((p) => p.plan) };
  const seen = new Map();
  const results = plans.map(({ entry, plan }) => {
    if (seen.has(plan.key)) return { ok: true, changed: false, path: plan.path, file: plan.file, sameAs: seen.get(plan.key), message: `같은 파일이라 한 번만 씀: ${plan.path}` };
    seen.set(plan.key, plan.path);
    return dryRun ? plan : commitBlock(plan, entry.skill);
  });
  return { ok: true, refused: [], results };
}
