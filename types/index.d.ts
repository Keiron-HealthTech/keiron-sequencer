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

export type Route = 'sdd' | 'light' | 'tdd'

export type CardStatus = {
  key: string
  slug: string | null
  branch: string | null
  currentBranch: string | null
  route: Route | null
  isRouteFixed: boolean
  facts: { isMultiRepo: boolean; tier: string | null; newPaths: number; fixupsReceived: number; peopleDecisions: number }
  stackedOn: string | null
  pack: { isStale: boolean; answered: number; open: number } | null
  flow: 'sdd' | 'superpowers' | null
  phase: string | null
  isDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'keiron-sequencer': {
      snapshot: Shaped<Snapshot | null>
      planned: Shaped<CardStatus | null>
      card: Shaped<CardStatus | null>
    }
  }
}
