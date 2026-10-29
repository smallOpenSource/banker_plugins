#!/usr/bin/env node
// Run ledger for /banker:ultra-chain. A run is one folder that holds the chain's artifacts and two files:
// run.json (when, where and from which commit the run started) and events.jsonl (one JSON line per stage
// event). The time of every event is taken here, never written by the model. Pure Node, no dependencies.
//
//   node chain-ledger.mjs init --base <folder> [--runtime claude|codex] [--exclude]
//   node chain-ledger.mjs event <run> --stage <id> --status <status> [--file <event.json>] [--round <n>]
//                               [--summary <text>] [--reason <text>]
//   node chain-ledger.mjs boxes <run> --file <boxes.mjs report> [--stage <id>] [--round <n>]
//                               [--unverified <box,...> --why <text>]
//   node chain-ledger.mjs gates <run> --file <g>/evidence.md --round <k> [--stage <id>]
//                               (ralph-qa's gate-evidence.mjs records of iteration <k>; observed only)
//   node chain-ledger.mjs show <run>
//
// Exit codes: 0 done, 1 a file could not be read or written (a missing or broken --file included),
// 2 a usage error or a rejected event.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGES = [
  { id: "preflight", label: "사전 점검" },
  { id: "research", label: "자료 조사" },
  { id: "interview", label: "모호성 제거" },
  { id: "plan", label: "합의 계획" },
  { id: "mock", label: "목업" },
  { id: "build", label: "구현" },
  { id: "qa", label: "OS 시험과 합의 검증" },
  { id: "visual", label: "시각 검토" },
  { id: "trace", label: "과정 시각화" },
  { id: "share", label: "결과 공유" },
];
export const STAGE_IDS = STAGES.map((s) => s.id);
export const STATUSES = ["started", "done", "failed", "skipped", "stopped", "note"];
const TERMINAL = new Set(["done", "failed", "skipped", "stopped"]);
const NEEDS_REASON = new Set(["failed", "skipped", "stopped"]);
const VERDICTS = ["APPROVE", "ITERATE", "REJECT", "INCONCLUSIVE", "PASS", "FAIL", "STOPPED"];
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class UsageError extends Error {}

// ── values ───────────────────────────────────────────────────────────────────

// A path the report may link to: relative to the run folder, forward slashes, no `..`, no drive or scheme.
export function runPath(p) {
  if (typeof p !== "string" || !p || p.length > 300 || /[\u0000-\u001F]/.test(p)) return null;
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return null;
  const parts = s.split("/").filter((x) => x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || x === "")) return null;
  return parts.join("/");
}

const text = (max) => (v) => (typeof v === "string" && v.length <= max ? v.replace(CONTROL, "") : undefined);
const int = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const num = (lo, hi) => (v) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const oneOf = (...xs) => (v) => (xs.includes(v) ? v : undefined);
const bool = () => (v) => (typeof v === "boolean" ? v : undefined);
const path = () => (v) => runPath(v) ?? undefined;
const COUNT = int(0, 10_000_000);

