#!/usr/bin/env node
/*
 * Review page for the 3d-intro-build and motion-graphic-make skills (scripts/sync-adapter.js keeps
 * the copies identical). Every take (a still, a clip, a snapshot, a render) is a card beside the
 * prompt that made it, so a person judges the output and its instructions together, before any
 * further paid step. The convention is a local page on an unused port, never a claude.ai artifact.
 *
 * Files in the project folder:
 *   IN   curate-input.json  { title?, stage, stageLabel?, promptLabel?, budgetUsd?, spentUsd?,
 *                             scenes: [{ id, label?, takes: [{ file, take?, prompt?, negativePrompt?,
 *                             model?, size?, seconds?, firstFrame?, lastFrame?, createdAt?, costUsd? }] }] }
 *        stage: stills | clips | snapshots | render (or any name). `variants` is read as `takes`.
 *        Every file is relative to the project folder; one outside it is refused.
 *   OUT  decisions.json     { <stage>: { updatedAt, scenes: [{ id, verdict, chosen?, note?, rejected[],
 *                             archived?, by: page|chat, at }] } }
 *        verdict: approve (chosen is the take to use) | regenerate (note says what to change) | pending.
 *
 * Usage:
 *   node curate.mjs [projectDir] [--port N]          serve the page (state: <projectDir>/curate.server.json)
 *   node curate.mjs --stop [projectDir]              end that server
 *   node curate.mjs --record [projectDir] --scene <id|n> --verdict approve|regenerate|reject|pending
 *                   [--take <n|file>] [--note "..."]  record a verdict given in chat
 *   node curate.mjs --archive [projectDir]           move rejected takes to rejected-YYYYMMDD/
 *   PREVIEW_HOST=0.0.0.0 binds every interface and prints a warning.
 *
 * Runtime: Node >=18 builtins only. No shell, cross-platform.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOOPBACK, answersPid, decodePath, forgetSelf, hostWarning, listen, resolveInside, send, sendFile, stopServer,
  urlFor, writeState,
} from './preview-lib.mjs';

const INPUT = 'curate-input.json';
const DECISIONS = 'decisions.json';
const STATE = 'curate.server.json';
const STAGE_LABELS = { stills: '스틸 검토', clips: '클립 검토', snapshots: '스냅숏 검토', render: '렌더 검토' };
const INSTRUCTION_STAGES = new Set(['snapshots', 'render']);
const VERDICTS = new Set(['approve', 'regenerate', 'reject', 'pending']);
const VIDEO = /\.(mp4|webm|mov)$/i;

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A project-relative file as a URL path, each segment encoded.
const fileUrl = (file) => '/' + String(file).replace(/^[.][/\\]/, '').split(/[\\/]/).map(encodeURIComponent).join('/');
const money = (n) => `$${Number(Number(n).toFixed(3))}`;
const inside = (dir, file) => typeof file === 'string' && file !== '' && resolveInside(dir, '/' + file) !== null;

// ---- input and decisions ----------------------------------------------------

export function readInput(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, INPUT), 'utf8'));
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).map((s, i) => ({
    ...s, id: String(s.id ?? `scene-${i + 1}`), label: s.label || String(s.id ?? `scene-${i + 1}`),
    takes: (Array.isArray(s.takes) ? s.takes : Array.isArray(s.variants) ? s.variants : [])
      .map((t, j) => ({ ...t, take: t.take ?? j + 1 })),
  }));
  return { ...raw, stage: raw.stage || 'stills', scenes };
}

export function readDecisions(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, DECISIONS), 'utf8')); } catch { return {}; }
}

function writeDecisions(dir, all) {
  fs.writeFileSync(path.join(dir, DECISIONS), JSON.stringify(all, null, 2) + '\n');
}

// The verdict a scene's choice and note add up to: a note asks for a new take.
const verdictOf = (e) => (e.note ? 'regenerate' : e.chosen ? 'approve' : 'pending');

function entryFor(stageDecisions, id) {
  let e = stageDecisions.scenes.find((x) => x.id === id);
  if (!e) stageDecisions.scenes.push((e = { id, verdict: 'pending', rejected: [] }));
  e.rejected = Array.isArray(e.rejected) ? e.rejected : [];
  return e;
}

function stageOf(all, stage) {
  all[stage] = all[stage] && Array.isArray(all[stage].scenes) ? all[stage] : { scenes: [] };
  return all[stage];
}

function findScene(input, ref) {
  const byId = input.scenes.find((s) => s.id === String(ref));
  const byNumber = /^\d+$/.test(String(ref)) ? input.scenes[Number(ref) - 1] : undefined;
  const scene = byId || byNumber;
  if (!scene) throw new Error(`curate: 장면 ${ref} 을 찾지 못했습니다`);
  return scene;
}

function findTake(scene, ref) {
  const take = scene.takes.find((t) => String(t.take) === String(ref) || t.file === ref);
  if (!take) throw new Error(`curate: ${scene.id} 에 테이크 ${ref} 가 없습니다`);
  return take.file;
}

// How a verdict given in chat changes one scene's entry. A reject drops the take from the choice.
const CHAT_VERDICTS = {
  pending: (e) => Object.assign(e, { rejected: [], chosen: undefined, note: undefined }),
  approve: (e, file, note) => Object.assign(e, { chosen: file, note: note || undefined, rejected: e.rejected.filter((f) => f !== file) }),
  reject: (e, file) => {
    if (!e.rejected.includes(file)) e.rejected.push(file);
    if (e.chosen === file) e.chosen = undefined;
  },
  regenerate: (e, file, note) => {
    if (note !== undefined) e.note = note || undefined;
    if (file) e.chosen = file;
  },
};

function applyVerdict(e, verdict, file, note) {
  CHAT_VERDICTS[verdict](e, file, note);
  e.verdict = verdict === 'regenerate' ? 'regenerate' : verdictOf(e);
  return e;
}

/** Records a verdict given in chat: scene by id or 1-based number, take by number or file. */
export function recordDecision(dir, { scene, verdict, take, note }, now = new Date()) {
  if (!VERDICTS.has(verdict)) throw new Error(`curate: 판정은 approve, regenerate, reject, pending 중 하나입니다 (${verdict})`);
  const input = readInput(dir);
  const s = findScene(input, scene);
  const needsTake = verdict === 'approve' || verdict === 'reject';
  if (needsTake && take === undefined) throw new Error(`curate: ${verdict} 에는 테이크 번호가 필요합니다`);
  const file = take === undefined ? undefined : findTake(s, take);
  const all = readDecisions(dir);
  const stage = stageOf(all, input.stage);
  const e = applyVerdict(entryFor(stage, s.id), verdict, file, note);
  Object.assign(e, { by: 'chat', at: now.toISOString() });
  stage.updatedAt = now.toISOString();
  writeDecisions(dir, all);
  return e;
}

