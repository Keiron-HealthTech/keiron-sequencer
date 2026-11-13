import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appRepo, CARD, FAKE_CHECKOUT, fakeStartFixture, GIT_BRANCH_NAME, HEAD_SHA, startIssue } from './helpers/start-fixture.mjs';

guardNetwork();

const card = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME });
const CHECKS = [['node', 'check.js'], ['node', 'lint.js']];

function recordingSetup(answer = () => ({ status: 0, stdout: 'ok\n', stderr: '' })) {
  const calls = [];
  let running = 0;
  const run = (argv, opts = {}) => {
    calls.push({ argv: [...argv], cwd: opts.cwd, timeoutMs: opts.timeoutMs, overlapping: running > 0 });
    running++;
    try {
      return answer(argv);
    } finally {
      running--;
    }
  };
  return { calls, run };
}

const fixture = (t, { repo = { typecheck: CHECKS, typecheckTimeoutMs: 60000 }, setup = recordingSetup(), git = {} } = {}) => {
  const f = fakeStartFixture({ issues: [card], repos: { app: appRepo(FAKE_CHECKOUT, repo) }, git });
  t.after(f.dispose);
  return Object.assign(f, { setup });
};
const approve = async f => {
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).approve;
};
const baseline = async (f, hash, extra = {}) => f.run(['baseline', CARD, '--approve', hash ?? (await approve(f))], { runSetup: f.setup.run, ...extra });
const logOf = f => join(f.home, 'start', 'logs', 'typecheck-app.log');

test('baseline without --approve is a usage error with no setup, git or Linear call', async t => {
  const f = fixture(t);
  const r = await f.run(['baseline', CARD], { runSetup: f.setup.run });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: node scripts\/start\.mjs baseline <CARD> --approve <hash>/);
  assert.deepEqual([f.setup.calls.length, f.git.calls.length, f.linear.sent.length], [0, 0, 0]);
});

test('baseline with a hash that no longer matches is refused, exit 5, running no command', async t => {
  const f = fixture(t);
  await approve(f);
  const r = await baseline(f, 'f'.repeat(12));
  assert.equal(r.code, 5);
  assert.equal(f.setup.calls.length, 0);
});

test('baseline runs each typecheck argv in order, one at a time, with the timeout, from the top of the checkout', async t => {
  const f = fixture(t);
  const hash = await approve(f);
  const r = await baseline(f, hash, { cwd: `${FAKE_CHECKOUT}/src` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.setup.calls.map(c => [c.argv, c.cwd, c.timeoutMs, c.overlapping]), CHECKS.map(argv => [argv, FAKE_CHECKOUT, 60000, false]));
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.repo, out.configured, out.log], ['app', true, logOf(f)]);
  assert.deepEqual(out.commands, CHECKS.map(argv => ({ argv, status: 0 })));
});

test('errors found are a baseline, not a failure: a non-zero status is reported and still exit 0', async t => {
  const setup = recordingSetup(argv => (argv[1] === 'check.js' ? { status: 2, stdout: 'src/a.js: 3 errors\n', stderr: '' } : { status: 0, stdout: '', stderr: '' }));
  const f = fixture(t, { setup });
  const r = await baseline(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).commands.map(c => c.status), [2, 0]);
});

test('a command that cannot run or times out is reported with its error, and the next one still runs', async t => {
  const setup = recordingSetup(argv => {
    if (argv[1] === 'check.js') throw Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return { status: 0, stdout: '', stderr: '' };
  });
  const f = fixture(t, { setup });
  const r = await baseline(f);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.commands, [{ argv: CHECKS[0], status: null, error: 'spawnSync node ETIMEDOUT' }, { argv: CHECKS[1], status: 0 }]);
  assert.match(readFileSync(out.log, 'utf8'), /ETIMEDOUT/);
});

test('output is appended to the log under the home, and the tail is the last 40 lines of this run', async t => {
  const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const setup = recordingSetup(argv => ({ status: argv[1] === 'check.js' ? 1 : 0, stdout: argv[1] === 'check.js' ? `${many}\n` : 'clean\n', stderr: argv[1] === 'lint.js' ? 'warn\n' : '' }));
  const f = fixture(t, { setup });
  const hash = await approve(f);
  await baseline(f, hash);
  const out = JSON.parse((await baseline(f, hash)).stdout);
  const log = readFileSync(logOf(f), 'utf8');
  assert.equal(log.split('line 50\n').length - 1, 2, 'both runs are in the log');
  const tail = out.tail.split('\n');
  assert.equal(tail.length, 40);
  assert.deepEqual(tail.slice(-3), ['clean', 'warn', 'exit 0']);
  assert.ok(log.endsWith(`${out.tail}\n`));
  assert.ok(!existsSync(join(f.home, 'start', 'runs')), 'no runs/ dir under start');
});

test('a repo with no typecheck configured reports configured: false, runs nothing and writes no log', async t => {
  const f = fixture(t, { repo: {} });
  const r = await baseline(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { repo: 'app', configured: false, commands: [], log: null, tail: '' });
  assert.equal(f.setup.calls.length, 0);
  assert.ok(!existsSync(join(f.home, 'start')));
});

test('baseline runs with the nextApprove a branch run returned', async t => {
  const state = { current: 'main', local: ['main'] };
  const git = {
    'rev-parse': argv => (argv.includes('--abbrev-ref') ? `${state.current}\n` : `${FAKE_CHECKOUT}\n.git\n${HEAD_SHA}\n`),
    'for-each-ref': () => [...state.local.map(b => `refs/heads/${b}`), 'refs/remotes/origin/main'].map(r => `${HEAD_SHA} ${r}\n`).join(''),
    'worktree list': () => `worktree ${FAKE_CHECKOUT}\nHEAD ${HEAD_SHA}\nbranch refs/heads/${state.current}\n\n`,
    checkout: argv => { state.local.push(argv[2]); state.current = argv[2]; return ''; },
  };
  const f = fixture(t, { git });
  const hash = await approve(f);
  const branched = JSON.parse((await f.run(['branch', CARD, '--approve', hash])).stdout);
  assert.notEqual(branched.nextApprove, hash);
  assert.equal((await baseline(f, hash)).code, 5);
  const r = await baseline(f, branched.nextApprove);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.setup.calls.length, CHECKS.length);
});

test('a home inside a git work tree is refused before any command runs, exit 1', async t => {
  const f = fixture(t);
  const repo = makeRepo();
  t.after(repo.dispose);
  const home = join(repo.dir, 'keiron-sequencer-home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), readFileSync(join(f.home, 'config.json')));
  const hash = JSON.parse((await f.run(['plan', CARD], { home })).stdout).approve;
  const r = await baseline(f, hash, { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /inside the git work tree/);
  assert.equal(f.setup.calls.length, 0);
});
