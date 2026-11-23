import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { capReached } from '../scripts/lib/spike/state.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import {
  activeRunDir, appendTranscript, call, issue, playCard, PROJECT_URL, SLUG, spikeFixture, usageEntry,
} from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const keys = n => Array.from({ length: n }, (_, i) => `CRM-${i + 1}`);
const fixtureOf = (n, over = {}) => spikeFixture({ issues: keys(n).map(k => issue(k)), ...over });
const stateIn = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const recordOf = (fixture, card) => JSON.parse(readFileSync(join(fixture.dataDir, SLUG, `${card}.json`), 'utf8'));
const minute = m => `2026-11-10T1${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:00.000Z`;

async function begin(fixture, flags = [], { session = join(fixture.transcripts, '-work', 'session-1.jsonl') } = {}) {
  const r = await call(fixture, ['begin', PROJECT_URL, ...flags], { session });
  assert.equal(r.code, 0, r.stderr);
  return { session, runId: JSON.parse(r.stdout).runId };
}

// Plays cards back to back, one every ten minutes from 10:01, each costing the given weighted tokens.
async function play(fixture, session, costs, from = 1) {
  const results = [];
  for (const [i, w] of costs.entries()) {
    const m = from + i * 10;
    const r = await playCard(fixture, `CRM-${results.length + from}`, { start: minute(m), end: minute(m + 5), session, w: [w] });
    results.push(r);
  }
  return results;
}

const nextAt = async (fixture, m, session) => {
  fixture.at(minute(m));
  return call(fixture, ['next'], { session });
};

test('a token cap lets the card that crosses it finish, then pauses before the next card, keeping the trees', async () => {
  const fixture = fixtureOf(3);
  const { session } = await begin(fixture, ['--max-tokens', '100']);
  const [first] = await play(fixture, session, [150]);
  assert.equal(first.ended.code, 0, first.ended.stderr);
  assert.ok(existsSync(join(fixture.dataDir, SLUG, 'CRM-1.json')));

  const r = await nextAt(fixture, 20, session);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(Object.keys(out)[0], 'mark');
  assert.deepEqual({ ...out, mark: undefined }, { mark: undefined, action: 'pause', reason: 'tokens', spent: 150, cap: 100 });
  const state = stateIn(activeRunDir(fixture.home));
  assert.equal(state.status, 'paused');
  assert.deepEqual([state.cards['CRM-2'].status, state.cards['CRM-2'].windows], ['pending', []]);
  assert.deepEqual([state.executions[0].endReason, state.executions[0].endedAt], ['tokens', minute(20)]);
  assert.ok(existsSync(state.tracks.t1.repos.backend.path));

  const again = await nextAt(fixture, 21, session);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /paused.*begin/);
});

test('a card cap of 2 over five cards ends exactly two cards, then pauses with reason cards', async () => {
  const fixture = fixtureOf(5);
  const { session } = await begin(fixture, ['--max-cards', '2']);
  await play(fixture, session, [10, 10]);
  const out = JSON.parse((await nextAt(fixture, 30, session)).stdout);
  assert.deepEqual([out.action, out.reason, out.spent, out.cap], ['pause', 'cards', 2, 2]);
  const state = stateIn(activeRunDir(fixture.home));
  assert.deepEqual(keys(5).map(k => state.cards[k].status), ['done', 'done', 'pending', 'pending', 'pending']);
});

test('with both caps the first one reached stops the run', async () => {
  const fixture = fixtureOf(4);
  const { session } = await begin(fixture, ['--max-tokens', '1000', '--max-cards', '2']);
  await play(fixture, session, [10, 10]);
  const out = JSON.parse((await nextAt(fixture, 30, session)).stdout);
  assert.deepEqual([out.reason, out.spent, out.cap], ['cards', 2, 2]);
});

test('when both caps are reached at the same card boundary the token cap is the one reported', () => {
  const execution = { caps: { tokens: 100, cards: 1 } };
  assert.deepEqual(capReached(execution, { tokens: 150.4, cards: 1 }), { reason: 'tokens', spent: 150, cap: 100 });
  assert.deepEqual(capReached(execution, { tokens: 50, cards: 1 }), { reason: 'cards', spent: 1, cap: 1 });
  assert.equal(capReached(execution, { tokens: null, cards: 0 }), null);
});

