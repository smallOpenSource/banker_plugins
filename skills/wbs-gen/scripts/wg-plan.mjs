// wg-plan.mjs: reads a wbs-gen plan (JSON), checks it and lays it out as one model that the XLSX and HTML writers
// both draw. Nothing here touches the network or the disk.
import { businessDays, dowName, keyMs, mmdd, parseHolidays, resolveDate, weeks } from "./wg-dates.mjs";

export const HEAD = ["WBS", "작업", "담당", "우선순위", "선행·미확정", "시작", "종료", "일수\n(영업일)"];
export const KINDS = ["group", "task", "constraint", "milestone"];
const HEX = /^#?[0-9A-Fa-f]{6}$/;
const DEFAULT_BAR = "5D6D7E";
const DEFAULT_LIGHT = "EBEDEF";

export const hex = (c) => String(c).replace(/^#/, "").toUpperCase();
const str = (v) => (v === undefined || v === null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Checks the plan's frame (title, range, holidays, parts, gates). Returns { range, holidays, parts, gates }. */
function readFrame(plan, errors, warnings) {
  if (!str(plan.title).trim()) errors.push("title 이 없음");
  const range = { start: str(plan.start), end: str(plan.end) };
  if (keyMs(range.start) === null || keyMs(range.end) === null) {
    errors.push("start, end 는 YYYY-MM-DD 여야 함");
    return null;
  }
  if (range.end < range.start) errors.push("end 가 start 보다 앞섬");
  const h = parseHolidays(plan.holidays ?? [], range);
  if (h.bad.length) errors.push(`공휴일을 날짜로 읽지 못함: ${h.bad.join(", ")}`);
  if (h.outside.length) warnings.push(`기간 밖 공휴일은 뺌: ${h.outside.join(", ")}`);
  return { range, holidays: h.keys, parts: readParts(obj(plan.parts), errors), bars: readBars(obj(plan.bars), errors) };
}

function readBars(list, errors) {
  const bars = {};
  for (const [k, v] of Object.entries(list)) {
    if (HEX.test(str(v))) bars[k] = hex(v);
    else errors.push(`bars.${k} 색이 6자리 16진수가 아님: ${str(v)}`);
  }
  return bars;
}

function readParts(parts, errors) {
  const out = {};
  for (const [id, raw] of Object.entries(parts)) {
    const p = obj(raw);
    for (const k of ["light", "dark"]) {
      if (p[k] !== undefined && !HEX.test(str(p[k]))) errors.push(`parts.${id}.${k} 색이 6자리 16진수가 아님: ${str(p[k])}`);
    }
    out[id] = { name: str(p.name || id), light: hex(p.light ?? DEFAULT_LIGHT), dark: hex(p.dark ?? DEFAULT_BAR), legend: p.legend !== false };
  }
  return out;
}

/** A plan date as a key inside the range that is a working day, or null with an error. */
function workday(text, what, ctx) {
  const r = resolveDate(text, ctx.range);
  if (!r) ctx.errors.push(`${what}: 날짜로 읽지 못함 (${str(text)})`);
  else if (!r.inRange) ctx.errors.push(`${what}: 기간 밖 (${r.key})`);
  else if (ctx.index.get(r.key) === undefined) ctx.errors.push(`${what}: 주말이나 공휴일 (${r.key} ${dowName(r.key)})`);
  else return r.key;
  return null;
}

function gatesOf(plan, ctx) {
  return arr(plan.gates).map((g, i) => {
    const key = workday(obj(g).date, `gates[${i}]`, ctx);
    return key && { key, col: ctx.index.get(key), label: str(obj(g).label) };
  }).filter(Boolean);
}

function barColor(row, part, ctx) {
  if (row.bar !== undefined) {
    if (HEX.test(str(row.bar))) return hex(row.bar);
    ctx.errors.push(`${row.wbs || row.task}: bar 색이 6자리 16진수가 아님`);
  }
  return ctx.bars[str(row.priority)] ?? part?.dark ?? DEFAULT_BAR;
}

function partOf(row, what, ctx) {
  if (row.part === undefined) return null;
  const p = ctx.parts[str(row.part)];
  if (!p) ctx.errors.push(`${what}: parts 에 없는 part (${str(row.part)})`);
  return p ?? null;
}

/** Start and end of a task or constraint; a constraint may give date alone. */
function spanOf(row, what, ctx) {
  const s = workday(row.start ?? row.date, `${what} 시작`, ctx);
  const e = workday(row.end ?? row.start ?? row.date, `${what} 종료`, ctx);
  if (s && e && e < s) {
    ctx.errors.push(`${what}: 종료가 시작보다 앞섬`);
    return null;
  }
  return s && e ? { s, e } : null;
}

function cellsOf(row, extra) {
  return [str(row.wbs), str(row.task), str(row.owner), str(row.priority), str(row.pending), ...extra];
}

function layRow(row, i, ctx) {
  const kind = str(row.kind || "task");
  const what = `rows[${i}] ${str(row.wbs || row.task)}`.trim();
  if (!KINDS.includes(kind)) {
    ctx.errors.push(`${what}: kind 는 ${KINDS.join(", ")} 중 하나여야 함 (${kind})`);
    return null;
  }
  const part = partOf(row, what, ctx);
  const out = { kind, fill: null, bar: null, from: -1, to: -1, diamonds: [], dotted: false, cells: cellsOf(row, ["", "", ""]) };
  if (kind === "group") return { ...out, fill: part?.light ?? DEFAULT_LIGHT };
  if (kind === "milestone") {
    const k = workday(row.date ?? row.start, what, ctx);
    return { ...out, diamonds: k ? [ctx.index.get(k)] : [] };
  }
  return laySpan(row, kind, part, what, ctx, out);
}

function laySpan(row, kind, part, what, ctx, out) {
  const span = spanOf(row, what, ctx);
  if (!span) return out;
  const from = ctx.index.get(span.s);
  const to = ctx.index.get(span.e);
  const n = to - from + 1;
  const cells = cellsOf(row, [mmdd(span.s), mmdd(span.e), n]);
  if (kind === "constraint") return { ...out, diamonds: [to], dotted: true, cells };
  return { ...out, bar: barColor(row, part, ctx), from, to, cells };
}

function legendOf(plan, parts, gates, errors) {
  const items = Object.values(parts).filter((p) => p.legend).map((p) => ({ type: "swatch", color: p.dark, label: p.name }));
  arr(plan.legend).map(obj).forEach((l, i) => {
    if (!HEX.test(str(l.color))) errors.push(`legend[${i}] 색이 6자리 16진수가 아님`);
    else items.push({ type: l.dotted ? "dotted" : "swatch", color: hex(l.color), label: str(l.label) });
  });
  if (plan.milestoneLegend !== false) items.push({ type: "diamond", color: "", label: str(plan.milestoneLabel || "마일스톤") });
  for (const g of gates) items.push({ type: "gate", color: "C0392B", label: `${g.label || "게이트"}(빨간 수직선 = ${mmdd(g.key)})` });
  return items;
}

function titleOf(plan, range, n) {
  const span = `${range.start}(${dowName(range.start)}) ~ ${mmdd(range.end)}(${dowName(range.end)})`;
  return [str(plan.title).trim(), span, `${n} 영업일`, str(plan.subtitle).trim()].filter(Boolean).join("    |    ");
}

/**
 * Checks a plan and lays it out. Returns { errors, warnings, model }; model is null when there are errors.
 * model: { title, sheet, head, days: [{ key, label, dow }], weeks, gates, rows, legend, notes }
 */
function rowsOf(plan, ctx) {
  if (!Array.isArray(plan.rows) || !plan.rows.length) {
    ctx.errors.push("rows 가 비어 있음");
    return [];
  }
  return plan.rows.map((r, i) => layRow(obj(r), i, ctx)).filter(Boolean);
}

const notesOf = (plan) => arr(plan.notes).map(obj).map((n) => ({
  heading: str(n.heading),
  lines: arr(n.lines).map(str),
}));

export function layout(plan) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { errors: ["plan 은 JSON 객체여야 함"], warnings, model: null };
  const frame = readFrame(plan, errors, warnings);
  if (!frame) return { errors, warnings, model: null };
  const days = businessDays(frame.range.start, frame.range.end, frame.holidays);
  if (!days.length) errors.push("기간 안에 영업일이 없음");
  const ctx = { ...frame, errors, index: new Map(days.map((k, i) => [k, i])) };
  const gates = gatesOf(plan, ctx);
  const rows = rowsOf(plan, ctx);
  const legend = legendOf(plan, frame.parts, gates, errors);
  if (errors.length) return { errors, warnings, model: null };
  const model = {
    title: titleOf(plan, frame.range, days.length),
    sheet: str(plan.sheet || "WBS 간트"),
    head: HEAD,
    days: days.map((k) => ({ key: k, label: mmdd(k), dow: dowName(k) })),
    weeks: weeks(days),
    gates,
    rows,
    legend,
    notes: notesOf(plan),
  };
  return { errors, warnings, model };
}
