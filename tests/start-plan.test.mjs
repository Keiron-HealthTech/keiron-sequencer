import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { cardReasons } from '../scripts/lib/start/plan.mjs';
import { draftPack, writePack } from '../scripts/lib/packs.mjs';
import { readOnlySubcommands } from './helpers/fake-git.mjs';
import { SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appRepo, CARD, FAKE_CHECKOUT, fakeStartFixture, GIT_BRANCH_NAME, HEAD_SHA, SENTINEL as SENTINEL_KEY, SLUG, snapshot, startIssue, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const blocks = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });
const card = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME });
const started = { name: 'In Progress', type: 'started' };
const blocker = (key, over = {}) => startIssue(key, { state: started, ...blocks(CARD), ...over });

const ghPr = (n, over = {}) => ({
  number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `user/abc-${n}-x`,
  title: `[ABC-${n}] blocker`, url: `https://github.com/acme/app/pull/${n}`, ...over,
});
const merged = (n, over) => ghPr(n, { state: 'MERGED', mergedAt: '2026-11-05T00:00:00Z', ...over });

// Answers `pr list --search <KEY>`, `pr list --head <branch>` and `pr view <n>` from three tables.
const ghFrom = ({ search = {}, head = {}, view = {} } = {}) => argv => {
  const at = flag => argv[argv.indexOf(flag) + 1];
  if (argv[1] === 'view') return JSON.stringify(view[argv[2]] ?? null);
  if (argv.includes('--search')) return JSON.stringify(search[at('--search')] ?? []);
  if (argv.includes('--head')) return JSON.stringify(head[at('--head')] ?? []);
  return '[]';
};

const fixture = (t, { blockers = [], gh, git } = {}) => {
  const f = fakeStartFixture({ issues: [card, ...blockers], gh: gh ? ghFrom(gh) : undefined, git });
  t.after(f.dispose);
  return f;
};
const plan = async (f, flags = []) => {
  const r = await f.run(['plan', CARD, ...flags]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const codes = out => out.reasons.map(r => r.code);
const fetched = (...branches) => ({
  refs: ['refs/heads/main', 'refs/remotes/origin/main', ...branches.map(b => `refs/remotes/origin/${b}`)],
  heads: ['main', ...branches],
});

test('a blocker merged on GitHub leaves the default branch as the base, warning when Linear is still open', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], gh: { search: { 'ABC-2': [merged(2)] } } });
  const out = await plan(f);
  assert.deepEqual([out.action, out.base.kind, out.base.ref], ['create', 'default', 'origin/main']);
  assert.deepEqual(out.blockers.map(b => [b.key, b.source, b.status]), [['ABC-2', 'linear', 'merged']]);
  assert.match(out.blockers[0].warning, /still open in Linear/);
  assert.deepEqual(out.blockers[0].prs.map(p => [p.number, p.via]), [[2, 'search']]);
});

test('one open blocker PR: stack on its head, with the costs', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], gh: { search: { 'ABC-2': [ghPr(2)] } } });
  const out = await plan(f);
  assert.deepEqual([out.action, out.base.kind, out.base.ref, out.base.pr.number], ['create', 'stack', 'origin/user/abc-2-x', 2]);
  assert.equal(out.base.costs.length, 2);
});

test('two independent open blocker PRs: wait, with push-these-reviews, exit 0', async t => {
  const f = fixture(t, {
    blockers: [blocker('ABC-2'), blocker('ABC-3')], gh: { search: { 'ABC-2': [ghPr(2)], 'ABC-3': [ghPr(3)] } },
    git: { ...fetched('user/abc-2-x', 'user/abc-3-x'), revList: '2\n' },
  });
  const out = await plan(f);
  assert.deepEqual([out.action, out.base.kind], ['wait', 'wait']);
  assert.deepEqual(out.base.pushReviews.map(r => r.number), [2, 3]);
  assert.deepEqual(codes(out), ['push-reviews']);
});

test('two blocker PRs chained by their base: stack on the top one', async t => {
  const f = fixture(t, {
    blockers: [blocker('ABC-2'), blocker('ABC-3')],
    gh: { search: { 'ABC-2': [ghPr(2)], 'ABC-3': [ghPr(3, { baseRefName: 'user/abc-2-x' })] } },
  });
  const out = await plan(f);
  assert.deepEqual([out.action, out.base.kind, out.base.ref], ['create', 'stack', 'origin/user/abc-3-x']);
});

test('an unstarted blocker with nothing on GitHub stops the plan, exit 0, naming it', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2', { state: { name: 'Todo', type: 'unstarted' } })] });
  const out = await plan(f);
  assert.deepEqual([out.action, out.base.kind], ['stop', 'stop']);
  assert.deepEqual(codes(out), ['unstarted-blocker']);
  assert.match(out.reasons[0].message, /ABC-2/);
});

test('a blocker Linear shows started or done with nothing on GitHub is an ask', async t => {
  for (const state of [started, { name: 'Done', type: 'completed' }]) {
    const f = fixture(t, { blockers: [blocker('ABC-2', { state })] });
    const out = await plan(f);
    assert.deepEqual([out.action, out.base.kind, codes(out)], ['ask', 'ask', ['unverified-blocker']], state.type);
  }
});

