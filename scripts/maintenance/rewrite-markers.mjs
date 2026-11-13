#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isEntry, ok, parseArgs, redacted } from '../lib/cli.mjs';
import { issueOrNull, readBack, stateIndex } from '../lib/harvest-apply.mjs';
import { approvalError, descriptionHash, markerOf, normalizeDescription, observe, planHash } from '../lib/harvest.mjs';
import { fetchIssueState, readLinearKey, redact } from '../lib/linear-fetch.mjs';
import { updateDescription } from '../lib/linear-write.mjs';
import { dataDirFor } from '../lib/spike/home.mjs';

const SCRIPT = fileURLToPath(import.meta.url);

const USAGE = [
  'usage: node scripts/maintenance/rewrite-markers.mjs plan <slug>',
  'usage: node scripts/maintenance/rewrite-markers.mjs apply <slug> <plan hash>',
];

const SLUG = /^[0-9a-f]{12}$/i;
const OLD_MARKER = /<!-- mikado:([a-z0-9][a-z0-9-]*) -->/g;
const NEW_MARKER = /<!-- keiron-sequencer:[a-z0-9][a-z0-9-]* -->/g;
const oldMarkerOf = key => `<!-- mikado:${key} -->`;

const failure = e => (/^Linear\b/.test(e.message) ? e.message : `internal error: ${e.message}`);

const tilde = path => (path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path);

const harvestDir = (dataDir, slug) => join(dataDir, slug, 'harvest');
const planFile = (dataDir, slug) => join(harvestDir(dataDir, slug), 'markers-plan.json');

const COMMANDS = { plan, apply };

export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), dataDir = dataDirFor(env), sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const [command, ...rest] = argv;
  const a = parseArgs(rest);
  if (!Object.hasOwn(COMMANDS, command) || !a || !SLUG.test(a.positional[0] ?? '')) return fail(2, ...USAGE);
  const deps = { env, fetchImpl, keyFile, now, dataDir, sleep };
  try {
    return await COMMANDS[command](a.positional[0].toLowerCase(), a.positional.slice(1), deps);
  } catch (e) {
    return redacted(fail(1, failure(e)), readLinearKey(env, keyFile).key);
  }
}

function createdCards(path) {
  const entries = readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  return [...new Set(entries.filter(l => l.type === 'card.create' && l.identifier).map(l => l.identifier))].sort();
}

function classify(description) {
  const old = [...description.matchAll(OLD_MARKER)];
  const fresh = description.match(NEW_MARKER) ?? [];
  if (old.length === 0) return fresh.length ? { reason: 'already-new' } : { reason: 'no-marker' };
  if (old.length > 1 || fresh.length) return { reason: 'ambiguous' };
  return { key: old[0][1] };
}

async function plan(slug, extra, { env, fetchImpl, keyFile, now, dataDir }) {
  if (extra.length) return fail(2, ...USAGE);
  const log = join(harvestDir(dataDir, slug), 'applied.jsonl');
  let cards;
  try {
    cards = createdCards(log);
  } catch (e) {
    return fail(2, `cannot read ${tilde(log)}: ${e.message}`);
  }
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);

  const ops = [];
  const skipped = [];
  for (const identifier of cards) {
    const state = await issueOrNull(identifier, key, fetchImpl);
    if (!state) { skipped.push({ card: identifier, reason: 'not-found' }); continue; }
    const found = classify(state.description);
    if (found.reason) { skipped.push({ card: identifier, reason: found.reason }); continue; }
    const description = state.description.replace(oldMarkerOf(found.key), markerOf(found.key));
    ops.push({
      id: `marker:${state.identifier}`, type: 'notes.replace', card: state.identifier, issueId: state.id, key: found.key,
      ...(state.archivedAt ? { archived: true } : {}),
      before: { descriptionHash: descriptionHash(state.description) },
      after: { description, descriptionHash: descriptionHash(description) },
    });
  }
  const body = { schemaVersion: 1, kind: 'marker-rewrite', slug, ops, skipped };
  const hash = planHash(body);
  const path = planFile(dataDir, slug);
  mkdirSync(harvestDir(dataDir, slug), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...body, generatedAt: now().toISOString(), hash }, null, 2)}\n`);
  return redacted(ok({
    status: ops.length ? 'written' : 'nothing to rewrite',
    plan: path,
    hash,
    counts: { ops: ops.length, skipped: skipped.length },
    skipped,
    apply: ops.length ? `node ${tilde(SCRIPT)} apply ${slug} ${hash.slice(0, 12)}` : null,
  }), key);
}

const occurrences = (text, marker) => normalizeDescription(text).split(marker).length - 1;

const rewritten = op => state => observe(op, stateIndex(state)) === 'applied'
  && occurrences(state.description, markerOf(op.key)) === 1
  && occurrences(state.description, oldMarkerOf(op.key)) === 0;

function staleness(op, state) {
  if (!state) return 'not found in Linear';
  const seen = observe(op, stateIndex(state));
  if (seen === 'pending') return null;
  return seen === 'applied' ? 'already rewritten since the plan' : seen.drift;
}

async function apply(slug, extra, { env, fetchImpl, keyFile, now, dataDir, sleep }) {
  if (extra.length > 1) return fail(2, ...USAGE);
  const [approve] = extra;
  const path = planFile(dataDir, slug);
  let p;
  try {
    p = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(5, `cannot read the plan ${tilde(path)}: ${e.message}; run plan first`);
  }
  if (!approve) return fail(5, 'apply needs the plan hash printed by plan');
  const refused = approvalError(p, approve);
  if (refused) return fail(5, refused);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);

  const live = new Map();
  for (const op of p.ops) live.set(op.card, await issueOrNull(op.issueId, key, fetchImpl));
  const stale = p.ops.map(op => ({ op, reason: staleness(op, live.get(op.card)) })).filter(s => s.reason);
  if (stale.length) {
    return redacted(fail(6, ...stale.map(({ op, reason }) => `stale: ${op.card}: ${reason}`), 'nothing was written; run plan again'), key);
  }

  const log = join(harvestDir(dataDir, slug), 'markers.jsonl');
  const results = [];
  for (const op of p.ops) {
    let result;
    let error = null;
    try {
      await updateDescription(op.issueId, op.after.description, { apiKey: key, fetchImpl });
      const shows = rewritten(op);
      result = shows(await readBack(() => fetchIssueState(op.issueId, key, { fetchImpl }), shows, sleep)) ? 'applied' : 'unverified';
    } catch (e) {
      result = 'failed';
      error = failure(e);
    }
    const line = {
      v: 1, hash: p.hash, at: now().toISOString(), card: op.card, issueId: op.issueId, key: op.key, result,
      from: oldMarkerOf(op.key), to: markerOf(op.key), before: live.get(op.card).description, ...(error ? { error } : {}),
    };
    appendFileSync(log, `${redact(JSON.stringify(line), key)}\n`);
    results.push({ card: op.card, result });
    if (result === 'failed') return redacted(fail(1, `failed: ${op.card}: ${error}`, 'stopped; run plan again for the cards not yet rewritten'), key);
    if (result === 'unverified') {
      return redacted(fail(1, `unverified: ${op.card}: Linear did not show the new marker after the write`, 'stopped; check that card by hand, then run plan again'), key);
    }
  }
  return redacted(ok({ status: 'applied', results }), key);
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
