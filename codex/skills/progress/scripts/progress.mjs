#!/usr/bin/env node
/*
 * banker progress (Codex) - 지금 Codex 세션의 진행 상황을 텍스트 트리로 보인다. Claude Code 의 /progress 패널에 해당한다.
 *
 * 읽는 것은 이 세션의 기록(rollout) 하나다. Codex 는 셸에 CODEX_THREAD_ID 를 주고, 그 id 가 rollout 파일 이름 끝에 있다.
 *  - 계획: 이 세션이 도구 호출(exec_command 의 명령, apply_patch 의 파일 머리)로 다룬 마지막 계획 파일(.omx/plans/*.md,
 *    .omc/plans/*.md, docs/superpowers/plans/*.md, ~/.claude/plans/*.md, prd.json, ultragoal/goals.json). 트리 엔진은
 *    Claude Code 패널과 같은 progress-plan.mjs(hooks/progress-plan.mjs 의 같은 사본, scripts/sync-adapter.js 가 지킴).
 *  - 단계: 마지막 update_plan 의 계획. 없으면 이 세션에서 사용자가 입력한 요청.
 *  - 하위 목록: 진행 중인 단계(없으면 마지막 요청) 뒤의 최근 도구 호출.
 * 파일은 읽기만 한다. --pane 만 tmux 칸을 열고 닫는다.
 *
 * 사용: node progress.mjs [--depth N] [--rollout FILE] [--follow] [--pane on|off]
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clip, fit, parsePlan, planKind } from './progress-plan.mjs';

const MAX_READ = 32 << 20;
const PLAN_READ = 1 << 20;
const RECENT_CALLS = 5;
const RECENT_PROMPTS = 10;
const PANE_TITLE = 'banker-progress';
const ID_RE = /^[0-9A-Za-z-]{8,64}$/;

// 계획 파일인지: Claude Code 패널의 규칙에 OMX 의 계획 폴더(.omx/plans)를 더한다. 'plan', 'weak', null.
export function codexPlanKind(path) {
  const p = String(path ?? '').replaceAll('\\', '/');
  return planKind(p.replace(/\/\.omx\/plans\//, '/.omc/plans/'));
}

export function rolloutFor(thread, env = process.env) {
  if (!ID_RE.test(thread ?? '')) return null;
  const root = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const hits = [];
  for (const y of list(root)) for (const m of list(join(root, y))) for (const d of list(join(root, y, m))) {
    for (const f of list(join(root, y, m, d))) if (f.startsWith('rollout-') && f.endsWith(`-${thread}.jsonl`)) hits.push(join(root, y, m, d, f));
  }
  return hits.sort().at(-1) ?? null;
}

function list(dir) {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

// 일반 파일의 끝 max 바이트를 줄로. 앞에서 잘린 첫 줄은 버린다. FIFO 는 열기 전에 거른다.
export function tail(file, max = MAX_READ) {
  if (!statSync(file).isFile()) return [];
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

// rollout 줄에서 이 도구가 쓰는 기록만: 세션 머리, 사용자 요청, 도구 호출.
export function records(lines) {
  const out = { cwd: '', prompts: [], calls: [], plan: null, planAt: -1 };
  for (const line of lines) {
    if (!line.includes('"session_meta"') && !line.includes('"user_message"') && !line.includes('_call"')) continue;
    const rec = json(line);
    const p = rec?.payload;
    if (!p || typeof p !== 'object') continue;
    if (rec.type === 'session_meta' && typeof p.cwd === 'string') out.cwd = p.cwd;
    else if (rec.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') out.prompts.push({ text: p.message, at: out.calls.length });
    else if (rec.type === 'response_item' && /_call$/.test(String(p.type))) takeCall(out, p);
  }
  return out;
}

function takeCall(out, p) {
  const name = typeof p.name === 'string' && p.name ? p.name : String(p.type).slice(0, -5);
  if (name === 'update_plan') {
    const plan = json(p.arguments)?.plan;
    if (Array.isArray(plan)) [out.plan, out.planAt] = [plan.filter((s) => s && typeof s.step === 'string'), out.calls.length];
    return;
  }
  const args = typeof p.arguments === 'string' ? json(p.arguments) ?? {} : {};
  const input = typeof p.input === 'string' ? p.input : '';
  out.calls.push({ name, cmd: typeof args.cmd === 'string' ? args.cmd : '', workdir: typeof args.workdir === 'string' ? args.workdir : '', input });
}

// 한 도구 호출이 다룬 파일 경로들(명령의 낱말, apply_patch 의 파일 머리).
export function pathsOf(call, cwd) {
  const words = call.cmd.match(/[^\s'"`;|&<>()]+\.(?:md|json)\b/g) ?? [];
  const heads = [...call.input.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => m[1].trim());
  const base = call.workdir || cwd;
  return [...words, ...heads].map((w) => (w.startsWith('~/') ? join(homedir(), w.slice(2)) : isAbsolute(w) || !base ? w : resolve(base, w)));
}

// 이 세션이 마지막으로 다룬 계획 파일. 리뷰 기록 같은 약한 계획은 다른 계획이 없을 때만.
export function lastPlan(calls, cwd) {
  let weak = null;
  for (let i = calls.length - 1; i >= 0; i--) {
    for (const path of pathsOf(calls[i], cwd).reverse()) {
      const kind = codexPlanKind(path);
      if (kind === 'plan' && existsSync(path)) return path;
      if (kind === 'weak' && !weak && existsSync(path)) weak = path;
    }
  }
  return weak;
}

function readPlan(path) {
  try {
    if (!statSync(path).isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fstatSync(fd).size, PLAN_READ));
      readSync(fd, buf, 0, buf.length, 0);
      return parsePlan(path, buf.toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

const BOX = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
const box = (status) => BOX[status] ?? '';
const one = (text, n) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), n);

function nodeText(n) {
  const t = n.text || (Array.isArray(n.parts) ? n.parts.join(' ') : '') || n.name || n.head || '';
  return [box(n.status), n.kind === 'item' && !n.status && n.marker ? (/\d/.test(n.marker) ? `${n.marker}.` : '-') : '', one(t, 100), n.count ? `(${n.count})` : '']
    .filter(Boolean).join(' ');
}

export function renderTree(nodes, depth, out = [], level = 0) {
  for (const n of nodes) {
    out.push(`${'  '.repeat(level + 1)}${nodeText(n)}`);
    if (n.children?.length && level + 1 < depth) renderTree(n.children, depth, out, level + 1);
    else if (n.children?.length) out[out.length - 1] += ` (+${n.children.length})`;
  }
  return out;
}

const callLine = (c) => `      - ${c.name}${c.cmd ? `: ${one(c.cmd, 80)}` : c.input ? `: ${one(c.input.match(/^\*\*\* \w+ File: .+$/m)?.[0] ?? '', 80)}` : ''}`;

function stepLines(r) {
  const out = [];
  if (r.plan) {
    out.push('단계 (update_plan)');
    const current = r.plan.findIndex((s) => s.status === 'in_progress');
    r.plan.forEach((s, i) => {
      out.push(`  ${box(s.status) || '[ ]'} ${one(s.step, 100)}`);
      if (i === current) out.push(...r.calls.slice(r.planAt).slice(-RECENT_CALLS).map(callLine));
    });
    return out;
  }
  const prompts = r.prompts.slice(-RECENT_PROMPTS);
  out.push(prompts.length ? '요청 (update_plan 없음)' : '요청 없음');
  prompts.forEach((p, i) => {
    const last = i === prompts.length - 1;
    out.push(`  ${last ? '[>]' : '[x]'} ${one(p.text, 100)}`);
    if (last) out.push(...r.calls.slice(p.at).slice(-RECENT_CALLS).map(callLine));
  });
  return out;
}

// rollout 하나를 진행 상황 글로.
export function render(file, depth = 2) {
  const r = records(tail(file));
  const out = [`진행 상황 (${file.split(/[\\/]/).at(-1).slice(-42, -6)})`];
  const planPath = lastPlan(r.calls, r.cwd);
  const plan = planPath && readPlan(planPath);
  if (plan) {
    out.push(`계획: ${clip(planPath, 200)}${plan.hasStates ? `  ${plan.done}/${plan.total}` : ''}`);
    out.push(...renderTree(plan.tree, depth));
    if (plan.treeCut) out.push('  (계획이 길어 일부만 보임)');
  } else out.push('계획 파일 없음');
  out.push('', ...stepLines(r));
  return out.join('\n');
}

function opt(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function pane(mode, file, depth) {
  if (!process.env.TMUX) return 'tmux 안이 아니라 칸을 열 수 없음. 진행 상황은 이 출력으로 봄';
  const ids = spawnSync('tmux', ['list-panes', '-F', '#{pane_id} #{pane_title}'], { encoding: 'utf8' });
  if (ids.status !== 0) return `tmux 에 닿지 못함(${(ids.stderr || '').trim() || ids.error?.code}). 샌드박스 밖 실행 승인이 필요할 수 있음`;
  for (const l of ids.stdout.split('\n')) if (l.endsWith(` ${PANE_TITLE}`)) spawnSync('tmux', ['kill-pane', '-t', l.split(' ')[0]]);
  if (mode === 'off') return 'progress 칸을 닫음';
  const me = fileURLToPath(import.meta.url);
  const cmd = [process.execPath, me, '--follow', '--rollout', file, '--depth', String(depth)].map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
  const r = spawnSync('tmux', ['split-window', '-h', '-d', '-l', '40%', '-P', '-F', '#{pane_id}', cmd], { encoding: 'utf8' });
  if (r.status !== 0) return `칸을 열지 못함(${(r.stderr || '').trim()})`;
  spawnSync('tmux', ['select-pane', '-t', r.stdout.trim(), '-T', PANE_TITLE]);
  return 'progress 칸을 오른쪽에 엶(2초마다 갱신). 닫기: --pane off';
}

function follow(file, depth) {
  const draw = () => {
    let text;
    try { text = render(file, depth); } catch (e) { text = `읽지 못함: ${e.message}`; }
    const width = process.stdout.columns || 80;
    process.stdout.write(`\x1b[2J\x1b[H${text.split('\n').map((l) => fit(l, width)).join('\n')}\n`);
  };
  draw();
  setInterval(draw, 2000);
}

function main(argv) {
  const depth = Math.max(1, Math.min(9, Number.parseInt(opt(argv, '--depth', '2'), 10) || 2));
  const file = opt(argv, '--rollout', null) ?? rolloutFor(process.env.CODEX_THREAD_ID);
  if (!file) {
    console.error('Codex 세션 기록을 찾지 못함: Codex 안(CODEX_THREAD_ID)에서 실행하거나 --rollout FILE 을 줌');
    return 2;
  }
  if (argv.includes('--follow')) return follow(file, depth);
  if (argv.includes('--pane')) {
    console.log(pane(opt(argv, '--pane', 'on') === 'off' ? 'off' : 'on', file, depth));
    return 0;
  }
  console.log(render(file, depth));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
}
