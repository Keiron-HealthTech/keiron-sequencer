import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exitError } from '../cli.mjs';
import { combineTree } from '../spike/combine.mjs';
import { allowedRepos } from '../spike/config.mjs';
import { isMerged, isOpen } from '../start/base.mjs';
import { carriesKey, titleTag } from '../start/checkout.mjs';

export const PR_LIST_FIELDS = 'number,state,isDraft,mergedAt,baseRefName,headRefName,headRefOid,isCrossRepository,title,url';

const lines = text => text.split('\n').filter(Boolean);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byCard = (a, b) => cardNumber(a.key) - cardNumber(b.key) || compare(a.key, b.key) || compare(a.repoDir ?? '', b.repoDir ?? '');

// Local branches and the remote's tracking refs as the checkout has them now: no fetch.
export function readRefs(git, { checkout, remote }) {
  const out = lines(git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', ...(remote ? [`refs/remotes/${remote}`] : [])], { cwd: checkout }));
  const local = {};
  const tracking = {};
  const prefix = `refs/remotes/${remote}/`;
  for (const line of out) {
    const [sha, ref] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
    if (ref.startsWith('refs/heads/')) local[ref.slice('refs/heads/'.length)] = sha;
    else if (remote && ref.startsWith(prefix) && ref !== `${prefix}HEAD`) tracking[ref.slice(prefix.length)] = sha;
  }
  return { local, tracking };
}

// ghRunner reports a non-zero status instead of throwing, so a failed read must not pass for "no PRs".
export function readPrLists(gh, config, slug) {
  const lists = new Map();
  for (const dir of allowedRepos(config, slug).filter(d => config.repos[d]?.github)) {
    const { github } = config.repos[dir];
    const r = gh(['pr', 'list', '--repo', github, '--state', 'all', '--limit', '500', '--json', PR_LIST_FIELDS]);
    if (r.status !== 0) throw exitError(1, `gh pr list --repo ${github} failed (${r.status}): ${String(r.stderr).trim()}`);
    try {
      lists.set(dir, JSON.parse(r.stdout));
    } catch {
      throw exitError(1, `gh pr list --repo ${github} returned no JSON`);
    }
  }
  return lists;
}

export function pinBranch(git, cwd, branch) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { cwd }).trim();
  } catch {
    throw exitError(2, `branch ${branch} does not resolve to a commit in ${cwd}`);
  }
}

const prOf = p => ({ number: p.number, url: p.url, headRefName: p.headRefName, baseRefName: p.baseRefName ?? null, isDraft: Boolean(p.isDraft) });
const entry = (key, kind, evidence, repoDir, over = {}) => ({ key, kind, evidence, repoDir, pr: null, branch: null, sha: null, needed: false, warning: null, ...over });

function branchesCarrying(key, gitBranchName, config, refs) {
  const found = [];
  for (const [dir, { local, tracking }] of refs) {
    const mine = name => name === gitBranchName || carriesKey(name, key);
    const remote = config.repos[dir]?.remote;
    const names = [...Object.keys(local).filter(mine), ...(remote ? Object.keys(tracking).filter(n => mine(n) && !(n in local)).map(n => `${remote}/${n}`) : [])];
    if (names.length) found.push({ dir, names: names.sort() });
  }
  return found;
}

// A bare name with no local branch falls back to the remote-tracking ref, which is all a merged-into branch often has.
function resolveAnswer(key, branch, config, refs, pin) {
  for (const [dir, { local, tracking }] of refs) {
    const remote = config.repos[dir]?.remote;
    const named = branch in local ? branch
      : remote && branch.startsWith(`${remote}/`) && branch.slice(remote.length + 1) in tracking ? branch
        : remote && branch in tracking ? `${remote}/${branch}` : null;
    if (named) return entry(key, 'local', 'branch', dir, { branch: named, sha: pin(dir, named) });
  }
  throw exitError(2, `--built ${key}=${branch}: no branch ${branch} in a configured checkout`);
}

