import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import * as detect from '../scripts/lib/spike/config-detect.mjs';
import * as sandbox from './helpers/git-sandbox.mjs';
import { makeBareOrigin, makeRepo, SANDBOX_ENV, sandboxGit, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { checkoutUnder } from './helpers/respike-fixture.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-config-detect-');
const seed = makeRepo();
const origin = makeBareOrigin({ from: seed.dir });
after(() => {
  rmSync(DIR, { recursive: true, force: true });
  seed.dispose();
  origin.dispose();
});

// Every detection call in this file goes through one recorder, so the last test can check the whole set.
const runner = gitRunner({ env: SANDBOX_ENV });
const seen = [];
const git = (args, opts = {}) => {
  seen.push([...args]);
  return runner(args, opts);
};

let dirs = 0;
const freshDir = name => {
  const dir = join(DIR, `${name}-${++dirs}`);
  mkdirSync(dir);
  return dir;
};
const clone = (root, name, remoteUrl = `https://github.com/acme/${name.toLowerCase()}.git`, head) =>
  checkoutUnder(root, name, { from: origin.dir, remoteUrl, head });
const corrupt = (root, name) => {
  mkdirSync(join(root, name, '.git'), { recursive: true });
  writeFileSync(join(root, name, '.git', 'HEAD'), 'not a ref\n');
};
const names = list => list.map(c => c.basename);

test('a main checkout under a root is a candidate; a linked checkout is listed apart; plain folders and files are ignored', () => {
  const root = freshDir('root');
  const app = clone(root, 'app');
  sandboxGit(['worktree', 'add', '-q', '-b', 'side', join(root, 'app-linked')], { cwd: app });
  mkdirSync(join(root, 'plain'));
  writeFileSync(join(root, 'notes.txt'), 'x\n');
  const scan = detect.scanRoots(git, [root]);
  assert.deepEqual(names(scan.candidates), ['app']);
  assert.equal(scan.candidates[0].path, app);
  assert.deepEqual(scan.linked.map(c => [c.basename, c.path]), [['app-linked', join(root, 'app-linked')]]);
  assert.deepEqual(scan.missingRoots, []);
  assert.deepEqual(scan.skipped, []);
});

test('a symlink to a checkout counts, and a root that is itself a repo is not a candidate', () => {
  const elsewhere = freshDir('elsewhere');
  const real = clone(elsewhere, 'app');
  const root = freshDir('root');
  sandboxGit(['init', '-q', '-b', 'main', root]);
  symlinkSync(real, join(root, 'linked-name'));
  const scan = detect.scanRoots(git, [root]);
  assert.deepEqual(names(scan.candidates), ['linked-name']);
  assert.equal(scan.candidates[0].path, join(root, 'linked-name'));
});

test('a missing root is listed apart and the other roots are still scanned', () => {
  const root = freshDir('root');
  clone(root, 'app');
  const gone = join(DIR, 'no-such-root');
  const scan = detect.scanRoots(git, [gone, root]);
  assert.deepEqual(scan.missingRoots, [gone]);
  assert.deepEqual(names(scan.candidates), ['app']);
});

test('a corrupt .git directory is skipped with a fixed reason and its good sibling is kept', () => {
  const root = freshDir('root');
  corrupt(root, 'broken');
  clone(root, 'good');
  const scan = detect.scanRoots(git, [root]);
  assert.deepEqual(names(scan.candidates), ['good']);
  assert.deepEqual(scan.skipped, [{ path: join(root, 'broken'), basename: 'broken', reason: 'git could not read its remotes' }]);
});

test('a corrupt checkout inside a root that sits in another repo is never read as that repo', () => {
  const outer = makeRepo();
  after(outer.dispose);
  outer.git(['remote', 'add', 'origin', 'https://github.com/acme/outer.git']);
  const root = join(outer.dir, 'checkouts');
  mkdirSync(root);
  corrupt(root, 'broken');
  const scan = detect.scanRoots(git, [root]);
  assert.deepEqual(scan.candidates, []);
  assert.deepEqual(names(scan.skipped), ['broken']);
});

