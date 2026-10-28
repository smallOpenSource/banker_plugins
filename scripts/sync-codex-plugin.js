#!/usr/bin/env node
'use strict';
/*
 * Codex plugin sync guard. `codex plugin add banker@banker-plugins` installs this repo as a Codex plugin and reads
 * .codex-plugin/plugin.json (Claude Code reads .claude-plugin/ and ignores it). Its skills come from three folders:
 *   skills/                  the skills both runtimes share
 *   codex/skills/            the codex-only skills (Codex counterparts of Claude Code mods)
 *   codex/command-skills/    commands/<name>.md as skills (Codex 0.144+ has no custom prompts), written here
 * so the plugin offers what `banker setup --codex` installs (codex/manifest.json: target both and codex-only).
 * `commands: []` keeps Codex 0.160+ from also turning commands/ (Claude Code commands) into source-command-* skills.
 * codex/hooks.json is written here too. Codex runs a trusted hook outside its sandbox, so each command finds node on
 * PATH, resolves its real path, and runs nothing when that is relative or under the temp folder or the session folder
 * (both writable from the sandbox): the rule `banker setup --codex` applies with safeNode() in bin/lib/codex-hooks.mjs.
 * Usage:
 *   node scripts/sync-codex-plugin.js          # write codex/command-skills from commands/, and codex/hooks.json
 *   node scripts/sync-codex-plugin.js --check  # exit 1 if a command skill, the hooks file, or the plugin's skill set drifts
 */
const fs = require('fs');
const path = require('path');
const { commandSkillText } = require('../bin/lib/command-skill.cjs');

const root = path.resolve(__dirname, '..');
const CMD_DIR = path.join(root, 'codex', 'command-skills');
const SKILL_DIRS = ['./skills/', './codex/skills/', './codex/command-skills/'];
const HOOKS_FILE = './codex/hooks.json';

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const manifest = () => JSON.parse(read('codex/manifest.json'));
const eligible = (m) => m.surfaces.filter((s) => s.target === 'both' || s.target === 'codex-only');
const skillDirs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md'))) : []);

// The plugin's hooks: [event, tool matcher, script under hooks/, args, through run.cjs]. The obsidizer hook is not here:
// it would start node on every shell call for everyone, so `obsidizer --enable` installs it on its own, in the user
// scope, as the npm install does (bin/banker.js hooks enable obsidize, run from the plugin folder).
const HOOKS = [
  ['SessionStart', null, 'update-notify.mjs', ['--codex', '--plugin'], true],
  ['Stop', null, 'telemetry-count-codex.mjs', [], true],
];
const HOOKS_NOTE = 'banker hooks for the Codex plugin (codex plugin add banker@banker-plugins), written by scripts/sync-codex-plugin.js. '
  + 'Codex reads this file instead of hooks/hooks.json because .codex-plugin/plugin.json names it. update notice (SessionStart, opt-out '
  + 'BANKER_NO_UPDATE_CHECK), usage counting (Stop, opt-out BANKER_NO_TELEMETRY). The obsidizer hook is installed only by obsidizer --enable. '
  + 'Codex runs them only after you trust them in /hooks, and outside its sandbox: each command runs the node PATH names only when its real '
  + 'path is absolute and outside the temp folder and the session folder, and runs it from the plugin folder (a version manager shim '
  + 'then reads no version file from the session folder; the hook scripts take that folder from their input). command is for sh, commandWindows for PowerShell; PLUGIN_ROOT is '
  + 'the installed plugin folder.';

// sh: node from PATH, resolved (no realpath or readlink -f: run nothing), then refused when relative or in a sandbox-writable place.
function shCommand(script, args, viaRun) {
  const run = viaRun ? ' "$PLUGIN_ROOT/hooks/run.cjs"' : '';
  return '[ -n "$PLUGIN_ROOT" ] || exit 0; n=$(command -v node) || exit 0; '
    + 'r=$(realpath "$n" 2>/dev/null || readlink -f "$n" 2>/dev/null) || exit 0; '
    // Compared as real paths: on macOS /tmp and TMPDIR are links into /private.
    + 'u=$(cd /tmp && pwd -P); t=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || t=$u; p=$(pwd -P); '
    + '[ "$p" != / ] || exit 0; case "$r" in "$u"/*|"$t"/*|"$p"/*) exit 0;; /*) ;; *) exit 0;; esac; '
    // From the plugin folder: an asdf or mise shim picks the node binary from a .tool-versions it finds from the cwd up.
    + 'cd "$PLUGIN_ROOT" || exit 0; '
    + `"$r"${run} "$PLUGIN_ROOT/hooks/${script}"${args.map((a) => ` ${a}`).join('')}`;
}

// PowerShell (Windows): the node.exe PATH names (a .cmd shim would run node by bare name, found in the current folder
// first), refused under TEMP, TMP or the session folder, run from the plugin folder.
function psCommand(script, args, viaRun) {
  const run = viaRun ? ' "$env:PLUGIN_ROOT\\hooks\\run.cjs"' : '';
  return 'if (-not $env:PLUGIN_ROOT) { exit 0 }; '
    + '$n = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $n) { exit 0 }; '
    + "$r = [IO.Path]::GetFullPath($n.Source); if ($r -notlike '*.exe') { exit 0 }; "
    + "foreach ($d in @($env:TEMP, $env:TMP, \"$env:LOCALAPPDATA\\Temp\", $PWD.Path)) { if ($d -and $r.StartsWith($d.TrimEnd('\\') + '\\', 'OrdinalIgnoreCase')) { exit 0 } }; "
    + 'if (-not (Set-Location -LiteralPath $env:PLUGIN_ROOT -PassThru -ErrorAction SilentlyContinue)) { exit 0 }; '
    + `& $r${run} "$env:PLUGIN_ROOT\\hooks\\${script}"${args.map((a) => ` ${a}`).join('')}`;
}

