// Tests for boxes.mjs. Run from the repo root: node --test skills/remains/scripts/boxes.test.mjs
// No network and no real box: every ssh and scp call goes to a recording stand-in.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  checkBox, installStop, loadBoxes, main, nodeTestCommand, parseArgs, parseTap, probeBox, remoteSteps, runOnBox, runScript,
  scpBase, spawnExec, sshBase,
} from "./boxes.mjs";

const dir = mkdtempSync(join(tmpdir(), "remains-boxes-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

const MAC = { name: "macos", os: "darwin", ssh: "svcmon@10.0.0.60", path: ["/usr/local/bin"] };
const WIN = { name: "windows", os: "win32", ssh: "kaydash@10.0.0.55" };
const ROCKY = { name: "rocky8", os: "linux", ssh: "root@10.0.0.65", runAs: "nobody", port: 2222 };
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
const BOX_DIR = "/tmp/banker-remains.Ab12Cd34";
const TAP_OK = "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n";

let seq = 0;
const config = (value) => {
  const f = join(dir, `boxes${seq++}.json`);
  writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value));
  return f;
};

test("a missing registration file means no boxes, not an error", () => {
  const r = loadBoxes(join(dir, "none.json"));
  assert.deepEqual(r.boxes, []);
  assert.equal(r.missing, true);
});

test("a valid registration file loads every box in order", () => {
  const r = loadBoxes(config({ boxes: [MAC, WIN, ROCKY] }));
  assert.deepEqual(r.boxes.map((b) => b.name), ["macos", "windows", "rocky8"]);
  assert.equal(r.missing, false);
});

test("a broken registration file stops with the reason", () => {
  assert.throws(() => loadBoxes(config("{ not json")), /JSON/);
  assert.throws(() => loadBoxes(config({ boxes: {} })), /boxes/);
  assert.throws(() => loadBoxes(config({ boxes: [MAC, { ...WIN, name: "macos" }] })), /macos/);
  assert.throws(() => loadBoxes(config({ boxes: [{ ...MAC, os: "freebsd" }] })), /boxes\[0\]/);
});

test("each box needs a name, a known os and a plain user@host", () => {
  assert.equal(checkBox(MAC, 0), null);
  assert.match(checkBox({ os: "linux", ssh: "a@b" }, 0), /name/);
  assert.match(checkBox({ name: "x y", os: "linux", ssh: "a@b" }, 0), /name/);
  assert.match(checkBox({ name: "..", os: "linux", ssh: "a@b" }, 0), /name/, "a name is a local folder and file name");
  assert.match(checkBox({ name: "x", os: "freebsd", ssh: "a@b" }, 0), /os/);
  assert.match(checkBox({ name: "x", os: "linux", ssh: "host-only" }, 0), /ssh/);
  assert.match(checkBox({ name: "x", os: "linux", ssh: "a@b; rm -rf /" }, 0), /ssh/);
  assert.match(checkBox({ name: "x", os: "linux", ssh: "-oProxyCommand=x@h" }, 0), /ssh/, "ssh must not read it as an option");
  assert.match(checkBox({ name: "x", os: "linux", ssh: "a@-h" }, 0), /ssh/);
  assert.match(checkBox(null, 3), /boxes\[3\]/);
});

test("passwords and unknown fields are refused, so a typo cannot pass silently", () => {
  assert.match(checkBox({ ...MAC, password: "x" }, 0), /비밀번호/);
  assert.match(checkBox({ ...MAC, apiToken: "x" }, 0), /비밀번호/);
  assert.match(checkBox({ ...MAC, prot: 22 }, 0), /prot/);
});

