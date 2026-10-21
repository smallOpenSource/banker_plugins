/**
 * seat-spawn: how the ralph-qa runner (seat-run.mjs) finds a seat CLI and runs it inside its
 * time limit, with every process the seat started ended when the run returns.
 *
 * which(name)     the CLI on PATH, from absolute PATH folders only. libuv on Windows looks in the
 *                 child's working folder before PATH for a bare name, so the runner always starts
 *                 a CLI by the absolute path this gives. Windows tries .exe, then .cmd and .bat
 *                 in each folder, never an extensionless file.
 * cmdLine(exe, args)  the cmd.exe line for a .cmd or .bat seat (Node refuses to start those
 *                 without a shell since CVE-2024-27980). Every word is quoted by the MSVC rules;
 *                 a word holding what cmd.exe reads itself (% ! ^ & | < >, a line break, NUL,
 *                 or a parenthesis beside a quote, which cmd's quote toggling over \" can bare)
 *                 makes it null: the seat does not start.
 * runLimited(opts)  starts the seat with stdin, stdout and stderr on files and resolves with
 *                 { exit, signal, timedOut, stopped, secs, error, leftover }. On POSIX the seat
 *                 gets its own process group: the limit sends the group TERM and, after the grace,
 *                 KILL; a seat that exits on its own has its group sent KILL at once, so nothing it
 *                 left (a late writer, an MCP server) outlives the run. On Windows the limit ends
 *                 the tree with System32's taskkill /T /F; a process left after the seat exits on
 *                 its own is not reached (Windows keeps no group).
 * stopAll()       ends every seat still running (TERM, then KILL 2 s later; taskkill on Windows).
 *
 * No shell and no timeout program: the limit is a timer here, so Git Bash's or System32's
 * timeout never comes into it.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, openSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

const running = new Set();
const STOP_GRACE_MS = 2000;
// How long a run waits for a seat to go after its KILL before it gives up on it (`leftover`).
const BACKSTOP_MS = 10000;

const system32 = (file) => win32.join(process.env.SystemRoot || "C:\\Windows", "System32", file);

function pathOf(env, platform) {
  if (platform !== "win32") return env.PATH || "";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key ? env[key] || "" : "";
}

const runnable = (platform) => (file) => {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function which(name, opts = {}) {
  const platform = opts.platform || process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const isFile = opts.isFile || runnable(platform);
  const dirs = pathOf(opts.env || process.env, platform).split(paths.delimiter).filter((dir) => dir && paths.isAbsolute(dir));
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = paths.join(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return null;
}

const CMD_META = /[%!^&|<>\r\n\0]/;
const cmdSafe = (w) => !CMD_META.test(w) && !(/[()]/.test(w) && w.includes('"'));
const quoteWord = (w) => `"${w.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

export function cmdLine(exe, args) {
  const words = [exe, ...args].map(String);
  return words.every(cmdSafe) ? words.map(quoteWord).join(" ") : null;
}

// The files the seat reads and writes, opened for it; "ignore" is passed through.
function openStdio({ stdin, stdout, stderr }) {
  const fds = [];
  const open = (path, flags) => {
    if (path === undefined || path === "ignore") return "ignore";
    const fd = openSync(path, flags, 0o600);
    fds.push(fd);
    return fd;
  };
  try {
    return { stdio: [open(stdin, "r"), open(stdout, "w"), open(stderr, "w")], fds };
  } catch (e) {
    for (const fd of fds) closeSync(fd);
    throw e;
  }
}

// The child process for the seat: a .cmd or .bat through System32's cmd.exe, anything else as is.
function launch({ exe, args, cwd, env, platform }, stdio) {
  const viaCmd = platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  if (!viaCmd) return spawn(exe, args, { cwd, env, stdio, windowsHide: true, detached: platform !== "win32" });
  const line = cmdLine(exe, args);
  if (line === null) throw Object.assign(new Error("a word cmd.exe would read"), { code: "unsafe-word" });
  return spawn(system32("cmd.exe"), ["/d", "/v:off", "/s", "/c", `"${line}"`],
    { cwd, env, stdio, windowsHide: true, windowsVerbatimArguments: true });
}

const signalGroup = (pid, sig) => {
  try {
    process.kill(-pid, sig);
  } catch {
    /* the group is gone */
  }
};
const taskkill = (pid) => spawnSync(system32("taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });

// Ends a seat: TERM to its group and KILL after `grace` (POSIX), or taskkill on its tree (Windows).
function terminate(seat, why, grace) {
  if (seat.ending) return;
  seat.ending = why;
  if (seat.platform === "win32") {
    taskkill(seat.child.pid);
    seat.backstop = setTimeout(() => seat.finish(true), BACKSTOP_MS);
    return;
  }
  signalGroup(seat.child.pid, "SIGTERM");
  seat.killTimer = setTimeout(() => {
    seat.killed = true;
    signalGroup(seat.child.pid, "SIGKILL");
    if (seat.exited) seat.finish(false);
    else seat.backstop = setTimeout(() => seat.finish(true), BACKSTOP_MS);
  }, grace);
}

// The seat's own exit: on POSIX its group is sent KILL now, or when the grace ends if it is being
// ended, so nothing it left keeps running.
function onExit(seat, code, signal) {
  if (seat.child.pid === undefined) return undefined; // a seat that never started: its error ends the run
  seat.exited = { code, signal };
  clearTimeout(seat.limitTimer);
  if (seat.platform === "win32") return seat.finish(false);
  if (seat.ending && !seat.killed) return undefined;
  signalGroup(seat.child.pid, "SIGKILL");
  return seat.finish(false);
}

function watch(seat, opts) {
  const { child } = seat;
  const grace = opts.graceMs ?? Math.min(10000, opts.limitMs / 2);
  seat.limitTimer = setTimeout(() => terminate(seat, "limit", grace), opts.limitMs);
  child.on("exit", (code, signal) => onExit(seat, code, signal));
  child.on("error", (e) => {
    if (child.pid === undefined) seat.finish(false, e.code || "spawn");
  });
}

function result(seat, t0, leftover, error) {
  const { code = null, signal = null } = seat.exited || {};
  return {
    exit: error ? null : code, signal: error ? null : signal, timedOut: seat.ending === "limit", stopped: seat.ending === "stop",
    secs: Math.round((Date.now() - t0) / 100) / 10, error: error || null, leftover,
  };
}

export function runLimited(opts) {
  const t0 = Date.now();
  const platform = opts.platform || process.platform;
  return new Promise((done) => {
    let io;
    try {
      if (!statSync(opts.exe).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
      io = openStdio(opts);
    } catch (e) {
      done(result({}, t0, false, e.code || "spawn"));
      return;
    }
    const seat = { platform };
    seat.finish = (leftover, error) => {
      if (seat.done) return;
      seat.done = true;
      for (const t of [seat.limitTimer, seat.killTimer, seat.backstop]) clearTimeout(t);
      running.delete(seat);
      done(result(seat, t0, leftover, error));
    };
    try {
      seat.child = launch({ ...opts, args: opts.args || [], platform }, io.stdio);
    } catch (e) {
      seat.finish(false, e.code || "spawn");
      return;
    } finally {
      for (const fd of io.fds) closeSync(fd);
    }
    running.add(seat);
    watch(seat, opts);
  });
}

export function stopAll() {
  const seats = [...running];
  const ends = seats.map((seat) => new Promise((resolve) => {
    const finish = seat.finish;
    seat.finish = (...a) => {
      finish(...a);
      resolve();
    };
  }));
  for (const seat of seats) terminate(seat, "stop", STOP_GRACE_MS);
  return Promise.all(ends);
}
