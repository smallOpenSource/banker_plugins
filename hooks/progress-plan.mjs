/**
 * What banker's /progress pane (progress.mjs) reads from text: a prompt as the person wrote it, and
 * a plan file as steps and as a tree. Plain functions of strings; the pane reads the files itself.
 *
 * A turn's text comes with the harness's tags: a slash command arrives as `<command-name>` and
 * `<command-args>`, a background task's end as `<task-notification>`, a shell command as
 * `<bash-input>`, pasted text inside `<pasted_content id="…">`. Claude 5 models get no task list
 * tool in Claude Code 2.1.296, so the plan a session writes (ralplan's, superpowers', ralph's PRD,
 * ultragoal's goals) is what shows the work ahead.
 *
 * The pane shows the whole plan as a tree that folds like a toggle list: headings hold what follows
 * them, list items their nested items, a table its rows, a code block its lines. The steps (the
 * rules below) only count how far along the plan is.
 *
 * Every mod shares the engine's one hooks worker, and a plan may come from a cloned repository, so
 * no step here takes more than linear time: a markdown plan is read to its first 256 Ki characters
 * and each line to its first 1 Ki (a lone CR ends a line too, so no line holds one), a JSON plan to
 * 512 Ki characters, a JSON plan's fields and a prompt's text are cut before they are cleaned, tags
 * are found with indexOf, node names are told apart by a count, and no pattern backtracks over a line.
 * What the engine will not draw (control characters, lone surrogates, private-use characters such as
 * its own U+10EEEE, bidirectional overrides) never reaches the pane.
 */

// ── text on the pane ─────────────────────────────────────────────────────────

// Characters a terminal draws two cells wide: Hangul, CJK, fullwidth forms, and emoji shown as
// emoji by default. Combining marks, joiners and variation selectors take none.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const NONE = /[\p{Mn}\p{Me}\u200B-\u200D\uFE0E\uFE0F]/u;
const width = (c) => (NONE.test(c) ? 0 : WIDE.test(c) ? 2 : 1);

// The cells a line of text takes on a terminal.
export const cells = (text) => [...String(text)].reduce((n, c) => n + width(c), 0);

// A line cut to `n` cells, its end an ellipsis where it was cut.
export function fit(text, n) {
  if (cells(text) <= n) return text;
  if (n <= 0) return '';
  let out = '';
  let used = 0;
  for (const c of text) {
    if (used + width(c) > n - 1) break;
    out += c;
    used += width(c);
  }
  return `${out}…`;
}

// Characters the engine refuses in a drawing, or that would turn the text drawn after them around:
// control characters, private-use ones (the engine keeps U+10EEEE for itself; icon fonts' glyphs go
// too), bidirectional overrides. Lone surrogates go by toWellFormed. For replace only: a global
// pattern keeps lastIndex between test() calls.
export const UNDRAWABLE = /[\p{Cc}\p{Co}\u202A-\u202E\u2066-\u2069]/gu;

