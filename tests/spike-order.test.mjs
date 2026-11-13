import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { analyzeProject } from '../scripts/lib/graph.mjs';
import { existingPrs, offProjectFindings, spikeOrder } from '../scripts/lib/spike/order.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { blocks, issue, notes, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

test('begin orders a two-card chain by its blocks edge, not by the order Linear lists the cards', async () => {
  const { deps } = spikeFixture({ issues: [issue('CRM-3'), issue('CRM-5', { relations: blocks('CRM-3') })] });
  const r = await run(['begin', PROJECT_URL], deps);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).plan.order, ['CRM-5', 'CRM-3']);
});

const MILESTONES = [{ name: 'Second', sortOrder: 2 }, { name: 'First', sortOrder: 1 }];
const inMilestone = name => ({ projectMilestone: { name } });
const done = { state: { name: 'Done', type: 'completed' } };
const orderOf = (issues, milestones = MILESTONES) => spikeOrder(analyzeProject({ issues, milestones }));

test('a dependency beats the card number', () => {
  assert.deepEqual(orderOf([issue('CRM-1100'), issue('CRM-1200', { relations: blocks('CRM-1100') })]).order, ['CRM-1200', 'CRM-1100']);
});

test('free cards are ordered by milestone, then number; a card with no milestone sorts last', () => {
  const issues = [
    issue('CRM-1199'), issue('CRM-1202', inMilestone('Second')), issue('CRM-1201', inMilestone('First')), issue('CRM-1200', inMilestone('First')),
  ];
  assert.deepEqual(orderOf(issues).order, ['CRM-1200', 'CRM-1201', 'CRM-1202', 'CRM-1199']);
});

test('the order does not depend on the order of the input', () => {
  const issues = [
    issue('CRM-10', { ...inMilestone('Second'), relations: blocks('CRM-12', 'CRM-11') }), issue('CRM-11', inMilestone('First')),
    issue('CRM-12', inMilestone('First')), issue('CRM-13', { ...inMilestone('First'), relations: blocks('CRM-11') }), issue('CRM-14'),
  ];
  const forward = orderOf(issues);
  assert.deepEqual(forward.order, ['CRM-13', 'CRM-10', 'CRM-11', 'CRM-12', 'CRM-14']);
  assert.deepEqual(orderOf([...issues].reverse(), [...MILESTONES].reverse()), forward);
});

test('a completed blocker is skipped and gates nothing; started and in-review cards stay in the run', () => {
  const issues = [
    issue('CRM-1', { ...done, relations: blocks('CRM-2') }), issue('CRM-2'),
    issue('CRM-3', { state: { name: 'In Progress', type: 'started' } }), issue('CRM-4', { state: { name: 'In Review', type: 'started' } }),
  ];
  const { order, skipped } = orderOf(issues);
  assert.deepEqual(order, ['CRM-2', 'CRM-3', 'CRM-4']);
  assert.deepEqual(skipped, [{ card: 'CRM-1', reason: 'completed' }]);
});

test('a cycle among run cards is reported; a cycle among completed cards only is not', () => {
  const loop = orderOf([issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2', { relations: blocks('CRM-1') }), issue('CRM-3')]);
  assert.deepEqual(loop.cycles, [['CRM-1', 'CRM-2']]);
  const closed = orderOf([issue('CRM-1', { ...done, relations: blocks('CRM-2') }), issue('CRM-2', { ...done, relations: blocks('CRM-1') }), issue('CRM-3')]);
  assert.deepEqual([closed.cycles, closed.order], [[], ['CRM-3']]);
});

test('a cycle that mixes a completed card with a run card still stops the run: any cycle group that touches the run does', () => {
  const mixed = orderOf([issue('CRM-1', { ...done, relations: blocks('CRM-2') }), issue('CRM-2', { relations: blocks('CRM-1') }), issue('CRM-3')]);
  assert.deepEqual([mixed.cycles, mixed.order], [[['CRM-1', 'CRM-2']], []]);
});

test('an open PR whose title carries [KEY] or (KEY) makes the card existing-pr; a bare number does not', () => {
  const prLists = [
    { repoDir: 'api', prs: [
      { number: 12, title: 'feat: x (CRM-1220)', url: 'https://github.com/o/api/pull/12' },
      { number: 13, title: 'fix 1221 and CRM-1222', url: 'https://github.com/o/api/pull/13' },
      { number: 14, title: '[CRM-12231] other', url: 'https://github.com/o/api/pull/14' },
    ] },
    { repoDir: 'web', prs: [{ number: 7, title: '[CRM-1223] web side', url: 'https://github.com/o/web/pull/7' }] },
  ];
  const found = existingPrs(prLists, ['CRM-1220', 'CRM-1221', 'CRM-1222', 'CRM-1223']);
  assert.deepEqual(Object.fromEntries(found), {
    'CRM-1220': { repoDir: 'api', number: 12, url: 'https://github.com/o/api/pull/12' },
    'CRM-1223': { repoDir: 'web', number: 7, url: 'https://github.com/o/web/pull/7' },
  });
});

test('each off-project blocker becomes a risk finding that names it', () => {
  assert.deepEqual(offProjectFindings(['CRM-900']), [{ kind: 'risk', text: 'Blocked by off-project card CRM-900, still open.', ref: 'linear:CRM-900' }]);
  assert.deepEqual(offProjectFindings([]), []);
});

const PR_LIST = ['pr', 'list', '--repo', 'acme/backend', '--state', 'open', '--limit', '200', '--json', 'number,title,url,isDraft'];

test('begin scans each allowed repo with one read-only gh pr list and marks the tagged card existing-pr', async () => {
  const prs = [{ number: 41, title: 'feat: thing (CRM-2)', url: 'https://github.com/acme/backend/pull/41', isDraft: false }];
  const { deps, gh, home, at } = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')], gh: () => JSON.stringify(prs) });
  const r = await run(['begin', PROJECT_URL], deps);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.calls.map(c => c.argv), [PR_LIST]);
  const { runId } = JSON.parse(r.stdout);
  const state = JSON.parse(readFileSync(join(home, SLUG, 'runs', runId, 'run.json'), 'utf8'));
  assert.deepEqual([state.plan.cards['CRM-1'].origin, state.plan.cards['CRM-1'].pr], ['thin-spike', null]);
  assert.deepEqual([state.plan.cards['CRM-2'].origin, state.plan.cards['CRM-2'].pr], ['existing-pr', { repoDir: 'backend', number: 41, url: prs[0].url }]);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  assert.ok(gh.calls.every(c => ['pr list', 'pr view', 'pr diff'].includes(c.argv.slice(0, 2).join(' '))));
});

test('a failing gh pr list stops begin naming the repo, with no run written', async () => {
  const { deps, home, gh } = spikeFixture();
  const r = await run(['begin', PROJECT_URL], { ...deps, gh: argv => { gh.run(argv); return { status: 1, stdout: '', stderr: 'auth required' }; } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /gh pr list for backend failed \(1\): auth required/);
  assert.deepEqual(walk(home), ['config.json']);
});

test('an off-project blocker keeps the card in the run and lands as a risk finding in its record', async () => {
  const blocked = issue('CRM-1', { inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'CRM-900', archivedAt: null, state: { type: 'unstarted' } } }] } });
  const { deps, home, dataDir, at } = spikeFixture({ issues: [blocked] });
  const { runId, plan } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  assert.deepEqual(plan.order, ['CRM-1']);
  at('2026-11-10T10:01:00.000Z');
  assert.deepEqual(JSON.parse((await run(['next'], deps)).stdout).offProject, ['CRM-900']);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'README.md'), 'changed\n');
  mkdirSync(join(home, SLUG, 'runs', runId, 'notes'), { recursive: true });
  writeFileSync(join(home, SLUG, 'runs', runId, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  const record = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.deepEqual(record.findings, [{ kind: 'risk', text: 'Blocked by off-project card CRM-900, still open.', ref: 'linear:CRM-900' }]);
});

