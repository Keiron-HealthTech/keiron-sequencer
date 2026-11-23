import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run as respike } from '../../scripts/respike.mjs';
import { run as spike } from '../../scripts/spike.mjs';
import { serializeRecord, validateRecord } from '../../scripts/lib/record.mjs';
import { gitRunner } from '../../scripts/lib/spike/exec.mjs';
import { runDir, writeJsonAtomic } from '../../scripts/lib/spike/home.mjs';
import { DIFF } from '../../scripts/lib/spike/snapshot.mjs';
import { createRun } from '../../scripts/lib/spike/state.mjs';
import { fakeLinearStore } from './fake-linear.mjs';
import { fakeGh, fakeSetup, makeBareOrigin, makeRepo, SANDBOX_ENV, sandboxGit, tempDir } from './git-sandbox.mjs';

export const SLUG = 'fedcba987654';
export const PROJECT_URL = `https://linear.app/x/project/respike-${SLUG}`;
export const PROJECT_NAME = 'Respike project';
export const SENTINEL = 'lin_api_SENTINEL_' + 'r'.repeat(30);
export const OLD_RUN = '20261101T100000Z';
export const A = 'CRM-1';
export const B = 'CRM-2';
export const PATCH_A = 'backend/00001-new.patch';

export const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `https://linear.app/x/issue/${identifier}`, description: `Do ${identifier}.`,
  estimate: null, archivedAt: null, state: { name: 'Todo', type: 'unstarted' }, projectMilestone: null,
  labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, gitBranchName: null, ...over,
});

export const notes = card => ({
  cases: [1, 2, 3].map(i => ({ given: `a list, case ${i}`, when: 'it is read', then: 'the order holds', source: 'linear', ref: `linear:${card}` })),
  decisions: [],
  findings: [],
  openDecisions: [],
  piiInLogs: [],
  scope: { complete: true, note: null },
  engram: [],
});

export const oldRecord = (card, { spikedAt, patches }) => ({
  schemaVersion: 1,
  card,
  title: `Card ${card}`,
  project: { slug: SLUG, name: PROJECT_NAME },
  origin: 'thin-spike',
  spikedAt,
  scope: { complete: true, note: null },
  size: { prodLines: 1, testLines: 0, files: 1, repos: ['backend-repo'], sharedWith: [], deletionWeight: 0.25 },
  effort: {
    basis: 'card-run', runId: OLD_RUN,
    windows: [{ start: '2026-11-01T10:00:00.000Z', end: spikedAt, cards: [card], messages: 3, tokens: { input: 5, cacheCreation: 0, cacheRead: 0, output: 2, thinking: 0 } }],
  },
  fixups: { received: [], caused: [] },
  cases: notes(card).cases.map((c, i) => ({ id: `c${i + 1}`, ...c })),
  decisions: [{ text: 'Keep the list in one file.', ref: `linear:${card}` }],
  findings: [{ kind: 'risk', text: 'The list order matters downstream.', ref: `linear:${card}` }],
  openDecisions: [],
  riskAreas: [],
  novelty: { newPaths: [] },
  refs: { engram: [], patches, linear: `https://linear.app/x/issue/${card}`, runId: OLD_RUN },
});

export const walk = dir => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name))).sort()
  : []);

export const snapshotDir = dir => walk(dir).map(path => [path, readFileSync(join(dir, path), 'utf8')]);

const LIST = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
const listText = lines => `${lines.join('\n')}\n`;

// A's old patch changes line5; main later changes line3, inside that hunk's context, so only a 3-way apply lands it.
function buildHistory(repo) {
  writeFileSync(join(repo.dir, 'src', 'list.js'), listText(LIST));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'list']);
  repo.git(['checkout', '-q', '-b', 'scratch']);
  writeFileSync(join(repo.dir, 'src', 'list.js'), listText(LIST.map(l => (l === 'line5' ? 'line5 from A' : l))));
  repo.git(['commit', '-q', '-am', 'scratch']);
  const patch = repo.git([...DIFF, 'main', 'scratch']);
  repo.git(['checkout', '-q', 'main']);
  repo.git(['branch', '-q', '-D', 'scratch']);
  writeFileSync(join(repo.dir, 'src', 'list.js'), listText(LIST.map(l => (l === 'line3' ? 'line3 from main' : l))));
  repo.git(['commit', '-q', '-am', 'main moves on']);
  return patch;
}

function plainApplyFails(repo, patchFile) {
  const r = spawnSync('git', ['apply', '--check', patchFile], { cwd: repo.dir, env: SANDBOX_ENV, encoding: 'utf8' });
  if (r.status === 0) throw new Error('the fixture patch applies without a 3-way merge');
}

