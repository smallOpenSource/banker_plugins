#!/usr/bin/env node
/**
 * payload-mon: turns the statusline payload segment on or off.
 *
 *   node payload-mon.mjs on       add the payload-mon block to the OMC HUD wrapper
 *   node payload-mon.mjs off      take it out again, with the module copy and the cache
 *   node payload-mon.mjs status   say whether it is on, with this session's estimate
 *
 * The wrapper (<config>/hud/omc-hud-custom.mjs, where <config> is
 * $CLAUDE_CONFIG_DIR or ~/.claude; $PAYLOAD_MON_HUD_FILE overrides the path)
 * gets one marker-delimited block right after the line that adds ctx, which
 * works out the segment and places it there. Blocks other tools add to the same
 * wrapper with their own markers are left alone.
 *
 * Two wrapper layouts take the block. The older one reads stdin into `let input`
 * and runs the OMC HUD through spawnSync; the current omc_hud one reads it into
 * `const input`, runs the HUD in-process and keeps spawnSync for a fallback
 * branch. A block anchored on spawnSync would land in that branch, so the ctx
 * line is the only anchor. Earlier versions that also put a block before
 * spawnSync are converted on the next `on`.
 *
 * The block imports a copy of payload-size.mjs kept beside the wrapper
 * (<hud>/payload-mon/payload-size.mjs), not the module in this folder: a plugin
 * install lives under a versioned path that the next update retires, and an
 * import pointing there would go dark without a word. `on` writes the copy and
 * refreshes it when this version's module differs; `status` says when it does.
 *
 * `on` converges on the current block and is a no-op when it is in place. It
 * writes only into the OMC custom HUD (signature-gated); `off` removes only
 * payload-mon's own marker blocks. Both refuse markers that do not pair up, keep
 * the text from before each change in <wrapper>.payload-mon.bak, and write
 * nothing that fails `node --check`.
 * Exit status 1 means nothing was changed; 2 means an unexpected error stopped
 * the command partway, so check `status`.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CACHE_DIR, clearCache, estimatePayloadBytes, REQUEST_LIMIT_BYTES, SHOW_FROM_BYTES } from "./payload-size.mjs";

const OPEN = "// >>> payload-mon >>>";
const CLOSE = "// <<< payload-mon <<<";
const BLOCKS = /^[ \t]*\/\/ >>> payload-mon >>>[\s\S]*?\/\/ <<< payload-mon <<<[ \t]*\r?\n/gm;
// The block goes right after the line that adds ctx.
const CTX_LINE = /^ {2}if \(f\.ctx\) colored\.push\(colorCtx\(f\.ctx\)\);\r?\n/m;
// The statusline JSON the block reads, in either layout.
const INPUT_DECL = /^(?:let|const) input\b/m;
const MB = 1024 * 1024;

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

const DEFAULTS = {
  hudFile: process.env.PAYLOAD_MON_HUD_FILE || join(CONFIG_DIR, "hud", "omc-hud-custom.mjs"),
  moduleSource: fileURLToPath(new URL("./payload-size.mjs", import.meta.url)),
  cacheDir: CACHE_DIR,
  settingsFile: join(CONFIG_DIR, "settings.json"),
  projectsDir: join(CONFIG_DIR, "projects"),
  sessionId: process.env.CLAUDE_CODE_SESSION_ID,
};

// Where the block's module lives: beside the wrapper, outside any versioned path.
const moduleCopy = (hudFile) => join(dirname(hudFile), "payload-mon", "payload-size.mjs");
const moduleUrl = (hudFile) => pathToFileURL(moduleCopy(hudFile)).href;

// Right after ctx, colored like the 5h/wk rates: % on the ctx scale, MB in cyan.
// Its names are block-scoped, so none can clash with the wrapper's own.
const placeBlock = (url) =>
  [
    "  " + OPEN,
    "  // payload-mon: estimated API request payload against the 32MB request limit, shown",
    "  // like ctx from 8MB (25%) on. `payload-mon off` removes this block; a missing or",
    "  // broken module costs only this segment, never the statusline.",
    "  try {",
    "    const transcript = JSON.parse(input)?.transcript_path;",
    "    if (transcript) {",
    `      const { estimatePayloadBytes, payloadSegment } = await import(${JSON.stringify(url)});`,
    "      const segment = payloadSegment(estimatePayloadBytes(transcript));",
    "      if (segment) colored.push(colorRate(segment));",
    "    }",
    "  } catch {",
    "    /* no stdin JSON, unreadable transcript or module error */",
    "  }",
    "  " + CLOSE,
    "",
  ].join("\n");

const insertBlock = (base, url) => base.replace(CTX_LINE, (line) => line + placeBlock(url));

const count = (text, needle) => text.split(needle).length - 1;

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

