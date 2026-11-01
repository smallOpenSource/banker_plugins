// tune-tmux with real tmux (plan 4.4, US-4 acceptance 3, 7, 8). Each tmux found on this machine runs on private
// servers only (`-L tt-<pid>-<n>`), started with -f /dev/null and killed at the end; the user's tmux server and
// ~/.tmux.conf are never touched. HOME is a temp folder.
//
// Keys are sent the way a terminal sends them: an outer private server runs the inner server's client in a pane,
// and `send-keys` to that pane writes the PageUp/PageDown bytes the client reads. (tmux 3.6a `send-keys -K` was
// tried first: for an unbound PageDown it wrote "k" to the pane instead of the key, so it does not show what a
// user gets. The pane path also runs on tmux older than 3.4, which has no -K.)
// Run: node --test skills/tune-tmux/scripts/tmux-it.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as tc from "./tmux-config.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "tune-tmux.mjs");
const PROBE = join(HERE, "..", "..", "..", "scripts", "test-fixtures", "alt-screen-probe.mjs");
// macOS picks pbcopy before any xclip on PATH (tmux-config clipboard order), so the expected command follows the OS.
const CLIP = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard -in";
const base = mkdtempSync(join(tmpdir(), "tune-tmux-it-"));
const servers = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every distinct tmux on PATH and in the usual places, by real path.
function tmuxBinaries() {
  const dirs = [...String(process.env.PATH ?? "").split(delimiter), "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"];
  const found = new Map();
  for (const d of dirs.filter(Boolean)) {
    const p = join(d, "tmux");
    try {
      if (!statSync(p).isFile()) continue;
      const v = tc.parseVersion(spawnSync(p, ["-V"], { encoding: "utf8" }).stdout);
      if (v?.kind === "tmux" && !found.has(realpathSync(p))) found.set(realpathSync(p), { bin: realpathSync(p), v });
    } catch {
      // not here
    }
  }
  return [...found.values()];
}
const BINARIES = process.platform === "win32" ? [] : tmuxBinaries();