// answers.built: card -> branch; answers.unbuilt: cards the user calls unbuilt. Merged-into-branch cards stay pending
// until the bases are known, since their code is built only when that branch heads a base.
export function classifyBuilt(analysis, { config, prs, refs, answers, pin }) {
  const built = [];
  const pending = [];
  const asks = [];
  const warnings = [];
  for (const card of analysis.cards) {
    const { key } = card;
    const tagged = [...prs].map(([dir, list]) => ({ dir, list: list.filter(p => titleTag(key).test(String(p.title ?? ''))) }));
    const intoDefault = tagged.flatMap(({ dir, list }) => list.filter(p => isMerged(p) && p.baseRefName === config.repos[dir]?.defaultBranch).map(p => ({ dir, p })));
    // Once merged into the default branch, the card's code is there; an open PR into another branch (a [Prod] port to
    // main) is cut from that branch, and as a base head it would pull in all of its drift from the default branch.
    const mergedIn = new Set(intoDefault.map(({ dir }) => dir));
    const counts = (dir, p) => isOpen(p) && (!mergedIn.has(dir) || p.baseRefName === config.repos[dir]?.defaultBranch);
    const open = tagged.flatMap(({ dir, list }) => list.filter(p => counts(dir, p)).sort((a, b) => b.number - a.number).slice(0, 1).map(p => ({ dir, p })));
    const elsewhere = tagged.flatMap(({ dir, list }) => list.filter(p => isMerged(p) && p.baseRefName !== config.repos[dir]?.defaultBranch).map(p => ({ dir, p })));
    const completed = card.statusType === 'completed';
    for (const { dir, p } of intoDefault) {
      const warning = completed ? null : 'merged, still open in Linear';
      if (warning) warnings.push({ code: 'merged-still-open', card: key, message: `${key}: ${warning}` });
      built.push(entry(key, 'merged', 'github', dir, { pr: prOf(p), warning }));
    }
    const unbuilt = answers.unbuilt.has(key);
    if (!unbuilt) for (const { dir, p } of open) built.push(entry(key, 'pr', 'github', dir, { pr: prOf(p), branch: p.headRefName, sha: p.headRefOid }));
    if (intoDefault.length || open.length) continue;
    if (completed) {
      warnings.push({ code: 'linear-done-no-pr', card: key, message: `${key}: completed in Linear, no merged PR found` });
      built.push(entry(key, 'merged', 'linear', null, { warning: 'completed in Linear, no merged PR found' }));
      continue;
    }
    if (unbuilt) continue;
    if (answers.built.has(key)) { built.push(resolveAnswer(key, answers.built.get(key), config, refs, pin)); continue; }
    if (elsewhere.length) {
      const { dir, p } = elsewhere[0];
      pending.push({ key, repoDir: dir, branch: p.baseRefName, pr: prOf(p) });
      continue;
    }
    for (const { dir, names } of branchesCarrying(key, card.gitBranchName, config, refs)) {
      asks.push({
        code: 'local-branch', card: key, repoDir: dir, branches: names, cards: [key], paths: [],
        message: `${key} has no PR but ${dir} has branch ${names.join(', ')}: treat it as built (that branch is the base) or unbuilt?`,
        answers: [...names.map(n => `--built ${key}=${n}`), `--unbuilt ${key}`],
      });
    }
  }
  return { built: built.sort(byCard), pending, asks, warnings };
}

const isCandidate = b => (b.kind === 'pr' || b.kind === 'local') && b.repoDir && b.sha;

function upward(analysis) {
  const blockers = new Map();
  for (const e of analysis.edges) blockers.set(e.to, [...(blockers.get(e.to) ?? []), e.from]);
  return start => {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      for (const k of blockers.get(stack.pop()) ?? []) if (!seen.has(k)) { seen.add(k); stack.push(k); }
    }
    return seen;
  };
}

// entries: [{ key, repos }]; repos null means the entry names no repo, so its trees may open anywhere.
export function neededCandidates(analysis, built, entries) {
  const above = upward(analysis);
  const ancestors = new Map(entries.map(e => [e.key, above(e.key)]));
  return built.map(b => ({
    ...b,
    needed: isCandidate(b) && entries.some(e => (e.repos === null || e.repos.includes(b.repoDir)) && ancestors.get(e.key).has(b.key)),
  }));
}