// One line of plain text, cut to `n` characters, with what the engine cannot draw gone: it refuses a
// whole drawing that holds any. A long text is cut first, so cleaning it stays cheap.
export const clip = (text, n) => {
  const raw = String(text ?? '').slice(0, n * 4 + 1024);
  const s = (raw.toWellFormed?.() ?? raw).replace(UNDRAWABLE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [];
  for (const c of s) {
    chars.push(c);
    if (chars.length > n) break;
  }
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

// ── a prompt's text ──────────────────────────────────────────────────────────

// Past this a prompt, its tags taken out, has nothing more for a title or a description.
const PROMPT_CAP = 65536;

// Tags the harness wraps around what it adds to a prompt: they go with what they hold.
const HARNESS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'bash-stdout', 'bash-stderr', 'command-message', 'command-name', 'command-args', 'bash-input'];

// Messages the harness wraps in a tag with attributes: another session's, a teammate's.
const WRAPPER = /^\s*<(cross-session-message|teammate-message)\b[^>]*>/;

// The first `open … close` pair from `from` on, or null where there is none.
function pair(text, open, close, from = 0) {
  const start = text.indexOf(open, from);
  if (start < 0) return null;
  const stop = text.indexOf(close, start + open.length);
  return stop < 0 ? null : { start, inner: text.slice(start + open.length, stop), end: stop + close.length };
}

const inner = (text, tag) => pair(text, `<${tag}>`, `</${tag}>`)?.inner.trim() ?? '';

// The text with each pair of a harness tag taken out, with what it holds; an unclosed tag stays.
function strip(text) {
  let s = text;
  for (const tag of HARNESS) {
    let out = '';
    let at = 0;
    let m = pair(s, `<${tag}>`, `</${tag}>`);
    while (m) {
      out += `${s.slice(at, m.start)} `;
      at = m.end;
      m = pair(s, `<${tag}>`, `</${tag}>`, at);
    }
    s = out + s.slice(at);
  }
  return s;
}

// What the harness puts around pasted text, an id on both of its tags (`<pasted_content id="e6a9">`
// and `</pasted_content id="e6a9">`): the tags go, the text stays. Past this many characters after
// its name a `>` closes no such tag.
const PASTED = 'pasted_content';
const TAG_ROOM = 64;

// Where the next opening or closing tag named `name` starts and ends from `from` on, or null.
function nextTag(text, name, from) {
  for (let i = text.indexOf(name, from); i >= 0; i = text.indexOf(name, i + name.length)) {
    const start = text[i - 1] === '<' ? i - 1 : text.startsWith('</', i - 2) ? i - 2 : -1;
    const after = text[i + name.length];
    const close = text.slice(i + name.length, i + name.length + TAG_ROOM).indexOf('>');
    if (start >= 0 && close >= 0 && (after === '>' || after === ' ')) return { start, end: i + name.length + close + 1 };
  }
  return null;
}

// The text with each `<name …>` and `</name …>` tag taken out, what they held left in place.
export function untag(text, name) {
  let out = '';
  let at = 0;
  for (let tag = nextTag(text, name, 0); tag; tag = nextTag(text, name, at)) {
    out += `${text.slice(at, tag.start)} `;
    at = tag.end;
  }
  return out + text.slice(at);
}

// The next closing tag named `name` from `from` on, or null.
function nextClosing(text, name, from) {
  let tag = nextTag(text, name, from);
  while (tag && text[tag.start + 1] !== '/') tag = nextTag(text, name, tag.end);
  return tag;
}

// The text with each pasted block, its tags and what it holds, taken out (an unclosed one to the end):
// where the harness's own tags are looked for, so a tag that was pasted names no command.
export function withoutPastes(text) {
  let out = '';
  let at = 0;
  for (let tag = nextTag(text, PASTED, 0); tag; tag = nextTag(text, PASTED, at)) {
    out += text.slice(at, tag.start);
    const close = text[tag.start + 1] === '/' ? tag : nextClosing(text, PASTED, tag.end);
    at = close ? close.end : text.length;
  }
  return out + text.slice(at);
}

// Another session's message is a prompt from there; a teammate's joins the work at hand.
function message(text, m) {
  const rest = text.slice(m[0].length);
  const stop = rest.indexOf(`</${m[1]}>`);
  const body = (stop < 0 ? rest : rest.slice(0, stop)).replace(/\s+/g, ' ').trim();
  if (m[1] === 'teammate-message') return { kind: 'notice', text: clip(body, 200), status: 'message' };
  return { kind: 'prompt', text: `[다른 세션] ${body}`.trim() };
}

// What a turn's text says: a notice (a background task's end, with its summary and status, or a
// teammate's message), or a prompt, a slash command as `/name args` and a shell command as `! command`.
export function readPrompt(raw) {
  const text = String(raw ?? '');
  if (/^\s*<task-notification>/.test(text)) {
    return { kind: 'notice', text: clip(inner(text, 'summary'), 200), status: inner(text, 'status') };
  }
  const wrapped = WRAPPER.exec(text);
  if (wrapped) return message(text, wrapped);
  const outside = withoutPastes(text);
  const command = inner(outside, 'command-name');
  const shell = inner(outside, 'bash-input');
  const lead = command ? `${command} ${inner(text, 'command-args')}` : shell ? `! ${shell}` : '';
  return { kind: 'prompt', text: `${lead} ${strip(untag(text, PASTED))}`.slice(0, PROMPT_CAP).replace(/\s+/g, ' ').trim() };
}

// ── which files are plans ────────────────────────────────────────────────────

const PLAN_PATHS = [
  /\/\.omc\/plans\/[^/]+\.md$/,
  /\/docs\/superpowers\/plans\/[^/]+\.md$/,
  /\/\.claude\/plans\/[^/]+\.md$/,
  // A ralph PRD and ultragoal's goals wherever they sit: OMC_STATE_DIR moves OMC's state out of .omc (a mod cannot
  // read that variable), and a project may keep its PRD at the top. Only a file that parses as one becomes the plan.
  /\/prd\.json$/,
  /\/ultragoal\/goals\.json$/,
];
// Plan folders keep a plan's review rounds beside it (ralplan's `<plan>-critic-r2.md`,
// `architect-review-r1.md`) and OMC's open questions: a name that ends so is a weak plan, the plan only while the
// pane has no other.
const WEAK_NAMES = [/(?:^|[-_])(?:critic|architect|review|verdict|feedback)(?:-r\d+)?\.md$/i, /^open-questions\.md$/i];

/** What a path is to the pane: 'plan', 'weak' (a review round or open questions beside a plan), or null. */
export function planKind(path) {
  const p = String(path ?? '').replaceAll('\\', '/');
  if (!PLAN_PATHS.some((re) => re.test(p))) return null;
  return WEAK_NAMES.some((re) => re.test(p.split('/').at(-1))) ? 'weak' : 'plan';
}

export const isPlanPath = (path) => planKind(path) === 'plan';

// ── a plan file ──────────────────────────────────────────────────────────────

const PLAN_CAP = 256 * 1024;
// Past this a JSON file is no plan: a PRD or a goals file is far smaller, and each item costs a step.
const JSON_CAP = 512 * 1024;
// CRLF, CR alone or LF: no line keeps a CR, so a pattern that runs to a line's end cannot stop short
// of it and backtrack.
const LINE_END = /\r\n?|\n/;
const LINE_CAP = 1024;
const MAX_PLAN_STEPS = 50;
const BOM = /^\uFEFF/;
const fileName = (path) => String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
// Markdown's marks off a line: a link to its text, code spans' backticks, bold's asterisks.
const plain = (line) => line.replace(/\[([^[\]]*)\]\([^()]*\)/g, '$1').replace(/\*\*|`/g, '');
const step = (title, text, status) => ({
  title: clip(plain(clip(title, 400)), 60), text: clip(plain(clip(text || title, 400)), 200), status,
});

const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
// A map's own entry: a key like `constructor` finds nothing.
export const pick = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// ultragoal's states, and the ones like them; one it does not know shows no state.
const GOAL_STATUS = { complete: 'completed', completed: 'completed', in_progress: 'in_progress', active: 'in_progress',
  pending: 'pending', failed: 'failed', review_blocked: 'blocked', blocked: 'blocked' };

const storyStep = (st) => {
  const id = str(st.id);
  return { title: str(st.title) || id, text: [id, str(st.description)].filter(Boolean).join(': '), status: st.passes === true ? 'completed' : 'pending' };
};
const goalStep = (g) => ({ title: str(g.title) || str(g.id), text: str(g.objective), status: pick(GOAL_STATUS, str(g.status)) ?? null });

// A ralph PRD (`stories` or `userStories`, done where they pass) or ultragoal's goals; items that
// are not objects are passed over.
function jsonPlan(path, text) {
  if (text.length > JSON_CAP) return null;
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(d)) return null;
  const stories = d.stories ?? d.userStories;
  if (Array.isArray(stories)) {
    const items = stories.filter(isObject);
    const title = str(d.title) || [str(d.project), str(d.description)].filter(Boolean).join(': ') || fileName(path);
    return { title, records: items.map(storyStep), tree: jsonTree(items, storyTree) };
  }
  if (!Array.isArray(d.goals)) return null;
  const goals = d.goals.filter(isObject);
  return { title: 'ultragoal', records: goals.map(goalStep), tree: jsonTree(goals, goalTree) };
}

// The fence a line opens or closes (``` or ~~~), or ''. A run of backticks with a backtick after it
// opens inline code, not a fence (CommonMark).
function fenceMark(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return '';
  return m[1][0] === '`' && line.slice(m[0].length).includes('`') ? '' : m[1];
}

// The plan's lines as a reader sees them: a fenced code block's lines (to the fence that closes it,
// or the end) are blank, so they are no heading or item.
function proseLines(text) {
  let fence = '';
  return text.slice(0, PLAN_CAP).split(LINE_END).map((raw) => {
    const line = raw.slice(0, LINE_CAP);
    const mark = fenceMark(line);
    if (!fence) {
      fence = mark;
      return mark ? '' : line;
    }
    if (mark[0] === fence[0] && mark.length >= fence.length && !line.slice(line.indexOf(mark) + mark.length).trim()) fence = '';
    return '';
  });
}

// The headings, each with where its section ends (the next heading of its level or above) and the
// headings right under it: one pass, with a stack of the sections still open.
function outline(lines) {
  const heads = [];
  const open = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,6})[ \t]+([^\r\n]*)/.exec(line);
    if (!m) return;
    const h = { i, level: m[1].length, text: m[2].trim(), end: lines.length, subs: [] };
    while (open.length && open.at(-1).level >= h.level) open.pop().end = i;
    open.at(-1)?.subs.push(h);
    open.push(h);
    heads.push(h);
  });
  return heads;
}

