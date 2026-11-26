// static(요청 시각 스냅샷) 시험. 임시 프로젝트에 고정 자료(assets/fixture)를 넣고 CLI 로 기본 자리와 시각 이름, 같은 분의 번호,
// snapshots/ 생성, 자료 폴더 없음 종료 1, <file> 인자, HTML 의 갱신 연결 0 과 기준 시각, 서버를 건드리지 않음,
// init --memory later 의 갱신 규칙 줄(status)을 본다. 화면 e2e 는 Playwright Chromium 으로 file:// 에서 연다(pm-adr.test.mjs 와 같은 방식).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeNumbered, writeSnapshot } from './pm-render.mjs';
import { reject } from './pm-adr.mjs';
import { UsageError, dataReal, sameNode } from './pm-config.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
const FIX = path.resolve(HERE, '..', 'assets', 'fixture');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-static-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|CODEX_|PROGRESS_MON_|PM_TEST_|GIT_)/i.test(k)) env[k] = v;
  return Object.assign(env, {
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    NO_COLOR: '1',
    GIT_CEILING_DIRECTORIES: ROOT,
  });
})();
const FILES = ['config.json', 'items.json', 'req-spec.json', 'reqs.json', 'flow.json', 'arch.json', 'adr.json', 'wbs.json'];
const NOW = '2026-11-26T05:30:00Z';
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
// 이 계정이 심볼릭 링크를 만들 수 있는지(Windows 는 관리자나 개발자 모드). 못 만들면 링크 시험은 그 까닭으로 건너뜀.
const symlinkSkip = (() => {
  if (process.platform !== 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'can-symlink-'));
  try {
    fs.writeFileSync(path.join(d, 't'), '');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'file');
    return false;
  } catch {
    return 'this Windows account cannot make symbolic links (needs an elevated administrator or Developer Mode)';
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

const two = (x) => String(x).padStart(2, '0');
// 스크립트와 같은 규칙: 실행 환경 시간대의 벽시계 YYYYMMDD-HHmm(자식 프로세스는 같은 환경 변수로 돈다).
const stampOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
};
const shown = (iso) => new Date(iso).toLocaleString('ko-KR', { hour12: false });

let n = 0;
// 고정 자료를 복사한 자료 폴더(.omc/progress-mon). data 가 거짓이면 자료 폴더 없는 프로젝트.
function project(data = true) {
  const dir = path.join(ROOT, `p${++n}`);
  const d = path.join(dir, '.omc', 'progress-mon');
  fs.mkdirSync(data ? d : dir, { recursive: true });
  if (data) for (const f of FILES) fs.copyFileSync(path.join(FIX, f), path.join(d, f));
  return { dir, data: d, snaps: path.join(d, 'snapshots') };
}

test('static: 기본 자리 snapshots/progress-mon-<YYYYMMDD-HHmm>.html, snapshots/ 를 만들고 경로, 기준 시각, 단일 파일 줄', T, () => {
  const p = project();
  assert.equal(fs.existsSync(p.snaps), false);
  const r = cli(['static', '--now', NOW], p.dir);
  assert.equal(r.code, 0, r.err);
  const file = path.join(p.snaps, `progress-mon-${stampOf(NOW)}.html`);
  assert.deepEqual(r.out.trimEnd().split('\n'), [`스냅샷: ${file}`, `기준 시각: ${shown(NOW)}`, '서버 없이 여는 단일 파일(자동 갱신 없음, 외부 자원 없음). 서버는 그대로 둠']);
  assert.ok(fs.statSync(p.snaps).isDirectory());
  assert.deepEqual(fs.readdirSync(p.snaps), [path.basename(file)]);
  assert.ok(path.isAbsolute(file));
});

test('static: 같은 분에 또 만들면 덮어쓰지 않고 -2, -3. 다음 분은 새 이름', T, () => {
  const p = project();
  const base = path.join(p.snaps, `progress-mon-${stampOf(NOW)}`);
  assert.equal(cli(['static', '--now', NOW], p.dir).code, 0);
  const first = fs.readFileSync(`${base}.html`, 'utf8');
  const sameMin = ['2026-11-26T05:30:20Z', '2026-11-26T05:30:59Z'];
  for (const [i, at] of sameMin.entries()) {
    const r = cli(['static', '--now', at], p.dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], `스냅샷: ${base}-${i + 2}.html`);
    assert.ok(fs.readFileSync(`${base}-${i + 2}.html`, 'utf8').includes(`스냅샷 ${shown(at)} 기준`));
  }
  assert.equal(fs.readFileSync(`${base}.html`, 'utf8'), first, '첫 파일은 그대로');
  const next = cli(['static', '--now', '2026-11-26T05:31:00Z'], p.dir);
  assert.equal(next.out.split('\n')[0], `스냅샷: ${path.join(p.snaps, `progress-mon-${stampOf('2026-11-26T05:31:00Z')}.html`)}`);
  assert.equal(fs.readdirSync(p.snaps).length, 4);
});

