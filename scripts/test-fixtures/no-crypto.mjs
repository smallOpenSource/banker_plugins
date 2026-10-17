// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 node:crypto 를 불러오지 못하는 Node(crypto 없이
// 빌드한 Node)를 흉내 낸다. ESM 가져오기는 no-crypto-loader.mjs 의 resolve 훅이, CJS require 는 Module._load 감쌈이
// 거부한다. env NO_CRYPTO_MARK 가 있으면 시도마다 그 파일에 esm 이나 cjs 한 줄을 더한다(부르지 않았는지 보는 시험용).
// scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import fs from 'node:fs';
import Module, { register } from 'node:module';

const mark = process.env.NO_CRYPTO_MARK;
const load = Module._load;

Module._load = function loadWithoutCrypto(request, ...rest) {
  if (request === 'crypto' || request === 'node:crypto') {
    if (mark) fs.appendFileSync(mark, 'cjs\n');
    throw Object.assign(new Error('Node.js is not compiled with OpenSSL crypto support'), { code: 'ERR_NO_CRYPTO' });
  }
  return load.call(this, request, ...rest);
};

register(new URL('./no-crypto-loader.mjs', import.meta.url));
