#!/usr/bin/env node
'use strict';
/*
 * Adapter sync guard. Single source of truth = the BUILD copies of the shared 3d-intro modules.
 * Mirrors each one, byte-identical, to the SETUP skill so both skills ship the same code.
 *   canonical: skills/3d-intro-build/references/<file>
 *   mirror:    skills/3d-intro-setup/references/<file>
 *   files:     azure-adapter.mjs (Azure image + Sora), video-pool.mjs (WAN key pool -> Sora fallback)
 * Usage:
 *   node scripts/sync-adapter.js          # copy canonical -> mirror (byte-identical)
 *   node scripts/sync-adapter.js --check  # exit 1 if any pair differs (used in CI/prepublish)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const FILES = ['azure-adapter.mjs', 'video-pool.mjs'];
const check = process.argv.includes('--check');

let failed = false;
for (const file of FILES) {
  const canonicalPath = path.join(root, 'skills', '3d-intro-build', 'references', file);
  const mirrorPath = path.join(root, 'skills', '3d-intro-setup', 'references', file);

  if (!fs.existsSync(canonicalPath)) {
    console.error(`ADAPTER SOURCE MISSING: ${path.relative(root, canonicalPath)} (source of truth).`);
    failed = true;
    continue;
  }

  const canonical = fs.readFileSync(canonicalPath);
  const mirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath) : null;
  const inSync = mirror !== null && canonical.equals(mirror);

  if (check) {
    if (inSync) {
      console.log(`${file} in sync`);
    } else {
      console.error(`ADAPTER MISMATCH: ${path.relative(root, mirrorPath)} != ${path.relative(root, canonicalPath)} (source of truth).`);
      console.error('Fix: node scripts/sync-adapter.js');
      failed = true;
    }
    continue;
  }

  if (inSync) {
    console.log(`${file} already in sync`);
    continue;
  }
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(mirrorPath, canonical);
  console.log(`synced ${file} -> ${path.relative(root, mirrorPath)}`);
}
process.exit(failed ? 1 : 0);
