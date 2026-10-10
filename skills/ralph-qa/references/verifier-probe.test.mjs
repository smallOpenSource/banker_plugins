// Tests for verifier-probe.mjs. Run from the repo root: node --test skills/ralph-qa/references/verifier-probe.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ABSENT_REASONS,
  CLI_DEFAULT,
  DECISION_REASONS,
  detectRuntime,
  familyOf,
  isAuthorFamily,
  parseArgs,
  probe,
  readToml,
  resolveRuntime,
  RUNTIME_MARKERS,
  safeModel,
  stripJsonc,
  topLevelToml,
} from "./verifier-probe.mjs";

const PROBE = fileURLToPath(new URL("./verifier-probe.mjs", import.meta.url));

// codex's bundled catalog as `codex debug models --bundled` prints it (fields the probe reads).
const CATALOG = JSON.stringify({
  models: [
    { slug: "gpt-5.5", priority: 7, visibility: "list", supported_in_api: true },
    { slug: "gpt-5.6-sol", priority: 1, visibility: "list", supported_in_api: true },
    { slug: "codex-auto-review", priority: 43, visibility: "hide", supported_in_api: true },
    { slug: "gpt-5.6-terra", priority: 2, visibility: "list", supported_in_api: true },
  ],
});

// The probe joins paths by the host's rules, so on Windows this machine's /home/u comes back as
// \home\u: there files and folders are looked up with either separator. Elsewhere the lookup stays
// exact, so a probe that joins with the wrong separator still fails.
const slashed = process.platform === "win32" ? (p) => String(p).replace(/\\/g, "/") : String;
const bySlashed = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [slashed(k), v]));

// A machine for the probe: binaries on PATH, files, environment and command outputs. Every
// command run is recorded with the extra environment it was given.
function world({ bins = {}, files = {}, dirs = {}, env = {}, runs = {}, platform = "linux" } = {}) {
  const calls = [];
  const fileAt = bySlashed(files);
  const dirAt = bySlashed(dirs);
  return {
    home: "/home/u",
    cwd: "/work/repo",
    platform,
    env,
    calls,
    which: (name) => bins[name] ?? null,
    readFile: (path) => (slashed(path) in fileAt ? fileAt[slashed(path)] : null),
    listDir: (path) => dirAt[slashed(path)] ?? [],
    run: (cmd, args, extraEnv = {}) => {
      calls.push({ cmd: [cmd, ...args].join(" "), env: extraEnv });
      return runs[[cmd, ...args].join(" ")] ?? { status: 127, stdout: "" };
    },
  };
}

const CODEX = {
  bins: { codex: "/usr/bin/codex" },
  runs: {
    "codex --version": { status: 0, stdout: "codex-cli 0.144.5\n" },
    "codex debug models --bundled": { status: 0, stdout: CATALOG },
  },
};
const codexWith = (toml, extra = {}) => world({ ...CODEX, files: { "/home/u/.codex/config.toml": toml }, ...extra });
const seat = (out, cli) => out.seats.find((s) => s.cli === cli);
const one = (requested, w, runtime = "claude") => probe({ requested, runtime, world: w }).seats[0];

test("the flags name the seats; an empty value is no value; the runtime takes = or a space; the rest is reported", () => {
  assert.deepEqual(parseArgs(["--codex", "--gemini=gemini-2.5-pro", "--opencode=", "--runtime", "Codex", "--agents=4"]), {
    requested: { codex: null, gemini: "gemini-2.5-pro", opencode: null },
    runtime: "codex",
    unknown: ["--agents=4"],
  });
  assert.deepEqual(parseArgs(["--runtime=claude"]), { requested: {}, runtime: "claude", unknown: [] });
  assert.deepEqual(parseArgs(["--codx"]).unknown, ["--codx"]);
});

test("a spaced --runtime does not swallow the flag after it, and an empty one is no runtime", () => {
  assert.deepEqual(parseArgs(["--runtime", "--codex", "--opencode"]), { requested: { codex: null, opencode: null }, runtime: null, unknown: [] });
  assert.equal(parseArgs(["--gemini", "--runtime"]).runtime, null);
  assert.equal(parseArgs(["--runtime="]).runtime, null);
});

test("a --runtime the environment contradicts is not trusted: the runtime becomes unknown", () => {
  assert.equal(resolveRuntime("claude", { CLAUDECODE: "1" }), "claude");
  assert.equal(resolveRuntime(null, { CODEX_THREAD_ID: "t" }), "codex");
  assert.equal(resolveRuntime("claude", {}), "claude");
  const rt = resolveRuntime("claude", { CODEX_THREAD_ID: "t", CODEX_MANAGED_BY_NPM: "1" });
  const out = probe({ requested: { codex: "gpt-5.5" }, runtime: rt, world: codexWith("") });
  assert.equal(out.runtime, "unknown");
  assert.equal(seat(out, "codex").reason, "runtime-unknown");
  assert.ok(out.notes.some((n) => n.includes("the environment says codex")));
});

test("model names that could carry shell syntax are dropped with a note, wherever they come from", () => {
  for (const ok of ["gpt-5.5", "ollama-qwen/qwen3-coder:30b", "us.anthropic.claude-opus-4-1-20250805-v1:0", "claude-3-5-sonnet@20240620"]) assert.ok(safeModel(ok), ok);
  for (const bad of ["gemini-2.5-pro$(touch /tmp/x)", "a b", "x`id`", "x;rm", "'q'", "-m", "", null]) assert.ok(!safeModel(bad), String(bad));
  const fromSettings = one({ gemini: null }, gemini({ "/home/u/.gemini/settings.json": JSON.stringify({ model: { name: "gemini-2.5-pro$(touch /tmp/x)" } }) }));
  assert.equal(fromSettings.configured, null);
  assert.equal(fromSettings.model, "pro");
  assert.ok(fromSettings.notes.some((n) => n.startsWith("model name dropped")));
  assert.ok(!JSON.stringify(fromSettings).includes("touch"), "the dropped name is not repeated");
  const out = probe({ requested: { opencode: "local/q$(id)" }, runtime: "claude", world: opencode({ model: "local/qwen3;id" }) });
  assert.equal(seat(out, "opencode").reason, "no-candidate");
  assert.ok(out.notes.some((n) => n.includes("--opencode")));
  assert.ok(seat(out, "opencode").notes.some((n) => n.includes("opencode config")));
});

test("with no seat flags there are no external seats, and the report says why", () => {
  const out = probe({ requested: {}, runtime: "claude", world: world() });
  assert.deepEqual(out.seats, []);
  assert.equal(out.reason, "no-flag");
});

test("arguments the probe does not understand become a note instead of vanishing", () => {
  const out = probe({ requested: {}, runtime: "claude", unknown: ["--codx"], world: world() });
  assert.ok(out.notes.some((n) => n.includes("--codx")));
});

test("a CLI that is not installed is unseated as cli-absent", () => {
  assert.deepEqual(one({ gemini: null }, world()), { cli: "gemini", present: false, decision: "unseated", reason: "cli-absent" });
});

