// pm-adr.mjs: ADR 탭의 검사. adr.json 두 층 스키마 검사, 참조 검증과 gap 정리, docs/adr 갈라짐 경고, 밀도, 집계, check 대조 기록.
// 화면 렌더는 pm-adr-view.mjs.
// 두 층: project(검증, 흐름, 증거)는 프로젝트에 하나, decisions[](최적화 로직, 확장 대응, 포기와 얻은 것)는 결정마다.
// 서버 화면은 참조를 글로만 보이고 파일을 읽거나 링크하지 않는다. 참조 파일은 check 에서만 크기 상한 안의 일반 파일로 읽는다.
// 스키마 위반은 FAIL, 근거가 없어 비운 항목({ gap: 사유 })은 밀도 WARN, 확인 못 한 참조는 FAIL 이나 WARN(references/adr.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, noBom, readRegular, writeAtomic, writeNew } from './pm-config.mjs';

const ADR_FILE = 'adr.json';
const ADR_CHECK_FILE = 'adr-check.json';
const REF_READ_MAX = 4 * 1024 * 1024;
export const STATUS = { accepted: '채택', proposed: '제안', superseded: '대체됨' };
const REF_KINDS = ['file', 'test', 'commit', 'cmd'];
const HASH = /^[0-9a-f]{4,40}$/i;
export const DECISION_SLOTS = [
  ['optimization', '최적화 로직'],
  ['scaling', '확장 대응'],
  ['tradeoffs', '포기와 얻은 것'],
];

export const arr = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
export const str = (v) => typeof v === 'string' && v.trim().length > 0;
export const isGap = (v) => Boolean(obj(v)) && Object.hasOwn(v, 'gap');
// json 경로 조각(['decisions', 0, 'scaling']) 을 글(decisions[0].scaling)로.
const jp = (parts) => parts.reduce((a, k) => (typeof k === 'number' ? `${a}[${k}]` : a ? `${a}.${k}` : k), '') || '$';

// ---------- 스키마 ----------

// 칸 꼴: 빈 문자열이 아닌 글, 글(빈 값 허용), 배열, 객체.
const KIND = {
  str: [str, '빈 문자열이 아닌 문자열이 아님'],
  text: [(v) => typeof v === 'string', '문자열이 아님'],
  arr: [Array.isArray, '배열이 아님'],
  obj: [(v) => Boolean(obj(v)), '객체가 아님'],
};

// 검사 결과 모음. schema: 스키마 위반, claim: 증거 없는 주장(구현됨, 검증됨), refFail, refWarn: 참조 확인 결과,
// refs: 확인할 참조, modRefs: 모듈 id 참조, claims: 참조 확인 뒤 판정할 주장(검증한 모듈, 구현된 기능).
// schema 와 claim 은 둘 다 FAIL 이지만 정리 단계는 schema 만 파일을 옮긴다.
function state() {
  const S = { schema: [], claim: [], claims: [], refFail: [], refWarn: [], refs: [], modRefs: [], ids: new Set() };
  S.bad = (parts, msg) => S.schema.push({ p: jp(parts), msg });
  S.unproven = (parts, msg) => S.claim.push({ p: jp(parts), msg });
  return S;
}

// 주장에는 증거: 증거 칸에서 실제로 확인된 참조(꼴이 맞고 참조 확인에서 FAIL 도 WARN 도 없음)가 0개면 증거 없음.
// 확인 못 한 참조(출력 파일 없는 명령, 파일에 없는 시험 이름, git 이 꺼진 커밋)는 증거로 세지 않는다.
const MODULE_WAY = '증거를 지어내지 말고 그 모듈을 미검증으로 옮김: status "unverified" 와 why(사유)';
const FEATURE_WAY = '증거를 지어내지 말고 그 기능을 구현 못 함 목록으로 옮김: notImplemented 에 feature 와 why(사유)';

// o[key] 의 꼴 검사. 돌려줌: 맞으면 참. optional 이면 없어도 참.
function want(S, o, key, parts, kind, optional = false) {
  const v = o[key];
  if (v === undefined) {
    if (!optional) S.bad([...parts, key], '칸 없음');
    return optional;
  }
  const [ok, msg] = KIND[kind];
  if (!ok(v)) S.bad([...parts, key], msg);
  return ok(v);
}

const fields = (S, o, parts, list) => list.forEach(([k, kind, optional]) => want(S, o, k, parts, kind, optional));

