import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { carriesKey, currentCheckout, parseWorktrees, refContains, remoteHeads, remoteSlugs } from '../start/checkout.mjs';

const lines = text => String(text).split('\n').filter(Boolean);
const HEADS = 'refs/heads/';

export function siblingDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() || (e.isSymbolicLink() && statSync(join(dir, e.name), { throwIfNoEntry: false })?.isDirectory()))
      .map(e => e.name);
  } catch {
    return [];
  }
}

function probe(git, path) {
  try {
    const common = resolve(path, git(['rev-parse', '--git-common-dir'], { cwd: path }).trim());
    return { common, slugs: remoteSlugs(git(['remote', '-v'], { cwd: path })) };
  } catch {
    return null;
  }
}

function scan(git, repoDir, path) {
  const branches = lines(git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], { cwd: path }))
    .map(l => l.slice(l.indexOf(' ') + 1)).filter(r => r.startsWith(HEADS)).map(r => r.slice(HEADS.length));
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain'], { cwd: path }));
  return [
    ...branches.map(branch => ({ repoDir, path, branch, kind: 'branch' })),
    ...worktrees.filter(w => w.path).map(w => ({ repoDir, path: w.path, branch: w.branch, kind: 'worktree' })),
  ];
}

// The configured checkout is where start runs; its siblings are the other clones and worktrees of the same repo.
export function localWork(git, { config, repoDirs, listDir = siblingDirs }) {
  const repos = new Map();
  const local = [];
  const failed = new Map();
  const notes = [];
  for (const dir of repoDirs) {
    const repo = config.repos[dir];
    if (!repo?.checkout) {
      notes.push({ key: dir, kind: 'github-only', message: `${dir}: no checkout configured: GitHub only` });
      continue;
    }
    const path = repo.checkout;
    let checkout;
    try {
      checkout = currentCheckout(git, config, path);
      if (checkout.unconfigured || checkout.repoDir !== dir) throw new Error(`${path} is not a checkout of ${repo.github ?? dir}`);
    } catch (e) {
      failed.set(dir, `${dir}: ${e.message}`);
      continue;
    }
    // ls-remote needs the network; the local scan below does not, so an unreachable remote only loses the pushed heads.
    let heads = {};
    try {
      heads = remoteHeads(git, { cwd: path, remote: repo.remote });
    } catch (e) {
      failed.set(dir, `${dir}: ${e.message}`);
    }
    const contains = refContains(git, { cwd: path, remote: repo.remote, tracking: checkout.tracking, heads, local: checkout.branches.local });
    repos.set(dir, { path, checkout, heads, contains });
    const github = repo.github?.toLowerCase() ?? null;
    const own = probe(git, path)?.common ?? null;
    const seen = new Set();
    for (const folder of [path, ...listDir(dirname(path)).map(name => join(dirname(path), name))]) {
      const found = probe(git, folder);
      // The configured checkout and its worktrees count whatever their remote is called; other clones by their remote.
      if (!found || seen.has(found.common) || (found.common !== own && !(github && found.slugs.has(github)))) continue;
      seen.add(found.common);
      try {
        local.push(...scan(git, dir, folder));
      } catch (e) {
        notes.push({ key: folder, kind: 'git-unavailable', message: `${folder}: ${e.message}` });
      }
    }
  }
  return { repos, local, failed, notes };
}

export function startedBy(work, key) {
  const hit = work.local.find(l => (l.branch && carriesKey(l.branch, key)) || (l.kind === 'worktree' && carriesKey(basename(l.path), key)));
  if (hit) return { where: 'local', name: hit.branch && carriesKey(hit.branch, key) ? hit.branch : basename(hit.path), path: hit.path };
  for (const { heads } of work.repos.values()) {
    const name = Object.keys(heads).find(n => carriesKey(n, key));
    if (name) return { where: 'remote', name, path: null };
  }
  return null;
}
