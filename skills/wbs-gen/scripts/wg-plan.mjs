// wg-plan.mjs: reads a wbs-gen plan (JSON), checks it and lays it out as one model that the XLSX and HTML writers
// both draw. Nothing here touches the network or the disk.
import { businessDays, daysBetween, dowName, keyMs, mmdd, parseHolidays, resolveDate, weeks } from "./wg-dates.mjs";

export const HEAD = ["WBS", "작업", "담당", "우선순위", "선행·미확정", "시작", "종료", "일수\n(영업일)"];
export const KINDS = ["group", "task", "constraint", "milestone"];
// Five years of calendar days at most: about 1300 day columns, well inside Excel's 16384 columns.
export const MAX_SPAN_DAYS = 5 * 366;
// Excel keeps at most 32767 characters in a cell.
export const MAX_TEXT = 32767;
const HEX = /^#?[0-9A-Fa-f]{6}$/;
const DEFAULT_BAR = "5D6D7E";
const DEFAULT_LIGHT = "EBEDEF";

export const hex = (c) => String(c).replace(/^#/, "").toUpperCase();
const str = (v) => (v === undefined || v === null ? "" : String(v));
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
// Lookups by a plan string go through own keys only, so "constructor" or "__proto__" is just a missing name.
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** A list field: absent is empty; present but not an array is an error. */
function list(plan, name, errors) {
  const v = plan[name];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  errors.push(`${name} 는 배열이어야 함`);
  return [];
}

function readRange(plan, errors) {
  const range = { start: str(plan.start), end: str(plan.end) };
  if (keyMs(range.start) === null || keyMs(range.end) === null) {
    errors.push("start, end 는 YYYY-MM-DD 여야 함");
    return null;
  }
  if (range.end < range.start) {
    errors.push("end 가 start 보다 앞섬");
    return null;
  }
  if (daysBetween(range.start, range.end) > MAX_SPAN_DAYS) {
    errors.push("기간이 5년을 넘음. 단계나 해로 나누어 만드십시오");
    return null;
  }
  return range;
}

/** Checks the plan's frame (title, range, holidays, parts, bars). */
function readFrame(plan, errors, warnings) {
  if (!str(plan.title).trim()) errors.push("title 이 없음");
  const range = readRange(plan, errors);
  if (!range) return null;
  const h = parseHolidays(plan.holidays ?? [], range);
  if (h.bad.length) errors.push(`공휴일을 날짜로 읽지 못함: ${h.bad.join(", ")}`);
  if (h.ambiguous.length) errors.push(`기간 안 두 해에 걸리는 M/D: ${h.ambiguous.join(", ")}. YYYY-MM-DD 로 적으십시오`);
  if (h.outside.length) warnings.push(`기간 밖 공휴일은 뺌: ${h.outside.join(", ")}`);
  return { range, holidays: h.keys, parts: readParts(obj(plan.parts), errors), bars: readBars(obj(plan.bars), errors) };
}

function readBars(given, errors) {
  const bars = Object.create(null);
  for (const [k, v] of Object.entries(given)) {
    if (HEX.test(str(v))) bars[k] = hex(v);
    else errors.push(`bars.${k} 색이 6자리 16진수가 아님: ${str(v)}`);
  }
  return bars;
}

function readParts(parts, errors) {
  const out = Object.create(null);
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
  else if (r.ambiguous) ctx.errors.push(`${what}: ${str(text)} 가 기간 안 두 해에 걸림. YYYY-MM-DD 로 적으십시오`);
  else if (!r.inRange) ctx.errors.push(`${what}: 기간 밖 (${r.key})`);
  else if (ctx.index.get(r.key) === undefined) ctx.errors.push(`${what}: 주말이나 공휴일 (${r.key} ${dowName(r.key)})`);
  else return r.key;
  return null;
}

function gatesOf(plan, ctx) {
  return list(plan, "gates", ctx.errors).map((g, i) => {
    const key = workday(obj(g).date, `gates[${i}]`, ctx);
    return key && { key, col: ctx.index.get(key), label: str(obj(g).label) };
  }).filter(Boolean);
}

function barColor(row, part, ctx) {
  if (row.bar !== undefined) {
    if (HEX.test(str(row.bar))) return hex(row.bar);
    ctx.errors.push(`${str(row.wbs || row.task)}: bar 색이 6자리 16진수가 아님`);
  }
  return own(ctx.bars, str(row.priority)) ?? part?.dark ?? DEFAULT_BAR;
}

function partOf(row, what, ctx) {
  if (row.part === undefined) return null;
  const p = own(ctx.parts, str(row.part));
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
  const cells = cellsOf(row, [ctx.label(span.s), ctx.label(span.e), to - from + 1]);
  if (kind === "constraint") return { ...out, diamonds: [to], dotted: true, cells };
  return { ...out, bar: barColor(row, part, ctx), from, to, cells };
}

function legendOf(plan, parts, gates, errors) {
  const items = Object.values(parts).filter((p) => p.legend).map((p) => ({ type: "swatch", color: p.dark, label: p.name }));
  list(plan, "legend", errors).map(obj).forEach((l, i) => {
    if (!HEX.test(str(l.color))) errors.push(`legend[${i}] 색이 6자리 16진수가 아님`);
    else items.push({ type: l.dotted ? "dotted" : "swatch", color: hex(l.color), label: str(l.label) });
  });
  if (plan.milestoneLegend !== false) items.push({ type: "diamond", color: "", label: str(plan.milestoneLabel || "마일스톤") });
  for (const g of gates) items.push({ type: "gate", color: "C0392B", label: `${g.label || "게이트"}(빨간 수직선 = ${mmdd(g.key)})` });
  return items;
}

/** notes: [{ heading, lines }]; lines may also be one string. */
function notesOf(plan, errors) {
  return list(plan, "notes", errors).map(obj).map((n, i) => {
    const lines = typeof n.lines === "string" ? [n.lines] : n.lines ?? [];
    if (!Array.isArray(lines)) errors.push(`notes[${i}].lines 는 배열이나 글이어야 함`);
    return { heading: str(n.heading), lines: (Array.isArray(lines) ? lines : []).map(str) };
  });
}

function rowsOf(plan, ctx) {
  if (!Array.isArray(plan.rows) || !plan.rows.length) {
    ctx.errors.push("rows 가 비어 있음");
    return [];
  }
  return plan.rows.map((r, i) => layRow(obj(r), i, ctx)).filter(Boolean);
}

function titleOf(plan, range, n) {
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  const endText = sameYear ? mmdd(range.end) : range.end;
  const span = `${range.start}(${dowName(range.start)}) ~ ${endText}(${dowName(range.end)})`;
  return [str(plan.title).trim(), span, `${n} 영업일`, str(plan.subtitle).trim()].filter(Boolean).join("    |    ");
}

function tooLong(model, errors) {
  const texts = [
    model.title, model.sheet, ...model.legend.map((l) => l.label), ...model.rows.flatMap((r) => r.cells.map(str)),
    ...model.notes.flatMap((n) => [n.heading, ...n.lines]),
  ];
  if (texts.some((t) => t.length > MAX_TEXT)) errors.push(`한 칸의 글이 ${MAX_TEXT}자를 넘음(Excel 한도)`);
}

/**
 * Checks a plan and lays it out. Returns { errors, warnings, model }; model is null when there are errors.
 * model: { title, sheet, head, days: [{ key, label, dow }], weeks, gates, rows, legend, notes }
 */
export function layout(plan) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { errors: ["plan 은 JSON 객체여야 함"], warnings, model: null };
  const frame = readFrame(plan, errors, warnings);
  if (!frame) return { errors, warnings, model: null };
  const days = businessDays(frame.range.start, frame.range.end, frame.holidays);
  if (!days.length) errors.push("기간 안에 영업일이 없음");
  const multiYear = frame.range.start.slice(0, 4) !== frame.range.end.slice(0, 4);
  const label = (k) => (multiYear ? `${k.slice(2, 4)}/${mmdd(k)}` : mmdd(k));
  const ctx = { ...frame, errors, label, index: new Map(days.map((k, i) => [k, i])) };
  const gates = gatesOf(plan, ctx);
  const rows = rowsOf(plan, ctx);
  const legend = legendOf(plan, frame.parts, gates, errors);
  const notes = notesOf(plan, errors);
  const model = {
    title: titleOf(plan, frame.range, days.length),
    sheet: str(plan.sheet || "WBS 간트"),
    head: HEAD,
    days: days.map((k) => ({ key: k, label: mmdd(k), dow: dowName(k) })),
    weeks: weeks(days),
    gates,
    rows,
    legend,
    notes,
  };
  tooLong(model, errors);
  return { errors, warnings, model: errors.length ? null : model };
}
