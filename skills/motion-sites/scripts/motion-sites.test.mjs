// motion-sites engine: plugin lookup for both runtimes, the setup order and its failures, with a fake runner (no
// network, no install). Temp folders only.
// Run: node --test skills/motion-sites/scripts/motion-sites.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { byVersion, cacheHome, claudePlugin, run, claudeSkill, codexPlugin, codexSkill, main, pythons, reachable, setup, sources, status } from "./motion-sites.mjs";

const CLI = fileURLToPath(new URL("./motion-sites.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "motion-sites-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(base, String(n++));
  mkdirSync(d, { recursive: true });
  return d;
};
const ID = "motionsites-web-builder@motionsites";

// A Codex home with the plugin on (or off) and these cached versions.
function codexHome({ enabled = true, versions = ["1.0.0"] } = {}) {
  const h = fresh();
  writeFileSync(join(h, "config.toml"), `model = "x"\n\n[plugins."${ID}"]\nenabled = ${enabled}\n\n[marketplaces.motionsites]\nsource_type = "git"\n`);
  for (const v of versions) {
    const d = join(h, "plugins", "cache", "motionsites", "motionsites-web-builder", v, "skills", "motionsites-web-builder");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `# ${v}\n`);
  }
  return h;
}

// A fake runner: answers by the first matching [test, result] rule and records every call. A rule's out is stdout
// unless it gives stdout itself; the reachability probe (node -e ... net) answers yes unless a rule says otherwise.
function fake(rules) {
  const calls = [];
  const all = [...rules, [/require\('net'\)/, { ok: true }]];
  const runner = (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, timeout: opts.timeout });
    const hit = all.find(([re]) => re.test(line));
    const r = hit ? (typeof hit[1] === "function" ? hit[1](line) : hit[1]) : { ok: false, out: "", why: `${cmd} 실행 실패(ENOENT)` };
    return { out: "", why: null, ...r, stdout: r.stdout ?? r.out ?? "" };
  };
  return { runner, calls };
}
const PY_OK = [
  [/-c import sys/, { ok: true, out: "/usr/bin/python3\n" }],
  [/-c import playwright$/, { ok: true }],
];

test("codexSkill: on in config.toml and cached: the newest version's SKILL.md; off or missing: null", () => {
  const h = codexHome({ versions: ["1.0.0", "1.10.0", "1.9.2"] });
  assert.equal(codexSkill({ CODEX_HOME: h }), join(h, "plugins", "cache", "motionsites", "motionsites-web-builder", "1.10.0", "skills", "motionsites-web-builder", "SKILL.md"));
  assert.equal(codexSkill({ CODEX_HOME: codexHome({ enabled: false }) }), null);
  assert.equal(codexSkill({ CODEX_HOME: codexHome({ versions: [] }) }), null);
  assert.equal(codexSkill({ CODEX_HOME: fresh() }), null, "no config.toml");
});

test("claudeSkill: the enabled plugin's installPath from claude plugin list --json, only when its SKILL.md is there", () => {
  const p = fresh();
  const f = join(p, "skills", "motionsites-web-builder", "SKILL.md");
  mkdirSync(join(p, "skills", "motionsites-web-builder"), { recursive: true });
  writeFileSync(f, "x");
  const list = (enabled) => JSON.stringify([{ id: "other@x", installPath: "/nope" }, { id: ID, enabled, installPath: p }]);
  assert.equal(claudeSkill(fake([[/plugin list/, { ok: true, out: list(true) }]]).runner), f);
  assert.equal(claudeSkill(fake([[/plugin list/, { ok: true, out: list(false) }]]).runner), null, "disabled");
  assert.equal(claudeSkill(fake([[/plugin list/, { ok: true, out: "not json" }]]).runner), null);
  assert.equal(claudeSkill(fake([]).runner), null, "claude not found");
});

test("byVersion orders numerically, not as text", () => {
  assert.deepEqual(["1.10.0", "1.2.0", "1.9.9", "2.0.0", "2.0.0-rc1", "2.0.0.1"].sort(byVersion), ["1.2.0", "1.9.9", "1.10.0", "2.0.0-rc1", "2.0.0", "2.0.0.1"]);
});