function gapOk(S, v, parts) {
  if (str(v.gap)) return true;
  S.bad([...parts, 'gap'], 'gap 에 사유 없음');
  return false;
}

// 여섯 항목 칸 하나. 내용 꼴이나 { gap: 사유 }. 칸이 없거나 꼴이 틀리면 FAIL.
function slot(S, holder, key, parts, body) {
  const v = holder[key];
  const p = [...parts, key];
  if (v === undefined) return S.bad(p, '칸 없음');
  if (isGap(v)) return gapOk(S, v, p);
  if (body.kind === 'arr' ? !Array.isArray(v) : !obj(v)) return S.bad(p, body.kind === 'arr' ? '배열이거나 { gap: 사유 } 가 아님' : '객체이거나 { gap: 사유 } 가 아님');
  body.check(v, p);
}

const REF_FIELDS = {
  file: [['path', 'str'], ['line', 'line', true]],
  test: [['path', 'str'], ['name', 'str']],
  commit: [['hash', 'hash']],
  cmd: [['cmd', 'str'], ['output', 'str', true]],
};
const REF_KIND_CHECK = {
  ...KIND,
  line: [(v) => Number.isInteger(v) && v >= 1, '1 이상 정수가 아님'],
  hash: [(v) => typeof v === 'string' && HASH.test(v), '4~40자 16진 해시가 아님'],
};

// 참조 칸 하나의 꼴. 돌려줌: 맞으면 참(선택 칸이 없어도 참).
function refField(S, x, parts, [k, kind, optional]) {
  const v = x[k];
  if (v === undefined && optional) return true;
  const [test, msg] = REF_KIND_CHECK[kind];
  if (test(v)) return true;
  S.bad([...parts, k], v === undefined ? '칸 없음' : msg);
  return false;
}

// 참조 하나. 꼴이 맞으면 확인할 목록(S.refs)에 넣는다.
function ref(S, x, parts) {
  if (isGap(x)) return gapOk(S, x, parts);
  if (!obj(x)) return S.bad(parts, '참조가 객체가 아님');
  if (!REF_KINDS.includes(x.kind)) return S.bad([...parts, 'kind'], `${REF_KINDS.join(', ')} 가운데 하나가 아님: ${x.kind}`);
  const ok = REF_FIELDS[x.kind].map((f) => refField(S, x, parts, f)).every(Boolean);
  if (x.note !== undefined && typeof x.note !== 'string') S.bad([...parts, 'note'], '문자열이 아님');
  if (ok) S.refs.push({ ref: x, parts });
}

function refList(S, o, key, parts, optional = false) {
  if (!want(S, o, key, parts, 'arr', optional) || o[key] === undefined) return;
  o[key].forEach((x, i) => ref(S, x, [...parts, key, i]));
}

function modules(S, o, parts) {
  if (o.modules === undefined) return;
  if (!(Array.isArray(o.modules) && o.modules.every(str))) return S.bad([...parts, 'modules'], '문자열 배열이 아님');
  o.modules.forEach((id, i) => S.modRefs.push({ id, parts: [...parts, 'modules', i] }));
}

// 객체 배열의 원소마다 check. 객체가 아니면 FAIL.
function each(S, list, parts, check) {
  list.forEach((x, i) => (obj(x) ? check(x, [...parts, i]) : S.bad([...parts, i], '객체가 아님')));
}

// 모듈 하나. 검증한 모듈(status 없음이나 "verified")은 evidence 에 gap 아닌 참조 1개 이상, 미검증 모듈("unverified")은 why.
function moduleItem(S, x, p) {
  const unverified = x.status === 'unverified';
  if (x.status !== undefined && !['verified', 'unverified'].includes(x.status)) S.bad([...p, 'status'], `verified, unverified 가운데 하나가 아님: ${x.status}`);
  fields(S, x, p, [['id', 'str'], ['module', 'str'], ['result', 'str', unverified], ['why', 'str', !unverified]]);
  if (str(x.id) && S.ids.has(x.id)) S.bad([...p, 'id'], `모듈 id 겹침: ${x.id}`);
  if (str(x.id)) S.ids.add(x.id);
  refList(S, x, 'evidence', p, unverified);
  if (!unverified && Array.isArray(x.evidence)) S.claims.push({ parts: [...p, 'evidence'], n: x.evidence.length, msg: `증거 없음: 확인된 검증 증거가 없음(FAIL, WARN 없이 확인된 참조 0개). ${MODULE_WAY}` });
}