// Verdicts the page sends: one chosen take per scene, a note, and rejected takes.
function applyPageDecisions(dir, payload, now = new Date()) {
  const input = readInput(dir);
  const all = readDecisions(dir);
  const stage = stageOf(all, input.stage);
  for (const p of Array.isArray(payload.scenes) ? payload.scenes : []) {
    const scene = findScene(input, p.id);
    const files = new Set(scene.takes.map((t) => t.file));
    const rejected = (Array.isArray(p.rejected) ? p.rejected : []).filter((f) => files.has(f));
    if (p.chosen && !files.has(p.chosen)) throw new Error(`curate: ${scene.id} 의 선택이 테이크가 아닙니다`);
    const e = entryFor(stage, scene.id);
    Object.assign(e, { chosen: p.chosen || undefined, note: String(p.note ?? '').trim() || undefined, rejected });
    Object.assign(e, { verdict: verdictOf(e), by: 'page', at: now.toISOString() });
  }
  stage.updatedAt = now.toISOString();
  writeDecisions(dir, all);
  return stage;
}

const dated = (now) => `rejected-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

function moveInto(dir, file, folder) {
  const to = `${folder}/${file.split(/[\\/]/).join('/')}`;
  const dest = path.join(dir, ...to.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(dir, ...file.split(/[\\/]/)), dest);
  return { file, to };
}

/** Moves the current stage's rejected takes into rejected-YYYYMMDD/ and drops them from the input. */
export function archiveRejected(dir, { now = new Date() } = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, INPUT), 'utf8'));
  const input = readInput(dir);
  const all = readDecisions(dir);
  const stage = stageOf(all, input.stage);
  const moves = [];
  for (const e of stage.scenes) {
    const moved = e.rejected.filter((f) => inside(dir, f) && fs.existsSync(path.join(dir, f))).map((f) => moveInto(dir, f, dated(now)));
    e.archived = [...(e.archived || []), ...moved];
    e.rejected = e.rejected.filter((f) => !moved.some((m) => m.file === f));
    moves.push(...moved);
  }
  if (!moves.length) return moves;
  const gone = new Set(moves.map((m) => m.file));
  for (const s of raw.scenes || []) {
    for (const key of ['takes', 'variants']) if (Array.isArray(s[key])) s[key] = s[key].filter((t) => !gone.has(t.file));
  }
  fs.writeFileSync(path.join(dir, INPUT), JSON.stringify(raw, null, 2) + '\n');
  writeDecisions(dir, all);
  return moves;
}

// ---- the page -----------------------------------------------------------------

const hashes = new Map();
function sha256(fp) {
  const st = fs.statSync(fp);
  const key = `${fp}:${st.mtimeMs}:${st.size}`;
  if (!hashes.has(key)) hashes.set(key, crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'));
  return hashes.get(key);
}

function media(t, dir) {
  if (!inside(dir, t.file)) return '<p class="refused">파일 경로가 프로젝트 폴더 밖이라 보이지 않습니다.</p>';
  const src = escAttr(fileUrl(t.file));
  return VIDEO.test(t.file)
    ? `<video src="${src}" muted loop autoplay playsinline preload="metadata"></video>`
    : `<img src="${src}" alt="" loading="lazy">`;
}

function frameRow(label, file, dir) {
  if (!file) return '';
  const thumb = inside(dir, file) ? `<img class="thumb" src="${escAttr(fileUrl(file))}" alt="">` : '';
  return `<dt>${label}</dt><dd>${thumb}<code>${escHtml(file)}</code></dd>`;
}

function fileFacts(t, dir) {
  const fp = inside(dir, t.file) ? path.join(dir, t.file) : null;
  const hash = fp && fs.existsSync(fp) ? sha256(fp) : '파일 없음';
  return `<dt>파일</dt><dd><code>${escHtml(t.file ?? '')}</code></dd><dt>sha256</dt><dd><code class="hash">${escHtml(hash)}</code></dd>`;
}

function facts(t, dir, promptLabel) {
  const row = (label, v) => (v === undefined || v === null || v === '' ? '' : `<dt>${label}</dt><dd>${escHtml(v)}</dd>`);
  return '<dl>'
    + (t.prompt ? `<dt>${promptLabel}</dt><dd class="prompt">${escHtml(t.prompt)}</dd>` : '')
    + row('제외 프롬프트', t.negativePrompt) + row('모델', t.model) + row('크기', t.size)
    + row('길이', t.seconds != null ? `${t.seconds}초` : null)
    + frameRow('첫 프레임', t.firstFrame, dir) + frameRow('끝 프레임', t.lastFrame, dir)
    + row('생성 시각', t.createdAt) + row('비용', t.costUsd != null ? money(t.costUsd) : null)
    + fileFacts(t, dir) + '</dl>';
}

function card(t, dir, promptLabel, e) {
  const cls = ['card', e.chosen === t.file ? 'selected' : '', e.rejected.includes(t.file) ? 'rejected' : ''].filter(Boolean).join(' ');
  return `<article class="${cls}" data-file="${escAttr(t.file ?? '')}">
      <div class="media">${media(t, dir)}</div>
      <div class="meta"><strong>테이크 ${escHtml(t.take)}</strong>${facts(t, dir, promptLabel)}
        <div class="actions"><button type="button" data-act="choose">이 테이크로 승인</button>
        <button type="button" data-act="reject">탈락</button></div></div>
    </article>`;
}

const CHIPS = { approve: '승인', regenerate: '재생성 요청', pending: '대기' };

function sceneBlock(s, i, ctx) {
  const e = ctx.entries.get(s.id) || { verdict: 'pending', rejected: [] };
  const cards = s.takes.map((t) => card(t, ctx.dir, ctx.promptLabel, e)).join('\n      ') || '<p class="empty">테이크가 없습니다.</p>';
  return `<section class="scene" data-scene-id="${escAttr(s.id)}">
    <div class="scene-head"><h2>${i + 1}. ${escHtml(s.label)}</h2><span class="chip ${e.verdict}" data-chip>${CHIPS[e.verdict] || '대기'}</span></div>
    <div class="takes">
      ${cards}
    </div>
    <label class="note"><span>재생성 메모 (비우면 고른 테이크로 승인)</span>
      <textarea data-note rows="2">${escHtml(e.note || '')}</textarea></label>
  </section>`;
}

function summary(input, entries) {
  const approved = input.scenes.filter((s) => entries.get(s.id)?.verdict === 'approve').length;
  const spent = input.spentUsd ?? input.scenes.flatMap((s) => s.takes).reduce((a, t) => a + (Number(t.costUsd) || 0), 0);
  const budget = input.budgetUsd != null ? ` / 승인 예산 ${money(input.budgetUsd)}` : '';
  const stage = input.stageLabel || STAGE_LABELS[input.stage] || input.stage;
  return `<strong>${escHtml(stage)}</strong> <span>승인 ${approved} / ${input.scenes.length}</span> <span>누적 비용 ${money(spent)}${budget}</span>`;
}

export function renderPage(input, decisions, { dir }) {
  const stage = decisions[input.stage] || { scenes: [] };
  const entries = new Map(stage.scenes.map((e) => [e.id, { ...e, rejected: e.rejected || [] }]));
  const promptLabel = input.promptLabel || (INSTRUCTION_STAGES.has(input.stage) ? '구성 지시문' : '프롬프트');
  const ctx = { dir, promptLabel, entries };
  const body = input.scenes.map((s, i) => sceneBlock(s, i, ctx)).join('\n') || '<p class="empty">curate-input.json 에 장면이 없습니다.</p>';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(STAGE_LABELS[input.stage] || input.stage)}${input.title ? ' - ' + escHtml(input.title) : ''}</title>
<style>${PAGE_CSS}</style></head>
<body><header class="bar"><div class="bar-in"><div class="sum">${summary(input, entries)}</div>
<button id="save" class="btn">판정 저장</button></div></header>
<main id="app">${body}</main>
<div id="done" class="done" hidden><div class="done-card">판정을 저장했습니다. 에이전트로 돌아가세요.</div></div>
<script>${PAGE_JS}</script></body></html>
`;
}

