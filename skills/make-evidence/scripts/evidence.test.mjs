import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./evidence.mjs";
import { claimLog, redact, runLogged, runMetrics, secretLines, serve, stop } from "./me-run.mjs";
import { foreignHosts, isLocalHost, precheck } from "./me-precheck.mjs";
import { bareNumbers, checkDocs, countTrace } from "./me-check.mjs";
import { addWorktree, collectRoom, judge, makeRoom, runBug } from "./me-oracle.mjs";
import { commitEvidence } from "./me-commit.mjs";

const CLI = fileURLToPath(new URL("./evidence.mjs", import.meta.url));
const NODE = process.execPath;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const ORACLE_RUN = [
  "import { pick, total, allowed } from '../../impl.mjs';",
  "let xs; try { xs = pick(); } catch (e) { for (const k of ['constraint','objective','permission']) console.log(`ORACLE ${k} ERROR c1 ${e.message}`); process.exit(2); }",
  "const sum = xs[0] + xs[1];",
  "console.log(`ORACLE constraint ${sum <= 10 ? 'PASS' : 'FAIL'} c1 sum=${sum}`);",
  "console.log(`ORACLE objective ${total(xs) === sum ? 'PASS' : 'FAIL'} c1`);",
  "console.log(`ORACLE permission ${allowed('viewer') ? 'FAIL' : 'PASS'} c1`);",
  "",
].join("\n");

// A repository with one implementation file and an oracle that judges it by running it.
function makeRepo() {
  const dir = tmp("me-test-");
  sh(dir, "init", "-q");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "user.email", "t@example.invalid");
  sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# svc\n\n## 요구\n1. 합은 10 이하\n");
  writeFileSync(join(dir, "impl.mjs"), "export const pick = () => [3, 4];\nexport const total = (xs) => xs.reduce((a, b) => a + b, 0);\nexport const allowed = (role) => role === 'planner';\n");
  mkdirSync(join(dir, "tests", "oracle"), { recursive: true });
  writeFileSync(join(dir, "tests", "oracle", "run.mjs"), ORACLE_RUN);
  mkdirSync(join(dir, "docs", "evidence"), { recursive: true });
  writeFileSync(join(dir, "docs", "evidence", "owner-facts.md"), "- 합은 10 이하\n");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const worktrees = (repo) => sh(repo, "worktree", "list").trim().split("\n").length;

// ---- run, serve, stop -----------------------------------------------------------------------------------------

