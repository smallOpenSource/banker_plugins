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
 * folder is made when OMC is missing.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
const log = (m) => process.stdout.write(m + "\n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// 0. Check settings.json before touching anything, so a refusal leaves every
//    file as it was. Refuse rather than replace: a fresh file would drop every
//    other setting. A BOM (Windows editors) is dropped when the file is written
//    back; the backup keeps the original bytes.
const settingsPath = join(CONFIG_DIR, "settings.json");
let settings = {};
let settingsRaw = null;
if (existsSync(settingsPath)) {
  settingsRaw = readFileSync(settingsPath, "utf8");
  try {
    settings = JSON.parse(settingsRaw.replace(/^﻿/, ""));
  } catch {
    settings = undefined;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    log("[x] Existing settings.json is not a JSON object; nothing changed. Fix it and re-run.");
    process.exit(1);
  }
}

// Keep a timestamped copy of a file that differs from what replaces it.
function backupIfDifferent(dst, next, label) {
  if (!existsSync(dst)) return;
  const prev = readFileSync(dst);
  if (prev.equals(next)) return;
  const keep = dst + ".backup." + stamp;
  writeFileSync(keep, prev);
  log(`[ok] Backed up ${label} -> ${keep}`);
}

// 1. Resolve the installed OMC plugin root (for the canonical HUD loader template).
function resolvePluginRoot() {
  const hasTemplate = (r) => !!r && existsSync(join(r, "scripts", "lib", "hud-wrapper-template.txt"));
  if (hasTemplate(process.env.OMC_PLUGIN_ROOT)) return process.env.OMC_PLUGIN_ROOT;
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
    if (hasTemplate(r)) return r;
  }
  return null;
}

const pluginRoot = resolvePluginRoot();
const loaderDst = join(HUD_DIR, "omc-hud.mjs");
if (!pluginRoot && !existsSync(loaderDst)) {
  log("[x] OMC plugin not installed and no existing hud/omc-hud.mjs found.");
  log("    Install OMC first, then re-run:");
  log("      /plugin install oh-my-claudecode   (or)   npm i -g oh-my-claude-sisyphus");
  process.exit(1);
}

// 2. Ensure target directories exist, only once there is something to install,
//    then copy the loader.
for (const d of [join(HUD_DIR, "lib"), OMC_DIR]) mkdirSync(d, { recursive: true });
if (pluginRoot) {
  copyFileSync(join(pluginRoot, "scripts", "lib", "hud-wrapper-template.txt"), loaderDst);
  copyFileSync(join(pluginRoot, "scripts", "lib", "config-dir.mjs"), join(HUD_DIR, "lib", "config-dir.mjs"));
  log("[ok] OMC HUD loader installed from " + pluginRoot);
} else {
  log("[..] OMC plugin root not found; keeping existing hud/omc-hud.mjs");
}

// 3. Install the custom formatter and HUD config from the bundled templates.
//    Files that differ from the templates (local edits, blocks added by
//    payload-mon / claude-update-last) are kept as timestamped backups first.
const wrapperDst = join(HUD_DIR, "omc-hud-custom.mjs");
const configDst = join(OMC_DIR, "hud-config.json");
const wrapperSrc = readFileSync(join(SELF, "omc-hud-custom.mjs"));
const configSrc = readFileSync(join(SELF, "hud-config.json"));
backupIfDifferent(wrapperDst, wrapperSrc, "previous formatter");
backupIfDifferent(configDst, configSrc, "previous HUD config");
writeFileSync(wrapperDst, wrapperSrc);
writeFileSync(configDst, configSrc);
log("[ok] Custom formatter -> " + wrapperDst);
log("[ok] HUD config       -> " + configDst);

// 4. Point settings.json statusLine at the custom formatter.
//    Use an absolute forward-slash path: Claude Code runs statusLine via a shell
//    that treats backslashes as escapes, so forward slashes are required on Windows too.
const cmdPath = wrapperDst.split(sep).join("/");
if (settingsRaw !== null) {
  const backup = settingsPath + ".backup." + stamp;
  writeFileSync(backup, settingsRaw);
  log("[ok] Backed up settings.json -> " + backup);
}
// Quoted so a config dir with spaces (C:/Users/First Last/.claude) still runs.
const command = `node "${cmdPath}"`;
settings.statusLine = { type: "command", command };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
log("[ok] statusLine -> " + command);

log("");
log("Done. Restart Claude Code to load the new statusline.");
