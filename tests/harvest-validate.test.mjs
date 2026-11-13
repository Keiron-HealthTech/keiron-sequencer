import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES_SCHEMA, validateHarvest, validateNotes } from '../scripts/lib/harvest.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const VALID = {
  schemaVersion: 1,
  project: { slug: 'c0ffee000001' },
  edges: [
    { from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: 'fixup: a/b.patch', ref: 'fixup: a/b.patch' },
    { from: 'CRM-2', to: 'CRM-3', kind: 'deploy', evidence: 'deploy order', hold: null },
    { from: 'CRM-3', to: 'new:roles-users', kind: 'gate', evidence: 'gate', hold: 'pending' },
  ],
  removals: [{ from: 'CRM-4', to: 'CRM-5', reason: 'no shared code' }],
  splits: [{ parent: 'CRM-6', new: 'new:roles-users', parentHalf: '6b', newHalf: '6a', evidence: 'split notes' }],
  newCards: [{
    key: 'roles-users', title: 'Roles y usuarios', repo: 'example-auth', milestone: 'M1', team: 'CRM',
    description: 'Descripción', evidence: 'fixup: sample.patch', blocks: ['CRM-7'], hold: null,
  }],
  rejected: [{ from: 'CRM-8', to: 'CRM-9', reason: 'fixup only' }],
  notes: 'all',
};

const withList = (name, list) => ({ ...VALID, [name]: list });
const edge = over => ({ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: 'e', ...over });

test('a file with one edge per kind and every list filled is valid; every list is optional', () => {
  assert.deepEqual(validateHarvest(VALID), []);
  assert.deepEqual(validateHarvest({ schemaVersion: 1, project: { slug: 'c0ffee000001' } }), []);
  assert.deepEqual(validateHarvest({ ...VALID, notes: ['CRM-1', 'CRM-2'] }), []);
});

test('a kind outside code, deploy and gate is rejected naming the entry and the allowed kinds', () => {
  assert.deepEqual(validateHarvest(withList('edges', [edge({ kind: 'build' })])), ['edges[0].kind must be one of code, deploy, gate']);
});

test('empty or blank evidence and reasons are rejected', () => {
  assert.deepEqual(validateHarvest(withList('edges', [edge({ evidence: '   ' })])), ['edges[0].evidence must be a non-empty string']);
  assert.deepEqual(validateHarvest(withList('removals', [{ from: 'CRM-1', to: 'CRM-2', reason: '' }])), ['removals[0].reason must be a non-empty string']);
  assert.deepEqual(validateHarvest(withList('rejected', [{ from: 'CRM-1', to: 'CRM-2' }])), ['rejected[0].reason must be a non-empty string']);
  const card = { ...VALID.newCards[0], evidence: ' ' };
  assert.deepEqual(validateHarvest({ ...VALID, newCards: [card] }), ['newCards[0].evidence must be a non-empty string']);
});

test('an unknown field, top-level or in an entry, is rejected as a typo', () => {
  assert.deepEqual(validateHarvest({ ...VALID, edgs: [] }), ['unknown top-level field edgs']);
  assert.deepEqual(validateHarvest(withList('edges', [{ ...edge(), evidnce: 'x' }])), ['edges[0]: unknown field evidnce']);
  assert.deepEqual(validateHarvest({ ...VALID, project: { slug: 'c0ffee000001', nme: 'x' } }), ['project: unknown field nme']);
});

test('malformed card keys and placeholders, and placeholders missing from newCards, are rejected', () => {
  assert.deepEqual(validateHarvest(withList('edges', [edge({ from: 'crm-1' }), edge({ to: 'new:Bad Key' }), edge({ to: 'new:ghost' })])), [
    'edges[0].from must be a card key like CRM-123 or new:<key>',
    'edges[1].to must be a card key like CRM-123 or new:<key>',
    'edges[2].to names new:ghost, which is not in newCards',
  ]);
  const card = { ...VALID.newCards[0], key: 'CRM-9' };
  assert.deepEqual(validateHarvest({ ...VALID, newCards: [card], edges: [], splits: [] }),
    ['newCards[0].key must be lowercase letters, digits and dashes, like roles-users']);
});

test('self-edges and repeated entries are rejected', () => {
  assert.deepEqual(validateHarvest(withList('edges', [edge({ to: 'CRM-1' })])), ['edges[0] is a self-edge (CRM-1>CRM-1)']);
  assert.deepEqual(validateHarvest(withList('edges', [edge(), edge({ evidence: 'other' })])), ['edges[1] repeats edges[0] (CRM-1>CRM-2)']);
  assert.deepEqual(validateHarvest(withList('removals', [{ from: 'CRM-1', to: 'CRM-2', reason: 'r' }, { from: 'CRM-1', to: 'CRM-2', reason: 's' }])),
    ['removals[1] repeats removals[0] (CRM-1>CRM-2)']);
  const card = VALID.newCards[0];
  assert.deepEqual(validateHarvest({ ...VALID, newCards: [card, { ...card }] }), ['newCards[1].key repeats newCards[0] (roles-users)']);
  assert.deepEqual(validateHarvest({ ...VALID, newCards: [{ ...card, blocks: ['new:roles-users'] }] }),
    ['newCards[0].blocks[0] is a self-edge (new:roles-users>new:roles-users)']);
});

test('a draft entry is rejected until the draft flag is dropped', () => {
  assert.deepEqual(validateHarvest(withList('edges', [edge({ draft: true })])),
    ['edges[0] is a draft: confirm it by removing "draft": true']);
  assert.deepEqual(validateHarvest(withList('splits', [{ ...VALID.splits[0], draft: true }])),
    ['splits[0] is a draft: confirm it by removing "draft": true']);
});

