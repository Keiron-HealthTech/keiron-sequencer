import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../scripts/lib/next/free.mjs';
import { STACK_COSTS } from '../scripts/lib/start/base.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SHA = 'a'.repeat(40);
const repo = (name, github, checkout) => ({ name, github, checkout, url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [] });
const CONFIG = { schemaVersion: 1, repos: { app: repo('app-repo', 'acme/app', '/src/app'), web: repo('web-repo', 'acme/web', '/src/web') } };

const card = (key, over = {}) => ({
  key, title: `app-repo: Card ${key}`, url: `https://linear.app/x/issue/${key}`, status: 'Todo', statusType: 'unstarted',
  milestone: 'M1', milestoneOrder: 1, milestoneTargetDate: null, dueDate: null, estimate: null, assignee: null, labels: [],
  attachments: [], size: null, downstream: 0, offMapBlockers: [], rank: Number(key.split('-')[1]), due: null, deadline: null,
  deadlineFrom: null, ...over,
});
const done = (key, over) => card(key, { status: 'Done', statusType: 'completed', rank: null, ...over });
const overdue = { deadline: 'overdue', deadlineFrom: 'card', dueDate: '2026-11-01', due: 'overdue' };

const pr = (n, over = {}) => ({
  repoDir: 'app', github: 'acme/app', number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main',
  headRefName: `crm-${n}-x`, title: `[CRM-${n}] x`, url: `https://github.com/acme/app/pull/${n}`, via: 'open', ...over,
});
const merged = (n, over) => pr(n, { state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z', ...over });

const work = ({ heads = ['main'], configuredLocal = ['main'], local = [], failed = [], contains = () => null } = {}) => ({
  repos: new Map(['app', 'web'].map(dir => [dir, {
    path: `/src/${dir}`, contains, heads: Object.fromEntries(heads.map(h => [h, SHA])),
    checkout: { branches: { local: configuredLocal, remote: heads }, tracking: Object.fromEntries(heads.map(h => [h, SHA])) },
  }])),
  local: local.map(l => ({ repoDir: 'app', kind: 'branch', ...l })),
  failed: new Map(failed),
});

const run = ({ cards, edges = [], critical = [], criticalTies = [], offMap = new Map(), descriptions = new Map(), prs = [], failed = [], failedFor = [], w = work(), viewer = { id: 'me', name: 'Me' } }) =>
  classify({ cards, edges, critical, criticalTies, offMap, descriptions, viewer, prs: { byKey: new Map(prs), failed: new Map(failed), failedFor: new Map(failedFor) }, work: w, config: CONFIG });
const freeKeys = out => out.free.map(f => f.key);
const reasonOf = (out, key) => out.overdue.find(o => o.key === key)?.reason;
const blocks = (from, to) => ({ from, to });

test('only backlog and unstarted cards can be free', () => {
  const out = run({ cards: [card('CRM-1'), card('CRM-2', { statusType: 'backlog' }), card('CRM-3', { status: 'In Progress', statusType: 'started', ...overdue })] });
  assert.deepEqual(freeKeys(out), ['CRM-1', 'CRM-2']);
  assert.equal(reasonOf(out, 'CRM-3'), 'started-linear');
});

test('someone else\'s card is not free; mine and unassigned are', () => {
  const out = run({ cards: [card('CRM-1', { assignee: { id: 'me', name: 'Me' } }), card('CRM-2'), card('CRM-3', { assignee: { id: 'u9', name: 'Ana' }, ...overdue })] });
  assert.deepEqual(freeKeys(out), ['CRM-1', 'CRM-2']);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason, o.detail]), [['CRM-3', 'assigned-other', 'Ana']]);
});

test('a Discovery card and a No lleva PR card are excluded', () => {
  const out = run({
    cards: [card('CRM-1', { labels: ['Discovery'], ...overdue }), card('CRM-2', overdue), card('CRM-3')],
    descriptions: new Map([['CRM-2', 'Investigación. No lleva PR.']]),
  });
  assert.deepEqual(freeKeys(out), ['CRM-3']);
  assert.deepEqual(out.overdue.map(o => o.reason), ['excluded', 'excluded']);
});

