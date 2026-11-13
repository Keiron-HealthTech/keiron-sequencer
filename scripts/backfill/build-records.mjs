import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDirMap, renamePatchRefs } from '../lib/patch-dirs.mjs';
import { serializeRecord, validateRecord } from '../lib/record.mjs';
import { dataDirFor, findTrialReference, sequencerHome, trialPatchRoot } from '../lib/spike/home.mjs';
import { cardEffort } from './effort.mjs';
import { cardFixups } from './fixups.mjs';
import { checkPatchMap, diskPath, listPatches } from './patch-map.mjs';
import { cardSizes } from './size.mjs';

export const LINEAR_SNAPSHOT = 'linear-snapshot.json';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ENGRAM_ID = /^[\w.-]+#\d+$/;
const REF = /^(engram:[\w.-]+#\d+|linear:[A-Z]+-\d+|patch:[^/\s]+\/[^/\s]+\.patch)$/;

const CURATED_KEYS = ['card', 'scope', 'archived', 'cases', 'decisions', 'findings', 'engram'];
const ITEM_KEYS = {
  cases: ['given', 'when', 'then', 'source', 'ref'],
  decisions: ['text', 'ref'],
  findings: ['kind', 'text', 'ref'],
};
const RECORD_PATHS = ['$.card', '$.scope', '$.archived', '$.cases', '$.decisions', '$.findings'];

export const serializeCurated = value => `${JSON.stringify(value, null, 2)}\n`;

export function spikedCards(patchMap) {
  const cards = new Set();
  for (const entry of Object.values(patchMap.patches)) if (entry.kind === 'card') entry.cards.forEach(c => cards.add(c));
  return [...cards].sort(compare);
}

export function skeleton(card, patchMap) {
  const note = null;
  const archived = patchMap.cards?.[card]?.archived;
  return {
    card,
    scope: note ? { complete: false, note } : { complete: true, note: null },
    ...(archived ? { archived } : {}),
    cases: [],
    decisions: [],
    findings: [],
    engram: [],
  };
}

export function writeSkeletons(curatedDir, patchMap) {
  mkdirSync(curatedDir, { recursive: true });
  const written = [];
  const kept = [];
  for (const card of spikedCards(patchMap)) {
    const file = join(curatedDir, `${card}.json`);
    if (existsSync(file)) { kept.push(card); continue; }
    writeFileSync(file, serializeCurated(skeleton(card, patchMap)), { flag: 'wx' });
    written.push(card);
  }
  return { written, kept };
}

// Curated content becomes record content, so it is checked by the record validator itself.
const withCaseIds = cases => (Array.isArray(cases) ? cases.map((c, i) => (isObject(c) ? { ...c, id: `c${i + 1}` } : c)) : cases);
const asRecord = curated => ({
  schemaVersion: 1,
  title: 'x',
  project: { slug: 'x', name: 'x' },
  origin: 'thin-spike',
  spikedAt: '2000-01-01T00:00:00Z',
  supersededBy: null,
  alias: { splitFrom: null, mergedInto: null },
  size: null,
  effort: null,
  fixups: { received: [], caused: [] },
  refs: { engram: [], patches: [], linear: null },
  ...Object.fromEntries(['card', 'scope', 'archived', 'decisions', 'findings'].filter(k => k in curated).map(k => [k, curated[k]])),
  ...('cases' in curated ? { cases: withCaseIds(curated.cases) } : {}),
});

export function validateCurated(value) {
  if (!isObject(value)) return ['$: expected object'];
  const errors = validateRecord(asRecord(value)).filter(e => RECORD_PATHS.some(p => e.startsWith(p)));
  for (const key of Object.keys(value)) if (!CURATED_KEYS.includes(key)) errors.push(`$.${key}: unknown key`);
  for (const [list, keys] of Object.entries(ITEM_KEYS)) {
    if (!Array.isArray(value[list])) continue;
    value[list].forEach((item, i) => {
      if (isObject(item)) for (const key of Object.keys(item)) if (!keys.includes(key)) errors.push(`$.${list}[${i}].${key}: unknown key`);
    });
  }
  if (!('engram' in value)) errors.push('$.engram: required');
  else if (!Array.isArray(value.engram)) errors.push('$.engram: expected array');
  else value.engram.forEach((id, i) => {
    if (typeof id !== 'string' || !ENGRAM_ID.test(id)) errors.push(`$.engram[${i}]: expected <project>#<id>`);
  });
  return errors;
}

export function validateFixupNotes(notes, patchMap) {
  if (!isObject(notes)) return ['$: expected object'];
  const errors = [];
  for (const [patch, entry] of Object.entries(notes)) {
    const path = `$[${JSON.stringify(patch)}]`;
    const kind = patchMap.patches[patch]?.kind;
    if (kind !== 'fixup' && kind !== 'refactor') errors.push(`${path}: not a fixup or refactor patch in patch-map.json`);
    if (!isObject(entry)) { errors.push(`${path}: expected object`); continue; }
    if (typeof entry.note !== 'string' || entry.note.length === 0) errors.push(`${path}.note: expected non-empty string`);
    if (typeof entry.ref !== 'string' || !REF.test(entry.ref)) errors.push(`${path}.ref: expected engram:<project>#<id>, linear:<KEY> or patch:<dir>/<file>.patch`);
    for (const key of Object.keys(entry)) if (key !== 'note' && key !== 'ref') errors.push(`${path}.${key}: unknown key`);
  }
  return errors;
}

class BuildError extends Error {
  constructor(errors) {
    super(`${errors.length} error(s):\n${errors.map(e => `  ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const failIf = errors => { if (errors.length) throw new BuildError(errors); };
const attempt = (errors, fn) => {
  try {
    return fn();
  } catch (err) {
    errors.push(err.message);
    return undefined;
  }
};

function readCurated(curatedDir, cards, errors) {
  const curated = {};
  const extra = readdirSync(curatedDir).filter(f => /^[A-Z]+-\d+\.json$/.test(f) && !cards.includes(f.slice(0, -5)));
  for (const file of extra) errors.push(`curated/${file}: not a spiked card`);
  for (const card of cards) {
    const file = `curated/${card}.json`;
    const value = attempt(errors, () => readJson(join(curatedDir, `${card}.json`)));
    if (value === undefined) continue;
    const problems = validateCurated(value);
    if (value?.card !== card) problems.push(`$.card: expected ${card}`);
    problems.forEach(e => errors.push(`${file}: ${e}`));
    curated[card] = value;
  }
  return curated;
}

function linearFacts(card, mapCard, issues, trialDir) {
  const issue = issues.get(card);
  if (issue) return { title: issue.title, linear: issue.url };
  const ref = mapCard?.titleRef;
  const read = typeof ref === 'string' && ref.startsWith('file:') ? readJson(join(trialDir, ref.slice('file:'.length))) : null;
  return { title: mapCard?.title, linear: read?.url ?? null };
}

const engramOf = items => items.map(i => i.ref).filter(r => r.startsWith('engram:')).map(r => r.slice('engram:'.length));

// The patches stay readable from the trial dir until they are moved out of the repo into the home.
export const defaultPatchRoot = (trialDir, slug, { home = sequencerHome() } = {}) =>
  (listPatches(trialDir).length ? trialDir : trialPatchRoot(home, slug));

export function trialInputs({ trial, linear, home = sequencerHome() } = {}) {
  const trialDir = trial ?? findTrialReference(home);
  if (!existsSync(join(trialDir, 'backfill/patch-map.json'))) throw new Error(`no trial patch map at ${join(trialDir, 'backfill/patch-map.json')}: pass --trial <dir>`);
  const linearSnapshot = linear ?? join(trialDir, LINEAR_SNAPSHOT);
  if (!existsSync(linearSnapshot)) throw new Error(`no Linear snapshot at ${linearSnapshot}: pass --linear <file>`);
  return { trialDir, linearSnapshot };
}

export function buildRecords({ trialDir, patchRoot, home, linearSnapshot } = {}) {
  ({ trialDir, linearSnapshot } = trialInputs({ trial: trialDir, linear: linearSnapshot, home }));
  const map = readJson(join(trialDir, 'backfill/patch-map.json'));
  const root = patchRoot ?? defaultPatchRoot(trialDir, map.project.slug, { home });
  if (!existsSync(root)) throw new Error(`no trial patches at ${root}: pass --patches <dir>`);
  failIf(checkPatchMap(map, listPatches(root)));

  const errors = [];
  const cards = spikedCards(map);
  const curated = readCurated(join(trialDir, 'backfill/curated'), cards, errors);
  const notes = readJson(join(trialDir, 'backfill/curated/fixups.json'));
  validateFixupNotes(notes, map).forEach(e => errors.push(`curated/fixups.json: ${e}`));
  const fixups = attempt(errors, () => cardFixups(map, notes)) ?? {};
  const effort = attempt(errors, () => cardEffort(map, readJson(join(trialDir, 'backfill/usage-by-window.json')))) ?? {};
  const sizes = cardSizes(map, path => readFileSync(diskPath(root, path), 'utf8'));
  const dirs = readDirMap(root);
  const project = readJson(linearSnapshot).project;
  const issues = new Map(project.issues.nodes.map(i => [i.identifier, i]));
  failIf(errors);

  const out = new Map();
  for (const card of cards) {
    const c = curated[card];
    const mapCard = map.cards?.[card];
    const own = Object.entries(map.patches).filter(([, e]) => e.kind === 'card' && e.cards.includes(card));
    const { title, linear } = linearFacts(card, mapCard, issues, trialDir);
    const record = {
      schemaVersion: 1,
      card,
      title,
      project: { slug: map.project.slug, name: project.name },
      origin: own.some(([, e]) => e.existing) ? 'existing-pr' : 'thin-spike',
      spikedAt: effort[card]?.spikedAt,
      archived: mapCard?.archived ?? null,
      supersededBy: null,
      alias: { splitFrom: mapCard?.alias?.splitFrom ?? null, mergedInto: mapCard?.alias?.mergedInto ?? null },
      scope: c.scope,
      size: sizes[card] ?? null,
      effort: effort[card]?.effort ?? null,
      fixups: fixups[card] ?? { received: [], caused: [] },
      cases: c.cases.map((x, i) => ({ id: `c${i + 1}`, ...x })),
      decisions: c.decisions,
      findings: c.findings,
      refs: {
        engram: [...new Set([...engramOf([...c.cases, ...c.decisions, ...c.findings]), ...c.engram])],
        patches: own.map(([p]) => p).sort(compare),
        linear,
      },
    };
    const named = renamePatchRefs(record, dirs);
    validateRecord(named).forEach(e => errors.push(`${card}.json: ${e}`));
    out.set(card, serializeRecord(named));
  }
  failIf(errors);
  return out;
}

const RECORD_FILE = /^[A-Z]+-\d+\.json$/;

export function writeRecords(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (RECORD_FILE.test(name) && !files.has(name.slice(0, -5))) rmSync(join(dir, name));
  }
  for (const [card, text] of files) writeFileSync(join(dir, `${card}.json`), text);
}

export function checkRecords(dir, files) {
  if (!existsSync(dir)) return [`${dir}: no such directory`];
  const diffs = [];
  const expected = new Set([...files.keys()].map(card => `${card}.json`));
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!expected.has(entry.name)) diffs.push(`${entry.name}: not produced by the build`);
  }
  for (const [card, text] of files) {
    const file = join(dir, `${card}.json`);
    if (!existsSync(file)) diffs.push(`${card}.json: missing`);
    else if (readFileSync(file, 'utf8') !== text) diffs.push(`${card}.json: differs from the build`);
  }
  return diffs;
}

function option(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return argv[i + 1];
}

function main(argv) {
  const [trial, linear, patchRoot, given] = ['--trial', '--linear', '--patches', '--out'].map(name => option(argv, name));
  if (argv.includes('--skeletons')) {
    const trialDir = trial ?? findTrialReference(sequencerHome());
    const patchMap = readJson(join(trialDir, 'backfill/patch-map.json'));
    const { written, kept } = writeSkeletons(join(trialDir, 'backfill/curated'), patchMap);
    process.stdout.write(`skeletons: ${written.length} written, ${kept.length} kept\n`);
    return 0;
  }
  const { trialDir, linearSnapshot } = trialInputs({ trial, linear });
  const files = buildRecords({ trialDir, patchRoot, linearSnapshot });
  const out = given ?? join(dataDirFor(), readJson(join(trialDir, 'backfill/patch-map.json')).project.slug);
  if (argv.includes('--check')) {
    const diffs = checkRecords(out, files);
    for (const d of diffs) process.stderr.write(`drift: ${d}\n`);
    if (diffs.length) return 1;
    process.stdout.write(`check: ${files.size} records match\n`);
    return 0;
  }
  writeRecords(out, files);
  process.stdout.write(`records: ${files.size} written\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  }
}
