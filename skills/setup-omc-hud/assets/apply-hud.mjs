#!/usr/bin/env node
/**
 * apply-hud.mjs — cross-platform installer for the custom OMC HUD statusline.
 *
 * Installs into ${CLAUDE_CONFIG_DIR:-~/.claude}:
 *   - hud/omc-hud.mjs        (OMC loader, copied from the installed plugin)
 *   - hud/lib/config-dir.mjs (loader dependency)
 *   - hud/omc-hud-custom.mjs (the custom compact/colored formatter)
 *   - .omc/hud-config.json   (HUD preset/elements)
 *   - settings.json          (statusLine -> the custom formatter; backed up when it changes)
 *
 * Runs identically on Linux, macOS, and Windows (only needs node + an OMC install).
 * Run it directly with `node apply-hud.mjs` on every OS; the templates are read
 * from this file's folder, so nothing is downloaded.
 *
 * Based on smallOpenSource/omc_hud d3cedd5 (MIT, see LICENSE-omc_hud). Changes:
 * statusLine path quoted; a settings.json that is not a JSON object is refused
 * before any file changes (the original replaced it), naming the line and
 * column when Node reports one but never quoting it; one holding only white
 * space is read as {}, as Claude Code does; UTF-8 BOM accepted; CLAUDE_CONFIG_DIR trimmed, "~" expanded
 * and made absolute; formatter and HUD config backed up when they differ (the
 * blocks payload-mon and claude-update-last add do not count unless edited by hand), settings.json only
 * when it changes; pre-releases sort below their release; no
 * folder is made when OMC is missing. Also refused before any change: a config
 * folder path the statusLine shell would act on, a file or folder it cannot
 * write, an OMC folder without both loader files, a relative OMC_PLUGIN_ROOT.
 * Backups keep the original bytes and mode; the files it writes are 0644 and new
 * folders 0755; the other statusLine fields (padding, ...) stay. settings.json goes
 * in as a new file through a rename (a link keeps pointing at it), in place where
 * that cannot be done or would part a hard link or change its owner or group, and
 * is left as it was when the disk is too full for the new file.
 * At the end it runs the installed formatter once with no input and reports
 * whether OMC's HUD loads and which version draws (the render check); that never
 * changes the exit code. APPLY_HUD_CHECK_TIMEOUT_MS (tests) shortens its 25s limit.
 * Exit 1 means nothing changed; exit 2 means an unexpected error stopped it partway.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = dirname(fileURLToPath(import.meta.url));
// Same rules as OMC's getClaudeConfigDir: trim, expand a leading "~", then make
// it absolute so statusLine works from any cwd.
function configDir() {
  const v = (process.env.CLAUDE_CONFIG_DIR || "").trim();
  if (!v) return join(homedir(), ".claude");
  if (v === "~") return homedir();
  if (v.startsWith("~/") || v.startsWith("~\\")) return join(homedir(), v.slice(2));
  return resolve(v);
}
const CONFIG_DIR = configDir().replace(/[\\/]+$/, "");
const HUD_DIR = join(CONFIG_DIR, "hud");
const OMC_DIR = join(CONFIG_DIR, ".omc");
const settingsPath = join(CONFIG_DIR, "settings.json");
const loaderDst = join(HUD_DIR, "omc-hud.mjs");
const libDst = join(HUD_DIR, "lib", "config-dir.mjs");
const wrapperDst = join(HUD_DIR, "omc-hud-custom.mjs");
const configDst = join(OMC_DIR, "hud-config.json");
// An absolute forward-slash path: Claude Code runs statusLine through a shell (Git Bash or
// PowerShell on Windows) that treats backslashes as escapes.
const cmdPath = wrapperDst.split(sep).join("/");
const log = (m) => process.stdout.write(m + "\n");
// Characters that could act on a terminal or pass for a line of their own are shown as "?", as
// omc-patch.mjs (UNSAFE_CH) shows file values in output an agent reads.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}\u{2800}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}]/gu;
const shown = (s) => String(s).replace(UNSAFE, "?");
// The old statusLine command as the report shows it: its first word (the program; a NAME=value it sets is skipped) and
// its length. settings.json can hold tokens (see step 0) and the line goes into a report; masking the parts that look
// like secrets missed every form no rule named (curl -u, sshpass -p, mysql -pPW), so the rest stays in the backup.
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Shell words: runs of plain characters and quoted pieces, a quote left open running to the end, so a value in quotes
// stays one word with its name.
const WORDS = /(?:"[^"]*"?|'[^']*'?|[^\s"'])+/g;
function priorShown(command) {
  const text = String(command).trim();
  const words = text.match(WORDS) || [];
  const first = words.findIndex((w) => !ASSIGN.test(w));
  // a first word that looks like a setting or an address may hold a secret itself
  const name = first === -1 ? "(no program)" : /[=@]|:\/\//.test(words[first]) ? "(program hidden)" : words[first];
  const head = `${name}${first !== -1 && first < words.length - 1 ? " …" : ""}`;
  return `${JSON.stringify(shown(head))} (${text.length} characters)`;
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const refuse = (lines) => {
  for (const l of lines) log(l);
  process.exit(1);
};

// 0. Check settings.json before touching anything, so a refusal leaves every
//    file as it was. Refuse rather than replace: a fresh file would drop every
//    other setting. A BOM (Windows editors) is dropped when the file is written
//    back; the backup keeps the original bytes.
//    Read as Claude Code (2.1.303) reads it: white space only is {}, and JSON
//    with comments or trailing commas is invalid. A refusal says where the JSON
//    breaks (from Node's "at position N") but never quotes it: Node's own message
//    does, and the file can hold tokens.
function jsonErrorAt(text, message) {
  const m = /at position (\d+)/.exec(message);
  if (!m) return "";
  const before = text.slice(0, Number(m[1]));
  return `line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")}`;
}
const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`);
function readSettings(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  if (text.trim() === "") return { settings: {}, empty: true };
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const at = jsonErrorAt(text, String(e && e.message));
    return {
      refusal:
        `[x] settings.json is not valid JSON${at ? ` (${at})` : ""}; nothing changed. ` +
        "Claude Code cannot read it either: comments and trailing commas are not allowed. Fix it and re-run.",
    };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return { settings: value, empty: false };
  return { refusal: `[x] settings.json holds ${kindOf(value)}, not a JSON object; nothing changed. Fix it and re-run.` };
}
// A target that is there but no regular file (a folder, a FIFO, a device), or a folder the install writes into that
// is there but no folder, is refused before anything is read or written: reading or writing a FIFO waits for good,
// and the others stopped the install half-way. Links are followed, as the reads and writes follow them; a target
// that is not there (a broken link too) is written new.
function oddTarget() {
  for (const p of [settingsPath, loaderDst, libDst, wrapperDst, configDst]) {
    try {
      if (!statSync(p).isFile()) return `${shown(p)} is not a regular file (a folder, a FIFO or a device)`;
    } catch {
      /* not there: written new */
    }
  }
  for (const d of [CONFIG_DIR, HUD_DIR, join(HUD_DIR, "lib"), OMC_DIR]) {
    try {
      if (!statSync(d).isDirectory()) return `${shown(d)} is not a folder`;
    } catch {
      /* not there: made */
    }
  }
  return "";
}
const odd = oddTarget();
if (odd) refuse([`[x] ${odd}; nothing changed. Move it aside and re-run.`]);