test("pythons: MOTION_SITES_PYTHON first, then the cache's virtual environment, then the system's", () => {
  const env = { MOTION_SITES_PYTHON: "/opt/py/bin/python3", MOTION_SITES_HOME: "/c" };
  const list = pythons(env);
  assert.deepEqual(list[0], ["/opt/py/bin/python3"]);
  assert.match(list[1][0], /[\\/]c[\\/]venv[\\/](bin|Scripts)[\\/]python/);
  assert.ok(list.length >= 4);
  assert.equal(cacheHome({ MOTION_SITES_HOME: "/x" }), "/x");
});

test("status: ready only with the plugin, Playwright and Chromium", () => {
  const h = codexHome();
  const chromium = join(fresh(), "chrome");
  writeFileSync(chromium, "");
  const env = { CODEX_HOME: h, MOTION_SITES_HOME: fresh() };
  const ready = status("codex", { env, runner: fake([...PY_OK, [/sync_playwright/, { ok: true, out: `${chromium}\n` }]]).runner });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.python, { bin: "/usr/bin/python3", playwright: true, chromium: true });
  const noChrome = status("codex", { env, runner: fake([...PY_OK, [/sync_playwright/, { ok: true, out: "/gone/chrome\n" }]]).runner });
  assert.equal(noChrome.ready, false);
  assert.equal(noChrome.python.chromium, false);
});

test("setup on Claude Code: marketplace add, plugin install, pip install playwright, playwright install chromium, in order", () => {
  const env = { MOTION_SITES_HOME: fresh() };
  const { runner, calls } = fake([
    [/plugin list/, { ok: true, out: "[]" }],
    [/marketplace add Motionsites-AI\/claude-skill/, { ok: true }],
    [/plugin install motionsites-web-builder@motionsites/, { ok: true }],
    [/-c import sys/, { ok: true, out: "/usr/bin/python3\n" }],
    [/-m pip install playwright/, { ok: true }],
    [/-m playwright install chromium/, { ok: true }],
  ]);
  const r = setup("claude", { env, runner });
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [
    ["marketplace add", true],
    ["plugin install", true],
    ["pip install playwright", true],
    ["playwright install chromium", true],
  ]);
  const order = calls.map((c) => c.line).filter((l) => /marketplace add|plugin install|pip install|playwright install/.test(l));
  assert.equal(order.length, 4);
  assert.ok(calls.filter((c) => /install|add/.test(c.line)).every((c) => c.timeout >= 60000), "each step has a time limit");
});

test("setup on Codex: codex plugin marketplace add, then codex plugin add", () => {
  const env = { CODEX_HOME: fresh(), MOTION_SITES_HOME: fresh() };
  const { runner, calls } = fake([[/^codex plugin/, { ok: true }], ...PY_OK, [/sync_playwright/, { ok: true, out: "/gone\n" }], [/install chromium/, { ok: true }]]);
  setup("codex", { env, runner });
  const plugin = calls.map((c) => c.line).filter((l) => l.startsWith("codex plugin"));
  assert.deepEqual(plugin, ["codex plugin marketplace add Motionsites-AI/claude-skill", "codex plugin add motionsites-web-builder@motionsites"]);
});

test("setup: a marketplace already there is fine when the install works; a failed install stops before Python", () => {
  const env = { MOTION_SITES_HOME: fresh() };
  const ok = setup("claude", { env, runner: fake([[/plugin list/, { ok: true, out: "[]" }], [/marketplace add/, { ok: false, out: "already added", why: "x" }], [/plugin install/, { ok: true }], ...PY_OK]).runner });
  assert.deepEqual(ok.steps.slice(0, 2).map((s) => s.ok), [true, true]);
  const { runner, calls } = fake([[/plugin list/, { ok: true, out: "[]" }], [/marketplace add/, { ok: false, out: "", why: "시간 초과(600초)" }], [/plugin install/, { ok: false, out: "", why: "claude plugin install 종료 1: not found" }]]);
  const bad = setup("claude", { env, runner });
  assert.equal(bad.ready, false);
  assert.deepEqual(bad.steps.map((s) => [s.step, s.ok]), [["marketplace add", false], ["plugin install", false]]);
  assert.match(bad.steps[0].why, /시간 초과/);
  assert.equal(calls.some((c) => /pip install/.test(c.line)), false, "nothing more after a failed step");
});

