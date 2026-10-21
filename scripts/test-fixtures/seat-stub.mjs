#!/usr/bin/env node
// A fake seat CLI for the ralph-qa runner tests: node seat-stub.mjs <codex|gemini|opencode> [args...].
// Not shipped (scripts/ is outside package.json's files). It opens no socket; it writes files only.
//
// stubBin(dir) writes the entry points a test puts on PATH: on POSIX a `#!/bin/sh` file per name
// that execs this module with node, on Windows a `<name>.cmd` that runs it through cmd.exe, the way
// npm's shims run codex and gemini.
//
// RQ_STUB_LOG: a folder for one record per call, `<name>-<pid>.md` (JSON: args, cwd, the env names
// below, stdin length), the stdin bytes `<name>-<pid>-stdin.md` and the pids the call started,
// `<name>-<pid>-pids.md`, one per line.
// RQ_STUB_MODE: what a run does, comma separated (default answer):
//   answer        prints an answer with one `VERDICT: <RQ_STUB_VERDICT or APPROVE>` line and exits 0
//   empty         prints no answer         two-verdicts  two VERDICT lines      no-verdict  none
//   exit3         stderr `boom`, exit 3    rejected      a model-not-found error, exit 1
//   policy-error  gemini's `Policy file error` on stderr   full-report  gemini's API error report, exit 1
//   fallback      opencode's `Falling back to default agent` on stderr
//   model-line=<m> codex's stderr header names <m> as the model it ran
//   hang          waits for ever, with a child that waits too
//   chain         a child and a grandchild that wait for ever, the run waits too
//   term-proof    a worker that ignores TERM; the run itself exits on TERM
//   term-note     a child that writes `term-<pid>.md` in the record folder when TERM comes, then exits
//   linger        a child that waits for ever; the run exits 0 at once
//   late-write    answers, exits 0, and a child writes a gemini record 1.5 s later
//   slow=<ms>     waits <ms> before answering
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const WATCHED = /^(GEMINI_|OPENCODE_|CODEX_|TMPDIR$|TEMP$|TMP$|HOME$|USERPROFILE$|GIT_)/i;
const sh = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export function stubBin(dir, names = ["codex", "gemini", "opencode"]) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${SELF}" ${name} %*\r\n`);
    } else {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(SELF)} ${name} "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
  return dir;
}

const modes = () => String(process.env.RQ_STUB_MODE || "answer").split(",");
const mode = (m) => modes().includes(m);
const modeValue = (m) => (modes().find((x) => x.startsWith(`${m}=`)) || "").slice(m.length + 1) || null;
const log = (file) => (process.env.RQ_STUB_LOG ? join(process.env.RQ_STUB_LOG, file) : null);

function record(name, args, stdin) {
  const at = log(`${name}-${process.pid}.md`);
  if (!at) return;
  const env = Object.fromEntries(Object.keys(process.env).filter((k) => WATCHED.test(k)).map((k) => [k, process.env[k]]));
  writeFileSync(at, JSON.stringify({ name, args, cwd: process.cwd(), env, stdinBytes: stdin.length, pid: process.pid }));
  writeFileSync(log(`${name}-${process.pid}-stdin.md`), stdin);
}

function startedPid(name, pid) {
  const at = log(`${name}-${process.pid}-pids.md`);
  if (at) appendFileSync(at, `${pid}\n`);
}

// A node child that waits for ever, or ignores TERM first; with `chain` it starts a grandchild
// that waits too and prints the grandchild's pid.
const WAIT = "setInterval(() => {}, 1000);";
const TELL = `const g = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(WAIT)}], { stdio: "ignore" }); console.log(g.pid); ${WAIT}`;
const NOTE = (dir) => `process.on("SIGTERM", () => { require("node:fs").writeFileSync(require("node:path").join(${JSON.stringify(dir)}, "term-" + process.pid + ".md"), "TERM\\n"); process.exit(0); });`;
function waiter(name, { ignoreTerm = false, chain = false, note = false } = {}) {
  const code = chain ? TELL : `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}${note ? NOTE(process.env.RQ_STUB_LOG) : ""}${WAIT}`;
  const c = spawn(process.execPath, ["-e", code], { stdio: chain ? ["ignore", "pipe", "ignore"] : "ignore" });
  startedPid(name, c.pid);
  if (chain) c.stdout.on("data", (b) => String(b).split("\n").filter(Boolean).forEach((p) => startedPid(name, Number(p))));
  return c;
}

