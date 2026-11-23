import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exitError } from '../cli.mjs';
import { analyzeProject } from '../graph.mjs';
import { canonicalJson } from '../harvest.mjs';
import { fetchDescriptions, fetchProject, fetchProjectMap } from '../linear-fetch.mjs';
import { dataInRepoWarning, isLive, readRecords } from '../records.mjs';
import { allowedRepos, loadConfig } from '../spike/config.mjs';
import { displayData, trialPatchRoot, trialReferenceDir } from '../spike/home.mjs';
import { activeRunFor, latestRun } from '../spike/state.mjs';
import { tracksOf } from '../spike/tracks.mjs';
import { cardRepos } from '../start/checkout.mjs';
import { classifyBuilt, decideBases, neededCandidates, pinBranch, readPrLists, readRefs, resolvePending } from './built.mjs';
import { coverage, touchedRepos } from './coverage.mjs';
import { replayPlans } from './replay-plan.mjs';
import { ancestorsOf, cardStaleness, contractedEdges, entryOrder, selectCards } from './selection.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);

// behind and the default-branch tip move on their own, so they stay out of the hash.
export function approveHash(plan, answers = { built: new Map(), unbuilt: new Set() }) {
  const hashed = {
    slug: plan.project.slug,
    mode: plan.selection.mode,
    selected: plan.selection.cards.map(c => c.key).sort(),
    built: plan.built.map(b => ({ key: b.key, kind: b.kind, repoDir: b.repoDir, sha: b.sha })),
    bases: Object.fromEntries(Object.entries(plan.bases).map(([dir, b]) => [dir, {
      kind: b.kind, sha: b.sha, heads: b.heads?.map(h => ({ card: h.card, sha: h.sha })) ?? null, tree: b.tree,
    }])),
    order: plan.order,
    tracks: plan.tracks,
    replay: plan.ancestors.map(a => ({ key: a.key, from: a.from, patches: a.patches, dropped: a.dropped })),
    answers: {
      built: [...answers.built].sort(([a], [b]) => compare(a, b)), unbuilt: [...answers.unbuilt].sort(), withDefault: [...(answers.withDefault ?? [])].sort(),
    },
    action: plan.action,
    codes: [...plan.asks, ...plan.stops].map(x => x.code),
  };
  return createHash('sha256').update(canonicalJson(hashed)).digest('hex').slice(0, 12);
}

function readConfig(home) {
  try {
    return loadConfig(home);
  } catch (e) {
    throw exitError(2, e.message);
  }
}

const actionOf = ({ missingConfig, stops, asks, order }) => {
  if (missingConfig.length) return 'blocked';
  if (stops.length) return 'stop';
  if (asks.length) return 'ask';
  return order.length ? 'ready' : 'nothing-to-do';
};

// answers: { built: Map card -> branch, unbuilt: Set of cards }. Git runs only in configured checkouts, and the
// bases (the only step that reads commits) run after coverage, so a url-only repo is blocked before any of it.
// config replaces the home's config.json; coverageOnly stops after coverage, before the open-run check, bases and hash.
// Milestones order the work, so an open card with none has no place in that order: assign it in Linear before begin.
function noMilestone(analysis) {
  const cards = analysis.cards.filter(c => !['completed', 'canceled'].includes(c.statusType) && !c.milestone).map(c => c.key)
    .sort((a, b) => cardNumber(a) - cardNumber(b) || compare(a, b));
  if (!cards.length) return [];
  return [{ code: 'no-milestone', cards, message: `${cards.join(', ')} ${cards.length === 1 ? 'has' : 'have'} no milestone: assign one in Linear before begin, so the order and the blocks between milestones can be checked` }];
}

// Trial patches replay in the order of the trial logs; without them they would silently fall back to name order.
function assertTrialReference(home, slug, dir) {
  if (existsSync(dir)) return;
  throw exitError(2, `trial records of ${slug} replay from ${trialPatchRoot(home, slug)}, but there is no trial reference at ${dir} to order them: move it there with scripts/maintenance/move-reference.mjs, then preflight again`);
}

// Records still in the repo's data/ while the data dir has none: the respike would treat every card as never spiked.
function dataInRepo(dataDir, repoDataDir, slug) {
  const w = dataInRepoWarning({ dataDir, repoDataDir, slug, display: displayData(dataDir, slug) });
  return w ? [{ code: w.kind, message: w.message }] : [];
}

