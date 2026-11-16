import { GITHUB_PULL } from './linear-fetch.mjs';

export const DECISION_LABEL = 'map';
export const DELIVERY_LABEL = 'map:design-delivery';

export const isQaIssue = node =>
  (node?.labels?.nodes ?? []).some(l => String(l?.name).toUpperCase() === 'QA')
  || String(node?.title ?? '').trim().toUpperCase() === 'QA';

const labelsOf = node => (node?.labels?.nodes ?? []).map(l => l.name);
const isQaCard = node => isQaIssue(node) || /^QA\s*:/i.test(String(node.title ?? '').trim());
const isPlanner = node => labelsOf(node).some(l => l === DECISION_LABEL || l === DELIVERY_LABEL);

export function isExecutionCard(node) {
  if (!node || node.archivedAt) return false;
  if (node.state?.type === 'canceled') return false;
  if (isPlanner(node) || isQaCard(node)) return false;
  // An empty label list is still label data; only a payload with no labels at all falls back to the title.
  if (node.labels == null && String(node.title ?? '').trim().startsWith('¿')) return false;
  return true;
}

export function milestoneTags(milestones) {
  const sorted = [...(milestones ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const out = {};
  sorted.forEach((m, i) => { out[m.name] = { tag: `M${i + 1}`, order: i + 1 }; });
  return out;
}

const milestoneName = card => `${card.milestoneTag} ${card.milestone}`;

// Milestones are deliverables in order: a card cannot wait on one planned for a later milestone. Cards with no milestone
// never count here; they are reported on their own.
export function isBackward(fromCard, toCard) {
  return fromCard?.milestoneOrder != null && toCard?.milestoneOrder != null && fromCard.milestoneOrder > toCard.milestoneOrder;
}

export const backwardMessage = (fromCard, toCard) => `${fromCard.key} (${milestoneName(fromCard)}) blocks ${toCard.key} (${milestoneName(toCard)}), `
  + 'but milestones are delivered in order: move one card\'s milestone in Linear, or drop the edge if it is not a hard dependency';

export function backwardEdges(cards, edges) {
  const byKey = new Map(cards.map(c => [c.key, c]));
  return edges.filter(e => !e.via && isBackward(byKey.get(e.from), byKey.get(e.to)))
    .map(e => ({ key: `${e.from}>${e.to}`, kind: 'backward-milestone', message: backwardMessage(byKey.get(e.from), byKey.get(e.to)) }));
}

export function buildCardMap({ issues, milestones }, { sizes = {} } = {}) {
  const tags = milestoneTags(milestones);
  const targetByName = Object.fromEntries((milestones ?? []).map(m => [m.name, m.targetDate ?? null]));
  const cards = (issues ?? []).filter(isExecutionCard).map(n => {
    const ms = n.projectMilestone?.name ?? null;
    return {
      key: n.identifier,
      title: n.title,
      url: n.url,
      status: n.state?.name ?? 'unknown',
      statusType: n.state?.type ?? 'unknown',
      milestone: ms,
      milestoneTag: ms ? tags[ms]?.tag ?? null : null,
      milestoneOrder: ms ? tags[ms]?.order ?? null : null,
      milestoneTargetDate: ms ? targetByName[ms] ?? null : null,
      dueDate: n.dueDate ?? null,
      estimate: n.estimate ?? null,
      gitBranchName: n.gitBranchName ?? null,
      assignee: n.assignee ? { id: n.assignee.id, name: n.assignee.name ?? null } : null,
      labels: (n.labels?.nodes ?? []).map(l => l.name),
      attachments: (n.attachments?.nodes ?? []).map(a => a?.url).filter(url => GITHUB_PULL.test(url ?? '')),
      size: sizes[n.identifier] ?? null,
    };
  });
  const present = new Set(cards.map(c => c.key));
  const seen = new Set();
  const edges = [];
  for (const n of issues ?? []) {
    if (!present.has(n.identifier)) continue;
    for (const r of n.relations?.nodes ?? []) {
      const to = r.relatedIssue?.identifier;
      if (r.type !== 'blocks' || !present.has(to) || to === n.identifier) continue;
      const id = `${n.identifier}>${to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ from: n.identifier, to });
    }
  }
  return { cards, edges };
}

const isDone = c => c.statusType === 'completed';
const isOpen = c => !isDone(c);

function adjacency(cards, edges) {
  const out = new Map(cards.map(c => [c.key, []]));
  const inn = new Map(cards.map(c => [c.key, []]));
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from).push(e.to);
    inn.get(e.to).push(e.from);
  }
  return { out, inn };
}

function reach(out, start, skip = null) {
  const seen = new Set();
  const stack = [];
  for (const n of out.get(start) ?? []) {
    if (skip && skip.from === start && skip.to === n) continue;
    stack.push(n);
  }
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of out.get(n) ?? []) if (!seen.has(m)) stack.push(m);
  }
  return seen;
}

export function freeNow(cards, edges) {
  const { inn } = adjacency(cards, edges);
  const byKey = new Map(cards.map(c => [c.key, c]));
  return cards
    .filter(c => ['backlog', 'unstarted'].includes(c.statusType))
    .filter(c => inn.get(c.key).every(k => isDone(byKey.get(k))))
    .map(c => c.key);
}

export function downstreamCounts(cards, edges) {
  const { out } = adjacency(cards, edges);
  const res = {};
  for (const c of cards) {
    const r = reach(out, c.key);
    r.delete(c.key);
    res[c.key] = r.size;
  }
  return res;
}

export function impliedEdges(cards, edges) {
  const { out } = adjacency(cards, edges);
  return edges.filter(e => reach(out, e.from, e).has(e.to));
}

export function impliedChain(cards, edges, e) {
  const { out } = adjacency(cards, edges);
  const prev = new Map([[e.from, null]]);
  const queue = [e.from];
  while (queue.length) {
    const v = queue.shift();
    for (const w of out.get(v) ?? []) {
      if (v === e.from && w === e.to) continue;
      if (prev.has(w)) continue;
      prev.set(w, v);
      if (w === e.to) {
        const path = [];
        for (let x = w; x !== null; x = prev.get(x)) path.unshift(x);
        return path;
      }
      queue.push(w);
    }
  }
  return null;
}

export const impliedLines = edges =>
  edges.filter(e => e.implied)
    .map(e => `- ${e.from} → ${e.to}  (${(e.via ?? []).join(' → ')})`)
    .join('\n');

export function cycles(cards, edges) {
  const { out } = adjacency(cards, edges);
  let index = 0;
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], groups = [];
  const visit = v => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of out.get(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const g = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); g.push(w); } while (w !== v);
      if (g.length > 1 || out.get(v).includes(v)) groups.push(g.sort());
    }
  };
  for (const c of cards) if (!idx.has(c.key)) visit(c.key);
  return groups;
}

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);

// Cards in a cycle are left out: a longest chain through a cycle never ends.
// Equal-length chains are not more or less critical; picking the highest card
// number only keeps the path stable between refreshes, and `ties` names the
// other heads that were just as long.
export function criticalPath(cards, edges) {
  const inCycle = new Set(cycles(cards, edges).flat());
  const open = cards.filter(c => isOpen(c) && !inCycle.has(c.key));
  const keep = new Set(open.map(c => c.key));
  const { out } = adjacency(open, edges.filter(e => keep.has(e.from) && keep.has(e.to)));
  const len = new Map(), next = new Map();
  const better = (a, b) => len.get(a) - len.get(b) || cardNumber(a) - cardNumber(b);
  const solve = v => {
    if (len.has(v)) return len.get(v);
    let best = null;
    for (const w of out.get(v)) {
      solve(w);
      if (best === null || better(w, best) > 0) best = w;
    }
    len.set(v, 1 + (best === null ? 0 : len.get(best)));
    next.set(v, best);
    return len.get(v);
  };
  for (const c of open) solve(c.key);
  if (!open.length) return { path: [], ties: [] };
  const starts = open.map(c => c.key);
  const top = Math.max(...starts.map(k => len.get(k)));
  const heads = starts.filter(k => len.get(k) === top).sort((a, b) => cardNumber(b) - cardNumber(a));
  const path = [];
  for (let v = heads[0]; v; v = next.get(v)) path.push(v);
  return { path, ties: heads.slice(1) };
}

export function analyzeCardMap({ cards, edges }) {
  const free = freeNow(cards, edges);
  const implied = impliedEdges(cards, edges);
  const loops = cycles(cards, edges);
  const crit = criticalPath(cards, edges);
  const down = downstreamCounts(cards, edges);
  const impliedIds = new Set(implied.map(e => `${e.from}>${e.to}`));
  const freeSet = new Set(free);
  return {
    cards: cards.map(c => ({ ...c, free: freeSet.has(c.key), downstream: down[c.key] })),
    edges: edges.map(e => impliedIds.has(`${e.from}>${e.to}`)
      ? { ...e, implied: true, via: impliedChain(cards, edges, e) }
      : { ...e, implied: false }),
    free,
    critical: crit.path,
    criticalTies: crit.ties,
    cycles: loops,
    summary: {
      cards: cards.length,
      open: cards.filter(isOpen).length,
      free: free.length,
      blocks: edges.length,
      critical: crit.path.length,
      implied: implied.length,
      cycles: loops.length,
    },
  };
}

function offMapReason(fetched, ref) {
  if (!fetched) return ref?.archivedAt ? 'archived' : 'outside-project';
  if (fetched.archivedAt) return 'archived';
  if (fetched.state?.type === 'canceled') return 'canceled';
  if (isPlanner(fetched)) return 'planner';
  if (isQaCard(fetched)) return 'qa';
  // Left off the map by the «¿» title fallback, which marks a decision ticket.
  return 'planner';
}

const isOpenEnd = n => !n?.archivedAt && !['completed', 'canceled'].includes(n?.state?.type);

export function danglingBlocks(issues, { cards }) {
  const onMap = new Set(cards.map(c => c.key));
  const byKey = new Map((issues ?? []).map(n => [n.identifier, n]));
  const seen = new Set();
  const out = [];
  const add = (fromNode, toNode) => {
    const from = fromNode?.identifier, to = toNode?.identifier;
    if (!from || !to || from === to || onMap.has(from) === onMap.has(to)) return;
    const id = `${from}>${to}`;
    if (seen.has(id)) return;
    seen.add(id);
    const ref = onMap.has(from) ? toNode : fromNode;
    const fetched = byKey.get(ref.identifier);
    out.push({ from, to, offMap: ref.identifier, reason: offMapReason(fetched, ref), open: isOpenEnd(fetched ?? ref) });
  };
  for (const n of issues ?? []) {
    for (const r of n.relations?.nodes ?? []) if (r.type === 'blocks') add(n, r.relatedIssue);
  }
  for (const n of issues ?? []) {
    if (!onMap.has(n.identifier)) continue;
    for (const r of n.inverseRelations?.nodes ?? []) if (r.type === 'blocks') add(r.issue, n);
  }
  return out;
}

export function analyzeProject({ issues, milestones }, { sizes = {} } = {}) {
  const map = buildCardMap({ issues, milestones }, { sizes });
  const result = analyzeCardMap(map);
  const dangling = danglingBlocks(issues, map);
  const blockers = new Map();
  for (const d of dangling) if (d.open && d.reason === 'outside-project' && d.offMap === d.from) blockers.set(d.to, [...(blockers.get(d.to) ?? []), d.from]);
  return {
    ...result,
    cards: result.cards.map(c => ({ ...c, offMapBlockers: blockers.get(c.key) ?? [] })),
    danglingBlocks: dangling,
  };
}
