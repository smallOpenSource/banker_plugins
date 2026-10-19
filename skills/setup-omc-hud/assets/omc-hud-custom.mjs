#!/usr/bin/env node
/**
 * OMC HUD custom formatter (wrapper) — v4
 *
 * Runs the canonical OMC HUD (omc-hud.mjs), then reformats its rendered line
 * into a compact pipe-delimited layout requested by the user:
 *
 *   <model>/<effort>|5h:<pct>/<reset>|wk:<pct>/<reset>|<mm>:<pct>/<reset>|think|PL:<mb>M|se:<hours>h|ctx:<pct>%|🤖<agents>|🔧<tools>|⚡<skills>|<cwd>|<account>|<branch>|claude<cur>→<new>
 *   e.g. Op5.5/high|5h:8%/1h23m|wk:96%/1h23m|Fa:0%/1h23m|think|PL:0.4M|se:0.4h|ctx:12%|🤖1|🔧14|⚡3|...
 *
 * Changes vs v3:
 *   - OMC 5.x wraps at the terminal width; the width is hidden from OMC and the
 *     wrapper wraps the compact line itself at segment boundaries (no "…").
 *   - effort:<level> badge dropped; session -> se:<hours, 1 decimal>h.
 *   - ctx:<pct>% comes right after se, without OMC's " COMPRESS?" / " CRITICAL"
 *     words (the color shows the level).
 *   - OMC's call counts ("🔧14 🤖1 ⚡3") are shown agents, tools, skills, one
 *     segment each: 🤖1|🔧14|⚡3. A count OMC leaves out (zero) stays out.
 *   - per-model usage badge (fable:0%(1h31m)) -> Fa:0%/1h31m, after the rate windows.
 *   - PL:<MB, 1 decimal>M always shown before se. It reads payload-mon's module
 *     copy next to this file (hud/payload-mon/payload-size.mjs); without it PL
 *     is left out.
 *   - cwd group split on "|"; branch shown without "branch:" after the account.
 *   - OMC#X.Y.Z label no longer shown, nor OMC's update hint lines
 *     ("[!] omc X - paste: ! ...", "[!] claude X - paste: ! claude update").
 *   - Claude Code update notice "[Claude#2.1.300] -> 2.1.302 claude update" ->
 *     "claude2.1.300→2.1.302", shown last. A claude-update-last block has
 *     nothing left to move.
 *   - >=85% is pink (256-color 213) instead of red.
 *   - Blocks added by `payload-mon on` / `claude-update-last on` are not part of
 *     this file; those tools insert them.
 *
 * Why a wrapper: OMC's render.js hardcodes " | " separators, the "[...]" label
 * brackets, the "Model: " prefix, the "percent(time)" rate layout and the
 * "session:Nm" label. None are configurable, so we transform the final text.
 * All data (usage %, reset times, tool counts, cwd) still comes from OMC.
 *
 * Defensive: on any parse failure it prints OMC's raw output unchanged, so the
 * statusline never breaks if OMC's format changes after an update.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Changes vs v1 (formatting logic below is byte-identical to v1 on purpose):
 *
 *   1. The canonical HUD runs IN THIS PROCESS instead of via spawnSync, so a
 *      statusline refresh costs one node process instead of two. Windows charges
 *      kernel paged pool per process creation (fltmgr FMfn name-cache node), and
 *      on this machine that accumulation is not reclaimable short of a reboot.
 *
 *   2. Every unbounded wait now has a time budget. v1 could block forever in two
 *      places with no timeout: readFileSync(0) waiting for stdin EOF, and
 *      spawnSync waiting on the child. Both are SYNCHRONOUS, so a setTimeout
 *      watchdog cannot fire while they block — the event loop is not running.
 *      A stalled instance never dies, and the next refresh spawns another, so
 *      they accumulate linearly. Both are now async and bounded.
 *
 * Timer discipline comes from a 3-OS reproduction documented in
 * .omc/wiki/bounding-a-hanging-dynamic-import-in-node.md:
 *   - the budget timer stays REF'd: an unref'd timer never fires when Node bails
 *     out of an unsettled top-level await with exit 13,
 *   - the self-exit timer is UNREF'd: it must not hold a healthy process open,
 *     and when something really is hung the loop is alive so it still fires,
 *   - the budget is 10s, not 3s: a tight budget silently discards work that was
 *     merely slow, without saving any time (the hung import holds the loop anyway).
 *
 * 🔴 omc-hud.mjs ends with a bare `main();` — no await. Module evaluation
 *    therefore completes BEFORE any output is produced. Awaiting the import
 *    alone captures nothing (that is why v2 printed "[OMC HUD] no output").
 *    We wait for the first complete line instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUD = join(__dirname, "omc-hud.mjs");

const STDIN_TIMEOUT_MS = 2000; // Claude Code pipes the payload immediately
const RENDER_TIMEOUT_MS = 10000; // see timer discipline note above
const SPAWN_TIMEOUT_MS = 8000; // fallback path only
const EXIT_GRACE_MS = 2000;
const HARD_EXIT_MS = 20000;

// Last-resort guard: if any path leaves us alive past this, end voluntarily.
// unref'd so a healthy render is never held open by it.
{
  const g = setTimeout(() => {
    try {
      process.stdout.write("\n");
    } catch {
      /* stdout already gone */
    }
    process.exit(0);
  }, HARD_EXIT_MS);
  if (g && g.unref) g.unref();
}

