#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isEntry, lines, ok, parseArgs, redacted } from './lib/cli.mjs';
import { applyCyclePlan } from './lib/cycle/apply.mjs';
import { readBuilt } from './lib/cycle/built.mjs';
import { computeCyclePlan, renderCycleReview } from './lib/cycle/plan.mjs';
import { anchors, TIERS } from './lib/cycle/size.mjs';
import { approvalError } from './lib/harvest.mjs';
import {
  fetchCycleContext, fetchDescriptions, fetchProject, fetchProjectMap, parseProjectRef, readLinearKey, redact,
} from './lib/linear-fetch.mjs';
import { readRecords } from './lib/records.mjs';
import { loadConfig } from './lib/spike/config.mjs';
import { ghRunner, gitRunner } from './lib/spike/exec.mjs';
import { dataDirFor, sequencerHome } from './lib/spike/home.mjs';

const SCRIPT = fileURLToPath(import.meta.url);

const USAGE = [
  'usage: node scripts/cycle.mjs needs <project ref> [--team KEY]',
  'usage: node scripts/cycle.mjs [plan] <project ref> [--team KEY] [--availability "<name>=<percent>"]... [--guess <CARD>=<S|M|L|XL>]... [--focus <milestone number or name>]...',
  'usage: node scripts/cycle.mjs apply <project ref> --plan <plan.json> --approve <hash> [--with-stretch] [--drop <CARD>]... [--team KEY]',
];

const PLAN_FLAGS = [['--team'], ['--availability', '--guess', '--focus']];
const failure = e => (/^Linear\b/.test(e.message) ? e.message : `internal error: ${e.message}`);
const tilde = path => (path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path);
const usage = (...why) => fail(2, ...why, ...USAGE);
const projectRef = a => (a && a.positional.length === 1 ? parseProjectRef(a.positional[0]) : null);
const filesOf = (dataDir, slug) => {
  const dir = join(dataDir, slug, 'cycle');
  return { dir, plan: join(dir, 'plan.json'), review: join(dir, 'plan.md'), log: join(dir, 'applied.jsonl') };
};

class Usage extends Error {}

const COMMANDS = { needs, plan, apply };

export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), dataDir = dataDirFor(env), home = sequencerHome(env),
  gh = ghRunner(), git = gitRunner(), listDir,
} = {}) {
  const deps = { env, fetchImpl, keyFile, now, dataDir, home, gh, git, listDir };
  const [command, ...rest] = argv;
  try {
    return await (Object.hasOwn(COMMANDS, command) ? COMMANDS[command](rest, deps) : plan(argv, deps));
  } catch (e) {
    if (e instanceof Usage) return usage(e.message);
    return redacted(fail(1, failure(e)), readLinearKey(env, keyFile).key);
  }
}

function pickTeam(teams, wanted) {
  if (wanted) {
    const team = teams.find(t => t.key.toLowerCase() === wanted.toLowerCase());
    if (!team) throw new Usage(`team ${wanted} is not on the project (teams: ${teams.map(t => t.key).join(', ') || 'none'})`);
    return team;
  }
  if (teams.length === 1) return teams[0];
  throw new Usage(teams.length ? `the project has several teams (${teams.map(t => t.key).join(', ')}): pass --team KEY` : 'the project has no team');
}

async function read(parsed, key, { fetchImpl, now, team: wanted }) {
  const raw = await fetchProjectMap(parsed.ref, key, { fetchImpl });
  const team = pickTeam(raw.project.teams ?? [], wanted);
  const context = await fetchCycleContext(raw.project.id, team.id, key, { fetchImpl, now: now() });
  return { raw, team, context };
}

function parseAvailability(values, members) {
  const out = {};
  for (const v of values ?? []) {
    const m = String(v).match(/^(.+?)\s*=\s*(\d{1,3})%?$/);
    if (!m || Number(m[2]) > 100) throw new Usage(`--availability takes "<name>=<0..100>", got ${JSON.stringify(v)}`);
    const name = m[1].trim().toLowerCase();
    const member = members.find(x => x.name?.toLowerCase() === name || x.displayName?.toLowerCase() === name);
    if (!member) throw new Usage(`no project member named ${JSON.stringify(m[1].trim())} (members: ${members.map(x => x.name).join(', ')})`);
    out[member.id] = Number(m[2]);
  }
  return out;
}

function parseGuesses(values) {
  const out = {};
  for (const v of values ?? []) {
    const m = String(v).match(/^([A-Z]+-\d+)=(S|M|L|XL)$/);
    if (!m) throw new Usage(`--guess takes <CARD>=<${TIERS.join('|')}>, got ${JSON.stringify(v)}`);
    out[m[1]] = m[2];
  }
  return out;
}

// A milestone is named by its number ("6" matches "6. Los logs ...") or its whole name, ignoring case.
function parseFocus(values, milestones) {
  return [...new Set((values ?? []).map(v => {
    const wanted = String(v).trim().toLowerCase();
    const named = milestones.filter(m => {
      const name = String(m.name ?? '').toLowerCase();
      return name === wanted || (/^\d+$/.test(wanted) && new RegExp(`^${wanted}[.)\\s]`).test(name));
    });
    if (named.length !== 1) {
      const why = named.length ? `matches ${named.length} milestones` : 'matches no milestone';
      throw new Usage(`--focus ${JSON.stringify(v)} ${why} (milestones: ${milestones.map(m => JSON.stringify(m.name)).join(', ') || 'none'})`);
    }
    return named[0].name;
  }))];
}