let settings = {};
let settingsRaw = null;
if (existsSync(settingsPath)) {
  settingsRaw = readFileSync(settingsPath, "utf8");
  const read = readSettings(settingsRaw);
  if (read.refusal) refuse([read.refusal]);
  settings = read.settings;
  if (read.empty) log("[..] settings.json is empty; read as {} as Claude Code does");
}

// Inside the command's double quotes these still act: a quote ends the path, $ and `
// run what follows, %VAR% expands, a backslash escapes, a line break ends the command.
if (/["`$%\\\r\n]/.test(cmdPath)) {
  refuse([
    '[x] The config folder path has a character the statusLine shell would act on (" ` $ % \\ or a line break); nothing changed.',
    "    Use a config folder without it (CLAUDE_CONFIG_DIR).",
  ]);
}

// 1. Resolve the installed OMC plugin root (for the canonical HUD loader template).
function resolvePluginRoot() {
  const lib = (r) => join(r, "scripts", "lib");
  // The loader needs both files; a folder holding only one would leave hud/ half replaced.
  const complete = (r) => existsSync(join(lib(r), "hud-wrapper-template.txt")) && existsSync(join(lib(r), "config-dir.mjs"));
  const fromEnv = process.env.OMC_PLUGIN_ROOT;
  // Only an absolute path: a relative one would be read from the project folder the command runs in.
  if (fromEnv && isAbsolute(fromEnv) && complete(fromEnv)) return fromEnv;
  const base = join(CONFIG_DIR, "plugins", "cache", "omc", "oh-my-claudecode");
  if (!existsSync(base)) return null;
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/;
  // Newest first; a pre-release sorts below its release (5.7.4-beta < 5.7.4).
  const newer = (a, b) => {
    const x = a.match(SEMVER);
    const y = b.match(SEMVER);
    for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +y[i] - +x[i];
    if (!x[4] !== !y[4]) return x[4] ? 1 : -1;
    return (y[4] || "").localeCompare(x[4] || "", undefined, { numeric: true });
  };
  const versions = readdirSync(base)
    .filter((n) => SEMVER.test(n))
    .sort(newer);
  for (const v of versions) {
    const r = join(base, v);
    if (complete(r)) return r;
  }
  return null;
}

const pluginRoot = resolvePluginRoot();
if (!pluginRoot && !existsSync(loaderDst)) {
  refuse([
    "[x] OMC plugin not installed and no existing hud/omc-hud.mjs found.",
    "    Install OMC first, then re-run:",
    "      /plugin install oh-my-claudecode   (or set OMC_PLUGIN_ROOT to an OMC version folder)",
  ]);
}

// Every file this run writes or backs up, checked before the first write so that a
// refusal changes nothing; a new file or backup needs its folder, or the nearest one
// that exists, to take it.
function unwritable() {
  for (const p of [settingsPath, loaderDst, libDst, wrapperDst, configDst]) {
    if (!existsSync(p)) continue;
    try {
      accessSync(p, constants.W_OK);
    } catch (e) {
      return `${p} (${e.code})`;
    }
  }
  for (const dir of [CONFIG_DIR, HUD_DIR, join(HUD_DIR, "lib"), OMC_DIR]) {
    let d = dir;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    try {
      accessSync(d, constants.W_OK);
    } catch (e) {
      return `${d} (${e.code})`;
    }
  }
  return "";
}
const blocked = unwritable();
if (blocked) refuse([`[x] Cannot write ${blocked}; nothing changed. Fix the permission and re-run.`]);

// The statusline runs or reads these on every refresh, so no other account may change them.
const FILE_MODE = 0o644;
function writeOwned(file, data) {
  writeFileSync(file, data, { mode: FILE_MODE });
  if (process.platform !== "win32") chmodSync(file, FILE_MODE);
}

// The marker blocks payload-mon and claude-update-last add to the installed formatter, matched as those
// tools match them (payload-mon.mjs BLOCKS, claude-update-last.mjs BLOCKS). Read as latin1, which maps
// every byte to one character, so text outside the blocks compares byte for byte.
const TOOL_BLOCKS = [
  /^[ \t]*\/\/ >>> payload-mon >>>[\s\S]*?\/\/ <<< payload-mon <<<[ \t]*\r?\n/gm,
  /^[ \t]*\/\/ >>> claude-update-last >>>(?:(?!\/\/ >>> claude-update-last >>>)[\s\S])*?\/\/ <<< claude-update-last <<<[ \t]*(?:\r?\n|(?![\s\S]))/gm,
];
// payload-mon's closing line (payload-mon.mjs CLOSE_LINE). No block reaches past the last one, so its
// pattern runs only on the text before it: otherwise every stray opening line scans to the end again
// (a 2MB file of them took 28s).
const PM_CLOSE = /\/\/ <<< payload-mon <<<[ \t]*\r?\n/g;
// The text without the tools' blocks, and the blocks it held.
function splitToolBlocks(text) {
  const blocks = [];
  const take = (t, pattern) =>
    t.replace(pattern, (block) => {
      blocks.push(block);
      return "";
    });
  let end = -1;
  for (const m of text.matchAll(PM_CLOSE)) end = m.index + m[0].length;
  const rest = end < 0 ? text : take(text.slice(0, end), TOOL_BLOCKS[0]) + text.slice(end);
  return { body: take(rest, TOOL_BLOCKS[1]), blocks };
}
// The blocks as the tools write them (payload-mon.mjs placeBlock, claude-update-last.mjs blockText), with
// LF line endings and payload-mon's import of its module copy as "<module copy>" (where the copy sits is the
// tool's to choose; a URL to any other file is an edit). A block that differs from both was edited by hand. When a tool's block changes, the test "payload-mon 블록만 다른 래퍼와 바뀌지 않은 settings.json 은
// 다시 설치해도 백업하지 않음" fails until this copy follows.
const TOOL_BLOCK_TEXTS = [
  [
    "  // >>> payload-mon >>>",
    "  // payload-mon: estimated API request payload against the 32MB request limit, shown",
    "  // like ctx from 8MB (25%) on. `payload-mon off` removes this block; a missing or",
    "  // broken module costs only this segment, never the statusline.",
    "  try {",
    "    const transcript = JSON.parse(input)?.transcript_path;",
    "    if (transcript) {",
    "      const { estimatePayloadBytes, payloadSegment } = await <module copy>;",
    "      const segment = payloadSegment(estimatePayloadBytes(transcript));",
    "      if (segment) colored.push(colorRate(segment));",
    "    }",
    "  } catch {",
    "    /* no stdin JSON, unreadable transcript or module error */",
    "  }",
    "  // <<< payload-mon <<<",
    "",
  ].join("\n"),
  [
    "  // >>> claude-update-last >>>",
    "  // claude-update-last (setup-omc-hud): OMC's Claude Code update notice",
    "  // (\"[Claude#X] -> Y claude update\") goes after every other segment.",
    "  // `claude-update-last off` removes this block; on any error the order stays as it was.",
    "  try {",
    "    const notice = /^\\[Claude(?:#[^\\]]*)?\\]\\s*->\\s*\\S+\\s+claude\\s+update\\b/;",
    "    const plain = (s) => stripAnsi(String(s)).trim();",
    "    const found = segs.find((s) => notice.test(plain(s)));",
    "    if (found) {",
    "      const moved = A(\"2\", plain(found));",
    "      for (let i = colored.length - 1; i >= 0; i--) if (notice.test(plain(colored[i]))) colored.splice(i, 1);",
    "      colored.push(moved);",
    "    }",
    "  } catch {",
    "    /* keep the order the wrapper chose */",
    "  }",
    "  // <<< claude-update-last <<<",
    "",
  ].join("\n"),
];
const toolMade = (block) =>
  TOOL_BLOCK_TEXTS.includes(block.replace(/\r\n/g, "\n").replace(/await import\("file:\/\/[^"\\]*\/payload-mon\/payload-size\.mjs"\)/, "await <module copy>"));
const sameBytes = (a, b) => a.equals(b);
// Blocks as the tools write them are no reason for a backup: `payload-mon on` puts its block back, and
// wrapper v4 needs no claude-update-last block. A block edited by hand is one.
function sameFormatter(a, b) {
  const old = splitToolBlocks(a.toString("latin1"));
  return old.body === splitToolBlocks(b.toString("latin1")).body && old.blocks.every(toolMade);
}

// Keep a timestamped copy, with its bytes and mode, of a file that differs from what replaces it.
function backupIfDifferent(dst, next, label, same = sameBytes) {
  if (!existsSync(dst)) return;
  if (same(readFileSync(dst), next)) return;
  const keep = dst + ".backup." + stamp;
  copyFileSync(dst, keep);
  log(`[ok] Backed up ${label} -> ${keep}`);
}

// 2. Ensure target directories exist, then copy the loader.
function installLoader() {
  for (const d of [join(HUD_DIR, "lib"), OMC_DIR]) mkdirSync(d, { recursive: true, mode: 0o755 });
  if (!pluginRoot) {
    log("[..] OMC plugin root not found; keeping existing hud/omc-hud.mjs");
    return;
  }
  writeOwned(loaderDst, readFileSync(join(pluginRoot, "scripts", "lib", "hud-wrapper-template.txt")));
  writeOwned(libDst, readFileSync(join(pluginRoot, "scripts", "lib", "config-dir.mjs")));
  log("[ok] OMC HUD loader installed from " + pluginRoot);
}

// 3. Install the custom formatter and HUD config from the bundled templates.
//    Files that differ from the templates (local edits) are kept as timestamped
//    backups first; the blocks payload-mon / claude-update-last add, as they write them, do not count.
function installTemplates() {
  const wrapperSrc = readFileSync(join(SELF, "omc-hud-custom.mjs"));
  const configSrc = readFileSync(join(SELF, "hud-config.json"));
  backupIfDifferent(wrapperDst, wrapperSrc, "previous formatter", sameFormatter);
  backupIfDifferent(configDst, configSrc, "previous HUD config");
  writeOwned(wrapperDst, wrapperSrc);
  writeOwned(configDst, configSrc);
  log("[ok] Custom formatter -> " + wrapperDst);
  log("[ok] HUD config       -> " + configDst);
}

// settings.json goes in as a new file through a rename, so a stop midway never leaves it half written.
// One that is a link (dotfiles) keeps its link, and the file it points at is the one replaced. A file
// left at the temporary name (an earlier run with this pid, or a link put there) is removed first and
// never written through. It is written in place as before where the new file cannot go in (a folder
// this account may not write, a file another program holds open, a file system that refuses the
// rename) or the link leads nowhere yet, and where a rename would part a hard link (its other name
// would keep the old text) or the new file has another owner or group. Only a full disk stops it, as
// writing in place could then cut settings.json short; the new file is written before that choice, so
// a hard link or another owner finds a full disk first too.
const FULL_DISK = new Set(["ENOSPC", "EDQUOT"]);
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const removeTmp = (tmp) => {
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* a folder at that name: left alone */
  }
};
// Whether the file, as `old` was, must keep its inode: it has a second name (a hard link), or the new file
// `tmp` got another owner or group than it had.
function keepsInode(old, tmp) {
  if (!old) return false;
  const now = statSync(tmp);
  return old.nlink > 1 || now.uid !== old.uid || now.gid !== old.gid;
}
function writeSettings(file, text) {
  let target = file;
  let old;
  let mode;
  try {
    target = realpathSync(file);
    old = statSync(target);
    mode = old.mode & 0o777;
  } catch {
    if (isLink(file)) return writeFileSync(file, text);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, text, { flag: "wx", mode });
    if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode);
    if (!keepsInode(old, tmp)) return renameSync(tmp, target);
  } catch (e) {
    if (FULL_DISK.has(e.code)) throw e;
  } finally {
    removeTmp(tmp);
  }
  writeFileSync(file, text);
}