test('with no cap every card runs and the run completes', async () => {
  const fixture = fixtureOf(3);
  const { session } = await begin(fixture);
  await play(fixture, session, [500, 500, 500]);
  const out = JSON.parse((await nextAt(fixture, 40, session)).stdout);
  assert.equal(out.action, 'complete');
});

test('caps are never checked mid-card: under a cap of 1 the first card starts, ends and is recorded before the pause', async () => {
  const fixture = fixtureOf(2);
  const { session } = await begin(fixture, ['--max-tokens', '1']);
  const [first] = await play(fixture, session, [5]);
  assert.equal(first.out.action, 'card');
  assert.equal(first.ended.code, 0, first.ended.stderr);
  assert.ok(existsSync(join(fixture.dataDir, SLUG, 'CRM-1.json')));
  assert.equal(JSON.parse((await nextAt(fixture, 20, session)).stdout).reason, 'tokens');
});

test('a token cap with no bound session refuses to start a card with exit 7; a box alone does not block', async () => {
  const capped = fixtureOf(2);
  await begin(capped, ['--max-tokens', '100'], { session: null });
  const r = await nextAt(capped, 1);
  assert.equal(r.code, 7);
  const out = JSON.parse(r.stdout);
  assert.equal(Object.keys(out)[0], 'mark');
  assert.deepEqual([out.action, out.usage, out.cap], ['unmeasured', 'unmeasured', 100]);
  assert.match(r.stderr, /unmeasured/);
  assert.equal(stateIn(activeRunDir(capped.home)).cards['CRM-1'].status, 'pending');

  const boxed = fixtureOf(2);
  await begin(boxed, ['--box', '100'], { session: null });
  const started = await nextAt(boxed, 1);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).card, 'CRM-1');
});

test('a box overrun is warn only: the record carries over true, scope stays complete and the next card starts', async () => {
  const fixture = fixtureOf(2);
  const { session } = await begin(fixture, ['--box', '100']);
  const [first] = await play(fixture, session, [150]);
  const ended = JSON.parse(first.ended.stdout);
  assert.match(ended.warnings.join(' '), /CRM-1 spent 150 of its box 100/);
  const record = recordOf(fixture, 'CRM-1');
  assert.deepEqual(record.timeBox, { budget: 100, spent: 150, over: true });
  assert.equal(record.scope.complete, true);
  assert.equal(JSON.parse((await nextAt(fixture, 20, session)).stdout).card, 'CRM-2');
});

test('an existing-pr card under --box 100 gets no box and no timeBox', async () => {
  const fixture = spikeFixture({
    issues: [issue('CRM-1')],
    gh: argv => (argv[1] === 'list' ? JSON.stringify([{ number: 7, title: 'feat: x [CRM-1]', url: 'https://github.com/acme/backend/pull/7', isDraft: false }]) : ''),
  });
  const { session } = await begin(fixture, ['--box', '100']);
  await play(fixture, session, [150]);
  const state = stateIn(activeRunDir(fixture.home));
  assert.equal(state.cards['CRM-1'].box, null);
  assert.equal(recordOf(fixture, 'CRM-1').timeBox, undefined);
});

test('begin refuses a cap or box that is not a positive integer', async () => {
  const fixture = fixtureOf(1);
  for (const flags of [['--max-tokens', '0'], ['--max-cards', '-1'], ['--box', '1.5'], ['--box', 'x']]) {
    const r = await call(fixture, ['begin', PROJECT_URL, ...flags]);
    assert.equal(r.code, 2, flags.join(' '));
  }
  assert.equal(existsSync(join(fixture.home, SLUG)), false);
});

test('a card started under --box 100, interrupted and resumed with no --box keeps its box, spent over both windows', async () => {
  const fixture = fixtureOf(1);
  const { session } = await begin(fixture, ['--box', '100']);
  fixture.at(minute(1));
  await call(fixture, ['next'], { session });
  appendTranscript(session, [usageEntry('early', minute(2), 30)]);
  fixture.at(minute(60));
  const second = join(fixture.transcripts, '-work', 'session-2.jsonl');
  await begin(fixture, [], { session: second });
  await playCard(fixture, 'CRM-1', { start: minute(61), end: minute(65), session: second, w: [50] });
  assert.deepEqual(recordOf(fixture, 'CRM-1').timeBox, { budget: 100, spent: 80, over: false });
  assert.equal(stateIn(activeRunDir(fixture.home)).executions[1].box, null);
});

