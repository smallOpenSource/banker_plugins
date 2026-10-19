// Tests for ../assets/apply-hud.mjs. Run from the repo root: node --test skills/setup-omc-hud/scripts/*.test.mjs
// Every run gets its own HOME, USERPROFILE and CLAUDE_CONFIG_DIR under a temp folder, with a fake OMC
// version folder that holds only the two files the installer copies.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const APPLY = join(ASSETS, "apply-hud.mjs");
const root = mkdtempSync(join(tmpdir(), "apply-hud-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
const fresh = (name = "case") => {
  const dir = join(root, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const slash = (p) => p.split(sep).join("/");
const asset = (name) => readFileSync(join(ASSETS, name));

// A fake OMC version folder: the loader template says which version it came from.
function fakeOmc(dir, version, withTemplate = true) {
  const lib = join(dir, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  if (withTemplate) writeFileSync(join(lib, "hud-wrapper-template.txt"), `// loader ${version}\n`);
  writeFileSync(join(lib, "config-dir.mjs"), "export const getClaudeConfigDir = () => '';\n");
}
const omcCache = (cfg) => join(cfg, "plugins", "cache", "omc", "oh-my-claudecode");

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CONFIG_DIR|OMC_PLUGIN_ROOT|HOME|USERPROFILE)$/i.test(k)));
const INSTALL_DEFAULTS = { cwd: root, versions: ["5.7.4"], bare: [], env: {}, wrap: [] };
// Runs the installer. `cfg` is where the config folder really is; `value` is what CLAUDE_CONFIG_DIR
// says (default `cfg`, null to leave it unset).
function install(opts) {
  const o = { ...INSTALL_DEFAULTS, home: fresh("home"), value: opts.cfg, ...opts };
  for (const v of o.versions) fakeOmc(join(omcCache(o.cfg), v), v);
  for (const v of o.bare) fakeOmc(join(omcCache(o.cfg), v), v, false);
  const childEnv = { ...cleanEnv(), HOME: o.home, USERPROFILE: o.home, ...o.env };
  if (o.value !== null) childEnv.CLAUDE_CONFIG_DIR = o.value;
  const [cmd, ...args] = [...o.wrap, process.execPath, APPLY];
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: childEnv, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, home: o.home };
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
  writeFileSync(join(cfg, "settings.json"), "﻿" + JSON.stringify({ theme: "dark" }));
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
