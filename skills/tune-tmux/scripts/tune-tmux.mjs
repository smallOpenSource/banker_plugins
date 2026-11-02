#!/usr/bin/env node
/**
 * tune-tmux: puts one marked block into the tmux (or psmux) config so mouse drag copies to the OS clipboard and
 * PageUp scrolls tmux history, while Claude Code and Codex full-screen views keep their own keys.
 *
 *   node tune-tmux.mjs [status|on|off] [--target auto|tmux|psmux] [--conf <path>] [--follow-symlink]
 *                      [--force-drag] [--reload] [--socket <name>] [--dry-run] [--json]
 *
 * - tmux: the block sets mouse on, set-clipboard on, the clipboard command (copy-command on 3.2 and later,
 *   copy-pipe on older) and a PageUp binding that enters copy-mode only on the normal screen. The root
 *   MouseDrag1Pane default (an app that grabs the mouse gets the drag) is kept unless --force-drag.
 * - psmux: only lines psmux-caps.json marks verified and not already psmux defaults. Today that is none, so psmux
 *   gets no block. on says so with the counts of unverified and broken behaviors (exit 0 is not "all works"), and
 *   takes out an old block left in that file, as off does.
 * - marker-block.mjs refuses links (unless --follow-symlink), hard links, other owners, broken markers and files
 *   that are not UTF-8; a refusal changes nothing. The first original is kept in <conf>.tune-tmux.bak.
 * - Claude Code and Codex settings are never read or written.
 *
 * Exit status: 0 done (nothing to change included), 1 refused, write or reload failed, 2 usage error,
 * 3 environment (on or off with neither tmux nor psmux). No network is used.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HASH, commitBlock, markers, planBlock } from "./marker-block.mjs";
import * as tc from "./tmux-config.mjs";
import { appRows } from "./app-notes.mjs";

// The folder programs start in: the home folder (Windows looks for a program in the working folder first, so a
// program planted in the folder worked on never runs), or the temp folder when there is no home folder.
const runDir = () => (existsSync(homedir()) ? homedir() : tmpdir());

const USAGE = [
  "tune-tmux: tmux, psmux 설정에 표지 블록을 넣고 빼서 마우스 드래그 복사와 PageUp/PageDown 스크롤을 맞춤",
  "사용법: node tune-tmux.mjs [status|on|off] [--target auto|tmux|psmux] [--conf <경로>] [--follow-symlink] [--force-drag] [--reload] [--socket <이름>] [--dry-run] [--json]",
  "종료 코드: 0 성공(바뀐 것 없음 포함), 1 거부나 쓰기, 반영 실패, 2 사용 오류, 3 환경(on, off 인데 tmux, psmux 둘 다 없음)",
].join("\n");

const ID = "banker:tune-tmux";
const SKILL = "tune-tmux";
const MK = markers(HASH, ID);
const FLAGS = { "--follow-symlink": "follow", "--force-drag": "forceDrag", "--reload": "reload", "--dry-run": "dryRun", "--json": "json", "--help": "help", "-h": "help" };
const VALUES = { "--target": "target", "--conf": "conf", "--socket": "socket" };
const SUBCOMMANDS = new Set(["status", "on", "off"]);
const fail = (code, error) => ({ code, error });

function splitArg(a) {
  const eq = a.indexOf("=");
  return a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
}

/** The options in argv, or { error } (exit 2). */
export function parseArgs(argv) {
  const o = { cmd: "status", target: "auto", conf: null, socket: null, follow: false, forceDrag: false, reload: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = splitArg(argv[i]);
    if (FLAGS[name] && inline === undefined) o[FLAGS[name]] = true;
    else if (VALUES[name]) {
      const value = inline ?? argv[++i];
      if (!value) return { error: `${name} 에 값이 없음` };
      o[VALUES[name]] = value;
    } else if (i === 0 && SUBCOMMANDS.has(name)) o.cmd = name;
    else return { error: `모르는 인자: ${argv[i]}` };
  }
  if (!["auto", "tmux", "psmux"].includes(o.target)) return { error: `--target 은 auto, tmux, psmux: ${o.target}` };
  return o;
}

const loadCaps = () => JSON.parse(readFileSync(new URL("./psmux-caps.json", import.meta.url), "utf8"));