test("codex run from Codex is the author itself, even when codex is not on this PATH", () => {
  for (const w of [codexWith('model = "gpt-5.5"\n'), world()]) {
    const s = one({ codex: null }, w, "codex");
    assert.equal(s.decision, "unseated");
    assert.equal(s.reason, "self-runtime");
  }
});

test("an unknown runtime leaves out both claude and gpt and seats no codex (fail-closed)", () => {
  const cfg = { model: "openai/gpt-5", provider: { openai: { models: { "gpt-5": {} } }, local: { models: { qwen3: {} } }, anthropic: { models: { "claude-opus-4": {} } } } };
  const out = probe({ requested: { codex: null, opencode: null }, runtime: null, world: { ...opencode(cfg), which: (n) => `/usr/bin/${n}` } });
  assert.equal(out.runtime, "unknown");
  assert.deepEqual(out.authorFamilies, ["claude", "gpt"]);
  assert.equal(seat(out, "codex").reason, "runtime-unknown");
  assert.deepEqual(seat(out, "opencode").candidates, ["local/qwen3"]);
  assert.ok(out.notes.some((n) => n.startsWith("runtime unknown")));
  const typo = probe({ requested: { codex: null }, runtime: "claud", world: codexWith("") });
  assert.equal(seat(typo, "codex").reason, "runtime-unknown");
  assert.ok(typo.notes.some((n) => n.includes('"claud"')));
});

