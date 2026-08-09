#!/usr/bin/env node
'use strict';
/*
 * S6 verification harness (no network). Run: `node scripts/smoke-test.js`.
 * npm pack -> install the tarball into a TEMP prefix + TEMP HOME -> dry-run setup for both
 * targets -> assert planned actions match the manifest (54 skills + 2 command prompts, AGENTS.md
 * untouched, no writes). Exits non-zero on any failed assertion.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) failures++; };
const run = (cmd, args, opts = {}) => cp.execFileSync(cmd, args, { encoding: 'utf8', ...opts });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banker-smoke-'));
const prefix = path.join(tmp, 'prefix');
const home = path.join(tmp, 'home');
fs.mkdirSync(prefix, { recursive: true });
fs.mkdirSync(home, { recursive: true });

try {
  // 1) pack
  const packOut = run('npm', ['pack', '--silent', '--pack-destination', tmp], { cwd: root });
  const tarball = packOut.trim().split('\n').filter(Boolean).pop().trim();
  const tarPath = path.join(tmp, tarball);
  ok(fs.existsSync(tarPath), `npm pack produced ${tarball}`);

  // 2) global install into temp prefix (offline; no deps)
  run('npm', ['i', '-g', '--prefix', prefix, tarPath], { stdio: 'pipe' });
  const binPath = process.platform === 'win32' ? path.join(prefix, 'banker.cmd') : path.join(prefix, 'bin', 'banker');
  ok(fs.existsSync(binPath), `installed banker bin (${path.relative(tmp, binPath)})`);

  const env = { ...process.env, HOME: home, USERPROFILE: home };

  // 3) codex dry-run (project scope)
  const codexOut = run(binPath, ['setup', '--codex', '--scope', 'project', '--dry-run'], { cwd: home, env });
  const copies = (codexOut.match(/\[dry-run\] copy skills\//g) || []).length;
  ok(copies === 54, `codex dry-run plans 54 skill copies (got ${copies})`);
  ok(codexOut.includes('copy skills/obsidizer '), 'codex dry-run includes the new 0.6.0 obsidizer skill (target both)');
  ok(!codexOut.includes('copy skills/deep-interview '), 'deep-interview NOT bundled (already native in OMC+OMX)');
  const cmdCopies = (codexOut.match(/\[dry-run\] copy commands\//g) || []).length;
  ok(cmdCopies === 2, `codex dry-run plans 2 command prompts (got ${cmdCopies})`);
  ok(codexOut.includes('copy skills/setup-insane-search '), 'codex dry-run includes setup-insane-search (target both)');
  ok(codexOut.includes('AGENTS.md is NOT modified'), 'codex states AGENTS.md untouched');

  // 4) claude dry-run (capture stdout+stderr; tolerate absent claude, e.g. CI runners)
  const claudeRes = cp.spawnSync(binPath, ['setup', '--claude', '--dry-run'], { cwd: home, env, encoding: 'utf8' });
  const claudeOut = `${claudeRes.stdout || ''}${claudeRes.stderr || ''}`;
  ok(/marketplace add/.test(claudeOut) && /plugin install banker@banker-plugins/.test(claudeOut) || /claude CLI not found/.test(claudeOut),
     'claude dry-run prints register commands (or notes missing claude)');

  // 5) no writes outside temp
  ok(!fs.existsSync(path.join(home, '.codex')), 'dry-run wrote nothing (no HOME/.codex)');
  ok(!fs.existsSync(path.join(process.cwd(), '.codex')) || process.cwd() === home, 'dry-run created no .codex in repo cwd');

  // 5.5) manifest and skills/ must name the SAME SET. This runs BEFORE the real install below:
  // a manifest entry with no matching directory makes that install throw ENOENT mid-copy, which
  // surfaces as an opaque "HARNESS ERROR: Command failed" and skips every later assertion.
  // Counting alone cannot catch it. The dry-run counter walks the manifest, not the filesystem, so
  // any N manifest lines satisfy it whether or not the directories exist. Naming the set also
  // covers the reverse direction (a skill on disk but absent from the manifest ships to Claude and
  // never to Codex, a silent claude-only skill), which nothing else checked. Keep this assertion
  // instead of appending another per-release hardcoded name array.
  const mfSkillSurfaces = JSON.parse(fs.readFileSync(path.join(root, 'codex', 'manifest.json'), 'utf8'))
    .surfaces.filter((s) => s.type === 'skill');
  const mfSkills = mfSkillSurfaces.map((s) => s.name).sort();
  const diskSkills = fs.readdirSync(path.join(root, 'skills'))
    .filter((d) => fs.existsSync(path.join(root, 'skills', d, 'SKILL.md'))).sort();
  const manifestOnly = mfSkills.filter((n) => !diskSkills.includes(n));
  const diskOnly = diskSkills.filter((n) => !mfSkills.includes(n));
  ok(manifestOnly.length === 0 && diskOnly.length === 0,
     `manifest == skills/ (manifest-only: [${manifestOnly.join(', ')}]; disk-only: [${diskOnly.join(', ')}])`);
  // Every manifest skill must be target:both. A claude-only skill would still pass the set-equality
  // and copies===52 checks (it lives in the manifest and on disk, and the dry-run counts only the
  // 52 both-skills), so nothing above catches a silent claude-only. This replaces the former
  // per-release hardcoded skill-name arrays: they regression-guarded named skills, this guards the
  // universal property (all both) with no per-release edit. Trade-off: a count-preserving name
  // substitution (drop one both-skill, add another) is no longer caught here; set-equality still
  // catches the realistic deletion/duplication cases.
  const claudeOnly = mfSkillSurfaces.filter((s) => s.target !== 'both').map((s) => s.name);
  ok(claudeOnly.length === 0, `every manifest skill is target:both (silent claude-only: [${claudeOnly.join(', ')}])`);

  // 6) REAL codex install into a fresh temp HOME: assert dir==name (Codex discovery) + stale sweep
  const home2 = path.join(tmp, 'home2');
  const staleDir = path.join(home2, '.codex', 'skills', 'banker-STALE');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'SKILL.md'), '---\nname: banker-STALE\n---\n');
  // rename-case guard: seed the OLD name (game-qa -> play-qa) and assert update sweeps it out
  const renamedAwayDir = path.join(home2, '.codex', 'skills', 'banker-game-qa');
  fs.mkdirSync(renamedAwayDir, { recursive: true });
  fs.writeFileSync(path.join(renamedAwayDir, 'SKILL.md'), '---\nname: banker-game-qa\n---\n');
  // rename-case guard 2: setup-stitch-proxy -> setup-stitch
  const renamedStitchDir = path.join(home2, '.codex', 'skills', 'banker-setup-stitch-proxy');
  fs.mkdirSync(renamedStitchDir, { recursive: true });
  fs.writeFileSync(path.join(renamedStitchDir, 'SKILL.md'), '---\nname: banker-setup-stitch-proxy\n---\n');
  const env2 = { ...process.env, HOME: home2, USERPROFILE: home2 };
  run(binPath, ['setup', '--codex', '--scope', 'user'], { cwd: home2, env: env2 });
  const instDir = path.join(home2, '.codex', 'skills');
  const installed = fs.readdirSync(instDir).filter((d) => d.startsWith('banker-'));
  ok(installed.length === 54, `real codex install has 54 banker-* skills (got ${installed.length})`);
  ok(!fs.existsSync(staleDir), 'stale banker-* swept on reinstall (no leftover duplicate)');
  ok(!fs.existsSync(renamedAwayDir), 'renamed-away banker-game-qa swept on update (replaced by play-qa)');
  ok(installed.includes('banker-play-qa'), 'renamed skill installed as banker-play-qa');
  ok(!fs.existsSync(renamedStitchDir), 'renamed-away banker-setup-stitch-proxy swept (replaced by setup-stitch)');
  ok(installed.includes('banker-setup-stitch'), 'renamed skill installed as banker-setup-stitch');
  ok(installed.includes('banker-docs-setup'), 'new docs-setup installed as banker-docs-setup');
  ok(installed.includes('banker-obsidizer'), 'obsidizer installed as banker-obsidizer');
  ok(installed.includes('banker-motion-graphic-setup'), 'new motion-graphic-setup installed as banker-motion-graphic-setup');
  ok(installed.includes('banker-motion-graphic-make'), 'new motion-graphic-make installed as banker-motion-graphic-make');
  ok(installed.includes('banker-3d-intro-setup'), 'new 3d-intro-setup installed as banker-3d-intro-setup');
  ok(installed.includes('banker-3d-intro-build'), 'new 3d-intro-build installed as banker-3d-intro-build');
  // 3d-intro-setup ships a byte-identical copy of the build skill's Azure adapter (scripts/sync-adapter.js
  // guards this in CI/prepublish; assert it here too so a drifted mirror fails the smoke suite).
  const adapterBuild = fs.readFileSync(path.join(root, 'skills', '3d-intro-build', 'references', 'azure-adapter.mjs'));
  const adapterSetup = fs.readFileSync(path.join(root, 'skills', '3d-intro-setup', 'references', 'azure-adapter.mjs'));
  ok(adapterBuild.equals(adapterSetup), 'azure-adapter.mjs is byte-identical across 3d-intro-build and 3d-intro-setup');

  // 6.5) lineage.py Python regression tests. GATE ON INTERPRETER >=3.7, not mere presence:
  // EL8/Rocky8's default `python3` is 3.6.8, which lineage.py sys.exit(2)s at import, so a
  // presence check would FALSE-FAIL the per-OS matrix. Probe candidates, run under the first
  // >=3.7, and SKIP (not fail) with an explicit log if none exists ("too old" == "absent").
  const pyCandidates = ['python3', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8', 'python3.7'];
  let py = null;
  for (const cand of pyCandidates) {
    const r = cp.spawnSync(cand, ['-c', 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 7) else 1)'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) { py = cand; break; }
  }
  if (py) {
    const pyRes = cp.spawnSync(py, ['-B', '-m', 'unittest', 'test_lineage'],
      { cwd: path.join(root, 'skills', 'lineage'), encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const tail = ((pyRes.stderr || pyRes.stdout || '').trim().split('\n').pop() || '').slice(0, 80);
    ok(pyRes.status === 0, `lineage.py regression suite passes under ${py} (${tail})`);
  } else {
    console.log('SKIP: no python>=3.7 found — lineage.py suite not run (EL8 default python3=3.6 exits at import)');
  }

  // 7) hook packaging + static safety checks (0.6.0 obsidizer: banker's first plugin-declared hook).
  // 0.8.0 replaced the opt-in telemetry-flush.mjs client with an update-check + count-default-on
  // pair: update-notify.mjs (SessionStart) and telemetry-count.mjs/telemetry-count-skill.mjs
  // (UserPromptExpansion/PostToolUse) ARE wired in hooks.json below; update-fetch.mjs and
  // update-checkin.mjs are standalone scripts update-notify.mjs spawns detached (never declared in
  // hooks.json), but files[] still ships them, so assert all are packaged like the rest.
  const hookFiles = ['hooks.json', 'obsidize-hook.mjs', 'run.cjs', 'telemetry-count.mjs', 'telemetry-count-skill.mjs',
    'update-fetch.mjs', 'update-notify.mjs', 'update-checkin.mjs'];
  for (const f of hookFiles) {
    ok(fs.existsSync(path.join(root, 'hooks', f)), `hooks/${f} exists in the repo`);
  }
  const pkgRoot = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', '@kaydash9999', 'banker-plugins')
    : path.join(prefix, 'lib', 'node_modules', '@kaydash9999', 'banker-plugins');
  for (const f of hookFiles) {
    ok(fs.existsSync(path.join(pkgRoot, 'hooks', f)), `hooks/${f} is npm-packaged (present in the globally-installed tarball)`);
  }
  // PRIVACY.md (0.8.0) is the telemetry privacy notice; files[] must ship it beside LICENSE/README/CHANGELOG.
  ok(fs.existsSync(path.join(pkgRoot, 'PRIVACY.md')), 'PRIVACY.md is npm-packaged (files[] ships it alongside LICENSE/README/CHANGELOG)');
  // Tests are repo-only. obsidize.test.mjs sits INSIDE skills/obsidizer/, so shipping it
  // lets a runtime scanning the skill dir surface a test double as skill content.
  for (const f of [path.join('skills', 'obsidizer', 'obsidize.test.mjs'), path.join('hooks', 'obsidize-hook.test.mjs'),
    path.join('hooks', 'telemetry-count.test.mjs'), path.join('hooks', 'telemetry-count-skill.test.mjs'),
    path.join('hooks', 'update-fetch.test.mjs'), path.join('hooks', 'update-notify.test.mjs'),
    path.join('hooks', 'update-checkin.test.mjs'),
    path.join('skills', '3d-intro-build', 'references', 'azure-adapter.test.mjs'),
    // lineage.py is Python; its test is test_lineage.py (not *.test.mjs). files[] excludes
    // it via `!**/test_*.py`. pkgRoot IS the installed tarball Codex copies from, so this one
    // assertion covers BOTH runtimes: a leaked test would ship to Claude and Codex alike.
    path.join('skills', 'lineage', 'test_lineage.py')]) {
    ok(fs.existsSync(path.join(root, f)), `${f} exists in the repo (CI runs the suites from here, not the tarball)`);
    ok(!fs.existsSync(path.join(pkgRoot, f)), `${f} is NOT npm-packaged (files[] negation holds)`);
  }
  const hooksJson = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const declaredTimeouts = [];
  (function collectTimeouts(node) {
    if (Array.isArray(node)) { node.forEach(collectTimeouts); return; }
    if (node && typeof node === 'object') {
      if (typeof node.timeout === 'number') declaredTimeouts.push(node.timeout);
      Object.values(node).forEach(collectTimeouts);
    }
  })(hooksJson.hooks);
  ok(declaredTimeouts.length > 0 && declaredTimeouts.every((t) => t <= 5), `hooks.json declares an explicit timeout <=5s (got [${declaredTimeouts.join(', ')}])`);
  // Every *command* node in EVERY hooks.json event (PostToolUse, SessionStart, UserPromptExpansion,
  // ...) must carry an EXPLICIT timeout in [3,5]. The tree-walking collector above only pushes
  // timeouts it finds, so a command node that OMITS `timeout` is silently skipped and would still
  // pass. Enumerate the command nodes per event directly (not hardcoded to PostToolUse, so a future
  // event type is covered for free) and fail if any lacks a numeric `timeout` in range.
  const allCommands = Object.entries(hooksJson.hooks || {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : [])
      .flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : []))
      .filter((h) => h && h.type === 'command')
      .map((h) => ({ event, timeout: h.timeout })));
  const badTimeout = allCommands.filter((c) => typeof c.timeout !== 'number' || c.timeout < 3 || c.timeout > 5);
  ok(allCommands.length > 0 && badTimeout.length === 0,
     `every command node in every hooks.json event has an explicit timeout in [3,5] (nodes: ${allCommands.length}, offending: [${badTimeout.map((c) => c.event).join(', ')}])`);
  const hookScript = fs.readFileSync(path.join(root, 'hooks', 'obsidize-hook.mjs'), 'utf8');
  ok(!hookScript.includes('additionalContext'), 'obsidize-hook.mjs never injects LLM context (no additionalContext, per the SKILL.md refusal)');
  ok(!hookScript.includes('.wiki-lock'), 'obsidize-hook.mjs has zero coupling to OMC internal .wiki-lock');

  const prompts = fs.readdirSync(path.join(home2, '.codex', 'prompts')).filter((d) => d.startsWith('banker-'));
  ok(prompts.length === 2, `real codex install has 2 banker-* command prompts (got ${prompts.length})`);
  const readName = (md) => {
    const m = fs.readFileSync(md, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const nm = m && m[1].match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
    return nm ? nm[1] : null;
  };
  const mismatched = installed.filter((d) => readName(path.join(instDir, d, 'SKILL.md')) !== d);
  ok(mismatched.length === 0, `every installed skill has dir==frontmatter name (mismatched: ${mismatched.join(', ') || 'none'})`);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
