import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSource, computePlan, renderReview } from '../scripts/lib/harvest.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SLUG = 'c0ffee000001';
const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});
function world(keys, live = [], descriptions = {}) {
  const issues = keys.map(k => ({ ...issue(k), relations: { nodes: [] }, inverseRelations: { nodes: [] } }));
  const byKey = new Map(issues.map(i => [i.identifier, i]));
  live.forEach(([from, to], n) => {
    byKey.get(from)?.relations.nodes.push({ id: `r${n + 1}`, type: 'blocks', relatedIssue: { identifier: to } });
    byKey.get(to)?.inverseRelations.nodes.push({ id: `r${n + 1}`, type: 'blocks', issue: { identifier: from } });
  });
  return {
    raw: { project: { id: 'project-uuid', slug: SLUG, name: 'Sample Project', url: 'u', teams: [{ id: 'team-crm', key: 'CRM' }] },
      issues, milestones: [{ id: 'm2', name: 'M2', sortOrder: 1 }],
      warnings: [{ key: 'CRM-9', kind: 'relations-truncated', message: 'CRM-9: 100 relations returned; blocks may be missing' }] },
    descriptions: new Map(issues.map(i => [i.identifier, { id: i.id, title: i.title, description: descriptions[i.identifier] ?? '', archivedAt: null }])),
  };
}
const kase = { id: 'c1', given: 'dado', when: 'cuando', then: 'entonces', source: 'patch', ref: 'patch:a/b.patch' };
const FULL = {
  schemaVersion: 1, project: { slug: SLUG },
  edges: [
    { from: 'CRM-2', to: 'CRM-3', kind: 'code', evidence: 'shared module' },
    { from: 'AUTH-8', to: 'CRM-1', kind: 'gate', evidence: 'platform first' },
    { from: 'CRM-2', to: 'CRM-1', kind: 'code', evidence: 'kept', hold: 'pending' },
    { from: 'CRM-5', to: 'CRM-6', kind: 'code', evidence: 'already there' },
  ],
  removals: [{ from: 'CRM-3', to: 'CRM-4', reason: 'no shared code' }],
  splits: [{ parent: 'CRM-1216', new: 'CRM-1357', parentHalf: '1216b', newHalf: '1216a', evidence: 'split notes' }],
  newCards: [{ key: 'roles-users', title: 'Roles y usuarios', repo: 'example-auth', milestone: 'M2',
    description: 'Descripción', evidence: 'fixup: sample.patch', blocks: ['CRM-4'] }],
  notes: ['CRM-1'],
};
const W = world(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5', 'CRM-6', 'CRM-9', 'CRM-1216', 'CRM-1357'],
  [['CRM-1', 'CRM-2'], ['CRM-1', 'CRM-3'], ['CRM-3', 'CRM-4'], ['CRM-5', 'CRM-6'], ['CRM-6', 'CRM-5']], { 'CRM-1': 'Texto.' });
const OUTSIDE = new Map([['AUTH-8', { id: 'uuid-AUTH-8', identifier: 'AUTH-8', archivedAt: null }]]);
const RECORDS = [{ card: 'CRM-1', cases: [kase], archived: null, supersededBy: null }];
const NOTES = { schemaVersion: 1, cards: { 'CRM-1': { c1: { source: caseSource(kase), es: 'Dado esto, cuando aquello, entonces lo otro.' } } } };
const COMMAND = `node scripts/harvest.mjs apply ${SLUG} --plan /tmp/p/plan.json --approve 0123456789ab`;

