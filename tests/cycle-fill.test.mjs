import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCycle, remainingFraction } from '../scripts/lib/cycle/fill.mjs';
import { TIER_POINTS } from '../scripts/lib/cycle/size.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const TODO = { name: 'Todo', type: 'unstarted' };
const DOING = { name: 'In Progress', type: 'started' };
const REVIEW = { name: 'In Review', type: 'started' };
const A = { id: 'u-a', name: 'Dev A' };
const B = { id: 'u-b', name: 'Dev B' };
const person = (who, committed, stretch, over = {}) => ({ ...who, member: true, availability: 100, committed, stretch, ...over });
const tiers = {};
const sizeOf = key => ({ tier: tiers[key] ?? 'M', points: TIER_POINTS[tiers[key] ?? 'M'], source: 'record' });
const card = (key, tier, over = {}) => {
  tiers[key] = tier;
  return { key, id: `uuid-${key}`, title: `Card ${key}`, state: TODO, assignee: null, offMapBlockers: [], ...over };
};
const fill = ({ people, fixed = [], candidates = [], edges = [], done = new Set() }) => fillCycle({ people, fixed, candidates, edges, done, sizeOf });
const byKey = cards => Object.fromEntries(cards.map(c => [c.key, c]));

test('remaining fraction: not started 1, in progress 0.75, in review 0.25', () => {
  assert.deepEqual([TODO, DOING, REVIEW, { name: 'Backlog', type: 'backlog' }].map(remainingFraction), [1, 0.75, 0.25, 1]);
});

test('fixed load past capacity flags the person over and gives them no new card', () => {
  const out = fill({
    people: [person(A, 6, 7.67)],
    fixed: [card('ABC-1', 'L', { kind: 'carry-over', state: DOING, assignee: A }), card('ABC-2', 'XL', { kind: 'carry-over', assignee: A })],
    candidates: [card('ABC-3', 'S', { assignee: A })],
  });
  const cards = byKey(out.cards);
  assert.deepEqual([cards['ABC-1'].band, cards['ABC-1'].remaining, cards['ABC-2'].band], ['fixed', 2.25, 'fixed']);
  assert.deepEqual([out.people[0].load, out.people[0].over], [7.25, 1.25]);
  assert.deepEqual([cards['ABC-3'].band, cards['ABC-3'].reason], ['left-out', 'Dev A is over committed']);
});

test('a card fits committed, then stretch, then is left out', () => {
  const out = fill({ people: [person(A, 4, 6)], candidates: [card('ABC-1', 'L', { assignee: A }), card('ABC-2', 'M', { assignee: A }), card('ABC-3', 'M', { assignee: A })] });
  assert.deepEqual(out.cards.map(c => c.band), ['committed', 'stretch', 'left-out']);
});

test('a card ranked before its blocker waits and lands after it, in the same band or later', () => {
  const out = fill({
    people: [person(A, 4, 8)],
    candidates: [card('ABC-2', 'S', { assignee: A }), card('ABC-1', 'L', { assignee: A }), card('ABC-3', 'S', { assignee: A })],
    edges: [{ from: 'ABC-1', to: 'ABC-2' }],
  });
  const cards = byKey(out.cards);
  // ABC-2 waits for ABC-1, then lands right after it, ahead of the lower-ranked ABC-3.
  assert.deepEqual([cards['ABC-1'].band, cards['ABC-2'].band, cards['ABC-3'].band], ['committed', 'committed', 'stretch']);
});

test('a card whose blocker is in stretch is capped at stretch', () => {
  const out = fill({
    people: [person(A, 3, 10), person(B, 10, 10)],
    candidates: [card('ABC-1', 'L', { assignee: A }), card('ABC-2', 'L', { assignee: A }), card('ABC-3', 'S', { assignee: B })],
    edges: [{ from: 'ABC-2', to: 'ABC-3' }],
  });
  assert.deepEqual(out.cards.map(c => c.band), ['committed', 'stretch', 'stretch']);
});

test('a blocked card whose blocker is left out is left out, blocked by it', () => {
  const out = fill({ people: [person(A, 2, 2)], candidates: [card('ABC-1', 'XL', { assignee: A }), card('ABC-2', 'S', { assignee: A })], edges: [{ from: 'ABC-1', to: 'ABC-2' }] });
  assert.deepEqual(byKey(out.cards)['ABC-2'].reason, 'blocked by ABC-1');
});

test('a card blocked by an open card outside the plan is left out, blocked by it; a done blocker does not block', () => {
  const out = fill({
    people: [person(A, 10, 10)],
    candidates: [card('ABC-2', 'S', { assignee: A }), card('ABC-3', 'S', { assignee: A })],
    edges: [{ from: 'ABC-9', to: 'ABC-2' }, { from: 'ABC-8', to: 'ABC-3' }],
    done: new Set(['ABC-8']),
  });
  const cards = byKey(out.cards);
  assert.deepEqual([cards['ABC-2'].band, cards['ABC-2'].reason, cards['ABC-3'].band], ['left-out', 'blocked by ABC-9', 'committed']);
});

test('an open blocker outside the project keeps the card out', () => {
  const out = fill({ people: [person(A, 10, 10)], candidates: [card('ABC-1', 'S', { assignee: A, offMapBlockers: ['XYZ-4'] })] });
  assert.deepEqual([out.cards[0].band, out.cards[0].reason], ['left-out', 'blocked outside the project by XYZ-4']);
});

