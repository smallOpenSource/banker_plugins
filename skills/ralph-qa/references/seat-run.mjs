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
 * (the DRM of a closed network encrypts files by their extension, and .md is one it leaves readable).
 */
import { fork } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Stop as RunStop, bases, isFile, listDir, lstatOr, makeRunFolder, norm, realOr, removeMarked, runFolder } from "./run-folder.mjs";
import { POLICY, cleanSeat, policyIntact, strayEnvFiles, sweepBase } from "./gemini-seat.mjs";
import { scan } from "./payload-scan.mjs";
import { MAX_BYTES, Stop, buildPayload, checkPayload, gitAt, markerCount, readRun, splitPayload, untracked } from "./seat-payload.mjs";
import { cmdLine, runLimited, stopAll, which } from "./seat-spawn.mjs";
import { CLI_DEFAULT, probe as localProbe, safeModel } from "./verifier-probe.mjs";

// The stops a command may end with, as `stop` in its JSON; the skill's table of what to do holds the same set.
export const STOP_CODES = ["index-missing", "no-diff", "list", "binary-diff", "range-source", "range-link", "range-outside", "file", "markers",
  "spec", "not-a-repo", "base-invalid", "git-failed", "git-timeout", "scan", "too-large", "sent", "sandboxed", "base-not-private",
  "base-not-writable", "inside-repo", "busy", "not-prepared", "not-a-run-folder", "split", "cleanup-left"];
const EXIT_OF = { scan: 1, "too-large": 4, busy: 5 };

const DAY_MS = 86400 * 1000;
const STALE_LOCK_MS = 15 * 60 * 1000;
const RUN_NAME = /^ralph-qa\.[A-Za-z0-9]+$/;
// A run folder of any version: bash's six characters, PowerShell's 32 of a guid, this runner's six.
const ANY_RUN = /^ralph-qa(-out)?\.[A-Za-z0-9]+$/;
// The lock of a send that runs: one name, made with "wx", holding the pid and the time.
const LOCK_NAME = ".running.md";
const TAKING_NAME = ".taking.md";
const STALE_TAKING_MS = 60 * 1000;

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

// A path as Git Bash writes it on Windows (/c/Users/...) as Windows reads it (C:\Users\...). Git Bash turns such a
// word into C:\... for a Windows program only some of the time (not one with Korean and brackets), and git cannot go
// to /c/...: the runner does it for --repo and --dir. Any other path, and every path off Windows, stays.
export function fromMsys(p, platform) {
  const m = platform === "win32" ? /^\/([A-Za-z])(?:\/([\s\S]*))?$/.exec(String(p)) : null;
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || "").replace(/\//g, "\\")}` : p;
}

// A folder init made (run-folder.mjs: its name, its marker, right under a known private base) and its answer folder,
// the sibling ralph-qa-out.<the same>.
function runPair(dir, ctx) {
  const { d } = runFolder(dir, ctx, ["ralph-qa"]);
  const o = join(dirname(d), basename(d).replace(/^ralph-qa\./, "ralph-qa-out."));
  const answers = lstatOr(o);
  return { d, o: answers?.isDirectory() && isFile(join(o, ".ralph-qa")) ? o : null };
}

// Two folders with the same six characters: the payload one by run-folder.mjs, its answer folder beside it.
function makeFolders(ctx) {
  for (let tries = 0; tries < 20; tries += 1) {
    const { dir: d, base } = makeRunFolder(ctx, "ralph-qa");
    const o = join(base, basename(d).replace(/^ralph-qa\./, "ralph-qa-out."));
    try {
      mkdirSync(o, { mode: 0o700 });
      writeFileSync(join(o, ".ralph-qa"), "", { mode: 0o600 });
      return { d, o, base };
    } catch (e) {
      rmSync(d, { recursive: true, force: true });
      if (e.code !== "EEXIST") throw new Stop("base-not-writable", `기준 폴더에 쓸 수 없다(${e.code}): ${base}`);
    }
  }
  throw new Stop("base-not-writable", `기준 폴더에 새 폴더 이름을 정하지 못했다: ${bases(ctx).base}`);
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
  const made = makeFolders(ctx);
  if (insideRepo(ctx, made.d)) {
    for (const p of [made.d, made.o]) rmSync(p, { recursive: true, force: true });
    throw new Stop("inside-repo", `기준 폴더가 git 저장소 안이다: ${made.base}`);
  }
  return [{ ok: true, dir: made.d, out: made.o, base: made.base }, 0, made.d];
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
  const { d } = runPair(o.dir, ctx);
  refuseSent(d);
  const built = buildPayload({ dir: d, repo: o.repo, base: o.base, id: o.id, env: ctx.env });
  const [result, code] = verdict({ dir: d, prompt: join(d, "prompt.md"), raw: join(d, "raw.md"), unsentFile: join(d, "unsent.md"), ...built });
  return [result, code, d];
}

