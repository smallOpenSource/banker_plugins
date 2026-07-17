#!/usr/bin/env node
'use strict';
/*
 * S6 verification harness (no network). Run: `node scripts/smoke-test.js`.
 * npm pack -> install the tarball into a TEMP prefix + TEMP HOME -> dry-run setup for both
 * targets -> assert planned actions match the manifest (48 skills + 2 command prompts, AGENTS.md
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
  ok(copies === 48, `codex dry-run plans 48 skill copies (got ${copies})`);
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
  // and copies===48 checks (it lives in the manifest and on disk, and the dry-run counts only the
  // 48 both-skills), so nothing above catches a silent claude-only. This replaces the former
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
  ok(installed.length === 48, `real codex install has 48 banker-* skills (got ${installed.length})`);
  ok(!fs.existsSync(staleDir), 'stale banker-* swept on reinstall (no leftover duplicate)');
  ok(!fs.existsSync(renamedAwayDir), 'renamed-away banker-game-qa swept on update (replaced by play-qa)');
  ok(installed.includes('banker-play-qa'), 'renamed skill installed as banker-play-qa');
  ok(!fs.existsSync(renamedStitchDir), 'renamed-away banker-setup-stitch-proxy swept (replaced by setup-stitch)');
  ok(installed.includes('banker-setup-stitch'), 'renamed skill installed as banker-setup-stitch');
  ok(installed.includes('banker-docs-setup'), 'new docs-setup installed as banker-docs-setup');
  ok(installed.includes('banker-obsidizer'), 'obsidizer installed as banker-obsidizer');

  // 7) hook packaging + static safety checks (0.6.0 obsidizer: banker's first plugin-declared hook).
  // telemetry-count/flush.mjs (0.8.0) are standalone hook scripts: option B keeps them OUT of
  // hooks.json (inert), but files[] still ships them, so assert both are packaged like the rest.
  const hookFiles = ['hooks.json', 'obsidize-hook.mjs', 'run.cjs', 'telemetry-count.mjs', 'telemetry-flush.mjs'];
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
    path.join('hooks', 'telemetry-count.test.mjs'), path.join('hooks', 'telemetry-flush.test.mjs')]) {
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
  // Every PostToolUse *command* node must carry an EXPLICIT timeout in [3,5]. The tree-walking
  // collector above only pushes timeouts it finds, so a command node that OMITS `timeout` is
  // silently skipped and would still pass. Enumerate the command nodes directly and fail if any
  // lacks a numeric `timeout` in range (currently the single obsidizer node, timeout 5).
  const ptuCommands = ((hooksJson.hooks && hooksJson.hooks.PostToolUse) || [])
    .flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : []))
    .filter((h) => h && h.type === 'command');
  const ptuBadTimeout = ptuCommands.filter((h) => typeof h.timeout !== 'number' || h.timeout < 3 || h.timeout > 5);
  ok(ptuCommands.length > 0 && ptuBadTimeout.length === 0,
     `every PostToolUse command node has an explicit timeout in [3,5] (nodes: ${ptuCommands.length}, offending: ${ptuBadTimeout.length})`);
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
