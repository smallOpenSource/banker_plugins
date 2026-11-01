// pm-adr.mjs: ADR 탭. adr.json 두 층 스키마 검사, 참조 검증과 gap 정리, docs/adr 갈라짐 경고, 밀도, 렌더.
// 두 층: project(검증, 흐름, 증거)는 프로젝트에 하나, decisions[](최적화 로직, 확장 대응, 포기와 얻은 것)는 결정마다.
// 서버 화면은 참조를 글로만 보이고 파일을 읽거나 링크하지 않는다. 참조 파일은 check 에서만 크기 상한 안의 일반 파일로 읽는다.
// 스키마 위반은 FAIL, 근거가 없어 비운 항목({ gap: 사유 })은 밀도 WARN, 확인 못 한 참조는 FAIL 이나 WARN(references/adr.md).
import fs from 'node:fs';
import path from 'node:path';
import { git, noBom, readRegular, writeAtomic } from './pm-config.mjs';
import { esc } from './pm-html.mjs';

const ADR_FILE = 'adr.json';
const REF_READ_MAX = 4 * 1024 * 1024;
const STATUS = { accepted: '채택', proposed: '제안', superseded: '대체됨' };
const REF_KINDS = ['file', 'test', 'commit', 'cmd'];
const HASH = /^[0-9a-f]{4,40}$/i;
const DECISION_SLOTS = [
  ['optimization', '최적화 로직'],
  ['scaling', '확장 대응'],
  ['tradeoffs', '포기와 얻은 것'],
];

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v) => typeof v === 'string' && v.trim().length > 0;
const isGap = (v) => Boolean(obj(v)) && Object.hasOwn(v, 'gap');
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

// 검사 결과 모음. schema: 스키마 위반, refFail, refWarn: 참조 확인 결과, refs: 확인할 참조, modRefs: 모듈 id 참조.
function state() {
  const S = { schema: [], refFail: [], refWarn: [], refs: [], modRefs: [], ids: new Set() };
  S.bad = (parts, msg) => S.schema.push({ p: jp(parts), msg });
  return S;
}

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

function verification(S, list, parts) {
  each(S, list, parts, (x, p) => {
    fields(S, x, p, [['id', 'str'], ['module', 'str'], ['result', 'str']]);
    if (str(x.id) && S.ids.has(x.id)) S.bad([...p, 'id'], `모듈 id 겹침: ${x.id}`);
    if (str(x.id)) S.ids.add(x.id);
    refList(S, x, 'evidence', p);
  });
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
    });
  }
  if (want(S, v, 'notImplemented', parts, 'arr')) each(S, v.notImplemented, [...parts, 'notImplemented'], (x, p) => fields(S, x, p, [['feature', 'str'], ['why', 'str']]));
}

