#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { exitError, fail, isEntry, ok } from '../lib/cli.mjs';
import { caseSource } from '../lib/harvest.mjs';
import { invert, MANIFEST, readDirMap, renamePatchRefs } from '../lib/patch-dirs.mjs';
import { serializeRecord, validateRecord } from '../lib/record.mjs';
import { loadConfig } from '../lib/spike/config.mjs';
import { assertHomeOutsideWorkTree, dataDirFor, findTrialReference, sequencerHome, trialPatchRoot, writeAtomic, writeJsonAtomic } from '../lib/spike/home.mjs';
import { activeRunFor } from '../lib/spike/state.mjs';
import { mapRepo } from '../lib/start/checkout.mjs';

const USAGE = 'usage: node scripts/maintenance/rename-trial-dirs.mjs [--apply] [--inverse] [--home <dir>] [--data <dir>] [--trial <trial reference dir>]';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirsIn = root => (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(compare) : []);
const filesIn = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort(compare) : []);
const sha256 = text => createHash('sha256').update(text).digest('hex');
const renamed = map => Object.fromEntries(Object.entries(map).filter(([from, to]) => from !== to));

function parse(argv) {
  const out = { apply: false, inverse: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply' || arg === '--inverse') out[arg.slice(2)] = true;
    else if (['--home', '--data', '--trial'].includes(arg) && i + 1 < argv.length) out[arg.slice(2)] = argv[++i];
    else return null;
  }
  return out;
}

function readPatchMap(trial) {
  try {
    const map = JSON.parse(readFileSync(join(trial, 'backfill', 'patch-map.json'), 'utf8'));
    return { slug: map.project.slug, repos: map.repos };
  } catch (e) {
    throw exitError(1, `cannot read the trial patch map under ${trial}: ${e.code ?? e.message}`);
  }
}

function readConfig(home) {
  if (!existsSync(join(home, 'config.json'))) return null;
  try {
    return loadConfig(home);
  } catch (e) {
    throw exitError(2, e.message);
  }
}

// Each trial dir goes to the configured dir carrying its repo name, else to the repo name itself.
function forwardMap(repos, config) {
  const map = {};
  const warnings = [];
  for (const dir of Object.keys(repos).sort(compare)) {
    const hit = config ? mapRepo(config, repos[dir]) : null;
    map[dir] = hit?.dir ?? repos[dir];
    if (!hit) warnings.push({ code: 'unconfigured', dir, to: map[dir], message: `${dir} becomes ${map[dir]}, which no configured repo carries yet` });
  }
  const sources = Object.keys(map);
  for (const to of new Set(Object.values(map))) {
    const from = sources.filter(d => map[d] === to);
    if (from.length > 1) throw exitError(5, `trial dirs ${from.join(' and ')} would both become ${to}; nothing was changed`);
    if (sources.includes(to) && map[to] !== to) throw exitError(5, `trial dir ${from[0]} would become ${to}, which is another trial dir; nothing was changed`);
  }
  return { map, warnings };
}

// Every string a rename would change, by its JSON path in the record's own key order.
function changesIn(before, after, path = '$', out = []) {
  if (typeof before === 'string') {
    if (before !== after) out.push({ path, from: before, to: after });
  } else if (Array.isArray(before)) {
    before.forEach((v, i) => changesIn(v, after[i], `${path}[${i}]`, out));
  } else if (before && typeof before === 'object') {
    for (const [k, v] of Object.entries(before)) changesIn(v, after[k], `${path}.${k}`, out);
  }
  return out;
}

