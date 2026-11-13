import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot, Station, StationKind } from '../types'

const PANE = 'spike-metro'
const TITLE = 'Spike metro'
const POLL_MS = 10_000
// A login shell finds the same node the user runs the CLIs with. The root is passed as $1, never spliced into the script.
export const statusArgv = (root: string) => ['/bin/sh', '-lc', 'exec node "$1/scripts/spike.mjs" status', 'sh', root]

const snapshot = atom({ plugin: 'keiron-sequencer', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'spike-metro', description: 'Show the running spike as a metro line' })
    let hasOpened = false
    const refresh = async () => {
      const snap = await poll($.plugin.root, argv => $.process.run(argv, { timeoutMs: 20_000 }), new Date().toISOString())
      await update($, snapshot, () => snap)
      $.ui.status(snap.isRunning ? `🚃 ${snap.done}/${snap.total} · ${snap.current ?? 'between stations'}` : undefined)
      if (snap.isRunning && !hasOpened) {
        hasOpened = true
        void $.ui.open({ id: PANE, title: TITLE })
      }
    }
    void refresh()
    $.clock.every(POLL_MS, refresh)
    return started
  })

  on('command.run', { command: 'spike-metro' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
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
        <Text dimColor>● spiked  ◆ express (replayed, no tokens)  ↻ re-spiked  ○ ahead</Text>
        <Text dimColor>updated {snap.at.slice(11, 19)} UTC</Text>
      </Box>
    )
  })
}
