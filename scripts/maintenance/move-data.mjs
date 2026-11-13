#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fail, isEntry, ok } from '../lib/cli.mjs';
import { REPO_DATA_DIR } from '../lib/records.mjs';
import { assertHomeOutsideWorkTree, sequencerHome } from '../lib/spike/home.mjs';
import { isSlug } from '../lib/spike/prune.mjs';

const USAGE = 'usage: node scripts/maintenance/move-data.mjs <slug> [--apply] [--home <dir>] [--data <repo data dir>]';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parse(argv) {
  const out = { apply: false, slug: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if ((arg === '--home' || arg === '--data') && i + 1 < argv.length) out[arg.slice(2)] = argv[++i];
    else if (!arg.startsWith('--') && out.slug === null) out.slug = arg;
    else return null;
  }
  return out.slug && isSlug(out.slug) ? out : null;
}

const filesUnder = dir => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name)))
  : []);

function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

// Empty folders left behind, deepest first; a folder still holding anything stays.
function pruneEmpty(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

export async function run(argv, { env = process.env } = {}) {
  const args = parse(argv);
  if (!args) return fail(2, USAGE);
  const home = args.home ?? sequencerHome(env);
  const from = join(args.data ?? REPO_DATA_DIR, args.slug);
  const to = join(home, args.slug);
  try {
    assertHomeOutsideWorkTree(home);
  } catch (e) {
    return fail(2, e.message);
  }
  const moves = filesUnder(from).sort(compare).map(f => ({ from: join(from, f), to: join(to, f) }));
  const taken = moves.filter(m => existsSync(m.to));
  if (args.apply && taken.length) {
    return fail(2, ...taken.map(m => `${m.to} already exists: nothing was moved`), 'move or merge that file by hand, then run this again');
  }
  if (args.apply) {
    for (const m of moves) move(m.from, m.to);
    pruneEmpty(from);
  }
  return ok({ action: 'move-data', slug: args.slug, applied: args.apply, from, to, moves });
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
