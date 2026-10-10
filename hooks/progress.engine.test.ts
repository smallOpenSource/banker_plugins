// Runs progress.mjs inside the engine's own test kit: claude plugin test <copy of the plugin folder>.
// hooks/progress.test.mjs covers the module against a stand-in engine (node --test); this file holds
// it to what the engine itself accepts and routes: the command's registration and run, the pane's
// open and close, and the drawing a terminal gets, pressed as a person would.
import { expect, test } from 'claude-code/testing'

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const PANE = 'banker-progress'

// The engine beneath the plugins: the commands it registered, the panes it holds open (each with
// whether it is shown; false is a tab behind another plugin's pane), the opens it was asked for and
// the lines logged. As in Claude Code 2.1.296, an open resolves to nothing and raises a pane only
// with `focus`. `refuse` names a command it will not register; `panesDeny` refuses the pane list.
type Below = { tool?: (e: any) => any; refuse?: string; panesDeny?: string }
const answer = (e: any): any => (e.tool === 'Bash' ? { result: {}, text: 'exit 1', isError: true } : { result: {}, text: 'ok' })

function beneath(on: any, { tool = answer, refuse, panesDeny }: Below = {}) {
  const registered: { name: string; immediate?: true; argumentHint?: string }[] = []
  const open = new Map<string, boolean>()
  const opens: any[] = []
  const logged: string[] = []
  on('session.version', () => ({ value: { version: '2.1.296', base: '2.1.296' } }))
  on('command.register', (_: unknown, e: any) => {
    if (e.name === refuse) return { deny: 'taken by another plugin' }
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', (_: unknown, e: any) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => (panesDeny ? { deny: panesDeny } : { value: [...open].map(([id, isShown]) => ({ id, title: '진행 상황', isShown, isFocused: false, isPlaced: true })) }))
  on('ui.open', (_: unknown, e: any) => {
    opens.push(e)
    open.set(e.id, !open.has(e.id) || open.get(e.id) === true || e.focus === true)
    return { value: undefined }
  })
  on('ui.close', (_: unknown, e: any) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'engine' }))
  on('tool.call', (_: unknown, e: any) => tool(e))
  return { registered, open, opens, logged }
}

const mountPane = ($: any) => $.ui.mount({
  plugin: 'banker', surface: 'terminal', component: 'Pane', requestId: PANE,
  props: { title: '진행 상황', isFocused: false, bodyColumns: 60, placement: 'dock' },
})

test('it registers /progress to run mid-turn, and the command toggles the pane', async ($, on) => {
  const { registered, open } = beneath(on)
  await $.session.start(START)
  expect(registered).toContainEqual(expect.objectContaining({ name: 'progress', immediate: true, argumentHint: '[show | on | off]' }))

  expect(await $.command.run({ command: 'progress', args: '' })).toEqual({})
  expect(open.has(PANE)).toBe(true)
  await $.command.run({ command: 'progress', args: 'show' })
  expect(open.has(PANE)).toBe(false)
  await $.command.run({ command: 'progress', args: 'on' })
  await $.command.run({ command: 'progress', args: 'on' })
  expect(open.has(PANE)).toBe(true)
  await $.command.run({ command: 'progress', args: 'off' })
  expect(open.has(PANE)).toBe(false)
  expect((await $.command.run({ command: 'progress', args: 'toggle' })).text).toMatch(/사용법/)
})

test('show raises the pane from behind another plugin\'s pane instead of closing it', async ($, on) => {
  const { open, opens } = beneath(on)
  await $.session.start(START)
  await $.command.run({ command: 'progress', args: '' })
  expect(opens[0].focus).toBeUndefined()
  open.set(PANE, false)
  await $.command.run({ command: 'progress', args: 'show' })
  expect(open.get(PANE)).toBe(true)
  expect(opens.at(-1)).toEqual(expect.objectContaining({ id: PANE, focus: true }))
})

