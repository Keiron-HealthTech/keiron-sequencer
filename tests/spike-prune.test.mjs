import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { runDir, TRIAL_DIR, trialPatchRoot } from '../scripts/lib/spike/home.mjs';
import { pruneRuns } from '../scripts/lib/spike/prune.mjs';
import { activeRuns, createRun, saveState } from '../scripts/lib/spike/state.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { call, playCard, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

const NOW = new Date('2026-11-10T10:00:00.000Z');
const IDS = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z'];
const FOUR_LAST = '20261104T000000Z';

function homeWith(runs, { slug = 'p1', home = tempDir('keiron-sequencer-prune-') } = {}) {
  after(() => rmSync(home, { recursive: true, force: true }));
  for (const [runId, status, trees = false] of runs) {
    const plan = { fetchedAt: NOW.toISOString(), order: [], skipped: [], cards: {} };
    const state = createRun({ runId, project: { id: 'x', slug, name: 'P', url: 'u' }, plan, home, dataDir: '/data', now: NOW });
    state.status = status;
    if (trees) state.repos.backend = { path: join(runDir(home, slug, runId), 'trees', 'backend'), status: 'open' };
    saveState(runDir(home, slug, runId), state, NOW);
    mkdirSync(join(runDir(home, slug, runId), 'patches', 'backend'), { recursive: true });
    writeFileSync(join(runDir(home, slug, runId), 'patches', 'backend', '00001-new.patch'), 'x\n');
  }
  return home;
}

const runsOf = (home, slug = 'p1') => walk(join(home, slug)).filter(f => f.endsWith('run.json')).map(f => f.split('/')[1]);

test('with three runs prune removes only the oldest; with one or two it removes nothing', () => {
  const home = homeWith(IDS.map(id => [id, 'complete']));
  assert.deepEqual(pruneRuns(home, 'p1'), { slug: 'p1', removed: [IDS[0]], skipped: [] });
  assert.deepEqual(runsOf(home), IDS.slice(1));
  assert.deepEqual(pruneRuns(home, 'p1').removed, []);
  const single = homeWith([[IDS[0], 'abandoned']]);
  assert.deepEqual(pruneRuns(single, 'p1').removed, []);
  assert.deepEqual(pruneRuns(homeWith([]), 'p1').removed, []);
});

test('an old run that is not complete and still has trees is kept and reported', () => {
  const home = homeWith([[IDS[0], 'paused', true], [IDS[1], 'complete'], [IDS[2], 'complete']]);
  assert.deepEqual(pruneRuns(home, 'p1'), { slug: 'p1', removed: [], skipped: [{ runId: IDS[0], reason: 'paused with trees' }] });
  assert.deepEqual(runsOf(home), IDS);
});

test('prune never touches the trial patches, another project, or names that are not run ids', () => {
  const home = homeWith(IDS.map(id => [id, 'complete']));
  const trial = join(trialPatchRoot(home, 'p1'), 'backend');
  mkdirSync(trial, { recursive: true });
  writeFileSync(join(trial, '01183-new.patch'), 'x\n');
  const strays = ['notes', '20261101T000000Z-copy', '2026110T000000Z', '19991231T235959'];
  for (const name of strays) {
    mkdirSync(join(home, 'p1', 'runs', name), { recursive: true });
    writeFileSync(join(home, 'p1', 'runs', name, 'keep.txt'), 'x\n');
  }
  for (const id of IDS) {
    mkdirSync(runDir(home, 'p2', id), { recursive: true });
    writeFileSync(join(runDir(home, 'p2', id), 'keep.txt'), 'x\n');
  }
  pruneRuns(home, 'p1');
  assert.deepEqual(walk(join(home, 'p1', TRIAL_DIR)), ['backend/01183-new.patch']);
  assert.deepEqual(walk(join(home, 'p2')).length, 3);
  for (const name of strays) assert.ok(existsSync(join(home, 'p1', 'runs', name, 'keep.txt')), name);
  assert.deepEqual(runsOf(home), IDS.slice(1));
  assert.throws(() => pruneRuns(home, '../p2'), /not a project slug/);
});

test('prune --dry-run lists what it would remove and deletes nothing; prune with no slug covers every project', async () => {
  const home = homeWith(IDS.map(id => [id, 'complete']));
  const dry = await run(['prune', 'p1', '--dry-run'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { action: 'prune', dryRun: true, projects: [{ slug: 'p1', removed: [IDS[0]], skipped: [] }] });
  assert.deepEqual(runsOf(home), IDS);
  const all = await run(['prune'], { home });
  assert.deepEqual(JSON.parse(all.stdout).projects.map(p => [p.slug, p.removed]), [['p1', [IDS[0]]]]);
  assert.deepEqual(runsOf(home), IDS.slice(1));
  assert.equal((await run(['prune', '../x'], { home })).code, 2);
});

test('prune and the open-run scan leave config.json.bak alone and never take it for a run', async () => {
  const home = homeWith([[IDS[0], 'complete'], [IDS[1], 'paused', true], [IDS[2], 'complete'], [FOUR_LAST, 'complete']]);
  writeFileSync(join(home, 'config.json'), '{"schemaVersion": 1}\n');
  writeFileSync(join(home, 'config.json.bak'), '{"schemaVersion": 1, "old": true}\n');
  assert.deepEqual(activeRuns(home).map(r => r.state.runId), [IDS[1]]);
  assert.deepEqual(pruneRuns(home, 'p1').removed, [IDS[0]]);
  const all = await run(['prune'], { home });
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout).projects.map(p => p.slug), ['p1']);
  assert.equal(readFileSync(join(home, 'config.json.bak'), 'utf8'), '{"schemaVersion": 1, "old": true}\n');
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{"schemaVersion": 1}\n');
  assert.deepEqual(walk(home).filter(f => !f.startsWith('p1/')), ['config.json', 'config.json.bak']);
});

