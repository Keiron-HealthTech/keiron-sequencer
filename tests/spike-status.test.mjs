import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { fakeSetup } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import {
  activeRunDir, appendTranscript, call, issue, playCard, PROJECT_URL, spikeFixture, twoRepoFixture, usageEntry, walk,
} from './helpers/spike-fixture.mjs';

guardNetwork();

// Every file of the home and the data dir, with its content.
const everything = fixture => [fixture.home, fixture.dataDir].map(root => walk(root).map(f => [f, readFileSync(join(root, f), 'utf8')]));

test('status shows the run, the execution, the current card\'s live spend against its box, open trees and unsettled windows, and writes nothing', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const session = join(fixture.transcripts, '-work', 'session-1.jsonl');
  fixture.at('2026-11-10T10:00:00.000Z');
  const { runId } = JSON.parse((await call(fixture, ['begin', PROJECT_URL, '--box', '100', '--max-cards', '3'], { session })).stdout);
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', session, w: [30] });
  fixture.at('2026-11-10T10:06:00.000Z');
  await call(fixture, ['next'], { session });
  appendTranscript(session, [usageEntry('live', '2026-11-10T10:07:00.000Z', 90)]);
  const dir = activeRunDir(fixture.home);
  const before = everything(fixture);

  fixture.at('2026-11-10T10:08:00.000Z');
  const r = await run(['status'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, {
    action: 'status',
    runId,
    status: 'active',
    project: { slug: out.project.slug, name: 'Tracer project' },
    execution: {
      id: 1, startedAt: '2026-11-10T10:00:00.000Z', endedAt: null, endReason: null, caps: { tokens: null, cards: 3 }, box: 100,
      spent: { cards: 1, tokens: 30 }, sessions: [session],
    },
    current: { card: 'CRM-2', startedAt: '2026-11-10T10:06:00.000Z', box: 100, spent: 90, over: false },
    cards: { done: ['CRM-1'], inProgress: ['CRM-2'], pending: [] },
    trees: [{ repo: 'backend', kind: 'worktree', status: 'open', path: join(dir, 'trees', 'backend') }],
    unsettled: [],
  });
  assert.deepEqual(everything(fixture), before);
});

test('status lists a tree whose setup failed and says unmeasured, never 0, without a session', async () => {
  const fixture = twoRepoFixture();
  const config = JSON.parse(readFileSync(join(fixture.home, 'config.json'), 'utf8'));
  config.repos.frontend.setup = [['make', 'deps']];
  writeFileSync(join(fixture.home, 'config.json'), JSON.stringify(config));
  fixture.at('2026-11-10T10:00:00.000Z');
  await call(fixture, ['begin', PROJECT_URL, '--box', '100']);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  assert.equal((await run(['tree', 'frontend'], { ...fixture.deps, runSetup: fakeSetup({ 'make deps': 1 }).run })).code, 1);
  const dir = activeRunDir(fixture.home);
  const before = everything(fixture);

  const out = JSON.parse((await run(['status'], fixture.deps)).stdout);
  assert.deepEqual(out.current, { card: 'CRM-1', startedAt: '2026-11-10T10:01:00.000Z', box: 100, spent: 'unmeasured' });
  assert.deepEqual(out.execution.spent, { cards: 0, tokens: 'unmeasured' });
  assert.deepEqual(out.trees, [{ repo: 'frontend', kind: 'worktree', status: 'setup', path: join(dir, 'trees', 'frontend') }]);
  assert.deepEqual(everything(fixture), before);
});

test('status reports the windows still unsettled', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const session = join(fixture.transcripts, '-work', 'session-1.jsonl');
  await call(fixture, ['begin', PROJECT_URL], { session });
  await playCard(fixture, 'CRM-1', { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', session, w: [30], settle: false });
  const out = JSON.parse((await run(['status'], fixture.deps)).stdout);
  assert.deepEqual(out.unsettled, [{ card: 'CRM-1', execution: 1, end: '2026-11-10T10:05:00.000Z' }]);
  assert.equal(out.current, null);
  assert.equal((await run(['status', 'extra'], fixture.deps)).code, 2);
});

test('status of a respike run lists each replay entry with its outcome and its mode, and no diff content', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2'), issue('CRM-3'), issue('CRM-4'), issue('CRM-5')] });
  await call(fixture, ['begin', PROJECT_URL]);
  const dir = activeRunDir(fixture.home);
  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const entry = card => ({ from: '20261101T100000Z', patches: [`backend/0000${card.at(-1)}-new.patch`], dropped: [], sharedWith: [], units: {}, replanned: false });
  state.plan.respike = {
    approve: 'abcdefabcdef', previous: { runId: '20261101T100000Z' }, selection: { mode: 'cards', cards: [{ key: 'CRM-5', why: 'picked' }] }, built: [], bases: {},
    replay: Object.fromEntries(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'].map(k => [k, entry(k)])), map: { open: [], completed: [] },
  };
  const modes = { 'CRM-1': 'replay', 'CRM-2': 'replay', 'CRM-3': 'spike', 'CRM-4': 'replay', 'CRM-5': 'spike' };
  for (const [k, mode] of Object.entries(modes)) state.plan.cards[k].mode = mode;
  const at = '2026-11-10T10:00:00.000Z';
  Object.assign(state.cards['CRM-1'], { status: 'done', replay: { status: 'replayed', at, applied: ['backend/00001-new.patch'], folded: [] } });
  Object.assign(state.cards['CRM-2'], { status: 'done', replay: { status: 'empty', at, applied: ['backend/00002-new.patch'], folded: [] } });
  state.cards['CRM-3'].replay = {
    status: 'conflict', at, applied: [], folded: [],
    conflict: { repo: 'backend', patch: 'backend/00003-new.patch', reason: 'conflict', unmerged: ['src/list.js'] },
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(state));

  const r = await run(['status'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.replays, [
    { card: 'CRM-1', mode: 'replay', status: 'replayed' },
    { card: 'CRM-2', mode: 'replay', status: 'empty' },
    { card: 'CRM-3', mode: 'spike', status: 'conflict' },
    { card: 'CRM-4', mode: 'replay', status: 'pending' },
  ]);
  for (const marker of ['diff --git', '+++ b/', '--- a/', '@@ -']) assert.equal(r.stdout.includes(marker), false, marker);
});

test('status of a plain run has no replay list', async () => {
  const fixture = spikeFixture();
  await call(fixture, ['begin', PROJECT_URL]);
  const out = JSON.parse((await run(['status'], fixture.deps)).stdout);
  assert.equal(Object.hasOwn(out, 'replays'), false);
  assert.equal(Object.hasOwn(out, 'modes'), false);
});