test('static: 그 이름에 끊어진 링크가 있으면 따라가지 않고 -2', { ...T, skip: symlinkSkip }, () => {
  const p = project();
  fs.mkdirSync(p.snaps);
  const target = path.join(p.dir, 'outside.html');
  const base = path.join(p.snaps, `progress-mon-${stampOf(NOW)}`);
  fs.symlinkSync(target, `${base}.html`, 'file');
  const r = cli(['static', '--now', NOW], p.dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n')[0], `스냅샷: ${base}-2.html`);
  assert.equal(fs.existsSync(target), false, '링크 너머에 파일을 만들지 않음');
  assert.ok(fs.lstatSync(`${base}.html`).isSymbolicLink());
});

test('static: 자료 폴더가 없으면 종료 1(init 먼저), 폴더를 만들지 않음. <file> 을 주어도 같음', T, () => {
  const p = project(false);
  for (const args of [['static'], ['static', path.join(p.dir, 'x.html')]]) {
    const r = cli(args, p.dir);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.equal(r.err, '오류: 자료 폴더 없음(.omc/progress-mon/). init 먼저 실행\n');
  }
  assert.equal(fs.existsSync(path.join(p.dir, '.omc')), false);
  assert.equal(fs.existsSync(path.join(p.dir, 'x.html')), false);
});

test('static <file>: 그 파일에 쓰고 snapshots/ 는 만들지 않음. 인자 오류는 종료 1', T, () => {
  const p = project();
  const out = path.join(p.dir, 'out', 'snap.html');
  fs.mkdirSync(path.dirname(out));
  const r = cli(['static', out, '--now', NOW], p.dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n')[0], `스냅샷: ${out}`);
  assert.ok(fs.readFileSync(out, 'utf8').includes(`스냅샷 ${shown(NOW)} 기준`));
  assert.equal(fs.existsSync(p.snaps), false);
  assert.match(cli(['static', 'a.html', 'b.html'], p.dir).err, /사용: static \[<file>\] \[--now <ISO>\]/);
  assert.match(cli(['static', '--now', 'yesterday'], p.dir).err, /--now 는 ISO 8601 시각/);
  assert.match(cli(['static', path.join(p.dir, 'no-such', 'x.html')], p.dir).err, /쓰기 실패/);
});

test('static: snapshots 자리에 파일이 있으면 거부(종료 1), 문구는 링크일 때와 같음', T, () => {
  const p = project();
  fs.writeFileSync(p.snaps, 'x');
  const r = cli(['static', '--now', NOW], p.dir);
  assert.equal(r.code, 1);
  assert.equal(r.err, '오류: snapshots 자리에 폴더가 아닌 것(링크 포함)이 있어 거부\n');
  assert.equal(fs.readFileSync(p.snaps, 'utf8'), 'x');
});

const REFUSE = '오류: snapshots 자리에 폴더가 아닌 것(링크 포함)이 있어 거부\n';

// 폴더 링크는 junction 으로 만든다(Windows 는 권한 없이 됨, POSIX 는 형식을 무시하고 폴더 링크).
test('static: snapshots 가 밖을 가리키는 폴더 링크면 거부하고 밖에 쓰지 않음', T, () => {
  const p = project();
  const outside = path.join(p.dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, p.snaps, 'junction');
  const r = cli(['static', '--now', NOW], p.dir);
  assert.equal(r.code, 1);
  assert.equal(r.err, REFUSE);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('static: snapshots 가 끊어진 링크면 같은 문구로 거부하고 링크 너머에 폴더를 만들지 않음', T, () => {
  const p = project();
  const gone = path.join(p.dir, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, p.snaps, 'junction');
  fs.rmSync(gone, { recursive: true });
  const r = cli(['static', '--now', NOW], p.dir);
  assert.equal(r.code, 1);
  assert.equal(r.err, REFUSE);
  assert.equal(fs.existsSync(gone), false);
});

const run = (args, cwd) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd, env: ENV, windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });

test('static: 같은 시각으로 동시에 8번 불러도 이름이 겹치지 않고 모두 온전한 파일', T, async () => {
  const p = project();
  const rs = await Promise.all(Array.from({ length: 8 }, () => run(['static', '--now', NOW], p.dir)));
  assert.deepEqual(rs.map((r) => r.code), Array(8).fill(0));
  const files = rs.map((r) => r.out.split('\n')[0].slice('스냅샷: '.length));
  assert.equal(new Set(files).size, 8);
  const base = path.join(p.snaps, `progress-mon-${stampOf(NOW)}`);
  assert.deepEqual(new Set(files), new Set([`${base}.html`, ...[2, 3, 4, 5, 6, 7, 8].map((i) => `${base}-${i}.html`)]));
  const sizes = new Set(files.map((f) => fs.statSync(f).size));
  assert.equal(sizes.size, 1, '모두 같은 크기');
  for (const f of files) assert.ok(fs.readFileSync(f, 'utf8').trimEnd().endsWith('</html>'), f);
});

// static <file> 과 export <file> 은 같은 규칙: 덮어쓰지 않고 번호, 링크는 따라가지 않음, 이름은 .html 이나 .htm.
for (const cmd of ['static', 'export']) {
  const head = cmd === 'static' ? '스냅샷: ' : '내보냄: ';

  test(`${cmd} <파일>: 있는 파일은 그대로 두고 -2, -3(확장자 앞)에 씀. .htm 도 같음`, T, () => {
    const p = project();
    const keep = path.join(p.dir, 'keep.html');
    fs.writeFileSync(keep, 'KEEP');
    for (const i of [2, 3]) {
      const r = cli([cmd, keep, '--now', NOW], p.dir);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out.split('\n')[0], `${head}${path.join(p.dir, `keep-${i}.html`)}`);
    }
    assert.equal(fs.readFileSync(keep, 'utf8'), 'KEEP');
    const htm = path.join(p.dir, 'Page.HTM');
    fs.writeFileSync(htm, 'OLD');
    assert.equal(cli([cmd, htm, '--now', NOW], p.dir).out.split('\n')[0], `${head}${path.join(p.dir, 'Page-2.HTM')}`);
    assert.equal(fs.readFileSync(htm, 'utf8'), 'OLD');
  });

  test(`${cmd} <파일>: 링크(있는 대상, 끊어진 것)는 따라가지 않고 -2`, { ...T, skip: symlinkSkip }, () => {
    const p = project();
    const target = path.join(p.dir, 'outside.txt');
    fs.writeFileSync(target, 'OUTSIDE');
    fs.symlinkSync(target, path.join(p.dir, 'link.html'), 'file');
    const r = cli([cmd, path.join(p.dir, 'link.html'), '--now', NOW], p.dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], `${head}${path.join(p.dir, 'link-2.html')}`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'OUTSIDE');
    const gone = path.join(p.dir, 'gone.html');
    fs.symlinkSync(gone, path.join(p.dir, 'dead.html'), 'file');
    assert.equal(cli([cmd, path.join(p.dir, 'dead.html'), '--now', NOW], p.dir).out.split('\n')[0], `${head}${path.join(p.dir, 'dead-2.html')}`);
    assert.equal(fs.existsSync(gone), false, '링크 너머에 파일을 만들지 않음');
  });

  test(`${cmd} <파일>: .html, .htm 이 아닌 이름은 종료 1 이고 그 파일과 자료 파일은 그대로`, T, () => {
    const p = project();
    const notes = path.join(p.dir, 'notes.txt');
    fs.writeFileSync(notes, 'IMPORTANT');
    const items = path.join(p.data, 'items.json');
    const before = fs.readFileSync(items, 'utf8');
    for (const f of [notes, items, path.join(p.dir, 'x.html.bak'), path.join(p.dir, 'noext')]) {
      const r = cli([cmd, f, '--now', NOW], p.dir);
      assert.equal(r.code, 1, f);
      assert.equal(r.err, `오류: 파일 이름은 .html 이나 .htm 으로 끝나야 함: ${f}\n`);
    }
    assert.equal(fs.readFileSync(notes, 'utf8'), 'IMPORTANT');
    assert.equal(fs.readFileSync(items, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(p.dir, 'noext')), false);
  });
}

