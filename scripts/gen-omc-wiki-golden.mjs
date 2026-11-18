#!/usr/bin/env node
/*
 * Dev-only: write the golden fixtures skills/append_wiki/wiki.test.mjs compares wiki.mjs with, by running the cases
 * of scripts/test-fixtures/omc-wiki-cases.mjs through an intact OMC plugin folder (its dist/ and node_modules/).
 * The test reads only the fixtures, so it runs where OMC is absent. Rerun this when the cases change or to hold
 * wiki.mjs to a newer OMC (then rename the fixture folder and the test's FIXTURE_DIR with it).
 *
 * Usage: node scripts/gen-omc-wiki-golden.mjs [<OMC plugin folder>]
 *   default: ~/.claude/plugins/cache/omc/oh-my-claudecode/5.8.4
 * Writes scripts/test-fixtures/omc-wiki-5.8.4/{golden,locations,validation}.json. Works in temp folders only.
 *
 *        node scripts/gen-omc-wiki-golden.mjs --check [<OMC plugin folder>]
 *   default: the newest intact version folder in the plugin cache. Writes nothing: compares that OMC's answers with
 *   the fixtures (all but their `source` line) and exits 0 when equal, 1 when OMC now answers differently (wiki.mjs
 *   would then write a format that OMC no longer does), 2 when no intact OMC folder is found. RELEASING.md step 7.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FIXTURE_DIR, LOCATION_CASES, SCENARIOS, VALIDATION, buildLocationLayout, caseCwd, caseEnv, caseExtraEnv, caseWd,
  digest, makeBase, makeProject, normalizeWhere, runChild,
} from './test-fixtures/omc-wiki-cases.mjs';

const NEEDS = ['dist/tools/wiki-tools.js', 'dist/hooks/wiki/storage.js', 'dist/lib/worktree-paths.js', 'node_modules/zod/index.js'];
const CACHE = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
const missingIn = (dir) => NEEDS.find((need) => !fs.existsSync(path.join(dir, ...need.split('/'))));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const byVersion = (a, b) => { const x = a.match(SEMVER), y = b.match(SEMVER); for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +y[i] - +x[i]; return 0; };

// The newest version folder that is a real folder (not a link to another version) and holds what the cases import.
// Newer folders it passes over (no build, a link, unreadable) are named, so an "equal" result is not read as a check
// against the newest OMC when it was not.
function newestIntact() {
  let names;
  try { names = fs.readdirSync(CACHE).filter((n) => SEMVER.test(n)).sort(byVersion); } catch { return null; }
  const skipped = [];
  for (const n of names) {
    const d = path.join(CACHE, n);
    let link;
    try { link = fs.lstatSync(d).isSymbolicLink(); } catch { skipped.push(`${n} (unreadable)`); continue; }
    if (!link && !missingIn(d)) {
      if (skipped.length) console.log(`note: newer version folders are not intact, so this compares with ${n}: ${skipped.join(', ')}`);
      return d;
    }
    if (!link) skipped.push(`${n} (no ${missingIn(d)})`);
  }
  return null;
}

const CHECK = process.argv[2] === '--check';
const given = process.argv[CHECK ? 3 : 2];
const omcDir = given ? path.resolve(given) : CHECK ? newestIntact() : path.join(CACHE, '5.8.4');
if (!omcDir) {
  console.error(`no intact OMC version folder (with ${NEEDS.join(', ')}) in ${CACHE}`);
  process.exit(2);
}
if (missingIn(omcDir)) {
  console.error(`not an intact OMC plugin folder (no ${missingIn(omcDir)}): ${omcDir}`);
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(path.join(omcDir, 'package.json'), 'utf8')).version;
const impl = `omc=${omcDir}`;
const base = makeBase('banker-wikigold-');

try {
  const scenarios = {};
  for (const name of Object.keys(SCENARIOS)) {
    const cwd = makeProject(base, name);
    scenarios[name] = { digest: digest(SCENARIOS[name]), ...runChild('scenario', impl, name, { cwd, env: caseEnv(base) }) };
  }
  const locBase = path.join(base, 'loc');
  fs.mkdirSync(locBase);
  buildLocationLayout(locBase);
  const locations = LOCATION_CASES.map((c) => {
    const wd = caseWd(locBase, c);
    const env = caseEnv(locBase, caseExtraEnv(locBase, c));
    const answer = runChild('where', impl, wd === undefined ? undefined : JSON.stringify(wd), { cwd: caseCwd(locBase, c), env });
    return { name: c[0], ...normalizeWhere(locBase, answer) };
  });
  const validation = { digest: digest(VALIDATION), ok: runChild('validate', impl, undefined, { cwd: base, env: caseEnv(base) }) };
  if (CHECK) process.exitCode = compare({ 'golden.json': { scenarios }, 'locations.json': { cases: locations }, 'validation.json': validation });
  else writeAll(scenarios, locations, validation);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

// --check: the fixtures without their source line against what this OMC answers now. Names the parts that differ.
function compare(now) {
  const differ = [];
  for (const [file, data] of Object.entries(now)) {
    const { source, ...kept } = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
    for (const key of new Set([...Object.keys(kept), ...Object.keys(data)])) {
      const was = kept[key], is = JSON.parse(JSON.stringify(data[key] ?? null));
      if (key === 'scenarios' || key === 'cases') {
        const name = (x, i) => (key === 'cases' ? x.name : i);
        const list = (v) => (key === 'cases' ? Object.fromEntries((v || []).map((x, i) => [name(x, i), x])) : v || {});
        const [a, b] = [list(was), list(is)];
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) differ.push(`${file} ${key} ${k}`);
      } else if (JSON.stringify(was) !== JSON.stringify(is)) differ.push(`${file} ${key}`);
    }
  }
  if (!differ.length) { console.log(`OMC ${version} (${omcDir}) answers as the fixtures: wiki.mjs still writes its format`); return 0; }
  console.log(`OMC ${version} (${omcDir}) answers differently from the fixtures (${FIXTURE_DIR}):`);
  for (const d of differ) console.log(`  ${d}`);
  console.log('Compare the new OMC wiki code (src/hooks/wiki, src/tools/wiki-tools.ts) and bring wiki.mjs to it, then regenerate.');
  return 1;
}

function writeAll(scenarios, locations, validation) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const source = `OMC ${version}, written by scripts/gen-omc-wiki-golden.mjs`;
  const write = (file, data) => fs.writeFileSync(path.join(FIXTURE_DIR, file), `${JSON.stringify({ source, ...data }, null, 1)}\n`);
  write('golden.json', { scenarios });
  write('locations.json', { cases: locations });
  write('validation.json', validation);
  console.log(`wrote ${FIXTURE_DIR} from ${source}: ${Object.keys(scenarios).length} scenarios, ${locations.length} locations, ${VALIDATION.length} inputs`);
}
