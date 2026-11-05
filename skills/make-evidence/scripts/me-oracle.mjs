// make-evidence: the oracle writer's room, and the seeded bugs run in a separate worktree of HEAD. The user's work
// tree is never written. Pure Node, no network.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { EVIDENCE, EXCLUDE, KINDS, ORACLE, Usage, git, gitOut, headOf, lines, sha256, topOf, treePrint } from "./me-git.mjs";
import { claimLog, runLogged } from "./me-run.mjs";

// Inside means below, not equal; a path on another Windows drive is outside (relative() returns it absolute).
export const inside = (top, p) => { const r = relative(top, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
const slash = (p) => p.split("\\").join("/");

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(slash(relative(base, p)));
  }
  return out;
}

// ---- room -----------------------------------------------------------------------------------------------------

// The room is <base>/room; its note (the repository path and the input list) is <base>/room.json, outside the
// room, so the oracle writer does not learn where the repository is.
const noteOf = (roomDir) => join(dirname(roomDir), "room.json");

export function makeRoom(repo, req = ["README.md"]) {
  const top = topOf(repo);
  const files = [...req, `${EVIDENCE}/owner-facts.md`];
  const dir = join(mkdtempSync(join(tmpdir(), "make-evidence-room-")), "room");
  if (inside(top, dir)) throw new Error(`임시 폴더가 저장소 안에 있음: ${dir}`);
  mkdirSync(dir);
  for (const f of files) {
    const src = join(top, f);
    if (!existsSync(src) || !lstatSync(src).isFile()) throw new Error(`방에 넣을 파일이 없음: ${f}`);
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(src, join(dir, f));
  }
  mkdirSync(join(dir, ORACLE), { recursive: true });
  writeFileSync(noteOf(dir), JSON.stringify({ repo: top, files }, null, 2));
  return { dir, files };
}

// What the room holds beside the oracle: only the input files, unchanged.
function roomProblems(roomDir, top, files) {
  const problems = [];
  for (const f of walk(roomDir)) {
    if (f.startsWith(`${ORACLE}/`)) continue;
    if (!files.includes(f)) problems.push(`방에 허용하지 않은 파일: ${f}`);
    else if (!readFileSync(join(roomDir, f)).equals(readFileSync(join(top, f)))) problems.push(`입력 파일이 바뀜: ${f}`);
  }
  return problems;
}

const isFilled = (dir) => existsSync(dir) && readdirSync(dir).length > 0;

export function collectRoom(roomDir, repo, { replace = false } = {}) {
  const note = JSON.parse(readFileSync(noteOf(roomDir), "utf8"));
  const top = repo ? topOf(repo) : note.repo;
  const problems = roomProblems(roomDir, top, note.files);
  const made = existsSync(join(roomDir, ORACLE)) ? walk(join(roomDir, ORACLE)) : [];
  if (!made.length) problems.push(`${ORACLE}/ 에 파일이 없음`);
  const dest = join(top, ORACLE);
  if (!replace && isFilled(dest)) problems.push(`${ORACLE}/ 가 이미 있음(판정기 빈틈을 고친 새 판정기일 때만 --replace)`);
  const previous = lines(gitOut(top, ["log", "-1", "--format=%h %ad %s", "--date=iso", "--", ORACLE]))[0] || null;
  if (problems.length) return { problems, made, previous };
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(roomDir, ORACLE), dest, { recursive: true });
  return { problems, made, previous };
}

// ---- worktree and links ---------------------------------------------------------------------------------------

const META = "meta.json";
const BUILD_DIR = /^(dist|build|out|target|\.next|\.nuxt|\.output|bin|obj|coverage|lib)$/i;
const metaOf = (wt) => JSON.parse(readFileSync(join(dirname(wt), META), "utf8"));

function checkLink(top, p) {
  const src = resolve(top, p);
  const rel = relative(top, src);
  if (!inside(top, src)) throw new Usage(`--link 는 저장소 안의 경로만: ${p}`);
  if (!existsSync(src)) throw new Usage(`--link 경로가 없음: ${p}`);
  if (BUILD_DIR.test(basename(src))) throw new Usage(`--link 로 빌드 결과를 잇지 않음(버그를 넣은 빌드가 사용자 폴더에 써짐): ${p}. 작업 트리 안에서 새로 빌드함`);
  if (/^\.env/i.test(basename(src))) throw new Usage(`--link 로 .env 를 잇지 않음: ${p}`);
  if (lines(gitOut(top, ["ls-files", "--", rel])).length) throw new Usage(`--link 는 추적되지 않는 폴더만(추적되는 파일은 작업 트리에 이미 있음): ${p}`);
  return rel;
}

