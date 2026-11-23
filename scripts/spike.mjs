#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run as respike } from './respike.mjs';
import { basename, join, resolve } from 'node:path';
import { fail, isEntry, lines, ok, parseArgs, redacted } from './lib/cli.mjs';
import { analyzeProject } from './lib/graph.mjs';
import { fetchDescriptions, fetchProject, fetchProjectMap, parseProjectRef, readLinearKey } from './lib/linear-fetch.mjs';
import { withCheckSlot } from './lib/spike/checks.mjs';
import { checkNotes, finishCard, finishFixup, NOTES_ALLOWED, notesPath, notesTemplate, rewriteUsage } from './lib/spike/build-record.mjs';
import { deriveRepo, mergeRiskAreas } from './lib/spike/derive.mjs';
import { allowedRepos, loadConfig } from './lib/spike/config.mjs';
import { ghRunner, gitRunner, setupRunner } from './lib/spike/exec.mjs';
import { dataInRepoWarnings, REPO_DATA_DIR } from './lib/records.mjs';
import { assertHomeOutsideWorkTree, dataDirFor, displayData, runDir, runIdAt, sequencerHome, withLock, writeAtomic, writeJsonAtomic } from './lib/spike/home.mjs';
import { existingPrs, spikeOrder } from './lib/spike/order.mjs';
import { LIMIT_FLAGS, limitsFrom, sessionsFrom } from './lib/spike/limits.mjs';
import { isSlug, prunableSlugs, pruneRuns } from './lib/spike/prune.mjs';
import { previousOf, replanAfterTurn, replayContext, replayEntry } from './lib/spike/replay.mjs';
import { changedSinceLast, repoTypecheck, typecheckLog } from './lib/spike/typecheck.mjs';
import { cardPatchName, fixupPatchName, oldSideRanges, overlapCandidates, rangesOverlap, snapshot, workingDiff } from './lib/spike/snapshot.mjs';
import { scanPatch, SECRET_KINDS } from './lib/spike/secrets.mjs';
import {
  activeRunFor, activeRuns, allRepos, capReached, closeOpenExecutions, createRun, executionSpend, issueMark, latestRun, noteStartTrees, openCardWindow,
  openExecution, readState, saveState, timeBoxFor, trackIdOf, trackOfCard, unsettledWindows, waitingOn,
} from './lib/spike/state.mjs';
import { applyPrDiff, assertLastTree, checkTree, discardTree, guardTree, openTree, rebuildTree, teardownTrees, touchedCheckouts } from './lib/spike/trees.mjs';
import { bindSession, lastEntryAt, sessionFiles, transcriptsRoot, weighted, windowUsage } from './lib/spike/usage-window.mjs';

const USAGE = [
  'usage: node scripts/spike.mjs begin <project ref> [--max-tokens <n>] [--max-cards <n>] [--box <n>] [--session-file <transcript.jsonl>]',
  'usage: node scripts/spike.mjs next [--track <id>] [--project <project ref>]',
  'usage: node scripts/spike.mjs tree <repoDir> [--track <id>] [--project <project ref>]',
  'usage: node scripts/spike.mjs notes-template <CARD> [--track <id>] [--project <project ref>]',
  'usage: node scripts/spike.mjs end <CARD> [--track <id>] [--notes <notes.json>] [--allow <kind>:<path>]... [--skip-typecheck <reason>] [--project <project ref>]',
  'usage: node scripts/spike.mjs check [--track <id>] [--cwd <repoDir>] [--project <project ref>] -- <argv>...',
  'usage: node scripts/spike.mjs candidates [--track <id>] [--repo <repoDir>] [--project <project ref>]',
  'usage: node scripts/spike.mjs fixup [--track <id>] --fixes <CARD>[,<CARD>] --slug <kebab-slug> --note <text> --repo <repoDir> [--allow <kind>:<path>]... [--project <project ref>] -- <path>...',
  'usage: node scripts/spike.mjs rebuild <repoDir> [--track <id>] [--project <project ref>]',
  'usage: node scripts/spike.mjs pause [--project <project ref>]',
  'usage: node scripts/spike.mjs abandon [--discard] [--project <project ref>]',
  'usage: node scripts/spike.mjs prune [<slug>] [--dry-run]',
  'usage: node scripts/spike.mjs status [--project <project ref>]',
  'usage: node scripts/spike.mjs tracks [--project <project ref>]',
  'usage: node scripts/spike.mjs config <project ref> --out <draft.json> [--root <dir>]...',
  'usage: node scripts/spike.mjs config --draft <draft.json> [--approve <hash>]',
];

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);

const COMMANDS = { begin, next, tree, check, candidates, 'notes-template': notesTemplateFor, end, fixup, rebuild, pause, abandon, prune, status, tracks, config };

// transcripts: null means no session discovery, so only an explicit --session-file is ever read.
export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), home, dataDir, repoDataDir,
  transcripts = null, git = gitRunner(), gh = ghRunner(), runSetup = setupRunner(), sleep = ms => new Promise(r => setTimeout(r, ms)), lock = {}, slot = {},
} = {}) {
  const deps = { env, fetchImpl, keyFile, now, home: home ?? sequencerHome(env), dataDir: dataDir ?? home ?? dataDirFor(env), transcripts, git, gh, runSetup, sleep, lock, slot };
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command)) return fail(2, ...USAGE);
  const repoData = repoDataDir ?? (dataDir === undefined && home === undefined ? REPO_DATA_DIR : null);
  const moved = dataInRepoWarnings({ repoDataDir: repoData, display: slug => displayData(deps.dataDir, slug) }).map(w => `warning: ${w.message}`);
  let result;
  try {
    assertHomeOutsideWorkTree(deps.home);
    result = await COMMANDS[command](rest, deps);
  } catch (e) {
    result = fail(e.exitCode ?? 1, e.message);
  }
  return moved.length ? { ...result, stderr: `${result.stderr}${lines(moved)}` } : result;
}

const isProject = (project, ref) => {
  const wanted = parseProjectRef(ref)?.ref ?? ref;
  return [project.slug, project.id, project.name].includes(wanted);
};

function activeRun(home, ref) {
  const runs = activeRuns(home).filter(r => ref === undefined || isProject(r.state.project, ref));
  if (runs.length === 1) return runs[0];
  if (!runs.length) throw new Error(ref === undefined ? 'no active spike run: start one with begin' : `no active spike run for project ${ref}`);
  const list = runs.map(r => `${r.state.project.slug}/${r.state.runId}`).join(', ');
  throw new Error(`more than one active spike run: ${list}${ref === undefined ? '; pass --project <project ref>' : ''}`);
}

