// Runs graceful-pause.mjs inside the engine's own test kit: claude plugin test <copy of the plugin folder>.
// The kit has nothing beneath a plugin's $.session.append (2.1.289), so the mid-turn note is
// covered by hooks/graceful-pause.test.mjs (stand-in engine, node --test) and was checked in a
// live session; this file holds the module to what the engine itself accepts and routes,
// the host checks a stand-in can miss included.
import { expect, mock, test } from 'claude-code/testing'

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }

test('on 2.1.289 it registers /graceful-pause to run mid-turn, answers it while idle, and passes turns on', async ($, on) => {
  const registered: { name: string; immediate?: true; argumentHint?: string }[] = []
  on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289' } }))
  on('command.register', (_, e) => {
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'engine' }))

  expect(await $.session.start(START)).toEqual({ cwd: '/work' })
  expect(registered).toEqual([expect.objectContaining({ name: 'graceful-pause', immediate: true })])

  const idle = await $.command.run({ command: 'graceful-pause', args: '메모' })
  expect(idle.text).toMatch(/진행 중인 작업이 없/)

  expect(await $.turn.start({ text: 'do the work', turnId: 't1' })).toEqual({ turnId: 't1' })
  expect(await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })).toEqual({ text: 'engine' })

  const after = await $.command.run({ command: 'graceful-pause' })
  expect(after.text).toMatch(/진행 중인 작업이 없/)
})

test('an engine older than 2.1.289 gets no command and one log line', async ($, on) => {
  const logged: string[] = []
  const registered: unknown[] = []
  on('session.version', () => ({ value: { version: '2.1.288', base: '2.1.288' } }))
  on('command.register', (_, e) => {
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  expect(await $.session.start(START)).toEqual({ cwd: '/work' })
  expect(registered).toEqual([])
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('2.1.289')
})

test('a name the engine refuses is logged, and the session still starts', async ($, on) => {
  const logged: string[] = []
  on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289' } }))
  on('command.register', () => ({ deny: 'taken by another plugin' }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  expect(await $.session.start(START)).toEqual({ cwd: '/work' })
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('/graceful-pause')
})

const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'npm test' }

test('idle with background work in flight, the note goes out as a prompt of its own once the command has answered', async ($, on) => {
  const clock = mock.clock(on)
  const submitted: string[] = []
  const logged: string[] = []
  on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289' } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'engine' }))
  on('classic.Stop', () => ({}))
  const origins: unknown[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    origins.push(e.origin)
    return { text: e.text }
  })

  await $.session.start(START)
  await $.turn.start({ text: 'do the work', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL] })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })

  const res = await $.command.run({ command: 'graceful-pause', args: '정지' })
  expect(res.text).toMatch(/백그라운드/)
  expect(submitted).toEqual([])
  await clock.advance(5)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('메모: 정지')
  expect(origins[0]).toEqual(expect.objectContaining({ kind: 'plugin', asUser: true }))
  expect(logged).toEqual([])
})

test('a report prompt a hook drops is logged, and the command can send it again', async ($, on) => {
  const clock = mock.clock(on)
  const logged: string[] = []
  on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289' } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'engine' }))
  on('classic.Stop', () => ({}))
  on('prompt.submit', () => ({ drop: 'refused by a policy hook' }))

  await $.session.start(START)
  await $.turn.start({ text: 'do the work', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL] })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })

  await $.command.run({ command: 'graceful-pause' })
  await clock.advance(5)
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('refused by a policy hook')
  const again = await $.command.run({ command: 'graceful-pause' })
  expect(again.text).not.toMatch(/이미/)
})

test('/clear forgets the running turn and the background count', async ($, on) => {
  on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289' } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))

  await $.session.start(START)
  await $.turn.start({ text: 'do the work', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL] })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const res = await $.command.run({ command: 'graceful-pause' })
  expect(res.text).toMatch(/진행 중인 작업이 없/)
})
