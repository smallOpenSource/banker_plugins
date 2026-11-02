// The templates init-dir writes, run for real (US-2 acceptance 10 and 11): scripts/lib/service.mjs through the
// start, stop, status and restart wrappers (.sh on POSIX, .cmd on Windows), and tests/run.mjs.
// Temp project folders and a temp HOME only.
// Run: node --test skills/init-dir/scripts/service-template.test.mjs
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { symlinkSkip } from "../../../scripts/test-fixtures/can-symlink.mjs";

const WIN = process.platform === "win32";
const CLI = fileURLToPath(new URL("./init-dir.mjs", import.meta.url));
// Preload that blocks /proc/<pid>/cmdline, ps and powershell.exe (scripts/test-fixtures, not shipped).
const NO_CMDLINE = new URL("../../../scripts/test-fixtures/no-cmdline.mjs", import.meta.url).href;
// Preload that writes another start's fresh lock at the moment a stale lock is being cleared (scripts/test-fixtures).
const LOCK_RACE = new URL("../../../scripts/test-fixtures/lock-race.mjs", import.meta.url).href;
// Preload that answers EPERM, EBUSY once, as Windows does for a lock file being deleted (scripts/test-fixtures).
const LOCK_BUSY = new URL("../../../scripts/test-fixtures/lock-busy-once.mjs", import.meta.url).href;
const base = mkdtempSync(join(tmpdir(), "init-dir-service-"));
const home = join(base, "home");
mkdirSync(home);
const ENV = { ...process.env, HOME: home, USERPROFILE: home, NODE: process.execPath, SERVICE_START_CHECK_MS: "800", SERVICE_STOP_GRACE_MS: "2000" };
const started = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
// The child's process group on POSIX (the shell and what it runs), the child itself on Windows.
function groupAlive(pid) {
  if (WIN) return alive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function killQuietly(pid, group) {
  for (const target of group && !WIN ? [-pid, pid] : [pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // gone
    }
  }
}

// Whatever a failed test left running is killed before the temp folder goes.
after(() => {
  for (const p of started) {
    killQuietly(p.supervisor, false);
    killQuietly(p.child, true);
  }
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
function project(folders = "scripts") {
  const root = join(base, `p${n++}`);
  mkdirSync(root);
  const r = spawnSync(process.execPath, [CLI, "apply", "--runtime", "claude", "--root", root, `--only=${folders}`], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

// Runs a wrapper the way a user does: ./scripts/<name>.sh, or scripts\<name>.cmd on Windows.
function wrapper(root, dir, name, args = [], env = {}) {
  const opts = { encoding: "utf8", cwd: root, env: { ...ENV, ...env }, timeout: 30000 };
  if (WIN) return spawnSync("cmd.exe", ["/d", "/c", join(root, dir, `${name}.cmd`), ...args], opts);
  return spawnSync(join(root, dir, `${name}.sh`), args, opts);
}
const svc = (root, name, env) => wrapper(root, "scripts", name, [], env);

function configure(root, script) {
  const command = `"${process.execPath}" -e "${script}"`;
  writeFileSync(join(root, "scripts", "service.conf"), `name=app\ncommand=${command}\n`);
}
const pidOf = (root) => {
  const p = JSON.parse(readFileSync(join(root, "logs", "app.pid"), "utf8"));
  started.push(p);
  return p;
};
async function waitFor(check, ms = 5000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(50)) if (check()) return true;
  return check();
}
const logText = (root, name) => {
  const p = join(root, "logs", name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

const WAITER = "console.log('hello-out');console.error('hello-err');setInterval(()=>{},1000)";

test("AC10: start, status, restart, stop exit 0; stdout and stderr go to separate logs; the pid file holds both pids", async () => {
  const root = project("scripts,logs");
  configure(root, WAITER);
  const s = svc(root, "start");
  assert.equal(s.status, 0, s.stderr);
  const first = pidOf(root);
  assert.ok(Number.isInteger(first.supervisor) && Number.isInteger(first.child), JSON.stringify(first));
  assert.ok(typeof first.startedAt === "string");
  const st = svc(root, "status");
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /감독: 실행 중/);
  assert.match(st.stdout, /자식: 실행 중/);
  assert.ok(await waitFor(() => logText(root, "app.out.log").includes("hello-out") && logText(root, "app.err.log").includes("hello-err")));
  assert.equal(logText(root, "app.out.log").includes("hello-err"), false);
  assert.equal(logText(root, "app.err.log").includes("hello-out"), false);
  const rs = svc(root, "restart");
  assert.equal(rs.status, 0, rs.stderr);
  const second = pidOf(root);
  assert.notEqual(second.supervisor, first.supervisor);
  assert.equal(alive(first.supervisor) || groupAlive(first.child), false, "the first run is gone");
  const sp = svc(root, "stop");
  assert.equal(sp.status, 0, sp.stderr);
  assert.equal(alive(second.supervisor) || groupAlive(second.child), false);
  assert.equal(existsSync(join(root, "logs", "app.pid")), false);
  const after = svc(root, "status");
  assert.equal(after.status, 1);
  assert.match(after.stdout, /감독: 없음/);
  assert.match(after.stdout, /자식: 없음/);
});

test("AC10: a small rotation threshold rotates when size plus the write would pass it; at most 7 files per stream", async () => {
  const root = project("scripts");
  const line = "x".repeat(32);
  configure(root, `let i=0;const t=setInterval(()=>{const s='line-'+String(i).padStart(2,'0')+'-${line}';console.log(s);console.error(s);if(++i===30)clearInterval(t)},15);setInterval(()=>{},1000)`);
  const s = svc(root, "start", { SERVICE_LOG_ROTATE_BYTES: "100" });
  assert.equal(s.status, 0, s.stderr);
  pidOf(root);
  assert.ok(await waitFor(() => logText(root, "app.out.log").includes("line-29") && logText(root, "app.err.log").includes("line-29"), 10000));
  assert.equal(svc(root, "stop").status, 0);
  // Each line is 41 bytes: two fit under 100, the third would pass it, so the file rotates before that write.
  for (const stream of ["out", "err"]) {
    const files = readdirSync(join(root, "logs")).filter((f) => f.startsWith(`app.${stream}.`) && f.endsWith(".log"));
    assert.ok(files.some((f) => statSync(join(root, "logs", f)).size === 82), `${stream}: a file of exactly two lines`);
    assert.deepEqual(files.sort(), [`app.${stream}.log`, ...[1, 2, 3, 4, 5, 6].map((i) => `app.${stream}.${i}.log`)].sort(), stream);
    for (const f of files) {
      const size = statSync(join(root, "logs", f)).size;
      assert.ok(size > 0 && size <= 100, `${f}: ${size}`);
    }
    assert.match(logText(root, `app.${stream}.log`), /line-29/);
    assert.equal(logText(root, `app.${stream}.6.log`).includes("line-00"), false, "the oldest lines were dropped");
  }
});

test("AC10: with the supervisor killed, status reports it gone and the child apart; stop ends the child", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  assert.equal(svc(root, "start").status, 0);
  const p = pidOf(root);
  process.kill(p.supervisor, "SIGKILL");
  assert.ok(await waitFor(() => !alive(p.supervisor)));
  const st = svc(root, "status");
  assert.equal(st.status, 1);
  assert.match(st.stdout, /감독: 없음/);
  assert.match(st.stdout, /자식: 실행 중/);
  // On Windows the shell (p.child) dies with the supervisor's job object; the child status names is what it ran.
  const left = Number(/자식: 실행 중 \(PID (\d+)\)/.exec(st.stdout)?.[1]);
  started.push({ child: left });
  if (!WIN) assert.equal(left, p.child);
  const sp = svc(root, "stop");
  assert.equal(sp.status, 0, sp.stderr);
  assert.equal(groupAlive(p.child), false);
  assert.equal(alive(left), false, `the child status named (PID ${left}) is gone`);
});

test("AC10: empty command= makes start exit 2; a missing Node makes the wrapper exit 3; .sh files are 0755", () => {
  const root = project("scripts");
  const s = svc(root, "start");
  assert.equal(s.status, 2);
  assert.match(s.stderr, /command= 가 비어 있음/);
  assert.equal(svc(root, "start", { NODE: join(base, "no-such-node") }).status, 3);
  if (!WIN) for (const name of ["start", "stop", "status", "restart"]) assert.equal(statSync(join(root, "scripts", `${name}.sh`)).mode & 0o777, 0o755);
});

test("AC10: Windows .cmd wrappers are CRLF and stop uses taskkill", { skip: !WIN && "Windows 전용(.cmd, taskkill)" }, () => {
  const root = project("scripts");
  for (const name of ["start", "stop", "status", "restart"]) {
    const text = readFileSync(join(root, "scripts", `${name}.cmd`), "utf8");
    assert.equal(/(?<!\r)\n/.test(text), false, name);
  }
  assert.match(readFileSync(join(root, "scripts", "lib", "service.mjs"), "utf8"), /taskkill/);
});

test("AC11: tests/run.mjs prints one line per suite and exits 1 when a suite fails", () => {
  const root = project("tests");
  const node = `"${process.execPath}"`;
  const conf = join(root, "tests", "tests.conf");
  writeFileSync(conf, `unit=${node} -e "process.exit(0)"\nintegration=${node} -e "console.error('boom');process.exit(3)"\n`);
  const r = wrapper(root, "tests", "run");
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.trimEnd().split(/\r?\n/);
  assert.match(lines[0], /^PASS unit \(\d+\.\d+s\)$/);
  assert.match(lines[1], /^FAIL integration \(\d+\.\d+s, 종료 3\)$/);
  assert.equal(lines[2], "  boom");
  assert.equal(lines.at(-1), "결과: 통과 1, 실패 1, 건너뜀 0");
  const only = wrapper(root, "tests", "run", ["unit"]);
  assert.equal(only.status, 0);
  assert.deepEqual(only.stdout.trimEnd().split(/\r?\n/).map((l) => l.replace(/\(\d+\.\d+s\)/, "(t)")), ["PASS unit (t)", "결과: 통과 1, 실패 0, 건너뜀 0"]);
  assert.equal(wrapper(root, "tests", "run", ["nope"]).status, 2);
  writeFileSync(conf, "unit=\nintegration=\n");
  const none = wrapper(root, "tests", "run");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /실행할 명령 없음/);
});

// A live process that is not this service, started and ended by the test itself.
function stranger() {
  const p = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)"], { stdio: "ignore" });
  return p;
}
const plant = (root, value) => {
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "logs", "app.pid"), `${JSON.stringify(value)}\n`);
};

