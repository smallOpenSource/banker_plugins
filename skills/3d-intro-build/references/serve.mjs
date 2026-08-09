#!/usr/bin/env node
/*
 * First-party static preview server for the 3d-intro-build skill.
 *
 * Serves an assembled intro directory (index.html + scrub-engine.js + assets/) so the
 * scroll-scrubbed page can be previewed in a real browser — the project convention is a
 * self-contained local HTML on an unused port, never a claude.ai artifact.
 *
 * Why a server at all: the page loads each .mp4 with fetch()->Blob (always seekable), and
 * mp4 delivery is smoother with HTTP Range (206) support, which file:// cannot provide.
 *
 * Runtime: Node >=18 builtins ONLY (node:http / node:fs / node:path). No external deps,
 * no shell — cross-platform (path.join, path.resolve, path.sep everywhere).
 *
 * Usage:
 *   node serve.mjs [dir] [--port N]
 *     dir      directory to serve (default: current working directory)
 *     --port   preferred port; falls back through a candidate list if busy/omitted
 *   On listen it writes <dir>/port.txt and prints  PREVIEW http://localhost:<port>/
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
  console.error(`serve: not a directory: ${DIR}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';

  // Resolve inside DIR and reject any path that escapes it (traversal guard).
  const fp = path.normalize(path.join(DIR, p));
  if (fp !== DIR && !fp.startsWith(DIR + path.sep)) { res.writeHead(403); res.end('403'); return; }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('404'); return; }

  const size = fs.statSync(fp).size;
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const isVideo = type.startsWith('video/');
  const range = req.headers.range;

  // Range requests (video scrubbing benefits from 206 partial content).
  if (range && isVideo) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(fp, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
});

// ---- pick a free port (preferred first, then a candidate list) ----
const candidates = [8931, 8932, 8933, 8080, 8090, 8100, 8123, 8321];
const ports = portArg ? [portArg, ...candidates.filter((p) => p !== portArg)] : candidates;
// Default to loopback (matches the printed localhost URL). Set PREVIEW_HOST=0.0.0.0 for LAN / on-device mobile preview.
const HOST = process.env.PREVIEW_HOST || '127.0.0.1';

(function tryPort(i) {
  if (i >= ports.length) { console.error('serve: no free port available'); process.exit(1); }
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') tryPort(i + 1);
    else { console.error(e); process.exit(1); }
  });
  server.listen(ports[i], HOST, () => {
    try { fs.writeFileSync(path.join(DIR, 'port.txt'), String(ports[i])); } catch { /* best effort */ }
    console.log(`PREVIEW http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${ports[i]}/`);
    console.log(`serving ${DIR}`);
  });
})(0);

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