function check(o, ctx) {
  const { d } = runPair(o.dir, ctx);
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
  const { d } = runPair(o.dir, ctx);
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

const lockPid = (d) => {
  try {
    return Number(readFileSync(join(d, LOCK_NAME), "utf8").split(" ")[0]) || null;
  } catch {
    return null;
  }
};

// A send of the folder that still runs: the lock of a live process, touched in the last 15 minutes (a send touches
// it every minute; a lock left by a send that was killed, or one whose number another process now has, goes stale).
export function liveLock(d, now = Date.now()) {
  const pid = lockPid(d);
  const st = pid && lstatOr(join(d, LOCK_NAME));
  return st && st.isFile() && pid !== process.pid && now - st.mtimeMs < STALE_LOCK_MS && alive(pid) ? pid : null;
}

// A lock with no number to read (empty: another send made it and has not written its number yet; or broken) touched
// in the last 15 minutes: taken over, it would let two sends hold the folder.
function freshUnread(d, now) {
  const st = lockPid(d) ? null : lstatOr(join(d, LOCK_NAME));
  return Boolean(st && st.isFile() && now - st.mtimeMs < STALE_LOCK_MS);
}

const justStarted = () => new Stop("busy", "이 폴더의 send 가 방금 시작했다");

// Windows makes "wx" fail EPERM (or EACCES, EBUSY), not EEXIST, where another process is deleting the file (delete
// pending: a lock given back that moment). Such a code is tried again for up to a second; then it is the lock there
// when the file is seen, else this send's error. Any other error fails at once.
const PENDING = new Set(["EPERM", "EACCES", "EBUSY"]);
const PENDING_TRIES = 40;
const PENDING_WAIT_MS = 25;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The lock (or the take-over mark) made with "wx": one of two sends that make it together has it.
function makeLock(file, now) {
  for (let tries = 1; ; tries += 1) {
    try {
      writeFileSync(file, `${process.pid} ${new Date(now).toISOString()}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      if (!PENDING.has(e.code)) throw e;
      if (tries >= PENDING_TRIES) {
        if (existsSync(file)) return false;
        throw e;
      }
    }
    pause(PENDING_WAIT_MS);
  }
}

// A stale lock is taken over only under the take-over mark .taking.md, and judged again under it: of two sends that
// both found it stale, the second finds the first's new lock live (or with no number yet) and is busy; neither removes
// a lock that is not stale. A mark left by a send that died taking over is cleared once it is a minute old (that send
// is busy; the next one goes on), so it holds the folder no longer than that.
export function takeOver(d, lock, now = Date.now()) {
  const taking = join(d, TAKING_NAME);
  if (!makeLock(taking, now)) {
    const st = lstatOr(taking);
    if (st?.isFile() && now - st.mtimeMs >= STALE_TAKING_MS) rmSync(taking, { force: true });
    throw new Stop("busy", "다른 send 가 이 폴더의 낡은 잠금을 넘겨받는 중이다");
  }
  try {
    if (liveLock(d, now) || freshUnread(d, now)) throw justStarted();
    rmSync(lock, { force: true });
    if (!makeLock(lock, now)) throw justStarted();
    return lock;
  } finally {
    rmSync(taking, { force: true });
  }
}

// Takes the folder's lock: "wx" lets one of two sends that start together have it; a stale one is taken over under
// the take-over mark. Gives back the lock's path.
export function takeLock(d, now = Date.now()) {
  const lock = join(d, LOCK_NAME);
  if (makeLock(lock, now)) return lock;
  const pid = liveLock(d, now);
  if (pid) throw new Stop("busy", `이 폴더의 send 가 아직 돈다(pid ${pid})`);
  if (freshUnread(d, now)) throw justStarted();
  return takeOver(d, lock, now);
}

// Touches the lock every `every` ms while a send runs: a send past 15 minutes (split parts) stays live to cleanup.
export function keepFresh(lock, every = 60000) {
  const timer = setInterval(() => {
    try {
      utimesSync(lock, new Date(), new Date());
    } catch {
      /* the lock is gone: nothing to keep */
    }
  }, every);
  timer.unref();
  return timer;
}

// The lock goes back only while it is this process's (a send past 15 minutes without its touches may have lost it).
function giveBack(lock) {
  if (lockPid(dirname(lock)) === process.pid) rmSync(lock, { force: true });
}

// The lock, and only then the last look for result-send.md: a send that checked before another gave the lock back
// finds the folder sent here, not after it sent again. A stop here gives the lock back.
export function holdFolder(d, now = Date.now()) {
  const lock = takeLock(d, now);
  try {
    refuseSent(d);
  } catch (e) {
    giveBack(lock);
    throw e;
  }
  return lock;
}

// The day rule: folders of an earlier run, marked, past a day, never a link or a folder without the marker (removed
// by run-folder.mjs, the marker last). One that cannot be removed (a held handle, a folder this account cannot
// empty) goes to `left` with why; the rest go on.
function dayRule(base, now, left) {
  const removed = [];
  for (const name of listDir(base)) {
    const p = join(base, name);
    const st = ANY_RUN.test(name) ? lstatOr(p) : null;
    if (!st?.isDirectory() || now - st.mtimeMs <= DAY_MS || !isFile(join(p, ".ralph-qa"))) continue;
    try {
      removeMarked(p, ".ralph-qa");
      removed.push(p);
    } catch (e) {
      left.push({ path: p, why: e.code || e.message });
    }
  }
  return removed;
}

// This run's folders; any that stays is a stop (the payload copy would stay on disk), named with why.
function removeOwn(folders) {
  const stayed = [];
  for (const p of folders.filter(Boolean)) {
    try {
      removeMarked(p, ".ralph-qa");
    } catch (e) {
      stayed.push(`${p} (${e.code || e.message})`);
    }
  }
  if (stayed.length) throw new Stop("cleanup-left", "이 실행의 폴더를 다 지우지 못했다. 사용자에게 경로를 알린다", stayed);
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
  const { d, o: out } = runPair(o.dir, ctx);
  const pid = o.force ? null : liveLock(d, ctx.now());
  if (pid) throw new Stop("busy", `이 폴더의 send 가 아직 돈다(pid ${pid}). 끝난 뒤 다시 한다`);
  const { known } = bases(ctx);
  const all = [...new Set([dirname(d), ...known])];
  const gemini = cleanSeat(join(d, "gemini"), { env: ctx.env, platform: ctx.platform });
  const left = [];
  const swept = all.flatMap((b) => dayRule(b, ctx.now(), left));
  for (const b of all) gemini.skipped.push(...sweepBase(b, { env: ctx.env, platform: ctx.platform }).skipped);
  for (const p of gemini.skipped) ctx.stderr.write(`ralph-qa: gemini 기록 폴더를 남겼다(두 프로젝트가 그 이름을 씀): ${p}\n`);
  const opencode = await opencodeSessions({ ...ctx, d, id: readIdOr(d) }, all);
  removeOwn([d, out]);
  return [{ ok: true, removed: [d, out].filter(Boolean), swept, left, gemini, opencode }, 0, null];
}

// ---- send

// Why a seat was not sent (`not-sent`) or its run counts for nothing (`failed`); `probe:<reason>` carries the probe's.
export const SEAT_WHY = ["rejected", "timeout", "exit", "signal", "spawn", "empty", "verdict", "policy-file-error", "fallback-agent",
  "model-mismatch", "default-model-family", "probe", "unsafe-model", "cli-absent", "unsafe-word", "gemini-policy", "gemini-env-file",
  "opencode-agent", "split"];
const LIMIT_S = 600;
const CHECK_LIMIT_MS = 120000;
// Lines of a seat's errors that say the provider refused the model (the author may then seat another, before a first verdict).
const REJECT_HINT = /\b40[34]\b|model_not_found|model not found|does not exist|PERMISSION_DENIED|permission denied/i;
const VERDICT_LINE = /^VERDICT: (APPROVE|ITERATE|REJECT|ERROR)\s*$/;
const RANK = { APPROVE: 0, ITERATE: 1, REJECT: 2, ERROR: 3 };

function seatArg(v) {
  const m = /^(codex|gemini|opencode)=([\s\S]+)$/.exec(String(v));
  if (!m) throw new Usage(`--seat 은 <cli>=<모델> 이다(cli 는 codex, gemini, opencode): ${String(v).slice(0, 80)}`);
  return { cli: m[1], model: m[2] };
}
function splitArg(v) {
  const m = /^(codex|gemini|opencode)=(\d{1,2})$/.exec(String(v));
  if (!m || Number(m[2]) < 2) throw new Usage(`--split 은 <cli>=<2 이상의 수> 다: ${String(v).slice(0, 80)}`);
  return [m[1], Number(m[2])];
}
function limitOf(o) {
  const limit = o.limit === undefined ? LIMIT_S : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_S) throw new Usage(`--limit 은 1~600 초다: ${String(o.limit).slice(0, 40)}`);
  return limit * 1000;
}
function sendArgs(o) {
  if (!["claude", "codex"].includes(o.runtime)) throw new Usage(`--runtime 은 claude 나 codex 다: ${String(o.runtime).slice(0, 40)}`);
  const seats = o.seat.map(seatArg);
  if (seats.length > 3 || new Set(seats.map((x) => x.cli)).size !== seats.length) throw new Usage("--seat 는 CLI 마다 한 번, 셋까지다");
  const split = Object.fromEntries((o.split || []).map(splitArg));
  for (const cli of Object.keys(split)) if (!seats.some((x) => x.cli === cli)) throw new Usage(`--split 의 ${cli} 는 보내는 좌석이 아니다`);
  if (o.effort !== undefined && !/^[a-z]{1,16}$/.test(o.effort)) throw new Usage(`--effort 값이 아니다: ${String(o.effort).slice(0, 40)}`);
  return { seats, split, limitMs: limitOf(o), effort: o.effort, runtime: o.runtime, dryRun: Boolean(o["dry-run"]) };
}

// What goes out, read once: the same bytes are checked here and copied for every seat.
function payloadToSend(d, id, allowLarge) {
  let buf;
  try {
    buf = readFileSync(join(d, "prompt.md"));
  } catch {
    throw new Stop("not-prepared", `prompt.md 가 없다. prepare 를 먼저 한다: ${d}`);
  }
  const markers = markerCount(buf, id);
  if (markers !== 2) throw new Stop("markers", `표지가 두 줄이 아니다(${markers}줄). 가리다 표지를 지웠으면 prepare 를 다시 한다`);
  let found;
  try {
    found = scan(buf.toString("utf8"));
  } catch (e) {
    throw new Stop("scan", `비밀 검사를 끝내지 못해 보내지 않는다(${String(e?.message || e).split("\n")[0]})`);
  }
  if (found.count) throw new Stop("scan", `비밀처럼 보이는 줄이 있어 보내지 않는다: ${found.hits.map((h) => h.line).join(", ")}. 가린 뒤 check 를 다시 한다`);
  if (buf.length > MAX_BYTES && !allowLarge) throw new Stop("too-large", `페이로드가 512 KiB 를 넘는다(${buf.length}바이트). 사용자가 보내기로 하면 --allow-large 로 다시 한다`);
  return buf;
}

const modelFlag = (model) => (model === CLI_DEFAULT ? [] : ["-m", model]);
const OPENCODE_DENY = '{"*":"deny"}';
// The commands of the 0.20.4 skill's bash block, word for word, as plans: arguments, what is set and unset in the
// env, and the check run first (opencode). `part` names the files of a split part.
const PLANS = {
  codex: (p, f) => ({
    args: ["exec", "-C", f.cwd, "--ephemeral", "--ignore-rules", ...["multi_agent", "hooks", "plugins", "apps", "shell_tool"].flatMap((x) => ["--disable", x]),
      "-c", "notify=[]", "-c", "analytics.enabled=false", "-c", "web_search=disabled", ...(p.mcpServers || []).flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]),
      "-c", 'otel.exporter="none"', "-c", 'otel.trace_exporter="none"', "-c", 'otel.metrics_exporter="none"',
      ...(p.effort ? ["-c", `model_reasoning_effort=${p.effort}`] : []), ...modelFlag(p.model), "-s", "read-only", "--skip-git-repo-check", "-o", f.answer, "-"],
    stdout: join(p.o, `stdout-codex${f.sfx}.md`), set: {}, unset: [], check: null,
  }),
  gemini: (p, f) => ({
    args: ["--skip-trust", "--approval-mode", "default", "--admin-policy", p.policy, "--allowed-mcp-server-names", "ralph-qa-none", "-e", "none",
      ...modelFlag(p.model), "-p", "첨부한 검토 지시를 따르라"],
    stdout: f.answer, set: { TMPDIR: p.o, TEMP: p.o, TMP: p.o, GEMINI_SANDBOX: "false", GEMINI_TELEMETRY_LOG_PROMPTS: "false" }, unset: ["GEMINI_CLI_IDE_WORKSPACE_PATH"], check: null,
  }),
  opencode: (p, f) => {
    const agent = `ralph-qa-review-${p.id}`;
    const config = { share: "disabled", agent: { compaction: { disable: true }, [agent]: { mode: "primary", description: "ralph-qa reviewer", permission: { "*": "deny" } } } };
    return {
      args: ["run", "--pure", "--agent", agent, "--title", agent, ...modelFlag(p.model), "아래 검토 지시를 따르라"], stdout: f.answer, unset: [],
      set: { OPENCODE_PERMISSION: OPENCODE_DENY, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
      check: ["debug", "agent", agent, "--pure"],
    };
  },
};

export function seatPlan(p) {
  const sfx = p.part ? `-${p.part}` : "";
  const cwd = join(p.d, p.cli);
  const f = { cwd, sfx, answer: join(p.o, `out-${p.cli}${sfx}.md`) };
  return { cwd, stdin: join(cwd, `prompt${sfx}.md`), stderr: join(p.o, `err-${p.cli}${sfx}.md`), answer: f.answer, ...PLANS[p.cli](p, f) };
}

// The seat's env: the runner's, without what the plan unsets (on Windows whatever the case of a name), with what it sets.
function seatEnv(ctx, plan) {
  const win = ctx.platform === "win32";
  const drop = new Set([...plan.unset, ...(win ? Object.keys(plan.set) : [])].map((k) => (win ? k.toUpperCase() : k)));
  const kept = Object.entries(ctx.env).filter(([k]) => !drop.has(win ? k.toUpperCase() : k));
  return { ...Object.fromEntries(kept), ...plan.set };
}

// The probe called again just before the send, with the model chosen: the guards as the config is now, the MCP
// servers to turn off by name. The model is not chosen again.
function reprobe(ctx, seat, runtime) {
  const run = ctx.probe || localProbe;
  const out = run({ requested: { [seat.cli]: seat.model === CLI_DEFAULT ? null : seat.model }, runtime });
  return (out.seats || []).find((x) => x.cli === seat.cli) || { decision: "unseated", reason: "cli-call-failed", notes: out.notes };
}

function guards(ctx, seat, a) {
  if (seat.model !== CLI_DEFAULT && !safeModel(seat.model)) return { why: "unsafe-model" };
  const exe = which(seat.cli, { env: ctx.env, platform: ctx.platform });
  if (!exe) return { why: "cli-absent" };
  const probed = reprobe(ctx, seat, a.runtime);
  if (probed.decision === "unseated") return { why: `probe:${probed.reason}`, notes: probed.notes || [] };
  return { exe, probed };
}

const policyText = () => {
  try {
    return readFileSync(POLICY, "utf8");
  } catch {
    return null;
  }
};

// The checks a seat must pass in its own folder before anything goes: cmd.exe's words, gemini's policy and a .env
// above the folder, opencode's per-run agent.
async function cliChecks(ctx, seat, plan, exe) {
  const viaCmd = ctx.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  if (viaCmd && [plan.check, plan.args].some((args) => args && cmdLine(exe, args) === null)) return "unsafe-word";
  if (seat.cli === "gemini" && !policyIntact(policyText())) return "gemini-policy";
  if (seat.cli === "gemini" && strayEnvFiles(plan.cwd, { env: ctx.env, platform: ctx.platform }).length) return "gemini-env-file";
  if (!plan.check) return null;
  const r = await runLimited({ exe, args: plan.check, cwd: plan.cwd, env: seatEnv(ctx, plan), stdin: "ignore", stdout: "ignore", stderr: "ignore", limitMs: CHECK_LIMIT_MS });
  return r.exit === 0 ? null : "opencode-agent";
}

// The parts a seat gets: the payload, or its split, each with its two markers and no secret-like line.
function partsOf(payload, n, { id, short, shortSha }) {
  const parts = n ? splitPayload(payload, n, id, short, shortSha) : [payload];
  parts.forEach((part, k) => {
    if (markerCount(part, id) !== 2 || scan(part.toString("utf8")).count) throw new Stop("split", `부분 ${k + 1}/${parts.length} 의 표지나 검사가 맞지 않는다`);
  });
  return parts;
}

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// What a seat's answer and errors say.
function factsOf(cli, plan) {
  const out = readText(plan.answer);
  const err = readText(plan.stderr);
  const facts = { verdicts: out.split(/\r?\n/).map((l) => VERDICT_LINE.exec(l)).filter(Boolean).map((m) => m[1]), empty: !out.trim() };
  if (cli === "codex") facts.ranModel = (/^model: (\S+)/m.exec(err.split("\n").slice(0, 40).join("\n")) || [])[1] || null;
  if (cli === "gemini") Object.assign(facts, { policyError: err.includes("Policy file error"), apiError: err.includes("Full report") });
  if (cli === "opencode") facts.fallback = err.includes("Falling back to default agent");
  const hint = err.split("\n").find((l) => REJECT_HINT.test(l));
  if (hint) facts.rejectHint = hint.trim().slice(0, 200);
  return facts;
}

// A run that ended without an answer to read: why, or null.
function processWhy(r) {
  if (r.error) return "spawn";
  if (r.timedOut) return "timeout";
  if (r.stopped || r.signal) return "signal";
  return null;
}
// An answer that cannot count: why, or null.
function answerWhy(r, f, seat) {
  if (f.policyError) return "policy-file-error";
  if (f.fallback) return "fallback-agent";
  if (r.exit !== 0) return f.rejectHint ? "rejected" : "exit";
  if (f.empty) return "empty";
  if (f.verdicts.length !== 1) return "verdict";
  if (seat.cli === "codex" && seat.model !== CLI_DEFAULT && f.ranModel !== seat.model) return "model-mismatch";
  return null;
}

// Run with @cli-default, codex ran what its config names: the author's own family, or one the probe cannot tell, does not count.
function defaultFamilyWhy(ctx, seat, a, f) {
  if (seat.cli !== "codex" || seat.model !== CLI_DEFAULT) return null;
  if (!f.ranModel || !safeModel(f.ranModel)) return "default-model-family";
  const again = reprobe(ctx, { cli: "codex", model: f.ranModel }, a.runtime);
  return again.decision === "unseated" || again.familyKnown === false ? "default-model-family" : null;
}

export const gathered = (verdicts) => verdicts.reduce((worst, v) => (RANK[v] > RANK[worst] ? v : worst), "APPROVE");

async function runPart(ctx, run, seat, g, part, k, count) {
  const plan = seatPlan({ cli: seat.cli, model: seat.model, effort: run.effort, mcpServers: g.probed.mcpServers || [], d: run.d, o: run.o, id: run.id, policy: POLICY, part: count > 1 ? k + 1 : 0 });
  writeFileSync(plan.stdin, part, { mode: 0o600 });
  if (run.signalled()) return { why: "signal", r: { exit: null, signal: null, secs: 0 }, f: {}, plan };
  const r = await runLimited({ exe: g.exe, args: plan.args, cwd: plan.cwd, env: seatEnv(ctx, plan), stdin: plan.stdin, stdout: plan.stdout, stderr: plan.stderr, limitMs: run.limitMs });
  const f = processWhy(r) ? {} : factsOf(seat.cli, plan);
  const why = processWhy(r) || answerWhy(r, f, seat) || defaultFamilyWhy(ctx, seat, run, f);
  return { why, r, f, plan };
}

const factsShown = (f) => Object.fromEntries(Object.entries({ verdict: f.verdicts?.length === 1 ? f.verdicts[0] : undefined, ranModel: f.ranModel,
  apiError: f.apiError || undefined, rejectHint: f.rejectHint }).filter(([, v]) => v !== undefined && v !== null));

// Sends the parts in order; the first that fails ends the seat's run (the seat is ERROR whatever the rest say).
async function runParts(ctx, run, seat, g, parts, base) {
  const done = [];
  for (const [k, part] of parts.entries()) {
    const one = await runPart(ctx, run, seat, g, part, k, parts.length);
    done.push(one);
    if (one.why) break;
  }
  const last = done[done.length - 1];
  const secs = Math.round(done.reduce((t, x) => t + (x.r.secs || 0), 0) * 10) / 10;
  const result = { ...base, status: last.why ? "failed" : "answered", why: last.why, exit: last.r.exit, signal: last.r.signal, secs,
    answer: last.plan.answer, errors: last.plan.stderr, facts: factsShown(last.f) };
  if (!last.why && parts.length > 1) result.facts.verdict = gathered(done.map((x) => x.f.verdicts[0]));
  if (parts.length > 1) result.parts = done.map((x) => ({ answer: x.plan.answer, errors: x.plan.stderr, why: x.why, facts: factsShown(x.f) }));
  return result;
}

// What a seat's run leaves is taken away when it returns: gemini's record of its folder, this run's opencode session,
// the seat's copy of the payload. What cannot be taken away (a held handle, a virus scanner on Windows) is a note of
// the seat's: the other seats' results still come back, and the lock stays until every seat has ended.
async function afterSeat(ctx, run, seat) {
  const notes = [];
  const copy = join(run.d, seat.cli);
  try {
    if (seat.cli === "gemini") notes.push(...cleanSeat(copy, { env: ctx.env, platform: ctx.platform }).skipped.map((p) => `gemini 기록 폴더를 남김: ${p}`));
    if (seat.cli === "opencode") await opencodeSessions({ ...ctx, d: run.d, id: run.id }, []);
  } catch (e) {
    notes.push(`좌석 기록을 지우지 못했다(${e.code || e.message})`);
  }
  try {
    rmSync(copy, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    notes.push(`사본을 지우지 못했다: ${copy} (${e.code || e.message})`);
  }
  return notes;
}

async function seatWork(ctx, run, seat, g, payload, base) {
  const plan = seatPlan({ cli: seat.cli, model: seat.model, effort: run.effort, mcpServers: g.probed.mcpServers || [], d: run.d, o: run.o, id: run.id, policy: POLICY });
  const why = await cliChecks(ctx, seat, plan, g.exe);
  if (why) return { ...base, why };
  let parts;
  try {
    parts = partsOf(payload, run.split[seat.cli], run);
  } catch (e) {
    if (e instanceof Stop) return { ...base, why: "split", notes: [e.message] };
    throw e;
  }
  if (run.dryRun) return { ...base, status: "planned", plan: { exe: g.exe, cwd: plan.cwd, args: plan.args, set: plan.set, unset: plan.unset, check: plan.check, parts: parts.length } };
  return runParts(ctx, run, seat, g, parts, base);
}

// The seat CLI's version, read without starting gemini or opencode: codex's from the probe's `codex --version`, the
// others' from the package.json of their npm package (beside the entry point, above its real path, or under the
// prefix's lib/node_modules), opencode's own installer folder holding the plugin package of its version.
const PACKAGES = { codex: "@openai/codex", gemini: "@google/gemini-cli", opencode: "opencode-ai" };
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
function installedVersion(cli, exe) {
  const real = realOr(exe);
  const pkg = PACKAGES[cli].split("/");
  const tries = [join(dirname(exe), "node_modules", ...pkg, "package.json"), join(dirname(dirname(exe)), "lib", "node_modules", ...pkg, "package.json")];
  for (let dir = dirname(real), k = 0; k < 5; k += 1, dir = dirname(dir)) tries.push(join(dir, "package.json"));
  const found = tries.map(readJson).find((j) => j?.name === PACKAGES[cli] && typeof j.version === "string");
  if (found) return found.version;
  const own = cli === "opencode" ? readJson(join(dirname(dirname(real)), "package.json"))?.dependencies?.["@opencode-ai/plugin"] : null;
  return typeof own === "string" ? `${own} (설치 폴더의 @opencode-ai/plugin)` : null;
}
export function cliVersion(cli, exe, probed) {
  if (cli === "codex" && probed?.version) return String(probed.version).slice(0, 80);
  return installedVersion(cli, exe) || "알 수 없음";
}

async function sendSeat(ctx, run, seat, payload) {
  const none = { seat: seat.cli, model: seat.model, status: "not-sent", why: null, exit: null, signal: null, secs: 0, answer: null, errors: null, facts: {}, notes: [] };
  const g = guards(ctx, seat, run);
  if (g.why) return { ...none, why: g.why, notes: g.notes || [] };
  const base = { ...none, cliVersion: cliVersion(seat.cli, g.exe, g.probed) };
  let result;
  try {
    mkdirSync(join(run.d, seat.cli), { recursive: true, mode: 0o700 });
    result = await seatWork(ctx, run, seat, g, payload, base);
  } catch (e) {
    // the runner's own error in this seat's work (its copy cannot be written: ENOSPC, EACCES, a Windows lock) is this
    // seat's failure: the other seats go on, and the lock and the stop handlers hold until they end
    if (e instanceof RunStop) throw e;
    result = { ...base, status: "failed", why: "spawn", notes: [`좌석을 준비하지 못했다(${e.code || e.message})`] };
  } finally {
    const notes = await afterSeat(ctx, run, seat);
    if (result) result.notes = [...(result.notes || []), ...notes];
  }
  return result;
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
// A stop the runner asks of the send's node over their channel, or the channel closing (the runner is gone): it stops
// the send as that signal would, also when it comes before the send watches for signals.
const asked = { sig: null, on: null };
function askStop(sig) {
  if (asked.sig) return;
  asked.sig = sig;
  if (asked.on) asked.on(sig);
}

// SIGINT, SIGTERM and SIGHUP end every seat (TERM to its group, KILL 2 s later), the seats' records are still cleaned,
// and send ends with 128 + the signal's number; past 30 s it ends anyway.
function watchSignals() {
  let code = 0;
  const stop = (sig) => {
    if (code) return;
    code = 128 + (osConstants.signals[sig] || 0);
    stopAll();
    setTimeout(() => process.exit(code), 30000).unref();
  };
  const handlers = STOP_SIGNALS.map((sig) => [sig, () => stop(sig)]);
  for (const [sig, h] of handlers) process.on(sig, h);
  asked.on = stop;
  if (asked.sig) stop(asked.sig);
  return {
    code: () => code,
    off: () => {
      asked.on = null;
      handlers.forEach(([sig, h]) => process.off(sig, h));
    },
  };
}

const DEST = {
  codex: () => "config.toml 이 정한 프로바이더",
  gemini: () => "사용자 설정의 인증",
  opencode: (x) => (x.model === CLI_DEFAULT ? "opencode 설정의 프로바이더" : `${x.model.split("/")[0]}(-m 의 프로바이더)`),
};
const unsentCount = (d) => readText(join(d, "unsent.md")).split("\n").filter(Boolean).length;
// The line the report carries: where the payload went, its size, the scan, the new files left out.
function declared(run, bytes, seats, d) {
  const went = seats.filter((x) => x.status !== "not-sent").map((x) => `${x.seat} 는 ${DEST[x.seat](x)}`);
  const head = run.dryRun ? "외부 전송(선언, dry-run 이라 보내지 않음)" : "외부 전송(선언)";
  return `${head}: ${went.join(", ") || "보낸 좌석 없음"}, 페이로드 ${bytes}B, 비밀 검사 0건, 보내지 않은 새 파일 ${unsentCount(d)}`;
}

function sendStart(o, ctx, a) {
  const { d, o: out } = runPair(o.dir, ctx);
  if (!out) throw new Stop("not-a-run-folder", `답 폴더(ralph-qa-out.*)가 없다: ${d}`);
  refuseSent(d);
  if (ctx.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" && !a.dryRun) throw new Stop("sandboxed", "Codex sandbox 가 네트워크를 막는다. 승인을 받아 sandbox 밖에서 send 를 다시 한다");
  const { id, short, shortsha } = readRun(d);
  const payload = payloadToSend(d, id, Boolean(o["allow-large"]));
  return { d, out, id, payload, short: Number(short), shortSha: shortsha || null };
}

const resultJson = (command, result) => `${JSON.stringify({ command, ...result }, null, 2)}\n`;
const writeResult = (dir, name, json) => {
  try {
    writeFileSync(join(dir, `result-${name}.md`), json, { mode: 0o600 });
  } catch {
    /* the JSON on stdout is the answer */
  }
};

// A send that went out writes result-send.md before the lock goes back, so the next send to take the lock finds it
// (report writes it again with the same JSON).
async function send(o, ctx) {
  const a = sendArgs(o);
  const { d, out, id, payload, short, shortSha } = sendStart(o, ctx, a);
  const lock = holdFolder(d, ctx.now());
  const touch = keepFresh(lock);
  const signals = watchSignals();
  const run = { ...a, d, o: out, id, short, shortSha, signalled: () => signals.code() !== 0 };
  try {
    // every seat settles before the lock goes back and the stop handlers go away
    const settled = await Promise.allSettled(a.seats.map((x) => sendSeat(ctx, run, x, payload)));
    const thrown = settled.find((x) => x.status === "rejected");
    if (thrown) throw thrown.reason;
    const seats = settled.map((x) => x.value);
    if (!a.dryRun) appendFileSync(join(d, "run.md"), seats.filter((x) => x.cliVersion).map((x) => `cli-${x.seat} ${x.cliVersion}\n`).join(""), { mode: 0o600 });
    const result = { ok: true, ...(a.dryRun ? { dryRun: true } : {}), dir: d, out, bytes: payload.length, scan: 0, unsent: unsentCount(d), seats, declared: declared(run, payload.length, seats, d) };
    if (!a.dryRun) writeResult(d, "send", resultJson("send", result));
    return [result, signals.code(), a.dryRun ? null : d];
  } finally {
    clearInterval(touch);
    signals.off();
    giveBack(lock);
  }
}

const COMMANDS = { init, untracked: listUntracked, prepare, check, send, cleanup, put };

// The JSON on stdout and in <d>/result-<command>.md (not for cleanup: the folder is gone).
function report(ctx, command, dir, result, code, name = command) {
  const json = resultJson(command, result);
  ctx.stdout.write(json);
  if (result.message) ctx.stderr.write(`${result.message}\n`);
  if (dir) writeResult(dir, name, json);
  return code;
}

// A stop in the folder it concerns, when that is a run folder.
const folderOf = (o, ctx) => {
  try {
    return o.dir ? runPair(o.dir, ctx).d : null;
  } catch {
    return null;
  }
};

// A send that stopped goes to result-send-stop.md: result-send.md says the folder was sent, and a stopped send sent nothing.
const stopName = (command) => (command === "send" ? "send-stop" : command);

// A stop of run-folder.mjs carries no name: this runner's goes before it.
const named = (message) => (message.startsWith("ralph-qa: ") ? message : `ralph-qa: ${message}`);

function failed(ctx, { command, o }, e) {
  if (e instanceof Usage) {
    ctx.stderr.write(`ralph-qa: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (!(e instanceof RunStop)) {
    ctx.stderr.write(`ralph-qa: 실행기 내부 오류(${e?.code || e?.name || "error"}): ${String(e?.message || e).split("\n")[0]}\n`);
    return 2;
  }
  const result = { ok: false, stop: e.code, message: named(e.message), detail: e.detail };
  return report(ctx, command, folderOf(o, ctx), result, EXIT_OF[e.code] || 3, stopName(command));
}

// ---- the send's own node ----

// send runs in a second node, started here with a channel to it: a kill of this process alone (kill -9, Task Manager)
// runs none of its handlers and would leave the seats running past their limit, but closes the channel, and the
// second node then stops the send itself. It is detached: Windows ends the children a node started undetached when
// that node dies (libuv's job object), and a kill of this process's group does not reach it. It has no output of its
// own (a detached Windows process has no console): what it prints comes over the channel and is printed here. A stop
// signal here goes to it over the channel too. Its exit code is the send's.
function sendViaWorker(argv, ctx) {
  return new Promise((done) => {
    let reported = null;
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      forward.forEach(([sig, h]) => process.off(sig, h));
      done(code);
    };
    const child = fork(fileURLToPath(import.meta.url), ["send-worker", ...argv.slice(1)],
      { env: ctx.env, stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true, windowsHide: true });
    const forward = STOP_SIGNALS.map((sig) => [sig, () => child.connected && child.send({ stop: sig }, () => {})]);
    for (const [sig, h] of forward) process.on(sig, h);
    child.on("message", (m) => {
      if (m && typeof m.out === "string") ctx.stdout.write(m.out);
      if (m && typeof m.err === "string") ctx.stderr.write(m.err);
      if (m && Number.isInteger(m.done)) reported = m.done;
    });
    child.on("error", (e) => {
      ctx.stderr.write(`ralph-qa: send 를 맡을 node 를 띄우지 못했다(${e.code || e.message})\n`);
      settle(2);
    });
    // close, not exit: it comes after the channel is closed, so the node's last message is in
    child.on("close", (code, signal) => {
      if (settled) return;
      if (reported === null) ctx.stderr.write(`ralph-qa: send 를 맡은 node 가 결과 없이 끝났다(${signal || `종료 ${code}`}). 좌석이 아직 돌 수 있다. 남은 좌석 기록과 사본은 다음 cleanup 이 지운다\n`);
      settle(reported === null ? 2 : reported);
    });
  });
}

// What the send's node prints goes to the runner over the channel; with the runner gone it is dropped (the result
// files in the folder stay).
const relay = (key) => ({ write: (text) => process.connected && process.send({ [key]: String(text) }, () => {}) });

// The send's node: a message from the runner is a signal the runner got, the channel closing means the runner is gone.
async function workerMain(argv, ctx) {
  if (typeof process.send !== "function") {
    ctx.stderr.write(`ralph-qa: send-worker 는 send 가 띄우는 내부 명령이다\n${USAGE}`);
    return 2;
  }
  process.on("message", (m) => {
    if (m && STOP_SIGNALS.includes(m.stop)) askStop(m.stop);
  });
  process.on("disconnect", () => askStop("SIGTERM"));
  if (!process.connected) askStop("SIGTERM");
  const code = await runCommand(["send", ...argv.slice(1)], { ...ctx, stdout: relay("out"), stderr: relay("err") });
  if (process.connected) process.send({ done: code }, () => process.connected && process.disconnect());
  return code;
}

async function runCommand(argv, ctx) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return failed(ctx, { command: argv[0], o: {} }, e);
  }
  for (const k of ["repo", "dir"]) if (k in parsed.o) parsed.o[k] = fromMsys(parsed.o[k], ctx.platform);
  try {
    const [result, code, dir] = await COMMANDS[parsed.command](parsed.o, ctx);
    return report(ctx, parsed.command, dir, result, code);
  } catch (e) {
    return failed(ctx, parsed, e);
  }
}

export async function main(argv, io = {}) {
  const ctx = {
    env: io.env || process.env, platform: io.platform || process.platform, stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr,
    stdin: io.stdin, probe: io.probe, now: io.now || Date.now,
  };
  if (argv[0] === "send-worker") return workerMain(argv, ctx);
  if (argv[0] === "send") {
    try {
      parseArgs(argv);
    } catch (e) {
      return failed(ctx, { command: "send", o: {} }, e);
    }
    return sendViaWorker(argv, ctx);
  }
  return runCommand(argv, ctx);
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