test("PID reuse: an unrelated live PID in the pid file is no running service; start runs anew and stop leaves it alive", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const other = stranger();
  try {
    assert.ok(await waitFor(() => alive(other.pid)));
    const recent = { supervisor: other.pid, child: other.pid, startedAt: new Date().toISOString(), command: "something else" };
    plant(root, recent);
    const sp = svc(root, "stop");
    assert.equal(sp.status, 0, sp.stderr);
    assert.match(sp.stdout, /실행 중 아님/);
    assert.match(sp.stderr, /이 서비스가 아님/);
    assert.equal(alive(other.pid), true, "stop did not signal the unrelated process");
    const st = svc(root, "status");
    assert.equal(st.status, 1);
    assert.match(st.stdout, /감독: 없음/);
    plant(root, recent);
    const s = svc(root, "start");
    assert.equal(s.status, 0, s.stderr);
    assert.doesNotMatch(s.stdout, /이미 실행 중/);
    assert.match(s.stdout, /시작함/);
    const mine = pidOf(root);
    assert.notEqual(mine.supervisor, other.pid);
    assert.equal(mine.command, `"${process.execPath}" -e "${WAITER}"`);
    assert.equal(svc(root, "stop").status, 0);
    assert.equal(alive(mine.supervisor) || groupAlive(mine.child), false);
    assert.equal(alive(other.pid), true, "the unrelated process is still alive");
  } finally {
    other.kill("SIGKILL");
  }
});

