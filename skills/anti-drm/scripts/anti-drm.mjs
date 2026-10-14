#!/usr/bin/env node
/**
 * anti-drm: keeps rules on or off across sessions that steer the agent away
 * from the file extensions this PC's DRM encrypts, toward replacements the user
 * chose. A file the DRM encrypted can no longer be read by the agent or by
 * development tools.
 *
 *   node anti-drm.mjs on     --runtime claude|codex [--deny <list> --alt <list> [--tsv tab|comma]]
 *   node anti-drm.mjs off    --runtime claude|codex
 *   node anti-drm.mjs status
 *   node anti-drm.mjs config --deny <list> --alt <list> [--tsv tab|comma]
 *
 * <list> is extensions split by commas or spaces, such as ".txt,.pdf".
 *
 * The settings are one JSON file both runtimes share, ~/.config/banker/anti-drm.json
 * ($BANKER_ANTI_DRM_CONFIG names another): the denied extensions, the
 * replacements, and whether a .tsv file splits its columns with tabs or commas.
 * `off` keeps the file, so turning the rules on again asks nothing. .md and
 * .json cannot be denied: the rules file and AGENTS.md are .md, the settings
 * .json.
 *
 * The rules are the template in ../SKILL.md between the anti-drm:rules markers,
 * filled from the settings. Where they go, and how they come out again byte for
 * byte, is instruction-toggle.mjs beside this file, shared with tone-compact.
 * `on` and `off` act on one runtime. Settings given to `on`, and every
 * `config`, also refresh each runtime that holds the rules, since both runtimes
 * read the same settings.
 *
 * Exit status 0 means done or already so; 1 means refused or a usage error
 * (with settings given, also a runtime that could not be refreshed after they
 * were saved); 2 means an unexpected error stopped the command partway, so
 * check `status`.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEEP_CLOSE,
  KEEP_OPEN,
  RUNTIMES,
  denied,
  present,
  stateLines,
  toggleSpec,
  turnOff as toggleOff,
  turnOn as toggleOn,
  where,
  writeFresh,
} from "./instruction-toggle.mjs";

const RULES_START = "<!-- anti-drm:rules:start -->";
const RULES_END = "<!-- anti-drm:rules:end -->";
const TOGGLE = toggleSpec({
  slug: "anti-drm",
  staleText: "켜짐, 단 규칙이 지금 설정이나 이 버전과 다름 (on 으로 갱신)",
  updatedText: "규칙을 지금 설정으로 바꿨습니다",
});
const MARKERS = [TOGGLE.open, TOGGLE.close, KEEP_OPEN, KEEP_CLOSE, RULES_START, RULES_END];
const PLACES = ["{{map}}", "{{alts}}"];
// anti-drm's own files: the rules file and AGENTS.md are .md, the settings .json.
const RESERVED = [".md", ".json"];

const DEFAULTS = {
  claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  codexDir: process.env.CODEX_HOME || join(homedir(), ".codex"),
  configFile: process.env.BANKER_ANTI_DRM_CONFIG || join(homedir(), ".config", "banker", "anti-drm.json"),
  skillFile: fileURLToPath(new URL("../SKILL.md", import.meta.url)),
};

const BOM = String.fromCharCode(0xfeff);
const RUNTIME_NAME = { claude: "Claude Code", codex: "Codex" };
const done = (message) => ({ ok: true, message });
const refuse = (message) => ({ ok: false, message });
const count = (text, needle) => text.split(needle).length - 1;
const lf = (text) => text.replace(/\r\n/g, "\n");
// A value from outside, as a message shows it. An extension is printable
// ASCII, so anything else becomes "?" (a line break or a direction mark cannot
// forge a line or reorder the text), at most 40 characters stay, and a value
// that is not a string shows only its type.
const shown = (value) => (typeof value === "string" ? value.replace(/[^ -~]/g, "?").slice(0, 40) : `(${typeof value})`);

// ---- settings ----

const EXT = /^\.[a-z0-9]{1,15}$/;
// At most this many extensions in each list: the rules load into every session.
const MAX_EXTS = 64;
// The largest settings file read; the settings hold two short lists.
const MAX_BYTES = 64 * 1024;

/** The words of an extension list: split by commas or spaces. */
export const splitList = (text) => String(text ?? "").split(/[\s,]+/).filter(Boolean);