function writeOldRun(home, dataDir) {
  const project = { id: 'project-uuid', slug: SLUG, name: PROJECT_NAME, url: PROJECT_URL };
  const card = (key, number) => ({
    title: `Card ${key}`, url: `https://linear.app/x/issue/${key}`, number, milestoneOrder: null, description: '', origin: 'thin-spike', pr: null, offProject: [],
  });
  const plan = { fetchedAt: '2026-11-01T10:00:00.000Z', order: [A, B], skipped: [], cards: { [A]: card(A, 1), [B]: card(B, 2) } };
  const state = createRun({ runId: OLD_RUN, project, plan, home, dataDir, now: new Date('2026-11-01T10:00:00.000Z') });
  state.status = 'complete';
  state.tracks.t1.repos.backend = { name: 'backend-repo', kind: 'worktree', status: 'removed', log: [{ name: '00001-new' }] };
  state.cards[A] = { ...state.cards[A], status: 'done', patches: [PATCH_A] };
  state.cards[B] = { ...state.cards[B], status: 'done', patches: [] };
  writeJsonAtomic(join(runDir(home, SLUG, OLD_RUN), 'run.json'), state);
}

function writeRecord(dataDir, record) {
  const errors = validateRecord(record);
  if (errors.length) throw new Error(`invalid fixture record ${record.card}: ${errors.join('; ')}`);
  mkdirSync(join(dataDir, SLUG), { recursive: true });
  writeFileSync(join(dataDir, SLUG, `${record.card}.json`), serializeRecord(record));
}

function recordingGit(runner) {
  const calls = [];
  const run = (args, opts = {}) => {
    calls.push({ argv: [...args], cwd: opts.cwd, env: opts.env });
    return runner(args, opts);
  };
  return { calls, run };
}

// A main checkout at <root>/<name>, cloned from a local origin, whose origin then names a URL that is never contacted.
// head sets refs/remotes/origin/HEAD to that branch; null removes it; undefined leaves what the clone made.
export function checkoutUnder(root, name, { from, remoteUrl, head } = {}) {
  const dir = join(root, name);
  sandboxGit(['clone', '-q', from, dir]);
  sandboxGit(['remote', 'set-url', 'origin', remoteUrl], { cwd: dir });
  if (head) sandboxGit(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${head}`], { cwd: dir });
  else if (head === null) sandboxGit(['remote', 'set-head', 'origin', '-d'], { cwd: dir });
  return dir;
}

export const D = 'CRM-4';
export const K = 'CRM-5';
export const P1 = 'CRM-6';
export const P2 = 'CRM-7';
export const PATCH_D = 'backend/00004-new.patch';
export const PATCH_K = 'backend/00005-new.patch';

const blocksB = { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-2' } }] } };

const newFile = (path, line) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1 @@', `+${line}`, ''].join('\n');

// A patch of src/list.js made on the main of the fixture, before any PR: one line replaced.
export function linePatch(repo, line, text) {
  repo.git(['checkout', '-q', '-b', 'scratch']);
  const path = join(repo.dir, 'src', 'list.js');
  writeFileSync(path, readFileSync(path, 'utf8').replace(`${line}\n`, `${text}\n`));
  repo.git(['commit', '-q', '-am', 'scratch']);
  const patch = repo.git([...DIFF, 'main', 'scratch']);
  repo.git(['checkout', '-q', 'main']);
  repo.git(['branch', '-q', '-D', 'scratch']);
  return patch;
}

// Pushes a commit off main to the origin's pull ref, as GitHub keeps an open PR's head; no local branch is left behind.
function pullHead(repo, origin, number, edit) {
  repo.git(['checkout', '-q', '-b', `pull-${number}`]);
  edit();
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', `pull ${number}`]);
  const sha = repo.git(['rev-parse', 'HEAD']).trim();
  repo.git(['push', '-q', origin.dir, `HEAD:refs/pull/${number}/head`]);
  repo.git(['checkout', '-q', 'main']);
  repo.git(['branch', '-q', '-D', `pull-${number}`]);
  return sha;
}

const pullRequest = (number, key, sha) => ({
  number, state: 'OPEN', isDraft: number === 71, mergedAt: null, baseRefName: 'main', headRefName: `work-${number}`, headRefOid: sha,
  isCrossRepository: false, title: `[${key}] work`, url: `https://github.com/acme/backend/pull/${number}`,
});

