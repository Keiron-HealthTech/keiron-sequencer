export type StationKind =
  | 'spiked'
  | 'replayed'
  | 'empty'
  | 'respiked'
  | 'current'
  | 'next-spike'
  | 'next-replay'

export type Station = { card: string; kind: StationKind }

export type Snapshot = {
  at: string
  isRunning: boolean
  message: string
  runId: string | null
  status: string | null
  project: string | null
  isRespike: boolean
  stations: Station[]
  done: number
  total: number
  current: string | null
  currentTokens: number | null
  runTokens: number | null
  tokenCap: number | null
  cardCap: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'keiron-sequencer': { snapshot: Shaped<Snapshot | null> }
  }
}
