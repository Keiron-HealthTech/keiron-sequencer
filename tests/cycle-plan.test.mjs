import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCyclePlan, renderCycleReview } from '../scripts/lib/cycle/plan.mjs';
import { planHash } from '../scripts/lib/harvest.mjs';
import { FIXTURE_SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const NOW = new Date('2026-11-13T12:00:00.000Z');
const TEAM = { id: 'team-abc', key: 'ABC' };
const OTHER = { id: 'team-xyz', key: 'XYZ' };
const A = { id: 'u-a', name: 'Dev A' };
const B = { id: 'u-b', name: 'Dev B' };
const cycle = (n, startsAt, endsAt) => ({ id: `cyc-${n}`, number: n, startsAt, endsAt });
const ACTIVE = cycle(9, '2026-11-02T03:00:00.000Z', '2026-11-16T03:00:00.000Z');
const NEXT = cycle(10, '2026-11-16T03:00:00.000Z', '2026-11-30T03:00:00.000Z');
const PAST = [
  cycle(8, '2026-10-19T03:00:00.000Z', '2026-11-02T03:00:00.000Z'),
  cycle(7, '2026-10-05T03:00:00.000Z', '2026-10-19T03:00:00.000Z'),
  cycle(6, '2026-09-21T03:00:00.000Z', '2026-10-05T03:00:00.000Z'),
];
const DONE = { name: 'Done', type: 'completed' };
const TODO = { name: 'Todo', type: 'unstarted' };
const DOING = { name: 'In Progress', type: 'started' };
const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, dueDate: null,
  archivedAt: null, completedAt: null, state: TODO, projectMilestone: null, labels: { nodes: [] },
  assignee: null, cycle: null, team: TEAM, relations: { nodes: [] }, inverseRelations: { nodes: [] }, ...over,
});
const doneIn = (c, who, identifier, over = {}) => issue(identifier, {
  state: DONE, assignee: who, cycle: { id: c.id, number: c.number },
  completedAt: new Date(Date.parse(c.startsAt) + 86_400_000).toISOString(), ...over,
});
const record = (card, lines) => ({ card, title: `Card ${card}`, origin: 'thin-spike', archived: null, supersededBy: null, size: { prodLines: lines, testLines: 0 } });
// Spiked cards ABC-1..4 set the scale: S 10, M 20, L 30, XL 40 lines.
const RECORDS = [record('ABC-1', 10), record('ABC-2', 20), record('ABC-3', 30), record('ABC-4', 40)];
const HISTORY = [
  // Dev A: cycle 8 = ABC-3 (L 3), cycle 7 = ABC-4 (XL 5), cycle 6 = ABC-31 (guessed L 3) → committed 3, stretch 3.67.
  doneIn(PAST[0], A, 'ABC-3'), doneIn(PAST[1], A, 'ABC-4'), doneIn(PAST[2], A, 'ABC-31', { title: 'Old card' }),
];
const raw = issues => ({ project: { id: 'project-uuid', slug: FIXTURE_SLUG, name: 'Sample Project', url: 'u/p', teams: [TEAM] }, issues, milestones: [], warnings: [] });
const CONTEXT = { members: [{ ...A, displayName: 'deva' }, { ...B, displayName: 'devb' }], active: ACTIVE, next: NEXT, past: PAST };
const plan = (issues, over = {}) => computeCyclePlan({ raw: raw(issues), context: CONTEXT, team: TEAM, records: RECORDS, now: NOW, guesses: { 'ABC-31': 'L' }, ...over });

test('the hash covers guesses, availability and ops, not generatedAt', () => {
  const { plan: p } = plan([...HISTORY, issue('ABC-20')]);
  assert.equal(p.hash, planHash(p));
  const later = plan([...HISTORY, issue('ABC-20')], { now: new Date('2026-11-13T13:00:00.000Z') }).plan;
  assert.equal(later.hash, p.hash);
  const half = plan([...HISTORY, issue('ABC-20')], { availability: { 'u-a': 50 } }).plan;
  assert.notEqual(half.hash, p.hash);
});

