import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register } from 'claude-code'

import type { CardStatus, Route, Snapshot, Station, StationKind } from '../types'

const PANE = 'spike-metro'
const TITLE = 'Spike metro'
// The docked width it asks for; a width the person drags the dock to wins.
const OPEN = { id: PANE, title: TITLE, columns: 40 }
const POLL_MS = 10_000
// A login shell finds the same node the user runs the CLIs with. The root is passed as $1, never spliced into the script.
export const statusArgv = (root: string) => ['/bin/sh', '-lc', 'exec node "$1/scripts/spike.mjs" status', 'sh', root]

const snapshot = atom({ plugin: 'keiron-sequencer', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
// The card the last start plan showed, and the card this session is on once start's branch step ran.
const planned = atom({ plugin: 'keiron-sequencer', key: 'planned' } as const, null, { shape: 'card-2' })
const card = atom({ plugin: 'keiron-sequencer', key: 'card' } as const, null, { shape: 'card-2' })
// Set once this session runs the spike CLI. The run state is shared by every session, so only its owner shows it unasked.
const owner = atom({ plugin: 'keiron-sequencer', key: 'owner' } as const, null, { shape: 'owner-1' })

type Dollar = Pick<CoreEngineInterface, 'state' | 'ui' | 'process' | 'fs' | 'env' | 'plugin'>

type StatusJson = {
  runId?: string
  status?: string
  project?: { name?: string }
  execution?: { caps?: { tokens?: number | null; cards?: number | null }; spent?: { tokens?: number | 'unmeasured' } }
  current?: { card?: string | null; spent?: number | null } | null
  cards?: { done?: string[]; inProgress?: string[]; pending?: string[] }
  modes?: Record<string, string>
  replays?: { card: string; mode: string; status: string }[]
}

const TURNED = new Set(['conflict', 'no-preimage', 'secret'])

export function stationsOf(s: StatusJson): Station[] {
  const outcome = new Map((s.replays ?? []).map(r => [r.card, r.status]))
  const kindOf = (card: string, phase: 'done' | 'current' | 'pending'): StationKind => {
    if (phase === 'current') return 'current'
    const result = outcome.get(card)
    if (phase === 'done') {
      if (result === 'replayed') return 'replayed'
      if (result === 'empty') return 'empty'
      if (result && TURNED.has(result)) return 'respiked'
      return 'spiked'
    }
    return s.modes?.[card] === 'replay' ? 'next-replay' : 'next-spike'
  }
  return [
    ...(s.cards?.done ?? []).map(card => ({ card, kind: kindOf(card, 'done') })),
    ...(s.cards?.inProgress ?? []).map(card => ({ card, kind: kindOf(card, 'current') })),
    ...(s.cards?.pending ?? []).map(card => ({ card, kind: kindOf(card, 'pending') })),
  ]
}

export function snapshotOf(exitCode: number, stdout: string, stderr: string, at: string): Snapshot {
  const idle = (message: string): Snapshot => ({
    at, isRunning: false, message, runId: null, status: null, project: null, isRespike: false,
    stations: [], done: 0, total: 0, current: null, currentTokens: null, runTokens: null, tokenCap: null, cardCap: null,
  })
  if (exitCode !== 0) return idle(stderr.trim().split('\n')[0] || 'No train on the line.')
  let s: StatusJson
  try {
    s = JSON.parse(stdout)
  } catch {
    return idle('Could not read the spike status.')
  }
  const stations = stationsOf(s)
  const spent = s.execution?.spent?.tokens
  return {
    at,
    isRunning: true,
    message: '',
    runId: s.runId ?? null,
    status: s.status ?? null,
    project: s.project?.name ?? null,
    isRespike: Boolean(s.modes),
    stations,
    done: s.cards?.done?.length ?? 0,
    total: stations.length,
    current: s.current?.card ?? s.cards?.inProgress?.[0] ?? null,
    currentTokens: s.current?.spent ?? null,
    runTokens: typeof spent === 'number' ? spent : null,
    tokenCap: s.execution?.caps?.tokens ?? null,
    cardCap: s.execution?.caps?.cards ?? null,
  }
}

const tokens = (n: number | null) =>
  n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)

const LOOK: Record<StationKind, { glyph: string; color: string; label: string; isDim?: boolean }> = {
  spiked: { glyph: '●', color: '#2E9E5B', label: 'spiked' },
  replayed: { glyph: '◆', color: '#3B82F6', label: 'express · replayed' },
  empty: { glyph: '◇', color: '#3B82F6', label: 'replayed · nothing new', isDim: true },
  respiked: { glyph: '↻', color: '#E4572E', label: 'replay conflicted · re-spiked' },
  current: { glyph: '🚃', color: '#F59E0B', label: 'car is here' },
  'next-spike': { glyph: '○', color: '#9CA3AF', label: '', isDim: true },
  'next-replay': { glyph: '◇', color: '#9CA3AF', label: 'express stop', isDim: true },
}

export function windowOf(stations: Station[], rows: number) {
  const at = stations.findIndex(s => s.kind === 'current')
  const anchor = at === -1 ? stations.findIndex(s => s.kind.startsWith('next')) : at
  const room = Math.max(3, Math.floor(rows / 2))
  const start = Math.max(0, (anchor === -1 ? stations.length : anchor) - 3)
  return { before: start, shown: stations.slice(start, start + room), after: Math.max(0, stations.length - start - room) }
}

type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export async function poll(root: string, run: Run, at: string): Promise<Snapshot> {
  if (!root) return snapshotOf(1, '', 'The plugin folder is unknown, so the spike status cannot run.', at)
  try {
    const { exitCode, stdout, stderr } = await run(statusArgv(root))
    return snapshotOf(exitCode, stdout, stderr, at)
  } catch {
    return snapshotOf(1, '', 'The spike status could not run.', at)
  }
}

type PlanJson = {
  card?: { key?: string; project?: { slug?: string } }
  base?: { kind?: string; branch?: string | null } | null
  branch?: { name?: string | null } | null
  route?: { route?: Route | null; said?: string | null; reasons?: string[] } | null
  brief?: { pack?: { stale?: unknown; answered?: unknown[]; open?: unknown[] } | null } | null
}

type PackJson = { questions?: { answer?: unknown }[] }

const CARD = String.raw`([A-Z][A-Z0-9]*-\d+)`
const START_CALL = new RegExp(String.raw`scripts/start\.mjs["']?\s+(?:(plan|branch|fetch|baseline|move)\s+)?` + CARD)
const SPIKE_CALL = /scripts\/(?:re)?spike\.mjs["']?(?!\s+status\b)/
export const isSpikeCall = (command: string) => SPIKE_CALL.test(command)
const PACKS_CALL = /scripts\/packs\.mjs["']?\s+(answer|draft)\b/

export function startCallOf(command: string) {
  const m = START_CALL.exec(command)
  return m?.[2] ? { step: m[1] ?? 'plan', card: m[2] } : null
}

export const isPacksCall = (command: string) => PACKS_CALL.test(command)

export const isPrCreate = (command: string) => /\bgh\s+pr\s+create\b/.test(command)

type Step = { flow: 'sdd' | 'superpowers'; phase: string }

const SDD_PHASES: Record<string, string> = {
  'sdd-new': 'explore', 'sdd-explore': 'explore', 'sdd-ff': 'propose', 'sdd-propose': 'propose', 'sdd-spec': 'spec',
  'sdd-design': 'design', 'sdd-tasks': 'tasks', 'sdd-apply': 'apply', 'sdd-debug': 'debug', 'sdd-review': 'review',
  'sdd-verify': 'verify', 'sdd-archive': 'done',
}
const SUPERPOWERS_PHASES: Record<string, string> = {
  'writing-plans': 'plan', 'executing-plans': 'build', 'subagent-driven-development': 'build',
  'test-driven-development': 'build', 'finishing-a-development-branch': 'done',
}

// A skill or subagent name as `plugin:name`; the phase it starts, or null for anything else.
export function stepOf(name: string): Step | null {
  const [plugin, skill = ''] = name.split(':')
  if (plugin === 'spec-driven-dev') {
    if (/^(review|jd)-/.test(skill)) return { flow: 'sdd', phase: 'review' }
    const phase = SDD_PHASES[skill]
    return phase ? { flow: 'sdd', phase } : null
  }
  if (plugin === 'superpowers') {
    const phase = SUPERPOWERS_PHASES[skill]
    return phase ? { flow: 'superpowers', phase } : null
  }
  return null
}

// A slash command may come without its plugin (`/sdd-apply`); SDD's names are tried first, then superpowers'.
export function qualified(name: string) {
  if (name.includes(':')) return name
  return stepOf(`spec-driven-dev:${name}`) ? `spec-driven-dev:${name}` : `superpowers:${name}`
}

// SDD's apply phase runs superpowers' TDD inside it, so once SDD is the flow only superpowers' closing step counts.
export function withStep(c: CardStatus, step: Step): CardStatus {
  if (step.phase === 'done') return { ...c, isDone: true }
  if (c.flow === 'sdd' && step.flow === 'superpowers') return c
  return { ...c, flow: step.flow, phase: step.phase, isDone: false }
}

// A stacked base is a blocker's branch; Linear branch names carry the card key, so the line can name the card.
export function cardKeyOf(branch: string | null | undefined) {
  const m = /(?:^|[/_])([a-z][a-z0-9]*-\d+)/i.exec(branch ?? '')
  return m?.[1] ? m[1].toUpperCase() : branch || null
}

const countIn = (reasons: string[], name: string) => {
  const found = reasons.find(r => r.startsWith(`${name}:`))
  return found ? Number(found.slice(name.length + 1)) || 0 : 0
}

export function cardOfPlan(plan: PlanJson): CardStatus | null {
  const key = plan.card?.key
  if (!key) return null
  const reasons = plan.route?.reasons ?? []
  const tier = reasons.find(r => r.startsWith('tier:'))
  const pack = plan.brief?.pack
  return {
    key,
    slug: plan.card?.project?.slug ?? null,
    branch: plan.branch?.name ?? null,
    currentBranch: null,
    route: plan.route?.route ?? null,
    isRouteFixed: !plan.route?.route || plan.route.said === 'unknown',
    facts: {
      isMultiRepo: reasons.includes('repos>1'),
      tier: tier ? tier.slice('tier:'.length) : null,
      newPaths: countIn(reasons, 'new-paths'),
      fixupsReceived: countIn(reasons, 'fixups-received'),
      peopleDecisions: countIn(reasons, 'people-decisions') + countIn(reasons, 'pack-answered'),
    },
    stackedOn: plan.base?.kind === 'stack' ? cardKeyOf(plan.base.branch) : null,
    pack: pack ? { isStale: Boolean(pack.stale), answered: pack.answered?.length ?? 0, open: pack.open?.length ?? 0 } : null,
    flow: null,
    phase: null,
    isDone: false,
  }
}

export function packOfFile(pack: PackJson, isStale: boolean): CardStatus['pack'] {
  const questions = pack.questions ?? []
  const answered = questions.filter(q => q.answer).length
  return { isStale, answered, open: questions.length - answered }
}

export const openDecisions = (c: CardStatus) =>
  c.pack && !c.pack.isStale ? Math.max(0, c.facts.peopleDecisions - c.pack.answered) : c.facts.peopleDecisions

// The same rule start's route uses, so answering the pack moves the route without running start again.
export function routeOf(c: CardStatus): Route | null {
  if (c.isRouteFixed) return c.route
  const { isMultiRepo, tier, newPaths, fixupsReceived } = c.facts
  if (isMultiRepo || openDecisions(c) > 0 || tier === 'XL') return 'sdd'
  if (tier === 'L' || newPaths > 0 || fixupsReceived >= 2) return 'light'
  return 'tdd'
}

export function cardLine(c: CardStatus) {
  if (c.branch && c.currentBranch && c.currentBranch !== c.branch) return `${c.key} · on ${c.currentBranch}, not its branch`
  if (c.isDone) return `${c.key} · ✓ done`
  const route = routeOf(c)
  const label = c.flow === 'sdd' ? 'sdd' : c.flow === 'superpowers' ? (route === 'light' || route === 'tdd' ? route : 'superpowers') : null
  const parts = [c.key, c.phase && label ? `${label}: ${c.phase}` : route ?? 'no record']
  if (c.stackedOn) parts.push(`stacked on ${c.stackedOn}`)
  const open = openDecisions(c)
  if (c.pack?.isStale) parts.push('pack stale')
  else if (open > 0) parts.push(`${open} open decision${open === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

const parsed = <T,>(text: string | undefined): T | null => {
  try {
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

async function paint($: Dollar) {
  const snap = await read($, snapshot)
  const on = await read($, card)
  const isOwner = (await read($, owner)) !== null
  $.ui.status(isOwner && snap?.isRunning ? `🚃 ${snap.done}/${snap.total} · ${snap.current ?? 'between stations'}` : on ? cardLine(on) : undefined)
}

async function readPack($: Dollar, c: CardStatus) {
  if (!c.slug) return null
  const home = (await $.env.get('KEIRON_SEQUENCER_HOME')) || `${await $.env.get('HOME')}/.keiron-sequencer`
  try {
    return parsed<PackJson>(await $.fs.read(`${home}/${c.slug}/packs/${c.key}.json`))
  } catch {
    return null
  }
}

async function onStartCall($: Dollar, step: string, key: string, stdout: string | undefined) {
  const json = parsed<PlanJson & { branch?: unknown }>(stdout)
  if (!json) return
  if (step === 'plan') {
    const plan = cardOfPlan(json)
    if (plan) await update($, planned, () => plan)
  }
  if (step === 'branch' && typeof json.branch === 'string') {
    const name = json.branch
    const plan = await read($, planned)
    const base: CardStatus = plan?.key === key ? plan : {
      key, slug: null, branch: null, currentBranch: null, route: null, isRouteFixed: true,
      facts: { isMultiRepo: false, tier: null, newPaths: 0, fixupsReceived: 0, peopleDecisions: 0 }, stackedOn: null, pack: null,
      flow: null, phase: null, isDone: false,
    }
    await update($, card, () => ({ ...base, branch: name, currentBranch: name }))
  }
}

async function onPacksCall($: Dollar, command: string) {
  const c = await read($, card)
  if (!c) return
  const pack = await readPack($, c)
  if (!pack) return
  // A draft writes the pack again from the current record and base, so it is fresh; an answer keeps what it was.
  const isStale = /\bdraft\b/.test(command) ? false : c.pack?.isStale ?? false
  await update($, card, prev => (prev ? { ...prev, pack: packOfFile(pack, isStale) } : prev))
}

async function onStep($: Dollar, step: Step | null) {
  if (!step || !(await read($, card))) return
  await update($, card, prev => (prev ? withStep(prev, step) : prev))
  await paint($)
}

const quietly = async (work: () => Promise<void>) => {
  try {
    await work()
  } catch {
    // The status line is a convenience: a failure here never touches what the session is doing.
  }
}

async function checkBranch($: Dollar) {
  const c = await read($, card)
  if (!c?.branch) return
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
    const current = exitCode === 0 ? stdout.trim() : null
    if (current && current !== c.currentBranch) await update($, card, prev => (prev ? { ...prev, currentBranch: current } : prev))
  } catch {
    // Not a git checkout, or git is missing: the line keeps the branch start chose.
  }
}

async function refresh($: Dollar) {
  const snap = await poll($.plugin.root, argv => $.process.run(argv, { timeoutMs: 20_000 }), new Date().toISOString())
  await update($, snapshot, () => snap)
  try {
    await checkBranch($)
    await paint($)
    const own = await read($, owner)
    if (snap.isRunning && own && !own.hasOpened) {
      await update($, owner, () => ({ hasOpened: true }))
      void $.ui.open(OPEN)
    }
  } catch {
    // The session can end between ticks; the next tick, if any, paints again.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'spike-metro', description: 'Show the running spike as a metro line' })
    void refresh($)
    $.clock.every(POLL_MS, () => refresh($))
    return started
  })

  // start and packs print JSON; their results are read after the call, and the call itself is never changed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const start = startCallOf(e.command)
    const isPacks = isPacksCall(e.command)
    const isPr = isPrCreate(e.command)
    const isSpike = isSpikeCall(e.command)
    if (!start && !isPacks && !isPr && !isSpike) return next(e)
    const ran = await next(e)
    if (isSpike) {
      await quietly(async () => {
        if (await read($, owner)) return
        await update($, owner, () => ({ hasOpened: false }))
        void quietly(() => refresh($))
      })
    }
    if (ran.deny !== undefined || ran.isError) return ran
    await quietly(async () => {
      const stdout = (ran.result as { stdout?: string } | undefined)?.stdout
      if (start) await onStartCall($, start.step, start.card, stdout)
      if (isPacks) await onPacksCall($, e.command)
      if (isPr) await onStep($, { flow: 'superpowers', phase: 'done' })
      await paint($)
    })
    return ran
  })

  // A phase starts when its skill is called by the model or typed as a slash command. Not skill.prompt: a plugin
  // that runs first may answer it without passing it on.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    await quietly(() => onStep($, stepOf(qualified(e.skill))))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const name = e.command?.name
    if (name) await quietly(() => onStep($, stepOf(qualified(name))))
    return next(e)
  })

  // SDD runs most phases as subagents of its own types.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type) await quietly(() => onStep($, stepOf(e.subagent_type ?? '')))
    return next(e)
  })

  on('command.run', { command: 'spike-metro' }, async $ => {
    await $.ui.open(OPEN)
    return { text: 'Spike metro opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap) return <Text dimColor>Checking the line…</Text>
    if (!snap.isRunning) {
      return (
        <Box flexDirection="column">
          <Text bold>🚇 No train on the line</Text>
          <Text dimColor>{snap.message}</Text>
        </Box>
      )
    }
    const { before, shown, after } = windowOf(snap.stations, (e.viewport?.rows ?? 30) - 6)
    const passed = (kind: StationKind) => !kind.startsWith('next')
    return (
      <Box flexDirection="column">
        <Text bold>🚇 {snap.project ?? 'keiron-sequencer'}</Text>
        <Text dimColor>
          {snap.isRespike ? 'respike' : 'spike'} · run {snap.runId} · {snap.status}
        </Text>
        <Text>
          Station {snap.done}/{snap.total}
          {snap.cardCap ? ` (stop after ${snap.cardCap})` : ''} · run {tokens(snap.runTokens)}
          {snap.tokenCap ? ` of ${tokens(snap.tokenCap)}` : ''} tokens
        </Text>
        <Text> </Text>
        {before > 0 && <Text dimColor>   ┃ {before} earlier stations</Text>}
        {shown.map((station, i) => {
          const look = LOOK[station.kind]
          const label =
            station.kind === 'current' && snap.currentTokens != null
              ? `${look.label} · ${tokens(snap.currentTokens)} tokens`
              : look.label
          return (
            <Box flexDirection="column">
              <Text color={look.color} dimColor={look.isDim} bold={station.kind === 'current'}>
                {' '}{look.glyph}  {station.card}  {label}
              </Text>
              {i < shown.length - 1 && (
                <Text color={passed(station.kind) ? '#2E9E5B' : '#9CA3AF'} dimColor={!passed(station.kind)}>
                  {passed(station.kind) ? '   ┃' : '   ┆'}
                </Text>
              )}
            </Box>
          )
        })}
        {after > 0 && <Text dimColor>   ┆ {after} more stations ahead</Text>}
        <Text> </Text>
        <Text dimColor>● spiked  ◆ express (no tokens)</Text>
        <Text dimColor>↻ re-spiked  ○ ahead</Text>
        <Text dimColor>updated {snap.at.slice(11, 19)} UTC</Text>
      </Box>
    )
  })
}
