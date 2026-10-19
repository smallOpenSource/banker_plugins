// Tests for ../assets/apply-hud.mjs. Run from the repo root: node --test skills/setup-omc-hud/scripts/*.test.mjs
// Every run gets its own HOME, USERPROFILE and CLAUDE_CONFIG_DIR under a temp folder, with a fake OMC
// version folder that holds only the two files the installer copies.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const APPLY = join(ASSETS, "apply-hud.mjs");
const root = mkdtempSync(join(tmpdir(), "apply-hud-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
// Mode bits are POSIX matters, and root writes files it may not.
const POSIX = process.platform !== "win32";
const posixOnly = { skip: !POSIX && "Windows has no POSIX mode bits" };
const asRoot = POSIX && process.getuid?.() === 0;
const modeOf = (p) => statSync(p).mode & 0o777;

let seq = 0;
const fresh = (name = "case") => {
  const dir = join(root, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const slash = (p) => p.split(sep).join("/");
const asset = (name) => readFileSync(join(ASSETS, name));

// The first line of OMC's diagnostic for a run with no input, which names the version that loaded.
const banner = (v) => `console.log("[OMC] HUD v${v} | preset: full");\n`;
// A fake OMC version folder: the loader template says which version it came from. `template: false` and
// `configDir: false` leave out either file the installer copies; `mode` sets the files' mode bits (POSIX).
// For the render check: `loader` replaces the template's text (the installed hud/omc-hud.mjs runs it),
// `pkg: true` writes the package.json OMC carries, `dist` the dist/hud/index.js its loader imports.
function omcFiles(dir, version, o) {
  const lib = join(dir, "scripts", "lib");
  return [
    [o.template !== false, join(lib, "hud-wrapper-template.txt"), o.loader ?? `// loader ${version}\n${banner(version)}`],
    [o.configDir !== false, join(lib, "config-dir.mjs"), "export const getClaudeConfigDir = () => '';\n"],
    [o.pkg === true, join(dir, "package.json"), JSON.stringify({ version }) + "\n"],
    [o.dist !== undefined, join(dir, "dist", "hud", "index.js"), o.dist],
  ].filter(([wanted]) => wanted);
}
function fakeOmc(dir, version, o = {}) {
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  for (const [, file, text] of omcFiles(dir, version, o)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (o.mode && POSIX) chmodSync(file, o.mode);
  }
}
const omcCache = (cfg) => join(cfg, "plugins", "cache", "omc", "oh-my-claudecode");
// Which fake version's template the installer copied: the loader's first line.
const loaderOf = (cfg) => readFileSync(join(cfg, "hud", "omc-hud.mjs"), "utf8").split("\n")[0];

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CONFIG_DIR|OMC_PLUGIN_ROOT|HOME|USERPROFILE)$/i.test(k)));
const INSTALL_DEFAULTS = { cwd: root, versions: ["5.7.4"], bare: [], half: [], env: {}, wrap: [], omcMode: undefined, omc: {} };
// Runs the installer. `cfg` is where the config folder really is; `value` is what CLAUDE_CONFIG_DIR
// says (default `cfg`, null to leave it unset). `bare` versions lack the template, `half` ones config-dir.mjs.
// `omc` holds more fakeOmc options per version; an `env.PATH` replaces the PATH under any spelling.
function install(opts) {
  const o = { ...INSTALL_DEFAULTS, home: fresh("home"), value: opts.cfg, ...opts };
  for (const v of o.versions) fakeOmc(join(omcCache(o.cfg), v), v, { mode: o.omcMode, ...o.omc[v] });
  for (const v of o.bare) fakeOmc(join(omcCache(o.cfg), v), v, { template: false });
  for (const v of o.half) fakeOmc(join(omcCache(o.cfg), v), v, { configDir: false });
  const base = cleanEnv();
  if (o.env.PATH !== undefined) for (const k of Object.keys(base)) if (/^path$/i.test(k)) delete base[k];
  const childEnv = { ...base, HOME: o.home, USERPROFILE: o.home, ...o.env };
  if (o.value !== null) childEnv.CLAUDE_CONFIG_DIR = o.value;
  const [cmd, ...args] = [...o.wrap, process.execPath, APPLY];
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: childEnv, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, err: r.stderr, home: o.home };
}
const settingsOf = (cfg) => JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8"));
const backups = (dir, name) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.backup.`)) : []);

// The two block tools as the skill runs them after an install, on the same config folder.
const PAYLOAD_MON = fileURLToPath(new URL("../../payload-mon/scripts/payload-mon.mjs", import.meta.url));
const CLAUDE_UPDATE_LAST = fileURLToPath(new URL("./claude-update-last.mjs", import.meta.url));
function turnOnTool(script, cfg, home) {
  const env = { ...cleanEnv(), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, PAYLOAD_MON_HUD_FILE: "", CLAUDE_UPDATE_LAST_HUD_FILE: "" };
  const r = spawnSync(process.execPath, [script, "on"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, `${script}: ${r.stdout}${r.stderr}`);
}

test("공백과 한글이 든 설정 폴더에 설치하면 statusLine 이 따옴표 친 슬래시 경로", () => {
  const cfg = join(fresh(), "claude cfg 한글");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "dark", env: { A: "1" } }));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  const s = settingsOf(cfg);
  assert.deepEqual(s.statusLine, { type: "command", command: `node "${slash(cfg)}/hud/omc-hud-custom.mjs"` });
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.env, { A: "1" });
  assert.ok(readFileSync(join(cfg, "hud", "omc-hud-custom.mjs")).equals(asset("omc-hud-custom.mjs")));
  assert.ok(readFileSync(join(cfg, ".omc", "hud-config.json")).equals(asset("hud-config.json")));
  assert.equal(loaderOf(cfg), "// loader 5.7.4");
  assert.ok(existsSync(join(cfg, "hud", "lib", "config-dir.mjs")));
  assert.match(r.out, /\[ok\] statusLine -> node "/);
});

test("BOM 이 있는 settings.json 을 받아 BOM 없이 다시 씀", () => {
  const cfg = fresh();
  writeFileSync(join(cfg, "settings.json"), "\uFEFF" + JSON.stringify({ theme: "dark" }));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(cfg, "settings.json"))[0], 0x7b);
  assert.equal(settingsOf(cfg).theme, "dark");
  const [bak] = backups(cfg, "settings.json");
  assert.ok(bak, "settings.json backup");
  assert.deepEqual([...readFileSync(join(cfg, bak)).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

// A settings.json the installer refuses: exit 1, the reason, and no file or folder changed.
function assertRefused(bad, want) {
  const cfg = fresh();
  writeFileSync(join(cfg, "settings.json"), bad);
  const r = install({ cfg });
  assert.equal(r.status, 1, `${bad}: ${r.out}`);
  assert.match(r.out, want);
  assert.ok(!existsSync(join(cfg, "hud")), `${bad}: no hud folder`);
  assert.ok(!existsSync(join(cfg, ".omc")), `${bad}: no .omc folder`);
  assert.equal(readFileSync(join(cfg, "settings.json"), "utf8"), bad);
  assert.deepEqual(backups(cfg, "settings.json"), []);
  return r;
}

test("settings.json 이 깨진 JSON, null, 배열이면 종료 1 이고 아무것도 바꾸지 않음", () => {
  assertRefused("{", /\[x\] settings\.json is not valid JSON \(line 1, column 2\); nothing changed\. Claude Code cannot read it either/);
  assertRefused("null", /\[x\] settings\.json holds null, not a JSON object; nothing changed\. Fix it and re-run\./);
  assertRefused("[]", /\[x\] settings\.json holds an array, not a JSON object; nothing changed/);
});

test("빈 settings.json 은 Claude Code 처럼 {} 로 읽고 statusLine 을 넣음", () => {
  for (const empty of ["", " \n", "\uFEFF"]) {
    const cfg = fresh();
    writeFileSync(join(cfg, "settings.json"), empty);
    const r = install({ cfg });
    assert.equal(r.status, 0, `${JSON.stringify(empty)}: ${r.out}`);
    assert.match(r.out, /\[\.\.\] settings\.json is empty; read as \{\} as Claude Code does/);
    assert.equal(settingsOf(cfg).statusLine.command, `node "${slash(cfg)}/hud/omc-hud-custom.mjs"`);
    const kept = backups(cfg, "settings.json");
    assert.equal(kept.length, 1, `${JSON.stringify(empty)}: one backup`);
    assert.equal(readFileSync(join(cfg, kept[0]), "utf8"), empty);
  }
});

test("주석이나 끝 쉼표가 든 settings.json 은 위치와 이유를 알리고 파일 내용은 내보내지 않음", () => {
  const why = "nothing changed\\. Claude Code cannot read it either: comments and trailing commas are not allowed\\. Fix it and re-run\\.";
  const cases = [
    ['{\n  // keep\n  "env": {}\n}', new RegExp(`\\[x\\] settings\\.json is not valid JSON \\(line 2, column 3\\); ${why}`)],
    ['{"theme":"x",}', /not valid JSON \(line 1, column 14\); nothing changed/],
    // Node's own message quotes the file around this error ('..."nv":{"K":tok-1234567"...') and has no position.
    ['{"env":{"K":tok-1234567}}', new RegExp(`\\[x\\] settings\\.json is not valid JSON; ${why}`)],
  ];
  for (const [bad, want] of cases) {
    const r = assertRefused(bad, want);
    assert.doesNotMatch(r.out, /keep|"theme"|tok-1234567|"K"/, "no part of the file reaches the output");
  }
});

test("OMC 가 없으면 종료 1 이고 폴더를 만들지 않음", () => {
  const cfg = fresh();
  const r = install({ cfg, versions: [] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[x\] OMC plugin not installed/);
  assert.doesNotMatch(r.out, /npm i -g/, "an npm install would not help: the installer reads only the plugin cache");
  assert.ok(!existsSync(join(cfg, "hud")), "no hud folder");
  assert.ok(!existsSync(join(cfg, ".omc")), "no .omc folder");
  assert.ok(!existsSync(join(cfg, "settings.json")), "no settings.json");
});

test("CLAUDE_CONFIG_DIR 의 ~ 를 홈으로, 상대경로를 절대경로로, 앞뒤 공백과 끝 슬래시를 뗌", () => {
  const home = fresh("home");
  const tilde = install({ cfg: join(home, ".cw"), value: "~/.cw", home });
  assert.equal(tilde.status, 0, tilde.out);
  assert.ok(existsSync(join(home, ".cw", "hud", "omc-hud-custom.mjs")));
  assert.equal(settingsOf(join(home, ".cw")).statusLine.command, `node "${slash(join(home, ".cw"))}/hud/omc-hud-custom.mjs"`);

  const cwd = realpathSync(fresh("cwd"));
  const rel = install({ cfg: join(cwd, "rel cfg"), value: " rel cfg/ ", cwd });
  assert.equal(rel.status, 0, rel.out);
  assert.ok(existsSync(join(cwd, "rel cfg", "hud", "omc-hud-custom.mjs")));
  assert.equal(settingsOf(join(cwd, "rel cfg")).statusLine.command, `node "${slash(join(cwd, "rel cfg"))}/hud/omc-hud-custom.mjs"`);
});

test("다시 설치할 때 바뀐 래퍼만 백업", () => {
  const cfg = fresh();
  assert.equal(install({ cfg }).status, 0);
  const wrapper = join(cfg, "hud", "omc-hud-custom.mjs");
  const edited = Buffer.concat([asset("omc-hud-custom.mjs"), Buffer.from("// edited by hand\n")]);
  writeFileSync(wrapper, edited);
  const again = install({ cfg, versions: [] });
  assert.equal(again.status, 0, again.out);
  const kept = backups(join(cfg, "hud"), "omc-hud-custom.mjs");
  assert.equal(kept.length, 1, again.out);
  assert.ok(readFileSync(join(cfg, "hud", kept[0])).equals(edited));
  assert.ok(readFileSync(wrapper).equals(asset("omc-hud-custom.mjs")));
  assert.deepEqual(backups(join(cfg, ".omc"), "hud-config.json"), []);
  assert.equal(install({ cfg, versions: [] }).status, 0);
  assert.equal(backups(join(cfg, "hud"), "omc-hud-custom.mjs").length, 1, "unchanged wrapper is not backed up");
});

test("payload-mon 블록만 다른 래퍼와 바뀌지 않은 settings.json 은 다시 설치해도 백업하지 않음", () => {
  const cfg = fresh();
  const first = install({ cfg });
  assert.equal(first.status, 0, first.out);
  turnOnTool(PAYLOAD_MON, cfg, first.home);
  turnOnTool(CLAUDE_UPDATE_LAST, cfg, first.home);
  const wrapper = join(cfg, "hud", "omc-hud-custom.mjs");
  const text = readFileSync(wrapper, "utf8");
  assert.ok(text.includes("// >>> payload-mon >>>") && text.includes("// >>> claude-update-last >>>"), "both blocks went in");
  const again = install({ cfg, home: first.home, versions: [] });
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(backups(join(cfg, "hud"), "omc-hud-custom.mjs"), []);
  assert.deepEqual(backups(cfg, "settings.json"), []);
  assert.match(again.out, /\[ok\] statusLine -> node ".*" \(settings\.json unchanged, no backup\)/);
  assert.ok(readFileSync(wrapper).equals(asset("omc-hud-custom.mjs")));
});

test("블록이 있어도 손으로 고친 래퍼는 백업함", () => {
  const cfg = fresh();
  const first = install({ cfg });
  assert.equal(first.status, 0, first.out);
  turnOnTool(PAYLOAD_MON, cfg, first.home);
  const wrapper = join(cfg, "hud", "omc-hud-custom.mjs");
  const edited = readFileSync(wrapper, "utf8") + "// edited by hand\n";
  writeFileSync(wrapper, edited);
  const again = install({ cfg, home: first.home, versions: [] });
  assert.equal(again.status, 0, again.out);
  const kept = backups(join(cfg, "hud"), "omc-hud-custom.mjs");
  assert.equal(kept.length, 1, again.out);
  assert.equal(readFileSync(join(cfg, "hud", kept[0]), "utf8"), edited);
});

test("버전 폴더는 숫자로 비교하고 정식판을 pre-release 보다 위로", () => {
  const loaderAfter = (versions, bare = []) => {
    const cfg = fresh();
    const r = install({ cfg, versions, bare });
    assert.equal(r.status, 0, r.out);
    return loaderOf(cfg);
  };
  assert.equal(loaderAfter(["4.15.10", "5.7.4", "5.7.4-beta", "5.7.5", "5.7.10"]), "// loader 5.7.10");
  assert.equal(loaderAfter(["5.7.4", "5.7.4-rc.10", "5.7.4-rc.2", "5.7.4-beta"]), "// loader 5.7.4");
  assert.equal(loaderAfter(["5.7.4-rc.2", "5.7.4-rc.10"]), "// loader 5.7.4-rc.10");
  assert.equal(loaderAfter(["5.7.4"], ["5.8.0"]), "// loader 5.7.4");
});

test("OMC_PLUGIN_ROOT 가 템플릿을 가지면 그것을 씀", () => {
  const cfg = fresh();
  const pluginRoot = fresh("plugin-root");
  fakeOmc(pluginRoot, "root");
  const r = install({ cfg, env: { OMC_PLUGIN_ROOT: pluginRoot } });
  assert.equal(r.status, 0, r.out);
  assert.equal(loaderOf(cfg), "// loader root");
});

test("v3 래퍼와 두 블록이 있던 설치를 다시 설치하면 옛 래퍼를 백업하고 첨부 래퍼로 바꿈", () => {
  const cfg = fresh();
  mkdirSync(join(cfg, "hud"), { recursive: true });
  const v3 = [
    "// OMC HUD custom formatter (wrapper).",
    "  // >>> payload-mon >>>",
    "  // <<< payload-mon <<<",
    "  // >>> claude-update-last >>>",
    "  // <<< claude-update-last <<<",
    "",
  ].join("\n");
  writeFileSync(join(cfg, "hud", "omc-hud-custom.mjs"), v3);
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  const [bak] = backups(join(cfg, "hud"), "omc-hud-custom.mjs");
  const kept = readFileSync(join(cfg, "hud", bak), "utf8");
  assert.ok(kept.includes("// >>> payload-mon >>>") && kept.includes("// >>> claude-update-last >>>"));
  assert.ok(readFileSync(join(cfg, "hud", "omc-hud-custom.mjs")).equals(asset("omc-hud-custom.mjs")));
});

test("설치 스크립트는 내장 모듈만 가져오고 네트워크 코드가 없음", () => {
  const src = readFileSync(APPLY, "utf8");
  // Each top-level import statement runs from `import` at a line start to its `;`.
  const specifiers = [...src.matchAll(/^import\b[^;]*;/gm)].map((m) => /["']([^"']+)["']\s*;$/.exec(m[0])?.[1]);
  assert.ok(specifiers.length > 0);
  // child_process runs the installed statusline once for the render check.
  const builtins = ["node:child_process", "node:fs", "node:os", "node:path", "node:url"];
  assert.deepEqual(specifiers.filter((s) => !builtins.includes(s)), []);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /https?:\/\//);
});

const offline = spawnSync("unshare", ["-rn", "true"]).status === 0;
test("네트워크가 없어도 설치가 끝남", { skip: !offline && "needs Linux unshare -rn (no network namespace here)" }, () => {
  const cfg = fresh();
  const r = install({ cfg, wrap: ["unshare", "-rn"] });
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(cfg, "hud", "omc-hud-custom.mjs")));
  assert.equal(settingsOf(cfg).statusLine.command, `node "${slash(cfg)}/hud/omc-hud-custom.mjs"`);
  assert.match(r.out, /Render check: /, "the render check runs offline too");
});

// The render check runs the installed statusline once with no input, as `node` from PATH; withNode puts
// this test's own node first.
const withNode = (extra = {}) => ({ PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`, ...extra });
const renderWith = (loader, env = withNode()) => {
  const cfg = fresh();
  const r = install({ cfg, env, omc: { "5.7.4": { pkg: true, loader } } });
  assert.equal(r.status, 0, r.out);
  return { cfg, out: r.out };
};

