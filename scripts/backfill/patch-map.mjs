import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { invert, readDirMap } from '../lib/patch-dirs.mjs';

const CARD_KEY = /^[A-Z]+-\d+$/;
const FIXUP_NAME = /^(fixup|refactor)-([\d-]+)-from-(\d+)/;

// Paths stay in the trial namespace after the trial folders are renamed: the manifest maps each folder back.
export function listPatches(trialDir) {
  const trialName = invert(readDirMap(trialDir));
  return readdirSync(trialDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .flatMap(d => readdirSync(join(trialDir, d.name)).filter(f => f.endsWith('.patch')).map(f => `${trialName[d.name] ?? d.name}/${f}`))
    .sort();
}

export function diskPath(root, path) {
  const [dir, file] = path.split('/');
  return join(root, readDirMap(root)[dir] ?? dir, file);
}

export function parsePatchName(path) {
  const m = basename(path, '.patch').match(FIXUP_NAME);
  return m ? { kind: m[1], fixed: m[2].split('-').map(n => `CRM-${n}`), from: `CRM-${m[3]}` } : null;
}

const sameFixup = (a, b) => a.kind === b.kind && a.from === b.from && JSON.stringify(a.fixed) === JSON.stringify(b.fixed);

function entryErrors(path, entry, map) {
  const parsed = parsePatchName(path);
  switch (entry?.kind) {
    case 'card': {
      const { cards } = entry;
      const ok = Array.isArray(cards) && cards.length > 0 && cards.every(k => CARD_KEY.test(k)) && new Set(cards).size === cards.length;
      return [
        ...(ok ? [] : ['cards must be a non-empty list of distinct card keys']),
        ...(parsed ? [`the file name says ${parsed.kind} but kind is card`] : []),
      ];
    }
    case 'fixup':
    case 'refactor':
      return parsed && sameFixup(parsed, entry) ? [] : ['fixed/from/kind disagree with the file name'];
    case 'skip':
      return map.patches[entry.replacedBy]?.kind === 'card' ? [] : [`replacedBy ${entry.replacedBy} is not a mapped card patch`];
    default:
      return [`unknown kind ${entry?.kind}`];
  }
}

export function checkPatchMap(map, patchPaths) {
  const errors = [];
  const files = new Set(patchPaths);
  for (const path of patchPaths) if (!(path in map.patches)) errors.push(`${path}: not mapped in patch-map.json`);
  for (const [path, entry] of Object.entries(map.patches)) {
    if (!files.has(path)) errors.push(`${path}: no such patch under the trial dir`);
    const dir = path.split('/')[0];
    if (!map.repos?.[dir]) errors.push(`${path}: no repo for directory ${dir}`);
    for (const e of entryErrors(path, entry, map)) errors.push(`${path}: ${e}`);
  }
  return errors;
}