test('the detection module names no linked-checkout subcommand', () => {
  const source = readFileSync(new URL('../scripts/lib/spike/config-detect.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"`]worktree/);
});

const SECRET = ['planted', 'credential', 'value'].join('_');

test('every GitHub URL form reads as lowercase owner/name, with or without .git or credentials', () => {
  const root = freshDir('root');
  const dir = clone(root, 'name');
  const forms = [
    'https://github.com/Owner/Name.git',
    'https://github.com/owner/name',
    `https://x-token:${SECRET}@github.com/owner/name.git`,
    'git@github.com:owner/name.git',
    'ssh://git@github.com/owner/name',
  ];
  for (const url of forms) {
    sandboxGit(['remote', 'set-url', 'origin', url], { cwd: dir });
    const read = detect.readRemotes(git, dir);
    assert.deepEqual(read, { remotes: { origin: 'owner/name' }, reason: null }, url);
    assert.ok(!JSON.stringify(read).includes(SECRET));
  }
});

test('a remote that is not on GitHub reads as null, and a checkout with no remote has none', () => {
  const root = freshDir('root');
  const dir = clone(root, 'app', 'https://gitlab.com/owner/app.git');
  sandboxGit(['remote', 'add', 'local', origin.dir], { cwd: dir });
  assert.deepEqual(detect.readRemotes(git, dir), { remotes: { local: null, origin: null }, reason: null });
  sandboxGit(['remote', 'remove', 'origin'], { cwd: dir });
  sandboxGit(['remote', 'remove', 'local'], { cwd: dir });
  assert.deepEqual(detect.readRemotes(git, dir), { remotes: {}, reason: null });
});

test('a credential in a remote URL never reaches a scan result', () => {
  const root = freshDir('root');
  clone(root, 'app', `https://x-token:${SECRET}@github.com/acme/app.git`);
  const scan = detect.scanRoots(git, [root]);
  assert.deepEqual(scan.candidates[0].remotes, { origin: 'acme/app' });
  assert.ok(!JSON.stringify(scan).includes(SECRET));
});

test('a remote URL carrying anything past owner/name is not read as a GitHub repo, so no query or fragment leaks', () => {
  const root = freshDir('root');
  const dir = clone(root, 'app');
  const secret = SECRET.toLowerCase();
  for (const url of [`https://github.com/acme/app.git?token=${secret}`, `https://github.com/acme/app#${secret}`, `git@github.com:acme/app.git?x=${secret}`]) {
    sandboxGit(['remote', 'set-url', 'origin', url], { cwd: dir });
    const read = detect.readRemotes(git, dir);
    assert.deepEqual(read, { remotes: { origin: null }, reason: null }, url);
    assert.ok(!JSON.stringify(read).includes(secret));
  }
});

test('a git error that quotes a credential gives a fixed reason and never its text', () => {
  const root = freshDir('root');
  clone(root, 'app');
  const leaky = () => {
    throw new Error(`git remote failed (128): fatal: https://x-token:${SECRET}@github.com/acme/app.git`);
  };
  const read = detect.readRemotes(leaky, join(root, 'app'));
  assert.deepEqual(read, { remotes: null, reason: 'git could not read its remotes' });
  const scan = detect.scanRoots(leaky, [root]);
  assert.deepEqual(scan.candidates, []);
  assert.deepEqual(names(scan.skipped), ['app']);
  assert.ok(!JSON.stringify([read, scan]).includes(SECRET));
});

const paths = list => list.map(c => c.path);
const noUrl = value => assert.doesNotMatch(JSON.stringify(value), /:\/\/|@|github\.com/);

test('a folder named like the repo, in any case, is the pick even when its origin points at an unrelated repo', () => {
  const root = freshDir('root');
  const dir = clone(root, 'Web-App', 'https://github.com/acme/unrelated.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web-app'], github: 'acme/web-app' });
  assert.equal(match.pick.path, dir);
  assert.equal(match.via, 'folder');
  assert.deepEqual(match.ambiguous, []);
});