test('--blocker-pr answers the ask with the PR the user names', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], gh: { view: { 2: ghPr(2, { title: 'untagged' }) } } });
  const out = await plan(f, ['--blocker-pr', 'ABC-2=https://github.com/acme/app/pull/2']);
  assert.deepEqual([out.action, out.base.kind, out.base.ref], ['create', 'stack', 'origin/user/abc-2-x']);
  assert.deepEqual(out.blockers[0].prs.map(p => [p.number, p.via]), [[2, 'given']]);
});

test('--blocker-branch answers the ask: its PR stacks, a branch with no PR stacks, an unknown branch still asks', async t => {
  const withPr = fixture(t, {
    blockers: [blocker('ABC-2')], gh: { head: { 'feat/two': [ghPr(2, { headRefName: 'feat/two', title: 'untagged' })] } },
    git: { heads: ['main', 'feat/two'] },
  });
  const stacked = await plan(withPr, ['--blocker-branch', 'ABC-2=feat/two']);
  assert.deepEqual([stacked.action, stacked.base.ref, stacked.blockers[0].prs[0].via], ['create', 'origin/feat/two', 'given-branch']);

  const bare = fixture(t, { blockers: [blocker('ABC-2')], git: { heads: ['main', 'feat/two'] } });
  const onBranch = await plan(bare, ['--blocker-branch', 'ABC-2=feat/two']);
  assert.deepEqual([onBranch.action, onBranch.blockers[0].status, onBranch.blockers[0].branch], ['create', 'branch', { name: 'feat/two', where: 'remote', via: 'given' }]);
  assert.deepEqual([onBranch.base.kind, onBranch.base.ref, onBranch.base.pr], ['stack', 'origin/feat/two', null]);

  const local = fixture(t, { blockers: [blocker('ABC-2')], git: { refs: ['refs/heads/main', 'refs/heads/feat/two', 'refs/remotes/origin/main'] } });
  const onLocal = await plan(local, ['--blocker-branch', 'ABC-2=feat/two']);
  assert.deepEqual([onLocal.action, onLocal.base.kind, onLocal.base.ref], ['create', 'stack', 'refs/heads/feat/two']);
  assert.deepEqual(onLocal.fetch.refs, ['origin/main']);

  const missing = fixture(t, { blockers: [blocker('ABC-2')] });
  const asked = await plan(missing, ['--blocker-branch', 'ABC-2=feat/two']);
  assert.equal(asked.action, 'ask');
  assert.ok(asked.warnings.some(w => /branch feat\/two not found on origin/.test(w)), asked.warnings.join('; '));
});

test('--skip-blocker answers the ask, and the skipped blocker is listed', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')] });
  const out = await plan(f, ['--skip-blocker', 'ABC-2']);
  assert.deepEqual([out.action, out.base.kind], ['create', 'default']);
  assert.deepEqual(out.skippedBlockers, [{ key: 'ABC-2', source: 'linear' }]);
});

test('one branch carrying the blocker id, with no PR, pushed or local, is stacked on; a longer id does not count', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], git: { heads: ['main', 'user/abc-2-wip'] } });
  const out = await plan(f);
  assert.deepEqual([out.action, out.blockers[0].status, out.base.ref], ['create', 'branch', 'origin/user/abc-2-wip']);
  const local = fixture(t, { blockers: [blocker('ABC-2')], git: { refs: ['refs/heads/main', 'refs/heads/user/abc-2-wip', 'refs/remotes/origin/main'] } });
  const onLocal = await plan(local);
  assert.deepEqual([onLocal.action, onLocal.blockers[0].branch, onLocal.base.ref], ['create', { name: 'user/abc-2-wip', where: 'local', via: 'local' }, 'refs/heads/user/abc-2-wip']);
  const longer = fixture(t, { blockers: [blocker('ABC-2')], git: { heads: ['main', 'user/abc-20-x', 'xabc-2-y'] } });
  assert.equal((await plan(longer)).blockers[0].status, 'unverified');
});

test('several branches carrying the blocker id ask which; --blocker-branch picks one', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], git: { heads: ['main', 'user/abc-2-a'], refs: ['refs/heads/main', 'refs/heads/user/abc-2-b', 'refs/remotes/origin/main'] } });
  const out = await plan(f);
  assert.deepEqual([out.action, codes(out), out.blockers[0].branches.map(b => [b.name, b.where])], ['ask', ['unverified-blocker'], [['user/abc-2-a', 'remote'], ['user/abc-2-b', 'local']]]);
  assert.match(out.blockers[0].warning, /several branches/);
  const picked = await plan(f, ['--blocker-branch', 'ABC-2=user/abc-2-b']);
  assert.deepEqual([picked.action, picked.base.ref], ['create', 'refs/heads/user/abc-2-b']);
});

test('a draft blocker PR is stacked on, with the draft cost', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], gh: { search: { 'ABC-2': [ghPr(2, { isDraft: true })] } } });
  const out = await plan(f);
  assert.deepEqual([out.action, out.base.kind, out.base.ref, out.base.pr.number], ['create', 'stack', 'origin/user/abc-2-x', 2]);
  assert.ok(out.base.costs.some(c => /draft/.test(c)), out.base.costs.join('; '));
  assert.match(out.blockers[0].warning, /draft/);
});

