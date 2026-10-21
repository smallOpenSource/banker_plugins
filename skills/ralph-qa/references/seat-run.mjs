#!/usr/bin/env node
/**
 * seat-run: the external seat send of ralph-qa (the skill's "외부 좌석 전송") as one program: the folders, the
 * payload and its checks, the seats with their read-only guards and time limit, and the cleanup. The skill gives it
 * paths and choices; no seat command or git chain is put together by hand.
 *
 *   node seat-run.mjs init                                         the payload folder <d> and the answer folder <o>
 *   node seat-run.mjs untracked --repo <repo> [--folder <folder>]  the new files git does not track, by exact name
 *   node seat-run.mjs prepare --dir <d> --repo <repo> --base <base|auto> --id <id>   short.md + spec.md -> prompt.md
 *   node seat-run.mjs check --dir <d>                              prompt.md again, after the author masked it
 *   node seat-run.mjs send --dir <d> --runtime claude|codex --seat <cli>=<model|@cli-default> ...
 *                     [--effort <v>] [--allow-large] [--split <cli>=<n>] [--limit <s>] [--dry-run]
 *   node seat-run.mjs cleanup --dir <d> [--force]                  the seat records, old runs' folders, <d> and <o>
 *   node seat-run.mjs put --dir <d> --name short.md|spec.md        writes the file from standard input
 *
 * Out: one JSON object on stdout, the same in <d>/result-<command>.md (a PowerShell 5.1 console may garble it), and
 * `ralph-qa: ` lines on stderr. Exit 0 done, 1 secret-like lines, 2 a usage or internal error, 3 a stop (`stop` in
 * the JSON says which), 4 a payload past 512 KiB, 5 a send of the folder still runs. Every file name ends in .md
 * (the DRM of a closed network encrypts files by their extension, and .md is one it leaves readable).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY, cleanSeat, policyIntact, strayEnvFiles, sweepBase } from "./gemini-seat.mjs";
import { scan } from "./payload-scan.mjs";
import { MAX_BYTES, Stop, buildPayload, checkPayload, gitAt, markerCount, readRun, splitPayload, untracked } from "./seat-payload.mjs";
import { cmdLine, runLimited, stopAll, which } from "./seat-spawn.mjs";
import { CLI_DEFAULT, probe as localProbe, safeModel } from "./verifier-probe.mjs";

// The stops a command may end with, as `stop` in its JSON; the skill's table of what to do holds the same set.
export const STOP_CODES = ["index-missing", "no-diff", "list", "binary-diff", "range-source", "range-link", "range-outside", "file", "markers",
  "spec", "not-a-repo", "base-invalid", "git-failed", "git-timeout", "scan", "too-large", "sent", "sandboxed", "base-not-private",
  "base-not-writable", "inside-repo", "busy", "not-prepared", "not-a-run-folder", "split"];
const EXIT_OF = { scan: 1, "too-large": 4, busy: 5 };

const DAY_MS = 86400 * 1000;
const STALE_LOCK_MS = 15 * 60 * 1000;
const RUN_NAME = /^ralph-qa\.[A-Za-z0-9]+$/;
// A run folder of any version: bash's six characters, PowerShell's 32 of a guid, this runner's six.
const ANY_RUN = /^ralph-qa(-out)?\.[A-Za-z0-9]+$/;
const LOCK = /^\.running-(\d+)\.md$/;

class Usage extends Error {}
const USAGE = "usage: node seat-run.mjs init | untracked --repo <repo> [--folder <f>] | prepare --dir <d> --repo <repo> --base <base|auto> --id <id>"
  + " | check --dir <d> | send --dir <d> --runtime claude|codex --seat <cli>=<model> ... | cleanup --dir <d> [--force] | put --dir <d> --name short.md|spec.md\n";

// The flags of each command: a plain name takes one value, `*` takes many, `!` takes none.
const FLAGS = {
  init: [], untracked: ["repo", "folder"], prepare: ["dir", "repo", "base", "id"], check: ["dir"],
  send: ["dir", "runtime", "seat*", "effort", "allow-large!", "split*", "limit", "dry-run!"], cleanup: ["dir", "force!"], put: ["dir", "name"],
};
const REQUIRED = { untracked: ["repo"], prepare: ["dir", "repo", "base", "id"], check: ["dir"], send: ["dir", "runtime", "seat"], cleanup: ["dir"], put: ["dir", "name"] };

function takeFlag(o, flag, name, value) {
  if (flag.endsWith("*")) (o[name] = o[name] || []).push(value);
  else if (name in o) throw new Usage(`--${name} 를 두 번 줬다`);
  else o[name] = value;
}

// One flag at rest[i] into o; gives the index of the next one.
function readFlag(spec, rest, i, o) {
  const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(rest[i]);
  const flag = m && spec.find((f) => f.replace(/[*!]$/, "") === m[1]);
  if (!flag) throw new Usage(`모르는 인자다: ${String(rest[i]).slice(0, 80)}`);
  if (flag.endsWith("!")) {
    o[m[1]] = true;
    return i + 1;
  }
  const value = m[2] !== undefined ? m[2] : rest[i + 1];
  if (value === undefined) throw new Usage(`--${m[1]} 에 값이 없다`);
  takeFlag(o, flag, m[1], value);
  return m[2] !== undefined ? i + 1 : i + 2;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const spec = Object.prototype.hasOwnProperty.call(FLAGS, command) ? FLAGS[command] : null;
  if (!spec) throw new Usage(`모르는 명령이다: ${command ?? "(없음)"}`);
  const o = {};
  for (let i = 0; i < rest.length; ) i = readFlag(spec, rest, i, o);
  for (const r of REQUIRED[command] || []) if (!(r in o)) throw new Usage(`--${r} 가 필요하다`);
  return { command, o };
}

const lstatOr = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const isFile = (p) => Boolean(lstatOr(p)?.isFile());
const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// A folder init made: named ralph-qa.<letters and digits>, a folder and no link, with its marker. Its answer folder
// is the sibling ralph-qa-out.<the same>.
export function runFolder(dir) {
  const d = resolve(String(dir));
  if (!RUN_NAME.test(basename(d)) || !lstatOr(d)?.isDirectory() || !isFile(join(d, ".ralph-qa"))) {
    throw new Stop("not-a-run-folder", `init 이 만든 폴더가 아니다: ${d}`);
  }
  const o = join(dirname(d), basename(d).replace(/^ralph-qa\./, "ralph-qa-out."));
  const answers = lstatOr(o);
  return { d, o: answers?.isDirectory() && isFile(join(o, ".ralph-qa")) ? o : null };
}

const homeOf = (ctx) => (ctx.platform === "win32" ? ctx.env.USERPROFILE : ctx.env.HOME) || homedir();
const norm = (ctx, p) => (ctx.platform === "win32" ? p.toLowerCase() : p);
const realOr = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

// A folder only this account may write in (POSIX: its own, no group or other write bit).
function privateDir(p) {
  try {
    const st = statSync(p);
    return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}
const insideHome = (ctx, p) => norm(ctx, realOr(p)).startsWith(norm(ctx, realOr(homeOf(ctx))) + sep);

// The base for this run's folders, and every base a run of any version may have used, for the day rule. Linux: an
// XDG_RUNTIME_DIR of this account's own, else ~/.cache; macOS: $TMPDIR (its own per account); Windows: %TEMP% when it
// is inside the home, else ~/.cache (the old Git Bash runs used ~/.cache). Never /tmp: gemini reads a .env it finds
// walking up from its folder, and another account may put one there.
export function bases(ctx) {
  const cache = join(homeOf(ctx), ".cache");
  const base = baseOn(ctx, cache);
  const xdg = ctx.platform === "linux" && ctx.env.XDG_RUNTIME_DIR ? [resolve(ctx.env.XDG_RUNTIME_DIR)] : [];
  return { base, known: [...new Set([base, cache, ...xdg])] };
}

function baseOn(ctx, cache) {
  const { env } = ctx;
  if (ctx.platform === "win32") return env.TEMP && insideHome(ctx, env.TEMP) ? resolve(env.TEMP) : cache;
  if (ctx.platform === "darwin") return env.TMPDIR ? resolve(env.TMPDIR) : cache;
  const xdg = env.XDG_RUNTIME_DIR;
  return xdg && isAbsolute(xdg) && privateDir(xdg) ? resolve(xdg) : cache;
}

function readyBase(ctx, base) {
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Stop("base-not-writable", `기준 폴더를 만들 수 없다(${e.code}): ${base}`);
  }
  if (ctx.platform !== "win32" && !privateDir(base)) throw new Stop("base-not-private", `기준 폴더를 다른 계정도 쓸 수 있다: ${base}`);
}

// Two folders with the same six characters: the payload one by mkdtemp, its answer folder beside it.
function makeFolders(base) {
  for (let tries = 0; tries < 20; tries += 1) {
    const d = mkdtempSync(join(base, "ralph-qa."));
    const o = join(base, basename(d).replace(/^ralph-qa\./, "ralph-qa-out."));
    try {
      mkdirSync(o, { mode: 0o700 });
      for (const p of [d, o]) writeFileSync(join(p, ".ralph-qa"), "", { mode: 0o600 });
      return { d, o };
    } catch (e) {
      rmSync(d, { recursive: true, force: true });
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Stop("base-not-writable", `기준 폴더에 새 폴더 이름을 정하지 못했다: ${base}`);
}

// Whether `dir` is inside a git work tree: a seat would then read the repo through its tools.
function insideRepo(ctx, dir) {
  try {
    return gitAt(dir, ctx.env, dir)(["rev-parse", "--git-dir"], { ok: [0, 128] }).status === 0;
  } catch {
    return false; // no git: no repo either
  }
}

function init(_o, ctx) {
  const { base } = bases(ctx);
  readyBase(ctx, base);
  let made;
  try {
    made = makeFolders(base);
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw new Stop("base-not-writable", `기준 폴더에 쓸 수 없다(${e.code}): ${base}`);
  }
  if (insideRepo(ctx, made.d)) {
    for (const p of [made.d, made.o]) rmSync(p, { recursive: true, force: true });
    throw new Stop("inside-repo", `기준 폴더가 git 저장소 안이다: ${base}`);
  }
  return [{ ok: true, dir: made.d, out: made.o, base }, 0, made.d];
}

function listUntracked(o, ctx) {
  return [{ ok: true, ...untracked({ repo: o.repo, env: ctx.env, folder: o.folder || null }) }, 0, null];
}

const sent = (d) => existsSync(join(d, "result-send.md"));
const refuseSent = (d) => {
  if (sent(d)) throw new Stop("sent", `이미 보낸 폴더다. 반복마다 init 으로 새 폴더를 만든다: ${d}`);
};

// prepare and check end with 1 when a line looks like a secret and 4 past 512 KiB; the JSON carries both.
function verdict(result) {
  if (result.scan.count) {
    const lines = result.scan.hits.map((h) => `${h.line}(${h.kind}${h.end === null ? ", 끝 줄 없음" : ""})`);
    return [{ ...result, ok: false, stop: "scan", message: `ralph-qa: 비밀처럼 보이는 줄이 있다: ${lines.join(", ")}. 값을 [REDACTED] 로 가린 뒤 check 를 다시 한다` }, 1];
  }
  if (result.bytes > MAX_BYTES) {
    return [{ ...result, ok: false, stop: "too-large", message: `ralph-qa: 페이로드가 512 KiB 를 넘는다(${result.bytes}바이트). 보내기 전에 사용자에게 묻는다` }, 4];
  }
  return [{ ...result, ok: true }, 0];
}

function prepare(o, ctx) {
  const { d } = runFolder(o.dir);
  refuseSent(d);
  const built = buildPayload({ dir: d, repo: o.repo, base: o.base, id: o.id, env: ctx.env });
  const [result, code] = verdict({ dir: d, prompt: join(d, "prompt.md"), raw: join(d, "raw.md"), unsentFile: join(d, "unsent.md"), ...built });
  return [result, code, d];
}

function check(o) {
  const { d } = runFolder(o.dir);
  const id = readRun(d).id;
  const c = checkPayload({ dir: d, id });
  if (c.markers !== 2) throw new Stop("markers", `표지가 두 줄이 아니다(${c.markers}줄). 가리다 표지를 지웠으면 prepare 를 다시 한다`);
  const [result, code] = verdict({ dir: d, prompt: join(d, "prompt.md"), bytes: c.bytes, markers: c.markers, scan: c.scan });
  return [result, code, d];
}

const readStdin = (ctx) => {
  if (ctx.stdin !== undefined) return Buffer.from(ctx.stdin);
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
};

function put(o, ctx) {
  if (!["short.md", "spec.md"].includes(o.name)) throw new Usage(`--name 은 short.md 나 spec.md 다: ${String(o.name).slice(0, 80)}`);
  const { d } = runFolder(o.dir);
  refuseSent(d);
  const data = readStdin(ctx);
  writeFileSync(join(d, o.name), data, { mode: 0o600 });
  return [{ ok: true, written: join(d, o.name), bytes: data.length }, 0, d];
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// A send of the folder that still runs: a lock of a live process, newer than 15 minutes (a lock left by a send that
// was killed, or one whose number another process now has, goes stale).
export function liveLock(d, now = Date.now()) {
  for (const name of listDir(d)) {
    const m = LOCK.exec(name);
    const st = m && lstatOr(join(d, name));
    if (st && Number(m[1]) !== process.pid && now - st.mtimeMs < STALE_LOCK_MS && alive(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

// The day rule: folders of an earlier run, marked, past a day, never a link or a folder without the marker.
function dayRule(base, now) {
  const removed = [];
  for (const name of listDir(base)) {
    const p = join(base, name);
    const st = ANY_RUN.test(name) ? lstatOr(p) : null;
    if (!st?.isDirectory() || now - st.mtimeMs <= DAY_MS || !isFile(join(p, ".ralph-qa"))) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// An opencode session of this run, or of a seat folder under one of the bases that is gone (a run cut short).
// opencode records the folder resolved through links (macOS's /var is a link to /private/var).
function staleSession(ctx, s, forms) {
  if (typeof s?.title !== "string" || !SESSION_ID.test(String(s.id))) return false;
  return (Boolean(ctx.id) && s.title === `ralph-qa-review-${ctx.id}`) || goneSeat(ctx, s, forms);
}
function goneSeat(ctx, s, forms) {
  const dir = String(s.directory || "");
  if (!s.title.startsWith("ralph-qa-review-") || basename(dir) !== "opencode" || !RUN_NAME.test(basename(dirname(dir)))) return false;
  return forms.has(norm(ctx, dirname(dirname(dir)))) && !existsSync(dir);
}

async function opencodeCall(ctx, exe, args, out) {
  const env = { ...ctx.env, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
  return runLimited({ exe, args, cwd: ctx.d, env, stdin: "ignore", stdout: out, stderr: "ignore", limitMs: 60000 });
}

async function opencodeSessions(ctx, known) {
  const exe = which("opencode", { env: ctx.env, platform: ctx.platform });
  if (!exe) return { deleted: 0, note: "opencode 가 없다" };
  const out = join(ctx.d, ".opencode-sessions.md");
  const r = await opencodeCall(ctx, exe, ["session", "list", "--pure", "--format", "json"], out);
  let sessions = [];
  try {
    sessions = r.exit === 0 ? JSON.parse(readFileSync(out, "utf8")) : [];
  } catch {
    return { deleted: 0, note: "opencode 의 세션 목록을 읽지 못했다" };
  }
  const forms = new Set(known.flatMap((b) => [norm(ctx, b), norm(ctx, realOr(b))]));
  let deleted = 0;
  for (const s of Array.isArray(sessions) ? sessions.filter((x) => staleSession(ctx, x, forms)) : []) {
    if ((await opencodeCall(ctx, exe, ["session", "delete", String(s.id), "--pure"], "ignore")).exit === 0) deleted += 1;
  }
  return { deleted };
}

const readIdOr = (d) => {
  try {
    return readRun(d).id;
  } catch {
    return null;
  }
};

async function cleanup(o, ctx) {
  const { d, o: out } = runFolder(o.dir);
  const pid = o.force ? null : liveLock(d, ctx.now());
  if (pid) throw new Stop("busy", `이 폴더의 send 가 아직 돈다(pid ${pid}). 끝난 뒤 다시 한다`);
  const { known } = bases(ctx);
  const all = [...new Set([dirname(d), ...known])];
  const gemini = cleanSeat(join(d, "gemini"), { env: ctx.env, platform: ctx.platform });
  const swept = all.flatMap((b) => dayRule(b, ctx.now()));
  for (const b of all) gemini.skipped.push(...sweepBase(b, { env: ctx.env, platform: ctx.platform }).skipped);
  for (const p of gemini.skipped) ctx.stderr.write(`ralph-qa: gemini 기록 폴더를 남겼다(두 프로젝트가 그 이름을 씀): ${p}\n`);
  const opencode = await opencodeSessions({ ...ctx, d, id: readIdOr(d) }, all);
  for (const p of [d, out]) if (p) rmSync(p, { recursive: true, force: true });
  return [{ ok: true, removed: [d, out].filter(Boolean), swept, gemini, opencode }, 0, null];
}

// ---- send

// Why a seat was not sent (`not-sent`) or its run counts for nothing (`failed`); `probe:<reason>` carries the probe's.
export const SEAT_WHY = ["rejected", "timeout", "exit", "signal", "spawn", "empty", "verdict", "policy-file-error", "fallback-agent",
  "model-mismatch", "default-model-family", "probe", "unsafe-model", "cli-absent", "unsafe-word", "gemini-policy", "gemini-env-file",
  "opencode-agent", "split", "payload"];
const LIMIT_S = 600;
const CHECK_LIMIT_MS = 120000;
// Lines of a seat's errors that say the provider refused the model (the author may then seat another, before a first verdict).
const REJECT_HINT = /\b40[34]\b|model_not_found|model not found|does not exist|PERMISSION_DENIED|permission denied/i;
const VERDICT_LINE = /^VERDICT: (APPROVE|ITERATE|REJECT|ERROR)\s*$/;
const RANK = { APPROVE: 0, ITERATE: 1, REJECT: 2, ERROR: 3 };

function seatArg(v) {
  const m = /^(codex|gemini|opencode)=([\s\S]+)$/.exec(String(v));
  if (!m) throw new Usage(`--seat 은 <cli>=<모델> 이다(cli 는 codex, gemini, opencode): ${String(v).slice(0, 80)}`);
  return { cli: m[1], model: m[2] };
}
function splitArg(v) {
  const m = /^(codex|gemini|opencode)=(\d{1,2})$/.exec(String(v));
  if (!m || Number(m[2]) < 2) throw new Usage(`--split 은 <cli>=<2 이상의 수> 다: ${String(v).slice(0, 80)}`);
  return [m[1], Number(m[2])];
}
function limitOf(o) {
  const limit = o.limit === undefined ? LIMIT_S : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_S) throw new Usage(`--limit 은 1~600 초다: ${String(o.limit).slice(0, 40)}`);
  return limit * 1000;
}
function sendArgs(o) {
  if (!["claude", "codex"].includes(o.runtime)) throw new Usage(`--runtime 은 claude 나 codex 다: ${String(o.runtime).slice(0, 40)}`);
  const seats = o.seat.map(seatArg);
  if (seats.length > 3 || new Set(seats.map((x) => x.cli)).size !== seats.length) throw new Usage("--seat 는 CLI 마다 한 번, 셋까지다");
  const split = Object.fromEntries((o.split || []).map(splitArg));
  for (const cli of Object.keys(split)) if (!seats.some((x) => x.cli === cli)) throw new Usage(`--split 의 ${cli} 는 보내는 좌석이 아니다`);
  if (o.effort !== undefined && !/^[a-z]{1,16}$/.test(o.effort)) throw new Usage(`--effort 값이 아니다: ${String(o.effort).slice(0, 40)}`);
  return { seats, split, limitMs: limitOf(o), effort: o.effort, runtime: o.runtime, dryRun: Boolean(o["dry-run"]) };
}

// What goes out, read once: the same bytes are checked here and copied for every seat.
function payloadToSend(d, id, allowLarge) {
  let buf;
  try {
    buf = readFileSync(join(d, "prompt.md"));
  } catch {
    throw new Stop("not-prepared", `prompt.md 가 없다. prepare 를 먼저 한다: ${d}`);
  }
  const markers = markerCount(buf, id);
  if (markers !== 2) throw new Stop("markers", `표지가 두 줄이 아니다(${markers}줄). 가리다 표지를 지웠으면 prepare 를 다시 한다`);
  let found;
  try {
    found = scan(buf.toString("utf8"));
  } catch (e) {
    throw new Stop("scan", `비밀 검사를 끝내지 못해 보내지 않는다(${String(e?.message || e).split("\n")[0]})`);
  }
  if (found.count) throw new Stop("scan", `비밀처럼 보이는 줄이 있어 보내지 않는다: ${found.hits.map((h) => h.line).join(", ")}. 가린 뒤 check 를 다시 한다`);
  if (buf.length > MAX_BYTES && !allowLarge) throw new Stop("too-large", `페이로드가 512 KiB 를 넘는다(${buf.length}바이트). 사용자가 보내기로 하면 --allow-large 로 다시 한다`);
  return buf;
}

const modelFlag = (model) => (model === CLI_DEFAULT ? [] : ["-m", model]);
const OPENCODE_DENY = '{"*":"deny"}';
// The commands of the 0.20.4 skill's bash block, word for word, as plans: arguments, what is set and unset in the
// env, and the check run first (opencode). `part` names the files of a split part.
const PLANS = {
  codex: (p, f) => ({
    args: ["exec", "-C", f.cwd, "--ephemeral", "--ignore-rules", ...["multi_agent", "hooks", "plugins", "apps", "shell_tool"].flatMap((x) => ["--disable", x]),
      "-c", "notify=[]", "-c", "analytics.enabled=false", "-c", "web_search=disabled", ...(p.mcpServers || []).flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]),
      "-c", 'otel.exporter="none"', "-c", 'otel.trace_exporter="none"', "-c", 'otel.metrics_exporter="none"',
      ...(p.effort ? ["-c", `model_reasoning_effort=${p.effort}`] : []), ...modelFlag(p.model), "-s", "read-only", "--skip-git-repo-check", "-o", f.answer, "-"],
    stdout: join(p.o, `stdout-codex${f.sfx}.md`), set: {}, unset: [], check: null,
  }),
  gemini: (p, f) => ({
    args: ["--skip-trust", "--approval-mode", "default", "--admin-policy", p.policy, "--allowed-mcp-server-names", "ralph-qa-none", "-e", "none",
      ...modelFlag(p.model), "-p", "첨부한 검토 지시를 따르라"],
    stdout: f.answer, set: { TMPDIR: p.o, TEMP: p.o, TMP: p.o, GEMINI_SANDBOX: "false", GEMINI_TELEMETRY_LOG_PROMPTS: "false" }, unset: ["GEMINI_CLI_IDE_WORKSPACE_PATH"], check: null,
  }),
  opencode: (p, f) => {
    const agent = `ralph-qa-review-${p.id}`;
    const config = { share: "disabled", agent: { compaction: { disable: true }, [agent]: { mode: "primary", description: "ralph-qa reviewer", permission: { "*": "deny" } } } };
    return {
      args: ["run", "--pure", "--agent", agent, "--title", agent, ...modelFlag(p.model), "아래 검토 지시를 따르라"], stdout: f.answer, unset: [],
      set: { OPENCODE_PERMISSION: OPENCODE_DENY, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
      check: ["debug", "agent", agent, "--pure"],
    };
  },
};

export function seatPlan(p) {
  const sfx = p.part ? `-${p.part}` : "";
  const cwd = join(p.d, p.cli);
  const f = { cwd, sfx, answer: join(p.o, `out-${p.cli}${sfx}.md`) };
  return { cwd, stdin: join(cwd, `prompt${sfx}.md`), stderr: join(p.o, `err-${p.cli}${sfx}.md`), answer: f.answer, ...PLANS[p.cli](p, f) };
}

// The seat's env: the runner's, without what the plan unsets (on Windows whatever the case of a name), with what it sets.
function seatEnv(ctx, plan) {
  const win = ctx.platform === "win32";
  const drop = new Set([...plan.unset, ...(win ? Object.keys(plan.set) : [])].map((k) => (win ? k.toUpperCase() : k)));
  const kept = Object.entries(ctx.env).filter(([k]) => !drop.has(win ? k.toUpperCase() : k));
  return { ...Object.fromEntries(kept), ...plan.set };
}

// The probe called again just before the send, with the model chosen: the guards as the config is now, the MCP
// servers to turn off by name. The model is not chosen again.
function reprobe(ctx, seat, runtime) {
  const run = ctx.probe || localProbe;
  const out = run({ requested: { [seat.cli]: seat.model === CLI_DEFAULT ? null : seat.model }, runtime });
  return (out.seats || []).find((x) => x.cli === seat.cli) || { decision: "unseated", reason: "cli-call-failed", notes: out.notes };
}

function guards(ctx, seat, a) {
  if (seat.model !== CLI_DEFAULT && !safeModel(seat.model)) return { why: "unsafe-model" };
  const exe = which(seat.cli, { env: ctx.env, platform: ctx.platform });
  if (!exe) return { why: "cli-absent" };
  const probed = reprobe(ctx, seat, a.runtime);
  if (probed.decision === "unseated") return { why: `probe:${probed.reason}`, notes: probed.notes || [] };
  return { exe, probed };
}

const policyText = () => {
  try {
    return readFileSync(POLICY, "utf8");
  } catch {
    return null;
  }
};

// The checks a seat must pass in its own folder before anything goes: cmd.exe's words, gemini's policy and a .env
// above the folder, opencode's per-run agent.
async function cliChecks(ctx, seat, plan, exe) {
  const viaCmd = ctx.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  if (viaCmd && [plan.check, plan.args].some((args) => args && cmdLine(exe, args) === null)) return "unsafe-word";
  if (seat.cli === "gemini" && !policyIntact(policyText())) return "gemini-policy";
  if (seat.cli === "gemini" && strayEnvFiles(plan.cwd, { env: ctx.env, platform: ctx.platform }).length) return "gemini-env-file";
  if (!plan.check) return null;
  const r = await runLimited({ exe, args: plan.check, cwd: plan.cwd, env: seatEnv(ctx, plan), stdin: "ignore", stdout: "ignore", stderr: "ignore", limitMs: CHECK_LIMIT_MS });
  return r.exit === 0 ? null : "opencode-agent";
}

// The parts a seat gets: the payload, or its split, each with its two markers and no secret-like line.
function partsOf(payload, n, id) {
  const parts = n ? splitPayload(payload, n, id) : [payload];
  parts.forEach((part, k) => {
    if (markerCount(part, id) !== 2 || scan(part.toString("utf8")).count) throw new Stop("split", `부분 ${k + 1}/${parts.length} 의 표지나 검사가 맞지 않는다`);
  });
  return parts;
}

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// What a seat's answer and errors say.
function factsOf(cli, plan) {
  const out = readText(plan.answer);
  const err = readText(plan.stderr);
  const facts = { verdicts: out.split(/\r?\n/).map((l) => VERDICT_LINE.exec(l)).filter(Boolean).map((m) => m[1]), empty: !out.trim() };
  if (cli === "codex") facts.ranModel = (/^model: (\S+)/m.exec(err.split("\n").slice(0, 40).join("\n")) || [])[1] || null;
  if (cli === "gemini") Object.assign(facts, { policyError: err.includes("Policy file error"), apiError: err.includes("Full report") });
  if (cli === "opencode") facts.fallback = err.includes("Falling back to default agent");
  const hint = err.split("\n").find((l) => REJECT_HINT.test(l));
  if (hint) facts.rejectHint = hint.trim().slice(0, 200);
  return facts;
}

// A run that ended without an answer to read: why, or null.
function processWhy(r) {
  if (r.error) return "spawn";
  if (r.timedOut) return "timeout";
  if (r.stopped || r.signal) return "signal";
  return null;
}
// An answer that cannot count: why, or null.
function answerWhy(r, f, seat) {
  if (f.policyError) return "policy-file-error";
  if (f.fallback) return "fallback-agent";
  if (r.exit !== 0) return f.rejectHint ? "rejected" : "exit";
  if (f.empty) return "empty";
  if (f.verdicts.length !== 1) return "verdict";
  if (seat.cli === "codex" && seat.model !== CLI_DEFAULT && f.ranModel !== seat.model) return "model-mismatch";
  return null;
}

// Run with @cli-default, codex ran what its config names: the author's own family, or one the probe cannot tell, does not count.
function defaultFamilyWhy(ctx, seat, a, f) {
  if (seat.cli !== "codex" || seat.model !== CLI_DEFAULT) return null;
  if (!f.ranModel || !safeModel(f.ranModel)) return "default-model-family";
  const again = reprobe(ctx, { cli: "codex", model: f.ranModel }, a.runtime);
  return again.decision === "unseated" || again.familyKnown === false ? "default-model-family" : null;
}

export const gathered = (verdicts) => verdicts.reduce((worst, v) => (RANK[v] > RANK[worst] ? v : worst), "APPROVE");

async function runPart(ctx, run, seat, g, part, k, count) {
  const plan = seatPlan({ cli: seat.cli, model: seat.model, effort: run.effort, mcpServers: g.probed.mcpServers || [], d: run.d, o: run.o, id: run.id, policy: POLICY, part: count > 1 ? k + 1 : 0 });
  writeFileSync(plan.stdin, part, { mode: 0o600 });
  if (run.signalled()) return { why: "signal", r: { exit: null, signal: null, secs: 0 }, f: {}, plan };
  const r = await runLimited({ exe: g.exe, args: plan.args, cwd: plan.cwd, env: seatEnv(ctx, plan), stdin: plan.stdin, stdout: plan.stdout, stderr: plan.stderr, limitMs: run.limitMs });
  const f = processWhy(r) ? {} : factsOf(seat.cli, plan);
  const why = processWhy(r) || answerWhy(r, f, seat) || defaultFamilyWhy(ctx, seat, run, f);
  return { why, r, f, plan };
}

const factsShown = (f) => Object.fromEntries(Object.entries({ verdict: f.verdicts?.length === 1 ? f.verdicts[0] : undefined, ranModel: f.ranModel,
  apiError: f.apiError || undefined, rejectHint: f.rejectHint }).filter(([, v]) => v !== undefined && v !== null));

// Sends the parts in order; the first that fails ends the seat's run (the seat is ERROR whatever the rest say).
async function runParts(ctx, run, seat, g, parts, base) {
  const done = [];
  for (const [k, part] of parts.entries()) {
    const one = await runPart(ctx, run, seat, g, part, k, parts.length);
    done.push(one);
    if (one.why) break;
  }
  const last = done[done.length - 1];
  const secs = Math.round(done.reduce((t, x) => t + (x.r.secs || 0), 0) * 10) / 10;
  const result = { ...base, status: last.why ? "failed" : "answered", why: last.why, exit: last.r.exit, signal: last.r.signal, secs,
    answer: last.plan.answer, errors: last.plan.stderr, facts: factsShown(last.f) };
  if (!last.why && parts.length > 1) result.facts.verdict = gathered(done.map((x) => x.f.verdicts[0]));
  if (parts.length > 1) result.parts = done.map((x) => ({ answer: x.plan.answer, errors: x.plan.stderr, why: x.why, facts: factsShown(x.f) }));
  return result;
}

// What a seat's run leaves is taken away when it returns: gemini's record of its folder, this run's opencode session,
// the seat's copy of the payload.
async function afterSeat(ctx, run, seat) {
  const notes = [];
  if (seat.cli === "gemini") notes.push(...cleanSeat(join(run.d, "gemini"), { env: ctx.env, platform: ctx.platform }).skipped.map((p) => `gemini 기록 폴더를 남김: ${p}`));
  if (seat.cli === "opencode") await opencodeSessions({ ...ctx, d: run.d, id: run.id }, []);
  rmSync(join(run.d, seat.cli), { recursive: true, force: true });
  return notes;
}

async function seatWork(ctx, run, seat, g, payload, base) {
  const plan = seatPlan({ cli: seat.cli, model: seat.model, effort: run.effort, mcpServers: g.probed.mcpServers || [], d: run.d, o: run.o, id: run.id, policy: POLICY });
  const why = await cliChecks(ctx, seat, plan, g.exe);
  if (why) return { ...base, why };
  let parts;
  try {
    parts = partsOf(payload, run.split[seat.cli], run.id);
  } catch (e) {
    if (e instanceof Stop) return { ...base, why: "split", notes: [e.message] };
    throw e;
  }
  if (run.dryRun) return { ...base, status: "planned", plan: { exe: g.exe, cwd: plan.cwd, args: plan.args, set: plan.set, unset: plan.unset, check: plan.check, parts: parts.length } };
  return runParts(ctx, run, seat, g, parts, base);
}

async function sendSeat(ctx, run, seat, payload) {
  const base = { seat: seat.cli, model: seat.model, status: "not-sent", why: null, exit: null, signal: null, secs: 0, answer: null, errors: null, facts: {}, notes: [] };
  const g = guards(ctx, seat, run);
  if (g.why) return { ...base, why: g.why, notes: g.notes || [] };
  mkdirSync(join(run.d, seat.cli), { recursive: true, mode: 0o700 });
  let result;
  try {
    result = await seatWork(ctx, run, seat, g, payload, base);
  } finally {
    const notes = await afterSeat(ctx, run, seat);
    if (result) result.notes = [...(result.notes || []), ...notes];
  }
  return result;
}

// SIGINT, SIGTERM and SIGHUP end every seat (TERM to its group, KILL 2 s later), the seats' records are still cleaned,
// and send ends with 128 + the signal's number; past 30 s it ends anyway.
function watchSignals() {
  let code = 0;
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => [sig, () => {
    if (code) return;
    code = 128 + (osConstants.signals[sig] || 0);
    stopAll();
    setTimeout(() => process.exit(code), 30000).unref();
  }]);
  for (const [sig, h] of handlers) process.on(sig, h);
  return { code: () => code, off: () => handlers.forEach(([sig, h]) => process.off(sig, h)) };
}

const DEST = {
  codex: () => "config.toml 이 정한 프로바이더",
  gemini: () => "사용자 설정의 인증",
  opencode: (x) => (x.model === CLI_DEFAULT ? "opencode 설정의 프로바이더" : `${x.model.split("/")[0]}(-m 의 프로바이더)`),
};
const unsentCount = (d) => readText(join(d, "unsent.md")).split("\n").filter(Boolean).length;
// The line the report carries: where the payload went, its size, the scan, the new files left out.
function declared(run, bytes, seats, d) {
  const went = seats.filter((x) => x.status !== "not-sent").map((x) => `${x.seat} 는 ${DEST[x.seat](x)}`);
  const head = run.dryRun ? "외부 전송(선언, dry-run 이라 보내지 않음)" : "외부 전송(선언)";
  return `${head}: ${went.join(", ") || "보낸 좌석 없음"}, 페이로드 ${bytes}B, 비밀 검사 0건, 보내지 않은 새 파일 ${unsentCount(d)}`;
}

function sendStart(o, ctx, a) {
  const { d, o: out } = runFolder(o.dir);
  if (!out) throw new Stop("not-a-run-folder", `답 폴더(ralph-qa-out.*)가 없다: ${d}`);
  refuseSent(d);
  if (ctx.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" && !a.dryRun) throw new Stop("sandboxed", "Codex sandbox 가 네트워크를 막는다. 승인을 받아 sandbox 밖에서 send 를 다시 한다");
  const { id } = readRun(d);
  const payload = payloadToSend(d, id, Boolean(o["allow-large"]));
  const pid = liveLock(d, ctx.now());
  if (pid) throw new Stop("busy", `이 폴더의 send 가 아직 돈다(pid ${pid})`);
  return { d, out, id, payload };
}

async function send(o, ctx) {
  const a = sendArgs(o);
  const { d, out, id, payload } = sendStart(o, ctx, a);
  const lock = join(d, `.running-${process.pid}.md`);
  writeFileSync(lock, `${process.pid} ${new Date(ctx.now()).toISOString()}\n`, { mode: 0o600 });
  const signals = watchSignals();
  const run = { ...a, d, o: out, id, signalled: () => signals.code() !== 0 };
  try {
    const seats = await Promise.all(a.seats.map((x) => sendSeat(ctx, run, x, payload)));
    const result = { ok: true, ...(a.dryRun ? { dryRun: true } : {}), dir: d, out, bytes: payload.length, scan: 0, unsent: unsentCount(d), seats, declared: declared(run, payload.length, seats, d) };
    return [result, signals.code(), a.dryRun ? null : d];
  } finally {
    signals.off();
    rmSync(lock, { force: true });
  }
}

const COMMANDS = { init, untracked: listUntracked, prepare, check, send, cleanup, put };

// The JSON on stdout and in <d>/result-<command>.md (not for cleanup: the folder is gone).
function report(ctx, command, dir, result, code, name = command) {
  const json = `${JSON.stringify({ command, ...result }, null, 2)}\n`;
  ctx.stdout.write(json);
  if (result.message) ctx.stderr.write(`${result.message}\n`);
  if (dir) {
    try {
      writeFileSync(join(dir, `result-${name}.md`), json, { mode: 0o600 });
    } catch {
      /* the JSON on stdout is the answer */
    }
  }
  return code;
}

