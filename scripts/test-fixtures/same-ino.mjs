// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 Number 로 받는 fs.statSync, lstatSync, fstatSync 의
// ino 를 모두 같은 값(42)으로 바꾼다. bigint 로 받는 stat 은 그대로 둔다. Windows NTFS 의 파일 ID 는 2^53 을 넘어
// Number 로 바꾸면 아래 자리가 잘리고, 연달아 만든 두 파일이 같은 ino 가 될 수 있다. 그 충돌을 Linux, macOS 에서
// 재현해, 파일을 가르는 코드가 bigint ino 를 쓰는지 본다. scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lossy = (real) =>
  function statWithSameIno(target, options, ...rest) {
    const st = real.call(this, target, options, ...rest);
    if (st && !(options && options.bigint)) st.ino = 42;
    return st;
  };
fs.statSync = lossy(fs.statSync);
fs.lstatSync = lossy(fs.lstatSync);
fs.fstatSync = lossy(fs.fstatSync);
syncBuiltinESMExports();
