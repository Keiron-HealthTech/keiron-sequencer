import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseSource } from '../harvest.mjs';
import { COMBINE_FIXUP, PRIOR_FINDING_OUTCOMES } from '../record.mjs';
import { isLive, tiers, verdict } from '../records.mjs';
import { upgradeState } from '../spike/state.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byCard = (a, b) => cardNumber(a) - cardNumber(b) || compare(a, b);

export const norm = text => String(text).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');

// The previous record of a card is its newest history entry written by another run.
export function previousRecords(dataDir, state) {
  const out = new Map();
  for (const card of state.plan.order) {
    const dir = join(dataDir, state.project.slug, 'spike', 'history', card);
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
    const older = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter(r => r.refs?.runId !== state.runId);
    if (older.length) out.set(card, older.at(-1));
  }
  return out;
}

const sizeOf = r => (r?.size ? { prodLines: r.size.prodLines, testLines: r.size.testLines, files: r.size.files, repos: r.size.repos } : null);

// Items on one side only, matched by key; kept counts the keys found on both sides.
function matched(oldItems, newItems, keyOf, show = x => x, order = compare) {
  const index = items => new Map((items ?? []).map(x => [keyOf(x), x]));
  const before = index(oldItems);
  const now = index(newItems);
  const only = (a, b) => [...a].filter(([k]) => !b.has(k)).map(([, x]) => show(x)).sort(order);
  return { added: only(now, before), gone: only(before, now), kept: [...now.keys()].filter(k => before.has(k)).length };
}

const setMove = (oldValues, newValues, order = compare) => {
  const { added, gone } = matched(oldValues, newValues, x => x, x => x, order);
  return { added, gone };
};

const caseOut = c => ({ id: c.id, source: caseSource(c), given: c.given, when: c.when, then: c.then });
const byCase = (a, b) => cardNumber(a.id) - cardNumber(b.id) || compare(a.source, b.source);
const byFinding = (a, b) => compare(a.kind, b.kind) || compare(a.text, b.text);

function riskMove(oldAreas, newAreas) {
  const pathsOf = areas => new Map((areas ?? []).map(a => [a.kind, a.paths ?? []]));
  const before = pathsOf(oldAreas);
  const now = pathsOf(newAreas);
  const paths = {};
  for (const kind of [...new Set([...before.keys(), ...now.keys()])].sort(compare)) {
    const move = setMove(before.get(kind), now.get(kind));
    if (move.added.length || move.gone.length) paths[kind] = move;
  }
  return { ...setMove([...before.keys()], [...now.keys()]), paths };
}

const pair = (previous, current, read) => ({ old: previous ? read(previous) ?? null : null, new: current ? read(current) ?? null : null });

// The old tier is read over today's population with this card's previous record put back in its place.
function tierPair(card, current, previous, population, tierNow) {
  const tierThen = previous ? tiers([...population.filter(r => r.card !== card), previous]) : null;
  return { old: tierThen?.get(card) ?? null, new: current ? tierNow.get(card) ?? null : null };
}

// A record that gave each old finding an outcome is read by those outcomes; one that did not falls back to text matching.
function findingsMove(previous, current) {
  const show = f => ({ kind: f.kind, text: f.text });
  if (!Array.isArray(current?.priorFindings)) return matched(previous?.findings, current?.findings, f => `${f.kind}\u0000${norm(f.text)}`, show, byFinding);
  const outcomes = Object.fromEntries(PRIOR_FINDING_OUTCOMES.map(o => [o, current.priorFindings.filter(p => p.outcome === o).length]));
  return {
    added: (current.findings ?? []).map(show).sort(byFinding),
    gone: current.priorFindings.filter(p => p.outcome !== 'holds').map(p => ({ text: p.text, outcome: p.outcome })).sort((a, b) => compare(a.text, b.text)),
    kept: outcomes.holds,
    outcomes,
  };
}