test("run records the command, both streams and the exit code, returns that code and adds run metrics", async () => {
  const dir = tmp("me-run-");
  const r = await runLogged({ log: join(dir, "a-{ts}.log"), argv: [NODE, "-e", "console.log('out'); console.error('err'); process.exit(3)"], cwd: dir });
  assert.equal(r.code, 3);
  const text = readFileSync(r.file, "utf8");
  assert.match(text.split("\n")[0], /^\$ .*node.* -e 'console\.log\(/);
  assert.match(text, /^# head=none dirty=\? at=/m);
  assert.match(text, /^out$/m);
  assert.match(text, /^err$/m);
  assert.match(text, /# redacted=0\nexit=3\nMETRIC run\.exit=3\n$/);
  assert.doesNotMatch(r.file, /\{ts\}/);
});

test("run closes stdin, so a command that reads it ends", async () => {
  const dir = tmp("me-run-");
  const r = await runLogged({ log: join(dir, "in.log"), argv: [NODE, "-e", "process.stdin.on('data',()=>{}).on('end',()=>{console.log('eof')})"], cwd: dir, timeoutS: 20 });
  assert.equal(r.code, 0);
  assert.match(readFileSync(r.file, "utf8"), /^eof$/m);
});

test("run ends the process tree at the time limit and returns 124", async () => {
  const dir = tmp("me-run-");
  const t0 = Date.now();
  const r = await runLogged({ log: join(dir, "t.log"), argv: [NODE, "-e", "setInterval(()=>{},1000)"], cwd: dir, timeoutS: 1 });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t0 < 15000);
  assert.match(readFileSync(r.file, "utf8"), /exit=timeout\(1s\)\n/);
});

test("run does not wait for a detached descendant that keeps the output open", async () => {
  const dir = tmp("me-run-");
  const code = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:['ignore','inherit','inherit']});console.log('kid',c.pid);c.unref()";
  const t0 = Date.now();
  const r = await runLogged({ log: join(dir, "o.log"), argv: [NODE, "-e", code], cwd: dir, timeoutS: 60 });
  const text = readFileSync(r.file, "utf8");
  assert.ok(Date.now() - t0 < 20000, "ends soon after the command exits");
  assert.equal(r.code, 0);
  assert.match(text, /# orphan-output=yes\n/);
  const kid = Number((text.match(/^kid (\d+)$/m) || [])[1]);
  try { process.kill(kid, "SIGKILL"); } catch { /* gone */ }
});

test("run masks secrets in the command line and the output, and never overwrites a log", async () => {
  const dir = tmp("me-run-");
  const log = join(dir, "s.log");
  const r = await runLogged({ log, argv: [NODE, "-e", "console.log('Authorization: Bearer abc.def'); console.log('url postgres://u:hunter2@db/x'); console.log('DB_PASSWORD=hunter2')", "--", "--password", "hunter2"], cwd: dir });
  const text = readFileSync(r.file, "utf8");
  assert.doesNotMatch(text, /hunter2|abc\.def/);
  assert.match(text, /# redacted=3\n/);
  await assert.rejects(runLogged({ log, argv: [NODE, "-e", "1"], cwd: dir }), /이미 있음/);
});

test("run --shell runs one command line in the platform shell", async () => {
  const dir = tmp("me-run-");
  const r = await runLogged({ log: join(dir, "sh.log"), argv: ["echo", "hi"], cwd: dir, shell: true });
  assert.equal(r.code, 0);
  assert.match(readFileSync(r.file, "utf8"), /^hi\s*$/m);
});

test("redact covers the common .env and command line forms, and leaves metric lines alone", () => {
  for (const s of ["DB_PASSWORD=hunter2", "POSTGRES_PASSWORD: hunter2", "MYSQL_ROOT_PASSWORD=pw1234", "PGPASSWORD=hunter2 psql", "SECRET_KEY=django-insecure-abc",
    "JWT_SECRET=xyz123", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "mysql -u root -phunter2 db", "--token hunter2", ("-----BEGIN RSA " + "PRIVATE KEY-----\nMIIabc\n-----END RSA " + "PRIVATE KEY-----")]) {
    const r = redact(s);
    assert.ok(r.n >= 1 && !/hunter2|pw1234|django-insecure|xyz123|wJalr|MIIabc/.test(r.text), `${s} -> ${r.text}`);
    assert.equal(redact(r.text).n, 0, "a masked text counts nothing again");
  }
  assert.deepEqual(redact("METRIC scale.x5.median_s=1.25\n"), { text: "METRIC scale.x5.median_s=1.25\n", n: 0 });
  assert.deepEqual(secretLines("a\nAPI_KEY=abcdef123\nb\n"), [2]);
});

test("runMetrics picks up node, pytest and jest counts", () => {
  assert.deepEqual(runMetrics("ℹ tests 5\nℹ pass 4\nℹ fail 1\n", "1"), ["run.exit=1", "run.tests.tests=5", "run.tests.pass=4", "run.tests.fail=1"]);
  assert.deepEqual(runMetrics("===== 3 passed, 1 failed in 0.12s =====", "1"), ["run.exit=1", "run.tests.passed=3", "run.tests.failed=1"]);
  assert.deepEqual(runMetrics("Tests:       1 failed, 4 passed, 5 total", "1"), ["run.exit=1", "run.tests.failed=1", "run.tests.passed=4", "run.tests.total=5"]);
});

test("serve refuses a URL that already answers, notices an exit, and stop marks a server that died first", async () => {
  const dir = tmp("me-serve-");
  const port = 40000 + (process.pid % 20000);
  const url = `http://127.0.0.1:${port}/`;
  const exits = await serve({ log: join(dir, "x.log"), pidFile: join(dir, "x.pid"), ready: url, waitS: 20, argv: [NODE, "-e", "process.exit(4)"], cwd: dir });
  assert.equal(exits.ready, false);
  assert.match(exits.why, /exited 4/);
  const code = `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>console.log('listening'))`;
  const pidFile = join(dir, "srv.pid");
  const r = await serve({ log: join(dir, "srv.log"), pidFile, ready: url, waitS: 20, argv: [NODE, "-e", code], cwd: dir });
  assert.equal(r.ready, true);
  await assert.rejects(serve({ log: join(dir, "dup.log"), pidFile: join(dir, "dup.pid"), ready: url, argv: [NODE, "-e", code], cwd: dir }), /이미 답하는 서버/);
  stop({ pidFile });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => "up", () => "down"), "down");
  assert.match(readFileSync(r.file, "utf8"), /listening\n# redacted=0\nexit=stopped\n$/);
  const dies = await serve({ log: join(dir, "d.log"), pidFile: join(dir, "d.pid"), ready: url, waitS: 20, argv: [NODE, "-e", `${code};setTimeout(()=>process.exit(0),1500)`], cwd: dir });
  assert.equal(dies.ready, true);
  await new Promise((res) => setTimeout(res, 2500));
  stop({ pidFile: join(dir, "d.pid") });
  assert.match(readFileSync(dies.file, "utf8"), /exit=gone-before-stop\n$/);
});

// ---- check and count ------------------------------------------------------------------------------------------

function runLog(metrics) {
  return `$ node measure.mjs\n# head=abc dirty=0 at=x node=v24 os=linux cwd=/x\n${metrics.map((m) => `METRIC ${m}`).join("\n")}\n# redacted=0\nexit=0\n`;
}

test("check finds the exact metric line in a run log the line names", () => {
  const repo = makeRepo();
  const ev = join(repo, "docs", "evidence");
  mkdirSync(join(ev, "logs"), { recursive: true });
  writeFileSync(join(ev, "logs", "scale.log"), runLog(["scale.x1.median_s=12.5", "gap.c1.pct=0"]));
  writeFileSync(join(ev, "logs", "hand.log"), "METRIC a.b=1\n");
  writeFileSync(join(ev, "logs", "echo.log"), "$ echo METRIC a.b=1\n# head=x\nMETRIC a.b=1\nexit=0\n");
  writeFileSync(join(ev, "scale.md"), [
    "| 1배 | `scale.x1.median_s=12.5` | logs/scale.log |",
    "| 사례 c1 | `gap.c1.pct=0` | docs/evidence/logs/scale.log |",
    "| 덫 | `scale.x1.median_s=2.5` | logs/scale.log |",
    "| 경로 없음 | `gap.c1.pct=0` |",
    "| 없는 로그 | `a.b=1` | logs/none.log |",
    "| 손 로그 | `a.b=1` | logs/hand.log |",
    "| echo 로그 | `a.b=1` | logs/echo.log |",
    "10배에서도 0.4초 안에 끝남",
    "명령: `node evidence.mjs run --log 'docs/evidence/logs/scale-{ts}.log'`, 끝 줄 `exit=0`, 코드 `app/logs/export.py:30`",
    "```",
    "for i in 1..10: x += 3",
    "```",
    "수치 대조: logs/scale.log",
    "",
  ].join("\n"));
  writeFileSync(join(ev, "logs", "const.log"), "$ node -e console.log('METRIC a.b=1')\n# head=x\nMETRIC a.b=1\nexit=0\n");
  writeFileSync(join(ev, "flow.md"), "| 상수 | `a.b=1` | logs/const.log |\n수치 대조: docs/evidence/logs/check-{ts}.log\n");
  writeFileSync(join(ev, "owner-facts.md"), "- 최대 `max.hours=40` 시간\n");
  writeFileSync(join(ev, "logs", "verify-bug-objective-20261105-082739-147Z.patch"), "diff --git a/x b/x\n");
  writeFileSync(join(ev, "logs", "verify-oracle-prompt-20261105-082700.md"), "prompt\n");
  writeFileSync(join(ev, "verify.md"), "- 지시문: docs/evidence/logs/verify-oracle-prompt-20261105-082700.md\n| objective | `logs/verify-bug-objective-20261105-082739-147Z.patch` | `bug.objective.result=caught` | logs/scale.log logs/verify-bug-objective-20261105-082739-147Z.patch |\n");
  const c = checkDocs(repo);
  assert.equal(c.tokens, 9);
  assert.ok(c.errors.some((e) => e.includes("verify.md:2") && e.includes("bug.objective.result=caught")), "a value is still looked up in the .log the line names");
  assert.ok(!c.errors.some((e) => e.includes(".patch") || e.includes("prompt")), "a patch and a saved prompt only have to exist");
  const at = (n, s) => c.errors.some((e) => e.includes(`scale.md:${n}`) && e.includes(s));
  assert.ok(at(3, "median_s=2.5"), "a substring of a logged value is not that value");
  assert.ok(at(4, "로그 경로가 없음"));
  assert.ok(at(5, "로그가 없음"));
  assert.ok(at(6, "run 이 만든 로그가 아님"));
  assert.ok(at(7, "글을 찍기만 하는 명령"));
  assert.ok(c.errors.some((e) => e.includes("flow.md:1") && e.includes("상수를 찍는 명령")), "a log whose command prints the METRIC text itself is refused");
  assert.ok(c.errors.some((e) => e.includes("flow.md:2") && e.includes("이름 꼴")), "the check line must name a real log");
  assert.equal(c.errors.length, 13, c.errors.join("\n")); // a bad log also has no usable metric line
  assert.deepEqual(c.warnings.map((w) => w.split(" ")[0]), ["docs/evidence/scale.md:8"], c.warnings.join("\n")); // paths with digits are not numbers
  const t = checkDocs(repo, { tracked: true });
  assert.ok(t.errors.some((e) => e.includes("git 에 없음")), "an untracked log is reported with --tracked");
});

test("bareNumbers keeps ids, multiples, paths and quotes out", () => {
  for (const s of ["| R1 | x1 | x10 | c3 |", "`a.b=3` 와 코드", "src/opt.mjs:12, opt.py:30-40, 2026-11-05, v1.2.3, 3812a76", "### 5. verify", "1. 첫 단계", "| 3 | 요구 |", "의사코드 10줄",
    "5배 데이터를 만듦", "경로 ./data/x2.json 과 /tmp/a1 과 https://h/x9", "tests/oracle/case3.mjs"]) assert.equal(bareNumbers(s), false, s);
  for (const s of ["3 회 돌림", "0.4초", "28 통과", "## 결과: 10배 데이터에서 중앙값 0.9초", "10배 데이터에서 시간은 12배로 늘었다", "처리량 1200req/s", "지연:120ms", "총 1234567건을 처리함", "\"0.4초\" 안에 끝남",
    "지연 p50/p95=120/340ms", "latency(p50)/p95=120/340ms", "응답 시간 median/max=0.4/0.9s", "rate/s=1200", "10배 데이터에서 시간도 10배로 늘었다(선형)", "5배 데이터에서 시간은 약 5배",
    "## 12 배 빨라짐", "초당 1200줄을 처리함", "| 1200 | 값 |", "x12 로 늘었다",
    "| 10배 | `a.b=1` logs/x.log | 10배 |", "| 5배 | 값 | 약 5배 |", "시간이 10배 | 선형"]) assert.equal(bareNumbers(s), true, s);
  for (const s of ["| 10배 | 값 |", "| 10배 데이터 | 값 |"]) assert.equal(bareNumbers(s), false, s);
  assert.equal(bareNumbers("| R1 | \"200개 이하\" | 완료 |", { quotes: true }), false, "a quoted requirement in trace.md");
});

function writeDoc(text) {
  const f = join(tmp("me-doc-"), "trace.md");
  writeFileSync(f, text);
  return f;
}

test("count reads the 상태 column by its heading and lists rows it cannot read", () => {
  const c = countTrace([
    "| 번호 | 요구 | 출처 | 상태 | 시험 이름 | 로그 경로 |",
    "|---|---|---|---|---|---|",
    "| R1 | \"화면 \\| 목록\" | README.md:3 | 완료 | t1 | logs/a.log |",
    "| R2 | API | README.md:4 | 부분(권한 404) | t2 | logs/b.log |",
    "| R3 | 여러 배낭 | README.md:5 | 미구현(범위 밖) | 없음 | - |",
    "| R4 | 화면 조작 | README.md:6 | 미검증(브라우저 없음) | 없음 | - |",
    "| R5 | ? | README.md:7 | 끝남 | x | - |",
  ].join("\n"));
  assert.deepEqual(c, { rows: 5, done: 1, partial: 1, notdone: 1, unverified: 1, unknown: 1, unknownRows: [7] });
  assert.throws(() => countTrace("| R1 | a | 완료 |\n"), /상태/);
  const cli = spawnSync(NODE, [CLI, "count", "--doc", writeDoc("| 번호 | 상태 |\n|---|---|\n| R1 | ? |\n")], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /ERROR 상태를 알 수 없는 행/);
});

// ---- room -----------------------------------------------------------------------------------------------------

test("room holds only the inputs, its note is outside it, and collect refuses extra or changed files", () => {
  const repo = makeRepo();
  rmSync(join(repo, "tests", "oracle"), { recursive: true });
  sh(repo, "commit", "-qam", "drop oracle");
  const { dir } = makeRoom(repo);
  assert.deepEqual(readdirSync(dir).sort(), ["README.md", "docs", "tests"], "the room holds no note naming the repository");
  assert.equal(realpathSync(JSON.parse(readFileSync(join(dir, "..", "room.json"), "utf8")).repo), realpathSync(repo));
  writeFileSync(join(dir, "tests", "oracle", "o.mjs"), "// oracle\n");
  writeFileSync(join(dir, "notes.txt"), "x");
  assert.ok(collectRoom(dir, repo).problems.some((p) => p.includes("notes.txt")));
  rmSync(join(dir, "notes.txt"));
  writeFileSync(join(dir, "README.md"), "changed");
  assert.ok(collectRoom(dir, repo).problems.some((p) => p.includes("입력 파일이 바뀜")));
  writeFileSync(join(dir, "README.md"), readFileSync(join(repo, "README.md")));
  assert.deepEqual(collectRoom(dir, repo).problems, []);
  assert.equal(readFileSync(join(repo, "tests", "oracle", "o.mjs"), "utf8"), "// oracle\n");
  assert.ok(collectRoom(dir, repo).problems.some((p) => p.includes("이미 있음")), "an existing oracle is not replaced without --replace");
  sh(repo, "add", "tests");
  sh(repo, "commit", "-qm", "oracle");
  const again = collectRoom(dir, repo, { replace: true });
  assert.deepEqual(again.problems, []);
  assert.match(again.previous, /oracle$/, "the commit of the oracle it replaces is reported");
});

// ---- judge and bug --------------------------------------------------------------------------------------------

test("judge: only a new FAIL of the bug's kind over the same cases, with no ERROR, is caught", () => {
  const base = "ORACLE constraint PASS c1\nORACLE objective PASS c1\nORACLE permission FAIL old\nORACLE permission PASS c1\n";
  const run = (o) => `ORACLE constraint ${o.c ?? "PASS"} c1 x=1\nORACLE objective ${o.o ?? "PASS"} c1\nORACLE permission FAIL old\nORACLE permission ${o.p ?? "PASS"} c1\n`;
  assert.deepEqual(judge(run({ c: "FAIL" }), "constraint", base, false), { result: "caught", reason: "new-fail", collateral: 0 });
  assert.equal(judge(run({}), "constraint", base, false).result, "missed");
  assert.equal(judge(run({}), "permission", base, false).result, "missed", "a FAIL the baseline already had is not a catch");
  assert.equal(judge(run({ c: "FAIL", o: "FAIL" }), "constraint", base, false).collateral, 1);
  assert.equal(judge(run({ o: "ERROR" }), "objective", base, false).reason, "oracle-error");
  assert.equal(judge("ORACLE constraint FAIL c1\n", "constraint", base, false).reason, "cases-differ", "a run that judged fewer cases says nothing");
  assert.equal(judge(run({ c: "FAIL" }), "constraint", base, true).reason, "timeout");
  assert.equal(judge(run({ c: "FAIL" }), "constraint", "ORACLE constraint FAIL c1\n", false).reason, "baseline-no-pass");
});

async function bugCycle(repo, name, kind, edit, baseline, links = []) {
  const wt = addWorktree(repo, links);
  if (edit) writeFileSync(join(wt, "impl.mjs"), edit(readFileSync(join(wt, "impl.mjs"), "utf8")));
  return runBug({ wt, name, kind, baseline, argv: [NODE, "tests/oracle/run.mjs"], timeoutS: 60 });
}

test("bug runs in a separate worktree, leaves the user's changes alone and judges by the oracle lines", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "impl.mjs"), `${readFileSync(join(repo, "impl.mjs"), "utf8")}// user's unfinished work\n`);
  const base = await bugCycle(repo, "baseline", undefined, null);
  assert.ok(base.metrics.includes("baseline.constraint.pass=1"), base.metrics.join(" "));
  const cases = [
    ["constraint", "constraint", (s) => s.replace("[3, 4]", "[6, 7]"), "caught"],
    ["objective", "objective", (s) => s.replace("a + b, 0", "a + b, 1"), "caught"],
    ["permission", "permission", (s) => s.replace("role === 'planner'", "true"), "caught"],
    ["harmless", "constraint", (s) => s.replace("[3, 4]", "[4, 3]"), "missed"],
    ["crash", "objective", (s) => s.replace("export const pick = () => [3, 4];", "export const pick = () => { throw new Error('x'); };"), "undecidable"],
    ["broken", "objective", (s) => s.replace("export const total", "export const total = ("), "undecidable"],
  ];
  for (const [name, kind, edit, want] of cases) {
    const r = await bugCycle(repo, name, kind, edit, base.log);
    assert.ok(r.metrics.includes(`bug.${name}.result=${want}`), `${name}: ${r.metrics.join(" ")}`);
    assert.ok(r.metrics.includes(`bug.${name}.tree_unchanged=yes`));
    assert.match(readFileSync(r.patch, "utf8"), /^diff --git a\/impl\.mjs/m);
    assert.match(readFileSync(r.log, "utf8"), new RegExp(`METRIC bug\\.${name}\\.result=${want}\\n`));
  }
  assert.match(readFileSync(join(repo, "impl.mjs"), "utf8"), /user's unfinished work/);
  assert.equal(worktrees(repo), 1, "every worktree is removed");
});

