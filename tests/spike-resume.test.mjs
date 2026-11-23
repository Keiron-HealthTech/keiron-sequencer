import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { join } from 'node:path';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import {
  activeRunDir, appendTranscript, call, issue, notes, playCard, PROJECT_URL, SLUG, spikeFixture, usageEntry, walk,
} from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const fixtureOf = n => spikeFixture({ issues: Array.from({ length: n }, (_, i) => issue(`CRM-${i + 1}`)) });
const stateIn = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const recordOf = (fixture, card) => JSON.parse(readFileSync(join(fixture.dataDir, SLUG, `${card}.json`), 'utf8'));
const sessionIn = (fixture, name) => join(fixture.transcripts, '-work', `${name}.jsonl`);
const snapshotOf = (fixture, dir) => Object.fromEntries([
  ...walk(fixture.dataDir).map(f => [`data/${f}`, readFileSync(join(fixture.dataDir, f), 'utf8')]),
  ...walk(join(dir, 'patches')).map(f => [`patches/${f}`, readFileSync(join(dir, 'patches', f), 'utf8')]),
]);

async function begin(fixture, flags, session, at) {
  fixture.at(at);
  const r = await call(fixture, ['begin', PROJECT_URL, ...flags], { session });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a resumed run gets a fresh cap budget, keeps its run id, and leaves the done cards\' records and patches untouched', async () => {
  const fixture = fixtureOf(3);
  const first = sessionIn(fixture, 'session-1');
  const { runId } = await begin(fixture, ['--max-tokens', '100'], first, '2026-11-10T10:00:00.000Z');
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', session: first, w: [150] });
  fixture.at('2026-11-10T10:06:00.000Z');
  assert.equal(JSON.parse((await call(fixture, ['next'], { session: first })).stdout).reason, 'tokens');
  const dir = activeRunDir(fixture.home);
  const before = snapshotOf(fixture, dir);

  const second = sessionIn(fixture, 'session-2');
  const resumed = await begin(fixture, ['--max-tokens', '100'], second, '2026-11-10T11:00:00.000Z');
  assert.deepEqual([resumed.runId, resumed.resumed], [runId, true]);
  const { out, ended } = await playCard(fixture, 'CRM-2', { start: '2026-11-10T11:01:00.000Z', end: '2026-11-10T11:05:00.000Z', session: second, w: [60] });
  assert.equal(out.card, 'CRM-2');
  assert.equal(ended.code, 0, ended.stderr);
  fixture.at('2026-11-10T11:06:00.000Z');
  const brief = JSON.parse((await call(fixture, ['next'], { session: second })).stdout);
  assert.equal(brief.card, 'CRM-3', 'the second execution spent 60 of a fresh 100');

  const after = snapshotOf(fixture, dir);
  for (const [name, text] of Object.entries(before)) assert.equal(after[name], text, name);
  assert.deepEqual(readdirSync(join(fixture.home, SLUG, 'runs')), [runId]);
});

