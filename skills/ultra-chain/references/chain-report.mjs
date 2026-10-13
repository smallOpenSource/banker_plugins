#!/usr/bin/env node
// Process view for /banker:ultra-chain. Renders a run folder's ledger (run.json, events.jsonl, task.md) into
// one self-contained index.html in that folder: the stage timeline, review verdicts, the OS test matrix, the
// visual board (mock beside actual), the human checklist and the artifacts. No script and no external
// resource: every text is escaped and links go only to files inside the run folder.
//
//   node chain-report.mjs <run> [--out <file name>]
//
// Exit codes: 0 written, 1 the ledger could not be read or the page not written, 2 usage.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, readEvents, readRun, runPath, summarize } from "./chain-ledger.mjs";

const STATUS_LABEL = {
  pending: "대기", started: "진행 중", done: "완료", failed: "실패", skipped: "건너뜀", stopped: "멈춤", note: "기록",
  running: "진행 중", pass: "통과", fail: "실패", unverified: "미검증", revise: "고칠 것",
};
const LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A link inside the run folder, or null. Each path segment is percent-encoded.
export function href(p) {
  const rel = runPath(p);
  return rel ? `./${rel.split("/").map(encodeURIComponent).join("/")}` : null;
}

// A link only to a file the run folder holds (`ctx.exists`); a folder, a missing file or a note such as
// "02-spec.md AC-10" stays words, so no link on the page is dead.
const linkable = (p, ctx) => Boolean(href(p)) && ctx.exists(runPath(p));
const link = (p, text, ctx) => (linkable(p, ctx) ? `<a href="${esc(href(p))}">${esc(text ?? p)}</a>` : esc(text ?? p ?? ""));

