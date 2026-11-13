import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGit, fakeGitHub, readOnlySubcommands, subcommandOf } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

test('fakeGit records argv, cwd and the extra env of every call, and answers by subcommand', () => {
  const git = fakeGit({ 'rev-parse': 'abc\n', 'worktree list': argv => `listed ${argv.at(-1)}\n` });
  assert.equal(git.run(['rev-parse', 'HEAD'], { cwd: '/fake/checkout' }), 'abc\n');
  assert.equal(git.run(['worktree', 'list', '--porcelain'], { cwd: '/fake/checkout', env: { GIT_OPTIONAL_LOCKS: '0' } }), 'listed --porcelain\n');
  assert.deepEqual(git.calls.map(c => [c.sub, c.argv, c.cwd, c.env.GIT_OPTIONAL_LOCKS]), [
    ['rev-parse', ['rev-parse', 'HEAD'], '/fake/checkout', undefined],
    ['worktree list', ['worktree', 'list', '--porcelain'], '/fake/checkout', '0'],
  ]);
});

test('fakeGit throws like the real runner on a non-zero answer or a subcommand it has no answer for', () => {
  const git = fakeGit({ 'rev-list': { status: 128, stderr: 'bad revision' } });
  assert.throws(() => git.run(['rev-list', '--count', 'a..b'], { cwd: '/c' }), /git rev-list failed \(128\): bad revision/);
  assert.throws(() => git.run(['log'], { cwd: '/c' }), /git log failed .*no answer for log/);
  assert.equal(git.calls.length, 2);
});

test('fakeGit keeps the real deny-list: a commit is refused before it is recorded', () => {
  const git = fakeGit({ commit: '' });
  assert.throws(() => git.run(['commit', '-m', 'x'], { cwd: '/c' }), /never run/);
  assert.deepEqual(git.calls, []);
});

test('subcommandOf skips global options, and the read-only list names what a plan may run', () => {
  assert.equal(subcommandOf(['--literal-pathspecs', 'log', '--since=x']), 'log');
  assert.equal(subcommandOf(['-c', 'core.x=1', 'status', '--porcelain']), 'status');
  assert.equal(subcommandOf(['worktree', 'list', '--porcelain']), 'worktree list');
  assert.deepEqual(readOnlySubcommands, ['rev-parse', 'remote', 'status', 'for-each-ref', 'worktree list', 'ls-remote', 'log', 'rev-list']);
});

test('fakeGitHub answers through the real gh allowlist and reports a non-zero status instead of throwing', () => {
  const gh = fakeGitHub(argv => (argv[1] === 'view' ? { status: 1, stderr: 'not found' } : '[]'));
  assert.deepEqual(gh.run(['pr', 'list', '--repo', 'acme/app'], { cwd: '/c' }), { status: 0, stdout: '[]', stderr: '' });
  assert.deepEqual(gh.run(['pr', 'view', '7'], { cwd: '/c' }), { status: 1, stdout: '', stderr: 'not found' });
  assert.throws(() => gh.run(['pr', 'create'], { cwd: '/c' }), /never run/);
  assert.deepEqual(gh.calls.map(c => c.argv.slice(0, 2).join(' ')), ['pr list', 'pr view']);
});
