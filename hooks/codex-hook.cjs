#!/usr/bin/env node
'use strict';
/*
 * The node side of the Codex plugin's Windows hook commands (scripts/sync-codex-plugin.js psCommand):
 *   node codex-hook.cjs [--notice] <hook script> [args...]
 * PowerShell has already judged node and the plugin folder this file is in (their real paths are outside TEMP, TMP,
 * LOCALAPPDATA\Temp and the session folder) and starts node in the plugin folder, naming the session folder in
 * BANKER_HOOK_SESSION. Here node and the hook script are judged once more by their real paths (realpathSync.native writes
 * an 8.3 name long, follows links and junctions, and writes a subst drive as its folder), PATH keeps only the entries
 * outside those folders, so what a hook starts by name comes from elsewhere, and the hook script runs in this node, from
 * the plugin folder, with process.argv as if node had run it: one node process instead of two (run.cjs starts another).
 * A refusal or a hook that cannot load says why and exits 0: as a systemMessage with --notice (SessionStart), on stderr
 * otherwise.
 * PowerShell does no more because a slow Windows PC pays for each cmdlet and process, and Codex counts that within the
 * hook's time limit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
};
const under = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
};

// The folders the sandbox can write: the temp folders and the session folder, unless that is the home folder itself.
function unsafeDirs(env = process.env, cwd = process.cwd(), tmp = os.tmpdir()) {
  const dirs = [tmp, env.TEMP, env.TMP, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Temp')].filter(Boolean).map(real);
  const work = real(cwd);
  if (work.toLowerCase() !== real(env.USERPROFILE || os.homedir()).toLowerCase()) dirs.push(work);
  return dirs;
}

// PATH without the entries under those folders (empty entries dropped too).
function cleanPath(value, dirs) {
  return String(value || '').split(path.delimiter).filter((p) => p && !dirs.some((d) => under(real(p), d))).join(path.delimiter);
}

function say(notice, message) {
  const m = `banker hooks skipped: ${message}`;
  if (notice) process.stdout.write(JSON.stringify({ systemMessage: m }));
  else process.stderr.write(`${m}\n`);
  process.exit(0);
}

function main() {
  const notice = process.argv[2] === '--notice';
  const [script, ...args] = process.argv.slice(notice ? 3 : 2);
  if (!script) process.exit(0);
  const session = process.env.BANKER_HOOK_SESSION || process.cwd();
  delete process.env.BANKER_HOOK_SESSION;
  const dirs = unsafeDirs(process.env, session);
  const file = real(script);
  const node = real(process.execPath);
  for (const [what, p] of [['node', node], ['the hook script', file]]) {
    if (dirs.some((d) => under(p, d))) say(notice, `${what} is in a temp folder or the session folder (${p})`);
  }
  process.env.PATH = cleanPath(process.env.PATH, dirs);
  process.argv = [process.argv[0], file, ...args];
  process.chdir(path.dirname(path.dirname(file)));
  return import(pathToFileURL(file).href).catch((e) => say(notice, `cannot run ${path.basename(file)} (${e?.code || e?.message || e})`));
}

if (require.main === module) main();

module.exports = { cleanPath, unsafeDirs, under };
