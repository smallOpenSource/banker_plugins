#!/usr/bin/env node
/**
 * ralph-state: the record of one banker ralph run (Codex), and the check that decides when it may end. The record is
 * <g>/ralph.md in the ralph-qa gate folder <g> the run's gates use (gate-evidence.mjs init). It is not kept in the
 * repo: an untracked file there would change the work tree fingerprint every gate record is judged by.
 *
 *   start   --dir <g> --cwd <repo> --task <text> [--plan <path>] (--gates <a,b> | --no-gates <reason>) [--max <n>]
 *           [--no-deslop]                            a new run at iteration 0; baseline "run" when the tree has no change
 *   next    --dir <g>                                the next iteration (1, 2, ...), up to --max
 *   deslop  --dir <g> --cwd <repo> --note <text>     this iteration's slop pass over the changed files, on the tree now
 *   accept-baseline --dir <g> --cwd <repo> --id <gate> --reason <text>
 *                                                    a gate that fails as it did before the change, said not to be this
 *                                                    task's; counts only with a reviewer's APPROVE recorded after it
 *   evidence --dir <g>                               this iteration's gate records and accepted baselines, for a reviewer
 *   verdict --dir <g> --cwd <repo> --by <reviewer-N> --verdict APPROVE|REJECT --fingerprint <fp> --note <text>
 *           [--blockers <n>]                         a fresh reviewer's word on the tree it was shown (<fp> from check)
 *   check   --dir <g> --cwd <repo>                   exit 0 when this iteration may end the run, 1 with what is missing
 *   done    --dir <g> --cwd <repo>                   check, then status complete; exit 1 and no change when check fails
 *   stop    --dir <g> --reason <text>                status stopped: a blocker the user must see
 *   adopt   --dir <g>                                this Codex session (CODEX_THREAD_ID) takes over the run (a resume)
 *   status  --dir <g> [--cwd <repo>]                 the record, and the check when --cwd is given
 *   find    --cwd <repo>                             this repo's runs under the known bases, newest first
 *
 * continueFor() is what the Codex Stop hook (hooks/ralph-continue-codex.mjs) asks: while the session that started a
 * run (CODEX_THREAD_ID at start) still has it active, the turn may not end. Five stops in a row with no change to the
 * record or the gate evidence let it end, so a run that cannot move on never loops for ever.
 *
 * Every change to the record is made under <g>/.ralph.lock, so two calls at once never lose a verdict. Out: one JSON
 * object on stdout; exit 2 for a usage or internal error, 3 for a stop. The gate commands themselves run through
 * gate-evidence.mjs (a byte-identical copy of ralph-qa's), never through this program. No network, no shell.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateConjunct, readEvidence, repeatedFailures } from "./gate-evidence.mjs";
import { Stop, bases, hashFile, listDir, norm, realOr, requireGitTree, runFolder, snapshot, spawnFiles } from "./run-folder.mjs";

const GATES_KIND = "ralph-qa-gates";
const STATE = "ralph.md";
const LOCK = ".ralph.lock";
const TEXT_MAX = 4000;
const REVIEWER = /^reviewer-[1-9][0-9]?$/;
const STATUSES = new Set(["active", "complete", "stopped"]);
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 60000;
const CONTINUE = ".ralph-continue.md";
const CONTINUE_LIMIT = 5;
const HOOK_LOCK_WAIT_MS = 1500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Usage extends Error {}

const FLAGS = {
  start: ["dir", "cwd", "task", "plan", "gates", "no-gates", "max", "no-deslop"], next: ["dir"],
  verdict: ["dir", "cwd", "by", "verdict", "fingerprint", "note", "blockers"], deslop: ["dir", "cwd", "note"],
  "accept-baseline": ["dir", "cwd", "id", "reason"], evidence: ["dir"],
  check: ["dir", "cwd"], done: ["dir", "cwd"], stop: ["dir", "reason"], status: ["dir", "cwd"], find: ["cwd"], adopt: ["dir"],
};
const REQUIRED = {
  start: ["dir", "cwd", "task"], next: ["dir"], verdict: ["dir", "cwd", "by", "verdict", "fingerprint", "note"], deslop: ["dir", "cwd", "note"],
  "accept-baseline": ["dir", "cwd", "id", "reason"], evidence: ["dir"],
  check: ["dir", "cwd"], done: ["dir", "cwd"], stop: ["dir", "reason"], status: ["dir"], find: ["cwd"], adopt: ["dir"],
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

// One `--name value`, `--name=value` or boolean `--name` at rest[i] into o; gives the index of the next one. A value
// that starts with -- is taken only in the `--name=value` form: `--task --gates` is a missing value, not a task.
function readFlag(spec, rest, i, o) {
  const m = /^--([a-z][a-z-]*)(?:=([\s\S]*))?$/.exec(rest[i]);
  if (!m || !spec.includes(m[1])) throw new Usage(`모르는 인자다: ${String(rest[i]).slice(0, 80)}`);
  if (m[1] in o) throw new Usage(`--${m[1]} 를 두 번 줬다`);
  if (BOOLEAN.has(m[1])) {
    if (m[2] !== undefined) throw new Usage(`--${m[1]} 는 값을 받지 않는다`);
    o[m[1]] = true;
    return i + 1;
  }
  const inline = m[2] !== undefined;
  const value = inline ? m[2] : nextValue(rest[i + 1]);
  if (value === undefined) throw new Usage(`--${m[1]} 에 값이 없다`);
  o[m[1]] = value;
  return inline ? i + 1 : i + 2;
}
const nextValue = (v) => (v === undefined || v.startsWith("--") ? undefined : v);

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
const GATE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const gateIds = (v) => {
  const ids = String(v).split(",").map((g) => g.trim()).filter(Boolean);
  const bad = ids.find((g) => !GATE_ID.test(g));
  if (bad !== undefined) throw new Usage(`게이트 id 는 영소문자, 숫자, - 로 48자까지다: ${bad.slice(0, 60)}`);
  if (!ids.length) throw new Usage("--gates 가 비었다");
  return [...new Set(ids)];
};

// ---- the record and its lock

const statePath = (d) => join(d, STATE);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The shape every command relies on; anything else is a record this program did not write.
function validState(s) {
  const arrays = ["gates", "verdicts", "deslops", "accepts"].every((k) => Array.isArray(s?.[k]));
  const strings = ["repo", "task", "startFingerprint", "baseline"].every((k) => typeof s?.[k] === "string");
  const numbers = ["iter", "max", "seq"].every((k) => Number.isInteger(s?.[k]));
  return s?.kind === "banker-ralph" && s.v === 1 && STATUSES.has(s.status) && arrays && strings && numbers;
}

function readState(d) {
  let raw;
  try {
    raw = readFileSync(statePath(d), "utf8");
  } catch {
    throw new Stop("not-started", `이 게이트 폴더에 ralph 기록이 없다(start 를 먼저): ${d}`);
  }
  let s = null;
  try {
    s = JSON.parse(raw);
  } catch {
    /* below */
  }
  if (!validState(s)) throw new Stop("bad-state", `ralph 기록을 읽을 수 없다: ${statePath(d)}`);
  return s;
}

