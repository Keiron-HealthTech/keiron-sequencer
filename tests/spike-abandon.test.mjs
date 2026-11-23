import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { fakeSetup, sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appendTranscript, call, issue, playCard, PROJECT_URL, SLUG, spikeFixture, usageEntry } from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const fixtureOf = (n, over) => spikeFixture({ issues: Array.from({ length: n }, (_, i) => issue(`CRM-${i + 1}`)), ...over });
const stateIn = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const runDirOf = (fixture, runId) => join(fixture.home, SLUG, 'runs', runId);
const worktrees = cwd => sandboxGit(['worktree', 'list', '--porcelain'], { cwd }).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));

async function begin(fixture, session = null) {
  const r = await call(fixture, ['begin', PROJECT_URL], { session });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).runId;
}

test('pause ends the execution mid-card and keeps the trees; the card resumes in a new window after begin', async () => {
  const fixture = fixtureOf(2);
  const session = join(fixture.transcripts, '-work', 'session-1.jsonl');
  const runId = await begin(fixture, session);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next'], { session });
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  writeFileSync(join(tree, 'CRM-1.txt'), 'half\n');
  appendTranscript(session, [usageEntry('a', '2026-11-10T10:02:00.000Z', 25)]);

  fixture.at('2026-11-10T10:03:00.000Z');
  const r = await call(fixture, ['pause'], { session });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(Object.keys(out)[0], 'mark');
  assert.deepEqual([out.action, out.reason, out.runId], ['pause', 'paused', runId]);
  const state = stateIn(runDirOf(fixture, runId));
  assert.equal(state.status, 'paused');
  assert.deepEqual([state.executions[0].endReason, state.executions[0].endedAt], ['paused', '2026-11-10T10:03:00.000Z']);
  assert.equal(state.tracks.t1.current.card, 'CRM-1');
  assert.equal(state.cards['CRM-1'].status, 'in-progress');
  const [window] = state.cards['CRM-1'].windows;
  assert.deepEqual([window.end, window.endReason, window.w], ['2026-11-10T10:03:00.000Z', 'paused', 25]);
  assert.ok(existsSync(join(tree, 'CRM-1.txt')));

  assert.match((await call(fixture, ['next'])).stderr, /CRM-1 is still in progress: end it first/);
  assert.match((await call(fixture, ['pause'])).stderr, /already paused/);
  fixture.at('2026-11-10T11:00:00.000Z');
  await begin(fixture);
  const { out: brief, ended } = await playCard(fixture, 'CRM-1', { start: '2026-11-10T11:01:00.000Z', end: '2026-11-10T11:05:00.000Z' });
  assert.deepEqual([brief.card, brief.resumed], ['CRM-1', true]);
  assert.equal(ended.code, 0, ended.stderr);
});

test('an abandon after a pause leaves the window the pause closed as it was', async () => {
  const fixture = fixtureOf(1);
  const runId = await begin(fixture);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  await call(fixture, ['tree', 'backend']);
  fixture.at('2026-11-10T10:03:00.000Z');
  assert.equal((await call(fixture, ['pause'])).code, 0);
  fixture.at('2026-11-10T12:00:00.000Z');
  assert.equal((await call(fixture, ['abandon'])).code, 0);
  const state = stateIn(runDirOf(fixture, runId));
  const window = state.cards['CRM-1'].windows.at(-1);
  assert.deepEqual([window.end, window.endReason, state.tracks.t1.current], ['2026-11-10T10:03:00.000Z', 'paused', null]);
});

test('abandon tears the trees down, marks the run abandoned and keeps its patches and records; the next begin starts a new run', async () => {
  const fixture = fixtureOf(2);
  const runId = await begin(fixture);
  const { dir } = await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z' });
  const tree = stateIn(dir).tracks.t1.repos.backend.path;
  fixture.at('2026-11-10T10:06:00.000Z');
  const r = await call(fixture, ['abandon']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(Object.keys(out)[0], 'mark');
  assert.deepEqual([out.action, out.runId, out.removed], ['abandon', runId, [{ repo: 'backend', kind: 'worktree', path: tree, prunePending: false }]]);
  assert.equal(existsSync(tree), false);
  assert.deepEqual(worktrees(fixture.repo.dir), [fixture.repo.dir]);
  const state = stateIn(dir);
  assert.equal(state.status, 'abandoned');
  assert.equal(state.executions.at(-1).endReason, 'abandoned');
  assert.ok(existsSync(join(dir, 'patches', 'backend', '00001-new.patch')));
  assert.ok(existsSync(join(fixture.dataDir, SLUG, 'CRM-1.json')));

  fixture.at('2026-11-10T12:00:00.000Z');
  const again = JSON.parse((await call(fixture, ['begin', PROJECT_URL])).stdout);
  assert.equal(again.resumed, false);
  assert.notEqual(again.runId, runId);
});

test('abandon refuses unsnapshotted work unless --discard is given, and then removes the tree', async () => {
  const fixture = fixtureOf(1);
  const runId = await begin(fixture);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  writeFileSync(join(tree, 'wip.txt'), 'never ended\n');
  const dir = runDirOf(fixture, runId);
  const before = readFileSync(join(dir, 'run.json'), 'utf8');

  const refused = await call(fixture, ['abandon']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /backend.*not snapshotted.*--discard/);
  assert.ok(existsSync(join(tree, 'wip.txt')));
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);

  const discarded = await call(fixture, ['abandon', '--discard']);
  assert.equal(discarded.code, 0, discarded.stderr);
  assert.equal(existsSync(tree), false);
  const state = stateIn(dir);
  assert.deepEqual([state.status, state.tracks.t1.current, state.cards['CRM-1'].windows[0].endReason], ['abandoned', null, 'abandoned']);
});