// Each field: [check, required, what the check wants]. A check returns the cleaned value or undefined.
const RECORDS = {
  artifacts: { max: 50, fields: { label: [text(200), false, "200자 이하 글"], path: [path(), true, "실행 폴더 기준 상대 경로"] } },
  tests: { max: 60, fields: {
    where: [text(100), true, "100자 이하 글"], os: [oneOf("linux", "darwin", "win32", "other"), false, "linux, darwin, win32, other"],
    status: [oneOf("pass", "fail", "unverified"), true, "pass, fail, unverified"], tests: [COUNT, false, "0 이상 정수"],
    pass: [COUNT, false, "0 이상 정수"], fail: [COUNT, false, "0 이상 정수"], skipped: [COUNT, false, "0 이상 정수"],
    note: [text(500), false, "500자 이하 글"], log: [path(), false, "실행 폴더 기준 상대 경로"] } },
  visual: { max: 100, fields: {
    name: [text(100), true, "100자 이하 글"], mock: [path(), false, "실행 폴더 기준 상대 경로"],
    actual: [path(), false, "실행 폴더 기준 상대 경로"], score: [num(0, 100), false, "0~100 수"],
    verdict: [oneOf("pass", "revise", "fail", "unverified"), false, "pass, revise, fail, unverified"], intended: [bool(), false, "true, false"],
    note: [text(500), false, "500자 이하 글"] } },
  checklist: { max: 60, fields: {
    item: [text(300), true, "300자 이하 글"], why: [text(500), false, "500자 이하 글"], ref: [path(), false, "실행 폴더 기준 상대 경로"] } },
  seats: { max: 20, fields: {
    id: [text(60), true, "60자 이하 글"], lens: [text(30), false, "30자 이하 글"], model: [text(100), false, "100자 이하 글"],
    verdict: [oneOf("APPROVE", "ITERATE", "REJECT", "ERROR"), true, "APPROVE, ITERATE, REJECT, ERROR"] } },
};
const EVENT_FIELDS = {
  stage: [oneOf(...STAGE_IDS), true, STAGE_IDS.join(", ")], status: [oneOf(...STATUSES), true, STATUSES.join(", ")],
  summary: [text(4000), false, "4000자 이하 글"], reason: [text(1000), false, "1000자 이하 글"], round: [int(1, 99), false, "1~99 정수"],
};
const VERDICT_FIELDS = {
  by: [text(100), true, "100자 이하 글"], result: [oneOf(...VERDICTS), true, VERDICTS.join(", ")], note: [text(1000), false, "1000자 이하 글"],
};
const EVENT_LISTS = ["artifacts", "tests", "visual", "checklist"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Checks the plain fields of one record; unknown keys are refused so a typo does not vanish silently.
function checkFields(obj, fields, where, extra = []) {
  if (!isObject(obj)) throw new UsageError(`${where}: 객체가 아닙니다`);
  const unknown = Object.keys(obj).filter((k) => !Object.prototype.hasOwnProperty.call(fields, k) && !extra.includes(k));
  if (unknown.length) throw new UsageError(`${where}: 모르는 항목 ${unknown.join(", ")}`);
  const out = {};
  for (const [key, [check, required, want]] of Object.entries(fields)) {
    if (obj[key] === undefined) {
      if (required) throw new UsageError(`${where}.${key}: 꼭 있어야 합니다(${want})`);
      continue;
    }
    const value = check(obj[key]);
    if (value === undefined) throw new UsageError(`${where}.${key}: ${want} 이어야 합니다`);
    out[key] = value;
  }
  return out;
}

function checkList(list, spec, where) {
  if (!Array.isArray(list) || list.length > spec.max) throw new UsageError(`${where}: ${spec.max}개 이하 배열이어야 합니다`);
  return list.map((item, i) => checkFields(item, spec.fields, `${where}[${i}]`));
}

const BLOCKERS = { max: 50, fields: { item: [text(1000), true, "1000자 이하 글"] } };

function checkVerdict(v) {
  const out = checkFields(v, VERDICT_FIELDS, "verdict", ["seats", "blockers"]);
  if (v.seats !== undefined) out.seats = checkList(v.seats, RECORDS.seats, "verdict.seats");
  if (v.blockers !== undefined) {
    if (!Array.isArray(v.blockers)) throw new UsageError("verdict.blockers: 글의 배열이어야 합니다");
    out.blockers = checkList(v.blockers.map((b) => ({ item: b })), BLOCKERS, "verdict.blockers").map((b) => b.item);
  }
  return out;
}

// Validates one event and returns its cleaned copy (paths normalized, control characters removed).
export function checkEvent(raw) {
  const event = checkFields(raw, EVENT_FIELDS, "event", [...EVENT_LISTS, "verdict"]);
  if (NEEDS_REASON.has(event.status) && !event.reason) throw new UsageError(`event.reason: status 가 ${event.status} 이면 이유가 있어야 합니다`);
  for (const key of EVENT_LISTS) {
    if (raw[key] !== undefined) event[key] = checkList(raw[key], RECORDS[key], key);
  }
  if (raw.verdict !== undefined) event.verdict = checkVerdict(raw.verdict);
  return event;
}

// ── run folder ───────────────────────────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const pad = (n) => String(n).padStart(2, "0");

export function runId(now, rand) {
  const d = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${d}-${pad(now.getHours())}${pad(now.getMinutes())}-${rand}`;
}

// Puts the run base into the repo's local exclude file (.git/info/exclude), never into a tracked file.
// Both paths are compared as real paths: git reports the real one (/private/var on macOS) while the base
// may come through a link (/var, a symlinked home, a Windows short name).
function addExclude(root, baseDir) {
  const rel = relative(realpathSync.native(root), realpathSync.native(baseDir)).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("실행 폴더가 저장소 밖이라 제외 파일에 넣지 않았습니다");
  const gitPath = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (!gitPath) return false;
  const file = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
  const line = `/${rel}/`;
  const now = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (now.split(/\r?\n/).includes(line)) return true;
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, `${now && !now.endsWith("\n") ? "\n" : ""}# banker ultra-chain runs\n${line}\n`);
  return true;
}

function repoInfo(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { repo: null, baseCommit: null, branch: null };
  return { repo: root, baseCommit: git(root, ["rev-parse", "--verify", "-q", "HEAD"]), branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) };
}

