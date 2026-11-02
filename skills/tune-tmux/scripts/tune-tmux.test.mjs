// tune-tmux unit and command tests (plan 4.4, US-4 acceptance 1, 2, 4, 5, 6, 9, 10, 11). Temp HOME only; tmux is
// played by a fake exec so every OS runs these. Real tmux runs in tmux-it.test.mjs.
// Run: node --test skills/tune-tmux/scripts/tune-tmux.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HASH, markers } from "./marker-block.mjs";
import * as tc from "./tmux-config.mjs";
import { parseArgs, run } from "./tune-tmux.mjs";

const WIN = process.platform === "win32";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "tune-tmux.mjs");
const base = mkdtempSync(join(tmpdir(), "tune-tmux-unit-"));
after(() => rmSync(base, { recursive: true, force: true }));
const MK = markers(HASH, "banker:tune-tmux");

let n = 0;
const fresh = (name = "h") => {
  const d = join(base, `${name}${n++}`);
  mkdirSync(d);
  return d;
};
const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
const enoent = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });

// Plays tmux (and psmux) for run(): version, the #{||:} probe, a running server or not.
function fakeExec({ version = "tmux 3.6a", conditional = true, psmux = null, running = false, calls = [] } = {}) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "psmux") return psmux ? ok(psmux) : enoent();
    if (cmd !== "tmux" || version === null) return enoent();
    if (args[0] === "-V") return ok(`${version}\n`);
    if (args.includes("display-message")) return ok(conditional ? "10\n" : "#{||:0,1}#{||:0,0}\n");
    if (args.includes("list-sessions")) return running ? ok("s: 1 windows\n") : { status: 1, stdout: "", stderr: "no server running" };
    return ok("");
  };
}
const PSMUX_V = "tmux 3.3.8\npsmux 3.3.8 (66cf613 2026-08-18)";

const envFor = (home, extra = {}) => ({ HOME: home, USERPROFILE: home, PATH: join(home, "no-bin"), ...extra });
const tune = (home, argv, o = {}) => run(argv, { env: envFor(home, o.env), platform: o.platform ?? "linux", exec: o.exec ?? fakeExec(o.fake), caps: o.caps ?? null });
const json = (r) => JSON.parse(r.stdout);
const count = (text, needle) => text.split(needle).length - 1;

function trySymlink(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (e) {
    if (WIN && e.code === "EPERM") return false;
    throw e;
  }
}

test("usage: --help first line, unknown argument and bad --target are exit 2", () => {
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout.split("\n")[0], /^tune-tmux: /);
  assert.equal(run(["--nope"]).code, 2);
  assert.equal(run(["on", "--target", "screen"]).code, 2);
  assert.equal(run(["on", "--conf"]).code, 2);
  assert.deepEqual(parseArgs(["off", "--target=psmux", "--force-drag"]).target, "psmux");
});

test("acceptance 1: on makes ~/.tmux.conf with one block, on again is byte-identical, off leaves an empty file", () => {
  const home = fresh();
  const conf = join(home, ".tmux.conf");
  const first = tune(home, ["on", "--target", "tmux"]);
  assert.equal(first.code, 0, first.stderr);
  const bytes = readFileSync(conf);
  assert.equal(count(bytes.toString(), MK.start), 1);
  assert.equal(count(bytes.toString(), MK.end), 1);
  assert.match(bytes.toString(), /^set -g mouse on$/m);
  const again = tune(home, ["on", "--target", "tmux", "--json"]);
  assert.equal(json(again).changed, false);
  assert.deepEqual(readFileSync(conf), bytes);
  assert.equal(existsSync(`${conf}.tune-tmux.bak`), false, "a new file needs no backup");
  const off = tune(home, ["off", "--target", "tmux"]);
  assert.equal(off.code, 0);
  assert.equal(readFileSync(conf).length, 0);
  assert.match(off.stdout, /빈 파일로 남김/);
  assert.equal(json(tune(home, ["off", "--target", "tmux", "--json"])).changed, false, "off without a block changes nothing");
});

