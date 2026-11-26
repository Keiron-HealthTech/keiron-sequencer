#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exitError, fail, isEntry, lines, ok, parseArgs, redacted } from './lib/cli.mjs';
import { fetchDescriptions, parseProjectRef, readLinearKey } from './lib/linear-fetch.mjs';
import { readRecords, REPO_DATA_DIR } from './lib/records.mjs';
import { buildRespikePlan } from './lib/respike/plan.mjs';
import { contractedEdges } from './lib/respike/selection.mjs';
import { parseWorktrees } from './lib/start/checkout.mjs';
import { gapLine } from './lib/respike/coverage.mjs';
import { buildReport, previousRecords } from './lib/respike/report.mjs';
import { gatherAudit, inputsPath, markRecord, readInputs, validateVerdicts, verdictSummary } from './lib/respike/audit.mjs';
import { gatherPrCheck, markPrCheck, validatePrVerdicts } from './lib/respike/pr-check.mjs';
import { serializeRecord } from './lib/record.mjs';
import { findDiffText } from './lib/spike/build-record.mjs';
import { configPath, expandHome, readConfigBytes, writeConfig } from './lib/spike/config.mjs';
import { draftFacts, oldTrialDir, scanRoots, toolProber } from './lib/spike/config-detect.mjs';
import {
  assertDraftPath, buildDraft, changesBetween, diffFromBase, draftHash, draftState, EMPTY_BASE, planningConfig, rawConfigOf, readRawConfig, readRiskTemplate,
  redactText, redactUrls, searchTargets, strayKeys,
} from './lib/spike/config-draft.mjs';
import { ghRunner, gitRunner, setupRunner } from './lib/spike/exec.mjs';
import { assertHomeOutsideWorkTree, dataDirFor, displayData, RUN_ID, runDir, runIdAt, sequencerHome, trialPatchRoot, trialReferenceDir, withLock, writeAtomic } from './lib/spike/home.mjs';
import { LIMIT_FLAGS, limitsFrom, sessionsFrom } from './lib/spike/limits.mjs';
import { createRun, issueMark, openExecution, readState, saveState } from './lib/spike/state.mjs';

const RISK_TEMPLATE = fileURLToPath(new URL('../docs/spike-config.example.json', import.meta.url));

// The draft only asks tools for their version; corepack must neither download one nor prompt for it to answer.
const PROBE_ENV = { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };

const SELECT = '[--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... '
  + '[--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]...';
const USAGE = [
  `usage: node scripts/respike.mjs preflight <project ref> ${SELECT}`,
  `usage: node scripts/respike.mjs fetch <project ref> --approve <hash> ${SELECT}`,
  `usage: node scripts/respike.mjs fast-forward <project ref> --repo <repoDir> --approve <hash> ${SELECT}`,
  `usage: node scripts/respike.mjs begin <project ref> --approve <hash> ${SELECT} [--max-tokens <n>] [--max-cards <n>] [--box <n>] [--workers <n>] [--checks <n>] [--session-file <transcript.jsonl>]`,
  `usage: node scripts/respike.mjs config <project ref> --out <draft.json> [--root <dir>]... ${SELECT}`,
  'usage: node scripts/respike.mjs config --draft <draft.json> [--approve <hash>]',
  'usage: node scripts/respike.mjs report <project ref> [--run <runId>]',
  `usage: node scripts/respike.mjs audit <project ref> --before ${SELECT}`,
  'usage: node scripts/respike.mjs audit <project ref> --before --verdicts <verdicts.json>',
  'usage: node scripts/respike.mjs audit <project ref> [--run <runId>]',
  'usage: node scripts/respike.mjs audit <project ref> --verdicts <verdicts.json> [--run <runId>]',
];

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);

const COMMANDS = { preflight, fetch: fetchHeads, 'fast-forward': fastForward, begin, config, report, audit };

