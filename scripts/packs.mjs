#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, isEntry, ok, parseArgs, redacted } from './lib/cli.mjs';
import { analyzeProject } from './lib/graph.mjs';
import { fetchDescriptions, fetchProjectMap, parseProjectRef, readLinearKey } from './lib/linear-fetch.mjs';
import { draftPack, packStale, readPack, writePack } from './lib/packs.mjs';
import { dataInRepoWarning, isLive, readRecords, REPO_DATA_DIR } from './lib/records.mjs';
import { loadConfig } from './lib/spike/config.mjs';
import { gitRunner } from './lib/spike/exec.mjs';
import { dataDirFor, displayData } from './lib/spike/home.mjs';
import { mapRepo } from './lib/start/checkout.mjs';

const USAGE = [
  'usage: node scripts/packs.mjs draft <project ref>',
  'usage: node scripts/packs.mjs status <project ref>',
  'usage: node scripts/packs.mjs answer <slug> <CARD> <question id> --outcome <text>',
];
const SLUG = /^[0-9a-f]{12}$/;
const byNumber = (a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0) || (a < b ? -1 : a > b ? 1 : 0);

// The commits the card would start from, by config repo dir: the default tip of each of its repos the config can read.
function basesFor(git, config, record) {
  const bases = {};
  for (const name of record.size?.repos ?? []) {
    const mapped = config && mapRepo(config, name);
    const repo = mapped && config.repos[mapped.dir];
    if (!repo?.checkout || !repo.remote || !repo.defaultBranch) continue;
    try {
      bases[mapped.dir] = git(['rev-parse', '--verify', '--quiet', `${repo.remote}/${repo.defaultBranch}^{commit}`], { cwd: repo.checkout }).trim();
    } catch {
      // an unreadable tip is left out: it is not a move
    }
  }
  return bases;
}

function configOf(home) {
  try {
    return loadConfig(home);
  } catch {
    return null;
  }
}

async function readProject(ref, key, { fetchImpl, dataDir, repoDataDir }) {
  const raw = await fetchProjectMap(ref, key, { fetchImpl });
  const descriptions = await fetchDescriptions(raw.project.id, key, { fetchImpl });
  const slug = raw.project.slug;
  const records = new Map(readRecords(join(dataDir, slug)).records.filter(isLive).map(r => [r.card, r]));
  const issueOf = card => ({ identifier: card, description: descriptions.get(card)?.description ?? '' });
  const moved = dataInRepoWarning({ repoDataDir, slug, display: displayData(dataDir, slug) });
  return { raw, slug, records, issueOf, warnings: moved ? [{ kind: moved.kind, message: moved.message }] : [] };
}

// Packs only for the startable frontier: cards whose blockers are all done. A descendant's questions change when its
// parent lands, so it gets none. A fresh pack is kept; a stale one is drafted again, keeping the answers to the questions
// still asked in the same words.
async function draft(args, { key, fetchImpl, dataDir, home, git, repoDataDir }) {
  const ref = parseProjectRef(args[0] ?? '');
  if (args.length !== 1 || !ref) return fail(2, ...USAGE);
  const { raw, slug, records, issueOf, warnings } = await readProject(ref.ref, key, { fetchImpl, dataDir, repoDataDir });
  const frontier = analyzeProject(raw).free;
  const config = configOf(home);
  const out = { action: 'draft', slug, drafted: [], fresh: [], skipped: [], warnings };
  for (const card of [...frontier].sort(byNumber)) {
    const record = records.get(card);
    if (!record) { out.skipped.push({ card, reason: 'no record' }); continue; }
    const bases = basesFor(git, config, record);
    const old = readPack(dataDir, slug, card);
    if (old && !packStale(old, { issue: issueOf(card), record, bases })) { out.fresh.push(card); continue; }
    const pack = draftPack(record, issueOf(card), bases);
    if (!pack.questions.length) { out.skipped.push({ card, reason: 'no people-owned open decision' }); continue; }
    const kept = new Map((old?.questions ?? []).filter(q => q.answer).map(q => [q.text, q.answer]));
    for (const q of pack.questions) q.answer = kept.get(q.text) ?? null;
    writePack(dataDir, slug, pack);
    out.drafted.push(card);
  }
  return ok(out);
}

async function status(args, { key, fetchImpl, dataDir, home, git, repoDataDir }) {
  const ref = parseProjectRef(args[0] ?? '');
  if (args.length !== 1 || !ref) return fail(2, ...USAGE);
  const { slug, records, issueOf, warnings } = await readProject(ref.ref, key, { fetchImpl, dataDir, repoDataDir });
  const dir = join(dataDir, slug, 'packs');
  const cards = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(byNumber) : [];
  const config = configOf(home);
  const packs = cards.map(card => {
    const pack = readPack(dataDir, slug, card);
    const record = records.get(card) ?? null;
    const reason = record ? packStale(pack, { issue: issueOf(card), record, bases: basesFor(git, config, record) }) : 'record';
    const answered = pack.questions.filter(q => q.answer).length;
    const open = pack.questions.length - answered;
    return { card, state: reason ? 'stale' : open ? 'unanswered' : 'fresh', reason, answered, open };
  });
  return ok({ action: 'status', slug, packs, warnings });
}

// One answer, worded as an outcome; it reads the pack on disk only, so it needs no key.
function answer(args, { dataDir, now }) {
  const a = parseArgs(args, ['--outcome']);
  if (!a || a.positional.length !== 3 || !a.flags.outcome?.trim()) return fail(2, ...USAGE);
  const [slug, card, id] = a.positional;
  if (!SLUG.test(slug)) return fail(2, 'answer takes the project slug, the 12 hex characters of its URL', ...USAGE);
  const pack = readPack(dataDir, slug, card);
  if (!pack) return fail(2, `${card} has no pack in ${slug}: run draft first`);
  const question = pack.questions.find(q => q.id === id);
  if (!question) return fail(2, `${card}'s pack has no question ${id}: it has ${pack.questions.map(q => q.id).join(', ')}`);
  question.answer = { outcome: a.flags.outcome.trim(), answeredAt: now().toISOString() };
  writePack(dataDir, slug, pack);
  return ok({ action: 'answer', slug, card, question: id, outcome: question.answer.outcome });
}

const COMMANDS = { draft, status, answer };
const NEEDS_KEY = new Set(['draft', 'status']);

export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), dataDir, home, repoDataDir, git = gitRunner(),
} = {}) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command)) return fail(2, ...USAGE);
  const deps = {
    fetchImpl, now, dataDir: dataDir ?? dataDirFor(env), home: home ?? dataDir ?? dataDirFor(env), git,
    repoDataDir: repoDataDir ?? (dataDir === undefined ? REPO_DATA_DIR : null),
  };
  if (!NEEDS_KEY.has(command)) return COMMANDS[command](rest, deps);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  try {
    return redacted(await COMMANDS[command](rest, { ...deps, key }), key);
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
