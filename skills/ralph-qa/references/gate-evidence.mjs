#!/usr/bin/env node
/**
 * gate-evidence: a gate command run by this program, not by the model, and what it saw, as the evidence ralph-qa
 * (--gates), ultraqa, all-in-one, ultra-init and ultra-chain judge by. The source of truth is
 * skills/ralph-qa/references/gate-evidence.mjs; skills/ultraqa/references holds a byte-identical copy
 * (scripts/sync-adapter.js).
 *
 *   node gate-evidence.mjs init [--cwd <repo>]   the gate folder <g> of one ralph-qa run (ralph-qa-gates.<letters and digits>): made
 *        once before the baseline, kept across the iterations, apart from the payload folder seat-run.mjs makes anew
 *        each iteration; seat-run's day rule never takes it (another name, another marker). init and run stop with
 *        not-a-git-tree when the repo (--cwd) is no git work tree: its fingerprint would see no change.
 *   node gate-evidence.mjs cleanup --dir <g>     that gate folder alone, once the run has its end word
 *   node gate-evidence.mjs run --dir <d> --id <id> --cmd <command> --timeout <s> [--iter <n>] [--cwd <repo>]
 *        one command (one gate, never several joined), POSIX `sh -c`, Windows PowerShell 7 (pwsh) when on PATH,
 *        else 5.1, with an exit that keeps the command's code; its output on the descriptor of a new file
 *        <d>/gate-<id>-<iter>-<seq>.md (no Node pipes); past the limit its whole tree ends (POSIX: its process group, TERM then
 *        KILL; Windows: taskkill /T /F); after it ends on its own the group is sent KILL too (POSIX). One
 *        `observed` line goes to <d>/evidence.md: the command, folder, times, exit or signal, timedOut, the output
 *        file and its sha256, the work tree fingerprint after it, the verdict and the failure signature. Each seq is
 *        claimed with a file of its own (<d>/.seq-<n>.md, made with "wx"), so two runs at once never share one.
 *   node gate-evidence.mjs note --dir <d> --id <id> --text <what> [--iter <n>] [--exit <code>]
 *        a `reported` line: what someone said (a model, an OMX report). Never a verdict's evidence.
 *   node gate-evidence.mjs gate --dir <d> --gates <a,b,...> --iter <n> [--cwd <repo>]
 *        gateConjunct over the evidence and the fingerprint now; exit 0 when it holds, 1 when not.
 *   node gate-evidence.mjs verify --dir <d>     each observed output file against its recorded sha256; 1 on a mismatch
 *   node gate-evidence.mjs fingerprint [--cwd <repo>]
 *
 * <d> is a gate folder (init), an ultraqa run folder, or a ralph-qa folder an older version made with seat-run.mjs init
 * (run-folder.mjs). Iteration 0 is the baseline, before any fix. Out: one
 * JSON object on stdout; exit 2 for a usage or internal error, 3 for a stop. Every file name ends in .md (a closed
 * network's DRM encrypts files by their extension and leaves .md readable).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Stop, hashFile, makeRunFolder, removeRunFolder, requireGitTree, runFolder, snapshot } from "./run-folder.mjs";

const GATES_KIND = "ralph-qa-gates";
const KINDS = [GATES_KIND, "ralph-qa", "ultraqa"];
const EVIDENCE = "evidence.md";
const GRACE_MS = 2000;
// The output text the verdict and the signature read: whole up to 64 MiB, past that its first and last 32 MiB.
const TEXT_MAX = 64 << 20;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// The nine adversarial classes (OMX ultraqa's), the lens of ralph-qa's adversarial seat and the rows of ultraqa's matrix.
export const CLASSES = [
  ["malformed-input", "잘못된 입력"], ["repeated-interruption", "반복 중단"], ["prompt-injection", "프롬프트 주입"],
  ["cancel-resume", "취소와 재개"], ["stale-state", "낡은 상태"], ["dirty-worktree", "더러운 작업 트리"],
  ["hung-command", "멈춘 명령"], ["flaky-test", "흔들리는 시험"], ["misleading-output", "오도하는 성공 출력"],
];

// ---- verdict and signature (pure)

// Exit 0 whose output still says a test failed or was skipped: node:test, TAP, Jest, Vitest, pytest, Go test.
const MISLEADING = [
  ["node:test 실패", /^ℹ (?:fail|cancelled) [1-9]/m], ["node:test 건너뜀", /^ℹ (?:skipped|todo) [1-9]/m],
  ["TAP 실패나 건너뜀", /^# (?:fail|skip|todo|cancelled) [1-9]/m],
  ["Jest/Vitest 실패", /^\s*Tests?:?\s+.*?\b[1-9]\d* failed\b/m], ["Jest/Vitest 건너뜀", /^\s*Tests?:?\s+.*?\b[1-9]\d* (?:skipped|todo|pending)\b/m],
  ["pytest 실패", /^=+ .*?\b[1-9]\d* (?:failed|errors?)\b.*=+\s*$/m], ["pytest 건너뜀", /^=+ .*?\b[1-9]\d* skipped\b.*=+\s*$/m],
  ["Go test 실패", /^(?:--- FAIL: |FAIL\s)/m], ["Go test 건너뜀", /^\s*--- SKIP: /m],
];

export function judge({ exit, signal, timedOut, text }) {
  if (timedOut) return { verdict: "timeout", why: "시간 제한" };
  if (exit !== 0) return { verdict: "fail", why: exit === null ? `신호 ${signal}` : `종료 ${exit}` };
  const hit = MISLEADING.find(([, re]) => re.test(text));
  return hit ? { verdict: "misleading", why: hit[0] } : { verdict: "pass", why: null };
}

const FAILURE_LINE = /(?:^|[\s(])(?:not ok|✖|FAIL(?:ED)?|Error|ERROR|error|[Ff]ailed|AssertionError|panic:|Traceback)\b/;
// What does not tell two failures apart: colours, times, numbers, long hex, temporary folders.
const normalized = (line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/(?:\/tmp|\/var\/folders|\\Temp|\/private\/var)[^\s'"]*/gi, "<tmp>")
  .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>").replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim();

