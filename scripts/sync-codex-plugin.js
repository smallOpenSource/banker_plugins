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
 * Codex keeps a hook's trust by the hash of its command, so each command carries a hash of the files the hooks run
 * (hooksRev): a change to those files changes the command, and Codex asks again in /hooks before it runs the new code.
 * Usage:
 *   node scripts/sync-codex-plugin.js          # write codex/command-skills from commands/, and codex/hooks.json
 *   node scripts/sync-codex-plugin.js --check  # exit 1 if a command skill, the hooks file, or the plugin's skill set drifts
 */
const crypto = require('crypto');
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
  + 'Codex runs them only after you trust them in /hooks, and outside its sandbox: each command runs the node PATH names (a multicall shim '
  + 'such as Volta or mise, or a .cmd shim on Windows: the node binary it names) only when its real path is absolute and outside the temp '
  + 'folder and the session folder (a session in the home folder itself excepted), from the plugin folder, and otherwise says why it '
  + 'skipped. Each command starts with a hash of the hook files (banker-hooks-rev), so new hook code asks for trust again. command is '
  + 'for sh, commandWindows for PowerShell; PLUGIN_ROOT is the installed plugin folder.';

// The files a hook runs: the scripts HOOKS names, run.cjs, and what they load or start, found by following relative
// imports and requires and the sibling script names they spell (update-notify starts update-fetch.mjs or
// update-checkin.mjs by name). Repo-relative, with forward slashes, sorted.
function hookFiles(read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel) || !fs.existsSync(path.join(root, rel))) return;
    seen.add(rel);
    const text = read(rel);
    const dir = path.posix.dirname(rel);
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(path.posix.normalize(path.posix.join(dir, m[1])));
    for (const m of text.matchAll(/['"]([A-Za-z0-9_-]+\.(?:mjs|cjs|js))['"]/g)) visit(path.posix.join(dir, m[1]));
  };
  visit('hooks/run.cjs');
  for (const [, , script] of HOOKS) visit(`hooks/${script}`);
  return [...seen].sort();
}

// The hash the commands carry: of each hook file's path and text, line ends made LF so a Windows checkout agrees.
function hooksRev(read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')) {
  const h = crypto.createHash('sha256');
  for (const rel of hookFiles(read)) h.update(`${rel}\0${read(rel).replace(/\r\n/g, '\n')}\0`);
  return h.digest('hex').slice(0, 12);
}

// sh. Which node runs, outside the sandbox:
// - node from PATH, absolute, resolved to its real path.
// - A real path named node (nvm, fnm, Homebrew, system, an asdf shim script) runs as it is. Another name is a multicall
//   shim that reads its argv0 (Volta, mise, snap): it is asked, from the plugin folder, for the node binary it runs, and
//   that binary runs (the asking runs that node once before its own path is checked; the shim and its link are checked
//   first). Every path run or asked must be outside the real /tmp, TMPDIR and the session folder (pwd -P),
//   which the sandbox can write; a session folder that is the home folder itself is no workspace here (nvm keeps node
//   under ~/.nvm, and a sandbox writing the home can already change the shell's rc files and that node).
// - Nothing else the command runs is found in those folders either: once node is found, PATH keeps only absolute
//   entries outside them, so realpath, readlink, and whatever a shim starts come from elsewhere (a project .venv/bin
//   or node_modules/.bin on PATH would otherwise lend a planted realpath). A PATH left empty becomes /usr/bin:/bin (bash
//   reads an empty PATH as the current folder), and the command moves to the plugin folder before running anything
//   found on it. Before that only shell builtins run, and the refusal notice takes tr from the system's default PATH
//   (command -p).
// - From the plugin folder, so a version manager reads no version file of the session folder; the hook scripts take
//   that folder from their input.
// - The real path comes from realpath, else readlink -f, else (macOS before 12.3 has neither) by following the links
//   one readlink at a time, at most 40.
// - A Codex started from the macOS desktop gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), without the shell's.
//   With no node on PATH, the node Homebrew (/opt/homebrew/bin) or the nodejs.org installer (/usr/local/bin) puts there
//   is taken, under the same checks. A node kept elsewhere (nvm) is not guessed: the refusal names the likely cause.
// A refusal says why and exits 0: as a systemMessage for SessionStart (shown in the TUI), on stderr otherwise.
const NODE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
function shCommand(script, args, viaRun, notice = false, rev = '', nodeDirs = NODE_DIRS) {
  const run = viaRun ? ' "$PLUGIN_ROOT/hooks/run.cjs"' : '';
  const say = notice
    ? String.raw`m=$(printf '%s' "banker hooks skipped: $1" | command -p tr -d '\000-\037"\\'); printf '{"systemMessage":"%s"}\n' "$m"`
    : String.raw`printf '%s\n' "banker hooks skipped: $1" >&2`;
  return (rev ? `: banker-hooks-rev ${rev}; ` : '')
    + String.raw`x() { ${say}; exit 0; }; [ -n "$PLUGIN_ROOT" ] || x "PLUGIN_ROOT is not set"; `
    + String.raw`p=$(pwd -P); [ -n "$p" ] && [ "$p" != / ] || x "the session folder is /"; `
    + 'u=$(cd /tmp 2>/dev/null && pwd -P); t=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P); '
    + String.raw`h=; case "$HOME" in /?*) h=$(cd "$HOME" 2>/dev/null && pwd -P);; esac; `
    + String.raw`w() { for z in "$u" "$t"; do [ -n "$z" ] && case "$1/" in "$z"/*) return 0;; esac; done; [ "$p" = "$h" ] && return 1; case "$1/" in "$p"/*) return 0;; esac; return 1; }; `
    + `n=$(command -v node) || for d in ${nodeDirs.join(' ')}; do [ -x "$d/node" ] && n=$d/node && break; done; `
    + String.raw`[ -n "$n" ] || x "node is not on PATH (a Codex started from the desktop may not have the shell's PATH)"; case "$n" in /*) ;; *) x "node on PATH is not an absolute path ($n)";; esac; `
    + 'set -f; o=$IFS; IFS=:; q=; for v in $PATH; do case "$v" in /*) ;; *) continue;; esac; y=$(cd "$v" 2>/dev/null && pwd -P) || continue; '
    + 'w "$y" || q=$q${q:+:}$v; done; IFS=$o; set +f; PATH=${q:-/usr/bin:/bin}; export PATH; '
    + String.raw`cd "$PLUGIN_ROOT" || x "cannot enter the plugin folder"; `
    + String.raw`rp() { realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || { f=$1; i=0; while [ -L "$f" ]; do i=$((i+1)); [ "$i" -le 40 ] || return 1; `
    + 'l=$(readlink "$f") || return 1; case "$l" in /*) f=$l;; *) f=${f%/*}/$l;; esac; done; [ -e "$f" ] || return 1; '
    + 'd=$(cd -P "${f%/*}/" 2>/dev/null && pwd -P) || return 1; printf \'%s\\n\' "${d%/}/${f##*/}"; }; }; '
    + String.raw`r=$(rp "$n") || x "cannot resolve the real path of $n"; `
    + String.raw`k() { case "$1" in /*) ;; *) x "node path is not absolute ($1)";; esac; for d in "$u" "$t"; do [ -n "$d" ] && case "$1" in "$d"/*) x "node is in a temp folder ($1)";; esac; done; `
    + String.raw`[ "$p" = "$h" ] || case "$1" in "$p"/*) x "node is in the session folder ($1)";; esac; }; `
    + `case "\${r##*/}" in node) k "$r"; e=$r;; *) k "$n"; k "$r"; e=$("$n" -p 'require("fs").realpathSync(process.execPath)' 2>/dev/null) || x "the node shim $n did not name its node"; k "$e";; esac; `
    + `"$e"${run} "$PLUGIN_ROOT/hooks/${script}"${args.map((a) => ` ${a}`).join('')}`;
}

// PowerShell (Windows): the first node.exe, node.bat or node.cmd on PATH (in PATHEXT's order within a folder), looked
// for only in local drive folders: a network drive or UNC entry is neither searched nor kept. A .cmd or .bat shim (mise) is asked, from the
// plugin folder, for the node.exe it runs, and that runs, as the sh command asks a multicall shim. Every path run or
// asked is refused under TEMP, TMP, LOCALAPPDATA\Temp or the session folder (unless that is USERPROFILE itself: nvm-windows
// and Volta keep node under it). Once node is found, PATH keeps only absolute entries outside those folders, so what a
// shim starts by name (cmd.exe looks mise up on PATH) comes from elsewhere. Paths are compared in their long form
// (Get-Item, so an 8.3 name such as C:\Users\LONGNA~1 in TEMP still matches) with symbolic links and junctions on the
// way followed, and a subst drive written as the folder it stands for, as the sh command compares real paths. A hard
// link is not followed: its other name is the same file. Network entries (a mapped network drive, \\server\share) are
// never read, so a share that does not answer cannot hold the hook past Codex's limit; subst.exe is found through the
// system folder the API names, not an environment variable. (The sh command reads every PATH entry as the shell itself
// does when it looks up a command; a mount that does not answer holds it until Codex's limit ends the hook.) A refusal says why, as for sh (English: Windows PowerShell 5.1
// garbles other letters in a command line).
function psCommand(script, args, viaRun, notice = false, rev = '') {
  const run = viaRun ? ' "$env:PLUGIN_ROOT\\hooks\\run.cjs"' : '';
  const say = notice
    ? 'Write-Output (ConvertTo-Json -Compress @{ systemMessage = "banker hooks skipped: $m" })'
    : '[Console]::Error.WriteLine("banker hooks skipped: $m")';
  return (rev ? `$null = 'banker-hooks-rev ${rev}'; ` : '')
    + `function x($m) { ${say}; exit 0 }; if (-not $env:PLUGIN_ROOT) { x 'PLUGIN_ROOT is not set' }; `
    + String.raw`function G($p) { try { (Get-Item -LiteralPath $p -Force -ErrorAction Stop).FullName } catch { try { [IO.Path]::GetFullPath($p) } catch { $p } } }; `
    + String.raw`$sb = @{}; foreach ($l in @(& (Join-Path ([Environment]::SystemDirectory) 'subst.exe') 2>$null)) { if ($l -match '^([A-Za-z]:)\\: => (.+)$') { $sb[$matches[1].ToUpper()] = $matches[2] } }; `
    + String.raw`function L($p) { if (-not $p) { return '' }; $p = G $p; for ($i = 0; $i -lt 32; $i++) { $d2 = if ($p.Length -ge 2) { $p.Substring(0, 2).ToUpper() } else { '' }; if ($sb.Contains($d2)) { $p = G ($sb[$d2].TrimEnd('\') + $p.Substring(2)); continue }; $c = $p; $t = $null; `
    + String.raw`while ($c) { $it = Get-Item -LiteralPath $c -Force -ErrorAction SilentlyContinue; if ($it -and $it.LinkType -in 'SymbolicLink', 'Junction' -and @($it.Target)[0]) { $t = [string]@($it.Target)[0]; break }; $c = Split-Path -LiteralPath $c }; `
    + String.raw`if (-not $t) { break }; if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path -LiteralPath $c) $t }; $p = G ($t.TrimEnd('\') + $p.Substring($c.Length)) }; $p.TrimEnd('\') }; `
    + String.raw`$ds = @($env:TEMP, $env:TMP); if ($env:LOCALAPPDATA) { $ds += "$env:LOCALAPPDATA\Temp" }; $w = L $PWD.Path; if ($w -ne (L $env:USERPROFILE)) { $ds += $w }; `
    + String.raw`$ds = @($ds | Where-Object { $_ } | ForEach-Object { L $_ } | Where-Object { $_ }); `
    + String.raw`function u($f) { $f = L $f; foreach ($d in $ds) { if ($f -eq $d -or $f.StartsWith($d + '\', 'OrdinalIgnoreCase')) { return $true } }; $false }; `
    + String.raw`function k($f) { if (u $f) { x "node is in a temp folder or the session folder ($(L $f))" }; L $f }; `
    + String.raw`$nd = @(@($env:PATH -split ';') | Where-Object { $_ -match '^[A-Za-z]:\\' -and ([IO.DriveInfo]::new($_.Substring(0, 1))).DriveType -ne 'Network' }); `
    + String.raw`$n = $null; foreach ($d in $nd) { foreach ($e in 'node.exe', 'node.bat', 'node.cmd') { $f = Join-Path $d $e; if (Test-Path -LiteralPath $f -PathType Leaf) { $n = $f; break } }; if ($n) { break } }; `
    + "if (-not $n) { x 'node is not on PATH' }; "
    + String.raw`$env:PATH = ($nd | Where-Object { -not (u $_) }) -join ';'; `
    + "$r = k $n; "
    + "if (-not (Set-Location -LiteralPath $env:PLUGIN_ROOT -PassThru -ErrorAction SilentlyContinue)) { x 'cannot enter the plugin folder' }; "
    + String.raw`if ($r -notmatch '\.exe$') { $e = & $r -p process.execPath 2>$null | Select-Object -Last 1; `
    + String.raw`if (-not $e -or $e -notmatch '\.exe$' -or -not (Test-Path -LiteralPath $e -PathType Leaf)) { x "the node shim $r did not name its node" }; $r = k $e }; `
    + `& $r${run} "$env:PLUGIN_ROOT\\hooks\\${script}"${args.map((a) => ` ${a}`).join('')}`;
}

function hooksText() {
  const doc = { description: HOOKS_NOTE, hooks: {} };
  const rev = hooksRev();
  for (const [ev, matcher, script, args, viaRun] of HOOKS) {
    doc.hooks[ev] = [{ ...(matcher ? { matcher } : {}), hooks: [{
      type: 'command', command: shCommand(script, args, viaRun, ev === 'SessionStart', rev), commandWindows: psCommand(script, args, viaRun, ev === 'SessionStart', rev), timeout: 5,
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

module.exports = { commandSkills, pluginProblems, hooksText, hookFiles, hooksRev, shCommand, psCommand, SKILL_DIRS, HOOKS_FILE };