// A linked folder's print (files, bytes, latest change) and the links in it that lead back into the main tree:
// symbolic links resolving there (workspace packages), .pth and egg-link files naming it (editable installs).
export function scanLinked(top, root) {
  const s = { files: 0, bytes: 0, mtime: 0, toRepo: [] };
  const real = realpathSync(top);
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const st = lstatSync(p);
      s.files++; s.bytes += st.size; s.mtime = Math.max(s.mtime, st.mtimeMs);
      if (e.isSymbolicLink()) {
        let to; try { to = realpathSync(p); } catch { to = resolve(dir, readlinkSync(p)); }
        if (inside(real, to) && !inside(realpathSync(root), to)) s.toRepo.push(slash(relative(top, p)));
      } else if (e.isDirectory()) visit(p);
      else if (/\.(pth|egg-link)$|^__editable__/.test(e.name) && st.size < 65536 && readFileSync(p, "utf8").includes(real)) s.toRepo.push(slash(relative(top, p)));
    }
  };
  visit(root);
  return s;
}

export function addWorktree(repo, links = []) {
  const top = topOf(repo);
  const rels = links.map((p) => checkLink(top, p));
  const base = mkdtempSync(join(tmpdir(), "make-evidence-wt-"));
  const wt = join(base, "wt");
  gitOut(top, ["worktree", "add", "--detach", wt, "HEAD"]);
  writeFileSync(join(base, META), JSON.stringify({ repo: top, links: rels }));
  // The oracle and the evidence scripts as they are now, committed or not, so the run uses them.
  for (const p of [ORACLE, `${EVIDENCE}/scripts`]) {
    if (!existsSync(join(top, p))) continue;
    rmSync(join(wt, p), { recursive: true, force: true });
    cpSync(join(top, p), join(wt, p), { recursive: true });
  }
  for (const rel of rels) {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    symlinkSync(join(top, rel), join(wt, rel), "junction");
  }
  return wt;
}

export function removeWorktree(wt) {
  const { repo, links } = metaOf(wt);
  for (const rel of links) {
    const at = join(wt, rel);
    try { if (lstatSync(at).isSymbolicLink()) rmSync(at); } catch { /* not there */ } // the link, never its target
  }
  git(repo, ["worktree", "remove", "--force", wt]);
  git(repo, ["worktree", "prune"]);
  rmSync(dirname(wt), { recursive: true, force: true });
}

// ---- oracle lines and the verdict -----------------------------------------------------------------------------

const ORACLE_LINE = /^ORACLE (constraint|objective|permission) (PASS|FAIL|ERROR)\s+(\S+)/;

export function oracleResults(text) {
  const r = Object.fromEntries(KINDS.map((k) => [k, { pass: new Set(), fail: new Set(), error: new Set() }]));
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(ORACLE_LINE);
    if (m) r[m[1]][m[2].toLowerCase()].add(m[3]);
  }
  return r;
}

const casesOf = (r) => new Set(KINDS.flatMap((k) => [...r[k].pass, ...r[k].fail, ...r[k].error].map((c) => `${k}:${c}`)));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// caught: a FAIL of the bug's kind the baseline did not have, in a run that judged the same cases as the baseline
// and gave no ERROR. Anything that does not show the oracle judging the implementation is undecidable.
export function judge(text, kind, baseText, timedOut) {
  const cur = oracleResults(text), base = oracleResults(baseText);
  const collateral = KINDS.filter((k) => k !== kind).reduce((n, k) => n + [...cur[k].fail].filter((c) => !base[k].fail.has(c)).length, 0);
  const undecided = (reason) => ({ result: "undecidable", reason, collateral });
  if (timedOut) return undecided("timeout");
  if (KINDS.some((k) => cur[k].error.size)) return undecided("oracle-error");
  if (!base[kind].pass.size) return undecided("baseline-no-pass");
  if (!sameSet(casesOf(cur), casesOf(base))) return undecided("cases-differ");
  const caught = [...cur[kind].fail].some((c) => !base[kind].fail.has(c));
  return { result: caught ? "caught" : "missed", reason: caught ? "new-fail" : "no-new-fail", collateral };
}

export function oracleSha(wt) {
  const dir = join(wt, ORACLE);
  return existsSync(dir) ? sha256(walk(dir).sort().map((f) => `${f}:${sha256(readFileSync(join(dir, f)))}`).join("\n")).slice(0, 16) : "none";
}

// ---- the bug run ----------------------------------------------------------------------------------------------

const metricOf = (text, name) => (text.match(new RegExp(`^METRIC ${name.replace(/\./g, "\\.")}=(\\S+)$`, "m")) || [])[1];