test("the runtime is read from the markers each runtime leaves, and two or none of them mean unknown", () => {
  assert.equal(detectRuntime({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectRuntime({ CODEX_THREAD_ID: "t" }), "codex");
  assert.equal(detectRuntime({ CODEX_MANAGED_BY_NPM: "1" }), "codex");
  assert.equal(detectRuntime({ CLAUDECODE: "1", CODEX_SANDBOX: "seatbelt" }), null);
  assert.equal(detectRuntime({ CODEX_HOME: "/x" }), null, "CODEX_HOME is configuration, not a sign of the runtime");
  assert.equal(detectRuntime({}), null);
});

test("codex adopts the catalog's top model when the configuration already uses it", () => {
  const s = one({ codex: null }, codexWith('model = "gpt-5.6-sol"\n'));
  assert.equal(s.decision, "adopt");
  assert.equal(s.model, "gpt-5.6-sol");
  assert.equal(s.reason, "catalog-top-is-configured");
  assert.equal(s.version, "codex-cli 0.144.5");
});

test("codex asks when the catalog's top model is not the configured one, the configured model as the fallback", () => {
  const s = one({ codex: null }, codexWith('model = "gpt-5.5"\nmodel_provider = "azure"\n'));
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, ["gpt-5.6-sol", "gpt-5.5"]);
  assert.equal(s.fallback, "gpt-5.5");
  assert.equal(s.reason, "top-differs-from-configured");
  assert.deepEqual(s.candidates, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"], "priority order, hidden models left out");
});

test("codex reads single-quoted TOML strings like double-quoted ones", () => {
  assert.deepEqual(topLevelToml("model = 'gpt-5.5'\nmodel_provider = \"azure\" # here\n[t]\nmodel = 'x'\n"), { model: "gpt-5.5", model_provider: "azure" });
  const s = one({ codex: null }, codexWith("model = 'gpt-5.5'\nmodel_provider = 'azure'\n"));
  assert.equal(s.reason, "top-differs-from-configured");
});

test("codex with no configured model on its default provider adopts the catalog's top model", () => {
  const s = one({ codex: null }, codexWith("# nothing set\n"));
  assert.equal(s.decision, "adopt");
  assert.equal(s.model, "gpt-5.6-sol");
  assert.equal(s.reason, "catalog-top");
});

test("codex with no configured model but a custom provider asks, and falls back to the CLI's own default", () => {
  const s = one({ codex: null }, codexWith('model_provider = "azure"\n'));
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, ["gpt-5.6-sol"]);
  assert.equal(s.fallback, CLI_DEFAULT);
  assert.equal(s.reason, "custom-provider");
});

test("codex 0.144.5 refuses a top-level profile key, so the seat is not offered; an older codex is asked about", () => {
  const toml = 'profile = "fast"\nmodel = "gpt-5.5"\n[profiles.fast]\nmodel = "gpt-5.4-mini"\n';
  const s = one({ codex: "gpt-5.5" }, codexWith(toml));
  assert.equal(s.decision, "unseated");
  assert.equal(s.reason, "cli-call-failed");
  assert.ok(s.notes.some((n) => n.includes("--profile <name>")));
  const older = { ...CODEX.runs, "codex --version": { status: 0, stdout: "codex-cli 0.130.0\n" } };
  const o = one({ codex: null }, world({ ...CODEX, runs: older, files: { "/home/u/.codex/config.toml": toml } }));
  assert.equal(o.decision, "ask");
  assert.equal(o.reason, "config-not-understood");
  assert.equal(o.fallback, "gpt-5.5");
});

test("codex's TOML is read past multi-line strings, and one left open stops the seat", () => {
  const text = [
    'model_provider = "azure"',
    'developer_instructions = """',
    "Rules:",
    "[1] be terse",
    'model = "gpt-4.1-nano"',
    '"""',
    'model = "gpt-5.5"',
    "[mcp_servers.fs]",
    'command = "x"',
    "[mcp_servers.fs.env]",
    'A = "1"',
    '[mcp_servers."my.srv"]',
  ].join("\n");
  assert.deepEqual(readToml(text), {
    values: { model_provider: "azure", model: "gpt-5.5" }, roots: ["model_provider", "developer_instructions", "model", "mcp_servers"],
    arrays: {}, mcpServers: ["fs", "my.srv"], mcpUnread: false, modelKeys: true, broken: false,
  });
  const literal = ["x = '''one line'''", "model = 'gpt-5.5'"].join("\n");
  assert.deepEqual(readToml(literal).values, { model: "gpt-5.5" });
  // Left open, the walk may have read a server's table as text: the list of servers is not known.
  const open = one({ codex: null }, codexWith(['model = "gpt-5.5"', 'notes = """', "never closed"].join("\n")));
  assert.equal(open.decision, "unseated");
  assert.equal(open.reason, "cli-call-failed");
  assert.ok(open.notes.some((n) => n.includes("to its end")));
});

test("codex lists the MCP servers its config defines, so the seat can turn each one off", () => {
  const s = one({ codex: null }, codexWith('model = "gpt-5.6-sol"\n[mcp_servers.filesystem]\ncommand = "npx"\n[mcp_servers.fetch]\ncommand = "uvx"\n'));
  assert.deepEqual(s.mcpServers, ["filesystem", "fetch"]);
});

test("codex's MCP servers are found in every TOML form codex reads, and quoted keys are keys", () => {
  const text = [
    '"model" = "gpt-5.5"',
    "notify = [",
    '  "node",',
    '  "[not a header]",',
    "]",
    "mcp_servers.dotted.command = \"node\"",
    "[ mcp_servers . 'single q' ]",
    'command = "x"',
    "[mcp_servers]",
    'inline1 = { command = "node", args = ["y"] }',
    'plain.command = "z"',
  ].join("\n");
  assert.deepEqual(readToml(text), {
    values: { model: "gpt-5.5" }, roots: ["model", "notify", "mcp_servers"], arrays: { notify: ["node", "[not a header]"] },
    mcpServers: ["dotted", "single q", "inline1", "plain"], mcpUnread: false, modelKeys: true, broken: false,
  });
  assert.equal(readToml('mcp_servers = { a = { command = "x" } }\n').mcpUnread, true);
  assert.equal(readToml('profiles = { fast = { model = "o3" } }\n').modelKeys, true);
  assert.equal(readToml("args = [\n  1,\n").broken, true, "an array left open");
});

test("codex inline tables may span lines, and their keys are not taken for MCP servers", () => {
  const text = ["[mcp_servers]", "marker = {", '  command = "node",', '  args = ["x", "]"],', "}", "fetch = { command = \"uvx\" }"].join("\n");
  const read = readToml(text);
  assert.deepEqual(read.mcpServers, ["marker", "fetch"]);
  assert.equal(read.mcpUnread, false);
  assert.equal(read.broken, false);
  const s = one({ codex: null }, codexWith('model = "gpt-5.6-sol"\n' + text.split("\n").slice(0, 5).join("\n")));
  assert.notEqual(s.reason, "cli-call-failed", "the seat turns marker off and runs");
  assert.deepEqual(s.mcpServers, ["marker"]);
  assert.equal(readToml('[profiles]\nfast = {\n  model = "o3",\n}\n').modelKeys, true, "a model inside it still counts");
});

test("a bracket inside a multi-line string in an array does not hide a later MCP server", () => {
  const text = ["notify = [", '  """', "  a ] in text", '  """,', "]", "[mcp_servers.docs]", 'command = "a"', "[mcp_servers.writer]", 'command = "b"'].join("\n");
  assert.deepEqual(readToml(text).mcpServers, ["docs", "writer"]);
  // A server named in text the walk reads as a string is not listed: the seat is not seated.
  const quoted = readToml(['note = """', "see [mcp_servers.legacy] in the docs", '"""', "[mcp_servers.docs]", 'command = "a"'].join("\n"));
  assert.deepEqual(quoted.mcpServers, ["docs"]);
  assert.equal(quoted.mcpUnread, true);
  assert.equal(readToml("# [mcp_servers.old] was removed\n[mcp_servers.docs]\ncommand = \"a\"\n").mcpUnread, false, "comment lines do not count");
});

test("an escaped quote or a quote run inside a multi-line string does not close it, so a later MCP server is listed", () => {
  // the shape a round-5 reviewer found: \""" inside one line, [mcp_servers] keys, a later multi-line string
  const text = ['note = """a \\""" b"""', "[mcp_servers]", 'writer = { command = "node", args = ["w.mjs"] }',
    "[profiles.notes]", 'text = """', "long", '"""'].join("\n");
  const read = readToml(text);
  assert.deepEqual(read.mcpServers, ["writer"]);
  assert.equal(read.mcpUnread, false);
  assert.equal(read.broken, false);
  // four or five quotes end a string that holds one or two quotes at its end
  assert.deepEqual(readToml('a = """x""""\n[mcp_servers.after]\ncommand = "y"\n').mcpServers, ["after"]);
  assert.deepEqual(readToml("a = '''x'''''\n[mcp_servers.lit]\ncommand = 'y'\n").mcpServers, ["lit"]);
  assert.deepEqual(readToml('a = """\nline \\\n  """\n[mcp_servers.cont]\ncommand = "y"\n').mcpServers, ["cont"], "a line-ending backslash");
  const inline = readToml('x = { a = """q"""" }\n[mcp_servers.after]\ncommand = "y"\n');
  assert.deepEqual([inline.mcpServers, inline.broken], [["after"], false], "a quote run closing a string inside an inline table");
});

test("U+2028 and U+2029 in a codex config do not hide a header, a key or an array item", () => {
  // TOML ends a line only at \n or \r\n; a JS `.` also stops at these two, so a comment that holds
  // one hid the line from the probe, while codex reads it.
  for (const sep of ["\u2028", "\u2029"]) {
    assert.deepEqual(readToml(`[mcp_servers.writer] # note${sep}more\ncommand = "node"\n`).mcpServers, ["writer"], "a header");
    assert.deepEqual(readToml(`mcp_servers.writer.command = "node" # note${sep}more\n`).mcpServers, ["writer"], "a dotted key");
    assert.deepEqual(readToml(`[mcp_servers]\nwriter = { command = "node" } # x${sep}y\n`).mcpServers, ["writer"], "a key under [mcp_servers]");
    assert.equal(readToml(`model = "gpt-5.5" # pinned${sep}by ops\n`).values.model, "gpt-5.5");
    assert.deepEqual(readToml(`modes = ["live"] # ${sep}"disabled"\n`).arrays.modes, ["live"], "a comment is no item");
    const s = one({ codex: null }, world({ ...CODEX, files: { "/home/u/.codex/config.toml": 'model = "gpt-5.5"\n',
      "/etc/codex/managed_config.toml": `notify = ["/usr/local/bin/n"] # ${sep}x\n` } }));
    assert.equal(s.reason, "cli-call-failed", "the managed file still sets notify");
  }
  assert.deepEqual(readToml('modes = [\n  "a", # one\n  "b",\n]\n').arrays.modes, ["a", "b"], "a comment ends at its line, not past the next items");
});

test("a line the probe cannot place keeps the config from being read as whole", () => {
  for (const text of ['[mcp_servers.작성기]\ncommand = "x"\n', 'mcp_servers.작성기.command = "x"\n', 'model = "gpt-5.5"\nwhat is this\n']) {
    assert.equal(readToml(text).broken, true, text);
  }
  const real = ['﻿model = "gpt-5.5"', 'model_reasoning_effort = "high"\r', "", "# a comment", "\t[profiles.fast]", '\tmodel = "o3"',
    "[[skills.config]]", 'path = "/x"', 'notes = """', "line [not a header]", '"""', "[mcp_servers.docs]", 'command = "npx"',
    "args = [", '  "-y", # flag', '  "pkg",', "]", 'env = { A = "1", B = "2" }', "[tui]", 'theme = { name = "x",', "  dark = true }"].join("\n");
  const read = readToml(real);
  assert.deepEqual([read.broken, read.mcpServers], [false, ["docs"]]);
  const s = one({ codex: null }, codexWith('model = "gpt-5.6-sol"\n[mcp_servers.작성기]\ncommand = "x"\n'));
  assert.equal(s.reason, "cli-call-failed");
  assert.ok(s.notes.some((n) => n.includes("a line it could not place")), s.notes.join("; "));
  const managed = one({ codex: null }, world({ ...CODEX, files: { "/home/u/.codex/config.toml": 'model = "gpt-5.5"\n',
    "/etc/codex/managed_config.toml": "[notify.작성기]\n" } }));
  assert.equal(managed.reason, "cli-call-failed", "a managed file read short may set a key the seat turns off");
  assert.ok(managed.notes.some((n) => n.includes("could not be read to its end")), managed.notes.join("; "));
});

test("a [mcp_servers] block the walk reads as text still counts in the cross-check", () => {
  const hidden = readToml(['note = """', "[mcp_servers]", 'writer = { command = "node" }', '"""', "[mcp_servers.docs]", 'command = "a"'].join("\n"));
  assert.deepEqual(hidden.mcpServers, ["docs"]);
  assert.equal(hidden.mcpUnread, true, "writer is spelt under a [mcp_servers] header");
  const spanning = readToml(["[mcp_servers]", "marker = {", '  command = "node",', "}", "[other]", "x = 1"].join("\n"));
  assert.equal(spanning.mcpUnread, false, "a key inside a server's inline table is no server");
});

test("codex is not seated when its requirements file could undo a seat guard, and is when it allows what the seat runs", () => {
  const user = { "/home/u/.codex/config.toml": 'model = "gpt-5.5"\n' };
  const seatWith = (req, platform = "linux") => one({ codex: null }, world({ ...CODEX, platform, files: { ...user, "/etc/codex/requirements.toml": req } }));
  // 0.144.5 under a fake /etc (user and mount namespace): a pinned features.shell_tool or
  // feature_requirements.shell_tool brings exec_command back under --disable shell_tool
  for (const req of ["[features]\nshell_tool = true\n", "[feature_requirements]\nshell_tool = true\n", "[rules]\nprefix_rules = []\n",
    '[mcp_servers.mgd]\nidentity = { command = "x" }\n', 'allowed_sandbox_modes = ["workspace-write"]\n',
    'allowed_web_search_modes = ["live"]\n', 'allowed_approval_policies = ["on-request"]\n', "allow_managed_hooks_only = true\n",
    'default_permissions = "dev"\n', "something_new = 1\n", 'allowed_web_search_modes = [\n  # "disabled" is not allowed\n  "cached",\n]\n',
    'allowed_sandbox_modes = "read-only"\n', 'allowed_sandbox_modes = [\n  "read-only",\n', 'enforce_residency = """\nus\n',
    'allowed_web_search_modes = ["live"] # \u2028"disabled"\n']) {
    const s = seatWith(req);
    assert.equal(s.reason, "cli-call-failed", req);
    assert.ok(s.notes.some((n) => n.includes("requirements.toml")), req);
  }
  const fine = ['allowed_sandbox_modes = ["read-only", "workspace-write"]', "allowed_approval_policies = [", '  "never",', '  "on-request",', "]",
    "allowed_web_search_modes = ['disabled', 'cached'] # web search off is allowed", 'enforce_residency = "us"'].join("\n");
  const s = seatWith(fine);
  assert.notEqual(s.reason, "cli-call-failed", (s.notes ?? []).join("; "));
  assert.notEqual(seatWith("[features]\nshell_tool = true\n", "win32").reason, "cli-call-failed", "no /etc layers on Windows");
});

test("codex is not seated when its managed config sets a key the seat turns off", () => {
  for (const managed of ["notify = [\"/usr/local/bin/n\"]\n", "[otel]\nexporter = \"otlp-http\"\n", "[mcp_servers.mgd]\nenabled = true\n",
    'web_search = "live"\n', "[features]\nmulti_agent = true\n", 'sandbox_mode = "danger-full-access"\n']) {
    const s = one({ codex: null }, world({ ...CODEX, files: { "/etc/codex/managed_config.toml": managed, "/home/u/.codex/config.toml": 'model = "gpt-5.5"\n' } }));
    assert.equal(s.decision, "unseated", managed);
    assert.equal(s.reason, "cli-call-failed");
    assert.ok(s.notes.some((n) => n.includes("managed_config.toml sets")), managed);
  }
  const fine = one({ codex: null }, world({ ...CODEX, files: { "/etc/codex/managed_config.toml": 'model = "gpt-5.5"\nmodel_provider = "openai"\n' } }));
  assert.notEqual(fine.reason, "cli-call-failed", "a managed model is no guard the seat sets");
});

test("codex is not seated when its seat command could not turn an MCP server off", () => {
  for (const toml of ['[mcp_servers."my.srv"]\ncommand = "x"\n', "[mcp_servers.'x$(touch /tmp/p)']\ncommand = \"x\"\n",
    'mcp_servers = { a = { command = "x" } }\n']) {
    const s = one({ codex: null }, codexWith('model = "gpt-5.6-sol"\n' + toml));
    assert.equal(s.decision, "unseated", toml);
    assert.equal(s.reason, "cli-call-failed");
    assert.ok(s.notes.some((n) => /rename them|its own \[mcp_servers/.test(n)), toml);
    assert.ok(!s.notes.some((n) => n.includes("touch")), "the name itself is not echoed");
  }
});

test("codex reads its system and managed config files too, the managed file first", () => {
  const files = {
    "/etc/codex/managed_config.toml": 'model = "gpt-5.5"\n',
    "/home/u/.codex/config.toml": 'model = "gpt-5.6-terra"\n[mcp_servers.mine]\ncommand = "x"\n',
    "/etc/codex/config.toml": '[mcp_servers.sysmarker]\ncommand = "y"\n',
  };
  const s = one({ codex: null }, world({ ...CODEX, files }));
  assert.equal(s.configured, "gpt-5.5");
  assert.deepEqual(s.mcpServers, ["mine", "sysmarker"]);
  const sys = one({ codex: null }, world({ ...CODEX, files: { "/etc/codex/config.toml": 'model_provider = "azure"\n[profiles.p]\nmodel = "x"\n' } }));
  assert.equal(sys.fallback, null, "a model in the system file may be what codex runs without -m");
  const win = one({ codex: null }, world({ ...CODEX, platform: "win32", files: { "/etc/codex/managed_config.toml": 'model = "gpt-5.5"\n' } }));
  assert.equal(win.configured, null, "no /etc layers on Windows");
});

test("a model given with the flag is adopted as is", () => {
  const s = one({ codex: "gpt-5.4" }, codexWith('model = "gpt-5.5"\n'));
  assert.equal(s.decision, "adopt");
  assert.equal(s.model, "gpt-5.4");
  assert.equal(s.reason, "flag");
  assert.equal(s.familyKnown, true);
});

test("a flag-given model whose family cannot be read is seated but marked", () => {
  const s = one({ codex: "prod-deployment" }, codexWith(""));
  assert.equal(s.decision, "adopt");
  assert.equal(s.familyKnown, false);
});

test("codex without a readable catalog asks about the configured model, or falls back to the CLI default", () => {
  const runs = { "codex --version": CODEX.runs["codex --version"] };
  const w = world({ bins: CODEX.bins, files: { "/home/u/.codex/config.toml": 'model = "gpt-5.5"\n' }, runs });
  const s = one({ codex: null }, w);
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, ["gpt-5.5"]);
  assert.equal(s.fallback, "gpt-5.5");
  assert.equal(s.reason, "no-catalog");
  const bare = one({ codex: null }, world({ bins: CODEX.bins, runs }));
  assert.deepEqual(bare.options, []);
  assert.equal(bare.fallback, CLI_DEFAULT);
});

test("a configured model of unknown family is neither offered nor a fallback, and is listed as unclassified", () => {
  const s = one({ codex: null }, codexWith('model = "prod-deployment"\nmodel_provider = "azure"\n'));
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, ["gpt-5.6-sol"]);
  assert.equal(s.fallback, null);
  assert.equal(s.noAskReason, "no-default-model");
  assert.deepEqual(s.unclassified, ["prod-deployment"]);
});

