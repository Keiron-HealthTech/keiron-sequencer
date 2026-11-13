import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { snapshot } from '../scripts/lib/spike/snapshot.mjs';
import { guardTree, openTree, teardownTrees, touchedCheckouts } from '../scripts/lib/spike/trees.mjs';
import { makeBareOrigin, makeRepo, SANDBOX_ENV, sandboxGit, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, notes, PROJECT_URL, SLUG, spikeFixture, twoRepoFixture } from './helpers/spike-fixture.mjs';

guardNetwork();

const git = gitRunner({ env: SANDBOX_ENV });
const disposeLater = (...dirs) => after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

function commitIn(dir, file, text) {
  writeFileSync(join(dir, file), text);
  sandboxGit(['add', '-A'], { cwd: dir });
  sandboxGit(['commit', '-q', '-m', file], { cwd: dir });
  return sandboxGit(['rev-parse', 'HEAD'], { cwd: dir }).trim();
}

// A bare origin seeded from a sandbox repo, a user checkout cloned from it, and an origin that then moved ahead.
function remoteRepo({ branch = 'main' } = {}) {
  const seed = makeRepo();
  if (branch !== 'main') seed.git(['branch', '-m', branch]);
  const origin = makeBareOrigin({ from: seed.dir });
  if (branch !== 'main') sandboxGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: origin.dir });
  const checkout = join(tempDir('keiron-sequencer-trees-checkout-'), 'checkout');
  sandboxGit(['clone', '-q', origin.dir, checkout]);
  const userTip = sandboxGit(['rev-parse', 'HEAD'], { cwd: checkout }).trim();
  const originTip = commitIn(seed.dir, 'ahead.txt', 'ahead\n');
  sandboxGit(['push', '-q', origin.dir, `HEAD:refs/heads/${branch}`], { cwd: seed.dir });
  after(() => { seed.dispose(); origin.dispose(); rmSync(join(checkout, '..'), { recursive: true, force: true }); });
  return { seed, origin, checkout, userTip, originTip };
}

const runDirFor = () => {
  const dir = tempDir('keiron-sequencer-trees-run-');
  disposeLater(dir);
  return dir;
};

const repoConfig = over => ({ name: 'backend-repo', checkout: null, url: null, remote: 'origin', defaultBranch: 'main', setup: [], ...over });
const refs = cwd => sandboxGit(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd });
const worktrees = cwd => sandboxGit(['worktree', 'list', '--porcelain'], { cwd }).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));

test('a checkout with a remote gets a detached worktree at the fetched remote tip, not the stale local branch', () => {
  const { checkout, userTip, originTip } = remoteRepo();
  const dir = runDirFor();
  const state = { repos: {} };
  const repo = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir });

  assert.equal(repo.path, join(dir, 'trees', 'backend'));
  assert.deepEqual(state.repos.backend, repo);
  assert.equal(repo.kind, 'worktree');
  assert.equal(repo.source, checkout);
  assert.equal(repo.createdBySpike, true);
  assert.equal(repo.status, 'open');
  assert.equal(repo.baseCommit, originTip);
  assert.equal(repo.baseTree, sandboxGit(['rev-parse', `${originTip}^{tree}`], { cwd: checkout }).trim());
  assert.equal(repo.last, repo.baseTree);
  assert.deepEqual(repo.log, []);
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: repo.path }).trim(), originTip);
  assert.equal(sandboxGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: repo.path }).trim(), 'HEAD');
  assert.equal(sandboxGit(['rev-parse', 'refs/heads/main'], { cwd: checkout }).trim(), userTip);
  assert.ok(worktrees(checkout).includes(repo.path));
});

test('defaultBranch null resolves through the remote HEAD symbolic ref', () => {
  const { checkout, originTip } = remoteRepo({ branch: 'trunk' });
  const repo = openTree(git, { repos: {} }, { repoDir: 'backend', repo: repoConfig({ checkout, defaultBranch: null }), dir: runDirFor() });
  assert.equal(repo.baseCommit, originTip);
});

test('a checkout with remote null is based on its local branch tip, with no fetch', () => {
  const { checkout, userTip } = remoteRepo();
  const before = refs(checkout);
  const repo = openTree(git, { repos: {} }, { repoDir: 'backend', repo: repoConfig({ checkout, remote: null }), dir: runDirFor() });
  assert.equal(repo.baseCommit, userTip);
  assert.equal(refs(checkout), before);
});

test('a url repo gets a scratch clone with a detached HEAD at the default branch tip, and its source is left alone', () => {
  const { origin, originTip } = remoteRepo();
  const before = refs(origin.dir);
  const dir = runDirFor();
  const repo = openTree(git, { repos: {} }, { repoDir: 'web', repo: repoConfig({ url: origin.dir }), dir });
  assert.equal(repo.kind, 'clone');
  assert.equal(repo.source, origin.dir);
  assert.equal(repo.path, join(dir, 'trees', 'web'));
  assert.equal(repo.baseCommit, originTip);
  assert.equal(sandboxGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: repo.path }).trim(), 'HEAD');
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: repo.path }).trim(), originTip);
  assert.equal(refs(origin.dir), before);
});