test("optional fields are checked: port range, absolute PATH entries, runAs only for a root Linux login", () => {
  assert.equal(checkBox(ROCKY, 0), null);
  assert.equal(checkBox({ ...WIN, identity: "C:\\keys\\id_ed25519" }, 0), null);
  assert.match(checkBox({ ...MAC, port: 70000 }, 0), /port/);
  assert.match(checkBox({ ...MAC, identity: "" }, 0), /identity/);
  assert.match(checkBox({ ...MAC, path: ["bin"] }, 0), /path/);
  assert.match(checkBox({ ...MAC, path: ["/usr/bin;rm -rf /"] }, 0), /path/);
  assert.match(checkBox({ ...WIN, path: ["C:\\tools"] }, 0), /path/);
  assert.match(checkBox({ ...MAC, runAs: "nobody" }, 0), /runAs/);
  assert.match(checkBox({ ...ROCKY, runAs: "no body" }, 0), /runAs/);
  assert.match(checkBox({ ...ROCKY, ssh: "svc@10.0.0.65" }, 0), /runAs/, "runuser needs root");
});

test("ssh and scp never prompt, accept a new host key once, and carry the port and key file", () => {
  assert.deepEqual(sshBase(MAC), SSH_OPTS);
  assert.deepEqual(sshBase(ROCKY), [...SSH_OPTS, "-p", "2222"]);
  assert.deepEqual(scpBase({ ...ROCKY, identity: "/k/id" }), [...SSH_OPTS, "-P", "2222", "-i", "/k/id"]);
});

test("the run script records its process id, enters the tree, adds the box's PATH entries and runs the command", () => {
  const s = runScript(MAC, "repo", "node --test a.test.mjs");
  assert.equal(s.ext, ".sh");
  assert.equal(s.text, '#!/bin/sh\necho $$ > "$(dirname "$0")/pid"\ncd "$(dirname "$0")/repo" || exit 97\n'
    + "PATH='/usr/local/bin':\"$PATH\"; export PATH\nnode --test a.test.mjs\n");
  assert.ok(!runScript(ROCKY, "repo", "x").text.includes("PATH="), "no PATH line without entries");
});

test("on Windows the command runs from a .cmd file through call, with CRLF line ends and its exit code", () => {
  const s = runScript(WIN, "repo", "npm test");
  assert.equal(s.ext, ".cmd");
  assert.equal(s.text, '@echo off\r\ncd /d "%~dp0repo" || exit /b 97\r\ncall npm test\r\nexit /b %ERRORLEVEL%\r\n');
});

test("node test commands quote each file for the box's shell", () => {
  assert.equal(nodeTestCommand("linux", ["a.test.mjs", "b c.test.mjs"]), "node --test --test-reporter=tap 'a.test.mjs' 'b c.test.mjs'");
  assert.equal(nodeTestCommand("darwin", ["it's.test.mjs"]), "node --test --test-reporter=tap 'it'\\''s.test.mjs'");
  assert.equal(nodeTestCommand("win32", ["a b.test.mjs"]), 'node --test --test-reporter=tap "a b.test.mjs"');
});

test("the TAP summary and the failing test names come from node's reporter, TODO tests left out", () => {
  const tap = "TAP version 13\n# Subtest: x\nnot ok 1 - x fails\n  ---\n  ...\nok 2 - y\n    not ok 1 - nested\n"
    + "not ok 3 - x fails\nnot ok 4 - later # TODO not yet\n1..4\n# tests 5\n# suites 0\n# pass 1\n# fail 3\n# cancelled 0\n# skipped 0\n# todo 1\n";
  const r = parseTap(tap);
  assert.deepEqual([r.tests, r.pass, r.fail, r.skipped, r.todo], [5, 1, 3, 0, 1]);
  assert.deepEqual(r.failures, ["x fails", "nested"]);
  assert.equal(parseTap("plain output, no summary"), null);
});

test("probe reads node, git and tar from a box that answers", async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return { status: 0, stdout: "Darwin x86_64\nv22.23.3\ngit version 2.50.1\ntar-ok\n", stderr: "" };
  };
  const r = await probeBox(MAC, exec);
  assert.deepEqual([r.reachable, r.node, r.git, r.tar], [true, "v22.23.3", true, true]);
  assert.deepEqual(calls[0].slice(0, SSH_OPTS.length + 2), ["ssh", ...SSH_OPTS, "svcmon@10.0.0.60"]);
  assert.ok(calls[0].at(-1).startsWith("PATH='/usr/local/bin':\"$PATH\"; "));
});

