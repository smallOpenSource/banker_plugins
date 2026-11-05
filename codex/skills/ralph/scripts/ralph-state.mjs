#!/usr/bin/env node
/**
 * ralph-state: the record of one banker ralph run (Codex), and the check that decides when it may end. The record is
 * <g>/ralph.md in the ralph-qa gate folder <g> the run's gates use (gate-evidence.mjs init). It is not kept in the
 * repo: an untracked file there would change the work tree fingerprint every gate record is judged by.
 *
 *   start   --dir <g> --cwd <repo> --task <text> [--plan <path>] [--gates <a,b>] [--no-gates <reason>] [--max <n>]
 *           [--no-deslop]                            a new run at iteration 0; baseline "run" when the tree has no change
 *   next    --dir <g>                                the next iteration (1, 2, ...), up to --max
 *   verdict --dir <g> --cwd <repo> --by <reviewer-N> --verdict APPROVE|REJECT --note <text> [--blockers <n>]
 *                                                    a fresh reviewer's word on the tree as it is now
 *   deslop  --dir <g> --cwd <repo> --note <text>     this iteration's slop pass over the changed files is done
 *   check   --dir <g> --cwd <repo>                   exit 0 when this iteration may end the run, 1 with what is missing
 *   done    --dir <g> --cwd <repo>                   check, then status complete; exit 1 and no change when check fails
 *   stop    --dir <g> --reason <text>                status stopped: a blocker the user must see
 *   status  --dir <g> [--cwd <repo>]                 the record, and the check when --cwd is given
 *   find    --cwd <repo>                             this repo's runs under the known bases, newest first
 *
 * Out: one JSON object on stdout; exit 2 for a usage or internal error, 3 for a stop. The gate commands themselves run
 * through gate-evidence.mjs (a byte-identical copy of ralph-qa's), never through this program. No network, no shell.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateConjunct, readEvidence, repeatedFailures } from "./gate-evidence.mjs";
import { Stop, bases, hashFile, listDir, norm, realOr, requireGitTree, runFolder, snapshot } from "./run-folder.mjs";

const GATES_KIND = "ralph-qa-gates";
const STATE = "ralph.md";
const TEXT_MAX = 4000;
const REVIEWER = /^reviewer-[1-9][0-9]?$/;

class Usage extends Error {}

const FLAGS = {
  start: ["dir", "cwd", "task", "plan", "gates", "no-gates", "max", "no-deslop"], next: ["dir"],
  verdict: ["dir", "cwd", "by", "verdict", "note", "blockers"], deslop: ["dir", "cwd", "note"],
  check: ["dir", "cwd"], done: ["dir", "cwd"], stop: ["dir", "reason"], status: ["dir", "cwd"], find: ["cwd"],
};
const REQUIRED = {
  start: ["dir", "cwd", "task"], next: ["dir"], verdict: ["dir", "cwd", "by", "verdict", "note"], deslop: ["dir", "cwd", "note"],
  check: ["dir", "cwd"], done: ["dir", "cwd"], stop: ["dir", "reason"], status: ["dir"], find: ["cwd"],
};
const BOOLEAN = new Set(["no-deslop"]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) throw new Usage(`모르는 명령이다: ${command ?? "(없음)"}`);
  const o = {};
  for (let i = 0; i < rest.length; ) i = readFlag(FLAGS[command], rest, i, o);
  for (const r of REQUIRED[command]) if (!(r in o)) throw new Usage(`--${r} 가 필요하다`);
  return { command, o };
}

// One `--name value`, `--name=value` or boolean `--name` at rest[i] into o; gives the index of the next one.
function readFlag(spec, rest, i, o) {
  const m = /^--([a-z][a-z-]*)(?:=([\s\S]*))?$/.exec(rest[i]);
  if (!m || !spec.includes(m[1])) throw new Usage(`모르는 인자다: ${String(rest[i]).slice(0, 80)}`);
  if (m[1] in o) throw new Usage(`--${m[1]} 를 두 번 줬다`);
  if (BOOLEAN.has(m[1])) {
    if (m[2] !== undefined) throw new Usage(`--${m[1]} 는 값을 받지 않는다`);
    o[m[1]] = true;
    return i + 1;
  }
  const value = m[2] !== undefined ? m[2] : rest[i + 1];
  if (value === undefined) throw new Usage(`--${m[1]} 에 값이 없다`);
  o[m[1]] = value;
  return m[2] !== undefined ? i + 1 : i + 2;
}

const whole = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Usage(`--${name} 는 ${min}~${max} 정수다: ${String(v).slice(0, 20)}`);
  return n;
};
const text = (v, name) => {
  const s = String(v).trim();
  if (!s) throw new Usage(`--${name} 가 비었다`);
  return s.slice(0, TEXT_MAX);
};
const gateIds = (v) => {
  const ids = String(v).split(",").map((g) => g.trim()).filter(Boolean);
  const bad = ids.find((g) => !/^[a-z0-9][a-z0-9-]{0,47}$/.test(g));
  if (bad !== undefined) throw new Usage(`게이트 id 는 영소문자, 숫자, - 로 48자까지다: ${bad.slice(0, 60)}`);
  if (!ids.length) throw new Usage("--gates 가 비었다");
  return [...new Set(ids)];
};

// ---- the record

const statePath = (d) => join(d, STATE);

function readState(d) {
  let raw;
  try {
    raw = readFileSync(statePath(d), "utf8");
  } catch {
    throw new Stop("not-started", `이 게이트 폴더에 ralph 기록이 없다(start 를 먼저): ${d}`);
  }
  try {
    const s = JSON.parse(raw);
    if (s?.kind === "banker-ralph" && s.v === 1) return s;
  } catch {
    /* below */
  }
  throw new Stop("bad-state", `ralph 기록을 읽을 수 없다: ${statePath(d)}`);
}