test('번호 고리 상한: writeNumbered, adr.json 옮기기 모두 상한을 넘으면 오류 줄, 새 파일 0, 원본 그대로', T, () => {
  const p = project();
  const stem = path.join(p.dir, 'full');
  for (const f of ['full.html', 'full-2.html', 'full-3.html']) fs.writeFileSync(path.join(p.dir, f), f);
  const before = fs.readdirSync(p.dir).sort();
  assert.throws(() => writeNumbered(stem, '.html', 'x', 3), (e) => e instanceof UsageError && e.message === `새 이름을 찾지 못함: ${stem}.html 부터 -3 까지 모두 있음`);
  assert.deepEqual(fs.readdirSync(p.dir).sort(), before);
  for (const f of ['full.html', 'full-2.html', 'full-3.html']) assert.equal(fs.readFileSync(path.join(p.dir, f), 'utf8'), f);
  assert.equal(writeNumbered(stem, '.html', 'x', 4), `${stem}-4.html`);
  const adr = path.join(p.data, 'adr.json');
  const at = Date.parse(NOW);
  const first = reject(adr, at, 1);
  fs.copyFileSync(first, adr);
  const bytes = fs.readFileSync(adr);
  assert.throws(() => reject(adr, at, 1), (e) => e instanceof UsageError && /옮길 새 이름을 찾지 못함: .*-1 까지 모두 있음\. adr\.json 그대로$/.test(e.message));
  assert.deepEqual(fs.readFileSync(adr), bytes, 'adr.json 그대로');
  assert.equal(reject(adr, at, 2), `${first}-2`);
});

