import { isExecutionCard } from '../graph.mjs';
import { localWork, startedBy } from '../next/clones.mjs';
import { pullRequests } from '../next/github.mjs';
import { allowedRepos } from '../spike/config.mjs';
import { isMerged, isOpen } from '../start/base.mjs';

export const MERGED_LEFT = 0.1;
export const OPEN_PR_LEFT = 0.25;
export const BRANCH_LEFT = 0.5;

const LEFT = { merged: MERGED_LEFT, pr: OPEN_PR_LEFT, branch: BRANCH_LEFT };
const PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const short = p => `${p.github.split('/').pop()}#${p.number}`;
const latest = list => list.reduce((a, b) => (Date.parse(b.mergedAt) > Date.parse(a.mergedAt) ? b : a));

// Each repo the card touches is judged alone; the card is as built as its least built repo. Once a PR is merged into the
// default branch, an open PR into another branch is its [Prod] port, not more work; one more into the default branch is.
function repoState(prs, defaultOf) {
  const intoDefault = prs.filter(p => isMerged(p) && (!defaultOf(p) || p.baseRefName === defaultOf(p)));
  const counts = p => isOpen(p) && (!intoDefault.length || !defaultOf(p) || p.baseRefName === defaultOf(p));
  const open = prs.filter(counts).sort((a, b) => b.number - a.number)[0];
  if (open) return { kind: 'pr', evidence: `${open.isDraft ? 'draft PR' : 'PR'} ${short(open)}`, mergedAt: null };
  if (intoDefault.length) {
    const pr = latest(intoDefault);
    return { kind: 'merged', evidence: `merged ${short(pr)}`, mergedAt: pr.mergedAt };
  }
  // Merged into another card's branch: the code waits on that branch's own PR.
  const stacked = prs.find(isMerged);
  if (stacked) return { kind: 'pr', evidence: `${short(stacked)} merged into ${stacked.baseRefName}`, mergedAt: null };
  return null;
}

// Cards to read: the team's open execution cards, the ones that can still carry remaining work.
export function buildKeys(raw, team) {
  const cards = (raw.issues ?? []).filter(i => i.team?.id === team.id && isExecutionCard(i) && !['completed', 'canceled'].includes(i.state?.type));
  const attachments = new Map(cards
    .map(i => [i.identifier, (i.attachments?.nodes ?? []).map(a => a?.url).filter(url => PULL.test(url ?? ''))])
    .filter(([, urls]) => urls.length));
  return { keys: cards.map(i => i.identifier), attachments };
}

// Reads what is built the way /next does: GitHub PRs (drafts included) across every repo of the project, then pushed and
// local branches. A failed read is a warning, and the cards it could hide fall back to their Linear state.
export function readBuilt({ raw, team, config, gh, git, listDir }) {
  const { keys, attachments } = buildKeys(raw, team);
  const repoDirs = allowedRepos(config, raw.project.slug);
  const repos = repoDirs.map(dir => ({ dir, github: config.repos[dir]?.github ?? null }));
  const known = Object.entries(config.repos).map(([dir, r]) => ({ dir, github: r.github ?? null }));
  const prs = pullRequests(gh, { repos, known, keys, offMapKeys: [], attachments });
  const work = localWork(git, { config, repoDirs, ...(listDir ? { listDir } : {}) });
  const defaultOf = p => (p.repoDir ? config.repos[p.repoDir]?.defaultBranch ?? null : null);
  const built = new Map();
  for (const key of keys) {
    const state = builtState(key, prs.byKey.get(key) ?? [], work, defaultOf);
    if (state) built.set(key, state);
  }
  const warnings = [
    ...[...prs.failed.values()],
    ...[...prs.failedFor].map(([key, message]) => `${key}: ${message}`),
    ...[...work.failed.values()],
  ].map(message => `build state may be incomplete: ${message}`);
  return { built, warnings };
}

export function builtState(key, prs, work, defaultOf) {
  const byRepo = new Map();
  for (const p of prs) byRepo.set(p.github.toLowerCase(), [...(byRepo.get(p.github.toLowerCase()) ?? []), p]);
  const states = [...byRepo.values()].map(list => repoState(list, defaultOf)).filter(Boolean);
  // A branch speaks only for a card with no PR at all: a merged card's branch often outlives its merge.
  if (!prs.length) {
    const started = startedBy(work, key);
    if (started) states.push({ kind: 'branch', evidence: `branch ${started.name} ${started.where === 'local' ? 'local' : 'pushed'}`, mergedAt: null });
  }
  if (!states.length) return null;
  const least = states.reduce((a, b) => (LEFT[b.kind] > LEFT[a.kind] ? b : a));
  const fraction = LEFT[least.kind];
  const mergedAt = least.kind === 'merged' ? states.map(s => s.mergedAt).sort().at(-1) : null;
  return { kind: least.kind, fraction, evidence: states.map(s => s.evidence).join(', '), mergedAt };
}
