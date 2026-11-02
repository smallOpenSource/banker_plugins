/**
 * tmux-config: what tune-tmux knows about tmux and psmux. Tool and version detection, the clipboard command,
 * which config files are read, the block lines, conflicting lines in other files and the commands that take
 * block lines back out of a running server.
 *
 * Every function that runs a program takes `exec(cmd, args)` returning { status, stdout, stderr, error }, so the
 * tests can stand in for tmux on every OS. No network is used.
 */
import { accessSync, constants, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/** The tool and version in `tmux -V` output. psmux says "tmux 3.3.8" on line 1 and "psmux" on line 2. */
export function parseVersion(text) {
  const out = String(text ?? "");
  const first = out.split(/\r?\n/)[0].trim();
  if (!/^(tmux|psmux)\s/i.test(first)) return null;
  const kind = /psmux/i.test(out) ? "psmux" : "tmux";
  const m = /(\d+)\.(\d+)/.exec(first);
  return m ? { kind, major: Number(m[1]), minor: Number(m[2]), raw: first } : { kind, major: 99, minor: 0, raw: first };
}

/** Whether version v is at least major.minor. */
export const atLeast = (v, major, minor) => v.major > major || (v.major === major && v.minor >= minor);

/** The tool behind bin, or null when it does not run. */
export function toolVersion(exec, bin) {
  const r = exec(bin, ["-V"]);
  if (r.error || r.status !== 0) return null;
  const v = parseVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  return v ? { ...v, bin } : null;
}

/** The home folder psmux and tmux use: USERPROFILE first on Windows, HOME elsewhere. */
export function homeOf(env, platform) {
  const first = platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME;
  return first || homedir();
}

// Whether p is a file this user may run (Windows: any file).
function runnable(p, platform) {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The path of an executable name in env.PATH, or null. */
export function which(name, env, platform = process.platform) {
  const exts = platform === "win32" ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (runnable(p, platform)) return p;
    }
  }
  return null;
}

const CLIPBOARDS = [
  { tool: "pbcopy", cmd: "pbcopy", when: (o) => o.platform === "darwin" },
  { tool: "wl-copy", cmd: "wl-copy", when: (o) => Boolean(o.env.WAYLAND_DISPLAY) },
  { tool: "xclip", cmd: "xclip -selection clipboard -in", when: (o) => Boolean(o.env.DISPLAY) },
  { tool: "xsel", cmd: "xsel -ib", when: (o) => Boolean(o.env.DISPLAY) },
  { tool: "clip.exe", cmd: "clip.exe", when: (o) => Boolean(o.env.WSL_DISTRO_NAME || o.env.WSL_INTEROP) },
];

/** The OS clipboard command: macOS pbcopy, Wayland wl-copy, X11 xclip then xsel, WSL clip.exe; or null. */
export function pickClipboard({ platform, env, has }) {
  const hit = CLIPBOARDS.find((c) => c.when({ platform, env }) && has(c.tool));
  return hit ? { tool: hit.tool, cmd: hit.cmd } : null;
}

const exists = (p) => lstatSync(p, { throwIfNoEntry: false }) !== undefined;

// The path as the file system spells it (native first: the long name and the case on disk), a missing tail joined to
// its nearest existing folder so spelled.
function spelled(p) {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      const up = dirname(p);
      return up === p ? p : join(spelled(up), basename(p));
    }
  }
}

/**
 * Whether a and b name one file: device and inode (bigint) when both are there, else the spelled paths, case folded on
 * Windows and macOS. A string compare took a --conf in another case, through a linked XDG_CONFIG_HOME or an 8.3 name
 * for another file and warned wrongly.
 */
export function sameFile(a, b) {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    if (x.ino !== 0n && y.ino !== 0n) return x.dev === y.dev && x.ino === y.ino;
  } catch {
    // one is not there (yet): the spellings decide
  }
  const fold = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  return fold(spelled(resolve(a))) === fold(spelled(resolve(b)));
}

/** The config files tmux reads by itself, in order. Measured: 3.6a reads every one there; 2.7 only ~/.tmux.conf. */
export function tmuxReads(v, env, home) {
  const files = [join(home, ".tmux.conf")];
  if (v && !atLeast(v, 3, 1)) return files;
  if (env.XDG_CONFIG_HOME) files.push(join(env.XDG_CONFIG_HOME, "tmux", "tmux.conf"));
  files.push(join(home, ".config", "tmux", "tmux.conf"));
  return files.map((f) => resolve(f)).filter((f, i, all) => !all.slice(0, i).some((g) => sameFile(g, f)));
}

/** The tmux file for the block: --conf, else the first of tmuxReads that is there, else ~/.tmux.conf. */
export function chooseTmuxConf(v, env, home, conf) {
  if (conf) return resolve(conf);
  return tmuxReads(v, env, home).find(exists) ?? resolve(join(home, ".tmux.conf"));
}