// One extension as the settings keep it (lower case, a leading dot, then 1 to
// 15 letters or digits), or null when the word is not one.
function normalExt(word) {
  if (typeof word !== "string") return null;
  const lower = word.trim().toLowerCase();
  const ext = lower.startsWith(".") ? lower : `.${lower}`;
  return EXT.test(ext) ? ext : null;
}

// The extensions in words, normalized and each once, or why they are not a list.
function extList(words, what) {
  if (!Array.isArray(words)) return { error: `${what}가 목록이 아닙니다` };
  if (words.length === 0) return { error: `${what}가 비어 있습니다` };
  if (words.length > MAX_EXTS) return { error: `${what}는 ${MAX_EXTS}개까지 쓸 수 있습니다` };
  const list = new Set();
  for (const word of words) {
    const ext = normalExt(word);
    if (ext === null) return { error: `${what}로 쓸 수 없는 값입니다: ${shown(word)}` };
    list.add(ext);
  }
  return { list: [...list] };
}

/** Settings from their parts, normalized: { config } or { error }. */
export function checkConfig({ deny, alt, tsvDelimiter = "tab" }) {
  const d = extList(deny, "금지 확장자");
  if (d.error) return d;
  const a = extList(alt, "대체 확장자");
  if (a.error) return a;
  const reserved = d.list.filter((x) => RESERVED.includes(x));
  if (reserved.length > 0) return { error: `anti-drm 이 쓰는 형식이라 금지할 수 없습니다: ${reserved.join(" ")}` };
  const both = d.list.filter((x) => a.list.includes(x));
  if (both.length > 0) return { error: `금지 확장자와 대체 확장자에 함께 있습니다: ${both.join(" ")}` };
  if (tsvDelimiter !== "tab" && tsvDelimiter !== "comma") {
    return { error: `TSV 구분자는 tab 이나 comma 여야 합니다: ${shown(tsvDelimiter)}` };
  }
  return { config: { version: 1, deny: d.list, alt: a.list, tsvDelimiter } };
}

const ownedByOther = (st) => typeof process.getuid === "function" && st.uid !== process.getuid();