let n = 0;
// A temp HOME and bin folder whose `tmux` is bin, with a fake xclip so the block has a clipboard command.
function sandbox(bin) {
  const root = join(base, `s${n++}`);
  const home = join(root, "home");
  const tools = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(tools);
  symlinkSync(bin, join(tools, "tmux"));
  writeFileSync(join(tools, "xclip"), "#!/bin/sh\ncat >/dev/null\n");
  chmodSync(join(tools, "xclip"), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin`, DISPLAY: ":99", SHELL: "/bin/sh" };
  for (const k of ["TMUX", "TMUX_PANE", "XDG_CONFIG_HOME", "WAYLAND_DISPLAY", "WSL_DISTRO_NAME", "WSL_INTEROP", "TMUX_TMPDIR"]) delete env[k];
  const sock = () => {
    const s = `tt-${process.pid}-${n++}`;
    servers.add({ bin, env, s });
    return s;
  };
  const tmux = (s, ...args) => spawnSync(bin, ["-L", s, ...args], { encoding: "utf8", env });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { root, home, env, sock, tmux, cli, exec: (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env }) };
}

// Kills every private server and removes its socket file (tmux leaves it behind after kill-server).
after(() => {
  const dir = join("/tmp", `tmux-${process.getuid?.()}`);
  for (const { bin, env, s } of servers) {
    spawnSync(bin, ["-L", s, "kill-server"], { env });
    if (lstatSync(join(dir, s), { throwIfNoEntry: false })?.isSocket()) rmSync(join(dir, s));
  }
  rmSync(base, { recursive: true, force: true });
});

async function waitFor(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`시간 안에 안 됨: ${what}`);
    await sleep(50);
  }
}

const out = (r) => String(r.stdout).trim();
const rootKey = (sb, s, key) => out(sb.tmux(s, "list-keys", "-T", "root")).split("\n").find((l) => l.split(/\s+/)[3] === key) ?? "";
const norm = (line) => line.replace(/\s+/g, " ").trim();
const defaultOf = (sb, bin, table, key) => tc.defaultKeys(sb.exec, bin, [{ table, key }]).get(`${table} ${key}`) ?? "";

// Starts a private server with no config, sources conf into it, and returns its socket name.
function serverWith(sb, conf) {
  const s = sb.sock();
  assert.equal(sb.tmux(s, "-f", devNull, "new-session", "-d", "-s", "i", "-x", "100", "-y", "30").status, 0);
  if (conf) assert.equal(sb.tmux(s, "source-file", conf).status, 0, "block config sources without error");
  return s;
}

const SKIP = BINARIES.length === 0 ? (process.platform === "win32" ? "Windows: tmux 없음(psmux 실측은 SKILL.md 출처, OS 고유)" : "tmux 없음(도구 부족: 이 OS 에 tmux 를 마련해야 함)") : false;
if (SKIP) test("tmux integration", { skip: SKIP }, () => {});

// Acceptance 3: the files tmux reads by itself (measured with a user option in each), and the conflict warning.
function configFilesRead(bin, v) {
  const sb = sandbox(bin);
  const xdg = join(sb.root, "xdg");
  const files = { a: join(sb.home, ".tmux.conf"), b: join(sb.home, ".config", "tmux", "tmux.conf"), c: join(xdg, "tmux", "tmux.conf") };
  for (const [k, f] of Object.entries(files)) {
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, `set -g @banker_${k} 1\n`);
  }
  const env = { ...sb.env, XDG_CONFIG_HOME: xdg };
  const s = sb.sock();
  assert.equal(spawnSync(bin, ["-L", s, "new-session", "-d", "-s", "m"], { env }).status, 0);
  const reads = tc.tmuxReads(v, env, sb.home);
  for (const [k, f] of Object.entries(files)) {
    const value = out(sb.tmux(s, "show", "-gv", `@banker_${k}`));
    assert.equal(value === "1", reads.includes(f), `${f}: tmux ${value === "1" ? "reads" : "does not read"} it`);
  }
  writeFileSync(files.b, "set -g mouse off\n");
  const st = JSON.parse(sb.cli("status", "--target", "tmux", "--json").stdout);
  assert.equal(st.conf, files.a);
  assert.equal(st.warnings.some((w) => w.includes(files.b) && w.includes("mouse off")), reads.includes(files.b));
}

// Acceptance 7: the block sourced into a private server gives the expected bindings and options.
function blockLines(bin, v) {
  const sb = sandbox(bin);
  const on = sb.cli("on", "--target", "tmux");
  assert.equal(on.status, 0, on.stderr);
  const s = serverWith(sb, join(sb.home, ".tmux.conf"));
  assert.match(rootKey(sb, s, "PPage"), /if-shell -F "#\{\|\|:#\{alternate_on\},#\{pane_in_mode\}\}" "send-keys PPage" "copy-mode -eu"/);
  assert.equal(out(sb.tmux(s, "show", "-gv", "mouse")), "on");
  if (tc.atLeast(v, 3, 2)) assert.equal(out(sb.tmux(s, "show", "-sv", "copy-command")), CLIP);
  else assert.match(out(sb.tmux(s, "list-keys", "-T", "copy-mode")), new RegExp(`MouseDragEnd1Pane\\s+send-keys -X copy-pipe-and-cancel "${CLIP}"`));
  assert.equal(norm(rootKey(sb, s, "MouseDrag1Pane")), norm(defaultOf(sb, bin, "root", "MouseDrag1Pane")), "MouseDrag1Pane stays the default");
}

// Acceptance 7: only --force-drag changes the root MouseDrag1Pane binding.
function forceDrag(bin) {
  const sb = sandbox(bin);
  assert.equal(sb.cli("on", "--target", "tmux", "--force-drag").status, 0);
  const s = serverWith(sb, join(sb.home, ".tmux.conf"));
  const line = rootKey(sb, s, "MouseDrag1Pane");
  assert.match(line, /if-shell -F "#\{pane_in_mode\}" "send-keys -M" "copy-mode -M"/);
  assert.notEqual(norm(line), norm(defaultOf(sb, bin, "root", "MouseDrag1Pane")));
}

// An inner server with the block and more than a page of history, attached as a real client inside an outer one.
async function realClient(bin) {
  const sb = sandbox(bin);
  assert.equal(sb.cli("on", "--target", "tmux").status, 0);
  const inner = serverWith(sb, join(sb.home, ".tmux.conf"));
  sb.tmux(inner, "send-keys", "-t", "i", "seq 1 500", "Enter");
  await waitFor("seq 출력", () => /^500$/m.test(out(sb.tmux(inner, "capture-pane", "-p", "-t", "i"))));
  const outer = sb.sock();
  const attach = `exec env -u TMUX ${bin} -L ${inner} attach -t i`;
  assert.equal(sb.tmux(outer, "-f", devNull, "new-session", "-d", "-s", "o", "-x", "120", "-y", "40", attach).status, 0);
  await waitFor("안쪽 클라이언트", () => out(sb.tmux(inner, "list-clients")));
  const state = (t = "i") => out(sb.tmux(inner, "display-message", "-p", "-t", t, "#{pane_in_mode} #{scroll_position}")).split(" ");
  return { sb, inner, state, key: (k) => sb.tmux(outer, "send-keys", "-t", "o", k) };
}

// Acceptance 7: on the normal screen PageUp enters copy-mode and scrolls; PageDown scrolls back and leaves at the bottom.
async function pageKeys(bin) {
  const { state, key } = await realClient(bin);
  key("PPage");
  const [, p1] = await waitFor("PageUp 으로 copy-mode", () => (state()[0] === "1" ? state() : null));
  assert.ok(Number(p1) > 0, `scroll_position ${p1}`);
  key("PPage");
  const p2 = Number((await waitFor("두 번째 PageUp", () => (Number(state()[1]) > Number(p1) ? state() : null)))[1]);
  key("NPage");
  await waitFor("PageDown 으로 줄어듦", () => state()[0] === "1" && Number(state()[1]) < p2);
  for (let i = 0; i < 20 && state()[0] === "1"; i++) {
    key("NPage");
    await sleep(100);
  }
  assert.equal(state()[0], "0", "PageDown at the bottom leaves copy-mode");
}

// Acceptance 7: an alternate-screen app that grabs the mouse gets PageUp and PageDown; tmux stays out of copy-mode.
async function altScreenApp(bin) {
  const { sb, inner, state, key } = await realClient(bin);
  const log = join(sb.root, "alt.log");
  sb.tmux(inner, "new-window", "-t", "i", "-n", "alt", `${process.execPath} ${PROBE} ${log} --mouse --seconds 30`);
  await waitFor("alternate screen", () => out(sb.tmux(inner, "display-message", "-p", "-t", "i:alt", "#{alternate_on}")) === "1");
  key("PPage");
  key("NPage");
  await waitFor("앱이 PageUp, PageDown 받음", () => {
    const got = readFileSync(log, "latin1");
    return got.includes("\x1b[5~") && got.includes("\x1b[6~");
  });
  assert.equal(state("i:alt")[0], "0", "tmux stays out of copy-mode for the app");
}

// Acceptance 8: --reload on a running server, including dropping --force-drag and off bringing user lines back.
function reloadRunning(bin, v) {
  const sb = sandbox(bin);
  const conf = join(sb.home, ".tmux.conf");
  writeFileSync(conf, "set -g @user_opt 1\nset -g mouse on\n");
  const s = serverWith(sb, null);
  const reload = (...args) => {
    const r = sb.cli(...args, "--target", "tmux", "--reload", "--socket", s, "--json");
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).reload;
  };
  assert.equal(reload("on", "--force-drag").state, "reloaded");
  assert.match(rootKey(sb, s, "PPage"), /copy-mode -eu/);
  assert.match(rootKey(sb, s, "MouseDrag1Pane"), /"#\{pane_in_mode\}"/);
  reload("on");
  assert.equal(norm(rootKey(sb, s, "MouseDrag1Pane")), norm(defaultOf(sb, bin, "root", "MouseDrag1Pane")), "dropping --force-drag restores the default");
  reload("off");
  assert.equal(rootKey(sb, s, "PPage"), "");
  assert.equal(out(sb.tmux(s, "show", "-gv", "@user_opt")), "1");
  assert.equal(out(sb.tmux(s, "show", "-gv", "mouse")), "on", "the user's own mouse line is back");
  if (tc.atLeast(v, 3, 2)) assert.equal(out(sb.tmux(s, "show", "-sv", "copy-command")), "");
  else {
    const line = out(sb.tmux(s, "list-keys", "-T", "copy-mode")).split("\n").find((l) => l.includes("MouseDragEnd1Pane")) ?? "";
    assert.equal(norm(line), norm(defaultOf(sb, bin, "copy-mode", "MouseDragEnd1Pane")));
  }
  assert.equal(readFileSync(conf, "utf8"), "set -g @user_opt 1\nset -g mouse on\n");
}

const CASES = [
  ["acceptance 3: which config files tmux reads, and status warns about mouse off only in a file it reads", configFilesRead],
  ["acceptance 7: block lines on a private server", blockLines],
  ["acceptance 7: --force-drag changes MouseDrag1Pane", forceDrag],
  ["acceptance 7: PageUp and PageDown through a real client on the normal screen", pageKeys],
  ["acceptance 7: an alternate-screen app gets PageUp and PageDown", altScreenApp],
  ["acceptance 8: --reload puts the block in and takes it out of a running server", reloadRunning],
];

for (const { bin, v } of BINARIES) {
  describe(`tmux ${v.raw} (${bin})`, () => {
    for (const [title, fn] of CASES) test(`${title} (tmux ${v.major}.${v.minor})`, () => fn(bin, v));
  });
}