test("probe reports an unreachable box with ssh's own reason", async () => {
  const exec = async () => ({ status: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.60 port 22: No route to host\r\n" });
  const r = await probeBox(MAC, exec);
  assert.equal(r.reachable, false);
  assert.equal(r.error, "ssh: connect to host 10.0.0.60 port 22: No route to host");
});

test("on Windows probe goes through cmd /c, which works whichever shell sshd starts", async () => {
  let remote;
  const exec = async (_file, args) => {
    remote = args.at(-1);
    return { status: 0, stdout: "Microsoft Windows [Version 10.0.19045]\r\nnode-missing\r\ngit version 2.55.0\r\ntar-ok\r\n", stderr: "" };
  };
  const r = await probeBox(WIN, exec);
  assert.ok(remote.startsWith('cmd /c "'));
  assert.deepEqual([r.reachable, r.node, r.git, r.tar], [true, null, true, true]);
});

// A recording stand-in for ssh and scp. It tells the steps apart by what it is asked to do.
function fakeExec({ failAt = null, run = { status: 0, stdout: TAP_OK, stderr: "" }, made = `${BOX_DIR}\n`, end = 0, onRun = null } = {}) {
  const calls = [];
  const kind = (file, last) => {
    if (file === "scp") return "upload";
    if (/mktemp -d/.test(last)) return "prepare";
    if (/pgrep -P|powershell/.test(last)) return "abort";
    return /rm -rf|rmdir/.test(last) ? "cleanup" : "run";
  };
  const exec = async (file, args) => {
    const step = kind(file, args.at(-1));
    calls.push({ step, args });
    if (step === failAt) return { status: 255, stdout: "", stderr: "ssh: connect to host x port 22: Connection refused\n" };
    if (step === "prepare") return { status: 0, stdout: made, stderr: "" };
    if (step === "run") return onRun ? onRun() : run;
    return { status: step === "upload" ? 0 : end, stdout: "", stderr: "" };
  };
  return { calls, exec, steps: () => calls.map((c) => c.step) };
}
const plan = (extra = {}) => ({ id: "banker-remains-ab12", tar: join(dir, "t.tar"), prefix: "repo", scriptDir: mkdtempSync(join(dir, "plan-")),
  commandFor: () => "node --test", timeoutMs: 60000, ctl: { stopping: null }, ...extra });
writeFileSync(join(dir, "t.tar"), "tar bytes");

test("a Linux or macOS run makes a private folder, uploads into it, runs, and cleans up", async () => {
  const f = fakeExec();
  const p = plan();
  const r = await runOnBox(MAC, p, f.exec);
  assert.deepEqual(f.steps(), ["prepare", "upload", "run", "cleanup"]);
  const up = f.calls[1].args;
  assert.deepEqual(up.slice(-3), [join(p.scriptDir, "macos", "banker-remains-ab12-macos.tar"),
    join(p.scriptDir, "macos", "banker-remains-ab12-macos.sh"), `svcmon@10.0.0.60:${BOX_DIR}/`]);
  assert.ok(readFileSync(up.at(-2), "utf8").endsWith("\nnode --test\n"));
  assert.ok(f.calls[2].args.at(-1).startsWith(`sh -c 'D=${BOX_DIR}; cd "$D" && tar -xf banker-remains-ab12-macos.tar`));
  assert.ok(f.calls[2].args.at(-1).includes('sh "$D/run.sh"'));
  assert.equal(f.calls[3].args.at(-1), `sh -c 'rm -rf ${BOX_DIR} && [ ! -e ${BOX_DIR} ]'`);
  assert.deepEqual([r.reachable, r.exit, r.summary.pass, r.cleaned], [true, 0, 1, true]);
});

test("a box that cannot make its folder is unreachable and gets nothing else", async () => {
  const f = fakeExec({ failAt: "prepare" });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual(f.steps(), ["prepare"]);
  assert.deepEqual([r.reachable, r.error], [false, "ssh: connect to host x port 22: Connection refused"]);
});

test("a folder path that mktemp should not have made is refused before anything is sent", async () => {
  const f = fakeExec({ made: "/home/svcmon\n" });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual(f.steps(), ["prepare"]);
  assert.match(r.error, /mktemp/);
});

test("cleanup still runs when the upload fails, and the box is reported unreachable", async () => {
  const f = fakeExec({ failAt: "upload" });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual(f.steps(), ["prepare", "upload", "cleanup"]);
  assert.equal(r.reachable, false);
  assert.match(r.error, /Connection refused/);
});

test("a run that loses the connection is unreachable and ends what it started on the box", async () => {
  const f = fakeExec({ failAt: "run" });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual([r.reachable, r.exit], [false, null]);
  assert.deepEqual(f.steps(), ["prepare", "upload", "run", "abort"]);
  const abort = f.calls[3].args.at(-1);
  assert.ok(abort.includes('P=$(cat "$D/pid" 2>/dev/null)') && abort.includes("kill -s KILL $L"));
});

test("a run that times out ends the process tree on the box before removing its folder", async () => {
  const f = fakeExec({ run: { status: null, stdout: "", stderr: "", timedOut: true } });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual([r.reachable, r.timedOut], [true, true]);
  assert.equal(f.steps().at(-1), "abort");
});

test("a run stopped by a signal ends what it started on the box", async () => {
  const p = plan();
  const f = fakeExec({ onRun: () => { p.ctl.stopping = "SIGTERM"; return { status: 143, stdout: "", stderr: "" }; } });
  const r = await runOnBox(MAC, p, f.exec);
  assert.equal(f.steps().at(-1), "abort");
  assert.equal(r.stopped, true);
});

test("a command that exits 255 by itself keeps its result and output", async () => {
  const f = fakeExec({ run: { status: 255, stdout: "partial\n", stderr: "my tool failed\n" } });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual([r.reachable, r.exit, r.stdout], [true, 255, "partial\n"]);
  assert.equal(f.steps().at(-1), "cleanup");
});

test("a command that fails on the box is a result with its failing tests", async () => {
  const f = fakeExec({ run: { status: 1, stdout: "not ok 2 - broke\n# tests 2\n# pass 1\n# fail 1\n# skipped 0\n", stderr: "" } });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.deepEqual([r.reachable, r.exit, r.summary.failures], [true, 1, ["broke"]]);
});

test("a cleanup that fails is reported, not hidden", async () => {
  const f = fakeExec({ end: 1 });
  const r = await runOnBox(MAC, plan(), f.exec);
  assert.equal(r.cleaned, false);
});

test("a root Linux box runs the script as the configured account, with a HOME of its own", async () => {
  const f = fakeExec();
  await runOnBox(ROCKY, plan(), f.exec);
  const run = f.calls.find((c) => c.step === "run").args.at(-1);
  assert.ok(run.includes('chown -R nobody "$D"'));
  assert.ok(run.includes('runuser -u nobody -- env HOME="$D/home" sh "$D/run.sh"'));
  assert.ok(f.calls[1].args.includes("-P") && f.calls[2].args.includes("-p"), "the port reaches scp and ssh");
});

test("a Windows box works in the profile folder by relative names, so spaces in it do not matter", async () => {
  const f = fakeExec();
  await runOnBox(WIN, plan(), f.exec);
  assert.deepEqual(f.steps(), ["upload", "run", "cleanup"]);
  assert.equal(f.calls[0].args.at(-1), "kaydash@10.0.0.55:");
  const n = "banker-remains-ab12-windows";
  assert.equal(f.calls[1].args.at(-1), `cmd /c "mkdir ${n} && tar -xf ${n}.tar -C ${n} && del ${n}.tar`
    + ` && move /y ${n}.cmd ${n}\\run.cmd >nul && ${n}\\run.cmd"`);
  assert.ok(f.calls[2].args.at(-1).includes(`if exist ${n} (exit /b 1) else (exit /b 0)`), "a folder that stays is a failed cleanup");
});

test("ending a Windows run kills the process trees whose command line holds the run's name", () => {
  const abort = remoteSteps(WIN, "banker-remains-ab12-windows").abort;
  const script = Buffer.from(abort.split(" ").at(-1), "base64").toString("utf16le");
  assert.ok(abort.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand "));
  assert.ok(script.includes("-like '*banker-remains-ab12-windows*'") && script.includes("taskkill /F /T /PID"));
  assert.ok(script.includes("if (Test-Path 'banker-remains-ab12-windows') { exit 1 }"));
});

test("the command line takes list, probe and run with their options", () => {
  assert.deepEqual(parseArgs(["list"]), { cmd: "list", boxes: [], ref: "HEAD", nodeTest: false, command: null, timeoutMin: 20, out: null });
  assert.deepEqual(parseArgs(["probe", "--box", "macos"]).boxes, ["macos"]);
  const r = parseArgs(["run", "--node-test", "--ref", "worktree", "--box", "a", "--box", "b", "--timeout", "5", "--out", "/o"]);
  assert.deepEqual([r.cmd, r.nodeTest, r.ref, r.boxes, r.timeoutMin, r.out], ["run", true, "worktree", ["a", "b"], 5, "/o"]);
  assert.equal(parseArgs(["run", "--cmd", "npm test"]).command, "npm test");
  assert.throws(() => parseArgs(["run"]), /--cmd/);
  assert.throws(() => parseArgs(["run", "--cmd", "x", "--node-test"]), /하나만/);
  assert.throws(() => parseArgs(["wipe"]), /list/);
  assert.throws(() => parseArgs(["run", "--node-test", "--timeout", "0"]), /timeout/);
  assert.throws(() => parseArgs(["run", "--node-test", "--box"]), /--box/);
  assert.throws(() => parseArgs(["run", "--node-test", "--bogus"]), /--bogus/);
});

const sink = () => {
  const s = { text: "", write: (t) => { s.text += t; return true; } };
  return s;
};
const signals = () => new EventEmitter();

test("list says where to register boxes when there is no file", async () => {
  const out = sink();
  const err = sink();
  const code = await main(["list"], { file: join(dir, "nothing.json"), out, err });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.text).boxes, []);
  assert.match(err.text, /test-boxes\.json/);
});

test("an unknown box name or a broken file is a usage error", async () => {
  const file = config({ boxes: [MAC] });
  assert.equal(await main(["probe", "--box", "nope"], { file, out: sink(), err: sink() }), 2);
  assert.equal(await main(["list"], { file: config("[1,"), out: sink(), err: sink() }), 2);
});

function gitRepo() {
  const repo = mkdtempSync(join(dir, "repo-"));
  const g = (...a) => assert.equal(spawnSync("git", a, { cwd: repo, encoding: "utf8" }).status, 0, a.join(" "));
  g("init", "-q");
  mkdirSync(join(repo, "lib"));
  writeFileSync(join(repo, "lib", "a.test.mjs"), "// a\n");
  writeFileSync(join(repo, "notes.md"), "x\n");
  g("add", ".");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  return repo;
}
const runMain = async (args, { boxes = [MAC], exec = fakeExec().exec, repo = gitRepo(), tag = `logs${seq++}` } = {}) => {
  const out = sink();
  const code = await main(["run", ...args, "--out", join(dir, tag)], { file: config({ boxes }), out, err: sink(), exec, cwd: repo, signals: signals() });
  return { code, report: out.text ? JSON.parse(out.text) : null };
};

test("run sends a committed tree to every box and writes each box's log", { skip: !HAS_GIT && "git not found" }, async () => {
  const { code, report } = await runMain(["--node-test"], { boxes: [MAC, WIN], tag: "logs-run" });
  assert.equal(code, 0);
  assert.deepEqual(report.boxes.map((b) => [b.name, b.reachable, b.exit, b.cleaned]), [["macos", true, 0, true], ["windows", true, 0, true]]);
  assert.match(report.command.darwin, /'lib\/a\.test\.mjs'$/);
  assert.match(report.command.win32, /"lib\/a\.test\.mjs"$/);
  assert.ok(existsSync(join(dir, "logs-run", "macos.log")) && existsSync(join(dir, "logs-run", "windows.log")));
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith(report.id)).length, 0, "the local tree and scripts are removed");
});