// Where the command ran, as <repo>: the same failure in the repo and in a clean worktree copy of it (the baseline of a
// tree with changes) names two folders. Each root (never a file system root) in its own form and with / (a Windows
// file URL), longest first, as one pattern.
function rootsOut(roots) {
  const forms = [...new Set(roots.filter((r) => r && dirname(r) !== r).flatMap((r) => [r, r.replace(/\\/g, "/")]))].sort((x, y) => y.length - x.length);
  if (!forms.length) return (line) => line;
  const re = new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (line) => line.replace(re, "<repo>");
}

// The id with the sha256 (16 hex) of the normalized failure lines, or of the last 20 lines when none reads as one.
// `roots` are the folders the command ran in (its cwd, the repo root): written as <repo>.
export function signatureOf(id, verdict, text, roots = []) {
  const lines = String(text).split(/\r?\n/);
  const failing = lines.filter((l) => FAILURE_LINE.test(l));
  const out = rootsOut(roots);
  const picked = (failing.length ? failing : lines.filter((l) => l.trim()).slice(-20)).map((l) => normalized(out(l)));
  return `${id}:${sha256(`${verdict}\n${[...new Set(picked)].slice(0, 200).join("\n")}`).slice(0, 16)}`;
}

// ---- the gate conjunct (pure)

const OK_STATES = new Set(["pass", "baseline", "misleading"]);
const PASSES_AFTER_FAIL = 3;

// `scenarios` stands for every scenario-* gate the evidence holds.
function expand(gates, observed) {
  const scenarioIds = [...new Set(observed.map((r) => r.id).filter((id) => id.startsWith("scenario-")))];
  return gates.flatMap((g) => (g !== "scenarios" ? [g] : scenarioIds.length ? scenarioIds : ["scenarios"]));
}

