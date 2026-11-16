import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dueBucket, localDay, ORDER_KEYS, rankCards, SOON_DAYS } from '../scripts/lib/next-order.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

function inZone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

test('today is the local calendar date of the injected clock', () => {
  const at = new Date('2026-11-13T02:30:00Z');
  inZone('America/Santiago', () => {
    assert.equal(localDay(at), '2026-11-12');
    assert.notEqual(localDay(at), at.toISOString().slice(0, 10));
  });
});

test('today can be a day ahead of the UTC date', () => {
  const at = new Date('2026-11-12T11:30:00Z');
  inZone('Pacific/Kiritimati', () => assert.equal(localDay(at), '2026-11-13'));
});

test('adding days crosses a month and a year end', () => {
  assert.equal(addDays('2026-11-28', 6), '2026-12-04');
  assert.equal(addDays('2026-12-28', 6), '2027-01-03');
});

test('adding days across a daylight saving change lands on the calendar day', () => {
  inZone('America/Santiago', () => {
    assert.equal(addDays('2026-04-04', 2), '2026-04-06');
    assert.equal(addDays('2026-09-05', 2), '2026-09-07');
  });
});

test('the soon window is seven days', () => {
  assert.equal(SOON_DAYS, 7);
});

test('a card due yesterday is overdue', () => {
  assert.equal(dueBucket('2026-11-12', '2026-11-13'), 'overdue');
});

test('a card due today is soon, not overdue', () => {
  assert.equal(dueBucket('2026-11-13', '2026-11-13'), 'soon');
});

test('a card due on the last day of the window is soon', () => {
  assert.equal(dueBucket('2026-11-19', '2026-11-13'), 'soon');
});

test('a card due one day past the window has no due bucket', () => {
  assert.equal(dueBucket('2026-11-20', '2026-11-13'), null);
});

test('a card with no due date has no due bucket', () => {
  assert.equal(dueBucket(null, '2026-11-13'), null);
  assert.equal(dueBucket(undefined, '2026-11-13'), null);
});

test('the window crosses a month and a year end', () => {
  assert.equal(dueBucket('2027-01-03', '2026-12-28'), 'soon');
  assert.equal(dueBucket('2027-01-04', '2026-12-28'), null);
});

test('a malformed due date is treated as absent', () => {
  assert.equal(dueBucket('13/11/2026', '2026-11-13'), null);
  assert.equal(dueBucket('', '2026-11-13'), null);
});

const TODAY = '2026-11-13';
const card = (key, over = {}) => ({
  key, statusType: 'unstarted', milestoneOrder: 1, milestoneTargetDate: null, dueDate: null, downstream: 0, ...over,
});
const M = (order, targetDate = null) => ({ milestoneOrder: order, milestoneTargetDate: targetDate });
const NO_MILESTONE = { milestoneOrder: null, milestoneTargetDate: null };
const byKey = out => Object.fromEntries(out.map(c => [c.key, c]));
const orderOf = (cards, opts = {}) => rankCards(cards, { today: TODAY, ...opts })
  .filter(c => c.rank !== null).sort((a, b) => a.rank - b.rank).map(c => c.key);

test('the order keys are named in the order they apply', () => {
  assert.deepEqual(ORDER_KEYS, ['deadline', 'milestone order', 'card due date', 'critical path', 'downstream', 'card number']);
});

test('a due date equal to the local date is soon across the UTC midnight boundary', () => {
  const today = inZone('America/Santiago', () => localDay(new Date('2026-11-13T02:30:00Z')));
  const [c] = rankCards([card('CRM-1', { ...M(1, '2026-11-12'), dueDate: '2026-11-12' })], { today });
  assert.equal(c.due, 'soon');
  assert.equal(c.milestoneOverdue, false);
});

test('the same instant read as UTC would differ', () => {
  const [c] = rankCards([card('CRM-1', { ...M(1, '2026-11-12'), dueDate: '2026-11-12' })], { today: '2026-11-13' });
  assert.equal(c.due, 'overdue');
  assert.equal(c.milestoneOverdue, true);
});