// How far along a section's checkboxes say it is; null where it has none.
function boxStatus(lines, h) {
  let all = 0;
  let done = 0;
  for (let i = h.i + 1; i < h.end; i++) {
    const m = /^\s*[-*+][ \t]+\[([ xX])\]/.exec(lines[i]);
    if (!m) continue;
    all += 1;
    if (m[1] !== ' ') done += 1;
  }
  if (!all) return null;
  return done === 0 ? 'pending' : done === all ? 'completed' : 'in_progress';
}

const TASK_HEAD = /^Task\s+\d+\s*[:.]\s*/i;
const STEP_HEAD = /^(?:(?:phase|step|stage|milestone|sprint)\s*[\d.]+|단계\s*\d+|\d+(?:\.\d+)?\s*단계)/i;

// Two or more headings of one level named as steps (Phase 1, Step 2, 3단계): the shallowest such level.
function stepHeadings(heads) {
  const byLevel = new Map();
  for (const h of heads) {
    if (!STEP_HEAD.test(h.text)) continue;
    if (!byLevel.has(h.level)) byLevel.set(h.level, []);
    byLevel.get(h.level).push(h);
  }
  const level = [...byLevel.keys()].sort((a, b) => a - b).find((l) => byLevel.get(l).length >= 2);
  return byLevel.get(level) ?? [];
}

