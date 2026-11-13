import { DELETION_WEIGHT } from './record.mjs';

const TEST_PATH = /(\.spec\.|\.integration-spec\.|_test\.go$|__tests__|\.test\.)/;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Splits on \r, \n and \r\n like Python's universal newlines, which build.py relies on.
export function patchStats(text) {
  let prod = 0;
  let test = 0;
  let current = '';
  const files = new Set();
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('diff --git')) {
      current = line.split(' b/').at(-1).trim();
      files.add(current);
    } else if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
      const weight = line[0] === '+' ? 1 : DELETION_WEIGHT;
      if (TEST_PATH.test(current)) test += weight;
      else prod += weight;
    }
  }
  return { prod, test, files: [...files] };
}

export function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff !== 0.5) return Math.round(x);
  return floor % 2 === 0 ? floor : floor + 1;
}

export function cardSizes(patchMap, readPatch) {
  const acc = new Map();
  for (const [path, entry] of Object.entries(patchMap.patches)) {
    if (entry.kind !== 'card') continue;
    const { prod, test, files } = patchStats(readPatch(path));
    const repo = patchMap.repos[path.split('/')[0]];
    const share = entry.cards.length;
    for (const card of entry.cards) {
      if (!acc.has(card)) acc.set(card, { prod: 0, test: 0, files: new Set(), repos: new Set(), sharedWith: new Set() });
      const c = acc.get(card);
      c.prod += prod / share;
      c.test += test / share;
      files.forEach(f => c.files.add(f));
      c.repos.add(repo);
      entry.cards.filter(k => k !== card).forEach(k => c.sharedWith.add(k));
    }
  }
  const out = Object.fromEntries(Object.keys(patchMap.cards ?? {}).map(card => [card, null]));
  for (const [card, c] of acc) {
    out[card] = {
      prodLines: roundHalfEven(c.prod),
      testLines: roundHalfEven(c.test),
      files: c.files.size,
      repos: [...c.repos].sort(compare),
      sharedWith: [...c.sharedWith].sort(compare),
      deletionWeight: DELETION_WEIGHT,
    };
  }
  return Object.fromEntries(Object.keys(out).sort(compare).map(k => [k, out[k]]));
}
