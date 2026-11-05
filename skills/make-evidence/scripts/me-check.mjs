// make-evidence: checks the numbers in the evidence documents against the run logs, and counts trace statuses.
// Pure Node, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { EVIDENCE, gitOut, lines, topOf } from "./me-git.mjs";

// A cited value: `<name>=<value>` in backticks, the name with at least one dot (scale.x5.median_s), so plain
// code such as `exit=0` is not taken for one.
const TOKEN = /`([A-Za-z][\w-]*(?:\.[\w-]+)+)=([^`\s]+)`/g;
const LOGREF = /(?<=^|[\s|(\[`'"])(?:docs\/evidence\/)?logs\/[^\s`|)\]>"',]+/g;
const CHECK_LINE = /^수치 대조: (?:docs\/evidence\/)?logs\/\S+$/;
const WRITER = /^\$ (?:echo|printf|cat|type|tee|Write-Output|Set-Content|Out-File|Add-Content)\b/i;
const SKIP_DOCS = new Set(["owner-facts.md"]);

const logPath = (top, ref) => join(top, ref.startsWith("logs/") ? join(EVIDENCE, ref) : ref);

// A .log the helper wrote: `$ <command>` then `# head=`. The METRIC lines in it, or why it is not one. Other files
// under logs/ (patches, saved prompts) are checked for being there, and hold no citable numbers.
function readLog(cache, file) {
  if (!cache.has(file)) {
    let entry;
    if (!existsSync(file)) entry = { missing: true };
    else if (!file.endsWith(".log")) entry = { metrics: new Set(), other: true }; // a patch or a saved prompt: it only has to exist
    else {
      const all = readFileSync(file, "utf8").split(/\r?\n/);
      if (!all[0]?.startsWith("$ ") || !all[1]?.startsWith("# head=")) entry = { bad: "run 이 만든 로그가 아님(첫 두 줄)" };
      else if (WRITER.test(all[0])) entry = { bad: `글을 찍기만 하는 명령의 로그: ${all[0].slice(0, 60)}` };
      else if (all[0].includes("METRIC ")) entry = { bad: "명령 줄에 METRIC 글이 들어 있음(상수를 찍는 명령)" };
      else entry = { metrics: new Set(all.filter((l) => l.startsWith("METRIC ")).map((l) => l.trim())) };
    }
    cache.set(file, entry);
  }
  return cache.get(file);
}

// Numbers that are not measurements: inline code, paths and file:line (a name with an extension), hashes (with a
// letter), dates, versions, ids (R1, F2, M-3, c1), the multiples the skill uses (1배, 5배, 10배, x5), line counts
// (10줄), steps (3단계), section and list numbers, a row number cell. Quoted text only where requirements are
// quoted (quotes: true, trace.md). Everything else with a digit is reported.
export function bareNumbers(line, { quotes = false } = {}) {
  if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return false;
  let rest = line.replace(/^\s*#+\s*(?:\d+(?:\.\d+)*\.\s+)?/, " ").replace(/`[^`]*`/g, " ").replace(LOGREF, " ");
  if (quotes) rest = rest.replace(/"[^"]*"|“[^”]*”|「[^」]*」/g, " ");
  rest = rest
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, " ").replace(/(?<!\S)(?:\.{0,2}\/|~\/)\S*/g, " ")
    .replace(/(?<!\S)[\w.-]+(?:[/\\][\w.-]+)+\.[A-Za-z][\w]*(?::\d+(?:-\d+)?)?(?=$|[\s,);])/g, " ")
    .replace(/(?<!\S)[\w.-]+\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|rb|php|cs|sql|md|json|ya?ml|toml|sh|ps1|html|css|vue|svelte):\d+(?:-\d+)?/g, " ")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, " ").replace(/\bv\d+(?:\.\d+)*\b|\b\d+\.\d+\.\d+(?:\.\d+)?\b/g, " ")
    .replace(/\b[A-Z]{1,3}-?\d+\b|\b(?!x\d)[a-z_]+\d+\b/g, " ").replace(/(?<![\d.])(?:1|5|10)배(?=\s*(?:데이터|입력|사례))|\bx(?:1|5|10)\b/g, " ")
    .replace(/(?<!\d)10줄|\d\s*(?:단계|번째)/g, " ").replace(/^\s*\|\s*(?:\d{1,3}|(?:1|5|10)배)\s*\|/, "|").replace(/^\s*(?:\d+\.|[-*])\s+/, " ");
  return /\d/.test(rest);
}

