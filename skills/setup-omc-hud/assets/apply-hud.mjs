#!/usr/bin/env node
/**
 * apply-hud.mjs — cross-platform installer for the custom OMC HUD statusline.
 *
 * Installs into ${CLAUDE_CONFIG_DIR:-~/.claude}:
 *   - hud/omc-hud.mjs        (OMC loader, copied from the installed plugin)
 *   - hud/lib/config-dir.mjs (loader dependency)
 *   - hud/omc-hud-custom.mjs (the custom compact/colored formatter)
 *   - .omc/hud-config.json   (HUD preset/elements)
 *   - settings.json          (statusLine -> the custom formatter; existing file backed up)
 *
 * Runs identically on Linux, macOS, and Windows (only needs node + an OMC install).
 * Run it directly with `node apply-hud.mjs` on every OS; the templates are read
 * from this file's folder, so nothing is downloaded.
 *
 * Based on smallOpenSource/omc_hud d3cedd5 (MIT, see LICENSE-omc_hud). Changes:
 * statusLine path quoted; a settings.json that is not a JSON object is refused
 * before any file changes (the original replaced it); UTF-8 BOM accepted;
 * CLAUDE_CONFIG_DIR trimmed, "~" expanded and made absolute; formatter and HUD
 * config backed up when they differ; pre-releases sort below their release; no
 * folder is made when OMC is missing. Also refused before any change: a config
 * folder path the statusLine shell would act on, a file or folder it cannot
 * write, an OMC folder without both loader files, a relative OMC_PLUGIN_ROOT.
 * Backups keep the original bytes and mode; the files it writes are 0644 and new
 * folders 0755; the other statusLine fields (padding, ...) stay.
 * Exit 1 means nothing changed; exit 2 means an unexpected error stopped it partway.
 */
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const refuse = (lines) => {
  for (const l of lines) log(l);
  process.exit(1);
};

// 0. Check settings.json before touching anything, so a refusal leaves every
//    file as it was. Refuse rather than replace: a fresh file would drop every
//    other setting. A BOM (Windows editors) is dropped when the file is written
//    back; the backup keeps the original bytes.
let settings = {};
let settingsRaw = null;
if (existsSync(settingsPath)) {
  settingsRaw = readFileSync(settingsPath, "utf8");
  try {
    settings = JSON.parse(settingsRaw.replace(/^\uFEFF/, ""));
  } catch {
    settings = undefined;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    refuse(["[x] Existing settings.json is not a JSON object; nothing changed. Fix it and re-run."]);
  }
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

// Keep a timestamped copy, with its bytes and mode, of a file that differs from what replaces it.
function backupIfDifferent(dst, next, label) {
  if (!existsSync(dst)) return;
  if (readFileSync(dst).equals(next)) return;
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
//    Files that differ from the templates (local edits, blocks added by
//    payload-mon / claude-update-last) are kept as timestamped backups first.
function installTemplates() {
  const wrapperSrc = readFileSync(join(SELF, "omc-hud-custom.mjs"));
  const configSrc = readFileSync(join(SELF, "hud-config.json"));
  backupIfDifferent(wrapperDst, wrapperSrc, "previous formatter");
  backupIfDifferent(configDst, configSrc, "previous HUD config");
  writeOwned(wrapperDst, wrapperSrc);
  writeOwned(configDst, configSrc);
  log("[ok] Custom formatter -> " + wrapperDst);
  log("[ok] HUD config       -> " + configDst);
}

// 4. Point settings.json statusLine at the custom formatter; its other fields (padding, ...) stay.
const objectOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
function pointStatusLine() {
  if (settingsRaw !== null) {
    const backup = settingsPath + ".backup." + stamp;
    copyFileSync(settingsPath, backup); // the original bytes and mode
    log("[ok] Backed up settings.json -> " + backup);
  }
  // Quoted so a config dir with spaces (C:/Users/First Last/.claude) still runs.
  const command = `node "${cmdPath}"`;
  const prior = objectOr(settings.statusLine);
  if (typeof prior.command === "string" && prior.command && prior.command !== command) {
    log(`[..] statusLine ran ${JSON.stringify(prior.command)}; it now runs the custom HUD (the old value is in the backup)`);
  }
  settings.statusLine = { ...prior, type: "command", command };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  log("[ok] statusLine -> " + command);
}

try {
  installLoader();
  installTemplates();
  pointStatusLine();
} catch (e) {
  log(`[x] Stopped partway (${e.code || e.message}); some files may have changed.`);
  log(`    A replaced file's earlier version is in <file>.backup.${stamp}.`);
  process.exit(2);
}

log("");
log("Done. Restart Claude Code to load the new statusline.");
