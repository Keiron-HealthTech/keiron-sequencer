#!/usr/bin/env node
import { join } from 'node:path';
import { fail, isEntry, lines, redacted } from './lib/cli.mjs';
import { analyzeProject, backwardEdges, isExecutionCard } from './lib/graph.mjs';
import { fetchDescriptions, fetchOffMapIssue, fetchProjectMap, fetchViewer, parseProjectRef, readLinearKey } from './lib/linear-fetch.mjs';
import { localWork } from './lib/next/clones.mjs';
import { classify } from './lib/next/free.mjs';
import { pullRequests } from './lib/next/github.mjs';
import { textEdges } from './lib/next/text.mjs';
import { localDay, rankCards } from './lib/next-order.mjs';
import { dataInRepoWarning, isLive, readRecords, REPO_DATA_DIR, sizesFor } from './lib/records.mjs';
import { allowedRepos, loadConfig } from './lib/spike/config.mjs';
import { ghRunner, gitRunner } from './lib/spike/exec.mjs';
import { dataDirFor, displayData, sequencerHome } from './lib/spike/home.mjs';

const STARTABLE = new Set(['backlog', 'unstarted']);

const USAGE = 'usage: node scripts/next.mjs <Linear project URL | slug | UUID | identifier like P-CRM-371>';

export async function run(argv, {
  env = process.env, fetchImpl = fetch, keyFile, now = () => new Date(), home, dataDir, repoDataDir,
  gh = ghRunner(), git = gitRunner(), listDir,
} = {}) {
  if (!argv[0]) return fail(2, USAGE);
  const parsed = parseProjectRef(argv[0]);
  if (!parsed) return fail(2, 'the argument is not a Linear project URL, slug, UUID or identifier', USAGE);
  const { key, reason } = readLinearKey(env, keyFile);
  if (!key) return fail(3, reason);
  let config;
  try {
    config = loadConfig(home ?? sequencerHome(env));
  } catch (e) {
    return redacted(fail(2, e.message), key);
  }
  const data = { dataDir: dataDir ?? dataDirFor(env), repoDataDir: repoDataDir ?? (dataDir === undefined ? REPO_DATA_DIR : null) };
  const result = await next(parsed.ref, key, { fetchImpl, now, data, config, gh, git, listDir });
  return redacted(result, key);
}

async function readLinear(ref, key, { fetchImpl }) {
  const raw = await fetchProjectMap(ref, key, { fetchImpl });
  const viewer = await fetchViewer(key, { fetchImpl });
  const described = await fetchDescriptions(raw.project.id, key, { fetchImpl });
  return { raw, viewer, descriptions: new Map([...described].map(([k, v]) => [k, v.description])) };
}

