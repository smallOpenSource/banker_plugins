#!/usr/bin/env node
/**
 * smart-compact for Codex: a UserPromptSubmit hook that tells the session when its context passes a threshold.
 *
 *   node codex-gate.mjs on [--threshold N]   arm: save N (default 50), copy the hook, add it to hooks.json
 *   node codex-gate.mjs off                  disarm: take the hook out, with its copy, threshold and state
 *   node codex-gate.mjs status               say whether it is armed and the hook is in place and current
 *   node codex-gate.mjs usage <rollout>      print the context use the session record shows
 *   node codex-gate.mjs hook                 the hook itself (Codex runs it; reads the hook input on stdin)
 *
 * Codex gives a hook no context percentage, but every hook input carries transcript_path, the session record
 * (rollout). Its token_count events hold last_token_usage and model_context_window, so the use of the last
 * request over the window is the context use (measured on Codex 0.144.5).
 * Files live in <CODEX_HOME> (default ~/.codex): smart-compact.json (threshold), smart-compact-state.json
 * (sessions told), hooks.json.smart-compact.bak (hooks.json before each change) and the hook itself, copied to
 * hooks-custom/banker-smart-compact-gate.mjs. Codex runs a trusted hook outside the sandbox, so the hook runs from
 * that copy, where a sandboxed session cannot write, and not from a skill folder that may sit in a workspace.
 * Codex trusts a hook by its handler and records the trust under the group's index: the threshold lives in a file
 * so the command never changes with it, and the group is appended after the ones there, so OMX's hooks keep
 * their indexes. On Windows Codex runs a hook command through PowerShell (measured on Codex 0.160.1), so the
 * command there is `& '<node>' '<script>' hook`.
 * The hook speaks once per session while the use stays at or over the threshold, and again after the use has
 * dropped below it (after /compact). It never blocks a prompt: any error leaves it silent with exit 0.
 * Exit status 1 means nothing was changed; 2 means an unexpected error stopped the command.
 */
import {
  chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const COPY_NAME = "banker-smart-compact-gate.mjs";
const KEEP_SESSIONS = 50;
const MAX_READ = 32 << 20;

export function paths(env = process.env) {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  return {
    home,
    hooks: join(home, "hooks.json"),
    config: join(home, "smart-compact.json"),
    state: join(home, "smart-compact-state.json"),
    backup: join(home, "hooks.json.smart-compact.bak"),
    copyDir: join(home, "hooks-custom"),
    copy: join(home, "hooks-custom", COPY_NAME),
  };
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// JSON from a regular file only: a FIFO or a device would stall the hook. null when missing, odd or unreadable.
function readJson(file) {
  try {
    return lstatSync(file).isFile() ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

// A new file beside the target, given the target's mode when there is one, then renamed over it. The temp name is
// created exclusively and a link in the target's place is replaced, not followed. The temp file goes on failure.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    const mode = modeOf(file);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function modeOf(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() ? st.mode & 0o7777 : null;
  } catch {
    return null;
  }
}

const writeJson = (file, value) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

// The last token_count with usage in a rollout, read from the end in growing spans, so a long session costs one
// tail read in the usual case; null past `max` bytes, for a file that is not regular (checked before opening, since
// opening a FIFO waits for a writer), or when none has usage yet (info is null on the first events of a session).
export function lastUsage(file, max = MAX_READ) {
  if (!statSync(file).isFile()) return null;
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    for (let span = 1 << 18; ; span *= 4) {
      const start = Math.max(0, size - Math.min(span, max));
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const found = scanUsage(buf.toString("utf8"), start > 0);
      if (found || start === 0 || span >= max) return found;
    }
  } finally {
    closeSync(fd);
  }
}

function scanUsage(text, cutFirst) {
  const lines = text.split("\n");
  if (cutFirst) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = lines[i].includes('"token_count"') ? usageOf(lines[i]) : null;
    if (found) return found;
  }
  return null;
}