// Rules 1 and 2: superpowers' `Task N:` headings, else headings named as steps; each as far along
// as the checkboxes in its section.
function headedSteps(lines, heads) {
  const tasks = heads.filter((h) => TASK_HEAD.test(h.text));
  return (tasks.length ? tasks : stepHeadings(heads))
    .map((h) => ({ title: h.text.replace(TASK_HEAD, ''), text: h.text, status: boxStatus(lines, h) }));
}

// Sections whose checkboxes test the work rather than lay out its steps.
const CRITERIA = /수용\s*기준|인수\s*기준|완료\s*(?:기준|조건|판정)|검증\s*기준|acceptance|definition of done|criteria/i;

// Rule 3: checkboxes at the top level of the text, outside the criteria sections.
function boxSteps(lines, heads) {
  const marks = new Int32Array(lines.length + 1);
  for (const h of heads) {
    if (!CRITERIA.test(h.text)) continue;
    marks[h.i] += 1;
    marks[h.end] -= 1;
  }
  const out = [];
  let depth = 0;
  lines.forEach((line, i) => {
    depth += marks[i];
    const m = depth > 0 ? null : /^[-*+][ \t]+\[([ xX])\][ \t]+([^\r\n]*)/.exec(line);
    if (m) out.push({ title: m[2], text: m[2], status: m[1] === ' ' ? 'pending' : 'completed' });
  });
  return out;
}

