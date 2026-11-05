// Tests for ralph-state.mjs as a program: a run ends only on gates that passed on the tree as it is now, a fresh
// reviewer's APPROVE of the tree it was shown and this iteration's slop pass on that tree; any change after them, a
// REJECT of that tree in any iteration, a baseline failure nobody accepted, another repo or a spent limit keeps it
// from ending. The Codex Stop hook's question (continueFor) keeps only the session that started a run going.
// Run: node --test codex/skills/ralph/scripts/ralph-state.test.mjs
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkRun, continueFor, parseArgs } from "./ralph-state.mjs";

const TOOL = fileURLToPath(new URL("./ralph-state.mjs", import.meta.url));
const GATE = fileURLToPath(new URL("./gate-evidence.mjs", import.meta.url));
const WIN = process.platform === "win32";
const NODE = process.execPath;
const SESSION = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const q = (s) => (WIN ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`);
const nodeCmd = (...args) => `${WIN ? "& " : ""}${[NODE, ...args].map(q).join(" ")}`;
const PASS = nodeCmd("-e", "process.exit(0)");
// A gate that fails while a.txt starts with "one" (the bug), and passes once it is fixed.
const BUGGY = nodeCmd("-e", "const t=require('fs').readFileSync('a.txt','utf8'); if (t.startsWith('one')) { console.log('a.txt still one'); process.exit(1) }");

function world(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "br-rs-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const base = WIN ? join(home, "AppData", "Local", "Temp") : join(dir, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_THREAD_ID: SESSION,
    ...(WIN ? { TEMP: base, TMP: base } : process.platform === "darwin" ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }),
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  for (const a of [["-c", "init.defaultBranch=main", "init", "-q"], ["add", "a.txt"], ["commit", "-q", "-m", "base"]]) spawnSync("git", ["-C", repo, ...a], { env });
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
const runGate = (w, id, cmd, iter, g = w.g) => gate(w, ["run", "--dir", g, "--id", id, "--cmd", cmd, "--timeout", "30", "--iter", String(iter), "--cwd", w.repo]);
const start = (w, extra = ["--gates", "tests"]) => rs(w, ["start", "--dir", w.g, "--cwd", w.repo, "--task", "fix a", ...extra]);
const check = (w) => rs(w, ["check", "--dir", w.g, "--cwd", w.repo]);
const fp = (w) => check(w).json.fingerprint;
const judge = (w, by, word, extra = []) => rs(w, ["verdict", "--dir", w.g, "--cwd", w.repo, "--by", by, "--verdict", word, "--fingerprint", fp(w), "--note", "seen", ...extra]);
const approve = (w, by = "reviewer-1") => judge(w, by, "APPROVE");
const deslop = (w) => rs(w, ["deslop", "--dir", w.g, "--cwd", w.repo, "--note", "a.txt 점검, 바꾼 것 없음"]);
const next = (w) => rs(w, ["next", "--dir", w.g]);
const state = (w) => JSON.parse(readFileSync(join(w.g, "ralph.md"), "utf8"));
const ctxOf = (w) => ({ env: w.env, platform: process.platform });

// One iteration that may end: change, slop pass, gate pass, reviewer APPROVE.
function greenIteration(w) {
  writeFileSync(join(w.repo, "a.txt"), "two\n");
  assert.equal(next(w).json.iter, 1);
  assert.equal(deslop(w).code, 0);
  assert.equal(runGate(w, "tests", PASS, 1).json.verdict, "pass");
  assert.equal(approve(w).code, 0);
}

test("arguments: unknown flags, values on a boolean, a flag taken for a value and missing flags are usage errors", () => {
  assert.throws(() => parseArgs(["start", "--dir", "x", "--cwd", "y"]), /--task/);
  assert.throws(() => parseArgs(["start", "--dir", "x", "--cwd", "y", "--task", "t", "--no-deslop=yes"]), /값을 받지 않는다/);
  assert.throws(() => parseArgs(["start", "--dir", "x", "--cwd", "y", "--task", "--gates", "tests"]), /--task 에 값이 없다/);
  assert.equal(parseArgs(["start", "--dir", "x", "--cwd", "y", "--task=--odd", "--gates", "t"]).o.task, "--odd");
  assert.throws(() => parseArgs(["next", "--dir", "x", "--force"]), /모르는 인자/);
  assert.throws(() => parseArgs(["launch"]), /모르는 명령/);
  assert.throws(() => parseArgs(["verdict", "--dir", "x", "--cwd", "y", "--by", "reviewer-1", "--verdict", "APPROVE", "--note", "n"]), /--fingerprint/);
});

test("checkRun: an iteration with no gate record, no APPROVE and no slop pass names all three", () => {
  const s = { status: "active", iter: 1, gates: ["tests"], noGates: null, deslop: true, verdicts: [], deslops: [], accepts: [], baseline: "run", startFingerprint: "x" };
  assert.deepEqual(checkRun(s, [], "fp").missing, ["게이트 tests: missing", "지금 작업 트리에 대한 검토자 APPROVE 없음", "지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음"]);
});

test("start: needs gates or a reason for none, refuses a second start, records the session and a baseline only on a clean tree", (t) => {
  const w = world(t);
  assert.ok(w.g, "gate folder");
  assert.equal(rs(w, ["start", "--dir", w.g, "--cwd", w.repo, "--task", "x"]).code, 2);
  const s = start(w);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.baseline, "run");
  assert.equal(s.json.session, SESSION);
  assert.match(s.json.head, /^[0-9a-f]{40}$/);
  assert.equal(start(w).json.stop, "started");
  const w2 = world(t);
  writeFileSync(join(w2.repo, "new.txt"), "untracked\n");
  assert.equal(start(w2).json.baseline, "none-dirty");
});

test("a full green iteration ends the run once, with its line", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  const d = rs(w, ["done", "--dir", w.g, "--cwd", w.repo]);
  assert.equal(d.code, 0, d.stdout);
  assert.equal(d.json.line, "RALPH COMPLETE iter=1 gates=tests approvals=1 deslop=done baseline=0 misleading=0");
  assert.equal(state(w).status, "complete");
  assert.equal(rs(w, ["done", "--dir", w.g, "--cwd", w.repo]).json.stop, "not-active");
});

test("a change after the gates and the APPROVE makes both stale: done refuses and leaves the run active", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  writeFileSync(join(w.repo, "b.txt"), "new file\n");
  const d = rs(w, ["done", "--dir", w.g, "--cwd", w.repo]);
  assert.equal(d.code, 1);
  for (const m of ["게이트 tests: stale", "지금 작업 트리에 대한 검토자 APPROVE 없음", "지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음"]) assert.ok(d.json.missing.includes(m), d.stdout);
  assert.equal(state(w).status, "active");
});

test("a REJECT of this tree outweighs an APPROVE, also when the APPROVE came in a later iteration", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  assert.equal(judge(w, "reviewer-2", "REJECT", ["--blockers", "1"]).code, 0);
  assert.deepEqual(check(w).json.missing, ["이 작업 트리에 검토자 REJECT: reviewer-2"]);
  next(w);
  deslop(w);
  runGate(w, "tests", PASS, 2);
  approve(w, "reviewer-3");
  const d = rs(w, ["done", "--dir", w.g, "--cwd", w.repo]);
  assert.equal(d.code, 1, "an unchanged tree a reviewer rejected cannot end the run");
  assert.deepEqual(d.json.missing, ["이 작업 트리에 검토자 REJECT: reviewer-2"]);
});

test("verdicts: only reviewer-N, no APPROVE with blockers, none before iteration 1, and only for the tree the reviewer saw", (t) => {
  const w = world(t);
  start(w);
  assert.equal(approve(w).json.stop, "no-iteration");
  next(w);
  assert.equal(approve(w, "author").code, 2);
  assert.equal(judge(w, "reviewer-1", "APPROVE", ["--blockers", "2"]).code, 2);
  assert.equal(judge(w, "reviewer-1", "MAYBE").code, 2);
  const seen = fp(w);
  writeFileSync(join(w.repo, "a.txt"), "changed while the review ran\n");
  const r = rs(w, ["verdict", "--dir", w.g, "--cwd", w.repo, "--by", "reviewer-1", "--verdict", "APPROVE", "--fingerprint", seen, "--note", "x"]);
  assert.equal(r.json.stop, "stale-review");
  assert.equal(state(w).verdicts.length, 0);
});

test("a baseline failure the task must fix never ends the run unaccepted; an accepted one needs an APPROVE after it", (t) => {
  const w = world(t);
  start(w);
  assert.equal(runGate(w, "tests", BUGGY, 0).json.verdict, "fail");
  next(w);
  writeFileSync(join(w.repo, "note.txt"), "nothing fixed\n");
  deslop(w);
  runGate(w, "tests", BUGGY, 1);
  approve(w);
  const c = check(w).json;
  assert.equal(c.ok, false);
  assert.match(c.missing.join("\n"), /게이트 tests: 시작 전부터 같은 실패\(baseline\)/);
  assert.equal(rs(w, ["accept-baseline", "--dir", w.g, "--cwd", w.repo, "--id", "tests", "--reason", "상관없는 실패"]).code, 0);
  assert.deepEqual(check(w).json.missing, ["accept-baseline 뒤에 받은 검토자 APPROVE 없음"]);
  approve(w, "reviewer-2");
  const d = rs(w, ["done", "--dir", w.g, "--cwd", w.repo]);
  assert.equal(d.code, 0, d.stdout);
  assert.match(d.json.line, / baseline=1 /);
  assert.match(d.json.warnings.join("\n"), /시작 전부터 같은 실패를 받아들임\(상관없는 실패\)/);
});

test("accept-baseline refuses a gate that does not fail as it did at the start", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  assert.equal(rs(w, ["accept-baseline", "--dir", w.g, "--cwd", w.repo, "--id", "tests", "--reason", "x"]).json.stop, "not-baseline");
});

test("iteration 0 counts as the baseline only on the clean tree the run started from", (t) => {
  const dirty = world(t);
  writeFileSync(join(dirty.repo, "a.txt"), "one, half changed\n");
  assert.equal(start(dirty).json.baseline, "none-dirty");
  runGate(dirty, "tests", BUGGY, 0);
  next(dirty);
  deslop(dirty);
  runGate(dirty, "tests", BUGGY, 1);
  approve(dirty);
  assert.deepEqual(check(dirty).json.missing, ["게이트 tests: fail"]);
  const moved = world(t);
  start(moved);
  writeFileSync(join(moved.repo, "a.txt"), "one, broken before the baseline\n");
  runGate(moved, "tests", BUGGY, 0);
  next(moved);
  deslop(moved);
  runGate(moved, "tests", BUGGY, 1);
  approve(moved);
  assert.deepEqual(check(moved).json.missing, ["게이트 tests: fail"]);
});

test("the slop pass belongs to its iteration and tree; --no-deslop drops it", (t) => {
  const w = world(t);
  start(w);
  greenIteration(w);
  next(w);
  runGate(w, "tests", PASS, 2);
  approve(w);
  assert.deepEqual(check(w).json.missing, ["지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음"]);
  const w2 = world(t);
  start(w2, ["--gates", "tests", "--no-deslop"]);
  writeFileSync(join(w2.repo, "a.txt"), "two\n");
  next(w2);
  runGate(w2, "tests", PASS, 1);
  approve(w2);
  assert.equal(check(w2).code, 0);
});

test("no gates: allowed with a reason, which the check reports", (t) => {
  const w = world(t);
  assert.equal(start(w, ["--no-gates", "시험이 없는 문서 저장소"]).code, 0);
  next(w);
  deslop(w);
  approve(w);
  const c = check(w);
  assert.equal(c.code, 0);
  assert.deepEqual(c.json.warnings, ["게이트 없음: 시험이 없는 문서 저장소"]);
  assert.equal(start(world(t), ["--gates", "tests", "--no-gates", "x"]).code, 2);
});

test("an output file changed after its record keeps the run from ending; evidence shows this iteration's records", (t) => {
  const w = world(t);
  start(w);
  writeFileSync(join(w.repo, "a.txt"), "two\n");
  next(w);
  deslop(w);
  const out = runGate(w, "tests", PASS, 1).json.output;
  approve(w);
  const ev = rs(w, ["evidence", "--dir", w.g]).json;
  assert.deepEqual(ev.records.map((r) => [r.id, r.iter, r.verdict]), [["tests", 1, "pass"]]);
  writeFileSync(out, "edited\n");
  assert.match(check(w).json.missing.join("\n"), /출력 파일이 기록과 다름/);
});

test("next stops at --max; stop ends the run with its reason, and done then refuses", (t) => {
  const w = world(t);
  start(w, ["--gates", "tests", "--max", "1"]);
  assert.equal(next(w).json.iter, 1);
  assert.equal(next(w).json.stop, "max-spent");
  assert.equal(rs(w, ["stop", "--dir", w.g, "--reason", "같은 실패 3회"]).json.status, "stopped");
  assert.equal(next(w).json.stop, "not-active");
  assert.equal(rs(w, ["done", "--dir", w.g, "--cwd", w.repo]).json.stop, "not-active");
});

test("another repo, a folder no init made, a repo with no git and an unreadable record are stops", (t) => {
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
  const g2 = gate(w, ["init", "--cwd", w.repo]).json.dir;
  writeFileSync(join(g2, "ralph.md"), JSON.stringify({ kind: "banker-ralph", v: 1 }));
  assert.equal(rs(w, ["check", "--dir", g2, "--cwd", w.repo]).json.stop, "bad-state");
  const f = rs(w, ["find", "--cwd", w.repo]).json;
  assert.deepEqual([f.runs.length, f.unreadable], [1, [g2]]);
});

test("find lists this repo's runs only, newest first", (t) => {
  const w = world(t);
  start(w);
  const g2 = gate(w, ["init", "--cwd", w.repo]).json.dir;
  rs(w, ["start", "--dir", g2, "--cwd", w.repo, "--task", "second", "--gates", "tests"]);
  const f = rs(w, ["find", "--cwd", w.repo]);
  assert.equal(f.code, 0);
  assert.deepEqual(f.json.runs.map((r) => r.task), ["second", "fix a"]);
  assert.ok(existsSync(f.json.runs[1].dir));
});

test("verdicts recorded at the same moment are all kept (the record is changed under a lock)", async (t) => {
  const w = world(t);
  start(w);
  next(w);
  const seen = fp(w);
  const one = (i) => new Promise((resolve) => {
    const c = spawn(NODE, [TOOL, "verdict", "--dir", w.g, "--cwd", w.repo, "--by", `reviewer-${i}`, "--verdict", i % 2 ? "REJECT" : "APPROVE",
      ...(i % 2 ? ["--blockers", "1"] : []), "--fingerprint", seen, "--note", `n${i}`], { env: w.env, stdio: "ignore" });
    c.on("close", resolve);
  });
  const codes = await Promise.all([1, 2, 3, 4, 5, 6].map(one));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  assert.equal(state(w).verdicts.length, 6);
  assert.match(check(w).json.missing.join("\n"), /검토자 REJECT/);
});

test("a lock left by a dead process is taken over after a minute", (t) => {
  const w = world(t);
  start(w);
  const lock = join(w.g, ".ralph.lock");
  writeFileSync(lock, "99999 old\n");
  const old = new Date(Date.now() - 120000);
  utimesSync(lock, old, old);
  assert.equal(next(w).json.iter, 1);
  assert.equal(existsSync(lock), false);
});

test("continueFor: keeps only the starting session going while its run is active, and lets go after five stops with no change", (t) => {
  const w = world(t);
  start(w);
  const ask = (turn, sessionId = SESSION) => continueFor({ cwd: w.repo, sessionId, turnId: turn }, ctxOf(w));
  assert.match(ask("t1"), /banker ralph 실행이 아직 active 다/);
  assert.match(ask("t1"), /1\/5/, "a second hook in the same turn does not count again");
  assert.equal(ask("t1", "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002"), null, "another session (a reviewer) may stop");
  for (const turn of ["t2", "t3", "t4", "t5"]) assert.ok(ask(turn));
  assert.equal(ask("t6"), null, "the sixth stop with nothing new lets the turn end");
  next(w);
  assert.match(ask("t7"), /1\/5/, "progress resets the count");
  const other = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003";
  assert.equal(call({ env: { ...w.env, CODEX_THREAD_ID: other } }, TOOL, ["adopt", "--dir", w.g]).json.session, other);
  assert.equal(ask("t8"), null, "after adopt the old session may stop");
  assert.match(ask("t9", other), /banker ralph/, "and the new one is kept going");
  assert.equal(call({ env: { ...w.env, CODEX_THREAD_ID: "" } }, TOOL, ["adopt", "--dir", w.g]).json.stop, "no-session");
  rs(w, ["stop", "--dir", w.g, "--reason", "user"]);
  assert.equal(ask("t10", other), null);
  assert.equal(continueFor({ cwd: join(w.dir, "nowhere"), sessionId: SESSION, turnId: "x" }, ctxOf(w)), null);
});

test("continueFor: a continued turn (same turn_id) still counts each stop, a held lock lets the turn end at once, and the rollout name finds the session", (t) => {
  const w = world(t);
  start(w);
  const note = join(w.g, ".ralph-continue.md");
  const age = () => writeFileSync(note, JSON.stringify({ ...JSON.parse(readFileSync(note, "utf8")), at: Date.now() - 10000 }));
  const ask = (extra = {}) => continueFor({ cwd: w.repo, sessionId: SESSION, turnId: "same", ...extra }, ctxOf(w));
  for (let i = 1; i <= 5; i += 1) {
    assert.match(ask(), new RegExp(`${i}/5`));
    age();
  }
  assert.equal(ask(), null, "five blocks in one continued turn with nothing new, then the turn may end");
  next(w);
  const lock = join(w.g, ".ralph.lock");
  writeFileSync(lock, "someone else\n");
  const t0 = Date.now();
  assert.equal(ask({ turnId: "other" }), null);
  assert.ok(Date.now() - t0 < 2000, "the hook does not wait for a held lock");
  rmSync(lock);
  const rollout = join(w.dir, `rollout-2026-11-06T00-00-00-${SESSION}.jsonl`);
  assert.match(continueFor({ cwd: w.repo, sessionId: "not-a-uuid", turnId: "r1", transcript: rollout }, ctxOf(w)), /banker ralph/);
  assert.equal(continueFor({ cwd: w.repo, sessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009", turnId: "r2", transcript: rollout }, ctxOf(w)), null,
    "a sub-agent with its own session id is not matched through the parent's rollout path");
  writeFileSync(note, JSON.stringify({ key: "x", count: 1, total: 100, turn: "old", at: 0 }));
  assert.equal(ask({ turnId: "late" }), null, "a hundred blocks in all let the turn end");
});
