// no-crypto.mjs 가 module.register 로 거는 resolve 훅(시험 도구). ESM 의 node:crypto 가져오기를 거부하고,
// env NO_CRYPTO_MARK 가 있으면 그 파일에 esm 한 줄을 더한다.
import fs from 'node:fs';

const mark = process.env.NO_CRYPTO_MARK;

export async function resolve(specifier, context, next) {
  if (specifier === 'node:crypto' || specifier === 'crypto') {
    if (mark) fs.appendFileSync(mark, 'esm\n');
    throw Object.assign(new Error('Node.js is not compiled with OpenSSL crypto support'), { code: 'ERR_NO_CRYPTO' });
  }
  return next(specifier, context);
}
