// cdp.mjs: minimal headless Chrome / Edge / Chromium driver over the DevTools protocol, no dependencies. The
// protocol runs over the browser's own pipe (--remote-debugging-pipe: Node writes to its fd 3 and reads its fd 4,
// one NUL-terminated JSON message each), so no debugging port is opened that other users of the PC could reach.
// Used by check.mjs, record.mjs, pptx-edit.mjs, pptx.mjs and the tests.
//   const b = await launch();  const p = await b.open(url);  await p.eval('expr');  await p.shot(file);  b.close();
// Browser: env CHROME, else Chrome, Edge, Chromium, then Playwright's chromium cache (Windows, macOS, Linux).
// Each launch uses a fresh profile folder from mkdtemp that close() removes.
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMD_MS = 30000; // the reply time of one protocol command, unless the caller gives its own

function playwrightRoots() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'win32') roots.push(join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright'));
  else if (process.platform === 'darwin') roots.push(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
  else roots.push(join(homedir(), '.cache', 'ms-playwright'));
  return roots;
}

/** Executables in Playwright's chromium-<n> folders, newest first; the folder names follow playwright-core's registry. */
export function playwrightCandidates(platform = process.platform, roots = playwrightRoots()) {
  const tails = {
    win32: [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']],
    darwin: [['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']],
    linux: [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']],
  }[platform === 'win32' || platform === 'darwin' ? platform : 'linux'];
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
  // absolute PATH entries only: a relative one would name a program in whatever folder the helper runs in
  for (const dir of (process.env.PATH || '').split(delimiter)) for (const n of names) if (dir && isAbsolute(dir)) out.push(join(dir, n));
  return out;
}

/** Candidate browser paths in search order (env CHROME first). */
export function browserCandidates() {
  const env = process.env.CHROME ? [resolve(process.env.CHROME)] : [];
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
  if (process.env.CHROME) return existsSync(process.env.CHROME) ? resolve(process.env.CHROME) : null;
  for (const p of browserCandidates()) if (p && existsSync(p)) return p;
  return null;
}

const KEYS = {
  ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Enter: ['Enter', 13], ' ': ['Space', 32], PageDown: ['PageDown', 34],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], PageUp: ['PageUp', 33], Backspace: ['Backspace', 8], b: ['KeyB', 66],
};

// ---------- snap Chromium (Linux) ----------
// A snap browser runs confined: it has its own /tmp and sees only non-hidden folders under the home folder (and
// its own ~/snap/<name>/). /snap/bin/chromium is a link to /usr/bin/snap, and Ubuntu's chromium-browser and
// chromium commands are scripts that run /snap/bin/chromium.

/** True when the browser is a snap: its path, its real path, and the first bytes of the real file. Pure. */
export function isSnap(path, real = path, head = '') {
  const p = String(path), r = String(real);
  return p.startsWith('/snap/') || r.includes('/snap/') || /(^|\/)snap$/.test(r) || (/^#!/.test(head) && /\/snap\/bin\//.test(head));
}

/** isSnap for a browser on this PC (Linux only). */
export function snapBrowser(browser, platform = process.platform) {
  if (platform !== 'linux' || !browser) return false;
  let real = browser, head = '';
  try { real = realpathSync(browser); } catch { /* keep the given path */ }
  try {
    const fd = openSync(real, 'r'), buf = Buffer.alloc(4096);
    try { head = buf.toString('latin1', 0, readSync(fd, buf, 0, buf.length, 0)); } finally { closeSync(fd); }
  } catch { /* unreadable: decided by the paths */ }
  return isSnap(browser, real, head);
}

/** Where the profile and other files the browser must read go: OS temp, or for a snap ~/snap/chromium/common, the one
 * folder under home a snap Chromium may write (any hidden folder is unreadable to it). scratchDir creates it when the
 * snap has never run; snapd creates its own folders with MkdirAll, so one that already exists is kept. Pure. */
export function scratchBase(snap, home = homedir()) {
  return snap ? join(home, 'snap', 'chromium', 'common') : tmpdir();
}

/** A new empty folder in scratchBase (the caller removes it). */
export function scratchDir(browser, prefix) {
  const base = scratchBase(snapBrowser(browser));
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

/** Whether a snap browser can read the file: under home, no hidden folder on the way (except ~/snap/chromium/). Pure. */
export function snapCanRead(file, home = homedir()) {
  const rel = relative(home, resolve(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  if (parts[0] === 'snap' && parts[1] === 'chromium') return true;
  return !parts.some((x) => x.startsWith('.'));
}

export const snapUnreadable = (file) => Object.assign(new Error(`snap Chromium cannot read ${file}: a snap browser sees only non-hidden folders under your home, not /tmp. `
  + "Put the deck under your home folder, or set CHROME to a browser not installed by snap (Chrome, Edge or Playwright's chromium)"), { exit: 2 });

// ---------- launch ----------
// Windows: taskkill from System32 (a bare name is looked up in the current folder first)
const taskkill = () => win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

function killTree(proc) {
  if (!proc.pid || proc.exitCode != null || proc.signalCode != null) return;
  try {
    if (process.platform === 'win32') execFileSync(taskkill(), ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
    else proc.kill('SIGKILL');
  } catch { /* already gone */ }
}

function removeDir(dir) {
  for (let i = 0; i < 10; i++) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked, retry */ }
    if (!existsSync(dir)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
}

/** Splits a byte stream into NUL-terminated messages; feed(chunk) calls onMessage(text) per complete message. */
export function nulSplitter(onMessage) {
  let parts = [];
  return (chunk) => {
    let start = 0;
    for (let i; (i = chunk.indexOf(0, start)) !== -1; start = i + 1) {
      parts.push(chunk.subarray(start, i));
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      onMessage(text);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  };
}

/** The protocol over the browser's fd 3 (we write) and fd 4 (we read). */
function pipeTransport(proc, onEvent) {
  const toB = proc.stdio[3], fromB = proc.stdio[4];
  let id = 0, gone = null;
  const pending = new Map();
  const failAll = (why) => { gone = gone || why; for (const p of pending.values()) p.rej(new Error(`${p.method}: ${gone}`)); pending.clear(); };
  fromB.on('data', nulSplitter((text) => {
    const d = JSON.parse(text);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.rej(new Error(`${p.method}: ${d.error.message}`)); else p.res(d.result);
    } else if (d.method && onEvent) onEvent(d.method, d.params, d.sessionId);
  }));
  for (const s of [toB, fromB]) s.on('error', () => failAll('the browser pipe broke'));
  proc.on('exit', (code, sig) => failAll(`the browser exited (${sig || code})`));
  proc.on('error', (e) => failAll(`the browser did not run (${e.code || e.message})`));
  const send = (method, params = {}, sessionId, ms = CMD_MS) => new Promise((res, rej) => {
    if (gone) { rej(new Error(`${method}: ${gone}`)); return; }
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`${method}: no reply in ${ms} ms`)); }, ms);
    pending.set(i, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    toB.write(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }) + '\0');
  });
  const end = () => { failAll('the browser was closed'); for (const s of [toB, fromB]) { try { s.destroy(); } catch { /* closed */ } } };
  return { send, end };
}

/** Starts a headless browser. onEvent(method, params, sessionId) receives protocol events; extraArgs are added browser flags. */
export async function launch({ onEvent, browser = findBrowser(), extraArgs = [] } = {}) {
  if (!browser) throw new Error('no Chrome, Edge or Chromium found (set CHROME to the browser executable)');
  browser = resolve(browser);
  const snap = snapBrowser(browser);
  const profile = scratchDir(browser, 'pgg-chrome-');
  const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio', '--window-size=1920,1080', '--force-device-scale-factor=1',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions'];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push(...extraArgs, 'about:blank');
  const proc = spawn(browser, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const pipe = pipeTransport(proc, onEvent);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    killTree(proc);
    pipe.end();
    removeDir(profile);
  };
  // a file the snap browser cannot see fails here with the reason, not later as a page that never loads
  const send = (method, params = {}, sessionId, ms) => {
    const url = params && typeof params.url === 'string' ? params.url : '';
    if (snap && /^file:/i.test(url) && (method === 'Page.navigate' || method === 'Target.createTarget')) {
      const file = fileURLToPath(url.split('#')[0]);
      if (!snapCanRead(file)) return Promise.reject(snapUnreadable(file));
    }
    return pipe.send(method, params, sessionId, ms);
  };
  let timer;
  try {
    await Promise.race([pipe.send('Browser.getVersion'), new Promise((res, rej) => { timer = setTimeout(() => rej(new Error('no reply in 20 s')), 20000); })]);
  } catch (e) {
    close();
    throw new Error(`browser did not start: ${browser} (${e.message})`);
  } finally {
    clearTimeout(timer);
  }

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
      // ms: the reply time for an expression that awaits longer than one command (pptx.mjs compareMs)
      async eval(expression, ms) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, ms);
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
  return { send, open, close, browser, snap, profile, pid: proc.pid };
}

// node scripts/cdp.mjs: prints the browser the gates will use, or says none was found (exit 2)
// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findBrowser();
  process.stdout.write(found ? `browser ${found}\n` : 'no Chrome, Edge or Chromium found (set CHROME to the browser executable)\n');
  process.exit(found ? 0 : 2);
}