test('an off-project blocker is checked like any other; a QA card never blocks', async t => {
  const outside = startIssue('ABC-9', { projectId: 'other-project', state: started, ...blocks(CARD) });
  const qa = blocker('ABC-4', { title: 'QA: check it', labels: { nodes: [{ name: 'QA' }] } });
  const f = fixture(t, { blockers: [outside, qa], gh: { search: { 'ABC-9': [merged(9)] } } });
  const out = await plan(f);
  assert.deepEqual(out.blockers.map(b => [b.key, b.source, b.status]), [['ABC-9', 'off-project', 'merged']]);
});

test('a planner card blocking the card never blocks it', async t => {
  const decision = blocker('ABC-5', { title: 'Decide the export', labels: { nodes: [{ name: 'map' }] } });
  const delivery = blocker('ABC-6', { title: 'Deliver the design', labels: { nodes: [{ name: 'map:design-delivery' }] } });
  const out = await plan(fixture(t, { blockers: [decision, delivery] }));
  assert.deepEqual(out.blockers, []);
  assert.deepEqual([out.action, out.base.kind], ['create', 'default']);
});

test('a gh failure never reads as no PRs: the blocker is unverified and the plan says gh is unavailable', async t => {
  const f = fakeStartFixture({
    issues: [card, blocker('ABC-2', { state: { name: 'Todo', type: 'unstarted' } })],
    gh: argv => (argv.includes('--search') ? { status: 1, stderr: 'HTTP 401' } : '[]'),
  });
  t.after(f.dispose);
  const out = await plan(f);
  assert.deepEqual([out.action, out.blockers[0].status], ['ask', 'unverified']);
  assert.ok(codes(out).includes('gh-unavailable'), codes(out).join(','));
  assert.equal(out.reasons.find(r => r.code === 'gh-unavailable').blocking, false);
});

test('the plan only runs read-only git, never in another directory, and writes nothing to Linear', async t => {
  const f = fixture(t, {
    blockers: [blocker('ABC-2'), blocker('ABC-3')], gh: { search: { 'ABC-2': [ghPr(2)], 'ABC-3': [ghPr(3)] } },
    git: { ...fetched('user/abc-2-x', 'user/abc-3-x'), revList: '1\n' },
  });
  await plan(f, ['--blocker-branch', 'ABC-2=user/abc-2-x']);
  assert.ok(f.git.calls.length > 0);
  for (const c of f.git.calls) {
    assert.ok(readOnlySubcommands.includes(c.sub), c.argv.join(' '));
    assert.equal(c.cwd, '/fake/checkout');
    assert.ok(!c.argv.some(a => /symbolic-ref|\/HEAD$/.test(a)), c.argv.join(' '));
  }
  assert.ok(f.git.calls.some(c => c.sub === 'rev-list'));
  assert.deepEqual(f.linear.mutations, []);
});

const mine = (n, over = {}) => ghPr(n, { headRefName: `user/abc-1-${n}`, title: `[ABC-1] mine ${n}`, ...over });

test('a local branch of the card is a resume, and it wins over a base that would wait', async t => {
  const f = fixture(t, {
    blockers: [blocker('ABC-2')], gh: { search: { 'ABC-2': [merged(2, { baseRefName: 'user/abc-3-y' })] } },
    git: { refs: ['refs/heads/main', `refs/heads/${GIT_BRANCH_NAME}`, 'refs/remotes/origin/main'] },
  });
  const out = await plan(f);
  assert.equal(out.action, 'resume');
  assert.equal(out.base.kind, 'wait');
  assert.deepEqual(out.resume.branches, [{ name: GIT_BRANCH_NAME, where: 'local', path: null }]);
  assert.equal(out.resume.found, true);
});

test('an open PR of the card is a resume naming it; a branch in another worktree is reported with its path', async t => {
  const pr = fixture(t, { gh: { search: { [CARD]: [mine(4, { isDraft: true })] } } });
  const byPr = await plan(pr);
  assert.deepEqual([byPr.action, byPr.resume.prs.map(p => p.number)], ['resume', [4]]);
  const wt = fixture(t, {
    git: { refs: ['refs/heads/main', 'refs/heads/abc-1-wt'], worktrees: [{ path: '/fake/checkout', branch: 'main' }, { path: '/src/wt', branch: 'abc-1-wt' }] },
  });
  const byWorktree = await plan(wt);
  assert.deepEqual([byWorktree.action, byWorktree.resume.branches], ['resume', [{ name: 'abc-1-wt', where: 'worktree', path: '/src/wt' }]]);
});

