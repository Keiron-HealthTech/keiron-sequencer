import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, undoRun } from '../scripts/lib/harvest-apply.mjs';
import { caseSource, computePlan } from '../scripts/lib/harvest.mjs';
import { fetchDescriptions, fetchProjectMap } from '../scripts/lib/linear-fetch.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'u'.repeat(30);
const SLUG = 'c0ffee000001';
const NOW = new Date('2026-11-09T10:00:00.000Z');
const LATER = new Date('2026-11-09T11:00:00.000Z');

const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});
const world = (over = {}) => fakeLinearStore({
  issues: [
    issue('CRM-1'), issue('CRM-2'),
    issue('CRM-3', { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-4' } }] } }), issue('CRM-4'),
    issue('CRM-5', { description: 'Texto humano.' }),
  ],
  milestones: [{ id: 'm1', name: 'M1', sortOrder: 1 }],
  ...over,
});
const kase = id => ({ id, given: `dado ${id}`, when: `cuando ${id}`, then: `entonces ${id}`, source: 'patch', ref: 'patch:a/b.patch' });
const RECORDS = [{ card: 'CRM-5', cases: [kase('c1')], archived: null, supersededBy: null }];
const NOTES = { schemaVersion: 1, cards: { 'CRM-5': { c1: { source: caseSource(kase('c1')), es: 'Caso c1.' } } } };
const HARVEST = {
  schemaVersion: 1, project: { slug: SLUG },
  edges: [{ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: 'shared module' }],
  removals: [{ from: 'CRM-3', to: 'CRM-4', reason: 'no shared code' }],
  newCards: [{ key: 'roles', title: 'Roles y usuarios', repo: 'example-auth', milestone: 'M1', description: 'D.', evidence: 'e', blocks: ['CRM-2'] }],
  notes: ['CRM-5'],
};

async function appliedRun() {
  const fake = world();
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl: fake.fetchImpl });
  const descriptions = await fetchDescriptions(raw.project.id, KEY, { fetchImpl: fake.fetchImpl });
  const { plan } = computePlan({ harvest: HARVEST, records: RECORDS, notes: NOTES, raw, descriptions });
  const entries = [];
  const r = await applyPlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: l => entries.push(l) });
  assert.equal(r.code, 0, r.messages.join('\n'));
  return { fake, entries, runId: entries[0].run, sentAfterApply: fake.sent.length, mutationsAfterApply: fake.mutations.length };
}

const undo = (entries, runId, fake, { execute = false, logged = [] } = {}) =>
  undoRun(entries, runId, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => LATER, appendLog: l => logged.push(l), execute });

test('undo is a dry listing by default: no request, nothing logged, one action per change in reverse order', async () => {
  const { fake, entries, runId, sentAfterApply } = await appliedRun();
  const logged = [];
  const r = await undo(entries, runId, fake, { logged });
  assert.equal(r.code, 0);
  assert.equal(fake.sent.length, sentAfterApply);
  assert.deepEqual(logged, []);
  assert.deepEqual(r.results.map(x => [x.op, x.result, x.action]), [
    ['notes:CRM-5', 'manual', 'remove the agent notes block from CRM-5 by hand; it had none before this run'],
    ['rel-:CRM-3>CRM-4', 'listed', 'recreate CRM-3 blocks CRM-4'],
    ['rel+:new:roles>CRM-2', 'listed', 'delete relation rel-3: CRM-6 blocks CRM-2'],
    ['rel+:CRM-1>CRM-2', 'listed', 'delete relation rel-2: CRM-1 blocks CRM-2'],
    ['card:roles', 'manual', 'archive CRM-6 by hand; a created card cannot be undone'],
  ]);
});

test('undo with execute deletes the created relations in reverse order, recreates the removed pair, and logs undone lines', async () => {
  const { fake, entries, runId, mutationsAfterApply } = await appliedRun();
  const logged = [];
  const r = await undo(entries, runId, fake, { execute: true, logged });
  assert.equal(r.code, 0, r.messages.join('\n'));
  assert.deepEqual(fake.mutations.slice(mutationsAfterApply).map(m => [m.name, m.variables]), [
    ['RelationCreate', { blocker: 'uuid-CRM-3', blocked: 'uuid-CRM-4' }],
    ['RelationDelete', { id: 'rel-3' }],
    ['RelationDelete', { id: 'rel-2' }],
  ]);
  assert.deepEqual(fake.store.relations.map(x => `${x.from}>${x.to}`), ['CRM-3>CRM-4']);
  assert.deepEqual(logged.map(l => [l.op, l.result, l.undo]), [
    ['rel-:CRM-3>CRM-4', 'undone', true], ['rel+:new:roles>CRM-2', 'undone', true], ['rel+:CRM-1>CRM-2', 'undone', true],
  ]);
  assert.equal(logged[0].run, runId);
  assert.equal(logged[0].at, LATER.toISOString());
  assert.deepEqual(r.results.filter(x => x.result === 'manual').map(x => x.op), ['notes:CRM-5', 'card:roles']);
});

