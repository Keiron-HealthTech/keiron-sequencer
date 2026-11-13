const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const creditedCards = entry => (entry.kind === 'card' ? entry.cards : entry.kind === 'skip' ? [] : [entry.from]);

// Every member of a group window carries the whole window: summing effort across cards double-counts.
export function cardEffort(patchMap, usage) {
  const windowOf = new Map();
  const windows = usage.windows.map(w => {
    if (Date.parse(w.start) >= Date.parse(w.end)) throw new Error(`window ending ${w.end} (${w.patches.join(', ')}): start is not before end`);
    const cards = [...new Set(w.patches.flatMap(p => creditedCards(patchMap.patches[p] ?? { kind: 'skip' })))].sort(compare);
    const out = { start: w.start, end: w.end, cards, messages: w.messages, tokens: { ...w.tokens } };
    w.patches.forEach(p => windowOf.set(p, out));
    return out;
  });

  const own = new Map();
  const existing = new Set();
  for (const [patch, entry] of Object.entries(patchMap.patches)) {
    if (entry.kind !== 'card') continue;
    const w = windowOf.get(patch);
    if (!w) throw new Error(`${patch}: no usage window`);
    for (const card of entry.cards) {
      own.set(card, [...(own.get(card) ?? []), w]);
      if (entry.existing) existing.add(card);
    }
  }

  const result = {};
  for (const card of [...own.keys()].sort(compare)) {
    const spikedAt = own.get(card).map(w => w.end).sort(compare).at(-1);
    const mine = windows.filter(w => w.cards.includes(card)).sort((a, b) => compare(a.end, b.end));
    result[card] = {
      effort: existing.has(card) ? null : { basis: 'transcript-window', windows: mine.map(w => ({ ...w, cards: [...w.cards], tokens: { ...w.tokens } })) },
      spikedAt,
    };
  }
  return result;
}
