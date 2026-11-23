import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { exitError } from '../cli.mjs';
import { combineTree } from './combine.mjs';
import { allRepos } from './state.mjs';

export const NO_PUSH_URL = 'keiron-sequencer-no-push:///blocked';
const PRE_PUSH = '#!/bin/sh\necho "keiron-sequencer: a spike tree never pushes" >&2\nexit 1\n';

const oneLine = text => text.split('\n').map(l => l.trim()).filter(Boolean).join(' ');

function defaultBranchOf(git, repoDir, repo) {
  if (repo.defaultBranch) return repo.defaultBranch;
  if (repo.remote === null) throw new Error(`${repoDir}: a checkout read with "remote": null needs a defaultBranch`);
  const head = git(['symbolic-ref', `refs/remotes/${repo.remote}/HEAD`], { cwd: repo.checkout }).trim();
  return head.slice(`refs/remotes/${repo.remote}/`.length);
}

function baseOfCheckout(git, repoDir, repo) {
  const branch = defaultBranchOf(git, repoDir, repo);
  if (repo.remote === null) return git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: repo.checkout }).trim();
  git(['fetch', '-q', repo.remote, branch], { cwd: repo.checkout });
  return git(['rev-parse', '--verify', `refs/remotes/${repo.remote}/${branch}^{commit}`], { cwd: repo.checkout }).trim();
}

function writeHook(dir) {
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-push'), PRE_PUSH);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  return hooks;
}

// The hook refuses every push, a push to a bare URL included; the pushurl also breaks a push by remote name.
function installPushGuard(git, path, dir, scope) {
  const cwd = path;
  git(['config', ...scope, 'core.hooksPath', writeHook(dir)], { cwd });
  for (const remote of git(['remote'], { cwd }).split('\n').filter(Boolean)) git(['config', ...scope, `remote.${remote}.pushurl`, NO_PUSH_URL], { cwd });
}

// Per-worktree config needs this extension in the checkout's shared config; it is the one key the spike adds there.
function enableWorktreeConfig(git, checkout) {
  const on = git(['config', '--type=bool', '--default=false', '--get', 'extensions.worktreeConfig'], { cwd: checkout }).trim() === 'true';
  if (!on) git(['config', 'extensions.worktreeConfig', 'true'], { cwd: checkout });
  return !on;
}

const PULL_HEAD = /^refs\/pull\/\d+\/head$/;

// A respike base is pinned at approval: a PR head is fetched by its pull ref, and only the pinned commit is used.
function pinnedCommit(git, repoDir, repo, { ref, sha }) {
  const cwd = repo.checkout;
  const gone = () => exitError(1, `pinned base ${sha} for ${repoDir} is gone; abandon and run respike preflight again`);
  if (PULL_HEAD.test(ref ?? '')) {
    try {
      git(['fetch', '-q', repo.remote, ref], { cwd });
    } catch {
      throw gone();
    }
  }
  try {
    return git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd }).trim();
  } catch {
    throw gone();
  }
}

// The combined tree is recomputed from the pinned heads and must be the approved one before anything is created.
function combinedBase(git, repoDir, repo, base) {
  const heads = base.heads.map(h => ({ ...h, sha: pinnedCommit(git, repoDir, repo, h) }));
  const { tree } = combineTree(git, repo.checkout, heads);
  if (tree !== base.tree) throw exitError(1, `combined base for ${repoDir} differs from the approved plan; abandon and run respike preflight again`);
  return { heads: heads.map(({ card, sha }) => ({ card, sha })), tree };
}

function createWorktree(git, repoDir, repo, path, dir, base) {
  const combine = base?.kind === 'combine' ? combinedBase(git, repoDir, repo, base) : null;
  const baseCommit = combine ? combine.heads[0].sha
    : base && base.kind !== 'default' ? pinnedCommit(git, repoDir, repo, base) : baseOfCheckout(git, repoDir, repo);
  const worktreeConfigSet = enableWorktreeConfig(git, repo.checkout);
  git(['worktree', 'add', '--detach', '-q', path, baseCommit], { cwd: repo.checkout });
  if (combine) {
    try {
      git(['read-tree', '-m', '-u', baseCommit, combine.tree], { cwd: path });
    } catch (e) {
      git(['worktree', 'remove', '--force', path], { cwd: repo.checkout });
      throw e;
    }
  }
  installPushGuard(git, path, dir, ['--worktree']);
  return { kind: 'worktree', source: repo.checkout, worktreeConfigSet, baseCommit, ...(combine ? { combine } : {}) };
}

