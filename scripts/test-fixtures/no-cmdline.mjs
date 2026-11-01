// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 프로세스 명령줄을 읽는 길을 모두 막는다.
// fs.readFileSync 는 `/proc/<pid>/cmdline` 에만 EACCES 를 던지고, child_process.spawnSync 는 `ps` 와 `powershell.exe`
// 에만 실행 파일이 없을 때(ENOENT)의 결과를 돌려준다. 그 밖의 경로와 명령은 그대로 둔다. env NO_CMDLINE_MARK 가
// 있으면 막을 때마다 그 파일에 한 줄(`proc`, `ps`, `powershell.exe`)을 더한다. init-dir 틀 service.mjs 가 /proc 도
// ps 도 없는 시스템에서 "확인 불가" 로 끝나는지 보는 데 쓴다. scripts/ 는 package.json 의 files 에 없어 배포에 들지
// 않는다.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const mark = process.env.NO_CMDLINE_MARK;
const note = (what) => {
  if (mark) fs.appendFileSync(mark, `${what}\n`);
};
const readFileSync = fs.readFileSync;
const spawnSync = childProcess.spawnSync;
const BLOCKED = new Set(['ps', 'powershell.exe']);

fs.readFileSync = function readWithoutProc(path, ...rest) {
  if (typeof path === 'string' && /^\/proc\/\d+\/cmdline$/.test(path)) {
    note('proc');
    throw Object.assign(new Error(`EACCES: permission denied, open '${path}' (test)`), { code: 'EACCES' });
  }
  return readFileSync.call(this, path, ...rest);
};

childProcess.spawnSync = function spawnWithoutPs(command, ...rest) {
  const name = typeof command === 'string' ? basename(command).toLowerCase() : '';
  if (!BLOCKED.has(name)) return spawnSync.call(this, command, ...rest);
  note(name);
  const error = Object.assign(new Error(`spawnSync ${command} ENOENT (test)`), { code: 'ENOENT' });
  return { pid: 0, output: null, stdout: '', stderr: '', status: null, signal: null, error };
};
syncBuiltinESMExports();