test('only a merged PR of the card asks before anything is created, ahead of a base that would wait', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], gh: { search: { [CARD]: [mine(9, { state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z' })] } } });
  const out = await plan(f);
  assert.equal(out.action, 'ask');
  assert.deepEqual(codes(out), ['pr-merged', 'unverified-blocker']);
  assert.equal(out.reasons[0].blocking, true);
});

test('a card without a branch name stops, unless it is already started', async t => {
  const none = fakeStartFixture({ issues: [startIssue(CARD)] });
  t.after(none.dispose);
  const stopped = await plan(none);
  assert.deepEqual([stopped.action, codes(stopped)], ['stop', ['no-branch-name']]);
  const resumed = fakeStartFixture({ issues: [startIssue(CARD)], git: { refs: ['refs/heads/main', 'refs/heads/abc-1-x'] } });
  t.after(resumed.dispose);
  assert.equal((await plan(resumed)).action, 'resume');
});

test('a dirty checkout and an unreadable gh only add non-blocking reasons', async t => {
  const f = fakeStartFixture({ issues: [card], git: { status: ' M a.js\n?? b.js\n' }, gh: () => ({ status: 1, stderr: 'HTTP 503' }) });
  t.after(f.dispose);
  const out = await plan(f);
  assert.equal(out.action, 'create');
  assert.deepEqual(out.reasons.map(r => [r.code, r.blocking]), [['gh-unavailable', false], ['dirty-checkout', false]]);
  assert.equal(out.resume.remote, 'unavailable');
});

test('a closed card stops before any GitHub read, even with its branch present', async t => {
  const issue = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, state: { name: 'Done', type: 'completed' } });
  const f = fakeStartFixture({ issues: [issue], git: { refs: ['refs/heads/main', `refs/heads/${GIT_BRANCH_NAME}`] } });
  t.after(f.dispose);
  const out = await plan(f);
  assert.deepEqual([out.action, codes(out), out.resume.found], ['stop', ['card-closed'], false]);
  assert.equal(f.gh.calls.length, 0);
});

test('card-level reasons: archived, completed or canceled is closed; off the execution map is not an execution card', () => {
  const onMap = new Set([CARD]);
  const at = over => cardReasons({ key: CARD, archivedAt: null, state: { name: 'Todo', type: 'unstarted' }, ...over }, onMap).map(r => r.code);
  assert.deepEqual(at({}), []);
  assert.deepEqual(at({ archivedAt: '2026-10-01T00:00:00Z' }), ['card-closed']);
  for (const type of ['completed', 'canceled']) assert.deepEqual(at({ state: { name: type, type } }), ['card-closed'], type);
  assert.deepEqual(cardReasons({ key: 'ABC-9', archivedAt: null, state: { type: 'started' } }, onMap).map(r => r.code), ['not-execution-card']);
});

test('the approve hash moves when a branch of the card appears', async t => {
  const before = await plan(fixture(t));
  const after = await plan(fixture(t, { git: { refs: ['refs/heads/main', 'refs/heads/abc-1-new'] } }));
  assert.notEqual(after.approve, before.approve);
});

const failSearchOf = (...keys) => ({ search, view = {} } = {}) => argv => {
  if (argv.includes('--search') && keys.includes(argv[argv.indexOf('--search') + 1])) return { status: 1, stderr: 'HTTP 502' };
  return ghFrom({ search, view })(argv);
};
const unread = (t, blockers, gh, git) => {
  const f = fakeStartFixture({ issues: [card, ...blockers], gh, git });
  t.after(f.dispose);
  return f;
};
const askNoBase = out => [out.action, out.base.kind, out.base.ref, out.base.branch];

test('a blocker GitHub could not read makes the base an ask, never the default, in every Linear state', async t => {
  for (const state of [{ name: 'Todo', type: 'unstarted' }, started, { name: 'Done', type: 'completed' }]) {
    const out = await plan(unread(t, [blocker('ABC-2', { state })], failSearchOf('ABC-2')()));
    assert.deepEqual(askNoBase(out), ['ask', 'ask', null, null], state.type);
    assert.equal(out.blockers[0].status, 'unverified', state.type);
    assert.deepEqual(out.reasons.map(r => [r.code, r.blocking]), [['unverified-blocker', true], ['gh-unavailable', false]], state.type);
  }
});

test('an unreadable blocker still asks when every other blocker is merged and would give the default', async t => {
  const done = { state: { name: 'Done', type: 'completed' } };
  const out = await plan(unread(t, [blocker('ABC-2'), blocker('ABC-3', done)], failSearchOf('ABC-3')({ search: { 'ABC-2': [merged(2)] } })));
  assert.deepEqual(askNoBase(out), ['ask', 'ask', null, null]);
  assert.deepEqual(out.blockers.map(b => [b.key, b.status]), [['ABC-2', 'merged'], ['ABC-3', 'unverified']]);
  assert.match(out.base.note, /ABC-3/);
  assert.doesNotMatch(out.base.note, /ABC-2/);
});

test('a merged PR the user names does not settle a blocker whose search failed', async t => {
  const f = unread(t, [blocker('ABC-2')], failSearchOf('ABC-2')({ view: { 2: merged(2) } }));
  const out = await plan(f, ['--blocker-pr', 'ABC-2=https://github.com/acme/app/pull/2']);
  assert.deepEqual(askNoBase(out), ['ask', 'ask', null, null]);
  assert.equal(out.blockers[0].status, 'unverified');
  assert.ok(codes(out).includes('gh-unavailable'), codes(out).join(','));
});

const exitsOne = async (f, pattern, flags = []) => {
  const r = await f.run(['plan', CARD, ...flags]);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, pattern);
  return r;
};

const remoteDown = { 'ls-remote': { status: 128, stderr: 'fatal: Could not read from remote repository.' } };
const remoteExit = async (f, pattern, flags) => {
  const r = await exitsOne(f, pattern, flags);
  assert.match(r.stderr, /Could not read from remote repository/);
  assert.ok(!r.stderr.includes(f.key));
};

