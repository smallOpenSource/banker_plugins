#!/usr/bin/env node
'use strict';
/*
 * banker — multi-target installer CLI for the banker plugin.
 * Installs the banker skills/commands into Claude Code and/or Codex CLI from one source of truth.
 * No runtime deps (Node built-ins only). Cross-OS. Idempotent. Never runs as root. Supports --dry-run.
 * Source of truth: this package's skills/ + commands/ + codex/manifest.json. The Claude Code
 * marketplace flow is unchanged; this is an additive layer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');

const PKG_ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(PKG_ROOT, 'codex', 'manifest.json');
const PLUGIN_JSON = path.join(PKG_ROOT, '.claude-plugin', 'plugin.json');
const MARKETPLACE = 'banker-plugins';
const PLUGIN_NAME = 'banker';
const REPO_URL = 'https://github.com/smallOpenSource/banker_plugins';
const REPO_SLUG = REPO_URL.replace(/^https:\/\/github\.com\//, ''); // smallOpenSource/banker_plugins (star API 대상)

function version() {
  try { return require(path.join(PKG_ROOT, 'package.json')).version; } catch { return '0.0.0'; }
}
function log(...a) { console.log(...a); }
function warn(...a) { console.error(...a); }

// GitHub 저장소에 별을 단다 (gh CLI 인증 사용). star 는 repo 쓰기 권한이 필요 없어 인증된 어느 계정으로도
// 가능하다. gh 미설치/미인증/실패는 {ok:false, reason} 로 반환해 호출부가 URL 안내로 폴백하게 한다.
// spawn 은 테스트 주입용(기본 cp.spawnSync). 자체 timeout·오류삼킴으로 setup 을 절대 막지 않는다.
function starRepo(spawn = cp.spawnSync) {
  try {
    const v = spawn('gh', ['--version'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    if (v.error || v.status !== 0) return { ok: false, reason: 'gh CLI 없음' };
    const r = spawn('gh', ['api', '-X', 'PUT', `/user/starred/${REPO_SLUG}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true });
    if (r.error) return { ok: false, reason: r.error.message };
    if (r.status !== 0) {
      const msg = (`${r.stderr || r.stdout || ''}`).trim().split('\n')[0] || `gh exited ${r.status}`;
      return { ok: false, reason: msg };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

function parseArgs(argv) {
  const a = { cmd: null, sub: null, claude: false, codex: false, scope: 'user', scopeExplicit: false, dryRun: false, help: false, version: false };
  for (const t of argv) {
    if (t === 'setup' || t === 'doctor' || t === 'uninstall' || t === 'help' || t === 'telemetry') { if (!a.cmd) a.cmd = t; }
    else if (t === 'on' || t === 'off' || t === 'status') { if (!a.sub) a.sub = t; } // telemetry subcommand
    else if (t === '--claude') a.claude = true;
    else if (t === '--codex') a.codex = true;
    else if (t === '--dry-run' || t === '-n') a.dryRun = true;
    else if (t === '--scope=project' || t === 'project') { a.scope = 'project'; a.scopeExplicit = true; }
    else if (t === '--scope=user') { a.scope = 'user'; a.scopeExplicit = true; }
    else if (t === '--scope') a._wantScope = true;
    else if (a._wantScope) { a.scope = (t === 'project') ? 'project' : 'user'; a.scopeExplicit = true; a._wantScope = false; }
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '-v' || t === '--version') a.version = true;
  }
  // If neither target specified for setup/uninstall, default to BOTH.
  if ((a.cmd === 'setup' || a.cmd === 'uninstall') && !a.claude && !a.codex) { a.claude = true; a.codex = true; }
  return a;
}

function assertNotRoot() {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    warn('banker: refusing to run as root (would write root-owned files into a user home). Re-run as your normal user.');
    process.exit(2);
  }
}

function readManifest() { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
function eligible(m) { return m.surfaces.filter(s => s.target === 'both'); }

function homeDir() { return os.homedir(); }
function claudePluginsDir() { return path.join(homeDir(), '.claude', 'plugins'); }
function codexBase(scope) { return scope === 'project' ? path.join(process.cwd(), '.codex') : path.join(homeDir(), '.codex'); }

function have(bin) {
  // PATH scan — no shell (avoids DEP0190 + injection). Cross-OS.
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) {
      try { fs.accessSync(path.join(d, bin + e), fs.constants.X_OK); return true; } catch { /* keep scanning */ }
    }
  }
  return false;
}

