import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { exitError } from '../cli.mjs';
import { COMBINE_FIXUP } from '../record.mjs';
import { spikeOrder } from './order.mjs';
import { assertSnapshotted, mergedTree, replanAfterTurn } from './replay.mjs';
import { DIFF } from './snapshot.mjs';
import { trackOfCard } from './state.mjs';
import { openTree } from './trees.mjs';
import { repoTypecheck, typecheckLog } from './typecheck.mjs';

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const CARD_ENTRY = /^(\d{5})-(?:new|existing)$/;

function reach(edges, from, { up = false } = {}) {
  const next = new Map();
  for (const e of edges) {
    const [a, b] = up ? [e.to, e.from] : [e.from, e.to];
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const seen = new Set();
  const stack = [...(next.get(from) ?? [])];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(next.get(k) ?? []));
  }
  return seen;
}

// A crossing C -> B is the blocks edge B -> C. A `changes` crossing also keeps C ahead of the cards below B it re-spiked, so a
// later merge cannot order them before C's fix again.
export function runEdges(state, { pending = false } = {}) {
  const crossings = state.crossings.filter(c => pending || (!c.pending && !c.merging));
  const base = [...(state.plan.edges ?? []), ...crossings.map(c => ({ from: c.to, to: c.from }))];
  const after = crossings.filter(c => c.kind === 'changes').flatMap(c => {
    const below = reach(base, c.to);
    return c.respiked.filter(k => k !== c.from && below.has(k) && !reach(base, k).has(c.from)).map(k => ({ from: c.from, to: k }));
  });
  return [...base, ...after];
}

// Deferred crossings count: two of them pointing at each other would merge into a cycle once both are applied.
export const closesCycle = (state, B, C) => B === C || reach(runEdges(state, { pending: true }), C).has(B);

function orderOf(state, cards, edges, rank) {
  const { order } = spikeOrder({ cards: cards.map(key => ({ key, milestoneOrder: state.plan.cards[key].milestoneOrder })), edges }, { rank });
  if (order.length !== cards.length) throw new Error(`the merged order lost ${cards.filter(k => !order.includes(k)).join(', ')}: its edges hold a cycle`);
  return order;
}

const isDone = (state, k) => state.cards[k].status === 'done';

// The done cards below B, before C in the merged order: they were built on the B that C is about to change. C ranks as not
// done even when it is, so a done dependent numbered after C still sorts before it.
export function dependentsBefore(state, B, C) {
  const cards = [...new Set([B, C].flatMap(k => state.tracks[trackOfCard(state, k)].cards))];
  const edges = [...runEdges(state), { from: B, to: C }];
  const order = orderOf(state, cards, edges, k => (isDone(state, k) && k !== C ? 0 : 1));
  const below = reach(edges, B);
  return order.slice(0, order.indexOf(C)).filter(k => below.has(k) && isDone(state, k));
}

// A card patch carries the card's number; a fixup belongs to the card it was made while working.
function ownerOf(state, repoDir, name) {
  const m = name.match(CARD_ENTRY);
  if (m) return state.plan.order.find(k => cardNumber(k) === Number(m[1])) ?? null;
  return state.fixups.find(f => f.patch === `${repoDir}/${name}.patch`)?.from ?? null;
}

// A done card stays done only while everything above it does: the cards below a re-spiked one were built on it.
function closeBelow(state, respiked, edges) {
  for (const k of [...respiked]) for (const d of reach(edges, k)) if (isDone(state, d)) respiked.add(d);
}

// Each entry is applied with a 3-way merge onto the tree before it, in a temporary index: the tree's files do not move.
function applyEntries(git, repoDir, repo, tip, names, { dir, into }) {
  const entries = [];
  for (const name of names) {
    const index = join(dir, 'tmp', into, `merge-${repoDir}.index`);
    const r = mergedTree(git, repoDir, { ...repo, last: tip }, [name], { index, pathOf: n => join(dir, 'patches', repoDir, `${n}.patch`) });
    if (r.conflict) return { conflict: name };
    if (r.tree !== tip) entries.push({ name, from: tip, tree: r.tree });
    tip = r.tree;
  }
  return { entries, tip };
}

