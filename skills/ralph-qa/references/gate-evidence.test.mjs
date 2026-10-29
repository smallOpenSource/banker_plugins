// Tests for gate-evidence.mjs as a program: it runs the gate command itself, records what it saw, ends a command past
// its limit with every process it started, keeps PowerShell's exit codes, and tells observed from reported.
// Run: node --test skills/ralph-qa/references/gate-evidence.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeRunFolder } from "./run-folder.mjs";
import { outputText, shellFor } from "./gate-evidence.mjs";

const TOOL = fileURLToPath(new URL("./gate-evidence.mjs", import.meta.url));
const WIN = process.platform === "win32";
const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const NODE = process.execPath;
// A word for the shell this OS runs a gate in: sh quotes, or PowerShell's call operator with its quotes.
const q = (s) => (WIN ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`);
const nodeCmd = (...args) => `${WIN ? "& " : ""}${[NODE, ...args].map(q).join(" ")}`;

function world(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rq-ge-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const base = WIN ? join(home, "AppData", "Local", "Temp") : join(dir, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...(WIN ? { TEMP: base, TMP: base } : process.platform === "darwin" ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }),
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const d = makeRunFolder({ env, platform: process.platform }, "ralph-qa-gates").dir;
  const repo = join(dir, "repo");
  mkdirSync(repo);
  if (HAS_GIT) {
    for (const a of [["-c", "init.defaultBranch=main", "init", "-q"], ["commit", "-q", "--allow-empty", "-m", "base"]]) spawnSync("git", ["-C", repo, ...a], { env });
  }
  return { dir, env, d, repo, base };
}

function cli(w, args) {
  const r = spawnSync(NODE, [TOOL, ...args], { encoding: "utf8", env: w.env, timeout: 120000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const run = (w, id, cmd, extra = []) => cli(w, ["run", "--dir", w.d, "--id", id, "--cmd", cmd, "--timeout", "30", "--cwd", w.repo, ...extra]);
const evidence = (w) => readFileSync(join(w.d, "evidence.md"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("run executes the command itself and records what it saw: exit, output file and its sha256, fingerprint, verdict", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  let r = run(w, "tests", nodeCmd("-e", "console.log('ok 1'); console.error('to stderr')"));
  assert.equal(r.code, 0, r.stderr);
  const rec = r.json;
  assert.deepEqual([rec.kind, rec.id, rec.iter, rec.seq, rec.exit, rec.verdict, rec.timedOut], ["observed", "tests", 0, 1, 0, "pass", false]);
  assert.equal(rec.shell, WIN ? (rec.shell === "pwsh" ? "pwsh" : "powershell") : "sh");
  const out = readFileSync(rec.output, "utf8");
  assert.ok(out.includes("ok 1") && out.includes("to stderr"), "stdout and stderr both on the output file");
  assert.match(rec.output, /gate-tests-0-1\.md$/);
  assert.ok(rec.git && /^[0-9a-f]{64}$/.test(rec.fingerprint) && /^[0-9a-f]{64}$/.test(rec.outputSha256));
  r = run(w, "tests", nodeCmd("-e", "console.log('not ok 1 - adds'); process.exit(7)"), ["--iter", "1"]);
  assert.deepEqual([r.json.exit, r.json.verdict, r.json.iter, r.json.seq], [7, "fail", 1, 2]);
  assert.match(r.json.signature, /^tests:[0-9a-f]{16}$/);
  assert.deepEqual(evidence(w).map((x) => x.seq), [1, 2]);
});

test("the child writes the output file itself: its bytes and sha256 are what it printed, and a file already there is never reused", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const text = "line one\nline two\n".repeat(300);
  writeFileSync(join(w.d, "gate-tests-0-1.md"), "left by a run that stopped");
  // 큰따옴표는 Windows PowerShell 5.1 이 외부 프로그램 인자에서 지우므로, 작은따옴표 JS 문자열로 넘긴다
  const r = run(w, "tests", nodeCmd("-e", "process.stdout.write('line one\\nline two\\n'.repeat(300))"));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.output, /gate-tests-0-2\.md$/);
  assert.equal(readFileSync(r.json.output, "utf8"), text);
  assert.equal(r.json.bytes, Buffer.byteLength(text));
  assert.equal(r.json.outputSha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(readFileSync(join(w.d, "gate-tests-0-1.md"), "utf8"), "left by a run that stopped");
  const src = readFileSync(TOOL, "utf8");
  assert.ok(!/stdio:\s*\[\s*"ignore",\s*"pipe"/.test(src) && !/\.on\("data"/.test(src), "no Node pipes for the gate's output");
});

test("exit 0 with a failure or skip count in the output is misleading, not a pass", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const r = run(w, "tests", nodeCmd("-e", "console.log('ℹ tests 2'); console.log('ℹ skipped 1')"));
  assert.deepEqual([r.json.exit, r.json.verdict], [0, "misleading"]);
});

test("past the limit the whole tree ends: the command and the child it started are gone when run returns", { skip: !HAS_GIT && "no git", timeout: 60000 }, (t) => {
  const w = world(t);
  const pidFile = join(w.dir, "child-pid.md");
  const script = join(w.dir, "spawner.mjs");
  writeFileSync(script, `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n`
    + `const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });\n`
    + `writeFileSync(process.argv[2], String(c.pid));\nsetTimeout(() => {}, 120000);\n`);
  const t0 = Date.now();
  const r = cli(w, ["run", "--dir", w.d, "--id", "hang", "--cmd", nodeCmd(script, pidFile), "--timeout", "2", "--cwd", w.repo]);
  assert.deepEqual([r.json.verdict, r.json.timedOut], ["timeout", true], r.stdout + r.stderr);
  assert.ok(Date.now() - t0 < 30000, "it did not wait for the command");
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = Date.now() + 5000;
  while (alive() && Date.now() < until) spawnSync(NODE, ["-e", "setTimeout(() => {}, 100)"]);
  assert.equal(alive(), false, "the grandchild was ended with the tree");
});

test("the shell keeps the command's exit code, also after a trailing comment", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  assert.equal(run(w, "a", nodeCmd("-e", "process.exit(3)")).json.exit, 3);
  assert.equal(run(w, "b", `${nodeCmd("-e", "process.exit(4)")} # a comment`).json.exit, 4);
  assert.equal(run(w, "c", nodeCmd("-e", "process.exit(0)")).json.exit, 0);
});

