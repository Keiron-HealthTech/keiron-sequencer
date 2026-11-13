import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEffort } from '../scripts/backfill/effort.mjs';

const t = s => `2026-01-01T${s}.000Z`;
const tokens = n => ({ input: n, cacheCreation: 0, cacheRead: 0, output: n, thinking: 0 });
const win = (start, end, patches, n) => ({ start: t(start), end: t(end), patches, messages: n, tokens: tokens(n) });
const MAP = {
  patches: {
    'backend/00001-new.patch': { kind: 'card', cards: ['CRM-1'] },
    'backend/00002-00003-partial.patch': { kind: 'card', cards: ['CRM-3', 'CRM-2'] },
    'backend/00002-finish.patch': { kind: 'card', cards: ['CRM-2'] },
    'backend/fixup-4-from-1-x.patch': { kind: 'fixup', fixed: ['CRM-4'], from: 'CRM-1' },
    'backend/refactor-1-from-3-y.patch': { kind: 'refactor', fixed: ['CRM-1'], from: 'CRM-3' },
    'backend/00004-existing.patch': { kind: 'card', cards: ['CRM-4'], existing: true },
    'backend/00000-old.patch': { kind: 'skip', replacedBy: 'backend/00001-new.patch' },
  },
};
const USAGE = {
  schemaVersion: 1,
  source: {},
  windows: [
    win('00:00:00', '00:01:00', ['backend/00004-existing.patch'], 1),
    win('00:01:00', '00:02:00', ['backend/00001-new.patch'], 2),
    win('00:02:00', '00:03:00', ['backend/00002-00003-partial.patch', 'backend/fixup-4-from-1-x.patch'], 3),
    win('00:03:00', '00:04:00', ['backend/refactor-1-from-3-y.patch'], 4),
    win('00:04:00', '00:05:00', ['backend/00002-finish.patch'], 5),
  ],
};
const plain = (start, end, cards, n) => ({ start: t(start), end: t(end), cards, messages: n, tokens: tokens(n) });

test('a window credits card patches to their cards and fixup/refactor patches to the causer', () => {
  const out = cardEffort(MAP, USAGE);
  assert.deepEqual(out['CRM-1'].effort, {
    basis: 'transcript-window',
    windows: [plain('00:01:00', '00:02:00', ['CRM-1'], 2), plain('00:02:00', '00:03:00', ['CRM-1', 'CRM-2', 'CRM-3'], 3)],
  });
  assert.deepEqual(out['CRM-3'].effort.windows.map(w => w.end), [t('00:03:00'), t('00:04:00')]);
});

test('a group window is identical for every member and never split or summed', () => {
  const out = cardEffort(MAP, USAGE);
  const shared = plain('00:02:00', '00:03:00', ['CRM-1', 'CRM-2', 'CRM-3'], 3);
  for (const card of ['CRM-1', 'CRM-2', 'CRM-3']) assert.deepEqual(out[card].effort.windows.find(w => w.end === t('00:03:00')), shared);
});

test('a multi-window card keeps each window, sorted by end', () => {
  assert.deepEqual(cardEffort(MAP, USAGE)['CRM-2'].effort.windows, [
    plain('00:02:00', '00:03:00', ['CRM-1', 'CRM-2', 'CRM-3'], 3),
    plain('00:04:00', '00:05:00', ['CRM-2'], 5),
  ]);
});

test('existing-pr cards get null effort but still a spikedAt', () => {
  assert.deepEqual(cardEffort(MAP, USAGE)['CRM-4'], { effort: null, spikedAt: t('00:01:00') });
});

test('spikedAt is the latest end over the card\'s own card-patch windows, fixup and refactor windows excluded', () => {
  const out = cardEffort(MAP, USAGE);
  assert.equal(out['CRM-1'].spikedAt, t('00:02:00'));
  assert.equal(out['CRM-2'].spikedAt, t('00:05:00'));
  assert.equal(out['CRM-3'].spikedAt, t('00:03:00'));
  assert.deepEqual(Object.keys(out), ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4']);
});

test('a window whose start is not before its end fails the run', () => {
  const bad = structuredClone(USAGE);
  bad.windows[1].start = bad.windows[1].end;
  assert.throws(() => cardEffort(MAP, bad), /backend\/00001-new\.patch/);
});

test('a card patch with no window fails the run', () => {
  const missing = structuredClone(USAGE);
  missing.windows.pop();
  assert.throws(() => cardEffort(MAP, missing), /backend\/00002-finish\.patch/);
});