function readStdin() {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

const flagValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

function answerText() {
  if (mode("empty")) return "";
  const v = process.env.RQ_STUB_VERDICT || "APPROVE";
  if (mode("two-verdicts")) return `first\nVERDICT: ${v}\nsecond\nVERDICT: ${v}\n`;
  if (mode("no-verdict")) return "an answer without a verdict line\n";
  return `stub review\nVERDICT: ${v}\n`;
}

function errText(name, args) {
  const lines = [];
  if (name === "codex") lines.push("OpenAI Codex (stub)", "--------", `workdir: ${process.cwd()}`, `model: ${modeValue("model-line") || flagValue(args, "-m") || "gpt-5.5"}`, "--------");
  if (mode("policy-error")) lines.push("Policy file error: could not read the admin policy");
  if (mode("full-report")) lines.push("Error when talking to Gemini API Full report available at: /tmp/gemini-client-error-x.json");
  if (mode("fallback")) lines.push('Falling back to default agent "build"');
  if (mode("rejected")) lines.push("Error: 404 model_not_found: The model does not exist");
  if (mode("exit3")) lines.push("boom");
  return lines.length ? lines.join("\n") + "\n" : "";
}

// gemini 0.62.0's record of a headless session: tmp/<slug>/chats and .project_root naming the folder.
function geminiRecord(file) {
  const home = process.env.GEMINI_CLI_HOME;
  if (!home) return;
  const slug = `stub-${process.pid}`;
  const dir = join(home, ".gemini", "tmp", slug);
  mkdirSync(join(dir, "chats"), { recursive: true });
  if (!existsSync(join(dir, ".project_root"))) writeFileSync(join(dir, ".project_root"), realpathSync(process.cwd()));
  writeFileSync(join(dir, "chats", file), "session record\n");
}

function lateWrite(name) {
  const dir = join(process.env.GEMINI_CLI_HOME || process.cwd(), ".gemini", "tmp", `stub-${process.pid}`, "chats");
  const code = `setTimeout(() => { require("node:fs").mkdirSync(${JSON.stringify(dir)}, { recursive: true }); require("node:fs").writeFileSync(${JSON.stringify(join(dir, "late.md"))}, "late record\\n"); }, 1500);`;
  const c = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
  startedPid(name, c.pid);
  c.unref();
}

function startWork(name) {
  if (mode("hang")) waiter(name);
  if (mode("chain")) waiter(name, { chain: true });
  if (mode("term-proof")) waiter(name, { ignoreTerm: true });
  if (mode("term-note")) waiter(name, { note: true });
  if (mode("linger")) waiter(name).unref();
  return mode("hang") || mode("chain") || mode("term-proof") || mode("term-note");
}

function finish(name, args) {
  const answer = answerText();
  const out = name === "codex" ? flagValue(args, "-o") : null;
  if (out) writeFileSync(out, answer);
  else process.stdout.write(answer);
  if (name === "codex") process.stdout.write("codex progress line\n");
  process.stderr.write(errText(name, args));
  if (name === "gemini") geminiRecord("session.md");
  if (name === "gemini" && mode("late-write")) lateWrite(name);
  process.exit(mode("exit3") ? 3 : mode("rejected") || mode("full-report") ? 1 : 0);
}

function run(name, args) {
  record(name, args, readStdin());
  if (name === "opencode") addSession(args);
  if (startWork(name)) return;
  const slow = Number(modeValue("slow") || 0);
  setTimeout(() => finish(name, args), slow);
}

const SESSIONS = () => process.env.RQ_STUB_SESSIONS || log("opencode-sessions.md");
const readSessions = () => {
  try {
    return JSON.parse(readFileSync(SESSIONS(), "utf8"));
  } catch {
    return [];
  }
};
function addSession(args) {
  if (!SESSIONS()) return;
  const all = readSessions();
  all.push({ id: `ses_${process.pid}`, title: flagValue(args, "--title") || "untitled", directory: realpathSync(process.cwd()) });
  writeFileSync(SESSIONS(), JSON.stringify(all));
}

// opencode 1.3.10's `debug agent <A>`: 0 only when the config holds that agent.
function debugAgent(args) {
  record("opencode", args, Buffer.alloc(0));
  let agents = {};
  try {
    agents = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}").agent || {};
  } catch {
    /* no agents */
  }
  if (args[2] in agents) return process.exit(0);
  process.stderr.write(`agent ${args[2]} not found\n`);
  return process.exit(1);
}

function opencode(args) {
  const [a, b, c] = args;
  if (a === "debug" && b === "agent") return debugAgent(args);
  if (a === "session" && b === "list") return process.stdout.write(JSON.stringify(readSessions()) + "\n");
  if (a === "session" && b === "delete") {
    writeFileSync(SESSIONS(), JSON.stringify(readSessions().filter((s) => s.id !== c)));
    return process.exit(0);
  }
  return run("opencode", args);
}

const CATALOG = { models: [{ slug: "gpt-5.5", priority: 1 }, { slug: "o4-mini", priority: 2 }] };
function codex(args) {
  if (args[0] === "--version") return process.stdout.write("codex-cli 0.144.5\n");
  if (args[0] === "debug" && args[1] === "models") return process.stdout.write(JSON.stringify(CATALOG) + "\n");
  return run("codex", args);
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  const [name, ...args] = process.argv.slice(2);
  if (name === "codex") codex(args);
  else if (name === "opencode") opencode(args);
  else run(name || "gemini", args);
}
