#!/usr/bin/env node
/**
 * tone-compact: keeps the compact Korean writing rules on or off across sessions.
 *
 *   node tone-compact.mjs on  --runtime claude|codex   save the rules where that runtime loads them
 *   node tone-compact.mjs off --runtime claude|codex   take them out again
 *   node tone-compact.mjs status                       say where they are on, for both runtimes
 *
 * The rules are the part of ../SKILL.md between the tone-compact:rules markers,
 * so the text the skill applies in the session and the text later sessions load
 * are the same.
 *
 * Claude Code loads every rules file under <config>/rules/ (<config> is
 * $CLAUDE_CONFIG_DIR or ~/.claude) at session start and again after compaction.
 * `on` writes banker-tone-compact.md there and `off` deletes it. A file at that
 * name that does not start with banker's mark belongs to someone else and is
 * left alone.
 *
 * Codex reads $CODEX_HOME/AGENTS.override.md when it holds any non-whitespace
 * text and $CODEX_HOME/AGENTS.md otherwise (CODEX_HOME defaults to ~/.codex).
 * `on` adds one marked block at the end of AGENTS.md, or of the override when
 * the override has text of its own (a block alone there would hide AGENTS.md);
 * `off` takes it out and gives back the bytes from before. The block sits inside
 * OMX's USER:OMX:POLICY markers, the only part of a generated AGENTS.md that
 * `omx setup --merge-agents` carries over; a plain `omx setup` with team mode on
 * only refreshes the model table. `omx setup --force`, confirming its overwrite
 * prompt, or a plain `omx setup` with team mode off replaces the file block and
 * all; `on` then has to run again. Text other tools keep in these files is left
 * alone, and the bytes from before each change are kept in
 * <file>.tone-compact.bak. Markers count only as whole lines that open and close
 * in turn; a marker quoted inside a sentence, or an end before a start, makes on
 * and off refuse rather than guess where the block ends. So does a file that is
 * not UTF-8 (CP949, UTF-16): written back as text it would lose its bytes.
 *
 * `off` never needs the rules, so it works even when SKILL.md cannot be read.
 * Exit status 0 means done or already so; 1 means refused or a usage error, with
 * nothing changed; 2 means an unexpected error stopped the command partway, so
 * check `status`.
 */
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RULES_START = "<!-- tone-compact:rules:start -->";
const RULES_END = "<!-- tone-compact:rules:end -->";
// The Claude Code rules file starts with this mark; it is how off and on know the file is banker's.
const OWNER_MARK = "<!-- banker tone-compact";
const HEADER = `${OWNER_MARK}: banker 가 관리하는 파일입니다. 끄려면 tone-compact 에 off 를 실행하세요. -->`;
const OPEN = "<!-- banker:tone-compact:start -->";
const CLOSE = "<!-- banker:tone-compact:end -->";
// OMX keeps only these regions when `omx setup` rewrites a generated AGENTS.md.
const KEEP_OPEN = "<!-- USER:OMX:POLICY:START -->";
const KEEP_CLOSE = "<!-- USER:OMX:POLICY:END -->";
const MARKERS = [OPEN, CLOSE, KEEP_OPEN, KEEP_CLOSE, RULES_START, RULES_END];

const DEFAULTS = {
  claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  codexDir: process.env.CODEX_HOME || join(homedir(), ".codex"),
  skillFile: fileURLToPath(new URL("../SKILL.md", import.meta.url)),
};

const count = (text, needle) => text.split(needle).length - 1;
const lf = (text) => text.replace(/\r\n/g, "\n");
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A file's bytes and text, null when there is no such file. text is null when
// the bytes are not UTF-8, which callers refuse: decoding them would replace
// them with U+FFFD for good. Any other read failure (permissions, a folder at
// that name) is not "missing" and propagates.
function readFile(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
  try {
    return { bytes, text: UTF8.decode(bytes) };
  } catch {
    return { bytes, text: null };
  }
}

const done = (message) => ({ ok: true, message });
const refuse = (message) => ({ ok: false, message });

