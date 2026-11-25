// Every command file that decides "am I run, or imported?" from process.argv[1] still runs when realpath cannot read
// that path (remains 0.29.0 F). The check used to answer false then, so the command printed nothing and exited 0.
// Each file is run twice by its real path, once as usual and once with realpath failing for argv[1]
// (realpath-fails.mjs); both runs must give the same exit code and output, and the usual run must show that it ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PRELOAD = pathToFileURL(join(ROOT, "scripts", "test-fixtures", "realpath-fails.mjs")).href;
const BOGUS = ["--no-such-flag-x"];

// Hooks print nothing for an empty payload; that they read stdin shows that main ran.
const HOOK = { args: [], input: "{}", stdin: true };
const STOP = { args: ["--stop"] }; // a review server start would keep running; --stop with no state just says so

const CASES = {
  "codex/renamed-skills/append_wiki/wiki.mjs": {},
  "codex/renamed-skills/setup-omx-hud/assets/codex-status-line.mjs": {},
  "codex/renamed-skills/setup-omx-hud/scripts/claude-update-last.mjs": {},
  "codex/skills/progress/scripts/progress.mjs": {},
  "codex/skills/ralph/scripts/gate-evidence.mjs": {},
  "codex/skills/ralph/scripts/ralph-state.mjs": {},
  "codex/skills/teamwork/scripts/teamwork.mjs": {},
  "hooks/obsidize-hook.mjs": HOOK,
  "hooks/ralph-continue-codex.mjs": HOOK,
  "hooks/stop-codex.mjs": HOOK,
  "hooks/update-notify.mjs": HOOK,
  "scripts/test-fixtures/omc-wiki-cases.mjs": {},
  "scripts/test-fixtures/omx-wiki-cases.mjs": {},
  "scripts/test-fixtures/seat-stub.mjs": { input: "" },
  "skills/3d-intro-build/references/assemble.mjs": {},
  "skills/3d-intro-build/references/curate.mjs": STOP,
  "skills/3d-intro-build/references/serve.mjs": STOP,
  "skills/3d-intro-build/references/verify-intro.mjs": {},
  "skills/anti-drm/scripts/anti-drm.mjs": {},
  "skills/append_wiki/wiki.mjs": {},
  "skills/build-testbox/scripts/browser-cell.mjs": {},
  "skills/build-testbox/scripts/testbox.mjs": {},
  "skills/git-init/scripts/git-init.mjs": {},
  "skills/git-init/scripts/payload-scan.mjs": {},
  "skills/init-dir/scripts/init-dir.mjs": {},
  "skills/make-evidence/scripts/evidence.mjs": {},
  "skills/motion-graphic-make/references/curate.mjs": STOP,
  "skills/motion-graphic-make/references/serve.mjs": STOP,
  "skills/motion-sites/scripts/motion-sites.mjs": {},
  "skills/obsidizer/obsidize.mjs": {},
  "skills/omc-patch/scripts/drm-progress.mjs": {},
  "skills/omc-patch/scripts/probe-pm.mjs": {},
  "skills/payload-mon/scripts/payload-mon.mjs": {},
  "skills/presentation-graphic-gen/scripts/apply-fix.mjs": {},
  "skills/presentation-graphic-gen/scripts/build.mjs": {},
  "skills/presentation-graphic-gen/scripts/cdp.mjs": {},
  "skills/presentation-graphic-gen/scripts/check.mjs": {},
  "skills/presentation-graphic-gen/scripts/make.mjs": {},
  "skills/presentation-graphic-gen/scripts/pptx-anim-probe.mjs": {},
  "skills/presentation-graphic-gen/scripts/pptx-edit.mjs": {},
  "skills/presentation-graphic-gen/scripts/pptx-video.mjs": {},
  "skills/presentation-graphic-gen/scripts/pptx.mjs": {},
  "skills/presentation-graphic-gen/scripts/record.mjs": {},
  "skills/progress-mon/scripts/progress-mon.mjs": {},
  "skills/ralph-qa/references/gate-evidence.mjs": {},
  "skills/ralph-qa/references/gemini-seat.mjs": {},
  "skills/ralph-qa/references/payload-scan.mjs": {},
  "skills/ralph-qa/references/seat-run.mjs": {},
  "skills/ralph-qa/references/verifier-probe.mjs": { args: ["--runtime=claude"] }, // no CLI flag: starts no codex
  "skills/remains/scripts/boxes.mjs": {},
  "skills/setup-bypass-permissions/scripts/bypass-permissions.mjs": {},
  "skills/setup-bypass-permissions/scripts/codex-bypass.mjs": {},
  "skills/setup-omc-hud/assets/codex-status-line.mjs": {},
  "skills/setup-omc-hud/scripts/claude-update-last.mjs": {},
  "skills/smart-compact/scripts/codex-gate.mjs": {},
  "skills/theme-selection/scripts/themes.mjs": {},
  "skills/tone-compact/scripts/tone-compact.mjs": {},
  "skills/transfer-string/scripts/transfer-string.mjs": {},
  "skills/tune-tmux/scripts/tune-tmux.mjs": {},
  "skills/ultra-chain/references/capture.mjs": {},
  "skills/ultra-chain/references/chain-ledger.mjs": {},
  "skills/ultra-chain/references/chain-report.mjs": {},
  "skills/ultra-chain/references/serve.mjs": STOP,
  "skills/ultraqa/references/gate-evidence.mjs": {},
  "skills/ultraqa/references/uqa-run.mjs": {},
  "skills/vertical-pptx/verify_a4p.mjs": {},
  "skills/video-gen/scripts/video-gen.mjs": {},
  "skills/wbs-gen/scripts/wbs-gen.mjs": {},
  "skills/wide-pptx/scripts/wide-pptx.mjs": {},
};

