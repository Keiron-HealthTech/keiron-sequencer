import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tracksOf } from '../scripts/lib/spike/tracks.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

test('two disconnected chains are two tracks, ids by first card', () => {
  const t = tracksOf({ order: ['A', 'X', 'B', 'Y'], edges: [{ from: 'A', to: 'B' }, { from: 'X', to: 'Y' }], links: [] });
  assert.deepEqual(t, [{ id: 't1', cards: ['A', 'B'] }, { id: 't2', cards: ['X', 'Y'] }]);
});

test('an edge in either direction joins; a previous fixup link joins too', () => {
  const t = tracksOf({ order: ['A', 'B', 'C'], edges: [{ from: 'B', to: 'A' }], links: [['C', 'A']] });
  assert.deepEqual(t, [{ id: 't1', cards: ['A', 'B', 'C'] }]);
});

test('edges and links to cards outside the run are ignored', () => {
  const t = tracksOf({ order: ['A', 'B'], edges: [{ from: 'Z', to: 'A' }, { from: 'Z', to: 'B' }], links: [['Z', 'B']] });
  assert.equal(t.length, 2);
});

test('a link whose first card is outside the run still joins its remaining cards', () => {
  const t = tracksOf({ order: ['A', 'B', 'C'], edges: [], links: [['Z', 'B', 'C']] });
  assert.deepEqual(t, [{ id: 't1', cards: ['A'] }, { id: 't2', cards: ['B', 'C'] }]);
});