test('a guess changes the plan and its hash', () => {
  const base = plan([...HISTORY, issue('ABC-20')]).plan;
  const guessed = plan([...HISTORY, issue('ABC-20')], { guesses: { 'ABC-31': 'L', 'ABC-20': 'XL' } }).plan;
  assert.notEqual(guessed.hash, base.hash);
  assert.deepEqual([guessed.cards.find(c => c.key === 'ABC-20').tier, guessed.cards.find(c => c.key === 'ABC-20').sizeSource], ['XL', 'guess']);
});

test('ops add only committed new cards to the next cycle, and set assignees only where there was none', () => {
  const { plan: p } = plan([
    ...HISTORY,
    issue('ABC-10', { state: DOING, cycle: { id: ACTIVE.id, number: 9 } }),
    issue('ABC-11', { assignee: B }),
    issue('ABC-12'),
    issue('ABC-13'), issue('ABC-14'), issue('ABC-15'), issue('ABC-16'), issue('ABC-17'),
  ]);
  const bands = Object.fromEntries(p.cards.map(c => [c.key, c.band]));
  assert.equal(bands['ABC-10'], 'fixed');
  for (const op of p.ops) {
    const c = p.cards.find(x => x.key === op.card);
    assert.ok(c.band === 'committed' || (c.band === 'fixed' && c.assigns), op.card);
    if (c.band === 'fixed') assert.deepEqual(Object.keys(op.set), ['assigneeId']);
    else assert.equal(op.set.cycleId, NEXT.id);
  }
  const eleven = p.ops.find(o => o.card === 'ABC-11');
  assert.ok(eleven && !('assigneeId' in eleven.set), 'an assigned card keeps its assignee');
  assert.ok(p.cards.some(c => c.band === 'stretch' || c.band === 'left-out'));
  assert.ok(p.ops.every(o => bands[o.card] !== 'stretch'), 'stretch cards are not added');
  assert.deepEqual(p.ops.map(o => o.card), [...p.ops.map(o => o.card)].sort());
});

test('cards of another team are not filled and not counted in history', () => {
  const { plan: p } = plan([...HISTORY, doneIn(PAST[0], A, 'XYZ-1', { team: OTHER }), issue('XYZ-2', { team: OTHER })]);
  assert.ok(!p.cards.some(c => c.key === 'XYZ-2'));
  assert.deepEqual(p.people.find(x => x.id === 'u-a').history, [3, 5, 3]);
});

test('no next cycle refuses the plan', () => {
  const out = computeCyclePlan({ raw: raw(HISTORY), context: { ...CONTEXT, next: null }, team: TEAM, records: RECORDS, now: NOW });
  assert.equal(out.plan, null);
  assert.deepEqual(out.refusals, ['the team has no next cycle']);
});

test('no project members refuses the plan', () => {
  const out = computeCyclePlan({ raw: raw(HISTORY), context: { ...CONTEXT, members: [] }, team: TEAM, records: RECORDS, now: NOW });
  assert.deepEqual(out.refusals, ['the project has no members']);
});

test('needs lists default-sized cards from both the plan and history', () => {
  const { needs } = plan([...HISTORY, doneIn(PAST[0], B, 'ABC-40'), issue('ABC-20')], { guesses: {} });
  assert.deepEqual(needs.map(n => [n.key, n.completed]), [['ABC-20', false], ['ABC-31', true], ['ABC-40', true]]);
});

test('an assignee outside the project members gets a row marked not a member', () => {
  const C = { id: 'u-c', name: 'Dev C' };
  const { plan: p } = plan([...HISTORY, issue('ABC-20', { assignee: C })]);
  assert.equal(p.people.find(x => x.id === 'u-c').member, false);
});

test('the review shows each person, their bands, sizes, reasons, the hash and the apply command', () => {
  const { plan: p } = plan([
    ...HISTORY, doneIn(PAST[1], A, 'ABC-41', { title: 'Guess me' }), doneIn(PAST[2], A, 'ABC-42'),
    issue('ABC-10', { state: DOING, cycle: { id: ACTIVE.id, number: 9 }, assignee: A }),
    issue('ABC-11', { cycle: { id: ACTIVE.id, number: 9 }, assignee: A }),
    issue('ABC-20'), issue('ABC-21', { assignee: A }),
  ], { guesses: { 'ABC-31': 'L', 'ABC-41': 'S', 'ABC-20': 'L' } });
  const md = renderCycleReview(p, { approveCommand: 'node cycle.mjs apply x --approve HASH' });
  for (const text of [
    'Dev A', '100%', 'history 3 · 6 · 5', 'committed 3', 'Dev B', 'capacity guessed, no cycle history',
    '2 of 5 history cards guessed, 1 default', 'over committed by', 'guessed from card', 'default M', 'left out',
    'Dev A is over committed', p.hash, 'node cycle.mjs apply x --approve HASH', 'cards',
  ]) assert.ok(md.includes(text), `review lacks ${JSON.stringify(text)}\n${md}`);
});

