// Tests for the pure parts of gate-evidence.mjs that the quorum and ultraqa's status judge by: the gate conjunct, the
// verdict of one run, the failure signature, the same failure and the same issue, and how a spent --max ends.
// Run: node --test skills/ralph-qa/references/gate-quorum.test.mjs
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLASSES, exhausted, gateConjunct, issueKey, judge, repeated, repeatedFailures, signatureOf } from "./gate-evidence.mjs";

const FP = "fp-now";
let seq = 0;
const obs = (id, iter, verdict, extra = {}) => ({ kind: "observed", id, iter, seq: (seq += 1), cmd: `run ${id}`, fingerprint: FP, verdict,
  signature: verdict === "pass" ? null : `${id}:sig-a`, ...extra });
const states = (r) => Object.fromEntries(r.gates.map((g) => [g.id, g.state]));

test("every declared gate needs an observed record of this iteration: a missing one or one of an earlier iteration fails", () => {
  const ev = [obs("tests", 1, "pass"), obs("build", 0, "pass")];
  const r = gateConjunct(ev, ["tests", "build"], FP, 1);
  assert.equal(r.ok, false);
  assert.deepEqual(states(r), { tests: "pass", build: "missing" });
  assert.equal(gateConjunct(ev, [], FP, 1).ok, false, "no gate declared is no conjunct to pass");
});

test("a record made on another tree is stale, so a fix after the gate ran cannot ride on its pass", () => {
  const r = gateConjunct([obs("tests", 2, "pass", { fingerprint: "fp-before-edit" })], ["tests"], FP, 2);
  assert.deepEqual([r.ok, states(r).tests], [false, "stale"]);
});

test("a reported line never counts, even one that says the gate passed", () => {
  const ev = [{ kind: "reported", id: "tests", iter: 1, exit: 0, text: "all green", fingerprint: FP, verdict: "pass" }];
  assert.deepEqual(states(gateConjunct(ev, ["tests"], FP, 1)), { tests: "missing" });
});

test("a failure the baseline had with the same signature and command is split off; a new one is not", () => {
  const base = obs("lint", 0, "fail");
  assert.deepEqual(states(gateConjunct([base, obs("lint", 1, "fail")], ["lint"], FP, 1)), { lint: "baseline" });
  assert.equal(gateConjunct([base, obs("lint", 1, "fail")], ["lint"], FP, 1).ok, true);
  assert.deepEqual(states(gateConjunct([base, obs("lint", 1, "fail", { signature: "lint:sig-b" })], ["lint"], FP, 1)), { lint: "fail" });
  assert.deepEqual(states(gateConjunct([base, obs("lint", 1, "fail", { cmd: "other" })], ["lint"], FP, 1)), { lint: "fail" });
  assert.deepEqual(states(gateConjunct([obs("lint", 1, "timeout")], ["lint"], FP, 1)), { lint: "timeout" });
});

test("a pass right after a failure needs two more passes on the same tree", () => {
  const fail = obs("tests", 1, "fail");
  let r = gateConjunct([fail, obs("tests", 2, "pass")], ["tests"], FP, 2);
  assert.deepEqual([r.ok, r.gates[0].state, r.gates[0].need], [false, "flaky", 2]);
  r = gateConjunct([fail, obs("tests", 2, "pass"), obs("tests", 2, "pass")], ["tests"], FP, 2);
  assert.equal(r.gates[0].need, 1);
  r = gateConjunct([fail, obs("tests", 2, "pass"), obs("tests", 2, "pass"), obs("tests", 2, "pass")], ["tests"], FP, 2);
  assert.deepEqual([r.ok, r.gates[0].state], [true, "pass"]);
  r = gateConjunct([fail, obs("tests", 2, "pass", { fingerprint: "old" }), obs("tests", 2, "pass"), obs("tests", 2, "pass")], ["tests"], FP, 2);
  assert.equal(r.gates[0].state, "flaky", "a pass on another tree is not one of the three");
  assert.equal(gateConjunct([obs("tests", 1, "pass")], ["tests"], FP, 1).ok, true, "no failure before: one pass");
});

test("misleading output is no machine block: it passes the conjunct and is named for the seats", () => {
  const r = gateConjunct([obs("tests", 1, "misleading", { why: "node:test 건너뜀" })], ["tests"], FP, 1);
  assert.deepEqual([r.ok, r.gates[0].state, r.gates[0].why], [true, "misleading", "node:test 건너뜀"]);
});

test("scenarios stands for every scenario-* gate, and with none recorded it is missing", () => {
  const ev = [obs("scenario-1", 1, "pass"), obs("scenario-2", 1, "fail", { signature: "scenario-2:x" })];
  const r = gateConjunct(ev, ["scenarios"], FP, 1);
  assert.deepEqual(states(r), { "scenario-1": "pass", "scenario-2": "fail" });
  assert.deepEqual(states(gateConjunct([], ["scenarios"], FP, 1)), { scenarios: "missing" });
});

