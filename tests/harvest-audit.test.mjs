import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyPlan, undoRun } from '../scripts/lib/harvest-apply.mjs';
import {
  caseSource, computePlan, itemsToTranslate, normalizeDescription, renderNotesBlock, renderReview, textSource, validateHarvest,
} from '../scripts/lib/harvest.mjs';
import { fetchDescriptions, fetchProjectMap } from '../scripts/lib/linear-fetch.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

// A built card audited against its PR (made-up keys and text): c1, c2 and d1 moved to CRM-30, c4 to CRM-40; c3, d2, d3 hold.
const SLUG = 'c0ffee000001';
const KEY = 'lin_api_dummy_' + 'h'.repeat(30);
const NOW = new Date('2026-11-24T10:00:00.000Z');
const RUN = '20261122T100000Z';
const sha = text => createHash('sha256').update(text).digest('hex');

const mark = (verdict, card) => ({ verdict, ...(card ? { card } : {}), note: `why ${verdict}`, runId: RUN, at: '2026-11-24T09:00:00.000Z' });
const kase = (id, audit) => ({ id, given: `dado ${id}`, when: `cuando ${id}`, then: `entonces ${id}`, source: 'patch', ref: 'patch:a/b.patch', ...(audit ? { audit } : {}) });
const dec = (text, audit) => ({ text, ref: 'patch:a/b.patch', ...(audit ? { audit } : {}) });

const AUDITED = {
  card: 'CRM-20', archived: null, supersededBy: null,
  cases: [kase('c1', mark('moved', 'CRM-30')), kase('c2', mark('moved', 'CRM-30')), kase('c3', mark('holds')), kase('c4', mark('moved', 'CRM-40'))],
  decisions: [dec('Pictures by note id.', mark('moved', 'CRM-30')), dec('Letter files by position.', mark('holds')), dec('Reuse the page checks.', mark('holds'))],
  openDecisions: [],
};

const spanish = record => ({
  ...Object.fromEntries(record.cases.map(c => [c.id, { source: caseSource(c), es: `Caso ${c.id}.` }])),
  ...Object.fromEntries((record.decisions ?? []).map((d, i) => [`d${i + 1}`, { source: textSource(d), es: `Decisión d${i + 1}.` }])),
});

const AUDITED_BLOCK = [
  '+++ Notas del agente',
  '',
  '**Casos de aceptación**',
  '',
  '- **c3.** Caso c3.',
  '',
  '**Decisiones**',
  '',
  '- **d2.** Decisión d2.',
  '- **d3.** Decisión d3.',
  '',
  '+++',
].join('\n');

test('the notes block publishes only the items that hold, and says nothing of where a moved item went', () => {
  const block = renderNotesBlock(AUDITED, spanish(AUDITED));
  assert.equal(block, AUDITED_BLOCK);
  assert.doesNotMatch(block, /CRM-30|CRM-40|Movido/);
});

test('a not-built or dropped item is left out of the block, and an item with no audit holds', () => {
  const record = { card: 'CRM-21', cases: [kase('c1'), kase('c2', mark('not-built')), kase('c3', mark('dropped'))], decisions: [dec('Una.')] };
  assert.equal(renderNotesBlock(record, spanish(record)), [
    '+++ Notas del agente', '', '**Casos de aceptación**', '', '- **c1.** Caso c1.', '', '**Decisiones**', '', '- **d1.** Decisión d1.', '', '+++',
  ].join('\n'));
});

test('only the items that hold need a translation, and their ids stay as the record has them', () => {
  assert.deepEqual(itemsToTranslate([AUDITED], null, 'all').map(i => i.id), ['c3', 'd2', 'd3']);
  const translated = { schemaVersion: 1, cards: { 'CRM-20': spanish(AUDITED) } };
  assert.deepEqual(itemsToTranslate([AUDITED], translated, 'all'), []);
});

const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});