export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), home, dataDir, repoDataDir, git = gitRunner(), gh = ghRunner(),
  trialLogDir, tmpRoot = tmpdir(), userHome = homedir(), riskTemplate = RISK_TEMPLATE, runSetup = setupRunner({ env: PROBE_ENV }),
} = {}) {
  const deps = { env, fetchImpl, keyFile, now, home: home ?? sequencerHome(env), dataDir: dataDir ?? home ?? dataDirFor(env), repoDataDir: repoDataDir ?? (dataDir === undefined && home === undefined ? REPO_DATA_DIR : null), git, gh, trialLogDir, tmpRoot, userHome, riskTemplate, runSetup };
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command)) return fail(2, ...USAGE);
  try {
    assertHomeOutsideWorkTree(deps.home);
    return await COMMANDS[command](rest, deps);
  } catch (e) {
    return fail(e.exitCode ?? 1, e.message);
  }
}

const BUILT_ANSWER = /^([A-Z]+-\d+)=(\S+)$/;
const HAND_ANSWER = /^([A-Z]+-\d+:[cdm]\d+)=([A-Z]+-\d+)$/;
const ITEM_KEY = /^[A-Z]+-\d+:[cdm]\d+$/;
const CARD_KEY = /^[A-Z]+-\d+$/;

// Selection and answer flags; null on a usage error. --stale and --all take no value, so they are taken out before parseArgs.
// With no --cards and no --all the selection is the stale cards: a plain respike replays what is still fresh.
function selectionArgs(args, flags = [], many = []) {
  const all = args.includes('--all');
  const a = parseArgs(args.filter(x => x !== '--stale' && x !== '--all' && x !== '--before'), ['--cards', ...flags],
    ['--built', '--unbuilt', '--with-default', '--hand', '--drop', '--skip-check', ...many]);
  const parsed = a?.positional.length === 1 ? parseProjectRef(a.positional[0]) : null;
  if (!parsed) return null;
  const built = (a.flags.built ?? []).map(v => BUILT_ANSWER.exec(v));
  const unbuilt = a.flags.unbuilt ?? [];
  if (built.some(m => !m) || !unbuilt.every(k => CARD_KEY.test(k))) return { error: 'malformed --built <CARD>=<branch> or --unbuilt <CARD>' };
  const hand = (a.flags.hand ?? []).map(v => HAND_ANSWER.exec(v));
  const drop = a.flags.drop ?? [];
  const skipCheck = a.flags['skip-check'] ?? [];
  if (hand.some(m => !m) || !drop.every(k => ITEM_KEY.test(k)) || !skipCheck.every(k => CARD_KEY.test(k))) {
    return { error: 'malformed --hand <CARD>:<item>=<CARD>, --drop <CARD>:<item> or --skip-check <CARD>' };
  }
  return {
    ref: parsed.ref, flags: a.flags,
    options: {
      cards: a.flags.cards === undefined ? null : a.flags.cards.split(',').filter(Boolean),
      stale: !all && (args.includes('--stale') || a.flags.cards === undefined),
      all,
      answers: {
        built: new Map(built.map(m => [m[1], m[2]])), unbuilt: new Set(unbuilt), withDefault: new Set(a.flags['with-default'] ?? []),
        hand: new Map(hand.map(m => [m[1], m[2]])), drop: new Set(drop), skipCheck: new Set(skipCheck),
      },
    },
  };
}

async function withKey(deps, fn) {
  const { key, reason } = readLinearKey(deps.env, deps.keyFile);
  if (!key) return fail(3, reason);
  try {
    return redacted(await fn(key), key);
  } catch (e) {
    return redacted(fail(e.exitCode ?? 1, e.message), key);
  }
}

function planOutput(plan) {
  if (plan.action !== 'blocked') return ok(plan);
  return { ...ok(plan), code: 2, stderr: lines(plan.missingConfig.map(gapLine)) };
}

async function preflight(args, deps) {
  const a = selectionArgs(args);
  if (!a) return fail(2, ...USAGE);
  if (a.error) return fail(2, a.error, ...USAGE);
  return withKey(deps, async key => planOutput((await buildRespikePlan(a.ref, key, a.options, deps)).plan));
}

