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
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FIXTURE_DIR, LOCATION_CASES, SCENARIOS, VALIDATION, buildLocationLayout, caseCwd, caseEnv, caseExtraEnv, caseWd,
  digest, makeBase, makeProject, normalizeWhere, runChild,
} from './test-fixtures/omc-wiki-cases.mjs';

const omcDir = path.resolve(process.argv[2] || path.join(os.homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.4'));
for (const need of ['dist/tools/wiki-tools.js', 'dist/hooks/wiki/storage.js', 'dist/lib/worktree-paths.js', 'node_modules/zod/index.js']) {
  if (!fs.existsSync(path.join(omcDir, ...need.split('/')))) {
    console.error(`not an intact OMC plugin folder (no ${need}): ${omcDir}`);
    process.exit(2);
  }
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
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const source = `OMC ${version}, written by scripts/gen-omc-wiki-golden.mjs`;
  const write = (file, data) => fs.writeFileSync(path.join(FIXTURE_DIR, file), `${JSON.stringify({ source, ...data }, null, 1)}\n`);
  write('golden.json', { scenarios });
  write('locations.json', { cases: locations });
  write('validation.json', validation);
  console.log(`wrote ${FIXTURE_DIR} from ${source}: ${Object.keys(scenarios).length} scenarios, ${locations.length} locations, ${VALIDATION.length} inputs`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
