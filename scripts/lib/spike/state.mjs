import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitError } from '../cli.mjs';
import { holderAlive, RUN_ID, writeJsonAtomic } from './home.mjs';

const STATE_FILE = 'run.json';

export const RUN_STATUSES = ['active', 'paused', 'complete', 'abandoned'];
export const CARD_STATUSES = ['pending', 'in-progress', 'done'];

const isOpenRun = state => state.status === 'active' || state.status === 'paused';

// Patch names carry only the card number, so two cards sharing one would write the same patch.
function refuseSharedNumbers(plan) {
  const byNumber = new Map();
  for (const key of plan.order) {
    const n = plan.cards[key].number;
    if (byNumber.has(n)) throw new Error(`${byNumber.get(n)} and ${key} share the number ${n}: their patches would collide`);
    byNumber.set(n, key);
  }
}

const newTrack = (cards, { status = 'pending', current = null, repos = {} } = {}) => ({ cards, status, mergedInto: null, current, generation: 0, repos });

export function createRun({ runId, project, plan, home, dataDir, now }) {
  refuseSharedNumbers(plan);
  const at = now.toISOString();
  return {
    schemaVersion: 2,
    runId,
    status: 'active',
    project,
    createdAt: at,
    updatedAt: at,
    home,
    dataDir,
    plan,
    tracks: Object.fromEntries((plan.tracks ?? [{ id: 't1', cards: plan.order }]).map(t => [t.id, newTrack(t.cards)])),
    crossings: [],
    combine: { rounds: 0, results: [] },
    executions: [],
    cards: Object.fromEntries(plan.order.map(key => [key, { status: 'pending', box: null, windows: [], patches: [] }])),
    fixups: [],
  };
}

// A schema-1 run is one track t1; its trees keep the paths they were made at.
export function upgradeState(state) {
  if (state.tracks) return state;
  const { current = null, repos = {}, ...rest } = state;
  const started = Object.values(state.cards ?? {}).some(c => c.status !== 'pending');
  return { ...rest, schemaVersion: 2, tracks: { t1: newTrack(state.plan?.order ?? [], { status: started ? 'active' : 'pending', current, repos }) }, crossings: [], combine: { rounds: 0, results: [] } };
}

const liveTracks = state => Object.entries(state.tracks).filter(([, t]) => !t.mergedInto);

const liveTarget = (state, id) => (state.tracks[id].mergedInto ? liveTarget(state, state.tracks[id].mergedInto) : id);

// A merge whose process is gone holds nothing: a rerun of its cross takes it over.
export const mergingCrossing = (state, trackId, isAlive = p => process.kill(p, 0)) => state.crossings
  .find(c => c.merging && [c.fromTrack, c.toTrack].includes(trackId) && holderAlive(String(c.merging.pid), isAlive)) ?? null;

// Exit 75 answers busy like a full check slot: the command changed nothing and is run again.
export const mergingRefusal = c => Object.assign(exitError(75, `${c.fromTrack} is merging into ${c.toTrack}: run the command again once that cross ends`), {
  output: { action: 'busy', merging: { from: c.fromTrack, into: c.toTrack } },
});

export function trackIdOf(state, id) {
  if (id !== undefined) {
    if (!Object.hasOwn(state.tracks, id)) throw new Error(`${id} is not a track of run ${state.runId}`);
    if (state.tracks[id].mergedInto) throw new Error(`${id} was merged into ${liveTarget(state, id)}: pass --track ${liveTarget(state, id)}`);
    const merging = mergingCrossing(state, id);
    if (merging) throw mergingRefusal(merging);
    return id;
  }
  const live = liveTracks(state);
  if (live.length !== 1) throw new Error(`pass --track <id>: this run has ${live.length} tracks: ${live.map(([k]) => k).join(', ')}`);
  return live[0][0];
}

export const trackOf = (state, id) => state.tracks[trackIdOf(state, id)];

// A merged track keeps its cards list; they live on in the track it merged into.
export const trackOfCard = (state, card) => liveTracks(state).find(([, t]) => t.cards.includes(card))?.[0] ?? null;

// A card that an applied crossing says needs another card waits until that card is done; a deferred one gates nothing yet.
export const waitingOn = (state, card) => state.crossings
  .find(c => !c.pending && !c.merging && c.from === card && state.cards[c.to]?.status !== 'done')?.to ?? null;

// Every tree of the run, whichever track holds it.
export const allRepos = state => Object.values(state.tracks).flatMap(t => Object.entries(t.repos));

export function openExecution(state, { now, sessions, caps = { tokens: null, cards: null }, box = null }) {
  const execution = {
    id: state.executions.length + 1,
    startedAt: now.toISOString(),
    endedAt: null,
    endReason: null,
    caps,
    box,
    mark: null,
    sessions,
  };
  state.executions.push(execution);
  return execution;
}