test('a finished card past its due date has no due bucket', () => {
  const out = byKey(rankCards([
    card('CRM-1', { statusType: 'completed', dueDate: '2026-11-01' }),
    card('CRM-2', { statusType: 'canceled', dueDate: '2026-11-01' }),
  ], { today: TODAY }));
  assert.equal(out['CRM-1'].due, null);
  assert.equal(out['CRM-2'].due, null);
});

test('a milestone whose target date has passed is overdue', () => {
  assert.equal(rankCards([card('CRM-1', M(1, '2026-11-12'))], { today: TODAY })[0].milestoneOverdue, true);
});

test('a milestone whose target date is today is not overdue', () => {
  assert.equal(rankCards([card('CRM-1', M(1, '2026-11-13'))], { today: TODAY })[0].milestoneOverdue, false);
});

test('a milestone with no target date is never overdue', () => {
  for (const today of ['2000-01-01', TODAY, '2099-12-31']) {
    assert.equal(rankCards([card('CRM-1', M(1))], { today })[0].milestoneOverdue, false);
  }
});

test('a milestone with a malformed target date is never overdue', () => {
  assert.equal(rankCards([card('CRM-1', M(1, '01/11/2026'))], { today: TODAY })[0].milestoneOverdue, false);
});

test('a card with no milestone is not in an overdue milestone', () => {
  const [c] = rankCards([card('CRM-1', NO_MILESTONE)], { today: TODAY });
  assert.equal(c.milestoneOverdue, false);
  assert.equal(c.milestoneTargetDate, null);
});

test('a finished card still carries its milestone overdue fact', () => {
  const out = byKey(rankCards([
    card('CRM-1', { ...M(1, '2026-11-01'), statusType: 'completed' }),
    card('CRM-2', { ...M(1, '2026-11-01'), statusType: 'canceled' }),
  ], { today: TODAY }));
  assert.equal(out['CRM-1'].milestoneOverdue, true);
  assert.equal(out['CRM-2'].milestoneOverdue, true);
});

test('finished cards get no rank', () => {
  const out = byKey(rankCards([
    card('CRM-1', { statusType: 'completed' }), card('CRM-2', { statusType: 'canceled' }), card('CRM-3'), card('CRM-4'),
  ], { today: TODAY }));
  assert.equal(out['CRM-1'].rank, null);
  assert.equal(out['CRM-2'].rank, null);
  assert.equal(out['CRM-3'].rank, 1);
  assert.equal(out['CRM-4'].rank, 2);
});

test('open cards are ranked 1 to N and the output keeps the input order', () => {
  const input = [card('CRM-3', M(2)), card('CRM-1', { statusType: 'completed' }), card('CRM-2', M(1)), card('CRM-4', { statusType: 'started', ...M(3) })];
  const before = structuredClone(input);
  const out = rankCards(input, { today: TODAY });
  assert.deepEqual(out.map(c => c.key), ['CRM-3', 'CRM-1', 'CRM-2', 'CRM-4']);
  assert.deepEqual(out.map(c => c.rank), [2, null, 1, 3]);
  assert.deepEqual(out[0], { ...input[0], due: null, milestoneOverdue: false, deadline: null, deadlineFrom: null, rank: 2 });
  assert.deepEqual(input, before);
});

test('a later overdue milestone beats an earlier non-overdue one with work', () => {
  assert.deepEqual(orderOf([card('CRM-10', M(1, '2026-12-01')), card('CRM-20', M(2, '2026-11-10'))]), ['CRM-20', 'CRM-10']);
});

test('two non-overdue milestones follow milestone order even when the later one\'s target is nearer', () => {
  assert.deepEqual(orderOf([card('CRM-20', M(2, '2026-11-20')), card('CRM-10', M(1, '2026-12-20'))]), ['CRM-10', 'CRM-20']);
});

