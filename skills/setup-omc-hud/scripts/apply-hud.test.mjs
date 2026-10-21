// Tests for ../assets/apply-hud.mjs. Run from the repo root: node --test skills/setup-omc-hud/scripts/*.test.mjs
// Every run gets its own HOME, USERPROFILE and CLAUDE_CONFIG_DIR under a temp folder, with a fake OMC
// version folder that holds only the two files the installer copies.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

// An inode number read as BigInt: NTFS file IDs pass 2^53 (seen on the Windows test box), and a Number loses the low bits.
const inoOf = (p) => statSync(p, { bigint: true }).ino;

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const APPLY = join(ASSETS, "apply-hud.mjs");
const root = mkdtempSync(join(tmpdir(), "apply-hud-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
// Mode bits are POSIX matters, and root writes files it may not.
const POSIX = process.platform !== "win32";
const posixModes = { skip: !POSIX && "Windows has no POSIX mode bits" };
const posixSignals = { skip: !POSIX && "Windows has no POSIX signals" };
// A file link needs a privilege on Windows, so the tests that make one run only where this account can.
const canLinkFiles = (() => {
  const probe = mkdtempSync(join(tmpdir(), "link-probe-"));
  try {
    writeFileSync(join(probe, "a"), "");
    symlinkSync(join(probe, "a"), join(probe, "b"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const fileLinks = { skip: !canLinkFiles && "this account cannot make file links" };
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
    [Boolean(o.pkg), join(dir, "package.json"), JSON.stringify(o.pkg === true ? { version } : o.pkg) + "\n"],
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
const INSTALL_DEFAULTS = { cwd: root, versions: ["5.7.4"], bare: [], half: [], env: {}, wrap: [], nodeArgs: [], omcMode: undefined, omc: {}, apply: APPLY };
// Runs the installer. `cfg` is where the config folder really is; `value` is what CLAUDE_CONFIG_DIR
// says (default `cfg`, null to leave it unset). `bare` versions lack the template, `half` ones config-dir.mjs.
// `omc` holds more fakeOmc options per version; an `env.PATH` replaces the PATH under any spelling. `apply` is
// the installer to run (a copy beside other attached files, say), `nodeArgs` go to node before it (a preload, say).
function install(opts) {
  const o = { ...INSTALL_DEFAULTS, home: fresh("home"), value: opts.cfg, ...opts };
  for (const v of o.versions) fakeOmc(join(omcCache(o.cfg), v), v, { mode: o.omcMode, ...o.omc[v] });
  for (const v of o.bare) fakeOmc(join(omcCache(o.cfg), v), v, { template: false });
  for (const v of o.half) fakeOmc(join(omcCache(o.cfg), v), v, { configDir: false });
  const base = cleanEnv();
  if (o.env.PATH !== undefined) for (const k of Object.keys(base)) if (/^path$/i.test(k)) delete base[k];
  const childEnv = { ...base, HOME: o.home, USERPROFILE: o.home, ...o.env };
  if (o.value !== null) childEnv.CLAUDE_CONFIG_DIR = o.value;
  const [cmd, ...args] = [...o.wrap, process.execPath, ...o.nodeArgs, o.apply];
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: childEnv, encoding: "utf8", timeout: o.timeout });
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

test("짝 없는 payload-mon 여는 줄이 많은 큰 래퍼도 다시 설치가 빨리 끝남", () => {
  const cfg = fresh();
  const first = install({ cfg });
  assert.equal(first.status, 0, first.out);
  const wrapper = join(cfg, "hud", "omc-hud-custom.mjs");
  writeFileSync(wrapper, readFileSync(wrapper, "utf8") + "// >>> payload-mon >>>\n".repeat(90000));
  const started = Date.now();
  const again = install({ cfg, home: first.home, versions: [] });
  const took = Date.now() - started;
  assert.equal(again.status, 0, again.out);
  assert.ok(took < 5000, `took ${took}ms`);
  assert.equal(backups(join(cfg, "hud"), "omc-hud-custom.mjs").length, 1);
});

// Installs, turns `script` on and edits its block by hand: the first `from` past its opening marker.
function editedBlock(script, open, from, to) {
  const cfg = fresh();
  const first = install({ cfg });
  assert.equal(first.status, 0, first.out);
  turnOnTool(script, cfg, first.home);
  const wrapper = join(cfg, "hud", "omc-hud-custom.mjs");
  const text = readFileSync(wrapper, "utf8");
  const at = text.indexOf(open);
  assert.ok(at >= 0 && text.indexOf(from, at) > at, "the block holds the word");
  const edited = text.slice(0, at) + text.slice(at).replace(from, to);
  writeFileSync(wrapper, edited);
  return { cfg, home: first.home, edited };
}
for (const [name, script, open, from, to] of [
  ["payload-mon", PAYLOAD_MON, "// >>> payload-mon >>>", "shown", "SHOWN"],
  ["claude-update-last", CLAUDE_UPDATE_LAST, "// >>> claude-update-last >>>", "goes after", "GOES AFTER"],
  ["payload-mon 모듈 주소", PAYLOAD_MON, "// >>> payload-mon >>>", "payload-size.mjs", "payload-sizf.mjs"],
]) {
  test(`블록 안쪽을 손으로 고친 래퍼는 다시 설치할 때 백업함(${name})`, () => {
    const { cfg, home, edited } = editedBlock(script, open, from, to);
    const again = install({ cfg, home, versions: [] });
    assert.equal(again.status, 0, again.out);
    const kept = backups(join(cfg, "hud"), "omc-hud-custom.mjs");
    assert.equal(kept.length, 1, again.out);
    assert.equal(readFileSync(join(cfg, "hud", kept[0]), "utf8"), edited);
  });
}

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

test("렌더 확인은 PATH 의 상대 경로 폴더에 있는 node 를 실행하지 않음", posixModes, () => {
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

test("래퍼 파일만 링크한 설정 폴더에 설치하면 렌더 확인이 [ok]", fileLinks, () => {
  const cfg = fresh();
  const dot = fresh("dot");
  writeFileSync(join(dot, "omc-hud-custom.mjs"), "// old wrapper\n");
  mkdirSync(join(cfg, "hud"), { recursive: true });
  symlinkSync(join(dot, "omc-hud-custom.mjs"), join(cfg, "hud", "omc-hud-custom.mjs"));
  const r = install({ cfg, env: withNode() });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[ok\] Render check: the statusline loads OMC 5\.7\.4\./);
  assert.ok(readFileSync(join(dot, "omc-hud-custom.mjs")).equals(asset("omc-hud-custom.mjs")));
  assert.ok(lstatSync(join(cfg, "hud", "omc-hud.mjs")).isFile());
});

test("렌더 확인: 상태표시줄이 Node 오류를 내면 [!!] 와 Error 줄", () => {
  assert.match(
    renderWith('import "./no-such-module.mjs";\n').out,
    /\[!!\] Render check: the statusline prints an error instead of a line: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/,
  );
});

test("렌더 확인: OMC 가 입력 없이 아무것도 내지 않으면 [..] 로 알리고 OMC 탓으로 단정하지 않음", () => {
  const { out } = renderWith('console.log("[OMC HUD] no output");\n');
  assert.match(out, /\[\.\.\] Render check: OMC printed nothing with no input, so this check cannot tell whether the statusline draws\./);
  assert.doesNotMatch(out, /OMC's install is at fault/);
});

test("렌더 확인: 판이 다르고 설치한 판이 오류 없이 돌면 [..] 로 판만 알림", () => {
  const omc = {
    "5.7.4": { pkg: true, loader: banner("5.7.4") },
    "5.7.5": { pkg: true, loader: banner("5.7.4"), dist: 'console.log("ok");\n' },
  };
  const r = install({ cfg: fresh(), versions: ["5.7.4", "5.7.5"], env: withNode(), omc });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[\.\.\] Render check: the statusline loads OMC 5\.7\.4, not the installed 5\.7\.5\./);
  assert.doesNotMatch(r.out, /does not load|OMC's install is at fault/);
});

test("렌더 확인은 PATH 앞쪽의 실행할 수 없는 node 를 건너뜀", posixModes, () => {
  const dir = fresh("noexec");
  writeFileSync(join(dir, "node"), "#!/bin/sh\n");
  chmodSync(join(dir, "node"), 0o644);
  const { out } = renderWith(banner("5.7.4"), { PATH: `${dir}${delimiter}${dirname(process.execPath)}` });
  assert.match(out, /\[ok\] Render check/);
  assert.doesNotMatch(out, /skipped/);
});

test("렌더 확인: node.cmd 만 있으면 [..] 로 Git Bash 가 못 돌린다고 알림", { skip: POSIX && "Windows only" }, () => {
  const dir = fresh("cmd");
  writeFileSync(join(dir, "node.cmd"), `@"${process.execPath}" %*\r\n`);
  const sys = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const { out } = renderWith(banner("5.7.4"), { PATH: `${dir}${delimiter}${sys}` });
  assert.match(out, /\[\.\.\] Render check: skipped; PATH has node\.cmd but no node\.exe/);
});

test("렌더 확인 출력의 제어 글자는 ? 로 바뀜", () => {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const { out } = renderWith(`console.log(${JSON.stringify(`[OMC HUD] HUD import failed: ${esc}]0;t${bel}x`)});\n`);
  assert.match(out, /Render check: OMC's HUD does not load: \[OMC HUD\] HUD import failed: \?\]0;t\?x/);
  assert.ok(!out.includes(esc) && !out.includes(bel));
});

test("렌더 확인은 OMC 판 문자열의 제어 글자와 줄바꿈도 ? 로 바꿈", () => {
  const esc = String.fromCharCode(27);
  const drawn = `[OMC] HUD v5.7.4${esc}]0;t | preset: full`;
  const omc = { "5.7.5": { pkg: { version: `5.7.5${esc}]0;x\n[ok] Render check: fake` }, loader: `console.log(${JSON.stringify(drawn)});\n` } };
  const r = install({ cfg: fresh(), versions: ["5.7.5"], env: withNode(), omc });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.includes(esc), r.out);
  assert.doesNotMatch(r.out, /^\[ok\] Render check: fake/m);
  assert.match(r.out, /the statusline loads OMC 5\.7\.4\?\]0;t, not the installed 5\.7\.5\?\]0;x\?\[ok\] Render check: fake/);
});

test("렌더 확인 정화는 한글 경로를 그대로 둠", () => {
  const cfg = join(fresh(), "claude cfg 한글");
  mkdirSync(cfg, { recursive: true });
  const line = `[OMC HUD] HUD import failed from ${slash(cfg)}/x: Cannot find package 'zod'`;
  const r = install({ cfg, env: withNode(), omc: { "5.7.4": { pkg: true, loader: `console.log(${JSON.stringify(line)});\n` } } });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(`OMC's HUD does not load: ${line}`), r.out);
});

test("렌더 확인: 상태표시줄 명령이 실패하면 stderr 의 Error 줄을 보임", () => {
  const loader = 'process.stderr.write("node:internal/x:1\\n\\nError: boom\\n");\nprocess.exit(3);\n';
  assert.match(renderWith(loader).out, /failed \(exit 3\): Error: boom/);
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

test("새 폴더와 파일은 umask 002 에서도 그룹이 쓸 수 없음", posixModes, () => {
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

test("settings.json 을 쓸 수 없으면 종료 1 이고 아무것도 바꾸지 않음", { skip: (!POSIX && "Windows has no POSIX mode bits") || (asRoot && "root writes read-only files") }, () => {
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

// A write that fails for a reason the install cannot see coming (an I/O error), after the loader and the wrapper
// went in. A folder where a file goes was this test's way in before 0.20.5; that is now refused before anything.
function failingWritePreload(suffix) {
  const file = join(root, `fail-write-${++seq}.mjs`);
  writeFileSync(file, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const write = fs.writeFileSync;",
    "fs.writeFileSync = function (p, ...rest) {",
    `  if (typeof p === "string" && p.endsWith(${JSON.stringify(suffix)})) throw Object.assign(new Error("i/o error"), { code: "EIO" });`,
    "  return write.call(this, p, ...rest);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  return ["--import", pathToFileURL(file).href];
}

test("예기치 못한 오류로 중간에 멈추면 종료 2 와 [x] 줄, 스택 없음", () => {
  const cfg = fresh();
  const r = install({ cfg, nodeArgs: failingWritePreload("hud-config.json") });
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
  assert.match(r.out, /\[\.\.\] statusLine ran "node …" \(16 characters\)/);
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

test("다시 설치하면 그룹이 쓸 수 있던 래퍼와 로더도 0644 로", posixModes, () => {
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

test("CRLF 첨부 래퍼로 설치하고 두 블록을 켠 뒤 다시 설치해도 래퍼 백업이 없음", () => {
  // A Windows checkout with core.autocrlf=true (the repository has no .gitattributes) gives the attached files CRLF.
  const assets = fresh("assets-crlf");
  for (const name of readdirSync(ASSETS)) writeFileSync(join(assets, name), readFileSync(join(ASSETS, name)));
  writeFileSync(join(assets, "omc-hud-custom.mjs"), readFileSync(join(ASSETS, "omc-hud-custom.mjs"), "utf8").replace(/\r?\n/g, "\r\n"));
  const apply = join(assets, "apply-hud.mjs");
  const cfg = fresh();
  const first = install({ cfg, apply });
  assert.equal(first.status, 0, first.out);
  turnOnTool(PAYLOAD_MON, cfg, first.home);
  turnOnTool(CLAUDE_UPDATE_LAST, cfg, first.home);
  const wrapper = join(cfg, "hud", "omc-hud-custom.mjs");
  assert.doesNotMatch(readFileSync(wrapper, "latin1"), /[^\r]\n/, "every line ends in CRLF");
  const again = install({ cfg, home: first.home, versions: [], apply });
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(backups(join(cfg, "hud"), "omc-hud-custom.mjs"), []);
});

test("설치 스크립트의 블록 정규식은 두 도구의 것과 글자까지 같음", async () => {
  const pm = await import("../../payload-mon/scripts/payload-mon.mjs");
  const cul = await import("./claude-update-last.mjs");
  const src = readFileSync(APPLY, "utf8");
  const listed = /^const TOOL_BLOCKS = \[\n([\s\S]*?)\n\];$/m.exec(src)[1].split("\n").map((l) => l.trim().replace(/,$/, ""));
  assert.deepEqual(listed, [String(pm.BLOCKS), String(cul.BLOCKS)]);
  assert.equal(/^const PM_CLOSE = (.*);$/m.exec(src)[1], String(pm.CLOSE_LINE));
});

test("BOM 이 붙은 settings.json 의 JSON 오류도 줄과 칸이 맞음", () => {
  const cfg = fresh();
  writeFileSync(join(cfg, "settings.json"), String.fromCharCode(0xfeff) + '{\n  "a": 1,\n}\n');
  const r = install({ cfg });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /settings\.json is not valid JSON \(line 3, column 1\)/);
});

test("렌더 확인: 신호로 끝난 상태표시줄 명령은 신호 이름을 알림", posixSignals, () => {
  assert.match(renderWith('process.kill(process.pid, "SIGTERM");\n').out, /failed \(exit SIGTERM\)/);
});

test("렌더 확인: 새 판에 dist 가 없으면 이유가 no dist/hud/index.js", () => {
  const omc = { "5.7.4": { pkg: true, loader: banner("5.7.4") }, "5.7.5": { pkg: true, loader: banner("5.7.4") } };
  const r = install({ cfg: fresh(), versions: ["5.7.4", "5.7.5"], env: withNode(), omc });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /5\.7\.5 does not load \(no dist\/hud\/index\.js\)\./);
});

test("렌더 확인: 출력이 너무 크면 [..] skipped 와 이유", () => {
  const loader = 'process.stdout.write("x".repeat(3 * 1024 * 1024) + "\\n");\n';
  assert.match(renderWith(loader).out, /\[\.\.\] Render check: skipped \(ENOBUFS\)/);
});

test("렌더 확인은 PATH 의 따옴표 친 폴더에서도 node 를 찾고 node 라는 폴더는 건너뜀", () => {
  const dir = fresh("node-dir");
  mkdirSync(join(dir, process.platform === "win32" ? "node.exe" : "node"));
  const { out } = renderWith(banner("5.7.4"), { PATH: `${dir}${delimiter}"${dirname(process.execPath)}"` });
  assert.match(out, /\[ok\] Render check/);
});

test("이전 statusLine 명령의 보이지 않는 글자는 ? 로 보임", () => {
  const cfg = fresh();
  const rlo = String.fromCharCode(0x202e);
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: `old${rlo}.mjs --x` } }));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[\.\.\] statusLine ran "old\?\.mjs …"/);
  assert.ok(!r.out.includes(rlo), "the control character is not printed");
});

test("settings.json 은 새 파일로 바꿔 넣고 권한을 지킴", posixModes, () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  chmodSync(file, 0o600);
  const ino = inoOf(file);
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.notEqual(inoOf(file), ino, "replaced through a rename");
  assert.equal(modeOf(file), 0o600);
  assert.deepEqual(readdirSync(cfg).filter((n) => n.endsWith(".tmp")), []);
});

// A settings.json kept in a dotfiles folder and linked into the config folder.
function linkedSettings() {
  const cfg = fresh();
  const dot = fresh("dot");
  const target = join(dot, "settings.json");
  writeFileSync(target, JSON.stringify({ theme: "dark" }));
  symlinkSync(target, join(cfg, "settings.json"));
  return { cfg, dot, target };
}

test("링크인 settings.json 은 링크를 두고 가리키는 파일을 바꿈", fileLinks, () => {
  const { cfg, target } = linkedSettings();
  const ino = inoOf(target);
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.ok(lstatSync(join(cfg, "settings.json")).isSymbolicLink(), "the link stays");
  const s = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(s.theme, "dark");
  assert.match(s.statusLine.command, /omc-hud-custom\.mjs/);
  assert.notEqual(inoOf(target), ino, "the file it points at was replaced");
});

// The installer's temporary file is named after its pid; a preload pins the pid so a test can put
// something at that name first.
const PID = 4242424;
function pinnedPid() {
  const file = join(root, `pid-${++seq}.mjs`);
  writeFileSync(file, `Object.defineProperty(process, "pid", { value: ${PID} });\n`);
  return ["--import", pathToFileURL(file).href];
}

test("같은 pid 의 임시 파일이 남아 있어도 settings.json 을 바꿔 넣고 그 파일을 치움", () => {
  const cfg = fresh();
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(cfg, `settings.json.${PID}.tmp`), "left by an earlier run that was killed\n");
  const ino = inoOf(join(cfg, "settings.json"));
  const r = install({ cfg, nodeArgs: pinnedPid() });
  assert.equal(r.status, 0, r.out);
  assert.match(settingsOf(cfg).statusLine.command, /omc-hud-custom\.mjs/);
  assert.notEqual(inoOf(join(cfg, "settings.json")), ino, "went in through the rename, not in place");
  assert.deepEqual(readdirSync(cfg).filter((n) => n.endsWith(".tmp")), []);
});

test("임시 파일 자리에 끊어진 링크가 있어도 그 너머에 쓰지 않음", fileLinks, () => {
  const cfg = fresh();
  const outside = fresh("outside");
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "dark" }));
  symlinkSync(join(outside, "planted.json"), join(cfg, `settings.json.${PID}.tmp`));
  const r = install({ cfg, nodeArgs: pinnedPid() });
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(join(outside, "planted.json")), false, "nothing was written where the link led");
  assert.ok(!lstatSync(join(cfg, "settings.json")).isSymbolicLink());
  assert.match(settingsOf(cfg).statusLine.command, /omc-hud-custom\.mjs/);
});

// A preload that makes one fs call fail with `code` for the installer's temporary file, on every OS.
function failingPreload(fn, code) {
  const file = join(root, `fail-${++seq}.mjs`);
  writeFileSync(file, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    `const real = fs.${fn};`,
    `fs.${fn} = function (p, ...rest) {`,
    `  if (String(p).endsWith(".tmp")) throw Object.assign(new Error("${code} (test)"), { code: "${code}" });`,
    "  return real.call(this, p, ...rest);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  return ["--import", pathToFileURL(file).href];
}

test("settings.json 을 rename 하지 못하면 오류가 무엇이든 제자리에 쓰고 임시 파일을 남기지 않음", () => {
  for (const code of ["EPERM", "EIO", "ENOTSUP"]) {
    const cfg = fresh();
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ theme: "dark" }));
    const r = install({ cfg, nodeArgs: failingPreload("renameSync", code) });
    assert.equal(r.status, 0, `${code}: ${r.out}`);
    assert.match(settingsOf(cfg).statusLine.command, /omc-hud-custom\.mjs/, code);
    assert.deepEqual(readdirSync(cfg).filter((name) => name.endsWith(".tmp")), [], code);
  }
});

