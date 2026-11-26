import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPack } from '../packs.mjs';
import { writeJsonAtomic } from '../spike/home.mjs';

export const STARTED_SCHEMA = 1;

// FNV-1a over the path's UTF-16 code units. The status line hook computes the same name, so keep the two in step.
export function startedKey(checkoutPath) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < checkoutPath.length; i++) {
    hash ^= checkoutPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// One file per checkout, holding each branch start made or resumed there.
export const startedPath = (home, checkoutPath) => join(home, 'started', `${startedKey(checkoutPath)}.json`);

export function readStarted(home, checkoutPath) {
  const path = startedPath(home, checkoutPath);
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  return file?.path === checkoutPath ? file : null;
}

// Only what the status line reads from the plan, so a card shows the same line however start was invoked.
function planFacts(plan) {
  const pack = plan.brief?.pack;
  return {
    card: { key: plan.card.key, project: { slug: plan.card.project?.slug ?? null } },
    base: plan.base ? { kind: plan.base.kind ?? null, branch: plan.base.branch ?? null } : null,
    route: plan.route ? { route: plan.route.route ?? null, said: plan.route.said ?? null, reasons: plan.route.reasons ?? [] } : null,
    brief: { pack: pack ? { stale: pack.stale ?? null, answered: pack.answered ?? [], open: pack.open ?? [] } : null },
  };
}

// The pack's stamp at start: a pack drafted again later carries a new one, which tells the hook it is fresh.
export function recordStart(home, { plan, branch, action, checkoutPath, dataDir = home, at }) {
  const slug = plan.card.project?.slug ?? null;
  const pack = slug ? readPack(dataDir, slug, plan.card.key) : null;
  const entry = { card: plan.card.key, slug, branch, action, at, plan: planFacts(plan), packStamp: pack?.stamp ?? null };
  let previous = null;
  try {
    previous = readStarted(home, checkoutPath);
  } catch {
    // An unreadable file is written again whole.
  }
  const file = { schemaVersion: STARTED_SCHEMA, path: checkoutPath, branches: { ...(previous?.branches ?? {}), [branch]: entry } };
  writeJsonAtomic(startedPath(home, checkoutPath), file);
  return startedPath(home, checkoutPath);
}
