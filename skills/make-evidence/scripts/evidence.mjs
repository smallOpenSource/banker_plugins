#!/usr/bin/env node
/**
 * evidence.mjs: the helper the make-evidence skill runs. It records commands into logs, checks the numbers written
 * in the evidence documents against those logs, gives the oracle writer a room outside the repository, runs the
 * seeded bugs in a separate worktree, and commits only the evidence paths. Pure Node, no dependencies, no network.
 *
 *   node evidence.mjs precheck [--repo <dir>]
 *   node evidence.mjs run --log <file> [--timeout <s>] [--cwd <dir>] [--shell] -- <command...>
 *   node evidence.mjs serve --log <file> --pid <file> --ready <url> [--wait <s>] [--cwd <dir>] [--shell] -- <command...>
 *   node evidence.mjs stop --pid <file>
 *   node evidence.mjs check [--repo <dir>] [--tracked]
 *   node evidence.mjs count --doc <trace.md>
 *   node evidence.mjs room [--repo <dir>] [--req <file>]...
 *   node evidence.mjs collect --room <dir> [--repo <dir>] [--replace]
 *   node evidence.mjs worktree [--repo <dir>] [--link <untracked dependency folder>]... | worktree --remove <dir>
 *   node evidence.mjs bug --worktree <dir> --name <name> [--kind <kind> --baseline <log>] [--timeout <s>] [--shell] -- <oracle command...>
 *   node evidence.mjs commit --message <text> [--paths <p>]... [--accept <file:line>]... [--repo <dir>]
 *
 * - A log name may hold {ts} or @TS@; it becomes a UTC time with milliseconds. An existing log is never overwritten.
 * - A log starts with the command line (shell-quoted, secrets masked) and `# head= dirty= at= node= os= cwd=`, holds
 *   stdout and stderr as they come (secrets masked), and ends with `# redacted=<n>`, `exit=<code>` (or
 *   `exit=timeout(<s>s)`, `exit=interrupted(<signal>)`) and `METRIC run.exit=` plus the test counts it recognised.
 * - Measured numbers go into a log as `METRIC <name.with.dots>=<value>`; a document cites them in backticks on a
 *   line that names the log, and check looks for that exact line there.
 * - Oracle output lines are `ORACLE <constraint|objective|permission> <PASS|FAIL|ERROR> <case> [note]`.
 *
 * Exit status: 0 done, 1 a check failed (numbers, room, tree changed, commit refused, unknown trace status), 2
 * usage error or a step that could not run, 3 precheck found something the user must decide, 124 run hit its
 * time limit; run otherwise passes the command's own exit code through.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OWN, ORACLE, Usage } from "./me-git.mjs";
import { runLogged, serve, stop } from "./me-run.mjs";
import { precheck } from "./me-precheck.mjs";
import { checkDocs, countTrace } from "./me-check.mjs";
import { addWorktree, collectRoom, makeRoom, removeWorktree, runBug } from "./me-oracle.mjs";
import { commitEvidence } from "./me-commit.mjs";

const USAGE = `make-evidence: 증거 문서용 도우미(기록 실행, 수치 대조, 판정기 방, 버그 작업 트리, 증거만 커밋)
사용법: node evidence.mjs <precheck|run|serve|stop|check|count|room|collect|worktree|bug|commit> [인자]
  precheck  [--repo <dir>]                          스테이징, 미커밋 변경, 이 컴퓨터 밖 주소(설정, 환경 변수). 결정할 것이 있으면 종료 3
  run       --log <file> [--timeout <s>] [--cwd <dir>] [--shell] -- <명령...>   기본 제한 300초
  serve     --log <file> --pid <file> --ready <url> [--wait <s>] [--cwd <dir>] [--shell] -- <명령...>
  stop      --pid <file>
  check     [--repo <dir>] [--tracked]              문서의 \`이름.점=값\` 을 가리킨 로그의 METRIC 줄과 대조, 손 숫자 경고
  count     --doc <trace.md>                        trace 표의 상태 칸을 세어 METRIC 줄로 출력
  room      [--repo <dir>] [--req <file>]...         판정기 작성용 방(요구 문서와 owner-facts 만)
  collect   --room <dir> [--repo <dir>] [--replace]  방의 tests/oracle 을 저장소로 가져옴
  worktree  [--repo <dir>] [--link <폴더>]... | --remove <dir>   HEAD 의 별도 작업 트리
  bug       --worktree <dir> --name <이름> [--kind <종류> --baseline <log>] [--timeout <s>] [--shell] -- <판정기 명령...>
  commit    --message <text> [--paths <p>]... [--accept <file:line>]... [--repo <dir>]
로그 이름의 {ts} 는 PowerShell 에서 따옴표로 감싸거나 @TS@ 로 씀`;

const FLAGS = new Set(["--shell", "--tracked", "--replace"]);
const MULTI = new Set(["--req", "--paths", "--link", "--accept"]);

export function parseArgs(argv) {
  const a = { _: [], rest: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { a.rest = argv.slice(i + 1); break; }
    if (FLAGS.has(t)) a[t.slice(2)] = true;
    else if (t.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Usage(`${t} 에 값이 없음`);
      const v = argv[++i];
      if (MULTI.has(t)) (a.multi[t.slice(2)] ||= []).push(v);
      else a[t.slice(2)] = v;
    } else a._.push(t);
  }
  return a;
}

const need = (a, k) => { if (!a[k]) throw new Usage(`--${k} 가 필요함`); return a[k]; };
const seconds = (v, d) => { const n = v === undefined ? d : Number(v); if (!(n > 0)) throw new Usage(`시간 값이 잘못됨: ${v}`); return n; };
const say = (xs) => { for (const x of xs) console.log(x); };

async function cmdRun(a) {
  const r = await runLogged({ log: need(a, "log"), argv: a.rest, cwd: resolve(a.cwd || "."), timeoutS: seconds(a.timeout, 300), shell: !!a.shell });
  console.log(`run: exit=${r.exit} log=${r.file}`);
  return r.code;
}

async function cmdServe(a) {
  const r = await serve({ log: need(a, "log"), pidFile: resolve(need(a, "pid")), ready: need(a, "ready"), waitS: seconds(a.wait, 60), argv: a.rest, cwd: resolve(a.cwd || "."), shell: !!a.shell });
  console.log(`serve: ${r.ready ? "ready" : `${r.why}, stopped`} pid=${r.pid} log=${r.file}`);
  return r.ready ? 0 : 2;
}

function cmdCheck(a) {
  const c = checkDocs(a.repo || ".", { tracked: !!a.tracked });
  say(c.errors.map((e) => `ERROR ${e}`));
  say(c.warnings.map((w) => `WARN ${w}`));
  say([`METRIC check.docs=${c.docs}`, `METRIC check.values=${c.tokens}`, `METRIC check.errors=${c.errors.length}`, `METRIC check.warnings=${c.warnings.length}`]);
  return c.errors.length || c.warnings.length ? 1 : 0;
}

function cmdCount(a) {
  const c = countTrace(readFileSync(need(a, "doc"), "utf8"));
  say(c.unknownRows.map((n) => `ERROR 상태를 알 수 없는 행: ${a.doc}:${n}`));
  say(["rows", "done", "partial", "notdone", "unverified", "unknown"].map((k) => `METRIC trace.${k}=${c[k]}`));
  return c.unknown ? 1 : 0;
}

function cmdCollect(a) {
  const r = collectRoom(resolve(need(a, "room")), a.repo, { replace: !!a.replace });
  say(r.problems.map((p) => `ERROR ${p}`));
  if (r.previous && !r.problems.length) console.log(`replaced ${ORACLE} 의 이전 커밋: ${r.previous}`);
  say(r.made.map((f) => `oracle ${ORACLE}/${f}`));
  return r.problems.length ? 1 : 0;
}

function cmdWorktree(a) {
  if (a.remove) { removeWorktree(resolve(a.remove)); console.log(`removed ${resolve(a.remove)}`); return 0; }
  console.log(addWorktree(a.repo || ".", a.multi.link || []));
  return 0;
}

async function cmdBug(a) {
  const r = await runBug({ wt: resolve(need(a, "worktree")), name: need(a, "name"), kind: a.kind, baseline: a.baseline && resolve(a.baseline), timeoutS: seconds(a.timeout, 300), argv: a.rest, shell: !!a.shell });
  say([`bug: log=${r.log}${r.patch ? ` patch=${r.patch}` : ""}`, ...r.toRepo.map((p) => `WARN 링크한 폴더가 원래 트리를 가리킴: ${p}`), ...r.metrics.map((m) => `METRIC ${m}`)]);
  return r.unchanged ? 0 : 1;
}

function cmdCommit(a) {
  const r = commitEvidence(a.repo || ".", need(a, "message"), a.multi.paths || OWN, a.multi.accept || []);
  if (r.refused) { say(r.refused.map((x) => `ERROR ${x}`)); return 1; }
  say([`commit: ${r.sha}`, ...r.files.map((f) => `file ${f}`), ...r.outside.map((f) => `ERROR 증거 밖의 파일이 커밋됨: ${f}`)]);
  return r.outside.length ? 1 : 0;
}

const COMMANDS = {
  precheck: (a) => { const r = precheck(a.repo || "."); say(r.out); return r.decide ? 3 : 0; },
  run: cmdRun,
  serve: cmdServe,
  stop: (a) => { const r = stop({ pidFile: resolve(need(a, "pid")) }); console.log(`stop: pid=${r.pid} log=${r.file}`); return 0; },
  check: cmdCheck,
  count: cmdCount,
  room: (a) => { const r = makeRoom(a.repo || ".", a.multi.req); say([`room: ${r.dir}`, ...r.files.map((f) => `file ${f}`)]); return 0; },
  collect: cmdCollect,
  worktree: cmdWorktree,
  bug: cmdBug,
  commit: cmdCommit,
};

export async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") { console.log(USAGE); return sub ? 0 : 2; }
  const fn = COMMANDS[sub];
  if (!fn) { console.error(`make-evidence: 모르는 명령: ${sub}\n${USAGE}`); return 2; }
  try {
    return await fn(parseArgs(rest));
  } catch (e) {
    console.error(`make-evidence: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
