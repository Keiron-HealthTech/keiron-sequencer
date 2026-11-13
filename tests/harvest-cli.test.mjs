import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/harvest.mjs';
import { caseSource } from '../scripts/lib/harvest.mjs';
import { fakeLinearStore, FIXTURE_NAME, FIXTURE_SLUG as SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const CLI = fileURLToPath(new URL('../scripts/harvest.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/sample-records/c0ffee000001/', import.meta.url));
const KEY = 'lin_api_dummy_' + 'c'.repeat(30);
const UUID = '12345678-1234-1234-1234-123456789abc';
const NOW = new Date('2026-11-09T10:00:00.000Z');
const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-harvest-cli-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const NO_FILE = join(TMP, 'absent', 'linear.key');

const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});
const store = (over = {}) => fakeLinearStore({ issues: [issue('CRM-1'), issue('CRM-2'), issue('ABC-5')], ...over });
const HARVEST = { schemaVersion: 1, project: { slug: SLUG }, edges: [{ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: 'shared module' }] };

let n = 0;
function dataDir({ harvest = HARVEST, notes, records = [], stalePlan = false } = {}) {
  const dir = join(TMP, `data-${++n}`);
  const harvestDir = join(dir, SLUG, 'harvest');
  mkdirSync(harvestDir, { recursive: true });
  for (const card of records) cpSync(join(SAMPLE, `${card}.json`), join(dir, SLUG, `${card}.json`));
  if (harvest !== undefined) writeFileSync(join(harvestDir, 'harvest.json'), typeof harvest === 'string' ? harvest : JSON.stringify(harvest));
  if (notes !== undefined) writeFileSync(join(harvestDir, 'notes.es.json'), typeof notes === 'string' ? notes : JSON.stringify(notes));
  if (stalePlan) writeFileSync(join(harvestDir, 'plan.json'), '{"stale":true}');
  return dir;
}
const deps = (fetchImpl, dir, env = { LINEAR_API_KEY: KEY }) => ({ env, keyFile: NO_FILE, now: () => NOW, fetchImpl, dataDir: dir });
const planPath = dir => join(dir, SLUG, 'harvest', 'plan.json');
const reviewPath = dir => join(dir, SLUG, 'harvest', 'plan.md');
const counting = () => {
  const sent = [];
  return { sent, fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); throw new Error('no request expected'); } };
};

test('draft and cases read local files only: no key needed and zero requests', async () => {
  const all = join(TMP, 'draft-data');
  mkdirSync(join(all, SLUG), { recursive: true });
  for (const f of readdirSync(SAMPLE).filter(f => f.endsWith('.json'))) cpSync(join(SAMPLE, f), join(all, SLUG, f));
  const none = counting();
  const d = await run(['draft', SLUG], deps(none.fetchImpl, all, {}));
  assert.equal(d.code, 0, d.stderr);
  const drafts = JSON.parse(d.stdout);
  assert.ok(drafts.edges.length > 0);
  assert.ok(drafts.edges.every(e => e.draft === true && e.kind === 'code'));

  const record = JSON.parse(readFileSync(join(SAMPLE, 'ABC-5.json'), 'utf8'));
  const [first] = record.cases;
  const dir = dataDir({
    harvest: { ...HARVEST, notes: ['ABC-5'] }, records: ['ABC-5'],
    notes: { schemaVersion: 1, cards: { 'ABC-5': { [first.id]: { source: caseSource(first), es: 'Caso traducido.' } } } },
  });
  const c = await run(['cases', SLUG], deps(none.fetchImpl, dir, {}));
  assert.equal(c.code, 0, c.stderr);
  const out = JSON.parse(c.stdout);
  assert.deepEqual(out.cases.map(x => [x.card, x.id, x.status]), record.cases.slice(1).map(x => ['ABC-5', x.id, 'missing']));
  assert.equal(none.sent.length, 0);
});