test('an interrupted card is resumed: its window closes at the last transcript entry, a new window opens, and the box carries over', async () => {
  const fixture = fixtureOf(2);
  const first = sessionIn(fixture, 'session-1');
  await begin(fixture, ['--box', '100'], first, '2026-11-10T10:00:00.000Z');
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next'], { session: first });
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  writeFileSync(join(tree, 'CRM-1.txt'), 'half done\n');
  appendTranscript(first, [usageEntry('a', '2026-11-10T10:02:00.000Z', 70), usageEntry('b', '2026-11-10T10:03:00.000Z', 10)]);

  const second = sessionIn(fixture, 'session-2');
  await begin(fixture, ['--box', '500'], second, '2026-11-10T11:00:00.000Z');
  const dir = activeRunDir(fixture.home);
  const interrupted = stateIn(dir);
  assert.equal(interrupted.tracks.t1.current, null);
  assert.equal(interrupted.cards['CRM-1'].status, 'in-progress');
  assert.deepEqual(interrupted.cards['CRM-1'].windows.map(({ mark, ...w }) => w), [{
    execution: 1, start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:03:00.000Z', endReason: 'interrupted', settled: true, messages: 2,
    tokens: { input: 80, cacheCreation: 0, cacheRead: 0, output: 0, thinking: 0 }, w: 80,
  }]);
  assert.deepEqual(interrupted.executions[0].endReason, 'interrupted');

  const { out, ended } = await playCard(fixture, 'CRM-1', { start: '2026-11-10T11:01:00.000Z', end: '2026-11-10T11:05:00.000Z', session: second, w: [40] });
  assert.deepEqual([out.card, out.resumed], ['CRM-1', true]);
  assert.equal(ended.code, 0, ended.stderr);
  const state = stateIn(dir);
  assert.deepEqual(state.cards['CRM-1'].windows.map(w => [w.execution, w.start, w.end]), [
    [1, '2026-11-10T10:01:00.000Z', '2026-11-10T10:03:00.000Z'], [2, '2026-11-10T11:01:00.000Z', '2026-11-10T11:05:00.000Z'],
  ]);
  assert.equal(state.cards['CRM-1'].box, 100);
  const record = recordOf(fixture, 'CRM-1');
  assert.deepEqual(record.timeBox, { budget: 100, spent: 120, over: true });
  assert.deepEqual(record.effort.windows.map(w => w.tokens.input), [80, 40]);
  assert.match(readFileSync(join(dir, 'patches', 'backend', '00001-new.patch'), 'utf8'), /^\+CRM-1$/m);

  const { out: next } = await playCard(fixture, 'CRM-2', { start: '2026-11-10T11:10:00.000Z', end: '2026-11-10T11:15:00.000Z', session: second, w: [1] });
  assert.equal(next.card, 'CRM-2');
  assert.equal(stateIn(dir).cards['CRM-2'].box, 500);
});

test('an interrupted card with no transcript activity after its start drops that empty window', async () => {
  const fixture = fixtureOf(1);
  const first = sessionIn(fixture, 'session-1');
  await begin(fixture, [], first, '2026-11-10T10:00:00.000Z');
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  appendTranscript(first, [usageEntry('before', '2026-11-10T10:00:30.000Z', 9)]);
  await begin(fixture, [], sessionIn(fixture, 'session-2'), '2026-11-10T11:00:00.000Z');
  assert.deepEqual(stateIn(activeRunDir(fixture.home)).cards['CRM-1'].windows, []);
});

test('an interrupted card whose execution bound no session closes its window at the last mark, unmeasured, and its record keeps effort null', async () => {
  const fixture = fixtureOf(1);
  await begin(fixture, [], null, '2026-11-10T10:00:00.000Z');
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  await begin(fixture, [], null, '2026-11-10T11:00:00.000Z');
  const dir = activeRunDir(fixture.home);
  const [window] = stateIn(dir).cards['CRM-1'].windows;
  assert.deepEqual([window.end, window.endReason, window.w], [stateIn(dir).executions[0].mark.issuedAt, 'interrupted', undefined]);

  const { ended } = await playCard(fixture, 'CRM-1', { start: '2026-11-10T11:01:00.000Z', end: '2026-11-10T11:05:00.000Z' });
  assert.equal(ended.code, 0, ended.stderr);
  assert.equal(JSON.parse(ended.stdout).usage, 'unmeasured');
  assert.equal(recordOf(fixture, 'CRM-1').effort, null);
});

test('begin checks the config before resuming: an invalid config stops the resume naming the problem and changes nothing', async () => {
  const fixture = fixtureOf(1);
  await begin(fixture, [], null, '2026-11-10T10:00:00.000Z');
  const dir = activeRunDir(fixture.home);
  const state = readFileSync(join(dir, 'run.json'), 'utf8');
  const config = JSON.parse(readFileSync(join(fixture.home, 'config.json'), 'utf8'));
  config.repos.backend.url = 'file:///elsewhere';
  writeFileSync(join(fixture.home, 'config.json'), JSON.stringify(config));
  fixture.at('2026-11-10T11:00:00.000Z');
  const r = await call(fixture, ['begin', PROJECT_URL]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /backend.*exactly one of checkout and url/);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), state);
});

