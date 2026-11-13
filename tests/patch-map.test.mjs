import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPatchMap, diskPath, listPatches, parsePatchName } from '../scripts/backfill/patch-map.mjs';

const MINI = JSON.parse(readFileSync(new URL('./fixtures/mini-trial/backfill/patch-map.json', import.meta.url), 'utf8'));
const MAP = {
  ...MINI,
  patches: {
    ...MINI.patches,
    'api/00000-old.patch': { kind: 'skip', replacedBy: 'api/00001-new.patch', reason: 'r' },
    'api/refactor-3-from-1-shared-loader.patch': { kind: 'refactor', fixed: ['CRM-3'], from: 'CRM-1' },
  },
};

test('fixup and refactor names parse into the fixed cards and the causer', () => {
  assert.deepEqual(parsePatchName('backend/fixup-1184-1188-from-1187-labels.patch'),
    { kind: 'fixup', fixed: ['CRM-1184', 'CRM-1188'], from: 'CRM-1187' });
  assert.deepEqual(parsePatchName('backend/refactor-1210-from-1208-shared-loaders.patch'),
    { kind: 'refactor', fixed: ['CRM-1210'], from: 'CRM-1208' });
  for (const name of ['backend/00042-existing+fixup-extra.patch', 'backend/00007-test-fix.patch']) {
    assert.equal(parsePatchName(name), null, name);
  }
});

test('checkPatchMap names the offending patch for every kind of map error', () => {
  const patches = Object.keys(MAP.patches).sort();
  assert.deepEqual(checkPatchMap(MAP, patches), []);
  const broken = (path, entry) => ({ ...MAP, patches: { ...MAP.patches, [path]: entry } });
  const cases = [
    [MAP, [...patches, 'api/09999-new.patch'], 'api/09999-new.patch', /not mapped/],
    [broken('api/09998-new.patch', { kind: 'card', cards: ['CRM-9998'] }), patches, 'api/09998-new.patch', /no such patch/],
    [broken('api/fixup-1-from-3-shared-helper.patch', { kind: 'fixup', fixed: ['CRM-2'], from: 'CRM-3' }), patches,
      'api/fixup-1-from-3-shared-helper.patch', /file name/],
    [broken('api/fixup-1-from-3-shared-helper.patch', { kind: 'card', cards: ['CRM-1'] }), patches,
      'api/fixup-1-from-3-shared-helper.patch', /file name/],
    [broken('api/00003-new.patch', { kind: 'fixup', fixed: ['CRM-1'], from: 'CRM-3' }), patches, 'api/00003-new.patch', /file name/],
    [broken('api/00000-old.patch', { kind: 'skip', replacedBy: 'api/00099-x.patch', reason: 'r' }), patches, 'api/00000-old.patch', /replacedBy/],
    [broken('api/00003-new.patch', { kind: 'card', cards: [] }), patches, 'api/00003-new.patch', /cards/],
    [broken('api/00003-new.patch', { kind: 'card', cards: ['CRM-3', 'CRM-3'] }), patches, 'api/00003-new.patch', /cards/],
    [broken('api/00003-new.patch', { kind: 'feature', cards: ['CRM-3'] }), patches, 'api/00003-new.patch', /kind/],
    [{ ...MAP, repos: { ...MAP.repos, api: undefined } }, patches, 'api/00003-new.patch', /repo/],
  ];
  for (const [map, files, path, why] of cases) {
    const errors = checkPatchMap(map, files);
    assert.ok(errors.some(e => e.startsWith(`${path}: `) && why.test(e)), `${path} ${why}: ${JSON.stringify(errors)}`);
  }
});

test('with a rename manifest, listPatches names the patches by their trial dir and diskPath reads the renamed folder; without one both are as before', () => {
  const root = mkdtempSync(join(tmpdir(), 'keiron-sequencer-patch-map-'));
  try {
    for (const [dir, file] of [['example-api', '00001-new.patch'], ['worker', '00002-new.patch']]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, file), `${dir}\n`);
    }
    assert.deepEqual(listPatches(root), ['example-api/00001-new.patch', 'worker/00002-new.patch']);
    assert.equal(diskPath(root, 'example-api/00001-new.patch'), join(root, 'example-api', '00001-new.patch'));
    writeFileSync(join(root, 'dirs.json'), JSON.stringify({ schemaVersion: 1, dirs: { backend: 'example-api' } }));
    assert.deepEqual(listPatches(root), ['backend/00001-new.patch', 'worker/00002-new.patch']);
    assert.equal(diskPath(root, 'backend/00001-new.patch'), join(root, 'example-api', '00001-new.patch'));
    assert.equal(readFileSync(diskPath(root, 'worker/00002-new.patch'), 'utf8'), 'worker\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