function checkRefs(ctx, at, refs) {
  for (const ref of refs) {
    const p = logPath(ctx.top, ref);
    const log = readLog(ctx.cache, p);
    if (log.missing) ctx.errors.push(`${at} 로그가 없음: ${ref}`);
    else if (log.bad) ctx.errors.push(`${at} ${log.bad}: ${ref}`);
    else if (ctx.tracked && !ctx.tracked.has(relative(ctx.top, p).split("\\").join("/"))) ctx.errors.push(`${at} 로그가 git 에 없음: ${ref}`);
  }
}

function checkTokens(ctx, at, refs, line) {
  for (const m of line.matchAll(TOKEN)) {
    ctx.tokens++;
    const want = `METRIC ${m[1]}=${m[2]}`;
    if (!refs.length) ctx.errors.push(`${at} \`${m[1]}=${m[2]}\` 줄에 로그 경로가 없음`);
    else if (!refs.some((r) => readLog(ctx.cache, logPath(ctx.top, r)).metrics?.has(want))) ctx.errors.push(`${at} 가리킨 로그에 \`${want}\` 줄이 없음`);
  }
}

function checkDoc(ctx, name) {
  let fenced = false;
  readFileSync(join(ctx.top, EVIDENCE, name), "utf8").split(/\r?\n/).forEach((line, i) => {
    const at = `${EVIDENCE}/${name}:${i + 1}`;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const all = line.match(LOGREF) || [];
    if (CHECK_LINE.test(line.trim())) {
      if (all.some((r) => /\{ts\}|@TS@|[<*]/.test(r))) ctx.errors.push(`${at} 수치 대조 줄이 실제 로그가 아니라 이름 꼴을 가리킴`);
      checkRefs(ctx, at, all);
      return;
    }
    const refs = all.filter((r) => !/\{ts\}|@TS@|[<*]/.test(r)); // a name pattern in a command, not a log
    checkRefs(ctx, at, refs);
    checkTokens(ctx, at, refs, line);
    if (bareNumbers(line, { quotes: name === "trace.md" })) ctx.warnings.push(`${at} \`이름=값\` 밖의 숫자: ${line.trim().slice(0, 120)}`);
  });
}

export function checkDocs(repo, { tracked = false } = {}) {
  const top = topOf(repo);
  const dir = join(top, EVIDENCE);
  const ctx = { top, cache: new Map(), errors: [], warnings: [], tokens: 0, docs: 0 };
  if (tracked) ctx.tracked = new Set(lines(gitOut(top, ["ls-files", "--", EVIDENCE])));
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && !SKIP_DOCS.has(f)).sort() : [];
  for (const name of names) { ctx.docs++; checkDoc(ctx, name); }
  return ctx;
}

// ---- trace counts ---------------------------------------------------------------------------------------------

const STATUS = [["완료", "done"], ["부분", "partial"], ["미구현", "notdone"], ["미검증", "unverified"]];
const cellsOf = (line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((s) => s.trim());

// Counts the 상태 column, found by its heading. No heading with 상태 is an error; rows whose status is none of
// the four are listed.
export function countTrace(text) {
  const c = { rows: 0, done: 0, partial: 0, notdone: 0, unverified: 0, unknown: 0, unknownRows: [] };
  let col = -1;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trimStart().startsWith("|") || /^\s*\|[\s:|-]+\|\s*$/.test(line)) return;
    const cells = cellsOf(line);
    if (col < 0) { col = cells.indexOf("상태"); return; }
    if (cells.includes("상태")) return; // a second table's heading
    c.rows++;
    const hit = STATUS.find(([k]) => (cells[col] || "").startsWith(k));
    if (hit) c[hit[1]]++;
    else { c.unknown++; c.unknownRows.push(i + 1); }
  });
  if (col < 0) throw new Error("trace 표에 `상태` 칸이 있는 머리 줄이 없음");
  return c;
}
