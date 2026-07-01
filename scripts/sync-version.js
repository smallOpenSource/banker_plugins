#!/usr/bin/env node
'use strict';
/*
 * Version sync guard. Single source of truth = .claude-plugin/plugin.json `version`.
 * Propagates to package.json `version` and .claude-plugin/marketplace.json `metadata.version`.
 * Usage:
 *   node scripts/sync-version.js          # sync the targets <- plugin.json
 *   node scripts/sync-version.js --check  # exit 1 if any target drifts (used by prepublishOnly)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pluginPath = path.join(root, '.claude-plugin', 'plugin.json');
const pkgPath = path.join(root, 'package.json');
const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');

const sot = JSON.parse(fs.readFileSync(pluginPath, 'utf8')).version; // authoritative
const check = process.argv.includes('--check');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const market = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));

const targets = [
  { name: 'package.json', path: pkgPath, obj: pkg, get: (o) => o.version, set: (o, v) => { o.version = v; } },
  { name: 'marketplace.json', path: marketplacePath, obj: market,
    get: (o) => o.metadata && o.metadata.version,
    set: (o, v) => { o.metadata = o.metadata || {}; o.metadata.version = v; } },
];

const drift = targets.filter((t) => t.get(t.obj) !== sot);
if (drift.length === 0) {
  console.log(`version in sync: ${sot}`);
  process.exit(0);
}
if (check) {
  for (const t of drift) console.error(`VERSION MISMATCH: ${t.name} ${t.get(t.obj)} != plugin.json ${sot} (source of truth).`);
  console.error('Fix: node scripts/sync-version.js');
  process.exit(1);
}
for (const t of drift) {
  t.set(t.obj, sot);
  fs.writeFileSync(t.path, JSON.stringify(t.obj, null, 2) + '\n');
  console.log(`synced ${t.name} version -> ${sot}`);
}
