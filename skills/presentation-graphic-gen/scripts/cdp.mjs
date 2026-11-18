// cdp.mjs: minimal headless Chrome / Edge / Chromium driver over the DevTools protocol (Node's global WebSocket,
// no dependencies). Used by check.mjs and the tests.
//   const b = await launch();  const p = await b.open(url);  await p.eval('expr');  await p.shot(file);  b.close();
// Browser: env CHROME, else Chrome, Edge, Chromium, then Playwright's chromium cache (Windows, macOS, Linux).
// Each launch uses a fresh profile folder from mkdtemp that close() removes.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMD_MS = 30000;

function playwrightCandidates() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'win32') roots.push(join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright'));
  else if (process.platform === 'darwin') roots.push(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
  else roots.push(join(homedir(), '.cache', 'ms-playwright'));
  const tails = {
    win32: [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']],
    darwin: [['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']],
    linux: [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']],
  }[process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'];
  const out = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]); } catch { continue; }
    for (const d of dirs) for (const t of tails) out.push(join(root, d, ...t));
  }
  return out;
}

function onPath(names) {
  const out = [];
  for (const dir of (process.env.PATH || '').split(delimiter)) for (const n of names) if (dir) out.push(join(dir, n));
  return out;
}

/** Candidate browser paths in search order (env CHROME first). */
export function browserCandidates() {
  const env = process.env.CHROME ? [process.env.CHROME] : [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return env.concat([
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(la, 'Chromium', 'Application', 'chrome.exe'),
    ], playwrightCandidates());
  }
  if (process.platform === 'darwin') {
    return env.concat([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ], playwrightCandidates());
  }
  return env.concat(onPath(['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'chromium', 'chromium-browser']),
    ['/opt/google/chrome/chrome', '/snap/bin/chromium'], playwrightCandidates());
}

/** The first browser that exists, or null. A CHROME that names no file is not overridden by a search. */
export function findBrowser() {
  if (process.env.CHROME) return existsSync(process.env.CHROME) ? process.env.CHROME : null;
  for (const p of browserCandidates()) if (p && existsSync(p)) return p;
  return null;
}

const KEYS = {
  ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Enter: ['Enter', 13], ' ': ['Space', 32], PageDown: ['PageDown', 34],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], PageUp: ['PageUp', 33], Backspace: ['Backspace', 8], b: ['KeyB', 66],
};

/** Starts a headless browser. onEvent(method, params, sessionId) receives protocol events; extraArgs are added browser flags. */
export async function launch({ onEvent, browser = findBrowser(), extraArgs = [] } = {}) {
  if (!browser) throw new Error('no Chrome, Edge or Chromium found (set CHROME to the browser executable)');
  const profile = mkdtempSync(join(tmpdir(), 'pgg-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio', '--window-size=1920,1080', '--force-device-scale-factor=1',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions'];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push(...extraArgs, 'about:blank');
  const proc = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
  let ws = null, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (ws) ws.close(); } catch { /* closing */ }
    if (proc.pid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' });
        else proc.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    for (let i = 0; i < 10; i++) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked, retry */ }
      if (!existsSync(profile)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  };
  const portFile = join(profile, 'DevToolsActivePort');
  for (let waited = 0; !existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2; waited += 100) {
    if (waited > 20000 || proc.exitCode != null) { close(); throw new Error(`browser did not start: ${browser}`); }
    await sleep(100);
  }
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools websocket did not connect')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.rej(new Error(`${p.method}: ${d.error.message}`)); else p.res(d.result);
    } else if (d.method && onEvent) onEvent(d.method, d.params, d.sessionId);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`${method}: no reply in ${CMD_MS} ms`)); }, CMD_MS);
    pending.set(i, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

  // init: scripts run before any page script on every load (tests use it to hold document.fonts.ready);
  // dpr: the device pixel ratio the page sees (check.mjs plays the deck at 1.5 as well)
  async function open(url, { width = 1920, height = 1080, dpr = 1, network = false, init = [], media = [] } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    if (network) await send('Network.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId);
    if (media.length) await send('Emulation.setEmulatedMedia', { features: media }, sessionId);
    for (const source of init) await send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    const page = {
      sessionId, targetId,
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) + ' :: ' + expression.slice(0, 100));
        return r.result.value;
      },
      async goto(u, { wait = true } = {}) {
        await send('Page.navigate', { url: u }, sessionId);
        if (wait) await page.ready();
      },
      async ready(ms = 20000) {
        for (let k = 0; k < ms / 100; k++) {
          let ok = false;
          try { ok = await page.eval("document.documentElement.dataset.ready === '1' && !!window.__deck"); } catch { /* navigating */ }
          if (ok) return;
          await sleep(100);
        }
        throw new Error('page not ready');
      },
      async press(key) {
        const [code, vk] = KEYS[key];
        for (const type of ['keyDown', 'keyUp']) {
          const text = type === 'keyDown' ? (key === ' ' ? ' ' : key === 'Enter' ? '\r' : key === 'b' ? 'b' : undefined) : undefined;
          await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, text }, sessionId);
        }
      },
      async click(x, y) {
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
      },
      async settle(ms = 20000) {
        for (let k = 0; k < ms / 50; k++) { if (!(await page.eval('__deck.animating'))) return true; await sleep(50); }
        return false;
      },
      // PNG screenshot (bytes); clip = { x, y, width, height } in CSS px
      async shot(file, clip) {
        const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip: Object.assign({ scale: 1 }, clip) } : { format: 'png' }, sessionId);
        const bytes = Buffer.from(r.data, 'base64');
        if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); }
        return bytes;
      },
      close: () => send('Target.closeTarget', { targetId }),
    };
    if (url) await page.goto(url);
    return page;
  }
  return { send, open, close, browser };
}

// node scripts/cdp.mjs: prints the browser the gates will use, or says none was found (exit 2)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findBrowser();
  process.stdout.write(found ? `browser ${found}\n` : 'no Chrome, Edge or Chromium found (set CHROME to the browser executable)\n');
  process.exit(found ? 0 : 2);
}
