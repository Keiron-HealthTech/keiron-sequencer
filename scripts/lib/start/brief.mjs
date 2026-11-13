import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchStats } from '../patch-stats.mjs';
import { runDir, trialPatchRoot } from '../spike/home.mjs';

export const PATCHES_NOTE = 'reference only: chained diffs, not diffs against the default branch';

export function recordNote(records, cardKey) {
  const own = records.filter(r => r.card === cardKey);
  if (!own.length) return 'no record';
  if (own.some(r => !r.archived && !r.supersededBy)) return null;
  const r = own[0];
  if (r.archived) return `the record of ${cardKey} is archived (${r.archived.reason ?? 'no reason given'}), so it is not used`;
  return `the record of ${cardKey} is superseded by ${r.supersededBy.card ?? 'another record'}, so it is not used`;
}

// Only the diff --git headers are read, so no diff text can reach the plan.
export function resolvePatches(record, { home, slug }) {
  return (record?.refs?.patches ?? []).map(ref => {
    const candidates = [
      ...(record.refs.runId ? [['run', join(runDir(home, slug, record.refs.runId), 'patches', ref)]] : []),
      ['trial', join(trialPatchRoot(home, slug), ref)],
    ];
    const [location, path] = candidates.find(([, p]) => existsSync(p)) ?? [null, null];
    return { ref, repoDir: ref.split('/')[0], location, files: path ? patchStats(readFileSync(path, 'utf8')).files : [] };
  });
}

function sizeOf(record, size) {
  if (!record.size) return null;
  const { files, repos, sharedWith = [] } = record.size;
  return { label: size?.label ?? null, tier: size?.tier ?? null, lines: record.size.prodLines + record.size.testLines, files, repos, sharedWith };
}

export function buildBrief({ record, size = null, recordNote: note = null, patches = [], otherRepos = [], pack = null }) {
  return {
    record: record && {
      spikedAt: record.spikedAt, origin: record.origin, scope: record.scope, size: sizeOf(record, size), decisions: record.decisions,
      cases: record.cases, findings: record.findings, fixups: record.fixups, openDecisions: record.openDecisions,
      riskAreas: record.riskAreas, novelty: record.novelty, engramRefs: record.refs.engram,
    },
    recordNote: note,
    patches,
    patchesNote: PATCHES_NOTE,
    otherRepos,
    pack,
  };
}