// How many other names settings.json has (a hard link, a `cp -al` snapshot, say), 0 when it cannot be read.
// writeSettings writes such a file in place, so those names show the new text too.
function otherNames(file) {
  try {
    return statSync(file).nlink - 1;
  } catch {
    return 0;
  }
}

// 4. Point settings.json statusLine at the custom formatter; its other fields (padding, ...) stay.
//    A settings.json that already says exactly this is neither backed up nor written.
const objectOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
function pointStatusLine() {
  // Quoted so a config dir with spaces (C:/Users/First Last/.claude) still runs.
  const command = `node "${cmdPath}"`;
  const prior = objectOr(settings.statusLine);
  if (typeof prior.command === "string" && prior.command && prior.command !== command) {
    log(`[..] statusLine ran ${priorShown(prior.command)}; it now runs the custom HUD (the old value is in the backup)`);
  }
  settings.statusLine = { ...prior, type: "command", command };
  const next = JSON.stringify(settings, null, 2) + "\n";
  if (next === settingsRaw) {
    log(`[ok] statusLine -> ${command} (settings.json unchanged, no backup)`);
    return;
  }
  if (settingsRaw !== null) {
    const backup = settingsPath + ".backup." + stamp;
    copyFileSync(settingsPath, backup); // the original bytes and mode
    log("[ok] Backed up settings.json -> " + backup);
  }
  const others = otherNames(settingsPath);
  writeSettings(settingsPath, next);
  log("[ok] statusLine -> " + command);
  if (others > 0) {
    log(`[..] settings.json has ${others} other name${others > 1 ? "s" : ""} (a hard link); it was written in place, so they show the new text too (the old text is in the backup)`);
  }
}