// A pass right after a failure counts once it has two more passes on the same tree.
function afterFailure(recs, last, fingerprint) {
  const lastBad = recs.reduce((at, r, i) => (r.verdict !== "pass" ? i : at), -1);
  if (lastBad === -1) return { state: "pass", seq: last.seq };
  const passes = recs.slice(lastBad + 1).filter((r) => r.fingerprint === fingerprint).length;
  return passes >= PASSES_AFTER_FAIL ? { state: "pass", seq: last.seq } : { state: "flaky", seq: last.seq, need: PASSES_AFTER_FAIL - passes };
}

// The baseline record (iteration 0 of the gate) failed the same way: the same command and failure signature.
const sameAsBaseline = (base, r) => Boolean(base) && base.verdict !== "pass" && base.cmd === r.cmd && base.signature === r.signature;

// A failure the baseline (iteration 0, the same command) had with the same signature is not this change's.
function failed(recs, last) {
  const same = sameAsBaseline(recs.find((r) => r.iter === 0), last);
  return same ? { state: "baseline", seq: last.seq, signature: last.signature } : { state: last.verdict, seq: last.seq, signature: last.signature };
}

function gateState(recs, id, fingerprint, iter) {
  const now = recs.filter((r) => r.iter === iter);
  if (!now.length) return { id, state: "missing" };
  const last = now[now.length - 1];
  // A tree with no git has one fingerprint whatever changes: no record of it shows the tree it was judged on.
  if (last.git === false) return { id, state: "unverifiable", seq: last.seq, why: "git 저장소가 아니라 작업 트리 변경을 볼 수 없다" };
  if (last.fingerprint !== fingerprint) return { id, state: "stale", seq: last.seq };
  if (last.verdict === "misleading") return { id, state: "misleading", seq: last.seq, why: last.why };
  return { id, ...(last.verdict === "pass" ? afterFailure(recs, last, fingerprint) : failed(recs, last)) };
}

// The quorum's gate conjunct: every declared gate has an observed record of this iteration on the tree as it is now,
// and passes (a pass after a failure: two more), or fails as the baseline did. `reported` lines never count.
export function gateConjunct(evidence, gates, fingerprint, iter) {
  const observed = evidence.filter((r) => r && r.kind === "observed");
  const results = expand(gates, observed).map((g) => gateState(observed.filter((r) => r.id === g), g, fingerprint, iter));
  return { ok: results.length > 0 && results.every((x) => OK_STATES.has(x.state)), gates: results };
}

// Keys seen in `n` or more different iterations: the same failure (a gate's signature) or the same issue.
export function repeated(items, n = 3) {
  const iters = new Map();
  for (const { key, iter } of items) iters.set(key, (iters.get(key) || new Set()).add(iter));
  return [...iters].filter(([, s]) => s.size >= n).map(([key]) => key);
}
// A gate's same failure, from iteration 1 on: the baseline (iteration 0) is no review iteration, and a failure the
// baseline had (same command, same signature; `baseline` in the conjunct, never this change's to fix) is not counted.
export function repeatedFailures(evidence, n = 3) {
  const observed = evidence.filter((r) => r?.kind === "observed");
  const own = observed.filter((r) => r.signature && r.iter !== 0 && !sameAsBaseline(observed.find((b) => b.id === r.id && b.iter === 0), r));
  return repeated(own.map((r) => ({ key: r.signature, iter: r.iter })), n);
}

// ralph-qa's same issue: (seat id, the path or criterion ID it cites, its title normalized).
export const issueKey = (seat, cite, title) => [seat, cite, String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()].join("\u0000");

// How a run that spent --max ends: blockers left are INCONCLUSIVE; a run that only the gates kept from APPROVE says so.
export function exhausted({ blockers, quorumWithoutGate, gateOk }) {
  if (blockers > 0) return "INCONCLUSIVE";
  return quorumWithoutGate && gateOk === false ? "ITERATE(한도 소진, 원인 gate)" : "ITERATE(한도 소진)";
}

// ---- running one command

