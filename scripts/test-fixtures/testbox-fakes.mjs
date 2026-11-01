// Test-only helpers for build-testbox: fake executables (an engine, npx, tart) put first on PATH, and a log of the
// calls they got. Each fake is a Node script behind a POSIX sh wrapper and a Windows .cmd wrapper.
// Not shipped (scripts/ is outside package.json's files), so the npm package, the Codex install copy and the Codex
// plugin's skills/build-testbox/ never carry it.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The fake: appends {tool, args} to FAKE_LOG and answers by FAKE_MODE.
//   ok       image inspect 0, create prints an id, inspect prints FAKE_NET (bridge), cp 0 (a cp of <stage>/. keeps
//            the stage path), start prints passing browser results for the staged spec, pull 0, rm 0
//   missing  image inspect fails with "image not known", the rest as ok
//   denied   every call fails with a permission error (exit 125)
// npx: exit 0. tart: list prints FAKE_TART_VMS as JSON, exec --help fails when FAKE_MODE is noexec, exec prints
// "tart ran" and exits FAKE_EXIT (0).
const FAKE_SOURCE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const tool = basename(process.argv[2]);
const args = process.argv.slice(3);
const mode = process.env.FAKE_MODE || "ok";
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, args }) + "\n");
const state = process.env.FAKE_LOG + ".stage";
const say = (s) => process.stdout.write(s + "\n");
function startStaged() {
  if (!existsSync(state)) return 0;
  const spec = JSON.parse(readFileSync(join(readFileSync(state, "utf8"), "spec.json"), "utf8"));
  const now = new Date().toISOString();
  const cells = spec.cells.map((c) => ({ id: c.id, status: "pass", reason: "", startedAt: now, endedAt: now, variant: "fake", url: spec.url }));
  say("BANKER_TESTBOX_RESULT " + JSON.stringify({ cells }));
  return 0;
}
const ENGINE = {
  "--version": () => (say(tool + " version 9.9.9-fake"), 0),
  image: () => (mode === "missing" ? (process.stderr.write("Error: " + args.at(-1) + ": image not known\n"), 125) : 0),
  inspect: () => (say(process.env.FAKE_NET || "bridge"), 0),
  cp: () => (args[2].endsWith(":/tb") && writeFileSync(state, args[1].slice(0, -1)), 0),
  start: startStaged,
  create: () => (say("fakeid"), 0),
};
function engine() {
  if (mode === "denied") { process.stderr.write("Error: open /run/podman/podman.sock: permission denied\n"); return 125; }
  return (ENGINE[args[0]] || (() => 0))();
}
function tart() {
  if (args[0] === "list") { say(JSON.stringify((process.env.FAKE_TART_VMS || "").split(",").filter(Boolean).map((Name) => ({ Name, Source: "local" })))); return 0; }
  if (args[0] === "exec" && args[1] === "--help") return mode === "noexec" ? (process.stderr.write("Error: unknown subcommand exec\n"), 64) : 0;
  if (args[0] === "exec") { say("tart ran " + args.slice(1).join(" ")); return Number(process.env.FAKE_EXIT || 0); }
  return 0;
}
process.exitCode = tool === "tart" ? tart() : tool === "npx" ? 0 : engine();
`;

// Temporary folders made here are removed when the test process exits.
const MADE = [];
process.on("exit", () => { for (const dir of MADE) rmSync(dir, { recursive: true, force: true }); });

function made(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  MADE.push(dir);
  return dir;
}

export function fakeBin(names) {
  const dir = made("banker-testbox-fake-");
  const script = join(dir, "fake.mjs");
  writeFileSync(script, FAKE_SOURCE);
  for (const name of names) {
    const sh = join(dir, name);
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${name}" "$@"\n`);
    chmodSync(sh, 0o755);
    writeFileSync(`${sh}.cmd`, `@echo off\r\n"${process.execPath}" "${script}" "${name}" %*\r\n`);
  }
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  return { dir, log, script };
}

// PATH with the fake folder first; the rest of PATH stays (git, node).
export function fakeEnv(fake, extra = {}) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  return { ...process.env, [key]: `${fake.dir}${delimiter}${process.env[key] || ""}`, FAKE_LOG: fake.log, ...extra };
}

export function calls(fake) {
  if (!existsSync(fake.log)) return [];
  return readFileSync(fake.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export const tempDir = (prefix = "banker-testbox-t-") => made(prefix);