// Written whole to a new file, then moved over the old one: a stop part way leaves the old record.
function writeState(d, s) {
  const tmp = join(d, `.${STATE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath(d));
}

const gateFolder = (o, ctx) => runFolder(o.dir, ctx, [GATES_KIND]).d;

// The repo the command names must be the run's: a check against another tree would judge the wrong work.
async function treeOf(o, ctx, s) {
  const snap = await snapshot(resolve(o.cwd), ctx.env);
  if (!snap.git) throw new Stop("not-a-git-tree", `git 저장소가 아니다: ${resolve(o.cwd)}`);
  if (s && norm(ctx, snap.root) !== norm(ctx, s.repo)) throw new Stop("other-repo", `이 실행의 저장소가 아니다: ${snap.root} (실행은 ${s.repo})`);
  return snap;
}

const active = (s) => {
  if (s.status !== "active") throw new Stop("not-active", `이 실행은 이미 ${s.status} 다`);
};

// ---- commands

// The gates the run must pass, or the reason it has none: one of the two, never both.
function gatesOf(o) {
  const given = o.gates !== undefined;
  const none = o["no-gates"] !== undefined;
  if (given === none) throw new Usage("--gates <a,b> 나 --no-gates <까닭> 중 하나만 준다");
  return given ? { gates: gateIds(o.gates), noGates: null } : { gates: [], noGates: text(o["no-gates"], "no-gates") };
}

async function start(o, ctx) {
  const d = gateFolder(o, ctx);
  if (listDir(d).includes(STATE)) throw new Stop("started", `이 게이트 폴더에는 이미 ralph 기록이 있다(status 로 이어 감): ${d}`);
  const gates = gatesOf(o);
  const root = requireGitTree(o.cwd, ctx.env);
  const snap = await snapshot(root, ctx.env);
  const st = spawnSync("git", ["-C", snap.root, "status", "--porcelain=v1", "--untracked-files=all"], { env: ctx.env, encoding: "utf8" });
  const clean = st.status === 0 && st.stdout === "";
  const s = {
    v: 1, kind: "banker-ralph", status: "active", repo: snap.root, task: text(o.task, "task"), plan: o.plan ? resolve(o.plan) : null,
    ...gates,
    max: whole(o.max ?? 10, "max", 1, 100), deslop: !o["no-deslop"], iter: 0, head: snap.head, startFingerprint: snap.fingerprint,
    baseline: clean ? "run" : "none-dirty", startedAt: new Date().toISOString(), verdicts: [], deslops: [], ended: null,
  };
  writeState(d, s);
  return [{ ok: true, dir: d, iter: 0, baseline: s.baseline, gates: s.gates, max: s.max, deslop: s.deslop }, 0];
}

function next(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  active(s);
  if (s.iter >= s.max) throw new Stop("max-spent", `반복 한도 ${s.max} 를 다 썼다. stop 으로 끝내고 남은 문제를 보고한다`);
  s.iter += 1;
  writeState(d, s);
  return [{ ok: true, iter: s.iter, max: s.max, repeatedFailures: repeatedFailures(readEvidence(d)) }, 0];
}

async function verdict(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  active(s);
  if (s.iter < 1) throw new Stop("no-iteration", "반복 1 전에는 판정을 받지 않는다(next 를 먼저)");
  if (!REVIEWER.test(String(o.by))) throw new Usage(`--by 는 reviewer-<번호> 다(저자는 판정하지 않는다): ${String(o.by).slice(0, 40)}`);
  const word = String(o.verdict).toUpperCase();
  if (word !== "APPROVE" && word !== "REJECT") throw new Usage("--verdict 는 APPROVE 나 REJECT 다");
  const snap = await treeOf(o, ctx, s);
  const record = { by: o.by, verdict: word, blockers: whole(o.blockers ?? 0, "blockers", 0, 999), note: text(o.note, "note"), iter: s.iter, fingerprint: snap.fingerprint, at: new Date().toISOString() };
  if (word === "APPROVE" && record.blockers > 0) throw new Usage("blocker 가 있는 APPROVE 는 없다(REJECT 로 적는다)");
  s.verdicts.push(record);
  writeState(d, s);
  return [{ ok: true, ...record }, 0];
}

async function deslop(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  active(s);
  if (s.iter < 1) throw new Stop("no-iteration", "반복 1 전에는 슬롭 점검을 적지 않는다(next 를 먼저)");
  const snap = await treeOf(o, ctx, s);
  const record = { iter: s.iter, fingerprint: snap.fingerprint, note: text(o.note, "note"), at: new Date().toISOString() };
  s.deslops.push(record);
  writeState(d, s);
  return [{ ok: true, ...record }, 0];
}

// Each observed output of this iteration still has the sha256 its record names.
function changedOutputs(evidence, iter) {
  return evidence.filter((r) => r.kind === "observed" && r.iter === iter).filter((r) => {
    try {
      return hashFile(createHash, r.output) !== r.outputSha256;
    } catch {
      return true;
    }
  }).map((r) => r.seq);
}

function gateMissing(s, evidence, fingerprint) {
  if (!s.gates.length) return { missing: [], warnings: [`게이트 없음: ${s.noGates}`] };
  const conj = gateConjunct(evidence, s.gates, fingerprint, s.iter);
  const missing = conj.gates.filter((g) => !["pass", "baseline", "misleading"].includes(g.state)).map((g) => `게이트 ${g.id}: ${g.state}${g.need ? `(통과 ${g.need}회 더)` : ""}`);
  const warnings = conj.gates.filter((g) => g.state === "misleading").map((g) => `게이트 ${g.id}: 종료 0 인데 출력에 실패나 건너뜀(${g.why}). 검토자가 판단`);
  const changed = changedOutputs(evidence, s.iter);
  if (changed.length) missing.push(`출력 파일이 기록과 다름: seq ${changed.join(", ")}`);
  return { missing, warnings };
}

function reviewMissing(s, fingerprint) {
  const now = s.verdicts.filter((v) => v.iter === s.iter && v.fingerprint === fingerprint);
  const rejects = now.filter((v) => v.verdict === "REJECT");
  if (rejects.length) return [`검토자 REJECT: ${rejects.map((v) => v.by).join(", ")}`];
  if (!now.some((v) => v.verdict === "APPROVE")) return ["지금 작업 트리에 대한 검토자 APPROVE 없음"];
  return [];
}

// What keeps this iteration from ending the run: the gates on the tree as it is now, a fresh reviewer's APPROVE of
// that same tree with no REJECT beside it, and this iteration's slop pass recorded on that tree (an edit after the
// pass needs a new pass).
export function checkRun(s, evidence, fingerprint) {
  const missing = [];
  if (s.status !== "active") missing.push(`실행 상태 ${s.status}`);
  if (s.iter < 1) missing.push("반복 1 전(구현 전)");
  const gates = gateMissing(s, evidence, fingerprint);
  missing.push(...gates.missing, ...reviewMissing(s, fingerprint));
  if (s.deslop && !s.deslops.some((x) => x.iter === s.iter && x.fingerprint === fingerprint)) missing.push("지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음");
  return { ok: missing.length === 0, iter: s.iter, missing, warnings: gates.warnings, repeatedFailures: repeatedFailures(evidence) };
}

async function check(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  const snap = await treeOf(o, ctx, s);
  const r = checkRun(s, readEvidence(d), snap.fingerprint);
  return [{ ...r, fingerprint: snap.fingerprint }, r.ok ? 0 : 1];
}

async function done(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  active(s);
  const snap = await treeOf(o, ctx, s);
  const r = checkRun(s, readEvidence(d), snap.fingerprint);
  if (!r.ok) return [{ ...r, status: s.status }, 1];
  s.status = "complete";
  s.ended = { at: new Date().toISOString(), iter: s.iter, fingerprint: snap.fingerprint, head: snap.head };
  writeState(d, s);
  const approvals = s.verdicts.filter((v) => v.iter === s.iter && v.fingerprint === snap.fingerprint && v.verdict === "APPROVE").length;
  const line = `RALPH COMPLETE iter=${s.iter} gates=${s.gates.join(",") || "없음"} approvals=${approvals} deslop=${s.deslop ? "done" : "skipped"}`;
  return [{ ...r, status: "complete", line, warnings: r.warnings }, 0];
}

function stop(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  active(s);
  s.status = "stopped";
  s.ended = { at: new Date().toISOString(), iter: s.iter, reason: text(o.reason, "reason") };
  writeState(d, s);
  return [{ ok: true, status: "stopped", iter: s.iter, reason: s.ended.reason }, 0];
}

async function status(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  if (o.cwd === undefined) return [{ ok: true, dir: d, state: s }, 0];
  const snap = await treeOf(o, ctx, s);
  return [{ ok: true, dir: d, state: s, check: checkRun(s, readEvidence(d), snap.fingerprint) }, 0];
}

// This repo's runs: gate folders right under a known base whose record names this repo.
function find(o, ctx) {
  const root = requireGitTree(o.cwd, ctx.env);
  const real = norm(ctx, realOr(root));
  const runs = [];
  for (const base of bases(ctx).known) {
    for (const name of listDir(base).filter((n) => new RegExp(`^${GATES_KIND}\\.[A-Za-z0-9]+$`).test(n))) {
      const d = join(base, name);
      let s;
      try {
        runFolder(d, ctx, [GATES_KIND]);
        s = readState(d);
      } catch {
        continue;
      }
      if (norm(ctx, realOr(s.repo)) === real) runs.push({ dir: d, status: s.status, iter: s.iter, max: s.max, task: s.task.slice(0, 120), startedAt: s.startedAt });
    }
  }
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return [{ ok: true, repo: root, runs }, 0];
}

const COMMANDS = { start, next, verdict, deslop, check, done, stop, status, find };

const stopJson = (e) => ({ ok: false, stop: e.code, message: `ralph-state: ${e.message}`, detail: e.detail, ...(e.checked ? { checked: e.checked } : {}) });

function failure(e, out, err) {
  if (e instanceof Stop) {
    out.write(`${JSON.stringify(stopJson(e), null, 2)}\n`);
    return 3;
  }
  err.write(e instanceof Usage ? `ralph-state: ${e.message}\n` : `ralph-state: 내부 오류(${e?.code || e?.name || "error"}): ${String(e?.message || e).split("\n")[0]}\n`);
  return 2;
}

export async function main(argv, io = {}) {
  const ctx = { env: io.env || process.env, platform: io.platform || process.platform };
  const out = io.stdout || process.stdout;
  try {
    const { command, o } = parseArgs(argv);
    const [result, code] = await COMMANDS[command](o, ctx);
    out.write(`${JSON.stringify({ command, ...result }, null, 2)}\n`);
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
