import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inProgressStateOf, moveToInProgress } from '../scripts/lib/start/move.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { fakeStartFixture, SENTINEL } from './helpers/start-fixture.mjs';

guardNetwork();

const CARD = 'ABC-1';
const KEY = 'lin_api_SENTINEL_' + 'm'.repeat(30);

const TODO = { id: 's-todo', name: 'Todo', type: 'unstarted' };
const BACKLOG = { id: 's-backlog', name: 'Backlog', type: 'backlog' };
const PROGRESS = { id: 's-progress', name: 'In Progress', type: 'started' };
const REVIEW = { id: 's-review', name: 'In Review', type: 'started' };
const DONE = { id: 's-done', name: 'Done', type: 'completed' };
const CANCELED = { id: 's-canceled', name: 'Canceled', type: 'canceled' };
const TRIAGE = { id: 's-triage', name: 'Triage', type: 'triage' };
const TEAM_STATES = [BACKLOG, TODO, PROGRESS, REVIEW, DONE, CANCELED, TRIAGE];

const store = ({ state = TODO, states = TEAM_STATES, failOn } = {}) => fakeLinearStore({
  issues: [{ identifier: CARD, title: 'Card', url: `u/${CARD}`, estimate: null, archivedAt: null, state, projectMilestone: null, labels: { nodes: [] } }],
  teams: [{ id: 'team-abc', key: 'ABC', states }],
  failOn,
});
const ops = fake => fake.sent.map(s => s.body.query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1]);
const move = (fake, extra = {}) => moveToInProgress(CARD, { key: KEY, fetchImpl: fake.fetchImpl, ...extra });

test('with one In Progress started state, a Todo card is moved with one team-state read and one state update by issue id', async () => {
  const fake = store();
  const out = await move(fake);
  assert.deepEqual(ops(fake), ['IssueTeamStates', 'IssueStateUpdate']);
  assert.deepEqual(fake.mutations, [{ name: 'IssueStateUpdate', variables: { id: `uuid-${CARD}`, stateId: 's-progress' } }]);
  assert.deepEqual(out, { action: 'moved', card: CARD, from: { name: 'Todo', type: 'unstarted' }, to: 'In Progress' });
  assert.equal(fake.store.issues[0].state.id, 's-progress');
});

test('a backlog card is moved too', async () => {
  const fake = store({ state: BACKLOG });
  assert.equal((await move(fake)).action, 'moved');
  assert.equal(fake.mutations.length, 1);
});

test('inProgressStateOf takes the one started state named In Progress, case-insensitively, among other started states', () => {
  assert.deepEqual(inProgressStateOf(TEAM_STATES), { state: PROGRESS });
  const lower = { id: 's-lower', name: 'in progress', type: 'started' };
  assert.deepEqual(inProgressStateOf([TODO, lower, REVIEW]), { state: lower });
});

test('inProgressStateOf refuses zero matches, including an In Progress that is not of the started type', () => {
  for (const states of [[TODO, REVIEW], [TODO, { id: 's-x', name: 'In Progress', type: 'unstarted' }], []]) {
    const r = inProgressStateOf(states);
    assert.equal(r.state, undefined);
    assert.match(r.refused, /no started state named "In Progress"/);
  }
});

test('inProgressStateOf refuses several matches', () => {
  const r = inProgressStateOf([PROGRESS, { id: 's-p2', name: 'IN PROGRESS', type: 'started' }]);
  assert.equal(r.state, undefined);
  assert.match(r.refused, /2 started states named "In Progress"/);
});

test('zero or several In Progress states refuse the move with the team key and state name, and nothing is written', async () => {
  for (const states of [[TODO, REVIEW], [TODO, PROGRESS, { id: 's-p2', name: 'In progress', type: 'started' }]]) {
    const fake = store({ states });
    const out = await move(fake);
    assert.match(out.refused, /\bteam ABC\b/);
    assert.match(out.refused, /"In Progress"/);
    assert.deepEqual(ops(fake), ['IssueTeamStates']);
    assert.deepEqual(fake.mutations, []);
  }
});

test('a card in any started-type state is already started: no write, and the state name is reported', async () => {
  for (const state of [PROGRESS, REVIEW]) {
    const fake = store({ state });
    assert.deepEqual(await move(fake), { action: 'already-started', card: CARD, state: { name: state.name, type: 'started' } });
    assert.deepEqual(fake.mutations, []);
  }
});

test('a started card is reported already started even when the team has no In Progress state', async () => {
  const fake = store({ state: REVIEW, states: [TODO, REVIEW] });
  assert.equal((await move(fake)).action, 'already-started');
  assert.deepEqual(fake.mutations, []);
});

