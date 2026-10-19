// Tests for ../assets/apply-hud.mjs. Run from the repo root: node --test skills/setup-omc-hud/scripts/*.test.mjs
// Every run gets its own HOME, USERPROFILE and CLAUDE_CONFIG_DIR under a temp folder, with a fake OMC
// version folder that holds only the two files the installer copies.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

// A fake OMC version folder: the loader template says which version it came from. `template` and
// `configDir` leave out either file the installer copies; `mode` sets both files' mode bits (POSIX).
function fakeOmc(dir, version, { template = true, configDir = true, mode } = {}) {
  const lib = join(dir, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  const files = [];
  if (template) files.push([join(lib, "hud-wrapper-template.txt"), `// loader ${version}\n`]);
  if (configDir) files.push([join(lib, "config-dir.mjs"), "export const getClaudeConfigDir = () => '';\n"]);
  for (const [file, text] of files) {
    writeFileSync(file, text);
    if (mode && POSIX) chmodSync(file, mode);
  }
}
const omcCache = (cfg) => join(cfg, "plugins", "cache", "omc", "oh-my-claudecode");

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CONFIG_DIR|OMC_PLUGIN_ROOT|HOME|USERPROFILE)$/i.test(k)));
const INSTALL_DEFAULTS = { cwd: root, versions: ["5.7.4"], bare: [], half: [], env: {}, wrap: [], omcMode: undefined };
// Runs the installer. `cfg` is where the config folder really is; `value` is what CLAUDE_CONFIG_DIR
// says (default `cfg`, null to leave it unset). `bare` versions lack the template, `half` ones config-dir.mjs.
function install(opts) {
  const o = { ...INSTALL_DEFAULTS, home: fresh("home"), value: opts.cfg, ...opts };
  for (const v of o.versions) fakeOmc(join(omcCache(o.cfg), v), v, { mode: o.omcMode });
  for (const v of o.bare) fakeOmc(join(omcCache(o.cfg), v), v, { template: false });
  for (const v of o.half) fakeOmc(join(omcCache(o.cfg), v), v, { configDir: false });
  const childEnv = { ...cleanEnv(), HOME: o.home, USERPROFILE: o.home, ...o.env };
  if (o.value !== null) childEnv.CLAUDE_CONFIG_DIR = o.value;
  const [cmd, ...args] = [...o.wrap, process.execPath, APPLY];
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: childEnv, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, err: r.stderr, home: o.home };
}
const settingsOf = (cfg) => JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8"));
const backups = (dir, name) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.backup.`)) : []);

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
  assert.equal(readFileSync(join(cfg, "hud", "omc-hud.mjs"), "utf8"), "// loader 5.7.4\n");
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

test("settings.json 이 깨진 JSON, null, 배열이면 종료 1 이고 아무것도 바꾸지 않음", () => {
  for (const bad of ["{", "null", "[]"]) {
    const cfg = fresh();
    writeFileSync(join(cfg, "settings.json"), bad);
    const r = install({ cfg });
    assert.equal(r.status, 1, `${bad}: ${r.out}`);
    assert.match(r.out, /\[x\] Existing settings\.json is not a JSON object/);
    assert.ok(!existsSync(join(cfg, "hud")), `${bad}: no hud folder`);
    assert.ok(!existsSync(join(cfg, ".omc")), `${bad}: no .omc folder`);
    assert.equal(readFileSync(join(cfg, "settings.json"), "utf8"), bad);
    assert.deepEqual(backups(cfg, "settings.json"), []);
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

test("버전 폴더는 숫자로 비교하고 정식판을 pre-release 보다 위로", () => {
  const loaderAfter = (versions, bare = []) => {
    const cfg = fresh();
    const r = install({ cfg, versions, bare });
    assert.equal(r.status, 0, r.out);
    return readFileSync(join(cfg, "hud", "omc-hud.mjs"), "utf8").trim();
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
  assert.equal(readFileSync(join(cfg, "hud", "omc-hud.mjs"), "utf8"), "// loader root\n");
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

test("설치 스크립트는 내장 모듈 fs, os, path, url 만 가져옴", () => {
  const src = readFileSync(APPLY, "utf8");
  // Each top-level import statement runs from `import` at a line start to its `;`.
  const specifiers = [...src.matchAll(/^import\b[^;]*;/gm)].map((m) => /["']([^"']+)["']\s*;$/.exec(m[0])?.[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((s) => !["node:fs", "node:os", "node:path", "node:url"].includes(s)), []);
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
  assert.equal(readFileSync(join(cfg, "hud", "omc-hud.mjs"), "utf8"), "// loader 5.7.4\n");
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
  assert.equal(readFileSync(join(cfg, "hud", "omc-hud.mjs"), "utf8"), "// loader 5.7.4\n");
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
