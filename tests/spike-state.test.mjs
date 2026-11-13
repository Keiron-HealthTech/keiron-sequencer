import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { runDir } from '../scripts/lib/spike/home.mjs';
import {
  activeRunFor, CARD_STATUSES, createRun, openCardWindow, openExecution, readState, RUN_STATUSES, saveState, timeBoxFor,
} from '../scripts/lib/spike/state.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, PROJECT_URL, SLUG, spikeFixture } from './helpers/spike-fixture.mjs';

guardNetwork();

const HOME = tempDir('keiron-sequencer-state-');
after(() => rmSync(HOME, { recursive: true, force: true }));

const NOW = new Date('2026-11-10T10:00:00.000Z');
const planned = (key, origin = 'thin-spike') => ({
  title: key, url: `https://linear.app/x/issue/${key}`, number: Number(key.split('-')[1]), milestoneOrder: null,
  description: '', origin, pr: null, offProject: [],
});
const plan = (keys, origins = {}) => ({
  fetchedAt: NOW.toISOString(), order: keys, skipped: [], cards: Object.fromEntries(keys.map(k => [k, planned(k, origins[k])])),
});
const project = (slug = 'p1') => ({ id: `${slug}-uuid`, slug, name: `Project ${slug}`, url: `https://linear.app/x/project/${slug}` });
const newRun = (keys = ['CRM-1', 'CRM-2'], { origins, slug, runId = '20261110T100000Z' } = {}) =>
  createRun({ runId, project: project(slug), plan: plan(keys, origins), home: HOME, dataDir: '/data', now: NOW });

test('the status values are fixed, a new run is active and its cards pending with no box yet', () => {
  assert.deepEqual(RUN_STATUSES, ['active', 'paused', 'complete', 'abandoned']);
  assert.deepEqual(CARD_STATUSES, ['pending', 'in-progress', 'done']);
  const state = newRun();
  assert.equal(state.status, 'active');
  assert.deepEqual(state.cards['CRM-1'], { status: 'pending', box: null, windows: [], patches: [] });
});

test('two run cards with the same number are refused, naming the pair', () => {
  assert.throws(() => newRun(['CRM-7', 'ABC-7']), /CRM-7 and ABC-7 share the number 7/);
});

test('the state round-trips through run.json and keeps unknown keys across a transition', () => {
  const state = newRun();
  state.future = { a: 1 };
  state.cards['CRM-1'].extra = 'kept';
  state.plan.cards['CRM-1'].extra = [1];
  const dir = runDir(HOME, 'p1', state.runId);
  saveState(dir, state, NOW);
  const read = readState(dir);
  assert.deepEqual(read, state);
  const execution = openExecution(read, { now: NOW, sessions: [] });
  openCardWindow(read, 'CRM-1', execution, NOW);
  saveState(dir, read, NOW);
  const again = readState(dir);
  assert.deepEqual([again.future, again.cards['CRM-1'].extra, again.plan.cards['CRM-1'].extra], [{ a: 1 }, 'kept', [1]]);
  assert.equal(again.cards['CRM-1'].status, 'in-progress');
});

test('the box is fixed from the execution that opens the first window and never changes afterwards', () => {
  const state = newRun();
  const first = openExecution(state, { now: NOW, sessions: [] });
  first.box = 100;
  openCardWindow(state, 'CRM-1', first, NOW);
  assert.equal(state.cards['CRM-1'].box, 100);
  state.current = null;
  const second = openExecution(state, { now: NOW, sessions: [] });
  second.box = 500;
  openCardWindow(state, 'CRM-1', second, NOW);
  assert.equal(state.cards['CRM-1'].box, 100);
  assert.equal(state.cards['CRM-1'].windows.length, 2);
  state.current = null;
  openCardWindow(state, 'CRM-2', second, NOW);
  assert.equal(state.cards['CRM-2'].box, 500);
  const none = newRun(['CRM-3']);
  openCardWindow(none, 'CRM-3', openExecution(none, { now: NOW, sessions: [] }), NOW);
  assert.equal(none.cards['CRM-3'].box, null);
});

test('an existing-pr card never gets a box, whatever the execution offers', () => {
  const state = newRun(['CRM-1'], { origins: { 'CRM-1': 'existing-pr' } });
  const execution = openExecution(state, { now: NOW, sessions: [] });
  execution.box = 100;
  openCardWindow(state, 'CRM-1', execution, NOW);
  assert.equal(state.cards['CRM-1'].box, null);
  assert.equal(timeBoxFor(state.cards['CRM-1']), null);
});