test('a failed ls-remote of the remote exits 1, naming the remote', async t => {
  await remoteExit(unread(t, [], undefined, remoteDown), /branches could not be read from origin/);
});

test('a failed ls-remote exits 1 even when a blocker branch was given', async t => {
  await remoteExit(unread(t, [blocker('ABC-2')], undefined, remoteDown), /could not be read from origin/, ['--blocker-branch', 'ABC-2=feat/two']);
});

test('a failed ls-remote of a given blocker branch exits 1, naming the branch and the remote', async t => {
  const given = argv => (argv.length === 4 ? { status: 128, stderr: 'fatal: Could not read from remote repository.' } : `${'a'.repeat(40)}\trefs/heads/main\n`);
  const f = unread(t, [blocker('ABC-2')], undefined, { 'ls-remote': given });
  await remoteExit(f, /branch feat\/two could not be read from origin/, ['--blocker-branch', 'ABC-2=feat/two']);
});

test('a gh binary that cannot be run exits 1', async t => {
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  await exitsOne(unread(t, [blocker('ABC-2')], () => ({ error: missing })), /spawn gh ENOENT/);
});

test('a local git read that fails exits 1', async t => {
  for (const sub of ['rev-parse', 'status', 'for-each-ref', 'worktree list']) {
    await exitsOne(unread(t, [], undefined, { [sub]: { status: 128, stderr: `fatal: ${sub} broke` } }), new RegExp(`${sub} broke`));
  }
  const twoOpen = unread(t, [blocker('ABC-2'), blocker('ABC-3')], ghFrom({ search: { 'ABC-2': [ghPr(2)], 'ABC-3': [ghPr(3)] } }), {
    ...fetched('user/abc-2-x', 'user/abc-3-x'), 'rev-list': { status: 128, stderr: 'fatal: bad object' },
  });
  await exitsOne(twoOpen, /bad object/);
});

test('a Linear read that fails while reading a blocker exits 1', async t => {
  const f = unread(t, [blocker('ABC-2')]);
  let reads = 0;
  const fetchImpl = async (url, init) => {
    if (/^\s*query\s+StartIssue\b/.test(JSON.parse(init.body).query) && ++reads === 2) {
      return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
    }
    return f.linear.fetchImpl(url, init);
  };
  const r = await f.run(['plan', CARD], { fetchImpl });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(reads, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Linear HTTP 500/);
});

const PLAN_KEYS = {
  '': ['action', 'approve', 'base', 'blockers', 'brief', 'branch', 'card', 'checkout', 'fetch', 'gates', 'reasons', 'resume', 'route', 'schemaVersion', 'siblings', 'skippedBlockers', 'staleness', 'typecheck', 'verdict', 'warnings'],
  card: ['comments', 'commentsTruncated', 'description', 'gitBranchName', 'id', 'key', 'milestone', 'project', 'repos', 'state', 'title', 'url'],
  checkout: ['branch', 'defaultBranch', 'defaultBranchLocal', 'detached', 'dirty', 'head', 'name', 'notes', 'path', 'remote', 'repoDir'],
  siblings: ['dependents', 'milestone'],
  base: ['branch', 'costs', 'kind', 'note', 'pr', 'pushReviews', 'ref'],
  fetch: ['lastFetch', 'refs', 'remote'],
  branch: ['editable', 'name', 'rule', 'source'],
  resume: ['branches', 'elsewhere', 'found', 'prs', 'remote'],
  verdict: ['label', 'tier', 'value'],
  route: ['changeName', 'reasons', 'route', 'said'],
  brief: ['gates', 'otherRepos', 'pack', 'patches', 'patchesNote', 'record', 'recordNote'],
  staleness: ['anchor', 'baseCommit', 'computed', 'filesFrom', 'groups', 'hunks', 'reason', 'ref', 'since', 'touched', 'unchecked'],
  typecheck: ['commands', 'configured'],
};
const assertKeys = (out, label) => {
  for (const [at, keys] of Object.entries(PLAN_KEYS)) assert.deepEqual(Object.keys(at ? out[at] : out).sort(), [...keys].sort(), `${label}: ${at || 'top level'}`);
};

