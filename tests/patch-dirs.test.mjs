import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invert, readDirMap, renamePatchRefs } from '../scripts/lib/patch-dirs.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const root = () => {
  const dir = tempDir('keiron-sequencer-patch-dirs-');
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('readDirMap returns the manifest dirs, or an empty map when the file is missing or not an object map', () => {
  const dir = root();
  assert.deepEqual(readDirMap(dir), {});
  writeFileSync(join(dir, 'dirs.json'), JSON.stringify({ schemaVersion: 1, dirs: { backend: 'example-api', perms: 'auth' } }));
  assert.deepEqual(readDirMap(dir), { backend: 'example-api', perms: 'auth' });
  for (const text of ['[]', '{"dirs": []}', '{"dirs": "x"}', 'not json', '{"schemaVersion": 1}']) {
    writeFileSync(join(dir, 'dirs.json'), text);
    assert.deepEqual(readDirMap(dir), {}, text);
  }
});

const record = {
  card: 'CRM-1',
  fixups: { received: [{ from: 'CRM-2', patch: 'backend/fixup-1-from-2-x.patch', note: null }], caused: [{ to: 'CRM-3', patch: 'perms/fixup-3-from-1-y.patch', note: null }] },
  cases: [{ id: 'c1', given: 'backend/x.patch is mentioned', when: 'w', then: 't', source: 'patch', ref: 'patch:backend/01182-new.patch' }],
  decisions: [{ text: 'd', ref: 'patch:frontend/01201-new.patch' }],
  refs: { patches: ['backend/01182-new.patch', 'frontend/01201-new.patch', 'other/01182-new.patch'], linear: 'https://linear.app/x/issue/CRM-1' },
};

test('renamePatchRefs rewrites every patch path naming a mapped dir, anywhere in a value, and nothing else', () => {
  const map = { backend: 'example-api', perms: 'auth' };
  const out = renamePatchRefs(record, map);
  assert.deepEqual(out.refs.patches, ['example-api/01182-new.patch', 'frontend/01201-new.patch', 'other/01182-new.patch']);
  assert.equal(out.fixups.received[0].patch, 'example-api/fixup-1-from-2-x.patch');
  assert.equal(out.fixups.caused[0].patch, 'auth/fixup-3-from-1-y.patch');
  assert.equal(out.cases[0].ref, 'patch:example-api/01182-new.patch');
  assert.equal(out.cases[0].given, 'backend/x.patch is mentioned');
  assert.equal(out.decisions[0].ref, 'patch:frontend/01201-new.patch');
  assert.equal(out.refs.linear, record.refs.linear);
  assert.equal(renamePatchRefs('backend/sub/x.patch', map), 'backend/sub/x.patch');
  assert.equal(renamePatchRefs('backend/x.diff', map), 'backend/x.diff');
  assert.equal(record.refs.patches[0], 'backend/01182-new.patch');
  assert.deepEqual(renamePatchRefs(record, {}), record);
});

test('invert swaps a map, and a round trip through the inverse is the identity', () => {
  const map = { backend: 'example-api', perms: 'auth' };
  assert.deepEqual(invert(map), { 'example-api': 'backend', auth: 'perms' });
  assert.deepEqual(renamePatchRefs(renamePatchRefs(record, map), invert(map)), record);
});
