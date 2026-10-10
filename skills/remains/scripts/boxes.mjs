#!/usr/bin/env node
// Test boxes for /banker:remains: list them, check that they answer, and run a project's tests on them.
// Pure Node, no dependencies. This machine needs ssh, scp and git; a box needs tar (Windows 10 1803+ has it).
//
//   node boxes.mjs list
//   node boxes.mjs probe [--box <name>]...
//   node boxes.mjs run (--node-test | --cmd "<command>") [--ref <commit>|worktree] [--box <name>]... [--timeout <min>] [--out <dir>]
//
// Boxes are registered in ~/.config/banker/test-boxes.json, or the file BANKER_TEST_BOXES names. Logins are
// SSH keys only: a password field is refused. `run` sends the tracked files of --ref (default HEAD; `worktree`
// adds uncommitted changes to tracked files) and runs the command on every box at once. A Linux or macOS box
// works in a private `mktemp -d` folder. When a run times out, loses its connection or is stopped (SIGINT,
// SIGTERM), what it started on the box is ended before the folder is removed; each box reports `cleaned`.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OSES = new Set(["linux", "darwin", "win32"]);
const FIELDS = new Set(["name", "os", "ssh", "port", "identity", "path", "runAs"]);
const SECRETISH = /pass|secret|token|credential/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/;
const REMOTE_DIR = /^\/tmp\/banker-remains\.[A-Za-z0-9]+$/;
// What ssh and scp print about the connection itself, as opposed to what the remote command prints.
const SSH_ERR = /^(ssh|scp): |Connection (closed|refused|reset|timed out)|Host key verification failed|Permission denied \(|Could not resolve hostname|No route to host|Broken pipe/m;
const UPLOAD_MS = 10 * 60 * 1000;
const CLEANUP_MS = 2 * 60 * 1000;
const PROBE_MS = 30 * 1000;
const MAX_OUTPUT = 50 * 1024 * 1024;
const BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
const USAGE = `usage:
  node boxes.mjs list
  node boxes.mjs probe [--box <name>]...
  node boxes.mjs run (--node-test | --cmd "<command>") [--ref <commit>|worktree] [--box <name>]... [--timeout <min>] [--out <dir>]
`;
const EXAMPLE = { boxes: [
  { name: "macos", os: "darwin", ssh: "user@mac-host", path: ["/usr/local/bin"] },
  { name: "windows", os: "win32", ssh: "user@windows-host" },
  { name: "linux", os: "linux", ssh: "root@linux-host", runAs: "nobody" },
] };

export const configFile = () => process.env.BANKER_TEST_BOXES || join(homedir(), ".config", "banker", "test-boxes.json");

// ── registration ─────────────────────────────────────────────────────────────

const OPTIONAL = [
  ["port", (v) => Number.isInteger(v) && v > 0 && v < 65536, "port 는 1~65535 정수입니다"],
  ["identity", (v) => typeof v === "string" && v.length > 0, "identity 는 키 파일 경로입니다"],
  ["path", (v, b) => b.os !== "win32" && Array.isArray(v) && v.every((p) => /^\/[\w./+-]*$/.test(String(p))),
    "path 는 Linux, macOS 박스에서만 쓰는 절대 경로 목록입니다"],
  ["runAs", (v, b) => b.os === "linux" && String(b.ssh).startsWith("root@") && /^[a-z_][a-z0-9_-]*$/.test(String(v)),
    "runAs 는 root 로 접속하는 Linux 박스에서 시험을 대신 돌릴 계정 이름입니다"],
];

function checkShape(b, where) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return `${where}: 객체가 아닙니다`;
  const extra = Object.keys(b).filter((k) => !FIELDS.has(k));
  if (extra.some((k) => SECRETISH.test(k))) return `${where}: 비밀번호나 토큰은 적지 않습니다(SSH 키 접속만 지원): ${extra.join(", ")}`;
  if (extra.length) return `${where}: 모르는 항목 ${extra.join(", ")} (쓸 수 있는 항목: ${[...FIELDS].join(", ")})`;
  return null;
}