// 바꿔치기 흉내. 쓰는 함수가 폴더를 본 뒤 단계마다(checked: 본 직후, pinned: 열기 직전, opened: 연 뒤 내용 쓰기 전) 부르는
// 훅에서 그 폴더를 바꾼다. move: 진짜 폴더를 밖으로 옮기고 그 자리에 밖을 가리키는 링크(정체 dev, ino 가 같음). other: 진짜 폴더를
// 옆 이름으로 옮기고 밖의 빈 폴더를 가리키는 링크. 링크는 junction(Windows 는 권한 없이 됨, POSIX 는 폴더 링크).
// Windows 는 열린 파일이 있는 폴더를 옮길 수 없어(EPERM) 옮기기가 실패할 수 있다. 그때는 바꿔치기가 없었으므로 안에 써야 한다.
const PINNED = new Set(['EPERM', 'EBUSY', 'EACCES']);
function swapDir(dir, outside, mode) {
  try {
    if (mode === 'move') {
      fs.renameSync(dir, path.join(outside, 'moved'));
      fs.symlinkSync(path.join(outside, 'moved'), dir, 'junction');
    } else {
      fs.renameSync(dir, `${dir}-old`);
      fs.mkdirSync(path.join(outside, 'other'));
      fs.symlinkSync(path.join(outside, 'other'), dir, 'junction');
    }
    return true;
  } catch (e) {
    if (process.platform === 'win32' && PINNED.has(e.code)) return false;
    throw e;
  }
}
// 밖 폴더 아래에서 이름이 맞는 파일(이번 쓰기가 만들 수 있는 것) 목록. 링크는 따라가지 않는다(Node 18 은 recursive 없음).
function written(dir, re) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...written(f, re));
    else if (re.test(e.name)) out.push(f);
  }
  return out;
}
// 훅: 고른 단계에서 한 번 바꿔치기. 돌려줌: { hook, swapped() }
function swapAt(stage, dir, outside, mode) {
  let did = null;
  return {
    hook: (s) => {
      if (s === stage && did === null) did = swapDir(dir, outside, mode);
    },
    swapped: () => did,
  };
}
// 바꿔치기가 됐으면 쓰기는 거부(UsageError)이고 밖에 쓴 파일 0. 막혔으면(Windows) 안에 내용이 온전히 있음.
function expectSafe(t, fn, inside, outside, re, data) {
  let out = null;
  let err = null;
  try {
    out = fn();
  } catch (e) {
    err = e;
  }
  assert.deepEqual(written(outside, re), [], '밖에 쓴 파일 0');
  if (t.swapped()) {
    assert.ok(err instanceof UsageError, `바꿔치기 뒤 거부: ${err && err.message}, out=${out}`);
    assert.match(err.message, /폴더가 바뀌어 쓰지 않음|거부/);
    return;
  }
  assert.equal(t.swapped(), false, '훅이 불림');
  assert.equal(err, null, err && err.message);
  assert.equal(path.dirname(out), inside);
  assert.equal(fs.readFileSync(out, 'utf8'), data);
}

const STAGES = ['checked', 'pinned', 'opened'];
for (const mode of ['move', 'other']) {
  test(`바꿔치기(${mode}): static 기본 자리. snapshots 를 본 뒤 단계마다 링크로 바꿔도 밖에 한 바이트도 쓰지 않음`, T, () => {
    for (const stage of STAGES) {
      const p = project();
      fs.mkdirSync(p.snaps);
      const outside = path.join(ROOT, `out-${n}-${stage}`);
      fs.mkdirSync(outside);
      const ctx = { project: p.dir, runtime: 'claude', dataDir: p.data, exists: true };
      const t = swapAt(stage, p.snaps, outside, mode);
      expectSafe(t, () => writeSnapshot(ctx, 'SNAP', Date.parse(NOW), { hook: t.hook }), p.snaps, outside, /^progress-mon-/, 'SNAP');
      if (process.platform !== 'win32' || stage !== 'opened') assert.equal(t.swapped(), true, `${stage}: 열린 파일이 없을 때는 바꿔치기가 됨`);
    }
  });

  test(`바꿔치기(${mode}): static, export <파일>. 그 파일의 폴더를 열기 직전이나 연 뒤 링크로 바꿔도 밖에 쓰지 않음`, T, () => {
    for (const stage of ['pinned', 'opened']) {
      const p = project();
      const dir = path.join(p.dir, 'out-dir');
      fs.mkdirSync(dir);
      const outside = path.join(ROOT, `out-${n}-${stage}`);
      fs.mkdirSync(outside);
      const t = swapAt(stage, dir, outside, mode);
      expectSafe(t, () => writeNumbered(path.join(dir, 'page'), '.html', 'PAGE', 999, { hook: t.hook }), dir, outside, /^page/, 'PAGE');
    }
  });

  test(`바꿔치기(${mode}): adr.json.rejected 옮기기. 자료 폴더를 바꿔도 밖에 사본을 쓰지 않고 adr.json 을 잃지 않음`, T, () => {
    for (const stage of ['pinned', 'opened']) {
      const p = project();
      const ctx = { project: p.dir, runtime: 'claude', dataDir: p.data, exists: true };
      const want = dataReal(ctx);
      const adr = path.join(p.data, 'adr.json');
      const bytes = fs.readFileSync(adr);
      const outside = path.join(ROOT, `out-${n}-${stage}`);
      fs.mkdirSync(outside);
      const t = swapAt(stage, p.data, outside, mode);
      expectSafe(t, () => reject(adr, Date.parse(NOW), 999, { want, hook: t.hook }), p.data, outside, /rejected/, bytes.toString('utf8'));
      if (t.swapped()) {
        const real = mode === 'move' ? path.join(outside, 'moved', 'adr.json') : `${p.data}-old${path.sep}adr.json`;
        assert.deepEqual(fs.readFileSync(real), bytes, 'adr.json 을 잃지 않음');
      } else assert.equal(fs.existsSync(path.join(p.data, 'adr.json')), false, '옮겼으면 원본은 지움');
    }
  });
}