const STEPS_SECTION = /단계|(?:작업|집행|실행|구현|진행)\s*(?:순서|흐름|계획)|\bsteps?\b|implementation|phases?|\btasks?\b|milestones?|로드맵|road ?map/i;

// The numbered items of a section, up to `stop`.
function numbered(lines, h, stop) {
  const out = [];
  for (let i = h.i + 1; i < stop; i++) {
    const m = /^\d+[.)][ \t]+([^\r\n]*)/.exec(lines[i]);
    if (m) out.push({ title: m[1], text: m[1], status: null });
  }
  return out;
}

// Rule 4: the first section named for the steps: its own numbered items (those before its first
// sub-heading), else its sub-headings.
function sectionSteps(lines, heads) {
  for (const h of heads) {
    if (h.level === 1 || STEP_HEAD.test(h.text) || !STEPS_SECTION.test(h.text)) continue;
    const items = numbered(lines, h, h.subs[0]?.i ?? h.end);
    if (items.length) return items;
    if (h.subs.length) return h.subs.map((x) => ({ title: x.text, text: x.text, status: boxStatus(lines, x) }));
  }
  return [];
}

function markdownPlan(path, text) {
  const lines = proseLines(text);
  const heads = outline(lines);
  let records = headedSteps(lines, heads);
  if (!records.length) records = boxSteps(lines, heads);
  if (!records.length) records = sectionSteps(lines, heads);
  const tree = planTree(text);
  return { title: heads.find((h) => h.level === 1)?.text || fileName(path), records, cut: text.length > PLAN_CAP, tree };
}

// ── a plan file as a tree ────────────────────────────────────────────────────

// Past these a tree takes no more: nodes, nested list levels, the raw text a node gathers, a code
// line's characters, a code block's lines.
const MAX_NODES = 3000;
const MAX_DEPTH = 12;
const TEXT_CAP = 1000;
const CODE_CAP = 200;
const MAX_CODE_LINES = 200;
// A first line `---` opens YAML front matter only when a closing line comes within this many lines;
// else it is a rule, and the plan below it is no front matter.
const FRONT_LINES = 60;

const ITEM_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+([^\r\n]*)$/;
const BOX_MARK = /^\[([ xX])\][ \t]+/;
const RULE_LINE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_LINE = /^[ \t]*\|/;
// A table's rule row (`|---|:--:|`): dashes, colons, bars and blanks only. A test per character, so
// no pattern backtracks over the line.
const isTableRule = (line) => line.includes('-') && !/[^ \t|:-]/.test(line);
const HEAD_LINE = /^ {0,3}(#{1,6})(?:[ \t]+([^\r\n]*))?$/;
const FENCE_LINE = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)$/;

// A node's own text: a link's words, no code ticks or bold marks, one line of plain text.
const prose = (raw) => clip(plain(String(raw).slice(0, TEXT_CAP * 4)), TEXT_CAP);
const indentWidth = (lead) => lead.replace(/\t/g, '    ').length;
const treeNode = (kind, extra) => ({ kind, text: '', children: [], ...extra });

// A heading's words without the closing run of `#` that ATX allows after a space.
function headWords(raw) {
  const text = String(raw ?? '').trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  return end === text.length || (end > 0 && text[end - 1] !== ' ' && text[end - 1] !== '\t') ? text : text.slice(0, end).trimEnd();
}