test("PID reuse: a pid file older than the last boot is stale and its live PID gets no signal", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const other = stranger();
  try {
    assert.ok(await waitFor(() => alive(other.pid)));
    plant(root, { supervisor: other.pid, child: other.pid, startedAt: "2000-01-01T00:00:00.000Z", command: `"${process.execPath}" -e "setInterval(()=>{},1e3)"` });
    const sp = svc(root, "stop");
    assert.equal(sp.status, 0, sp.stderr);
    assert.match(sp.stderr, /PID 파일이 낡음/);
    assert.equal(alive(other.pid), true);
  } finally {
    other.kill("SIGKILL");
  }
});

test("a failed rotation warns once in the stderr log and the service keeps writing to the current file", async () => {
  const root = project("scripts");
  configure(root, "let i=0;const t=setInterval(()=>{console.log('row-'+String(i).padStart(2,'0')+'-'+'y'.repeat(40));if(++i===20)clearInterval(t)},10);setInterval(()=>{},1000)");
  // A folder where the oldest rotated file goes makes every rotation of the stdout log fail. 400 bytes keeps the
  // warning line inside one stderr log file.
  mkdirSync(join(root, "logs", "app.out.6.log"), { recursive: true });
  writeFileSync(join(root, "logs", "app.out.6.log", "keep"), "x");
  const s = svc(root, "start", { SERVICE_LOG_ROTATE_BYTES: "400" });
  assert.equal(s.status, 0, s.stderr);
  pidOf(root);
  assert.ok(await waitFor(() => logText(root, "app.out.log").includes("row-19"), 10000));
  assert.equal(svc(root, "stop").status, 0);
  const warnings = logText(root, "app.err.log").split(/\r?\n/).filter((l) => l.startsWith("service: 로그 로테이션 실패"));
  assert.equal(warnings.length, 1, logText(root, "app.err.log"));
  for (let i = 0; i < 20; i++) assert.ok(logText(root, "app.out.log").includes(`row-${String(i).padStart(2, "0")}`), `row ${i}`);
});

