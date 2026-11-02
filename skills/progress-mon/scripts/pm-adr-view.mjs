// pm-adr-view.mjs: ADR 탭 화면 렌더. 검사, 밀도, 집계는 pm-adr.mjs.
// 화면은 참조를 글로만 보이고 파일을 읽거나 링크하지 않는다. 참조 확인은 check 가 하고, 그 집계는 adr-check.json 으로 대조한다.
import { DECISION_SLOTS, STATUS, adrTally, arr, isGap, obj, str } from './pm-adr.mjs';
import { esc } from './pm-html.mjs';

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

const evidenceHtml = (x) => (x.status === 'unverified' ? `<span class="b unv">미검증: ${esc(x.why)}</span>${arr(x.evidence).length ? `<br>${refsHtml(x.evidence)}` : ''}` : refsHtml(x.evidence));

function verificationHtml(v) {
  return table(['id', '단위 기능', '결과', 'evidence'], arr(v).filter(obj).map((x) => `<tr>${td(esc(x.id), 'h')}${td(esc(x.module))}${td(esc(x.result || '-'))}${td(evidenceHtml(x), 'n')}</tr>`));
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

// check 대조. 화면은 적힌 참조로, check 는 확인을 마친 참조로 센다(깨진 참조가 있으면 참조 없는 서술 수가 다름).
// m.adrCheck: check 가 남긴 adr-check.json({ sha, tally, at }), m.adr.sha: 지금 adr.json 의 sha256. text: 화면 집계 글.
export function checkNote(m, text) {
  const rec = m.adrCheck && obj(m.adrCheck.value);
  const b = (cls, t) => `<span class="b ${cls}">${esc(t)}</span>`;
  if (!rec || typeof rec.sha !== 'string' || typeof rec.tally !== 'string') return b('unv', 'check 기록 없음. 참조 확인은 check');
  const at = typeof rec.at === 'string' ? rec.at.slice(0, 19).replace('T', ' ') : '';
  const when = at ? `check(${at} UTC)` : 'check';
  if (rec.sha !== (m.adr && m.adr.sha)) return b('unv', `${when} 뒤 adr.json 이 바뀜. check 를 다시 실행하면 대조`);
  if (rec.tally === text) return b('done', `${when} 와 같음`);
  return b('miss', `${when} 기준: ${rec.tally}. 화면은 적힌 참조로 세어 다름. 확인 못 한 참조는 check 의 참조 줄`);
}

// ADR 탭 본문. 자료가 없거나 깨졌으면 다른 탭처럼 안내와 스키마 문서.
export function adrBody(m, emptyNotice) {
  const v = m.adr && obj(m.adr.value);
  if (!v) return emptyNotice('references/adr.md');
  const p = obj(v.project) || {};
  const ds = arr(v.decisions).filter(obj);
  const tally = adrTally(v);
  return `<div class="meta">의사 결정 기록. 위는 프로젝트 전체(검증, 흐름, 증거), 아래는 결정마다(최적화 로직, 확장 대응, 포기와 얻은 것). 자료: <code>adr.json</code>. 참조는 위치만 보이고 이 화면은 파일을 열지 않음. 참조 확인은 check.</div>
<div class="meta"><span class="b ${tally.any ? 'miss' : 'done'}">${esc(tally.text)}</span> ${checkNote(m, tally.text)}</div>
<h2>프로젝트 요약</h2>
${sec('검증', slotHtml(p.verification, verificationHtml))}${sec('흐름', slotHtml(p.flow, flowHtml))}${sec('증거', slotHtml(p.proof, proofHtml))}
<h2>결정 목록 <small>${ds.length}건</small></h2>
${table(['id', '제목', '상태', '날짜', '결정별 3항목', '빈 항목'], ds.map(decisionRow))}
${ds.map(decisionHtml).join('\n')}`;
}
