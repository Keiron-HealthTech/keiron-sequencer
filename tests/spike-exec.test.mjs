import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghRunner, gitRunner, setupRunner } from '../scripts/lib/spike/exec.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPIKE_FILES = globSync(['scripts/spike.mjs', 'scripts/lib/spike/*.mjs'], { cwd: ROOT }).sort();
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const recordingSpawn = () => {
  const spawned = [];
  const spawn = (bin, args, opts) => { spawned.push({ bin, args, opts }); return { status: 0, stdout: 'out', stderr: '' }; };
  return { spawned, spawn };
};

test('the git runner refuses commit, push, tag and remote set-url wherever the subcommand sits, without spawning', () => {
  const { spawned, spawn } = recordingSpawn();
  const git = gitRunner({ spawn });
  const refused = [
    ['commit', '-m', 'x'],
    ['push'],
    ['tag', 'v1'],
    ['-C', '/some/tree', 'commit', '-m', 'x'],
    ['-c', 'k=v', 'push', 'origin', 'main'],
    ['-c', 'user.name=t', '-C', '/t', 'tag', 'v1'],
    ['--git-dir=/t/.git', 'commit'],
    ['--git-dir', '/t/.git', '--work-tree', '/t', 'push'],
    ['--no-pager', '-p', 'tag'],
    ['remote', 'set-url', 'origin', 'https://example.invalid/x'],
    ['-C', '/t', 'remote', '-v', 'set-url', '--push', 'origin', 'x'],
  ];
  for (const args of refused) assert.throws(() => git(args), /is never run by the spike/, args.join(' '));
  assert.deepEqual(spawned, []);
});

test('the git runner lets every other subcommand through, even when an option value or a later argument says commit or push', () => {
  const { spawned, spawn } = recordingSpawn();
  const git = gitRunner({ spawn });
  const allowed = [
    ['status'],
    ['-C', '/t', 'status'],
    ['-c', 'commit.gpgsign=false', 'write-tree'],
    ['-c', 'push.default=nothing', 'diff', '--binary', 'a', 'b'],
    ['log', '--grep', 'commit'],
    ['remote', '-v'],
    ['remote', 'get-url', 'origin'],
    ['worktree', 'add', '--detach', '/t/trees/x', 'abc'],
  ];
  for (const args of allowed) assert.equal(git(args), 'out', args.join(' '));
  assert.deepEqual(spawned.map(s => s.args), allowed);
  assert.ok(spawned.every(s => s.bin === 'git'));
});

test('the git runner lays a per-call env over its own, leaving later calls unchanged', () => {
  const { spawned, spawn } = recordingSpawn();
  const git = gitRunner({ spawn, env: { A: '1', B: '2' } });
  git(['write-tree'], { cwd: '/t', env: { B: '3', GIT_INDEX_FILE: '/run/tmp.index' } });
  git(['write-tree'], { cwd: '/t' });
  assert.deepEqual(spawned.map(s => s.opts.env), [{ A: '1', B: '3', GIT_INDEX_FILE: '/run/tmp.index' }, { A: '1', B: '2' }]);
});

test('the default gh runner only runs pr list, pr view and pr diff', () => {
  const { spawned, spawn } = recordingSpawn();
  const gh = ghRunner({ spawn });
  for (const argv of [['pr', 'create'], ['pr', 'merge', '1'], ['api', 'graphql'], ['repo', 'clone', 'x'], ['pr']]) {
    assert.throws(() => gh(argv), /is never run by the spike/, argv.join(' '));
  }
  assert.deepEqual(spawned, []);
  for (const argv of [['pr', 'list', '--repo', 'a/b'], ['pr', 'view', '1'], ['pr', 'diff', '1']]) {
    assert.deepEqual(gh(argv, { cwd: '/w' }), { status: 0, stdout: 'out', stderr: '' });
  }
  assert.deepEqual(spawned.map(s => [s.bin, s.args.join(' '), s.opts.cwd]), [
    ['gh', 'pr list --repo a/b', '/w'], ['gh', 'pr view 1', '/w'], ['gh', 'pr diff 1', '/w'],
  ]);
});

test('the default setup runner spawns one argv array with no shell and refuses anything else', () => {
  const { spawned, spawn } = recordingSpawn();
  const runSetup = setupRunner({ spawn });
  for (const argv of [[], 'yarn install', [''], [1]]) assert.throws(() => runSetup(argv, { cwd: '/t' }), /argv array/);
  assert.deepEqual(runSetup(['corepack', 'yarn', 'install'], { cwd: '/t', timeoutMs: 5000 }), { status: 0, stdout: 'out', stderr: '' });
  assert.equal(spawned.length, 1);
  assert.deepEqual([spawned[0].bin, spawned[0].args], ['corepack', ['yarn', 'install']]);
  assert.equal(spawned[0].opts.shell, false);
  assert.equal(spawned[0].opts.cwd, '/t');
  assert.equal(spawned[0].opts.timeout, 5000);
});

test('with a child pid file the setup runner records the pid of the command itself, which replaces the shell that wrote it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keiron-sequencer-child-'));
  try {
    const file = join(dir, 'slot with space.lock.child');
    const r = setupRunner()(['sh', '-c', 'echo $$'], { cwd: dir, childPidFile: file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(file, 'utf8').trim(), r.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the git runner refuses a command-line alias, which could rename a refused subcommand', () => {
  const { spawned, spawn } = recordingSpawn();
  const git = gitRunner({ spawn });
  for (const args of [['-c', 'alias.save=commit', 'save'], ['--config-env=alias.save=X', 'save'], ['--config-env', 'alias.save=X', 'save']]) {
    assert.throws(() => git(args), /is never run by the spike/, args.join(' '));
  }
  assert.deepEqual(spawned, []);
});

test('static: only exec.mjs spawns, and no spike module names a refused git subcommand, linear-write or the key file', () => {
  assert.ok(SPIKE_FILES.includes('scripts/spike.mjs'));
  assert.ok(SPIKE_FILES.includes('scripts/lib/spike/exec.mjs'));
  assert.ok(SPIKE_FILES.length >= 9, SPIKE_FILES.join(', '));
  for (const file of SPIKE_FILES) {
    const text = source(file);
    assert.doesNotMatch(text, /linear-write/, `${file} imports linear-write`);
    assert.doesNotMatch(text, /linear\.key|keiron-planner/, `${file} names the key file`);
    if (basename(file) === 'exec.mjs') continue;
    assert.doesNotMatch(text, /child_process|\bspawn(Sync)?\(|\bexec(File)?(Sync)?\(/, `${file} spawns outside exec.mjs`);
    assert.doesNotMatch(text, /(['"`])(commit|push|tag|set-url)\1/, `${file} names a refused git subcommand`);
    assert.doesNotMatch(text, /alias\./, `${file} passes a git alias`);
  }
});

test('static: exec.mjs spawns only git, gh, and a setup argv with no shell', () => {
  const text = source('scripts/lib/spike/exec.mjs');
  const spawns = [...text.matchAll(/\bspawn\(([^,]+),/g)].map(m => m[1].trim());
  assert.deepEqual(spawns.sort(), ["'gh'", "'git'", 'argv[0]']);
  assert.match(text, /shell: false/);
});