function runPlan(built, at) {
  const { plan, analysis, descriptions } = built;
  const byKey = new Map(analysis.cards.map(c => [c.key, c]));
  const cards = Object.fromEntries(plan.order.map(({ key, mode }) => {
    const c = byKey.get(key);
    return [key, {
      title: c.title, url: c.url, number: cardNumber(key), milestoneOrder: c.milestoneOrder, description: descriptions.get(key)?.description ?? '',
      origin: 'thin-spike', pr: null, offProject: c.offMapBlockers, mode,
    }];
  }));
  const replay = Object.fromEntries(plan.ancestors.filter(a => a.mode === 'replay').map(a => [a.key, {
    from: a.from, patches: a.patches, dropped: a.dropped, sharedWith: a.sharedWith, units: a.units,
    ...(a.sources ? { sources: a.sources } : {}), replanned: false,
  }]));
  const keysWhere = test => analysis.cards.filter(test).map(c => c.key);
  return {
    fetchedAt: at.toISOString(),
    order: plan.order.map(e => e.key),
    edges: contractedEdges(analysis.edges, new Set(plan.order.map(e => e.key))),
    tracks: plan.tracks,
    skipped: [],
    cards,
    respike: {
      approve: plan.approve,
      previous: { runId: plan.previous.runId },
      selection: {
        mode: plan.selection.mode, cards: plan.selection.cards.map(({ key, why }) => ({ key, why })),
        dropped: plan.selection.dropped.map(({ key, reason }) => ({ key, reason })),
      },
      built: plan.built,
      ancestors: plan.ancestors.map(({ key, mode, reason, sharedWith, spikedAncestors }) => ({ key, mode, reason, sharedWith, ...(spikedAncestors ? { spikedAncestors } : {}) })),
      bases: plan.bases,
      prChecks: plan.prChecks,
      handoffs: plan.handoffs,
      drops: plan.drops,
      moved: plan.moved,
      replay,
      map: { open: keysWhere(c => c.statusType !== 'completed'), completed: keysWhere(c => c.statusType === 'completed') },
    },
  };
}

// The only write is a pull-ref fetch in the checkout, for each PR head a bases-unknown ask is missing.
async function fetchHeads(args, deps) {
  const a = selectionArgs(args, ['--approve']);
  if (!a || (!a.error && !a.flags.approve)) return fail(2, ...USAGE);
  if (a.error) return fail(2, a.error, ...USAGE);
  return withKey(deps, async key => {
    const { plan, config } = await buildRespikePlan(a.ref, key, a.options, deps);
    if (plan.approve !== a.flags.approve) return fail(5, `the plan is not the approved one: its hash is now ${plan.approve ?? 'none'}; run preflight again`);
    const unknown = plan.asks.filter(x => x.code === 'bases-unknown');
    if (!unknown.length) return fail(5, `the plan is ${plan.action} with no bases-unknown ask: there is nothing to fetch`);
    const fetched = [];
    for (const ask of unknown) {
      const repo = config.repos[ask.repoDir];
      for (const card of ask.cards) {
        const b = plan.built.find(x => x.key === card && x.repoDir === ask.repoDir && x.kind === 'pr');
        if (!b) continue;
        const ref = `refs/pull/${b.pr.number}/head`;
        deps.git(['fetch', '-q', repo.remote, ref], { cwd: repo.checkout });
        fetched.push({ repo: ask.repoDir, card, ref });
      }
    }
    const after = await buildRespikePlan(a.ref, key, a.options, deps);
    return ok({ action: 'fetch', fetched, nextApprove: after.plan.approve });
  });
}

