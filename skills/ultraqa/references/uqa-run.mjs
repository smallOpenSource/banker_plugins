#!/usr/bin/env node
/**
 * uqa-run: the run folder and the machine checks of banker's ultraqa (Claude Code only). The model plans, fixes and
 * writes; this program keeps the state as data and says when COMPLETE may be claimed.
 *
 *   node uqa-run.mjs init --repo <repo> --gates <a,b,...> [--resume]
 *        a new run folder (run-folder.mjs) with state.md, or with --resume the unfinished run of the same repo (by real
 *        path) whose HEAD and work tree fingerprint are still the same
 *   node uqa-run.mjs row --dir <d>            one scenario row (JSON on stdin) into matrix.md, by its id
 *   node uqa-run.mjs status --dir <d>         same-failure, max-cycles, matrix-incomplete, stale-evidence, gates
 *   node uqa-run.mjs finish --dir <d> --end complete|max-cycles|same-failure|blocked|error [--why <text>]
 *        the end line; complete only when status allows it, max-cycles and same-failure only when status says so
 *   node uqa-run.mjs report --dir <d>         the report skeleton (markdown): observed and reported apart
 *   node uqa-run.mjs cleanup --dir <d>        that run folder alone; paths the matrix names outside it are reported only
 *
 * The gate commands run through gate-evidence.mjs (`run --iter <cycle>`), in the same folder. Out: JSON on stdout
 * (report: markdown); exit 0 done, 1 a check that does not hold, 2 usage or internal error, 3 a stop.
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSES, gateConjunct, readEvidence, repeatedFailures } from "./gate-evidence.mjs";
import { Stop, bases, makeRunFolder, removeRunFolder, requireGitTree, runFolder, snapshot } from "./run-folder.mjs";

const KIND = ["ultraqa"];
export const MAX_CYCLES = 5;
const STATUSES = ["pass", "fail", "blocked", "excluded"];
const ROW_KEYS = ["id", "class", "intent", "model", "setup", "command", "expected", "status", "evidenceRef", "excludeReason", "cleanup"];
const END_LINES = {
  complete: (n) => `ULTRAQA COMPLETE: Goal met after ${n} cycles`,
  "max-cycles": () => "ULTRAQA STOPPED: Max cycles",
  "same-failure": () => "ULTRAQA STOPPED: Same failure detected 3 times",
  blocked: (_n, why) => `ULTRAQA BLOCKED: ${why}`,
  error: (_n, why) => `ULTRAQA ERROR: ${why}`,
};

class Usage extends Error {}
const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const readState = (d) => {
  const s = readJson(join(d, "state.md"), null);
  if (!s) throw new Stop("no-state", `state.md 가 없거나 읽을 수 없다: ${d}`);
  return s;
};
const writeState = (d, s) => writeFileSync(join(d, "state.md"), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
export function readMatrix(d) {
  let text = "";
  try {
    text = readFileSync(join(d, "matrix.md"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const realRepo = (repo) => {
  try {
    return realpathSync.native(resolve(repo));
  } catch {
    throw new Stop("no-repo", `저장소 폴더가 없다: ${repo}`);
  }
};
const gatesOf = (v) => String(v || "").split(",").map((g) => g.trim()).filter(Boolean);

// ---- the checks (pure)

// A passed row rests on a scenario record of this cycle that passed and is that scenario's last record of the cycle:
// observed, its id scenario-*, verdict pass. A goal gate's record, a failed one, one of an earlier cycle or a pass a
// rerun of the same scenario has since failed is no ground for it (staleCheck adds the tree).
function restsOn(r, observed, cycle) {
  const rec = Number.isInteger(r.evidenceRef) ? observed.find((x) => x.seq === r.evidenceRef) : null;
  if (!rec || !String(rec.id).startsWith("scenario-") || rec.verdict !== "pass" || rec.iter !== cycle) return false;
  return observed.filter((x) => x.id === rec.id && x.iter === cycle).pop() === rec;
}

// The record numbers two or more passed rows cite: one scenario run covers one row, never several classes at once.
const sharedRefs = (rows) => {
  const seen = new Map();
  for (const r of rows.filter((x) => x.status === "pass")) seen.set(r.evidenceRef, (seen.get(r.evidenceRef) || 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([ref]) => ref));
};

// The matrix: every class has a row or is excluded with a reason; a row's status is one of four; a passed row names
// the passing scenario record of this cycle it rests on, a record no other passed row cites; a failed or blocked row
// is still open.
export function matrixCheck(rows, evidence = [], cycle = 0) {
  const observed = evidence.filter((r) => r?.kind === "observed");
  const missing = CLASSES.map(([id]) => id).filter((c) => !rows.some((r) => r.class === c && (r.status !== "excluded" || String(r.excludeReason || "").trim())));
  const shared = sharedRefs(rows);
  const bad = rows.filter((r) => !STATUSES.includes(r.status) || (r.status === "pass" && (shared.has(r.evidenceRef) || !restsOn(r, observed, cycle)))).map((r) => r.id);
  const open = rows.filter((r) => r.status === "fail" || r.status === "blocked").map((r) => r.id);
  return { ok: rows.length > 0 && !missing.length && !bad.length && !open.length, missing, bad, open };
}

// Each goal gate's last observed record, and each record a passed row rests on, was made on the tree as it is now.
export function staleCheck(evidence, gates, rows, fingerprint) {
  const observed = evidence.filter((r) => r.kind === "observed");
  const last = gates.map((g) => observed.filter((r) => r.id === g).pop()).filter(Boolean);
  const cited = rows.filter((r) => r.status === "pass").map((r) => observed.find((x) => x.seq === r.evidenceRef) || { seq: r.evidenceRef, fingerprint: null });
  const stale = [...last, ...cited].filter((r) => r.fingerprint !== fingerprint).map((r) => r.seq);
  return { ok: stale.length === 0 && last.length === gates.length, stale, unrun: gates.filter((g) => !observed.some((r) => r.id === g)) };
}

// The goal gates as records: `interactive` is the drive scripts' scenario-* records (references/tmux-drive.md), as
// ralph-qa's `scenarios` is; with none it stays `interactive` (never run).
export function goalGates(gates, evidence) {
  const scenarios = [...new Set(evidence.filter((r) => r?.kind === "observed" && String(r.id).startsWith("scenario-")).map((r) => r.id))];
  return gates.flatMap((g) => (g !== "interactive" ? [g] : scenarios.length ? scenarios : [g]));
}

export function statusOf({ evidence, rows, gates, fingerprint }) {
  const observed = evidence.filter((r) => r.kind === "observed");
  const cycle = Math.max(0, ...observed.map((r) => r.iter));
  const same = repeatedFailures(evidence);
  const goal = goalGates(gates, evidence);
  const checks = {
    sameFailure: { ok: same.length === 0, signatures: same },
    maxCycles: { ok: cycle <= MAX_CYCLES, cycle, max: MAX_CYCLES },
    matrix: matrixCheck(rows, evidence, cycle),
    staleEvidence: staleCheck(evidence, goal, rows, fingerprint),
    gates: gateConjunct(evidence, goal, fingerprint, cycle),
  };
  const complete = Object.values(checks).every((c) => c.ok);
  return { complete, cycle, checks, next: nextLine(complete, checks, cycle) };
}

function nextLine(complete, checks, cycle) {
  if (complete) return END_LINES.complete(cycle);
  if (!checks.sameFailure.ok) return END_LINES["same-failure"]();
  return cycle >= MAX_CYCLES ? END_LINES["max-cycles"]() : null;
}

// Whether `end` may be claimed with this status: COMPLETE only when every check holds; the two STOPPED lines only
// when status says so; BLOCKED and ERROR need a reason.
const needsWhy = (_st, why) => (String(why || "").trim() ? null : "--why 가 필요하다");
const END_RULES = {
  complete: (st) => (st.complete ? null : `COMPLETE 를 거부한다: ${Object.entries(st.checks).filter(([, c]) => !c.ok).map(([k]) => k).join(", ")}`),
  "same-failure": (st) => (st.checks.sameFailure.ok ? "같은 실패 3회가 기록에 없다" : null),
  "max-cycles": (st) => (st.cycle >= MAX_CYCLES ? null : `순환이 ${st.cycle} 번이라 아직 한도가 아니다`),
  blocked: needsWhy,
  error: needsWhy,
};
export function endAllowed(end, st, why) {
  return Object.prototype.hasOwnProperty.call(END_RULES, end) ? END_RULES[end](st, why) : `모르는 종료다: ${end}`;
}

// ---- commands

async function current(d, ctx) {
  const state = readState(d);
  const evidence = readEvidence(d);
  const snap = await snapshot(state.repo, ctx.env);
  return { state, evidence, rows: readMatrix(d), fingerprint: snap.fingerprint, head: snap.head };
}

async function init(o, ctx) {
  const repo = realRepo(o.repo);
  const gates = gatesOf(o.gates);
  if (!gates.length) throw new Usage("--gates 에 목표 게이트를 하나 이상 준다(tests, build, lint, typecheck, custom, interactive)");
  requireGitTree(repo, ctx.env);
  if (o.resume) return resume(repo, ctx);
  const snap = await snapshot(repo, ctx.env);
  const { dir } = makeRunFolder(ctx, "ultraqa");
  const state = { repo, gates, head: snap.head, fingerprint: snap.fingerprint, startedAt: new Date().toISOString(), finished: null };
  writeState(dir, state);
  writeFileSync(join(dir, "matrix.md"), "", { mode: 0o600 });
  return [{ ok: true, dir, resumed: false, ...state }, 0];
}

// The unfinished runs of this repo under the known bases, newest first.
function unfinished(repo, ctx) {
  const found = [];
  for (const base of bases(ctx).known) {
    let names = [];
    try {
      names = readdirSync(base).filter((n) => /^ultraqa\.[A-Za-z0-9]+$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const { d } = runFolder(join(base, n), ctx, KIND);
        const s = readState(d);
        if (s.repo === repo && !s.finished) found.push({ d, s, at: statSync(join(d, "state.md")).mtimeMs });
      } catch {
        /* not a run folder of this account, or no state */
      }
    }
  }
  return found.sort((a, b) => b.at - a.at);
}

