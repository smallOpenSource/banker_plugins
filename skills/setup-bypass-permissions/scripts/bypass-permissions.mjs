#!/usr/bin/env node
/**
 * bypass-permissions: turns Claude Code's default permission mode to bypassPermissions, or back.
 *
 *   node bypass-permissions.mjs on --yes   set permissions.defaultMode to "bypassPermissions"
 *   node bypass-permissions.mjs off        put back what was there before `on`
 *   node bypass-permissions.mjs [status]   say what the settings, this machine's policy and this account allow
 *
 * `--yes` stands for the confirmation the skill asks for first: without it `on` changes nothing.
 *
 * The file is <config>/settings.json, where <config> is $CLAUDE_CONFIG_DIR or ~/.claude, and it
 * must already exist as a folder: a machine without Claude Code gets nothing. Every other key stays
 * as it was, and so does a BOM before the JSON (Claude Code reads such a file). The file is replaced
 * whole through a temp file and a rename, keeping its mode; a link at its name stays a link.
 * `on` remembers what it replaced in <settings>.bypass-permissions.json, written before the
 * settings, so a stop partway never leaves a mode `off` cannot take back. `off` restores exactly
 * that: the earlier mode, or no key and no permissions object when there was none, and drops the
 * warning skip (skipDangerousModePermissionPrompt) Claude Code writes when the mode is first accepted,
 * unless it was there before. A record that does not hold up is ignored.
 * The text from before `on` is kept in <settings>.bypass-permissions.bak, readable by this account
 * alone: settings can hold secrets.
 * $BANKER_BYPASS_POLICY_FILES and $BANKER_BYPASS_POLICY_DIRS replace the policy paths in this skill's tests,
 * and only with BANKER_BYPASS_TEST=1. The settings path has no override: a repository's .claude/settings.json
 * `env` can set most variables (Claude Code ignores a list there that holds CLAUDE_CONFIG_DIR and HOME), so
 * only those two may decide where it is.
 * That `env` can still set BANKER_BYPASS_TEST and IS_SANDBOX, hiding the policy or the root account from
 * this script; Claude Code then still enforces the policy itself, so the worst is a report of `on` that
 * the next session's /status does not bear out.
 *
 * `on` refuses where Claude Code would not honour the mode or not start with it: this machine's
 * managed settings or their drop-in folder forbid it (permissions.disableBypassPermissionsMode), the
 * settings file forbids it itself, or the account is root outside a sandbox Claude Code recognises
 * (IS_SANDBOX=1, or its bubblewrap one). It also refuses a file that is not a JSON object, and a
 * policy file or folder this account cannot read: then nothing says the policy allows the mode.
 *
 * Exit status: 0 done, or nothing to do. 1 refused, nothing changed. 2 an unexpected error
 * stopped the command partway: check `status`. 3 this account may not write the file or its
 * folder (a sandbox, a read-only mount, a file another account owns): the settings are unchanged.
 * Every output ends with the line `설정 파일: <path>`.
 */
import { accessSync, chmodSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODE = "bypassPermissions";
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// Where Claude Code reads machine-wide managed settings, per OS: a file and a drop-in folder.
const POLICY_HOMES = {
  linux: "/etc/claude-code",
  darwin: "/Library/Application Support/ClaudeCode",
  win32: "C:\\Program Files\\ClaudeCode",
};
const policyHome = POLICY_HOMES[process.platform] || POLICY_HOMES.linux;
const TESTING = process.env.BANKER_BYPASS_TEST === "1";
const testPaths = (name) => (TESTING && process.env[name] ? process.env[name].split("\n").filter(Boolean) : null);

const DEFAULTS = {
  settingsFile: join(CONFIG_DIR, "settings.json"),
  policyFiles: testPaths("BANKER_BYPASS_POLICY_FILES") || [join(policyHome, "managed-settings.json")],
  policyDirs: testPaths("BANKER_BYPASS_POLICY_DIRS") || [join(policyHome, "managed-settings.d")],
  uid: process.getuid?.(),
  sandbox: process.env.IS_SANDBOX,
  bubblewrap: process.env.CLAUDE_CODE_BUBBLEWRAP,
};

// Write failures that mean "this account may not", not "something broke".
const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);
// A rename that cannot land on the settings file (a bind-mounted single file): write in place.
const IN_PLACE = new Set(["EBUSY", "EXDEV"]);
const WARNING_SKIP = "skipDangerousModePermissionPrompt";
const MODES = new Set(["default", "manual", "acceptEdits", "plan", "auto", "dontAsk"]); // what `previous` may name