function moveTree(git, repo, to) {
  git(['read-tree', '-m', '-u', repo.last, to], { cwd: repo.path });
  repo.last = to;
}

// The patch of each re-applied entry is cut again against the tree it now sits on, so rebuild can plain-apply the log.
function logEntries(git, repoDir, repo, entries, { dir }) {
  const writes = entries.map(e => ({ path: join(dir, 'patches', repoDir, `${e.name}.patch`), text: git([...DIFF, e.from, e.tree], { cwd: repo.path }) }));
  repo.log.push(...entries.map(e => ({ name: e.name, tree: e.tree, stat: git(['diff', '--shortstat', e.from, e.tree], { cwd: repo.path }).trim() })));
  return writes;
}

// Every tree of the track goes back to the snapshot before the first entry of a re-spiked card, and the later entries of the
// other cards are applied again on top. A card whose entry no longer applies is re-spiked too, in every repo.
function cutTrees(git, state, trackId, respiked, edges, ctx) {
  const open = Object.entries(state.tracks[trackId].repos).filter(([, r]) => r.status === 'open');
  for (;;) {
    closeBelow(state, respiked, edges);
    const cuts = [];
    let failed = null;
    for (const [repoDir, repo] of open) {
      const at = repo.log.findIndex(e => respiked.has(ownerOf(state, repoDir, e.name)));
      if (at === -1) continue;
      const again = repo.log.slice(at).filter(e => !respiked.has(ownerOf(state, repoDir, e.name))).map(e => e.name);
      const r = applyEntries(git, repoDir, repo, at ? repo.log[at - 1].tree : repo.baseTree, again, ctx);
      if (r.conflict) { failed = { repoDir, name: r.conflict, card: ownerOf(state, repoDir, r.conflict) }; break; }
      cuts.push({ repoDir, repo, at, ...r });
    }
    if (failed && !failed.card) throw new Error(`${failed.repoDir}/${failed.name}.patch no longer applies and belongs to no card of the run`);
    if (failed) { respiked.add(failed.card); continue; }
    return cuts.flatMap(({ repoDir, repo, at, entries, tip }) => {
      moveTree(git, repo, tip);
      repo.log = repo.log.slice(0, at);
      return logEntries(git, repoDir, repo, entries, ctx);
    });
  }
}

// One card of the merged track, onto the target's trees: every repo is merged before any moves, and each moved tree is
// type-checked over what the card changed. On a conflict or a failed check the trees stay where they were before it.
function replayCard(git, state, card, from, ctx) {
  const { into, config, dir, runSetup } = ctx;
  const planned = [];
  for (const [repoDir, source] of Object.entries(state.tracks[from].repos)) {
    const names = source.log.filter(e => ownerOf(state, repoDir, e.name) === card).map(e => e.name);
    if (!names.length) continue;
    const repo = openTree(git, state, { trackId: into, repoDir, repo: config.repos[repoDir], dir, runSetup });
    const r = applyEntries(git, repoDir, repo, repo.last, names, ctx);
    if (r.conflict) return null;
    planned.push({ repoDir, repo, ...r });
  }
  const moved = [];
  for (const p of planned.filter(x => x.tip !== x.repo.last)) {
    const changed = git(['diff', '--name-only', '--diff-filter=d', p.repo.last, p.tip], { cwd: p.repo.path }).split('\n').filter(Boolean);
    moved.push({ p, back: p.repo.last });
    moveTree(git, p.repo, p.tip);
    const check = repoTypecheck(runSetup, config.repos[p.repoDir], { treePath: p.repo.path, changed, logPath: typecheckLog(dir, into, p.repoDir) });
    if (check.ran && !check.ok) {
      for (const m of moved) moveTree(git, m.p.repo, m.back);
      return null;
    }
  }
  return planned.flatMap(p => logEntries(git, p.repoDir, p.repo, p.entries, ctx));
}

function assertAtLast(git, state, trackId) {
  for (const [repoDir, repo] of Object.entries(state.tracks[trackId].repos).filter(([, r]) => r.status === 'open')) {
    try {
      assertSnapshotted(git, repoDir, repo);
    } catch (e) {
      throw exitError(e.exitCode ?? 1, `${e.message}; a merge starts only from there, and that work belongs to no card in progress (a replay of ${trackId} killed mid-way leaves such work): report it before running cross again`);
    }
  }
}

