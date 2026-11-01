// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 fs.openSync 가 env FAIL_OPEN_AT 과 이름이 같은 파일을
// "wx"(새로 만들기)로 열 때 던진다. 그 밖의 열기는 그대로 둔다. init-dir 이 틀을 쓰다 중간에 실패할 때 임시 폴더를
// 지우는지 보는 데 쓴다. scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const target = process.env.FAIL_OPEN_AT;
const openSync = fs.openSync;

fs.openSync = function openOrFail(path, flags, ...rest) {
  if (target && flags === 'wx' && typeof path === 'string' && basename(path) === target) {
    throw Object.assign(new Error(`주입한 실패: ${path}`), { code: 'EIO' });
  }
  return openSync.call(this, path, flags, ...rest);
};
syncBuiltinESMExports();
