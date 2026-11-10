// wg-dates.mjs: dates for wbs-gen. A date is a 'YYYY-MM-DD' key read as a calendar day (UTC math, no time zone).
// Input dates may be 'YYYY-MM-DD' or 'M/D' ('MM/DD'); a month/day takes the year that puts it inside the project.

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

/** One month/day in a year, or null when that day does not exist (2/30, 2/29 of a common year). */
function monthDay(y, m, d) {
  const key = `${y}-${pad(m)}-${pad(d)}`;
  return keyMs(key) === null ? null : key;
}

/**
 * Reads 'YYYY-MM-DD' or 'M/D' against the project range { start, end }.
 * Returns { key, inRange } or null when the text is not a date. A month/day takes the first year from the start
 * year to the end year that puts it inside the range, else the start year (inRange false).
 */
export function resolveDate(text, range) {
  const s = String(text ?? "").trim();
  if (keyMs(s) !== null) return { key: s, inRange: s >= range.start && s <= range.end };
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(s);
  return m ? placeMonthDay(+m[1], +m[2], range) : null;
}

function placeMonthDay(month, day, range) {
  let first = null;
  for (let y = +range.start.slice(0, 4); y <= +range.end.slice(0, 4); y++) {
    const key = monthDay(y, month, day);
    if (key && key >= range.start && key <= range.end) return { key, inRange: true };
    first ??= key;
  }
  return first ? { key: first, inRange: false } : null;
}

/**
 * Reads a holiday list: an array, or text such as "8/17, 10/03" (commas, spaces or new lines between). The words
 * 없음 / none / - mean no holiday. Returns { keys: Set of keys inside the range, outside: [text], bad: [text] }.
 */
export function parseHolidays(list, range) {
  const items = Array.isArray(list) ? list.map(String) : String(list ?? "").split(/[,\s]+/);
  const out = { keys: new Set(), outside: [], bad: [] };
  for (const raw of items) {
    const t = raw.trim();
    if (!t || /^(없음|none|-)$/i.test(t)) continue;
    const r = resolveDate(t, range);
    if (!r) out.bad.push(t);
    else if (r.inRange) out.keys.add(r.key);
    else out.outside.push(t);
  }
  return out;
}

/** The working days from start to end inclusive: Monday to Friday and not in holidays. */
export function businessDays(start, end, holidays = new Set()) {
  const days = [];
  for (let k = start; k <= end; k = addDays(k, 1)) {
    const w = dow(k);
    if (w !== 0 && w !== 6 && !holidays.has(k)) days.push(k);
  }
  return days;
}

/** Groups working days by calendar week (Monday first): [{ label: 'W1', first, count }]. */
export function weeks(days) {
  const out = [];
  let monday = null;
  days.forEach((k, i) => {
    const m = addDays(k, -((dow(k) + 6) % 7));
    if (m !== monday) {
      monday = m;
      out.push({ label: `W${out.length + 1}`, first: i, count: 0 });
    }
    out[out.length - 1].count++;
  });
  return out;
}
