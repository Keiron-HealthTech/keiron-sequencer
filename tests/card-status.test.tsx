import { expect, test } from 'claude-code/testing'

import { cardKeyOf, cardLine, cardOfPlan, qualified, startCallOf, stepOf } from '../hooks/register'

const SLUG = 'abc123def456'
const START = 'node /p/keiron-sequencer/scripts/start.mjs'
const PACKS = 'node /p/keiron-sequencer/scripts/packs.mjs'

const PLAN = {
  card: { key: 'ABC-7', project: { slug: SLUG } },
  base: { kind: 'stack', branch: 'dev/abc-6-shared-guard' },
  branch: { name: 'dev/abc-7-restriction' },
  route: {
    route: 'sdd' as const,
    said: null,
    reasons: ['design-decisions:2', 'people-decisions:2', 'new-paths:0', 'files:4', 'fixups-received:1', 'tier:L', 'unblocks:3'],
  },
  brief: { pack: { fresh: true, stale: false, answered: [], open: [{ id: 'q1' }, { id: 'q2' }] } },
}

const BRANCH = { action: 'created', branch: 'dev/abc-7-restriction', base: 'origin/dev/abc-6-shared-guard' }

type Seen = { status: (string | undefined)[]; outputs: Record<string, string>; files: Record<string, string> }

function engine(on: any, { isError = false } = {}): Seen {
  const seen: Seen = { status: [], outputs: {}, files: {} }
  on('ui.status', (_: unknown, e: { text: string | undefined }) => (seen.status.push(e.text), { value: undefined }))
  on('clock.every', () => ({ value: {} }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no active spike run\n', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    e.path in seen.files ? { value: seen.files[e.path] } : { error: new Error(`missing ${e.path}`) })
  on('tool.call', (_: unknown, e: { command?: string }) => {
    const key = Object.keys(seen.outputs).find(k => (e.command ?? '').includes(k))
    return { result: { stdout: key ? seen.outputs[key] : '', stderr: '' }, ...(isError ? { isError: true } : {}) }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  return seen
}

async function begin($: any) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const run = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })

test('the line stays off after a plan and turns on when start makes the branch', async ($, on) => {
  const seen = engine(on)
  seen.outputs[`start.mjs plan ABC-7`] = JSON.stringify(PLAN)
  seen.outputs[`start.mjs branch ABC-7`] = JSON.stringify(BRANCH)
  await begin($)

  await run($, `${START} plan ABC-7`)
  expect(seen.status.at(-1)).toBeUndefined()

  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd · stacked on ABC-6 · 2 open decisions')
})

test('answering the pack counts down the decisions and the route drops with the last one', async ($, on) => {
  const seen = engine(on)
  seen.outputs[`start.mjs plan ABC-7`] = JSON.stringify(PLAN)
  seen.outputs[`start.mjs branch ABC-7`] = JSON.stringify(BRANCH)
  const path = `/home/dev/.keiron-sequencer/${SLUG}/packs/ABC-7.json`
  await begin($)
  await run($, `${START} plan ABC-7`)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)

  seen.files[path] = JSON.stringify({ questions: [{ answer: { outcome: 'a' } }, { answer: null }] })
  await run($, `${PACKS} answer ${SLUG} ABC-7 q1 --outcome "a"`)
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd · stacked on ABC-6 · 1 open decision')

  seen.files[path] = JSON.stringify({ questions: [{ answer: { outcome: 'a' } }, { answer: { outcome: 'b' } }] })
  await run($, `${PACKS} answer ${SLUG} ABC-7 q2 --outcome "b"`)
  expect(seen.status.at(-1)).toBe('ABC-7 · light · stacked on ABC-6')
})

test('a stale pack is said, and its answers do not settle anything', async ($, on) => {
  const seen = engine(on)
  const stale = { ...PLAN, brief: { pack: { fresh: false, stale: 'card-text', answered: [{ text: 'x' }], open: [{ id: 'q2' }] } } }
  seen.outputs[`start.mjs plan ABC-7`] = JSON.stringify(stale)
  seen.outputs[`start.mjs branch ABC-7`] = JSON.stringify(BRANCH)
  await begin($)
  await run($, `${START} plan ABC-7`)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd · stacked on ABC-6 · pack stale')
})

test('a failed start call leaves the line off', async ($, on) => {
  const seen = engine(on, { isError: true })
  seen.outputs[`start.mjs branch ABC-7`] = JSON.stringify(BRANCH)
  await begin($)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.filter(Boolean)).toEqual([])
})

