import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { B, PROJECT_URL, respikeFixture } from './helpers/respike-fixture.mjs';

guardNetwork();

// A checkout whose remote-tracking default branch is behind its origin: before 11-26 the plan judged staleness from the
// ref as it was, so every commit pushed since the last fetch was missed.
const json = r => JSON.parse(r.stdout);
const PICK = [PROJECT_URL, '--cards', B];
const rev = (dir, ref) => sandboxGit(['rev-parse', ref], { cwd: dir }).trim();

// Pushes a commit to the origin's main by path, so the checkout's refs/remotes/origin/main does not see it.
function pushBehindTheCheckout(f) {
  f.repo.git(['checkout', '-q', '-b', 'elsewhere']);
  writeFileSync(join(f.repo.dir, 'other.txt'), 'pushed by someone else\n');
  f.repo.git(['add', '-A']);
  f.repo.git(['commit', '-q', '-m', 'pushed elsewhere']);
  const sha = f.repo.git(['rev-parse', 'HEAD']).trim();
  f.repo.git(['push', '-q', f.origin.dir, 'HEAD:main']);
  f.repo.git(['checkout', '-q', 'main']);
  f.repo.git(['branch', '-q', '-D', 'elsewhere']);
  return sha;
}

test('preflight fetches each configured repo\'s default branch first, moving only the remote-tracking ref, and reports how far it moved', async () => {
  const f = respikeFixture();
  const before = rev(f.repo.dir, 'refs/remotes/origin/main');
  const localMain = rev(f.repo.dir, 'refs/heads/main');
  const pushed = pushBehindTheCheckout(f);
  const r = await f.run('preflight', PICK);
  assert.equal(r.code, 0, r.stderr);
  const plan = json(r);
  assert.deepEqual(plan.fetched, [{ repo: 'backend', remote: 'origin', branch: 'main', from: before, to: pushed, moved: 1 }]);
  assert.equal(rev(f.repo.dir, 'refs/remotes/origin/main'), pushed);
  assert.equal(rev(f.repo.dir, 'refs/heads/main'), localMain);
  assert.ok(f.git.calls.some(c => c.argv.join(' ') === 'fetch -q origin main' && c.cwd === f.repo.dir), f.git.calls.map(c => c.argv.join(' ')).join('\n'));
});

test('a default branch already current is reported as moved 0', async () => {
  const f = respikeFixture();
  const sha = rev(f.repo.dir, 'refs/remotes/origin/main');
  const plan = json(await f.run('preflight', PICK));
  assert.deepEqual(plan.fetched, [{ repo: 'backend', remote: 'origin', branch: 'main', from: sha, to: sha, moved: 0 }]);
});

test('a fetch that fails is a warning naming the repo, and the plan goes on from the ref as it is', async () => {
  const f = respikeFixture();
  const sha = rev(f.repo.dir, 'refs/remotes/origin/main');
  sandboxGit(['remote', 'set-url', 'origin', join(f.scratch, 'no-such-origin')], { cwd: f.repo.dir });
  const r = await f.run('preflight', PICK);
  assert.equal(r.code, 0, r.stderr);
  const plan = json(r);
  assert.equal(plan.action, 'ready');
  assert.equal(plan.fetched[0].to, sha);
  assert.match(plan.fetched[0].error, /fetch/);
  const warning = plan.warnings.find(w => w.code === 'fetch-failed');
  assert.match(warning.message, /backend: could not fetch origin\/main .*the plan reads the ref as it is/);
});

test('begin fetches again, and a plan whose hash still matches begins', async () => {
  const f = respikeFixture();
  pushBehindTheCheckout(f);
  const plan = json(await f.run('preflight', PICK));
  f.git.calls.length = 0;
  f.at('2026-11-10T10:01:00.000Z');
  const begun = await f.run('begin', [...PICK, '--approve', plan.approve]);
  assert.equal(begun.code, 0, begun.stderr);
  assert.ok(f.git.calls.some(c => c.argv.join(' ') === 'fetch -q origin main'));
});

test('the fetch result stays out of the plan hash: a second preflight after the move gives the same hash', async () => {
  const f = respikeFixture();
  pushBehindTheCheckout(f);
  const first = json(await f.run('preflight', PICK));
  const second = json(await f.run('preflight', PICK));
  assert.equal(second.fetched[0].moved, 0);
  assert.equal(second.approve, first.approve);
});
