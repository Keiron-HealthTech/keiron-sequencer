import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localWork, siblingDirs, startedBy } from '../scripts/lib/next/clones.mjs';
import { fakeGit } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SHA = 'a'.repeat(40);
const APP = { name: 'app-repo', github: 'acme/app', checkout: '/src/app', url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [] };
const WEB = { ...APP, name: 'web-repo', github: 'acme/web', checkout: '/src/web' };
const config = (repos = { app: APP }) => ({ schemaVersion: 1, repos });

// One git folder: its common dir, remote, local branches, worktrees and pushed heads.
const folder = ({ common, github = 'acme/app', branches = ['main'], worktrees = [], heads = ['main'], tracking = ['main'] }) => ({
  'rev-parse': (argv, opts) => {
    if (argv.includes('--abbrev-ref')) return 'main\n';
    if (argv.includes('--show-toplevel')) return `${opts.cwd}\n${common}\n${SHA}\n`;
    return `${common}\n`;
  },
  remote: `origin\tgit@github.com:${github}.git (fetch)\n`,
  status: '',
  'for-each-ref': argv => [...branches.map(b => `${SHA} refs/heads/${b}`), ...(argv.includes('refs/remotes/origin') ? tracking.map(b => `${SHA} refs/remotes/origin/${b}`) : [])]
    .map(l => `${l}\n`).join(''),
  'worktree list': worktrees.map(w => `worktree ${w.path}\nHEAD ${SHA}\n${w.branch ? `branch refs/heads/${w.branch}` : 'detached'}\n\n`).join(''),
  'ls-remote': heads.map(h => `${SHA}\trefs/heads/${h}\n`).join(''),
});
const NOT_GIT = { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };

// Routes each git call to the folder it ran in.
const gitAt = folders => {
  const subs = ['rev-parse', 'remote', 'status', 'for-each-ref', 'worktree list', 'ls-remote', 'rev-list'];
  return fakeGit(Object.fromEntries(subs.map(sub => [sub, (argv, opts) => {
    const f = folders[opts.cwd];
    if (!f) return NOT_GIT;
    const answer = f[sub];
    return typeof answer === 'function' ? answer(argv, opts) : answer ?? '';
  }])));
};
const listDirOf = tree => dir => tree[dir] ?? [];

test('branches and worktrees from every clone of the repo, deduplicated on the common dir', () => {
  const git = gitAt({
    '/src/app': folder({ common: '/src/app/.git', branches: ['main', 'crm-5-x'], worktrees: [{ path: '/src/app', branch: 'main' }, { path: '/src/app-wt', branch: 'crm-6-y' }] }),
    '/src/app-wt': folder({ common: '/src/app/.git' }),
    '/src/app-pr11': folder({ common: '/src/app-pr11/.git', branches: ['main', 'crm-7-z'], worktrees: [{ path: '/src/app-pr11', branch: 'crm-7-z' }] }),
  });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app', 'app-wt', 'app-pr11'] }) });
  const seen = work.local.map(l => `${l.kind}:${l.branch}@${l.path}`).sort();
  assert.deepEqual(seen, [
    'branch:crm-5-x@/src/app', 'branch:crm-7-z@/src/app-pr11', 'branch:main@/src/app', 'branch:main@/src/app-pr11',
    'worktree:crm-6-y@/src/app-wt', 'worktree:crm-7-z@/src/app-pr11', 'worktree:main@/src/app',
  ]);
  assert.equal(git.calls.filter(c => c.sub === 'worktree list' && c.cwd === '/src/app-wt').length, 0);
  assert.equal(work.failed.size, 0);
});

test('the configured checkout gives the heads, its local branches and a containment check', () => {
  const git = gitAt({ '/src/app': folder({ common: '/src/app/.git', branches: ['main', 'crm-2-x'], heads: ['main', 'crm-3-y'], tracking: ['main', 'crm-3-y'] }) });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app'] }) });
  const app = work.repos.get('app');
  assert.deepEqual(Object.keys(app.heads).sort(), ['crm-3-y', 'main']);
  assert.deepEqual(app.checkout.branches.local, ['main', 'crm-2-x']);
  assert.equal(typeof app.contains, 'function');
});

test('startedBy finds a local branch first, then a pushed one, and crm-12 does not match crm-123-x', () => {
  const git = gitAt({ '/src/app': folder({ common: '/src/app/.git', branches: ['main', 'user/crm-123-x', 'crm-4-local'], heads: ['main', 'crm-9-pushed'] }) });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app'] }) });
  assert.equal(startedBy(work, 'CRM-12'), null);
  assert.deepEqual(startedBy(work, 'CRM-4'), { where: 'local', name: 'crm-4-local', path: '/src/app' });
  assert.deepEqual(startedBy(work, 'CRM-9'), { where: 'remote', name: 'crm-9-pushed', path: null });
});

