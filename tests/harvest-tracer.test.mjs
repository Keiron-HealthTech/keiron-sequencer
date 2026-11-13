import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/harvest.mjs';
import { applyPlan } from '../scripts/lib/harvest-apply.mjs';
import { createBlocks } from '../scripts/lib/linear-write.mjs';
import { fetchDescriptions, fetchIssueState, fetchProjectMap } from '../scripts/lib/linear-fetch.mjs';
import { computePlan, planHash, renderReview, validateHarvest } from '../scripts/lib/harvest.mjs';
import { fakeLinearStore, FIXTURE_NAME, FIXTURE_SLUG as SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'h'.repeat(30);

const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});

const isMutation = s => /\bmutation\b/i.test(s.body.query);

test('the network guard makes the global fetch throw, so only an injected fake can answer', async () => {
  assert.throws(() => globalThis.fetch('https://api.linear.app/graphql'), /network/i);
  await assert.rejects(fetchProjectMap(SLUG, KEY), /network/i);
});

test('the store-backed fake answers the project map and IssueState from one store with deterministic ids', async () => {
  const { fetchImpl, sent, store } = fakeLinearStore({
    issues: [
      issue('CRM-1', { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-2' } }] } }),
      issue('CRM-2'),
    ],
  });
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl });
  assert.equal(raw.project.id, 'project-uuid');
  assert.deepEqual(raw.issues.map(i => [i.identifier, i.id]), [['CRM-1', 'uuid-CRM-1'], ['CRM-2', 'uuid-CRM-2']]);
  assert.deepEqual(raw.issues[0].relations.nodes.map(r => [r.type, r.relatedIssue.identifier]), [['blocks', 'CRM-2']]);
  assert.deepEqual(raw.issues[1].inverseRelations.nodes.map(r => [r.type, r.issue.identifier]), [['blocks', 'CRM-1']]);

  const state = await fetchIssueState('CRM-1', KEY, { fetchImpl });
  assert.deepEqual(state, {
    id: 'uuid-CRM-1', identifier: 'CRM-1', title: 'Card CRM-1', description: '', archivedAt: null,
    projectId: 'project-uuid', blocks: [{ id: 'rel-1', to: 'CRM-2' }],
  });
  assert.deepEqual(store.relations, [{ id: 'rel-1', type: 'blocks', from: 'CRM-1', to: 'CRM-2' }]);
  assert.equal(sent.filter(isMutation).length, 0);
  assert.match(sent.at(-1).body.query, /^\s*query IssueState\(/);
});

test('descriptions are read page by page through the named HarvestDescriptions query, archived issues included', async () => {
  const { fetchImpl, sent } = fakeLinearStore({
    issues: [issue('CRM-1', { description: 'one' }), issue('CRM-2', { archivedAt: '2026-11-01T00:00:00.000Z' })],
    page: 1,
  });
  const map = await fetchDescriptions('project-uuid', KEY, { fetchImpl });
  assert.deepEqual([...map.entries()], [
    ['CRM-1', { id: 'uuid-CRM-1', title: 'Card CRM-1', description: 'one', archivedAt: null }],
    ['CRM-2', { id: 'uuid-CRM-2', title: 'Card CRM-2', description: '', archivedAt: '2026-11-01T00:00:00.000Z' }],
  ]);
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.match(s.body.query, /^\s*query HarvestDescriptions\(/);
    assert.match(s.body.query, /includeArchived: true/);
    assert.equal(s.body.variables.projectId, 'project-uuid');
  }
});

const EVIDENCE = 'fixup: CRM-2 touched apps/base/src/deal.service.ts owned by CRM-1';
const HARVEST = {
  schemaVersion: 1,
  project: { slug: SLUG },
  edges: [{ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: EVIDENCE }],
  notes: [],
};
const slice = () => fakeLinearStore({ issues: [issue('CRM-1'), issue('CRM-2')] });

test('one harvest edge absent live validates and plans exactly one relation.create with a stable hash and an apply command', async () => {
  assert.deepEqual(validateHarvest(HARVEST), []);
  assert.notDeepEqual(validateHarvest({ ...HARVEST, edges: [{ ...HARVEST.edges[0], kind: 'build' }] }), []);

  const { fetchImpl } = slice();
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl });
  const { plan, refusals } = computePlan({ harvest: HARVEST, records: [], notes: null, raw, descriptions: new Map() });
  assert.deepEqual(refusals, []);
  assert.deepEqual(plan.ops, [{
    id: 'rel+:CRM-1>CRM-2', type: 'relation.create', from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: EVIDENCE,
    before: { exists: false }, after: { exists: true },
  }]);
  assert.deepEqual(plan.project, { id: 'project-uuid', slug: SLUG, name: FIXTURE_NAME });
  assert.match(plan.hash, /^[0-9a-f]{64}$/);
  assert.equal(planHash(plan), plan.hash);
  assert.equal(planHash({ ...plan, generatedAt: '2026-11-09T10:00:00.000Z' }), plan.hash);
  const again = computePlan({ harvest: HARVEST, records: [], notes: null, raw, descriptions: new Map() }).plan;
  assert.equal(again.hash, plan.hash);

  const approveCommand = `node scripts/harvest.mjs apply ${SLUG} --plan /tmp/x/plan.json --approve ${plan.hash.slice(0, 12)}`;
  const md = renderReview(plan, { refusals, approveCommand });
  assert.ok(md.includes(plan.hash), 'review shows the hash');
  assert.ok(md.includes(approveCommand), 'review shows the exact apply command');
  assert.ok(md.includes('CRM-1 blocks CRM-2'));
  assert.ok(!md.includes(KEY));
});

