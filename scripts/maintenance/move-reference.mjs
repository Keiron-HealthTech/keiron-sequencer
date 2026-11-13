#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isEntry, ok } from '../lib/cli.mjs';
import { assertHomeOutsideWorkTree, sequencerHome, trialReferenceDir } from '../lib/spike/home.mjs';
import { isSlug } from '../lib/spike/prune.mjs';
import { LINEAR_SNAPSHOT } from '../backfill/build-records.mjs';

const SOURCE = fileURLToPath(new URL('../../docs/reference/', import.meta.url));
const USAGE = 'usage: node scripts/maintenance/move-reference.mjs [--apply] [--home <dir>] [--source <reference dir>]';
const PATCH_MAP = join('backfill', 'patch-map.json');

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function parse(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if ((arg === '--home' || arg === '--source') && i + 1 < argv.length) out[arg.slice(2)] = argv[++i];
    else return null;
  }
  return out;
}

const filesUnder = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name))).sort(compare);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// The trial folder is the one subfolder holding the patch map; the Linear snapshot is the top-level JSON holding a project's issues.
function layoutOf(source) {
  const top = readdirSync(source, { withFileTypes: true });
  const trials = top.filter(e => e.isDirectory() && existsSync(join(source, e.name, PATCH_MAP))).map(e => e.name);
  if (trials.length !== 1) throw new Error(`expected one trial folder holding ${PATCH_MAP} under ${source}, found ${trials.length ? trials.join(', ') : 'none'}`);
  const snapshots = top.filter(e => e.isFile() && e.name.endsWith('.json') && readJson(join(source, e.name))?.project?.issues).map(e => e.name);
  if (snapshots.length !== 1) throw new Error(`expected one Linear snapshot at the top of ${source}, found ${snapshots.length ? snapshots.join(', ') : 'none'}`);
  const slug = readJson(join(source, trials[0], PATCH_MAP))?.project?.slug;
  if (!isSlug(slug)) throw new Error(`the patch map ${join(source, trials[0], PATCH_MAP)} names no usable project slug`);
  return { trial: trials[0], snapshot: snapshots[0], slug };
}

function destOf(file, { trial, snapshot }) {
  if (file === snapshot) return LINEAR_SNAPSHOT;
  return file.startsWith(`${trial}${sep}`) ? file.slice(trial.length + 1) : file;
}

// Empty folders left behind, deepest first; a folder still holding anything stays.
function pruneEmpty(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

export async function run(argv, { env = process.env, source = SOURCE, copyFile = copyFileSync } = {}) {
  const args = parse(argv);
  if (!args) return fail(2, USAGE);
  const home = args.home ?? sequencerHome(env);
  const from = args.source ?? source;
  try {
    assertHomeOutsideWorkTree(home);
  } catch (e) {
    return fail(2, e.message);
  }
  if (!existsSync(from)) return fail(2, `no reference folder at ${from}: pass --source <dir>`);
  let layout;
  try {
    layout = layoutOf(from);
  } catch (e) {
    return fail(2, e.message);
  }
  const to = trialReferenceDir(home, layout.slug);
  const moves = filesUnder(from).map(f => ({ from: join(from, f), to: join(to, destOf(f, layout)) }));
  const seen = new Map();
  const clashes = [];
  for (const m of moves) {
    if (seen.has(m.to)) clashes.push(`${seen.get(m.to)} and ${m.from} both go to ${m.to}`);
    else seen.set(m.to, m.from);
  }
  const taken = moves.filter(m => existsSync(m.to)).map(m => `${m.to} already exists`);
  const refusals = [...clashes, ...taken];
  if (args.apply && refusals.length) return fail(2, ...refusals.map(r => `${r}: nothing was moved`), 'move or merge those files by hand, then run this again');
  if (args.apply) {
    for (const m of moves) {
      m.sha256 = sha256(m.from);
      mkdirSync(dirname(m.to), { recursive: true });
      copyFile(m.from, m.to, constants.COPYFILE_EXCL);
    }
    const bad = moves.filter(m => sha256(m.to) !== m.sha256).map(m => m.from);
    if (bad.length) return fail(1, `the copies of ${bad.join(', ')} do not match their sha256: no source was removed and the copies were kept`);
    for (const m of moves) unlinkSync(m.from);
    pruneEmpty(from);
  }
  return ok({ action: 'move-reference', slug: layout.slug, applied: args.apply, from, to, moves: moves.map(m => ({ from: m.from, to: m.to })), refusals });
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
