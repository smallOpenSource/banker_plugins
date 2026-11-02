#!/usr/bin/env node
/**
 * service.mjs: starts, stops and reports one background service of this project (made by banker init-dir).
 *
 *   ./scripts/start.sh | stop.sh | status.sh | restart.sh        (Windows: the .cmd files of the same names)
 *   node scripts/lib/service.mjs start|stop|status|restart
 *
 * Settings: scripts/service.conf, `name=` (default app) and `command=` (run through the shell, in the project
 * folder). `start` launches a detached supervisor that runs the command as its child and writes the child's
 * stdout to logs/<name>.out.log and stderr to logs/<name>.err.log. Before a write that would take a file past
 * 100MB it rotates: <name>.out.log becomes <name>.out.1.log and so on, at most 7 files per stream with the
 * current one. If a rotation fails (a reader holds a file open on Windows) a `service:` warning goes to the
 * stderr log and writing goes on in the current file. logs/<name>.pid holds {supervisor, child, startedAt, command}.
 *
 * Before a recorded PID counts as this service (already running, status, a signal from stop) it is checked: a pid
 * file older than the last boot is stale, and the process's command line must hold service.mjs and __supervise
 * (the supervisor) or the recorded command (the child). Linux reads it from /proc/<pid>/cmdline, then `ps`; other
 * POSIX systems use `ps`, Windows PowerShell Get-CimInstance. A PID that fails the check gets no signal and the pid
 * file counts as stale. When a live PID's command line cannot be read at all (no /proc, no ps), start, stop, status
 * and restart print "확인 불가: <사유>", send no signal, keep the pid file and exit 1.
 *
 * `stop` sends SIGTERM to the supervisor, which passes it to the child's process group; after 10 seconds both
 * are killed. With the supervisor gone, the child is stopped directly. Windows uses taskkill /T and, when the
 * grace time has passed, taskkill /T /F (stop and the supervisor alike).
 * If the supervisor dies the child may die of SIGPIPE at its next write; `status` reports both separately.
 * On Windows the child is the shell, which dies with the supervisor (its job object); what the shell ran lives on
 * and counts as the child when its parent is the recorded shell PID and its command line holds the command.
 *
 * Exit status: 0 done (status: supervisor and child running), 1 failed (died within the start check, could not
 * stop, status found it not fully running), 2 settings (command= empty, bad name, usage), 3 environment (the
 * wrappers did not find Node 18 or later).
 *
 * Two `start` runs at once launch one supervisor: start holds logs/<name>.start.lock (made with O_EXCL, holding its
 * pid and time, removed when it ends). A later start waits for it, then sees the service running. A lock whose pid
 * is dead, is another program, or is older than 30 seconds plus the start check is removed, by one start at a time:
 * the one holding logs/<name>.start.lock.break (O_EXCL), which reads the lock again and removes only the lock it
 * judged stale. A link or a folder at either name is refused (exit 1), a link to nothing among them: Windows opens
 * O_EXCL through such a link and makes the file it leads to, so the name is looked at before the open and again after.
 *
 * Environment (tuning): SERVICE_LOG_ROTATE_BYTES (default 104857600), SERVICE_STOP_GRACE_MS (10000),
 * SERVICE_START_CHECK_MS (2000).
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(dirname(SELF));
const ROOT = dirname(SCRIPTS);
const LOGS = join(ROOT, "logs");
const KEEP = 7;
const WIN = process.platform === "win32";
const USAGE = "사용법: service.mjs start|stop|status|restart";

const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const ROTATE_BYTES = envInt("SERVICE_LOG_ROTATE_BYTES", 100 * 1024 * 1024);
const STOP_GRACE_MS = envInt("SERVICE_STOP_GRACE_MS", 10000);
const START_CHECK_MS = envInt("SERVICE_START_CHECK_MS", 2000);
const BOOT_SLACK_MS = 5000;
const LOCK_STALE_MS = 30000 + START_CHECK_MS;
const LOCK_WAIT_MS = 5000 + START_CHECK_MS;
const BREAK_STALE_MS = 5000;
// On Windows a file being deleted while another process has it open answers EPERM, EACCES or EBUSY: busy, try again.
const BUSY = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseConf(text) {
  const conf = { name: "app", command: "" };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line.startsWith("#") || eq <= 0) continue;
    conf[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return conf;
}

// The settings, or { error } with exit status 2. needCommand: start, restart and the supervisor need command=.
function readConf(needCommand) {
  const file = join(SCRIPTS, "service.conf");
  if (!existsSync(file)) return { error: `설정 파일 없음: ${file}` };
  const conf = parseConf(readFileSync(file, "utf8"));
  if (!/^[A-Za-z0-9._-]+$/.test(conf.name)) return { error: `service.conf 의 name 은 영문, 숫자, . _ - 만 씀: ${conf.name}` };
  if (needCommand && conf.command === "") return { error: `service.conf 의 command= 가 비어 있음: ${file}` };
  return conf;
}

const pathsOf = (name) => ({
  pid: join(LOGS, `${name}.pid`),
  out: join(LOGS, `${name}.out.log`),
  err: join(LOGS, `${name}.err.log`),
});
const nth = (file, i) => (i === 0 ? file : file.replace(/\.log$/, `.${i}.log`));

function readPid(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// A fresh temp file with a random name (no one can plant a link at it first), renamed over the pid file.
function writePid(file, value) {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Removes the pid file when it still names this supervisor.
function dropPid(file, supervisor) {
  if (readPid(file)?.supervisor === supervisor) rmSync(file, { force: true });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// The child runs in its own process group on POSIX: the group is alive while any member is.
function groupAlive(pid) {
  if (WIN || !Number.isInteger(pid) || pid <= 0) return alive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM" || alive(pid);
  }
}

function taskkill(pid, force) {
  spawnSync("taskkill", ["/T", ...(force ? ["/F"] : []), "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
}

// The child's whole tree: its process group on POSIX, taskkill /T on Windows (/F for SIGKILL).
function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (WIN) return taskkill(pid, signal === "SIGKILL");
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      // gone already, or no group: try the next form
    }
  }
}

// Moves file.5 to file.6 and so on down to file to file.1; the oldest (file.6) goes.
function shift(file) {
  rmSync(nth(file, KEEP - 1), { force: true });
  for (let i = KEEP - 2; i >= 0; i--) if (existsSync(nth(file, i))) renameSync(nth(file, i), nth(file, i + 1));
}

// A log file that rotates before a write would take it past ROTATE_BYTES. A failed rotation calls warn once until
// a rotation works again.
function openLog(file, warn) {
  let fd = openSync(file, "a");
  let size = statSync(file).size;
  let warned = false;
  const rotate = () => {
    closeSync(fd);
    let failure = null;
    try {
      shift(file);
    } catch (e) {
      // a reader holds a file open (Windows): keep writing to the current one and try again at the next write
      failure = e;
    } finally {
      fd = openSync(file, "a");
      size = statSync(file).size;
    }
    if (!failure) warned = false;
    else if (!warned) {
      warned = true;
      warn(`로그 로테이션 실패(${file}: ${failure.code || failure.message}). 현재 파일에 이어 씀`);
    }
  };
  const write = (chunk) => {
    for (let at = 0; at < chunk.length; ) {
      const piece = Math.min(chunk.length - at, ROTATE_BYTES);
      if (size > 0 && size + piece > ROTATE_BYTES) rotate();
      writeSync(fd, chunk, at, piece);
      size += piece;
      at += piece;
    }
  };
  return { write, close: () => closeSync(fd) };
}

function supervise(conf) {
  const p = pathsOf(conf.name);
  let err = null;
  // The supervisor has no terminal (stdio ignored), so its warnings go to the stderr log as `service:` lines.
  const warn = (text) => err?.write(Buffer.from(`service: ${text}\n`));
  const out = openLog(p.out, warn);
  err = openLog(p.err, warn);
  // Not detached on Windows: a detached shell has no console, so what it runs gets a new console of its own (its
  // output goes there, not into the logs). See orphanOf for what this costs when the supervisor dies.
  const child = spawn(conf.command, { shell: true, cwd: ROOT, detached: !WIN, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (c) => out.write(c));
  child.stderr.on("data", (c) => err.write(c));
  child.on("error", (e) => warn(e.message));
  writePid(p.pid, { supervisor: process.pid, child: child.pid ?? null, startedAt: new Date().toISOString(), command: conf.command });
  let killTimer = null;
  const term = () => {
    signalGroup(child.pid, "SIGTERM");
    killTimer ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", term);
  if (!WIN) process.on("SIGHUP", () => {});
  child.on("close", (code) => {
    clearTimeout(killTimer);
    out.close();
    err.close();
    dropPid(p.pid, process.pid);
    process.exit(code ?? 1);
  });
}

function tail(file, lines) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

// Linux: /proc/<pid>/cmdline with its NULs as spaces; { text: "" } when the process is gone, null without /proc.
function procCommandLine(pid) {
  if (process.platform !== "linux" || !existsSync("/proc/self/cmdline")) return null;
  try {
    return { text: readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ").trim() };
  } catch (e) {
    return e.code === "ENOENT" ? { text: "" } : null;
  }
}

// The command line of a process: { text } ("" when it is gone) or { why } when it cannot be read.
function commandLine(pid) {
  return procCommandLine(pid) ?? toolCommandLine(pid);
}

// `ps` on POSIX, PowerShell on Windows.
function toolCommandLine(pid) {
  const r = WIN
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 20000 })
    : spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 });
  if (r.error) return { why: r.error.code || r.error.message };
  if (r.status === 0) return { text: r.stdout.trim() };
  if (!WIN && r.status === 1 && !r.stdout.trim() && !r.stderr.trim()) return { text: "" };
  return { why: r.stderr.trim().split(/\r?\n/)[0] || `종료 ${r.status}` };
}

// Quotes, backslashes and runs of spaces differ between a shell command and the argv a process shows.
const squash = (s) => String(s).replace(/["'\\]/g, "").replace(/\s+/g, " ").trim();
const isSupervisor = (text) => text.includes("service.mjs") && text.includes("__supervise");
const isChild = (command) => (text) => typeof command === "string" && squash(command) !== "" && squash(text).includes(squash(command));

// { ok: true } this service's, {} another process, { unknown } its command line could not be read.
function confirm(pid, label, test) {
  const line = commandLine(pid);
  if (line.why) return { unknown: `${label} PID ${pid} 의 명령줄을 읽지 못함(${line.why})` };
  if (test(line.text)) return { ok: true };
  console.error(`${label} PID ${pid} 는 이 서비스가 아님(명령줄이 기록과 다름): 신호를 보내지 않고 낡은 PID 파일로 봄`);
  return {};
}

// Why the pid file is older than the last boot (its PIDs then belong to other processes), or null.
function staleWhy(cur) {
  const at = Date.parse(cur.startedAt);
  if (Number.isNaN(at)) return "startedAt 없음";
  return at < Date.now() - uptime() * 1000 - BOOT_SLACK_MS ? `startedAt ${cur.startedAt} 이 마지막 부팅보다 이름` : null;
}

// The recorded PIDs that are this service's: { supervisor, child, unknown }, each PID or null. A live PID that does
// not count says why on stderr and gets no signal. The child of a confirmed supervisor counts with it. unknown is
// why a live PID could not be checked: the callers then stop with exit 1 and keep the pid file.
function owned(cur) {
  const none = { supervisor: null, child: null, unknown: null };
  if (!cur) return none;
  const orphan = !alive(cur.supervisor) && !groupAlive(cur.child) ? orphanOf(cur) : null;
  const rec = orphan ? { ...cur, child: orphan } : cur;
  if (!alive(rec.supervisor) && !groupAlive(rec.child)) return none;
  const stale = staleWhy(rec);
  if (stale) {
    console.error(`PID 파일이 낡음(${stale}): 기록된 PID 에 신호를 보내지 않음`);
    return none;
  }
  return checkLive(rec);
}

// Windows: the child is the shell (cmd.exe) in the supervisor's job object, so it dies with the supervisor, while
// what it ran has left the job and lives on with the dead shell's PID as its parent. That process is the child
// when its command line holds the recorded command. null elsewhere, or when none is found or readable.
function orphanOf(cur) {
  if (!WIN || !Number.isInteger(cur.child) || cur.child <= 0) return null;
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${cur.child}" | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => isChild(cur.command)(l.slice(l.indexOf(" ") + 1)));
  return hit ? Number.parseInt(hit, 10) : null;
}

function checkLive(cur) {
  const sup = alive(cur.supervisor) ? confirm(cur.supervisor, "감독", isSupervisor) : {};
  const kid = !groupAlive(cur.child) ? {} : sup.ok ? { ok: true } : confirm(cur.child, "자식", isChild(cur.command));
  return { supervisor: sup.ok ? cur.supervisor : null, child: kid.ok ? cur.child : null, unknown: sup.unknown ?? kid.unknown ?? null };
}

function unverifiable(own) {
  console.error(`확인 불가: ${own.unknown}. 신호를 보내지 않고 PID 파일을 남김`);
  return 1;
}

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const lockInfo = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const holders = new Map();

// Whether the lock (text as read) belongs to a start still at work: its pid alive, younger than LOCK_STALE_MS, and
// the pid's command line holds service.mjs (read once per lock; unreadable counts as its own, the age decides).
function lockBusy(text, st) {
  const info = lockInfo(text);
  const at = Date.parse(info?.at);
  if (Date.now() - (Number.isNaN(at) ? st.mtimeMs : at) > LOCK_STALE_MS) return false;
  if (!info) return true; // just made, its pid not written yet
  if (!alive(info.pid)) return false;
  if (!holders.has(text)) {
    const line = commandLine(info.pid);
    holders.set(text, line.why !== undefined || line.text.includes("service.mjs"));
  }
  return holders.get(text);
}

// One file made with O_EXCL holding this start's pid and time: { text } made, { code } not (EEXIST: there is one).
// Anything at the name, a link to nothing among them, is EEXIST: Windows opens O_EXCL through a link to nothing and
// makes the file it leads to (macOS and Linux answer EEXIST), so the name is looked at first, and after the open,
// before anything is written, the opened file is compared with the name: a name gone, a link or another file is EEXIST
// (an empty file made through a link is taken back). A look that cannot be made (ESTALE, EPERM) writes as a plain
// O_EXCL open would. A write that fails takes the empty lock away again.
function makeLockFile(file) {
  const text = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  try {
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) return { code: "EEXIST" };
    const fd = openSync(file, "wx");
    try {
      let made = null;
      try {
        made = fstatSync(fd, { bigint: true });
      } catch {
        // cannot look: the name is not judged
      }
      if (namesOpened(file, made) === false) return { code: "EEXIST" };
      try {
        writeSync(fd, text);
      } catch (e) {
        if (namesOpened(file, made) === true) rmSync(file, { force: true });
        throw e;
      }
    } finally {
      closeSync(fd);
    }
    return { text };
  } catch (e) {
    return { code: e.code };
  }
}

// Whether the name is the opened file (made): true, false (gone, a link, another file), or null when it cannot be
// told (a look that fails, no file ids). A link: the empty file made through it is taken back, and false.
function namesOpened(file, made) {
  let st;
  try {
    st = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (!st) return false;
  if (st.isSymbolicLink()) {
    if (!made) return false;
    try {
      const target = realpathSync(file);
      const at = statSync(target, { bigint: true });
      if (at.dev === made.dev && at.ino === made.ino && at.size === 0n) rmSync(target, { force: true });
    } catch {
      // the link changed again: nothing of ours to find
    }
    return false;
  }
  if (!made || made.ino === 0n) return null;
  return st.dev === made.dev && st.ino === made.ino;
}

// lstat that answers undefined for a missing file and null for one busy being deleted (the next try sees).
function lstatNow(file) {
  try {
    return lstatSync(file, { throwIfNoEntry: false });
  } catch (e) {
    if (BUSY.has(e.code)) return null;
    throw e;
  }
}

// rm that leaves a busy file for the next try (a lock left so has a dead pid once this start ends: stale).
function rmNow(file) {
  try {
    rmSync(file, { force: true });
  } catch (e) {
    if (!BUSY.has(e.code)) throw e;
  }
}

// Removes a break lock older than BREAK_STALE_MS (clearing takes milliseconds, so its start is taken as dead or
// stuck), and only when it is still the text judged old when read again (a newer break lock is left alone).
function clearStaleBreak(brk, st) {
  const text = readText(brk);
  const at = Date.parse(lockInfo(text)?.at);
  if (Date.now() - (Number.isNaN(at) ? st.mtimeMs : at) > BREAK_STALE_MS && readText(brk) === text) rmNow(brk);
}

// The break lock could not be made (code): another start holds it, or it was left. { error } for a link or a folder.
function breakHeld(brk, code) {
  const st = BUSY.has(code) ? lstatNow(brk) : undefined;
  if (st && !st.isFile()) return { error: `시작 잠금 정리 자리에 일반 파일이 아닌 것(링크나 폴더)이 있어 거부: ${brk}` };
  if (st) clearStaleBreak(brk, st);
  return {};
}

// Removes a stale lock (seen: its text as judged). Only the start holding <lock>.break does it, and only when the lock
// read again under the break lock is the same text and still not busy, so a lock another start made after the
// first read is never removed. Another start holding the break lock leaves the work to it. Returns { error } when a
// link or a folder sits at the break lock's name, else {}.
function breakStale(file, seen) {
  const brk = `${file}.break`;
  const made = makeLockFile(brk);
  if (!made.text) return breakHeld(brk, made.code);
  try {
    const st = lstatNow(file);
    if (st && st.isFile() && readText(file) === seen && !lockBusy(seen, st)) rmNow(file);
  } finally {
    if (readText(brk) === made.text) rmNow(brk);
  }
  return {};
}

// Makes the lock or looks at what is there: { text } made, or { st } (undefined: gone, null: busy being deleted).
// When nothing is there and the open failed for another reason than EEXIST (no write access and the like), one more
// open (a Windows file being deleted can be gone by the lstat), then it throws.
function makeOrSee(file) {
  for (let i = 0; ; i++) {
    const made = makeLockFile(file);
    if (made.text) return made;
    const st = lstatNow(file);
    if (st !== undefined || made.code === "EEXIST") return { st };
    if (i) throw Object.assign(new Error(`시작 잠금을 만들지 못함(${made.code}): ${file}`), { code: made.code });
  }
}

// One try at the lock: { text } held, { error } refused, or {} busy.
function tryLock(file) {
  const got = makeOrSee(file);
  if (got.text) return got;
  const { st } = got;
  if (!st) return {}; // gone or busy being deleted: the next try sees
  if (!st.isFile()) return { error: `시작 잠금 자리에 일반 파일이 아닌 것(링크나 폴더)이 있어 거부: ${file}` };
  const seen = readText(file);
  return seen !== null && !lockBusy(seen, st) ? breakStale(file, seen) : {};
}

// logs/<name>.start.lock, waiting up to LOCK_WAIT_MS for another start: { text } or { error }.
async function takeLock(file) {
  for (const until = Date.now() + LOCK_WAIT_MS; ; await sleep(100)) {
    const r = tryLock(file);
    if (r.text || r.error) return r;
    if (Date.now() >= until) return { error: `다른 start 가 ${LOCK_WAIT_MS}ms 넘게 진행 중: ${file}. 잠시 뒤 다시 실행하세요` };
  }
}

async function start(conf) {
  mkdirSync(LOGS, { recursive: true });
  const lock = join(LOGS, `${conf.name}.start.lock`);
  const held = await takeLock(lock);
  if (held.error) return say(console.error, held.error, 1);
  try {
    return await startLocked(conf);
  } finally {
    if (readText(lock) === held.text) rmNow(lock);
  }
}

async function startLocked(conf) {
  const p = pathsOf(conf.name);
  const cur = readPid(p.pid);
  const own = owned(cur);
  if (own.unknown) return unverifiable(own);
  if (own.supervisor) {
    console.log(`이미 실행 중: ${conf.name} (감독 PID ${cur.supervisor}, 자식 PID ${cur.child})`);
    return 0;
  }
  if (own.child) {
    console.error(`감독 없이 자식이 살아 있음(PID ${own.child}). 먼저 stop 을 실행하세요`);
    return 1;
  }
  rmSync(p.pid, { force: true });
  const sup = spawn(process.execPath, [SELF, "__supervise"], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true });
  sup.unref();
  await sleep(START_CHECK_MS);
  const now = readPid(p.pid);
  if (now?.supervisor === sup.pid && alive(now.supervisor) && groupAlive(now.child)) {
    console.log(`시작함: ${conf.name} (감독 PID ${now.supervisor}, 자식 PID ${now.child})`);
    return 0;
  }
  console.error(`시작 뒤 ${START_CHECK_MS}ms 안에 멈춤: ${conf.name}. 로그: ${p.err}`);
  for (const line of tail(p.err, 5)) console.error(`  ${line}`);
  return 1;
}

function kill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // gone already
  }
}

// Asks the supervisor (or, with it gone, the child) to stop; force kills both. own holds only confirmed PIDs.
function terminate(own, force) {
  if (WIN) return taskkill(own.supervisor ?? own.child, force);
  if (!force) return own.supervisor ? kill(own.supervisor, "SIGTERM") : signalGroup(own.child, "SIGTERM");
  if (own.child) signalGroup(own.child, "SIGKILL");
  if (own.supervisor) kill(own.supervisor, "SIGKILL");
}

async function waitGone(own, ms) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) {
    if (!alive(own.supervisor) && !groupAlive(own.child)) return true;
  }
  return !alive(own.supervisor) && !groupAlive(own.child);
}

async function stop(conf) {
  const p = pathsOf(conf.name);
  const cur = readPid(p.pid);
  const own = owned(cur);
  if (own.unknown) return unverifiable(own);
  if (!own.supervisor && !own.child) {
    rmSync(p.pid, { force: true });
    console.log(`실행 중 아님: ${conf.name}`);
    return 0;
  }
  terminate(own, false);
  const gone = (await waitGone(own, STOP_GRACE_MS)) || (terminate(own, true), await waitGone(own, 3000));
  if (!gone) {
    console.error(`멈추지 못함: ${conf.name} (감독 PID ${cur.supervisor}, 자식 PID ${own.child ?? cur.child})`);
    return 1;
  }
  rmSync(p.pid, { force: true });
  console.log(`멈춤: ${conf.name}`);
  return 0;
}

function logLine(file) {
  const files = Array.from({ length: KEEP }, (_, i) => nth(file, i)).filter((f) => existsSync(f));
  const bytes = files.reduce((sum, f) => sum + statSync(f).size, 0);
  return `${file} (파일 ${files.length}개, 합계 ${bytes} 바이트)`;
}

function status(conf) {
  const p = pathsOf(conf.name);
  const cur = readPid(p.pid) ?? {};
  const own = owned(cur);
  if (own.unknown) return unverifiable(own);
  const sup = own.supervisor !== null;
  const child = own.child !== null;
  console.log(`서비스: ${conf.name}`);
  console.log(`감독: ${sup ? `실행 중 (PID ${cur.supervisor})` : "없음"}`);
  console.log(`자식: ${child ? `실행 중 (PID ${own.child})` : "없음"}`);
  console.log(`표준 출력 로그: ${logLine(p.out)}`);
  console.log(`표준 오류 로그: ${logLine(p.err)}`);
  return sup && child ? 0 : 1;
}

async function restart(conf) {
  const code = await stop(conf);
  return code === 0 ? start(conf) : code;
}

const COMMANDS = { start, stop, status, restart };
const NEEDS_COMMAND = new Set(["start", "restart", "__supervise"]);

const HELP = new Set(["--help", "-h"]);
const say = (write, text, code) => {
  write(text);
  return code;
};

async function main(argv) {
  const cmd = argv[0];
  if (HELP.has(cmd)) return say(console.log, USAGE, 0);
  if (!Object.hasOwn(COMMANDS, cmd ?? "") && cmd !== "__supervise") return say(console.error, USAGE, 2);
  const conf = readConf(NEEDS_COMMAND.has(cmd));
  if (conf.error) return say(console.error, conf.error, 2);
  if (cmd !== "__supervise") return COMMANDS[cmd](conf);
  supervise(conf);
  return null;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (e) => {
    console.error(`service: ${e.message}`);
    process.exitCode = 1;
  },
);
