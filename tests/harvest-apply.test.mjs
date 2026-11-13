import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/harvest.mjs';
import { applyPlan } from '../scripts/lib/harvest-apply.mjs';
import { caseSource, computePlan } from '../scripts/lib/harvest.mjs';
import { fetchDescriptions, fetchProjectMap } from '../scripts/lib/linear-fetch.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'a'.repeat(30);
const SLUG = 'c0ffee000001';
const NOW = new Date('2026-11-09T10:00:00.000Z');
const MILESTONES = [{ id: 'm1', name: 'M1', sortOrder: 1 }];

const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});
const blocks = (...to) => ({ relations: { nodes: to.map(identifier => ({ type: 'blocks', relatedIssue: { identifier } })) } });

const world = (over = {}) => fakeLinearStore({
  issues: [
    issue('CRM-1'), issue('CRM-2'), issue('CRM-3', blocks('CRM-4')), issue('CRM-4'),
    issue('CRM-5', { description: 'Texto humano arriba.\n\nTexto humano abajo.' }),
    issue('AUTH-8', { projectId: 'other-project' }),
  ],
  milestones: MILESTONES,
  ...over,
});

const kase = id => ({ id, given: `dado ${id}`, when: `cuando ${id}`, then: `entonces ${id}`, source: 'patch', ref: 'patch:a/b.patch' });
const RECORDS = [{ card: 'CRM-5', cases: [kase('c1'), kase('c2')], archived: null, supersededBy: null }];
const NOTES = { schemaVersion: 1, cards: { 'CRM-5': Object.fromEntries(RECORDS[0].cases.map(c => [c.id, { source: caseSource(c), es: `Caso ${c.id}.` }])) } };
const CARD = {
  key: 'roles', title: 'Roles y usuarios', repo: 'example-auth', milestone: 'M1',
  description: 'Descripción.', evidence: 'fixup: sample.patch', blocks: ['CRM-2'],
};
const HARVEST = {
  schemaVersion: 1, project: { slug: SLUG },
  edges: [{ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: 'shared module' }],
  removals: [{ from: 'CRM-3', to: 'CRM-4', reason: 'no shared code' }],
  newCards: [CARD],
  notes: ['CRM-5'],
};

async function planFor(fake, harvest = HARVEST, { outside = new Map() } = {}) {
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl: fake.fetchImpl });
  const descriptions = await fetchDescriptions(raw.project.id, KEY, { fetchImpl: fake.fetchImpl });
  const r = computePlan({ harvest, records: RECORDS, notes: NOTES, raw, descriptions, outside });
  assert.deepEqual(r.refusals, []);
  return r.plan;
}

const apply = (plan, fake, logged = []) =>
  applyPlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: l => logged.push(l), sleep: async () => {} });

test('applyPlan refuses a missing, unhashed or edited plan with code 5 before any request', async () => {
  const plan = await planFor(world());
  const edited = { ...plan, ops: plan.ops.map((op, i) => (i ? op : { ...op, evidence: 'edited after review' })) };
  const { hash, ...unhashed } = plan;
  for (const bad of [null, unhashed, edited]) {
    const fresh = world();
    const r = await apply(bad, fresh);
    assert.equal(r.code, 5);
    assert.equal(fresh.sent.length, 0);
    assert.match(r.messages.join('\n'), /hash|plan/);
  }
});

const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-harvest-apply-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const NO_FILE = join(TMP, 'absent', 'linear.key');
const deps = (fetchImpl, dataDir = join(TMP, 'data')) => ({ env: { LINEAR_API_KEY: KEY }, keyFile: NO_FILE, now: () => NOW, fetchImpl, dataDir });
const planFile = (name, plan) => {
  const file = join(TMP, `${name}.json`);
  writeFileSync(file, JSON.stringify({ ...plan, generatedAt: NOW.toISOString() }));
  return file;
};

