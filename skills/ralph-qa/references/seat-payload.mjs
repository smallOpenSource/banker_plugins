/**
 * seat-payload: the review payload the ralph-qa runner (seat-run.mjs) sends to an external seat,
 * built from the repository as step 2 of the skill's "외부 좌석 전송" says, and its checks.
 *
 * The author writes two files in the payload folder <d> (with a file tool, or `seat-run put`):
 *   short.md  the fixed preamble, the opening marker <review-data id="<id>">, the user's request
 *             and the acceptance criteria
 *   spec.md   one line each, in the order the parts go out:
 *               new <file>                a new file of the change (its exact name, from the repo root)
 *               range <start> <end> <file>  lines of a tracked or listed file the verdict needs
 *               file <path>               a base or rule file; gate <path> a saved gate output
 *               review <path>             what to review outside the diff (an ignored folder, a file
 *                                         outside the repo); with one, an empty diff is no stop
 *             A relative path is from the repo root. Blank lines and # lines are skipped.
 * buildPayload writes, removing the last try's first:
 *   prompt.md  short.md, the diff with the listed new files, each part of spec.md under its own
 *              `=== ` line, and the closing marker
 *   raw.md     the diff and the parts alone (the source-independent seat's input)
 *   unsent.md  the new files left out, one per line as git lists them
 *   run.md     the id, base and repo of this prepare (send refuses a folder without it)
 * The diff comes from a copy of the real index (its staging, sparse checkout and racy entries as
 * they are, its time kept so racily clean entries stay suspect) with only the listed new files
 * added as intent-to-add. textconv, external drivers, color, submodule contents, the user's
 * context settings and fsmonitor are off; attributes are followed, and a diff with a NUL byte
 * stops. git runs by its absolute path from <d>, never from the repo. A stop is a Stop with the
 * 0.20.4 wording. The secret scan and the size are reported, not stopped on: the author masks
 * prompt.md and runs check.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scan } from "./payload-scan.mjs";
import { which } from "./seat-spawn.mjs";

export const MAX_BYTES = 524288;
const GIT_TIMEOUT_MS = 120000;
const FILE_CAP = 64 * 1024 * 1024;
const FOLD_PAST = 100;
const WIN = process.platform === "win32";
const OUTPUTS = ["prompt.md", "raw.md", "unsent.md", "run.md"];

export class Stop extends Error {
  constructor(code, message, detail = []) {
    super(`ralph-qa: ${message}`);
    this.code = code;
    this.detail = detail;
  }
}

const SAFE_ID = /^[A-Za-z0-9]{4,64}$/;
export function checkId(id) {
  if (!SAFE_ID.test(String(id))) throw new Stop("spec", `id 는 영문자와 숫자 4~64자다: ${String(id).slice(0, 80)}`);
}

// What the author wrote: a UTF-8 BOM dropped, UTF-16 with its BOM read as text.
function authorBytes(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(buf.slice(2).toString("utf16le"), "utf8");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(Buffer.from(buf.slice(2)).swap16().toString("utf16le"), "utf8");
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.slice(3) : buf;
}

const withNewline = (buf) => (buf.length && buf[buf.length - 1] !== 10 ? Buffer.concat([buf, Buffer.from("\n")]) : buf);

function readAuthor(dir, name) {
  try {
    return authorBytes(readFileSync(join(dir, name)));
  } catch (e) {
    throw new Stop(name === "spec.md" ? "spec" : "markers", `${name} 를 읽을 수 없다(${e.code || e.message})`);
  }
}

// Lines of `buf` holding the marker text of `id`, as grep -c counts them.
export function markerCount(buf, id) {
  const needle = Buffer.from(`review-data id="${id}"`);
  let n = 0;
  for (let start = 0; start <= buf.length; ) {
    const end = buf.indexOf(10, start);
    const stop = end === -1 ? buf.length : end;
    if (buf.slice(start, stop).includes(needle)) n += 1;
    if (end === -1) break;
    start = end + 1;
  }
  return n;
}

function readShort(dir, id) {
  const short = withNewline(readAuthor(dir, "short.md"));
  if (markerCount(short, id) !== 1 || !short.includes(Buffer.from(`<review-data id="${id}">`))) {
    throw new Stop("markers", `short.md 에 여는 표지 <review-data id="${id}"> 가 한 줄에 한 번만 있어야 한다`);
  }
  return short;
}

// A path from the repo root as spec.md gives it: ./ dropped, no absolute path, no .. part.
function repoPath(raw, n) {
  let p = WIN ? raw.replace(/\\/g, "/") : raw;
  while (p.startsWith("./")) p = p.slice(2);
  const bad = !p || p.includes("\0") || p.includes("\r") || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split("/").includes("..");
  if (bad) throw new Stop("spec", `spec ${n}: 저장소 루트 기준 경로가 아니다(절대 경로, .., 빈 경로): ${raw.slice(0, 200)}`);
  return p;
}

function specLine(line, n) {
  const m = /^(new|range|file|gate|review) (.+)$/.exec(line);
  if (!m) throw new Stop("spec", `spec ${n}: new, range, file, gate, review 로 시작하는 줄이 아니다: ${line.slice(0, 200)}`);
  if (m[1] === "new") return { kind: "new", path: repoPath(m[2], n), line: n };
  if (m[1] !== "range") {
    if (m[2].includes("\0")) throw new Stop("spec", `spec ${n}: 경로에 NUL 이 있다`);
    return { kind: m[1], path: m[2], line: n };
  }
  const r = /^(\d{1,9}) (\d{1,9}) (.+)$/.exec(m[2]);
  if (!r) throw new Stop("spec", `spec ${n}: range <시작> <끝> <파일> 꼴이 아니다: ${line.slice(0, 200)}`);
  return { kind: "range", from: Number(r[1]), to: Number(r[2]), path: repoPath(r[3], n), line: n };
}

export function readSpec(buf) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(authorBytes(buf));
  } catch {
    throw new Stop("spec", "spec.md 가 UTF-8 이 아니다");
  }
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() && !line.startsWith("#")) out.push(specLine(line, i + 1));
  });
  return out;
}

const firstLine = (buf) => String(buf || "").split("\n").find((l) => l.trim()) || "";
const withoutKeys = (env, re) => Object.fromEntries(Object.entries(env).filter(([k]) => !re.test(k)));

// git by its absolute path, from `cwd`, on `repo`, with the C locale and no context settings.
// `index` runs it on an index copy, which git then writes whole (no split index in the repo's .git).
export function gitAt(repo, env = process.env, cwd = homedir()) {
  const exe = which("git", { env });
  if (!exe) throw new Stop("git-failed", "git 을 PATH 의 절대 경로에서 찾지 못했다");
  const base = { ...withoutKeys(env, /^(GIT_DIFF_OPTS|LC_ALL)$/i), LC_ALL: "C" };
  const onCopy = (index) => ({ ...withoutKeys(base, /^GIT_INDEX_FILE$/i), GIT_INDEX_FILE: index });
  return (args, { index, input, ok = [0] } = {}) => {
    const pre = ["-C", repo, "-c", "core.fsmonitor=false", ...(index ? ["-c", "core.splitIndex=false"] : [])];
    const r = spawnSync(exe, [...pre, ...args], {
      cwd, env: index ? onCopy(index) : base, input, maxBuffer: 1 << 30, timeout: GIT_TIMEOUT_MS, windowsHide: true,
    });
    const what = `git ${args.filter((a) => a.startsWith("-") || /^[a-z-]+$/.test(a)).slice(0, 4).join(" ")}`;
    if (r.error && r.error.code === "ETIMEDOUT") throw new Stop("git-timeout", `${what} 가 ${GIT_TIMEOUT_MS / 1000}초 안에 끝나지 않았다`);
    if (r.error) throw new Stop("git-failed", `${what} 를 띄우지 못했다(${r.error.code})`);
    if (!ok.includes(r.status)) throw new Stop("git-failed", `${what} 가 실패했다(종료 ${r.status}): ${firstLine(r.stderr)}`);
    return r;
  };
}

const zList = (buf) => String(buf).split("\0").filter(Boolean);

function topLevel(repo, env, cwd) {
  const git = gitAt(repo, env, cwd);
  const r = git(["rev-parse", "--show-toplevel"], { ok: [0, 128] });
  if (r.status !== 0) throw new Stop("not-a-repo", `git 저장소가 아니다: ${repo}`, [firstLine(r.stderr)]);
  const top = resolve(String(r.stdout).trim());
  return { top, git: gitAt(top, env, cwd) };
}

export function untracked({ repo, env = process.env, folder = null, cwd = homedir() }) {
  const { git } = topLevel(repo, env, cwd);
  const args = ["--literal-pathspecs", "ls-files", "-z", "--others", "--exclude-standard"];
  if (folder) return { files: zList(git([...args, "--", `${folder.replace(/\/+$/, "")}/`]).stdout), folded: false };
  const files = zList(git(args).stdout);
  if (files.length <= FOLD_PAST) return { files, count: files.length, folded: false };
  return { files: zList(git([...args, "--directory"]).stdout), count: files.length, folded: true };
}

// The tree to diff against: `auto` is HEAD, or the empty tree in a repo without a commit.
function baseTree(git, base) {
  const value = String(base);
  if (value === "auto") {
    if (git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { ok: [0, 1] }).status === 0) return baseTree(git, "HEAD");
    return String(git(["hash-object", "-t", "tree", "--stdin"], { input: "" }).stdout).trim();
  }
  if (!/^[^\s-][^\s]{0,255}$/.test(value)) throw new Stop("base-invalid", `기준이 아니다: ${value.slice(0, 80)}`);
  const r = git(["rev-parse", "-q", "--verify", `${value}^{tree}`], { ok: [0, 1, 128] });
  if (r.status !== 0) throw new Stop("base-invalid", `기준을 찾지 못했다: ${value}`, [firstLine(r.stderr)]);
  return String(r.stdout).trim();
}

// The real index copied with its times, so entries as new as it stay suspect to git.
function copyIndex(git, top, idx) {
  const out = String(git(["rev-parse", "--git-path", "index"]).stdout).trim();
  const real = isAbsolute(out) ? out : join(top, out);
  rmSync(idx, { force: true });
  if (existsSync(real)) {
    copyFileSync(real, idx);
    const st = statSync(real);
    utimesSync(idx, st.atime, st.mtime);
    return;
  }
  if (git(["rev-parse", "-q", "--verify", "HEAD"], { ok: [0, 1] }).status === 0) throw new Stop("index-missing", `커밋이 있는데 인덱스 파일이 없다: ${real}`);
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// C-style quoting as git lists a name with ", \ or a control character.
function unquoted(p) {
  if (!/^".*"$/.test(p)) return null;
  try {
    return JSON.parse(p.replace(/\\([0-7]{3})/g, (_, o) => `\\u00${Number.parseInt(o, 8).toString(16).padStart(2, "0")}`).replace(/\\a/g, "\\u0007").replace(/\\v/g, "\\u000b"));
  } catch {
    return null;
  }
}

const UNDER_LIMIT = 5;
function folderReason(p, all) {
  const prefix = p === "." ? "" : `${p.replace(/\/+$/, "")}/`;
  const under = all.filter((f) => f.startsWith(prefix));
  const shown = under.slice(0, UNDER_LIMIT).join(", ") + (under.length > UNDER_LIMIT ? " 등" : "");
  return `폴더 줄이다. 그 아래 새 파일을 한 줄에 하나씩 적는다(${shown || "새 파일 없음"})`;
}

// The reasons a `new` line is no new file that need no git: a quoted name, a nested repo.
function quotedOrNested(p, all) {
  const set = new Set(all);
  const plain = unquoted(p);
  if (plain !== null && set.has(plain)) return `따옴표를 풀지 않은 줄이다. new ${plain} 로 적는다`;
  if (set.has(`${p}/`)) return "하위 저장소다. 그 안의 파일은 실리지 않는다";
  if (all.some((f) => f.endsWith("/") && p.startsWith(f))) return "하위 저장소 안이다. 필요하면 file 줄로 붙인다";
  return null;
}

// Why a `new` line names no new file of the repo, in the words the author fixes it by.
function whyNotNew(p, { git, idx, top, all }) {
  const early = quotedOrNested(p, all);
  if (early) return early;
  if (p === "." || p.endsWith("/") || isDir(join(top, p))) return folderReason(p, all);
  const has = (args) => zList(git(["--literal-pathspecs", "ls-files", "-z", ...args, "--", p], { index: idx }).stdout).includes(p);
  if (has(["--others", "--ignored", "--exclude-standard"])) return "무시되는 파일이다. 검토 대상이면 review 줄로 적는다";
  if (has([])) return "이미 추적하는 파일이다(diff 에 실린다)";
  return existsSync(join(top, p)) ? "추적하지 않는 새 파일이 아니다" : "없다";
}

// The listed new files, each one exactly a new file of the repo; any other line stops with `list`.
function listedNew(ctx, spec) {
  const wanted = [...new Set(spec.filter((u) => u.kind === "new").map((u) => u.path))];
  const all = zList(ctx.git(["ls-files", "-z", "--others", "--exclude-standard"], { index: ctx.idx }).stdout);
  const set = new Set(all);
  const bad = wanted.filter((p) => !set.has(p)).map((p) => `${p}: ${whyNotNew(p, { ...ctx, all })}`);
  if (bad.length) throw new Stop("list", "목록의 줄이 새 파일 하나가 아니다", bad);
  return { wanted, all };
}

function addIntent(ctx, { wanted, all }) {
  for (let i = 0; i < wanted.length; i += 100) {
    ctx.git(["--literal-pathspecs", "add", "-N", "--", ...wanted.slice(i, i + 100)], { index: ctx.idx });
  }
  const left = zList(ctx.git(["ls-files", "-z", "--others", "--exclude-standard"], { index: ctx.idx }).stdout);
  const extra = all.filter((f) => !wanted.includes(f) && !left.includes(f));
  if (left.length !== all.length - wanted.length || extra.length) {
    throw new Stop("list", "목록에 없는 새 파일이 올라간다", extra.slice(0, 20));
  }
}

function diffOf(ctx, tree) {
  const diff = ctx.git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short",
    "-U3", "--inter-hunk-context=0", tree, "--"], { index: ctx.idx }).stdout;
  const nul = diff.indexOf(0);
  if (nul === -1) return diff;
  const head = diff.lastIndexOf(Buffer.from("diff --git "), nul);
  const name = head === -1 ? "" : firstLine(diff.slice(head, diff.indexOf(10, head)));
  throw new Stop("binary-diff", "diff 에 바이너리 바이트가 있다(attributes 의 diff 속성이 바이너리 파일을 글로 펼침)", [name]);
}

// A regular file's bytes, opened without following a link and without blocking on a FIFO; null when it is not one.
function readRegular(full) {
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > FILE_CAP) throw new Stop("file", `파일이 64 MiB 를 넘는다: ${full}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Whether `rel` (from the repo root) passes through a link: each folder and the file itself.
function throughLink(top, rel) {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    try {
      if (lstatSync(join(top, ...parts.slice(0, i))).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  const norm = (p) => (WIN ? p.toLowerCase() : p);
  try {
    return norm(realpathSync.native(join(top, rel))) !== norm(join(realpathSync.native(top), ...parts));
  } catch {
    return false;
  }
}

function lineStarts(buf) {
  const starts = [0];
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) starts.push(i + 1);
  const count = starts[starts.length - 1] === buf.length ? starts.length - 1 : starts.length;
  return { starts, count };
}

// The bytes of a part's file; `fail(why)` makes the stop for one that cannot be read (why) or is
// not a regular file (null).
function readPart(full, fail) {
  let buf;
  try {
    buf = readRegular(full);
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw fail(e.code || e.message);
  }
  if (buf === null) throw fail(null);
  return buf;
}

function rangeUnit(ctx, u) {
  const tracked = zList(ctx.git(["--literal-pathspecs", "ls-files", "-z", "--", u.path], { index: ctx.idx }).stdout).includes(u.path);
  if (!tracked) throw new Stop("range-source", `관련 범위의 파일이 추적 파일도 목록의 새 파일도 아니다: ${u.path}`);
  const link = (why) => new Stop("range-link", `관련 범위의 파일이 링크이거나 링크 폴더 아래에 있다(저장소 밖을 읽을 수 있다): ${u.path}`, why ? [why] : []);
  if (throughLink(ctx.top, u.path)) throw link(null);
  const buf = readPart(join(ctx.top, u.path), link);
  const { starts, count } = lineStarts(buf);
  if (u.from < 1 || u.to < u.from || u.from > count) throw new Stop("range-outside", `관련 범위가 파일 밖이다: ${u.path}:${u.from}-${u.to}`);
  const last = Math.min(u.to, count);
  const body = buf.slice(starts[u.from - 1], last < count ? starts[last] : buf.length);
  return Buffer.concat([Buffer.from(`=== ${u.path}:${u.from}-${u.to}\n`), withNewline(body)]);
}

// A file, gate or review part under its `=== <kind> <name>` line: the path from the repo root
// when it is inside the repo, else its file name alone.
function fileUnit(ctx, u) {
  const full = resolve(ctx.top, u.path);
  const rel = relative(ctx.top, full).split(sep).join("/");
  const inside = rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  if (inside && throughLink(ctx.top, rel)) throw new Stop("file", `${u.kind} 의 파일이 링크이거나 링크 폴더 아래에 있다: ${u.path}`);
  const buf = readPart(full, (why) => new Stop("file", why ? `${u.kind} 의 파일을 읽을 수 없다(${why}): ${u.path}` : `${u.kind} 의 파일이 일반 파일이 아니다: ${u.path}`));
  if (buf.includes(0)) throw new Stop("file", `${u.kind} 의 파일이 바이너리다: ${u.path}`);
  return Buffer.concat([Buffer.from(`=== ${u.kind} ${inside ? rel : basename(full)}\n`), withNewline(buf)]);
}

const unitOf = (ctx, u) => (u.kind === "range" ? rangeUnit(ctx, u) : fileUnit(ctx, u));

function writeOutputs(dir, { prompt, raw, unsent, run }) {
  writeFileSync(join(dir, "raw.md"), raw, { mode: 0o600 });
  writeFileSync(join(dir, "unsent.md"), unsent, { mode: 0o600 });
  const tmp = join(dir, `.prompt-${process.pid}.md`);
  writeFileSync(tmp, prompt, { mode: 0o600 });
  renameSync(tmp, join(dir, "prompt.md"));
  writeFileSync(join(dir, "run.md"), run, { mode: 0o600 });
}

// The parts of the payload, from the repo and spec.md: the diff, then each part in spec order.
function assemble(ctx, spec, tree) {
  const listed = listedNew(ctx, spec);
  if (listed.wanted.length) addIntent(ctx, listed);
  const unsent = ctx.git(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], { index: ctx.idx }).stdout;
  const diff = diffOf(ctx, tree);
  if (!diff.length && !spec.some((u) => u.kind === "review")) {
    throw new Stop("no-diff", "보낼 diff 가 없다", ["무시되는 폴더나 저장소 밖의 검토 대상이면 review 줄을 더한다"]);
  }
  const raw = Buffer.concat([diff, ...spec.filter((u) => u.kind !== "new").map((u) => unitOf(ctx, u))]);
  return { raw, unsent };
}

export function buildPayload({ dir, repo, base, id, env = process.env }) {
  checkId(id);
  for (const f of OUTPUTS) rmSync(join(dir, f), { force: true });
  const short = readShort(dir, id);
  const spec = readSpec(readAuthor(dir, "spec.md"));
  const { top, git } = topLevel(repo, env, dir);
  const tree = baseTree(git, base);
  const ctx = { git, top, idx: join(dir, "idx.md") };
  try {
    copyIndex(git, top, ctx.idx);
    const { raw, unsent } = assemble(ctx, spec, tree);
    const prompt = Buffer.concat([short, raw, Buffer.from(`</review-data id="${id}">\n`)]);
    const markers = markerCount(prompt, id);
    if (markers !== 2) throw new Stop("markers", `표지가 두 줄이 아니다(${markers}줄). id 를 바꿔 short.md 를 다시 쓴다`);
    writeOutputs(dir, { prompt, raw, unsent, run: `id ${id}\nbase ${base}\ntree ${tree}\nrepo ${top}\n` });
    return { bytes: prompt.length, markers, scan: scan(prompt.toString("utf8")), unsent: String(unsent).split("\n").filter(Boolean).length };
  } finally {
    rmSync(ctx.idx, { force: true });
    rmSync(`${ctx.idx}.lock`, { force: true });
  }
}
// What run.md says of the last prepare in `dir`: its id, base, tree and repo. A folder without one was never prepared
// (or its prepare stopped): nothing in it goes out.
export function readRun(dir) {
  let text;
  try {
    text = readFileSync(join(dir, "run.md"), "utf8");
  } catch {
    throw new Stop("not-prepared", `prepare 가 끝난 폴더가 아니다(run.md 없음): ${dir}`);
  }
  const run = Object.fromEntries(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
  checkId(run.id);
  return run;
}

// The payload as it would go out now (after the author masked it): its size, the lines with the marker of the id,
// the secret scan, and whether it is past 512 KiB.
export function checkPayload({ dir, id = readRun(dir).id }) {
  let buf;
  try {
    buf = readFileSync(join(dir, "prompt.md"));
  } catch {
    throw new Stop("not-prepared", `prompt.md 가 없다. prepare 를 먼저 한다: ${dir}`);
  }
  return { bytes: buf.length, markers: markerCount(buf, id), scan: scan(buf.toString("utf8")), tooLarge: buf.length > MAX_BYTES };
}

// Where each line of `buf` starts, and the end.
function lineStartsOf(buf) {
  const starts = [0];
  for (let i = buf.indexOf(10); i !== -1 && i + 1 < buf.length; i = buf.indexOf(10, i + 1)) starts.push(i + 1);
  return starts;
}

// Groups of the parts, in order, as even in size as they can be, `n` groups each holding one part at least.
function balanced(units, n) {
  const total = units.reduce((a, u) => a + u.length, 0);
  const groups = [[]];
  let acc = 0;
  units.forEach((u, i) => {
    const left = units.length - i;
    const toOpen = n - groups.length;
    if (groups[groups.length - 1].length && (left <= toOpen || acc >= (total * groups.length) / n)) groups.push([]);
    groups[groups.length - 1].push(u);
    acc += u.length;
  });
  return groups;
}

// The payload cut into `n` parts where a part starts (a file's diff, a `=== ` line), between the short part and the
// closing marker. Each part holds the short part, a `부분 <k>/<n>` line and the closing marker; the parts in order hold
// every part of the payload once. A line inside a file that starts like a part may become a cut: the parts are still
// whole together.
export function splitPayload(buf, n, id) {
  if (!Number.isInteger(n) || n < 2) throw new Stop("split", `나눌 수는 2 이상의 정수다: ${n}`);
  const at = lineStartsOf(buf);
  const lineAt = (k) => buf.slice(at[k], k + 1 < at.length ? at[k + 1] : buf.length).toString("utf8").replace(/\r?\n$/, "");
  const lines = at.map((_, k) => lineAt(k));
  const open = lines.findIndex((l) => l.includes(`<review-data id="${id}">`));
  const close = lines.lastIndexOf(`</review-data id="${id}">`);
  if (open === -1 || close <= open) throw new Stop("split", "여는 표지와 닫는 표지를 찾지 못했다");
  const starts = lines.map((l, k) => (k > open && k < close && (l.startsWith("diff --git ") || l.startsWith("=== ")) ? k : -1)).filter((k) => k !== -1);
  if (starts.length < n) throw new Stop("split", `나눌 수 있는 단위가 ${starts.length}개라 ${n} 부분으로 나눌 수 없다`);
  const units = starts.map((k, j) => buf.slice(at[k], at[j + 1 < starts.length ? starts[j + 1] : close]));
  const prefix = buf.slice(0, at[starts[0]]);
  const closing = buf.slice(at[close]);
  return balanced(units, n).map((g, k) => Buffer.concat([prefix, Buffer.from(`부분 ${k + 1}/${n}\n`), ...g, closing]));
}