const PAGE_CSS = `
:root{--bg:#f5f3ef;--panel:#fff;--ink:#23202a;--muted:#6c6675;--line:#e2ddd4;--accent:#7c5cbf;--ok:#2f7d4f;--warn:#b26a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#17151b;--panel:#201d26;--ink:#ece8f1;--muted:#a49db1;--line:#322d3c;--accent:#a488e6;--ok:#7fd3a0;--warn:#e6b063;--bad:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif}
.bar{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line)}
.bar-in{max-width:1400px;margin:0 auto;padding:10px 20px;display:flex;gap:16px;align-items:center;justify-content:space-between}
.sum{display:flex;gap:18px;flex-wrap:wrap;align-items:baseline}.sum span{color:var(--muted)}
.btn{border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;padding:9px 18px;cursor:pointer}.btn:disabled{opacity:.5}
main{max-width:1400px;margin:0 auto;padding:18px 20px}
.scene{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px}
.scene-head{display:flex;gap:12px;align-items:center}.scene-head h2{font-size:16px;margin:0}
.chip{font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid currentColor}
.chip.approve{color:var(--ok)}.chip.regenerate{color:var(--warn)}.chip.pending{color:var(--muted)}
.takes{display:flex;gap:12px;overflow-x:auto;padding:12px 0}
.card{flex:0 0 340px;border:2px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.card.selected{border-color:var(--ok)}.card.rejected{border-color:var(--bad);opacity:.6}
.media img,.media video{display:block;width:100%;height:auto;background:#000}
.meta{padding:8px 10px}.meta dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 8px;margin:6px 0}
.meta dt{color:var(--muted)}.meta dd{margin:0;overflow-wrap:anywhere}.prompt{white-space:pre-wrap;max-height:9em;overflow:auto}
.thumb{width:72px;height:auto;vertical-align:middle;margin-right:6px}.hash{font-size:11px}
.actions{display:flex;gap:8px}.actions button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:4px 10px;cursor:pointer}
.note span{display:block;color:var(--muted);font-size:13px}.note textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;background:var(--bg);color:var(--ink)}
.refused,.empty{color:var(--bad)}[hidden]{display:none!important}
.done{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg) 82%,transparent);z-index:10}
.done-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px 32px;font-size:17px;font-weight:600}`;