test('static: 자료 폴더의 위 폴더(.omc)가 링크면 snapshots 의 실제 경로가 밖이라 거부, 밖에 쓰지 않음', T, () => {
  const p = project();
  const outside = path.join(ROOT, `out-${n}-up`);
  fs.mkdirSync(outside);
  fs.renameSync(path.join(p.dir, '.omc'), path.join(outside, '.omc'));
  fs.symlinkSync(path.join(outside, '.omc'), path.join(p.dir, '.omc'), 'junction');
  const ctx = { project: p.dir, runtime: 'claude', dataDir: p.data, exists: true };
  assert.throws(() => writeSnapshot(ctx, 'SNAP', Date.parse(NOW)), (e) => e instanceof UsageError && e.message.startsWith('snapshots 의 실제 경로가 자료 폴더 밖이라 거부(위 폴더가 링크): '));
  assert.deepEqual(written(outside, /^progress-mon-/), []);
});

test('static HTML: meta refresh, fetch, 주기 갱신 스크립트, 서버 주소 0. 윗부분에 스냅샷 <시각> 기준, 6탭', T, () => {
  const p = project();
  const r = cli(['static', '--now', NOW], p.dir);
  const html = fs.readFileSync(r.out.split('\n')[0].slice('스냅샷: '.length), 'utf8');
  for (const bad of [/http-equiv/i, /\bfetch\s*\(/, /XMLHttpRequest/, /EventSource/, /WebSocket/, /sendBeacon/, /setInterval/, /setTimeout/, /location\.reload/, /\/\?tab=/, /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i]) {
    assert.ok(!bad.test(html), String(bad));
  }
  const top = html.slice(html.indexOf('<body>'), html.indexOf('<div class="tabs">'));
  assert.ok(top.includes(`<div class="meta">스냅샷 ${shown(NOW)} 기준 | 서버 없이 여는 단일 파일(자동 갱신 없음)`), top);
  assert.equal((html.match(/<section id="tab-/g) || []).length, 6);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => ([3456, 3458, 30000].some((f) => f >= port && f <= port + 100) ? resolve(freePort()) : resolve(port)));
    });
  });
}

test('static: 서버를 띄우지도 끄지도 않음(꺼져 있으면 그대로 꺼짐, 떠 있으면 같은 PID 로 실행 중)', T, async () => {
  const p = project();
  assert.equal(cli(['static', '--now', NOW], p.dir).code, 0);
  assert.equal(cli(['status'], p.dir).code, 3);
  assert.equal(fs.existsSync(path.join(p.data, 'server.json')), false);
  const port = await freePort();
  try {
    assert.equal(cli(['start', '--port', String(port)], p.dir).code, 0);
    const pid = JSON.parse(fs.readFileSync(path.join(p.data, 'server.json'), 'utf8')).pid;
    assert.equal(cli(['static', '--now', NOW], p.dir).code, 0);
    const s = cli(['status'], p.dir);
    assert.equal(s.code, 0);
    assert.equal(s.out.split('\n')[0], `실행 중: http://127.0.0.1:${port}/ (PID ${pid})`);
  } finally {
    cli(['stop'], p.dir);
  }
});

// 읽기 전용 쓰기 막힘 흉내(chmod). Windows 는 chmod 로 폴더 쓰기를 막지 못하고, root 는 권한을 넘으므로 그 둘은 건너뜀(OS 조건).
const readOnlySkip = process.platform === 'win32' ? 'chmod cannot make a folder read-only on Windows' : process.getuid && process.getuid() === 0 ? 'root ignores file modes' : false;
const HINT = {
  codex: '알림: 쓰기가 막힘. Codex 샌드박스면 같은 명령 하나를 sandbox_permissions: "require_escalated" 로 다시 실행(승인 요청). 승인을 못 받으면 사용자가 Codex 입력란에서 ! 를 붙여 같은 명령을 직접 실행',
  claude: '알림: 쓰기가 막힘. 그 폴더의 쓰기 권한과 읽기 전용 여부를 확인',
};

test('쓰기가 읽기 전용으로 막히면(Codex 샌드박스 흉내) static 은 종료 1 과 런타임에 맞는 막힘 안내 줄', { ...T, skip: readOnlySkip }, () => {
  for (const rt of ['claude', 'codex']) {
    const p = project();
    let snaps = p.snaps;
    if (rt === 'codex') {
      fs.mkdirSync(path.join(p.dir, '.omx'));
      fs.renameSync(p.data, path.join(p.dir, '.omx', 'progress-mon'));
      snaps = path.join(p.dir, '.omx', 'progress-mon', 'snapshots');
    }
    fs.mkdirSync(snaps);
    fs.chmodSync(snaps, 0o555);
    try {
      const r = cli(['static', '--runtime', rt, '--now', NOW], p.dir);
      assert.equal(r.code, 1);
      assert.equal(r.err, `오류: 쓰기 실패(EACCES): ${snaps}\n${HINT[rt]}\n`);
      assert.deepEqual(fs.readdirSync(snaps), []);
    } finally {
      fs.chmodSync(snaps, 0o755);
    }
  }
});

test('init: 자료 폴더를 만들 수 없으면(위 폴더 읽기 전용) 종료 1 과 막힘 안내 줄(예기치 못한 오류 종료 2 아님)', { ...T, skip: readOnlySkip }, () => {
  const p = project(false);
  const omc = path.join(p.dir, '.omc');
  fs.mkdirSync(omc);
  fs.chmodSync(omc, 0o555);
  try {
    const r = cli(['init', '--memory', 'later'], p.dir);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.err, `오류: 자료 폴더 .omc/progress-mon/ 만들지 못함(EACCES)\n${HINT.claude}\n`);
  } finally {
    fs.chmodSync(omc, 0o755);
  }
  assert.equal(fs.existsSync(p.data), false);
});