// Whether git ignores the run folder; with `exclude`, a folder it does not ignore goes to .git/info/exclude.
// A failed write (a read-only .git in a sandbox) is reported in excludeError, not thrown: the run folder
// already exists and the chain can go on.
function ignoreState(root, dir, baseDir, exclude) {
  if (!root) return { ignored: null, excluded: false };
  const ignored = git(root, ["check-ignore", "-q", "--", realpathSync.native(dir)]) !== null;
  if (ignored || !exclude) return { ignored, excluded: false };
  try {
    return { ignored, excluded: addExclude(root, baseDir) };
  } catch (e) {
    return { ignored, excluded: false, excludeError: String(e.code || e.message) };
  }
}

// Folders the stages write into, made up front so a shell redirect into them never fails.
export const RUN_FOLDERS = ["mock/expected", "actual", "visual", "qa", "boxes"];

// Creates <base>/<id>/ with run.json and an empty events.jsonl. opts: base, cwd, runtime, exclude, now, rand.
export function initRun(opts) {
  const o = { cwd: process.cwd(), runtime: null, exclude: false, now: new Date(), rand: randomBytes(2).toString("hex"), ...opts };
  if (!o.base) throw new UsageError("--base 가 필요합니다");
  if (/[\u0000-\u001F]/.test(o.base)) throw new UsageError("--base 에 제어 문자가 있습니다");
  if (o.runtime !== null && !["claude", "codex"].includes(o.runtime)) throw new UsageError("--runtime 은 claude, codex 중 하나입니다");
  const info = repoInfo(o.cwd);
  const baseDir = resolve(o.cwd, o.base);
  const id = runId(o.now, o.rand);
  const dir = join(baseDir, id);
  if (existsSync(dir)) throw new Error(`이미 있는 실행 폴더입니다: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const meta = { schema: 1, id, createdAt: o.now.toISOString(), runtime: o.runtime, ...info };
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(meta, null, 1)}\n`);
  writeFileSync(join(dir, "events.jsonl"), "");
  for (const f of RUN_FOLDERS) mkdirSync(join(dir, f), { recursive: true });
  return { dir, id, ...ignoreState(info.repo, dir, baseDir, o.exclude) };
}

