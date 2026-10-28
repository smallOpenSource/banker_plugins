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
 * Usage:
 *   node scripts/sync-codex-plugin.js          # write codex/command-skills from commands/
 *   node scripts/sync-codex-plugin.js --check  # exit 1 if a command skill drifts or the plugin's skill set or hooks drift
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
  for (const p of pluginProblems(m)) { console.error(`CODEX PLUGIN: ${p}`); failed = true; }
  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = { commandSkills, pluginProblems, SKILL_DIRS, HOOKS_FILE };