function onPath(name, env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  for (const dir of String(key ? env[key] : "").split(delimiter).filter((x) => win32.isAbsolute(x))) {
    const p = win32.join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

// The shell: POSIX sh, or PowerShell with an exit that keeps a native command's code (5.1 makes any failure 1) and
// turns a failed cmdlet into 1. A newline before it, so a trailing comment in the command cannot swallow it.
export function shellFor(cmd, ctx) {
  if (ctx.platform !== "win32") return { name: "sh", exe: "/bin/sh", args: ["-c", cmd] };
  const pwsh = onPath("pwsh.exe", ctx.env);
  const exe = pwsh || win32.join(ctx.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tail = "\n$rqOk = $?; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $rqOk) { exit 1 }; exit 0";
  return { name: pwsh ? "pwsh" : "powershell", exe, args: ["-NoProfile", "-NonInteractive", "-Command", `${cmd}${tail}`] };
}

const killGroup = (pid, sig) => {
  try {
    process.kill(-pid, sig);
  } catch {
    /* the group is gone */
  }
};
const taskkill = (ctx, pid) => spawnSync(win32.join(ctx.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });

function endTree(ctx, child) {
  if (ctx.platform === "win32") return void taskkill(ctx, child.pid);
  killGroup(child.pid, "SIGTERM");
  setTimeout(() => killGroup(child.pid, "SIGKILL"), GRACE_MS).unref();
}

// Runs `cmd` with its output on `fd` (a new output file, closed here); resolves { exit, signal, timedOut, secs, shell }.
// The child writes to the output file's descriptor itself, not through Node's pipes: those are AF_UNIX socket pairs,
// and in the Codex Linux sandbox their output can be lost (zero bytes recorded for a command that printed).
export function execute({ cmd, cwd, limitMs, fd }, ctx) {
  const sh = shellFor(cmd, ctx);
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn(sh.exe, sh.args, { cwd, env: ctx.env, stdio: ["ignore", fd, fd], detached: ctx.platform !== "win32", windowsHide: true });
    let timedOut = false;
    let settled = false;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      closeSync(fd);
      const { code = null, signal = null } = status || {};
      done({ exit: error ? null : code, signal, timedOut, secs: Math.round((Date.now() - t0) / 100) / 10, shell: sh.name, error: error || null });
    };
    const limit = setTimeout(() => {
      timedOut = true;
      endTree(ctx, child);
    }, limitMs);
    child.on("error", (e) => (child.pid === undefined ? finish(null, e.code || "spawn") : null));
    // After the shell ends, what it left in its group ends too (POSIX).
    child.on("exit", (code, signal) => {
      if (ctx.platform !== "win32") killGroup(child.pid, "SIGKILL");
      finish({ code, signal });
    });
  });
}

// A new file (never one already there): its descriptor, or null when one is there; a folder the sandbox does not let
// it write is a stop with what to do.
function openNew(p) {
  try {
    return openSync(p, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return null;
    if (!["EACCES", "EPERM", "EROFS"].includes(e.code)) throw e;
    throw new Stop("no-write", `게이트 기록 파일을 만들지 못했다(${e.code}): ${p}. 실행 폴더가 샌드박스 쓰기 범위 밖이면 이 명령을 승인으로 다시 실행한다`, [p]);
  }
}

// The next seq: past every recorded one (a record cut short leaves no line) and claimed by its own file made with
// "wx", so two runs in one folder at once never share one.
function claimSeq(d) {
  const recorded = readEvidence(d).map((r) => (Number.isInteger(r?.seq) ? r.seq : 0));
  for (let seq = Math.max(recorded.length, ...recorded) + 1; ; seq += 1) {
    const fd = openNew(join(d, `.seq-${seq}.md`));
    if (fd !== null) return (closeSync(fd), seq);
  }
}

// A claimed seq whose output file is new (one a run of an older version left behind takes the next seq).
function newOutput(d, id, iter) {
  for (;;) {
    const seq = claimSeq(d);
    const output = join(d, `gate-${id}-${iter}-${seq}.md`);
    const fd = openNew(output);
    if (fd !== null) return { seq, output, fd };
  }
}

// What the verdict and the signature read: the whole output up to TEXT_MAX, past it the first and last half (a
// test runner's counts are at its end) with `cut`.
export function outputText(p, max = TEXT_MAX) {
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= max) return { text: readFileSync(fd).toString("utf8"), size, cut: false };
    const part = (at, n) => {
      const b = Buffer.alloc(n);
      return b.subarray(0, readSync(fd, b, 0, n, at));
    };
    return { text: Buffer.concat([part(0, max / 2), Buffer.from("\n"), part(size - max / 2, max / 2)]).toString("utf8"), size, cut: true };
  } finally {
    closeSync(fd);
  }
}

