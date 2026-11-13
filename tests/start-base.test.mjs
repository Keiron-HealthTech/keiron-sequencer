import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainTop, classifyBlocker, decideBase } from '../scripts/lib/start/base.mjs';
import { refContains } from '../scripts/lib/start/checkout.mjs';
import { fakeGit } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const DEFAULTS = { app: 'main', web: 'trunk', loose: null };
const ctx = { currentRepoDir: 'app', defaultBranchOf: dir => DEFAULTS[dir] ?? null };

const pr = (over = {}) => ({
  repoDir: 'app', github: 'acme/app', number: 10, state: 'OPEN', isDraft: false, mergedAt: null,
  baseRefName: 'main', headRefName: 'user/abc-2-x', title: '[ABC-2] x', url: 'https://github.com/acme/app/pull/10', via: 'search', ...over,
});
const merged = over => pr({ state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z', ...over });
const closed = over => pr({ state: 'CLOSED', ...over });
const blocker = (over = {}) => ({
  key: 'ABC-2', title: 'Card ABC-2', source: 'linear', linearState: { name: 'In Progress', type: 'started' },
  prs: [], branches: [], ...over,
});
const status = (b, c = ctx) => classifyBlocker(blocker(b), c).status;

test('a blocker whose GitHub read failed is unverified whatever PRs were found, so it never gives the default base', () => {
  for (const prs of [[merged()], [pr()], [pr({ isDraft: true })], []]) {
    const out = classifyBlocker(blocker({ prs, lookupFailed: 'gh pr list --repo acme/app failed (1): HTTP 502' }), ctx);
    assert.deepEqual([out.status, out.pr], ['unverified', null], JSON.stringify(prs));
    assert.match(out.warning, /HTTP 502/);
  }
});

test('merged into the default branch is satisfied; a Linear card still open gets a warning', () => {
  const open = classifyBlocker(blocker({ prs: [merged()] }), ctx);
  assert.equal(open.status, 'merged');
  assert.match(open.warning, /merged, still open in Linear/);
  const done = classifyBlocker(blocker({ prs: [merged()], linearState: { name: 'Done', type: 'completed' } }), ctx);
  assert.deepEqual([done.status, done.warning], ['merged', null]);
});

test('Linear Done with no merged PR is not treated as merged', () => {
  assert.equal(status({ linearState: { name: 'Done', type: 'completed' } }), 'unverified');
  assert.equal(status({ linearState: { name: 'Done', type: 'completed' }, prs: [closed()] }), 'unverified');
});

test('no PR and no pushed branch: unstarted when Linear says so, otherwise unverified', () => {
  for (const type of ['backlog', 'unstarted', 'triage']) assert.equal(status({ linearState: { name: 'x', type } }), 'unstarted', type);
  assert.equal(status({ linearState: { name: 'In Progress', type: 'started' } }), 'unverified');
  assert.equal(status({ linearState: { name: null, type: null } }), 'unverified');
});

test('an open PR in the current repo is open, draft or not; in another repo it cannot be stacked on', () => {
  assert.equal(status({ prs: [pr()] }), 'open');
  const draft = classifyBlocker(blocker({ prs: [pr({ isDraft: true })] }), ctx);
  assert.deepEqual([draft.status, draft.pr.number], ['open', 10]);
  assert.match(draft.warning, /draft/);
  assert.equal(status({ prs: [pr({ isDraft: true, repoDir: 'web', github: 'acme/web' })] }), 'open-other-repo');
  assert.equal(status({ prs: [pr({ repoDir: 'web', github: 'acme/web' })] }), 'open-other-repo');
  assert.equal(status({ prs: [pr({ repoDir: null, github: 'other/x' })] }), 'open-other-repo');
});

test('a branch merged elsewhere is not a usable base', () => {
  assert.equal(status({ prs: [merged({ baseRefName: 'user/abc-3-y' })] }), 'merged-into-branch');
});

const pushedBranch = (name, via = 'ls-remote') => ({ name, where: 'remote', via });
const localBranch = (name, via = 'local') => ({ name, where: 'local', via });

test('one branch with no PR, pushed or only local, is the blocker\'s base, even when Linear says unstarted', () => {
  for (const found of [pushedBranch('user/abc-2-x'), localBranch('user/abc-2-x')]) {
    const out = classifyBlocker(blocker({ branches: [found] }), ctx);
    assert.deepEqual([out.status, out.branch, out.pr], ['branch', found, null], found.where);
    assert.match(out.warning, /no PR: branch user\/abc-2-x/);
  }
  assert.equal(status({ branches: [localBranch('user/abc-2-x')], linearState: { name: 'Todo', type: 'unstarted' } }), 'branch');
  assert.equal(status({ branches: [pushedBranch('user/abc-2-x')], prs: [pr({ isDraft: true })] }), 'open');
});

test('a blocker Linear closed, with no merged PR, does not stack on a found branch, only on a named one', () => {
  for (const state of [{ name: 'Done', type: 'completed' }, { name: 'Canceled', type: 'canceled' }]) {
    const found = classifyBlocker(blocker({ linearState: state, branches: [pushedBranch('user/abc-2-x')] }), ctx);
    assert.deepEqual([found.status, found.branch], ['unverified', null], state.type);
    assert.match(found.warning, /user\/abc-2-x.*--blocker-branch/);
    assert.equal(status({ linearState: state, branches: [localBranch('user/abc-2-x', 'given')] }), 'branch', state.type);
  }
});

test('several branches with no PR are the user\'s pick, unless one was named with --blocker-branch', () => {
  const two = [pushedBranch('user/abc-2-a'), localBranch('user/abc-2-b')];
  const asked = classifyBlocker(blocker({ branches: two }), ctx);
  assert.deepEqual([asked.status, asked.branch], ['unverified', null]);
  assert.match(asked.warning, /user\/abc-2-a, user\/abc-2-b.*--blocker-branch/);
  const named = classifyBlocker(blocker({ branches: [localBranch('user/abc-2-b', 'given'), pushedBranch('user/abc-2-a')] }), ctx);
  assert.deepEqual([named.status, named.branch.name], ['branch', 'user/abc-2-b']);
});

test('the default branch is the PR repo\'s own; an unconfigured repo accepts any base, with a warning', () => {
  assert.equal(status({ prs: [merged({ repoDir: 'web', baseRefName: 'trunk' })] }), 'merged');
  assert.equal(status({ prs: [merged({ repoDir: 'web', baseRefName: 'main' })] }), 'merged-into-branch');
  const loose = classifyBlocker(blocker({ prs: [merged({ repoDir: null, github: 'other/x', baseRefName: 'release' })] }), ctx);
  assert.equal(loose.status, 'merged');
  assert.match(loose.warning, /not configured/);
});

test('with several PRs: merged-to-default wins, then open non-draft, then draft; closed-unmerged is ignored', () => {
  assert.equal(status({ prs: [pr({ number: 1 }), merged({ number: 2 }), pr({ number: 3, isDraft: true })] }), 'merged');
  assert.equal(classifyBlocker(blocker({ prs: [closed({ number: 1 }), pr({ number: 2, isDraft: true }), pr({ number: 3 })] }), ctx).pr.number, 3);
  assert.equal(classifyBlocker(blocker({ prs: [closed({ number: 1 }), pr({ number: 2, isDraft: true })] }), ctx).pr.number, 2);
  assert.equal(status({ prs: [merged({ number: 1, baseRefName: 'other' }), pr({ number: 2 })] }), 'open');
  assert.equal(classifyBlocker(blocker({ prs: [closed({ number: 1 }), pr({ number: 3 })] }), ctx).pr.number, 3);
});

test('PR state is read case-insensitively, and mergedAt alone marks a merge', () => {
  assert.equal(status({ prs: [pr({ state: 'open' })] }), 'open');
  assert.equal(status({ prs: [pr({ state: 'closed', mergedAt: '2026-11-01T00:00:00Z' })] }), 'merged');
});

test('a skipped blocker is only listed', () => {
  assert.equal(status({ skipped: true, prs: [pr()] }), 'skipped');
});

const classified = (status, prOver, key = 'ABC-2', branch = null) => ({ key, title: `Card ${key}`, status, pr: prOver ? pr(prOver) : null, warning: null, branch });
const noChain = () => assert.fail('the chain is only read with two or more open PRs');
const decide = (blockers, chainOf = noChain) => decideBase(blockers, { remote: 'origin', defaultBranch: 'main', chainOf });

test('no blockers, merged or skipped ones: the configured default branch on the configured remote', () => {
  for (const blockers of [[], [classified('merged', {})], [classified('skipped')]]) {
    const base = decide(blockers);
    assert.deepEqual([base.kind, base.ref, base.branch, base.pr], ['default', 'origin/main', 'main', null]);
    assert.deepEqual(base.costs, []);
  }
});

test('one open PR: stack on its head, with the PR and the generic stack costs', () => {
  const base = decide([classified('merged', {}, 'ABC-3'), classified('open', { headRefName: 'user/abc-2-x', number: 10 })]);
  assert.equal(base.kind, 'stack');
  assert.equal(base.ref, 'origin/user/abc-2-x');
  assert.equal(base.branch, 'user/abc-2-x');
  assert.deepEqual(base.pr, { number: 10, url: 'https://github.com/acme/app/pull/10' });
  assert.equal(base.costs.length, 2);
  assert.ok(base.costs.some(c => /preview/.test(c)) && base.costs.some(c => /retarget/.test(c) && /rebase/.test(c)), base.costs.join('; '));
});

test('precedence: stop over wait over ask over open PRs', () => {
  const open = classified('open', {}, 'ABC-5');
  const ask = classified('unverified', null, 'ABC-4');
  const wait = classified('open-other-repo', { repoDir: 'web' }, 'ABC-3');
  const stop = classified('unstarted', null, 'ABC-2');
  assert.equal(decide([open, ask, wait, stop]).kind, 'stop');
  assert.equal(decide([open, ask, wait]).kind, 'wait');
  assert.equal(decide([open, ask]).kind, 'ask');
  for (const s of ['merged-into-branch', 'open-other-repo']) assert.equal(decide([classified(s, {})]).kind, 'wait', s);
  for (const kind of ['stop', 'wait', 'ask']) {
    const base = decide({ stop: [stop], wait: [wait], ask: [ask] }[kind]);
    assert.deepEqual([base.ref, base.branch, base.pr], [null, null, null], kind);
  }
});

test('a draft PR stacks like an open one, with the draft cost added', () => {
  const base = decide([classified('open', { isDraft: true, number: 11, headRefName: 'user/abc-2-d' })]);
  assert.deepEqual([base.kind, base.ref, base.pr.number], ['stack', 'origin/user/abc-2-d', 11]);
  assert.equal(base.costs.length, 3);
  assert.match(base.costs[2], /draft/);
});

test('a branch with no PR stacks on the pushed head or on the local branch, with no PR and its own costs', () => {
  const pushed = decide([classified('branch', null, 'ABC-2', pushedBranch('user/abc-2-x'))]);
  assert.deepEqual([pushed.kind, pushed.ref, pushed.branch, pushed.pr], ['stack', 'origin/user/abc-2-x', 'user/abc-2-x', null]);
  assert.ok(pushed.costs.some(c => /no PR yet/.test(c)) && !pushed.costs.some(c => /retarget/.test(c)), pushed.costs.join('; '));
  const local = decide([classified('branch', null, 'ABC-2', localBranch('user/abc-2-x'))]);
  assert.deepEqual([local.kind, local.ref, local.branch, local.pr], ['stack', 'refs/heads/user/abc-2-x', 'user/abc-2-x', null]);
  assert.ok(local.costs.some(c => /push it/.test(c)), local.costs.join('; '));
});

test('an open PR and a branch blocker: the chain decides, and a diverged pair lists the branch beside the PR', () => {
  const both = [classified('open', { number: 1, headRefName: 'user/abc-2-a' }, 'ABC-2'), classified('branch', null, 'ABC-3', localBranch('user/abc-3-b'))];
  const stacked = decide(both, prs => chainTop(prs, (top, other) => top.headRefName === 'user/abc-3-b' && other.number === 1));
  assert.deepEqual([stacked.kind, stacked.ref, stacked.pr], ['stack', 'refs/heads/user/abc-3-b', null]);
  const diverged = decide(both, prs => chainTop(prs, () => false));
  assert.deepEqual(diverged.pushReviews.map(r => r.number ?? r.branch), [1, 'user/abc-3-b']);
});

test('the stop names the unstarted blocker and the possible inversion; the ask names the unverified one', () => {
  assert.match(decide([classified('unstarted')]).note, /ABC-2.*(order|invert)/);
  assert.match(decide([classified('unverified')]).note, /ABC-2/);
});

const a = { number: 1, headRefName: 'user/abc-2-a', baseRefName: 'main', title: '[ABC-2] a', url: 'u/1' };
const b = { number: 2, headRefName: 'user/abc-3-b', baseRefName: 'user/abc-2-a', title: '[ABC-3] b', url: 'u/2' };
const two = (pa, pb) => [classified('open', pa, 'ABC-2'), classified('open', pb, 'ABC-3')];

test('two open PRs chained by their base links: stack on the top one, without reading git', () => {
  const base = decide(two(a, b), prs => chainTop(prs, () => assert.fail('links settle it')));
  assert.deepEqual([base.kind, base.ref, base.pr.number], ['stack', 'origin/user/abc-3-b', 2]);
});

test('two open PRs the links do not settle: containment decides, else wait with push-these-reviews', () => {
  const unlinked = { ...b, baseRefName: 'main' };
  const contained = decide(two(a, unlinked), prs => chainTop(prs, (top, other) => top.number === 2 && other.number === 1));
  assert.deepEqual([contained.kind, contained.pr.number], ['stack', 2]);
  const diverged = decide(two(a, unlinked), prs => chainTop(prs, () => false));
  assert.equal(diverged.kind, 'wait');
  assert.deepEqual(diverged.pushReviews.map(r => r.number), [1, 2]);
  assert.deepEqual(Object.keys(diverged.pushReviews[0]).sort(), ['number', 'repoDir', 'title', 'url']);
});

test('containment that cannot be read is wait, fetch to decide', () => {
  const base = decide(two(a, { ...b, baseRefName: 'main' }), prs => chainTop(prs, () => null));
  assert.equal(base.kind, 'wait');
  assert.match(base.note, /fetch to decide/);
});

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const contains = (table, { tracking, heads }) => {
  const git = fakeGit(table);
  return { git, contains: refContains(git.run, { cwd: '/fake/checkout', remote: 'origin', tracking, heads }) };
};

test('refContains counts commits of the other head missing from the top head, in the checkout', () => {
  const both = { tracking: { 'user/abc-2-a': SHA, 'user/abc-3-b': SHA }, heads: { 'user/abc-2-a': SHA, 'user/abc-3-b': SHA } };
  const yes = contains({ 'rev-list': '0\n' }, both);
  assert.equal(yes.contains(b, a), true);
  assert.deepEqual(yes.git.calls.map(c => [c.argv, c.cwd]), [[['rev-list', '--count', 'origin/user/abc-3-b..origin/user/abc-2-a'], '/fake/checkout']]);
  assert.equal(contains({ 'rev-list': '3\n' }, both).contains(b, a), false);
});

test('refContains cannot decide when a head is not fetched or is stale against ls-remote', () => {
  const missing = contains({ 'rev-list': '0\n' }, { tracking: { 'user/abc-2-a': SHA }, heads: { 'user/abc-2-a': SHA, 'user/abc-3-b': SHA } });
  assert.equal(missing.contains(b, a), null);
  assert.equal(missing.git.calls.length, 0);
  const stale = contains({ 'rev-list': '0\n' }, { tracking: { 'user/abc-2-a': SHA, 'user/abc-3-b': SHA }, heads: { 'user/abc-2-a': SHA, 'user/abc-3-b': OTHER } });
  assert.equal(stale.contains(b, a), null);
});

test('refContains reads a local candidate from its own branch, with no fetch needed', () => {
  const localTop = { headRefName: 'user/abc-3-b', local: true };
  const out = contains({ 'rev-list': '0\n' }, { tracking: { 'user/abc-2-a': SHA }, heads: { 'user/abc-2-a': SHA } });
  assert.equal(out.contains(localTop, a), null);
  const git = fakeGit({ 'rev-list': '0\n' });
  const known = refContains(git.run, { cwd: '/fake/checkout', remote: 'origin', tracking: { 'user/abc-2-a': SHA }, heads: { 'user/abc-2-a': SHA }, local: ['user/abc-3-b'] });
  assert.equal(known(localTop, a), true);
  assert.deepEqual(git.calls.map(c => c.argv), [['rev-list', '--count', 'refs/heads/user/abc-3-b..origin/user/abc-2-a']]);
});

test('refContains lets a failing git read through instead of reading it as unknown', () => {
  const broken = contains({ 'rev-list': { status: 128, stderr: 'bad object' } }, { tracking: { 'user/abc-2-a': SHA, 'user/abc-3-b': SHA }, heads: { 'user/abc-2-a': SHA, 'user/abc-3-b': SHA } });
  assert.throws(() => broken.contains(b, a), /git rev-list failed \(128\): bad object/);
});