test('timeBoxFor is null without a box; spent is the rounded sum of every window and over is strict', () => {
  const card = (box, ...ws) => ({ status: 'done', box, windows: ws.map(w => ({ w })), patches: [] });
  assert.equal(timeBoxFor(card(null, 10)), null);
  assert.deepEqual(timeBoxFor(card(100, 60.2, 39.7)), { budget: 100, spent: 100, over: false });
  assert.deepEqual(timeBoxFor(card(100, 60.2, 40.4)), { budget: 100, spent: 101, over: true });
  assert.deepEqual(timeBoxFor(card(100, 140)), { budget: 100, spent: 140, over: true });
  assert.deepEqual(timeBoxFor(card(100, 60)), { budget: 100, spent: 60, over: false });
  assert.equal(timeBoxFor(card(100, 60, undefined)), null, 'an unmeasured window never counts as zero spend');
});

test('a project has at most one non-complete run; a complete one does not count', () => {
  const dir = id => runDir(HOME, 'p2', id);
  const a = newRun(['CRM-1'], { slug: 'p2', runId: '20261110T100000Z' });
  saveState(dir(a.runId), a, NOW);
  assert.equal(activeRunFor(HOME, 'p2').state.runId, a.runId);
  assert.equal(activeRunFor(HOME, 'nope'), null);
  const b = newRun(['CRM-1'], { slug: 'p2', runId: '20261111T100000Z' });
  saveState(dir(b.runId), b, NOW);
  assert.throws(() => activeRunFor(HOME, 'p2'), /more than one non-complete run for p2: 20261110T100000Z, 20261111T100000Z/);
  b.status = 'complete';
  saveState(dir(b.runId), b, NOW);
  assert.equal(activeRunFor(HOME, 'p2').state.runId, a.runId);
});

test('with active runs in two projects, next, tree and end need --project, which takes a slug or a project URL', async () => {
  const { home, deps, at } = spikeFixture();
  assert.equal((await run(['begin', PROJECT_URL], deps)).code, 0);
  const other = createRun({ runId: '20261110T090000Z', project: project('ffffffffffff'), plan: plan(['OPS-9']), home, dataDir: '/data', now: NOW });
  saveState(runDir(home, 'ffffffffffff', other.runId), other, NOW);
  at('2026-11-10T10:01:00.000Z');
  for (const argv of [['next'], ['tree', 'backend'], ['end', 'CRM-1']]) {
    const r = await run(argv, deps);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.stderr, /more than one active spike run: .*pass --project/, argv.join(' '));
  }
  const brief = await run(['next', '--project', SLUG], deps);
  assert.equal(brief.code, 0, brief.stderr);
  assert.equal(JSON.parse(brief.stdout).card, 'CRM-1');
  const tree = await run(['tree', 'backend', '--project', PROJECT_URL], deps);
  assert.equal(tree.code, 0, tree.stderr);
  const unknown = await run(['next', '--project', '000000000000'], deps);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no active spike run for project 000000000000/);
  const untouched = JSON.parse(readFileSync(join(runDir(home, 'ffffffffffff', other.runId), 'run.json'), 'utf8'));
  assert.equal(untouched.current, null);
});

test('the respike plan keys, the replay outcomes and a combine base survive save, pause, resume and abandon', async () => {
  const { home, deps, at } = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = runDir(home, SLUG, runId);
  const state = readState(dir);
  state.plan.respike = {
    approve: 'abcdefabcdef', previous: { runId: '20261101T100000Z' }, selection: { mode: 'cards', cards: [{ key: 'CRM-2', why: 'picked' }] },
    built: [], bases: { backend: { kind: 'default', ref: 'origin/main', sha: null, card: null, heads: null, tree: null, behind: null } },
    replay: { 'CRM-1': { from: '20261101T100000Z', patches: ['backend/00001-new.patch'], dropped: [], sharedWith: [], units: { backend: ['backend/00001-new.patch'] }, replanned: false } },
    map: { open: ['CRM-1', 'CRM-2'], completed: [] },
  };
  state.plan.cards['CRM-1'].mode = 'spike';
  state.plan.cards['CRM-2'].mode = 'spike';
  state.cards['CRM-1'].replay = {
    status: 'conflict', at: NOW.toISOString(), applied: [], folded: [], before: { size: null, riskAreas: null, newPaths: [] },
    conflict: { repo: 'backend', patch: 'backend/00001-new.patch', reason: 'conflict', unmerged: ['src/a.js'] },
  };
  state.repos.extra = { status: 'removed', combine: { heads: [{ card: 'CRM-7', sha: 'a'.repeat(40) }], tree: 'b'.repeat(40) } };
  saveState(dir, state, NOW);
  const kept = s => [s.plan.respike, s.plan.cards['CRM-1'].mode, s.cards['CRM-1'].replay, s.repos.extra.combine];
  const expected = kept(state);

  at('2026-11-10T10:01:00.000Z');
  const brief = JSON.parse((await run(['next'], deps)).stdout);
  assert.equal(brief.card, 'CRM-1');
  assert.deepEqual(kept(readState(dir)), expected);
  assert.equal((await run(['pause'], deps)).code, 0);
  assert.deepEqual(kept(readState(dir)), expected);
  const resumed = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(kept(readState(dir)), expected);
  assert.equal((await run(['abandon', '--discard'], deps)).code, 0);
  assert.deepEqual(kept(readState(dir)), expected);
});