function defaults(deps) {
  const env = deps.env ?? process.env;
  // from the home folder: Windows looks for tmux or psmux in the working folder first
  const exec = (cmd, args) => spawnSync(cmd, args, { cwd: runDir(), encoding: "utf8", env, timeout: 15000, windowsHide: true });
  return { env, platform: process.platform, exec, caps: null, ...deps };
}

// tmux and psmux as installed. On Windows the tmux command may be psmux (its -V says so on line 2).
function detectTools(want, platform, exec) {
  const tmux = tc.toolVersion(exec, "tmux");
  const psmux = platform === "win32" || want === "psmux" ? tc.toolVersion(exec, "psmux") : null;
  return { tmux, psmux: psmux ?? (tmux?.kind === "psmux" ? tmux : null) };
}

/** The target and its tool: auto is psmux on Windows (tmux when there is no psmux), tmux elsewhere. */
function resolveTarget(want, platform, exec) {
  const { tmux, psmux } = detectTools(want, platform, exec);
  if (want === "psmux" || (want === "auto" && platform === "win32" && psmux !== null)) return { target: "psmux", tool: psmux, warnings: [] };
  if (tmux?.kind === "psmux") return { target: "psmux", tool: tmux, warnings: ["경고: tmux 명령이 psmux 라 psmux 로 처리"] };
  return { target: "tmux", tool: tmux, warnings: [] };
}

// The block lines this machine wants for tmux, after a probe of #{||:} on a private server.
function tmuxWanted(tool, o, d) {
  const clipboard = tc.pickClipboard({ platform: d.platform, env: d.env, has: (n) => tc.which(n, d.env, d.platform) });
  const probe = tc.probeConditional(d.exec, tool.bin);
  const body = tc.tmuxBody({ version: tool, clipboard, conditional: probe.ok, forceDrag: o.forceDrag });
  if (probe.reason) body.omitted.push({ what: "PageUp", reason: probe.reason });
  return { ...body, clipboard };
}

// Everything worked out before a write: target, tool, config file, block lines, warnings.
function context(o, d) {
  const t = resolveTarget(o.target, d.platform, d.exec);
  if (!t.tool && o.cmd !== "status") return fail(3, `${t.target} 미설치. banker setup-tmux 로 먼저 설치`);
  const home = tc.homeOf(d.env, d.platform);
  const toolPath = t.tool ? tc.which(t.tool.bin, d.env, d.platform) : null;
  const ctx = { ...t, home, toolPath, warnings: [...t.warnings] };
  if (t.target === "psmux") {
    const body = tc.psmuxBody(d.caps ?? loadCaps(), o.forceDrag);
    return { ...ctx, conf: tc.choosePsmuxConf(d.env, home, o.conf), ...body, clipboard: null };
  }
  const conf = tc.chooseTmuxConf(t.tool, d.env, home, o.conf);
  const reads = tc.tmuxReads(t.tool, d.env, home);
  if (o.conf && !reads.some((f) => tc.sameFile(f, conf))) ctx.warnings.push(`경고: tmux 가 스스로 읽지 않는 파일: ${conf}. tmux -f 나 source-file 로 불러야 적용됨`);
  ctx.warnings.push(...tc.conflictsIn(reads.filter((f) => !tc.sameFile(f, conf))));
  const body = t.tool ? tmuxWanted(t.tool, o, d) : { lines: [], omitted: [], clipboard: null };
  return { ...ctx, conf, ...body };
}

const planOf = (ctx, body, o) => planBlock(ctx.conf, { comment: HASH, id: ID, body, skill: SKILL, followSymlink: o.follow });

// absent, current, stale or refused:<code>, from two dry plans (take out, put in).
function blockState(ctx, o) {
  const out = planOf(ctx, null, o);
  if (!out.ok) return `refused:${out.refused}`;
  if (!out.changed) return "absent";
  if (ctx.lines.length === 0) return "present";
  return planOf(ctx, ctx.lines.join("\n"), o).changed ? "stale" : "current";
}

function status(ctx, o) {
  const state = ctx.tool ? blockState(ctx, o) : "unknown";
  return { code: 0, report: { ...reportOf(ctx, "status", o), state, apps: appRows(ctx.target) } };
}

function reportOf(ctx, command, o) {
  const tool = ctx.tool ? { kind: ctx.tool.kind, version: ctx.tool.raw, bin: ctx.tool.bin, path: ctx.toolPath } : null;
  return { ok: true, command, target: ctx.target, tool, conf: ctx.conf, dryRun: o.dryRun, lines: ctx.lines, omitted: ctx.omitted, clipboard: ctx.clipboard, warnings: ctx.warnings };
}

