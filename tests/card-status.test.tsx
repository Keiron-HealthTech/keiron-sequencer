import { expect, mock, test } from 'claude-code/testing'

import { cardKeyOf, cardLine, cardOfPlan, qualified, startedKey, stepOf } from '../hooks/register'

const SLUG = 'abc123def456'
const START = 'node /p/keiron-sequencer/scripts/start.mjs'
const PACKS = 'node /p/keiron-sequencer/scripts/packs.mjs'
const HOME = '/home/dev/.keiron-sequencer'
const CHECKOUT = '/w/app'
const BRANCH_NAME = 'dev/abc-7-restriction'
const STAMP = { descriptionHash: 'h1', recordSpikedAt: '2026-11-01T00:00:00Z', runId: null, bases: {} }
const PACK_PATH = `${HOME}/${SLUG}/packs/ABC-7.json`
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



type Effect = (seen: Seen) => void
type Seen = {
  status: (string | undefined)[]
  effects: Record<string, Effect>
  files: Record<string, string>
  at: { path: string; branch: string } | null
}

// What start.mjs branch writes (scripts/lib/start/started.mjs), here written by hand for a checkout and branch.
function writeStart(seen: Seen, plan: object, { path = CHECKOUT, branch = BRANCH_NAME, packStamp = null as unknown } = {}) {
  const file = `${HOME}/started/${startedKey(path)}.json`
  const prev = seen.files[file] ? JSON.parse(seen.files[file]!) : { schemaVersion: 1, path, branches: {} }
  const p = plan as { card: { key: string; project?: { slug?: string } } }
  prev.branches[branch] = { card: p.card.key, slug: p.card.project?.slug ?? null, branch, action: 'created', at: '2026-11-25T00:00:00.000Z', plan, packStamp }
  seen.files[file] = JSON.stringify(prev)
}

const writePack = (seen: Seen, answers: (string | null)[], stamp: object = STAMP) => {
  seen.files[PACK_PATH] = JSON.stringify({ stamp, questions: answers.map(a => ({ answer: a ? { outcome: a } : null })) })
}