test("bug refuses a stale baseline, a baseline with changes and a bug with none, and removes the worktree", async () => {
  const repo = makeRepo();
  const wt = addWorktree(repo);
  writeFileSync(join(wt, "impl.mjs"), "export const pick = () => [1];\n");
  await assert.rejects(runBug({ wt, name: "baseline", argv: [NODE, "-e", "1"] }), /기준선인데/);
  assert.equal(existsSync(wt), false, "a refused bug leaves no worktree");
  const base = await bugCycle(repo, "baseline", undefined, null);
  await assert.rejects(runBug({ wt: addWorktree(repo), name: "x", kind: "objective", baseline: base.log, argv: [NODE, "-e", "1"] }), /넣은 버그가 없음/);
  await assert.rejects(runBug({ wt: "/nowhere", name: "x", kind: "speed", baseline: base.log, argv: [NODE, "-e", "1"] }), /--kind/);
  writeFileSync(join(repo, "tests", "oracle", "run.mjs"), `${ORACLE_RUN}// changed\n`);
  await assert.rejects(bugCycle(repo, "x", "objective", (s) => s.replace("a + b, 0", "a + b, 1"), base.log), /판정기가 지금 판정기와 다름/);
  writeFileSync(join(repo, "tests", "oracle", "run.mjs"), ORACLE_RUN);
  sh(repo, "commit", "-qm", "next", "--allow-empty");
  await assert.rejects(bugCycle(repo, "x", "objective", (s) => s.replace("a + b, 0", "a + b, 1"), base.log), /HEAD/);
  assert.equal(worktrees(repo), 1);
});

