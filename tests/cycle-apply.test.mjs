import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCyclePlan } from '../scripts/lib/cycle/apply.mjs';
import { computeCyclePlan } from '../scripts/lib/cycle/plan.mjs';
import { fetchCycleContext, fetchProjectMap } from '../scripts/lib/linear-fetch.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'c'.repeat(30);
const NOW = new Date('2026-11-13T12:00:00.000Z');
const TEAM = { id: 'team-abc', key: 'ABC' };
const A = { id: 'u-a', name: 'Dev A' };
const B = { id: 'u-b', name: 'Dev B' };
const cycle = (n, startsAt, endsAt) => ({ id: `cyc-${n}`, number: n, startsAt, endsAt });
const CYCLES = {
  active: cycle(9, '2026-11-02T03:00:00.000Z', '2026-11-16T03:00:00.000Z'),
  next: cycle(10, '2026-11-16T03:00:00.000Z', '2026-11-30T03:00:00.000Z'),
  past: [],
};
const TODO = { name: 'Todo', type: 'unstarted' };
const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, dueDate: null, archivedAt: null, completedAt: null,
  state: TODO, projectMilestone: null, labels: { nodes: [] }, assignee: null, cycle: null, team: TEAM, ...over,
});
const ISSUES = () => [
  issue('ABC-1', { cycle: { id: 'cyc-9', number: 9 } }),
  issue('ABC-2', { assignee: B }),
  issue('ABC-3'),
];
const noSleep = async () => {};

async function setup(over = {}) {
  const fake = fakeLinearStore({ issues: ISSUES(), teams: [TEAM], members: [A, B], cycles: CYCLES, ...over });
  const read = async () => {
    const raw = await fetchProjectMap('project-uuid', KEY, { fetchImpl: fake.fetchImpl });
    const context = await fetchCycleContext(raw.project.id, TEAM.id, KEY, { fetchImpl: fake.fetchImpl, now: NOW });
    return { raw, context };
  };
  const { raw, context } = await read();
  const { plan } = computeCyclePlan({ raw, context, team: TEAM, records: [], now: NOW });
  const log = [];
  const apply = async () => applyCyclePlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: e => log.push(e), sleep: noSleep, live: await read() });
  return { fake, plan, log, apply };
}

const find = (fake, key) => fake.store.issues.find(i => i.identifier === key);

test('apply sets the next cycle and the assignee on each op and logs one line per op', async () => {
  const { fake, plan, log, apply } = await setup();
  assert.deepEqual(plan.ops.map(o => o.card), ['ABC-1', 'ABC-2', 'ABC-3']);
  const out = await apply();
  assert.equal(out.code, 0, out.messages.join('\n'));
  assert.equal(find(fake, 'ABC-1').cycle.id, 'cyc-9', 'carry-over stays in its cycle');
  assert.equal(find(fake, 'ABC-1').assignee.id, 'u-a');
  assert.deepEqual([find(fake, 'ABC-2').cycle.id, find(fake, 'ABC-2').assignee.id], ['cyc-10', 'u-b']);
  assert.deepEqual([find(fake, 'ABC-3').cycle.id, find(fake, 'ABC-3').assignee.id], ['cyc-10', 'u-a']);
  assert.deepEqual(log.map(l => [l.card, l.status]), [['ABC-1', 'applied'], ['ABC-2', 'applied'], ['ABC-3', 'applied']]);
});

test('an existing assignee is never sent', async () => {
  const { fake, apply } = await setup();
  await apply();
  const sent = fake.mutations.find(m => m.variables.id === 'uuid-ABC-2');
  assert.deepEqual(sent.variables.input, { cycleId: 'cyc-10' });
});

test('an op already in its target state is skipped, so a re-run duplicates nothing', async () => {
  const { fake, apply } = await setup();
  await apply();
  const writes = fake.mutations.length;
  const again = await apply();
  assert.equal(again.code, 0);
  assert.equal(fake.mutations.length, writes);
  assert.ok(again.results.every(r => r.status === 'skipped'));
});

test('a changed next cycle, a card reassigned or a card completed since the plan is drift, and nothing is written', async () => {
  for (const change of [
    fake => { fake.store.issues.find(i => i.identifier === 'ABC-3').assignee = B; },
    fake => { fake.store.issues.find(i => i.identifier === 'ABC-3').state = { name: 'Done', type: 'completed' }; },
  ]) {
    const { fake, apply } = await setup();
    change(fake);
    const out = await apply();
    assert.equal(out.code, 6, out.messages.join('\n'));
    assert.equal(fake.mutations.length, 0);
  }
  const moved = await setup();
  const out = await applyCyclePlan(moved.plan, {
    apiKey: KEY, fetchImpl: moved.fake.fetchImpl, now: () => NOW, appendLog: () => {}, sleep: noSleep,
    live: { raw: await fetchProjectMap('project-uuid', KEY, { fetchImpl: moved.fake.fetchImpl }), context: { ...CYCLES, members: [A, B], next: cycle(11, '2026-11-30T03:00:00.000Z', '2026-12-14T03:00:00.000Z') } },
  });
  assert.equal(out.code, 6);
  assert.match(out.messages.join('\n'), /next cycle/);
});

test('a failed write stops there with code 1; the next run continues', async () => {
  const { fake, log, apply } = await setup({ failOn: { op: 'CycleIssueUpdate', nth: 2, as: 'http500' } });
  const first = await apply();
  assert.equal(first.code, 1);
  assert.deepEqual(log.map(l => l.card), ['ABC-1']);
  const second = await apply();
  assert.equal(second.code, 0, second.messages.join('\n'));
  assert.deepEqual(second.results.map(r => r.status), ['skipped', 'applied', 'applied']);
  assert.equal(find(fake, 'ABC-3').cycle.id, 'cyc-10');
});

test('an edited plan is refused with code 5 and nothing is sent', async () => {
  const { fake, plan } = await setup();
  const edited = { ...plan, ops: plan.ops.slice(1) };
  const out = await applyCyclePlan(edited, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: () => {}, sleep: noSleep, live: { raw: null, context: null } });
  assert.equal(out.code, 5);
  assert.equal(fake.mutations.length, 0);
});
