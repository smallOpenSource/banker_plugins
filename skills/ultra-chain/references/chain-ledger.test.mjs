// Tests for chain-ledger.mjs. Run from the repo root: node --test skills/ultra-chain/references/chain-ledger.test.mjs
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_FOLDERS, STAGE_IDS, UsageError, appendEvent, boxesToTests, checkEvent, decodeText, gateToTest, initRun, main, markUnverified, observedOf,
  progressLine, readEvents, runId, runPath, summarize,
} from "./chain-ledger.mjs";
import { makeRunFolder } from "../../ralph-qa/references/run-folder.mjs";

const tmp = mkdtempSync(join(tmpdir(), "chain-ledger-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const fresh = (name) => {
  const d = join(tmp, `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const hasGit = spawnSync("git", ["--version"]).status === 0;
const gitIn = (cwd, args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
const repo = (name) => {
  const d = fresh(name);
  gitIn(d, ["init", "-q"]);
  writeFileSync(join(d, "a.txt"), "a\n");
  gitIn(d, ["add", "a.txt"]);
  gitIn(d, ["commit", "-q", "-m", "first"]);
  return d;
};
const at = (iso) => new Date(iso);
const sink = () => ({ text: "", write(s) { this.text += s; } });

test("runPath keeps plain relative paths and refuses anything that leaves the run folder", () => {
  assert.equal(runPath("mock/home.png"), "mock/home.png");
  assert.equal(runPath("mock\\home.png"), "mock/home.png");
  assert.equal(runPath("./a/./b.md"), "a/b.md");
  for (const bad of ["/etc/passwd", "C:\\x.png", "c:x", "http://x/y", "javascript:alert(1)", "../x", "a/../b", "", "a//b", "a/", "a\u0000b", 5, null]) {
    assert.equal(runPath(bad), null, String(bad));
  }
  assert.equal(runPath("x".repeat(301)), null);
});

test("checkEvent accepts a full event and normalizes it", () => {
  const e = checkEvent({
    stage: "qa", status: "note", round: 2, summary: "ok\u0007 done",
    artifacts: [{ label: "plan", path: "plan\\03-plan.md" }],
    tests: [{ where: "box:mac", os: "darwin", status: "pass", tests: 5, pass: 5, fail: 0, skipped: 0, log: "boxes/r2/mac.log" }],
    visual: [{ name: "home", mock: "mock/home.png", actual: "visual/home.png", score: 92.5, verdict: "pass", intended: false }],
    checklist: [{ item: "문구 톤 확인", why: "취향" }],
    verdict: { by: "ralph-qa", result: "ITERATE", seats: [{ id: "backbone#1", lens: "critic", verdict: "APPROVE" }], blockers: ["x"] },
  });
  assert.equal(e.summary, "ok done");
  assert.equal(e.artifacts[0].path, "plan/03-plan.md");
  assert.equal(e.verdict.blockers[0], "x");
  assert.equal(e.visual[0].score, 92.5);
});

test("checkEvent refuses unknown keys, bad values and endings without a reason", () => {
  const bad = [
    { stage: "qa", status: "done", extra: 1 },
    { stage: "nope", status: "done" },
    { stage: "qa", status: "finished" },
    { stage: "qa" },
    { stage: "qa", status: "skipped" },
    { stage: "qa", status: "stopped", reason: "" },
    { stage: "qa", status: "note", round: 0 },
    { stage: "qa", status: "note", artifacts: [{ path: "../x" }] },
    { stage: "qa", status: "note", artifacts: [{ path: "a.md", size: 1 }] },
    { stage: "qa", status: "note", tests: [{ where: "x", status: "ok" }] },
    { stage: "qa", status: "note", visual: [{ name: "x", score: 101 }] },
    { stage: "qa", status: "note", verdict: { by: "x", result: "MAYBE" } },
    { stage: "qa", status: "note", verdict: { by: "x", result: "APPROVE", blockers: "one" } },
    { stage: "qa", status: "note", verdict: { by: "x", result: "APPROVE", seats: [{ id: "s", verdict: "OK" }] } },
    { stage: "qa", status: "note", summary: "x".repeat(4001) },
    [], null, "event",
  ];
  for (const raw of bad) assert.throws(() => checkEvent(raw), UsageError, JSON.stringify(raw));
  assert.equal(checkEvent({ stage: "plan", status: "skipped", reason: "이미 있음" }).reason, "이미 있음");
});

test("runId is date, time and a random part", () => {
  assert.equal(runId(new Date(2026, 9, 13, 7, 5), "ab12"), "261013-0705-ab12");
});

test("initRun outside git makes the folder with run.json and an empty ledger", () => {
  const cwd = fresh("nogit");
  const r = initRun({ base: "runs", cwd, runtime: "codex", now: at("2026-10-13T00:00:00Z"), rand: "0001" });
  const meta = JSON.parse(readFileSync(join(r.dir, "run.json"), "utf8"));
  assert.equal(meta.schema, 1);
  assert.equal(meta.runtime, "codex");
  assert.equal(readFileSync(join(r.dir, "events.jsonl"), "utf8"), "");
  for (const f of RUN_FOLDERS) assert.ok(existsSync(join(r.dir, f)), f);
  assert.equal(r.excluded, false);
  assert.throws(() => initRun({ base: "runs", cwd, now: at("2026-10-13T00:00:00Z"), rand: "0001" }), /이미 있는/);
  assert.throws(() => initRun({ cwd }), UsageError);
  assert.throws(() => initRun({ base: "x", cwd, runtime: "gemini" }), UsageError);
});

test("initRun in a repo records the commit and adds an unignored base to .git/info/exclude once", { skip: !hasGit }, () => {
  const cwd = repo("repo");
  const head = gitIn(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  const r = initRun({ base: ".chain/runs", cwd, exclude: true, rand: "aaaa" });
  const meta = JSON.parse(readFileSync(join(r.dir, "run.json"), "utf8"));
  assert.equal(meta.baseCommit, head);
  assert.equal(meta.branch, "main");
  assert.equal(r.ignored, false);
  assert.equal(r.excluded, true);
  const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.chain\/runs\/$/m);
  const again = initRun({ base: ".chain/runs", cwd, exclude: true, rand: "bbbb" });
  assert.equal(again.ignored, true);
  assert.equal(readFileSync(join(cwd, ".git", "info", "exclude"), "utf8").split("/.chain/runs/").length, 2);
  assert.equal(gitIn(cwd, ["status", "--porcelain"]).stdout, "");
});

test("initRun leaves an already ignored base alone", { skip: !hasGit }, () => {
  const cwd = repo("ignored");
  writeFileSync(join(cwd, ".gitignore"), ".omc/\n");
  const r = initRun({ base: ".omc/ultra-chain", cwd, exclude: true, rand: "cccc" });
  assert.equal(r.ignored, true);
  assert.equal(r.excluded, false);
  const ex = join(cwd, ".git", "info", "exclude");
  assert.ok(!existsSync(ex) || !readFileSync(ex, "utf8").includes("ultra-chain"));
});

test("appendEvent stamps the time; readEvents reports a cut-off line and keeps the rest", () => {
  const { dir } = initRun({ base: "runs", cwd: fresh("append"), rand: "dddd" });
  const e = appendEvent(dir, { stage: "research", status: "started" }, at("2026-10-13T01:00:00Z"));
  assert.equal(e.t, "2026-10-13T01:00:00.000Z");
  writeFileSync(join(dir, "events.jsonl"), `${readFileSync(join(dir, "events.jsonl"), "utf8")}{"t":"x","stage":\n`);
  appendEvent(dir, { stage: "research", status: "done", summary: "보고서" }, at("2026-10-13T01:10:00Z"));
  const { events, bad } = readEvents(dir);
  assert.equal(events.length, 2);
  assert.deepEqual(bad, [2]);
  assert.throws(() => appendEvent(fresh("notrun"), { stage: "qa", status: "done" }), /run\.json/);
});

test("summarize follows the chain: pending, running, skipped, re-entered, stopped and done", () => {
  const ev = (stage, status, t, extra = {}) => ({ t: `2026-10-13T0${t}:00:00.000Z`, stage, status, ...extra });
  assert.equal(summarize([]).current, "preflight");
  const run1 = [ev("preflight", "started", 1), ev("preflight", "done", 2), ev("research", "started", 2)];
  const s1 = summarize(run1);
  assert.equal(s1.overall, "running");
  assert.equal(s1.current, "research");
  assert.equal(s1.stages[0].ms, 3600000);
  const skipped = [...run1, ev("research", "done", 3), ev("interview", "skipped", 3, { reason: "명세 있음" })];
  assert.equal(summarize(skipped).current, "plan");
  const loop = [...skipped, ev("plan", "done", 4), ev("plan", "note", 4, { round: 1, summary: "1회차" }), ev("plan", "started", 5)];
  const s3 = summarize(loop);
  assert.equal(s3.current, "plan");
  assert.equal(s3.stages[3].rounds, 1);
  assert.equal(s3.stages[3].end, null);
  const halted = summarize([...loop, ev("plan", "stopped", 6, { reason: "합의 실패" })]);
  assert.equal(halted.overall, "stopped");
  assert.equal(halted.current, "plan", "a stopped run resumes at the stage that stopped");
  const all = STAGE_IDS.flatMap((id) => [ev(id, "started", 1), ev(id, "done", 2, { summary: `${id} 끝` })]);
  const s4 = summarize(all);
  assert.equal(s4.overall, "done");
  assert.equal(s4.current, null);
  assert.equal(s4.stages[9].summary, "share 끝");
});

test("boxesToTests maps every boxes.mjs outcome to pass, fail or unverified", () => {
  const dir = fresh("boxes");
  const report = { boxes: [
    { name: "mac", os: "darwin", reachable: true, exit: 0, summary: { tests: 3, pass: 3, fail: 0, skipped: 0 }, cleaned: true, log: join(dir, "boxes", "mac.log") },
    { name: "win", os: "win32", reachable: true, exit: 1, summary: { tests: 3, pass: 2, fail: 1, skipped: 0, failures: ["t1"] }, cleaned: false, log: join(tmp, "elsewhere.log") },
    { name: "rocky", os: "linux", reachable: false, error: "Connection timed out" },
    { name: "a", os: "linux", reachable: true, exit: 127 },
    { name: "b", os: "win32", reachable: true, exit: 9009 },
    { name: "c", os: "linux", reachable: true, exit: 97 },
    { name: "d", os: "linux", reachable: true, exit: 0, noTests: true },
    { name: "e", os: "linux", reachable: true, exit: null, timedOut: true },
    { name: "f", os: "beos", reachable: true, exit: 0, stopped: true },
  ] };
  const t = boxesToTests(report, dir);
  assert.deepEqual(t.map((x) => x.status), ["pass", "fail", "unverified", "unverified", "unverified", "unverified", "unverified", "fail", "unverified"]);
  assert.equal(t[0].log, "boxes/mac.log");
  assert.equal(t[1].log, undefined);
  assert.match(t[1].note, /박스 정리 실패; t1/);
  assert.match(t[2].note, /Connection timed out/);
  assert.equal(t[8].os, "other");
  for (const x of t) assert.doesNotThrow(() => checkEvent({ stage: "qa", status: "note", tests: [x] }));
  assert.throws(() => boxesToTests({}, dir), UsageError);
});

test("command line: init, event with a file, boxes, show and the exit codes", () => {
  const cwd = fresh("cli");
  const out = sink();
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(main(["init", "--base", "runs", "--runtime=claude"], out, sink()), 0);
  } finally {
    process.chdir(prev);
  }
  const { dir } = JSON.parse(out.text);
  const file = join(dir, ".event.json");
  writeFileSync(file, JSON.stringify({ summary: "계획 합의", verdict: { by: "ralph-qa", result: "APPROVE" } }));
  assert.equal(main(["event", dir, "--stage", "plan", "--status", "done", "--file", file], sink(), sink()), 0);
  writeFileSync(file, JSON.stringify({ stage: "plan", status: "done" }));
  const err = sink();
  assert.equal(main(["event", dir, "--stage", "mock", "--status", "done", "--file", file], sink(), err), 2);
  assert.match(err.text, /--stage 와 --file/);
  writeFileSync(file, JSON.stringify({ boxes: [{ name: "mac", os: "darwin", reachable: true, exit: 0, summary: { tests: 1, pass: 1, fail: 0, skipped: 0 } }] }));
  assert.equal(main(["boxes", dir, "--file", file, "--round", "1"], sink(), sink()), 0);
  const show = sink();
  assert.equal(main(["show", dir], show, sink()), 0);
  const s = JSON.parse(show.text);
  assert.equal(s.stages.find((x) => x.id === "plan").status, "done");
  assert.equal(s.stages.find((x) => x.id === "qa").rounds, 1);
  assert.equal(main(["show", cwd], sink(), sink()), 1);
  assert.equal(main(["event", dir, "--bogus"], sink(), sink()), 2);
  assert.equal(main(["nope"], sink(), sink()), 2);
  assert.equal(main(["event", dir, "--stage"], sink(), sink()), 2);
});

test("initRun reports a .git/info/exclude it cannot write instead of failing", { skip: !hasGit }, () => {
  const cwd = repo("readonly");
  const exclude = join(cwd, ".git", "info", "exclude");
  rmSync(exclude, { force: true });
  mkdirSync(exclude, { recursive: true });
  const r = initRun({ base: ".chain/runs", cwd, exclude: true, rand: "eeee" });
  assert.ok(existsSync(join(r.dir, "run.json")));
  assert.equal(r.excluded, false);
  assert.ok(r.excludeError, JSON.stringify(r));
});

test("show keeps what a resumed run needs: the last verdict, its blockers and the highest round", () => {
  const ev = (status, extra) => ({ t: "2026-10-13T01:00:00.000Z", stage: "qa", status, ...extra });
  const s = summarize([ev("started", {}), ev("note", { round: 1, verdict: { by: "ralph-qa", result: "ITERATE", blockers: ["AC-3 미충족"] } }),
    ev("note", { round: 2, tests: [] })]);
  const qa = s.stages.find((x) => x.id === "qa");
  assert.equal(qa.maxRound, 2);
  assert.deepEqual(qa.lastVerdict, { round: 1, by: "ralph-qa", result: "ITERATE", blockers: ["AC-3 미충족"] });
  assert.equal(s.stages.find((x) => x.id === "plan").lastVerdict, null);
  assert.equal(checkEvent({ stage: "visual", status: "note", visual: [{ name: "home", verdict: "unverified", note: "Playwright 없음" }] }).visual[0].verdict, "unverified");
});

test("an unreachable box is not also reported as a failed cleanup", () => {
  const [t] = boxesToTests({ boxes: [{ name: "windows", os: "win32", reachable: false, error: "timeout", cleaned: false }] }, fresh("box2"));
  assert.equal(t.status, "unverified");
  assert.doesNotMatch(t.note, /정리 실패/);
});

test("JSON written as UTF-16 (Windows PowerShell 5.1 redirect) or with a BOM is read", () => {
  const json = JSON.stringify({ boxes: [{ name: "mac", os: "darwin", reachable: true, exit: 0, summary: { tests: 1, pass: 1, fail: 0, skipped: 0 } }] });
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")])), json);
  assert.equal(decodeText(Buffer.from(`\ufeff${json}`, "utf8")), json);
  const { dir } = initRun({ base: "runs", cwd: fresh("bom"), rand: "ffff" });
  const file = join(dir, "boxes", "r1.json");
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]));
  assert.equal(main(["boxes", dir, "--file", file, "--round", "1"], sink(), sink()), 0);
  assert.equal(readEvents(dir).events[0].tests[0].status, "pass");
});

test("--unverified records named boxes as unverified with the reason; unknown names and a missing reason are refused", () => {
  const tests = [{ where: "box:mac", os: "darwin", status: "pass" }, { where: "box:win", os: "win32", status: "pass", note: "x" }];
  const out = markUnverified(tests, "win", "시험 수를 셀 수 없고 로그에 실행 흔적 없음");
  assert.deepEqual(out.map((t) => t.status), ["pass", "unverified"]);
  assert.match(out[1].note, /^시험 수를 셀 수 없고 로그에 실행 흔적 없음; x$/);
  assert.equal(markUnverified(tests, undefined, undefined), tests);
  assert.throws(() => markUnverified(tests, "win", ""), UsageError);
  assert.throws(() => markUnverified(tests, "linux", "y"), /보고서에 없는 박스: linux/);
  const { dir } = initRun({ base: "runs", cwd: fresh("unv"), rand: "abab" });
  const file = join(dir, "boxes", "r1.json");
  writeFileSync(file, JSON.stringify({ boxes: [{ name: "win", os: "win32", reachable: true, exit: 0 }] }));
  assert.equal(main(["boxes", dir, "--file", file, "--round", "1", "--unverified", "win", "--why", "jest 출력이라 시험 수 없음"], sink(), sink()), 0);
  assert.equal(readEvents(dir).events[0].tests[0].status, "unverified");
});

test("show re-makes the stage folders a run folder lacks, so a resumed run can write into them", () => {
  const { dir } = initRun({ base: "runs", cwd: fresh("resume"), rand: "cdcd" });
  rmSync(join(dir, "actual"), { recursive: true });
  assert.equal(main(["show", dir], sink(), sink()), 0);
  for (const f of RUN_FOLDERS) assert.ok(existsSync(join(dir, f)), f);
});

test("resuming an earlier stage after a stop runs again; an earlier stop alone does not hold the run", () => {
  const ev = (stage, status, h, extra = {}) => ({ t: `2026-10-13T${String(h).padStart(2, "0")}:00:00.000Z`, stage, status, ...extra });
  const done = (ids, h) => ids.flatMap((id) => [ev(id, "started", h), ev(id, "done", h)]);
  const upToQa = done(["preflight", "research", "interview", "plan", "mock", "build"], 1);
  const qaStopped = [...upToQa, ev("qa", "started", 2), ev("qa", "stopped", 3, { reason: "한도 소진" })];
  assert.equal(summarize(qaStopped).current, "qa");
  const rebuild = summarize([...qaStopped, ev("build", "started", 4)]);
  assert.equal(rebuild.overall, "running");
  assert.equal(rebuild.current, "build");
  const planStopped = [...done(["preflight", "research", "interview"], 1), ev("plan", "started", 2), ev("plan", "stopped", 2, { reason: "무합의" })];
  const later = [...planStopped, ...done(["mock", "build"], 3), ev("qa", "started", 4), ev("qa", "failed", 4, { reason: "x" })];
  assert.deepEqual([summarize(later).overall, summarize(later).current], ["failed", "qa"]);
  const finished = summarize([...later, ev("qa", "done", 5), ...done(["visual", "trace", "share"], 6)]);
  assert.deepEqual([finished.overall, finished.current], ["running", "plan"], "the plan that never finished is still owed");
});

test("the exclude line is written through a linked path, and a base outside the repo is reported", { skip: !hasGit }, (t) => {
  const real = repo("linked");
  const link = join(tmp, `link-${++seq}`);
  try {
    symlinkSync(real, link, "dir");
  } catch {
    t.skip("symlinks not allowed here");
    return;
  }
  const r = initRun({ base: ".chain/runs", cwd: link, exclude: true, rand: "1111" });
  assert.equal(r.excluded, true, JSON.stringify(r));
  assert.match(readFileSync(join(realpathSync(real), ".git", "info", "exclude"), "utf8"), /^\/\.chain\/runs\/$/m);
  const outside = initRun({ base: join(tmp, `outside-${++seq}`), cwd: real, exclude: true, rand: "2222" });
  assert.equal(outside.excluded, false);
  assert.match(outside.excludeError, /저장소 밖/);
  assert.throws(() => initRun({ base: "runs\nfoo", cwd: real }), UsageError);
});

test("box results follow the TAP count: failures fail, all-skipped is unverified, a stopped box says so", () => {
  const dir = fresh("tap");
  const [failed, skipped, stopped] = boxesToTests({ boxes: [
    { name: "a", os: "linux", reachable: true, exit: 0, summary: { tests: 3, pass: 2, fail: 1, skipped: 0 } },
    { name: "b", os: "win32", reachable: true, exit: 0, summary: { tests: 2, pass: 0, fail: 0, skipped: 2 } },
    { name: "c", os: "darwin", reachable: false, stopped: true, cleaned: false },
  ] }, dir);
  assert.deepEqual([failed.status, skipped.status, stopped.status], ["fail", "unverified", "unverified"]);
  assert.match(failed.note, /시험 실패 1건/);
  assert.match(skipped.note, /모두 건너뜀/);
  assert.match(stopped.note, /^중단됨; 박스 정리 실패/);
});

test("a cut-off last line loses only itself; unknown keys named like Object members are refused; a bad --file exits 1", () => {
  const { dir } = initRun({ base: "runs", cwd: fresh("cut"), rand: "3333" });
  writeFileSync(join(dir, "events.jsonl"), '{"t":"2026-10-13T00:00:00.000Z","stage":"plan","sta');
  appendEvent(dir, { stage: "research", status: "done", summary: "살아남음" });
  const { events, bad } = readEvents(dir);
  assert.deepEqual([events.length, events[0].summary, bad], [1, "살아남음", [1]]);
  for (const raw of ['{"stage":"qa","status":"note","constructor":1}', '{"stage":"qa","status":"note","__proto__":{"x":1}}']) {
    assert.throws(() => checkEvent(JSON.parse(raw)), UsageError, raw);
  }
  assert.equal(main(["boxes", dir, "--file", join(dir, "nope.json")], sink(), sink()), 1);
  const file = join(dir, "boxes", "r9.json");
  writeFileSync(file, JSON.stringify({ untracked: 2, boxes: [{ name: "m", os: "darwin", reachable: true, exit: 0 }] }));
  const out = sink();
  assert.equal(main(["boxes", dir, "--file", file, "--round", "9"], out, sink()), 0);
  assert.match(JSON.parse(out.text).summary, /보내지 않은 새 파일 2개/);
  assert.equal(JSON.parse(out.text).progress, "[ultra-chain] 6/9 OS 시험과 합의 검증: 기록 9회차");
});

test("a record command hands back the progress line to say and to add to the resume memo", () => {
  assert.equal(progressLine({ stage: "preflight", status: "started" }), "[ultra-chain] 0/9 사전 점검: 시작");
  assert.equal(progressLine({ stage: "plan", status: "note", round: 2, verdict: { by: "ralph-qa", result: "ITERATE" } }), "[ultra-chain] 3/9 합의 계획: ralph-qa ITERATE 2회차");
  assert.equal(progressLine({ stage: "share", status: "done" }), "[ultra-chain] 9/9 결과 공유: 끝");
  const { dir } = initRun({ base: "runs", cwd: fresh("progress"), rand: "pppp" });
  const out = { text: "", write(s) { this.text += s; } };
  assert.equal(main(["event", dir, "--stage", "research", "--status", "started"], out, { write() {} }), 0);
  assert.equal(JSON.parse(out.text).progress, "[ultra-chain] 1/9 자료 조사: 시작");
  assert.ok(!readFileSync(join(dir, "events.jsonl"), "utf8").includes("progress"), "the ledger keeps no copy of it");
});

test("the progress line stays one line and names the stage it cannot place, and a failed verdict keeps its word", () => {
  assert.equal(progressLine({ stage: "nope", status: "done" }), "[ultra-chain] ?/9 nope: 끝");
  assert.equal(progressLine({ stage: "qa", status: "failed", verdict: { by: "ralph\nqa", result: "REJECT" } }), "[ultra-chain] 6/9 OS 시험과 합의 검증: 실패, ralph qa REJECT");
});

// S15: ultra-chain's local gates run through ralph-qa's gate-evidence.mjs; the ledger reads its records.
const sha = (s) => createHash("sha256").update(s).digest("hex");
function evidenceFixture(name) {
  const g = fresh(name);
  const out = (file, text) => (writeFileSync(join(g, file), text), { output: join(g, file), outputSha256: sha(text) });
  const base = { kind: "observed", id: "lint", iter: 0, cmd: "npm run lint", verdict: "fail", exit: 1, signature: "lint:aaaa", ...out("gate-lint-0-1.md", "x\n") };
  const lint = { kind: "observed", id: "lint", iter: 2, cmd: "npm run lint", cwd: "/repo", verdict: "fail", why: "종료 1", exit: 1, signature: "lint:aaaa", fingerprint: "f1", ...out("gate-lint-2-2.md", "error: no-unused\n") };
  const testsOld = { kind: "observed", id: "tests", iter: 2, cmd: "npm test", verdict: "fail", exit: 1, signature: "tests:bbbb", ...out("gate-tests-2-3.md", "not ok 1\n") };
  const tests = { kind: "observed", id: "tests", iter: 2, cmd: "npm test", cwd: "/repo", verdict: "pass", why: null, exit: 0, signature: null, fingerprint: "f1", ...out("gate-tests-2-4.md", "ok 1 ```x```\n") };
  const typecheck = { kind: "observed", id: "typecheck", iter: 2, cmd: "tsc", verdict: "misleading", why: "node:test 건너뜀", exit: 0, ...out("gate-typecheck-2-5.md", "ℹ skipped 1\n") };
  const build = { kind: "observed", id: "build", iter: 2, cmd: "npm run build", verdict: "pass", exit: 0, ...out("gate-build-2-6.md", "built\n") };
  writeFileSync(join(g, "gate-build-2-6.md"), "changed after the run\n");
  const said = { kind: "reported", id: "scenario-1", iter: 2, exit: 0, text: "모델이 통과라고 함" };
  const lines = [base, lint, testsOld, tests, typecheck, build, said].map((r) => JSON.stringify(r));
  writeFileSync(join(g, "evidence.md"), `${lines.join("\n")}\nnot json\n`);
  return g;
}

test("gates: observed records of the round become tests with their verdict; reported lines never do", () => {
  const g = evidenceFixture("gates");
  const { dir } = initRun({ base: "runs", cwd: fresh("gates-run"), rand: "gggg" });
  const out = sink();
  assert.equal(main(["gates", dir, "--file", join(g, "evidence.md"), "--round", "2"], out, sink()), 0);
  const e = JSON.parse(out.text);
  const by = Object.fromEntries(e.tests.map((t) => [t.where, t]));
  assert.deepEqual(Object.keys(by).sort(), ["local:build", "local:lint", "local:tests", "local:typecheck"], "the reported scenario-1 line is not a test");
  assert.equal(by["local:tests"].status, "pass", "the last record of a gate in the round wins");
  assert.equal(by["local:lint"].status, "fail");
  assert.match(by["local:lint"].note, /기준선과 같은 실패/);
  assert.equal(by["local:typecheck"].status, "unverified", "misleading output is not a pass");
  assert.equal(by["local:build"].status, "unverified");
  assert.match(by["local:build"].note, /sha256 이 기록과 다름/);
  assert.ok(e.tests.every((t) => t.log === "qa/local-r2.md"));
  assert.match(e.summary, /받지 않은 reported 1건/);
  assert.equal(e.progress, "[ultra-chain] 6/9 OS 시험과 합의 검증: 기록 2회차");
  const view = readFileSync(join(dir, "qa", "local-r2.md"), "utf8");
  assert.match(view, /error: no-unused/);
  assert.match(view, /````\nok 1 ```x```\n````/, "a fence longer than the output's own backticks");
  assert.equal(readEvents(dir).events.at(-1).artifacts[0].path, "qa/local-r2.md");
});

test("gates: a round with only reported lines, a missing file or a bad round is refused", () => {
  const g = evidenceFixture("gates-bad");
  const { dir } = initRun({ base: "runs", cwd: fresh("gates-bad-run"), rand: "hhhh" });
  const err = sink();
  writeFileSync(join(g, "only-said.md"), `${JSON.stringify({ kind: "reported", id: "tests", iter: 3, exit: 0 })}\n`);
  assert.equal(main(["gates", dir, "--file", join(g, "only-said.md"), "--round", "3"], sink(), err), 2);
  assert.match(err.text, /observed 기록이 없습니다\(reported 1건은 받지 않음\)/);
  assert.equal(main(["gates", dir, "--file", join(g, "nope.md"), "--round", "2"], sink(), sink()), 1);
  assert.equal(main(["gates", dir, "--file", join(g, "evidence.md")], sink(), sink()), 2);
  assert.equal(main(["gates", dir, "--file", join(g, "evidence.md"), "--round", "0"], sink(), sink()), 2);
  assert.equal(readEvents(dir).events.length, 0, "nothing was recorded");
});

// S11 Q3: the view is shared in stage 9; a record naming a file outside the gate folder never brings it in.
test("gates: an output file outside the gate folder is not read into the view, even with its sha256 right", () => {
  const g = fresh("gates-outside");
  const away = join(fresh("gates-outside-away"), "secret.md");
  writeFileSync(away, "SECRET-OUTSIDE\n");
  writeFileSync(join(g, "evidence.md"), `${JSON.stringify({ kind: "observed", id: "tests", iter: 1, cmd: "npm test", verdict: "pass", exit: 0, output: away, outputSha256: sha("SECRET-OUTSIDE\n") })}\n`);
  const { dir } = initRun({ base: "runs", cwd: fresh("gates-outside-run"), rand: "oooo" });
  const out = sink();
  assert.equal(main(["gates", dir, "--file", join(g, "evidence.md"), "--round", "1"], out, sink()), 0);
  const e = JSON.parse(out.text);
  assert.deepEqual([e.tests[0].status, /게이트 기록 폴더 밖/.test(e.tests[0].note)], ["unverified", true]);
  assert.doesNotMatch(readFileSync(join(dir, "qa", "local-r1.md"), "utf8"), /SECRET-OUTSIDE/);
});

test("observedOf keeps the baseline apart and gateToTest reads a timeout as a failure", () => {
  const { records, base, reported } = observedOf(readFileSync(join(evidenceFixture("observed"), "evidence.md"), "utf8"), 2);
  assert.deepEqual([records.length, base.length, reported], [4, 1, 1]);
  const t = gateToTest({ id: "tests", cmd: "npm test", verdict: "timeout", timedOut: true }, { text: "" }, false, "qa/local-r1.md");
  assert.deepEqual([t.status, /시간 초과/.test(t.note)], ["fail", true]);
});

test("a ralph-qa end word with its cause keeps the word before the parenthesis as result and the cause in note", () => {
  const e = checkEvent({ stage: "qa", status: "note", round: 3, verdict: { by: "ralph-qa", result: "ITERATE", note: "ITERATE(한도 소진, 원인 gate) 게이트(관측): tests = fail" } });
  assert.equal(e.verdict.result, "ITERATE");
  assert.match(e.verdict.note, /원인 gate/);
  assert.throws(() => checkEvent({ stage: "qa", status: "note", verdict: { by: "ralph-qa", result: "ITERATE(한도 소진, 원인 gate)" } }), UsageError);
  const { dir } = initRun({ base: "runs", cwd: fresh("cause"), rand: "cccc" });
  appendEvent(dir, e);
  assert.equal(summarize(readEvents(dir).events).stages.find((s) => s.id === "qa").lastVerdict.result, "ITERATE");
});

test("gates reads what ralph-qa's real gate-evidence.mjs writes: an observed pass and a reported line", () => {
  const root = realpathSync.native(fresh("real-gates"));
  const home = join(root, "home");
  const base = process.platform === "win32" ? join(home, "AppData", "Local", "Temp") : join(root, "run");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    ...(process.platform === "win32" ? { TEMP: base, TMP: base } : process.platform === "darwin" ? { TMPDIR: base } : { XDG_RUNTIME_DIR: base }) };
  const g = makeRunFolder({ env, platform: process.platform }, "ralph-qa").dir;
  const tool = fileURLToPath(new URL("../../ralph-qa/references/gate-evidence.mjs", import.meta.url));
  const q = (s) => (process.platform === "win32" ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`);
  const cmd = `${process.platform === "win32" ? "& " : ""}${[process.execPath, "-e", "console.log('ok 1 - real')"].map(q).join(" ")}`;
  const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", env, timeout: 120000 });
  const r = run(["run", "--dir", g, "--id", "tests", "--cmd", cmd, "--timeout", "60", "--iter", "1", "--cwd", root]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run(["note", "--dir", g, "--id", "tests", "--iter", "1", "--exit", "0", "--text", "model says pass"]).status, 0);
  const { dir } = initRun({ base: "runs", cwd: fresh("real-gates-run"), rand: "rrrr" });
  const out = sink();
  assert.equal(main(["gates", dir, "--file", join(g, "evidence.md"), "--round", "1"], out, sink()), 0);
  const e = JSON.parse(out.text);
  assert.deepEqual(e.tests.map((x) => [x.where, x.status]), [["local:tests", "pass"]]);
  assert.match(e.summary, /받지 않은 reported 1건/);
  assert.match(readFileSync(join(dir, "qa", "local-r1.md"), "utf8"), /ok 1 - real/);
});