// Files that name process.argv[1] and import.meta.url but decide nothing from realpath.
const NOT_AN_ENTRY_CHECK = {
  "codex/renamed-skills/setup-omx-hud/assets/omc-hud-custom.mjs": "a status line that always runs; argv[1] only finds its folder",
  "skills/setup-omc-hud/assets/omc-hud-custom.mjs": "a status line that always runs; argv[1] only finds its folder",
  "hooks/telemetry-count-codex.mjs": "matches argv[1] by its file name, no realpath",
};

function tracked() {
  const r = spawnSync("git", ["ls-files", "-z", "*.mjs", "*.js", "*.cjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").filter((f) => f && !/\.test\.mjs$|(^|\/)(vendor|third_party|node_modules)\//.test(f));
}

test("every tracked file that checks process.argv[1] against import.meta.url is in the table", { skip: !existsSync(join(ROOT, ".git")) && "not a git checkout" }, () => {
  const found = tracked().filter((f) => {
    const text = readFileSync(join(ROOT, f), "utf8");
    return /process\.argv\[1\]/.test(text) && /import\.meta\.url/.test(text);
  });
  const listed = new Set([...Object.keys(CASES), ...Object.keys(NOT_AN_ENTRY_CHECK)]);
  assert.deepEqual(found.filter((f) => !listed.has(f)), [], "add the new command file to CASES");
  assert.deepEqual([...listed].filter((f) => !found.includes(f)), [], "a listed file is gone or no longer checks argv[1]");
});

function run(file, c, extraEnv) {
  const work = mkdtempSync(join(tmpdir(), "entry-realpath-"));
  const home = join(work, "home");
  const cwd = join(work, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  const mark = join(work, "stdin.mark");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), BANKER_NO_UPDATE_CHECK: "1", BANKER_NO_TELEMETRY: "1", BANKER_TEST_STDIN_MARK: mark, ...extraEnv };
  for (const k of ["CODEX_THREAD_ID", "TMUX", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT", "NODE_OPTIONS"]) delete env[k];
  try {
    const r = spawnSync(process.execPath, ["--import", PRELOAD, file, ...(c.args ?? BOGUS)], { cwd, env, input: c.input ?? "", encoding: "utf8", timeout: 60000 });
    const out = `${r.stdout}${r.stderr}`.split(work).join("<work>");
    return { status: r.status, signal: r.signal, out, stdin: existsSync(mark) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const [rel, c] of Object.entries(CASES)) {
  test(`${rel} runs when realpath cannot read argv[1]`, () => {
    const file = realpathSync(join(ROOT, rel));
    const usual = run(file, c, {});
    assert.equal(usual.signal, null, `the usual run ended by ${usual.signal}: ${usual.out}`);
    if (c.stdin) assert.ok(usual.stdin, "the usual run reads its payload");
    else assert.ok(usual.status !== 0 || usual.out.trim() !== "", "the usual run says something, so a silent exit 0 is told apart");
    const failing = run(file, c, { BANKER_TEST_REALPATH_FAILS: "1" });
    assert.deepEqual({ status: failing.status, out: failing.out, stdin: failing.stdin }, { status: usual.status, out: usual.out, stdin: usual.stdin });
  });
}