test("worktree links a dependency folder, refuses build output, and a link back into the tree makes the bug undecidable", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "deps"));
  writeFileSync(join(repo, "deps", "lib.mjs"), "export const v = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "*.log\ndeps/\ndist/\n");
  sh(repo, "commit", "-qam", "ignore deps");
  mkdirSync(join(repo, "dist"));
  assert.throws(() => addWorktree(repo, ["dist"]), /빌드 결과/);
  assert.throws(() => addWorktree(repo, ["impl.mjs"]), /추적되지 않는 폴더만/);
  assert.throws(() => addWorktree(repo, [".."]), /저장소 안의 경로만/);
  const base = await bugCycle(repo, "baseline", undefined, null, undefined, ["deps"]);
  assert.equal(readFileSync(join(repo, "deps", "lib.mjs"), "utf8"), "export const v = 1;\n", "the linked folder survives the worktree removal");
  symlinkSync(join(repo, "impl.mjs"), join(repo, "deps", "impl-link.mjs"));
  const r = await bugCycle(repo, "linked", "constraint", (s) => s.replace("[3, 4]", "[6, 7]"), base.log, ["deps"]);
  assert.ok(r.metrics.includes("bug.linked.result=undecidable") && r.metrics.includes("bug.linked.reason=link-to-main"), r.metrics.join(" "));
  assert.deepEqual(r.toRepo, ["deps/impl-link.mjs"]);
  assert.equal(worktrees(repo), 1);
});