function checkRequired(b, where) {
  if (!NAME.test(String(b.name ?? ""))) return `${where}: name 은 영문이나 숫자로 시작하고 영문, 숫자, '.', '_', '-' 만 씁니다`;
  if (!OSES.has(b.os)) return `${where}: os 는 linux, darwin, win32 중 하나입니다`;
  if (!TARGET.test(String(b.ssh ?? ""))) return `${where}: ssh 는 user@host 형식이고 영문이나 숫자로 시작합니다`;
  return null;
}

function checkOptional(b, where) {
  const bad = OPTIONAL.find(([k, ok]) => b[k] !== undefined && !ok(b[k], b));
  return bad ? `${where}: ${bad[2]}` : null;
}

// The reason a registered box is unusable, or null.
export function checkBox(b, i) {
  const where = `boxes[${i}]`;
  return checkShape(b, where) || checkRequired(b, where) || checkOptional(b, where);
}

// No file means no boxes. A file that is there but wrong stops with the reason, so a typo is never ignored.
export function loadBoxes(file = configFile()) {
  if (!existsSync(file)) return { file, missing: true, boxes: [] };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: JSON 이 아닙니다 (${e.message})`);
  }
  if (!Array.isArray(data?.boxes)) throw new Error(`${file}: "boxes" 배열이 없습니다`);
  const seen = new Set();
  data.boxes.forEach((b, i) => {
    const why = checkBox(b, i) || (seen.has(b.name) ? `boxes[${i}]: 이름 ${b.name} 이 두 번 나옵니다` : null);
    if (why) throw new Error(`${file}: ${why}`);
    seen.add(b.name);
  });
  return { file, missing: false, boxes: data.boxes };
}

// ── commands for a box ───────────────────────────────────────────────────────

const extras = (b, portFlag) => [...(b.port ? [portFlag, String(b.port)] : []), ...(b.identity ? ["-i", b.identity] : [])];
export const sshBase = (b) => [...BASE, ...extras(b, "-p")];
export const scpBase = (b) => [...BASE, ...extras(b, "-P")];

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const pathPrefix = (b) => (b.path?.length ? `PATH=${b.path.map(shq).join(":")}:"$PATH"; ` : "");
// Linux and macOS steps go through sh, whatever the login shell is (zsh does not split $L).
const viaSh = (script) => `sh -c ${shq(script)}`;
const encodePs = (script) => Buffer.from(script, "utf16le").toString("base64");

export const nodeTestCommand = (os, files) =>
  ["node --test --test-reporter=tap", ...files.map((f) => (os === "win32" ? `"${f}"` : shq(f)))].join(" ");

// The script that runs on the box from the top of the sent tree. On Linux and macOS it first leaves its process
// id beside itself, so a stopped run can end everything it started. On Windows it is a .cmd file: `call` returns
// from a batch command such as npm, and the command stays out of the ssh and cmd /c quoting.
export function runScript(b, prefix, command) {
  if (b.os === "win32") {
    const lines = ["@echo off", `cd /d "%~dp0${prefix}" || exit /b 97`, `call ${command}`, "exit /b %ERRORLEVEL%"];
    return { ext: ".cmd", text: lines.map((l) => `${l}\r\n`).join("") };
  }
  const path = b.path?.length ? [`${pathPrefix(b)}export PATH`] : [];
  const lines = ["#!/bin/sh", 'echo $$ > "$(dirname "$0")/pid"', `cd "$(dirname "$0")/${prefix}" || exit 97`, ...path, command];
  return { ext: ".sh", text: `${lines.join("\n")}\n` };
}

// Windows sessions start in the profile folder, which only the account can write, so the run uses relative
// names there and spaces in the profile path do not matter. Ending a run finds the processes whose command
// line holds the run's unique name and ends each one's tree.
function winSteps(b, name) {
  const stop = `$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}*' -and $_.ProcessId -ne $PID } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }; `
    + `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${name}', '${name}.tar', '${name}.cmd'; if (Test-Path '${name}') { exit 1 } else { exit 0 }`;
  return {
    upload: `${b.ssh}:`,
    run: `cmd /c "mkdir ${name} && tar -xf ${name}.tar -C ${name} && del ${name}.tar && move /y ${name}.cmd ${name}\\run.cmd >nul && ${name}\\run.cmd"`,
    cleanup: `cmd /c "rmdir /s /q ${name} 2>nul & del /q ${name}.tar ${name}.cmd 2>nul & if exist ${name} (exit /b 1) else (exit /b 0)"`,
    abort: `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePs(stop)}`,
  };
}

