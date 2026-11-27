import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOptions } from '../scripts/lib/cycle/options.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const A = { id: 'u-a', name: 'Dev A' };
const person = (who, committed, stretch, history, over = {}) => ({
  ...who, member: true, availability: 100, committed, stretch, history, cycles: history.map((_, i) => 9 - i), basis: 'history', ...over,
});
const card = (key, band, remaining, over = {}) => ({ key, band, remaining, assignee: A, built: null, ...over });
const ids = o => o.options.map(x => x.id);
const byId = (o, id) => o.options.find(x => x.id === id);

test('with no stretch cards the only option is committed', () => {
  const o = planOptions({ people: [person(A, 6, 8, [6, 9, 9])], cards: [card('ABC-1', 'committed', 3)] });
  assert.deepEqual([ids(o), o.recommended], [['A'], 'A']);
});

test('a steady history recommends committed, and C drops the lowest-ranked stretch cards to the middle of the range', () => {
  // committed 6, stretch 12, middle 9; B loads 4 + 3 + 2 + 2 + 2 = 13.
  const cards = [card('ABC-1', 'committed', 4), card('ABC-2', 'stretch', 3), card('ABC-3', 'stretch', 2), card('ABC-4', 'stretch', 2), card('ABC-5', 'stretch', 2)];
  const o = planOptions({ people: [person(A, 6, 12, [6, 10, 20])], cards });
  assert.deepEqual([ids(o), o.recommended], [['A', 'B', 'C'], 'A']);
  assert.deepEqual([byId(o, 'A').people[0].load, byId(o, 'B').people[0].load], [4, 13]);
  assert.deepEqual([byId(o, 'C').drop, byId(o, 'C').people[0].load, byId(o, 'C').cards], [['ABC-4', 'ABC-5'], 9, 3]);
  assert.deepEqual([byId(o, 'C').withStretch, byId(o, 'A').withStretch], [true, false]);
});

test('drops never take a built card, and take focus cards last', () => {
  const cards = [
    card('ABC-1', 'committed', 4), card('ABC-2', 'stretch', 3), card('ABC-3', 'stretch', 2),
    card('ABC-4', 'stretch', 0.5, { built: { kind: 'pr', evidence: 'PR app#4' } }), card('ABC-5', 'stretch', 3),
  ];
  const o = planOptions({ people: [person(A, 6, 12, [6, 10, 20])], cards, focusKeys: new Set(['ABC-5']) });
  // B is 12.5 against a middle of 9: ABC-3 goes first (lowest unfocused), then ABC-2; ABC-4 is built, ABC-5 is the focus.
  assert.deepEqual([byId(o, 'C').drop, byId(o, 'C').people[0].load], [['ABC-2', 'ABC-3'], 7.5]);
});

test('a lowest cycle under half the next one is an outlier: the recommendation takes stretch and says why', () => {
  const cards = [card('ABC-1', 'fixed', 1.7), card('ABC-2', 'stretch', 10), card('ABC-3', 'stretch', 9)];
  const o = planOptions({ people: [person(A, 2, 21.58, [37.75, 25, 2], { cycles: [44, 43, 42] })], cards });
  // Without cycle 42, committed would be 21.58 (25, capped at stretch): B's 20.7 fits, so nothing is dropped.
  assert.deepEqual([ids(o), o.recommended], [['A', 'B'], 'B']);
  assert.equal(o.reason, "Dev A's committed is pinned by cycle 42 (2 pts, against 37.75 and 25); without it, committed would be 21.58");
});

test('an outlier whose stretch still runs past the middle recommends C', () => {
  const cards = [card('ABC-1', 'stretch', 5), card('ABC-2', 'stretch', 5), card('ABC-3', 'stretch', 5)];
  const o = planOptions({ people: [person(A, 1, 16, [20, 1, 27])], cards });
  // Without the 1, committed would be 16 (20 capped at stretch 16): B's 15 fits the middle, 16, so B.
  assert.equal(o.recommended, 'B');
  const tight = planOptions({ people: [person(A, 1, 16, [20, 1, 27], { availability: 50 })], cards });
  // At 50%, committed would be 10: the middle is 13, so ABC-3 drops and C is recommended.
  assert.deepEqual([tight.recommended, byId(tight, 'C').drop], ['C', ['ABC-3']]);
});