test('a folder named like the config key matches without the origin fallback', () => {
  const root = freshDir('root');
  const dir = clone(root, 'backend', 'https://github.com/acme/unrelated.git');
  clone(root, 'elsewhere', 'https://github.com/acme/backend.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['backend', 'backend-repo'], github: 'acme/backend' });
  assert.equal(match.pick.path, dir);
  assert.equal(match.via, 'folder');
});

test('a folder named like the entry name matches as well as one named like the key', () => {
  const root = freshDir('root');
  const dir = clone(root, 'Backend-Repo', 'https://github.com/acme/unrelated.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['backend', 'backend-repo'], github: null });
  assert.equal(match.pick.path, dir);
  assert.equal(match.via, 'folder');
});

test('a folder named like the key and another named like the entry name are both listed and neither is picked', () => {
  const root = freshDir('root');
  const both = [clone(root, 'backend'), clone(root, 'backend-repo')];
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['backend', 'backend-repo'], github: 'acme/backend' });
  assert.equal(match.pick, null);
  assert.deepEqual(paths(match.ambiguous), both);
});

test('with no folder of that name, a checkout whose origin is the repo is the pick', () => {
  const root = freshDir('root');
  const dir = clone(root, 'other-dir', 'git@github.com:Acme/Web.git');
  clone(root, 'unrelated', 'https://github.com/acme/else.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web'], github: 'acme/web' });
  assert.equal(match.pick.path, dir);
  assert.equal(match.via, 'origin');
});

test('with no github on the entry, the origin fallback compares the repo part of origin with the name', () => {
  const root = freshDir('root');
  const dir = clone(root, 'other-dir', 'https://github.com/someone/Web.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web'], github: null });
  assert.equal(match.pick.path, dir);
  assert.equal(match.via, 'origin');
});