// A code line as written: its leading spaces kept, tabs as two spaces, control characters gone.
function codeText(line) {
  const raw = line.slice(0, CODE_CAP * 2).replace(/\t/g, '  ');
  const s = (raw.toWellFormed?.() ?? raw).replace(UNDRAWABLE, '');
  return [...s].slice(0, CODE_CAP).join('') || ' ';
}

const treeState = () => ({ root: [], heads: [], items: [], open: null, table: null, code: null, count: 0, cut: false,
  titled: false, front: false, comment: false });
const sectionOf = (st) => st.heads.at(-1)?.node.children ?? st.root;

// Puts a node under the deepest open list item indented less than it, else under the section; false
// once the tree holds all the nodes it takes.
function attach(st, node, indent) {
  if (st.count >= MAX_NODES) {
    st.cut = true;
    st.open = null;
    return false;
  }
  st.count += 1;
  while (st.items.length && st.items.at(-1).indent >= indent) st.items.pop();
  (st.items.at(-1)?.node.children ?? sectionOf(st)).push(node);
  return true;
}

// Text that a node gathers line by line, joined once the tree is read.
function gather(node, text) {
  if (node.size >= TEXT_CAP * 4) return;
  node.parts.push(text);
  node.size += text.length + 1;
}

function headingLine(st, line) {
  const m = HEAD_LINE.exec(line);
  const level = m[1].length;
  const words = headWords(m[2]);
  st.items = [];
  st.open = null;
  if (level === 1 && !st.titled && !st.count && !st.heads.length) {
    st.titled = true;
    return;
  }
  st.titled = true;
  while (st.heads.length && st.heads.at(-1).level >= level) st.heads.pop();
  const node = treeNode('head', { text: prose(words), level });
  if (!attach(st, node, 0)) return;
  st.items = [];
  st.heads.push({ level, node });
}

function itemLine(st, line) {
  const m = ITEM_LINE.exec(line);
  let indent = indentWidth(m[1]);
  let text = m[3];
  const box = BOX_MARK.exec(text);
  const status = box ? (box[1] === ' ' ? 'pending' : 'completed') : null;
  if (box) text = text.slice(box[0].length);
  const deepest = st.items.at(-1);
  if (st.items.length >= MAX_DEPTH && deepest.indent < indent) indent = deepest.indent;
  const node = treeNode('item', { marker: /\d/.test(m[2]) ? m[2] : status ? '' : '-', status, parts: [text], size: text.length });
  if (!attach(st, node, indent)) return;
  st.items.push({ indent, node });
  st.open = node;
  st.titled = true;
}

function textLine(st, line) {
  const text = line.trim().replace(/^>[ \t]?/, '');
  st.titled = true;
  if (st.open) {
    gather(st.open, text);
    return;
  }
  const node = treeNode('text', { parts: [text], size: text.length });
  if (attach(st, node, indentWidth(/^[ \t]*/.exec(line)[0]))) st.open = node;
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).join(' | ');

function tableLine(st, line) {
  st.open = null;
  st.titled = true;
  if (!st.table) {
    const head = prose(cellsOf(line));
    const node = treeNode('table', { head, name: head, rows: 0 });
    st.table = attach(st, node, indentWidth(/^[ \t]*/.exec(line)[0])) ? node : { rows: 0, children: [], skip: true };
    return;
  }
  if (isTableRule(line) && !st.table.rows && !st.table.ruled) {
    st.table.ruled = true;
    return;
  }
  st.table.rows += 1;
  if (!st.table.skip && st.count < MAX_NODES) {
    st.count += 1;
    st.table.children.push(treeNode('row', { text: prose(cellsOf(line)) }));
  } else st.cut = true;
}

function finishTable(st) {
  const t = st.table;
  st.table = null;
  if (t && !t.skip) t.text = `표: ${t.head} (${t.rows}행)`;
}