// A local branch the default branch already contains is moved to the default tip, on the approved hash. Only a branch
// with no own commits moves, and never a checked-out one with uncommitted work; nothing is pushed.
async function fastForward(args, deps) {
  const a = selectionArgs(args, ['--approve', '--repo']);
  if (!a || (!a.error && (!a.flags.approve || !a.flags.repo))) return fail(2, ...USAGE);
  if (a.error) return fail(2, a.error, ...USAGE);
  return withKey(deps, async key => {
    const { plan, config } = await buildRespikePlan(a.ref, key, a.options, deps);
    if (plan.approve !== a.flags.approve) return fail(5, `the plan is not the approved one: its hash is now ${plan.approve ?? 'none'}; run preflight again`);
    const dir = a.flags.repo;
    const base = plan.bases[dir];
    const repo = config.repos[dir];
    if (!base || !repo) return fail(5, `${dir} has no base in this plan`);
    if (base.kind !== 'local') return fail(5, `${dir}'s base is ${base.kind}, not a local branch: run preflight again with --with-default ${dir} to bring it up to date`);
    if (!(base.behind > 0)) return fail(5, `${dir}'s base ${base.ref} is not behind ${repo.remote}/${repo.defaultBranch}`);
    if (base.ownCommits !== 0) {
      return fail(5, `${dir}'s base ${base.ref} has ${base.ownCommits ?? 'unknown'} own commit(s), so it cannot be fast-forwarded: run preflight again with --with-default ${dir}`);
    }
    const cwd = repo.checkout;
    const to = deps.git(['rev-parse', '--verify', `${repo.remote}/${repo.defaultBranch}^{commit}`], { cwd }).trim();
    const checkedOut = parseWorktrees(deps.git(['worktree', 'list', '--porcelain'], { cwd })).find(w => w.branch === base.ref);
    if (checkedOut) {
      if (deps.git(['status', '--porcelain', '--untracked-files=no'], { cwd: checkedOut.path }).trim()) {
        return fail(5, `${base.ref} is checked out in ${checkedOut.path} with uncommitted changes: commit or stash them, then run fast-forward again`);
      }
      deps.git(['merge', '--ff-only', '-q', to], { cwd: checkedOut.path });
    } else {
      deps.git(['update-ref', `refs/heads/${base.ref}`, to, base.sha], { cwd });
    }
    const after = await buildRespikePlan(a.ref, key, a.options, deps);
    return ok({ action: 'fast-forward', repo: dir, branch: base.ref, from: base.sha, to, checkout: checkedOut?.path ?? null, nextApprove: after.plan.approve });
  });
}

// The hash is checked before anything is written, so a refusal leaves the home as it was.
async function begin(args, deps) {
  const a = selectionArgs(args, ['--approve', ...LIMIT_FLAGS]);
  const limits = a && !a.error && limitsFrom(a.flags);
  if (!a || (!a.error && (!a.flags.approve || !limits))) return fail(2, ...USAGE);
  if (a.error) return fail(2, a.error, ...USAGE);
  return withKey(deps, async key => {
    const built = await buildRespikePlan(a.ref, key, a.options, deps);
    const { plan } = built;
    if (plan.approve !== a.flags.approve) return fail(5, `the plan is not the approved one: its hash is now ${plan.approve ?? 'none'}; run preflight again`);
    if (plan.action !== 'ready') return fail(5, `the plan is ${plan.action}, not ready; run preflight again`);
    const at = deps.now();
    const runId = runIdAt(at);
    const project = { id: built.raw.project.id, slug: plan.project.slug, name: plan.project.name, url: built.raw.project.url };
    const state = createRun({ runId, project, plan: runPlan(built, at), home: deps.home, dataDir: deps.dataDir, now: at });
    Object.assign(state, { workers: limits.workers ?? 3, checks: limits.checks ?? 1 });
    const execution = openExecution(state, { now: at, sessions: sessionsFrom(a.flags, at), ...limits });
    const mark = issueMark(state, execution, at);
    await withLock(runDir(deps.home, project.slug, runId), () => saveState(runDir(deps.home, project.slug, runId), state, at));
    const count = mode => plan.order.filter(e => e.mode === mode).length;
    return ok({
      mark, runId, resumed: false, project: plan.project, plan: { order: state.plan.order, skipped: state.plan.skipped },
      respike: { selected: plan.selection.cards.length, replay: count('replay'), spike: count('spike'), built: plan.built.length },
    });
  });
}

// --out drafts, --draft reviews, and --draft with --approve writes config.json. Every message and report goes out with
// URL credentials masked: the change list and the diff carry the base file's own values.
async function config(args, deps) {
  let result;
  try {
    result = await configStep(args, deps);
  } catch (e) {
    result = fail(e.exitCode ?? 1, e.message);
  }
  return { ...result, stdout: redactUrls(result.stdout), stderr: redactText(result.stderr) };
}