test("acceptance 2: user conf with CRLF and 0600 comes back byte- and mode-identical; .bak keeps the first original", () => {
  const home = fresh();
  const conf = join(home, ".tmux.conf");
  const original = Buffer.from("# mine\r\nset -g history-limit 9000\r\nbind r source-file ~/.tmux.conf\r\n");
  writeFileSync(conf, original);
  chmodSync(conf, 0o600);
  assert.equal(tune(home, ["on", "--target", "tmux"]).code, 0);
  const on1 = readFileSync(conf, "utf8");
  assert.match(on1, /\r\nset -g mouse on\r\n/, "block lines use the file's CRLF");
  assert.deepEqual(readFileSync(`${conf}.tune-tmux.bak`), original);
  const bin = fresh("bin");
  // tune() plays Linux (platform "linux"), so the lookup wants the Linux name "xclip" with no extension on every host.
  writeFileSync(join(bin, "xclip"), "");
  chmodSync(join(bin, "xclip"), 0o755);
  const second = tune(home, ["on", "--target", "tmux"], { env: { PATH: bin, DISPLAY: ":9" } });
  assert.equal(second.code, 0);
  assert.notEqual(readFileSync(conf, "utf8"), on1, "the second on changed the block (clipboard found)");
  assert.deepEqual(readFileSync(`${conf}.tune-tmux.bak`), original, "the second on does not overwrite .bak");
  assert.equal(tune(home, ["off", "--target", "tmux"]).code, 0);
  assert.deepEqual(readFileSync(conf), original);
  if (!WIN) assert.equal(statSync(conf).mode & 0o777, 0o600);
});

test("acceptance 4: psmux reads ~/.psmux.conf before ~/.tmux.conf; PSMUX_CONFIG_FILE comes first; --conf before both", () => {
  const home = fresh();
  const fake = { psmux: PSMUX_V };
  const confOf = (o = {}) => json(tune(home, ["status", "--target", "psmux", "--json", ...(o.argv ?? [])], { platform: "win32", fake, env: o.env })).conf;
  assert.equal(confOf(), join(home, ".psmux.conf"), "nothing there: ~/.psmux.conf would be made");
  writeFileSync(join(home, ".tmux.conf"), "set -g @b 1\n");
  assert.equal(confOf(), join(home, ".tmux.conf"));
  mkdirSync(join(home, ".config", "psmux"), { recursive: true });
  writeFileSync(join(home, ".config", "psmux", "psmux.conf"), "");
  assert.equal(confOf(), join(home, ".tmux.conf"), "~/.tmux.conf comes before ~/.config/psmux/psmux.conf");
  writeFileSync(join(home, ".psmuxrc"), "");
  assert.equal(confOf(), join(home, ".psmuxrc"));
  writeFileSync(join(home, ".psmux.conf"), "set -g @a 1\n");
  assert.equal(confOf(), join(home, ".psmux.conf"));
  const envFile = join(home, "env.conf");
  assert.equal(confOf({ env: { PSMUX_CONFIG_FILE: envFile } }), envFile);
  assert.equal(confOf({ env: { PSMUX_CONFIG_FILE: envFile }, argv: ["--conf", join(home, "f.conf")] }), join(home, "f.conf"));
});