function world(descriptions = {}, keys = ['CRM-20', 'CRM-30', 'CRM-40']) {
  const issues = keys.map(k => ({ ...issue(k), relations: { nodes: [] }, inverseRelations: { nodes: [] } }));
  return {
    raw: { project: { id: 'project-uuid', slug: SLUG, name: 'Sample Project', url: 'u', teams: [{ id: 'team-crm', key: 'CRM' }] }, issues, milestones: [], warnings: [] },
    descriptions: new Map(issues.map(i => [i.identifier, { id: i.id, title: i.title, description: descriptions[i.identifier] ?? '', archivedAt: null }])),
  };
}

const NOTES = { schemaVersion: 1, cards: { 'CRM-20': spanish(AUDITED) } };
const plan = (harvest, w, extra = {}) =>
  computePlan({ harvest: { schemaVersion: 1, project: { slug: SLUG }, ...harvest }, records: [AUDITED], notes: NOTES, ...w, ...extra });

test('the notes op names the items that hold, the moved ones and where they went, and the ones left out', () => {
  const left = { ...AUDITED, cases: [...AUDITED.cases, kase('c5', mark('not-built')), kase('c6', mark('dropped'))] };
  const r = plan({ notes: ['CRM-20'] }, world({ 'CRM-20': 'Texto.' }), { records: [left] });
  assert.deepEqual(r.refusals, []);
  assert.equal(r.plan.ops[0].evidence, 'record CRM-20: c3, d2, d3; moved to CRM-30: c1, c2, d1; moved to CRM-40: c4; left out: c5 (not-built), c6 (dropped)');
  assert.equal(r.plan.ops[0].after.block, AUDITED_BLOCK);
});

test('the review shows under each notes block what it publishes, what moved and what it leaves out', () => {
  const left = { ...AUDITED, cases: [...AUDITED.cases, kase('c5', mark('not-built'))] };
  const md = renderReview(plan({ notes: ['CRM-20'] }, world({ 'CRM-20': 'Texto.' }), { records: [left] }).plan, { approveCommand: 'apply' });
  assert.ok(md.includes('### CRM-20: add the block\n\nrecord CRM-20: c3, d2, d3; moved to CRM-30: c1, c2, d1; moved to CRM-40: c4; left out: c5 (not-built)\n\n```text'), md);
});

test('a card where nothing holds any more has its frozen block removed, and with no block there is nothing to do', () => {
  const allMoved = { card: 'CRM-20', cases: [kase('c1', mark('moved', 'CRM-30')), kase('c2', mark('dropped'))], decisions: [] };
  const frozen = 'Texto.\n\n+++ Notas del agente\n\n- **c1.** vieja\n\n+++';
  const r = plan({ notes: 'all' }, world({ 'CRM-20': frozen }), { records: [allMoved], notes: null });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.map(op => [op.id, op.after.block, op.after.description]), [['notes:CRM-20', null, 'Texto.']]);
  assert.equal(r.plan.ops[0].evidence, 'moved to CRM-30: c1; left out: c2 (dropped)');
  assert.match(renderReview(r.plan, { approveCommand: 'apply' }), /### CRM-20: remove the block\n\nmoved to CRM-30: c1; left out: c2 \(dropped\)\n\n/);
  const none = plan({ notes: 'all' }, world({ 'CRM-20': 'Texto.' }), { records: [allMoved], notes: null });
  assert.deepEqual(none.plan.ops, []);
  assert.deepEqual(none.plan.noop, [{ id: 'notes:CRM-20', reason: 'no notes block to remove' }]);
});

test('a description entry for a card where nothing holds drops the frozen block in the same op', () => {
  const allMoved = { card: 'CRM-20', cases: [kase('c1', mark('moved', 'CRM-30'))], decisions: [] };
  const frozen = 'Vieja.\n\n+++ Notas del agente\n\n- **c1.** vieja\n\n+++';
  const r = plan({ notes: ['CRM-20'], descriptions: DESCRIBED }, world({ 'CRM-20': frozen }), { records: [allMoved], notes: null });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.map(op => [op.id, op.after.description]), [['description:CRM-20', DESCRIBED['CRM-20'].text]]);
});

