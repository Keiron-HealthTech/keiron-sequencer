#!/usr/bin/env node
import { fail, isEntry, ok, parseArgs, redacted } from './lib/cli.mjs';
import { readLinearKey } from './lib/linear-fetch.mjs';
import { REPO_DATA_DIR } from './lib/records.mjs';
import { ghRunner, gitRunner, setupRunner } from './lib/spike/exec.mjs';
import { loadConfig } from './lib/spike/config.mjs';
import { dataDirFor, sequencerHome } from './lib/spike/home.mjs';
import { runBaseline } from './lib/start/baseline.mjs';
import { createBranch, fetchRemote, resumeBranch } from './lib/start/branch.mjs';
import { parsePullUrl } from './lib/start/checkout.mjs';
import { startSettings } from './lib/start/config.mjs';
import { recordStart } from './lib/start/started.mjs';
import { moveToInProgress } from './lib/start/move.mjs';
import { approvedPlan, buildPlan } from './lib/start/plan.mjs';

const BLOCKER_USAGE = '[--blocker <CARD>]... [--blocker-pr <CARD>=<PR url>]... [--blocker-branch <CARD>=<branch>]... [--skip-blocker <CARD>]...';

const USAGE = [
  `usage: node scripts/start.mjs plan <CARD> ${BLOCKER_USAGE}`,
  `usage: node scripts/start.mjs fetch <CARD> --approve <hash> ${BLOCKER_USAGE}`,
  `usage: node scripts/start.mjs branch <CARD> --approve <hash> [--name <branch>] [--resume <branch>] [--accept <reason>]... ${BLOCKER_USAGE}`,
  `usage: node scripts/start.mjs baseline <CARD> --approve <hash> ${BLOCKER_USAGE}`,
  'usage: node scripts/start.mjs move <CARD> --confirm <CARD>',
];

const CARD_KEY = /^[A-Z]+-\d+$/;

const BLOCKER_FLAGS = ['--blocker', '--blocker-pr', '--blocker-branch', '--skip-blocker'];

function keyed(flag, value, check) {
  const at = value.indexOf('=');
  const card = at === -1 ? '' : value.slice(0, at);
  const rest = at === -1 ? '' : value.slice(at + 1);
  if (!CARD_KEY.test(card) || !check(rest)) throw new Error(`${flag} expects <CARD>=${flag === '--blocker-pr' ? '<PR url>' : '<branch>'}, got "${value}"`);
  return [card, rest];
}

function cardFlag(flag, value) {
  if (!CARD_KEY.test(value)) throw new Error(`${flag} expects a card key such as ABC-12, got "${value}"`);
  return value;
}

// Shared by every subcommand that recomputes the plan, so the same flags give the same plan.
function parseBlockerFlags(flags) {
  const list = name => flags[name] ?? [];
  return {
    blockers: list('blocker').map(v => cardFlag('--blocker', v)),
    blockerPrs: list('blocker-pr').map(v => keyed('--blocker-pr', v, url => Boolean(parsePullUrl(url)))).map(([key, url]) => ({ key, url })),
    blockerBranches: list('blocker-branch').map(v => keyed('--blocker-branch', v, b => b.length > 0)).map(([key, branch]) => ({ key, branch })),
    skip: list('skip-blocker').map(v => cardFlag('--skip-blocker', v)),
  };
}

// `fetch` must not name a handler here: it is the default Linear client below.
const COMMANDS = { plan, fetch: fetchCommand, branch: branchCommand, baseline: baselineCommand, move };

export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), home, dataDir, repoDataDir, cwd = process.cwd(),
  git = gitRunner(), gh = ghRunner(), runSetup = setupRunner(),
} = {}) {
  const deps = { env, fetchImpl, keyFile, now, home: home ?? sequencerHome(env), dataDir: dataDir ?? home ?? dataDirFor(env), repoDataDir: repoDataDir ?? (dataDir === undefined && home === undefined ? REPO_DATA_DIR : null), cwd, git, gh, runSetup };
  const [command, ...rest] = CARD_KEY.test(argv[0] ?? '') ? ['plan', ...argv] : argv;
  if (!Object.hasOwn(COMMANDS, command)) return fail(2, ...USAGE);
  return COMMANDS[command](rest, deps);
}

