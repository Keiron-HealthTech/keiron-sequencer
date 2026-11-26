import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { exitError } from '../cli.mjs';
import { analyzeProject } from '../graph.mjs';
import { canonicalJson } from '../harvest.mjs';
import { fetchProjectMap, fetchStartIssue } from '../linear-fetch.mjs';
import { dataInRepoWarning, isLive, readRecords } from '../records.mjs';
import { allowedRepos, loadConfig } from '../spike/config.mjs';
import { packStale, readPack } from '../packs.mjs';
import { displayData } from '../spike/home.mjs';
import { runChain } from '../spike/run-base.mjs';
import { markers } from '../next/text.mjs';
import { chainTop, classifyBlocker, decideBase, gateText } from './base.mjs';
import { buildBrief, decisionGates, recordNote, resolvePatches } from './brief.mjs';
import { cardRepos, carriesKey, currentCheckout, findResume, givenBranch, mapRepo, prsFor, refContains, remoteHeads, repoMatch, uniquePrs } from './checkout.mjs';
import { branchNameFor, startSettings } from './config.mjs';
import { routeFor, verdictFor } from './route.mjs';
import { notComputed as staleNotComputed, staleness, stalenessFiles } from './staleness.mjs';

export function approveHash(plan) {
  const hashed = {
    card: plan.card.key,
    action: plan.action,
    reasons: plan.reasons.map(r => r.code),
    base: { kind: plan.base.kind, ref: plan.base.ref },
    branch: { name: plan.branch.name, rule: plan.branch.rule },
    checkout: { path: plan.checkout.path, head: plan.checkout.head, branch: plan.checkout.branch, dirty: plan.checkout.dirty },
    resume: plan.resume.branches.map(b => b.name),
  };
  return createHash('sha256').update(canonicalJson(hashed)).digest('hex').slice(0, 12);
}

const NO_FLAGS = { blockers: [], blockerPrs: [], blockerBranches: [], skip: [] };

const reason = (code, message, blocking = true) => ({ code, message, blocking });

const notComputed = note => ({ kind: null, ref: null, branch: null, pr: null, pushReviews: [], costs: [], note });
const NO_RESUME = { found: false, branches: [], prs: [], elsewhere: [], remote: null };

const CLOSED = new Set(['completed', 'canceled']);

const knownRepos = config => Object.entries(config.repos).map(([dir, r]) => ({ dir, github: r.github ?? null }));

function checkoutView(checkout, settings) {
  const { branches, worktrees, tracking, unconfigured, notGit, ...shown } = checkout;
  return {
    ...shown, name: settings?.name ?? null, remote: settings?.remote ?? null, defaultBranch: settings?.defaultBranch ?? null,
    defaultBranchLocal: shown.defaultBranchLocal ?? null, notes: settings?.notes ?? [],
  };
}

// onMap null: the card has no project, so there is no map to be on.
export function cardReasons(issue, onMap) {
  if (issue.archivedAt || CLOSED.has(issue.state?.type)) {
    return [reason('card-closed', `${issue.key} is ${issue.archivedAt ? 'archived' : issue.state.name} in Linear`)];
  }
  if (onMap && !onMap.has(issue.key)) return [reason('not-execution-card', `${issue.key} is not an execution card of the project map`)];
  return [];
}

const NO_MAP = { cards: [], edges: [] };
const NO_PROJECT = 'no project';

function repoReasons(issue, checkout, config, found, warnings) {
  if (checkout.unconfigured) {
    const why = checkout.notGit ? 'is not a git checkout, so it is no repo of the keiron-sequencer config' : 'is not the checkout of any repo in the keiron-sequencer config';
    return { reasons: [reason('repo-unconfigured', `${checkout.path} ${why}`)], repos: found };
  }
  const current = { dir: checkout.repoDir, name: config.repos[checkout.repoDir].name ?? checkout.repoDir };
  const { repos, wrongRepo, warning } = repoMatch(found, current);
  if (warning) warnings.push(warning);
  if (!wrongRepo) return { reasons: [], repos };
  const message = `${issue.key} belongs to ${wrongRepo.join(', ')}, not ${current.name}; start it from that checkout`;
  const checkouts = repos.map(r => ({ dir: r.dir, name: r.name, github: config.repos[r.dir]?.github ?? null, checkout: config.repos[r.dir]?.checkout ?? null }));
  return { reasons: [{ ...reason('wrong-repo', message), checkouts }], repos };
}