test('a draft, an open and a merged PR each take the card; merged is left out of overdue', () => {
  const out = run({
    cards: [card('CRM-1', overdue), card('CRM-2', overdue), card('CRM-3', overdue), card('CRM-4')],
    prs: [['CRM-1', [pr(1, { isDraft: true })]], ['CRM-2', [pr(2)]], ['CRM-3', [merged(3)]]],
  });
  assert.deepEqual(freeKeys(out), ['CRM-4']);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason]), [['CRM-1', 'taken'], ['CRM-2', 'in-review']]);
});

test('a local worktree or a pushed branch with the id takes the card', () => {
  const out = run({
    cards: [card('CRM-1', overdue), card('CRM-2', overdue), card('CRM-3')],
    w: work({ heads: ['main', 'crm-2-pushed'], local: [{ path: '/src/app-wt', branch: 'crm-1-wip', kind: 'worktree' }] }),
  });
  assert.deepEqual(freeKeys(out), ['CRM-3']);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason]), [['CRM-1', 'started-local'], ['CRM-2', 'started-remote']]);
  assert.match(out.overdue[0].detail, /\/src\/app-wt/);
});

test('an attachment PR takes the card when the title lacks the tag', () => {
  const out = run({ cards: [card('CRM-1')], prs: [['CRM-1', [pr(40, { title: 'untagged', via: 'attachment' })]]] });
  assert.deepEqual(freeKeys(out), []);
});

test('a blocker done in Linear, or merged into the default branch, frees the card on the default base', () => {
  const out = run({
    cards: [done('CRM-1'), card('CRM-2', { status: 'Self QA', statusType: 'started' }), card('CRM-3'), card('CRM-4')],
    edges: [blocks('CRM-1', 'CRM-3'), blocks('CRM-2', 'CRM-4')],
    prs: [['CRM-2', [merged(2)]]],
  });
  assert.deepEqual(freeKeys(out), ['CRM-3', 'CRM-4']);
  for (const f of out.free) assert.deepEqual(f.base, { kind: 'default', ref: 'origin/main', pr: null, costs: [] });
});

test('one open blocker PR: free, stacked on its head, with the costs', () => {
  const out = run({ cards: [card('CRM-1', { statusType: 'started' }), card('CRM-2')], edges: [blocks('CRM-1', 'CRM-2')], prs: [['CRM-1', [pr(1)]]] });
  const [f] = out.free;
  assert.equal(f.key, 'CRM-2');
  assert.deepEqual(f.base, { kind: 'stack', ref: 'origin/crm-1-x', pr: { number: 1, url: 'https://github.com/acme/app/pull/1' }, costs: STACK_COSTS });
});

test('two independent open blockers: not free, waiting-reviews', () => {
  const out = run({
    cards: [card('CRM-1', { statusType: 'started' }), card('CRM-2', { statusType: 'started' }), card('CRM-3', overdue)],
    edges: [blocks('CRM-1', 'CRM-3'), blocks('CRM-2', 'CRM-3')],
    prs: [['CRM-1', [pr(1)]], ['CRM-2', [pr(2)]]],
    w: work({ heads: ['main', 'crm-1-x', 'crm-2-x'], contains: () => false }),
  });
  assert.deepEqual(freeKeys(out), []);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason]), [['CRM-3', 'waiting-reviews']]);
});

test('containment unknown: free, base null, unverified names the unfetched heads', () => {
  const out = run({
    cards: [card('CRM-1', { statusType: 'started' }), card('CRM-2', { statusType: 'started' }), card('CRM-3')],
    edges: [blocks('CRM-1', 'CRM-3'), blocks('CRM-2', 'CRM-3')],
    prs: [['CRM-1', [pr(1)]], ['CRM-2', [pr(2)]]],
  });
  const [f] = out.free;
  assert.deepEqual([f.key, f.base], ['CRM-3', null]);
  assert.match(f.unverified, /not fetched/);
});