// A stop in the folder it concerns, when that is a run folder.
const folderOf = (o) => {
  try {
    return o.dir ? runFolder(o.dir).d : null;
  } catch {
    return null;
  }
};

// A send that stopped goes to result-send-stop.md: result-send.md says the folder was sent, and a stopped send sent nothing.
const stopName = (command) => (command === "send" ? "send-stop" : command);

function failed(ctx, { command, o }, e) {
  if (e instanceof Usage) {
    ctx.stderr.write(`ralph-qa: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (!(e instanceof Stop)) {
    ctx.stderr.write(`ralph-qa: 실행기 내부 오류(${e?.code || e?.name || "error"}): ${String(e?.message || e).split("\n")[0]}\n`);
    return 2;
  }
  const result = { ok: false, stop: e.code, message: e.message, detail: e.detail };
  return report(ctx, command, folderOf(o), result, EXIT_OF[e.code] || 3, stopName(command));
}

export async function main(argv, io = {}) {
  const ctx = {
    env: io.env || process.env, platform: io.platform || process.platform, stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr,
    stdin: io.stdin, probe: io.probe, now: io.now || Date.now,
  };
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return failed(ctx, { command: argv[0], o: {} }, e);
  }
  try {
    const [result, code, dir] = await COMMANDS[parsed.command](parsed.o, ctx);
    return report(ctx, parsed.command, dir, result, code);
  } catch (e) {
    return failed(ctx, parsed, e);
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