test('a moved item that names another card asks for no order note: it is no longer published', () => {
  const naming = { card: 'CRM-20', cases: [kase('c1'), { ...kase('c2', mark('moved', 'CRM-30')), then: 'CRM-30 llama a esto' }], decisions: [] };
  const notes = { schemaVersion: 1, cards: { 'CRM-20': spanish(naming) } };
  const r = plan({ notes: ['CRM-20'], rejected: [{ from: 'CRM-20', to: 'CRM-30', reason: 'no shared code' }] }, world(), { records: [naming], notes });
  assert.deepEqual(r.refusals, []);
});

const DESCRIBED = { 'CRM-20': { text: 'Abrir archivos de cartas de un hilo por posición.', evidence: `audit ${RUN}: the picture half moved to CRM-30` } };

test('harvest.json takes descriptions: one entry per card with the new text and its evidence, and the text never holds a notes block', () => {
  const base = { schemaVersion: 1, project: { slug: SLUG } };
  assert.deepEqual(validateHarvest({ ...base, descriptions: DESCRIBED }), []);
  assert.deepEqual(validateHarvest({ ...base, descriptions: { 'CRM-20': { ...DESCRIBED['CRM-20'], hold: 'ask the owner' } } }), []);
  assert.deepEqual(validateHarvest({ ...base, descriptions: [] }), ['descriptions must be an object of card keys']);
  assert.deepEqual(validateHarvest({ ...base, descriptions: { nope: DESCRIBED['CRM-20'] } }), ['descriptions: nope is not a card key like CRM-123']);
  assert.deepEqual(validateHarvest({ ...base, descriptions: { 'CRM-20': { text: ' ' } } }), [
    'descriptions.CRM-20.text must be a non-empty string', 'descriptions.CRM-20.evidence must be a non-empty string',
  ]);
  assert.deepEqual(validateHarvest({ ...base, descriptions: { 'CRM-20': { ...DESCRIBED['CRM-20'], extra: 1 } } }), ['descriptions.CRM-20: unknown field extra']);
  assert.deepEqual(validateHarvest({ ...base, descriptions: { 'CRM-20': { ...DESCRIBED['CRM-20'], text: 'Texto.\n\n+++ Notas del agente\n\n+++' } } }),
    ['descriptions.CRM-20.text must hold no agent notes block and no +++ line']);
});

test('a description entry becomes one description.replace op that keeps the card\'s notes block', () => {
  const current = 'Abrir archivos de un hilo, con el bloqueo.\n\n+++ Notas del agente\n\n- **c1.** vieja\n\n+++';
  const r = plan({ descriptions: DESCRIBED }, world({ 'CRM-20': current }));
  assert.deepEqual(r.refusals, []);
  const description = 'Abrir archivos de cartas de un hilo por posición.\n\n+++ Notas del agente\n\n- **c1.** vieja\n\n+++';
  assert.deepEqual(r.plan.ops, [{
    id: 'description:CRM-20', type: 'description.replace', card: 'CRM-20', issueId: 'uuid-CRM-20', evidence: DESCRIBED['CRM-20'].evidence,
    before: { descriptionHash: sha(normalizeDescription(current)), description: current },
    after: { descriptionHash: sha(normalizeDescription(description)), description, notes: null },
  }]);
});

test('a card with both a description entry and notes gets one op carrying the new text and the new block', () => {
  const r = plan({ notes: ['CRM-20'], descriptions: DESCRIBED }, world({ 'CRM-20': 'Vieja.' }));
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.map(op => op.id), ['description:CRM-20']);
  const [op] = r.plan.ops;
  assert.equal(op.after.description, `${DESCRIBED['CRM-20'].text}\n\n${AUDITED_BLOCK}`);
  assert.equal(op.after.notes, 'record CRM-20: c3, d2, d3; moved to CRM-30: c1, c2, d1; moved to CRM-40: c4');
});

