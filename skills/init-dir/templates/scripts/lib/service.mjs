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
 * current one. logs/<name>.pid holds {supervisor, child, startedAt}.
 *
 * `stop` sends SIGTERM to the supervisor, which passes it to the child's process group; after 10 seconds both
 * are killed. With the supervisor gone, the child is stopped directly. Windows uses taskkill /T, then /F.
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

function signalGroup(pid, signal) {
  for (const target of WIN ? [pid] : [-pid, pid]) {
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

// A log file that rotates before a write would take it past ROTATE_BYTES.
function openLog(file) {
  let fd = openSync(file, "a");
  let size = statSync(file).size;
  const rotate = () => {
    closeSync(fd);
    try {
      shift(file);
    } catch {
      // a reader holds a file open (Windows): keep writing to the current one and try again at the next write
    } finally {
      fd = openSync(file, "a");
      size = statSync(file).size;
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
  const out = openLog(p.out);
  const err = openLog(p.err);
  const child = spawn(conf.command, { shell: true, cwd: ROOT, detached: !WIN, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (c) => out.write(c));
  child.stderr.on("data", (c) => err.write(c));
  child.on("error", (e) => err.write(Buffer.from(`service: ${e.message}\n`)));
  writePid(p.pid, { supervisor: process.pid, child: child.pid ?? null, startedAt: new Date().toISOString() });
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

async function start(conf) {
  const p = pathsOf(conf.name);
  const cur = readPid(p.pid);
  if (cur && alive(cur.supervisor)) {
    console.log(`이미 실행 중: ${conf.name} (감독 PID ${cur.supervisor}, 자식 PID ${cur.child})`);
    return 0;
  }
  if (cur && groupAlive(cur.child)) {
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

function taskkill(pid, force) {
  spawnSync("taskkill", ["/T", ...(force ? ["/F"] : []), "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
}

// Asks the supervisor (or, with it gone, the child) to stop; force kills both.
function terminate(cur, force) {
  const supervised = alive(cur.supervisor);
  if (WIN) return taskkill(supervised ? cur.supervisor : cur.child, force);
  if (!force) return supervised ? kill(cur.supervisor, "SIGTERM") : signalGroup(cur.child, "SIGTERM");
  signalGroup(cur.child, "SIGKILL");
  if (supervised) kill(cur.supervisor, "SIGKILL");
}

async function waitGone(cur, ms) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) {
    if (!alive(cur.supervisor) && !groupAlive(cur.child)) return true;
  }
  return !alive(cur.supervisor) && !groupAlive(cur.child);
}

async function stop(conf) {
  const p = pathsOf(conf.name);
  const cur = readPid(p.pid);
  if (!cur || (!alive(cur.supervisor) && !groupAlive(cur.child))) {
    rmSync(p.pid, { force: true });
    console.log(`실행 중 아님: ${conf.name}`);
    return 0;
  }
  terminate(cur, false);
  const gone = (await waitGone(cur, STOP_GRACE_MS)) || (terminate(cur, true), await waitGone(cur, 3000));
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
  const sup = alive(cur.supervisor);
  const child = groupAlive(cur.child);
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