function engine(on: any, { isError = false, spikeStatus = '', clock = true } = {}): Seen {
  const seen: Seen = { status: [], effects: {}, files: {}, at: { path: CHECKOUT, branch: BRANCH_NAME } }
  on('ui.status', (_: unknown, e: { text: string | undefined }) => (seen.status.push(e.text), { value: undefined }))
  if (clock) on('clock.every', () => ({ value: {} }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const out = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'git') return seen.at ? out(0, `${seen.at.path}\n${seen.at.branch}\n`) : out(128, '', 'fatal: not a git repository\n')
    return spikeStatus ? out(0, spikeStatus) : out(1, '', 'no active spike run\n')
  })
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    e.path in seen.files ? { value: seen.files[e.path] } : { deny: `missing ${e.path}` })
  // A Bash call runs every effect whose key its command holds, as the CLI would, whatever else the command says.
  on('tool.call', (_: unknown, e: { command?: string }) => {
    for (const [key, effect] of Object.entries(seen.effects)) if ((e.command ?? '').includes(key)) effect(seen)
    return { result: { stdout: '', stderr: '' }, ...(isError ? { isError: true } : {}) }
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

// start's branch step: it writes the started file, as start.mjs does on success.
const startsWith = (seen: Seen, plan: object, options?: Parameters<typeof writeStart>[2]) => {
  seen.effects['branch ABC-7'] = s => writeStart(s, plan, options)
}

const LINE = 'ABC-7 · sdd · stacked on ABC-6 · 2 open decisions'

test('the line stays off after a plan and turns on when start makes the branch', async ($, on) => {
  const seen = engine(on)
  startsWith(seen, PLAN)
  await begin($)

  await run($, `${START} plan ABC-7`)
  expect(seen.status.at(-1)).toBeUndefined()

  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.at(-1)).toBe(LINE)
})

test('a start wrapped in a shell variable lights the line', async ($, on) => {
  const seen = engine(on)
  startsWith(seen, PLAN)
  await begin($)
  await run($, `P=/p/keiron-sequencer/scripts/start.mjs; node $P branch ABC-7 --approve 1234abcd`)
  expect(seen.status.at(-1)).toBe(LINE)
})

test('a chained start whose later step fails still lights the line for the branch it made', async ($, on) => {
  const seen = engine(on, { isError: true })
  startsWith(seen, PLAN)
  await begin($)
  await run($, `node $P branch ABC-7 --approve 1234abcd && node $P baseline ABC-7 --approve 5678ef90`)
  expect(seen.status.at(-1)).toBe(LINE)
})

test('a start run before the session, from a terminal, lights the line when the session starts', async ($, on) => {
  const seen = engine(on, { clock: false })
  const clock = mock.clock(on)
  writeStart(seen, PLAN)
  await begin($)
  await clock.settle()
  expect(seen.status.at(-1)).toBe(LINE)
})

test('a start run from a terminal during the session lights the line on the next tick', async ($, on) => {
  const seen = engine(on, { clock: false })
  const clock = mock.clock(on)
  await begin($)
  await clock.settle()
  expect(seen.status.filter(Boolean)).toEqual([])

  writeStart(seen, PLAN)
  await clock.advance(10_000)
  expect(seen.status.at(-1)).toBe(LINE)
})

test('a start in another checkout does not light this one', async ($, on) => {
  const seen = engine(on)
  writeStart(seen, PLAN, { path: '/w/other' })
  startsWith(seen, PLAN, { path: '/w/other' })
  await begin($)
  await run($, `node $P branch ABC-7 --approve 1234abcd`)
  expect(seen.status.filter(Boolean)).toEqual([])
})

test('a start on another branch of this checkout does not light this branch', async ($, on) => {
  const seen = engine(on)
  seen.at = { path: CHECKOUT, branch: 'main' }
  writeStart(seen, PLAN)
  await begin($)
  await run($, 'git status')
  expect(seen.status.filter(Boolean)).toEqual([])
})

test('a file named for this checkout but holding another path is not read as this checkout', async ($, on) => {
  const seen = engine(on)
  writeStart(seen, PLAN)
  const file = `${HOME}/started/${startedKey(CHECKOUT)}.json`
  seen.files[file] = seen.files[file]!.replace(`"path":"${CHECKOUT}"`, '"path":"/w/elsewhere"')
  await begin($)
  expect(seen.status.filter(Boolean)).toEqual([])
})

test('outside a git checkout the line stays off', async ($, on) => {
  const seen = engine(on)
  seen.at = null
  writeStart(seen, PLAN)
  await begin($)
  await run($, 'ls')
  expect(seen.status.filter(Boolean)).toEqual([])
})

test('leaving the card branch says so, and coming back shows the card again', async ($, on) => {
  const seen = engine(on)
  startsWith(seen, PLAN)
  await begin($)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  seen.at = { path: CHECKOUT, branch: 'main' }
  await run($, 'git checkout main')
  expect(seen.status.at(-1)).toBe('ABC-7 · on main, not its branch')
  seen.at = { path: CHECKOUT, branch: BRANCH_NAME }
  await run($, `git checkout ${BRANCH_NAME}`)
  expect(seen.status.at(-1)).toBe(LINE)
})

test('answering the pack counts down the decisions and the route drops with the last one', async ($, on) => {
  const seen = engine(on)
  writePack(seen, [null, null])
  startsWith(seen, PLAN, { packStamp: STAMP })
  await begin($)
  await run($, `${START} plan ABC-7`)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)

  seen.effects['q1'] = s => writePack(s, ['a', null])
  await run($, `${PACKS} answer ${SLUG} ABC-7 q1 --outcome "a"`)
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd · stacked on ABC-6 · 1 open decision')

  seen.effects['q2'] = s => writePack(s, ['a', 'b'])
  await run($, `X=${PACKS}; node $X answer ${SLUG} ABC-7 q2 --outcome "b"`)
  expect(seen.status.at(-1)).toBe('ABC-7 · light · stacked on ABC-6')
})

const STALE = { ...PLAN, brief: { pack: { fresh: false, stale: 'card-text', answered: [{ text: 'x' }], open: [{ id: 'q2' }] } } }

test('a stale pack is said, and its answers do not settle anything', async ($, on) => {
  const seen = engine(on)
  writePack(seen, ['x', null])
  startsWith(seen, STALE, { packStamp: STAMP })
  await begin($)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd · stacked on ABC-6 · pack stale')
})

test('a pack drafted again after the start is fresh, read from its new stamp', async ($, on) => {
  const seen = engine(on)
  writePack(seen, ['x', null])
  startsWith(seen, STALE, { packStamp: STAMP })
  await begin($)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  seen.effects['draft'] = s => writePack(s, [null, null], { ...STAMP, descriptionHash: 'h2' })
  await run($, `${PACKS} draft ${SLUG} ABC-7`)
  expect(seen.status.at(-1)).toBe(LINE)
})

test('a failed start call that wrote no file leaves the line off', async ($, on) => {
  const seen = engine(on, { isError: true })
  await begin($)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.filter(Boolean)).toEqual([])
})

// scripts/lib/start/started.mjs names the file the same way; tests/start-branch.test.mjs pins the same vector.
test('the started file is named by an FNV-1a hash of the checkout path', () => {
  expect(startedKey('/w/app')).toBe('977955ef')
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
  startsWith(seen, plan)
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

test('a spike run by another session leaves this session on its card line', async ($, on) => {
  const status = { runId: 'r1', status: 'active', cards: { done: ['XYZ-1'], inProgress: ['XYZ-2'], pending: [] } }
  const seen = engine(on, { spikeStatus: JSON.stringify(status) })
  startsWith(seen, PLAN)
  await begin($)

  await run($, `${START} plan ABC-7`)
  await run($, `${START} branch ABC-7 --approve 1234abcd`)
  expect(seen.status.at(-1)).toBe('ABC-7 · sdd · stacked on ABC-6 · 2 open decisions')
})