function usageOf(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  const info = rec && rec.payload && rec.payload.type === "token_count" ? rec.payload.info : null;
  return info ? usageIn(info) : null;
}

function usageIn(info) {
  const used = info.last_token_usage ? info.last_token_usage.total_tokens : NaN;
  const win = info.model_context_window;
  return Number.isFinite(used) && Number.isFinite(win) && win > 0 ? { used, window: win } : null;
}

export const percent = (u) => Math.round((u.used * 100) / u.window);

export function nudge(pct, threshold) {
  return `smart-compact: 컨텍스트 사용률 ${pct}% (임계 ${threshold}%). 이번 응답에서 위생 체인을 실행한다: `
    + "$banker-append_wiki, 그다음 한 줄 안내(다음 메시지가 resume 프롬프트이고 그 뒤 /copy, /compact, 붙여 넣기 순서), "
    + "마지막으로 $banker-ready-compact. /copy, /compact, 붙여 넣기는 사용자가 한다.";
}

const text = (o, key) => (o && typeof o[key] === "string" ? o[key] : "");

// The hook's decision for one prompt: the text to inject, or "" for none. Mutates and returns the state.
export function decide(input, config, state) {
  const sid = text(input, "session_id");
  const file = text(input, "transcript_path");
  const usage = config && sid && file ? lastUsage(file) : null;
  if (!usage) return { text: "", state };
  const pct = percent(usage);
  if (pct < config.threshold) {
    delete state[sid];
    return { text: "", state };
  }
  if (state[sid]) return { text: "", state };
  state[sid] = Date.now();
  prune(state);
  return { text: nudge(pct, config.threshold), state };
}

function prune(state) {
  const ids = Object.keys(state).sort((a, b) => state[a] - state[b]);
  for (const old of ids.slice(0, Math.max(0, ids.length - KEEP_SESSIONS))) delete state[old];
}

function validConfig(c) {
  return isObject(c) && Number.isInteger(c.threshold) && c.threshold >= 1 && c.threshold <= 95 ? c : null;
}

async function runHook(p) {
  try {
    process.stdin.setEncoding("utf8");
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const read = readJson(p.state);
    const before = isObject(read) ? read : {};
    const was = JSON.stringify(before);
    const { text: say, state } = decide(JSON.parse(raw), validConfig(readJson(p.config)), before);
    if (JSON.stringify(state) !== was) writeJson(p.state, state);
    if (say) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: say },
      }));
    }
  } catch {
    /* a hook never blocks the prompt */
  }
  return 0;
}

const under = (p, dir) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