// Resumed only when the repo's HEAD and work tree are what the run last saw (its last observed record, else init).
async function resume(repo, ctx) {
  const runs = unfinished(repo, ctx);
  if (!runs.length) throw new Stop("no-resume", `이어 갈 끝나지 않은 실행이 없다: ${repo}`);
  const { d, s } = runs[0];
  const snap = await snapshot(repo, ctx.env);
  const lastSeen = readEvidence(d).filter((r) => r.kind === "observed").pop()?.fingerprint || s.fingerprint;
  if (snap.head !== s.head || snap.fingerprint !== lastSeen) {
    throw new Stop("no-resume", `HEAD 나 작업 트리가 그 실행이 마지막에 본 것과 다르다. 새로 시작한다: ${d}`);
  }
  const st = statusOf({ evidence: readEvidence(d), rows: readMatrix(d), gates: s.gates, fingerprint: snap.fingerprint });
  return [{ ok: true, dir: d, resumed: true, cycle: st.cycle, nextCycle: st.cycle + 1, ...s }, 0];
}

function row(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KIND);
  const r = JSON.parse(String(ctx.stdin()).trim() || "null");
  if (!r || typeof r !== "object" || !/^[A-Za-z0-9._-]{1,64}$/.test(String(r.id))) throw new Usage("행은 id(영숫자, . _ - 64자까지)가 있는 JSON 객체다");
  if (!CLASSES.some(([c]) => c === r.class) && r.class !== "normal") throw new Usage(`class 는 9분류의 id 나 normal 이다: ${String(r.class).slice(0, 40)}`);
  if (!STATUSES.includes(r.status)) throw new Usage(`status 는 ${STATUSES.join(", ")} 가운데 하나다`);
  const clean = Object.fromEntries(ROW_KEYS.filter((k) => k in r).map((k) => [k, r[k]]));
  const rows = readMatrix(d).filter((x) => x.id !== clean.id).concat(clean);
  writeFileSync(join(d, "matrix.md"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  return [{ ok: true, rows: rows.length, row: clean }, 0];
}

async function status(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KIND);
  const c = await current(d, ctx);
  const st = statusOf({ evidence: c.evidence, rows: c.rows, gates: c.state.gates, fingerprint: c.fingerprint });
  return [{ ok: true, ...st, finished: c.state.finished }, st.complete ? 0 : 1];
}