test("a linked folder written during the run is reported, and worktree --remove takes a worktree away", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "cache"));
  writeFileSync(join(repo, ".gitignore"), "*.log\ncache/\n");
  writeFileSync(join(repo, "tests", "oracle", "write.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('cache/x', 'y');\nconsole.log('ORACLE constraint PASS c1');\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "cache");
  const wt = addWorktree(repo, ["cache"]);
  const r = await runBug({ wt, name: "baseline", argv: [NODE, "tests/oracle/write.mjs"], timeoutS: 60 });
  assert.ok(r.metrics.includes("bug.baseline.links_unchanged=no"), r.metrics.join(" "));
  assert.equal(r.unchanged, false);
  const wt2 = addWorktree(repo);
  const rm = spawnSync(NODE, [CLI, "worktree", "--remove", wt2], { encoding: "utf8" });
  assert.equal(rm.status, 0, rm.stderr);
  assert.equal(existsSync(wt2), false);
  assert.equal(worktrees(repo), 1);
});

test("bug from a linked worktree of the user's writes its logs there", async () => {
  const main = makeRepo();
  const linked = join(tmp("me-linked-"), "w");
  sh(main, "worktree", "add", "-q", "--detach", linked);
  const r = await bugCycle(linked, "baseline", undefined, null);
  assert.ok(realpathSync(r.log).startsWith(join(realpathSync(linked), "docs", "evidence", "logs")), r.log); // macOS /var is /private/var
});

