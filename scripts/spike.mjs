#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run as respike } from './respike.mjs';
import { basename, join, resolve } from 'node:path';
import { fail, isEntry, lines, ok, parseArgs, redacted } from './lib/cli.mjs';
import { analyzeProject } from './lib/graph.mjs';
import { fetchDescriptions, fetchProject, fetchProjectMap, parseProjectRef, readLinearKey } from './lib/linear-fetch.mjs';
import { checkNotes, finishCard, finishFixup, NOTES_ALLOWED, notesPath, notesTemplate, rewriteUsage } from './lib/spike/build-record.mjs';
import { deriveRepo, mergeRiskAreas } from './lib/spike/derive.mjs';
import { allowedRepos, loadConfig } from './lib/spike/config.mjs';
import { ghRunner, gitRunner, setupRunner } from './lib/spike/exec.mjs';
import { dataInRepoWarnings, REPO_DATA_DIR } from './lib/records.mjs';
import { assertHomeOutsideWorkTree, dataDirFor, displayData, runDir, runIdAt, sequencerHome, withLock, writeJsonAtomic } from './lib/spike/home.mjs';
import { existingPrs, spikeOrder } from './lib/spike/order.mjs';
import { LIMIT_FLAGS, limitsFrom, sessionsFrom } from './lib/spike/limits.mjs';
import { isSlug, prunableSlugs, pruneRuns } from './lib/spike/prune.mjs';
import { previousOf, replanAfterTurn, replayContext, replayEntry } from './lib/spike/replay.mjs';
import { changedSinceLast, repoTypecheck, typecheckLog } from './lib/spike/typecheck.mjs';
import { cardPatchName, fixupPatchName, overlapCandidates, snapshot, workingDiff } from './lib/spike/snapshot.mjs';
import { scanPatch, SECRET_KINDS } from './lib/spike/secrets.mjs';
import {
  activeRunFor, activeRuns, allRepos, capReached, closeOpenExecutions, createRun, executionSpend, issueMark, latestRun, noteStartTrees, openCardWindow,
  openExecution, readState, saveState, timeBoxFor, trackIdOf, trackOf, unsettledWindows,
} from './lib/spike/state.mjs';
import { applyPrDiff, assertLastTree, checkTree, guardTree, openTree, rebuildTree, teardownTrees, touchedCheckouts } from './lib/spike/trees.mjs';
import { bindSession, lastEntryAt, sessionFiles, transcriptsRoot, weighted, windowUsage } from './lib/spike/usage-window.mjs';

const USAGE = [
  'usage: node scripts/spike.mjs begin <project ref> [--max-tokens <n>] [--max-cards <n>] [--box <n>] [--session-file <transcript.jsonl>]',
  'usage: node scripts/spike.mjs next [--project <project ref>]',
  'usage: node scripts/spike.mjs tree <repoDir> [--project <project ref>]',
  'usage: node scripts/spike.mjs notes-template <CARD> [--project <project ref>]',
  'usage: node scripts/spike.mjs end <CARD> [--notes <notes.json>] [--allow <kind>:<path>]... [--skip-typecheck <reason>] [--project <project ref>]',
  'usage: node scripts/spike.mjs candidates [--repo <repoDir>] [--project <project ref>]',
  'usage: node scripts/spike.mjs fixup --fixes <CARD>[,<CARD>] --slug <kebab-slug> --note <text> --repo <repoDir> [--allow <kind>:<path>]... [--project <project ref>] -- <path>...',
  'usage: node scripts/spike.mjs rebuild <repoDir> [--project <project ref>]',
  'usage: node scripts/spike.mjs pause [--project <project ref>]',
  'usage: node scripts/spike.mjs abandon [--discard] [--project <project ref>]',
  'usage: node scripts/spike.mjs prune [<slug>] [--dry-run]',
  'usage: node scripts/spike.mjs status [--project <project ref>]',
  'usage: node scripts/spike.mjs config <project ref> --out <draft.json> [--root <dir>]...',
  'usage: node scripts/spike.mjs config --draft <draft.json> [--approve <hash>]',
];

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);