test("Windows paths in the template: stop and the supervisor use taskkill /T, then /T /F after the grace time", () => {
  const root = project("scripts");
  const text = readFileSync(join(root, "scripts", "lib", "service.mjs"), "utf8");
  assert.match(text, /if \(WIN\) return taskkill\(pid, signal === "SIGKILL"\);/);
  assert.match(text, /killTimer \?\?= setTimeout\(\(\) => signalGroup\(child\.pid, "SIGKILL"\), STOP_GRACE_MS\)/);
  assert.match(text, /\|\| \(terminate\(own, true\), await waitGone\(own, 3000\)\)/);
  assert.match(text, /Get-CimInstance Win32_Process -Filter "ProcessId=\$\{pid\}"/);
});

test("AC11: a suite past its time limit is FAIL (timeout) and its whole process tree is killed; the environment wins over tests.conf", async () => {
  const root = project("tests");
  const node = `"${process.execPath}"`;
  const grand = join(root, "grandchild.pid");
  // The suite starts a grandchild that writes its PID, then both wait forever.
  const script = `const c=require('child_process').spawn(process.execPath,['-e','require(\\'fs\\').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1e3)',process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1e3)`;
  writeFileSync(join(root, "tests", "tests.conf"), `timeout=1\nunit=${node} -e "process.exit(0)"\nslow=${node} -e "${script}" "${grand}"\n`);
  const began = Date.now();
  const r = wrapper(root, "tests", "run");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const lines = r.stdout.trimEnd().split(/\r?\n/);
  assert.match(lines[0], /^PASS unit \(\d+\.\d+s\)$/);
  assert.match(lines[1], /^FAIL slow \(\d+\.\d+s, timeout 1초\)$/);
  assert.equal(lines.at(-1), "결과: 통과 1, 실패 1, 건너뜀 0");
  assert.ok(Date.now() - began < 20000, "the limit ended the run");
  assert.ok(existsSync(grand), "the grandchild started");
  const pid = Number(readFileSync(grand, "utf8"));
  assert.ok(await waitFor(() => !alive(pid)), `grandchild ${pid} is gone`);
  const env = wrapper(root, "tests", "run", ["slow"], { TESTS_TIMEOUT_SECONDS: "2" });
  assert.match(env.stdout, /^FAIL slow \(\d+\.\d+s, timeout 2초\)$/m);
  assert.ok(await waitFor(() => !alive(Number(readFileSync(grand, "utf8")))));
});