test("디스크가 가득 차 임시 파일을 못 쓰면 settings.json 을 그대로 두고 멈춤", () => {
  for (const code of ["ENOSPC", "EDQUOT"]) {
    const cfg = fresh();
    const file = join(cfg, "settings.json");
    writeFileSync(file, JSON.stringify({ theme: "dark" }));
    const before = readFileSync(file);
    const r = install({ cfg, nodeArgs: failingPreload("writeFileSync", code) });
    assert.notEqual(r.status, 0, `${code}: ${r.out}`);
    assert.match(r.out, new RegExp(code));
    assert.ok(readFileSync(file).equals(before), `${code}: settings.json is as it was`);
    assert.deepEqual(readdirSync(cfg).filter((name) => name.endsWith(".tmp")), [], code);
  }
});

test("settings.json 을 새 파일로 못 바꾸면 제자리에 씀", { skip: (!POSIX && "Windows has no POSIX mode bits") || (asRoot && "root writes read-only folders") || (!canLinkFiles && "this account cannot make file links") }, () => {
  const { cfg, dot, target } = linkedSettings();
  chmodSync(dot, 0o555);
  try {
    const r = install({ cfg });
    assert.equal(r.status, 0, r.out);
    assert.match(JSON.parse(readFileSync(target, "utf8")).statusLine.command, /omc-hud-custom\.mjs/);
    assert.ok(lstatSync(join(cfg, "settings.json")).isSymbolicLink());
  } finally {
    chmodSync(dot, 0o755);
  }
});

