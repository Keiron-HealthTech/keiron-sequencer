import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, FAKE_CHECKOUT, fakeStartFixture, GIT_BRANCH_NAME, HEAD_SHA, SENTINEL, startIssue } from './helpers/start-fixture.mjs';

guardNetwork();

const card = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME });
const fixture = (t, opts = {}) => {
  const f = fakeStartFixture({ issues: [card, ...(opts.extra ?? [])], ...opts, git: { fetch: '', ...opts.git } });
  t.after(f.dispose);
  return f;
};
const approve = async f => {
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).approve;
};
const fetches = f => f.git.calls.filter(c => c.sub === 'fetch');

test('fetch with the approved hash runs exactly one quiet fetch of the configured remote in the checkout', async t => {
  const f = fixture(t);
  const hash = await approve(f);
  const r = await f.run(['fetch', CARD, '--approve', hash]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetches(f).map(c => [c.argv, c.cwd]), [[['fetch', '--quiet', 'origin'], FAKE_CHECKOUT]]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.action, out.remote], ['fetched', 'origin']);
});

test('fetch without --approve is a usage error before any git call or Linear request', async t => {
  const f = fixture(t);
  const r = await f.run(['fetch', CARD]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: node scripts\/start\.mjs fetch <CARD> --approve <hash>/);
  assert.deepEqual([f.git.calls.length, f.gh.calls.length, f.linear.sent.length], [0, 0, 0]);
});

test('fetch with a hash that no longer matches is refused, exit 5, and nothing is fetched', async t => {
  const f = fixture(t);
  const hash = await approve(f);
  const r = await f.run(['fetch', CARD, '--approve', 'f'.repeat(12)]);
  assert.equal(r.code, 5);
  assert.ok(r.stderr.includes(hash), r.stderr);
  assert.equal(fetches(f).length, 0);
});

test('fetch with no Linear key exits 3 before any request or git call', async t => {
  const f = fixture(t);
  writeFileSync(f.keyFile, '');
  const r = await f.run(['fetch', CARD, '--approve', 'a'.repeat(12)]);
  assert.equal(r.code, 3);
  assert.deepEqual([f.git.calls.length, f.linear.sent.length], [0, 0]);
});

test('nextApprove is the hash of the plan recomputed after the fetch: unchanged when the fetch changes nothing', async t => {
  const f = fixture(t);
  const hash = await approve(f);
  const out = JSON.parse((await f.run(['fetch', CARD, '--approve', hash])).stdout);
  assert.equal(out.nextApprove, hash);
});

const blocks = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });
const started = { name: 'In Progress', type: 'started' };
const pr = n => ({
  number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `user/abc-${n}-x`,
  title: `[ABC-${n}] blocker`, url: `https://github.com/acme/app/pull/${n}`,
});

test('a fetch that lets the plan decide a chain changes nextApprove, and the new hash matches a fresh plan', async t => {
  let fetched = false;
  const heads = ['main', 'user/abc-2-x', 'user/abc-3-x'];
  const tracked = () => ['refs/heads/main', 'refs/remotes/origin/main', ...(fetched ? heads.slice(1).map(h => `refs/remotes/origin/${h}`) : [])]
    .map(r => `${HEAD_SHA} ${r}\n`).join('');
  const f = fixture(t, {
    extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) }), startIssue('ABC-3', { state: started, ...blocks(CARD) })],
    gh: argv => (argv.includes('--search') ? JSON.stringify({ 'ABC-2': [pr(2)], 'ABC-3': [pr(3)] }[argv[argv.indexOf('--search') + 1]] ?? []) : '[]'),
    git: { heads, 'for-each-ref': tracked, fetch: () => { fetched = true; return ''; } },
  });
  const before = JSON.parse((await f.run(['plan', CARD])).stdout);
  assert.deepEqual([before.action, before.base.kind], ['wait', 'wait']);
  assert.match(before.base.note, /fetch to decide/);
  const r = await f.run(['fetch', CARD, '--approve', before.approve]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.nextApprove, before.approve);
  const after = JSON.parse((await f.run(['plan', CARD])).stdout);
  assert.deepEqual([after.action, after.base.kind, out.nextApprove], ['create', 'stack', after.approve]);
});

test('a fetch that git refuses exits 1 with git\'s message, the key redacted', async t => {
  const f = fixture(t, { git: { fetch: { status: 128, stderr: `fatal: could not read from remote (${SENTINEL})` } } });
  const hash = await approve(f);
  const r = await f.run(['fetch', CARD, '--approve', hash]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fetch failed/);
  assert.ok(!r.stderr.includes(SENTINEL));
});

test('a plan whose checkout has no configured remote is refused, exit 5, with nothing fetched', async t => {
  const f = fixture(t, { git: { remote: 'origin\tgit@github.com:other/repo.git (fetch)\n', commonDir: '/elsewhere/.git' } });
  const hash = await approve(f);
  const r = await f.run(['fetch', CARD, '--approve', hash]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /no remote/);
  assert.equal(fetches(f).length, 0);
});

test('the Linear client is the global fetch unless one is injected; no subcommand handler shadows it', async t => {
  const f = fixture(t);
  const r = await f.run(['plan', CARD], { fetchImpl: undefined });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /network disabled in tests/);
});

test('the gated commands recompute with the blocker flags given: the hash of a plan with --skip-blocker needs the same flag', async t => {
  const f = fixture(t, { extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })] });
  const skipped = JSON.parse((await f.run(['plan', CARD, '--skip-blocker', 'ABC-2'])).stdout);
  assert.equal(skipped.action, 'create');
  assert.equal((await f.run(['fetch', CARD, '--approve', skipped.approve])).code, 5);
  const r = await f.run(['fetch', CARD, '--approve', skipped.approve, '--skip-blocker', 'ABC-2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).nextApprove, skipped.approve);
  assert.equal(fetches(f).length, 1);
});

test('branch and baseline with no Linear key exit 3 before any request, git call or setup command', async t => {
  const f = fixture(t);
  writeFileSync(f.keyFile, '');
  let setups = 0;
  for (const sub of ['branch', 'baseline']) {
    const r = await f.run([sub, CARD, '--approve', 'a'.repeat(12)], { runSetup: () => { setups++; } });
    assert.equal(r.code, 3, sub);
  }
  assert.deepEqual([f.git.calls.length, f.linear.sent.length, setups], [0, 0, 0]);
});