const serviceDirect = (root, cmd, env, preload = []) =>
  spawnSync(process.execPath, [...preload, join(root, "scripts", "lib", "service.mjs"), cmd], { encoding: "utf8", cwd: root, env: { ...ENV, ...env }, timeout: 30000 });

test("no ps on PATH (Linux): stop reads /proc and really stops a live service", { skip: process.platform !== "linux" && "Linux 전용(/proc)" }, async () => {
  const root = project("scripts");
  configure(root, WAITER);
  assert.equal(svc(root, "start").status, 0);
  const p = pidOf(root);
  const empty = join(base, `nops${n++}`);
  mkdirSync(empty);
  assert.equal(spawnSync("ps", [], { env: { PATH: empty } }).error?.code, "ENOENT", "ps is not reachable");
  const sp = serviceDirect(root, "stop", { PATH: empty });
  assert.equal(sp.status, 0, sp.stdout + sp.stderr);
  assert.match(sp.stdout, /멈춤/);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
  assert.equal(existsSync(join(root, "logs", "app.pid")), false);
});

test("command lines unreadable (no /proc, no ps; preload): stop, status, start, restart exit 1, keep the pid file and signal nothing", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  assert.equal(svc(root, "start").status, 0);
  const p = pidOf(root);
  const mark = join(base, `blind${n++}.log`);
  const blind = { NO_CMDLINE_MARK: mark };
  const preload = ["--import", NO_CMDLINE];
  const reader = process.platform === "linux" ? ["proc", "ps"] : [WIN ? "powershell.exe" : "ps"];
  const pidFile = join(root, "logs", "app.pid");
  const before = readFileSync(pidFile, "utf8");
  for (const cmd of ["stop", "status", "start", "restart"]) {
    rmSync(mark, { force: true });
    const r = serviceDirect(root, cmd, blind, preload);
    assert.equal(r.status, 1, `${cmd}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /확인 불가: 감독 PID \d+ 의 명령줄을 읽지 못함\(ENOENT\)/, cmd);
    assert.deepEqual([...new Set(readFileSync(mark, "utf8").trim().split("\n"))].sort(), reader.sort(), `${cmd} tried the real readers`);
    assert.equal(readFileSync(pidFile, "utf8"), before, `${cmd} keeps the pid file`);
    assert.ok(alive(p.supervisor) && groupAlive(p.child), `${cmd} signalled nothing`);
  }
  assert.equal(existsSync(join(root, "logs", "app.start.lock")), false, "start left no lock");
  assert.equal(svc(root, "stop").status, 0);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
  // A pid file older than the last boot stays stale even when command lines cannot be read.
  const other = stranger();
  try {
    assert.ok(await waitFor(() => alive(other.pid)));
    plant(root, { supervisor: other.pid, child: other.pid, startedAt: "2000-01-01T00:00:00.000Z", command: "x" });
    const sp = serviceDirect(root, "stop", blind, preload);
    assert.equal(sp.status, 0, sp.stderr);
    assert.match(sp.stderr, /PID 파일이 낡음/);
    assert.equal(alive(other.pid), true);
  } finally {
    other.kill("SIGKILL");
  }
});

// Runs the start wrapper without waiting, as a user starting it twice at once.
function startAsync(root) {
  const opts = { cwd: root, env: ENV };
  const p = WIN ? spawn("cmd.exe", ["/d", "/c", join(root, "scripts", "start.cmd")], opts) : spawn(join(root, "scripts", "start.sh"), [], opts);
  let out = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (out += c));
  return new Promise((resolve) => p.on("close", (code) => resolve({ code, out })));
}

test("start lock: four starts at once launch one supervisor; all exit 0, three report it already running, no lock is left", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const runs = await Promise.all([0, 1, 2, 3].map(() => startAsync(root)));
  const p = pidOf(root);
  for (const r of runs) assert.equal(r.code, 0, r.out);
  const startedRuns = runs.filter((r) => /시작함/.test(r.out));
  const already = runs.filter((r) => /이미 실행 중/.test(r.out));
  assert.equal(startedRuns.length, 1, runs.map((r) => r.out).join("\n"));
  assert.equal(already.length, 3, runs.map((r) => r.out).join("\n"));
  for (const r of runs) assert.match(r.out, new RegExp(`감독 PID ${p.supervisor}[,)]`), "every run names the same supervisor");
  assert.equal(existsSync(join(root, "logs", "app.start.lock")), false);
  assert.equal(svc(root, "stop").status, 0);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
});

test("start lock: a stale lock of a dead pid is taken over; a folder at the lock's name is refused", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  const deadPid = Number(dead.stdout.trim());
  assert.equal(alive(deadPid), false);
  const lock = join(root, "logs", "app.start.lock");
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(lock, `${JSON.stringify({ pid: deadPid, at: new Date(Date.now() - 60000).toISOString() })}\n`);
  const s = svc(root, "start");
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /시작함/);
  const p = pidOf(root);
  assert.equal(existsSync(lock), false);
  assert.equal(svc(root, "stop").status, 0);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
  mkdirSync(lock);
  const refused = svc(root, "start");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /시작 잠금 자리에 일반 파일이 아닌 것\(링크나 폴더\)이 있어 거부/);
  assert.equal(existsSync(join(root, "logs", "app.pid")), false, "nothing started");
});

// A lock left by a dead start, written as one (its pid dead, a minute old).
function staleLock(root, name = "app.start.lock") {
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  const deadPid = Number(dead.stdout.trim());
  assert.equal(alive(deadPid), false);
  mkdirSync(join(root, "logs"), { recursive: true });
  const file = join(root, "logs", name);
  writeFileSync(file, `${JSON.stringify({ pid: deadPid, at: new Date(Date.now() - 60000).toISOString() })}\n`);
  return file;
}

test("start lock: four starts at once over a stale lock launch one supervisor, rounds over; no lock or break lock is left", async () => {
  for (let round = 0; round < 3; round++) {
    const root = project("scripts");
    configure(root, WAITER);
    const lock = staleLock(root);
    const runs = await Promise.all([0, 1, 2, 3].map(() => startAsync(root)));
    const all = runs.map((r) => r.out).join("\n");
    const p = pidOf(root);
    for (const r of runs) assert.equal(r.code, 0, all);
    assert.equal(runs.filter((r) => /시작함/.test(r.out)).length, 1, `round ${round}: ${all}`);
    for (const r of runs) assert.match(r.out, new RegExp(`감독 PID ${p.supervisor}[,)]`), `round ${round}: every run names the same supervisor`);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.break`), false);
    assert.equal(svc(root, "stop").status, 0);
    assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
  }
});