// B1-1: the new branches of writeSettings that no test pinned.
test("settings.json 은 umask 가 지우는 권한 비트도 그대로 두고 새 파일로 바꿔 넣음", posixModes, () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  chmodSync(file, 0o664);
  const ino = inoOf(file);
  const r = install({ cfg, wrap: ["sh", "-c", 'umask 022; exec "$0" "$@"'] });
  assert.equal(r.status, 0, r.out);
  assert.notEqual(inoOf(file), ino, "replaced through a rename");
  assert.equal(modeOf(file), 0o664);
});

test("끊어진 링크인 settings.json 은 링크를 두고 가리키는 자리에 씀", fileLinks, () => {
  const cfg = fresh();
  const target = join(fresh("dot"), "settings.json");
  symlinkSync(target, join(cfg, "settings.json"));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.ok(lstatSync(join(cfg, "settings.json")).isSymbolicLink(), "the link stays");
  assert.match(JSON.parse(readFileSync(target, "utf8")).statusLine.command, /omc-hud-custom\.mjs/);
});

// A preload under which a rename between two folders fails as one between two file systems does (EXDEV).
function renameInOneFolderOnly() {
  const file = join(root, `exdev-${++seq}.mjs`);
  writeFileSync(file, [
    'import fs from "node:fs";',
    'import { dirname } from "node:path";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const real = fs.renameSync;",
    "fs.renameSync = function (a, b, ...rest) {",
    '  if (dirname(String(a)) !== dirname(String(b))) throw Object.assign(new Error("EXDEV (test)"), { code: "EXDEV" });',
    "  return real.call(this, a, b, ...rest);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  return ["--import", pathToFileURL(file).href];
}

test("링크인 settings.json 의 임시 파일은 가리키는 파일 옆이라 링크가 다른 파일 시스템에 있어도 바꿔 넣음", fileLinks, () => {
  const { cfg, target } = linkedSettings();
  const ino = inoOf(target);
  const r = install({ cfg, nodeArgs: renameInOneFolderOnly() });
  assert.equal(r.status, 0, r.out);
  assert.ok(lstatSync(join(cfg, "settings.json")).isSymbolicLink(), "the link stays");
  assert.match(JSON.parse(readFileSync(target, "utf8")).statusLine.command, /omc-hud-custom\.mjs/);
  assert.notEqual(inoOf(target), ino, "renamed within the target's folder, not written in place");
});

// B1-2: a rename must not part a hard link or hand settings.json to another owner or group.
test("하드 링크인 settings.json 은 제자리에 써 다른 이름도 같은 내용", () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  const other = join(fresh("dot"), "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  linkSync(file, other);
  const ino = inoOf(file);
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.equal(inoOf(file), ino, "written in place");
  assert.equal(statSync(other).nlink, 2, "still one file with two names");
  assert.match(JSON.parse(readFileSync(other, "utf8")).statusLine.command, /omc-hud-custom\.mjs/);
  assert.deepEqual(readdirSync(cfg).filter((n) => n.endsWith(".tmp")), []);
});

test("하드 링크인 settings.json 도 디스크가 가득 차 새 파일을 못 쓰면 그대로 두고 멈춤", () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  const other = join(fresh("dot"), "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  linkSync(file, other);
  const before = readFileSync(file);
  const r = install({ cfg, nodeArgs: failingPreload("writeFileSync", "ENOSPC") });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /ENOSPC/);
  assert.ok(readFileSync(other).equals(before), "settings.json is as it was");
  assert.equal(statSync(file).nlink, 2);
});

// The group a new file in the test folders gets (the account's on Linux, the folder's on macOS), and another group
// of this account's, which a settings.json made anew could not keep.
const newFileGroup = (() => {
  const probe = join(root, "group-probe");
  writeFileSync(probe, "");
  try {
    return statSync(probe).gid;
  } finally {
    rmSync(probe);
  }
})();
// Only a group a file here can be given: in a user namespace a group that is not mapped shows as 65534 and cannot.
const canGive = (gid) => {
  const probe = join(root, "group-probe");
  writeFileSync(probe, "");
  try {
    chownSync(probe, process.getuid(), gid);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe);
  }
};
const otherGroup = POSIX ? process.getgroups().find((g) => g !== newFileGroup && canGive(g)) : undefined;
const otherGroupOpts = { skip: (!POSIX && "Windows has no POSIX groups") || (otherGroup === undefined && "this account has no other group a file here can be given") };