test('an edge already live is kept, not planned', async () => {
  const { fetchImpl } = fakeLinearStore({ issues: [
    issue('CRM-1', { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-2' } }] } }), issue('CRM-2'),
  ] });
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl });
  const { plan } = computePlan({ harvest: HARVEST, records: [], notes: null, raw, descriptions: new Map() });
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.keep, [{ from: 'CRM-1', to: 'CRM-2', kind: 'code', evidence: EVIDENCE }]);
});

const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-harvest-tracer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const NO_FILE = join(TMP, 'absent', 'linear.key');
const NOW = new Date('2026-11-09T10:00:00.000Z');

const dataDirWith = (name, harvest = HARVEST) => {
  const dataDir = join(TMP, name);
  mkdirSync(join(dataDir, SLUG, 'harvest'), { recursive: true });
  writeFileSync(join(dataDir, SLUG, 'harvest', 'harvest.json'), `${JSON.stringify(harvest, null, 2)}\n`);
  return dataDir;
};
const cliDeps = (fetchImpl, dataDir) => ({ env: { LINEAR_API_KEY: KEY }, keyFile: NO_FILE, now: () => NOW, fetchImpl, dataDir });

test('the CLI plan subcommand reaches Linear through the injected fake and reports the plan as written', async () => {
  const { fetchImpl } = slice();
  const r = await run(['plan', SLUG], cliDeps(fetchImpl, dataDirWith('plan-wire')));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'written');
});

test('plan writes plan.json and plan.md under data/<slug>/harvest only, the hash recomputes and no mutation is sent', async () => {
  const { fetchImpl, sent } = slice();
  const dataDir = dataDirWith('plan-files');
  const r = await run([SLUG], cliDeps(fetchImpl, dataDir));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  const dir = join(dataDir, SLUG, 'harvest');
  assert.deepEqual(Object.keys(out).sort(), ['counts', 'hash', 'plan', 'refusals', 'review', 'status']);
  assert.equal(out.plan, join(dir, 'plan.json'));
  assert.equal(out.review, join(dir, 'plan.md'));
  assert.deepEqual(out.refusals, []);
  assert.deepEqual(out.counts, { ops: 1, keep: 0, noop: 0, held: 0, warnings: 0 });

  const plan = JSON.parse(readFileSync(out.plan, 'utf8'));
  assert.equal(plan.generatedAt, NOW.toISOString());
  assert.equal(plan.hash, out.hash);
  assert.equal(planHash(plan), plan.hash);
  assert.deepEqual(plan.ops.map(op => op.id), ['rel+:CRM-1>CRM-2']);

  const md = readFileSync(out.review, 'utf8');
  assert.ok(md.includes(plan.hash));
  assert.ok(md.includes(`apply ${SLUG} --plan ${out.plan} --approve ${plan.hash.slice(0, 12)}`));
  assert.equal(sent.filter(isMutation).length, 0);
  assert.ok(!r.stdout.includes(KEY) && !md.includes(KEY));
  assert.ok(!existsSync(join(dir, 'applied.jsonl')));
});

