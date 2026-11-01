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
 * (the supervisor) or the recorded command (the child). POSIX reads it with `ps`, Windows with PowerShell
 * Get-CimInstance. A PID that fails the check, or whose command line cannot be read, gets no signal; the reason
 * is printed.
 *
 * `stop` sends SIGTERM to the supervisor, which passes it to the child's process group; after 10 seconds both
 * are killed. With the supervisor gone, the child is stopped directly. Windows uses taskkill /T and, when the
 * grace time has passed, taskkill /T /F (stop and the supervisor alike).
 * If the supervisor dies the child may die of SIGPIPE at its next write; `status` reports both separately.
 *
 * Exit status: 0 done (status: supervisor and child running), 1 failed (died within the start check, could not
 * stop, status found it not fully running), 2 settings (command= empty, bad name, usage), 3 environment (the
 * wrappers did not find Node 18 or later).
 *
 * Environment (tests and tuning): SERVICE_LOG_ROTATE_BYTES (default 104857600), SERVICE_STOP_GRACE_MS (10000),
 * SERVICE_START_CHECK_MS (2000).
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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

function writePid(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
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

// The command line of a process: { text } ("" when it is gone) or { why } when it cannot be read.
function commandLine(pid) {
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

function confirm(pid, label, test) {
  const line = commandLine(pid);
  if (line.why) console.error(`${label} PID ${pid} 의 명령줄을 읽지 못함(${line.why}): 신호를 보내지 않고 낡은 PID 파일로 봄`);
  else if (test(line.text)) return true;
  else console.error(`${label} PID ${pid} 는 이 서비스가 아님(명령줄이 기록과 다름): 신호를 보내지 않고 낡은 PID 파일로 봄`);
  return false;
}

// Why the pid file is older than the last boot (its PIDs then belong to other processes), or null.
function staleWhy(cur) {
  const at = Date.parse(cur.startedAt);
  if (Number.isNaN(at)) return "startedAt 없음";
  return at < Date.now() - uptime() * 1000 - BOOT_SLACK_MS ? `startedAt ${cur.startedAt} 이 마지막 부팅보다 이름` : null;
}

// The recorded PIDs that are this service's: { supervisor, child }, each a PID or null. A live PID that does not
// count says why on stderr and gets no signal. The child of a confirmed supervisor counts with it.
function owned(cur) {
  const none = { supervisor: null, child: null };
  if (!cur || (!alive(cur.supervisor) && !groupAlive(cur.child))) return none;
  const stale = staleWhy(cur);
  if (stale) {
    console.error(`PID 파일이 낡음(${stale}): 기록된 PID 에 신호를 보내지 않음`);
    return none;
  }
  const supervisor = alive(cur.supervisor) && confirm(cur.supervisor, "감독", isSupervisor) ? cur.supervisor : null;
  const childOk = groupAlive(cur.child) && (supervisor !== null || confirm(cur.child, "자식", isChild(cur.command)));
  return { supervisor, child: childOk ? cur.child : null };
}

async function start(conf) {
  const p = pathsOf(conf.name);
  const cur = readPid(p.pid);
  const own = owned(cur);
  if (own.supervisor) {
    console.log(`이미 실행 중: ${conf.name} (감독 PID ${cur.supervisor}, 자식 PID ${cur.child})`);
    return 0;
  }
  if (own.child) {
    console.error(`감독 없이 자식이 살아 있음(PID ${cur.child}). 먼저 stop 을 실행하세요`);
    return 1;
  }
  rmSync(p.pid, { force: true });
  mkdirSync(LOGS, { recursive: true });
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
  if (!own.supervisor && !own.child) {
    rmSync(p.pid, { force: true });
    console.log(`실행 중 아님: ${conf.name}`);
    return 0;
  }
  terminate(own, false);
  const gone = (await waitGone(own, STOP_GRACE_MS)) || (terminate(own, true), await waitGone(own, 3000));
  if (!gone) {
    console.error(`멈추지 못함: ${conf.name} (감독 PID ${cur.supervisor}, 자식 PID ${cur.child})`);
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
  const sup = own.supervisor !== null;
  const child = own.child !== null;
  console.log(`서비스: ${conf.name}`);
  console.log(`감독: ${sup ? `실행 중 (PID ${cur.supervisor})` : "없음"}`);
  console.log(`자식: ${child ? `실행 중 (PID ${cur.child})` : "없음"}`);
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
