#!/usr/bin/env node
'use strict';
/*
 * Version sync guard. Single source of truth = .claude-plugin/plugin.json `version`.
 * Usage:
 *   node scripts/sync-version.js          # sync package.json version <- plugin.json
 *   node scripts/sync-version.js --check  # exit 1 if mismatch (used by prepublishOnly)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pluginPath = path.join(root, '.claude-plugin', 'plugin.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
const sot = plugin.version; // authoritative
const check = process.argv.includes('--check');

if (pkg.version === sot) {
  console.log(`version in sync: ${sot}`);
  process.exit(0);
}
if (check) {
  console.error(`VERSION MISMATCH: package.json ${pkg.version} != plugin.json ${sot} (source of truth).`);
  console.error('Fix: node scripts/sync-version.js');
  process.exit(1);
}
pkg.version = sot;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`synced package.json version -> ${sot}`);
