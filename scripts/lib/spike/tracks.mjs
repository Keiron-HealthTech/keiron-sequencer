// A track is a weakly connected component of the run's card graph; `links` are extra groups that must share one.
export function tracksOf({ order, edges, links }) {
  const parent = new Map(order.map(k => [k, k]));
  const find = k => {
    while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k) }
    return k;
  };
  const join = (a, b) => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  };
  for (const e of edges) join(e.from, e.to);
  for (const [first, ...rest] of links) for (const k of rest) join(first, k);
  const groups = new Map();
  for (const k of order) {
    const root = find(k);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(k);
  }
  return [...groups.values()].map((cards, i) => ({ id: `t${i + 1}`, cards }));
}