test('usage errors exit 2 with zero requests: no ref, a --apply or --undo flag, draft with a non-slug, undo without --run', async () => {
  const none = counting();
  for (const argv of [[], ['--apply', SLUG], ['plan', SLUG, '--undo', 'x'], ['draft'], ['draft', 'P-ABC-12'], ['cases'], ['undo', SLUG], ['nonsense']]) {
    const r = await run(argv, deps(none.fetchImpl, dataDir()));
    assert.equal(r.code, 2, `${argv.join(' ')} → ${r.code} ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage/);
  }
  assert.equal(none.sent.length, 0);
});

test('no key exits 3 before any request for plan, apply and undo', async () => {
  const dir = dataDir();
  const planned = JSON.parse((await run(['plan', SLUG], deps(store().fetchImpl, dir))).stdout);
  const none = counting();
  for (const argv of [['plan', SLUG], ['apply', SLUG, '--plan', planned.plan, '--approve', planned.hash], ['undo', SLUG, '--run', 'x']]) {
    const r = await run(argv, deps(none.fetchImpl, dir, {}));
    assert.equal(r.code, 3, `${argv.join(' ')} → ${r.code} ${r.stderr}`);
    assert.match(r.stderr, /no Linear key/);
  }
  assert.equal(none.sent.length, 0);
});

const INVALID = { ...HARVEST, edges: [{ from: 'CRM-1', to: 'CRM-2', kind: 'build', evidence: '' }] };
const BAD_NOTES = { schemaVersion: 1, cards: { 'CRM-1': { c1: { source: 'nothex', es: '' } } } };

test('with a slug or URL ref, invalid harvest.json or notes.es.json exits 4 before any request', async () => {
  for (const ref of [SLUG, `https://linear.app/x/project/p-${SLUG}`]) {
    for (const input of [{ harvest: INVALID }, { notes: BAD_NOTES }, { harvest: '{not json' }]) {
      const none = counting();
      const dir = dataDir({ ...input, stalePlan: true });
      const r = await run(['plan', ref], deps(none.fetchImpl, dir));
      assert.equal(r.code, 4, `${ref} ${JSON.stringify(input)} → ${r.code} ${r.stderr}`);
      assert.equal(none.sent.length, 0, ref);
      assert.ok(!existsSync(planPath(dir)), 'the stale plan.json is removed');
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, 'refused');
      assert.equal(out.plan, null);
      assert.ok(out.refusals.length > 0 && out.refusals.every(x => x.kind === 'invalid'));
      assert.match(readFileSync(reviewPath(dir), 'utf8'), /## Refusals/);
    }
  }
});

test('with a P-XXX or UUID ref, invalid input exits 4 after exactly one project read', async () => {
  for (const ref of ['P-ABC-12', UUID]) {
    for (const input of [{ harvest: INVALID }, { notes: BAD_NOTES }]) {
      const fake = store();
      const dir = dataDir({ ...input, stalePlan: true });
      const r = await run(['plan', ref], deps(fake.fetchImpl, dir));
      assert.equal(r.code, 4, `${ref} → ${r.code} ${r.stderr}`);
      assert.equal(fake.sent.length, 1, ref);
      assert.match(fake.sent[0].body.query, /project\(id: \$ref\)/);
      assert.ok(!existsSync(planPath(dir)));
      assert.ok(readFileSync(reviewPath(dir), 'utf8').includes(FIXTURE_NAME));
    }
  }
});

test('with a P-XXX ref and valid input the project is read once, then the issue pages, and the plan is written', async () => {
  const fake = store();
  const dir = dataDir();
  const r = await run(['plan', 'P-ABC-12'], deps(fake.fetchImpl, dir));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.sent.filter(s => /project\(id:/.test(s.body.query)).length, 1);
  assert.ok(fake.sent.length > 1);
  assert.equal(JSON.parse(r.stdout).status, 'written');
  assert.ok(readFileSync(reviewPath(dir), 'utf8').includes('apply P-ABC-12 --plan'));
});

test('a conflict, a cycle or a missing translation refuses with exit 4: status refused, stale plan.json removed, plan.md lists them', async () => {
  const cases = [
    [{ harvest: { ...HARVEST, edges: [{ from: 'CRM-1', to: 'CRM-404', kind: 'code', evidence: 'e' }] } }, /target not found\/archived: CRM-404/],
    [{ harvest: { ...HARVEST, edges: [...HARVEST.edges, { from: 'CRM-2', to: 'CRM-1', kind: 'code', evidence: 'e' }] } }, /cycle/],
    [{ harvest: { ...HARVEST, notes: ['ABC-5'] }, records: ['ABC-5'] }, /needs-translation/],
  ];
  for (const [input, refusal] of cases) {
    const fake = store();
    const dir = dataDir({ ...input, stalePlan: true });
    const r = await run(['plan', SLUG], deps(fake.fetchImpl, dir));
    assert.equal(r.code, 4, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ['counts', 'hash', 'plan', 'refusals', 'review', 'status']);
    assert.equal(out.status, 'refused');
    assert.equal(out.hash, null);
    assert.ok(!existsSync(planPath(dir)));
    const md = readFileSync(reviewPath(dir), 'utf8');
    assert.match(md, refusal);
    assert.match(r.stderr, refusal);
    assert.equal(fake.mutations.length, 0);
  }
});

test('a key outside the project is looked up with IssueState; Linear "Entity not found" is a refusal, an existing card is planned off-project', async () => {
  const fake = store();
  fake.store.issues.push({ ...issue('AUTH-8'), id: 'uuid-AUTH-8', description: '', projectId: 'other' });
  const notFound = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/IssueState/.test(body.query) && body.variables.id === 'AUTH-404') {
      fake.sent.push({ url, init, body });
      return { ok: true, json: async () => ({ data: null, errors: [{ message: 'Entity not found: Issue' }] }) };
    }
    return fake.fetchImpl(url, init);
  };
  const harvest = { ...HARVEST, edges: [{ from: 'AUTH-8', to: 'CRM-1', kind: 'code', evidence: 'e' }, { from: 'AUTH-404', to: 'CRM-2', kind: 'gate', evidence: 'e' }] };
  const r = await run(['plan', SLUG], deps(notFound, dataDir({ harvest })));
  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).refusals.map(x => x.message), ['edges[1]: target not found/archived: AUTH-404']);
  const lookedUp = fake.sent.filter(s => /IssueState/.test(s.body.query)).map(s => s.body.variables.id).sort();
  assert.deepEqual(lookedUp, ['AUTH-404', 'AUTH-8']);

  const ok = await run(['plan', SLUG], deps(fake.fetchImpl, dataDir({ harvest: { ...harvest, edges: [harvest.edges[0]] } })));
  assert.equal(ok.code, 0, ok.stderr);
  const plan = JSON.parse(readFileSync(JSON.parse(ok.stdout).plan, 'utf8'));
  assert.equal(plan.ops[0].offProject, 'AUTH-8');
});

