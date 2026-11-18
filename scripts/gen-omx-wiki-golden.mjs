#!/usr/bin/env node
/*
 * Dev-only: write the golden fixtures skills/append_wiki/wiki-omx.test.mjs compares wiki.mjs --profile=omx with, by
 * running the cases of scripts/test-fixtures/omx-wiki-cases.mjs through an installed OMX package: the scenarios through
 * `omx wiki`'s own handler (dist/cli/mcp-parity.js, in process with a frozen clock), the CLI cases through its real
 * command (dist/cli/omx.js wiki ...). The test reads only the fixtures, so it runs where OMX is absent. Rerun this when
 * the cases change or to hold wiki.mjs to a newer OMX (then rename the fixture folder and FIXTURE_DIR with it).
 *
 * Usage: node scripts/gen-omx-wiki-golden.mjs [<OMX package folder>]
 *   default: BANKER_OMX_DIR, else oh-my-codex in the global npm folder beside this node
 * Writes scripts/test-fixtures/omx-wiki-0.20.2/{golden,cli}.json. Works in temp folders only, with a temp HOME.
 */
import fs from 'node:fs';
import path from 'node:path';

import { caseEnv, digest, makeBase, makeProject } from './test-fixtures/omc-wiki-cases.mjs';
import { CLI_STEPS, FIXTURE_DIR, SCENARIOS, findOmxDir, runCli, runScenarioChild } from './test-fixtures/omx-wiki-cases.mjs';

const omxDir = path.resolve(process.argv[2] || findOmxDir() || 'oh-my-codex-not-found');
for (const need of ['dist/cli/mcp-parity.js', 'dist/cli/omx.js', 'dist/wiki/storage.js', 'node_modules/@modelcontextprotocol/sdk']) {
  if (!fs.existsSync(path.join(omxDir, ...need.split('/')))) {
    console.error(`not an installed OMX package (no ${need}): ${omxDir}`);
    process.exit(2);
  }
}
const version = JSON.parse(fs.readFileSync(path.join(omxDir, 'package.json'), 'utf8')).version;
const base = makeBase('banker-omxwikigold-');

try {
  const scenarios = {};
  for (const name of Object.keys(SCENARIOS)) {
    const cwd = makeProject(base, name);
    scenarios[name] = { digest: digest(SCENARIOS[name]), ...runScenarioChild(`omx=${omxDir}`, name, { cwd, env: caseEnv(base) }) };
  }
  const cwd = makeProject(base, 'cli');
  const cli = { digest: digest(CLI_STEPS), steps: runCli([path.join(omxDir, 'dist', 'cli', 'omx.js'), 'wiki'], [], { cwd, env: caseEnv(base) }) };
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const source = `OMX ${version}, written by scripts/gen-omx-wiki-golden.mjs`;
  // A BOM a seeded page starts with is written as the JSON escape \ufeff, so the fixture holds no hidden character.
  const json = (data) => JSON.stringify({ source, ...data }, null, 1).replace(/\uFEFF/g, '\\ufeff');
  const write = (file, data) => fs.writeFileSync(path.join(FIXTURE_DIR, file), `${json(data)}\n`);
  write('golden.json', { scenarios });
  write('cli.json', cli);
  console.log(`wrote ${FIXTURE_DIR} from ${source}: ${Object.keys(scenarios).length} scenarios, ${CLI_STEPS.length} CLI steps`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