test('a split names an existing card key or a declared placeholder, and both half labels', () => {
  assert.deepEqual(validateHarvest(withList('splits', [{ parent: 'CRM-6', new: 'new:ghost', parentHalf: '6b', newHalf: '6a', evidence: 'e' }])),
    ['splits[0].new names new:ghost, which is not in newCards']);
  assert.deepEqual(validateHarvest(withList('splits', [{ parent: 'new:roles-users', new: 'CRM-7', parentHalf: '', newHalf: '6a', evidence: 'e' }])), [
    'splits[0].parent must be a card key like CRM-123',
    'splits[0].parentHalf must be a non-empty string',
  ]);
});

test('hold is a non-empty string or null, team is a string, and notes is "all" or a list of card keys', () => {
  assert.deepEqual(validateHarvest(withList('edges', [edge({ hold: 1 }), edge({ to: 'CRM-3', hold: '' })])), [
    'edges[0].hold must be a non-empty string or null',
    'edges[1].hold must be a non-empty string or null',
  ]);
  assert.deepEqual(validateHarvest({ ...VALID, newCards: [{ ...VALID.newCards[0], team: 5 }] }), ['newCards[0].team must be a non-empty string']);
  assert.deepEqual(validateHarvest({ ...VALID, notes: 'some' }), ['notes must be "all" or a list of card keys']);
  assert.deepEqual(validateHarvest({ ...VALID, notes: ['crm-1'] }), ['notes must be "all" or a list of card keys']);
  assert.deepEqual(validateHarvest({ ...VALID, edges: {} }), ['edges must be a list']);
});

test('every error comes back in one run, one line each, with the entry index', () => {
  const errors = validateHarvest({
    ...VALID,
    edges: [edge({ kind: 'build' }), VALID.edges[1], edge({ from: 'CRM-5', to: 'CRM-6', evidence: '' })],
    removals: [{ from: 'CRM-1', to: 'CRM-1', reason: 'r' }],
  });
  assert.deepEqual(errors, [
    'edges[0].kind must be one of code, deploy, gate',
    'edges[2].evidence must be a non-empty string',
    'removals[0] is a self-edge (CRM-1>CRM-1)',
  ]);
  for (const e of errors) assert.doesNotMatch(e, /\n/);
  assert.deepEqual(validateHarvest(null), ['harvest.json must be a JSON object']);
  assert.deepEqual(validateHarvest({ ...VALID, schemaVersion: 2 }), ['schemaVersion must be 1']);
});

const NOTES = {
  schemaVersion: 1,
  cards: { 'CRM-1': { c1: { source: '0123456789ab', es: 'Dado un usuario, cuando entra, entonces ve su tablero.' } } },
};
const withEs = es => ({ ...NOTES, cards: { 'CRM-1': { c1: { source: '0123456789ab', es } } } });

test('notes.es.json holds one-line Spanish text per card and case, with a 12-hex source', () => {
  assert.equal(NOTES_SCHEMA, 1);
  assert.deepEqual(validateNotes(NOTES), []);
  assert.deepEqual(validateNotes({ schemaVersion: 1, cards: {} }), []);
  assert.deepEqual(validateNotes(null), ['notes.es.json must be a JSON object']);
  assert.deepEqual(validateNotes({ ...NOTES, extra: 1 }), ['unknown top-level field extra']);
  assert.deepEqual(validateNotes({ ...NOTES, cards: { 'crm-1': {} } }), ['cards.crm-1 must be a card key like CRM-123']);
  assert.deepEqual(validateNotes({ ...NOTES, cards: { 'CRM-1': { case1: NOTES.cards['CRM-1'].c1 } } }),
    ['cards.CRM-1.case1 must be an item id like c1, d1 or o1']);
  assert.deepEqual(validateNotes({ ...NOTES, cards: { 'CRM-1': { c1: { source: 'xyz', es: 'ok', en: 'x' } } } }), [
    'cards.CRM-1.c1: unknown field en',
    'cards.CRM-1.c1.source must be 12 hex characters',
  ]);
});

test('the Spanish text is one non-empty line, never a heading, never +++', () => {
  assert.deepEqual(validateNotes(withEs('')), ['cards.CRM-1.c1.es must be a non-empty string']);
  assert.deepEqual(validateNotes(withEs('línea uno\nlínea dos')), ['cards.CRM-1.c1.es must be one line']);
  assert.deepEqual(validateNotes(withEs('## Título')), ['cards.CRM-1.c1.es must not be a heading']);
  assert.deepEqual(validateNotes(withEs('cierra con +++')), ['cards.CRM-1.c1.es must not contain +++']);
});

test('an order note on a rejected or removed pair is one non-empty line with no +++', () => {
  const entry = order => ({ from: 'CRM-1', to: 'CRM-2', reason: 'r', order });
  assert.deepEqual(validateHarvest(withList('rejected', [entry('Si CRM-1 llega primero, CRM-2 lo usa.')])), []);
  assert.deepEqual(validateHarvest(withList('removals', [entry('La que llegue segunda ajusta el spec.')])), []);
  assert.deepEqual(validateHarvest(withList('rejected', [entry('')])), ['rejected[0].order must be a non-empty string']);
  assert.deepEqual(validateHarvest(withList('removals', [entry('una\ndos')])), ['removals[0].order must be one line with no +++']);
  assert.deepEqual(validateHarvest(withList('rejected', [entry('a +++ b')])), ['rejected[0].order must be one line with no +++']);
});