function verification(S, list, parts) {
  each(S, list, parts, (x, p) => moduleItem(S, x, p));
}

function flow(S, f, parts) {
  fields(S, f, parts, [['input', 'text'], ['logic', 'text'], ['output', 'text']]);
  refList(S, f, 'refs', parts, true);
}

function proof(S, v, parts) {
  if (want(S, v, 'implemented', parts, 'arr')) {
    each(S, v.implemented, [...parts, 'implemented'], (x, p) => {
      want(S, x, 'feature', p, 'str');
      modules(S, x, p);
      refList(S, x, 'proofs', p);
      if (Array.isArray(x.proofs)) S.claims.push({ parts: [...p, 'proofs'], n: x.proofs.length, msg: `증거 없음: 확인된 구현 증명이 없음(FAIL, WARN 없이 확인된 참조 0개). ${FEATURE_WAY}` });
    });
  }
  if (want(S, v, 'notImplemented', parts, 'arr')) each(S, v.notImplemented, [...parts, 'notImplemented'], (x, p) => fields(S, x, p, [['feature', 'str'], ['why', 'str']]));
}

function project(S, p) {
  const parts = ['project'];
  slot(S, p, 'verification', parts, { kind: 'arr', check: (v, q) => verification(S, v, q) });
  slot(S, p, 'flow', parts, { kind: 'obj', check: (v, q) => flow(S, v, q) });
  slot(S, p, 'proof', parts, { kind: 'obj', check: (v, q) => proof(S, v, q) });
  // 검증과 증거 칸 전체를 gap 으로 둘 수 없음(주장에는 증거). 흐름의 gap 은 밀도 WARN
  if (isGap(p.verification) && str(p.verification.gap)) S.unproven([...parts, 'verification'], `증거 없음: 검증 칸 전체를 gap 으로 둘 수 없음. 모듈을 적고 ${MODULE_WAY}`);
  if (isGap(p.proof) && str(p.proof.gap)) S.unproven([...parts, 'proof'], `증거 없음: 증거 칸 전체를 gap 으로 둘 수 없음. implemented 를 비우고 ${FEATURE_WAY}`);
}

function options(S, d, parts) {
  if (!want(S, d, 'options', parts, 'arr')) return;
  each(S, d.options, [...parts, 'options'], (x, p) => fields(S, x, p, [['name', 'str'], ['pros', 'text'], ['cons', 'text']]));
  if (d.options.length < 2 && !str(d.rejected)) S.bad([...parts, 'options'], `선택지 ${d.options.length}개. 2개 미만이면 rejected(다른 선택지를 버린 사유) 필요`);
}

function tradeoffs(S, v, parts) {
  if (want(S, v, 'gaveUp', parts, 'arr')) each(S, v.gaveUp, [...parts, 'gaveUp'], (x, p) => fields(S, x, p, [['what', 'str'], ['why', 'str']]));
  if (want(S, v, 'gained', parts, 'arr')) each(S, v.gained, [...parts, 'gained'], (x, p) => fields(S, x, p, [['what', 'str'], ['purpose', 'str']]));
}

function decision(S, d, parts, seen) {
  fields(S, d, parts, [['id', 'str'], ['title', 'str'], ['context', 'str'], ['decision', 'str'], ['why', 'str'], ['rejected', 'str', true]]);
  if (str(d.id) && seen.has(d.id)) S.bad([...parts, 'id'], `결정 id 겹침: ${d.id}`);
  seen.add(d.id);
  if (!Object.hasOwn(STATUS, d.status)) S.bad([...parts, 'status'], `${Object.keys(STATUS).join(', ')} 가운데 하나가 아님: ${d.status}`);
  if (d.date !== undefined && !(typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))) S.bad([...parts, 'date'], `YYYY-MM-DD 가 아님: ${d.date}`);
  options(S, d, parts);
  slot(S, d, 'optimization', parts, { kind: 'obj', check: (v, q) => (want(S, v, 'process', q, 'str'), modules(S, v, q), refList(S, v, 'refs', q)) });
  slot(S, d, 'scaling', parts, { kind: 'obj', check: (v, q) => (fields(S, v, q, [['argument', 'str'], ['limits', 'text', true]]), refList(S, v, 'refs', q)) });
  slot(S, d, 'tradeoffs', parts, { kind: 'obj', check: (v, q) => tradeoffs(S, v, q) });
  refList(S, d, 'sources', parts, true);
}