// The state is read again under the lock: the copy listed before it was taken may already be stale.
function onActiveRun(home, ref, fn, lock) {
  const { dir } = activeRun(home, ref);
  return withLock(dir, () => fn(dir, readState(dir)), lock);
}

const treeStatuses = track => JSON.stringify(Object.entries(track.repos).map(([d, r]) => [d, r.status]));

// A merge or rewind (generation), a pause or abandon (run status), or a teardown (a tree's status) since before.
const movedSince = (state, before, trackId) => state.tracks[trackId].generation !== before.tracks[trackId].generation
  || state.status !== before.status || treeStatuses(state.tracks[trackId]) !== treeStatuses(before.tracks[trackId]);

// The second locked section of a command whose heavy work ran outside the lock: it writes onto the state read here, never
// onto the copy the work started from, and nothing at all if the run or the track moved since section 1 read before.
// onStale puts back what the heavy work did to the trees, so they match the state again.
function relock(dir, lock, trackId, before, fn, onStale = () => {}) {
  return withLock(dir, () => {
    const state = readState(dir);
    if (!movedSince(state, before, trackId)) return fn(state);
    onStale();
    return ok({ action: 'stale', track: trackId });
  }, lock);
}

// A tree the work made is removed; a tree it moved past its last snapshot goes back to it.
function rollBackTrees(git, before, work, trackId) {
  const was = before.tracks[trackId].repos;
  for (const [repoDir, repo] of Object.entries(work.tracks[trackId].repos)) {
    if (!was[repoDir]) discardTree(git, repo);
    else if (was[repoDir].last && repo.last !== was[repoDir].last) git(['read-tree', '-m', '-u', repo.last, was[repoDir].last], { cwd: repo.path });
  }
}

// Only the entries the heavy work changed are copied: the others keep what the re-read state holds, which may be newer.
function copyMoved(to, from, before) {
  for (const [k, v] of Object.entries(from)) if (JSON.stringify(v) !== JSON.stringify(before[k])) to[k] = v;
}

async function begin(args, deps) {
  const a = parseArgs(args, LIMIT_FLAGS);
  const parsed = a?.positional.length === 1 ? parseProjectRef(a.positional[0]) : null;
  const limits = a && limitsFrom(a.flags);
  if (!parsed || !limits) return fail(2, ...USAGE);
  const { key, reason } = readLinearKey(deps.env, deps.keyFile);
  if (!key) return fail(3, reason);
  try {
    return redacted(await startRun(parsed.ref, key, { ...a.flags, limits }, deps), key);
  } catch (e) {
    return redacted(fail(e.exitCode ?? 1, e.message), key);
  }
}

// A session given with --session-file is used as given; otherwise the transcript holding the last mark is bound.
async function bindExecution(execution, { transcripts, now }) {
  if (!execution?.mark || execution.sessions.some(s => s.given)) return;
  const bound = execution.sessions.map(s => s.file);
  const found = await bindSession({ root: transcripts, nonce: execution.mark.nonce, issuedAt: execution.mark.issuedAt, bound });
  if (found && !bound.includes(found.file)) execution.sessions.push({ file: found.file, boundAt: now().toISOString(), ...(found.subagent ? { subagent: true } : {}) });
}

const usageFiles = execution => execution.sessions.flatMap(s => (s.subagent ? [s.file] : sessionFiles(s.file)));

// A card whose mark landed in a worker's transcript is measured on that file alone: tracks overlap in time, so every
// other file of the execution holds someone else's spend. Any other card is measured on the whole execution.
async function windowFiles(window, execution, { transcripts, now, keep = true }) {
  if (window.worker) return [window.worker];
  if (!window.mark || execution.sessions.some(s => s.given)) return usageFiles(execution);
  const found = await bindSession({ root: transcripts, nonce: window.mark.nonce, issuedAt: window.mark.issuedAt, bound: execution.sessions.map(s => s.file) });
  if (!found?.subagent) return usageFiles(execution);
  if (keep) window.worker = found.file;
  return [found.file];
}

async function measure(window, files) {
  if (!files.length) return null;
  let usage;
  try {
    usage = await windowUsage({ files, start: window.start, end: window.end });
  } catch {
    return null;
  }
  Object.assign(window, { settled: usage.settled, messages: usage.messages, tokens: usage.tokens, w: weighted(usage.tokens) });
  return usage;
}

const sameUsage = (window, usage) => window.messages === usage.messages && JSON.stringify(window.tokens) === JSON.stringify(usage.tokens);

// A done card whose window sum moved gets its record's effort and timeBox rewritten.
async function settleWindows(state, { dataDir, transcripts, now }) {
  const moved = new Set();
  const unsettled = new Set();
  for (const { card, window, execution } of unsettledWindows(state)) {
    const before = { messages: window.messages, tokens: window.tokens };
    const usage = await measure(window, await windowFiles(window, execution, { transcripts, now }));
    if (!usage) continue;
    if (!sameUsage(before, usage)) moved.add(card);
    if (!usage.settled) unsettled.add(card);
  }
  for (const card of moved) if (state.cards[card].status === 'done') rewriteUsage(state, card, dataDir);
  return { unsettled: [...unsettled] };
}

const SETTLE_POLLS = 5;
const SETTLE_POLL_MS = 1000;

const begun = (state, mark, resumed) => ok({
  mark, runId: state.runId, resumed, project: { slug: state.project.slug, name: state.project.name },
  plan: { order: state.plan.order, skipped: state.plan.skipped },
});

const PR_FIELDS = 'number,title,url,isDraft';

