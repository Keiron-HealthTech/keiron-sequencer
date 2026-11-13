#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fail, isEntry, ok } from '../lib/cli.mjs';
import { workTreeOf, writeAtomic } from '../lib/spike/home.mjs';

const USAGE = 'usage: node scripts/maintenance/move-home.mjs [--apply] [--inverse] [--from <dir>] [--to <dir>]';
const OLD_HOME = '.mikado';
const NEW_HOME = '.keiron-sequencer';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parse(argv) {
  const out = { apply: false, inverse: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply' || arg === '--inverse') out[arg.slice(2)] = true;
    else if ((arg === '--from' || arg === '--to') && i + 1 < argv.length) out[arg.slice(2)] = argv[++i];
    else return null;
  }
  return out;
}

const subdirs = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(dir, e.name)) : []);

const runDirs = home => subdirs(home).flatMap(slug => subdirs(join(slug, 'runs')));

const jsonFiles = home => (existsSync(home)
  ? readdirSync(home, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => join(e.parentPath, e.name))
    .sort(compare)
  : []);

const movedPath = (value, from, to) => (value === from || value.startsWith(`${from}${sep}`) ? `${to}${value.slice(from.length)}` : null);

// Rewrites string values in the JSON text itself, so every byte other than a moved path keeps its place:
// whitespace, key order and escapes stay as written, and the inverse restores the file exactly. Keys are left alone.
function rewriteText(text, from, to) {
  const changes = [];
  const key = /\s*:/y;
  const rewritten = text.replace(/"(?:[^"\\]+|\\.)*"/g, (token, at) => {
    key.lastIndex = at + token.length;
    if (key.test(text)) return token;
    const value = JSON.parse(token);
    const moved = movedPath(value, from, to);
    if (moved === null) return token;
    changes.push({ old: value, new: moved });
    return JSON.stringify(moved);
  });
  return { after: rewritten, changes };
}

function refusals(from, to, files) {
  const out = [];
  if (!existsSync(from)) out.push(`${from} does not exist: there is nothing to move`);
  if (existsSync(to)) out.push(`${to} already exists: move it aside first`);
  for (const path of [from, to]) {
    const tree = workTreeOf(path);
    if (tree) out.push(`${path} is inside the git work tree ${tree}: a data home must sit outside every repo`);
  }
  for (const dir of runDirs(from)) {
    const lock = join(dir, 'run.lock');
    if (existsSync(lock)) out.push(`${lock} exists: a spike run is active, finish it first`);
    const trees = join(dir, 'trees');
    if (existsSync(trees) && readdirSync(trees).length) out.push(`${trees} holds spike trees whose git links would break: prune them first`);
  }
  for (const file of files) {
    try {
      JSON.parse(file.text);
    } catch (e) {
      out.push(`${file.path} is not valid JSON (${e.message}): fix or remove it first`);
    }
  }
  return out;
}

// Rewrites first, then one rename: on any failure the files written so far get their original text back,
// so the source is left exactly as it was and a fresh preview shows the same plan.
function apply(rewrites, from, to, rename) {
  const written = [];
  let step;
  try {
    for (const w of rewrites) {
      step = `rewriting ${w.path}`;
      writeAtomic(w.path, w.after);
      written.push(w);
    }
    step = `the rename of ${from} to ${to}`;
    rename(from, to);
    return null;
  } catch (e) {
    for (const w of written) writeAtomic(w.path, w.before);
    return `${step} failed: ${e.message}`;
  }
}

export async function run(argv, { userHome, rename = renameSync } = {}) {
  const args = parse(argv);
  if (!args) return fail(2, USAGE);
  const roots = [args.from ?? join(userHome, OLD_HOME), args.to ?? join(userHome, NEW_HOME)];
  const [from, to] = args.inverse ? roots.reverse() : roots;
  const files = jsonFiles(from).map(path => ({ path, text: readFileSync(path, 'utf8') }));
  const refused = refusals(from, to, files);
  if (refused.length) return fail(5, ...refused, 'nothing was moved or rewritten');
  const rewrites = files
    .map(({ path, text }) => ({ path, before: text, ...rewriteText(text, from, to) }))
    .filter(w => w.changes.length);
  const entries = readdirSync(from).sort(compare);
  if (args.apply) {
    const failed = apply(rewrites, from, to, rename);
    if (failed) return fail(1, failed, 'nothing was moved: every rewritten file has its original text again');
  }
  const shown = to.startsWith(`${userHome}${sep}`) ? `~${to.slice(userHome.length)}` : to;
  return ok({
    action: 'move-home',
    direction: args.inverse ? 'inverse' : 'forward',
    applied: args.apply,
    from,
    to,
    entries,
    rewrites: rewrites.flatMap(w => w.changes.map(c => ({ file: relative(from, w.path), ...c }))),
    ...(args.apply ? { next: `run /add-dir ${shown} in Claude Code so it can read the moved data` } : {}),
  });
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2), { userHome: homedir() });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
