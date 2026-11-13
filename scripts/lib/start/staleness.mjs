import { DIFF, oldSideRanges, rangesOverlap } from '../spike/snapshot.mjs';
import { carriesKey, titleTag } from './checkout.mjs';

export const STALENESS_CAP = 10;
export const HUNK_MARGIN = 3;

const emptyGroups = () => ({ self: { commits: [], more: 0 }, sibling: { commits: [], more: 0 }, unrelated: { commits: [], more: 0 } });

export function notComputed(reason, over = {}) {
  return {
    computed: false, reason, anchor: 'spikedAt', since: null, ref: null, filesFrom: null,
    baseCommit: { sha: null, status: null }, groups: emptyGroups(), hunks: null, touched: { commits: [], more: 0 }, unchecked: [], ...over,
  };
}

const sorted = list => [...new Set(list)].sort();

export function stalenessFiles({ patches, record, isCurrent }) {
  const own = patches.filter(p => p.location && isCurrent(p.repoDir)).flatMap(p => p.files);
  if (own.length) return { files: sorted(own), filesFrom: 'patches' };
  const paths = [...(record?.riskAreas ?? []).flatMap(a => a.paths ?? []), ...(record?.novelty?.newPaths ?? [])];
  return paths.length ? { files: sorted(paths), filesFrom: 'record' } : { files: [], filesFrom: null };
}

function parseLog(text) {
  return text.split('\x1e').filter(chunk => chunk.trim()).map(chunk => {
    const [head, ...rest] = chunk.split('\n');
    const tab = head.indexOf('\t');
    return { sha: head.slice(0, tab), subject: head.slice(tab + 1), files: rest.filter(Boolean) };
  });
}

function baseCommitStatus(git, { cwd, ref, baseCommit }) {
  if (!baseCommit) return { sha: null, status: null };
  try {
    const ahead = git(['rev-list', '--count', `${ref}..${baseCommit}`], { cwd }).trim();
    return { sha: baseCommit, status: ahead === '0' ? 'ancestor' : 'forked' };
  } catch {
    return { sha: baseCommit, status: 'absent', note: 'baseCommit not in this clone' };
  }
}

// Which of the card's files the default branch changed where the card's patches did, read from one -U0 diff from the spike
// base. The card's line numbers hold only for a file no earlier card of the run touched (chained) and a base that is a real
// commit, not a combine: otherwise the file, or the whole check, is judged at file level. So is a file the card's patches
// give no lines for.
export function hunkOverlap(git, { cwd, ref, baseCommit, files, patchTexts = [], chainedFiles = [], combine = false, margin = HUNK_MARGIN }) {
  if (combine) return { level: 'file', overlap: [], fallback: 'combine' };
  if (!baseCommit) return { level: 'file', overlap: [], fallback: 'no-base' };
  let diff;
  try {
    diff = git(['--literal-pathspecs', ...DIFF, '-U0', baseCommit, ref, '--', ...files], { cwd });
  } catch {
    return { level: 'file', overlap: [], fallback: 'no-base' };
  }
  const theirs = oldSideRanges(diff);
  const ours = new Map();
  for (const text of patchTexts) for (const [path, ranges] of oldSideRanges(text)) ours.set(path, [...(ours.get(path) ?? []), ...ranges]);
  const chained = new Set(chainedFiles);
  const overlap = [];
  let fallback = null;
  for (const [path, changed] of [...theirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!changed.length && !chained.has(path)) continue;
    // A file with no card ranges (its patch text could not be read) is judged whole: no ranges must never read as fresh.
    const whole = chained.has(path) ? 'chained' : ours.has(path) ? null : 'no-patch';
    if (whole) { overlap.push({ path, ranges: null }); fallback = fallback === 'chained' ? fallback : whole; continue; }
    const ranges = rangesOverlap(ours.get(path), changed, { margin });
    if (ranges.length) overlap.push({ path, ranges });
  }
  return { level: fallback ? 'file' : 'hunk', overlap, fallback };
}

// A commit on a file where the default branch did not meet the card's hunks is listed as touched, not stale; with no base
// or a combine base every commit on the files counts, as before hunks were read.
export function staleness(git, {
  cwd, remote, baseRef, local = false, tracking, files, filesFrom, spikedAt, baseCommit, projectKeys, cardKey, blockerPrNumbers, unchecked = [],
  patchTexts = [], chainedFiles = [], combine = false,
}) {
  const ref = local ? `refs/heads/${baseRef}` : `${remote}/${baseRef}`;
  const shown = { since: spikedAt ?? null, ref, filesFrom, unchecked };
  if (!spikedAt) return notComputed('the record has no spikedAt', shown);
  if (!files.length) return notComputed('no patch files and no record paths to check', shown);
  if (!local && !tracking[baseRef]) return notComputed(`${ref} is not fetched in this checkout`, shown);
  const log = git(['--literal-pathspecs', 'log', `--since=${spikedAt}`, '--format=%x1e%H%x09%s', '--name-only', ref, '--', ...files], { cwd });
  const siblings = projectKeys.filter(k => k !== cardKey).map(titleTag);
  const prTags = blockerPrNumbers.map(n => `(#${n})`);
  const commits = parseLog(log);
  const hunks = commits.length ? hunkOverlap(git, { cwd, ref, baseCommit, files, patchTexts, chainedFiles, combine }) : null;
  const wholeFile = !hunks || hunks.fallback === 'no-base' || hunks.fallback === 'combine';
  const hit = new Set(hunks?.overlap.map(o => o.path) ?? []);
  const groups = emptyGroups();
  const touched = { commits: [], more: 0 };
  const keep = (bucket, commit) => {
    if (bucket.commits.length < STALENESS_CAP) bucket.commits.push(commit);
    else bucket.more += 1;
  };
  for (const commit of commits) {
    const self = carriesKey(commit.subject, cardKey);
    if (!self && !wholeFile && !commit.files.some(f => hit.has(f))) { keep(touched, commit); continue; }
    keep(groups[self ? 'self' : siblings.some(tag => tag.test(commit.subject)) || prTags.some(tag => commit.subject.includes(tag)) ? 'sibling' : 'unrelated'], commit);
  }
  return {
    computed: true, reason: null, anchor: 'spikedAt', ...shown, baseCommit: baseCommitStatus(git, { cwd, ref, baseCommit }), groups, hunks, touched,
  };
}
