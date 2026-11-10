// wp-html.mjs: draws the wide-pptx model as one self-contained HTML deck: 1280 x 720 slides (13.333 x 7.5 in at
// 96 px/in, the PPTX size), scaled to the window, one slide per page when printed. A small inline script moves
// between slides (arrows, space, PageUp/PageDown, Home/End, click) and N shows the speaker notes. No library, no
// network: images are data URIs, charts inline SVG. Fonts: "Noto Sans" then "Noto Sans KR" (Hangul falls to KR).
import { chartSvg, esc } from "./wp-svg.mjs";

const br = (s) => esc(s).replace(/\n/g, "<br>");

const css = (t) => `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#2C3E50;font-family:"Noto Sans","Noto Sans KR",sans-serif;color:#${t.dark}}
.stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.slide{position:absolute;width:1280px;height:720px;background:#fff;display:none;transform-origin:center center;overflow:hidden}
.slide.on{display:block}
.slide h2{position:absolute;left:58px;top:34px;width:1164px;height:82px;font-size:37px;font-weight:700;display:flex;align-items:center;color:#${t.dark}}
.bar{position:absolute;left:58px;top:117px;width:106px;height:6px;background:#${t.accent}}
.foot{position:absolute;left:58px;right:58px;top:672px;height:29px;font-size:13px;color:#${t.muted};display:flex;justify-content:space-between}
.body{position:absolute;left:77px;top:149px;width:1126px;height:494px}
ul.b{list-style:none;font-size:27px;line-height:1.35}
ul.b li{position:relative;padding-left:30px;margin-bottom:11px}
ul.b li::before{content:"";position:absolute;left:4px;top:.55em;width:10px;height:10px;border-radius:50%;background:#${t.accent}}
ul.b li.l2{font-size:23px;margin-left:34px}
ul.b li.l2::before{width:8px;height:8px;border-radius:0;background:#${t.muted}}
.cols{display:flex;gap:38px;height:100%}.cols>div{flex:1;min-width:0}
.cols h3{font-size:27px;color:#${t.accent};margin-bottom:18px}
table.t{width:100%;border-collapse:collapse;font-size:19px}
table.t th{background:#${t.primary};color:#fff;font-weight:700}
table.t th,table.t td{border:1px solid #D5D8DC;padding:8px 10px;text-align:left}
table.t tr:nth-child(odd) td{background:#${t.light}}
.cap{position:absolute;left:77px;top:605px;width:1126px;font-size:16px;color:#${t.muted}}
.media{display:flex;align-items:center;justify-content:center;height:446px}
.media img{max-width:100%;max-height:100%}
.s-title,.s-closing{background:#${t.primary};color:#fff}
.s-title .acc{position:absolute;left:77px;top:216px;width:115px;height:8px;background:#${t.accent}}
.s-title h1{position:absolute;left:77px;top:235px;width:1126px;font-size:53px;font-weight:700;line-height:1.2}
.s-title .sub{position:absolute;left:77px;top:379px;width:1126px;font-size:29px;color:#D6EAF8}
.s-title .by{position:absolute;left:77px;top:547px;font-size:21px}
.s-closing h1{position:absolute;left:77px;top:259px;width:1126px;text-align:center;font-size:53px;font-weight:700}
.s-closing .sub{position:absolute;left:77px;top:394px;width:1126px;text-align:center;font-size:27px;color:#D6EAF8}
.s-section,.s-quote{background:#${t.light}}
.s-section .edge{position:absolute;left:0;top:0;width:34px;height:720px;background:#${t.accent}}
.s-section h1{position:absolute;left:96px;top:259px;width:1088px;font-size:48px;font-weight:700}
.s-section .sub{position:absolute;left:96px;top:374px;width:1088px;font-size:27px;color:#${t.muted}}
.s-quote .q{position:absolute;left:115px;top:192px;width:1050px;height:269px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:40px;font-style:italic}
.s-quote .who{position:absolute;left:115px;top:470px;width:1050px;text-align:right;font-size:24px;color:#${t.muted}}
.s-quote .qt{position:absolute;left:58px;top:34px;font-size:24px;font-weight:700;color:#${t.accent}}
.notes{position:fixed;left:0;right:0;bottom:0;max-height:35%;overflow:auto;background:#fff;border-top:4px solid #${t.accent};padding:14px 22px;font-size:18px;display:none;white-space:pre-wrap}
body.show-notes .notes{display:block}
.hint{position:fixed;right:12px;bottom:8px;color:#BDC3C7;font-size:12px}
@page{size:13.333in 7.5in;margin:0}
@media print{html,body{background:#fff;height:auto}.stage{position:static;display:block}.slide{position:relative;display:block;transform:none!important;page-break-after:always;break-after:page}
.notes,.hint{display:none!important}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

const bullets = (list) => (list.length ? `<ul class="b">${list.map((b) => `<li class="l${b.level}">${br(b.text)}</li>`).join("")}</ul>` : "");
const head = (s) => `<h2>${br(s.title)}</h2><div class="bar"></div>`;
const cap = (s) => (s.caption ? `<div class="cap">${br(s.caption)}</div>` : "");

function table(t) {
  const th = t.header.length ? `<tr>${t.header.map((h) => `<th>${br(h)}</th>`).join("")}</tr>` : "";
  return `<table class="t">${th}${t.rows.map((r) => `<tr>${r.map((c) => `<td>${br(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}

const BODY = {
  title: (s) => `<div class="acc"></div><h1>${br(s.title)}</h1>${s.subtitle ? `<div class="sub">${br(s.subtitle)}</div>` : ""}`
    + `<div class="by">${esc([s.presenter, s.date].filter(Boolean).join("  |  "))}</div>`,
  section: (s) => `<div class="edge"></div><h1>${br(s.title)}</h1>${s.subtitle ? `<div class="sub">${br(s.subtitle)}</div>` : ""}`,
  bullets: (s) => `${head(s)}<div class="body">${bullets(s.bullets)}</div>`,
  two: (s) => `${head(s)}<div class="body cols">${[s.left, s.right].map((c) => `<div>${c.heading ? `<h3>${br(c.heading)}</h3>` : ""}${bullets(c.bullets)}</div>`).join("")}</div>`,
  table: (s) => `${head(s)}<div class="body">${table(s.table)}</div>${cap(s)}`,
  chart: (s) => `${head(s)}<div class="body media">${chartSvg(s.chart, 1126, 446)}</div>${cap(s)}`,
  image: (s) => `${head(s)}<div class="body media"><img alt="${esc(s.caption || s.title)}" src="data:${s.image.mime};base64,${s.image.data.toString("base64")}"></div>${cap(s)}`,
  quote: (s) => `${s.title ? `<div class="qt">${br(s.title)}</div>` : ""}<div class="q">“${br(s.quote)}”</div>${s.by ? `<div class="who">- ${br(s.by)}</div>` : ""}`,
  closing: (s) => `<h1>${br(s.title)}</h1>${s.subtitle ? `<div class="sub">${br(s.subtitle)}</div>` : ""}`,
};

function slideHtml(s, i, m) {
  const plain = s.type === "title" || s.type === "closing";
  const foot = plain ? "" : `<div class="foot"><span>${esc(m.footer)}</span><span>${i + 1}</span></div>`;
  return `<section class="slide s-${s.type}" data-notes="${esc(s.notes)}">${BODY[s.type](s)}${foot}</section>`;
}

// The deck's own script: scale to the window, move between slides, show notes. Reads nothing from outside.
const SCRIPT = `(function(){var s=[].slice.call(document.querySelectorAll('.slide')),n=document.querySelector('.notes'),i=0;
function fit(){var k=Math.min(innerWidth/1280,innerHeight/720);s.forEach(function(e){e.style.transform='scale('+k+')';});}
function go(j){i=Math.max(0,Math.min(s.length-1,j));s.forEach(function(e,x){e.classList.toggle('on',x===i);});n.textContent=s[i].getAttribute('data-notes')||'(노트 없음)';history.replaceState(null,'','#'+(i+1));}
addEventListener('keydown',function(e){var k=e.key;if(k==='ArrowRight'||k==='PageDown'||k===' ')go(i+1);else if(k==='ArrowLeft'||k==='PageUp')go(i-1);else if(k==='Home')go(0);else if(k==='End')go(s.length-1);else if(k==='n'||k==='N')document.body.classList.toggle('show-notes');else return;e.preventDefault();});
document.querySelector('.stage').addEventListener('click',function(e){go(e.clientX<innerWidth/3?i-1:i+1);});
addEventListener('resize',fit);fit();go((parseInt(location.hash.slice(1),10)||1)-1);})();`;

/** Returns the HTML text for a model. */
export function toHtml(m) {
  const slides = m.slides.map((s, i) => slideHtml(s, i, m)).join("\n");
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(m.title)}</title><style>${css(m.theme)}</style></head><body>`
    + `<div class="stage">\n${slides}\n</div><div class="notes"></div><div class="hint">← → 넘김, N 노트</div>`
    + `<script>${SCRIPT}</script></body></html>\n`;
}
