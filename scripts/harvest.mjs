#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isEntry, lines, ok, parseArgs, redacted } from './lib/cli.mjs';
import { applyPlan, issueOrNull, undoRun } from './lib/harvest-apply.mjs';
import {
  approvalError, computePlan, draftFromRecords, itemsToTranslate, renderReview, validateHarvest, validateNotes,
} from './lib/harvest.mjs';
import {
  fetchDescriptions, fetchProject, fetchProjectMap, parseProjectRef, readLinearKey, redact,
} from './lib/linear-fetch.mjs';
import { readRecords } from './lib/records.mjs';
import { dataDirFor } from './lib/spike/home.mjs';

const SCRIPT = fileURLToPath(import.meta.url);

const USAGE = [
  'usage: node scripts/harvest.mjs draft <slug>',
  'usage: node scripts/harvest.mjs cases <slug>',
  'usage: node scripts/harvest.mjs [plan] <project ref>',
  'usage: node scripts/harvest.mjs apply <project ref> --plan <plan.json> --approve <hash>',
  'usage: node scripts/harvest.mjs undo <project ref> --run <run id> [--approve <run id>]',
];

const SLUG = /^[0-9a-f]{12}$/i;
const CARD_KEY = /^[A-Z]+-\d+$/;

const failure = e => (/^Linear\b/.test(e.message) ? e.message : `internal error: ${e.message}`);

const tilde = path => (path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path);

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

const projectRef = a => (a && a.positional.length === 1 ? parseProjectRef(a.positional[0]) : null);

const slugArg = args => {
  const a = parseArgs(args);
  return a?.positional.length === 1 && SLUG.test(a.positional[0]) ? a.positional[0].toLowerCase() : null;
};

const COMMANDS = { draft, cases, plan, apply, undo };

export async function run(argv, { env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), dataDir = dataDirFor(env) } = {}) {
  const deps = { env, fetchImpl, keyFile, now, dataDir };
  const [command, ...rest] = argv;
  try {
    return await (Object.hasOwn(COMMANDS, command) ? COMMANDS[command](rest, deps) : plan(argv, deps));
  } catch (e) {
    return redacted(fail(1, failure(e)), readLinearKey(env, keyFile).key);
  }
}

function readInputs(dir, { harvestRequired = true } = {}) {
  const errors = [];
  const read = (file, validate, required) => {
    const path = join(dir, file);
    if (!required && !existsSync(path)) return null;
    let value;
    try {
      value = readJson(path);
    } catch (e) {
      errors.push(`cannot read ${tilde(path)}: ${e.message}`);
      return null;
    }
    errors.push(...validate(value).map(m => `${file}: ${m}`));
    return value;
  };
  return { harvest: read('harvest.json', validateHarvest, harvestRequired), notes: read('notes.es.json', validateNotes, false), errors };
}

function draft(args, { dataDir }) {
  const slug = slugArg(args);
  if (!slug) return fail(2, ...USAGE);
  const { harvest, errors } = readInputs(join(dataDir, slug, 'harvest'), { harvestRequired: false });
  if (errors.length) return fail(4, ...errors);
  return ok(draftFromRecords(readRecords(join(dataDir, slug)).records, harvest));
}

function cases(args, { dataDir }) {
  const slug = slugArg(args);
  if (!slug) return fail(2, ...USAGE);
  const { harvest, notes, errors } = readInputs(join(dataDir, slug, 'harvest'));
  if (errors.length) return fail(4, ...errors);
  const list = itemsToTranslate(readRecords(join(dataDir, slug)).records, notes, harvest.notes ?? []);
  const of = kind => list.filter(i => i.kind === kind).map(({ kind: _, ...i }) => i);
  return ok({ slug, count: list.length, cases: of('case'), decisions: of('decision'), openDecisions: of('openDecision') });
}

async function plan(args, { env, fetchImpl, keyFile, now, dataDir }) {
  const parsed = projectRef(parseArgs(args));
  if (!parsed) return fail(2, ...USAGE);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  return redacted(await writePlan(parsed, key, { fetchImpl, now, dataDir }), key);
}

function refuse(files, project, refusals, warnings) {
  rmSync(files.plan, { force: true });
  let review = null;
  if (existsSync(dirname(files.review))) {
    writeFileSync(files.review, renderReview(null, { refusals, project, warnings }));
    review = files.review;
  }
  const out = { status: 'refused', plan: null, review, hash: null, counts: null, refusals };
  return { code: 4, stdout: `${JSON.stringify(out)}\n`, stderr: lines(refusals.map(r => `${r.kind}: ${r.message}`)) };
}

async function outsideCards(harvest, raw, key, fetchImpl) {
  const inProject = new Set(raw.issues.map(i => i.identifier));
  const keys = new Set();
  const add = ref => { if (CARD_KEY.test(ref) && !inProject.has(ref)) keys.add(ref); };
  for (const e of [...(harvest.edges ?? []), ...(harvest.removals ?? [])]) if (!e.hold) { add(e.from); add(e.to); }
  for (const c of harvest.newCards ?? []) if (!c.hold) (c.blocks ?? []).forEach(add);
  const outside = new Map();
  for (const k of [...keys].sort()) {
    const card = await issueOrNull(k, key, fetchImpl);
    if (card) outside.set(k, card);
  }
  return outside;
}