test("setup: pip refusing the system Python (externally managed) puts Playwright in the cache's virtual environment", () => {
  const home = fresh();
  const env = { CODEX_HOME: codexHome(), MOTION_SITES_HOME: home };
  const { runner, calls } = fake([
    [/-c import sys/, { ok: true, out: "/usr/bin/python3\n" }],
    [/^(python3|python|py -3) -m pip install playwright/, { ok: false, out: "error: externally-managed-environment", why: "x" }],
    [/-m venv /, { ok: true }],
    [/venv.*-m pip install playwright/, { ok: true }],
    [/venv.*-m playwright install chromium/, { ok: true }],
  ]);
  const r = setup("codex", { env, runner });
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [["pip install playwright", true], ["playwright install chromium", true]]);
  assert.ok(calls.some((c) => c.line.includes(join(home, "venv"))));
});

test("command line: usage errors exit 2, --help exits 0, path without the plugin exits 1", () => {
  const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["status"]).status, 2);
  assert.equal(cli(["status", "--runtime", "gemini"]).status, 2);
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^motion-sites: /);
  const none = cli(["path", "--runtime", "codex"], { CODEX_HOME: fresh() });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /설치되지 않음/);
  const h = codexHome();
  const found = cli(["path", "--runtime", "codex"], { CODEX_HOME: h });
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /motionsites-web-builder[\\/]SKILL\.md/);
  assert.equal(main(["nope"], () => {}, () => {}), 2);
});

test("codexPlugin: enabled = false after an array value holding [ is still read as off", () => {
  const h = codexHome();
  writeFileSync(join(h, "config.toml"), `[plugins."${ID}"]\ntags = ["a", "b"]\nenabled = false\n\n[other]\nx = 1\n`);
  assert.deepEqual(codexPlugin({ CODEX_HOME: h }), { file: null, disabled: true });
  writeFileSync(join(h, "config.toml"), `[plugins."${ID}"]\ntags = ["a"]\n\n[other]\nenabled = false\n`);
  assert.equal(codexPlugin({ CODEX_HOME: h }).disabled, false, "another table's enabled is not this plugin's");
});

test("claudePlugin: JSON from stdout only, so a warning on stderr does not hide the plugin; a disabled one is told apart", () => {
  const p = fresh();
  mkdirSync(join(p, "skills", "motionsites-web-builder"), { recursive: true });
  writeFileSync(join(p, "skills", "motionsites-web-builder", "SKILL.md"), "x");
  const list = (enabled) => JSON.stringify([{ id: ID, enabled, installPath: p }]);
  const warned = (enabled) => fake([[/plugin list/, { ok: true, stdout: list(enabled), out: `${list(enabled)}warning: [update] a newer version\n` }]]).runner;
  assert.equal(claudePlugin(warned(true)).file, join(p, "skills", "motionsites-web-builder", "SKILL.md"));
  assert.deepEqual(claudePlugin(warned(false)), { file: null, disabled: true });
});

test("setup: a disabled plugin is turned on (Claude Code) or named with where to turn it on (Codex), not installed again", () => {
  const p = fresh();
  mkdirSync(join(p, "skills", "motionsites-web-builder"), { recursive: true });
  writeFileSync(join(p, "skills", "motionsites-web-builder", "SKILL.md"), "x");
  const env = { MOTION_SITES_HOME: fresh() };
  const { runner, calls } = fake([[/plugin list/, { ok: true, out: JSON.stringify([{ id: ID, enabled: false, installPath: p }]) }], [/plugin enable/, { ok: true }], ...PY_OK]);
  const r = setup("claude", { env, runner });
  assert.deepEqual(r.steps[0], { step: "plugin enable", ok: true, why: null });
  assert.equal(calls.some((c) => /plugin install|marketplace add/.test(c.line)), false);
  const h = codexHome({ enabled: false });
  const c = setup("codex", { env: { ...env, CODEX_HOME: h }, runner: fake(PY_OK).runner });
  assert.equal(c.steps[0].ok, false);
  assert.match(c.steps[0].why, /enabled = true/);
});

