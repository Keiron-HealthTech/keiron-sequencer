import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exitError } from '../cli.mjs';
import { replanReplay } from '../respike/replay-plan.mjs';
import { cardSizes } from '../patch-stats.mjs';
import { replayedRecord, replayedRecordFile } from './build-record.mjs';
import { deriveRepo } from './derive.mjs';
import { runDir, trialPatchRoot } from './home.mjs';
import { scanPatch } from './secrets.mjs';
import { cardPatchName, DIFF, snapshot } from './snapshot.mjs';
import { trackOfCard } from './state.mjs';
import { checkTree, openTree } from './trees.mjs';
import { clearGenerated, repoTypecheck, typecheckLog } from './typecheck.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NO_PREIMAGE = /lacks the necessary blob/;

// What a respike hands the card loop from the card's existing record, so old findings get an outcome; null on a first spike.
export function previousOf(dataDir, slug, card, runId) {
  if (!existsSync(join(dataDir, slug, `${card}.json`))) return null;
  const r = readRecord(dataDir, slug, card);
  if (r.refs?.runId === runId) return null;
  return { spikedAt: r.spikedAt, findings: r.findings ?? [], decisions: r.decisions ?? [], openDecisions: r.openDecisions ?? [] };
}

export function readRecord(dataDir, slug, card) {
  const path = join(dataDir, slug, `${card}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the record of ${card} at ${path}: ${e.code ?? e.message}`);
  }
}

function assertSnapshotted(git, repoDir, repo) {
  checkTree(git, repoDir, repo);
  clearGenerated(repo.path);
  git(['add', '-A'], { cwd: repo.path });
  if (git(['write-tree'], { cwd: repo.path }).trim() !== repo.last) {
    throw exitError(6, `${repoDir} has work in ${repo.path} that was not snapshotted; a replay starts only from the last snapshot`);
  }
}

const unmergedPaths = out => [...new Set(out.split('\n').filter(Boolean).map(l => l.slice(l.indexOf('\t') + 1)))].sort(compare);

// The 3-way apply runs in a temporary index, so a patch that does not apply leaves the tree's index and files as they were.
function mergedTree(git, repoDir, repo, patches, { index, pathOf }) {
  const env = { GIT_INDEX_FILE: index };
  try {
    git(['read-tree', repo.last], { cwd: repo.path, env });
    for (const patch of patches) {
      try {
        git(['apply', '--cached', '--3way', '--binary', pathOf(patch)], { cwd: repo.path, env });
      } catch (e) {
        const unmerged = unmergedPaths(git(['ls-files', '-u'], { cwd: repo.path, env }));
        return { conflict: { repo: repoDir, patch, reason: NO_PREIMAGE.test(e.message) ? 'no-preimage' : 'conflict', unmerged } };
      }
    }
    return { tree: git(['write-tree'], { cwd: repo.path, env }).trim() };
  } finally {
    rmSync(index, { force: true });
  }
}

// The entry becomes a card to spike where it stands in the order; nothing of it was written.
function turn(state, card, at, status, detail) {
  state.plan.cards[card].mode = 'spike';
  state.cards[card].replay = { status, at, applied: [], folded: [], ...detail };
  return { outcome: { card, status, patches: [] }, writes: [] };
}

const rootOf = (state, from) => (from === 'trial' ? trialPatchRoot(state.home, state.project.slug) : join(runDir(state.home, state.project.slug, from), 'patches'));

