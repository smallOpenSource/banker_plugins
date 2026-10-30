// pm-render.mjs: 4탭(진척도, 구현요건, workflow, 구성도)과 단일 HTML 스냅숏, workflow 배치와 구성도 자동 배치.
// 옛 진척도 서버의 클래스 이름과 DOM 구조를 그대로 둔다. 저장소 고유 값은 config.json 에서 읽는다.
// 시각은 now 인자로만 받는다. CLI 하위 명령 export 도 여기서 맡는다.
import fs from 'node:fs';
import path from 'node:path';
import { esc, color, finite, textW, wrap, FAVICON, CSS, TABS, tabsHtml } from './pm-html.mjs';
import { configOrFail, loadConfig, UsageError, DEFAULT_REQ_RULE, STORYLESS_REQ_RULE } from './pm-config.mjs';
import { collect, parseTime, storyOfBusyLabel, hiddenAgent } from './pm-sources.mjs';

const two = (n) => String(n).padStart(2, '0');
const hm = (ms) => (ms == null ? '-' : Math.floor(ms / 3600e3) + ':' + two(Math.floor((ms % 3600e3) / 60000)));
// 표시는 실행 환경 시간대(현지).
const fmt = (ms) => {
  if (!ms) return '-';
  const d = new Date(ms);
  return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
};
const span = (a, b) => (a && b && b >= a ? b - a : undefined);
const nowText = (now) => new Date(now).toLocaleString('ko-KR', { hour12: false });
const arr = (v) => (Array.isArray(v) ? v : []);
// 문장 끝 온점(뒤에 공백)에서 줄을 바꾼다. 판 번호(5.7.12) 같은 점은 그대로 둔다.
const brk = (t) => esc(t).replace(/\.\s+/g, '.<br>');
// 이미 만든 HTML 문단에 같은 규칙. 문단 안 태그는 속성 없는 <code> 뿐이라 태그 안에 ". " 가 없다.
const sent = (h) => h.replace(/\.\s+(?=\S)/g, '.<br>');
// 자료 없음 안내. 스키마 문서는 스킬 기준 경로.
const emptyNotice = (...docs) => `<div class="meta empty">자료 없음. 만드는 법: ${docs.map((d) => `<code>${esc(d)}</code>`).join(', ')}</div>`;
const tabName = (k) => TABS.find((t) => t[0] === k)[1];

// ---------- 진척도 ----------

const LABEL = { done: '완료', doing: '진행 중', todo: '예정' };

// 스토리 상태 판정 함수 묶음. 커밋(제목 판정 또는 storyCommits)이 있으면 완료, 없으면 storyStates, 없으면 진행 중 에이전트.
function storyJudge(m, config) {
  const pattern = config.agentLabelPattern;
  const busy = new Map();
  for (const a of m.agents) {
    const id = storyOfBusyLabel(a.label, m.ids, pattern);
    if (id) busy.set(id, a);
  }
  const ss = (id) => {
    const v = m.storyStates[id];
    return v && typeof v === 'object' && ['done', 'doing', 'todo'].includes(v.status) ? v : null;
  };
  const state = (id) => (m.commits[id] ? 'done' : ss(id) ? ss(id).status : busy.has(id) ? 'doing' : 'todo');
  return { busy, ss, state, hidden: (label) => hiddenAgent(label, m.ids, pattern) };
}

function historyBody(m, config, now) {
  const j = storyJudge(m, config);
  const rows = { done: [], doing: [], todo: [] };
  // live: 실행 중 정보(에이전트, 멈춤). notes 비고 앞에 붙인다. dur: 소요시간(ms).
  const add = (status, t, kind, text, o = {}) => {
    const n = (o.key && m.notes[o.key]) || {};
    const note = [o.live, o.note || n.note].filter(Boolean).join(', ');
    (rows[status] || rows.doing).push({ t, dur: o.dur, kind, text, hash: o.hash || '', note, issue: o.issue || n.issue || '' });
  };
  for (const { id, label } of m.stages) {
    const s = m.stageState[id];
    const key = 'stage:' + id;
    if (!s) add('todo', 0, '단계', label, { key });
    else if (s.s === 'done') add('done', s.t, '단계', label, { key, dur: span(s.start, s.t) });
    else add('doing', s.t, '단계', label, { key, dur: span(s.start, now), live: s.s === 'stopped' ? '멈춤' : '' });
  }
  for (const { id, name } of m.stories) {
    const c = m.commits[id];
    const st = j.ss(id);
    const text = id + ' ' + name;
    const a = j.busy.get(id);
    if (c) add('done', c.t, '스토리', text, { key: id, hash: c.h, dur: span(m.starts[id], c.t) });
    else if (st && st.status === 'done') {
      const t = parseTime(st.t);
      add('done', t, '스토리', text, { key: id, dur: span(m.starts[id], t) });
    } else if (st && st.status === 'doing') {
      const t = parseTime(st.t) || (a ? a.since : 0);
      add('doing', t, '스토리', text, { key: id, dur: span(m.starts[id] || t, now), live: a ? a.label : '' });
    } else if (!st && a) add('doing', a.since, '스토리', text, { key: id, dur: span(m.starts[id] || a.since, now), live: a.label });
    else add('todo', 0, '스토리', text, { key: id });
  }
  for (const a of m.agents) if (!j.hidden(a.label)) add('doing', a.since, '에이전트', a.label, { dur: span(a.since, now) });
  // 기타 항목은 s(시작 시각)가 있을 때만 소요시간을 낸다. hash(item --commit)는 앞 7자리.
  for (const x of m.items) {
    const t = parseTime(x.t);
    const s0 = parseTime(x.s);
    const hash = typeof x.hash === 'string' ? x.hash.slice(0, 7) : '';
    add(x.status, t, '기타', x.text, { note: x.note, issue: x.issue, hash, dur: span(s0, x.status === 'doing' ? now : t) });
  }
  rows.done.sort((a, b) => a.t - b.t);
  rows.doing.sort((a, b) => a.t - b.t);
  // 진척률: 스토리가 있으면 스토리, 없으면 단계와 기타 항목(에이전트 행은 넣지 않음).
  const total = m.stories.length;
  const nDone = m.stories.filter((s) => j.state(s.id) === 'done').length;
  const work = [...rows.done, ...rows.doing, ...rows.todo].filter((r) => r.kind !== '에이전트');
  const iTotal = work.length;
  const iDone = rows.done.filter((r) => r.kind !== '에이전트').length;
  const [unit, a, b] = total ? ['스토리', nDone, total] : ['항목', iDone, iTotal];
  const pct = b ? Math.round((a / b) * 100) : 0;
  let seq = 0;
  const section = (k) =>
    `<tr class="sec ${k}"><td colspan="8">${LABEL[k]} ${rows[k].length}건</td></tr>` +
    rows[k].map((r) => `<tr class="${k}"><td class="q">${++seq}</td><td class="t">${fmt(r.t)}</td><td class="d">${hm(r.dur)}</td><td><span class="b ${k}">${LABEL[k]}</span></td><td><small>${esc(r.kind)}</small> ${esc(r.text)}</td><td class="h">${esc(r.hash)}</td><td class="p">${brk(r.issue)}</td><td class="n">${brk(r.note)}</td></tr>`).join('');
  // 표에 그릴 행이 하나도 없을 때만 기록이 없다는 안내 한 줄과 기록 명령(승인 목업 문구).
  const empty = !m.stages.length && !rows.done.length && !rows.doing.length && !rows.todo.length;
  const head = b
    ? `<div>${unit} ${a}/${b} 완료 (${pct}%)</div><div class="bar"><i style="width:${pct}%"></i></div>`
    : empty
      ? '<div class="meta">단계와 스토리 기록 없음. ultra-chain 실행 기록(events.jsonl)이 없고 config.json 의 stories 가 비어 있음. stage, story, item 명령으로 기록</div>'
      : '';
  // 소요시간이 모두 "-" 면 칸이 좁아 머리글이 한 글자씩 꺾인다. 그때만 머리글을 꺾지 않는다(줄은 <br> 두 줄 그대로).
  const durTh = [...rows.done, ...rows.doing, ...rows.todo].some((r) => r.dur != null) ? '<th>소요<br>시간</th>' : '<th style="white-space:nowrap">소요<br>시간</th>';
  // 스토리와 단계가 모두 없는 프로젝트는 내용 칸이 좁아질 수 있어 한글 낱말 가운데에서 꺾지 않는다(공백에서만).
  const keep = !m.stories.length && !m.stages.length ? ' style="word-break:keep-all"' : '';
  return `${head}
<table${keep}><thead><tr><th>순번</th><th>시각</th>${durTh}<th>상태</th><th>내용</th><th>commit Hash<br>(앞 7자리)</th><th>문제점</th><th>비고</th></tr></thead><tbody>
${section('done')}
${section('doing')}
${section('todo')}
</tbody></table>`;
}

// ---------- 구현요건 ----------

const REQ_LABEL = { done: '완료', part: '일부', doing: '진행 중', todo: '미구현', unv: '미검증', excl: '대상 제외', none: '명세 없음' };

// 요구(묶음) 상태. 대상 제외 명세는 넣지 않고 모두 대상 제외면 대상 제외. 차례: 모두 완료면 완료, 진행 중이 있으면 진행 중,
// 완료나 일부가 있으면 일부, 모두 미검증이나 명세 없음이고 미검증이 하나라도 있으면 미검증, 모두 명세 없음이면 명세 없음, 그 밖 미구현.
export function groupKind(ks) {
  const kin = ks.filter((k) => k !== 'excl');
  if (!kin.length) return 'excl';
  if (kin.every((k) => k === 'done')) return 'done';
  if (kin.includes('doing')) return 'doing';
  if (kin.some((k) => k === 'done' || k === 'part')) return 'part';
  if (kin.every((k) => k === 'none')) return 'none';
  if (kin.every((k) => k === 'unv' || k === 'none')) return 'unv';
  return 'todo';
}

// 판정 순서(계획 4.4절): 명세 state, 근거 AC 의 담당 스토리, 스토리 없는 AC 는 미검증, AC 없음은 명세 없음.
function reqBody(m, config) {
  if (!m.reqSpec.value) return emptyNotice('references/req-spec.md', 'references/reqs.md');
  const j = storyJudge(m, config);
  const spec = m.reqSpec.value;
  const users = arr(spec.users);
  const acStories = new Map(arr(m.reqs.value && m.reqs.value.acs).map((a) => [a && a.id, a && a.stories]));
  const judge = (stories) => {
    const left = stories.filter((s) => j.state(s) !== 'done');
    return { k: !left.length ? 'done' : left.some((s) => j.state(s) === 'doing') ? 'doing' : left.length < stories.length ? 'part' : 'todo', left };
  };
  const cnt = { done: 0, part: 0, doing: 0, todo: 0, unv: 0, excl: 0, none: 0 };
  // 스토리가 없는 프로젝트(설정과 story 명령 모두 없음)는 빈 담당 스토리 칸과 빈 스토리 표를 그리지 않는다.
  const specStories = Object.entries(spec.stories && typeof spec.stories === 'object' ? spec.stories : {});
  const noStories = !m.stories.length;
  const stCol = !noStories || users.some((u) => arr(u.specs).some((x) => arr(x.acs).some((a) => arr(acStories.get(a)).length)));
  let nSpec = 0;
  const body = users
    .map((u, ui) => {
      const ks = [];
      const rows = arr(u.specs)
        .map((x, si) => {
          const acs = arr(x.acs);
          const stories = [...new Set(acs.flatMap((a) => arr(acStories.get(a))))];
          let r;
          if (x.state && REQ_LABEL[x.state]) r = { k: x.state, left: [] };
          else if (acs.length && stories.length) r = judge(stories);
          else if (acs.length) r = { k: 'unv', left: [], why: '담당 스토리 없음' };
          else r = { k: 'none', left: [] };
          const { k, left } = r;
          ks.push(k);
          cnt[k]++;
          nSpec++;
          const st = stories.map((s) => `<span class="s${j.state(s) === 'done' ? ' ok' : ''}">${esc(s)}</span>`).join('');
          const note = [r.why || (left.length && k !== 'todo' ? '남은 스토리 ' + left.join(', ') : ''), x.note].filter(Boolean).join('. ');
          return `<tr><td class="q">${ui + 1}.${si + 1}</td><td>${brk(x.text)}</td><td class="h">${esc(acs.join(', '))}</td>${stCol ? `<td class="st">${st}</td>` : ''}<td><span class="b ${k === 'none' ? 'miss' : k}">${REQ_LABEL[k]}</span></td><td class="n">${esc(note)}</td></tr>`;
        })
        .join('');
      const uk = groupKind(ks);
      return `<tr class="sec"><td class="q">${ui + 1}</td><td colspan="${stCol ? 3 : 2}">${brk(u.text)} <small>${esc(u.source)}</small></td><td><span class="b ${uk === 'none' ? 'miss' : uk}">${REQ_LABEL[uk]}</span></td><td></td></tr>${rows}`;
    })
    .join('');
  // 대상 제외 명세는 완료율의 분모에서 뺀다.
  const pct = Math.round((cnt.done / (nSpec - cnt.excl || 1)) * 100);
  // 담당 스토리 칸이 없을 때 판정 문구가 기본(스토리 기준) 그대로면 state 판정 문구로 바꾼다.
  // 담당 스토리 칸이 없으면 상태 칸이 좁아 "구현 여부" 가 꺾이므로 그 머리글은 꺾지 않는다(아래 머리 줄).
  const rule = !stCol && config.text.reqRule === DEFAULT_REQ_RULE ? STORYLESS_REQ_RULE : config.text.reqRule;
  const stories = specStories
    .map(([id, v]) => {
      const [name, what] = Array.isArray(v) ? v : [v, ''];
      const k = j.state(id);
      return `<tr><td class="st"><span class="s${k === 'done' ? ' ok' : ''}">${esc(id)}</span></td><td>${esc(name)}</td><td>${esc(what)}</td><td><span class="b ${k}">${REQ_LABEL[k]}</span></td></tr>`;
    })
    .join('');
  return `<div>요구 ${users.length}건, 기능 명세 ${nSpec}건: 완료 ${cnt.done}, 일부 ${cnt.part}, 진행 중 ${cnt.doing}, 미구현 ${cnt.todo}, 미검증 ${cnt.unv}, 대상 제외 ${cnt.excl}, 명세 없음 ${cnt.none} (대상 제외를 뺀 완료 ${pct}%)</div><div class="bar"><i style="width:${pct}%"></i></div>
<div class="meta">${sent(`${esc(rule)} ${esc(spec.excluded || '')}`)}</div>
<table><thead><tr><th>순번</th><th>요구 / 기능 명세</th><th>근거 AC</th>${stCol ? '<th>담당 스토리</th><th>구현 여부</th>' : '<th style="white-space:nowrap">구현 여부</th>'}<th>비고</th></tr></thead><tbody>${body}</tbody></table>${noStories && !specStories.length ? '' : `
<h2>스토리</h2>
<table class="sty"><thead><tr><th>스토리</th><th>이름</th><th>내용</th><th>상태</th></tr></thead><tbody>${stories}</tbody></table>`}`;
}