test('begin on a project whose last run is complete reports nothing to do and starts no run', async () => {
  const fixture = fixtureOf(1);
  const { runId } = await begin(fixture, [], null, '2026-11-10T10:00:00.000Z');
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z' });
  fixture.at('2026-11-10T10:06:00.000Z');
  assert.equal(JSON.parse((await call(fixture, ['next'])).stdout).action, 'complete');
  fixture.at('2026-11-10T12:00:00.000Z');
  const r = await call(fixture, ['begin', PROJECT_URL]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'nothing-to-do', runId, project: { slug: SLUG, name: 'Tracer project' } });
  assert.deepEqual(readdirSync(join(fixture.home, SLUG, 'runs')), [runId]);
});

test('resume runs the tree guard: a tree with a commit stops begin with exit 6 and changes nothing', async () => {
  const fixture = fixtureOf(2);
  await begin(fixture, [], null, '2026-11-10T10:00:00.000Z');
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', cardNotes: notes });
  const dir = activeRunDir(fixture.home);
  const tree = stateIn(dir).tracks.t1.repos.backend.path;
  sandboxGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'oops'], { cwd: tree });
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  fixture.at('2026-11-10T11:00:00.000Z');
  const r = await call(fixture, ['begin', PROJECT_URL]);
  assert.equal(r.code, 6);
  assert.match(r.stderr, /tree guard: the backend tree/);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('a respike run paused by its card cap resumes through spike begin with the same id, the same plan and its pending cards, and no hash', async () => {
  const [C, D, X] = ['CRM-5', 'CRM-6', 'CRM-4'];
  const f = R.respikeFixture({
    issues: ([a, b]) => [a, b, R.issue(C), R.issue(D, { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: X } }] } }),
      R.issue(X, { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: R.B } }] } })],
  });
  const patchX = 'backend/00004-new.patch';
  writeFileSync(join(f.home, R.SLUG, 'runs', R.OLD_RUN, 'patches', patchX), ['diff --git a/x.txt b/x.txt', 'new file mode 100644', '--- /dev/null', '+++ b/x.txt', '@@ -0,0 +1 @@', '+x', ''].join('\n'));
  writeFileSync(join(f.dataDir, R.SLUG, `${X}.json`), serializeRecord(R.oldRecord(X, { spikedAt: '2026-11-01T10:40:00.000Z', patches: [patchX] })));
  const pick = [R.PROJECT_URL, '--cards', `${R.B},${C},${D}`];
  const plan = JSON.parse((await f.run('preflight', pick)).stdout);
  assert.deepEqual(plan.order.map(e => `${e.key}:${e.mode}`), [`${R.A}:replay`, `${C}:spike`, `${D}:spike`, `${X}:spike`, `${R.B}:spike`]);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse((await f.run('begin', [...pick, '--approve', plan.approve, '--max-cards', '1'])).stdout);
  const dir = join(f.home, R.SLUG, 'runs', runId);
  f.at('2026-11-10T10:02:00.000Z');
  assert.equal(JSON.parse((await f.spike(['next', '--track', 't2'])).stdout).card, C);
  const tree = JSON.parse((await f.spike(['tree', 'backend', '--track', 't2'])).stdout).path;
  writeFileSync(join(tree, 'c.txt'), 'c\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${C}.json`), JSON.stringify(R.notes(C)));
  f.at('2026-11-10T10:03:00.000Z');
  assert.equal((await f.spike(['end', C, '--track', 't2'])).code, 0);
  f.at('2026-11-10T10:04:00.000Z');
  assert.equal(JSON.parse((await f.spike(['next', '--track', 't1'])).stdout).reason, 'cards');
  const paused = stateIn(dir);
  assert.equal(paused.status, 'paused');
  assert.deepEqual([paused.cards[X].status, paused.plan.cards[X].mode], ['pending', 'spike']);

  f.at('2026-11-10T10:05:00.000Z');
  const linearCalls = f.linear.sent.length;
  const resumed = await f.spike(['begin', R.PROJECT_URL]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual([JSON.parse(resumed.stdout).runId, JSON.parse(resumed.stdout).resumed], [runId, true]);
  const after = stateIn(dir);
  assert.deepEqual(after.plan, paused.plan);
  assert.equal(after.status, 'active');
  assert.ok(f.linear.sent.length - linearCalls <= 1);
  f.at('2026-11-10T10:06:00.000Z');
  assert.equal(JSON.parse((await f.spike(['next', '--track', 't1'])).stdout).card, D);
});