// Track `from` joins `into` (the crossing's entry already sits at index `crossing`): `into`'s trees go back before the cards a
// `changes` crossing re-spikes, then `from`'s done cards are replayed onto them in `from`'s order. With from === into the
// crossing applies inside one track: only the edge and the re-spikes. `parked` is a card of `into` whose work the caller already
// set aside; it restarts like C. Patches come back as writes and records as the cards whose record the caller rewrites, both
// for the caller to make once it keeps the merge.
export function mergeTracks(state, { from, into, edge, kind, crossing, parked = null }, { git, dir, config, runSetup, dataDir }) {
  const C = edge.to;
  const ctx = { into, config, dir, runSetup };
  mkdirSync(join(dir, 'tmp', into), { recursive: true });
  assertAtLast(git, state, into);
  const edges = [...runEdges(state), edge];
  const respiked = new Set(kind === 'changes' ? dependentsBefore(state, edge.from, C) : []);
  if (isDone(state, C)) respiked.add(C);
  const writes = cutTrees(git, state, into, respiked, edges, ctx);

  const replayed = [];
  for (const card of from === into ? [] : state.tracks[from].cards.filter(k => isDone(state, k))) {
    closeBelow(state, respiked, edges);
    if (respiked.has(card)) continue;
    const out = replayCard(git, state, card, from, ctx);
    if (!out) { respiked.add(card); continue; }
    writes.push(...out);
    replayed.push(card);
  }
  closeBelow(state, respiked, edges);

  const turned = [...respiked].filter(k => state.plan.cards[k].mode === 'replay');
  for (const k of new Set([...respiked, C, ...(parked ? [parked] : [])])) {
    const cardState = state.cards[k];
    cardState.status = 'pending';
    delete cardState.startTrees;
    delete cardState.prDiff;
    state.plan.cards[k].mode = 'spike';
  }
  if (parked && state.tracks[into].current?.card === parked) state.tracks[into].current = null;
  for (const k of respiked) state.cards[k].respikedBy = { crossing };
  for (const k of replayed) state.cards[k].mergedFrom = { track: from, crossing };

  const entry = state.crossings[crossing];
  delete entry.pending;
  delete entry.merging;
  entry.respiked = [...respiked].sort((a, b) => cardNumber(a) - cardNumber(b));
  const merged = runEdges(state);
  const ahead = new Set([C, ...[...reach(merged, C, { up: true })].filter(k => !isDone(state, k))]);
  const rank = k => (ahead.has(k) ? 0 : state.plan.cards[k].mode === 'replay' ? 1 : 2);
  const target = state.tracks[into];
  target.cards = orderOf(state, [...new Set([...target.cards, ...state.tracks[from].cards])], merged, rank);
  target.status = target.cards.some(k => isDone(state, k)) ? 'active' : 'pending';
  target.generation += 1;
  if (from !== into) Object.assign(state.tracks[from], { status: 'merged', mergedInto: into, current: null, generation: state.tracks[from].generation + 1 });

  // A fixup belongs to the card that made it: when that card's entries left the trees, its fixups left with them. A fix made on
  // the combined tree fitted the cards as they were, so it leaves once any card it fixed is re-spiked.
  const live = new Set(Object.entries(target.repos).flatMap(([d, r]) => r.log.map(e => `${d}/${e.name}.patch`)));
  const orphaned = f => (f.from === COMBINE_FIXUP ? f.fixed.some(k => respiked.has(k)) : target.cards.includes(f.from) && !live.has(f.patch));
  const dropped = state.fixups.filter(f => !f.droppedBy && orphaned(f));
  for (const f of dropped) f.droppedBy = { crossing };

  if (state.plan.respike) for (const k of turned) replanAfterTurn(state, { dataDir }, k);
  const records = [...new Set([...respiked, ...replayed, ...dropped.flatMap(f => [f.from, ...f.fixed])])].filter(k => k !== COMBINE_FIXUP);
  return { replayed, respiked: entry.respiked, dropped: dropped.map(f => f.patch), records, writes };
}
