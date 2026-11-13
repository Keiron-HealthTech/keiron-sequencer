import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/maintenance/rewrite-markers.mjs';
import { normalizeDescription, planHash } from '../scripts/lib/harvest.mjs';
import { fakeLinearStore } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const KEY = 'lin_api_dummy_' + 'r'.repeat(30);
const SLUG = 'abc123def456';
const NOW = new Date('2026-11-13T10:00:00.000Z');
const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-rewrite-markers-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const NO_FILE = join(TMP, 'absent', 'linear.key');

const OLD = key => `<!-- mikado:${key} -->`;
const NEW = key => `<!-- keiron-sequencer:${key} -->`;
const keyOf = identifier => `k${identifier.split('-')[1]}`;

const card = (identifier, description, over = {}) => ({ identifier, title: `Card ${identifier}`, description, ...over });
const legacy = identifier => card(identifier, `Body of ${identifier}\n\n${OLD(keyOf(identifier))}`);
const created = (identifier, result = 'applied') => ({
  v: 1, run: 'aaaaaaaaaaaa@2026-11-01T00:00:00.000Z', at: '2026-11-01T00:00:00.000Z', op: `new:${keyOf(identifier)}`,
  type: 'card.create', result, key: keyOf(identifier), issueId: `uuid-${identifier}`, identifier,
});

let n = 0;
function dataDir(lines) {
  const dir = join(TMP, `data-${++n}`);
  mkdirSync(join(dir, SLUG, 'harvest'), { recursive: true });
  if (lines) writeFileSync(join(dir, SLUG, 'harvest', 'applied.jsonl'), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return dir;
}
const forCards = ids => dataDir(ids.map(id => created(id)));
const deps = (fetchImpl, dir, env = { LINEAR_API_KEY: KEY }, now = NOW) => ({ env, keyFile: NO_FILE, now: () => now, fetchImpl, dataDir: dir, sleep: async () => {} });
const planPath = dir => join(dir, SLUG, 'harvest', 'markers-plan.json');
const logPath = dir => join(dir, SLUG, 'harvest', 'markers.jsonl');
const readPlan = dir => JSON.parse(readFileSync(planPath(dir), 'utf8'));
const readLog = dir => (existsSync(logPath(dir)) ? readFileSync(logPath(dir), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const operation = sent => sent.map(s => s.body.query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1]);
const count = (text, marker) => normalizeDescription(text).split(marker).length - 1;
const descriptionOf = (fake, identifier) => fake.store.issues.find(i => i.identifier === identifier).description;

async function planned(fake, dir, now = NOW) {
  const r = await run(['plan', SLUG], deps(fake.fetchImpl, dir, undefined, now));
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('plan considers every distinct card.create identifier, whatever its result, and nothing else', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-9'].map(legacy) });
  const { issueId, ...noIssueId } = created('ABC-2', 'skipped');
  const dir = dataDir([
    created('ABC-1'), noIssueId, created('ABC-3', 'unverified'),
    { v: 1, run: 'r', at: 't', op: 'edge:ABC-1>ABC-3', type: 'relation.create', result: 'applied', from: 'ABC-1', to: 'ABC-3', relationId: 'rel-1' },
    { v: 1, run: 'r', at: 't', op: 'new:k7', type: 'card.create', result: 'failed', key: 'k7', error: 'Linear HTTP 500' },
    created('ABC-1', 'skipped'),
  ]);
  await planned(fake, dir);
  const p = readPlan(dir);
  assert.deepEqual(p.ops.map(op => op.card), ['ABC-1', 'ABC-2', 'ABC-3']);
  assert.deepEqual(p.skipped, []);
  assert.equal(operation(fake.sent).filter(name => name === 'IssueState').length, 3);
});

test('plan with no applied.jsonl, or an unreadable one, exits 2 naming it with zero requests', async () => {
  for (const dir of [dataDir(), dataDir(['{not json'])]) {
    const fake = fakeLinearStore({ issues: [legacy('ABC-1')] });
    const r = await run(['plan', SLUG], deps(fake.fetchImpl, dir));
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /applied\.jsonl/);
    assert.equal(fake.sent.length, 0);
    assert.ok(!existsSync(planPath(dir)));
  }
});

test('plan replaces only the marker and keeps every other byte of the live description', async () => {
  const live = 'Intro [x](<https://x>) - a\r\n\n* item  \n\n<!-- mikado:k1 -->\ntrailing ';
  const fake = fakeLinearStore({ issues: [card('ABC-1', live), card('ABC-2', 'text\n\n<!-- mikado:k2 -->')] });
  const dir = forCards(['ABC-1', 'ABC-2']);
  await planned(fake, dir);
  const [one, two] = readPlan(dir).ops;
  assert.equal(one.after.description, live.replace('<!-- mikado:k1 -->', '<!-- keiron-sequencer:k1 -->'));
  assert.equal(two.after.description, 'text\n\n<!-- keiron-sequencer:k2 -->');
  assert.deepEqual([one.card, one.issueId, one.key, one.type], ['ABC-1', 'uuid-ABC-1', 'k1', 'notes.replace']);
});

test('plan sends no write request', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2'].map(legacy) });
  await planned(fake, forCards(['ABC-1', 'ABC-2']));
  assert.ok(fake.sent.length > 0);
  assert.deepEqual(fake.sent.filter(s => /\bmutation\b/i.test(s.body.query)), []);
  assert.deepEqual(fake.mutations, []);
});