test("start lock: a break lock left by a dead start is cleared after a while; a folder at its name is refused", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const lock = staleLock(root);
  staleLock(root, "app.start.lock.break");
  const s = svc(root, "start");
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /시작함/);
  const p = pidOf(root);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${lock}.break`), false);
  assert.equal(svc(root, "stop").status, 0);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
  staleLock(root);
  mkdirSync(`${lock}.break`);
  const refused = svc(root, "start");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /시작 잠금 정리 자리에 일반 파일이 아닌 것\(링크나 폴더\)이 있어 거부/);
  assert.equal(existsSync(join(root, "logs", "app.pid")), false, "nothing started");
  assert.equal(existsSync(lock), true, "the stale lock stays when it cannot be cleared safely");
});

test("start lock: a lock another start makes after the stale one was judged is never removed; this start waits and gives up", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const lock = staleLock(root);
  const r = serviceDirect(root, "start", {}, ["--import", LOCK_RACE]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /다른 start 가 \d+ms 넘게 진행 중/);
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).race, "A", "the fresh lock made after the stale one was judged is still there");
  assert.equal(existsSync(`${lock}.break`), false, "the break lock is gone");
  assert.equal(existsSync(join(root, "logs", "app.pid")), false, "nothing started");
});

test("start lock: EPERM and EBUSY from a lock or break lock being deleted (Windows) are waited out, not a failure", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const lock = staleLock(root);
  const mark = join(base, `busy${n++}.log`);
  const r = serviceDirect(root, "start", { LOCK_BUSY_MARK: mark }, ["--import", LOCK_BUSY]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /시작함/);
  assert.deepEqual(readFileSync(mark, "utf8").trim().split("\n").sort(), ["lstat break", "lstat lock", "open break", "open lock", "rm lock"], "every busy answer was met");
  const p = pidOf(root);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${lock}.break`), false);
  assert.equal(svc(root, "stop").status, 0);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
});