test('a 401 from Linear exits 1 with one line; a GraphQL error echoing the key is redacted everywhere', async () => {
  const denied = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });
  const r = await run(['plan', SLUG], deps(denied, dataDir()));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'Linear HTTP 401 Unauthorized\n');

  const echo = async (url, init) => ({ ok: true, json: async () => ({ data: null, errors: [{ message: `bad key ${init.headers.authorization}` }] }) });
  const e = await run(['plan', 'P-ABC-12'], deps(echo, dataDir()));
  assert.equal(e.code, 1);
  assert.ok(!e.stderr.includes(KEY) && !e.stdout.includes(KEY));
  assert.match(e.stderr, /\[redacted\]/);
});

test('an internal bug exits 1 with the internal error: prefix', async () => {
  const broken = async (url, init) => {
    const { query } = JSON.parse(init.body);
    const data = /project\(id:/.test(query) ? { project: { id: 'p', slugId: SLUG, name: 'P', url: 'u' } } : { issues: { nodes: 5 } };
    return { ok: true, json: async () => ({ data }) };
  };
  const r = await run(['plan', SLUG], deps(broken, dataDir()));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^internal error: /);
});

test('undo lists by default, refuses an --approve that is not the run id with exit 5, and executes with it', async () => {
  const fake = store();
  const dir = dataDir();
  const planned = JSON.parse((await run(['plan', SLUG], deps(fake.fetchImpl, dir))).stdout);
  const applied = await run(['apply', SLUG, '--plan', planned.plan, '--approve', planned.hash], deps(fake.fetchImpl, dir));
  assert.equal(applied.code, 0, applied.stderr);
  const log = join(dir, SLUG, 'harvest', 'applied.jsonl');
  const runId = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]).run;
  const mutations = fake.mutations.length;

  const listed = await run(['undo', SLUG, '--run', runId], deps(fake.fetchImpl, dir));
  assert.equal(listed.code, 0, listed.stderr);
  const out = JSON.parse(listed.stdout);
  assert.equal(out.status, 'listed');
  assert.deepEqual(out.results.map(x => x.action), ['delete relation rel-1: CRM-1 blocks CRM-2']);
  assert.equal(fake.mutations.length, mutations);

  const wrong = await run(['undo', SLUG, '--run', runId, '--approve', 'something-else'], deps(fake.fetchImpl, dir));
  assert.equal(wrong.code, 5);
  assert.equal(fake.mutations.length, mutations);

  const done = await run(['undo', SLUG, '--run', runId, '--approve', runId], deps(fake.fetchImpl, dir));
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).status, 'undone');
  assert.deepEqual(fake.store.relations, []);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.result, l.undo ?? false]), [['applied', false], ['undone', true]]);
  assert.ok(!readFileSync(log, 'utf8').includes(KEY));
});

test('the spawned CLI with an empty env and no key file exits 3 and prints only the reason', () => {
  const home = join(TMP, 'home');
  mkdirSync(home);
  const guard = join(TMP, 'guard.mjs');
  writeFileSync(guard, "globalThis.fetch = () => { throw new Error('network disabled in tests'); };\n");
  const r = spawnSync(process.execPath, ['--import', guard, CLI, 'plan', SLUG], { encoding: 'utf8', env: { HOME: home } });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^no Linear key: set LINEAR_API_KEY or put it in /);
});

test('undo with a P-XXX ref refuses a mismatched --approve with zero requests and lists after exactly one project read', async () => {
  const fake = store();
  const dir = dataDir();
  const planned = JSON.parse((await run(['plan', SLUG], deps(fake.fetchImpl, dir))).stdout);
  assert.equal((await run(['apply', SLUG, '--plan', planned.plan, '--approve', planned.hash], deps(fake.fetchImpl, dir))).code, 0);
  const runId = JSON.parse(readFileSync(join(dir, SLUG, 'harvest', 'applied.jsonl'), 'utf8').split('\n')[0]).run;

  const refused = store();
  const wrong = await run(['undo', 'P-ABC-12', '--run', runId, '--approve', 'other'], deps(refused.fetchImpl, dir));
  assert.equal(wrong.code, 5);
  assert.equal(refused.sent.length, 0);

  const listing = store();
  const listed = await run(['undo', 'P-ABC-12', '--run', runId], deps(listing.fetchImpl, dir));
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listing.sent.length, 1);
  assert.match(listing.sent[0].body.query, /project\(id: \$ref\)/);
  assert.equal(listing.mutations.length, 0);
});
