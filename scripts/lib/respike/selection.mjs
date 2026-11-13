import { exitError } from '../cli.mjs';
import { cycles } from '../graph.mjs';
import { spikeOrder } from '../spike/order.mjs';
import { resolvePatches } from '../start/brief.mjs';
import { cardRepos, mapRepo } from '../start/checkout.mjs';
import { staleness, stalenessFiles } from '../start/staleness.mjs';
import { runChain } from '../spike/run-base.mjs';

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byNumber = (a, b) => cardNumber(a) - cardNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
const isCompleted = card => card.statusType === 'completed';

const sorted = list => [...list].sort((a, b) => byNumber(a.key, b.key));

// staleOf answers { why: 'new' }, { why: 'stale', staleness }, { unknown: reason }, { touched } (same-file commits outside the
// card's hunks: shown, never selected) or null (fresh).
export function selectCards(analysis, { cards: picked = null, stale = false, all = false, isBuilt = () => false, staleOf = () => null } = {}) {
  const byKey = new Map(analysis.cards.map(c => [c.key, c]));
  const missing = (picked ?? []).filter(k => !byKey.has(k));
  if (missing.length) throw exitError(2, `not an execution card on the project map: ${missing.join(', ')}`);
  const out = new Map();
  const dropped = new Set();
  const unknown = [];
  const touched = [];
  const runnable = k => !isCompleted(byKey.get(k)) && !isBuilt(k);
  const take = (keys, why) => {
    for (const key of keys) {
      if (runnable(key)) out.set(key, { key, why, staleness: null });
      else dropped.add(key);
    }
  };
  if (picked) take([...new Set(picked)], 'picked');
  if (stale) {
    for (const c of analysis.cards.filter(c => runnable(c.key) && !out.has(c.key))) {
      const found = staleOf(c.key);
      if (found?.unknown) unknown.push({ key: c.key, reason: found.unknown });
      else if (found?.touched) touched.push({ card: c.key, ...found.touched });
      else if (found) out.set(c.key, { key: c.key, why: found.why, staleness: found.staleness ?? null });
    }
  }
  if (all || (!picked && !stale)) take(analysis.cards.filter(c => !isCompleted(c) && !out.has(c.key)).map(c => c.key), 'all');
  const mode = all ? 'all' : picked && stale ? 'cards+stale' : picked ? 'cards' : stale ? 'stale' : 'all';
  return {
    mode, cards: sorted(out.values()), unknown: sorted(unknown), touched: touched.sort((a, b) => byNumber(a.card, b.card)), dropped: [...dropped].sort(byNumber).map(key => ({ key, reason: 'built' })),
  };
}

const commitCount = group => group.commits.length + group.more;

// Stale means a commit by anyone but the card itself changed the card's hunks since spikedAt, on the default branch as last
// fetched; a commit elsewhere in the same file is touched. Without a run base the whole file counts, as before.
export function cardStaleness(git, { config, card, record, home, slug, projectKeys, refsOf }) {
  if (!record) return { why: 'new' };
  const repos = cardRepos(card, record, record.refs?.patches, config).filter(r => r.dir);
  if (!repos.length) return { unknown: `${card.key} names no repo with a configured entry` };
  const patches = resolvePatches(record, { home, slug });
  let commits = 0;
  const touchedCommits = [];
  const reasons = [];
  const unchecked = [];
  for (const { dir } of repos) {
    const repo = config.repos[dir];
    if (!repo.checkout || !repo.remote || !repo.defaultBranch) {
      reasons.push(`${dir} has no checkout, remote or default branch`);
      unchecked.push(dir);
      continue;
    }
    const isCurrent = d => mapRepo(config, d)?.dir === dir;
    const patchDir = patches.find(p => isCurrent(p.repoDir))?.repoDir ?? dir;
    const { baseCommit, patchTexts, chainedFiles, combine } = runChain(record, { home, slug, repoDir: dir, patchDir });
    const s = staleness(git, {
      cwd: repo.checkout, remote: repo.remote, baseRef: repo.defaultBranch, tracking: refsOf(dir),
      ...stalenessFiles({ patches, record, isCurrent }),
      spikedAt: record.spikedAt, baseCommit, patchTexts, chainedFiles, combine, projectKeys, cardKey: card.key, blockerPrNumbers: [],
    });
    if (!s.computed) { reasons.push(`${dir}: ${s.reason}`); unchecked.push(dir); continue; }
    commits += commitCount(s.groups.sibling) + commitCount(s.groups.unrelated);
    touchedCommits.push(...s.touched.commits);
  }
  if (commits) return { why: 'stale', staleness: { commits, unchecked } };
  if (touchedCommits.length && !reasons.length) {
    return { touched: { commits: touchedCommits.length, files: [...new Set(touchedCommits.flatMap(c => c.files))].sort() } };
  }
  return reasons.length ? { unknown: reasons.join('; ') } : null;
}

// Walks the blocks edges upward from the selected cards through every card, built and completed ones included.
export function ancestorsOf(analysis, selected, { isBuilt = () => false } = {}) {
  const blockers = new Map();
  for (const e of analysis.edges) blockers.set(e.to, [...(blockers.get(e.to) ?? []), e.from]);
  const seen = new Set(selected);
  const stack = [...selected];
  while (stack.length) {
    for (const k of blockers.get(stack.pop()) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(k);
    }
  }
  const byKey = new Map(analysis.cards.map(c => [c.key, c]));
  return [...seen].filter(k => !selected.includes(k) && !isCompleted(byKey.get(k)) && !isBuilt(k)).sort(byNumber);
}

// One edge X -> Y for every path from entry X to entry Y whose inner cards are all outside the run (built or merged).
function contractedEdges(edges, wanted) {
  const next = new Map();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const out = [];
  for (const from of wanted) {
    const seen = new Set();
    const stack = [...(next.get(from) ?? [])];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      if (wanted.has(k)) out.push({ from, to: k });
      else stack.push(...(next.get(k) ?? []));
    }
  }
  return out;
}

export function entryOrder(analysis, entries, { rank = null } = {}) {
  const wanted = new Set(entries);
  const loops = cycles(analysis.cards, analysis.edges).filter(group => group.some(k => wanted.has(k)));
  if (loops.length) return { order: [], cycles: loops };
  const { order } = spikeOrder({ cards: analysis.cards.filter(c => wanted.has(c.key)), edges: contractedEdges(analysis.edges, wanted) }, { rank });
  return { order, cycles: [] };
}