test("새 파일이면 그룹이 바뀔 settings.json 은 제자리에 써 그룹과 권한이 그대로", otherGroupOpts, () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  chownSync(file, process.getuid(), otherGroup);
  chmodSync(file, 0o660);
  const ino = inoOf(file);
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.equal(inoOf(file), ino, "written in place");
  assert.equal(statSync(file).gid, otherGroup);
  assert.equal(modeOf(file), 0o660);
  assert.match(settingsOf(cfg).statusLine.command, /omc-hud-custom\.mjs/);
});

// A preload under which the installer's temporary file reports another owner, as when settings.json belongs to
// another account (root, say) that lets this one write it. Tied to the installer reading it with statSync.
function otherOwnerPreload() {
  const file = join(root, `owner-${++seq}.mjs`);
  writeFileSync(file, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const real = fs.statSync;",
    "fs.statSync = function (p, ...rest) {",
    "  const st = real.call(this, p, ...rest);",
    '  if (st && String(p).endsWith(".tmp")) st.uid += 1;',
    "  return st;",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  return ["--import", pathToFileURL(file).href];
}

test("새 파일이면 소유자가 바뀔 settings.json 은 제자리에 씀", () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  const ino = inoOf(file);
  const r = install({ cfg, nodeArgs: otherOwnerPreload() });
  assert.equal(r.status, 0, r.out);
  assert.equal(inoOf(file), ino, "written in place");
  assert.match(settingsOf(cfg).statusLine.command, /omc-hud-custom\.mjs/);
  assert.deepEqual(readdirSync(cfg).filter((n) => n.endsWith(".tmp")), []);
});