async function finish(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KIND);
  const c = await current(d, ctx);
  const st = statusOf({ evidence: c.evidence, rows: c.rows, gates: c.state.gates, fingerprint: c.fingerprint });
  const refused = endAllowed(o.end, st, o.why);
  if (refused) return [{ ok: false, refused, next: st.next, checks: st.checks }, 1];
  const line = END_LINES[o.end](st.cycle, String(o.why || "").trim());
  writeState(d, { ...c.state, finished: { end: o.end, line, at: new Date().toISOString() } });
  return [{ ok: true, line }, 0];
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 200);

// The report skeleton: the parts the program knows are filled, the rest the model writes. Observed and reported apart.
export function reportOf({ state, evidence, rows, st }) {
  const observed = evidence.filter((r) => r.kind === "observed");
  const reported = evidence.filter((r) => r.kind === "reported");
  return [
    "# UltraQA 보고서", "", "## 목표와 성공 기준", `- 목표 게이트: ${state.gates.join(", ")}`, "- 성공 기준: (모델이 씀)", "- 종료 조건: COMPLETE, 순환 5회, 같은 실패 3회, 안전 경계, 환경 오류",
    "- 적용한 안전 경계: (모델이 씀)", "", "## 시나리오 행렬",
    "| ID | 분류 | 사용자/공격자 모델 | 시나리오 | 명령/하네스 | 기대 신호 | 상태 | 증거(기록 번호) | 정리 |", "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${[r.id, r.class, r.model, r.intent, r.command, r.expected, r.status, r.evidenceRef ?? cell(r.excludeReason), r.cleanup].map(cell).join(" | ")} |`),
    "", "## 실행한 명령(관측)", ...observed.map((r) => `- [${r.exit ?? r.signal ?? "-"}] \`${cell(r.cmd)}\` 순환 ${r.iter}, ${r.secs}s/${r.timeout}s, ${r.verdict}${r.why ? `(${r.why})` : ""}, 출력 sha256 ${String(r.outputSha256).slice(0, 12)}`),
    "", "## 신고(판정에 쓰지 않음)", ...(reported.length ? reported.map((r) => `- ${r.id} 순환 ${r.iter}: ${cell(r.text)}`) : ["- 없음"]),
    "", "## 찾은 실패", "- (모델이 씀: 시나리오 ID, 실패 신호, 근본 원인, 사용자 영향, 안전 영향)", "", "## 적용한 고침", "- (모델이 씀: 바꾼 파일, 까닭, 연결된 시나리오, 회귀 증거)",
    "", "## 정리와 되돌림", "- (cleanup 결과와 작업 트리 전후)", "", "## 남은 위험", ...rows.filter((r) => r.status !== "pass").map((r) => `- ${r.id}: ${r.status} ${cell(r.excludeReason)}`),
    "", "## 기계 판정", `- 순환 ${st.cycle}/${MAX_CYCLES}, COMPLETE ${st.complete ? "허용" : "거부"}${st.next ? `, 다음 줄: ${st.next}` : ""}`,
    ...Object.entries(st.checks).map(([k, c]) => `- ${k}: ${c.ok ? "통과" : "실패"}`), "",
  ].join("\n");
}

