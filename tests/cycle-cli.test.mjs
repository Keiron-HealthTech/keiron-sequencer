import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/cycle.mjs';
import { fakeLinearStore, FIXTURE_SLUG as SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const CLI = fileURLToPath(new URL('../scripts/cycle.mjs', import.meta.url));
const KEY = 'lin_api_dummy_' + 'c'.repeat(30);
const NOW = new Date('2026-11-13T12:00:00.000Z');
const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-cycle-cli-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const NO_FILE = join(TMP, 'absent', 'linear.key');
const TEAM = { id: 'team-abc', key: 'ABC' };
const A = { id: 'u-a', name: 'Dev A', displayName: 'deva' };
const B = { id: 'u-b', name: 'Dev B', displayName: 'devb' };
const cycle = (n, startsAt, endsAt) => ({ id: `cyc-${n}`, number: n, startsAt, endsAt });
const CYCLES = {
  active: cycle(9, '2026-11-02T03:00:00.000Z', '2026-11-16T03:00:00.000Z'),
  next: cycle(10, '2026-11-16T03:00:00.000Z', '2026-11-30T03:00:00.000Z'),
  past: [cycle(8, '2026-10-19T03:00:00.000Z', '2026-11-02T03:00:00.000Z')],
};
const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, dueDate: null, archivedAt: null, completedAt: null,
  state: { name: 'Todo', type: 'unstarted' }, projectMilestone: null, labels: { nodes: [] }, assignee: null, cycle: null, team: TEAM,
  description: `What ${identifier} does.`, ...over,
});
const ISSUES = () => [
  issue('ABC-1', { state: { name: 'Done', type: 'completed' }, assignee: A, completedAt: '2026-10-20T15:00:00.000Z', cycle: { id: 'cyc-8', number: 8 } }),
  issue('ABC-2', { cycle: { id: 'cyc-9', number: 9 }, assignee: A }),
  issue('ABC-3'),
];
let n = 0;
const dataDir = () => { const d = join(TMP, `data-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const store = (over = {}) => fakeLinearStore({ issues: ISSUES(), teams: [TEAM], members: [A, B], cycles: CYCLES, ...over });
const call = (argv, fake, dir, env = { LINEAR_API_KEY: KEY }) => run(argv, { env, fetchImpl: fake.fetchImpl, keyFile: NO_FILE, now: () => NOW, dataDir: dir });
const json = r => JSON.parse(r.stdout);

test('plan writes plan.json and plan.md and never sends a mutation', async () => {
  const fake = store();
  const dir = dataDir();
  const r = await call(['plan', SLUG, '--availability', 'dev b=50', '--guess', 'ABC-3=L'], fake, dir);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.status, 'written');
  const plan = JSON.parse(readFileSync(join(dir, SLUG, 'cycle', 'plan.json'), 'utf8'));
  assert.equal(plan.hash, out.hash);
  assert.equal(plan.people.find(p => p.id === 'u-b').availability, 50);
  assert.equal(plan.cards.find(c => c.key === 'ABC-3').sizeSource, 'guess');
  const md = readFileSync(join(dir, SLUG, 'cycle', 'plan.md'), 'utf8');
  assert.ok(md.includes(`--approve ${out.hash.slice(0, 12)}`));
  assert.equal(fake.mutations.length, 0);
});

test('needs lists cards without a record with their descriptions and the anchors', async () => {
  const r = await call(['needs', SLUG], store(), dataDir());
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(out.needs.map(x => [x.key, x.completed, x.description]), [
    ['ABC-1', true, 'What ABC-1 does.'], ['ABC-2', false, 'What ABC-2 does.'], ['ABC-3', false, 'What ABC-3 does.'],
  ]);
  assert.deepEqual(out.anchors, { S: [], M: [], L: [], XL: [] });
});

test('apply refuses without --approve, with a wrong hash or an edited plan (exit 5) and sends nothing', async () => {
  const fake = store();
  const dir = dataDir();
  const { hash } = json(await call(['plan', SLUG], fake, dir));
  const path = join(dir, SLUG, 'cycle', 'plan.json');
  assert.equal((await call(['apply', SLUG, '--plan', path], fake, dir)).code, 5);
  assert.equal((await call(['apply', SLUG, '--plan', path, '--approve', 'f'.repeat(12)], fake, dir)).code, 5);
  const edited = JSON.parse(readFileSync(path, 'utf8'));
  edited.ops = [];
  writeFileSync(path, JSON.stringify(edited));
  assert.equal((await call(['apply', SLUG, '--plan', path, '--approve', hash.slice(0, 12)], fake, dir)).code, 5);
  assert.equal(fake.mutations.length, 0);
});

test('apply with the hash writes and exits 0', async () => {
  const fake = store();
  const dir = dataDir();
  const { hash } = json(await call(['plan', SLUG], fake, dir));
  const r = await call(['apply', SLUG, '--plan', join(dir, SLUG, 'cycle', 'plan.json'), '--approve', hash.slice(0, 12)], fake, dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).status, 'applied');
  assert.ok(fake.mutations.length > 0);
  assert.ok(existsSync(join(dir, SLUG, 'cycle', 'applied.jsonl')));
  assert.equal(fake.store.issues.find(i => i.identifier === 'ABC-3').cycle.id, 'cyc-10');
});

test('several teams without --team is a usage error; --team picks one; an unknown --team is a usage error', async () => {
  const two = store({ teams: [TEAM, { id: 'team-xyz', key: 'XYZ' }] });
  assert.equal((await call(['plan', SLUG], two, dataDir())).code, 2);
  assert.equal((await call(['plan', SLUG, '--team', 'abc'], two, dataDir())).code, 0);
  assert.equal((await call(['plan', SLUG, '--team', 'QQQ'], two, dataDir())).code, 2);
});

test('no next cycle exits 4 and removes a stale plan.json', async () => {
  const dir = dataDir();
  await call(['plan', SLUG], store(), dir);
  const path = join(dir, SLUG, 'cycle', 'plan.json');
  assert.ok(existsSync(path));
  const r = await call(['plan', SLUG], store({ cycles: { ...CYCLES, next: null } }), dir);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /no next cycle/);
  assert.ok(!existsSync(path));
  assert.ok(!existsSync(join(dir, SLUG, 'cycle', 'plan.md')), 'a refused plan leaves no stale plan.md');
});

test('an unknown availability name or tier is a usage error', async () => {
  assert.equal((await call(['plan', SLUG, '--availability', 'Nobody=50'], store(), dataDir())).code, 2);
  assert.equal((await call(['plan', SLUG, '--availability', 'Dev A=150'], store(), dataDir())).code, 2);
  assert.equal((await call(['plan', SLUG, '--guess', 'ABC-3=XXL'], store(), dataDir())).code, 2);
});

test('no key exits 3 and the key never appears in output', async () => {
  const r = await call(['plan', SLUG], store(), dataDir(), {});
  assert.equal(r.code, 3);
  const fake = store({ failOn: { op: 'CycleContext', as: 'graphql' } });
  const leak = await call(['plan', SLUG], fake, dataDir());
  assert.equal(leak.code, 1);
  assert.ok(!leak.stderr.includes(KEY) && !leak.stdout.includes(KEY));
});

test('the entry point runs as a script and exits 3 with no key in a temp HOME', () => {
  const home = join(TMP, 'home');
  mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, 'plan', SLUG], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, KEIRON_SEQUENCER_HOME: join(home, 'data') },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /no Linear key/);
});

test('apply accepts --team, as the skill passes it on every command', async () => {
  const fake = store();
  const dir = dataDir();
  const { hash } = json(await call(['plan', SLUG, '--team', 'ABC'], fake, dir));
  const r = await call(['apply', SLUG, '--team', 'ABC', '--plan', join(dir, SLUG, 'cycle', 'plan.json'), '--approve', hash.slice(0, 12)], fake, dir);
  assert.equal(r.code, 0, r.stderr);
});

test('needs lists the project members', async () => {
  const out = json(await call(['needs', SLUG], store(), dataDir()));
  assert.deepEqual(out.members.map(m => m.name), ['Dev A', 'Dev B']);
});
