import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/harvest.mjs';
import { canonicalJson, caseSource, computePlan, liveIndex, normalizeDescription, observe, planHash } from '../scripts/lib/harvest.mjs';
import { fakeLinearStore, FIXTURE_SLUG as SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});

function world(keys, live = [], { over = {}, descriptions = {} } = {}) {
  const issues = keys.map(k => ({ ...issue(k, over[k]), relations: { nodes: [] }, inverseRelations: { nodes: [] } }));
  const byKey = new Map(issues.map(i => [i.identifier, i]));
  live.forEach(([from, to], n) => {
    byKey.get(from)?.relations.nodes.push({ id: `r${n + 1}`, type: 'blocks', relatedIssue: { identifier: to } });
    byKey.get(to)?.inverseRelations.nodes.push({ id: `r${n + 1}`, type: 'blocks', issue: { identifier: from } });
  });
  return {
    raw: { project: { id: 'project-uuid', slug: SLUG, name: 'P', url: 'u', teams: [{ id: 'team-crm', key: 'CRM' }] },
      issues, milestones: [{ id: 'm1', name: 'M1', sortOrder: 1 }], warnings: [] },
    descriptions: new Map(issues.map(i => [i.identifier, { id: i.id, title: i.title, description: descriptions[i.identifier] ?? '', archivedAt: i.archivedAt }])),
  };
}
const HARVEST = {
  schemaVersion: 1, project: { slug: SLUG },
  edges: [{ from: 'CRM-2', to: 'CRM-3', kind: 'code', evidence: 'shared module' }, { from: 'CRM-3', to: 'CRM-4', kind: 'gate', evidence: 'gate' }],
};
const W = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'], [['CRM-1', 'CRM-2'], ['CRM-1', 'CRM-3']]);
const planOf = (harvest = HARVEST, extra = {}) => computePlan({ harvest, records: [], notes: null, ...W, ...extra }).plan;

test('canonical JSON ignores key order, so a re-plan from reordered keys has the same hash', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: 3 } }), canonicalJson({ a: { c: 3, d: [2, { x: 0, y: 1 }] }, b: 1 }));
  const reordered = {
    edges: HARVEST.edges.map(({ evidence, kind, to, from }) => ({ evidence, kind, to, from })),
    project: { slug: SLUG }, schemaVersion: 1,
  };
  assert.equal(planOf(reordered).hash, planOf().hash);
  assert.equal(planOf().hash, planOf().hash);
});

test('the hash leaves out generatedAt and itself but covers warnings and every evidence string', () => {
  const plan = planOf();
  assert.ok(plan.warnings.length > 0, 'the fixture plans an add that makes a live edge redundant');
  assert.equal(planHash({ ...plan, generatedAt: '2026-11-09T10:00:00.000Z', hash: 'x' }), plan.hash);
  assert.notEqual(planHash({ ...plan, warnings: [] }), plan.hash);
  const edited = { ...HARVEST, edges: [HARVEST.edges[0], { ...HARVEST.edges[1], evidence: 'gate, reworded' }] };
  assert.notEqual(planOf(edited).hash, planOf().hash);
});

const kase = (id, then) => ({ id, given: 'dado', when: 'cuando', then, source: 'patch', ref: 'patch:a/b.patch' });

test('the records input hash follows the cases of live records only', () => {
  const records = [{ card: 'CRM-1', cases: [kase('c1', 'uno')], archived: null, supersededBy: null }];
  const base = planOf(HARVEST, { records });
  assert.match(base.inputs.records, /^[0-9a-f]{64}$/);
  const changed = planOf(HARVEST, { records: [{ ...records[0], cases: [kase('c1', 'dos')] }] });
  assert.notEqual(changed.inputs.records, base.inputs.records);
  assert.notEqual(changed.hash, base.hash);
  const archived = { card: 'CRM-2', cases: [kase('c1', 'x')], archived: { at: '2026-11-01', reason: 'r' }, supersededBy: null };
  assert.equal(planOf(HARVEST, { records: [...records, archived] }).inputs.records, base.inputs.records);
});