// ---- commit and precheck --------------------------------------------------------------------------------------

test("commit takes only the evidence paths, forces in ignored logs only, and refuses secrets and other staged changes", () => {
  const repo = makeRepo();
  const ev = join(repo, "docs", "evidence");
  mkdirSync(join(ev, "logs"), { recursive: true });
  mkdirSync(join(ev, "scripts"), { recursive: true });
  writeFileSync(join(ev, "logs", "a.log"), runLog(["x.y=1"]));
  writeFileSync(join(ev, "trace.md"), "| R1 | `x.y=1` | logs/a.log |\n");
  writeFileSync(join(repo, "other.txt"), "user\n");
  sh(repo, "add", "other.txt");
  assert.match(commitEvidence(repo, "docs(evidence): t").refused[0], /other\.txt/);
  sh(repo, "reset", "-q", "other.txt");
  writeFileSync(join(ev, "scripts", "cfg.txt"), "API_KEY=abcdef123\n");
  const refused = commitEvidence(repo, "docs(evidence): t").refused;
  assert.ok(refused.some((x) => x.includes("docs/evidence/scripts/cfg.txt:1")), refused.join("\n"));
  writeFileSync(join(ev, "scripts", "cfg.txt"), "API_KEY=***\n");
  writeFileSync(join(ev, "scripts", "debug.log"), "ignored and not a run log\n");
  writeFileSync(join(repo, "impl.mjs"), "changed\n");
  const r = commitEvidence(repo, "docs(evidence): t");
  assert.equal(r.refused, undefined, String(r.refused));
  assert.deepEqual(r.files.sort(), ["docs/evidence/logs/a.log", "docs/evidence/scripts/cfg.txt", "docs/evidence/trace.md"]);
  assert.match(sh(repo, "status", "--porcelain", "--ignored"), /!! docs\/evidence\/scripts\/debug\.log/);
  assert.match(sh(repo, "status", "--porcelain"), / M impl\.mjs/);
  assert.deepEqual(checkDocs(repo, { tracked: true }).errors, []);
});

