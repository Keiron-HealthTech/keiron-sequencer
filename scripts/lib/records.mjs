import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecord } from './record.mjs';

// Where records lived before they moved to the spike home, and the script that moves them.
export const REPO_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const MOVE_DATA = fileURLToPath(new URL('../maintenance/move-data.mjs', import.meta.url));

const recordFiles = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json')).length : 0);

// Every record left in the repo's data/ reads as "no record" to the CLIs, even once the home holds some: say how many, where,
// and how to move them. The move refuses a file the home already has, so that one is merged by hand.
export function dataInRepoWarning({ repoDataDir, slug, display }) {
  const count = repoDataDir ? recordFiles(join(repoDataDir, slug)) : 0;
  if (!count) return null;
  return {
    key: slug, kind: 'data-in-repo',
    message: `${count} spike record(s) for ${slug} are still in ${join(repoDataDir, slug)}, where they read as no record: `
      + `preview the move to ${display} with node ${MOVE_DATA} ${slug}, then run it again with --apply; `
      + 'it refuses a file that already exists there, so move or merge such a file by hand first',
  };
}

// The same warning for every project that still has records in the repo's data/, for a CLI that runs before it knows its slug.
export function dataInRepoWarnings({ repoDataDir, display }) {
  if (!repoDataDir || !existsSync(repoDataDir)) return [];
  return readdirSync(repoDataDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    .map(slug => dataInRepoWarning({ repoDataDir, slug, display: display(slug) })).filter(Boolean);
}

export function readRecords(dir) {
  const records = [];
  const invalid = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { records, invalid };
  }
  const files = entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name).sort();
  for (const file of files) {
    const { value, errors } = readOne(join(dir, file), file);
    if (errors.length) invalid.push({ file, errors });
    else records.push(value);
  }
  return { records, invalid };
}

function readOne(path, file) {
  let text;
  let value;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { errors: [`unreadable: ${e.code ?? e.message}`] };
  }
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { errors: [`not valid JSON: ${e.message}`] };
  }
  const errors = validateRecord(value);
  const card = value?.card;
  if (typeof card === 'string' && `${card}.json` !== file) errors.push(`$.card: ${card} does not match the file name ${file}`);
  return { value, errors };
}

export const isLive = r => !r.archived && !r.supersededBy;

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const linesOf = r => r.size.prodLines + r.size.testLines;

export function tiers(records) {
  const population = records
    .filter(r => isLive(r) && r.origin === 'thin-spike' && r.size && linesOf(r) > 0)
    .sort((a, b) => linesOf(a) - linesOf(b) || cardNumber(a.card) - cardNumber(b.card));
  const n = population.length;
  return new Map(population.map((r, i) => {
    const q = i / n;
    return [r.card, q < 0.25 ? 'S' : q < 0.5 ? 'M' : q < 0.75 ? 'L' : 'XL'];
  }));
}

export function sizeLabel({ tier, lines, origin }) {
  if (tier) return `${tier} · ${lines} lines`;
  return origin === 'existing-pr' ? `${lines} lines · existing PR` : `${lines} lines`;
}

// unknown: a record written before openDecisions and novelty existed lacks the inputs; it is never "No SDD".
// Risk areas are path globs, not design questions: they no longer decide the verdict. An open decision written before
// impact existed counts as design.
export function verdict(r, tier) {
  if (!Array.isArray(r.openDecisions) || !Array.isArray(r.novelty?.newPaths)) return 'unknown';
  if (r.openDecisions.some(d => (d?.impact ?? 'design') === 'design') || tier === 'XL') return 'SDD';
  if (tier === 'L' || (r.fixups?.received?.length ?? 0) + (r.fixups?.caused?.length ?? 0) >= 2 || r.novelty.newPaths.length) return 'Light';
  return 'No SDD';
}

export function sizesFor(records) {
  const tierOf = tiers(records);
  const out = {};
  for (const r of records) {
    if (!isLive(r) || !r.size) continue;
    const size = { tier: tierOf.get(r.card) ?? null, lines: linesOf(r), origin: r.origin };
    out[r.card] = { ...size, label: sizeLabel(size), verdict: verdict(r, size.tier) };
  }
  return out;
}