function parseCommand(args, { single = [], many = [], usable = () => true } = {}) {
  const a = parseArgs(args, single, [...BLOCKER_FLAGS, ...many]);
  if (a?.positional.length !== 1 || !CARD_KEY.test(a.positional[0]) || !usable(a.flags)) return { failed: fail(2, ...USAGE) };
  try {
    return { card: a.positional[0], given: a.flags, flags: parseBlockerFlags(a.flags) };
  } catch (e) {
    return { failed: fail(2, e.message, ...USAGE) };
  }
}

async function plan(args, deps) {
  const c = parseCommand(args);
  if (c.failed) return c.failed;
  const { key, reason } = readLinearKey(deps.env, deps.keyFile);
  if (!key) return fail(3, reason);
  try {
    return redacted(ok(await buildPlan(c.card, { ...deps, key, flags: c.flags })), key);
  } catch (e) {
    return redacted(fail(e.exitCode ?? 1, e.message), key);
  }
}

// Recomputes the plan with the same flags and acts only when its hash is the one the user approved.
async function gated(args, deps, act, { single = [], many = [], usable = () => true } = {}) {
  const c = parseCommand(args, { single: ['--approve', ...single], many, usable: f => Boolean(f.approve) && usable(f) });
  if (c.failed) return c.failed;
  const { key, reason } = readLinearKey(deps.env, deps.keyFile);
  if (!key) return fail(3, reason);
  const planDeps = { ...deps, key, flags: c.flags };
  try {
    const approved = await approvedPlan(c.card, c.given.approve, planDeps);
    if (approved.refused) return redacted(fail(5, approved.refused), key);
    const done = await act(approved.plan, planDeps, c.given);
    if (done.refused) return redacted(fail(5, done.refused), key);
    return redacted(ok(done), key);
  } catch (e) {
    return redacted(fail(e.exitCode ?? 1, e.message), key);
  }
}

const recomputed = (approved, planDeps) => buildPlan(approved.card.key, planDeps);

function fetchCommand(args, deps) {
  return gated(args, deps, async (approved, planDeps) => {
    const done = fetchRemote(deps.git, approved, { cwd: deps.cwd });
    if (done.refused) return done;
    return { ...done, nextApprove: (await recomputed(approved, planDeps)).approve };
  });
}

// The status line reads this file, not the command text, so it lights however start was invoked. The branch is made
// either way: a file that cannot be written only leaves the line off.
function noteStart(deps, approved, done) {
  if (!approved.checkout?.path || !done.branch) return;
  try {
    recordStart(deps.home, { plan: approved, branch: done.branch, action: done.action, checkoutPath: approved.checkout.path, dataDir: deps.dataDir, at: deps.now().toISOString() });
  } catch {
    // Nothing to report: the line is a convenience.
  }
}

function branchCommand(args, deps) {
  return gated(args, deps, async (approved, planDeps, flags) => {
    const done = flags.resume === undefined
      ? createBranch(deps.git, approved, { cwd: deps.cwd, name: flags.name, accept: flags.accept ?? [] })
      : resumeBranch(deps.git, approved, flags.resume, { cwd: deps.cwd });
    if (done.refused) return done;
    noteStart(deps, approved, done);
    const after = await recomputed(approved, planDeps);
    return { ...done, head: after.checkout.head, nextApprove: after.approve };
  }, { single: ['--name', '--resume'], many: ['--accept'], usable: f => f.resume === undefined || (f.name === undefined && !f.accept) });
}

function baselineCommand(args, deps) {
  return gated(args, deps, async approved => {
    const { repoDir, path } = approved.checkout;
    const settings = repoDir ? startSettings(loadConfig(deps.home), repoDir).settings : null;
    return runBaseline(deps.runSetup, { repoDir, settings, cwd: path, home: deps.home, now: deps.now });
  });
}

async function move(args, deps) {
  const a = parseArgs(args, ['--confirm']);
  if (a?.positional.length !== 1 || !CARD_KEY.test(a.positional[0]) || a.flags.confirm === undefined) return fail(2, ...USAGE);
  const card = a.positional[0];
  if (a.flags.confirm !== card) return fail(5, `--confirm ${a.flags.confirm} does not repeat the card ${card}; nothing was moved`);
  const { key, reason } = readLinearKey(deps.env, deps.keyFile);
  if (!key) return fail(3, reason);
  try {
    const done = await moveToInProgress(card, { key, fetchImpl: deps.fetchImpl });
    return redacted(done.refused ? fail(5, done.refused) : ok(done), key);
  } catch (e) {
    return redacted(fail(e.exitCode ?? 1, e.message), key);
  }
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