/** psmux reads one file: -f, PSMUX_CONFIG_FILE, then the first there of these four (measured on psmux 3.3.8). */
function psmuxCandidates(home) {
  return [join(home, ".psmux.conf"), join(home, ".psmuxrc"), join(home, ".tmux.conf"), join(home, ".config", "psmux", "psmux.conf")];
}

export function choosePsmuxConf(env, home, conf) {
  if (conf) return resolve(conf);
  if (env.PSMUX_CONFIG_FILE) return resolve(env.PSMUX_CONFIG_FILE);
  return resolve(psmuxCandidates(home).find(exists) ?? join(home, ".psmux.conf"));
}

export const PAGE_UP = 'bind -n PPage if -F "#{||:#{alternate_on},#{pane_in_mode}}" "send-keys PPage" "copy-mode -eu"';
export const FORCE_DRAG = 'bind -n MouseDrag1Pane if -F "#{pane_in_mode}" "send-keys -M" "copy-mode -M"';
export const HEADER = "# banker tune-tmux: mouse drag copy and PageUp scroll. Remove with: tune-tmux off";

// The lines that send a finished mouse selection to the OS clipboard, for this version.
function copyLines(v, clipboard) {
  if (!clipboard) return { lines: [], omitted: [{ what: "copy-command", reason: "외부 클립보드 도구 없음, 터미널의 OSC 52 허용 필요" }] };
  if (atLeast(v, 3, 2)) return { lines: [`set -s copy-command '${clipboard.cmd}'`], omitted: [] };
  if (atLeast(v, 2, 4)) {
    const pipe = (t) => `bind -T ${t} MouseDragEnd1Pane send -X copy-pipe-and-cancel '${clipboard.cmd}'`;
    return { lines: [pipe("copy-mode"), pipe("copy-mode-vi")], omitted: [] };
  }
  return { lines: [], omitted: [{ what: "copy-pipe", reason: `tmux ${v.major}.${v.minor} 는 send -X 가 없음(2.4 이상 필요)` }] };
}

/** The tmux block: { lines, omitted }. conditional is whether #{||:} works (probeConditional). */
export function tmuxBody({ version, clipboard, conditional, forceDrag }) {
  const copy = copyLines(version, clipboard);
  const lines = [HEADER, "set -g mouse on", "set -s set-clipboard on", ...copy.lines];
  const omitted = [...copy.omitted];
  if (conditional) lines.push(PAGE_UP);
  else omitted.push({ what: "PageUp", reason: "이 tmux 는 #{||:} 조건식을 읽지 못함. PageUp 줄을 넣으면 전체 화면 앱의 PageUp 을 빼앗으므로 넣지 않음" });
  if (forceDrag) lines.push(FORCE_DRAG);
  return { lines, omitted };
}

/** The psmux block from the caps table: verified lines psmux does not already have. Empty means no block. */
export function psmuxBody(caps, forceDrag) {
  const wanted = caps.options.filter((o) => !o.forceDrag || forceDrag);
  const lines = wanted.filter((o) => o.verified === true && o.default !== true).map((o) => o.line);
  const omitted = wanted
    .filter((o) => !(o.verified === true && o.default !== true))
    .map((o) => ({ what: o.id, reason: o.default === true ? `psmux 기본값과 같음: ${o.note}` : `psmux ${caps.psmux} 에서 확인 안 됨: ${o.note}` }));
  return { lines: lines.length > 0 ? [HEADER, ...lines] : [], omitted, behavior: psmuxBehavior(caps) };
}