test("a configured model of the author's family is dropped, and the CLI default does not stand in for it", () => {
  const s = one({ codex: null }, codexWith('model = "us.anthropic.claude-sonnet-4"\nmodel_provider = "bedrock"\n'));
  assert.equal(s.configured, null);
  assert.deepEqual(s.options, ["gpt-5.6-sol"]);
  assert.equal(s.fallback, null, "without -m codex would run that Claude model");
  assert.equal(s.noAskReason, "no-default-model");
  assert.ok(!s.candidates.some((m) => /claude/.test(m)));
  assert.ok(s.notes.some((n) => n.includes("author's family")));
  const runs = { "codex --version": CODEX.runs["codex --version"] };
  const files = { "/home/u/.codex/config.toml": 'model = "anthropic/claude-opus-4"\nmodel_provider = "openrouter"\n' };
  const bare = one({ codex: null }, world({ bins: CODEX.bins, runs, files }));
  assert.equal(bare.reason, "no-catalog");
  assert.deepEqual(bare.options, []);
  assert.equal(bare.fallback, null);
});

test("the CLI default is a fallback only when the config names no model anywhere", () => {
  const s = one({ codex: null }, codexWith('model_provider = "azure"\n[profiles.x]\nmodel = "claude-sonnet-4"\n'));
  assert.equal(s.reason, "custom-provider");
  assert.equal(s.fallback, null);
  for (const key of ['"model"', "'model'"]) {
    const q = one({ codex: null }, codexWith(`${key} = "claude-opus-4"\nmodel_provider = "litellm"\n`));
    assert.equal(q.configured, null, "a quoted model key is the model key");
    assert.equal(q.fallback, null, "without -m codex would run that Claude model");
    assert.ok(q.notes.some((n) => n.includes("author's family")));
  }
});