test('쓰는 중 폴더가 지워지면 원시 오류 대신 같은 거부(UsageError). Windows 는 열린 파일이 든 폴더를 못 지워 안에 씀', T, () => {
  const p = project();
  fs.mkdirSync(p.snaps);
  const ctx = { project: p.dir, runtime: 'claude', dataDir: p.data, exists: true };
  let removed = null;
  const hook = (s) => {
    if (s !== 'opened' || removed !== null) return;
    try {
      fs.rmSync(p.snaps, { recursive: true });
      removed = true;
    } catch (e) {
      if (process.platform !== 'win32' || !PINNED.has(e.code)) throw e;
      removed = false;
    }
  };
  let out = null;
  let err = null;
  try {
    out = writeSnapshot(ctx, 'SNAP', Date.parse(NOW), { hook });
  } catch (e) {
    err = e;
  }
  if (removed) assert.ok(err instanceof UsageError && err.message.startsWith('폴더가 바뀌어 쓰지 않음'), String(err));
  else assert.equal(fs.readFileSync(out, 'utf8'), 'SNAP');
});

// 하드 링크 틈: 연 뒤 쓰기 전(opened)에 생기면 지금 fstat 의 링크 수로 쓰기 전에 거부(밖 이름 0 바이트),
// 쓴 직후(written)에 생기면 모든 길에서 0 바이트로 자르고 거부. 로컬 길(POSIX, Windows NTFS) 그대로.
test('하드 링크: 쓰기 전(opened)이면 쓰지 않고, 쓴 직후(written)면 0 바이트로 잘라 거부. 밖 이름에 내용 없음', T, () => {
  for (const stage of ['opened', 'written']) {
    const p = project();
    const dir = path.join(p.dir, 'hl');
    fs.mkdirSync(dir);
    const copy = path.join(ROOT, `hl-${n}-${stage}.html`);
    const hook = (s) => {
      if (s === stage) fs.linkSync(path.join(dir, 'page.html'), copy);
    };
    assert.throws(() => writeNumbered(path.join(dir, 'page'), '.html', 'PAGE', 999, { hook }), (e) => e instanceof UsageError && e.message.startsWith('폴더가 바뀌어 쓰지 않음'), stage);
    assert.equal(fs.statSync(copy).size, 0, `${stage}: 밖 이름의 내용 0 바이트`);
    assert.equal(fs.existsSync(path.join(dir, 'page.html')), false, `${stage}: 안의 파일은 지움`);
  }
});

test('파일 ID 0(파일 ID 를 주지 않는 NAS)은 dev, ino 대조를 건너뜀(거부하지 않음). 0 이 아니면 그대로 대조', T, () => {
  assert.equal(sameNode({ dev: 1n, ino: 0n }, { dev: 2n, ino: 9n }), true);
  assert.equal(sameNode({ dev: 1n, ino: 9n }, { dev: 1n, ino: 0n }), true);
  assert.equal(sameNode({ dev: 1n, ino: 9n }, { dev: 1n, ino: 9n }), true);
  assert.equal(sameNode({ dev: 1n, ino: 9n }, { dev: 1n, ino: 8n }), false);
  assert.equal(sameNode({ dev: 1n, ino: 9n }, { dev: 2n, ino: 9n }), false);
  assert.equal(sameNode(undefined, { dev: 1n, ino: 0n }), false, '없는 이름은 거짓');
});