test('plan lists each skip with its reason and keeps it out of the ops', async () => {
  const fake = fakeLinearStore({ issues: [
    card('ABC-1', `done\n\n${NEW('k1')}`),
    card('ABC-2', 'no marker at all'),
    card('ABC-3', `${OLD('k3')}\n${NEW('k3')}`),
    card('ABC-4', `${OLD('k4')}\n${OLD('k40')}`),
    card('ABC-7', `todo\n\n${OLD('k7')}`),
  ] });
  // The fake answers an unknown id with a null issue; real Linear answers it with an error.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.variables?.id === 'ABC-6') return { ok: true, json: async () => ({ data: null, errors: [{ message: 'Entity not found: ABC-6' }] }) };
    return fake.fetchImpl(url, init);
  };
  const dir = forCards(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6', 'ABC-7']);
  const r = await run(['plan', SLUG], deps(fetchImpl, dir));
  assert.equal(r.code, 0, r.stderr);
  const p = readPlan(dir);
  assert.deepEqual(p.ops.map(op => op.card), ['ABC-7']);
  assert.deepEqual(p.skipped, [
    { card: 'ABC-1', reason: 'already-new' },
    { card: 'ABC-2', reason: 'no-marker' },
    { card: 'ABC-3', reason: 'ambiguous' },
    { card: 'ABC-4', reason: 'ambiguous' },
    { card: 'ABC-5', reason: 'not-found' },
    { card: 'ABC-6', reason: 'not-found' },
  ]);
});

test('plan marks an archived card so the review shows it', async () => {
  const fake = fakeLinearStore({ issues: [legacy('ABC-1'), { ...legacy('ABC-2'), archivedAt: '2026-10-01T00:00:00.000Z' }] });
  const dir = forCards(['ABC-1', 'ABC-2']);
  await planned(fake, dir);
  assert.deepEqual(readPlan(dir).ops.map(op => [op.card, op.archived ?? false]), [['ABC-1', false], ['ABC-2', true]]);
});

test('the plan hash binds the live descriptions and ignores the generation time', async () => {
  const issues = () => ['ABC-1', 'ABC-2'].map(legacy);
  const a = await planned(fakeLinearStore({ issues: issues() }), forCards(['ABC-1', 'ABC-2']));
  const b = await planned(fakeLinearStore({ issues: issues() }), forCards(['ABC-1', 'ABC-2']), new Date('2026-12-01T00:00:00.000Z'));
  assert.equal(a.hash, b.hash);
  const changed = issues();
  changed[1].description = `Edited\n\n${OLD('k2')}`;
  const c = await planned(fakeLinearStore({ issues: changed }), forCards(['ABC-1', 'ABC-2']));
  assert.notEqual(c.hash, a.hash);
});

