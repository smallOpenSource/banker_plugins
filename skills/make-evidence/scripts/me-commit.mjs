// make-evidence: commits only the evidence paths. Ignored files are forced in only for the run logs and patches
// under docs/evidence/logs; .env files, big files and text that still looks like a secret stop the commit.
// Commit hooks run. Pure Node, no network.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE, OWN, git, gitOut, headOf, lines, topOf } from "./me-git.mjs";
import { secretLines } from "./me-run.mjs";

const MAX_FILE = 5 * 1024 * 1024;
const FORCE = new RegExp(`^${EVIDENCE}/logs/[^/]+\\.(log|patch|md)$`);
const NEVER = /(^|\/)(\.env[^/]*|node_modules|__pycache__|\.venv)(\/|$)/;
const under = (f, paths) => paths.some((p) => f === p || f.startsWith(`${p}/`));

function candidates(top, paths) {
  const normal = lines(gitOut(top, ["ls-files", "--modified", "--others", "--deleted", "--exclude-standard", "--", ...paths]));
  const ignored = lines(gitOut(top, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...paths]));
  return { normal: [...new Set(normal)], forced: ignored.filter((f) => FORCE.test(f)) };
}

// accept: exact file:line places the user confirmed are not secrets.
function refusals(top, files, accept = []) {
  const out = [];
  for (const f of files) {
    if (NEVER.test(f)) { out.push(`넣지 않는 파일: ${f}`); continue; }
    let st;
    try { st = statSync(join(top, f)); } catch { continue; } // a deletion
    if (st.size > MAX_FILE) { out.push(`5MB 넘는 파일: ${f}`); continue; }
    const hits = secretLines(readFileSync(join(top, f), "utf8")).filter((n) => !accept.includes(`${f}:${n}`));
    for (const n of hits.slice(0, 5)) out.push(`비밀값 꼴이 남음: ${f}:${n} (값을 가리거나, 비밀값이 아니면 --accept ${f}:${n})`);
  }
  return out;
}

export function commitEvidence(repo, message, paths = OWN, accept = []) {
  const top = topOf(repo);
  const foreign = lines(gitOut(top, ["diff", "--cached", "--name-only"])).filter((f) => !under(f, paths));
  if (foreign.length) return { refused: [`증거 밖의 스테이징된 변경이 있음: ${foreign.join(", ")}`] };
  const { normal, forced } = candidates(top, paths);
  if (!normal.length && !forced.length) return { refused: [`커밋할 것이 없음: ${paths.join(", ")}`] };
  const refused = refusals(top, [...normal, ...forced], accept);
  if (refused.length) return { refused };
  if (normal.length) gitOut(top, ["add", "-A", "--", ...normal]);
  if (forced.length) gitOut(top, ["add", "-f", "--", ...forced]);
  const r = git(top, ["commit", "-m", message, "--", ...new Set([...normal, ...forced])]);
  if (r.status !== 0) return { refused: [`git commit 실패(훅은 우회하지 않음): ${String(r.stdout + r.stderr).trim().split("\n").slice(-3).join(" / ")}`] };
  const files = lines(gitOut(top, ["show", "--name-only", "--format=", "HEAD"]));
  return { sha: headOf(top), files, outside: files.filter((f) => !under(f, paths)) };
}