test("렌더 확인: 설치한 OMC 판이 그리면 [ok]", () => {
  assert.match(renderWith(banner("5.7.4")).out, /\[ok\] Render check: the statusline loads OMC 5\.7\.4\./);
});

test("렌더 확인: 새 판이 불러오기에 실패해 옛 판이 그리면 [!!] 와 이유", () => {
  const cfg = fresh();
  const omc = {
    "5.7.4": { pkg: true, loader: banner("5.7.4") },
    // 5.7.5's loader falls back to 5.7.4 when 5.7.5's own HUD does not import.
    "5.7.5": { pkg: true, loader: banner("5.7.4"), dist: "throw new Error(\"Cannot find package 'zod' imported from x\");\n" },
  };
  const r = install({ cfg, versions: ["5.7.4", "5.7.5"], env: withNode(), omc });
  assert.equal(r.status, 0, r.out);
  const want = /\[!!\] Render check: the statusline loads OMC 5\.7\.4, not the installed 5\.7\.5; 5\.7\.5 does not load \(Error: Cannot find package 'zod' imported from x\)\./;
  assert.match(r.out, want);
  assert.match(r.out, /run setup-omc-hud again after it/);
});

test("렌더 확인: OMC 가 불러오기에 실패하면 [!!] 와 OMC 의 줄", () => {
  const { out } = renderWith('console.log("[OMC HUD] HUD import failed from /x/dist/hud/index.js: Cannot find package \'zod\'");\n');
  assert.match(out, /\[!!\] Render check: OMC's HUD does not load: \[OMC HUD\] HUD import failed/);
  assert.match(out, /run setup-omc-hud again after it/);
});

test("렌더 확인의 자식은 설정 폴더에서 돌아, 설치를 돌린 폴더의 파일이 끼어들지 않음", () => {
  // Both children note where they run: the formatter (through the loader it imports) and the HUD of
  // the version that fails. OMC's loader looks in the working folder's node_modules, and its git runs
  // from there; on Windows a bare name is also looked up in the working folder first.
  const cfg = fresh();
  const cwd = fresh("cwd");
  const loader = 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./cwd-seen.txt", import.meta.url), process.cwd());\n' + banner("5.7.4");
  const dist = 'require("fs").writeFileSync(require("path").join(__dirname, "cwd-seen.txt"), process.cwd());\nthrow new Error("broken");\n';
  const omc = { "5.7.4": { pkg: true, loader: banner("5.7.4") }, "5.7.5": { pkg: true, loader, dist } };
  const r = install({ cfg, cwd, versions: ["5.7.4", "5.7.5"], env: withNode(), omc });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[!!\] Render check: the statusline loads OMC 5\.7\.4, not the installed 5\.7\.5/);
  const real = realpathSync(cfg);
  assert.equal(realpathSync(readFileSync(join(cfg, "hud", "cwd-seen.txt"), "utf8")), real, "the formatter runs in the config folder");
  const distSeen = join(omcCache(cfg), "5.7.5", "dist", "hud", "cwd-seen.txt");
  assert.equal(realpathSync(readFileSync(distSeen, "utf8")), real, "so does the failing version's HUD");
});

