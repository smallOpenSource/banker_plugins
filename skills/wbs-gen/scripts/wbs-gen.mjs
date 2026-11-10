#!/usr/bin/env node
/**
 * wbs-gen.mjs: the helper the wbs-gen skill runs. It turns a WBS plan (JSON) into a Gantt sheet as XLSX and/or a
 * self-contained HTML file. Pure Node, no dependencies; only `holidays` uses the network.
 *
 *   node wbs-gen.mjs example                                  print a sample plan (JSON)
 *   node wbs-gen.mjs holidays --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--timeout <s>] [--ics <file> | --url <https URL>]
 *   node wbs-gen.mjs check --plan <plan.json> [--holidays "<M/D, M/D>"]
 *   node wbs-gen.mjs build --plan <plan.json> --out <file.xlsx|file.html>... [--holidays "<M/D, M/D>"] [--force]
 *
 * - holidays prints `MM/DD 이름` lines and a last line `HOLIDAYS MM/DD, MM/DD` (`HOLIDAYS 없음` when there are none)
 *   from Google's public Korean holiday calendar (공휴일 only, not 기념일). --ics reads a saved calendar file instead;
 *   --url reads another iCalendar URL in the same form (a mirror).
 * - --holidays replaces the plan's holidays; it takes 'M/D' or 'YYYY-MM-DD' items, or 없음.
 * - build checks every --out first (kind, duplicates, existing files), then writes each through a random temporary
 *   name: a hard link (or an exclusive copy) puts it in place, so a file that appears meanwhile is never replaced;
 *   --force renames over an existing file instead.
 * - holidays prints MM/DD within one year and YYYY-MM-DD when --from and --to are in different years.
 *
 * Exit status: 0 done, 1 the plan has errors, 2 usage error or a file that could not be read or written,
 * 3 the holiday calendar could not be reached (ask the user for the holidays instead).
 */
import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keyMs, mmdd } from "./wg-dates.mjs";
import { fetchText, ICS_URL, parseIcs, publicHolidays } from "./wg-holidays.mjs";
import { toHtml } from "./wg-html.mjs";
import { layout } from "./wg-plan.mjs";
import { toXlsx } from "./wg-xlsx.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "..", "assets", "example.json");

class Usage extends Error {}