test("precheck reports staged and changed files and hosts that are not this machine, in files and the environment", () => {
  const repo = makeRepo();
  assert.equal(precheck(repo, {}).decide, false);
  mkdirSync(join(repo, "apps", "api", "config"), { recursive: true });
  writeFileSync(join(repo, "apps", "api", ".env"), "DATABASE_URL=postgres://u:p@prod-db.corp.example.net:5432/app\nREDIS_HOST=localhost\nAPI=http://127.0.0.1:8000\n");
  writeFileSync(join(repo, "apps", "api", "config", "database.yml"), "production:\n  host: db.internal.corp\n");
  writeFileSync(join(repo, "compose.yaml"), "services:\n  db:\n    image: postgres\n");
  writeFileSync(join(repo, "shared.env.real"), "DB_HOST=proddb\n");
  symlinkSync(join(repo, "shared.env.real"), join(repo, ".env"));
  writeFileSync(join(repo, "impl.mjs"), "x\n");
  writeFileSync(join(repo, "staged.txt"), "x\n");
  sh(repo, "add", "staged.txt");
  writeFileSync(join(repo, "db.mjs"), "export const url = process.env.DATABASE_URL;\n");
  mkdirSync(join(repo, "docs", "evidence", "logs"), { recursive: true });
  writeFileSync(join(repo, "docs", "evidence", "logs", "precheck-old.log"), "NOTE host env OTHER_TOOL_URL elsewhere.example.org\n");
  sh(repo, "add", "-f", "db.mjs", "docs/evidence/logs/precheck-old.log");
  const env = { DATABASE_URL: "postgres://u:p@from-env.corp.example.net/x", HOSTNAME: "mybox", OTHER_TOOL_URL: "https://elsewhere.example.org/x",
    PGHOST: "pg-prod.corp", SPRING_DATASOURCE_URL: "jdbc:postgresql://spring-prod.corp:5432/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
    SPRING_KAFKA_BOOTSTRAP_SERVERS: "kafka-prod.corp:9092,kafka2-prod.corp:9092", ConnectionStrings__Default: "Server=prod-sql.corp;Database=x", PGPASSWORD: "myserver:hunter2" };
  const r = precheck(repo, env);
  assert.equal(r.decide, true);
  assert.ok(r.out.includes("STOP staged staged.txt"));
  assert.ok(r.out.some((l) => l.startsWith("ASK dirty") && l.includes("impl.mjs")));
  const hosts = foreignHosts(repo, env).map((h) => `${h.where} ${h.host}`).sort();
  assert.deepEqual(hosts, [".env:1 proddb", "apps/api/.env:1 prod-db.corp.example.net", "apps/api/config/database.yml:2 db.internal.corp",
    "env ConnectionStrings__Default prod-sql.corp", "env DATABASE_URL from-env.corp.example.net", "env OTHER_TOOL_URL elsewhere.example.org", "env PGHOST pg-prod.corp", "env SPRING_DATASOURCE_URL spring-prod.corp",
    "env SPRING_KAFKA_BOOTSTRAP_SERVERS kafka-prod.corp", "env SPRING_KAFKA_BOOTSTRAP_SERVERS kafka2-prod.corp"]);
  assert.ok(r.out.every((l) => !l.includes("hunter2")), "a password variable is never read for a host");
  assert.ok(r.out.includes("ASK host env PGHOST (이 컴퓨터 밖 주소)") && r.out.some((l) => l.startsWith("ASK host env SPRING_DATASOURCE_URL ")), "variables database libraries read on their own are asked about");
  assert.ok(r.out.some((l) => l.startsWith("NOTE host env OTHER_TOOL_URL")), "another tool's variable the project does not name is only noted");
  assert.ok(r.out.every((l) => !/pg-prod|elsewhere\.example|from-env/.test(l)), "an environment variable's host is not printed into the log");
  assert.ok(r.out.every((l) => !l.includes(":p@")), "no value from the config is shown");
});