// A fence opens a code block; a backtick fence with a backtick after it is inline code (CommonMark).
function fenceOpen(st, line) {
  const m = FENCE_LINE.exec(line);
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return false;
  st.open = null;
  st.titled = true;
  const info = prose(m[3].trim().split(/[ \t]/)[0] ?? '');
  const node = treeNode('code', { info, name: info, lines: 0 });
  st.code = { node, mark: m[2], kept: attach(st, node, indentWidth(m[1])) };
  return true;
}

function codeLine(st, line) {
  const { code } = st;
  const close = FENCE_LINE.exec(line);
  if (close && close[2][0] === code.mark[0] && close[2].length >= code.mark.length && !close[3].trim()) {
    finishCode(st);
    return;
  }
  code.node.lines += 1;
  if (code.kept && st.count >= MAX_NODES) st.cut = true;
  if (!code.kept || code.node.children.length >= MAX_CODE_LINES || st.count >= MAX_NODES) return;
  st.count += 1;
  code.node.children.push(treeNode('code-line', { text: codeText(line) }));
}

function finishCode(st) {
  const { node } = st.code;
  st.code = null;
  const more = node.lines - node.children.length;
  if (more > 0) node.children.push(treeNode('text', { text: `외 ${more}줄` }));
  node.text = `코드${node.info ? ` ${node.info}` : ''} (${node.lines}줄)`;
}

// A YAML front matter block at the top, and HTML comments, are no part of the plan as it reads.
function skipped(st, line, i) {
  const t = line.trim();
  if (st.front) {
    if (i > 0 && (t === '---' || t === '...')) st.front = false;
    return true;
  }
  if (st.comment) {
    st.comment = !line.includes('-->');
    return true;
  }
  if (!t.startsWith('<!--')) return false;
  st.comment = !t.slice(4).includes('-->');
  return true;
}

const LINE_KINDS = [
  [(line) => !line.trim(), (st) => { st.open = null; }],
  [(line) => TABLE_LINE.test(line), tableLine],
  [(line) => HEAD_LINE.test(line), headingLine],
  [(line) => RULE_LINE.test(line), (st) => { st.open = null; }],
  [(line) => ITEM_LINE.test(line), itemLine],
  [() => true, textLine],
];

function treeLine(st, raw, i) {
  const line = raw.slice(0, LINE_CAP);
  if (!st.code && skipped(st, line, i)) return;
  if (st.code) {
    codeLine(st, line);
    return;
  }
  if (st.table && !TABLE_LINE.test(line)) finishTable(st);
  if (fenceOpen(st, line)) return;
  const kind = LINE_KINDS.find(([test]) => test(line));
  kind[1](st, line);
}

// After the read: gathered text joined and cleaned, each section's checkboxes counted.
function settle(nodes) {
  let all = 0;
  let done = 0;
  for (const n of nodes) {
    if (n.parts) n.text = prose(n.parts.join(' '));
    delete n.parts;
    delete n.size;
    const below = settle(n.children);
    if (below.all && !n.status) n.count = `${below.done}/${below.all}`;
    all += below.all + (n.status ? 1 : 0);
    done += below.done + (n.status === 'completed' ? 1 : 0);
  }
  return { all, done };
}