// The verdict of one run; a pass whose output was too large to read whole is misleading (the seats judge it).
function verdictOf(r, out) {
  if (r.error) return { verdict: "fail", why: `시작 실패(${r.error})` };
  const v = judge({ ...r, text: out.text });
  return v.verdict === "pass" && out.cut ? { verdict: "misleading", why: `출력 ${out.size} 바이트가 ${TEXT_MAX} 바이트를 넘어 앞뒤만 봄` } : v;
}

// ---- commands

class Usage extends Error {}
const FLAGS = {
  init: ["cwd"], cleanup: ["dir"], run: ["dir", "id", "cmd", "timeout", "iter", "cwd"], note: ["dir", "id", "text", "iter", "exit"],
  gate: ["dir", "gates", "iter", "cwd"], verify: ["dir"], fingerprint: ["cwd"],
};
const REQUIRED = { init: [], cleanup: ["dir"], run: ["dir", "id", "cmd", "timeout"], note: ["dir", "id", "text"], gate: ["dir", "gates", "iter"], verify: ["dir"], fingerprint: [] };

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) throw new Usage(`모르는 명령이다: ${command ?? "(없음)"}`);
  const o = {};
  for (let i = 0; i < rest.length; ) i = readFlag(FLAGS[command], rest, i, o);
  for (const r of REQUIRED[command]) if (!(r in o)) throw new Usage(`--${r} 가 필요하다`);
  return { command, o };
}

// One `--name value` or `--name=value` at rest[i] into o; gives the index of the next one.
function readFlag(spec, rest, i, o) {
  const m = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(rest[i]);
  if (!m || !spec.includes(m[1])) throw new Usage(`모르는 인자다: ${String(rest[i]).slice(0, 80)}`);
  if (m[1] in o) throw new Usage(`--${m[1]} 를 두 번 줬다`);
  const value = m[2] !== undefined ? m[2] : rest[i + 1];
  if (value === undefined) throw new Usage(`--${m[1]} 에 값이 없다`);
  o[m[1]] = value;
  return m[2] !== undefined ? i + 1 : i + 2;
}

const gateId = (id) => {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(String(id))) throw new Usage(`게이트 id 는 영소문자, 숫자, - 로 48자까지다: ${String(id).slice(0, 60)}`);
  return id;
};
const whole = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Usage(`--${name} 는 ${min}~${max} 정수다: ${String(v).slice(0, 20)}`);
  return n;
};

export function readEvidence(d) {
  let text = "";
  try {
    text = readFileSync(join(d, EVIDENCE), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { kind: "unreadable" };
    }
  });
}
const append = (d, record) => appendFileSync(join(d, EVIDENCE), `${JSON.stringify(record)}\n`, { mode: 0o600 });

function init(o, ctx) {
  requireGitTree(o.cwd || process.cwd(), ctx.env);
  const { dir, base } = makeRunFolder(ctx, GATES_KIND);
  return [{ ok: true, dir, base }, 0];
}

// The gate folder alone (an older ralph-qa.* folder goes with seat-run.mjs cleanup, which knows its answer folder).
function cleanup(o, ctx) {
  return [{ ok: true, ...removeRunFolder(o.dir, ctx, [GATES_KIND]) }, 0];
}