// 네트워크 경로(SMB) 길: rename 고정 확인 대신 쓴 직후 fd 와 경로 대조. 로컬 NTFS 에서 network: true 로 그 길을 돌린다.
const winOnly = process.platform === 'win32' ? false : 'Windows-only write path (network shares)';
test('Windows 네트워크 경로 길: 보통은 씀, 열기 전 바꿔치기는 거부, 쓴 직후 다른 이름이 생기면 0 바이트로 자르고 거부', { ...T, skip: winOnly }, () => {
  const p = project();
  const dir = path.join(p.dir, 'net');
  fs.mkdirSync(dir);
  assert.equal(fs.readFileSync(writeNumbered(path.join(dir, 'ok'), '.html', 'OK', 999, { network: true }), 'utf8'), 'OK');
  const outside = path.join(ROOT, `out-${n}-net`);
  fs.mkdirSync(outside);
  const t = swapAt('pinned', dir, outside, 'move');
  assert.throws(() => writeNumbered(path.join(dir, 'page'), '.html', 'PAGE', 999, { network: true, hook: t.hook }), (e) => e instanceof UsageError);
  assert.equal(t.swapped(), true);
  assert.deepEqual(written(outside, /^page/), []);
  const q = project();
  const dir2 = path.join(q.dir, 'net');
  fs.mkdirSync(dir2);
  const copy = path.join(outside, 'copy.html');
  const link = (s) => {
    if (s === 'written') fs.linkSync(path.join(dir2, 'late.html'), copy);
  };
  assert.throws(() => writeNumbered(path.join(dir2, 'late'), '.html', 'LATE', 999, { network: true, hook: link }), (e) => e instanceof UsageError);
  assert.equal(fs.statSync(copy).size, 0, '밖 이름의 내용은 0 바이트로 잘림');
});

// git 제외 목록 파일만 읽기 전용(Windows 는 읽기 전용 속성으로 EPERM, POSIX 는 EACCES). root 는 파일 권한을 넘으므로 건너뜀.
const rootSkip = process.platform !== 'win32' && process.getuid && process.getuid() === 0 ? 'root ignores file modes' : false;
test('git 제외 목록 쓰기가 막히면 init 은 다시 실행 안내를 내고, 다시 실행하면 자료 그대로 제외 줄만 더함', { ...T, skip: rootSkip }, () => {
  const q = project(false);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: q.dir, env: ENV }).status, 0);
  const info = path.join(q.dir, '.git', 'info');
  const excl = path.join(info, 'exclude');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(excl, '# git ls-files --others --exclude-from=.git/info/exclude\n');
  fs.chmodSync(excl, 0o444);
  try {
    const r = cli(['init', '--memory', 'later'], q.dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^알림: git 제외 목록에 추가하지 못함\((EACCES|EPERM)\)\. 샌드박스가 막았으면 승인을 받아 init 을 다시 실행\(자료 파일은 그대로 두고 제외 줄만 더함\)$/m);
  } finally {
    fs.chmodSync(excl, 0o644);
  }
  fs.writeFileSync(path.join(q.data, 'items.json'), '{"schema":1,"items":[]}\n');
  const again = cli(['init', '--memory', 'later'], q.dir);
  assert.match(again.out, /^그대로 둠: \.omc\/progress-mon\/items\.json$/m);
  assert.match(again.out, /^git 제외 목록 추가: \/\.omc\/progress-mon\/ /m);
});

// 스냅샷만 만든 자료 폴더(init --memory later)는 status 가 갱신 규칙 줄로 드러낸다. 인자 없는 호출은 그 줄로 한 번 묻는다.
test('init --memory later: 규칙을 쓰지 않고 state.json 에 later, status 의 갱신 규칙 줄(묻기, 묻지 않음, 값 오류)', T, () => {
  const p = project(false);
  const init = cli(['init', '--memory', 'later'], p.dir);
  assert.equal(init.code, 0, init.err);
  assert.ok(init.out.includes('규칙 등록 미룸(--memory later). 다음 인자 없는 호출에서 묻는다'));
  assert.equal(fs.existsSync(path.join(p.dir, 'CLAUDE.md')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.data, 'state.json'), 'utf8')).memory, { kind: 'later', path: null });
  const lines = () => cli(['status'], p.dir).out.trimEnd().split('\n');
  assert.equal(lines()[2], '갱신 규칙: 미등록(묻기)');
  const cfgFile = path.join(p.data, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, ruleAsk: false }));
  assert.equal(lines()[2], '갱신 규칙: 미등록(묻지 않음)');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, ruleAsk: 'false' }));
  assert.equal(lines()[2], '갱신 규칙: 미등록(ruleAsk 값 오류)');
  const chk = cli(['check'], p.dir);
  assert.equal(chk.code, 1);
  assert.match(chk.out, /^FAIL config\.json ruleAsk 참 또는 거짓$/m);
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  // 사용자가 등록을 고르면 init 을 런타임 표의 종류로 다시: 줄이 사라지고 규칙이 등록됨
  assert.equal(cli(['init', '--memory', 'claude-md'], p.dir).code, 0);
  assert.ok(fs.readFileSync(path.join(p.dir, 'CLAUDE.md'), 'utf8').includes('<!-- progress-mon:rule -->'));
  assert.ok(!lines().some((l) => l.startsWith('갱신 규칙:')));
});

