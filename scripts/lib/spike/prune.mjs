import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isLive } from '../records.mjs';
import { RUN_ID } from './home.mjs';
import { allRepos, readState } from './state.mjs';

const KEEP = 2;
export const isSlug = name => /^[A-Za-z0-9-]+$/.test(name);

const dirs = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []);

export const prunableSlugs = home => dirs(home).filter(slug => isSlug(slug) && existsSync(join(home, slug, 'runs')));

// A run that can still be resumed keeps its trees, so it is kept whatever its age.
function resumableWithTrees(dir) {
  if (!existsSync(join(dir, 'run.json'))) return null;
  const state = readState(dir);
  const open = state.status === 'active' || state.status === 'paused';
  return open && allRepos(state).some(([, r]) => r.status !== 'removed') ? `${state.status} with trees` : null;
}

// Only top-level records count: a history record never needs its patches again.
function referencedRuns(dataDir, slug) {
  const dir = join(dataDir, slug);
  const files = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name).sort() : [];
  const kept = new Set();
  const unreadable = [];
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (record?.refs?.runId && isLive(record)) kept.add(record.refs.runId);
    } catch (e) {
      unreadable.push(`${join(slug, file)}: ${e.code ?? e.message}`);
    }
  }
  return { kept, unreadable };
}

// Only run-id folders under <slug>/runs/ are ever deleted: the trial patches and every other name stay.
export function pruneRuns(home, slug, { dryRun = false, dataDir = null } = {}) {
  if (!isSlug(slug)) throw new Error(`${slug} is not a project slug`);
  const runs = join(home, slug, 'runs');
  const removed = [];
  const skipped = [];
  const { kept, unreadable } = dataDir ? referencedRuns(dataDir, slug) : { kept: new Set(), unreadable: [] };
  if (unreadable.length) return { slug, removed, skipped, unreadable };
  for (const runId of dirs(runs).filter(n => RUN_ID.test(n)).slice(0, -KEEP).filter(id => !kept.has(id))) {
    const reason = resumableWithTrees(join(runs, runId));
    if (reason) { skipped.push({ runId, reason }); continue; }
    if (!dryRun) rmSync(join(runs, runId), { recursive: true, force: true });
    removed.push(runId);
  }
  return { slug, removed, skipped };
}