test("acceptance 4: on Windows auto picks psmux, and a tmux command that is psmux is psmux", () => {
  const home = fresh();
  assert.equal(json(tune(home, ["status", "--json"], { platform: "win32", fake: { version: null, psmux: PSMUX_V } })).target, "psmux");
  const alias = json(tune(home, ["status", "--json"], { platform: "win32", fake: { version: PSMUX_V } }));
  assert.equal(alias.target, "psmux");
  const asked = json(tune(home, ["status", "--target", "tmux", "--json"], { fake: { version: PSMUX_V } }));
  assert.equal(asked.target, "psmux");
  assert.match(asked.warnings.join("\n"), /psmux 라 psmux 로 처리/);
  assert.equal(json(tune(home, ["status", "--json"], { platform: "win32", fake: { version: "tmux 3.4" } })).target, "tmux", "no psmux: tmux");
  assert.deepEqual(tc.parseVersion(PSMUX_V), { kind: "psmux", major: 3, minor: 3, raw: "tmux 3.3.8" });
});

test("acceptance 5: the shipped psmux table puts no block; exit 0 with the counts of unverified and broken behaviors", () => {
  const home = fresh();
  writeFileSync(join(home, ".psmux.conf"), "set -g @mine 1\n");
  const before = readFileSync(join(home, ".psmux.conf"));
  const r = tune(home, ["on", "--target", "psmux"], { platform: "win32", fake: { psmux: PSMUX_V } });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /충분/, "no claim that the defaults are enough");
  assert.match(r.stdout, /^넣은 줄 0: psmux 기본값 유지\. 미확인 2, 안 됨 3$/m);
  assert.match(r.stdout, /psmux 기본값으로 되는 것:\n  - 마우스\(mouse on\)\n  - set-clipboard on\n  - 휠로 copy-mode 진입/);
  assert.match(r.stdout, /확인 못 한 것:\n  - 드래그한 글이 Windows 클립보드로 가는지/);
  assert.match(r.stdout, /안 되는 것:\n  - 앱 밖\(셸\) PageUp 은 prefix 뒤에만[^\n]*\n  - PageDown 이 바닥에서 copy-mode 를 빠지지 않음[^\n]*\n  - #\{alternate_on\} 이 늘 0/);
  const j = json(tune(home, ["on", "--target", "psmux", "--json"], { platform: "win32", fake: { psmux: PSMUX_V } }));
  assert.deepEqual([j.changed, j.note, j.psmux.unverified.length, j.psmux.broken.length], [false, "넣은 줄 0: psmux 기본값 유지. 미확인 2, 안 됨 3", 2, 3]);
  assert.deepEqual(readFileSync(join(home, ".psmux.conf")), before);
  assert.deepEqual(readdirSync(home).sort(), [".psmux.conf"], "no backup, no new file");
  const caps = JSON.parse(readFileSync(join(HERE, "psmux-caps.json"), "utf8"));
  assert.equal(tc.psmuxBody(caps, true).lines.length, 0, "no verified non-default line, --force-drag included");
  const st = tune(home, ["status", "--target", "psmux"], { platform: "win32", fake: { psmux: PSMUX_V } });
  assert.match(st.stdout, /바닥에서 빠지지 않음/);
  assert.match(st.stdout, /alternate_on\} 이 늘 0/);
});

test("acceptance 5: a verified line goes in, a line equal to the psmux default does not", () => {
  const home = fresh();
  const caps = {
    psmux: "9.9",
    options: [
      { id: "mouse", line: "set -g mouse on", verified: true, default: true, note: "기본" },
      { id: "history", line: "set -g history-limit 5000", verified: true, note: "확인" },
      { id: "page-up", line: "bind -n PPage copy-mode -u", verified: false, note: "미확인" },
    ],
  };
  const r = tune(home, ["on", "--target", "psmux"], { platform: "win32", fake: { psmux: PSMUX_V }, caps });
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(join(home, ".psmux.conf"), "utf8");
  assert.match(text, /^set -g history-limit 5000$/m);
  assert.doesNotMatch(text, /mouse on/);
  assert.doesNotMatch(text, /PPage/);
  assert.equal(count(text, MK.start), 1);
});

