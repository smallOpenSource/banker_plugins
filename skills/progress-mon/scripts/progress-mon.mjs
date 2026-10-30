#!/usr/bin/env node
// progress-mon.mjs: CLI 진입. 인자 해석, 런타임 판별, 하위 명령 분기, --help, 종료 코드.
// 종료 코드: 0 성공, 1 거부나 사용법 오류, 2 예기치 못한 오류, 3 status 꺼짐.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveContext, configOrFail, dataLabel, writeAtomic, UsageError } from './pm-config.mjs';
import { serve, start, stop, status } from './pm-server.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(CLI_PATH), '..');

export const HELP = `progress-mon: 프로젝트 진척도 웹 화면

사용: node progress-mon.mjs <명령> [인자]

명령
  init      --memory claude-md|agents-md|auto-memory|none [--memory-dir <dir>] [--title <t>]
            자료 폴더와 config.json, items.json 을 만들고 갱신 규칙 등록
  start     [--port <n>] [--port-strict] [--host <사설 IPv4>]
            서버를 분리 실행하고 URL 출력. 같은 프로젝트 서버가 떠 있으면 재사용
  stop      서버 정지. 상태 파일의 PID 가 이 서버일 때만
  status    실행 여부, URL, PID, 자료 폴더, 탭별 자료 유무
  export    <file> [--now <ISO>]
            외부 자원 없는 단일 HTML
  item      --key <k> --status todo|doing|done --text <t> [--note <t>] [--issue <t>] [--at <ISO>] [--commit <hash>]
  note      --key <k> [--note <t>] [--issue <t>]
  stage     --id <id> --status started|done|skipped|failed|stopped [--label <t>]
  story     --id <id> (--status todo|doing|done | --commit <hash>) [--name <t>]
  check     자료 파일 검사. FAIL, WARN 한 줄씩

공통 인자
  --runtime claude|codex    자료 폴더 기본값(.omc/progress-mon/, .omx/progress-mon/)
  --project <dir>           프로젝트 루트
  --data <dir>              자료 폴더 직접 지정

종료 코드: 0 성공, 1 거부나 사용법 오류, 2 예기치 못한 오류, 3 status 꺼짐
`;

// 값을 받는 인자와 값 없는 인자.
const VALUE_FLAGS = new Set(['runtime', 'project', 'data', 'port', 'host', 'memory', 'memory-dir', 'title', 'now', 'key', 'status', 'text', 'note', 'issue', 'id', 'label', 'commit', 'name', 'at']);
const BOOL_FLAGS = new Set(['port-strict', 'help']);

// 서버 밖 명령을 맡는 모듈. 쓰는 명령에서만 적재한다.
const MODS = {
  init: 'pm-data.mjs',
  item: 'pm-data.mjs',
  note: 'pm-data.mjs',
  stage: 'pm-data.mjs',
  story: 'pm-data.mjs',
  export: 'pm-render.mjs',
  check: 'pm-check.mjs',
};
const SERVER_CMDS = new Set(['serve', 'start', 'stop', 'status']);
// 자료 폴더가 없으면 init 먼저(폴더를 만들지 않음).
const NEED_DATA = new Set(['serve', 'start', 'item', 'note', 'stage', 'story']);

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      o.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOL_FLAGS.has(name)) {
      if (eq > 0) throw new UsageError(`${a.slice(0, eq)} 는 값을 받지 않음`);
      o[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`--${name} 에 값이 필요함`);
      o[name] = v;
    } else throw new UsageError(`모르는 인자: ${a}`);
  }
  return o;
}

function portArg(v) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1024 || Number(v) > 65535) throw new UsageError(`--port 는 1024~65535 정수: ${v}`);
  return Number(v);
}

// 자료 폴더가 이미 있을 때만 state.json 의 skillDir, runtime 을 맞춘다. 값이 같으면 쓰지 않는다.
async function touchState(ctx) {
  if (!ctx.exists) return;
  const file = path.join(ctx.dataDir, 'state.json');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cur = {};
  }
  if (cur && cur.skillDir === SKILL_DIR && cur.runtime === ctx.runtime) return;
  const next = { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), skillDir: SKILL_DIR, runtime: ctx.runtime, updatedAt: new Date().toISOString() };
  try {
    await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
  } catch {
    // 못 써도 명령은 계속. 다음 실행이 다시 맞춘다
  }
}

export async function main(argv, io, cwd = process.cwd()) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  if (o.help || !cmd) {
    io.write(HELP);
    return 0;
  }
  if (!SERVER_CMDS.has(cmd) && !MODS[cmd]) throw new UsageError(`모르는 명령: ${cmd}. --help 참고`);
  const ctx = resolveContext({ cwd, project: o.project, runtime: o.runtime, data: o.data });
  if (ctx.warn) io.err(ctx.warn);
  if (NEED_DATA.has(cmd) && !ctx.exists) throw new UsageError(`자료 폴더 없음(${dataLabel(ctx)}). init 먼저 실행`);
  await touchState(ctx);
  if (MODS[cmd]) {
    const mod = await import(`./${MODS[cmd]}`);
    return mod.command(cmd, ctx, o, io, { skillDir: SKILL_DIR });
  }
  if (cmd === 'stop') return stop(ctx, io);
  if (cmd === 'status') return status(ctx, io);
  const config = configOrFail(ctx);
  const opts = { port: portArg(o.port), portStrict: Boolean(o['port-strict']), host: o.host };
  if (cmd === 'start') return start(ctx, config, opts, io, { cliPath: CLI_PATH });
  const srv = await serve(ctx, config, opts, io);
  const quit = () => srv.close().then(() => process.exit(0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, quit);
  return null;
}

const stdio = {
  write: (s) => process.stdout.write(s),
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
};

// 직접 실행인지: 실행 경로와 이 파일을 실제 경로로 풀어 비교한다(junction, symlink 로 불러도 같음).
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(real(process.argv[1]), real(CLI_PATH))) {
  main(process.argv.slice(2), stdio).then(
    (code) => {
      // serve 는 null: 리스너가 프로세스를 붙잡는다.
      if (code !== null) process.exitCode = code;
    },
    (e) => {
      if (e instanceof UsageError) {
        stdio.err(`오류: ${e.message}`);
        process.exitCode = 1;
      } else {
        stdio.err(`오류: 예기치 못한 오류(${(e && e.message) || e})`);
        process.exitCode = 2;
      }
    },
  );
}
