import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { runDir, TRIAL_DIR, writeJsonAtomic } from '../scripts/lib/spike/home.mjs';
import { createRun } from '../scripts/lib/spike/state.mjs';
import { subcommandOf } from './helpers/fake-git.mjs';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { A, B, issue, notes, PATCH_A, PROJECT_URL, SENTINEL, SLUG, respikeFixture, snapshotDir, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const P = 'CRM-3';
const json = r => JSON.parse(r.stdout);
const blocks = (...keys) => ({ nodes: keys.map(k => ({ type: 'blocks', relatedIssue: { identifier: k } })) });
const pick = [PROJECT_URL, '--cards', B];
const WRITES = new Set(['fetch', 'clone', 'worktree add', 'worktree remove', 'read-tree', 'apply', 'add', 'write-tree', 'update-ref', 'checkout', 'config', 'commit', 'push', 'tag']);

// A blocks B; P has an open PR and blocks B too.
function withPr(extra = []) {
  const prs = [];
  const f = respikeFixture({
    gh: () => JSON.stringify(prs),
    issues: ([a, b]) => [a, b, issue(P, { state: { name: 'In Review', type: 'started' }, relations: blocks(B) }), ...extra],
  });
  const commit = (branch, file, content, from = 'main') => {
    f.repo.git(['checkout', '-q', '-B', branch, from]);
    writeFileSync(join(f.repo.dir, file), content);
    f.repo.git(['add', '-A']);
    f.repo.git(['commit', '-q', '-m', `${branch} ${file}`]);
    const sha = f.repo.git(['rev-parse', 'HEAD']).trim();
    f.repo.git(['checkout', '-q', 'main']);
    return sha;
  };
  const pr = (number, key, headRefName, headRefOid) => ({
    number, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName, headRefOid, isCrossRepository: false,
    title: `[${key}] work`, url: `https://github.com/acme/backend/pull/${number}`,
  });
  return { f, prs, commit, pr };
}

function runIn(f, status) {
  const project = { id: 'project-uuid', slug: SLUG, name: 'P', url: PROJECT_URL };
  const runId = '20261105T100000Z';
  const state = createRun({ runId, project, plan: { fetchedAt: '2026-11-05T10:00:00.000Z', order: [], skipped: [], cards: {} }, home: f.home, dataDir: f.dataDir, now: new Date('2026-11-05T10:00:00.000Z') });
  state.status = status;
  writeJsonAtomic(join(runDir(f.home, SLUG, runId), 'run.json'), state);
  return runId;
}

test('begin keeps the picked cards dropped as built and every ancestor with its mode and reason, for the offline report', async () => {
  const C = 'CRM-8';
  const { f, prs, commit, pr } = withPr([issue(C, { relations: blocks(B) })]);
  prs.push(pr(30, P, 'p3', commit('p3', 'p.txt', 'p\n')));
  const both = [PROJECT_URL, '--cards', `${B},${P}`];
  const plan = json(await f.run('preflight', both));
  assert.equal(plan.action, 'ready');
  f.at('2026-11-10T10:01:00.000Z');
  const out = json(await f.run('begin', [...both, '--approve', plan.approve]));
  const { respike } = JSON.parse(readFileSync(join(runDir(f.home, SLUG, out.runId), 'run.json'), 'utf8')).plan;
  assert.deepEqual(respike.selection.dropped, [{ key: P, reason: 'built' }]);
  assert.deepEqual(respike.ancestors, [
    { key: A, mode: 'replay', reason: null, sharedWith: [] },
    { key: C, mode: 'spike', reason: 'no-record', sharedWith: [] },
  ]);
});

test('begin after a complete run creates a new active run carrying the plan order, bases and entry kinds, with counts and caps', async () => {
  const { f, prs, commit, pr } = withPr();
  prs.push(pr(30, P, 'p3', commit('p3', 'p.txt', 'p\n')));
  const plan = json(await f.run('preflight', pick));
  assert.equal(plan.action, 'ready');
  const before = f.git.calls.length;
  f.at('2026-11-10T10:01:00.000Z');
  const session = join(f.scratch, 'session.jsonl');
  const r = await f.run('begin', [...pick, '--approve', plan.approve, '--max-cards', '2', '--max-tokens', '5000', '--box', '300', '--session-file', session]);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(out.respike, { selected: 1, replay: 1, spike: 1, built: 1 });
  assert.deepEqual(out.plan.order, [A, B]);
  const state = JSON.parse(readFileSync(join(runDir(f.home, SLUG, out.runId), 'run.json'), 'utf8'));
  assert.equal(state.status, 'active');
  assert.deepEqual(state.plan.order, [A, B]);
  assert.deepEqual(state.plan.respike.bases, plan.bases);
  assert.deepEqual([state.plan.cards[A].mode, state.plan.cards[B].mode], ['replay', 'spike']);
  assert.deepEqual(state.plan.respike.replay[A].units, { backend: [PATCH_A] });
  assert.deepEqual(state.executions[0].caps, { tokens: 5000, cards: 2 });
  assert.equal(state.executions[0].box, 300);
  assert.deepEqual(state.executions[0].sessions.map(s => [s.file, s.given]), [[session, true]]);
  const seen = f.git.calls.slice(before).map(c => subcommandOf(c.argv));
  assert.deepEqual(seen.filter(s => WRITES.has(s)), []);
  assert.ok(f.git.calls.slice(before).filter(c => subcommandOf(c.argv) === 'merge-tree').every(c => c.env?.GIT_OBJECT_DIRECTORY));
  assert.equal(r.stdout.includes(SENTINEL), false);
});

test('begin refuses a wrong hash with exit 5, a missing --approve or a bad cap with exit 2, and the home stays byte-identical', async () => {
  const f = respikeFixture();
  const plan = json(await f.run('preflight', pick));
  const home = snapshotDir(f.home);
  assert.equal((await f.run('begin', pick)).code, 2);
  assert.equal((await f.run('begin', [...pick, '--approve', plan.approve, '--max-cards', '0'])).code, 2);
  const wrong = await f.run('begin', [...pick, '--approve', 'abcdefabcdef']);
  assert.equal(wrong.code, 5);
  assert.match(wrong.stderr, new RegExp(plan.approve));
  assert.deepEqual(snapshotDir(f.home), home);
});

test('a PR head that moved between preflight and begin changes the hash, so begin refuses with exit 5', async () => {
  const { f, prs, commit, pr } = withPr();
  prs.push(pr(30, P, 'p3', commit('p3', 'p.txt', 'p\n')));
  const plan = json(await f.run('preflight', pick));
  prs[0] = pr(30, P, 'p3', commit('p3', 'p.txt', 'p moved\n', 'p3'));
  const home = snapshotDir(f.home);
  const r = await f.run('begin', [...pick, '--approve', plan.approve]);
  assert.equal(r.code, 5);
  assert.deepEqual(snapshotDir(f.home), home);
});

test('begin refuses an ask plan given its own hash, and an open run, with exit 5 and nothing written', async () => {
  const { f, commit } = withPr();
  commit('crm-3-wip', 'three.txt', '3\n');
  const asked = json(await f.run('preflight', pick));
  assert.equal(asked.action, 'ask');
  const home = snapshotDir(f.home);
  const refused = await f.run('begin', [...pick, '--approve', asked.approve]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /ask, not ready/);
  assert.deepEqual(snapshotDir(f.home), home);

  const ready = json(await f.run('preflight', [...pick, '--unbuilt', P]));
  const runId = runIn(f, 'paused');
  const open = await f.run('begin', [...pick, '--unbuilt', P, '--approve', ready.approve]);
  assert.equal(open.code, 5);
  assert.match(open.stderr, new RegExp(runId));
});

test('with no runs dir at all, begin creates the first run from trial records', async () => {
  const f = respikeFixture();
  const trial = join(f.home, SLUG, TRIAL_DIR);
  mkdirSync(join(trial, 'backend'), { recursive: true });
  writeFileSync(join(trial, PATCH_A), readFileSync(join(f.home, SLUG, 'runs', f.oldRunId, 'patches', PATCH_A)));
  for (const card of [A, B]) {
    const path = join(f.dataDir, SLUG, `${card}.json`);
    const old = JSON.parse(readFileSync(path, 'utf8'));
    const { runId: _, ...refs } = old.refs;
    writeFileSync(path, serializeRecord({ ...old, refs }));
  }
  rmSync(join(f.home, SLUG, 'runs'), { recursive: true, force: true });
  const plan = json(await f.run('preflight', pick));
  assert.equal(plan.action, 'ready');
  assert.deepEqual(plan.previous, { runId: null, records: 2, fromTrial: 2 });
  f.at('2026-11-10T10:01:00.000Z');
  const r = await f.run('begin', [...pick, '--approve', plan.approve]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(walk(join(f.home, SLUG, 'runs')), [`${json(r).runId}/run.json`]);
});

// P's PR head exists only in the origin under refs/pull/30/head; Q's PR head is in the checkout.
function missingHead() {
  const Q = 'CRM-4';
  const prs = [];
  const f = respikeFixture({
    gh: () => JSON.stringify(prs),
    issues: ([a, b]) => [a, b, ...[P, Q].map(k => issue(k, { state: { name: 'In Review', type: 'started' }, relations: blocks(B) }))],
  });
  const other = join(f.scratch, 'other');
  sandboxGit(['clone', '-q', f.origin.dir, other]);
  writeFileSync(join(other, 'p.txt'), 'p\n');
  sandboxGit(['add', '-A'], { cwd: other });
  sandboxGit(['commit', '-q', '-m', 'p'], { cwd: other });
  const pSha = sandboxGit(['rev-parse', 'HEAD'], { cwd: other }).trim();
  sandboxGit(['push', '-q', f.origin.dir, 'HEAD:refs/pull/30/head'], { cwd: other });
  f.repo.git(['checkout', '-q', '-b', 'q4']);
  writeFileSync(join(f.repo.dir, 'q.txt'), 'q\n');
  f.repo.git(['add', '-A']);
  f.repo.git(['commit', '-q', '-m', 'q']);
  const qSha = f.repo.git(['rev-parse', 'HEAD']).trim();
  f.repo.git(['checkout', '-q', 'main']);
  const pr = (number, key, headRefName, headRefOid) => ({
    number, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName, headRefOid, isCrossRepository: false,
    title: `[${key}] work`, url: `https://github.com/acme/backend/pull/${number}`,
  });
  prs.push(pr(30, P, 'p3', pSha), pr(40, Q, 'q4', qSha));
  return { f, pSha, qSha };
}

test('fetch on a bases-unknown plan fetches each missing PR head by its pull ref and nothing else, writes nothing, and prints the next hash', async () => {
  const { f, pSha } = missingHead();
  const plan = json(await f.run('preflight', pick));
  assert.equal(plan.action, 'ask');
  assert.deepEqual(plan.asks.map(a => [a.code, a.cards]), [['bases-unknown', [P]]]);
  const home = snapshotDir(f.home);
  const data = snapshotDir(f.dataDir);
  const before = f.git.calls.length;
  const r = await f.run('fetch', [...pick, '--approve', plan.approve]);
  assert.equal(r.code, 0, r.stderr);
  const writes = f.git.calls.slice(before).filter(c => WRITES.has(subcommandOf(c.argv)));
  assert.deepEqual(writes.map(c => [c.argv, c.cwd]), [[['fetch', '-q', 'origin', 'refs/pull/30/head'], f.repo.dir]]);
  assert.deepEqual(snapshotDir(f.home), home);
  assert.deepEqual(snapshotDir(f.dataDir), data);
  assert.equal(f.repo.git(['cat-file', '-t', pSha]).trim(), 'commit');
  const out = json(r);
  const next = json(await f.run('preflight', pick));
  assert.equal(next.action, 'ready');
  assert.equal(next.bases.backend.kind, 'combine');
  assert.equal(out.nextApprove, next.approve);
  assert.equal(r.stdout.includes(SENTINEL), false);
});

test('fetch refuses a wrong hash or a plan with no bases-unknown ask with exit 5, a missing --approve with 2, a missing key with 3, and fetches nothing', async () => {
  const { f } = missingHead();
  const plan = json(await f.run('preflight', pick));
  const before = f.git.calls.length;
  const fetches = () => f.git.calls.slice(before).filter(c => subcommandOf(c.argv) === 'fetch').length;
  assert.equal((await f.run('fetch', pick)).code, 2);
  assert.equal((await f.run('fetch', [...pick, '--approve', 'abcdefabcdef'])).code, 5);
  const sent = f.linear.sent.length;
  const keyless = await f.run('fetch', [...pick, '--approve', plan.approve], { keyFile: join(f.scratch, 'absent') });
  assert.equal(keyless.code, 3);
  assert.equal(f.linear.sent.length, sent);
  const ready = json(await f.run('preflight', [...pick, '--unbuilt', P]));
  assert.equal(ready.action, 'ready');
  const none = await f.run('fetch', [...pick, '--unbuilt', P, '--approve', ready.approve]);
  assert.equal(none.code, 5);
  assert.match(none.stderr, /bases-unknown/);
  assert.equal(fetches(), 0);
});

test('completing a respike run tears its trees down and prunes the runs no live record references, keeping the newest two', async () => {
  const f = respikeFixture();
  const stale = ['20261001T100000Z', '20261002T100000Z'];
  for (const id of stale) {
    mkdirSync(join(f.home, SLUG, 'runs', id), { recursive: true });
    writeFileSync(join(f.home, SLUG, 'runs', id, 'run.json'), JSON.stringify({ runId: id, status: 'complete', project: { slug: SLUG }, repos: {} }));
  }
  const plan = json(await f.run('preflight', pick));
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = json(await f.run('begin', [...pick, '--approve', plan.approve]));
  const dir = runDir(f.home, SLUG, runId);
  f.at('2026-11-10T10:02:00.000Z');
  assert.equal(json(await f.spike(['next'])).card, B);
  const tree = json(await f.spike(['tree', 'backend'])).path;
  writeFileSync(join(tree, 'b.txt'), 'b\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${B}.json`), JSON.stringify(notes(B)));
  f.at('2026-11-10T10:03:00.000Z');
  assert.equal((await f.spike(['end', B])).code, 0);
  f.at('2026-11-10T10:04:00.000Z');
  const done = json(await f.spike(['next']));
  assert.equal(done.action, 'complete');
  assert.deepEqual(done.removed.map(r => r.repo), ['backend']);
  assert.equal(existsSync(tree), false);
  assert.deepEqual([...done.pruned].sort(), stale);
  assert.deepEqual(readdirSync(join(f.home, SLUG, 'runs')).sort(), [f.oldRunId, runId]);
});