test("psmux on with zero lines takes out an old tune-tmux block like off, keeps the user's lines, then changes nothing", () => {
  const home = fresh();
  const conf = join(home, ".psmux.conf");
  writeFileSync(conf, "set -g @mine 1\n");
  const caps = { psmux: "9.9", options: [{ id: "history", line: "set -g history-limit 5000", verified: true, note: "확인" }] };
  assert.equal(tune(home, ["on", "--target", "psmux"], { platform: "win32", fake: { psmux: PSMUX_V }, caps }).code, 0);
  assert.equal(count(readFileSync(conf, "utf8"), MK.start), 1, "old block in place");
  const dry = tune(home, ["on", "--target", "psmux", "--dry-run"], { platform: "win32", fake: { psmux: PSMUX_V } });
  assert.match(dry.stdout, /옛 tune-tmux 블록을 뺄 예정/);
  assert.equal(count(readFileSync(conf, "utf8"), MK.start), 1, "dry-run changes nothing");
  const r = tune(home, ["on", "--target", "psmux"], { platform: "win32", fake: { psmux: PSMUX_V } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^결과: 바꿈: /m);
  assert.match(r.stdout, /^넣은 줄 0: psmux 기본값 유지\. 미확인 2, 안 됨 3$/m);
  assert.match(r.stdout, /^넣을 줄이 0개라 옛 tune-tmux 블록을 뺌\(off 와 같음\)$/m);
  assert.equal(readFileSync(conf, "utf8"), "set -g @mine 1\n", "only the block is gone");
  const again = json(tune(home, ["on", "--target", "psmux", "--json"], { platform: "win32", fake: { psmux: PSMUX_V } }));
  assert.equal(again.changed, false);
  // a file that held only the block is left empty, and the report says so
  const only = fresh("only");
  const conf2 = join(only, ".psmux.conf");
  tune(only, ["on", "--target", "psmux"], { platform: "win32", fake: { psmux: PSMUX_V }, caps });
  const r2 = json(tune(only, ["on", "--target", "psmux", "--json"], { platform: "win32", fake: { psmux: PSMUX_V } }));
  assert.equal(r2.removed, "넣을 줄이 0개라 옛 tune-tmux 블록을 뺌(off 와 같음). 블록만 있던 파일이라 빈 파일로 남김");
  assert.equal(readFileSync(conf2, "utf8"), "");
});

test("acceptance 6: clipboard choice for macOS, Wayland, X11 xclip and xsel, WSL and none", () => {
  const has = (...names) => (n) => names.includes(n);
  const pick = (platform, env, ...names) => tc.pickClipboard({ platform, env, has: has(...names) })?.cmd ?? null;
  assert.equal(pick("darwin", {}, "pbcopy"), "pbcopy");
  assert.equal(pick("linux", { WAYLAND_DISPLAY: "wayland-0" }, "wl-copy", "xclip"), "wl-copy");
  assert.equal(pick("linux", { DISPLAY: ":0" }, "xclip", "xsel"), "xclip -selection clipboard -in");
  assert.equal(pick("linux", { DISPLAY: ":0" }, "xsel"), "xsel -ib");
  assert.equal(pick("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "clip.exe"), "clip.exe");
  assert.equal(pick("linux", {}, "xclip", "wl-copy", "pbcopy"), null, "no display, not macOS, not WSL");
  const bin = fresh("bin");
  writeFileSync(join(bin, WIN ? "xsel.exe" : "xsel"), "");
  if (!WIN) chmodSync(join(bin, "xsel"), 0o755);
  // Windows: the PATHEXT entry as written (.EXE) finds xsel.exe on a case-insensitive file system; same file.
  const found = tc.which("xsel", { PATH: bin, PATHEXT: ".EXE" });
  const want = join(bin, WIN ? "xsel.exe" : "xsel");
  assert.equal(WIN ? found?.toLowerCase() : found, WIN ? want.toLowerCase() : want);
  assert.equal(tc.which("xclip", { PATH: bin, PATHEXT: ".EXE" }), null);
});

test("acceptance 6: tmux 3.6 gets copy-command, 3.1 gets copy-pipe in both copy tables, no tool gets OSC 52 only", () => {
  const clipboard = { tool: "xclip", cmd: "xclip -selection clipboard -in" };
  const v = (s) => tc.parseVersion(`tmux ${s}`);
  const new6 = tc.tmuxBody({ version: v("3.6a"), clipboard, conditional: true, forceDrag: false }).lines;
  assert.ok(new6.includes("set -s copy-command 'xclip -selection clipboard -in'"));
  assert.ok(!new6.some((l) => l.includes("copy-pipe")));
  const old1 = tc.tmuxBody({ version: v("3.1"), clipboard, conditional: true, forceDrag: false }).lines;
  assert.ok(!old1.some((l) => l.includes("copy-command")));
  assert.ok(old1.includes("bind -T copy-mode MouseDragEnd1Pane send -X copy-pipe-and-cancel 'xclip -selection clipboard -in'"));
  assert.ok(old1.includes("bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-pipe-and-cancel 'xclip -selection clipboard -in'"));
  const none = tc.tmuxBody({ version: v("3.6a"), clipboard: null, conditional: true, forceDrag: false });
  assert.ok(!none.lines.some((l) => /copy-command|copy-pipe/.test(l)));
  assert.match(none.omitted[0].reason, /OSC 52/);
  assert.ok(new6.includes("set -s set-clipboard on") && new6.includes(tc.PAGE_UP));
  assert.ok(!new6.includes(tc.FORCE_DRAG), "MouseDrag1Pane stays the tmux default");
  assert.ok(tc.tmuxBody({ version: v("3.6a"), clipboard, conditional: true, forceDrag: true }).lines.includes(tc.FORCE_DRAG));
});

test("acceptance 9: a linked conf is refused (exit 1, link and target unchanged); --follow-symlink writes the target", (t) => {
  const home = fresh();
  const dots = fresh("dots");
  const target = join(dots, "tmux.conf");
  writeFileSync(target, "set -g @dot 1\n");
  if (!trySymlink(target, join(home, ".tmux.conf"))) return t.skip("Windows: 심볼릭 링크를 만들 권한 없음(OS 고유)");
  const refused = tune(home, ["on", "--target", "tmux"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /심볼릭 링크라 그대로 둠/);
  assert.equal(readFileSync(target, "utf8"), "set -g @dot 1\n");
  const followed = tune(home, ["on", "--target", "tmux", "--follow-symlink"]);
  assert.equal(followed.code, 0, followed.stderr);
  assert.ok(lstatSync(join(home, ".tmux.conf")).isSymbolicLink());
  assert.equal(readlinkSync(join(home, ".tmux.conf")), target);
  assert.match(readFileSync(target, "utf8"), /^set -g @dot 1\n\n# banker:tune-tmux:start/);
  const other = fresh();
  trySymlink(join(other, "gone.conf"), join(other, ".tmux.conf"));
  const dangling = tune(other, ["on", "--target", "tmux", "--follow-symlink"]);
  assert.equal(dangling.code, 1);
  assert.match(dangling.stderr, /끊어진 링크/);
  assert.equal(readdirSync(other).length, 1);
});

test("acceptance 10: a tmux that cannot read #{||:} gets no PageUp line and the reason", () => {
  const home = fresh();
  const r = tune(home, ["on", "--target", "tmux"], { fake: { conditional: false } });
  assert.equal(r.code, 0);
  assert.doesNotMatch(readFileSync(join(home, ".tmux.conf"), "utf8"), /PPage/);
  assert.match(r.stdout, /PageUp: 이 tmux 는 #\{\|\|:\} 조건식을 읽지 못함/);
});

test("acceptance 10 (fake executable): the command line drops PageUp when tmux prints the format back", (t) => {
  if (WIN) return t.skip("Windows: 셸 스크립트 가짜 실행 파일을 셸 없이 띄울 수 없음(OS 고유). 같은 경로는 위 시험이 덮음");
  const home = fresh();
  const bin = fresh("bin");
  const script = ["#!/bin/sh", 'case "$1" in -V) echo "tmux 3.6a"; exit 0;; esac', 'for a in "$@"; do case "$a" in display-message) echo "#{||:0,1}#{||:0,0}";; esac; done', "exit 0", ""];
  writeFileSync(join(bin, "tmux"), script.join("\n"));
  chmodSync(join(bin, "tmux"), 0o755);
  const r = spawnSync(process.execPath, [CLI, "on", "--target", "tmux"], { encoding: "utf8", env: { HOME: home, PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /조건식을 읽지 못함/);
  assert.doesNotMatch(readFileSync(join(home, ".tmux.conf"), "utf8"), /PPage/);
});

test("acceptance 11: status shows the per-app table and the code never names Claude Code or Codex settings", () => {
  const home = fresh();
  const r = tune(home, ["status", "--target", "tmux"]);
  assert.equal(r.code, 0);
  for (const s of ["Claude Code 전체 화면", "Codex Fullscreen", "--no-alt-screen", 'tui.alternate_screen = "never"', "Shift 드래그", "--force-drag", "블록: 없음"]) assert.ok(r.stdout.includes(s), s);
  for (const file of ["tune-tmux.mjs", "tmux-config.mjs", "app-notes.mjs"]) {
    const src = readFileSync(join(HERE, file), "utf8");
    assert.doesNotMatch(src, /\.claude|\.codex|settings\.json|config\.toml|CODEX_HOME/, file);
  }
});

test("environment: on and off without tmux are exit 3; status is exit 0 and points at setup-tmux", () => {
  const home = fresh();
  assert.equal(tune(home, ["on"], { fake: { version: null } }).code, 3);
  assert.equal(tune(home, ["off", "--target", "psmux"], { fake: { version: null } }).code, 3);
  const st = tune(home, ["status"], { fake: { version: null } });
  assert.equal(st.code, 0);
  assert.match(st.stdout, /미설치\(banker setup-tmux 로 설치\)/);
  assert.deepEqual(readdirSync(home), []);
});

test("dry-run plans without writing; --reload with no server running is exit 0", () => {
  const home = fresh();
  const dry = tune(home, ["on", "--target", "tmux", "--dry-run", "--json"]);
  assert.equal(json(dry).changed, true);
  assert.deepEqual(readdirSync(home), []);
  const calls = [];
  const r = tune(home, ["on", "--target", "tmux", "--reload", "--json"], { fake: { calls } });
  assert.equal(r.code, 0);
  assert.equal(json(r).reload.state, "no-server");
  assert.ok(!calls.some((c) => c.includes("source-file")), "nothing sourced without a server");
});

test("status block states: absent, current, stale, refused", () => {
  const home = fresh();
  const state = (o) => json(tune(home, ["status", "--target", "tmux", "--json"], o)).state;
  assert.equal(state(), "absent");
  tune(home, ["on", "--target", "tmux"]);
  assert.equal(state(), "current");
  assert.equal(state({ fake: { conditional: false } }), "stale");
  writeFileSync(join(home, ".tmux.conf"), `${MK.start}\nset -g mouse on\n`);
  assert.equal(state(), "refused:markers");
  assert.equal(tune(home, ["off", "--target", "tmux"]).code, 1, "broken markers are refused");
});

test("conflicts: mouse off, set-clipboard off and a root PPage in another file are warned; prefix PPage is not", () => {
  const dir = fresh();
  const f = join(dir, "other.conf");
  writeFileSync(f, "set -g mouse off\nset-option -s set-clipboard off\nbind -n PPage copy-mode\nbind PPage copy-mode -u\n# set -g mouse off\n");
  const w = tc.conflictsIn([f, join(dir, "missing.conf")]);
  assert.equal(w.length, 3);
  assert.match(w[0], /other\.conf:1 에 mouse off/);
  assert.match(w[2], /:3 에 루트 PPage/);
});

test("undo: options are unset, keys go back to the default or are unbound, lines kept in the new block stay", () => {
  const oldLines = [tc.HEADER, "set -g mouse on", "set -s copy-command 'pbcopy'", tc.PAGE_UP, tc.FORCE_DRAG];
  const defaults = new Map([["root MouseDrag1Pane", "bind-key -T root MouseDrag1Pane copy-mode -M"]]);
  assert.deepEqual(tc.undoCommands(oldLines, [], defaults), ["set -gu mouse", "set -su copy-command", "unbind -T root PPage", "bind-key -T root MouseDrag1Pane copy-mode -M"]);
  assert.deepEqual(tc.undoCommands(oldLines, oldLines.slice(0, 4), defaults), ["bind-key -T root MouseDrag1Pane copy-mode -M"]);
  assert.deepEqual(tc.keysOf(oldLines).map((k) => `${k.table} ${k.key}`), ["root PPage", "root MouseDrag1Pane"]);
});

test("config files tmux reads: 3.1 and later add the XDG paths, older reads only ~/.tmux.conf", () => {
  const home = fresh();
  const v = (s) => tc.parseVersion(`tmux ${s}`);
  assert.deepEqual(tc.tmuxReads(v("2.7"), {}, home), [join(home, ".tmux.conf")]);
  assert.deepEqual(tc.tmuxReads(v("3.6a"), { XDG_CONFIG_HOME: join(home, "x") }, home), [join(home, ".tmux.conf"), join(home, "x", "tmux", "tmux.conf"), join(home, ".config", "tmux", "tmux.conf")]);
  mkdirSync(join(home, ".config", "tmux"), { recursive: true });
  writeFileSync(join(home, ".config", "tmux", "tmux.conf"), "");
  assert.equal(tc.chooseTmuxConf(v("3.6a"), {}, home, null), join(home, ".config", "tmux", "tmux.conf"));
  assert.equal(tc.chooseTmuxConf(v("2.7"), {}, home, null), join(home, ".tmux.conf"), "2.7 does not read the XDG file");
  assert.equal(tc.parseVersion("tmux next-3.7").major, 3);
  assert.equal(tc.parseVersion("tmux master").major, 99);
  assert.equal(tc.parseVersion("bash: tmux: not found"), null);
});

test("config files tmux reads: XDG_CONFIG_HOME through a link to ~/.config is one file, and names one file with it", () => {
  const home = fresh();
  const v = (s) => tc.parseVersion(`tmux ${s}`);
  mkdirSync(join(home, ".config", "tmux"), { recursive: true });
  const xdg = join(home, "xdg-link");
  symlinkSync(join(home, ".config"), xdg, "junction");
  assert.deepEqual(tc.tmuxReads(v("3.6a"), { XDG_CONFIG_HOME: xdg }, home), [join(home, ".tmux.conf"), join(xdg, "tmux", "tmux.conf")]);
  assert.equal(tc.sameFile(join(xdg, "tmux", "tmux.conf"), join(home, ".config", "tmux", "tmux.conf")), true, "not there yet");
  writeFileSync(join(home, ".config", "tmux", "tmux.conf"), "");
  assert.equal(tc.sameFile(join(xdg, "tmux", "tmux.conf"), join(home, ".config", "tmux", "tmux.conf")), true, "there");
  assert.equal(tc.sameFile(join(home, ".tmux.conf"), join(home, ".config", "tmux", "tmux.conf")), false);
});

test("alt-screen-probe: usage error without a log file", () => {
  const r = spawnSync(process.execPath, [join(HERE, "..", "..", "..", "scripts", "test-fixtures", "alt-screen-probe.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