test('apply refuses a slug, URL or UUID ref naming another project with exit 5 before any request; an identifier ref costs one project read', async () => {
  const plan = await planFor(world());
  const file = planFile('other-ref', plan);
  for (const ref of ['aaaaaaaaaaaa', 'https://linear.app/x/project/other-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000']) {
    const fresh = world();
    const r = await run(['apply', ref, '--plan', file, '--approve', plan.hash], deps(fresh.fetchImpl));
    assert.equal(r.code, 5, `${ref}: ${r.stderr}`);
    assert.match(r.stderr, /project/);
    assert.equal(fresh.sent.length, 0, ref);
  }
  const other = world({ project: { id: 'other-uuid', slugId: 'aaaaaaaaaaaa', name: 'Other', url: 'u' } });
  const r = await run(['apply', 'P-CRM-999', '--plan', file, '--approve', plan.hash], deps(other.fetchImpl));
  assert.equal(r.code, 5, r.stderr);
  assert.equal(other.sent.length, 1);
  assert.match(other.sent[0].body.query, /project\(id:/);
  assert.equal(other.mutations.length, 0);

  const missing = world();
  const gone = await run(['apply', SLUG, '--plan', join(TMP, 'nope.json'), '--approve', plan.hash], deps(missing.fetchImpl));
  assert.equal(gone.code, 5);
  assert.equal(missing.sent.length, 0);
});

test('with a P-XXX ref every offline apply refusal exits 5 with zero requests, before the one project read', async () => {
  const plan = await planFor(world());
  const file = planFile('offline-refusals', plan);
  const edited = planFile('offline-edited', { ...plan, ops: plan.ops.map((op, i) => (i ? op : { ...op, evidence: 'edited after review' })) });
  const wrong = plan.hash.startsWith('0') ? `1${plan.hash.slice(1, 12)}` : `0${plan.hash.slice(1, 12)}`;
  for (const args of [
    ['--plan', file],
    ['--approve', plan.hash],
    ['--plan', file, '--approve', wrong],
    ['--plan', file, '--approve', plan.hash.slice(0, 11)],
    ['--plan', edited, '--approve', plan.hash],
    ['--plan', join(TMP, 'nope.json'), '--approve', plan.hash],
  ]) {
    const fresh = world();
    const r = await run(['apply', 'P-ABC-12', ...args], deps(fresh.fetchImpl));
    assert.equal(r.code, 5, `${args.join(' ')} → ${r.code} ${r.stderr}`);
    assert.equal(fresh.sent.length, 0, args.join(' '));
  }
  const same = world();
  const ok = await run(['apply', 'P-ABC-12', '--plan', file, '--approve', plan.hash], deps(same.fetchImpl));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(same.sent.filter(s => /project\(id:/.test(s.body.query)).length, 3, 'the ref check, then the pre-write and final re-fetches');
});

test('drift on any op before the first write exits 6 naming every drifted op, with zero mutations and nothing logged', async () => {
  const fake = world();
  const plan = await planFor(fake);
  fake.store.issues.find(i => i.identifier === 'CRM-5').description = 'Alguien editó la tarjeta.';
  fake.store.relations.push({ id: 'rel-x', type: 'blocks', from: 'CRM-3', to: 'CRM-4' });
  const logged = [];
  const r = await apply(plan, fake, logged);
  assert.equal(r.code, 6);
  assert.equal(fake.mutations.length, 0);
  assert.deepEqual(logged, []);
  assert.deepEqual(r.results.map(x => [x.op, x.result]), [['rel-:CRM-3>CRM-4', 'drift'], ['notes:CRM-5', 'drift']]);
  assert.match(r.messages.join('\n'), /notes:CRM-5: the description of CRM-5 changed since the plan/);
  assert.match(r.messages.join('\n'), /nothing was written/);
});

test('writes run in the order card.create, relation.create, relation.delete, notes.replace, and the placeholder edge uses the created card', async () => {
  const fake = world();
  const plan = await planFor(fake);
  assert.deepEqual(plan.ops.map(op => op.id),
    ['card:roles', 'rel+:CRM-1>CRM-2', 'rel+:new:roles>CRM-2', 'rel-:CRM-3>CRM-4', 'notes:CRM-5']);
  const logged = [];
  const r = await apply(plan, fake, logged);
  assert.equal(r.code, 0, r.messages?.join('\n'));
  assert.deepEqual(fake.mutations.map(m => m.name), ['IssueCreate', 'RelationCreate', 'RelationCreate', 'RelationDelete', 'DescriptionUpdate']);
  assert.deepEqual(fake.mutations[2].variables, { blocker: 'uuid-CRM-6', blocked: 'uuid-CRM-2' });
  assert.deepEqual(fake.mutations[3].variables, { id: 'rel-1' });
  assert.deepEqual(logged.map(l => [l.op, l.result]), plan.ops.map(op => [op.id, 'applied']));
  assert.deepEqual(logged[2], {
    v: 1, run: `${plan.hash.slice(0, 12)}@${NOW.toISOString()}`, at: NOW.toISOString(), op: 'rel+:new:roles>CRM-2', type: 'relation.create',
    result: 'applied', from: 'CRM-6', to: 'CRM-2', relationId: 'rel-3',
  });
});

test('an edge to an existing card outside the project resolves its id with IssueState and is written; archived since the plan is drift', async () => {
  const harvest = { schemaVersion: 1, project: { slug: SLUG }, edges: [{ from: 'AUTH-8', to: 'CRM-1', kind: 'gate', evidence: 'auth first' }] };
  const outside = new Map([['AUTH-8', { id: 'uuid-AUTH-8', identifier: 'AUTH-8', archivedAt: null }]]);
  const fake = world();
  const plan = await planFor(fake, harvest, { outside });
  assert.equal(plan.ops[0].offProject, 'AUTH-8');
  const r = await apply(plan, fake);
  assert.equal(r.code, 0, r.messages?.join('\n'));
  assert.deepEqual(fake.mutations.map(m => m.variables), [{ blocker: 'uuid-AUTH-8', blocked: 'uuid-CRM-1' }]);

  const archived = world();
  const later = await planFor(archived, harvest, { outside });
  archived.store.issues.find(i => i.identifier === 'AUTH-8').archivedAt = '2026-11-09T09:00:00.000Z';
  const d = await apply(later, archived);
  assert.equal(d.code, 6);
  assert.equal(archived.mutations.length, 0);
  assert.match(d.messages.join('\n'), /AUTH-8 is archived/);
});

const afterWrite = (fake, name, then) => async (url, init) => {
  const res = await fake.fetchImpl(url, init);
  if (JSON.parse(init.body).query.match(/^\s*mutation (\w+)/)?.[1] === name) then();
  return res;
};

test('drift found by the check before a later write stops the run: a failed line naming the drift, code 1 because a write was made', async () => {
  const fake = world();
  const plan = await planFor(fake, { ...HARVEST, newCards: [], removals: [] });
  const editCrm5 = () => { fake.store.issues.find(i => i.identifier === 'CRM-5').description = 'Editada a mano.'; };
  const logged = [];
  const r = await applyPlan(plan, { apiKey: KEY, fetchImpl: afterWrite(fake, 'RelationCreate', editCrm5), now: () => NOW, appendLog: l => logged.push(l) });
  assert.equal(r.code, 1);
  assert.deepEqual(fake.mutations.map(m => m.name), ['RelationCreate']);
  assert.deepEqual(logged.map(l => [l.op, l.result]), [['rel+:CRM-1>CRM-2', 'applied'], ['notes:CRM-5', 'failed']]);
  assert.equal(logged[1].error, 'drift: the description of CRM-5 changed since the plan');
  assert.match(r.messages.join('\n'), /earlier ops were written/);
});

test('a full apply converges: a fresh plan from the new live state has no ops, and a re-run only skips with zero mutations', async () => {
  const fake = world();
  const plan = await planFor(fake);
  assert.equal((await apply(plan, fake)).code, 0);
  const replanned = await planFor(fake);
  assert.deepEqual(replanned.ops, []);
  const mutations = fake.mutations.length;
  const logged = [];
  const again = await apply(plan, fake, logged);
  assert.equal(again.code, 0, again.messages.join('\n'));
  assert.equal(fake.mutations.length, mutations);
  assert.deepEqual(logged.map(l => l.result), plan.ops.map(() => 'skipped'));
  assert.deepEqual(logged[0], {
    v: 1, run: `${plan.hash.slice(0, 12)}@${NOW.toISOString()}`, at: NOW.toISOString(), op: 'card:roles', type: 'card.create',
    result: 'skipped', key: 'roles', issueId: 'uuid-CRM-6', identifier: 'CRM-6',
  });
});

const onlyCard = { ...HARVEST, edges: [], removals: [], notes: [] };

test('a card carrying the marker since the plan is reused, not created, and its placeholder edge points at it', async () => {
  const fake = world();
  const plan = await planFor(fake, onlyCard);
  fake.store.issues.push({ ...issue('CRM-40', { title: 'Hecha a mano' }), id: 'uuid-CRM-40', description: 'x\n\n<!-- keiron-sequencer:roles -->' });
  const logged = [];
  const r = await apply(plan, fake, logged);
  assert.equal(r.code, 0, r.messages.join('\n'));
  assert.deepEqual(fake.mutations.map(m => [m.name, m.variables]), [['RelationCreate', { blocker: 'uuid-CRM-40', blocked: 'uuid-CRM-2' }]]);
  assert.deepEqual(logged.map(l => [l.op, l.result, l.identifier ?? l.from]), [['card:roles', 'skipped', 'CRM-40'], ['rel+:new:roles>CRM-2', 'applied', 'CRM-40']]);
});

test('a card with the same title and no marker since the plan is drift: exit 6, nothing created', async () => {
  const fake = world();
  const plan = await planFor(fake, onlyCard);
  fake.store.issues.push({ ...issue('CRM-40', { title: 'Roles y usuarios' }), id: 'uuid-CRM-40', description: '' });
  const r = await apply(plan, fake);
  assert.equal(r.code, 6);
  assert.equal(fake.mutations.length, 0);
  assert.match(r.messages.join('\n'), /card:roles: a card titled "Roles y usuarios" exists without the keiron-sequencer marker: CRM-40/);
});

test('a same-title card holding a marker under another prefix since the plan is drift: exit 6, nothing created', async () => {
  const fake = world();
  const plan = await planFor(fake, onlyCard);
  fake.store.issues.push({ ...issue('ABC-40', { title: 'Roles y usuarios' }), id: 'uuid-ABC-40', description: 'x\n\n<!-- other-prefix:roles -->' });
  const r = await apply(plan, fake);
  assert.equal(r.code, 6);
  assert.equal(fake.mutations.length, 0);
  assert.match(r.messages.join('\n'), /card:roles: a card titled "Roles y usuarios" exists without the keiron-sequencer marker: ABC-40/);
});

test('when Linear drops HTML comments the create fails verify once, and the re-run stops on the title guard instead of a duplicate', async () => {
  const fake = world({ markdown: { dropComments: true } });
  const plan = await planFor(fake, onlyCard);
  const logged = [];
  const r = await apply(plan, fake, logged);
  assert.equal(r.code, 1);
  assert.deepEqual(logged.map(l => [l.op, l.result, l.identifier]), [['card:roles', 'unverified', 'CRM-6']]);
  const again = await apply(plan, fake);
  assert.equal(again.code, 6);
  assert.deepEqual(fake.mutations.map(m => m.name), ['IssueCreate']);
});

test('when Linear rewrites dash bullets as stars the notes write still verifies', async () => {
  const fake = world({ markdown: { starBullets: true } });
  const plan = await planFor(fake, { ...HARVEST, newCards: [], edges: [], removals: [] });
  const r = await apply(plan, fake);
  assert.equal(r.code, 0, r.messages.join('\n'));
  assert.match(fake.store.issues.find(i => i.identifier === 'CRM-5').description, /^\* \*\*c1\.\*\* Caso c1\.$/m);
});

test('only the notes block is replaced: the human text above and below stays byte-identical', async () => {
  const above = 'Texto humano arriba.\n\n';
  const below = '\n\nTexto humano abajo.\n- viñeta';
  const stale = '+++ Notas del agente (casos de aceptación)\n\n- **c1.** vieja\n\n+++';
  const fake = world();
  fake.store.issues.find(i => i.identifier === 'CRM-5').description = `${above}${stale}${below}`;
  const plan = await planFor(fake, { ...HARVEST, newCards: [], edges: [], removals: [] });
  const logged = [];
  assert.equal((await apply(plan, fake, logged)).code, 0);
  const now = fake.store.issues.find(i => i.identifier === 'CRM-5').description;
  assert.equal(now, `${above}${plan.ops[0].after.block}${below}`);
  assert.deepEqual(logged[0].before, { block: stale });
  assert.equal(logged[0].issueId, 'uuid-CRM-5');
});

for (const as of ['http500', 'graphql', 'success-false', 'timeout']) {
  test(`a ${as} failure on a write stops there with a failed line and code 1, later ops untouched, and the re-run converges`, async () => {
    const fake = world({ failOn: { op: 'RelationDelete', nth: 1, as } });
    const plan = await planFor(fake);
    const logged = [];
    const r = await apply(plan, fake, logged);
    assert.equal(r.code, 1);
    assert.deepEqual(fake.mutations.map(m => m.name), ['IssueCreate', 'RelationCreate', 'RelationCreate', 'RelationDelete']);
    assert.deepEqual(logged.map(l => l.result), ['applied', 'applied', 'applied', 'failed']);
    assert.equal(logged[3].op, 'rel-:CRM-3>CRM-4');
    assert.ok(logged[3].error.length > 0);
    assert.ok(!JSON.stringify([logged, r]).includes(KEY), 'the key never reaches a log line or a message');
    assert.match(r.messages.join('\n'), /failed: rel-:CRM-3>CRM-4: /);

    const again = [];
    const second = await apply(plan, fake, again);
    assert.equal(second.code, 0, second.messages.join('\n'));
    assert.deepEqual(again.map(l => l.result), ['skipped', 'skipped', 'skipped', 'applied', 'applied']);
    assert.equal(fake.store.issues.filter(i => i.title === 'Roles y usuarios').length, 1);
    assert.equal(fake.store.relations.filter(rel => rel.from === 'CRM-1' && rel.to === 'CRM-2').length, 1);
  });
}

test('a change that verified but is gone in the final re-fetch fails the run with code 1', async () => {
  const fake = world();
  const plan = await planFor(fake, { schemaVersion: 1, project: { slug: SLUG }, edges: HARVEST.edges });
  let wrote = false;
  const vanishing = async (url, init) => {
    const { query } = JSON.parse(init.body);
    if (/^\s*mutation/.test(query)) wrote = true;
    else if (wrote && /project\(id:/.test(query)) fake.store.relations.length = 0;
    return fake.fetchImpl(url, init);
  };
  const logged = [];
  const r = await applyPlan(plan, { apiKey: KEY, fetchImpl: vanishing, now: () => NOW, appendLog: l => logged.push(l) });
  assert.deepEqual(logged.map(l => l.result), ['applied']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.messages, ['unverified: rel+:CRM-1>CRM-2: not applied in the final re-fetch']);
});

// Linear can answer a read right after a write with the state before it: hide the new relation from the next `stale` reads.
const staleReadsAfter = (fake, mutation, stale) => {
  let left = 0;
  return async (url, init) => {
    const { query } = JSON.parse(init.body);
    const name = query.match(/^\s*mutation (\w+)/)?.[1];
    if (/query IssueState/.test(query) && left > 0) {
      left -= 1;
      const hidden = fake.store.relations.splice(0);
      try { return await fake.fetchImpl(url, init); } finally { fake.store.relations.push(...hidden); }
    }
    const res = await fake.fetchImpl(url, init);
    if (name === mutation) left = stale;
    return res;
  };
};

test('a read-back that is stale once and then right is applied after a retry, with the delay injected', async () => {
  const fake = world();
  const plan = await planFor(fake, { schemaVersion: 1, project: { slug: SLUG }, edges: HARVEST.edges });
  const slept = [];
  const logged = [];
  const r = await applyPlan(plan, { apiKey: KEY, fetchImpl: staleReadsAfter(fake, 'RelationCreate', 1), now: () => NOW, appendLog: l => logged.push(l), sleep: async ms => { slept.push(ms); } });
  assert.equal(r.code, 0, r.messages.join('\n'));
  assert.deepEqual(logged.map(l => [l.op, l.result]), [['rel+:CRM-1>CRM-2', 'applied']]);
  assert.equal(slept.length, 1);
});

test('a read-back that stays stale through every retry is unverified and stops the run as before', async () => {
  const fake = world();
  const plan = await planFor(fake, { schemaVersion: 1, project: { slug: SLUG }, edges: HARVEST.edges });
  const slept = [];
  const logged = [];
  const r = await applyPlan(plan, { apiKey: KEY, fetchImpl: staleReadsAfter(fake, 'RelationCreate', 99), now: () => NOW, appendLog: l => logged.push(l), sleep: async ms => { slept.push(ms); } });
  assert.equal(r.code, 1);
  assert.deepEqual(logged.map(l => [l.op, l.result]), [['rel+:CRM-1>CRM-2', 'unverified']]);
  assert.match(r.messages[0], /^unverified: rel\+:CRM-1>CRM-2/);
  assert.equal(slept.length, 2, 'three reads in all');
});