test("CODEX_HOME moves the config the probe reads, and keys inside tables are not the top-level model", () => {
  const w = world({
    ...CODEX,
    env: { CODEX_HOME: "/opt/codex" },
    files: { "/opt/codex/config.toml": '[profiles.fast]\nmodel = "gpt-5.4-mini"\n', "/home/u/.codex/config.toml": 'model = "gpt-5.5"\n' },
  });
  const s = one({ codex: null }, w);
  assert.equal(s.configured, null);
  assert.equal(s.reason, "catalog-top");
});

const GEMINI = { bins: { gemini: "/usr/bin/gemini" } };
const gemini = (files = {}, env = {}, platform = "linux") => world({ ...GEMINI, files, env, platform });

test("gemini is not seated while its system policy folder holds policies, which override --admin-policy", () => {
  const dirs = { "/etc/gemini-cli/policies": ["site.toml"] };
  const s = one({ gemini: null }, world({ ...GEMINI, dirs }));
  assert.equal(s.decision, "unseated");
  assert.equal(s.reason, "cli-call-failed");
  assert.ok(s.notes.some((n) => n.includes("--admin-policy")));
  assert.equal(one({ gemini: null }, world({ ...GEMINI, dirs: { "/etc/gemini-cli/policies": ["README"] } })).decision, "adopt");
  const mac = world({ ...GEMINI, platform: "darwin", dirs: { "/Library/Application Support/GeminiCli/policies": ["a.toml"] } });
  assert.equal(one({ gemini: null }, mac).reason, "cli-call-failed");
});

test("gemini hooks in the settings are noted: no flag turns them off in the seat", () => {
  const hooks = JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: "x" }] }] } });
  const s = one({ gemini: null }, gemini({ "/home/u/.gemini/settings.json": hooks }));
  assert.ok(s.notes.some((n) => n.includes("hooks")));
  const off = JSON.stringify({ hooks: { BeforeAgent: [] }, hooksConfig: { enabled: false } });
  assert.ok(!(one({ gemini: null }, gemini({ "/home/u/.gemini/settings.json": off })).notes ?? []).some((n) => n.includes("hooks")));
});

test("gemini is not seated while its settings add folders or IDE files to the workspace", () => {
  for (const at of ["/home/u/.gemini/settings.json", "/etc/gemini-cli/settings.json"]) {
    const s = one({ gemini: null }, gemini({ [at]: JSON.stringify({ context: { includeDirectories: ["/srv/notes"] } }) }));
    assert.equal(s.decision, "unseated", at);
    assert.equal(s.reason, "cli-call-failed");
    assert.ok(s.notes.some((n) => n.includes("includeDirectories")));
  }
  const none = one({ gemini: null }, gemini({ "/home/u/.gemini/settings.json": JSON.stringify({ context: { includeDirectories: [] } }) }));
  assert.equal(none.decision, "adopt");
  const ide = one({ gemini: null }, gemini({ "/home/u/.gemini/settings.json": JSON.stringify({ ide: { enabled: true } }) }));
  assert.equal(ide.reason, "cli-call-failed", "IDE mode adds the IDE's open files to the request");
  assert.ok(ide.notes.some((n) => n.includes("ide.enabled")));
  const sysOff = one({ gemini: null }, gemini({ "/etc/gemini-cli/settings.json": JSON.stringify({ ide: { enabled: false } }),
    "/home/u/.gemini/settings.json": JSON.stringify({ ide: { enabled: true } }) }));
  assert.equal(sysOff.decision, "adopt", "the system file overrides the user's");
});

test("gemini's usage statistics are noted unless its settings turn them off", () => {
  const stats = (files) => (one({ gemini: null }, gemini(files)).notes ?? []).some((n) => n.includes("play.googleapis.com"));
  assert.ok(stats({}));
  assert.equal(stats({ "/home/u/.gemini/settings.json": JSON.stringify({ privacy: { usageStatisticsEnabled: false } }) }), false);
  assert.ok(stats({ "/etc/gemini-cli/settings.json": JSON.stringify({ privacy: { usageStatisticsEnabled: true } }),
    "/home/u/.gemini/settings.json": JSON.stringify({ privacy: { usageStatisticsEnabled: false } }) }), "the system file overrides the user's");
});

test("GEMINI_CLI_HOME moves the user settings the probe reads, as gemini reads them", () => {
  const s = one({ gemini: null }, gemini({ "/opt/gh/.gemini/settings.json": JSON.stringify({ model: { name: "gemini-2.5-flash" } }),
    "/home/u/.gemini/settings.json": JSON.stringify({ model: { name: "gemini-2.0-flash" } }) }, { GEMINI_CLI_HOME: "/opt/gh" }));
  assert.equal(s.configured, "gemini-2.5-flash");
});