test('the review suggests a spike when more than a third of the open cards have no record', () => {
  const { plan: p } = plan([...HISTORY, issue('ABC-20'), issue('ABC-21'), issue('ABC-1')]);
  assert.ok(renderCycleReview(p, { approveCommand: 'x' }).includes('/keiron-sequencer:spike'));
  const { plan: q } = plan([...HISTORY, issue('ABC-1'), issue('ABC-2')]);
  assert.ok(!renderCycleReview(q, { approveCommand: 'x' }).includes('/keiron-sequencer:spike'));
});

test('a card scheduled for a later cycle is left out, not moved', () => {
  const { plan: p } = plan([...HISTORY, issue('ABC-20', { cycle: { id: 'cyc-12', number: 12 } })]);
  const c = p.cards.find(x => x.key === 'ABC-20');
  assert.deepEqual([c.band, c.reason], ['left-out', 'scheduled for cycle 12']);
  assert.ok(!p.ops.some(o => o.card === 'ABC-20'));
});

test('archived completed cards still count in history', () => {
  const archived = HISTORY.map(i => ({ ...i, archivedAt: '2026-11-10T00:00:00.000Z' }));
  assert.deepEqual(plan(archived).plan.people.find(x => x.id === 'u-a').history, [3, 5, 3]);
});

test('needs lists the project members for the availability question', () => {
  assert.deepEqual(plan([...HISTORY]).members, [{ id: 'u-a', name: 'Dev A', displayName: 'deva' }, { id: 'u-b', name: 'Dev B', displayName: 'devb' }]);
});

test('the review marks the current cycle as so far', () => {
  const { plan: p } = plan([...HISTORY, doneIn(ACTIVE, A, 'ABC-4x1', { identifier: 'ABC-50' }), issue('ABC-20')]);
  const a = p.people.find(x => x.id === 'u-a');
  assert.deepEqual([a.cycles, a.history], [[9, 8, 7], [2, 3, 5]]);
  assert.ok(renderCycleReview(p, { approveCommand: 'x' }).includes('cycles 9 so far, 8, 7'));
});

test('built cards: remaining work follows the build, a merged card counts in its merge cycle, the rest in this one', () => {
  const built = new Map([
    ['ABC-10', { kind: 'merged', fraction: 0.1, evidence: 'merged app#7', mergedAt: '2026-10-25T12:00:00.000Z' }],
    ['ABC-11', { kind: 'pr', fraction: 0.25, evidence: 'draft PR app#8', mergedAt: null }],
  ]);
  const issues = [
    ...HISTORY,
    issue('ABC-10', { state: DOING, assignee: A, cycle: { id: ACTIVE.id, number: 9 } }),
    issue('ABC-11', { state: DOING, assignee: A, cycle: { id: ACTIVE.id, number: 9 } }),
  ];
  const { plan: p } = plan(issues, { guesses: { 'ABC-31': 'L', 'ABC-10': 'S', 'ABC-11': 'L' }, built });
  const cards = Object.fromEntries(p.cards.map(c => [c.key, c]));
  assert.deepEqual([cards['ABC-10'].remaining, cards['ABC-10'].built], [0.1, { kind: 'merged', evidence: 'merged app#7' }]);
  assert.deepEqual([cards['ABC-11'].remaining, cards['ABC-11'].fraction], [0.75, 0.25]);
  const a = p.people.find(x => x.id === 'u-a');
  // Cycle 9 so far: 75% of ABC-11 (L 3); cycle 8: ABC-3 (L 3) + ABC-10 merged (S 1); cycle 7: ABC-4 (XL 5).
  assert.deepEqual([a.cycles, a.history, a.builtPoints], [[9, 8, 7], [2.25, 4, 5], 3.25]);
  const md = renderCycleReview(p, { approveCommand: 'apply' });
  assert.ok(md.includes('0.1 (10%, merged app#7)'), md);
  assert.ok(md.includes('(cycles 9 so far, 8, 7, 3.25 pts of it built and not Done in Linear)'), md);
});