export function readRun(dir) {
  const file = join(dir, "run.json");
  if (!existsSync(file)) throw new Error(`실행 폴더가 아닙니다(run.json 없음): ${dir}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// A cut-off last line (no newline) gets one before the new event, so only the cut line is lost.
function needsNewline(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  return text.length > 0 && !text.endsWith("\n");
}

export function appendEvent(dir, raw, now = new Date()) {
  readRun(dir);
  const event = { t: now.toISOString(), ...checkEvent(raw) };
  const file = join(dir, "events.jsonl");
  appendFileSync(file, `${needsNewline(file) ? "\n" : ""}${JSON.stringify(event)}\n`);
  return event;
}

// Every readable line, in order. A line that is not an event (a cut-off write) is reported, not fatal.
export function readEvents(dir) {
  const file = join(dir, "events.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const events = [];
  const bad = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (typeof e.t !== "string" || !STAGE_IDS.includes(e.stage) || !STATUSES.includes(e.status)) throw new Error("shape");
      events.push(e);
    } catch {
      bad.push(i + 1);
    }
  });
  return { events, bad };
}

// ── summary ──────────────────────────────────────────────────────────────────

// First start and, when the stage has ended, its last end. A stage entered again (a fix loop) keeps its
// first start; it counts as ended only when its latest mark is an ending one.
function stageTimes(mine, last) {
  const first = mine.find((e) => e.status === "started") || mine.find((e) => e.status !== "note");
  const start = first ? first.t : null;
  const end = last && TERMINAL.has(last.status) ? last.t : null;
  return { start, end, ms: start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null };
}

function lastWords(mine) {
  const said = [...mine].reverse().find((e) => e.summary || e.reason);
  if (!said) return null;
  return said.summary || said.reason;
}

// The latest verdict of the stage, with the round it came from: what a resumed run must not lose.
function lastVerdict(mine) {
  const e = [...mine].reverse().find((x) => x.verdict);
  if (!e) return null;
  return { round: e.round ?? null, by: e.verdict.by, result: e.verdict.result, blockers: e.verdict.blockers ?? [] };
}

function stageSummary(stage, events) {
  const mine = events.filter((e) => e.stage === stage.id);
  const last = mine.filter((e) => e.status !== "note").at(-1);
  const numbered = mine.filter((e) => e.round).map((e) => e.round);
  return { id: stage.id, label: stage.label, status: last ? last.status : "pending", ...stageTimes(mine, last),
    rounds: new Set(numbered).size, maxRound: numbered.length ? Math.max(...numbered) : 0, events: mine.length,
    summary: lastWords(mine), lastVerdict: lastVerdict(mine) };
}

const FINISHED = new Set(["done", "skipped"]);

// The run is halted only while its latest mark (not a note) is a stop or a failure: resuming an earlier
// stage afterwards (--from) makes it run again.
function haltedStage(events, stages) {
  const last = events.filter((e) => e.status !== "note").at(-1);
  if (!last || (last.status !== "stopped" && last.status !== "failed")) return null;
  return stages.find((s) => s.id === last.stage);
}

// overall: stopped or failed while the latest mark is one, done when every stage is done or skipped, else
// running. current: the stage to resume from; the halted stage, else the first started stage in chain
// order, else the first stage not done or skipped (one that stopped earlier included).
export function summarize(events) {
  const stages = STAGES.map((s) => stageSummary(s, events));
  const halted = haltedStage(events, stages);
  const current = halted || stages.find((s) => s.status === "started") || stages.find((s) => !FINISHED.has(s.status));
  let overall = "running";
  if (halted) overall = halted.status;
  else if (!current) overall = "done";
  return { overall, current: current ? current.id : null, stages };
}

// ── boxes.mjs report ─────────────────────────────────────────────────────────

const NOT_RUN = new Set([127, 9009, 97]);

function boxStatus(b, s) {
  if (b.stopped) return ["unverified", "중단됨"];
  if (!b.reachable) return ["unverified", b.error ? `접속 실패: ${b.error}` : "접속 실패"];
  if (b.timedOut) return ["fail", "시간 초과"];
  if (NOT_RUN.has(b.exit)) return ["unverified", `시험이 돌지 못함(종료 코드 ${b.exit})`];
  if (b.noTests) return ["unverified", "시험 0건"];
  return tapStatus(b, s);
}

// The TAP count outranks a zero exit: failures are failures, and a run where every test was skipped proved
// nothing on that box.
function tapStatus(b, s) {
  if (s.fail > 0) return ["fail", `시험 실패 ${s.fail}건`];
  if (b.exit !== 0) return ["fail", `종료 코드 ${b.exit}`];
  if (Number.isInteger(s.tests) && s.tests > 0 && s.pass === 0) return ["unverified", "시험이 모두 건너뜀"];
  return ["pass", ""];
}

// The log link survives only when the log lies inside the run folder (boxes.mjs run --out <run>/...).
function boxLog(b, dir) {
  if (typeof b.log !== "string" || !b.log) return null;
  return runPath(relative(dir, resolve(b.log)).split("\\").join("/"));
}

// A box that never answered has nothing to clean up, so only a reachable one can report a failed cleanup.
const cleanupNote = (b) => ((b.reachable || b.stopped) && b.cleaned === false ? "박스 정리 실패" : "");

function boxEntry(b, dir) {
  const s = isObject(b.summary) ? b.summary : {};
  const [status, why] = boxStatus(b, s);
  const failures = Array.isArray(s.failures) ? s.failures.slice(0, 5).map(String) : [];
  const notes = [why, cleanupNote(b), ...failures].filter(Boolean);
  const entry = { where: `box:${String(b.name).slice(0, 90)}`, os: ["linux", "darwin", "win32"].includes(b.os) ? b.os : "other", status };
  for (const k of ["tests", "pass", "fail", "skipped"]) if (Number.isInteger(s[k]) && s[k] >= 0) entry[k] = s[k];
  if (notes.length) entry.note = notes.join("; ").slice(0, 500);
  const log = boxLog(b, dir);
  if (log) entry.log = log;
  return entry;
}

// One tests[] entry per box of a `boxes.mjs run` report.
export function boxesToTests(report, dir) {
  if (!isObject(report) || !Array.isArray(report.boxes)) throw new UsageError("boxes.mjs run 의 출력 JSON 이 아닙니다(boxes 배열 없음)");
  return report.boxes.slice(0, 60).map((b) => boxEntry(isObject(b) ? b : {}, dir));
}

// ── gate-evidence.mjs records ────────────────────────────────────────────────

// ralph-qa's gate-evidence.mjs writes one JSON line per gate run into <g>/evidence.md. Only `observed` lines
// (the runner ran the command and saw its exit) become tests; `reported` lines (what a model said) never do.
const GATE_STATUS = { pass: "pass", fail: "fail", timeout: "fail", misleading: "unverified" };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hostOs = () => (["linux", "darwin", "win32"].includes(process.platform) ? process.platform : "other");

function evidenceLines(text) {
  return String(text).split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(isObject);
}

// The last observed record of each gate in iteration `iter`, the baseline records (iteration 0) and how many
// reported lines that iteration had.
export function observedOf(text, iter) {
  const recs = evidenceLines(text);
  const last = new Map();
  for (const r of recs) if (r.kind === "observed" && r.iter === iter && typeof r.id === "string") last.set(r.id, r);
  return { records: [...last.values()], base: recs.filter((r) => r.kind === "observed" && r.iter === 0),
    reported: recs.filter((r) => r.kind === "reported" && r.iter === iter).length };
}

// The recorded output file as it is now: its text when its sha256 is the recorded one, else why not.
function outputOf(rec) {
  try {
    const buf = readFileSync(String(rec.output));
    return sha256(buf) === rec.outputSha256 ? { text: decodeText(buf) } : { why: "출력 파일 sha256 이 기록과 다름" };
  } catch {
    return { why: "출력 파일을 읽지 못함" };
  }
}

// A failure the baseline had with the same command and signature (gate-evidence.mjs's own rule).
const sameAsBaseline = (rec, base) => base.some((b) => b.id === rec.id && b.verdict !== "pass" && b.cmd === rec.cmd
  && typeof b.signature === "string" && b.signature === rec.signature);

export function gateToTest(rec, out, baseline, log) {
  const status = out.why ? "unverified" : GATE_STATUS[rec.verdict] ?? "unverified";
  const ended = rec.timedOut ? "시간 초과" : rec.exit === null || rec.exit === undefined ? `신호 ${rec.signal}` : `종료 ${rec.exit}`;
  const notes = [`${rec.verdict}${rec.why ? `(${rec.why})` : ""}`, `${String(rec.cmd).slice(0, 200)} ${ended}`,
    baseline ? "기준선과 같은 실패" : "", out.why ?? ""].filter(Boolean);
  return { where: `local:${rec.id}`.slice(0, 100), os: hostOs(), status, note: notes.join("; ").slice(0, 500), log };
}

const fenceFor = (text) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

// The view qa/local-r<k>.md: every record's facts and its output, so the log can be read without the runner.
function gateView(round, entries) {
  const parts = [`# 로컬 게이트 r${round} (gate-evidence.mjs 의 observed 기록, 반복 ${round})`, ""];
  for (const { rec, out, test } of entries) {
    const body = out.text ?? `(${out.why})`;
    const fence = fenceFor(body);
    parts.push(`## ${rec.id}: ${test.status}`, "", `- ${test.note}`, `- 폴더: ${rec.cwd}`, `- 출력: ${rec.output}`,
      `- 출력 sha256: ${rec.outputSha256}`, `- 작업 트리 지문: ${rec.fingerprint}`, "", fence, body.trimEnd(), fence, "");
  }
  return parts.join("\n");
}

// One tests[] entry per gate of iteration `round` from <g>/evidence.md, and the view they link to.
export function gatesToTests(text, round, dir) {
  const { records, base, reported } = observedOf(text, round);
  if (!records.length) throw new UsageError(`반복 ${round} 의 observed 기록이 없습니다(reported ${reported}건은 받지 않음)`);
  const log = `qa/local-r${round}.md`;
  const entries = records.slice(0, 60).map((rec) => {
    const out = outputOf(rec);
    return { rec, out, test: gateToTest(rec, out, sameAsBaseline(rec, base), log) };
  });
  mkdirSync(join(dir, "qa"), { recursive: true });
  writeFileSync(join(dir, log), gateView(round, entries));
  return { tests: entries.map((e) => e.test), reported, baseline: entries.filter((e) => e.test.note.includes("기준선과 같은 실패")).length };
}

// ── command line ─────────────────────────────────────────────────────────────

const FLAGS = new Set(["--base", "--runtime", "--stage", "--status", "--file", "--round", "--summary", "--reason", "--unverified", "--why"]);

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (key === "--exclude") o.exclude = true;
    else if (FLAGS.has(key)) {
      const value = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`${key} 에 값이 없습니다`);
      o[key.slice(2)] = value;
    } else if (a.startsWith("--")) throw new UsageError(`모르는 옵션 ${a}`);
    else o._.push(a);
  }
  return o;
}

