#!/usr/bin/env node
/**
 * gemini-seat: what ralph-qa checks before a gemini seat runs and removes after it ran.
 *
 *   node gemini-seat.mjs check <seat folder>   prints the read-only policy's path (exit 0), or
 *                                               says why the seat must not run (exit 1)
 *   node gemini-seat.mjs clean <seat folder>   removes gemini's record of that folder's sessions
 *   node gemini-seat.mjs sweep <base folder>   removes the records of seat folders under it that
 *                                               are gone (a run cut short before its clean)
 *
 * check: the admin policy next to this script must be the shipped deny-all one, as gemini reads
 * a missing or changed policy file without a word and opens its tools (0.62.0). And no folder
 * above the seat folder, outside the home, may hold `.gemini/.env` or `.env`: gemini reads the
 * first one it finds walking up to the root, and a GOOGLE_GEMINI_BASE_URL there sends the
 * payload elsewhere. On Windows any account may create such a folder under C:\.
 * clean: gemini 0.62.0 records every headless session, payload and answer, under
 * <home>/.gemini/tmp/<id>/chats, kept 30 days by default, and no setting stops it. The folders
 * whose `.project_root` names the seat folder go: tmp/<id> and history/<id>, and the same under
 * <home>/.cache/.gemini, where gemini keeps them in its macOS sandbox. projects.json keeps the
 * seat folder's path and nothing else. <home> is $GEMINI_CLI_HOME when set, as gemini reads it.
 * The seat folder may be gone already (a run cut short): clean matches its path as written, and
 * sweep finds every <base>/ralph-qa.<id>/gemini record whose folder is gone. A run still going
 * keeps its folder, so sweep leaves its records. On Windows the paths are compared by their
 * long names (TEMP may be spelt with an 8.3 short one).
 * Exit 2 on a usage error, or for check, a seat folder that does not exist.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY = fileURLToPath(new URL("./gemini-read-only.toml", import.meta.url));

// The policy's rules as gemini reads them, comments and blank lines aside: one rule, every tool
// denied. Any other rule could open a tool to the seat.
const POLICY_LINES = ["[[rule]]", 'toolName = "*"', 'decision = "deny"', "priority = 100"];

// ASCII only, and only spaces and tabs around a rule: gemini's TOML parser drops a file with a
// BOM or a no-break space, and then opens every tool, while trim() would let one through.
export function policyIntact(text) {
  if (typeof text !== "string" || /[^\t\r\n\x20-\x7e]/.test(text)) return false;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").replace(/^[ \t]+|[ \t\r]+$/g, "")).filter(Boolean);
  return lines.length === POLICY_LINES.length && lines.every((l, i) => l === POLICY_LINES[i]);
}

// realpath as the OS gives it: on Windows that spells an 8.3 short name (C:\Users\RUNNER~1) long,
// as a home folder is. A path that does not exist stays as written.
const OS_REALPATH = process.platform === "win32" ? realpathSync.native : realpathSync;
const realWith = (realpath) => (p) => {
  try {
    return realpath(p);
  } catch {
    return resolve(p);
  }
};
const real = realWith(OS_REALPATH);
const norm = (p, platform) => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const geminiHome = (env) => env.GEMINI_CLI_HOME || homedir();

function inside(dir, root, platform) {
  const d = norm(dir, platform);
  const r = norm(root, platform);
  return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep);
}

// The .env files gemini could read for a run in `seat` that sit in folders above it outside the
// home ($GEMINI_CLI_HOME and the account's home both count as the home).
export function strayEnvFiles(seat, { env = process.env, platform = process.platform, exists = existsSync, realpath = OS_REALPATH } = {}) {
  const longName = realWith(realpath);
  const homes = [geminiHome(env), homedir()].map(longName);
  const found = [];
  for (let dir = longName(seat); ; dir = dirname(dir)) {
    if (!homes.some((h) => inside(dir, h, platform))) {
      found.push(...[join(dir, ".gemini", ".env"), join(dir, ".env")].filter((f) => exists(f)));
    }
    if (dirname(dir) === dir) return found;
  }
}

const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// The folder a session folder's .project_root names, or null for a link, a file or no marker.
function projectRoot(dir) {
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    return readFileSync(join(dir, ".project_root"), "utf8").trim();
  } catch {
    return null;
  }
}

// Each folder gemini keeps under tmp/ or history/, here and under .cache/.gemini, with the
// folder its .project_root names.
function projectFolders(env) {
  const home = geminiHome(env);
  const bases = [join(home, ".gemini"), join(home, ".cache", ".gemini")].flatMap((g) => [join(g, "tmp"), join(g, "history")]);
  return bases.flatMap((base) => listDir(base).map((name) => join(base, name)))
    .map((dir) => ({ dir, owner: projectRoot(dir) })).filter((p) => p.owner);
}

// The folders gemini keeps for sessions run in `seat`, matched by the path as written and as
// resolved; the seat folder may be gone already.
export function sessionFolders(seat, { env = process.env, platform = process.platform } = {}) {
  const want = new Set([norm(seat, platform), norm(real(seat), platform)]);
  return projectFolders(env).filter((p) => want.has(norm(p.owner, platform))).map((p) => p.dir);
}

// The session folders of seat folders under `base` that are gone: .project_root names
// <base>/ralph-qa.<id>/gemini and that folder no longer exists (a run cut short before its clean).
// A run still going has its seat folder, so its records stay.
const SEAT_PARENT = /^ralph-qa\.[A-Za-z0-9]+$/;
export function staleSessionFolders(base, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const roots = new Set([norm(base, platform), norm(real(base), platform)]);
  const stale = ({ owner }) => {
    const o = norm(owner, platform);
    return basename(o) === "gemini" && SEAT_PARENT.test(basename(dirname(o))) && roots.has(dirname(dirname(o))) && !exists(owner);
  };
  return projectFolders(env).filter(stale).map((p) => p.dir);
}

function check(seat) {
  let text = null;
  try {
    text = readFileSync(POLICY, "utf8");
  } catch {
    // reported as not intact below
  }
  if (!policyIntact(text)) {
    process.stderr.write(`gemini-seat: ${POLICY} is missing or is not the shipped deny-all policy; the seat would run with its tools open\n`);
    return 1;
  }
  const stray = strayEnvFiles(seat);
  if (stray.length) {
    process.stderr.write(`gemini-seat: gemini would read ${stray.join(", ")} (above the seat folder, outside the home); remove it or make the seat folder elsewhere\n`);
    return 1;
  }
  process.stdout.write(POLICY + "\n");
  return 0;
}

function remove(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ removed: dirs }) + "\n");
  return 0;
}

function main(argv) {
  const [cmd, folder, ...rest] = argv;
  if (!["check", "clean", "sweep"].includes(cmd) || !folder || rest.length) {
    process.stderr.write("usage: node gemini-seat.mjs check|clean <seat folder> | sweep <base folder>\n");
    return 2;
  }
  if (cmd === "check" && !existsSync(folder)) {
    process.stderr.write(`gemini-seat: no such folder: ${folder}\n`);
    return 2;
  }
  if (cmd === "check") return check(folder);
  return remove(cmd === "clean" ? sessionFolders(folder) : staleSessionFolders(folder));
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