test('abandon removes a tree whose setup failed, and never deletes a path the spike did not make', async () => {
  const fixture = fixtureOf(1, {
    config: config => ({ ...config, repos: { backend: { ...config.repos.backend, setup: [['make', 'deps']] } } }),
  });
  const runId = await begin(fixture);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  const failed = await run(['tree', 'backend'], { ...fixture.deps, runSetup: fakeSetup({ 'make deps': 2 }).run });
  assert.equal(failed.code, 1);
  const dir = runDirOf(fixture, runId);
  const { path } = stateIn(dir).tracks.t1.repos.backend;
  assert.equal(stateIn(dir).tracks.t1.repos.backend.status, 'setup');

  const foreign = stateIn(dir);
  foreign.tracks.t1.repos.backend.path = fixture.repo.dir;
  writeFileSync(join(dir, 'run.json'), JSON.stringify(foreign));
  const refused = await call(fixture, ['abandon', '--discard']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refusing to delete/);
  assert.ok(existsSync(join(fixture.repo.dir, 'README.md')));

  foreign.tracks.t1.repos.backend.path = path;
  writeFileSync(join(dir, 'run.json'), JSON.stringify(foreign));
  const r = await call(fixture, ['abandon', '--discard']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(path), false);
  assert.equal(stateIn(dir).tracks.t1.repos.backend.status, 'removed');
  assert.deepEqual(readdirSync(join(fixture.home, SLUG, 'runs')), [runId]);
});

test('abandon deletes a worktree whose source checkout is gone and reports worktree prune pending', async () => {
  const fixture = fixtureOf(1);
  const runId = await begin(fixture);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  fixture.repo.dispose();

  const r = await call(fixture, ['abandon']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.removed, [{ repo: 'backend', kind: 'worktree', path: tree, prunePending: true }]);
  assert.match(out.warnings.join(' '), /backend.*worktree prune/);
  assert.equal(existsSync(tree), false);
  assert.equal(stateIn(runDirOf(fixture, runId)).status, 'abandoned');
});

test('abandon mid-card completes when the session file is gone, leaving the run abandoned with its trees removed', async () => {
  const fixture = fixtureOf(1);
  const session = join(fixture.transcripts, '-work', 'session-1.jsonl');
  const runId = await begin(fixture, session);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next'], { session });
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  rmSync(session);

  fixture.at('2026-11-10T10:03:00.000Z');
  const r = await call(fixture, ['abandon', '--discard']);
  assert.equal(r.code, 0, r.stderr);
  const state = stateIn(runDirOf(fixture, runId));
  assert.equal(state.status, 'abandoned');
  assert.equal(state.tracks.t1.current, null);
  assert.ok(Object.values(state.tracks.t1.repos).every(x => x.status === 'removed'));
  assert.equal(existsSync(tree), false);
});

test('a run left with its trees deleted and its state open can be abandoned again', async () => {
  const fixture = fixtureOf(1);
  const runId = await begin(fixture);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  rmSync(tree, { recursive: true, force: true });

  const r = await call(fixture, ['abandon', '--discard']);
  assert.equal(r.code, 0, r.stderr);
  const state = stateIn(runDirOf(fixture, runId));
  assert.equal(state.status, 'abandoned');
  assert.ok(Object.values(state.tracks.t1.repos).every(x => x.status === 'removed'));
});

test('abandoning a respike run after one clean replay keeps its run dir, since the replayed record references it, and prune keeps it', async () => {
  const f = R.respikeFixture();
  for (const id of ['20261111T100000Z', '20261112T100000Z']) {
    mkdirSync(join(f.home, R.SLUG, 'runs', id), { recursive: true });
    writeFileSync(join(f.home, R.SLUG, 'runs', id, 'run.json'), JSON.stringify({ runId: id, status: 'complete', project: { slug: R.SLUG }, repos: {} }));
  }
  const pick = [R.PROJECT_URL, '--cards', R.B];
  const plan = JSON.parse((await f.run('preflight', pick)).stdout);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse((await f.run('begin', [...pick, '--approve', plan.approve])).stdout);
  f.at('2026-11-10T10:02:00.000Z');
  assert.deepEqual(JSON.parse((await f.spike(['next'])).stdout).replayed.map(r => r.status), ['replayed']);
  const abandoned = await f.spike(['abandon']);
  assert.equal(abandoned.code, 0, abandoned.stderr);
  const pruned = await f.spike(['prune', R.SLUG]);
  assert.equal(pruned.code, 0, pruned.stderr);
  const runs = readdirSync(join(f.home, R.SLUG, 'runs')).sort();
  assert.ok(runs.includes(runId), JSON.stringify(runs));
  const record = JSON.parse(readFileSync(join(f.dataDir, R.SLUG, `${R.A}.json`), 'utf8'));
  assert.equal(record.refs.runId, runId);
  for (const p of record.refs.patches) assert.ok(existsSync(join(f.home, R.SLUG, 'runs', runId, 'patches', p)), p);
});