test('plan writes a hash-bound plan file and prints its path, hash, counts and the apply command', async () => {
  const fake = fakeLinearStore({ issues: [legacy('ABC-1'), card('ABC-2', 'none')] });
  const dir = forCards(['ABC-1', 'ABC-2']);
  const out = await planned(fake, dir);
  const p = readPlan(dir);
  assert.equal(out.status, 'written');
  assert.equal(out.plan, planPath(dir));
  assert.match(out.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.counts, { ops: 1, skipped: 1 });
  assert.ok(out.apply.startsWith('node '), out.apply);
  assert.ok(out.apply.endsWith(`scripts/maintenance/rewrite-markers.mjs apply ${SLUG} ${out.hash.slice(0, 12)}`), out.apply);
  assert.deepEqual([p.schemaVersion, p.kind, p.slug, p.hash, p.generatedAt], [1, 'marker-rewrite', SLUG, out.hash, NOW.toISOString()]);
  assert.equal(planHash(p), p.hash);
});

test('a plan with nothing to rewrite is still written', async () => {
  const fake = fakeLinearStore({ issues: [card('ABC-1', `done\n\n${NEW('k1')}`)] });
  const dir = forCards(['ABC-1']);
  const out = await planned(fake, dir);
  assert.equal(out.status, 'nothing to rewrite');
  assert.deepEqual(out.counts, { ops: 0, skipped: 1 });
  assert.deepEqual(readPlan(dir).ops, []);
  assert.equal(readPlan(dir).hash, out.hash);
});

const apply = (fake, dir, hash, fetchImpl = fake.fetchImpl) => run(['apply', SLUG, hash], deps(fetchImpl, dir));

test('apply refuses a missing, wrong or short hash and an edited or missing plan file with exit 5 and zero requests', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2'].map(legacy) });
  const dir = forCards(['ABC-1', 'ABC-2']);
  const { hash } = await planned(fake, dir);
  const before = fake.sent.length;
  for (const argv of [['apply', SLUG], ['apply', SLUG, 'f'.repeat(64)], ['apply', SLUG, hash.slice(0, 8)]]) {
    const r = await run(argv, deps(fake.fetchImpl, dir));
    assert.equal(r.code, 5, `${argv.join(' ')} → ${r.code} ${r.stderr}`);
  }
  const edited = readPlan(dir);
  edited.ops[0].after.description += ' extra';
  writeFileSync(planPath(dir), JSON.stringify(edited));
  const r = await apply(fake, dir, hash);
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stderr, /edited after planning/);
  const missing = await apply(fake, forCards(['ABC-1']), hash);
  assert.equal(missing.code, 5, missing.stderr);
  assert.match(missing.stderr, /markers-plan\.json/);
  assert.equal(fake.sent.length, before);
  assert.deepEqual(readLog(dir), []);
});

test('apply with a card changed since the plan is stale: exit 6, nothing written, every stale card named', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2', 'ABC-3'].map(legacy) });
  const dir = forCards(['ABC-1', 'ABC-2', 'ABC-3']);
  const { hash } = await planned(fake, dir);
  fake.store.issues.find(i => i.identifier === 'ABC-2').description += '\nedited by hand';
  fake.store.issues.splice(fake.store.issues.findIndex(i => i.identifier === 'ABC-3'), 1);
  const r = await apply(fake, dir, hash);
  assert.equal(r.code, 6, r.stderr);
  assert.match(r.stderr, /ABC-2/);
  assert.match(r.stderr, /ABC-3/);
  assert.doesNotMatch(r.stderr, /ABC-1/);
  assert.match(r.stderr, /run plan again/);
  assert.deepEqual(fake.mutations, []);
  assert.deepEqual(readLog(dir), []);
});