test("gemini with no configured model adopts its `pro` alias, and runs nothing to find out", () => {
  const w = gemini();
  const s = one({ gemini: null }, w);
  assert.equal(s.decision, "adopt");
  assert.equal(s.model, "pro");
  assert.equal(s.reason, "cli-pro-alias");
  assert.deepEqual(w.calls, [], "gemini is not started: its own network use is not verified");
});

test("gemini with a configured model asks between pro and it, the configured one as the fallback", () => {
  for (const [files, env] of [
    [{ "/home/u/.gemini/settings.json": JSON.stringify({ model: { name: "gemini-2.5-flash" } }) }, {}],
    [{ "/home/u/.gemini/settings.json": '{ "model": "gemini-2.5-flash", }' }, {}],
    [{}, { GEMINI_MODEL: "gemini-2.5-flash" }],
  ]) {
    const s = one({ gemini: null }, gemini(files, env));
    assert.equal(s.decision, "ask");
    assert.deepEqual(s.options, ["pro", "gemini-2.5-flash"]);
    assert.equal(s.fallback, "gemini-2.5-flash");
    assert.equal(s.reason, "configured-vs-pro");
  }
  assert.equal(one({ gemini: null }, gemini({}, { GEMINI_MODEL: "auto" })).fallback, "auto");
  assert.equal(one({ gemini: null }, gemini({}, { GEMINI_MODEL: "pro" })).decision, "adopt");
});

