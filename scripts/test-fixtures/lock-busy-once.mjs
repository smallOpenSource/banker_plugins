// 시험 도구: `node --import <이 파일의 file URL> <init-dir 틀 service.mjs> start` 로 쓰면 Windows 에서 지우는 중인
// 잠금 파일이 내는 답(EPERM, EBUSY)을 한 번씩 흉내 낸다. 시작 잠금(`.start.lock`)과 정리 잠금(`.start.lock.break`)의
// wx 만들기와 lstat 은 처음 한 번 EPERM, 시작 잠금의 rm 은 처음 한 번 EBUSY 를 던진다. 그 밖은 그대로 둔다.
// env LOCK_BUSY_MARK 가 있으면 던질 때마다 그 파일에 한 줄(`open lock`, `lstat break` 등)을 더한다.
// scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const { openSync, lstatSync, rmSync, appendFileSync } = fs;
const mark = process.env.LOCK_BUSY_MARK;
const done = new Set();
const kind = (p) => (typeof p !== 'string' ? null : p.endsWith('.start.lock.break') ? 'break' : p.endsWith('.start.lock') ? 'lock' : null);
const once = (op, p, code) => {
  const k = kind(p);
  if (!k || done.has(`${op} ${k}`)) return;
  done.add(`${op} ${k}`);
  if (mark) appendFileSync(mark, `${op} ${k}\n`);
  throw Object.assign(new Error(`${code}: operation not permitted, ${op} '${p}' (test)`), { code });
};

fs.openSync = function openBusy(p, flags, ...rest) {
  if (flags === 'wx') once('open', p, 'EPERM');
  return openSync.call(this, p, flags, ...rest);
};
fs.lstatSync = function lstatBusy(p, ...rest) {
  once('lstat', p, 'EPERM');
  return lstatSync.call(this, p, ...rest);
};
fs.rmSync = function rmBusy(p, ...rest) {
  if (kind(p) === 'lock') once('rm', p, 'EBUSY');
  return rmSync.call(this, p, ...rest);
};
syncBuiltinESMExports();
