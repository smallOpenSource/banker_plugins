#!/usr/bin/env node
/**
 * claude-update-last: puts OMC's Claude Code update notice at the end of the statusline.
 *
 *   node claude-update-last.mjs on       add the block to the OMC custom HUD wrapper
 *   node claude-update-last.mjs off      take it out again
 *   node claude-update-last.mjs status   say whether it is on
 *
 * When a newer Claude Code is out, OMC's HUD prints "[Claude#<running>] -> <latest>
 * claude update" on its main line. The omc_hud wrapper lays that line out again in
 * a fixed order: the older wrapper drops segments it does not know, so the notice
 * never shows, and the current one shows them dimmed before the path, mid-line.
 * The block runs right before the wrapper joins its segments, takes the notice out
 * of wherever it landed and adds it, dimmed, after every other segment. OMC's own
 * hint on the line below ("[!] claude <latest> - paste: ! claude update") is left
 * as the wrapper shows it.
 *
 * The wrapper is <config>/hud/omc-hud-custom.mjs, where <config> is
 * $CLAUDE_CONFIG_DIR or ~/.claude; $CLAUDE_UPDATE_LAST_HUD_FILE overrides the path.
 * Blocks other tools add with their own markers (payload-mon's, say) are left alone.
 *
 * `on` converges on the current block and is a no-op when it is in place. Both
 * commands refuse markers that do not pair up, keep the text from before each
 * change in <wrapper>.claude-update-last.bak, and write nothing that fails
 * `node --check`. Exit status 1 means nothing was changed; 2 means an unexpected
 * error stopped the command partway, so check `status`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OPEN = "// >>> claude-update-last >>>";
const CLOSE = "// <<< claude-update-last <<<";
// A block's body never crosses another opening marker, so a stray one above a
// block is left over (and refused) instead of taking the code between with it.
const BLOCKS =
  /^[ \t]*\/\/ >>> claude-update-last >>>(?:(?!\/\/ >>> claude-update-last >>>)[\s\S])*?\/\/ <<< claude-update-last <<<[ \t]*(?:\r?\n|(?![\s\S]))/gm;
// The block goes right before the line that joins the segments into the statusline.
const JOIN_LINE = /^ {2}let result = colored\.join\(SEP\);\r?$/gm;
// What the block reads at that line, all in the wrapper's own scope there.
const NAMES = [/\bconst segs\b/, /\bconst colored\b/, /\bconst stripAnsi\b/, /\bconst A = /];

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

const DEFAULTS = {
  hudFile: process.env.CLAUDE_UPDATE_LAST_HUD_FILE || join(CONFIG_DIR, "hud", "omc-hud-custom.mjs"),
};

// OMC 5.6.1 renders the notice as `[Claude${tag}] -> ${latest} claude update`, the
// tag being "#<running version>" or empty. The block's names are block-scoped, so
// none can clash with the wrapper's own.
const BLOCK = [
  OPEN,
  "// claude-update-last (setup-omc-hud): OMC's Claude Code update notice",
  '// ("[Claude#X] -> Y claude update") goes after every other segment.',
  "// `claude-update-last off` removes this block; on any error the order stays as it was.",
  "try {",
  String.raw`  const notice = /^\[Claude(?:#[^\]]*)?\]\s*->\s*\S+\s+claude\s+update\b/;`,
  "  const plain = (s) => stripAnsi(String(s)).trim();",
  "  const found = segs.find((s) => notice.test(plain(s)));",
  "  if (found) {",
  '    const moved = A("2", plain(found));',
  "    for (let i = colored.length - 1; i >= 0; i--) if (notice.test(plain(colored[i]))) colored.splice(i, 1);",
  "    colored.push(moved);",
  "  }",
  "} catch {",
  "  /* keep the order the wrapper chose */",
  "}",
  CLOSE,
];

// The block as `on` writes it, in the line endings of the line it goes before.
const blockText = (eol) => BLOCK.map((line) => "  " + line).join(eol) + eol;

const count = (text, needle) => text.split(needle).length - 1;
// Markers that do not pair up, in number or in order: removing the blocks leaves one behind.
const unpaired = (src) => {
  const rest = src.replace(BLOCKS, "");
  return rest.includes(OPEN) || rest.includes(CLOSE);
};
const PAIR = "claude-update-last 표시(>>> / <<<)의 짝이 맞지 않습니다(개수나 순서)";

// Every line that joins the segments, as [offset, line ending].
const joinLines = (src) => [...src.matchAll(JOIN_LINE)].map((m) => [m.index, m[0].endsWith("\r") ? "\r\n" : "\n"]);

// The wrapper's text, null when there is no such file. Any other read failure
// (permissions, say) is not "missing" and propagates.
const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
};

const refusal = (why, hudFile) => ({ ok: false, message: `${why}. 래퍼를 그대로 두었습니다: ${hudFile}` });

