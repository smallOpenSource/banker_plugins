// Child processes for build-testbox: PATH lookup (PATHEXT on Windows), a promise-returning runner with a time limit
// and a set of live children, so a signal handler can stop them all. No shell: arguments go to the program as given.
// On Windows a .cmd or .bat goes through cmd.exe with each argument quoted (Node refuses to spawn them directly).
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";

const LIVE = new Set();
const MAX_OUT = 8 * 1024 * 1024;

function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// On Windows a name without extension also tries each PATHEXT entry.
function candidates(name, env) {
  const dirs = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" && !extname(name) ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  return dirs.flatMap((dir) => exts.flatMap((ext) => [...new Set([name + ext.toLowerCase(), name + ext])].map((n) => join(dir, n))));
}

// The full path of a program on PATH, or null.
export function which(name, env = process.env) {
  if (isAbsolute(name)) return isExecutable(name) ? name : null;
  return candidates(name, env).find(isExecutable) || null;
}

const quoteCmd = (a) => `"${String(a).replace(/"/g, '""')}"`;

function spawnArgs(file, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteCmd).join(" ");
    return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true }];
  }
  return [file, args, {}];
}

function collector() {
  const parts = { stdout: "", stderr: "", out: "" };
  const add = (key) => (chunk) => {
    const s = chunk.toString("utf8");
    if (parts.out.length < MAX_OUT) parts.out += s;
    if (parts[key].length < MAX_OUT) parts[key] += s;
  };
  return { parts, add };
}

// Ends a child and everything it started: on POSIX its process group (the child leads one, spawned detached), on
// Windows the tree through System32's taskkill /T /F (not a taskkill found in the working folder).
function killTree(child) {
  if (process.platform === "win32") {
    const taskkill = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// Runs a program and resolves { code, signal, stdout, stderr, out, timedOut, error }. Never rejects: a missing
// program is { code: null, error: "ENOENT" }. out holds stdout and stderr in arrival order.
export function runProc(cmd, args = [], opts = {}) {
  const file = which(cmd, opts.env || process.env) || cmd;
  const [bin, argv, extra] = spawnArgs(file, args);
  const { parts, add } = collector();
  return new Promise((resolveRun) => {
    let timedOut = false;
    let child;
    try {
      const detached = process.platform !== "win32"; // its own process group, so a time-out ends what it started too
      child = spawn(bin, argv, { cwd: opts.cwd, env: opts.env || process.env, stdio: ["ignore", "pipe", "pipe"], detached, ...extra });
    } catch (e) {
      resolveRun({ code: null, signal: null, ...parts, timedOut, error: e.code || String(e.message) });
      return;
    }
    LIVE.add(child);
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs) : null;
    // After a time-out, a process that left the tree may still hold the pipes: they are closed a second after the exit,
    // so the run ends instead of waiting for it.
    child.on("exit", () => {
      if (timedOut) setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000).unref();
    });
    child.stdout.on("data", add("stdout"));
    child.stderr.on("data", add("stderr"));
    let error = null;
    child.on("error", (e) => { error = e.code || String(e.message); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      LIVE.delete(child);
      resolveRun({ code, signal, ...parts, timedOut, error });
    });
  });
}

// Stops every child still running (used by the SIGINT and SIGTERM handlers, and when this process exits). On POSIX a
// child leads its own process group, so it no longer gets the terminal's signals: an entry point that uses runProc
// keeps signal handlers that call killAll (testbox.mjs does).
export function killAll() {
  for (const child of LIVE) killTree(child);
  LIVE.clear();
}

export const firstLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";

// A child group left when this process ends some other way (an uncaught error) is ended too.
process.on("exit", killAll);
