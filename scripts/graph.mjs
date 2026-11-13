#!/usr/bin/env node
import { join } from 'node:path';
import { fail, isEntry, lines, redacted } from './lib/cli.mjs';
import { analyzeProject, backwardEdges, isExecutionCard } from './lib/graph.mjs';
import { fetchProjectMap, parseProjectRef, readLinearKey } from './lib/linear-fetch.mjs';
import { localDay, rankCards } from './lib/next-order.mjs';
import { dataInRepoWarning, isLive, readRecords, REPO_DATA_DIR, sizesFor } from './lib/records.mjs';
import { dataDirFor, displayData } from './lib/spike/home.mjs';

const USAGE = 'usage: node scripts/graph.mjs <Linear project URL | slug | UUID | identifier like P-CRM-371>';

export async function run(argv, { env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), dataDir, repoDataDir } = {}) {
  if (!argv[0]) return fail(2, USAGE);
  const parsed = parseProjectRef(argv[0]);
  if (!parsed) return fail(2, 'the argument is not a Linear project URL, slug, UUID or identifier', USAGE);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  const data = { dataDir: dataDir ?? dataDirFor(env), repoDataDir: repoDataDir ?? (dataDir === undefined ? REPO_DATA_DIR : null) };
  const result = await graph(parsed.ref, key, { fetchImpl, now, data });
  return redacted(result, key);
}

async function graph(ref, key, { fetchImpl, now, data }) {
  let raw;
  try {
    raw = await fetchProjectMap(ref, key, { fetchImpl });
  } catch (e) {
    return fail(1, e.message);
  }
  try {
    return render(raw, now, data);
  } catch (e) {
    return fail(1, `internal error: ${e.message}`);
  }
}

function spikeRecords(raw, { dataDir, repoDataDir }) {
  const dir = displayData(dataDir, raw.project.slug);
  const { records, invalid } = readRecords(join(dataDir, raw.project.slug));
  const onMap = new Set((raw.issues ?? []).filter(isExecutionCard).map(n => n.identifier));
  const live = records.filter(r => isLive(r) && onMap.has(r.card));
  const warnings = invalid.map(({ file, errors }) => ({
    key: file, kind: 'record-invalid', message: `spike record ${dir}/${file} is invalid, ignored: ${errors.join('; ')}`,
  }));
  const moved = dataInRepoWarning({ dataDir, repoDataDir, slug: raw.project.slug, display: dir });
  if (moved) warnings.push(moved);
  return { sizes: sizesFor(live), summary: { dir, count: live.length, invalid: invalid.length }, warnings };
}

function render(raw, now, data) {
  const records = spikeRecords(raw, data);
  const a = analyzeProject(raw, { sizes: records.sizes });
  const warnings = [...raw.warnings, ...backwardEdges(a.cards, a.edges), ...records.warnings];
  const at = now();
  const out = {
    schemaVersion: 1,
    fetched: at.toISOString(),
    project: raw.project,
    cards: rankCards(a.cards, { today: localDay(at), critical: a.critical, criticalTies: a.criticalTies }),
    edges: a.edges,
    free: a.free,
    critical: a.critical,
    criticalTies: a.criticalTies,
    cycles: a.cycles,
    danglingBlocks: a.danglingBlocks,
    records: records.summary,
    warnings,
    summary: a.summary,
  };
  return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: lines(warnings.map(w => `warning: ${w.message}`)) };
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