const stateOf = (settingsFile) => `${settingsFile}.bypass-permissions.json`;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const forbids = (v) => v === true || v === "disable";
const refusal = (why, file) => ({ ok: false, message: `${why}. 설정 파일을 그대로 두었습니다: ${file}` });
const denied = (why, file) => ({ ok: false, code: 3, message: `설정 파일에 쓸 권한이 없습니다(${why}). 설정 파일을 그대로 두었습니다: ${file}` });

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // keeps a BOM in the text, refuses other bytes

// The file as { raw, text }, null when there is no such file, { raw, bad } when it is not UTF-8.
// Any other read failure propagates.
function readParts(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
  try {
    return { raw, text: utf8.decode(raw) };
  } catch {
    return { raw, bad: true };
  }
}
const readText = (file) => readParts(file)?.text ?? null;

// parseSettings for readParts' answer.
const parseParts = (parts) => (parts?.bad ? { why: "설정 파일이 UTF-8 이 아닙니다" } : parseSettings(parts ? parts.text : null));

// { data, bom } for a JSON object (an absent file reads as {}), { why } for anything else.
function parseSettings(text) {
  if (text === null) return { data: {}, bom: "" };
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (!text.slice(bom.length).trim()) return { data: {}, bom };
  let data;
  try {
    data = JSON.parse(text.slice(bom.length));
  } catch (e) {
    return { why: `설정 파일이 올바른 JSON 이 아닙니다(${e.message})` };
  }
  if (!isObject(data)) return { why: "설정 파일의 최상위가 JSON 객체가 아닙니다" };
  if ("permissions" in data && !isObject(data.permissions)) return { why: "설정 파일의 permissions 항목이 객체가 아닙니다" };
  return { data, bom };
}

// A policy path that is not there, or is not a file of that kind: no policy, not a failure.
const ABSENT = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const unreadablePolicy = (path) => `이 머신의 관리 정책을 읽을 수 없습니다(${path}). 관리 정책이 이 모드를 허용하는지 관리자에게 확인하세요`;

// { files } of the policy drop-in folders, in the order Claude Code reads them (hidden files are
// not policy), or { unreadable } naming a folder that is there but cannot be listed.
function dropIns(dirs) {
  const files = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (ABSENT.has(e.code)) continue;
      return { unreadable: dir };
    }
    files.push(...names.filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort().map((f) => join(dir, f)));
  }
  return { files };
}

// Why this machine's policy stops the mode, or "": a managed settings file or drop-in forbids it, or
// a policy file or folder is there but this account cannot read it, so nothing says it allows it.
function policyBlock(o) {
  const listed = dropIns(o.policyDirs);
  if (listed.unreadable) return unreadablePolicy(listed.unreadable);
  for (const file of [...o.policyFiles, ...listed.files]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if (ABSENT.has(e.code)) continue;
      return unreadablePolicy(file);
    }
    try {
      if (forbids(JSON.parse(text.replace(/^\uFEFF/, ""))?.permissions?.disableBypassPermissionsMode)) {
        return `이 머신의 관리 정책이 bypassPermissions 를 막습니다(${file})`;
      }
    } catch {
      /* not JSON: nothing this script can see forbids it */
    }
  }
  return "";
}

// An environment flag as Claude Code reads it: 1, true, yes or on, any case.
const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());

// Why Claude Code would not run in the mode here, or "".
function modeBlock(o, data) {
  // Claude Code lets root use the mode inside a sandbox it recognises: IS_SANDBOX exactly "1", or
  // CLAUDE_CODE_BUBBLEWRAP set to a true value (2.1.289 reads 1, true, yes, on; 0 or false is not one).
  if (o.uid === 0 && o.sandbox !== "1" && !truthy(o.bubblewrap)) {
    return "root 계정에서는 Claude Code 가 bypassPermissions 로 시작하지 않습니다. 격리된 샌드박스라면 IS_SANDBOX=1 을 설정한 Claude Code 에서 다시 실행하세요";
  }
  const blocked = policyBlock(o);
  if (blocked) return blocked;
  if (forbids(data.permissions?.disableBypassPermissionsMode)) {
    return "설정 파일 자체의 permissions.disableBypassPermissionsMode 가 bypassPermissions 를 막습니다";
  }
  return "";
}

