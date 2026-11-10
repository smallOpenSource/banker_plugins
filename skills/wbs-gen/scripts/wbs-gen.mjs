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
 * - build writes each output through a random temporary name and a rename; an existing output is kept unless --force.
 *
 * Exit status: 0 done, 1 the plan has errors, 2 usage error or a file that could not be read or written,
 * 3 the holiday calendar could not be reached (ask the user for the holidays instead).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function writeOut(file, data, force) {
  const target = resolve(file);
  if (existsSync(target) && !force) throw new Usage(`이미 있음(덮어쓰려면 --force): ${target}`);
  const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.wbs-gen.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Usage(`쓰지 못함 ${target}: ${e.message}`);
  }
  return target;
}

function cmdBuild(args) {
  if (!args.out.length) throw new Usage("--out <파일.xlsx|파일.html> 이 필요함");
  const kinds = args.out.map((f) => extname(f).toLowerCase());
  const bad = args.out.filter((_, i) => ![".xlsx", ".html", ".htm"].includes(kinds[i]));
  if (bad.length) throw new Usage(`--out 은 .xlsx 나 .html 이어야 함: ${bad.join(", ")}`);
  const res = layout(readPlan(args));
  report(res);
  if (!res.model) return 1;
  args.out.forEach((f, i) => {
    const data = kinds[i] === ".xlsx" ? toXlsx(res.model) : toHtml(res.model);
    process.stdout.write(`WROTE ${writeOut(f, data, args.force)}\n`);
  });
  process.stdout.write(`OK ${summary(res.model)}\n`);
  return 0;
}

function holidayArgs(args) {
  const { from, to } = args;
  if (keyMs(from) === null || keyMs(to) === null || to < from) throw new Usage("--from, --to 는 YYYY-MM-DD 이고 from <= to 여야 함");
  const seconds = Number(args.timeout ?? 10);
  if (!(seconds > 0 && seconds <= 60)) throw new Usage("--timeout 은 1~60 초");
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
  if (!items.length) {
    process.stderr.write(`공휴일 달력에서 일정을 읽지 못함. ${ASK}\n`);
    return 3;
  }
  const days = publicHolidays(items, from, to);
  for (const d of days) process.stdout.write(`${mmdd(d.key)} ${d.name}\n`);
  process.stdout.write(`HOLIDAYS ${days.length ? days.map((d) => mmdd(d.key)).join(", ") : "없음"}\n`);
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