test('a blocker branch only in another clone is not stackable', () => {
  const out = run({
    cards: [card('CRM-1', { statusType: 'started' }), card('CRM-2', overdue)],
    edges: [blocks('CRM-1', 'CRM-2')],
    w: work({ local: [{ path: '/src/app-pr11', branch: 'crm-1-wip' }] }),
  });
  assert.deepEqual(freeKeys(out), []);
  assert.equal(reasonOf(out, 'CRM-2'), 'blocked');
  assert.match(out.overdue[0].detail, /crm-1-wip.*\/src\/app-pr11.*push/);
});

test('a blocker branch local in the configured checkout is stackable with the local cost', () => {
  const out = run({ cards: [card('CRM-1', { statusType: 'started' }), card('CRM-2')], edges: [blocks('CRM-1', 'CRM-2')],
    w: work({ configuredLocal: ['main', 'crm-1-wip'], local: [{ path: '/src/app', branch: 'crm-1-wip' }] }) });
  assert.equal(out.free[0].base.kind, 'stack');
  assert.equal(out.free[0].base.ref, 'refs/heads/crm-1-wip');
});

test('a text dependency blocks, names itself in textBlockers, and warns when Linear lacks it', () => {
  const out = run({
    cards: [card('CRM-1', { statusType: 'started' }), card('CRM-2'), card('CRM-3')],
    descriptions: new Map([['CRM-2', 'Depende de CRM-1'], ['CRM-3', 'Nada']]),
    prs: [['CRM-1', [pr(1)]]],
  });
  assert.deepEqual(freeKeys(out), ['CRM-2', 'CRM-3']);
  assert.equal(out.free[0].base.kind, 'stack');
  assert.deepEqual(out.free[0].textBlockers, ['CRM-1']);
  assert.ok(out.warnings.some(w => w.kind === 'text-only-dependency' && /move it to Linear: CRM-1 blocks CRM-2/.test(w.message)));
});

test('a text dependency Linear already has through a chain counts once and gives no warning', () => {
  const out = run({
    cards: [done('CRM-1'), done('CRM-2'), card('CRM-3')],
    edges: [blocks('CRM-1', 'CRM-2'), blocks('CRM-2', 'CRM-3')],
    descriptions: new Map([['CRM-3', 'Depende de CRM-1']]),
  });
  assert.deepEqual(out.free[0].textBlockers, []);
  assert.equal(out.warnings.filter(w => w.kind === 'text-only-dependency').length, 0);
});

test('an off-map QA or planner blocker never blocks; an open off-map card does', () => {
  const off = (key, over) => ({ key, title: `Card ${key}`, description: '', archivedAt: null, state: { name: 'Todo', type: 'unstarted' }, labels: [], attachments: [], ...over });
  const out = run({
    cards: [card('CRM-1', { offMapBlockers: ['OPS-1'] }), card('CRM-2', { offMapBlockers: ['OPS-2'], ...overdue }), card('CRM-3', { offMapBlockers: ['OPS-3'] })],
    offMap: new Map([['OPS-1', off('OPS-1', { labels: ['QA'] })], ['OPS-2', off('OPS-2')], ['OPS-3', off('OPS-3', { labels: ['map'] })]]),
  });
  assert.deepEqual(freeKeys(out), ['CRM-1', 'CRM-3']);
  assert.deepEqual([reasonOf(out, 'CRM-2'), out.overdue[0].detail], ['blocked', 'OPS-2']);
});

test('a gh failure in one repo marks only the cards that needed it unverified', () => {
  const out = run({
    cards: [card('CRM-1'), card('CRM-2', { title: 'web-repo: Card CRM-2' })],
    failed: [['acme/web', 'gh pr list --repo acme/web failed (1): HTTP 502']],
  });
  assert.deepEqual(out.free.map(f => [f.key, f.unverified === null]), [['CRM-1', true], ['CRM-2', false]]);
  assert.match(out.free[1].unverified, /HTTP 502/);
  assert.equal(out.free[1].base, null);
  assert.ok(out.warnings.some(w => w.kind === 'github-unavailable'));
});