export async function buildRespikePlan(ref, key, {
  cards = null, stale = false, all = false, answers = { built: new Map(), unbuilt: new Set() }, config: given = null, coverageOnly = false,
} = {}, deps) {
  const { fetchImpl, home, dataDir, repoDataDir = null, git, gh, trialLogDir, tmpRoot } = deps;
  const config = given ?? readConfig(home);
  const known = await fetchProject(ref, key, { fetchImpl });
  const raw = await fetchProjectMap(ref, key, { fetchImpl, project: known });
  const descriptions = await fetchDescriptions(raw.project.id, key, { fetchImpl });
  const analysis = analyzeProject(raw);
  const { slug } = raw.project;
  const cardOf = k => ({ ...analysis.cards.find(c => c.key === k), description: descriptions.get(k)?.description ?? '' });
  const live = readRecords(join(dataDir, slug)).records.filter(isLive);
  const records = new Map(live.map(r => [r.card, r]));

  const local = allowedRepos(config, slug).filter(d => config.repos[d]?.checkout);
  const refs = new Map(local.map(d => [d, readRefs(git, config.repos[d])]));
  const prs = readPrLists(gh, config, slug);
  const pin = (dir, branch) => pinBranch(git, config.repos[dir].checkout, branch);
  const classified = classifyBuilt(analysis, { config, prs, refs, answers, pin });
  const builtKeys = new Set([...classified.built.map(b => b.key), ...classified.pending.map(p => p.key)]);
  const isBuilt = k => builtKeys.has(k);

  const projectKeys = analysis.cards.map(c => c.key);
  const staleOf = k => cardStaleness(git, { config, card: cardOf(k), record: records.get(k) ?? null, home, slug, projectKeys, refsOf: dir => refs.get(dir)?.tracking ?? {} });
  const selection = selectCards(analysis, { cards, stale, all, isBuilt, staleOf });
  const selected = selection.cards.map(c => c.key);
  const walked = ancestorsOf(analysis, selected, { isBuilt });
  const orderOf = modes => entryOrder(analysis, [...modes.keys()], { rank: k => (modes.get(k) === 'replay' ? 0 : 1) });
  const logDir = trialLogDir ?? trialReferenceDir(home, slug);
  const ancestors = replayPlans({
    ancestors: walked, selected, records, isBuilt, home, slug, config, trialLogDir: logDir, edges: analysis.edges, order: modes => orderOf(modes).order,
  });
  if (trialLogDir === undefined && ancestors.some(a => a.mode === 'replay' && a.from === 'trial')) assertTrialReference(home, slug, logDir);
  const modes = new Map([...ancestors.map(a => [a.key, a.mode]), ...selected.map(k => [k, 'spike'])]);
  const ordered = orderOf(modes);
  const links = [...records.values()].flatMap(r => (r.fixups?.received ?? []).map(f => [f.from, r.card]));
  const tracks = tracksOf({ order: ordered.order, edges: contractedEdges(analysis.edges, new Set(ordered.order)), links });
  const stops = ordered.cycles.map(members => ({ code: 'cycle', members, message: `cycle among the run's cards: ${members.join(', ')}` }));

  const spikeEntries = [...modes].filter(([, m]) => m === 'spike').map(([k]) => ({ card: cardOf(k), record: records.get(k) ?? null }));
  const replayEntries = ancestors.filter(a => a.mode === 'replay');
  const entryRepos = [
    ...spikeEntries.map(({ card, record }) => {
      const repos = cardRepos(card, record, record?.refs.patches, config);
      return { key: card.key, repos: repos.length ? repos.filter(r => r.dir).map(r => r.dir) : null };
    }),
    ...replayEntries.map(a => ({ key: a.key, repos: Object.keys(a.units) })),
  ];
  const needed = neededCandidates(analysis, classified.built, entryRepos);
  const baseRepos = [...new Set(needed.filter(b => b.needed).map(b => b.repoDir))]
    .map(dir => ({ dir, cards: needed.filter(b => b.needed && b.repoDir === dir).map(b => b.key) }));
  const touched = touchedRepos(config, { spike: spikeEntries, replay: replayEntries, bases: baseRepos });
  const covered = coverage(config, slug, touched);
  if (coverageOnly) return { coverage: covered, touched, slug, raw, config };

  const plan = {
    schemaVersion: 1,
    approve: null,
    action: null,
    project: { slug, name: raw.project.name },
    previous: { runId: latestRun(home, slug)?.state.runId ?? null, records: live.length, fromTrial: live.filter(r => !r.refs.runId).length },
    selection,
    built: needed,
    ancestors,
    bases: {},
    order: ordered.order.map(k => ({ key: k, mode: modes.get(k) })),
    tracks,
    asks: [],
    stops,
    missingConfig: covered.missingConfig,
    warnings: [...classified.warnings, ...covered.warnings, ...noMilestone(analysis), ...dataInRepo(dataDir, repoDataDir, slug)],
  };
  if (!plan.missingConfig.length) {
    const open = activeRunFor(home, slug);
    if (open) throw exitError(5, `run ${open.state.runId} of ${slug} is ${open.state.status}: spike.mjs begin resumes it and spike.mjs abandon ends it`);
    const pending = resolvePending(classified.pending, needed);
    const decided = decideBases(git, { config, built: needed, repos: touched.repos.map(r => r.repo), refs, tmpRoot, withDefault: answers.withDefault ?? new Set() });
    plan.built = [...needed, ...pending.built].sort((a, b) => cardNumber(a.key) - cardNumber(b.key) || compare(a.key, b.key) || compare(a.repoDir ?? '', b.repoDir ?? ''));
    plan.bases = decided.bases;
    plan.asks = [...classified.asks, ...pending.asks, ...decided.asks];
    plan.warnings.push(...decided.warnings);
  }
  plan.action = actionOf(plan);
  if (plan.action === 'ready' || plan.action === 'ask') plan.approve = approveHash(plan, answers);
  return { plan, analysis, raw, descriptions, config };
}