async function configStep(args, deps) {
  const drafting = args.includes('--out');
  if (drafting === args.includes('--draft')) return fail(2, ...USAGE);
  if (drafting) return configDraft(args, deps);
  const a = parseArgs(args, ['--draft', '--approve']);
  if (!a || a.positional.length) return fail(2, ...USAGE);
  return a.flags.approve === undefined ? configReview(a.flags.draft, deps) : configWrite(a.flags.draft, a.flags.approve, deps);
}

// Checked before the key: a draft path that is refused or taken, and each --root, which must be an existing folder.
function draftInputs(a, { home, dataDir, userHome }) {
  const out = assertDraftPath(a.flags.out, { home, dataDir });
  if (existsSync(out)) throw exitError(2, `the draft path ${out} already exists: draft into a new file, so edits made to a draft are never overwritten`);
  const roots = (a.flags.root ?? []).map(root => {
    const path = expandHome(root, userHome);
    if (!isAbsolute(path)) throw exitError(2, `--root ${root} is relative: give an absolute folder, or one starting with ~/`);
    if (!isFolder(path)) throw exitError(2, `--root ${root} is not an existing folder`);
    return resolve(path);
  });
  return { out, roots: [...new Set(roots)] };
}

const isFolder = path => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// A file that is not a JSON object is never drafted from or compared with, so no draft can ever replace it.
const UNREADABLE = { unparseable: read => read.error, 'not-object': () => 'its top level is not a JSON object' };

function baseOf(read, home, doing) {
  if (UNREADABLE[read.state]) throw exitError(2, `cannot ${doing} the spike config ${configPath(home)}: ${UNREADABLE[read.state](read)}; it is never replaced: fix or remove it by hand`);
  return read;
}

const baseReport = read => ({ state: read.state === 'read' ? 'read' : 'missing', issues: (read.issues ?? []).map(i => `${i.at}: ${i.message}`) });

// What the review and the write show of a draft text against the config.json there is now.
function draftReport(read, text, value) {
  const { valid, errors, approve } = draftState(text, read.bytes ?? null);
  return {
    approve, valid, errors, base: baseReport(read), stray: strayKeys(value),
    changes: changesBetween(read.raw ?? null, value), ...diffFromBase(read.text ?? null, text),
  };
}

const NO_ROOTS = 'no checkout roots: ask the user once which folders hold their checkouts and pass each with --root <dir>; the draft stores them as checkoutRoots';

// --root replaces the stored roots for this call; stored ones the config refuses count as none.
function rootsOf(given, read, userHome) {
  if (given.length) return { searched: given, from: 'flag' };
  const stored = read.state === 'read' && !read.issues.some(i => i.field === 'checkoutRoots') ? read.raw.checkoutRoots ?? [] : [];
  return stored.length ? { searched: [...new Set(stored.map(root => resolve(expandHome(root, userHome))))], from: 'config' } : { searched: [], from: null };
}

// The trial patch map tells an old trial dir name from a repo with no entry; with none, every name is a repo.
// One that is there but unusable stops the draft: read as none, its old dirs would be proposed as new repos.
// JSON.parse's own message quotes the text, so the reason given is fixed.
function readPatchMap(trialLogDir) {
  const path = join(trialLogDir, 'backfill', 'patch-map.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw exitError(2, `cannot read the trial patch map ${path}: ${e.code ?? 'unreadable'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw exitError(2, `the trial patch map ${path} is not valid JSON: fix it or move it aside, then draft again`);
  }
}

