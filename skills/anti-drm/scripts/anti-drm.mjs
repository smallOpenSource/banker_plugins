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
 *   node anti-drm.mjs on --runtime claude|codex --stdin
 *   node anti-drm.mjs config --stdin
 *
 * <list> is extensions split by commas or spaces, such as ".txt,.pdf".
 * --stdin reads the settings from standard input instead, one line each:
 * deny=<list>, alt=<list> and tsv=tab|comma. The skill passes them in a
 * quoted heredoc, so no value the user chose is ever read by a shell.
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
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEEP_CLOSE,
  KEEP_OPEN,
  RUNTIMES,
  count,
  denied,
  done,
  hasMarker,
  lf,
  LINK_REPLACED,
  noBom,
  present,
  refuse,
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

const RUNTIME_NAME = { claude: "Claude Code", codex: "Codex" };
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
  // In any letter case, as the --tsv flag takes it; kept lower-cased.
  const tsv = typeof tsvDelimiter === "string" ? tsvDelimiter.toLowerCase() : tsvDelimiter;
  if (tsv !== "tab" && tsv !== "comma") {
    return { error: `TSV 구분자는 tab 이나 comma 여야 합니다: ${shown(tsvDelimiter)}` };
  }
  return { config: { version: 1, deny: d.list, alt: a.list, tsvDelimiter: tsv } };
}

/**
 * Whether the owner of a settings file may steer this account's rules: this
 * account, or root when only root can write the file (settings IT deployed).
 */
export const ownerTrusted = (st, uid) => st.uid === uid || (st.uid === 0 && (st.mode & 0o022) === 0);
const ownedByOther = (st) => typeof process.getuid === "function" && !ownerTrusted(st, process.getuid());

// What opening the settings file can fail with, as the status line says it.
const OPEN_ERRORS = new Map([
  ["EISDIR", "일반 파일이 아닙니다"],
  ["ELOOP", "일반 파일이 아닙니다"],
  ["EACCES", "읽을 권한이 없습니다"],
  ["EPERM", "읽을 권한이 없습니다"],
]);

// The settings file's text: null when there is none, { error } when it is not a
// regular file of at most 64 KiB that a trusted owner holds. Opening without
// blocking keeps a FIFO from hanging the command, and another account's file
// cannot steer this account's rules.
function settingsText(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    if (OPEN_ERRORS.has(e.code)) return { error: OPEN_ERRORS.get(e.code) };
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
    raw = JSON.parse(noBom(text));
  } catch {
    return { error: "JSON 이 아닙니다" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "JSON 객체가 아닙니다" };
  return checkConfig({ deny: raw.deny, alt: raw.alt, tsvDelimiter: raw.tsvDelimiter ?? "tab" });
}

// What sits at the settings path: "none", "file" (a regular file with this one name), "link" (a link, wherever it
// leads), "hardlink" (a regular file with another name too) or "other" (a folder, a FIFO). The save replaces a link
// or a hard link by this name only: what it led to stays, so nothing of it is read or kept.
function pathKind(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return "none";
    throw e;
  }
  if (st.isSymbolicLink()) return "link";
  if (!st.isFile()) return "other";
  return st.nlink > 1 ? "hardlink" : "file";
}

// Opened without blocking. O_NOFOLLOW, where the system has it, keeps the open from following a link put at the name
// after the first look; Windows has none, so there the name is looked at again after the open.
const PRIOR_OPEN = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * What the settings name holds after the open, against the opened file, from their bigint stats: "same", "link" (a
 * link now: the open followed it), "hardlink" (the opened file has another name now) or "changed" (gone, not a regular
 * file, or another file: the file IDs differ; an ID of 0, which some file systems give, proves nothing).
 */
export function nameNow(opened, now) {
  if (now?.isSymbolicLink()) return "link";
  if (!now?.isFile()) return "changed";
  if (opened.ino !== 0n && (now.ino !== opened.ino || now.dev !== opened.dev)) return "changed";
  return now.nlink > 1n ? "hardlink" : "same";
}