// Linux and macOS work in the private folder `mktemp -d` made. A root login hands the run to runAs, with a
// HOME of its own. Ending a run takes the process tree under the recorded id first, then the folder.
function posixSteps(b, name, dir) {
  const go = b.runAs
    ? `mkdir -p "$D/home" && chown -R ${b.runAs} "$D" && runuser -u ${b.runAs} -- env HOME="$D/home" sh "$D/run.sh"`
    : 'sh "$D/run.sh"';
  const tree = 'L=; w() { L="$L $1"; for c in $(pgrep -P "$1"); do w "$c"; done; }';
  return {
    upload: `${b.ssh}:${dir}/`,
    run: viaSh(`D=${dir}; cd "$D" && tar -xf ${name}.tar && rm -f ${name}.tar && mv ${name}.sh run.sh && ${go}`),
    cleanup: viaSh(`rm -rf ${dir} && [ ! -e ${dir} ]`),
    abort: viaSh(`D=${dir}; P=$(cat "$D/pid" 2>/dev/null); if [ -n "$P" ]; then ${tree}; w "$P"; kill -s TERM $L 2>/dev/null; `
      + `sleep 1; kill -s KILL $L 2>/dev/null; fi; rm -rf "$D" && [ ! -e "$D" ]`),
  };
}

export const remoteSteps = (b, name, dir) => (b.os === "win32" ? winSteps(b, name) : posixSteps(b, name, dir));

// ── results ──────────────────────────────────────────────────────────────────

const lastLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) || "";

