import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parsePatchName } from '../../backfill/patch-map.mjs';
import { invert, readDirMap } from '../patch-dirs.mjs';
import { COMBINE_FIXUP } from '../record.mjs';
import { isLive } from '../records.mjs';
import { runDir, statePath, trialPatchRoot } from '../spike/home.mjs';
import { allRepos, upgradeState } from '../spike/state.mjs';
import { mapRepo } from '../start/checkout.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = patch => patch.split('/')[0];
const prefixOf = key => String(key).replace(/-\d+$/, '');
const TWO_CARDS = /^(\d{5})-(\d{5})(?:-|\.patch$)/;

// A trial card patch named for two cards (03920-03922-finish.patch) names both, whoever's record holds it.
function namedCards(patch, holder) {
  const m = basename(patch).match(TWO_CARDS);
  return m ? [m[1], m[2]].map(n => `${prefixOf(holder)}-${Number(n)}`) : [];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// A record replays from the run that holds its patches while that run exists; otherwise from the trial root.
function sourceOf(record, { home, slug }) {
  const runId = record.refs.runId;
  if (runId && existsSync(runDir(home, slug, runId))) return { from: runId, root: join(runDir(home, slug, runId), 'patches') };
  return { from: 'trial', root: trialPatchRoot(home, slug) };
}

function logNames(source, dir, { home, slug, trialLogDir }) {
  if (source.from !== 'trial') {
    const state = readJson(statePath(home, slug, source.from));
    return (state ? allRepos(upgradeState(state)) : []).filter(([d]) => d === dir).flatMap(([, r]) => r.log ?? []).map(e => e.name);
  }
  const trialDir = invert(readDirMap(trialPatchRoot(home, slug)))[dir] ?? dir;
  const path = join(trialLogDir ?? '', trialDir, 'log.txt');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').map(l => l.split(/\s+/)[0]).filter(Boolean) : [];
}

// Patches named in the log come in log order; the rest follow by name. Log names the record does not hold are ignored.
function inLogOrder(patches, source, ctx) {
  const rank = new Map();
  for (const dir of new Set(patches.map(dirOf))) logNames(source, dir, ctx).forEach((name, i) => { if (!rank.has(`${dir}/${name}.patch`)) rank.set(`${dir}/${name}.patch`, i); });
  return [...patches].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || compare(a, b));
}

function fixedBy(patch, source, holder, ctx) {
  if (source.from !== 'trial') {
    const known = (readJson(statePath(ctx.home, ctx.slug, source.from))?.fixups ?? []).find(f => f.patch === patch);
    if (known) return known.fixed;
  }
  const parsed = parsePatchName(patch);
  return parsed ? parsed.fixed.map(k => `${prefixOf(holder)}-${k.split('-')[1]}`) : [holder];
}

function candidate(key, record, ctx) {
  const spike = (reason, extra = {}) => ({ key, mode: 'spike', reason, from: null, patches: [], dropped: [], sharedWith: [], units: {}, ...extra });
  if (!record || !isLive(record)) return { entry: spike('no-record') };
  const source = sourceOf(record, ctx);
  const folded = new Set(record.replayed?.folded ?? []);
  const fixups = [...new Map((record.fixups?.received ?? []).filter(f => !folded.has(f.patch)).map(f => [f.patch, f])).values()];
  const cardPatches = [...new Set(record.refs.patches)];
  const set = [...new Set([...cardPatches, ...fixups.map(f => f.patch)])];
  const missing = set.filter(p => !existsSync(join(source.root, p))).sort(compare);
  if (!cardPatches.length || missing.length) return { entry: spike('patch-missing', missing.length ? { missing } : {}) };
  return { source, cardPatches, fixups, entry: { key, mode: 'replay', reason: null, from: source.from, patches: [], dropped: [], sharedWith: [], units: {} } };
}

