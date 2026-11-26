import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { caseSource, computePlan, liveIndex, normalizeDescription, renderNotesBlock, textSource } from '../scripts/lib/harvest.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SLUG = 'c0ffee000001';
const MILESTONES = [{ id: 'm1', name: 'M1', sortOrder: 1 }, { id: 'm2', name: 'M2', sortOrder: 2 }];
const TEAMS = [{ id: 'team-crm', key: 'CRM' }];

const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});

function world(keys, live = [], { over = {}, teams = TEAMS, descriptions = {} } = {}) {
  const issues = keys.map(k => ({ ...issue(k, over[k]), relations: { nodes: [] }, inverseRelations: { nodes: [] } }));
  const byKey = new Map(issues.map(i => [i.identifier, i]));
  live.forEach(([from, to], n) => {
    const id = `r${n + 1}`;
    byKey.get(from)?.relations.nodes.push({ id, type: 'blocks', relatedIssue: { identifier: to, archivedAt: null, state: { type: 'backlog' } } });
    byKey.get(to)?.inverseRelations.nodes.push({ id, type: 'blocks', issue: { identifier: from, archivedAt: null, state: { type: 'backlog' } } });
  });
  return {
    raw: { project: { id: 'project-uuid', slug: SLUG, name: 'Sample Project', url: 'u', teams }, issues, milestones: MILESTONES, warnings: [] },
    descriptions: new Map(issues.map(i => [i.identifier, { id: i.id, title: i.title, description: descriptions[i.identifier] ?? '', archivedAt: i.archivedAt }])),
  };
}

const plan = (harvest, w, extra = {}) =>
  computePlan({ harvest: { schemaVersion: 1, project: { slug: SLUG }, ...harvest }, records: [], notes: null, ...w, ...extra });
const e = (from, to, over = {}) => ({ from, to, kind: 'code', evidence: `${from} before ${to}`, ...over });
const created = (from, to, over = {}) => ({
  id: `rel+:${from}>${to}`, type: 'relation.create', from, to, kind: 'code', evidence: `${from} before ${to}`,
  before: { exists: false }, after: { exists: true }, ...over,
});
const messages = r => r.refusals.map(x => x.message);

test('edges and removals are classified add, keep, remove, noop or held, and unlisted live relations are never removed', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5', 'CRM-6', 'CRM-7', 'CRM-8'],
    [['CRM-1', 'CRM-2'], ['CRM-3', 'CRM-4'], ['CRM-5', 'CRM-6']]);
  const held = e('CRM-4', 'CRM-5', { hold: 'pending' });
  const heldRemoval = { from: 'CRM-7', to: 'CRM-8', reason: 'later', hold: 'pending' };
  const r = plan({
    edges: [e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3'), held],
    removals: [{ from: 'CRM-3', to: 'CRM-4', reason: 'no shared code' }, { from: 'CRM-6', to: 'CRM-1', reason: 'stale' }, heldRemoval],
  }, w);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops, [
    created('CRM-2', 'CRM-3'),
    { id: 'rel-:CRM-3>CRM-4', type: 'relation.delete', from: 'CRM-3', to: 'CRM-4', evidence: 'no shared code',
      before: { exists: true, relationIds: ['r2'] }, after: { exists: false } },
  ]);
  assert.deepEqual(r.plan.keep, [{ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: 'CRM-1 before CRM-2' }]);
  assert.deepEqual(r.plan.noop, [{ id: 'rel-:CRM-6>CRM-1', reason: 'already absent in Linear' }]);
  assert.deepEqual(r.plan.held, [
    { id: 'rel+:CRM-4>CRM-5', hold: 'pending', entry: held },
    { id: 'rel-:CRM-7>CRM-8', hold: 'pending', entry: heldRemoval },
  ]);
  assert.ok(!JSON.stringify(r.plan.ops).includes('CRM-5>CRM-6'));
  assert.deepEqual([r.plan.warnings, r.plan.irreversible, r.plan.splits], [[], [], []]);
  assert.deepEqual(r.plan.project, { id: 'project-uuid', slug: SLUG, name: 'Sample Project' });
});