const TYPECHECK = [['npm', 'run', 'typecheck'], ['npm', 'run', 'lint:types']];
const fullRepos = { app: appRepo(FAKE_CHECKOUT, { typecheck: TYPECHECK, notes: ['a stacked PR gets no preview here'] }) };
const fullIssues = () => [
  startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, projectMilestone: { name: 'M1' }, comments: [{ body: 'later', createdAt: '2026-11-02T00:00:00.000Z' }] }),
  blocker('ABC-2', { state: { name: 'Done', type: 'completed' }, projectMilestone: { name: 'M1' } }),
  startIssue('ABC-5', { title: 'Card ABC-5', projectMilestone: { name: 'M1' }, relations: { nodes: [] } }),
];
const dependsOnCard = issues => issues.map(i => (i.identifier === CARD ? { ...i, relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ABC-5' } }] } } : i));

test('a full fixture gives every key of the plan with its fields, siblings, fetch refs, typecheck and notes', async t => {
  const f = fakeStartFixture({ issues: dependsOnCard(fullIssues()), repos: fullRepos, gh: ghFrom({ search: { 'ABC-2': [merged(2)] } }) });
  t.after(f.dispose);
  const out = await plan(f);
  assertKeys(out, 'full');
  assert.deepEqual([out.action, out.base.kind, out.blockers[0].status], ['create', 'default', 'merged']);
  assert.deepEqual(out.siblings, { dependents: [{ key: 'ABC-5', title: 'Card ABC-5', status: 'Todo' }], milestone: { name: 'M1', open: 2, done: 1 } });
  assert.deepEqual(out.fetch, { remote: 'origin', refs: ['origin/main'], lastFetch: 'unknown' });
  assert.deepEqual(out.typecheck, { configured: true, commands: TYPECHECK });
  assert.deepEqual(out.checkout.notes, ['a stacked PR gets no preview here']);
  assert.ok(out.brief.record);
});

test('a stack plan fetches the stacked branch too', async t => {
  const f = fixture(t, { blockers: [blocker('ABC-2')], gh: { search: { 'ABC-2': [ghPr(2)] } } });
  assert.deepEqual((await plan(f)).fetch.refs, ['origin/main', 'origin/user/abc-2-x']);
});

test('a card with no record, and a stop at the card, are still complete plans', async t => {
  const none = fakeStartFixture({ records: [] });
  t.after(none.dispose);
  const empty = await plan(none);
  assertKeys(empty, 'no record');
  assert.deepEqual([empty.verdict.value, empty.brief.record, empty.siblings.milestone], ['no record', null, null]);
  assert.deepEqual(empty.typecheck, { configured: false, commands: [] });

  const elsewhere = fakeStartFixture({ git: { remotes: 'origin\tgit@github.com:acme/else.git (fetch)\n', commonDir: '/elsewhere/.git' } });
  t.after(elsewhere.dispose);
  const stopped = await plan(elsewhere);
  assertKeys(stopped, 'card stop');
  assert.deepEqual([stopped.action, stopped.reasons[0].code, stopped.base.kind], ['stop', 'repo-unconfigured', null]);
  assert.deepEqual(stopped.fetch, { remote: null, refs: [], lastFetch: 'unknown' });
  assert.deepEqual(stopped.resume, { found: false, branches: [], prs: [], elsewhere: [], remote: null });
});

test('the full plan is read-only: home and data dir byte-identical, no mutation, only read-only git, never a fetch or the remote HEAD', async t => {
  const runId = '20261101T100000Z';
  const record = startRecord(CARD, { refs: { engram: [], patches: ['app-repo/ABC-1.patch'], linear: null, runId } });
  const f = fakeStartFixture({ issues: dependsOnCard(fullIssues()), records: [record], repos: fullRepos, gh: ghFrom({ search: { 'ABC-2': [merged(2)] } }) });
  t.after(f.dispose);
  const dir = join(f.home, SLUG, 'runs', runId);
  mkdirSync(join(dir, 'patches', 'app-repo'), { recursive: true });
  writeFileSync(join(dir, 'patches', 'app-repo', 'ABC-1.patch'), 'diff --git a/src/p.js b/src/p.js\n+x\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ repos: { app: { baseCommit: 'b'.repeat(40) } } }));
  const before = { home: snapshot(f.home), data: snapshot(f.dataDir) };
  const out = await plan(f);
  assert.equal(out.staleness.computed, true);
  assert.deepEqual({ home: snapshot(f.home), data: snapshot(f.dataDir) }, before);
  assert.deepEqual(f.linear.mutations, []);
  for (const s of f.linear.sent) assert.doesNotMatch(s.body.query, /\bmutation\b/i);
  for (const c of f.git.calls) {
    assert.ok(readOnlySubcommands.includes(c.sub), c.argv.join(' '));
    assert.ok(!c.argv.some(a => /symbolic-ref|origin\/HEAD|^fetch$/.test(a)), c.argv.join(' '));
  }
  assert.deepEqual([...new Set(f.git.calls.map(c => c.sub))].sort(), ['for-each-ref', 'log', 'ls-remote', 'remote', 'rev-list', 'rev-parse', 'status', 'worktree list']);
});

const linearNotFound = f => async (url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (/^\s*query\s+StartIssue\b/.test(query) && variables.id === 'ABC-404') {
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ errors: [{ message: 'Entity not found: Issue' }] }) };
  }
  return f.linear.fetchImpl(url, init);
};

test('a card or a given blocker Linear answers "Entity not found" for exits 1 saying it was not found', async t => {
  const f = unread(t, []);
  const fetchImpl = linearNotFound(f);
  for (const argv of [['plan', 'ABC-404'], ['plan', CARD, '--blocker', 'ABC-404']]) {
    const r = await f.run(argv, { fetchImpl });
    assert.equal(r.code, 1, argv.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^ABC-404 was not found in Linear$/m, argv.join(' '));
  }
});

test('a missing, unreadable or invalid config file is exit 2 naming the file, before any Linear request', async t => {
  for (const [label, write, pattern] of [
    ['missing', home => rmSync(join(home, 'config.json')), /cannot read the spike config .*config\.json: ENOENT/],
    ['not JSON', home => writeFileSync(join(home, 'config.json'), '{ nope'), /cannot read the spike config .*config\.json/],
    ['invalid', home => writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, repos: 'x' })), /invalid spike config .*config\.json/],
  ]) {
    const f = unread(t, []);
    write(f.home);
    const r = await f.run(['plan', CARD]);
    assert.equal(r.code, 2, `${label}: ${r.stderr}`);
    assert.match(r.stderr, pattern, label);
    assert.equal(r.stdout, '');
    assert.equal(f.linear.sent.length, 0, label);
  }
});