test('completed, canceled and any other non-backlog, non-unstarted card is refused with no write', async () => {
  for (const state of [DONE, CANCELED, TRIAGE]) {
    const fake = store({ state });
    const out = await move(fake);
    assert.match(out.refused, new RegExp(`${CARD} is ${state.name} \\(${state.type}\\)`));
    assert.deepEqual(fake.mutations, []);
  }
});

test('a card Linear does not return is an error, not a refusal', async () => {
  const fake = fakeLinearStore({ issues: [], teams: [{ id: 'team-abc', key: 'ABC', states: TEAM_STATES }] });
  await assert.rejects(move(fake), e => e.message === `${CARD} was not found in Linear` && e.exitCode === 1);
  assert.deepEqual(fake.mutations, []);
});

test('a card read with no team is a plain error, and nothing is written', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { issue: { id: 'uuid-x', identifier: CARD, state: TODO, team: null } } }) });
  await assert.rejects(moveToInProgress(CARD, { key: KEY, fetchImpl }), e => e.message === `${CARD} has no team in Linear`);
});

test('success:false on the state update is a plain-English failure', async () => {
  const fake = store({ failOn: { op: 'IssueStateUpdate', as: 'success-false' } });
  await assert.rejects(move(fake), e => e.message === 'Linear did not accept IssueStateUpdate (success: false)');
  assert.equal(fake.store.issues[0].state.id, 's-todo');
});

const hangUntilAborted = signal => new Promise((_, reject) => {
  const guard = setTimeout(() => reject(new Error('the request was never aborted')), 2000);
  signal.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason); }, { once: true });
});

test('a Linear read that never answers is cut at the timeout', async () => {
  const fetchImpl = (url, init) => hangUntilAborted(init.signal);
  await assert.rejects(moveToInProgress(CARD, { key: KEY, fetchImpl, timeoutMs: 20 }),
    e => e.message === 'Linear request timed out after 0.02s');
});

test('a state update that never answers is cut at the timeout', async () => {
  const fake = store();
  const fetchImpl = (url, init) => (JSON.parse(init.body).query.includes('IssueStateUpdate')
    ? hangUntilAborted(init.signal) : fake.fetchImpl(url, init));
  await assert.rejects(moveToInProgress(CARD, { key: KEY, fetchImpl, timeoutMs: 20 }),
    e => e.message === 'Linear request timed out after 0.02s');
});

const cli = (t, opts = {}) => {
  const f = fakeStartFixture();
  t.after(f.dispose);
  const linear = store(opts);
  const run = argv => f.run(argv, { fetchImpl: linear.fetchImpl });
  return { f, linear, run };
};
const untouched = ({ f }) => assert.deepEqual([f.git.calls.length, f.gh.calls.length, f.linear.sent.length], [0, 0, 0]);
const clean = r => { for (const out of [r.stdout, r.stderr]) assert.ok(!out.includes(SENTINEL), out); };

test('move with a matching --confirm moves the card: one team-state read, one state update, JSON out, no git or gh', async t => {
  const c = cli(t);
  const r = await c.run(['move', CARD, '--confirm', CARD]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'moved', card: CARD, from: { name: 'Todo', type: 'unstarted' }, to: 'In Progress' });
  assert.deepEqual(ops(c.linear), ['IssueTeamStates', 'IssueStateUpdate']);
  assert.deepEqual(c.linear.mutations, [{ name: 'IssueStateUpdate', variables: { id: `uuid-${CARD}`, stateId: 's-progress' } }]);
  untouched(c);
  clean(r);
});

test('move without --confirm, or with any other flag, is a usage error before any request', async t => {
  for (const argv of [
    ['move', CARD], ['move', CARD, '--confirm'], ['move', '--confirm', CARD], ['move', 'abc', '--confirm', 'abc'],
    ['move', CARD, '--confirm', CARD, '--approve', 'a'.repeat(12)], ['move', CARD, '--confirm', CARD, '--blocker', 'ABC-2'],
  ]) {
    const c = cli(t);
    const r = await c.run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /usage: node scripts\/start\.mjs move <CARD> --confirm <CARD>/);
    assert.equal(c.linear.sent.length, 0);
    untouched(c);
  }
});

test('move with a --confirm that is not the card is refused, exit 5, before any request', async t => {
  for (const other of ['ABC-2', 'abc-1']) {
    const c = cli(t);
    const r = await c.run(['move', CARD, '--confirm', other]);
    assert.equal(r.code, 5);
    assert.ok(r.stderr.includes(CARD) && r.stderr.includes(other), r.stderr);
    assert.equal(c.linear.sent.length, 0);
    untouched(c);
  }
});