test('an add already implied by other relations is refused as redundant, naming the chain and the fix', () => {
  const r = plan({ edges: [e('CRM-1', 'CRM-3')] }, world(['CRM-1', 'CRM-2', 'CRM-3'], [['CRM-1', 'CRM-2'], ['CRM-2', 'CRM-3']]));
  assert.equal(r.plan, null);
  assert.equal(r.refusals.length, 1);
  const [x] = r.refusals;
  assert.deepEqual([x.kind, x.from, x.to, x.via], ['redundant', 'CRM-1', 'CRM-3', ['CRM-2']]);
  assert.match(x.message, /CRM-1 blocks CRM-3 already follows from CRM-1 → CRM-2 → CRM-3/);
  assert.match(x.message, /drop the edge, or list it under rejected with the reason "redundant"/);
});

test('an add implied only by other adds of the same plan is refused; the adds that make the chain pass', () => {
  const r = plan({ edges: [e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3'), e('CRM-1', 'CRM-3')] }, world(['CRM-1', 'CRM-2', 'CRM-3']));
  assert.deepEqual(r.refusals.map(x => [x.kind, x.from, x.to]), [['redundant', 'CRM-1', 'CRM-3']]);
  assert.deepEqual(plan({ edges: [e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3')] }, world(['CRM-1', 'CRM-2', 'CRM-3'])).refusals, []);
});

test('an add that makes a live edge redundant is planned with a live-redundant warning naming the live edge', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3'], [['CRM-1', 'CRM-3']]);
  const r = plan({ edges: [e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3')] }, w);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops, [created('CRM-1', 'CRM-2'), created('CRM-2', 'CRM-3')]);
  assert.equal(r.plan.warnings.length, 1);
  const [x] = r.plan.warnings;
  assert.deepEqual([x.kind, x.from, x.to, x.via], ['live-redundant', 'CRM-1', 'CRM-3', ['CRM-2']]);
  assert.match(x.message, /the live edge CRM-1 blocks CRM-3/);
  assert.match(x.message, /propose removing it/);
  const already = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'], [['CRM-1', 'CRM-2'], ['CRM-2', 'CRM-3'], ['CRM-1', 'CRM-3']]);
  assert.deepEqual(plan({ edges: [e('CRM-3', 'CRM-4')] }, already).plan.warnings, [], 'a live edge that was redundant before the plan is not this plan\'s doing');
});

const CARD = {
  key: 'roles-users', title: 'Roles y usuarios', repo: 'example-auth', milestone: 'M2',
  description: 'Descripción', evidence: 'fixup: sample.patch', blocks: ['CRM-2'],
};

test('a new card compiles to card.create in the only team, its blocks become edges, and placeholder edges are planned', () => {
  const r = plan({ newCards: [CARD], edges: [e('CRM-1', 'new:roles-users', { kind: 'gate' })] }, world(['CRM-1', 'CRM-2']));
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops, [
    { id: 'card:roles-users', type: 'card.create', key: 'roles-users', title: 'Roles y usuarios', repo: 'example-auth',
      milestone: 'M2', team: 'CRM', evidence: 'fixup: sample.patch', before: { match: null },
      after: { teamId: 'team-crm', projectId: 'project-uuid', projectMilestoneId: 'm2', title: 'Roles y usuarios',
        description: 'Repo: example-auth\n\nDescripción\n\n<!-- keiron-sequencer:roles-users -->' } },
    created('CRM-1', 'new:roles-users', { kind: 'gate' }),
    created('new:roles-users', 'CRM-2', { evidence: 'fixup: sample.patch' }),
  ]);
  assert.deepEqual(r.plan.irreversible, ['card:roles-users']);
});

test('a new card whose marker is already in a description is not created again, and its edges use that card', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-9'], [], { descriptions: { 'CRM-9': 'Texto\n\n<!-- keiron-sequencer:roles-users -->' } });
  const r = plan({ newCards: [CARD], edges: [e('CRM-1', 'new:roles-users')] }, w);
  assert.deepEqual(r.plan.ops, [
    created('CRM-9', 'CRM-2', { id: 'rel+:CRM-9>CRM-2', evidence: 'fixup: sample.patch' }),
    created('CRM-1', 'CRM-9', { evidence: 'CRM-1 before new:roles-users' }),
  ].sort((a, b) => (a.id < b.id ? -1 : 1)));
  assert.deepEqual(r.plan.noop, [{ id: 'card:roles-users', reason: 'exists as CRM-9 (marker)' }]);
  assert.deepEqual(r.plan.irreversible, []);
});

const OTHER_CARD = { key: 'k1', title: 'Tarjeta nueva', repo: 'repo-a', milestone: 'M1', description: 'Texto', evidence: 'e' };

test('a new card description ends with the keiron-sequencer marker of its key', () => {
  const r = plan({ newCards: [OTHER_CARD] }, world(['ABC-1']));
  assert.deepEqual(r.refusals, []);
  assert.ok(r.plan.ops[0].after.description.endsWith('\n\n<!-- keiron-sequencer:k1 -->'), r.plan.ops[0].after.description);
});

test('a same-title card holding a marker under another prefix is a conflict that names the keiron-sequencer marker', () => {
  const w = world(['ABC-1', 'ABC-2'], [], { over: { 'ABC-2': { title: 'Tarjeta nueva' } }, descriptions: { 'ABC-2': 'x\n\n<!-- other-prefix:k1 -->' } });
  const r = plan({ newCards: [OTHER_CARD] }, w);
  assert.equal(r.plan, null);
  assert.deepEqual(messages(r), ['newCards[0]: "Tarjeta nueva" matches ABC-2 by title but has no keiron-sequencer marker']);
});

test('the marker scan reads only the keiron-sequencer prefix with a lowercase key', () => {
  const old = '<!-- ' + 'mi' + 'kado:c-1 -->';
  const w = world(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4'], [], { descriptions: {
    'ABC-1': '<!-- keiron-sequencer:a-1 -->', 'ABC-2': '<!-- keiron-sequencer:A_1 -->', 'ABC-3': '<!-- other-prefix:b-1 -->', 'ABC-4': old,
  } });
  assert.deepEqual([...liveIndex(w.raw, w.descriptions).markers], [['a-1', 'ABC-1']]);
});

test('a title match without the marker, a team outside the project and an unknown milestone refuse the plan', () => {
  const titled = plan({ newCards: [CARD] }, world(['CRM-2', 'CRM-9'], [], { over: { 'CRM-9': { title: 'roles y usuarios ' } } }));
  assert.equal(titled.plan, null);
  assert.deepEqual(messages(titled), ['newCards[0]: "Roles y usuarios" matches CRM-9 by title but has no keiron-sequencer marker']);
  assert.ok(titled.refusals.every(x => x.kind === 'conflict'));

  assert.deepEqual(messages(plan({ newCards: [{ ...CARD, team: 'PLAT' }] }, world(['CRM-2']))),
    ['newCards[0]: team PLAT is not a team of the project (CRM)']);
  const two = [...TEAMS, { id: 'team-plat', key: 'PLAT' }];
  assert.deepEqual(messages(plan({ newCards: [CARD] }, world(['CRM-2'], [], { teams: two }))),
    ['newCards[0]: the project has 2 teams (CRM, PLAT); set team']);
  assert.equal(plan({ newCards: [{ ...CARD, team: 'PLAT' }] }, world(['CRM-2'], [], { teams: two })).plan.ops[0].after.teamId, 'team-plat');
  assert.deepEqual(messages(plan({ newCards: [{ ...CARD, milestone: 'M9' }] }, world(['CRM-2']))),
    ['newCards[0]: milestone "M9" is not in the project; its milestones are M1, M2']);
});

test('a split produces no op and is carried for the review only', () => {
  const split = { parent: 'CRM-1216', new: 'CRM-1357', parentHalf: '1216b', newHalf: '1216a', evidence: 'split notes' };
  const r = plan({ splits: [split] }, world(['CRM-1216', 'CRM-1357']));
  assert.deepEqual(r.plan.ops, []);
  assert.deepEqual(r.plan.splits, [split]);
  assert.deepEqual(messages(plan({ splits: [{ ...split, parent: 'CRM-1' }] }, world(['CRM-1357']))),
    ['splits[0]: CRM-1 is not a card of the project']);
});

const OUTSIDE = new Map([
  ['AUTH-7', { id: 'uuid-AUTH-7', identifier: 'AUTH-7', archivedAt: null }],
  ['AUTH-8', { id: 'uuid-AUTH-8', identifier: 'AUTH-8', archivedAt: null }],
  ['AUTH-9', { id: 'uuid-AUTH-9', identifier: 'AUTH-9', archivedAt: '2026-11-01T00:00:00.000Z' }],
]);

test('an existing, unarchived card outside the project may be one end of any kind of edge, and is marked off-project', () => {
  const w = world(['CRM-1', 'CRM-2'], [['AUTH-7', 'CRM-2']]);
  const r = plan({ edges: [e('AUTH-8', 'CRM-1'), e('AUTH-7', 'CRM-2', { kind: 'gate' })] }, w, { outside: OUTSIDE });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.filter(op => op.type !== 'notes.replace'), [created('AUTH-8', 'CRM-1', { offProject: 'AUTH-8' })]);
  assert.deepEqual(r.plan.keep, [{ from: 'AUTH-7', to: 'CRM-2', kind: 'gate', evidence: 'AUTH-7 before CRM-2' }]);
  // The kept gate edge writes its "Sale después de" line into the blocked card's notes.
  const notes = r.plan.ops.filter(op => op.type === 'notes.replace');
  assert.deepEqual(notes.map(op => op.card), ['CRM-2']);
  assert.match(notes[0].after.block, /- \*\*AUTH-7\.\*\* Sale después de AUTH-7: no necesita su código\./);

  const bad = plan({ edges: [e('AUTH-9', 'CRM-1'), e('AUTH-404', 'CRM-1'), e('AUTH-7', 'AUTH-8')] }, w, { outside: OUTSIDE });
  assert.equal(bad.plan, null);
  assert.deepEqual(messages(bad), [
    'edges[0]: target not found/archived: AUTH-9',
    'edges[1]: target not found/archived: AUTH-404',
    'edges[2]: AUTH-7 and AUTH-8 are both outside the project; one end must be a card of the project',
  ]);
});

test('non-execution cards, an edge also removed or rejected, and an edge listed twice refuse the plan', () => {
  const w = world(['CRM-1', 'CRM-5', 'CRM-6', 'CRM-7'], [], { over: {
    'CRM-5': { state: { name: 'Canceled', type: 'canceled' } },
    'CRM-6': { archivedAt: '2026-11-01T00:00:00.000Z' },
    'CRM-7': { labels: { nodes: [{ name: 'QA' }] } },
  } });
  assert.deepEqual(messages(plan({ edges: [e('CRM-1', 'CRM-5'), e('CRM-1', 'CRM-6'), e('CRM-1', 'CRM-7')] }, w)), [
    'edges[0]: CRM-5 is not an execution card of the project (canceled)',
    'edges[1]: CRM-6 is not an execution card of the project (archived)',
    'edges[2]: CRM-7 is not an execution card of the project (planner or QA card)',
  ]);
  const three = world(['CRM-1', 'CRM-2', 'CRM-3']);
  assert.deepEqual(messages(plan({
    edges: [e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3')],
    removals: [{ from: 'CRM-1', to: 'CRM-2', reason: 'r' }],
    rejected: [{ from: 'CRM-2', to: 'CRM-3', reason: 'r' }],
  }, three)), ['CRM-1>CRM-2 is both in edges and in removals', 'CRM-2>CRM-3 is both in edges and in rejected']);
  assert.deepEqual(messages(plan({ newCards: [{ ...CARD, milestone: 'M1' }], edges: [e('new:roles-users', 'CRM-2')] }, three)),
    ['new:roles-users>CRM-2 is listed twice (edges[0] and newCards[0].blocks[0])']);
});

test('a cycle that contains a planned add refuses the plan, a placeholder included', () => {
  const two = plan({ edges: [e('CRM-2', 'CRM-1')] }, world(['CRM-1', 'CRM-2'], [['CRM-1', 'CRM-2']]));
  assert.equal(two.plan, null);
  assert.deepEqual(two.refusals, [{ kind: 'cycle', cards: ['CRM-1', 'CRM-2'], message: 'the plan closes a cycle among CRM-1, CRM-2' }]);
  const viaNew = plan({ newCards: [{ ...CARD, blocks: ['CRM-1'] }], edges: [e('CRM-2', 'new:roles-users')] },
    world(['CRM-1', 'CRM-2'], [['CRM-1', 'CRM-2']]));
  assert.deepEqual(viaNew.refusals.map(x => [x.kind, x.cards]), [['cycle', ['CRM-1', 'CRM-2', 'new:roles-users']]]);
});

test('a live cycle the plan does not touch is a warning, and a removal that breaks a live cycle is fine', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'], [['CRM-1', 'CRM-2'], ['CRM-2', 'CRM-1']]);
  const untouched = plan({ edges: [e('CRM-3', 'CRM-4')] }, w);
  assert.deepEqual(untouched.refusals, []);
  assert.deepEqual(untouched.plan.warnings, [{ kind: 'cycle-untouched', cards: ['CRM-1', 'CRM-2'] }]);
  const broken = plan({ removals: [{ from: 'CRM-2', to: 'CRM-1', reason: 'wrong way' }] }, w);
  assert.deepEqual(broken.refusals, []);
  assert.deepEqual(broken.plan.warnings, []);
  assert.deepEqual(broken.plan.ops.map(op => op.id), ['rel-:CRM-2>CRM-1']);
});

test('ops come out in a fixed order whatever the input order', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'], [['CRM-4', 'CRM-1']]);
  const edges = [e('CRM-3', 'CRM-4'), e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3')];
  const removals = [{ from: 'CRM-4', to: 'CRM-1', reason: 'r' }];
  const a = plan({ edges, removals, newCards: [{ ...CARD, blocks: [] }] }, w).plan;
  const b = plan({ edges: [...edges].reverse(), removals, newCards: [{ ...CARD, blocks: [] }] }, w).plan;
  assert.deepEqual(a.ops.map(op => op.id), [
    'card:roles-users', 'rel+:CRM-1>CRM-2', 'rel+:CRM-2>CRM-3', 'rel+:CRM-3>CRM-4', 'rel-:CRM-4>CRM-1',
  ]);
  assert.deepEqual(b.ops, a.ops);
});

const sha = text => createHash('sha256').update(text).digest('hex');
const kase = (id, then = `entonces ${id}`) => ({ id, given: `dado ${id}`, when: `cuando ${id}`, then, source: 'patch', ref: 'patch:a/b.patch' });
const RECORDS = [
  { card: 'CRM-1', cases: [kase('c1'), kase('c2')], archived: null, supersededBy: null },
  { card: 'CRM-2', cases: [kase('c1')], archived: null, supersededBy: null },
];
const translated = (...cards) => ({ schemaVersion: 1, cards: Object.fromEntries(cards.map(card => [card,
  Object.fromEntries(RECORDS.find(r => r.card === card).cases.map(c => [c.id, { source: caseSource(c), es: `Caso ${card} ${c.id}.` }]))])) });
const BLOCK = renderNotesBlock(RECORDS[0], translated('CRM-1').cards['CRM-1']);

test('a selected card gets a notes.replace op whose before and after hash the normalized description', () => {
  const w = world(['CRM-1', 'CRM-2'], [], { descriptions: { 'CRM-1': 'Texto humano.' } });
  const r = plan({ notes: ['CRM-1'] }, w, { records: RECORDS, notes: translated('CRM-1') });
  const description = `Texto humano.\n\n${BLOCK}`;
  assert.deepEqual(r.plan.ops, [{
    id: 'notes:CRM-1', type: 'notes.replace', card: 'CRM-1', issueId: 'uuid-CRM-1', evidence: 'record CRM-1: c1, c2',
    before: { descriptionHash: sha(normalizeDescription('Texto humano.')), block: null },
    after: { descriptionHash: sha(normalizeDescription(description)), block: BLOCK, description },
  }]);
  const current = plan({ notes: ['CRM-1'] }, world(['CRM-1'], [], { descriptions: { 'CRM-1': description } }),
    { records: RECORDS, notes: translated('CRM-1') });
  assert.deepEqual(current.plan.ops, []);
  assert.deepEqual(current.plan.noop, [{ id: 'notes:CRM-1', reason: 'notes already current' }]);
});

test('a missing translation, two notes blocks or a card with no record refuse the plan', () => {
  const w = world(['CRM-1', 'CRM-2'], [], { descriptions: { 'CRM-1': 'Texto.' } });
  const missing = plan({ notes: 'all' }, w, { records: RECORDS, notes: translated('CRM-1') });
  assert.equal(missing.plan, null);
  assert.deepEqual(missing.refusals, [{
    kind: 'needs-translation', card: 'CRM-2', case: 'c1', status: 'missing',
    message: 'CRM-2 c1: the Spanish text is missing; run cases and update notes.es.json',
  }]);
  const twice = world(['CRM-1'], [], { descriptions: { 'CRM-1': `${BLOCK}\n\n${BLOCK}` } });
  assert.deepEqual(messages(plan({ notes: ['CRM-1'] }, twice, { records: RECORDS, notes: translated('CRM-1') })),
    ['notes: CRM-1 has 2 agent notes blocks in its description; leave one']);
  assert.deepEqual(messages(plan({ notes: ['CRM-3'] }, w, { records: RECORDS, notes: translated('CRM-1') })),
    ['notes: CRM-3 has no live record with cases or decisions on the project map']);
  assert.deepEqual(plan({ notes: [] }, w, { records: RECORDS, notes: null }).plan.ops, []);
});

test('a selected card whose notes header has no closing +++ refuses the plan instead of appending a second block', () => {
  const broken = 'Texto.\n\n+++ Notas del agente (casos de aceptación)\n\n- **c1.** sin cierre\n\nMás texto humano.';
  const w = world(['CRM-1'], [], { descriptions: { 'CRM-1': broken } });
  const r = plan({ notes: ['CRM-1'] }, w, { records: RECORDS, notes: translated('CRM-1') });
  assert.equal(r.plan, null);
  assert.deepEqual(messages(r), ['notes: CRM-1 has an agent notes header with no closing +++; fix the description by hand']);
});

test('an added edge whose blocker sits in a later milestone than the card it blocks is refused as backward-milestone', () => {
  const inM1 = { projectMilestone: { name: 'M1' } };
  const inM2 = { projectMilestone: { name: 'M2' } };
  const w = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'], [['CRM-4', 'CRM-1']], { over: { 'CRM-1': inM1, 'CRM-2': inM2, 'CRM-3': inM2 } });
  const backward = plan({ edges: [e('CRM-2', 'CRM-1')] }, w);
  assert.equal(backward.plan, null);
  assert.equal(backward.refusals.length, 1);
  const [r] = backward.refusals;
  assert.deepEqual([r.kind, r.from, r.to, r.fromMilestone, r.toMilestone], ['backward-milestone', 'CRM-2', 'CRM-1', 'M2', 'M1']);
  assert.match(r.message, /move one card's milestone in Linear/);
  assert.match(r.message, /not a hard dependency/);
  assert.deepEqual(plan({ edges: [e('CRM-1', 'CRM-2'), e('CRM-2', 'CRM-3')] }, w).refusals, [], 'forward and same-milestone edges pass');
  for (const edge of [e('CRM-4', 'CRM-2'), e('CRM-2', 'CRM-4')]) assert.deepEqual(plan({ edges: [edge] }, w).refusals, [], 'a card with no milestone never triggers it');
  assert.deepEqual(plan({ edges: [e('CRM-4', 'CRM-1')] }, w).refusals, [], 'an edge already in Linear is kept, not refused');
});

test('a backward-milestone refusal asks the user to choose between a milestone move and a rejection', () => {
  const w = world(['CRM-1', 'CRM-2'], [], { over: { 'CRM-1': { projectMilestone: { name: 'M1' } }, 'CRM-2': { projectMilestone: { name: 'M2' } } } });
  const [r] = plan({ edges: [e('CRM-2', 'CRM-1')] }, w).refusals;
  assert.match(r.message, /ask the user/);
  assert.match(r.message, /if CRM-1 needs CRM-2's code, move a milestone/);
});

const rec = (card, over = {}) => ({ card, archived: null, supersededBy: null, ...over });

test('a rejected or removed pair that a record of either card names refuses the plan until the entry carries an order note', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3'], [['CRM-3', 'CRM-2']]);
  const records = [
    rec('CRM-2', { decisions: [{ text: 'Reuse the service CRM-1 adds.' }] }),
    rec('CRM-3', { findings: [{ kind: 'reorder', text: 'Whichever of CRM-2 and CRM-3 lands second rebases the spec.' }] }),
  ];
  const r = plan({
    rejected: [{ from: 'CRM-1', to: 'CRM-2', reason: 'preference' }],
    removals: [{ from: 'CRM-3', to: 'CRM-2', reason: 'spec churn' }],
  }, w, { records });
  assert.equal(r.plan, null);
  assert.deepEqual(r.refusals.map(x => [x.kind, x.from, x.to, x.mentions]), [
    ['unordered-reference', 'CRM-1', 'CRM-2', ['CRM-2 d1']],
    ['unordered-reference', 'CRM-3', 'CRM-2', ['CRM-3 f1']],
  ]);
  assert.match(r.refusals[0].message, /^rejected\[0\]: CRM-2 d1 names CRM-1, but CRM-1 will not block CRM-2: keep the edge, or add an order note/);
  const ordered = plan({
    rejected: [{ from: 'CRM-1', to: 'CRM-2', reason: 'preference', order: 'Si CRM-1 llega primero, CRM-2 usa su servicio.' }],
    removals: [{ from: 'CRM-3', to: 'CRM-2', reason: 'spec churn', order: 'La que llegue segunda ajusta el spec.' }],
  }, w, { records, notes: { schemaVersion: 1, cards: { 'CRM-2': { d1: { source: textSource(records[0].decisions[0]), es: 'Reusa el servicio de CRM-1.' } } } } });
  assert.deepEqual(ordered.refusals, []);
  assert.deepEqual(ordered.plan.ops.map(op => op.id), ['rel-:CRM-3>CRM-2', 'notes:CRM-1', 'notes:CRM-2', 'notes:CRM-3']);
});

test('a pair with a completed card, or whose records do not name each other, needs no order note', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3'], [], { over: { 'CRM-1': { state: { name: 'Done', type: 'completed' } } } });
  const records = [rec('CRM-2', { decisions: [{ text: 'Builds on CRM-1.' }] }), rec('CRM-3', { decisions: [{ text: 'Nothing shared, CRM-30 aside.' }] })];
  const r = plan({ rejected: [{ from: 'CRM-1', to: 'CRM-2', reason: 'done' }, { from: 'CRM-2', to: 'CRM-3', reason: 'unrelated' }] }, w, { records });
  assert.deepEqual(r.refusals, []);
});

test('an order note is written into both cards\' notes, also for a card with no record or outside the notes list', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3'], [], { descriptions: { 'CRM-1': 'Texto.', 'CRM-2': 'Texto.', 'CRM-3': 'Texto.' } });
  const order = 'Si CRM-1 llega primero, CRM-2 usa su servicio; si no, CRM-1 cambia CRM-2 al servicio.';
  const r = plan({ notes: ['CRM-1'], rejected: [{ from: 'CRM-1', to: 'CRM-3', reason: 'preference', order }] }, w,
    { records: RECORDS, notes: translated('CRM-1') });
  assert.deepEqual(r.refusals, []);
  const blocks = Object.fromEntries(r.plan.ops.map(op => [op.card, op.after.block]));
  assert.deepEqual(Object.keys(blocks), ['CRM-1', 'CRM-3']);
  assert.equal(blocks['CRM-1'], [
    '+++ Notas del agente', '', '**Casos de aceptación**', '', '- **c1.** Caso CRM-1 c1.', '- **c2.** Caso CRM-1 c2.', '',
    '**Orden con otras tarjetas**', '', `- **CRM-3.** ${order}`, '', '+++',
  ].join('\n'));
  assert.equal(blocks['CRM-3'], ['+++ Notas del agente', '', '**Orden con otras tarjetas**', '', `- **CRM-1.** ${order}`, '', '+++'].join('\n'));
  assert.equal(r.plan.ops.find(op => op.card === 'CRM-3').evidence, 'order: CRM-1');
});

test('a rejected pair that a chain of relations already orders needs no order note', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3'], [['CRM-1', 'CRM-2']]);
  const records = [rec('CRM-3', { decisions: [{ text: 'Uses what CRM-1 adds.' }] })];
  const chained = { edges: [e('CRM-2', 'CRM-3')], rejected: [{ from: 'CRM-1', to: 'CRM-3', reason: 'redundant' }] };
  assert.deepEqual(plan(chained, w, { records }).refusals, []);
  const removed = { removals: [{ from: 'CRM-1', to: 'CRM-2', reason: 'stale' }] };
  assert.deepEqual(plan(removed, w, { records: [rec('CRM-2', { decisions: [{ text: 'Uses CRM-1.' }] })] }).refusals.map(x => x.kind),
    ['unordered-reference'], 'the removed relation itself does not count as a chain');
});

test('an unblocked pair whose earlier card names the later blocker is a backward-reference warning for the user', () => {
  const w = world(['CRM-1', 'CRM-2'], [], { over: { 'CRM-1': { projectMilestone: { name: 'M1' } }, 'CRM-2': { projectMilestone: { name: 'M2' } } } });
  const records = [rec('CRM-1', { decisions: [{ text: 'Calls the service CRM-2 adds.' }] })];
  const order = 'Si CRM-2 llega primero, CRM-1 usa su servicio.';
  const notes = { schemaVersion: 1, cards: { 'CRM-1': { d1: { source: textSource(records[0].decisions[0]), es: 'Usa el servicio de CRM-2.' } } } };
  const r = plan({ rejected: [{ from: 'CRM-2', to: 'CRM-1', reason: 'preference', order }] }, w, { records, notes });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.warnings.map(x => [x.kind, x.from, x.to, x.mentions]), [['backward-reference', 'CRM-2', 'CRM-1', ['CRM-1 d1']]]);
  assert.match(r.plan.warnings[0].message, /CRM-1 \(M1\) names CRM-2 \(M2\) in d1: ask the user whether CRM-1 belongs in a later milestone/);
});

test('a card the plan writes notes into but whose description was not read is a conflict, never a blank description', () => {
  const w = world(['CRM-1', 'CRM-2']);
  w.descriptions.delete('CRM-2');
  const r = plan({ rejected: [{ from: 'CRM-1', to: 'CRM-2', reason: 'r', order: 'La que llegue segunda rebasa.' }] }, w);
  assert.deepEqual(messages(r), ['notes: the description of CRM-2 was not read; plan again']);
});

// A stacked spike can record a use of another card's code with no fixup and no finding, so no edge is ever drafted and
// nothing tells next or start. Every pair a published item names must be ordered, listed, or settled.
test('a pair a published item names that no relation orders and no entry lists refuses the plan as unaddressed-reference', () => {
  const w = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5'], [['CRM-3', 'CRM-4']], { over: { 'CRM-5': { state: { name: 'Done', type: 'completed' } } } });
  const records = [
    rec('CRM-2', {
      decisions: [{ text: 'updateDeal reuses the viewer CRM-1 adds.' }, { text: 'Like CRM-5 did.' }],
      openDecisions: [{ text: 'Ask CRM-99\'s owner.' }],
      cases: [{ id: 'c1', given: 'g', when: 'w', then: 'it answers 403 (CRM-4)', audit: { check: 'pr', verdict: 'moved', card: 'CRM-4', note: 'n', at: 't' } }],
    }),
    rec('CRM-4', { decisions: [{ text: 'Uses CRM-3\'s loader.' }] }),
  ];
  const r = plan({}, w, { records });
  assert.equal(r.plan, null);
  assert.deepEqual(r.refusals.map(x => [x.kind, x.cards, x.mentions]), [['unaddressed-reference', ['CRM-1', 'CRM-2'], ['CRM-2 d1']]]);
  assert.equal(r.refusals[0].message, 'CRM-2 d1 names CRM-1, but no relation orders the two cards and no edge, rejected or removals entry lists them: '
    + 'add the edge when one needs the other\'s code, or reject it with an order note');
  assert.deepEqual(plan({ edges: [e('CRM-1', 'CRM-2')] }, w, { records }).refusals, []);
  assert.deepEqual(plan({ edges: [e('CRM-1', 'CRM-2', { hold: 'asking' })] }, w, { records }).refusals, []);
  assert.deepEqual(plan({ rejected: [{ from: 'CRM-1', to: 'CRM-2', reason: 'r' }] }, w, { records }).refusals.map(x => x.kind), ['unordered-reference']);
});
