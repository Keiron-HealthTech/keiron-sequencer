import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitRunner } from '../lib/spike/exec.mjs';

const isPatch = path => path.endsWith('.patch');
const nulList = text => text.split('\0').filter(Boolean);
const lineList = text => text.split('\n').filter(Boolean);

function parseCommit(raw) {
  const split = raw.indexOf('\n\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  const commit = { parents: [], message: split === -1 ? '' : raw.slice(split + 2) };
  for (const line of head.split('\n')) {
    const key = line.split(' ', 1)[0];
    const value = line.slice(key.length + 1);
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author' || key === 'committer') commit[key] = value;
  }
  return commit;
}

const IDENT = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/;

function identEnv(prefix, ident) {
  const [, name, email, seconds, zone] = ident.match(IDENT);
  return { [`GIT_${prefix}_NAME`]: name, [`GIT_${prefix}_EMAIL`]: email, [`GIT_${prefix}_DATE`]: `@${seconds} ${zone}` };
}

const blobs = (run, tree) => nulList(run(['ls-tree', '-r', '-z', '--full-tree', tree]));
const pathOf = entry => entry.slice(entry.indexOf('\t') + 1);

// With `objects`, new trees and commits go to a throwaway object directory that reads the repo's as an alternate,
// so a preview leaves the repo's object store as it was.
function rewrite(git, repo, tip, { objects } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'keiron-sequencer-strip-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  if (objects) {
    env.GIT_OBJECT_DIRECTORY = join(scratch, 'objects');
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objects;
    mkdirSync(env.GIT_OBJECT_DIRECTORY);
  }
  const run = (args, extra = {}) => git(args, { cwd: repo, env: { ...env, ...extra } });
  try {
    const mapped = new Map();
    const commits = [];
    for (const old of lineList(run(['rev-list', '--reverse', '--topo-order', tip]))) {
      const c = parseCommit(run(['cat-file', 'commit', old]));
      run(['read-tree', c.tree]);
      const removed = nulList(run(['ls-files', '-z'])).filter(isPatch).sort();
      if (removed.length) run(['update-index', '--force-remove', '--', ...removed]);
      const tree = removed.length ? run(['write-tree']).trim() : c.tree;
      const parents = c.parents.map(p => mapped.get(p) ?? p);
      const rewritten = tree !== c.tree || parents.some((p, i) => p !== c.parents[i]);
      let next = old;
      if (rewritten) {
        const message = join(scratch, 'message');
        writeFileSync(message, c.message);
        const ident = { ...identEnv('AUTHOR', c.author), ...identEnv('COMMITTER', c.committer) };
        next = run(['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap(p => ['-p', p]), '-F', message], ident).trim();
      }
      mapped.set(old, next);
      const n = rewritten ? parseCommit(run(['cat-file', 'commit', next])) : c;
      const kept = {
        metadata: n.author === c.author && n.committer === c.committer && n.message === c.message,
        blobs: JSON.stringify(blobs(run, c.tree).filter(e => !isPatch(pathOf(e)))) === JSON.stringify(blobs(run, n.tree)),
      };
      commits.push({ old, new: next, rewritten, removed, kept });
    }
    return { commits, newTip: mapped.get(tip) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const remotesOf = (git, repo) => lineList(git(['remote'], { cwd: repo }));

const count = (git, repo, args) => Number(git(['rev-list', '--count', ...args], { cwd: repo }).trim());
const isPushed = (git, repo, tip) => count(git, repo, [tip]) !== count(git, repo, [tip, '--not', '--remotes']);

const tipOf = (git, repo, branch) => git(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { cwd: repo }).trim();

export function planRewrite(repo, { branch = 'main', git = gitRunner() } = {}) {
  const oldTip = tipOf(git, repo, branch);
  const objects = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo }).trim(), 'objects');
  const { commits, newTip } = rewrite(git, repo, oldTip, { objects });
  const removed = [...new Set(commits.flatMap(c => c.removed))].sort();
  return { branch, oldTip, newTip, commits, removed, pushed: isPushed(git, repo, oldTip), remotes: remotesOf(git, repo) };
}

const refExists = (git, repo, ref) => lineList(git(['for-each-ref', '--format=%(refname)', ref], { cwd: repo })).includes(ref);

export function applyRewrite(repo, plan, { approve = false, backupRef = `refs/backup/pre-strip-patches/${plan.branch}`, bundlePath, git = gitRunner() } = {}) {
  if (!approve) return { applied: false, plan };
  const run = args => git(args, { cwd: repo });
  const remotes = remotesOf(git, repo);
  if (remotes.length) throw new Error(`the repo has remote ${remotes.join(', ')}: a rewrite is refused for a repo with a remote`);
  if (isPushed(git, repo, plan.oldTip)) throw new Error('a commit to rewrite is reachable from refs/remotes/*, so it was pushed: the rewrite is refused');
  if (!bundlePath) throw new Error('an applied rewrite needs a bundlePath for its backup bundle');
  if (existsSync(bundlePath)) throw new Error(`${bundlePath} already exists: choose a new bundle path`);
  const now = tipOf(git, repo, plan.branch);
  if (now !== plan.oldTip) throw new Error(`${plan.branch} moved since the plan (${plan.oldTip} is now ${now}): plan again`);
  if (refExists(git, repo, backupRef)) throw new Error(`${backupRef} already exists: a backup from an earlier rewrite is still there`);
  if (plan.newTip === plan.oldTip) throw new Error('nothing to rewrite: no commit holds a .patch file');

  const { newTip } = rewrite(git, repo, plan.oldTip);
  if (newTip !== plan.newTip) throw new Error(`the rewrite gave ${newTip}, not the planned ${plan.newTip}; nothing was changed`);
  run(['update-ref', backupRef, plan.oldTip, '']);
  mkdirSync(dirname(bundlePath), { recursive: true });
  run(['bundle', 'create', '-q', bundlePath, '--all']);
  run(['update-ref', `refs/heads/${plan.branch}`, newTip, plan.oldTip]);
  if (run(['rev-parse', '--symbolic-full-name', 'HEAD']).trim() === `refs/heads/${plan.branch}`) {
    const staged = nulList(run(['ls-files', '-z'])).filter(isPatch);
    if (staged.length) run(['update-index', '--force-remove', '--', ...staged]);
  }
  return { applied: true, branch: plan.branch, oldTip: plan.oldTip, newTip, backupRef, bundlePath };
}

// HEAD is walked too: a detached HEAD on an old commit keeps its patches reachable.
export function verifyNoPatches(repo, { exclude = [], git = gitRunner() } = {}) {
  const run = args => git(args, { cwd: repo });
  const refs = lineList(run(['for-each-ref', '--format=%(refname)'])).filter(r => !exclude.some(prefix => r.startsWith(prefix)));
  const offending = [];
  for (const commit of lineList(run(['rev-list', 'HEAD', ...refs, '--']))) {
    const paths = nulList(run(['ls-tree', '-r', '-z', '--name-only', commit])).filter(isPatch);
    if (paths.length) offending.push({ commit, paths });
  }
  return { ok: offending.length === 0, offending };
}

export function purgeBackup(repo, { backupRef, approve = false, git = gitRunner() } = {}) {
  if (!approve) throw new Error(`purging ${backupRef} drops the last in-repo copy of the old history: it needs its own approve`);
  if (!refExists(git, repo, backupRef)) throw new Error(`${backupRef} does not exist`);
  const run = args => git(args, { cwd: repo });
  run(['update-ref', '-d', backupRef]);
  run(['reflog', 'expire', '--expire=now', '--all']);
  run(['gc', '--prune=now', '-q']);
  return { purged: true, backupRef };
}