test('several overdue milestones are taken in milestone order, not by oldest target date', () => {
  const cards = [card('CRM-10', M(1, '2026-12-01')), card('CRM-30', M(3, '2026-10-01')), card('CRM-20', M(2, '2026-11-01'))];
  assert.deepEqual(orderOf(cards), ['CRM-20', 'CRM-30', 'CRM-10']);
});

test('cards with no milestone rank last', () => {
  const cards = [card('CRM-5', { ...NO_MILESTONE, dueDate: '2026-12-20', downstream: 9 }), card('CRM-40', { ...M(4), downstream: 0 })];
  assert.deepEqual(orderOf(cards, { critical: ['CRM-5'] }), ['CRM-40', 'CRM-5']);
});

test('an undated milestone is ordered by milestone order only', () => {
  const out = rankCards([card('CRM-11', M(2)), card('CRM-12', M(1))], { today: TODAY });
  assert.deepEqual(out.filter(c => c.rank).sort((a, b) => a.rank - b.rank).map(c => c.key), ['CRM-12', 'CRM-11']);
  assert.ok(out.every(c => c.milestoneOverdue === false));
});

test('an overdue card ranks ahead of an earlier milestone with no target date', () => {
  const out = byKey(rankCards([card('CRM-20', { ...M(2), dueDate: '2026-11-01' }), card('CRM-10', M(1))], { today: TODAY }));
  assert.ok(out['CRM-20'].rank < out['CRM-10'].rank);
  assert.equal(out['CRM-20'].due, 'overdue');
});

test('inside a milestone an overdue card beats a soon card, which beats an undated card', () => {
  const cards = [card('CRM-1', { downstream: 8 }), card('CRM-2', { dueDate: '2026-11-15' }), card('CRM-3', { dueDate: '2026-11-10' })];
  assert.deepEqual(orderOf(cards, { critical: ['CRM-1'] }), ['CRM-3', 'CRM-2', 'CRM-1']);
});

test('inside a due bucket the critical path decides before downstream', () => {
  const cards = [card('CRM-8', { downstream: 6 }), card('CRM-7', { downstream: 1 })];
  assert.deepEqual(orderOf(cards, { critical: ['CRM-7'] }), ['CRM-7', 'CRM-8']);
});

test('a head listed in the critical ties counts as on the critical path', () => {
  const cards = [card('CRM-6', { downstream: 4 }), card('CRM-9', { downstream: 1 })];
  assert.deepEqual(orderOf(cards, { criticalTies: ['CRM-9'] }), ['CRM-9', 'CRM-6']);
});

test('two overdue cards are not ordered by how late they are', () => {
  const cards = [card('CRM-4', { dueDate: '2026-11-01' }), card('CRM-5', { dueDate: '2026-11-12' })];
  assert.deepEqual(orderOf(cards, { critical: ['CRM-5'] }), ['CRM-5', 'CRM-4']);
});

test('downstream then card number break the remaining ties', () => {
  const cards = [card('CRM-50', { downstream: 1 }), card('CRM-1000', { downstream: 3 }), card('CRM-999', { downstream: 3 })];
  assert.deepEqual(orderOf(cards), ['CRM-999', 'CRM-1000', 'CRM-50']);
});

test('the order does not depend on input order', () => {
  const fixtures = [
    [[card('CRM-10', M(1, '2026-12-01')), card('CRM-30', M(3, '2026-10-01')), card('CRM-20', M(2, '2026-11-01'))], {}],
    [[card('CRM-5', { ...NO_MILESTONE, dueDate: '2026-11-01', downstream: 9 }), card('CRM-40', M(4))], { critical: ['CRM-5'] }],
    [[card('CRM-1', { downstream: 8 }), card('CRM-2', { dueDate: '2026-11-15' }), card('CRM-3', { dueDate: '2026-11-10' })], { critical: ['CRM-1'] }],
    [[card('CRM-6', { downstream: 4 }), card('CRM-9', { downstream: 1 })], { criticalTies: ['CRM-9'] }],
    [[card('CRM-50', { downstream: 1 }), card('CRM-1000', { downstream: 3 }), card('CRM-999', { downstream: 3 })], {}],
  ];
  const ranks = (cards, opts) => Object.fromEntries(rankCards(cards, { today: TODAY, ...opts }).map(c => [c.key, c.rank]));
  for (const [cards, opts] of fixtures) {
    assert.deepEqual(ranks([...cards].reverse(), opts), ranks(cards, opts));
  }
});