const readBytes = (file) => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};

const refusal = (why, hudFile) => ({ ok: false, message: `${why}. 래퍼를 그대로 두었습니다: ${hudFile}` });

// The block exactly as `on` writes it for this URL, once, right after the ctx line.
function inPlace(src, url) {
  if (count(src, OPEN) !== 1 || count(src, CLOSE) !== 1) return false;
  const ctx = CTX_LINE.exec(src);
  return ctx !== null && src.startsWith(placeBlock(url), ctx.index + ctx[0].length);
}

// Why the block cannot go into this wrapper, or "" when it can. Markers that do
// not pair up would let the block pattern swallow the code between them.
function misfit(src) {
  if (count(src, OPEN) !== count(src, CLOSE)) return "payload-mon 표시(>>> / <<<)의 짝이 맞지 않습니다";
  const base = src.replace(BLOCKS, "");
  if (!base.includes("omc-hud.mjs") || !base.includes("const colorRate")) return "OMC 커스텀 HUD 래퍼가 아닙니다";
  if (!INPUT_DECL.test(base)) return "삽입 위치를 찾지 못했습니다(statusline 입력을 담는 input 변수가 없음)";
  if (!CTX_LINE.test(base)) return "삽입 위치를 찾지 못했습니다(ctx를 넣는 줄이 없음)";
  return "";
}

// "current", "stale" (differs from this version's module) or "missing".
function copyState(o) {
  const copy = readBytes(moduleCopy(o.hudFile));
  if (copy === null) return "missing";
  const source = readBytes(o.moduleSource);
  return source !== null && copy.equals(source) ? "current" : "stale";
}

