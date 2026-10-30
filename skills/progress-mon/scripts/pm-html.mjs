// pm-html.mjs: 화면 조각 공통. escape, 색과 수 검사, 글 폭 추정, 줄 나눔, 공통 CSS, 탭 머리, favicon.
// CSS, favicon, 탭 머리는 옛 진척도 서버와 같은 바이트(같은 모양 원칙).

// 본문과 속성 모두 & < > " ' 를 바꾼다.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 속성 값: esc 에 더해 줄바꿈과 탭도 문자 참조로.
export const attr = (s) => esc(s).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');

// 색은 #rrggbb 만. 그 밖은 기본 색.
export const color = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);

// 유한 수만 참. 문자열 수는 받지 않음.
export const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// 10px 글꼴 기준 글 폭 추정(한글 10.5px, 그 밖 6px).
export const textW = (t) => [...String(t || '')].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? 10.5 : 6), 0);

// 11px 글꼴 기준 폭(px)으로 줄을 나눈다(띄어쓰기에서 끊음).
export function wrap(t, px) {
  const out = [];
  let cur = '';
  for (const w of String(t || '').split(' ')) {
    if (cur && textW(cur + ' ' + w) * 1.1 > px) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

// 진척 막대 모양 아이콘. 외부 파일 없이 data URI 로 넣는다.
export const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1b5e20"/><rect x="5" y="20" width="5" height="7" fill="#a5d6a7"/><rect x="13.5" y="13" width="5" height="14" fill="#c8e6c9"/><rect x="22" y="6" width="5" height="21" fill="#fff"/></svg>');

// 공통 CSS. 쓰는 쪽은 `<style>\n${CSS}\n</style>` 꼴로 넣는다.
export const CSS = `body{font:14px/1.5 "Malgun Gothic",system-ui,sans-serif;margin:16px;color:#222;background:#f6f7f9}
h1{font-size:20px;margin:0 0 4px}.meta{color:#666;font-size:12px;margin-bottom:12px}
.bar{height:8px;background:#ddd;border-radius:4px;max-width:520px;margin:6px 0 16px}.bar i{display:block;height:100%;background:#2e7d32;border-radius:4px}
table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px #0001}
th,td{border-bottom:1px solid #eee;border-right:1px solid #e3e3e3;padding:6px 10px;text-align:left;vertical-align:top}
th:last-child,td:last-child{border-right:0}
thead th{background:#fafafa;font-size:13px;border-bottom:2px solid #ddd}
td.t{white-space:nowrap;color:#555;font-family:Consolas,monospace;font-size:12px;width:90px}td.n{color:#666;font-size:12px}
td.q{text-align:right;color:#888;font-size:12px;width:36px}td.d{text-align:right;font-family:Consolas,monospace;font-size:12px;white-space:nowrap}
td.h{font-family:Consolas,monospace;font-size:12px;color:#555;white-space:nowrap}td.p{color:#b3261e;font-size:12px}
tr.sec td{font-weight:bold;padding-top:14px;border-bottom:2px solid #ccc}
tr.sec.done td{color:#2e7d32}tr.sec.doing td{color:#b26a00}tr.sec.todo td{color:#555}
tr.doing td{background:#fff8e6}tr.todo td{color:#777}
.b{display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;white-space:nowrap}
.b.done{background:#e3f3e4;color:#2e7d32}.b.doing{background:#ffe9b8;color:#8a5200}.b.todo{background:#eee;color:#666}
small{color:#888;margin-right:4px}
.tabs{border-bottom:1px solid #ccc;margin:0 0 12px}.tabs a{display:inline-block;padding:6px 16px;margin-right:4px;border:1px solid #ccc;border-bottom:0;border-radius:6px 6px 0 0;background:#e9ebef;color:#333;text-decoration:none;position:relative;top:1px}
.tabs a.on{background:#fff;font-weight:bold}
h2{font-size:16px;margin:18px 0 6px}.b.part{background:#e1ecfb;color:#1a4f9c}.b.miss{background:#fde2e0;color:#b3261e}.b.unv{background:#f3e5f5;color:#6a1b9a}.b.excl{background:#eceff1;color:#546e7a}
.s{display:inline-block;font-family:Consolas,monospace;font-size:12px;padding:0 4px;margin:1px;border-radius:4px;background:#eee;color:#777}.s.ok{background:#e3f3e4;color:#2e7d32}td.st{width:144px;min-width:144px;max-width:144px;white-space:normal;font-size:0}td.st .s{width:34px;box-sizing:border-box;text-align:center}
.fwrap{overflow-x:auto;background:#fff;box-shadow:0 1px 3px #0001;border-radius:6px;padding:8px;margin-bottom:6px}.dot{display:inline-block;width:10px;height:10px;border-radius:5px;margin-right:6px}
svg.flow text{font-family:"Malgun Gothic",system-ui,sans-serif}svg.flow .no{font-size:11px;fill:#fff;text-anchor:middle;font-weight:bold}svg.flow .lb{font-size:14px;font-weight:bold;fill:#222}
svg.flow .dt{font-size:11px;fill:#555}svg.flow .who{font-size:10px;fill:#999;font-family:Consolas,monospace}svg.flow .ac{font-size:10px;fill:#b26a00;text-anchor:end}
svg.flow .et{font-size:10px;fill:#555;text-anchor:middle}svg.flow .bt{font-size:10px;fill:#b3261e}svg.flow .pl rect{fill:#fbfbfb}
svg.flow .fl{stroke-width:2;stroke-dasharray:6 5;animation:fd 1s linear infinite}@keyframes fd{to{stroke-dashoffset:-11}}
svg.arch text{font-family:"Malgun Gothic",system-ui,sans-serif}svg.arch .zl{font-size:13px;font-weight:bold}svg.arch .nl{font-size:13px;font-weight:bold;fill:#222}
svg.arch .ns{font-size:10.5px;fill:#555}svg.arch .ck{font-size:10px;fill:#333}svg.arch .el{font-size:10px;fill:#333}svg.arch .tag{font-size:9.5px;fill:#b26a00;text-anchor:end}
svg.arch .api{stroke-width:2.6;stroke-dasharray:8 6;animation:fd2 1.2s linear infinite}@keyframes fd2{to{stroke-dashoffset:-14}}
svg.arch .control{stroke-width:1.6}svg.arch .data{stroke-width:1.4;stroke-dasharray:4 4}
@media (prefers-reduced-motion: reduce){svg.flow .n,svg.flow .fl,svg.arch .api,svg.arch .nd{animation:none}}`;

// 탭 순서와 이름.
export const TABS = [
  ['history', '진척도'],
  ['req', '구현요건'],
  ['workflow', 'workflow'],
  ['arch', '구성도'],
];

// 서버 화면의 탭 머리. cur 는 켜진 탭 id.
export const tabsHtml = (cur) => `<div class="tabs">${TABS.map(([k, name]) => `<a href="/?tab=${k}"${cur === k ? ' class="on"' : ''}>${name}</a>`).join('')}</div>`;
