// Child processes for build-testbox: PATH lookup (PATHEXT on Windows), a promise-returning runner with a time limit
// and a set of live children, so a signal handler can stop them all. No shell: arguments go to the program as given.
// On Windows a .cmd or .bat goes through cmd.exe with each argument quoted (Node refuses to spawn them directly).
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

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
      child = spawn(bin, argv, { cwd: opts.cwd, env: opts.env || process.env, stdio: ["ignore", "pipe", "pipe"], ...extra });
    } catch (e) {
      resolveRun({ code: null, signal: null, ...parts, timedOut, error: e.code || String(e.message) });
      return;
    }
    LIVE.add(child);
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
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

// Stops every child still running (used by the SIGINT and SIGTERM handlers).
export function killAll() {
  for (const child of LIVE) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  LIVE.clear();
}

export const firstLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
