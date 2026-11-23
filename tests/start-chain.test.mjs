import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxGit, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { run as packs } from '../scripts/packs.mjs';
import { CARD, GIT_BRANCH_NAME, SLUG, startFixture, startIssue } from './helpers/start-fixture.mjs';

guardNetwork();

const CHECK = ['node', 'check.js'];

const fixture = (t, opts) => {
  const f = startFixture(opts);
  t.after(f.dispose);
  return f;
};
const step = async (f, argv, code = 0) => {
  const r = await f.run(argv);
  assert.equal(r.code, code, `${argv.join(' ')}: ${r.stderr}`);
  return code === 0 ? JSON.parse(r.stdout) : r;
};
const sha = (f, ref) => f.repo.git(['rev-parse', ref]).trim();
const worktreePaths = f => f.repo.git(['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree '));
const commitCount = f => f.repo.git(['rev-list', '--all', '--count']).trim();

test('plan, fetch, branch and baseline chained by nextApprove create the branch from origin/main in this checkout only', async t => {
  const f = fixture(t, { repoOver: { typecheck: [CHECK] } });
  const [worktrees, commits] = [worktreePaths(f), commitCount(f)];
  const planned = await step(f, ['plan', CARD]);
  assert.deepEqual([planned.action, planned.base.ref], ['create', 'origin/main']);
  const fetched = await step(f, ['fetch', CARD, '--approve', planned.approve]);
  assert.equal(fetched.nextApprove, planned.approve);
  const branched = await step(f, ['branch', CARD, '--approve', fetched.nextApprove]);
  assert.deepEqual([branched.action, branched.branch, branched.base], ['created', GIT_BRANCH_NAME, 'origin/main']);
  const baselined = await step(f, ['baseline', CARD, '--approve', branched.nextApprove]);
  assert.deepEqual([baselined.configured, baselined.commands], [true, [{ argv: CHECK, status: 0 }]]);
  assert.deepEqual(f.setup.calls.map(c => [c.argv, c.cwd]), [[CHECK, f.repo.dir]]);

  assert.equal(f.repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), GIT_BRANCH_NAME);
  assert.equal(sha(f, GIT_BRANCH_NAME), sha(f, 'origin/main'));
  assert.equal(branched.head, sha(f, 'HEAD'));
  assert.deepEqual(worktreePaths(f), worktrees);
  assert.equal(commitCount(f), commits);
  assert.deepEqual(f.linear.mutations, []);
  assert.ok(f.git.calls.every(c => c.cwd === f.repo.dir), 'every git call ran in the checkout');
  assert.equal((await step(f, ['plan', CARD])).action, 'resume');
});

test('a card with no Linear project runs the same chain in no-project mode, and the next plan resumes it', async t => {
  const f = fixture(t, { issues: [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, projectId: null })], repoOver: { typecheck: [CHECK] } });
  const planned = await step(f, ['plan', CARD]);
  assert.deepEqual([planned.action, planned.base.ref, planned.reasons.map(r => r.code)], ['create', 'origin/main', ['no-project']]);
  const fetched = await step(f, ['fetch', CARD, '--approve', planned.approve]);
  const branched = await step(f, ['branch', CARD, '--approve', fetched.nextApprove]);
  assert.deepEqual([branched.action, branched.branch, branched.base], ['created', GIT_BRANCH_NAME, 'origin/main']);
  const baselined = await step(f, ['baseline', CARD, '--approve', branched.nextApprove]);
  assert.deepEqual([baselined.configured, baselined.commands], [true, [{ argv: CHECK, status: 0 }]]);
  assert.equal(f.repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), GIT_BRANCH_NAME);
  assert.ok(f.linear.sent.every(s => !s.body.query.includes('project(id:')), 'no project read was sent');
  assert.equal((await step(f, ['plan', CARD])).action, 'resume');
});

// Another clone pushes one commit to main; this checkout has not fetched it.
function pushToMain(t, f) {
  const other = join(tempDir('keiron-sequencer-start-main-'), 'clone');
  t.after(() => rmSync(join(other, '..'), { recursive: true, force: true }));
  sandboxGit(['clone', '-q', f.origin.dir, other]);
  writeFileSync(join(other, 'moved.txt'), 'moved\n');
  sandboxGit(['add', '-A'], { cwd: other });
  sandboxGit(['commit', '-q', '-m', 'main moved'], { cwd: other });
  sandboxGit(['push', '-q', 'origin', 'HEAD'], { cwd: other });
}

