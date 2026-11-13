import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { currentCheckout, refContains, remoteHeads } from '../scripts/lib/start/checkout.mjs';
import { sandboxGit, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, startFixture } from './helpers/start-fixture.mjs';

guardNetwork();

const fixture = t => {
  const f = startFixture();
  t.after(f.dispose);
  return f;
};
const commitOn = (f, branch, file) => {
  f.repo.git(['checkout', '-q', '-b', branch]);
  writeFileSync(join(f.repo.dir, file), `${file}\n`);
  f.repo.git(['add', '-A']);
  f.repo.git(['commit', '-q', '-m', file]);
};
const originGit = (f, args) => sandboxGit(['--git-dir', f.origin.dir, ...args]);

test('on real git, the top branch contains the one below it and not the reverse; a stale tracking ref cannot decide', t => {
  const f = fixture(t);
  commitOn(f, 'a', 'a.txt');
  commitOn(f, 'b', 'b.txt');
  f.repo.git(['push', '-q', 'origin', 'a', 'b']);
  f.repo.git(['checkout', '-q', 'main']);
  const git = gitRunner({ env: SANDBOX_ENV });
  const cwd = f.repo.dir;
  const read = () => {
    const checkout = currentCheckout(git, f.config, cwd);
    return refContains(git, { cwd, remote: 'origin', tracking: checkout.tracking, heads: remoteHeads(git, { cwd, remote: 'origin' }) });
  };
  const contains = read();
  assert.equal(contains({ headRefName: 'b' }, { headRefName: 'a' }), true);
  assert.equal(contains({ headRefName: 'a' }, { headRefName: 'b' }), false);
  originGit(f, ['update-ref', 'refs/heads/a', originGit(f, ['rev-parse', 'refs/heads/b']).trim()]);
  assert.equal(read()({ headRefName: 'b' }, { headRefName: 'a' }), null);
});

test('on real git, a local branch, a remote-only branch and a branch in another worktree of the card all resume', async t => {
  const f = fixture(t);
  f.repo.git(['branch', 'abc-1-wip']);
  originGit(f, ['update-ref', 'refs/heads/user/abc-1-remote', originGit(f, ['rev-parse', 'refs/heads/main']).trim()]);
  const parent = tempDir('keiron-sequencer-start-wt-');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  f.repo.git(['worktree', 'add', '-q', '-b', 'abc-1-wt', join(parent, 'wt')]);
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'resume');
  assert.deepEqual(out.resume.branches, [
    { name: 'abc-1-wip', where: 'local', path: null },
    { name: 'abc-1-wt', where: 'worktree', path: join(parent, 'wt') },
    { name: 'user/abc-1-remote', where: 'remote', path: null },
  ]);
  assert.equal(out.resume.remote, 'ok');
});