test('a url repo with defaultBranch null is cloned at the remote HEAD branch as origin, whatever remote name the config gives, and that remote gets the blocked pushurl', () => {
  const { origin, originTip } = remoteRepo({ branch: 'trunk' });
  const repo = openTree(git, { repos: {} }, { repoDir: 'web', repo: repoConfig({ url: origin.dir, defaultBranch: null, remote: 'upstream' }), dir: runDirFor() });
  assert.equal(repo.baseCommit, originTip);
  assert.equal(sandboxGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: repo.path }).trim(), 'HEAD');
  assert.deepEqual(sandboxGit(['remote'], { cwd: repo.path }).split('\n').filter(Boolean), ['origin']);
  assert.equal(sandboxGit(['config', '--local', '--get', 'remote.origin.pushurl'], { cwd: repo.path }).trim(), 'keiron-sequencer-no-push:///blocked');
});

test('opening a tree twice is idempotent: the second call returns the recorded tree and creates nothing', () => {
  const { checkout } = remoteRepo();
  const dir = runDirFor();
  const state = { repos: {} };
  const first = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir });
  const snapshot = structuredClone(first);
  const second = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir });
  assert.equal(second, first);
  assert.deepEqual(second, snapshot);
  assert.equal(worktrees(checkout).length, 2);
});

test('tree opens only the repo it names: the other configured repo gets no tree', async () => {
  const { deps, home, other } = twoRepoFixture();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  await run(['next'], deps);
  const r = await run(['tree', 'backend'], deps);
  assert.equal(r.code, 0, r.stderr);
  const dir = join(home, SLUG, 'runs', runId);
  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.repos), ['backend']);
  assert.equal(existsSync(join(dir, 'trees', 'frontend')), false);
  assert.equal(worktrees(other.dir).length, 1);
});

const PR_DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # sandbox\n+from the pr\n';
const CONFLICTING = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # not this line\n+from the pr\n';

function prFixture(diff = PR_DIFF, over = {}) {
  const prs = [{ number: 41, title: '[CRM-1] feature', url: 'https://github.com/acme/backend/pull/41', isDraft: false }];
  return spikeFixture({
    issues: [issue('CRM-1')],
    gh: argv => (argv[1] === 'list' ? JSON.stringify(prs) : diff),
    ...over,
  });
}

test('an existing-PR card gets its PR diff applied into the tree it is opened in, read with gh pr diff', async () => {
  const { deps, gh } = prFixture();
  await run(['begin', PROJECT_URL], deps);
  const brief = JSON.parse((await run(['next'], deps)).stdout);
  assert.equal(brief.origin, 'existing-pr');
  const r = await run(['tree', 'backend'], deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.prDiff, 'applied');
  assert.equal(readFileSync(join(out.path, 'README.md'), 'utf8'), '# sandbox\nfrom the pr\n');
  assert.deepEqual(gh.calls.map(c => c.argv).at(-1), ['pr', 'diff', '41', '--repo', 'acme/backend', '--color', 'never']);
  assert.equal(sandboxGit(['diff', '--cached', '--name-only'], { cwd: out.path }).trim(), '');

  const again = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  assert.equal(again.prDiff, undefined);
  assert.equal(gh.calls.filter(c => c.argv[1] === 'diff').length, 1);
  assert.equal(readFileSync(join(out.path, 'README.md'), 'utf8'), '# sandbox\nfrom the pr\n');
});

test('a PR diff that does not apply is reported as a conflict and leaves the tree for the agent', async () => {
  const { deps } = prFixture(CONFLICTING);
  await run(['begin', PROJECT_URL], deps);
  await run(['next'], deps);
  const r = await run(['tree', 'backend'], deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.prDiff, 'conflict');
  assert.match(out.prDiffError, /README\.md/);
  assert.equal(readFileSync(join(out.path, 'README.md'), 'utf8'), '# sandbox\n');
});

test('an existing-PR card whose repo tree is already open gets the diff applied when next starts it', async () => {
  const prs = [{ number: 41, title: '[CRM-2] feature', url: 'https://github.com/acme/backend/pull/41', isDraft: false }];
  const { deps, home, at } = spikeFixture({
    issues: [issue('CRM-1'), issue('CRM-2')],
    gh: argv => (argv[1] === 'list' ? JSON.stringify(prs) : PR_DIFF),
  });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'src', 'index.js'), 'export const one = 2\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);

  at('2026-11-10T10:06:00.000Z');
  const brief = JSON.parse((await run(['next'], deps)).stdout);
  assert.equal(brief.card, 'CRM-2');
  assert.equal(brief.prDiff, 'applied');
  assert.equal(readFileSync(join(tree.path, 'README.md'), 'utf8'), '# sandbox\nfrom the pr\n');
});