function createClone(git, repo, path, dir) {
  mkdirSync(dirname(path), { recursive: true });
  git(['clone', '-q', ...(repo.defaultBranch ? ['--branch', repo.defaultBranch] : []), repo.url, path], { cwd: dir });
  git(['checkout', '-q', '--detach'], { cwd: path });
  installPushGuard(git, path, dir, ['--local']);
  return { kind: 'clone', source: repo.url, worktreeConfigSet: false, baseCommit: git(['rev-parse', 'HEAD'], { cwd: path }).trim() };
}

function runSetupCommands(runSetup, repoDir, repo, path, log) {
  mkdirSync(dirname(log), { recursive: true });
  for (const command of repo.setup ?? []) {
    appendFileSync(log, `$ ${command.join(' ')}\n`);
    let r;
    try {
      r = runSetup(command, { cwd: path, timeoutMs: repo.setupTimeoutMs });
    } catch (e) {
      r = { status: null, stdout: '', stderr: '', error: e.code ?? e.message };
    }
    appendFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `error ${r.error}` : `exit ${r.status}`}\n`);
    if (r.status === 0) continue;
    const why = r.error ? `could not run (${r.error})` : `exited ${r.status}`;
    throw Object.assign(exitError(1, `setup of ${repoDir} failed: ${command.join(' ')} ${why}; see ${log}`), {
      setup: { repo: repoDir, command, exitCode: r.status, log },
    });
  }
}

// A tree whose setup failed stays recorded with status "setup": it is spike-made, and the next open retries its setup.
export function openTree(git, state, { trackId, repoDir, repo, dir, runSetup }) {
  const { repos } = state.tracks[trackId];
  const known = repos[repoDir];
  if (known && known.status !== 'setup') return known;
  const path = known?.path ?? join(dir, 'trees', trackId, repoDir);
  if (!known) {
    if (state.plan?.respike && !repo.checkout) {
      throw exitError(1, `${repoDir} has no local checkout; a respike run opens trees only in checkouts. Configure \`checkout\` instead of \`url\` for it, then run tree again`);
    }
    const base = state.plan?.respike?.bases?.[repoDir];
    const made = repo.checkout ? createWorktree(git, repoDir, repo, path, dir, base) : createClone(git, repo, path, dir);
    repos[repoDir] = {
      name: repo.name, kind: made.kind, source: made.source, path, createdBySpike: true, worktreeConfigSet: made.worktreeConfigSet,
      baseCommit: made.baseCommit, ...(made.combine ? { combine: made.combine } : {}), baseTree: null, last: null, log: [], status: 'setup',
    };
  }
  const record = repos[repoDir];
  runSetupCommands(runSetup, repoDir, repo, path, join(dir, 'logs', trackId, `setup-${repoDir}.log`));
  git(['add', '-A'], { cwd: path });
  const baseTree = git(['write-tree'], { cwd: path }).trim();
  return Object.assign(record, { baseTree, last: baseTree, status: 'open' });
}

// A tree no state records, made by a command that went stale: it is removed again, so the next open can make it.
export function discardTree(git, repo) {
  if (repo.kind === 'worktree') git(['worktree', 'remove', '--force', repo.path], { cwd: repo.source });
  rmSync(repo.path, { recursive: true, force: true });
}

export const touchedCheckouts = state => allRepos(state)
  .filter(([, r]) => r.worktreeConfigSet)
  .map(([repo, r]) => ({ repo, checkout: r.source }));

export function guardTree(git, repoDir, repo) {
  const cwd = repo.path;
  const where = `${repoDir} tree ${repo.path}`;
  let ref;
  let head;
  let ahead;
  try {
    ref = git(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd }).trim();
    head = git(['rev-parse', 'HEAD'], { cwd }).trim();
    ahead = Number(git(['rev-list', '--count', `${repo.baseCommit}..HEAD`], { cwd }).trim());
  } catch (e) {
    throw exitError(6, `tree guard: cannot read the ${where}: ${oneLine(e.message)}`);
  }
  if (ref !== 'HEAD') throw exitError(6, `tree guard: the ${where} is on ${ref}; it must stay detached at its base ${repo.baseCommit}`);
  if (head !== repo.baseCommit || ahead !== 0) {
    throw exitError(6, `tree guard: the ${where} is at ${head}, ${ahead} commit(s) past its base ${repo.baseCommit}; the spike never commits`);
  }
}

