// 시험 도구: `node --import <이 파일의 file URL> <대상>` 으로 쓰면 암호 모듈 없이 빌드한 Node 를 흉내 낸다. 그런 Node 처럼
// node:crypto 와 그것이 있어야 하는 https, tls, http2 를 불러오지 못하게 한다(규칙은 no-crypto-loader.mjs). 그래서
// https 를 가져오는 update-fetch, update-checkin 은 이 흉내에서 시작하지 못한다. env NO_CRYPTO_ONLY=1 이면
// node:crypto 만 막아, 그 둘이 crypto 를 따로 가져오지 않는지만 본다. ESM 가져오기는 resolve 훅이, CJS require 는
// Module._load 감쌈이 거부한다. scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import Module, { register } from 'node:module';
import { refuse } from './no-crypto-loader.mjs';

const load = Module._load;

Module._load = function loadWithoutCrypto(request, ...rest) {
  if (typeof request === 'string') refuse('cjs', request);
  return load.call(this, request, ...rest);
};

register(new URL('./no-crypto-loader.mjs', import.meta.url));