test('the pack start drafts after the fetch is fresh in the next plan, and an answer survives a re-draft after the default moves', async t => {
  const f = fixture(t);
  const pk = async argv => {
    const r = await packs(argv, { env: {}, keyFile: f.keyFile, fetchImpl: f.linear.fetchImpl, dataDir: f.dataDir, home: f.home, git: f.git.run });
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const planned = await step(f, ['plan', CARD]);
  const fetched = await step(f, ['fetch', CARD, '--approve', planned.approve]);
  const branched = await step(f, ['branch', CARD, '--approve', fetched.nextApprove]);
  await step(f, ['baseline', CARD, '--approve', branched.nextApprove]);

  const drafted = await pk(['draft', SLUG, '--card', CARD]);
  assert.deepEqual([drafted.drafted, drafted.pack.open, drafted.pack.questions[0].text], [[CARD], 1, 'Which state counts as started.']);
  const outcome = 'A card counts as started once its branch exists.';
  await pk(['answer', SLUG, CARD, 'q1', '--outcome', outcome]);
  const after = await step(f, ['plan', CARD]);
  assert.deepEqual([after.brief.pack.fresh, after.brief.pack.answered], [true, [{ text: 'Which state counts as started.', outcome }]]);
  assert.ok(after.route.reasons.includes('pack-answered:1'), after.route.reasons.join(', '));

  pushToMain(t, f);
  await step(f, ['fetch', CARD, '--approve', after.approve]);
  assert.equal((await step(f, ['plan', CARD])).brief.pack.stale, 'base');
  const redrafted = await pk(['draft', SLUG, '--card', CARD]);
  assert.deepEqual([redrafted.drafted, redrafted.pack.state, redrafted.pack.questions[0].answer.outcome], [[CARD], 'fresh', outcome]);
  const again = await step(f, ['plan', CARD]);
  assert.deepEqual([again.brief.pack.fresh, again.brief.pack.answered.length], [true, 1]);
});

const blocks = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });
const started = { name: 'In Progress', type: 'started' };
const pr = n => ({
  number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `user/abc-${n}-x`,
  title: `[ABC-${n}] blocker`, url: `https://github.com/acme/app/pull/${n}`,
});

// Another clone pushes two stacked blocker branches; this checkout has not fetched them.
function pushStackedBlockers(t, f) {
  const other = join(tempDir('keiron-sequencer-start-other-'), 'clone');
  t.after(() => rmSync(join(other, '..'), { recursive: true, force: true }));
  sandboxGit(['clone', '-q', f.origin.dir, other]);
  const git = args => sandboxGit(args, { cwd: other });
  for (const n of [2, 3]) {
    git(['checkout', '-q', '-b', `user/abc-${n}-x`]);
    writeFileSync(join(other, `blocker-${n}.txt`), `${n}\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', `[ABC-${n}] blocker`]);
  }
  git(['push', '-q', 'origin', 'user/abc-2-x', 'user/abc-3-x']);
}

test('a push the checkout has not fetched changes nextApprove, and branch with the old hash is refused', async t => {
  const f = fixture(t, {
    issues: [
      startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME }),
      startIssue('ABC-2', { state: started, ...blocks(CARD) }), startIssue('ABC-3', { state: started, ...blocks(CARD) }),
    ],
    gh: argv => JSON.stringify(argv.includes('--search') ? ({ 'ABC-2': [pr(2)], 'ABC-3': [pr(3)] }[argv[argv.indexOf('--search') + 1]] ?? []) : []),
  });
  pushStackedBlockers(t, f);
  const planned = await step(f, ['plan', CARD]);
  assert.deepEqual([planned.action, planned.base.kind], ['wait', 'wait']);
  assert.match(planned.base.note, /fetch to decide/);
  const fetched = await step(f, ['fetch', CARD, '--approve', planned.approve]);
  assert.notEqual(fetched.nextApprove, planned.approve);
  const stale = await step(f, ['branch', CARD, '--approve', planned.approve], 5);
  assert.match(stale.stderr, /changed since it was approved/);
  assert.equal(f.git.calls.filter(c => c.argv[0] === 'checkout').length, 0);
  assert.equal(f.repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  const branched = await step(f, ['branch', CARD, '--approve', fetched.nextApprove]);
  assert.equal(branched.base, 'origin/user/abc-3-x');
  assert.equal(sha(f, GIT_BRANCH_NAME), sha(f, 'origin/user/abc-3-x'));
  assert.deepEqual(f.linear.mutations, []);
});

test('a branch created under a custom --name carrying the card id is resumed by the next plan', async t => {
  const f = fixture(t, { repoOver: { branchNaming: 'strip-card-id' } });
  const name = 'feat/abc-1-custom';
  const planned = await step(f, ['plan', CARD]);
  assert.deepEqual([planned.action, planned.branch.name], ['create', 'user/some-title']);
  const branched = await step(f, ['branch', CARD, '--approve', planned.approve, '--name', name]);
  assert.deepEqual([branched.action, branched.branch], ['created', name]);
  assert.equal(sha(f, name), sha(f, 'origin/main'));
  const again = await step(f, ['plan', CARD]);
  assert.equal(again.action, 'resume');
  assert.deepEqual(again.resume.branches.map(b => [b.name, b.where]), [[name, 'local']]);
});
