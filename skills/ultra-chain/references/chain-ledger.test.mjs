// Tests for chain-ledger.mjs. Run from the repo root: node --test skills/ultra-chain/references/chain-ledger.test.mjs
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUN_FOLDERS, STAGE_IDS, UsageError, appendEvent, boxesToTests, checkEvent, decodeText, initRun, main, markUnverified, readEvents, runId, runPath,
  summarize,
} from "./chain-ledger.mjs";

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
});