test("렌더 확인 정화는 제어 글자 밖의 서식, 사용자 영역, 미할당, 변이 선택, 점자 빈칸, 넓은 공백도 ? 로 바꿈", () => {
  const odd = [0x202e, 0xe000, 0x0378, 0xfe0f, 0x2800, 0x3000, 0x00a0].map((c) => String.fromCharCode(c));
  const { out } = renderWith(`console.log(${JSON.stringify(`[OMC HUD] HUD import failed: a${odd.join("b")}c`)});\n`);
  assert.match(out, /OMC's HUD does not load: \[OMC HUD\] HUD import failed: a\?b\?b\?b\?b\?b\?b\?c/);
  for (const ch of odd) assert.ok(!out.includes(ch), `U+${ch.charCodeAt(0).toString(16)} is shown as ?`);
});

const ESC = String.fromCharCode(27);
test("렌더 확인: stderr 의 오류 줄도 정화", () => {
  const { out } = renderWith(`process.stderr.write(${JSON.stringify(`Error: bad${ESC}x\n`)});\nprocess.exit(3);\n`);
  assert.match(out, /failed \(exit 3\): Error: bad\?x/);
  assert.ok(!out.includes(ESC));
});

test("렌더 확인: Node 오류 줄도 정화", () => {
  const { out } = renderWith(`import ${JSON.stringify(`./no-such-${ESC}.mjs`)};\n`);
  assert.match(out, /prints an error instead of a line: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module .*no-such-\?\.mjs/);
  assert.ok(!out.includes(ESC));
});

test("렌더 확인: 이유 줄도 정화", () => {
  const omc = {
    "5.7.4": { pkg: true, loader: banner("5.7.4") },
    "5.7.5": { pkg: true, loader: banner("5.7.4"), dist: `throw new Error(${JSON.stringify(`boom${ESC}x`)});\n` },
  };
  const r = install({ cfg: fresh(), versions: ["5.7.4", "5.7.5"], env: withNode(), omc });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /5\.7\.5 does not load \(Error: boom\?x\)\./);
  assert.ok(!r.out.includes(ESC));
});