// The block exactly as `on` writes it, once, right before the one joining line.
function inPlace(src) {
  if (count(src, OPEN) !== 1 || count(src, CLOSE) !== 1) return false;
  const lines = joinLines(src);
  if (lines.length !== 1) return false;
  const [at, eol] = lines[0];
  const block = blockText(eol);
  return src.slice(at - block.length, at) === block;
}

// Why the block cannot go into this wrapper, or "" when it can. Markers that do
// not pair up would let the block pattern swallow the code between them.
function misfit(src) {
  if (unpaired(src)) return PAIR;
  const base = src.replace(BLOCKS, "");
  if (!base.includes("omc-hud.mjs")) return "OMC 커스텀 HUD 래퍼가 아닙니다";
  const places = joinLines(base).length;
  if (places === 0) return "삽입 위치를 찾지 못했습니다(세그먼트를 합치는 colored.join(SEP) 줄이 없음)";
  if (places > 1) return "삽입 위치가 두 곳 이상입니다(colored.join(SEP) 줄이 여러 개)";
  if (!NAMES.every((name) => name.test(base))) return "블록이 쓰는 이름(segs, colored, stripAnsi, A)을 래퍼에서 찾지 못했습니다";
  return "";
}

function insertBlock(base) {
  const [[at, eol]] = joinLines(base);
  return base.slice(0, at) + blockText(eol) + base.slice(at);
}

// Replaces file through a fresh temp file ("wx") and a rename: a link planted at
// either name is replaced rather than written through, and a write that fails
// leaves the old file as it was.
function writeFresh(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// The first lines of node's complaint about `text` as an ES module, "" if it parses.
function syntaxError(text) {
  const dir = mkdtempSync(join(tmpdir(), "claude-update-last-"));
  try {
    const file = join(dir, "check.mjs");
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return r.status === 0 ? "" : String(r.stderr || r.error).trim().split("\n").slice(0, 3).join(" | ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Writes `after` over the wrapper if it parses, keeping `before` in the .bak.
function commit(hudFile, before, after, done) {
  const err = syntaxError(after);
  if (err) return { ok: false, message: `node --check 실패로 래퍼를 그대로 두었습니다: ${err}` };
  try {
    accessSync(hudFile, constants.W_OK);
  } catch (e) {
    return refusal(`래퍼에 쓸 권한이 없습니다(${e.code || e.message})`, hudFile);
  }
  writeFresh(`${hudFile}.claude-update-last.bak`, before);
  writeFileSync(hudFile, after);
  return { ok: true, message: done };
}

export function turnOn(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const src = readText(o.hudFile);
  if (src === null) return { ok: false, message: `HUD 래퍼가 없습니다: ${o.hudFile}` };
  if (inPlace(src)) return { ok: true, message: "이미 켜져 있습니다 (변경 없음)." };
  const why = misfit(src);
  if (why) return refusal(why, o.hudFile);
  const done = "켰습니다. 다음 statusline 갱신부터 Claude Code 갱신 안내가 줄 맨 끝에 표시됩니다.";
  return commit(o.hudFile, src, insertBlock(src.replace(BLOCKS, "")), done);
}

export function turnOff(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const src = readText(o.hudFile);
  if (src === null) return { ok: true, message: `HUD 래퍼가 없어 끌 것이 없습니다: ${o.hudFile}` };
  if (unpaired(src)) return refusal(PAIR, o.hudFile);
  const out = src.replace(BLOCKS, "");
  if (out === src) return { ok: true, message: "이미 꺼져 있습니다 (래퍼 변경 없음)." };
  return commit(o.hudFile, src, out, "껐습니다. 다음 statusline 갱신부터 원래 순서로 표시됩니다.");
}

function stateOf(src) {
  if (src === null) return "HUD 래퍼 없음";
  if (count(src, OPEN) + count(src, CLOSE) === 0) return "꺼짐";
  // on and off both refuse this, so pointing at on would be a dead end.
  if (unpaired(src)) return "표시(>>> / <<<)의 짝이 맞지 않습니다 (on, off 모두 거부: HUD 재설치 또는 남은 표시 줄 정리)";
  return inPlace(src) ? "켜짐" : "켜짐이 불완전하거나 오래됨 (on 으로 복구)";
}

// What status says about the wrapper. A wrapper it cannot read is reported, not
// thrown: status is where an exit 2 sends the user to look.
function describe(o) {
  try {
    return stateOf(readText(o.hudFile));
  } catch (e) {
    return `HUD 래퍼를 읽을 수 없음 (${e.code || e.message})`;
  }
}

export function status(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return { ok: true, message: `claude-update-last: ${describe(o)} (${o.hudFile})` };
}

const COMMANDS = new Map([
  ["on", turnOn],
  ["off", turnOff],
  ["status", status],
]);

function main(arg) {
  const run = COMMANDS.get(arg);
  if (!run) {
    process.stdout.write("사용법: claude-update-last on | off | status\n");
    return 1;
  }
  try {
    const { ok, message } = run();
    process.stdout.write(message + "\n");
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

if (invokedDirectly()) process.exitCode = main((process.argv[2] || "status").toLowerCase());
