import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { draftPack, packPath, packStale, readPack, validatePack, writePack } from '../scripts/lib/packs.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-packs-');
after(() => rmSync(DIR, { recursive: true, force: true }));

const BASE = { backend: 'a'.repeat(40), web: 'c'.repeat(40) };
const issue = (description = 'Do the thing.') => ({ identifier: 'CRM-1', description });
const record = (openDecisions, over = {}) => ({
  card: 'CRM-1', spikedAt: '2026-11-11T10:00:00.000Z', refs: { patches: [], runId: '20261111T100000Z' }, openDecisions, ...over,
});
const OPEN = [
  { text: 'Who may see a customer record without a grant.', impact: 'design', owner: 'people', status: 'open' },
  { text: 'Which phone number wins.', impact: 'design', owner: 'people', status: 'narrowed', eliminated: [{ option: 'drop the override', why: 'the frontend passes selectedPhone' }] },
  { text: 'Which index to add.', impact: 'design', owner: 'code' },
  { text: 'Untagged, from an old record.' },
];

test('draftPack takes only people-owned open or narrowed decisions', () => {
  const pack = draftPack(record(OPEN), issue(), BASE);
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.card, 'CRM-1');
  assert.deepEqual(pack.questions.map(q => [q.id, q.text]), [
    ['q1', 'Who may see a customer record without a grant.'],
    ['q2', 'Which phone number wins.'],
    ['q3', 'Untagged, from an old record.'],
  ]);
  assert.deepEqual(pack.questions[1].evidence, ['ruled out: drop the override (the frontend passes selectedPhone)']);
  assert.ok(pack.questions.every(q => q.owner === 'people' && q.answer === null && Array.isArray(q.options)));
  assert.deepEqual(Object.keys(pack.stamp), ['descriptionHash', 'recordSpikedAt', 'runId', 'bases']);
  assert.deepEqual([pack.stamp.recordSpikedAt, pack.stamp.runId, pack.stamp.bases], ['2026-11-11T10:00:00.000Z', '20261111T100000Z', BASE]);
  assert.deepEqual(validatePack(pack), []);
  assert.equal(draftPack(record([OPEN[2]]), issue(), BASE).questions.length, 0);
});

test('packStale names what changed', () => {
  const r = record(OPEN);
  const pack = draftPack(r, issue(), BASE);
  assert.equal(packStale(pack, { issue: issue(), record: r, bases: BASE }), null);
  const notes = 'Do the thing.\n\n+++ Notas del agente\n\n**Casos de aceptación**\n\n- **c1.** Caso.\n\n+++';
  assert.equal(packStale(pack, { issue: issue(notes), record: r, bases: BASE }), null, 'the agent notes block is not card text');
  assert.equal(packStale(pack, { issue: issue('Do another thing.'), record: r, bases: BASE }), 'card-text');
  assert.equal(packStale(pack, { issue: issue(), record: { ...r, spikedAt: '2026-11-12T10:00:00.000Z' }, bases: BASE }), 'record');
  assert.equal(packStale(pack, { issue: issue(), record: r, bases: { backend: 'b'.repeat(40) } }), 'base');
  assert.equal(packStale(pack, { issue: issue(), record: r, bases: { web: BASE.web } }), null, 'a start from the second repo compares that repo only');
  assert.equal(packStale(pack, { issue: issue(), record: r, bases: { tools: 'b'.repeat(40) } }), null, 'a repo the pack never stamped is not a change');
  assert.equal(packStale(pack, { issue: issue(), record: r, bases: {} }), null, 'an unknown base is not a change');
});

test('validatePack refuses an answer without outcome', () => {
  const pack = draftPack(record(OPEN), issue(), BASE);
  pack.questions[0].answer = { answeredAt: '2026-11-12T10:00:00.000Z' };
  assert.ok(validatePack(pack).includes('questions[0].answer.outcome: expected non-empty string'), validatePack(pack).join('; '));
  pack.questions[0].answer = { outcome: 'No customer record reaches a user without a grant.', answeredAt: '2026-11-12T10:00:00.000Z' };
  assert.deepEqual(validatePack(pack), []);
  assert.ok(validatePack({ ...pack, schemaVersion: 2 }).some(e => /schemaVersion/.test(e)));
  assert.ok(validatePack({ ...pack, questions: [{ ...pack.questions[0], owner: 'code' }] }).some(e => /owner/.test(e)));
});

test('a pack is written to <home>/<slug>/packs/<CARD>.json and read back', () => {
  const pack = draftPack(record(OPEN), issue(), BASE);
  writePack(DIR, 'p1', pack);
  assert.equal(packPath(DIR, 'p1', 'CRM-1'), `${DIR}/p1/packs/CRM-1.json`);
  assert.deepEqual(readPack(DIR, 'p1', 'CRM-1'), pack);
  assert.equal(readPack(DIR, 'p1', 'CRM-2'), null);
});
