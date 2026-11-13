import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCycleContext, fetchProjectMap } from '../scripts/lib/linear-fetch.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'c'.repeat(30);
const NOW = new Date('2026-11-13T12:00:00.000Z');
const cycle = (n, endsAt) => ({ id: `cyc-${n}`, number: n, startsAt: '2026-01-01T03:00:00.000Z', endsAt });
const MEMBERS = [{ id: 'u-a', name: 'Dev A', displayName: 'deva' }, { id: 'u-b', name: 'Dev B', displayName: 'devb' }];

test('fetchCycleContext returns members and the active, next and last six past cycles, newest first', async () => {
  const past = [3, 7, 1, 8, 5, 2, 6, 4].map(n => cycle(n, `2026-${String(n + 1).padStart(2, '0')}-01T03:00:00.000Z`));
  const { fetchImpl } = fakeLinearStore({ members: MEMBERS, cycles: { active: cycle(9, '2026-11-17T03:00:00.000Z'), next: cycle(10, '2026-12-01T03:00:00.000Z'), past } });
  const ctx = await fetchCycleContext('project-uuid', 'team-crm', KEY, { fetchImpl, now: NOW });
  assert.deepEqual(ctx.members, MEMBERS);
  assert.equal(ctx.active.id, 'cyc-9');
  assert.equal(ctx.next.id, 'cyc-10');
  assert.deepEqual(ctx.past.map(c => c.number), [8, 7, 6, 5, 4, 3]);
});

test('a team with no next cycle gives next: null', async () => {
  const { fetchImpl } = fakeLinearStore({ members: MEMBERS, cycles: { active: cycle(9, '2026-11-17T03:00:00.000Z'), next: null, past: [] } });
  const ctx = await fetchCycleContext('project-uuid', 'team-crm', KEY, { fetchImpl, now: NOW });
  assert.equal(ctx.next, null);
  assert.deepEqual(ctx.past, []);
});

test('fetchCycleContext bounds the past cycles by a date before now', async () => {
  const { fetchImpl, sent } = fakeLinearStore({ cycles: { active: null, next: null, past: [] } });
  await fetchCycleContext('project-uuid', 'team-crm', KEY, { fetchImpl, now: NOW });
  const since = sent.at(-1).body.variables.since;
  assert.ok(Date.parse(since) < NOW.getTime(), since);
});

test('the issues query asks for assignee, cycle, completedAt and team', async () => {
  const issue = {
    identifier: 'ABC-1', title: 'Card', url: 'u/ABC-1', estimate: null, archivedAt: null, dueDate: null,
    state: { name: 'Done', type: 'completed' }, projectMilestone: null, labels: { nodes: [] },
    assignee: { id: 'u-a', name: 'Dev A' }, cycle: { id: 'cyc-8', number: 8 }, completedAt: '2026-11-05T15:00:00.000Z',
  };
  const { fetchImpl, sent } = fakeLinearStore({ issues: [issue] });
  const raw = await fetchProjectMap('project-uuid', KEY, { fetchImpl });
  const query = sent.map(s => s.body.query).find(q => q.includes('issues('));
  for (const field of ['assignee {', 'cycle {', 'completedAt', 'team {']) assert.ok(query.includes(field), field);
  assert.equal(raw.issues[0].assignee.name, 'Dev A');
  assert.deepEqual(raw.issues[0].team, { id: 'team-crm', key: 'CRM' });
});