function project(S, p) {
  const parts = ['project'];
  slot(S, p, 'verification', parts, { kind: 'arr', check: (v, q) => verification(S, v, q) });
  slot(S, p, 'flow', parts, { kind: 'obj', check: (v, q) => flow(S, v, q) });
  slot(S, p, 'proof', parts, { kind: 'obj', check: (v, q) => proof(S, v, q) });
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

// 두 층 스키마 검사. 돌려줌: 검사 결과 S(schema, refs, modRefs).
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

// adr.json 읽기. 돌려줌: { missing } | { error } | { value }
function readAdr(dataDir) {
  let text;
  try {
    text = readRegular(path.join(dataDir, ADR_FILE));
  } catch (e) {
    return e.code === 'ENOENT' ? { missing: true } : { error: `읽기 실패(${e.code || 'error'})` };
  }
  try {
    return { value: JSON.parse(noBom(text)) };
  } catch (e) {
    return { error: `JSON 아님: ${e.message}` };
  }
}

// 검사 전체(check 와 정리가 같이 씀). 돌려줌: { missing } | { error } | { value, S, diverge }
function inspectAdr(ctx, config) {
  const got = readAdr(ctx.dataDir);
  if (!Object.hasOwn(got, 'value')) return got;
  const S = adrSchema(got.value);
  verifyRefs(S, ctx, config);
  const diverge = S.schema.length ? [] : divergence(ctx, got.value);
  return { value: got.value, S, diverge };
}

// check 의 ADR 부분. r: pm-check 의 sink. 돌려줌: 밀도에 쓸 값(없거나 깨졌으면 null).
export function checkAdr(ctx, config, r) {
  const got = inspectAdr(ctx, config);
  if (got.missing) return null;
  if (got.error) return r.fail(ADR_FILE, '$', got.error), null;
  for (const x of got.S.schema) r.fail(ADR_FILE, x.p, x.msg);
  for (const x of got.S.refFail) r.fail(ADR_FILE, jp(x.parts), `참조: ${x.msg}`);
  for (const x of got.S.refWarn) r.warn(ADR_FILE, jp(x.parts), `참조: ${x.msg}`);
  for (const msg of got.diverge) r.warn(ADR_FILE, 'sources:', msg);
  return got.value;
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
// 지우지 않는다. 새 이름은 COPYFILE_EXCL 로 만들어 있는 파일을 덮지 않고, 사본을 만든 뒤에만 원본을 지운다. 돌려줌: 옮긴 경로.
function reject(file, now) {
  const base = `${file}.rejected-${stamp(now)}`;
  for (let i = 1; ; i++) {
    const dest = i === 1 ? base : `${base}-${i}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
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
  return [`정리: adr.json 참조 FAIL ${fails.length}건을 gap 으로 바꿈: ${fails.map((f) => jp(f.parts)).join(', ')}`];
}

// ---------- 밀도 ----------

const realRefs = (list) => arr(list).filter((x) => obj(x) && !isGap(x)).length;
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

// 돌려줌: density 줄 [{tab: 'adr', item, value, min, miss}]. v 가 없으면(파일 없음, 깨짐) 모두 0.
export function adrRows(v) {
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
  const refd = [...ver.map((x, i) => [`project.verification[${i}](${x.id})`, x.evidence]), ...impl.map((x, i) => [`project.proof.implemented[${i}]`, x.proofs])];
  const rmiss = refd.filter(([, l]) => !realRefs(l)).map(([n]) => n);
  add('참조', refd.length - rmiss.length, refd.length, rmiss);
  add('결정', ds.length, 1);
  const tmiss = ds.filter((d) => !(obj(content(d.tradeoffs)) && arr(d.tradeoffs.gaveUp).length && arr(d.tradeoffs.gained).length)).map((d) => d.id);
  add('포기얻음', ds.length - tmiss.length, ds.length, tmiss);
  return rows;
}

// ---------- 렌더 ----------

const gapHtml = (v) => `<span class="b miss">근거 없음: ${esc(v.gap)}</span>`;

// 참조 한 줄 글. 파일을 읽거나 링크하지 않는다.
export function refText(x) {
  if (!obj(x)) return '';
  if (isGap(x)) return gapHtml(x);
  const note = typeof x.note === 'string' && x.note ? ` <small>${esc(x.note)}</small>` : '';
  const line = Number.isInteger(x.line) ? `:${x.line}` : '';
  const out = {
    file: () => `파일 <code>${esc(x.path)}${line}</code>`,
    test: () => `시험 <code>${esc(x.path)}</code> 의 ${esc(x.name)}`,
    commit: () => `커밋 <code>${esc(String(x.hash || '').slice(0, 7))}</code>`,
    cmd: () => `명령 <code>${esc(x.cmd)}</code>, 출력 ${x.output ? `<code>${esc(x.output)}</code>` : '없음'}`,
  }[x.kind];
  return out ? out() + note : esc(JSON.stringify(x)) + note;
}

const refsHtml = (list) => arr(list).map(refText).filter(Boolean).join('<br>') || '<span class="n">참조 없음</span>';
const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="n">없음</td></tr>`}</tbody></table>`;
const td = (h, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${h}</td>`;
const sec = (title, body) => `<h3>${esc(title)}</h3>${body}`;
// 칸이 gap 이면 근거 없음, 아니면 body(값).
const slotHtml = (v, body) => (isGap(v) ? `<div>${gapHtml(v)}</div>` : obj(v) || Array.isArray(v) ? body(v) : `<div>${gapHtml({ gap: '칸 없음' })}</div>`);

function verificationHtml(v) {
  return table(['id', '단위 기능', '결과', 'evidence'], arr(v).filter(obj).map((x) => `<tr>${td(esc(x.id), 'h')}${td(esc(x.module))}${td(esc(x.result))}${td(refsHtml(x.evidence), 'n')}</tr>`));
}

function flowHtml(f) {
  const rows = [['입력', f.input], ['처리', f.logic], ['출력', f.output]].map(([k, t]) => `<tr>${td(k, 't')}${td(str(t) ? esc(t) : gapHtml({ gap: '빈 칸' }))}</tr>`);
  return `${table(['구분', '내용'], rows)}<div class="meta">참조: ${refsHtml(f.refs)}</div>`;
}

function proofHtml(p) {
  const impl = arr(p.implemented).filter(obj).map((x) => `<tr>${td(esc(x.feature))}${td(esc(arr(x.modules).join(', ')), 'h')}${td(refsHtml(x.proofs), 'n')}</tr>`);
  const not = arr(p.notImplemented).filter(obj).map((x) => `<tr>${td(esc(x.feature))}${td(esc(x.why))}</tr>`);
  return `<div class="meta">구현된 기능과 증명 위치</div>${table(['구현된 기능', '모듈', '증명 위치'], impl)}<div class="meta">구현 못 한 기능</div>${table(['구현 못 한 기능', '사유'], not)}`;
}

const filled = (d) => DECISION_SLOTS.filter(([k]) => obj(d[k]) && !isGap(d[k])).length;
const emptyNames = (d) => DECISION_SLOTS.filter(([k]) => !(obj(d[k]) && !isGap(d[k]))).map(([, n]) => n);

function decisionRow(d) {
  const miss = emptyNames(d);
  const st = STATUS[d.status] || d.status;
  return `<tr>${td(esc(d.id), 'h')}${td(esc(d.title))}${td(esc(st))}${td(esc(d.date || '-'), 't')}${td(`${filled(d)}/3`, 'd')}${td(miss.length ? `<span class="b miss">${esc(miss.join(', '))}</span>` : '-', 'n')}</tr>`;
}

function tradeoffsHtml(t) {
  const gave = arr(t.gaveUp).filter(obj).map((x) => `<tr>${td(esc(x.what))}${td(esc(x.why))}</tr>`);
  const got = arr(t.gained).filter(obj).map((x) => `<tr>${td(esc(x.what))}${td(esc(x.purpose))}</tr>`);
  return `${table(['포기한 것', '이유'], gave)}${table(['얻은 것', '목적'], got)}`;
}

function decisionHtml(d) {
  const opts = arr(d.options).filter(obj).map((x) => `<tr>${td(esc(x.name))}${td(esc(x.pros))}${td(esc(x.cons))}</tr>`);
  const rejected = str(d.rejected) ? `<div class="meta">버린 선택지: ${esc(d.rejected)}</div>` : '';
  const optim = (o) => `<div>${esc(o.process)}</div><div class="meta">참조한 모듈: ${esc(arr(o.modules).join(', ') || '없음')}</div><div class="meta">참조: ${refsHtml(o.refs)}</div>`;
  const scale = (s) => `<div>${esc(s.argument)}</div>${str(s.limits) ? `<div class="meta">한계: ${esc(s.limits)}</div>` : ''}<div class="meta">참조: ${refsHtml(s.refs)}</div>`;
  return `<h2>${esc(d.id)} ${esc(d.title)} <small>${esc(STATUS[d.status] || d.status)}</small></h2>
<div class="meta">맥락: ${esc(d.context)}</div>${table(['선택지', '장점', '단점'], opts)}${rejected}
<div><b>결론</b>: ${esc(d.decision)}</div><div class="meta">이유: ${esc(d.why)}</div>
${sec('최적화 로직', slotHtml(d.optimization, optim))}${sec('확장 대응', slotHtml(d.scaling, scale))}${sec('포기와 얻은 것', slotHtml(d.tradeoffs, tradeoffsHtml))}
<div class="meta">근거 출처: ${refsHtml(d.sources)}</div>`;
}

// ADR 탭 본문. 자료가 없거나 깨졌으면 다른 탭처럼 안내와 스키마 문서.
export function adrBody(m, emptyNotice) {
  const v = m.adr && obj(m.adr.value);
  if (!v) return emptyNotice('references/adr.md');
  const p = obj(v.project) || {};
  const ds = arr(v.decisions).filter(obj);
  return `<div class="meta">의사 결정 기록. 위는 프로젝트 전체(검증, 흐름, 증거), 아래는 결정마다(최적화 로직, 확장 대응, 포기와 얻은 것). 자료: <code>adr.json</code>. 참조는 위치만 보이고 이 화면은 파일을 열지 않음. 참조 확인은 check.</div>
<h2>프로젝트 요약</h2>
${sec('검증', slotHtml(p.verification, verificationHtml))}${sec('흐름', slotHtml(p.flow, flowHtml))}${sec('증거', slotHtml(p.proof, proofHtml))}
<h2>결정 목록 <small>${ds.length}건</small></h2>
${table(['id', '제목', '상태', '날짜', '결정별 3항목', '빈 항목'], ds.map(decisionRow))}
${ds.map(decisionHtml).join('\n')}`;
}