test('start calls are recognized in their bare and step forms only', () => {
  expect(startCallOf(`${START} ABC-7`)).toEqual({ step: 'plan', card: 'ABC-7' })
  expect(startCallOf(`node "$CLAUDE_PLUGIN_ROOT/scripts/start.mjs" branch ABC-7 --approve x`)).toEqual({ step: 'branch', card: 'ABC-7' })
  expect(startCallOf('git checkout -b abc-7')).toBeNull()
})

test('a stacked base is named by the card key in its branch, else by the branch', () => {
  expect(cardKeyOf('dev/abc-6-shared-guard')).toBe('ABC-6')
  expect(cardKeyOf('release')).toBe('release')
})

test('on another branch the line says so instead of the card facts', () => {
  const c = cardOfPlan(PLAN)!
  expect(cardLine({ ...c, branch: 'dev/abc-7-restriction', currentBranch: 'main' })).toBe('ABC-7 · on main, not its branch')
})

test('a card with no record shows only its key and that it has none', () => {
  const c = cardOfPlan({ card: { key: 'ABC-9', project: { slug: SLUG } }, route: { route: null, said: 'no record', reasons: [] } })!
  expect(cardLine(c)).toBe('ABC-9 · no record')
})

const SMALL = {
  ...PLAN,
  base: { kind: 'default', branch: 'main' },
  route: { route: 'tdd' as const, said: null, reasons: ['design-decisions:0', 'people-decisions:0', 'new-paths:0', 'fixups-received:0', 'tier:S'] },
  brief: { pack: null },
}

const skill = ($: any, pluginName: string, name: string) => $.tool.call({ tool: 'Skill', skill: `${pluginName}:${name}` })
const typed = ($: any, name: string) => $.prompt.submit({ text: `/${name}`, command: { name, args: '' } })

async function started($: any, on: any, plan: object) {
  const seen = engine(on)
  seen.outputs[`start.mjs plan ABC-7`] = JSON.stringify(plan)
  seen.outputs[`start.mjs branch ABC-7`] = JSON.stringify(BRANCH)
  await begin($)
  await run($, `${START} plan ABC-7`)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  return seen
}

test('an sdd card shows its phase, ignores the TDD inside apply, and ends done at archive', async ($, on) => {
  const seen = await started($, on, PLAN)

  await typed($, 'sdd-new')
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd: explore · stacked on ABC-6 · 2 open decisions')

  await $.tool.call({ tool: 'Agent', description: 'apply', prompt: 'apply', subagent_type: 'spec-driven-dev:sdd-apply' })
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd: apply · stacked on ABC-6 · 2 open decisions')

  await skill($, 'superpowers', 'test-driven-development')
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd: apply · stacked on ABC-6 · 2 open decisions')

  await skill($, 'spec-driven-dev', 'sdd-archive')
  expect(seen.status.at(-1)).toBe('ABC-7 · ✓ done')
})

test('a tdd card shows its build phase and ends done when the PR is opened', async ($, on) => {
  const seen = await started($, on, SMALL)
  expect(seen.status.at(-1)).toBe('ABC-7 · tdd')

  await skill($, 'superpowers', 'test-driven-development')
  expect(seen.status.at(-1)).toBe('ABC-7 · tdd: build')

  await run($, 'gh pr create --draft --base main --title "x" --body "y"')
  expect(seen.status.at(-1)).toBe('ABC-7 · ✓ done')
})

test('a phase skill with no started card shows nothing', async ($, on) => {
  const seen = engine(on)
  await begin($)
  await skill($, 'spec-driven-dev', 'sdd-apply')
  expect(seen.status.filter(Boolean)).toEqual([])
})

test('a typed command without its plugin is read as SDD first, then superpowers', () => {
  expect(qualified('sdd-apply')).toBe('spec-driven-dev:sdd-apply')
  expect(qualified('writing-plans')).toBe('superpowers:writing-plans')
  expect(qualified('superpowers:writing-plans')).toBe('superpowers:writing-plans')
})

test('only the development workflows count as phases', () => {
  expect(stepOf('spec-driven-dev:review-risk')).toEqual({ flow: 'sdd', phase: 'review' })
  expect(stepOf('superpowers:finishing-a-development-branch')).toEqual({ flow: 'superpowers', phase: 'done' })
  expect(stepOf('superpowers:brainstorming')).toBeNull()
  expect(stepOf('keiron-sequencer:next')).toBeNull()
})
