// make-evidence: runs a command into a log (secrets masked, exit code kept, time limit over the process tree),
// and starts or stops a server. Pure Node, no network beyond the ready check on the URL it is given.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EXCLUDE, Usage, git, lines, runDir, stamp } from "./me-git.mjs";

// ---- secrets --------------------------------------------------------------------------------------------------

const KEYWORD = "(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)";
const SECRETS = [
  [/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, "$1***"],
  [new RegExp(`(\\b[A-Za-z0-9_]*${KEYWORD}[A-Za-z0-9_]*["']?\\s*[:=]\\s*["']?)[^\\s"'&,;]+`, "gi"), "$1***"],
  [new RegExp(`(--?${KEYWORD}[A-Za-z0-9_-]*(?:=|\\s+))[^\\s"'-][^\\s"']*`, "gi"), "$1***"],
  [/(\bmysql(?:dump)?\b[^\n]*?\s-p)[^\s"']+/gi, "$1***"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1***@"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g, "***"],
  [/(\b(?:cookie|set-cookie):\s*)\S[^\r\n]*/gi, "$1***"],
];

export function redact(text) {
  let n = 0;
  for (const [re, to] of SECRETS) {
    for (const m of text.matchAll(re)) if (!m[0].endsWith("***") && !m[0].endsWith("***@")) n++;
    text = text.replace(re, (...m) => (m[0].endsWith("***") || m[0].endsWith("***@") ? m[0] : m[0].replace(new RegExp(re.source, re.flags.replace("g", "")), to)));
  }
  return { text, n };
}

// Places in a text that still look like a secret (already masked ones do not count): line numbers only.
export function secretLines(text) {
  const hits = new Set();
  const all = text.split("\n");
  all.forEach((line, i) => { if (redact(line).n) hits.add(i + 1); });
  if (redact(text).n && !hits.size) hits.add(1); // a block over several lines
  return [...hits];
}

// ---- logs -----------------------------------------------------------------------------------------------------

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

// The log file to write: {ts} (or @TS@, which PowerShell leaves alone unquoted) filled in, the folder made, an
// existing file refused.
export function claimLog(name) {
  const file = resolve(name.replace(/\{ts\}|@TS@/g, stamp()));
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) throw new Error(`로그가 이미 있음(덮어쓰지 않음): ${file}`);
  return file;
}

function headInfo(cwd) {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  if (r.status !== 0) return { sha: "none", dirty: "?" };
  const s = git(cwd, ["--no-optional-locks", "status", "--porcelain", "--", ".", ...EXCLUDE]);
  return { sha: r.stdout.trim(), dirty: s.status === 0 ? lines(s.stdout).length : "?" };
}

export function header(argv, shell, cwd) {
  const shown = redact(shell ? argv.join(" ") : argv.map(quote).join(" ")).text;
  const h = headInfo(cwd);
  return `$ ${shown}\n# head=${h.sha} dirty=${h.dirty} at=${new Date().toISOString()} node=${process.version} os=${process.platform} cwd=${cwd}\n`;
}