const planFor = async store => {
  const raw = await fetchProjectMap(SLUG, KEY, { fetchImpl: store.fetchImpl });
  return computePlan({ harvest: HARVEST, records: [], notes: null, raw, descriptions: new Map() }).plan;
};

test('linear-write has no default transport: without an injected fetchImpl it refuses before any request', async () => {
  await assert.rejects(createBlocks('uuid-CRM-1', 'uuid-CRM-2', { apiKey: KEY }), /fetchImpl/);
});

test('applyPlan sends one blocks mutation through linear-write with the blocker as issueId and the type as a literal', async () => {
  const fake = slice();
  const plan = await planFor(fake);
  const { code } = await applyPlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: () => {} });
  assert.equal(code, 0);
  const sentMutations = fake.sent.filter(isMutation);
  assert.equal(sentMutations.length, 1);
  const { query, variables } = sentMutations[0].body;
  assert.match(query, /^\s*mutation RelationCreate\(/);
  assert.match(query, /type: blocks, issueId: \$blocker, relatedIssueId: \$blocked/);
  assert.deepEqual(variables, { blocker: 'uuid-CRM-1', blocked: 'uuid-CRM-2' });
});

const opName = s => s.body.query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? null;

test('applyPlan reads the blocker before and after the write, logs one applied line, and a second run only skips', async () => {
  const fake = slice();
  const plan = await planFor(fake);
  const start = fake.sent.length;
  const logged = [];
  const first = await applyPlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: l => logged.push(l) });
  assert.equal(first.code, 0);
  assert.deepEqual(first.results, [{ op: 'rel+:CRM-1>CRM-2', result: 'applied' }]);

  const calls = fake.sent.slice(start);
  const m = calls.findIndex(isMutation);
  assert.equal(opName(calls[m - 1]), 'IssueState');
  assert.equal(calls[m - 1].body.variables.id, 'uuid-CRM-1');
  assert.equal(opName(calls[m + 1]), 'IssueState');
  assert.ok(calls.slice(m + 2).some(s => /project\(id:/.test(s.body.query)), 'a final re-fetch follows the last write');
  assert.deepEqual(fake.store.relations, [{ id: 'rel-1', type: 'blocks', from: 'CRM-1', to: 'CRM-2' }]);

  const run = `${plan.hash.slice(0, 12)}@${NOW.toISOString()}`;
  assert.deepEqual(logged, [{
    v: 1, run, at: NOW.toISOString(), op: 'rel+:CRM-1>CRM-2', type: 'relation.create', result: 'applied',
    from: 'CRM-1', to: 'CRM-2', relationId: 'rel-1',
  }]);

  const mutationsBefore = fake.mutations.length;
  const again = [];
  const second = await applyPlan(plan, { apiKey: KEY, fetchImpl: fake.fetchImpl, now: () => NOW, appendLog: l => again.push(l) });
  assert.equal(second.code, 0);
  assert.equal(fake.mutations.length, mutationsBefore);
  assert.deepEqual(again.map(l => [l.op, l.result, l.relationId]), [['rel+:CRM-1>CRM-2', 'skipped', 'rel-1']]);
  assert.ok(!JSON.stringify([...logged, ...again]).includes(KEY));
});

test('a write Linear acknowledges but does not keep fails verify: one unverified line, code 1, nothing after it', async () => {
  const fake = slice();
  const plan = await planFor(fake);
  const forgetful = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/^\s*mutation RelationCreate\(/.test(body.query)) {
      fake.sent.push({ url, init, body });
      return { ok: true, json: async () => ({ data: { issueRelationCreate: { success: true, issueRelation: { id: 'rel-ghost' } } } }) };
    }
    return fake.fetchImpl(url, init);
  };
  const logged = [];
  const r = await applyPlan(plan, { apiKey: KEY, fetchImpl: forgetful, now: () => NOW, appendLog: l => logged.push(l), sleep: async () => {} });
  assert.equal(r.code, 1);
  assert.deepEqual(logged.map(l => [l.op, l.result]), [['rel+:CRM-1>CRM-2', 'unverified']]);
  assert.deepEqual(fake.store.relations, []);
});