test("inside treats another Windows drive as outside", async () => {
  const { inside } = await import("./me-oracle.mjs");
  const path = await import("node:path");
  const r = path.win32.relative("D:\\work\\repo", "C:\\Temp\\make-evidence-room-x\\room");
  assert.equal(path.win32.isAbsolute(r), true, "the case the check guards against");
  assert.equal(inside("/a/repo", "/a/repo/x"), true);
  assert.equal(inside("/a/repo", "/a/repo"), false);
  assert.equal(inside("/a/repo", "/tmp/room"), false);
});

test("isLocalHost keeps this machine and compose services, nothing else", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]) assert.equal(isLocalHost(h), true, h);
  assert.equal(isLocalHost("db", new Set(["db"])), true);
  for (const h of ["db", "proddb", "10.0.0.5", "192.168.1.2", "db.internal.corp"]) assert.equal(isLocalHost(h), false, h);
});

// ---- command line ---------------------------------------------------------------------------------------------

test("parseArgs, claimLog and the command line", () => {
  assert.deepEqual(parseArgs(["--log", "a", "--shell", "--req", "x", "--req", "y", "--", "echo", "--log"]), { _: [], rest: ["echo", "--log"], multi: { req: ["x", "y"] }, log: "a", shell: true });
  assert.throws(() => parseArgs(["--log"]), /값이 없음/);
  assert.match(claimLog(join(tmp("me-"), "x-{ts}.log")), /x-\d{8}-\d{6}-\d{3}Z\.log$/);
  assert.match(claimLog(join(tmp("me-"), "x-@TS@.log")), /x-\d{8}-\d{6}-\d{3}Z\.log$/);
  const help = spawnSync(NODE, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout.split("\n")[0], /^make-evidence: /);
  assert.equal(spawnSync(NODE, [CLI, "nope"], { encoding: "utf8" }).status, 2);
  const noLog = spawnSync(NODE, [CLI, "run", "--", NODE, "-e", "1"], { encoding: "utf8" });
  assert.equal(noLog.status, 2);
  assert.match(noLog.stderr, /--log 가 필요함/);
});