test("on Windows a failed cmdlet is exit 1 and a native exit code above 1 is kept (PowerShell 5.1 and 7)", { skip: !WIN && "Windows only" }, (t) => {
  const w = world(t);
  assert.equal(run(w, "cmdlet", "Get-Item -LiteralPath 'C:\\rq-no-such-path-x'").json.exit, 1);
  assert.equal(run(w, "native", nodeCmd("-e", "process.exit(9)")).json.exit, 9);
  const sh = shellFor("x", { platform: "win32", env: { PATH: "", SystemRoot: "C:\\Windows" } });
  assert.match(sh.exe, /WindowsPowerShell\\v1\.0\\powershell\.exe$/i, "5.1 when no pwsh is on PATH");
});

test("the shell for each OS: sh -c, or PowerShell with the exit that keeps the code on its own line", () => {
  assert.deepEqual(shellFor("npm test", { platform: "linux", env: {} }), { name: "sh", exe: "/bin/sh", args: ["-c", "npm test"] });
  const ps = shellFor("npm test", { platform: "win32", env: { PATH: "", SystemRoot: "C:\\Windows" } });
  assert.equal(ps.name, "powershell");
  assert.deepEqual(ps.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(ps.args[3], /^npm test\n\$rqOk = \$\?; .*exit \$LASTEXITCODE.*exit 0$/s);
});

test("note is a reported line: kept apart, and the gate check reads only observed lines", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  let r = cli(w, ["note", "--dir", w.d, "--id", "tests", "--iter", "1", "--exit", "0", "--text", "the model says all passed"]);
  assert.deepEqual([r.code, r.json.kind, r.json.exit], [0, "reported", 0]);
  r = cli(w, ["gate", "--dir", w.d, "--gates", "tests", "--iter", "1", "--cwd", w.repo]);
  assert.deepEqual([r.code, r.json.ok, r.json.gates[0].state], [1, false, "missing"]);
  run(w, "tests", nodeCmd("-e", "0"), ["--iter", "1"]);
  r = cli(w, ["gate", "--dir", w.d, "--gates", "tests", "--iter", "1", "--cwd", w.repo]);
  assert.deepEqual([r.code, r.json.ok], [0, true]);
});

