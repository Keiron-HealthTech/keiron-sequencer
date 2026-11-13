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

const OLD_NAME = new RegExp('mi' + 'kado', 'i')

type Run = { exitCode: number; stdout: string; stderr: string }

function engine(on: any, run: Run) {
  const seen = { argvs: [] as string[][], opened: [] as { id: string; title: string }[], commands: [] as { name: string; description: string }[] }
  on('command.register', (_: unknown, e: { name: string; description: string }) => (seen.commands.push(e), { value: { command: e.name } }))
  on('ui.open', (_: unknown, e: { id: string; title: string }) => (seen.opened.push(e), { value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: {} }))
  on('process.run', (_: unknown, e: { argv: string[] }) => (seen.argvs.push([...e.argv]), { value: { ...run, isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return seen
}

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 20; i++) await Promise.resolve()
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

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /🚇 keiron-sequencer/ })).toBeTruthy()
  await ui.unmount()
  expect(seen.commands.map(c => c.name)).toEqual(['spike-metro'])
  expect(seen.opened.map(o => o.id)).toEqual(['spike-metro'])
  for (const text of [...seen.commands.flatMap(c => [c.name, c.description]), ...seen.opened.flatMap(o => [o.id, o.title])]) {
    expect(text).not.toMatch(OLD_NAME)
  }
})
