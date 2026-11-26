import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markers, textEdges } from '../scripts/lib/next/text.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const pairs = edges => edges.map(e => [e.from, e.to]).sort((a, b) => `${a}`.localeCompare(`${b}`));
const edgesOf = entries => pairs(textEdges(new Map(entries)));

test('each "depends on" phrase makes the named card block this one', () => {
  assert.deepEqual(edgesOf([['CRM-1', 'Depende de CRM-2. Necesita CRM-3, y espera a CRM-4. necesita CRM-5']]),
    [['CRM-2', 'CRM-1'], ['CRM-3', 'CRM-1'], ['CRM-4', 'CRM-1'], ['CRM-5', 'CRM-1']]);
});

test('each "blocks" phrase makes this card block the named one', () => {
  assert.deepEqual(edgesOf([['CRM-4', 'Esto bloquea CRM-5 y habilita CRM-6.\nGates: CRM-7']]),
    [['CRM-4', 'CRM-5'], ['CRM-4', 'CRM-6'], ['CRM-4', 'CRM-7']]);
});

test('several ids after one phrase each count', () => {
  assert.deepEqual(edgesOf([['CRM-1', 'Depende de CRM-2 y CRM-3'], ['CRM-9', 'Gates: CRM-4, CRM-5 / CRM-6']]),
    [['CRM-2', 'CRM-1'], ['CRM-3', 'CRM-1'], ['CRM-9', 'CRM-4'], ['CRM-9', 'CRM-5'], ['CRM-9', 'CRM-6']]);
});

test('a Linear issue tag counts as its label', () => {
  assert.deepEqual(edgesOf([['CRM-1', 'Depende de <issue id="u-9" label="CRM-9" title="x"/>']]), [['CRM-9', 'CRM-1']]);
});

test('prose without a phrase is no dependency, and a card naming itself is ignored', () => {
  assert.deepEqual(edgesOf([['CRM-1', 'Ver CRM-5, como en CRM-6. Depende de CRM-1']]), []);
});

test('the same dependency written twice, or on both cards, counts once', () => {
  assert.deepEqual(edgesOf([['CRM-1', 'Depende de CRM-2. Necesita CRM-2'], ['CRM-2', 'Habilita CRM-1']]), [['CRM-2', 'CRM-1']]);
});

test('markers read deferrable, No lleva PR and deployado en QA', () => {
  assert.deepEqual(markers('Carta elástica. No lleva PR. CRM-3 deployado en QA'), { deferrable: true, noPr: true, qaLive: ['CRM-3'], after: [] });
  assert.deepEqual(markers('Se puede diferir'), { deferrable: true, noPr: false, qaLive: [], after: [] });
  assert.deepEqual(markers('Diferido hasta enero'), { deferrable: true, noPr: false, qaLive: [], after: [] });
  assert.deepEqual(markers('Necesita CRM-8 deployado en QA y CRM-9 deployado en QA'), { deferrable: false, noPr: false, qaLive: ['CRM-8', 'CRM-9'], after: [] });
  assert.deepEqual(markers(''), { deferrable: false, noPr: false, qaLive: [], after: [] });
});

test('a Linear mention link or a bare Linear issue URL counts as its id', () => {
  assert.deepEqual(edgesOf([
    ['CRM-1', 'Depende de [CRM-8](https://linear.app/x/issue/CRM-8)'],
    ['CRM-2', 'Depende de [CRM-9](<https://linear.app/x/issue/CRM-9/some-title>)'],
    ['CRM-3', 'Necesita https://linear.app/x/issue/CRM-7/slug para seguir'],
  ]), [['CRM-7', 'CRM-3'], ['CRM-8', 'CRM-1'], ['CRM-9', 'CRM-2']]);
  assert.deepEqual(markers('[CRM-4](https://linear.app/x/issue/CRM-4) deployado en QA').qaLive, ['CRM-4']);
});

test('a negated phrase is no dependency', () => {
  assert.deepEqual(edgesOf([['CRM-1', 'No depende de CRM-2. no necesita CRM-3. Esto no bloquea CRM-4 ni habilita nada']]), []);
});