// The name's own stats in bigint, or null when it cannot be looked at.
function lstatOrNull(file) {
  try {
    return lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
}

// What the file opened at the settings path gives, as priorBytes says. Without O_NOFOLLOW the name must still hold it.
function openedBytes(file, fd, noFollow) {
  const st = fstatSync(fd);
  if (!st.isFile() || st.nlink > 1) return { bytes: null };
  const now = noFollow ? "same" : nameNow(fstatSync(fd, { bigint: true }), lstatOrNull(file));
  if (now === "changed") return { refusal: "확인하는 사이에 바뀐 자리라 설정을 저장하지 않았습니다" };
  if (now !== "same") return { bytes: null };
  if (st.size > MAX_BYTES) return { refusal: "64KiB 보다 큰 파일이라 설정을 저장하지 않았습니다" };
  return { bytes: readFileSync(fd) };
}

/**
 * The bytes of the regular file with this one name at the settings path: { bytes } (null when it turned out to be
 * something else: gone, a link, not a regular file, or a file with another name too, which the save loses nothing
 * of) or { refusal }. noFollow is O_NOFOLLOW where the system has it; 0 takes the Windows way.
 */
export function priorBytes(file, noFollow = NO_FOLLOW) {
  let fd;
  try {
    fd = openSync(file, PRIOR_OPEN | noFollow);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "ELOOP") return { bytes: null };
    if (denied(e)) return { refusal: "읽을 수 없는 파일이라 설정을 저장하지 않았습니다" };
    throw e;
  }
  try {
    return openedBytes(file, fd, noFollow);
  } finally {
    closeSync(fd);
  }
}

// The keys anti-drm writes; a file with any other key holds something of the user's.
const OWN_KEYS = ["version", "deny", "alt", "tsvDelimiter"];

// Whether bytes are settings anti-drm wrote (or could have): nothing is lost when they go.
function ownSettings(bytes) {
  try {
    const text = bytes.toString("utf8");
    const raw = JSON.parse(noBom(text));
    const plain = Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
    return plain && Object.keys(raw).every((k) => OWN_KEYS.includes(k)) && Boolean(checkConfig(raw).config);
  } catch {
    return false;
  }
}

// Keeps a file anti-drm did not write at bak, once, and says what it did: "kept", "earlier" (a regular file is there
// already and stays) or "other" (something else is there: a link, a dangling one too, or a folder; nothing is written).
// The note comes from the same look as the write.
function keepOnce(bak, bytes) {
  let st;
  try {
    st = lstatSync(bak);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    writeFresh(bak, bytes, 0o600);
    return "kept";
  }
  return st.isFile() ? "earlier" : "other";
}

// What a save finds at the settings path: { keep } (the bytes to put in .bak, null for none: nothing there, a link
// or a hard link, whose file stays, or anti-drm's own settings) or { refusal }.
function priorSettings(file) {
  const kind = pathKind(file);
  if (kind === "other") return { refusal: "일반 파일이 아니라 설정을 저장하지 않았습니다" };
  if (kind !== "file") return { keep: null };
  const got = priorBytes(file);
  if (got.refusal) return got;
  return { keep: got.bytes === null || ownSettings(got.bytes) ? null : got.bytes };
}

/**
 * Saves the settings: the folder 0755, the file 0644 through a temp file and a
 * rename. keep, when given, is a file anti-drm did not write; its bytes go to
 * <file>.bak, readable by this account only, once: a .bak already there is the
 * first such file and stays. Gives back what became of keep: null when none was
 * given, else "kept", "earlier" or "other" (see keepOnce).
 */
export function writeConfig(file, config, keep = null) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const kept = keep === null ? null : keepOnce(`${file}.bak`, keep);
  writeFresh(file, `${JSON.stringify(config, null, 2)}\n`, 0o644);
  return kept;
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
  if (PLACES.some((p) => count(template, p) !== 1) || MARKERS.some((m) => template.includes(m)) || hasMarker(template)) {
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
  const rules = template.replace("{{map}}", () => map).replace("{{alts}}", () => alts);
  if (rules.includes("{{")) throw new Error("규칙을 채운 뒤에도 자리 표시({{)가 남았습니다");
  return rules;
}