// Replaces file through a fresh temp file and a rename, so a link planted at its name
// is replaced rather than written through. A folder in the way is not a permission problem,
// though Windows answers the rename with EPERM: say so on every OS, before any write.
function writeFresh(file, data, mode) {
  if (lstatSync(file, { throwIfNoEntry: false })?.isDirectory()) {
    throw Object.assign(new Error(`쓸 자리에 폴더가 있습니다: ${file}`), { code: "EISDIR" });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, data, { flag: "wx", mode });
    chmodSync(tmp, mode); // the umask has no say
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const serialize = (data, bom) => bom + JSON.stringify(data, null, 2) + "\n";

// The answer for an existing settings file this account may not write; null when it may.
function writeDenial(file, before) {
  if (before === null) return null;
  try {
    accessSync(file, constants.W_OK);
    return null;
  } catch (e) {
    return denied(e.code || e.message, file);
  }
}

// Replaces the file behind a link at `file` (the link stays) whole, keeping its mode.
function replaceSettings(file, text) {
  const real = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(real) ? statSync(real).mode & 0o777 : 0o600;
  try {
    writeFresh(real, text, mode);
  } catch (e) {
    if (!IN_PLACE.has(e.code)) throw e;
    writeFileSync(file, text);
  }
}

// Writes `text` as the settings, after keeping the old text in the .bak when `backup` asks for it.
function commit(o, before, text, done, backup) {
  if (backup && before !== null) writeFresh(`${o.settingsFile}.bypass-permissions.bak`, before, 0o600);
  replaceSettings(o.settingsFile, text);
  return { ok: true, message: done };
}

// Reads the settings back after a write: the mode must be what the write meant.
function confirmMode(o, wantOn) {
  const { data } = parseSettings(readText(o.settingsFile));
  if ((data?.permissions?.defaultMode === MODE) !== wantOn) throw new Error("다시 읽은 설정의 defaultMode 가 쓴 값과 다릅니다");
}

export function turnOn(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parts = readParts(o.settingsFile);
  const before = parts ? parts.raw : null; // the .bak keeps these bytes
  const { data, bom, why } = parseParts(parts);
  if (why) return refusal(why, o.settingsFile);
  const blocked = modeBlock(o, data);
  if (blocked) return refusal(blocked, o.settingsFile);
  if (data.permissions?.defaultMode === MODE) return { ok: true, message: "이미 켜져 있습니다 (변경 없음)." };
  if (!existsSync(dirname(o.settingsFile))) {
    return refusal(`Claude Code 설정 폴더가 없습니다(${dirname(o.settingsFile)}). 이 머신에서 Claude Code 를 쓰지 않는다면 켤 것이 없습니다`, o.settingsFile);
  }
  const denial = writeDenial(o.settingsFile, before);
  if (denial) return denial;
  const hadPermissions = isObject(data.permissions);
  const previous = hadPermissions && "defaultMode" in data.permissions ? data.permissions.defaultMode : null;
  const record = { hadPermissions, previous, warningSkip: WARNING_SKIP in data ? { value: data[WARNING_SKIP] } : null };
  const next = { ...data, permissions: { ...(data.permissions || {}), defaultMode: MODE } };
  writeFresh(stateOf(o.settingsFile), JSON.stringify(record) + "\n", 0o600);
  let res;
  try {
    res = commit(o, before, serialize(next, bom), "켰습니다. 다음 세션부터 도구 실행 확인 없이 진행합니다. 되돌리려면 off.", true);
  } catch (e) {
    rmSync(stateOf(o.settingsFile), { force: true }); // the settings were not replaced
    throw e;
  }
  // From here the record stays, even when the read-back fails: the mode may be on, and only the
  // record lets off put back what was there. A stale one is harmless; off and on both replace it.
  confirmMode(o, true);
  return res;
}

// What `on` replaced, or null when there is no record or it does not hold up.
function remembered(settingsFile) {
  let s;
  try {
    s = JSON.parse(readFileSync(stateOf(settingsFile), "utf8"));
  } catch {
    return null;
  }
  if (!isObject(s) || typeof s.hadPermissions !== "boolean") return null;
  if (s.previous !== null && !MODES.has(s.previous)) return null;
  if (s.warningSkip !== undefined && s.warningSkip !== null && !(isObject(s.warningSkip) && "value" in s.warningSkip)) return null;
  return s;
}

// The settings as they were before `on`, as far as the record tells.
function restored(data, state) {
  const permissions = { ...data.permissions };
  if (state && state.previous !== null) permissions.defaultMode = state.previous;
  else delete permissions.defaultMode;
  const next = { ...data, permissions };
  if (state && !state.hadPermissions && Object.keys(permissions).length === 0) delete next.permissions;
  if (state && state.warningSkip === null) delete next[WARNING_SKIP];
  else if (state && isObject(state.warningSkip)) next[WARNING_SKIP] = state.warningSkip.value;
  return next;
}

export function turnOff(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parts = readParts(o.settingsFile);
  const before = parts ? parts.raw : null;
  const { data, bom, why } = parseParts(parts);
  if (why) return refusal(why, o.settingsFile);
  if (data.permissions?.defaultMode !== MODE) {
    rmSync(stateOf(o.settingsFile), { force: true }); // a record of an `on` that no longer holds
    return { ok: true, message: "이미 꺼져 있습니다 (변경 없음)." };
  }
  const denial = writeDenial(o.settingsFile, before);
  if (denial) return denial;
  const state = remembered(o.settingsFile);
  const done = state
    ? "껐습니다. on 하기 전의 권한 모드로 되돌렸습니다."
    : "껐습니다. banker 가 켠 기록이 없거나 그 기록을 믿을 수 없어 defaultMode 를 지웠습니다(Claude Code 의 기본 시작 모드).";
  const res = commit(o, before, serialize(restored(data, state), bom), done, false);
  confirmMode(o, false);
  rmSync(stateOf(o.settingsFile), { force: true });
  return res;
}

function describe(o, parsed) {
  if (parsed.why) return parsed.why;
  const mode = parsed.data.permissions?.defaultMode;
  if (mode !== MODE) return `꺼짐 (defaultMode: ${mode === undefined ? "없음" : mode})`;
  return `켜짐 (defaultMode: ${MODE}, ${remembered(o.settingsFile) ? "banker 가 설정" : "직접 설정"})`;
}

export function status(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let parsed;
  try {
    parsed = parseParts(readParts(o.settingsFile));
  } catch (e) {
    parsed = { why: `설정 파일을 읽을 수 없음 (${e.code || e.message})` };
  }
  const lines = [`bypass-permissions: ${describe(o, parsed)} (${o.settingsFile})`];
  const blocked = modeBlock(o, parsed.data || {});
  if (blocked) lines.push(`주의: ${blocked}. 이 상태에서는 on 이 거부됩니다.`);
  return { ok: true, message: lines.join("\n") };
}

// The command for the exact arguments, or null: `on` needs `--yes`, and nothing else is taken.
function commandFor(argv) {
  const key = JSON.stringify(argv);
  if (key === '["on","--yes"]') return turnOn;
  if (key === '["off"]') return turnOff;
  if (key === "[]" || key === '["status"]') return status;
  return null;
}

// { code, message } for the exact arguments: what main prints before the settings file line.
function outcome(argv) {
  const run = commandFor(argv);
  if (!run) {
    const hint = JSON.stringify(argv) === '["on"]' ? "켜기는 확인을 거친 뒤 on --yes 로만 실행합니다. 바뀐 것은 없습니다.\n" : "";
    return { code: 1, message: `${hint}사용법: bypass-permissions on --yes | off | status` };
  }
  try {
    const { ok, code, message } = run();
    return { code: ok ? 0 : code || 1, message };
  } catch (e) {
    if (DENIED.has(e.code)) return { code: 3, message: `설정 파일이나 그 폴더에 쓸 권한이 없습니다(${e.code}). 설정 파일은 바뀌지 않았습니다.` };
    return { code: 2, message: `예기치 못한 오류로 중단했습니다: ${e.message}\nstatus 로 상태를 확인하세요.` };
  }
}

function main(argv) {
  const { code, message } = outcome(argv);
  process.stdout.write(`${message}\n설정 파일: ${DEFAULTS.settingsFile}\n`);
  return code;
}

// Run as a command, also when reached through a symlinked path.
const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