// Print and terminate. The canonical HUD ran in-process, so its own async work
// may still be pending on the event loop; once our line is out there is nothing
// left to wait for. The write callback is the flush-safe exit point, and the
// unref'd timer covers the case where the callback never arrives.
// Only the first call prints: the fallback path may emit and then fall through
// to the formatter, whose passthrough catch would print a second line.
let emitted = false;
function emit(s) {
  if (emitted) return;
  emitted = true;
  try {
    process.stdout.write(s, () => process.exit(0));
  } catch {
    process.exit(0);
  }
  const k = setTimeout(() => process.exit(0), EXIT_GRACE_MS);
  if (k && k.unref) k.unref();
}

// Currently logged-in Claude account: the part of the email before "@".
// Read from <config home>/.claude.json (oauthAccount.emailAddress) via a light
// regex so we don't JSON.parse the whole config every render. Claude Code keeps
// that file in $CLAUDE_CONFIG_DIR when set, otherwise in the home folder.
function claudeJsonDir() {
  const v = (process.env.CLAUDE_CONFIG_DIR || "").trim();
  if (!v) return homedir();
  if (v === "~") return homedir();
  if (v.startsWith("~/") || v.startsWith("~\\")) return join(homedir(), v.slice(2));
  return v;
}
function loginAccount() {
  try {
    const raw = readFileSync(join(claudeJsonDir(), ".claude.json"), "utf8");
    const m = raw.match(/"emailAddress"\s*:\s*"([^"@]+)@/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// Read the statusline JSON Claude Code pipes on stdin, bounded.
// A TTY means a human ran this by hand — there is no EOF coming, so skip it
// entirely rather than hang waiting for one.
function readStdinBounded(ms) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const onData = (c) => {
      data += c;
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", finish);
      process.stdin.removeListener("error", finish);
      try {
        process.stdin.pause();
      } catch {
        /* already closed */
      }
      resolve(data);
    };
    const t = setTimeout(finish, ms); // ref'd on purpose
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onData);
      process.stdin.once("end", finish);
      process.stdin.once("error", finish);
    } catch {
      finish();
    }
  });
}

const input = await readStdinBounded(STDIN_TIMEOUT_MS);

// Current reasoning effort level (low/medium/high/xhigh) from the statusline
// payload (effort.level) — shown next to the model. Empty if absent.
let effort = "";
try {
  effort = String(JSON.parse(input)?.effort?.level || "");
} catch {
  /* no/invalid stdin JSON */
}