test("렌더 확인의 기본 시간 제한은 래퍼가 스스로 끝내는 시간보다 김", () => {
  // Killing a formatter that is still working would leave its fallback child running: the formatter
  // gives up on its own after stdin, the in-process render and that child, or at its hard exit.
  const wrapper = readFileSync(join(ASSETS, "omc-hud-custom.mjs"), "utf8");
  const ms = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(wrapper)[1]);
  const own = Math.max(ms("STDIN_TIMEOUT_MS") + ms("RENDER_TIMEOUT_MS") + ms("SPAWN_TIMEOUT_MS"), ms("HARD_EXIT_MS"));
  const limit = Number(/APPLY_HUD_CHECK_TIMEOUT_MS\) \|\| (\d+);/.exec(readFileSync(APPLY, "utf8"))[1]);
  assert.ok(limit > own, `the render check's ${limit}ms must outwait the formatter's own ${own}ms`);
});

test("렌더 확인: 설정 폴더 경로가 길어도 OMC 줄의 끝에 있는 이유까지 보임", () => {
  const long = `/home/${"deep/".repeat(40)}dist/hud/index.js`;
  const { out } = renderWith(`console.log("[OMC HUD] HUD import failed from ${long}: Cannot find package 'zod'");\n`);
  assert.match(out, /OMC's HUD does not load: \[OMC HUD\] HUD import failed from .*: Cannot find package 'zod'/);
});

test("렌더 확인: PATH 에 node 가 없으면 [!!]", () => {
  const { cfg, out } = renderWith(banner("5.7.4"), { PATH: fresh("empty-path") });
  assert.match(out, /\[!!\] Render check: no "node" on PATH; the statusLine command runs "node", so the statusline will not show\./);
  assert.equal(settingsOf(cfg).statusLine.command, `node "${slash(cfg)}/hud/omc-hud-custom.mjs"`);
});

test("렌더 확인은 PATH 의 상대 경로 폴더에 있는 node 를 실행하지 않음", posixOnly, () => {
  const cfg = fresh();
  const cwd = fresh("cwd");
  const marker = join(cwd, "ran");
  writeFileSync(join(cwd, "node"), `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(join(cwd, "node"), 0o755);
  const env = { PATH: `.${delimiter}${dirname(process.execPath)}` };
  const r = install({ cfg, cwd, env, omc: { "5.7.4": { pkg: true, loader: banner("5.7.4") } } });
  assert.equal(r.status, 0, r.out);
  assert.ok(!existsSync(marker), "the node in the working folder did not run");
  assert.match(r.out, /\[ok\] Render check/);
});

test("렌더 확인: 시간 안에 답이 없으면 [!!]", () => {
  const { out } = renderWith("setInterval(() => {}, 1000);\n", withNode({ APPLY_HUD_CHECK_TIMEOUT_MS: "1000" }));
  assert.match(out, /\[!!\] Render check: the statusline gave no answer in 1s\./);
});

test("렌더 확인: 상태표시줄 명령이 실패하면 종료 코드를 알림", () => {
  assert.match(renderWith("process.exit(3);\n").out, /\[!!\] Render check: the statusline command failed \(exit 3\)/);
});

test("렌더 확인: 모르는 출력은 [..] 로 첫 줄을 보임", () => {
  assert.match(renderWith('console.log("hello");\n').out, /\[\.\.\] Render check: unrecognized output: hello/);
});

test("settings.json 백업은 원본과 같은 바이트와 권한", () => {
  const cfg = fresh();
  // Not UTF-8 inside a JSON string (a CP949 editor, say): parsing still works, the backup must keep the bytes.
  const original = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xb0, 0xa1]), Buffer.from('"}')]);
  writeFileSync(join(cfg, "settings.json"), original);
  if (POSIX) chmodSync(join(cfg, "settings.json"), 0o600);
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  const [bak] = backups(cfg, "settings.json");
  assert.ok(readFileSync(join(cfg, bak)).equals(original), "backup bytes");
  if (POSIX) assert.equal(modeOf(join(cfg, bak)), 0o600, "backup as private as the original");
});

test("새 폴더와 파일은 umask 002 에서도 그룹이 쓸 수 없음", posixOnly, () => {
  const cfg = fresh();
  const r = install({ cfg, omcMode: 0o664, wrap: ["sh", "-c", 'umask 002; exec "$0" "$@"'] });
  assert.equal(r.status, 0, r.out);
  for (const d of ["hud", join("hud", "lib"), ".omc"]) assert.equal(modeOf(join(cfg, d)), 0o755, d);
  const files = [join("hud", "omc-hud-custom.mjs"), join("hud", "omc-hud.mjs"), join("hud", "lib", "config-dir.mjs"), join(".omc", "hud-config.json")];
  for (const f of files) assert.equal(modeOf(join(cfg, f)), 0o644, f);
});

// Characters a shell still acts on inside the double quotes of the statusLine command. Windows names
// cannot hold a double quote or a line break, and its backslash is the separator.
const SHELL_CHARS = POSIX ? ['"', "$", "`", "%", "\\", "\n"] : ["$", "`", "%"];
test("설정 폴더 경로에 셸이 해석하는 글자가 있으면 종료 1 이고 아무것도 바꾸지 않음", () => {
  for (const ch of SHELL_CHARS) {
    const cfg = join(fresh(), `a${ch}b`);
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), '{"theme":"x"}');
    const r = install({ cfg });
    assert.equal(r.status, 1, `${JSON.stringify(ch)}: ${r.out}`);
    assert.match(r.out, /\[x\] The config folder path has a character/);
    assert.ok(!existsSync(join(cfg, "hud")), `${JSON.stringify(ch)}: no hud folder`);
    assert.equal(readFileSync(join(cfg, "settings.json"), "utf8"), '{"theme":"x"}');
    assert.deepEqual(backups(cfg, "settings.json"), []);
  }
});

test("작은따옴표, 괄호, & 가 든 경로는 설치함", () => {
  const cfg = join(fresh(), "it's (a&b)");
  mkdirSync(cfg, { recursive: true });
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.equal(settingsOf(cfg).statusLine.command, `node "${slash(cfg)}/hud/omc-hud-custom.mjs"`);
});

test("settings.json 을 쓸 수 없으면 종료 1 이고 아무것도 바꾸지 않음", { skip: (!POSIX && "mode bits") || (asRoot && "root writes read-only files") }, () => {
  const cfg = fresh();
  writeFileSync(join(cfg, "settings.json"), '{"theme":"x"}');
  chmodSync(join(cfg, "settings.json"), 0o444);
  try {
    const r = install({ cfg });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[x\] Cannot write .*settings\.json/);
    assert.equal(r.err, "", "no stack trace");
    assert.ok(!existsSync(join(cfg, "hud")), "no hud folder");
    assert.deepEqual(backups(cfg, "settings.json"), []);
  } finally {
    chmodSync(join(cfg, "settings.json"), 0o644);
  }
});

test("config-dir.mjs 가 없는 OMC 루트와 판 폴더는 쓰지 않음", () => {
  const cfg = fresh();
  const pluginRoot = fresh("plugin-root");
  fakeOmc(pluginRoot, "root", { configDir: false });
  const r = install({ cfg, half: ["5.8.0"], env: { OMC_PLUGIN_ROOT: pluginRoot } });
  assert.equal(r.status, 0, r.out);
  assert.equal(loaderOf(cfg), "// loader 5.7.4");
  assert.ok(existsSync(join(cfg, "hud", "lib", "config-dir.mjs")));
});

test("예기치 못한 오류로 중간에 멈추면 종료 2 와 [x] 줄, 스택 없음", () => {
  const cfg = fresh();
  mkdirSync(join(cfg, ".omc", "hud-config.json"), { recursive: true }); // a folder where the HUD config goes
  const r = install({ cfg });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /\[x\] Stopped partway/);
  assert.equal(r.err, "", "no stack trace");
});

test("기존 statusLine 의 다른 필드는 두고, 다른 명령이었으면 알림", () => {
  const cfg = fresh();
  const prior = { type: "command", command: "node /x/wrap.mjs", padding: 2, refreshInterval: 30 };
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ statusLine: prior }));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  const s = settingsOf(cfg).statusLine;
  assert.equal(s.padding, 2);
  assert.equal(s.refreshInterval, 30);
  assert.equal(s.command, `node "${slash(cfg)}/hud/omc-hud-custom.mjs"`);
  assert.match(r.out, /\[\.\.\] statusLine ran "node \/x\/wrap\.mjs"/);
});

test("상대경로 OMC_PLUGIN_ROOT 는 쓰지 않음", () => {
  const cfg = fresh();
  const cwd = fresh("cwd");
  fakeOmc(join(cwd, "plugin-root"), "relative");
  const r = install({ cfg, cwd, env: { OMC_PLUGIN_ROOT: "plugin-root" } });
  assert.equal(r.status, 0, r.out);
  assert.equal(loaderOf(cfg), "// loader 5.7.4");
});

test("첨부 HUD 설정은 상세 줄을 8줄까지 둠", () => {
  // OMC folds its output past maxOutputLines into "... (+N lines)"; 3 hid the agent lines (2026-10-19 decision).
  assert.equal(JSON.parse(asset("hud-config.json")).elements.maxOutputLines, 8);
});

test("다시 설치하면 그룹이 쓸 수 있던 래퍼와 로더도 0644 로", posixOnly, () => {
  const cfg = fresh();
  mkdirSync(join(cfg, "hud", "lib"), { recursive: true });
  const owned = ["omc-hud-custom.mjs", "omc-hud.mjs", join("lib", "config-dir.mjs")];
  for (const f of owned) {
    writeFileSync(join(cfg, "hud", f), "// old\n");
    chmodSync(join(cfg, "hud", f), 0o664);
  }
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  for (const f of owned) assert.equal(modeOf(join(cfg, "hud", f)), 0o644, f);
});