const localConfig = cwd => sandboxGit(['config', '--local', '--list'], { cwd }).split('\n').filter(Boolean).sort();
const pushFails = (args, cwd) => assert.throws(() => sandboxGit(['push', '-q', ...args], { cwd }), /failed/);
const branchesOf = cwd => sandboxGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd }).trim().split('\n');

test('a worktree carries its own push guard: a hand push to its remote or to a URL is rejected, and the checkout is untouched', () => {
  const { checkout, origin } = remoteRepo();
  const before = localConfig(checkout);
  const dir = runDirFor();
  const state = { repos: {} };
  const repo = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir });

  pushFails(['origin', 'HEAD:refs/heads/spiked'], repo.path);
  pushFails([origin.dir, 'HEAD:refs/heads/spiked'], repo.path);
  assert.deepEqual(branchesOf(origin.dir), ['refs/heads/main']);
  assert.equal(sandboxGit(['config', '--worktree', '--get', 'remote.origin.pushurl'], { cwd: repo.path }).trim(), 'keiron-sequencer-no-push:///blocked');
  assert.equal(sandboxGit(['config', '--worktree', '--get', 'core.hooksPath'], { cwd: repo.path }).trim(), join(dir, 'hooks'));
  const hook = readFileSync(join(dir, 'hooks', 'pre-push'), 'utf8');
  assert.match(hook, /^echo "keiron-sequencer: a spike tree never pushes" >&2$/m);
  assert.doesNotMatch(hook, new RegExp('mi' + 'kado', 'i'));

  assert.equal(repo.worktreeConfigSet, true);
  assert.deepEqual(localConfig(checkout), [...before, 'extensions.worktreeconfig=true'].sort());
  assert.deepEqual(touchedCheckouts(state), [{ repo: 'backend', checkout }]);
  sandboxGit(['push', '-q', 'origin', 'HEAD:refs/heads/from-the-user'], { cwd: checkout });
  assert.deepEqual(branchesOf(origin.dir), ['refs/heads/from-the-user', 'refs/heads/main']);
});

test('a checkout that already has extensions.worktreeConfig is not reported as touched', () => {
  const { checkout } = remoteRepo();
  sandboxGit(['config', 'extensions.worktreeConfig', 'true'], { cwd: checkout });
  const before = localConfig(checkout);
  const state = { repos: {} };
  const repo = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir: runDirFor() });
  assert.equal(repo.worktreeConfigSet, false);
  assert.deepEqual(touchedCheckouts(state), []);
  assert.deepEqual(localConfig(checkout), before);
});

test('a scratch clone carries the hook and pushurl in its own config, and its source is untouched', () => {
  const { origin } = remoteRepo();
  const before = localConfig(origin.dir);
  const dir = runDirFor();
  const repo = openTree(git, { repos: {} }, { repoDir: 'web', repo: repoConfig({ url: origin.dir }), dir });
  pushFails(['origin', 'HEAD:refs/heads/spiked'], repo.path);
  pushFails([origin.dir, 'HEAD:refs/heads/spiked'], repo.path);
  assert.equal(sandboxGit(['config', '--local', '--get', 'remote.origin.pushurl'], { cwd: repo.path }).trim(), 'keiron-sequencer-no-push:///blocked');
  assert.equal(repo.worktreeConfigSet, false);
  assert.deepEqual(localConfig(origin.dir), before);
  assert.deepEqual(branchesOf(origin.dir), ['refs/heads/main']);
});

test('the tree guard passes a clean detached tree and refuses a commit or an attached branch with exit 6, naming repo and path', () => {
  const { checkout } = remoteRepo();
  const repo = openTree(git, { repos: {} }, { repoDir: 'backend', repo: repoConfig({ checkout }), dir: runDirFor() });
  guardTree(git, 'backend', repo);
  commitIn(repo.path, 'sneaky.txt', 'x\n');
  const refused = e => e.exitCode === 6 && e.message.includes('backend') && e.message.includes(repo.path);
  assert.throws(() => guardTree(git, 'backend', repo), refused);
  sandboxGit(['checkout', '-q', '--detach', repo.baseCommit], { cwd: repo.path });
  guardTree(git, 'backend', repo);
  sandboxGit(['checkout', '-q', '-b', 'attached'], { cwd: repo.path });
  assert.throws(() => guardTree(git, 'backend', repo), refused);
});