/** What psmux does with its defaults: { default, unverified, broken } lists of text (empty when caps has none). */
function psmuxBehavior(caps) {
  const b = caps.behavior ?? {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return { default: list(b.default), unverified: list(b.unverified), broken: list(b.broken) };
}

// The socket file of a private server, removed after kill-server (tmux leaves it behind; measured 2.7 and 3.6a).
function removeSocket(path, sock) {
  if (!path || basename(path) !== sock) return;
  if (lstatSync(path, { throwIfNoEntry: false })?.isSocket()) rmSync(path, { force: true });
}

/** Runs fn(sock) against a private server started with no config, then kills it: { value } or { error }. */
function withPrivateServer(exec, bin, fn) {
  const sock = `banker-tune-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const up = exec(bin, ["-L", sock, "-f", devNull, "new-session", "-d", "-s", "probe", "-x", "80", "-y", "24"]);
  if (up.error || up.status !== 0) return { error: `사설 서버를 띄우지 못함: ${firstLine(up)}` };
  const path = String(exec(bin, ["-L", sock, "display-message", "-p", "-t", "probe", "#{socket_path}"]).stdout ?? "").trim();
  try {
    return { value: fn(sock) };
  } finally {
    exec(bin, ["-L", sock, "kill-server"]);
    removeSocket(path, sock);
  }
}

/** Whether #{||:} works, asked of a private server: { ok, reason? }. */
export function probeConditional(exec, bin) {
  const r = withPrivateServer(exec, bin, (sock) => exec(bin, ["-L", sock, "display-message", "-p", "-t", "probe", "#{||:0,1}#{||:0,0}"]));
  if (r.error) return { ok: false, reason: r.error };
  return { ok: r.value.status === 0 && String(r.value.stdout).trim() === "10" };
}

export const firstLine = (r) => String(r.error?.message || r.stderr || r.stdout || "").trim().split(/\r?\n/)[0];

const CONFLICTS = [
  { what: "mouse off", test: (t) => isSet(t, "mouse", "off") },
  { what: "set-clipboard off", test: (t) => isSet(t, "set-clipboard", "off") },
  { what: "루트 PPage 바인딩", test: (t) => isRootBind(t, "PPage") },
];
const isSet = (t, name, value) => ["set", "set-option"].includes(t[0]) && t.indexOf(name) > 0 && t[t.indexOf(name) + 1] === value;
const isRootBind = (t, key) => ["bind", "bind-key"].includes(t[0]) && (t.includes("-n") || t[t.indexOf("-T") + 1] === "root") && t.includes(key);

/** Warnings for lines in other files tmux reads that undo the block (mouse off, set-clipboard off, PPage). */
export function conflictsIn(files) {
  const warnings = [];
  for (const file of files) {
    let text;
    try {
      if (!statSync(file).isFile() || statSync(file).size > 1024 * 1024) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim().split(/\s+/);
      for (const c of CONFLICTS) if (c.test(t)) warnings.push(`경고: ${file}:${i + 1} 에 ${c.what}. tmux 가 이 파일도 읽으므로 블록보다 나중에 읽히면 블록 설정을 덮음`);
    });
  }
  return warnings;
}

/** The body lines of the block in text (marker lines excluded), or [] when there is none. */
export function blockLinesOf(text, mk) {
  const lines = String(text).replace(/^\u{FEFF}/u, "").split(/\r?\n/);
  const first = lines.findIndex((l) => l.trimEnd() === mk.start);
  const last = lines.findIndex((l) => l.trimEnd() === mk.end);
  return first !== -1 && last > first ? lines.slice(first + 1, last) : [];
}

// What a block line changes: an option ({ scope, name }) or a key ({ table, key }), or null for a comment.
function effectOf(line) {
  const set = /^set\s+-([gs])\s+(\S+)\s/.exec(line);
  if (set) return { id: `opt:${set[1]}:${set[2]}`, undo: `set -${set[1]}u ${set[2]}` };
  const bind = /^bind\s+(?:-n|-T\s+(\S+))\s+(\S+)\s/.exec(line);
  if (bind) return { id: `key:${bind[1] ?? "root"}:${bind[2]}`, table: bind[1] ?? "root", key: bind[2] };
  return null;
}

// The list-keys lines of the keys asked, from tables of a private server.
function readKeys(exec, bin, sock, keys) {
  const found = new Map(keys.map((k) => [`${k.table} ${k.key}`, null]));
  for (const table of new Set(keys.map((k) => k.table))) {
    for (const line of String(exec(bin, ["-L", sock, "list-keys", "-T", table]).stdout ?? "").split(/\r?\n/)) {
      const m = /^bind-key\s+(?:-r\s+)?-T\s+(\S+)\s+(\S+)\s/.exec(line);
      if (m && found.has(`${m[1]} ${m[2]}`)) found.set(`${m[1]} ${m[2]}`, line.trim());
    }
  }
  return found;
}

/** The default bindings of a fresh private server for the keys asked: Map "table key" -> list-keys line or null. */
export function defaultKeys(exec, bin, keys) {
  if (keys.length === 0) return new Map();
  const r = withPrivateServer(exec, bin, (sock) => readKeys(exec, bin, sock, keys));
  return r.value ?? new Map();
}

/**
 * The commands that take the effect of oldLines out of a server when newLines replace them: options are unset,
 * keys get their default binding back (from defaults) or are unbound. Lines also in newLines are left alone.
 */
export function undoCommands(oldLines, newLines, defaults) {
  const kept = new Set(newLines.map(effectOf).filter(Boolean).map((e) => e.id));
  const gone = oldLines.map(effectOf).filter((e) => e && !kept.has(e.id));
  return gone.map((e) => e.undo ?? defaults.get(`${e.table} ${e.key}`) ?? `unbind -T ${e.table} ${e.key}`);
}

/** The keys among block lines, for defaultKeys. */
export const keysOf = (lines) => lines.map(effectOf).filter((e) => e?.key);