// ---------- workflow ----------
// 흐름별 SVG. 상자 id(<흐름>-<단계>)와 data-scene 은 모션 그래픽으로 옮길 때 장면과 상자를 잇는 열쇠다.
// FPAD: 그림 좌우 여백(줄 바꿈 연결선이 지나는 자리), FOUT: 그 연결선이 상자 옆면에서 나가는 거리.
export const FLOW = { FW: 176, FH: 92, FGX: 38, FGY: 104, FPER: 5, FTOP: 34, FSTEP_S: 0.9, FPAD: 40, FOUT: 28 };
const { FW, FH, FGX, FGY, FPER, FTOP, FSTEP_S, FPAD, FOUT } = FLOW;
const PLANNED_TAG = '예정';

// 두 사각형이 가로와 세로 모두 1 px 이상 겹치는 양. 변이 닿기만 하면 0.
const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

// 단계 이름(.lb, 14px 굵게) 폭 추정. textW 의 글자 구분(0x2e7f 넘는 한글 등과 그 밖)을 14px 굵은 글꼴 실측에 맞춰 나눔.
// 브라우저 실측(Chromium, 맑은 고딕 굵게 14px): 한글 14.0, 공백 4.9, M W m w 12.9~14.1, 그 밖 대문자 11.2 이하,
// i l f r 과 문장 부호 5.8 이하, 그 밖 소문자와 숫자 8.8 이하. 이 저장소 이름 33개에서 실측보다 작게 잡은 것 0.
const nameW = (t) =>
  [...String(t || '')].reduce((a, ch) => a + (ch === ' ' ? 5 : ch.charCodeAt(0) > 0x2e7f || /[MWmw@%&]/.test(ch) ? 14 : /[A-Z]/.test(ch) ? 11 : /[ijlIft.,:;|!()[\]{}/\-r]/.test(ch) ? 6 : 8.8), 0);

// 단계 이름 한 줄이 상자 안에 들어가는지. 이름은 x + 32 에서 시작해 상자 테두리(폭 2) 안쪽 176 - 2 까지.
// 예정 단계는 오른쪽 "예정" 표기(끝 176 - 8, 폭 textW) 앞 4 px 까지. 옛 서버는 줄바꿈하지 않으므로 정말 넘칠 때만 두 줄.
export const nameFits = (s, planned) => 32 + nameW(s) <= (planned ? FW - 8 - textW(PLANNED_TAG) - 4 : FW - 2);

// 단계 이름 줄. 한 줄에 들어가지 않으면 두 줄.
export function labelLines(label, planned) {
  const t = String(label ?? '');
  if (nameFits(t, planned)) return [t];
  const words = t.split(' ');
  let first = words[0];
  let i = 1;
  while (i < words.length && nameFits(first + ' ' + words[i], planned)) first += ' ' + words[i++];
  const rest = words.slice(i).join(' ');
  return rest ? [first, rest] : [t];
}

// 흐름 하나의 배치(렌더와 check 가 같이 씀). 옛 공식(한 줄 5상자 지그재그)에 두 가지만 더함:
// 분기 표가 아래 줄 상자나 외부 표와 1 px 이상 겹치면 그 줄 간격을 필요한 만큼 늘림, 넘치는 이름은 두 줄
// (설명은 한 줄 내리고 3줄 그대로. 설명이 3줄이면 그 상자 높이를 15 px 늘리고 다음 줄도 그만큼 내림).
export function flowLayout(l) {
  const steps = arr(l.steps);
  const branches = arr(l.branches);
  const externals = arr(l.externals);
  const n = steps.length;
  const rows = Math.ceil(n / FPER);
  const byId = new Map(steps.map((s, i) => [s.id, i]));
  const brText = (b) => {
    const j = byId.get(b.to);
    return String(b.when ?? '') + (j !== undefined ? ` (${j + 1}번)` : '');
  };
  // 줄 바꿈 연결선은 이 흐름에서 가장 긴 분기 표의 오른쪽 끝보다 바깥을 지난다.
  const out = Math.max(FOUT, ...branches.map((b) => 20 + textW(brText(b)) + 16 - FW + 10));
  const pad = Math.max(FPAD, out + 12);
  const cells = steps.map((s, i) => {
    const r = Math.floor(i / FPER);
    const c = i % FPER;
    const col = r % 2 ? FPER - 1 - c : c;
    return { x: pad + col * (FW + FGX), r, c };
  });
  // 분기 표(상자 아래, 상자마다 차례 k). y 는 줄 위에서의 거리.
  const brCount = new Map();
  const brs = [];
  for (const b of branches) {
    const i = byId.get(b.from);
    if (i === undefined) continue;
    const k = brCount.get(i) || 0;
    brCount.set(i, k + 1);
    const text = brText(b);
    brs.push({ b, i, k, text, w: textW(text) + 16 });
  }
  // 외부 표(상자 위). 한 상자에 여럿이면 옆으로.
  const extX = new Map();
  const exts = [];
  for (const e of externals) {
    const i = byId.get(e.linkTo);
    if (i === undefined) continue;
    const x = extX.get(i) ?? cells[i].x + 6;
    const w = textW(e.label) + 16;
    extX.set(i, x + w + 6);
    exts.push({ e, i, x, w });
  }
  const names = steps.map((s) => labelLines(s.label, s.planned));
  // 이름이 두 줄이면 설명 첫 줄을 한 줄(15 px) 내린다. 설명은 3줄까지 그대로 두고, 내린 설명이 3줄이면 상자를 15 px 늘린다.
  const downs = names.map((nm) => (nm.length > 1 ? 15 : 0));
  const descs = steps.map((s) => wrap(s.detail, FW - 20).slice(0, 3));
  const hs = descs.map((d, i) => FH + (downs[i] && d.length > 2 ? 15 : 0));
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(FH, ...hs.filter((_, i) => cells[i].r === r)));
  // 줄 위치. 기본 간격 FGY(앞 줄의 가장 높은 상자 아래부터), 겹치면 늘림.
  const rowTop = [];
  for (let r = 0; r < rows; r++) {
    if (!r) {
      rowTop.push(FTOP);
      continue;
    }
    const top = rowTop[r - 1];
    const H = rowH[r - 1];
    let gap = FGY;
    for (const q of brs) {
      if (cells[q.i].r !== r - 1) continue;
      const x0 = cells[q.i].x + 20;
      const bottom = top + hs[q.i] + 10 + q.k * 24 + 20;
      for (let i = 0; i < n; i++) {
        if (cells[i].r !== r || overlap(x0, x0 + q.w, cells[i].x, cells[i].x + FW) < 1) continue;
        if (bottom - (top + H + gap) >= 1) gap = bottom - top - H;
      }
      for (const x of exts) {
        if (cells[x.i].r !== r || overlap(x0, x0 + q.w, x.x, x.x + x.w) < 1) continue;
        if (bottom - (top + H + gap - 26) >= 1) gap = bottom - top - H + 26;
      }
    }
    rowTop.push(top + H + gap);
  }
  const pos = cells.map((c) => ({ x: c.x, y: rowTop[c.r], r: c.r, c: c.c }));
  const maxBr = Math.max(0, ...brCount.values());
  const h = rows ? rowTop[rows - 1] + rowH[rows - 1] + 14 + maxBr * 24 : FTOP + 14;
  const cols = Math.min(n, FPER);
  const w = Math.max(0, 2 * pad + cols * FW + (cols - 1) * FGX);
  const branchesAt = brs.map((q) => {
    const p = pos[q.i];
    const y = p.y + hs[q.i] + 10 + q.k * 24;
    return { ...q, sx: p.x + 10, x: p.x + 20, y, cy: y + 10, y0: q.k ? y + 10 - 24 : p.y + hs[q.i] };
  });
  const externalsAt = exts.map((q) => ({ ...q, y: pos[q.i].y - 26 }));
  return { n, rows, out, pos, rowTop, names, downs, descs, hs, branches: branchesAt, externals: externalsAt, w, h };
}

function laneSvg(l, li, scenesOf) {
  const L = flowLayout(l);
  const steps = arr(l.steps);
  const lc = color(l.color, '#455a64');
  const { n, pos, out } = L;
  const cycle = n * FSTEP_S + 1.5;
  const hi = Math.max(2, Math.round((FSTEP_S / cycle) * 100));
  const parts = [];
  // 연결선: 같은 줄은 옆으로. 줄이 바뀌면 줄 끝 상자의 바깥 옆면에서 나가 그림 가장자리를 따라 내려와
  // 다음 줄 상자의 같은 옆면으로 들어간다. alone 단계는 앞 단계와 잇지 않는다(다른 진입점).
  for (let i = 0; i + 1 < n; i++) {
    if (steps[i + 1].alone) continue;
    const a = pos[i];
    const b = pos[i + 1];
    const ltr = a.r % 2 === 0;
    if (a.r === b.r) {
      const x1 = ltr ? a.x + FW : a.x;
      const x2 = ltr ? b.x - 4 : b.x + FW + 4;
      const y = a.y + FH / 2;
      parts.push(`<line class="fl" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${lc}" marker-end="url(#ah${li})"/>`);
    } else {
      const ya = a.y + FH / 2;
      const yb = b.y + FH / 2;
      const pts = ltr
        ? [[a.x + FW, ya], [a.x + FW + out, ya], [a.x + FW + out, yb], [b.x + FW + 4, yb]]
        : [[a.x, ya], [a.x - out, ya], [a.x - out, yb], [b.x - 4, yb]];
      parts.push(`<polyline class="fl" points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${lc}" marker-end="url(#ah${li})"/>`);
    }
  }
  steps.forEach((s, i) => {
    const p = pos[i];
    const sc = scenesOf(l.id, s.id);
    const name = L.names[i];
    const down = L.downs[i];
    const refs = arr(s.refs);
    parts.push(`<g class="n${s.planned ? ' pl' : ''}" id="${esc(l.id + '-' + s.id)}" data-scene="${esc(sc.join(','))}" style="animation:fp${li} ${cycle}s ${(i * FSTEP_S).toFixed(1)}s infinite">
<title>${esc(s.actor + ': ' + s.detail + (refs.length ? ' (' + refs.join(', ') + ')' : ''))}</title>
<rect x="${p.x}" y="${p.y}" width="${FW}" height="${L.hs[i]}" rx="10" fill="#fff" stroke="${lc}" stroke-width="2"${s.planned ? ' stroke-dasharray="6 4"' : ''}/>
<circle cx="${p.x + 16}" cy="${p.y + 16}" r="10" fill="${lc}"/><text x="${p.x + 16}" y="${p.y + 20}" class="no">${i + 1}</text>
<text x="${p.x + 32}" y="${p.y + 21}" class="lb">${esc(name[0])}</text>${name[1] !== undefined ? `<text x="${p.x + 32}" y="${p.y + 37}" class="lb l2">${esc(name[1])}</text>` : ''}
<text x="${p.x + FW - 8}" y="${p.y + 21}" class="ac">${s.planned ? PLANNED_TAG : ''}</text>
${L.descs[i].map((t, k) => `<text x="${p.x + 10}" y="${p.y + 42 + down + k * 15}" class="dt">${esc(t)}</text>`).join('')}
<text x="${p.x + 10}" y="${p.y + L.hs[i] - 7}" class="who">${esc(s.actor)}</text></g>`);
  });
  // 외부 구성요소: 연결된 상자 위에 회색 표. 예정 변경은 주황 표.
  for (const { e, i, x, w } of L.externals) {
    const p = pos[i];
    const y = p.y - 26;
    const [fill, line] = e.planned ? ['#fff4e0', '#b26a00'] : ['#eef0f3', '#999'];
    parts.push(`<g class="ex" id="${esc(l.id + '-' + e.id)}"><title>${esc(e.note)}</title><line x1="${x + w / 2}" y1="${y + 18}" x2="${x + w / 2}" y2="${p.y}" stroke="${line}" stroke-dasharray="3 3"/><rect x="${x}" y="${y}" width="${w}" height="18" rx="9" fill="${fill}" stroke="${line}" stroke-dasharray="3 3"/><text x="${x + w / 2}" y="${y + 13}" class="et">${esc(e.label)}</text></g>`);
  }
  // 분기: 상자 아래 빨간 표. 상자 왼쪽 아래의 세로선 하나에서 표마다 가지를 친다. note 는 마우스를 올리면 보인다.
  for (const { b, text, sx, x, y, cy, y0, w } of L.branches) {
    parts.push(`<g class="br"><title>${esc(b.note || b.when)}</title><polyline points="${sx},${y0} ${sx},${cy} ${x},${cy}" fill="none" stroke="#c62828" stroke-dasharray="3 3"/><rect x="${x}" y="${y}" width="${w}" height="20" rx="10" fill="#fdecea" stroke="#c62828"/><text x="${x + 8}" y="${y + 14}" class="bt">${esc(text)}</text></g>`);
  }
  return `<style>@keyframes fp${li}{0%{filter:none}${Math.round(hi / 2)}%{filter:drop-shadow(0 0 7px ${lc})}${hi}%,100%{filter:none}}</style>
<svg class="flow" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}" role="img" aria-label="${esc(l.title)}"><defs><marker id="ah${li}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${lc}"/></marker></defs>${parts.join('')}</svg>`;
}