const full = () => computePlan({ harvest: FULL, records: RECORDS, notes: NOTES, ...W, outside: OUTSIDE });
const inOrder = (md, parts) => {
  const at = parts.map(p => md.indexOf(p));
  at.forEach((i, n) => assert.ok(i >= 0, `missing: ${parts[n]}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, `out of order: ${parts.join(' | ')}`);
};

test('a written plan reads header, warnings, new cards, splits, adds, removes, notes, unchanged, held, the undo limit and the command, in that order', () => {
  const { plan, refusals } = full();
  assert.deepEqual(refusals, []);
  const md = renderReview(plan, { refusals, approveCommand: COMMAND });
  inOrder(md, [
    '# Harvest plan: Sample Project', `- Hash: \`${plan.hash}\``,
    '## Warnings', '## New cards', '## Splits (review only, nothing is written)', '## Relations to add', '## Relations to remove',
    '## Agent notes', '## Unchanged', '## Held', 'New cards cannot be undone; archive them by hand.', '## Apply', COMMAND,
  ]);
  assert.ok(!md.includes('## Refusals'));
});

test('each section names what it changes and why', () => {
  const { plan } = full();
  const md = renderReview(plan, { refusals: [], approveCommand: COMMAND });
  for (const line of [
    '- Project: Sample Project (c0ffee000001)',
    '- live-redundant: the live edge CRM-1 blocks CRM-3 now follows from CRM-1 → CRM-2 → CRM-3: propose removing it in removals if no one needs it',
    '- cycle-untouched: CRM-5, CRM-6 already form a cycle in Linear; this plan does not touch it',
    '- relations-truncated: CRM-9: 100 relations returned; blocks may be missing',
    '- new:roles-users: "Roles y usuarios" (example-auth; milestone M2; team CRM): fixup: sample.patch',
    '- CRM-1216 keeps its ID as 1216b; CRM-1357 is 1216a: split notes',
    '- AUTH-8 blocks CRM-1 (gate, AUTH-8 is off-project): platform first',
    '- CRM-2 blocks CRM-3 (code): shared module',
    '- new:roles-users blocks CRM-4 (code): fixup: sample.patch',
    '- CRM-3 no longer blocks CRM-4: no shared code',
    '### CRM-1: add the block',
    '- **c1.** Dado esto, cuando aquello, entonces lo otro.',
    '1 listed relation(s) already in Linear.',
    '- rel+:CRM-2>CRM-1: held (pending)',
  ]) assert.ok(md.includes(line), `missing line: ${line}\n\n${md}`);
});

test('without new cards there is no undo-limit sentence, and an empty plan says nothing changes', () => {
  const { plan } = computePlan({ harvest: { ...FULL, newCards: [], notes: [] }, records: [], notes: null, ...W, outside: OUTSIDE });
  const md = renderReview(plan, { refusals: [], approveCommand: COMMAND });
  assert.ok(!md.includes('cannot be undone'));
  assert.ok(!md.includes('## New cards'));
  const empty = computePlan({ harvest: { schemaVersion: 1, project: { slug: SLUG } }, records: [], notes: null, ...W }).plan;
  assert.ok(renderReview(empty, { refusals: [], approveCommand: COMMAND }).includes('No changes: Linear already matches this harvest.'));
});

test('a refused plan reads header, warnings and refusals, has no hash and no apply command', () => {
  const r = computePlan({ harvest: { ...FULL, notes: 'all', edges: [...FULL.edges, { from: 'CRM-3', to: 'CRM-1', kind: 'code', evidence: 'loop' }] },
    records: [...RECORDS, { card: 'CRM-2', cases: [kase], archived: null, supersededBy: null }], notes: NOTES, ...W, outside: OUTSIDE });
  assert.equal(r.plan, null);
  const md = renderReview(null, { refusals: r.refusals, warnings: r.warnings, project: W.raw.project, approveCommand: COMMAND });
  inOrder(md, ['# Harvest plan: Sample Project', '- Status: refused; no plan file was written. Fix the input and run plan again.',
    '## Warnings', '## Refusals', '- cycle: the plan closes a cycle among CRM-1, CRM-2, CRM-3',
    '- needs-translation: CRM-2 c1: the Spanish text is missing; run cases and update notes.es.json']);
  for (const absent of ['Hash:', '## Apply', COMMAND, '## Relations to add']) assert.ok(!md.includes(absent), absent);
});

test('the review never carries a Linear key', () => {
  const md = renderReview(full().plan, { refusals: [], approveCommand: COMMAND });
  assert.doesNotMatch(md, /lin_api/);
});