test("렌더 확인: 모르는 출력도 정화", () => {
  const { out } = renderWith(`console.log(${JSON.stringify(`hello${ESC}x`)});\n`);
  assert.match(out, /unrecognized output: hello\?x/);
  assert.ok(!out.includes(ESC));
});

// B1-12: settings.json can hold tokens, and the line about the old statusLine command goes into a report. 0.20.5 review:
// masking the parts that look like secrets missed every form no rule named (curl -u, sshpass -p, mysql -pPW, a JSON
// password), so the line shows the command's first word (a variable it sets is skipped) and its length.
test("이전 statusLine 명령은 첫 낱말(변수 대입은 건너뜀)과 길이만 보임", () => {
  const cfg = fresh();
  // Made here, so no secret-looking text sits in the repository.
  const pw = ["hu", "nt3r2"].join("");
  const userinfo = ["me", pw].join(":");
  const command = [
    "COLUMNS=120", `API_TOKEN=${pw}`, 'node "/x/s.mjs"', `--password ${pw}`, `https://${userinfo}@example.invalid/p?key=${pw}`,
    `-H "Authorization: ${pw}"`, `curl -u alice:${pw}`, `sshpass -p ${pw}`, `mysql -p${pw}`, `'{"password":"${pw}"}'`,
  ].join(" ");
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ statusLine: { type: "command", command } }));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  const line = r.out.split("\n").find((l) => l.startsWith("[..] statusLine ran ")) ?? "";
  assert.ok(line.includes(`"node …" (${command.length} characters)`), line);
  assert.ok(!line.includes(pw) && !line.includes("COLUMNS") && !line.includes("/x/s.mjs"), line);
  // a value in quotes is one word with its name, a quote left open runs to the end, and a first word that looks like
  // a secret (a NAME=value in quotes, an address) is not shown (0.20.5 reviews N3 and d)
  const word = ["Secret", "Word"].join("");
  for (const [cmd, shownAs] of [[`PASSWORD="my ${word} pass" node /x/old.mjs --a`, '"node …"'], [`KEY='a ${word}' node x.mjs`, '"node …"'],
    [`TOKEN="ab ${word}"tail node x`, '"node …"'], [`TOKEN="ab ${word} node x`, '"(no program)"'], [`"API_KEY=${word}" node x.mjs`, '"(program hidden) …"'],
    [`https://u:${word}@example.invalid/hud.sh`, '"(program hidden)"'],
    // a backslash escapes a quote or a space inside a word (0.20.5 code review r3)
    [`PASSWORD="a \\" ${word} \\" b" node x`, '"node …"'], [`PASSWORD=a\\ ${word}\\ b node x`, '"node …"']]) {
    const c = fresh();
    writeFileSync(join(c, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: cmd } }));
    const out = install({ cfg: c }).out;
    const l = out.split("\n").find((x) => x.startsWith("[..] statusLine ran ")) ?? "";
    assert.ok(l.includes(`${shownAs} (${cmd.length} characters)`), `${cmd}\n${l}`);
    assert.ok(!l.includes(word) && !l.includes("tail"), l);
  }
  // a command of one word shows that word
  const one = fresh();
  writeFileSync(join(one, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "/usr/local/bin/my-hud" } }));
  assert.match(install({ cfg: one }).out, /\[\.\.\] statusLine ran "\/usr\/local\/bin\/my-hud" \(21 characters\)/);
});

