export const isMerged = p => Boolean(p.mergedAt) || /^merged$/i.test(p.state ?? '');
export const isOpen = p => !isMerged(p) && /^open$/i.test(p.state ?? '');

const UNSTARTED = new Set(['backlog', 'unstarted', 'triage']);
const CLOSED = new Set(['completed', 'canceled']);

const result = (status, pr = null, warning = null, branch = null) => ({ status, pr, warning, branch });

const where = b => (b.where === 'local' ? 'only in this checkout' : 'pushed');

export function classifyBlocker(blocker, { currentRepoDir, defaultBranchOf }) {
  if (blocker.skipped) return result('skipped');
  // A read that failed may hide the PR that decides, so nothing found alongside it counts.
  if (blocker.lookupFailed) return result('unverified', null, `its PRs or branch could not be read: ${blocker.lookupFailed}`);
  const prs = blocker.prs ?? [];
  const intoDefault = p => {
    const target = p.repoDir ? defaultBranchOf(p.repoDir) : null;
    return target ? p.baseRefName === target : true;
  };
  const merged = prs.find(p => isMerged(p) && intoDefault(p));
  if (merged) {
    const target = merged.repoDir ? defaultBranchOf(merged.repoDir) : null;
    const warning = !target ? `merged into ${merged.baseRefName}; ${merged.github} is not configured, so any base counts`
      : blocker.linearState?.type !== 'completed' ? `merged, still open in Linear (${blocker.linearState?.name ?? 'unknown state'})` : null;
    return result('merged', merged, warning);
  }
  // A draft is stacked on like any open PR; a ready one wins when both exist.
  const open = prs.filter(isOpen).sort((a, b) => Number(Boolean(a.isDraft)) - Number(Boolean(b.isDraft)));
  const here = open.find(p => p.repoDir === currentRepoDir);
  if (here) return result('open', here, here.isDraft ? `PR #${here.number} is a draft` : null);
  if (open.length) return result('open-other-repo', open[0], `PR #${open[0].number} is open in ${open[0].github}; a branch cannot be stacked across repos`);
  const elsewhere = prs.find(isMerged);
  if (elsewhere) return result('merged-into-branch', elsewhere, `PR #${elsewhere.number} merged into ${elsewhere.baseRefName}, not the default branch`);
  // A branch the user named outranks the ones found by the blocker's id; several candidates are the user's pick.
  // A found branch of a card Linear closed is likely a leftover, so only a named one is stacked on.
  const branches = blocker.branches ?? [];
  const given = branches.filter(b => b.via === 'given');
  const candidates = given.length ? given : branches;
  if (!given.length && candidates.length && CLOSED.has(blocker.linearState?.type)) {
    return result('unverified', null, `Linear says ${blocker.linearState.name ?? 'closed'} with no merged PR, but branches carry its id: ${candidates.map(b => b.name).join(', ')}; name one with --blocker-branch, or skip it`);
  }
  if (candidates.length === 1) return result('branch', null, `no PR: branch ${candidates[0].name} (${where(candidates[0])}) is the base`, candidates[0]);
  if (candidates.length > 1) return result('unverified', null, `no PR, and several branches carry its id: ${candidates.map(b => b.name).join(', ')}; name one with --blocker-branch`);
  if (UNSTARTED.has(blocker.linearState?.type)) return result('unstarted');
  return result('unverified', null, `Linear says ${blocker.linearState?.name ?? 'unknown'} but GitHub shows no PR or branch`);
}

const WAIT = new Set(['merged-into-branch', 'open-other-repo']);

export const STACK_COSTS = [
  'no preview deployment: the default-branch pipeline does not build a stacked PR',
  'when the base PR merges: retarget this PR by hand and rebase the stack bottom-up',
];
export const DRAFT_COST = 'the base PR is a draft: it must be marked ready and merge before this one';
export const NO_PR_COST = 'the base branch has no PR yet: its PR opens first, and this one targets it';
export const LOCAL_COST = 'the base branch is only in this checkout: push it before pushing this branch';