// Text of a JSON file whatever wrote it: a UTF-8 BOM is dropped, and UTF-16 (Windows PowerShell 5.1's `>`)
// is decoded.
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file) {
  try {
    return JSON.parse(decodeText(readFileSync(file)));
  } catch (e) {
    throw new Error(`JSON 파일을 읽지 못했습니다(${file}): ${e.message}`);
  }
}

// The event file gives the body; flags may add the plain fields but never contradict the file.
function eventFrom(o) {
  const body = o.file ? readJson(o.file) : {};
  if (!isObject(body)) throw new UsageError("--file 의 JSON 은 객체여야 합니다");
  const flags = { stage: o.stage, status: o.status, summary: o.summary, reason: o.reason, round: o.round && Number(o.round) };
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) continue;
    if (body[k] !== undefined && body[k] !== v) throw new UsageError(`--${k} 와 --file 의 ${k} 가 다릅니다`);
    body[k] = v;
  }
  return body;
}

function runDir(o) {
  if (o._.length !== 2) throw new UsageError("실행 폴더 하나를 주십시오");
  return resolve(o._[1]);
}

// --unverified <box,...>: boxes whose logs show the tests never really ran (no TAP count to tell), recorded as
// unverified with --why from the start, since the ledger only appends.
export function markUnverified(tests, names, why) {
  if (names === undefined) return tests;
  if (!why) throw new UsageError("--unverified 에는 --why <이유> 가 함께 필요합니다");
  const wanted = new Set(String(names).split(",").map((x) => x.trim()).filter(Boolean));
  const known = new Set(tests.map((t) => t.where.replace(/^box:/, "")));
  const unknown = [...wanted].filter((n) => !known.has(n));
  if (unknown.length) throw new UsageError(`보고서에 없는 박스: ${unknown.join(", ")}`);
  return tests.map((t) => (wanted.has(t.where.replace(/^box:/, ""))
    ? { ...t, status: "unverified", note: [why, t.note].filter(Boolean).join("; ").slice(0, 500) } : t));
}