test('end on a tree with a commit past its base exits 6: no patch is written and last does not move', async () => {
  const { deps, home, at } = spikeFixture();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  commitIn(tree.path, 'sneaky.txt', 'x\n');
  writeFileSync(join(tree.path, 'README.md'), 'changed\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  at('2026-11-10T10:05:00.000Z');
  const r = await run(['end', 'CRM-1'], deps);
  assert.equal(r.code, 6);
  assert.match(r.stderr, new RegExp(`backend.*${tree.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(existsSync(join(dir, 'patches')), false);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('tree reports the checkout whose extensions.worktreeConfig it set', async () => {
  const { deps, repo } = spikeFixture();
  await run(['begin', PROJECT_URL], deps);
  await run(['next'], deps);
  const out = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  assert.deepEqual(out.touchedCheckouts, [{ repo: 'backend', checkout: repo.dir }]);
});

const recordingSetup = (respond = () => ({ status: 0, stdout: '', stderr: '' })) => {
  const calls = [];
  let running = 0;
  const run = (argv, opts) => {
    assert.equal(running, 0, 'a setup command started while another was running');
    running++;
    try {
      calls.push({ argv: [...argv], cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return respond(argv, opts);
    } finally {
      running--;
    }
  };
  return { calls, run };
};

test('setup runs in the new tree one command at a time, repo by repo, before the base tree is taken', async () => {
  const { deps, home, other } = twoRepoFixture();
  const setup = recordingSetup();
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  config.repos.backend.setup = [['yarn', 'install'], ['yarn', 'build']];
  config.repos.backend.setupTimeoutMs = 5000;
  config.repos.frontend.setup = [['npm', 'ci']];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], { ...deps, runSetup: setup.run })).stdout);
  await run(['next'], deps);
  const back = JSON.parse((await run(['tree', 'backend'], { ...deps, runSetup: setup.run })).stdout);
  const front = JSON.parse((await run(['tree', 'frontend'], { ...deps, runSetup: setup.run })).stdout);
  assert.deepEqual(setup.calls, [
    { argv: ['yarn', 'install'], cwd: back.path, timeoutMs: 5000 },
    { argv: ['yarn', 'build'], cwd: back.path, timeoutMs: 5000 },
    { argv: ['npm', 'ci'], cwd: front.path, timeoutMs: undefined },
  ]);
  assert.ok(existsSync(join(home, SLUG, 'runs', runId, 'logs', 'setup-backend.log')));
  assert.equal(worktrees(other.dir).length, 2);
});

test('a failing setup command stops the open with exit 1 naming repo, command and exit code; nothing after it runs', async () => {
  const { deps, home } = twoRepoFixture();
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  config.repos.backend.setup = [['yarn', 'install'], ['yarn', 'build'], ['yarn', 'lint']];
  config.repos.frontend.setup = [['npm', 'ci']];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const failing = recordingSetup(argv => ({ status: argv[1] === 'build' ? 1 : 0, stdout: '', stderr: 'boom' }));
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  await run(['next'], deps);
  const r = await run(['tree', 'backend'], { ...deps, runSetup: failing.run });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'setup-failed', repo: 'backend', command: ['yarn', 'build'], exitCode: 1, log: join(home, SLUG, 'runs', runId, 'logs', 'setup-backend.log') });
  assert.match(r.stderr, /setup of backend failed: yarn build exited 1/);
  assert.deepEqual(failing.calls.map(c => c.argv.join(' ')), ['yarn install', 'yarn build']);
  const state = JSON.parse(readFileSync(join(home, SLUG, 'runs', runId, 'run.json'), 'utf8'));
  assert.equal(state.repos.backend.status, 'setup');
  assert.equal(state.repos.backend.baseTree, null);
  assert.equal(state.repos.frontend, undefined);

  const passing = recordingSetup();
  const retry = await run(['tree', 'backend'], { ...deps, runSetup: passing.run });
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(passing.calls.map(c => c.argv.join(' ')), ['yarn install', 'yarn build', 'yarn lint']);
  const opened = JSON.parse(readFileSync(join(home, SLUG, 'runs', runId, 'run.json'), 'utf8')).repos.backend;
  assert.equal(opened.status, 'open');
  assert.equal(opened.last, opened.baseTree);
});

test('setup output goes to the repo log, not to stdout; a command that cannot run is a failure with no exit code', () => {
  const { checkout } = remoteRepo();
  const dir = runDirFor();
  const noisy = recordingSetup(argv => {
    if (argv[0] === 'slow') throw Object.assign(new Error('spawnSync slow ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return { status: 0, stdout: 'installed 3 packages\n', stderr: 'warn: peer dep\n' };
  });
  const state = { repos: {} };
  assert.throws(
    () => openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout, setup: [['npm', 'ci'], ['slow']] }), dir, runSetup: noisy.run }),
    e => e.exitCode === 1 && e.setup.command.join(' ') === 'slow' && e.setup.exitCode === null && /ETIMEDOUT/.test(e.message),
  );
  const log = readFileSync(join(dir, 'logs', 'setup-backend.log'), 'utf8');
  assert.match(log, /^\$ npm ci$/m);
  assert.match(log, /installed 3 packages/);
  assert.match(log, /warn: peer dep/);
  assert.match(log, /^\$ slow$/m);
});

test('files a setup command leaves in the tree are part of the base tree, so no card patch carries them', async () => {
  const { deps, home, at } = spikeFixture();
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  config.repos.backend.setup = [['generate']];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const generating = recordingSetup((argv, { cwd }) => { writeFileSync(join(cwd, 'generated.txt'), 'made by setup\n'); return { status: 0, stdout: '', stderr: '' }; });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], { ...deps, runSetup: generating.run })).stdout);
  const repo = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).repos.backend;
  assert.notEqual(repo.baseTree, sandboxGit(['rev-parse', `${repo.baseCommit}^{tree}`], { cwd: tree.path }).trim());
  assert.ok(sandboxGit(['ls-tree', '--name-only', repo.baseTree], { cwd: tree.path }).split('\n').includes('generated.txt'));

  writeFileSync(join(tree.path, 'README.md'), 'changed\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);
  const patch = readFileSync(join(dir, 'patches', 'backend', '00001-new.patch'), 'utf8');
  assert.doesNotMatch(patch, /generated\.txt/);
  assert.match(patch, /README\.md/);
});

async function oneCardDone(fixture, edit = path => writeFileSync(join(path, 'README.md'), 'changed\n')) {
  const { deps, home, at } = fixture;
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const trees = {};
  for (const repoDir of Object.keys(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).repos)) {
    const r = await run(['tree', repoDir], deps);
    assert.equal(r.code, 0, r.stderr);
    trees[repoDir] = JSON.parse(r.stdout).path;
  }
  edit(trees.backend);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  at('2026-11-10T10:06:00.000Z');
  return { runId, dir, trees };
}

const stateOf = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));

test('completion removes the worktree and the scratch clone, keeps patches and records, and marks the run complete', async () => {
  const { origin } = remoteRepo();
  const fixture = spikeFixture({
    config: config => ({
      ...config,
      repos: { ...config.repos, web: { name: 'web-repo', checkout: null, url: origin.dir, remote: 'origin', defaultBranch: 'main', setup: [] } },
      projects: { [SLUG]: { repos: ['backend', 'web'] } },
    }),
  });
  const { dir, trees } = await oneCardDone(fixture);
  const r = await run(['next'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(Object.keys(out)[0], 'mark');
  assert.equal(out.action, 'complete');
  assert.deepEqual(out.removed, [
    { repo: 'backend', kind: 'worktree', path: trees.backend, prunePending: false },
    { repo: 'web', kind: 'clone', path: trees.web, prunePending: false },
  ]);
  assert.deepEqual(out.touchedCheckouts, [{ repo: 'backend', checkout: fixture.repo.dir }]);
  assert.equal(existsSync(trees.backend), false);
  assert.equal(existsSync(trees.web), false);
  assert.deepEqual(worktrees(fixture.repo.dir), [fixture.repo.dir]);
  assert.ok(existsSync(join(dir, 'patches', 'backend', '00001-new.patch')));
  assert.ok(existsSync(join(fixture.dataDir, SLUG, 'CRM-1.json')));
  const state = stateOf(dir);
  assert.equal(state.status, 'complete');
  assert.deepEqual(Object.values(state.repos).map(x => x.status), ['removed', 'removed']);
  assert.deepEqual([state.executions.at(-1).endReason, state.executions.at(-1).endedAt], ['complete', '2026-11-10T10:06:00.000Z']);
  assert.match((await run(['next'], fixture.deps)).stderr, /no active spike run/);
});

test('completion refuses to remove a tree with work that was never snapshotted, and keeps it', async () => {
  const fixture = spikeFixture();
  const { dir, trees } = await oneCardDone(fixture);
  writeFileSync(join(trees.backend, 'late.txt'), 'never ended\n');
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const r = await run(['next'], fixture.deps);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /backend.*not snapshotted/);
  assert.ok(existsSync(join(trees.backend, 'late.txt')));
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('teardown refuses a tree path that is a user checkout, lies outside the run trees, or was not made by the spike', () => {
  const user = makeRepo();
  after(user.dispose);
  const dir = runDirFor();
  const made = { name: 'b', kind: 'worktree', source: user.dir, createdBySpike: true, baseCommit: 'x', baseTree: 'y', last: 'y', log: [], status: 'open' };
  for (const repo of [
    { ...made, path: user.dir },
    { ...made, path: join(dir, 'elsewhere', 'backend') },
    { ...made, path: join(dir, 'trees', 'backend'), createdBySpike: false },
  ]) {
    assert.throws(() => teardownTrees(git, { repos: { backend: repo } }, { dir }), /refusing to delete/);
  }
  assert.ok(existsSync(join(user.dir, 'README.md')));
});

test('a worktree whose source checkout is gone is deleted and reported as worktree prune pending', async () => {
  const fixture = spikeFixture();
  const { trees } = await oneCardDone(fixture);
  fixture.repo.dispose();
  const r = await run(['next'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.removed, [{ repo: 'backend', kind: 'worktree', path: trees.backend, prunePending: true }]);
  assert.match(out.warnings.join(' '), /backend.*worktree prune/);
  assert.equal(existsSync(trees.backend), false);
});

const looseObject = (checkout, id) => join(checkout, '.git', 'objects', id.slice(0, 2), id.slice(2));

async function lastTreeLost(fixture) {
  const { deps, home, at } = fixture;
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'README.md'), 'changed\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  for (const k of ['CRM-1', 'CRM-2']) writeFileSync(join(dir, 'notes', `${k}.json`), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);
  at('2026-11-10T10:06:00.000Z');
  assert.equal(JSON.parse((await run(['next'], deps)).stdout).card, 'CRM-2');
  const { last } = stateOf(dir).repos.backend;
  rmSync(looseObject(fixture.repo.dir, last));
  assert.throws(() => sandboxGit(['cat-file', '-e', `${last}^{tree}`], { cwd: tree }));
  writeFileSync(join(tree, 'src', 'index.js'), 'export const one = 2\n');
  return { dir, tree, last };
}

test('a lost last tree stops end and resume with exit 6 naming repo and tree; rebuild restores it from the patches', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const refsBefore = refs(fixture.repo.dir);
  const { dir, tree, last } = await lastTreeLost(fixture);
  const before = readFileSync(join(dir, 'run.json'), 'utf8');

  const ended = await run(['end', 'CRM-2'], fixture.deps);
  assert.equal(ended.code, 6);
  assert.match(ended.stderr, new RegExp(`backend.*${last}`));
  assert.equal(existsSync(join(dir, 'patches', 'backend', '00002-new.patch')), false);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);

  const resumed = await run(['begin', PROJECT_URL], fixture.deps);
  assert.equal(resumed.code, 6);
  assert.match(resumed.stderr, new RegExp(`backend.*${last}`));
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);

  const rebuilt = await run(['rebuild', 'backend'], fixture.deps);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.deepEqual(JSON.parse(rebuilt.stdout), { repo: 'backend', tree: last, rebuilt: true });
  sandboxGit(['cat-file', '-e', `${last}^{tree}`], { cwd: tree });
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
  assert.equal(readFileSync(join(tree, 'src', 'index.js'), 'utf8'), 'export const one = 2\n');

  const retried = await run(['end', 'CRM-2'], fixture.deps);
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(readFileSync(join(dir, 'patches', 'backend', '00002-new.patch'), 'utf8'), /^\+export const one = 2$/m);
  assert.equal(refs(fixture.repo.dir), refsBefore);
});

test('a rebuild whose patches do not reproduce the recorded last tree fails and changes nothing', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const refsBefore = refs(fixture.repo.dir);
  const { dir, tree, last } = await lastTreeLost(fixture);
  const patch = join(dir, 'patches', 'backend', '00001-new.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('+changed', '+tampered'));
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const r = await run(['rebuild', 'backend'], fixture.deps);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`backend.*not the recorded last tree ${last}`));
  assert.throws(() => sandboxGit(['cat-file', '-e', `${last}^{tree}`], { cwd: tree }));
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
  assert.equal(refs(fixture.repo.dir), refsBefore);
  assert.equal(sandboxGit(['diff', '--cached', '--name-only'], { cwd: tree }).trim(), 'README.md');
});

// The origin holds an open PR's head under refs/pull/<n>/head; the user's checkout has never fetched it.
function pullRepo() {
  const r = remoteRepo();
  r.seed.git(['checkout', '-q', '-b', 'pr-work']);
  const pinned = commitIn(r.seed.dir, 'pr.txt', 'from the pr\n');
  sandboxGit(['push', '-q', r.origin.dir, 'HEAD:refs/pull/7/head'], { cwd: r.seed.dir });
  r.seed.git(['checkout', '-q', 'main']);
  return { ...r, pinned };
}

const respikeState = base => ({ repos: {}, plan: { respike: { bases: { backend: base } } } });
const prBase = sha => ({ kind: 'pr', ref: 'refs/pull/7/head', sha, card: 'CRM-7', heads: null, tree: null, behind: null });
const userView = checkout => [sandboxGit(['rev-parse', 'HEAD'], { cwd: checkout }), sandboxGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'], { cwd: checkout })];

test('a pinned PR base opens a worktree detached at the pin after fetching the PR head, and the user checkout keeps its HEAD and branches', () => {
  const { checkout, origin, pinned } = pullRepo();
  const before = userView(checkout);
  const dir = runDirFor();
  const state = respikeState(prBase(pinned));
  const repo = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir });
  assert.equal(repo.baseCommit, pinned);
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: repo.path }).trim(), pinned);
  assert.equal(sandboxGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: repo.path }).trim(), 'HEAD');
  assert.equal(readFileSync(join(repo.path, 'pr.txt'), 'utf8'), 'from the pr\n');
  assert.equal(repo.baseTree, sandboxGit(['rev-parse', `${pinned}^{tree}`], { cwd: checkout }).trim());
  assert.deepEqual(userView(checkout), before);
  guardTree(git, 'backend', repo);
  assert.equal(sandboxGit(['rev-list', '--count', `${repo.baseCommit}..HEAD`], { cwd: repo.path }).trim(), '0');
  pushFails([origin.dir, 'HEAD:refs/heads/spiked'], repo.path);
});

test('a PR head that moved on after the plan still opens at the pinned commit', () => {
  const { checkout, origin, seed, pinned } = pullRepo();
  seed.git(['checkout', '-q', 'pr-work']);
  const moved = commitIn(seed.dir, 'pr.txt', 'moved on\n');
  sandboxGit(['push', '-q', '-f', origin.dir, 'HEAD:refs/pull/7/head'], { cwd: seed.dir });
  assert.notEqual(moved, pinned);
  const repo = openTree(git, respikeState(prBase(pinned)), { repoDir: 'backend', repo: repoConfig({ checkout }), dir: runDirFor() });
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: repo.path }).trim(), pinned);
  assert.equal(readFileSync(join(repo.path, 'pr.txt'), 'utf8'), 'from the pr\n');
});

test('a pinned base that is not reachable after the fetch refuses with exit 1 naming the repo and the pin, and creates nothing', () => {
  const { checkout } = pullRepo();
  const gone = 'f'.repeat(40);
  const dir = runDirFor();
  const state = respikeState(prBase(gone));
  const before = worktrees(checkout);
  assert.throws(() => openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir }), e => {
    assert.equal(e.exitCode, 1);
    assert.match(e.message, new RegExp(`pinned base ${gone} for backend is gone`));
    return true;
  });
  assert.deepEqual(state.repos, {});
  assert.equal(existsSync(join(dir, 'trees')), false);
  assert.deepEqual(worktrees(checkout), before);
  assert.equal(sandboxGit(['config', '--type=bool', '--default=false', '--get', 'extensions.worktreeConfig'], { cwd: checkout }).trim(), 'false');
});

test('a local branch base is a worktree detached at its pinned commit, with no fetch, and the branch ref is unchanged', () => {
  const { checkout } = remoteRepo();
  sandboxGit(['checkout', '-q', '-b', 'crm-8-local'], { cwd: checkout });
  const pinned = commitIn(checkout, 'local.txt', 'local work\n');
  commitIn(checkout, 'later.txt', 'after the plan\n');
  sandboxGit(['checkout', '-q', 'main'], { cwd: checkout });
  const before = userView(checkout);
  const calls = [];
  const recording = (args, opts) => { calls.push(args[0]); return git(args, opts); };
  const state = respikeState({ kind: 'local', ref: 'crm-8-local', sha: pinned, card: 'CRM-8', heads: null, tree: null, behind: null });
  const repo = openTree(recording, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir: runDirFor() });
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: repo.path }).trim(), pinned);
  assert.equal(existsSync(join(repo.path, 'later.txt')), false);
  assert.equal(calls.includes('fetch'), false);
  assert.deepEqual(userView(checkout), before);
  guardTree(git, 'backend', repo);
});

test('a default base in a respike plan opens at the fetched default branch tip, as a plain run does', () => {
  const { checkout, originTip } = remoteRepo();
  const state = respikeState({ kind: 'default', ref: 'origin/main', sha: null, card: null, heads: null, tree: null, behind: null });
  const repo = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir: runDirFor() });
  assert.equal(repo.baseCommit, originTip);
});

// Two PRs off main that change different files: neither contains the other, and they merge cleanly.
function divergedPulls() {
  const r = remoteRepo();
  const head = (n, file) => {
    r.seed.git(['checkout', '-q', '-B', `pr-${n}`, 'main']);
    const sha = commitIn(r.seed.dir, file, `from pr ${n}\n`);
    sandboxGit(['push', '-q', r.origin.dir, `HEAD:refs/pull/${n}/head`], { cwd: r.seed.dir });
    return sha;
  };
  const h1 = head(7, 'seven.txt');
  const h2 = head(8, 'eight.txt');
  r.seed.git(['checkout', '-q', 'main']);
  const tree = r.seed.git(['merge-tree', '--write-tree', h1, h2]).trim();
  const heads = [{ card: 'CRM-7', kind: 'pr', ref: 'refs/pull/7/head', sha: h1 }, { card: 'CRM-8', kind: 'pr', ref: 'refs/pull/8/head', sha: h2 }];
  return { ...r, h1, h2, tree, base: { kind: 'combine', ref: null, sha: h1, card: null, heads, tree, behind: null } };
}

const userRefs = checkout => [
  sandboxGit(['rev-parse', 'HEAD'], { cwd: checkout }),
  sandboxGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes'], { cwd: checkout }),
];

test('a combine base opens detached at the first head with the pinned heads combined in its index and files, and no commit, branch or tag', () => {
  const { checkout, h1, h2, tree, base } = divergedPulls();
  const before = userRefs(checkout);
  const state = respikeState(base);
  const repo = openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir: runDirFor() });
  assert.equal(repo.baseCommit, h1);
  assert.deepEqual(repo.combine, { heads: [{ card: 'CRM-7', sha: h1 }, { card: 'CRM-8', sha: h2 }], tree });
  assert.equal(repo.baseTree, tree);
  assert.equal(repo.last, tree);
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: repo.path }).trim(), h1);
  assert.equal(sandboxGit(['rev-list', '--count', `${h1}..HEAD`], { cwd: repo.path }).trim(), '0');
  assert.equal(readFileSync(join(repo.path, 'seven.txt'), 'utf8'), 'from pr 7\n');
  assert.equal(readFileSync(join(repo.path, 'eight.txt'), 'utf8'), 'from pr 8\n');
  guardTree(git, 'backend', repo);
  assert.deepEqual(userRefs(checkout), before);

  writeFileSync(join(repo.path, 'spiked.txt'), 'spiked\n');
  const snap = snapshot(git, repo);
  assert.deepEqual([...snap.patch.matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1]), ['spiked.txt']);
});

test('a combined tree that differs from the pinned one refuses with exit 1 naming the repo and leaves no worktree', () => {
  const { checkout, seed, base } = divergedPulls();
  const before = worktrees(checkout);
  const dir = runDirFor();
  const state = respikeState({ ...base, tree: seed.git(['rev-parse', `${base.heads[0].sha}^{tree}`]).trim() });
  assert.throws(() => openTree(git, state, { repoDir: 'backend', repo: repoConfig({ checkout }), dir }), e => {
    assert.equal(e.exitCode, 1);
    assert.match(e.message, /combined base for backend differs from the approved plan/);
    return true;
  });
  assert.deepEqual(state.repos, {});
  assert.deepEqual(worktrees(checkout), before);
  assert.equal(existsSync(join(dir, 'trees', 'backend')), false);
});

test('when moving the new worktree onto the combined tree fails, the worktree is removed before the error is rethrown', () => {
  const { checkout, base } = divergedPulls();
  const before = worktrees(checkout);
  const dir = runDirFor();
  const failing = (args, opts) => {
    if (args[0] === 'read-tree') throw new Error('git read-tree failed (128): simulated');
    return git(args, opts);
  };
  assert.throws(() => openTree(failing, respikeState(base), { repoDir: 'backend', repo: repoConfig({ checkout }), dir }), /simulated/);
  assert.deepEqual(worktrees(checkout), before);
  assert.equal(existsSync(join(dir, 'trees', 'backend')), false);
});

test('a combine tree whose setup failed is retried with the combined files in place', () => {
  const { checkout, tree, base } = divergedPulls();
  const dir = runDirFor();
  const state = respikeState(base);
  const config = repoConfig({ checkout, setup: [['make', 'deps']] });
  const failing = () => ({ status: 1, stdout: '', stderr: '' });
  assert.throws(() => openTree(git, state, { repoDir: 'backend', repo: config, dir, runSetup: failing }), e => Boolean(e.setup));
  assert.equal(state.repos.backend.status, 'setup');
  const seen = [];
  const passing = (argv, { cwd }) => { seen.push(existsSync(join(cwd, 'eight.txt'))); return { status: 0, stdout: '', stderr: '' }; };
  const repo = openTree(git, state, { repoDir: 'backend', repo: config, dir, runSetup: passing });
  assert.deepEqual(seen, [true]);
  assert.equal(repo.status, 'open');
  assert.equal(repo.baseTree, tree);
});

test('a respike run refuses a tree for a url-only repo with exit 1, telling the user to configure checkout, and clones nothing', () => {
  const { origin } = remoteRepo();
  const dir = runDirFor();
  const state = respikeState({ kind: 'default', ref: 'origin/main', sha: null, card: null, heads: null, tree: null, behind: null });
  assert.throws(() => openTree(git, state, { repoDir: 'web', repo: repoConfig({ url: origin.dir }), dir }), e => {
    assert.equal(e.exitCode, 1);
    assert.match(e.message, /^web has no local checkout; .*Configure `checkout` instead of `url`/);
    return true;
  });
  assert.deepEqual(state.repos, {});
  assert.equal(existsSync(join(dir, 'trees')), false);
});

test('tree in a respike run refuses a url-only repo and run.json gains no entry for it', async () => {
  const { origin } = remoteRepo();
  const fixture = spikeFixture({
    config: config => ({
      ...config,
      repos: { ...config.repos, web: { name: 'web-repo', github: 'acme/web', checkout: null, url: origin.dir, remote: 'origin', defaultBranch: 'main', setup: [] } },
      projects: { [SLUG]: { repos: ['backend', 'web'] } },
    }),
  });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], fixture.deps)).stdout);
  const dir = join(fixture.home, SLUG, 'runs', runId);
  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  state.plan.respike = { bases: {}, replay: {} };
  state.plan.cards['CRM-1'].mode = 'spike';
  writeFileSync(join(dir, 'run.json'), JSON.stringify(state));
  fixture.at('2026-11-10T10:01:00.000Z');
  assert.equal((await run(['next'], fixture.deps)).code, 0);
  const r = await run(['tree', 'web'], fixture.deps);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /web has no local checkout/);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).repos, 'web'), false);
  assert.equal(existsSync(join(dir, 'trees', 'web')), false);
});