// Deferred 2: a hard-linked settings.json is written in place (the 2026-10-20 decision), so its other names change too.
test("하드 링크인 settings.json 은 다른 이름도 바뀐다고 알리고, 이름이 하나면 알리지 않음", () => {
  const cfg = fresh();
  const file = join(cfg, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  linkSync(file, join(fresh("snapshot"), "settings.json"));
  const r = install({ cfg });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[\.\.\] settings\.json has 1 other name \(a hard link\); it was written in place/);
  const plain = fresh();
  writeFileSync(join(plain, "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.doesNotMatch(install({ cfg: plain }).out, /other name/);
});

// 0.20.5: a target that is there but no regular file stops the install before it reads or writes anything. Reading or
// writing a FIFO waits for good, and a folder stopped the install half-way, after the loader was written.
const NOT_REGULAR = /is not a regular file \(a folder, a FIFO or a device\); nothing changed/;
function assertUntouched(cfg, rel) {
  for (const f of [join("hud", "omc-hud.mjs"), join("hud", "omc-hud-custom.mjs"), "settings.json"]) {
    if (f !== rel) assert.ok(!existsSync(join(cfg, f)), `${rel}: ${f} was written`);
  }
}
test("설치 대상 자리에 FIFO 가 있으면 기다리지 않고 아무것도 바꾸지 않은 채 멈춤", { skip: !POSIX && "Windows has no FIFO" }, () => {
  for (const rel of ["settings.json", join("hud", "omc-hud.mjs"), join(".omc", "hud-config.json")]) {
    const cfg = fresh();
    mkdirSync(dirname(join(cfg, rel)), { recursive: true });
    assert.equal(spawnSync("mkfifo", [join(cfg, rel)]).status, 0);
    const r = install({ cfg, timeout: 20000 });
    assert.equal(r.status, 1, `${rel}: ${r.out}`);
    assert.match(r.out, NOT_REGULAR, rel);
    assertUntouched(cfg, rel);
  }
});

test("설치 대상 자리에 폴더가 있으면 반쯤 쓰지 않고 아무것도 바꾸지 않은 채 멈춤", () => {
  const cfg = fresh();
  const rel = join("hud", "omc-hud-custom.mjs");
  mkdirSync(join(cfg, rel), { recursive: true });
  const r = install({ cfg, timeout: 20000 });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, NOT_REGULAR);
  assertUntouched(cfg, rel);
  const other = fresh();
  writeFileSync(join(other, ".omc"), "a file where the HUD config folder goes\n");
  const f = install({ cfg: other, timeout: 20000 });
  assert.equal(f.status, 1, f.out);
  assert.match(f.out, /\.omc is not a folder; nothing changed/);
  assertUntouched(other, "");
});