// 5. Render check: run the installed formatter once with no input, as the statusLine command does,
//    with `node` from PATH. With no input OMC prints its diagnostic, whose first line names the version
//    that loaded ("[OMC] HUD v5.7.4 | preset: full"), and uses no network. Reported only: the install
//    is done either way. The 25s limit outwaits the formatter, which gives up on its own within 20s
//    and then ends its fallback child; killing it sooner would leave that child running.
//    APPLY_HUD_CHECK_TIMEOUT_MS shortens the limit for tests.
const CHECK_MS = Number(process.env.APPLY_HUD_CHECK_TIMEOUT_MS) || 25000;
const BLAME =
  "    OMC's install is at fault. /oh-my-claudecode:omc-setup repairs it but points statusLine back at OMC, so run setup-omc-hud again after it.";
const clip = (s, n = 200) => shown(s).slice(0, n);
// No input, and the config folder as working folder: OMC's loader looks in the working folder's
// node_modules and runs git from it, and Windows looks there first for a bare program name, so the
// folder the installer was started in (a project, say) must not be it.
const RUN_OPTS = { input: "", encoding: "utf8", timeout: CHECK_MS, windowsHide: true, cwd: CONFIG_DIR };

// node as the statusLine shell finds it, but only in PATH folders given as absolute paths: spawning the
// bare name would on Windows try the working folder first, where a project's own node.exe could run.
// Like the shell, it passes over a file it may not run.
function findNode(pathEnv, name = process.platform === "win32" ? "node.exe" : "node") {
  for (const entry of (pathEnv || "").split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      /* not in this folder, or not runnable */
    }
  }
  return null;
}