// on with zero lines (psmux): what the defaults do, what is unverified, what does not work. Exit 0 means the file
// was handled, not that every behavior works, so the counts stay on the result.
function noLines(ctx) {
  const b = ctx.behavior ?? { default: [], unverified: [], broken: [] };
  return { psmux: b, note: `넣은 줄 0: psmux 기본값 유지. 미확인 ${b.unverified.length}, 안 됨 ${b.broken.length}` };
}

// The report of an on with zero lines that took out an old block: the counts note, and what was taken out.
function removedOld(out, ctx) {
  const removed = `넣을 줄이 0개라 옛 tune-tmux 블록을 ${out.dryRun ? "뺄 예정" : "뺌"}(off 와 같음)${out.note ? `. ${out.note}` : ""}`;
  return { ...out, ...noLines(ctx), removed };
}

// on or off: plan, write unless dry-run, then reload when asked. on with zero lines takes out an old block as off.
function change(ctx, o, d) {
  const none = o.cmd === "on" && ctx.lines.length === 0;
  const plan = planOf(ctx, o.cmd === "off" || none ? null : ctx.lines.join("\n"), o);
  if (!plan.ok) return fail(1, `${plan.message}. 아무것도 바꾸지 않음`);
  if (none && !plan.changed) return { code: 0, report: { ...reportOf(ctx, o.cmd, o), changed: false, ...noLines(ctx) } };
  const done = o.dryRun ? plan : commitBlock(plan, SKILL);
  if (!done.ok) return fail(1, `${done.message}. 아무것도 바꾸지 않음`);
  return reloaded(ctx, plan, o, d, none ? removedOld(written(ctx, o, plan, done), ctx) : written(ctx, o, plan, done));
}

// The written report, applied to a running server when --reload asks (not on a dry run).
function reloaded(ctx, plan, o, d, out) {
  if (!o.reload || o.dryRun) return { code: 0, report: out };
  const reload = reloadServer(ctx, plan, o, d);
  if (reload.error) return fail(1, `파일은 ${plan.changed ? "바꿨음" : "그대로"}. 떠 있는 서버 반영 실패: ${reload.error}`);
  return { code: 0, report: { ...out, reload } };
}

// What the write (or the dry-run plan) did, as the report says it.
function written(ctx, o, plan, done) {
  const empty = (o.cmd === "off" || ctx.lines.length === 0) && plan.changed && plan.after?.length === 0;
  const note = empty ? "블록만 있던 파일이라 빈 파일로 남김" : null;
  return { ...reportOf(ctx, o.cmd, o), changed: plan.changed, created: done.created === true, backup: done.backup ?? null, note };
}

// Sources each file into the server in turn; { error } at the first that fails.
function sourceAll(d, bin, base, files) {
  for (const f of files) {
    const r = d.exec(bin, [...base, "source-file", f]);
    if (r.error || r.status !== 0) return { error: `source-file ${f}: ${tc.firstLine(r)}` };
  }
  return {};
}

/**
 * Applies the file to a running server: the effect of old block lines not in the new block is taken out (options
 * unset, keys back to the defaults of a fresh server), then the whole config file is sourced again.
 */
