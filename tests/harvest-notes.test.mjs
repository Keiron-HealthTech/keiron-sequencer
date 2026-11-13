import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTES_TITLE, caseSource, itemsToTranslate, normalizeDescription, renderNotesBlock, replaceNotesBlock, textSource, validateNotes,
} from '../scripts/lib/harvest.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const c = (id, then = `then ${id}`) => ({ id, given: `given ${id}`, when: `when ${id}`, then, source: 'patch', ref: 'patch:a/b.patch' });
const record = (card, cases, over = {}) => ({ card, cases, archived: null, supersededBy: null, ...over });

test('a case source is the first 12 hex of a hash over given, when and then only', () => {
  const one = caseSource(c('c1'));
  assert.match(one, /^[0-9a-f]{12}$/);
  assert.equal(caseSource({ then: 'then c1', when: 'when c1', given: 'given c1' }), one);
  assert.equal(caseSource({ ...c('c1'), id: 'c9', source: 'linear', ref: 'linear:CRM-1' }), one);
  assert.notEqual(caseSource(c('c1', 'then something else')), one);
});

test('itemsToTranslate lists the missing and the stale cases of live records, in card and case order', () => {
  const records = [
    record('CRM-10', [c('c10'), c('c2')]),
    record('CRM-9', [c('c1')]),
    record('CRM-11', [c('c1')], { archived: { at: '2026-11-01', reason: 'gone' } }),
    record('CRM-12', [c('c1')], { supersededBy: { card: 'CRM-13', spikedAt: '2026-11-01T00:00:00Z' } }),
  ];
  const notes = { schemaVersion: 1, cards: {
    'CRM-9': { c1: { source: caseSource(c('c1')), es: 'al día' } },
    'CRM-10': { c2: { source: '000000000000', es: 'vieja' } },
  } };
  assert.deepEqual(itemsToTranslate(records, notes, 'all'), [
    { card: 'CRM-10', id: 'c2', kind: 'case', source: caseSource(c('c2')), given: 'given c2', when: 'when c2', then: 'then c2', status: 'stale' },
    { card: 'CRM-10', id: 'c10', kind: 'case', source: caseSource(c('c10')), given: 'given c10', when: 'when c10', then: 'then c10', status: 'missing' },
  ]);
  assert.deepEqual(itemsToTranslate(records, notes, ['CRM-9']), []);
  assert.deepEqual(itemsToTranslate(records, null, ['CRM-9']).map(x => [x.card, x.id, x.status]), [['CRM-9', 'c1', 'missing']]);
});

const BLOCK = [
  '+++ Notas del agente',
  '',
  '**Casos de aceptación**',
  '',
  '- **c1.** Dado uno, cuando dos, entonces tres.',
  '- **c2.** Dado cuatro, cuando cinco, entonces seis.',
  '',
  '+++',
].join('\n');

test('the notes block has the literal header, one bullet per case in case order, and a closing +++', () => {
  assert.equal(NOTES_TITLE, 'Notas del agente');
  const notesForCard = {
    c2: { source: 'x', es: 'Dado cuatro, cuando cinco, entonces seis.' },
    c1: { source: 'x', es: 'Dado uno, cuando dos, entonces tres.' },
  };
  assert.equal(renderNotesBlock({ cases: [c('c2'), c('c1')] }, notesForCard), BLOCK);
  assert.throws(() => renderNotesBlock({ cases: [c('c3')] }, notesForCard), /c3/);
});

test('the block renders the three sections in Spanish', () => {
  const record = {
    cases: [c('c1')],
    decisions: [d('Keep one file.')],
    openDecisions: [
      { text: 'Who sees it.', impact: 'design', owner: 'people' },
      { text: 'Which phone wins.', impact: 'design', owner: 'code', status: 'narrowed' },
      { text: 'Which log level.', impact: 'detail', owner: 'code' },
      { text: 'Retention period.', impact: 'design', owner: 'people', status: 'narrowed' },
    ],
  };
  const es = { c1: 'Caso uno.', d1: 'Un solo archivo.', o1: 'Quién lo ve.', o2: 'Qué teléfono gana.', o3: 'Qué nivel de log.', o4: 'Plazo de retención.' };
  const notesForCard = Object.fromEntries(Object.entries(es).map(([id, text]) => [id, { source: 'x', es: text }]));
  assert.equal(renderNotesBlock(record, notesForCard), [
    '+++ Notas del agente', '',
    '**Casos de aceptación**', '', '- **c1.** Caso uno.', '',
    '**Decisiones**', '', '- **d1.** Un solo archivo.', '',
    '**Decisiones abiertas**', '',
    '- **o1.** Quién lo ve. (abierta, la deciden personas)',
    '- **o2.** Qué teléfono gana. (acotada)',
    '- **o3.** Qué nivel de log.',
    '- **o4.** Plazo de retención. (acotada, la deciden personas)',
    '', '+++',
  ].join('\n'));
  assert.throws(() => renderNotesBlock(record, { ...notesForCard, d1: undefined }), /d1/);
});

