import { chainTop, classifyBlocker, decideBase, gateText, isMerged, isOpen } from '../start/base.mjs';
import { cardRepos, carriesKey } from '../start/checkout.mjs';
import { startedBy } from './clones.mjs';
import { markers, textEdges } from './text.mjs';

const STARTABLE = new Set(['backlog', 'unstarted']);
const NEVER_BLOCK_LABELS = new Set(['qa', 'map', 'map:design-delivery']);
const UNFETCHED = 'blocker heads not fetched here; start fetches and decides';

const neverBlocks = off => Boolean(off.archivedAt) || off.state?.type === 'canceled'
  || off.labels.some(l => NEVER_BLOCK_LABELS.has(String(l).toLowerCase()))
  || /^QA(\s*:|$)/i.test(String(off.title ?? '').trim());

function reachable(adjacency, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adjacency.get(n) ?? []));
  }
  return false;
}

// Classifies every open card: free (startable now, with its base) or, when overdue, why it is not.
// decisionGates: card -> the texts of its record's gate open decisions.
export function classify({ cards, edges, critical = [], criticalTies = [], offMap, descriptions, viewer, prs, work, config, decisionGates = new Map() }) {
  const onMap = new Map(cards.map(c => [c.key, c]));
  const onPath = new Set([...critical, ...criticalTies]);
  const warnings = [];
  const describe = key => descriptions.get(key) ?? '';
  const repoOf = key => {
    const c = onMap.get(key);
    return cardRepos({ title: c?.title ?? '', description: describe(key) }, null, [], config).find(r => r.dir)?.dir ?? null;
  };
  const githubOf = dir => (dir ? config.repos[dir]?.github ?? null : null);

  const adjacency = new Map();
  const link = (from, to) => adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  for (const e of edges) link(e.from, e.to);
  for (const c of cards) for (const b of c.offMapBlockers ?? []) link(b, c.key);
  const text = textEdges(descriptions);
  const textOnly = text.filter(e => !reachable(adjacency, e.from, e.to));
  for (const e of textOnly) {
    if (onMap.get(e.to)?.rank != null) warnings.push({ key: e.to, kind: 'text-only-dependency', message: `move it to Linear: ${e.from} blocks ${e.to}` });
  }
  for (const [github, message] of prs.failed) warnings.push({ key: github, kind: 'github-unavailable', message });
  for (const [dir, message] of work.failed) warnings.push({ key: dir, kind: 'git-unavailable', message });
  warnings.push(...(work.notes ?? []));

  // A failed read only taints the cards whose answer could be in it; an unknown repo could be in any.
  const ghFailed = new Map([...prs.failed].map(([github, message]) => [github.toLowerCase(), message]));
  const ghFailure = dir => {
    const github = githubOf(dir)?.toLowerCase();
    if (github) return ghFailed.get(github) ?? null;
    return ghFailed.size ? [...ghFailed.values()].join('; ') : null;
  };
  const cardFailure = key => prs.failedFor?.get(key) ?? null;
  const gitFailure = dir => {
    if (dir) return work.failed.get(dir) ?? null;
    return work.failed.size ? [...work.failed.values()].join('; ') : null;
  };

  function ownReason(c, own) {
    const m = markers(describe(c.key));
    if (c.labels.some(l => String(l).toLowerCase() === 'discovery')) return { reason: 'excluded', detail: 'Discovery' };
    if (m.noPr) return { reason: 'excluded', detail: 'No lleva PR' };
    const open = own.filter(isOpen);
    const ready = open.find(p => !p.isDraft);
    if (ready) return { reason: 'in-review', detail: `PR #${ready.number} open in ${ready.github}` };
    if (open.length) return { reason: 'taken', detail: `draft PR #${open[0].number} in ${open[0].github}` };
    const started = startedBy(work, c.key);
    if (started?.where === 'local') return { reason: 'started-local', detail: `branch ${started.name} in ${started.path}` };
    if (started) return { reason: 'started-remote', detail: `branch ${started.name} pushed` };
    if (c.statusType === 'triage') return { reason: 'triage', detail: `Linear says ${c.status}: accept it into the backlog first` };
    if (!STARTABLE.has(c.statusType)) return { reason: 'started-linear', detail: `Linear says ${c.status}` };
    if (c.assignee && c.assignee.id !== viewer.id) return { reason: 'assigned-other', detail: c.assignee.name };
    return null;
  }

  function blockerKeys(c) {
    const keys = new Set([
      ...edges.filter(e => e.to === c.key).map(e => e.from),
      ...(c.offMapBlockers ?? []),
      ...text.filter(e => e.to === c.key).map(e => e.from),
    ]);
    keys.delete(c.key);
    return [...keys];
  }

  // Branches a blocker could be stacked from: pushed, or local in the configured checkout start runs in.
  // With no repo for the card, every repo's pushed heads count, so a blocker is never missed.
  function branchesOf(key, cardKey, dir) {
    const repos = dir ? [work.repos.get(dir)].filter(Boolean) : [...work.repos.values()];
    const mine = name => Boolean(name) && carriesKey(name, key) && !carriesKey(name, cardKey);
    const pushed = [...new Set(repos.flatMap(r => Object.keys(r.heads)))].filter(mine).sort();
    const local = dir && repos.length ? repos[0].checkout.branches.local.filter(n => mine(n) && !pushed.includes(n)).sort() : [];
    const branches = [...pushed.map(name => ({ name, where: 'remote', via: 'ls-remote' })), ...local.map(name => ({ name, where: 'local', via: 'local' }))];
    const configured = new Set(repos.map(r => r.path));
    const elsewhere = work.local.find(l => mine(l.branch) && !configured.has(l.path)) ?? null;
    return { branches, elsewhere };
  }

  // A card the card only ships after is a gate until it is merged or done: never a blocker, so the card starts from the default.
  function gatesOf(c) {
    const done = key => (prs.byKey.get(key) ?? []).some(isMerged)
      || [onMap.get(key)?.statusType, offMap.get(key)?.state?.type].includes('completed');
    return [
      ...markers(describe(c.key)).after.filter(key => key !== c.key && !done(key)).map(key => ({ kind: 'card', card: key, text: gateText(key) })),
      ...(decisionGates.get(c.key) ?? []).map(text => ({ kind: 'decision', text })),
    ];
  }

  function blockersOf(c, cardDir, uncertain) {
    const out = [];
    const after = new Set(markers(describe(c.key)).after);
    for (const key of blockerKeys(c).filter(k => !after.has(k))) {
      const mapCard = onMap.get(key);
      const off = mapCard ? null : offMap.get(key);
      if (!mapCard && !off) {
        warnings.push({ key, kind: 'text-dependency-unknown', message: `${c.key} names ${key} as a dependency, but Linear has no such card` });
        continue;
      }
      if (off && neverBlocks(off)) continue;
      const state = mapCard ? { name: mapCard.status, type: mapCard.statusType } : off.state;
      if (state?.type === 'completed') continue;
      const blockerDir = mapCard ? repoOf(key) : null;
      for (const failure of [ghFailure(mapCard ? blockerDir : null), cardFailure(key)]) if (failure) uncertain.push(`${key}: ${failure}`);
      const { branches, elsewhere } = branchesOf(key, c.key, cardDir);
      out.push({ key, linearState: state, prs: prs.byKey.get(key) ?? [], branches, elsewhere, textOnly: textOnly.some(e => e.from === key && e.to === c.key) });
    }
    return out;
  }

  const free = [];
  const overdue = [];
  for (const c of cards) {
    if (c.rank == null) continue;
    const own = prs.byKey.get(c.key) ?? [];
    if (own.some(isMerged)) continue;
    let dir = repoOf(c.key);
    const uncertain = [];
    const notFree = (reason, detail) => {
      if (c.deadline === 'overdue') {
        overdue.push({
          key: c.key, title: c.title, deadline: c.deadline, deadlineFrom: c.deadlineFrom, dueDate: c.dueDate,
          milestone: c.milestone, milestoneTargetDate: c.milestoneTargetDate, reason, detail,
        });
      }
    };
    const definite = ownReason(c, own);
    if (definite) { notFree(definite.reason, definite.detail); continue; }
    for (const failure of [ghFailure(dir), gitFailure(dir), cardFailure(c.key)]) if (failure) uncertain.push(failure);

    const blockers = blockersOf(c, dir, uncertain);
    const stranded = blockers.find(b => !b.prs.length && !b.branches.length && b.elsewhere);
    if (stranded && !uncertain.length) {
      notFree('blocked', `${stranded.key}: branch ${stranded.elsewhere.branch} is only in ${stranded.elsewhere.path}: push it`);
      continue;
    }
    if (!dir) dir = blockers.flatMap(b => b.prs).find(isOpen)?.repoDir ?? null;
    const ctx = { currentRepoDir: dir, defaultBranchOf: d => config.repos[d]?.defaultBranch ?? null };
    const classified = blockers.map(b => ({ ...b, ...classifyBlocker(b, ctx) }));
    const settings = dir ? config.repos[dir] : null;
    let unknown = false;
    const contains = (dir && work.repos.get(dir)?.contains) || (() => null);
    // A card with no repo still gets its blockers decided; only the base itself is left to start.
    const base = decideBase(classified, {
      remote: settings?.remote ?? 'origin', defaultBranch: settings?.defaultBranch ?? null,
      chainOf: open => { const r = chainTop(open, contains); if (r.unknown) unknown = true; return r; },
    });
    if (!uncertain.length && !unknown && base.kind !== 'default' && base.kind !== 'stack') {
      const waiting = base.pushReviews.length > 0;
      const detail = waiting
        ? base.pushReviews.map(r => (r.number ? `#${r.number}` : r.branch)).join(', ')
        : classified.filter(b => b.status !== 'merged').map(b => b.key).join(', ');
      notFree(waiting ? 'waiting-reviews' : 'blocked', detail);
      continue;
    }
    if (!settings) warnings.push({ key: c.key, kind: 'repo-unknown', message: `${c.key}: no configured repo in its title or Repo: line; start decides from the checkout it runs in` });
    if (unknown) uncertain.push(UNFETCHED);
    const settled = settings && !uncertain.length && (base.kind === 'default' || base.kind === 'stack');
    free.push({
      key: c.key, title: c.title, url: c.url, rank: c.rank,
      repo: dir ? config.repos[dir]?.name ?? dir : null,
      milestone: c.milestone, milestoneOrder: c.milestoneOrder, deadline: c.deadline, deadlineFrom: c.deadlineFrom,
      dueDate: c.dueDate, milestoneTargetDate: c.milestoneTargetDate, due: c.due,
      critical: onPath.has(c.key), downstream: c.downstream ?? 0, size: c.size ?? null, estimate: c.estimate ?? null,
      deferrable: markers(describe(c.key)).deferrable,
      base: settled ? { kind: base.kind, ref: base.ref, pr: base.pr, costs: base.costs } : null,
      textBlockers: blockers.filter(b => b.textOnly).map(b => b.key),
      checks: markers(describe(c.key)).qaLive.map(k => `${k} must be live in QA`),
      gates: gatesOf(c),
      unverified: uncertain.length ? uncertain.join('; ') : null,
    });
  }
  free.sort((a, b) => a.rank - b.rank);
  return { free, overdue, warnings };
}