// The line the chain says as a stage starts, ends or records a round, and adds to its resume memo:
// `[ultra-chain] 3/9 합의 계획: ralph-qa ITERATE 2회차`. A record command hands it back as `progress`, so
// saying it needs no words of the model's own.
const PROGRESS_WORD = { started: "시작", done: "끝", failed: "실패", skipped: "건너뜀", stopped: "멈춤", note: "기록" };

// A stage it does not know keeps its own name; a verdict on an end that is not a plain note keeps the
// end's word before it; the line stays one line.
export function progressLine(e) {
  const i = STAGES.findIndex((s) => s.id === e.stage);
  const where = i >= 0 ? `${i}/${STAGES.length - 1} ${STAGES[i].label}` : `?/${STAGES.length - 1} ${e.stage}`;
  const word = PROGRESS_WORD[e.status] ?? String(e.status);
  const verdict = e.verdict ? `${e.verdict.by} ${e.verdict.result}` : "";
  const what = !verdict ? word : e.status === "note" ? verdict : `${word}, ${verdict}`;
  const round = Number.isInteger(e.round) ? ` ${e.round}회차` : "";
  return `[ultra-chain] ${where}: ${what}${round}`.replace(/\s+/g, " ");
}

const withProgress = (e) => ({ ...e, progress: progressLine(e) });