test('a detached worktree is kept with no branch, and a non-git sibling folder is skipped, without failing', () => {
  const git = gitAt({ '/src/app': folder({ common: '/src/app/.git', worktrees: [{ path: '/src/app', branch: 'main' }, { path: '/src/app-detached', branch: null }] }) });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app', 'notes'] }) });
  assert.deepEqual(work.local.filter(l => l.kind === 'worktree').map(l => [l.path, l.branch]), [['/src/app', 'main'], ['/src/app-detached', null]]);
  assert.equal(work.failed.size, 0);
});

test('a worktree whose folder carries the card id counts as started, even detached', () => {
  const git = gitAt({ '/src/app': folder({ common: '/src/app/.git', worktrees: [{ path: '/src/app', branch: 'main' }, { path: '/src/wt/crm-77', branch: null }] }) });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app'] }) });
  assert.deepEqual(startedBy(work, 'CRM-77'), { where: 'local', name: 'crm-77', path: '/src/wt/crm-77' });
});

test('an unreachable remote is a failure, and the local branches are still scanned', () => {
  const app = folder({ common: '/src/app/.git', branches: ['main', 'crm-5-x'] });
  const git = gitAt({ '/src/app': { ...app, 'ls-remote': { status: 128, stdout: '', stderr: 'fatal: Could not read from remote repository.' } } });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app'] }) });
  assert.match(work.failed.get('app'), /remote/);
  assert.deepEqual(startedBy(work, 'CRM-5'), { where: 'local', name: 'crm-5-x', path: '/src/app' });
  assert.deepEqual(work.repos.get('app').heads, {});
});

test('the configured checkout is scanned even when its remote is an ssh host alias', () => {
  const app = folder({ common: '/src/app/.git', branches: ['main', 'crm-6-x'] });
  const git = gitAt({ '/src/app': { ...app, remote: 'origin\tgit@github-work:acme/app.git (fetch)\n' } });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app'] }) });
  assert.equal(startedBy(work, 'CRM-6')?.name, 'crm-6-x');
});

test('a sibling clone of another repo is not counted', () => {
  const git = gitAt({
    '/src/app': folder({ common: '/src/app/.git' }),
    '/src/web': folder({ common: '/src/web/.git', github: 'acme/web', branches: ['crm-8-web'] }),
  });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app', 'web'] }) });
  assert.equal(work.local.some(l => l.branch === 'crm-8-web'), false);
});

test('a repo with no checkout is a github-only note, not a failure, and is not scanned', () => {
  const git = gitAt({ '/src/app': folder({ common: '/src/app/.git' }) });
  const work = localWork(git.run, { config: config({ app: APP, web: { ...WEB, checkout: null, url: 'https://github.com/acme/web.git' } }), repoDirs: ['app', 'web'], listDir: listDirOf({ '/src': ['app'] }) });
  assert.equal(work.failed.has('web'), false);
  assert.deepEqual(work.notes.map(n => [n.key, n.kind]), [['web', 'github-only']]);
  assert.match(work.notes[0].message, /no checkout configured/);
  assert.equal(work.repos.has('web'), false);
  assert.equal(work.repos.has('app'), true);
});

test('a sibling clone git cannot list is a git-unavailable note, and the run goes on', () => {
  const broken = { ...folder({ common: '/src/app-pr11/.git' }), 'for-each-ref': { status: 128, stdout: '', stderr: 'fatal: bad object' } };
  const git = gitAt({ '/src/app': folder({ common: '/src/app/.git', branches: ['main', 'crm-5-x'] }), '/src/app-pr11': broken });
  const work = localWork(git.run, { config: config(), repoDirs: ['app'], listDir: listDirOf({ '/src': ['app', 'app-pr11'] }) });
  assert.deepEqual(work.notes.map(n => [n.key, n.kind]), [['/src/app-pr11', 'git-unavailable']]);
  assert.equal(startedBy(work, 'CRM-5')?.name, 'crm-5-x');
  assert.equal(work.failed.size, 0);
});

test('a symlinked sibling folder is listed like any other', () => {
  const root = mkdtempSync(join(tmpdir(), 'keiron-sequencer-clones-'));
  try {
    mkdirSync(join(root, 'app'));
    mkdirSync(join(root, 'real-clone'));
    symlinkSync(join(root, 'real-clone'), join(root, 'app-link'));
    writeFileSync(join(root, 'a-file'), '');
    assert.deepEqual(siblingDirs(root).sort(), ['app', 'app-link', 'real-clone']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a configured checkout git cannot read is listed in failed', () => {
  const work = localWork(gitAt({}).run, { config: config(), repoDirs: ['app'], listDir: listDirOf({}) });
  assert.match(work.failed.get('app'), /\/src\/app/);
});