// node --test --test-reporter=tap: the summary lines and the names of failing tests (TODO tests left out),
// or null without a summary.
export function parseTap(text) {
  const s = String(text || "");
  if (!/^# tests \d+/m.test(s)) return null;
  const n = (k) => Number((s.match(new RegExp(`^# ${k} (\\d+)`, "m")) || [])[1]);
  const names = [...s.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((m) => m[1]).filter((t) => !/#\s*TODO\b/i.test(t));
  return { tests: n("tests"), pass: n("pass"), fail: n("fail"), skipped: n("skipped"), todo: n("todo"),
    cancelled: n("cancelled"), failures: [...new Set(names)].slice(0, 30) };
}

const PROBE_POSIX = "uname -sm; node -v 2>/dev/null || echo node-missing; git --version 2>/dev/null || echo git-missing; "
  + "command -v tar >/dev/null 2>&1 && echo tar-ok || echo tar-missing";
const PROBE_WIN = 'cmd /c "ver & (node -v 2>nul || echo node-missing) & (git --version 2>nul || echo git-missing)'
  + ' & (where tar >nul 2>nul && echo tar-ok || echo tar-missing)"';

export async function probeBox(b, exec) {
  const remote = b.os === "win32" ? PROBE_WIN : pathPrefix(b) + PROBE_POSIX;
  const r = await exec("ssh", [...sshBase(b), b.ssh, remote], { timeoutMs: PROBE_MS });
  if (r.status !== 0) return { name: b.name, os: b.os, reachable: false, error: lastLine(r.stderr) || "ssh 실패" };
  const out = String(r.stdout || "");
  return {
    name: b.name, os: b.os, reachable: true, system: out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "",
    node: (out.match(/^v\d+\.\d+\.\d+/m) || [null])[0], git: /git version/.test(out), tar: /tar-ok/.test(out),
  };
}

// ── run ──────────────────────────────────────────────────────────────────────

// The files one box gets, named for that box: two registrations of one account cannot collide.
function stage(b, plan, name) {
  const dir = join(plan.scriptDir, b.name);
  mkdirSync(dir, { recursive: true });
  const tar = join(dir, `${name}.tar`);
  try {
    linkSync(plan.tar, tar);
  } catch {
    copyFileSync(plan.tar, tar);
  }
  const s = runScript(b, plan.prefix, plan.commandFor(b.os));
  const script = join(dir, `${name}${s.ext}`);
  writeFileSync(script, s.text);
  return [tar, script];
}

// ssh did not start (no status, no timeout), or ssh itself failed rather than the remote command.
const sshFailed = (r) => (r.status === null && !r.timedOut) || (r.status === 255 && SSH_ERR.test(String(r.stderr || "")));

async function makeDir(b, exec) {
  if (b.os === "win32") return { dir: null };
  const r = await exec("ssh", [...sshBase(b), b.ssh, "mktemp -d /tmp/banker-remains.XXXXXXXX"], { timeoutMs: PROBE_MS });
  const dir = String(r.stdout || "").trim();
  if (r.status !== 0) return { error: lastLine(r.stderr) || "ssh 실패" };
  return REMOTE_DIR.test(dir) ? { dir } : { error: `mktemp -d 가 예상과 다른 경로를 냈습니다: ${dir.slice(0, 80)}` };
}

async function attempt(b, plan, exec, files, steps) {
  const base = { name: b.name, os: b.os, reachable: false, exit: null, timedOut: false };
  const up = await exec("scp", [...scpBase(b), ...files, steps.upload], { timeoutMs: UPLOAD_MS });
  if (up.status !== 0) return { ...base, error: lastLine(up.stderr) || "scp 실패" };
  const run = await exec("ssh", [...sshBase(b), b.ssh, steps.run], { timeoutMs: plan.timeoutMs });
  const stopped = Boolean(plan.ctl?.stopping);
  if (sshFailed(run)) return { ...base, error: lastLine(run.stderr) || "ssh 실패", abort: true, stopped };
  const summary = parseTap(run.stdout);
  return { ...base, reachable: true, exit: run.status, timedOut: Boolean(run.timedOut), summary, noTests: summary?.tests === 0,
    stdout: run.stdout, stderr: run.stderr, abort: Boolean(run.timedOut) || stopped, stopped };
}

// One box: a private folder, upload, run, then clean up. A run that did not end on its own is ended first.
export async function runOnBox(b, plan, exec) {
  const t0 = Date.now();
  const place = await makeDir(b, exec);
  if (place.error) return { name: b.name, os: b.os, reachable: false, exit: null, timedOut: false, error: place.error, cleaned: true, ms: Date.now() - t0 };
  const name = `${plan.id}-${b.name}`;
  const steps = remoteSteps(b, name, place.dir);
  let result = { name: b.name, os: b.os, reachable: false, exit: null, timedOut: false, error: "중단됨", abort: true };
  try {
    result = await attempt(b, plan, exec, stage(b, plan, name), steps);
  } finally {
    const end = await exec("ssh", [...sshBase(b), b.ssh, result.abort ? steps.abort : steps.cleanup], { timeoutMs: CLEANUP_MS });
    result = { ...result, cleaned: end.status === 0 };
  }
  const { abort, ...rest } = result;
  return { ...rest, ms: Date.now() - t0 };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.filter((a) => !a.includes("=")).join(" ")} 실패: ${lastLine(r.stderr) || r.error?.message || ""}`);
  return r.stdout;
}

// The commit to send. `worktree` is a commit object made from the tracked files as they are now
// (git stash create: no stash entry, no change to the work tree). Untracked files are never sent.
function resolveTree(repo, ref) {
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
  const untracked = status.filter((l) => l.startsWith("??")).length;
  if (ref !== "worktree") {
    return { sha: git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).trim(), untracked, modified: status.length - untracked };
  }
  const made = git(repo, ["-c", "user.name=banker-remains", "-c", "user.email=banker-remains@localhost", "stash", "create"]).trim();
  return { sha: made || git(repo, ["rev-parse", "HEAD"]).trim(), untracked, modified: 0 };
}

function testFiles(repo, sha) {
  const files = git(repo, ["ls-tree", "-r", "-z", "--name-only", sha]).split("\0")
    .filter((f) => f.endsWith(".test.mjs") && !f.split("/").includes("node_modules"));
  if (!files.length) throw new Error("*.test.mjs 시험 파일이 없습니다. --cmd 로 시험 명령을 주십시오");
  return files;
}

function writeLogs(results, logDir) {
  mkdirSync(logDir, { recursive: true });
  return results.map(({ stdout, stderr, ...r }) => {
    if (stdout === undefined && stderr === undefined) return r;
    const log = join(logDir, `${r.name}.log`);
    writeFileSync(log, `${stdout || ""}\n--- stderr ---\n${stderr || ""}`);
    return { ...r, log };
  });
}

const passed = (r) => r.reachable && r.exit === 0 && !r.timedOut && !r.noTests && r.cleaned !== false;

async function runAll(boxes, a, { exec, out, ctl }, repo) {
  const { sha, untracked, modified } = resolveTree(repo, a.ref);
  const files = a.nodeTest ? testFiles(repo, sha) : null;
  const commandFor = (os) => (files ? nodeTestCommand(os, files) : a.command);
  const id = `banker-remains-${randomBytes(4).toString("hex")}`;
  const work = join(tmpdir(), id);
  mkdirSync(work);
  try {
    // Committed bytes, whatever this machine's core.autocrlf: Git for Windows would turn LF into CRLF.
    git(repo, ["-c", "core.autocrlf=false", "archive", "--format=tar", "--prefix=repo/", "-o", join(work, `${id}.tar`), sha]);
    const plan = { id, tar: join(work, `${id}.tar`), prefix: "repo", scriptDir: work, commandFor, timeoutMs: a.timeoutMin * 60000, ctl };
    const results = await Promise.all(boxes.map((b) => runOnBox(b, plan, exec)));
    const logDir = a.out || join(tmpdir(), "banker-remains-logs", id);
    const command = Object.fromEntries([...new Set(boxes.map((b) => b.os))].map((os) => [os, commandFor(os)]));
    const report = { id, ref: a.ref, sha, untracked, modified, command, out: logDir, boxes: writeLogs(results, logDir) };
    out.write(`${JSON.stringify(report, null, 1)}\n`);
    return results.every(passed) ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── command line ─────────────────────────────────────────────────────────────

const VALUE = { "--box": "boxes", "--ref": "ref", "--cmd": "command", "--timeout": "timeoutMin", "--out": "out" };

function takeOption(a, rest, i) {
  const k = rest[i];
  if (k === "--node-test") {
    a.nodeTest = true;
    return i;
  }
  const field = VALUE[k];
  if (!field) throw new Error(`모르는 옵션 ${k}`);
  const v = rest[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${k} 에 값이 없습니다`);
  if (field === "boxes") a.boxes.push(v);
  else a[field] = field === "timeoutMin" ? Number(v) : v;
  return i + 1;
}

function checkArgs(a) {
  if (!(Number.isFinite(a.timeoutMin) && a.timeoutMin > 0)) throw new Error("--timeout 은 0보다 큰 분 단위 숫자입니다");
  if (a.cmd !== "run") return a;
  if (a.nodeTest && a.command) throw new Error("--node-test 와 --cmd 는 하나만 씁니다");
  if (!a.nodeTest && !a.command) throw new Error('run 에는 --cmd "<명령>" 이나 --node-test 가 필요합니다');
  return a;
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!["list", "probe", "run"].includes(cmd)) throw new Error("명령은 list, probe, run 중 하나입니다");
  const a = { cmd, boxes: [], ref: "HEAD", nodeTest: false, command: null, timeoutMin: 20, out: null };
  for (let i = 0; i < rest.length; i++) i = takeOption(a, rest, i);
  return checkArgs(a);
}