test("a change to an untracked file after the gate makes its record stale", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  writeFileSync(join(w.repo, "new.mjs"), "export const a = 1;\n");
  run(w, "tests", nodeCmd("-e", "0"), ["--iter", "1"]);
  assert.equal(cli(w, ["gate", "--dir", w.d, "--gates", "tests", "--iter", "1", "--cwd", w.repo]).json.ok, true);
  writeFileSync(join(w.repo, "new.mjs"), "export const a = 2;\n");
  const r = cli(w, ["gate", "--dir", w.d, "--gates", "tests", "--iter", "1", "--cwd", w.repo]);
  assert.deepEqual([r.json.ok, r.json.gates[0].state], [false, "stale"]);
});

test("verify checks each output file against its recorded sha256", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const rec = run(w, "tests", nodeCmd("-e", "console.log('ok')")).json;
  assert.deepEqual([cli(w, ["verify", "--dir", w.d]).code], [0]);
  writeFileSync(rec.output, "ok, made up\n");
  const r = cli(w, ["verify", "--dir", w.d]);
  assert.deepEqual([r.code, r.json.bad[0].state], [1, "changed"]);
});

test("a folder that is no run folder is a stop; a bad argument is a usage error and runs nothing", (t) => {
  const w = world(t);
  const plain = join(w.dir, "ralph-qa.plain1");
  mkdirSync(plain);
  writeFileSync(join(plain, ".ralph-qa"), "");
  const marker = join(w.dir, "ran.md");
  let r = cli(w, ["run", "--dir", plain, "--id", "tests", "--cmd", nodeCmd("-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`), "--timeout", "5"]);
  assert.deepEqual([r.code, r.json.stop], [3, "not-a-run-folder"]);
  for (const args of [["run", "--dir", w.d, "--id", "Bad Id", "--cmd", "x", "--timeout", "5"], ["run", "--dir", w.d, "--id", "t", "--cmd", "x", "--timeout", "0"],
    ["run", "--dir", w.d, "--id", "t", "--cmd", "x"], ["nope"], ["run", "--dir", w.d, "--id", "t", "--cmd", "x", "--timeout", "5", "--extra", "1"]]) {
    r = cli(w, args);
    assert.equal(r.code, 2, args.join(" "));
  }
  assert.equal(existsSync(marker), false, "nothing ran");
});

// H1: one gate folder for the whole run, made by init before the baseline, kept across the iterations, removed once.
test("init makes the gate folder once; its records span the iterations, so a lucky pass after a failure stays flaky; cleanup removes it alone", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const made = cli(w, ["init", "--cwd", w.repo]);
  assert.equal(made.code, 0, made.stderr);
  const g = made.json.dir;
  assert.match(g, /[\\/]ralph-qa-gates\.[A-Za-z0-9]+$/);
  assert.ok(existsSync(join(g, ".ralph-qa-gates")));
  const gateRun = (iter, code) => cli(w, ["run", "--dir", g, "--id", "tests", "--cmd", nodeCmd("-e", `console.log('not ok ${iter}'); process.exit(${code})`), "--timeout", "30", "--iter", String(iter), "--cwd", w.repo]);
  gateRun(0, 0);
  gateRun(1, 1);
  gateRun(2, 0);
  let r = cli(w, ["gate", "--dir", g, "--gates", "tests", "--iter", "2", "--cwd", w.repo]);
  assert.deepEqual([r.code, r.json.gates[0].state, r.json.gates[0].need], [1, "flaky", 2], "the failure of iteration 1 is in the same folder");
  for (let i = 0; i < 2; i += 1) gateRun(2, 0);
  r = cli(w, ["gate", "--dir", g, "--gates", "tests", "--iter", "2", "--cwd", w.repo]);
  assert.deepEqual([r.code, r.json.gates[0].state], [0, "pass"]);
  assert.equal(cli(w, ["cleanup", "--dir", w.d]).json.removed, w.d);
  assert.ok(existsSync(g), "another gate folder stays");
  r = cli(w, ["cleanup", "--dir", g]);
  assert.deepEqual([r.code, r.json.removed, existsSync(g)], [0, g, false]);
  const old = makeRunFolder({ env: w.env, platform: process.platform }, "ralph-qa").dir;
  assert.equal(cli(w, ["cleanup", "--dir", old]).json.stop, "not-a-run-folder", "an older ralph-qa.* folder goes with seat-run cleanup, which knows its answer folder");
});

// L3: each seq is claimed with a file of its own, so two runs at once in one folder never share a seq or a name.
test("two runs at once in one gate folder get two seqs and two output files", { skip: !HAS_GIT && "no git" }, async (t) => {
  const w = world(t);
  const { spawn } = await import("node:child_process");
  const one = (id) => new Promise((done) => {
    const c = spawn(NODE, [TOOL, "run", "--dir", w.d, "--id", id, "--cmd", nodeCmd("-e", "setTimeout(() => console.log('ok'), 300)"), "--timeout", "30", "--cwd", w.repo], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (b) => (out += b));
    c.on("close", (code) => done({ code, json: JSON.parse(out || "null") }));
  });
  const runs = await Promise.all([one("tests"), one("tests"), one("lint")]);
  assert.deepEqual(runs.map((x) => x.code), [0, 0, 0]);
  const seqs = evidence(w).map((x) => x.seq).sort();
  assert.deepEqual([new Set(seqs).size, new Set(runs.map((x) => x.json.output)).size], [3, 3]);
  writeFileSync(join(w.d, "gate-tests-0-5.md"), "an output left by a run cut short before its record");
  writeFileSync(join(w.d, ".seq-4.md"), "");
  const r = run(w, "tests", nodeCmd("-e", "0"));
  assert.equal(r.json.seq, 6, "past the claimed seq 4 and the output file of seq 5 left behind");
});

// Security 5: an output past 2 GiB is hashed in pieces and read for the verdict by its ends; a pass is then misleading.
test("an output too large to read whole is hashed in pieces and its verdict, read by its ends, is misleading, not a pass", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const p = join(w.dir, "big.md");
  writeFileSync(p, `head\n${"x".repeat(5000)}\nℹ fail 1\n`);
  const cut = outputText(p, 1000);
  assert.deepEqual([cut.cut, cut.size, cut.text.startsWith("head"), cut.text.endsWith("ℹ fail 1\n"), cut.text.length < 1100], [true, 5017, true, true, true]);
  assert.deepEqual([outputText(p).cut, Buffer.byteLength(outputText(p).text)], [false, 5017]);
  if (WIN) return;
  // A sparse file of 2.1 GiB: fd 1 is the output file, so the child sets its length without writing it.
  const r = run(w, "huge", nodeCmd("-e", "require('fs').ftruncateSync(1, 2254857830)"));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.json.verdict, r.json.bytes, /넘어 앞뒤만 봄/.test(r.json.why)], ["misleading", 2254857830, true]);
  assert.equal(cli(w, ["verify", "--dir", w.d]).code, 0, "verify hashes it in pieces too");
});

// Security 6, S11 R3: a tree with no git gives one fingerprint whatever changes, so no record of it could hold the
// conjunct; init and run stop at the start with a named stop instead of spending the iterations.
test("init and run on a folder with no git stop with not-a-git-tree before anything runs or is made", (t) => {
  const w = world(t);
  const plain = join(w.dir, "plain");
  mkdirSync(plain);
  const marker = join(w.dir, "ran.md");
  let r = cli(w, ["run", "--dir", w.d, "--id", "tests", "--cmd", nodeCmd("-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`), "--timeout", "30", "--iter", "1", "--cwd", plain]);
  assert.deepEqual([r.code, r.json.stop, /git init/.test(r.json.message)], [3, "not-a-git-tree", true]);
  assert.deepEqual([existsSync(marker), existsSync(join(w.d, "evidence.md"))], [false, false], "nothing ran, nothing recorded");
  const before = readdirSync(w.base).length;
  r = cli(w, ["init", "--cwd", plain]);
  assert.deepEqual([r.code, r.json.stop, readdirSync(w.base).length], [3, "not-a-git-tree", before], "no gate folder made");
});
