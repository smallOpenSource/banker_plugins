// pm-wbs-view.mjs: WBS 탭 화면 렌더. 자료 wbs.json 은 wbs-gen 의 plan.json 과 같은 형식이다.
// 검사와 배치는 wg-plan.mjs, 격자는 wg-html.mjs 가 한다. 둘은 wbs-gen 의 정본 사본(scripts/sync-adapter.js)이라 고치지 않는다.
// 격자 CSS 는 .wbsg 아래로만 걸려 이 화면의 body, table, th, td 규칙을 바꾸지 않는다.
import { layout } from './wg-plan.mjs';
import { SCOPED_CSS, toFragment } from './wg-html.mjs';
import { esc } from './pm-html.mjs';

// 화면에 보이는 오류 줄 상한. 나머지는 check 로 본다.
const ERR_MAX = 20;

// 고칠 곳 안내: 깨짐 배지와 오류 줄 목록.
function brokenHtml(why, errors) {
  const more = errors.length > ERR_MAX ? `<li>외 ${errors.length - ERR_MAX}건</li>` : '';
  const list = errors.length ? `<ul class="meta">${errors.slice(0, ERR_MAX).map((e) => `<li>${esc(e)}</li>`).join('')}${more}</ul>` : '';
  return `<div class="meta"><span class="b miss">${esc(why)}</span> 고치는 법: <code>references/wbs.md</code>. 위치는 check</div>${list}`;
}

// 단위 안내 한 줄. 시간 단위는 기간 2일 이내.
const unitText = (model) =>
  model.unit === 'hour' ? `시간 단위(기간 2일 이내): 모든 시간 ${model.days.length}칸` : `영업일 단위: 영업일 ${model.days.length}칸, 주 ${model.weeks.length}`;

// WBS 탭 본문. m.wbs: wbs.json 읽기 결과({ value } | { missing } | { error }).
export function wbsBody(m, emptyNotice) {
  const got = m.wbs || { missing: true };
  if (got.missing) return emptyNotice('references/wbs.md');
  if (got.error) return brokenHtml(`wbs.json 을 읽지 못함(${got.error})`, []);
  const res = layout(got.value);
  if (!res.model) return brokenHtml(`wbs.json 오류 ${res.errors.length}건`, res.errors);
  const warn = res.warnings.map((w) => `<div class="meta"><span class="b unv">${esc(w)}</span></div>`).join('');
  return `<div class="meta">WBS 간트. 자료: <code>wbs.json</code>(wbs-gen 의 계획 형식). ${esc(unitText(res.model))}. 일정이 바뀌면 wbs.json 을 고치고 check.</div>${warn}
<style>${SCOPED_CSS}</style>
${toFragment(res.model)}`;
}