// ancestors: unbuilt, unselected walked cards; order(modes) gives the run order of the entries once the modes are known.
export function replayPlans({ ancestors, selected = [], records, isBuilt, home, slug, config, trialLogDir, order, edges = [] }) {
  const ctx = { home, slug, trialLogDir };
  const plans = new Map(ancestors.map(k => [k, candidate(k, records.get(k), ctx)]));
  const replaying = k => plans.get(k)?.entry.mode === 'replay';
  const present = k => isBuilt(k) || replaying(k);
  const holdersOf = (patch, from) => [...records.values()]
    .filter(r => isLive(r) && r.refs.patches.includes(patch) && sourceOf(r, ctx).from === from).map(r => r.card).sort(compare);

  // A card patch naming several cards came from the hand-run trial; it is never replayed, so each card it names is
  // re-spiked and gets a patch of its own.
  const sharing = new Map();
  for (const [key, p] of plans) {
    if (!replaying(key)) continue;
    for (const patch of p.cardPatches) {
      const others = [...holdersOf(patch, p.source.from), ...namedCards(patch, key)].filter(k => k !== key);
      for (const [a, b] of others.flatMap(o => [[key, o], [o, key]])) sharing.set(a, new Set([...(sharing.get(a) ?? []), b]));
    }
  }
  for (const [key, others] of sharing) {
    const p = plans.get(key);
    if (p?.entry.mode !== 'replay') continue;
    p.entry = { ...p.entry, mode: 'spike', reason: 'shared-patch', from: null, sharedWith: [...others].sort(compare) };
  }

  // A replay whose blocker, at any depth, is spiked fresh would land on code that spike changes: it is spiked too. Decided
  // here, at plan time; a replay that turns into a spike mid-run is caught by the typecheck at replay.
  const blockersOf = new Map();
  for (const e of edges) blockersOf.set(e.to, [...(blockersOf.get(e.to) ?? []), e.from]);
  const above = key => {
    const seen = new Set();
    const stack = [...(blockersOf.get(key) ?? [])];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(...(blockersOf.get(k) ?? []));
    }
    return seen;
  };
  const spiked = k => selected.includes(k) || plans.get(k)?.entry.mode === 'spike';
  for (let flipped = true; flipped;) {
    flipped = false;
    for (const [key, p] of plans) {
      if (p.entry.mode !== 'replay' || ![...above(key)].some(spiked)) continue;
      p.entry = { ...p.entry, mode: 'spike', reason: 'ancestor-spiked', from: null };
      flipped = true;
    }
  }
  for (const [key, p] of plans) {
    if (p.entry.reason === 'ancestor-spiked') p.entry.spikedAncestors = [...above(key)].filter(spiked).sort(compare);
  }

  const modes = new Map([...[...plans].map(([k, p]) => [k, p.entry.mode]), ...selected.map(k => [k, 'spike'])]);
  const position = new Map(order(modes).map((k, i) => [k, i]));

  const owner = new Map();
  const source = new Map();
  const claim = (patch, unit, from) => {
    if (owner.has(patch) && position.get(owner.get(patch)) >= position.get(unit)) return;
    owner.set(patch, unit);
    source.set(patch, from);
  };
  for (const [key, p] of plans) {
    if (!replaying(key)) continue;
    for (const patch of p.cardPatches) claim(patch, key, p.source.from);
    const kept = [];
    for (const f of p.fixups) {
      const fixed = fixedBy(f.patch, p.source, key, ctx);
      if (f.from !== COMBINE_FIXUP && !present(f.from)) { p.entry.dropped.push({ patch: f.patch, reason: 'from-absent' }); continue; }
      if (!fixed.every(present)) { p.entry.dropped.push({ patch: f.patch, reason: 'fixed-absent' }); continue; }
      kept.push(f.patch);
      // A fixup adapts its fixed cards to its from card's change: it lands only once all of them have replayed.
      const last = [f.from, ...fixed, key].filter(replaying).sort((a, b) => position.get(b) - position.get(a))[0];
      claim(f.patch, last, p.source.from);
    }
    p.entry.patches = [...p.cardPatches, ...kept].sort(compare);
    p.entry.dropped.sort((a, b) => compare(a.patch, b.patch));
  }
  for (const [key, p] of plans) {
    if (!replaying(key)) continue;
    const mine = [...owner].filter(([, k]) => k === key).map(([patch]) => patch);
    const units = {};
    for (const patch of inLogOrder(mine, p.source, ctx)) {
      const dir = mapRepo(config, dirOf(patch))?.dir ?? dirOf(patch);
      units[dir] = [...(units[dir] ?? []), patch];
    }
    p.entry.units = units;
    const foreign = Object.fromEntries(mine.filter(patch => source.get(patch) !== p.source.from).map(patch => [patch, source.get(patch)]));
    if (Object.keys(foreign).length) p.entry.sources = foreign;
  }
  return ancestors.map(k => plans.get(k).entry);
}

const without = (list, patch) => list.filter(p => p !== patch);

// After an entry turned into a spike, the pending replays follow the same presence rules again: a kept fixup whose from card
// or fixed card is a spike is dropped from every pending set and unit. records holds the live record of every replay entry,
// since a fixup's receiver may be done already.
export function replanReplay({ replay, pending, isSpike, records, home, slug }) {
  const out = structuredClone(replay);
  const dropped = [];
  const spiking = isSpike;
  const holds = (e, patch) => e.patches.includes(patch) || Object.values(e.units).some(ps => ps.includes(patch));
  const drop = (patch, reason) => {
    for (const k of pending.filter(x => holds(out[x], patch))) {
      const e = out[k];
      e.patches = without(e.patches, patch);
      e.dropped = [...e.dropped, { patch, reason }].sort((a, b) => compare(a.patch, b.patch));
      e.units = Object.fromEntries(Object.entries(e.units).map(([d, ps]) => [d, without(ps, patch)]).filter(([, ps]) => ps.length));
      e.replanned = true;
      dropped.push({ card: k, patch, reason });
    }
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, record] of records) {
      for (const f of record?.fixups?.received ?? []) {
        if (!pending.some(k => holds(out[k], f.patch))) continue;
        const reason = spiking(f.from) ? 'from-absent' : fixedBy(f.patch, { from: out[key]?.from }, key, { home, slug }).some(spiking) ? 'fixed-absent' : null;
        if (!reason) continue;
        drop(f.patch, reason);
        changed = true;
      }
    }
  }
  return { replay: out, dropped };
}
