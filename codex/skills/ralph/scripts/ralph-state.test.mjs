// Tests for ralph-state.mjs as a program: a run ends only on gates that passed on the tree as it is now, a fresh
// reviewer's APPROVE of that same tree and this iteration's slop pass; any change after them, a REJECT, another repo
// or a spent limit keeps it from ending.
// Run: node --test codex/skills/ralph/scripts/ralph-state.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkRun, parseArgs } from "./ralph-state.mjs";

const TOOL = fileURLToPath(new URL("./ralph-state.mjs", import.meta.url));
const GATE = fileURLToPath(new URL("./gate-evidence.mjs", import.meta.url));
const WIN = process.platform === "win32";
const NODE = process.execPath;
const q = (s) => (WIN ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`);
const nodeCmd = (...args) => `${WIN ? "& " : ""}${[NODE, ...args].map(q).join(" ")}`;
const PASS = nodeCmd("-e", "process.exit(0)");
const FAIL = nodeCmd("-e", "console.log('broken'); process.exit(1)");

function world(t, { commit = true } = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "br-rs-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const base = WIN ? join(home, "AppData", "Local", "Temp") : join(dir, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...(WIN ? { TEMP: base, TMP: base } : process.platform === "darwin" ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }),
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  for (const a of [["-c", "init.defaultBranch=main", "init", "-q"], ["add", "a.txt"], ...(commit ? [["commit", "-q", "-m", "base"]] : [])]) spawnSync("git", ["-C", repo, ...a], { env });
  const w = { dir, env, repo, base };
  w.g = gate(w, ["init", "--cwd", repo]).json?.dir;
  return w;
}

function call(w, tool, args) {
  const r = spawnSync(NODE, [tool, ...args], { encoding: "utf8", env: w.env, timeout: 120000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const rs = (w, args) => call(w, TOOL, args);
const gate = (w, args) => call(w, GATE, args);
const runGate = (w, id, cmd, iter) => gate(w, ["run", "--dir", w.g, "--id", id, "--cmd", cmd, "--timeout", "30", "--iter", String(iter), "--cwd", w.repo]);
const start = (w, extra = ["--gates", "tests"]) => rs(w, ["start", "--dir", w.g, "--cwd", w.repo, "--task", "fix a", ...extra]);
const approve = (w, by = "reviewer-1") => rs(w, ["verdict", "--dir", w.g, "--cwd", w.repo, "--by", by, "--verdict", "APPROVE", "--note", "ok"]);
const deslop = (w) => rs(w, ["deslop", "--dir", w.g, "--cwd", w.repo, "--note", "a.txt 점검, 바꾼 것 없음"]);
const check = (w) => rs(w, ["check", "--dir", w.g, "--cwd", w.repo]);

// One iteration that may end: change, gate pass, slop pass, reviewer APPROVE.
function greenIteration(w) {
  writeFileSync(join(w.repo, "a.txt"), "two\n");
  assert.equal(rs(w, ["next", "--dir", w.g]).json.iter, 1);
  assert.equal(runGate(w, "tests", PASS, 1).json.verdict, "pass");
  assert.equal(deslop(w).code, 0);
  assert.equal(approve(w).code, 0);
}

test("arguments: unknown flags, values on a boolean and missing required flags are usage errors", () => {
  assert.throws(() => parseArgs(["start", "--dir", "x", "--cwd", "y"]), /--task/);
  assert.throws(() => parseArgs(["start", "--dir", "x", "--cwd", "y", "--task", "t", "--no-deslop=yes"]), /값을 받지 않는다/);
  assert.throws(() => parseArgs(["next", "--dir", "x", "--force"]), /모르는 인자/);
  assert.throws(() => parseArgs(["launch"]), /모르는 명령/);
  assert.deepEqual(parseArgs(["start", "--dir", "x", "--cwd", "y", "--task", "t", "--no-deslop"]).o["no-deslop"], true);
});

test("checkRun: an iteration with no gate record, no APPROVE and no slop pass names all three", () => {
  const s = { status: "active", iter: 1, gates: ["tests"], noGates: null, deslop: true, verdicts: [], deslops: [] };
  const r = checkRun(s, [], "fp");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["게이트 tests: missing", "지금 작업 트리에 대한 검토자 APPROVE 없음", "지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음"]);
});

test("start: needs gates or a reason for none, refuses a second start, and records a baseline only on a clean tree", (t) => {
  const w = world(t);
  assert.ok(w.g, "gate folder");
  assert.equal(rs(w, ["start", "--dir", w.g, "--cwd", w.repo, "--task", "x"]).code, 2);
  const s = start(w);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.baseline, "run");
  assert.equal(start(w).json.stop, "started");
  const w2 = world(t);
  writeFileSync(join(w2.repo, "a.txt"), "dirty\n");
  assert.equal(start(w2).json.baseline, "none-dirty");
});

test("a full green iteration ends the run once, with its line", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  assert.equal(check(w).code, 0, JSON.stringify(check(w).json));
  const d = rs(w, ["done", "--dir", w.g, "--cwd", w.repo]);
  assert.equal(d.code, 0, d.stdout);
  assert.match(d.json.line, /^RALPH COMPLETE iter=1 gates=tests approvals=1 deslop=done$/);
  assert.equal(JSON.parse(readFileSync(join(w.g, "ralph.md"), "utf8")).status, "complete");
  assert.equal(rs(w, ["done", "--dir", w.g, "--cwd", w.repo]).json.stop, "not-active");
});

test("a change after the gates and the APPROVE makes both stale: done refuses and leaves the run active", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  writeFileSync(join(w.repo, "b.txt"), "new file\n");
  const d = rs(w, ["done", "--dir", w.g, "--cwd", w.repo]);
  assert.equal(d.code, 1);
  assert.ok(d.json.missing.includes("게이트 tests: stale"), d.stdout);
  assert.ok(d.json.missing.includes("지금 작업 트리에 대한 검토자 APPROVE 없음"), d.stdout);
  assert.equal(JSON.parse(readFileSync(join(w.g, "ralph.md"), "utf8")).status, "active");
});

test("a REJECT on the same tree outweighs another reviewer's APPROVE", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  const r = rs(w, ["verdict", "--dir", w.g, "--cwd", w.repo, "--by", "reviewer-2", "--verdict", "REJECT", "--blockers", "1", "--note", "edge case"]);
  assert.equal(r.code, 0);
  assert.deepEqual(check(w).json.missing, ["검토자 REJECT: reviewer-2"]);
});

test("verdicts: only reviewer-N may judge, an APPROVE with blockers is refused, none before iteration 1", (t) => {
  const w = world(t);
  start(w);
  assert.equal(approve(w).json.stop, "no-iteration");
  rs(w, ["next", "--dir", w.g]);
  assert.equal(approve(w, "author").code, 2);
  assert.equal(rs(w, ["verdict", "--dir", w.g, "--cwd", w.repo, "--by", "reviewer-1", "--verdict", "APPROVE", "--blockers", "2", "--note", "x"]).code, 2);
  assert.equal(rs(w, ["verdict", "--dir", w.g, "--cwd", w.repo, "--by", "reviewer-1", "--verdict", "MAYBE", "--note", "x"]).code, 2);
});

test("a failing gate keeps the run going; a failure the clean baseline had counts as baseline", (t) => {
  const w = world(t);
  start(w, ["--gates", "tests,lint"]);
  runGate(w, "lint", FAIL, 0);
  writeFileSync(join(w.repo, "a.txt"), "two\n");
  rs(w, ["next", "--dir", w.g]);
  runGate(w, "tests", FAIL, 1);
  runGate(w, "lint", FAIL, 1);
  deslop(w);
  approve(w);
  assert.deepEqual(check(w).json.missing, ["게이트 tests: fail"]);
});

test("the slop pass belongs to its iteration; --no-deslop drops it", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  rs(w, ["next", "--dir", w.g]);
  runGate(w, "tests", PASS, 2);
  approve(w);
  assert.deepEqual(check(w).json.missing, ["지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음"]);
  const w2 = world(t);
  start(w2, ["--gates", "tests", "--no-deslop"]);
  writeFileSync(join(w2.repo, "a.txt"), "two\n");
  rs(w2, ["next", "--dir", w2.g]);
  runGate(w2, "tests", PASS, 1);
  approve(w2);
  assert.equal(check(w2).code, 0);
});

test("no gates: allowed with a reason, which the check reports", (t) => {
  const w = world(t);
  assert.equal(start(w, ["--no-gates", "시험이 없는 문서 저장소"]).code, 0);
  rs(w, ["next", "--dir", w.g]);
  deslop(w);
  approve(w);
  const c = check(w);
  assert.equal(c.code, 0);
  assert.deepEqual(c.json.warnings, ["게이트 없음: 시험이 없는 문서 저장소"]);
  assert.equal(start(world(t), ["--gates", "tests", "--no-gates", "x"]).code, 2);
});

test("an edit after the slop pass needs a new pass, even when the gates and the review are redone", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  writeFileSync(join(w.repo, "a.txt"), "three\n");
  runGate(w, "tests", PASS, 1);
  runGate(w, "tests", PASS, 1);
  approve(w, "reviewer-2");
  assert.deepEqual(check(w).json.missing, ["지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음"]);
  deslop(w);
  assert.equal(check(w).code, 0);
});

test("an output file changed after its record keeps the run from ending", (t) => {
  const w = world(t);
  start(w);
  writeFileSync(join(w.repo, "a.txt"), "two\n");
  rs(w, ["next", "--dir", w.g]);
  const out = runGate(w, "tests", PASS, 1).json.output;
  deslop(w);
  approve(w);
  writeFileSync(out, "edited\n");
  assert.match(check(w).json.missing.join("\n"), /출력 파일이 기록과 다름/);
});

test("next stops at --max; stop ends the run with its reason", (t) => {
  const w = world(t);
  start(w, ["--gates", "tests", "--max", "1"]);
  assert.equal(rs(w, ["next", "--dir", w.g]).json.iter, 1);
  assert.equal(rs(w, ["next", "--dir", w.g]).json.stop, "max-spent");
  const s = rs(w, ["stop", "--dir", w.g, "--reason", "같은 실패 3회"]);
  assert.equal(s.json.status, "stopped");
  assert.equal(rs(w, ["next", "--dir", w.g]).json.stop, "not-active");
});

test("another repo, a folder no init made, and a repo with no git are stops", (t) => {
  const w = world(t);
  start(w);
  const other = world(t);
  assert.equal(rs(w, ["check", "--dir", w.g, "--cwd", other.repo]).json.stop, "other-repo");
  const fake = join(w.base, "ralph-qa-gates.fake01");
  mkdirSync(fake);
  assert.equal(rs(w, ["status", "--dir", fake]).json.stop, "not-a-run-folder");
  const plain = join(w.dir, "plain");
  mkdirSync(plain);
  assert.equal(rs(w, ["find", "--cwd", plain]).json.stop, "not-a-git-tree");
});

test("find lists this repo's runs only, newest first", (t) => {
  const w = world(t);
  start(w);
  const g2 = gate(w, ["init", "--cwd", w.repo]).json.dir;
  rs(w, ["start", "--dir", g2, "--cwd", w.repo, "--task", "second", "--gates", "tests"]);
  const f = rs(w, ["find", "--cwd", w.repo]);
  assert.equal(f.code, 0);
  assert.equal(f.json.runs.length, 2);
  assert.equal(f.json.runs[0].task, "second");
  assert.ok(existsSync(f.json.runs[1].dir));
});