// A card the card only ships after ("Sale después de" in its text) needs none of its code: it is a gate on merging and
// deploying until it is done, never a blocker, unless the user names it with --blocker.
async function gatherBlockers(cardKey, analyzed, flags, { key, fetchImpl, description }, warnings) {
  const card = analyzed.cards.find(c => c.key === cardKey);
  const after = new Set(markers(description).after.filter(k => k !== cardKey && !flags.blockers.includes(k)));
  const listed = new Map();
  const add = (k, source) => { if (k !== cardKey && !listed.has(k) && !after.has(k)) listed.set(k, source); };
  for (const e of analyzed.edges) if (e.to === cardKey) add(e.from, 'linear');
  for (const k of card?.offMapBlockers ?? []) add(k, 'off-project');
  for (const k of flags.blockers) add(k, 'given');
  const gates = [];
  for (const k of [...after].sort()) {
    const issue = await fetchStartIssue(k, key, { fetchImpl });
    if (!issue) { warnings.push(`${cardKey} ships after ${k}, but Linear has no such card`); continue; }
    if (issue.archivedAt || ['completed', 'canceled'].includes(issue.state?.type)) continue;
    gates.push({ kind: 'card', card: k, text: gateText(k), state: issue.state });
  }
  const skip = new Set(flags.skip);
  const skippedBlockers = [...listed].filter(([k]) => skip.has(k)).map(([k, source]) => ({ key: k, source }));
  const blockers = [];
  for (const [k, source] of listed) {
    if (skip.has(k)) continue;
    const issue = await fetchStartIssue(k, key, { fetchImpl });
    if (!issue) throw exitError(1, `${k} was not found in Linear`);
    const closedAs = issue.archivedAt ? 'archived' : issue.state?.type === 'canceled' ? 'canceled' : null;
    if (source === 'given' && closedAs) {
      warnings.push(`--blocker ${k}: ${closedAs} in Linear, ignored`);
      continue;
    }
    blockers.push({ key: k, title: issue.title, source, linearState: issue.state, attachments: issue.attachments });
  }
  const known = new Set([...listed.keys()]);
  for (const [flag, keys] of [['--blocker-pr', flags.blockerPrs.map(p => p.key)], ['--blocker-branch', flags.blockerBranches.map(b => b.key)], ['--skip-blocker', flags.skip]]) {
    for (const k of new Set(keys)) if (!known.has(k)) warnings.push(`${flag} ${k}: not a blocker of ${cardKey}, ignored`);
  }
  return { blockers, skippedBlockers, gates };
}

// Branches found by a blocker's id: pushed ones, then ones only in this checkout; never one that carries the card's own id.
function branchesOf(key, cardKey, { heads, local }) {
  const mine = name => carriesKey(name, key) && !carriesKey(name, cardKey);
  const pushed = Object.keys(heads).filter(mine).sort();
  const localOnly = local.filter(n => mine(n) && !(n in heads)).sort();
  return [...pushed.map(name => ({ name, where: 'remote', via: 'ls-remote' })), ...localOnly.map(name => ({ name, where: 'local', via: 'local' }))];
}