const planned = async (name, fake = slice()) => {
  const dataDir = dataDirWith(name);
  const r = await run(['plan', SLUG], cliDeps(fake.fetchImpl, dataDir));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  return { dataDir, fake, planFile: out.plan, hash: out.hash, log: join(dataDir, SLUG, 'harvest', 'applied.jsonl') };
};
const readLog = path => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('apply with the plan file and a 12-hex approval runs the slice end to end and appends to applied.jsonl', async () => {
  const { dataDir, fake, planFile, hash, log } = await planned('apply-slice');
  const r = await run(['apply', SLUG, '--plan', planFile, '--approve', hash.slice(0, 12)], cliDeps(fake.fetchImpl, dataDir));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'applied');
  assert.equal(fake.mutations.length, 1);
  assert.deepEqual(readLog(log).map(l => [l.op, l.result, l.relationId]), [['rel+:CRM-1>CRM-2', 'applied', 'rel-1']]);

  const again = await run(['apply', SLUG, '--plan', planFile, '--approve', hash], cliDeps(fake.fetchImpl, dataDir));
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fake.mutations.length, 1);
  assert.deepEqual(readLog(log).map(l => l.result), ['applied', 'skipped']);
  assert.ok(!readFileSync(log, 'utf8').includes(KEY));
});

test('apply refuses with exit 5 and sends nothing without --plan or --approve, with a wrong or short hash, or with an edited plan', async () => {
  const { dataDir, planFile, hash, log } = await planned('apply-refused');
  const edited = join(dataDir, 'edited.json');
  const tampered = JSON.parse(readFileSync(planFile, 'utf8'));
  tampered.ops[0].evidence = 'edited after review';
  writeFileSync(edited, JSON.stringify(tampered));
  const wrong = hash.startsWith('0') ? `1${hash.slice(1, 12)}` : `0${hash.slice(1, 12)}`;
  for (const argv of [
    ['apply', SLUG, '--plan', planFile],
    ['apply', SLUG, '--approve', hash],
    ['apply', SLUG, '--plan', planFile, '--approve', wrong],
    ['apply', SLUG, '--plan', planFile, '--approve', hash.slice(0, 8)],
    ['apply', SLUG, '--plan', edited, '--approve', hash],
  ]) {
    const fresh = slice();
    const r = await run(argv, cliDeps(fresh.fetchImpl, dataDir));
    assert.equal(r.code, 5, `${argv.join(' ')} → ${r.code} ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.trim().length > 0);
    assert.equal(fresh.sent.length, 0, argv.join(' '));
  }
  assert.ok(!existsSync(log));
});

test('apply refuses with exit 5 and no mutation when the ref resolves to another project', async () => {
  const { dataDir, planFile, hash } = await planned('apply-other-project');
  const other = fakeLinearStore({
    issues: [issue('CRM-1'), issue('CRM-2')],
    project: { id: 'other-uuid', slugId: 'aaaaaaaaaaaa', name: 'Other', url: 'u' },
  });
  const r = await run(['apply', SLUG, '--plan', planFile, '--approve', hash], cliDeps(other.fetchImpl, dataDir));
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stderr, /project/);
  assert.equal(other.mutations.length, 0);
});

test('drift before any write exits 6 naming the op, with zero mutations: the reverse relation appeared or an endpoint was archived', async () => {
  const { dataDir, fake, planFile, hash, log } = await planned('apply-drift');
  fake.store.relations.push({ id: 'rel-9', type: 'blocks', from: 'CRM-2', to: 'CRM-1' });
  const r = await run(['apply', SLUG, '--plan', planFile, '--approve', hash], cliDeps(fake.fetchImpl, dataDir));
  assert.equal(r.code, 6, r.stderr);
  assert.match(r.stderr, /rel\+:CRM-1>CRM-2/);
  assert.match(r.stderr, /CRM-2 already blocks CRM-1/);
  assert.equal(fake.mutations.length, 0);
  assert.ok(!existsSync(log));

  const archived = slice();
  const plan = await planFor(archived);
  archived.store.issues[1].archivedAt = '2026-11-09T09:00:00.000Z';
  const res = await applyPlan(plan, { apiKey: KEY, fetchImpl: archived.fetchImpl, now: () => NOW, appendLog: () => assert.fail('nothing logged') });
  assert.equal(res.code, 6);
  assert.equal(archived.mutations.length, 0);
});