test('기존 init 자료 폴더(규칙 등록됨, none, 기록 없음)는 갱신 규칙 줄이 없고 status 출력 그대로', T, () => {
  const kinds = [{ kind: 'claude-md', path: 'CLAUDE.md' }, { kind: 'none', path: null }, null];
  for (const memory of kinds) {
    const p = project();
    if (memory) fs.writeFileSync(path.join(p.data, 'state.json'), JSON.stringify({ runtime: 'claude', memory }));
    const s = cli(['status'], p.dir);
    assert.equal(s.code, 3);
    assert.deepEqual(s.out.trimEnd().split('\n'), ['꺼짐(자료 폴더: .omc/progress-mon/)', '탭 자료: 진척도 있음, 구현요건 있음, workflow 있음, 구성도 있음, ADR 있음, WBS 있음'], JSON.stringify(memory));
  }
  const p = project(false);
  assert.equal(cli(['init', '--memory', 'none'], p.dir).code, 0);
  assert.ok(!cli(['status'], p.dir).out.includes('갱신 규칙:'));
});

// Playwright: 테스트박스 도구 폴더(BUILD_TESTBOX_PLAYWRIGHT_DIR)가 먼저, 없으면 이 PC 의 전역 npm root. 둘 다 없으면 { skip: 사유 }.
function playwrightModules() {
  const given = process.env.BUILD_TESTBOX_PLAYWRIGHT_DIR;
  if (given) return { dir: path.join(given, 'node_modules'), from: 'BUILD_TESTBOX_PLAYWRIGHT_DIR' };
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: win, timeout: 30000 });
  return { dir: r.status === 0 ? r.stdout.trim() : '', from: 'npm root -g', status: r.status };
}

async function chromium() {
  const { dir, from, status } = playwrightModules();
  if (!dir || !fs.existsSync(path.join(dir, 'playwright'))) return { skip: `Playwright 없음(${from}: ${dir || status})` };
  try {
    const mod = await import(pathToFileURL(createRequire(path.join(dir, 'noop.js')).resolve('playwright')).href);
    const browser = await (mod.chromium || mod.default.chromium).launch();
    return { browser };
  } catch (e) {
    return { skip: `Chromium 을 띄우지 못함: ${String(e.message).split('\n')[0]}` };
  }
}

// 네트워크를 끈 브라우저 맥락에서 file:// 로 연다. 탭 머리를 차례로 눌러 6탭이 하나씩 보이고, 윗부분에 기준 시각이 보이며,
// 문서 밖 요청(file: 과 data: 가 아닌 것)이 0 이고 2초 기다려도 새 요청이 없다(주기 갱신 없음).
test('화면 e2e: static 스냅샷을 오프라인 Chromium 으로 file:// 에서 열어 6탭 전환, 기준 시각, 네트워크 요청 0', { timeout: 120000 }, async (t) => {
  const got = await chromium();
  if (got.skip) return t.skip(got.skip);
  const p = project();
  const file = cli(['static', '--now', NOW], p.dir).out.split('\n')[0].slice('스냅샷: '.length);
  try {
    const context = await got.browser.newContext({ offline: true });
    const page = await context.newPage();
    const reqs = [];
    page.on('request', (q) => reqs.push(q.url()));
    await page.goto(pathToFileURL(file).href);
    assert.ok((await page.textContent('body > .meta')).startsWith(`스냅샷 ${shown(NOW)} 기준`));
    const keys = ['history', 'req', 'workflow', 'arch', 'adr', 'wbs'];
    for (const k of keys) {
      await page.click(`.tabs a[data-tab="${k}"]`);
      // 전환은 hashchange 처리기가 한다(비동기). 그 탭이 cur 가 될 때까지 기다린 뒤 본다
      await page.waitForFunction((x) => document.getElementById(`tab-${x}`).classList.contains('cur'), k, { timeout: 5000 });
      for (const x of keys) assert.equal(await page.isVisible(`#tab-${x}`), x === k, `${k} 를 눌렀을 때 ${x}`);
      assert.equal(await page.getAttribute(`.tabs a[data-tab="${k}"]`, 'class'), 'on');
    }
    await page.click('.tabs a[data-tab="adr"]');
    await page.waitForFunction(() => document.getElementById('tab-adr').classList.contains('cur'), null, { timeout: 5000 });
    const heads = await page.$$eval('#tab-adr h3', (hs) => hs.filter((h) => h.offsetParent !== null).map((h) => h.textContent));
    for (const s of ['검증', '흐름', '증거', '최적화 로직', '확장 대응', '포기와 얻은 것']) assert.ok(heads.includes(s), `ADR ${s}: ${heads.join(', ')}`);
    await page.click('.tabs a[data-tab="wbs"]');
    await page.waitForFunction(() => document.getElementById('tab-wbs').classList.contains('cur'), null, { timeout: 5000 });
    assert.ok((await page.$$eval('#tab-wbs .wbsg tbody td', (tds) => tds.filter((td) => td.style.background).length)) > 0, 'WBS 막대 칸');
    await page.waitForTimeout(2000);
    const outside = reqs.filter((u) => !u.startsWith('file:') && !u.startsWith('data:'));
    assert.deepEqual(outside, [], '네트워크 요청 0');
    assert.equal(reqs.filter((u) => u.startsWith('file:')).length, 1, '문서 한 번만 읽음(다시 읽기 없음)');
    if (process.env.PM_STATIC_SHOT) fs.writeFileSync(process.env.PM_STATIC_SHOT, await page.screenshot({ fullPage: true }));
  } finally {
    await got.browser.close();
  }
});
