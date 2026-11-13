import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linearQuery } from '../scripts/lib/linear-fetch.mjs';
import { createBlocks, createIssue, deleteRelation, setIssueState, updateDescription } from '../scripts/lib/linear-write.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'w'.repeat(30);
const SOURCE = readFileSync(new URL('../scripts/lib/linear-write.mjs', import.meta.url), 'utf8');

const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});
const store = () => fakeLinearStore({
  issues: [issue('CRM-1', { description: 'human text' }), issue('CRM-7')],
  milestones: [{ id: 'm1', name: 'M1', sortOrder: 1 }],
});
const ctx = fake => ({ apiKey: KEY, fetchImpl: fake.fetchImpl });
const opName = query => query.match(/^\s*mutation\s+(\w+)/)?.[1] ?? null;

test('deleteRelation deletes by relation id, never by endpoints', async () => {
  const fake = store();
  const { relationId } = await createBlocks('uuid-CRM-1', 'uuid-CRM-7', ctx(fake));
  assert.equal(await deleteRelation(relationId, ctx(fake)), undefined);
  const { body } = fake.sent.at(-1);
  assert.equal(opName(body.query), 'RelationDelete');
  assert.match(body.query, /issueRelationDelete\(id: \$id\)/);
  assert.deepEqual(body.variables, { id: relationId });
  assert.deepEqual(fake.store.relations, []);
});

test('createIssue sends team, project, milestone, title and description only, and returns the new id, identifier and url', async () => {
  const fake = store();
  const input = {
    teamId: 'team-crm', projectId: 'project-uuid', projectMilestoneId: 'm1', title: 'Nueva tarjeta',
    description: 'Repo: example-api\n\nTexto\n\n<!-- keiron-sequencer:roles-users -->',
  };
  const created = await createIssue(input, ctx(fake));
  assert.deepEqual(created, { id: 'uuid-CRM-8', identifier: 'CRM-8', url: 'u/CRM-8' });
  const { body } = fake.sent.at(-1);
  assert.equal(opName(body.query), 'IssueCreate');
  assert.match(body.query, /issueCreate\(input: \$input\)/);
  assert.deepEqual(body.variables, { input });
  assert.ok(!('stateId' in body.variables.input));
  const stored = fake.store.issues.find(i => i.identifier === 'CRM-8');
  assert.equal(stored.description, input.description);
  assert.equal(stored.projectMilestone.name, 'M1');
});

test('updateDescription carries only the issue id and the description', async () => {
  const fake = store();
  assert.equal(await updateDescription('uuid-CRM-1', 'human text\n\nnotes', ctx(fake)), undefined);
  const { body } = fake.sent.at(-1);
  assert.equal(opName(body.query), 'DescriptionUpdate');
  assert.match(body.query, /issueUpdate\(id: \$id, input: \{ description: \$description \}\)/);
  assert.deepEqual(body.variables, { id: 'uuid-CRM-1', description: 'human text\n\nnotes' });
  assert.equal(fake.store.issues[0].description, 'human text\n\nnotes');
});

test('the module holds exactly six mutation texts, has no default transport, and importing it sends nothing', async () => {
  const names = [...SOURCE.matchAll(/^mutation (\w+)\(/gm)].map(m => m[1]).sort();
  assert.deepEqual(names, ['CycleIssueUpdate', 'DescriptionUpdate', 'IssueCreate', 'IssueStateUpdate', 'RelationCreate', 'RelationDelete']);
  assert.equal([...SOURCE.matchAll(/\bmutation\b/g)].length, 6);
  assert.doesNotMatch(SOURCE, /=\s*fetch\b|\bfetch\(/);
  const guarded = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('network disabled'); };
  try {
    await import(`../scripts/lib/linear-write.mjs?fresh=${Date.now()}`);
  } finally {
    globalThis.fetch = guarded;
  }
  assert.equal(calls, 0);
});

test('every write refuses before any request without an injected fetchImpl', async () => {
  for (const write of [
    () => createBlocks('a', 'b', { apiKey: KEY }),
    () => deleteRelation('rel-1', { apiKey: KEY }),
    () => createIssue({ title: 't' }, { apiKey: KEY }),
    () => updateDescription('a', 'd', { apiKey: KEY }),
    () => setIssueState('a', 's', { apiKey: KEY }),
  ]) await assert.rejects(write, /fetchImpl/);
});

const reply = data => async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => data });

