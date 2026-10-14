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
 * are the same. Where they go, and how they come out again byte for byte, is
 * instruction-toggle.mjs beside this file, shared with anti-drm: a rules file
 * under Claude Code's <config>/rules/, and one marked block in the instructions
 * file Codex reads.
 *
 * `off` never needs the rules, so it works even when SKILL.md cannot be read.
 * Exit status 0 means done or already so; 1 means refused or a usage error, with
 * nothing changed; 2 means an unexpected error stopped the command partway, so
 * check `status`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEEP_CLOSE,
  KEEP_OPEN,
  RUNTIMES,
  blockSpansOf,
  stateLines,
  toggleSpec,
  turnOff as toggleOff,
  turnOn as toggleOn,
} from "./instruction-toggle.mjs";

const RULES_START = "<!-- tone-compact:rules:start -->";
const RULES_END = "<!-- tone-compact:rules:end -->";
const TOGGLE = toggleSpec({
  slug: "tone-compact",
  staleText: "켜짐, 단 규칙이 이 버전과 다름 (on 으로 갱신)",
  updatedText: "규칙을 이 버전으로 바꿨습니다",
});
const MARKERS = [TOGGLE.open, TOGGLE.close, KEEP_OPEN, KEEP_CLOSE, RULES_START, RULES_END];

const DEFAULTS = {
  claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  codexDir: process.env.CODEX_HOME || join(homedir(), ".codex"),
  skillFile: fileURLToPath(new URL("../SKILL.md", import.meta.url)),
};

const count = (text, needle) => text.split(needle).length - 1;
const lf = (text) => text.replace(/\r\n/g, "\n");

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

/** Where the tone-compact blocks sit in text, or null when the markers do not pair up. */
export const blockSpans = (text) => blockSpansOf(text, TOGGLE.open, TOGGLE.close);

export function status(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lines = ["tone-compact 상태"];
  let rules;
  try {
    rules = loadRules(o);
  } catch (e) {
    lines.push(`- 규칙 원문을 읽지 못해 버전은 비교하지 않음 (${e.code || e.message})`);
  }
  lines.push(...stateLines(TOGGLE, o, rules));
  return { ok: true, message: lines.join("\n") };
}

export const turnOn = (runtime, opts = {}) => {
  const o = { ...DEFAULTS, ...opts };
  return toggleOn(TOGGLE, runtime, o, () => loadRules(o));
};
export const turnOff = (runtime, opts = {}) => toggleOff(TOGGLE, runtime, { ...DEFAULTS, ...opts });

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

// Why the command line cannot run as given, or "" when it can.
function usageError(command, flag, extra) {
  if (extra.length > 0 || !["on", "off", "status"].includes(command)) return USAGE;
  return flag !== null && !RUNTIMES.includes(flag) ? USAGE : "";
}

function main(argv, env = process.env) {
  const { command, runtime: flag, extra } = parseArgs(argv);
  const why = usageError(command, flag, extra);
  if (why) {
    process.stdout.write(`${why}\n`);
    return 1;
  }
  const runtime = runtimeOf(flag, env);
  if (command !== "status" && !RUNTIMES.includes(runtime)) {
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
