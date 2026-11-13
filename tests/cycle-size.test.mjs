import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchors, makeSizer, TIER_POINTS } from '../scripts/lib/cycle/size.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const record = (card, lines, over = {}) => ({
  card, title: `Card ${card}`, origin: 'thin-spike', archived: null, supersededBy: null,
  size: { prodLines: lines, testLines: 0 }, ...over,
});
const POPULATION = [record('ABC-1', 10), record('ABC-2', 20), record('ABC-3', 30), record('ABC-4', 40)];

test('tier points are S=1, M=2, L=3, XL=5', () => {
  assert.deepEqual(TIER_POINTS, { S: 1, M: 2, L: 3, XL: 5 });
});

test('a thin-spike record keeps the tier tiers() gives it', () => {
  const sizeOf = makeSizer(POPULATION);
  assert.deepEqual(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4'].map(k => sizeOf(k).tier), ['S', 'M', 'L', 'XL']);
  assert.deepEqual(sizeOf('ABC-3'), { tier: 'L', points: 3, source: 'record' });
});

test('an existing-pr record is placed on the thin-spike boundaries by its lines', () => {
  const sizeOf = makeSizer([...POPULATION,
    record('ABC-5', 25, { origin: 'existing-pr' }), record('ABC-6', 5, { origin: 'existing-pr' }), record('ABC-7', 400, { origin: 'existing-pr' })]);
  assert.equal(sizeOf('ABC-5').tier, 'M');
  assert.equal(sizeOf('ABC-6').tier, 'S');
  assert.equal(sizeOf('ABC-7').tier, 'XL');
  assert.equal(sizeOf('ABC-5').source, 'record');
});

test('a card with no record, or 0 lines, uses its guess, else M', () => {
  const sizeOf = makeSizer([...POPULATION, record('ABC-8', 0)], { 'ABC-9': 'L', 'ABC-8': 'S' });
  assert.deepEqual(sizeOf('ABC-9'), { tier: 'L', points: 3, source: 'guess' });
  assert.deepEqual(sizeOf('ABC-8'), { tier: 'S', points: 1, source: 'guess' });
  assert.deepEqual(sizeOf('ABC-10'), { tier: 'M', points: 2, source: 'default' });
});

test('an archived or superseded record counts as no record', () => {
  const sizeOf = makeSizer([...POPULATION,
    record('ABC-11', 400, { archived: { at: '2026-11-01', reason: 'gone' } }),
    record('ABC-12', 400, { supersededBy: { card: 'ABC-13', spikedAt: '2026-11-01T00:00:00.000Z' } })]);
  assert.equal(sizeOf('ABC-11').source, 'default');
  assert.equal(sizeOf('ABC-12').source, 'default');
});

test('with no thin-spike population every record falls back to guess or default', () => {
  const sizeOf = makeSizer([record('ABC-5', 25, { origin: 'existing-pr' })], { 'ABC-6': 'XL' });
  assert.deepEqual(sizeOf('ABC-5'), { tier: 'M', points: 2, source: 'default' });
  assert.deepEqual(sizeOf('ABC-6'), { tier: 'XL', points: 5, source: 'guess' });
});

test('anchors lists up to three spiked cards per tier, lowest card number first', () => {
  const many = Array.from({ length: 16 }, (_, i) => record(`ABC-${i + 1}`, (i + 1) * 10));
  const a = anchors(many);
  assert.deepEqual(a.S, [{ key: 'ABC-1', title: 'Card ABC-1' }, { key: 'ABC-2', title: 'Card ABC-2' }, { key: 'ABC-3', title: 'Card ABC-3' }]);
  assert.deepEqual(a.XL.map(c => c.key), ['ABC-13', 'ABC-14', 'ABC-15']);
  assert.deepEqual(anchors([]), { S: [], M: [], L: [], XL: [] });
});
