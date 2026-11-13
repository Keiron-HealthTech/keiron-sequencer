export const HISTORY_CYCLES = 3;
export const LOOKBACK_CYCLES = 6;
export const GUESS_POINTS_PER_DAY = 1;
// With fewer than 3 cycles the lowest is usually a ramp-up cycle, not a bad one, so committed is a share of the mean instead.
export const THIN_COMMITTED_SHARE = 0.8;

const DAY_MS = 86_400_000;
export const round2 = n => Math.round(n * 100) / 100;
const utcDay = iso => Date.parse(`${String(iso).slice(0, 10)}T00:00:00.000Z`);

// Linear stores cycle bounds as UTC instants; the date part is the day the team sees, on any machine.
export function workingDays(cycle) {
  let days = 0;
  for (let t = utcDay(cycle.startsAt); t < utcDay(cycle.endsAt); t += DAY_MS) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days++;
  }
  return days;
}

const within = (at, c) => {
  const t = Date.parse(at);
  return t >= Date.parse(c.startsAt) && t < Date.parse(c.endsAt);
};

// The current cycle counts first with what is finished in it so far: planning happens before it ends, and it is often the
// cycle with the most recent work.
export function capacityOf({ personId, completed, past, active = null, availability = 100, next, sizeOf }) {
  const share = availability / 100;
  const counted = [];
  for (const c of [...(active ? [active] : []), ...past.slice(0, LOOKBACK_CYCLES)]) {
    const cards = completed.filter(x => x.assigneeId === personId && x.completedAt && within(x.completedAt, c));
    if (cards.length) counted.push({ number: c.number, sizes: cards.map(x => sizeOf(x.key)) });
    if (counted.length === HISTORY_CYCLES) break;
  }
  const sizes = counted.flatMap(c => c.sizes);
  const history = counted.map(c => c.sizes.reduce((sum, s) => sum + s.points, 0));
  const tally = {
    counted: sizes.length,
    guessedCards: sizes.filter(s => s.source === 'guess').length,
    defaultCards: sizes.filter(s => s.source === 'default').length,
  };
  if (!history.length) {
    const guess = round2(workingDays(next) * GUESS_POINTS_PER_DAY * share);
    return { history, cycles: [], partial: null, basis: 'guessed', committed: guess, stretch: guess, ...tally };
  }
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const thin = history.length < HISTORY_CYCLES;
  return {
    history,
    cycles: counted.map(c => c.number),
    partial: active && counted[0]?.number === active.number ? active.number : null,
    basis: thin ? 'thin' : 'history',
    committed: round2((thin ? mean * THIN_COMMITTED_SHARE : Math.min(...history)) * share),
    stretch: round2(mean * share),
    ...tally,
  };
}
