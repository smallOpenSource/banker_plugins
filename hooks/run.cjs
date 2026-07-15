#!/usr/bin/env node
'use strict';
/*
 * banker cross-platform hook runner.
 *
 * Re-spawns the target hook script with process.execPath — the Node binary already
 * running this file — instead of letting the hook's shell resolve `node` from PATH.
 * nvm/fnm shims and Windows both fail that resolution; OMC hit it in hooks (#909,
 * #899, #892, #869) and answers it with the same pattern.
 *
 * Never blocks a tool: exits 0 whenever it cannot run the target.
 *
 * Usage (hooks.json):
 *   node "$CLAUDE_PLUGIN_ROOT"/hooks/run.cjs "$CLAUDE_PLUGIN_ROOT"/hooks/<hook>.mjs [args...]
 */
const { spawnSync } = require('child_process');
const { existsSync, realpathSync } = require('fs');

const target = process.argv[2];
if (!target) process.exit(0);

function resolveTarget(scriptPath) {
  if (existsSync(scriptPath)) return scriptPath;
  try {
    // A plugin update can leave CLAUDE_PLUGIN_ROOT pointing at a version dir that is now
    // a symlink; realpath follows it.
    const real = realpathSync(scriptPath);
    if (existsSync(real)) return real;
  } catch {
    // realpathSync throws when the path is gone entirely — expected, fall through.
  }
  return null;
}

const resolved = resolveTarget(target);
if (!resolved) process.exit(0);

// stdio: 'inherit' hands our stdin to the child — that is how the hook payload reaches it.
const result = spawnSync(process.execPath, [resolved, ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});

process.exit(result.status ?? 0);