test('with no github on the entry, the origin fallback accepts the repo part matching the config key as well as the entry name', () => {
  const root = freshDir('root');
  const dir = clone(root, 'elsewhere', 'https://github.com/acme/backend.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['backend', 'backend-repo'], github: null });
  assert.equal(match.pick.path, dir);
  assert.equal(match.via, 'origin');
});

test('a checkout whose origin points elsewhere, or that reaches the repo only through another remote, is not the pick', () => {
  const root = freshDir('root');
  clone(root, 'elsewhere', 'https://github.com/acme/else.git');
  const mirror = clone(root, 'mirror', 'https://github.com/acme/else.git');
  sandboxGit(['remote', 'add', 'upstream', 'https://github.com/acme/web.git'], { cwd: mirror });
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web'], github: 'acme/web' });
  assert.deepEqual(match, { pick: null, via: null, ambiguous: [], linked: [] });
});

test('a folder named like the repo wins over another checkout whose origin is the repo', () => {
  const root = freshDir('root');
  const named = clone(root, 'web', 'https://github.com/acme/web.git');
  clone(root, 'other-dir', 'https://github.com/acme/web.git');
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web'], github: 'acme/web' });
  assert.equal(match.pick.path, named);
  assert.equal(match.via, 'folder');
});

test('a linked checkout named like the repo is never the pick, is listed, and the origin fallback picks the main checkout', () => {
  const root = freshDir('root');
  const main = clone(root, 'other-dir', 'https://github.com/acme/web.git');
  sandboxGit(['worktree', 'add', '-q', '-b', 'side', join(root, 'web')], { cwd: main });
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web'], github: 'acme/web' });
  assert.equal(match.pick.path, main);
  assert.equal(match.via, 'origin');
  assert.deepEqual(paths(match.linked), [join(root, 'web')]);
});

test('same-named checkouts in two roots are listed with both paths and no URL, and neither is picked', () => {
  const [a, b] = [freshDir('root'), freshDir('root')];
  const both = [clone(a, 'web', `https://x-token:${SECRET}@github.com/acme/web.git`), clone(b, 'web')];
  const match = detect.matchCandidates(detect.scanRoots(git, [a, b]), { names: ['web'], github: 'acme/web' });
  assert.equal(match.pick, null);
  assert.equal(match.via, 'folder');
  assert.deepEqual(paths(match.ambiguous), both);
  noUrl(match);
});

test('two origin matches with no folder of that name are listed with both paths, and neither is picked', () => {
  const root = freshDir('root');
  const both = [clone(root, 'copy-a', 'https://github.com/acme/web.git'), clone(root, 'copy-b', 'git@github.com:acme/web.git')];
  const match = detect.matchCandidates(detect.scanRoots(git, [root]), { names: ['web'], github: 'acme/web' });
  assert.equal(match.pick, null);
  assert.equal(match.via, 'origin');
  assert.deepEqual(paths(match.ambiguous), both);
  noUrl(match);
});

test('the remote comes from origin when origin is on GitHub, else from the single GitHub remote, never from fork logic', () => {
  const at = remotes => detect.remoteOf({ path: '/x', basename: 'x', remotes });
  assert.deepEqual(at({ origin: 'acme/web', upstream: 'upstream-org/web' }), { remote: 'origin', github: 'acme/web', reason: null });
  assert.deepEqual(at({ mine: 'acme/web' }), { remote: 'mine', github: 'acme/web', reason: null });
  assert.deepEqual(at({ origin: null, mine: 'acme/web' }), { remote: 'mine', github: 'acme/web', reason: null });
  assert.deepEqual(at({ fork: 'me/web', upstream: 'acme/web' }), { remote: null, github: null, reason: 'several GitHub remotes and no origin: fork, upstream' });
  assert.deepEqual(at({ origin: null }), { remote: null, github: null, reason: 'no GitHub remote' });
  assert.deepEqual(at({}), { remote: null, github: null, reason: 'no GitHub remote' });
});

test('two gaps on one checkout: the first dir keeps it, the second is told it is the same checkout', () => {
  const pick = { path: '/roots/web', basename: 'web', remotes: { origin: 'acme/web' } };
  const other = { path: '/roots/api', basename: 'api', remotes: { origin: 'acme/api' } };
  const found = (p, via) => ({ pick: p, via, ambiguous: [], linked: [] });
  const claimed = detect.claimCheckouts({ web: found(pick, 'origin'), api: found(other, 'folder'), frontend: found(pick, 'folder') });
  assert.equal(claimed.frontend.pick, pick);
  assert.equal(claimed.api.pick, other);
  assert.deepEqual(claimed.web, { pick: null, via: null, ambiguous: [], linked: [], sameAs: 'frontend', reason: 'same checkout as repos.frontend' });
});

test('the default branch comes from the chosen remote HEAD, with the remote name stripped', () => {
  seed.git(['push', '-q', origin.dir, 'main:refs/heads/develop']);
  const root = freshDir('root');
  const dir = clone(root, 'app', 'https://github.com/acme/app.git', 'develop');
  assert.deepEqual(detect.originHead(git, dir, 'origin'), { branch: 'develop', reason: null });
  sandboxGit(['remote', 'add', 'mine', 'https://github.com/acme/app.git'], { cwd: dir });
  sandboxGit(['symbolic-ref', 'refs/remotes/mine/HEAD', 'refs/remotes/mine/trunk'], { cwd: dir });
  assert.deepEqual(detect.originHead(git, dir, 'mine'), { branch: 'trunk', reason: null });
});

test('an unset remote HEAD is left unfilled with that reason, and git is never asked to set it', () => {
  const root = freshDir('root');
  const dir = clone(root, 'app', 'https://github.com/acme/app.git', null);
  const before = seen.length;
  assert.deepEqual(detect.originHead(git, dir, 'origin'), { branch: null, reason: 'refs/remotes/origin/HEAD is not set' });
  assert.deepEqual(seen.slice(before).map(argv => argv[0]), ['symbolic-ref']);
});

test('with no remote the default branch needs one, and git is not called', () => {
  const root = freshDir('root');
  const dir = clone(root, 'app');
  const before = seen.length;
  assert.deepEqual(detect.originHead(git, dir, null), { branch: null, reason: 'needs a remote' });
  assert.equal(seen.length, before);
});

test('a git error reading the remote HEAD gives the fixed reason and never its text', () => {
  const leaky = () => {
    throw new Error(`git symbolic-ref failed (128): https://x-token:${SECRET}@github.com/acme/app.git`);
  };
  const head = detect.originHead(leaky, freshDir('app'), 'origin');
  assert.deepEqual(head, { branch: null, reason: 'refs/remotes/origin/HEAD is not set' });
});

test('over every detection call in this file, git was asked only for remote -v and symbolic-ref', () => {
  assert.ok(seen.length > 10, `${seen.length} calls`);
  const asked = new Set(seen.map(argv => (argv[0] === 'remote' ? argv.join(' ') : argv[0])));
  assert.deepEqual([...asked].sort(), ['remote -v', 'symbolic-ref']);
});

test('a tool the fake answers for is present', () => {
  const tools = sandbox.fakeTools({ npm: '10.8.1' });
  assert.equal(detect.probeTool(tools.run, 'npm', { cwd: DIR }).present, true);
});

test('the fake tools answer like spawnSync: a version is status 0, null is status 1, a tool left out throws ENOENT', () => {
  const tools = sandbox.fakeTools({ npm: '10.8.1', yarn: null });
  assert.deepEqual(tools.run(['npm', '--version'], { cwd: DIR }), { status: 0, stdout: '10.8.1\n', stderr: '' });
  assert.deepEqual(tools.run(['yarn', '--version']), { status: 1, stdout: '', stderr: '' });
  assert.throws(() => tools.run(['go', 'version']), { code: 'ENOENT' });
  assert.deepEqual(tools.calls.map(c => c.argv), [['npm', '--version'], ['yarn', '--version'], ['go', 'version']]);
});

test('a probe reads the version and its major, and treats a missing tool as absent', () => {
  const tools = sandbox.fakeTools({ npm: '10.8.1', yarn: '1.22.22', corepack: null, go: 'go version go1.22.1 darwin/arm64' });
  const probe = tool => detect.probeTool(tools.run, tool, { cwd: DIR });
  assert.deepEqual(probe('npm'), { present: true, version: '10.8.1', major: 10 });
  assert.deepEqual(probe('yarn'), { present: true, version: '1.22.22', major: 1 });
  assert.deepEqual(probe('corepack'), { present: true, version: null, major: null });
  assert.deepEqual(probe('pnpm'), { present: false, version: null, major: null });
  assert.equal(probe('go').present, true);
  assert.deepEqual(tools.calls.map(c => c.argv), ['npm', 'yarn', 'corepack', 'pnpm', 'go'].map(t => detect.VERSION_ARGV[t]));
  assert.deepEqual(detect.VERSION_ARGV.go, ['go', 'version']);
  assert.ok(tools.calls.every(c => c.cwd === DIR));
});

test('a probe that fails for another reason than a missing tool reads as present with no version', () => {
  const hung = () => {
    throw Object.assign(new Error('spawnSync yarn ETIMEDOUT'), { code: 'ETIMEDOUT' });
  };
  assert.deepEqual(detect.probeTool(hung, 'yarn', { cwd: DIR }), { present: true, version: null, major: null });
});

test('a prober asks each tool at most once and only with its version argv', () => {
  const tools = sandbox.fakeTools({ yarn: '4.1.0' });
  const probe = detect.toolProber(tools.run, { cwd: DIR });
  for (const tool of ['yarn', 'corepack', 'yarn', 'corepack', 'yarn']) probe(tool);
  assert.deepEqual(probe('yarn'), { present: true, version: '4.1.0', major: 4 });
  assert.deepEqual(tools.calls.map(c => c.argv), [detect.VERSION_ARGV.yarn, detect.VERSION_ARGV.corepack]);
});

const BERRY_LOCK = '# This file is generated by running "yarn install" inside your project.\n\n__metadata:\n  version: 8\n';
const CLASSIC_LOCK = '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n';
const repoWith = files => {
  const dir = freshDir('eco');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
const manifest = fields => JSON.stringify({ name: 'app', ...fields });

test('the ecosystem comes from a recognized packageManager first, then a single lockfile, then go.mod', () => {
  const cases = [
    [{ 'package.json': manifest({ packageManager: 'yarn@4.1.0' }), 'yarn.lock': BERRY_LOCK }, 'yarn-berry', 4],
    [{ 'package.json': manifest({ packageManager: 'yarn@3.6.4+sha512.abc' }), 'yarn.lock': CLASSIC_LOCK }, 'yarn-berry', 3],
    [{ 'package.json': manifest({ packageManager: 'yarn@1.22.22' }), 'yarn.lock': CLASSIC_LOCK }, 'yarn-classic', 1],
    [{ 'package.json': manifest({ packageManager: 'npm@10.8.1' }) }, 'npm', 10],
    [{ 'package.json': manifest({ packageManager: 'pnpm@9.1.0' }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'pnpm', 9],
    [{ 'package.json': manifest({}), 'yarn.lock': BERRY_LOCK }, 'yarn-berry', null],
    [{ 'package.json': manifest({}), 'yarn.lock': CLASSIC_LOCK }, 'yarn-classic', null],
    [{ 'package.json': manifest({}), 'package-lock.json': '{}' }, 'npm', null],
    [{ 'package.json': manifest({}), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'pnpm', null],
    [{ 'package.json': '{ not json', 'package-lock.json': '{}' }, 'npm', null],
    [{ 'go.mod': 'module example.com/app\n' }, 'go', null],
  ];
  for (const [files, ecosystem, declaredMajor] of cases) {
    assert.deepEqual(detect.ecosystemOf(repoWith(files)), { ecosystem, declaredMajor, reason: null }, JSON.stringify(files));
  }
});

test('an ecosystem that cannot be told apart is left unfilled with a fixed reason', () => {
  const cases = [
    [{ 'package.json': manifest({}), 'package-lock.json': '{}', 'yarn.lock': CLASSIC_LOCK }, 'several lockfiles: package-lock.json, yarn.lock'],
    [{ 'package.json': manifest({}) }, 'package.json without a lockfile'],
    [{ 'package.json': manifest({}), 'go.mod': 'module example.com/app\n' }, 'package.json without a lockfile'],
    [{ 'package.json': manifest({}), 'yarn.lock': 'something else\n' }, 'yarn.lock in an unknown format'],
    [{ 'README.md': '# app\n' }, 'no ecosystem detected'],
  ];
  for (const [files, reason] of cases) {
    assert.deepEqual(detect.ecosystemOf(repoWith(files)), { ecosystem: null, declaredMajor: null, reason }, JSON.stringify(files));
  }
});

test('a hostile packageManager is not recognized and no part of it reaches the result', () => {
  const hostile = ['yarn@1; touch /tmp/x', '$(id)', 'yarn@4.1.0 "quoted" \'and\' spaced', 'yarn@4.1.0\nnpm@1.0.0'];
  for (const packageManager of hostile) {
    const withLock = detect.ecosystemOf(repoWith({ 'package.json': manifest({ packageManager }), 'yarn.lock': CLASSIC_LOCK }));
    assert.deepEqual(withLock, { ecosystem: 'yarn-classic', declaredMajor: null, reason: null }, packageManager);
    const alone = detect.ecosystemOf(repoWith({ 'package.json': manifest({ packageManager }) }));
    assert.deepEqual(alone, { ecosystem: null, declaredMajor: null, reason: 'package.json without a lockfile' }, packageManager);
    assert.doesNotMatch(JSON.stringify([withLock, alone]), /touch|\$\(|quoted|spaced|;|@/);
  }
});

test('a yarn.lock that cannot be read leaves the ecosystem unfilled instead of failing', () => {
  const dir = repoWith({ 'package.json': manifest({}) });
  mkdirSync(join(dir, 'yarn.lock'));
  assert.deepEqual(detect.ecosystemOf(dir), { ecosystem: null, declaredMajor: null, reason: 'yarn.lock in an unknown format' });
});

const ALL_TOOLS = { corepack: '0.29.4', yarn: '4.1.0', npm: '10.8.1', pnpm: '9.1.0', go: 'go version go1.22.1 darwin/arm64' };
const setupWith = (versions, ecosystem, declaredMajor = null) =>
  detect.setupFor(ecosystem, declaredMajor, detect.toolProber(sandbox.fakeTools(versions).run, { cwd: DIR }));
const chosen = setup => ({ setup, reason: null, needs: null });
const needing = text => ({ setup: null, reason: text, needs: text });

test('the setup candidates are the fixed ordered table, one list per ecosystem', () => {
  assert.deepEqual(detect.SETUP_CANDIDATES, {
    'yarn-berry': [
      { tool: 'corepack', setup: [['corepack', 'yarn', 'install', '--immutable']] },
      { tool: 'yarn', major: 'berry', setup: [['yarn', 'install', '--immutable']] },
    ],
    'yarn-classic': [
      { tool: 'corepack', setup: [['corepack', 'yarn', 'install', '--frozen-lockfile']] },
      { tool: 'yarn', major: 1, setup: [['yarn', 'install', '--frozen-lockfile']] },
    ],
    npm: [{ tool: 'npm', setup: [['npm', 'ci']] }],
    pnpm: [
      { tool: 'corepack', setup: [['corepack', 'pnpm', 'install', '--frozen-lockfile']] },
      { tool: 'pnpm', setup: [['pnpm', 'install', '--frozen-lockfile']] },
    ],
    go: [{ tool: 'go', setup: [['go', 'mod', 'download']] }],
  });
});

test('with every tool installed each ecosystem gets its first candidate', () => {
  for (const [ecosystem, declared] of [['yarn-berry', 4], ['yarn-berry', null], ['yarn-classic', null], ['npm', null], ['pnpm', null], ['go', null]]) {
    assert.deepEqual(setupWith(ALL_TOOLS, ecosystem, declared), chosen(detect.SETUP_CANDIDATES[ecosystem][0].setup), ecosystem);
  }
});

test('without corepack the tool on PATH wins when its major fits', () => {
  assert.deepEqual(setupWith({ yarn: '1.22.22' }, 'yarn-classic', 1), chosen([['yarn', 'install', '--frozen-lockfile']]));
  assert.deepEqual(setupWith({ pnpm: '9.1.0' }, 'pnpm'), chosen([['pnpm', 'install', '--frozen-lockfile']]));
  assert.deepEqual(setupWith({ yarn: '4.1.0' }, 'yarn-berry', 4), chosen([['yarn', 'install', '--immutable']]));
  assert.deepEqual(setupWith({ yarn: '3.6.4' }, 'yarn-berry', null), chosen([['yarn', 'install', '--immutable']]));
});

test('when no candidate fits, setup is left unfilled with a needs text naming the tools', () => {
  assert.deepEqual(setupWith({ yarn: '1.22.22' }, 'yarn-berry', 4), needing('needs yarn 4 via corepack, or yarn 4 on PATH'));
  assert.deepEqual(setupWith({ yarn: '3.6.4' }, 'yarn-berry', 4), needing('needs yarn 4 via corepack, or yarn 4 on PATH'));
  assert.deepEqual(setupWith({ yarn: '1.22.22' }, 'yarn-berry', null), needing('needs corepack, or yarn 2 or later on PATH'));
  assert.deepEqual(setupWith({ yarn: null }, 'yarn-berry', null), needing('needs corepack, or yarn 2 or later on PATH'));
  assert.deepEqual(setupWith({ yarn: '4.1.0' }, 'yarn-classic', null), needing('needs corepack, or yarn 1 on PATH'));
  assert.deepEqual(setupWith({}, 'pnpm'), needing('needs corepack, or pnpm on PATH'));
  assert.deepEqual(setupWith({}, 'npm'), needing('needs npm'));
});

test('a go module gets go mod download when go is installed, and needs go when it is not', () => {
  assert.deepEqual(setupWith({ go: 'go version go1.22.1 darwin/arm64' }, 'go'), chosen([['go', 'mod', 'download']]));
  assert.deepEqual(setupWith({}, 'go'), needing('needs go'));
});

test('across many repos each tool is probed at most once, only by version, and the table is never handed out to be changed', () => {
  const tools = sandbox.fakeTools({ yarn: '1.22.22', go: 'go version go1.22.1 darwin/arm64' });
  const probe = detect.toolProber(tools.run, { cwd: DIR });
  const results = [['yarn-berry', 4], ['yarn-classic', 1], ['yarn-classic', null], ['pnpm', null], ['npm', null], ['go', null], ['go', null]]
    .map(([ecosystem, declared]) => detect.setupFor(ecosystem, declared, probe));
  const argvs = tools.calls.map(c => c.argv);
  assert.deepEqual(argvs.map(a => a[0]).sort(), ['corepack', 'go', 'npm', 'pnpm', 'yarn']);
  assert.ok(argvs.every(a => Object.values(detect.VERSION_ARGV).some(v => v.join(' ') === a.join(' '))), JSON.stringify(argvs));
  results[1].setup[0].push('--changed');
  assert.deepEqual(detect.SETUP_CANDIDATES['yarn-classic'][1].setup, [['yarn', 'install', '--frozen-lockfile']]);
});

test('no candidate, setup or needs text holds a tool-installation command', () => {
  const texts = [detect.SETUP_CANDIDATES, detect.VERSION_ARGV];
  for (const versions of [ALL_TOOLS, {}, { yarn: '1.22.22' }]) {
    for (const ecosystem of Object.keys(detect.SETUP_CANDIDATES)) texts.push(setupWith(versions, ecosystem, 4), setupWith(versions, ecosystem, null));
  }
  const banned = new RegExp(['--global', 'brew', 'enable', 'apt-get', 'winget', '"-g"'].join('|'));
  assert.doesNotMatch(JSON.stringify(texts), banned);
});

test('an old trial dir is a patch-map key of this project whose repo name differs from it', () => {
  const map = { schemaVersion: 1, project: { slug: 'abc123', name: 'A project' }, repos: { api: 'api-service', web: 'web' }, patches: {} };
  assert.equal(detect.oldTrialDir(map, 'abc123', 'api'), true);
  assert.equal(detect.oldTrialDir(map, 'abc123', 'web'), false);
  assert.equal(detect.oldTrialDir(map, 'other1', 'api'), false);
  assert.equal(detect.oldTrialDir(map, 'abc123', 'api-service'), false);
  assert.equal(detect.oldTrialDir(map, 'abc123', 'constructor'), false);
  assert.equal(detect.oldTrialDir(null, 'abc123', 'api'), false);
  assert.equal(detect.oldTrialDir({ project: { slug: 'abc123' } }, 'abc123', 'api'), false);
});

test('the facts of a checkout are read on first use only, once each, and the remotes of a scan are not read again', () => {
  const root = freshDir('facts');
  const app = clone(root, 'app', 'https://github.com/acme/app.git', 'main');
  writeFileSync(join(app, 'go.mod'), 'module app\n');
  const calls = [];
  const counted = (args, opts) => { calls.push(args[0]); return git(args, opts); };
  const tools = sandbox.fakeTools({ go: 'go version go1.22.0' });
  const facts = detect.checkoutFacts(counted, detect.toolProber(tools.run, { cwd: root }), { path: app });
  assert.deepEqual([calls, tools.calls], [[], []]);
  assert.deepEqual(facts.head, { branch: 'main', reason: null });
  assert.deepEqual(facts.remote, { remote: 'origin', github: 'acme/app', reason: null });
  assert.deepEqual(calls, ['remote', 'symbolic-ref']);
  assert.deepEqual(facts.setup, { setup: [['go', 'mod', 'download']], reason: null, needs: null });
  assert.deepEqual(facts.setup.setup, [['go', 'mod', 'download']]);
  assert.deepEqual(tools.calls.map(c => c.argv), [['go', 'version']]);
  assert.deepEqual(calls, ['remote', 'symbolic-ref']);

  const scanned = detect.checkoutFacts(counted, detect.toolProber(tools.run, { cwd: root }), { path: app, remotes: { origin: 'acme/app' } });
  assert.deepEqual(scanned.remote, { remote: 'origin', github: 'acme/app', reason: null });
  assert.deepEqual(calls, ['remote', 'symbolic-ref']);
  const none = detect.checkoutFacts(counted, detect.toolProber(tools.run, { cwd: root }), { path: join(root, 'no-such') });
  assert.deepEqual(none.setup, { setup: null, reason: 'no ecosystem detected', needs: null });
});