const PAGE_JS = `
const chip = (scene) => {
  const c = scene.querySelector('[data-chip]');
  const note = scene.querySelector('[data-note]').value.trim();
  const v = note ? 'regenerate' : scene.querySelector('.card.selected') ? 'approve' : 'pending';
  c.className = 'chip ' + v; c.textContent = { approve: '승인', regenerate: '재생성 요청', pending: '대기' }[v];
};
document.getElementById('app').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const card = btn.closest('.card'); const scene = card.closest('.scene');
  if (btn.dataset.act === 'choose') {
    scene.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected'); card.classList.remove('rejected');
  } else { card.classList.toggle('rejected'); if (card.classList.contains('rejected')) card.classList.remove('selected'); }
  chip(scene);
});
document.getElementById('app').addEventListener('input', (e) => { const s = e.target.closest('.scene'); if (s) chip(s); });
document.getElementById('save').addEventListener('click', async () => {
  const scenes = [...document.querySelectorAll('.scene')].map((s) => ({ id: s.dataset.sceneId,
    chosen: s.querySelector('.card.selected')?.dataset.file || '', note: s.querySelector('[data-note]').value,
    rejected: [...s.querySelectorAll('.card.rejected')].map((c) => c.dataset.file) }));
  const btn = document.getElementById('save'); btn.disabled = true;
  try {
    const r = await fetch('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes }) });
    if (!r.ok) throw new Error(await r.text());
    document.getElementById('done').hidden = false;
  } catch (err) { btn.disabled = false; alert('저장하지 못했습니다: ' + (err && err.message ? err.message : err)); }
});`;

