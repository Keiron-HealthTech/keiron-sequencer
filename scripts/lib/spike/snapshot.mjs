import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { clearGenerated } from './typecheck.mjs';

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);

export const fixupPatchName = (fixed, from, slug) =>
  `fixup-${fixed.map(cardNumber).sort((a, b) => a - b).join('-')}-from-${cardNumber(from)}-${slug}.patch`;

export const cardPatchName = (card, origin) => `${String(cardNumber(card)).padStart(5, '0')}-${origin === 'existing-pr' ? 'existing' : 'new'}.patch`;

const CARD_PATCH = /^(\d{5})-(new|existing)\.patch$/;

// The backfill's parsePatchName must keep reading card names as null (its map check depends on it), so card names parse here.
export function parseCardPatchName(path, { prefix = 'CRM' } = {}) {
  const m = basename(path).match(CARD_PATCH);
  return m ? { kind: 'card', card: `${prefix}-${Number(m[1])}`, origin: m[2] === 'existing' ? 'existing-pr' : 'thin-spike' } : null;
}

// A user's diff config (no prefixes, colors, an external tool) would change what lands in the patch.
export const DIFF = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

export function snapshot(git, repo, { paths } = {}) {
  const cwd = repo.path;
  clearGenerated(cwd);
  git(['add', '-A', ...(paths ? ['--', ...paths] : [])], { cwd });
  const tree = git(['write-tree'], { cwd }).trim();
  const patch = git([...DIFF, repo.last, tree], { cwd });
  if (!patch) return null;
  const stat = git(['diff', '--shortstat', repo.last, tree], { cwd }).trim();
  return { tree, patch, stat };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function fileSections(patch) {
  const files = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git a/')) files.push({ old: line.slice('diff --git a/'.length, line.lastIndexOf(' b/')), new: line.split(' b/').at(-1), lines: [] });
    else files.at(-1)?.lines.push(line);
  }
  return files;
}

function toRanges(lines) {
  const out = [];
  for (const n of [...new Set(lines)].sort((a, b) => a - b)) {
    if (out.length && out.at(-1)[1] + 1 >= n) out.at(-1)[1] = n;
    else out.push([n, n]);
  }
  return out;
}

// Lines an earlier patch changed, in the coordinates of the tree it produced; its context lines are not changes.
function changedNewLines(patch) {
  const out = new Map();
  for (const file of fileSections(patch)) {
    const marked = [];
    let line = 0;
    for (const raw of file.lines) {
      const h = raw.match(HUNK);
      if (h) { line = Number(h[3]); continue; }
      if (!line) continue;
      if (raw.startsWith('+')) marked.push(line++);
      else if (raw.startsWith('-')) marked.push(line);
      else if (raw.startsWith(' ')) line++;
    }
    out.set(file.new, toRanges(marked));
  }
  return out;
}

// The old-side lines a patch changes, per old path, for a -U0 or a -U3 diff: context lines are skipped, a removed line is
// marked, and an insertion touches the old line it follows (the first line for an insertion at the top).
export function oldSideRanges(patch) {
  const out = new Map();
  for (const file of fileSections(patch)) {
    const marked = [];
    let line = 0;
    for (const raw of file.lines) {
      const h = raw.match(HUNK);
      if (h) { line = Number(h[1]) + (h[2] === '0' ? 1 : 0); continue; }
      if (!line) continue;
      if (raw.startsWith('-')) marked.push(line++);
      else if (raw.startsWith('+')) marked.push(Math.max(line - 1, 1));
      else if (raw.startsWith(' ')) line++;
    }
    out.set(file.old, toRanges(marked));
  }
  return out;
}

// Where ranges a, each widened by margin lines on both sides, meet ranges b.
export function rangesOverlap(a, b, { margin = 0 } = {}) {
  const hits = a.flatMap(([x, y]) => b.map(([c, d]) => [Math.max(x - margin, c), Math.min(y + margin, d)]).filter(([lo, hi]) => lo <= hi));
  return toRanges(hits.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)));
}

export function overlapCandidates(workingPatch, earlier) {
  const working = oldSideRanges(workingPatch);
  const out = [];
  for (const { card, patch } of earlier) {
    for (const [path, theirs] of changedNewLines(patch)) {
      const ours = working.get(path) ?? [];
      const hits = ours.flatMap(([a, b]) => theirs.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).filter(([x, y]) => x <= y));
      if (hits.length) out.push({ card, path, ranges: toRanges(hits.flatMap(([x, y]) => Array.from({ length: y - x + 1 }, (_, i) => x + i))) });
    }
  }
  return out;
}

// Staged into a copy of the tree's index (read-tree -m keeps its stat data), so the real index stays as the agent left it.
export function workingDiff(git, repo, { index }) {
  const cwd = repo.path;
  const env = { GIT_INDEX_FILE: index };
  const real = git(['rev-parse', '--git-path', 'index'], { cwd }).trim();
  const realPath = isAbsolute(real) ? real : join(cwd, real);
  try {
    if (existsSync(realPath)) copyFileSync(realPath, index);
    git(['read-tree', '-m', repo.last], { cwd, env });
    git(['add', '-A'], { cwd, env });
    const tree = git(['write-tree'], { cwd, env }).trim();
    return git([...DIFF, '-U0', repo.last, tree], { cwd, env });
  } finally {
    rmSync(index, { force: true });
  }
}
