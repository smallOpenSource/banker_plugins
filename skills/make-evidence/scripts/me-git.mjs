// make-evidence: git calls, the evidence paths and a fingerprint of the user's work tree. Pure Node, no network.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const EVIDENCE = "docs/evidence";
export const ORACLE = "tests/oracle";
export const OWN = [EVIDENCE, ORACLE];
export const EXCLUDE = OWN.map((p) => `:(exclude)${p}`);
export const KINDS = ["constraint", "objective", "permission"];
export const MAX_TEXT = 4 * 1024 * 1024;

export class Usage extends Error {}

// Programs start from the home folder (Windows looks for a program in the working folder first); git gets the
// folder through -C.
export const runDir = () => (existsSync(homedir()) ? homedir() : tmpdir());

export function git(cwd, args, extra = {}) {
  const r = spawnSync("git", ["-C", resolve(cwd), ...args], { cwd: runDir(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...extra });
  if (r.error) throw new Error(`git 을 실행하지 못함: ${r.error.message}`);
  return r;
}

export function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.filter((a) => !a.startsWith(":(")).join(" ")} 실패: ${String(r.stderr).trim().split("\n").pop()}`);
  return r.stdout;
}

export const lines = (s) => String(s).split(/\r?\n/).filter(Boolean);
export const topOf = (dir) => gitOut(dir, ["rev-parse", "--show-toplevel"]).trim();
export const headOf = (dir) => gitOut(dir, ["rev-parse", "HEAD"]).trim();

// What git sees changed outside the evidence paths (tracked and untracked).
export const otherStatus = (repo) => gitOut(repo, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--", ".", ...EXCLUDE]);

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function fileHash(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() ? sha256(readFileSync(file)) : `${st.isSymbolicLink() ? "link" : "other"}`;
  } catch {
    return "gone";
  }
}

// The user's work tree outside the evidence paths: the status lines, the content of tracked changes and of every
// untracked file. Two equal prints mean nothing there changed (ignored files are not covered).
export function treePrint(top) {
  const status = otherStatus(top);
  const diff = gitOut(top, ["--no-optional-locks", "diff", "HEAD", "--binary", "--", ".", ...EXCLUDE]);
  const untracked = lines(gitOut(top, ["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE]));
  return sha256(`${status}\0${diff}\0${untracked.map((f) => `${f}:${fileHash(join(top, f))}`).join("\n")}`);
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}Z`;
}