// ---- commands ----

const USAGE =
  "사용법: anti-drm on | off | status | config [--runtime claude|codex] [--stdin | --deny <확장자 목록> --alt <확장자 목록> [--tsv tab|comma]]\n" +
  "--stdin 은 표준 입력이 끝날 때까지 기다립니다.";

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

// What a save does beyond writing the settings, as lines to report: a link or a hard link at the settings path becomes
// a regular file (what it led to stays, and nothing of it goes to .bak), and a file anti-drm did not write goes to
// .bak, or is not kept when an earlier one, or something that is not a regular file, is there already. kept is what
// writeConfig gave back.
const KEPT_NOTES = {
  kept: (bak) => `참고: anti-drm 이 쓰지 않은 원래 파일은 ${bak} 에 남겼습니다.`,
  earlier: (bak) => `참고: anti-drm 이 쓰지 않은 원래 파일은 남기지 않았습니다. 먼저 남긴 파일이 있습니다: ${bak}`,
  other: (bak) => `참고: anti-drm 이 쓰지 않은 원래 파일은 남기지 않았습니다. 그 자리에 일반 파일이 아닌 것이 있습니다: ${bak}`,
};
const REPLACED_NOTES = {
  link: LINK_REPLACED,
  hardlink: "참고: 하드 링크였던 자리를 일반 파일로 바꿨습니다. 같은 파일의 다른 이름은 건드리지 않았습니다.",
};
function saveNotes(file, replaced, kept) {
  const notes = REPLACED_NOTES[replaced] ? [REPLACED_NOTES[replaced]] : [];
  if (kept) notes.push(KEPT_NOTES[kept](where(`${file}.bak`)));
  return notes;
}

// Saves the settings, as a result to report. The look just before the write names what the rename replaces.
function save(o, config) {
  let notes;
  try {
    const prior = priorSettings(o.configFile);
    if (prior.refusal) return refuse(`${prior.refusal}: ${where(o.configFile)}`);
    const replaced = pathKind(o.configFile);
    notes = saveNotes(o.configFile, replaced, writeConfig(o.configFile, config, prior.keep));
  } catch (e) {
    if (denied(e)) return refuse(`쓸 권한이 없어 설정을 저장하지 못했습니다 (${e.code}): ${where(o.configFile)}`);
    throw e;
  }
  return done([`설정을 저장했습니다: ${where(o.configFile)}`, ...notes].join("\n"));
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
  return checkConfig({ deny: splitList(flags.deny), alt: splitList(flags.alt), tsvDelimiter: flags.tsv ?? "tab" });
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
  if (found === null) return { refusal: refuse("설정이 없습니다. 금지 확장자와 대체 확장자를 --stdin 이나 --deny, --alt 로 함께 주세요.") };
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

/**
 * { command, runtime, flags, extra, stdin } from the command line; each value
 * flag takes "x" or "=x", and --stdin takes nothing.
 */
export function parseArgs(argv) {
  const rest = [];
  const flags = {};
  let stdin = false;
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (m && FLAG_NAMES.includes(m[1])) flags[m[1]] = m[2] ?? argv[++i] ?? "";
    else if (argv[i] === "--stdin") stdin = true;
    else rest.push(argv[i]);
  }
  const { runtime, ...settings } = flags;
  const command = (rest[0] ?? "status").toLowerCase();
  return { command, runtime: runtime?.toLowerCase() ?? null, flags: settings, extra: rest.slice(1), stdin };
}

// Lines on standard input that hold the settings: the key, "=", the value.
const STDIN_LINE = /^(deny|alt|tsv)=(.*)$/;
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/**
 * The settings on standard input as flags: { flags } or { error }. At most
 * 64 KiB of UTF-8; a leading byte order mark and CRLF line ends are fine;
 * each of deny=, alt= and tsv= once; blank lines are skipped.
 */
