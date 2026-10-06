#!/usr/bin/env node
/**
 * verifier-probe: which external CLI seats ralph-qa can seat, and with which model,
 * worked out from this machine alone. It sends no HTTP request and no prompt itself. The
 * only child processes are `codex --version` and `codex debug models --bundled`; it starts no
 * gemini and no opencode (opencode 1.3.10 empties its cache folder, the models.dev copy the probe
 * reads too, on any start that finds the folder's version file missing or old).
 *
 *   node verifier-probe.mjs --runtime=claude|codex [--codex[=<model>]] [--gemini[=<model>]] [--opencode[=<provider/model>]]
 *
 * Only the CLIs named by a flag are looked at; with none, there are no external seats
 * (reason "no-flag"). For each one it prints a seat with a decision:
 *   adopt     seat it with `model` (`reason` says why that model is the best known one)
 *   ask       the best model is unclear: offer `options` (best first; may be empty, then ask
 *             for a model by name). `fallback` is what to seat when nobody can be asked:
 *             a model, "@cli-default" (run the CLI without a model flag; only when its
 *             config names no model at all) or null, and then `noAskReason` is the reason
 *             to report
 *   unseated  `reason` says why not
 * The author's own family is never adopted, offered or used as a fallback (Claude Code runs
 * Claude models, Codex runs GPT models and whatever family its config.toml names), and
 * neither is codex when the author is Codex. When the runtime is unknown, or the flag and the
 * environment disagree on it, both families are left out and codex is not seated. A model
 * whose family cannot be read from its name is never adopted on its own or used as a
 * fallback; it is listed under `unclassified`. A model given with the flag is taken as is,
 * with `familyKnown: false` when its family cannot be read. A name that could carry shell
 * syntax is dropped with a note, wherever it comes from: the seat commands put the chosen
 * name on a command line.
 *
 * Sources, all local: codex's bundled catalog (ordered by `priority`) and its config files
 * (/etc/codex/managed_config.toml, config.toml under $CODEX_HOME or ~/.codex, /etc/codex/config.toml;
 * their MCP servers, however the TOML defines them, are listed as `mcpServers` so the seat can
 * turn them off, and a server it cannot turn off keeps codex unseated, as does a managed file
 * that sets a key the seat turns off); gemini's $GEMINI_MODEL, its system and user settings.json
 * (the user's under $GEMINI_CLI_HOME when set; settings that widen the seat's workspace keep it
 * unseated, and usage statistics left on are noted) and whether its system policy folder holds
 * policies;
 * opencode's global, $OPENCODE_CONFIG, ~/.opencode, $OPENCODE_CONFIG_DIR and managed configs
 * and its local copy of the models.dev list. Left out on purpose: the reviewed repository's own
 * gemini and opencode settings and $OPENCODE_CONFIG_CONTENT, because the seats run in the
 * payload folder with project config off and replace that variable. Whether a provider
 * actually serves a model is not checked here: the seat's first call is the check.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEAT_NAMES = ["codex", "gemini", "opencode"];

// The value of the `--runtime` at `i` and how many words it takes: `--runtime=x` one,
// `--runtime x` two, unless x is another flag, which is then read in its own turn.
function runtimeValue(argv, i, inline) {
  if (inline !== undefined) return [inline, 1];
  const next = argv[i + 1];
  return next !== undefined && !next.startsWith("--") ? [next, 2] : ["", 1];
}

export function parseArgs(argv) {
  const requested = {};
  const unknown = [];
  let runtime = "";
  for (let i = 0; i < argv.length; ) {
    const seat = /^--(codex|gemini|opencode)(?:=(.*))?$/.exec(argv[i]);
    const rt = /^--runtime(?:=(.*))?$/.exec(argv[i]);
    let used = 1;
    if (seat) requested[seat[1]] = seat[2] || null;
    else if (rt) [runtime, used] = runtimeValue(argv, i, rt[1]);
    else unknown.push(argv[i]);
    i += used;
  }
  return { requested, runtime: runtime.trim().toLowerCase() || null, unknown };
}

// A model's family from anywhere in its name: provider prefixes, region prefixes and gateway
// spellings (`amazon-bedrock/us.anthropic.claude-…`, `litellm/sonnet`, `gitlab/duo-chat-gpt-5`).
// The two author families match loosely on purpose: a miss would seat the author's own model
// as an independent one.
const FAMILIES = [
  ["claude", /claude|anthropic|(^|[^a-z])(opus|sonnet|haiku)([^a-z]|$)/],
  ["gpt", /openai|(^|[^a-z])(chat)?gpt(?![a-z])|(^|[^a-z])codex|(^|[^a-z])o\d/],
  ["gemini", /gemini/],
  ["gemma", /gemma/],
  ["qwen", /qwen/],
  ["llama", /llama/],
  ["mistral", /mistral|mixtral|codestral|devstral|magistral/],
  ["deepseek", /deepseek/],
  ["grok", /grok|(^|[^a-z])xai[/.]/],
  ["phi", /(^|[^a-z])phi-?\d/],
  ["kimi", /kimi|moonshot/],
  ["glm", /(^|[^a-z])glm|zhipu/],
  ["minimax", /minimax/],
  ["nova", /amazon\.nova|(^|[^a-z])nova-(pro|lite|micro|premier)/],
  ["cohere", /cohere|command-r/],
];
const FAMILY_RE = Object.fromEntries(FAMILIES);
// gemini's own aliases; it resolves them to Gemini models (`auto` routes between Pro and Flash).
const GEMINI_ALIASES = new Set(["pro", "auto", "flash", "flash-lite"]);

export function familyOf(model) {
  const name = String(model ?? "").toLowerCase();
  if (GEMINI_ALIASES.has(name)) return "gemini";
  for (const [family, re] of FAMILIES) if (re.test(name)) return family;
  return null;
}

// True when the name matches any author family at all, not just as its first family.
export function isAuthorFamily(model, authorFamilies) {
  const name = String(model ?? "").toLowerCase();
  return authorFamilies.some((family) => FAMILY_RE[family].test(name));
}

// What a model name may hold to go on a seat's command line: letters, digits and `._:/@+-`,
// starting with a letter or digit. No spaces, quotes, `$`, backticks or other shell syntax.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
export const safeModel = (m) => typeof m === "string" && SAFE_MODEL.test(m);

// The safe names among `models`, with a note for each one dropped (its length, not its text).
function safeOnly(models, where, notes) {
  const out = [];
  for (const m of models) {
    if (m == null || m === "") continue;
    if (safeModel(m)) out.push(m);
    else notes.push(`model name dropped (${where}, ${String(m).length} characters): it holds characters a command line cannot carry safely`);
  }
  return out;
}

const AUTHOR_FAMILIES = { claude: ["claude"], codex: ["gpt"] };
const UNKNOWN_AUTHOR = ["claude", "gpt"];

// Environment markers each runtime leaves on the shells it starts. Both or neither: unknown.
export const RUNTIME_MARKERS = {
  claude: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
  codex: ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM", "CODEX_MANAGED_PACKAGE_ROOT"],
};

export function detectRuntime(env) {
  const hits = Object.keys(RUNTIME_MARKERS).filter((rt) => RUNTIME_MARKERS[rt].some((k) => env[k]));
  return hits.length === 1 ? hits[0] : null;
}

// The runtime to probe for: the flag, the markers when there is no flag, and neither when they
// disagree (the probe then treats the runtime as unknown and says why).
export function resolveRuntime(flag, env) {
  const detected = detectRuntime(env);
  if (flag && detected && flag !== detected) return `${flag} (the environment says ${detected})`;
  return flag ?? detected;
}

// Why a seat ends up empty. The probe sets most; the skill sets model-declined (the person
// dropped the seat when asked), cli-call-failed when the first call failed with no candidate
// left to switch to, and the `noAskReason` of an ask it could not put to anyone. The probe sets
// cli-call-failed too when every call would fail (codex's legacy profile) or the seat could not
// hold its guards (MCP servers it cannot list or turn off, a managed or requirements file over
// the seat's flags, gemini's system policies, settings that widen gemini's workspace); `notes`
// then says what to change. SKILL.md lists the same set.
export const ABSENT_REASONS = [
  'no-flag',
  'self-family',
  'self-runtime',
  'model-declined',
  'runtime-unknown',
  'cli-absent',
  'no-independent-model',
  'no-default-model',
  'cli-call-failed',
];

// Why a model was adopted (the first five) or asked about (the rest). SKILL.md lists the same set.
export const DECISION_REASONS = [
  'flag',
  'catalog-top-is-configured',
  'catalog-top',
  'cli-pro-alias',
  'single-candidate',
  'top-differs-from-configured',
  'custom-provider',
  'no-catalog',
  'open-model-set',
  'configured-vs-pro',
  'several-candidates',
  'no-candidate',
  'config-not-understood',
];

export const CLI_DEFAULT = "@cli-default";

const firstLine = (res) => (res?.status === 0 ? String(res.stdout).trim().split("\n")[0] || null : null);
const absent = (cli) => ({ cli, present: false, decision: "unseated", reason: "cli-absent" });
const adopt = (seat, model, reason) => ({ ...seat, decision: "adopt", model, reason });
const withNotes = (seat, notes) => (notes.length ? { ...seat, notes: [...new Set([...(seat.notes ?? []), ...notes])] } : seat);

// TOML keys: bare, "basic" or 'literal', dotted with optional spaces (`a."b.c" . d`). TOML ends a
// line only at \n or \r\n, so `.` runs over U+2028 and U+2029 too (the s flag): without it a
// comment holding one hid a header or a key that codex reads.
const KEY_SEG = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
const KEY_PATH = String.raw`${KEY_SEG}(?:\s*\.\s*${KEY_SEG})*`;
const HEADER_RE = new RegExp(String.raw`^\s*\[(\[?)\s*(${KEY_PATH})\s*\]\]?\s*(?:#.*)?$`, "s");
const ASSIGN_RE = new RegExp(String.raw`^\s*(${KEY_PATH})\s*=\s*(.*)$`, "s");
const SEG_RE = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+)/gs;
const STRING_VALUE = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/s;

// A dotted key's segments, quotes taken off (escapes kept as written).
const keyPath = (text) => [...text.matchAll(SEG_RE)].map((m) => m[1] ?? m[2] ?? m[3]);

// The walk's state: where it is (open string, nesting depth, table, array being gathered) and
// what it found so far.
const tomlState = () => ({ values: {}, arrays: {}, mcpServers: new Set(), mcpUnread: false, modelKeys: false,
  open: null, depth: 0, table: [], roots: new Set(), array: null, unplaced: false });

// The index just past the one-line string that opens at `i` (the line's end when it never closes).
function stringEnd(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (q === '"' && text[j] === "\\") j += 1;
    else if (text[j] === q) return j + 1;
  }
  return text.length;
}

// The index just past the delimiter that closes the multi-line string `open` (""" or ''') at or
// after `i`, -1 when this line does not close it. A basic one skips backslash escapes, and a run
// of up to five quotes ends with the last three of them (TOML lets one or two stand inside).
function multiEnd(text, i, open) {
  for (let j = i; j < text.length; j += 1) {
    if (open === '"""' && text[j] === "\\") j += 1;
    else if (text.startsWith(open, j)) {
      let k = j + 3;
      while (k < j + 5 && text[k] === open[0]) k += 1;
      return k;
    }
  }
  return -1;
}

// One step of walkValue outside a string: the index after the token at `i`, -1 at a comment.
function valueStep(state, text, i) {
  const three = text.slice(i, i + 3);
  if (three === '"""' || three === "'''") {
    state.open = three;
    return i + 3;
  }
  const c = text[i];
  if (c === "#") return -1;
  if (c === '"' || c === "'") return stringEnd(text, i);
  if (c === "[" || c === "{") state.depth += 1;
  if (c === "]" || c === "}") state.depth = Math.max(0, state.depth - 1);
  return i + 1;
}

// A value's text as it runs across lines: how deep `[` and `{` nesting is still open, and the
// multi-line string (""" or ''') still open, strings and comments aside. Inline tables can span
// lines too (TOML 1.1, which codex 0.144.5 reads).
function walkValue(state, text) {
  let i = 0;
  while (i >= 0 && i < text.length) {
    if (!state.open) {
      i = valueStep(state, text, i);
      continue;
    }
    const end = multiEnd(text, i, state.open);
    if (end < 0) return;
    state.open = null;
    i = end;
  }
}

// The MCP server a key path under mcp_servers names. One `mcp_servers = { ... }` inline table
// is not read for names: the probe could not say which servers to turn off.
function noteMcp(state, full) {
  if (full[0] !== "mcp_servers") return;
  if (full.length > 1) state.mcpServers.add(full[1]);
  else state.mcpUnread = true;
}

// True when a key path ends in `model`, or its inline-table value sets one.
const setsModel = (full, value) => full[full.length - 1] === "model" || (value.startsWith("{") && /[{,]\s*model\s*=/.test(value));

// The strings of a top-level array, gathered line by line until it closes; comments aside. The
// gathered text spans lines, so a comment ends at the line's end, U+2028 and U+2029 inside it.
const ARRAY_ITEM = /"((?:[^"\\]|\\.)*)"|'([^']*)'|#[^\r\n]*/gs;
function gatherArray(state, text) {
  if (!state.array) return;
  state.array.text += text + "\n";
  if (state.open || state.depth > 0) return;
  state.arrays[state.array.key] = [...state.array.text.matchAll(ARRAY_ITEM)].filter((m) => !m[0].startsWith("#")).map((m) => m[1] ?? m[2]);
  state.array = null;
}