test('deployado en QA puts a check on the free card', () => {
  const out = run({ cards: [done('CRM-1'), card('CRM-2')], edges: [blocks('CRM-1', 'CRM-2')], descriptions: new Map([['CRM-2', 'Necesita CRM-1 deployado en QA']]) });
  assert.deepEqual(out.free[0].checks, ['CRM-1 must be live in QA']);
});

test('a card whose repo is unknown gets base null and a warning', () => {
  const out = run({ cards: [card('CRM-1', { title: 'Card with no repo' })] });
  assert.deepEqual([out.free[0].repo, out.free[0].base], [null, null]);
  assert.ok(out.warnings.some(w => w.key === 'CRM-1' && w.kind === 'repo-unknown'));
});

test('overdue lists only overdue cards that are not free, and free is sorted by rank with its facts', () => {
  const out = run({
    cards: [card('CRM-3', { ...overdue, rank: 1 }), card('CRM-1', { rank: 2, deferrable: undefined }), card('CRM-2', { statusType: 'started' })],
    critical: ['CRM-1'], descriptions: new Map([['CRM-1', 'Carta elástica']]),
  });
  assert.deepEqual(freeKeys(out), ['CRM-3', 'CRM-1']);
  assert.deepEqual(out.overdue, []);
  const f = out.free[1];
  assert.deepEqual([f.critical, f.deferrable, f.repo, f.checks, f.textBlockers, f.unverified], [true, true, 'app-repo', [], [], null]);
});

test('a card whose repo is unknown is still blocked by an unstarted blocker, or one with no PR or branch', () => {
  const out = run({
    cards: [card('CRM-1'), card('CRM-2', { title: 'Card 2', ...overdue }), card('CRM-3', { status: 'In Progress', statusType: 'started' }), card('CRM-4', { title: 'Card 4', ...overdue })],
    edges: [blocks('CRM-1', 'CRM-2'), blocks('CRM-3', 'CRM-4')],
  });
  assert.deepEqual(freeKeys(out), ['CRM-1']);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason]), [['CRM-2', 'blocked'], ['CRM-4', 'blocked']]);
});

test('a card whose repo is unknown, with one pushed blocker branch, is free with base null', () => {
  const out = run({
    cards: [card('CRM-3', { status: 'In Progress', statusType: 'started' }), card('CRM-4', { title: 'Card 4' })],
    edges: [blocks('CRM-3', 'CRM-4')],
    w: work({ heads: ['main', 'crm-3-x'] }),
  });
  assert.deepEqual(out.free.map(f => [f.key, f.base]), [['CRM-4', null]]);
});

test('a failed attachment view marks only its own card unverified', () => {
  const out = run({ cards: [card('CRM-1'), card('CRM-2')], failedFor: [['CRM-2', 'gh pr view other/repo#9 failed (1): HTTP 404']] });
  assert.deepEqual(out.free.map(f => [f.key, f.unverified === null]), [['CRM-1', true], ['CRM-2', false]]);
});

test('a failed repo matches the config whatever its case', () => {
  const out = run({ cards: [card('CRM-1')], failed: [['Acme/App', 'HTTP 502']] });
  assert.match(out.free[0].unverified, /HTTP 502/);
});

test('a triage card is not free, and says it is in triage, not started', () => {
  const out = run({ cards: [card('CRM-1', { status: 'Triage', statusType: 'triage', ...overdue })] });
  assert.deepEqual(freeKeys(out), []);
  assert.deepEqual(out.overdue.map(o => [o.reason, o.detail]), [['triage', 'Linear says Triage: accept it into the backlog first']]);
});

test('a note from the local scan is a warning and taints no card', () => {
  const w = work();
  w.notes = [{ key: 'web', kind: 'github-only', message: 'web: no checkout configured: GitHub only' }];
  const out = run({ cards: [card('CRM-1', { title: 'web-repo: Card CRM-1' })], w });
  assert.equal(out.free[0].unverified, null);
  assert.ok(out.warnings.some(x => x.kind === 'github-only'));
});