test('undo skips a relation already deleted by hand and a removed pair already back, and a second undo writes nothing', async () => {
  const { fake, entries, runId, mutationsAfterApply } = await appliedRun();
  fake.store.relations.splice(fake.store.relations.findIndex(x => x.id === 'rel-2'), 1);
  fake.store.relations.push({ id: 'rel-hand', type: 'blocks', from: 'CRM-3', to: 'CRM-4' });
  const logged = [];
  const r = await undo(entries, runId, fake, { execute: true, logged });
  assert.equal(r.code, 0, r.messages.join('\n'));
  assert.deepEqual(logged.map(l => [l.op, l.result]), [
    ['rel-:CRM-3>CRM-4', 'skipped'], ['rel+:new:roles>CRM-2', 'undone'], ['rel+:CRM-1>CRM-2', 'skipped'],
  ]);
  assert.deepEqual(fake.mutations.slice(mutationsAfterApply).map(m => m.name), ['RelationDelete']);

  const before = fake.mutations.length;
  const twice = await undo([...entries, ...logged], runId, fake, { execute: true });
  assert.equal(twice.code, 0);
  assert.equal(fake.mutations.length, before);
});

test('undo of a notes edit that replaced an older block returns that block for a manual restore and sends nothing for it', async () => {
  const stale = '+++ Notas del agente (casos de aceptación)\n\n- **c1.** vieja\n\n+++';
  const fake = world({ issues: [issue('CRM-5', { description: `Texto humano.\n\n${stale}` })] });
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl: fake.fetchImpl });
  const descriptions = await fetchDescriptions(raw.project.id, KEY, { fetchImpl: fake.fetchImpl });
  const { plan } = computePlan({ harvest: { schemaVersion: 1, project: { slug: SLUG }, notes: ['CRM-5'] }, records: RECORDS, notes: NOTES, raw, descriptions });
  const entries = [];
  assert.equal((await applyPlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: l => entries.push(l) })).code, 0);
  const runId = entries[0].run;
  const expected = [{ op: 'notes:CRM-5', type: 'notes.replace', result: 'manual',
    action: 'restore the agent notes block of CRM-5 by hand from block', block: stale }];

  for (const execute of [false, true]) {
    const sent = fake.sent.length;
    const mutations = fake.mutations.length;
    const logged = [];
    const r = await undo(entries, runId, fake, { execute, logged });
    assert.equal(r.code, 0, r.messages.join('\n'));
    assert.deepEqual(r.results, expected);
    assert.equal(fake.mutations.length, mutations);
    assert.equal(fake.sent.length, sent);
    assert.deepEqual(logged, []);
  }
  assert.ok(fake.store.issues.find(i => i.identifier === 'CRM-5').description.includes('Caso c1.'));
});

test('an unknown run is refused as invalid input; a failing delete stops the undo with a failed line and code 1', async () => {
  const { fake, entries, runId } = await appliedRun();
  const unknown = await undo(entries, 'ffffffffffff@2026-01-01T00:00:00.000Z', fake, { execute: true });
  assert.equal(unknown.code, 4);
  assert.match(unknown.messages.join('\n'), /no applied lines for run ffffffffffff@/);

  const failing = world({ failOn: { op: 'RelationDelete', nth: 1, as: 'graphql' } });
  failing.store.issues.push({ ...issue('CRM-6'), id: 'uuid-CRM-6', description: '' });
  failing.store.relations.push({ id: 'rel-2', type: 'blocks', from: 'CRM-1', to: 'CRM-2' });
  failing.store.relations.push({ id: 'rel-3', type: 'blocks', from: 'CRM-6', to: 'CRM-2' });
  const logged = [];
  const relationsOnly = entries.filter(l => l.type === 'relation.create');
  const r = await undo(relationsOnly, runId, failing, { execute: true, logged });
  assert.equal(r.code, 1);
  assert.deepEqual(logged.map(l => [l.op, l.result]), [['rel+:new:roles>CRM-2', 'failed']]);
  assert.ok(!JSON.stringify([logged, r]).includes(KEY));
});

test('an undo read-back that is stale once is retried and counted as undone', async () => {
  const { fake, entries, runId } = await appliedRun();
  const created = entries.find(l => l.type === 'relation.create' && l.result === 'applied');
  let left = 0;
  const staleOnce = async (url, init) => {
    const { query } = JSON.parse(init.body);
    if (/query IssueState/.test(query) && left > 0) {
      left -= 1;
      fake.store.relations.push({ id: created.relationId, type: 'blocks', from: created.from, to: created.to });
      try { return await fake.fetchImpl(url, init); } finally { fake.store.relations.pop(); }
    }
    const res = await fake.fetchImpl(url, init);
    if (/^\s*mutation RelationDelete/.test(query)) left = 1;
    return res;
  };
  const logged = [];
  const slept = [];
  const r = await undoRun(entries, runId, { apiKey: KEY, fetchImpl: staleOnce, now: () => LATER, appendLog: l => logged.push(l), execute: true, sleep: async ms => { slept.push(ms); } });
  assert.equal(logged.find(l => l.op === created.op).result, 'undone', JSON.stringify(logged));
  assert.ok(slept.length >= 1);
  assert.equal(r.code, 0, r.messages.join('\n'));
});