function checkBugArgs(name, kind, baseline) {
  if (!/^[\w-]+$/.test(name || "")) throw new Usage("--name 은 영문, 숫자, - 와 _ 만");
  if (name === "baseline") return;
  if (!KINDS.includes(kind)) throw new Usage(`--kind 는 ${KINDS.join(", ")} 가운데 하나`);
  if (!baseline || !existsSync(baseline)) throw new Usage("--baseline <기준선 로그> 가 필요함(먼저 --name baseline 으로 돌림)");
}

// The baseline must be of this HEAD and this oracle.
function checkBaseline(wt, baseText) {
  const head = (baseText.match(/^# head=(\S+)/m) || [])[1];
  if (head !== headOf(wt)) throw new Usage(`기준선의 HEAD(${head})가 지금 HEAD 와 다름. 기준선을 다시 돌림`);
  const sha = metricOf(baseText, "bug.baseline.oracle_sha");
  if (sha !== oracleSha(wt)) throw new Usage("기준선의 판정기가 지금 판정기와 다름. 기준선을 다시 돌림");
}

function verdictMetrics(name, kind, run, text, baseText, linked) {
  const m = [`bug.${name}.exit=${run.exit}`];
  if (name === "baseline") {
    const r = oracleResults(text);
    for (const k of KINDS) m.push(`baseline.${k}.pass=${r[k].pass.size}`, `baseline.${k}.fail=${r[k].fail.size}`, `baseline.${k}.error=${r[k].error.size}`);
    return m;
  }
  let v = judge(text, kind, baseText, run.code === 124);
  if (linked.toRepo.length) v = { ...v, result: "undecidable", reason: "link-to-main" };
  m.push(`bug.${name}.kind=${kind}`, `bug.${name}.result=${v.result}`, `bug.${name}.reason=${v.reason}`, `bug.${name}.collateral=${v.collateral}`);
  return m;
}

function linkedPrints(top, links) {
  const all = links.map((rel) => scanLinked(top, join(top, rel)));
  return { key: JSON.stringify(all.map((s) => [s.files, s.bytes, s.mtime])), toRepo: all.flatMap((s) => s.toRepo) };
}

async function bugBody({ wt, name, kind, baseText, timeoutS, argv, shell }) {
  const { repo: top, links } = metaOf(wt);
  const logs = join(top, EVIDENCE, "logs");
  const diff = gitOut(wt, ["diff", "--", ".", ...EXCLUDE]);
  if (name === "baseline" ? diff.trim() : !diff.trim()) throw new Error(name === "baseline" ? "기준선인데 작업 트리에 바뀐 것이 있음" : "작업 트리에 넣은 버그가 없음(추적되는 파일을 고침)");
  if (name !== "baseline") checkBaseline(wt, baseText);
  const before = { tree: treePrint(top), linked: linkedPrints(top, links) };
  const patch = name === "baseline" ? null : claimLog(join(logs, `verify-bug-${name}-{ts}.patch`));
  if (patch) writeFileSync(patch, diff);
  const run = await runLogged({ log: join(logs, `verify-bug-${name}-{ts}.log`), argv, cwd: wt, timeoutS, shell });
  const metrics = verdictMetrics(name, kind, run, readFileSync(run.file, "utf8"), baseText, before.linked);
  metrics.push(`bug.${name}.oracle_sha=${oracleSha(wt)}`, `bug.${name}.links_to_repo=${before.linked.toRepo.length}`);
  return { top, links, run, patch, metrics, before };
}

export async function runBug({ wt, name, kind, baseline, timeoutS = 300, argv, shell = false }) {
  checkBugArgs(name, kind, baseline);
  if (!argv.length) throw new Usage("판정기 명령이 없음(-- 뒤에 씀)");
  let r;
  try {
    r = await bugBody({ wt, name, kind, baseText: baseline ? readFileSync(baseline, "utf8") : "", timeoutS, argv, shell });
  } finally {
    removeWorktree(wt);
  }
  const treeSame = treePrint(r.top) === r.before.tree;
  const linkedSame = linkedPrints(r.top, r.links).key === r.before.linked.key;
  r.metrics.push(`bug.${name}.tree_unchanged=${treeSame ? "yes" : "no"}`, `bug.${name}.links_unchanged=${linkedSame ? "yes" : "no"}`);
  writeFileSync(r.run.file, `${readFileSync(r.run.file, "utf8")}${r.metrics.map((m) => `METRIC ${m}`).join("\n")}\n`);
  return { log: r.run.file, patch: r.patch, metrics: r.metrics, unchanged: treeSame && linkedSame, toRepo: r.before.linked.toRepo };
}