function copyDir(src, dest, dryRun) {
  if (dryRun) { log(`  [dry-run] copy ${path.relative(PKG_ROOT, src)} -> ${dest}`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });            // idempotent: replace
  fs.cpSync(src, dest, { recursive: true });                    // COPY (not symlink) — Windows-safe
}
function copyFile(src, dest, dryRun) {
  if (dryRun) { log(`  [dry-run] copy ${path.relative(PKG_ROOT, src)} -> ${dest}`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Remove every prior `banker-*` skill dir and prompt file so a re-run is a clean
// reinstall — a skill dropped from the manifest (or renamed) never lingers as a stale duplicate.
function sweepCodexArtifacts(base, dryRun) {
  let removed = 0;
  for (const sub of ['skills', 'prompts']) {
    const dir = path.join(base, sub);
    let entries = [];
    try { entries = fs.readdirSync(dir).filter(d => d.startsWith('banker-')); } catch { /* dir absent */ }
    for (const e of entries) {
      const p = path.join(dir, e);
      if (dryRun) { log(`  [dry-run] sweep ${p}`); continue; }
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// Read a SKILL.md frontmatter `name:` (used by doctor to verify the Codex dir==name rule).
function readSkillName(skillMd) {
  let src;
  try { src = fs.readFileSync(skillMd, 'utf8'); } catch { return null; }
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1] : null;
}

// Codex discovers skills by directory and expects the SKILL.md frontmatter `name:` to equal the
// directory name. Our Codex dir is `banker-<name>` (prefixed to avoid colliding with omx/system
// skills), so rewrite ONLY the first `name:` line inside the YAML frontmatter to match.
function setCodexSkillName(skillMd, newName, dryRun) {
  if (dryRun) { log(`  [dry-run] set frontmatter name: ${newName}`); return; }
  let src;
  try { src = fs.readFileSync(skillMd, 'utf8'); } catch { return; }
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return;                                   // no frontmatter — leave untouched
  let block = fm[1];
  block = /^name:.*$/m.test(block) ? block.replace(/^name:.*$/m, `name: ${newName}`) : `name: ${newName}\n${block}`;
  fs.writeFileSync(skillMd, src.slice(0, fm.index) + `---\n${block}\n---` + src.slice(fm.index + fm[0].length));
}

/* ---------- Claude Code target ---------- */
function setupClaude(dryRun) {
  log('• Claude Code:');
  if (!have('claude')) { warn('  claude CLI not found on PATH — install Claude Code first. Skipping --claude.'); return false; }
  const steps = [
    ['claude', ['plugin', 'marketplace', 'add', PKG_ROOT]],          // local dir is a marketplace (.claude-plugin/marketplace.json)
    ['claude', ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE}`]],
  ];
  for (const [bin, args] of steps) {
    if (dryRun) { log(`  [dry-run] ${bin} ${args.join(' ')}`); continue; }
    try { cp.execFileSync(bin, args, { stdio: 'inherit' }); }
    catch (e) { warn(`  step failed (may already be applied): ${bin} ${args.join(' ')}`); }
  }
  log('  → skills/commands available as /banker:* (reload-plugins or restart to apply).');
  log('  → for all-in-one / ultra-init / front-qa, install OMC too: run /banker:setup and pick oh-my-claudecode (or `omc update`).');
  return true;
}

/* ---------- Codex target ---------- */
function setupCodex(dryRun, scope) {
  log(`• Codex CLI (scope=${scope}):`);
  const m = readManifest();
  const base = codexBase(scope);
  const skillsDir = path.join(base, 'skills');
  const promptsDir = path.join(base, 'prompts');
  // Clean reinstall: remove any prior banker-* first so an update never leaves a stale duplicate.
  const swept = sweepCodexArtifacts(base, dryRun);
  if (swept) log(`  swept ${swept} prior banker-* artifact(s) before reinstall.`);
  let nSkill = 0, nCmd = 0;
  for (const s of eligible(m)) {
    if (s.type === 'skill') {
      const dest = path.join(skillsDir, `banker-${s.name}`);
      copyDir(path.join(PKG_ROOT, 'skills', s.name), dest, dryRun);
      setCodexSkillName(path.join(dest, 'SKILL.md'), `banker-${s.name}`, dryRun); // dir==name (Codex discovery)
      nSkill++;
    } else if (s.type === 'command') {
      copyFile(path.join(PKG_ROOT, 'commands', `${s.name}.md`), path.join(promptsDir, `banker-${s.name}.md`), dryRun);
      nCmd++;
    }
  }
  log(`  → ${nSkill} skills -> ${path.join(base, 'skills', 'banker-*')}, ${nCmd} prompts -> ${path.join(base, 'prompts', 'banker-*.md')}`);
  log('  → skills are invoked as `banker-<name>` (frontmatter name rewritten to match the dir).');
  log('  → ~/.codex/AGENTS.md is NOT modified (omx regenerates it); skills auto-discovered from ~/.codex/skills/.');
  return true;
}

/* ---------- doctor ---------- */
function doctor() {
  log(`banker v${version()}  (pkg: ${PKG_ROOT})`);
  log(`plugin.json version: ${(() => { try { return require(PLUGIN_JSON).version; } catch { return '?'; } })()}`);
  log('Claude Code:');
  log(`  claude CLI: ${have('claude') ? 'found' : 'NOT found'}`);
  log('Codex CLI:');
  const base = codexBase('user');
  const sdir = path.join(base, 'skills');
  let installed = [];
  try { installed = fs.readdirSync(sdir).filter(d => d.startsWith('banker-')); } catch {}
  log(`  codex CLI: ${have('codex') ? 'found' : 'NOT found'}`);
  log(`  installed banker skills in ~/.codex/skills: ${installed.length}`);
  // Codex only discovers a skill when its dir name equals the SKILL.md `name:` — flag any mismatch.
  const mismatched = installed
    .map(d => ({ d, name: readSkillName(path.join(sdir, d, 'SKILL.md')) }))
    .filter(x => x.name && x.name !== x.d);
  if (mismatched.length) {
    log(`  ⚠ dir/name mismatch (Codex will NOT list these) — reinstall with this version:`);
    for (const x of mismatched) log(`      ${x.d}/  has  name: ${x.name}`);
  }
  if (have('codex') && installed.length === 0) log('  ⚠ codex found but 0 banker skills installed — run: banker setup --codex');
  const m = readManifest();
  const nSkills = eligible(m).filter(s => s.type === 'skill').length;
  log(`  manifest: ${eligible(m).length} codex-eligible surfaces (${nSkills} skills) of ${m.surfaces.length}.`);
  log('Dependencies: all-in-one / ultra-init / front-qa need OMC (Claude) or OMX (Codex); browser skills need playwright.');
  log('  → install via /banker:setup (Claude) or the setup-* skills; skills also guide you if a dependency is missing.');
}

/* ---------- uninstall ---------- */
function uninstallClaude(dryRun) {
  log('• Claude Code uninstall:');
  if (!have('claude')) { warn('  claude CLI not found; skipping.'); return; }
  for (const args of [['plugin', 'uninstall', PLUGIN_NAME], ['plugin', 'marketplace', 'remove', MARKETPLACE]]) {
    if (dryRun) { log(`  [dry-run] claude ${args.join(' ')}`); continue; }
    try { cp.execFileSync('claude', args, { stdio: 'inherit' }); } catch { warn(`  (not present) claude ${args.join(' ')}`); }
  }
}
function uninstallCodex(dryRun, scopes) {
  // sweep each scope (default = both user+project so project installs aren't orphaned)
  for (const scope of scopes) {
    log(`• Codex uninstall (scope=${scope}):`);
    const base = codexBase(scope);
    let removedAny = false;
    for (const sub of ['skills', 'prompts']) {
      const dir = path.join(base, sub);
      let entries = [];
      try { entries = fs.readdirSync(dir).filter(d => d.startsWith('banker-')); } catch {}
      for (const e of entries) {
        const p = path.join(dir, e);
        if (dryRun) { log(`  [dry-run] rm ${p}`); continue; }
        fs.rmSync(p, { recursive: true, force: true });
      }
      if (entries.length) { log(`  removed ${entries.length} banker-* from ${dir}`); removedAny = true; }
    }
    if (!removedAny) log(`  (nothing in ${base})`);
  }
}

/* ---------- telemetry config bridge ---------- */
// bin/banker.js is CommonJS; telemetry-config is ESM (.mjs). Load it lazily via dynamic import
// (pathToFileURL keeps the specifier valid on Windows). Only the interactive setup path and the
// telemetry subcommand call this, so the non-TTY / dry-run setup path never imports it.
async function loadTelemetry() {
  return import(pathToFileURL(path.join(__dirname, 'lib', 'telemetry-config.mjs')).href);
}

/* ---------- setup first-run prompts (US-6) ---------- */
// Interactive-only. ABSOLUTE rule: never prompt or persist in a non-TTY / CI / dry-run context.
// scripts/smoke-test.js runs `setup --claude --dry-run` non-interactively; a blocking read here
// would hang CI forever. The isTTY + dryRun guard below is the single gate that prevents that.
async function maybeFirstRunPrompts(a) {
  if (!process.stdin.isTTY || a.dryRun) return;                     // non-TTY / CI / dry-run: do nothing
  const tc = await loadTelemetry();
  const cfg = tc.readConfig();
  const askStar = cfg.promptedStarV1 !== true;
  // count-default-on: 카운팅은 opt-in 질문이 아니라 투명 고지(차단 프롬프트 아님). --claude 관여 시에만 1회 출력.
  const showTelemetryNotice = a.claude && cfg.promptedTelemetryV2 !== true;
  if (!askStar && !showTelemetryNotice) return;                     // already shown before - never re-show

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const next = { ...cfg };
  try {
    if (askStar) {
      const ans = (await ask('banker가 유용했다면 GitHub 별(star)을 눌러 주세요. [Y/n] ')).trim().toLowerCase();
      if (ans === '' || ans === 'y' || ans === 'yes') {
        log('GitHub 별을 누르는 중...'); // gh 네트워크가 느리면 최대 10초 블로킹이라 진행 표시.
        const star = starRepo(); // gh CLI 로 실제 별을 단다(인증 필요).
        if (star.ok) {
          log('감사합니다. GitHub 별을 눌렀습니다.');
        } else {
          log(`자동으로 누르지 못했습니다(${star.reason}). 아래에서 직접 눌러 주세요:`);
          log(`  ${REPO_URL}`);
        }
      }
      next.promptedStarV1 = true;
    }
    if (showTelemetryNotice) {
      log('banker 는 익명 사용량 카운트를 기본 수집합니다(스킬별 호출수·버전·OS·식별자 없음).');
      log('끄려면 BANKER_NO_TELEMETRY=1 또는 `banker telemetry off`. 자세히: PRIVACY.md');
      next.promptedTelemetryV2 = true;
    }
  } finally {
    rl.close();
  }
  tc.writeConfig(next);
}

/* ---------- telemetry subcommand (US-08, count-default-on) ---------- */
const TELEMETRY_USAGE = `Usage: banker telemetry <on|off|status>
  on      카운팅 opt-out 을 해제 (기본값인 켜짐으로 복귀)
  off     카운팅을 끔 (config.telemetry=false 로 opt-out)
  status  카운팅 / 업데이트-체크의 opt-out · 엔드포인트 · 캐시 상태를 정직하게 출력`;

async function telemetryCmd(sub) {
  const tc = await loadTelemetry();
  if (sub === 'on' || sub === 'off') {
    const cfg = tc.readConfig();
    if (sub === 'off') cfg.telemetry = false;                        // opt-out 저장
    else delete cfg.telemetry;                                       // opt-out 해제: 기본-on 으로 복귀
    if (!tc.writeConfig(cfg)) {
      warn('banker: 설정을 저장하지 못했습니다 (config 쓰기 실패).');
      process.exitCode = 1;
      return;
    }
    if (sub === 'off') {
      log('카운팅을 껐습니다 (off). config.telemetry=false 로 opt-out 을 저장했습니다.');
    } else {
      log('카운팅 opt-out 을 해제했습니다 (on). 기본값(켜짐)으로 복귀합니다.');
      if (!tc.endpoint()) log('참고: 엔드포인트가 설정되어 있지 않아 지금은 아무것도 전송하지 않습니다.');
    }
    return;
  }
  if (sub === 'status') {
    const cfg = tc.readConfig();
    const v = process.env.BANKER_NO_TELEMETRY;
    const envOptOut = !(v === undefined || v === '' || v === '0' || v === 'false');
    const cfgOptOut = cfg.telemetry === false;
    log('banker 상태:');
    log('[카운팅] 익명 사용량 카운팅 (기본값: 켜짐 · count-default-on)');
    log(`  엔드포인트 설정: ${tc.endpoint() != null ? '설정됨' : '미설정'}`);
    log(`  opt-out(BANKER_NO_TELEMETRY): ${envOptOut ? '적용됨' : '미적용'}`);
    log(`  opt-out(config.telemetry=false): ${cfgOptOut ? '적용됨' : '미적용'}`);
    log(`  실효 상태(effective): ${tc.countingActive() ? 'enabled' : 'disabled'}`);
    log('  참고: 엔드포인트가 설정되어 있고 opt-out 이 아닐 때(env·config 둘 다 아님)만 실제로 전송됩니다.');

    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(tc.UPDATE_CHECK_PATH, 'utf8')); } catch { /* 캐시 없음/malformed */ }
    const installed = tc.installedVersion();
    const cmp = (cache.latest && installed) ? tc.compareVersions(cache.latest, installed) : null;
    log('[업데이트 체크] 새 버전 알림 (기본값: 켜짐)');
    log(`  opt-out(BANKER_NO_UPDATE_CHECK/config.updateCheck=false): ${tc.noUpdateCheck() ? '적용됨' : '미적용'}`);
    log(`  마지막 체크: ${cache.checkedAt ? new Date(cache.checkedAt).toISOString() : '없음'}`);
    log(`  캐시된 최신 버전: ${cache.latest || '없음'} / 설치된 버전: ${installed || '알 수 없음'}`);
    log(cmp === null ? '  비교 불가 (캐시 없음 또는 malformed)'
      : cmp > 0 ? `  업데이트 있음 (${installed} → ${cache.latest})`
      : '  최신 버전 사용 중');
    return;
  }
  log(TELEMETRY_USAGE);                                              // 알 수 없는 하위명령: 사용법 출력
}

const HELP = `banker v${version()} — install the banker plugin into Claude Code and/or Codex CLI

Usage:
  banker setup [--claude] [--codex] [--scope user|project] [--dry-run]
  banker uninstall [--claude] [--codex] [--scope user|project] [--dry-run]
  banker telemetry <on|off|status>
  banker doctor
  banker help

Notes:
  - setup/uninstall with no target flag applies to BOTH tools.
  - --claude registers the marketplace + installs banker@banker-plugins (skills as /banker:*).
  - --codex copies codex-eligible skills -> ~/.codex/skills/banker-* and commands -> ~/.codex/prompts/banker-*.md.
  - telemetry on|off toggles anonymous usage counting opt-out (default-on; config only); status prints counting + update-check state. See PRIVACY.md.
  - Never runs as root. --dry-run prints planned actions without writing.`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.version) { log(version()); return; }
  if (a.help || a.cmd === 'help' || !a.cmd) { log(HELP); return; }
  if (a.cmd === 'doctor') { doctor(); return; }
  if (a.cmd === 'telemetry') { await telemetryCmd(a.sub); return; }
  assertNotRoot();
  if (a.cmd === 'setup') {
    log(`banker setup${a.dryRun ? ' (dry-run)' : ''}: claude=${a.claude} codex=${a.codex}`);
    if (a.claude) setupClaude(a.dryRun);
    if (a.codex) setupCodex(a.dryRun, a.scope);
    // Best-effort first-run prompts (interactive TTY only). A prompt failure must never fail setup.
    try { await maybeFirstRunPrompts(a); } catch { /* non-fatal */ }
    log('done.');
    return;
  }
  if (a.cmd === 'uninstall') {
    if (a.claude) uninstallClaude(a.dryRun);
    if (a.codex) uninstallCodex(a.dryRun, a.scopeExplicit ? [a.scope] : ['user', 'project']);
    log('done.');
    return;
  }
}
// CLI 로 직접 실행될 때만 main 을 돌린다. 테스트가 require 로 import 하면 main 은 안 돌고 starRepo 만 노출.
if (require.main === module) {
  main().catch((e) => { warn('banker:', e && e.message ? e.message : e); process.exitCode = 1; });
}

module.exports = { starRepo };