export function resolvePending(pending, built) {
  const heads = built.filter(b => b.needed && isCandidate(b));
  const out = { built: [], asks: [] };
  for (const p of pending) {
    const head = heads.find(h => h.repoDir === p.repoDir && h.branch === p.branch);
    if (head) {
      out.built.push(entry(p.key, 'merged', 'github', p.repoDir, { pr: p.pr, branch: p.branch, warning: `merged into ${p.branch}, the head of ${head.key}` }));
      continue;
    }
    out.asks.push({
      code: 'merged-into-branch', card: p.key, repoDir: p.repoDir, cards: [p.key], paths: [],
      message: `${p.key}'s PR was merged into ${p.branch}, which is no base: treat it as built (branch ${p.branch} is the base) or unbuilt?`,
      answers: [`--built ${p.key}=${p.branch}`, `--unbuilt ${p.key}`],
    });
  }
  return out;
}

function present(git, cwd, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

const headRef = b => (b.kind === 'pr' ? `refs/pull/${b.pr.number}/head` : b.branch);

// PR base/head links decide first; what links leave open is decided by rev-list in the checkout, or is unknown.
function maximal(git, cwd, candidates) {
  const byHead = new Map(candidates.map(c => [c.branch, c]));
  const linkedBelow = top => {
    const seen = new Set();
    for (let c = byHead.get(top.pr?.baseRefName); c && !seen.has(c.branch); c = byHead.get(c.pr?.baseRefName)) seen.add(c.branch);
    return seen;
  };
  const open = candidates.filter(c => !candidates.some(o => o !== c && linkedBelow(o).has(c.branch)));
  if (open.length === 1) return { tops: open };
  const missing = open.filter(c => !present(git, cwd, c.sha));
  if (missing.length) return { missing };
  const contains = (top, other) => git(['rev-list', '--count', `${top.sha}..${other.sha}`], { cwd }).trim() === '0';
  const tops = open.filter(c => !open.some(o => o !== c && contains(o, c) && (!contains(c, o) || cardNumber(o.key) < cardNumber(c.key))));
  return { tops };
}

function behindDefault(git, cwd, repo, refs, shas) {
  if (!refs.tracking[repo.defaultBranch]) return null;
  try {
    return Number(git(['rev-list', '--count', `${repo.remote}/${repo.defaultBranch}`, ...shas.map(s => `^${s}`)], { cwd }).trim());
  } catch {
    return null;
  }
}

// Commits a head holds that the default branch does not: 0 means the default branch already contains it.
function ownCommits(git, cwd, repo, refs, sha) {
  if (!refs?.tracking?.[repo.defaultBranch] || !present(git, cwd, sha)) return null;
  try {
    return Number(git(['rev-list', '--count', `${repo.remote}/${repo.defaultBranch}..${sha}`], { cwd }).trim());
  } catch {
    return null;
  }
}

// merge-tree writes its merged objects into a temporary object directory, so preflight leaves the checkout's store as it was.
function combineInTemp(git, cwd, heads, tmpRoot) {
  const objects = resolve(cwd, git(['rev-parse', '--git-path', 'objects'], { cwd }).trim());
  const temp = mkdtempSync(join(tmpRoot, 'keiron-sequencer-combine-'));
  try {
    return combineTree(git, cwd, heads, { env: { GIT_OBJECT_DIRECTORY: temp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const defaultBase = repo => ({
  kind: 'default', ref: `${repo.remote}/${repo.defaultBranch}`, sha: null, card: null, heads: null, tree: null, behind: null, ownCommits: null, warning: null,
});

// withDefault: the repos whose base takes the default branch's tip as one more head, so a base behind default is brought up
// to date in the spike's own tree; no branch of the user's moves.
export function decideBases(git, { config, built, repos, refs, tmpRoot, withDefault = new Set() }) {
  const bases = {};
  const asks = [];
  const warnings = [];
  for (const dir of [...repos].sort(compare)) {
    const repo = config.repos[dir];
    if (!repo) continue;
    const cwd = repo.checkout;
    const candidates = built.filter(b => b.needed && isCandidate(b) && b.repoDir === dir).sort(byCard);
    if (!candidates.length) { bases[dir] = defaultBase(repo); continue; }
    const found = maximal(git, cwd, candidates);
    const unknown = cards => asks.push({
      code: 'bases-unknown', repoDir: dir, cards, paths: [],
      message: `${dir}: the head commit of ${cards.join(', ')} is not in the checkout, so its base cannot be decided; fetch it or treat it as unbuilt`,
      answers: ['fetch', ...cards.map(c => `--unbuilt ${c}`)],
    });
    if (found.missing) { unknown(found.missing.map(c => c.key)); continue; }
    const tops = found.tops.sort(byCard);
    let base;
    if (tops.length === 1) {
      const [top] = tops;
      base = {
        kind: top.kind, ref: headRef(top), sha: top.sha, card: top.key, heads: null, tree: null,
        behind: present(git, cwd, top.sha) ? behindDefault(git, cwd, repo, refs.get(dir), [top.sha]) : null, ownCommits: ownCommits(git, cwd, repo, refs.get(dir), top.sha),
      };
    } else {
      const heads = tops.map(t => ({ card: t.key, kind: t.kind, ref: headRef(t), sha: t.sha, ownCommits: ownCommits(git, cwd, repo, refs.get(dir), t.sha) }));
      const combined = combineInTemp(git, cwd, heads, tmpRoot);
      if (combined.missing) { unknown(combined.missing.map(h => h.card)); continue; }
      if (combined.conflict) {
        const { cards, paths } = combined.conflict;
        asks.push({
          code: 'combine-conflict', repoDir: dir, cards, paths,
          message: `${dir}'s built branches ${cards.join(', ')} conflict on ${paths.join(', ') || 'their merge bases'}: which card should be treated as unbuilt (replayed or re-spiked)?`,
          answers: cards.map(c => `--unbuilt ${c}`),
        });
        continue;
      }
      base = { kind: 'combine', ref: null, sha: heads[0].sha, card: null, heads, tree: combined.tree, behind: behindDefault(git, cwd, repo, refs.get(dir), heads.map(h => h.sha)), ownCommits: null };
    }
    const tip = refs.get(dir)?.tracking?.[repo.defaultBranch];
    if (withDefault.has(dir) && base.behind > 0 && tip) {
      const heads = [...(base.heads ?? [{ card: base.card, kind: base.kind, ref: base.ref, sha: base.sha, ownCommits: base.ownCommits }]),
        { card: null, kind: 'default', ref: `${repo.remote}/${repo.defaultBranch}`, sha: tip }];
      const combined = combineInTemp(git, cwd, heads, tmpRoot);
      if (combined.conflict || combined.missing) {
        const cards = heads.map(h => h.card).filter(Boolean);
        asks.push({
          code: 'default-conflict', repoDir: dir, cards, paths: combined.conflict?.paths ?? [],
          message: `${dir}'s base does not merge with ${repo.remote}/${repo.defaultBranch}${combined.conflict?.paths?.length ? ` on ${combined.conflict.paths.join(', ')}` : ''}: drop --with-default ${dir}, or treat a card as unbuilt`,
          answers: [`drop --with-default ${dir}`, ...cards.map(c => `--unbuilt ${c}`)],
        });
        continue;
      }
      base = { kind: 'combine', ref: null, sha: heads[0].sha, card: null, heads, tree: combined.tree, behind: 0, ownCommits: null };
    }
    base.warning = base.behind ? `base ${base.behind} commits behind default` : null;
    if (base.behind) warnings.push({ code: 'base-behind-default', repo: dir, behind: base.behind, message: `${dir}: ${base.warning}` });
    bases[dir] = base;
  }
  return { bases, asks, warnings };
}