const NO_NODE = '[!!] Render check: no "node" on PATH; the statusLine command runs "node", so the statusline will not show.';
// Claude Code runs statusLine with Git Bash when it finds it, else with PowerShell. Of the two only
// PowerShell runs node.cmd for "node", and this check cannot tell which it will be, so it does not run.
const NODE_CMD_ONLY =
  '[..] Render check: skipped; PATH has node.cmd but no node.exe, and Git Bash, which Claude Code runs statusLine with when it finds it, does not run node.cmd as "node".';
const noNodeLine = (pathEnv) => (process.platform === "win32" && findNode(pathEnv, "node.cmd") ? NODE_CMD_ONLY : NO_NODE);

function omcVersion(root) {
  if (!root) return null;
  try {
    const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// The first line of a Node error ("Error: ...", "TypeError [ERR_X]: ..."), "" when there is none.
const errorLine = (text) => /^\w*Error\b.*$/m.exec(text || "")?.[0] ?? "";

// Why an OMC version does not load: its HUD's own error when run directly.
function loadReason(node, root) {
  const hud = join(root, "dist", "hud", "index.js");
  if (!existsSync(hud)) return "no dist/hud/index.js";
  const r = spawnSync(node, [hud], RUN_OPTS);
  const line = errorLine(r.stderr);
  return line ? clip(line) : "";
}

const NO_OUTPUT = "[..] Render check: OMC printed nothing with no input, so this check cannot tell whether the statusline draws.";

// What the formatter printed, as report lines.
function judgeRender(out, node) {
  const banner = /^\[OMC\] HUD v(\S+) \| preset: /m.exec(out);
  if (banner) {
    const installed = omcVersion(pluginRoot);
    // Both version strings come from OMC (its output, its package.json): shown through clip like its lines.
    const [drew, want] = [clip(banner[1], 40), clip(installed, 40)];
    if (!installed || installed === banner[1]) return [`[ok] Render check: the statusline loads OMC ${drew}.`];
    const why = loadReason(node, pluginRoot);
    // Without an error from the installed version, all this check saw is which version drew.
    if (!why) return [`[..] Render check: the statusline loads OMC ${drew}, not the installed ${want}.`];
    return [`[!!] Render check: the statusline loads OMC ${drew}, not the installed ${want}; ${want} does not load (${why}).`, BLAME];
  }
  // The formatter says this when OMC printed nothing; with no input that alone does not say it cannot draw.
  if (/^\[OMC HUD\] no output$/m.test(out)) return [NO_OUTPUT];
  // OMC's line ends with the reason, after a path that can be long: keep it whole within reason.
  const failed = /^\[OMC HUD\] .*$/m.exec(out);
  if (failed) return [`[!!] Render check: OMC's HUD does not load: ${clip(failed[0], 1000)}`, BLAME];
  // A loader that cannot load prints Node's error, header lines first; its module path can be long.
  const error = errorLine(out);
  if (error) return [`[!!] Render check: the statusline prints an error instead of a line: ${clip(error, 1000)}`];
  return [`[..] Render check: unrecognized output: ${clip(out.split("\n")[0])}`];
}

// A statusline command that exited non-zero: its Node error line when stderr has one, else the first line.
function failedLine(r) {
  const stderr = (r.stderr || "").trim();
  const err = errorLine(stderr) || stderr.split("\n")[0];
  return `[!!] Render check: the statusline command failed (exit ${r.status ?? r.signal})${err ? `: ${clip(err)}` : ""}`;
}

function renderReport() {
  const node = findNode(process.env.PATH);
  if (!node) return [noNodeLine(process.env.PATH)];
  const r = spawnSync(node, [wrapperDst], RUN_OPTS);
  if (r.error && r.error.code === "ETIMEDOUT") return [`[!!] Render check: the statusline gave no answer in ${CHECK_MS / 1000}s.`];
  if (r.error) throw r.error;
  if (r.status !== 0) return [failedLine(r)];
  return judgeRender((r.stdout || "").replace(/\x1b\[[0-9;]*m/g, ""), node);
}

function renderCheck() {
  try {
    for (const line of renderReport()) log(line);
  } catch (e) {
    log(`[..] Render check: skipped (${e.code || e.message})`);
  }
}

try {
  installLoader();
  installTemplates();
  pointStatusLine();
} catch (e) {
  log(`[x] Stopped partway (${e.code || e.message}); some files may have changed.`);
  log(`    Earlier versions it replaced, apart from the loader and blocks as the tools wrote them, are in <file>.backup.${stamp}.`);
  process.exit(2);
}

renderCheck();
log("");
log("Done. Restart Claude Code to load the new statusline.");
