#!/usr/bin/env node
'use strict';
/*
 * Shared-module sync guard. Single source of truth = the BUILD copies in
 * skills/3d-intro-build/references/. Each listed file is mirrored, byte-identical, into the other
 * skill that ships it, because banker skills are installed (Claude and Codex) as separate folders.
 *   azure-adapter.mjs, video-pool.mjs     -> 3d-intro-setup      (Azure image + Sora, WAN key pool)
 *   preview-lib.mjs, serve.mjs, curate.mjs -> motion-graphic-make (local servers, review page)
 * Usage:
 *   node scripts/sync-adapter.js          # copy canonical -> mirror (byte-identical)
 *   node scripts/sync-adapter.js --check  # exit 1 if any pair differs (used in CI/prepublish)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const MIRRORS = [
  { skill: '3d-intro-setup', files: ['azure-adapter.mjs', 'video-pool.mjs'] },
  { skill: 'motion-graphic-make', files: ['preview-lib.mjs', 'serve.mjs', 'curate.mjs'] },
];
const check = process.argv.includes('--check');

let failed = false;
for (const { skill, file } of MIRRORS.flatMap((m) => m.files.map((f) => ({ skill: m.skill, file: f })))) {
  const canonicalPath = path.join(root, 'skills', '3d-intro-build', 'references', file);
  const mirrorPath = path.join(root, 'skills', skill, 'references', file);

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
      console.log(`${file} in sync (${skill})`);
    } else {
      console.error(`ADAPTER MISMATCH: ${path.relative(root, mirrorPath)} != ${path.relative(root, canonicalPath)} (source of truth).`);
      console.error('Fix: node scripts/sync-adapter.js');
      failed = true;
    }
    continue;
  }

  if (inSync) {
    console.log(`${file} already in sync (${skill})`);
    continue;
  }
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(mirrorPath, canonical);
  console.log(`synced ${file} -> ${path.relative(root, mirrorPath)}`);
}
process.exit(failed ? 1 : 0);
