// Tests for chain-report.mjs. Run from the repo root: node --test skills/ultra-chain/references/chain-report.test.mjs
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES, appendEvent, initRun } from "./chain-ledger.mjs";
import { checklistItems, duration, esc, href, main, renderReport, taskText, writeReport } from "./chain-report.mjs";

const tmp = mkdtempSync(join(tmpdir(), "chain-report-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const fresh = () => {
  const d = join(tmp, `cwd${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const sink = () => ({ text: "", write(s) { this.text += s; } });
const RUN = { id: "261013-0900-abcd", createdAt: "2026-10-13T00:00:00.000Z", runtime: "claude", baseCommit: "e3bd1a4f38b5b809", branch: "feat/x" };
const XSS = "<script>alert(1)</script>";
const t = (h) => `2026-10-13T${String(h).padStart(2, "0")}:00:00.000Z`;

const EVENTS = [
  { t: t(0), stage: "preflight", status: "started" },
  { t: t(1), stage: "preflight", status: "done", summary: "OMC 5.7.1, 박스 3대 접속" },
  { t: t(1), stage: "research", status: "done", summary: XSS, artifacts: [{ label: "조사 보고서", path: "01-research.md" }] },
  { t: t(2), stage: "plan", status: "note", round: 1, verdict: { by: "ralph-qa", result: "ITERATE", blockers: ["수용 기준 3 누락"],
    seats: [{ id: "backbone#1", lens: "critic", model: "session", verdict: "APPROVE" }, { id: "backbone-si#3", verdict: "REJECT" }] } },
  { t: t(3), stage: "qa", status: "note", round: 1, tests: [
    { where: "local", os: "linux", status: "pass", tests: 9, pass: 9, fail: 0, skipped: 0 },
    { where: "box:windows", os: "win32", status: "fail", tests: 9, pass: 8, fail: 1, skipped: 0, note: "t1", log: "boxes/r1/windows.log" }] },
  { t: t(4), stage: "visual", status: "note", visual: [{ name: "home", mock: "mock/home.png", actual: "visual/home.png", score: 71, verdict: "revise" }] },
  { t: t(5), stage: "visual", status: "note", visual: [{ name: "home", mock: "mock/home.png", actual: "visual/home 2.png", score: 93, verdict: "pass", intended: true }],
    checklist: [{ item: "버튼 문구 톤", why: "취향", ref: "visual/home 2.png" }, { item: "버튼 문구 톤" }] },
];

test("esc, href and duration", () => {
  assert.equal(esc(`a&<>"'b`), "a&amp;&lt;&gt;&quot;&#39;b");
  assert.equal(esc(null), "");
  assert.equal(href("visual/home 2.png"), "./visual/home%202.png");
  for (const bad of ["../x", "/etc/passwd", "javascript:alert(1)", "C:\\x", ""]) assert.equal(href(bad), null, bad);
  assert.deepEqual([0, 59000, 61000, 3720000].map(duration), ["0초", "59초", "1분 1초", "1시간 2분"]);
  assert.equal(duration(null), "");
});

test("renderReport shows every stage, verdicts, tests, the latest visual pair and a de-duplicated checklist", () => {
  const html = renderReport({ run: RUN, task: `목표 ${XSS}`, events: EVENTS, generatedAt: t(6) });
  for (const s of STAGES) assert.ok(html.includes(`<td>${s.label}</td>`), s.label);
  assert.match(html, /ralph-qa <span class="s s-revise">ITERATE<\/span>/);
  assert.match(html, /<span class="s s-fail">REJECT<\/span>/);
  assert.match(html, /<span class="s s-pass">APPROVE<\/span>/);
  assert.match(html, /수용 기준 3 누락/);
  assert.match(html, /box:windows/);
  assert.match(html, /href="\.\/boxes\/r1\/windows\.log"/);
  assert.match(html, /93점/);
  assert.doesNotMatch(html, /71점/, "a later check of the same view replaces the earlier one");
  assert.match(html, /src="\.\/visual\/home%202\.png"/);
  assert.match(html, /의도한 차이/);
  assert.match(html, /사람이 볼 것 \(1\)/);
  assert.match(html, /href="\.\/01-research\.md"/);
});

test("renderReport escapes all text and links nowhere outside the run folder", () => {
  const hostile = [...EVENTS, { t: t(7), stage: "share", status: "note", artifacts: [{ label: "x", path: "../secret.txt" }, { label: "y", path: "javascript:alert(1)" }] }];
  const html = renderReport({ run: { ...RUN, id: XSS }, task: XSS, events: hostile, bad: [3] });
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.doesNotMatch(html, /href="[^"]*\.\.\//);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i, "no external resource");
  assert.match(html, /읽지 못한 기록 줄: 3/);
});

test("renderReport of an empty ledger: everything pending, nothing to review", () => {
  const html = renderReport({ run: RUN, task: null, events: [] });
  assert.equal((html.match(/class="s s-pending"/g) || []).length, STAGES.length);
  assert.match(html, /사람이 볼 것 \(0\)/);
  assert.match(html, /task\.md 없음/);
});

test("writeReport and the command line write index.html inside the run folder only", () => {
  const { dir } = initRun({ base: "runs", cwd: fresh(), rand: "aaaa" });
  writeFileSync(join(dir, "task.md"), "요청 원문\n");
  appendEvent(dir, { stage: "preflight", status: "started" });
  const file = writeReport(dir);
  assert.equal(file, join(dir, "index.html"));
  assert.match(readFileSync(file, "utf8"), /요청 원문/);
  for (const bad of ["../x.html", "a/b.html", "x.txt", ""]) assert.throws(() => writeReport(dir, bad), /--out/, bad);
  const out = sink();
  assert.equal(main([dir], out, sink()), 0, "the plain form, no --out");
  assert.equal(out.text.trim(), join(dir, "index.html"));
  assert.equal(main([dir, "--out", "report.html"], sink(), sink()), 0);
  assert.equal(main(["--out", "r2.html", dir], sink(), sink()), 0);
  assert.ok(existsSync(join(dir, "report.html")) && existsSync(join(dir, "r2.html")));
  assert.equal(main([], sink(), sink()), 2);
  assert.equal(main([dir, "--out"], sink(), sink()), 2);
  assert.equal(main([fresh()], sink(), sink()), 1);
});

test("two checklist items with the same words but different refs stay two; the page forbids scripts", () => {
  const ev = { t: t(1), stage: "visual", status: "note", checklist: [
    { item: "의도한 차이 확인", ref: "visual/actual-home.png" }, { item: "의도한 차이 확인", ref: "visual/actual-settings.png" },
    { item: "의도한 차이 확인", ref: "visual/actual-home.png" }] };
  const html = renderReport({ run: RUN, task: null, events: [ev] });
  assert.match(html, /사람이 볼 것 \(2\)/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">/);
  const hostile = renderReport({ run: RUN, task: null, events: [{ t: t(2), stage: "qa", status: "note", round: "<img src=x onerror=alert(1)>" }] });
  assert.doesNotMatch(hostile, /<img src=x/);
});

test("checklist items without a ref stay apart when their reasons differ, and merge when they repeat", () => {
  const ev = { t: t(1), stage: "visual", status: "note", checklist: [
    { item: "목업 없음", why: "home" }, { item: "목업 없음", why: "settings" }, { item: "목업 없음", why: "home" }, { item: "목업 없음" }] };
  assert.deepEqual(checklistItems([ev]).map((c) => c.why), ["home", "settings"]);
  assert.equal(checklistItems([{ ...ev, checklist: [{ item: "x" }, { item: "x" }] }]).length, 1);
});

test("the page links only files the run folder holds; a folder, a missing file or a note stays words", () => {
  const { dir } = initRun({ base: "runs", cwd: fresh(), rand: "bbbb" });
  writeFileSync(join(dir, "02-spec.md"), "# spec\n");
  mkdirSync(join(dir, "mock", "expected"), { recursive: true });
  appendEvent(dir, { stage: "plan", status: "done", artifacts: [{ label: "명세", path: "02-spec.md" }, { label: "기대 출력", path: "mock/expected" }],
    checklist: [{ item: "AC-10 해석", ref: "02-spec.md AC-10" }, { item: "명세 확인", ref: "02-spec.md" }] });
  appendEvent(dir, { stage: "qa", status: "note", tests: [{ where: "local", os: "linux", status: "pass", log: "qa/gone.txt" }] });
  appendEvent(dir, { stage: "visual", status: "note", visual: [{ name: "home", mock: "visual/none.png", actual: "visual/none2.png", score: 95, verdict: "pass" }] });
  const html = readFileSync(writeReport(dir), "utf8");
  assert.match(html, /<a href="\.\/02-spec\.md">근거<\/a>/);
  assert.match(html, /근거: 02-spec\.md AC-10/);
  assert.doesNotMatch(html, /href="\.\/02-spec\.md%20AC-10"/);
  assert.doesNotMatch(html, /href="\.\/mock\/expected"/);
  assert.match(html, /기대 출력 <span class="why">\(파일 아님: mock\/expected\)<\/span>/);
  assert.doesNotMatch(html, /qa\/gone\.txt/, "a missing log gets no link");
  assert.match(html, /목업: 없음/);
});

test("task.md's argument line and its task are shown once when they say the same", () => {
  assert.equal(taskText("list 에 --json\nlist 에 --json\n더 할 말"), "list 에 --json\n더 할 말");
  assert.equal(taskText("--auto list 에 --json\nlist 에 --json"), "--auto list 에 --json\nlist 에 --json");
  assert.equal(taskText("한 줄"), "한 줄");
  assert.match(renderReport({ run: RUN, task: "같은 줄\n같은 줄", events: [] }), /<pre class="task">같은 줄<\/pre>/);
});