test('a legacy-titled block is replaced, not duplicated', () => {
  const legacy = '+++ Notas del agente (casos de aceptación)\n\n- **c1.** vieja\n\n+++';
  const r = replaceNotesBlock(`Arriba.\n\n${legacy}\n\nAbajo.`, BLOCK);
  assert.equal(r.description, `Arriba.\n\n${BLOCK}\n\nAbajo.`);
  assert.equal(r.before, legacy);
  assert.equal(r.count, 1);
  assert.equal(replaceNotesBlock(`${legacy}\n\n${BLOCK}`, BLOCK).count, 2);
});

test('an existing block is replaced in place and every byte around it is kept', () => {
  const above = 'Texto humano arriba.\r\n* viñeta  \n';
  const stale = '+++ Notas del agente  \n\n- **c1.** vieja\n\n+++';
  const below = '\n\nTexto humano abajo.\n';
  const r = replaceNotesBlock(`${above}${stale}${below}`, BLOCK);
  assert.equal(r.description, `${above}${BLOCK}${below}`);
  assert.equal(r.before, stale);
  assert.equal(r.count, 1);
});

test('with no block the new one is appended after a blank line, and a second pass changes nothing', () => {
  const first = replaceNotesBlock('Texto humano.\n', BLOCK);
  assert.deepEqual(first, { description: `Texto humano.\n\n${BLOCK}`, before: null, count: 0 });
  const second = replaceNotesBlock(first.description, BLOCK);
  assert.deepEqual(second, { description: first.description, before: BLOCK, count: 1 });
  assert.deepEqual(replaceNotesBlock('', BLOCK), { description: BLOCK, before: null, count: 0 });
});

test('a block under another heading is left alone, and two notes blocks are counted, not touched', () => {
  const other = 'Intro\n\n+++ Agent notes\n\n- keep me\n\n+++';
  assert.equal(replaceNotesBlock(other, BLOCK).description, `${other}\n\n${BLOCK}`);
  const twice = `${BLOCK}\n\nmedio\n\n${BLOCK}`;
  assert.deepEqual(replaceNotesBlock(twice, BLOCK), { description: twice, before: null, count: 2 });
});

test('normalizeDescription turns CRLF into LF, strips line ends, turns star bullets into dashes and trims the end', () => {
  assert.equal(normalizeDescription('a  \r\n* b\r\n  * c\t\n*no\n\n\n'), 'a\n- b\n  - c\n*no');
  assert.equal(normalizeDescription(null), '');
});

test('a notes header with no closing +++ is reported as unterminated and the description is left untouched', () => {
  const broken = 'Intro\n\n+++ Notas del agente (casos de aceptación)\n\n- **c1.** sin cierre\n\nTexto humano después.';
  assert.deepEqual(replaceNotesBlock(broken, BLOCK), { description: broken, before: null, count: 1, unterminated: true });
});

const d = text => ({ text, ref: 'linear:CRM-1' });

test('itemsToTranslate lists missing decision and open-decision translations', () => {
  const records = [record('CRM-1', [c('c1')], { decisions: [d('Keep one file.')], openDecisions: [{ text: 'Who sees it.', impact: 'design', owner: 'people' }] })];
  const notes = { schemaVersion: 1, cards: { 'CRM-1': { c1: { source: caseSource(c('c1')), es: 'Caso.' } } } };
  assert.deepEqual(itemsToTranslate(records, notes, 'all'), [
    { card: 'CRM-1', id: 'd1', kind: 'decision', source: textSource(d('Keep one file.')), text: 'Keep one file.', status: 'missing' },
    { card: 'CRM-1', id: 'o1', kind: 'openDecision', source: textSource({ text: 'Who sees it.' }), text: 'Who sees it.', status: 'missing' },
  ]);
  const full = { schemaVersion: 1, cards: { 'CRM-1': {
    c1: { source: caseSource(c('c1')), es: 'Caso.' }, d1: { source: textSource(d('Keep one file.')), es: 'Un archivo.' }, o1: { source: textSource({ text: 'Who sees it.' }), es: 'Quién lo ve.' },
  } } };
  assert.deepEqual(itemsToTranslate(records, full, 'all'), []);
  assert.deepEqual(validateNotes(full), []);
  assert.ok(validateNotes({ schemaVersion: 1, cards: { 'CRM-1': { x1: { source: 'aaaaaaaaaaaa', es: 'x' } } } }).some(e => /x1/.test(e)));
  const withCaseMissing = itemsToTranslate([record('CRM-2', [c('c1')])], null, 'all');
  assert.deepEqual(withCaseMissing.map(i => [i.id, i.kind, i.given]), [['c1', 'case', 'given c1']]);
});

test('a reordered decision list marks the moved items stale', () => {
  const before = record('CRM-1', [c('c1')], { decisions: [d('First.'), d('Second.')] });
  const notes = { schemaVersion: 1, cards: { 'CRM-1': {
    c1: { source: caseSource(c('c1')), es: 'Caso.' }, d1: { source: textSource(d('First.')), es: 'Primera.' }, d2: { source: textSource(d('Second.')), es: 'Segunda.' },
  } } };
  assert.deepEqual(itemsToTranslate([before], notes, 'all'), []);
  const after = { ...before, decisions: [d('Second.'), d('First.')] };
  assert.deepEqual(itemsToTranslate([after], notes, 'all').map(i => [i.id, i.text, i.status]), [['d1', 'Second.', 'stale'], ['d2', 'First.', 'stale']]);
});