async function writePlan(parsed, key, { fetchImpl, now, dataDir }) {
  // The harvest files are keyed by slug, so an identifier or UUID ref costs exactly one project read before validation.
  let project = null;
  if (parsed.kind === 'identifier' || parsed.kind === 'uuid') {
    try {
      project = await fetchProject(parsed.ref, key, { fetchImpl });
    } catch (e) {
      return fail(1, failure(e));
    }
  }
  const slug = project ? project.slugId : parsed.ref.toLowerCase();
  const dir = join(dataDir, slug, 'harvest');
  const files = { plan: join(dir, 'plan.json'), review: join(dir, 'plan.md') };
  const input = readInputs(dir);
  if (input.errors.length) {
    return refuse(files, { name: project?.name ?? slug, slug }, input.errors.map(message => ({ kind: 'invalid', message })), []);
  }
  let raw;
  let descriptions;
  let outside;
  try {
    raw = await fetchProjectMap(project?.id ?? parsed.ref, key, { fetchImpl, project });
    descriptions = await fetchDescriptions(raw.project.id, key, { fetchImpl });
    outside = await outsideCards(input.harvest, raw, key, fetchImpl);
  } catch (e) {
    return fail(1, failure(e));
  }
  const { records } = readRecords(join(dataDir, slug));
  const r = computePlan({ harvest: input.harvest, records, notes: input.notes, raw, descriptions, outside });
  if (!r.plan) return refuse(files, raw.project, r.refusals, r.warnings);
  const p = r.plan;
  const approveCommand = `node ${tilde(SCRIPT)} apply ${parsed.ref} --plan ${files.plan} --approve ${p.hash.slice(0, 12)}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(files.plan, `${JSON.stringify({ ...p, generatedAt: now().toISOString() }, null, 2)}\n`);
  writeFileSync(files.review, renderReview(p, { refusals: [], approveCommand }));
  const counts = { ops: p.ops.length, keep: p.keep.length, noop: p.noop.length, held: p.held.length, warnings: p.warnings.length };
  return ok({ status: 'written', plan: files.plan, review: files.review, hash: p.hash, counts, refusals: [] });
}

// Slug, URL and UUID refs are compared offline; only an identifier like P-CRM-371 needs one project read.
async function otherProject(parsed, planned, key, fetchImpl) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (parsed.kind === 'uuid') return same(parsed.ref, planned.id) ? null : 'another project';
  if (parsed.kind !== 'identifier') return same(parsed.ref, planned.slug) ? null : 'another project';
  const project = await fetchProject(parsed.ref, key, { fetchImpl });
  return project.id === planned.id ? null : `${project.name} (${project.slugId})`;
}

async function apply(args, { env, fetchImpl, keyFile, now, dataDir }) {
  const a = parseArgs(args, ['--plan', '--approve']);
  const parsed = projectRef(a);
  if (!parsed) return fail(2, ...USAGE);
  if (!a.flags.plan || !a.flags.approve) return fail(5, 'apply needs --plan <plan.json> and --approve <hash> from the reviewed plan');
  let p;
  try {
    p = readJson(a.flags.plan);
  } catch (e) {
    return fail(5, `cannot read the plan ${tilde(a.flags.plan)}: ${e.message}`);
  }
  const refused = approvalError(p, a.flags.approve);
  if (refused) return fail(5, refused);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  let other;
  try {
    other = await otherProject(parsed, p.project, key, fetchImpl);
  } catch (e) {
    return redacted(fail(1, failure(e)), key);
  }
  if (other) return redacted(fail(5, `the plan is for project ${p.project.name} (${p.project.slug}), but ${parsed.ref} is ${other}`), key);
  const dir = join(dataDir, p.project.slug, 'harvest');
  const appendLog = line => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'applied.jsonl'), `${redact(JSON.stringify(line), key)}\n`);
  };
  let r;
  try {
    r = await applyPlan(p, { apiKey: key, fetchImpl, now, appendLog });
  } catch (e) {
    return redacted(fail(1, failure(e)), key);
  }
  if (r.code) return redacted(fail(r.code, ...r.messages), key);
  return redacted(ok({ status: 'applied', results: r.results }), key);
}

async function undo(args, { env, fetchImpl, keyFile, now, dataDir }) {
  const a = parseArgs(args, ['--run', '--approve']);
  const parsed = projectRef(a);
  if (!parsed || !a.flags.run) return fail(2, ...USAGE);
  if ('approve' in a.flags && a.flags.approve !== a.flags.run) return fail(5, 'undo --approve must repeat the run id given to --run');
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  let slug = parsed.ref.toLowerCase();
  if (parsed.kind === 'identifier' || parsed.kind === 'uuid') {
    try {
      slug = (await fetchProject(parsed.ref, key, { fetchImpl })).slugId;
    } catch (e) {
      return redacted(fail(1, failure(e)), key);
    }
  }
  const log = join(dataDir, slug, 'harvest', 'applied.jsonl');
  let entries;
  try {
    entries = readFileSync(log, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch (e) {
    return fail(4, `cannot read ${tilde(log)}: ${e.message}`);
  }
  const execute = 'approve' in a.flags;
  const appendLog = line => appendFileSync(log, `${redact(JSON.stringify(line), key)}\n`);
  let r;
  try {
    r = await undoRun(entries, a.flags.run, { apiKey: key, fetchImpl, now, appendLog, execute });
  } catch (e) {
    return redacted(fail(1, failure(e)), key);
  }
  if (r.code) return redacted(fail(r.code, ...r.messages), key);
  return redacted(ok({ status: execute ? 'undone' : 'listed', run: a.flags.run, results: r.results }), key);
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