function list(reg, out, err) {
  out.write(`${JSON.stringify({ file: reg.file, missing: reg.missing, boxes: reg.boxes }, null, 1)}\n`);
  if (reg.missing) {
    err.write(`테스트박스가 등록돼 있지 않습니다. ${reg.file} 에 이 형식으로 적습니다`
      + `(기본 위치 ~/.config/banker/test-boxes.json, BANKER_TEST_BOXES 로 바꿈, SSH 키 접속만):\n${JSON.stringify(EXAMPLE, null, 1)}\n`);
  }
  return 0;
}

async function probeAll(boxes, exec, out) {
  const results = await Promise.all(boxes.map((b) => probeBox(b, exec)));
  out.write(`${JSON.stringify(results, null, 1)}\n`);
  return results.every((r) => r.reachable) ? 0 : 1;
}

function pick(reg, names) {
  const unknown = names.filter((n) => !reg.boxes.some((b) => b.name === n));
  if (unknown.length) throw new Error(`등록되지 않은 박스: ${unknown.join(", ")}`);
  const boxes = names.length ? reg.boxes.filter((b) => names.includes(b.name)) : reg.boxes;
  if (!boxes.length) throw new Error(`등록된 테스트박스가 없습니다 (${reg.file}). list 로 등록 형식을 봅니다`);
  return boxes;
}

