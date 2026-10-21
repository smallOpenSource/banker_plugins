#!/usr/bin/env node
/**
 * seat-run: the external seat send of ralph-qa (the skill's "외부 좌석 전송") as one program: the folders, the
 * payload and its checks, the seats with their read-only guards and time limit, and the cleanup. The skill gives it
 * paths and choices; no seat command or git chain is put together by hand.
 *
 *   node seat-run.mjs init                                         the payload folder <d> and the answer folder <o>
 *   node seat-run.mjs untracked --repo <repo> [--folder <folder>]  the new files git does not track, by exact name
 *   node seat-run.mjs prepare --dir <d> --repo <repo> --base <base|auto> --id <id>   short.md + spec.md -> prompt.md
 *   node seat-run.mjs check --dir <d>                              prompt.md again, after the author masked it
 *   node seat-run.mjs send --dir <d> --runtime claude|codex --seat <cli>=<model|@cli-default> ...
 *                     [--effort <v>] [--allow-large] [--split <cli>=<n>] [--limit <s>] [--dry-run]
 *   node seat-run.mjs cleanup --dir <d> [--force]                  the seat records, old runs' folders, <d> and <o>
 *   node seat-run.mjs put --dir <d> --name short.md|spec.md        writes the file from standard input
 *
 * Out: one JSON object on stdout, the same in <d>/result-<command>.md (a PowerShell 5.1 console may garble it), and
 * `ralph-qa: ` lines on stderr. Exit 0 done, 1 secret-like lines, 2 a usage or internal error, 3 a stop (`stop` in
 * the JSON says which), 4 a payload past 512 KiB, 5 a send of the folder still runs. Every file name ends in .md
 * (a DRM of a closed network encrypts .txt or .json files).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanSeat, sweepBase } from "./gemini-seat.mjs";
import { MAX_BYTES, Stop, buildPayload, checkPayload, gitAt, readRun, untracked } from "./seat-payload.mjs";
import { runLimited, which } from "./seat-spawn.mjs";

// The stops a command may end with, as `stop` in its JSON; the skill's table of what to do holds the same set.
export const STOP_CODES = ["index-missing", "no-diff", "list", "binary-diff", "range-source", "range-link", "range-outside", "file", "markers",
  "spec", "not-a-repo", "base-invalid", "git-failed", "git-timeout", "scan", "too-large", "sent", "sandboxed", "base-not-private",
  "base-not-writable", "inside-repo", "busy", "not-prepared", "not-a-run-folder", "split"];
const EXIT_OF = { scan: 1, "too-large": 4, busy: 5 };

const DAY_MS = 86400 * 1000;
const STALE_LOCK_MS = 15 * 60 * 1000;
const RUN_NAME = /^ralph-qa\.[A-Za-z0-9]+$/;
// A run folder of any version: bash's six characters, PowerShell's 32 of a guid, this runner's six.
const ANY_RUN = /^ralph-qa(-out)?\.[A-Za-z0-9]+$/;
const LOCK = /^\.running-(\d+)\.md$/;

class Usage extends Error {}
const USAGE = "usage: node seat-run.mjs init | untracked --repo <repo> [--folder <f>] | prepare --dir <d> --repo <repo> --base <base|auto> --id <id>"
  + " | check --dir <d> | send --dir <d> --runtime claude|codex --seat <cli>=<model> ... | cleanup --dir <d> [--force] | put --dir <d> --name short.md|spec.md\n";

// The flags of each command: a plain name takes one value, `*` takes many, `!` takes none.
const FLAGS = {
  init: [], untracked: ["repo", "folder"], prepare: ["dir", "repo", "base", "id"], check: ["dir"],
  send: ["dir", "runtime", "seat*", "effort", "allow-large!", "split*", "limit", "dry-run!"], cleanup: ["dir", "force!"], put: ["dir", "name"],
};
const REQUIRED = { untracked: ["repo"], prepare: ["dir", "repo", "base", "id"], check: ["dir"], send: ["dir", "runtime", "seat"], cleanup: ["dir"], put: ["dir", "name"] };

function takeFlag(o, flag, name, value) {
  if (flag.endsWith("*")) (o[name] = o[name] || []).push(value);
  else if (name in o) throw new Usage(`--${name} 를 두 번 줬다`);
  else o[name] = value;
}

// One flag at rest[i] into o; gives the index of the next one.
function readFlag(spec, rest, i, o) {
  const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(rest[i]);
  const flag = m && spec.find((f) => f.replace(/[*!]$/, "") === m[1]);
  if (!flag) throw new Usage(`모르는 인자다: ${String(rest[i]).slice(0, 80)}`);
  if (flag.endsWith("!")) {
    o[m[1]] = true;
    return i + 1;
  }
  const value = m[2] !== undefined ? m[2] : rest[i + 1];
  if (value === undefined) throw new Usage(`--${m[1]} 에 값이 없다`);
  takeFlag(o, flag, m[1], value);
  return m[2] !== undefined ? i + 1 : i + 2;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const spec = Object.prototype.hasOwnProperty.call(FLAGS, command) ? FLAGS[command] : null;
  if (!spec) throw new Usage(`모르는 명령이다: ${command ?? "(없음)"}`);
  const o = {};
  for (let i = 0; i < rest.length; ) i = readFlag(spec, rest, i, o);
  for (const r of REQUIRED[command] || []) if (!(r in o)) throw new Usage(`--${r} 가 필요하다`);
  return { command, o };
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

// A folder init made: named ralph-qa.<letters and digits>, a folder and no link, with its marker. Its answer folder
// is the sibling ralph-qa-out.<the same>.
export function runFolder(dir) {
  const d = resolve(String(dir));
  if (!RUN_NAME.test(basename(d)) || !lstatOr(d)?.isDirectory() || !isFile(join(d, ".ralph-qa"))) {
    throw new Stop("not-a-run-folder", `init 이 만든 폴더가 아니다: ${d}`);
  }
  const o = join(dirname(d), basename(d).replace(/^ralph-qa\./, "ralph-qa-out."));
  const answers = lstatOr(o);
  return { d, o: answers?.isDirectory() && isFile(join(o, ".ralph-qa")) ? o : null };
}

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
function privateDir(p) {
  try {
    const st = statSync(p);
    return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}
const insideHome = (ctx, p) => norm(ctx, realOr(p)).startsWith(norm(ctx, realOr(homeOf(ctx))) + sep);

// The base for this run's folders, and every base a run of any version may have used, for the day rule. Linux: an
// XDG_RUNTIME_DIR of this account's own, else ~/.cache; macOS: $TMPDIR (its own per account); Windows: %TEMP% when it
// is inside the home, else ~/.cache (the old Git Bash runs used ~/.cache). Never /tmp: gemini reads a .env it finds
// walking up from its folder, and another account may put one there.
export function bases(ctx) {
  const cache = join(homeOf(ctx), ".cache");
  const base = baseOn(ctx, cache);
  const xdg = ctx.platform === "linux" && ctx.env.XDG_RUNTIME_DIR ? [resolve(ctx.env.XDG_RUNTIME_DIR)] : [];
  return { base, known: [...new Set([base, cache, ...xdg])] };
}

function baseOn(ctx, cache) {
  const { env } = ctx;
  if (ctx.platform === "win32") return env.TEMP && insideHome(ctx, env.TEMP) ? resolve(env.TEMP) : cache;
  if (ctx.platform === "darwin") return env.TMPDIR ? resolve(env.TMPDIR) : cache;
  const xdg = env.XDG_RUNTIME_DIR;
  return xdg && isAbsolute(xdg) && privateDir(xdg) ? resolve(xdg) : cache;
}

function readyBase(ctx, base) {
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Stop("base-not-writable", `기준 폴더를 만들 수 없다(${e.code}): ${base}`);
  }
  if (ctx.platform !== "win32" && !privateDir(base)) throw new Stop("base-not-private", `기준 폴더를 다른 계정도 쓸 수 있다: ${base}`);
}

// Two folders with the same six characters: the payload one by mkdtemp, its answer folder beside it.
function makeFolders(base) {
  for (let tries = 0; tries < 20; tries += 1) {
    const d = mkdtempSync(join(base, "ralph-qa."));
    const o = join(base, basename(d).replace(/^ralph-qa\./, "ralph-qa-out."));
    try {
      mkdirSync(o, { mode: 0o700 });
      for (const p of [d, o]) writeFileSync(join(p, ".ralph-qa"), "", { mode: 0o600 });
      return { d, o };
    } catch (e) {
      rmSync(d, { recursive: true, force: true });
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Stop("base-not-writable", `기준 폴더에 새 폴더 이름을 정하지 못했다: ${base}`);
}

// Whether `dir` is inside a git work tree: a seat would then read the repo through its tools.
function insideRepo(ctx, dir) {
  try {
    return gitAt(dir, ctx.env, dir)(["rev-parse", "--git-dir"], { ok: [0, 128] }).status === 0;
  } catch {
    return false; // no git: no repo either
  }
}

function init(_o, ctx) {
  const { base } = bases(ctx);
  readyBase(ctx, base);
  let made;
  try {
    made = makeFolders(base);
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw new Stop("base-not-writable", `기준 폴더에 쓸 수 없다(${e.code}): ${base}`);
  }
  if (insideRepo(ctx, made.d)) {
    for (const p of [made.d, made.o]) rmSync(p, { recursive: true, force: true });
    throw new Stop("inside-repo", `기준 폴더가 git 저장소 안이다: ${base}`);
  }
  return [{ ok: true, dir: made.d, out: made.o, base }, 0, made.d];
}

function listUntracked(o, ctx) {
  return [{ ok: true, ...untracked({ repo: o.repo, env: ctx.env, folder: o.folder || null }) }, 0, null];
}

const sent = (d) => existsSync(join(d, "result-send.md"));
const refuseSent = (d) => {
  if (sent(d)) throw new Stop("sent", `이미 보낸 폴더다. 반복마다 init 으로 새 폴더를 만든다: ${d}`);
};

// prepare and check end with 1 when a line looks like a secret and 4 past 512 KiB; the JSON carries both.
function verdict(result) {
  if (result.scan.count) {
    const lines = result.scan.hits.map((h) => `${h.line}(${h.kind}${h.end === null ? ", 끝 줄 없음" : ""})`);
    return [{ ...result, ok: false, stop: "scan", message: `ralph-qa: 비밀처럼 보이는 줄이 있다: ${lines.join(", ")}. 값을 [REDACTED] 로 가린 뒤 check 를 다시 한다` }, 1];
  }
  if (result.bytes > MAX_BYTES) {
    return [{ ...result, ok: false, stop: "too-large", message: `ralph-qa: 페이로드가 512 KiB 를 넘는다(${result.bytes}바이트). 보내기 전에 사용자에게 묻는다` }, 4];
  }
  return [{ ...result, ok: true }, 0];
}

function prepare(o, ctx) {
  const { d } = runFolder(o.dir);
  refuseSent(d);
  const built = buildPayload({ dir: d, repo: o.repo, base: o.base, id: o.id, env: ctx.env });
  const [result, code] = verdict({ dir: d, prompt: join(d, "prompt.md"), raw: join(d, "raw.md"), unsentFile: join(d, "unsent.md"), ...built });
  return [result, code, d];
}

function check(o) {
  const { d } = runFolder(o.dir);
  const id = readRun(d).id;
  const c = checkPayload({ dir: d, id });
  if (c.markers !== 2) throw new Stop("markers", `표지가 두 줄이 아니다(${c.markers}줄). 가리다 표지를 지웠으면 prepare 를 다시 한다`);
  const [result, code] = verdict({ dir: d, prompt: join(d, "prompt.md"), bytes: c.bytes, markers: c.markers, scan: c.scan });
  return [result, code, d];
}

const readStdin = (ctx) => {
  if (ctx.stdin !== undefined) return Buffer.from(ctx.stdin);
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
};

function put(o, ctx) {
  if (!["short.md", "spec.md"].includes(o.name)) throw new Usage(`--name 은 short.md 나 spec.md 다: ${String(o.name).slice(0, 80)}`);
  const { d } = runFolder(o.dir);
  refuseSent(d);
  const data = readStdin(ctx);
  writeFileSync(join(d, o.name), data, { mode: 0o600 });
  return [{ ok: true, written: join(d, o.name), bytes: data.length }, 0, d];
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// A send of the folder that still runs: a lock of a live process, newer than 15 minutes (a lock left by a send that
// was killed, or one whose number another process now has, goes stale).
export function liveLock(d, now = Date.now()) {
  for (const name of listDir(d)) {
    const m = LOCK.exec(name);
    const st = m && lstatOr(join(d, name));
    if (st && Number(m[1]) !== process.pid && now - st.mtimeMs < STALE_LOCK_MS && alive(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

// The day rule: folders of an earlier run, marked, past a day, never a link or a folder without the marker.
function dayRule(base, now) {
  const removed = [];
  for (const name of listDir(base)) {
    const p = join(base, name);
    const st = ANY_RUN.test(name) ? lstatOr(p) : null;
    if (!st?.isDirectory() || now - st.mtimeMs <= DAY_MS || !isFile(join(p, ".ralph-qa"))) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// An opencode session of this run, or of a seat folder under one of the bases that is gone (a run cut short).
// opencode records the folder resolved through links (macOS's /var is a link to /private/var).
function staleSession(ctx, s, forms) {
  if (typeof s?.title !== "string" || !SESSION_ID.test(String(s.id))) return false;
  return (Boolean(ctx.id) && s.title === `ralph-qa-review-${ctx.id}`) || goneSeat(ctx, s, forms);
}
function goneSeat(ctx, s, forms) {
  const dir = String(s.directory || "");
  if (!s.title.startsWith("ralph-qa-review-") || basename(dir) !== "opencode" || !RUN_NAME.test(basename(dirname(dir)))) return false;
  return forms.has(norm(ctx, dirname(dirname(dir)))) && !existsSync(dir);
}

async function opencodeCall(ctx, exe, args, out) {
  const env = { ...ctx.env, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
  return runLimited({ exe, args, cwd: ctx.d, env, stdin: "ignore", stdout: out, stderr: "ignore", limitMs: 60000 });
}

async function opencodeSessions(ctx, known) {
  const exe = which("opencode", { env: ctx.env, platform: ctx.platform });
  if (!exe) return { deleted: 0, note: "opencode 가 없다" };
  const out = join(ctx.d, ".opencode-sessions.md");
  const r = await opencodeCall(ctx, exe, ["session", "list", "--pure", "--format", "json"], out);
  let sessions = [];
  try {
    sessions = r.exit === 0 ? JSON.parse(readFileSync(out, "utf8")) : [];
  } catch {
    return { deleted: 0, note: "opencode 의 세션 목록을 읽지 못했다" };
  }
  const forms = new Set(known.flatMap((b) => [norm(ctx, b), norm(ctx, realOr(b))]));
  let deleted = 0;
  for (const s of Array.isArray(sessions) ? sessions.filter((x) => staleSession(ctx, x, forms)) : []) {
    if ((await opencodeCall(ctx, exe, ["session", "delete", String(s.id), "--pure"], "ignore")).exit === 0) deleted += 1;
  }
  return { deleted };
}

const readIdOr = (d) => {
  try {
    return readRun(d).id;
  } catch {
    return null;
  }
};

async function cleanup(o, ctx) {
  const { d, o: out } = runFolder(o.dir);
  const pid = o.force ? null : liveLock(d, ctx.now());
  if (pid) throw new Stop("busy", `이 폴더의 send 가 아직 돈다(pid ${pid}). 끝난 뒤 다시 한다`);
  const { known } = bases(ctx);
  const all = [...new Set([dirname(d), ...known])];
  const gemini = cleanSeat(join(d, "gemini"), { env: ctx.env, platform: ctx.platform });
  const swept = all.flatMap((b) => dayRule(b, ctx.now()));
  for (const b of all) gemini.skipped.push(...sweepBase(b, { env: ctx.env, platform: ctx.platform }).skipped);
  for (const p of gemini.skipped) ctx.stderr.write(`ralph-qa: gemini 기록 폴더를 남겼다(두 프로젝트가 그 이름을 씀): ${p}\n`);
  const opencode = await opencodeSessions({ ...ctx, d, id: readIdOr(d) }, all);
  for (const p of [d, out]) if (p) rmSync(p, { recursive: true, force: true });
  return [{ ok: true, removed: [d, out].filter(Boolean), swept, gemini, opencode }, 0, null];
}

async function send() {
  throw new Usage("send 는 아직 없다");
}

const COMMANDS = { init, untracked: listUntracked, prepare, check, send, cleanup, put };

// The JSON on stdout and in <d>/result-<command>.md (not for cleanup: the folder is gone).
function report(ctx, command, dir, result, code) {
  const json = `${JSON.stringify({ command, ...result }, null, 2)}\n`;
  ctx.stdout.write(json);
  if (result.message) ctx.stderr.write(`${result.message}\n`);
  if (dir) {
    try {
      writeFileSync(join(dir, `result-${command}.md`), json, { mode: 0o600 });
    } catch {
      /* the JSON on stdout is the answer */
    }
  }
  return code;
}

// A stop in the folder it concerns, when that is a run folder.
const folderOf = (o) => {
  try {
    return o.dir ? runFolder(o.dir).d : null;
  } catch {
    return null;
  }
};

function failed(ctx, { command, o }, e) {
  if (e instanceof Usage) {
    ctx.stderr.write(`ralph-qa: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (!(e instanceof Stop)) {
    ctx.stderr.write(`ralph-qa: 실행기 내부 오류(${e?.code || e?.name || "error"}): ${String(e?.message || e).split("\n")[0]}\n`);
    return 2;
  }
  const result = { ok: false, stop: e.code, message: e.message, detail: e.detail };
  return report(ctx, command, folderOf(o), result, EXIT_OF[e.code] || 3);
}

export async function main(argv, io = {}) {
  const ctx = {
    env: io.env || process.env, platform: io.platform || process.platform, stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr,
    stdin: io.stdin, probe: io.probe, now: io.now || Date.now,
  };
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return failed(ctx, { command: argv[0], o: {} }, e);
  }
  try {
    const [result, code, dir] = await COMMANDS[parsed.command](parsed.o, ctx);
    return report(ctx, parsed.command, dir, result, code);
  } catch (e) {
    return failed(ctx, parsed, e);
  }
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