/** The rules: the text between the markers in SKILL.md, without the line breaks around it. */
export function rulesOf(skillText) {
  const text = lf(skillText);
  const start = text.indexOf(RULES_START);
  const end = text.indexOf(RULES_END);
  if (count(text, RULES_START) !== 1 || count(text, RULES_END) !== 1 || end < start) {
    throw new Error("SKILL.md 에서 규칙 구간(tone-compact:rules 표시)을 찾지 못했습니다");
  }
  const rules = text.slice(start + RULES_START.length, end).replace(/^\n+|\n+$/g, "");
  if (rules === "" || MARKERS.some((m) => rules.includes(m))) {
    throw new Error("SKILL.md 의 규칙 구간이 비었거나 관리 표시를 담고 있습니다");
  }
  return rules;
}

const loadRules = (o) => rulesOf(readFileSync(o.skillFile, "utf8"));

// Replaces file through a fresh temp file ("wx") and a rename: a link planted at
// either name is replaced rather than written through, and a write that fails
// leaves the old file as it was.
function writeFresh(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, data, { flag: "wx", mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const denied = (e) => e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS";

// ---- Claude Code: one rules file that is banker's alone ----

const claudeFile = (o) => join(o.claudeDir, "rules", "banker-tone-compact.md");
const claudeText = (rules) => `${HEADER}\n${rules}\n`;

// "off", "foreign" (not banker's file), or, when rules are given, "on" or
// "stale" (an earlier version's rules); without rules a banker file is "ours".
function claudeState(file, rules) {
  if (file === null) return "off";
  if (file.text === null) return "foreign";
  const body = lf(file.text.replace(/^\uFEFF/, ""));
  if (!body.startsWith(OWNER_MARK)) return "foreign";
  if (rules === undefined) return "ours";
  return body === claudeText(rules) ? "on" : "stale";
}

function claudeOn(o) {
  const file = claudeFile(o);
  if (!isDir(o.claudeDir)) return refuse(`Claude Code 설정 폴더가 없습니다: ${o.claudeDir}`);
  const rules = loadRules(o);
  const state = claudeState(readFile(file), rules);
  if (state === "foreign") return refuse(`같은 이름의 다른 파일이 있어 그대로 두었습니다: ${file}`);
  if (state === "on") return done(`Claude Code: 이미 켜져 있습니다 (변경 없음). ${file}`);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
    writeFresh(file, claudeText(rules));
  } catch (e) {
    if (denied(e)) return refuse(`쓸 권한이 없어 켜지 못했습니다 (${e.code}): ${file}`);
    throw e;
  }
  return done(
    state === "stale"
      ? `Claude Code: 규칙을 이 버전으로 바꿨습니다. ${file}`
      : `Claude Code: 켰습니다. 다음 세션부터 자동 적용됩니다. ${file}`,
  );
}

function claudeOff(o) {
  const file = claudeFile(o);
  const state = claudeState(readFile(file));
  if (state === "off") return done("Claude Code: 이미 꺼져 있습니다 (변경 없음).");
  if (state === "foreign") return refuse(`같은 이름의 다른 파일이 있어 그대로 두었습니다: ${file}`);
  try {
    rmSync(file);
  } catch (e) {
    if (denied(e)) return refuse(`지울 권한이 없어 끄지 못했습니다 (${e.code}): ${file}`);
    throw e;
  }
  return done(`Claude Code: 껐습니다. 다음 세션부터 적용되지 않습니다. ${file}`);
}

// ---- Codex: one block in the global instructions file Codex reads ----

const lineBare = (line) => line.replace(/\r?\n$/, "");
// A line without its line break, and the first one without the byte order mark
// an editor may put in front of it.
const bareAt = (lines, i) => (i === 0 ? lineBare(lines[i]).replace(/^\uFEFF/, "") : lineBare(lines[i]));

// One block's place in the text: [from, to) runs from its first line (the keep
// marker when one wraps it directly) through the end of its last line; cut is
// from minus the line break `on` puts before the block, and blankBefore says
// whether that break makes a blank line of its own.
function spanOf(lines, offsets, first, last) {
  const wrapped =
    first > 0 &&
    last + 1 < lines.length &&
    bareAt(lines, first - 1) === KEEP_OPEN &&
    bareAt(lines, last + 1) === KEEP_CLOSE;
  const top = wrapped ? first - 1 : first;
  const bottom = wrapped ? last + 1 : last;
  const before = top > 0 ? lines[top - 1] : "";
  const joint = before.endsWith("\r\n") ? 2 : before.endsWith("\n") ? 1 : 0;
  const blankBefore = before !== "" && lineBare(before) === "";
  return { cut: offsets[top] - joint, from: offsets[top], to: offsets[bottom] + lines[bottom].length, blankBefore };
}

/**
 * Where the tone-compact blocks sit in text, or null when the markers are not
 * whole lines that open and close in turn. on and off refuse null, so a marker
 * quoted inside a sentence can never make them cut the user's own text.
 */
export function blockSpans(text) {
  const lines = text.split(/(?<=\n)/);
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length;
  }
  const spans = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const bare = bareAt(lines, i);
    if (bare === OPEN && open === -1) open = i;
    else if (bare === CLOSE && open !== -1) {
      spans.push(spanOf(lines, offsets, open, i));
      open = -1;
    } else if (lines[i].includes(OPEN) || lines[i].includes(CLOSE)) return null;
  }
  return open === -1 ? spans : null;
}