// An execution still open when the next begin arrives was interrupted; its last CLI call is the last thing known of it.
export function closeOpenExecutions(state) {
  for (const e of state.executions.filter(x => !x.endedAt)) {
    e.endedAt = e.mark?.issuedAt ?? e.startedAt;
    e.endReason = e.endReason ?? 'interrupted';
  }
}

export function issueMark(state, execution, now) {
  const nonce = randomBytes(6).toString('hex');
  execution.mark = { nonce, issuedAt: now.toISOString() };
  return `keiron-sequencer-spike:${state.runId}:${execution.id}:${nonce}`;
}

// The box is fixed when the card's first window opens; a later execution only adds spend to it.
export function openCardWindow(state, card, execution, now) {
  const cardState = state.cards[card];
  const window = { execution: execution.id, start: now.toISOString(), end: null };
  if (cardState.status === 'pending') cardState.box = state.plan.cards[card].origin === 'existing-pr' ? null : execution.box ?? null;
  cardState.status = 'in-progress';
  cardState.windows.push(window);
  const track = state.tracks[trackOfCard(state, card)];
  track.status = 'active';
  track.current = { card, startedAt: window.start, execution: execution.id };
  return window;
}

// A card's risk areas and new paths are read against the trees as they stood when it first touched each repo.
export function noteStartTrees(state, card) {
  const cardState = state.cards[card];
  cardState.startTrees ??= {};
  for (const [repoDir, repo] of Object.entries(state.tracks[trackOfCard(state, card)].repos)) if (repo.status === 'open') cardState.startTrees[repoDir] ??= repo.last;
}

export function timeBoxFor(cardState) {
  if (cardState.box == null) return null;
  if (cardState.windows.some(w => typeof w.w !== 'number')) return null;
  const spent = Math.round(cardState.windows.reduce((sum, w) => sum + w.w, 0));
  return { budget: cardState.box, spent, over: spent > cardState.box };
}

// A closed window stays unsettled until its transcript shows a line after its end.
export function unsettledWindows(state) {
  const executions = new Map(state.executions.map(e => [e.id, e]));
  return Object.entries(state.cards).flatMap(([card, c]) => c.windows
    .filter(w => w.end && w.settled !== true)
    .map(window => ({ card, window, execution: executions.get(window.execution) })));
}

// Only cards ended in this execution count, so every execution starts its caps from zero. Spend is null, never 0,
// while any of those windows is unmeasured.
export function executionSpend(state, execution) {
  const done = Object.values(state.cards).filter(c => c.status === 'done');
  const windows = done.flatMap(c => c.windows.filter(w => w.execution === execution.id));
  return {
    cards: done.filter(c => c.windows.at(-1)?.execution === execution.id).length,
    tokens: windows.every(w => typeof w.w === 'number') ? windows.reduce((sum, w) => sum + w.w, 0) : null,
  };
}

export function capReached(execution, spend) {
  const { tokens, cards } = execution.caps;
  if (tokens != null && spend.tokens != null && spend.tokens >= tokens) return { reason: 'tokens', spent: Math.round(spend.tokens), cap: tokens };
  if (cards != null && spend.cards >= cards) return { reason: 'cards', spent: spend.cards, cap: cards };
  return null;
}

export const readState = dir => upgradeState(JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')));

export function saveState(dir, state, now) {
  state.updatedAt = now.toISOString();
  writeJsonAtomic(join(dir, STATE_FILE), state);
}

const subdirs = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []);

export function activeRuns(home) {
  const out = [];
  for (const slug of subdirs(home)) {
    for (const id of subdirs(join(home, slug, 'runs')).filter(n => RUN_ID.test(n))) {
      const dir = join(home, slug, 'runs', id);
      if (!existsSync(join(dir, STATE_FILE))) continue;
      const state = readState(dir);
      if (isOpenRun(state)) out.push({ dir, state });
    }
  }
  return out;
}

export function latestRun(home, slug) {
  const ids = subdirs(join(home, slug, 'runs')).filter(n => RUN_ID.test(n) && existsSync(join(home, slug, 'runs', n, STATE_FILE)));
  if (!ids.length) return null;
  const dir = join(home, slug, 'runs', ids.at(-1));
  return { dir, state: readState(dir) };
}

export function activeRunFor(home, slug) {
  const runs = activeRuns(home).filter(r => r.state.project.slug === slug);
  if (runs.length > 1) throw new Error(`more than one non-complete run for ${slug}: ${runs.map(r => r.state.runId).join(', ')}`);
  return runs[0] ?? null;
}