test('a pause keeps the card in progress, so its in-flight end still records it; begin then hands out the next card', async () => {
  const fixture = fixtureOf(2);
  const session = sessionIn(fixture, 'session-1');
  await begin(fixture, [], session, '2026-11-10T10:00:00.000Z');
  fixture.at('2026-11-10T10:01:00.000Z');
  assert.equal(JSON.parse((await call(fixture, ['next'], { session })).stdout).card, 'CRM-1');
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  writeFileSync(join(tree, 'CRM-1.txt'), 'CRM-1\n');
  const dir = activeRunDir(fixture.home);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  fixture.at('2026-11-10T10:02:00.000Z');
  assert.equal((await call(fixture, ['pause'])).code, 0);
  assert.equal(stateIn(dir).tracks.t1.current.card, 'CRM-1');

  fixture.at('2026-11-10T10:03:00.000Z');
  const ended = await call(fixture, ['end', 'CRM-1']);
  assert.equal(ended.code, 0, ended.stderr);
  const state = stateIn(dir);
  assert.deepEqual([state.status, state.cards['CRM-1'].status, state.tracks.t1.current], ['paused', 'done', null]);
  const window = state.cards['CRM-1'].windows.at(-1);
  assert.deepEqual([window.end, window.endReason], ['2026-11-10T10:03:00.000Z', undefined]);
  assert.equal(recordOf(fixture, 'CRM-1').card, 'CRM-1');

  await begin(fixture, [], sessionIn(fixture, 'session-2'), '2026-11-10T11:00:00.000Z');
  fixture.at('2026-11-10T11:01:00.000Z');
  assert.equal(JSON.parse((await call(fixture, ['next'])).stdout).card, 'CRM-2');
});

test('a schema-1 run with its tree at trees/<repoDir> resumes, and its card ends and completes there', async () => {
  const fixture = fixtureOf(1);
  await begin(fixture, [], sessionIn(fixture, 'session-1'), '2026-11-10T10:00:00.000Z');
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  const opened = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  const dir = activeRunDir(fixture.home);
  const old = join(dir, 'trees', 'backend');
  const { tracks, crossings, combine, workers, checks, ...rest } = stateIn(dir);
  sandboxGit(['worktree', 'move', opened, old], { cwd: tracks.t1.repos.backend.source });
  delete rest.plan.edges;
  delete rest.plan.tracks;
  const repos = { backend: { ...tracks.t1.repos.backend, path: old } };
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...rest, schemaVersion: 1, current: tracks.t1.current, repos }));
  writeFileSync(join(old, 'CRM-1.txt'), 'CRM-1\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));

  await begin(fixture, [], sessionIn(fixture, 'session-2'), '2026-11-10T11:00:00.000Z');
  fixture.at('2026-11-10T11:01:00.000Z');
  const brief = JSON.parse((await call(fixture, ['next'])).stdout);
  assert.deepEqual([brief.card, brief.resumed, brief.trees], ['CRM-1', true, { backend: old }]);
  fixture.at('2026-11-10T11:02:00.000Z');
  const ended = await call(fixture, ['end', 'CRM-1']);
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(JSON.parse(ended.stdout).patches, ['backend/00001-new.patch']);
  assert.match(readFileSync(join(dir, 'patches', 'backend', '00001-new.patch'), 'utf8'), /\+CRM-1/);
  assert.equal(recordOf(fixture, 'CRM-1').card, 'CRM-1');
  const state = stateIn(dir);
  assert.deepEqual([state.schemaVersion, state.tracks.t1.repos.backend.path], [2, old]);
  assert.equal(existsSync(join(dir, 'trees', 't1', 'backend')), false);

  fixture.at('2026-11-10T11:03:00.000Z');
  const done = JSON.parse((await call(fixture, ['next'])).stdout);
  assert.equal(done.action, 'complete');
  assert.deepEqual(done.removed.map(r => r.path), [old]);
});