// A stack candidate: an open PR, or a blocker branch with no PR (number null).
const fromPr = p => ({ headRefName: p.headRefName, baseRefName: p.baseRefName, number: p.number, url: p.url, title: p.title, repoDir: p.repoDir ?? null, isDraft: Boolean(p.isDraft), local: false });
const fromBranch = b => ({ headRefName: b.name, baseRefName: null, number: null, url: null, title: null, repoDir: null, isDraft: false, local: b.where === 'local' });

function costsOf(top) {
  if (top.number === null) return [STACK_COSTS[0], NO_PR_COST, ...(top.local ? [LOCAL_COST] : [])];
  return top.isDraft ? [...STACK_COSTS, DRAFT_COST] : STACK_COSTS;
}

const keysOf = blockers => blockers.map(b => b.key).join(', ');
const none = (kind, note, pushReviews = []) => ({ kind, ref: null, branch: null, pr: null, pushReviews, costs: [], note });
const review = p => (p.number === null ? { branch: p.headRefName } : { repoDir: p.repoDir ?? null, number: p.number, title: p.title, url: p.url });

// A top contains another PR when following base links from it reaches that PR's head, or `contains` says so (null = unknown).
export function chainTop(prs, contains) {
  const byHead = new Map(prs.map(p => [p.headRefName, p]));
  const linkedBelow = top => {
    const seen = new Set();
    for (let p = byHead.get(top.baseRefName); p && !seen.has(p.headRefName); p = byHead.get(p.baseRefName)) seen.add(p.headRefName);
    return seen;
  };
  const linked = prs.find(top => linkedBelow(top).size === prs.length - 1);
  if (linked) return { top: linked };
  let unknown = false;
  for (const top of prs) {
    const below = linkedBelow(top);
    const answers = prs.filter(p => p !== top).map(p => below.has(p.headRefName) || contains(top, p));
    if (answers.every(x => x === true)) return { top };
    if (answers.some(x => x === null)) unknown = true;
  }
  return unknown ? { unknown: true } : { diverged: true };
}

export function decideBase(blockers, { remote, defaultBranch, chainOf }) {
  const active = blockers.filter(b => b.status !== 'skipped');
  const having = test => active.filter(b => test(b.status));
  const unstarted = having(s => s === 'unstarted');
  if (unstarted.length) return none('stop', `${keysOf(unstarted)} has not started: this card may be ordered before its blocker`);
  const waiting = having(s => WAIT.has(s));
  if (waiting.length) return none('wait', `wait for ${keysOf(waiting)}: no usable base yet`);
  const unverified = having(s => s === 'unverified');
  if (unverified.length) return none('ask', `${keysOf(unverified)}: no single PR or branch of it to stack on; name its PR or branch, or skip it`);
  const stackable = [
    ...having(s => s === 'open').map(b => fromPr(b.pr)),
    ...having(s => s === 'branch').map(b => fromBranch(b.branch)),
  ];
  const open = [...new Map(stackable.map(c => [`${c.local}:${c.headRefName}`, c])).values()];
  if (!open.length) return { kind: 'default', ref: `${remote}/${defaultBranch}`, branch: defaultBranch, pr: null, pushReviews: [], costs: [], note: null };
  const chain = open.length === 1 ? { top: open[0] } : chainOf(open);
  if (chain.top) {
    const top = chain.top;
    const ref = top.local ? `refs/heads/${top.headRefName}` : `${remote}/${top.headRefName}`;
    const pr = top.number === null ? null : { number: top.number, url: top.url };
    return { kind: 'stack', ref, branch: top.headRefName, pr, pushReviews: [], costs: costsOf(top), note: null };
  }
  if (chain.unknown) return none('wait', `${open.length} blocker bases and their heads are not all fetched: fetch to decide`);
  return none('wait', `${open.length} blocker bases on independent branches: push these reviews first`, open.map(review));
}