test("the same failure is a signature seen in three different iterations; repeats within one iteration do not add up", () => {
  const ev = [obs("tests", 0, "fail"), obs("tests", 1, "fail"), obs("tests", 1, "fail")];
  assert.deepEqual(repeatedFailures(ev), []);
  assert.deepEqual(repeatedFailures([...ev, obs("tests", 2, "fail")]), ["tests:sig-a"]);
  assert.deepEqual(repeatedFailures([...ev, { kind: "reported", id: "tests", iter: 2, signature: "tests:sig-a" }]), [], "reported lines do not count");
});

test("the same issue is (seat, cited path or criterion, title) with the title's case and punctuation normalized", () => {
  const a = issueKey("backbone#1", "src/a.mjs", "Missing timeout!");
  assert.equal(a, issueKey("backbone#1", "src/a.mjs", "missing  timeout"));
  assert.notEqual(a, issueKey("backbone#2", "src/a.mjs", "missing timeout"));
  assert.notEqual(a, issueKey("backbone#1", "AC-2", "missing timeout"));
  assert.deepEqual(repeated([1, 2, 3].map((iter) => ({ key: a, iter }))), [a]);
});

test("a spent --max: blockers left are INCONCLUSIVE, a quorum kept only by the gates names gate as its cause", () => {
  assert.equal(exhausted({ blockers: 1, quorumWithoutGate: true, gateOk: false }), "INCONCLUSIVE");
  assert.equal(exhausted({ blockers: 0, quorumWithoutGate: true, gateOk: false }), "ITERATE(한도 소진, 원인 gate)");
  assert.equal(exhausted({ blockers: 0, quorumWithoutGate: false, gateOk: false }), "ITERATE(한도 소진)");
  assert.equal(exhausted({ blockers: 0, quorumWithoutGate: false, gateOk: undefined }), "ITERATE(한도 소진)");
});

test("one run's verdict: a non-zero exit fails, a timeout is its own, exit 0 with failures or skips in the output misleads", () => {
  assert.equal(judge({ exit: 1, text: "" }).verdict, "fail");
  assert.equal(judge({ exit: null, signal: "SIGKILL", text: "" }).verdict, "fail");
  assert.equal(judge({ exit: null, timedOut: true, text: "" }).verdict, "timeout");
  assert.equal(judge({ exit: 0, text: "all good\n" }).verdict, "pass");
  for (const text of ["ℹ tests 3\nℹ fail 1\n", "ℹ skipped 2\n", "# fail 1\n", "Tests:       1 failed, 2 passed, 3 total\n",
    "Tests:       2 skipped, 5 passed, 7 total\n", " Tests  1 failed | 3 passed (4)\n", "==== 1 failed, 4 passed in 0.12s ====\n",
    "===== 3 passed, 1 skipped in 0.20s =====\n", "--- FAIL: TestX (0.00s)\n", "    --- SKIP: TestY (0.00s)\n"]) {
    assert.equal(judge({ exit: 0, text }).verdict, "misleading", text);
  }
  for (const text of ["ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\n", "Tests:       3 passed, 3 total\n", "==== 4 passed in 0.12s ====\n", "ok  \tpkg\t0.01s\n"]) {
    assert.equal(judge({ exit: 0, text }).verdict, "pass", text);
  }
});

test("a failure signature ignores times, numbers and temporary folders, and tells two failing tests apart", () => {
  const a = signatureOf("tests", "fail", "✖ adds two numbers (12.3ms)\n  AssertionError: 3 !== 4\n at /tmp/rq-abc123/x.mjs:10:5\n");
  const b = signatureOf("tests", "fail", "✖ adds two numbers (99.1ms)\n  AssertionError: 3 !== 4\n at /tmp/rq-zz9qq1/x.mjs:11:7\n");
  const c = signatureOf("tests", "fail", "✖ parses a flag (1ms)\n  AssertionError: false !== true\n");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^tests:[0-9a-f]{16}$/);
  assert.notEqual(signatureOf("tests", "fail", "x\n"), signatureOf("tests", "timeout", "x\n"), "the verdict is part of it");
});

test("the nine adversarial classes are OMX ultraqa's, each with an id and a Korean name", () => {
  assert.deepEqual(CLASSES.map(([id]) => id), ["malformed-input", "repeated-interruption", "prompt-injection", "cancel-resume", "stale-state",
    "dirty-worktree", "hung-command", "flaky-test", "misleading-output"]);
  assert.ok(CLASSES.every(([, ko]) => /[가-힣]/.test(ko)));
});