async function next(ref, key, { fetchImpl, now, data, config, gh, git, listDir }) {
  let read;
  try {
    read = await readLinear(ref, key, { fetchImpl });
  } catch (e) {
    return fail(1, e.message);
  }
  let analyzed;
  let offMapKeys;
  try {
    ({ analyzed, offMapKeys } = analyze(read, data));
  } catch (e) {
    return fail(1, `internal error: ${e.message}`);
  }
  const offMap = new Map();
  try {
    for (const k of offMapKeys) {
      const issue = await fetchOffMapIssue(k, key, { fetchImpl });
      if (issue) offMap.set(k, issue);
    }
  } catch (e) {
    return fail(1, e.message);
  }
  try {
    return render({ read, analyzed, offMap, now, config, gh, git, listDir });
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

function analyze({ raw, descriptions }, data) {
  const records = spikeRecords(raw, data);
  const a = analyzeProject(raw, { sizes: records.sizes });
  const onMap = new Set(a.cards.map(c => c.key));
  const mapText = new Map([...descriptions].filter(([k]) => onMap.has(k)));
  const textFrom = textEdges(mapText).filter(e => onMap.has(e.to) && !onMap.has(e.from)).map(e => e.from);
  const offMapKeys = [...new Set([...a.cards.flatMap(c => c.offMapBlockers), ...textFrom])].sort();
  return { analyzed: { ...a, records }, offMapKeys };
}

// The Linear-only board warnings the skill reports as hygiene.
function boardWarnings(a) {
  const out = [...backwardEdges(a.cards, a.edges)];
  for (const group of a.cycles) out.push({ key: group.join('>'), kind: 'cycle', message: `blocks cycle: ${[...group, group[0]].join(' → ')}` });
  const loose = a.cards.filter(c => c.statusType !== 'completed' && !c.milestone).map(c => c.key);
  if (loose.length) {
    out.push({ key: loose.join(','), kind: 'no-milestone', message: `open cards with no milestone: ${loose.join(', ')}; assign one in Linear before a respike` });
  }
  for (const d of a.danglingBlocks) {
    const id = `${d.from}>${d.to}`;
    if (d.reason === 'archived' || d.reason === 'canceled') {
      out.push({ key: id, kind: 'stale-block', message: `${d.from} blocks ${d.to}, but ${d.offMap} is ${d.reason}: remove the block in Linear` });
    } else if ((d.reason === 'qa' || d.reason === 'planner') && d.offMap === d.from && d.open) {
      out.push({ key: id, kind: 'wiring', message: `${d.from} (${d.reason}) blocks ${d.to}: QA and planner cards never block; check the relation` });
    } else if (d.reason === 'outside-project' && d.offMap === d.to && d.open) {
      out.push({ key: id, kind: 'outside-project', message: `${d.from} blocks ${d.to}, an open card in another project` });
    }
  }
  return out;
}

function render({ read, analyzed: a, offMap, now, config, gh, git, listDir }) {
  const { raw, viewer } = read;
  const at = now();
  const cards = rankCards(a.cards, { today: localDay(at), critical: a.critical, criticalTies: a.criticalTies });
  const open = cards.filter(c => c.rank !== null);
  const repoDirs = allowedRepos(config, raw.project.slug);
  const repos = repoDirs.map(dir => ({ dir, github: config.repos[dir]?.github ?? null }));
  const known = Object.entries(config.repos).map(([dir, r]) => ({ dir, github: r.github ?? null }));
  const onMap = new Set(a.cards.map(c => c.key));
  // Only map cards and their off-map blockers speak for the map: a canceled or QA card's text names no dependency.
  const descriptions = new Map([...[...read.descriptions].filter(([k]) => onMap.has(k)), ...[...offMap].map(([k, v]) => [k, v.description])]);
  // A linked PR matters only for a card that could be free, or for one that blocks such a card.
  const startable = new Set(open.filter(c => STARTABLE.has(c.statusType)).map(c => c.key));
  const blocking = [...a.edges, ...textEdges(descriptions)].filter(e => startable.has(e.to)).map(e => e.from);
  const needed = new Set([...startable, ...blocking]);
  const attachments = new Map([
    ...open.filter(c => needed.has(c.key) && c.attachments.length).map(c => [c.key, c.attachments]),
    ...[...offMap].filter(([, v]) => v.attachments.length).map(([k, v]) => [k, v.attachments]),
  ]);
  const prs = pullRequests(gh, { repos, known, keys: open.map(c => c.key), offMapKeys: [...offMap.keys()], attachments });
  const work = localWork(git, { config, repoDirs, ...(listDir ? { listDir } : {}) });
  const result = classify({
    cards, edges: a.edges, critical: a.critical, criticalTies: a.criticalTies, offMap, descriptions, viewer, prs, work, config,
  });
  const warnings = [...raw.warnings, ...boardWarnings(a), ...a.records.warnings, ...result.warnings];
  const out = {
    schemaVersion: 1,
    fetched: at.toISOString(),
    today: localDay(at),
    project: raw.project,
    viewer,
    critical: a.critical,
    criticalTies: a.criticalTies,
    free: result.free,
    overdue: result.overdue,
    summary: { open: open.length, free: result.free.length },
    records: a.records.summary,
    warnings,
  };
  return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: lines(warnings.map(w => `warning: ${w.message}`)) };
}

if (isEntry(import.meta.url)) {
  const { code, stdout, stderr } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
