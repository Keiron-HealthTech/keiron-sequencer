import { parsePatchName } from './patch-map.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const FIXUP_KINDS = ['fixup', 'refactor'];

export function cardFixups(patchMap, notes) {
  const out = {};
  const entryFor = card => (out[card] ??= { received: [], caused: [] });
  for (const entry of Object.values(patchMap.patches)) if (entry.kind === 'card') entry.cards.forEach(entryFor);
  Object.keys(patchMap.cards ?? {}).forEach(entryFor);

  for (const [patch, entry] of Object.entries(patchMap.patches)) {
    if (!FIXUP_KINDS.includes(entry.kind)) continue;
    const parsed = parsePatchName(patch);
    if (!parsed || parsed.kind !== entry.kind || parsed.from !== entry.from || parsed.fixed.join() !== entry.fixed.join()) {
      throw new Error(`${patch}: patch-map entry disagrees with the file name`);
    }
    const note = notes[patch]?.note;
    if (typeof note !== 'string' || note.length === 0) throw new Error(`${patch}: no curated note`);
    for (const fixed of entry.fixed) {
      entryFor(fixed).received.push({ from: entry.from, patch, note });
      entryFor(entry.from).caused.push({ to: fixed, patch, note });
    }
  }

  for (const f of Object.values(out)) {
    f.received.sort((a, b) => compare(a.patch, b.patch) || compare(a.from, b.from));
    f.caused.sort((a, b) => compare(a.patch, b.patch) || compare(a.to, b.to));
  }
  return Object.fromEntries(Object.keys(out).sort(compare).map(k => [k, out[k]]));
}