function flowBody(m) {
  if (!m.flow.value) return emptyNotice('references/flow.md');
  const f = m.flow.value;
  const lanes = arr(f.lanes);
  const scenes = arr(f.scenes);
  const scenesOf = (lane, id) => scenes.filter((s) => s.lane === lane && arr(s.focus).includes(id)).map((s) => s.n);
  const body = lanes
    .map((l, li) => `<h2><span class="dot" style="background:${color(l.color, '#455a64')}"></span>${esc(l.title)} <small>${arr(l.steps).length}단계</small></h2>${l.note ? `<div class="meta">${brk(l.note)}</div>` : ''}<div class="fwrap">${laneSvg(l, li, scenesOf)}</div>`)
    .join('');
  const total = scenes.reduce((a, s) => a + (finite(s.sec) ? s.sec : 0), 0);
  const laneTitle = new Map(lanes.map((l) => [l.id, l.title]));
  const stepLabel = (lane, id) => {
    const l = lanes.find((x) => x.id === lane);
    const i = l ? arr(l.steps).findIndex((s) => s.id === id) : -1;
    return i < 0 ? id : `${i + 1} ${l.steps[i].label}`;
  };
  const rows = scenes.map((s) => `<tr><td class="q">${esc(s.n)}</td><td class="d">${esc(s.sec)}초</td><td>${esc(laneTitle.get(s.lane) || s.lane || '전체')}</td><td>${esc(s.caption)}</td><td class="n">${esc(arr(s.focus).map((id) => stepLabel(s.lane, id)).join(', '))}</td></tr>`).join('');
  return `<div class="meta">${sent(`${esc(f.note || '')} 실행 순서를 그린 화면. 구성요소 사이의 연결은 구성도 탭. 자료: <code>flow.json</code>. 상자에 마우스를 올리면 행위자, 근거 파일이 보임. 점선 상자는 예정(아직 구현 안 됨), 빨간 표는 분기, 회색 표는 외부 구성요소, 주황 표는 예정 변경. 표에 마우스를 올리면 근거가 보임.`)}</div>
${body}
<h2>장면 대본 <small>모션 그래픽 준비, 합계 ${total}초</small></h2>
<table><thead><tr><th>장면</th><th>길이</th><th>흐름</th><th>화면 내용</th><th>강조 단계</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- 구성도 ----------
// 영역(zones), 구성요소(nodes), 연결(edges). 연결 종류: api(요청이 흐르는 길, 움직이는 굵은 선),
// control(실행, 호출), data(파일, 설정 읽기와 쓰기, 점선).
const ACOL = { api: '#e65100', control: '#455a64', data: '#8d8d8d' };
// 자동 배치 치수: 바깥 여백, 영역 머리, 영역 안 여백, 상자 사이 가로와 세로, 영역 사이(위아래, 옆), 상자 최소 크기,
// 띠 폭 상한 후보, 넓은 후보(가로세로 비를 못 맞출 때만), 가로세로 비 하한과 그 하한을 적용하는 상자 수, WARN 하나의 값(px),
// 배치 고르기에서 선 길이 1 px 의 값, 엇갈림 하나의 값, 붐비는 이름표(상자에서 LBOX 안, 영역 이름이나 테두리를 가림, 다른 선이 LGAP 안) 하나의 값,
// 선을 그어 보는 후보 수, 상자 순서 후보에서 옮기는 상자의 다른 영역 연결 수, 두 끝이 속하지 않는 영역 안을 지나는 선 1 px 의 값,
// 좁은 나란한 선 쌍과 테두리 붙은 긴 선분 하나의 값(routeSum).
// 연결 길 찾기 값은 아래 ROUTE.
const AUTO = { PAD: 20, HEAD: 32, IN: 16, GX: 60, GY: 40, ZGAP: 72, ZGX: 48, NW: 160, NH: 64, WIDTHS: [1200, 1400, 1560], WIDE: 1760, RATIO: 1.2, MANY: 20, WARN_PX: 60, LEN: 0.1, CROSS: 10, CROWD: 30, TRY: 3, HUB: 4, FOREIGN: 0.3, TIGHT: 20 };

// 상자 a 의 가장자리에서 점 (bx, by) 쪽으로 나가는 점. off 는 가장자리를 따라 옮기는 거리.
function exitPt(a, bx, by, off = 0) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) * a.h >= Math.abs(dy) * a.w) return [dx > 0 ? a.x + a.w : a.x, ay + off];
  return [ax + off, dy > 0 ? a.y + a.h : a.y];
}

// 상자 a 에서 b 까지 선의 점. via 는 꺾는 점.
function pathOf(a, b, via, off, offTo) {
  const first = via[0] || [b.x + b.w / 2, b.y + b.h / 2];
  const last = via[via.length - 1] || [a.x + a.w / 2, a.y + a.h / 2];
  return [exitPt(a, first[0], first[1], off), ...via, exitPt(b, last[0], last[1], offTo)];
}

// 선분의 둘레 사각형이 상자 안쪽(가장자리 1 px 안쪽)과 겹치는지. 가로나 세로 선분이면 상자를 지나는지와 같다.
const axisHits = (p, q, r) => Math.max(p[0], q[0]) > r.x + 1 && Math.min(p[0], q[0]) < r.x + r.w - 1 && Math.max(p[1], q[1]) > r.y + 1 && Math.min(p[1], q[1]) < r.y + r.h - 1;

// 선분이 상자 안을 지나는지(가장자리 1 px 안쪽, 표본점 19개). check 의 판정. 둘레 사각형이 겹치지 않으면 표본점도 들어가지 않는다.
function segHits(p, q, r) {
  if (!axisHits(p, q, r)) return false;
  for (let k = 1; k < 20; k++) {
    const x = p[0] + ((q[0] - p[0]) * k) / 20;
    const y = p[1] + ((q[1] - p[1]) * k) / 20;
    if (x > r.x + 1 && x < r.x + r.w - 1 && y > r.y + 1 && y < r.y + r.h - 1) return true;
  }
  return false;
}

const RECT = ['x', 'y', 'w', 'h'];
const optNum = (v) => v === undefined || v === null || finite(v);
const okVia = (v) => v === undefined || v === null || (Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])));

// 좌표를 쓸 수 없는 첫 키 경로. 모두 맞으면 null(계획 4.5절 키 집합).
export function missingCoord(f) {
  for (const k of ['width', 'height']) if (!finite(f[k])) return k;
  for (const [list, name] of [[arr(f.zones), 'zones'], [arr(f.nodes), 'nodes']]) {
    for (let i = 0; i < list.length; i++) for (const k of RECT) if (!finite(list[i] && list[i][k])) return `${name}[${i}].${k}`;
  }
  const edges = arr(f.edges);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i] || {};
    if (!okVia(e.via)) return `edges[${i}].via`;
    for (const k of ['lx', 'ly', 'off', 'offTo']) if (!optNum(e[k])) return `edges[${i}].${k}`;
  }
  return null;
}

// 자동 배치의 상자 크기: 이름, 설명 줄(가장 긴 낱말이 한 줄에 들어가는 폭), 칩 줄이 들어가는 폭과 높이.
function nodeNeed(n, w, prefix) {
  const sub = wrap(n.detail, w - 16).slice(0, n.lines || 2);
  let cx = 8;
  let cy = 26 + sub.length * 14 + 4;
  let chips = false;
  let wide = 0;
  for (const t of arr(n.items)) {
    const cw = textW(t) + 12;
    wide = Math.max(wide, cw + 14);
    if (cx + cw > w - 6) {
      cx = 8;
      cy += 19;
    }
    cx += cw + 4;
    chips = true;
  }
  const textBottom = sub.length ? 34 + (sub.length - 1) * 14 + 4 : 22;
  const tag = n.planned ? textW(prefix) + 8 : 0;
  const word = Math.max(0, ...String(n.detail || '').split(' ').map((t) => Math.ceil(textW(t) * 1.1) + 16));
  return { h: Math.max(AUTO.NH, Math.max(textBottom, chips ? cy + 16 : 0) + 10), w: Math.max(Math.ceil(textW(n.label) * 1.3) + 16 + tag, wide, word) };
}

// 영역 제목 띠: 렌더가 영역 이름을 쓰는 자리(왼쪽 위 + (12, 5), 굵은 13px 글 폭 x 1.3, 높이 18). 길 찾기의 장애물.
const titleBand = (z, x, y) => ({ x: x + 12, y: y + 5, w: textW(z.label) * 1.3, h: 18 });

// 자동 배치 후보 하나. 영역은 groups 순서대로 띠(가로 줄)에 왼쪽부터 채우고, 띠 폭이 maxW 를 넘으면 다음 띠.
// 영역 안 상자는 rows 줄 이하가 되는 가장 적은 칸 수로 행 우선(영역 폭이 maxW 를 넘으면 칸을 줄임). snake 면 짝수 번째 띠(둘째, 넷째)를 오른쪽부터 채운다.
// 띠는 모두 가장 넓은 띠 폭에 맞춰 영역 폭을 똑같이 늘리고, 영역 높이는 그 띠의 가장 높은 영역에 맞춘다.
function autoPlace(groups, rows, maxW, snake, gapOf = () => AUTO.ZGX, bandGap = () => AUTO.ZGAP) {
  const { PAD, HEAD, IN, GX, GY } = AUTO;
  const gs = groups.map((g) => {
    const n = g.list.length;
    // 칸 수는 영역 폭이 띠 폭 상한 maxW 안에 들도록 줄인다(줄이 rows 보다 많아짐). 그림 폭은 maxW + 2 x PAD 이하.
    const gx = g.gx || GX;
    const c = Math.max(1, Math.min(Math.ceil(n / rows), Math.floor((maxW - 2 * IN + gx) / (g.nw + gx))));
    const r = Math.max(1, Math.ceil(n / c));
    const gw = c * g.nw + (c - 1) * gx;
    return { ...g, gx, c, r, gw, w: Math.max(2 * IN + gw, g.z ? Math.ceil(textW(g.z.label) * 1.3) + 24 : 0), h: HEAD + r * g.nh + (r - 1) * GY + IN };
  });
  const bands = [];
  let cur = null;
  for (const g of gs) {
    // 영역 없는 상자 묶음은 맨 아래 띠에 혼자. 옆 영역 사이 틈은 gapOf(왼쪽 묶음, 오른쪽 묶음).
    if (!cur || !g.z || cur.w + gapOf(cur.list.at(-1), g) + g.w > maxW) bands.push((cur = { list: [], gaps: [], w: 0 }));
    const gap = cur.list.length ? gapOf(cur.list.at(-1), g) : 0;
    cur.gaps.push(gap);
    cur.list.push(g);
    cur.w += gap + g.w;
    if (!g.z) cur = null;
  }
  const W = Math.max(0, ...bands.map((b) => b.w));
  const zone = new Map();
  const node = new Map();
  const titles = [];
  let y = PAD;
  bands.forEach((b, bi) => {
    const k = b.list.length;
    const extra = W - b.w;
    const H = Math.max(...b.list.map((g) => g.h));
    let x = PAD;
    b.list.forEach((g, gi) => {
      x += b.gaps[gi];
      const w = g.w + Math.floor(extra / k) + (gi === k - 1 ? extra % k : 0);
      const zx = snake && bi % 2 ? 2 * PAD + W - x - w : x;
      if (g.z) {
        zone.set(g.z.id, { x: zx, y, w, h: H });
        titles.push(titleBand(g.z, zx, y));
      }
      const x0 = zx + Math.floor((w - g.gw) / 2);
      g.list.forEach((n, i) => node.set(n.id, { x: x0 + (i % g.c) * (g.nw + g.gx), y: y + HEAD + Math.floor(i / g.c) * (g.nh + GY), w: g.nw, h: g.nh }));
      x += w;
    });
    y += H + (bi + 1 < bands.length ? bandGap(bi) : 0);
  });
  return { auto: true, width: 2 * PAD + W, height: bands.length ? y + PAD : 2 * PAD, zone, node, titles, sig: bands.map((b) => b.list.map((g) => g.c).join(',')).join('/') };
}

// 자동 배치 연결의 길 찾기 값(px 또는 px 로 친 값).
// M: 격자점이 상자 테두리에서 떨어질 거리. SNAP: 이보다 가까운 격자선은 하나로. BEND: 꺾기 하나. CROSS: 다른 선과 엇갈림 하나.
// SHARE: 다른 선이 이미 지나는 통로를 같이 쓸 때 px 당 더하는 비율(쓰는 선 하나마다). OVER: 통로에 들어갈 나란한 선 수를 넘길 때 px 당 비율.
// TRACK: 같은 통로 나란한 선 사이. NEAR: 다른 묶음 선과 이보다 가까우면 합쳐 다시 벌림(TRACK 과 같아 따로 놓인 나란한 선도 TRACK 간격으로). KEEP: 나란한 선과 상자 사이(모자라면 HARD 까지).
// ZK: 선과 나란한 영역 테두리, 그림 가장자리 사이(늘 지킴).
// CORNER: 끝 자리와 옆면 모서리 사이. OFFW: 옆면 가운데에서 떨어진 자리 px 당 값. PORT: 같은 옆면을 이미 쓰는 연결 하나마다(같은 자리면 LINE 더).
// ARROW: 끝 선분 최소 길이(화살표). LPAD: 이름표 자리를 찾을 때 상자와 둘 여유. LGAP: 이름표와 다른 선, 영역 테두리 사이 여유.
// LROW: 이름표 있는 연결의 나란한 가로 선분 사이(이름표 높이 16 + LGAP, 이름표가 위아래로 들어감).
// ZONE: 두 끝이 속하지 않는 영역 안을 지날 때 px 당 더하는 비율. RIM: 그림 가장자리 여백이나 영역 머리 줄을 따라 달릴 때 px 당 더하는 비율.
// ZL: 이름표 있는 선과 LONG 넘는 선분이 나란한 영역 테두리에서 먼저 지킬 거리(모자라면 ZK). LBOX: 이름표와 상자 사이 여유.
const ROUTE = { M: 8, SNAP: 6, BEND: 40, CROSS: 30, SHARE: 0.5, TRACK: 12, NEAR: 12, KEEP: 10, HARD: 3, ZK: 6, OVER: 4, CORNER: 10, OFFW: 0.5, PORT: 12, LINE: 30, ARROW: 10, LPAD: 6, LGAP: 4, LROW: 20, ZONE: 1, RIM: 0.5, ZL: 12, LONG: 100, LBOX: 5 };
const BACK = [1, 0, 3, 2];

// 길 찾기 격자. 가로세로 선: 상자 가운데 선(옆면, 위아래 가운데에서 나가는 자리)과 통로 가운데(상자 옆 틈, 상자 아래 틈,
// 같은 행 이웃 상자 사이 틈, 영역 사이 틈, 영역 안 상자 묶음 둘레의 넓은 빈 곳, 그림 가장자리 여백). SNAP 보다 가까운 선은 하나만 둔다(상자 가운데 선이 먼저).
// 통로 가운데 선이 그림 가장자리 여백 가운데보다 바깥이면 버린다. 영역 테두리에 가까운 선도 남긴다(다른 띠 영역의 테두리에 가까워 이웃 상자 사이 틈 가운데 선이
// 사라지는 일이 없게). 그 테두리를 따라 가는 것은 아래 noH, noV 가 막는다.
// 영역 제목 띠를 지나는 가로선과 세로선이 없으면 띠 가운데에 하나씩 더한다.
// 격자점은 상자와 제목 띠(장애물)를 M 만큼 키운 사각형 밖일 때만 쓴다. 장애물마다 그 안을 지나는 격자선이 있으므로 이웃 격자점 둘이 모두
// 쓸 수 있으면 그 사이 선분은 장애물을 지나지 않는다.
// 영역 테두리에서 ZK 보다 가까운 격자선(상자 가운데 선 등)은 그 테두리를 따라 가지 못한다(noH, noV: 그 점에서 오른쪽, 아래로 가는 선분). 가로지르기는 된다.
// 돌려줌의 walls: 통로 폭과 나란한 선 자리를 정할 때 보는 것(상자, 제목 띠, 두께 0 의 영역 테두리 네 변).
function routeGrid(L) {
  const { PAD, GX, GY, ZGAP, ZGX } = AUTO;
  const { M, SNAP, ZK } = ROUTE;
  const boxes = [...L.node.values()];
  const titles = L.titles || [];
  const zs = [...L.zone.values()];
  const borders = zs.flatMap((z) => [{ x: z.x, y: z.y, w: z.w, h: 0 }, { x: z.x, y: z.y + z.h, w: z.w, h: 0 }, { x: z.x, y: z.y, w: 0, h: z.h }, { x: z.x + z.w, y: z.y, w: 0, h: z.h }]);
  const cx = boxes.map((r) => r.x + r.w / 2);
  const cy = boxes.map((r) => r.y + r.h / 2);
  const xs = [PAD / 2, L.width - PAD / 2];
  const ys = [PAD / 2, L.height - PAD / 2];
  for (const r of boxes) xs.push(r.x - GX / 2, r.x + r.w + GX / 2), ys.push(r.y + r.h + GY / 2);
  // 같은 행 이웃 상자 사이 틈 가운데(영역마다 상자 사이 가로 간격이 다름).
  for (const r of boxes) {
    const o = boxes.filter((b) => b.y === r.y && b.x > r.x).sort((p, q) => p.x - q.x)[0];
    if (o && o.x - r.x - r.w <= 2 * GX) xs.push((r.x + r.w + o.x) / 2);
  }
  for (const z of L.zone.values()) {
    // 같은 띠 오른쪽 이웃 영역과의 틈 가운데(틈이 ZGX 보다 넓을 때 이름표가 들어가는 자리).
    const right = zs.filter((o) => o.y === z.y && o.x > z.x).sort((p, q) => p.x - q.x)[0];
    if (right) xs.push((z.x + z.w + right.x) / 2);
    xs.push(z.x - ZGX / 2, z.x + z.w + ZGX / 2);
    ys.push(z.y - ZGAP / 2, z.y + z.h + ZGAP / 2);
    const inn = boxes.filter((r) => r.x >= z.x && r.x + r.w <= z.x + z.w && r.y >= z.y && r.y + r.h <= z.y + z.h);
    if (!inn.length) continue;
    const x0 = Math.min(...inn.map((r) => r.x));
    const x1 = Math.max(...inn.map((r) => r.x + r.w));
    const y1 = Math.max(...inn.map((r) => r.y + r.h));
    if (x0 - z.x >= 3 * M) xs.push((z.x + x0) / 2);
    if (z.x + z.w - x1 >= 3 * M) xs.push((x1 + z.x + z.w) / 2);
    if (z.y + z.h - y1 >= 3 * M) ys.push((y1 + z.y + z.h) / 2);
  }
  const lines = (centers, more, max, bands) => {
    const keep = [];
    for (const v of [...new Set(centers)].sort((a, b) => a - b)) if (!keep.length || v - keep.at(-1) >= SNAP) keep.push(v);
    const out = [...keep];
    for (const v of [...new Set(more)].sort((a, b) => a - b)) if (v >= PAD / 2 && v <= max - PAD / 2 && !out.some((k) => Math.abs(k - v) < SNAP)) out.push(v);
    for (const [b0, b1] of bands) if (!out.some((v) => v > b0 && v < b1)) out.push((b0 + b1) / 2);
    return out.sort((a, b) => a - b);
  };
  const X = lines(cx, xs, L.width, titles.map((t) => [t.x, t.x + t.w]));
  const Y = lines(cy, ys, L.height, titles.map((t) => [t.y, t.y + t.h]));
  const nx = X.length;
  const ok = new Uint8Array(nx * Y.length).fill(1);
  for (const r of [...boxes, ...titles]) {
    for (let j = 0; j < Y.length; j++) {
      if (Y[j] <= r.y - M || Y[j] >= r.y + r.h + M) continue;
      for (let i = 0; i < nx; i++) if (X[i] > r.x - M && X[i] < r.x + r.w + M) ok[j * nx + i] = 0;
    }
  }
  const noH = new Uint8Array(nx * Y.length);
  const noV = new Uint8Array(nx * Y.length);
  const near = (v, a, b) => Math.abs(v - a) < ZK || Math.abs(v - b) < ZK;
  for (const z of zs) {
    for (let j = 0; j < Y.length; j++) if (near(Y[j], z.y, z.y + z.h)) for (let i = 0; i + 1 < nx; i++) if (X[i + 1] > z.x && X[i] < z.x + z.w) noH[j * nx + i] = 1;
    for (let i = 0; i < nx; i++) if (near(X[i], z.x, z.x + z.w)) for (let j = 0; j + 1 < Y.length; j++) if (Y[j + 1] > z.y && Y[j] < z.y + z.h) noV[j * nx + i] = 1;
  }
  return { X, Y, nx, ny: Y.length, ok, noH, noV, boxes, walls: [...boxes, ...titles, ...borders], titles, borders };
}

// 끝(상자나 영역)에서 나가는 자리. 옆면을 지나는 격자선마다(모서리에서 CORNER 안쪽). 상자는 옆면 가운데(가장 가까운 격자선)도 넣고,
// 가운데에서 떨어진 만큼 값(OFFW)을 더한다. 자리에서 바깥으로 곧게 가서 만나는 첫 격자점까지가 첫 선분.
// 그 점을 다른 상자가 막으면 그 자리는 쓰지 않는다. 돌려줌 [{ p: [x, y], d: 바깥 방향(0 +x, 1 -x, 2 +y, 3 -y), n: 격자점, len: 값 }].
function routePorts(G, r, isZone) {
  const { X, Y, nx, ok } = G;
  const { M, SNAP, CORNER } = ROUTE;
  const out = [];
  const seen = new Set();
  const add = (px, py, d, mid) => {
    const horiz = d < 2;
    const line = horiz ? X : Y;
    const cross = horiz ? Y : X;
    const want = horiz ? py : px;
    let j = -1;
    cross.forEach((v, k) => {
      if (Math.abs(v - want) < SNAP && (j < 0 || Math.abs(v - want) < Math.abs(cross[j] - want))) j = k;
    });
    if (j < 0 || seen.has(d * 1e6 + j)) return;
    seen.add(d * 1e6 + j);
    const p = horiz ? [px, cross[j]] : [cross[j], py];
    const at = horiz ? px : py;
    const step = d % 2 ? -1 : 1;
    let i = step > 0 ? line.findIndex((v) => v > at) : line.findLastIndex((v) => v < at);
    for (; i >= 0 && i < line.length; i += step) {
      const n = horiz ? j * nx + i : i * nx + j;
      // 첫 선분은 화살표가 들어가게 ARROW 이상. 자기 상자를 M 만큼 키운 띠 안이거나 ARROW 보다 가까우면 더 나가 본다.
      // 다른 상자가 막으면 이 자리는 버린다.
      const far = Math.abs(line[i] - at);
      if (ok[n] && far >= ROUTE.ARROW) return void out.push({ p, d, n, len: far + (mid === undefined ? 0 : Math.abs(cross[j] - mid) * ROUTE.OFFW) });
      if (!ok[n] && (isZone || far >= M)) return;
    }
  };
  if (!isZone) {
    for (const [d, at, cross, s0, len] of [[0, r.x + r.w, Y, r.y, r.h], [1, r.x, Y, r.y, r.h], [2, r.y + r.h, X, r.x, r.w], [3, r.y, X, r.x, r.w]]) {
      const mid = s0 + len / 2;
      for (const v of [mid, ...cross.filter((v) => v >= s0 + CORNER && v <= s0 + len - CORNER)]) (d < 2 ? add(at, v, d, mid) : add(v, at, d, mid));
    }
    return out;
  }
  const free = (x, y) => !G.boxes.some((b) => x > b.x - M && x < b.x + b.w + M && y > b.y - M && y < b.y + b.h + M);
  for (const x of X) {
    if (x < r.x + CORNER || x > r.x + r.w - CORNER) continue;
    if (free(x, r.y + r.h)) add(x, r.y + r.h, 2);
    if (free(x, r.y)) add(x, r.y, 3);
  }
  for (const y of Y) {
    if (y < r.y + CORNER || y > r.y + r.h - CORNER) continue;
    if (free(r.x + r.w, y)) add(r.x + r.w, y, 0);
    if (free(r.x, y)) add(r.x, y, 1);
  }
  return out;
}

// 자동 배치 연결의 길(렌더와 check 가 같이 씀). 돌려줌 Map(연결 → 점 목록). 모든 선분은 가로나 세로이고, 두 끝이 아닌 상자는 지나지 않는다.
// 1) 짧은 연결부터 하나씩 격자 위 가장 값이 작은 길(A*). 값: 길이 + 꺾기 x BEND + 다른 선과 엇갈림 x CROSS
//    + 이미 다른 선이 지나는 통로 길이 x SHARE x 그 선 수 + 나란한 선 자리가 찬 통로 길이 x OVER + 같은 옆면(자리)을 쓰는 연결 수 x PORT(LINE)
//    + 두 끝이 속하지 않는 영역 안 길이 x ZONE + 그림 가장자리 여백과 영역 머리 줄을 따라 가는 길이 x RIM.
//    같은 값이면 먼저 넣은 길(결과가 늘 같음).
//    이름표가 있는 연결은 이름표가 상자와 겹치지 않고 놓이는 곧은 구간을 지나는 길만 고른다(그런 길이 없으면 조건 없이).
// 2) 같은 방향 선분이 겹치거나 가까우면 나란한 선(TRACK 간격)으로 벌린다(routeTracks).
// 길을 찾지 못하면(막힌 끝) 한 번 꺾은 선. 시험은 직접 부른다.
export function autoRoutes(L, edges) {
  const G = routeGrid(L);
  const { X, Y, nx, ny, ok, noH, noV, boxes } = G;
  const { LGAP } = ROUTE;
  const N = nx * ny;
  const S = N * 8;
  const passH = new Uint8Array(N);
  const passV = new Uint8Array(N);
  // 통로 칸: 이웃 격자점 사이 선분마다 양옆에서 가장 가까운 벽(상자, 제목 띠, 영역 테두리) 면 사이(같은 구간, 같은 두 면이면 격자선이 달라도 같은 통로).
  // 통로마다 지나는 선 수(use)와 들어갈 나란한 선 수(cap: 폭에서 KEEP 두 번을 뺀 폭 / TRACK + 1).
  const xy = (n) => [X[n % nx], Y[Math.floor(n / nx)]];
  const corH = new Int32Array(N).fill(-1);
  const corV = new Int32Array(N).fill(-1);
  const corId = new Map();
  const use = [];
  const cap = [];
  for (const [cor, step, along, max] of [[corH, 1, X, L.height], [corV, nx, Y, L.width]]) {
    const h = step === 1;
    // 구간(이웃 격자선 사이)마다 겹치는 상자의 가로지르는 쪽 범위 [d0, d1].
    const spans = along.slice(1).map((v, i) => G.walls.filter((b) => (h ? b.x + b.w > along[i] + 0.5 && b.x < v - 0.5 : b.y + b.h > along[i] + 0.5 && b.y < v - 0.5)).map((b) => (h ? [b.y, b.y + b.h] : [b.x, b.x + b.w])));
    for (let n = 0; n < N; n++) {
      const m = n + step;
      if (!ok[n] || m >= N || !ok[m] || (h && m % nx === 0)) continue;
      const [i0, c] = h ? [n % nx, Y[Math.floor(n / nx)]] : [Math.floor(n / nx), X[n % nx]];
      let lo = 0;
      let hi = max;
      for (const [d0, d1] of spans[i0]) {
        if (d1 <= c) lo = Math.max(lo, d1);
        else if (d0 >= c) hi = Math.min(hi, d0);
      }
      const key = `${step}:${i0}:${lo}:${hi}`;
      if (!corId.has(key)) {
        corId.set(key, use.length);
        use.push(0);
        cap.push(Math.max(1, Math.floor((hi - lo - 2 * ROUTE.KEEP) / ROUTE.TRACK) + 1));
      }
      cor[n] = corId.get(key);
    }
  }
  // 격자 선분(이웃 격자점 사이)마다 가운데가 든 영역 번호(zoneH, zoneV, 없으면 -1)와 가장자리 띠인지(nearH, nearV).
  // 가장자리 띠: 그림 가장자리에서 PAD 안(영역 바깥 여백), 가로 선분은 영역 머리(영역 위 테두리에서 HEAD 안, 영역 이름 줄)도.
  const zs = [...L.zone.values()];
  const inZone = (x, y) => zs.findIndex((z) => x > z.x && x < z.x + z.w && y > z.y && y < z.y + z.h);
  const zoneH = new Int16Array(N).fill(-1);
  const zoneV = new Int16Array(N).fill(-1);
  const nearH = new Uint8Array(N);
  const nearV = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    const [x, y] = xy(n);
    if (n % nx + 1 < nx) {
      const mx = (x + X[n % nx + 1]) / 2;
      zoneH[n] = inZone(mx, y);
      nearH[n] = y < AUTO.PAD || y > L.height - AUTO.PAD || zs.some((z) => mx > z.x && mx < z.x + z.w && y > z.y && y < z.y + AUTO.HEAD) ? 1 : 0;
    }
    if (n + nx < N) {
      const my = (y + Y[Math.floor(n / nx) + 1]) / 2;
      zoneV[n] = inZone(x, my);
      nearV[n] = x < AUTO.PAD || x > L.width - AUTO.PAD ? 1 : 0;
    }
  }
  // 끝(상자, 영역) 옆면마다, 그 옆면의 자리(격자선)마다 이미 쓰는 연결 수.
  const sideUse = new Map();
  const sideKeys = (p) => [p.d, `${p.d}:${p.d < 2 ? p.p[1] : p.p[0]}`];
  const sideCost = (r, p) => {
    const u = sideUse.get(r);
    if (!u) return 0;
    const [side, line] = sideKeys(p);
    return (u.get(side) || 0) * ROUTE.PORT + (u.get(line) || 0) * ROUTE.LINE;
  };
  const sideAdd = (r, p) => {
    if (!sideUse.has(r)) sideUse.set(r, new Map());
    const u = sideUse.get(r);
    for (const k of sideKeys(p)) u.set(k, (u.get(k) || 0) + 1);
  };
  const dist = new Float64Array(S);
  const prev = new Int32Array(S);
  const mark = new Uint32Array(S);
  let stamp = 0;
  const next = (n, d) => {
    const i = n % nx;
    if (d === 0) return i + 1 < nx ? n + 1 : -1;
    if (d === 1) return i > 0 ? n - 1 : -1;
    if (d === 2) return n + nx < N ? n + nx : -1;
    return n - nx >= 0 ? n - nx : -1;
  };
  // 상태 = (격자점 x 4 + 방향) x 2 + 이름표 자리를 지났는지. 끝 자리 도착은 상태 S + 자리 번호.
  const search = (a, b, starts, goals, lw, own) => {
    const need = lw > 0;
    const fitMemo = new Map();
    // 격자점 n 을 방향 d 로 곧게 지날 때 이름표(가운데가 n, 그림 안으로 민 자리)가 상자와 겹치지 않고 영역 테두리에서 LGAP 떨어지는지.
    // 선을 나란히 벌리면 선분과 수직으로 움직이므로 상자는 그 방향만 LPAD 여유, 선분 방향은 1 px.
    const fits = (n, d) => {
      const key = n * 2 + (d < 2 ? 1 : 0);
      if (fitMemo.has(key)) return fitMemo.get(key);
      const [x0, y0] = xy(n);
      const x = Math.min(Math.max(x0, lw / 2 + 1), L.width - lw / 2 - 1);
      const [px, py] = d < 2 ? [1, ROUTE.LPAD] : [ROUTE.LPAD, 1];
      const r = { x: x - lw / 2 - px, y: y0 - 8 - py, w: lw + 2 * px, h: 16 + 2 * py };
      const rb = { x: x - lw / 2 - LGAP, y: y0 - 8 - LGAP, w: lw + 2 * LGAP, h: 16 + 2 * LGAP };
      const v = !boxes.some((q) => hits(r, q, 0)) && !G.borders.some((q) => q.x + q.w > rb.x && q.x < rb.x + rb.w && q.y + q.h > rb.y && q.y < rb.y + rb.h);
      fitMemo.set(key, v);
      return v;
    };
    const h = (n) => {
      const [x, y] = xy(n);
      return Math.max(0, b.x - x, x - b.x - b.w) + Math.max(0, b.y - y, y - b.y - b.h);
    };
    const goalAt = new Map();
    goals.forEach((g, k) => goalAt.set(g.n, [...(goalAt.get(g.n) || []), k]));
    stamp++;
    // 힙: [f, 넣은 차례, 상태, g]. f 가 같으면 먼저 넣은 것.
    const heap = [];
    let seq = 0;
    const less = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);
    const push = (f, s, g) => {
      const v = [f, seq++, s, g];
      let k = heap.push(v) - 1;
      while (k) {
        const pk = (k - 1) >> 1;
        if (!less(v, heap[pk])) break;
        heap[k] = heap[pk];
        k = pk;
      }
      heap[k] = v;
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          if (l >= heap.length) break;
          const c = l + 1 < heap.length && less(heap[l + 1], heap[l]) ? l + 1 : l;
          if (!less(heap[c], last)) break;
          heap[k] = heap[c];
          k = c;
        }
        heap[k] = last;
      }
      return top;
    };
    const relax = (s, g, from) => {
      if (mark[s] === stamp && dist[s] <= g) return false;
      mark[s] = stamp;
      dist[s] = g;
      prev[s] = from;
      push(g + h(s >> 3), s, g);
      return true;
    };
    const startOf = new Map();
    for (const p of starts) if (relax((p.n * 4 + p.d) * 2 + (need ? 0 : 1), p.len + sideCost(a, p), -1)) startOf.set((p.n * 4 + p.d) * 2 + (need ? 0 : 1), p);
    const goalG = new Map();
    while (heap.length) {
      const [, , s, g] = pop();
      if (s >= S) {
        const states = [];
        for (let t = goalG.get(s).from; t >= 0; t = prev[t]) states.push(t);
        return { states: states.reverse(), goal: goals[s - S], startOf };
      }
      if (dist[s] !== g || mark[s] !== stamp) continue;
      const n = s >> 3;
      const d = (s >> 1) & 3;
      const f = s & 1;
      for (const k of goalAt.get(n) || []) {
        const q = goals[k];
        const straight = BACK[q.d] === d;
        // 끝 자리 쪽에서 오는 길(되돌아 겹치는 선)은 쓰지 않는다.
        if (q.d === d || (!f && !(straight && fits(n, d)))) continue;
        const gg = g + q.len + sideCost(b, q) + (straight ? 0 : ROUTE.BEND);
        const gs = S + k;
        if (!goalG.has(gs) || goalG.get(gs).g > gg) {
          goalG.set(gs, { g: gg, from: s });
          push(gg, gs, gg);
        }
      }
      for (let nd = 0; nd < 4; nd++) {
        if (nd === BACK[d]) continue;
        const m = next(n, nd);
        const horiz = nd < 2;
        if (m < 0 || !ok[m] || (horiz ? noH : noV)[Math.min(n, m)]) continue;
        const len = horiz ? Math.abs(X[m % nx] - X[n % nx]) : Math.abs(Y[Math.floor(m / nx)] - Y[Math.floor(n / nx)]);
        const k = Math.min(n, m);
        const c = (horiz ? corH : corV)[k];
        const zi = (horiz ? zoneH : zoneV)[k];
        const extra = (zi >= 0 && !own.includes(zi) ? ROUTE.ZONE : 0) + ((horiz ? nearH : nearV)[k] ? ROUTE.RIM : 0);
        const cost = len * (1 + extra + ROUTE.SHARE * use[c] + (use[c] >= cap[c] ? ROUTE.OVER : 0)) + (nd === d ? 0 : ROUTE.BEND) + ((horiz ? passV[m] : passH[m]) ? ROUTE.CROSS : 0);
        const nf = f || (nd === d && fits(n, d)) ? 1 : 0;
        relax((m * 4 + nd) * 2 + nf, g + cost, s);
      }
    }
    return null;
  };
  const list = [];
  edges.forEach((e, i) => {
    const za = !L.node.has(e.from);
    const zb = !L.node.has(e.to);
    const a = za ? L.zone.get(e.from) : L.node.get(e.from);
    const b = zb ? L.zone.get(e.to) : L.node.get(e.to);
    if (!a || !b) return;
    const d = Math.abs(a.x + a.w / 2 - b.x - b.w / 2) + Math.abs(a.y + a.h / 2 - b.y - b.h / 2);
    list.push({ e, i, a, b, za, zb, d });
  });
  list.sort((p, q) => p.d - q.d || p.i - q.i);
  const found = [];
  for (const it of list) {
    const { a, b } = it;
    let pts = null;
    if (a !== b) {
      const starts = routePorts(G, a, it.za);
      const goals = routePorts(G, b, it.zb);
      const lw = it.e.label ? textW(it.e.label) + 10 : 0;
      // 두 끝이 속한 영역(영역 끝은 그 영역, 상자는 가운데가 든 영역).
      const own = [[a, it.za], [b, it.zb]].map(([r, z]) => (z ? zs.indexOf(r) : inZone(r.x + r.w / 2, r.y + r.h / 2)));
      const got = (lw && search(a, b, starts, goals, lw, own)) || search(a, b, starts, goals, 0, own);
      if (got) {
        const { states } = got;
        const nodes = states.map((s) => s >> 3);
        for (let k = 0; k < nodes.length; k++) {
          const n = nodes[k];
          if (k) {
            const p = nodes[k - 1];
            use[(Math.abs(n - p) === 1 ? corH : corV)[Math.min(n, p)]]++;
          }
          for (const t of [states[k], states[k + 1]]) if (t !== undefined) ((t >> 1) & 3) < 2 ? (passH[n] = 1) : (passV[n] = 1);
        }
        const sp = got.startOf.get(states[0]);
        sideAdd(a, sp);
        sideAdd(b, got.goal);
        pts = [sp.p, ...nodes.map(xy), got.goal.p];
      }
    }
    if (!pts) pts = pathOf(a, b, [[b.x + b.w / 2, a.y + a.h / 2]], 0, 0);
    // 같은 직선 위 가운데 점은 뺀다.
    pts = pts.filter((p, k) => {
      if (!k || k === pts.length - 1) return true;
      const [o, q] = [pts[k - 1], pts[k + 1]];
      return !((o[0] === p[0] && p[0] === q[0]) || (o[1] === p[1] && p[1] === q[1]));
    });
    found.push({ e: it.e, i: it.i, pts, a, b });
  }
  found.sort((p, q) => p.i - q.i);
  routeTracks(L, G, found);
  return new Map(found.map((r) => [r.e, r.pts]));
}

// 나란한 선 벌리기. 같은 방향 선분 가운데 구간이 겹치거나 TRACK 보다 가까운 것끼리 묶어 묶음마다 나란한 자리(TRACK 간격)를 정한다.
// 처음 묶음은 같은 격자선 위 선분. 벌린 뒤 다른 묶음의 선분과 NEAR 보다 가까워지면 두 묶음을 합쳐 다시 정한다.
// 선분 하나뿐인 묶음도 자리 범위 안으로 옮긴다(격자선이 상자에서 KEEP 안이거나 영역 테두리에서 ZL 안이면).
// 묶음 안 차례: 원래 줄 좌표, 다음에 먼저 끝나는 쪽 끝에서 꺾는 방향(위나 왼쪽으로 꺾으면 앞 자리), 늦게 시작하는 쪽 끝에서 오는 방향, 연결 차례.
// 자리 범위와 간격은 아래 bounds, place.
function routeTracks(L, G, routes) {
  const { TRACK, KEEP, HARD, CORNER, ZK } = ROUTE;
  const { boxes } = G;
  const walls = [...boxes, ...G.titles];
  const all = [];
  for (const r of routes) {
    r.pts = r.pts.map((p) => [...p]);
    const P = r.pts;
    for (let k = 0; k + 1 < P.length; k++) {
      const h = P[k][1] === P[k + 1][1];
      if (!h && P[k][0] !== P[k + 1][0]) continue;
      const ax = h ? 0 : 1;
      const c = P[k][1 - ax];
      const [u, v] = [P[k][ax], P[k + 1][ax]];
      // 선분 끝에서 꺾는 방향: 이웃 점이 이 줄의 어느 쪽인지. 끝 자리(상자, 영역)는 0.
      const side = (q) => (q ? Math.sign(q[1 - ax] - c) : 0);
      const [sU, sV] = [side(P[k - 1]), side(P[k + 2])];
      all.push({ r, k, h, c, pos: c, lo: Math.min(u, v), hi: Math.max(u, v), sLo: u <= v ? sU : sV, sHi: u <= v ? sV : sU, first: k === 0, last: k + 2 === P.length });
    }
  }
  const cmp = (a, b) => {
    if (a.c !== b.c) return a.c - b.c;
    let v = 0;
    if (a.hi < b.hi - 0.5) v += a.sHi;
    else if (b.hi < a.hi - 0.5) v -= b.sHi;
    else v += a.sHi - b.sHi;
    if (a.lo > b.lo + 0.5) v += a.sLo;
    else if (b.lo > a.lo + 0.5) v -= b.sLo;
    else v += a.sLo - b.sLo;
    return v || a.r.i - b.r.i || a.k - b.k;
  };
  const near = (a, b) => a.lo < b.hi + TRACK && b.lo < a.hi + TRACK;
  // 처음 묶음: 같은 줄에서 구간이 이어지는 선분.
  const groups = [];
  const byLine = new Map();
  for (const s of all) {
    const key = (s.h ? 'h' : 'v') + s.c;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(s);
  }
  for (const segs of byLine.values()) {
    segs.sort((a, b) => a.lo - b.lo || a.r.i - b.r.i || a.k - b.k);
    let hi = -Infinity;
    for (const s of segs) {
      if (s.lo >= hi + TRACK) groups.push({ segs: [] });
      s.g = groups.at(-1);
      s.g.segs.push(s);
      hi = Math.max(hi, s.hi);
    }
  }
  // 선분 하나의 자리 범위: 그 선분 구간과 1 px 넘게 겹치는 상자와 제목 띠에서 keep 안쪽(끝 선분이 이어지는 끝 상자나 영역은 ARROW 이상),
  // 나란한 영역 테두리와 그림 가장자리에서 ZK 안쪽, 끝 자리가 상자나 영역 옆면이면 모서리에서 CORNER 안쪽.
  const bounds = (s, keep, zk) => {
    const ax = s.h ? 1 : 0;
    let lo = ZK;
    let hi = (s.h ? L.height : L.width) - ZK;
    const ends = [s.k === 1 ? s.r.a : null, s.k + 3 === s.r.pts.length ? s.r.b : null];
    const lim = (b, k) => {
      const [b0, b1, d0, d1] = s.h ? [b.x, b.x + b.w, b.y, b.y + b.h] : [b.y, b.y + b.h, b.x, b.x + b.w];
      if (b1 <= s.lo + 0.5 || b0 >= s.hi - 0.5) return;
      if (d1 <= s.c + 0.5) lo = Math.max(lo, d1 + k);
      else if (d0 >= s.c - 0.5) hi = Math.min(hi, d0 - k);
    };
    // 이름표 있는 가로 선분은 먼저(zk) 상자에서 이름표 반 높이 + LBOX 이상(이름표가 상자에서 LBOX 떨어짐).
    const k0 = zk && s.h && s.r.e.label ? Math.max(keep, 8 + ROUTE.LBOX) : keep;
    for (const b of [...walls, ...ends.filter((e) => e && !boxes.includes(e))]) lim(b, ends.includes(b) ? Math.max(k0, ROUTE.ARROW) : k0);
    for (const b of G.borders) lim(b, zk && (s.r.e.label || s.hi - s.lo > ROUTE.LONG) ? ROUTE.ZL : ZK);
    for (const [on, box] of [[s.first, s.r.a], [s.last, s.r.b]]) {
      if (!on) continue;
      const [b0, b1] = ax ? [box.y, box.y + box.h] : [box.x, box.x + box.w];
      lo = Math.max(lo, b0 + CORNER);
      hi = Math.min(hi, b1 - CORNER);
    }
    return [lo, hi];
  };
  // 묶음 자리: 차례대로 간격 gap 이상, 선분마다 자리 범위 안. 원래 줄 가운데에 가깝게 놓고(앞으로 밀기, 뒤로 당기기)
  // 범위를 못 맞추면 아래 차례로 푼다: 이름표 있는 연결의 가로 선분끼리 이웃이면 LROW(이름표 높이 + LGAP), 나머지 TRACK 에 상자 거리 KEEP,
  // 간격 TRACK 에 상자 거리 KEEP, 간격 TRACK - 1..6 에 상자 거리 KEEP, 간격 TRACK..6 에 상자 거리 6, 간격 5..4 에 KEEP, 6, 마지막으로 간격 TRACK..HARD 에 상자 거리 HARD.
  // 단계마다 먼저 이름표 있는 선과 LONG 넘는 선분을 나란한 영역 테두리에서 ZL, 이름표 있는 가로 선분을 상자에서 8 + LBOX 떨어뜨려 보고, 안 되면 ZK 와 위 상자 거리로.
  // 끝내 못 맞추면 원래 줄에 둔다.
  const place = (g) => {
    const segs = g.segs.sort(cmp);
    const n = segs.length;
    if (!n) return;
    const c0 = Math.min(...segs.map((s) => s.c));
    const c1 = Math.max(...segs.map((s) => s.c));
    const lab = segs.map((s) => Boolean(s.h && s.r.e.label));
    const tiers = [[KEEP, TRACK, TRACK, ROUTE.LROW], [KEEP, TRACK, TRACK, 0], [KEEP, TRACK - 1, 6, 0], [6, TRACK, 6, 0], [KEEP, 5, 4, 0], [6, 5, 4, 0], [HARD, TRACK, HARD, 0]];
    for (const [keep, g0, g1, lg, zk] of tiers.flatMap((t) => [[...t, true], [...t, false]])) {
      if (lg && !lab.some((v, t) => v && lab[t - 1])) continue;
      const bs = segs.map((s) => bounds(s, keep, zk));
      for (let gap = g0; gap >= g1; gap--) {
        const at = (t) => (lg && lab[t - 1] && lab[t] ? Math.max(gap, lg) : gap);
        const off = [0];
        for (let t = 1; t < n; t++) off.push(off[t - 1] + at(t));
        const p = segs.map((_, t) => (c0 + c1) / 2 + off[t] - off[n - 1] / 2);
        for (let t = 0; t < n; t++) p[t] = Math.max(p[t], bs[t][0], t ? p[t - 1] + at(t) : -Infinity);
        for (let t = n - 1; t >= 0; t--) p[t] = Math.min(p[t], bs[t][1], t < n - 1 ? p[t + 1] - at(t + 1) : Infinity);
        if (p.every((v, t) => v >= bs[t][0] - 1e-9)) return void segs.forEach((s, t) => (s.pos = p[t]));
      }
    }
    segs.forEach((s) => (s.pos = s.c));
  };
  groups.forEach(place);
  // 다른 묶음과 가까워진 선분이 있으면 두 묶음을 합쳐 다시 정한다. 묶음 수가 줄 때만 되풀이하므로 끝난다.
  for (let round = 0; round < all.length; round++) {
    let merged = false;
    for (const h of [true, false]) {
      const segs = all.filter((s) => s.h === h).sort((a, b) => a.pos - b.pos || a.r.i - b.r.i || a.k - b.k);
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length && segs[j].pos - segs[i].pos < ROUTE.NEAR; j++) {
          const [a, b] = [segs[i], segs[j]];
          if (a.g === b.g || a.r === b.r || !near(a, b)) continue;
          const keep = a.g;
          const gone = b.g;
          for (const s of gone.segs) {
            s.g = keep;
            keep.segs.push(s);
          }
          gone.segs = [];
          place(keep);
          merged = true;
        }
      }
    }
    if (!merged) break;
  }
  for (const s of all) {
    const ax = s.h ? 1 : 0;
    s.r.pts[s.k][ax] = s.pos;
    s.r.pts[s.k + 1][ax] = s.pos;
  }
}

// 자동 배치 선의 길이 합, 엇갈림 수(다른 연결의 가로 선분과 세로 선분이 두 선분 안쪽에서 만남), 두 끝이 속하지 않는 영역 안 길이,
// 좁은 나란한 선 쌍 수, 테두리 붙은 긴 선분 수. 배치 고르기 값.
function routeSum(routes, L) {
  let len = 0;
  let foreign = 0;
  const hs = [];
  const vs = [];
  let id = 0;
  const zs = [...L.zone.values()];
  const inZone = (r) => zs.find((z) => r.x >= z.x && r.y >= z.y && r.x + r.w <= z.x + z.w && r.y + r.h <= z.y + z.h);
  // 구간 [a0, a1](순서 무관)과 [b0, b1] 의 겹친 길이.
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(Math.max(a0, a1), b1) - Math.max(Math.min(a0, a1), b0));
  for (const [e, pts] of routes) {
    id++;
    const own = [e.from, e.to].map((k) => L.zone.get(k) || (L.node.has(k) ? inZone(L.node.get(k)) : null));
    for (let k = 1; k < pts.length; k++) {
      const [p, q] = [pts[k - 1], pts[k]];
      len += Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
      for (const z of zs) {
        if (own.includes(z)) continue;
        if (p[1] === q[1] && p[1] > z.y && p[1] < z.y + z.h) foreign += ov(p[0], q[0], z.x, z.x + z.w);
        else if (p[0] === q[0] && p[0] > z.x && p[0] < z.x + z.w) foreign += ov(p[1], q[1], z.y, z.y + z.h);
      }
      if (p[1] === q[1]) hs.push([id, p[1], Math.min(p[0], q[0]), Math.max(p[0], q[0])]);
      else if (p[0] === q[0]) vs.push([id, p[0], Math.min(p[1], q[1]), Math.max(p[1], q[1])]);
    }
  }
  let cross = 0;
  for (const h of hs) for (const v of vs) if (h[0] !== v[0] && v[1] > h[2] && v[1] < h[3] && h[1] > v[2] && h[1] < v[3]) cross++;
  // 좁은 나란한 선: 다른 연결의 같은 방향 선분이 20 px 넘게 함께 달리며 TRACK 보다 가까운 쌍.
  // 테두리 붙은 긴 선: LONG 넘게 나란한 영역 테두리에서 ZL 안을 달리는 선분.
  let tight = 0;
  for (const list of [hs, vs]) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      if (a[0] !== b[0] && Math.abs(a[1] - b[1]) < ROUTE.TRACK && Math.min(a[3], b[3]) - Math.max(a[2], b[2]) > 20) tight++;
    }
  }
  let hug = 0;
  for (const [list, h] of [[hs, true], [vs, false]]) {
    for (const [, c, lo, hi] of list) {
      for (const z of zs) {
        const [b0, b1, l0, l1] = h ? [z.x, z.x + z.w, z.y, z.y + z.h] : [z.y, z.y + z.h, z.x, z.x + z.w];
        if (Math.min(hi, b1) - Math.max(lo, b0) > ROUTE.LONG && (Math.abs(c - l0) < ROUTE.ZL || Math.abs(c - l1) < ROUTE.ZL)) hug++;
      }
    }
  }
  return { len, cross, foreign, tight, hug };
}

// 자동 배치 선이 지나는 틈 가운데 나란한 선이 들어가지 않는 틈의 필요한 폭. 같은 띠 옆 영역 사이 틈(키: 두 영역 id)은 그 틈을 지나는 세로 선분,
// 띠 사이 틈(키: 'band' + 위 띠 번호)은 가로 선분을 구간이 이어지는 묶음(나란한 선 벌리기와 같은 묶음)으로 나눠 가장 큰 묶음의 선 수 n 으로
// (n - 1) x TRACK + 2 x ZL. 지금 틈보다 넓을 때만 넣는다.
function roomNeed(L, routes, key) {
  const need = new Map();
  const segs = [...routes.values()].flatMap((pts) => pts.slice(1).map((q, k) => [pts[k], q]));
  // 가로(h)나 세로 선분 가운데 줄 좌표가 (a0, a1) 안이고 구간이 (b0, b1) 와 겹치는 것의 가장 큰 묶음 크기.
  const most = (h, a0, a1, b0 = -Infinity, b1 = Infinity) => {
    const on = segs
      .filter(([p, q]) => (h ? p[1] === q[1] : p[0] === q[0]) && (h ? p[1] : p[0]) > a0 && (h ? p[1] : p[0]) < a1)
      .map(([p, q]) => (h ? [Math.min(p[0], q[0]), Math.max(p[0], q[0])] : [Math.min(p[1], q[1]), Math.max(p[1], q[1])]))
      .filter(([l, u]) => u > b0 && l < b1)
      .sort((p, q) => p[0] - q[0]);
    let n = 0;
    let k = 0;
    let hi = -Infinity;
    for (const [l, u] of on) {
      k = l < hi + ROUTE.TRACK ? k + 1 : 1;
      hi = k === 1 ? u : Math.max(hi, u);
      n = Math.max(n, k);
    }
    return n;
  };
  const room = (n) => (n - 1) * ROUTE.TRACK + 2 * ROUTE.ZL;
  const zs = [...L.zone.entries()];
  for (const [id, z] of zs) {
    const right = zs.filter(([, o]) => o.y === z.y && o.x > z.x).sort((p, q) => p[1].x - q[1].x)[0];
    if (!right) continue;
    const [x0, x1] = [z.x + z.w, right[1].x];
    const r = room(most(false, x0, x1, z.y, z.y + z.h));
    if (r > x1 - x0) need.set(key(id, right[0]), r);
  }
  const ys = [...new Set(zs.map(([, z]) => z.y))].sort((a, b) => a - b);
  ys.slice(1).forEach((y1, bi) => {
    const y0 = Math.max(...zs.filter(([, z]) => z.y === ys[bi]).map(([, z]) => z.y + z.h));
    const r = room(most(true, y0, y1));
    if (r > y1 - y0) need.set('band' + bi, r);
  });
  return need;
}

// 구성도 배치(렌더와 check 가 같이 씀). 좌표가 모두 맞으면 그대로, 하나라도 빠지거나 틀리면 그림 전체 자동 배치:
// 후보(영역과 상자 순서, 영역 안 줄 수 상한, 띠 폭 상한, 띠 방향)마다 autoPlace 로 놓고, 아래 한계가 작은 TRY 개만 autoRoutes 로 그어 하나를 고른다.
// 고르는 기준(앞이 같을 때만 다음): 상자가 MANY 개 이상이면 가로세로 비 RATIO 이상, 값(높이 + WARN 수 x WARN_PX + 선 길이 합 x LEN
// + 엇갈림 수 x CROSS + 붐비는 이름표 수 x CROWD + 다른 영역 안 길이 x FOREIGN + (좁은 나란한 선 쌍 + 테두리 붙은 긴 선분) x TIGHT)이 가장 작음, 먼저 만든 후보.
// 고른 후보는 나란한 선이 모자란 틈(roomNeed)과 이름표가 상자에 붙는 같은 행 이웃 상자 사이를 넓혀 한 번 더 놓고, 값이 더 작으면 바꾼다.
// WIDTHS 후보로 비를 맞추지 못하면 WIDE 후보도 보고 같은 기준으로 더 나은 쪽.
// 그림 폭은 띠 폭 상한 + 2 x PAD 이하(WIDTHS 는 1600, WIDE 는 1800 이하). 연결 선택 키(via, lx, ly, off, offTo)는 무시한다.
// 같은 자료 객체면 다시 계산하지 않는다(서버는 바뀌지 않은 파일의 파싱 결과를 다시 씀).
const layoutMemo = new WeakMap();
export function archLayout(f, prefix = '예정') {
  if (!f || typeof f !== 'object') return layoutOf(f, prefix);
  const memo = layoutMemo.get(f) || new Map();
  layoutMemo.set(f, memo);
  if (!memo.has(prefix)) memo.set(prefix, layoutOf(f, prefix));
  return memo.get(prefix);
}

function layoutOf(f, prefix) {
  const zones = arr(f.zones);
  const nodes = arr(f.nodes);
  const edges = arr(f.edges);
  const missing = missingCoord(f);
  if (!missing) {
    const zone = new Map();
    const node = new Map();
    for (const z of zones) zone.set(z.id, { x: z.x, y: z.y, w: z.w, h: z.h });
    for (const n of nodes) node.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
    return { auto: false, missing: null, width: f.width, height: f.height, zone, node, edge: (e) => e };
  }
  // 영역마다 상자 크기를 가장 크게 필요한 상자에 맞춘다.
  const sized = (list) => {
    const nw = Math.max(AUTO.NW, ...list.map((n) => nodeNeed(n, AUTO.NW, prefix).w));
    return { list, nw, nh: Math.max(AUTO.NH, ...list.map((n) => nodeNeed(n, nw, prefix).h)) };
  };
  const ids = new Set(zones.map((z) => z.id));
  const groups = zones.map((z) => ({ z, ...sized(nodes.filter((n) => n.zone === z.id)) }));
  const loose = nodes.filter((n) => !ids.has(n.zone));
  if (loose.length) groups.push({ z: null, ...sized(loose) });
  const maxN = Math.max(1, ...groups.map((g) => g.list.length));
  // 연결 끝의 영역 id(상자면 그 상자의 영역, 영역 없는 상자는 null).
  const zoneOfNode = new Map(nodes.map((n) => [n.id, ids.has(n.zone) ? n.zone : null]));
  const zid = (id) => (zoneOfNode.has(id) ? zoneOfNode.get(id) : ids.has(id) ? id : null);
  // 같은 띠 옆 영역 사이 틈: 두 영역을 잇는 이름표 있는 연결이 있으면 가장 넓은 이름표 + 2 x LGAP + 8(ZGX 이상).
  // 이름표가 영역 테두리를 덮지 않고 틈에 들어간다.
  const pairKey = (a, b) => (a < b ? [a, b] : [b, a]).join('|');
  const gapNeed = new Map();
  for (const e of edges) {
    const [a, b] = [zid(e && e.from), zid(e && e.to)];
    if (!a || !b || a === b || !e.label) continue;
    const k = pairKey(a, b);
    gapNeed.set(k, Math.max(gapNeed.get(k) || 0, Math.ceil(textW(e.label) + 10) + 2 * ROUTE.LGAP + 8));
  }
  const gapOf = (p, q) => Math.max(AUTO.ZGX, (p.z && q.z && gapNeed.get(pairKey(p.z.id, q.z.id))) || 0);
  // 영역 순서 후보: 배열 순서, 연결이 많은 영역끼리 이웃하게 이은 순서. 둘째는 첫 영역에서 시작해 마지막에 놓은 영역과
  // 연결이 가장 많은 영역을 다음에 놓는다(같으면 이미 놓은 영역 전체와 연결 수, 다음에 배열 순서). 영역 없는 상자 묶음은 늘 맨 끝.
  const zg = groups.filter((g) => g.z);
  const link = new Map();
  for (const e of edges) {
    const [a, b] = [zid(e && e.from), zid(e && e.to)];
    if (a && b && a !== b) link.set(pairKey(a, b), (link.get(pairKey(a, b)) || 0) + 1);
  }
  const w = (p, q) => link.get(pairKey(p.z.id, q.z.id)) || 0;
  const chain = zg.slice(0, 1);
  const left = zg.slice(1);
  while (left.length) {
    let k = 0;
    const score = (g) => [w(chain.at(-1), g), chain.reduce((t, c) => t + w(c, g), 0)];
    for (let j = 1; j < left.length; j++) {
      const [a, b] = [score(left[j]), score(left[k])];
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) k = j;
    }
    chain.push(left.splice(k, 1)[0]);
  }
  // 상자 순서 후보: 영역마다 다른 영역과 잇는 연결이 HUB 개 이상 몰린 상자(값: 뒤 영역 연결 수 - 앞 영역 연결 수, 영역 없는 상자는 맨 뒤)를
  // 값이 HUB 이상이면 맨 뒤 칸(아래 행, 오른쪽), -HUB 이하면 맨 앞 칸으로. 나머지는 배열 순서 그대로. 연결이 많은 상자의 선이
  // 같은 영역의 다른 상자를 돌아가지 않고 바로 이웃 영역으로 간다.
  const sortNodes = (order) => {
    const at = new Map(order.map((g, i) => [g.z ? g.z.id : null, i]));
    return order.map((g, gi) => {
      const val = new Map(g.list.map((n) => [n.id, 0]));
      for (const e of edges) {
        for (const [me, other] of [[e && e.from, e && e.to], [e && e.to, e && e.from]]) {
          if (!val.has(me) || val.has(other)) continue;
          if (!zoneOfNode.has(other) && !ids.has(other)) continue;
          const oz = zid(other);
          const oi = at.has(oz) ? at.get(oz) : -1;
          if (oi >= 0 && oi !== gi) val.set(me, val.get(me) + (oi > gi ? 1 : -1));
        }
      }
      const side = (n) => (Math.abs(val.get(n.id)) >= AUTO.HUB ? Math.sign(val.get(n.id)) : 0);
      const list = g.list.map((n, i) => [n, i]).sort((p, q) => side(p[0]) - side(q[0]) || p[1] - q[1]).map((x) => x[0]);
      return list.every((n, i) => n === g.list[i]) ? g : { ...g, list };
    });
  };
  const orders = [];
  const seen = new Set();
  for (const o of [groups, [...chain, ...groups.filter((g) => !g.z)]]) {
    for (const v of [o, sortNodes(o)]) {
      const sig = v.map((g) => g.list.map((n) => n.id).join(',')).join('/');
      if (!seen.has(sig)) seen.add(sig), orders.push(v);
    }
  }
  // 후보 값 = base + WARN 수 x WARN_PX + 선 길이 합 x LEN + 엇갈림 수 x CROSS + 붐비는 이름표 수 x CROWD + FOREIGN, TIGHT 몫(위). base 는 높이, 상자 MANY 개 이상이고 가로세로 비가
  // RATIO 아래면 모자란 폭(RATIO x 높이 - 폭)을 더한다(비 하한에 가까운 후보). 길을 긋기 전에 아래 한계(base + 두 끝 사각형 사이
  // 가로세로 거리 합 x LEN. 선은 그 거리보다 짧을 수 없음)로 후보를 줄 세워 작은 TRY 개만 긋는다. 그 가운데 앞서 고른 후보 값보다
  // 아래 한계가 큰 후보는 긋지 않는다.
  const base = (L) => L.height + (nodes.length >= AUTO.MANY ? Math.max(0, AUTO.RATIO * L.height - L.width) : 0);
  const ends = edges.filter((e) => e && e.from !== e.to).map((e) => [e.from, e.to]);
  const lower = (L) => {
    let d = 0;
    for (const [a, b] of ends) {
      const p = L.node.get(a) || L.zone.get(a);
      const q = L.node.get(b) || L.zone.get(b);
      if (p && q) d += Math.max(0, q.x - p.x - p.w, p.x - q.x - q.w) + Math.max(0, q.y - p.y - p.h, p.y - q.y - q.h);
    }
    return base(L) + d * AUTO.LEN;
  };
  // 후보 하나에 선을 긋고 값을 잰다.
  const draw = (L) => {
    const routes = autoRoutes(L, edges);
    L.edge = (e) => {
      const pts = routes.get(e);
      return { ...e, via: pts && pts.length > 2 ? pts.slice(1, -1) : undefined, lx: undefined, ly: undefined, off: 0, offTo: undefined, pts };
    };
    const { len, cross, foreign, tight, hug } = routeSum(routes, L);
    const es = archEdges(f, L);
    const crowd = es.filter((g) => g.crowd).length;
    const cost = base(L) + archFlaws(f, L, es).length * AUTO.WARN_PX + len * AUTO.LEN + cross * AUTO.CROSS + crowd * AUTO.CROWD + foreign * AUTO.FOREIGN + (tight + hug) * AUTO.TIGHT;
    return { routes, es, cost };
  };
  const pick = (widths) => {
    const cands = [];
    const tried = new Set();
    orders.forEach((order, oi) => {
      for (const maxW of widths) {
        for (let rows = 1; rows <= maxN; rows++) {
          for (const snake of [false, true]) {
            const L = autoPlace(order, rows, maxW, snake, gapOf);
            const key = oi + ':' + L.sig + (snake && L.sig.includes('/') ? '/s' : '');
            if (tried.has(key)) continue;
            tried.add(key);
            cands.push({ L, args: [order, rows, maxW, snake], i: cands.length, bad: nodes.length >= AUTO.MANY && L.width / L.height < AUTO.RATIO ? 1 : 0, lb: lower(L) });
          }
        }
      }
    });
    // 아래 한계가 작은 차례(같으면 먼저 만든 후보). 비 하한을 맞춘 후보가 있으면 못 맞춘 후보는 긋지 않는다.
    cands.sort((p, q) => p.bad - q.bad || p.lb - q.lb || p.i - q.i);
    let best = null;
    for (const c of cands.slice(0, AUTO.TRY)) {
      if (best && (c.bad > best.bad || c.lb > best.cost)) continue;
      const d = draw(c.L);
      if (!best || c.bad < best.bad || (c.bad === best.bad && (d.cost < best.cost || (d.cost === best.cost && c.i < best.i)))) best = { ...c, ...d };
    }
    // 고른 후보에서 나란한 선이 들어가지 않는 틈을 넓혀 다시 놓고 그어 본다. 값이 작고 비 하한을 지키면 바꾼다.
    const need = roomNeed(best.L, best.routes, pairKey);
    // 같은 영역 같은 행 이웃 상자를 곧게 잇는 선의 이름표가 상자에서 LBOX 안이면 그 영역 상자 사이 가로 간격을 이름표 + 2 x LBOX + 2 로(GX + 16 이하일 때만).
    for (const g of best.es) {
      const [p, q] = g.pts;
      const z = zoneOfNode.get(g.e.from);
      const w = Math.ceil(g.lw) + 2 * ROUTE.LBOX + 2;
      if (!g.e.label || g.pts.length !== 2 || p[1] !== q[1] || !z || z !== zoneOfNode.get(g.e.to) || w > AUTO.GX + 16 || Math.abs(q[0] - p[0]) >= w) continue;
      need.set('gx:' + z, Math.max(need.get('gx:' + z) || 0, w));
    }
    if (need.size) {
      const [order, ...rest] = best.args;
      const L = autoPlace(order.map((g) => (g.z && need.has('gx:' + g.z.id) ? { ...g, gx: need.get('gx:' + g.z.id) } : g)), ...rest, (p, q) => Math.max(gapOf(p, q), (p.z && q.z && need.get(pairKey(p.z.id, q.z.id))) || 0), (bi) => Math.max(AUTO.ZGAP, need.get('band' + bi) || 0));
      const bad = nodes.length >= AUTO.MANY && L.width / L.height < AUTO.RATIO ? 1 : 0;
      const d = draw(L);
      if (bad <= best.bad && d.cost < best.cost) best = { ...best, L, bad, ...d };
    }
    return best;
  };
  let best = pick(AUTO.WIDTHS);
  if (best.bad) {
    const wide = pick([AUTO.WIDE]);
    if (wide.bad < best.bad || (wide.bad === best.bad && wide.cost < best.cost)) best = wide;
  }
  const { L } = best;
  return { auto: true, missing, width: L.width, height: L.height, zone: L.zone, node: L.node, edge: L.edge };
}

// 이름표 자리 후보(선분 위 비율). 가운데부터 시작 쪽으로, 다음에 끝 쪽으로.
const LABEL_TS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const hits = (a, b, gap) => overlap(a.x, a.x + a.w, b.x, b.x + b.w) > gap && overlap(a.y, a.y + a.h, b.y, b.y + b.h) > gap;
const seg = (s) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);

// 연결선 점과 이름표 자리(렌더와 check 가 같이 씀). 끝을 찾지 못한 연결은 뺀다.
// 좌표 사용이면 옛 규칙(lx, ly 또는 가장 긴 선분 가운데). 자동 배치면 선을 모두 그은 뒤 이름표를 연결 차례로 놓는다:
// 그 연결의 선분을 긴 차례로 보며 상자와 1 px 이상 겹치지 않고, 상자에서 LBOX 이상, 앞서 놓은 이름표와 4 px 이상 떨어지고, 영역 이름과 영역 테두리를
// 가리지 않고, 다른 연결의 선과 LGAP 이상 떨어진 첫 후보. 없으면 (덮는 상자 수, LBOX 안 상자 수, 가까운 이름표 수, 가리는 영역 이름과 테두리 수,
// LGAP 안의 다른 선 수)가 가장 작은 첫 후보.
export function archEdges(f, L) {
  const out = [];
  const segsOf = new Map();
  for (const e0 of arr(f.edges)) {
    const e = L.edge(e0);
    // 연결 끝은 구성요소나 영역(zone) id. 상자를 먼저 찾는다.
    const a = L.node.get(e.from) || L.zone.get(e.from);
    const b = L.node.get(e.to) || L.zone.get(e.to);
    if (!a || !b) continue;
    const pts = L.auto && e.pts ? e.pts : pathOf(a, b, e.via || [], e.off || 0, e.offTo ?? e.off ?? 0);
    // 가장 긴 선분이 앞. 길이가 같으면 선 차례(안정 정렬).
    const segs = pts.slice(1).map((q, i) => [pts[i], q]).sort((s, t) => seg(t) - seg(s));
    const [p, q] = segs[0];
    const lw = textW(e.label) + 10;
    const col = color(e.color, '') || ACOL[e.kind] || ACOL.control;
    const g = { e, e0, id: e.id || `${e.from}-${e.to}`, pts, col, lx: e.lx ?? (p[0] + q[0]) / 2, ly: e.ly ?? (p[1] + q[1]) / 2, lw };
    segsOf.set(g, segs);
    out.push(g);
  }
  if (!L.auto) return out;
  const placed = [];
  const boxes = [...L.node.values()];
  // 선분이 이름표 사각형 안을 지나는지(가장자리 1 px 안쪽).
  const under = (s, r) => Math.max(s[0][0], s[1][0]) > r.x + 1 && Math.min(s[0][0], s[1][0]) < r.x + r.w - 1 && Math.max(s[0][1], s[1][1]) > r.y + 1 && Math.min(s[0][1], s[1][1]) < r.y + r.h - 1;
  // 후보 자리: 선분을 긴 차례로, 선분마다 LABEL_TS 17곳. 상자와 겹치지 않는 곳이 없으면 선분마다 가운데부터 4 px 간격으로 더.
  // 그림 밖으로 나가는 자리는 그림 안(테두리 선 굵기까지 1 px 안쪽)으로 민다(가장자리 통로를 지나는 선).
  // 자리마다 덮는 상자 수, 가리는 영역 이름(굵은 13px, 글 폭 x 1.3)과 LGAP 안의 영역 테두리 수, LGAP 안의 다른 연결 선 수를 미리 센다.
  const zoneNames = arr(f.zones).filter((z) => L.zone.has(z.id)).map((z) => titleBand(z, L.zone.get(z.id).x, L.zone.get(z.id).y));
  // 영역 테두리 네 변(선분). 이름표가 덮지 않게 다른 선처럼 센다.
  const borders = [...L.zone.values()].flatMap((z) => [[[z.x, z.y], [z.x + z.w, z.y]], [[z.x, z.y + z.h], [z.x + z.w, z.y + z.h]], [[z.x, z.y], [z.x, z.y + z.h]], [[z.x + z.w, z.y], [z.x + z.w, z.y + z.h]]]);
  const { LGAP, LBOX } = ROUTE;
  const fine = (len) => Array.from({ length: Math.max(0, Math.floor(len / 8) - 1) }, (_, k) => 0.5 + ((k % 2 ? -1 : 1) * Math.ceil(k / 2) * 4) / len);
  const spots = new Map();
  for (const g of out) {
    if (!g.e.label) continue;
    const { lw } = g;
    // 이 연결의 선분 둘레(이름표 폭 절반 + 9 px 바깥까지)와 닿는 다른 선분만 본다.
    const own = segsOf.get(g).flat();
    const [bx0, bx1, by0, by1] = [Math.min(...own.map((q) => q[0])) - lw / 2 - 9, Math.max(...own.map((q) => q[0])) + lw / 2 + 9, Math.min(...own.map((q) => q[1])) - 17, Math.max(...own.map((q) => q[1])) + 17];
    const others = out.filter((o) => o !== g).flatMap((o) => segsOf.get(o)).filter((q) => Math.max(q[0][0], q[1][0]) > bx0 && Math.min(q[0][0], q[1][0]) < bx1 && Math.max(q[0][1], q[1][1]) > by0 && Math.min(q[0][1], q[1][1]) < by1);
    const list = [];
    for (const ts of [() => LABEL_TS, (s) => fine(seg(s))]) {
      for (const s of segsOf.get(g)) {
        const [s0, s1] = s;
        for (const t of ts(s)) {
          const x = Math.min(Math.max(s0[0] + (s1[0] - s0[0]) * t, lw / 2 + 1), L.width - lw / 2 - 1);
          const y = Math.min(Math.max(s0[1] + (s1[1] - s0[1]) * t, 9), L.height - 9);
          const r = { x: x - lw / 2, y: y - 8, w: lw, h: 16 };
          const near = { x: r.x - LGAP, y: r.y - LGAP, w: r.w + 2 * LGAP, h: r.h + 2 * LGAP };
          const pad = { x: r.x - LBOX, y: r.y - LBOX, w: r.w + 2 * LBOX, h: r.h + 2 * LBOX };
          list.push({ x, y, r, box: boxes.filter((n) => hits(r, n, 0)).length, boxNear: boxes.filter((n) => hits(pad, n, 0)).length, zone: zoneNames.filter((z) => hits(r, z, 0)).length + borders.filter((q) => under(q, near)).length, line: others.filter((q) => under(q, near)).length });
        }
      }
      if (list.some((c) => !c.box)) break;
    }
    spots.set(g, list);
  }
  // 상자와 겹치지 않는 자리가 적은 이름표부터 놓는다(같으면 연결 차례). 자리 점수: 덮는 상자 수, LBOX 안 상자 수, 4 px 안쪽 이름표 수,
  // 가리는 영역 이름과 테두리 수, LGAP 안의 다른 선 수. 모두 0 인 첫 자리, 없으면 점수가 가장 작은 첫 자리.
  const free = (g) => spots.get(g).filter((c) => !c.box).length;
  const order = [...spots.keys()].map((g, i) => [g, free(g), i]).sort((p, q) => p[1] - q[1] || p[2] - q[2]);
  for (const [g] of order) {
    let best = null;
    for (const c of spots.get(g)) {
      const sc = [c.box, c.boxNear, placed.filter((o) => hits(c.r, o, -4)).length, c.zone, c.line];
      if (!best || (sc[0] - best.sc[0] || sc[1] - best.sc[1] || sc[2] - best.sc[2] || sc[3] - best.sc[3] || sc[4] - best.sc[4]) < 0) best = { sc, c };
      if (!best.sc.some(Boolean)) break;
    }
    [g.lx, g.ly] = [best.c.x, best.c.y];
    // 상자에서 LBOX 안이거나 영역 이름이나 테두리를 가리거나 다른 선이 LGAP 안에 있는 이름표(배치 고르기 값).
    g.crowd = best.sc[1] + best.sc[3] + best.sc[4] > 0;
    placed.push(best.c.r);
  }
  return out;
}

// 연결의 기하 문제(check 와 자동 배치 고르기가 같이 씀): 선이 지나는 상자, 그림 밖 이름표, 이름표가 덮는 상자.
// 돌려줌: [{ g: archEdges 한 줄, kind: 'cross' | 'out' | 'cover', id: 상자 id }]. 연결 차례, 그 안에서 위 종류 차례.
export function archFlaws(f, L, es = archEdges(f, L)) {
  const nodes = arr(f.nodes);
  const out = [];
  const hit = (a, b) => overlap(a.x, a.x + a.w, b.x, b.x + b.w) >= 1 && overlap(a.y, a.y + a.h, b.y, b.y + b.h) >= 1;
  for (const g of es) {
    const a = L.node.get(g.e.from) || L.zone.get(g.e.from);
    const b = L.node.get(g.e.to) || L.zone.get(g.e.to);
    const crossed = new Set();
    for (let k = 0; k + 1 < g.pts.length; k++) {
      for (const n of nodes) {
        const box = L.node.get(n.id);
        if (box === a || box === b || crossed.has(n.id)) continue;
        if (segHits(g.pts[k], g.pts[k + 1], box)) crossed.add(n.id);
      }
    }
    for (const id of crossed) out.push({ g, kind: 'cross', id });
    if (g.e.label) {
      const lab = { x: g.lx - g.lw / 2, y: g.ly - 8, w: g.lw, h: 16 };
      if (lab.x < 0 || lab.x + lab.w > L.width) out.push({ g, kind: 'out' });
      for (const n of nodes) if (hit(lab, L.node.get(n.id))) out.push({ g, kind: 'cover', id: n.id });
    }
  }
  return out;
}

function archBody(m, config) {
  if (!m.arch.value) return emptyNotice('references/arch.md');
  const f = m.arch.value;
  const prefix = config.text.plannedPrefix;
  const L = archLayout(f, prefix);
  const zones = arr(f.zones);
  const nodes = arr(f.nodes);
  const edgesIn = arr(f.edges);
  const scenes = arr(f.scenes);
  const zoneD = new Map(zones.map((z) => [z.id, z]));
  const sceneOf = (id) => scenes.filter((s) => arr(s.focus).includes(id)).map((s) => s.n);
  const main = arr(f.main);
  const cycle = main.length * FSTEP_S + 1.5;
  const hi = Math.max(2, Math.round((FSTEP_S / cycle) * 100));
  const zoneColor = (z) => color(z && z.color, '#555555');
  const parts = [];
  for (const z of zones) {
    const r = L.zone.get(z.id);
    const zc = zoneColor(z);
    parts.push(`<g class="zn" id="z-${esc(z.id)}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="14" fill="${zc}14" stroke="${zc}" stroke-width="1.5"${z.dashed ? ' stroke-dasharray="7 5"' : ''}/><text x="${r.x + 12}" y="${r.y + 19}" class="zl" fill="${zc}">${esc(z.label)}</text></g>`);
  }
  const cols = new Set();
  const edges = [];
  const labels = [];
  for (const { e, id, pts, col, lx, ly, lw } of archEdges(f, L)) {
    cols.add(col);
    // 선과 이름표를 따로 그린다. 이름표는 모든 선과 상자 뒤(SVG 는 나중에 그린 것이 앞)에 그려 선에 가리지 않는다.
    // 마우스를 올리면 보이는 글: 설명, 없으면 이름표, 둘 다 없으면 근거만(근거도 없으면 빈 글).
    const refs = arr(e.refs);
    const said = e.detail || e.label || '';
    const tip = `<title>${esc(said + (refs.length ? (said ? ' (' : '(') + refs.join(', ') + ')' : ''))}</title>`;
    if (e.label) labels.push(`<g class="el-tag" id="e-${esc(id)}" data-scene="${esc(sceneOf(id).join(','))}">${tip}<rect x="${lx - lw / 2}" y="${ly - 8}" width="${lw}" height="16" rx="8" fill="#fff" stroke="${col}" stroke-width="0.8"/><text x="${lx}" y="${ly + 3.5}" class="el" text-anchor="middle">${esc(e.label)}</text></g>`);
    edges.push(`<g class="eg" id="e-${esc(id)}-line" data-scene="${esc(sceneOf(id).join(','))}">${tip}
<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${col}" class="${esc(e.kind || 'control')}" marker-end="url(#am${col.slice(1)})"${e.both ? ` marker-start="url(#am${col.slice(1)})"` : ''}/>
</g>`);
  }
  for (const n of nodes) {
    const r = L.node.get(n.id);
    const col = color(n.color, '') || zoneColor(zoneD.get(n.zone));
    const k = main.indexOf(n.id);
    const anim = k >= 0 ? ` style="animation:ap ${cycle}s ${(k * FSTEP_S).toFixed(1)}s infinite"` : '';
    const sub = wrap(n.detail, r.w - 16).slice(0, n.lines || 2);
    let cx = r.x + 8;
    let cy = r.y + 26 + sub.length * 14 + 4;
    const chips = arr(n.items)
      .map((t) => {
        const w = textW(t) + 12;
        if (cx + w > r.x + r.w - 6) {
          cx = r.x + 8;
          cy += 19;
        }
        // 예정 접두로 시작하는 칩은 주황(아직 구현 안 됨).
        const planned = Boolean(prefix) && String(t).startsWith(prefix);
        const [cf, cs] = planned ? ['#fff4e0', '#b26a00'] : [col + '1f', col];
        const s = `<rect x="${cx}" y="${cy}" width="${w}" height="16" rx="8" fill="${cf}" stroke="${cs}" stroke-width="0.6"${planned ? ' stroke-dasharray="3 2"' : ''}/><text x="${cx + 6}" y="${cy + 11.5}" class="ck">${esc(t)}</text>`;
        cx += w + 4;
        return s;
      })
      .join('');
    parts.push(`<g class="nd" id="n-${esc(n.id)}" data-scene="${esc(sceneOf(n.id).join(','))}"${anim}><title>${esc([n.kind, n.detail, n.path, arr(n.refs).join(', ')].filter(Boolean).join(' | '))}</title>
<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="9" fill="#fff" stroke="${col}" stroke-width="${k >= 0 ? 2.4 : 1.6}"${n.planned ? ' stroke-dasharray="6 4"' : ''}/>
<text x="${r.x + 8}" y="${r.y + 18}" class="nl">${esc(n.label)}</text>${n.planned ? `<text x="${r.x + r.w - 6}" y="${r.y + 16}" class="tag">${PLANNED_TAG}</text>` : ''}
${sub.map((t, i) => `<text x="${r.x + 8}" y="${r.y + 34 + i * 14}" class="ns">${esc(t)}</text>`).join('')}${chips}</g>`);
  }
  const markers = [...cols].map((c) => `<marker id="am${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join('');
  const total = scenes.reduce((a, s) => a + (finite(s.sec) ? s.sec : 0), 0);
  const nodeD = new Map(nodes.map((n) => [n.id, n]));
  const label = (id) => (nodeD.get(id) || {}).label || (edgesIn.find((e) => (e.id || `${e.from}-${e.to}`) === id) || {}).label || id;
  const rows = scenes.map((s) => `<tr><td class="q">${esc(s.n)}</td><td class="d">${esc(s.sec)}초</td><td>${esc(s.caption)}</td><td class="n">${esc(arr(s.focus).map(label).join(', '))}</td></tr>`).join('');
  const legend = arr(f.legend).map((t) => `<li>${esc(t)}</li>`).join('');
  return `<div class="meta">${sent(`${esc(f.note || '')} 자료: <code>arch.json</code>. 주황 굵은 선은 요청이 흐르는 길, 회색 실선은 실행과 호출, 점선은 파일과 설정 읽기, 점선 상자는 예정. 상자와 선에 마우스를 올리면 근거가 보임.`)}</div>
<style>@keyframes ap{0%{filter:none}${Math.round(hi / 2)}%{filter:drop-shadow(0 0 8px #e65100)}${hi}%,100%{filter:none}}</style>
<div class="fwrap"><svg class="arch" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" role="img" aria-label="${esc(config.shortName)} 구성도"><defs>${markers}</defs>${parts.slice(0, zones.length).join('')}${edges.join('')}${parts.slice(zones.length).join('')}${labels.join('')}</svg></div>
${legend ? `<h2>읽는 법</h2><ul class="meta">${legend}</ul>` : ''}
<h2>장면 대본 <small>모션 그래픽 준비, 합계 ${total}초</small></h2>
<table><thead><tr><th>장면</th><th>길이</th><th>화면 내용</th><th>강조 구성요소</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- 화면 ----------

// 탭 key. workflow 탭의 옛 주소(?tab=flow)도 받는다. 모르는 값은 진척도.
export const tabKey = (tab) => (tab === 'flow' ? 'workflow' : TABS.some((t) => t[0] === tab) ? tab : 'history');

function tabBody(m, config, k, now) {
  if (k === 'arch') return archBody(m, config);
  if (k === 'workflow') return flowBody(m);
  if (k === 'req') return reqBody(m, config);
  return historyBody(m, config, now);
}

// 모은 자료(m)로 탭 하나의 HTML. workflow 와 구성도는 움직임이 있고 자주 바뀌지 않아 자동 갱신하지 않는다.
export function pageFrom(m, config, tab, now) {
  const k = tabKey(tab);
  const refresh = k === 'history' || k === 'req' ? `<meta http-equiv="refresh" content="${config.refreshSec};url=/?tab=${k}">` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">${refresh}
<title>${esc(config.shortName)} ${tabName(k)}</title><link rel="icon" href="${FAVICON}"><style>
${CSS}
</style></head><body>
<h1>${esc(config.title)}</h1>
<div class="meta">갱신 ${esc(nowText(now))} | ${config.refreshSec}초마다 자동 갱신 | HEAD <code>${esc(m.head)}</code></div>
${tabsHtml(k)}
${tabBody(m, config, k, now)}</body></html>`;
}

// 단일 HTML 스냅숏: 네 탭을 한 파일에. 서버, 자동 갱신, 외부 자원 없이 file:// 로 열린다.
// 탭 전환은 주소의 #history, #req, #workflow, #arch 와 짧은 인라인 스크립트. 스크립트가 꺼져 있으면 네 탭을 모두 보인다.
export function snapshotFrom(m, config, now) {
  const tabs = TABS.map(([k, name]) => `<a href="#${k}" data-tab="${k}">${esc(name)}</a>`).join('');
  const secs = TABS.map(([k, name]) => `<section id="tab-${k}" class="tab"><h2 class="tt">${esc(name)}</h2>\n\n${tabBody(m, config, k, now)}</section>`).join('\n');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${esc(config.shortName)} 진척도 스냅숏</title><link rel="icon" href="${FAVICON}"><style>
${CSS}
</style>
<style>.js .tab{display:none}.js .tab.cur{display:block}.js h2.tt{display:none}h2.tt{border-top:2px solid #ccc;padding-top:10px}</style></head><body>
<h1>${esc(config.title)}</h1>
<div class="meta">스냅숏 ${esc(nowText(now))} | 서버 없이 여는 단일 파일(자동 갱신 없음) | HEAD <code>${esc(m.head)}</code></div>
<div class="tabs">${tabs}</div>
${secs}
<script>(function(){var d=document.documentElement;d.className+=' js';var ks=${JSON.stringify(TABS.map((t) => t[0]))};
function show(){var h=location.hash.slice(1),k=ks.indexOf(h)<0?ks[0]:h;ks.forEach(function(x){document.getElementById("tab-"+x).className='tab'+(x===k?' cur':'');var a=document.querySelector('.tabs a[data-tab="'+x+'"]');a.className=x===k?'on':'';});scrollTo(0,0);}
addEventListener('hashchange',show);show();})();</script>
</body></html>`;
}

// 서버가 요청마다 부른다. 자료는 요청마다 다시 읽는다(바뀌지 않은 파일은 캐시).
export function renderTab(ctx, config, tab, now) {
  return pageFrom(collect(ctx, config, now), config, tab, now);
}

// config.json 형식 오류 화면. 고치면 다음 자동 갱신(기본 주기)에 화면이 돌아온다.
export function configErrorPage(errors, refreshSec) {
  const rows = errors.map((e) => `<li><code>${esc(e.path)}</code> ${esc(e.msg)}</li>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="refresh" content="${refreshSec}">
<title>config.json 형식 오류</title><link rel="icon" href="${FAVICON}"><style>
${CSS}
</style></head><body>
<h1>config.json 형식 오류</h1>
<div class="meta">고친 뒤 ${refreshSec}초 안에 화면이 돌아옴. check 로 확인</div>
<ul>${rows}</ul></body></html>`;
}

// 서버의 렌더 함수. config.json 을 요청마다 보고 (mtime, 크기, ctime)이 바뀌었을 때만 다시 읽는다.
// 그래서 stories, commitRegex, title 같은 값은 서버를 다시 띄우지 않아도 다음 응답에 반영된다(포트와 주소만 다시 띄워야 함).
export function liveRender(ctx, initial) {
  const file = path.join(ctx.dataDir, 'config.json');
  const keyOf = () => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}:${st.ctimeMs}`;
    } catch (e) {
      return e.code || 'error';
    }
  };
  let key = keyOf();
  let cur = { config: initial, errors: [] };
  return (tab, now) => {
    const k = keyOf();
    if (k !== key) {
      key = k;
      cur = loadConfig(ctx);
    }
    if (cur.errors.length) return configErrorPage(cur.errors, initial.refreshSec);
    return renderTab(ctx, cur.config, tab, now);
  };
}

// CLI: export <file> [--now <ISO>]. 자료 폴더를 만들지 않는다.
export async function command(cmd, ctx, o, io) {
  if (cmd !== 'export') throw new UsageError(`${cmd} 는 pm-render.mjs 가 맡지 않음`);
  const file = o._[1];
  if (!file || o._.length > 2) throw new UsageError('사용: export <file> [--now <ISO>]');
  let now = Date.now();
  if (o.now !== undefined) {
    now = Date.parse(o.now);
    if (!Number.isFinite(now)) throw new UsageError(`--now 는 ISO 8601 시각: ${o.now}`);
  }
  const config = configOrFail(ctx);
  const out = path.resolve(file);
  try {
    fs.writeFileSync(out, snapshotFrom(collect(ctx, config, now), config, now));
  } catch (e) {
    throw new UsageError(`쓰기 실패(${e.code || e.message}): ${file}`);
  }
  io.out(`내보냄: ${out}`);
  return 0;
}
