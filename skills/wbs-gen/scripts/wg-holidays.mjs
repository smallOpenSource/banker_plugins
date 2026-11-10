// wg-holidays.mjs: Korean public holidays from Google's public calendar (iCalendar, no key). Only events whose
// description starts with 공휴일 count; the calendar also lists observances (기념일) that are working days.
// When the calendar cannot be reached (an air-gapped network, a proxy Node does not use), the skill asks the user
// for the holidays as 'M/D, M/D' instead. Nothing here is cached or written.
import { get } from "node:https";
import { addDays, keyMs } from "./wg-dates.mjs";

export const ICS_URL =
  "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";
const MAX_BYTES = 4 * 1024 * 1024;

/** Fetches a URL as text within timeoutMs (redirects followed up to 3 times). Rejects on any failure. */
export function fetchText(url, timeoutMs, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { "user-agent": "wbs-gen" } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 3) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).href, timeoutMs, hops + 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`HTTP ${code}`));
        return;
      }
      readBody(res, resolve, reject);
    });
    // One timer for the whole exchange: a server that sends a little at a time is cut at the same limit.
    const timer = setTimeout(() => req.destroy(new Error(`${Math.round(timeoutMs / 1000)}초 안에 끝나지 않음`)), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}

function readBody(res, resolve, reject) {
  const chunks = [];
  let size = 0;
  res.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) res.destroy(new Error("응답이 너무 큼"));
    else chunks.push(c);
  });
  res.on("error", reject);
  res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
}

const unescape = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

function field(block, name) {
  const m = new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, "m").exec(block);
  return m ? unescape(m[1].trim()) : "";
}

const icsDate = (v) => {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/**
 * Reads iCalendar text. Returns [{ key, name, isPublic }], one item per day (DTEND is exclusive), sorted by date.
 */
export function parseIcs(text) {
  const unfolded = String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out = [];
  for (const m of unfolded.matchAll(/BEGIN:VEVENT\n([\s\S]*?)END:VEVENT/g)) {
    const start = icsDate(field(m[1], "DTSTART"));
    if (!start || keyMs(start) === null) continue;
    const endRaw = icsDate(field(m[1], "DTEND"));
    const end = endRaw && keyMs(endRaw) !== null && endRaw > start ? endRaw : addDays(start, 1);
    const name = field(m[1], "SUMMARY");
    const isPublic = /^공휴일/.test(field(m[1], "DESCRIPTION"));
    for (let k = start; k < end && out.length < 100000; k = addDays(k, 1)) out.push({ key: k, name, isPublic });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Public holidays from start to end inclusive, one per day (names of the same day joined with ' / '). */
export function publicHolidays(items, start, end) {
  const byDay = new Map();
  for (const h of items) {
    if (!h.isPublic || h.key < start || h.key > end) continue;
    const names = byDay.get(h.key) ?? [];
    if (!names.includes(h.name)) names.push(h.name);
    byDay.set(h.key, names);
  }
  return [...byDay].map(([key, names]) => ({ key, name: names.join(" / ") }));
}
