import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeRecord } from '../../scripts/lib/record.mjs';
import { fakeGit, fakeGitHub } from './fake-git.mjs';
import { fakeLinearStore } from './fake-linear.mjs';
import { tempDir } from './git-sandbox.mjs';

export const SLUG = 'a1b2c3d4e5f6';
export const PROJECT_URL = `https://linear.app/x/project/next-${SLUG}`;
export const SENTINEL = 'lin_api_SENTINEL_' + 'n'.repeat(30);
export const SHA = 'a'.repeat(40);
export const M1 = { id: 'ms-1', name: 'Build', sortOrder: 1 };

export const nextIssue = (identifier, over = {}) => ({
  identifier, title: `app-repo: Card ${identifier}`, url: `https://linear.app/x/issue/${identifier}`, description: '',
  estimate: null, archivedAt: null, dueDate: null, state: { name: 'Todo', type: 'unstarted' }, projectMilestone: { name: 'Build' },
  labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, gitBranchName: null, assignee: null, attachments: [],
  ...over,
});
export const blocksIt = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });

export const appRepo = (over = {}) => ({
  name: 'app-repo', github: 'acme/app', checkout: '/src/app', url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [], ...over,
});

// One git folder: its common dir, remote, local branches, worktrees and pushed heads.
export const folder = ({ common, github = 'acme/app', branches = ['main'], worktrees = [], heads = ['main'], tracking = ['main'] }) => ({
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
  'rev-list': '0\n',
});
const NOT_GIT = { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };

// Routes each git call to the folder it ran in.
export const gitAt = folders => {
  const subs = ['rev-parse', 'remote', 'status', 'for-each-ref', 'worktree list', 'ls-remote', 'rev-list'];
  return fakeGit(Object.fromEntries(subs.map(sub => [sub, (argv, opts) => {
    const f = folders[opts.cwd];
    if (!f) return NOT_GIT;
    const answer = f[sub];
    return typeof answer === 'function' ? answer(argv, opts) : answer ?? '';
  }])));
};

export function fakeNextFixture({
  issues = [nextIssue('ABC-1')], milestones = [M1], records = [], repos = { app: appRepo() }, projectRepos,
  folders = { '/src/app': folder({ common: '/src/app/.git' }) }, siblings = { '/src': ['app'] }, gh = () => '[]',
  viewer = { id: 'viewer-1', name: 'Me' }, now = new Date('2026-11-16T12:00:00.000Z'), slug = SLUG,
} = {}) {
  const home = tempDir('keiron-sequencer-next-home-');
  const dataDir = tempDir('keiron-sequencer-next-data-');
  const config = { schemaVersion: 1, repos, projects: { [slug]: { repos: projectRepos ?? Object.keys(repos) } } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  mkdirSync(join(dataDir, slug));
  for (const record of records) writeFileSync(join(dataDir, slug, `${record.card}.json`), serializeRecord(record));
  const keyFile = join(home, 'key');
  writeFileSync(keyFile, `${SENTINEL}\n`);
  const linear = fakeLinearStore({
    issues, milestones, viewer,
    project: { id: 'project-uuid', slugId: slug, name: 'Next project', url: PROJECT_URL.replace(SLUG, slug) },
    teams: [{ id: 'team-abc', key: 'ABC' }],
  });
  const git = gitAt(folders);
  const github = fakeGitHub(gh);
  const deps = {
    env: {}, fetchImpl: linear.fetchImpl, keyFile, now: () => now, home, dataDir, repoDataDir: null,
    git: git.run, gh: github.run, listDir: dir => siblings[dir] ?? [],
  };
  const run = async (argv = [PROJECT_URL], extra = {}) => {
    const { run: next } = await import('../../scripts/next.mjs');
    return next(argv, { ...deps, ...extra });
  };
  const dispose = () => { for (const dir of [home, dataDir]) rmSync(dir, { recursive: true, force: true }); };
  return { home, dataDir, keyFile, config, linear, git, gh: github, deps, run, dispose, key: SENTINEL };
}
