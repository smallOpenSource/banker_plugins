// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 프로세스 명령줄 읽기를 모두 느리게 한다. 부하가 큰
// Windows 에서 PowerShell 의 Get-CimInstance 한 번이 몇 초 걸리는 것을 흉내 낸다. `/proc/<pid>/cmdline` 의
// fs.readFileSync 와 `ps`, `powershell.exe` 의 child_process.spawnSync 는 실제로 읽기 전에 env SLOW_CMDLINE_MS
// (기본 2500)만큼 멈춘다. 그 밖의 경로와 명령은 그대로 둔다. NODE_OPTIONS 의 --import 로 넘기면 init-dir 틀의
// start.sh, start.cmd 가 띄운 service.mjs 에도 걸린다. scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const ms = Number(process.env.SLOW_CMDLINE_MS) || 2500;
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const { readFileSync } = fs;
const { spawnSync } = childProcess;
const READERS = new Set(['ps', 'powershell']);

fs.readFileSync = function slowProc(path, ...rest) {
  if (typeof path === 'string' && /^\/proc\/\d+\/cmdline$/.test(path)) pause();
  return readFileSync.call(this, path, ...rest);
};
childProcess.spawnSync = function slowReader(command, ...rest) {
  const name = typeof command === 'string' ? command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') : '';
  if (READERS.has(name)) pause();
  return spawnSync.call(this, command, ...rest);
};
syncBuiltinESMExports();