test('begin on a cycle among run cards exits 5 naming its members, with no state, no tree and no PR scan', async () => {
  const { deps, home, gh, repo } = spikeFixture({ issues: [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2', { relations: blocks('CRM-1') })] });
  const r = await run(['begin', PROJECT_URL], deps);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /cycle among the run's cards: CRM-1, CRM-2/);
  assert.deepEqual(walk(home), ['config.json']);
  assert.deepEqual(gh.calls, []);
  assert.equal(repo.git(['worktree', 'list']).trim().split('\n').length, 1);
});

test('begin with a cycle among completed cards only starts normally', async () => {
  const { deps } = spikeFixture({
    issues: [issue('CRM-1', { ...done, relations: blocks('CRM-2') }), issue('CRM-2', { ...done, relations: blocks('CRM-1') }), issue('CRM-3')],
  });
  const r = await run(['begin', PROJECT_URL], deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.plan.order, ['CRM-3']);
  assert.deepEqual(out.plan.skipped.map(s => s.card), ['CRM-1', 'CRM-2']);
});

test('begin on run cards that share a number exits 1 naming the pair, with no state', async () => {
  const { deps, home } = spikeFixture({ issues: [issue('CRM-7'), issue('OPS-7')] });
  const r = await run(['begin', PROJECT_URL], deps);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CRM-7 and OPS-7 share the number 7/);
  assert.deepEqual(walk(home), ['config.json']);
});

test('a rank orders ready entries before milestone and number; with no rank the order is unchanged', () => {
  const issues = [issue('CRM-1', inMilestone('First')), issue('CRM-2', inMilestone('First')), issue('CRM-3', inMilestone('Second')), issue('CRM-4')];
  const analysis = analyzeProject({ issues, milestones: MILESTONES });
  const replay = new Set(['CRM-3', 'CRM-4']);
  const rank = key => (replay.has(key) ? 0 : 1);
  assert.deepEqual(spikeOrder(analysis).order, ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4']);
  assert.deepEqual(spikeOrder(analysis, { rank }).order, ['CRM-3', 'CRM-4', 'CRM-1', 'CRM-2']);
  const reversed = analyzeProject({ issues: [...issues].reverse(), milestones: [...MILESTONES].reverse() });
  assert.deepEqual(spikeOrder(reversed, { rank }), spikeOrder(analysis, { rank }));
});

test('a ranked spike entry still waits for the entry that blocks it', () => {
  const issues = [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3')];
  const rank = key => (key === 'CRM-2' ? 0 : 1);
  assert.deepEqual(spikeOrder(analyzeProject({ issues, milestones: [] }), { rank }).order, ['CRM-1', 'CRM-2', 'CRM-3']);
});

test('edges from cards outside the given set hold back no dependent', () => {
  const issues = [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2', { state: { name: 'In Review', type: 'started' }, relations: blocks('CRM-3') }), issue('CRM-3')];
  const analysis = analyzeProject({ issues, milestones: [] });
  const entries = { ...analysis, cards: analysis.cards.filter(c => c.key !== 'CRM-2') };
  const rank = key => (key === 'CRM-3' ? 0 : 1);
  assert.deepEqual(spikeOrder(entries, { rank }).order, ['CRM-3', 'CRM-1']);
});