async function run(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KINDS);
  const [id, iter, limit] = [gateId(o.id), whole(o.iter ?? 0, "iter", 0, 999), whole(o.timeout, "timeout", 1, 86400)];
  const cwd = resolve(o.cwd || process.cwd());
  if (!existsSync(cwd)) throw new Stop("no-cwd", `--cwd 폴더가 없다: ${cwd}`);
  requireGitTree(cwd, ctx.env);
  const { seq, output, fd } = newOutput(d, id, iter);
  const startedAt = new Date().toISOString();
  const r = await execute({ cmd: o.cmd, cwd, limitMs: limit * 1000, fd }, ctx);
  const out = outputText(output);
  const snap = await snapshot(cwd, ctx.env);
  const v = verdictOf(r, out);
  const record = {
    kind: "observed", id, iter, seq, cmd: o.cmd, cwd, shell: r.shell, startedAt, endedAt: new Date().toISOString(), secs: r.secs,
    exit: r.exit, signal: r.signal, timedOut: r.timedOut, timeout: limit, output, outputSha256: hashFile(createHash, output), bytes: out.size,
    git: snap.git, fingerprint: snap.fingerprint, verdict: v.verdict, why: v.why,
    signature: v.verdict === "pass" ? null : signatureOf(id, v.verdict, out.text, [cwd, snap.root]),
  };
  append(d, record);
  return [record, 0];
}

function note(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KINDS);
  const record = { kind: "reported", id: gateId(o.id), iter: whole(o.iter ?? 0, "iter", 0, 999), exit: o.exit === undefined ? null : Number(o.exit),
    text: String(o.text).slice(0, 4000), at: new Date().toISOString(), seq: claimSeq(d) };
  append(d, record);
  return [record, 0];
}

async function gate(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KINDS);
  const gates = String(o.gates).split(",").map((g) => g.trim()).filter(Boolean).map((g) => gateId(g.replace(/^custom:.*$/s, "custom")));
  const evidence = readEvidence(d);
  const snap = await snapshot(resolve(o.cwd || process.cwd()), ctx.env);
  const result = gateConjunct(evidence, gates, snap.fingerprint, whole(o.iter, "iter", 0, 999));
  return [{ ...result, fingerprint: snap.fingerprint, repeatedFailures: repeatedFailures(evidence) }, result.ok ? 0 : 1];
}

function verify(o, ctx) {
  const { d } = runFolder(o.dir, ctx, KINDS);
  const checked = readEvidence(d).filter((r) => r.kind === "observed").map((r) => {
    let now = null;
    try {
      now = hashFile(createHash, r.output);
    } catch {
      /* gone */
    }
    return { seq: r.seq, id: r.id, output: r.output, state: now === null ? "missing" : now === r.outputSha256 ? "same" : "changed" };
  });
  const bad = checked.filter((c) => c.state !== "same");
  return [{ ok: bad.length === 0, checked: checked.length, bad }, bad.length ? 1 : 0];
}

async function fingerprint(o, ctx) {
  const snap = await snapshot(resolve(o.cwd || process.cwd()), ctx.env);
  return [snap, 0];
}

const COMMANDS = { init, cleanup, run, note, gate, verify, fingerprint };

// A stop as JSON: what it is, its line, its paths, and for not-a-git-tree the folder it checked.
const stopJson = (e) => ({ ok: false, stop: e.code, message: `gate-evidence: ${e.message}`, detail: e.detail, ...(e.checked ? { checked: e.checked } : {}) });

// A usage error and an internal one on stderr (2), a stop as JSON on stdout (3).
function failure(e, out, err) {
  if (e instanceof Stop) {
    out.write(`${JSON.stringify(stopJson(e), null, 2)}\n`);
    return 3;
  }
  err.write(e instanceof Usage ? `gate-evidence: ${e.message}\n` : `gate-evidence: 내부 오류(${e?.code || e?.name || "error"}): ${String(e?.message || e).split("\n")[0]}\n`);
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
