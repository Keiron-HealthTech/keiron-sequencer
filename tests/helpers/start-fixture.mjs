import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serializeRecord, validateRecord } from '../../scripts/lib/record.mjs';
import { gitRunner } from '../../scripts/lib/spike/exec.mjs';
import { fakeGit, fakeGitHub } from './fake-git.mjs';
import { fakeLinearStore } from './fake-linear.mjs';
import { fakeGh, fakeSetup, makeBareOrigin, makeRepo, SANDBOX_ENV, tempDir } from './git-sandbox.mjs';

export const CARD = 'ABC-1';
export const SLUG = 'a1b2c3d4e5f6';
export const PROJECT_URL = `https://linear.app/x/project/start-${SLUG}`;
export const GIT_BRANCH_NAME = 'user/abc-1-some-title';
export const SENTINEL = 'lin_api_SENTINEL_' + 's'.repeat(30);

export const startIssue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `https://linear.app/x/issue/${identifier}`, description: `Do ${identifier}.`,
  estimate: null, archivedAt: null, state: { name: 'Todo', type: 'unstarted' }, projectMilestone: null,
  labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, gitBranchName: null, ...over,
});

export const startRecord = (card, over = {}) => ({
  schemaVersion: 1,
  card,
  title: `Card ${card}`,
  project: { slug: SLUG, name: 'Start project' },
  origin: 'thin-spike',
  spikedAt: '2026-11-01T10:00:00.000Z',
  archived: null,
  supersededBy: null,
  alias: { splitFrom: null, mergedInto: null },
  scope: { complete: false, note: 'Only the read path; the export is a later card.' },
  size: { prodLines: 40, testLines: 20, files: 3, repos: ['app-repo'], sharedWith: [], deletionWeight: 0.25 },
  effort: null,
  fixups: { received: [], caused: [] },
  cases: [{ id: 'c1', given: 'a card with a record', when: 'it is started', then: 'the brief carries the record', source: 'linear', ref: `linear:${card}` }],
  decisions: [{ text: 'Read the card through the existing fetch module.', ref: `linear:${card}` }],
  findings: [],
  openDecisions: [{ text: 'Which state counts as started.' }],
  riskAreas: [],
  novelty: { newPaths: ['src/start.js'] },
  refs: { engram: [], patches: [], linear: null },
  ...over,
});

export function snapshot(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name))
    .sort()
    .map(path => [relative(dir, path), readFileSync(path, 'utf8')]);
}

function recordingGit(runner) {
  const calls = [];
  const run = (args, opts = {}) => {
    calls.push({ argv: [...args], cwd: opts.cwd });
    return runner(args, opts);
  };
  return { calls, run };
}

export const appRepo = (checkout, over = {}) => ({
  name: 'app-repo', github: 'acme/app', checkout, url: null, remote: 'origin',
  defaultBranch: 'main', branchNaming: 'verbatim', setup: [], ...over,
});