test('cards equal on every key are ordered by their key', () => {
  const ranks = cards => Object.fromEntries(rankCards(cards, { today: TODAY }).map(c => [c.key, c.rank]));
  const cards = [card('OPS-7'), card('CRM-7')];
  assert.deepEqual(ranks(cards), { 'CRM-7': 1, 'OPS-7': 2 });
  assert.deepEqual(ranks([...cards].reverse()), { 'CRM-7': 1, 'OPS-7': 2 });
});

test('a card due today in a later milestone outranks an earlier milestone with no target date', () => {
  const cards = [card('CRM-10', M(3)), card('CRM-20', { ...M(4), dueDate: TODAY })];
  assert.deepEqual(orderOf(cards), ['CRM-20', 'CRM-10']);
  assert.equal(byKey(rankCards(cards, { today: TODAY }))['CRM-20'].deadline, 'soon');
});

test('a card\'s deadline is its due date or its milestone target, whichever comes first', () => {
  const out = byKey(rankCards([
    card('CRM-1', { ...M(1, '2026-11-15'), dueDate: '2026-12-30' }),
    card('CRM-2', { ...M(1, '2026-12-30'), dueDate: '2026-11-01' }),
    card('CRM-3', M(1, '2026-12-30')),
    card('CRM-4', { ...NO_MILESTONE, dueDate: '2026-11-14' }),
  ], { today: TODAY }));
  assert.deepEqual(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'].map(k => out[k].deadline), ['soon', 'overdue', null, 'soon']);
});

test('when both deadlines are soon, milestone order decides', () => {
  const cards = [card('CRM-20', { ...M(4), dueDate: addDays(TODAY, 5) }), card('CRM-10', M(3, addDays(TODAY, 2)))];
  assert.deepEqual(orderOf(cards), ['CRM-10', 'CRM-20']);
});

test('an overdue card outranks a milestone that is only due soon, and overdue ties go by milestone order', () => {
  assert.deepEqual(orderOf([card('CRM-10', M(1, addDays(TODAY, 1))), card('CRM-30', { ...M(3), dueDate: '2026-11-01' })]), ['CRM-30', 'CRM-10']);
  assert.deepEqual(orderOf([card('CRM-30', { ...M(3), dueDate: '2026-11-01' }), card('CRM-20', M(2, '2026-11-01'))]), ['CRM-20', 'CRM-30']);
});

test('a card with no milestone but an overdue due date ranks ahead of undated milestones', () => {
  assert.deepEqual(orderOf([card('CRM-40', M(4)), card('CRM-5', { ...NO_MILESTONE, dueDate: '2026-11-01' })]), ['CRM-5', 'CRM-40']);
});

test('deadlineFrom names whose deadline it is', () => {
  const out = byKey(rankCards([
    card('CRM-1', { dueDate: '2026-11-10', milestoneTargetDate: '2026-11-20' }),
    card('CRM-2', { dueDate: null, milestoneTargetDate: '2026-11-12' }),
    card('CRM-3', { dueDate: '2026-11-12', milestoneTargetDate: '2026-11-12' }),
    card('CRM-4', { dueDate: null, milestoneTargetDate: null }),
  ], { today: '2026-11-16' }));
  assert.deepEqual(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'].map(k => out[k].deadlineFrom), ['card', 'milestone', 'card', null]);
});
