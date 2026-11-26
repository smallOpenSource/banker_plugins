/*
 * Other plugins whose skills banker has retired, and how to take them out of Claude Code.
 *
 * humanize-korean@im-not-ai (marketplace epoko77-ai/im-not-ai): its skills humanize, humanize-redo and humanize-scan
 * did not work for the user, and banker's humanizer does that job now. A plugin cannot lose single skills, so the whole
 * plugin is uninstalled (claude plugin uninstall <id> --scope <scope>). Its marketplace stays registered.
 *
 * Users:
 *  - bin/banker.js `banker setup --claude` uninstalls the user and local scope installs and reports each one.
 *  - hooks/update-notify.mjs (Claude Code SessionStart) says once, with the command, that such an install is there.
 *    It never uninstalls: a hook has five seconds and must not change the user's setup.
 *  - skills/update-banker tells the same steps after the Claude channel.
 * Only local files are read: installed_plugins.json under the Claude config folder (CLAUDE_CONFIG_DIR or ~/.claude).
 * No network. A missing or unreadable file means nothing is installed.
 *
 * A project scope install is written in <project>/.claude/settings.json, which the project shares (often in git),
 * so it is reported with its command and left to the user. Codex has none of these skills: the plugin's Codex
 * package (install.sh --codex-only) installs only ~/.codex/skills/humanize-korean, not humanize, humanize-redo or
 * humanize-scan.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configDir, readRegular, writeByRename } from './telemetry-config.mjs';

export const RETIRED = [
  { id: 'humanize-korean@im-not-ai', skills: ['humanize', 'humanize-redo', 'humanize-scan'], instead: 'humanizer' },
];

// Claude Code's config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude.
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

// The installs of retired plugins: [{ id, scope, projectPath }]. Nothing installed or no readable file: [].
export function retiredInstalls(env = process.env) {
  let j;
  try {
    j = JSON.parse(readRegular(path.join(claudeConfigDir(env), 'plugins', 'installed_plugins.json')));
  } catch {
    return [];
  }
  const out = [];
  for (const r of RETIRED) {
    const list = j && typeof j === 'object' && j.plugins && typeof j.plugins === 'object' ? j.plugins[r.id] : null;
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const scope = typeof e?.scope === 'string' ? e.scope : 'user';
      out.push({ id: r.id, scope, projectPath: typeof e?.projectPath === 'string' ? e.projectPath : '' });
    }
  }
  return out;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// How to uninstall one install: { args, cwd, run, why }. run is false when banker leaves it to the user.
export function uninstallStep(inst, home = os.homedir()) {
  const args = ['plugin', 'uninstall', inst.id, '--scope', inst.scope];
  if (inst.scope === 'user') return { args, cwd: home, run: true, why: '' };
  if (inst.scope === 'local' && inst.projectPath && isDir(inst.projectPath)) return { args, cwd: inst.projectPath, run: true, why: '' };
  if (inst.scope === 'local') return { args, cwd: inst.projectPath, run: false, why: 'its project folder is not there' };
  if (inst.scope === 'project') return { args, cwd: inst.projectPath, run: false, why: 'the project shares it in .claude/settings.json' };
  return { args, cwd: inst.projectPath, run: false, why: `scope ${inst.scope} is not the user's to change` };
}

// The command as the user types it, with the folder to run it in when that is a project.
export function commandText(step) {
  const cmd = `claude ${step.args.join(' ')}`;
  return step.args.includes('user') || !step.cwd ? cmd : `${step.cwd} 에서 ${cmd}`;
}

// The notice for the installs, or ''.
export function retiredNote(installs) {
  if (!installs.length) return '';
  const byId = new Map();
  for (const i of installs) byId.set(i.id, [...(byId.get(i.id) || []), i]);
  return [...byId].map(([id, list]) => {
    const r = RETIRED.find((x) => x.id === id);
    const cmds = list.map((i) => commandText(uninstallStep(i))).join(', ');
    return `banker: 설치된 ${id} 의 ${r.skills.join(', ')} 은 효과가 없어 banker 가 지우기로 했습니다. `
      + `banker setup --claude 나 /banker:update-banker 가 플러그인째 지웁니다. 바로 지우려면 ${cmds} 를 실행하십시오`
      + `(마켓플레이스 등록은 그대로 둡니다). 윤문은 /banker:${r.instead}`;
  }).join('\n');
}

const NOTIFIED_FILE = () => path.join(configDir(), 'retired-notified.json');

// For the SessionStart hook: the notice once per retired plugin id (the ids told are kept in the banker config
// folder). '' when nothing is installed, everything installed was told before, or anything fails.
export function retiredNoticeOnce(env = process.env, file = NOTIFIED_FILE()) {
  try {
    const installs = retiredInstalls(env);
    if (!installs.length) return '';
    let told = [];
    try { told = JSON.parse(readRegular(file)); } catch { /* none told yet */ }
    if (!Array.isArray(told)) told = [];
    const fresh = installs.filter((i) => !told.includes(i.id));
    if (!fresh.length) return '';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeByRename(file, JSON.stringify([...new Set([...told, ...fresh.map((i) => i.id)])]));
    } catch { /* cannot keep it: told again next session rather than never */ }
    return retiredNote(fresh);
  } catch {
    return '';
  }
}
