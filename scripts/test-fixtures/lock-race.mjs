// 시험 도구: `node --import <이 파일의 file URL> <init-dir 틀 service.mjs> start` 로 쓰면 낡은 시작 잠금을 정리하는 순간에
// 다른 start 가 끼어든 순서를 그대로 만든다. 낡다고 판정한 잠금 자리에 이 프로세스 pid 의 새 잠금(race "A", 다른 start 가
// 막 잡은 잠금 역할)을 써 넣는다. 끼우는 자리는 정리 잠금(`.start.lock.break`)을 wx 로 만든 직후이고, 옛 방식(잠금을
// `.stale` 로 rename 한 뒤 link 로 되돌림)이면 rename 직전이다. 옛 방식에는 link 직전에 셋째 start 의 잠금(race "C")도
// 써 넣는다. 정리하는 쪽이 판정 뒤에 생긴 잠금 A 를 지우지 않으면 끝난 뒤 잠금은 A 그대로다. scripts/ 는 package.json 의
// files 에 없어 배포에 들지 않는다.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const { openSync, renameSync, linkSync, writeFileSync } = fs;
const LOCK = '.start.lock';
const fresh = (race) => `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), race })}\n`;
let planted = false;
const plantA = (lock) => {
  if (planted) return;
  planted = true;
  writeFileSync(lock, fresh('A'));
};

fs.openSync = function openWithRace(path, flags, ...rest) {
  const fd = openSync.call(this, path, flags, ...rest);
  if (typeof path === 'string' && flags === 'wx' && path.endsWith(`${LOCK}.break`)) plantA(path.slice(0, -'.break'.length));
  return fd;
};

fs.renameSync = function renameWithRace(from, to, ...rest) {
  if (typeof from === 'string' && from.endsWith(LOCK) && String(to).endsWith('.stale')) plantA(from);
  return renameSync.call(this, from, to, ...rest);
};

fs.linkSync = function linkWithRace(from, to, ...rest) {
  if (typeof to === 'string' && to.endsWith(LOCK)) writeFileSync(to, fresh('C'));
  return linkSync.call(this, from, to, ...rest);
};
syncBuiltinESMExports();
