const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const priority = (a, b) => (a.milestoneOrder ?? Infinity) - (b.milestoneOrder ?? Infinity)
  || cardNumber(a.key) - cardNumber(b.key)
  || compare(a.key, b.key);

function takeFirst(queue, first) {
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (first(queue[i], queue[best]) < 0) best = i;
  return queue.splice(best, 1)[0];
}

// Completed cards are skipped, so their blocks edges gate nothing; `rank` (lower first) breaks ties before the milestone.
export function spikeOrder({ cards, edges, cycles = [] }, { rank = null } = {}) {
  const first = rank ? (a, b) => rank(a.key) - rank(b.key) || priority(a, b) : priority;
  const runCards = cards.filter(c => c.statusType !== 'completed');
  const byKey = new Map(runCards.map(c => [c.key, c]));
  const skipped = cards.filter(c => c.statusType === 'completed').sort(priority).map(c => ({ card: c.key, reason: 'completed' }));
  const loops = cycles.filter(group => group.some(k => byKey.has(k)));
  if (loops.length) return { order: [], skipped, cycles: loops };
  const waiting = new Map(runCards.map(c => [c.key, 0]));
  const next = new Map(runCards.map(c => [c.key, []]));
  for (const e of edges) {
    if (!byKey.has(e.from) || !byKey.has(e.to)) continue;
    next.get(e.from).push(e.to);
    waiting.set(e.to, waiting.get(e.to) + 1);
  }
  const queue = runCards.filter(c => waiting.get(c.key) === 0);
  const order = [];
  while (queue.length) {
    const c = takeFirst(queue, first);
    order.push(c.key);
    for (const k of next.get(c.key)) {
      waiting.set(k, waiting.get(k) - 1);
      if (waiting.get(k) === 0) queue.push(byKey.get(k));
    }
  }
  return { order, skipped, cycles: [] };
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only a bracketed id counts, as in /keiron-sequencer:next: a title that merely mentions the number is another PR.
export function existingPrs(prLists, cardKeys) {
  const found = new Map();
  for (const key of cardKeys) {
    const tag = new RegExp(`\\[${escape(key)}\\]|\\(${escape(key)}\\)`);
    for (const { repoDir, prs } of prLists) {
      const pr = [...prs].sort((a, b) => a.number - b.number).find(p => tag.test(String(p.title)));
      if (pr) { found.set(key, { repoDir, number: pr.number, url: pr.url }); break; }
    }
  }
  return found;
}

export const offProjectFindings = keys => keys.map(k => ({ kind: 'risk', text: `Blocked by off-project card ${k}, still open.`, ref: `linear:${k}` }));
