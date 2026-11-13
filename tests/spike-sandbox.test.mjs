import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeGh, fakeSetup, makeBareOrigin, makeRepo, sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const BASIC = new URL('./fixtures/spike/transcripts/basic.jsonl', import.meta.url);

test('makeRepo gives a temp git repo with one commit on main, no remote, a root file and a src dir', () => {
  const repo = makeRepo();
  try {
    assert.ok(repo.dir.startsWith(realpathSync(tmpdir())), repo.dir);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
    assert.equal(repo.git(['rev-list', '--count', 'HEAD']).trim(), '1');
    assert.equal(repo.git(['remote']).trim(), '');
    assert.equal(repo.git(['status', '--porcelain']).trim(), '');
    assert.ok(statSync(join(repo.dir, 'README.md')).isFile());
    assert.ok(statSync(join(repo.dir, 'src')).isDirectory());
  } finally {
    repo.dispose();
  }
  assert.equal(existsSync(repo.dir), false);
});

test('makeRepo writes no git config outside the temp repo: user identity is passed per call', () => {
  const repo = makeRepo();
  try {
    const local = repo.git(['config', '--local', '--list']);
    assert.doesNotMatch(local, /^user\./m);
    assert.equal(repo.git(['log', '-1', '--format=%an <%ae>']).trim(), 't <t@t>');
  } finally {
    repo.dispose();
  }
});

test('makeBareOrigin returns a local bare repo, empty or cloned from a sandbox repo', () => {
  const repo = makeRepo();
  const empty = makeBareOrigin();
  const seeded = makeBareOrigin({ from: repo.dir });
  try {
    for (const origin of [empty, seeded]) {
      assert.equal(sandboxGit(['rev-parse', '--is-bare-repository'], { cwd: origin.dir }).trim(), 'true');
    }
    assert.equal(sandboxGit(['rev-parse', 'refs/heads/main'], { cwd: seeded.dir }).trim(), repo.git(['rev-parse', 'HEAD']).trim());
  } finally {
    for (const r of [repo, empty, seeded]) r.dispose();
  }
});

test('fakeGh and fakeSetup record every argv with its cwd and answer like spawnSync', () => {
  const gh = fakeGh(argv => (argv[1] === 'list' ? '[{"number":1}]' : ''));
  assert.deepEqual(gh.run(['pr', 'list', '--repo', 'acme/x'], { cwd: '/w' }), { status: 0, stdout: '[{"number":1}]', stderr: '' });
  assert.deepEqual(gh.calls, [{ argv: ['pr', 'list', '--repo', 'acme/x'], cwd: '/w' }]);

  const setup = fakeSetup({ 'yarn install': 1 });
  assert.equal(setup.run(['yarn', 'build'], { cwd: '/t' }).status, 0);
  assert.equal(setup.run(['yarn', 'install'], { cwd: '/t' }).status, 1);
  assert.deepEqual(setup.calls.map(c => c.argv.join(' ')), ['yarn build', 'yarn install']);
});

test('the basic transcript fixture holds usage lines with ids and timestamps only', () => {
  const lines = readFileSync(BASIC, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.length >= 4);
  for (const l of lines) {
    assert.match(l.timestamp, /Z$/);
    assert.ok(l.message?.id || l.requestId);
    assert.ok(l.message?.usage);
    assert.equal(l.message.content, undefined);
  }
});