export function duration(ms) {
  if (ms === null || ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

const pad = (n) => String(n).padStart(2, "0");
export function when(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const badge = (status) => `<span class="s s-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;

function table(head, rows) {
  if (!rows.length) return '<p class="none">없음</p>';
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows.map((r) => `<tr>${r.join("")}</tr>`).join("\n")}</tbody></table>`;
}

const td = (html, cls) => `<td${cls ? ` class="${cls}"` : ""}>${html}</td>`;

// ── sections ─────────────────────────────────────────────────────────────────

// task.md's first line is the argument line as given and the rest the task: with no flags the two say the
// same, so the second is left out.
export function taskText(task) {
  const lines = String(task).split(/\r?\n/);
  return lines.length > 1 && lines[1].trim() && lines[1].trim() === lines[0].trim() ? [lines[0], ...lines.slice(2)].join("\n") : String(task);
}

function renderHeader(run, task, sum, generatedAt) {
  const total = sum.stages.reduce((a, s) => a + (s.ms ?? 0), 0);
  const current = sum.current ? `${esc(LABEL[sum.current])} 단계` : "모든 단계 끝";
  const facts = [
    ["실행", esc(run.id)], ["상태", `${badge(sum.overall)} ${current}`], ["시작", esc(when(run.createdAt))],
    ["단계 시간 합", esc(duration(total))], ["런타임", esc(run.runtime ?? "미상")],
    ["기준 커밋", esc((run.baseCommit ?? "").slice(0, 12))], ["브랜치", esc(run.branch ?? "")], ["보고서 생성", esc(when(generatedAt))],
  ];
  const dl = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("");
  const ask = task ? `<pre class="task">${esc(taskText(task))}</pre>` : '<p class="none">task.md 없음</p>';
  return `<header><h1>ultra-chain 과정</h1><dl class="facts">${dl}</dl><h2>요청</h2>${ask}</header>`;
}

function renderTimeline(stages) {
  const rows = stages.map((s, i) => [td(String(i)), td(esc(s.label)), td(badge(s.status)), td(esc(when(s.start))), td(esc(when(s.end))),
    td(esc(duration(s.ms))), td(s.rounds ? String(s.rounds) : ""), td(esc(s.summary ?? ""), "wrap")]);
  return `<section><h2>단계</h2>${table(["#", "단계", "상태", "시작", "끝", "걸린 시간", "회차", "요약"], rows)}</section>`;
}

// A verdict word keeps its own text; only the color says pass (APPROVE, PASS), revise (ITERATE) or fail.
const VERDICT_TONE = { APPROVE: "pass", PASS: "pass", ITERATE: "revise" };
const verdictBadge = (word) => `<span class="s s-${VERDICT_TONE[word] ?? "fail"}">${esc(word)}</span>`;

function renderVerdict(e) {
  const v = e.verdict;
  const seats = (v.seats ?? []).map((s) => [td(esc(s.id)), td(esc(s.lens ?? "")), td(esc(s.model ?? "")), td(verdictBadge(s.verdict))]);
  const blockers = v.blockers?.length ? `<ul>${v.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
  const round = e.round ? ` ${e.round}회차` : "";
  return `<article class="verdict"><h3>${esc(LABEL[e.stage])}${esc(round)}: ${esc(v.by)} ${verdictBadge(v.result)}</h3>`
    + `${v.note ? `<p>${esc(v.note)}</p>` : ""}${seats.length ? table(["검토자", "관점", "모델", "판정"], seats) : ""}${blockers}</article>`;
}

function renderVerdicts(events) {
  const list = events.filter((e) => e.verdict);
  return `<section><h2>검토 판정</h2>${list.length ? list.map(renderVerdict).join("\n") : '<p class="none">없음</p>'}</section>`;
}

function renderTests(events, ctx) {
  const rows = events.flatMap((e) => (e.tests ?? []).map((t) => [td(esc(`${LABEL[e.stage]}${e.round ? ` ${e.round}회차` : ""}`)),
    td(esc(t.where)), td(esc(t.os ?? "")), td(badge(t.status)), td(esc([t.pass, t.fail, t.skipped].map((n) => n ?? "-").join(" / "))),
    td(esc(t.note ?? ""), "wrap"), td(t.log && linkable(t.log, ctx) ? link(t.log, "로그", ctx) : "")]));
  return `<section><h2>시험 (이 머신과 OS 박스)</h2>${table(["단계", "위치", "OS", "결과", "통과 / 실패 / 건너뜀", "비고", "로그"], rows)}</section>`;
}

// The latest entry per view name: a later visual check replaces an earlier one.
function latestVisual(events) {
  const byName = new Map();
  for (const e of events) for (const v of e.visual ?? []) byName.set(v.name, v);
  return [...byName.values()];
}

function renderShot(p, caption, ctx) {
  const h = href(p);
  if (!h || !ctx.exists(runPath(p))) return `<figure class="shot empty"><figcaption>${esc(caption)}: 없음</figcaption></figure>`;
  return `<figure class="shot"><a href="${esc(h)}"><img src="${esc(h)}" alt="${esc(caption)}" loading="lazy"></a><figcaption>${esc(caption)}</figcaption></figure>`;
}

function renderVisual(events, ctx) {
  const cards = latestVisual(events).map((v) => {
    const score = v.score === undefined ? "" : ` ${v.score}점`;
    const intended = v.intended ? ' <span class="s s-note">의도한 차이</span>' : "";
    return `<article class="card"><h3>${esc(v.name)}${esc(score)} ${v.verdict ? badge(v.verdict) : ""}${intended}</h3>`
      + `<div class="pair">${renderShot(v.mock, "목업", ctx)}${renderShot(v.actual, "실제", ctx)}</div>${v.note ? `<p>${esc(v.note)}</p>` : ""}</article>`;
  });
  return `<section><h2>시각 검토</h2>${cards.length ? cards.join("\n") : '<p class="none">없음</p>'}</section>`;
}

// One entry per item and what tells it apart: its ref, or its reason when it has no ref. The same words about
// two views stay two entries; a bare repeat (no ref, no reason) of an item that has more adds nothing.
const checkKey = (c) => (c.ref ? `ref:${c.ref}` : `why:${c.why ?? ""}`);

export function checklistItems(events) {
  const groups = new Map();
  for (const e of events) {
    for (const c of e.checklist ?? []) {
      const g = groups.get(c.item) ?? new Map();
      if (!g.has(checkKey(c))) g.set(checkKey(c), c);
      groups.set(c.item, g);
    }
  }
  return [...groups.values()].flatMap((g) => {
    const full = [...g.entries()].filter(([key]) => key !== "why:").map(([, c]) => c);
    return full.length ? full : [g.get("why:")];
  });
}

// An item's ref: a link where it names a file of the run folder, else its own words.
const refOf = (ref, ctx) => (linkable(ref, ctx) ? link(ref, "근거", ctx) : `<span class="why">근거: ${esc(ref)}</span>`);

function renderChecklist(events, ctx) {
  const items = checklistItems(events).map((c) => `<li><b>${esc(c.item)}</b>${c.why ? ` <span class="why">${esc(c.why)}</span>` : ""}${c.ref ? ` ${refOf(c.ref, ctx)}` : ""}</li>`);
  return `<section class="check"><h2>사람이 볼 것 (${items.length})</h2>${items.length ? `<ol>${items.join("")}</ol>` : '<p class="none">없음</p>'}</section>`;
}

function renderArtifacts(events, ctx) {
  const seen = new Map();
  for (const e of events) for (const a of e.artifacts ?? []) if (!seen.has(a.path)) seen.set(a.path, { ...a, stage: e.stage });
  const missing = (a) => (linkable(a.path, ctx) ? "" : ` <span class="why">(파일 아님: ${esc(a.path)})</span>`);
  const rows = [...seen.values()].map((a) => [td(esc(LABEL[a.stage])), td(`${link(a.path, a.label ?? a.path, ctx)}${missing(a)}`)]);
  return `<section><h2>산출물</h2>${table(["단계", "파일"], rows)}</section>`;
}

function renderLog(events, bad) {
  const rows = events.map((e) => [td(esc(when(e.t))), td(esc(LABEL[e.stage])), td(badge(e.status)), td(Number.isInteger(e.round) ? String(e.round) : ""),
    td(esc(e.summary ?? e.reason ?? ""), "wrap")]);
  const warn = bad.length ? `<p class="warn">읽지 못한 기록 줄: ${esc(bad.join(", "))}</p>` : "";
  return `<section><details><summary>전체 기록 (${events.length}줄)</summary>${warn}${table(["시각", "단계", "상태", "회차", "내용"], rows)}</details></section>`;
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#d2d2d7;--card:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f5f5f7;--mute:#a1a1a6;--line:#3a3a3c;--card:#2c2c2e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 12px}h2{font-size:18px;margin:28px 0 10px}h3{font-size:15px;margin:8px 0}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin:0}.facts div{background:var(--card);border-radius:8px;padding:8px 10px}
dt{color:var(--mute);font-size:12px}dd{margin:0}pre.task{white-space:pre-wrap;background:var(--card);border-radius:8px;padding:12px;margin:0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:600}td.wrap{white-space:pre-wrap;word-break:break-word}
.s{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;background:var(--line)}
.s-done,.s-pass{background:#d1f2dc;color:#0b6b2e}.s-started,.s-running{background:#d6e8ff;color:#0b4ea2}
.s-failed,.s-fail,.s-stopped{background:#ffd9d6;color:#a1150b}.s-revise,.s-unverified{background:#ffefc7;color:#7a5200}
.s-skipped,.s-pending,.s-note{background:var(--line);color:var(--mute)}
.card,.verdict{background:var(--card);border-radius:10px;padding:10px 14px;margin:10px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.shot{margin:0}.shot img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}
figcaption{color:var(--mute);font-size:12px}.none{color:var(--mute)}.why{color:var(--mute)}.warn{color:#a1150b}
.check ol{background:var(--card);border-radius:10px;padding:10px 10px 10px 34px}a{color:#0b63ce}`;

// No script, plugin, form or base change may run in the page, whatever a ledger line holds.
const CSP = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// The whole page. generatedAt is the time printed as "보고서 생성". exists(rel) says whether the run folder
// holds that file; without it every path in the folder counts as one.
export function renderReport({ run, task, events, bad = [], generatedAt = new Date().toISOString(), exists = () => true }) {
  const sum = summarize(events);
  const ctx = { exists };
  const body = [renderHeader(run, task, sum, generatedAt), renderChecklist(events, ctx), renderTimeline(sum.stages), renderVerdicts(events),
    renderTests(events, ctx), renderVisual(events, ctx), renderArtifacts(events, ctx), renderLog(events, bad)].join("\n");
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<title>ultra-chain ${esc(run.id)}</title><style>${CSS}</style></head><body><main>\n${body}\n</main></body></html>\n`;
}

// ── command line ─────────────────────────────────────────────────────────────

export function writeReport(dir, out = "index.html") {
  if (!/^[\w.-]+\.html$/.test(out)) throw new Error(`--out 은 실행 폴더 안의 .html 파일 이름입니다: ${out}`);
  const run = readRun(dir);
  const { events, bad } = readEvents(dir);
  const taskFile = join(dir, "task.md");
  const task = existsSync(taskFile) ? readFileSync(taskFile, "utf8").slice(0, 8000) : null;
  const file = join(dir, out);
  const exists = (rel) => {
    try {
      return statSync(join(dir, rel)).isFile();
    } catch {
      return false;
    }
  };
  writeFileSync(file, renderReport({ run, task, events, bad, exists }));
  return file;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  const outAt = argv.indexOf("--out");
  const name = outAt >= 0 ? argv[outAt + 1] : "index.html";
  const rest = outAt >= 0 ? argv.filter((_, i) => i !== outAt && i !== outAt + 1) : argv;
  if (rest.length !== 1 || !name) {
    err.write("usage: node chain-report.mjs <run> [--out <file name>]\n");
    return 2;
  }
  try {
    out.write(`${writeReport(resolve(rest[0]), name)}\n`);
    return 0;
  } catch (e) {
    err.write(`chain-report: ${e.message}\n`);
    return 1;
  }
}

// Run as a command, also when reached through a symlinked path: Node resolves
// symlinks for import.meta.url but not for process.argv[1].
const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