test('completion prunes the project\'s runs and prints what it removed', async () => {
  const fixture = spikeFixture();
  homeWith([[IDS[0], 'abandoned'], [IDS[1], 'abandoned']], { slug: SLUG, home: fixture.home });
  const begun = JSON.parse((await call(fixture, ['begin', PROJECT_URL])).stdout);
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z' });
  fixture.at('2026-11-10T10:06:00.000Z');
  const out = JSON.parse((await call(fixture, ['next'])).stdout);
  assert.equal(out.action, 'complete');
  assert.deepEqual(out.pruned, [IDS[0]]);
  assert.deepEqual(runsOf(fixture.home, SLUG), [IDS[1], begun.runId]);
});

const FOUR = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z'];

function dataWith(records) {
  const dataDir = tempDir('keiron-sequencer-prune-data-');
  after(() => rmSync(dataDir, { recursive: true, force: true }));
  for (const [path, value] of Object.entries(records)) {
    mkdirSync(join(dataDir, 'p1', path, '..'), { recursive: true });
    writeFileSync(join(dataDir, 'p1', path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dataDir;
}

const naming = (card, runId, extra = {}) => ({ card, refs: { patches: [], runId }, ...extra });

test('a run named by a live record is kept past the two newest; history and archived records keep nothing', () => {
  const home = homeWith(FOUR.map(id => [id, 'complete']));
  const dataDir = dataWith({
    'CRM-1.json': naming('CRM-1', FOUR[0]),
    'CRM-2.json': naming('CRM-2', FOUR[1], { archived: { at: '2026-11-05', reason: 'gone' } }),
    'spike/history/CRM-3/2026-11-01T00-00-00.000Z.json': naming('CRM-3', FOUR[1]),
  });
  assert.deepEqual(pruneRuns(home, 'p1', { dataDir }), { slug: 'p1', removed: [FOUR[1]], skipped: [] });
  assert.deepEqual(runsOf(home), [FOUR[0], FOUR[2], FOUR[3]]);
});

test('a history record alone does not keep its run', () => {
  const home = homeWith(FOUR.map(id => [id, 'complete']));
  const dataDir = dataWith({ 'spike/history/CRM-3/2026-11-01T00-00-00.000Z.json': naming('CRM-3', FOUR[0]) });
  assert.deepEqual(pruneRuns(home, 'p1', { dataDir }).removed, [FOUR[0], FOUR[1]]);
});

test('an unreadable top-level record makes prune delete nothing and name the file', () => {
  const home = homeWith(FOUR.map(id => [id, 'complete']));
  const dataDir = dataWith({ 'CRM-1.json': naming('CRM-1', FOUR[0]), 'CRM-9.json': '{not json' });
  const out = pruneRuns(home, 'p1', { dataDir });
  assert.deepEqual(out.removed, []);
  assert.equal(out.unreadable.length, 1);
  assert.match(out.unreadable[0], /CRM-9\.json/);
  assert.deepEqual(runsOf(home), FOUR);
});

test('with a data dir, --dry-run lists the unreferenced runs and deletes nothing', async () => {
  const home = homeWith(FOUR.map(id => [id, 'complete']));
  const dataDir = dataWith({ 'CRM-1.json': naming('CRM-1', FOUR[0]) });
  const dry = await run(['prune', 'p1', '--dry-run'], { home, dataDir });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).projects, [{ slug: 'p1', removed: [FOUR[1]], skipped: [] }]);
  assert.deepEqual(runsOf(home), FOUR);
});

test('completion keeps an old run that a live record still names', async () => {
  const fixture = spikeFixture();
  homeWith([[IDS[0], 'abandoned'], [IDS[1], 'abandoned']], { slug: SLUG, home: fixture.home });
  mkdirSync(join(fixture.dataDir, SLUG), { recursive: true });
  writeFileSync(join(fixture.dataDir, SLUG, 'CRM-7.json'), JSON.stringify(naming('CRM-7', IDS[0])));
  await call(fixture, ['begin', PROJECT_URL]);
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z' });
  fixture.at('2026-11-10T10:06:00.000Z');
  const out = JSON.parse((await call(fixture, ['next'])).stdout);
  assert.equal(out.action, 'complete');
  assert.deepEqual(out.pruned, []);
  assert.ok(runsOf(fixture.home, SLUG).includes(IDS[0]));
});
