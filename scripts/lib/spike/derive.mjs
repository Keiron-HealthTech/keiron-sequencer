import { riskKinds } from './config.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = values => [...new Set(values)].sort(compare);
const PII = 'pii-in-logs';

export function mergeRiskAreas(lists) {
  const byKind = new Map();
  for (const area of lists.flat()) byKind.set(area.kind, [...(byKind.get(area.kind) ?? []), ...area.paths]);
  return [...byKind.keys()].sort(compare).map(kind => ({ kind, paths: sorted(byKind.get(kind)) }));
}

// pii-in-logs is never matched from paths or contents: only the agent's attested paths carry it.
export function riskAreas(repoDir, changedPaths, rules, attested = []) {
  const areas = changedPaths.flatMap(path => riskKinds({ risk: rules }, path).map(kind => ({ kind, paths: [`${repoDir}/${path}`] })));
  return mergeRiskAreas([areas, attested.length ? [{ kind: PII, paths: attested }] : []]);
}

export function newPaths(repoDir, addedFiles, startRootEntries) {
  const existing = new Set(startRootEntries);
  return sorted(addedFiles
    .map(path => [path.split('/')[0], path.includes('/')])
    .filter(([seg]) => !existing.has(seg))
    .map(([seg, nested]) => `${repoDir}/${seg}${nested ? '/' : ''}`));
}

const names = out => out.split('\0').filter(Boolean);

export function deriveRepo(git, repoDir, { cwd, rules, startTree, endTree }) {
  const diff = filter => names(git(['diff', '--no-ext-diff', '--name-only', '-z', '--no-renames', ...filter, startTree, endTree], { cwd }));
  return {
    riskAreas: riskAreas(repoDir, diff([]), rules),
    newPaths: newPaths(repoDir, diff(['--diff-filter=A']), names(git(['ls-tree', '--name-only', '-z', startTree], { cwd }))),
  };
}
