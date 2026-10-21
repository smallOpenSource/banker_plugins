#!/usr/bin/env node
'use strict';
/*
 * S6 verification harness (no network). Run: `node scripts/smoke-test.js`.
 * npm pack -> install the tarball into a TEMP prefix + TEMP HOME (npm's cache and logs in the TEMP folder too) -> dry-run setup for both
 * targets -> assert planned actions match the manifest (63 skills + 2 command prompts, AGENTS.md
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
// npm reaches no registry from this harness: update_notifier=false stops the weekly update check, the one request
// npm pack and a local tarball's install made; offline keeps any other lookup off the network. Its cache and logs go
// to the temp folder, not the real ~/.npm.
const OFFLINE_SETTINGS = { npm_config_update_notifier: 'false', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
  npm_config_cache: path.join(tmp, 'npm-cache'), npm_config_logs_dir: path.join(tmp, 'npm-cache', '_logs') };
// npm runs with a HOME of its own in the temp folder: a user .npmrc that moves the logs (logs-dir) or turns them off
// (logs-max=0) changes nothing here, and whatever npm would put under HOME shows as a file in that folder.
const npmHome = path.join(tmp, 'npm-home');
// npm reads npm_config_* names whatever their case and the last spelling wins: drop every spelling of the settings set
// here (an own key only: a variable named like `constructor` is no setting).
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k); // Object.hasOwn is Node 16.9 on; engines says 16.7
const NPM_OFFLINE = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !own(OFFLINE_SETTINGS, k.toLowerCase()))), ...OFFLINE_SETTINGS,
  HOME: npmHome, USERPROFILE: npmHome };

const prefix = path.join(tmp, 'prefix');
const home = path.join(tmp, 'home');
fs.mkdirSync(prefix, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(npmHome, { recursive: true });

try {
  // 1) pack
  const packOut = run('npm', ['pack', '--silent', '--pack-destination', tmp], { cwd: root, env: NPM_OFFLINE });
  const tarball = packOut.trim().split('\n').filter(Boolean).pop().trim();
  const tarPath = path.join(tmp, tarball);
  ok(fs.existsSync(tarPath), `npm pack produced ${tarball}`);
  ok(fs.readdirSync(npmHome).length === 0, 'npm put nothing under its HOME: its cache and logs stay in the temp folder (not ~/.npm)');

  // 2) global install into temp prefix (offline; no deps)
  run('npm', ['i', '-g', '--prefix', prefix, tarPath], { stdio: 'pipe', env: NPM_OFFLINE });
  const binPath = process.platform === 'win32' ? path.join(prefix, 'banker.cmd') : path.join(prefix, 'bin', 'banker');
  ok(fs.existsSync(binPath), `installed banker bin (${path.relative(tmp, binPath)})`);

  const env = { ...process.env, HOME: home, USERPROFILE: home };

  // 3) codex dry-run (project scope)
  const codexOut = run(binPath, ['setup', '--codex', '--scope', 'project', '--dry-run'], { cwd: home, env });
  const copies = (codexOut.match(/\[dry-run\] copy skills\//g) || []).length;
  ok(copies === 63, `codex dry-run plans 63 skill copies (got ${copies})`);
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
  // Claude Code's typeahead already puts "(banker)" before a plugin skill's description, and the
  // Codex copy is named banker-<name>, so a description that starts with the tag shows it twice.
  const descFiles = [
    ...diskSkills.map((d) => path.join(root, 'skills', d, 'SKILL.md')),
    ...fs.readdirSync(path.join(root, 'commands')).filter((f) => f.endsWith('.md')).map((f) => path.join(root, 'commands', f)),
  ];
  const tagged = descFiles.filter((f) => /^description:\s*"?\(banker\)/m.test(fs.readFileSync(f, 'utf8').split(/\n---/)[0]))
    .map((f) => path.relative(root, f));
  ok(tagged.length === 0, `no skill or command description starts with "(banker)" (tagged: [${tagged.join(', ')}])`);
  // Descriptions follow tone-compact (the user's request). A regex can hold its mechanical rules: no
  // decorative symbol, look-alike, emoji or exclamation mark; no translationese, inflected forms included;
  // no sentence over 25 words; one line each, as a description is read in one line (so its vertical-list
  // rule cannot apply). Code spans keep their original text: the symbol and translationese checks skip them,
  // while the 25-word count still counts their words. What a regex cannot judge
  // (meaning kept, terms, triggers) stays with review. /graceful-pause's description lives in
  // hooks/graceful-pause.mjs, as function-hooks commands have no frontmatter.
  const descs = descFiles.map((f) => {
    const fm = fs.readFileSync(f, 'utf8').split(/\r?\n---/)[0];
    const m = /^description:[ \t]*(.*?)\r?$/m.exec(fm);
    let text = m ? m[1].trim() : '';
    if (/^"(.*)"$/.test(text)) text = text.slice(1, -1);
    // a value continued on an indented next line, quoted or not, is not one line either
    const unclosed = /^"/.test(m ? m[1].trim() : '') && !/"$/.test(m ? m[1].trim() : '');
    return { file: path.relative(root, f), text, multi: unclosed || /^description:.*\r?\n[ \t]+\S/m.test(fm) };
  });
  const pauseSrc = fs.readFileSync(path.join(root, 'hooks', 'graceful-pause.mjs'), 'utf8');
  descs.push({ file: 'hooks/graceful-pause.mjs', text: (/^  description: '([^']*)',$/m.exec(pauseSrc) || [, ''])[1] });
  const progressSrc = fs.readFileSync(path.join(root, 'hooks', 'progress.mjs'), 'utf8');
  descs.push({ file: 'hooks/progress.mjs', text: (/^export const SPEC = \{ [^\n]*?description: '([^']*)'/m.exec(progressSrc) || [, ''])[1] });
  const SYMBOLS = /[→⇒·…※★✓✗●■—–―‒‥!！‼⁉ㆍ•‧∙⋅・･⋯⸺⸻]|[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]|\p{Extended_Pictographic}/u;
  // the double passive is written attached (되어지다), so a spaced 되어 지원 is ordinary prose
  const TRANSLATIONESE = /에\s?대(해|한|하여)|[을를]\s?통(해|한|하여)|것이\s?가능|(되어|보여|쓰여|잊혀|불려|놓여|짜여)[지진졌짐져질집]/;
  const toneBreaks = descs.flatMap(({ file, text, multi }) => {
    const why = [];
    const prose = text.replace(/`[^`]*`/g, '');
    if (!text || multi || /^[>|]/.test(text)) why.push('no one-line description found');
    if (SYMBOLS.test(prose)) why.push('decorative symbol, look-alike, emoji or "!"');
    if (TRANSLATIONESE.test(prose)) why.push('translationese');
    const longest = Math.max(...text.split(/(?<=\.)\s+/).map((s) => s.split(/\s+/).filter(Boolean).length));
    if (longest > 25) why.push(`a ${longest}-word sentence`);
    return why.map((w) => `${file}: ${w}`);
  });
  // argument-hint shows on the same typeahead line as the description: no decorative symbol there either
  const hintBreaks = descFiles.flatMap((f) => {
    const h = /^argument-hint:[ \t]*(.*?)\r?$/m.exec(fs.readFileSync(f, 'utf8').split(/\r?\n---/)[0]);
    return h && SYMBOLS.test(h[1].replace(/`[^`]*`/g, '')) ? [`${path.relative(root, f)}: argument-hint symbol`] : [];
  });
  const breaks = [...toneBreaks, ...hintBreaks];
  ok(breaks.length === 0,
     `descriptions pass the mechanical tone checks: symbols, translationese, sentence length, one line; argument-hint symbols (${descs.length} checked${breaks.length ? '; ' + breaks.join('; ') : ''})`);

  // anti-drm: banker's own work files avoid .txt and .csv, which a DRM may encrypt so that the agent can no longer
  // read them back. A name below stays only for the reason beside it. Tests are repo-only and skipped; anti-drm
  // itself names the denied extensions. An allowance that matches nothing fails too, so the list stays true.
  const DRM_KEEP = [
    ['skills/audit-security/SKILL.md', 'requirements.txt', 'a name the Python tools fix; the skill only reads it'],
    ['skills/audit-security/SKILL.md', '<requirements>.txt', 'the same name in a command template'],
    ['skills/rfp-author/references/research-provenance.md', '/tmp/rfp_pdf.txt', 'a record of past research, not a step'],
    ['skills/rfp-author/references/research-provenance.md', '/tmp/nist6001.txt', 'a record of past research, not a step'],
    ['skills/lineage/lineage.py', '.txt', 'reads the .txt name lineage 3.0.2 and earlier wrote (none matches since summarizer version 4); writes .md'],
    ['skills/lineage/SKILL.md', '.txt', 'names the .txt of lineage 3.0.2 and earlier, not used since summarizer version 4'],
    ['skills/ultra-chain/SKILL.md', '05-baseline.txt', 'the baseline of a run begun before the change, read when resuming'],
    ['commands/front-qa.md', 'docs/note.txt', 'the old default spec, read only when docs/note.md is missing'],
    ['commands/front-qa.md', 'progress.txt', "OMC's checkpoint file, named by OMC"],
    ['skills/setup-omc-hud/assets/apply-hud.mjs', 'hud-wrapper-template.txt', "OMC's HUD loader template, named by OMC; the installer only reads it"],
    ...['3d-intro-build', 'motion-graphic-make', 'ultra-chain'].map((s) =>
      [`skills/${s}/references/preview-lib.mjs`, '.txt', 'a MIME type the preview server serves; no file is written']),
  ];
  // Every text file under skills/ and commands/, in any letter case (a DRM matches NOTES.TXT too). A file that is
  // not UTF-8 holds no name to read.
  const drmNames = [];
  // A name starts only where a run of name letters starts: a long run is read once, not once per letter.
  const drmName = /(?<![A-Za-z0-9_./<>{}$*-])[A-Za-z0-9_./<>{}$*-]*\.(?:txt|csv)\b/gi;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  function scanDrm(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '__pycache__', '.omc'].includes(e.name)) scanDrm(p); continue; }
      if (!e.isFile() || /\.test\.(mjs|ts)$|^test_.*\.py$/.test(e.name)) continue;
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (rel.startsWith('skills/anti-drm/')) continue;
      let text;
      try { text = utf8.decode(fs.readFileSync(p)); } catch { continue; }
      for (const m of text.matchAll(drmName)) drmNames.push([rel, m[0]]);
    }
  }
  scanDrm(path.join(root, 'skills'));
  scanDrm(path.join(root, 'commands'));
  const drmUnexplained = [...new Set(drmNames.filter(([rel, name]) => !DRM_KEEP.some(([f, n]) => f === rel && n === name))
    .map(([rel, name]) => `${rel}: ${name}`))];
  const drmUnused = DRM_KEEP.filter(([f, n]) => !drmNames.some(([rel, name]) => rel === f && name === n)).map(([f, n]) => `${f}: ${n}`);
  ok(drmUnexplained.length === 0 && drmUnused.length === 0,
     `banker work files avoid .txt and .csv (unexplained: [${drmUnexplained.join(', ')}]; unused allowances: [${drmUnused.join(', ')}])`);
  const longRun = `${'a'.repeat(100000)} NOTES.TXT x/y.csv`;
  const t0 = Date.now();
  const longHits = [...longRun.matchAll(drmName)].map((m) => m[0]);
  const took = Date.now() - t0;
  ok(took < 1000 && longHits.join(' ') === 'NOTES.TXT x/y.csv', `DRM name scan reads a 100,000-letter run in linear time (${took} ms)`);
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
  // rename-case guard 3: harness-factory -> setup-harness-factory
  const renamedFactoryDir = path.join(home2, '.codex', 'skills', 'banker-harness-factory');
  fs.mkdirSync(renamedFactoryDir, { recursive: true });
  fs.writeFileSync(path.join(renamedFactoryDir, 'SKILL.md'), '---\nname: banker-harness-factory\n---\n');
  // removal guard: graceful_pause left the plugin (replaced by the /graceful-pause function-hooks command)
  const removedPauseDir = path.join(home2, '.codex', 'skills', 'banker-graceful_pause');
  fs.mkdirSync(removedPauseDir, { recursive: true });
  fs.writeFileSync(path.join(removedPauseDir, 'SKILL.md'), '---\nname: banker-graceful_pause\n---\n');
  const env2 = { ...process.env, HOME: home2, USERPROFILE: home2 };
  run(binPath, ['setup', '--codex', '--scope', 'user'], { cwd: home2, env: env2 });
  const instDir = path.join(home2, '.codex', 'skills');
  const installed = fs.readdirSync(instDir).filter((d) => d.startsWith('banker-'));
  ok(installed.length === 63, `real codex install has 63 banker-* skills (got ${installed.length})`);
  ok(!fs.existsSync(staleDir), 'stale banker-* swept on reinstall (no leftover duplicate)');
  ok(!fs.existsSync(renamedAwayDir), 'renamed-away banker-game-qa swept on update (replaced by play-qa)');
  ok(installed.includes('banker-play-qa'), 'renamed skill installed as banker-play-qa');
  ok(!fs.existsSync(renamedStitchDir), 'renamed-away banker-setup-stitch-proxy swept (replaced by setup-stitch)');
  ok(installed.includes('banker-setup-stitch'), 'renamed skill installed as banker-setup-stitch');
  ok(!fs.existsSync(renamedFactoryDir), 'renamed-away banker-harness-factory swept (replaced by setup-harness-factory)');
  ok(installed.includes('banker-setup-harness-factory'), 'renamed skill installed as banker-setup-harness-factory');
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
  const poolBuild = fs.readFileSync(path.join(root, 'skills', '3d-intro-build', 'references', 'video-pool.mjs'));
  const poolSetup = fs.readFileSync(path.join(root, 'skills', '3d-intro-setup', 'references', 'video-pool.mjs'));
  ok(poolBuild.equals(poolSetup), 'video-pool.mjs is byte-identical across 3d-intro-build and 3d-intro-setup');
  // motion-graphic-make ships the build skill's local servers and review page (same sync script).
  for (const f of ['preview-lib.mjs', 'serve.mjs', 'curate.mjs']) {
    const a = fs.readFileSync(path.join(root, 'skills', '3d-intro-build', 'references', f));
    const b = fs.readFileSync(path.join(root, 'skills', 'motion-graphic-make', 'references', f));
    ok(a.equals(b), `${f} is byte-identical across 3d-intro-build and motion-graphic-make`);
  }
  // ultra-chain serves its mock and report with the same preview server (same sync script).
  for (const f of ['preview-lib.mjs', 'serve.mjs']) {
    const a = fs.readFileSync(path.join(root, 'skills', '3d-intro-build', 'references', f));
    const b = fs.readFileSync(path.join(root, 'skills', 'ultra-chain', 'references', f));
    ok(a.equals(b), `${f} is byte-identical across 3d-intro-build and ultra-chain`);
  }
  // payload-mon runs on its two scripts: payload-mon.mjs patches the HUD wrapper and copies payload-size.mjs
  // beside it, so a Codex copy missing either one can neither turn the segment on nor compute it.
  ok(installed.includes('banker-payload-mon'), 'new payload-mon installed as banker-payload-mon');
  const pmScripts = ['payload-mon.mjs', 'payload-size.mjs'];
  ok(pmScripts.every((f) => fs.existsSync(path.join(instDir, 'banker-payload-mon', 'scripts', f))),
     `banker-payload-mon carries scripts/${pmScripts.join(' + scripts/')} into the Codex install`);
  // tone-compact's script reads its rules from the SKILL.md beside it (../SKILL.md), so the Codex copy needs
  // both, and the rule markers must survive the frontmatter `name:` rewrite.
  ok(installed.includes('banker-tone-compact'), 'new tone-compact installed as banker-tone-compact');
  const tcDir = path.join(instDir, 'banker-tone-compact');
  ok(fs.existsSync(path.join(tcDir, 'scripts', 'tone-compact.mjs')), 'banker-tone-compact carries scripts/tone-compact.mjs into the Codex install');
  ok(fs.existsSync(path.join(tcDir, 'scripts', 'instruction-toggle.mjs')), 'banker-tone-compact carries scripts/instruction-toggle.mjs into the Codex install');
  // anti-drm runs its script from the skill's own folder with the shared toggle module beside it, and fills the
  // rules from the template in its SKILL.md; the template markers must survive the frontmatter `name:` rewrite.
  ok(installed.includes('banker-anti-drm'), 'new anti-drm installed as banker-anti-drm');
  const adDir = path.join(instDir, 'banker-anti-drm');
  ok(['anti-drm.mjs', 'instruction-toggle.mjs'].every((f) => fs.existsSync(path.join(adDir, 'scripts', f))),
     'banker-anti-drm carries scripts/anti-drm.mjs + scripts/instruction-toggle.mjs into the Codex install');
  const adSkill = fs.readFileSync(path.join(adDir, 'SKILL.md'), 'utf8');
  ok(/^---\nname: banker-anti-drm\n/.test(adSkill) && adSkill.includes('<!-- anti-drm:rules:start -->') && adSkill.includes('<!-- anti-drm:rules:end -->'),
     'Codex copy of anti-drm keeps its rule template markers after the name rewrite');
  const toggleTc = fs.readFileSync(path.join(root, 'skills', 'tone-compact', 'scripts', 'instruction-toggle.mjs'));
  const toggleAd = fs.readFileSync(path.join(root, 'skills', 'anti-drm', 'scripts', 'instruction-toggle.mjs'));
  ok(toggleTc.equals(toggleAd), 'instruction-toggle.mjs is byte-identical across tone-compact and anti-drm');
  const tcSkill = fs.readFileSync(path.join(tcDir, 'SKILL.md'), 'utf8');
  ok(/^---\nname: banker-tone-compact\n/.test(tcSkill) && tcSkill.includes('<!-- tone-compact:rules:start -->') && tcSkill.includes('<!-- tone-compact:rules:end -->'),
     'Codex copy of tone-compact keeps its rule markers after the name rewrite');
  // omc-patch runs its tool from the skill's own folder (scripts/omc-patch.mjs), so the Codex copy needs it too.
  ok(installed.includes('banker-omc-patch'), 'new omc-patch installed as banker-omc-patch');
  ok(fs.existsSync(path.join(instDir, 'banker-omc-patch', 'scripts', 'omc-patch.mjs')), 'banker-omc-patch carries scripts/omc-patch.mjs into the Codex install');
  ok(fs.existsSync(path.join(instDir, 'banker-omc-patch', 'scripts', 'probe-pm.mjs')), 'banker-omc-patch carries scripts/probe-pm.mjs into the Codex install');
  // theme-selection runs scripts/themes.mjs from the skill's own folder, and the engine reads the palettes beside
  // it (../assets/palettes.json); their MIT notice travels with them. Run the installed copy once: a copy that has
  // the file but cannot find its palettes would pass an existence check alone.
  ok(installed.includes('banker-theme-selection'), 'new theme-selection installed as banker-theme-selection');
  const tsDir = path.join(instDir, 'banker-theme-selection');
  const tsFiles = ['scripts/themes.mjs', 'assets/palettes.json', 'assets/LICENSE', 'assets/NOTICE.md',
    'references/integrate.md', 'references/contrast.md'];
  ok(tsFiles.every((f) => fs.existsSync(path.join(tsDir, ...f.split('/')))),
     `banker-theme-selection carries ${tsFiles.join(', ')} into the Codex install`);
  const tsRun = cp.spawnSync(process.execPath, [path.join(tsDir, 'scripts', 'themes.mjs'), 'list', '--only', 'airbnb'],
    { encoding: 'utf8' });
  ok(tsRun.status === 0 && tsRun.stdout === 'airbnb\tAirbnb\n',
     `the Codex copy of theme-selection runs and reads its palettes (status ${tsRun.status}, stderr ${JSON.stringify(tsRun.stderr)})`);
  // remains runs its box tool from the skill's own folder (scripts/boxes.mjs), so the Codex copy needs it too.
  ok(installed.includes('banker-remains'), 'new remains installed as banker-remains');
  ok(fs.existsSync(path.join(instDir, 'banker-remains', 'scripts', 'boxes.mjs')), 'banker-remains carries scripts/boxes.mjs into the Codex install');
  ok(installed.includes('banker-trouble-shooting'), 'new trouble-shooting installed as banker-trouble-shooting');
  // ultra-chain runs its ledger, report, capture and preview server from the skill's own folder, so the Codex copy needs them.
  ok(installed.includes('banker-ultra-chain'), 'new ultra-chain installed as banker-ultra-chain');
  const ucFiles = ['chain-ledger.mjs', 'chain-report.mjs', 'capture.mjs', 'serve.mjs', 'preview-lib.mjs'];
  ok(ucFiles.every((f) => fs.existsSync(path.join(instDir, 'banker-ultra-chain', 'references', f))),
     `banker-ultra-chain carries references/${ucFiles.join(' + references/')} into the Codex install`);
  ok(!fs.existsSync(removedPauseDir) && !installed.includes('banker-graceful_pause'),
     'removed graceful_pause swept on update and not reinstalled (Claude Code has /graceful-pause instead)');
  // setup-omc-hud installs the statusline from the files in its own folder (assets/), downloading nothing, and its
  // off/status arguments run scripts/claude-update-last.mjs; every copy of that folder ships them, Codex's included
  // (there the skill points at OMX's hud, so they sit unused). Run the installed copy's installer once, against a
  // temp config with a stand-in OMC: a copy that has the files but cannot install from them would pass alone.
  const hudSkillDir = path.join(instDir, 'banker-setup-omc-hud');
  const hudFiles = ['scripts/claude-update-last.mjs', 'assets/apply-hud.mjs', 'assets/omc-hud-custom.mjs',
    'assets/hud-config.json', 'assets/LICENSE-omc_hud'];
  ok(hudFiles.every((f) => fs.existsSync(path.join(hudSkillDir, ...f.split('/')))),
     `banker-setup-omc-hud carries ${hudFiles.join(', ')} into the Codex install`);
  const hudCfg = path.join(tmp, 'hud cfg');
  const omcLib = path.join(hudCfg, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.4', 'scripts', 'lib');
  fs.mkdirSync(omcLib, { recursive: true });
  fs.writeFileSync(path.join(omcLib, 'hud-wrapper-template.txt'), '// loader\n');
  fs.writeFileSync(path.join(omcLib, 'config-dir.mjs'), 'export {};\n');
  const hudRun = cp.spawnSync(process.execPath, [path.join(hudSkillDir, 'assets', 'apply-hud.mjs')],
    { encoding: 'utf8', env: { ...env2, CLAUDE_CONFIG_DIR: hudCfg, OMC_PLUGIN_ROOT: '' } });
  let hudCmd = '';
  try { hudCmd = JSON.parse(fs.readFileSync(path.join(hudCfg, 'settings.json'), 'utf8')).statusLine.command; } catch { /* not written */ }
  ok(hudRun.status === 0 && hudCmd === `node "${path.join(hudCfg, 'hud', 'omc-hud-custom.mjs').split(path.sep).join('/')}"`,
     `the Codex copy of setup-omc-hud installs the statusline from its own files (status ${hudRun.status}, command ${JSON.stringify(hudCmd)})`);
  // ...and its procedure works offline: SKILL.md runs no download (the bundled files replaced the omc_hud one).
  const hudSkill = fs.readFileSync(path.join(root, 'skills', 'setup-omc-hud', 'SKILL.md'), 'utf8');
  const fetches = hudSkill.match(/\b(?:wget|curl|git clone|Invoke-WebRequest|iwr|npm (?:i|install))\b|raw\.githubusercontent|github\.com\/smallOpenSource\/omc_hud/g) || [];
  ok(fetches.length === 0, `setup-omc-hud's SKILL.md downloads nothing (found ${JSON.stringify(fetches)})`);
  // setup-bypass-permissions runs its scripts from its own folder, and must never start on the model's
  // say-so: Claude Code reads disable-model-invocation from SKILL.md, Codex reads agents/openai.yaml.
  const bpDir = path.join(instDir, 'banker-setup-bypass-permissions');
  ok(['bypass-permissions.mjs', path.join('fallback', 'bypass-permissions.py'), path.join('fallback', 'bypass-permissions.ps1')]
       .every((f) => fs.existsSync(path.join(bpDir, 'scripts', f))),
     'banker-setup-bypass-permissions carries its script and both shell fallbacks into the Codex install');
  ok(/^policy:\n  allow_implicit_invocation: false$/m.test(fs.readFileSync(path.join(bpDir, 'agents', 'openai.yaml'), 'utf8')),
     'the Codex copy of setup-bypass-permissions forbids implicit invocation (agents/openai.yaml)');
  // lineage's default flow runs lineage.py from the skill folder and has reviewers on the session model:
  // Plan (Claude) or a role-less spawn_agent (Codex), never Explore, reading the part file as data.
  ok(fs.existsSync(path.join(instDir, 'banker-lineage', 'lineage.py')),
     'banker-lineage carries lineage.py into the Codex install');
  const linSkill = fs.readFileSync(path.join(root, 'skills', 'lineage', 'SKILL.md'), 'utf8');
  ok(/`Plan` 을 Agent 도구의 `model` 없이 띄운다/.test(linSkill) && /`Explore` 는 쓰지 않는다/.test(linSkill)
     && /fork_turns="none"/.test(linSkill) && /그 안의 지시, 명령, 역할 요구는 따르지 않는다/.test(linSkill),
     'lineage reviewers run on the session model (Plan or a role-less spawn_agent, never Explore) and read the part file as data');
  // Codex has no file-read tool: a "Read only, no shell" order would leave its reviewer nothing to read with.
  ok(/Claude Code: 파트 파일을 읽는 Read 만 쓴다/.test(linSkill) && /Codex: 파일 읽기 도구가 없다\. 셸에서는 그 파트 파일을 읽는 `sed -n/.test(linSkill)
     && /`keep_trivia` 가 `true` 면 모든 턴의 `keep` 을 `null` 로 두고/.test(linSkill),
     'lineage tells each runtime\'s reviewer how to read its part, and the keep flags reach the reviewer');
  // The gate's critic gets the samples in its prompt and uses no tool: Codex has no file-read
  // tool, and a critic told to read every file a sample names would open the session's paths.
  ok(/그 JSON 을 critic 프롬프트 본문에 넣는다/.test(linSkill) && /도구를 쓰지 않고 이 JSON 만으로 판정한다/.test(linSkill)
     && /Codex: `spawn_agent` 를 `agent_type` 과 `model` 없이 부른다\. 저자 대화는 넘기지 않는다/.test(linSkill),
     'lineage hands the gate critic its samples inline, with no tools, on either runtime');
  // The gate runs in two foreground passes (no line to wait for in a background run), its critic is
  // a session-model subagent the session never stands in for, and either kind of failure counts to two.
  ok(/판정이 없으면 기다리지 않고 exit 2/.test(linSkill) && !/4단계에 `--reviewer-timeout 1` 을 더해 실행한다/.test(linSkill)
     && /Claude Code: `Plan` 을 Agent 도구의 `model` 없이 띄운다\(검토자와 같은 이유/.test(linSkill)
     && /critic 을 띄울 수 없으면 세션이 스스로 판정하지 않는다/.test(linSkill) && /FAIL 과 5번의 exit 2 가 합쳐 두 번 이어지면 멈춘다/.test(linSkill)
     && /샘플의 `idx`, `id`, `key` 를 그대로 담는다/.test(linSkill) && !/백그라운드로 실행한다/.test(linSkill) && !/`oh-my-claudecode:critic` 에이전트\(스킬이 아니다\)/.test(linSkill),
     'lineage runs its gate in two foreground passes with a session-model critic it never plays itself, and stops after two failures of either kind');
  // The gate's second run carries the first run's paths and page name, the critic judges by a
  // stated rule, an answer that is a list yet refused counts as a failure, and reviewers stop.
  ok(/1단계에서 정한 이름 끝 시각/.test(linSkill) && /4단계를 1번과 같은 인자로 다시 실행한다/.test(linSkill)
     && /`left by a gated run`/.test(linSkill) && /1단계에 준 경로도 검토자를 띄우기 전에 exit 2 로 멈춘다/.test(linSkill)
     && /`recoverable` 은 `generated_summary` 가 `original_detail` 의 결론\(무엇을 했고 무엇이 나왔는지\)을 틀린 사실 없이 담으면 true/.test(linSkill)
     && /`\[REDACTED:\.\.\.\]` 자리는 흠으로 보지 않는다/.test(linSkill)
     && /그런 역할이 없으면 critic 을 띄울 수 없는 경우다/.test(linSkill)
     && /맨 배열인데 `idx` 가 든 객체가 하나도 없으면\(빈 배열 포함\) exit 2\(`no entry names idx`\)다/.test(linSkill) && /2번부터 다시 하고 6번의 횟수에 센다/.test(linSkill)
     && /`idx` 가 든 객체가 하나라도 있는 JSON 배열/.test(linSkill)
     && /같은 파트를 두 번 다시 검토해도 턴이 빠지거나 배열이 없으면 더 띄우지 않는다/.test(linSkill) && /그 파트의 결정 파일을 쓰지 않는다/.test(linSkill)
     && /`reviewers dropped N typed user turn\(s\)`/.test(linSkill)
     && /`!` 명령 뒤 하네스가 쓴 출력 턴\(`<bash-stdout>` 블록 뒤 `<bash-stderr>` 블록, 실패하면 `<bash-stderr>` 블록 하나만 있는 턴\. 가리기 전 글로 본다\)은 세지 않는다/.test(linSkill)
     && /1,000,000 바이트/.test(linSkill)
     && /첨자 대입/.test(linSkill) && /빈 사용자나 빈 비밀번호/.test(linSkill) && /`date -u \+%H:%M`/.test(linSkill)
     && /`\/` 로 시작하는 비밀번호/.test(linSkill) && /^version: 3\.0\.10$/m.test(linSkill)
     && /따로 감싼 `"USER":"PW"`, 따옴표 친 명령 속의 이스케이프한 따옴표\(`\\"USER:PW\\"`, 여러 겹 JSON\), bash 의 `'\\''` 와 `shlex\.quote` 의 `'"'"'`, cmd 의 `\^"`, PowerShell 의 `` `" ``, bash 의 `\$'…'`, `\$\{API_USER\}` 같은 변수 사용자와 변수에 이은 사용자\(`"\$USER"@corp\.com`, `"\$\{ENV\}"-deployer`\), 인라인 코드나 괄호 안/.test(linSkill)
     && !/선형 시간과 맞바꿈/.test(linSkill) && /`\+%` 뒤에 글자가 오면 나머지는 보지 않는다/.test(linSkill)
     && /인자 목록에서 다른 종류의 따옴표가 든 비밀번호/.test(linSkill) && /플래그 꼴과 따옴표가 오는 꼴\(`"\$USER"-eu":PW"`\)/.test(linSkill) && !/공백 없는 인자 목록\(`\["docker","run","-u","1000:1000","img"\]`\)/.test(linSkill)
     && /검토자 패턴은 모든 페이지\(기본 흐름과 `--rulebase`\)에도 건다/.test(linSkill) && /비밀을 가린 턴은 2\.x 와 다를 수 있다/.test(linSkill)
     && !/비밀이 없는 턴에서 2\.x 와 같다/.test(linSkill) && !/\(2\.x 동작, 모델 호출 없음\)/.test(linSkill)
     && !/출력 경로를 페이지처럼 그대로 둔다/.test(linSkill)
     && /규칙 요약은 가린 본문에서 자른다/.test(linSkill) && /값이 `\/`, `~`, `\$` 로 시작하는 password 값/.test(linSkill)
     && !/페이지는 이 패턴을 쓰지 않으므로/.test(linSkill)
     && /`the page still holds secret-like text \(<패턴>=N\)` WARN 을 내면, 패턴 이름과 수를 사용자에게 알리고 공유하기 전에 페이지를 확인하라고 말한다/.test(linSkill)
     && /`--rulebase` 실행이 `still holds secret-like text` WARN 을 내면 5단계처럼 사용자에게 알린다/.test(linSkill)
     && /다시 만들 때는 그 값을 `LINEAGE_REDACT_EXTRA` 에 넣고 `--rebuild-summaries` 를 준다/.test(linSkill)
     && /무작위 키\(`stdin-id\.key`, 0600\)로 HMAC 한 값이다/.test(linSkill)
     && /앞서 만든 페이지\(`--rulebase` 는 그 옆의 게이트 샘플도\)는 그 값을 가진 채 남으므로 지우라고 알린다/.test(linSkill)
     && /stdin-id\.key +\(stdin 턴 id 의 HMAC 키, 0600/.test(linSkill)
     && !/`--redact-extra` 로 주면 셸 기록에 남는다/.test(linSkill)
     && /기본값이 콜론 없는 경로\(`\/`, `~`, `\.` 로 시작\)인 변수/.test(linSkill) && /기본값이 경로가 아닌 변수\(`\$\{UID:-1000\}:\$\{GID:-1000\}`, `\$\{API_KEY:-…\}`\)는 가린다/.test(linSkill)
     && /`ls -lu a:bcd`/.test(linSkill) && !/`ls -lu a:b`/.test(linSkill),
     'lineage: the gate rerun keeps its paths and page, the critic has a stated rule, a refused list counts as a failure, re-reviews stop at two, and dropped user turns are named');
  // The summary cache is kept only by the summarizer version: a release that changes the summarizer or the page
  // redaction and keeps the version reuses the old summaries (3.0.8 did). The SKILL says so instead of "자동 무효화".
  ok(!/자동 무효화/.test(linSkill)
     && (linSkill.match(/요약기나 가림을 바꾼 판은 요약기 버전\(`SUMMARIZER_VERSION`\)을 올려/g) || []).length === 2,
     'lineage: the SKILL says a release that changes the summarizer or the redaction bumps SUMMARIZER_VERSION, not that the cache invalidates itself');
  // A --rulebase rerun with other redaction settings reuses the summaries: the SKILL says to rebuild them.
  ok(/설정을 바꿔 다시 돌릴 때는 `--rebuild-summaries` 를 함께 준다/.test(linSkill),
     'lineage: the SKILL tells a --rulebase rerun with other redaction settings to rebuild the summaries');
  const bpFm = fs.readFileSync(path.join(root, 'skills', 'setup-bypass-permissions', 'SKILL.md'), 'utf8').split(/\n---/)[0];
  ok(/^disable-model-invocation: true$/m.test(bpFm),
     'setup-bypass-permissions/SKILL.md sets disable-model-invocation: the model cannot start it');

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
  // The failing tests by name (Class.test), each once: unittest writes `FAIL: test (module.Class)` before 3.11,
  // `FAIL: test (module.Class.test)` from 3.11 on, and a subTest's `[msg]` and `(k=v)` after either.
  const failedTestNames = (out) => [...new Set(out.split(/\r?\n/)
    .map((l) => /^(?:FAIL|ERROR): (\S+) \((\S+)\)(?: \[.*\])?(?: \(.*\))?$/.exec(l)).filter(Boolean)
    .map(([, name, where]) => {
      const parts = where.split('.');
      if (parts[parts.length - 1] === name) parts.pop();
      return `${parts.pop()}.${name}`;
    }))];
  ok(JSON.stringify(failedTestNames('FAIL: test_a (test_lineage.C.test_a) (i=1)\r\nFAIL: test_a (test_lineage.C.test_a) (i=2)\r\n'
    + 'ERROR: test_b (test_lineage.D) [label (x)] (k=1)\r\nFAIL: test_c (test_lineage.E.test_c) (<subtest>)\r\n'
    + 'FAIL: test_d (test_lineage.F.test_d)\n[lineage] ERROR: not a test\n'))
     === JSON.stringify(['C.test_a', 'D.test_b', 'E.test_c', 'F.test_d']),
     'lineage: the smoke names each failed test once, a subTest\'s too, on either line end');
  if (py) {
    const pyRes = cp.spawnSync(py, ['-B', '-m', 'unittest', 'test_lineage'],
      { cwd: path.join(root, 'skills', 'lineage'), encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONDONTWRITEBYTECODE: '1' } });
    const tail = ((pyRes.stderr || pyRes.stdout || '').trim().split('\n').pop() || '').slice(0, 80);
    const failed = failedTestNames(`${pyRes.stdout || ''}${pyRes.stderr || ''}`).slice(0, 5);
    ok(pyRes.status === 0, `lineage.py regression suite passes under ${py} (${failed.length ? failed.join(', ') : tail})`);
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
    'update-fetch.mjs', 'update-notify.mjs', 'update-checkin.mjs', 'register.mjs', 'graceful-pause.mjs', 'progress.mjs',
    'progress-fallback.mjs'];
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
    path.join('skills', '3d-intro-build', 'references', 'video-pool.test.mjs'),
    ...['preview-lib', 'curate', 'assemble', 'step-nav', 'verify-intro', 'intro-e2e']
      .map((n) => path.join('skills', '3d-intro-build', 'references', `${n}.test.mjs`)),
    path.join('skills', 'payload-mon', 'scripts', 'payload-mon.test.mjs'),
    path.join('skills', 'payload-mon', 'scripts', 'payload-size.test.mjs'),
    path.join('skills', 'tone-compact', 'scripts', 'tone-compact.test.mjs'),
    path.join('skills', 'anti-drm', 'scripts', 'anti-drm.test.mjs'),
    path.join('skills', 'theme-selection', 'scripts', 'themes.test.mjs'),
    path.join('skills', 'omc-patch', 'scripts', 'omc-patch.test.mjs'),
    path.join('skills', 'omc-patch', 'scripts', 'probe-pm.test.mjs'),
    path.join('skills', 'remains', 'scripts', 'boxes.test.mjs'),
    path.join('skills', 'ultra-chain', 'references', 'chain-ledger.test.mjs'),
    path.join('skills', 'ultra-chain', 'references', 'chain-report.test.mjs'),
    path.join('skills', 'ultra-chain', 'references', 'capture.test.mjs'),
    path.join('skills', 'setup-omc-hud', 'scripts', 'claude-update-last.test.mjs'),
    path.join('skills', 'setup-omc-hud', 'scripts', 'apply-hud.test.mjs'),
    path.join('skills', 'setup-omc-hud', 'scripts', 'omc-hud-custom.test.mjs'),
    path.join('skills', 'setup-bypass-permissions', 'scripts', 'bypass-permissions.test.mjs'),
    path.join('skills', 'setup-bypass-permissions', 'scripts', 'fallbacks.test.mjs'),
    path.join('hooks', 'graceful-pause.test.mjs'), path.join('hooks', 'graceful-pause.engine.test.ts'),
    path.join('hooks', 'progress.test.mjs'), path.join('hooks', 'progress.engine.test.ts'), path.join('hooks', 'register.test.mjs'),
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

  // 8) ralph-qa (a backbone of session-model reviewers + CLI seats only on a flag). These lock RULES
  // INTO THE DOC, not rule EXECUTION -- a model that skips the quorum section still passes here. The
  // parts a prose reader could get wrong silently (which model, the family filter, the reason sets)
  // live in `verifier-probe.mjs` and have unit tests.
  // Judged by readFileSync + JS regex on purpose: `execSync('grep -c ...')` THROWS on a passing
  // (zero-match) check and stays silent on a violation, i.e. exactly backwards for a gate.
  const rqSkill = fs.readFileSync(path.join(root, 'skills', 'ralph-qa', 'SKILL.md'), 'utf8');
  const rqFm = rqSkill.slice(0, rqSkill.indexOf('---', 4));
  const rqSurface = JSON.parse(fs.readFileSync(path.join(root, 'codex', 'manifest.json'), 'utf8'))
    .surfaces.find((s) => s.name === 'ralph-qa');
  const rqRefs = ['verifier-probe.mjs', 'payload-scan.mjs', 'gemini-read-only.toml', 'gemini-seat.mjs', 'seat-run.mjs', 'seat-payload.mjs', 'seat-spawn.mjs'];
  const probeRel = path.join('skills', 'ralph-qa', 'references', 'verifier-probe.mjs');
  const probeSrc = fs.readFileSync(path.join(root, probeRel), 'utf8');

  ok(JSON.stringify(rqSurface.supportingFiles) === JSON.stringify(rqRefs.map((f) => `references/${f}`))
     && rqRefs.every((f) => fs.existsSync(path.join(root, 'skills', 'ralph-qa', 'references', f))),
     `S2: ralph-qa supportingFiles is exactly [references/${rqRefs.join(', references/')}] and every file exists`);
  const rqTests = rqRefs.filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join('skills', 'ralph-qa', 'references', f.replace(/\.mjs$/, '.test.mjs')));
  ok(rqTests.every((t) => fs.existsSync(path.join(root, t)) && !fs.existsSync(path.join(pkgRoot, t))),
     'S2-b: the probe, scanner, gemini seat helper and seat runner tests exist in the repo but are NOT npm-packaged (files[] negation holds)');
  // SKILL.md runs both scripts from its own references/ folder, so every shipped copy must carry them.
  ok(rqRefs.every((f) => fs.existsSync(path.join(pkgRoot, 'skills', 'ralph-qa', 'references', f))
       && fs.existsSync(path.join(instDir, 'banker-ralph-qa', 'references', f))),
     'S2-c: the npm package and the Codex install both carry the probe, the scanner, the gemini policy, its seat helper and the seat runner');
  // The limitation must stay stated PRECISELY: per-call effort has no path, but agent-DEFINITION
  // frontmatter does. banker ships no agents, which is the real reason the backbone knob is closed.
  ok(/외부 전용 \(codex\)/.test(rqSkill) && /백본에는 전송 경로가 없다/.test(rqSkill)
     && /백본의 reasoning effort 는 이 스킬이 호출 단위로 지정하지 못한다/.test(rqSkill)
     && /에이전트 정의의 프론트매터/.test(rqSkill) && /banker 는 에이전트를 배포하지 않으므로/.test(rqSkill),
     'S3: --effort is scoped to the codex seat and the backbone limitation names its real cause (no agents shipped)');
  // The backbone runs the SESSION's model: not chosen, inherited. An agent type whose definition
  // pins a model would silently run something else, so the doc must rule those out, and the report
  // must say what actually ran.
  // Explore is the trap: its definition forbids code review, and on a session above Opus it is
  // capped to Opus, so a doc that names it would silently break "the session's model".
  ok(/모델은 세션 모델이다\. 고르지 않고 물려받는다/.test(rqSkill)
     && /`Plan` 유형을 Agent 도구의 `model` 없이 띄운다/.test(rqSkill)
     && /`Explore` 는 쓰지 않는다/.test(rqSkill)
     && /`spawn_agent` 를 `agent_type` 과 `model` 없이 부른다/.test(rqSkill) && /fork_turns="none"/.test(rqSkill)
     && /정의가 모델을 고정한 유형/.test(rqSkill)
     && /추론 강도는 고르는 것이 아니라 물려받는 것이다/.test(rqSkill)
     && /실제로 쓴 모델과 물려받은 강도를 보고의 선언 블록에 적는다/.test(rqSkill)
     && /백본\(선언\): type=Plan · model=<세션 모델>\(상속\)/.test(rqSkill),
     'S18: the backbone is Plan (Claude) or a role-less, unforked spawn_agent (Codex) on the session model, never Explore, and the report discloses type, model and strength');
  ok(/에이전트 정의를 배포해 강도를 박는 길은 의도적으로 닫혀 있다/.test(rqSkill)
     && /런타임 대칭이 깨지고/.test(rqSkill),
     'S20: the closed agent-definition path is recorded as a decision with its reason, not as an accident');
  // External seats sit only on a flag, and working out their model sends nothing anywhere: the
  // probe reads local config and the CLI's bundled list. A network call in the probe source, or an
  // automatic seat in the doc, is the regression this guards.
  // opencode empties its cache folder (the models.dev copy the probe reads) on a start that finds
  // the folder's version file missing or old, so the probe starts no opencode at all.
  ok(/외부 좌석은 플래그를 줄 때만 앉는다/.test(rqSkill)
     && /프로브는 HTTP 요청도 프롬프트도 보내지 않는다/.test(rqSkill)
     && !/\bfetch\(|node:https?['"]|\bcurl\b|urllib/.test(probeSrc)
     && !/run\("opencode"/.test(probeSrc) && /gemini 와 opencode 는 띄우지 않는다/.test(rqSkill)
     && /좌석 명령과 정리 명령은 `OPENCODE_DISABLE_MODELS_FETCH=1` 과 `OPENCODE_DISABLE_AUTOUPDATE=1` 로 띄우고/.test(rqSkill),
     'S21: external seats need a flag, the probe source has no network path, the probe starts no opencode, and the seat starts it with its model-list refresh off');
  // The API-credential seats were removed on request; neither the doc nor the probe may keep them.
  ok(!/external:api|gemini-api|OPENAI_API_KEY|RALPH_QA_NO_DEFAULT_ENDPOINT|--external=/.test(rqSkill)
     && !/OPENAI_API_KEY|GEMINI_API_KEY|RALPH_QA_NO_DEFAULT_ENDPOINT/.test(probeSrc),
     'S19: the API-credential seats and --external are gone from SKILL.md and the probe');
  ok(!/falls back to same-runtime/.test(fs.readFileSync(path.join(root, 'codex', 'transform-matrix.md'), 'utf8')),
     'S4: transform-matrix.md no longer documents a same-runtime critic fallback (that is self-approval on Codex)');
  ok(!/Codex CLI 우선|그것도 없으면|가장 강한 가용 모델/.test(rqFm)
     && ['ralph-qa', '교차검증', '다른 LLM으로 검증', '독립 QA'].every((t) => rqFm.includes(t)),
     'S5: ralph-qa frontmatter drops the old ladder and strongest-model wording and keeps all 4 trigger phrases');
  ok(/\| 전송 경로 \| 확인 수준 \|/.test(rqSkill) && !/전달 메커니즘/.test(rqSkill),
     'S6: flag table uses the 전송 경로/확인 수준 columns (old 전달 메커니즘 header gone)');
  const rqReadmeRows = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    .split(/\r?\n/).filter((l) => /^\|/.test(l) && /ralph-qa/.test(l));   // the two table rows, not prose mentions
  ok(rqReadmeRows.length === 2 && rqReadmeRows.every((l) => !/폴백|최후/.test(l) && /세션 모델/.test(l)),
     `S7: both README ralph-qa rows describe the session-model backbone without fallback wording (rows: ${rqReadmeRows.length})`);
  // Anchor each trigger to its position in the disjunction list (`⟸`/`∨`), not to a bare mention.
  ok(/INCONCLUSIVE ⟸ 좌석 상실/.test(rqSkill) && /∨ 동일 좌석 ERROR 2연속/.test(rqSkill)
     && /∨ 좌석 총합 0/.test(rqSkill) && /∨ 세션 모델 좌석 3 미만/.test(rqSkill)
     && /∨ --max 소진 \+ 미해소 blocker 잔존/.test(rqSkill),
     'S8: all five INCONCLUSIVE trigger conditions are present in the quorum section');
  ok(/\{APPROVE, ITERATE, REJECT, ERROR\}/.test(rqSkill) && /VERDICT: <값>/.test(rqSkill)
     && /ERROR = 좌석 유지 \+ APPROVE 차단/.test(rqSkill),
     'S9: seat verdict domain is 4-valued with a strict VERDICT token and ERROR keeps the seat while blocking APPROVE');
  // Three or more internal seats is a quorum conjunct, and a smaller --agents is raised, not obeyed.
  // Only seats on the session model count: a role or a sub-agent model setting that runs another
  // model leaves a seat outside the quorum.
  ok(!/external=[a-z|\\]*only/.test(rqSkill) && /내부 좌석 ≥ 3 — 세션 모델 좌석만 센다/.test(rqSkill) && /최소 3/.test(rqSkill)
     && /3 미만을 주면 3으로 올리고/.test(rqSkill)
     && /세션 모델과 다른 모델이면 그 좌석은 세션 모델 좌석이 아니라 정족수의 `내부 좌석 ≥ 3` 에 세지 않는다/.test(rqSkill)
     && /∧ \(세션 모델 좌석의 과반이 APPROVE\)/.test(rqSkill) && !/∧ \(내부 좌석의 과반이 APPROVE\)/.test(rqSkill),
     'S10: 내부 좌석 >= 3 and the APPROVE majority count session-model seats only, and --agents below 3 is raised to 3 (no vacuous small-quorum APPROVE)');
  ok(/프로브\(관측\):/.test(rqSkill) && /좌석\(선언\):/.test(rqSkill)
     && /"증거"라고 부르지 않는다/.test(rqSkill),
     'S11: the report contract separates observed from declared and refuses to call declared values evidence');
  ok(/출처-독립 좌석은 저자가 쓴 요약을 받지 않는다/.test(rqSkill) && /출처-독립 1 포함/.test(rqSkill),
     'S12: the source-independent seat is defined in step 1 and surfaced in the report');
  ok(/종결어:\s+APPROVE\(3축\)/.test(rqSkill) && /APPROVE\(모델축 미커버 — 환경\)\s+— 외부 0/.test(rqSkill)
     && /APPROVE\(모델축 미커버 — 저자 요청\)\s+— 외부 0/.test(rqSkill),
     'S13: all three APPROVE terminal labels are defined in the quorum block (coverage survives one-line quoting)');
  ok(/좌석 식별자: \(종류, 렌즈\)/.test(rqSkill)
     && /집합 S_k 에 대해 S_k ⊆ S_\{k\+1\} 이어야 한다/.test(rqSkill)
     && /좌석 상실 \(원인 불문/.test(rqSkill)
     && /백본 좌석의 blocker 도 좌석 재생성으로 소멸하지 않는다/.test(rqSkill),
     'S14: seat identity is monotone across iterations, so re-rolling backbone seats cannot erase dissent');
  ok(/INCONCLUSIVE 소비 규칙 — 통과가 아니다/.test(rqSkill) && /APPROVE 취급 금지/.test(rqSkill)
     && /사람의 명시적 판단을 요구하고 멈춘다/.test(rqSkill),
     'S15: INCONCLUSIVE has consumption rules (not a pass, per-cause next action, human judgement on repeat)');
  // Set EQUALITY between a probe list and its SKILL.md definition line, plus the count stated in that
  // line: a hardcoded copy here would close one edge only (a token added on either side slips by).
  // Read from source text because the probe is ESM and this file is CJS.
  const listIn = (name) => [...(((probeSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`)) || [])[1] || '')
    .matchAll(/'([^']+)'/g))].map((m) => m[1]);
  const docLine = (label) => rqSkill.split(/\r?\n/).find((l) => new RegExp(`\\*\\*${label} \\d+종\\.\\*\\*`).test(l)) || '';
  const sameSet = (probeTokens, line, label) => {
    const docTokens = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const stated = Number((line.match(new RegExp(`${label} (\\d+)종`)) || [])[1] || 0);
    const missing = probeTokens.filter((t) => !docTokens.includes(t));
    const extra = docTokens.filter((t) => !probeTokens.includes(t));
    return { pass: probeTokens.length > 0 && !missing.length && !extra.length && stated === probeTokens.length,
      detail: `probe ${probeTokens.length} / doc ${docTokens.length} / stated ${stated}`
        + `${missing.length ? ', missing: ' + missing.join(', ') : ''}${extra.length ? ', extra: ' + extra.join(', ') : ''}` };
  };
  const absentSet = sameSet(listIn('ABSENT_REASONS'), docLine('사유 토큰'), '사유 토큰');
  ok(absentSet.pass && /직전 실행이 `INCONCLUSIVE` 인데 외부 플래그를 빼고 다시 돌렸다면/.test(rqSkill),
     `S16: SKILL.md's reason-token line equals the probe's ABSENT_REASONS and the stated count matches (${absentSet.detail})`);
  ok(/--max 소진은 항상 종결이다/.test(rqSkill) && /ITERATE\(한도 소진\)/.test(rqSkill)
     && /어느 갈래도 통과가 아니다/.test(rqSkill) && /같은 이슈가 3회\+ 재발/.test(rqSkill),
     'S17: --max exhaustion always terminates via two branches, neither of which is a pass');
  // Which model a CLI seat runs is the probe's call, and the doc's table of reasons must be the
  // probe's own; two external seats on one model must be disclosed, not counted as two axes.
  const decisionSet = sameSet(listIn('DECISION_REASONS'), docLine('모델 결정 사유'), '모델 결정 사유');
  ok(decisionSet.pass
     && /외부 좌석끼리도 같은 모델이면 모델 축은 하나다/.test(rqSkill)
     && /모델 부적격은 착석 전에만 갈아탈 수 있다/.test(rqSkill)
     && /물을 수 없는 실행/.test(rqSkill),
     `S22: SKILL.md's model-decision reasons equal the probe's DECISION_REASONS, with the no-one-to-ask fallback and same-model disclosure (${decisionSet.detail})`);
  // 0.20.5 (B3-12): the send runs in references/seat-run.mjs (folders, payload, scan, seats, limits, cleanup). Its tests
  // pin the seat commands of 0.20.4 word for word and run them against fake CLIs. The doc keeps what the model decides
  // and reads: these lock that the doc calls the runner, holds its stop and result sets, keeps the decisions, and builds
  // no seat command or git chain by hand.
  const rqRef = (f) => fs.readFileSync(path.join(root, 'skills', 'ralph-qa', 'references', f), 'utf8');
  const runnerFiles = ['seat-run.mjs', 'seat-payload.mjs', 'seat-spawn.mjs'];
  const runnerSrc = runnerFiles.map(rqRef);
  const sendSection = (rqSkill.split('## 외부 좌석 전송')[1] || '').split(/\n## /)[0];
  const exported = (name) => [...(((runnerSrc[0].match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`)) || [])[1] || '')
    .matchAll(/"([^"]+)"/g))].map((m) => m[1]);
  // The code spans of one column of the rows under a table header of the send section.
  const tableCells = (header, col) => {
    const lines = sendSection.split('\n');
    const at = lines.findIndex((l) => l.startsWith(header));
    const rows = [];
    for (let i = at + 2; at >= 0 && i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].split('|')[col + 1] || '');
    return rows.flatMap((c) => [...c.matchAll(/`([a-z-]+)(?::<[^>]+>)?`/g)].map((m) => m[1]));
  };
  const setGap = (a, b) => [...new Set(a)].filter((x) => !b.includes(x));
  const stopCodes = exported('STOP_CODES');
  const stopRows = tableCells('| `stop` |', 0);
  const seatWhy = exported('SEAT_WHY');
  const whyRows = tableCells('| `status` |', 1);
  const gaps = [...setGap(stopCodes, stopRows).map((x) => `stop table lacks ${x}`), ...setGap(stopRows, stopCodes).map((x) => `stop table has ${x}`),
    ...setGap(seatWhy, whyRows).map((x) => `result table lacks ${x}`), ...setGap(whyRows, seatWhy).map((x) => `result table has ${x}`)];
  ok(['init', 'untracked', 'prepare', 'check', 'send', 'cleanup', 'put'].every((c) => new RegExp(`seat-run\\.mjs['"]? ${c}\\b`).test(sendSection))
     && /`<R>` 은 `<이 스킬 디렉터리 절대경로>\/references` 다/.test(sendSection)
     && stopCodes.length >= 20 && seatWhy.length >= 15 && gaps.length === 0,
     `S25: the send section calls the runner's seven commands, and its stop and seat-result tables hold the runner's sets (stops ${stopCodes.length}, results ${seatWhy.length}${gaps.length ? '; ' + gaps.join('; ') : ''})`);
  const banned = [[/node:(?:https?|net|tls|dgram|dns)['"]/, 'a network module'], [/\bfetch\(/, 'fetch'], [/shell:\s*true/, 'shell: true'],
    [/import \{[^}]*\bexec(?:Sync|File|FileSync)?\b[^}]*\} from ["']node:child_process["']/, 'exec'], [/node:crypto/, 'node:crypto'],
    [/(?:spawn(?:Sync)?|which|runLimited)\(\s*\{?\s*(?:exe:\s*)?["'`](?:[\w./\\-]*[\/\\])?(?:timeout|perl)(?:\.exe)?["'`]/, 'a timeout program']];
  const bannedHits = runnerFiles.flatMap((f, i) => banned.filter(([re]) => re.test(runnerSrc[i])).map(([, what]) => `${f}: ${what}`));
  ok(bannedHits.length === 0 && /System32/.test(runnerSrc[2]) && /taskkill\.exe/.test(runnerSrc[2]) && /cmd\.exe/.test(runnerSrc[2]),
     `S25-b: the runner holds no network module, shell, exec, node:crypto or timeout program, and takes taskkill and cmd.exe from System32${bannedHits.length ? ` (${bannedHits.join('; ')})` : ''}`);
  // The plans as the runner makes them, from a child node (the runner is ESM): every guard of the device table.
  const planJs = `import { seatPlan } from ${JSON.stringify(require('url').pathToFileURL(path.join(root, 'skills', 'ralph-qa', 'references', 'seat-run.mjs')).href)};
const base = { d: '/d/ralph-qa.x', o: '/d/ralph-qa-out.x', id: 'a1b2c3d4', policy: '/p.toml', mcpServers: ['alpha'] };
console.log(JSON.stringify(['codex', 'gemini', 'opencode'].map((cli) => seatPlan({ ...base, cli, model: cli === 'opencode' ? 'p/m' : 'm1' }))));`;
  let plans = [];
  try {
    plans = JSON.parse(cp.execFileSync(process.execPath, ['--input-type=module', '-e', planJs], { encoding: 'utf8' }));
  } catch { /* no plans: the assertion below fails */ }
  const [cxPlan = {}, gmPlan = {}, ocPlan = {}] = plans;
  const pairs = (args = []) => args.slice(0, -1).map((a, i) => `${a} ${args[i + 1]}`);
  const cxPairs = pairs(cxPlan.args);
  const ocConfig = (() => { try { return JSON.parse(ocPlan.set.OPENCODE_CONFIG_CONTENT); } catch { return {}; } })();
  const gmPolicyText = rqRef('gemini-read-only.toml');
  const gmPolicy = /[^\t\r\n\x20-\x7e]/.test(gmPolicyText) ? ['not ASCII'] : gmPolicyText
    .split(/\r?\n/).map((l) => l.replace(/#.*/, '').replace(/^[ \t]+|[ \t\r]+$/g, '')).filter(Boolean);
  ok(['multi_agent', 'hooks', 'plugins', 'apps', 'shell_tool'].every((f) => cxPairs.includes(`--disable ${f}`))
     && ['notify=[]', 'analytics.enabled=false', 'web_search=disabled', 'mcp_servers.alpha.enabled=false', 'otel.exporter="none"',
       'otel.trace_exporter="none"', 'otel.metrics_exporter="none"'].every((v) => cxPairs.includes(`-c ${v}`))
     && ['--ephemeral', '--ignore-rules', '--skip-git-repo-check'].every((f) => (cxPlan.args || []).includes(f)) && cxPairs.includes('-s read-only')
     && ['--skip-trust', '--approval-mode default', '--allowed-mcp-server-names ralph-qa-none', '-e none', '--admin-policy /p.toml'].every((f) => pairs(gmPlan.args).includes(f) || (gmPlan.args || []).includes(f))
     && JSON.stringify(gmPlan.set) === JSON.stringify({ TMPDIR: '/d/ralph-qa-out.x', TEMP: '/d/ralph-qa-out.x', TMP: '/d/ralph-qa-out.x', GEMINI_SANDBOX: 'false', GEMINI_TELEMETRY_LOG_PROMPTS: 'false' })
     && JSON.stringify(gmPlan.unset) === JSON.stringify(['GEMINI_CLI_IDE_WORKSPACE_PATH'])
     && ['OPENCODE_PERMISSION', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE',
       'OPENCODE_DISABLE_SHARE', 'OPENCODE_DISABLE_CLAUDE_CODE'].every((k) => k in (ocPlan.set || {}))
     && ocConfig.share === 'disabled' && ocConfig.agent?.compaction?.disable === true && ocConfig.agent?.['ralph-qa-review-a1b2c3d4']?.permission?.['*'] === 'deny'
     && JSON.stringify(ocPlan.check) === JSON.stringify(['debug', 'agent', 'ralph-qa-review-a1b2c3d4', '--pure'])
     && pairs(ocPlan.args).includes('--agent ralph-qa-review-a1b2c3d4') && !(ocPlan.args || []).includes('-f')
     && JSON.stringify(gmPolicy) === JSON.stringify(['[[rule]]', 'toolName = "*"', 'decision = "deny"', 'priority = 100']),
     'S25-c: the runner\'s plans carry every guard of the device table (codex\'s five --disable and its -c set with each MCP server off, gemini\'s policy, env and flags, opencode\'s env, per-run agent and its check) and the shipped gemini policy is deny-all');
  const tooNew = [[/Object\.hasOwn\(/, 'Object.hasOwn'], [/\bstructuredClone\(/, 'structuredClone'], [/\.findLast(?:Index)?\(/, 'findLast'],
    [/AbortSignal\.timeout\(/, 'AbortSignal.timeout'], [/\bcause:/, 'Error cause'], [/\.toSorted\(|\.toReversed\(|\.toSpliced\(/, 'change-array-by-copy']];
  const newHits = runnerFiles.flatMap((f, i) => tooNew.filter(([re]) => re.test(runnerSrc[i])).map(([, what]) => `${f}: ${what}`));
  ok(newHits.length === 0, `S25-d: the runner uses no API newer than Node 16.7, package.json's engines floor${newHits.length ? ` (${newHits.join('; ')})` : ''}`);
  const rqBlocks = [...rqSkill.matchAll(/```(?:bash|powershell|sh)\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  ok(!/codex exec|gemini --skip-trust|opencode run|GIT_INDEX_FILE|add -N|mktemp -d|<상한>/.test(rqBlocks)
     && !/<상한>|GIT_INDEX_FILE=|cp -p "\$i"|new-files\.md|payload-scan\.mjs" "\$d/.test(rqSkill) && /\*\*좌석 명령과 git 사슬을 손으로 짜지 않는다\.\*\*/.test(sendSection)
     && /\*\*좌석 명령과 git 사슬을 손으로 짜지 마라\.\*\*/.test(rqSkill),
     'S25-e: the skill builds no seat command, git chain or time limit by hand, and says so in the section and in the traps');
  ok(/512 KiB\(524288 바이트\)를 넘는다는 뜻이다\. 보내기 전에 사용자에게 묻는다\. 물을 수 없는 실행이면 보내지 않고 그 좌석은 `cli-call-failed` 다\. 사용자가 보내지 않기로 하면 `model-declined` 다\. 상한은 나누기 전의 `prompt\.md` 전체에 건다/.test(sendSection)
     && /첫 판정 뒤의 반복이면 그 좌석은 `ERROR` 다/.test(sendSection) && /부분마다 표지를 세고 3단계 검사를 다시 해 0건일 때만 보낸다/.test(sendSection)
     && /백그라운드 작업 중지 도구\(`TaskStop`\)로 멈춘다\. 그러면 실행기와 좌석의 프로세스 트리 전체가 멈춘다\(Linux, macOS 실측\)/.test(sendSection)
     && /Claude Code 의 Bash 도구는 시간 제한을 넘긴 명령을 죽이지 않고 백그라운드로 넘겨 계속 돌린다/.test(sendSection)
     && /하위 에이전트로 돌면 send 가 끝나고 6단계 정리를 마친 뒤에 최종 답을 낸다/.test(sendSection)
     && /상한에 걸린 좌석, 멈춘 좌석, 빈 답은 `ERROR` 다\. 모델 거절로 보고 갈아타지 않는다/.test(sendSection)
     && /node 의 `os\.tmpdir\(\)` 는 POSIX 에서 `TMPDIR` 을, Windows 에서 `TEMP` 와 `TMP` 를 읽는다/.test(sendSection)
     && /자체 샌드박스 안에서 다시 뜬다\(docker, podman 컨테이너\. macOS 에서 값이 `true` 면 `sandbox-exec`\)\. 컨테이너 안에는 정책 파일이 없어/.test(sendSection)
     && /<<'RALPHQA_<id>'/.test(sendSection) && !/RALPHQA_EOF/.test(rqSkill) && /`'@` 로 시작하는 줄이 있으면 here-string 으로 쓰지 않고 그 좌석은 `cli-call-failed` 다/.test(sendSection)
     && /`외부 전송\(선언\)` 줄은 send 출력의 `declared` 를 옮겨 적는다/.test(sendSection)
     && /`\/tmp` 처럼 여러 계정이 쓰는 폴더 아래에는 만들지 않는다/.test(sendSection) && /0건이 안전의 증명은 아니다/.test(sendSection)
     && /`end` 가 `null` 이면 보내지 않는다/.test(sendSection) && /보내기 직전 고른 모델로 프로브를 다시 불러/.test(sendSection) && /모델은 다시 정하지 않는다/.test(sendSection)
     && /모델을 다시 정하는 재프로브 금지/.test(rqSkill) && /`\.project_root` 없이 다시 만든 기록 폴더는 `projects\.json` 의 좌석 경로로 찾는다/.test(sendSection)
     && /제목이 `ralph-qa-review-` 로 시작하고 `directory` 가 같은 기준 폴더의 `ralph-qa\.<영숫자>\/opencode` 인데 그 폴더가 없는 세션/.test(sendSection)
     && /\| `decision: unseated` \+ `reason` \| 앉을 수 없음 \| 사유와 `notes` 를 좌석 줄에 적는다 \|/.test(rqSkill)
     && /`apply_patch`\(읽기 전용 샌드박스가 `patch rejected` 로 막는다\)/.test(rqSkill) && /`model:` 줄/.test(sendSection)
     && /실행기는 gemini 좌석의 `TMPDIR`, `TEMP`, `TMP` 를 답 폴더로 둔다/.test(rqSkill),
     'S25-f: the send section keeps the decisions and their reasons: the 512 KiB question on the whole, the seat tokens before and after a first verdict, TaskStop and the sub-agent order, gemini\'s temp and sandbox reasons, the put fallbacks, the declared line, the probe called again without choosing again');
  ok(/`<review-data id="<id>">`/.test(rqSkill) && /실행마다 무작위 id/.test(rqSkill)
     && /파일을 쓰지 않고, 모델 호출/.test(rqSkill) && /게이트 결과/.test(rqSkill),
     'S24: every seat\'s instructions open with a per-run data boundary and the no-write rule, and the author passes gate output');
  // 0.20.4 B3: the probe names where it read a codex config short, an escaped key unseats codex, and a seat or cleanup
  // start of opencode may empty its models.dev copy.
  ok(/프로브가 자리를 잡지 못한 줄/.test(rqSkill) && /정하거나 프로브가 그 파일을 끝까지 읽지 못하면 좌석을 세우지 않는다/.test(rqSkill)
     && /따옴표 키에 이스케이프\(`\\`\)가 든 설정/.test(rqSkill),
     'S22-b: the codex unseat list names a line the probe could not place, an escaped quoted key and a managed file read short');
  ok(/그 시작이 models\.dev 사본\(`~\/\.cache\/opencode\/models\.json`\)을 지우고/.test(rqSkill) && /프로브는 그 경우 `notes` 에 까닭을 적는다/.test(rqSkill),
     'S21-b: the limits say a seat or cleanup start of opencode may empty its models.dev copy, and the probe says so');
  ok(/\+ `<d>\/unsent\.md`\(diff 에 싣지 않은 새 파일 목록/.test(rqSkill) && /`prepare` 가 만든 `<d>\/raw\.md`/.test(rqSkill),
     'S12-b: the source-independent seat gets the raw parts of prepare and the list of new files left out of the diff');

  // 9) airgap (0.20.4 B7): with no network a skill neither waits on every command nor reports a stale or empty result
  // as a success.
  const ubSkill = fs.readFileSync(path.join(root, 'skills', 'update-banker', 'SKILL.md'), 'utf8');
  const ubStep0 = ubSkill.slice(ubSkill.indexOf('### 0. 관측'), ubSkill.indexOf('### 1. npm 먼저'));
  ok(/^in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'; P=\$\?/m.test(ubStep0) && ubStep0.indexOf('npm ping') < ubStep0.indexOf('npm view')
     && /^\[ "\$P" = 0 \] && \(cd ~ && npm view @kaydash9999\/banker-plugins version --fetch-retries=0 --fetch-timeout=10000\)$/m.test(ubStep0)
     && /--cache "\$T" --no-update-notifier; r=\$\?/.test(ubStep0) && /ping 이 15초 감시에 걸려 멈췄으면\(종료 143\) 이 확인은 하지 않는다/.test(ubStep0)
     && /레지스트리에 닿지 못하면\(`npm ping` 의 종료 코드가 0 이 아님\) .* 어느 채널도 바꾸지 않고 멈춘다/.test(ubStep0)
     && /`npm` 이 없으면\(명령 없음, 종료 코드 127\) 레지스트리 문제가 아니다/.test(ubStep0)
     && ubSkill.split(/\r?\n/).filter((l) => /npm view @kaydash9999\/banker-plugins version/.test(l)).every((l) => /--fetch-retries=0/.test(l)),
     'airgap-1: update-banker checks the registry is reachable before npm view, stops when it is not (npm missing is no registry fault), and npm view never waits on retries');
  // A script piped from a download into a shell exits 0 when the download fails (the pipe's code is the shell's):
  // every SKILL and command saves the script first and runs it only when it came.
  const mdDocs = [...fs.readdirSync(path.join(root, 'skills')).map((d) => path.join('skills', d, 'SKILL.md')),
    ...fs.readdirSync(path.join(root, 'commands')).filter((f) => f.endsWith('.md')).map((f) => path.join('commands', f))]
    .filter((f) => fs.existsSync(path.join(root, f)));
  // Lines joined at a trailing backslash first; a download fed to a shell through `<(…)` or `"$(…)"` or `env`, or to iex
  // in PowerShell, is the same pipe.
  const piped = mdDocs.flatMap((f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
    .filter((l) => /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo(?:\s+-\S+)*\s+)?(?:(?:\/\S*\/)?env(?:\s+(?:-\S+|[A-Za-z_]\w*=\S*))*\s+)?(?:\/\S*\/)?(?:ba|z)?sh\b/.test(l)
      || /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?(?:<\(|\$\()\s*(?:curl|wget)\b/.test(l) || /(?:^|[\s;&|(])(?:source|\.)\s+<\(\s*(?:curl|wget)\b/.test(l) || /\beval\s+["']?\$\(\s*(?:curl|wget)\b/.test(l)
      || /\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^|\n]*\|\s*(?:iex|Invoke-Expression)\b/i.test(l)
      || /\b(?:iex|Invoke-Expression)\b\s*\(+\s*(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest|New-Object)\b/i.test(l))
    .map((l) => `${f}: ${l.trim().slice(0, 60)}`));
  ok(piped.length === 0, `airgap-3: no SKILL or command pipes a download into a shell (found ${JSON.stringify(piped)})`);
  // A skill that downloads first sees whether its sources answer within 10 s and reports "오프라인이라 설치하지 않음"
  // instead of waiting on every command (npm 70 s, curl and git without end); the curl, wget and git calls left have limits.
  const DL_DOCS = ['setup-node', 'setup-python', 'setup-java', 'setup-lsp', 'setup-playwright', 'setup-mcp', 'setup-stitch',
    'setup-tmux', 'setup-pwsh', 'setup-sandbox', 'setup-omc', 'setup-harness-factory', 'setup-insane-search', 'docs-setup',
    'vertical-pptx-setup', 'motion-graphic-setup', '3d-intro-setup', 'audit-security'].map((d) => path.join('skills', d, 'SKILL.md'))
    .concat(path.join('commands', 'setup.md'));
  const NET_CHECK = /\bin15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'|\(cd ~ && npm ping --fetch-retries=0 --fetch-timeout=10000\)|curl(?:\.exe)?(?: --ssl-no-revoke)? (?:-K - )?-sSI -o (?:\/dev\/null|NUL) --connect-timeout 5 --max-time 10\b/;
  const DOWNLOADS = /\b(?:curl|wget|git(?: -c \S+)* clone|npx|npm (?:i|install)\b|pip3? install|pipx install|uv tool install|uvx|dnf (?:-y )?install|apt(?:-get)? (?:-y )?install|brew install|winget install|Invoke-RestMethod|Invoke-WebRequest|nvm install|playwright install|claude plugin (?:marketplace add|install)|omc update)\b/;
  // Code blocks only (a sentence that quotes a command runs nothing), trailing comments cut.
  const codeBlocks = (text) => [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => ({ at: m.index, lines: m[1].split('\n').map((l) => l.replace(/\s#\s.*$/, '')).filter((l) => !/^\s*#/.test(l)) }));
  const joinedLines = (text) => codeBlocks(text).flatMap((b) => b.lines.join('\n').replace(/\\\n\s*/g, ' ').split('\n'));
  const firstBlockAt = (text, pick) => (codeBlocks(text).find((b) => b.lines.some(pick)) || { at: Infinity }).at;
  const isNetCheck = (l) => NET_CHECK.test(l);
  // A version query downloads nothing (`npx --version`, `curl -V`); `curl -v` is verbose and still downloads.
  const VERSION_QUERY = /\b(?:npx|uvx|pipx)\s+--version\b|\b(?:curl|wget)\s+(?:--version|-V)\b/g;
  const isDownload = (l) => !isNetCheck(l) && !/\bcommand -v\b/.test(l) && DOWNLOADS.test(l.replace(VERSION_QUERY, ''));
  const unchecked = DL_DOCS.filter((f) => {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    const at = firstBlockAt(t, isNetCheck);
    return at === Infinity || at > firstBlockAt(t, isDownload) || !/오프라인이라 설치하지 않음/.test(t);
  });
  // The npm check runs in the home folder (a project's .npmrc must not pick the registry or a token), and a web check
  // asks for the head only (a body of tens of MB must not decide "offline" on a slow line).
  const leaky = [...DL_DOCS, path.join('skills', 'update-banker', 'SKILL.md')].flatMap((f) => codeBlocks(fs.readFileSync(path.join(root, f), 'utf8'))
    .flatMap((b) => b.lines).filter((l) => (/\bnpm (?:ping|view)\b/.test(l) && !/\(cd ~ && (?:T=\$\(mktemp -d\) && \{ )?npm (?:ping|view)\b|\bin15 sh -c 'cd ~ && exec npm ping\b/.test(l))
      || /curl(?:\.exe)? -sS -o (?:\/dev\/null|NUL) --connect-timeout/.test(l) || /pypi\.org\/simple\/(?:\s|$)/.test(l))
    .map((l) => `${f}: ${l.trim().slice(0, 60)}`));
  ok(leaky.length === 0, `airgap-4c: the npm checks run in the home folder and the web checks ask for the head of a small page (found ${JSON.stringify(leaky)})`);
  // A mirror that does not answer `npm ping` is no offline network: the npm checks ask once more for the skill's own
  // package with an empty cache (no stale value can come). A PC with no npm yet is unchecked, not offline. /banker:setup
  // skips only what comes from the web, and the OS package manager steps are tried (they use their own mirrors).
  const npmDocs = DL_DOCS.filter((f) => f !== path.join('commands', 'setup.md') && codeBlocks(fs.readFileSync(path.join(root, f), 'utf8'))
    .some((b) => b.lines.some((l) => /\(cd ~ && npm ping\b|\bin15 sh -c 'cd ~ && exec npm ping\b/.test(l))));
  // The package asked for is one the skill installs (npm i, npm install, npx, in a code block or a quoted command).
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const installsPkg = (t, pkg) => [...joinedLines(t), ...[...t.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1])]
    .some((l) => /\bnpm (?:i|install)\b|\bnpx\b/.test(l) && !/\bnpm view\b/.test(l) && new RegExp(`(?:^|\\s)${reEsc(pkg)}(?:@|\\s|\\)|$)`).test(l));
  const noFallback = npmDocs.filter((f) => {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    const m = /`\(cd ~ && T=\$\(mktemp -d\) && \{ npm view (\S+) version --fetch-retries=0 --fetch-timeout=10000 --cache "\$T" --no-update-notifier; r=\$\?; rm -rf "\$T"; exit \$r; \}\)` 도 실패해야 오프라인으로 본다\. 이 스킬이 설치할 패키지\(`\1`\)를 빈 캐시로 물으므로 옛 값이 나올 수 없다\. ping 이 15초 감시에 걸려 멈췄으면\(종료 143\) 이 확인은 하지 않는다\./.exec(t);
    return !m || !installsPkg(t, m[1]) || !/`npm` 이 없으면\(명령 없음\) 오프라인이 아니라 확인하지 못한 것이다/.test(t);
  });
  const setupCmd = fs.readFileSync(path.join(root, 'commands', 'setup.md'), 'utf8');
  ok(npmDocs.length >= 8 && noFallback.length === 0
     && /`npm` 이 아직 없으면\(새 PC\) npm 쪽은 오프라인이 아니라 확인하지 못한 것이다/.test(setupCmd)
     && /결과는 알림으로만 쓰고, 이것만으로 항목을 건너뛰지 않는다/.test(setupCmd)
     && /항목을 건너뛸지는 각 스킬의 0단계가 그 스킬의 원천으로 정한다/.test(setupCmd) && !/웹 원천에서 받는 항목만 시도하지 않고/.test(setupCmd)
     && /OS 패키지 관리자\(dnf, apt, brew, winget\)만 쓰는 단계는 .*이 확인과 관계없이 각 스킬의 규칙대로 시도한다/.test(setupCmd)
     && /이 실행에서 부르는 스킬의 0단계는 \/banker:setup 0단계와 앞 스킬이 이미 돌린 같은 확인 줄\(같은 명령과 같은 주소\)의 결과를 쓰고 다시 돌리지 않는다\. 처음 보는 원천만 새로 본다\. 결과는 이 실행 안에서만 쓴다/.test(setupCmd)
     && /원천에 닿는지 한 번 본다\(curl 은 10초, npm 은 15초 안\)/.test(setupCmd) && !/각 10초 안/.test(setupCmd),
     `airgap-4d: a mirror without ping and a PC without npm are not read as offline, /banker:setup skips nothing on its own check, and the OS package manager steps are tried (npm docs ${npmDocs.length}, no fallback: ${JSON.stringify(noFallback)})`);
  ok(unchecked.length === 0, `airgap-4: each downloading skill and /banker:setup checks its sources before the first download (unchecked: ${JSON.stringify(unchecked)})`);
  // Each web source a skill downloads from has its own check line: the host of every address a curl, wget, git clone
  // or PowerShell download reads (variables set to an address in the same document resolved), npm for npm and npx,
  // PyPI for pip, pipx and uv, nodejs.org for nvm, GitHub for Claude Code plugin marketplaces. OS package managers keep
  // their own mirrors and are not checked (the documents say so).
  const hostOf = (u) => { const m = /^https?:\/\/(?:[^/@\s]*@)?([^/:"'$\s]+)/.exec(u); return m ? m[1].toLowerCase() : null; };
  const URLS = /https?:\/\/[^\s"'`)<>]+/g;
  // An installer command and the source it reads (`npm view` only asks for a version: no npm download).
  const INSTALLERS = [
    [/\bnpm (?:i|install)\b|\bnpx\b/, 'npm', /\bnpm view\b/],
    [/\bpip3? install\b|\bpipx install\b|\buv tool install\b|\buvx\b|-m pip install\b/, 'pypi'],
    [/\bnvm install\b/, 'nodejs.org'],
    [/\bclaude plugin (?:marketplace add|install)\b|\bomc update\b/, 'github.com'],
    [/nvm-sh\/nvm\/\S*\/install\.sh/, 'github.com'],   // nvm's install.sh clones from github.com when git is there
    [/\bplaywright install\b/, 'cdn.playwright.dev'],   // the browser download server (playwright-core 1.58 to 1.64)
  ];
  // The hosts a download line reads: its addresses, and the variables it quotes that are set to an address.
  const urlHosts = (l, vars) => (/\b(?:curl|wget)\b|\bgit\b.*\bclone\b|\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b|\bdnf (?:-y )?install -y https?:\/\//i.test(l)
    ? [...[...l.matchAll(URLS)].map((m) => m[0]), ...[...l.matchAll(/"\$\{?(\w+)\}?"/g)].map((m) => vars[m[1]]).filter(Boolean)].map(hostOf)
    : []);
  const sourcesOf = (lines) => {
    const vars = {};
    for (const l of lines) for (const m of l.matchAll(/\b(\w+)=["']?(https?:\/\/[^"'\s]+)/g)) vars[m[1]] = m[2];
    const out = new Set();
    for (const l of lines.filter((x) => !isNetCheck(x) && !/\bcommand -v\b|Get-Command\b/.test(x))) {
      for (const h of urlHosts(l, vars)) out.add(h);
      for (const [re, src, not] of INSTALLERS) if (re.test(l.replace(VERSION_QUERY, '')) && !(not && not.test(l))) out.add(src);
    }
    out.delete(null);
    return out;
  };
  const checksOf = (lines) => {
    const out = new Set();
    // A check fed `printf 'url = …' "$V…"` reads the address the document gives V as its default (`V="${…:-https://host}"`).
    const defaults = {};
    for (const l of lines) { const m = /^(\w+)="\$\{[^"]*:-(https?:\/\/[^}"]+)\}+"/.exec(l); if (m) defaults[m[1]] = m[2]; }
    for (const l of lines.filter(isNetCheck)) {
      const fed = /^printf 'url = [^|]*"\$\{?(\w+)\}?[\/"]/.exec(l);
      if (/\bnpm ping\b/.test(l)) out.add('npm');
      else if (/"\$I\/pip\/"/.test(l)) out.add('pypi');
      else if (fed && defaults[fed[1]]) out.add(hostOf(defaults[fed[1]]));
      else for (const m of l.matchAll(URLS)) out.add(hostOf(m[0]));
    }
    return out;
  };
  const uncovered = DL_DOCS.flatMap((f) => {
    const lines = joinedLines(fs.readFileSync(path.join(root, f), 'utf8'));
    const checked = checksOf(lines);
    return [...sourcesOf(lines)].filter((h) => !checked.has(h)).map((h) => `${f}: ${h}`);
  });
  ok(uncovered.length === 0, `airgap-4k: every web source a downloading skill reads has a check line of its own (unchecked: ${JSON.stringify(uncovered)})`);

  // 0.20.5 (R7): the checks say what stops them. A Codex sandbox that blocks the network is no offline network: the
  // check block says so on its first line. npm waits on a network that drops packets as long as the OS retries (about
  // 130 s; its fetch-timeout only times the pauses), so the ping runs under a 15 s watchdog. A failed check is reported
  // with its command, exit code and first stderr line, and a certificate failure is not read as offline. Windows
  // curl.exe skips the revocation check and is looked for first. The waits of dnf and apt, and apt's exit 0, are written down.
  const SANDBOX_BASH = '[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"';
  const SANDBOX_PS = "if ($env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1') { 'Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)' }";
  const docText = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const noSandbox = DL_DOCS.filter((f) => {
    const t = docText(f);
    const b = codeBlocks(t).find((x) => x.lines.some(isNetCheck));
    const first = b ? b.lines.find((l) => l.trim()).trim() : '';
    return (first !== SANDBOX_BASH && first !== SANDBOX_PS) || !/'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다/.test(t);
  });
  ok(noSandbox.length === 0, `airgap-4l: each check block first says when a Codex sandbox blocks the network, and the doc says to report that, not "offline" (missing: ${JSON.stringify(noSandbox)})`);
  const CERT_WORDS = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'NODE_EXTRA_CA_CERTS=<사내 CA 파일>'];
  const noReport = DL_DOCS.filter((f) => {
    const t = docText(f);
    const code = joinedLines(t).join('\n');
    return !/확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다/.test(t) || !/원인을 '오프라인' 하나로 짐작하지 않는다/.test(t)
      || (/\bnpm ping\b/.test(code) && !CERT_WORDS.every((w) => t.includes(w)))
      || (/\bcurl(?:\.exe)?(?: --ssl-no-revoke)? (?:-K - )?-sSI\b/.test(code) && !/curl 의 종료 60\(인증서 검증 실패\)도 오프라인이 아니다/.test(t));
  });
  ok(noReport.length === 0, `airgap-4m: a failed check is reported with its command, exit code and first stderr line, and a certificate failure is not read as offline (missing: ${JSON.stringify(noReport)})`);
  // Git Bash's curl is Schannel too (the Windows box): the bash check lines skip the revocation check as well, and the
  // other curls take the flag and ignore it (macOS curl 8.7.1, Rocky 8.10 curl 7.61.1).
  const noRevoke = DL_DOCS.filter((f) => {
    const t = docText(f);
    return /curl\.exe -sSI\b/.test(t) || (/curl\.exe/.test(t) && !/Get-Command curl\.exe -ErrorAction SilentlyContinue/.test(t))
      || joinedLines(t).some((l) => isNetCheck(l) && /\bcurl\b/.test(l) && !/\bcurl(?:\.exe)? --ssl-no-revoke\b/.test(l))
      || (joinedLines(t).some((l) => isNetCheck(l) && /\bcurl /.test(l)) && !/Windows 의 Git Bash curl 도 Schannel 이라/.test(t));
  });
  const pwshDoc = docText(path.join('skills', 'setup-pwsh', 'SKILL.md'));
  ok(noRevoke.length === 0 && /^if \(Get-Command curl\.exe -ErrorAction SilentlyContinue\) \{$/m.test(pwshDoc)
     && /^\s+curl\.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 https:\/\/cdn\.winget\.microsoft\.com\/cache\b/m.test(pwshDoc),
     `airgap-4n: Windows curl.exe checks skip the revocation check and look for curl.exe first, so an earlier command's 0 is not read as reached (wrong: ${JSON.stringify(noRevoke)})`);
  const PKG_CODE = /\b(?:dnf|apt-get|apt)\s+(?:-\S+\s+)*(?:install|update|upgrade|module|makecache|download)\b/;
  const pkgDocs = DL_DOCS.filter((f) => joinedLines(docText(f)).some((l) => PKG_CODE.test(l)));
  const noPkgWords = pkgDocs.filter((f) => {
    const t = docText(f);
    return !/dnf 는 저장소마다 약 2분\(SYN 을 버리는 망 실측 121초\), apt 는 원천마다 약 4분\(답하지 않는 원천 실측 247초\) 기다린 뒤 실패로 끝난다\. 시간 제한은 관리자 설정을 따르므로 이 스킬이 바꾸지 않는다/.test(t)
      || !/`apt-get update` 는 받지 못해도 종료 0 이다\. 출력의 `W: Failed to fetch` 가 있으면 그 단계를 실패로 보고한다/.test(t);
  });
  ok(pkgDocs.length >= 6 && noPkgWords.length === 0, `airgap-4o: the docs with dnf or apt steps say how long those wait on a closed network and that apt-get update ends 0 without its lists (docs ${pkgDocs.length}, missing: ${JSON.stringify(noPkgWords)})`);
  const setE = DL_DOCS.flatMap((f) => codeBlocks(docText(f)).filter((b) => b.lines.some((l) => /^\s*set -e|\btrap '[^']*' EXIT\b/.test(l)))
    .filter((b) => { const ls = b.lines.filter((l) => l.trim()); return ls[0].trim() !== '(' || ls[ls.length - 1].trim() !== ')'; }).map(() => f));
  ok(setE.length === 0, `airgap-4p: a block that sets -e or an EXIT trap runs in a subshell of its own, so neither stays in the shell after it (found ${JSON.stringify(setE)})`);
  const IN15 = 'in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) > /dev/null 2>&1 & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }';
  const ubDoc = path.join('skills', 'update-banker', 'SKILL.md');
  const unwatched = [...DL_DOCS, ubDoc].flatMap((f) => codeBlocks(docText(f)).filter((b) => b.lines.some((l) => /\bnpm ping\b/.test(l))).filter((b) => {
    const def = b.lines.findIndex((l) => l.trim() === IN15);
    const at = b.lines.findIndex((l) => /\bnpm ping\b/.test(l));
    return def < 0 || def > at || b.lines.some((l) => /\bnpm ping\b/.test(l) && !l.includes("in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'"));
  }).map(() => f));
  const psPing = [...DL_DOCS, ubDoc].flatMap((f) => [...docText(f).matchAll(/`Push-Location ~; npm ping[^`]*`/g)].map((m) => m[0]).filter((c) => !c.includes('--no-update-notifier')).map(() => f));
  const npmSkills = DL_DOCS.filter((f) => /\bnpm ping\b/.test(joinedLines(docText(f)).join('\n')));
  const noWatchWords = npmSkills.filter((f) => !/`npm ping` 은 15초 감시\(`in15`\) 안에서 부른다/.test(docText(f)));
  ok(unwatched.length === 0 && psPing.length === 0 && npmSkills.length >= 9 && noWatchWords.length === 0,
     `airgap-4q: npm ping runs under the 15 s watchdog defined in its block, with no update check, and the docs say why (unwatched: ${JSON.stringify(unwatched)}, PowerShell: ${JSON.stringify(psPing)}, npm docs ${npmSkills.length}, unexplained: ${JSON.stringify(noWatchWords)})`);
  // 0.20.5 review: ffmpeg comes from PLAYWRIGHT_DOWNLOAD_HOST or the default server, never from the chromium mirror
  // variable, so a check of the chromium host alone passed a closed network the ffmpeg download then waited out.
  const pwDoc = docText(path.join('skills', 'setup-playwright', 'SKILL.md'));
  ok(/^F="\$\{PLAYWRIGHT_DOWNLOAD_HOST:-https:\/\/cdn\.playwright\.dev\}"/m.test(pwDoc)
     && /^\[ "\$F" = "\$H" \] \|\| printf 'url = "%s\/"\\n' "\$F" \| curl --ssl-no-revoke -K - -sSI /m.test(pwDoc),
     'airgap-4r: setup-playwright checks the ffmpeg download server too when only the chromium mirror is given');
  // B7-11: with neither source of Node 22, the RHEL block installs no older nodejs of the distribution with sudo.
  const mgDoc = docText(path.join('skills', 'motion-graphic-setup', 'SKILL.md'));
  ok(!/^sudo dnf install -y nodejs\s*$/m.test(mgDoc) && /^if \[ "\$ok" = 1 \]; then sudo dnf install -y nodejs; else echo "Node 22 저장소/m.test(mgDoc),
     'airgap-9d: the motion-graphic-setup RHEL block installs nodejs only when a Node 22 source is set up');
  // B7-13: the installs outside the setup skills check first and keep out of the project's tree and its .npmrc.
  const vpDoc = docText(path.join('skills', 'vertical-pptx', 'SKILL.md'));
  const pveDoc = docText(path.join('skills', 'pdf-vision-extract', 'SKILL.md'));
  ok(/^\(cd "\$S" && npm i --no-save --no-audit --no-fund pptxgenjs@4\) && echo "NODE_PATH=\$S\/node_modules"$/m.test(vpDoc) && !/^npm i --no-save/m.test(vpDoc)
     && /"오프라인이라 설치하지 않음\(필요한 것: pptxgenjs 또는 python-pptx\)" 으로 알린다/.test(vpDoc)
     && /Offline \(no network\): do not install; look for the fallback tools of section 4 \(`pdftoppm`, ImageMagick\)/.test(pveDoc),
     'airgap-12: vertical-pptx and pdf-vision-extract say what to do offline, and the scratch npm install runs outside the project tree');

  // Every curl call (with flags or a bare address, but `curl --version` and detection lines), wget, git clone, and the
  // PowerShell downloads, with continued lines joined.
  const unlimited = DL_DOCS.flatMap((f) => joinedLines(fs.readFileSync(path.join(root, f), 'utf8'))
    .filter((l) => !/\bcommand -v\b|Get-Command\b/.test(l))
    .filter((l) => (/\bcurl(?:\.exe)?\s+(?:-(?!-version\b|V\b)\S|https?:\/\/|["']?\$)/.test(l) && !/--max-time \d+|--speed-time \d+/.test(l))
      || (/\bwget\s+(?:-\S|https?:\/\/|["']?\$)/.test(l) && !/--timeout=\d+/.test(l))
      || (/\bgit\b.*\bclone\b/.test(l) && !/http\.lowSpeedTime=\d+/.test(l))
      || (/\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\s/i.test(l) && !/-TimeoutSec \d+/i.test(l)))
    .map((l) => `${f}: ${l.trim().slice(0, 50)}`));
  ok(unlimited.length === 0, `airgap-4b: the curl, wget and git clone calls of those skills have time limits (found ${JSON.stringify(unlimited)})`);
  // A download to a fixed /tmp name can be taken over by another user (a file planted there first is unpacked, built or
  // run, some of it as root): the skills download into a private folder (mktemp -d). The large files use stall detection,
  // not a total limit that cuts a slow line still receiving, and a cut download leaves no file that looks installed.
  const fixedTmp = DL_DOCS.flatMap((f) => joinedLines(fs.readFileSync(path.join(root, f), 'utf8'))
    .filter((l) => /\bcd \/(?:var\/)?tmp\b|(?:-o|-O|--output|--output-dir|--destdir|-C|>)[= ]?\s*"?\/(?:var\/)?tmp\b|\b\w+=\/(?:var\/)?tmp\//.test(l)).map((l) => `${f}: ${l.trim().slice(0, 60)}`));
  const BIG = /jdt-language-server-latest|"\$VSIX_URL"|"\$FALLBACK"|LibreOffice_\$\{V\}_(?:Linux|MacOS)|releases\/latest\/download\/plantuml\.jar/;
  const bigLines = DL_DOCS.flatMap((f) => joinedLines(fs.readFileSync(path.join(root, f), 'utf8'))
    .filter((l) => /\bcurl -/.test(l) && BIG.test(l)).map((l) => [f, l]));
  const noStall = bigLines.filter(([, l]) => !/--speed-limit 1000 --speed-time 30/.test(l) || /--max-time/.test(l)).map(([f, l]) => `${f}: ${l.trim().slice(0, 60)}`);
  const docsSetup = fs.readFileSync(path.join(root, 'skills', 'docs-setup', 'SKILL.md'), 'utf8');
  // The upstream tarball of LibreOffice is unpacked, its RPMs taken out and its folder removed in the block that got
  // it: a sentence after a block is no step a shell keeps $T for (the next block is a new shell).
  const loBlockDone = (t) => {
    const b = codeBlocks(t).find((x) => x.lines.some((l) => /LibreOffice_\$\{V\}_Linux/.test(l)));
    const ls = b ? b.lines.filter((l) => l.trim()) : [];
    return ls.some((l) => /tar -xzf "\$T\/lo\.tar\.gz" -C "\$T"/.test(l)) && ls.length > 0 && ls[ls.length - 1].trim().startsWith('rm -rf "$T"')
      && !/받은 tarball 은 `\$T` 안에서 풀고/.test(t) && !/^for r in \$SP\/\*\.rpm/m.test(t);
  };
  ok(fixedTmp.length === 0 && bigLines.length >= 5 && noStall.length === 0
     && /-o ~\/bin\/plantuml\.jar\.part .*&& mv ~\/bin\/plantuml\.jar\.part ~\/bin\/plantuml\.jar;/s.test(docsSetup)
     && /^rm -f ~\/bin\/plantuml\.jar\.part\s/m.test(docsSetup)
     && loBlockDone(fs.readFileSync(path.join(root, 'skills', 'vertical-pptx-setup', 'SKILL.md'), 'utf8')),
     `airgap-4e: downloads go to a private folder, the large ones use stall detection, plantuml.jar gets its name only when complete, and the LibreOffice tarball is unpacked and removed in its own block (fixed /tmp: ${JSON.stringify(fixedTmp)}, large ${bigLines.length}, no stall detection: ${JSON.stringify(noStall)})`);
  // PowerShell: a script saved under a name another user can guess ($PID) in a shared TEMP can be swapped before it runs;
  // it goes into a new folder with a GUID name, removed afterwards.
  const psGuess = DL_DOCS.flatMap((f) => joinedLines(fs.readFileSync(path.join(root, f), 'utf8'))
    .filter((l) => /\$env:TEMP\b/.test(l) && !/\[guid\]::NewGuid\(\)/.test(l)).map((l) => `${f}: ${l.trim().slice(0, 60)}`));
  const pySkill = fs.readFileSync(path.join(root, 'skills', 'setup-python', 'SKILL.md'), 'utf8');
  ok(psGuess.length === 0 && /\$D = Join-Path \$env:TEMP \(\[guid\]::NewGuid\(\)\)/.test(pySkill)
     && /New-Item -ItemType Directory -ErrorAction Stop \$D/.test(pySkill) && /finally \{ Remove-Item -Recurse -Force -ErrorAction SilentlyContinue \$D \}/.test(pySkill)
     && /-File \$T\n\s*if \(\$LASTEXITCODE -ne 0\) \{ "uv 설치 스크립트가 실패했습니다\(종료 \$LASTEXITCODE\)" \}/.test(pySkill),
     `airgap-4f: a PowerShell download goes into a new folder with a GUID name that is removed afterwards (guessable: ${JSON.stringify(psGuess)})`);
  // The pip index check: pip's own settings (`pip config get` does not read PIP_CONFIG_FILE, `pip config list` does;
  // install before global, the env first), and the user info of the index URL is cut before curl: a secret in a
  // command's arguments shows in `ps` to the other users of the machine. Reachability needs no login (401 answers too).
  const pyDocs = DL_DOCS.filter((f) => codeBlocks(fs.readFileSync(path.join(root, f), 'utf8')).some((b) => b.lines.some((l) => /\bpip config\b/.test(l))));
  const pyBad = pyDocs.filter((f) => {
    const lines = joinedLines(fs.readFileSync(path.join(root, f), 'utf8'));
    const at = (re) => lines.findIndex((l) => re.test(l));
    const li = at(/^L=\$\( \(cd ~ && \{ pip config list \|\| pip3 config list \|\| python3\.13 -m pip config list \|\| python3\.12 -m pip config list \|\| python3\.11 -m pip config list \|\| python3 -m pip config list; \}\) 2>\/dev\/null\) \|\| echo "pip 설정을 읽지 못함/), ins = at(/^I="\$\{PIP_INDEX_URL:-\$\(printf '%s\\n' "\$L" \| sed -n "s\/\^install\\\.index-url=/);
    const glo = at(/^I="\$\{I:-\$\(printf '%s\\n' "\$L" \| sed -n "s\/\^global\\\.index-url=/);
    const cut = at(/^I=\$\(printf %s "\$\{I:-https:\/\/pypi\.org\/simple\}" \| sed -E 's#\^\(\[A-Za-z\]\[A-Za-z0-9\+\.-\]\*:\/\/\)\[\^\/\]\*@#\\1#; s#\/\$##'\)/);
    const get = at(/^printf 'url = "%s"\\n' "\$I\/pip\/" \| curl --ssl-no-revoke -K - -sSI -o \/dev\/null --connect-timeout 5 --max-time 10\b/);
    return !(li >= 0 && li < ins && ins < glo && glo < cut && cut < get) || lines.some((l) => /\bcurl\b/.test(l) && /PIP_INDEX_URL|pip config|\$\{I:-/.test(l))
      || lines.some((l) => /\bcurl\b[^|]*"\$I\b/.test(l))
      || lines.some((l) => /\bpython3? -m pip config\b/.test(l) && !/\(cd ~ && \{/.test(l));
  });
  ok(pyDocs.length === 7 && pyBad.length === 0 && pyDocs.every((f) => /Rocky 8 의 기본 pip\(9\.0\.3, `pip3`\)은 `config` 명령이 없고 `pip` 이름은 없다/.test(fs.readFileSync(path.join(root, f), 'utf8'))),
     `airgap-4g: the pip index check reads pip's settings (says so when it cannot), cuts the user info and gives curl the URL on its standard input, not in its arguments (docs ${pyDocs.length}, wrong: ${JSON.stringify(pyBad)})`);
  // LibreOffice run with a profile under a guessable /tmp name can start from a profile another user made first
  // (macro settings included): the profile goes into a private folder.
  const vpSetup = fs.readFileSync(path.join(root, 'skills', 'vertical-pptx-setup', 'SKILL.md'), 'utf8');
  ok(!/\/tmp\/lo-profile/.test(vpSetup.replace(/`\/tmp\/lo-profile-\$\$` 처럼 짐작할 수 있는 이름은 쓰지 않는다/, ''))
     && /`P=\$\(mktemp -d\)` 로 만든 개인 폴더를 `-env:UserInstallation=file:\/\/\$P` 로 주고, 끝나면 `rm -rf "\$P"` 로 지운다/.test(vpSetup),
     'airgap-4h: the LibreOffice profile for automation goes into a private folder, not a guessable /tmp name');
  // `python -c`, `python -m` and a script on standard input put the current folder first on the import path: run
  // in someone else's repository, its `pip/`, `json.py` or `pptx.py` runs as the user. The docs run them from the home
  // folder (absolute paths for the files they read), or in PowerShell between Push-Location ~ and Pop-Location.
  // Kept: lineage's own test run in its own skill folder.
  const PY_RUN = /(?:^|[\s;&|(`])(?:python[0-9.]*|py(?:\s+-[0-9][0-9.]*)?|"?\$\{?PY(?:_BASE)?\}?"?|~?[\w./-]*\/bin\/python[0-9.]*)\s+(?:-[A-HJ-Za-z]+\s+)*(?:-c\b|-m\b|-\s*<<|<<|<(?!<|[^\s<>]+>|[^\s<>][^<>\n;&|]*[^\s<>\d;&|]>))/;   // a stdin script with or without -, not a <placeholder>
  // A <placeholder> may hold spaces (<입력 파일 경로>); a redirect does not pass for one: a space just inside the bracket
  // (<in.py >out), a file descriptor or & before > (<in.py 2>err, <in.py &>log), or a shell operator inside.
  const PY_RUN_CATCH = ['python3 <in.py >out', 'python3 <in.py 2>err', 'python3 <in.py &>log', 'python3 <in.py', 'python3 < in.py',
    'python3 <in.py && cat>out', 'python3 - <<EOF', 'py -3 <in.py >out'];
  const PY_RUN_PASS = ['python3 <입력 파일 경로>', 'python3 <파일>', 'python3 <스크립트 경로> --flag', 'python3 -I <in.py >out'];
  ok(PY_RUN_CATCH.every((l) => PY_RUN.test(l)) && !PY_RUN_PASS.some((l) => PY_RUN.test(l)),
    `airgap-4i: the stdin check tells a redirect from a <placeholder>, spaces in it or not (missed ${JSON.stringify(PY_RUN_CATCH.filter((l) => !PY_RUN.test(l)))}, taken ${JSON.stringify(PY_RUN_PASS.filter((l) => PY_RUN.test(l)))})`);
  const pyDocsAll = [...fs.readdirSync(path.join(root, 'skills')).map((d) => path.join('skills', d, 'SKILL.md')),
    ...fs.readdirSync(path.join(root, 'commands')).filter((f) => f.endsWith('.md')).map((f) => path.join('commands', f))]
    .filter((f) => fs.existsSync(path.join(root, f)));
  const cwdImports = pyDocsAll.flatMap((f) => {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    const spans = [...t.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => / install | -c /.test(c));
    return [...joinedLines(t), ...spans].filter((l) => PY_RUN.test(l) && !/\(cd ~ && |Push-Location ~;/.test(l))
      .filter((l) => !(f === path.join('skills', 'lineage', 'SKILL.md') && /^python3 -m unittest test_lineage\b/.test(l.trim())))
      .map((l) => `${f}: ${l.trim().slice(0, 60)}`);
  });
  ok(cwdImports.length === 0, `airgap-4i: python -c, -m and stdin scripts run from the home folder, not the current one (found ${JSON.stringify(cwdImports)})`);
  // An audit of someone else's repository keeps its runners and results outside that repository: a `.audit/` the
  // repository planted as a link would take the writes elsewhere. And a block that clears a folder does it without a
  // glob, which zsh ends with "no matches found" on an empty folder (a `set -e` block stops there).
  const amSkill = fs.readFileSync(path.join(root, 'skills', 'audit-mock', 'SKILL.md'), 'utf8');
  const lspSkill = fs.readFileSync(path.join(root, 'skills', 'setup-lsp', 'SKILL.md'), 'utf8');
  ok(!/gitignored `\.audit\/`/.test(amSkill) && /감사 대상 저장소 밖의 작업 폴더/.test(amSkill)
     && !/rm -rf "\$\{TARGET:\?\}"\/\*/.test(lspSkill) && /find "\$\{TARGET:\?\}" -mindepth 1 -delete/.test(lspSkill),
     'airgap-4j: audit-mock keeps its work folder outside the audited repository, and setup-lsp clears its folder without a glob');
  // setup-mcp: `npx -y` and `uvx` ask the registry for a version at every start (offline: about 70 s, then a failure, each
  // session); the offline path registers pinned, installed executables and leaves out the servers that are a network service.
  const mcpSkill = fs.readFileSync(path.join(root, 'skills', 'setup-mcp', 'SKILL.md'), 'utf8');
  ok(/npm i -g @modelcontextprotocol\/server-sequential-thinking@<판> @modelcontextprotocol\/server-filesystem@<판>/.test(mcpSkill)
     && /^ST=\$\(command -v mcp-server-sequential-thinking\); FB=\$\(command -v mcp-server-filesystem\); GT=\$\(command -v mcp-server-git\)$/m.test(mcpSkill)
     && /claude mcp add sequential-thinking -s user -- "\$ST"; \}/.test(mcpSkill) && /claude mcp add filesystem -s user -- "\$FB" "\$FS_DIR"; \}/.test(mcpSkill)
     && /claude mcp add git -s user -- "\$GT"; \}/.test(mcpSkill) && !/-- mcp-server-(?:git|sequential-thinking|filesystem)\b/.test(mcpSkill.slice(mcpSkill.indexOf('### 네트워크가 없는 곳'), mcpSkill.indexOf('## 3. Claude Code 배선')).replace(/`[^`\n]*cmd \/c[^`\n]*`/g, ''))
     && /Windows 는 이름으로 등록하고 `cmd \/c` 를 앞에 둔다/.test(mcpSkill)
     && /네트워크가 필요한 서버\(context7, fetch, tavily\)는 등록하지 않/.test(mcpSkill),
     'airgap-5: setup-mcp registers pinned installed executables offline and leaves out the network-service servers');
  // A server registered online under the same name makes `claude mcp add` fail ("already exists"): the offline block
  // removes each name first, as the online sections do, for Claude Code and Codex.
  const mcpOffline = mcpSkill.slice(mcpSkill.indexOf('### 네트워크가 없는 곳 (오프라인 경로)'), mcpSkill.indexOf('## 3. Claude Code 배선'));
  const removedFirst = (rm, add) => { const r = mcpOffline.indexOf(rm); return r >= 0 && mcpOffline.indexOf(add, r) > r; };
  ok(['sequential-thinking', 'filesystem', 'git'].every((n) => removedFirst(`claude mcp remove ${n} -s user 2>/dev/null;`, `claude mcp add ${n} -s user --`)
       && removedFirst(`codex mcp remove ${n} 2>/dev/null;`, `codex mcp add ${n} --`))
     && /`uvx <패키지>` 가 오프라인에서 어떻게 끝나는지는 재지 못했다\(미실측\)/.test(mcpOffline) && !/`uvx <패키지>` 는 서버를 띄울 때마다/.test(mcpOffline)
     && /```bash\nFS_DIR="\$\{FS_DIR:-\$HOME\/projects\}"\nST=\$\(command -v mcp-server-sequential-thinking\);[^\n]*\n\[ -n "\$ST" \] && \{ codex mcp remove sequential-thinking/.test(mcpOffline),
     'airgap-5b: the setup-mcp offline block removes an earlier registration before each add, and does not claim a measured uvx failure');
  // A command quoted in a sentence is run as written: an npm view or ping there runs in the home folder too.
  const npmSpans = [...DL_DOCS, path.join('skills', 'update-banker', 'SKILL.md')].flatMap((f) => [...fs.readFileSync(path.join(root, f), 'utf8')
    .replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
    .filter((c) => (/\bnpm view (?!\.\.\.)\S+ \S+/.test(c) || /\bnpm ping --/.test(c)) && !/^(?:\(cd ~ && |Push-Location ~; )/.test(c)).map((c) => `${f}: ${c.slice(0, 60)}`));
  ok(npmSpans.length === 0, `airgap-5c: npm view and ping commands quoted in sentences run in the home folder too (found ${JSON.stringify(npmSpans)})`);
  // PowerShell: after npm in the home folder the shell comes back, else the next steps run in the home folder.
  const noPop = [...DL_DOCS, path.join('skills', 'update-banker', 'SKILL.md')].flatMap((f) => fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/)
    .filter((l) => /Push-Location ~/.test(l) && !/Pop-Location/.test(l)).map((l) => `${f}: ${l.trim().slice(0, 60)}`));
  ok(noPop.length === 0, `airgap-5d: each Push-Location ~ comes with Pop-Location (found ${JSON.stringify(noPop)})`);
  // ffmpeg-static is an npm package: with no network it cannot come either, so it is no offline fallback. Offline, the
  // skills point FFMPEG_PATH at an ffmpeg brought in beforehand.
  const ffDocs = ['3d-intro-setup', 'motion-graphic-setup'].map((d) => [d, fs.readFileSync(path.join(root, 'skills', d, 'SKILL.md'), 'utf8')]);
  // Wrong: offline among the cases of the ffmpeg-static fallback, or "오프라인이면" leading to ffmpeg-static as the way.
  // Judged sentence by sentence: an exemption in one sentence does not cover another on the same line.
  const ffExempt = (x) => /(?:받을|쓸) 수 없다/.test(x) || /오프라인이 아니면/.test(x) || /오프라인이면 미리 받/.test(x);
  const ffWrong = ffDocs.flatMap(([d, t]) => t.split(/\r?\n/).flatMap((l) => l.split(/(?<=\.)\s+/)).filter((l) => /ffmpeg-static/.test(l)
    && ((/폴백/.test(l) && /오프라인/.test(l)) || /오프라인이면[^.]*ffmpeg-static/.test(l)) && !ffExempt(l))
    .map((l) => `${d}: ${l.trim().slice(0, 60)}`));
  ok(ffWrong.length === 0 && ffDocs.every(([, t]) => /오프라인이면 `ffmpeg-static` 도 받을 수 없다/.test(t) && /미리 받아 둔 ffmpeg 실행 파일의 절대 경로/.test(t)),
     `airgap-7: ffmpeg-static is not offered as the offline fallback; offline, FFMPEG_PATH points at an ffmpeg brought in beforehand (found ${JSON.stringify(ffWrong)})`);
  // A tool called through npx asks the registry for a version each time (offline: about 70 s, then a failure): the skills
  // that call one give the offline way (a pinned global install, then the executable by name), and Stitch says it needs the network.
  const mgSetup = fs.readFileSync(path.join(root, 'skills', 'motion-graphic-setup', 'SKILL.md'), 'utf8');
  const mgMake = fs.readFileSync(path.join(root, 'skills', 'motion-graphic-make', 'SKILL.md'), 'utf8');
  const stitchSkill = fs.readFileSync(path.join(root, 'skills', 'setup-stitch', 'SKILL.md'), 'utf8');
  ok(/npm i -g hyperframes@<판>/.test(mgSetup) && /`hyperframes <명령>` 을 직접 부른다/.test(mgSetup)
     && /전역 설치한 `hyperframes doctor`/.test(mgMake) && /Stitch 는 원격 서비스라 네트워크가 없으면 쓸 수 없다/.test(stitchSkill),
     'airgap-9: the npx tools have an offline way (global install, then the executable), and setup-stitch says it needs the network');
  // motion-graphic-setup: the install check and the verification call the global hyperframes when there is one; npx (it
  // downloads when nothing is installed: about 70 s offline, read as "not installed") only after the network check.
  const mgNpx = joinedLines(mgSetup).filter((l) => /\bnpx hyperframes\b/.test(l) && !/command -v hyperframes\b/.test(l));
  ok(mgNpx.length === 0 && !/`npx hyperframes doctor` 가 통과하면/.test(mgSetup)
     && /^hf\(\) \{ if command -v hyperframes >\/dev\/null; then hyperframes "\$@"; else npx hyperframes "\$@"; fi; \}/m.test(mgSetup)
     && /전역 설치가 있으면 `hyperframes doctor` 다\. 없으면 아래 네트워크 확인이 통과한 뒤에만 `npx hyperframes doctor` 를 부른다/.test(mgSetup)
     && /오프라인이라 hyperframes 진단을 하지 못함/.test(mgSetup),
     `airgap-9b: motion-graphic-setup calls the global hyperframes when installed and npx only after the network check (unguarded: ${JSON.stringify(mgNpx)})`);
  // zsh does not split an unquoted variable into words: `X="a b"` then `$X ...` runs a command named "a b" there.
  const splitVars = [...DL_DOCS, path.join('skills', 'update-banker', 'SKILL.md')].flatMap((f) => codeBlocks(fs.readFileSync(path.join(root, f), 'utf8'))
    .flatMap((b) => {
      const names = b.lines.flatMap((l) => [...l.matchAll(/(?:^|[;&|]\s*)(?:export\s+|local\s+|readonly\s+)?(\w+)=(["'])[^"'$]*\s[^"'$]*\2/g)].map((m) => m[1]));
      return b.lines.filter((l) => names.some((n) => new RegExp(`(?:^|[;&|(]\\s*|\\b(?:if|then|else|do|while|until|exec)\\s+|!\\s*)\\$\\{?${n}\\b\\}?(?!")`).test(l.trim())));
    }).map((l) => `${f}: ${l.trim().slice(0, 60)}`));
  ok(splitVars.length === 0, `airgap-9c: no code block runs a command from an unquoted variable holding words (zsh does not split it) (found ${JSON.stringify(splitVars)})`);
  // audit-security: offline, npm audit exits 1 with only an error in its JSON and osv-scanner exits 127 with an empty
  // list; read as results they count 0 vulnerabilities. A tool's output is read only when it is a result, else "미커버".
  const asSkill = fs.readFileSync(path.join(root, 'skills', 'audit-security', 'SKILL.md'), 'utf8');
  // The conditions are positive (an empty offline DB exits 0 with the same body as "no issues"; a negative "no error
  // text" passes a tool that never ran): the output parses and shows that something was scanned.
  ok(/\| npm audit \| 종료 코드 0 이나 1\. 본문이 JSON 이고 `error` 키가 없음\. `metadata\.dependencies\.total` 이 0 보다 큼 \| 실측 \|/.test(asSkill)
     && /\| osv-scanner \| 종료 코드 0 이나 1\. 본문이 JSON\. stderr 의 `Scanned <파일> file and found <N> package` 의 N 합이 0 보다 큼 \| 실측 \|/.test(asSkill)
     && /\| osv-scanner 오프라인 DB \| .*항목을 1개 이상 가짐 \| 실측 \|/.test(asSkill)
     && ['trivy', 'grype', 'semgrep', 'pip-audit'].every((t) => new RegExp(`^\\| ${t} \\| 종료 코드 [^|]*본문이 JSON[^|]*\\| 미실측 \\|$`, 'm').test(asSkill))
     && !/stderr 에 [^|]*(?:없음|없다) \| 미커버 \|/.test(asSkill)
     && /0건으로 세지 않는다\. 리포트 Unknown 에 "미커버\(네트워크 없음 또는 대상 없음\): <도구>, 종료 <코드>, <stderr 첫 줄>" 로 적는다/.test(asSkill)
     && /stderr 는 `\$OUT\/<도구>\.err` 로 따로 남기고 종료 코드를 적는다/.test(asSkill)
     && /DB 의 기준일\(파일 수정 시각\)을 Evidence 에 적는다/.test(asSkill) && /`OUT="\$\{RESEARCH_DIR:-\$\(mktemp -d\)\}"; mkdir -p "\$OUT"`/.test(asSkill)
     && /감사 대상 저장소 밖의 작업 폴더/.test(asSkill) && !/gitignored `\.audit\/`/.test(asSkill),
     'airgap-2: audit-security reads a tool output as a result only when it parses and shows a scan, and writes "미커버" with the exit code and stderr instead of 0');
  // deep-research with no web tool that works ends as "웹 조사 불가" instead of a report without sources, and ultra-chain's
  // research gate does not pass on zero claims.
  const drSkill = fs.readFileSync(path.join(root, 'skills', 'deep-research', 'SKILL.md'), 'utf8');
  const ucSkill = fs.readFileSync(path.join(root, 'skills', 'ultra-chain', 'SKILL.md'), 'utf8');
  ok(/검색과 fetch 가 모두 실패하면\(네트워크 없음\) 보고서를 만들지 않고 "웹 조사 불가: <오류>" 로 끝낸다/.test(drSkill)
     && /`skipped` 와 이유 "네트워크 없음"/.test(ucSkill) && /주장이 0개면 게이트를 지나지 않은 것이다/.test(ucSkill)
     && /수단이 있어도 호출이 모두 실패하면\(네트워크 없음\) 같다/.test(fs.readFileSync(path.join(root, 'skills', 'ultra-interview', 'SKILL.md'), 'utf8')),
     'airgap-8: deep-research ends as "웹 조사 불가" when every web tool fails, and ultra-chain records the step as skipped');
  // README and PRIVACY tell an offline user what really happens: which skills need the network and how each one ends
  // without it, and that the hooks do not take HTTPS_PROXY.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const offlineReadme = readme.slice(readme.indexOf('## 오프라인에서 쓰기'), readme.indexOf('## 라이선스'));
  const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8');
  ok(!/그 밖의 스킬/.test(offlineReadme) && /네트워크를 쓰지 않는 스킬\(예: /.test(offlineReadme)
     && /`ultra-chain` 1단계/.test(offlineReadme) && /`motion-graphic-make`/.test(offlineReadme) && /`nothing-design`/.test(offlineReadme)
     && /OS 패키지 관리자\(dnf, apt, brew, winget\)의 단계는 .*미리 판정하지 않고 시도합니다/.test(offlineReadme) && /단 `setup-pwsh` 는 winget 이 유일한 원천이라 그 원천을 먼저 봅니다/.test(offlineReadme)
     && [offlineReadme, privacy].every((t) => /훅은 `HTTPS_PROXY`, `HTTP_PROXY` 를 따르지 않습니다/.test(t)),
     'airgap-11: the README offline section names the skills that need the network and how each ends, and both docs say the hooks ignore HTTPS_PROXY');
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
