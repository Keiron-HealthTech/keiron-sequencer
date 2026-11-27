import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityOf, workingDays } from '../scripts/lib/cycle/capacity.mjs';
import { TIER_POINTS } from '../scripts/lib/cycle/size.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

// Two-week cycles ending on the 1st and 15th; newest first, as fetchCycleContext returns them.
const cycle = (number, startsAt, endsAt) => ({ id: `cyc-${number}`, number, startsAt, endsAt });
const PAST = [
  cycle(8, '2026-10-29T03:00:00.000Z', '2026-11-12T03:00:00.000Z'),
  cycle(7, '2026-10-15T03:00:00.000Z', '2026-10-29T03:00:00.000Z'),
  cycle(6, '2026-10-01T03:00:00.000Z', '2026-10-15T03:00:00.000Z'),
  cycle(5, '2026-09-17T03:00:00.000Z', '2026-10-01T03:00:00.000Z'),
  cycle(4, '2026-09-03T03:00:00.000Z', '2026-09-17T03:00:00.000Z'),
  cycle(3, '2026-08-20T03:00:00.000Z', '2026-09-03T03:00:00.000Z'),
];
const NEXT = cycle(10, '2026-11-16T03:00:00.000Z', '2026-11-30T03:00:00.000Z');
const tierOf = {};
const sizeOf = key => {
  const [tier, source] = tierOf[key] ?? ['M', 'record'];
  return { tier, points: TIER_POINTS[tier], source };
};
let seq = 0;
// Cards of the given tiers finished by `who` inside cycle `c`.
const finished = (c, who, tiers, source = 'record') => tiers.map(tier => {
  const key = `ABC-${++seq}`;
  tierOf[key] = [tier, source];
  return { key, assigneeId: who, completedAt: new Date(Date.parse(c.startsAt) + 86_400_000).toISOString() };
});
// 6 = L+L, 9 = XL+L+S, 8 = XL+L.
const SIX_NINE_EIGHT = [...finished(PAST[0], 'u-a', ['L', 'L']), ...finished(PAST[1], 'u-a', ['XL', 'L', 'S']), ...finished(PAST[2], 'u-a', ['XL', 'L'])];

test('committed is the lowest and stretch the mean of the last three cycles with work', () => {
  const c = capacityOf({ personId: 'u-a', completed: SIX_NINE_EIGHT, past: PAST, next: NEXT, sizeOf });
  assert.deepEqual([c.history, c.cycles, c.basis, c.committed, c.stretch], [[6, 9, 8], [8, 7, 6], 'history', 6, 7.67]);
});

test('availability scales both bands', () => {
  const c = capacityOf({ personId: 'u-a', completed: SIX_NINE_EIGHT, past: PAST, next: NEXT, sizeOf, availability: 50 });
  assert.deepEqual([c.committed, c.stretch], [3, 3.83]);
});

test('a cycle with no finished project card is skipped, up to six back', () => {
  const completed = [...finished(PAST[1], 'u-b', ['M']), ...finished(PAST[3], 'u-b', ['L']), ...finished(PAST[5], 'u-b', ['S'])];
  const c = capacityOf({ personId: 'u-b', completed, past: PAST, next: NEXT, sizeOf });
  assert.deepEqual([c.cycles, c.history, c.basis], [[7, 5, 3], [2, 3, 1], 'history']);
});

test('one or two cycles found is thin history: committed is 80% of the mean, not the lowest', () => {
  const completed = [...finished(PAST[0], 'u-c', ['M']), ...finished(PAST[4], 'u-c', ['XL'])];
  const c = capacityOf({ personId: 'u-c', completed, past: PAST, next: NEXT, sizeOf });
  assert.deepEqual([c.basis, c.committed, c.stretch], ['thin', 2.8, 3.5]);
  const half = capacityOf({ personId: 'u-c', completed, past: PAST, next: NEXT, sizeOf, availability: 50 });
  assert.deepEqual([half.committed, half.stretch], [1.4, 1.75]);
});

test('no history guesses one point per working day of the next cycle', () => {
  const c = capacityOf({ personId: 'u-none', completed: SIX_NINE_EIGHT, past: PAST, next: NEXT, sizeOf });
  assert.deepEqual([c.basis, c.committed, c.stretch, c.history], ['guessed', 10, 10, []]);
  const half = capacityOf({ personId: 'u-none', completed: [], past: PAST, next: NEXT, sizeOf, availability: 50 });
  assert.deepEqual([half.committed, half.stretch], [5, 5]);
});

