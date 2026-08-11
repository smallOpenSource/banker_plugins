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

  // 8) ralph-qa verifier redesign (S2, S2-b, S3..S17). These lock RULES INTO THE DOC, not rule
  // EXECUTION -- a model that skips the quorum section still passes here. That gap is why the
  // plan keeps `verifier-probe.mjs` as code: the parts a prose reader could get wrong silently
  // (family filter, fail-closed, transport, 0-token liveness) live there and have unit tests.
  // Judged by readFileSync + JS regex on purpose: `execSync('grep -c ...')` THROWS on a passing
  // (zero-match) check and stays silent on a violation, i.e. exactly backwards for a gate.
  const rqSkill = fs.readFileSync(path.join(root, 'skills', 'ralph-qa', 'SKILL.md'), 'utf8');
  const rqFm = rqSkill.slice(0, rqSkill.indexOf('---', 4));
  const rqSurface = JSON.parse(fs.readFileSync(path.join(root, 'codex', 'manifest.json'), 'utf8'))
    .surfaces.find((s) => s.name === 'ralph-qa');
  const probeRel = path.join('skills', 'ralph-qa', 'references', 'verifier-probe.mjs');
  const probeTestRel = path.join('skills', 'ralph-qa', 'references', 'verifier-probe.test.mjs');

  ok(rqSurface.supportingFiles.length === 1
     && rqSurface.supportingFiles[0] === 'references/verifier-probe.mjs'
     && fs.existsSync(path.join(root, probeRel))
     && !rqSurface.supportingFiles.some((f) => /tally/.test(f)),
     'S2: ralph-qa supportingFiles is exactly [references/verifier-probe.mjs] and the file exists (no tally.mjs)');
  ok(fs.existsSync(path.join(root, probeTestRel)) && !fs.existsSync(path.join(pkgRoot, probeTestRel)),
     'S2-b: verifier-probe.test.mjs exists in the repo but is NOT npm-packaged (files[] negation holds)');
  // The limitation must stay stated PRECISELY: per-call effort has no path, but agent-DEFINITION
  // frontmatter does (7 official claude-security agents ship `effort: xhigh`). banker ships no
  // agents, which is the real reason the backbone knob is closed. An imprecise "no path anywhere"
  // would be the false-documentation failure this column exists to prevent.
  ok(/외부 전용 \(api·codex\)/.test(rqSkill) && /백본에는 전송 경로가 없다/.test(rqSkill)
     && /백본의 reasoning effort 는 이 스킬이 호출 단위로 지정하지 못한다/.test(rqSkill)
     && /에이전트 정의의 프론트매터/.test(rqSkill) && /banker 는 에이전트를 배포하지 않으므로/.test(rqSkill),
     'S3: --effort is scoped to external seats and the backbone limitation names its real cause (no agents shipped), not a blanket "impossible"');
  // The backbone must DEGRADE-AND-DISCLOSE rather than either promise max effort or give up on it:
  // pick the strongest available model/strength by preference order, then report what was actually
  // used. A target written without the disclosure line is the false-promise failure again.
  // Model is selectable (Agent tool `model`); strength is not — it is inherited from the session.
  // Keeping the ladder over BOTH would put a lever-less goal in prose, the same false-promise shape
  // the 전송 경로 column exists to block. So: ladder covers model, strength is declared inherited,
  // and the report states what was actually used either way.
  ok(/모델은 선호 순서로 내려간다/.test(rqSkill)
     && /가용한 것 중 가장 적합한 추론 모델/.test(rqSkill)
     && /추론 강도는 고르는 것이 아니라 물려받는 것이다/.test(rqSkill)
     && /실제로 쓴 모델과 물려받은 강도를 보고의 선언 블록에 적는다/.test(rqSkill)
     && /백본\(선언\): model=/.test(rqSkill),
     'S18: the backbone ladder covers model only, strength is declared inherited, and the report discloses both');
  // Shipping agent definitions would pin `effort:` — but that key is Claude-only, so it would split
  // backbone strength by runtime and break the target:both invariant smoke-tests elsewhere. Record
  // WHY the path is shut, or a future editor "fixes" the missing knob by opening it.
  ok(/에이전트 정의를 배포해 강도를 박는 길은 의도적으로 닫혀 있다/.test(rqSkill)
     && /런타임 대칭이 깨지고/.test(rqSkill),
     'S20: the closed agent-definition path is recorded as a decision with its reason, not as an accident');
  // The probe transmits an auth header to a third-party host. `--external=off` must actually mean
  // no HTTP (the report is instructed to write "미실행", which has to be TRUE), and the
  // default-endpoint descent must be disclosed and switchable -- OPENAI_API_KEY routinely holds a
  // NON-OpenAI provider's key, and that key must not travel to a vendor the user never named.
  ok(/`--external=off` 는 \*\*HTTP 를 한 건도 내지 않는다/.test(rqSkill)
     && /키 env 이름이 지목하는 표준 벤더 엔드포인트로 내려간다/.test(rqSkill)
     && /RALPH_QA_NO_DEFAULT_ENDPOINT/.test(rqSkill)
     && /`OPENAI_API_KEY` 가 OpenAI 키가 아닐 수 있다/.test(rqSkill),
     'S21: outbound transmission is disclosed, --external=off means zero HTTP, and the default-endpoint descent has an opt-out');
  // The user asked for FOUR conditional paths: codex CLI, gemini CLI, gpt credentials, gemini
  // credentials. The first build gated the gemini credential path behind CLI presence, so a valid
  // key with no CLI reported `cli-absent` -> "model axis uncovered (environment)" -- blaming the
  // environment for a credential the environment actually supplied. That is the false-coverage
  // failure this skill exists to prevent, so the CLI/credential split is now a locked rule.
  ok(/external:gemini-api/.test(rqSkill)
     && /CLI 경로와 크리덴셜 경로는 별개 좌석이다/.test(rqSkill)
     && /크리덴셜이 있으면 사유 토큰 `cli-absent` 를 쓰지 않는다/.test(rqSkill),
     'S19: the gemini credential seat is independent of the CLI seat and never reports cli-absent when a key exists');
  ok(!/falls back to same-runtime/.test(fs.readFileSync(path.join(root, 'codex', 'transform-matrix.md'), 'utf8')),
     'S4: transform-matrix.md no longer documents a same-runtime critic fallback (that is self-approval on Codex)');
  ok(!/Codex CLI 우선|그것도 없으면/.test(rqFm)
     && ['ralph-qa', '교차검증', '다른 LLM으로 검증', '독립 QA'].every((t) => rqFm.includes(t)),
     'S5: ralph-qa frontmatter drops the old priority-ladder wording and keeps all 4 trigger phrases');
  ok(/\| 전송 경로 \| 확인 수준 \|/.test(rqSkill) && !/전달 메커니즘/.test(rqSkill),
     'S6: flag table uses the 전송 경로/확인 수준 columns (old 전달 메커니즘 header gone)');
  const rqReadmeRows = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    .split(/\r?\n/).filter((l) => /ralph-qa/.test(l));
  ok(rqReadmeRows.length === 2 && rqReadmeRows.every((l) => !/폴백|최후/.test(l)),
     `S7: both README ralph-qa rows describe backbone+seats without fallback wording (rows: ${rqReadmeRows.length})`);
  // Anchor each trigger to its position in the disjunction list (`⟸`/`∨`), not to a bare mention:
  // `좌석 총합 0` also appears in the consumption rules below, so an unanchored probe would stay
  // green after that trigger line was deleted. Same class of hole as S14; found the same way.
  ok(/INCONCLUSIVE ⟸ 좌석 상실/.test(rqSkill) && /∨ 동일 좌석 ERROR 2연속/.test(rqSkill)
     && /∨ 좌석 총합 0/.test(rqSkill) && /∨ --max 소진 \+ 미해소 blocker 잔존/.test(rqSkill),
     'S8: all four INCONCLUSIVE trigger conditions are present in the quorum section');
  ok(/\{APPROVE, ITERATE, REJECT, ERROR\}/.test(rqSkill) && /VERDICT: <값>/.test(rqSkill)
     && /ERROR = 좌석 유지 \+ APPROVE 차단/.test(rqSkill),
     'S9: seat verdict domain is 4-valued with a strict VERDICT token and ERROR keeps the seat while blocking APPROVE');
  // Match the VALUE, not one spelling of it: `--external=auto|off|only` reintroduces the banned
  // seat-emptying mode without ever containing the literal "external=only". The narrow form stayed
  // green under exactly that mutation (AC-P5.3(d)), which is what the deliberate regression is for.
  ok(!/external=[a-z|\\]*only/.test(rqSkill) && /내부 좌석 ≥ 1/.test(rqSkill),
     'S10: the --external "only" value is gone in every spelling and 내부 좌석 >= 1 is a quorum conjunct (no vacuous zero-seat APPROVE)');
  ok(/프로브\(관측\):/.test(rqSkill) && /좌석\(선언\):/.test(rqSkill)
     && /"증거"라고 부르지 않는다/.test(rqSkill),
     'S11: the report contract separates observed from declared and refuses to call declared values evidence');
  ok(/출처-독립 좌석은 저자가 쓴 요약을 받지 않는다/.test(rqSkill) && /출처-독립 1 포함/.test(rqSkill),
     'S12: the source-independent seat is defined in step 1 and surfaced in the report');
  // Anchor to the 종결어 definition block in the quorum section; the labels are also quoted in the
  // report templates, so a whole-file probe would survive deleting the definitions themselves.
  ok(/종결어:\s+APPROVE\(3축\)/.test(rqSkill) && /APPROVE\(모델축 미커버 — 환경\)\s+— 외부 0/.test(rqSkill)
     && /APPROVE\(모델축 미커버 — 저자 요청\)\s+— 외부 0/.test(rqSkill),
     'S13: all three APPROVE terminal labels are defined in the quorum block (coverage survives one-line quoting)');
  // Anchor to the DEFINING line in the quorum block, not to any mention of the relation: step 4
  // also cites `S_k ⊆ S_{k+1}` in passing, so a bare /S_k ⊆ S_\{k\+1\}/ stayed green even after the
  // definition was deleted (caught by the AC-P5.3(e) deliberate regression, which is why it exists).
  ok(/좌석 식별자: \(종류, 렌즈\)/.test(rqSkill)
     && /집합 S_k 에 대해 S_k ⊆ S_\{k\+1\} 이어야 한다/.test(rqSkill)
     && /좌석 상실 \(원인 불문/.test(rqSkill)
     && /백본 좌석의 blocker 도 좌석 재생성으로 소멸하지 않는다/.test(rqSkill),
     'S14: seat identity is monotone across iterations, so re-rolling backbone seats cannot erase dissent');
  ok(/INCONCLUSIVE 소비 규칙 — 통과가 아니다/.test(rqSkill) && /APPROVE 취급 금지/.test(rqSkill)
     && /사람의 명시적 판단을 요구하고 멈춘다/.test(rqSkill),
     'S15: INCONCLUSIVE has consumption rules (not a pass, per-cause next action, human judgement on repeat)');
  // Set EQUALITY between the probe's ABSENT_REASONS and the SKILL.md definition line, plus the
  // declared count parsed out of that same line. A hardcoded list here with `.every()` only closed
  // one of three edges: it caught SKILL.md dropping a token, but a 9th token added on either side
  // slipped through, and the count in the prose could drift from the list beside it (it did — this
  // assertion's own comment and message said "7" while asserting 8, for two releases).
  // Same fix, same reason as the manifest==skills/ equality above: assert the invariant, do not
  // maintain a parallel copy. Read from source text because the probe is ESM and this file is CJS.
  const probeSrc = fs.readFileSync(path.join(root, probeRel), 'utf8');
  const absentBlock = (probeSrc.match(/const ABSENT_REASONS = \[([\s\S]*?)\n\];/) || [])[1] || '';
  const probeTokens = [...absentBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // `author-off` also appears in the two-row difference table, so scoping to the definition line is
  // what makes AC-P5.3(g) (delete the token from its definition) actually fail.
  const reasonDefLine = rqSkill.split(/\r?\n/).find((l) => /\*\*사유 토큰 \d+종\.\*\*/.test(l)) || '';
  const skillTokens = [...reasonDefLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const declaredCount = Number((reasonDefLine.match(/사유 토큰 (\d+)종/) || [])[1] || 0);
  const missing = probeTokens.filter((t) => !skillTokens.includes(t));
  const extra = skillTokens.filter((t) => !probeTokens.includes(t));
  ok(probeTokens.length > 0 && missing.length === 0 && extra.length === 0
     && declaredCount === probeTokens.length
     && /직전 실행이 `INCONCLUSIVE` 인데 `--external=off` 로 우회했다면/.test(rqSkill),
     `S16: SKILL.md's reason-token definition equals the probe's ABSENT_REASONS and the stated count matches `
     + `(probe ${probeTokens.length} / doc ${skillTokens.length} / stated ${declaredCount}`
     + `${missing.length ? ', missing: ' + missing.join(', ') : ''}${extra.length ? ', extra: ' + extra.join(', ') : ''})`);
  ok(/--max 소진은 항상 종결이다/.test(rqSkill) && /ITERATE\(한도 소진\)/.test(rqSkill)
     && /어느 갈래도 통과가 아니다/.test(rqSkill) && /같은 이슈가 3회\+ 재발/.test(rqSkill),
     'S17: --max exhaustion always terminates via two branches, neither of which is a pass');
  // The author's codex config is ALSO the api seat's preferred-model source, so without avoidance
  // `api:<X>` and `codex(<X>)` sit down together: two seats, one model. The gate does not widen
  // (extra seats only make APPROVE harder) but the report's "외부 2" reads as two independent
  // checks -- the reporting-honesty defect class this skill exists to prevent. Found by RUNNING the
  // probe, not by reading it: the unit cases all had a curl-only PATH, so no codex seat ever stood.
  // Set equality again (same reason as S16): the four ladder rungs live in the probe's return
  // values and in SKILL.md's field table, and a parallel hardcoded list here would close one edge.
  const pickFn = (probeSrc.match(/function pickSeatModel\([\s\S]*?\n\}/) || [''])[0];
  const probePicks = [...pickFn.matchAll(/pick: '([^']+)'/g)].map((m) => m[1]);
  const pickRow = rqSkill.split(/\r?\n/).find((l) => /modelPick` \|/.test(l)) || '';
  const skillPicks = [...pickRow.matchAll(/`([^`]+)`/g)].map((m) => m[1]).slice(1); // [0] is the field name
  const pickMissing = probePicks.filter((t) => !skillPicks.includes(t));
  const pickExtra = skillPicks.filter((t) => !probePicks.includes(t));
  ok(probePicks.length > 0 && pickMissing.length === 0 && pickExtra.length === 0
     && /외부 좌석끼리도 같은 모델이면 안 된다/.test(rqSkill)
     && /다른 계열 → 같은 계열의 다른 모델 → 같은 모델/.test(rqSkill)
     && /모델 부적격은 착석 전에만 갈아탈 수 있다/.test(rqSkill),
     `S22: the api seat avoids the codex seat's model family and SKILL.md's rungs equal the probe's `
     + `(probe ${probePicks.length} / doc ${skillPicks.length}`
     + `${pickMissing.length ? ', missing: ' + pickMissing.join(', ') : ''}`
     + `${pickExtra.length ? ', extra: ' + pickExtra.join(', ') : ''})`);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
