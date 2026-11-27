import { round2 } from './capacity.mjs';

export const IN_PROGRESS_LEFT = 0.75;
export const IN_REVIEW_LEFT = 0.25;

// built: the card's build state from GitHub and its branches; the lower of the two readings wins, since Linear often lags.
export function remainingFraction(state, built = null) {
  const linear = state?.type !== 'started' ? 1 : /review/i.test(state.name ?? '') ? IN_REVIEW_LEFT : IN_PROGRESS_LEFT;
  return Math.min(linear, built?.fraction ?? 1);
}

const BAND_RANK = { fixed: 0, committed: 0, stretch: 1 };
const ratio = p => (p.stretch > 0 ? p.load / p.stretch : Infinity);
const byShare = (a, b) => ratio(a) - ratio(b) || b.availability - a.availability || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Carry-over and cards already in the next cycle are in it whatever the plan says, so they are placed first and may push a
// person past capacity; new cards then fill the room left, and a card waits until every open blocker is placed.
export function fillCycle({ people, fixed, candidates, edges, done, sizeOf }) {
  const rows = people.map(p => ({ ...p, load: 0 }));
  const byId = new Map(rows.map(p => [p.id, p]));
  const personOf = assignee => {
    if (!byId.has(assignee.id)) {
      const row = { ...assignee, member: false, availability: 100, committed: 0, stretch: 0, load: 0 };
      rows.push(row);
      byId.set(assignee.id, row);
    }
    return byId.get(assignee.id);
  };
  const takers = () => rows.filter(p => p.member && p.availability > 0);
  const out = new Map();
  const sized = c => {
    const s = sizeOf(c.key);
    const fraction = remainingFraction(c.state, c.built);
    const built = c.built ? { kind: c.built.kind, evidence: c.built.evidence } : null;
    return { tier: s.tier, points: s.points, sizeSource: s.source, fraction, remaining: round2(s.points * fraction), built };
  };
  const place = (c, size, band, person, assigns, reason = null) => {
    if (person) person.load = round2(person.load + size.remaining);
    out.set(c.key, {
      key: c.key, id: c.id, title: c.title, kind: c.kind ?? 'new', ...size, band,
      assignee: person ? { id: person.id, name: person.name } : null, assigns, reason,
    });
  };

  for (const c of fixed) {
    const size = sized(c);
    const person = c.assignee ? personOf(c.assignee) : takers().sort(byShare)[0] ?? null;
    place(c, size, 'fixed', person, !c.assignee && !!person, person ? null : 'no member to take it');
  }

  const fixedLoad = new Map(rows.map(p => [p.id, p.load]));
  const isOver = p => (fixedLoad.get(p.id) ?? 0) > p.committed;
  const blockersOf = key => edges.filter(e => e.to === key && !done.has(e.from)).map(e => e.from);
  const unplacedOrLost = k => !out.has(k) || out.get(k).band === 'left-out';
  const ready = c => c.laterCycle || c.offMapBlockers?.length || blockersOf(c.key).every(k => out.has(k)) || blockersOf(c.key).some(k => out.get(k)?.band === 'left-out');
  const pending = [...candidates];
  // Each step places the highest-ranked card that is ready, so a card that waited lands right after its blocker.
  for (let at = pending.findIndex(ready); at !== -1; at = pending.findIndex(ready)) {
    const [c] = pending.splice(at, 1);
    const size = sized(c);
    const blockers = blockersOf(c.key);
    const lost = blockers.find(k => out.get(k)?.band === 'left-out');
    if (c.laterCycle) { place(c, size, 'left-out', null, false, `scheduled for cycle ${c.laterCycle}`); continue; }
    if (c.offMapBlockers?.length) { place(c, size, 'left-out', null, false, `blocked outside the project by ${c.offMapBlockers.join(', ')}`); continue; }
    if (lost) { place(c, size, 'left-out', null, false, `blocked by ${lost}`); continue; }
    const floor = Math.max(0, ...blockers.map(k => BAND_RANK[out.get(k).band]));
    const fits = (p, room) => round2(p.load + size.remaining) <= p[room];
    const rooms = floor === 0 ? ['committed', 'stretch'] : ['stretch'];
    if (c.assignee) {
      const p = personOf(c.assignee);
      const room = isOver(p) ? null : rooms.find(r => fits(p, r));
      if (room) place(c, size, room, p, false);
      else place(c, size, 'left-out', null, false, isOver(p) ? `${p.name} is over committed` : `${p.name} is full`);
      continue;
    }
    let chosen = null;
    for (const room of rooms) {
      const p = takers().filter(t => !isOver(t) && fits(t, room)).sort(byShare)[0];
      if (p) { chosen = [room, p]; break; }
    }
    if (chosen) place(c, size, chosen[0], chosen[1], true);
    else place(c, size, 'left-out', null, false, 'no room');
  }
  // What is still waiting sits behind a blocker outside the plan or in a loop; name the first one that never landed.
  for (const c of pending) place(c, sized(c), 'left-out', null, false, `blocked by ${blockersOf(c.key).find(unplacedOrLost)}`);

  return {
    people: rows.map(p => {
      const fixedOnly = fixedLoad.get(p.id) ?? 0;
      return { ...p, over: fixedOnly > p.committed ? round2(fixedOnly - p.committed) : 0 };
    }),
    cards: [...fixed, ...candidates].map(c => out.get(c.key)),
  };
}
