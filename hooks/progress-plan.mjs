/**
 * What banker's /progress pane (progress.mjs) reads from text: a prompt as the person wrote it, and
 * a plan file as steps. Plain functions of strings; the pane reads the files itself.
 *
 * A turn's text comes with the harness's tags: a slash command arrives as `<command-name>` and
 * `<command-args>`, a background task's end as `<task-notification>`, a shell command as
 * `<bash-input>`. Claude 5 models get no task list tool in Claude Code 2.1.296, so the plan a
 * session writes (ralplan's, superpowers', ralph's PRD, ultragoal's goals) is what shows the work
 * ahead.
 */

// One line of plain text, cut to `n` characters. Control characters go too: a pasted escape
// sequence is not text to show.
export const clip = (text, n) => {
  const s = String(text ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

// Characters a terminal draws two cells wide: Hangul, CJK, fullwidth forms and wide emoji.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;

// The cells a line of text takes on a terminal.
export const cells = (text) => [...String(text)].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0);

// A line cut to `n` cells, its end an ellipsis where it was cut.
export function fit(text, n) {
  if (cells(text) <= n) return text;
  let out = '';
  for (const c of text) {
    if (cells(out + c) > n - 1) break;
    out += c;
  }
  return n > 0 ? `${out}…` : '';
}

// ── a prompt's text ──────────────────────────────────────────────────────────

// Tags the harness wraps around what it adds to a prompt: they go with what they hold.
const HARNESS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'bash-stdout', 'bash-stderr', 'command-message', 'command-name', 'command-args', 'bash-input'];

const inner = (text, tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim() ?? '';

const strip = (text) => HARNESS.reduce((t, tag) => t.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), ' '), text);

// What a turn's text says: a notice of a background task's end (`kind: 'notice'`, its summary), or
// a prompt, a slash command as `/name args` and a shell command as `! command`.
export function readPrompt(raw) {
  const text = String(raw ?? '');
  if (/^\s*<task-notification>/.test(text)) {
    return { kind: 'notice', text: clip(inner(text, 'summary'), 200), status: inner(text, 'status') };
  }
  const command = inner(text, 'command-name');
  const shell = inner(text, 'bash-input');
  const lead = command ? `${command} ${inner(text, 'command-args')}` : shell ? `! ${shell}` : '';
  return { kind: 'prompt', text: `${lead} ${strip(text)}`.replace(/\s+/g, ' ').trim() };
}

// ── a plan file ──────────────────────────────────────────────────────────────

const PLAN_PATHS = [
  /\/\.omc\/plans\/[^/]+\.md$/,
  /\/docs\/superpowers\/plans\/[^/]+\.md$/,
  /\/\.claude\/plans\/[^/]+\.md$/,
  /\/\.omc\/(?:state\/(?:[^/]+\/)*)?prd\.json$/,
  /\/\.omc\/ultragoal\/goals\.json$/,
];

export const isPlanPath = (path) => {
  const p = String(path ?? '').replaceAll('\\', '/');
  return PLAN_PATHS.some((re) => re.test(p));
};

const MAX_PLAN_STEPS = 50;
const fileName = (path) => String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
// Markdown's marks off a line: emphasis, code, links, a heading's or an item's lead.
const plain = (line) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|[`*]/g, '');
const step = (title, text, status) => ({ title: clip(plain(title), 60), text: clip(plain(text || title), 200), status });

const GOAL_STATUS = { complete: 'completed', completed: 'completed', done: 'completed', active: 'in_progress', in_progress: 'in_progress' };

function storySteps(stories) {
  return stories.map((st) => step(String(st.title ?? st.id ?? ''), [st.id, st.description].filter(Boolean).join(': '),
    st.passes ? 'completed' : 'pending'));
}

function goalSteps(goals) {
  return goals.map((g) => step(String(g.title ?? g.id ?? ''), g.objective, GOAL_STATUS[g.status] ?? g.status ?? 'pending'));
}

// A ralph PRD (`stories` or `userStories`, done where they pass) or ultragoal's goals.
function jsonPlan(path, text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!d || Array.isArray(d) || typeof d !== 'object') return null;
  const stories = d.stories ?? d.userStories;
  if (Array.isArray(stories)) return { title: clip(d.title || d.project || fileName(path), 60), steps: storySteps(stories) };
  if (Array.isArray(d.goals)) return { title: 'ultragoal', steps: goalSteps(d.goals) };
  return null;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BOX = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const STEPS_SECTION = /단계|작업\s*(순서|흐름|계획)|(구현|실행)\s*(순서|계획)|\bsteps?\b|implementation|phases?|\btasks?\b|milestones?|로드맵/i;

const headings = (lines) => lines.flatMap((line, i) => {
  const m = HEADING.exec(line);
  return m ? [{ i, level: m[1].length, text: m[2].trim() }] : [];
});

// Where the section under the heading `h` ends: the next heading of its level or above.
const sectionEnd = (lines, heads, h) => heads.find((x) => x.i > h.i && x.level <= h.level)?.i ?? lines.length;
const section = (lines, heads, h) => lines.slice(h.i + 1, sectionEnd(lines, heads, h));

// Rule 1: superpowers' `### Task N:` headings, each as far along as its checkboxes.
function taskSteps(lines, heads) {
  const tasks = heads.filter((h) => /^Task\s+\d+\s*[:.]/i.test(h.text));
  return tasks.map((h) => {
    const boxes = section(lines, heads, h).flatMap((l) => /^\s*[-*]\s+\[([ xX])\]/.exec(l)?.[1] ?? []);
    const done = boxes.filter((b) => b !== ' ').length;
    const status = done === 0 ? 'pending' : done === boxes.length ? 'completed' : 'in_progress';
    return step(h.text.replace(/^Task\s+\d+\s*[:.]\s*/i, ''), h.text, status);
  });
}

// Rule 2: checkboxes at the top level of the text.
const boxSteps = (lines) => lines.flatMap((l) => {
  const m = BOX.exec(l);
  return m ? [step(m[2], m[2], m[1] === ' ' ? 'pending' : 'completed')] : [];
});

// Rule 3: the first section named for the steps that has numbered items, else sub-headings.
function sectionSteps(lines, heads) {
  for (const h of heads.filter((x) => x.level > 1 && STEPS_SECTION.test(x.text))) {
    const items = section(lines, heads, h).flatMap((l) => /^\d+[.)]\s+(.*)$/.exec(l)?.[1] ?? []);
    if (items.length) return items.map((t) => step(t, t, null));
    const end = sectionEnd(lines, heads, h);
    const subs = heads.filter((x) => x.i > h.i && x.i < end && x.level === h.level + 1);
    if (subs.length) return subs.map((x) => step(x.text, x.text, null));
  }
  return [];
}

function markdownPlan(path, text) {
  const lines = text.split(/\r?\n/);
  const heads = headings(lines);
  const title = heads.find((h) => h.level === 1)?.text;
  const found = [taskSteps(lines, heads), boxSteps(lines), sectionSteps(lines, heads)].find((s) => s.length) ?? [];
  return { title: clip(plain(title || fileName(path)), 60), steps: found };
}

// A plan file as `{ title, steps }`, each step `{ title, text, status }` (status null where the file
// says none), or null for a JSON file that is no plan.
export function parsePlan(path, text) {
  const plan = /\.json$/i.test(String(path)) ? jsonPlan(path, String(text)) : markdownPlan(path, String(text));
  if (plan) plan.steps = plan.steps.slice(0, MAX_PLAN_STEPS);
  return plan;
}