test("gemini settings override in gemini's own order, and the reviewed repository's settings are not read", () => {
  const user = { "/home/u/.gemini/settings.json": JSON.stringify({ model: { name: "user-pick-gemini" } }) };
  const workspace = { "/work/repo/.gemini/settings.json": JSON.stringify({ model: { name: "workspace-pick-gemini" } }) };
  const system = { "/etc/gemini-cli/settings.json": JSON.stringify({ model: { name: "system-pick-gemini" } }) };
  assert.equal(one({ gemini: null }, gemini({ ...user, ...workspace })).configured, "user-pick-gemini", "the seat runs in the payload folder");
  assert.equal(one({ gemini: null }, gemini(workspace)).model, "pro");
  assert.equal(one({ gemini: null }, gemini({ ...user, ...workspace, ...system })).configured, "system-pick-gemini");
  const mac = { "/Library/Application Support/GeminiCli/settings.json": JSON.stringify({ model: { name: "mac-gemini" } }) };
  assert.equal(one({ gemini: null }, gemini(mac, {}, "darwin")).configured, "mac-gemini");
  const moved = { "/x/s.json": JSON.stringify({ model: { name: "moved-gemini" } }) };
  assert.equal(one({ gemini: null }, gemini(moved, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/x/s.json" })).configured, "moved-gemini");
});

test("gemini's system-defaults layer is read below the user's settings, for the model and the workspace checks", () => {
  const defaults = { "/etc/gemini-cli/system-defaults.json": JSON.stringify({ model: { name: "defaults-pick-gemini" } }) };
  assert.equal(one({ gemini: null }, gemini(defaults)).configured, "defaults-pick-gemini");
  const user = { "/home/u/.gemini/settings.json": JSON.stringify({ model: { name: "user-pick-gemini" } }) };
  assert.equal(one({ gemini: null }, gemini({ ...defaults, ...user })).configured, "user-pick-gemini", "the user's settings win over the defaults");
  const inc = one({ gemini: null }, gemini({ "/etc/gemini-cli/system-defaults.json": JSON.stringify({ context: { includeDirectories: ["/srv/x"] } }) }));
  assert.equal(inc.reason, "cli-call-failed", "a folder the defaults add to the workspace");
  const moved = one({ gemini: null }, gemini({ "/opt/d.json": JSON.stringify({ ide: { enabled: true } }) }, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/opt/d.json" }));
  assert.equal(moved.reason, "cli-call-failed", "$GEMINI_CLI_SYSTEM_DEFAULTS_PATH moves the file");
  const beside = one({ gemini: null }, gemini({ "/x/system-defaults.json": JSON.stringify({ model: { name: "beside-gemini" } }) }, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/x/s.json" }));
  assert.equal(beside.configured, "beside-gemini", "beside a moved system settings file");
});

test("gemini's own sandbox is noted when its settings or GEMINI_SANDBOX turn it on, since the seat command turns it off", () => {
  const user = (sandbox) => ({ "/home/u/.gemini/settings.json": JSON.stringify({ tools: { sandbox } }) });
  const noted = (s) => (s.notes ?? []).some((n) => n.includes("GEMINI_SANDBOX=false"));
  for (const on of ["docker", true, { enabled: true, command: "podman" }]) {
    assert.ok(noted(one({ gemini: null }, gemini(user(on)))), JSON.stringify(on));
  }
  // gemini 0.62.0 reads the strings "false" and "0" in the setting as off, and compares as written: "FALSE" is on.
  for (const off of [false, { enabled: false }, "false", "0"]) assert.ok(!noted(one({ gemini: null }, gemini(user(off)))), JSON.stringify(off));
  assert.ok(noted(one({ gemini: null }, gemini(user("FALSE")))), "FALSE");
  assert.ok(!noted(one({ gemini: null }, gemini())), "no setting");
  assert.ok(!noted(one({ gemini: null }, gemini(user("docker"), { GEMINI_SANDBOX: "false" }))), "the env wins over the setting");
  assert.ok(noted(one({ gemini: null }, gemini({}, { GEMINI_SANDBOX: "1" }))));
  const s = one({ gemini: null }, gemini(user("docker")));
  assert.equal(s.decision, "adopt", "the seat still runs: its command turns the sandbox off");
});

test("unreadable gemini settings are reported and nothing is adopted on a guess", () => {
  const s = one({ gemini: null }, gemini({ "/home/u/.gemini/settings.json": "{ not json" }));
  assert.equal(s.decision, "ask");
  assert.equal(s.reason, "config-not-understood");
  assert.ok(s.notes.some((n) => slashed(n).includes("/home/u/.gemini/settings.json")));
});

const opencode = (config, extra = {}) =>
  world({
    bins: { opencode: "/usr/bin/opencode" },
    files: { "/home/u/.config/opencode/opencode.json": typeof config === "string" ? config : JSON.stringify(config), ...(extra.files ?? {}) },
    env: extra.env ?? {},
  });

const MODELS_DEV = { "/home/u/.cache/opencode/models.json": JSON.stringify({ openai: {}, google: {}, anthropic: {} }) };

test("the probe starts no opencode: any start empties a models.dev copy an older opencode left", () => {
  // opencode 1.3.10 clears its cache folder (models.json too) when the folder's version file is
  // missing or old, and with the refresh off it does not fetch the list again.
  const cfg = { model: "ollama-qwen/qwen3-coder:30b", enabled_providers: ["ollama-qwen"], provider: { "ollama-qwen": { models: { "qwen3-coder:30b": {} } } } };
  const w = opencode(cfg, { files: MODELS_DEV });
  assert.equal(one({ opencode: null }, w).reason, "single-candidate");
  assert.deepEqual(w.calls.filter((c) => c.cmd.startsWith("opencode")), []);
});

test("opencode adopts its one configured model only when nothing else can be run", () => {
  const cfg = { model: "ollama-qwen/qwen3-coder:30b", enabled_providers: ["ollama-qwen"], provider: { "ollama-qwen": { models: { "qwen3-coder:30b": {} } } } };
  const s = one({ opencode: null }, opencode(cfg, { files: MODELS_DEV }));
  assert.equal(s.decision, "adopt");
  assert.equal(s.model, "ollama-qwen/qwen3-coder:30b");
  assert.equal(s.reason, "single-candidate");
  const noCopy = one({ opencode: null }, opencode(cfg));
  assert.equal(noCopy.decision, "ask", "without the local models.dev copy the provider may be a built-in one");
  assert.equal(noCopy.reason, "no-catalog");
});

test("opencode asks about one known model of a provider models.dev knows, or with no enabled_providers", () => {
  const builtIn = { model: "google/gemini-2.5-flash", enabled_providers: ["google"], provider: { google: { models: { "gemini-2.5-flash": {} } } } };
  for (const cfg of [builtIn, { model: "google/gemini-2.5-flash" }, { model: "local/qwen3", provider: { local: { models: { qwen3: {} } } } }]) {
    const s = one({ opencode: null }, opencode(cfg, { files: MODELS_DEV }));
    assert.equal(s.decision, "ask", JSON.stringify(cfg));
    assert.equal(s.reason, "open-model-set", "the models.dev copy was read: opencode may run models beyond this one");
    assert.equal(s.fallback, cfg.model, "the configured model is still what runs when nobody can be asked");
    assert.equal(one({ opencode: null }, opencode(cfg)).reason, "no-catalog", "without the copy the probe cannot tell");
  }
});

test("opencode with several models asks, the configured model first and as the fallback", () => {
  const s = one({ opencode: null }, opencode({ model: "local/qwen3-b", provider: { local: { models: { "qwen3-a": {}, "qwen3-b": {}, "qwen3-c": {} } } } }));
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, ["local/qwen3-b", "local/qwen3-a", "local/qwen3-c"]);
  assert.equal(s.fallback, "local/qwen3-b");
});

test("opencode with models but no configured one asks with no fallback", () => {
  const s = one({ opencode: null }, opencode({ provider: { p1: { models: { "llama-small": {} } }, p2: { models: { "qwen3-big": {} } } } }));
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, ["p1/llama-small", "p2/qwen3-big"]);
  assert.equal(s.fallback, null);
  assert.equal(s.noAskReason, "no-default-model");
});

test("opencode with no known model asks for one by name instead of blaming the environment", () => {
  const s = one({ opencode: null }, opencode({}));
  assert.equal(s.decision, "ask");
  assert.deepEqual(s.options, []);
  assert.equal(s.reason, "no-candidate");
  assert.equal(s.noAskReason, "no-independent-model");
  const unknownOnly = one({ opencode: null }, opencode({ model: "gw/prod-deployment" }));
  assert.equal(unknownOnly.reason, "no-candidate");
  assert.equal(unknownOnly.noAskReason, "no-default-model");
  assert.deepEqual(unknownOnly.unclassified, ["gw/prod-deployment"]);
});

test("opencode leaves out the author's own family, gateway spellings included", () => {
  const cfg = {
    model: "amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0",
    provider: { "amazon-bedrock": { models: { "anthropic.claude-opus-4-1": {} } }, local: { models: { qwen3: {} } } },
  };
  const s = one({ opencode: null }, opencode(cfg));
  assert.equal(s.configured, null);
  assert.deepEqual(s.candidates, ["local/qwen3"]);
  assert.equal(s.fallback, null, "one known model that is not the configured one is not adopted on its own");
});

test("opencode reads its config with comments and trailing commas, and the .jsonc beside it", () => {
  const s = one({ opencode: null }, opencode('// local only\n{ "model": "local/qwen3", // pinned\n "x": "a//b", }\n'));
  assert.equal(s.configured, "local/qwen3");
  assert.equal(s.fallback, "local/qwen3");
  const jsonc = opencode({}, { files: { "/home/u/.config/opencode/opencode.jsonc": '{ "model": "local/llama3", }' } });
  assert.equal(one({ opencode: null }, jsonc).configured, "local/llama3");
});

test("opencode's later config sources win as opencode merges them, and disabled providers are left out", () => {
  const files = {
    "/cfg/o.json": JSON.stringify({ model: "b/qwen3-b", provider: { b: { models: { "qwen3-b": {} } } } }),
    "/cfgdir/opencode.json": JSON.stringify({ disabled_providers: ["a"] }),
  };
  const env = { OPENCODE_CONFIG: "/cfg/o.json", OPENCODE_CONFIG_DIR: "/cfgdir" };
  const s = one({ opencode: null }, opencode({ model: "a/qwen3-a", provider: { a: { models: { "qwen3-a": {} } } } }, { files, env }));
  assert.equal(s.configured, "b/qwen3-b");
  assert.deepEqual(s.candidates, ["b/qwen3-b"]);
});

test("$OPENCODE_CONFIG_CONTENT is not read, since the seat command replaces it, and the probe says so", () => {
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "x/llama3", provider: { x: { models: { llama3: {} } } } }) };
  const s = one({ opencode: null }, opencode({ model: "local/qwen3" }, { env }));
  assert.equal(s.configured, "local/qwen3");
  assert.ok(!s.candidates.includes("x/llama3"));
  assert.ok(s.notes.some((n) => n.startsWith("$OPENCODE_CONFIG_CONTENT is not read")));
});

test("an opencode config that cannot be read is reported, and nothing is adopted on a guess", () => {
  const s = one({ opencode: null }, opencode('{ "model": "local/qwen3" '));
  assert.equal(s.decision, "ask");
  assert.equal(s.reason, "config-not-understood");
  assert.ok(s.notes.some((n) => n.includes("opencode.json")));
});

test("a flag that names the author's own family is refused, whatever the gateway spelling", () => {
  for (const m of ["anthropic/claude-opus-4", "amazon-bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0", "litellm/sonnet"]) {
    const s = one({ opencode: m }, opencode({}));
    assert.equal(s.decision, "unseated", m);
    assert.equal(s.reason, "self-family", m);
  }
  assert.equal(one({ opencode: "gitlab/duo-chat-gpt-5-1" }, opencode({}), "codex").reason, "self-family");
});

test("from Codex, the family its config.toml runs is the author's too", () => {
  const files = {
    "/home/u/.config/opencode/opencode.json": JSON.stringify({ model: "local/qwen3-coder", provider: { local: { models: { "qwen3-coder": {}, llama3: {} } } } }),
    "/home/u/.codex/config.toml": 'model = "qwen3-coder:30b"\nmodel_provider = "ollama"\n',
  };
  const w = world({ bins: { opencode: "/usr/bin/opencode", codex: "/usr/bin/codex" }, files });
  const out = probe({ requested: { opencode: null }, runtime: "codex", world: w });
  assert.deepEqual(out.authorFamilies, ["gpt", "qwen"]);
  assert.deepEqual(seat(out, "opencode").candidates, ["local/llama3"]);
});

test("two seats on one model are noted as one model axis", () => {
  const w = { ...opencode({}), which: (n) => `/usr/bin/${n}` };
  w.run = (cmd, args) => CODEX.runs[[cmd, ...args].join(" ")] ?? { status: 0, stdout: "1.3.10\n" };
  const out = probe({ requested: { codex: "gpt-5.5", opencode: "azure/gpt-5.5" }, runtime: "claude", world: w });
  assert.ok(out.notes.some((n) => n.startsWith("same model on two seats")));
});

test("model families are read from anywhere in the name", () => {
  const cases = {
    "anthropic/claude-sonnet-4": "claude",
    "amazon-bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0": "claude",
    "sap-ai-core/anthropic--claude-4-sonnet": "claude",
    "litellm/sonnet": "claude",
    opus: "claude",
    "gpt-5.6-sol": "gpt",
    "openai/o3": "gpt",
    "gitlab/duo-chat-gpt-5-1": "gpt",
    "amazon-bedrock/openai.gpt-oss-120b-1:0": "gpt",
    "codex-mini-latest": "gpt",
    "gemini-2.5-pro": "gemini",
    pro: "gemini",
    auto: "gemini",
    "ollama-qwen/qwen3-coder:30b": "qwen",
    "mistral/codestral-latest": "mistral",
    "prod-deployment": null,
  };
  for (const [name, family] of Object.entries(cases)) assert.equal(familyOf(name), family, name);
  assert.ok(isAuthorFamily("router/claude-via-gpt", ["gpt"]), "any author family in the name counts, not just the first");
  assert.ok(!isAuthorFamily("ollama/qwen3-coder:30b", ["claude", "gpt"]));
});

test("comments and trailing commas leave JSON strings alone", () => {
  assert.equal(stripJsonc('{"a": "x // y", /* c */ "b": [1, 2,], }'), '{"a": "x // y",  "b": [1, 2] }');
  assert.equal(stripJsonc('{"q": "say \\"//\\"", }'), '{"q": "say \\"//\\"" }');
});

// The current environment without any runtime marker, so a test does not depend on the shell it runs in.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.values(RUNTIME_MARKERS).flat()) if (!(k in extra)) delete env[k];
  return env;
}

test("the command line prints the probe's JSON and reads the runtime from the environment", () => {
  const r = spawnSync(process.execPath, [PROBE, "--gemini"], { encoding: "utf8", env: cleanEnv({ PATH: "/nonexistent", CLAUDECODE: "1" }) });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.runtime, "claude");
  assert.equal(out.seats[0].reason, "cli-absent");
  const clash = spawnSync(process.execPath, [PROBE, "--runtime=claude", "--gemini"], { encoding: "utf8", env: cleanEnv({ PATH: "/nonexistent", CODEX_THREAD_ID: "t" }) });
  assert.equal(JSON.parse(clash.stdout).runtime, "unknown");
});