test('unassigned cards go to the member with the lowest fill ratio, weighted by availability', () => {
  // A: 0/10, B: 0/5 → tie, higher availability → A; then A 0.2 vs B 0 → B; A 0.2 vs B 0.4 → A; A 0.4 vs B 0.4 → tie → A.
  const out = fill({
    people: [person(A, 10, 10), person(B, 5, 5, { availability: 50 })],
    candidates: ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4'].map(k => card(k, 'M')),
  });
  assert.deepEqual(out.cards.map(c => c.assignee.name), ['Dev A', 'Dev B', 'Dev A', 'Dev A']);
  assert.ok(out.cards.every(c => c.assigns));
});

test('an unassigned card that fits nobody is left out with no room', () => {
  const out = fill({ people: [person(A, 1, 1)], candidates: [card('ABC-1', 'XL')] });
  assert.deepEqual([out.cards[0].band, out.cards[0].reason, out.cards[0].assignee], ['left-out', 'no room', null]);
});

test('a member at 0% gets nothing new', () => {
  const out = fill({ people: [person(A, 0, 0, { availability: 0 }), person(B, 4, 4)], candidates: [card('ABC-1', 'M'), card('ABC-2', 'M')] });
  assert.deepEqual(out.cards.map(c => c.assignee.name), ['Dev B', 'Dev B']);
});

test('an assignee who is not a project member keeps their card and never gets unassigned ones', () => {
  const C = { id: 'u-c', name: 'Dev C' };
  const out = fill({
    people: [person(A, 2, 2), person(C, 10, 10, { member: false })],
    candidates: [card('ABC-1', 'S', { assignee: C }), card('ABC-2', 'M'), card('ABC-3', 'M')],
  });
  assert.deepEqual(out.cards.map(c => [c.key, c.band, c.assignee?.name ?? null]), [
    ['ABC-1', 'committed', 'Dev C'], ['ABC-2', 'committed', 'Dev A'], ['ABC-3', 'left-out', null],
  ]);
});

test('an unassigned fixed card goes to the least loaded member, even past capacity', () => {
  const out = fill({
    people: [person(A, 1, 1), person(B, 2, 2)],
    fixed: [card('ABC-1', 'XL', { kind: 'carry-over' })],
  });
  assert.deepEqual([out.cards[0].band, out.cards[0].assignee.name, out.cards[0].assigns], ['fixed', 'Dev A', true]);
  assert.equal(out.people[0].over, 4);
});

test('a started card outside the active cycle is a candidate at its fraction, and what it blocks can land', () => {
  const out = fill({
    people: [person(A, 3, 3)],
    candidates: [card('ABC-1', 'XL', { state: REVIEW, assignee: A }), card('ABC-2', 'S', { assignee: A })],
    edges: [{ from: 'ABC-1', to: 'ABC-2' }],
  });
  assert.deepEqual(out.cards.map(c => [c.remaining, c.band]), [[1.25, 'committed'], [1, 'committed']]);
});

test('over counts only the fixed load, so a stretch card never flags the person', () => {
  const out = fill({
    people: [person(A, 1, 3)],
    fixed: [card('ABC-1', 'M', { kind: 'carry-over', state: REVIEW, assignee: A })],
    candidates: [card('ABC-2', 'M', { assignee: A })],
  });
  assert.deepEqual([out.cards[1].band, out.people[0].load, out.people[0].over], ['stretch', 2.5, 0]);
});

test('a waiting card keeps its rank: it lands right after its blocker, before lower-ranked filler', () => {
  const out = fill({
    people: [person(A, 4, 4)],
    candidates: ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4'].map(k => card(k, 'M', { assignee: A })),
    edges: [{ from: 'ABC-2', to: 'ABC-1' }],
  });
  assert.deepEqual(out.cards.map(c => c.band), ['committed', 'committed', 'left-out', 'left-out']);
});

test('a card blocked by a left-out card names a real blocker, also inside a loop', () => {
  const chain = fill({
    people: [person(A, 10, 10)],
    candidates: [card('ABC-2', 'S', { assignee: A }), card('ABC-3', 'S', { assignee: A })],
    edges: [{ from: 'ABC-9', to: 'ABC-2' }, { from: 'ABC-2', to: 'ABC-3' }],
  });
  assert.deepEqual(chain.cards.map(c => c.reason), ['blocked by ABC-9', 'blocked by ABC-2']);
  const loop = fill({
    people: [person(A, 10, 10)],
    candidates: [card('ABC-1', 'S', { assignee: A }), card('ABC-2', 'S', { assignee: A })],
    edges: [{ from: 'ABC-1', to: 'ABC-2' }, { from: 'ABC-2', to: 'ABC-1' }],
  });
  assert.deepEqual(loop.cards.map(c => c.reason), ['blocked by ABC-2', 'blocked by ABC-1']);
});

test('a person over committed from fixed load gets no new card, assigned or not', () => {
  const out = fill({
    people: [person(A, 3, 8), person(B, 0, 0, { availability: 0 })],
    fixed: [card('ABC-1', 'L', { kind: 'carry-over', assignee: A }), card('ABC-2', 'S', { kind: 'carry-over', assignee: A })],
    candidates: [card('ABC-3', 'S', { assignee: A }), card('ABC-4', 'S')],
  });
  assert.deepEqual(out.cards.slice(2).map(c => [c.band, c.reason]), [['left-out', 'Dev A is over committed'], ['left-out', 'no room']]);
});