test('in a respike run a card cap of 1 over a replay and two spikes pauses after the first spiked card: the replay spends nothing', async () => {
  const C = 'CRM-5';
  const f = R.respikeFixture({ issues: ([a, b]) => [a, b, R.issue(C)] });
  const pick = [R.PROJECT_URL, '--cards', `${R.B},${C}`];
  const plan = JSON.parse((await f.run('preflight', pick)).stdout);
  assert.deepEqual(plan.order, [{ key: R.A, mode: 'replay' }, { key: R.B, mode: 'spike' }, { key: C, mode: 'spike' }]);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse((await f.run('begin', [...pick, '--approve', plan.approve, '--max-cards', '1'])).stdout);
  const dir = join(f.home, R.SLUG, 'runs', runId);
  f.at('2026-11-10T10:02:00.000Z');
  const first = JSON.parse((await f.spike(['next', '--track', 't1'])).stdout);
  assert.deepEqual(first.replayed.map(r => r.card), [R.A]);
  assert.equal(first.card, R.B);
  assert.deepEqual(JSON.parse((await f.spike(['status'])).stdout).execution.spent.cards, 0);
  const tree = JSON.parse((await f.spike(['tree', 'backend', '--track', 't1'])).stdout).path;
  writeFileSync(join(tree, 'b.txt'), 'b\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${R.B}.json`), JSON.stringify(R.notes(R.B)));
  f.at('2026-11-10T10:05:00.000Z');
  assert.equal((await f.spike(['end', R.B, '--track', 't1'])).code, 0);
  f.at('2026-11-10T10:06:00.000Z');
  const paused = JSON.parse((await f.spike(['next', '--track', 't2'])).stdout);
  assert.deepEqual([paused.action, paused.reason, paused.spent, paused.cap], ['pause', 'cards', 1, 1]);
  assert.equal(stateIn(dir).cards[C].status, 'pending');
  assert.deepEqual(stateIn(dir).cards[R.A].windows, []);
});

test('a card below a card spiked in the run is spiked too, so the next after the card cap replays nothing and pauses', async () => {
  const [C, X] = ['CRM-5', 'CRM-4'];
  const f = R.respikeFixture({
    issues: ([a, b]) => [a, b, R.issue(C, { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: X } }] } }),
      R.issue(X, { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: R.B } }] } })],
  });
  const patchX = 'backend/00004-new.patch';
  writeFileSync(join(f.home, R.SLUG, 'runs', R.OLD_RUN, 'patches', patchX), ['diff --git a/x.txt b/x.txt', 'new file mode 100644', '--- /dev/null', '+++ b/x.txt', '@@ -0,0 +1 @@', '+x', ''].join('\n'));
  writeFileSync(join(f.dataDir, R.SLUG, `${X}.json`), serializeRecord(R.oldRecord(X, { spikedAt: '2026-11-01T10:40:00.000Z', patches: [patchX] })));
  const pick = [R.PROJECT_URL, '--cards', `${R.B},${C}`];
  const plan = JSON.parse((await f.run('preflight', pick)).stdout);
  assert.deepEqual(plan.order.map(e => `${e.key}:${e.mode}`), [`${R.A}:replay`, `${C}:spike`, `${X}:spike`, `${R.B}:spike`]);
  assert.deepEqual(plan.ancestors.find(a => a.key === X).spikedAncestors, [C]);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse((await f.run('begin', [...pick, '--approve', plan.approve, '--max-cards', '1'])).stdout);
  const dir = join(f.home, R.SLUG, 'runs', runId);
  f.at('2026-11-10T10:02:00.000Z');
  assert.equal(JSON.parse((await f.spike(['next'])).stdout).card, C);
  const tree = JSON.parse((await f.spike(['tree', 'backend'])).stdout).path;
  writeFileSync(join(tree, 'c.txt'), 'c\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${C}.json`), JSON.stringify(R.notes(C)));
  f.at('2026-11-10T10:03:00.000Z');
  assert.equal((await f.spike(['end', C])).code, 0);
  f.at('2026-11-10T10:04:00.000Z');
  const paused = JSON.parse((await f.spike(['next'])).stdout);
  assert.deepEqual([paused.action, paused.reason], ['pause', 'cards']);
  assert.deepEqual(paused.replayed, []);
  assert.equal(stateIn(dir).cards[X].status, 'pending');
});
