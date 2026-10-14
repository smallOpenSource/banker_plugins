#!/usr/bin/env node
'use strict';
/*
 * Shared-module sync guard. banker skills are installed (Claude and Codex) as separate folders, so a
 * module two skills use is kept as a byte-identical copy in each. Each pair names its source of truth:
 *   3d-intro-build/references: azure-adapter.mjs, video-pool.mjs     -> 3d-intro-setup      (Azure image + Sora, WAN key pool)
 *   3d-intro-build/references: preview-lib.mjs, serve.mjs, curate.mjs -> motion-graphic-make (local servers, review page)
 *   3d-intro-build/references: preview-lib.mjs, serve.mjs             -> ultra-chain         (local server for the mock and the report)
 *   tone-compact/scripts: instruction-toggle.mjs                      -> anti-drm            (rules on and off for Claude Code and Codex)
 * Usage:
 *   node scripts/sync-adapter.js          # copy canonical -> mirror (byte-identical)
 *   node scripts/sync-adapter.js --check  # exit 1 if any pair differs
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const MIRRORS = [
  { from: '3d-intro-build/references', to: '3d-intro-setup/references', files: ['azure-adapter.mjs', 'video-pool.mjs'] },
  { from: '3d-intro-build/references', to: 'motion-graphic-make/references', files: ['preview-lib.mjs', 'serve.mjs', 'curate.mjs'] },
  { from: '3d-intro-build/references', to: 'ultra-chain/references', files: ['preview-lib.mjs', 'serve.mjs'] },
  { from: 'tone-compact/scripts', to: 'anti-drm/scripts', files: ['instruction-toggle.mjs'] },
];
const check = process.argv.includes('--check');

let failed = false;
for (const { from, to, file } of MIRRORS.flatMap((m) => m.files.map((f) => ({ from: m.from, to: m.to, file: f })))) {
  const skill = to.split('/')[0];
  const canonicalPath = path.join(root, 'skills', ...from.split('/'), file);
  const mirrorPath = path.join(root, 'skills', ...to.split('/'), file);

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
