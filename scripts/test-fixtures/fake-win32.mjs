// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 POSIX 에서 대상 스크립트의 Windows 분기를 돌린다.
// process.platform 은 'win32' 로 보이고, child_process 의 실제 실행 동안만 진짜 값으로 돌아간다(Node 가 셸과 인자를
// 진짜 OS 에 맞게 고르게). spawnSync, spawn 에 넘긴 실행 파일 이름은 그대로 env FAKE_WIN32_MARK 파일에 한 줄씩 적는다.
// 이름의 끝이 taskkill(.exe) 이면 실행하지 않고 /PID 의 프로세스에 신호를 보낸 뒤 종료 0 을 돌려주고(/F 는 SIGKILL,
// 아니면 SIGTERM), powershell(.exe) 이면 실행하지 않고 -Filter "ProcessId=<n>" 의 /proc/<n>/cmdline 을 출력으로,
// ParentProcessId 는 빈 출력으로 돌려준다. 그 밖의 이름은 진짜로 실행한다(fc-match 를 불렀는지도 적힘).
// scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const REAL = process.platform;
let real = false;
Object.defineProperty(process, 'platform', { get: () => (real ? REAL : 'win32'), configurable: true });

const mark = process.env.FAKE_WIN32_MARK;
const leaf = (cmd) => String(cmd).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
const done = (stdout) => ({ pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null });

function taskkill(args) {
  const i = args.findIndex((a) => /^\/pid$/i.test(a));
  const pid = Number(args[i + 1]);
  try {
    process.kill(pid, args.some((a) => /^\/f$/i.test(a)) ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // gone already
  }
  return done('');
}

function powershell(args) {
  const m = /\bProcessId=(\d+)/.exec(args.join(' '));
  if (!m || /ParentProcessId=/.test(args.join(' '))) return done('');
  try {
    return done(`${fs.readFileSync(`/proc/${m[1]}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()}\n`);
  } catch {
    return done('');
  }
}

const asReal = (fn) =>
  function realPlatform(...a) {
    real = true;
    try {
      return fn.apply(this, a);
    } finally {
      real = false;
    }
  };
const { spawnSync, spawn } = childProcess;
const runSync = asReal(spawnSync);
childProcess.spawnSync = function fakeSpawnSync(cmd, args = [], ...rest) {
  if (mark) fs.appendFileSync(mark, `${cmd}\n`);
  const list = Array.isArray(args) ? args : [];
  if (leaf(cmd) === 'taskkill') return taskkill(list);
  if (leaf(cmd) === 'powershell') return powershell(list);
  return runSync.call(this, cmd, args, ...rest);
};
const runAsync = asReal(spawn);
childProcess.spawn = function fakeSpawn(cmd, ...rest) {
  if (mark) fs.appendFileSync(mark, `${cmd}\n`);
  return runAsync.call(this, cmd, ...rest);
};
syncBuiltinESMExports();
