import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register } from 'claude-code'

import type { CardStatus, Route, Snapshot, Station, StationKind, Track } from '../types'

const PANE = 'spike-metro'
const TITLE = 'Spike metro'
// The docked width it asks for; a width the person drags the dock to wins.
const OPEN = { id: PANE, title: TITLE, columns: 40 }
const DOCK = OPEN.columns
const POLL_MS = 10_000
// A login shell finds the same node the user runs the CLIs with. The root is passed as $1, never spliced into the script.
export const statusArgv = (root: string) => ['/bin/sh', '-lc', 'exec node "$1/scripts/spike.mjs" status', 'sh', root]

const snapshot = atom({ plugin: 'keiron-sequencer', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
// The card this session's checkout and branch are on, from the file start's branch step wrote.
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
  tracks?: { id: string; status: string; current: string | null; done: number; total: number; mergedInto: string | null; cards?: string[] }[]
}

const TURNED = new Set(['conflict', 'no-preimage', 'secret'])

export function stationsOf(s: StatusJson, only?: string[]): Station[] {
  const keep = (cards: string[] = []) => (only ? cards.filter(c => only.includes(c)) : cards)
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
    ...keep(s.cards?.done).map(card => ({ card, kind: kindOf(card, 'done') })),
    ...keep(s.cards?.inProgress).map(card => ({ card, kind: kindOf(card, 'current') })),
    ...keep(s.cards?.pending).map(card => ({ card, kind: kindOf(card, 'pending') })),
  ]
}