async function report(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KIND);
  const c = await current(d, ctx);
  const st = statusOf({ evidence: c.evidence, rows: c.rows, gates: c.state.gates, fingerprint: c.fingerprint });
  return [{ markdown: reportOf({ ...c, st }) }, 0];
}

// The run folder alone. A path a row's cleanup names outside it is reported, never removed.
function cleanup(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KIND);
  const outside = readMatrix(d).map((r) => r.cleanup).filter((p) => typeof p === "string" && p.trim() && !resolve(d, p).startsWith(d + sep));
  const done = removeRunFolder(d, ctx, KIND);
  return [{ ok: true, ...done, outside }, 0];
}

const FLAGS = { init: ["repo", "gates", "resume!"], row: ["dir"], status: ["dir"], finish: ["dir", "end", "why"], report: ["dir"], cleanup: ["dir"] };
const REQUIRED = { init: ["repo", "gates"], row: ["dir"], status: ["dir"], finish: ["dir", "end"], report: ["dir"], cleanup: ["dir"] };

function readFlag(spec, rest, i, o) {
  const m = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(rest[i]);
  const flag = m && spec.find((f) => f.replace(/!$/, "") === m[1]);
  if (!flag) throw new Usage(`모르는 인자다: ${String(rest[i]).slice(0, 80)}`);
  if (m[1] in o) throw new Usage(`--${m[1]} 를 두 번 줬다`);
  if (flag.endsWith("!")) return (o[m[1]] = true) && i + 1;
  const value = m[2] !== undefined ? m[2] : rest[i + 1];
  if (value === undefined) throw new Usage(`--${m[1]} 에 값이 없다`);
  o[m[1]] = value;
  return m[2] !== undefined ? i + 1 : i + 2;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) throw new Usage(`모르는 명령이다: ${command ?? "(없음)"}`);
  const o = {};
  for (let i = 0; i < rest.length; ) i = readFlag(FLAGS[command], rest, i, o);
  for (const r of REQUIRED[command]) if (!(r in o)) throw new Usage(`--${r} 가 필요하다`);
  return { command, o };
}

const COMMANDS = { init, row, status, finish, report, cleanup };

function failure(e, out, err) {
  if (e instanceof Stop) {
    out.write(`${JSON.stringify({ ok: false, stop: e.code, message: `ultraqa: ${e.message}`, detail: e.detail }, null, 2)}\n`);
    return 3;
  }
  err.write(e instanceof Usage || e instanceof SyntaxError ? `ultraqa: ${e.message}\n` : `ultraqa: 내부 오류(${e?.code || e?.name || "error"}): ${String(e?.message || e).split("\n")[0]}\n`);
  return 2;
}

export async function main(argv, io = {}) {
  const ctx = { env: io.env || process.env, platform: io.platform || process.platform, stdin: io.stdin || (() => readFileSync(0, "utf8")) };
  const out = io.stdout || process.stdout;
  try {
    const { command, o } = parseArgs(argv);
    const [result, code] = await COMMANDS[command](o, ctx);
    out.write(command === "report" ? result.markdown : `${JSON.stringify({ command, ...result }, null, 2)}\n`);
    return code;
  } catch (e) {
    return failure(e, out, io.stderr || process.stderr);
  }
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