test('move with no Linear key exits 3 before any request', async t => {
  const c = cli(t);
  writeFileSync(c.f.keyFile, '');
  const r = await c.run(['move', CARD, '--confirm', CARD]);
  assert.equal(r.code, 3);
  assert.equal(c.linear.sent.length, 0);
  untouched(c);
});

test('move on an already started card exits 0 with already-started and writes nothing', async t => {
  const c = cli(t, { state: REVIEW });
  const r = await c.run(['move', CARD, '--confirm', CARD]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'already-started', card: CARD, state: { name: 'In Review', type: 'started' } });
  assert.deepEqual(c.linear.mutations, []);
});

test('move refuses, exit 5 and no write, a closed card and a team without exactly one In Progress state', async t => {
  for (const [opts, pattern] of [
    [{ state: DONE }, /ABC-1 is Done \(completed\)/],
    [{ state: CANCELED }, /ABC-1 is Canceled \(canceled\)/],
    [{ states: [TODO, REVIEW] }, /team ABC has no started state named "In Progress"/],
    [{ states: [TODO, PROGRESS, { id: 's-p2', name: 'in progress', type: 'started' }] }, /team ABC has 2 started states named "In Progress"/],
  ]) {
    const c = cli(t, opts);
    const r = await c.run(['move', CARD, '--confirm', CARD]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, pattern);
    assert.equal(r.stdout, '');
    assert.deepEqual(c.linear.mutations, []);
  }
});

test('move exits 1 with a plain message for a missing card, success:false and a Linear error that echoes the key', async t => {
  const missing = cli(t);
  missing.linear.store.issues.length = 0;
  const gone = await missing.run(['move', CARD, '--confirm', CARD]);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /^ABC-1 was not found in Linear\n$/);

  const refusing = cli(t, { failOn: { op: 'IssueStateUpdate', as: 'success-false' } });
  const declined = await refusing.run(['move', CARD, '--confirm', CARD]);
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /^Linear did not accept IssueStateUpdate \(success: false\)\n$/);

  for (const op of ['IssueTeamStates', 'IssueStateUpdate']) {
    const c = cli(t, { failOn: { op, as: 'graphql' } });
    const r = await c.run(['move', CARD, '--confirm', CARD]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /forbidden for key/);
    assert.match(r.stderr, /\[redacted\]/);
    clean(r);
  }
});

test('the usage lists the move subcommand', async t => {
  const c = cli(t);
  const r = await c.run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^usage: node scripts\/start\.mjs move <CARD> --confirm <CARD>$/m);
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(join(ROOT, file), 'utf8');
const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s+'(\.{1,2}\/[^']+)'/gm;

function importClosure(entry) {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of read(file).matchAll(IMPORT)) visit(relative(ROOT, resolve(ROOT, dirname(file), spec)));
  };
  visit(entry);
  return seen;
}

test('static: setIssueState is named only by linear-write and the start move module, and by no skill', () => {
  const scripts = globSync('scripts/**/*.mjs', { cwd: ROOT }).sort();
  assert.ok(scripts.includes('scripts/lib/harvest-apply.mjs') && scripts.length > 20, scripts.join(', '));
  const naming = scripts.filter(f => /setIssueState/.test(read(f)));
  assert.deepEqual(naming, ['scripts/lib/linear-write.mjs', 'scripts/lib/start/move.mjs']);
  const skills = globSync('skills/**/*.md', { cwd: ROOT });
  assert.ok(skills.length > 0);
  assert.deepEqual(skills.filter(f => /setIssueState|IssueStateUpdate/.test(read(f))), []);
});

test('static: among the start sources only move.mjs names linear-write', () => {
  const start = globSync(['scripts/start.mjs', 'scripts/lib/start/*.mjs'], { cwd: ROOT }).sort();
  assert.ok(start.length >= 10, start.join(', '));
  assert.deepEqual(start.filter(f => /linear-write/.test(read(f))), ['scripts/lib/start/move.mjs']);
});

test('static: the plan import graph never reaches move.mjs or linear-write, while start.mjs reaches both', () => {
  const plan = importClosure('scripts/lib/start/plan.mjs');
  assert.ok(plan.has('scripts/lib/linear-fetch.mjs'), [...plan].join(', '));
  assert.ok(!plan.has('scripts/lib/start/move.mjs'));
  assert.ok(!plan.has('scripts/lib/linear-write.mjs'));
  const cliClosure = importClosure('scripts/start.mjs');
  assert.ok(cliClosure.has('scripts/lib/start/move.mjs'));
  assert.ok(cliClosure.has('scripts/lib/linear-write.mjs'));
});
