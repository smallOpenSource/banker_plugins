// Runs progress.mjs inside the engine's own test kit: claude plugin test <copy of the plugin folder>.
// hooks/progress.test.mjs covers the module against a stand-in engine (node --test); this file holds
// it to what the engine itself accepts and routes: the command's registration and run, the pane's
// open and close, and the drawing a terminal gets, pressed as a person would.
import { expect, test } from 'claude-code/testing'

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const PANE = 'banker-progress'

// The engine beneath the plugins: the commands it registered, the panes it holds open.
function beneath(on: any, tool = (e: any): any => (e.tool === 'Bash' ? { result: {}, text: 'exit 1', isError: true } : { result: {}, text: 'ok' })) {
  const registered: { name: string; immediate?: true; argumentHint?: string }[] = []
  const open = new Set<string>()
  on('session.version', () => ({ value: { version: '2.1.296', base: '2.1.296' } }))
  on('command.register', (_: unknown, e: any) => {
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [...open].map((id) => ({ id, title: '진행 상황', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', (_: unknown, e: any) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: any) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'engine' }))
  on('tool.call', (_: unknown, e: any) => tool(e))
  return { registered, open }
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

test('the markdown fallback\'s name opens the pane too, so it never reaches the model', async ($, on) => {
  const { open } = beneath(on)
  await $.session.start(START)
  await $.command.run({ command: 'banker:progress', args: '' })
  expect(open.has(PANE)).toBe(true)
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
  beneath(on, (e: any) => (e.tool === 'TaskCreate' ? { result: { task: { id: '7', subject: e.subject } }, text: 'ok' } : { result: {}, text: 'ok' }))
  await $.session.start(START)
  await $.turn.start({ text: '만들어 줘', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: '설계', description: '구조를 정한다' })
  const ui = await mountPane($)
  expect((await ui.find({ key: 'k-7' }))?.text).toBe('설계')
  expect(await ui.find({ key: 't-t1' })).toBeUndefined()
  await ui.unmount()
})