async function prepare(args, { env, keyFile, fetchImpl, now, dataDir }) {
  const a = parseArgs(args, ...PLAN_FLAGS);
  const parsed = projectRef(a);
  if (!parsed) throw new Usage('expected one project ref');
  const guesses = parseGuesses(a.flags.guess);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return { early: fail(3, reason) };
  const live = await read(parsed, key, { fetchImpl, now, team: a.flags.team });
  const availability = parseAvailability(a.flags.availability, live.context.members);
  const focus = parseFocus(a.flags.focus, live.raw.milestones ?? []);
  const { records } = readRecords(join(dataDir, live.raw.project.slug));
  return { parsed, key, live, records, guesses, availability, focus };
}

// Without a spike config there are no repos to read, so the plan falls back to Linear states and says so.
function buildState(raw, team, { home, gh, git, listDir }) {
  let config;
  try {
    config = loadConfig(home);
  } catch (e) {
    return { built: new Map(), warnings: [`build state not read: ${e.message}`] };
  }
  return readBuilt({ raw, team, config, gh, git, listDir });
}

async function needs(args, deps) {
  const p = await prepare(args, deps);
  if (p.early) return p.early;
  const { raw, team, context } = p.live;
  const r = computeCyclePlan({ raw, context, team, records: p.records, now: deps.now() });
  if (!r.plan) return redacted(fail(4, ...r.refusals), p.key);
  const descriptions = await fetchDescriptions(raw.project.id, p.key, { fetchImpl: deps.fetchImpl });
  const list = r.needs.map(n => ({ ...n, description: descriptions.get(n.key)?.description ?? '' }));
  const members = r.members.map(m => ({ name: m.name, displayName: m.displayName }));
  return redacted(ok({ project: raw.project.slug, members, needs: list, anchors: anchors(p.records) }), p.key);
}

async function plan(args, deps) {
  const p = await prepare(args, deps);
  if (p.early) return p.early;
  const { raw, team, context } = p.live;
  const files = filesOf(deps.dataDir, raw.project.slug);
  const { built, warnings } = buildState(raw, team, deps);
  const r = computeCyclePlan({ raw, context, team, records: p.records, guesses: p.guesses, availability: p.availability, built, buildWarnings: warnings, focus: p.focus, now: deps.now() });
  if (!r.plan) {
    rmSync(files.plan, { force: true });
    rmSync(files.review, { force: true });
    const out = { status: 'refused', plan: null, review: null, hash: null, counts: null, refusals: r.refusals };
    return redacted({ code: 4, stdout: `${JSON.stringify(out)}\n`, stderr: lines(r.refusals) }, p.key);
  }
  const approveCommand = `node ${tilde(SCRIPT)} apply ${p.parsed.ref} --plan ${files.plan} --approve ${r.plan.hash.slice(0, 12)}`;
  mkdirSync(files.dir, { recursive: true });
  writeFileSync(files.plan, `${JSON.stringify(r.plan, null, 2)}\n`);
  writeFileSync(files.review, renderCycleReview(r.plan, { approveCommand }));
  const out = ok({ status: 'written', plan: files.plan, review: files.review, hash: r.plan.hash, counts: r.plan.counts });
  return redacted({ ...out, stderr: lines(warnings.map(w => `warning: ${w}`)) }, p.key);
}

async function otherProject(parsed, planned, key, fetchImpl) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (parsed.kind === 'uuid') return same(parsed.ref, planned.id) ? null : 'another project';
  if (parsed.kind !== 'identifier') return same(parsed.ref, planned.slug) ? null : 'another project';
  const project = await fetchProject(parsed.ref, key, { fetchImpl });
  return project.id === planned.id ? null : `${project.name} (${project.slugId})`;
}

async function apply(args, { env, fetchImpl, keyFile, now, dataDir }) {
  // --team is accepted and unused: the plan already names its team, and the skill passes --team on every command.
  const withStretch = args.includes('--with-stretch');
  const a = parseArgs(args.filter(x => x !== '--with-stretch'), ['--plan', '--approve', '--team'], ['--drop']);
  const parsed = projectRef(a);
  if (!parsed) return usage('expected one project ref');
  if (!a.flags.plan || !a.flags.approve) return fail(5, 'apply needs --plan <plan.json> and --approve <hash> from the reviewed plan');
  let p;
  try {
    p = JSON.parse(readFileSync(a.flags.plan, 'utf8'));
  } catch (e) {
    return fail(5, `cannot read the plan ${tilde(a.flags.plan)}: ${e.message}`);
  }
  const refused = approvalError(p, a.flags.approve);
  if (refused) return fail(5, refused);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  const other = await otherProject(parsed, p.project, key, fetchImpl);
  if (other) return redacted(fail(5, `the plan is for project ${p.project.name} (${p.project.slug}), but ${parsed.ref} is ${other}`), key);
  const raw = await fetchProjectMap(p.project.id, key, { fetchImpl });
  const context = await fetchCycleContext(p.project.id, p.team.id, key, { fetchImpl, now: now() });
  const files = filesOf(dataDir, p.project.slug);
  const appendLog = line => {
    mkdirSync(files.dir, { recursive: true });
    appendFileSync(files.log, `${redact(JSON.stringify(line), key)}\n`);
  };
  const r = await applyCyclePlan(p, { apiKey: key, fetchImpl, now, appendLog, live: { raw, context }, withStretch, drop: a.flags.drop ?? [] });
  if (r.code) return redacted(fail(r.code, ...r.messages), key);
  return redacted(ok({ status: 'applied', results: r.results }), key);
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