// Replaces file through a fresh temp file ("wx") and a rename: a link planted at
// either name is replaced rather than written through, and a write that fails
// leaves the old file as it was.
function writeFresh(file, data, mode) {
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

// Brings the copy up to this version's module; true when it had to write. The
// statusline imports it on every refresh, so no other account may change it
// (reading it is harmless). When the write fails, a folder made here is taken
// away again: mkdirSync names a folder only when it created it, and rmdir
// leaves one that something else has meanwhile put a file in.
function syncModule(o) {
  if (copyState(o) === "current") return false;
  const copy = moduleCopy(o.hudFile);
  const made = mkdirSync(dirname(copy), { recursive: true, mode: 0o755 }) !== undefined;
  try {
    writeFresh(copy, readFileSync(o.moduleSource), 0o644);
  } catch (e) {
    if (made) {
      try {
        rmdirSync(dirname(copy));
      } catch {
        /* no longer empty, so not only ours */
      }
    }
    throw e;
  }
  return true;
}

// The first lines of node's complaint about `text` as an ES module, "" if it parses.
function syntaxError(text) {
  const dir = mkdtempSync(join(tmpdir(), "payload-mon-"));
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
// `prepare` runs once the text is known to parse and the wrapper to be writable,
// before the wrapper is touched, so a failure there leaves the wrapper as it was.
function commit(hudFile, before, after, done, prepare = () => {}) {
  const err = syntaxError(after);
  if (err) return { ok: false, message: `node --check 실패로 래퍼를 그대로 두었습니다: ${err}` };
  try {
    accessSync(hudFile, constants.W_OK);
  } catch (e) {
    return refusal(`래퍼에 쓸 권한이 없습니다(${e.code || e.message})`, hudFile);
  }
  try {
    prepare();
  } catch (e) {
    return refusal(`모듈 사본을 쓰지 못했습니다(${e.code || e.message})`, hudFile);
  }
  writeFresh(`${hudFile}.payload-mon.bak`, before);
  writeFileSync(hudFile, after);
  return { ok: true, message: done };
}

// Whether settings.json runs this wrapper as the statusline.
function statusLineUses(settingsFile, hudFile) {
  try {
    const command = JSON.parse(readFileSync(settingsFile, "utf8"))?.statusLine?.command;
    return typeof command === "string" && command.includes(basename(hudFile));
  } catch {
    return false;
  }
}

const notShownNote = (o) =>
  statusLineUses(o.settingsFile, o.hudFile)
    ? ""
    : `\n주의: statusLine 명령에 ${basename(o.hudFile)}가 보이지 않습니다. ` +
      "다른 래퍼(smart-compact 등)가 HUD를 감싸 호출하면 정상 표시되고, 아니면 화면에 나타나지 않습니다.";

export function turnOn(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const src = readText(o.hudFile);
  if (src === null) return { ok: false, message: `HUD 래퍼가 없습니다: ${o.hudFile}` };
  if (inPlace(src, moduleUrl(o.hudFile))) {
    try {
      const refreshed = syncModule(o);
      return { ok: true, message: (refreshed ? "모듈 사본을 이 버전으로 맞췄습니다." : "이미 켜져 있습니다 (변경 없음).") + notShownNote(o) };
    } catch (e) {
      return { ok: false, message: `모듈 사본을 쓰지 못했습니다(${e.code || e.message}): ${moduleCopy(o.hudFile)}` };
    }
  }
  const why = misfit(src);
  if (why) return refusal(why, o.hudFile);
  const done = "켰습니다. 다음 statusline 갱신부터 8MB 이상이면 ctx 옆에 payload가 표시됩니다.";
  const after = insertBlock(src.replace(BLOCKS, ""), moduleUrl(o.hudFile));
  return commit(o.hudFile, src, after, done + notShownNote(o), () => syncModule(o));
}

function removeBlocks(o, src) {
  if (src === null) return { ok: true, message: `HUD 래퍼가 없어 끌 것이 없습니다: ${o.hudFile}` };
  if (count(src, OPEN) !== count(src, CLOSE)) return refusal("payload-mon 표시(>>> / <<<)의 짝이 맞지 않습니다", o.hudFile);
  const out = src.replace(BLOCKS, "");
  if (out === src) return { ok: true, message: "이미 꺼져 있습니다 (래퍼 변경 없음)." };
  return commit(o.hudFile, src, out, "껐습니다. 다음 statusline 갱신부터 payload가 표시되지 않습니다.");
}

// What off leaves behind otherwise: the cache (when this account controls its
// folder), and the module copy with its folder (only when nothing else is in
// it). Neither failing undoes off.
function removeLeftovers(o) {
  const copy = moduleCopy(o.hudFile);
  for (const remove of [() => clearCache(o.cacheDir), () => rmSync(copy, { force: true })]) {
    try {
      remove();
    } catch {
      /* stale numbers or an unused copy; off stands */
    }
  }
  try {
    rmdirSync(dirname(copy));
  } catch {
    /* absent, or holds something that is not ours */
  }
}

export function turnOff(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const res = removeBlocks(o, readText(o.hudFile));
  if (res.ok) removeLeftovers(o);
  return res;
}

// "현재 세션: 0.8MB / 32MB (2%), 8MB부터 표시" for the session that runs this, "" if unknown.
function sessionEstimate(o) {
  if (!o.sessionId || !existsSync(o.projectsDir)) return "";
  const file = `${o.sessionId}.jsonl`;
  const project = readdirSync(o.projectsDir).find((d) => existsSync(join(o.projectsDir, d, file)));
  if (!project) return "";
  try {
    const bytes = estimatePayloadBytes(join(o.projectsDir, project, file), o.cacheDir);
    const pct = Math.floor((bytes / REQUEST_LIMIT_BYTES) * 100);
    return `현재 세션: ${(bytes / MB).toFixed(1)}MB / 32MB (${pct}%), ${SHOW_FROM_BYTES / MB}MB부터 표시`;
  } catch {
    return "";
  }
}

const COPY_NOTE = {
  current: "",
  stale: ", 단 모듈 사본이 이 버전과 다름 (on 으로 갱신)",
  missing: ", 단 모듈 사본이 없어 표시되지 않음 (on 으로 복구)",
};

function stateOf(src, o) {
  if (src === null) return "HUD 래퍼 없음";
  if (count(src, OPEN) + count(src, CLOSE) === 0) return "꺼짐";
  // on and off both refuse this, so pointing at on would be a dead end.
  if (count(src, OPEN) !== count(src, CLOSE)) return "표시(>>> / <<<)의 짝이 맞지 않습니다 (on·off 모두 거부: HUD 재설치 또는 남은 표시 줄 정리)";
  if (!inPlace(src, moduleUrl(o.hudFile))) return "켜짐이 불완전하거나 오래됨 (on 으로 복구)";
  return "켜짐" + COPY_NOTE[copyState(o)];
}

// What status says about the wrapper. A wrapper it cannot read is reported, not
// thrown: status is where an exit 2 sends the user to look.
function describe(o) {
  try {
    return stateOf(readText(o.hudFile), o);
  } catch (e) {
    return `HUD 래퍼를 읽을 수 없음 (${e.code || e.message})`;
  }
}

export function status(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lines = [`payload-mon: ${describe(o)} (${o.hudFile})`];
  const note = notShownNote(o);
  if (note) lines.push(note.trim());
  const estimate = sessionEstimate(o);
  if (estimate) lines.push(estimate);
  return { ok: true, message: lines.join("\n") };
}

const COMMANDS = new Map([
  ["on", turnOn],
  ["off", turnOff],
  ["status", status],
]);

function main(arg) {
  const run = COMMANDS.get(arg);
  if (!run) {
    process.stdout.write("사용법: payload-mon on | off | status\n");
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