// One `key = value` line: the MCP server it defines, whether it sets a model in any table,
// the multi-line string or array it opens, and a top-level string value or array of strings.
function assignment(state, path, value) {
  const full = [...state.table, ...path];
  state.roots.add(full[0]);
  noteMcp(state, full);
  if (setsModel(full, value)) state.modelKeys = true;
  if (full.length === 1 && value.startsWith("[")) state.array = { key: full[0], text: "" };
  walkValue(state, value);
  gatherArray(state, value);
  if (state.open || state.depth > 0) return;
  const str = state.table.length === 0 && path.length === 1 ? STRING_VALUE.exec(value) : null;
  if (str) state.values[path[0]] = str[1] ?? str[2];
}

// A table header: the table later keys go in, and the MCP server a [mcp_servers.<name>...] names.
function enterTable(state, header) {
  state.roots.add(keyPath(header[2])[0]);
  state.table = header[1] ? ["[[]]"] : keyPath(header[2]);
  if (state.table[0] === "mcp_servers" && state.table.length > 1) state.mcpServers.add(state.table[1]);
}

// One line of readToml into `state`: walked inside a multi-line string, array or inline table
// (a `model =` there still counts), else a table header or a `key = value`. Any other line but
// a comment or a blank one is a line the probe could not place (a key it cannot spell, such as a
// non-ASCII bare key), and the read is not whole.
function tomlLine(state, line) {
  if (state.open || state.depth > 0) {
    if (!state.open && /(?:^|[{,])\s*model\s*=/.test(line)) state.modelKeys = true;
    walkValue(state, line);
    gatherArray(state, line);
    return;
  }
  const header = HEADER_RE.exec(line);
  if (header) return enterTable(state, header);
  const assign = ASSIGN_RE.exec(line);
  if (assign) return assignment(state, keyPath(assign[1]), assign[2]);
  if (!/^\s*(?:#|$)/.test(line)) state.unplaced = true;
}

// The servers each [mcp_servers] header in the text names when the lines after it are walked
// alone, up to the next header. A cross-check on the walk, which a string it misreads (or text
// that only looks like a header) could lead past the block; a misread here only adds names.
function rawMcpBlockNames(lines) {
  const names = [];
  lines.forEach((line, i) => {
    const header = HEADER_RE.exec(line);
    if (!header || header[1] || keyPath(header[2]).join(".") !== "mcp_servers") return;
    const state = tomlState();
    state.table = ["mcp_servers"];
    for (const next of lines.slice(i + 1)) {
      if (!state.open && state.depth === 0 && HEADER_RE.test(next)) break;
      tomlLine(state, next);
    }
    names.push(...state.mcpServers);
  });
  return names;
}

// Every `mcp_servers.<name>` the text spells, comment lines aside, and the keys under each
// [mcp_servers] header: a cross-check on the walk.
const RAW_MCP = new RegExp(String.raw`mcp_servers\s*\.\s*(${KEY_SEG})`, "g");
const rawMcpNames = (lines) => lines.filter((l) => !/^\s*#/.test(l))
  .flatMap((l) => [...l.matchAll(RAW_MCP)].map((m) => keyPath(m[1])[0])).concat(rawMcpBlockNames(lines));


// What the probe reads from a TOML file: its top-level `key = "string"` pairs (quoted keys too),
// the first segment of every key and table (`roots`), the MCP server names wherever they are
// defined (table headers, under [mcp_servers], dotted keys), whether servers were written in a
// form it does not list or that the text names beyond what it listed (`mcpUnread`), whether any
// table sets a model (`modelKeys`), whether a multi-line string, array or inline table was left
// open or a line could not be placed (`broken`), and the strings of each top-level array
// (`arrays`). Enough for those keys; not a TOML parser.
export function readToml(text) {
  const state = tomlState();
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) tomlLine(state, line);
  const unlisted = rawMcpNames(lines).filter((n) => !state.mcpServers.has(n));
  return {
    values: state.values,
    roots: [...state.roots],
    arrays: state.arrays,
    mcpServers: [...state.mcpServers],
    mcpUnread: state.mcpUnread || unlisted.length > 0,
    modelKeys: state.modelKeys,
    broken: state.open !== null || state.depth > 0 || state.unplaced,
  };
}

export const topLevelToml = (text) => readToml(text).values;

// The comment or trailing comma that starts at `i`, as the index just past it; -1 when none.
function skipNoise(text, i) {
  if (text.startsWith("//", i)) {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith("/*", i)) {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (text[i] === ",") {
    let j = i + 1;
    while (/\s/.test(text[j] ?? "")) j += 1;
    if (text[j] === "}" || text[j] === "]") return i + 1;
  }
  return -1;
}

// JSON with comments and trailing commas (JSONC, as opencode and gemini accept) made plain.
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (inString) {
      const step = c === "\\" ? 2 : 1;
      out += text.slice(i, i + step);
      if (c === '"') inString = false;
      i += step;
      continue;
    }
    const next = skipNoise(text, i);
    if (next >= 0) {
      i = next;
      continue;
    }
    if (c === '"') inString = true;
    out += c;
    i += 1;
  }
  return out;
}

// { value } for a readable JSONC text, { unreadable: true } for a broken one, {} when absent.
function readJsonc(text) {
  if (text == null) return {};
  try {
    const value = JSON.parse(stripJsonc(String(text)));
    return value && typeof value === "object" && !Array.isArray(value) ? { value } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

// codex's bundled catalog: listed, API-served slugs by priority; null when it cannot be read.
function readCatalog(res, notes) {
  if (res?.status !== 0) return null;
  try {
    const models = JSON.parse(res.stdout).models;
    if (!Array.isArray(models)) return null;
    const slugs = models
      .filter((m) => m?.slug && m.visibility !== "hide" && m.supported_in_api !== false)
      .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
      .map((m) => m.slug);
    return safeOnly(slugs, "codex catalog", notes);
  } catch {
    return null;
  }
}

// Models split by what the probe may do with them: independent ones it may adopt or offer,
// unclassified ones only the person may pick; the author's own family is dropped.
function sortModels(models, authorFamilies) {
  const independent = [];
  const unclassified = [];
  for (const m of new Set(models.filter(Boolean))) {
    if (isAuthorFamily(m, authorFamilies)) continue;
    (familyOf(m) ? independent : unclassified).push(m);
  }
  return { independent, unclassified };
}

// The seat a flag-given model makes, or null when no model was given.
function flagged(base, model, authorFamilies) {
  if (!model) return null;
  if (isAuthorFamily(model, authorFamilies)) return { ...base, decision: "unseated", reason: "self-family" };
  return { ...base, decision: "adopt", model, reason: "flag", familyKnown: familyOf(model) !== null };
}

// An ask: options and fallback hold only models whose family is known (the rest stay listed
// under `unclassified`); with no fallback, `noAskReason` is what to report when nobody can be asked.
function ask(seat, options, fallback, reason, noAskReason = "no-default-model") {
  const known = [...new Set(options.filter((m) => m && familyOf(m)))];
  const safe = fallback === CLI_DEFAULT || (fallback && familyOf(fallback)) ? fallback : null;
  return { ...seat, decision: "ask", options: known, fallback: safe, reason, ...(safe ? {} : { noAskReason }) };
}

const codexConfigPath = (world) => join(world.env.CODEX_HOME || join(world.home, ".codex"), "config.toml");
const CODEX_MANAGED = "/etc/codex/managed_config.toml";
const CODEX_REQUIREMENTS = "/etc/codex/requirements.toml";

// codex's config files the probe can read, highest precedence first (codex 0.144.5): the legacy
// managed file, the user's config.toml, the system one. MDM and cloud layers are not files here.
function codexConfigFiles(world) {
  const user = codexConfigPath(world);
  return world.platform === "win32" ? [user] : [CODEX_MANAGED, user, "/etc/codex/config.toml"];
}

// Those layers as one: the first layer with a value wins, MCP servers add up.
function codexConfig(world) {
  const layers = codexConfigFiles(world).map((f) => readToml(world.readFile(f)));
  const pick = (key) => layers.map((l) => l.values[key]).find((v) => v !== undefined);
  return {
    cfg: { model: pick("model"), model_provider: pick("model_provider"), profile: pick("profile") },
    mcpServers: [...new Set(layers.flatMap((l) => l.mcpServers))],
    mcpUnread: layers.some((l) => l.mcpUnread),
    modelKeys: layers.some((l) => l.modelKeys),
    broken: layers.some((l) => l.broken),
  };
}

// What `-c mcp_servers.<name>.enabled=false` can address: codex splits the key on dots.
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

// The unseated seat when the seat command could not turn every MCP server off (a name `-c`
// cannot address, servers the probe could not list, a config it could not read to the end);
// null otherwise. An MCP tool runs outside codex's read-only sandbox.
function mcpBlockedSeat(seat, conf, notes) {
  const bad = conf.mcpServers.filter((n) => !MCP_NAME.test(n)).length;
  if (!bad && !conf.mcpUnread && !conf.broken) return null;
  if (bad) notes.push(`${bad} MCP server name(s) hold characters \`-c mcp_servers.<name>.enabled=false\` cannot address: rename them to letters, digits, _ and -`);
  if (conf.mcpUnread) notes.push("the probe could not list every MCP server the codex config defines (one inline mcp_servers table, or a name its walk did not place): write each server as its own [mcp_servers.<name>] table");
  if (conf.broken) notes.push("the probe could not read the codex config to its end (a multi-line string, array or inline table left open, or a line it could not place), so its list of MCP servers may be short");
  return { ...seat, decision: "unseated", reason: "cli-call-failed" };
}

// What the seat command turns off or pins with -c, --disable and -s. codex loads its legacy
// managed file last, over -c (0.144.5: "Overridden by legacy managed_config.toml"), so such a key
// there undoes the seat's guard.
const SEAT_KEYS = ["notify", "otel", "mcp_servers", "web_search", "tools", "analytics", "features", "hooks",
  "sandbox_mode", "sandbox_workspace_write", "approval_policy"];

// The unseated seat when the managed file sets one of those keys, or could not be read to its
// end (a line read short may set one); null otherwise.
function managedBlockedSeat(seat, world, notes) {
  if (world.platform === "win32") return null;
  const read = readToml(world.readFile(CODEX_MANAGED));
  const keys = read.roots.filter((k) => SEAT_KEYS.includes(k));
  if (!keys.length && !read.broken) return null;
  notes.push(`${CODEX_MANAGED} ${keys.length ? `sets ${keys.join(", ")}` : "could not be read to its end"}, which codex applies over the seat's -c flags: the seat cannot hold its guards`);
  return { ...seat, decision: "unseated", reason: "cli-call-failed" };
}

// What the seat sets that a requirements file may allow, and keys that hold no seat guard. codex
// holds /etc/codex/requirements.toml over -c, --disable and -s and runs the required value
// instead (0.144.5 under a fake /etc: a pinned features.shell_tool brings exec_command back under
// --disable shell_tool, a disallowed approval policy falls back with a warning, a sandbox list
// without read-only stops every run). Any other key could do the same to a guard.
const SEAT_ALLOWS = { allowed_sandbox_modes: "read-only", allowed_approval_policies: "never", allowed_web_search_modes: "disabled" };
const GUARD_FREE = ["enforce_residency"];

// The unseated seat when the requirements file could undo a seat guard; null otherwise.
function requirementsBlockedSeat(seat, world, notes) {
  if (world.platform === "win32") return null;
  const text = world.readFile(CODEX_REQUIREMENTS);
  if (text === null || text === undefined) return null;
  const read = readToml(text);
  const allows = (k) => SEAT_ALLOWS[k] !== undefined && (read.arrays[k] ?? []).includes(SEAT_ALLOWS[k]);
  const keys = read.roots.filter((k) => !GUARD_FREE.includes(k) && !allows(k));
  if (!keys.length && !read.broken) return null;
  notes.push(`${CODEX_REQUIREMENTS} ${keys.length ? `sets ${keys.join(", ")}` : "could not be read to its end"}, which codex holds over the seat's -c, --disable and -s flags: the seat cannot hold its guards`);
  return { ...seat, decision: "unseated", reason: "cli-call-failed" };
}

function codexSeatBase(world, runtime) {
  const present = Boolean(world.which("codex"));
  if (runtime === "codex") return { cli: "codex", present, decision: "unseated", reason: "self-runtime" };
  if (!runtime) return { cli: "codex", present, decision: "unseated", reason: "runtime-unknown" };
  if (!present) return absent("codex");
  return null;
}

// True when `version` (its first x.y.z) is at least `floor`.
function atLeast(version, floor) {
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!v) return false;
  for (let i = 0; i < 3; i += 1) {
    const d = Number(v[i + 1]) - floor[i];
    if (d !== 0) return d > 0;
  }
  return true;
}

// codex 0.144.5 refuses every run while config.toml keeps a top-level `profile` key.
const LEGACY_PROFILE_REFUSED_FROM = [0, 144, 5];

// The adopt-or-ask call for codex once its catalog's top model and the configuration are known.
// `ownModel`: config.toml sets a top-level model, whether or not it may be used. `cliDefault`:
// what running without a model flag may stand for, null when the config names any model.
function codexDecision(seat, { top, configured, ownModel, cliDefault, customProvider, unsure }) {
  if (unsure) return ask(seat, [top, configured], configured, "config-not-understood");
  if (!top) return ask(seat, [configured], configured ?? cliDefault, "no-catalog");
  if (configured === top) return adopt(seat, top, "catalog-top-is-configured");
  if (!ownModel && !customProvider) return adopt(seat, top, "catalog-top");
  if (!ownModel) return ask(seat, [top], cliDefault, "custom-provider");
  return ask(seat, [top, configured], configured, "top-differs-from-configured");
}

// A configured model a seat may run: not the author's family (noted when it is).
function vetConfigured(raw, authorFamilies, notes) {
  if (!raw) return null;
  if (!isAuthorFamily(raw, authorFamilies)) return raw;
  notes.push(`the configured model is of the author's family (${raw}): it is neither offered nor run as a fallback`);
  return null;
}

// What codex's config says about a seat run, for codexDecision.
function codexRunFacts({ cfg, modelKeys }) {
  return {
    ownModel: Boolean(cfg.model),
    // A model key in any table (a profile, say) may be what codex runs without -m.
    cliDefault: modelKeys ? null : CLI_DEFAULT,
    customProvider: Boolean(cfg.model_provider && cfg.model_provider !== "openai"),
    unsure: Boolean(cfg.profile),
  };
}

// The unseated seat when this codex refuses the config's legacy `profile` key; null otherwise.
function legacyProfileSeat(seat, cfg, notes) {
  if (!cfg.profile || !atLeast(seat.version, LEGACY_PROFILE_REFUSED_FROM)) return null;
  notes.push("config.toml has a top-level `profile` key, which this codex refuses for every run; move it to `--profile <name>` with <name>.config.toml");
  return { ...seat, decision: "unseated", reason: "cli-call-failed" };
}

function codexSeat(flag, { world, runtime, authorFamilies }) {
  const early = codexSeatBase(world, runtime);
  if (early) return early;
  const notes = [];
  const conf = codexConfig(world);
  const configured = vetConfigured(safeOnly([conf.cfg.model], "config.toml", notes)[0], authorFamilies, notes);
  const catalog = readCatalog(world.run("codex", ["debug", "models", "--bundled"]), notes) ?? [];
  const sorted = sortModels([...catalog, configured], authorFamilies);
  const version = firstLine(world.run("codex", ["--version"]));
  const seat = { cli: "codex", present: true, version, configured, candidates: sorted.independent, unclassified: sorted.unclassified, mcpServers: conf.mcpServers };
  const refused = legacyProfileSeat(seat, conf.cfg, notes) ?? managedBlockedSeat(seat, world, notes)
    ?? requirementsBlockedSeat(seat, world, notes) ?? mcpBlockedSeat(seat, conf, notes);
  if (refused) return withNotes(refused, notes);
  const top = sortModels(catalog, authorFamilies).independent[0] ?? null;
  const decided = flagged(seat, flag, authorFamilies) ?? codexDecision(seat, { top, configured, ...codexRunFacts(conf) });
  return withNotes(decided, notes);
}

function geminiSystemSettings(world) {
  if (world.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return world.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (world.platform === "darwin") return "/Library/Application Support/GeminiCli/settings.json";
  if (world.platform === "win32") return "C:\\ProgramData\\gemini-cli\\settings.json";
  return "/etc/gemini-cli/settings.json";
}

// gemini's system-defaults layer: $GEMINI_CLI_SYSTEM_DEFAULTS_PATH, or system-defaults.json beside
// the system settings (0.62.0).
const geminiSystemDefaults = (world) => world.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
  || join(dirname(geminiSystemSettings(world)), "system-defaults.json");

// gemini's system, user and system-defaults settings, in the order gemini lets them override
// (system over user over system-defaults); the user's sit under $GEMINI_CLI_HOME when it is set.
// Workspace settings are not read: the seat runs in the payload folder, where the
// repository's do not apply.
const geminiSettings = (world) => [geminiSystemSettings(world), join(world.env.GEMINI_CLI_HOME || world.home, ".gemini", "settings.json"),
  geminiSystemDefaults(world)]
  .map((file) => ({ file, ...readJsonc(world.readFile(file)) }));

// gemini's configured model and which settings files could not be read: $GEMINI_MODEL first,
// then the settings.
function geminiConfigured(world, settings, notes) {
  const unreadable = [];
  const pick = (name, where) => safeOnly([name], where, notes)[0] ?? null;
  if (world.env.GEMINI_MODEL) return { configured: pick(world.env.GEMINI_MODEL, "$GEMINI_MODEL"), unreadable };
  for (const read of settings) {
    if (read.unreadable) unreadable.push(read.file);
    const model = read.value?.model;
    const name = typeof model === "string" ? model : model?.name;
    if (name) return { configured: pick(name, read.file), unreadable };
  }
  return { configured: null, unreadable };
}

function geminiPoliciesDir(world) {
  if (world.platform === "darwin") return "/Library/Application Support/GeminiCli/policies";
  if (world.platform === "win32") return "C:\\ProgramData\\gemini-cli\\policies";
  return "/etc/gemini-cli/policies";
}

// gemini ignores --admin-policy while its system policy folder holds a policy (0.62.0), and the
// seat's read-only tools rest on that flag: such a seat is not seated.
function geminiPolicySeat(seat, world, notes) {
  const dir = geminiPoliciesDir(world);
  if (!world.listDir(dir).some((f) => f.endsWith(".toml"))) return null;
  notes.push(`gemini ignores --admin-policy while ${dir} holds policies: the seat cannot be held to its read-only tools`);
  return { ...seat, decision: "unseated", reason: "cli-call-failed" };
}

// gemini adds the settings' context.includeDirectories to the seat's workspace and lists them in
// its first request, and in IDE mode (ide.enabled) it adds the IDE's open files and selection
// (0.62.0): the seat would no longer keep to its payload folder.
function geminiWorkspaceSeat(seat, settings, notes) {
  const widened = settings.some((r) => (r.value?.context?.includeDirectories ?? []).length > 0);
  const ide = settings.map((r) => r.value?.ide?.enabled).find((v) => v !== undefined) === true;
  if (!widened && !ide) return null;
  if (widened) notes.push("the gemini settings add folders to the workspace (context.includeDirectories), whose listing would go with the payload: take them out for this run");
  if (ide) notes.push("the gemini settings turn on IDE mode (ide.enabled), which adds the IDE's open files to the request: turn it off for this run");
  return { ...seat, decision: "unseated", reason: "cli-call-failed" };
}

// gemini sends usage statistics (model, session and tool metadata, not the payload) to
// play.googleapis.com unless the settings turn them off; no flag does.
function geminiStatsNotes(settings) {
  const set = settings.map((r) => r.value?.privacy?.usageStatisticsEnabled).find((v) => v !== undefined);
  return set === false ? [] : ["gemini sends usage statistics (metadata, not the payload) to play.googleapis.com; set privacy.usageStatisticsEnabled to false in its settings to stop it"];
}

// gemini's own sandbox (tools.sandbox, or GEMINI_SANDBOX, which wins) restarts gemini inside it: a
// docker or podman container, or sandbox-exec on macOS when the value is true. The admin policy
// file does not reach a container, so every tool opens (0.62.0). The seat command turns it off
// with GEMINI_SANDBOX=false; this says so when it is on. gemini reads "0" and "false" as off, the
// env lower-cased and trimmed, the setting as written ("FALSE" there is on).
function geminiSandboxNotes(settings, env) {
  const off = (v) => v === "0" || v === "false";
  const fromEnv = String(env.GEMINI_SANDBOX ?? "").trim().toLowerCase();
  const set = settings.map((r) => r.value?.tools?.sandbox).find((v) => v !== undefined);
  const on = fromEnv ? !off(fromEnv) : Boolean(set && !off(set) && (typeof set !== "object" || set.enabled));
  return on ? ["gemini's own sandbox is on (tools.sandbox or GEMINI_SANDBOX): the seat command turns it off with GEMINI_SANDBOX=false, as the admin policy does not reach its container"] : [];
}

// gemini runs the hooks its settings define in every session, this seat too; no flag turns them off.
function geminiHookNotes(settings) {
  const off = settings.some((r) => r.value?.hooksConfig?.enabled === false);
  const hooks = settings.some((r) => Object.keys(r.value?.hooks ?? {}).length > 0);
  return hooks && !off ? ["the gemini settings define hooks, which run in this seat too: no flag turns them off"] : [];
}

// gemini has no catalog to rank; its `pro` alias resolves to the strongest Pro model the
// account may use, while `auto` routes each request to Pro or Flash.
function geminiSeat(flag, { world, authorFamilies }) {
  if (!world.which("gemini")) return absent("gemini");
  const notes = [];
  const settings = geminiSettings(world);
  const { configured: raw, unreadable } = geminiConfigured(world, settings, notes);
  const configured = vetConfigured(raw, authorFamilies, notes);
  const sorted = sortModels(["pro", configured], authorFamilies);
  const seat = { cli: "gemini", present: true, configured, candidates: sorted.independent, unclassified: sorted.unclassified };
  notes.push(...unreadable.map((f) => `settings not readable: ${f}`), ...geminiHookNotes(settings), ...geminiStatsNotes(settings),
    ...geminiSandboxNotes(settings, world.env));
  const blocked = geminiPolicySeat(seat, world, notes) ?? geminiWorkspaceSeat(seat, settings, notes);
  if (blocked) return withNotes(blocked, notes);
  const out = flagged(seat, flag, authorFamilies) ?? geminiDecision(seat, configured, unreadable.length > 0);
  return withNotes(out, notes);
}

function geminiDecision(seat, configured, unsure) {
  if (unsure) return ask(seat, ["pro", configured], configured, "config-not-understood");
  if (!configured || configured === "pro") return adopt(seat, "pro", "cli-pro-alias");
  return ask(seat, ["pro", configured], configured, "configured-vs-pro");
}

function managedOpencodeDir(world) {
  if (world.platform === "darwin") return "/Library/Application Support/opencode";
  if (world.platform === "win32") return join(world.env.ProgramData || "C:\\ProgramData", "opencode");
  return "/etc/opencode";
}

// opencode's config sources the seat will run with, lowest precedence first (opencode 1.3.10).
// $OPENCODE_CONFIG_CONTENT is not one of them: the seat command sets it to its reviewer agent.
function opencodeSources(world) {
  const env = world.env;
  const dirFiles = (dir) => (dir ? [join(dir, "opencode.jsonc"), join(dir, "opencode.json")] : []);
  const global = join(env.XDG_CONFIG_HOME || join(world.home, ".config"), "opencode");
  return [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((f) => join(global, f)),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...dirFiles(join(world.home, ".opencode")),
    ...dirFiles(env.OPENCODE_CONFIG_DIR),
    ...dirFiles(managedOpencodeDir(world)),
  ];
}

// One opencode config source merged into `merged` as opencode merges them: the last `model`
// and provider lists win, provider models add up.
function mergeOpencode(merged, cfg) {
  if (typeof cfg.model === "string" && cfg.model) merged.model = cfg.model;
  if (Array.isArray(cfg.enabled_providers)) merged.enabled = cfg.enabled_providers;
  if (Array.isArray(cfg.disabled_providers)) merged.disabled = cfg.disabled_providers;
  for (const [name, def] of Object.entries(cfg.provider ?? {})) {
    merged.provider[name] = [...new Set([...(merged.provider[name] ?? []), ...Object.keys(def?.models ?? {})])];
  }
}

function opencodeConfig(world) {
  const merged = { model: null, provider: {}, enabled: null, disabled: null, unreadable: [] };
  for (const file of opencodeSources(world)) {
    const read = readJsonc(world.readFile(file));
    if (read.unreadable) merged.unreadable.push(file);
    mergeOpencode(merged, read.value ?? {});
  }
  return merged;
}

// opencode's `provider/model` names: the configured one first, then each usable provider's.
function opencodeModels(cfg) {
  const usable = (p) => (!cfg.enabled || cfg.enabled.includes(p)) && !(cfg.disabled ?? []).includes(p);
  const listed = Object.entries(cfg.provider).filter(([p]) => usable(p)).flatMap(([p, ms]) => ms.map((m) => `${p}/${m}`));
  const own = cfg.model && usable(String(cfg.model).split("/")[0]) ? cfg.model : null;
  return { configured: own, models: [own, ...listed] };
}

// The providers opencode's local copy of the models.dev list knows; null when it cannot be read.
function catalogProviders(world) {
  const file = join(world.env.XDG_CACHE_HOME || join(world.home, ".cache"), "opencode", "models.json");
  const read = readJsonc(world.readFile(file));
  return read.value ? new Set(Object.keys(read.value)) : null;
}

// The models the config lists are all opencode can run only when enabled_providers names
// nothing but providers that list their models here and that models.dev (`catalog`) does not know.
function closedSet(cfg, catalog) {
  if (!cfg.enabled?.length) return false;
  return Boolean(catalog) && cfg.enabled.every((p) => cfg.provider[p]?.length > 0 && !catalog.has(p));
}

// opencode has no ranking: it adopts only when the configured model is the one model it can run.
// With one known model it asks: `no-catalog` when the models.dev copy could not be read,
// `open-model-set` when it was and opencode may still run models beyond the one known.
function opencodeDecision(seat, { configured, unsure, closed, catalog }) {
  const known = seat.candidates;
  if (unsure) return ask(seat, known, configured, "config-not-understood");
  if (known.length === 0) return ask(seat, [], null, "no-candidate", seat.unclassified.length ? "no-default-model" : "no-independent-model");
  if (known.length > 1) return ask(seat, known, configured, "several-candidates");
  if (closed && known[0] === configured) return adopt(seat, configured, "single-candidate");
  return ask(seat, known, configured, catalog ? "open-model-set" : "no-catalog");
}

function opencodeSeat(flag, { world, authorFamilies }) {
  if (!world.which("opencode")) return absent("opencode");
  const notes = [];
  const cfg = opencodeConfig(world);
  const { configured: raw, models } = opencodeModels(cfg);
  const usable = safeOnly(models, "opencode config", notes);
  const configured = vetConfigured(usable.includes(raw) ? raw : null, authorFamilies, notes);
  const sorted = sortModels(usable, authorFamilies);
  const seat = { cli: "opencode", present: true, configured, candidates: sorted.independent, unclassified: sorted.unclassified };
  notes.push(...cfg.unreadable.map((f) => `config not readable: ${f}`));
  if (world.env.OPENCODE_CONFIG_CONTENT) notes.push("$OPENCODE_CONFIG_CONTENT is not read: the seat command replaces it with its own reviewer agent");
  const catalog = catalogProviders(world);
  const closed = closedSet(cfg, catalog);
  const out = flagged(seat, flag, authorFamilies) ?? opencodeDecision(seat, { configured, unsure: cfg.unreadable.length > 0, closed, catalog });
  return withNotes(out, notes);
}

const SEATS = { codex: codexSeat, gemini: geminiSeat, opencode: opencodeSeat };

// Two adopted seats on one model, provider prefix aside: one model axis, not two.
function sameModelNotes(seats) {
  const bare = (m) => String(m).toLowerCase().split("/").pop();
  const adopted = seats.filter((s) => s.decision === "adopt");
  const notes = [];
  for (let i = 0; i < adopted.length; i += 1) {
    for (let j = i + 1; j < adopted.length; j += 1) {
      if (bare(adopted[i].model) === bare(adopted[j].model)) notes.push(`same model on two seats: ${adopted[i].cli} and ${adopted[j].cli} (${adopted[i].model})`);
    }
  }
  return notes;
}

// The author's families. A Codex author also runs the family its config.toml names (a local
// model through a custom provider, say), so a seat on that family would be the author again.
function authorFamiliesFor(rt, world, notes) {
  const base = AUTHOR_FAMILIES[rt] ?? UNKNOWN_AUTHOR;
  if (rt !== "codex") return base;
  const model = codexConfig(world).cfg.model;
  const family = model ? familyOf(model) : null;
  if (model && !family) notes.push("the Codex session's configured model has no known family: a seat running that model is not recognised as the author's");
  return family && !base.includes(family) ? [...base, family] : base;
}

const knownRuntime = (runtime) => (runtime === "claude" || runtime === "codex" ? runtime : null);
const unknownRuntimeNote = (runtime) => `runtime unknown${runtime ? ` (got "${runtime}")` : ""}: `
  + "claude and gpt are both left out and codex is not seated; pass --runtime=claude|codex";

// The seat for one requested CLI; a flag value that is not a safe model name is dropped first.
function seatFor(name, value, ctx, notes) {
  const flag = safeOnly([value], `--${name}`, notes)[0] ?? null;
  return SEATS[name](flag, ctx);
}

export function probe({ requested, runtime, unknown = [], world = realWorld() }) {
  const rt = knownRuntime(runtime);
  const notes = [];
  const authorFamilies = authorFamiliesFor(rt, world, notes);
  const out = { runtime: rt ?? "unknown", authorFamilies, seats: [], notes };
  if (!rt) notes.push(unknownRuntimeNote(runtime));
  if (unknown.length) notes.push(`arguments not understood: ${unknown.join(" ")}`);
  const names = SEAT_NAMES.filter((n) => n in requested);
  if (names.length === 0) return { ...out, reason: "no-flag" };
  for (const name of names) out.seats.push(seatFor(name, requested[name], { world, runtime: rt, authorFamilies }, notes));
  notes.push(...sameModelNotes(out.seats));
  return out;
}

// The executable `name` resolves to on PATH, only from absolute PATH entries (never the current
// folder, which cmd.exe would search first). Windows tries its executable extensions first.
function onPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      try {
        const file = join(dir, name + ext);
        if (statSync(file).isFile()) return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

function realWorld() {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    which: onPath,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    run: (cmd, args, env = {}) => {
      const exe = onPath(cmd);
      if (!exe) return { status: 127, stdout: "" };
      // Windows runs .cmd and .bat shims through cmd.exe; the path is quoted and the arguments are fixed words.
      const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
      const r = spawnSync(viaCmd ? `"${exe}"` : exe, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 64 * 1024 * 1024,
        shell: viaCmd,
        env: { ...process.env, ...env },
      });
      return { status: r.status, stdout: r.stdout ?? "" };
    },
  };
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  const { requested, runtime, unknown } = parseArgs(process.argv.slice(2));
  const rt = resolveRuntime(runtime, process.env);
  process.stdout.write(JSON.stringify(probe({ requested, runtime: rt, unknown }), null, 2) + "\n");
}