function reloadServer(ctx, plan, o, d) {
  const bin = ctx.tool.bin;
  const base = o.socket ? ["-L", o.socket] : [];
  const oldLines = plan.before ? tc.blockLinesOf(plan.before.toString("utf8"), MK) : [];
  const newLines = o.cmd === "off" ? [] : ctx.lines;
  if (oldLines.length === 0 && newLines.length === 0) return { state: "nothing", message: "넣은 줄이 없어 반영할 것 없음" };
  if (d.exec(bin, [...base, "list-sessions"]).status !== 0) return { state: "no-server", message: "떠 있는 서버 없음. 다음 시작 때 적용" };
  const undo = tc.undoCommands(oldLines, newLines, tc.defaultKeys(d.exec, bin, tc.keysOf(oldLines)));
  const dir = mkdtempSync(join(tmpdir(), "tune-tmux-"));
  try {
    writeFileSync(join(dir, "undo.conf"), `${undo.join("\n")}\n`);
    const r = sourceAll(d, bin, base, undo.length ? [join(dir, "undo.conf"), ctx.conf] : [ctx.conf]);
    if (r.error) return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { state: "reloaded", undone: undo, message: undo.length ? `반영함(되돌린 설정 ${undo.length}개)` : "반영함" };
}

const STATE_WORDS = { absent: "없음", current: "최신", stale: "낡음(on 으로 갱신)", present: "있음(넣을 줄 없음, off 로 뺄 수 있음)", unknown: "미설치라 확인 안 함" };

function headLines(rep) {
  const tool = rep.tool ? `${rep.tool.version}${rep.tool.kind === "psmux" ? " (psmux)" : ""} (${rep.tool.path ?? rep.tool.bin})` : `${rep.target} 미설치(banker setup-tmux 로 설치)`;
  const clip = rep.target === "psmux" ? "psmux 기본(set-clipboard on)" : rep.clipboard ? rep.clipboard.cmd : "외부 클립보드 도구 없음, 터미널의 OSC 52 허용 필요";
  return [`tune-tmux ${rep.command}${rep.dryRun ? " (dry-run, 바꾸지 않음)" : ""}: ${tool}`, `설정 파일: ${rep.conf}`, `클립보드: ${clip}`];
}

function bodyLines(rep) {
  const lines = rep.lines.length ? rep.lines.map((l) => `  ${l}`) : ["  (없음)"];
  const omitted = rep.omitted.map((x) => `  - ${x.what}: ${x.reason}`);
  return ["블록 줄:", ...lines, ...(omitted.length ? ["넣지 않은 줄:", ...omitted] : [])];
}

function resultLine(rep) {
  if (rep.state) return `블록: ${STATE_WORDS[rep.state] ?? `거부(${rep.state.replace("refused:", "")})`}`;
  const verb = rep.dryRun ? "바꿀 예정" : rep.created ? "새로 만듦" : "바꿈";
  const what = rep.changed ? `${verb}: ${rep.conf}${rep.backup ? ` (첫 원본 ${rep.backup})` : ""}` : `변경 없음: ${rep.conf}`;
  return `결과: ${what}`;
}

// The psmux behavior lists under an on with zero lines.
function behaviorLines(rep) {
  if (!rep.psmux) return [];
  const list = (head, xs) => (xs.length ? [head, ...xs.map((x) => `  - ${x}`)] : []);
  const removed = rep.removed ? [rep.removed] : [];
  return [...removed, ...list("psmux 기본값으로 되는 것:", rep.psmux.default), ...list("확인 못 한 것:", rep.psmux.unverified), ...list("안 되는 것:", rep.psmux.broken)];
}

function textOf(rep) {
  const out = [...headLines(rep), resultLine(rep), ...(rep.note ? [rep.note] : []), ...behaviorLines(rep), ...(rep.reload ? [`반영: ${rep.reload.message}`] : [])];
  out.push(...(rep.command === "off" ? [] : bodyLines(rep)), ...rep.warnings);
  if (rep.apps) out.push("", "앱별 동작", "", "| 앱 상태 | PageUp/PageDown | 드래그 |", "|---|---|---|", ...rep.apps.map((a) => `| ${a.state} | ${a.keys} | ${a.drag} |`));
  return out.join("\n");
}

function main(o, d) {
  const ctx = context(o, d);
  if (ctx.error) return ctx;
  return o.cmd === "status" ? status(ctx, o) : change(ctx, o, d);
}

/** Runs tune-tmux with argv; returns { code, stdout, stderr }. deps: { env, platform, exec, caps } for tests. */
export function run(argv, deps = {}) {
  const o = parseArgs(argv);
  if (o.help) return { code: 0, stdout: USAGE, stderr: "" };
  if (o.error) return finish(o, fail(2, `${o.error}\n${USAGE}`));
  try {
    return finish(o, main(o, defaults(deps)));
  } catch (e) {
    return finish(o, fail(1, `쓰기 실패: ${e.message}`));
  }
}

function finish(o, r) {
  if (r.error) {
    const out = o.json ? JSON.stringify({ ok: false, exit: r.code, error: r.error.split("\n")[0] }) : "";
    return { code: r.code, stdout: out, stderr: `tune-tmux: ${r.error}` };
  }
  return { code: r.code, stdout: o.json ? JSON.stringify(r.report) : textOf(r.report), stderr: "" };
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(`${r.stdout}\n`);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exitCode = r.code;
}
