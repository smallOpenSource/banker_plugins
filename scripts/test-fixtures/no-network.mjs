// 시험 도구: `node --import <이 파일의 file URL> ...` 로 먼저 부르면 http, https 의 request 와 get, net.connect 와
// net.createConnection, tls.connect, dns.lookup, globalThis.fetch 가 연결하지 않고 던진다. env NO_NETWORK_MARK 가 있으면
// 시도마다 그 파일에 한 줄(`http.request` 꼴)을 더한다. 훅 사본을 불러오기만 해서는 네트워크에 닿지 않는지 보는 데 쓴다.
// scripts/ 는 package.json 의 files 에 없어 배포에 들지 않는다.
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const mark = process.env.NO_NETWORK_MARK;
const refuse = (what) => () => {
  if (mark) fs.appendFileSync(mark, `${what}\n`);
  throw Object.assign(new Error(`network refused by the test: ${what}`), { code: 'ERR_TEST_NO_NETWORK' });
};
for (const [mod, name] of [[http, 'http'], [https, 'https']]) {
  mod.request = refuse(`${name}.request`);
  mod.get = refuse(`${name}.get`);
}
net.connect = refuse('net.connect');
net.createConnection = refuse('net.createConnection');
tls.connect = refuse('tls.connect');
dns.lookup = refuse('dns.lookup');
globalThis.fetch = refuse('fetch');
syncBuiltinESMExports();
