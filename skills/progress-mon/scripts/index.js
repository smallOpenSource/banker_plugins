// `node --test <이 폴더>/` 진입. Node 24 는 폴더 인자를 모듈 경로로 풀어 이 index.js 를 찾는다.
// 그래서 이 파일이 폴더의 *.test.mjs 를 모두 적재한다(CommonJS, Node 18 도 같음).
// 적재에 실패한 파일은 실패하는 `load <파일>` 시험으로 남기고 다음 파일을 계속 적재한다.
// 마지막 시험 `all <n> test files loaded` 는 모든 파일이 오류 없이 적재될 때만 통과한다.
// 적재 중 process.exit 를 부르는 파일이 있으면 이 시험이 TAP 에 나오지 않아 판정에서 걸린다.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

(async () => {
  const files = fs.readdirSync(__dirname).filter((n) => /\.test\.mjs$/.test(n)).sort();
  let attempted = 0;
  const failed = [];
  for (const f of files) {
    attempted++;
    try {
      await import(pathToFileURL(path.join(__dirname, f)).href);
    } catch (e) {
      failed.push(f);
      test(`load ${f}`, { timeout: 60000 }, () => {
        throw e;
      });
    }
  }
  test(`all ${files.length} test files loaded`, { timeout: 60000 }, () => {
    if (attempted !== files.length || failed.length) {
      throw new Error(`attempted ${attempted}/${files.length}, load failures ${failed.length}: ${failed.join(', ')}`);
    }
  });
})();