test('a card completed outside every past cycle window counts nowhere', () => {
  const completed = [{ key: 'ABC-900', assigneeId: 'u-d', completedAt: '2026-11-12T03:00:00.000Z' }];
  assert.equal(capacityOf({ personId: 'u-d', completed, past: PAST, next: NEXT, sizeOf }).basis, 'guessed');
});

test('history says how many of its cards were sized by guess or default', () => {
  const completed = [
    ...finished(PAST[0], 'u-e', ['M', 'L']), ...finished(PAST[1], 'u-e', ['S', 'L'], 'guess'), ...finished(PAST[2], 'u-e', ['M'], 'default'),
  ];
  const c = capacityOf({ personId: 'u-e', completed, past: PAST, next: NEXT, sizeOf });
  assert.deepEqual([c.counted, c.guessedCards, c.defaultCards], [5, 2, 1]);
});

test("workingDays counts by the UTC date part, whatever the machine's timezone", () => {
  assert.equal(workingDays(NEXT), 10);
  assert.equal(workingDays(cycle(1, '2026-11-14T23:30:00.000Z', '2026-11-16T00:30:00.000Z')), 0);
  assert.equal(workingDays(cycle(1, '2026-11-13T00:00:00.000Z', '2026-11-17T00:00:00.000Z')), 2);
});

test('the current cycle counts first, with the cards finished in it so far', () => {
  const ACTIVE = cycle(9, '2026-11-12T03:00:00.000Z', '2026-11-26T03:00:00.000Z');
  const completed = [...finished(ACTIVE, 'u-f', ['XL', 'XL', 'L']), ...finished(PAST[0], 'u-f', ['M']), ...finished(PAST[1], 'u-f', ['L'])];
  const c = capacityOf({ personId: 'u-f', completed, past: PAST, active: ACTIVE, next: NEXT, sizeOf });
  assert.deepEqual([c.cycles, c.history, c.partial, c.committed, c.stretch], [[9, 8, 7], [13, 2, 3], 9, 2, 6]);
});

test('a current cycle with nothing finished yet is skipped like any other', () => {
  const ACTIVE = cycle(9, '2026-11-12T03:00:00.000Z', '2026-11-26T03:00:00.000Z');
  const c = capacityOf({ personId: 'u-a', completed: SIX_NINE_EIGHT, past: PAST, active: ACTIVE, next: NEXT, sizeOf });
  assert.deepEqual([c.cycles, c.partial], [[8, 7, 6], null]);
});

test('built work not Done in Linear: a merged card counts in its merge cycle, the rest add their share to the current one', () => {
  const ACTIVE = cycle(9, '2026-11-12T03:00:00.000Z', '2026-11-26T03:00:00.000Z');
  const done = finished(ACTIVE, 'u-g', ['M']);
  const [mergedNow] = finished(ACTIVE, 'u-g', ['L']);
  const [mergedBefore] = finished(PAST[0], 'u-g', ['S']);
  const completed = [...done, { ...mergedNow, built: true }, { ...mergedBefore, built: true }];
  const [pr] = finished(ACTIVE, 'u-g', ['XL']);
  const [someoneElse] = finished(ACTIVE, 'u-h', ['XL']);
  const progress = [{ key: pr.key, assigneeId: 'u-g', share: 0.75 }, { key: someoneElse.key, assigneeId: 'u-h', share: 0.75 }];
  const c = capacityOf({ personId: 'u-g', completed, progress, past: PAST, active: ACTIVE, next: NEXT, sizeOf });
  // Cycle 9: M 2 + L 3 + 75% of XL 5 = 8.75; cycle 8: S 1.
  assert.deepEqual([c.cycles, c.history, c.partial, c.counted, c.builtPoints], [[9, 8], [8.75, 1], 9, 4, 7.75]);
});

test('a current cycle with only built work in progress still counts', () => {
  const ACTIVE = cycle(9, '2026-11-12T03:00:00.000Z', '2026-11-26T03:00:00.000Z');
  const [pr] = finished(ACTIVE, 'u-i', ['L']);
  const c = capacityOf({ personId: 'u-i', completed: [], progress: [{ key: pr.key, assigneeId: 'u-i', share: 0.5 }], past: PAST, active: ACTIVE, next: NEXT, sizeOf });
  assert.deepEqual([c.cycles, c.history, c.partial, c.builtPoints], [[9], [1.5], 9, 1.5]);
});