// Beside A: D replays cleanly, K's patch conflicts with P1's open PR, and P1 and P2 are diverged open PRs, so the
// backend base combines them. Every ancestor and PR blocks B.
function extend(f) {
  const kPatch = linePatch(f.repo, 'line8', 'line8 from K');
  const h1 = pullHead(f.repo, f.origin, 61, () => {
    const path = join(f.repo.dir, 'src', 'list.js');
    writeFileSync(path, readFileSync(path, 'utf8').replace('line8\n', 'line8 from P1\n'));
  });
  const h2 = pullHead(f.repo, f.origin, 71, () => writeFileSync(join(f.repo.dir, 'p2.txt'), 'from P2\n'));
  const patches = join(runDir(f.home, SLUG, OLD_RUN), 'patches');
  writeFileSync(join(patches, PATCH_D), newFile('src/d.js', 'export const d = 4'));
  writeFileSync(join(patches, PATCH_K), kPatch);
  writeRecord(f.dataDir, oldRecord(D, { spikedAt: '2026-11-01T10:40:00.000Z', patches: [PATCH_D] }));
  writeRecord(f.dataDir, oldRecord(K, { spikedAt: '2026-11-01T10:50:00.000Z', patches: [PATCH_K] }));
  f.prs.push(pullRequest(61, P1, h1), pullRequest(71, P2, h2));
  return { ...f, heads: [h1, h2] };
}

const extendedIssues = defaults => [
  ...defaults, issue(D, blocksB), issue(K, blocksB),
  ...[P1, P2].map(k => issue(k, { state: { name: 'In Review', type: 'started' }, ...blocksB })),
];

// One repo with a local bare origin, card A (unbuilt, old patch) blocking card B, and a completed run holding A's patch.
// issues(defaults) replaces the map, gh(argv) answers gh's stdout, config(config, repo) edits the config.
// extended adds a second clean ancestor, a conflicting one and two diverged open PRs (see extend).
export function respikeFixture({ issues = defaults => defaults, gh: ghRespond, config: editConfig = c => c, extended = false } = {}) {
  if (extended) {
    const prs = [];
    return extend({ ...respikeFixture({ issues: d => issues(extendedIssues(d)), gh: () => JSON.stringify(prs), config: editConfig }), prs });
  }
  const repo = makeRepo();
  const patch = buildHistory(repo);
  const origin = makeBareOrigin({ from: repo.dir });
  repo.git(['remote', 'add', 'origin', origin.dir]);
  repo.git(['fetch', '-q', 'origin']);
  const home = tempDir('keiron-sequencer-respike-home-');
  const dataDir = tempDir('keiron-sequencer-respike-data-');
  const scratch = tempDir('keiron-sequencer-respike-scratch-');
  const userHome = tempDir('keiron-sequencer-respike-userhome-');
  const dispose = () => {
    repo.dispose();
    origin.dispose();
    for (const dir of [home, dataDir, scratch, userHome]) rmSync(dir, { recursive: true, force: true });
  };
  after(dispose);

  const config = {
    schemaVersion: 1,
    repos: {
      backend: {
        name: 'backend-repo', github: 'acme/backend', checkout: repo.dir, url: null, remote: 'origin', defaultBranch: 'main', setup: [],
        risk: [{ kind: 'auth', paths: ['src/auth/**'] }],
      },
    },
    projects: { [SLUG]: { repos: ['backend'] } },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(editConfig(config, repo)));
  const patchFile = join(runDir(home, SLUG, OLD_RUN), 'patches', PATCH_A);
  mkdirSync(join(runDir(home, SLUG, OLD_RUN), 'patches', 'backend'), { recursive: true });
  writeFileSync(patchFile, patch);
  plainApplyFails(repo, patchFile);
  writeOldRun(home, dataDir);
  writeRecord(dataDir, oldRecord(A, { spikedAt: '2026-11-01T10:30:00.000Z', patches: [PATCH_A] }));
  writeRecord(dataDir, oldRecord(B, { spikedAt: '2026-11-01T11:00:00.000Z', patches: [] }));

  const keyFile = join(scratch, 'key');
  writeFileSync(keyFile, `${SENTINEL}\n`);
  const linear = fakeLinearStore({
    project: { id: 'project-uuid', slugId: SLUG, name: PROJECT_NAME, url: PROJECT_URL },
    issues: issues([
      issue(A, { state: { name: 'In Progress', type: 'started' }, relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: B } }] } }),
      issue(B),
    ]),
  });
  const gh = fakeGh(ghRespond);
  const setup = fakeSetup();
  const git = recordingGit(gitRunner({ env: SANDBOX_ENV }));
  let clock = Date.parse('2026-11-10T10:00:00.000Z');
  const deps = {
    env: {}, fetchImpl: linear.fetchImpl, keyFile, now: () => new Date(clock), home, dataDir, transcripts: null,
    git: git.run, gh: gh.run, runSetup: setup.run, sleep: async () => {}, trialLogDir: join(scratch, 'trial-logs'), tmpRoot: scratch, userHome,
  };
  return {
    home, dataDir, scratch, repo, origin, keyFile, key: SENTINEL, linear, gh, git, setup, deps, oldRunId: OLD_RUN, patchName: PATCH_A, dispose,
    at: iso => { clock = Date.parse(iso); },
    run: (sub, argv = [], extra = {}) => respike([sub, ...argv], { ...deps, ...extra }),
    spike: (argv, extra = {}) => spike(argv, { ...deps, ...extra }),
  };
}
