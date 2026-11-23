import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlocker, decideBase } from '../scripts/lib/start/base.mjs';
import { cardRepos, currentCheckout, findResume, givenBranch, PR_FIELDS, repoMatch } from '../scripts/lib/start/checkout.mjs';
import { fakeGit, fakeGitHub } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import {
  appRepo, CARD, checkoutTable, FAKE_CHECKOUT, fakeStartFixture, HEAD_SHA, startIssue, startRecord,
} from './helpers/start-fixture.mjs';

guardNetwork();

const config = (repos = { app: appRepo('/src/app') }) => ({ schemaVersion: 1, repos });
const checkout = (table, cfg = config()) => {
  const git = fakeGit(checkoutTable(table));
  return { git, result: currentCheckout(git.run, cfg, FAKE_CHECKOUT) };
};

test('the repo is the configured one whose github matches an ssh remote of the checkout', () => {
  const { git, result } = checkout({ commonDir: '/elsewhere/.git' });
  assert.equal(result.repoDir, 'app');
  assert.ok(git.calls.length > 0);
  for (const c of git.calls) assert.equal(c.cwd, FAKE_CHECKOUT, c.argv.join(' '));
});

test('an https remote matches case-insensitively, with or without .git', () => {
  for (const url of ['https://github.com/ACME/App.git', 'https://github.com/acme/app', 'ssh://git@github.com/acme/app.git']) {
    const { result } = checkout({ commonDir: '/elsewhere/.git', remotes: `upstream\t${url} (fetch)\n` });
    assert.equal(result.repoDir, 'app', url);
  }
});

test('with no matching remote the repo is found by the common dir path, resolved against the checkout', () => {
  const { result } = checkout({ remotes: 'origin\t/tmp/bare/origin.git (fetch)\n' }, config({ app: appRepo(FAKE_CHECKOUT) }));
  assert.equal(result.repoDir, 'app');
});

test('two configured repos on the same github are told apart by the common dir', () => {
  const cfg = config({ app: appRepo('/src/app'), clone: appRepo(FAKE_CHECKOUT, { name: 'app-clone' }) });
  assert.equal(checkout({}, cfg).result.repoDir, 'clone');
});

test('a checkout matching no configured repo is unconfigured and nothing else is read', () => {
  const { git, result } = checkout({ commonDir: '/elsewhere/.git', remotes: 'origin\tgit@github.com:other/thing.git (fetch)\n' });
  assert.equal(result.unconfigured, true);
  assert.equal(result.repoDir, null);
  assert.deepEqual(git.calls.map(c => c.sub), ['rev-parse', 'rev-parse', 'remote', 'status']);
});

test('the status read takes no optional locks', () => {
  const { git } = checkout({});
  const status = git.calls.find(c => c.sub === 'status');
  assert.equal(status.env.GIT_OPTIONAL_LOCKS, '0');
});

test('branch, detached HEAD and the dirty count, untracked files included', () => {
  const clean = checkout({}).result;
  assert.deepEqual([clean.branch, clean.detached, clean.dirty, clean.head], ['main', false, 0, HEAD_SHA]);
  const dirty = checkout({ branch: null, status: ' M src/a.js\n?? notes.txt\n' }).result;
  assert.deepEqual([dirty.branch, dirty.detached, dirty.dirty], [null, true, 2]);
});

