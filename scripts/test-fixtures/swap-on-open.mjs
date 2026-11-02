// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 fs.openSync 가 env SWAP_ON_OPEN 과 같은 경로를 처음
// 열기 직전에 env SWAP_FROM 의 파일을 그 자리로 rename 한다. 확인(lstat)과 열기 사이에 다른 프로그램이 파일을
// 바꿔 놓은 경우를 재현해, 연 파일이 확인한 파일과 같은지 가리는 코드를 본다. same-ino.mjs 와 함께 쓰면 Number ino 로
// 가리는 코드는 바뀐 것을 놓친다. scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const target = process.env.SWAP_ON_OPEN;
const from = process.env.SWAP_FROM;
const { openSync, renameSync } = fs;
let done = false;

fs.openSync = function openAfterSwap(p, ...rest) {
  if (!done && target && from && p === target) {
    done = true;
    renameSync(from, target);
  }
  return openSync.call(this, p, ...rest);
};
syncBuiltinESMExports();
