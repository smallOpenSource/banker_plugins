/**
 * What banker's /progress pane (progress.mjs) reads from text: a prompt as the person wrote it, and
 * a plan file as steps. Plain functions of strings; the pane reads the files itself.
 *
 * A turn's text comes with the harness's tags: a slash command arrives as `<command-name>` and
 * `<command-args>`, a background task's end as `<task-notification>`, a shell command as
 * `<bash-input>`. Claude 5 models get no task list tool in Claude Code 2.1.296, so the plan a
 * session writes (ralplan's, superpowers', ralph's PRD, ultragoal's goals) is what shows the work
 * ahead.
 *
 * Every mod shares the engine's one hooks worker, and a plan may come from a cloned repository, so
 * no step here takes more than linear time: a plan is read to its first 256 KiB and each line to its
 * first 1 KiB, tags are found with indexOf, and no pattern backtracks over a line.
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

// One line of plain text, cut to `n` characters. Control characters and lone surrogates go too: the
// engine refuses a drawing that holds either.
export const clip = (text, n) => {
  const raw = String(text ?? '');
  const s = (raw.toWellFormed?.() ?? raw).replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [];
  for (const c of s) {
    chars.push(c);
    if (chars.length > n) break;
  }
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

// ── a prompt's text ──────────────────────────────────────────────────────────

// Past this a prompt has nothing more for a title or a description.
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
  const text = String(raw ?? '').slice(0, PROMPT_CAP);
  if (/^\s*<task-notification>/.test(text)) {
    return { kind: 'notice', text: clip(inner(text, 'summary'), 200), status: inner(text, 'status') };
  }
  const wrapped = WRAPPER.exec(text);
  if (wrapped) return message(text, wrapped);
  const command = inner(text, 'command-name');
  const shell = inner(text, 'bash-input');
  const lead = command ? `${command} ${inner(text, 'command-args')}` : shell ? `! ${shell}` : '';
  return { kind: 'prompt', text: `${lead} ${strip(text)}`.replace(/\s+/g, ' ').trim() };
}

// ── which files are plans ────────────────────────────────────────────────────

const PLAN_PATHS = [
  /\/\.omc\/plans\/[^/]+\.md$/,
  /\/docs\/superpowers\/plans\/[^/]+\.md$/,
  /\/\.claude\/plans\/[^/]+\.md$/,
  /\/\.omc\/(?:state\/(?:[^/]+\/)*)?prd\.json$/,
  /\/\.omc\/ultragoal\/goals\.json$/,
];
// Plan folders keep a plan's review rounds (ralplan's critic and architect) and OMC's open questions
// beside it: those are no plan.
const NOT_A_PLAN = /critic|architect|review|verdict|feedback|open-questions/i;

export const isPlanPath = (path) => {
  const p = String(path ?? '').replaceAll('\\', '/');
  return PLAN_PATHS.some((re) => re.test(p)) && !NOT_A_PLAN.test(p.split('/').at(-1));
};

// ── a plan file ──────────────────────────────────────────────────────────────

const PLAN_CAP = 256 * 1024;
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
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// ultragoal's states, and the ones like them; one it does not know shows no state.
const GOAL_STATUS = { complete: 'completed', completed: 'completed', in_progress: 'in_progress', active: 'in_progress',
  pending: 'pending', failed: 'failed', review_blocked: 'blocked', blocked: 'blocked' };

const storyStep = (st) => {
  const id = str(st.id);
  return { title: str(st.title) || id, text: [id, str(st.description)].filter(Boolean).join(': '), status: st.passes === true ? 'completed' : 'pending' };
};
const goalStep = (g) => ({ title: str(g.title) || str(g.id), text: str(g.objective), status: GOAL_STATUS[str(g.status)] ?? null });

// A ralph PRD (`stories` or `userStories`, done where they pass) or ultragoal's goals; items that
// are not objects are passed over.
function jsonPlan(path, text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(d)) return null;
  const stories = d.stories ?? d.userStories;
  if (Array.isArray(stories)) return { title: str(d.title) || str(d.project) || fileName(path), records: stories.filter(isObject).map(storyStep) };
  if (Array.isArray(d.goals)) return { title: 'ultragoal', records: d.goals.filter(isObject).map(goalStep) };
  return null;
}

// The plan's lines as a reader sees them: a fenced code block's lines (``` or ~~~, to the fence that
// closes it or the end) are blank, so they are no heading or item.
function proseLines(text) {
  let fence = '';
  return text.slice(0, PLAN_CAP).split(/\r?\n/).map((raw) => {
    const line = raw.slice(0, LINE_CAP);
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
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

function numbered(lines, h) {
  const out = [];
  for (let i = h.i + 1; i < h.end; i++) {
    const m = /^\d+[.)][ \t]+([^\r\n]*)/.exec(lines[i]);
    if (m) out.push({ title: m[1], text: m[1], status: null });
  }
  return out;
}

// Rule 4: the first section named for the steps: its sub-headings, else its numbered items.
function sectionSteps(lines, heads) {
  for (const h of heads) {
    if (h.level === 1 || STEP_HEAD.test(h.text) || !STEPS_SECTION.test(h.text)) continue;
    if (h.subs.length) return h.subs.map((x) => ({ title: x.text, text: x.text, status: boxStatus(lines, x) }));
    const items = numbered(lines, h);
    if (items.length) return items;
  }
  return [];
}

function markdownPlan(path, text) {
  const lines = proseLines(text);
  const heads = outline(lines);
  let records = headedSteps(lines, heads);
  if (!records.length) records = boxSteps(lines, heads);
  if (!records.length) records = sectionSteps(lines, heads);
  return { title: heads.find((h) => h.level === 1)?.text || fileName(path), records, cut: text.length > PLAN_CAP };
}

// A plan file as `{ title, steps, total, done, hasStates, cut }`: its first 50 steps, each
// `{ title, text, status }` (status null where the file says none), how many it has and how many
// are done, and whether the file was longer than what was read. Null for a JSON file that is no plan.
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
  };
}