test('a directory that is not a git checkout is a repo-unconfigured stop, exit 0, read with real git', async t => {
  const outside = tempDir('keiron-sequencer-start-not-git-');
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const f = unread(t, []);
  const git = gitRunner({ env: SANDBOX_ENV });
  const r = await f.run(['plan', CARD], { cwd: outside, git });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.action, out.reasons.map(x => x.code), out.base.kind], ['stop', ['repo-unconfigured'], null]);
  assert.match(out.reasons[0].message, /is not a git checkout, so it is no repo of the keiron-sequencer config/);
  assert.deepEqual([out.checkout.path, out.checkout.repoDir, out.checkout.head], [outside, null, null]);
  assert.equal(f.gh.calls.length, 0);
});

test('a rev-parse failure other than "not a git repository" still exits 1', async t => {
  await exitsOne(unread(t, [], undefined, { 'rev-parse': { status: 128, stderr: 'fatal: unsafe repository' } }), /unsafe repository/);
});

test('every error path redacts the key: git, ls-remote, gh spawn, Linear and config errors', async t => {
  const echo = `echo ${SENTINEL_KEY}`;
  const cases = [
    ['git', unread(t, [], undefined, { status: { status: 128, stderr: `fatal: ${echo}` } }), 1],
    ['ls-remote', unread(t, [], undefined, { 'ls-remote': { status: 128, stderr: `fatal: ${echo}` } }), 1],
    ['gh spawn', unread(t, [blocker('ABC-2')], () => ({ error: new Error(`spawn gh ${echo}`) })), 1],
  ];
  for (const [label, f, code] of cases) {
    const r = await f.run(['plan', CARD]);
    assert.equal(r.code, code, `${label}: ${r.stderr}`);
    assert.ok(r.stderr.includes('[redacted]'), `${label}: ${r.stderr}`);
    assert.ok(!r.stderr.includes(SENTINEL_KEY) && !r.stdout.includes(SENTINEL_KEY), label);
  }
  const linear = unread(t, []);
  const failing = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ errors: [{ message: `bad ${SENTINEL_KEY}` }] }) });
  const r = await linear.run(['plan', CARD], { fetchImpl: failing });
  assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes(SENTINEL_KEY) && r.stderr.includes('[redacted]'), r.stderr);
  const config = unread(t, []);
  writeFileSync(join(config.home, 'config.json'), JSON.stringify({ schemaVersion: 1, repos: { [SENTINEL_KEY]: 'x' } }));
  const c = await config.run(['plan', CARD]);
  assert.equal(c.code, 2, c.stderr);
  assert.ok(!c.stderr.includes(SENTINEL_KEY), c.stderr);
});

test('a gh non-zero status is not an exit: the plan completes with gh-unavailable, and the blocker asks', async t => {
  const f = unread(t, [blocker('ABC-2')], () => ({ status: 4, stderr: 'gh auth required' }));
  const out = await plan(f);
  assert.deepEqual([out.action, out.blockers[0].status], ['ask', 'unverified']);
  assert.deepEqual(out.reasons.map(r => [r.code, r.blocking]), [['unverified-blocker', true], ['gh-unavailable', false]]);
});

test('wrong-repo and repo-unconfigured are exit-0 stops that create nothing', async t => {
  const other = fakeStartFixture({ records: [startRecord(CARD, { size: { ...startRecord(CARD).size, repos: ['web-repo'] } })],
    repos: { app: appRepo(FAKE_CHECKOUT), web: appRepo('/fake/web', { name: 'web-repo', github: 'acme/web' }) } });
  t.after(other.dispose);
  const unconfigured = fakeStartFixture({ git: { remotes: 'origin\tgit@github.com:acme/else.git (fetch)\n', commonDir: '/elsewhere/.git' } });
  t.after(unconfigured.dispose);
  for (const [f, code] of [[other, 'wrong-repo'], [unconfigured, 'repo-unconfigured']]) {
    const out = await plan(f);
    assert.deepEqual([out.action, out.reasons[0].code, out.reasons[0].blocking], ['stop', code, true]);
  }
});

test('records left in the repo data dir, with none in the home, are a warning naming the move', async t => {
  const f = fakeStartFixture({ issues: [card], records: [] });
  t.after(f.dispose);
  const repoData = tempDir('keiron-sequencer-start-repo-data-');
  t.after(() => rmSync(repoData, { recursive: true, force: true }));
  mkdirSync(join(repoData, SLUG));
  writeFileSync(join(repoData, SLUG, `${CARD}.json`), '{}');
  const r = await f.run(['plan', CARD], { repoDataDir: repoData });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.warnings.some(w => /move-data\.mjs/.test(w) && w.includes(join(repoData, SLUG))), JSON.stringify(out.warnings));
});