// Written whole to a new file, then moved over the old one: a stop part way leaves the old record. Windows may refuse
// the move for a moment while a scanner holds the file: a few short retries.
function writeState(d, s) {
  const tmp = join(d, `.${STATE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  for (let i = 0; ; i += 1) {
    try {
      renameSync(tmp, statePath(d));
      return;
    } catch (e) {
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleep(100);
    }
  }
}

function takeLock(p) {
  const fd = openSync(p, "wx", 0o600);
  writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
}

// A lock left by a process that died is old: removed after a minute. A live call holds it for milliseconds.
function staleLock(p) {
  try {
    return Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// fn runs with <g>/.ralph.lock held: the read, the change and the write of the record as one step.
function locked(d, fn, waitMs = LOCK_WAIT_MS) {
  const p = join(d, LOCK);
  for (const until = Date.now() + waitMs; ; ) {
    try {
      takeLock(p);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (staleLock(p)) unlinkSync(p);
      else if (Date.now() > until) throw new Stop("busy", `다른 ralph-state 호출이 기록을 쥐고 있다: ${p}`);
      else sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    unlinkSync(p);
  }
}

// read, change, write under the lock; `change` returns the command's result.
const update = (d, change) => locked(d, () => {
  const s = readState(d);
  const result = change(s);
  writeState(d, s);
  return result;
});

const gateFolder = (o, ctx) => runFolder(o.dir, ctx, [GATES_KIND]).d;

// The repo the command names must be the run's: a check against another tree would judge the wrong work.
async function treeOf(o, ctx, repo) {
  const snap = await snapshot(resolve(o.cwd), ctx.env);
  if (!snap.git) throw new Stop("not-a-git-tree", `git 저장소가 아니다: ${resolve(o.cwd)}`);
  if (repo && norm(ctx, realOr(snap.root)) !== norm(ctx, realOr(repo))) throw new Stop("other-repo", `이 실행의 저장소가 아니다: ${snap.root} (실행은 ${repo})`);
  return snap;
}

const active = (s) => {
  if (s.status !== "active") throw new Stop("not-active", `이 실행은 이미 ${s.status} 다`);
};
const iterating = (s, what) => {
  active(s);
  if (s.iter < 1) throw new Stop("no-iteration", `반복 1 전에는 ${what}을 적지 않는다(next 를 먼저)`);
};
const stamp = (s) => ({ seq: (s.seq += 1), at: new Date().toISOString() });

// No change at all: `git status` prints nothing. Its output goes to a file, not a Node pipe (the Codex Linux sandbox
// can lose a pipe's output, and an empty output would read as clean); any error reads as not clean.
function cleanTree(root, env) {
  const cwd = existsSync(homedir()) ? homedir() : tmpdir();
  const r = spawnFiles("git", ["-c", "core.fsmonitor=false", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, env, windowsHide: true });
  return r.status === 0 && !r.error && Buffer.isBuffer(r.stdout) && r.stdout.length === 0;
}

// ---- the check

// Iteration 0 is the baseline only when it ran on the tree the run started from, and that tree had no change.
const usable = (s, evidence) => evidence.filter((r) => r?.kind !== "observed" || r.iter !== 0 || (s.baseline === "run" && r.fingerprint === s.startFingerprint));

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

const acceptedFor = (s, g, fingerprint) => s.accepts.find((a) => a.id === g.id && a.signature === g.signature && a.iter === s.iter && a.fingerprint === fingerprint);

function gateLine(s, g, fingerprint) {
  if (g.state === "pass" || g.state === "misleading") return null;
  if (g.state === "baseline") {
    return acceptedFor(s, g, fingerprint) ? null
      : `게이트 ${g.id}: 시작 전부터 같은 실패(baseline). 이 작업이 고칠 실패면 고치고, 상관없는 실패면 accept-baseline 으로 까닭을 적은 뒤 검토받음`;
  }
  return `게이트 ${g.id}: ${g.state}${g.need ? `(통과 ${g.need}회 더)` : ""}`;
}

function gateMissing(s, evidence, fingerprint) {
  if (!s.gates.length) return { missing: [], warnings: [`게이트 없음: ${s.noGates}`], baseline: 0, misleading: 0 };
  const conj = gateConjunct(evidence, s.gates, fingerprint, s.iter);
  const missing = conj.gates.map((g) => gateLine(s, g, fingerprint)).filter(Boolean);
  const misleading = conj.gates.filter((g) => g.state === "misleading");
  const baseline = conj.gates.filter((g) => g.state === "baseline" && acceptedFor(s, g, fingerprint));
  const warnings = [...misleading.map((g) => `게이트 ${g.id}: 종료 0 인데 출력에 실패나 건너뜀(${g.why}). 검토자가 판단`),
    ...baseline.map((g) => `게이트 ${g.id}: 시작 전부터 같은 실패를 받아들임(${acceptedFor(s, g, fingerprint).reason})`)];
  const changed = changedOutputs(evidence, s.iter);
  if (changed.length) missing.push(`출력 파일이 기록과 다름: seq ${changed.join(", ")}`);
  return { missing, warnings, baseline: baseline.length, misleading: misleading.length };
}

// A REJECT of this tree stands in any iteration. An APPROVE counts for this iteration and tree, and only when it came
// after every baseline acceptance of that tree (the reviewer must have seen it).
function reviewMissing(s, fingerprint) {
  const rejects = s.verdicts.filter((v) => v.verdict === "REJECT" && v.fingerprint === fingerprint);
  if (rejects.length) return [`이 작업 트리에 검토자 REJECT: ${[...new Set(rejects.map((v) => v.by))].join(", ")}`];
  const lastAccept = Math.max(0, ...s.accepts.filter((a) => a.iter === s.iter && a.fingerprint === fingerprint).map((a) => a.seq));
  const approved = s.verdicts.some((v) => v.verdict === "APPROVE" && v.iter === s.iter && v.fingerprint === fingerprint && v.seq > lastAccept);
  return approved ? [] : [lastAccept ? "accept-baseline 뒤에 받은 검토자 APPROVE 없음" : "지금 작업 트리에 대한 검토자 APPROVE 없음"];
}

// What keeps this iteration from ending the run: the gates on the tree as it is now (a baseline failure only when
// accepted), a fresh reviewer's APPROVE of that tree with no REJECT of it, and this iteration's slop pass on that tree.
export function checkRun(s, rawEvidence, fingerprint) {
  const evidence = usable(s, rawEvidence);
  const missing = [];
  if (s.status !== "active") missing.push(`실행 상태 ${s.status}`);
  if (s.iter < 1) missing.push("반복 1 전(구현 전)");
  const gates = gateMissing(s, evidence, fingerprint);
  missing.push(...gates.missing, ...reviewMissing(s, fingerprint));
  if (s.deslop && !s.deslops.some((x) => x.iter === s.iter && x.fingerprint === fingerprint)) missing.push("지금 작업 트리에 대한 이번 반복의 슬롭 점검 기록 없음");
  return { ok: missing.length === 0, iter: s.iter, missing, warnings: gates.warnings, baseline: gates.baseline, misleading: gates.misleading,
    repeatedFailures: repeatedFailures(evidence) };
}

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
  const gates = gatesOf(o);
  const fields = { task: text(o.task, "task"), max: whole(o.max ?? 10, "max", 1, 100) };
  const root = requireGitTree(o.cwd, ctx.env);
  const snap = await snapshot(root, ctx.env);
  const clean = cleanTree(snap.root, ctx.env);
  const s = {
    v: 1, kind: "banker-ralph", status: "active", repo: snap.root, ...fields, plan: o.plan ? resolve(o.plan) : null, ...gates,
    deslop: !o["no-deslop"], iter: 0, seq: 0, head: snap.head, startFingerprint: snap.fingerprint, baseline: clean ? "run" : "none-dirty",
    session: UUID.test(String(ctx.env.CODEX_THREAD_ID || "")) ? ctx.env.CODEX_THREAD_ID : null,
    startedAt: new Date().toISOString(), verdicts: [], deslops: [], accepts: [], ended: null,
  };
  locked(d, () => {
    if (existsSync(statePath(d))) throw new Stop("started", `이 게이트 폴더에는 이미 ralph 기록이 있다(status 로 이어 감): ${d}`);
    writeState(d, s);
  });
  const warnings = s.session ? [] : ["CODEX_THREAD_ID 가 없어 Stop 훅이 이 실행을 잇지 않는다(Codex 세션 안에서 adopt 하면 이음)"];
  return [{ ok: true, dir: d, head: s.head, session: s.session, warnings, iter: 0, baseline: s.baseline, startFingerprint: s.startFingerprint, gates: s.gates, max: s.max, deslop: s.deslop }, 0];
}

function next(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = update(d, (st) => {
    active(st);
    if (st.iter >= st.max) throw new Stop("max-spent", `반복 한도 ${st.max} 를 다 썼다. stop 으로 끝내고 남은 문제를 보고한다`);
    st.iter += 1;
    return st;
  });
  return [{ ok: true, iter: s.iter, max: s.max, repeatedFailures: repeatedFailures(usable(s, readEvidence(d))) }, 0];
}

async function verdict(o, ctx) {
  const d = gateFolder(o, ctx);
  if (!REVIEWER.test(String(o.by))) throw new Usage(`--by 는 reviewer-<번호> 다(저자는 판정하지 않는다): ${String(o.by).slice(0, 40)}`);
  const word = String(o.verdict).toUpperCase();
  if (word !== "APPROVE" && word !== "REJECT") throw new Usage("--verdict 는 APPROVE 나 REJECT 다");
  const blockers = whole(o.blockers ?? 0, "blockers", 0, 999);
  if (word === "APPROVE" && blockers > 0) throw new Usage("blocker 가 있는 APPROVE 는 없다(REJECT 로 적는다)");
  const snap = await treeOf(o, ctx, readState(d).repo);
  if (o.fingerprint !== snap.fingerprint) throw new Stop("stale-review", "검토자가 본 작업 트리(--fingerprint)가 지금과 다르다. 지금 트리로 다시 검토받는다");
  const record = update(d, (s) => {
    iterating(s, "판정");
    const r = { by: o.by, verdict: word, blockers, note: text(o.note, "note"), iter: s.iter, fingerprint: snap.fingerprint, ...stamp(s) };
    s.verdicts.push(r);
    return r;
  });
  return [{ ok: true, ...record }, 0];
}

async function deslop(o, ctx) {
  const d = gateFolder(o, ctx);
  const snap = await treeOf(o, ctx, readState(d).repo);
  const record = update(d, (s) => {
    iterating(s, "슬롭 점검");
    const r = { iter: s.iter, fingerprint: snap.fingerprint, note: text(o.note, "note"), ...stamp(s) };
    s.deslops.push(r);
    return r;
  });
  return [{ ok: true, ...record }, 0];
}

async function acceptBaseline(o, ctx) {
  const d = gateFolder(o, ctx);
  if (!GATE_ID.test(String(o.id))) throw new Usage(`게이트 id 가 아니다: ${String(o.id).slice(0, 60)}`);
  const snap = await treeOf(o, ctx, readState(d).repo);
  const record = update(d, (s) => {
    iterating(s, "기준선 수용");
    const g = gateConjunct(usable(s, readEvidence(d)), s.gates, snap.fingerprint, s.iter).gates.find((x) => x.id === o.id);
    if (!g || g.state !== "baseline") throw new Stop("not-baseline", `게이트 ${o.id} 는 지금 트리에서 시작 전과 같은 실패가 아니다(${g ? g.state : "선언 안 됨"})`);
    const r = { id: o.id, signature: g.signature, reason: text(o.reason, "reason"), iter: s.iter, fingerprint: snap.fingerprint, ...stamp(s) };
    s.accepts.push(r);
    return r;
  });
  return [{ ok: true, ...record }, 0];
}

// What a reviewer is shown of the gates: this iteration's observed records and the accepted baselines.
function evidence(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  const pick = (r) => ({ id: r.id, iter: r.iter, seq: r.seq, cmd: r.cmd, verdict: r.verdict, why: r.why, exit: r.exit, timedOut: r.timedOut, output: r.output, outputSha256: r.outputSha256, fingerprint: r.fingerprint });
  const records = usable(s, readEvidence(d)).filter((r) => r.kind === "observed" && (r.iter === s.iter || r.iter === 0)).map(pick);
  return [{ ok: true, iter: s.iter, baseline: s.baseline, records, accepts: s.accepts.filter((a) => a.iter === s.iter) }, 0];
}

async function check(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  const snap = await treeOf(o, ctx, s.repo);
  const r = checkRun(s, readEvidence(d), snap.fingerprint);
  return [{ ...r, fingerprint: snap.fingerprint }, r.ok ? 0 : 1];
}

const completeLine = (s, r, fingerprint) => {
  const approvals = s.verdicts.filter((v) => v.iter === s.iter && v.fingerprint === fingerprint && v.verdict === "APPROVE").length;
  return `RALPH COMPLETE iter=${s.iter} gates=${s.gates.join(",") || "없음"} approvals=${approvals} deslop=${s.deslop ? "done" : "skipped"} baseline=${r.baseline} misleading=${r.misleading}`;
};

async function done(o, ctx) {
  const d = gateFolder(o, ctx);
  const snap = await treeOf(o, ctx, readState(d).repo);
  return locked(d, () => {
    const s = readState(d);
    active(s);
    const r = checkRun(s, readEvidence(d), snap.fingerprint);
    if (!r.ok) return [{ ...r, status: s.status, fingerprint: snap.fingerprint }, 1];
    s.status = "complete";
    s.ended = { at: new Date().toISOString(), iter: s.iter, fingerprint: snap.fingerprint, head: snap.head };
    writeState(d, s);
    return [{ ...r, status: "complete", line: completeLine(s, r, snap.fingerprint) }, 0];
  });
}

function stop(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = update(d, (st) => {
    active(st);
    st.status = "stopped";
    st.ended = { at: new Date().toISOString(), iter: st.iter, reason: text(o.reason, "reason") };
    return st;
  });
  return [{ ok: true, status: "stopped", iter: s.iter, reason: s.ended.reason }, 0];
}

// A resume in another Codex session: the Stop hook keeps going only the session the record names.
function adopt(o, ctx) {
  const d = gateFolder(o, ctx);
  const id = String(ctx.env.CODEX_THREAD_ID || "");
  if (!UUID.test(id)) throw new Stop("no-session", "CODEX_THREAD_ID 가 없다. Codex 세션 안에서 부른다");
  const s = update(d, (st) => {
    active(st);
    st.session = id;
    return st;
  });
  return [{ ok: true, session: s.session, iter: s.iter }, 0];
}

async function status(o, ctx) {
  const d = gateFolder(o, ctx);
  const s = readState(d);
  if (o.cwd === undefined) return [{ ok: true, dir: d, state: s }, 0];
  const snap = await treeOf(o, ctx, s.repo);
  return [{ ok: true, dir: d, state: s, fingerprint: snap.fingerprint, check: checkRun(s, readEvidence(d), snap.fingerprint) }, 0];
}

// This repo's runs: gate folders right under a known base whose record names this repo. A folder whose record cannot
// be read is listed apart, never a stop for the rest.
function runsOf(root, ctx) {
  const real = norm(ctx, realOr(root));
  const runs = [];
  const unreadable = [];
  for (const base of bases(ctx).known) {
    for (const name of listDir(base).filter((n) => new RegExp(`^${GATES_KIND}\\.[A-Za-z0-9]+$`).test(n))) {
      const d = join(base, name);
      try {
        runFolder(d, ctx, [GATES_KIND]);
        if (!existsSync(statePath(d))) continue;
        const s = readState(d);
        if (norm(ctx, realOr(s.repo)) === real) runs.push({ dir: d, state: s });
      } catch (e) {
        if (e.code === "bad-state") unreadable.push(d);
      }
    }
  }
  runs.sort((a, b) => String(b.state.startedAt).localeCompare(String(a.state.startedAt)));
  return { runs, unreadable };
}

function find(o, ctx) {
  const root = requireGitTree(o.cwd, ctx.env);
  const { runs, unreadable } = runsOf(root, ctx);
  const brief = ({ dir, state: s }) => ({ dir, status: s.status, iter: s.iter, max: s.max, task: s.task.slice(0, 120), startedAt: s.startedAt });
  return [{ ok: true, repo: root, runs: runs.map(brief), unreadable }, 0];
}

// ---- the Codex Stop hook's question

const evidenceSize = (d) => {
  try {
    return statSync(join(d, "evidence.md")).size;
  } catch {
    return 0;
  }
};

// How many stops in a row this run has seen with nothing new: one per turn (two banker hooks in one Codex, the npm
// and the plugin route, ask once each for the same turn), reset when the record or the gate evidence grew.
function stopsWithoutChange(d, s, turnId) {
  const key = `${s.iter}:${s.seq}:${s.status}:${evidenceSize(d)}`;
  const p = join(d, CONTINUE);
  let last = {};
  try {
    last = JSON.parse(readFileSync(p, "utf8")) || {};
  } catch {
    /* none yet */
  }
  if (last.turn && last.turn === turnId) return last.count;
  const count = last.key === key ? (last.count || 0) + 1 : 1;
  writeFileSync(p, `${JSON.stringify({ key, count, turn: turnId || null })}\n`, { mode: 0o600 });
  return count;
}

// The reason to keep the turn going, or null: an active run this session started in this repo.
export function continueFor({ cwd, sessionId, turnId }, ctx = { env: process.env, platform: process.platform }) {
  if (!UUID.test(String(sessionId || "")) || !cwd) return null;
  let root;
  try {
    root = requireGitTree(cwd, ctx.env);
  } catch {
    return null;
  }
  const run = runsOf(root, ctx).runs.find(({ state: s }) => s.status === "active" && s.session === sessionId);
  if (!run) return null;
  const s = run.state;
  // The hook has 5 seconds: a lock held longer still keeps the turn going, uncounted (a dead holder's lock goes in a minute).
  let count = 0;
  try {
    count = locked(run.dir, () => stopsWithoutChange(run.dir, s, turnId), HOOK_LOCK_WAIT_MS);
  } catch (e) {
    if (e.code !== "busy") throw e;
  }
  if (count > CONTINUE_LIMIT) return null;
  return [`banker ralph 실행이 아직 active 다(게이트 폴더 ${run.dir}, 반복 ${s.iter}/${s.max}). 끝내지 말고 이어 간다.`,
    `node '${fileURLToPath(import.meta.url)}' check --dir '${run.dir}' --cwd '${root}' 로 빠진 것을 보고 banker ralph SKILL.md 절차를 계속한다.`,
    "모두 맞으면 done 으로 끝낸다. 사용자 결정이 필요하거나 같은 실패가 반복되면 stop --reason 으로 멈추고 보고한다.",
    `(기록 변화 없이 멈추려 한 횟수 ${count}/${CONTINUE_LIMIT})`].join(" ");
}

const COMMANDS = { start, next, verdict, deslop, "accept-baseline": acceptBaseline, evidence, check, done, stop, adopt, status, find };

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