function openPrs(config, slug, gh) {
  const lists = [];
  for (const repoDir of allowedRepos(config, slug)) {
    const { github } = config.repos[repoDir];
    if (!github) continue;
    const r = gh(['pr', 'list', '--repo', github, '--state', 'open', '--limit', '200', '--json', PR_FIELDS]);
    if (r.status !== 0) throw new Error(`gh pr list for ${repoDir} failed (${r.status}): ${String(r.stderr).trim()}`);
    let prs;
    try {
      prs = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh pr list for ${repoDir} did not return JSON`);
    }
    lists.push({ repoDir, prs });
  }
  return lists;
}

async function startRun(ref, key, flags, { fetchImpl, now, home, dataDir, gh, git, lock, transcripts }) {
  const config = loadConfig(home);
  const known = await fetchProject(ref, key, { fetchImpl });
  const existing = activeRunFor(home, known.slugId);
  if (existing) return withLock(existing.dir, () => resumeRun({ dir: existing.dir, state: readState(existing.dir) }, flags, { now, git, dataDir, transcripts }), lock);
  const last = latestRun(home, known.slugId);
  if (last?.state.status === 'complete') {
    return ok({ action: 'nothing-to-do', runId: last.state.runId, project: { slug: last.state.project.slug, name: last.state.project.name } });
  }

  const raw = await fetchProjectMap(ref, key, { fetchImpl, project: known });
  const analysis = analyzeProject(raw);
  const { order, skipped, cycles } = spikeOrder(analysis);
  if (cycles.length) return fail(5, ...cycles.map(group => `cycle among the run's cards: ${group.join(', ')}`));
  const descriptions = await fetchDescriptions(raw.project.id, key, { fetchImpl });
  const prs = existingPrs(openPrs(config, raw.project.slug, gh), order);
  const byKey = new Map(analysis.cards.map(c => [c.key, c]));
  const plan = {
    fetchedAt: now().toISOString(),
    order,
    skipped,
    cards: Object.fromEntries(order.map(k => byKey.get(k)).map(c => [c.key, {
      title: c.title, url: c.url, number: cardNumber(c.key), milestoneOrder: c.milestoneOrder,
      description: descriptions.get(c.key)?.description ?? '', origin: prs.has(c.key) ? 'existing-pr' : 'thin-spike',
      pr: prs.get(c.key) ?? null, offProject: c.offMapBlockers,
    }])),
  };
  const at = now();
  const runId = runIdAt(at);
  const project = { id: raw.project.id, slug: raw.project.slug, name: raw.project.name, url: raw.project.url };
  const state = createRun({ runId, project, plan, home, dataDir, now: at });
  const execution = openExecution(state, { now: at, sessions: sessionsFrom(flags, at), ...flags.limits });
  const mark = issueMark(state, execution, at);
  const dir = runDir(home, project.slug, runId);
  await withLock(dir, () => saveState(dir, state, at), lock);
  return begun(state, mark, false);
}

// EX_TEMPFAIL: a wrapped command's own exit code is 0 for a pass, so busy must not look like one.
const busy = extra => ({ ...ok({ action: 'busy', ...extra }), code: 75 });

const isOpen = ([, r]) => r.status === 'open';
const openRepos = (state, trackId) => Object.entries(state.tracks[trackId].repos).filter(isOpen);
const anyRemoved = state => allRepos(state).some(([, r]) => r.status === 'removed');

// The card in progress keeps its status; its open window closes at the last transcript line of its execution,
// and next opens a new one. A window with no line after its start held no work and is dropped.
async function closeInterruptedCard(state, track, at, { transcripts, now }) {
  const { current } = track;
  if (!current) return;
  track.current = null;
  const cardState = state.cards[current.card];
  const window = cardState.windows.at(-1);
  if (window.end) return;
  const execution = state.executions.find(e => e.id === current.execution);
  const files = await windowFiles(window, execution, { transcripts, now });
  if (!files.length) {
    Object.assign(window, { end: execution.mark?.issuedAt ?? window.start, endReason: 'interrupted' });
    return;
  }
  const last = lastEntryAt(files, at.toISOString());
  if (!last || Date.parse(last) <= Date.parse(window.start)) {
    cardState.windows.pop();
    return;
  }
  Object.assign(window, { end: last, endReason: 'interrupted' });
  await measure(window, files);
  window.settled = true;
}

async function resumeRun({ dir, state }, flags, { now, git, dataDir, transcripts }) {
  for (const [repoDir, repo] of allRepos(state).filter(isOpen)) checkTree(git, repoDir, repo);
  const at = now();
  for (const track of Object.values(state.tracks)) await closeInterruptedCard(state, track, at, { transcripts, now });
  await settleWindows(state, { dataDir, transcripts, now });
  closeOpenExecutions(state);
  state.status = 'active';
  const execution = openExecution(state, { now: at, sessions: sessionsFrom(flags, at), ...flags.limits });
  const mark = issueMark(state, execution, at);
  saveState(dir, state, at);
  return begun(state, mark, true);
}

const openTrees = (state, trackId) => Object.fromEntries(openRepos(state, trackId).map(([d, r]) => [d, r.path]));

// The diff goes into the card's repo tree once: when the tree opens during the card, or at next if it is already open.
function applyCardPr(state, trackId, repoDir, { config, gh, git, dir }) {
  const track = state.tracks[trackId];
  const card = track.current?.card;
  const planned = card && state.plan.cards[card];
  if (planned?.origin !== 'existing-pr' || planned.pr?.repoDir !== repoDir || state.cards[card].prDiff) return {};
  const repo = track.repos[repoDir];
  if (repo?.status !== 'open') return {};
  const { number } = planned.pr;
  const r = gh(['pr', 'diff', String(number), '--repo', config().repos[repoDir].github, '--color', 'never']);
  if (r.status !== 0) throw new Error(`gh pr diff ${number} for ${repoDir} failed (${r.status}): ${String(r.stderr).trim()}`);
  const applied = applyPrDiff(git, repo, r.stdout, { dir, number });
  state.cards[card].prDiff = applied.status;
  return applied.status === 'applied' ? { prDiff: 'applied' } : { prDiff: 'conflict', prDiffError: applied.error };
}

async function next(args, { home, now, gh, git, transcripts, dataDir, sleep, runSetup, lock, slot }) {
  const a = parseArgs(args, ['--project', '--track']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  const deps = { home, now, config: () => loadConfig(home), gh, git, transcripts, dataDir, sleep, runSetup, slot };
  const first = await onActiveRun(home, a.flags.project, async (dir, state) => {
    const trackId = trackIdOf(state, a.flags.track);
    return refusedNext(state, trackId) || !replayAhead(state, trackId) ? { result: await nextCard(dir, state, trackId, deps) } : { dir, state, trackId };
  }, lock);
  if (first.result) return first.result;
  const { dir, trackId } = first;
  const replayed = [];
  for (let before = first.state; ;) {
    const step = await replayStep(dir, trackId, before, replayed, { ...deps, lock });
    if (!step.state) return step.result ?? step;
    before = step.state;
  }
}

// One replay entry: its tree work outside the lock, then a short locked section keeps it (state, patches, record) or, if the
// run moved meanwhile, undoes it. Entries kept before a stale one stay kept.
async function replayStep(dir, trackId, before, replayed, { lock, ...deps }) {
  const { now, git, slot } = deps;
  const work = structuredClone(before);
  let entry = null;
  let failure = null;
  const slotted = await withCheckSlot(dir, { slots: before.checks ?? 1, command: 'replay', ...slot }, () => {
    try {
      entry = replayNext(dir, work, trackId, deps);
    } catch (e) {
      failure = e;
    }
  });
  if (slotted.busy) return { result: busy({ replayed }) };
  return relock(dir, lock, trackId, before, async fresh => {
    adoptReplay(fresh, before, work, trackId);
    if (entry) fresh.tracks[trackId].status = 'active';
    for (const w of entry?.writes ?? []) writeAtomic(w.path, w.text);
    saveState(dir, fresh, now());
    if (entry) replayed.push(entry.outcome);
    if (failure && !failure.setup) throw failure;
    if (failure) return { result: { ...ok({ action: 'setup-failed', ...failure.setup, replayed }), code: 1, stderr: lines([failure.message]) } };
    if (refusedNext(fresh, trackId) || !replayAhead(fresh, trackId)) return { result: await nextCard(dir, fresh, trackId, deps, replayed) };
    return { state: fresh };
  }, () => rollBackTrees(git, before, work, trackId));
}

const pendingCard = (state, trackId) => state.tracks[trackId].cards.find(k => state.cards[k].status !== 'done');

function replayAhead(state, trackId) {
  const card = pendingCard(state, trackId);
  return state.plan.cards[card]?.mode === 'replay' && !waitingOn(state, card);
}

function refusedNext(state, trackId) {
  const { current } = state.tracks[trackId];
  if (current) return fail(1, `${current.card} is still in progress: end it first`);
  const execution = state.executions.at(-1);
  if (execution.endedAt) return fail(1, `the run is paused (${execution.endReason}): run begin to resume it`);
  return null;
}

function adoptReplay(fresh, before, work, trackId) {
  copyMoved(fresh.tracks[trackId].repos, work.tracks[trackId].repos, before.tracks[trackId].repos);
  copyMoved(fresh.cards, work.cards, before.cards);
  copyMoved(fresh.plan.cards, work.plan.cards, before.plan.cards);
  const { replay, replans = [] } = work.plan.respike;
  copyMoved(fresh.plan.respike.replay, replay, before.plan.respike.replay);
  const added = replans.slice(before.plan.respike.replans?.length ?? 0);
  if (added.length) fresh.plan.respike.replans = [...(fresh.plan.respike.replans ?? []), ...added];
}

async function nextCard(dir, state, trackId, { now, ...deps }, replayed = []) {
  const refused = refusedNext(state, trackId);
  if (refused) return refused;
  const execution = state.executions.at(-1);
  await bindExecution(execution, { ...deps, now });
  const settled = await settleWindows(state, { ...deps, now });
  const respike = state.plan.respike ? { replayed } : {};
  const track = state.tracks[trackId];
  const card = pendingCard(state, trackId);
  if (!card) {
    track.status = 'done';
    if (Object.values(state.tracks).every(t => t.status === 'done' || t.status === 'merged')) return completeRun(dir, state, settled, { now, ...deps }, respike);
    saveState(dir, state, now());
    return ok({ action: 'track-done', track: trackId, ...respike });
  }
  const needed = waitingOn(state, card);
  if (needed) {
    track.status = 'waiting';
    saveState(dir, state, now());
    return ok({ action: 'waiting', track: trackId, card, waitingOn: needed, ...respike });
  }
  const spend = executionSpend(state, execution);
  const stop = capReached(execution, spend);
  if (stop) return pauseRun(dir, state, execution, stop.reason, { now, out: { ...stop, ...respike } });
  if (execution.caps.tokens != null && (!execution.sessions.length || spend.tokens == null)) return refuseUnmeasured(dir, state, execution, { now, out: respike });
  const at = now();
  const resumed = state.cards[card].status === 'in-progress';
  const window = openCardWindow(state, card, execution, at);
  noteStartTrees(state, card);
  const planned = state.plan.cards[card];
  const pr = planned.pr ? applyCardPr(state, trackId, planned.pr.repoDir, { ...deps, dir }) : {};
  const mark = issueMark(state, execution, at);
  window.mark = { ...execution.mark };
  saveState(dir, state, at);
  return ok({
    mark, action: 'card', card, track: trackId, ...respike, ...replayContext(state.cards[card]), ...(resumed ? { resumed } : {}), title: planned.title, url: planned.url, description: planned.description,
    origin: planned.origin, pr: planned.pr, ...pr, offProject: planned.offProject, previous: previousOf(deps.dataDir, state.project.slug, card, state.runId),
    trees: openTrees(state, trackId), window: { start: window.start },
  });
}

function pauseRun(dir, state, execution, reason, { now, out = {} }) {
  const at = now();
  Object.assign(execution, { endedAt: at.toISOString(), endReason: reason });
  state.status = 'paused';
  const mark = issueMark(state, execution, at);
  saveState(dir, state, at);
  return ok({ mark, action: 'pause', reason, ...out });
}

// A fresh mark gives the next call another chance to find the session that logs it.
function refuseUnmeasured(dir, state, execution, { now, out = {} }) {
  const at = now();
  const mark = issueMark(state, execution, at);
  saveState(dir, state, at);
  return {
    ...ok({ mark, action: 'unmeasured', usage: 'unmeasured', cap: execution.caps.tokens, ...out }),
    code: 7,
    stderr: lines([`usage is unmeasured: no session transcript holds the last mark, so the token cap ${execution.caps.tokens} cannot be checked; run next again once this output is in the transcript, or resume with begin without --max-tokens`]),
  };
}

function prunePendingWarnings(state, removed) {
  const warnings = removed.filter(r => r.prunePending)
    .map(r => `${r.repo}: its source checkout ${allRepos(state).find(([d]) => d === r.repo)[1].source} is gone; run git worktree prune there once it is back`);
  return warnings.length ? { warnings } : {};
}

// Replay entries take no window and no box: next applies them one at a time, in order, until a card to spike comes up.
function replayNext(dir, state, trackId, { now, git, dataDir, runSetup, config }) {
  const card = pendingCard(state, trackId);
  const entry = replayEntry(git, state, card, { dir, config: config(), runSetup, dataDir, now });
  if (state.plan.cards[card].mode === 'spike') replanAfterTurn(state, { dataDir }, card);
  return entry;
}

async function completeRun(dir, state, settled, { home, now, git, dataDir, sleep, transcripts }, respike = {}) {
  for (let i = 0; i < SETTLE_POLLS && settled.unsettled.length; i++) {
    await sleep(SETTLE_POLL_MS);
    settled = await settleWindows(state, { dataDir, transcripts, now });
  }
  const at = now();
  let removed;
  try {
    removed = teardownTrees(git, state, { dir });
  } catch (e) {
    if (anyRemoved(state)) saveState(dir, state, at);
    throw e;
  }
  const execution = state.executions.at(-1);
  Object.assign(execution, { endedAt: at.toISOString(), endReason: 'complete' });
  state.status = 'complete';
  const mark = issueMark(state, execution, at);
  saveState(dir, state, at);
  const pruned = pruneRuns(home, state.project.slug, { dataDir });
  const warnings = [
    ...settled.unsettled.map(card => `${card}: its usage window is not settled yet; its record keeps the provisional sum`),
    ...(prunePendingWarnings(state, removed).warnings ?? []),
    ...pruned.skipped.map(s => `run ${s.runId} was not pruned: it is ${s.reason}`),
    ...(pruned.unreadable ?? []).map(f => `no run was pruned: the record ${f} cannot be read`),
  ];
  return ok({
    mark, action: 'complete', runId: state.runId, ...(state.plan.respike ? { respike: true, ...respike } : {}), removed, pruned: pruned.removed, touchedCheckouts: touchedCheckouts(state),
    ...(warnings.length ? { warnings } : {}),
  });
}

async function tree(args, { home, now, git, gh, runSetup, lock, slot }) {
  const a = parseArgs(args, ['--project', '--track']);
  if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
  const [repoDir] = a.positional;
  const config = loadConfig(home);
  if (!Object.hasOwn(config.repos, repoDir)) return fail(1, `${repoDir} is not a repo in the spike config`);
  const first = await onActiveRun(home, a.flags.project, (dir, state) => {
    const allowed = allowedRepos(config, state.project.slug);
    if (!allowed.includes(repoDir)) return { result: fail(1, `${repoDir} is not allowed for project ${state.project.slug}: its repos are ${allowed.join(', ')}`) };
    return { dir, state, trackId: trackIdOf(state, a.flags.track) };
  }, lock);
  if (first.result) return first.result;
  const { dir, state, trackId } = first;
  const work = structuredClone(state);
  let failure = null;
  const slotted = await withCheckSlot(dir, { slots: state.checks ?? 1, command: `tree ${repoDir}`, ...slot }, () => {
    try {
      openTree(git, work, { trackId, repoDir, repo: config.repos[repoDir], dir, runSetup });
    } catch (e) {
      if (!e.setup) throw e;
      failure = e;
    }
  });
  if (slotted.busy) return busy();
  return relock(dir, lock, trackId, state, fresh => {
    const track = fresh.tracks[trackId];
    copyMoved(track.repos, work.tracks[trackId].repos, state.tracks[trackId].repos);
    if (failure) {
      saveState(dir, fresh, now());
      return { ...ok({ action: 'setup-failed', ...failure.setup }), code: 1, stderr: lines([failure.message]) };
    }
    if (track.current) noteStartTrees(fresh, track.current.card);
    const pr = applyCardPr(fresh, trackId, repoDir, { config: () => config, gh, git, dir });
    saveState(dir, fresh, now());
    return ok({ repo: repoDir, path: track.repos[repoDir].path, ...pr, touchedCheckouts: touchedCheckouts(fresh) });
  }, () => rollBackTrees(git, state, work, trackId));
}

// Runs a command in a track's tree under a check slot; the run lock is only held to read the state, never while waiting.
async function check(args, { home, runSetup, slot }) {
  const split = args.indexOf('--');
  const argv = split < 0 ? [] : args.slice(split + 1);
  const a = parseArgs(split < 0 ? args : args.slice(0, split), ['--track', '--cwd', '--project']);
  if (!a || a.positional.length || !argv.length) return fail(2, ...USAGE);
  const { dir, state } = activeRun(home, a.flags.project);
  const repos = openRepos(state, trackIdOf(state, a.flags.track));
  const wanted = a.flags.cwd ? repos.filter(([d]) => d === a.flags.cwd) : repos.slice(0, 1);
  if (!wanted.length) return fail(1, a.flags.cwd ? `${a.flags.cwd} has no open tree in this track` : 'this track has no open tree: run tree <repoDir> first');
  const [[, { path }]] = wanted;
  const slotted = await withCheckSlot(dir, { slots: state.checks ?? 1, command: argv.join(' '), ...slot }, () => runSetup(argv, { cwd: path }));
  if (slotted.busy) return busy();
  const { status, stdout, stderr } = slotted.value;
  return { code: status ?? 1, stdout: stdout ?? '', stderr: stderr ?? '' };
}

// Done cards' patches in the other live tracks: their trees are separate, so these are hints, never blockers.
function otherTrackPatches(dir, state, trackId) {
  return Object.entries(state.tracks).filter(([id, t]) => id !== trackId && !t.mergedInto).flatMap(([track, t]) => t.cards
    .filter(k => state.cards[k].status === 'done')
    .flatMap(card => state.cards[card].patches.map(p => ({ card, track, repo: p.split('/')[0], patch: readFileSync(join(dir, 'patches', p), 'utf8') }))));
}

async function candidates(args, { home, git, lock }) {
  const a = parseArgs(args, ['--repo', '--project', '--track']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, (dir, state) => {
    const trackId = trackIdOf(state, a.flags.track);
    const repos = openRepos(state, trackId).filter(([d]) => !a.flags.repo || d === a.flags.repo);
    if (a.flags.repo && !repos.length) return fail(1, `${a.flags.repo} has no open tree in this track`);
    const found = [];
    for (const [repoDir, repo] of repos) {
      assertLastTree(git, repoDir, repo);
      const working = workingDiff(git, repo, { index: join(dir, 'tmp.index') });
      const earlier = state.tracks[trackId].cards
        .filter(k => state.cards[k].status === 'done')
        .flatMap(card => state.cards[card].patches.filter(p => p.startsWith(`${repoDir}/`)).map(p => ({ card, patch: readFileSync(join(dir, 'patches', p), 'utf8') })));
      for (const c of overlapCandidates(working, earlier)) found.push({ card: c.card, repo: repoDir, path: c.path, ranges: c.ranges });
      const ours = oldSideRanges(working);
      for (const o of otherTrackPatches(dir, state, trackId).filter(x => x.repo === repoDir)) {
        for (const [path, theirs] of oldSideRanges(o.patch)) {
          const ranges = rangesOverlap(ours.get(path) ?? [], theirs);
          if (ranges.length) found.push({ card: o.card, repo: repoDir, path, ranges, otherTrack: o.track });
        }
      }
    }
    return ok({ action: 'candidates', candidates: found });
  }, lock);
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CARD_KEY = /^[A-Z]+-\d+$/;

async function fixup(args, { home, dataDir, now, git, lock }) {
  const split = args.indexOf('--');
  const paths = split === -1 ? [] : args.slice(split + 1);
  const a = parseArgs(split === -1 ? args : args.slice(0, split), ['--fixes', '--slug', '--note', '--repo', '--project', '--track'], ['--allow']);
  const allow = a && parseAllow(a.flags.allow);
  const fixes = [...new Set(a?.flags.fixes?.split(',') ?? [])].sort((x, y) => cardNumber(x) - cardNumber(y));
  const usable = a && !a.positional.length && allow && paths.length && fixes.length && fixes.every(k => CARD_KEY.test(k))
    && KEBAB.test(a.flags.slug ?? '') && a.flags.repo && typeof a.flags.note === 'string';
  if (!usable) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, (dir, state) => fixupCard(dir, state, { ...a.flags, fixes, paths, allow }, { dataDir, now, git }), lock);
}

function fixupCard(dir, state, { fixes, paths, allow, slug, note, repo: repoDir, track: wanted }, { dataDir, now, git }) {
  const trackId = trackIdOf(state, wanted);
  const { current } = state.tracks[trackId];
  if (!current) return fail(1, 'no card is in progress: a fixup is recorded while working the card that caused it');
  const from = current.card;
  if (!note.trim()) return fail(1, 'a fixup needs a non-empty English --note saying what it fixes');
  for (const k of fixes) {
    if (k === from) return fail(1, `${k} is the card in progress: its own changes go in its card patch`);
    if (state.cards[k]?.status !== 'done') return fail(1, `${k} is not done in this run: only a done card can receive a fixup`);
    const other = trackOfCard(state, k);
    if (other !== trackId) return fail(1, `${k} is in track ${other}, not ${trackId}: a change to another track's card is a crossing, not a fixup`);
  }
  const after = structuredClone(state);
  const repo = after.tracks[trackId].repos[repoDir];
  if (repo?.status !== 'open') return fail(1, `${repoDir} has no open tree in this track`);
  checkTree(git, repoDir, repo);
  const snap = snapshot(git, repo, { paths });
  if (!snap) return fail(1, `no change in ${paths.join(', ')} since the last snapshot of ${repoDir}`);
  const file = fixupPatchName(fixes, from, slug);
  const pending = { name: `${repoDir}/${file}`, text: snap.patch };
  const { hits, allowed } = scanPending([pending], allow);
  if (hits.length) return refusedForSecrets(hits);

  const at = now();
  repo.last = snap.tree;
  repo.log.push({ name: basename(file, '.patch'), tree: snap.tree, stat: snap.stat });
  after.fixups = [...(after.fixups ?? []), {
    patch: pending.name, from, fixed: fixes, note, at: at.toISOString(), ...(allowed.length ? { allowedSecrets: allowed } : {}),
  }];
  const records = finishFixup(after, fixes, { pending, dataDir });
  saveState(dir, after, at);
  return ok({ action: 'fixup', patch: pending.name, fixed: fixes, from, records });
}

async function rebuild(args, { home, git, lock }) {
  const a = parseArgs(args, ['--project', '--track']);
  if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
  const [repoDir] = a.positional;
  return onActiveRun(home, a.flags.project, (dir, state) => {
    const repo = state.tracks[trackIdOf(state, a.flags.track)].repos[repoDir];
    if (repo?.status !== 'open') return fail(1, `${repoDir} has no open tree in this track`);
    guardTree(git, repoDir, repo);
    return ok({ repo: repoDir, tree: rebuildTree(git, repoDir, repo, { dir, patchRoot: join(dir, 'patches') }), rebuilt: true });
  }, lock);
}

function readNotes(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the card notes ${path}: ${e.code ?? e.message}`);
  }
}

const ALLOW = /^([a-z-]+):(.+)$/;

function parseAllow(values = []) {
  const out = values.map(v => v.match(ALLOW)).map(m => m && SECRET_KINDS.includes(m[1]) ? { kind: m[1], path: m[2] } : null);
  return out.includes(null) ? null : out;
}

// Each hit is reported with the patch it would land in; an allowed hit is kept aside so the state can record it.
function scanPending(pending, allow) {
  const found = pending.flatMap(p => scanPatch(p.text).map(h => ({ patch: p.name, ...h })));
  const allowed = found.filter(h => allow.some(a => a.kind === h.kind && a.path === h.path));
  return { hits: found.filter(h => !allowed.includes(h)), allowed };
}

const refusedForTypecheck = (repo, log, check) => ({
  ...ok({ action: 'typecheck', repo, log, status: check.status, timedOut: check.timedOut, tail: check.tail }),
  code: 8,
  stderr: lines([`the typecheck failed in ${repo}, nothing was written; fix it, or run end again with --skip-typecheck "<reason>" when the failure is not this card's`]),
});

const refusedForSecrets = hits => ({
  ...ok({ action: 'secret', hits }),
  code: 4,
  stderr: lines([`secret-like content found, nothing was written; for a false positive, run again with ${hits.map(h => `--allow ${h.kind}:${h.path}`).join(' ')}`]),
});

// The notes skeleton for a card of the active run; on a respike it lists the old findings that need an outcome.
async function notesTemplateFor(args, { home, dataDir }) {
  const a = parseArgs(args, ['--project', '--track']);
  if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
  const [card] = a.positional;
  const { state } = activeRun(home, a.flags.project);
  const trackId = trackIdOf(state, a.flags.track);
  if (!state.plan.cards[card]) return fail(1, `${card} is not a card of run ${state.runId}`);
  if (!state.tracks[trackId].cards.includes(card)) return fail(1, `${card} is not a card of track ${trackId}`);
  const previous = previousOf(dataDir, state.project.slug, card, state.runId);
  return ok({ action: 'notes-template', card, notes: notesTemplate(previous), allowed: NOTES_ALLOWED });
}

const notInProgress = card => fail(1, `${card} is not the card in progress`);

async function end(args, { home, dataDir, now, git, transcripts, runSetup, lock, slot }) {
  const config = loadConfig(home);
  const a = parseArgs(args, ['--notes', '--project', '--skip-typecheck', '--track'], ['--allow']);
  const allow = a && parseAllow(a.flags.allow);
  if (!a || a.positional.length !== 1 || !allow) return fail(2, ...USAGE);
  const [card] = a.positional;
  const flags = { ...a.flags, allow };
  const first = await onActiveRun(home, a.flags.project, (dir, state) => {
    const trackId = trackIdOf(state, a.flags.track);
    if (state.tracks[trackId].current?.card !== card) return { result: notInProgress(card) };
    const notesFile = flags.notes ?? join(dir, 'notes', `${card}.json`);
    const notes = readNotes(notesFile);
    const noteErrors = checkNotes(notes);
    if (noteErrors.length) return { result: fail(1, `the notes for ${card} are invalid:`, ...noteErrors) };
    return { dir, state, trackId, notesFile, notes };
  }, lock);
  if (first.result) return first.result;
  const { dir, state, trackId } = first;
  const open = openRepos(state, trackId);
  for (const [repoDir, repo] of open) checkTree(git, repoDir, repo);
  if (flags['skip-typecheck'] === undefined) {
    const slotted = await withCheckSlot(dir, { slots: state.checks ?? 1, command: `typecheck ${card}`, ...slot }, () => {
      for (const [repoDir, repo] of open) {
        const log = typecheckLog(dir, trackId, repoDir);
        const check = repoTypecheck(runSetup, config.repos[repoDir], { treePath: repo.path, changed: changedSinceLast(git, repo), logPath: log });
        if (check.ran && !check.ok) return refusedForTypecheck(repoDir, log, check);
      }
      return null;
    });
    if (slotted.busy) return busy();
    if (slotted.value) return slotted.value;
  }
  return relock(dir, lock, trackId, state, fresh => endCard(dir, fresh, trackId, card, first, flags, { config, dataDir, now, git, transcripts }));
}

async function endCard(dir, state, trackId, card, { notesFile, notes }, flags, { config, dataDir, now, git, transcripts }) {
  if (state.tracks[trackId].current?.card !== card) return notInProgress(card);
  const at = now();
  const after = structuredClone(state);
  const track = after.tracks[trackId];
  const execution = after.executions.find(e => e.id === track.current.execution);
  const cardState = after.cards[card];
  const window = cardState.windows.at(-1);
  window.end = at.toISOString();
  await bindExecution(execution, { transcripts, now });
  const usage = await measure(window, await windowFiles(window, execution, { transcripts, now }));

  const open = openRepos(after, trackId);
  const skip = flags['skip-typecheck'];
  if (skip !== undefined) cardState.typecheck = Object.fromEntries(open.map(([repoDir]) => [repoDir, { skipped: skip }]));
  const pending = [];
  const noChange = [];
  for (const [repoDir, repo] of open) {
    const snap = snapshot(git, repo);
    if (!snap) { noChange.push(repoDir); continue; }
    const file = cardPatchName(card, after.plan.cards[card].origin);
    repo.last = snap.tree;
    repo.log.push({ name: basename(file, '.patch'), tree: snap.tree, stat: snap.stat });
    pending.push({ name: `${repoDir}/${file}`, text: snap.patch });
  }
  const derived = open.map(([repoDir, repo]) => deriveRepo(git, repoDir, {
    cwd: repo.path, rules: config.repos[repoDir]?.risk ?? [], startTree: cardState.startTrees?.[repoDir] ?? repo.baseTree, endTree: repo.last,
  }));
  cardState.riskAreas = mergeRiskAreas(derived.map(d => d.riskAreas));
  cardState.newPaths = [...new Set(derived.flatMap(d => d.newPaths))].sort();
  const { hits, allowed } = scanPending(pending, flags.allow);
  if (hits.length) return refusedForSecrets(hits);
  if (allowed.length) cardState.allowedSecrets = [...(cardState.allowedSecrets ?? []), ...allowed];
  cardState.patches = pending.map(p => p.name);
  const { path } = finishCard(after, card, notes, { pending, dataDir });
  if (resolve(notesFile) !== resolve(notesPath(after, card))) writeJsonAtomic(notesPath(after, card), notes);

  cardState.status = 'done';
  cardState.recordWrittenAt = at.toISOString();
  track.current = null;
  const mark = issueMark(after, execution, at);
  saveState(dir, after, at);
  const crossingSuspects = crossingSuspectsOf(dir, after, trackId, pending);
  const cases = notes.cases?.length ?? 0;
  const box = timeBoxFor(cardState);
  const warnings = [
    ...(cases < 3 || cases > 6 ? [`${cases} case(s) written; 3 to 6 are expected`] : []),
    ...(box?.over ? [`${card} spent ${box.spent} of its box ${box.budget}; the box is a warning only`] : []),
  ];
  return ok({
    mark, card, record: path, patches: cardState.patches, noChange,
    usage: usage ? { messages: usage.messages, w: window.w } : 'unmeasured',
    ...(crossingSuspects.length ? { crossingSuspects } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
}

function crossingSuspectsOf(dir, state, trackId, pending) {
  const changed = pending.flatMap(p => [...oldSideRanges(p.text).keys()].map(path => ({ repo: p.name.split('/')[0], path })));
  const found = new Map();
  for (const o of otherTrackPatches(dir, state, trackId)) {
    for (const path of oldSideRanges(o.patch).keys()) {
      if (changed.some(c => c.repo === o.repo && c.path === path)) found.set(`${o.card}\0${o.repo}\0${path}`, { card: o.card, track: o.track, repo: o.repo, path });
    }
  }
  return [...found.values()];
}

// The card stays in progress: a later execution reopens it in a new window.
async function closeCurrentWindow(state, endReason, { now, transcripts }) {
  for (const track of Object.values(state.tracks)) {
    const { current } = track;
    if (!current) continue;
    track.current = null;
    const window = state.cards[current.card].windows.at(-1);
    const execution = state.executions.find(e => e.id === current.execution);
    await bindExecution(execution, { transcripts, now });
    Object.assign(window, { end: now().toISOString(), endReason });
    await measure(window, await windowFiles(window, execution, { transcripts, now }));
  }
}

async function pause(args, { home, now, transcripts, lock }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, async (dir, state) => {
    const execution = state.executions.at(-1);
    if (execution.endedAt) return fail(1, `the run is already paused (${execution.endReason}): run begin to resume it`);
    await closeCurrentWindow(state, 'paused', { now, transcripts });
    return pauseRun(dir, state, execution, 'paused', { now, out: { runId: state.runId } });
  }, lock);
}

async function abandon(args, { home, now, git, transcripts, lock }) {
  const discard = args.includes('--discard');
  const a = parseArgs(args.filter(x => x !== '--discard'), ['--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, async (dir, state) => {
    let removed;
    try {
      removed = teardownTrees(git, state, { dir, discard, advice: 'end the card that made it, or pass --discard to drop it with the run' });
    } catch (e) {
      if (anyRemoved(state)) saveState(dir, state, now());
      throw e;
    }
    await closeCurrentWindow(state, 'abandoned', { now, transcripts });
    const at = now();
    for (const e of state.executions.filter(x => !x.endedAt)) Object.assign(e, { endedAt: at.toISOString(), endReason: 'abandoned' });
    state.status = 'abandoned';
    const mark = issueMark(state, state.executions.at(-1), at);
    saveState(dir, state, at);
    return ok({ mark, action: 'abandon', runId: state.runId, removed, touchedCheckouts: touchedCheckouts(state), ...prunePendingWarnings(state, removed) });
  }, lock);
}

// Read-only: a session found by its mark is used for this answer and not bound. A run with several live tracks reports
// each track's card in its tracks list instead.
async function currentSpend(state, { now, transcripts }) {
  const live = Object.values(state.tracks).filter(t => !t.mergedInto);
  const current = live.length === 1 ? live[0].current : null;
  if (!current) return null;
  const cardState = state.cards[current.card];
  const execution = state.executions.find(e => e.id === current.execution);
  const bound = execution.sessions.map(s => s.file);
  const found = execution.mark && !execution.sessions.some(s => s.given)
    ? await bindSession({ root: transcripts, nonce: execution.mark.nonce, issuedAt: execution.mark.issuedAt, bound })
    : null;
  const unbound = found && !bound.includes(found.file) ? [{ file: found.file, ...(found.subagent ? { subagent: true } : {}) }] : [];
  const files = await windowFiles(cardState.windows.at(-1), { ...execution, sessions: [...execution.sessions, ...unbound] }, { transcripts, now, keep: false });
  const closed = cardState.windows.slice(0, -1);
  let spent = 'unmeasured';
  if (files.length && closed.every(w => typeof w.w === 'number')) {
    const usage = await windowUsage({ files, start: cardState.windows.at(-1).start, end: now().toISOString() });
    spent = Math.round(closed.reduce((sum, w) => sum + w.w, 0) + weighted(usage.tokens));
  }
  const over = cardState.box != null && typeof spent === 'number' ? { over: spent > cardState.box } : {};
  return { card: current.card, startedAt: current.startedAt, box: cardState.box, spent, ...over };
}

const replayOutcomes = state => state.plan.order.filter(k => Object.hasOwn(state.plan.respike.replay ?? {}, k))
  .map(card => ({ card, mode: state.plan.cards[card].mode, status: state.cards[card].replay?.status ?? 'pending' }));

const trackList = state => Object.entries(state.tracks).map(([id, t]) => ({
  id, status: t.status, current: t.current?.card ?? null, done: t.cards.filter(k => state.cards[k].status === 'done').length, total: t.cards.length, mergedInto: t.mergedInto,
}));

async function tracks(args, { home }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return ok({ action: 'tracks', tracks: trackList(activeRun(home, a.flags.project).state) });
}

async function status(args, { home, now, transcripts }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  const { state } = activeRun(home, a.flags.project);
  const execution = state.executions.at(-1);
  const spend = executionSpend(state, execution);
  const cardsIn = wanted => state.plan.order.filter(k => state.cards[k].status === wanted);
  return ok({
    action: 'status',
    runId: state.runId,
    status: state.status,
    project: { slug: state.project.slug, name: state.project.name },
    execution: {
      id: execution.id, startedAt: execution.startedAt, endedAt: execution.endedAt, endReason: execution.endReason, caps: execution.caps, box: execution.box,
      spent: { cards: spend.cards, tokens: spend.tokens == null || !execution.sessions.length ? 'unmeasured' : Math.round(spend.tokens) },
      sessions: execution.sessions.map(s => s.file),
    },
    current: await currentSpend(state, { now, transcripts }),
    tracks: trackList(state),
    cards: { done: cardsIn('done'), inProgress: cardsIn('in-progress'), pending: cardsIn('pending') },
    ...(state.plan.respike ? { modes: Object.fromEntries(state.plan.order.map(k => [k, state.plan.cards[k].mode])), replays: replayOutcomes(state) } : {}),
    trees: allRepos(state).filter(([, r]) => r.status !== 'removed').map(([repo, r]) => ({ repo, kind: r.kind, status: r.status, path: r.path })),
    unsettled: unsettledWindows(state).map(({ card, window }) => ({ card, execution: window.execution, end: window.end })),
  });
}

// The draft is respike's config step; before a first spike no card has a record, so every card counts as stale.
function config(args, { env, fetchImpl, keyFile, now, home, dataDir, git, gh }) {
  return respike(['config', ...args], { env, fetchImpl, keyFile, now, home, dataDir, git, gh });
}

async function prune(args, { home, dataDir }) {
  const dryRun = args.includes('--dry-run');
  const a = parseArgs(args.filter(x => x !== '--dry-run'));
  if (!a || a.positional.length > 1 || !a.positional.every(isSlug)) return fail(2, ...USAGE);
  const slugs = a.positional.length ? a.positional : prunableSlugs(home);
  return ok({ action: 'prune', dryRun, projects: slugs.map(slug => pruneRuns(home, slug, { dryRun, dataDir })) });
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2), { transcripts: transcriptsRoot(process.env) });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