test('apply rewrites only the marker of each card and verifies it through Linear\'s markdown re-serialization', async () => {
  const live = 'See [doc](<https://x>) - first\n\n<!-- mikado:k1 -->';
  const fake = fakeLinearStore({ issues: [card('ABC-1', live), legacy('ABC-2')] });
  const reserialize = text => text.replace(/\]\(<([^<>\s]+)>\)/g, ']($1)').replace(/-/g, '\\-');
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/DescriptionUpdate/.test(body.query)) {
      body.variables.description = reserialize(body.variables.description);
      return fake.fetchImpl(url, { ...init, body: JSON.stringify(body) });
    }
    return fake.fetchImpl(url, init);
  };
  const dir = forCards(['ABC-1', 'ABC-2']);
  const { hash } = await planned(fake, dir);
  const r = await apply(fake, dir, hash, fetchImpl);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results, [{ card: 'ABC-1', result: 'applied' }, { card: 'ABC-2', result: 'applied' }]);
  assert.deepEqual(fake.mutations.map(m => [m.name, m.variables.id]), [['DescriptionUpdate', 'uuid-ABC-1'], ['DescriptionUpdate', 'uuid-ABC-2']]);
  const stored = descriptionOf(fake, 'ABC-1');
  assert.ok(stored.includes('\\-'), stored);
  assert.equal(normalizeDescription(stored), normalizeDescription(live.replace(OLD('k1'), NEW('k1'))));
  for (const id of ['ABC-1', 'ABC-2']) {
    assert.equal(count(descriptionOf(fake, id), NEW(keyOf(id))), 1);
    assert.equal(count(descriptionOf(fake, id), OLD(keyOf(id))), 0);
  }
});

test('a write whose read-back lost the marker is logged unverified and stops the run with exit 1', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2'].map(legacy), markdown: { dropComments: true } });
  const dir = forCards(['ABC-1', 'ABC-2']);
  const { hash } = await planned(fake, dir);
  const r = await apply(fake, dir, hash);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /unverified: ABC-1/);
  assert.equal(fake.mutations.length, 1);
  assert.deepEqual(readLog(dir).map(l => [l.card, l.result]), [['ABC-1', 'unverified']]);
  assert.equal(descriptionOf(fake, 'ABC-2'), legacy('ABC-2').description);
});

test('a failed second write leaves exactly one card rewritten, logs the failure and exits 1', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2', 'ABC-3'].map(legacy), failOn: { op: 'DescriptionUpdate', nth: 2, as: 'http500' } });
  const dir = forCards(['ABC-1', 'ABC-2', 'ABC-3']);
  const { hash } = await planned(fake, dir);
  const r = await apply(fake, dir, hash);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /failed: ABC-2: Linear HTTP 500/);
  assert.deepEqual(['ABC-1', 'ABC-2', 'ABC-3'].map(id => count(descriptionOf(fake, id), NEW(keyOf(id)))), [1, 0, 0]);
  const log = readLog(dir);
  assert.deepEqual(log.map(l => [l.card, l.result]), [['ABC-1', 'applied'], ['ABC-2', 'failed']]);
  assert.match(log[1].error, /Linear HTTP 500/);
});

test('the log holds one line per card with the plan hash, time, card, result and full before-description, and only grows; applied.jsonl is untouched', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2', 'ABC-3'].map(legacy) });
  const dir = forCards(['ABC-1', 'ABC-2']);
  const applied = readFileSync(join(dir, SLUG, 'harvest', 'applied.jsonl'), 'utf8');
  const { hash } = await planned(fake, dir);
  assert.equal((await apply(fake, dir, hash)).code, 0);
  assert.equal(readFileSync(join(dir, SLUG, 'harvest', 'applied.jsonl'), 'utf8'), applied);
  const first = readLog(dir);
  assert.deepEqual(first, ['ABC-1', 'ABC-2'].map(id => ({
    v: 1, hash, at: NOW.toISOString(), card: id, issueId: `uuid-${id}`, key: keyOf(id), result: 'applied',
    from: OLD(keyOf(id)), to: NEW(keyOf(id)), before: legacy(id).description,
  })));
  const text = readFileSync(logPath(dir), 'utf8');
  writeFileSync(join(dir, SLUG, 'harvest', 'applied.jsonl'), ['ABC-1', 'ABC-2', 'ABC-3'].map(id => JSON.stringify(created(id))).join('\n') + '\n');
  const again = await planned(fake, dir);
  assert.equal((await apply(fake, dir, again.hash)).code, 0);
  const grown = readFileSync(logPath(dir), 'utf8');
  assert.ok(grown.startsWith(text));
  assert.deepEqual(readLog(dir).slice(2).map(l => [l.card, l.hash]), [['ABC-3', again.hash]]);
});