async function configDraft(args, deps) {
  const a = selectionArgs(args, ['--out'], ['--root']);
  if (!a) return fail(2, ...USAGE);
  if (a.error) return fail(2, a.error, ...USAGE);
  const { out, roots } = draftInputs(a, deps);
  return withKey(deps, async key => {
    const read = baseOf(readRawConfig(deps.home), deps.home, 'draft from');
    const raw = read.state === 'read' ? read.raw : null;
    const planning = planningConfig(raw ?? EMPTY_BASE, { userHome: deps.userHome });
    const { coverage, slug } = await buildRespikePlan(a.ref, key, { ...a.options, config: planning, coverageOnly: true }, deps);
    const { missingConfig } = coverage;
    const unmapped = missingConfig.filter(g => g.code === 'trial-dir-unmapped');
    const refDir = deps.trialLogDir ?? trialReferenceDir(deps.home, slug);
    const patchMap = readPatchMap(refDir);
    if (!patchMap && deps.trialLogDir === undefined && unmapped.length && existsSync(trialPatchRoot(deps.home, slug))) {
      throw exitError(2, `no trial patch map at ${join(refDir, 'backfill', 'patch-map.json')} to tell old trial folders from new repos: move the trial reference there with scripts/maintenance/move-reference.mjs, then draft again`);
    }
    const facts = Object.fromEntries(unmapped.map(g => [g.repo, { oldTrial: oldTrialDir(patchMap, slug, g.repo) }]));
    const targets = searchTargets({ raw, planning, missingConfig, facts });
    const searched = rootsOf(roots, read, deps.userHome);
    if (targets.length && !searched.searched.length) return fail(2, NO_ROOTS, ...missingConfig.map(gapLine));
    const scan = scanRoots(deps.git, searched.searched);
    const repos = [...missingConfig.map(g => g.repo), ...(read.issues ?? []).map(i => i.repo).filter(dir => dir !== null)];
    const probe = toolProber(deps.runSetup, { cwd: deps.tmpRoot });
    const { merged, items, fixes, stray, needs } = buildDraft({
      raw, planning, missingConfig, slug, facts: draftFacts(deps.git, probe, { scan, targets, repos, planning, facts }), roots: searched,
      riskTemplate: readRiskTemplate(deps.riskTemplate), userHome: deps.userHome,
    });
    const report = { base: baseReport(read), roots: { ...searched, missing: scan.missingRoots }, items, fixes, stray, warnings: coverage.warnings, needs };
    if (merged === null) return ok({ action: 'config-draft', draft: null, approve: null, message: 'nothing to draft', ...report });
    const text = `${JSON.stringify(merged, null, 2)}\n`;
    writeFileSync(out, text, { flag: 'wx' });
    const { approve, valid, errors, changes, diff, reformat } = draftReport(read, text, merged);
    return ok({ action: 'config-draft', draft: out, approve, valid, errors, ...report, changes, diff, reformat });
  });
}

// Review and write read the draft only from a scratch file: never from the home, the data dir or a repo.
function readDraft(path, { home, dataDir }) {
  const draft = assertDraftPath(path, { home, dataDir });
  try {
    return { draft, text: readFileSync(draft, 'utf8') };
  } catch (e) {
    throw exitError(2, `cannot read the draft ${draft}: ${e.code ?? 'unreadable'}`);
  }
}

function draftValue(draft, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw exitError(2, `the draft ${draft} is not valid JSON: fix it, then review it again`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw exitError(2, `the draft ${draft} is not a JSON object: fix it, then review it again`);
  return value;
}

// The hash is over the draft as it is now and config.json as it is now, so an edit to either shows as a new hash.
function configReview(path, deps) {
  const { draft, text } = readDraft(path, deps);
  const value = draftValue(draft, text);
  const read = baseOf(readRawConfig(deps.home), deps.home, 'review a draft against');
  const { approve, valid, errors, base, stray, changes, diff, reformat } = draftReport(read, text, value);
  return ok({ action: 'config-review', draft, approve, valid, errors, base, stray, changes, diff, reformat });
}

// Every check runs before writeConfig, so a refused write touches neither config.json nor its backup.
function configWrite(path, approve, deps) {
  const { draft, text } = readDraft(path, deps);
  const bytes = readConfigBytes(deps.home);
  if (draftHash(bytes, text) !== approve) return fail(5, 'the draft or config.json changed since its hash was shown; review again');
  baseOf(rawConfigOf(bytes), deps.home, 'replace');
  const { valid, errors } = draftState(text, bytes);
  if (!valid) return fail(2, `the draft ${draft} is not a config that can be written: ${errors.join('; ')}`);
  return ok({ action: 'config-written', ...writeConfig(deps.home, text, bytes), approve });
}

const subdirs = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []);

const isProject = (project, ref) => [project.slug, project.id, project.name].includes(parseProjectRef(ref)?.ref ?? ref);