export function snapshotOf(exitCode: number, stdout: string, stderr: string, at: string): Snapshot {
  const idle = (message: string): Snapshot => ({
    at, isRunning: false, message, runId: null, status: null, project: null, isRespike: false,
    stations: [], tracks: [], done: 0, total: 0, current: null, currentTokens: null, runTokens: null, tokenCap: null, cardCap: null,
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
  const tracks: Track[] = (s.tracks ?? []).map(({ cards, ...t }) => ({ ...t, stations: stationsOf(s, cards ?? []) }))
  return {
    at,
    isRunning: true,
    message: '',
    runId: s.runId ?? null,
    status: s.status ?? null,
    project: s.project?.name ?? null,
    isRespike: Boolean(s.modes),
    stations,
    tracks,
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

export const liveTracks = (snap: Snapshot) => (snap.tracks ?? []).filter(t => !t.mergedInto)

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
  card?: { key?: string; project?: { slug?: string | null } }
  base?: { kind?: string; branch?: string | null } | null
  branch?: { name?: string | null } | null
  route?: { route?: Route | null; said?: string | null; reasons?: string[] } | null
  brief?: { pack?: { stale?: unknown; answered?: unknown[]; open?: unknown[] } | null } | null
}

type PackJson = { stamp?: unknown; questions?: { answer?: unknown }[] }

// What start.mjs branch writes for each branch it made or resumed, one file per checkout (scripts/lib/start/started.mjs).
export type Started = { card: string; slug: string | null; branch: string; at: string; plan: PlanJson; packStamp?: unknown }
type StartedFile = { path?: string; branches?: Record<string, Started> }

// FNV-1a over the path's UTF-16 code units, the same name start.mjs gives the file.
export function startedKey(checkoutPath: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < checkoutPath.length; i++) {
    hash ^= checkoutPath.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function startedOf(text: string | undefined, checkoutPath: string, branch: string): Started | null {
  const file = parsed<StartedFile>(text)
  if (file?.path !== checkoutPath) return null
  const entry = file.branches?.[branch]
  return entry?.plan?.card?.key && entry.branch === branch ? entry : null
}

const SPIKE_CALL = /scripts\/(?:re)?spike\.mjs["']?(?!\s+status\b)/
export const isSpikeCall = (command: string) => SPIKE_CALL.test(command)

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
  const live = snap ? liveTracks(snap).length : 0
  const where = live > 1 ? `${live} tracks` : snap?.current ?? 'between stations'
  $.ui.status(isOwner && snap?.isRunning ? `🚃 ${snap.done}/${snap.total} · ${where}` : on ? cardLine(on) : undefined)
}

const homeOf = async ($: Dollar) =>
  (await $.env.get('KEIRON_SEQUENCER_HOME')) || `${await $.env.get('HOME')}/.keiron-sequencer`

const readText = async ($: Dollar, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

// The checkout and branch the session is in, read the way start.mjs reads them, so the two name the same file.
async function checkoutOf($: Dollar) {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
    const [path, branch] = stdout.trim().split('\n')
    return exitCode === 0 && path && branch ? { path, branch } : null
  } catch {
    // Not a git checkout, or git is missing.
    return null
  }
}

const sameStamp = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// The card a start file holds, with its pack read again. A pack drafted after the start has a new stamp, so it is fresh;
// answers keep the stamp. The phase the session reached stays while the card and branch do.
export function cardOfStart(s: Started, pack: PackJson | null, prev: CardStatus | null): CardStatus | null {
  const plan = cardOfPlan(s.plan)
  if (!plan) return null
  const c: CardStatus = { ...plan, slug: s.slug ?? plan.slug, branch: s.branch, currentBranch: s.branch }
  if (pack) c.pack = packOfFile(pack, sameStamp(pack.stamp, s.packStamp) ? Boolean(s.plan.brief?.pack?.stale) : false)
  if (prev?.key === c.key && prev.branch === c.branch) return { ...c, flow: prev.flow, phase: prev.phase, isDone: prev.isDone }
  return c
}

// Correctness rests on the file start.mjs writes, not on how the command was spelled, so this runs after every Bash
// call and on each tick: a start chained, wrapped in a variable or run in a terminal lights the line all the same.
async function sync($: Dollar) {
  const at = await checkoutOf($)
  if (!at) return
  const home = await homeOf($)
  const started = startedOf(await readText($, `${home}/started/${startedKey(at.path)}.json`), at.path, at.branch)
  const prev = await read($, card)
  if (!started) {
    // No start on this branch: a card held from this checkout says the branch moved off it.
    if (prev && prev.currentBranch !== at.branch) await update($, card, c => (c ? { ...c, currentBranch: at.branch } : c))
    return
  }
  const pack = started.slug ? parsed<PackJson>(await readText($, `${home}/${started.slug}/packs/${started.card}.json`)) : null
  const next = cardOfStart(started, pack, prev)
  if (next && JSON.stringify(next) !== JSON.stringify(prev)) await update($, card, () => next)
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

async function refresh($: Dollar) {
  const snap = await poll($.plugin.root, argv => $.process.run(argv, { timeoutMs: 20_000 }), new Date().toISOString())
  await update($, snapshot, () => snap)
  try {
    await sync($)
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

  // Every Bash call may have started a card, however it was spelled; the call itself is never changed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isSpike = isSpikeCall(e.command)
    const ran = await next(e)
    if (isSpike) {
      await quietly(async () => {
        if (await read($, owner)) return
        await update($, owner, () => ({ hasOpened: false }))
        void quietly(() => refresh($))
      })
    }
    await quietly(async () => {
      await sync($)
      if (isPrCreate(e.command) && ran.deny === undefined && !ran.isError) await onStep($, { flow: 'superpowers', phase: 'done' })
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
    const passed = (kind: StationKind) => !kind.startsWith('next')
    const draw = (stations: Station[], rows: number, isShort: boolean) => {
      const { before, shown, after } = windowOf(stations, rows)
      return (
        <Box flexDirection="column">
          {before > 0 && <Text dimColor>   ┃ {before} earlier stations</Text>}
          {shown.map((station, i) => {
            const look = LOOK[station.kind]
            const tokensLabel = station.kind === 'current' && snap.currentTokens != null ? `${tokens(snap.currentTokens)} tokens` : ''
            const label = isShort ? (tokensLabel ? `· ${tokens(snap.currentTokens)}` : '') : tokensLabel ? `${look.label} · ${tokensLabel}` : look.label
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
        </Box>
      )
    }
    const rows = (e.viewport?.rows ?? 30) - 6
    const tracks = snap.tracks ?? []
    const live = liveTracks(snap)
    const fit = (text: string) => (text.length > DOCK ? `${text.slice(0, DOCK - 1)}…` : text)
    const title = snap.project ?? 'keiron-sequencer'
    const runLine = `${snap.isRespike ? 'respike' : 'spike'} · run ${snap.runId} · ${snap.status}`
    return (
      <Box flexDirection="column">
        {tracks.length > 1 ? (
          <>
            <Text bold>{fit(`🚇 ${title}`)}</Text>
            <Text dimColor>{fit(runLine)}</Text>
            <Text>{fit(`Station ${snap.done}/${snap.total}${snap.cardCap ? ` · stop after ${snap.cardCap}` : ''}`)}</Text>
            <Text>{fit(`${tokens(snap.runTokens)}${snap.tokenCap ? ` of ${tokens(snap.tokenCap)}` : ''} tokens`)}</Text>
          </>
        ) : (
          <>
            <Text bold>🚇 {title}</Text>
            <Text dimColor>{runLine}</Text>
            <Text>
              Station {snap.done}/{snap.total}
              {snap.cardCap ? ` (stop after ${snap.cardCap})` : ''} · run {tokens(snap.runTokens)}
              {snap.tokenCap ? ` of ${tokens(snap.tokenCap)}` : ''} tokens
            </Text>
          </>
        )}
        <Text> </Text>
        {tracks.length > 1
          ? tracks.map(t =>
              t.mergedInto ? (
                <Text dimColor>{t.id} ⤳ {t.mergedInto}</Text>
              ) : (
                <Box flexDirection="column">
                  <Text bold>
                    {t.id} · {t.done}/{t.total}{t.current ? ` · ${t.current}` : ''}
                  </Text>
                  {draw(t.stations, Math.floor(rows / live.length), true)}
                </Box>
              ),
            )
          : draw(snap.stations, rows, false)}
        <Text> </Text>
        <Text dimColor>● spiked  ◆ express (no tokens)</Text>
        <Text dimColor>↻ re-spiked  ○ ahead</Text>
        <Text dimColor>updated {snap.at.slice(11, 19)} UTC</Text>
      </Box>
    )
  })
}