// Run the canonical HUD in-process, capturing what it writes to stdout.
// Resolves on the first complete line (see the `main();` note in the header),
// or when the budget expires — whichever comes first.
//
// 🔴 The HUD DOES read stdin — dist/hud/stdin.js readStdin() async-iterates
//    process.stdin (it is not readFileSync(0)). We already drained the real fd,
//    so without replaying the payload the HUD sees empty input and prints its
//    "HUD installed / statusLine configured" info screen instead of a
//    statusline. Swapping process.stdin for a stream carrying the same bytes
//    restores identical behaviour to the spawnSync path, which fed the child
//    through its stdin.
async function renderInProcess(ms) {
  const origWrite = process.stdout.write.bind(process.stdout);
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  let captured = "";
  let settleFirstLine;
  const firstLine = new Promise((r) => {
    settleFirstLine = r;
  });

  const replay = Readable.from(input ? [input] : []);
  replay.isTTY = false; // must stay falsy or readStdin() bails out early
  try {
    Object.defineProperty(process, "stdin", { value: replay, configurable: true });
  } catch {
    /* leave the real stdin in place; the fallback path still works */
  }

  process.stdout.write = (chunk, enc, cb) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") done();
    if (captured.includes("\n")) settleFirstLine();
    return true;
  };

  let budgetTimer;
  const budget = new Promise((r) => {
    budgetTimer = setTimeout(r, ms); // ref'd on purpose
  });

  try {
    await Promise.race([
      (async () => {
        await import(pathToFileURL(HUD).href);
        await firstLine;
      })(),
      budget,
    ]);
  } finally {
    clearTimeout(budgetTimer);
    process.stdout.write = origWrite;
    // Restore the real stdin so the spawnSync fallback below behaves normally.
    if (origStdin) {
      try {
        Object.defineProperty(process, "stdin", origStdin);
      } catch {
        /* not restorable; we exit right after anyway */
      }
    }
  }
  return captured;
}

// OMC 5.x wraps its line at the terminal width (index.js: stderr/stdout
// columns, then $COLUMNS). Wrapped tails land below the OMC# line, where this
// wrapper passes them through raw ("session:9m | ctx:12% | 🔧12"). The wrapper
// does its own compaction, so hide the width and let OMC emit one line.
// The width is read first: the wrapper wraps the compact line itself at the
// end, so Claude Code does not cut the tail off with "…".
const TERM_COLS =
  process.stderr.columns || process.stdout.columns || parseInt(process.env.COLUMNS ?? "0", 10) || 0;
delete process.env.COLUMNS; // also keeps the spawnSync fallback unwrapped
for (const s of [process.stdout, process.stderr]) {
  try {
    Object.defineProperty(s, "columns", { value: undefined, configurable: true });
  } catch {
    /* not overridable; OMC may wrap and the tail stays below */
  }
}

let raw = "";
try {
  raw = (await renderInProcess(RENDER_TIMEOUT_MS)).replace(/\r/g, "");
} catch {
  raw = ""; // fall through to the child-process path
}

if (!raw.trim()) {
  // In-process rendering produced nothing usable. Fall back to the original
  // out-of-process path: it costs an extra node, but a statusline that renders
  // beats one that does not — e.g. if a future OMC version stops being
  // import-safe. Bounded, unlike v1.
  const res = spawnSync(process.execPath, [HUD], {
    input,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  raw = (res.stdout || "").replace(/\r/g, "");
  if (!raw.trim()) {
    emit(((res.stderr || "").trim() || "[OMC HUD] no output") + "\n");
  }
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Terminal columns of a string: ANSI is free, CJK and emoji take two columns,
// variation selectors and ZWJ take none.
const WRAP_MARGIN = 4;
// BMP emoji drawn two columns wide (East Asian Width W), e.g. ⚡ in OMC's call counts.
const WIDE_BMP_EMOJI = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];
const visibleWidth = (s) => {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0);
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      WIDE_BMP_EMOJI.some(([lo, hi]) => c >= lo && c <= hi) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      c >= 0x20000;
    w += wide ? 2 : 1;
  }
  return w;
};