const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-harvest-hash-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const KEY = 'lin_api_dummy_' + 'z'.repeat(30);

test('apply accepts the full hash or a prefix of 12 or more hex characters and refuses 11, before any request', async () => {
  const dataDir = join(TMP, 'prefix');
  mkdirSync(join(dataDir, SLUG, 'harvest'), { recursive: true });
  writeFileSync(join(dataDir, SLUG, 'harvest', 'harvest.json'), JSON.stringify({ ...HARVEST, edges: [HARVEST.edges[0]] }));
  const store = () => fakeLinearStore({ issues: ['CRM-2', 'CRM-3'].map(k => issue(k)) });
  const deps = fetchImpl => ({ env: { LINEAR_API_KEY: KEY }, keyFile: join(TMP, 'absent'), now: () => new Date(0), fetchImpl, dataDir });
  const planned = await run(['plan', SLUG], deps(store().fetchImpl));
  assert.equal(planned.code, 0, planned.stderr);
  const { plan: planFile, hash } = JSON.parse(planned.stdout);
  const short = store();
  assert.equal((await run(['apply', SLUG, '--plan', planFile, '--approve', hash.slice(0, 11)], deps(short.fetchImpl))).code, 5);
  assert.equal(short.sent.length, 0);
  for (const approve of [hash.slice(0, 12), hash.slice(0, 13), hash]) {
    const r = await run(['apply', SLUG, '--plan', planFile, '--approve', approve], deps(store().fetchImpl));
    assert.equal(r.code, 0, `${approve.length}: ${r.stderr}`);
  }
});

const createOp = (from, to, over = {}) => ({
  id: `rel+:${from}>${to}`, type: 'relation.create', from, to, kind: 'code', evidence: 'e', before: { exists: false }, after: { exists: true }, ...over,
});

test('observe relation.create: pending, applied, drift, and placeholder or off-project ends', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-9'], [['CRM-1', 'CRM-2'], ['CRM-9', 'CRM-2']], { descriptions: { 'CRM-9': '<!-- keiron-sequencer:roles -->' } });
  const live = liveIndex(w.raw, w.descriptions);
  assert.equal(observe(createOp('CRM-1', 'CRM-2'), live), 'applied');
  assert.equal(observe(createOp('CRM-9', 'CRM-1'), live), 'pending');
  assert.deepEqual(observe(createOp('CRM-2', 'CRM-1'), live), { drift: 'CRM-1 already blocks CRM-2' });
  assert.deepEqual(observe(createOp('CRM-1', 'CRM-7'), live), { drift: 'CRM-7 is no longer in the project' });

  assert.equal(observe(createOp('new:roles', 'CRM-2'), live), 'applied', 'the marker resolves the placeholder');
  assert.equal(observe(createOp('new:other', 'CRM-2'), live), 'pending', 'a card not created yet');
  assert.equal(observe(createOp('new:other', 'CRM-2'), live, new Map([['new:other', 'CRM-1']])), 'applied');
  assert.equal(observe(createOp('AUTH-8', 'CRM-1', { offProject: 'AUTH-8' }), live), 'pending');
});

test('observe relation.delete: present is pending, absent is applied', () => {
  const live = liveIndex(world(['CRM-1', 'CRM-2'], [['CRM-1', 'CRM-2']]).raw);
  const op = to => ({ id: `rel-:CRM-1>${to}`, type: 'relation.delete', from: 'CRM-1', to, evidence: 'r',
    before: { exists: true, relationIds: ['r1'] }, after: { exists: false } });
  assert.equal(observe(op('CRM-2'), live), 'pending');
  assert.equal(observe(op('CRM-3'), live), 'applied');
});

test('observe relation.delete: the pair present under other relation ids is drift, not pending', () => {
  const live = liveIndex(world(['CRM-1', 'CRM-2'], [['CRM-1', 'CRM-2']]).raw);
  const op = { id: 'rel-:CRM-1>CRM-2', type: 'relation.delete', from: 'CRM-1', to: 'CRM-2', evidence: 'r',
    before: { exists: true, relationIds: ['r9'] }, after: { exists: false } };
  assert.deepEqual(observe(op, live), { drift: 'CRM-1 blocks CRM-2 under relation ids r1, not r9 as planned' });
});