test('a build read that failed is a warning in the review', () => {
  const { plan: p } = plan([...HISTORY, issue('ABC-20')], { buildWarnings: ['build state may be incomplete: gh pr list --repo acme/app failed (1): HTTP 502'] });
  const md = renderCycleReview(p, { approveCommand: 'apply' });
  assert.ok(md.includes('> build state may be incomplete: gh pr list --repo acme/app failed (1): HTTP 502. A card the read could not see is sized by its Linear state.'), md);
});

test('a focused milestone ranks first with its open blockers, and the focus is in the inputs, the hash and the review', () => {
  const M1 = { id: 'ms-1', name: '1. First', sortOrder: 1 };
  const M2 = { id: 'ms-2', name: '2. Logs', sortOrder: 2 };
  const issues = [
    ...HISTORY,
    issue('ABC-20', { projectMilestone: { name: M1.name } }),
    issue('ABC-21', { projectMilestone: { name: M1.name }, relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ABC-30' } }] } }),
    issue('ABC-30', { projectMilestone: { name: M2.name } }),
    issue('ABC-31', { projectMilestone: { name: M2.name }, state: DONE }),
  ];
  const withMilestones = over => computeCyclePlan({
    raw: { ...raw(issues), milestones: [M1, M2] }, context: CONTEXT, team: TEAM, records: RECORDS, now: NOW, guesses: { 'ABC-31': 'L' }, ...over,
  }).plan;
  const order = p => p.cards.filter(c => c.kind === 'new').map(c => c.key);
  const plain = withMilestones({});
  const focused = withMilestones({ focus: [M2.name] });
  // Unfocused, the second milestone's card comes last; ABC-21 leads because a card waits on it.
  assert.deepEqual(order(plain), ['ABC-21', 'ABC-20', 'ABC-30']);
  // ABC-30 waits on ABC-21, so the blocker comes forward with it; ABC-20 keeps its place after them.
  assert.deepEqual(order(focused), ['ABC-21', 'ABC-30', 'ABC-20']);
  assert.deepEqual(focused.inputs.focus, [M2.name]);
  assert.notEqual(focused.hash, plain.hash);
  assert.ok(renderCycleReview(focused, { approveCommand: 'apply' }).includes('- Focus: 2. Logs, ranked first with their open blockers'));
});

test('the review offers the options with their apply commands and the recommendation', () => {
  // Dev A: history 3 · 6 · 3 gives committed 3, stretch 4; ABC-20 and ABC-21 fill committed, and ABC-22 fits stretch.
  const extra = doneIn(PAST[1], A, 'ABC-32', { title: 'Old card' });
  const { plan: p } = plan([...HISTORY, extra, issue('ABC-20', { assignee: A }), issue('ABC-21', { assignee: A }), issue('ABC-22', { assignee: A })], {
    guesses: { 'ABC-31': 'L', 'ABC-32': 'S', 'ABC-20': 'S', 'ABC-21': 'M', 'ABC-22': 'S' },
  });
  const bands = Object.fromEntries(p.cards.map(c => [c.key, c.band]));
  assert.deepEqual([bands['ABC-20'], bands['ABC-21'], bands['ABC-22']], ['committed', 'committed', 'stretch']);
  assert.deepEqual(p.stretchOps.map(o => [o.card, o.set.cycleId]), [['ABC-22', NEXT.id]]);
  assert.deepEqual([p.options.options.map(o => o.id), p.options.recommended], [['A', 'B'], 'A']);
  const md = renderCycleReview(p, { approveCommand: 'apply-cmd' });
  assert.ok(md.includes("Recommended: A, because committed is each person's worst recent cycle; stretch cards are next if there is room."), md);
  assert.ok(md.includes('- **A. Committed only (recommended):** 2 cards added. Dev A 3 (committed 3, stretch 4)'), md);
  assert.ok(md.includes('- **B. With stretch:** 3 cards added. Dev A 4 (committed 3, stretch 4)'), md);
  assert.ok(md.includes('`apply-cmd --with-stretch`'), md);
});