// ssh and scp started by this process, so a stop can end them.
const children = new Set();

// SIGINT or SIGTERM during a run: end the ssh and scp in flight, so every box goes on to end its run and clean
// up; a second signal leaves at once. Returns the function that removes the handlers.
export function installStop(ctl, { on = process, kill = () => { for (const c of children) c.kill(); }, exit = process.exit } = {}) {
  const stop = (sig) => {
    if (ctl.stopping) exit(sig === "SIGINT" ? 130 : 143);
    ctl.stopping = sig;
    kill();
  };
  for (const s of ["SIGINT", "SIGTERM"]) on.on(s, stop);
  return () => { for (const s of ["SIGINT", "SIGTERM"]) on.off(s, stop); };
}

async function runWithStop(boxes, a, deps, repo) {
  const ctl = { stopping: null };
  const remove = installStop(ctl, { on: deps.signals });
  try {
    const code = await runAll(boxes, a, { ...deps, ctl }, repo);
    return ctl.stopping ? (ctl.stopping === "SIGINT" ? 130 : 143) : code;
  } finally {
    remove();
  }
}

const withDefaults = (d) => ({ file: configFile(), out: process.stdout, err: process.stderr, exec: spawnExec, cwd: process.cwd(), signals: process, ...d });

// Exit 0: done and every box passed. 1: a box was unreachable, failed, timed out, ran no tests or was left
// unclean. 2: usage or setup error. 130 and 143: stopped by SIGINT and SIGTERM, after cleaning up.
export async function main(argv, deps = {}) {
  const d = withDefaults(deps);
  try {
    const a = parseArgs(argv);
    const reg = loadBoxes(d.file);
    if (a.cmd === "list") return list(reg, d.out, d.err);
    const boxes = pick(reg, a.boxes);
    if (a.cmd === "probe") return await probeAll(boxes, d.exec, d.out);
    return await runWithStop(boxes, a, d, git(d.cwd, ["rev-parse", "--show-toplevel"]).trim());
  } catch (e) {
    d.err.write(`${e.message}\n${/^명령은|옵션|값이|--/.test(e.message) ? USAGE : ""}`);
    return 2;
  }
}

// ssh and scp as child processes, with a time limit. A timed-out child is killed and the result returns at once,
// even if a grandchild still holds its pipes. Output past MAX_OUTPUT is dropped.
export function spawnExec(file, args, { timeoutMs = UPLOAD_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    const buf = { stdout: "", stderr: "" };
    for (const k of ["stdout", "stderr"]) {
      child[k].setEncoding("utf8");
      child[k].on("data", (d) => { if (buf[k].length < MAX_OUTPUT) buf[k] += d; });
    }
    let timedOut = false;
    const done = (status, error) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ status, stdout: buf.stdout, stderr: error ? `${buf.stderr}\n${error.message}` : buf.stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); done(null, null); }, timeoutMs);
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code, null));
  });
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
