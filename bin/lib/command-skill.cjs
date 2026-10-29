'use strict';
/*
 * A command (commands/<name>.md) as a Codex skill. Codex 0.144+ has no custom prompts, so each command is also a skill.
 * Two installs use it:
 *  - npm (banker setup --codex): writes <CODEX_HOME>/skills/banker-<name>/SKILL.md, invoked as $banker-<name>.
 *  - Codex plugin (codex plugin add banker@banker-plugins): scripts/sync-codex-plugin.js writes
 *    codex/command-skills/<name>/SKILL.md in the repo, invoked as $banker:<name>.
 * The command's description becomes the skill's, or the manifest's codexDescription when it has one. Skills Codex
 * names apart (codex/manifest.json codexName: setup-omc is setup-omx there) take their Codex name in the body: whole
 * names only, so omc-patch, payload-mon and .omc/ paths stay. Codex skills get no $ARGUMENTS substitution, so a note
 * says where the arguments come from.
 */
function codexNames(text, rename) {
  const keys = Object.keys(rename || {}).sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_-])`, 'g');
  return text.replace(re, (k) => rename[k]);
}

function commandSkillText(text, name, invoke, { description, rename } = {}) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const desc = fm && fm[1].match(/^description:\s*(.*)$/m);
  const body = codexNames(fm ? text.slice(fm[0].length) : text, rename);
  const note = '> Codex: 이 명령은 스킬로 설치됐다. 본문의 `$ARGUMENTS`, `$1` 은 사용자가 `' + invoke + '` 뒤에 쓴 글이다.\n\n';
  const line = description ? JSON.stringify(description) : (desc ? desc[1] : '""');
  return `---\nname: ${name}\ndescription: ${line}\n---\n\n${note}${body}`;
}

// A SKILL.md with its frontmatter name set (added first when missing) and, when given, its description: only those
// two lines change, and the file's line ends stay. The description is written as a JSON string, which YAML reads as a
// double-quoted one. A file without frontmatter comes back as it is.
function codexFrontmatter(src, name, description) {
  const fm = src.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---/);
  if (!fm) return src;
  let block = fm[2];
  block = /^name:.*$/m.test(block) ? block.replace(/^name:.*$/m, () => `name: ${name}`) : `name: ${name}${fm[1]}${block}`;
  if (description) block = block.replace(/^description:.*$/m, () => `description: ${JSON.stringify(description)}`);
  return `${src.slice(0, fm.index)}---${fm[1]}${block}${fm[3]}---${src.slice(fm.index + fm[0].length)}`;
}

module.exports = { commandSkillText, codexNames, codexFrontmatter };