function respikeRun(home, ref, runId) {
  const found = [];
  for (const slug of subdirs(home)) {
    for (const id of subdirs(join(home, slug, 'runs')).filter(n => RUN_ID.test(n) && (!runId || n === runId))) {
      const dir = runDir(home, slug, id);
      if (!existsSync(join(dir, 'run.json'))) continue;
      const state = readState(dir);
      if (state.plan.respike && isProject(state.project, ref)) found.push(state);
    }
  }
  if (!found.length) throw exitError(1, `no respike run for ${ref}${runId ? ` with id ${runId}` : ''}`);
  return found.sort((a, b) => (a.runId < b.runId ? -1 : 1)).at(-1);
}

async function report(args, { home, dataDir }) {
  const a = parseArgs(args, ['--run']);
  if (!a || a.positional.length !== 1 || (a.flags.run !== undefined && !RUN_ID.test(a.flags.run))) return fail(2, ...USAGE);
  const state = respikeRun(home, a.positional[0], a.flags.run);
  const { slug } = state.project;
  const value = buildReport({
    state, records: readRecords(join(dataDir, slug)).records, previous: previousRecords(dataDir, state), audit: readInputs(home, slug, state.runId),
  });
  const diffText = findDiffText(value, 'report', 'a record field holds a diff');
  if (diffText.length) return fail(1, ...diffText);
  const name = `respike-${state.runId}.json`;
  writeAtomic(join(dataDir, slug, 'spike', name), `${JSON.stringify(value, null, 2)}\n`);
  return ok({ action: 'report', path: `${displayData(dataDir, slug)}/spike/${name}`, ...value });
}

// Without --verdicts it gathers what the audit needs and writes no record; with --verdicts it stores the skill's verdicts in the
// records, offline. Both work on a complete respike run only, since the fresh records are what the other cards are checked against.
async function audit(args, deps) {
  if (args.includes('--before')) return auditBefore(args, deps);
  const a = parseArgs(args, ['--run', '--verdicts']);
  if (!a || a.positional.length !== 1 || (a.flags.run !== undefined && !RUN_ID.test(a.flags.run))) return fail(2, ...USAGE);
  const state = respikeRun(deps.home, a.positional[0], a.flags.run);
  if (state.status !== 'complete') return fail(5, `run ${state.runId} is ${state.status}: audit it once it completes`);
  return a.flags.verdicts === undefined ? auditGather(state, deps) : auditStore(state, a.flags.verdicts, deps);
}

async function auditGather(state, deps) {
  const { slug } = state.project;
  return withKey(deps, async key => {
    const descriptions = await fetchDescriptions(state.project.id, key, { fetchImpl: deps.fetchImpl });
    const inputs = gatherAudit({ state, records: readRecords(join(deps.dataDir, slug)).records, descriptions, now: deps.now() });
    writeAtomic(inputsPath(deps.home, slug, state.runId), `${JSON.stringify(inputs, null, 2)}\n`);
    return ok({ action: 'audit-gathered', path: inputsPath(deps.home, slug, state.runId), ...inputs });
  });
}

function readVerdicts(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw exitError(2, `cannot read the verdicts ${path}: ${e instanceof SyntaxError ? 'not valid JSON' : e.code ?? e.message}`);
  }
}

// Every check runs before the first record is written, so a refusal leaves every record as it was.
function auditStore(state, path, { home, dataDir, now }) {
  const { slug } = state.project;
  const inputs = readInputs(home, slug, state.runId);
  if (!inputs) return fail(5, `no audit inputs for run ${state.runId}: gather the audit first`);
  const value = readVerdicts(path);
  const { open = [], completed = [] } = state.plan.respike.map ?? {};
  const errors = validateVerdicts(value, inputs, { onMap: new Set([...open, ...completed]) });
  if (errors.length) return fail(2, ...errors);
  const live = new Map(readRecords(join(dataDir, slug)).records.filter(r => !r.archived && !r.supersededBy).map(r => [r.card, r]));
  const at = now().toISOString();
  const marked = [];
  for (const [card, verdicts] of Object.entries(value.cards)) {
    const gathered = inputs.cards.find(c => c.card === card);
    const record = live.get(card);
    if (!record || record.spikedAt !== gathered.record.spikedAt) return fail(5, `${card}'s record changed since the gather: gather the audit again`);
    marked.push(markRecord(record, gathered, verdicts, { runId: state.runId, at }));
  }
  for (const r of marked) writeAtomic(join(dataDir, slug, `${r.card}.json`), serializeRecord(r));
  const cards = marked.map(r => ({ card: r.card, ...verdictSummary(r.audits.find(x => x.check === 'fresh' && x.runId === state.runId)) }))
    .sort((x, y) => cardNumber(x.card) - cardNumber(y.card));
  return ok({ action: 'audit-stored', runId: state.runId, cards });
}