function hooksText() {
  const doc = { description: HOOKS_NOTE, hooks: {} };
  for (const [ev, matcher, script, args, viaRun] of HOOKS) {
    doc.hooks[ev] = [{ ...(matcher ? { matcher } : {}), hooks: [{
      type: 'command', command: shCommand(script, args, viaRun), commandWindows: psCommand(script, args, viaRun), timeout: 5,
    }] }];
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// The command skills the plugin carries: { name, file, text }.
function commandSkills(m = manifest()) {
  return eligible(m).filter((s) => s.type === 'command').map((s) => ({
    name: s.name,
    file: path.join(CMD_DIR, s.name, 'SKILL.md'),
    text: commandSkillText(read(`commands/${s.name}.md`), s.name, `$banker:${s.name}`),
  }));
}

// Problems with the plugin manifest, its skill set and its hooks file, as messages.
function pluginProblems(m = manifest()) {
  const out = [];
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  const claude = JSON.parse(read('.claude-plugin/plugin.json'));
  if (plugin.name !== claude.name) out.push(`.codex-plugin/plugin.json name ${plugin.name} != ${claude.name}`);
  if (JSON.stringify(plugin.skills) !== JSON.stringify(SKILL_DIRS)) out.push(`.codex-plugin/plugin.json skills must be ${JSON.stringify(SKILL_DIRS)}`);
  if (plugin.hooks !== HOOKS_FILE) out.push(`.codex-plugin/plugin.json hooks must be ${HOOKS_FILE}`);
  // Codex 0.160 turns a plugin's commands/*.md into skills named source-command-<name> unless the manifest names its
  // commands. Ours are Claude Code commands (codex/command-skills carries the Codex side), so the list stays empty.
  if (!Array.isArray(plugin.commands) || plugin.commands.length) out.push('.codex-plugin/plugin.json commands must be [] (keeps Codex 0.160+ from turning commands/ into source-command-* skills)');
  // Codex names a plugin skill <plugin>:<dir>, so a name in two folders would shadow the other.
  const seen = new Map();
  for (const dir of SKILL_DIRS) {
    for (const d of skillDirs(path.join(root, dir))) {
      if (seen.has(d)) out.push(`skill ${d} is in both ${seen.get(d)} and ${dir}`);
      seen.set(d, dir);
    }
  }
  const want = eligible(m).map((s) => s.name).sort();
  const have = [...seen.keys()].sort();
  if (JSON.stringify(want) !== JSON.stringify(have)) {
    out.push(`plugin skills != manifest (missing: ${want.filter((n) => !seen.has(n)).join(', ') || '-'}; extra: ${have.filter((n) => !want.includes(n)).join(', ') || '-'})`);
  }
  // Every hook runs a script this repo has.
  const hooks = JSON.parse(read(HOOKS_FILE)).hooks || {};
  for (const groups of Object.values(hooks)) {
    for (const h of groups.flatMap((g) => g.hooks || [])) {
      for (const cmd of [h.command, h.commandWindows]) {
        const scripts = String(cmd).match(/hooks[\\/][a-z-]+\.(?:mjs|cjs)/g) || [];
        if (!scripts.length) out.push(`hook command runs no hooks/ script: ${cmd}`);
        for (const s of scripts) if (!fs.existsSync(path.join(root, ...s.split(/[\\/]/)))) out.push(`hook script missing: ${s}`);
      }
    }
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const m = manifest();
  const skills = commandSkills(m);
  let failed = false;
  for (const s of skills) {
    const now = fs.existsSync(s.file) ? fs.readFileSync(s.file, 'utf8') : null;
    if (now === s.text) { console.log(`command skill ${s.name} in sync`); continue; }
    if (check) {
      console.error(`COMMAND SKILL MISMATCH: ${path.relative(root, s.file)} != commands/${s.name}.md. Fix: node scripts/sync-codex-plugin.js`);
      failed = true;
      continue;
    }
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, s.text);
    console.log(`wrote ${path.relative(root, s.file)}`);
  }
  // A command dropped from the manifest leaves no stale skill behind.
  for (const d of skillDirs(CMD_DIR).filter((d) => !skills.some((s) => s.name === d))) {
    if (check) { console.error(`STALE COMMAND SKILL: codex/command-skills/${d}. Fix: node scripts/sync-codex-plugin.js`); failed = true; }
    else { fs.rmSync(path.join(CMD_DIR, d), { recursive: true, force: true }); console.log(`removed codex/command-skills/${d}`); }
  }
  const hooksFile = path.join(root, ...HOOKS_FILE.split('/'));
  if ((fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : null) !== hooksText()) {
    if (check) { console.error(`HOOKS MISMATCH: ${HOOKS_FILE}. Fix: node scripts/sync-codex-plugin.js`); failed = true; }
    else { fs.writeFileSync(hooksFile, hooksText()); console.log(`wrote ${HOOKS_FILE}`); }
  } else console.log(`${HOOKS_FILE} in sync`);
  for (const p of pluginProblems(m)) { console.error(`CODEX PLUGIN: ${p}`); failed = true; }
  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = { commandSkills, pluginProblems, hooksText, shCommand, psCommand, SKILL_DIRS, HOOKS_FILE };