// The hook command, or null when a path makes it unsafe. POSIX: both paths in double quotes, refusing what a shell
// still reads there. Windows: PowerShell's call operator with single-quoted paths, a quote doubled. A node inside
// the workspace or the temp folder is refused too: a sandboxed session could change it and Codex would run it
// outside the sandbox.
export function hookCommand(node, script, win = process.platform === "win32", cwd = process.cwd()) {
  if (/[\r\n]/.test(node + script) || [cwd, tmpdir()].some((d) => under(node, d))) return null;
  if (win) return `& '${node.replace(/'/g, "''")}' '${script.replace(/'/g, "''")}' hook`;
  return /["$`\\]/.test(node + script) ? null : `"${node}" "${script}" hook`;
}

const COPY_RE = new RegExp(`[/\\\\]${COPY_NAME.replace(/\./g, "\\.")}["']? hook$`);
const isOurs = (h) => isObject(h) && typeof h.command === "string" && COPY_RE.test(h.command);

// hooks.json as an object, or why it cannot be changed. A missing file reads as empty; a link, a file that is not
// JSON, or an error other than "not found" is refused, so OMX's hooks are never overwritten by mistake.
function loadHooks(file) {
  const kind = fileKind(file);
  if (kind === "missing") return { doc: { hooks: {} }, groups: [] };
  if (kind) return { why: kind };
  const doc = readJson(file);
  if (!isObject(doc)) return { why: `${file} 이 JSON 객체가 아님` };
  if (doc.hooks === undefined) doc.hooks = {};
  if (!isObject(doc.hooks)) return { why: `${file} 의 hooks 가 객체가 아님` };
  const ups = doc.hooks.UserPromptSubmit;
  if (ups !== undefined && !Array.isArray(ups)) return { why: `${file} 의 UserPromptSubmit 이 배열이 아님` };
  return { doc, groups: ups || [] };
}

// "" for a regular file, "missing", or why the file cannot be used.
function fileKind(file) {
  try {
    const st = lstatSync(file);
    return st.isSymbolicLink() || !st.isFile() ? `${file} 이 일반 파일이 아님(링크나 폴더)` : "";
  } catch (e) {
    return e && e.code === "ENOENT" ? "missing" : `${file} 을 확인하지 못함(${e && e.code})`;
  }
}

// Where our handler sits: [group index, handler index], or null.
function findOurs(groups) {
  for (let g = 0; g < groups.length; g++) {
    const hs = isObject(groups[g]) && Array.isArray(groups[g].hooks) ? groups[g].hooks : [];
    const h = hs.findIndex(isOurs);
    if (h >= 0) return [g, h];
  }
  return null;
}

function saveHooks(p, doc) {
  if (existsSync(p.hooks)) writeAtomic(p.backup, readFileSync(p.hooks));
  writeJson(p.hooks, doc);
}

// The hook copy in <CODEX_HOME>/hooks-custom, refreshed when this version differs. A folder or copy that is a
// link is refused.
function installCopy(p) {
  mkdirSync(p.copyDir, { recursive: true });
  if (lstatSync(p.copyDir).isSymbolicLink()) return `${p.copyDir} 이 링크임`;
  if (existsSync(p.copy) && !lstatSync(p.copy).isFile()) return `${p.copy} 이 일반 파일이 아님`;
  const mine = readFileSync(SELF);
  if (!existsSync(p.copy) || !readFileSync(p.copy).equals(mine)) writeAtomic(p.copy, mine);
  return "";
}

const TRUST = "Codex 를 다시 열면 뜨는 Hooks need review 창이나 /hooks 에서 이 훅을 신뢰하십시오. 신뢰 전에는 돌지 않습니다";

function placeHook(p, doc, groups, command) {
  const at = findOurs(groups);
  if (at && groups[at[0]].hooks[at[1]].command === command) return "훅은 이미 있음";
  if (at) groups[at[0]].hooks[at[1]] = { ...groups[at[0]].hooks[at[1]], command, timeout: 5 };
  else groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
  doc.hooks.UserPromptSubmit = groups;
  saveHooks(p, doc);
  return at ? `훅 명령을 고쳤습니다. ${TRUST}` : `훅을 더했습니다. ${TRUST}`;
}

export function turnOn(p, threshold, node = process.execPath) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 95) return { code: 1, msg: "임계값은 1~95 정수" };
  const { doc, groups, why } = loadHooks(p.hooks);
  if (why) return { code: 1, msg: `바꾸지 않음: ${why}` };
  const command = hookCommand(node, p.copy);
  if (!command) return { code: 1, msg: "바꾸지 않음: node 나 훅 경로가 안전하지 않음(셸이 읽는 글자, 작업 폴더나 임시 폴더의 node)" };
  const bad = installCopy(p);
  if (bad) return { code: 1, msg: `바꾸지 않음: ${bad}` };
  const done = placeHook(p, doc, groups, command);
  writeJson(p.config, { threshold });
  return { code: 0, msg: `켰습니다(임계 ${threshold}%). ${done}` };
}

