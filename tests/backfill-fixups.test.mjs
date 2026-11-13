import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardFixups } from '../scripts/backfill/fixups.mjs';
import { MINI } from './helpers/trial-patches.mjs';

const MAP = JSON.parse(readFileSync(join(MINI, 'backfill/patch-map.json'), 'utf8'));
const NOTES = JSON.parse(readFileSync(join(MINI, 'backfill/curated/fixups.json'), 'utf8'));

const FIX = 'backend/fixup-1221-from-1220-x.patch';
const MULTI = 'backend/fixup-1184-1188-from-1187-labels.patch';
const synthetic = {
  repos: { backend: 'example-api' },
  cards: {},
  patches: {
    'backend/01220-new.patch': { kind: 'card', cards: ['CRM-1220'] },
    'backend/01221-new.patch': { kind: 'card', cards: ['CRM-1221'] },
    'backend/01222-new.patch': { kind: 'card', cards: ['CRM-1222'] },
    [FIX]: { kind: 'fixup', fixed: ['CRM-1221'], from: 'CRM-1220' },
    [MULTI]: { kind: 'fixup', fixed: ['CRM-1184', 'CRM-1188'], from: 'CRM-1187' },
    'backend/refactor-1221-from-1187-y.patch': { kind: 'refactor', fixed: ['CRM-1221'], from: 'CRM-1187' },
  },
};
const notesFor = map => Object.fromEntries(Object.entries(map.patches)
  .filter(([, e]) => e.kind === 'fixup' || e.kind === 'refactor')
  .map(([path]) => [path, { note: `note for ${path}`, ref: 'engram:example-api#638' }]));

test('a fixup patch gives the fixed card a received entry and the causer a caused entry, with the curated note', () => {
  const out = cardFixups(synthetic, notesFor(synthetic));
  assert.deepEqual(out['CRM-1221'].received, [
    { from: 'CRM-1220', patch: FIX, note: `note for ${FIX}` },
    { from: 'CRM-1187', patch: 'backend/refactor-1221-from-1187-y.patch', note: 'note for backend/refactor-1221-from-1187-y.patch' },
  ]);
  assert.deepEqual(out['CRM-1220'].caused, [{ to: 'CRM-1221', patch: FIX, note: `note for ${FIX}` }]);
  assert.deepEqual(out['CRM-1187'].caused.map(c => [c.patch, c.to]), [
    [MULTI, 'CRM-1184'], [MULTI, 'CRM-1188'], ['backend/refactor-1221-from-1187-y.patch', 'CRM-1221'],
  ]);
  assert.deepEqual(out['CRM-1188'].received, [{ from: 'CRM-1187', patch: MULTI, note: `note for ${MULTI}` }]);
});

test('cards without fixups get empty lists', () => {
  const out = cardFixups(synthetic, notesFor(synthetic));
  assert.deepEqual(out['CRM-1222'], { received: [], caused: [] });
  assert.deepEqual(out['CRM-1220'].received, []);
});

test('a fixup without a curated note fails, naming the patch', () => {
  const notes = notesFor(synthetic);
  delete notes[FIX];
  assert.throws(() => cardFixups(synthetic, notes), new RegExp(FIX.replaceAll('.', '\\.')));
  assert.throws(() => cardFixups(synthetic, { ...notesFor(synthetic), [FIX]: { note: '', ref: 'x' } }), new RegExp(FIX.replaceAll('.', '\\.')));
});

test('a map entry that disagrees with its file name fails, naming the patch', () => {
  const wrong = { ...synthetic, patches: { ...synthetic.patches, [FIX]: { kind: 'fixup', fixed: ['CRM-1222'], from: 'CRM-1220' } } };
  assert.throws(() => cardFixups(wrong, notesFor(wrong)), /fixup-1221-from-1220-x\.patch/);
});

test('over the mini trial map, the fixup links the fixed card and the causer, and the other cards get empty lists', () => {
  const out = cardFixups(MAP, NOTES);
  const patch = 'api/fixup-1-from-3-shared-helper.patch';
  assert.deepEqual(out['CRM-1'].received, [{ from: 'CRM-3', patch, note: NOTES[patch].note }]);
  assert.deepEqual(out['CRM-3'].caused, [{ to: 'CRM-1', patch, note: NOTES[patch].note }]);
  assert.deepEqual(out['CRM-2'], { received: [], caused: [] });
});