// 두 층 스키마 검사. 돌려줌: 검사 결과 S(schema, refs, modRefs, claims). 주장 판정은 참조 확인 뒤(examine).
export function adrSchema(v) {
  const S = state();
  const a = obj(v);
  if (!a) return S.bad([], '객체가 아님'), S;
  if (want(S, a, 'project', [], 'obj')) project(S, a.project);
  if (want(S, a, 'decisions', [], 'arr')) {
    const seen = new Set();
    each(S, a.decisions, ['decisions'], (d, p) => decision(S, d, p, seen));
  }
  for (const m of S.modRefs) if (!S.ids.has(m.id)) S.bad(m.parts, `모듈 없음: ${m.id}`);
  return S;
}

// ---------- 참조 확인 ----------

const within = (a, b) => {
  const rel = path.relative(a, b);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// 프로젝트 루트 안 상대 경로의 일반 파일. 돌려줌: { file } | { err }. 절대 경로, .., 루트 밖 링크, 없음, 폴더와 특수 파일은 err.
function localFile(root, p) {
  if (path.isAbsolute(p) || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return { err: `절대 경로: ${p}` };
  if (p.split(/[\\/]/).includes('..')) return { err: `.. 이 든 경로: ${p}` };
  let real;
  try {
    real = fs.realpathSync(path.resolve(root, p));
  } catch {
    return { err: `파일 없음: ${p}` };
  }
  if (!within(root, real)) return { err: `프로젝트 루트 밖을 가리키는 링크: ${p}` };
  if (!fs.statSync(real).isFile()) return { err: `일반 파일이 아님(폴더나 특수 파일): ${p}` };
  return { file: real };
}

// 크기 상한 안의 일반 파일 글. 넘으면 null.
function readRef(file) {
  try {
    return readRegular(file, 'utf8', fs, REF_READ_MAX);
  } catch (e) {
    if (e.code === 'EFBIG') return null;
    throw e;
  }
}

const lineCount = (t) => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);
const TOO_BIG = `크기 상한(${REF_READ_MAX / 1024 / 1024} MB)을 넘어 내용을 확인 못 함`;

function fileRef(env, x) {
  const got = localFile(env.root, x.path);
  if (got.err) return { fail: got.err };
  if (x.line === undefined) return null;
  const text = readRef(got.file);
  if (text === null) return { warn: `${TOO_BIG}: ${x.path}` };
  const n = lineCount(text);
  return x.line > n ? { fail: `줄 ${x.line} 이 줄 수 ${n} 을 넘음: ${x.path}` } : null;
}

function testRef(env, x) {
  const got = localFile(env.root, x.path);
  if (got.err) return { fail: got.err };
  const text = readRef(got.file);
  if (text === null) return { warn: `${TOO_BIG}: ${x.path}` };
  return text.includes(x.name) ? null : { warn: `시험 이름이 파일에 없음: ${x.path} 의 ${x.name}` };
}

// 커밋은 git 으로만 확인. sources.git 이 꺼졌거나 저장소가 아니면 WARN(확인 못 함).
function commitRef(env, x) {
  if (!env.gitOn) return { warn: `sources.git 이 꺼져 있어 커밋을 확인 못 함: ${x.hash}` };
  if (env.repo === undefined) {
    try {
      git(env.project, ['rev-parse', '--git-dir']);
      env.repo = true;
    } catch {
      env.repo = false;
    }
  }
  if (!env.repo) return { warn: `git 저장소가 아니거나 git 이 없어 커밋을 확인 못 함: ${x.hash}` };
  try {
    git(env.project, ['cat-file', '-e', `${x.hash}^{commit}`]);
    return null;
  } catch {
    return { fail: `커밋 없음(짧은 해시가 여럿과 겹쳐도 같음): ${x.hash}` };
  }
}

function cmdRef(env, x) {
  if (x.output === undefined) return { warn: `출력 파일이 없어 명령 결과를 확인 못 함: ${x.cmd}` };
  const got = localFile(env.root, x.output);
  return got.err ? { fail: got.err } : null;
}

const VERIFY = { file: fileRef, test: testRef, commit: commitRef, cmd: cmdRef };

// S.refs 를 실제로 확인해 S.refFail, S.refWarn 에 넣는다.
function verifyRefs(S, ctx, config) {
  const env = { project: ctx.project, root: realOr(ctx.project), gitOn: Boolean(config.sources && config.sources.git), repo: undefined };
  for (const { ref: x, parts } of S.refs) {
    const r = VERIFY[x.kind](env, x);
    if (r && r.fail) S.refFail.push({ parts, msg: r.fail });
    else if (r) S.refWarn.push({ parts, msg: r.warn });
  }
}

// 참조 확인 뒤 주장 판정. 증거 칸의 참조 가운데 확인할 목록에 들었고(꼴이 맞고 gap 아님) FAIL, WARN 이 없는 것만 센다.
function judgeClaims(S) {
  const bad = new Set([...S.refFail, ...S.refWarn].map((x) => jp(x.parts)));
  const good = new Set(S.refs.map((x) => jp(x.parts)).filter((p) => !bad.has(p)));
  S.good = good;
  for (const c of S.claims) {
    const ok = Array.from({ length: c.n }, (_, i) => jp([...c.parts, i])).some((p) => good.has(p));
    if (!ok) S.unproven(c.parts, c.msg);
  }
}

// 스키마, 참조 확인, 주장 판정을 차례로. 돌려줌: S
function examine(v, ctx, config) {
  const S = adrSchema(v);
  verifyRefs(S, ctx, config);
  judgeClaims(S);
  return S;
}

// 두 원본 갈라짐: docs/adr/*.md 가운데 어떤 결정의 sources 도 가리키지 않는 파일.
function divergence(ctx, v) {
  let names;
  try {
    names = fs.readdirSync(path.join(ctx.project, 'docs', 'adr'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const pointed = new Set(arr(v.decisions).flatMap((d) => arr(obj(d) && d.sources).filter((x) => obj(x) && typeof x.path === 'string').map((x) => norm(x.path))));
  return names.sort().filter((n) => !pointed.has(`docs/adr/${n}`)).map((n) => `docs/adr/${n} 를 가리키는 결정 없음`);
}

// adr.json 글(BOM 을 뗀 뒤)의 sha256. check 대조 기록과 화면이 같은 adr.json 을 보았는지 가린다.
export const adrSha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// adr.json 읽기. 돌려줌: { missing } | { error } | { value, sha }
function readAdr(dataDir) {
  let text;
  try {
    text = readRegular(path.join(dataDir, ADR_FILE));
  } catch (e) {
    return e.code === 'ENOENT' ? { missing: true } : { error: `읽기 실패(${e.code || 'error'})` };
  }
  const body = noBom(text);
  try {
    return { value: JSON.parse(body), sha: adrSha(body) };
  } catch (e) {
    return { error: `JSON 아님: ${e.message}` };
  }
}

// 검사 전체(check 와 정리가 같이 씀). 돌려줌: { missing } | { error } | { value, sha, S, diverge }
function inspectAdr(ctx, config) {
  const got = readAdr(ctx.dataDir);
  if (!Object.hasOwn(got, 'value')) return got;
  const S = examine(got.value, ctx, config);
  const diverge = S.schema.length ? [] : divergence(ctx, got.value);
  return { value: got.value, sha: got.sha, S, diverge };
}

// check 의 ADR 부분. r: pm-check 의 sink. 돌려줌: { value: 밀도에 쓸 값, bare: 참조 없는 서술 칸, sha: adr.json sha256 }.
// adr.json 이 없거나 깨졌으면 { value: null, bare: [], sha: null }.
const NO_ADR = () => ({ value: null, bare: [], sha: null });
export function checkAdr(ctx, config, r) {
  const got = inspectAdr(ctx, config);
  if (got.missing) return NO_ADR();
  if (got.error) return r.fail(ADR_FILE, '$', got.error), NO_ADR();
  for (const x of [...got.S.schema, ...got.S.claim]) r.fail(ADR_FILE, x.p, x.msg);
  for (const x of got.S.refFail) r.fail(ADR_FILE, jp(x.parts), `참조: ${x.msg}`);
  for (const x of got.S.refWarn) r.warn(ADR_FILE, jp(x.parts), `참조: ${x.msg}`);
  for (const msg of got.diverge) r.warn(ADR_FILE, 'sources:', msg);
  return { value: got.value, bare: bareSlots(got.value, (p) => got.S.good.has(p)), sha: got.sha };
}

// check 대조 기록(adr-check.json): check 가 확인을 마친 참조로 센 집계 글과 그때 adr.json 의 sha256.
// 화면은 파일을 읽지 않고 적힌 참조로 세므로, 이 기록과 대조해 두 수가 다르거나 check 뒤 adr.json 이 바뀌었음을 알린다.
// rec: { sha, tally }. 쓰기 실패는 UsageError(writeAtomic).
export async function writeAdrCheck(dataDir, rec, now = Date.now()) {
  const body = { sha: rec.sha, tally: rec.tally, at: new Date(now).toISOString() };
  await writeAtomic(path.join(dataDir, ADR_CHECK_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

// json 경로 조각 자리에 값을 넣는다.
function setAt(root, parts, value) {
  const holder = parts.slice(0, -1).reduce((o, k) => o[k], root);
  holder[parts[parts.length - 1]] = value;
}

const two = (n) => String(n).padStart(2, '0');
// 현지 시각 YYYYMMDD-HHMMSS.
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

// 스키마 FAIL 이 남은 adr.json 을 같은 폴더의 adr.json.rejected-<시각>(있으면 -2, -3 ...)으로 옮긴다. 결정 기록을 잃지 않게
// 지우지 않는다. 새 이름은 writeNew 로 만들어 있는 것(끊어진 링크 포함)을 덮거나 따라가지 않고, 사본을 만든 뒤에만 원본을
// 지운다. 돌려줌: 옮긴 경로.
function reject(file, now) {
  const base = `${file}.rejected-${stamp(now)}`;
  const bytes = fs.readFileSync(file);
  const mode = fs.statSync(file).mode & 0o777; // as COPYFILE_EXCL kept it
  for (let i = 1; ; i++) {
    const dest = i === 1 ? base : `${base}-${i}`;
    try {
      writeNew(dest, bytes, { mode });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    fs.rmSync(file, { force: true });
    return dest;
  }
}

// init 정리 단계(결정 I). 스키마 위반이 남으면 adr.json 을 adr.json.rejected-<시각> 으로 옮겨 자료 없음으로, 참조 FAIL 만
// 있으면 그 참조를 { gap: "참조 확인 실패: ..." } 로 바꿔 파일을 남긴다. 돌려줌: 출력 줄 목록.
export async function cleanAdr(ctx, config, now = Date.now()) {
  const file = path.join(ctx.dataDir, ADR_FILE);
  const got = inspectAdr(ctx, config);
  if (got.missing) return ['정리: adr.json 없음'];
  const schema = got.error ? 1 : got.S.schema.length;
  if (schema) return [`정리: adr.json 을 ${reject(file, now)} 로 옮김(스키마 FAIL ${schema}건이 남아 자료 없음으로 둠)`];
  const fails = got.S.refFail;
  if (!fails.length) return ['정리: adr.json 참조 FAIL 0, 바꾼 것 없음'];
  for (const f of fails) setAt(got.value, f.parts, { gap: `참조 확인 실패: ${f.msg}` });
  await writeAtomic(file, JSON.stringify(got.value, null, 2) + '\n');
  const out = [`정리: adr.json 참조 FAIL ${fails.length}건을 gap 으로 바꿈: ${fails.map((f) => jp(f.parts)).join(', ')}`];
  // 바꾼 뒤 증거가 모두 gap 이 된 주장은 자동으로 옮기지 않는다(check 가 FAIL 로 보고, 에이전트가 판단해 옮김)
  const left = examine(got.value, ctx, config).claim;
  if (left.length) out.push(`정리: 증거가 남지 않은 주장 ${left.length}건(자동으로 옮기지 않음, check 의 FAIL 참고): ${left.map((x) => x.p).join(', ')}`);
  return out;
}

// ---------- 밀도 ----------

const content = (v) => (isGap(v) ? null : v);

// 여섯 항목 칸 가운데 비었거나(gap, 없음) 채운 칸.
function slotsOf(p, ds) {
  const list = [
    ['project.verification', p.verification],
    ['project.flow', p.flow],
    ['project.proof', p.proof],
  ];
  ds.forEach((d, i) => DECISION_SLOTS.forEach(([k]) => list.push([`decisions[${i}].${k}`, d[k]])));
  return list;
}

// 서술 칸: 결정의 최적화 로직(검증한 과정)과 확장 대응. gap 이 아닌 객체만(gap 은 근거 없음 칸으로 센다). 돌려줌: [이름, 칸]
const NARRATIVE = ['optimization', 'scaling'];
function narrativeSlots(v) {
  return arr(obj(v) && v.decisions).flatMap((d, i) => (obj(d) ? NARRATIVE.filter((k) => obj(d[k]) && !isGap(d[k])).map((k) => [`decisions[${i}].${k}`, d[k]]) : []));
}

// 참조 없는 서술: 서술 칸 가운데 refs 에 확인된 참조가 0개인 칸 이름. 규칙은 WARN 이지만 배지와 check 마지막 줄에 늘 센다.
// good(json 경로 글): 확인된 참조인가. check 는 참조 확인을 마친 집합(FAIL, WARN 없음). 화면은 파일을 읽지 않으므로
// 기본값은 꼴이 맞고 gap 이 아닌 참조(적힌 참조)다.
export function bareSlots(v, good) {
  const written = good ? null : new Set(adrSchema(v).refs.map((x) => jp(x.parts)));
  const ok = good || ((p) => written.has(p));
  return narrativeSlots(v)
    .filter(([n, x]) => !arr(x.refs).some((_, j) => ok(`${n}.refs[${j}]`)))
    .map(([n]) => n);
}

// 돌려줌: density 줄 [{tab: 'adr', item, value, min, miss}]. v 가 없으면(파일 없음, 깨짐) 모두 0.
// 증거 없는 모듈과 기능은 밀도가 아니라 FAIL(adrSchema 의 claim)이라 여기서 세지 않는다. bare: 참조 없는 서술 칸(없으면 적힌 참조로 잼).
export function adrRows(v, bare = bareSlots(v)) {
  const rows = [];
  const add = (item, value, min, miss = []) => rows.push({ tab: 'adr', item, value, min, miss });
  const a = obj(v) || {};
  const p = obj(a.project) || {};
  const ds = arr(a.decisions).filter(obj);
  const slots = slotsOf(p, ds);
  const empty = slots.filter(([, x]) => x === undefined || isGap(x)).map(([n]) => n);
  add('빈 항목', slots.length - empty.length, slots.length, empty);
  const ver = arr(content(p.verification)).filter(obj);
  add('검증', ver.length, 1);
  const f = obj(content(p.flow)) || {};
  const fmiss = [['input', '입력'], ['logic', '처리'], ['output', '출력']].filter(([k]) => !str(f[k])).map(([, n]) => n);
  add('흐름', 3 - fmiss.length, 3, fmiss);
  const impl = arr(obj(content(p.proof)) && p.proof.implemented).filter(obj);
  add('증거', impl.length, 1);
  add('결정', ds.length, 1);
  const tmiss = ds.filter((d) => !(obj(content(d.tradeoffs)) && arr(d.tradeoffs.gaveUp).length && arr(d.tradeoffs.gained).length)).map((d) => d.id);
  add('포기얻음', ds.length - tmiss.length, ds.length, tmiss);
  const narr = narrativeSlots(a).length;
  add('서술참조', narr - bare.length, narr, bare);
  return rows;
}

// adr.json 안의 { gap } 수(여섯 항목 칸과 참조 자리).
function gapCount(v) {
  if (Array.isArray(v)) return v.reduce((a, x) => a + gapCount(x), 0);
  if (!obj(v)) return 0;
  return isGap(v) ? 1 : Object.values(v).reduce((a, x) => a + gapCount(x), 0);
}

// 화면 배지와 check 끝 요약: 근거 없음(gap) 칸, 미검증 모듈, 구현 못 한 기능, 참조 없는 서술 칸 수. 모두 미검증이거나
// 서술 칸에 참조가 없어도 0칸만 보이는 오해를 막는다. bare: 참조 없는 서술 칸(없으면 적힌 참조로 잼).
export function adrTally(v, bare = bareSlots(v)) {
  const p = obj(obj(v) && v.project) || {};
  const unverified = arr(p.verification).filter((x) => obj(x) && x.status === 'unverified').length;
  const notImplemented = arr(obj(p.proof) && p.proof.notImplemented).filter(obj).length;
  const gaps = gapCount(v);
  return { text: `근거 없음 ${gaps}칸, 미검증 ${unverified}, 구현 못 함 ${notImplemented}, 참조 없는 서술 ${bare.length}`, any: gaps + unverified + notImplemented + bare.length > 0 };
}