test('the markdown fallback\'s name opens the pane too, so it never reaches the model', async ($, on) => {
  const { open } = beneath(on)
  await $.session.start(START)
  await $.command.run({ command: 'banker:progress', args: '' })
  expect(open.has(PANE)).toBe(true)
})

test('a command whose hook fails answers in words, so the fallback beneath never runs', async ($, on) => {
  beneath(on, { panesDeny: 'pane list unavailable' })
  await $.session.start(START)
  for (const command of ['progress', 'banker:progress']) {
    expect((await $.command.run({ command, args: '' })).text).toMatch(/^진행 상황 패널을 바꾸지 못했습니다\(/)
  }
})

test('a /progress the engine will not register is logged, and the session still starts', async ($, on) => {
  const { registered, logged } = beneath(on, { refuse: 'progress' })
  expect(await $.session.start(START)).toEqual({ cwd: '/work' })
  expect(registered.map((spec) => spec.name)).toEqual(['graceful-pause'])
  expect(logged.filter((line) => line.includes('/progress'))).toEqual([expect.stringMatching(/^\/progress 를 등록하지 못했습니다/)])
})

test('the pane lists the prompt as a step, folds its calls under the arrow, and describes what is pressed', async ($, on) => {
  beneath(on)
  await $.session.start(START)
  const ui = await mountPane($)
  expect((await ui.find({ key: 'idle' }))?.text).toBe('진행 중인 작업 없음')

  await $.turn.start({ text: 'README 를 고쳐 줘', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/README.md' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect((await ui.find({ key: 't-t1' }))?.text).toBe('README 를 고쳐 줘')
  expect(await ui.find({ key: 'c-1' })).toBeUndefined()

  await ui.press({ key: 'arrow-t-t1' })
  expect((await ui.find({ key: 'c-1' }))?.text).toBe('Read docs/README.md')
  expect((await ui.find({ key: 'row-c-2' }))?.text).toContain('실패')

  await ui.press({ key: 't-t1' })
  expect((await ui.find({ key: 'about' }))?.text).toMatch(/요청: README 를 고쳐 줘\. 진행 중, \d+초, 도구 호출 2회\(실패 1회\)\./)
  await ui.press({ key: 'c-2' })
  expect((await ui.find({ key: 'about' }))?.text).toMatch(/^Bash: npm test\. 실패, \d+초\.$/)

  await ui.press({ key: 'arrow-t-t1' })
  expect(await ui.find({ key: 'c-1' })).toBeUndefined()
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  expect((await ui.find({ key: 'row-t-t1' }))?.text).toContain('완료')
  await ui.unmount()
})

test('a task list Claude keeps replaces the prompts as steps', async ($, on) => {
  beneath(on, { tool: (e: any) => (e.tool === 'TaskCreate' ? { result: { task: { id: '7', subject: e.subject } }, text: 'ok' } : { result: {}, text: 'ok' }) })
  await $.session.start(START)
  await $.turn.start({ text: '만들어 줘', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: '설계', description: '구조를 정한다' })
  const ui = await mountPane($)
  expect((await ui.find({ key: 'k-7' }))?.text).toBe('설계')
  expect(await ui.find({ key: 't-t1' })).toBeUndefined()
  await ui.unmount()
})

test('a finished task list leaves the pane when the next prompt starts', async ($, on) => {
  beneath(on, {
    tool: (e: any) => (e.tool === 'TaskCreate'
      ? { result: { task: { id: '1', subject: e.subject } }, text: 'ok' }
      : { result: { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: e.status } }, text: 'ok' }),
  })
  await $.session.start(START)
  await $.turn.start({ text: '만들어 줘', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: '설계', description: '구조를 정한다' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const ui = await mountPane($)
  expect((await ui.find({ key: 'row-k-1' }))?.text).toContain('완료')
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  await $.turn.start({ text: '다음 요청', turnId: 't2' })
  expect(await ui.find({ key: 'k-1' })).toBeUndefined()
  expect((await ui.find({ key: 'row-t-t2' }))?.text).toContain('진행 중')
  await ui.unmount()
})