/** Reads --name value pairs; flags listed in bools take no value; --out may repeat. */
export function parseArgs(argv, bools = ["force"]) {
  const out = { _: [], out: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (bools.includes(name)) {
      out[name] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Usage(`--${name} 에 값이 없음`);
    if (name === "out") out.out.push(v);
    else out[name] = v;
  }
  return out;
}

function readPlan(args) {
  if (!args.plan) throw new Usage("--plan <plan.json> 이 필요함");
  let plan;
  try {
    plan = JSON.parse(readFileSync(args.plan, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new Usage(`plan 을 읽지 못함: ${e.message}`);
  }
  if (args.holidays !== undefined && plan && typeof plan === "object") plan.holidays = args.holidays;
  return plan;
}

function report(res) {
  for (const w of res.warnings) process.stderr.write(`경고: ${w}\n`);
  for (const e of res.errors) process.stderr.write(`오류: ${e}\n`);
}

function summary(m) {
  const tasks = m.rows.filter((r) => r.kind === "task").length;
  const marks = m.rows.reduce((n, r) => n + r.diamonds.length, 0);
  const span = `${m.days[0].key} ~ ${m.days[m.days.length - 1].key}`;
  return `영업일 ${m.days.length} (${span}), 주 ${m.weeks.length}, 행 ${m.rows.length}, 작업 ${tasks}, ◆ ${marks}, 게이트 ${m.gates.length}`;
}

function cmdCheck(args) {
  const res = layout(readPlan(args));
  report(res);
  if (!res.model) return 1;
  process.stdout.write(`OK ${summary(res.model)}\n`);
  return 0;
}

/** Puts tmp at target without replacing a file that appeared meanwhile (link, else an exclusive copy). */
function placeNew(tmp, target) {
  try {
    linkSync(tmp, target);
  } catch (e) {
    if (e.code === "EEXIST") throw e;
    copyFileSync(tmp, target, constants.COPYFILE_EXCL);
  }
  rmSync(tmp, { force: true });
}

function writeOut(target, data, force) {
  const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.wbs-gen.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    if (force) renameSync(tmp, target);
    else placeNew(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    const why = e.code === "EEXIST" ? "이미 있음(덮어쓰려면 --force)" : e.message;
    throw new Usage(`쓰지 못함 ${target}: ${why}`);
  }
  return target;
}

/** Checks every output before any is written: kind, duplicates, and (without --force) files already there. */
function targetsOf(args) {
  if (!args.out.length) throw new Usage("--out <파일.xlsx|파일.html> 이 필요함");
  const targets = args.out.map((f) => ({ path: resolve(f), kind: extname(f).toLowerCase() }));
  const bad = targets.filter((x) => ![".xlsx", ".html", ".htm"].includes(x.kind));
  if (bad.length) throw new Usage(`--out 은 .xlsx 나 .html 이어야 함: ${bad.map((x) => x.path).join(", ")}`);
  if (new Set(targets.map((x) => x.path)).size !== targets.length) throw new Usage("--out 에 같은 파일이 두 번 있음");
  const there = targets.filter((x) => existsSync(x.path));
  if (there.length && !args.force) throw new Usage(`이미 있음(덮어쓰려면 --force): ${there.map((x) => x.path).join(", ")}`);
  return targets;
}

function cmdBuild(args) {
  const targets = targetsOf(args);
  const res = layout(readPlan(args));
  report(res);
  if (!res.model) return 1;
  for (const x of targets) {
    const data = x.kind === ".xlsx" ? toXlsx(res.model) : toHtml(res.model);
    process.stdout.write(`WROTE ${writeOut(x.path, data, args.force)}\n`);
  }
  process.stdout.write(`OK ${summary(res.model)}\n`);
  return 0;
}

function holidayArgs(args) {
  const { from, to } = args;
  if (keyMs(from) === null || keyMs(to) === null || to < from) throw new Usage("--from, --to 는 YYYY-MM-DD 이고 from <= to 여야 함");
  const seconds = Number(args.timeout ?? 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Usage("--timeout 은 1~60 사이 정수(초)");
  if (args.url && !/^https:\/\//.test(args.url)) throw new Usage("--url 은 https:// 로 시작해야 함");
  return { from, to, ms: seconds * 1000 };
}

/** The calendar text, or null when it cannot be reached (the caller asks the user instead). */
async function calendarText(args, ms) {
  if (args.ics) {
    try {
      return readFileSync(args.ics, "utf8");
    } catch (e) {
      throw new Usage(`ics 를 읽지 못함: ${e.message}`);
    }
  }
  try {
    return await fetchText(args.url || ICS_URL, ms);
  } catch (e) {
    process.stderr.write(`공휴일 달력에 닿지 못함(${e.message}). ${ASK}\n`);
    return null;
  }
}

const ASK = "사용자에게 공휴일을 'M/D, M/D' 로 받으십시오.";

async function cmdHolidays(args) {
  const { from, to, ms } = holidayArgs(args);
  const text = await calendarText(args, ms);
  if (text === null) return 3;
  const items = parseIcs(text);
  // A calendar with events but not one 공휴일 means its wording changed: do not report "no holidays".
  if (!items.some((h) => h.isPublic)) {
    process.stderr.write(`공휴일 달력에서 공휴일을 읽지 못함. ${ASK}\n`);
    return 3;
  }
  const days = publicHolidays(items, from, to);
  // Within one year a month/day is enough; across years the full date keeps 2026 and 2027 apart.
  const show = from.slice(0, 4) === to.slice(0, 4) ? mmdd : (k) => k;
  for (const d of days) process.stdout.write(`${show(d.key)} ${d.name}\n`);
  process.stdout.write(`HOLIDAYS ${days.length ? days.map((d) => show(d.key)).join(", ") : "없음"}\n`);
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (cmd === "example") {
    process.stdout.write(readFileSync(EXAMPLE, "utf8"));
    return 0;
  }
  if (cmd === "holidays") return cmdHolidays(args);
  if (cmd === "check") return cmdCheck(args);
  if (cmd === "build") return cmdBuild(args);
  throw new Usage("명령: example | holidays | check | build");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`${e instanceof Usage ? "" : "내부 오류: "}${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