function lookUpBlockers(blockers, flags, { git, gh, cwd, settings, config, slug, heads, local, cardKey }, warnings) {
  const known = knownRepos(config);
  const search = allowedRepos(config, slug).map(dir => ({ dir, github: config.repos[dir]?.github ?? null }));
  return blockers.map(({ attachments, ...b }) => {
    const given = flags.blockerPrs.filter(p => p.key === b.key).map(p => p.url);
    const found = prsFor(gh, { key: b.key, search, known, attachments: attachments ?? [], given });
    const failures = found.unavailable ? [found.unavailable] : [];
    let prs = found.prs;
    const named = [];
    for (const { branch } of flags.blockerBranches.filter(x => x.key === b.key)) {
      const out = givenBranch(git, gh, { cwd, remote: settings.remote, github: settings.github, branch, known, local });
      if (!out.found) { warnings.push(`${b.key}: ${out.warning}`); continue; }
      prs = uniquePrs([...prs, ...out.prs]);
      if (out.branch && !named.some(x => x.name === out.branch.name)) named.push(out.branch);
      if (out.unavailable) failures.push(out.unavailable);
    }
    const branches = [...named, ...branchesOf(b.key, cardKey, { heads, local }).filter(x => !named.some(g => g.name === x.name))];
    return { ...b, prs, branches, lookupFailed: failures.join('; ') || null };
  });
}

function siblingsOf(cardKey, analyzed, milestone) {
  const byKey = new Map(analyzed.cards.map(c => [c.key, c]));
  const dependents = analyzed.edges.filter(e => e.from === cardKey && byKey.has(e.to))
    .map(e => byKey.get(e.to)).map(c => ({ key: c.key, title: c.title, status: c.status }));
  if (!milestone) return { dependents, milestone: null };
  const inMilestone = analyzed.cards.filter(c => c.milestone === milestone);
  const done = inMilestone.filter(c => c.statusType === 'completed').length;
  return { dependents, milestone: { name: milestone, open: inMilestone.length - done, done } };
}

const isLocalRef = ref => Boolean(ref?.startsWith('refs/heads/'));

function fetchOf(settings, base) {
  if (!settings) return { remote: null, refs: [], lastFetch: 'unknown' };
  const pushed = base.ref && !isLocalRef(base.ref) ? base.ref : null;
  const refs = [...new Set([`${settings.remote}/${settings.defaultBranch}`, pushed].filter(Boolean))];
  return { remote: settings.remote, refs, lastFetch: 'unknown' };
}

function planStaleness(git, { cwd, settings, config, checkout, base, record, patches, home, slug, onMap, blockers, cardKey, otherRepos }) {
  const here = checkout.repoDir;
  const isCurrent = dir => mapRepo(config, dir)?.dir === here;
  const patchDir = patches.find(p => isCurrent(p.repoDir))?.repoDir ?? here;
  const { baseCommit, patchTexts, chainedFiles, combine } = runChain(record, { home, slug, repoDir: here, patchDir });
  return staleness(git, {
    cwd, remote: settings.remote, baseRef: base.branch ?? settings.defaultBranch, local: isLocalRef(base.ref), tracking: checkout.tracking,
    ...stalenessFiles({ patches, record, isCurrent }),
    spikedAt: record.spikedAt, baseCommit, patchTexts, chainedFiles, combine,
    projectKeys: [...onMap, ...blockers.map(b => b.key)], cardKey,
    blockerPrNumbers: blockers.filter(b => b.status === 'merged' && b.pr?.repoDir === here).map(b => b.pr.number),
    unchecked: otherRepos.map(r => r.name),
  });
}

// The card's decision pack, when one was drafted: binding answers and the questions still open.
function packOf(dataDir, slug, { issue, record, bases }) {
  const pack = record ? readPack(dataDir, slug, record.card) : null;
  if (!pack) return null;
  const stale = packStale(pack, { issue, record, bases });
  return {
    fresh: !stale, stale,
    answered: pack.questions.filter(q => q.answer).map(q => ({ text: q.text, outcome: q.answer.outcome })),
    open: pack.questions.filter(q => !q.answer).map(q => ({ id: q.id, text: q.text, evidence: q.evidence, options: q.options })),
  };
}

