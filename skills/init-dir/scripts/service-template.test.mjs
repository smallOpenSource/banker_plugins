// The templates init-dir writes, run for real (US-2 acceptance 10 and 11): scripts/lib/service.mjs through the
// start, stop, status and restart wrappers (.sh on POSIX, .cmd on Windows), and tests/run.mjs.
// Temp project folders and a temp HOME only.
// Run: node --test skills/init-dir/scripts/service-template.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const CLI = fileURLToPath(new URL("./init-dir.mjs", import.meta.url));
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
  const sp = svc(root, "stop");
  assert.equal(sp.status, 0, sp.stderr);
  assert.equal(groupAlive(p.child), false);
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
