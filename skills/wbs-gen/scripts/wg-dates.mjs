// wg-dates.mjs: dates for wbs-gen. A date is a 'YYYY-MM-DD' key read as a calendar day (UTC math, no time zone).
// Input dates may be 'YYYY-MM-DD' or 'M/D' ('MM/DD'); a month/day takes the year that puts it inside the project,
// and is refused when two years would (a project longer than a year). Either may carry a time of day (splitTime);
// the hour unit of wg-plan.mjs reads it and the day unit drops it.

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const DAY = 86400000;

const pad = (n) => String(n).padStart(2, "0");

/** Milliseconds of a valid 'YYYY-MM-DD' key, or null. */
export function keyMs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return toKey(ms) === key ? ms : null;
}

export function toKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const addDays = (key, n) => toKey(keyMs(key) + n * DAY);
export const dow = (key) => new Date(keyMs(key)).getUTCDay();
export const dowName = (key) => DOW[dow(key)];
export const mmdd = (key) => `${key.slice(5, 7)}/${key.slice(8, 10)}`;
/** Whole days from a to b (keys). */
export const daysBetween = (a, b) => Math.round((keyMs(b) - keyMs(a)) / DAY);

/**
 * Splits a time of day off a plan date: 'YYYY-MM-DDTHH:MM', 'YYYY-MM-DD HH:MM' or 'M/D HH:MM'. Returns { date, min }
 * with min the minutes from 00:00, or null when the text has no time; bad is true for a time past 23:59 (24:00 alone is
 * read as the end of that day, minute 1440). A time is local wall-clock time: no zone, no seconds.
 */
export function splitTime(text) {
  const s = String(text ?? "").trim();
  const m = /^(.+?)(?:T|\s+)(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return { date: s, min: null };
  const min = +m[2] * 60 + +m[3];
  const bad = +m[3] > 59 || min > 1440;
  return { date: m[1].trim(), min: bad ? null : min, bad };
}

/** True for a time copied with a zone or seconds ('...T01:00:00Z', '...10:00+09:00'), which plans do not take. */
export const zoned = (text) => /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$|\d:\d{2}:\d{2}(?:\.\d+)?$/i.test(String(text ?? "").trim());

/** One month/day in a year, or null when that day does not exist (2/30, 2/29 of a common year). */
function monthDay(y, m, d) {
  const key = `${y}-${pad(m)}-${pad(d)}`;
  return keyMs(key) === null ? null : key;
}

/**
 * Reads 'YYYY-MM-DD' or 'M/D' against the project range { start, end }.
 * Returns { key, inRange }, { ambiguous: true } when a month/day falls inside the range in two years, or null when
 * the text is not a date. A month/day outside the range takes the start year (inRange false).
 */
export function resolveDate(text, range) {
  const s = String(text ?? "").trim();
  if (keyMs(s) !== null) return { key: s, inRange: s >= range.start && s <= range.end };
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(s);
  return m ? placeMonthDay(+m[1], +m[2], range) : null;
}

function placeMonthDay(month, day, range) {
  const all = [];
  for (let y = +range.start.slice(0, 4); y <= +range.end.slice(0, 4); y++) all.push(monthDay(y, month, day));
  const keys = all.filter(Boolean);
  const inside = keys.filter((k) => k >= range.start && k <= range.end);
  if (inside.length > 1) return { ambiguous: true };
  if (inside.length) return { key: inside[0], inRange: true };
  return keys.length ? { key: keys[0], inRange: false } : null;
}

/**
 * Reads a holiday list: an array, or text such as "8/17, 10/03" (commas, spaces or new lines between). The words
 * 없음 / none / - mean no holiday. Returns { keys: Set of keys inside the range, outside: [text], bad: [text],
 * ambiguous: [text] }.
 */
export function parseHolidays(list, range) {
  const items = Array.isArray(list) ? list.map(String) : String(list ?? "").split(/[,\s]+/);
  const out = { keys: new Set(), outside: [], bad: [], ambiguous: [] };
  for (const raw of items) {
    const t = raw.trim();
    if (!t || /^(없음|none|-)$/i.test(t)) continue;
    const r = resolveDate(t, range);
    if (!r) out.bad.push(t);
    else if (r.ambiguous) out.ambiguous.push(t);
    else if (r.inRange) out.keys.add(r.key);
    else out.outside.push(t);
  }
  return out;
}

/** The working days from start to end inclusive: Monday to Friday and not in holidays. */
export function businessDays(start, end, holidays = new Set()) {
  const days = [];
  const last = keyMs(end);
  for (let ms = keyMs(start); ms !== null && last !== null && ms <= last; ms += DAY) {
    const k = toKey(ms);
    const w = new Date(ms).getUTCDay();
    if (w !== 0 && w !== 6 && !holidays.has(k)) days.push(k);
  }
  return days;
}

/**
 * Groups working days by calendar week (Monday first): [{ label: 'W<n>', first, count }]. n counts calendar weeks
 * from the week of the first day, so a week with no working day keeps its number.
 */
export function weeks(days) {
  const out = [];
  if (!days.length) return out;
  const monday = (k) => addDays(k, -((dow(k) + 6) % 7));
  const base = monday(days[0]);
  days.forEach((k, i) => {
    const n = daysBetween(base, monday(k)) / 7 + 1;
    const last = out[out.length - 1];
    if (last && last.n === n) last.count++;
    else out.push({ n, label: `W${n}`, first: i, count: 1 });
  });
  return out;
}