test('the start brief carries answered outcomes', async t => {
  const f = fakeStartFixture({ issues: [card], records: [startRecord(CARD, { openDecisions: [{ text: 'Who may see it.', impact: 'design', owner: 'people' }, { text: 'Which retention.', impact: 'design', owner: 'people' }] })] });
  const none = JSON.parse((await f.run(['plan', CARD])).stdout);
  assert.equal(none.brief.pack, null);
  const pack = draftPack(startRecord(CARD, { openDecisions: [{ text: 'Who may see it.', impact: 'design', owner: 'people' }, { text: 'Which retention.', impact: 'design', owner: 'people' }] }), { description: card.description }, { app: HEAD_SHA });
  pack.questions[0].answer = { outcome: 'No customer record reaches a user without a grant.', answeredAt: '2026-11-12T10:00:00.000Z' };
  writePack(f.dataDir, SLUG, pack);
  t.after(f.dispose);
  const out = JSON.parse((await f.run(['plan', CARD])).stdout);
  assert.deepEqual(out.brief.pack, {
    fresh: true, stale: null,
    answered: [{ text: 'Who may see it.', outcome: 'No customer record reaches a user without a grant.' }],
    open: [{ id: 'q2', text: 'Which retention.', evidence: [], options: [] }],
  });
  assert.ok(out.route.reasons.includes('pack-answered:1') && out.route.reasons.includes('people-decisions:1'), out.route.reasons.join(', '));
  writePack(f.dataDir, SLUG, { ...pack, stamp: { ...pack.stamp, bases: { app: 'b'.repeat(40) } } });
  assert.equal(JSON.parse((await f.run(['plan', CARD])).stdout).brief.pack.stale, 'base');
});

// A card with no Linear project: no map, record, pack or staleness, but the parts that apply to any card still run.
const loose = (over = {}) => startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, projectId: null, ...over });
const projectReads = f => f.linear.sent.filter(s => s.body.query.includes('project(id:') || s.body.query.includes('issues(filter:'));

test('a card with no project plans in no-project mode: default base, Linear branch name, no project read', async t => {
  const f = fakeStartFixture({ issues: [loose()] });
  t.after(f.dispose);
  const out = await plan(f);
  assertKeys(out, 'no project');
  assert.deepEqual(projectReads(f), []);
  assert.deepEqual([out.action, out.base.kind, out.base.ref], ['create', 'default', 'origin/main']);
  assert.deepEqual(out.reasons.map(r => [r.code, r.blocking]), [['no-project', false]]);
  assert.match(out.reasons[0].message, /no Linear project/);
  assert.deepEqual([out.branch.name, out.branch.source], [GIT_BRANCH_NAME, 'linear']);
  assert.equal(out.card.project, null);
  assert.deepEqual([out.brief.record, out.brief.pack, out.brief.recordNote], [null, null, 'no record: the card has no Linear project']);
  assert.deepEqual([out.verdict.value, out.route.route, out.route.said], ['no project', null, 'no project']);
  assert.deepEqual([out.staleness.computed, out.staleness.reason], [false, 'no project']);
  assert.deepEqual(out.siblings, { dependents: [], milestone: null });
  assert.ok(out.warnings.some(w => /--blocker/.test(w)), JSON.stringify(out.warnings));
});

test('a no-project card still resumes its started branch, takes --blocker, and stops when closed or in another repo', async t => {
  const resumed = fakeStartFixture({ issues: [loose()], git: { refs: ['refs/heads/main', `refs/heads/${GIT_BRANCH_NAME}`, 'refs/remotes/origin/main'] } });
  t.after(resumed.dispose);
  const r = await plan(resumed);
  assert.deepEqual([r.action, r.resume.branches], ['resume', [{ name: GIT_BRANCH_NAME, where: 'local', path: null }]]);

  const stacked = fakeStartFixture({ issues: [loose(), blocker('ABC-2', { projectId: null, relations: { nodes: [] } })], gh: ghFrom({ search: { 'ABC-2': [ghPr(2)] } }) });
  t.after(stacked.dispose);
  const s = await plan(stacked, ['--blocker', 'ABC-2']);
  assert.deepEqual([s.action, s.base.kind, s.base.ref, s.blockers.map(b => [b.key, b.source])], ['create', 'stack', 'origin/user/abc-2-x', [['ABC-2', 'given']]]);

  const closed = fakeStartFixture({ issues: [loose({ state: { name: 'Done', type: 'completed' } })] });
  t.after(closed.dispose);
  assert.deepEqual(codes(await plan(closed)), ['card-closed', 'no-project']);

  const other = fakeStartFixture({ issues: [loose({ title: 'web-repo: Card ABC-1' })],
    repos: { app: appRepo(FAKE_CHECKOUT), web: appRepo('/fake/web', { name: 'web-repo', github: 'acme/web' }) } });
  t.after(other.dispose);
  const w = await plan(other);
  assert.deepEqual([w.action, codes(w)], ['stop', ['wrong-repo', 'no-project']]);
});

test('a no-project card never reads the spike records or a pack, even with a record of the same key on disk', async t => {
  const f = fakeStartFixture({ issues: [loose()], records: [startRecord(CARD)] });
  t.after(f.dispose);
  writePack(f.dataDir, SLUG, draftPack(startRecord(CARD, { openDecisions: [{ text: 'Who may see it.', impact: 'design', owner: 'people' }] }), { description: loose().description }, {}));
  const out = await plan(f);
  assert.deepEqual([out.brief.record, out.brief.pack, out.verdict.value], [null, null, 'no project']);
});