function compareCard(card, current, previous, population, tierNow) {
  const tier = tierPair(card, current, previous, population, tierNow);
  return {
    card,
    previous: previous && { spikedAt: previous.spikedAt, runId: previous.refs?.runId ?? null },
    origin: pair(previous, current, r => r.origin),
    size: { old: sizeOf(previous), new: sizeOf(current), tier },
    verdict: { old: previous ? verdict(previous, tier.old) : null, new: current ? verdict(current, tier.new) : null },
    scopeComplete: pair(previous, current, r => r.scope?.complete),
    fixups: {
      received: setMove(previous?.fixups?.received?.map(f => f.from), current?.fixups?.received?.map(f => f.from), byCard),
      caused: setMove(previous?.fixups?.caused?.map(f => f.to), current?.fixups?.caused?.map(f => f.to), byCard),
    },
    cases: matched(previous?.cases, current?.cases, caseSource, caseOut, byCase),
    decisions: matched(previous?.decisions, current?.decisions, d => norm(d.text), d => d.text),
    findings: findingsMove(previous, current),
    openDecisions: matched(previous?.openDecisions, current?.openDecisions, d => norm(d.text), d => d.text),
    riskAreas: riskMove(previous?.riskAreas, current?.riskAreas),
    newPaths: setMove(previous?.novelty?.newPaths, current?.novelty?.newPaths),
  };
}

// A replayed record keeps its findings; only the fields recomputed from the fresh patches move, and their old values
// were kept in the run state. An empty replay changed nothing.
function compareReplayed(card, cardState, from, current, population, tierNow) {
  const kept = cardState.replay.before;
  const previous = kept && current
    ? { ...current, size: kept.size, riskAreas: kept.riskAreas, novelty: { ...current.novelty, newPaths: kept.newPaths } }
    : current;
  const tier = tierPair(card, current, previous, population, tierNow);
  return {
    card,
    status: cardState.replay.status,
    from,
    size: { old: sizeOf(previous), new: sizeOf(current), tier },
    verdict: { old: previous ? verdict(previous, tier.old) : null, new: current ? verdict(current, tier.new) : null },
    riskAreas: setMove(previous?.riskAreas?.map(a => a.kind), current?.riskAreas?.map(a => a.kind)),
    newPaths: setMove(previous?.novelty?.newPaths, current?.novelty?.newPaths),
  };
}

const dirOf = patch => patch.split('/')[0];

function turnedOf(card, replay) {
  if (replay.status === 'conflict') return { card, reason: replay.conflict.reason, repo: replay.conflict.repo, patch: replay.conflict.patch, sharedWith: [] };
  if (replay.status === 'typecheck') return { card, reason: 'typecheck', repo: replay.typecheck.repo, patch: null, sharedWith: [] };
  const patch = replay.hits?.[0]?.patch ?? null;
  return { card, reason: 'secret', repo: patch && dirOf(patch), patch, sharedWith: [] };
}

function projectLists(state, live, cards, replayed) {
  const { order, respike } = state.plan;
  const inRun = new Set(order);
  const open = new Set(respike.map?.open ?? []);
  const completed = new Set(respike.map?.completed ?? []);
  const byCardThen = (...keys) => (a, b) => byCard(a.card, b.card) || keys.reduce((d, k) => d || compare(String(a[k]), String(b[k])), 0);
  const turned = order.filter(k => ['conflict', 'secret', 'typecheck'].includes(state.cards[k].replay?.status)).map(k => turnedOf(k, state.cards[k].replay));
  const shared = (respike.ancestors ?? []).filter(a => a.reason === 'shared-patch' || a.reason === 'ancestor-spiked')
    .map(a => ({
      card: a.key, reason: a.reason, repo: null, patch: null, sharedWith: a.sharedWith ?? [],
      ...(a.reason === 'ancestor-spiked' ? { spikedAncestors: a.spikedAncestors ?? [] } : {}),
    }));
  return {
    slug: state.project.slug,
    name: state.project.name,
    newCards: cards.filter(c => !c.previous).map(c => c.card),
    orphans: live.filter(r => !open.has(r.card)).map(r => ({ card: r.card, reason: completed.has(r.card) ? 'completed' : 'off-map' })).sort(byCardThen()),
    built: (respike.built ?? []).map(b => ({ card: b.key, kind: b.kind, repoDir: b.repoDir })).sort(byCardThen('repoDir')),
    selectedBuilt: (respike.selection.dropped ?? []).filter(d => d.reason === 'built').map(d => d.key).sort(byCard),
    replayed: replayed.map(({ card, status, from }) => ({ card, status, from })),
    replayToSpike: [...turned, ...shared].sort(byCardThen('reason')),
    replanned: (respike.replans ?? []).flatMap(r => r.dropped.map(d => ({ card: d.card, patch: d.patch, reason: d.reason, cause: r.cause }))).sort(byCardThen('patch')),
    unselected: live.filter(r => open.has(r.card) && !inRun.has(r.card)).map(r => r.card).sort(byCard),
    pending: state.status === 'complete' ? [] : order.filter(k => state.cards[k].status !== 'done').sort(byCard),
  };
}

