import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { run as next } from '../scripts/next.mjs';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, GIT_BRANCH_NAME, SENTINEL, SLUG, snapshot, startFixture, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const fixture = t => {
  const f = startFixture();
  t.after(f.dispose);
  return f;
};

const plan = async (f, argv = ['plan', CARD]) => {
  const r = await f.run(argv);
  assert.equal(r.code, 0, r.stderr);
  return { ...r, out: JSON.parse(r.stdout) };
};

const gitState = f => ({
  status: f.repo.git(['status', '--porcelain']),
  refs: f.repo.git(['for-each-ref', '--format=%(refname) %(objectname)']),
  head: f.repo.git(['rev-parse', 'HEAD']),
});

test('plan <CARD> prints one JSON plan with the card, its Linear branch name and the verbatim branch rule', async t => {
  const f = fixture(t);
  const { out } = await plan(f);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.card.key, CARD);
  assert.equal(out.card.gitBranchName, GIT_BRANCH_NAME);
  assert.deepEqual(
    { name: out.branch.name, rule: out.branch.rule, source: out.branch.source },
    { name: GIT_BRANCH_NAME, rule: 'verbatim', source: 'linear' },
  );
});

test('the Linear reads ask for the branch name under its exposed key', async t => {
  const f = fixture(t);
  await plan(f);
  const queries = f.linear.sent.map(s => s.body.query.replace(/\s+/g, ' '));
  const start = queries.find(q => /^query StartIssue\b/.test(q.trim()));
  const pages = queries.find(q => q.includes('issues(filter:'));
  assert.ok(start, 'no card read was sent');
  assert.ok(pages, 'no issue page was read');
  for (const q of [start, pages]) assert.ok(q.includes('gitBranchName: branchName'), q);
});

test('the brief carries the record and the verdict equals the one the next CLI shows for the same card', async t => {
  const f = fixture(t);
  const { out } = await plan(f);
  const record = startRecord(CARD);
  assert.deepEqual(out.brief.record.decisions, record.decisions);
  assert.equal(out.brief.record.scope.note, record.scope.note);
  const shown = await next([SLUG], { env: {}, fetchImpl: f.linear.fetchImpl, keyFile: f.keyFile, dataDir: f.dataDir, home: f.home, gh: f.gh.run, git: f.git.run, listDir: () => [] });
  assert.equal(shown.code, 0, shown.stderr);
  const card = JSON.parse(shown.stdout).free.find(c => c.key === CARD);
  assert.equal(card.size.verdict, 'SDD');
  assert.equal(out.verdict.value, card.size.verdict);
});

test('with no blockers the base is the configured default branch on the configured remote', async t => {
  const f = fixture(t);
  const { out } = await plan(f);
  assert.equal(out.base.kind, 'default');
  assert.equal(out.base.ref, 'origin/main');
});

test('the base stays the configured default branch when the remote HEAD names another branch', async t => {
  const f = fixture(t);
  f.repo.git(['push', '-q', 'origin', 'main:refs/heads/other']);
  sandboxGit(['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: f.origin.dir });
  f.repo.git(['fetch', '-q', 'origin']);
  f.repo.git(['remote', 'set-head', 'origin', '--auto']);
  assert.equal(f.repo.git(['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim(), 'origin/other');
  const { out } = await plan(f);
  assert.deepEqual([out.base.kind, out.base.ref, out.base.branch], ['default', 'origin/main', 'main']);
});

test('the approve hash is 12 hex characters and identical across two runs on the same state', async t => {
  const f = fixture(t);
  const first = (await plan(f)).out.approve;
  const second = (await plan(f)).out.approve;
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(second, first);
});

test('the plan is read-only: no Linear mutation, home, data dir and repo unchanged, git only in the checkout', async t => {
  const f = fixture(t);
  const before = { home: snapshot(f.home), data: snapshot(f.dataDir), git: gitState(f) };
  await plan(f);
  assert.deepEqual(f.linear.mutations, []);
  for (const s of f.linear.sent) assert.doesNotMatch(s.body.query, /\bmutation\b/i);
  assert.deepEqual({ home: snapshot(f.home), data: snapshot(f.dataDir), git: gitState(f) }, before);
  assert.ok(f.git.calls.length > 0);
  for (const c of f.git.calls) assert.equal(c.cwd, f.repo.dir, c.argv.join(' '));
});

test('the key never reaches the output, and a bare <CARD> is the same as plan <CARD>', async t => {
  const f = fixture(t);
  const explicit = await plan(f);
  const bare = await plan(f, [CARD]);
  for (const r of [explicit, bare]) {
    assert.ok(!r.stdout.includes(SENTINEL));
    assert.ok(!r.stderr.includes(SENTINEL));
  }
  assert.equal(bare.stdout, explicit.stdout);
});

test('no argument, or plan with no card, is a usage error, exit 2', async t => {
  const f = fixture(t);
  for (const argv of [[], ['plan']]) {
    const r = await f.run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /^usage: node scripts\/start\.mjs plan <CARD>/m);
  }
  assert.equal(f.linear.sent.length, 0);
});

test('with no key in the env or the key file it exits 3 before any request', async t => {
  const f = fixture(t);
  writeFileSync(f.keyFile, '');
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no Linear key/);
  assert.equal(f.linear.sent.length, 0);
  assert.equal(r.stdout, '');
});

test('a Linear failure that echoes the key exits 1 with the key redacted', async t => {
  const f = fixture(t);
  const fetchImpl = async (url, init) => { throw new Error(`refused for ${init.headers.authorization}`); };
  const r = await f.run(['plan', CARD], { fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused for \[redacted\]/);
  assert.ok(!r.stdout.includes(SENTINEL));
  assert.ok(!r.stderr.includes(SENTINEL));
});

test('a card Linear does not know exits 1 with a plain message', async t => {
  const f = fixture(t);
  const r = await f.run(['plan', 'ABC-99']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ABC-99 was not found in Linear/);
  assert.equal(r.stdout, '');
});

test('importing the CLI module sends no request', async () => {
  const calls = [];
  const guarded = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); return guarded(...args); };
  try {
    await import(`../scripts/start.mjs?fresh=${Date.now()}`);
  } finally {
    globalThis.fetch = guarded;
  }
  assert.deepEqual(calls, []);
});