test("setup offline: a source that does not answer stops its step with the reason, before any download", () => {
  const env = { MOTION_SITES_HOME: fresh() };
  const { runner, calls } = fake([[/plugin list/, { ok: true, out: "[]" }], [/require\('net'\).* github\.com$/, { ok: false }]]);
  const r = setup("claude", { env, runner });
  assert.deepEqual(r.steps, [{ step: "marketplace add", ok: false, why: "오프라인이라 설치하지 않음(github.com 에 닿지 않음)" }]);
  assert.equal(calls.some((c) => /marketplace add|plugin install|pip install/.test(c.line)), false);
  const h = codexHome();
  const py = setup("codex", { env: { ...env, CODEX_HOME: h }, runner: fake([...PY_OK.slice(0, 1), [/require\('net'\).* pypi\.org$/, { ok: false }]]).runner });
  assert.deepEqual(py.steps, [{ step: "pip install playwright", ok: false, why: "오프라인이라 설치하지 않음(pypi.org 에 닿지 않음)" }]);
});

test("reachable: not judged behind a proxy; sources follow the mirrors named in the environment", () => {
  assert.equal(reachable("github.com", { env: { HTTPS_PROXY: "http://p:3128" }, runner: () => assert.fail("no probe behind a proxy") }), null);
  assert.deepEqual(sources({ PIP_INDEX_URL: "https://mirror.example/simple", PLAYWRIGHT_DOWNLOAD_HOST: "https://dl.example" }), { plugin: ["github.com"], pip: ["mirror.example"], chromium: ["dl.example"] });
  assert.deepEqual(sources({}), { plugin: ["github.com"], pip: ["pypi.org"], chromium: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"] });
});

test("setup: a mirror set in git or pip configuration is not judged offline by the public host; Chromium needs one host of two", () => {
  const env = { MOTION_SITES_HOME: fresh() };
  const git = fake([[/plugin list/, { ok: true, out: "[]" }], [/^git config --get-regexp/, { ok: true, out: "url.https://mirror.example/.insteadof https://github.com/\n" }], [/require\('net'\)/, { ok: false }], [/marketplace add|plugin install/, { ok: true }]]);
  const r = setup("claude", { env, runner: git.runner });
  assert.deepEqual(r.steps.slice(0, 2).map((x) => x.ok), [true, true], "the install was tried, not refused as offline");
  const h = codexHome();
  const pip = fake([...PY_OK.slice(0, 1), [/-m pip config list/, { ok: true, out: "global.index-url='https://mirror.example/simple'\n" }], [/require\('net'\)/, { ok: false }], [/-m pip install playwright/, { ok: true }], [/install chromium/, { ok: true }]]);
  const q = setup("codex", { env: { ...env, CODEX_HOME: h }, runner: pip.runner });
  assert.equal(q.steps[0].ok, true);
  const one = fake([...PY_OK, [/require\('net'\).* cdn\.playwright\.dev$/, { ok: false }], [/sync_playwright/, { ok: true, out: "/gone\n" }], [/install chromium/, { ok: true }]]);
  const c = setup("codex", { env: { ...env, CODEX_HOME: h }, runner: one.runner });
  assert.deepEqual(c.steps, [{ step: "playwright install chromium", ok: true, why: null }], "the second host answered");
});

test("run starts programs in the home folder, not the working folder (python -c and -m import from there, Windows finds programs there)", () => {
  const r = run(process.execPath, ["-e", "process.stdout.write(process.cwd())"]);
  assert.equal(r.ok, true, r.why);
  assert.equal(realpathSync(r.stdout), realpathSync(homedir()));
});