test("the command line still prints when node keeps the symlink it was started through", { skip: process.platform === "win32" && "symlinks need privileges" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-link-"));
  try {
    symlinkSync(dirname(PROBE), join(dir, "refs"));
    const r = spawnSync(process.execPath, [join(dir, "refs", "verifier-probe.mjs"), "--runtime=claude"], { encoding: "utf8",
      env: cleanEnv({ PATH: "/nonexistent", NODE_OPTIONS: "--preserve-symlinks-main" }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).runtime, "claude", "not an empty exit 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line never runs a CLI from a relative PATH entry such as the current folder", { skip: process.platform === "win32" && "a shell-script stand-in needs POSIX" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-path-"));
  try {
    mkdirSync(join(dir, "bin"));
    const marker = join(dir, "ran");
    writeFileSync(join(dir, "bin", "codex"), `#!/bin/sh\ntouch "${marker}"\necho codex-cli 9.9.9\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [PROBE, "--runtime=claude", "--codex"], { encoding: "utf8", cwd: dir, env: cleanEnv({ PATH: "bin" }) });
    assert.equal(JSON.parse(r.stdout).seats[0].reason, "cli-absent");
    assert.ok(!existsSync(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every reason the probe gives is one SKILL.md lists, and the two lists do not overlap", () => {
  const anyBin = (w) => ({ ...w, which: (n) => `/usr/bin/${n}` });
  const scenarios = [
    [{}, world(), "claude"],
    [{ codex: null }, codexWith('model = "gpt-5.6-sol"\n'), "claude"],
    [{ codex: null }, codexWith('model = "gpt-5.5"\n'), "claude"],
    [{ codex: null }, codexWith(""), "claude"],
    [{ codex: null }, codexWith('model_provider = "azure"\n'), "claude"],
    [{ codex: null }, codexWith('profile = "x"\n'), "claude"],
    [{ codex: null }, codexWith('model = "gpt-5.5"\nx = """\n'), "claude"],
    [{ codex: "gpt-5.4" }, codexWith(""), "claude"],
    [{ codex: null }, world({ bins: CODEX.bins }), "claude"],
    [{ codex: null }, codexWith(""), "codex"],
    [{ codex: null }, codexWith(""), null],
    [{ gemini: null }, gemini(), "claude"],
    [{ gemini: null }, gemini({}, { GEMINI_MODEL: "gemini-2.5-flash" }), "claude"],
    [{ gemini: null }, gemini({ "/home/u/.gemini/settings.json": "{" }), "claude"],
    [{ gemini: null }, world(), "claude"],
    [{ opencode: null }, opencode({ model: "local/qwen3" }), "claude"],
    [{ opencode: null }, opencode({ model: "local/qwen3" }, { files: MODELS_DEV }), "claude"],
    [{ opencode: null }, opencode({ model: "local/qwen3", enabled_providers: ["local"], provider: { local: { models: { qwen3: {} } } } }, { files: MODELS_DEV }), "claude"],
    [{ opencode: null }, opencode({ model: "local/qwen3-a", provider: { local: { models: { "qwen3-a": {}, "qwen3-b": {} } } } }), "claude"],
    [{ opencode: null }, opencode({}), "claude"],
    [{ opencode: null }, opencode({ model: "gw/x" }), "claude"],
    [{ opencode: "anthropic/claude-opus-4" }, opencode({}), "claude"],
    [{ opencode: null }, anyBin(opencode("{")), "claude"],
  ];
  const seen = new Set();
  for (const [requested, w, runtime] of scenarios) {
    const out = probe({ requested, runtime, world: w });
    if (out.reason) seen.add(out.reason);
    for (const s of out.seats) for (const r of [s.reason, s.noAskReason]) if (r) seen.add(r);
  }
  const listed = new Set([...ABSENT_REASONS, ...DECISION_REASONS]);
  assert.deepEqual([...seen].filter((r) => !listed.has(r)), []);
  assert.deepEqual(ABSENT_REASONS.filter((r) => DECISION_REASONS.includes(r)), []);
  const skillSet = ["model-declined"];
  assert.deepEqual([...listed].filter((r) => !seen.has(r) && !skillSet.includes(r)), [], "the scenarios reach every probe-set reason");
});