// The settings file's text: null when there is none, { error } when it is not a
// regular file of at most 64 KiB that this account owns. Opening without
// blocking keeps a FIFO from hanging the command, and another account's file
// cannot steer this account's rules.
function settingsText(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    if (e.code === "EISDIR") return { error: "일반 파일이 아닙니다" };
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: "일반 파일이 아닙니다" };
    if (st.size > MAX_BYTES) return { error: "64KiB 보다 큽니다" };
    if (ownedByOther(st)) return { error: "다른 사용자 소유입니다" };
    return { text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/** The settings file: null when there is none, else { config } or { error }. */
export function readConfig(file) {
  const got = settingsText(file);
  if (got === null || got.error) return got;
  const { text } = got;
  let raw;
  try {
    raw = JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  } catch {
    return { error: "JSON 이 아닙니다" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "JSON 객체가 아닙니다" };
  return checkConfig({ deny: raw.deny, alt: raw.alt, tsvDelimiter: raw.tsvDelimiter ?? "tab" });
}

// The bytes of the regular file at path, following a link, or null when there is none.
function regularBytes(file) {
  try {
    return statSync(file).isFile() ? readFileSync(file) : null;
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/**
 * Saves the settings: the folder 0755, the file 0644 through a temp file and a
 * rename. The bytes from before stay in <file>.bak, readable by this account
 * only, whatever file the path named.
 */
export function writeConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const old = regularBytes(file);
  if (old !== null) writeFresh(`${file}.bak`, old, 0o600);
  writeFresh(file, `${JSON.stringify(config, null, 2)}\n`, 0o644);
}

// Whether the settings path holds nothing, a regular file or a link, which the
// write replaces; a folder or a FIFO there is refused.
function replaceable(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() || st.isSymbolicLink();
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return true;
    throw e;
  }
}

// ---- rules ----

/** The rules template: the text between the markers in SKILL.md, each placeholder in it once. */
export function templateOf(skillText) {
  const text = lf(skillText);
  const start = text.indexOf(RULES_START);
  const end = text.indexOf(RULES_END);
  if (count(text, RULES_START) !== 1 || count(text, RULES_END) !== 1 || end < start) {
    throw new Error("SKILL.md 에서 규칙 틀(anti-drm:rules 표시)을 찾지 못했습니다");
  }
  const template = text.slice(start + RULES_START.length, end).replace(/^\n+|\n+$/g, "");
  if (PLACES.some((p) => count(template, p) !== 1) || MARKERS.some((m) => template.includes(m))) {
    throw new Error("SKILL.md 의 규칙 틀에 자리 표시가 한 번씩 있지 않거나 관리 표시가 들어 있습니다");
  }
  return template;
}

const loadTemplate = (o) => templateOf(readFileSync(o.skillFile, "utf8"));

// Where each denied extension goes: the first of `order` the settings allow,
// else the first replacement in the settings.
const PREFER = [
  { exts: [".txt", ".doc", ".docx", ".hwp", ".hwpx"], order: [".md", ".html"] },
  { exts: [".pdf", ".ppt", ".pptx"], order: [".html", ".md"] },
  { exts: [".xls", ".xlsx", ".csv"], order: [".tsv", ".md", ".html"] },
];
const OTHER_ORDER = [".md", ".html", ".tsv"];

/** The replacement for one denied extension. */
export function replacementFor(ext, alt) {
  const order = PREFER.find((p) => p.exts.includes(ext))?.order ?? OTHER_ORDER;
  return order.find((x) => alt.includes(x)) ?? alt[0];
}

// What a replacement is for, as the rules say it.
function useOf(ext, config) {
  if (ext === ".md") return config.alt.includes(".tsv") ? "글과 메모" : "글과 메모. 표 데이터는 마크다운 표";
  if (ext === ".html") return "서식 문서와 발표 자료";
  if (ext !== ".tsv") return "사용자가 정한 대체 확장자";
  return config.tsvDelimiter === "comma"
    ? "표 데이터. CSV 내용을 그대로 쓰고 확장자만 .tsv. 읽고 쓰는 코드에 구분자 쉼표를 명시"
    : "표 데이터. 탭으로 구분하고 첫 줄은 머리글";
}

const table = (head, rows) =>
  [`| ${head[0]} | ${head[1]} |`, "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n");
const code = (ext) => `\`${ext}\``;

/** The rules: the template filled from the settings. */
export function renderRules(template, config) {
  const map = table(["금지 확장자", "대신 쓸 확장자"], config.deny.map((d) => [code(d), code(replacementFor(d, config.alt))]));
  const alts = table(["확장자", "쓰는 곳"], config.alt.map((a) => [code(a), useOf(a, config)]));
  return template.replace("{{map}}", () => map).replace("{{alts}}", () => alts);
}

// ---- commands ----

const USAGE =
  "사용법: anti-drm on | off | status | config [--runtime claude|codex] [--deny <확장자 목록> --alt <확장자 목록> [--tsv tab|comma]]";

// The settings as `status` shows them.
function configLines(o, found) {
  if (found === null) return ["- 설정: 없음 (on 이나 config 로 만듦)"];
  if (found.error) return [`- 설정: 올바르지 않음 (${found.error}): ${where(o.configFile)}`];
  const { deny, alt, tsvDelimiter } = found.config;
  const lines = [
    `- 설정: ${where(o.configFile)}`,
    `  - 금지 확장자 ${deny.length}개: ${deny.join(" ")}`,
    `  - 대체 확장자 ${alt.length}개: ${alt.join(" ")}`,
  ];
  if (alt.includes(".tsv")) lines.push(`  - TSV 구분자: ${tsvDelimiter === "comma" ? "쉼표" : "탭"}`);
  return lines;
}

// The saved settings, or why they cannot be read, for status.
function foundConfig(o) {
  try {
    return readConfig(o.configFile);
  } catch (e) {
    return { error: `읽을 수 없음 (${where(e.code || e.message)})` };
  }
}

/** The settings and both runtimes' state. */
export function status(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const found = foundConfig(o);
  const lines = ["anti-drm 상태", ...configLines(o, found)];
  let rules;
  if (found?.config) {
    try {
      rules = renderRules(loadTemplate(o), found.config);
    } catch (e) {
      lines.push(`- 규칙 틀을 읽지 못해 규칙은 비교하지 않음 (${where(e.code || e.message)})`);
    }
  }
  lines.push(...stateLines(TOGGLE, o, rules));
  return done(lines.join("\n"));
}

// Saves the settings, as a result to report.
function save(o, config) {
  if (!replaceable(o.configFile)) return refuse(`일반 파일이 아니라 설정을 저장하지 않았습니다: ${where(o.configFile)}`);
  try {
    writeConfig(o.configFile, config);
  } catch (e) {
    if (denied(e)) return refuse(`쓸 권한이 없어 설정을 저장하지 못했습니다 (${e.code}): ${where(o.configFile)}`);
    throw e;
  }
  return done(`설정을 저장했습니다: ${where(o.configFile)}`);
}

// New rules in each runtime that holds the rules, but `skip`. A runtime that
// refuses, or whose files cannot be read, is reported, not thrown: the
// settings are saved by now.
function refresh(o, rules, skip) {
  const results = [];
  for (const runtime of RUNTIMES.filter((r) => r !== skip)) {
    try {
      if (present(TOGGLE, runtime, o)) results.push(toggleOn(TOGGLE, runtime, o, () => rules));
    } catch (e) {
      results.push(refuse(`${RUNTIME_NAME[runtime]}: 규칙을 갱신하지 못했습니다 (${where(e.code || e.message)})`));
    }
  }
  return results;
}

// The settings from --deny, --alt and --tsv: { config }, { error }, or { usage } when a list is missing.
function configFromFlags(flags) {
  if (flags.deny === undefined || flags.alt === undefined) return { usage: true };
  const tsvDelimiter = (flags.tsv ?? "tab").toLowerCase();
  return checkConfig({ deny: splitList(flags.deny), alt: splitList(flags.alt), tsvDelimiter });
}

const settingsGiven = (flags) => ["deny", "alt", "tsv"].some((k) => flags[k] !== undefined);

// Saves settings given on the command line and refreshes the runtimes that
// hold the rules, but `skip`: { rules, lines, ok, refreshed } or { refusal }.
function applySettings(o, flags, skip) {
  const got = configFromFlags(flags);
  if (got.usage) return { refusal: refuse(USAGE) };
  if (got.error) return { refusal: refuse(`설정을 저장하지 않았습니다: ${got.error}`) };
  const rules = renderRules(loadTemplate(o), got.config);
  const saved = save(o, got.config);
  if (!saved.ok) return { refusal: saved };
  const results = refresh(o, rules, skip);
  return { rules, lines: [saved.message, ...results.map((r) => r.message)], ok: results.every((r) => r.ok), refreshed: results.length };
}

// The rules from the saved settings: { rules, lines, ok } or { refusal }.
function savedRules(o) {
  const found = readConfig(o.configFile);
  if (found === null) return { refusal: refuse("설정이 없습니다. 금지 확장자와 대체 확장자를 --deny, --alt 로 함께 주세요.") };
  if (found.error) {
    return { refusal: refuse(`설정 파일이 올바르지 않습니다 (${found.error}): ${where(o.configFile)}. config 로 다시 만드세요.`) };
  }
  return { rules: renderRules(loadTemplate(o), found.config), lines: [], ok: true };
}

function cmdOn(o, runtime, flags) {
  const s = settingsGiven(flags) ? applySettings(o, flags, runtime) : savedRules(o);
  if (s.refusal) return s.refusal;
  const result = toggleOn(TOGGLE, runtime, o, () => s.rules);
  const lines = [...s.lines, result.message];
  if (result.ok) lines.push("", "적용할 규칙:", s.rules);
  return { ok: s.ok && result.ok, message: lines.join("\n") };
}

function cmdOff(o, runtime) {
  const result = toggleOff(TOGGLE, runtime, o);
  if (!result.ok || !existsSync(o.configFile)) return result;
  return done(`${result.message}\n설정은 남겨 두었습니다. 다시 켜면 그대로 씁니다: ${where(o.configFile)}`);
}

function cmdConfig(o, flags) {
  const s = applySettings(o, flags, null);
  if (s.refusal) return s.refusal;
  const lines = [...s.lines];
  if (s.refreshed === 0) lines.push("켜진 런타임이 없어 규칙은 바꾸지 않았습니다. 켜려면 on 을 실행하세요.");
  else lines.push("", "적용할 규칙:", s.rules);
  return { ok: s.ok, message: lines.join("\n") };
}

/** `on` for one runtime; flags are --deny, --alt and --tsv as the command line gives them. */
export const turnOn = (runtime, opts = {}, flags = {}) => cmdOn({ ...DEFAULTS, ...opts }, runtime, flags);
/** `off` for one runtime. */
export const turnOff = (runtime, opts = {}) => cmdOff({ ...DEFAULTS, ...opts }, runtime);
/** `config`: saves the settings and refreshes the runtimes that hold the rules. */
export const configure = (opts = {}, flags = {}) => cmdConfig({ ...DEFAULTS, ...opts }, flags);

// ---- command line ----

const FLAG_NAMES = ["runtime", "deny", "alt", "tsv"];
const COMMANDS = ["on", "off", "status", "config"];

/** { command, runtime, flags, extra } from the command line; each flag takes "x" or "=x". */
export function parseArgs(argv) {
  const rest = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (m && FLAG_NAMES.includes(m[1])) flags[m[1]] = m[2] ?? argv[++i] ?? "";
    else rest.push(argv[i]);
  }
  const { runtime, ...settings } = flags;
  return { command: (rest[0] ?? "status").toLowerCase(), runtime: runtime?.toLowerCase() ?? null, flags: settings, extra: rest.slice(1) };
}

// Settings flags go only with on and config, and config needs both lists.
function settingsUsage(command, flags) {
  if (command === "config") return flags.deny === undefined || flags.alt === undefined ? USAGE : "";
  return command === "on" || Object.keys(flags).length === 0 ? "" : USAGE;
}

// Why the command line cannot run as given, or "" when it can.
function usageError({ command, runtime, flags, extra }) {
  if (extra.length > 0 || !COMMANDS.includes(command)) return USAGE;
  if (runtime !== null && !RUNTIMES.includes(runtime)) return USAGE;
  return settingsUsage(command, flags);
}

// The runtime on and off act on: the flag, else Claude Code when it runs this.
const runtimeOf = (flag, env) => flag ?? (env.CLAUDECODE === "1" ? "claude" : null);

function run(command, runtime, flags) {
  const o = { ...DEFAULTS };
  if (command === "status") return status(o);
  if (command === "config") return cmdConfig(o, flags);
  return command === "on" ? cmdOn(o, runtime, flags) : cmdOff(o, runtime);
}

function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const why = usageError(args);
  if (why) {
    process.stdout.write(`${why}\n`);
    return 1;
  }
  const runtime = runtimeOf(args.runtime, env);
  if ((args.command === "on" || args.command === "off") && !RUNTIMES.includes(runtime)) {
    process.stdout.write(`런타임을 정할 수 없습니다. --runtime claude 또는 --runtime codex 를 붙이세요.\n${USAGE}\n`);
    return 1;
  }
  try {
    const { ok, message } = run(args.command, runtime, args.flags);
    process.stdout.write(`${message}\n`);
    return ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(`예기치 못한 오류로 중단했습니다: ${where(e.message)}\nstatus 로 상태를 확인하세요.\n`);
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
