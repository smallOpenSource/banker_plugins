// wg-plan.mjs: reads a wbs-gen plan (JSON), checks it and lays it out as one model that the XLSX and HTML writers
// both draw. Nothing here touches the network or the disk.
// Two units. A plan longer than two calendar days has a column per working day. A plan of at most two calendar days
// (start and end at most one day apart) has a column per hour, every hour of the period (weekends, holidays and nights
// are not left out), so 48 columns at most. A date may carry a time ('YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM',
// 'M/D HH:MM'); the day unit reads the date part only, so one plan file works in both units.
import { addDays, businessDays, daysBetween, dowName, keyMs, mmdd, parseHolidays, resolveDate, splitTime, weeks } from "./wg-dates.mjs";

export const HEAD = ["WBS", "작업", "담당", "우선순위", "선행·미확정", "시작", "종료", "일수\n(영업일)"];
export const HEAD_HOUR = [...HEAD.slice(0, 7), "시간"];
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
const pad = (n) => String(n).padStart(2, "0");
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

/** start and end: { start, end } date keys and { startMin, endMin } minutes of the day (null without a time). */
function readRange(plan, errors) {
  const s = splitTime(plan.start);
  const e = splitTime(plan.end);
  const range = { start: s.date, end: e.date, startMin: s.min, endMin: e.min };
  if (s.bad || e.bad || keyMs(range.start) === null || keyMs(range.end) === null) {
    errors.push("start, end 는 YYYY-MM-DD 나 YYYY-MM-DD HH:MM 이어야 함");
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

/** Holidays of a day-unit plan. The hour unit shows every hour, so holidays given there are only warned about. */
function readHolidays(plan, range, hour, errors, warnings) {
  const h = parseHolidays(plan.holidays ?? [], range);
  if (hour) {
    const given = [...h.keys, ...h.outside, ...h.bad, ...h.ambiguous];
    if (given.length) warnings.push(`시간 단위(기간 2일 이내)는 모든 시간을 보여 공휴일을 쓰지 않음: ${given.join(", ")}`);
    return new Set();
  }
  if (h.bad.length) errors.push(`공휴일을 날짜로 읽지 못함: ${h.bad.join(", ")}`);
  if (h.ambiguous.length) errors.push(`기간 안 두 해에 걸리는 M/D: ${h.ambiguous.join(", ")}. YYYY-MM-DD 로 적으십시오`);
  if (h.outside.length) warnings.push(`기간 밖 공휴일은 뺌: ${h.outside.join(", ")}`);
  return h.keys;
}

/** Checks the plan's frame (title, range, unit, holidays, parts, bars). */
function readFrame(plan, errors, warnings) {
  if (!str(plan.title).trim()) errors.push("title 이 없음");
  const range = readRange(plan, errors);
  if (!range) return null;
  const hour = daysBetween(range.start, range.end) <= 1;
  if (hour && hourBounds(range).n <= 0) {
    errors.push("end 가 start 보다 앞서거나 같음");
    return null;
  }
  const holidays = readHolidays(plan, range, hour, errors, warnings);
  return { range, hour, holidays, parts: readParts(obj(plan.parts), errors), bars: readBars(obj(plan.bars), errors) };
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

/** A plan date (a time of day allowed) inside the range: { key, min } (min null without a time), or null with an error. */
function dateOf(text, what, ctx) {
  const t = splitTime(text);
  const r = t.bad ? null : resolveDate(t.date, ctx.range);
  if (!r) ctx.errors.push(`${what}: 날짜로 읽지 못함 (${str(text)})`);
  else if (r.ambiguous) ctx.errors.push(`${what}: ${str(text)} 가 기간 안 두 해에 걸림. YYYY-MM-DD 로 적으십시오`);
  else if (!r.inRange) ctx.errors.push(`${what}: 기간 밖 (${r.key})`);
  else return { key: r.key, min: t.min };
  return null;
}

// ---------- day unit ----------

/** A plan date as a key inside the range that is a working day (a time part is dropped), or null with an error. */
function workday(text, what, ctx) {
  const d = dateOf(text, what, ctx);
  if (d && ctx.index.get(d.key) === undefined) ctx.errors.push(`${what}: 주말이나 공휴일 (${d.key} ${dowName(d.key)})`);
  else if (d) return d.key;
  return null;
}

/** The column of a milestone or gate date: { key, col, at } (at: the date as the legend shows it), or null. */
function dayPoint(text, what, ctx) {
  const key = workday(text, what, ctx);
  return key && { key, col: ctx.index.get(key), at: mmdd(key) };
}

/** Start and end of a task or constraint: { from, to, first, last } (columns, start and end cell text); a row may give date alone. */
function daySpan(row, what, ctx) {
  const s = workday(row.start ?? row.date, `${what} 시작`, ctx);
  const e = workday(row.end ?? row.start ?? row.date, `${what} 종료`, ctx);
  if (s && e && e < s) {
    ctx.errors.push(`${what}: 종료가 시작보다 앞섬`);
    return null;
  }
  return s && e ? { from: ctx.index.get(s), to: ctx.index.get(e), first: ctx.label(s), last: ctx.label(e) } : null;
}

/** One column per working day, grouped by calendar week. */
function dayUnit(range, holidays, errors) {
  const days = businessDays(range.start, range.end, holidays);
  if (!days.length) errors.push("기간 안에 영업일이 없음");
  const multiYear = range.start.slice(0, 4) !== range.end.slice(0, 4);
  const endText = multiYear ? range.end : mmdd(range.end);
  return {
    name: "day",
    head: HEAD,
    index: new Map(days.map((k, i) => [k, i])),
    label: (k) => (multiYear ? `${k.slice(2, 4)}/${mmdd(k)}` : mmdd(k)),
    days: days.map((k) => ({ key: k, label: mmdd(k), dow: dowName(k) })),
    weeks: weeks(days),
    title: `${range.start}(${dowName(range.start)}) ~ ${endText}(${dowName(range.end)})`,
    count: `${days.length} 영업일`,
    point: dayPoint,
    span: daySpan,
  };
}

// ---------- hour unit ----------

/**
 * Minutes from 00:00 of the first day. A date alone is its first minute inside the period (edge 'start') or its last
 * (edge 'end'), so a date-only row on the first or the last day stays inside the period.
 */
function minuteOf(text, what, edge, ctx) {
  const d = dateOf(text, what, ctx);
  if (!d) return null;
  const day = daysBetween(ctx.range.start, d.key) * 1440;
  if (d.min !== null) return day + d.min;
  const u = ctx.unit;
  return edge === "end" ? Math.min(day + 1440, (u.first + u.n) * 60) : Math.max(day, u.first * 60);
}

/** The slot of a minute: a start floors to its hour; an end (the minute the work stops) takes the slot before it. */
function slotOf(min, edge, text, what, ctx) {
  const col = (edge === "end" ? Math.ceil(min / 60) - 1 : Math.floor(min / 60)) - ctx.unit.first;
  if (col >= 0 && col < ctx.unit.n) return col;
  ctx.errors.push(`${what}: 기간 밖 (${str(text)})`);
  return null;
}

function hourPoint(text, what, ctx) {
  const min = minuteOf(text, what, "start", ctx);
  const col = min === null ? null : slotOf(min, "start", text, what, ctx);
  return col === null ? null : { key: ctx.unit.days[col].key, col, at: ctx.unit.slotText(col) };
}

function hourSpan(row, what, ctx) {
  const sText = row.start ?? row.date;
  const eText = row.end ?? sText;
  const s = minuteOf(sText, `${what} 시작`, "start", ctx);
  const e0 = minuteOf(eText, `${what} 종료`, "end", ctx);
  if (s === null || e0 === null) return null;
  // One time and no end (a constraint's date, a one-hour task) covers the hour it falls in.
  const e = row.end === undefined && e0 === s ? s + 1 : e0;
  if (e <= s) {
    ctx.errors.push(`${what}: 종료가 시작보다 앞서거나 같음`);
    return null;
  }
  const from = slotOf(s, "start", sText, `${what} 시작`, ctx);
  const to = slotOf(e, "end", eText, `${what} 종료`, ctx);
  return from === null || to === null ? null : { from, to, first: ctx.unit.slotText(from), last: ctx.unit.edgeText(to) };
}

/** Hour slots grouped by calendar day: [{ n, label: 'MM/DD(요일)', first, count }]. */
function dayGroups(slots) {
  const out = [];
  slots.forEach((t, i) => {
    const last = out[out.length - 1];
    if (last && last.key === t.key) last.count++;
    else out.push({ key: t.key, n: out.length + 1, label: `${mmdd(t.key)}(${dowName(t.key)})`, first: i, count: 1 });
  });
  return out.map(({ key, ...g }) => g);
}

/**
 * The hour slots of a period: the first (hours from 00:00 of the first day) and how many. The start floors to its hour
 * and the end rises to the next hour (a date alone ends at 24:00). Two calendar days at most, so 48 slots at most.
 */
function hourBounds(range) {
  const first = Math.floor((range.startMin ?? 0) / 60);
  const end = Math.ceil((daysBetween(range.start, range.end) * 1440 + (range.endMin ?? 1440)) / 60);
  return { first, n: end - first };
}

/** One column per hour of the period, every hour shown. Slot h covers [h:00, h+1:00). */
function hourUnit(range) {
  const { first, n } = hourBounds(range);
  const multiYear = range.start.slice(0, 4) !== range.end.slice(0, 4);
  // Hour h from 00:00 of the first day as { key, hh }; an edge (the end of a slot) at 24:00 stays on its own day.
  const at = (h, edge) => {
    const d = Math.floor((edge ? h - 1 : h) / 24);
    return { key: addDays(range.start, d), hh: h - d * 24 };
  };
  const dayText = (k) => (multiYear ? `${k.slice(2, 4)}/${mmdd(k)}` : mmdd(k));
  const text = (h, edge) => `${dayText(at(h, edge).key)} ${pad(at(h, edge).hh)}:00`;
  const slots = Array.from({ length: n }, (_, i) => at(first + i, false));
  const last = at(first + n, true);
  const endDay = multiYear ? last.key : mmdd(last.key);
  return {
    name: "hour",
    head: HEAD_HOUR,
    first,
    n,
    days: slots.map((t) => ({ key: `${t.key}T${pad(t.hh)}:00`, label: `${pad(t.hh)}:00`, dow: "" })),
    weeks: dayGroups(slots),
    title: `${range.start}(${dowName(range.start)}) ${pad(first)}:00 ~ ${endDay}(${dowName(last.key)}) ${pad(last.hh)}:00`,
    count: `${n} 시간`,
    slotText: (col) => text(first + col, false),
    edgeText: (col) => text(first + col + 1, true),
    point: hourPoint,
    span: hourSpan,
  };
}

// ---------- rows ----------

function gatesOf(plan, ctx) {
  return list(plan, "gates", ctx.errors).map((g, i) => {
    const p = ctx.unit.point(obj(g).date, `gates[${i}]`, ctx);
    return p && { ...p, label: str(obj(g).label) };
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
    const p = ctx.unit.point(row.date ?? row.start, what, ctx);
    return { ...out, diamonds: p ? [p.col] : [] };
  }
  return laySpan(row, kind, part, what, ctx, out);
}

function laySpan(row, kind, part, what, ctx, out) {
  const span = ctx.unit.span(row, what, ctx);
  if (!span) return out;
  const { from, to } = span;
  const cells = cellsOf(row, [span.first, span.last, to - from + 1]);
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
  for (const g of gates) items.push({ type: "gate", color: "C0392B", label: `${g.label || "게이트"}(빨간 수직선 = ${g.at})` });
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

function titleOf(plan, span, count) {
  return [str(plan.title).trim(), span, count, str(plan.subtitle).trim()].filter(Boolean).join("    |    ");
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
 * model: { unit: 'day' | 'hour', title, sheet, head, days: [{ key, label, dow }], weeks: [{ label, first, count }],
 * gates, rows, legend, notes }. In the hour unit days are hour slots (label '11:00', dow '') and weeks are calendar days
 * (label '11/25(화)').
 */
export function layout(plan) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { errors: ["plan 은 JSON 객체여야 함"], warnings, model: null };
  const frame = readFrame(plan, errors, warnings);
  if (!frame) return { errors, warnings, model: null };
  const unit = frame.hour ? hourUnit(frame.range) : dayUnit(frame.range, frame.holidays, errors);
  const ctx = { ...frame, errors, unit, label: unit.label, index: unit.index };
  const gates = gatesOf(plan, ctx);
  const rows = rowsOf(plan, ctx);
  const legend = legendOf(plan, frame.parts, gates, errors);
  const notes = notesOf(plan, errors);
  const model = {
    unit: unit.name,
    title: titleOf(plan, unit.title, unit.count),
    sheet: str(plan.sheet || "WBS 간트"),
    head: unit.head,
    days: unit.days,
    weeks: unit.weeks,
    gates,
    rows,
    legend,
    notes,
  };
  tooLong(model, errors);
  return { errors, warnings, model: errors.length ? null : model };
}