test("run with --ref worktree sends changes not yet committed, as committed bytes", { skip: !HAS_GIT && "git not found" }, async () => {
  const repo = gitRepo();
  // Git for Windows sets core.autocrlf=true; an archive made with it would carry CRLF to every box.
  spawnSync("git", ["config", "core.autocrlf", "true"], { cwd: repo });
  writeFileSync(join(repo, "notes.md"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  let sent = null;
  const f = fakeExec();
  const exec = async (file, args) => {
    if (file === "scp") sent = spawnSync("tar", ["-xOf", args.at(-3), "repo/notes.md"], { encoding: "utf8" }).stdout;
    return f.exec(file, args);
  };
  const { report } = await runMain(["--cmd", "true", "--ref", "worktree"], { exec, repo });
  assert.equal(sent, "changed\n", "the tar that reaches the box has the uncommitted change");
  assert.equal(report.untracked, 1, "untracked files are counted, since they are not sent");
});

test("run exits 1 when a box cannot be reached and says why", { skip: !HAS_GIT && "git not found" }, async () => {
  const { code, report } = await runMain(["--cmd", "true"], { exec: fakeExec({ failAt: "prepare" }).exec });
  assert.equal(code, 1);
  assert.deepEqual([report.boxes[0].reachable, report.boxes[0].error], [false, "ssh: connect to host x port 22: Connection refused"]);
});

test("run exits 1 when tests fail, time out or do not run at all", { skip: !HAS_GIT && "git not found" }, async () => {
  const failing = fakeExec({ run: { status: 1, stdout: "not ok 1 - a\n# tests 1\n# pass 0\n# fail 1\n", stderr: "" } });
  assert.equal((await runMain(["--node-test"], { exec: failing.exec })).code, 1);
  const slow = fakeExec({ run: { status: null, stdout: "", stderr: "", timedOut: true } });
  assert.equal((await runMain(["--node-test"], { exec: slow.exec })).code, 1);
  const none = await runMain(["--node-test"], { exec: fakeExec({ run: { status: 0, stdout: "# tests 0\n# pass 0\n# fail 0\n", stderr: "" } }).exec });
  assert.deepEqual([none.code, none.report.boxes[0].noTests], [1, true], "zero tests is not a pass");
});

test("the first stop signal ends the ssh and scp in flight without leaving, and the handlers come off afterwards", () => {
  const ctl = { stopping: null };
  const on = signals();
  const killed = [];
  const remove = installStop(ctl, { on, kill: () => killed.push("in-flight"), exit: () => assert.fail("one signal does not exit") });
  on.emit("SIGTERM", "SIGTERM");
  assert.deepEqual([ctl.stopping, killed], ["SIGTERM", ["in-flight"]]);
  remove();
  assert.equal(on.listenerCount("SIGTERM") + on.listenerCount("SIGINT"), 0);
});

test("a SIGTERM during a run ends the run on the box, cleans up and exits 143", { skip: !HAS_GIT && "git not found" }, async () => {
  const on = signals();
  const f = fakeExec({ onRun: () => { on.emit("SIGTERM", "SIGTERM"); return { status: 143, stdout: "", stderr: "" }; } });
  const out = sink();
  const code = await main(["run", "--cmd", "true", "--out", join(dir, "logs-stop")],
    { file: config({ boxes: [MAC] }), out, err: sink(), exec: f.exec, cwd: gitRepo(), signals: on });
  assert.equal(code, 143);
  assert.equal(f.steps().at(-1), "abort");
  assert.equal(JSON.parse(out.text).boxes[0].cleaned, true);
  assert.equal(on.listenerCount("SIGTERM"), 0);
});

test("spawnExec reports a missing program and a timeout without hanging", async () => {
  const missing = await spawnExec("banker-remains-no-such-program", [], { timeoutMs: 5000 });
  assert.equal(missing.status, null);
  assert.match(missing.stderr, /ENOENT/);
  const t0 = Date.now();
  const slow = await spawnExec(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, "returns soon after the limit");
});