test('observe card.create: the marker means applied, a title-only match is drift, neither is pending', () => {
  const op = { id: 'card:roles', type: 'card.create', key: 'roles', title: 'Roles y usuarios', before: { match: null }, after: {} };
  const of = (descriptions, over = {}) => {
    const w = world(['CRM-9'], [], { descriptions, over });
    return liveIndex(w.raw, w.descriptions);
  };
  assert.equal(observe(op, of({ 'CRM-9': 'x\n\n<!-- keiron-sequencer:roles -->' })), 'applied');
  assert.deepEqual(observe(op, of({}, { 'CRM-9': { title: 'Roles y usuarios' } })),
    { drift: 'a card titled "Roles y usuarios" exists without the keiron-sequencer marker: CRM-9' });
  assert.equal(observe(op, of({})), 'pending');
  assert.equal(observe(op, of({}), new Map([['new:roles', 'CRM-10']])), 'applied');
});

test('observe notes.replace compares normalized description hashes with before and after', () => {
  const sha = text => createHash('sha256').update(normalizeDescription(text)).digest('hex');
  const before = 'Texto humano.';
  const description = 'Texto humano.\n\n+++ Notas del agente (casos de aceptación)\n\n- **c1.** Caso.\n\n+++';
  const op = { id: 'notes:CRM-1', type: 'notes.replace', card: 'CRM-1', issueId: 'uuid-CRM-1', evidence: 'record CRM-1: c1',
    before: { descriptionHash: sha(before), block: null }, after: { descriptionHash: sha(description), block: '', description } };
  const at = text => {
    const w = world(['CRM-1'], [], { descriptions: { 'CRM-1': text } });
    return liveIndex(w.raw, w.descriptions);
  };
  assert.equal(observe(op, at(before)), 'pending');
  assert.equal(observe(op, at(description)), 'applied');
  assert.equal(observe(op, at(description.replace('- **c1.**', '* **c1.**').replace(/\n/g, '\r\n'))), 'applied');
  assert.deepEqual(observe(op, at('Otro texto.')), { drift: 'the description of CRM-1 changed since the plan' });
  assert.equal(caseSource(kase('c1', 'x')).length, 12);
});

test('observe notes.replace sees a write as applied after Linear rewrites links and escapes on save', () => {
  const sha = text => createHash('sha256').update(normalizeDescription(text)).digest('hex');
  const before = 'Usa lo que agregó [CRM-1192](<https://linear.app/k/issue/CRM-1192/x>).';
  const description = `${before}\n\n+++ Notas del agente\n\n- **d2.** Duraciones [30, 60] minutos; 3 * 2.\n\n+++`;
  const saved = 'Usa lo que agregó [CRM-1192](https://linear.app/k/issue/CRM-1192/x).\n\n'
    + '+++ Notas del agente\n\n* **d2.** Duraciones \\[30, 60\\] minutos; 3 \\* 2.\n\n+++';
  const op = { id: 'notes:CRM-1', type: 'notes.replace', card: 'CRM-1', issueId: 'uuid-CRM-1', evidence: 'record CRM-1: d2',
    before: { descriptionHash: sha(before), block: null }, after: { descriptionHash: sha(description), block: '', description } };
  const at = text => {
    const w = world(['CRM-1'], [], { descriptions: { 'CRM-1': text } });
    return liveIndex(w.raw, w.descriptions);
  };
  assert.equal(observe(op, at(before.replace('(<https://linear.app/k/issue/CRM-1192/x>)', '(https://linear.app/k/issue/CRM-1192/x)'))), 'pending');
  assert.equal(observe(op, at(saved)), 'applied');
  assert.equal(normalizeDescription('a \\[b\\] \\* \\<c\\>'), 'a [b] * <c>');
  assert.equal(normalizeDescription('[x](<https://u/v>)'), '[x](https://u/v)');
  assert.equal(normalizeDescription('regex `\\d+` y ruta a\\\\b'), 'regex `\\d+` y ruta a\\\\b');
});