// Color helpers — we strip OMC's ANSI to parse, then re-apply our own so the
// statusline is highlighted. Threshold scale (usage/context %): green<70,
// yellow<85, pink>=85 (pink replaces red on request). Pipes and path are
// dimmed; model name cyan, effort yellow.
const A = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const SEP = "\x1b[2m|\x1b[0m";
const PINK = "38;5;213";
const pc = (n) => (n >= 85 ? PINK : n >= 70 ? "33" : "32");
const colorRate = (seg) => {
  const m = seg.match(/^(\w+):(\d+)%\/(.+)$/);
  return m ? `${m[1]}:${A(pc(+m[2]), m[2] + "%")}\x1b[2m/\x1b[0m${A("36", m[3])}` : seg;
};
const colorCtx = (seg) => {
  const m = seg.match(/^ctx:(\d+)%$/);
  return m ? `ctx:${A(pc(+m[1]), m[1] + "%")}` : seg;
};
const colorModel = (seg) => {
  const m = seg.match(/^(.+?)\/(\w+)$/);
  return m ? `${A("36", m[1])}\x1b[2m/\x1b[0m${A("33", m[2])}` : A("36", seg);
};
const colorSe = (seg) => {
  const m = seg.match(/^se:(.+)$/);
  return m ? `se:${A("33", m[1])}` : seg;
};
// Per-model usage badge ("fable:0%") rides along in the rate group and has no
// dedicated field. Shorten the model name to two letters so it matches the
// model token's own convention (Opus 4.8 -> Op4.8): fable:0% -> Fa:0%.
// OMC appends a stale marker and/or a reset time to scoped weekly buckets
// (renderRateLimits in dist/hud/elements/limits.js), so the pattern must not
// anchor at "%": keep that tail intact -> fable:0%(3d3h) -> Fa:0%(3d3h).
const shortModelPct = (seg) => {
  const m = seg.match(/^([A-Za-z][A-Za-z0-9.-]*):(\d+%\*?(?:\([^)]*\))?)$/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1, 2).toLowerCase()}:${m[2]}` : seg;
};

try {
  const lines = raw.split("\n").map(stripAnsi).filter((l) => l.length);
  const mainIdx = lines.findIndex((l) => l.includes("OMC#"));
  if (mainIdx === -1) throw new Error("no OMC line");

  const main = lines[mainIdx];
  const pathLine = lines.slice(0, mainIdx).join(" ").trim(); // cwd (+git) group above
  // Detail lines (agent tree, warnings) are kept as-is, except OMC's update
  // hints ("[!] omc 5.7.5 - paste: ! claude plugin ...", "[!] claude 2.1.302 -
  // paste: ! claude update"): the OMC version is not wanted here, and the Claude
  // Code update already shows as claude<cur>→<new> on the main line.
  const UPDATE_HINT = /^\[!\] (?:omc|claude) \S+ - paste: /;
  const below = lines.slice(mainIdx + 1).filter((l) => !UPDATE_HINT.test(l.trim()));

  // Collapse " | " -> "|", then split into segments.
  const rawSegs = main
    .replace(/\s*\|\s*/g, "|")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  // The 5h/wk/sn rate windows live in one space-separated segment; expand them.
  // The per-model usage badge ("fable:0%") arrives inside that same segment, so
  // remember which pieces came from there. Only those get abbreviated later —
  // unrelated badges that also land in `extra` must be left alone.
  const segs = [];
  const rateGroup = new Set();
  // OMC's Claude Code update notice ("[Claude#2.1.300] -> 2.1.302 claude update",
  // render.js claudeLabel) is shortened to "claude2.1.300→2.1.302" and shown last.
  // It is taken out of segs, so a claude-update-last block (which looks for the
  // long form in segs) finds nothing to move.
  const UPDATE_NOTICE = /^\[Claude(?:#([^\]]*))?\]\s*->\s*(\S+)\s+claude\s+update\b/;
  let update = "";
  for (const s of rawSegs) {
    const um = s.match(UPDATE_NOTICE);
    if (um) {
      update = `claude${um[1] || ""}→${um[2]}`;
    } else if (/\b(5h|wk|sn):/.test(s) && /\s/.test(s)) {
      for (const p of s.split(/\s+/)) {
        if (!p) continue;
        segs.push(p);
        if (!/^(5h|wk|sn):/.test(p)) rateGroup.add(p);
      }
    } else {
      segs.push(s);
    }
  }

  // Without effort.level on stdin, take the level from OMC's effort badge.
  if (!effort) {
    const badge = segs.find((s) => /^effort:\S/.test(s));
    if (badge) effort = badge.slice("effort:".length).trim();
  }

  const f = { label: "", model: "", r5: "", rwk: "", rsn: "", think: "", ctx: "", se: "", counts: "" };
  let ctxShown = ""; // the ctx segment shown after se; f.ctx stays empty (see the ctx line below)
  const extra = [];
  const modelRates = []; // per-model usage badges, shown right after the rate windows
  const slash = (s) => s.replace(/%\(([^)]+)\)/, "%/$1"); // 6%(3h56m) -> 6%/3h56m

  for (const s of segs) {
    if (/^\[?OMC#/.test(s)) {
      const m = s.match(/OMC#([0-9][0-9.]*)/);
      f.label = m ? `OMC#${m[1]}` : s; // drop brackets + trailing "L"
    } else if (/^Model:/.test(s) || /^(Opus|Sonnet|Haiku)\b/.test(s)) {
      const m = s.match(/(?:Model:\s*)?([A-Za-z]+)\s*([0-9][0-9.]*)/);
      // Opus 4.8 -> Op4.8/high; an unknown id (Model: claude-x-5) keeps its name.
      const name = m ? `${m[1].slice(0, 2)}${m[2]}` : s.replace(/^Model:\s*/, "");
      f.model = `${name}${effort ? "/" + effort : ""}`;
    } else if (/^5h:/.test(s)) {
      f.r5 = slash(s);
    } else if (/^wk:/.test(s)) {
      f.rwk = slash(s);
    } else if (/^sn:/.test(s)) {
      f.rsn = slash(s);
    } else if (/^think/i.test(s)) {
      f.think = "think";
    } else if (/^effort:/.test(s)) {
      // OMC 5.x effort badge; the level already rides on the model (Op5.5/high).
    } else if (/^ctx:/.test(s)) {
      // "ctx:82% COMPRESS?" -> "ctx:82%": the color already says how full it is.
      const m = s.match(/^ctx:(\d+)%/);
      ctxShown = m ? `ctx:${m[1]}%` : s;
    } else if (/^session:/.test(s)) {
      const m = s.match(/session:(\d+)m/);
      f.se = m ? `se:${(parseInt(m[1], 10) / 60).toFixed(1)}h` : s.replace(/^session:/, "se:");
    } else if (/🔧|🤖|⚡/.test(s) || /^[TAS]:\d/.test(s)) {
      f.counts = s;
    } else {
      if (rateGroup.has(s)) modelRates.push(slash(shortModelPct(s))); // fable:0%(1h31m) -> Fa:0%/1h31m
      else extra.push(s); // dynamic badges: todos, ralph, autopilot, bg, skill, etc.
    }
  }

  const colored = [];
  if (f.model) colored.push(colorModel(f.model));
  if (f.r5) colored.push(colorRate(f.r5));
  if (f.rwk) colored.push(colorRate(f.rwk));
  if (f.rsn) colored.push(colorRate(f.rsn));
  for (const r of modelRates) colored.push(colorRate(r));
  if (f.think) colored.push(A("36", f.think));
  // Keep the next line: f.ctx is always empty now (ctx is shown after se), but
  // `payload-mon on` inserts its block right after this exact line, ahead of PL.
  if (f.ctx) colored.push(colorCtx(f.ctx));
  // PL: payload size always shown before se, as "PL:0.3M" (MB, one decimal),
  // colored by its share of the 32MB limit. Replaces the payload-mon segment,
  // which only appears from 8MB on. Reuses payload-mon's module copy and cache;
  // without it (payload-mon off) or without a transcript, PL is left out.
  try {
    const transcript = JSON.parse(input)?.transcript_path;
    if (transcript) {
      const { estimatePayloadBytes, REQUEST_LIMIT_BYTES } = await import(pathToFileURL(join(__dirname, "payload-mon", "payload-size.mjs")).href);
      const bytes = estimatePayloadBytes(transcript);
      if (Number.isFinite(bytes)) {
        for (let i = colored.length - 1; i >= 0; i--) if (/^payload:/.test(stripAnsi(colored[i]))) colored.splice(i, 1);
        const pct = Math.floor((bytes / REQUEST_LIMIT_BYTES) * 100);
        colored.push(`PL:${A(pc(pct), (bytes / (1024 * 1024)).toFixed(1) + "M")}`);
      }
    }
  } catch {
    /* no stdin JSON, unreadable transcript or module missing */
  }
  if (f.se) colored.push(colorSe(f.se));
  if (ctxShown) colored.push(colorCtx(ctxShown));
  // OMC prints "🔧14 🤖1 ⚡3" ("T:14 A:1 S:3" in ASCII) and leaves out a zero count.
  // Show agents, tools, skills, one segment each; anything else keeps its place after them.
  if (f.counts) {
    const rank = (p) => (/^(?:🤖|A:)/u.test(p) ? 0 : /^(?:🔧|T:)/u.test(p) ? 1 : /^(?:⚡|S:)/u.test(p) ? 2 : 3);
    colored.push(...f.counts.trim().split(/\s+/).sort((a, b) => rank(a) - rank(b)));
  }
  for (const e of extra) colored.push(A("2", e));
  // OMC's cwd group is "cwd | branch:x | ...": keep the cwd parts here with "|",
  // and move the branch (without its "branch:" label) right before OMC#.
  let branch = "";
  const pathParts = pathLine
    .split(/\s*\|\s*/)
    .map((p) => p.trim())
    .filter((p) => {
      const m = p.match(/^branch:\s*(.+)$/);
      if (m) branch = m[1];
      return p && !m;
    });
  for (const p of pathParts) colored.push(A("36", p));
  const acct = loginAccount();
  if (acct) colored.push(A("92", acct));
  if (branch) colored.push(A("36", branch));
  // The OMC#X.Y.Z label is parsed (it marks OMC's main line) but not shown.
  if (update) colored.push(A("2", update));

  let result = colored.join(SEP);
  // Wrap at segment boundaries instead of letting Claude Code truncate the tail.
  // WRAP_MARGIN leaves room for the indent Claude Code puts before the line.
  if (TERM_COLS > WRAP_MARGIN + 20) {
    const max = TERM_COLS - WRAP_MARGIN;
    const rows = [];
    let row = "";
    for (const seg of colored) {
      if (row && visibleWidth(row) + 1 + visibleWidth(seg) > max) {
        rows.push(row);
        row = seg;
      } else {
        row = row ? row + SEP + seg : seg;
      }
    }
    if (row) rows.push(row);
    result = rows.join("\n");
  }
  if (below.length) result += "\n" + below.join("\n");
  emit(result + "\n");
} catch {
  emit(raw.endsWith("\n") ? raw : raw + "\n"); // safe passthrough
}
