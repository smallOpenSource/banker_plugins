#!/usr/bin/env node
/*
 * First-party still-curation server for the 3d-intro-build skill.
 *
 * Sits BETWEEN still generation (cheap paid) and video generation (the big paid step): the user
 * picks/approves one still per scene in a real browser BEFORE any Sora-2 call is spent. The project
 * convention is a self-contained local page on an unused port, never a claude.ai artifact.
 *
 * Contract (both files live in the project dir):
 *   IN   curate-input.json  {"scenes":[{"id","label","variants":[{"file","prompt?"}]}]}
 *          file = png path relative to projectDir (served with a path-traversal guard).
 *   OUT  selection.json     {"scenes":[{"id","chosen":<file>,"regenerate?":<note>}]}
 *          chosen = the file the user picked; regenerate = a tweaked-prompt note (present only when
 *          the user wants that scene re-generated). Written on POST /select.
 *
 * Routes:  GET /            -> curation page (rebuilt from curate-input.json each load, so a
 *                              regenerate-loop re-read shows fresh stills without a restart)
 *          GET /<img>       -> a still image (image/png/…; traversal-guarded; Cache-Control no-store)
 *          POST /select     -> writes selection.json, returns {ok:true}
 *
 * Runtime: Node >=18 builtins ONLY (node:http / node:fs / node:path). No external deps, no shell —
 * cross-platform (path.join / path.sep everywhere). Loopback by default; PREVIEW_HOST=0.0.0.0 for LAN.
 *
 * Usage:
 *   node curate.mjs [projectDir] [--port N]
 *     projectDir   dir holding curate-input.json + the stills it references (default: cwd)
 *     --port       preferred port; falls back through a candidate list if busy/omitted
 *   On listen it writes <projectDir>/curate-port.txt and prints  CURATE http://localhost:<port>/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ---- args ----
const argv = process.argv.slice(2);
let dirArg = null;
let portArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') portArg = Number(argv[++i]);
  else if (a.startsWith('--port=')) portArg = Number(a.slice('--port='.length));
  else if (!a.startsWith('--')) dirArg = a;
}

const DIR = path.resolve(dirArg || process.cwd());
if (!fs.existsSync(DIR) || !fs.statSync(DIR).isDirectory()) {
  console.error(`curate: not a directory: ${DIR}`);
  process.exit(1);
}
const INPUT = path.join(DIR, 'curate-input.json');
const OUTPUT = path.join(DIR, 'selection.json');

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

// ---- html helpers ----
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// posix URL for a project-relative file, each segment encoded (server decodes with decodeURIComponent)
const fileUrl = (file) => '/' + String(file).replace(/^[.][/\\]/, '').split(/[\\/]/).map(encodeURIComponent).join('/');

function renderCard(v, sceneId, idx, selected) {
  const cap = v.prompt ? `<span class="cap">${escHtml(v.prompt)}</span>` : '';
  return `<button type="button" class="card${selected ? ' selected' : ''}" data-file="${escAttr(v.file)}">`
    + `<img src="${escAttr(fileUrl(v.file))}" alt="${escAttr(sceneId)} 변형 ${idx + 1}" loading="lazy">${cap}</button>`;
}

function renderScene(s) {
  const variants = Array.isArray(s.variants) ? s.variants : [];
  const cards = variants.map((v, i) => renderCard(v, s.id, i, i === 0)).join('\n        ');
  const body = cards || '<p class="empty">이 씬에 스틸 변형이 없습니다.</p>';
  return `<section class="scene" data-scene-id="${escAttr(s.id)}">
      <div class="scene-head">
        <h2>${escHtml(s.label || s.id)}</h2>
        <span class="chip keep" data-chip>이 스틸로 승인</span>
      </div>
      <div class="cards">
        ${body}
      </div>
      <label class="regen">
        <span>재생성 메모 (선택 · 비우면 위에서 고른 스틸로 승인)</span>
        <textarea data-regen rows="2" placeholder="예: 배경을 더 어둡게, 캐릭터 2명 추가"></textarea>
      </label>
    </section>`;
}

function renderPage(manifest) {
  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
  const rows = scenes.length ? scenes.map(renderScene).join('\n    ') : '<p class="empty">curate-input.json 에 scenes 가 없습니다.</p>';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>스틸 큐레이션${manifest.title ? ' — ' + escHtml(manifest.title) : ''}</title>
<style>
  :root {
    --bg: #f5f3ef; --panel: #ffffff; --ink: #23202a; --muted: #6c6675;
    --line: #e2ddd4; --accent: #7c5cbf; --accent-ink: #ffffff;
    --keep: #2f7d4f; --keep-bg: #e6f3ea; --regen: #b26a00; --regen-bg: #fbefd8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17151b; --panel: #201d26; --ink: #ece8f1; --muted: #a49db1;
      --line: #322d3c; --accent: #a488e6; --accent-ink: #17151b;
      --keep: #7fd3a0; --keep-bg: #1d3327; --regen: #e6b063; --regen-bg: #3a2c14;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans KR", sans-serif; }
  .bar { position: sticky; top: 0; z-index: 5; background: var(--panel);
    border-bottom: 1px solid var(--line); }
  .bar-in { max-width: 1100px; margin: 0 auto; padding: 12px 20px;
    display: flex; align-items: center; gap: 16px; justify-content: space-between; }
  .muted { color: var(--muted); font-size: 13px; }
  .btn { border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-ink);
    font-size: 14px; font-weight: 600; padding: 10px 18px; cursor: pointer; }
  .btn:disabled { opacity: .5; cursor: default; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px; }
  .scene { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px; margin-bottom: 18px; }
  .scene-head { display: flex; align-items: center; gap: 12px; margin: 0 0 12px; }
  .scene-head h2 { font-size: 17px; margin: 0; }
  .chip { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
  .chip.keep { color: var(--keep); background: var(--keep-bg); }
  .chip.regen-on { color: var(--regen); background: var(--regen-bg); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .card { padding: 0; border: 2px solid var(--line); border-radius: 10px; background: var(--panel);
    cursor: pointer; overflow: hidden; text-align: left; display: flex; flex-direction: column; }
  .card img { display: block; width: 100%; height: auto; aspect-ratio: 3 / 4; object-fit: cover; }
  .card .cap { padding: 8px 10px; font-size: 12px; color: var(--muted);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card.selected { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
  .regen { display: block; margin-top: 12px; }
  .regen span { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  .regen textarea { width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; font: inherit; background: var(--bg); color: var(--ink); }
  .empty { color: var(--muted); }
  [hidden] { display: none !important; }
  .done { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--bg) 82%, transparent); z-index: 10; }
  .done-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 28px 36px; font-size: 18px; font-weight: 600; }
</style>
</head>
<body>
<header class="bar">
  <div class="bar-in">
    <div><strong>스틸 큐레이션</strong> <span class="muted">씬별로 스틸을 고르고, 다시 만들 씬엔 메모를 남기세요 (영상 생성은 이 확정 이후에만)</span></div>
    <button id="confirm" class="btn">선택 확정</button>
  </div>
</header>
<main id="app">
    ${rows}
</main>
<div id="done" class="done" hidden><div class="done-card">선택 저장됨 — 에이전트로 돌아가세요</div></div>
<script>
  const app = document.getElementById('app');
  app.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const scene = card.closest('.scene');
    scene.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
  });
  app.addEventListener('input', (e) => {
    const ta = e.target.closest('[data-regen]');
    if (!ta) return;
    const chip = ta.closest('.scene').querySelector('[data-chip]');
    const has = ta.value.trim() !== '';
    chip.textContent = has ? '재생성 요청됨' : '이 스틸로 승인';
    chip.classList.toggle('regen-on', has);
    chip.classList.toggle('keep', !has);
  });
  document.getElementById('confirm').addEventListener('click', async () => {
    const scenes = [], missing = [];
    document.querySelectorAll('.scene').forEach((scene) => {
      const id = scene.getAttribute('data-scene-id');
      const sel = scene.querySelector('.card.selected');
      const regen = (scene.querySelector('[data-regen]') || {}).value?.trim() || '';
      if (!sel) { missing.push(id); return; }
      const s = { id, chosen: sel.getAttribute('data-file') };
      if (regen) s.regenerate = regen;
      scenes.push(s);
    });
    if (missing.length) { alert('스틸을 선택하지 않은 씬: ' + missing.join(', ')); return; }
    const btn = document.getElementById('confirm');
    btn.disabled = true;
    try {
      const r = await fetch('/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      document.getElementById('done').hidden = false;
    } catch (err) {
      btn.disabled = false;
      alert('저장 실패: ' + (err && err.message ? err.message : err));
    }
  });
</script>
</body>
</html>
`;
}

// ---- request handling ----
function servePage(res) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(INPUT, 'utf8')); }
  catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`curate-input.json 을 읽지 못했습니다 (${INPUT}): ${e.message}`);
    return;
  }
  const html = renderPage(manifest);
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function serveFile(urlPath, res) {
  // Resolve inside DIR and reject any path that escapes it (traversal guard) — matches serve.mjs.
  const fp = path.normalize(path.join(DIR, urlPath));
  if (fp !== DIR && !fp.startsWith(DIR + path.sep)) { res.writeHead(403); res.end('403'); return; }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fs.statSync(fp).size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
}

function handleSelect(req, res) {
  let body = '';
  let tooBig = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > 1_000_000) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) { res.writeHead(413); res.end('413'); return; }
    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json;charset=utf-8' }); res.end('{"ok":false,"error":"invalid json"}'); return; }
    const scenes = (Array.isArray(payload.scenes) ? payload.scenes : []).map((s) => {
      const out = { id: String(s.id), chosen: String(s.chosen) };
      const note = s.regenerate == null ? '' : String(s.regenerate).trim();
      if (note) out.regenerate = note;
      return out;
    });
    try { fs.writeFileSync(OUTPUT, JSON.stringify({ scenes }, null, 2) + '\n'); }
    catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, written: 'selection.json', scenes: scenes.length }));
    console.log(`selection.json written -> ${OUTPUT} (${scenes.length} scene(s))`);
  });
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (method === 'POST' && urlPath === '/select') { handleSelect(req, res); return; }
  if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405); res.end('405'); return; }
  if (urlPath === '/' || urlPath === '/index.html') { servePage(res); return; }
  serveFile(urlPath, res);
});

// ---- pick a free port (preferred first, then a candidate list) ----
// Distinct from serve.mjs's list so a preview server and this curation server can coexist during dev;
// EADDRINUSE still falls through if any are taken.
const candidates = [8941, 8942, 8943, 8850, 8860, 8870, 8223, 8421];
const ports = portArg ? [portArg, ...candidates.filter((p) => p !== portArg)] : candidates;
// Default to loopback (matches the printed localhost URL). Set PREVIEW_HOST=0.0.0.0 for LAN / on-device mobile preview.
const HOST = process.env.PREVIEW_HOST || '127.0.0.1';

(function tryPort(i) {
  if (i >= ports.length) { console.error('curate: no free port available'); process.exit(1); }
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') tryPort(i + 1);
    else { console.error(e); process.exit(1); }
  });
  server.listen(ports[i], HOST, () => {
    try { fs.writeFileSync(path.join(DIR, 'curate-port.txt'), String(ports[i])); } catch { /* best effort */ }
    console.log(`CURATE http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${ports[i]}/`);
    console.log(`curating ${DIR}  (in: curate-input.json  out: selection.json)`);
  });
})(0);

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
