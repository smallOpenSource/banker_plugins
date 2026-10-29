// Tests for uqa-run.mjs: the status checks that let COMPLETE be claimed, the end lines, the resume conditions, the
// matrix rows, the report skeleton and the cleanup. Run: node --test skills/ultraqa/references/uqa-run.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CLASSES } from "./gate-evidence.mjs";
import { MAX_CYCLES, endAllowed, matrixCheck, staleCheck, statusOf } from "./uqa-run.mjs";

const RUN = fileURLToPath(new URL("./uqa-run.mjs", import.meta.url));
const GATE = fileURLToPath(new URL("./gate-evidence.mjs", import.meta.url));
const WIN = process.platform === "win32";
const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const NODE = process.execPath;
const q = (s) => (WIN ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`);
const nodeCmd = (...args) => `${WIN ? "& " : ""}${[NODE, ...args].map(q).join(" ")}`;

// ---- pure checks

const FP = "fp";
const obs = (id, iter, verdict, seq, extra = {}) => ({ kind: "observed", id, iter, seq, cmd: id, fingerprint: FP, verdict, signature: verdict === "pass" ? null : `${id}:s`, ...extra });
const fullMatrix = (seqOf = () => 2) => CLASSES.map(([c], i) => ({ id: `ADV-${i + 1}`, class: c, status: "pass", evidenceRef: seqOf(i) }));

test("matrix-incomplete: a class with no row, an excluded row without a reason, a pass with no record, an open row", () => {
  assert.equal(matrixCheck(fullMatrix()).ok, true);
  assert.deepEqual(matrixCheck(fullMatrix().slice(1)).missing, ["malformed-input"]);
  const rows = fullMatrix();
  rows[0] = { id: "ADV-1", class: "malformed-input", status: "excluded", excludeReason: " " };
  assert.deepEqual(matrixCheck(rows).missing, ["malformed-input"]);
  rows[0].excludeReason = "입력을 받는 곳이 없다";
  assert.equal(matrixCheck(rows).ok, true, "excluded with a reason covers the class");
  rows[1] = { ...rows[1], evidenceRef: undefined };
  assert.deepEqual(matrixCheck(rows).bad, ["ADV-2"]);
  rows[1] = { ...rows[1], status: "blocked" };
  assert.deepEqual(matrixCheck(rows).open, ["ADV-2"]);
  assert.equal(matrixCheck([]).ok, false);
});

test("stale-evidence: a goal gate's last record or a cited record made on another tree, or a goal gate never run", () => {
  const ev = [obs("tests", 1, "pass", 1), obs("scenario-1", 1, "pass", 2)];
  const rows = [{ id: "A", status: "pass", evidenceRef: 2 }];
  assert.equal(staleCheck(ev, ["tests"], rows, FP).ok, true);
  assert.deepEqual(staleCheck(ev, ["tests"], rows, "fp-after-a-fix").stale, [1, 2]);
  assert.deepEqual(staleCheck(ev, ["tests", "build"], rows, FP).unrun, ["build"]);
  assert.equal(staleCheck(ev, ["tests"], [{ id: "B", status: "pass", evidenceRef: 99 }], FP).ok, false, "a row citing no record");
});

test("status allows COMPLETE only when all hold, and names the end line otherwise", () => {
  const ev = [obs("tests", 1, "fail", 1), obs("tests", 2, "pass", 2), obs("tests", 2, "pass", 3), obs("tests", 2, "pass", 4)];
  let st = statusOf({ evidence: ev, rows: fullMatrix(), gates: ["tests"], fingerprint: FP });
  assert.deepEqual([st.complete, st.cycle, st.next], [true, 2, "ULTRAQA COMPLETE: Goal met after 2 cycles"]);
  st = statusOf({ evidence: ev, rows: fullMatrix().slice(2), gates: ["tests"], fingerprint: FP });
  assert.deepEqual([st.complete, st.checks.matrix.ok, st.next], [false, false, null]);
  st = statusOf({ evidence: ev.slice(0, 2), rows: fullMatrix(), gates: ["tests"], fingerprint: FP });
  assert.equal(st.checks.gates.ok, false, "a pass right after a failure needs two more");
  const same = [1, 2, 3].map((i) => obs("tests", i, "fail", i));
  st = statusOf({ evidence: same, rows: fullMatrix(), gates: ["tests"], fingerprint: FP });
  assert.deepEqual([st.checks.sameFailure.ok, st.next], [false, "ULTRAQA STOPPED: Same failure detected 3 times"]);
  const five = [1, 2, 3, 4, 5].map((i) => obs("tests", i, "fail", i, { signature: `tests:s${i}` }));
  st = statusOf({ evidence: five, rows: fullMatrix(), gates: ["tests"], fingerprint: FP });
  assert.deepEqual([st.cycle, st.checks.maxCycles.ok, st.next], [MAX_CYCLES, true, "ULTRAQA STOPPED: Max cycles"]);
  st = statusOf({ evidence: [...five, obs("tests", 6, "pass", 6)], rows: fullMatrix(), gates: ["tests"], fingerprint: FP });
  assert.equal(st.checks.maxCycles.ok, false, "a sixth cycle is past the limit");
});

test("finish: COMPLETE is refused while any check fails; the STOPPED lines need what status says; BLOCKED and ERROR a reason", () => {
  const ok = statusOf({ evidence: [obs("tests", 1, "pass", 1)], rows: fullMatrix(() => 1), gates: ["tests"], fingerprint: FP });
  assert.equal(endAllowed("complete", ok), null);
  for (const [name, st] of [["matrix", { ...ok, complete: false, checks: { ...ok.checks, matrix: { ok: false } } }],
    ["stale", { ...ok, complete: false, checks: { ...ok.checks, staleEvidence: { ok: false } } }]]) {
    assert.match(endAllowed("complete", st), /COMPLETE 를 거부한다/, name);
  }
  assert.ok(endAllowed("same-failure", ok), "no same failure recorded");
  assert.ok(endAllowed("max-cycles", ok), "one cycle is not the limit");
  assert.ok(endAllowed("blocked", ok, ""));
  assert.equal(endAllowed("error", ok, "tmux 없음"), null);
  assert.ok(endAllowed("done", ok));
});

// ---- the program, end to end

function world(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "uqa-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const base = WIN ? join(home, "AppData", "Local", "Temp") : join(dir, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...(WIN ? { TEMP: base, TMP: base } : process.platform === "darwin" ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }),
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const a of [["-c", "init.defaultBranch=main", "init", "-q"], ["commit", "-q", "--allow-empty", "-m", "base"]]) spawnSync("git", ["-C", repo, ...a], { env });
  return { dir, env, repo };
}
const call = (w, tool, args, input) => {
  const r = spawnSync(NODE, [tool, ...args], { encoding: "utf8", env: w.env, input, timeout: 120000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* markdown or nothing */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};

test("a whole run: init, gates through gate-evidence, rows, a refused COMPLETE, then COMPLETE, report and cleanup", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const init = call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests"]);
  assert.equal(init.code, 0, init.stderr);
  const d = init.json.dir;
  const gate = (iter) => call(w, GATE, ["run", "--dir", d, "--id", "tests", "--cmd", nodeCmd("-e", "console.log('ℹ pass 1')"), "--timeout", "30", "--iter", String(iter), "--cwd", w.repo]).json;
  const rec = gate(1);
  assert.equal(rec.verdict, "pass");
  let r = call(w, RUN, ["finish", "--dir", d, "--end", "complete"]);
  assert.equal(r.code, 1);
  assert.match(r.json.refused, /COMPLETE 를 거부한다: .*matrix/);
  const rows = (seq) => CLASSES.forEach(([c], i) => {
    const row = { id: `ADV-${i + 1}`, class: c, intent: "x", model: "적대적 사용자", status: i === 0 ? "excluded" : "pass", evidenceRef: seq, excludeReason: i === 0 ? "입력 없음" : undefined };
    assert.equal(call(w, RUN, ["row", "--dir", d], JSON.stringify(row)).code, 0);
  });
  rows(rec.seq);
  assert.equal(call(w, RUN, ["row", "--dir", d], '{"id":"x","class":"nope","status":"pass"}').code, 2, "an unknown class");
  assert.equal(call(w, RUN, ["status", "--dir", d]).json.complete, true);
  writeFileSync(join(w.repo, "fix.mjs"), "export {};\n");
  r = call(w, RUN, ["status", "--dir", d]);
  assert.deepEqual([r.code, r.json.checks.staleEvidence.ok], [1, false], "a change after the gate ran");
  const rec2 = gate(2);
  r = call(w, RUN, ["status", "--dir", d]);
  assert.equal(r.json.checks.staleEvidence.ok, false, "the rows still cite the record of the old tree");
  rows(rec2.seq);
  r = call(w, RUN, ["finish", "--dir", d, "--end", "complete"]);
  assert.deepEqual([r.code, r.json.line], [0, "ULTRAQA COMPLETE: Goal met after 2 cycles"], r.stdout);
  const md = call(w, RUN, ["report", "--dir", d]).stdout;
  assert.ok(md.includes("## 실행한 명령(관측)") && md.includes("## 신고(판정에 쓰지 않음)") && md.includes("| ADV-2 | repeated-interruption |"), md);
  r = call(w, RUN, ["cleanup", "--dir", d]);
  assert.equal(r.code, 0);
  assert.ok(!existsSync(d));
});

test("resume only for the same repo, HEAD and work tree of an unfinished run; a changed tree starts anew", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  assert.equal(call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests", "--resume"]).json.stop, "no-resume", "nothing to resume");
  const d = call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests"]).json.dir;
  call(w, GATE, ["run", "--dir", d, "--id", "tests", "--cmd", nodeCmd("-e", "process.exit(1)"), "--timeout", "30", "--iter", "1", "--cwd", w.repo]);
  let r = call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests", "--resume"]);
  assert.deepEqual([r.code, r.json.dir, r.json.resumed, r.json.nextCycle], [0, d, true, 2]);
  writeFileSync(join(w.repo, "edit.txt"), "changed\n");
  r = call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests", "--resume"]);
  assert.deepEqual([r.code, r.json.stop], [3, "no-resume"]);
  rmSync(join(w.repo, "edit.txt"));
  const other = join(w.dir, "other");
  mkdirSync(other);
  spawnSync("git", ["-C", other, "init", "-q"], { env: w.env });
  assert.equal(call(w, RUN, ["init", "--repo", other, "--gates", "tests", "--resume"]).json.stop, "no-resume", "another repo");
  call(w, RUN, ["finish", "--dir", d, "--end", "error", "--why", "test"]);
  assert.equal(call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests", "--resume"]).json.stop, "no-resume", "a finished run");
});

test("cleanup removes the run folder only and reports a cleanup path outside it", { skip: !HAS_GIT && "no git" }, (t) => {
  const w = world(t);
  const d = call(w, RUN, ["init", "--repo", w.repo, "--gates", "tests"]).json.dir;
  const outside = join(w.dir, "harness-left");
  mkdirSync(outside);
  call(w, RUN, ["row", "--dir", d], JSON.stringify({ id: "H1", class: "dirty-worktree", status: "fail", cleanup: outside }));
  const r = call(w, RUN, ["cleanup", "--dir", d]);
  assert.deepEqual([r.code, r.json.outside], [0, [outside]]);
  assert.ok(existsSync(outside) && !existsSync(d));
  assert.equal(call(w, RUN, ["init", "--repo", w.repo]).code, 2, "--gates is required");
  assert.equal(call(w, RUN, ["status", "--dir", outside]).json.stop, "not-a-run-folder");
  assert.equal(readFileSync(RUN, "utf8").includes("oh-my-claudecode"), false, "no OMC call");
});