export function stdinSettings(bytes) {
  if (bytes.length > MAX_BYTES) return { error: "표준 입력이 64KiB 보다 큽니다" };
  let text;
  try {
    text = UTF8_STRICT.decode(bytes);
  } catch {
    return { error: "표준 입력이 UTF-8 이 아닙니다" };
  }
  const flags = {};
  for (const line of noBom(text).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = STDIN_LINE.exec(line);
    if (!m || flags[m[1]] !== undefined) return { error: `표준 입력의 설정 줄을 읽을 수 없습니다: ${shown(line)}` };
    flags[m[1]] = m[2].trim();
  }
  return { flags };
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

// Standard input, read up to cap bytes and one more: { bytes } at the end of input, or { tooBig: true } as soon as
// more than cap came. A pipe left non-blocking answers EAGAIN until data comes: wait a little and read again.
function readCapped(fd, cap) {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    const n = readSome(fd, buf);
    if (n === 0) return { bytes: Buffer.concat(chunks) };
    total += n;
    if (total > cap) return { tooBig: true };
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
}

// One read into buf: how many bytes came, 0 at the end of input (Windows may say EOF instead).
function readSome(fd, buf) {
  for (;;) {
    try {
      return readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EOF") return 0;
      if (e.code !== "EAGAIN") throw e;
      Atomics.wait(PAUSE, 0, 0, 10);
    }
  }
}

// The settings standard input held: an error when it was too big or unreadable, or held no settings line, which
// on and config both refuse rather than reach for the saved settings.
function stdinFrom(got) {
  if (got.tooBig) return { error: "표준 입력이 64KiB 보다 큽니다" };
  const read = stdinSettings(got.bytes);
  if (read.error || Object.keys(read.flags).length > 0) return read;
  return { error: "표준 입력에 설정 줄이 없습니다" };
}

// Settings flags go only with on and config, and config needs both lists.
function settingsUsage(command, flags) {
  if (command === "config") return flags.deny === undefined || flags.alt === undefined ? USAGE : "";
  return command === "on" || Object.keys(flags).length === 0 ? "" : USAGE;
}

// Why the command line cannot run as given, or "" when it can.
function usageError({ command, runtime, flags, extra, stdin }) {
  if (extra.length > 0 || !COMMANDS.includes(command)) return USAGE;
  if (runtime !== null && !RUNTIMES.includes(runtime)) return USAGE;
  // --stdin brings all the settings, so it goes with on and config only and never with a settings flag.
  if (stdin) return (command === "on" || command === "config") && Object.keys(flags).length === 0 ? "" : USAGE;
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

// Writes a message line and gives back the exit status.
const say = (text, code) => {
  process.stdout.write(`${text}\n`);
  return code;
};

// Whether a command acts on one runtime and so needs to know which.
const needsRuntime = (command) => command === "on" || command === "off";
// The settings flags: from standard input with --stdin, else from the command line.
const settingsOf = (args, input) => (args.stdin ? stdinFrom(input()) : { flags: args.flags });

function main(argv, env = process.env, input = () => readCapped(0, MAX_BYTES)) {
  const args = parseArgs(argv);
  const why = usageError(args);
  if (why) return say(why, 1);
  const runtime = runtimeOf(args.runtime, env);
  if (needsRuntime(args.command) && !RUNTIMES.includes(runtime)) {
    return say(`런타임을 정할 수 없습니다. --runtime claude 또는 --runtime codex 를 붙이세요.\n${USAGE}`, 1);
  }
  try {
    const got = settingsOf(args, input);
    if (got.error) return say(`${got.error}\n${USAGE}`, 1);
    const { ok, message } = run(args.command, runtime, got.flags);
    return say(message, ok ? 0 : 1);
  } catch (e) {
    return say(`예기치 못한 오류로 중단했습니다: ${where(e.message)}\nstatus 로 상태를 확인하세요.`, 2);
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
