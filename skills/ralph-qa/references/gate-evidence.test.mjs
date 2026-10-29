// Tests for gate-evidence.mjs as a program: it runs the gate command itself, records what it saw, ends a command past
// its limit with every process it started, keeps PowerShell's exit codes, and tells observed from reported.
// Run: node --test skills/ralph-qa/references/gate-evidence.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeRunFolder } from "./run-folder.mjs";
import { shellFor } from "./gate-evidence.mjs";

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
  const d = makeRunFolder({ env, platform: process.platform }, "ralph-qa").dir;
  const repo = join(dir, "repo");
  mkdirSync(repo);
  if (HAS_GIT) {
    for (const a of [["-c", "init.defaultBranch=main", "init", "-q"], ["commit", "-q", "--allow-empty", "-m", "base"]]) spawnSync("git", ["-C", repo, ...a], { env });
  }
  return { dir, env, d, repo };
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
  assert.ok(out.includes("ok 1") && out.includes("to stderr"), "stdout and stderr both through the pipes");
  assert.match(rec.output, /gate-tests-0-1\.md$/);
  assert.ok(rec.git && /^[0-9a-f]{64}$/.test(rec.fingerprint) && /^[0-9a-f]{64}$/.test(rec.outputSha256));
  r = run(w, "tests", nodeCmd("-e", "console.log('not ok 1 - adds'); process.exit(7)"), ["--iter", "1"]);
  assert.deepEqual([r.json.exit, r.json.verdict, r.json.iter, r.json.seq], [7, "fail", 1, 2]);
  assert.match(r.json.signature, /^tests:[0-9a-f]{16}$/);
  assert.deepEqual(evidence(w).map((x) => x.seq), [1, 2]);
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