const trackList = state => Object.entries(state.tracks).map(([id, t]) => ({ id, status: t.status, mergedInto: t.mergedInto ?? null, cards: t.cards }));

function crossingList(state) {
  const { order } = state.plan;
  return state.crossings.map((c, i) => ({
    crossing: i, at: c.at, kind: c.kind, from: c.from, to: c.to, fromTrack: c.fromTrack, toTrack: c.toTrack,
    status: c.pending ? 'pending' : c.merging ? 'merging' : 'applied',
    note: c.note,
    respiked: c.respiked ?? [],
    replayed: order.filter(k => state.cards[k].mergedFrom?.crossing === i),
    droppedFixups: (state.fixups ?? []).filter(f => f.droppedBy?.crossing === i).map(f => f.patch),
  }));
}

// A failure's fixes are the combined fixups and crossings recorded after it and before the next round: round numbers start
// again at a resume, so they cannot tie a fix to its failure.
function combinedCheck(state) {
  const results = state.combine?.results ?? [];
  const within = (at, i) => at > results[i].at && (i + 1 === results.length || at <= results[i + 1].at);
  const fixups = (state.fixups ?? []).filter(f => f.from === COMBINE_FIXUP);
  return {
    passed: results.find(r => r.ok)?.at ?? null,
    failures: results.flatMap((r, i) => (r.ok ? [] : [{
      at: r.at,
      round: r.round,
      errors: r.errors,
      fixups: fixups.filter(f => within(f.at, i)).map(f => ({ patch: f.patch, fixed: f.fixed, note: f.note, dropped: Boolean(f.droppedBy) })),
      crossings: state.crossings.flatMap((c, k) => (within(c.at, i) ? [k] : [])),
    }])),
  };
}

const baseOf = b => ({ kind: b.kind, heads: b.heads ? b.heads.map(h => h.card) : null, behind: b.behind ?? null, ownCommits: b.ownCommits ?? null, warning: b.warning ?? null });

export function buildReport({ state: read, records, previous }) {
  const state = upgradeState(read);
  const { order, cards: planned, respike } = state.plan;
  const onMap = respike.map ? new Set([...respike.map.open, ...respike.map.completed]) : null;
  const live = records.filter(isLive);
  const population = live.filter(r => !onMap || onMap.has(r.card));
  const tierNow = tiers(population);
  const recordOf = card => live.find(r => r.card === card) ?? null;
  const spiked = order.filter(k => planned[k].mode === 'spike' && state.cards[k].status === 'done').sort(byCard);
  const cards = spiked.map(card => compareCard(card, recordOf(card), previous.get(card) ?? null, population, tierNow));
  const replayed = order.filter(k => ['replayed', 'empty'].includes(state.cards[k].replay?.status)).sort(byCard)
    .map(card => compareReplayed(card, state.cards[card], respike.replay[card]?.from ?? 'trial', recordOf(card), population, tierNow));
  const bases = Object.fromEntries(Object.keys(respike.bases ?? {}).sort(compare).map(dir => [dir, baseOf(respike.bases[dir])]));
  return {
    schemaVersion: 1,
    runId: state.runId,
    project: projectLists(state, live, cards, replayed),
    complete: state.status === 'complete',
    cards,
    replayed,
    bases,
    tracks: trackList(state),
    crossings: crossingList(state),
    combined: combinedCheck(state),
  };
}
