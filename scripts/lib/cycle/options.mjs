import { round2 } from './capacity.mjs';

// A lowest cycle under half the next one is an outlier (a ramp-up, or a cycle spent on cards history does not count), not
// a pace: committed, the lowest, then understates the person.
export const OUTLIER_SHARE = 0.5;

const loadOf = (cards, id) => round2(cards.filter(c => c.assignee?.id === id).reduce((s, c) => s + c.remaining, 0));

function outlier(p) {
  if (p.basis !== 'history' || p.history.length < 2) return null;
  const sorted = [...p.history].sort((a, b) => a - b);
  if (sorted[0] >= sorted[1] * OUTLIER_SHARE) return null;
  const at = p.history.indexOf(sorted[0]);
  const others = p.history.filter((_, i) => i !== at);
  // The next-lowest cycle stands in for committed, never past stretch.
  const committed = Math.min(round2(sorted[1] * p.availability / 100), p.stretch);
  return { committed, why: `${p.name}'s committed is pinned by cycle ${p.cycles[at]} (${sorted[0]} pts, against ${others.join(' and ')}); without it, committed would be ${committed}` };
}

// Three ways to apply a plan: the committed cards, all of them with stretch, or stretch less the cards that take a person
// past the middle of their range. Drops go from the lowest-ranked up, cards outside the focus first, and never a card
// already built: it is mostly done, and dropping it saves little.
export function planOptions({ people, cards, focusKeys = new Set() }) {
  const inCycle = cards.filter(c => c.band === 'fixed' || c.band === 'committed');
  const stretch = cards.filter(c => c.band === 'stretch');
  const shown = people.filter(p => p.member || cards.some(c => c.band !== 'left-out' && c.assignee?.id === p.id));
  const option = (id, kept, drop) => ({
    id, withStretch: id !== 'A', drop,
    cards: cards.filter(c => c.band === 'committed').length + kept.length,
    people: shown.map(p => ({ id: p.id, name: p.name, committed: p.committed, stretch: p.stretch, load: loadOf([...inCycle, ...kept], p.id) })),
  });
  const options = [option('A', [], [])];
  if (!stretch.length) return { options, recommended: 'A', reason: 'there are no stretch cards' };

  options.push(option('B', stretch, []));
  const outliers = new Map(shown.map(p => [p.id, outlier(p)]).filter(([, o]) => o));
  const order = [...stretch].reverse().filter(c => !c.built).sort((a, b) => Number(focusKeys.has(a.key)) - Number(focusKeys.has(b.key)));
  const drop = new Set();
  for (const p of shown) {
    const target = round2(((outliers.get(p.id)?.committed ?? p.committed) + p.stretch) / 2);
    let load = loadOf([...inCycle, ...stretch], p.id);
    for (const c of order.filter(x => x.assignee?.id === p.id)) {
      if (load <= target) break;
      drop.add(c.key);
      load = round2(load - c.remaining);
    }
  }
  const kept = stretch.filter(c => !drop.has(c.key));
  if (drop.size && kept.length) options.push(option('C', kept, stretch.map(c => c.key).filter(k => drop.has(k))));

  if (!outliers.size) return { options, recommended: 'A', reason: "committed is each person's worst recent cycle; stretch cards are next if there is room" };
  const recommended = options.some(o => o.id === 'C') ? 'C' : 'B';
  return { options, recommended, reason: [...outliers.values()].map(o => o.why).join('; ') };
}
