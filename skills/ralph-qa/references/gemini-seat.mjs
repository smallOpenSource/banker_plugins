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
 * <home>/.cache/.gemini, where gemini keeps them in its macOS sandbox. A seat still running
 * when its run cleaned up writes its session again into a folder without `.project_root`;
 * projects.json, which maps the seat folder's path to that folder's name, then ties it to the
 * seat, and its entry (a path, no payload) stays. <home> is $GEMINI_CLI_HOME when set, as gemini
 * reads it. The seat folder may be gone already (a run cut short): clean matches its path as
 * written and as resolved through the nearest folder that still exists, and sweep finds every
 * <base>/ralph-qa.<id>/gemini record whose folder is gone. A run still going keeps its folder, so
 * sweep leaves its records. On Windows the paths are compared by their long names (TEMP may be
 * spelt with an 8.3 short one).
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
// as a home folder is. A path that does not exist is resolved through its nearest folder that
// does, so a seat folder that is gone still matches what gemini recorded under a link above it.
const OS_REALPATH = process.platform === "win32" ? realpathSync.native : realpathSync;
const realWith = (realpath) => (p) => {
  const rest = [];
  for (let dir = resolve(p); ; dir = dirname(dir)) {
    try {
      return join(realpath(dir), ...rest);
    } catch {
      if (dirname(dir) === dir) return resolve(p);
      rest.unshift(basename(dir));
    }
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

// The folder a session folder's .project_root names; null for a link or a file, undefined for a
// folder without the marker.
function projectRoot(dir) {
  try {
    if (!lstatSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    return readFileSync(join(dir, ".project_root"), "utf8").trim();
  } catch {
    return undefined;
  }
}

// <g>/projects.json, gemini's map from a project folder to its folder name under tmp/ and
// history/, read the other way round: folder name to the project folders that claim it.
function registered(g) {
  try {
    const { projects } = JSON.parse(readFileSync(join(g, "projects.json"), "utf8"));
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return new Map();
    const owners = new Map();
    for (const [owner, name] of Object.entries(projects)) {
      if (typeof name !== "string") continue;
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name).add(resolve(owner));
    }
    return owners;
  } catch {
    return new Map();
  }
}

// Each folder gemini keeps under tmp/ or history/, here and under .cache/.gemini, with the
// folder its .project_root names. A folder without the marker (a seat that wrote its session
// again after its run cleaned up) gets the project projects.json gives its name. A name two
// project folders claim (a hand edit, another gemini) is no seat's for sure: its unmarked folder
// gets no owner, only the `claimants`, and stays. One folder written twice ("x", "x/") is one owner.
// Only folders read from tmp/ and history/ are looked up, so no name there reaches another folder.
function projectFolders(env) {
  const home = geminiHome(env);
  return [join(home, ".gemini"), join(home, ".cache", ".gemini")].flatMap((g) => {
    const names = registered(g);
    return ["tmp", "history"].flatMap((kind) => listDir(join(g, kind)).map((name) => {
      const dir = join(g, kind, name);
      const root = projectRoot(dir);
      if (root !== undefined) return { dir, owner: root, claimants: [] };
      const claimants = [...(names.get(name) ?? [])];
      return { dir, owner: claimants.length === 1 ? claimants[0] : null, claimants };
    }));
  }).filter((p) => p.owner || p.claimants.length > 1);
}

// Whether a project folder is `seat`, by the path as written or as resolved (it may be gone).
function seatOwner(seat, platform) {
  const want = new Set([norm(seat, platform), norm(real(seat), platform)]);
  return (owner) => want.has(norm(owner, platform));
}

// Whether a project folder is <base>/ralph-qa.<id>/gemini and gone (a run cut short before its
// clean). A run still going has its seat folder, so its records stay.
const SEAT_PARENT = /^ralph-qa\.[A-Za-z0-9]+$/;
function staleOwner(base, platform, exists) {
  const roots = new Set([norm(base, platform), norm(real(base), platform)]);
  return (owner) => {
    const o = norm(owner, platform);
    return basename(o) === "gemini" && SEAT_PARENT.test(basename(dirname(o))) && roots.has(dirname(dirname(o))) && !exists(owner);
  };
}

// The folders to remove, of the project folders `mine` takes, and those left because their name
// is also another project folder's.
function folderPlan(env, mine) {
  const all = projectFolders(env);
  return {
    dirs: all.filter((p) => p.owner && mine(p.owner)).map((p) => p.dir),
    skipped: all.filter((p) => !p.owner && p.claimants.some(mine)).map((p) => p.dir),
  };
}

// The folders gemini keeps for sessions run in `seat`, matched by the path as written and as
// resolved; the seat folder may be gone already.
export function sessionFolders(seat, { env = process.env, platform = process.platform } = {}) {
  return folderPlan(env, seatOwner(seat, platform)).dirs;
}

// The session folders of seat folders under `base` that are gone: .project_root names
// <base>/ralph-qa.<id>/gemini and that folder no longer exists.
export function staleSessionFolders(base, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  return folderPlan(env, staleOwner(base, platform, exists)).dirs;
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

// Removes `dirs`; gives back what it removed and the folders it left because their name is another project's too.
function removeFolders({ dirs, skipped }) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  return { removed: dirs, skipped };
}

// clean and sweep for a caller in the same process (the ralph-qa runner, seat-run.mjs).
export function cleanSeat(seat, { env = process.env, platform = process.platform } = {}) {
  return removeFolders(folderPlan(env, seatOwner(seat, platform)));
}
export function sweepBase(base, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  return removeFolders(folderPlan(env, staleOwner(base, platform, exists)));
}

// Removes `dirs` and says which folders it left (`skipped`), on stdout as JSON and one line each on stderr.
function remove(plan) {
  const { removed, skipped } = removeFolders(plan);
  for (const dir of skipped) {
    process.stderr.write(`gemini-seat: left ${dir}: two project folders in projects.json claim its name, so it may hold another project's sessions; remove it by hand if they are the seat's\n`);
  }
  process.stdout.write(JSON.stringify({ removed, skipped }) + "\n");
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
  const mine = cmd === "clean" ? seatOwner(folder, process.platform) : staleOwner(folder, process.platform, existsSync);
  return remove(folderPlan(process.env, mine));
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