test("start lock: a logs folder this account cannot write fails at once with the reason, not as a start at work", { skip: (WIN && "POSIX 권한 비트 전용") || (process.getuid?.() === 0 && "root 는 권한 비트를 무시") }, () => {
  const root = project("scripts");
  configure(root, WAITER);
  const logs = join(root, "logs");
  mkdirSync(logs, { recursive: true });
  chmodSync(logs, 0o555);
  try {
    const t0 = Date.now();
    const r = svc(root, "start");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /시작 잠금을 만들지 못함\(EACCES\)/);
    assert.doesNotMatch(r.stderr, /진행 중/);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  } finally {
    chmodSync(logs, 0o755);
  }
});

test("start lock: a fresh break lock is left alone until it is older than 5 seconds", async () => {
  const root = project("scripts");
  configure(root, WAITER);
  const lock = staleLock(root);
  writeFileSync(`${lock}.break`, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  const t0 = Date.now();
  const r = serviceDirect(root, "start", { SERVICE_START_CHECK_MS: "3000" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 >= 4500, `waited ${Date.now() - t0} ms for the fresh break lock`);
  const p = pidOf(root);
  assert.equal(existsSync(`${lock}.break`), false);
  assert.equal(svc(root, "stop").status, 0);
  assert.ok(await waitFor(() => !alive(p.supervisor) && !groupAlive(p.child)));
});

test("start lock: a link to nothing at the lock's name is refused and no file is made where it leads", { skip: symlinkSkip }, () => {
  const root = project("scripts");
  configure(root, WAITER);
  mkdirSync(join(root, "logs"), { recursive: true });
  const target = join(root, "outside-made.json");
  const lock = join(root, "logs", "app.start.lock");
  symlinkSync(target, lock, "file");
  const r = svc(root, "start");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /시작 잠금 자리에 일반 파일이 아닌 것\(링크나 폴더\)이 있어 거부/);
  assert.equal(existsSync(target), false, "Windows opens O_EXCL through a link to nothing: the file must not appear");
  assert.equal(existsSync(join(root, "logs", "app.pid")), false);
});

test("start lock: a link to nothing at the break lock's name is refused and no file is made where it leads", { skip: symlinkSkip }, () => {
  const root = project("scripts");
  configure(root, WAITER);
  mkdirSync(join(root, "logs"), { recursive: true });
  const lock = join(root, "logs", "app.start.lock");
  writeFileSync(lock, `${JSON.stringify({ pid: 2147483646, at: new Date(Date.now() - 3600e3).toISOString() })}\n`);
  const target = join(root, "outside-break.json");
  symlinkSync(target, `${lock}.break`, "file");
  const r = svc(root, "start");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /시작 잠금 정리 자리에 일반 파일이 아닌 것\(링크나 폴더\)이 있어 거부/);
  assert.equal(existsSync(target), false, "Windows opens O_EXCL through a link to nothing: the file must not appear");
});

test("start lock: a symbolic link at the lock's name is refused and its target is not touched", { skip: symlinkSkip }, () => {
  const root = project("scripts");
  configure(root, WAITER);
  mkdirSync(join(root, "logs"), { recursive: true });
  const target = join(root, "elsewhere.json");
  writeFileSync(target, "keep\n");
  const lock = join(root, "logs", "app.start.lock");
  symlinkSync(target, lock, "file");
  const r = svc(root, "start");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /시작 잠금 자리에 일반 파일이 아닌 것\(링크나 폴더\)이 있어 거부/);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
  assert.equal(lstatSync(lock).isSymbolicLink(), true);
  assert.equal(existsSync(join(root, "logs", "app.pid")), false);
});