// Only our handler goes; a group it leaves empty goes too. Groups after a removed one move up an index, and
// Codex then asks to trust their hooks again, so the message says so.
export function turnOff(p) {
  const { doc, groups, why } = loadHooks(p.hooks);
  if (why) return { code: 1, msg: `바꾸지 않음: ${why}` };
  const at = findOurs(groups);
  let note = "켜져 있지 않았습니다(훅 없음). 설정만 지웠습니다";
  if (at) {
    const hs = groups[at[0]].hooks.filter((h) => !isOurs(h));
    const shifts = hs.length === 0 && at[0] < groups.length - 1;
    if (hs.length) groups[at[0]].hooks = hs;
    else groups.splice(at[0], 1);
    if (groups.length) doc.hooks.UserPromptSubmit = groups;
    else delete doc.hooks.UserPromptSubmit;
    saveHooks(p, doc);
    note = shifts ? "껐습니다. 뒤에 있던 UserPromptSubmit 훅은 /hooks 에서 다시 신뢰해야 할 수 있습니다" : "껐습니다";
  }
  for (const f of [p.config, p.state, p.copy]) rmSync(f, { force: true });
  return { code: 0, msg: note };
}

function staleness(p, groups, node) {
  const at = findOurs(groups);
  if (!at) return "no-hook";
  if (groups[at[0]].hooks[at[1]].command !== hookCommand(node, p.copy)) return "stale";
  try {
    return readFileSync(p.copy).equals(readFileSync(SELF)) ? "" : "stale";
  } catch {
    return "stale";
  }
}

export function status(p, node = process.execPath) {
  const config = validConfig(readJson(p.config));
  const { groups, why } = loadHooks(p.hooks);
  if (why) return { code: 0, msg: `${config ? "켜짐 표시는 있으나 " : ""}hooks.json 을 읽지 못함: ${why}` };
  const state = staleness(p, groups, node);
  if (!config) return { code: 0, msg: state === "no-hook" ? "꺼짐" : "꺼짐(설정 없음, 훅만 남음). off 로 정리" };
  if (state === "no-hook") return { code: 0, msg: "켜짐 표시는 있으나 훅이 없음(다른 도구나 손 편집이 지웠을 수 있음). on 을 다시 실행" };
  if (state === "stale") return { code: 0, msg: "켜짐. 다만 훅 명령이나 사본이 이 판과 다름(node 경로가 바뀌었거나 banker 를 갱신함). on 을 다시 실행" };
  return { code: 0, msg: `켜짐(임계 ${config.threshold}%). 알림이 없으면 /hooks 에서 이 훅을 신뢰했는지 확인` };
}

// on's arguments: --threshold N or --threshold=N, nothing else.
function parseOn(args) {
  if (args.length === 0) return 50;
  const one = args.length === 1 && /^--threshold=(\d+)$/.exec(args[0]);
  if (one) return Number(one[1]);
  return args.length === 2 && args[0] === "--threshold" && /^\d+$/.test(args[1]) ? Number(args[1]) : NaN;
}

function usageLine(file) {
  const u = file ? lastUsage(file) : null;
  return u ? { code: 0, msg: `${percent(u)}% (${u.used} / ${u.window} 토큰)` } : { code: 1, msg: "token_count 기록 없음" };
}

const COMMANDS = {
  on: (p, rest) => turnOn(p, parseOn(rest)),
  off: (p, rest) => (rest.length ? null : turnOff(p)),
  status: (p, rest) => (rest.length ? null : status(p)),
  usage: (p, rest) => (rest.length === 1 ? usageLine(rest[0]) : null),
};

async function main(argv) {
  const [cmd = "status", ...rest] = argv;
  const p = paths();
  if (cmd === "hook") return runHook(p);
  const run = Object.prototype.hasOwnProperty.call(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  const out = (run && run(p, rest)) || { code: 1, msg: "사용법: codex-gate.mjs on [--threshold N] | off | status | usage <rollout>" };
  (out.code ? process.stderr : process.stdout).write(`smart-compact: ${out.msg}\n`);
  return out.code;
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
})();
if (invoked) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    process.stderr.write(`smart-compact: 예기치 못한 오류: ${e && e.message}\n`);
    process.exitCode = 2;
  });
}
