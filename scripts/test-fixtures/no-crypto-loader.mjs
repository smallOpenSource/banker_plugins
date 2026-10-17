// no-crypto.mjs 가 module.register 로 거는 resolve 훅과, 두 파일이 함께 쓰는 거부 규칙(시험 도구).
// 암호 모듈 없이 빌드한 Node 에는 node:crypto 와 함께 https, tls, http2 도 없다(Node 문서의 https 장). env
// NO_CRYPTO_ONLY=1 이면 node:crypto 만 거부한다. env NO_CRYPTO_MARK 가 있으면 시도마다 그 파일에 한 줄을 더한다.
import fs from 'node:fs';

const NEEDS_CRYPTO = ['crypto', 'https', 'tls', 'http2', '_tls_common', '_tls_wrap'];
const refused = process.env.NO_CRYPTO_ONLY === '1' ? ['crypto'] : NEEDS_CRYPTO;
const mark = process.env.NO_CRYPTO_MARK;

// 거부할 모듈이면 표시(`esm crypto`, `cjs https` 꼴)를 남기고 그런 Node 처럼 던진다. 아니면 아무것도 하지 않는다.
export function refuse(kind, name) {
  const bare = name.startsWith('node:') ? name.slice(5) : name;
  if (!refused.includes(bare)) return;
  if (mark) fs.appendFileSync(mark, `${kind} ${bare}\n`);
  throw Object.assign(new Error('Node.js is not compiled with OpenSSL crypto support'), { code: 'ERR_NO_CRYPTO' });
}

export async function resolve(specifier, context, next) {
  refuse('esm', specifier);
  return next(specifier, context);
}