// Every repo of the unit is merged before any is moved, so a unit that fails anywhere leaves every repo as it was.
// No patch or record is written here: they come back as writes, for the caller to make once it keeps the entry.
export function replayEntry(git, state, card, { dir, config, runSetup, dataDir, now }) {
  const entry = state.plan.respike.replay[card];
  const { slug } = state.project;
  const at = now().toISOString();
  const record = readRecord(dataDir, slug, card);
  const pathOf = patch => join(rootOf(state, entry.sources?.[patch] ?? entry.from), patch);
  const trackId = trackOfCard(state, card);
  mkdirSync(join(dir, 'tmp', trackId), { recursive: true });

  const merged = [];
  for (const [repoDir, patches] of Object.entries(entry.units)) {
    const repo = openTree(git, state, { trackId, repoDir, repo: config.repos[repoDir], dir, runSetup });
    assertSnapshotted(git, repoDir, repo);
    const result = mergedTree(git, repoDir, repo, patches, { index: join(dir, 'tmp', trackId, `replay-${repoDir}.index`), pathOf });
    if (result.conflict) return turn(state, card, at, 'conflict', { conflict: result.conflict });
    merged.push({ repoDir, repo, patches, tree: result.tree });
  }

  // Read from tree objects only: the files of the tree have not moved yet.
  const nameIn = repoDir => `${repoDir}/${cardPatchName(card, record.origin)}`;
  const hits = merged.filter(m => m.tree !== m.repo.last)
    .flatMap(({ repoDir, repo, tree }) => scanPatch(git([...DIFF, repo.last, tree], { cwd: repo.path })).map(h => ({ patch: nameIn(repoDir), ...h })));
  if (hits.length) return turn(state, card, at, 'secret', { hits });

  // Each moved tree is type-checked over the paths the replay changed; one failure puts every moved tree back and the
  // entry is spiked instead, so a replay never builds on an ancestor that no longer type-checks.
  const moved = [];
  for (const m of merged.filter(x => x.tree !== x.repo.last)) {
    const changed = git(['diff', '--name-only', '--diff-filter=d', m.repo.last, m.tree], { cwd: m.repo.path }).split('\n').filter(Boolean);
    git(['read-tree', '-m', '-u', m.repo.last, m.tree], { cwd: m.repo.path });
    moved.push(m);
    const log = typecheckLog(dir, trackId, m.repoDir);
    const check = repoTypecheck(runSetup, config.repos[m.repoDir], { treePath: m.repo.path, changed, logPath: log });
    if (check.ran && !check.ok) {
      for (const x of moved) git(['read-tree', '-m', '-u', x.tree, x.repo.last], { cwd: x.repo.path });
      return turn(state, card, at, 'typecheck', { typecheck: { repo: m.repoDir, log } });
    }
  }

  const applied = merged.flatMap(m => m.patches);
  const texts = new Map();
  for (const { repoDir, repo } of moved) {
    const snap = snapshot(git, repo);
    if (!snap) continue;
    const name = nameIn(repoDir);
    texts.set(name, snap.patch);
    repo.last = snap.tree;
    repo.log.push({ name: basename(name, '.patch'), tree: snap.tree, stat: snap.stat });
  }
  const fresh = [...texts.keys()];

  if (!fresh.length) {
    Object.assign(state.cards[card], { status: 'done', patches: [], replay: { status: 'empty', at, applied, folded: [] } });
    return { outcome: { card, status: 'empty', patches: [] }, writes: [] };
  }
  // Every name the record holds now is folded, so a later replay never looks one of them up again.
  const folded = [...new Set([...record.refs.patches, ...(record.fixups?.received ?? []).map(f => f.patch)])].sort(compare);
  const before = { size: record.size ?? null, riskAreas: record.riskAreas ?? null, newPaths: record.novelty?.newPaths ?? null };
  const recordFile = replayedRecordFile(dataDir, slug, replayedRecord(record, {
    ...measured(git, state, card, texts, { config }),
    patches: fresh,
    replayed: { at, runId: state.runId, fromRunId: entry.from === 'trial' ? null : entry.from, folded },
  }));
  Object.assign(state.cards[card], { status: 'done', patches: fresh, replay: { status: 'replayed', at, applied, folded, before } });
  return {
    outcome: { card, status: 'replayed', patches: fresh },
    writes: [...fresh.map(name => ({ path: join(dir, 'patches', name), text: texts.get(name) })), recordFile],
  };
}

// Each fresh patch is measured between the tree before it and the tree it produced, as the repo's log records them.
function measured(git, state, card, texts, { config }) {
  const fresh = [...texts.keys()];
  const dirs = [...new Set(fresh.map(n => n.split('/')[0]))];
  const { repos } = state.tracks[trackOfCard(state, card)];
  const patchMap = {
    cards: { [card]: {} },
    repos: Object.fromEntries(dirs.map(d => [d, repos[d].name])),
    patches: Object.fromEntries(fresh.map(n => [n, { kind: 'card', cards: [card] }])),
  };
  const size = cardSizes(patchMap, n => texts.get(n))[card];
  const derived = fresh.map(name => {
    const [repoDir] = name.split('/');
    const repo = repos[repoDir];
    const i = repo.log.findLastIndex(e => e.name === basename(name, '.patch'));
    return deriveRepo(git, repoDir, {
      cwd: repo.path, rules: config.repos[repoDir]?.risk ?? [], startTree: i > 0 ? repo.log[i - 1].tree : repo.baseTree, endTree: repo.log[i].tree,
    });
  });
  return { size, derived };
}

// What the agent is told about an entry that could not replay: where it stopped, never the patch content.
export function replayContext(cardState) {
  const { conflict, hits, typecheck } = cardState.replay ?? {};
  if (conflict) return { replayConflict: { repos: [conflict.repo], patch: conflict.patch, reason: conflict.reason, unmerged: conflict.unmerged } };
  if (typecheck) return { replayTypecheck: { repo: typecheck.repo, log: typecheck.log } };
  return hits ? { replaySecret: { hits } } : {};
}

// Run after an entry turned into a spike, before any other replay entry of its track is processed; each change is logged in
// the plan. Only the cause's track is replanned, so a replan never rewrites entries another track is replaying meanwhile.
export function replanAfterTurn(state, { dataDir }, cause) {
  const respike = state.plan.respike;
  const { slug } = state.project;
  const { cards } = state.tracks[trackOfCard(state, cause)];
  const keys = cards.filter(k => Object.hasOwn(respike.replay, k));
  const pending = keys.filter(k => state.plan.cards[k].mode === 'replay' && state.cards[k].status !== 'done');
  const records = new Map(keys.map(k => [k, readRecord(dataDir, slug, k)]));
  const out = replanReplay({ replay: respike.replay, pending, isSpike: k => state.plan.cards[k]?.mode === 'spike', records, home: state.home, slug });
  respike.replay = out.replay;
  if (out.dropped.length) respike.replans = [...(respike.replans ?? []), { cause, dropped: out.dropped }];
  return out.dropped;
}