const COMMANDS = { begin, next, tree, candidates, 'notes-template': notesTemplateFor, end, fixup, rebuild, pause, abandon, prune, status, config };

// transcripts: null means no session discovery, so only an explicit --session-file is ever read.
export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), home, dataDir, repoDataDir,
  transcripts = null, git = gitRunner(), gh = ghRunner(), runSetup = setupRunner(), sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const deps = { env, fetchImpl, keyFile, now, home: home ?? sequencerHome(env), dataDir: dataDir ?? home ?? dataDirFor(env), transcripts, git, gh, runSetup, sleep };
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
function onActiveRun(home, ref, fn) {
  const { dir } = activeRun(home, ref);
  return withLock(dir, () => fn(dir, readState(dir)));
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
  if (found && !bound.includes(found.file)) execution.sessions.push({ file: found.file, boundAt: now().toISOString() });
}

const usageFiles = execution => execution.sessions.flatMap(s => sessionFiles(s.file));

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
async function settleWindows(state, { dataDir }) {
  const moved = new Set();
  const unsettled = new Set();
  for (const { card, window, execution } of unsettledWindows(state)) {
    const before = { messages: window.messages, tokens: window.tokens };
    const usage = await measure(window, usageFiles(execution));
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

async function startRun(ref, key, flags, { fetchImpl, now, home, dataDir, gh, git }) {
  const config = loadConfig(home);
  const known = await fetchProject(ref, key, { fetchImpl });
  const existing = activeRunFor(home, known.slugId);
  if (existing) return withLock(existing.dir, () => resumeRun({ dir: existing.dir, state: readState(existing.dir) }, flags, { now, git, dataDir }));
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
  await withLock(dir, () => saveState(dir, state, at));
  return begun(state, mark, false);
}

const isOpen = ([, r]) => r.status === 'open';
const openRepos = state => Object.entries(trackOf(state).repos).filter(isOpen);
const anyRemoved = state => allRepos(state).some(([, r]) => r.status === 'removed');

// The card in progress keeps its status; its open window closes at the last transcript line of its execution,
// and next opens a new one. A window with no line after its start held no work and is dropped.
async function closeInterruptedCard(state, track, at) {
  const { current } = track;
  if (!current) return;
  track.current = null;
  const cardState = state.cards[current.card];
  const window = cardState.windows.at(-1);
  if (window.end) return;
  const execution = state.executions.find(e => e.id === current.execution);
  const files = usageFiles(execution);
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

async function resumeRun({ dir, state }, flags, { now, git, dataDir }) {
  for (const [repoDir, repo] of allRepos(state).filter(isOpen)) checkTree(git, repoDir, repo);
  const at = now();
  for (const track of Object.values(state.tracks)) await closeInterruptedCard(state, track, at);
  await settleWindows(state, { dataDir });
  closeOpenExecutions(state);
  state.status = 'active';
  const execution = openExecution(state, { now: at, sessions: sessionsFrom(flags, at), ...flags.limits });
  const mark = issueMark(state, execution, at);
  saveState(dir, state, at);
  return begun(state, mark, true);
}

const openTrees = state => Object.fromEntries(openRepos(state).map(([d, r]) => [d, r.path]));

// The diff goes into the card's repo tree once: when the tree opens during the card, or at next if it is already open.
function applyCardPr(state, repoDir, { config, gh, git, dir }) {
  const track = trackOf(state);
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

async function next(args, { home, now, gh, git, transcripts, dataDir, sleep, runSetup }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  const deps = { home, now, config: () => loadConfig(home), gh, git, transcripts, dataDir, sleep, runSetup };
  return onActiveRun(home, a.flags.project, (dir, state) => nextCard(dir, state, deps));
}

const pendingCard = state => state.plan.order.find(k => state.cards[k].status !== 'done');

async function nextCard(dir, state, { now, ...deps }) {
  const { current } = trackOf(state);
  if (current) return fail(1, `${current.card} is still in progress: end it first`);
  const execution = state.executions.at(-1);
  if (execution.endedAt) return fail(1, `the run is paused (${execution.endReason}): run begin to resume it`);
  await bindExecution(execution, { ...deps, now });
  const settled = await settleWindows(state, deps);
  const replayed = [];
  const respike = state.plan.respike ? { replayed } : {};
  try {
    replayPending(dir, state, { now, ...deps }, replayed);
  } catch (e) {
    if (!e.setup) throw e;
    return { ...ok({ action: 'setup-failed', ...e.setup, ...respike }), code: 1, stderr: lines([e.message]) };
  }
  const card = pendingCard(state);
  if (!card) return completeRun(dir, state, settled, { now, ...deps }, respike);
  const spend = executionSpend(state, execution);
  const stop = capReached(execution, spend);
  if (stop) return pauseRun(dir, state, execution, stop.reason, { now, out: { ...stop, ...respike } });
  if (execution.caps.tokens != null && (!execution.sessions.length || spend.tokens == null)) return refuseUnmeasured(dir, state, execution, { now, out: respike });
  const at = now();
  const resumed = state.cards[card].status === 'in-progress';
  const window = openCardWindow(state, card, execution, at);
  noteStartTrees(state, card);
  const planned = state.plan.cards[card];
  const pr = planned.pr ? applyCardPr(state, planned.pr.repoDir, { ...deps, dir }) : {};
  const mark = issueMark(state, execution, at);
  saveState(dir, state, at);
  return ok({
    mark, action: 'card', card, ...respike, ...replayContext(state.cards[card]), ...(resumed ? { resumed } : {}), title: planned.title, url: planned.url, description: planned.description,
    origin: planned.origin, pr: planned.pr, ...pr, offProject: planned.offProject, previous: previousOf(deps.dataDir, state.project.slug, card, state.runId),
    trees: openTrees(state), window: { start: window.start },
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

// Replay entries take no window and no box: each is applied in order until a card to spike comes up.
// out collects the outcomes as they come, so a caller still has them when a later entry throws.
function replayPending(dir, state, { now, git, dataDir, runSetup, config }, out = []) {
  for (let card = pendingCard(state); card && state.plan.cards[card].mode === 'replay'; card = pendingCard(state)) {
    try {
      out.push(...replayEntry(git, state, card, { dir, config: config(), runSetup, dataDir, now }));
      if (state.plan.cards[card].mode === 'spike') replanAfterTurn(state, { dataDir }, card);
    } finally {
      saveState(dir, state, now());
    }
  }
  return out;
}

async function completeRun(dir, state, settled, { home, now, git, dataDir, sleep }, respike = {}) {
  for (let i = 0; i < SETTLE_POLLS && settled.unsettled.length; i++) {
    await sleep(SETTLE_POLL_MS);
    settled = await settleWindows(state, { dataDir });
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

async function tree(args, { home, now, git, gh, runSetup }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
  const [repoDir] = a.positional;
  const config = loadConfig(home);
  if (!Object.hasOwn(config.repos, repoDir)) return fail(1, `${repoDir} is not a repo in the spike config`);
  return onActiveRun(home, a.flags.project, (dir, state) => {
    const allowed = allowedRepos(config, state.project.slug);
    if (!allowed.includes(repoDir)) return fail(1, `${repoDir} is not allowed for project ${state.project.slug}: its repos are ${allowed.join(', ')}`);
    let repo;
    try {
      repo = openTree(git, state, { trackId: trackIdOf(state), repoDir, repo: config.repos[repoDir], dir, runSetup });
    } catch (e) {
      if (!e.setup) throw e;
      saveState(dir, state, now());
      return { ...ok({ action: 'setup-failed', ...e.setup }), code: 1, stderr: lines([e.message]) };
    }
    const { current } = trackOf(state);
    if (current) noteStartTrees(state, current.card);
    const pr = applyCardPr(state, repoDir, { config: () => config, gh, git, dir });
    saveState(dir, state, now());
    return ok({ repo: repoDir, path: repo.path, ...pr, touchedCheckouts: touchedCheckouts(state) });
  });
}

async function candidates(args, { home, git }) {
  const a = parseArgs(args, ['--repo', '--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, (dir, state) => {
    const repos = openRepos(state).filter(([d]) => !a.flags.repo || d === a.flags.repo);
    if (a.flags.repo && !repos.length) return fail(1, `${a.flags.repo} has no open tree in this run`);
    const found = [];
    for (const [repoDir, repo] of repos) {
      assertLastTree(git, repoDir, repo);
      const working = workingDiff(git, repo, { index: join(dir, 'tmp.index') });
      const earlier = state.plan.order
        .filter(k => state.cards[k].status === 'done')
        .flatMap(card => state.cards[card].patches.filter(p => p.startsWith(`${repoDir}/`)).map(p => ({ card, patch: readFileSync(join(dir, 'patches', p), 'utf8') })));
      for (const c of overlapCandidates(working, earlier)) found.push({ card: c.card, repo: repoDir, path: c.path, ranges: c.ranges });
    }
    return ok({ action: 'candidates', candidates: found });
  });
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CARD_KEY = /^[A-Z]+-\d+$/;

async function fixup(args, { home, dataDir, now, git }) {
  const split = args.indexOf('--');
  const paths = split === -1 ? [] : args.slice(split + 1);
  const a = parseArgs(split === -1 ? args : args.slice(0, split), ['--fixes', '--slug', '--note', '--repo', '--project'], ['--allow']);
  const allow = a && parseAllow(a.flags.allow);
  const fixes = [...new Set(a?.flags.fixes?.split(',') ?? [])].sort((x, y) => cardNumber(x) - cardNumber(y));
  const usable = a && !a.positional.length && allow && paths.length && fixes.length && fixes.every(k => CARD_KEY.test(k))
    && KEBAB.test(a.flags.slug ?? '') && a.flags.repo && typeof a.flags.note === 'string';
  if (!usable) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, (dir, state) => fixupCard(dir, state, { ...a.flags, fixes, paths, allow }, { dataDir, now, git }));
}

function fixupCard(dir, state, { fixes, paths, allow, slug, note, repo: repoDir }, { dataDir, now, git }) {
  const { current } = trackOf(state);
  if (!current) return fail(1, 'no card is in progress: a fixup is recorded while working the card that caused it');
  const from = current.card;
  if (!note.trim()) return fail(1, 'a fixup needs a non-empty English --note saying what it fixes');
  for (const k of fixes) {
    if (k === from) return fail(1, `${k} is the card in progress: its own changes go in its card patch`);
    if (state.cards[k]?.status !== 'done') return fail(1, `${k} is not done in this run: only a done card can receive a fixup`);
  }
  const after = structuredClone(state);
  const repo = trackOf(after).repos[repoDir];
  if (repo?.status !== 'open') return fail(1, `${repoDir} has no open tree in this run`);
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

async function rebuild(args, { home, git }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
  const [repoDir] = a.positional;
  return onActiveRun(home, a.flags.project, (dir, state) => {
    const repo = trackOf(state).repos[repoDir];
    if (repo?.status !== 'open') return fail(1, `${repoDir} has no open tree in this run`);
    guardTree(git, repoDir, repo);
    return ok({ repo: repoDir, tree: rebuildTree(git, repoDir, repo, { dir, patchRoot: join(dir, 'patches') }), rebuilt: true });
  });
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
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
  const [card] = a.positional;
  const { state } = activeRun(home, a.flags.project);
  if (!state.plan.cards[card]) return fail(1, `${card} is not a card of run ${state.runId}`);
  const previous = previousOf(dataDir, state.project.slug, card, state.runId);
  return ok({ action: 'notes-template', card, notes: notesTemplate(previous), allowed: NOTES_ALLOWED });
}

async function end(args, { home, dataDir, now, git, transcripts, runSetup }) {
  const config = loadConfig(home);
  const a = parseArgs(args, ['--notes', '--project', '--skip-typecheck'], ['--allow']);
  const allow = a && parseAllow(a.flags.allow);
  if (!a || a.positional.length !== 1 || !allow) return fail(2, ...USAGE);
  const [card] = a.positional;
  return onActiveRun(home, a.flags.project, (dir, state) => endCard(dir, state, card, { ...a.flags, allow }, { config, dataDir, now, git, transcripts, runSetup }));
}

async function endCard(dir, state, card, flags, { config, dataDir, now, git, transcripts, runSetup }) {
  if (trackOf(state).current?.card !== card) return fail(1, `${card} is not the card in progress`);
  const notesFile = flags.notes ?? join(dir, 'notes', `${card}.json`);
  const notes = readNotes(notesFile);
  const noteErrors = checkNotes(notes);
  if (noteErrors.length) return fail(1, `the notes for ${card} are invalid:`, ...noteErrors);

  const at = now();
  const after = structuredClone(state);
  const track = trackOf(after);
  const execution = after.executions.find(e => e.id === track.current.execution);
  const cardState = after.cards[card];
  const window = cardState.windows.at(-1);
  window.end = at.toISOString();
  await bindExecution(execution, { transcripts, now });
  const usage = await measure(window, usageFiles(execution));

  const open = openRepos(after);
  for (const [repoDir, repo] of open) checkTree(git, repoDir, repo);
  const skip = flags['skip-typecheck'];
  if (skip !== undefined) cardState.typecheck = Object.fromEntries(open.map(([repoDir]) => [repoDir, { skipped: skip }]));
  else {
    for (const [repoDir, repo] of open) {
      const log = typecheckLog(dir, repoDir);
      const check = repoTypecheck(runSetup, config.repos[repoDir], { treePath: repo.path, changed: changedSinceLast(git, repo), logPath: log });
      if (check.ran && !check.ok) return refusedForTypecheck(repoDir, log, check);
    }
  }
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
  const cases = notes.cases?.length ?? 0;
  const box = timeBoxFor(cardState);
  const warnings = [
    ...(cases < 3 || cases > 6 ? [`${cases} case(s) written; 3 to 6 are expected`] : []),
    ...(box?.over ? [`${card} spent ${box.spent} of its box ${box.budget}; the box is a warning only`] : []),
  ];
  return ok({
    mark, card, record: path, patches: cardState.patches, noChange,
    usage: usage ? { messages: usage.messages, w: window.w } : 'unmeasured',
    ...(warnings.length ? { warnings } : {}),
  });
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
    await measure(window, usageFiles(execution));
  }
}

async function pause(args, { home, now, transcripts }) {
  const a = parseArgs(args, ['--project']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return onActiveRun(home, a.flags.project, async (dir, state) => {
    const execution = state.executions.at(-1);
    if (execution.endedAt) return fail(1, `the run is already paused (${execution.endReason}): run begin to resume it`);
    await closeCurrentWindow(state, 'paused', { now, transcripts });
    return pauseRun(dir, state, execution, 'paused', { now, out: { runId: state.runId } });
  });
}

async function abandon(args, { home, now, git, transcripts }) {
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
  });
}

// Read-only: a session found by its mark is used for this answer and not bound.
async function currentSpend(state, { now, transcripts }) {
  const { current } = trackOf(state);
  if (!current) return null;
  const cardState = state.cards[current.card];
  const execution = state.executions.find(e => e.id === current.execution);
  const bound = execution.sessions.map(s => s.file);
  const found = execution.mark && !execution.sessions.some(s => s.given)
    ? await bindSession({ root: transcripts, nonce: execution.mark.nonce, issuedAt: execution.mark.issuedAt, bound })
    : null;
  const files = [...new Set([...bound, ...(found ? [found.file] : [])])].flatMap(sessionFiles);
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
