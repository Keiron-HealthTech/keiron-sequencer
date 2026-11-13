#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isEntry, lines, ok, parseArgs, redacted } from './lib/cli.mjs';
import { applyCyclePlan } from './lib/cycle/apply.mjs';
import { computeCyclePlan, renderCycleReview } from './lib/cycle/plan.mjs';
import { anchors, TIERS } from './lib/cycle/size.mjs';
import { approvalError } from './lib/harvest.mjs';
import {
  fetchCycleContext, fetchDescriptions, fetchProject, fetchProjectMap, parseProjectRef, readLinearKey, redact,
} from './lib/linear-fetch.mjs';
import { readRecords } from './lib/records.mjs';
import { dataDirFor } from './lib/spike/home.mjs';

const SCRIPT = fileURLToPath(import.meta.url);

const USAGE = [
  'usage: node scripts/cycle.mjs needs <project ref> [--team KEY]',
  'usage: node scripts/cycle.mjs [plan] <project ref> [--team KEY] [--availability "<name>=<percent>"]... [--guess <CARD>=<S|M|L|XL>]...',
  'usage: node scripts/cycle.mjs apply <project ref> --plan <plan.json> --approve <hash> [--team KEY]',
];

const PLAN_FLAGS = [['--team'], ['--availability', '--guess']];
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

export async function run(argv, { env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), dataDir = dataDirFor(env) } = {}) {
  const deps = { env, fetchImpl, keyFile, now, dataDir };
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

async function prepare(args, { env, keyFile, fetchImpl, now, dataDir }) {
  const a = parseArgs(args, ...PLAN_FLAGS);
  const parsed = projectRef(a);
  if (!parsed) throw new Usage('expected one project ref');
  const guesses = parseGuesses(a.flags.guess);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return { early: fail(3, reason) };
  const live = await read(parsed, key, { fetchImpl, now, team: a.flags.team });
  const availability = parseAvailability(a.flags.availability, live.context.members);
  const { records } = readRecords(join(dataDir, live.raw.project.slug));
  return { parsed, key, live, records, guesses, availability };
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
  const r = computeCyclePlan({ raw, context, team, records: p.records, guesses: p.guesses, availability: p.availability, now: deps.now() });
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
  return redacted(ok({ status: 'written', plan: files.plan, review: files.review, hash: r.plan.hash, counts: r.plan.counts }), p.key);
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
  const a = parseArgs(args, ['--plan', '--approve', '--team']);
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
  const r = await applyCyclePlan(p, { apiKey: key, fetchImpl, now, appendLog, live: { raw, context } });
  if (r.code) return redacted(fail(r.code, ...r.messages), key);
  return redacted(ok({ status: 'applied', results: r.results }), key);
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