function writeInputs({ repos, projectRepos = Object.keys(repos), records, issues }) {
  const home = tempDir('keiron-sequencer-start-home-');
  const dataDir = tempDir('keiron-sequencer-start-data-');
  const scratch = tempDir('keiron-sequencer-start-scratch-');
  const config = { schemaVersion: 1, repos, projects: { [SLUG]: { repos: projectRepos } } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  mkdirSync(join(dataDir, SLUG));
  for (const record of records) {
    const errors = validateRecord(record);
    if (errors.length) throw new Error(`invalid fixture record ${record.card}: ${errors.join('; ')}`);
    writeFileSync(join(dataDir, SLUG, `${record.card}.json`), serializeRecord(record));
  }
  const keyFile = join(scratch, 'key');
  writeFileSync(keyFile, `${SENTINEL}\n`);
  const linear = fakeLinearStore({
    issues,
    project: { id: 'project-uuid', slugId: SLUG, name: 'Start project', url: PROJECT_URL },
    teams: [{ id: 'team-abc', key: 'ABC' }],
  });
  const dispose = () => { for (const dir of [home, dataDir, scratch]) rmSync(dir, { recursive: true, force: true }); };
  return { home, dataDir, scratch, config, keyFile, linear, dispose };
}

export const FAKE_CHECKOUT = '/fake/checkout';
export const HEAD_SHA = 'a'.repeat(40);

// What a clean checkout of acme/app on main answers; `over` replaces whole subcommand answers.
// A ref given without '<sha> ' points at HEAD_SHA.
export function checkoutTable({
  path = FAKE_CHECKOUT, commonDir = '.git', head = HEAD_SHA, branch = 'main', status = '',
  remotes = 'origin\tgit@github.com:acme/app.git (fetch)\n',
  refs = ['refs/heads/main', 'refs/remotes/origin/main'], worktrees = [{ path: FAKE_CHECKOUT, branch: 'main' }],
  heads = ['main'], revList = '0\n', log = '', ...over
} = {}) {
  return {
    'rev-parse': argv => (argv.includes('--abbrev-ref') ? `${branch ?? 'HEAD'}\n` : `${path}\n${commonDir}\n${head}\n`),
    remote: remotes,
    status,
    'for-each-ref': refs.map(r => (r.includes(' ') ? `${r}\n` : `${HEAD_SHA} ${r}\n`)).join(''),
    'worktree list': worktrees
      .map(w => `worktree ${w.path}\nHEAD ${head}\n${w.branch ? `branch refs/heads/${w.branch}` : 'detached'}\n\n`).join(''),
    'ls-remote': heads.map(h => `${HEAD_SHA}\trefs/heads/${h}\n`).join(''),
    'rev-list': revList,
    log,
    ...over,
  };
}

export function fakeStartFixture({
  issues = [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME })], records = [startRecord(CARD)],
  repos = { app: appRepo(FAKE_CHECKOUT) }, projectRepos, git = {}, gh = () => '[]',
} = {}) {
  const inputs = writeInputs({ repos, projectRepos, records, issues });
  const fake = { git: fakeGit(checkoutTable(git)), gh: fakeGitHub(gh) };
  const deps = {
    env: {}, fetchImpl: inputs.linear.fetchImpl, keyFile: inputs.keyFile, now: () => new Date('2026-11-10T10:00:00.000Z'),
    home: inputs.home, dataDir: inputs.dataDir, cwd: FAKE_CHECKOUT, git: fake.git.run, gh: fake.gh.run, runSetup: fakeSetup().run,
  };
  const run = async (argv, extra = {}) => {
    const { run: start } = await import('../../scripts/start.mjs');
    return start(argv, { ...deps, ...extra });
  };
  return { ...inputs, key: SENTINEL, git: fake.git, gh: fake.gh, deps, run };
}

export function startFixture({
  issues = [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME })], records = [startRecord(CARD)], repoOver = {}, gh: respond,
} = {}) {
  const repo = makeRepo();
  const origin = makeBareOrigin({ from: repo.dir });
  repo.git(['remote', 'add', 'origin', origin.dir]);
  repo.git(['fetch', '-q', 'origin']);
  const inputs = writeInputs({ repos: { app: appRepo(repo.dir, repoOver) }, records, issues });
  const gh = fakeGh(respond);
  const setup = fakeSetup();
  const git = recordingGit(gitRunner({ env: SANDBOX_ENV }));
  const deps = {
    env: {}, fetchImpl: inputs.linear.fetchImpl, keyFile: inputs.keyFile, now: () => new Date('2026-11-10T10:00:00.000Z'),
    home: inputs.home, dataDir: inputs.dataDir, cwd: repo.dir, git: git.run, gh: gh.run, runSetup: setup.run,
  };
  const run = async (argv, extra = {}) => {
    const { run: start } = await import('../../scripts/start.mjs');
    return start(argv, { ...deps, ...extra });
  };
  const dispose = () => {
    repo.dispose();
    origin.dispose();
    inputs.dispose();
  };
  return { ...inputs, repo, origin, key: SENTINEL, gh, git, setup, deps, run, dispose };
}
