import { expect, test } from 'claude-code/testing'

import { poll, statusArgv } from '../hooks/register'

const PANE = {
  plugin: 'keiron-sequencer',
  component: 'Pane',
  requestId: 'spike-metro',
  props: {
    title: 'Spike metro',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const STATUS = {
  runId: '20261111T194430Z',
  status: 'active',
  project: { name: 'Sample project' },
  execution: { caps: { tokens: null, cards: null }, spent: { cards: 4, tokens: 2369236 } },
  current: { card: 'ABC-3', spent: 98556 },
  cards: { done: ['ABC-1', 'ABC-2'], inProgress: ['ABC-3'], pending: ['ABC-4', 'ABC-5'] },
  modes: { 'ABC-1': 'spike', 'ABC-2': 'replay', 'ABC-3': 'spike', 'ABC-4': 'replay', 'ABC-5': 'spike' },
  replays: [
    { card: 'ABC-1', mode: 'spike', status: 'conflict' },
    { card: 'ABC-2', mode: 'replay', status: 'replayed' },
    { card: 'ABC-4', mode: 'replay', status: 'pending' },
  ],
}

const TRACKED = {
  ...STATUS,
  current: null,
  cards: { done: ['ABC-1', 'ABC-2'], inProgress: ['ABC-3', 'ABC-6'], pending: ['ABC-4', 'ABC-5'] },
  tracks: [
    { id: 't1', status: 'active', current: 'ABC-3', done: 2, total: 4, mergedInto: null, cards: ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4'] },
    { id: 't2', status: 'active', current: 'ABC-6', done: 0, total: 2, mergedInto: null, cards: ['ABC-6', 'ABC-5'] },
    { id: 't3', status: 'merged', current: null, done: 1, total: 1, mergedInto: 't1', cards: [] },
  ],
}

const OLD_NAME = new RegExp('mi' + 'kado', 'i')

type Run = { exitCode: number; stdout: string; stderr: string }

function engine(on: any, run: Run) {
  const seen = { status: [] as (string | undefined)[], argvs: [] as string[][], opened: [] as { id: string; title: string; columns?: number }[], commands: [] as { name: string; description: string }[] }
  on('command.register', (_: unknown, e: { name: string; description: string }) => (seen.commands.push(e), { value: { command: e.name } }))
  on('ui.open', (_: unknown, e: { id: string; title: string }) => (seen.opened.push(e), { value: { isPlaced: true } }))
  on('clock.every', () => ({ value: {} }))
  on('process.run', (_: unknown, e: { argv: string[] }) => (seen.argvs.push([...e.argv]), { value: { ...run, isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => (seen.status.push(e.text), { value: undefined }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return seen
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const runSpike = async ($: any, command = 'node /p/keiron-sequencer/scripts/respike.mjs begin') => {
  await $.tool.call({ tool: 'Bash', command })
  await flush()
}

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await flush()
}

test('a running respike draws as a metro line with the car on the current card', async ($, on) => {
  engine(on, { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /🚃\s+ABC-3/ }))?.text).toContain('car is here')
  expect((await ui.find({ type: 'Text', text: /ABC-2/ }))?.text).toContain('express')
  expect((await ui.find({ type: 'Text', text: /ABC-1/ }))?.text).toContain('re-spiked')
  expect((await ui.find({ type: 'Text', text: /ABC-4/ }))?.text).toContain('express stop')
  expect(await ui.find({ type: 'Text', text: /Station 2\/5/ })).toBeTruthy()
  await ui.unmount()
})

test('with no active run the pane says no train is on the line', async ($, on) => {
  engine(on, { exitCode: 1, stdout: '', stderr: 'no active spike run for project X\n' })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No train on the line/ })).toBeTruthy()
  await ui.unmount()
})

test('the status runs the spike CLI under the plugin root, passed as an argument', async ($, on) => {
  const seen = engine(on, { exitCode: 1, stdout: '', stderr: 'x\n' })
  await start($)

  const argv = seen.argvs.at(-1)!
  expect(argv.slice(0, 4)).toEqual(['/bin/sh', '-lc', 'exec node "$1/scripts/spike.mjs" status', 'sh'])
  expect(argv[4]).toMatch(/^\//)
  expect(argv[4]).not.toMatch(/\.claude-plugin$/)
})

test('the status command is built from the root it is given and names no fixed folder', () => {
  const argv = statusArgv('/tmp/x')
  expect(argv).toEqual(['/bin/sh', '-lc', 'exec node "$1/scripts/spike.mjs" status', 'sh', '/tmp/x'])
  expect(argv.join(' ')).not.toMatch(/Desktop/)
})

test('with no plugin root nothing runs and the snapshot says why the status is not available', async () => {
  const runs: string[][] = []
  const snap = await poll('', async argv => (runs.push(argv), { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' }), '2026-01-01T00:00:00.000Z')
  expect(runs).toEqual([])
  expect(snap.isRunning).toBe(false)
  expect(snap.message).toMatch(/plugin folder is unknown/)
})

test('a run with no project name is titled keiron-sequencer, under the spike-metro pane and command', async ($, on) => {
  const seen = engine(on, { exitCode: 0, stdout: JSON.stringify({ ...STATUS, project: {} }), stderr: '' })
  await start($)
  await runSpike($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /🚇 keiron-sequencer/ })).toBeTruthy()
  await ui.unmount()
  expect(seen.commands.map(c => c.name)).toEqual(['spike-metro'])
  expect(seen.opened.map(o => o.id)).toEqual(['spike-metro'])
  for (const text of [...seen.commands.flatMap(c => [c.name, c.description]), ...seen.opened.flatMap(o => [o.id, o.title])]) {
    expect(text).not.toMatch(OLD_NAME)
  }
})

test('the pane asks for a narrow dock, and every line it draws fits in it', async ($, on) => {
  const seen = engine(on, { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' })
  await start($)
  await runSpike($)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'desktop' })
  for (const legend of [/● spiked/, /↻ re-spiked/]) {
    const line = (await ui.find({ type: 'Text', text: legend }))?.text ?? ''
    expect(line.length > 0 && line.length <= 40).toBe(true)
  }
  await ui.unmount()
  expect(seen.opened.map(o => o.columns)).toEqual([40])
})

test('a session that did not run the spike neither opens the metro nor shows the run on its status line', async ($, on) => {
  const seen = engine(on, { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' })
  await start($)
  await runSpike($, 'node /p/keiron-sequencer/scripts/spike.mjs status')

  expect(seen.opened).toEqual([])
  expect(seen.status.filter(t => t?.startsWith('🚃'))).toEqual([])
})

test('the session that runs the spike CLI opens the metro once and shows the run on its status line', async ($, on) => {
  const seen = engine(on, { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' })
  await start($)
  await runSpike($, 'node /p/keiron-sequencer/scripts/spike.mjs next')
  await runSpike($, 'node /p/keiron-sequencer/scripts/spike.mjs next')

  expect(seen.opened.map(o => o.id)).toEqual(['spike-metro'])
  expect(seen.status.at(-1)).toBe('🚃 2/5 · ABC-3')
})

test('/spike-metro opens the metro in any session', async ($, on) => {
  const seen = engine(on, { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' })
  await start($)
  await $.command.run({ command: 'spike-metro' })

  expect(seen.opened.map(o => o.id)).toEqual(['spike-metro'])
})

test('a run with two tracks draws a line per track', async ($, on) => {
  engine(on, { exitCode: 0, stdout: JSON.stringify(TRACKED), stderr: '' })
  await start($)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /t1 · 2\/4 · ABC-3/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /t2 · 0\/2 · ABC-6/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /🚃\s+ABC-6/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /○\s+ABC-5/ })).toBeTruthy()
  const drawn = [...(await ui.findAll({ type: 'Text' }))].map(t => t.text ?? '')
  expect(drawn.length).toBeGreaterThan(8)
  for (const line of drawn) expect(line.length <= 40).toBe(true)
  await ui.unmount()
})

test('a merged track draws as joining its target', async ($, on) => {
  engine(on, { exitCode: 0, stdout: JSON.stringify(TRACKED), stderr: '' })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /t3 ⤳ t1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /t3 · / })).toBeFalsy()
  await ui.unmount()
})

test("the owner's status line counts tracks", async ($, on) => {
  const seen = engine(on, { exitCode: 0, stdout: JSON.stringify(TRACKED), stderr: '' })
  await start($)
  await runSpike($, 'node /p/keiron-sequencer/scripts/respike.mjs begin')

  expect(seen.status.at(-1)).toBe('🚃 2/6 · 2 tracks')
})