// ---- the server ---------------------------------------------------------------

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function decide(dir, req, res) {
  try {
    const stage = applyPageDecisions(dir, JSON.parse(await readBody(req)));
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, written: DECISIONS, scenes: stage.scenes.length }));
  } catch (e) {
    send(res, 400, String(e.message || e));
  }
}

function page(dir, res) {
  let html;
  try { html = renderPage(readInput(dir), readDecisions(dir), { dir }); } catch (e) { return send(res, 500, `${INPUT} 을 읽지 못했습니다: ${e.message}`); }
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function handler(dir) {
  return (req, res) => {
    const urlPath = decodePath(req.url);
    if (urlPath === null) return send(res, 400, '400');
    if (req.method === 'POST' && urlPath === '/decide') return void decide(dir, req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '405');
    if (answersPid(urlPath, res)) return;
    if (urlPath === '/' || urlPath === '/index.html') return page(dir, res);
    const fp = resolveInside(dir, urlPath);
    if (!fp) return send(res, 403, '403');
    sendFile(req, res, fp);
  };
}

/** Serves the review page for `dir` until close(). Resolves to { server, port, url, stateFile, close }. */
export async function startCurate(dir, { port, host = process.env.PREVIEW_HOST || LOOPBACK } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`curate: not a directory: ${root}`);
  const server = http.createServer(handler(root));
  const bound = await listen(server, { host, port });
  const url = urlFor(host, bound);
  const stateFile = path.join(root, STATE);
  writeState(stateFile, { pid: process.pid, port: bound, host, url, dir: root, startedAt: new Date().toISOString() });
  const close = () => new Promise((resolve) => { forgetSelf(stateFile); server.close(() => resolve()); });
  return { server, port: bound, host, url, stateFile, close };
}

// ---- CLI ------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { dir: null, port: null };
  const flags = new Set(['--stop', '--record', '--archive']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) o.mode = a.slice(2);
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      o[eq > 0 ? a.slice(2, eq) : a.slice(2)] = eq > 0 ? a.slice(eq + 1) : argv[++i];
    } else o.dir = a;
  }
  return o;
}

async function serveMain(dir, o) {
  const s = await startCurate(dir, { port: Number(o.port) || undefined });
  const warn = hostWarning(s.host);
  if (warn) console.warn(warn);
  console.log(`CURATE ${s.url}`);
  console.log(`reviewing ${dir}  (in: ${INPUT}  out: ${DECISIONS}  state: ${s.stateFile})`);
  const quit = () => { forgetSelf(s.stateFile); s.server.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = path.resolve(o.dir || process.cwd());
  if (o.mode === 'stop') {
    const r = await stopServer(path.join(dir, STATE));
    console.log(`STOP ${r.reason}`);
    return process.exit(['stopped', 'not-running', 'no-state'].includes(r.reason) ? 0 : 1);
  }
  if (o.mode === 'record') return console.log(JSON.stringify(recordDecision(dir, o)));
  if (o.mode === 'archive') return console.log(JSON.stringify(archiveRejected(dir)));
  return serveMain(dir, o);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