// FNV-1a: a short name for a node's place in the plan.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// Each node's id comes from its parent's, its kind and its first words (a table's header, a code
// block's language: not their counts, which grow as they are written), and how many before it under
// the same parent share those: the same section keeps its id (and so stays open) when the plan is
// written again around it.
// Two places whose names hash alike (a plan can be written so) are told apart by how many came before:
// `<id>_1`, `<id>_2`. A hashed name holds no `_`, so the marked ones meet no other.
export function nameNodes(nodes, parent, taken, h = hash) {
  const seen = new Map();
  for (const n of nodes) {
    const base = `${n.kind}:${String(n.name ?? n.text).slice(0, 40)}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const id = `n${h(`${parent}/${base}#${nth}`)}`;
    const before = taken.get(id) ?? 0;
    taken.set(id, before + 1);
    n.id = before ? `${id}_${before}` : id;
    nameNodes(n.children, n.id, taken, h);
  }
}

// A markdown plan as a tree: `{ nodes, cut }`, each node `{ id, kind, text, children }` with
// `marker` (a list item's number or `-`), `status` (a checkbox's) or `count` (`2/5` for the
// checkboxes under it), and `cut` true where the plan held more nodes than the tree takes. A
// level-1 heading with nothing before it is the plan's title, not a node.
export function planTree(text) {
  const st = treeState();
  const lines = String(text).replace(BOM, '').slice(0, PLAN_CAP).split(LINE_END);
  if (lines.at(-1) === '') lines.pop();
  const isEnd = (l) => l.trim() === '---' || l.trim() === '...';
  st.front = lines[0]?.trim() === '---' && lines.slice(1, FRONT_LINES).some(isEnd);
  lines.forEach((raw, i) => treeLine(st, raw, i));
  if (st.code) finishCode(st);
  finishTable(st);
  settle(st.root);
  nameNodes(st.root, 'n', new Map());
  return { nodes: st.root, cut: st.cut };
}

// ── a JSON plan as a tree ────────────────────────────────────────────────────

const textNode = (text) => treeNode('text', { text: prose(text) });

// A node with the given texts under it, those that are not empty, as far as the tree takes them.
function withTexts(node, texts, budget) {
  for (const t of texts) if (t && budget.left-- > 0) node.children.push(textNode(t));
  return node;
}

function storyTree(st, budget) {
  const id = str(st.id);
  const node = treeNode('story', { text: prose([id, str(st.title)].filter(Boolean).join(' ')), status: st.passes === true ? 'completed' : 'pending' });
  withTexts(node, [str(st.description)], budget);
  const criteria = Array.isArray(st.acceptanceCriteria) ? st.acceptanceCriteria.map(str).filter(Boolean) : [];
  if (criteria.length && budget.left-- > 0) {
    const group = treeNode('group', { text: `수용 기준 (${criteria.length})` });
    for (const c of criteria) if (budget.left-- > 0) group.children.push(treeNode('item', { text: prose(c), marker: '-' }));
    node.children.push(group);
  }
  return withTexts(node, [str(st.notes) && `메모: ${str(st.notes)}`], budget);
}

function goalTree(g, budget) {
  const node = treeNode('story', { text: prose(str(g.title) || str(g.id)), status: pick(GOAL_STATUS, str(g.status)) ?? null });
  return withTexts(node, [str(g.objective), str(g.evidence) && `근거: ${str(g.evidence)}`, str(g.failureReason) && `실패 이유: ${str(g.failureReason)}`], budget);
}

// A ralph PRD's stories or ultragoal's goals as a tree, the same shape as a markdown plan's.
function jsonTree(items, make) {
  const budget = { left: MAX_NODES };
  const nodes = [];
  for (const it of items) if (budget.left-- > 0) nodes.push(make(it, budget));
  nameNodes(nodes, 'n', new Map());
  return { nodes, cut: budget.left < 0 };
}

// A plan file as `{ title, steps, total, done, hasStates, cut, tree, treeCut }`: its first 50 steps,
// each `{ title, text, status }` (status null where the file says none), how many it has and how many
// are done, whether the file was longer than what was read, the whole plan as a tree (planTree) and
// whether the tree left nodes out. Null for a JSON file that is no plan.
export function parsePlan(path, text) {
  const body = String(text).replace(BOM, '');
  const plan = /\.json$/i.test(String(path)) ? jsonPlan(path, body) : markdownPlan(path, body);
  if (!plan) return null;
  const { records } = plan;
  return {
    title: clip(plain(clip(plan.title, 400)), 60),
    steps: records.slice(0, MAX_PLAN_STEPS).map((r) => step(r.title, r.text, r.status)),
    total: records.length,
    done: records.filter((r) => r.status === 'completed').length,
    hasStates: records.some((r) => r.status),
    cut: Boolean(plan.cut),
    tree: plan.tree.nodes,
    treeCut: plan.tree.cut,
  };
}