// The PR check, before a run: without --verdicts it reads the plan the selection flags make and gathers each built card whose
// record is unchecked or stale, with its diff; with --verdicts it stores the skill's holds, moved and not-built verdicts, offline.
async function auditBefore(args, deps) {
  if (args.includes('--verdicts')) {
    const a = parseArgs(args.filter(x => x !== '--before'), ['--verdicts']);
    if (!a || a.positional.length !== 1) return fail(2, ...USAGE);
    return prCheckStore(a.positional[0], a.flags.verdicts, deps);
  }
  const a = selectionArgs(args);
  if (!a) return fail(2, ...USAGE);
  if (a.error) return fail(2, a.error, ...USAGE);
  return withKey(deps, async key => {
    const { plan, analysis, raw, descriptions, config } = await buildRespikePlan(a.ref, key, { ...a.options, answers: { ...a.options.answers, hand: new Map(), drop: new Set() } }, deps);
    const { slug } = plan.project;
    const dir = join(deps.home, slug, 'audit');
    const inputs = gatherPrCheck({
      project: { id: raw.project.id, slug, name: plan.project.name }, plan, map: analysis.cards.map(c => c.key), descriptions, gh: deps.gh, git: deps.git, config, now: deps.now(),
      records: new Map(readRecords(join(deps.dataDir, slug)).records.filter(r => !r.archived && !r.supersededBy).map(r => [r.card, r])),
      writeDiff: (card, repoDir, text) => {
        const path = join(dir, `${card}.${repoDir}.diff`);
        writeAtomic(path, text);
        return path;
      },
    });
    writeAtomic(join(dir, 'before.json'), `${JSON.stringify(inputs, null, 2)}\n`);
    return ok({ action: 'audit-before-gathered', path: join(dir, 'before.json'), ...inputs });
  });
}

function prCheckInputs(home, ref) {
  for (const slug of subdirs(home)) {
    const path = join(home, slug, 'audit', 'before.json');
    if (!existsSync(path)) continue;
    const inputs = JSON.parse(readFileSync(path, 'utf8'));
    if (isProject(inputs.project, ref)) return inputs;
  }
  return null;
}

function prCheckStore(ref, path, { home, dataDir, now }) {
  const inputs = prCheckInputs(home, ref);
  if (!inputs) return fail(5, `no PR check gathered for ${ref}: run audit --before first`);
  const value = readVerdicts(path);
  const errors = validatePrVerdicts(value, inputs);
  if (errors.length) return fail(2, ...errors);
  const { slug } = inputs.project;
  const live = new Map(readRecords(join(dataDir, slug)).records.filter(r => !r.archived && !r.supersededBy).map(r => [r.card, r]));
  const at = now().toISOString();
  const marked = [];
  for (const [card, verdicts] of Object.entries(value.cards)) {
    const gathered = inputs.cards.find(c => c.card === card);
    const record = live.get(card);
    if (!record || record.spikedAt !== gathered.record.spikedAt) return fail(5, `${card}'s record changed since the gather: run audit --before again`);
    marked.push(markPrCheck(record, gathered, verdicts, { at }));
  }
  for (const r of marked) writeAtomic(join(dataDir, slug, `${r.card}.json`), serializeRecord(r));
  const cards = marked.map(r => ({ card: r.card, ...verdictSummary(r.audits.filter(x => x.check === 'pr').at(-1)) }))
    .sort((x, y) => cardNumber(x.card) - cardNumber(y.card));
  return ok({ action: 'audit-before-stored', cards });
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
