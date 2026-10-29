'use strict';
/*
 * A command (commands/<name>.md) as a Codex skill. Codex 0.144+ has no custom prompts, so each command is also a skill.
 * Two installs use it:
 *  - npm (banker setup --codex): writes <CODEX_HOME>/skills/banker-<name>/SKILL.md, invoked as $banker-<name>.
 *  - Codex plugin (codex plugin add banker@banker-plugins): scripts/sync-codex-plugin.js writes
 *    codex/command-skills/<name>/SKILL.md in the repo, invoked as $banker:<name>.
 * The command's description becomes the skill's. Codex skills get no $ARGUMENTS substitution, so a note says where the
 * arguments come from.
 */
function commandSkillText(text, name, invoke) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const desc = fm && fm[1].match(/^description:\s*(.*)$/m);
  const body = fm ? text.slice(fm[0].length) : text;
  const note = '> Codex: 이 명령은 스킬로 설치됐다. 본문의 `$ARGUMENTS`, `$1` 은 사용자가 `' + invoke + '` 뒤에 쓴 글이다.\n\n';
  return `---\nname: ${name}\ndescription: ${desc ? desc[1] : '""'}\n---\n\n${note}${body}`;
}

module.exports = { commandSkillText };