const COMMANDS = {
  init: (o) => initRun({ base: o.base, runtime: o.runtime ?? null, exclude: Boolean(o.exclude) }),
  event: (o) => withProgress(appendEvent(runDir(o), eventFrom(o))),
  boxes: (o) => {
    const dir = runDir(o);
    if (!o.file) throw new UsageError("--file <boxes.mjs run 출력 JSON> 이 필요합니다");
    const report = readJson(o.file);
    const tests = markUnverified(boxesToTests(report, dir), o.unverified, o.why);
    const count = (s) => tests.filter((t) => t.status === s).length;
    const untracked = Number.isInteger(report.untracked) ? `, 보내지 않은 새 파일 ${report.untracked}개` : "";
    const summary = `박스 ${tests.length}대: 통과 ${count("pass")}, 실패 ${count("fail")}, 미검증 ${count("unverified")}${untracked}`;
    return withProgress(appendEvent(dir, { stage: o.stage ?? "qa", status: "note", summary, tests, ...(o.round ? { round: Number(o.round) } : {}) }));
  },
  gates: (o) => {
    const dir = runDir(o);
    if (!o.file || !o.round) throw new UsageError("--file <gate-evidence 의 evidence.md> 와 --round <k> 가 필요합니다");
    const round = Number(o.round);
    if (!Number.isInteger(round) || round < 1 || round > 99) throw new UsageError("--round 는 1~99 정수입니다");
    let text;
    try {
      text = decodeText(readFileSync(o.file));
    } catch (e) {
      throw new Error(`게이트 기록을 읽지 못했습니다(${o.file}): ${e.message}`);
    }
    const { tests, reported, baseline } = gatesToTests(text, round, dir);
    const count = (s) => tests.filter((t) => t.status === s).length;
    const summary = `로컬 게이트 ${tests.length}개: 통과 ${count("pass")}, 실패 ${count("fail")}, 미검증 ${count("unverified")}`
      + `, 기준선과 같은 실패 ${baseline}, 받지 않은 reported ${reported}건`;
    const artifacts = [{ label: `로컬 게이트 r${round}`, path: `qa/local-r${round}.md` }];
    return withProgress(appendEvent(dir, { stage: o.stage ?? "qa", status: "note", round, summary, tests, artifacts }));
  },
  // show is the first command of a resume, so it also re-makes the stage folders an older run may lack.
  show: (o) => {
    const dir = runDir(o);
    const { id } = readRun(dir);
    for (const f of RUN_FOLDERS) mkdirSync(join(dir, f), { recursive: true });
    const { events, bad } = readEvents(dir);
    return { id, dir, ...summarize(events), bad };
  },
};

export function main(argv, out = process.stdout, err = process.stderr) {
  try {
    const o = parseArgs(argv);
    const run = COMMANDS[o._[0]];
    if (!run) throw new UsageError("명령은 init, event, boxes, gates, show 중 하나입니다");
    out.write(`${JSON.stringify(run(o), null, 1)}\n`);
    return 0;
  } catch (e) {
    err.write(`chain-ledger: ${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

// Run as a command, also when reached through a symlinked path: Node resolves
// symlinks for import.meta.url but not for process.argv[1].
const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