function spawnArgs(argv, shell) {
  if (!shell) return [argv[0], argv.slice(1)];
  const line = argv.join(" ");
  return process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line]] : ["/bin/sh", ["-c", line]];
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { cwd: runDir(), stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

// Writes whole lines, masked, in the order they arrive; a partial line waits for its end.
function lineSink(fd, count) {
  let part = "";
  const put = (s) => { const r = redact(s); count.n += r.n; writeSync(fd, r.text); };
  return {
    push(chunk) {
      part += chunk;
      const i = part.lastIndexOf("\n");
      if (i >= 0) { put(part.slice(0, i + 1)); part = part.slice(i + 1); }
    },
    end() { if (part) put(`${part}\n`); part = ""; },
  };
}

const GRACE_MS = 3000;
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

function exitText(state, code, signal) {
  if (state.timedOut) return `timeout(${state.timeoutS}s)`;
  if (state.error) return `error(${state.error})`;
  return code === null || code === undefined ? `signal(${signal})` : String(code);
}

// Closes the log once: on close, a little after exit when a descendant still holds the pipes, or on a signal
// to this helper (the child's tree is ended first).
function closer(state, fd, sinks, child, done) {
  return (code, signal, how) => {
    if (state.ended) return;
    state.ended = true;
    clearTimeout(state.timer); clearTimeout(state.grace);
    for (const s of SIGNALS) process.removeListener(s, state.onSignal);
    sinks.forEach((s) => s.end());
    if (how === "orphan") { killTree(child.pid); child.stdout.destroy(); child.stderr.destroy(); }
    const exit = how === "interrupted" ? `interrupted(${signal})` : exitText(state, code, signal);
    writeSync(fd, `${how === "orphan" ? "# orphan-output=yes\n" : ""}# redacted=${state.count.n}\nexit=${exit}\n`);
    closeSync(fd);
    appendFileSync(state.file, runMetrics(readFileSync(state.file, "utf8"), exit).map((m) => `METRIC ${m}\n`).join(""));
    done({ file: state.file, code: state.timedOut ? 124 : typeof code === "number" ? code : 1, exit });
  };
}

export async function runLogged({ log, argv, cwd = process.cwd(), timeoutS = 300, shell = false }) {
  if (!argv.length) throw new Usage("실행할 명령이 없음(-- 뒤에 씀)");
  const file = claimLog(log);
  const fd = openSync(file, "wx");
  writeSync(fd, header(argv, shell, cwd));
  const [cmd, args] = spawnArgs(argv, shell);
  return new Promise((done) => {
    const state = { file, timeoutS, count: { n: 0 }, ended: false, timedOut: false, error: null, timer: null, grace: null, onSignal: null };
    const sinks = [lineSink(fd, state.count), lineSink(fd, state.count)];
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const finish = closer(state, fd, sinks, child, done);
    state.onSignal = (sig) => { killTree(child.pid); finish(null, sig, "interrupted"); process.exit(130); };
    for (const s of SIGNALS) process.once(s, state.onSignal);
    state.timer = setTimeout(() => {
      state.timedOut = true;
      killTree(child.pid);
      state.grace = setTimeout(() => finish(null, "SIGKILL", "orphan"), GRACE_MS);
    }, timeoutS * 1000);
    child.stdout.setEncoding("utf8").on("data", (c) => sinks[0].push(c));
    child.stderr.setEncoding("utf8").on("data", (c) => sinks[1].push(c));
    child.on("error", (e) => { state.error = e.code || e.message; finish(null, null); });
    child.on("exit", (code, signal) => { state.grace = setTimeout(() => finish(code, signal, "orphan"), GRACE_MS); });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// Test counts the common runners print, so a document can cite them: node --test (spec and TAP), pytest, jest.
const SUMMARIES = [
  [/^\S*\s*(?:ℹ|#) (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/gm, (m) => [[m[1], m[2]]]],
  [/^=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s/gm, (m) => [...m[1].matchAll(/(\d+) (passed|failed|skipped|errors?|xfailed|xpassed)/g)].map((x) => [x[2], x[1]])],
  [/^Tests:\s+(.*\btotal)\s*$/gm, (m) => [...m[1].matchAll(/(\d+) (passed|failed|skipped|todo|total)/g)].map((x) => [x[2], x[1]])],
];

export function runMetrics(text, exit) {
  const out = new Map([["run.exit", exit]]);
  for (const [re, pick] of SUMMARIES) for (const m of text.matchAll(re)) for (const [k, v] of pick(m)) out.set(`run.tests.${k}`, v);
  return [...out].map(([k, v]) => `${k}=${v}`);
}

// ---- long-running servers -------------------------------------------------------------------------------------

async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function waitReady(child, ready, waitS) {
  const end = Date.now() + waitS * 1000;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) return `not-ready(exited ${child.exitCode ?? child.signalCode})`;
    if (await reachable(ready)) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
  return `not-ready(${waitS}s)`;
}

export async function serve({ log, pidFile, ready, waitS = 60, argv, cwd = process.cwd(), shell = false }) {
  if (!argv.length) throw new Usage("실행할 명령이 없음(-- 뒤에 씀)");
  if (existsSync(pidFile)) throw new Error(`pid 파일이 이미 있음: ${pidFile} (먼저 stop)`);
  if (await reachable(ready)) throw new Error(`이미 답하는 서버가 있음: ${ready} (띄우지 않음. 이미 떠 있던 서버로 다룸)`);
  const file = claimLog(log);
  const fd = openSync(file, "wx");
  writeSync(fd, header(argv, shell, cwd));
  const [cmd, args] = spawnArgs(argv, shell);
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
  closeSync(fd);
  writeFileSync(pidFile, `${child.pid}\n${file}\n`);
  const why = await waitReady(child, ready, waitS);
  child.unref();
  if (!why) return { file, pid: child.pid, ready: true };
  stop({ pidFile, why });
  return { file, pid: child.pid, ready: false, why };
}

// Ends the server's process tree, masks the secrets its log may hold and closes the log with its exit line.
export function stop({ pidFile, why: given = "stopped" }) {
  let why = given;
  const [pid, file] = lines(readFileSync(pidFile, "utf8"));
  let alive = true;
  try { process.kill(Number(pid), 0); } catch (e) { alive = e.code === "EPERM"; }
  if (!alive && why === "stopped") why = "gone-before-stop";
  killTree(Number(pid));
  if (file && existsSync(file)) {
    const r = redact(readFileSync(file, "utf8"));
    writeFileSync(file, `${r.text}${r.text.endsWith("\n") ? "" : "\n"}# redacted=${r.n}\nexit=${why}\n`);
  }
  rmSync(pidFile, { force: true });
  return { pid: Number(pid), file };
}