test('after a partial apply the old plan is stale, and a fresh plan holds only the unwritten cards and completes them', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2', 'ABC-3'].map(legacy), failOn: { op: 'DescriptionUpdate', nth: 2, as: 'http500' } });
  const dir = forCards(['ABC-1', 'ABC-2', 'ABC-3']);
  const first = await planned(fake, dir);
  assert.equal((await apply(fake, dir, first.hash)).code, 1);
  const stale = await apply(fake, dir, first.hash);
  assert.equal(stale.code, 6, stale.stderr);
  assert.match(stale.stderr, /ABC-1/);
  const fresh = await planned(fake, dir);
  assert.deepEqual(readPlan(dir).ops.map(op => op.card), ['ABC-2', 'ABC-3']);
  assert.deepEqual(readPlan(dir).skipped, [{ card: 'ABC-1', reason: 'already-new' }]);
  const r = await apply(fake, dir, fresh.hash);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(['ABC-1', 'ABC-2', 'ABC-3'].map(id => count(descriptionOf(fake, id), NEW(keyOf(id)))), [1, 1, 1]);
});

test('a second full run plans nothing and its apply writes nothing and logs nothing', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2'].map(legacy) });
  const dir = forCards(['ABC-1', 'ABC-2']);
  assert.equal((await apply(fake, dir, (await planned(fake, dir)).hash)).code, 0);
  const log = readFileSync(logPath(dir), 'utf8');
  const writes = fake.mutations.length;
  const again = await planned(fake, dir);
  assert.equal(again.status, 'nothing to rewrite');
  const r = await apply(fake, dir, again.hash);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results, []);
  assert.equal(fake.mutations.length, writes);
  assert.equal(readFileSync(logPath(dir), 'utf8'), log);
});

test('--inverse and other usage errors exit 2 with zero requests', async () => {
  const fake = fakeLinearStore({ issues: [legacy('ABC-1')] });
  const dir = forCards(['ABC-1']);
  const { hash } = await planned(fake, dir);
  const before = fake.sent.length;
  for (const argv of [
    ['plan', SLUG, '--inverse'], ['apply', SLUG, hash, '--inverse'], ['--inverse', 'apply', SLUG, hash],
    [], ['plan'], ['plan', 'not-a-slug'], ['plan', SLUG, 'extra'], ['apply', SLUG, hash, 'extra'], ['undo', SLUG],
  ]) {
    const r = await run(argv, deps(fake.fetchImpl, dir));
    assert.equal(r.code, 2, `${argv.join(' ')} → ${r.code} ${r.stderr}`);
    assert.match(r.stderr, /^usage: /);
  }
  assert.equal(fake.sent.length, before);
});

test('with no Linear key plan and apply exit 3 with zero requests', async () => {
  const fake = fakeLinearStore({ issues: [legacy('ABC-1')] });
  const dir = forCards(['ABC-1']);
  const { hash } = await planned(fake, dir);
  const before = fake.sent.length;
  for (const argv of [['plan', SLUG], ['apply', SLUG, hash]]) {
    const r = await run(argv, deps(fake.fetchImpl, dir, {}));
    assert.equal(r.code, 3, `${argv.join(' ')} → ${r.code} ${r.stderr}`);
    assert.match(r.stderr, /no Linear key/);
  }
  assert.equal(fake.sent.length, before);
});

test('the key never reaches stdout, stderr, the plan or the log, even inside a Linear error', async () => {
  const fake = fakeLinearStore({ issues: ['ABC-1', 'ABC-2'].map(legacy), failOn: { op: 'DescriptionUpdate', nth: 2, as: 'graphql' } });
  const dir = forCards(['ABC-1', 'ABC-2']);
  const p = await run(['plan', SLUG], deps(fake.fetchImpl, dir));
  const { hash } = JSON.parse(p.stdout);
  const a = await run(['apply', SLUG, hash], deps(fake.fetchImpl, dir));
  assert.equal(a.code, 1, a.stderr);
  assert.match(a.stderr, /forbidden for key/);
  assert.deepEqual(readLog(dir).map(l => l.result), ['applied', 'failed']);
  for (const text of [p.stdout, p.stderr, a.stdout, a.stderr, readFileSync(planPath(dir), 'utf8'), readFileSync(logPath(dir), 'utf8')]) {
    assert.ok(!text.includes(KEY.slice(0, 20)), text);
  }
});
