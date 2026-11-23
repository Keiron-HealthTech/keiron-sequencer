import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { draftFromRecords, validateHarvest } from '../scripts/lib/harvest.mjs';
import { readRecords } from '../scripts/lib/records.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SAMPLE = fileURLToPath(new URL('./fixtures/sample-records/c0ffee000001/', import.meta.url));

const record = (card, { received = [], caused = [], splitFrom = null } = {}) => ({
  card, fixups: { received, caused }, alias: { splitFrom, mergedInto: null },
});
const HARVEST = { schemaVersion: 1, project: { slug: 'c0ffee000001' } };

test('a fixup seen from both records becomes one code-edge draft: the receiver blocks the card the fix came from', () => {
  const records = [
    record('ABC-13', { received: [{ from: 'ABC-19', patch: 'backend/fixup-13-from-19.patch', note: null }] }),
    record('ABC-19', { caused: [{ to: 'ABC-13', patch: 'backend/fixup-13-from-19.patch', note: null }] }),
  ];
  assert.deepEqual(draftFromRecords(records, HARVEST), {
    edges: [{ from: 'ABC-13', to: 'ABC-19', kind: 'code', evidence: 'fixup: backend/fixup-13-from-19.patch', draft: true }],
    splits: [],
  });
  assert.deepEqual(draftFromRecords([records[1]], HARVEST).edges.map(e => [e.from, e.to]), [['ABC-13', 'ABC-19']]);
});

test('a fixup made on the combined tree of every track drafts no edge', () => {
  const patch = 'backend/fixup-13-19-from-combine-1.patch';
  const records = [
    record('ABC-13', { received: [{ from: 'combine', patch, note: 'The two tracks clash.' }] }),
    record('ABC-19', { received: [{ from: 'combine', patch, note: 'The two tracks clash.' }] }),
  ];
  assert.deepEqual(draftFromRecords(records, HARVEST), { edges: [], splits: [] });
});

test('every patch behind a pair is named in the evidence, and the drafts come out sorted', () => {
  const records = [
    record('CRM-30', { caused: [{ to: 'CRM-20', patch: 'b/two.patch', note: null }, { to: 'CRM-20', patch: 'b/one.patch', note: null }] }),
    record('CRM-10', { received: [{ from: 'CRM-30', patch: 'b/three.patch', note: null }] }),
  ];
  assert.deepEqual(draftFromRecords(records, HARVEST).edges.map(e => [e.from, e.to, e.evidence]), [
    ['CRM-10', 'CRM-30', 'fixup: b/three.patch'],
    ['CRM-20', 'CRM-30', 'fixup: b/one.patch, b/two.patch'],
  ]);
});

test('a split alias becomes a split draft, and anything the harvest already decides is left out', () => {
  const records = [
    record('CRM-1', { received: [{ from: 'CRM-2', patch: 'b/a.patch', note: null }, { from: 'CRM-3', patch: 'b/b.patch', note: null },
      { from: 'CRM-4', patch: 'b/c.patch', note: null }, { from: 'CRM-5', patch: 'b/d.patch', note: null }] }),
    record('ABC-57', { splitFrom: 'ABC-16' }),
    record('ABC-53', { splitFrom: 'ABC-17' }),
  ];
  const harvest = {
    ...HARVEST,
    edges: [{ from: 'CRM-2', to: 'CRM-1', kind: 'code', evidence: 'e' }],
    removals: [{ from: 'CRM-1', to: 'CRM-3', reason: 'r' }],
    rejected: [{ from: 'CRM-1', to: 'CRM-4', reason: 'r' }],
    splits: [{ parent: 'ABC-17', new: 'ABC-53', parentHalf: 'a', newHalf: 'b', evidence: 'e' }],
  };
  assert.deepEqual(draftFromRecords(records, harvest), {
    edges: [{ from: 'CRM-1', to: 'CRM-5', kind: 'code', evidence: 'fixup: b/d.patch', draft: true }],
    splits: [{ parent: 'ABC-16', new: 'ABC-57', evidence: 'alias.splitFrom: ABC-57 was split from ABC-16', draft: true }],
  });
});

test('drafts cannot enter a plan: pasted in with the draft flag, the harvest is invalid', () => {
  const records = [record('CRM-1', { received: [{ from: 'CRM-2', patch: 'b/a.patch', note: null }] }), record('CRM-9', { splitFrom: 'CRM-8' })];
  const drafts = draftFromRecords(records, HARVEST);
  assert.deepEqual(validateHarvest({ ...HARVEST, edges: drafts.edges, splits: drafts.splits }), [
    'edges[0] is a draft: confirm it by removing "draft": true',
    'splits[0] is a draft: confirm it by removing "draft": true',
  ]);
});

test('drafting the sample records finds ABC-1 blocks ABC-3 once and leaves every record file and object unchanged', () => {
  const files = readdirSync(SAMPLE).filter(f => f.endsWith('.json')).sort();
  const before = files.map(f => readFileSync(join(SAMPLE, f)));
  const { records } = readRecords(SAMPLE);
  const snapshot = structuredClone(records);
  const drafts = draftFromRecords(records, HARVEST);
  assert.deepEqual(records, snapshot);
  assert.deepEqual(files.map(f => readFileSync(join(SAMPLE, f))), before);
  assert.deepEqual(drafts.edges.map(e => [e.from, e.to]), [['ABC-1', 'ABC-3']]);
  assert.deepEqual(drafts.splits.map(s => [s.parent, s.new]), [['ABC-1', 'ABC-2'], ['ABC-2', 'ABC-4']]);
});

test('a fixup draft carries each fixup\'s note, so a repair of the earlier card\'s own patch can be told from a real dependency', () => {
  const records = [
    record('ABC-21', { received: [{ from: 'ABC-25', patch: 'backend/fixup-21-from-25-stale.patch', note: 'stale replay: re-applied ABC-21 on the rebuilt tree' }] }),
    record('ABC-25', { caused: [{ to: 'ABC-21', patch: 'backend/fixup-21-from-25-stale.patch', note: 'stale replay: re-applied ABC-21 on the rebuilt tree' }] }),
    record('CRM-7', { received: [{ from: 'CRM-8', patch: 'b/plain.patch', note: null }] }),
  ];
  const drafts = draftFromRecords(records, HARVEST);
  assert.deepEqual(drafts.edges.map(d => d.evidence), [
    'fixup: backend/fixup-21-from-25-stale.patch (note: "stale replay: re-applied ABC-21 on the rebuilt tree")',
    'fixup: b/plain.patch',
  ]);
});
