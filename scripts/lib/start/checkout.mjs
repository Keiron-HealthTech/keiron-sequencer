import { resolve } from 'node:path';
import { isMerged, isOpen } from './base.mjs';

const lines = text => text.split('\n').filter(Boolean);

const GITHUB_REMOTE = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

export function githubOf(url) {
  const m = GITHUB_REMOTE.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export const remoteSlugs = text => new Set(lines(text)
  .filter(l => l.endsWith('(fetch)'))
  .map(l => githubOf(l.split(/\s+/)[1] ?? ''))
  .filter(Boolean));

export function parseWorktrees(text) {
  return text.split('\n\n').map(lines).filter(b => b.length).map(b => ({
    path: b.find(l => l.startsWith('worktree '))?.slice('worktree '.length) ?? null,
    branch: b.find(l => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
  }));
}

function resolveRepo(config, slugs, common) {
  const dirs = Object.keys(config.repos);
  const byPath = dirs.find(d => config.repos[d].checkout && resolve(config.repos[d].checkout, '.git') === common) ?? null;
  const byRemote = dirs.filter(d => config.repos[d].github && slugs.has(config.repos[d].github.toLowerCase()));
  if (byRemote.length === 0) return byPath;
  return byRemote.includes(byPath) ? byPath : byRemote[0];
}

// LC_ALL=C keeps git's "not a git repository" message untranslated, so a plain directory can be told from a broken repo.
const NOT_A_REPO = /not a git repository/i;

function topLevel(read, cwd) {
  try {
    return lines(read(['rev-parse', '--show-toplevel', '--git-common-dir', 'HEAD'], { LC_ALL: 'C' }));
  } catch (e) {
    if (NOT_A_REPO.test(e.message)) return null;
    throw e;
  }
}

export function currentCheckout(git, config, cwd) {
  const read = (args, env) => git(args, { cwd, env });
  const top = topLevel(read, cwd);
  if (!top) return { repoDir: null, path: cwd, head: null, branch: null, detached: false, dirty: 0, unconfigured: true, notGit: true };
  const [path, commonDir, head] = top;
  const abbrev = read(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const slugs = remoteSlugs(read(['remote', '-v']));
  const dirty = lines(read(['status', '--porcelain'], { GIT_OPTIONAL_LOCKS: '0' })).length;
  // --git-common-dir can be relative to cwd.
  const repoDir = resolveRepo(config, slugs, resolve(cwd, commonDir));
  const found = { repoDir, path, head, branch: abbrev === 'HEAD' ? null : abbrev, detached: abbrev === 'HEAD', dirty };
  if (!repoDir) return { ...found, unconfigured: true };
  const { remote, defaultBranch } = config.repos[repoDir];
  const refs = lines(read(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', `refs/remotes/${remote}`]))
    .map(l => ({ sha: l.slice(0, l.indexOf(' ')), ref: l.slice(l.indexOf(' ') + 1) }));
  const local = refs.filter(r => r.ref.startsWith('refs/heads/')).map(r => r.ref.slice('refs/heads/'.length));
  const prefix = `refs/remotes/${remote}/`;
  const tracked = refs.filter(r => r.ref.startsWith(prefix) && r.ref !== `${prefix}HEAD`).map(r => [r.ref.slice(prefix.length), r.sha]);
  return {
    ...found,
    defaultBranchLocal: local.includes(defaultBranch),
    branches: { local, remote: tracked.map(([name]) => name) },
    tracking: Object.fromEntries(tracked),
    worktrees: parseWorktrees(read(['worktree', 'list', '--porcelain'])),
  };
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function mapRepo(config, given) {
  const dir = Object.keys(config.repos).find(d => sameName(d, given) || sameName(config.repos[d].name, given));
  return dir ? { dir, name: config.repos[dir].name ?? dir } : null;
}

const TITLE_PREFIX = /^\s*([^\s:]+):\s/;
const REPO_LINE = /^\s*(?:[-*]\s+)?Repo:\s*`?([^\s`]+)`?/m;

export function cardRepos(card, record, patches, config) {
  const out = [];
  const add = (found, source) => {
    if (!out.some(r => (found.dir ? r.dir === found.dir : sameName(r.name, found.name)))) out.push({ ...found, source });
  };
  const given = name => mapRepo(config, name) ?? { dir: null, name };
  // A title prefix such as "Fix:" is not a repo; only a configured name counts there.
  const titled = mapRepo(config, TITLE_PREFIX.exec(card.title ?? '')?.[1] ?? '');
  if (titled) add(titled, 'title');
  else {
    const line = REPO_LINE.exec(card.description ?? '')?.[1]?.replace(/[.,;:]+$/, '');
    if (line) add(given(line), 'repo-line');
  }
  for (const name of record?.size?.repos ?? []) add(given(name), 'record');
  for (const p of patches ?? []) add(given(p.split('/')[0]), 'patches');
  return out;
}

export function repoMatch(repos, current) {
  if (!repos.length) {
    return { repos: [{ ...current, source: 'assumed' }], wrongRepo: null, warning: `the card names no repo; assuming ${current.name}, the current checkout` };
  }
  return { repos, wrongRepo: repos.some(r => r.dir === current.dir) ? null : repos.map(r => r.name), warning: null };
}

// A local candidate is read from its own branch; a pushed one only once its tracking ref matches the remote.
export function refContains(git, { cwd, remote, tracking, heads, local = [] }) {
  const ready = c => (c.local ? local.includes(c.headRefName) : Boolean(tracking[c.headRefName]) && heads[c.headRefName] === tracking[c.headRefName]);
  const ref = c => (c.local ? `refs/heads/${c.headRefName}` : `${remote}/${c.headRefName}`);
  return (top, other) => {
    if (!ready(top) || !ready(other)) return null;
    return git(['rev-list', '--count', `${ref(top)}..${ref(other)}`], { cwd }).trim() === '0';
  };
}

export const PR_FIELDS = 'number,state,isDraft,mergedAt,baseRefName,headRefName,title,url';

const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

export function parsePullUrl(url) {
  const m = PULL_URL.exec(url ?? '');
  return m ? { github: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const titleTag = key => new RegExp(`[\\[(]${escaped(key)}[\\])]`, 'i');

// ghRunner reports a non-zero status instead of throwing, so a failure must be told apart from "no PRs".
export function ghLookup(gh, known) {
  const failures = [];
  const dirOf = github => known.find(r => r.github?.toLowerCase() === github.toLowerCase())?.dir ?? null;
  const read = argv => {
    const r = gh(argv);
    if (r.status !== 0) {
      const repo = argv[argv.indexOf('--repo') + 1];
      failures.push(`gh pr ${argv[1]} ${argv[1] === 'view' ? `${repo}#${argv[2]}` : repo} failed (${r.status}): ${String(r.stderr).trim()}`);
      return null;
    }
    try {
      return JSON.parse(r.stdout);
    } catch {
      failures.push(`gh ${argv.slice(0, 2).join(' ')} returned no JSON`);
      return null;
    }
  };
  const shaped = (github, via) => p => ({
    repoDir: dirOf(github), github, number: p.number, state: p.state, isDraft: Boolean(p.isDraft), mergedAt: p.mergedAt ?? null,
    baseRefName: p.baseRefName, headRefName: p.headRefName, title: p.title, url: p.url, via,
  });
  return {
    failures,
    search: (github, key) => (read(['pr', 'list', '--repo', github, '--state', 'all', '--search', key, '--json', PR_FIELDS]) ?? [])
      .filter(p => titleTag(key).test(p.title ?? '')).map(shaped(github, 'search')),
    list: (github, args, via) => (read(['pr', 'list', '--repo', github, ...args, '--json', PR_FIELDS]) ?? []).map(shaped(github, via)),
    head: (github, branch, via) => (read(['pr', 'list', '--repo', github, '--head', branch, '--state', 'all', '--json', PR_FIELDS]) ?? [])
      .map(shaped(github, via)),
    view: (url, via) => {
      const ref = parsePullUrl(url);
      const p = ref && read(['pr', 'view', String(ref.number), '--repo', ref.github, '--json', PR_FIELDS]);
      return p ? [shaped(ref.github, via)(p)] : [];
    },
  };
}

export function uniquePrs(prs) {
  const seen = new Set();
  return prs.filter(p => {
    const id = `${p.github.toLowerCase()}#${p.number}`;
    return !seen.has(id) && seen.add(id);
  });
}

export function prsFor(gh, { key, search, known, attachments, given }) {
  const look = ghLookup(gh, known);
  const prs = uniquePrs([
    ...given.flatMap(url => look.view(url, 'given')),
    ...attachments.flatMap(url => look.view(url, 'attachment')),
    ...search.filter(r => r.github).flatMap(r => look.search(r.github, key)),
  ]);
  return { prs, unavailable: look.failures.length ? look.failures.join('; ') : null };
}

function lsRemote(git, { cwd, remote }, what, refs = []) {
  try {
    return git(['ls-remote', '--heads', remote, ...refs], { cwd });
  } catch (e) {
    throw new Error(`${what} could not be read from ${remote}: ${e.message}`);
  }
}

// ls-remote matches a pattern against the tail of each ref, so only the exact ref counts.
// A branch only in this checkout has no PR to look up: GitHub cannot see it.
export function givenBranch(git, gh, { cwd, remote, github, branch, known, local = [] }) {
  const ref = `refs/heads/${branch}`;
  const listed = lsRemote(git, { cwd, remote }, `branch ${branch}`, [ref]);
  const pushed = lines(listed).some(l => l.split('\t')[1] === ref);
  if (!pushed) {
    if (local.includes(branch)) return { found: true, prs: [], branch: { name: branch, where: 'local', via: 'given' }, unavailable: null };
    return { found: false, warning: `branch ${branch} not found on ${remote} or in this checkout` };
  }
  const look = ghLookup(gh, known);
  const prs = look.head(github, branch, 'given-branch');
  return {
    found: true, prs, branch: prs.length ? null : { name: branch, where: 'remote', via: 'given' },
    unavailable: look.failures.length ? look.failures.join('; ') : null,
  };
}

export function remoteHeads(git, { cwd, remote }) {
  const prefix = 'refs/heads/';
  return Object.fromEntries(lines(lsRemote(git, { cwd, remote }, 'the branches'))
    .map(l => l.split('\t'))
    .filter(([, ref]) => ref?.startsWith(prefix))
    .map(([sha, ref]) => [ref.slice(prefix.length), sha]));
}

// abc-1 must not match abc-10.
export const carriesKey = (name, key) =>
  new RegExp(`(^|[^a-z0-9])${escaped(key.toLowerCase())}(?![0-9])`).test(String(name).toLowerCase());

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function findResume(gh, { github, cardKey, branchName, attachments, checkout, heads, known }) {
  const mine = name => name === branchName || carriesKey(name, cardKey);
  const elsewhere = new Map(checkout.worktrees.filter(w => w.branch && w.path !== checkout.path).map(w => [w.branch, w.path]));
  const local = checkout.branches.local.filter(mine);
  const remoteOnly = [...new Set([...checkout.branches.remote, ...Object.keys(heads)])].filter(b => mine(b) && !local.includes(b));
  const branches = [
    ...local.map(name => (elsewhere.has(name) ? { name, where: 'worktree', path: elsewhere.get(name) } : { name, where: 'local', path: null })),
    ...remoteOnly.map(name => ({ name, where: 'remote', path: null })),
  ].sort(byName);
  const look = ghLookup(gh, known);
  const found = uniquePrs([
    ...attachments.flatMap(url => look.view(url, 'attachment')),
    ...(branchName ? look.head(github, branchName, 'head') : []),
    ...look.search(github, cardKey),
  ]);
  const here = p => p.github.toLowerCase() === github.toLowerCase();
  const prs = found.filter(here);
  const open = prs.filter(isOpen);
  const started = branches.length > 0 || open.length > 0;
  const ask = started ? [] : [...new Set(prs.map(p => (isMerged(p) ? 'pr-merged' : 'pr-closed')))].sort();
  const unavailable = look.failures.length ? look.failures.join('; ') : null;
  return {
    found: started, branches, prs, elsewhere: found.filter(p => !here(p)),
    remote: unavailable ? 'unavailable' : 'ok', ask, unavailable,
  };
}