// Records whose patches live in a run hold run dirs, never trial dirs, so they are left as they are.
function planRecords(dataDir, slug, map) {
  const dir = join(dataDir, slug);
  const out = [];
  for (const file of filesIn(dir).filter(f => f.endsWith('.json'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const value = JSON.parse(text);
    if (value.refs?.runId) continue;
    const next = renamePatchRefs(value, map);
    const changes = changesIn(value, next);
    if (!changes.length) continue;
    if (text !== serializeRecord(value)) throw exitError(5, `${file} is not in canonical form, so a rewrite would change more than its patch references; nothing was changed`);
    const errors = validateRecord(next);
    if (errors.length) throw exitError(5, `${file} would not validate after the rewrite (${errors.join('; ')}); nothing was changed`);
    out.push({ file, value, text: serializeRecord(next), changes });
  }
  return out;
}

function heldWarnings(dataDir, slug, map) {
  const warnings = [];
  for (const sub of ['spike', 'harvest']) {
    const root = join(dataDir, slug, sub);
    if (!existsSync(root)) continue;
    for (const path of readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json'))) {
      const full = join(path.parentPath, path.name);
      const value = JSON.parse(readFileSync(full, 'utf8'));
      const count = changesIn(value, renamePatchRefs(value, map)).length;
      if (count) warnings.push({ code: 'not-rewritten', file: relative(dataDir, full), count, message: `${relative(dataDir, full)} names ${count} trial patch path(s); held files are never rewritten` });
    }
  }
  return warnings.sort((a, b) => compare(a.file, b.file));
}

// Patch bytes keyed in the trial namespace, so the digest is the same before and after a rename.
function digest(root, toTrial) {
  const entries = new Map();
  for (const dir of dirsIn(root)) {
    for (const file of filesIn(join(root, dir))) entries.set(`${toTrial[dir] ?? dir}/${file}`, sha256(readFileSync(join(root, dir, file))));
  }
  return entries;
}

const digestSummary = entries => ({
  count: entries.size,
  sha256: sha256([...entries].sort(([a], [b]) => compare(a, b)).map(([k, v]) => `${k}\t${v}`).join('\n')),
});

function folderStates(root, pairs) {
  return pairs.map(({ from, to }) => {
    if (from === to) return { from, to, state: 'same' };
    const source = existsSync(join(root, from));
    const target = existsSync(join(root, to));
    if (source && target) throw exitError(5, `the folder ${to} already exists beside ${from}; nothing was changed`);
    return { from, to, state: source ? 'todo' : target ? 'done' : 'absent' };
  });
}

function guarded(home, slug) {
  try {
    assertHomeOutsideWorkTree(home);
  } catch (e) {
    throw exitError(5, e.message);
  }
  const open = activeRunFor(home, slug);
  if (open) throw exitError(5, `run ${open.state.runId} of ${slug} is ${open.state.status} and may read the trial patches; finish or abandon it first`);
}

// pairs: [from, to] on disk, identity included; moves: the renames only; toTrial: disk dir -> trial dir.
function planMoves({ dataDir, slug, root, pairs, known, moves, toTrial }) {
  const unknown = dirsIn(root).filter(d => !known.has(d));
  if (unknown.length) throw exitError(5, `trial folders not in the patch map: ${unknown.join(', ')}; nothing was changed`);
  return {
    folders: folderStates(root, pairs.map(([from, to]) => ({ from, to }))),
    records: planRecords(dataDir, slug, moves),
    before: digest(root, toTrial),
  };
}

function planForward({ home, dataDir, trial }) {
  const { slug, repos } = readPatchMap(trial);
  const root = trialPatchRoot(home, slug);
  guarded(home, slug);
  const { map, warnings } = forwardMap(repos, readConfig(home));
  const moves = renamed(map);
  const toTrial = invert(moves);
  const known = new Set([...Object.keys(map), ...Object.values(map)]);
  const planned = planMoves({ dataDir, slug, root, pairs: Object.entries(map), known, moves, toTrial });
  return { slug, root, map, moves, toTrial, ...planned, warnings: [...warnings, ...heldWarnings(dataDir, slug, moves)] };
}

// The inverse reads only the manifest the apply wrote, never the live config.
function planInverse({ home, dataDir, trial }) {
  const { slug, repos } = readPatchMap(trial);
  const root = trialPatchRoot(home, slug);
  guarded(home, slug);
  const applied = readDirMap(root);
  if (!Object.keys(applied).length) {
    return { slug, root, map: {}, moves: {}, toTrial: {}, folders: [], records: [], before: digest(root, {}), warnings: [{ code: 'not-applied', message: `no ${MANIFEST} under ${root}: the rename was never applied` }] };
  }
  const dir = join(dataDir, slug);
  for (const file of filesIn(dir).filter(f => f.endsWith('.json'))) {
    const value = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (value.refs?.runId || value.replayed) {
      throw exitError(5, `${file} has a run id or a replay marker: a respike has run since the rename, and the inverse would also rename that run's references; nothing was changed. Restore the records of data/${slug} with git and rename the folders by hand`);
    }
  }
  const moves = Object.fromEntries(Object.entries(invert(applied)).sort(([a], [b]) => compare(a, b)));
  const known = new Set([...Object.keys(repos), ...Object.keys(moves)]);
  const planned = planMoves({ dataDir, slug, root, pairs: Object.entries(moves), known, moves, toTrial: moves });
  return { slug, root, map: moves, moves, toTrial: moves, ...planned, warnings: heldWarnings(dataDir, slug, moves) };
}

const output = (p, { direction, applied }) => ({
  direction,
  applied,
  map: p.map,
  folders: p.folders,
  records: p.records.map(({ file, changes }) => ({ file, changes })),
  patches: digestSummary(p.before),
  warnings: p.warnings,
});

const casesOf = record => (record.cases ?? []).map(caseSource);

// Patch bytes and case hashes are compared after the move; a mismatch stops with nothing further written.
function verify(p, after, written, dataDir) {
  const lost = [...p.before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k);
  if (lost.length || after.size !== p.before.size) throw exitError(1, `patch digests differ after the rename: ${lost.join(', ') || 'a file count changed'}`);
  for (const { file, value } of written) {
    const now = JSON.parse(readFileSync(join(dataDir, p.slug, file), 'utf8'));
    const errors = validateRecord(now);
    if (errors.length) throw exitError(1, `${file} does not validate after the rename: ${errors.join('; ')}`);
    if (JSON.stringify(casesOf(now)) !== JSON.stringify(casesOf(value))) throw exitError(1, `${file}: a case hash changed in the rename`);
  }
}

// Each step is idempotent per item, so running apply again after a failure finishes the job.
function applyForward(p, { dataDir, rename }) {
  for (const r of p.records) writeAtomic(join(dataDir, p.slug, r.file), r.text);
  for (const f of p.folders.filter(x => x.state === 'todo')) rename(join(p.root, f.from), join(p.root, f.to));
  const manifest = { schemaVersion: 1, dirs: p.moves };
  const path = join(p.root, MANIFEST);
  if (Object.keys(p.moves).length && JSON.stringify(readDirMap(p.root)) !== JSON.stringify(p.moves)) writeJsonAtomic(path, manifest);
  verify(p, digest(p.root, p.toTrial), p.records, dataDir);
}

// The manifest goes last, so an interrupted inverse still knows the map when it runs again.
function applyInverse(p, { dataDir, rename }) {
  if (!Object.keys(p.moves).length) return;
  for (const r of p.records) writeAtomic(join(dataDir, p.slug, r.file), r.text);
  for (const f of p.folders.filter(x => x.state === 'todo')) rename(join(p.root, f.from), join(p.root, f.to));
  verify(p, digest(p.root, p.toTrial), p.records, dataDir);
  rmSync(join(p.root, MANIFEST), { force: true });
}

export async function run(argv, { env = process.env, rename = renameSync } = {}) {
  const args = parse(argv);
  if (!args) return fail(2, USAGE);
  const home = args.home ?? sequencerHome(env);
  try {
    const paths = { home, dataDir: args.data ?? dataDirFor(env), trial: args.trial ?? findTrialReference(home) };
    const p = (args.inverse ? planInverse : planForward)(paths);
    if (args.apply) (args.inverse ? applyInverse : applyForward)(p, { dataDir: paths.dataDir, rename });
    return ok(output(p, { direction: args.inverse ? 'inverse' : 'forward', applied: args.apply }));
  } catch (e) {
    return fail(e.exitCode ?? 1, e.message);
  }
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