// The text without its blocks: exactly what it was before `on` added them. The
// line break `on` put in front goes with the block when the block ends the file
// or has a blank line of its own in front; with other text after it, the break
// stays, so the lines on either side never run together.
function strip(text, spans) {
  let out = "";
  let at = 0;
  for (const s of spans) {
    const keepBreak = s.to < text.length && !s.blankBefore;
    out += text.slice(at, keepBreak ? s.from : s.cut);
    at = s.to;
  }
  return out + text.slice(at);
}

// Whether text holds anything but whitespace, the way Codex judges a file empty
// (Rust's trim, which unlike JavaScript's keeps a byte order mark).
const hasContent = (text) => /[^\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(text);

// Both global instruction files with their bytes and text (null when absent;
// text null when not UTF-8) and blocks (null when the markers do not pair up).
// The block's place (target) is the override when the override has text of its
// own, AGENTS.md otherwise: an override holding only the block would hide
// AGENTS.md from Codex, which reads any override with non-whitespace text.
function codexFiles(o) {
  const read = (name) => {
    const path = join(o.codexDir, name);
    const file = readFile(path);
    if (file === null) return { path, bytes: null, text: null, spans: [] };
    return { path, ...file, spans: file.text === null ? null : blockSpans(file.text) };
  };
  const override = read("AGENTS.override.md");
  const main = read("AGENTS.md");
  const ownContent =
    binary(override) ||
    (override.text !== null && hasContent(override.spans === null ? override.text : strip(override.text, override.spans)));
  const target = ownContent ? override : main;
  return { target, other: target === override ? main : override, all: [override, main] };
}

const blockFor = (rules, eol) => [KEEP_OPEN, OPEN, ...rules.split("\n"), CLOSE, KEEP_CLOSE, ""].join(eol);
const binary = (f) => f.bytes !== null && f.text === null;
const unpaired = (f) => f.spans === null;
const hasBlock = (f) => f.spans !== null && f.spans.length > 0;
const stripped = (f) => (f.text === null ? "" : strip(f.text, f.spans));
// A block's text compared without line-break style, a leading byte order mark
// or the final line break, which editors add and drop.
const normBlock = (text) => lf(text).replace(/^\uFEFF/, "").replace(/\n$/, "");
// The block exactly as `on` writes it, and only once.
const blockCurrent = (f, rules) =>
  f.spans.length === 1 && normBlock(f.text.slice(f.spans[0].from, f.spans[0].to)) === normBlock(blockFor(rules, "\n"));

// The text with the block at the end, one line break between them; an empty
// file gets the block alone. strip() undoes exactly this.
function withBlock(text, rules) {
  const eol = eolOf(text);
  return text === "" ? blockFor(rules, eol) : text + eol + blockFor(rules, eol);
}

// "off", "on", "stale", "misplaced" (only in AGENTS.md while Codex reads the
// override, so not applied), "hidden" (alone in the override, applied but hiding
// AGENTS.md), "unpaired" or "notutf8". Without rules any block in its place
// counts as "on".
function codexState(files, rules) {
  if (files.all.some(binary)) return "notutf8";
  if (files.all.some(unpaired)) return "unpaired";
  const inTarget = hasBlock(files.target);
  const inOther = hasBlock(files.other);
  if (!inTarget) return inOther ? (files.other === files.all[0] ? "hidden" : "misplaced") : "off";
  if (rules === undefined) return "on";
  return blockCurrent(files.target, rules) && !inOther ? "on" : "stale";
}

// Why these files cannot be written, or "" when they can. The folder counts
// too: the .bak is written through a temp file beside the file.
function writeBlocked(changes) {
  for (const { file } of changes) {
    for (const path of file.bytes === null ? [dirname(file.path)] : [file.path, dirname(file.path)]) {
      try {
        accessSync(path, constants.W_OK);
      } catch (e) {
        return `쓸 권한이 없어 그대로 두었습니다 (${e.code || e.message}): ${path}`;
      }
    }
  }
  return "";
}

// Writes each file in place, so a symlinked AGENTS.md stays a link and its
// target changes, after keeping the old bytes in a .bak only this account can
// read (the file may be a link into a private folder). A new file gets 0644
// whatever the umask allows more. A file left empty is removed, unless it is a
// link: Codex skips an empty file anyway.
function apply(changes) {
  for (const { file, after } of changes) {
    if (file.bytes !== null) writeFresh(`${file.path}.tone-compact.bak`, file.bytes, 0o600);
    if (after === "" && !isLink(file.path)) rmSync(file.path, { force: true });
    else writeFileSync(file.path, after, { mode: 0o644 });
  }
}

const OMX_NOTE =
  "참고: omx setup 이 AGENTS.md 를 새로 만들면(--force, 덮어쓰기 확인, team 모드를 끈 상태의 omx setup) 이 블록이 사라집니다. 그 뒤에는 on 을 다시 실행하세요. --merge-agents 와 기본 omx setup 은 블록을 남깁니다.";

const notUtf8Refusal = (files) => refuse(`UTF-8 이 아닌 파일이라 그대로 두었습니다: ${files.all.find(binary).path}`);

const unpairedRefusal = (files) =>
  refuse(`tone-compact 표시의 짝이 맞지 않아 그대로 두었습니다: ${files.all.find(unpaired).path}`);

function codexOn(o) {
  if (!isDir(o.codexDir)) return refuse(`Codex 설정 폴더가 없습니다: ${o.codexDir}`);
  const rules = loadRules(o);
  const files = codexFiles(o);
  const state = codexState(files, rules);
  if (state === "notutf8") return notUtf8Refusal(files);
  if (state === "unpaired") return unpairedRefusal(files);
  if (state === "on") return done(`Codex: 이미 켜져 있습니다 (변경 없음). ${files.target.path}`);
  const changes = [{ file: files.target, after: withBlock(stripped(files.target), rules) }];
  if (hasBlock(files.other)) changes.push({ file: files.other, after: stripped(files.other) });
  const why = writeBlocked(changes);
  if (why) return refuse(why);
  apply(changes);
  const moved = "블록을 맞는 파일로 옮겼습니다";
  const what = { stale: "규칙을 이 버전으로 바꿨습니다", misplaced: moved, hidden: moved }[state];
  const note = files.target === files.all[1] ? `\n${OMX_NOTE}` : "";
  return done(`Codex: ${what ?? "켰습니다. 다음 세션부터 자동 적용됩니다"}. ${files.target.path}${note}`);
}

function codexOff(o) {
  if (!isDir(o.codexDir)) return done(`Codex: 설정 폴더가 없어 끌 것이 없습니다 (변경 없음). ${o.codexDir}`);
  const files = codexFiles(o);
  const state = codexState(files);
  if (state === "notutf8") return notUtf8Refusal(files);
  if (state === "unpaired") return unpairedRefusal(files);
  const changes = files.all.filter(hasBlock).map((f) => ({ file: f, after: stripped(f) }));
  if (changes.length === 0) return done("Codex: 이미 꺼져 있습니다 (변경 없음).");
  const why = writeBlocked(changes);
  if (why) return refuse(why);
  apply(changes);
  return done(`Codex: 껐습니다. 다음 세션부터 적용되지 않습니다. ${changes.map((c) => c.file.path).join(", ")}`);
}

// ---- status ----

const STATE_TEXT = {
  on: "켜짐",
  ours: "켜짐 (규칙 버전 확인 불가)",
  stale: "켜짐, 단 규칙이 이 버전과 다름 (on 으로 갱신)",
  off: "꺼짐",
  foreign: "꺼짐, 같은 이름의 다른 파일이 있음 (손대지 않음)",
  misplaced: "꺼짐, 단 블록이 Codex 가 읽지 않는 AGENTS.md 에 있음 (on 으로 옮김)",
  hidden: "켜짐, 단 AGENTS.override.md 에 블록만 있어 AGENTS.md 가 가려짐 (on 으로 옮김)",
  notutf8: "UTF-8 이 아닌 지침 파일이 있어 손대지 않음 (on, off 모두 거부)",
  unpaired: "표시의 짝이 맞지 않음 (on, off 모두 거부. 남은 표시 줄 정리 필요)",
};

// One status line per runtime. Read failures are reported, not thrown: status
// is where an exit 2 sends the user to look.
function describe(name, look) {
  try {
    const { state, path } = look();
    return `- ${name}: ${STATE_TEXT[state] ?? state} (${path})`;
  } catch (e) {
    return `- ${name}: 읽을 수 없음 (${e.code || e.message})`;
  }
}

export function status(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lines = ["tone-compact 상태"];
  let rules;
  try {
    rules = loadRules(o);
  } catch (e) {
    lines.push(`- 규칙 원문을 읽지 못해 버전은 비교하지 않음 (${e.code || e.message})`);
  }
  lines.push(
    describe("Claude Code", () => {
      if (!isDir(o.claudeDir)) return { state: "설정 폴더 없음", path: o.claudeDir };
      return { state: claudeState(readFile(claudeFile(o)), rules), path: claudeFile(o) };
    }),
    describe("Codex", () => {
      if (!isDir(o.codexDir)) return { state: "설정 폴더 없음", path: o.codexDir };
      const files = codexFiles(o);
      return { state: codexState(files, rules), path: files.target.path };
    }),
  );
  return done(lines.join("\n"));
}

const ACTIONS = new Map([
  ["claude", { on: claudeOn, off: claudeOff }],
  ["codex", { on: codexOn, off: codexOff }],
]);

export const turnOn = (runtime, opts = {}) => ACTIONS.get(runtime).on({ ...DEFAULTS, ...opts });
export const turnOff = (runtime, opts = {}) => ACTIONS.get(runtime).off({ ...DEFAULTS, ...opts });

// { command, runtime, extra } from the command line; --runtime takes "x" or "=x".
export function parseArgs(argv) {
  const rest = [];
  let runtime = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runtime") runtime = argv[++i] ?? "";
    else if (a.startsWith("--runtime=")) runtime = a.slice("--runtime=".length);
    else rest.push(a);
  }
  return { command: (rest[0] ?? "status").toLowerCase(), runtime: runtime?.toLowerCase() ?? null, extra: rest.slice(1) };
}

const USAGE = "사용법: tone-compact on | off | status [--runtime claude|codex]";

// The runtime on and off act on: the flag, else Claude Code when it runs this.
const runtimeOf = (flag, env) => flag ?? (env.CLAUDECODE === "1" ? "claude" : null);

function main(argv, env = process.env) {
  const { command, runtime: flag, extra } = parseArgs(argv);
  if (extra.length > 0 || !["on", "off", "status"].includes(command) || (flag !== null && !ACTIONS.has(flag))) {
    process.stdout.write(`${USAGE}\n`);
    return 1;
  }
  const runtime = runtimeOf(flag, env);
  if (command !== "status" && !ACTIONS.has(runtime)) {
    process.stdout.write(`런타임을 정할 수 없습니다. --runtime claude 또는 --runtime codex 를 붙이세요.\n${USAGE}\n`);
    return 1;
  }
  try {
    const { ok, message } = command === "status" ? status() : (command === "on" ? turnOn : turnOff)(runtime);
    process.stdout.write(`${message}\n`);
    return ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(`예기치 못한 오류로 중단했습니다: ${e.message}\nstatus 로 상태를 확인하세요.\n`);
    return 2;
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