test('local and remote branches, the local default ref and the other worktrees are read from the checkout', () => {
  const { result } = checkout({
    refs: ['refs/heads/feature', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', `${'c'.repeat(40)} refs/remotes/origin/user/abc-1-x`, 'refs/remotes/fork/main'],
    worktrees: [{ path: FAKE_CHECKOUT, branch: 'feature' }, { path: '/src/app-wt', branch: 'user/abc-1-x' }, { path: '/src/app-detached', branch: null }],
  });
  assert.equal(result.defaultBranchLocal, false);
  assert.deepEqual(result.branches, { local: ['feature'], remote: ['main', 'user/abc-1-x'] });
  assert.deepEqual(result.tracking, { main: HEAD_SHA, 'user/abc-1-x': `${'c'.repeat(40)}` });
  assert.deepEqual(result.worktrees, [
    { path: FAKE_CHECKOUT, branch: 'feature' }, { path: '/src/app-wt', branch: 'user/abc-1-x' }, { path: '/src/app-detached', branch: null },
  ]);
  assert.equal(checkout({}).result.defaultBranchLocal, true);
});

const repos2 = config({ app: appRepo('/src/app'), web: appRepo('/src/web', { name: 'web-repo', github: 'acme/web' }) });

test('card repos: a title prefix counts only when it names a configured repo', () => {
  assert.deepEqual(cardRepos({ title: 'web-repo: add the page', description: '' }, null, [], repos2),
    [{ dir: 'web', name: 'web-repo', source: 'title' }]);
  assert.deepEqual(cardRepos({ title: 'Fix: the page', description: 'Repo: app-repo\nmore' }, null, [], repos2),
    [{ dir: 'app', name: 'app-repo', source: 'repo-line' }]);
  assert.deepEqual(cardRepos({ title: 'web: the page', description: 'Repo: app-repo' }, null, [], repos2),
    [{ dir: 'web', name: 'web-repo', source: 'title' }]);
});

test('card repos: an unmapped Repo line is kept as given', () => {
  assert.deepEqual(cardRepos({ title: 'x', description: 'Repo: mystery' }, null, [], repos2), [{ dir: null, name: 'mystery', source: 'repo-line' }]);
});

test('card repos: the union of title, record repos and patch dirs, each repo once', () => {
  const record = startRecord(CARD, { size: { ...startRecord(CARD).size, repos: ['app-repo', 'web-repo'] } });
  assert.deepEqual(cardRepos({ title: 'app-repo: x', description: '' }, record, ['web/0001-x.patch', 'app/0002-y.patch'], repos2), [
    { dir: 'app', name: 'app-repo', source: 'title' },
    { dir: 'web', name: 'web-repo', source: 'record' },
  ]);
  assert.deepEqual(cardRepos({ title: 'x', description: '' }, null, ['web/0001-x.patch'], repos2), [{ dir: 'web', name: 'web-repo', source: 'patches' }]);
  assert.deepEqual(cardRepos({ title: 'x', description: '' }, null, [], repos2), []);
});

const plan = async (f, argv = ['plan', CARD]) => {
  const r = await f.run(argv);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const fixture = (t, opts) => {
  const f = fakeStartFixture(opts);
  t.after(f.dispose);
  return f;
};
const codes = out => out.reasons.map(r => r.code);
const webRecord = startRecord(CARD, { size: { ...startRecord(CARD).size, repos: ['web-repo'] } });
const webRepos = { app: appRepo(FAKE_CHECKOUT), web: appRepo('/src/web', { name: 'web-repo', github: 'acme/web' }) };

test('a checkout matching no configured repo is a stop plan, exit 0, with no gh call', async t => {
  const f = fixture(t, { git: { commonDir: '/elsewhere/.git', remotes: 'origin\tgit@github.com:other/thing.git (fetch)\n' } });
  const out = await plan(f);
  assert.equal(out.action, 'stop');
  assert.deepEqual(codes(out), ['repo-unconfigured']);
  assert.match(out.reasons[0].message, /is not the checkout of any repo in the keiron-sequencer config/);
  assert.equal(out.checkout.repoDir, null);
  assert.match(out.approve, /^[0-9a-f]{12}$/);
  assert.equal(f.gh.calls.length, 0);
});

test('a card of another configured repo is a wrong-repo stop naming the expected repo', async t => {
  const f = fixture(t, { repos: webRepos, records: [webRecord], issues: [startIssue(CARD, { title: 'web-repo: the page', gitBranchName: 'u/abc-1-x' })] });
  const out = await plan(f);
  assert.equal(out.action, 'stop');
  assert.deepEqual(codes(out), ['wrong-repo']);
  assert.match(out.reasons[0].message, /web-repo/);
  assert.deepEqual(out.reasons[0].checkouts, [{ dir: 'web', name: 'web-repo', github: 'acme/web', checkout: '/src/web' }]);
  assert.deepEqual(out.card.repos, [{ dir: 'web', name: 'web-repo', source: 'title' }]);
  assert.equal(f.gh.calls.length, 0);
});

test('a two-repo card run from its second repo is not wrong-repo', async t => {
  const record = startRecord(CARD, { size: { ...startRecord(CARD).size, repos: ['web-repo', 'app-repo'] } });
  const f = fixture(t, { repos: webRepos, records: [record] });
  const out = await plan(f);
  assert.equal(out.action, 'create');
  assert.deepEqual(out.card.repos.map(r => r.dir).sort(), ['app', 'web']);
});

test('a card naming no repo assumes the current one, with a warning; one naming only others is wrong-repo', () => {
  const current = { dir: 'app', name: 'app-repo' };
  const assumed = repoMatch([], current);
  assert.deepEqual(assumed.repos, [{ dir: 'app', name: 'app-repo', source: 'assumed' }]);
  assert.equal(assumed.wrongRepo, null);
  assert.match(assumed.warning, /no repo/);
  const web = [{ dir: 'web', name: 'web-repo', source: 'title' }, { dir: null, name: 'mystery', source: 'repo-line' }];
  assert.deepEqual(repoMatch(web, current), { repos: web, wrongRepo: ['web-repo', 'mystery'], warning: null });
  const both = [...web, { dir: 'app', name: 'app-repo', source: 'record' }];
  assert.deepEqual(repoMatch(both, current), { repos: both, wrongRepo: null, warning: null });
});

const knownRepos = [{ dir: 'app', github: 'acme/app' }];
const given = (heads, respond = () => '[]', local = []) => {
  const git = fakeGit({ 'ls-remote': heads.map(h => `${HEAD_SHA}\trefs/heads/${h}\n`).join('') });
  const gh = fakeGitHub(respond);
  const out = givenBranch(git.run, gh.run, { cwd: FAKE_CHECKOUT, remote: 'origin', github: 'acme/app', branch: 'user/abc-2-x', known: knownRepos, local });
  return { git, gh, out };
};

test('a given blocker branch is checked with exactly one ls-remote of that branch, in the checkout', () => {
  const { git, out } = given(['user/abc-2-x']);
  assert.deepEqual(git.calls.map(c => [c.argv, c.cwd]), [[['ls-remote', '--heads', 'origin', 'refs/heads/user/abc-2-x'], FAKE_CHECKOUT]]);
  assert.equal(out.found, true);
});

test('a given branch that is not on the remote is not found, with a warning naming the remote; a suffix match does not count', () => {
  for (const heads of [[], ['team/user/abc-2-x']]) {
    const { gh, out } = given(heads);
    assert.equal(out.found, false);
    assert.match(out.warning, /branch user\/abc-2-x not found on origin or in this checkout/);
    assert.equal(gh.calls.length, 0);
  }
});

test('a given branch only in this checkout is found as a local branch, with no PR lookup', () => {
  const { gh, out } = given([], undefined, ['main', 'user/abc-2-x']);
  assert.deepEqual([out.found, out.prs, out.branch], [true, [], { name: 'user/abc-2-x', where: 'local', via: 'given' }]);
  assert.equal(gh.calls.length, 0);
});

test('a found branch looks up its PR by head; a PR is tagged given-branch, none leaves a given pushed branch', () => {
  const pr = { number: 12, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: 'user/abc-2-x', title: 'no tag', url: 'u/12' };
  const withPr = given(['user/abc-2-x'], argv => JSON.stringify(argv.includes('--head') ? [pr] : []));
  assert.deepEqual(withPr.gh.calls.map(c => c.argv), [['pr', 'list', '--repo', 'acme/app', '--head', 'user/abc-2-x', '--state', 'all', '--json', PR_FIELDS]]);
  assert.deepEqual(withPr.out.prs.map(p => [p.number, p.repoDir, p.via]), [[12, 'app', 'given-branch']]);
  assert.equal(withPr.out.branch, null);
  const bare = given(['user/abc-2-x']);
  assert.deepEqual([bare.out.prs, bare.out.branch], [[], { name: 'user/abc-2-x', where: 'remote', via: 'given' }]);
});

test('a given branch with no PR is the base to stack on; the same blocker skipped gives the default branch', () => {
  const { out } = given(['user/abc-2-x']);
  const blocker = { key: 'ABC-2', linearState: { name: 'In Progress', type: 'started' }, prs: out.prs, branches: [out.branch] };
  const ctx = { currentRepoDir: 'app', defaultBranchOf: () => 'main' };
  const opts = { remote: 'origin', defaultBranch: 'main', chainOf: () => ({}) };
  const { status, branch } = classifyBlocker(blocker, ctx);
  assert.equal(status, 'branch');
  assert.deepEqual(Object.values(decideBase([{ ...blocker, status, branch }], opts)).slice(0, 2), ['stack', 'origin/user/abc-2-x']);
  const skipped = classifyBlocker({ ...blocker, skipped: true }, ctx).status;
  assert.equal(decideBase([{ ...blocker, status: skipped }], opts).kind, 'default');
});

const ownPr = (n, over = {}) => ({
  number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `user/abc-1-${n}`,
  title: `[ABC-1] mine ${n}`, url: `https://github.com/acme/app/pull/${n}`, ...over,
});
const resumeIn = ({ local = ['main'], remote = ['main'], worktrees = [{ path: FAKE_CHECKOUT, branch: 'main' }], heads = { main: HEAD_SHA }, attachments = [], branchName = 'user/abc-1-some-title' } = {}, respond = () => '[]') => {
  const gh = fakeGitHub(respond);
  const out = findResume(gh.run, {
    github: 'acme/app', cardKey: CARD, branchName, attachments, heads,
    checkout: { path: FAKE_CHECKOUT, branches: { local, remote }, worktrees }, known: [{ dir: 'app', github: 'acme/app' }, { dir: 'web', github: 'acme/web' }],
  });
  return { gh, out };
};

test('nothing started: no branch, no PR', () => {
  const { out } = resumeIn();
  assert.deepEqual(out, { found: false, branches: [], prs: [], elsewhere: [], remote: 'ok', ask: [], unavailable: null });
});

test('a local branch equal to the branch name, or carrying the card id in any case, is resumed locally; a longer id is not', () => {
  const { out } = resumeIn({ local: ['main', 'user/abc-1-some-title', 'Feature/ABC-1-old', 'user/abc-10-other'] });
  assert.equal(out.found, true);
  assert.deepEqual(out.branches, [
    { name: 'Feature/ABC-1-old', where: 'local', path: null }, { name: 'user/abc-1-some-title', where: 'local', path: null },
  ]);
});

test('a branch only on the remote is resumed from the remote, by ls-remote or by its tracking ref', () => {
  assert.deepEqual(resumeIn({ heads: { main: HEAD_SHA, 'user/abc-1-some-title': HEAD_SHA } }).out.branches,
    [{ name: 'user/abc-1-some-title', where: 'remote', path: null }]);
  assert.deepEqual(resumeIn({ remote: ['main', 'abc-1-wip'] }).out.branches, [{ name: 'abc-1-wip', where: 'remote', path: null }]);
});

test('a branch checked out in another worktree is reported with its path; the current worktree is local', () => {
  const worktrees = [{ path: FAKE_CHECKOUT, branch: 'abc-1-here' }, { path: '/src/app-wt', branch: 'user/abc-1-some-title' }];
  const { out } = resumeIn({ local: ['abc-1-here', 'user/abc-1-some-title'], worktrees });
  assert.deepEqual(out.branches, [
    { name: 'abc-1-here', where: 'local', path: null }, { name: 'user/abc-1-some-title', where: 'worktree', path: '/src/app-wt' },
  ]);
});

test('an open or draft PR of the card is resumed with its number, found by title tag, by head or by attachment', () => {
  const bySearch = resumeIn({}, argv => JSON.stringify(argv.includes('--search') ? [ownPr(4, { isDraft: true }), ownPr(5, { title: 'number only' })] : []));
  assert.deepEqual([bySearch.out.found, bySearch.out.prs.map(p => p.number)], [true, [4]]);
  const byHead = resumeIn({}, argv => JSON.stringify(argv.includes('--head') ? [ownPr(6, { title: 'untagged', headRefName: 'user/abc-1-some-title' })] : []));
  assert.deepEqual(byHead.out.prs.map(p => [p.number, p.via]), [[6, 'head']]);
  assert.ok(byHead.gh.calls.some(c => c.argv.join(' ').includes('--head user/abc-1-some-title')));
  const byAttachment = resumeIn({ attachments: ['https://github.com/acme/app/pull/7'] }, argv => (argv[1] === 'view' ? JSON.stringify(ownPr(7, { title: 'x' })) : '[]'));
  assert.deepEqual(byAttachment.out.prs.map(p => [p.number, p.via]), [[7, 'attachment']]);
});

test('with no branch name only the title search and the attachments are read', () => {
  const { gh } = resumeIn({ branchName: null });
  assert.ok(!gh.calls.some(c => c.argv.includes('--head')));
});

test('a PR of the card in another repo is listed elsewhere and does not resume here', () => {
  const { out } = resumeIn({ attachments: ['https://github.com/acme/web/pull/8'] },
    argv => (argv[1] === 'view' ? JSON.stringify(ownPr(8, { url: 'https://github.com/acme/web/pull/8' })) : '[]'));
  assert.equal(out.found, false);
  assert.deepEqual(out.elsewhere.map(p => [p.number, p.github, p.repoDir]), [[8, 'acme/web', 'web']]);
});

test('only a merged or only a closed PR of the card is an ask, not a resume', () => {
  const mergedOnly = resumeIn({}, argv => JSON.stringify(argv.includes('--search') ? [ownPr(9, { state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z' })] : []));
  assert.deepEqual([mergedOnly.out.found, mergedOnly.out.ask], [false, ['pr-merged']]);
  const closedOnly = resumeIn({}, argv => JSON.stringify(argv.includes('--search') ? [ownPr(9, { state: 'CLOSED' })] : []));
  assert.deepEqual([closedOnly.out.found, closedOnly.out.ask], [false, ['pr-closed']]);
});

test('a gh failure marks the remote unavailable', () => {
  const failed = resumeIn({}, () => ({ status: 1, stderr: 'HTTP 401' }));
  assert.equal(failed.out.remote, 'unavailable');
  assert.match(failed.out.unavailable, /401/);
});

test('a Repo: line written as a list item still names the card\'s repo', () => {
  const config = { repos: {} };
  for (const description of ['## Qué\n\n* Repo: app-repo (`apps/base`).\n* más', '- Repo: `app-repo`', '  * Repo: app-repo', '* Repo: app-repo.', '* Repo: app-repo, with its jobs']) {
    assert.deepEqual(cardRepos({ title: 'Hacer algo', description }, null, [], config), [{ dir: null, name: 'app-repo', source: 'repo-line' }], description);
  }
});