test('success:false in a mutation payload is a plain-English failure', async () => {
  const cases = [
    [() => createBlocks('a', 'b', { apiKey: KEY, fetchImpl: reply({ data: { issueRelationCreate: { success: false } } }) }), 'RelationCreate'],
    [() => deleteRelation('rel-1', { apiKey: KEY, fetchImpl: reply({ data: { issueRelationDelete: { success: false } } }) }), 'RelationDelete'],
    [() => createIssue({}, { apiKey: KEY, fetchImpl: reply({ data: { issueCreate: { success: false, issue: null } } }) }), 'IssueCreate'],
    [() => updateDescription('a', 'd', { apiKey: KEY, fetchImpl: reply({ data: { issueUpdate: { success: false } } }) }), 'DescriptionUpdate'],
    [() => setIssueState('a', 's', { apiKey: KEY, fetchImpl: reply({ data: { issueUpdate: { success: false } } }) }), 'IssueStateUpdate'],
  ];
  for (const [write, name] of cases) {
    await assert.rejects(write, e => e.message === `Linear did not accept ${name} (success: false)`);
  }
});

const hangUntilAborted = signal => new Promise((_, reject) => {
  const guard = setTimeout(() => reject(new Error('the request was never aborted')), 2000);
  signal.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason); }, { once: true });
});

test('a write that never answers is cut at the timeout', async () => {
  const fetchImpl = (url, init) => hangUntilAborted(init.signal);
  await assert.rejects(deleteRelation('rel-1', { apiKey: KEY, fetchImpl, timeoutMs: 20 }),
    e => e.message === 'Linear request timed out after 0.02s');
});

test('a GraphQL error that echoes the key is redacted in the thrown error', async () => {
  const fetchImpl = reply({ errors: [{ message: `forbidden for ${KEY}` }] });
  const e = await updateDescription('a', 'd', { apiKey: KEY, fetchImpl }).then(() => assert.fail('expected a rejection'), x => x);
  assert.match(e.message, /^Linear: forbidden for \[redacted\]$/);
  for (let i = 0; i + 8 <= KEY.length; i++) assert.ok(!String(e.stack).includes(KEY.slice(i, i + 8)));
});

const STATE_UPDATE = `
mutation IssueStateUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { name } } }
}`;
const statesFake = failOn => fakeLinearStore({
  issues: [issue('CRM-1', { state: { id: 's-todo', name: 'Todo', type: 'unstarted' } })],
  teams: [{ id: 'team-crm', key: 'CRM', states: [
    { id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-progress', name: 'In Progress', type: 'started' },
  ] }],
  failOn,
});
const sendStateUpdate = (fake, variables) => linearQuery(STATE_UPDATE, variables, KEY, fake.fetchImpl, 1000);

test('the fake store applies a state update by team state id and records the mutation variables', async () => {
  const fake = statesFake();
  const data = await sendStateUpdate(fake, { id: 'uuid-CRM-1', stateId: 's-progress' });
  assert.deepEqual(data, { issueUpdate: { success: true, issue: { id: 'uuid-CRM-1', state: { name: 'In Progress' } } } });
  assert.deepEqual(fake.store.issues[0].state, { id: 's-progress', name: 'In Progress', type: 'started' });
  assert.deepEqual(fake.mutations, [{ name: 'IssueStateUpdate', variables: { id: 'uuid-CRM-1', stateId: 's-progress' } }]);
});

test('the fake store refuses a state outside the card team and can answer success:false', async () => {
  const fake = statesFake();
  await assert.rejects(sendStateUpdate(fake, { id: 'uuid-CRM-1', stateId: 's-other' }), /^Error: Linear: Entity not found: s-other$/);
  assert.equal(fake.store.issues[0].state.id, 's-todo');
  const refusing = statesFake({ op: 'IssueStateUpdate', as: 'success-false' });
  const data = await sendStateUpdate(refusing, { id: 'uuid-CRM-1', stateId: 's-progress' });
  assert.deepEqual(data, { issueUpdate: { success: false } });
  assert.equal(refusing.store.issues[0].state.id, 's-todo');
  assert.equal(refusing.mutations.length, 1);
});

test('setIssueState sends one IssueStateUpdate carrying only the issue id and the state id, and returns the new state name', async () => {
  const fake = statesFake();
  assert.deepEqual(await setIssueState('uuid-CRM-1', 's-progress', ctx(fake)), { stateName: 'In Progress' });
  assert.equal(fake.sent.length, 1);
  const { body } = fake.sent[0];
  assert.equal(opName(body.query), 'IssueStateUpdate');
  assert.equal(body.query.trim(), STATE_UPDATE.trim());
  assert.equal([...body.query.matchAll(/\bmutation\b/g)].length, 1);
  assert.deepEqual(body.variables, { id: 'uuid-CRM-1', stateId: 's-progress' });
  assert.deepEqual(fake.mutations, [{ name: 'IssueStateUpdate', variables: { id: 'uuid-CRM-1', stateId: 's-progress' } }]);
  assert.equal(fake.store.issues[0].state.name, 'In Progress');
});