const BASE_REASON = {
  stop: () => 'unstarted-blocker',
  wait: base => (base.pushReviews.length ? 'push-reviews' : 'wait-blocker'),
  ask: () => 'unverified-blocker',
};

const OWN_PR = {
  'pr-merged': 'a PR of this card is already merged; creating a branch starts the card again',
  'pr-closed': 'a PR of this card was closed without merging; creating a branch starts the card again',
};

function decideAction(cardStopped, resume, base, branch) {
  if (cardStopped) return 'stop';
  if (resume.found) return 'resume';
  if (resume.ask.length) return 'ask';
  if (BASE_REASON[base.kind]) return base.kind;
  if (!branch.name) return 'stop';
  return 'create';
}

export async function buildPlan(cardKey, { key, fetchImpl, git, gh, home, dataDir, repoDataDir = null, cwd, flags = NO_FLAGS }) {
  let config;
  try {
    config = loadConfig(home);
  } catch (e) {
    throw exitError(2, e.message);
  }
  const issue = await fetchStartIssue(cardKey, key, { fetchImpl });
  if (!issue) throw exitError(1, `${cardKey} was not found in Linear`);
  // A card with no project has no map, records, pack or staleness; what applies to any card still runs.
  const noProject = !issue.project?.id;
  const raw = noProject ? null : await fetchProjectMap(issue.project.id, key, { fetchImpl });
  const slug = raw?.project.slug ?? null;
  const checkout = currentCheckout(git, config, cwd);
  const started = checkout.unconfigured ? {} : startSettings(config, checkout.repoDir);
  if (started.errors) throw exitError(2, started.errors.join('; '));
  const { settings } = started;
  const analyzed = raw ? analyzeProject(raw) : NO_MAP;
  const onMap = new Set(analyzed.cards.map(c => c.key));
  const { records } = raw ? readRecords(join(dataDir, slug)) : { records: [] };
  const live = records.filter(r => isLive(r) && onMap.has(r.card));
  const record = live.find(r => r.card === cardKey) ?? null;
  const warnings = [];
  const moved = raw && dataInRepoWarning({ dataDir, repoDataDir, slug, display: displayData(dataDir, slug) });
  if (moved) warnings.push(moved.message);
  const patches = resolvePatches(record, { home, slug });
  for (const p of patches.filter(x => !x.location)) warnings.push(`patches unavailable: ${p.ref} is in neither the run dir nor the trial dir`);
  const repoCheck = repoReasons(issue, checkout, config, cardRepos(issue, record, record?.refs.patches ?? [], config), warnings);
  const reasons = [...cardReasons(issue, noProject ? null : onMap), ...repoCheck.reasons];
  const cardStopped = reasons.length > 0;
  if (noProject) {
    reasons.push(reason('no-project', `${issue.key} has no Linear project: the plan skips the project map, the spike record, the decision pack and the staleness`, false));
  }
  const branch = branchNameFor(settings?.branchNaming ?? null, issue.gitBranchName, issue.key);
  let blockers = [];
  let skippedBlockers = [];
  let cardGates = [];
  let base = notComputed('not decided: the plan stops before the base');
  let resume = { ...NO_RESUME, ask: [], unavailable: null };
  const otherRepos = repoCheck.repos.filter(r => !r.dir || r.dir !== checkout.repoDir);
  let stale = staleNotComputed('the plan stops at the card');
  if (!cardStopped) {
    if (noProject) warnings.push(`${issue.key} has no project map, so no Linear blocks relation was read: only the --blocker flags give it blockers`);
    const gathered = await gatherBlockers(cardKey, analyzed, flags, { key, fetchImpl, description: issue.description }, warnings);
    skippedBlockers = gathered.skippedBlockers;
    cardGates = gathered.gates;
    const heads = remoteHeads(git, { cwd, remote: settings.remote });
    const ctx = { currentRepoDir: checkout.repoDir, defaultBranchOf: dir => config.repos[dir]?.defaultBranch ?? null };
    const local = checkout.branches.local;
    blockers = lookUpBlockers(gathered.blockers, flags, { git, gh, cwd, settings, config, slug, heads, local, cardKey }, warnings)
      .map(b => {
        const { status, pr, warning, branch: base } = classifyBlocker(b, ctx);
        return { ...b, status, warning, pr, branch: base };
      });
    resume = findResume(gh, {
      github: settings.github, cardKey, branchName: branch.name, attachments: issue.attachments, checkout, heads, known: knownRepos(config),
    });
    for (const code of resume.ask) reasons.push(reason(code, OWN_PR[code]));
    const contains = refContains(git, { cwd, remote: settings.remote, tracking: checkout.tracking, heads, local });
    base = decideBase(blockers, { ...settings, chainOf: prs => chainTop(prs, contains) });
    stale = record ? planStaleness(git, { cwd, settings, config, checkout, base, record, patches, home, slug, onMap, blockers, cardKey, otherRepos })
      : staleNotComputed(noProject ? NO_PROJECT : 'no record');
    const code = BASE_REASON[base.kind]?.(base);
    if (code) reasons.push(reason(code, base.note));
    if (!branch.name) reasons.push(reason('no-branch-name', `${issue.key} has no branch name to start from`));
    const failed = [...blockers.filter(b => b.lookupFailed).map(b => `${b.key}: ${b.lookupFailed}`), ...(resume.unavailable ? [`${cardKey}: ${resume.unavailable}`] : [])];
    if (failed.length) reasons.push(reason('gh-unavailable', failed.join('; '), false));
  }
  const verdict = noProject ? { value: NO_PROJECT, tier: null, label: null } : verdictFor(live, cardKey);
  const siblings = siblingsOf(cardKey, analyzed, issue.milestone);
  const bases = settings && checkout.repoDir ? { [checkout.repoDir]: checkout.tracking?.[settings.defaultBranch] ?? null } : {};
  const pack = noProject ? null : packOf(dataDir, slug, { issue, record, bases });
  if (checkout.dirty > 0) reasons.push(reason('dirty-checkout', `${checkout.dirty} uncommitted or untracked file(s) in the checkout`, false));
  const plan = {
    action: decideAction(cardStopped, resume, base, branch),
    reasons,
    card: {
      key: issue.key, id: issue.id, title: issue.title, url: issue.url, state: issue.state, gitBranchName: issue.gitBranchName,
      project: raw && { slug, name: raw.project.name, url: raw.project.url }, milestone: issue.milestone, repos: repoCheck.repos,
      description: issue.description, comments: issue.comments, commentsTruncated: issue.commentsTruncated,
    },
    checkout: checkoutView(checkout, settings),
    siblings,
    blockers: blockers.map(({ pr, lookupFailed, ...b }) => b),
    skippedBlockers,
    gates: [...cardGates, ...decisionGates(record)],
    base,
    fetch: fetchOf(settings, base),
    branch,
    resume: (({ ask, unavailable, ...shown }) => shown)(resume),
    verdict,
    route: routeFor({ verdict, record, siblings, pack }, issue.gitBranchName),
    brief: buildBrief({
      record, size: verdict, patches,
      recordNote: record ? null
        : noProject ? 'no record: the card has no Linear project'
        : onMap.has(cardKey) ? recordNote(records, cardKey) : 'no record: the card is not on the execution map',
      otherRepos,
      pack,
      cardGates,
    }),
    staleness: stale,
    typecheck: { configured: Boolean(settings?.typecheck.length), commands: settings?.typecheck ?? [] },
    warnings,
  };
  return { schemaVersion: 1, approve: approveHash(plan), ...plan };
}

export async function approvedPlan(cardKey, hash, deps) {
  const plan = await buildPlan(cardKey, deps);
  if (plan.approve === hash) return { plan };
  return { refused: `the plan changed since it was approved (approved ${hash}, now ${plan.approve}): show the new plan and confirm again` };
}