test('a description already current is a noop, a held one is held, and a card off the map or unread is a conflict', () => {
  const current = plan({ descriptions: DESCRIBED }, world({ 'CRM-20': DESCRIBED['CRM-20'].text }));
  assert.deepEqual(current.plan.ops, []);
  assert.deepEqual(current.plan.noop, [{ id: 'description:CRM-20', reason: 'description already current' }]);
  const held = plan({ descriptions: { 'CRM-20': { ...DESCRIBED['CRM-20'], hold: 'ask the owner' } } }, world({ 'CRM-20': 'Vieja.' }));
  assert.deepEqual(held.plan.ops, []);
  assert.deepEqual(held.plan.held, [{ id: 'description:CRM-20', hold: 'ask the owner', entry: { ...DESCRIBED['CRM-20'], hold: 'ask the owner' } }]);
  const off = plan({ descriptions: { 'CRM-99': DESCRIBED['CRM-20'] } }, world());
  assert.deepEqual(off.refusals.map(x => x.message), ['descriptions: CRM-99 is not a card of the project']);
  const w = world();
  w.descriptions.delete('CRM-20');
  assert.deepEqual(plan({ descriptions: DESCRIBED }, w).refusals.map(x => x.message), ['descriptions: the description of CRM-20 was not read; plan again']);
});

test('a description that holds a keiron-sequencer marker keeps it', () => {
  const current = 'Vieja.\n\n<!-- keiron-sequencer:roles -->';
  const [op] = plan({ descriptions: DESCRIBED }, world({ 'CRM-20': current })).plan.ops;
  assert.equal(op.after.description, `${DESCRIBED['CRM-20'].text}\n\n<!-- keiron-sequencer:roles -->`);
});

test('the review shows each description with its text before and after', () => {
  const r = plan({ descriptions: DESCRIBED }, world({ 'CRM-20': 'Vieja.' }));
  const md = renderReview(r.plan, { approveCommand: 'apply' });
  assert.match(md, /## Descriptions\n\n### CRM-20: replace the description\n\naudit 20261122T100000Z: the picture half moved to CRM-30\n\nBefore:\n\n```text\nVieja.\n```\n\nAfter:\n\n```text\nAbrir archivos de cartas de un hilo por posición.\n```/);
});

async function livePlan(fake, harvest) {
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl: fake.fetchImpl });
  const descriptions = await fetchDescriptions(raw.project.id, KEY, { fetchImpl: fake.fetchImpl });
  const r = computePlan({ harvest: { schemaVersion: 1, project: { slug: SLUG }, ...harvest }, records: [AUDITED], notes: NOTES, raw, descriptions });
  assert.deepEqual(r.refusals, []);
  return r.plan;
}

const store = () => fakeLinearStore({ issues: ['CRM-20', 'CRM-30', 'CRM-40'].map(k => issue(k, k === 'CRM-20' ? { description: 'Vieja.' } : {})), milestones: [] });

test('apply writes the description op after the notes, reads it back, and undo lists the old description to restore by hand', async () => {
  const fake = store();
  const p = await livePlan(fake, { descriptions: DESCRIBED });
  const logged = [];
  const r = await applyPlan(p, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: l => logged.push(l), sleep: async () => {} });
  assert.equal(r.code, 0, r.messages?.join('\n'));
  assert.deepEqual(fake.mutations.map(m => m.name), ['DescriptionUpdate']);
  assert.equal(fake.store.issues.find(i => i.identifier === 'CRM-20').description, DESCRIBED['CRM-20'].text);
  assert.deepEqual(logged.map(l => [l.op, l.type, l.result, l.before?.description]), [['description:CRM-20', 'description.replace', 'applied', 'Vieja.']]);
  const listed = await undoRun(logged, logged[0].run, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: () => {} });
  assert.deepEqual(listed.results, [{
    op: 'description:CRM-20', type: 'description.replace', result: 'manual',
    action: 'restore the description of CRM-20 by hand from description', description: 'Vieja.',
  }]);
});

test('a description edited in Linear since the plan is drift, and nothing is written', async () => {
  const fake = store();
  const p = await livePlan(fake, { descriptions: DESCRIBED });
  fake.store.issues.find(i => i.identifier === 'CRM-20').description = 'Editada a mano.';
  const r = await applyPlan(p, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: () => {}, sleep: async () => {} });
  assert.equal(r.code, 6);
  assert.equal(fake.mutations.length, 0);
  assert.match(r.messages.join('\n'), /the description of CRM-20 changed since the plan/);
});
