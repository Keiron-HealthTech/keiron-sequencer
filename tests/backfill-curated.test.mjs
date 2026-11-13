import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spikedCards, validateCurated, validateFixupNotes, writeSkeletons } from '../scripts/backfill/build-records.mjs';
import { MINI } from './helpers/trial-patches.mjs';

const MAP = JSON.parse(readFileSync(join(MINI, 'backfill/patch-map.json'), 'utf8'));

const valid = () => ({
  card: 'CRM-1187',
  scope: { complete: true, note: null },
  cases: [{ given: 'a signed-in user', when: 'they open a deal', then: 'sensitive values are hidden', source: 'engram', ref: 'engram:example-api#635' }],
  decisions: [{ text: 'Cache the check for 5 seconds.', ref: 'engram:example-api#635' }],
  findings: [{ kind: 'reorder', text: 'Must land before the surfaces.', ref: 'engram:example-api#635' }],
  engram: ['example-api#635'],
});
const has = (errors, prefix) => errors.some(e => e.startsWith(prefix));

test('skeletons: one file per spiked card, an archived card keeps its marker from the map, never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keiron-sequencer-curated-'));
  const archived = { at: '2026-01-01', reason: 'Archived in Linear.' };
  const map = { ...MAP, cards: { 'CRM-3': { archived } } };
  try {
    const cards = spikedCards(map);
    assert.deepEqual(cards, ['CRM-1', 'CRM-2', 'CRM-3']);
    const first = writeSkeletons(dir, map);
    assert.deepEqual(first, { written: cards, kept: [] });
    assert.deepEqual(readdirSync(dir).sort(), cards.map(c => `${c}.json`));

    const read = card => JSON.parse(readFileSync(join(dir, `${card}.json`), 'utf8'));
    assert.deepEqual(read('CRM-1'), { card: 'CRM-1', scope: { complete: true, note: null }, cases: [], decisions: [], findings: [], engram: [] });
    assert.deepEqual(read('CRM-3').archived, archived);
    assert.equal('archived' in read('CRM-1'), false);

    writeFileSync(join(dir, 'CRM-1.json'), 'edited\n');
    const second = writeSkeletons(dir, map);
    assert.deepEqual(second, { written: [], kept: cards });
    assert.equal(readFileSync(join(dir, 'CRM-1.json'), 'utf8'), 'edited\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateCurated accepts a complete card and an archived card without cases', () => {
  assert.deepEqual(validateCurated(valid()), []);
  const archived = { ...valid(), cases: [], archived: { at: '2026-11-09', reason: 'Archived in Linear.' } };
  assert.deepEqual(validateCurated(archived), []);
});

test('validateCurated rejects a live card without cases and an incomplete scope without a note', () => {
  assert.ok(has(validateCurated({ ...valid(), cases: [] }), '$.cases'));
  assert.ok(has(validateCurated({ ...valid(), scope: { complete: false, note: null } }), '$.scope.note'));
});

test('validateCurated rejects empty given/when/then, missing source or ref, and a ref that does not match its source', () => {
  for (const key of ['given', 'when', 'then']) {
    const v = valid();
    v.cases[0][key] = '';
    assert.ok(has(validateCurated(v), `$.cases[0].${key}`), key);
  }
  for (const key of ['source', 'ref']) {
    const v = valid();
    delete v.cases[0][key];
    assert.ok(has(validateCurated(v), `$.cases[0].${key}`), key);
  }
  const v = valid();
  v.cases[0].source = 'linear';
  assert.ok(has(validateCurated(v), '$.cases[0].ref'));
});

test('validateCurated rejects bad kinds, bad refs, malformed engram ids, unknown keys and non-objects', () => {
  const kind = valid();
  kind.findings[0].kind = 'other';
  assert.ok(has(validateCurated(kind), '$.findings[0].kind'));

  const ref = valid();
  ref.decisions[0].ref = 'example-api#635';
  assert.ok(has(validateCurated(ref), '$.decisions[0].ref'));

  assert.ok(has(validateCurated({ ...valid(), engram: ['635'] }), '$.engram[0]'));
  assert.ok(has(validateCurated({ ...valid(), case: [] }), '$.case'));

  const caseKey = valid();
  caseKey.cases[0].id = 'c1';
  assert.ok(has(validateCurated(caseKey), '$.cases[0].id'));

  const missing = valid();
  delete missing.engram;
  assert.ok(has(validateCurated(missing), '$.engram'));

  for (const bad of [null, [], 'x']) assert.deepEqual(validateCurated(bad), ['$: expected object']);
});

const CURATED = join(MINI, 'backfill/curated');
const engramRefs = c => ['cases', 'decisions', 'findings'].flatMap(k => c[k].map(i => i.ref))
  .filter(r => r.startsWith('engram:')).map(r => r.slice('engram:'.length));

test('the mini trial curated files validate, are named by card, list every engram ref they use and cover every spiked card', () => {
  const files = readdirSync(CURATED).filter(f => f.startsWith('CRM-')).sort();
  assert.deepEqual(files, spikedCards(MAP).map(c => `${c}.json`));
  for (const file of files) {
    const curated = JSON.parse(readFileSync(join(CURATED, file), 'utf8'));
    assert.equal(file, `${curated.card}.json`);
    assert.deepEqual(validateCurated(curated), [], file);
    for (const ref of engramRefs(curated)) assert.ok(curated.engram.includes(ref), `${file}: ${ref}`);
    if (!curated.archived) assert.ok(curated.cases.length >= 1, file);
  }
});

test('the mini trial fixup notes validate and cover every fixup and refactor patch', () => {
  const notes = JSON.parse(readFileSync(join(CURATED, 'fixups.json'), 'utf8'));
  assert.deepEqual(validateFixupNotes(notes, MAP), []);
  const patches = Object.entries(MAP.patches).filter(([, e]) => e.kind === 'fixup' || e.kind === 'refactor').map(([p]) => p).sort();
  assert.deepEqual(Object.keys(notes).sort(), patches);
});

test('validateFixupNotes accepts notes for fixup and refactor patches and rejects anything else', () => {
  const fixup = 'api/fixup-1-from-3-shared-helper.patch';
  const refactor = 'api/refactor-3-from-1-shared-loaders.patch';
  const map = { ...MAP, patches: { ...MAP.patches, [refactor]: { kind: 'refactor', fixed: ['CRM-3'], from: 'CRM-1' } } };
  const ok = { note: 'A note.', ref: 'linear:CRM-3' };
  assert.deepEqual(validateFixupNotes({ [fixup]: ok, [refactor]: ok }, map), []);
  assert.ok(has(validateFixupNotes({ 'api/00001-new.patch': ok }, map), '$["api/00001-new.patch"]'));
  assert.ok(has(validateFixupNotes({ 'api/fixup-9-from-8-x.patch': ok }, map), '$["api/fixup-9-from-8-x.patch"]'));
  assert.ok(has(validateFixupNotes({ [fixup]: { ...ok, note: '' } }, map), `$["${fixup}"].note`));
  assert.ok(has(validateFixupNotes({ [fixup]: { ...ok, ref: 'x' } }, map), `$["${fixup}"].ref`));
  assert.deepEqual(validateFixupNotes(null, map), ['$: expected object']);
});