export function assertLastTree(git, repoDir, repo) {
  try {
    git(['cat-file', '-e', `${repo.last}^{tree}`], { cwd: repo.path });
  } catch {
    throw exitError(6, `${repoDir}: the last snapshot tree ${repo.last} is missing from ${repo.path}; run rebuild ${repoDir} to restore it`);
  }
}

export function checkTree(git, repoDir, repo) {
  guardTree(git, repoDir, repo);
  assertLastTree(git, repoDir, repo);
}

// A temporary index keeps the tree's own index and working files out of it; only the tree object is written back.
export function rebuildTree(git, repoDir, repo, { dir, patchRoot }) {
  const env = { GIT_INDEX_FILE: join(dir, 'tmp', `rebuild-${repoDir}.index`) };
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  try {
    git(['read-tree', repo.baseTree], { cwd: repo.path, env });
    for (const entry of repo.log) git(['apply', '--cached', '--binary', join(patchRoot, repoDir, `${entry.name}.patch`)], { cwd: repo.path, env });
    const tree = git(['write-tree'], { cwd: repo.path, env }).trim();
    if (tree !== repo.last) throw new Error(`rebuild of ${repoDir} gave ${tree}, not the recorded last tree ${repo.last}: nothing was changed`);
    return tree;
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

const sourceGone = repo => repo.kind === 'worktree' && !existsSync(repo.source);

// A tree made before tracks sits at trees/<repoDir>.
function refuseForeign(trackId, repoDir, repo, dir) {
  const expected = join(resolve(dir), 'trees', trackId, repoDir);
  if (repo.createdBySpike !== true || ![expected, join(resolve(dir), 'trees', repoDir)].includes(resolve(repo.path))) {
    throw new Error(`refusing to delete ${repo.path} for ${repoDir}: only ${expected}, created by this run, is ever removed`);
  }
}

function refuseUnsnapshotted(git, repoDir, repo, advice) {
  if (repo.status !== 'open') return;
  git(['add', '-A'], { cwd: repo.path });
  const tree = git(['write-tree'], { cwd: repo.path }).trim();
  if (tree !== repo.last) throw new Error(`${repoDir} has work in ${repo.path} that was not snapshotted: ${advice}`);
}

// Every tree is checked before any is removed, so a refusal removes nothing. discard drops unsnapshotted work;
// the other refusals still hold.
export function teardownTrees(git, state, { dir, discard = false, advice = 'end the card that made it, or keep the run' }) {
  const live = Object.entries(state.tracks).flatMap(([trackId, t]) => Object.entries(t.repos).map(([repoDir, repo]) => [trackId, repoDir, repo]))
    .filter(([, , r]) => r.status !== 'removed');
  for (const [trackId, repoDir, repo] of live) {
    refuseForeign(trackId, repoDir, repo, dir);
    if (sourceGone(repo) || !existsSync(repo.path)) continue;
    guardTree(git, repoDir, repo);
    if (!discard) refuseUnsnapshotted(git, repoDir, repo, advice);
  }
  const removed = [];
  for (const [, repoDir, repo] of live) {
    const prunePending = sourceGone(repo);
    if (repo.kind === 'worktree' && !prunePending) {
      if (existsSync(repo.path)) git(['worktree', 'remove', '--force', repo.path], { cwd: repo.source });
      else git(['worktree', 'prune'], { cwd: repo.source });
    }
    rmSync(repo.path, { recursive: true, force: true });
    repo.status = 'removed';
    removed.push({ repo: repoDir, kind: repo.kind, path: repo.path, prunePending });
  }
  return removed;
}

// No --3way: it would stage the result. A refused diff leaves the tree as it was, for the agent to resolve.
export function applyPrDiff(git, repo, diff, { dir, number }) {
  const file = join(dir, 'tmp', `pr-${number}.diff`);
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  writeFileSync(file, diff);
  try {
    git(['apply', '--binary', file], { cwd: repo.path });
    return { status: 'applied' };
  } catch (e) {
    return { status: 'conflict', error: oneLine(e.message) };
  } finally {
    rmSync(file, { force: true });
  }
}
