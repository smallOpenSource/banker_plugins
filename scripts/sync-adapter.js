#!/usr/bin/env node
'use strict';
/*
 * Adapter sync guard. Single source of truth = the BUILD copy of the shared Azure adapter.
 * Mirrors it, byte-identical, to the SETUP copy so both skills ship the same code.
 *   canonical: skills/3d-intro-build/references/azure-adapter.mjs
 *   mirror:    skills/3d-intro-setup/references/azure-adapter.mjs
 * Usage:
 *   node scripts/sync-adapter.js          # copy canonical -> mirror (byte-identical)
 *   node scripts/sync-adapter.js --check  # exit 1 if the two differ (used in CI/prepublish)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(root, 'skills', '3d-intro-build', 'references', 'azure-adapter.mjs');
const mirrorPath = path.join(root, 'skills', '3d-intro-setup', 'references', 'azure-adapter.mjs');

const check = process.argv.includes('--check');

if (!fs.existsSync(canonicalPath)) {
  console.error(`ADAPTER SOURCE MISSING: ${path.relative(root, canonicalPath)} (source of truth).`);
  process.exit(1);
}

const canonical = fs.readFileSync(canonicalPath);
const mirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath) : null;
const inSync = mirror !== null && canonical.equals(mirror);

if (check) {
  if (inSync) {
    console.log('adapter in sync');
    process.exit(0);
  }
  console.error(`ADAPTER MISMATCH: ${path.relative(root, mirrorPath)} != ${path.relative(root, canonicalPath)} (source of truth).`);
  console.error('Fix: node scripts/sync-adapter.js');
  process.exit(1);
}

if (inSync) {
  console.log('adapter already in sync');
  process.exit(0);
}

fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
fs.writeFileSync(mirrorPath, canonical);
console.log(`synced adapter -> ${path.relative(root, mirrorPath)}`);
